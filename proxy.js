// Logging + rewriting reverse-proxy for grok's cli-chat-proxy (Node port).
//
// For every POST /v1/responses:
//   - Replaces the system message with $BENCH_ROOT/custom_system_prompt.txt (if present)
//   - Optionally replaces <system-reminder> user messages with a "." placeholder
//     (when $BENCH_ROOT/.strip_reminders exists)
//   - Captures every request/response pair under $BENCH_ROOT/<run-tag>/captures/
//     when $BENCH_ROOT/.current_run_tag points at an active run
//
// Configure grok:
//   [model.grok-build]
//   base_url = "http://127.0.0.1:18180/v1"
//
// Environment:
//   BENCH_ROOT   - root dir for bench state (default: this file's directory)
//   PROXY_PORT   - port to listen on (default: 18180)
//
// Export: start({ port, root }) -> returns the http.Server instance.

import http from 'node:http';
import https from 'node:https';
import { URL, fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, statSync, appendFileSync,
} from 'node:fs';

const UPSTREAM = 'https://cli-chat-proxy.grok.com';
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
]);
const SKIP_RESP = new Set([
  ...HOP_BY_HOP, 'transfer-encoding', 'content-length', 'content-encoding',
]);

let SEQ = 0;
function nextSeq() { return ++SEQ; }
function nowMsTag() {
  // 095912.123 — matches the Python format ('%H%M%S.%f'[:-3])
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function configFromEnv() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(process.env.BENCH_ROOT || here);
  const logDir = path.join(root, 'proxy_rewrite_logs');
  mkdirSync(logDir, { recursive: true });
  return {
    root,
    promptFile: path.join(root, 'custom_system_prompt.txt'),
    logDir,
    indexFile: path.join(logDir, 'index.jsonl'),
    currentRunFile: path.join(root, '.current_run_tag'),
    stripRemindersFile: path.join(root, '.strip_reminders'),
  };
}

function currentRunWorkdir(cfg) {
  if (!existsSync(cfg.currentRunFile)) return null;
  let tag = '';
  try { tag = readFileSync(cfg.currentRunFile, 'utf8').trim(); } catch { return null; }
  if (!tag) return null;
  const p = path.join(cfg.root, tag);
  try { return statSync(p).isDirectory() ? p : null; } catch { return null; }
}

// ---- body rewriters ----

