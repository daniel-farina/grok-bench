# grok-bench

A test bench for the **Grok CLI** (`grok` / `grok-build`). Lets you A/B different prompts and generation settings, captures every API call with full token & cost metrics, and gives you a live dashboard to compare runs.

Built for one thing: figuring out what settings make Grok produce more elaborate code (games, simulators, complex apps) versus more conservative output.

## What's inside

Three small services talking to each other:

```
┌──────────────────┐      ┌───────────────────┐      ┌──────────────────┐
│  bench-ui (Vite) │ ───► │ bench-server.js   │ ───► │ grok CLI process │
│  :7901           │ HTTP │ :7900             │ spawn│ (per Run click)  │
│  (frontend)      │ ◄─── │  state, runs,     │ ◄─── │ writes to        │
└──────────────────┘      │  captures, files  │ wait │ workdir          │
                          └─────┬─────────────┘      └────────┬─────────┘
                                │ writes config.toml          │ HTTPS via
                                │ + custom_system_prompt.txt  │ proxy base_url
                                ▼                             │
                          ┌───────────────────┐               │
                          │ proxy_rewrite.py  │ ◄─────────────┘
                          │ :18180            │  config.toml's base_url
                          │ rewrites/strips,  │
                          │ captures SSE      │
                          └─────┬─────────────┘
                                │ forwards
                                ▼
                          cli-chat-proxy.grok.com
```

