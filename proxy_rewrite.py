#!/usr/bin/env python3
"""
A logging + rewriting reverse-proxy for grok's cli-chat-proxy.

For every POST /v1/responses:
  - Replaces the system message with $BENCH_ROOT/custom_system_prompt.txt (if present)
  - Optionally replaces <system-reminder> user messages with a "." placeholder
    (when $BENCH_ROOT/.strip_reminders exists)
  - Captures every request/response pair under $BENCH_ROOT/<run-tag>/captures/
    when $BENCH_ROOT/.current_run_tag points at an active run

Run:
    python3 proxy_rewrite.py

Configure (config.toml of your grok install or a per-bench GROK_HOME):
    [model.grok-build]
    base_url = "http://127.0.0.1:18180/v1"

Environment:
    BENCH_ROOT  — root dir for bench state. Default: this script's directory.
    PROXY_PORT  — port to listen on. Default: 18180.
"""
import json
import os
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx

UPSTREAM = "https://cli-chat-proxy.grok.com"
BENCH_ROOT = Path(os.environ.get("BENCH_ROOT", Path(__file__).resolve().parent))
PROMPT_FILE = BENCH_ROOT / "custom_system_prompt.txt"
LOG_DIR = BENCH_ROOT / "proxy_rewrite_logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
INDEX = LOG_DIR / "index.jsonl"
PORT = int(os.environ.get("PROXY_PORT", "18180"))
CURRENT_RUN_FILE = BENCH_ROOT / ".current_run_tag"
RUN_ROOT = BENCH_ROOT
STRIP_REMINDERS_FILE = BENCH_ROOT / ".strip_reminders"


def current_run_workdir():
    if not CURRENT_RUN_FILE.exists():
        return None
    tag = CURRENT_RUN_FILE.read_text().strip()
    if not tag:
        return None
    p = RUN_ROOT / tag
    return p if p.is_dir() else None

SEQ = 0
SEQ_LOCK = threading.Lock()
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
}


def next_seq():
    global SEQ
    with SEQ_LOCK:
        SEQ += 1
        return SEQ


def now_ms_tag():
    return datetime.now().strftime("%H%M%S.%f")[:-3]


def maybe_rewrite_responses_body(body_bytes):
    """If body is a JSON object with `input[]` containing a system message,
    replace that system message's content with the file contents."""
    if not PROMPT_FILE.exists():
        return body_bytes, "no_custom_prompt_file"
    try:
        body = json.loads(body_bytes)
    except Exception:
        return body_bytes, "not_json"
    if not isinstance(body, dict):
        return body_bytes, "not_object"
    inputs = body.get("input")
    if not isinstance(inputs, list):
        return body_bytes, "no_input_array"

    custom_text = PROMPT_FILE.read_text()
    rewrote = False
    for item in inputs:
        if not isinstance(item, dict):
            continue
        if item.get("role") == "system":
            old = item.get("content", "")
            old_len = len(old) if isinstance(old, str) else 0
            item["content"] = custom_text
            rewrote = True
            # Save context for the log
            item.setdefault("_rewrite_from_grokscope", {
                "original_len": old_len,
                "new_len": len(custom_text),
            })
            break

    if not rewrote:
        return body_bytes, "no_system_message_found"

    new_body = json.dumps(body).encode("utf-8")
    return new_body, f"rewrote_{old_len}->{len(custom_text)}"


def maybe_strip_reminders(body_bytes):
    """If STRIP_REMINDERS_FILE exists, REPLACE user-role input items whose content
    starts with '<system-reminder>' with a tiny placeholder. We don't DROP the
    item, because grok's local chat_history retains the reminder; if the proxy
    drops it the message count desyncs and the agent loop stalls. Replacing
    preserves position while shrinking content from ~4.8KB to a few bytes.

    Returns (new_body_bytes, status_str_or_None).
    """
    if not STRIP_REMINDERS_FILE.exists():
        return body_bytes, None
    try:
        body = json.loads(body_bytes)
    except Exception:
        return body_bytes, None
    if not isinstance(body, dict):
        return body_bytes, None
    inputs = body.get("input")
    if not isinstance(inputs, list):
        return body_bytes, None

    PLACEHOLDER = "."  # smallest neutral content; preserves message position
    stripped_chars = 0
    stripped_count = 0
    for item in inputs:
        if isinstance(item, dict) and item.get("role") == "user":
            content = item.get("content")
            if isinstance(content, str) and content.lstrip().startswith("<system-reminder>"):
                stripped_chars += len(content)
                stripped_count += 1
                item["content"] = PLACEHOLDER
                # mark for inspection in the capture log
                item.setdefault("_proxy_stripped_reminder", {"original_len": len(content)})

    if stripped_count == 0:
        return body_bytes, "no_reminders_present"
    return json.dumps(body).encode("utf-8"), f"stripped_{stripped_count}_reminders_{stripped_chars}c"


