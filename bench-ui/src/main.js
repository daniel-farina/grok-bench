const $ = (id) => document.getElementById(id);
let state = null;

async function loadState() {
  const r = await fetch('/api/state');
  state = await r.json();
  $('user-prompt').value = state.user_prompt || '';
  $('custom-prompt').value = state.custom_prompt || '';
  $('custom-prompt-active').checked = !!state.custom_prompt_active;
  updateCustomPromptBadge();
  $('temperature').value = state.settings?.temperature ?? 0.5;
  $('max-tokens').value = String(state.settings?.max_completion_tokens ?? '16384');
  $('max-turns').value = state.settings?.max_turns ?? 60;
  $('effort').value = state.settings?.effort ?? 'medium';
  $('use-proxy').checked = !!state.use_proxy;
  $('strip-reminders').checked = !!state.strip_reminders;
  $('proxy-dot').classList.toggle('on', !!state.proxy_alive);
  $('proxy-state').textContent = state.proxy_alive ? 'alive' : 'offline';
}

function gatherState() {
  return {
    user_prompt: $('user-prompt').value,
    custom_prompt: $('custom-prompt').value,
    custom_prompt_active: $('custom-prompt-active').checked,
    use_proxy: $('use-proxy').checked,
    strip_reminders: $('strip-reminders').checked,
    settings: {
      temperature: parseFloat($('temperature').value) || 0.5,
      max_completion_tokens: $('max-tokens').value,
      max_turns: parseInt($('max-turns').value) || 60,
      effort: $('effort').value || 'medium',
    },
  };
}

async function saveState() {
  const body = gatherState();
  await fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  $('user-prompt-saved').classList.add('show');
  $('custom-prompt-saved').classList.add('show');
  updateCustomPromptBadge();
  setTimeout(() => {
    $('user-prompt-saved').classList.remove('show');
    $('custom-prompt-saved').classList.remove('show');
  }, 800);
}

function updateCustomPromptBadge() {
  const badge = document.getElementById('custom-prompt-status');
  if (!badge) return;
  const active = $('custom-prompt-active').checked;
  const len = ($('custom-prompt').value || '').length;
  badge.textContent = active ? `ACTIVE · ${len}c` : 'OFF';
  badge.classList.toggle('cp-on', active);
  badge.classList.toggle('cp-off', !active);
}

