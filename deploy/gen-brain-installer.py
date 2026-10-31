#!/usr/bin/env python3
# Generate the Claude Code client installer (MCP registration, CLAUDE.md section, SessionStart hook, 5 skills).
# Sources default to clients/claude-code/ in this repo; set BRAIN_CLIENT_SRC=~/.claude to package your own customized copies.
# Usage: BRAIN_URL=https://brain.<your-tailnet>.ts.net python3 deploy/gen-brain-installer.py > install-brain-client.sh
# then upload it into the vault at Setup/install-brain-client.sh (it is served to devices via /api/v1/file).
import os, sys
brain_url = os.environ.get("BRAIN_URL") or sys.exit("set BRAIN_URL, e.g. https://brain.<your-tailnet>.ts.net")
src = os.path.expanduser(os.environ.get("BRAIN_CLIENT_SRC") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "clients", "claude-code"))
claude_md = open(f"{src}/CLAUDE.md").read()
start = claude_md.index("<!-- brain:start -->"); end = claude_md.index("<!-- brain:end -->") + len("<!-- brain:end -->")
section = claude_md[start:end] + "\n"
hook = open(f"{src}/hooks/brain-context.sh").read()
skills = {n: open(f"{src}/skills/{n}/SKILL.md").read() for n in ["remember", "recall", "log", "create-memory", "load-memory"]}
def block(var, text):
    tag = "BRAIN_EOF_" + var.upper()
    assert tag not in text
    return f"read -r -d '' {var} <<'{tag}' || true\n{text}{'' if text.endswith(chr(10)) else chr(10)}{tag}\n"
out = ['''#!/usr/bin/env bash
# Brain client installer for Claude Code (Linux / macOS / WSL).
# Installs on this device: the brain MCP server (user scope), ~/.config/brain/{url,token},
# the CLAUDE.md "brain" section, the SessionStart index hook, and the skills
# /remember /recall /log /create-memory /load-memory. Safe to re-run (updates in place).
#
# Usage (token from the web UI: Settings -> MCP access):
#   curl -fsSL -H "Authorization: Bearer $TOKEN" \\
#     "__BRAIN_URL__/api/v1/file?path=Setup/install-brain-client.sh" -o /tmp/brain-install.sh
#   BRAIN_TOKEN="$TOKEN" bash /tmp/brain-install.sh
set -euo pipefail
BRAIN_URL="${BRAIN_URL:-__BRAIN_URL__}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

say() { printf '\\033[1;35m==\\033[0m %s\\n' "$*"; }
die() { printf '\\033[1;31mERROR:\\033[0m %s\\n' "$*" >&2; exit 1; }

for bin in curl python3 claude; do command -v "$bin" >/dev/null || die "'$bin' is required but not installed"; done

if [ -z "${BRAIN_TOKEN:-}" ]; then
  if [ -t 0 ]; then read -r -s -p "Brain MCP token (Settings -> MCP access): " BRAIN_TOKEN; echo; fi
fi
[ -n "${BRAIN_TOKEN:-}" ] || die "set BRAIN_TOKEN (Settings -> MCP access in the web UI)"

say "Checking access to $BRAIN_URL (device must be on the tailnet)"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 -H "Authorization: Bearer $BRAIN_TOKEN" "$BRAIN_URL/api/v1/recent?limit=1" || true)
[ "$code" = "200" ] || die "brain not reachable or token rejected (HTTP $code). Is Tailscale up on this device?"

say "Saving URL and token to ~/.config/brain (mode 600)"
mkdir -p "$HOME/.config/brain"; chmod 700 "$HOME/.config/brain"
( umask 077; printf '%s' "$BRAIN_URL" > "$HOME/.config/brain/url"; printf '%s' "$BRAIN_TOKEN" > "$HOME/.config/brain/token" )

say "Registering the brain MCP server (user scope)"
claude mcp remove --scope user brain >/dev/null 2>&1 || true
claude mcp add --transport http --scope user brain "$BRAIN_URL/mcp" --header "Authorization: Bearer $BRAIN_TOKEN" >/dev/null
''']
out.append(block("BRAIN_SECTION", section))
out.append(block("BRAIN_HOOK", hook))
for n, t in skills.items():
    out.append(block("SKILL_" + n.replace("-", "_").upper(), t))
out.append('''
mkdir -p "$CLAUDE_DIR/hooks" "$CLAUDE_DIR/skills"

say "Installing CLAUDE.md brain section"
BRAIN_SECTION="$BRAIN_SECTION" python3 - "$CLAUDE_DIR/CLAUDE.md" <<'PY'
import os, re, sys
p = sys.argv[1]; sec = os.environ["BRAIN_SECTION"].strip() + "\\n"
cur = open(p).read() if os.path.exists(p) else ""
if "<!-- brain:start -->" in cur and "<!-- brain:end -->" in cur:
    cur = re.sub(r"<!-- brain:start -->.*?<!-- brain:end -->\\n?", lambda m: sec, cur, flags=re.S)
else:
    cur = (cur.rstrip("\\n") + "\\n\\n" if cur.strip() else "") + sec
open(p, "w").write(cur)
PY

say "Installing SessionStart hook"
printf '%s\\n' "$BRAIN_HOOK" > "$CLAUDE_DIR/hooks/brain-context.sh"
chmod 700 "$CLAUDE_DIR/hooks/brain-context.sh"
python3 - "$CLAUDE_DIR/settings.json" <<'PY'
import json, os, shutil, sys
p = sys.argv[1]
data = {}
if os.path.exists(p):
    shutil.copy(p, p + ".bak-brain")
    data = json.load(open(p))
cmd = "~/.claude/hooks/brain-context.sh"
hooks = data.setdefault("hooks", {}).setdefault("SessionStart", [])
if not any(h.get("command") == cmd for g in hooks for h in g.get("hooks", [])):
    hooks.append({"hooks": [{"type": "command", "command": cmd, "timeout": 10}]})
json.dump(data, open(p, "w"), indent=2)
PY

say "Installing skills: remember recall log create-memory load-memory"
install_skill() { mkdir -p "$CLAUDE_DIR/skills/$1"; f="$CLAUDE_DIR/skills/$1/SKILL.md"; [ -f "$f" ] && ! grep -q "brain" "$f" && cp "$f" "$f.bak-local"; printf '%s\\n' "$2" > "$f"; }
install_skill remember "$SKILL_REMEMBER"
install_skill recall "$SKILL_RECALL"
install_skill log "$SKILL_LOG"
install_skill create-memory "$SKILL_CREATE_MEMORY"
install_skill load-memory "$SKILL_LOAD_MEMORY"

say "Verifying"
echo '{}' | "$CLAUDE_DIR/hooks/brain-context.sh" | python3 -c "import sys,json; print(json.load(sys.stdin)['hookSpecificOutput']['additionalContext'].splitlines()[0])"
claude mcp list 2>/dev/null | grep -i '^brain' || echo "(run 'claude mcp list' to check the connection)"
say "Done. Restart any open Claude Code sessions to pick up the brain."
''')
sys.stdout.write("".join(out).replace("__BRAIN_URL__", brain_url.rstrip("/")))