function maybeRewriteResponsesBody(bodyBuf, cfg) {
  if (!existsSync(cfg.promptFile)) return [bodyBuf, 'no_custom_prompt_file'];
  let body;
  try { body = JSON.parse(bodyBuf.toString('utf8')); }
  catch { return [bodyBuf, 'not_json']; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [bodyBuf, 'not_object'];
  if (!Array.isArray(body.input)) return [bodyBuf, 'no_input_array'];

  const customText = readFileSync(cfg.promptFile, 'utf8');
  let rewrote = false;
  let oldLen = 0;
  for (const item of body.input) {
    if (item && typeof item === 'object' && item.role === 'system') {
      const old = item.content;
      oldLen = (typeof old === 'string') ? old.length : 0;
      item.content = customText;
      item._rewrite_from_grokscope = item._rewrite_from_grokscope || {
        original_len: oldLen, new_len: customText.length,
      };
      rewrote = true;
      break;
    }
  }
  if (!rewrote) return [bodyBuf, 'no_system_message_found'];
  return [Buffer.from(JSON.stringify(body), 'utf8'), `rewrote_${oldLen}->${customText.length}`];
}

function maybeStripReminders(bodyBuf, cfg) {
  if (!existsSync(cfg.stripRemindersFile)) return [bodyBuf, null];
  let body;
  try { body = JSON.parse(bodyBuf.toString('utf8')); }
  catch { return [bodyBuf, null]; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [bodyBuf, null];
  if (!Array.isArray(body.input)) return [bodyBuf, null];

  const PLACEHOLDER = '.';
  let strippedChars = 0;
  let strippedCount = 0;
  for (const item of body.input) {
    if (item && typeof item === 'object' && item.role === 'user') {
      const c = item.content;
      if (typeof c === 'string' && c.replace(/^\s+/, '').startsWith('<system-reminder>')) {
        strippedChars += c.length;
        strippedCount++;
        item.content = PLACEHOLDER;
        item._proxy_stripped_reminder = item._proxy_stripped_reminder || { original_len: c.length };
      }
    }
  }
  if (strippedCount === 0) return [bodyBuf, 'no_reminders_present'];
  return [Buffer.from(JSON.stringify(body), 'utf8'), `stripped_${strippedCount}_reminders_${strippedChars}c`];
}

// ---- SSE summary extractor (mirrors summarize_sse_stream in the Python proxy) ----

function summarizeSseStream(text) {
  const out = {
    reasoning_summary: '',
    output_text: '',
    tool_calls: [],
    usage: null,
    model: null,
    completed_at: null,
    events_count: 0,
    event_types: {},
  };
  const tcById = Object.create(null);
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(payload); } catch { continue; }
    out.events_count++;
    const t = obj.type || '';
    out.event_types[t] = (out.event_types[t] || 0) + 1;

    if (t === 'response.reasoning_summary_text.delta') {
      if (typeof obj.delta === 'string') out.reasoning_summary += obj.delta;
    } else if (t === 'response.output_text.delta') {
      if (typeof obj.delta === 'string') out.output_text += obj.delta;
    } else if (t === 'response.output_item.added') {
      const item = obj.item || {};
      if (item.type === 'function_call') {
        const entry = {
          type: 'function_call',
          name: item.name ?? null,
          call_id: item.call_id ?? null,
          item_id: item.id ?? null,
          arguments: item.arguments || '',
        };
        if (entry.item_id) tcById[entry.item_id] = entry;
        out.tool_calls.push(entry);
      }
    } else if (t === 'response.function_call_arguments.delta') {
      const itemId = obj.item_id;
      let entry = tcById[itemId];
      if (!entry) {
        entry = { type: 'function_call', name: null, call_id: null, item_id: itemId, arguments: '' };
        tcById[itemId] = entry;
        out.tool_calls.push(entry);
      }
      if (typeof obj.delta === 'string') entry.arguments += obj.delta;
    } else if (t === 'response.function_call_arguments.done') {
      const itemId = obj.item_id;
      const finalArgs = obj.arguments;
      const entry = tcById[itemId];
      if (entry && typeof finalArgs === 'string') entry.arguments = finalArgs;
    } else if (t === 'response.completed') {
      const resp = obj.response || {};
      out.usage = resp.usage ?? null;
      out.model = resp.model ?? null;
      out.completed_at = resp.completed_at ?? null;
      for (const k of [
        'status', 'service_tier', 'truncation', 'background',
        'temperature', 'top_p', 'top_logprobs',
        'presence_penalty', 'frequency_penalty',
        'max_tool_calls', 'max_output_tokens',
        'prompt_cache_key', 'safety_identifier',
        'error', 'incomplete_details', 'instructions',
      ]) {
        if (k in resp) out[k] = resp[k];
      }
      const md = resp.metadata || null;
      if (md) {
        out.system_fingerprint = md.system_fingerprint ?? null;
        out.metadata = md;
      }
    }
  }
  return out;
}

// ---- handler ----