async function startRun() {
  await saveState();
  const r = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  if (r.ok) {
    setTimeout(loadRuns, 500);
  } else {
    alert('failed to start run');
  }
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return '-';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return Math.round(n).toLocaleString();
}
function shortNum(v) {
  const n = (typeof v === 'string') ? parseInt(v, 10) : v;
  if (!Number.isFinite(n)) return String(v);
  if (n >= 1024) return Math.round(n / 1024) + 'k';
  return String(n);
}
function fmtSignedDelta(n) {
  if (!Number.isFinite(n) || n === 0) return '';
  const sign = n > 0 ? '+' : '−';
  const abs = Math.abs(n);
  const s = abs >= 1000 ? (abs / 1000).toFixed(1) + 'k' : String(abs);
  return sign + s;
}
function fmtAgo(epochMs) {
  if (!epochMs) return '-';
  const diff = (Date.now() - epochMs) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Per-row expansion state: { tag -> 'log' | 'captures' | null }
const expansionState = new Map();

// Starred runs (persisted to localStorage)
const starredRuns = new Set();
try {
  const raw = localStorage.getItem('bench.starredRuns');
  if (raw) for (const f of JSON.parse(raw)) starredRuns.add(f);
} catch {}
function saveStarred() {
  try { localStorage.setItem('bench.starredRuns', JSON.stringify([...starredRuns])); } catch {}
}
function toggleStar(tag) {
  if (starredRuns.has(tag)) starredRuns.delete(tag);
  else starredRuns.add(tag);
  saveStarred();
  // Force row re-render by clearing its fingerprint
  const tr = findRowTr(tag);
  if (tr) tr.dataset.fp = '';
  loadRuns();
}

function cssQ(s) { return String(s).replace(/"/g, '\\"'); }
function findRowTr(tag)       { return document.querySelector(`tr.row[data-folder="${cssQ(tag)}"]`); }
function findExpandedTr(tag)  { return document.querySelector(`tr.expanded-row[data-folder="${cssQ(tag)}"]`); }

// ----- charts -----
function renderCharts(rows) {
  // Oldest → newest (rows from API arrive newest-first)
  const ordered = rows.slice().reverse();
  if (!ordered.length) { $('charts').innerHTML = ''; return; }

  const charts = [
    { key: 'cost',       label: 'cost (USD)', color: 'var(--warn)',  fmt: v => '$' + (v/1e9).toFixed(4), val: r => r.cost_ticks || 0 },
    { key: 'tokens',     label: 'total tokens', color: 'var(--accent)', fmt: fmtNum, val: r => r.total_tokens || 0 },
    { key: 'output',     label: 'output tokens', color: 'var(--good)',   fmt: fmtNum, val: r => r.output_tokens || 0 },
    { key: 'reasoning',  label: 'reasoning tokens', color: '#a78bfa', fmt: fmtNum, val: r => r.reasoning_tokens || 0 },
    { key: 'calls',      label: 'API calls', color: 'var(--accent-2)', fmt: fmtNum, val: r => r.api_calls || 0 },
    { key: 'tools',      label: 'tool calls', color: '#f472b6', fmt: fmtNum, val: r => r.tool_call_count || 0 },
  ];
  $('charts').innerHTML = charts.map(c => svgChart(ordered, c)).join('');
}

function svgChart(rows, cfg) {
  const W = 460, H = 110, padL = 6, padR = 6, padT = 18, padB = 8;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = rows.length;
  const max = Math.max(1, ...rows.map(cfg.val));
  const bw = Math.max(1, innerW / n - 1);
  const totalVal = rows.reduce((a, r) => a + cfg.val(r), 0);

  const bars = rows.map((r, i) => {
    const v = cfg.val(r);
    const h = (v / max) * innerH;
    const x = padL + i * (innerW / n);
    const y = padT + (innerH - h);
    const starred = starredRuns.has(r._folder);
    const title = `${r.tag || r._folder}\n${cfg.label}: ${cfg.fmt(v)}\nt=${r.temperature} · max=${r.max_completion_tokens} · turns=${r.max_turns}${starred ? ' · ★' : ''}`;
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" fill="${cfg.color}" opacity="${starred ? 1 : 0.78}" data-folder="${r._folder}"><title>${escapeHtml(title)}</title></rect>` +
      (starred ? `<rect x="${x.toFixed(2)}" y="${(padT-2).toFixed(2)}" width="${bw.toFixed(2)}" height="2" fill="var(--warn)" />` : '');
  }).join('');

  const maxLabel = cfg.fmt(max);
  return `<div class="chart">
    <div class="chart-head">
      <span class="chart-label">${cfg.label}</span>
      <span class="chart-stats">max: <code>${maxLabel}</code> · total: <code>${cfg.fmt(totalVal)}</code> · n=${n}</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg">
      <line x1="${padL}" x2="${W-padR}" y1="${H-padB}" y2="${H-padB}" stroke="var(--border)" stroke-width="0.5"/>
      ${bars}
    </svg>
  </div>`;
}

function renderTotals(rows) {
  const totals = {
    runs: rows.length,
    starred: rows.filter(r => starredRuns.has(r._folder)).length,
    running: rows.filter(r => r._status === 'running').length,
    done: rows.filter(r => r._status === 'done').length,
    api_calls: 0, tool_calls: 0,
    input: 0, cached: 0, output: 0, reasoning: 0, total: 0,
    cost_ticks: 0,
  };
  for (const r of rows) {
    totals.api_calls  += r.api_calls || 0;
    totals.tool_calls += r.tool_call_count || 0;
    totals.input      += r.input_tokens || 0;
    totals.cached     += r.cached_tokens || 0;
    totals.output     += r.output_tokens || 0;
    totals.reasoning  += r.reasoning_tokens || 0;
    totals.total      += r.total_tokens || 0;
    totals.cost_ticks += r.cost_ticks || 0;
  }
  const cost = totals.cost_ticks / 1e9;
  const tiles = [
    { label: 'runs',       big: fmtNum(totals.runs),       sub: `${totals.starred}★ · ${totals.running} running · ${totals.done} done` },
    { label: 'API calls',  big: fmtNum(totals.api_calls),  sub: 'across all runs' },
    { label: 'tool calls', big: fmtNum(totals.tool_calls), sub: 'function_call events' },
    { label: 'input',      big: fmtNum(totals.input),      sub: `${fmtNum(totals.cached)} cached (${totals.input ? Math.round(totals.cached*100/totals.input) : 0}%)`, cls: 'in' },
    { label: 'output',     big: fmtNum(totals.output),     sub: `${fmtNum(totals.reasoning)} reasoning (${totals.output ? Math.round(totals.reasoning*100/totals.output) : 0}%)`, cls: 'out' },
    { label: 'total tokens', big: fmtNum(totals.total),    sub: 'in + out', cls: 'total' },
    { label: 'cost',       big: '$' + cost.toFixed(4),     sub: `${totals.runs ? '$' + (cost/totals.runs).toFixed(4) : '$0'} avg/run`, cls: 'cost' },
  ];
  const el = $('totals');
  el.innerHTML = tiles.map(t => `
    <div class="tile ${t.cls || ''}">
      <div class="tile-label">${t.label}</div>
      <div class="tile-big">${t.big}</div>
      <div class="tile-sub">${t.sub}</div>
    </div>`).join('');

}

async function loadRuns() {
  const r = await fetch('/api/runs');
  const rows = await r.json();
  $('run-count-text').textContent = `${rows.length} runs`;
  renderTotals(rows);
  renderCharts(rows);
  const container = $('runs');
  if (!rows.length) {
    container.innerHTML = '<div class="empty">No runs yet. Hit <strong>Run test</strong> to start one.</div>';
    return;
  }
  // Create table skeleton on first call (subsequent calls reuse it)
  let table = container.querySelector('table.runs-table');
  if (!table) {
    table = document.createElement('table');
    table.className = 'runs-table';
    table.innerHTML = `<thead><tr>
      <th></th><th title="star this run"></th><th>Tag</th><th title="sum cost (USD)">$</th><th>Status</th><th>When</th><th></th>
    </tr></thead><tbody></tbody>`;
    container.innerHTML = '';
    container.appendChild(table);
  }
  const tbody = table.querySelector('tbody');

  // Index existing data rows
  const existing = new Map();
  for (const tr of tbody.querySelectorAll('tr.row[data-folder]')) {
    existing.set(tr.dataset.folder, tr);
  }

  const visible = rows.slice(0, 100);
  const wanted = new Set();
  let anchor = null; // node to position the next data row after

  for (const r of visible) {
    wanted.add(r._folder);
    let tr = existing.get(r._folder);
    if (!tr) {
      tr = document.createElement('tr');
      tr.className = 'row';
      tr.dataset.folder = r._folder;
    }
    updateRowCells(tr, r);

    // Position: place tr immediately after `anchor` (or at top if null)
    if (anchor) {
      if (tr.previousElementSibling !== anchor) anchor.after(tr);
    } else {
      if (tbody.firstChild !== tr) tbody.prepend(tr);
    }
    // If this row has an expanded panel, keep it glued underneath
    const exp = findExpandedTr(r._folder);
    if (exp) {
      if (exp.previousElementSibling !== tr) tr.after(exp);
      anchor = exp;
    } else {
      anchor = tr;
    }
  }

  // Remove rows that are no longer in the data
  for (const [folder, tr] of existing) {
    if (!wanted.has(folder)) {
      const exp = findExpandedTr(folder);
      if (exp) exp.remove();
      tr.remove();
      expansionState.delete(folder);
    }
  }
}

function updateRowCells(tr, r) {
  const starred = starredRuns.has(r._folder);
  // Fingerprint to skip identical re-renders (prevents flicker)
  const snap = r.settings_snapshot || {};
  const fp = JSON.stringify([
    r._status, r.exit_code, r.has_index,
    r.index_lines, r.api_calls, r.estimated_billed_tokens,
    r._mtime, r.prompt_variant, r.system_prompt,
    r.temperature, r.max_completion_tokens, r.max_turns,
    snap.effort, snap.strip_reminders, snap.use_proxy,
    snap.custom_prompt_active, snap.custom_prompt_length,
    !!expansionState.get(r._folder),
    starred,
  ]);
  if (tr.dataset.fp === fp) return;
  tr.dataset.fp = fp;

  let status = r._status;
  if (!status) {
    if (r.exit_code === null) status = 'running';
    else if (r.exit_code === 0) status = 'done';
    else if (r.has_index) status = 'done';
    else status = 'failed';
  }
  const statusClass = status === 'done' ? 'status-done' : status === 'running' ? 'status-running' : 'muted';
  const play = r.has_index ? `<a class="play" href="/${r._folder}/index.html" target="_blank" rel="noopener">play</a>` : '';
  tr.classList.toggle('row-expanded', !!expansionState.get(r._folder));
  tr.classList.toggle('row-starred', starred);

  const starBtn = `<button class="star-btn" data-action="star" data-tag="${r._folder}" title="${starred ? 'unstar' : 'star'} this run" aria-pressed="${starred}">${starred ? '★' : '☆'}</button>`;

  const costUsd = (r.cost_ticks != null) ? (r.cost_ticks / 1e9) : null;
  const fullPath = r._full_path || r._folder || '';
  // System-prompt indicator chip: "default" (gray) or "custom -2.3k" (teal w/ delta)
  const isCustom = (r.system_prompt && r.system_prompt !== 'default') || snap.custom_prompt_active === true;
  const customLen = snap.custom_prompt_length || 0;
  const defaultLen = 12367; // grok 0.1.211 default; shipped reference
  const sysChip = isCustom
    ? `<span class="rs-chip rs-custom" title="proxy replaced grok's 12K default with a ${customLen}-char custom prompt">custom${customLen ? ` ${fmtSignedDelta(customLen - defaultLen)}` : ''}</span>`
    : `<span class="rs-chip rs-default" title="full grok default 12K system prompt">default</span>`;
  // Settings chips
  const settingsChips = [sysChip];
  if (r.temperature != null) settingsChips.push(`<span class="rs-chip" title="temperature">t=${r.temperature}</span>`);
  if (r.max_completion_tokens != null) settingsChips.push(`<span class="rs-chip" title="max_completion_tokens">max=${shortNum(r.max_completion_tokens)}</span>`);
  if (r.max_turns != null) settingsChips.push(`<span class="rs-chip" title="max_turns">turns=${r.max_turns}</span>`);
  if (snap.effort != null) settingsChips.push(`<span class="rs-chip" title="--reasoning-effort">effort=${snap.effort}</span>`);
  if (snap.strip_reminders != null) settingsChips.push(`<span class="rs-chip ${snap.strip_reminders ? 'rs-on' : 'rs-off'}" title="strip &lt;system-reminder&gt; (skill catalog)">strip ${snap.strip_reminders ? '✓' : '✗'}</span>`);
  if (snap.use_proxy != null) settingsChips.push(`<span class="rs-chip ${snap.use_proxy ? 'rs-on' : 'rs-off'}" title="route through rewriting proxy">proxy ${snap.use_proxy ? '✓' : '✗'}</span>`);

  // Metric chips (moved from table columns to free up horizontal space)
  const cachePct = r.input_tokens ? Math.round((r.cached_tokens || 0) * 100 / r.input_tokens) : null;
  const reasPct  = r.output_tokens ? Math.round((r.reasoning_tokens || 0) * 100 / r.output_tokens) : null;
  const metricChips = [];
  if (r.api_calls != null) metricChips.push(`<span class="rs-chip rs-metric" title="API calls">${fmtNum(r.api_calls)} calls</span>`);
  if (r.tool_call_count != null) metricChips.push(`<span class="rs-chip rs-metric" title="function_call events">${fmtNum(r.tool_call_count)} tools</span>`);
  if (r.index_lines) metricChips.push(`<span class="rs-chip rs-metric" title="lines of generated output">${fmtNum(r.index_lines)} lines</span>`);
  if (r.input_tokens != null) metricChips.push(`<span class="rs-chip rs-metric" title="input tokens · cached%">in ${fmtNum(r.input_tokens)}${cachePct != null ? ` <span class="muted">(${cachePct}% cache)</span>` : ''}</span>`);
  if (r.output_tokens != null) metricChips.push(`<span class="rs-chip rs-metric" title="output tokens · reasoning%">out ${fmtNum(r.output_tokens)}${reasPct != null ? ` <span class="muted">(${reasPct}% reas)</span>` : ''}</span>`);
  if (r.total_tokens != null) metricChips.push(`<span class="rs-chip rs-metric" title="sum of input + output tokens">total ${fmtNum(r.total_tokens)}</span>`);

  const tagCell = `
    <div class="tag-stack">
      <div class="tag-name">
        <code title="${escapeHtml(r.system_prompt || 'default')} · t=${r.temperature} · max=${r.max_completion_tokens}">${escapeHtml(r.tag || r._folder)}</code>
      </div>
      <div class="tag-path-row">
        <button class="reveal-btn" data-action="reveal" data-tag="${r._folder}" title="open this folder in Finder">📂</button>
        <span class="tag-path" title="${escapeHtml(fullPath)}">${escapeHtml(fullPath)}</span>
      </div>
      <div class="tag-settings">${settingsChips.join('')}</div>
      <div class="tag-metrics">${metricChips.join('')}</div>
    </div>`;
  tr.innerHTML = `
    <td><span class="chev">&#x25B8;</span></td>
    <td>${starBtn}</td>
    <td>${tagCell}</td>
    <td class="cost-col">${costUsd != null ? '$' + costUsd.toFixed(4) : '-'}</td>
    <td class="${statusClass}">${status}</td>
    <td class="muted">${fmtAgo(r._mtime)}</td>
    <td><div class="row-actions">
      <button class="btn secondary" data-action="log" data-tag="${r._folder}" title="view run.log">log</button>
      <button class="btn secondary" data-action="captures" data-tag="${r._folder}" title="view captures">caps</button>
      ${play}
    </div></td>`;
}

// Delegated click handler — attached once, never torn down.
// Handles three things:
//   1. clicks on `button[data-action]` (star/reveal/log/captures)
//   2. clicks on links (`play`, `view`, etc.) — let those bubble naturally
//   3. clicks anywhere else inside a row → toggle the expansion (default tab: metrics)
function onRunsClick(ev) {
  // Let real links work — never hijack them
  if (ev.target.closest('a')) return;
  const btn = ev.target.closest('button[data-action]');
  if (btn) {
    ev.stopPropagation();
    const tag = btn.dataset.tag;
    const action = btn.dataset.action;
    if (action === 'star') { toggleStar(tag); return; }
    if (action === 'reveal') { fetch(`/api/run/${tag}/reveal`, { method: 'POST' }).catch(() => {}); return; }
    const cur = expansionState.get(tag);
    const row = findRowTr(tag);
    if (cur === action) {
      expansionState.delete(tag);
      collapsePanel(tag);
      if (row) row.classList.remove('row-expanded');
    } else {
      expansionState.set(tag, action);
      expandPanel(tag, action);
      if (row) row.classList.add('row-expanded');
    }
    return;
  }
  // Otherwise: row-level click toggles expansion (default tab: metrics)
  const row = ev.target.closest('tr.row[data-folder]');
  if (!row) return;
  // Don't react when clicking inside the expanded panel itself
  if (ev.target.closest('tr.expanded-row')) return;
  const tag = row.dataset.folder;
  const cur = expansionState.get(tag);
  if (cur) {
    expansionState.delete(tag);
    collapsePanel(tag);
    row.classList.remove('row-expanded');
  } else {
    const def = 'metrics';
    expansionState.set(tag, def);
    expandPanel(tag, def);
    row.classList.add('row-expanded');
  }
}

function collapsePanel(tag) {
  clearPanelPoller(tag);
  const exp = findExpandedTr(tag);
  if (exp) exp.remove();
}

// ---- Per-run metrics view (new) ----
async function renderMetricsInto(folder, container) {
  try {
    const [runsR, capsR] = await Promise.all([
      fetch('/api/runs'),
      fetch(`/api/run/${folder}/captures`),
    ]);
    const all = await runsR.json();
    const caps = await capsR.json();
    const run = all.find(x => x._folder === folder) || {};
    if (!caps.length) {
      container.innerHTML = '<div class="run-panel-empty">No captures yet — run hasn\'t produced API calls (proxy may be off, or run just started).</div>';
      return;
    }
    container.innerHTML = '';
    container.appendChild(renderMetricsSummary(run, caps));
    container.appendChild(renderMetricsTimeline(caps));
    container.appendChild(renderMetricsTokens(caps));
    container.appendChild(renderMetricsToolPie(caps));
    container.appendChild(renderMetricsCumCost(caps));
    container.appendChild(renderMetricsCacheHit(caps));
  } catch (e) {
    container.innerHTML = `<span style="color:var(--bad)">${e.message}</span>`;
  }
}

function metricsSection(title, hint = '') {
  const sec = document.createElement('div');
  sec.className = 'mx-section';
  sec.innerHTML = `<div class="mx-section-head"><h4>${title}</h4>${hint ? `<span class="muted">${hint}</span>` : ''}</div>`;
  return sec;
}

function renderMetricsSummary(run, caps) {
  // Roll up everything we know
  const totals = caps.reduce((a, c) => {
    a.elapsed += (c.elapsed_ms || 0);
    a.input   += (c.tokens_input || 0);
    a.cached  += (c.tokens_cached || 0);
    a.output  += (c.tokens_output || 0);
    a.reasoning += (c.tokens_reasoning || 0);
    a.total   += (c.tokens_total || 0);
    a.cost    += (c.cost_usd || 0);
    a.tools   += (c.tool_calls_count || 0);
    a.events  += (c.events_count || 0);
    return a;
  }, { elapsed:0, input:0, cached:0, output:0, reasoning:0, total:0, cost:0, tools:0, events:0 });

  // Wall-clock duration (start of first → end of last)
  const tsStart = caps[0]?.ts ? caps[0].ts * 1000 : null;
  const tsEnd   = (caps[caps.length-1]?.ts ? caps[caps.length-1].ts * 1000 : null)
                  + (caps[caps.length-1]?.elapsed_ms || 0);
  const wallSec = (tsStart && tsEnd && tsEnd > tsStart) ? Math.round((tsEnd - tsStart) / 1000) : null;
  const apiSec  = totals.elapsed / 1000;
  const cacheRate = totals.input ? (totals.cached / totals.input * 100) : 0;
  const reasoningRate = totals.output ? (totals.reasoning / totals.output * 100) : 0;

  const tiles = [
    { label: 'API calls',     big: caps.length },
    { label: 'tool calls',    big: totals.tools, sub: 'function_call events' },
    { label: 'wall time',     big: wallSec != null ? fmtDuration(wallSec) : '-', sub: 'first → last capture' },
    { label: 'API time',      big: fmtDuration(apiSec), sub: `${Math.round(apiSec/caps.length)}s avg/call` },
    { label: 'total tokens',  big: fmtNum(totals.total),  sub: `in ${fmtNum(totals.input)} · out ${fmtNum(totals.output)}` },
    { label: 'cache rate',    big: cacheRate.toFixed(0) + '%', sub: `${fmtNum(totals.cached)} cached` },
    { label: 'reasoning %',   big: reasoningRate.toFixed(0) + '%', sub: `${fmtNum(totals.reasoning)} of ${fmtNum(totals.output)} out` },
    { label: 'cost',          big: '$' + totals.cost.toFixed(4), sub: `$${(totals.cost/caps.length).toFixed(4)} avg/call` },
  ];

  const wrap = document.createElement('div');
  wrap.className = 'mx-summary';
  wrap.innerHTML = tiles.map(t => `
    <div class="mx-tile">
      <div class="mx-tile-label">${t.label}</div>
      <div class="mx-tile-big">${t.big}</div>
      ${t.sub ? `<div class="mx-tile-sub">${t.sub}</div>` : ''}
    </div>`).join('');
  return wrap;
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '-';
  sec = Math.round(sec);
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Color for a tool name — stable hash → HSL.
// Lightness ~48% gives enough contrast for white text on all hues.
function colorForTool(name) {
  if (!name) return 'var(--dim)';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 48%)`;
}

// Timeline: each capture as a horizontal bar on a time axis. Width = elapsed_ms.
// Plain HTML/CSS implementation: each row is a div with a track + bar positioned
// via percentages, so it's fully responsive and scales with the container width
// no matter how many captures there are.
function renderMetricsTimeline(caps) {
  const sec = metricsSection('Timeline', 'each API call positioned by start time · width = duration');
  const start = caps[0]?.ts * 1000 || 0;
  const end   = Math.max(...caps.map(c => (c.ts*1000) + (c.elapsed_ms || 0)));
  const span  = Math.max(1, end - start);
  const totalSec = span / 1000;

  // Axis ticks (5 evenly spaced)
  const tickFracs = [0, 0.25, 0.5, 0.75, 1];

  const rowsHtml = caps.map((c, i) => {
    const leftPct  = ((c.ts*1000 - start) / span) * 100;
    const rawPct   = ((c.elapsed_ms || 0) / span) * 100;
    const name = (c.tool_calls_names && c.tool_calls_names[0]) || (c.output_chars ? 'output_text' : '?');
    const col = colorForTool(name);
    const dur = fmtDurationMs(c.elapsed_ms || 0);
    const tip = `#${i+1} ${name} · ${dur} · in:${c.tokens_input||0} out:${c.tokens_output||0} · $${(c.cost_usd||0).toFixed(4)}`;

    // Wide bars get an inline label; narrow bars get the label hanging to the right.
    // 6% of track width is the threshold (works at any container width).
    const wide = rawPct >= 6;
    const insideLabel = wide
      ? `<span class="tl-bar-label">${escapeHtml(name)} <span class="tl-bar-dur">${dur}</span></span>`
      : '';
    const outsideLabel = !wide
      ? `<div class="tl-outside" style="left: calc(${leftPct.toFixed(3)}% + ${Math.max(rawPct, 0).toFixed(3)}% + 8px);">${escapeHtml(name)} <span class="tl-outside-dur">${dur}</span></div>`
      : '';

    return `
      <div class="tl-row">
        <div class="tl-index">#${i+1}</div>
        <div class="tl-track" title="${escapeHtml(tip)}">
          <div class="tl-bar" style="left: ${leftPct.toFixed(3)}%; width: ${rawPct.toFixed(3)}%; background: ${col};">${insideLabel}</div>
          ${outsideLabel}
        </div>
      </div>`;
  }).join('');

  const tickLines = tickFracs.map(f =>
    `<div class="tl-guide" style="left: ${(f * 100).toFixed(3)}%;"></div>`
  ).join('');
  const tickLabels = tickFracs.map((f, i) => {
    const pos = (f * 100).toFixed(3);
    const cls = i === 0 ? 'tl-tick-start' : i === tickFracs.length - 1 ? 'tl-tick-end' : 'tl-tick-mid';
    return `<div class="tl-tick ${cls}" style="left: ${pos}%;">${fmtDuration(totalSec * f)}</div>`;
  }).join('');

  const body = document.createElement('div');
  body.className = 'mx-chart tl-wrap';
  body.innerHTML = `
    <div class="tl-rows">
      <div class="tl-guides">${tickLines}</div>
      ${rowsHtml}
    </div>
    <div class="tl-axis">
      <div class="tl-index"></div>
      <div class="tl-track tl-track-axis">${tickLabels}</div>
    </div>`;
  sec.appendChild(body);
  return sec;
}

function fmtDurationMs(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

// Stacked tokens per call: cached + (input-cached) + reasoning + (output-reasoning)
function renderMetricsTokens(caps) {
  const sec = metricsSection('Tokens per call', 'cached | input | reasoning | visible-output');
  const W = 1000, padL = 6, padR = 6, padT = 6, padB = 16, H = 160;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = caps.length;
  const bw = Math.max(2, innerW / n - 1);
  const max = Math.max(1, ...caps.map(c => (c.tokens_input||0) + (c.tokens_output||0)));
  const COLORS = {
    cached: '#3a4a5a',
    input: 'var(--accent-2)',
    reasoning: '#a78bfa',
    output: 'var(--good)',
  };
  const rects = caps.map((c, i) => {
    const x = padL + i * (innerW / n);
    const cached = c.tokens_cached || 0;
    const inputUncached = Math.max(0, (c.tokens_input || 0) - cached);
    const reasoning = c.tokens_reasoning || 0;
    const outputVisible = Math.max(0, (c.tokens_output || 0) - reasoning);
    let yCursor = padT + innerH;
    const segs = [
      { val: cached, color: COLORS.cached, label: 'cached' },
      { val: inputUncached, color: COLORS.input, label: 'input' },
      { val: reasoning, color: COLORS.reasoning, label: 'reasoning' },
      { val: outputVisible, color: COLORS.output, label: 'output' },
    ];
    const parts = segs.map(s => {
      if (s.val <= 0) return '';
      const h = (s.val / max) * innerH;
      yCursor -= h;
      return `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${s.color}"><title>#${i+1} ${s.label}: ${s.val}</title></rect>`;
    }).join('');
    return parts;
  }).join('');
  const body = document.createElement('div');
  body.className = 'mx-chart';
  body.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:160px;">
      <line x1="${padL}" x2="${W-padR}" y1="${H-padB}" y2="${H-padB}" stroke="var(--border)" stroke-width="0.5"/>
      ${rects}
    </svg>
    <div class="mx-legend">
      <span><span class="mx-swatch" style="background:#3a4a5a;"></span>cached</span>
      <span><span class="mx-swatch" style="background:var(--accent-2);"></span>input (uncached)</span>
      <span><span class="mx-swatch" style="background:#a78bfa;"></span>reasoning</span>
      <span><span class="mx-swatch" style="background:var(--good);"></span>visible output</span>
    </div>
  `;
  sec.appendChild(body);
  return sec;
}

// Tool call distribution — horizontal bars
function renderMetricsToolPie(caps) {
  const counts = {};
  for (const c of caps) {
    for (const name of (c.tool_calls_names || [])) {
      counts[name] = (counts[name] || 0) + 1;
    }
  }
  const sec = metricsSection('Tools called', 'function_call by name');
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    sec.appendChild(Object.assign(document.createElement('div'), {
      innerHTML: '<div class="run-panel-empty">no tool calls in this run</div>',
    }));
    return sec;
  }
  const max = entries[0][1];
  const body = document.createElement('div');
  body.className = 'mx-bars';
  body.innerHTML = entries.map(([name, n]) => `
    <div class="mx-bar-row">
      <span class="mx-bar-label">${escapeHtml(name)}</span>
      <div class="mx-bar-track">
        <div class="mx-bar-fill" style="width:${(n*100/max).toFixed(1)}%; background:${colorForTool(name)};"></div>
      </div>
      <span class="mx-bar-val">${n}</span>
    </div>
  `).join('');
  sec.appendChild(body);
  return sec;
}

// Cumulative cost (USD) line chart
function renderMetricsCumCost(caps) {
  const sec = metricsSection('Cumulative cost', 'USD accumulated as the run progresses');
  const W = 1000, padL = 8, padR = 8, padT = 8, padB = 18, H = 130;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  let cum = 0;
  const points = caps.map((c, i) => {
    cum += (c.cost_usd || 0);
    return { x: padL + (i / Math.max(1, caps.length - 1)) * innerW, v: cum };
  });
  const maxCum = Math.max(1e-9, points[points.length - 1].v);
  const path = points.map((p, i) => {
    const y = padT + innerH - (p.v / maxCum) * innerH;
    return `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
  const body = document.createElement('div');
  body.className = 'mx-chart';
  body.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:130px;">
      <line x1="${padL}" x2="${W-padR}" y1="${H-padB}" y2="${H-padB}" stroke="var(--border)" stroke-width="0.5"/>
      <path d="${path}" stroke="var(--warn)" stroke-width="2" fill="none"/>
      <text x="${padL}" y="14" fill="var(--text-muted)" font-size="10" font-family="var(--mono)">$0</text>
      <text x="${W-padR}" y="14" fill="var(--text-muted)" font-size="10" font-family="var(--mono)" text-anchor="end">$${maxCum.toFixed(4)}</text>
    </svg>
  `;
  sec.appendChild(body);
  return sec;
}

// Cache hit rate per call
function renderMetricsCacheHit(caps) {
  const sec = metricsSection('Cache hit rate per call', '% of input tokens served from prompt cache (higher = cheaper)');
  const W = 1000, padL = 8, padR = 8, padT = 8, padB = 18, H = 110;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = caps.length;
  const bw = Math.max(2, innerW / n - 1);
  const bars = caps.map((c, i) => {
    const rate = (c.tokens_input ? (c.tokens_cached || 0) / c.tokens_input : 0);
    const x = padL + i * (innerW / n);
    const h = rate * innerH;
    const y = padT + innerH - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="var(--accent-2)" opacity="0.8"><title>#${i+1}: ${(rate*100).toFixed(1)}%</title></rect>`;
  }).join('');
  const body = document.createElement('div');
  body.className = 'mx-chart';
  body.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:110px;">
      <line x1="${padL}" x2="${W-padR}" y1="${H-padB}" y2="${H-padB}" stroke="var(--border)" stroke-width="0.5"/>
      <line x1="${padL}" x2="${W-padR}" y1="${padT}" y2="${padT}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="2,4"/>
      <text x="${padL}" y="14" fill="var(--text-muted)" font-size="10" font-family="var(--mono)">100%</text>
      <text x="${padL}" y="${H-padB-2}" fill="var(--text-muted)" font-size="10" font-family="var(--mono)">0%</text>
      ${bars}
    </svg>
  `;
  sec.appendChild(body);
  return sec;
}

async function renderFilesPanel(tag, body) {
  try {
    const r = await fetch(`/api/run/${tag}/files`);
    const list = await r.json();
    if (!list.length) {
      body.innerHTML = '<div style="color:var(--text-muted); font-size:11px;">no files yet</div>';
      return;
    }
    body.innerHTML = '';
    for (const f of list) {
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      const fileUrl = `/api/run/${tag}/file/${encodeURIComponent(f.name).replace(/%2F/g,'/')}`;
      const isHtml = ext === 'html' || ext === 'htm';
      const isViewable = ['html','htm','js','mjs','css','json','txt','md','svg','png','jpg','jpeg','gif','webp'].includes(ext);
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 4px 0; border-bottom: 1px solid var(--border);';
      const link = document.createElement('a');
      link.href = fileUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.style.cssText = `flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; ${isViewable ? 'color:var(--accent-2)' : 'color:var(--text-muted); pointer-events:none'}; text-decoration:none; font-size:11px;`;
      link.textContent = f.name;
      const sz = document.createElement('span');
      sz.style.cssText = 'color: var(--text-muted); font-size: 10px; white-space: nowrap;';
      sz.textContent = fmtBytes(f.size);
      row.appendChild(link);
      row.appendChild(sz);
      if (isHtml) {
        const play = document.createElement('a');
        play.href = fileUrl;
        play.target = '_blank';
        play.rel = 'noopener';
        play.textContent = '▶';
        play.title = 'open as page';
        play.style.cssText = 'color: var(--accent); padding: 0 4px; text-decoration: none;';
        row.appendChild(play);
      }
      body.appendChild(row);
    }
  } catch (e) {
    body.innerHTML = `<span style="color:var(--bad)">${e.message}</span>`;
  }
}

function expandPanel(tag, action) {
  let exp = findExpandedTr(tag);
  if (!exp) {
    const row = findRowTr(tag);
    if (!row) return;
    exp = document.createElement('tr');
    exp.className = 'expanded-row';
    exp.dataset.folder = tag;
    const td = document.createElement('td');
    td.colSpan = 7;
    const panel = document.createElement('div');
    panel.className = 'run-panel';
    panel.innerHTML = `
      <div class="run-panel-tabs">
        <button data-tab="metrics">metrics</button>
        <button data-tab="log">run.log</button>
        <button data-tab="captures">captures</button>
        <button data-tab="settings">settings</button>
        <button class="panel-close" title="Close">&times;</button>
      </div>
      <div class="run-panel-split">
        <div class="run-panel-main">
          <div class="run-panel-content"></div>
        </div>
        <aside class="run-panel-files">
          <h3>files in run folder</h3>
          <div class="run-panel-files-body"><em style="color:var(--text-muted)">loading…</em></div>
        </aside>
      </div>`;
    td.appendChild(panel);
    exp.appendChild(td);
    row.after(exp);

    // Files panel: always loaded on expand + refreshed periodically while expanded
    const filesBody = panel.querySelector('.run-panel-files-body');
    renderFilesPanel(tag, filesBody);
    const filesInterval = setInterval(() => {
      if (!findExpandedTr(tag)) {
        clearInterval(filesInterval);
        return;
      }
      renderFilesPanel(tag, filesBody);
    }, 5000);

    panel.querySelector('.panel-close').addEventListener('click', () => {
      expansionState.delete(tag);
      collapsePanel(tag);
      const r2 = findRowTr(tag);
      if (r2) r2.classList.remove('row-expanded');
    });
    for (const tabBtn of panel.querySelectorAll('[data-tab]')) {
      tabBtn.addEventListener('click', () => {
        const t = tabBtn.dataset.tab;
        if (expansionState.get(tag) === t) return;
        expansionState.set(tag, t);
        renderPanel(tag, t);
      });
    }
  }
  renderPanel(tag, action);
}

// Per-tag live-update interval IDs (one each for log/captures content area)
const panelPollers = new Map();
function clearPanelPoller(tag) {
  const id = panelPollers.get(tag);
  if (id) { clearInterval(id); panelPollers.delete(tag); }
}

function renderPanel(tag, action) {
  const exp = findExpandedTr(tag);
  if (!exp) return;
  const panel = exp.querySelector('.run-panel');
  for (const btn of panel.querySelectorAll('[data-tab]')) {
    btn.classList.toggle('active', btn.dataset.tab === action);
  }
  const content = panel.querySelector('.run-panel-content');
  content.classList.remove('captures-body');
  content.innerHTML = '<em style="color:var(--text-muted)">loading…</em>';
  // Clear any previously-running poller for this tag (e.g. switching tabs)
  clearPanelPoller(tag);
  if (action === 'log') {
    renderLogInto(tag, content);
    // Live: refresh log every 3s, preserving scroll if at bottom
    panelPollers.set(tag, setInterval(() => {
      if (!findExpandedTr(tag) || expansionState.get(tag) !== 'log') {
        clearPanelPoller(tag);
        return;
      }
      refreshLogInto(tag, content);
    }, 3000));
  } else if (action === 'metrics') {
    content.classList.add('captures-body');
    renderMetricsInto(tag, content);
    // Live refresh metrics every 4s while open
    panelPollers.set(tag, setInterval(() => {
      if (!findExpandedTr(tag) || expansionState.get(tag) !== 'metrics') {
        clearPanelPoller(tag);
        return;
      }
      renderMetricsInto(tag, content);
    }, 4000));
  } else if (action === 'captures') {
    content.classList.add('captures-body');
    renderCapturesInto(tag, content);
    // Live: poll for new captures every 3s; append without disturbing opened blocks
    panelPollers.set(tag, setInterval(() => {
      if (!findExpandedTr(tag) || expansionState.get(tag) !== 'captures') {
        clearPanelPoller(tag);
        return;
      }
      refreshCapturesInto(tag, content);
    }, 3000));
  } else if (action === 'settings') {
    content.classList.add('captures-body');
    renderSettingsInto(tag, content);
  }
}

async function renderSettingsInto(folder, container) {
  try {
    const r = await fetch('/api/runs');
    const all = await r.json();
    const run = all.find(x => x._folder === folder);
    if (!run) {
      container.innerHTML = '<div class="run-panel-empty">run not found in /api/runs</div>';
      return;
    }
    const snap = run.settings_snapshot || {};
    // Fetch the actual prompt text for this run
    let promptText = '';
    try {
      const rp = await fetch(`/api/run/${folder}/file/prompt.txt`);
      if (rp.ok) promptText = await rp.text();
    } catch {}
    const rows = [
      ['tag', run.tag || run._folder],
      ['full path', run._full_path || '(unknown)'],
      ['started_at', run.started_at],
      ['system_prompt', run.system_prompt],
      ['', null],
      ['temperature', snap.temperature ?? run.temperature],
      ['max_completion_tokens', snap.max_completion_tokens ?? run.max_completion_tokens],
      ['max_turns', snap.max_turns ?? run.max_turns],
      ['--reasoning-effort', snap.effort ?? '(unknown — older run)'],
      ['', null],
      ['use_proxy', snap.use_proxy],
      ['strip_reminders', snap.strip_reminders],
      ['custom_prompt_active', snap.custom_prompt_active],
      ['custom_prompt_length', snap.custom_prompt_length || 0],
      ['', null],
      ['_pid', run._pid],
      ['_status', run._status],
      ['exit_code', run.exit_code],
    ];
    const grid = rows.map(([k, v]) => {
      if (!k) return `<div style="grid-column:1/-1;height:6px;"></div>`;
      const dv = v == null || v === '' ? '<span class="muted">-</span>' : `<code>${escapeHtml(String(v))}</code>`;
      return `<span style="color:var(--text-muted);">${escapeHtml(k)}:</span>${dv}`;
    }).join('');
    let html = `<div style="display:grid; grid-template-columns:max-content 1fr; gap:4px 14px; font-size:12px; padding:6px 4px;">${grid}</div>`;
    html += `<details open style="margin-top:14px;"><summary style="cursor:pointer;color:var(--accent-2);font-size:11px;">user_prompt (${promptText.length} chars)</summary>
      <pre style="background:#050709;padding:10px;border-radius:5px;margin:6px 0 0;font-size:11px;max-height:240px;overflow:auto;white-space:pre-wrap;">${escapeHtml(promptText) || '<em class="muted">(empty)</em>'}</pre>
    </details>`;
    if (snap.custom_prompt_preview) {
      html += `<details style="margin-top:8px;"><summary style="cursor:pointer;color:var(--accent);font-size:11px;">custom_system_prompt preview (${snap.custom_prompt_length} chars, first 400 shown)</summary>
        <pre style="background:#050709;padding:10px;border-radius:5px;margin:6px 0 0;font-size:11px;max-height:240px;overflow:auto;white-space:pre-wrap;">${escapeHtml(snap.custom_prompt_preview)}</pre>
      </details>`;
    }
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<span style="color:var(--bad)">${e.message}</span>`;
  }
}

