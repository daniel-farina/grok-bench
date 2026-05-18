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
      <th></th><th title="star this run"></th><th>Tag</th><th>T</th><th>mt</th><th>Lines</th><th>Calls</th><th title="sum input tokens">In</th><th title="sum cached input tokens">Cache</th><th title="sum output tokens">Out</th><th title="sum reasoning tokens">Reas</th><th title="sum total tokens">Total</th><th title="sum cost (USD)">$</th><th>Status</th><th>When</th><th></th>
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
  const fp = JSON.stringify([
    r._status, r.exit_code, r.has_index,
    r.index_lines, r.api_calls, r.estimated_billed_tokens,
    r._mtime, r.prompt_variant, r.system_prompt,
    r.temperature, r.max_completion_tokens, r.max_turns,
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
  const tagCell = `
    <div class="tag-stack">
      <div>
        <code title="${escapeHtml(r.system_prompt || 'default')} · t=${r.temperature} · max=${r.max_completion_tokens}">${escapeHtml(r.tag || r._folder)}</code>
        <button class="reveal-btn" data-action="reveal" data-tag="${r._folder}" title="open this folder in Finder">📂</button>
      </div>
      <div class="tag-path" title="${escapeHtml(fullPath)}">${escapeHtml(fullPath)}</div>
    </div>`;
  tr.innerHTML = `
    <td><span class="chev">&#x25B8;</span></td>
    <td>${starBtn}</td>
    <td>${tagCell}</td>
    <td>${r.temperature ?? '-'}</td>
    <td>${r.max_turns ?? '-'}</td>
    <td>${fmtNum(r.index_lines || 0)}</td>
    <td>${fmtNum(r.api_calls || 0)}</td>
    <td>${fmtNum(r.input_tokens || 0)}</td>
    <td class="muted">${fmtNum(r.cached_tokens || 0)}</td>
    <td>${fmtNum(r.output_tokens || 0)}</td>
    <td class="muted">${fmtNum(r.reasoning_tokens || 0)}</td>
    <td>${fmtNum(r.total_tokens || 0)}</td>
    <td>${costUsd != null ? '$' + costUsd.toFixed(4) : '-'}</td>
    <td class="${statusClass}">${status}</td>
    <td class="muted">${fmtAgo(r._mtime)}</td>
    <td><div class="row-actions">
      <button class="btn secondary" data-action="log" data-tag="${r._folder}">log</button>
      <button class="btn secondary" data-action="captures" data-tag="${r._folder}">caps</button>
      ${play}
    </div></td>`;
}

// Delegated click handler — attached once, never torn down
function onRunsClick(ev) {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  ev.stopPropagation();
  const tag = btn.dataset.tag;
  const action = btn.dataset.action;
  // Star button has its own behavior — not log/captures
  if (action === 'star') {
    toggleStar(tag);
    return;
  }
  if (action === 'reveal') {
    fetch(`/api/run/${tag}/reveal`, { method: 'POST' }).catch(() => {});
    return;
  }
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
}

function collapsePanel(tag) {
  clearPanelPoller(tag);
  const exp = findExpandedTr(tag);
  if (exp) exp.remove();
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
    td.colSpan = 16;
    const panel = document.createElement('div');
    panel.className = 'run-panel';
    panel.innerHTML = `
      <div class="run-panel-tabs">
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
['user-prompt', 'custom-prompt', 'custom-prompt-active', 'temperature', 'max-tokens', 'max-turns', 'effort', 'use-proxy', 'strip-reminders'].forEach((id) => {
  $(id).addEventListener('change', saveState);
});

// ----- resizable sidebar -----
(function initResizer() {
  const root = document.documentElement;
  // Restore saved width
  const saved = parseInt(localStorage.getItem('bench.sidebar_w') || '', 10);
  if (Number.isFinite(saved) && saved > 240 && saved < 1400) {
    root.style.setProperty('--sidebar-w', saved + 'px');
  }
  const resizer = document.getElementById('resizer');
  if (!resizer) return;
  let dragging = false;
  let startX = 0;
  let startW = 0;
  function curW() {
    const v = getComputedStyle(root).getPropertyValue('--sidebar-w').trim();
    return parseFloat(v) || 760;
  }
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = curW();
    resizer.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.max(280, Math.min(1400, startW + (e.clientX - startX)));
    root.style.setProperty('--sidebar-w', w + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    localStorage.setItem('bench.sidebar_w', String(Math.round(curW())));
  });
  // Double-click to reset to default 760
  resizer.addEventListener('dblclick', () => {
    root.style.setProperty('--sidebar-w', '760px');
    localStorage.setItem('bench.sidebar_w', '760');
  });
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
