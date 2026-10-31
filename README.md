# Obsidian Web Brain

A small, self-hosted, **Obsidian-style markdown vault with a web UI** and a built-in **shared-memory MCP server**, so Claude Code on all your devices can share one "brain". Notes stay plain `.md` files on disk and are backed up to a private git repository.

> Independent, clean-room project, **not affiliated with or endorsed by Obsidian** (Obsidian is a trademark of Dynalist Inc.). No Obsidian code or assets are used. The behavior is designed to be compatible with Obsidian vault conventions, so the same folder also opens in Obsidian.

**Live showcase:** **https://tabtq.github.io/obsidian-web-brain/** is an interactive tour of the architecture, data flows, editor and MCP tools. To view it offline, download [`docs/showcase/index.html`](docs/showcase/index.html) and open it in a browser; it's a single self-contained file.

## Features

**Editor and notes**
- **Live-preview editor** (CodeMirror 6). Markdown renders as you type, and syntax appears only where the cursor is:
  - per token for bold, italic, code, links and math;
  - per line for headings, tasks and rules;
  - per block for callouts, code fences and math blocks.
- **Links:** `[[wikilinks]]` with aliases, `#heading` and `^block` references. Ambiguous names resolve the way Obsidian resolves them.
- **Embeds:** notes, headings, images (with size), audio, video and PDF.
- **Renames update links everywhere**: wikilinks, markdown links (URL-encoded) and frontmatter links.

**Navigation and search**
- Backlinks, outgoing links, outline, properties (YAML frontmatter) and a tag tree.
- **Search operators:** `"phrase"`, `OR`, `-exclude`, `file:`, `path:`, `content:`, `tag:`, `line:()`, `section:()`, `block:()`, `task-todo:`, `task-done:`, `[property:value]`, `/regex/` and `match-case:`.
- **Graph view** (global and local; d3-force on canvas), quick switcher, command palette, daily notes and templates (`{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}`).
- KaTeX math and lazy-loaded Mermaid diagrams.

**Git backup and sync**
- Every save is committed, and pushes are debounced.
- Manual commit, sync and pull are available.
- Edits made on GitHub flow back into the vault.
- A **per-file conflict resolver** (keep vault, keep remote, or edit a merged version) means nothing is lost. Conflicts are detected with `git merge-tree`, so the working tree never contains conflict markers.

**Safety**
- Soft delete to `.trash/`, restorable from the UI.
- **Stale-write protection**: writes carry an etag, so concurrent edits are rejected with a clear error instead of silently overwriting.

**MCP server** at `/mcp` (Streamable HTTP, bearer token) with 25 tools:
- search, read, create, append, prepend and edit notes;
- replace lines, update, rename and delete;
- backlinks, outgoing links and outline;
- tags, properties and daily notes;
- unresolved links, orphans, dead-ends and templates.

**Footprint:** about 20–90 MB RAM at idle. The server is a single Node.js process with one runtime dependency (`yaml`), and ships as a ~400 KB bundle.

## How it fits together

```
 Browser (any device on your tailnet) ─┐                ┌─> Claude Code (laptop, desktop, ...)
                                       │  HTTPS (real   │     MCP over HTTPS + bearer token
                       tailscale serve ┴─ certificate) ─┘
                                       │
                         127.0.0.1:8090 Node.js server (systemd)
                ┌──────────┬───────────┼─────────────┬──────────────┐
             REST API    MCP /mcp   live events     web UI      git sync
                └──────────┴─────┬─────┴─────────────┘              │
                       vault service + in-memory index              │
                   (links, backlinks, tags, properties, search)     │
                                 │                                  │
                      /var/lib/brain/vault/*.md  ── commits/pushes ─┴─> private GitHub repo
```

## Repository layout

```
server/              Node.js + TypeScript backend: vault, index, search, git, REST API, MCP
web/                 Vite + TypeScript frontend (no framework): editor, panels, graph, settings
clients/claude-code/ CLAUDE.md section, SessionStart hook and 5 skills for Claude Code
deploy/              release packaging, systemd unit, installer, optional Proxmox LXC helper
docs/showcase/       self-contained interactive showcase page (open offline)
```

## Run locally

```bash
npm install
npm test                                        # server test suite
BRAIN_DATA_DIR=.dev-data npm run dev:server     # API on http://127.0.0.1:8090
npm run dev:web                                 # UI on http://localhost:5173 (proxies /api and /mcp)
```

On first start the server prints a **one-time setup code**, which is also written to `$BRAIN_DATA_DIR/setup-code.txt`. Open the UI, enter the code and choose a password. The UI then shows your MCP token.

## Deploy (any Debian/Ubuntu host or container)