// Live log refresh: re-fetch text, preserve scroll position if user is at bottom.
async function refreshLogInto(folder, container) {
  try {
    const r = await fetch(`/api/run/${folder}/log`);
    const txt = await r.text();
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 30;
    const trimmed = txt.trim();
    if (!trimmed) {
      // keep showing empty-state placeholder
      return;
    }
    if (container.textContent === txt) return; // no change
    container.textContent = txt;
    if (atBottom) container.scrollTop = container.scrollHeight;
  } catch { /* transient — try again next tick */ }
}

async function renderFilesInto(folder, container) {
  try {
    const r = await fetch(`/api/run/${folder}/files`);
    const list = await r.json();
    if (!list.length) {
      container.innerHTML = '<div class="run-panel-empty">No files yet in this run folder. The model may not have written anything (e.g. it\'s still reasoning) or the run errored before write_file calls.</div>';
      return;
    }
    container.innerHTML = '';
    const head = document.createElement('div');
    head.style.cssText = 'color: var(--text-muted); font-size: 11px; margin-bottom: 8px;';
    head.textContent = `${list.length} file${list.length>1?'s':''} in the run folder`;
    container.appendChild(head);

    const table = document.createElement('table');
    table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 11.5px;';
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    for (const f of list) {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid var(--border)';
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      const fileUrl = `/api/run/${folder}/file/${encodeURIComponent(f.name).replace(/%2F/g,'/')}`;
      const isHtml = ext === 'html' || ext === 'htm';
      const isViewable = ['html','htm','js','mjs','css','json','txt','md','svg','png','jpg','jpeg','gif','webp'].includes(ext);
      const playBadge = isHtml ? `<a href="${fileUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:2px 8px;background:rgba(94,234,212,0.18);color:var(--accent);border:1px solid rgba(94,234,212,0.35);border-radius:4px;text-decoration:none;font-size:10.5px;margin-right:6px;">▶ open</a>` : '';
      const viewLink = isViewable ? `<a href="${fileUrl}" target="_blank" rel="noopener" style="color:var(--accent-2);text-decoration:none;">view</a>` : '<span class="muted">(binary)</span>';
      tr.innerHTML = `
        <td style="padding: 6px 8px; font-family: var(--mono); font-size: 11px; color: var(--text);">${escapeHtml(f.name)}</td>
        <td style="padding: 6px 8px; text-align: right; color: var(--text-muted); font-family: var(--mono); font-size: 10.5px;">${fmtBytes(f.size)}</td>
        <td style="padding: 6px 8px; text-align: right; white-space: nowrap;">${playBadge}${viewLink}</td>`;
      tbody.appendChild(tr);
    }
    container.appendChild(table);
  } catch (e) {
    container.innerHTML = `<span style="color:var(--bad)">${e.message}</span>`;
  }
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
  return (n/1024/1024).toFixed(2) + ' MB';
}

