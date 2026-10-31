#!/usr/bin/env bash
# SessionStart hook: inject a tiny index of the brain vault (titles and tags only,
# never note contents) so Claude knows what exists and can fetch just what is relevant.
# Silent no-op if the brain is unreachable (offline, not on the tailnet).
URL=$(cat "$HOME/.config/brain/url" 2>/dev/null) || exit 0
TOKEN=$(cat "$HOME/.config/brain/token" 2>/dev/null) || exit 0
get() { curl -fsS -m 3 -H "Authorization: Bearer $TOKEN" "$URL/api/v1/$1" 2>/dev/null; }
RECENT=$(get "recent?limit=12") || exit 0
TAGS=$(get "tags") || TAGS='{}'
python3 - "$RECENT" "$TAGS" <<'PY'
import json, sys
from datetime import datetime
recent = json.loads(sys.argv[1] or "[]")
tags = json.loads(sys.argv[2] or "{}")
lines = ["Brain vault (shared memory via the `brain` MCP) — index only, contents NOT loaded."]
if recent:
    lines.append("Recently modified notes: " + "; ".join(
        f"{r['path'][:-3] if r['path'].endswith('.md') else r['path']} ({datetime.fromtimestamp(r['mtime']/1000):%Y-%m-%d})" for r in recent))
else:
    lines.append("The vault is empty so far.")
top = sorted(tags.items(), key=lambda kv: -kv[1])[:25]
if top:
    lines.append("Tags in use: " + ", ".join(f"{t}({n})" for t, n in top))
lines.append("Only open notes relevant to the current task (search_notes / read_note on specific notes). Never bulk-read the vault.")
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "\n".join(lines)}}))
PY
