// Grok test-bench backend. No external deps.
// Endpoints:
//   GET  /                              -> bench.html
//   GET  /api/state                     -> { settings, custom_prompt, user_prompt, custom_prompt_active }
//   POST /api/state    { settings, custom_prompt, user_prompt, custom_prompt_active }
//   POST /api/run                       -> kicks off a run with current settings, returns { tag, pid }
//   GET  /api/runs                      -> list of all run metrics (newest first)
//   GET  /api/run/:tag/log              -> plain-text tail of run.log
//   GET  /api/proxy/status              -> is the rewriting proxy listening?
//   GET  /api/proxy/captures            -> recent rewrite-proxy index entries

import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, statSync, readdirSync, createReadStream, openSync, readSync, closeSync, unlinkSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ROOT is resolved at server-start time so start.js / start({root}) can override
let ROOT = path.resolve(process.env.BENCH_ROOT || __dirname);
let STATE_FILE = path.join(ROOT, 'bench-state.json');
let CUSTOM_PROMPT_FILE = path.join(ROOT, 'custom_system_prompt.txt');
let CUSTOM_PROMPT_INACTIVE = path.join(ROOT, 'custom_system_prompt.txt.inactive');
let USER_PROMPT_FILE = path.join(ROOT, 'bench_user_prompt.txt');
let STRIP_REMINDERS_MARKER = path.join(ROOT, '.strip_reminders');
let PROXY_LOGS = path.join(ROOT, 'proxy_rewrite_logs');
let PORT = parseInt(process.env.BENCH_PORT || '7900', 10);
let PROXY_PORT = parseInt(process.env.PROXY_PORT || '18180', 10);
let UI_DIST_DIR = path.join(__dirname, 'bench-ui', 'dist');

const DEFAULT_STATE = {
  settings: {
    temperature: 0.5,
    max_completion_tokens: 16384,
    max_turns: 60,
    // Route grok through our proxy by default — without this the bench can't
    // capture API traffic, token counts, cost, or apply prompt rewrites.
    use_proxy: true,
  },
  user_prompt: 'Create a 3d airplane game with mountains, ocean, birds and trees.',
  custom_prompt: '',
  custom_prompt_active: false,
  strip_reminders: false,
};

// Versioned reference prompts directory (prompts/grok-<version>.txt).
// resolveDefaultPromptFile() picks the file matching the installed grok version,
// or falls back to the highest version present.
const PROMPTS_DIR = path.join(__dirname, 'prompts');

let _grokVersion = null;
function detectGrokVersion() {
  if (_grokVersion !== null) return _grokVersion;
  const bin = process.env.GROK_BIN || path.join(process.env.HOME || '', '.grok/bin/grok');
  try {
    const { spawnSync } = require_spawnSync();
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    const m = (r.stdout || '').match(/(\d+\.\d+\.\d+)/);
    _grokVersion = m ? m[1] : '';
  } catch { _grokVersion = ''; }
  return _grokVersion;
}
// helper: pull spawnSync at use-time so the import order is happy at top of file
function require_spawnSync() {
  // child_process is already imported as { spawn } — re-import spawnSync here
  // through dynamic require-equivalent (we're in ESM but can use the same module).
  // eslint-disable-next-line no-undef
  return { spawnSync: childProcessSpawnSync };
}
import { spawnSync as childProcessSpawnSync } from 'node:child_process';

