---
name: log
description: Append a short summary of this session's work to today's daily note in the shared brain vault. Invoked as `/log` (optionally `/log <extra note>`). Use when the user says "log this session", "add to my daily note", "journal what we did", or at the end of a substantial piece of work.
---

# log

1. **Summarize this session** in 2–6 bullets:
   - What was done, decided or fixed.
   - Key paths, hosts or commands, and what is still open.
   - Include the argument text if one was given.
   - Use `[[links]]` to vault notes touched or relevant (only notes you already know exist), plus 1–2 `#tags`.
   - No secrets.
2. **Write it** with one `daily_note` call: `{ "append": "## <HH:MM> <short title>\n<bullets>" }`. Use the local time; there's no need to read the note first.
3. **Confirm** with the daily note's path.