| Component | Role |
|---|---|
| **`bench-server.js`** (Node, no deps) | REST API for state, run-list, captures, files. Spawns `grok` with isolated `GROK_HOME` + auto-generated `config.toml`. Aggregates per-run token/cost metrics from capture files. |
| **`proxy_rewrite.py`** (Python + `httpx`) | HTTP/1.1 reverse proxy. Optionally swaps the system prompt or strips the auto-injected skills `<system-reminder>`. Properly chunks SSE responses (critical — without proper framing grok's agent loop wedges after the first response). Saves every `/v1/responses` request+response under `<workdir>/captures/`. |
| **`bench-ui/`** (Vite + vanilla JS, no framework) | Live dashboard. Settings panel + sections editor + runs table + per-run trend charts + expanded view with live captures/log/files. |

## Features

- **Live dashboard** — runs table, totals strip, per-run trend charts (cost, tokens, tool calls), expanded panels with always-on file browser
- **Full per-request capture** — request body, SSE response, summarized tool calls, token breakdown, cost (USD ticks), system fingerprint, sampling params — all extracted from xAI's `response.completed` events
- **System-prompt editor** — load Grok's default 12K system prompt, parse it into ~12 sections + ~30 paragraph-level "rules", toggle each individually, apply trimmed version via the rewriting proxy
- **Strip skill catalog** — Grok injects a ~5KB `<system-reminder>` listing every `SKILL.md` on your disk into every request. Toggle it off to save tokens
- **All settings tracked** — temperature, max_completion_tokens, max_turns, --reasoning-effort, custom prompt active/length — snapshotted into `metrics.json` per run
- **Files panel** — every file the model writes shows up; HTML files get a ▶ button to open them as a real page
- **Star runs** to mark winners; persists in localStorage
- **Cost transparency** — each capture surfaces `cost_in_usd_ticks` from xAI's API echo (this is the actual billing number, not an estimate)

## Setup

### Prerequisites

- **Grok CLI** installed and authenticated (`grok login`). The bench assumes the binary at `~/.grok/bin/grok` (override via `GROK_BIN`).
- **Node.js 20+** and **Python 3.10+**.
- **httpx** for the proxy: `pip install httpx`

### Install

```bash
git clone https://github.com/<you>/grok-bench
cd grok-bench
cd bench-ui && npm install && cd ..
```

### First run

Open three terminals from the repo root:

```bash
# Terminal 1 — proxy (port 18180)
python3 proxy_rewrite.py

# Terminal 2 — bench backend (port 7900)
node bench-server.js

# Terminal 3 — frontend (port 7901)
cd bench-ui && npm run dev
```

Then open <http://127.0.0.1:7901>.

### Run a test

1. Type a prompt in the **User prompt** field
2. Tick **Force inference through proxy** (turns on rewriting + capture)
3. Pick a temperature, max_completion_tokens, max_turns, --reasoning-effort
4. Click **Run test** — grok spawns in an isolated workdir under the repo root

Watch the captures stream in live with all metrics. Once the run finishes, expand it to see the generated HTML/JS/etc., the run.log, and every API call.

## How the system-prompt rewriting works

Grok's default system prompt is a 12K char document split into XML-tagged sections (`<tool_calling>`, `<making_code_changes>`, `<formatting>`, etc.) and a couple of markdown headings. The bench includes a parsed copy at `grok_default_system_prompt.txt` for reference.

When you click **"Load grok's default…"** in the UI and select/deselect sections + rules, then click **"Apply selected → custom prompt"**:

1. The backend assembles a trimmed version (preserves text between sections — the "preamble")
2. Writes it to `custom_system_prompt.txt` in the repo root
3. Sets the activation flag in state
4. On the next run, the proxy reads `custom_system_prompt.txt` and replaces the system message in every `/v1/responses` request body

Rule-level granularity lets you target specific directives — e.g. removing *"Don't add features beyond what was asked"* (one of three "anti-creativity" rules in `<making_code_changes>`) without losing the whole section.

## File layout

```
grok-bench/
├── bench-server.js              ← Node backend (:7900)
├── proxy_rewrite.py             ← HTTP rewriting proxy (:18180)
├── finalize_run.py              ← Post-run metrics finalizer
├── build_index.py               ← Legacy static dashboard generator
├── grok_default_system_prompt.txt ← Reference: Grok's stock prompt
├── bench-ui/                    ← Vite frontend (:7901)
│   ├── index.html
│   ├── src/main.js
│   ├── src/style.css
│   ├── package.json
│   └── vite.config.js
├── tweet_card.html              ← Resizable card maker (one-off utility)
├── LICENSE                      ← MIT
└── README.md                    ← this file
```

At runtime the bench will create (gitignored):

```
bench_<timestamp>_t<T>_m<maxtok>[_px]/    ← one folder per run
├── prompt.txt                            ← the user prompt
├── metrics.json                          ← settings snapshot + aggregated metrics
├── run.log                               ← grok's stdout/stderr
├── captures/                             ← one JSON per /v1/responses call
│   ├── <ts>.json                         ← request + response_summary
│   └── <ts>.sse.txt                      ← raw SSE stream (sidecar)
└── <any files grok wrote>                ← the actual outputs
```

Plus a self-contained `grokhome/` holding the per-bench GROK_HOME (sessions, the auto-generated `config.toml`, etc.) — never committed.

## Configuration

Environment variables (optional):

| Variable | Default | What it does |
|---|---|---|
| `BENCH_ROOT` | the script's directory | Where bench state + run folders live (proxy + finalize + build_index) |
| `PROXY_PORT` | `18180` | Port the rewriting proxy listens on |
| `GROK_BIN` | `~/.grok/bin/grok` | Path to the grok binary |

For most setups, defaults work — just `cd` into the repo and run the three services.

## Notes

- **The proxy is required** when you want to use the system-prompt rewriting, reminder stripping, or per-call capture features. Without it, grok talks directly to xAI and the bench just records grok's local session log.
- **`--reasoning-effort`** vs `--effort`: grok-build is a reasoning model and rejects the `--effort` flag (which sets the `reasoningEffort` API param). Use `--reasoning-effort` instead. Valid values: `none, minimal, low, medium, high, xhigh`.
- **Telemetry is disabled** in the auto-generated `config.toml` — grok will otherwise keep a connection open to its Mixpanel endpoint after the agent finishes, blocking process exit.
- **HTTP/1.1 chunked encoding** is implemented explicitly in `proxy_rewrite.py`. Earlier versions used Python's `BaseHTTPRequestHandler` with raw unchunked bytes, which made grok's agent loop wedge after the first response. Don't downgrade that.

## License

MIT — see `LICENSE`.