function resolveDefaultPromptFile() {
  if (!existsSync(PROMPTS_DIR)) return { file: null, version: null, available: [] };
  let files;
  try {
    files = readdirSync(PROMPTS_DIR).filter(f => /^grok-[\d.]+\.txt$/.test(f));
  } catch { return { file: null, version: null, available: [] }; }
  if (!files.length) return { file: null, version: null, available: [] };
  const available = files.map(f => f.replace(/^grok-|\.txt$/g, ''))
    .sort((a, b) => cmpSemverLike(b, a));   // newest first
  const installed = detectGrokVersion();
  if (installed && available.includes(installed)) {
    return { file: path.join(PROMPTS_DIR, `grok-${installed}.txt`), version: installed, available, matched: true };
  }
  const fallback = available[0];
  return { file: path.join(PROMPTS_DIR, `grok-${fallback}.txt`), version: fallback, available, matched: false, installed };
}
function cmpSemverLike(a, b) {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function loadState() {
  if (!existsSync(STATE_FILE)) return structuredClone(DEFAULT_STATE);
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function applyCustomPromptToDisk(state) {
  // The rewriting proxy reads custom_system_prompt.txt when present.
  // Toggling active/inactive moves the file in and out of place.
  if (state.custom_prompt_active && state.custom_prompt) {
    writeFileSync(CUSTOM_PROMPT_FILE, state.custom_prompt);
    if (existsSync(CUSTOM_PROMPT_INACTIVE)) {
      try { unlinkSync(CUSTOM_PROMPT_INACTIVE); } catch {}
    }
  } else {
    // Move out of the way so the proxy goes pass-through
    if (existsSync(CUSTOM_PROMPT_FILE)) {
      writeFileSync(CUSTOM_PROMPT_INACTIVE, readFileSync(CUSTOM_PROMPT_FILE, 'utf8'));
      try { unlinkSync(CUSTOM_PROMPT_FILE); } catch {}
    }
  }
  if (state.user_prompt !== undefined) {
    writeFileSync(USER_PROMPT_FILE, state.user_prompt);
  }
  // Toggle the proxy's "strip reminders" marker
  if (state.strip_reminders) {
    writeFileSync(STRIP_REMINDERS_MARKER, '');
  } else if (existsSync(STRIP_REMINDERS_MARKER)) {
    try { unlinkSync(STRIP_REMINDERS_MARKER); } catch {}
  }
}

async function checkProxy() {
  return new Promise((resolve) => {
    const s = net.createConnection(PROXY_PORT, '127.0.0.1');
    s.on('connect', () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(500, () => { s.destroy(); resolve(false); });
  });
}

function aggregateRunMetrics(folder) {
  // Walk the run's captures/ dir and sum metrics across all completed calls.
  const dir = path.join(ROOT, folder, 'captures');
  const agg = {
    api_calls: 0,
    api_calls_ok: 0,
    api_calls_err: 0,
    sum_elapsed_ms: 0,
    sum_input_tokens: 0,
    sum_cached_tokens: 0,
    sum_output_tokens: 0,
    sum_reasoning_tokens: 0,
    sum_total_tokens: 0,
    sum_cost_ticks: 0,
    tool_call_count: 0,
    tool_call_names: {},   // name -> count
    last_model: null,
    last_system_fingerprint: null,
    last_status: null,
  };
  if (!existsSync(dir)) return agg;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let c;
    try { c = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    agg.api_calls++;
    if (c.status === 200) agg.api_calls_ok++;
    else agg.api_calls_err++;
    agg.sum_elapsed_ms += (c.elapsed_ms || 0);
    const rs = c.response_summary || {};
    const u = rs.usage || {};
    agg.sum_input_tokens     += (u.input_tokens || 0);
    agg.sum_cached_tokens    += ((u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0);
    agg.sum_output_tokens    += (u.output_tokens || 0);
    agg.sum_reasoning_tokens += ((u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || 0);
    agg.sum_total_tokens     += (u.total_tokens || 0);
    agg.sum_cost_ticks       += (u.cost_in_usd_ticks || 0);
    for (const tc of (rs.tool_calls || [])) {
      agg.tool_call_count++;
      const n = tc.name || '(unknown)';
      agg.tool_call_names[n] = (agg.tool_call_names[n] || 0) + 1;
    }
    if (rs.model) agg.last_model = rs.model;
    if (rs.system_fingerprint) agg.last_system_fingerprint = rs.system_fingerprint;
    if (rs.status) agg.last_status = rs.status;
  }
  return agg;
}

function listRuns() {
  const out = [];
  for (const entry of readdirSync(ROOT)) {
    const folder = path.join(ROOT, entry);
    const metrics = path.join(folder, 'metrics.json');
    if (existsSync(metrics)) {
      try {
        const m = JSON.parse(readFileSync(metrics, 'utf8'));
        m._folder = entry;
        m._full_path = path.join(ROOT, entry);
        const mtime = statSync(metrics).mtimeMs;
        m._mtime = mtime;
        // Layer in aggregated capture metrics
        const agg = aggregateRunMetrics(entry);
        m._agg = agg;
        // Surface the most-used fields directly on the row for the table
        m.api_calls = agg.api_calls;
        m.total_tokens = agg.sum_total_tokens;
        m.input_tokens = agg.sum_input_tokens;
        m.cached_tokens = agg.sum_cached_tokens;
        m.output_tokens = agg.sum_output_tokens;
        m.reasoning_tokens = agg.sum_reasoning_tokens;
        m.cost_ticks = agg.sum_cost_ticks;
        m.tool_call_count = agg.tool_call_count;
        // legacy field used by the UI's existing column
        m.estimated_billed_tokens = agg.sum_total_tokens;
        out.push(m);
      } catch {}
    }
  }
  out.sort((a, b) => b._mtime - a._mtime);
  return out;
}

function tailFile(p, max = 8000) {
  if (!existsSync(p)) return '';
  const st = statSync(p);
  const start = Math.max(0, st.size - max);
  const fd = openSync(p, 'r');
  const buf = Buffer.alloc(st.size - start);
  readSync(fd, buf, 0, buf.length, start);
  closeSync(fd);
  return buf.toString('utf8');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(e); }
    });
  });
}