1. **Build a release** on a machine with Node.js 22+:
   ```bash
   bash deploy/package.sh            # -> release/brain-<version>.tar.gz
   ```
2. **Install** on the target as root. This installs Node.js 24 (official tarball, checksum verified), git and the OpenSSH client, creates the `brain` user, and installs a hardened systemd unit listening on `127.0.0.1:8090` only.
   ```bash
   tar xzf brain-*.tar.gz && bash brain/install.sh
   ```
3. **Expose it privately with Tailscale** (recommended). You get HTTPS with a real certificate, reachable only from your tailnet:
   ```bash
   tailscale up --hostname brain
   tailscale serve --bg 8090         # -> https://brain.<your-tailnet>.ts.net
   ```
   Your tailnet needs MagicDNS and HTTPS certificates enabled.

**Proxmox VE (optional).** `deploy/create-lxc.sh` creates a suitable unprivileged Debian 12 LXC with the TUN device Tailscale needs:
```bash
VMID=200 IP=192.0.2.50/24 GW=192.0.2.1 bash create-lxc.sh      # run on the Proxmox node
PVE_HOST=root@your-pve VMID=200 bash deploy/update.sh          # later: push a new release
```

Configuration is through environment variables (see `deploy/brain.service`): `BRAIN_DATA_DIR`, `BRAIN_VAULT_DIR`, `BRAIN_WEB_DIR`, `BRAIN_HOST`, `BRAIN_PORT`.

## Git backup

In **Settings → Git sync**:
1. Generate a deploy key.
2. Add it to a **private** repository with write access.
3. Enter the SSH remote and branch, then check the host key. GitHub's key is verified against its published fingerprint.
4. Connect.

What happens on connect:
- **Empty repository:** the vault is pushed to it.
- **Empty vault:** the repository is cloned into it.
- **Both have content:** they are merged, and any conflicts open in the resolver.

## Use it from Claude Code

**Register the MCP server.** Settings → MCP access shows the exact command:
```bash
claude mcp add --transport http --scope user brain https://brain.<your-tailnet>.ts.net/mcp \
  --header "Authorization: Bearer <token>"
```

**For automatic, targeted use**, install the client kit from `clients/claude-code/`. It contains:
- **A `CLAUDE.md` section.** It tells Claude to run one or two targeted searches and read only the relevant notes (never bulk-read the vault), save only durable knowledge, and log work to the daily note.
- **A SessionStart hook.** It injects only recent note titles and tags, never contents, and is a silent no-op when offline.
- **Skills:** `/remember`, `/recall`, `/log`, `/create-memory` and `/load-memory`.

To install it on every device with one command, generate the installer, store it in your vault and fetch it from each device:
```bash
BRAIN_URL=https://brain.<your-tailnet>.ts.net python3 deploy/gen-brain-installer.py > install-brain-client.sh
# upload it into the vault as Setup/install-brain-client.sh, then on each device:
curl -fsSL -H "Authorization: Bearer $TOKEN" \
  "https://brain.<your-tailnet>.ts.net/api/v1/file?path=Setup/install-brain-client.sh" -o /tmp/brain-install.sh
BRAIN_TOKEN="$TOKEN" bash /tmp/brain-install.sh
```
The installer is idempotent. It merges into existing `CLAUDE.md` and `settings.json`, keeps backups, and supports Linux, macOS and WSL.

## Security model

- **Network:** the server binds to `127.0.0.1` only. Tailscale Serve terminates HTTPS, so credentials never cross the network unencrypted. Requests from another origin are rejected.
- **Web UI login:** a password hashed with scrypt, and an HMAC-signed session cookie that is `HttpOnly`, `Secure` and `SameSite=Strict`. State-changing requests must carry an `X-Brain-Request` header (CSRF defence). Repeated failed logins are throttled.
- **API and MCP clients:** a bearer token, which can be rotated in Settings.
- **First-run setup:** requires a one-time code that is only readable on the server.
- **Rendering:** markdown is rendered with raw HTML disabled, and vault SVG/HTML files are served with a sandbox CSP.
- **Secrets on disk:** `config.json` and `deploy_key` are mode 0600 and kept outside the vault. The `.trash/` folder is git-ignored.
- **Paths:** path traversal is rejected, and hidden paths (`.git`, `.trash`) are not writable through the API.

## Tests

```bash
npm test
```
The server suite covers:
- link resolution and its tie-breaks;
- rename rewriting (wiki, markdown and frontmatter links);
- every search operator;
- templates and daily notes;
- stale writes, path traversal and properties;
- HTTP auth and CSRF;
- the MCP endpoint through the **official MCP TypeScript SDK client**;
- git sync with a real conflict, using a local bare repository.

## License

[MIT](LICENSE)