async function renderLogInto(folder, container) {
  try {
    const r = await fetch(`/api/run/${folder}/log`);
    const txt = await r.text();
    container.classList.remove('captures-body');
    if (!txt.trim()) {
      container.innerHTML = '<div class="run-panel-empty">run.log is empty for this run</div>';
      return;
    }
    container.textContent = txt;
  } catch (e) {
    container.innerHTML = `<span style="color:var(--bad)">${e.message}</span>`;
  }
}

function buildCaptureBlock(c, idx, folder) {
  const block = document.createElement('details');
  block.dataset.capFile = c.file;
  block.style.background = 'var(--bg-2)';
  block.style.border = '1px solid var(--border)';
  block.style.borderRadius = '5px';
  block.style.padding = '6px 10px';
  block.style.marginBottom = '5px';
  const summary = document.createElement('summary');
  summary.style.cursor = 'pointer';
  summary.style.fontSize = '11px';
  const toolBadge = (c.tool_calls_count > 0)
    ? ` · <span style="color:var(--warn)">${c.tool_calls_count} tool call${c.tool_calls_count > 1 ? 's' : ''}${c.tool_calls_names && c.tool_calls_names.length ? ` (${c.tool_calls_names.slice(0,3).join(', ')})` : ''}</span>`
    : '';
  const outBadge = c.output_chars ? ` · out:${c.output_chars}c` : '';
  const rsBadge = c.reasoning_chars ? ` · reasoning:${c.reasoning_chars}c` : '';
  const cost = c.cost_usd != null ? ` · $${c.cost_usd.toFixed(4)}` : '';
  const cached = c.tokens_cached ? ` (${c.tokens_cached}c)` : '';
  const reasoning = c.tokens_reasoning ? ` (${c.tokens_reasoning}r)` : '';
  summary.innerHTML = `<strong>#${idx + 1}</strong> <span class="muted">${c.path}</span> · ${c.status} · ${c.events_count} events${rsBadge}${outBadge}${toolBadge} · in:${c.tokens_input ?? '-'}${cached} out:${c.tokens_output ?? '-'}${reasoning} · total:${c.tokens_total ?? '-'}${cost} · ${c.elapsed_ms}ms · <code>${c.rewrite_status}</code>`;
  block.appendChild(summary);
  const detailWrap = document.createElement('div');
  detailWrap.style.marginTop = '8px';
  detailWrap.innerHTML = '<em style="color:var(--text-muted);font-size:11px;">Loading…</em>';
  block.addEventListener('toggle', async () => {
    if (!block.open || detailWrap.dataset.loaded === '1') return;
    try {
      const r2 = await fetch(`/api/run/${folder}/capture/${c.file}`);
      const full = await r2.json();
      detailWrap.innerHTML = renderFullCapture(full);
      detailWrap.dataset.loaded = '1';
      for (const det of detailWrap.querySelectorAll('details[data-raw-file]')) {
        det.addEventListener('toggle', async () => {
          if (!det.open || det.dataset.loaded === '1') return;
          const target = det.querySelector('pre');
          if (!target) return;
          target.innerHTML = '<em style="color:var(--text-muted)">loading…</em>';
          try {
            const rr = await fetch(`/api/run/${folder}/capture/${det.dataset.rawFile}/raw`);
            const txt = await rr.text();
            target.textContent = txt || '(empty)';
            det.dataset.loaded = '1';
          } catch (e) {
            target.innerHTML = `<span style="color:var(--bad)">${e.message}</span>`;
          }
        });
      }
    } catch (e) {
      detailWrap.innerHTML = `<span style="color:var(--bad)">${e.message}</span>`;
    }
  });
  block.appendChild(detailWrap);
  return block;
}

