---
name: load-memory
description: Let the user pick one or more saved memories from the shared brain vault (brain MCP, folder Memories/) with a multi-select checklist and load their contents into the current conversation as context. Invoked as `/load-memory`. Use whenever the user says "load memory", "load memories", "bring in my saved context", or wants to reuse notes previously saved with create-memory.
---

# load-memory

Show the saved memories, let the user tick any number of them, then read the chosen files into this conversation so you can use them as context.

## Steps

1. **List memories.** Call `list_notes` for each of the folders `Memories`, `Projects` and `Knowledge`. These calls return paths only and read no contents. Group the options by folder; `Knowledge/<Area>/` subfolders are areas. If there are none, tell the user and suggest `/create-memory <name>`; then stop. If the user passed a topic argument, call `search_notes` with that topic instead, and offer only the matching notes.

2. **Gather labels.** Do not read the notes to build the list. Use each note's file name (without the folder and `.md`) as the option label, and the folder as its description. If you need a description, take it from the matching line returned by a single `search_notes` call such as `path:Memories/ description:`; otherwise leave it blank.

3. **Ask with a checklist.** Use the `AskUserQuestion` tool with `multiSelect: true`, which gives the user check-mark selection. Each question allows at most 4 options and a call allows at most 4 questions, so:
   - Split memories into groups of 4, one question per group (header like "Memories 1-4"), up to 4 questions (16 memories) per call.
   - If more than 16 memories exist, show the 16 newest and mention that older ones exist; if the user wants them, ask again with the next 16 (or accept a file name typed via "Other").
   - The built-in "Other" field lets the user type a name manually; treat it as a file name to load.

4. **Load the selection.** Call `read_note` only for the selected notes, in parallel. If nothing was selected, say so and stop.

5. **Confirm.** Reply briefly with the list of memories loaded and a one-line gist of each. Treat their contents as background context for the rest of the conversation: use the findings, avoid the recorded dead ends, and follow the noted conventions. Memories reflect what was true when saved, so verify any file path, function, or flag they mention before relying on it.

Do not modify or delete memory notes while loading, and do not read memories the user didn't select.