function json(res, obj, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

function plain(res, text, code = 200) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

// Parse grok's default system prompt into logical sections, each with nested "rules"
// (paragraph-level chunks the user can toggle individually).
function parsePromptSections(text) {
  const sections = [];
  // XML-tagged sections
  const xmlRe = /<([a-z_][a-z0-9_]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = xmlRe.exec(text)) !== null) {
    sections.push({
      kind: 'xml',
      name: m[1],
      start: m.index,
      end: m.index + m[0].length,
      length: m[0].length,
      preview: m[2].trim().slice(0, 120).replace(/\s+/g, ' '),
      _innerStart: m.index + `<${m[1]}>`.length,
      _innerEnd: m.index + m[0].length - `</${m[1]}>`.length,
    });
  }
  // Markdown ## sections (top-level only; skip ones already inside XML)
  const mdRe = /^## (.+)$/gm;
  const xmlStarts = sections.filter(s => s.kind === 'xml').map(s => s.start).sort((a,b)=>a-b);
  while ((m = mdRe.exec(text)) !== null) {
    const startLine = m.index;
    const insideXml = sections.some(s => s.kind === 'xml' && startLine > s.start && startLine < s.end);
    if (insideXml) continue;
    const afterHeader = m.index + m[0].length;
    const nextMd = text.indexOf('\n## ', afterHeader);
    const nextXml = xmlStarts.find(s => s > startLine) ?? text.length;
    let end = text.length;
    if (nextMd >= 0) end = Math.min(end, nextMd);
    end = Math.min(end, nextXml);
    sections.push({
      kind: 'md',
      name: m[1].trim(),
      start: startLine,
      end,
      length: end - startLine,
      preview: text.slice(startLine, end).replace(/^## .+\n/, '').trim().slice(0, 120).replace(/\s+/g, ' '),
      _innerStart: afterHeader + 1, // skip newline after heading
      _innerEnd: end,
    });
  }
  sections.sort((a, b) => a.start - b.start);

  // For each section, find paragraph-level "rules" (split on blank lines)
  for (const s of sections) {
    const inner = text.slice(s._innerStart, s._innerEnd);
    s.rules = parseRules(inner, s._innerStart);
  }
  return sections;
}

// Split a chunk of text into rules (paragraphs). A rule = a non-blank run of lines.
// Returns: [{ idx, start, end, length, text, preview }]
function parseRules(inner, baseOffset) {
  const rules = [];
  const trimmedLeading = inner.replace(/^\s+/, '');
  const offset0 = baseOffset + (inner.length - trimmedLeading.length);
  // Split on blank-line boundaries (2+ newlines)
  let cursor = 0;
  const text = trimmedLeading;
  let idx = 0;
  while (cursor < text.length) {
    // skip whitespace
    while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
    if (cursor >= text.length) break;
    const start = cursor;
    // walk until blank line (two consecutive newlines) or end
    while (cursor < text.length) {
      if (text[cursor] === '\n' && (text[cursor+1] === '\n' || cursor+1 >= text.length)) break;
      cursor++;
    }
    const end = cursor;
    const body = text.slice(start, end).trimEnd();
    if (body.length) {
      rules.push({
        idx,
        start: offset0 + start,
        end: offset0 + end,
        length: body.length,
        text: body,
        preview: body.slice(0, 140).replace(/\s+/g, ' '),
      });
      idx++;
    }
  }
  return rules;
}

// Rebuild the prompt with granular keep/drop logic.
// `include` is either:
//   - an array of section names (legacy: keep whole sections)
//   - an object: { sections: [names...], excludeRules: ["section#index", ...] }
// Sections not in the `sections` array are dropped entirely.
// Sections in the array are kept, minus any rules whose "section#index" is in `excludeRules`.
function assemblePromptFromSections(text, include) {
  const sections = parsePromptSections(text);
  let keepNames, excludeRules;
  if (Array.isArray(include)) {
    keepNames = new Set(include);
    excludeRules = new Set();
  } else {
    keepNames = new Set((include && include.sections) || []);
    excludeRules = new Set((include && include.excludeRules) || []);
  }

  // Build a list of intervals to drop in text-order
  const drops = []; // [start, end]
  for (const s of sections) {
    if (!keepNames.has(s.name)) {
      drops.push([s.start, s.end]);
      continue;
    }
    // Section is kept — drop only the excluded rules within it
    for (const r of s.rules) {
      if (excludeRules.has(`${s.name}#${r.idx}`)) {
        drops.push([r.start, r.end]);
      }
    }
  }
  drops.sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [a, b] of drops) {
    if (a < cursor) continue; // shouldn't happen, but guard
    out += text.slice(cursor, a);
    cursor = b;
    // collapse extra blank lines that may dangle after a dropped chunk
    while (text[cursor] === '\n' && text[cursor + 1] === '\n') cursor++;
  }
  out += text.slice(cursor);
  return out;
}