async function renderCapturesInto(folder, container) {
  try {
    const r = await fetch(`/api/run/${folder}/captures`);
    const list = await r.json();
    if (!list.length) {
      container.innerHTML = '<div class="run-panel-empty">No proxy captures yet… (live, will refresh as calls land)</div>';
      container.dataset.captureCount = '0';
      return;
    }
    container.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'captures-head';
    head.style.color = 'var(--text-muted)';
    head.style.fontSize = '11px';
    head.style.marginBottom = '8px';
    head.textContent = `${list.length} API calls captured · live`;
    container.appendChild(head);
    for (let i = 0; i < list.length; i++) {
      container.appendChild(buildCaptureBlock(list[i], i, folder));
    }
    container.dataset.captureCount = String(list.length);
  } catch (e) {
    container.innerHTML = `<span style="color:var(--bad)">${e.message}</span>`;
  }
}

// Incremental update: fetch latest captures and append any new ones without
// disturbing already-rendered (and possibly user-opened) blocks.
async function refreshCapturesInto(folder, container) {
  try {
    const r = await fetch(`/api/run/${folder}/captures`);
    const list = await r.json();
    const have = new Set();
    for (const det of container.querySelectorAll('details[data-cap-file]')) {
      have.add(det.dataset.capFile);
    }
    // If first capture just landed (we were showing empty state) — full render
    if (have.size === 0 && list.length > 0) {
      return renderCapturesInto(folder, container);
    }
    // Update head count
    const head = container.querySelector('.captures-head');
    if (head) head.textContent = `${list.length} API calls captured · live`;
    // Append any new captures (preserve indices that match the full list order)
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (have.has(c.file)) continue;
      container.appendChild(buildCaptureBlock(c, i, folder));
    }
  } catch { /* swallow transient errors */ }
}


