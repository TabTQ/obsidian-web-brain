---
name: remember
description: Save a fact, decision, fix, or detail to the shared brain vault (brain MCP) so every Claude Code session on every device can reuse it. Invoked as `/remember <what to remember>`. Use when the user says "remember this", "save this to my brain", "note that…", or asks you to keep something for later.
---

# remember

Store what the user asked to remember in the brain vault, in the right place, without duplicating anything.

1. **Work out what to save.** Use the argument. If it is empty, use the most recent decision or finding in this conversation. Rewrite it as a concise, standalone statement with concrete names, paths and absolute dates. Never include secrets; say where they live instead.
2. **Find the right home with one targeted search.** Run `search_notes` with 2–4 specific keywords (a host, a project, a tool), or `file:<topic>`. Look only at the results' titles and matching lines.
   - **An existing note fits:** `append_to_note`, or `edit_note` to update a line that is now wrong. Read that one note first only if you need its structure.
   - **No note fits:** `create_note` at `Knowledge/<Topic>.md`, or `Projects/<Project>.md` for project-specific facts. Give it a short `# Title`, 1–3 `#tags`, and `[[links]]` to related notes found by the search.
3. **Confirm** in one line: what was saved, and where (the note path).

Do not read unrelated notes. One search plus at most one read is normally enough.