def summarize_sse_stream(text):
    """Extract human-readable summary from a /v1/responses SSE stream.

    Captures: reasoning_summary, output_text, tool_calls (function calls with
    their accumulated arguments), usage, model, event-type histogram.
    """
    out = {
        "reasoning_summary": "",
        "output_text": "",
        "tool_calls": [],          # ordered list of {name, call_id, item_id, arguments, type}
        "usage": None,
        "model": None,
        "completed_at": None,
        "events_count": 0,
        "event_types": {},
    }
    # Indexed by item_id so we can append deltas + finalize arguments
    tc_by_id = {}

    for line in text.split("\n"):
        if not line.startswith("data: "):
            continue
        payload = line[6:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            obj = json.loads(payload)
        except Exception:
            continue
        out["events_count"] += 1
        t = obj.get("type") or ""
        out["event_types"][t] = out["event_types"].get(t, 0) + 1

        if t == "response.reasoning_summary_text.delta":
            d = obj.get("delta", "")
            if isinstance(d, str):
                out["reasoning_summary"] += d
        elif t == "response.output_text.delta":
            d = obj.get("delta", "")
            if isinstance(d, str):
                out["output_text"] += d
        elif t == "response.output_item.added":
            item = obj.get("item") or {}
            if item.get("type") == "function_call":
                entry = {
                    "type": "function_call",
                    "name": item.get("name"),
                    "call_id": item.get("call_id"),
                    "item_id": item.get("id"),
                    "arguments": item.get("arguments") or "",
                }
                tc_by_id[entry["item_id"]] = entry
                out["tool_calls"].append(entry)
        elif t == "response.function_call_arguments.delta":
            item_id = obj.get("item_id")
            delta = obj.get("delta", "")
            entry = tc_by_id.get(item_id)
            if entry is None:
                entry = {"type": "function_call", "name": None, "call_id": None,
                         "item_id": item_id, "arguments": ""}
                tc_by_id[item_id] = entry
                out["tool_calls"].append(entry)
            if isinstance(delta, str):
                entry["arguments"] += delta
        elif t == "response.function_call_arguments.done":
            item_id = obj.get("item_id")
            final_args = obj.get("arguments")
            entry = tc_by_id.get(item_id)
            if entry is not None and isinstance(final_args, str):
                entry["arguments"] = final_args
        elif t == "response.completed":
            resp = obj.get("response") or {}
            out["usage"] = resp.get("usage")
            out["model"] = resp.get("model")
            out["completed_at"] = resp.get("completed_at")
            # Capture every other useful field the API returns
            for k in (
                "status", "service_tier", "truncation", "background",
                "temperature", "top_p", "top_logprobs",
                "presence_penalty", "frequency_penalty",
                "max_tool_calls", "max_output_tokens",
                "prompt_cache_key", "safety_identifier",
                "error", "incomplete_details", "instructions",
            ):
                if k in resp:
                    out[k] = resp[k]
            md = resp.get("metadata") or {}
            if md:
                out["system_fingerprint"] = md.get("system_fingerprint")
                out["metadata"] = md
    return out


class RewriteTap(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[grok-tap-rewrite] {self.address_string()} - {fmt % args}\n")

    def _handle(self, method):
        seq = next_seq()
        tag = f"{now_ms_tag()}-{seq:04d}"

        body = b""
        length = self.headers.get("Content-Length")
        if length is not None:
            try:
                body = self.rfile.read(int(length))
            except Exception as e:
                self._send_error(502, f"read req: {e}")
                return

        rewrite_status = "n/a"
        if method == "POST" and self.path.startswith("/v1/responses"):
            body, rewrite_status = maybe_rewrite_responses_body(body)
            body, strip_status = maybe_strip_reminders(body)
            if strip_status:
                rewrite_status = f"{rewrite_status}|{strip_status}"
            self.headers["Content-Length"] = str(len(body))

        upstream_url = UPSTREAM.rstrip("/") + self.path

        out_headers = {}
        for k, v in self.headers.items():
            lk = k.lower()
            if lk in HOP_BY_HOP:
                continue
            # We set these ourselves below; skip whatever case the client used.
            if lk in ("content-length", "host"):
                continue
            out_headers[k] = v
        out_headers["Host"] = UPSTREAM.split("://", 1)[1]
        out_headers["Content-Length"] = str(len(body))

        # Log the (possibly-rewritten) request body for inspection
        try:
            sample = body.decode("utf-8", errors="replace")[:2000]
        except Exception:
            sample = "<binary>"
        req_path = LOG_DIR / f"{tag}-req.txt"
        req_path.write_text(
            f"{method} {upstream_url}\n"
            f"rewrite_status: {rewrite_status}\n"
            f"---headers---\n"
            + "\n".join(f"{k}: {'<redacted>' if k.lower()=='authorization' else v}" for k, v in self.headers.items())
            + "\n---body sample (first 2KB)---\n" + sample
        )

        start = time.time()
        # If a bench run is active, capture full request + response into its folder
        workdir = current_run_workdir()
        captures_dir = None
        captured_resp_bytes_buf = bytearray() if workdir else None
        if workdir:
            captures_dir = workdir / "captures"
            captures_dir.mkdir(parents=True, exist_ok=True)
        try:
            with httpx.Client(http2=False, timeout=httpx.Timeout(600.0, connect=15.0)) as client:
                with client.stream(method, upstream_url, headers=out_headers, content=body or None) as upstream:
                    self.send_response(upstream.status_code)
                    upstream_headers = {}
                    # We re-frame the body as chunked transfer-encoding ourselves.
                    # Strip any upstream framing headers and substitute our own.
                    SKIP_RESP = HOP_BY_HOP | {"transfer-encoding", "content-length", "content-encoding"}
                    for k, v in upstream.headers.items():
                        upstream_headers[k] = v
                        if k.lower() in SKIP_RESP:
                            continue
                        self.send_header(k, v)
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    captured_bytes = 0
                    for chunk in upstream.iter_bytes():
                        if not chunk:
                            continue
                        try:
                            # Proper HTTP/1.1 chunked-encoding framing:
                            # <hex-size>\r\n<bytes>\r\n
                            self.wfile.write(f"{len(chunk):x}\r\n".encode("ascii"))
                            self.wfile.write(chunk)
                            self.wfile.write(b"\r\n")
                            self.wfile.flush()
                            captured_bytes += len(chunk)
                        except (BrokenPipeError, ConnectionResetError):
                            break
                        if captured_resp_bytes_buf is not None and len(captured_resp_bytes_buf) < 4_000_000:
                            captured_resp_bytes_buf.extend(chunk)
                    # End-of-message marker for chunked encoding
                    try:
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    elapsed = time.time() - start
                    with INDEX.open("a") as fh:
                        fh.write(json.dumps({
                            "tag": tag,
                            "method": method,
                            "path": self.path,
                            "rewrite_status": rewrite_status,
                            "elapsed_ms": int(elapsed * 1000),
                            "resp_bytes": captured_bytes,
                            "status": upstream.status_code,
                        }) + "\n")
                    # Per-run capture file (if a run is active)
                    if workdir and captures_dir:
                        full_resp_text = captured_resp_bytes_buf.decode("utf-8", errors="replace") if captured_resp_bytes_buf else ""
                        # Parse the request body as JSON for easy display
                        try:
                            req_obj = json.loads(body) if body else None
                        except Exception:
                            req_obj = None
                        # Extract key parts from the SSE stream
                        sse_summary = summarize_sse_stream(full_resp_text)
                        # Persist the raw SSE alongside the summary
                        raw_filename = f"{tag}.sse.txt"
                        try:
                            (captures_dir / raw_filename).write_text(full_resp_text)
                        except Exception:
                            raw_filename = None
                        capture = {
                            "tag": tag,
                            "ts": time.time(),
                            "method": method,
                            "path": self.path,
                            "status": upstream.status_code,
                            "rewrite_status": rewrite_status,
                            "elapsed_ms": int(elapsed * 1000),
                            "request": req_obj if req_obj is not None else {"_raw": body[:8000].decode("utf-8", errors="replace") if body else ""},
                            "response_summary": sse_summary,
                            "response_raw_size": captured_bytes,
                            "raw_sse_file": raw_filename,  # sibling file in captures/
                        }
                        (captures_dir / f"{tag}.json").write_text(json.dumps(capture, indent=2))
        except httpx.HTTPError as e:
            self._send_error(502, f"upstream error: {e}")

    def _send_error(self, status, msg):
        body = msg.encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            pass

    def do_GET(self):    self._handle("GET")
    def do_POST(self):   self._handle("POST")
    def do_PUT(self):    self._handle("PUT")
    def do_DELETE(self): self._handle("DELETE")
    def do_PATCH(self):  self._handle("PATCH")


if __name__ == "__main__":
    addr = ("127.0.0.1", PORT)
    print(f"grok-tap-rewrite listening on http://{addr[0]}:{addr[1]}")
    print(f"upstream:           {UPSTREAM}")
    print(f"custom prompt file: {PROMPT_FILE}")
    print(f"logs:               {LOG_DIR}")
    print()
    if PROMPT_FILE.exists():
        print(f"  prompt file present, {PROMPT_FILE.stat().st_size} bytes - will REWRITE system messages on /v1/responses")
    else:
        print(f"  prompt file MISSING - will pass requests through unchanged. Create:")
        print(f"     echo 'your prompt' > {PROMPT_FILE}")
    print()
    print("Point grok at this with:")
    print(f"  [model.grok-build]")
    print(f'  base_url = "http://127.0.0.1:{PORT}/v1"')
    print()
    ThreadingHTTPServer(addr, RewriteTap).serve_forever()
