---
name: create-memory
description: Save the important context from the current conversation as a memory note in the shared brain vault (brain MCP, folder Memories/) so a future agent on any device can reuse it on similar work. Invoked as `/create-memory <file-name>`. Use whenever the user says "create memory", "save this as a memory", "remember what we did here", or wants to capture discoveries, root causes, fixes, or decisions from the session for later.
---

# create-memory

Distill the current conversation into a single markdown file that a *different agent, with zero context from this session,* can read later and immediately benefit from when doing similar work.

## Where it goes

The shared brain vault, through the `brain` MCP server: folder `Memories/`, so the note is `Memories/<file-name>.md`. Every device and session can see it. If the brain MCP is unavailable, say so and fall back to `~/.claude/memories/<file-name>.md`.

The user invokes `/create-memory <file-name>`. Use the argument as the file name:
- Lowercase-kebab it, strip any path separators, and append `.md` if absent.
- If no name was given, propose a short descriptive one and use it (don't stall on a question).
- If the note already exists, check with `read_note` on `Memories/<file-name>.md`. If it does, ask whether to overwrite or merge; never silently clobber it. To merge, use `update_note` with the etag from `read_note`.

## What to capture

Reread the conversation and extract only what would save a future agent time. Prioritize:

- **Goal / problem**: what was being attempted and the symptoms (exact error messages are valuable).
- **Discoveries**: non-obvious facts learned about the codebase, tools, environment, APIs, or config, including things that were surprising or contradicted assumptions.
- **Root cause and resolution**: what actually caused the issue, what was changed, and how (commands, file paths, key snippets).
- **Dead ends**: approaches tried that failed and why, so they aren't repeated.
- **Decisions and rationale**: choices made and the reasons behind them.
- **Verification**: how the fix was confirmed to work.
- **User preferences / conventions** expressed that apply to similar work.
- **Gotchas and follow-ups**: open items, caveats, things to check next time.

Skip chit-chat, raw tool output dumps, and anything trivially derivable from reading the code. Quality over volume: a tight, accurate file beats a long transcript. Never include secrets, tokens, or passwords; reference where they live instead.

## File format

```markdown
---
name: <file-name without .md>
description: <one line: what this memory helps with, used to pick it from a list>
created: <YYYY-MM-DD>
project: <working directory or repo, if relevant>
tags: [<a few keywords>]
---

# <Title>

## Context
<goal and situation in 2-4 sentences>

## Key findings
- ...

## What was done
1. <steps, with commands / file paths>

## Dead ends
- <tried X, failed because Y>

## Verification
<how it was confirmed>

## Notes for next time
- ...
```

Omit sections that have nothing real to say. Use absolute dates and concrete paths so the file stays meaningful out of context. Write it so it stands alone: a reader shouldn't need this conversation.

Also add `[[links]]` to related vault notes you already know about. Use tags without `#` in the frontmatter `tags:` list.

## Finish

Create the note with `create_note` (path `Memories/<file-name>.md`). Then tell the user the vault path and give a 1–2 line summary of what was saved.
