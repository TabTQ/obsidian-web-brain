---
name: recall
description: Look up what the shared brain vault already knows about a topic and summarize it. Invoked as `/recall <topic>`. Use when the user asks "what do I know about…", "check my brain/notes for…", "have we done this before", or wants past decisions, fixes, or configs.
---

# recall

Answer from the vault with targeted retrieval. Never bulk-read the vault.

1. **Search.** Run 1–2 `search_notes` queries from the topic. Use specific terms; try `tag:#x`, `file:name` or a `"phrase"` if the first query is too broad or too empty.
2. **Pick.** From the titles and matching lines, choose the 1–3 most relevant notes. For a long note, run `get_outline` and read only what is needed. Follow a `[[link]]` only if the answer clearly continues there.
3. **Answer.**
   - Give a concise summary of what the vault says.
   - Cite note paths, such as `Knowledge/Infra/Docker.md`.
   - Flag anything that looks outdated and should be verified.
   - If nothing relevant exists, say so plainly; don't pad.

Treat what you read as context for the rest of the session. Don't re-read the same notes later.