function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function renderFullCapture(c) {
  const sys = (c.request?.input || []).find((m) => m.role === 'system');
  const user = (c.request?.input || []).filter((m) => m.role === 'user');
  const out = [];

  const rs = c.response_summary || {};
  const u  = rs.usage || {};
  const costUsd = (u.cost_in_usd_ticks != null) ? u.cost_in_usd_ticks / 1e9 : null;
  // ---- metadata grid: model / API / sampling / tokens / cost ----
  const cells = [
    ['model', rs.model],
    ['api_status', rs.status],
    ['http', c.status],
    ['elapsed', `${c.elapsed_ms} ms`],
    ['rewrite', c.rewrite_status],
    ['service_tier', rs.service_tier],
    ['truncation', rs.truncation],
    ['system_fingerprint', rs.system_fingerprint],
    ['background', rs.background],
    ['', null], // spacer
    ['temperature', rs.temperature],
    ['top_p', rs.top_p],
    ['presence_penalty', rs.presence_penalty],
    ['frequency_penalty', rs.frequency_penalty],
    ['top_logprobs', rs.top_logprobs],
    ['max_output_tokens', rs.max_output_tokens],
    ['max_tool_calls', rs.max_tool_calls],
    ['', null],
    ['input_tokens', u.input_tokens],
    ['cached_tokens', u.input_tokens_details?.cached_tokens],
    ['output_tokens', u.output_tokens],
    ['reasoning_tokens', u.output_tokens_details?.reasoning_tokens],
    ['total_tokens', u.total_tokens],
    ['num_sources_used', u.num_sources_used],
    ['num_server_side_tools_used', u.num_server_side_tools_used],
    ['cost_in_usd_ticks', u.cost_in_usd_ticks],
    ['cost (USD)', costUsd != null ? `$${costUsd.toFixed(6)}` : null],
  ];
  const rows = cells.map(([k, v]) => {
    if (!k) return `<div style="grid-column: 1 / -1; height: 4px;"></div>`;
    const dv = v == null || v === '' ? '<span class="muted">-</span>' : `<code>${escapeHtml(String(v))}</code>`;
    return `<span>${escapeHtml(k)}:</span>${dv}`;
  }).join('');
  out.push(`<details open style="margin-bottom: 10px;">
    <summary style="cursor:pointer; color:var(--accent-2); font-size: 11px;">API metadata</summary>
    <div style="display:grid; grid-template-columns: max-content 1fr; gap: 3px 12px; font-size: 11px; color: var(--text-muted); margin-top: 6px;">
      ${rows}
    </div>
  </details>`);
  // Surface errors / incomplete prominently
  if (rs.error) {
    out.push(`<div style="background: rgba(255,123,114,0.1); border:1px solid rgba(255,123,114,0.3); border-radius:5px; padding: 8px 10px; margin-bottom: 8px; color:var(--bad); font-size: 11px;">
      <strong>API error:</strong> <code>${escapeHtml(JSON.stringify(rs.error))}</code>
    </div>`);
  }
  if (rs.incomplete_details) {
    out.push(`<div style="background: rgba(251,191,36,0.1); border:1px solid rgba(251,191,36,0.3); border-radius:5px; padding: 8px 10px; margin-bottom: 8px; color:var(--warn); font-size: 11px;">
      <strong>incomplete:</strong> <code>${escapeHtml(JSON.stringify(rs.incomplete_details))}</code>
    </div>`);
  }
  if (sys) {
    const content = typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content);
    out.push(`<details open style="margin-bottom:8px;"><summary style="cursor:pointer;color:var(--accent);font-size:11px;">SYSTEM message sent to model (${content.length} chars)</summary>
      <pre style="background:#050709;padding:10px;border-radius:5px;margin:6px 0 0;font-size:10.5px;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;">${escapeHtml(content)}</pre>
    </details>`);
  }
  if (user.length) {
    for (let i = 0; i < user.length; i++) {
      const content = typeof user[i].content === 'string' ? user[i].content : JSON.stringify(user[i].content);
      out.push(`<details style="margin-bottom:6px;"><summary style="cursor:pointer;color:var(--accent-2);font-size:11px;">USER message #${i + 1} (${content.length} chars)</summary>
        <pre style="background:#050709;padding:10px;border-radius:5px;margin:6px 0 0;font-size:10.5px;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word;">${escapeHtml(content)}</pre>
      </details>`);
    }
  }
  if (c.response_summary?.reasoning_summary) {
    out.push(`<details style="margin-bottom:6px;"><summary style="cursor:pointer;color:var(--warn);font-size:11px;">Reasoning summary (${c.response_summary.reasoning_summary.length} chars)</summary>
      <pre style="background:#050709;padding:10px;border-radius:5px;margin:6px 0 0;font-size:10.5px;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word;">${escapeHtml(c.response_summary.reasoning_summary)}</pre>
    </details>`);
  }
  if (c.response_summary?.output_text) {
    out.push(`<details style="margin-bottom:6px;"><summary style="cursor:pointer;color:var(--good);font-size:11px;">Assistant output text (${c.response_summary.output_text.length} chars)</summary>
      <pre style="background:#050709;padding:10px;border-radius:5px;margin:6px 0 0;font-size:10.5px;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;">${escapeHtml(c.response_summary.output_text)}</pre>
    </details>`);
  }

  // Tool calls (function calls) — open by default, since this is where agentic output lives
  const toolCalls = c.response_summary?.tool_calls || [];
  if (toolCalls.length) {
    const blocks = toolCalls.map((tc, idx) => {
      const args = tc.arguments || '';
      // Try to pretty-print JSON args if they parse
      let argsRendered = args;
      try {
        const parsed = JSON.parse(args);
        argsRendered = JSON.stringify(parsed, null, 2);
      } catch { /* leave as raw */ }
      return `<details open style="margin: 6px 0 0; background:#050709; border:1px solid var(--border); border-radius:5px;">
        <summary style="cursor:pointer; padding:6px 10px; color:var(--warn); font-size:11px;">
          tool #${idx + 1} · <code style="color:var(--accent);">${escapeHtml(tc.name || '(unknown)')}</code> · ${args.length} chars
        </summary>
        <pre style="margin:0; padding:10px; font-size:10.5px; max-height:320px; overflow:auto; white-space:pre-wrap; word-break:break-word; border-top:1px solid var(--border);">${escapeHtml(argsRendered)}</pre>
      </details>`;
    }).join('');
    out.push(`<details open style="margin-bottom:6px;"><summary style="cursor:pointer;color:var(--warn);font-size:11px;">Tool calls (${toolCalls.length})</summary>
      <div style="padding-left:4px;">${blocks}</div>
    </details>`);
  }

  // Event-type histogram — compact line
  const ev = c.response_summary?.event_types;
  if (ev && Object.keys(ev).length) {
    const evRows = Object.entries(ev)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<span style="color:var(--text-muted);">${escapeHtml(k.replace('response.', ''))}</span>×<span style="color:var(--text);">${v}</span>`)
      .join('  ');
    out.push(`<details style="margin-bottom:6px;"><summary style="cursor:pointer;color:var(--text-muted);font-size:11px;">SSE event types (${c.response_summary.events_count})</summary>
      <div style="padding:8px 10px; font-family:var(--mono); font-size:10.5px; line-height:1.7; background:#050709; border-radius:5px; margin-top:6px;">${evRows}</div>
    </details>`);
  }

  // Raw SSE viewer — lazy-loaded
  if (c.raw_sse_file) {
    const rawId = `raw-${Math.random().toString(36).slice(2, 8)}`;
    out.push(`<details style="margin-bottom:6px;" data-raw-folder="${escapeHtml(c.tag || '')}" data-raw-file="${escapeHtml(c.raw_sse_file)}" data-target="${rawId}"><summary style="cursor:pointer;color:var(--accent-2);font-size:11px;">Raw SSE stream (${c.response_raw_size} bytes) — click to load</summary>
      <pre id="${rawId}" style="background:#050709;padding:10px;border-radius:5px;margin:6px 0 0;font-size:10px;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;"><em style="color:var(--text-muted)">(not loaded)</em></pre>
    </details>`);
  }

  return out.join('');
}

// ----- system-prompt section/rule editor -----
let defaultPromptCache = null;       // { text, length, sections (each with rules) }
const sectionCheckState = new Map(); // section name -> checked
const ruleExcludeState = new Set();  // "sectionName#ruleIdx" -> excluded
const sectionExpandState = new Set();// section names currently expanded

function saveSectionState() {
  try {
    localStorage.setItem('bench.sectionCheck', JSON.stringify(Object.fromEntries(sectionCheckState)));
    localStorage.setItem('bench.ruleExclude', JSON.stringify(Array.from(ruleExcludeState)));
    localStorage.setItem('bench.sectionExpand', JSON.stringify(Array.from(sectionExpandState)));
  } catch {}
}

function restoreSectionState() {
  const validNames = new Set((defaultPromptCache?.sections || []).map(s => s.name));
  try {
    const c = JSON.parse(localStorage.getItem('bench.sectionCheck') || '{}');
    for (const [k, v] of Object.entries(c)) if (validNames.has(k)) sectionCheckState.set(k, !!v);
  } catch {}
  try {
    const e = JSON.parse(localStorage.getItem('bench.ruleExclude') || '[]');
    if (Array.isArray(e)) for (const id of e) if (validNames.has(String(id).split('#')[0])) ruleExcludeState.add(id);
  } catch {}
  try {
    const x = JSON.parse(localStorage.getItem('bench.sectionExpand') || '[]');
    if (Array.isArray(x)) for (const n of x) if (validNames.has(n)) sectionExpandState.add(n);
  } catch {}
}

async function loadDefaultPrompt() {
  const r = await fetch('/api/grok-default-prompt');
  if (!r.ok) {
    alert('No default prompt captured yet. Run one passthrough call (custom prompt off, proxy on) so the proxy can capture grok\'s 12K default, then try again.');
    return;
  }
  defaultPromptCache = await r.json();
  restoreSectionState();
  for (const s of defaultPromptCache.sections) {
    if (!sectionCheckState.has(s.name)) sectionCheckState.set(s.name, true);
  }
  saveSectionState();
  $('custom-prompt').value = defaultPromptCache.text;
  saveState();
  renderSections();
  $('sections-panel').style.display = 'block';
}

function renderSections() {
  const list = $('sections-list');
  list.innerHTML = '';
  if (!defaultPromptCache) {
    list.innerHTML = '<div class="hint">Click "Load grok\'s default…" first.</div>';
    return;
  }
  const head = document.createElement('div');
  head.style.cssText = 'margin-bottom: 8px; font-size: 11px; color: var(--text-muted);';
  head.textContent = `${defaultPromptCache.sections.length} sections · total ${defaultPromptCache.length} chars · click ▸ to expand and toggle individual rules`;
  list.appendChild(head);

  for (const s of defaultPromptCache.sections) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'border-bottom: 1px solid var(--border);';

    // Section header row
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 6px 4px; font-size: 11.5px;';

    const expander = document.createElement('span');
    expander.style.cssText = 'cursor: pointer; width: 14px; user-select: none; color: var(--text-muted); font-size: 10px;';
    const expanded = sectionExpandState.has(s.name);
    expander.textContent = expanded ? '▾' : '▸';
    expander.title = expanded ? 'collapse rules' : 'expand to toggle individual rules';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = sectionCheckState.get(s.name) !== false;
    cb.addEventListener('change', () => {
      sectionCheckState.set(s.name, cb.checked);
      saveSectionState();
    });

    const meta = document.createElement('div');
    meta.style.cssText = 'flex: 1; min-width: 0;';
    const ruleCount = s.rules.length;
    const excludedInSection = s.rules.filter(r => ruleExcludeState.has(`${s.name}#${r.idx}`)).length;
    const ruleSummary = excludedInSection > 0 ? ` <span style="color:var(--warn)">(${ruleCount - excludedInSection}/${ruleCount} rules)</span>` : ` <span class="muted">(${ruleCount} rules)</span>`;
    meta.innerHTML = `<div><code style="color: var(--accent);">${escapeHtml(s.name)}</code> <span class="muted">${s.kind} · ${s.length}c</span>${ruleSummary}</div>
      <div style="color: var(--text-muted); font-size: 10.5px; margin-top: 2px;">${escapeHtml(s.preview)}…</div>`;

    expander.addEventListener('click', () => {
      if (sectionExpandState.has(s.name)) sectionExpandState.delete(s.name);
      else sectionExpandState.add(s.name);
      saveSectionState();
      renderSections();
    });
    meta.addEventListener('click', (ev) => {
      // Click on text also toggles expansion (not the checkbox area)
      if (ev.target.closest('input')) return;
      if (sectionExpandState.has(s.name)) sectionExpandState.delete(s.name);
      else sectionExpandState.add(s.name);
      saveSectionState();
      renderSections();
    });

    row.appendChild(expander);
    row.appendChild(cb);
    row.appendChild(meta);
    wrap.appendChild(row);

    // Expanded rule list
    if (expanded) {
      const rulesBox = document.createElement('div');
      rulesBox.style.cssText = 'margin-left: 28px; padding: 4px 0 8px;';
      for (const r of s.rules) {
        const rid = `${s.name}#${r.idx}`;
        const rrow = document.createElement('label');
        rrow.style.cssText = 'display: flex; align-items: flex-start; gap: 6px; padding: 4px 6px; cursor: pointer; border-radius: 4px;';
        rrow.addEventListener('mouseover', () => rrow.style.background = 'var(--bg-3)');
        rrow.addEventListener('mouseout', () => rrow.style.background = '');
        const rcb = document.createElement('input');
        rcb.type = 'checkbox';
        rcb.checked = !ruleExcludeState.has(rid);
        rcb.style.marginTop = '2px';
        rcb.addEventListener('change', () => {
          if (rcb.checked) ruleExcludeState.delete(rid);
          else ruleExcludeState.add(rid);
          saveSectionState();
          // Update the section header summary without full rerender
          renderSections();
        });
        const rmeta = document.createElement('div');
        rmeta.style.cssText = 'flex: 1; min-width: 0; font-size: 11px; line-height: 1.45;';
        rmeta.innerHTML = `<span style="color: var(--text-muted); font-family: var(--mono); font-size: 10px;">${rid}</span> <span style="color: var(--text);">${escapeHtml(r.preview)}${r.length > r.preview.length ? '…' : ''}</span>`;
        rrow.appendChild(rcb);
        rrow.appendChild(rmeta);
        rulesBox.appendChild(rrow);
      }
      wrap.appendChild(rulesBox);
    }

    list.appendChild(wrap);
  }
}

async function applySections() {
  if (!defaultPromptCache) return;
  const sections = [];
  for (const s of defaultPromptCache.sections) {
    if (sectionCheckState.get(s.name) !== false) sections.push(s.name);
  }
  const excludeRules = Array.from(ruleExcludeState);
  const r = await fetch('/api/grok-default-prompt/assemble', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ include: { sections, excludeRules } }),
  });
  const d = await r.json();
  $('custom-prompt').value = d.text;
  // Auto-activate: without this, the trim sits in the textarea but
  // never reaches the proxy. Tick the checkbox + save so the file
  // lands on disk for the next run.
  const activeCb = $('custom-prompt-active');
  const wasAlreadyActive = activeCb.checked;
  activeCb.checked = true;
  await saveState();
  const totalRules = defaultPromptCache.sections.reduce((acc, s) => acc + s.rules.length, 0);
  const activeMsg = wasAlreadyActive
    ? '(custom prompt was already active)'
    : '✓ "Use custom system prompt" now ON';
  alert(`Applied: ${sections.length}/${defaultPromptCache.sections.length} sections, ${excludeRules.length}/${totalRules} rules excluded → ${d.length} chars\n${activeMsg}`);
}

