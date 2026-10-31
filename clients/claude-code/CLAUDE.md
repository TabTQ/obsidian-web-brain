<!-- brain:start -->
# Brain: shared memory across devices

I run a self-hosted vault ("brain") that every Claude Code session on all my devices shares through the `brain` MCP server. Notes are markdown with `[[wikilinks]]`, `#tags` and YAML frontmatter. A session-start hook gives you only an index (recent note titles and tags), not contents.

## Retrieval: targeted only
- At the start of a task, if prior context could plausibly help, run **one or two `search_notes` queries** built from the task's specifics: project name, hostname, service, tool, error text. For example `deploy tag:#docker` or `"payment service"`.
- Read **only the notes whose titles or matching lines are clearly relevant**, usually 1–3. Use `get_outline` first on long notes, and follow a link (`get_backlinks` / `get_outgoing_links`) only when it is needed.
- **Never** list and read the whole vault, read notes "just in case", or re-read a note already read in this session.
- Skip the brain entirely for self-contained tasks: general questions, small edits in code you can already see.
- Memories reflect the past. Verify paths, flags and configs they mention before relying on them.

## Saving: durable knowledge only
- Save when you learn something worth reusing on a later task: a decision and its reason, a root cause and fix, a host or config detail, a convention I state, a non-obvious gotcha.
- Search first and extend the existing note (`append_to_note` / `edit_note`). Only create a new note when none fits.
- Where things go:
  - `Knowledge/<Area>/<Topic>.md` for topic notes, such as `Knowledge/Infra/Docker.md`. An `Index.md` note can link the areas.
  - `Projects/<Project>.md` for per-project notes.
  - `Memories/<name>.md` for distilled session memories (`/create-memory`).
  - The daily note for session logs (`daily_note`).
- Link related notes with `[[...]]`, add 1–3 `#tags`, keep notes concise, and use absolute dates.
- Never store secrets (tokens, passwords, keys). Record where they live instead.
- Don't save trivia, raw tool output, or anything that is easy to re-derive from code or git history.
- At the end of substantial work (a fix, a deployment, a decision), append a 2–5 line summary to today's daily note, linking the notes you touched.

Slash commands: `/remember <fact>`, `/recall <topic>`, `/log`, `/create-memory <name>`, `/load-memory`.
<!-- brain:end -->