function handle(req, res, cfg) {
  const seq = nextSeq();
  const tag = `${nowMsTag()}-${String(seq).padStart(4, '0')}`;

  // Collect the full request body (small JSON; grok requests are well under a few KB)
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('error', (err) => sendErr(res, 502, `read req: ${err.message}`));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    let rewriteStatus = 'n/a';
    let stripStatus = null;

    if (req.method === 'POST' && req.url.startsWith('/v1/responses')) {
      [body, rewriteStatus] = maybeRewriteResponsesBody(body, cfg);
      [body, stripStatus] = maybeStripReminders(body, cfg);
      if (stripStatus) rewriteStatus = `${rewriteStatus}|${stripStatus}`;
    }

    // Build outbound headers (drop hop-by-hop + content-length + host)
    const outHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      if (lk === 'content-length' || lk === 'host') continue;
      // Node lowercases incoming header names; that's fine for upstream.
      outHeaders[k] = v;
    }
    const upstreamHost = new URL(UPSTREAM).host;
    outHeaders['host'] = upstreamHost;
    outHeaders['content-length'] = String(body.length);

    const upstreamUrl = UPSTREAM.replace(/\/+$/, '') + req.url;

    // Persist a request-side log (matching python's *-req.txt)
    try {
      const sample = body.subarray(0, 2000).toString('utf8');
      const headerLines = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${k.toLowerCase() === 'authorization' ? '<redacted>' : v}`)
        .join('\n');
      writeFileSync(
        path.join(cfg.logDir, `${tag}-req.txt`),
        `${req.method} ${upstreamUrl}\nrewrite_status: ${rewriteStatus}\n---headers---\n${headerLines}\n---body sample (first 2KB)---\n${sample}\n`,
      );
    } catch { /* ignore log errors */ }

    const workdir = currentRunWorkdir(cfg);
    let capturesDir = null;
    let captureBuf = null;
    if (workdir) {
      capturesDir = path.join(workdir, 'captures');
      try { mkdirSync(capturesDir, { recursive: true }); } catch {}
      captureBuf = [];
    }

    const upUrl = new URL(upstreamUrl);
    const reqOpts = {
      method: req.method,
      hostname: upUrl.hostname,
      port: upUrl.port || 443,
      path: upUrl.pathname + upUrl.search,
      headers: outHeaders,
    };
    const start = Date.now();
    const upReq = https.request(reqOpts, (upRes) => {
      // Forward status + filtered headers. Node's http server handles chunked
      // transfer-encoding automatically when we don't set Content-Length.
      const downHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (SKIP_RESP.has(k.toLowerCase())) continue;
        downHeaders[k] = v;
      }
      res.writeHead(upRes.statusCode || 502, downHeaders);

      let capturedBytes = 0;
      upRes.on('data', (chunk) => {
        capturedBytes += chunk.length;
        res.write(chunk);
        if (captureBuf !== null) {
          const room = 4_000_000 - sumLengths(captureBuf);
          if (room > 0) {
            captureBuf.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
          }
        }
      });
      upRes.on('end', () => {
        res.end();
        const elapsedMs = Date.now() - start;

        // Append index line
        try {
          appendFileSync(cfg.indexFile, JSON.stringify({
            tag, method: req.method, path: req.url,
            rewrite_status: rewriteStatus,
            elapsed_ms: elapsedMs,
            resp_bytes: capturedBytes,
            status: upRes.statusCode || 0,
          }) + '\n');
        } catch {}

        // Per-run capture file (if a bench run is active)
        if (workdir && capturesDir) {
          const fullRespText = captureBuf ? Buffer.concat(captureBuf).toString('utf8') : '';
          let reqObj = null;
          try { if (body.length) reqObj = JSON.parse(body.toString('utf8')); } catch {}
          const sseSummary = summarizeSseStream(fullRespText);

          const rawFilename = `${tag}.sse.txt`;
          let savedRaw = rawFilename;
          try { writeFileSync(path.join(capturesDir, rawFilename), fullRespText); }
          catch { savedRaw = null; }

          const capture = {
            tag,
            ts: Date.now() / 1000,
            method: req.method,
            path: req.url,
            status: upRes.statusCode || 0,
            rewrite_status: rewriteStatus,
            elapsed_ms: elapsedMs,
            request: reqObj != null ? reqObj : { _raw: body.subarray(0, 8000).toString('utf8') },
            response_summary: sseSummary,
            response_raw_size: capturedBytes,
            raw_sse_file: savedRaw,
          };
          try {
            writeFileSync(path.join(capturesDir, `${tag}.json`), JSON.stringify(capture, null, 2));
          } catch {}
        }
      });
      upRes.on('error', (err) => {
        // Connection died mid-stream — close downstream
        try { res.destroy(err); } catch {}
      });
    });
    upReq.on('error', (err) => {
      sendErr(res, 502, `upstream error: ${err.message}`);
    });
    // Wide timeout for long agentic SSE streams (matches Python's 600s read)
    upReq.setTimeout(600_000, () => {
      upReq.destroy(new Error('upstream timeout'));
    });
    if (body.length) upReq.write(body);
    upReq.end();
  });
}

function sumLengths(buffers) {
  let n = 0;
  for (const b of buffers) n += b.length;
  return n;
}

function sendErr(res, status, msg) {
  try {
    const buf = Buffer.from(msg, 'utf8');
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(buf.length),
    });
    res.end(buf);
  } catch { /* socket already gone */ }
}

// ---- public API ----

export function start({ port = 18180, root = null, quiet = false } = {}) {
  if (root) process.env.BENCH_ROOT = root;
  const cfg = configFromEnv();
  const server = http.createServer((req, res) => handle(req, res, cfg));
  // Match BaseHTTPRequestHandler's default keep-alive timeout to be safe
  server.keepAliveTimeout = 65_000;
  server.requestTimeout = 0; // we manage timeouts on upstream req
  server.listen(port, '127.0.0.1', () => {
    if (quiet) return;
    console.log(`[grok-tap-rewrite] listening on http://127.0.0.1:${port}`);
    console.log(`  upstream:           ${UPSTREAM}`);
    console.log(`  custom prompt file: ${cfg.promptFile}`);
    console.log(`  logs:               ${cfg.logDir}`);
    if (existsSync(cfg.promptFile)) {
      console.log(`  prompt file present (${statSync(cfg.promptFile).size} bytes) — will REWRITE system messages on /v1/responses`);
    } else {
      console.log(`  prompt file MISSING — passing requests through unchanged`);
    }
    console.log(`  point grok at this with:`);
    console.log(`    [model.grok-build]`);
    console.log(`    base_url = "http://127.0.0.1:${port}/v1"`);
  });
  return server;
}

// Direct-invoke mode (node proxy.js)
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 import.meta.url === `file://${path.resolve(process.argv[1] || '')}`;
if (isDirect) {
  start({ port: parseInt(process.env.PROXY_PORT || '18180', 10) });
}