function fireRun(state) {
  // Build a unique tag for this run
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const tag = `bench_${stamp}_t${state.settings.temperature}_m${state.settings.max_completion_tokens}${state.use_proxy ? '_px' : ''}`;
  const workdir = path.join(ROOT, tag);
  mkdirSync(workdir, { recursive: true });

  // Tell the proxy where to drop captures for this run
  writeFileSync(path.join(ROOT, '.current_run_tag'), tag);

  // Choose runner: existing run_test_v3.sh if user-prompt comes from a file
  // We invoke the binary directly here for full control.
  const env = { ...process.env, GROK_HOME: path.join(ROOT, 'grokhome') };

  // Build temp config.toml in the isolated home
  const tempCfg = `
[cli]
installer = "internal"
auto_update = false

[ui]
permission_mode = "always-approve"

[model.grok-build]
${state.settings.use_proxy_inference !== false ? '' : ''}${state.use_proxy ? `base_url = "http://127.0.0.1:${PROXY_PORT}/v1"\n` : ''}temperature = ${state.settings.temperature}
top_p = 0.95
${state.settings.max_completion_tokens && state.settings.max_completion_tokens !== 'default' ? `max_completion_tokens = ${state.settings.max_completion_tokens}` : ''}

[subagents]
enabled = true
default_model = "grok-build"

[session]
auto_compact_threshold_percent = 92

[toolset.bash]
timeout_secs = 600
output_byte_limit = 262144

[features]
support_permission = false
codebase_indexing = true

[telemetry]
mixpanel_enabled = false
trace_upload = false
`;
  writeFileSync(path.join(ROOT, 'grokhome', 'config.toml'), tempCfg);

  // Save the user prompt to a file the agent reads via --prompt-file
  const userPromptPath = path.join(workdir, 'prompt.txt');
  writeFileSync(userPromptPath, state.user_prompt);

  const logPath = path.join(workdir, 'run.log');
  // Resolve grok binary: prefer $GROK_BIN, else ~/.grok/bin/grok
  const grok = process.env.GROK_BIN
    || path.join(process.env.HOME || '', '.grok/bin/grok');
  const args = [
    '--prompt-file', userPromptPath,
    '--always-approve',
    '--max-turns', String(state.settings.max_turns || 60),
    '--output-format', 'plain',
  ];
  // (--reasoning-effort dropped — grok-build doesn't expose a usable reasoning-budget knob via CLI)
  const out = openSync(logPath, 'w');
  const child = spawn(grok, args, {
    cwd: workdir,
    env,
    stdio: ['ignore', out, out],
  });
  child.unref();

  // Snapshot ALL settings into metrics.json so the UI can show
  // exactly what config produced this run (settings drift over time).
  writeFileSync(path.join(workdir, 'metrics.json'), JSON.stringify({
    tag,
    system_prompt: state.custom_prompt_active && state.use_proxy ? 'custom-via-proxy' : 'default',
    prompt_variant: 'bench',
    temperature: state.settings.temperature,
    max_completion_tokens: state.settings.max_completion_tokens,
    max_turns: state.settings.max_turns,
    // Full settings snapshot
    settings_snapshot: {
      temperature: state.settings.temperature,
      max_completion_tokens: state.settings.max_completion_tokens,
      max_turns: state.settings.max_turns,
      use_proxy: !!state.use_proxy,
      strip_reminders: !!state.strip_reminders,
      custom_prompt_active: !!state.custom_prompt_active,
      custom_prompt_length: (state.custom_prompt_active && state.custom_prompt) ? state.custom_prompt.length : 0,
      custom_prompt_preview: (state.custom_prompt_active && state.custom_prompt) ? state.custom_prompt.slice(0, 400) : null,
    },
    started_at: new Date().toISOString(),
    elapsed_seconds: 0,
    exit_code: null,
    index_lines: 0,
    has_index: false,
    _status: 'running',
    _pid: child.pid,
  }, null, 2));

  // When grok exits: flip status running → done/failed directly in Node.
  // Then (optionally) invoke finalize_run.py for the deeper session-event metrics
  // — but only if the script is actually present alongside this server.
  child.on('exit', (code) => {
    const metricsPath = path.join(workdir, 'metrics.json');
    setTimeout(() => {
      try {
        const m = JSON.parse(readFileSync(metricsPath, 'utf8'));
        const startedAt = m.started_at ? Date.parse(m.started_at) : null;
        m.exit_code = code;
        m._status = (code === 0) ? 'done' : 'failed';
        m.finished_at = new Date().toISOString();
        if (startedAt) m.elapsed_seconds = Math.round((Date.now() - startedAt) / 1000);
        // index_lines + has_index: count lines in any HTML/JS the model wrote
        try {
          const files = readdirSync(workdir).filter(f => /\.(html|js|css)$/i.test(f));
          if (files.length) {
            const main = files.find(f => f === 'index.html') || files[0];
            const lines = readFileSync(path.join(workdir, main), 'utf8').split('\n').length;
            m.index_lines = lines;
            m.has_index = lines > 0;
          }
        } catch {}
        writeFileSync(metricsPath, JSON.stringify(m, null, 2));
      } catch (e) {
        // metrics.json missing/corrupt — leave it
      }
      // Best-effort deeper finalize (optional; only if finalize_run.py is here)
      const finalizeScript = path.join(__dirname, 'finalize_run.py');
      if (existsSync(finalizeScript)) {
        const finalizer = spawn('python3', [finalizeScript, workdir, String(code ?? -1)], {
          stdio: 'ignore',
          env: { ...process.env, BENCH_ROOT: ROOT },
        });
        finalizer.unref();
      }
    }, 1500);
  });

  return { tag, pid: child.pid };
}

