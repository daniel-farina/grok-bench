# Grok default system prompts (versioned)

Each `grok-<version>.txt` is a verbatim copy of the system prompt sent by the
named grok-build binary on its first agentic API call. Capture it like:

```sh
# from a bench run that used the default prompt (system_prompt: 'default'),
# grab the system message of any non-session-title capture:
python3 -c "
import json, glob, sys
caps = sorted(glob.glob('.bench-data/bench_*/captures/*.json'))
for f in caps:
    c = json.load(open(f))
    sys_msg = next((m for m in c['request']['input'] if m['role']=='system'), None)
    if sys_msg and len(sys_msg['content']) > 5000:
        open(sys.argv[1], 'w').write(sys_msg['content'])
        print(f'wrote {sys.argv[1]} ({len(sys_msg[\"content\"])} chars)')
        break
" prompts/grok-<version>.txt
```

The bench-server auto-detects your installed grok version (`grok --version`)
and serves the matching `grok-<version>.txt` from `/api/grok-default-prompt`.
If your version's file is missing, it falls back to the highest one present.

## Why version it?

- The prompt changes between grok releases. Section toggles + diffs are only
  meaningful against the exact prompt the model is actually receiving.
- Lets you compare prompts across versions (e.g. did `<output_efficiency>`
  get more restrictive in 0.2.0?).
