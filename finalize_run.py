#!/usr/bin/env python3
"""Finalize a bench run: read its session, compute metrics, refresh dashboard."""
import json, pathlib, sys, os
from urllib.parse import quote

if len(sys.argv) < 3:
    sys.exit('usage: finalize_run.py <workdir> <exit_code>')

workdir = pathlib.Path(sys.argv[1]).resolve()
exit_code = int(sys.argv[2])

m_path = workdir / 'metrics.json'
m = json.loads(m_path.read_text()) if m_path.exists() else {}

# Locate session under isolated GROK_HOME. bench-server sets GROK_HOME to
# <BENCH_ROOT>/grokhome before spawning grok, so sessions land here.
bench_root = pathlib.Path(os.environ.get('BENCH_ROOT', pathlib.Path(__file__).resolve().parent))
sess_root = bench_root / 'grokhome' / 'sessions'
# Grok url-encodes the cwd as the session-bucket directory name
candidate_dir = sess_root / quote(str(workdir), safe='')
sess_path = None
if candidate_dir.exists():
    sids = [d for d in candidate_dir.iterdir() if d.is_dir()]
    if sids:
        sess_path = sorted(sids, key=lambda p: p.stat().st_mtime)[-1]

# Locate game file
game_file = workdir / 'index.html'
if not game_file.exists():
    htmls = list(workdir.rglob('*.html'))
    game_file = htmls[0] if htmls else None

idx_lines = 0
idx_bytes = 0
if game_file and game_file.exists():
    idx_lines = sum(1 for _ in game_file.open())
    idx_bytes = game_file.stat().st_size

m.update({
    'exit_code': exit_code,
    'index_lines': idx_lines,
    'index_bytes': idx_bytes,
    'has_index': idx_lines > 0,
    '_status': 'done',
    'finished_at': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
})
if '_started_at' in m:
    pass  # leave alone
if 'started_at' in m:
    from datetime import datetime
    try:
        t0 = datetime.fromisoformat(m['started_at'].replace('Z', '+00:00'))
        m['elapsed_seconds'] = int((datetime.now(t0.tzinfo) - t0).total_seconds())
    except: pass

if sess_path:
    m['session_path'] = str(sess_path)
    ev = sess_path / 'events.jsonl'
    counts = {'turn_started':0,'turn_ended':0,'turn_error':0,'tool_started':0,'tool_completed':0,'first_token':0,'permission_requested':0}
    tools = {}
    if ev.exists():
        for line in ev.open():
            try: e = json.loads(line)
            except: continue
            t = e.get('type','')
            if t in counts: counts[t] += 1
            if t == 'turn_ended' and e.get('outcome') == 'error': counts['turn_error'] += 1
            if t == 'tool_started':
                n = e.get('tool') or e.get('tool_name') or e.get('name') or '?'
                tools[n] = tools.get(n,0) + 1
    m.update(counts)
    m['tools_used'] = tools
    upd = sess_path / 'updates.jsonl'
    per_stream = {}
    if upd.exists():
        for line in upd.open():
            try: u = json.loads(line)
            except: continue
            meta = (u.get('params') or {}).get('_meta') or {}
            tt = meta.get('totalTokens')
            sm = meta.get('streamStartMs')
            if isinstance(tt,(int,float)) and isinstance(sm,(int,float)):
                if tt > per_stream.get(sm, 0): per_stream[sm] = tt
    m['api_calls'] = len(per_stream)
    m['peak_total_tokens'] = max(per_stream.values()) if per_stream else 0
    m['estimated_billed_tokens'] = sum(per_stream.values())

m_path.write_text(json.dumps(m, indent=2))

# Refresh the legacy static dashboard if build_index.py is present alongside us
build_index = pathlib.Path(__file__).resolve().parent / 'build_index.py'
if build_index.exists():
    os.system(f'python3 {build_index} >/dev/null 2>&1')