$('load-default-btn').onclick = loadDefaultPrompt;
$('show-sections-btn').onclick = async () => {
  if (!defaultPromptCache) {
    await loadDefaultPrompt();
  } else {
    const panel = $('sections-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }
};
$('sections-apply-btn').onclick = applySections;
$('sections-all-btn').onclick = () => {
  if (!defaultPromptCache) return;
  for (const s of defaultPromptCache.sections) sectionCheckState.set(s.name, true);
  saveSectionState();
  renderSections();
};
$('sections-none-btn').onclick = () => {
  if (!defaultPromptCache) return;
  for (const s of defaultPromptCache.sections) sectionCheckState.set(s.name, false);
  saveSectionState();
  renderSections();
};

$('run-btn').onclick = startRun;
$('save-btn').onclick = saveState;

// "Use Grok's defaults" — reset all generation/proxy knobs to grok's stock behavior.
async function useGrokDefaults() {
  if (!confirm('Reset all settings to grok defaults? (t=0.6, max_tokens unset, turns=60, effort off, proxy + strip off)')) return;
  $('temperature').value = '0.6';
  $('max-tokens').value = 'default';
  $('max-turns').value = '60';
  $('effort').value = 'off';
  $('use-proxy').checked = false;
  $('strip-reminders').checked = false;
  await saveState();
}

// "Use Grok's default prompt" — clear the custom prompt + turn off the proxy override
// so grok's built-in 12K system prompt is used unchanged.
async function useGrokDefaultPrompt() {
  if (!confirm('Disable the custom system prompt? (grok will use its built-in 12K default)')) return;
  $('custom-prompt-active').checked = false;
  $('custom-prompt').value = '';
  // Wipe any uncheck-state in localStorage so the sections editor starts clean next time
  try {
    localStorage.removeItem('bench.sectionCheck');
    localStorage.removeItem('bench.ruleExclude');
    localStorage.removeItem('bench.sectionExpand');
  } catch {}
  // Drop the cached default and the section editor's UI state
  defaultPromptCache = null;
  sectionCheckState.clear();
  ruleExcludeState.clear();
  sectionExpandState.clear();
  $('sections-panel').style.display = 'none';
  await saveState();
}

const resetBtn = $('reset-settings-btn'); if (resetBtn) resetBtn.onclick = useGrokDefaults;
const defaultPromptBtn = $('use-default-prompt-btn'); if (defaultPromptBtn) defaultPromptBtn.onclick = useGrokDefaultPrompt;

// ---------- Grok user-config editor (Config view) ----------

// --- Minimal line-based TOML edit helpers ---
// These intentionally operate on text (not an AST) so the user's formatting,
// comments, and key ordering are preserved. Sufficient for grok's flat configs.

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Find the index range [start, end) of a section's body in `lines`.
// Returns null if the section is missing.
function findSectionRange(lines, name) {
  const head = new RegExp(`^\\s*\\[${escRe(name)}\\]\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (head.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  return [start, end];
}

// Get the raw RHS text of a key in a section, or null.
function tomlGet(text, section, key) {
  const lines = text.split('\n');
  const range = findSectionRange(lines, section);
  if (!range) return null;
  const re = new RegExp(`^\\s*${escRe(key)}\\s*=\\s*(.+?)\\s*$`);
  for (let i = range[0]; i < range[1]; i++) {
    const m = lines[i].match(re);
    if (m) return m[1];
  }
  return null;
}
function tomlGetBool(text, section, key) {
  const v = tomlGet(text, section, key);
  if (v == null) return undefined;
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return undefined;
}
function tomlGetString(text, section, key) {
  const v = tomlGet(text, section, key);
  if (v == null) return undefined;
  const m = v.match(/^"(.*)"$/) || v.match(/^'(.*)'$/);
  return m ? m[1] : v;
}

// Insert/overwrite a key=value in a section. Creates the section if needed.
// `rhs` is the raw right-hand-side text (already quoted/formatted).
function tomlSet(text, section, key, rhs) {
  let lines = text.split('\n');
  let range = findSectionRange(lines, section);
  const keyRe = new RegExp(`^\\s*${escRe(key)}\\s*=`);
  if (!range) {
    // Append a fresh section at the end with a leading blank line if needed
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`[${section}]`, `${key} = ${rhs}`);
    return lines.join('\n');
  }
  // Look for existing key inside the section
  for (let i = range[0]; i < range[1]; i++) {
    if (keyRe.test(lines[i])) {
      lines[i] = `${key} = ${rhs}`;
      return lines.join('\n');
    }
  }
  // Insert before end of section, trim trailing blank lines that belong to the section
  let insertAt = range[1];
  while (insertAt > range[0] && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, `${key} = ${rhs}`);
  return lines.join('\n');
}

// Remove a key. If the section becomes empty, remove the header too.
function tomlRemove(text, section, key) {
  let lines = text.split('\n');
  const range = findSectionRange(lines, section);
  if (!range) return text;
  const keyRe = new RegExp(`^\\s*${escRe(key)}\\s*=`);
  let removedAt = -1;
  for (let i = range[0]; i < range[1]; i++) {
    if (keyRe.test(lines[i])) { removedAt = i; break; }
  }
  if (removedAt === -1) return text;
  lines.splice(removedAt, 1);
  // Re-resolve range and check if section is now empty
  const range2 = findSectionRange(lines, section);
  if (range2) {
    let hasContent = false;
    for (let i = range2[0]; i < range2[1]; i++) {
      if (/\S/.test(lines[i]) && !/^\s*#/.test(lines[i])) { hasContent = true; break; }
    }
    if (!hasContent) {
      // Remove the section header + trailing blank line
      const headerIdx = range2[0] - 1;
      lines.splice(headerIdx, range2[1] - headerIdx);
      // Drop one trailing blank line for cleanliness
      if (lines[headerIdx] !== undefined && lines[headerIdx].trim() === '') {
        lines.splice(headerIdx, 1);
      }
    }
  }
  // Collapse runs of blank lines to at most one
  const collapsed = [];
  let prevBlank = false;
  for (const l of lines) {
    const blank = l.trim() === '';
    if (blank && prevBlank) continue;
    collapsed.push(l);
    prevBlank = blank;
  }
  // Trim leading/trailing blank lines
  while (collapsed.length && collapsed[0].trim() === '') collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1].trim() === '') collapsed.pop();
  return collapsed.join('\n') + (collapsed.length ? '\n' : '');
}

// --- Control definitions ---
// Each control reads from current textarea text, applies edits via tomlSet/Remove.
const PROXY_BASE_URL = 'http://127.0.0.1:18180/v1';

const GC_CONTROLS = [
  {
    kind: 'bool',
    label: 'Route grok-build through bench proxy',
    sub: '<code>[model.grok-build]</code> base_url = "' + PROXY_BASE_URL + '"',
    get: (t) => tomlGetString(t, 'model.grok-build', 'base_url') === PROXY_BASE_URL,
    set: (t, on) => on
      ? tomlSet(t, 'model.grok-build', 'base_url', `"${PROXY_BASE_URL}"`)
      : tomlRemove(t, 'model.grok-build', 'base_url'),
  },
  {
    kind: 'bool',
    label: 'Disable Mixpanel telemetry',
    sub: '<code>[telemetry]</code> mixpanel_enabled = false',
    get: (t) => tomlGetBool(t, 'telemetry', 'mixpanel_enabled') === false,
    set: (t, on) => on
      ? tomlSet(t, 'telemetry', 'mixpanel_enabled', 'false')
      : tomlRemove(t, 'telemetry', 'mixpanel_enabled'),
  },
  {
    kind: 'bool',
    label: 'Disable trace uploads',
    sub: '<code>[telemetry]</code> trace_upload = false',
    get: (t) => tomlGetBool(t, 'telemetry', 'trace_upload') === false,
    set: (t, on) => on
      ? tomlSet(t, 'telemetry', 'trace_upload', 'false')
      : tomlRemove(t, 'telemetry', 'trace_upload'),
  },
  {
    kind: 'bool',
    label: 'Always-approve permissions',
    sub: '<code>[ui]</code> permission_mode = "always-approve"',
    get: (t) => tomlGetString(t, 'ui', 'permission_mode') === 'always-approve',
    set: (t, on) => on
      ? tomlSet(t, 'ui', 'permission_mode', '"always-approve"')
      : tomlRemove(t, 'ui', 'permission_mode'),
  },
  {
    kind: 'bool',
    label: 'YOLO mode (skip safety prompts)',
    sub: '<code>[ui]</code> yolo = true',
    get: (t) => tomlGetBool(t, 'ui', 'yolo') === true,
    set: (t, on) => on
      ? tomlSet(t, 'ui', 'yolo', 'true')
      : tomlRemove(t, 'ui', 'yolo'),
  },
  {
    kind: 'bool',
    label: 'Subagents enabled',
    sub: '<code>[subagents]</code> enabled = true',
    get: (t) => tomlGetBool(t, 'subagents', 'enabled') === true,
    set: (t, on) => on
      ? tomlSet(t, 'subagents', 'enabled', 'true')
      : tomlRemove(t, 'subagents', 'enabled'),
  },
  {
    kind: 'bool',
    label: 'Codebase indexing',
    sub: '<code>[features]</code> codebase_indexing = true',
    get: (t) => tomlGetBool(t, 'features', 'codebase_indexing') === true,
    set: (t, on) => on
      ? tomlSet(t, 'features', 'codebase_indexing', 'true')
      : tomlRemove(t, 'features', 'codebase_indexing'),
  },
  {
    kind: 'number',
    label: 'grok-build temperature',
    sub: '<code>[model.grok-build]</code> temperature',
    placeholder: 'leave blank to unset',
    step: '0.1', min: '0', max: '2',
    get: (t) => {
      const v = tomlGet(t, 'model.grok-build', 'temperature');
      return v == null ? '' : v;
    },
    set: (t, v) => v === '' || v == null
      ? tomlRemove(t, 'model.grok-build', 'temperature')
      : tomlSet(t, 'model.grok-build', 'temperature', String(parseFloat(v))),
  },
  {
    kind: 'number',
    label: 'grok-build top_p',
    sub: '<code>[model.grok-build]</code> top_p',
    placeholder: 'leave blank to unset',
    step: '0.01', min: '0', max: '1',
    get: (t) => {
      const v = tomlGet(t, 'model.grok-build', 'top_p');
      return v == null ? '' : v;
    },
    set: (t, v) => v === '' || v == null
      ? tomlRemove(t, 'model.grok-build', 'top_p')
      : tomlSet(t, 'model.grok-build', 'top_p', String(parseFloat(v))),
  },
];

let gcState = { baseline: '', current: '', backups: [], path: '' };
let gcSelectedBackup = null;

async function gcLoad() {
  const r = await fetch('/api/grok-config');
  const d = await r.json();
  gcState = {
    baseline: (d.baseline && d.baseline.text) || '',
    current: d.text || '',
    backups: d.backups || [],
    path: d.path || '',
  };
  $('gc-path').textContent = d.path || '';
  $('gc-textarea').value = d.text || '';
  $('gc-inspect').hidden = true;
  gcRenderControls();
  gcRenderDiff();
  gcRenderHistory();
}

// Re-derive control values from the textarea's current content, render the controls.
function gcRenderControls() {
  const host = $('gc-controls');
  if (!host) return;
  const text = $('gc-textarea').value;
  host.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'gc-controls-head';
  head.innerHTML = '<strong>Quick toggles</strong><span class="hint" style="margin-left: 8px;">edits the TOML on the fly — your formatting + comments are preserved</span>';
  host.appendChild(head);
  const grid = document.createElement('div');
  grid.className = 'gc-controls-grid';
  host.appendChild(grid);

  for (const ctrl of GC_CONTROLS) {
    const row = document.createElement('div');
    row.className = 'gc-ctrl';
    if (ctrl.kind === 'bool') {
      const checked = !!ctrl.get(text);
      row.innerHTML = `
        <label class="gc-ctrl-row">
          <input type="checkbox" ${checked ? 'checked' : ''} />
          <div class="gc-ctrl-body">
            <div class="gc-ctrl-label">${escapeHtml(ctrl.label)}</div>
            <div class="gc-ctrl-sub muted">${ctrl.sub}</div>
          </div>
        </label>`;
      row.querySelector('input').addEventListener('change', (ev) => {
        const newText = ctrl.set($('gc-textarea').value, ev.target.checked);
        $('gc-textarea').value = newText;
        // Re-render so other controls reflect any cascading changes
        gcRenderControls();
      });
    } else if (ctrl.kind === 'number') {
      const val = ctrl.get(text);
      row.innerHTML = `
        <div class="gc-ctrl-row">
          <input type="number" value="${escapeHtml(String(val ?? ''))}" placeholder="${escapeHtml(ctrl.placeholder || '')}" step="${ctrl.step || 'any'}" ${ctrl.min!=null?`min="${ctrl.min}"`:''} ${ctrl.max!=null?`max="${ctrl.max}"`:''} />
          <div class="gc-ctrl-body">
            <div class="gc-ctrl-label">${escapeHtml(ctrl.label)}</div>
            <div class="gc-ctrl-sub muted">${ctrl.sub}</div>
          </div>
        </div>`;
      const inp = row.querySelector('input');
      // Update on blur and Enter (not every keystroke — avoids cursor jumping)
      const commit = () => {
        const newText = ctrl.set($('gc-textarea').value, inp.value);
        $('gc-textarea').value = newText;
        gcRenderControls();
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); commit(); }});
    }
    grid.appendChild(row);
  }
}

function gcFlash(msg, bad = false) {
  const el = $('gc-flash');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

async function gcSave() {
  const text = $('gc-textarea').value;
  const r = await fetch('/api/grok-config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const d = await r.json();
  if (d.ok) {
    gcFlash(`saved ${d.length} chars`);
    gcLoad();
  } else {
    gcFlash(d.error || 'save failed', true);
  }
}

async function gcValidate() {
  const out = $('gc-inspect');
  out.textContent = 'running grok inspect...';
  out.hidden = false;
  try {
    const r = await fetch('/api/grok-inspect');
    const d = await r.json();
    out.textContent = (d.stdout || '') + (d.stderr ? '\n--- stderr ---\n' + d.stderr : '');
    if (d.ok) gcFlash('config valid');
    else gcFlash('grok inspect returned non-zero', true);
  } catch (e) {
    out.textContent = String(e);
    gcFlash('inspect failed', true);
  }
}

async function gcRestoreBaseline() {
  if (!gcState.baseline) { gcFlash('no baseline yet', true); return; }
  if (!confirm('Reset to the baseline (the config when you first opened this editor)? Current is backed up first.')) return;
  const r = await fetch('/api/grok-config/restore/config.toml.baseline', { method: 'POST' });
  const d = await r.json();
  if (d.ok) { gcFlash('reset to baseline'); gcLoad(); }
  else { gcFlash(d.error || 'reset failed', true); }
}

function gcAppendSnippet(key) {
  const snip = GC_SNIPPETS[key];
  if (!snip) return;
  const ta = $('gc-textarea');
  const v = ta.value;
  const sep = (v.length && !v.endsWith('\n\n')) ? (v.endsWith('\n') ? '\n' : '\n\n') : '';
  ta.value = v + sep + snip;
  ta.focus();
  ta.scrollTop = ta.scrollHeight;
}

// Tabs in the config view
function gcSetMode(mode) {
  for (const t of document.querySelectorAll('.gc-tab')) {
    t.classList.toggle('active', t.dataset.mode === mode);
  }
  for (const m of document.querySelectorAll('.gc-mode')) {
    m.hidden = m.dataset.mode !== mode;
  }
  if (mode === 'diff') gcRenderDiff();
  if (mode === 'history') gcRenderHistory();
}

// Simple line-by-line diff (LCS-based, sufficient for small config files).
function lineDiff(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length, m = B.length;
  // Build LCS length table
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = (A[i] === B[j]) ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j])             { out.push({ t: '=', text: A[i] }); i++; j++; }
    else if (dp[i+1][j] >= dp[i][j+1]) { out.push({ t: '-', text: A[i] }); i++; }
    else                            { out.push({ t: '+', text: B[j] }); j++; }
  }
  while (i < n) { out.push({ t: '-', text: A[i++] }); }
  while (j < m) { out.push({ t: '+', text: B[j++] }); }
  return out;
}

function gcRenderDiff() {
  const el = $('gc-diff');
  if (!el) return;
  if (!gcState.baseline && !gcState.current) {
    el.innerHTML = '<span class="diff-empty">no content to compare</span>';
    return;
  }
  if (gcState.baseline === gcState.current) {
    el.innerHTML = '<span class="diff-empty">no changes since baseline ✓</span>';
    return;
  }
  const parts = lineDiff(gcState.baseline, gcState.current);
  el.innerHTML = parts.map(p => {
    const cls = p.t === '+' ? 'diff-add' : p.t === '-' ? 'diff-del' : 'diff-eq';
    const prefix = p.t === '=' ? '  ' : (p.t + ' ');
    return `<span class="${cls}">${escapeHtml(prefix + p.text)}</span>`;
  }).join('');
}

async function gcRenderHistory() {
  const listEl = $('gc-history-list');
  if (!listEl) return;
  // Entries: baseline (top) + all timestamped backups
  const entries = [];
  if (gcState.baseline) {
    entries.push({ name: 'config.toml.baseline', label: 'baseline (original)', isBaseline: true });
  }
  for (const b of gcState.backups) {
    entries.push({ name: b, label: b.replace(/^config\.toml\.bak\./, ''), isBaseline: false });
  }
  if (!entries.length) {
    listEl.innerHTML = '<div class="diff-empty">no backups yet — they appear after your first Save</div>';
    $('gc-history-selected').textContent = '(no backups)';
    $('gc-restore').disabled = true;
    $('gc-history-diff').innerHTML = '';
    return;
  }
  listEl.innerHTML = '';
  for (const e of entries) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.name = e.name;
    b.innerHTML = e.isBaseline
      ? `<span class="baseline-label">★ ${escapeHtml(e.label)}</span>`
      : escapeHtml(e.label);
    if (e.name === gcSelectedBackup) b.classList.add('active');
    b.addEventListener('click', () => gcSelectBackup(e.name));
    listEl.appendChild(b);
  }
  // Auto-select first entry if none selected
  if (!gcSelectedBackup) gcSelectBackup(entries[0].name);
}

async function gcSelectBackup(name) {
  gcSelectedBackup = name;
  for (const b of document.querySelectorAll('#gc-history-list button')) {
    b.classList.toggle('active', b.dataset.name === name);
  }
  $('gc-history-selected').textContent = name;
  $('gc-restore').disabled = false;
  try {
    const r = await fetch(`/api/grok-config/backup/${encodeURIComponent(name)}`);
    const d = await r.json();
    if (d.text != null) {
      // Diff this backup vs current on-disk
      const parts = lineDiff(d.text, gcState.current);
      const el = $('gc-history-diff');
      if (d.text === gcState.current) {
        el.innerHTML = '<span class="diff-empty">identical to current ✓</span>';
      } else {
        el.innerHTML = parts.map(p => {
          const cls = p.t === '+' ? 'diff-add' : p.t === '-' ? 'diff-del' : 'diff-eq';
          const prefix = p.t === '=' ? '  ' : (p.t + ' ');
          return `<span class="${cls}">${escapeHtml(prefix + p.text)}</span>`;
        }).join('');
      }
    } else {
      $('gc-history-diff').textContent = d.error || '(failed to load)';
    }
  } catch (e) {
    $('gc-history-diff').textContent = String(e);
  }
}

async function gcRestoreSelected() {
  if (!gcSelectedBackup) return;
  if (!confirm(`Restore ${gcSelectedBackup} over the current config? (current is backed up first)`)) return;
  const r = await fetch(`/api/grok-config/restore/${encodeURIComponent(gcSelectedBackup)}`, { method: 'POST' });
  const d = await r.json();
  if (d.ok) { gcFlash(`restored from ${d.restored_from}`); gcLoad(); }
  else { gcFlash(d.error || 'restore failed', true); }
}

// Wire up
$('gc-save').onclick = gcSave;
$('gc-reload').onclick = gcLoad;
$('gc-validate').onclick = gcValidate;
$('gc-reset-baseline').onclick = gcRestoreBaseline;
$('gc-restore').onclick = gcRestoreSelected;
for (const t of document.querySelectorAll('.gc-tab')) {
  t.addEventListener('click', () => gcSetMode(t.dataset.mode));
}
// Manual edits to the TOML should refresh the controls so they reflect what's there.
// Debounce a tiny bit so typing doesn't thrash on every keystroke.
{
  let debounceId;
  $('gc-textarea').addEventListener('input', () => {
    clearTimeout(debounceId);
    debounceId = setTimeout(() => gcRenderControls(), 200);
  });
}
['user-prompt', 'custom-prompt', 'custom-prompt-active', 'temperature', 'max-tokens', 'max-turns', 'effort', 'use-proxy', 'strip-reminders'].forEach((id) => {
  $(id).addEventListener('change', saveState);
});

// ----- nav: view switching -----
function setView(name) {
  if (!['runs', 'prompt', 'config'].includes(name)) name = 'runs';
  for (const v of document.querySelectorAll('.view')) {
    v.hidden = !v.classList.contains('view-' + name);
  }
  for (const b of document.querySelectorAll('.nav-btn')) {
    b.classList.toggle('active', b.dataset.view === name);
  }
  try { localStorage.setItem('bench.view', name); } catch {}
  // Auto-load the config when switching to it
  if (name === 'config' && typeof gcLoad === 'function') gcLoad();
}
(function initNav() {
  for (const b of document.querySelectorAll('.nav-btn')) {
    b.addEventListener('click', () => setView(b.dataset.view));
  }
  const saved = (() => { try { return localStorage.getItem('bench.view'); } catch { return null; } })();
  setView(saved || 'runs');
})();

(async () => {
  $('runs').addEventListener('click', onRunsClick);
  await loadState();
  await loadRuns();
  setInterval(loadRuns, 3000);
  setInterval(async () => {
    const r = await fetch('/api/proxy/status');
    const d = await r.json();
    $('proxy-dot').classList.toggle('on', d.alive);
    $('proxy-state').textContent = d.alive ? 'alive' : 'offline';
  }, 5000);
})();