const requestHandler = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // CORS for any /api calls if needed
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // (static-file fallback for the built UI is at the bottom)

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const state = loadState();
    state.proxy_alive = await checkProxy();
    return json(res, state);
  }

  if (url.pathname === '/api/state' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const state = { ...loadState(), ...body };
      saveState(state);
      applyCustomPromptToDisk(state);
      return json(res, { ok: true, state });
    } catch (e) {
      return json(res, { error: String(e) }, 400);
    }
  }

  if (url.pathname === '/api/run' && req.method === 'POST') {
    try {
      const body = await readJson(req).catch(() => ({}));
      const state = { ...loadState(), ...body };
      saveState(state);
      applyCustomPromptToDisk(state);
      const r = fireRun(state);
      return json(res, { ok: true, ...r });
    } catch (e) {
      return json(res, { error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/runs') {
    return json(res, listRuns());
  }

  const m = url.pathname.match(/^\/api\/run\/([^/]+)\/log$/);
  if (m) {
    const folder = path.join(ROOT, m[1]);
    const log = path.join(folder, 'run.log');
    return plain(res, tailFile(log, 32 * 1024));
  }

  // File browser: list files in the run folder (skip captures/, metrics.json, prompt.txt)
  const fileList = url.pathname.match(/^\/api\/run\/([^/]+)\/files$/);
  if (fileList) {
    const dir = path.join(ROOT, fileList[1]);
    if (!existsSync(dir)) return json(res, []);
    const out = [];
    const walk = (rel) => {
      const full = path.join(dir, rel);
      let entries;
      try { entries = readdirSync(full, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const sub = rel ? path.join(rel, e.name) : e.name;
        // Skip noise
        if (!rel && (e.name === 'captures' || e.name === 'metrics.json' || e.name === 'run.log')) continue;
        if (e.name === '.DS_Store' || e.name === 'node_modules' || e.name.startsWith('.')) continue;
        if (e.isDirectory()) {
          walk(sub);
        } else {
          try {
            const st = statSync(path.join(dir, sub));
            out.push({ name: sub, size: st.size, mtime: st.mtimeMs });
          } catch {}
        }
      }
    };
    walk('');
    out.sort((a, b) => a.name.localeCompare(b.name));
    return json(res, out);
  }

  // File content: serve any file from the run folder (with mime guessing)
  const fileGet = url.pathname.match(/^\/api\/run\/([^/]+)\/file\/(.+)$/);
  if (fileGet) {
    const folder = decodeURIComponent(fileGet[1]);
    const rel = decodeURIComponent(fileGet[2]);
    // Prevent escape from the run folder
    const dir = path.resolve(path.join(ROOT, folder));
    const target = path.resolve(path.join(dir, rel));
    if (!target.startsWith(dir + path.sep) && target !== dir) {
      return plain(res, 'forbidden', 403);
    }
    if (!existsSync(target)) return plain(res, 'not found', 404);
    const ext = path.extname(target).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.htm':  'text/html; charset=utf-8',
      '.js':   'application/javascript; charset=utf-8',
      '.mjs':  'application/javascript; charset=utf-8',
      '.css':  'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.txt':  'text/plain; charset=utf-8',
      '.md':   'text/plain; charset=utf-8',
      '.png':  'image/png',
      '.jpg':  'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif':  'image/gif',
      '.svg':  'image/svg+xml',
      '.webp': 'image/webp',
      '.ico':  'image/x-icon',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    createReadStream(target).pipe(res);
    return;
  }

  const capList = url.pathname.match(/^\/api\/run\/([^/]+)\/captures$/);
  if (capList) {
    const dir = path.join(ROOT, capList[1], 'captures');
    if (!existsSync(dir)) return json(res, []);
    const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    const summaries = files.map(f => {
      try {
        const c = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
        const rs = c.response_summary || {};
        const toolCalls = rs.tool_calls || [];
        const u = rs.usage || {};
        return {
          file: f,
          tag: c.tag,
          ts: c.ts,
          method: c.method,
          path: c.path,
          status: c.status,
          rewrite_status: c.rewrite_status,
          elapsed_ms: c.elapsed_ms,
          events_count: rs.events_count || 0,
          output_chars: (rs.output_text || '').length,
          reasoning_chars: (rs.reasoning_summary || '').length,
          tool_calls_count: toolCalls.length,
          tool_calls_names: toolCalls.map(t => t.name).filter(Boolean),
          input_messages: Array.isArray(c.request?.input) ? c.request.input.length : 0,
          model: rs.model,
          api_status: rs.status,                       // "completed" / "incomplete" / etc.
          system_fingerprint: rs.system_fingerprint,
          service_tier: rs.service_tier,
          truncation: rs.truncation,
          background: rs.background,
          api_temperature: rs.temperature,
          api_top_p: rs.top_p,
          api_presence_penalty: rs.presence_penalty,
          api_frequency_penalty: rs.frequency_penalty,
          api_max_tool_calls: rs.max_tool_calls,
          api_max_output_tokens: rs.max_output_tokens,
          api_error: rs.error,
          api_incomplete_details: rs.incomplete_details,
          // Cost: 1 tick = 1e-9 USD (xAI convention); we surface raw + dollars
          cost_ticks: u.cost_in_usd_ticks ?? null,
          cost_usd: u.cost_in_usd_ticks != null ? u.cost_in_usd_ticks / 1e9 : null,
          tokens_input: u.input_tokens ?? null,
          tokens_cached: u.input_tokens_details?.cached_tokens ?? null,
          tokens_output: u.output_tokens ?? null,
          tokens_reasoning: u.output_tokens_details?.reasoning_tokens ?? null,
          tokens_total: u.total_tokens ?? null,
          num_sources_used: u.num_sources_used ?? null,
          num_server_side_tools_used: u.num_server_side_tools_used ?? null,
          usage: u,
          has_raw_sse: !!c.raw_sse_file,
        };
      } catch { return null; }
    }).filter(Boolean);
    return json(res, summaries);
  }

  // Raw SSE stream for a specific capture
  const capRaw = url.pathname.match(/^\/api\/run\/([^/]+)\/capture\/([^/]+)\/raw$/);
  if (capRaw) {
    const p = path.join(ROOT, capRaw[1], 'captures', capRaw[2]);
    if (!existsSync(p)) return plain(res, 'not found', 404);
    return plain(res, readFileSync(p, 'utf8'));
  }

  const capOne = url.pathname.match(/^\/api\/run\/([^/]+)\/capture\/(.+)$/);
  if (capOne) {
    const p = path.join(ROOT, capOne[1], 'captures', capOne[2]);
    if (!existsSync(p)) return json(res, { error: 'not found' }, 404);
    return json(res, JSON.parse(readFileSync(p, 'utf8')));
  }

  if (url.pathname === '/api/proxy/status') {
    return json(res, { alive: await checkProxy(), port: PROXY_PORT });
  }

  // --- grok user config (~/.grok/config.toml) editor ---
  const GROK_HOME_USER = path.join(process.env.HOME || '', '.grok');
  const USER_CONFIG = path.join(GROK_HOME_USER, 'config.toml');

  if (url.pathname === '/api/grok-config' && req.method === 'GET') {
    const exists = existsSync(USER_CONFIG);
    const text = exists ? readFileSync(USER_CONFIG, 'utf8') : '';
    // Snapshot the baseline ONCE — the original config when the editor was first opened
    const BASELINE = path.join(GROK_HOME_USER, 'config.toml.baseline');
    if (exists && !existsSync(BASELINE)) {
      try { writeFileSync(BASELINE, text); } catch {}
    }
    const baselineText = existsSync(BASELINE) ? readFileSync(BASELINE, 'utf8') : '';
    // List any timestamped backups + the baseline
    let backups = [];
    try {
      backups = readdirSync(GROK_HOME_USER)
        .filter(f => /^config\.toml\.bak\./.test(f))
        .sort().reverse();
    } catch {}
    return json(res, {
      path: USER_CONFIG,
      exists,
      text,
      length: text.length,
      backups,
      baseline: { exists: existsSync(BASELINE), text: baselineText, length: baselineText.length },
    });
  }

  // Return the text content of a specific backup (for preview/diff)
  const bakRead = url.pathname.match(/^\/api\/grok-config\/backup\/(.+)$/);
  if (bakRead && req.method === 'GET') {
    const name = decodeURIComponent(bakRead[1]);
    if (!/^config\.toml\.(bak\.|baseline$)/.test(name) || name.includes('/') || name.includes('..')) {
      return json(res, { error: 'invalid name' }, 400);
    }
    const p = path.join(GROK_HOME_USER, name);
    if (!existsSync(p)) return json(res, { error: 'not found' }, 404);
    return json(res, { name, text: readFileSync(p, 'utf8') });
  }

  if (url.pathname === '/api/grok-config' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const text = String(body.text ?? '');
      // Always back up an existing config before overwrite (timestamped)
      if (existsSync(USER_CONFIG)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const bak = `${USER_CONFIG}.bak.${ts}`;
        writeFileSync(bak, readFileSync(USER_CONFIG, 'utf8'));
      }
      mkdirSync(GROK_HOME_USER, { recursive: true });
      writeFileSync(USER_CONFIG, text);
      return json(res, { ok: true, path: USER_CONFIG, length: text.length });
    } catch (e) {
      return json(res, { error: String(e) }, 400);
    }
  }

  const restoreMatch = url.pathname.match(/^\/api\/grok-config\/restore\/(.+)$/);
  if (restoreMatch && req.method === 'POST') {
    const bakName = decodeURIComponent(restoreMatch[1]);
    if (!/^config\.toml\.(bak\.|baseline$)/.test(bakName) || bakName.includes('/') || bakName.includes('..')) {
      return json(res, { error: 'invalid backup name' }, 400);
    }
    const bakPath = path.join(GROK_HOME_USER, bakName);
    if (!existsSync(bakPath)) return json(res, { error: 'backup not found' }, 404);
    // Backup the current before restore (in case the user wants to flip back)
    if (existsSync(USER_CONFIG)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      writeFileSync(`${USER_CONFIG}.bak.${ts}`, readFileSync(USER_CONFIG, 'utf8'));
    }
    writeFileSync(USER_CONFIG, readFileSync(bakPath, 'utf8'));
    return json(res, { ok: true, restored_from: bakName });
  }

  // Run `grok inspect` to validate and show what grok actually discovers.
  if (url.pathname === '/api/grok-inspect') {
    const grokBin = process.env.GROK_BIN || path.join(process.env.HOME || '', '.grok/bin/grok');
    return new Promise((resolve) => {
      const child = spawn(grokBin, ['inspect'], {
        env: { ...process.env, GROK_HOME: GROK_HOME_USER },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', (b) => { out += b; });
      child.stderr.on('data', (b) => { err += b; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        json(res, { ok: code === 0, code, stdout: out, stderr: err });
        resolve();
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        json(res, { error: String(e) }, 500);
        resolve();
      });
    });
  }

  // Reveal a run folder in Finder (macOS only)
  const reveal = url.pathname.match(/^\/api\/run\/([^/]+)\/reveal$/);
  if (reveal && req.method === 'POST') {
    const folder = path.resolve(path.join(ROOT, reveal[1]));
    // Prevent escape from ROOT
    if (!folder.startsWith(path.resolve(ROOT) + path.sep)) {
      return json(res, { error: 'forbidden' }, 403);
    }
    if (!existsSync(folder)) return json(res, { error: 'not found' }, 404);
    spawn('open', [folder], { detached: true, stdio: 'ignore' }).unref();
    return json(res, { ok: true, path: folder });
  }

  // Grok's default system prompt (versioned reference, picks file matching
  // the installed grok binary; falls back to the highest available version)
  if (url.pathname === '/api/grok-default-prompt') {
    const resolved = resolveDefaultPromptFile();
    if (!resolved.file) {
      return json(res, { error: 'no versioned prompt files found in ./prompts/', available: [] }, 404);
    }
    const text = readFileSync(resolved.file, 'utf8');
    const sections = parsePromptSections(text);
    return json(res, {
      text, length: text.length, sections,
      version: resolved.version,
      installed_grok_version: detectGrokVersion(),
      matched: !!resolved.matched,
      available_versions: resolved.available,
      file: path.basename(resolved.file),
    });
  }

  if (url.pathname === '/api/grok-default-prompt/assemble' && req.method === 'POST') {
    try {
      const { include } = await readJson(req); // array of section names to KEEP
      const resolved = resolveDefaultPromptFile();
      if (!resolved.file) return json(res, { error: 'no versioned prompt files' }, 404);
      const text = readFileSync(resolved.file, 'utf8');
      const out = assemblePromptFromSections(text, include || []);
      return json(res, { text: out, length: out.length });
    } catch (e) {
      return json(res, { error: String(e) }, 400);
    }
  }

  if (url.pathname === '/api/proxy/captures') {
    const idx = path.join(PROXY_LOGS, 'index.jsonl');
    if (!existsSync(idx)) return json(res, []);
    const rows = readFileSync(idx, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    return json(res, rows.slice(-50).reverse());
  }

  // Prompt history: walk every bench_*/prompt.txt, group identical prompts,
  // surface aggregate metrics so the user can see "this prompt was used N
  // times, here's its cost / total tokens / latest run".
  if (url.pathname === '/api/prompt-history') {
    const groups = new Map(); // hashKey -> { text, count, runs[], totals }
    let entries;
    try { entries = readdirSync(ROOT, { withFileTypes: true }); }
    catch { return json(res, { prompts: [] }); }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (!ent.name.startsWith('bench_')) continue;
      const promptPath = path.join(ROOT, ent.name, 'prompt.txt');
      const metricsPath = path.join(ROOT, ent.name, 'metrics.json');
      if (!existsSync(promptPath)) continue;
      let promptText;
      try { promptText = readFileSync(promptPath, 'utf8'); } catch { continue; }
      promptText = promptText.replace(/\s+$/, '');
      if (!promptText) continue;
      let m = {};
      try { m = JSON.parse(readFileSync(metricsPath, 'utf8')); } catch {}
      const agg = aggregateRunMetrics(ent.name);
      const key = promptText; // exact-match grouping
      let g = groups.get(key);
      if (!g) {
        g = { text: promptText, count: 0, runs: [], totals: { cost_ticks: 0, total_tokens: 0, api_calls: 0 } };
        groups.set(key, g);
      }
      g.count++;
      const mtime = (() => { try { return statSync(metricsPath).mtimeMs; } catch { return 0; } })();
      g.runs.push({
        folder: ent.name,
        tag: m.tag || ent.name,
        started_at: m.started_at,
        status: m._status,
        temperature: m.temperature,
        max_completion_tokens: m.max_completion_tokens,
        max_turns: m.max_turns,
        cost_ticks: agg.sum_cost_ticks,
        total_tokens: agg.sum_total_tokens,
        api_calls: agg.api_calls,
        mtime,
      });
      g.totals.cost_ticks += agg.sum_cost_ticks;
      g.totals.total_tokens += agg.sum_total_tokens;
      g.totals.api_calls += agg.api_calls;
    }
    // Newest-first per group, then groups sorted by latest mtime
    const prompts = [...groups.values()].map(g => {
      g.runs.sort((a, b) => b.mtime - a.mtime);
      g.latest_mtime = g.runs[0]?.mtime || 0;
      return g;
    }).sort((a, b) => b.latest_mtime - a.latest_mtime);
    return json(res, { prompts });
  }

  // Static-file fallback for the built bench-ui (bench-ui/dist/)
  // Any GET that hasn't matched an /api/* route is treated as a UI asset.
  if (req.method === 'GET' && existsSync(UI_DIST_DIR)) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    // Strip the leading slash so path.join doesn't treat it as absolute
    rel = rel.replace(/^\/+/, '');
    const target = path.resolve(path.join(UI_DIST_DIR, rel));
    // Prevent escape from the dist dir
    if (target === UI_DIST_DIR || target.startsWith(UI_DIST_DIR + path.sep)) {
      // If the resolved path is a directory, look for its index.html
      let toServe = target;
      try {
        const st = statSync(toServe);
        if (st.isDirectory()) toServe = path.join(toServe, 'index.html');
      } catch { /* ENOENT below */ }
      if (existsSync(toServe)) {
        const ext = path.extname(toServe).toLowerCase();
        const mime = {
          '.html': 'text/html; charset=utf-8',
          '.js':   'application/javascript; charset=utf-8',
          '.mjs':  'application/javascript; charset=utf-8',
          '.css':  'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg':  'image/svg+xml',
          '.png':  'image/png',
          '.jpg':  'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif':  'image/gif',
          '.ico':  'image/x-icon',
          '.webp': 'image/webp',
          '.woff': 'font/woff',
          '.woff2':'font/woff2',
          '.map':  'application/json; charset=utf-8',
          '.txt':  'text/plain; charset=utf-8',
        }[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': mime,
          // No long-cache during dev; rebuilds replace files in place
          'Cache-Control': 'no-cache',
        });
        createReadStream(toServe).pipe(res);
        return;
      }
    }
  }

  plain(res, 'not found', 404);
};

// Public API: start({ port, root, proxyPort, uiDistDir, quiet })
// Returns the http.Server instance.
export function start({ port, root, proxyPort, uiDistDir, quiet = false } = {}) {
  if (root) {
    ROOT = path.resolve(root);
    STATE_FILE = path.join(ROOT, 'bench-state.json');
    CUSTOM_PROMPT_FILE = path.join(ROOT, 'custom_system_prompt.txt');
    CUSTOM_PROMPT_INACTIVE = path.join(ROOT, 'custom_system_prompt.txt.inactive');
    USER_PROMPT_FILE = path.join(ROOT, 'bench_user_prompt.txt');
    STRIP_REMINDERS_MARKER = path.join(ROOT, '.strip_reminders');
    PROXY_LOGS = path.join(ROOT, 'proxy_rewrite_logs');
  }
  if (port != null) PORT = port;
  if (proxyPort != null) PROXY_PORT = proxyPort;
  if (uiDistDir) UI_DIST_DIR = path.resolve(uiDistDir);

  const server = http.createServer(requestHandler);
  server.listen(PORT, '127.0.0.1', () => {
    if (quiet) return;
    console.log(`[bench-server] listening on http://127.0.0.1:${PORT}`);
    console.log(`  root: ${ROOT}`);
    if (existsSync(UI_DIST_DIR)) {
      console.log(`  ui:   ${UI_DIST_DIR} (open http://127.0.0.1:${PORT}/)`);
    } else {
      console.log(`  ui:   (no dist build — run 'npm run build' to enable in-process UI)`);
    }
  });
  return server;
}

// Direct-invoke: `node bench-server.js`
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 import.meta.url === `file://${path.resolve(process.argv[1] || '')}`;
if (isDirect) {
  start();
}
