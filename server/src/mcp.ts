// Shared-memory MCP server (Streamable HTTP, stateless, JSON responses).
// Implemented directly on node:http to keep the footprint small.

import type { IncomingMessage, ServerResponse } from "node:http";
import { formatDate } from "./dates.js";
import type { Brain } from "./brain.js";
import { readBody, sendJson } from "./http.js";
import { naturalCompare } from "./paths.js";
import { HttpError } from "./vault.js";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "brain", title: "Brain (shared memory vault)", version: "0.1.0" };

const INSTRUCTIONS = `This server is the user's central "brain": a shared Obsidian-style markdown vault used as long-term memory across all of their devices and Claude Code sessions.
- Notes are markdown files; link notes with [[Note Name]] wikilinks, tag with #tags, and use YAML frontmatter for properties.
- Before writing, search (search_notes) or list (list_notes / recent_notes) to find an existing note and extend it rather than creating duplicates.
- Prefer append_to_note / edit_note for small changes. update_note replaces the whole note and requires the etag from read_note; if the note changed since you read it the write is rejected — re-read and retry.
- Use daily_note to log session summaries or decisions for today.
- Deletes are soft (moved to .trash) and everything is versioned in git, but still avoid destructive edits unless asked.`;

type Json = Record<string, unknown>;
interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  run: (args: Json) => Promise<unknown>;
}

const S = {
  str: (description: string) => ({ type: "string", description }),
  int: (description: string) => ({ type: "integer", description }),
  bool: (description: string) => ({ type: "boolean", description }),
};

function obj(props: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties: props, required, additionalProperties: false };
}

function needStr(a: Json, k: string): string {
  const v = a[k];
  if (typeof v !== "string" || v === "") throw new HttpError(400, `Missing or invalid "${k}"`, "invalid");
  return v;
}
function optStr(a: Json, k: string): string | undefined {
  const v = a[k];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new HttpError(400, `"${k}" must be a string`, "invalid");
  return v;
}
function optInt(a: Json, k: string, d: number): number {
  const v = a[k];
  return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : d;
}

export function buildTools(brain: Brain): Tool[] {
  const ro = { readOnlyHint: true, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
  const src = "mcp" as const;
  return [
    {
      name: "search_notes",
      description:
        'Full-text search across the vault using Obsidian search syntax: words are ANDed; "exact phrase"; OR; -exclude; file:name; path:folder/; tag:#tag; content:word; line:(a b); section:(a b); [property:value]; /regex/; task-todo:word. Returns matching notes with matching lines.',
      inputSchema: obj({ query: S.str("Search query"), limit: S.int("Max notes (default 20)") }, ["query"]),
      annotations: ro,
      run: async (a) => {
        const res = brain.search(needStr(a, "query"), { limit: optInt(a, "limit", 20) });
        return res.map((r) => ({ path: r.path, matches: r.matches.slice(0, 5).map((m) => `${m.line + 1}: ${m.text.slice(0, 300)}`) }));
      },
    },
    {
      name: "read_note",
      description: "Read a note's full markdown content with its etag (needed for update_note) and metadata. Accepts a path or a note name.",
      inputSchema: obj({ path: S.str("Vault path like 'Projects/Plan.md' or a note name like 'Plan'") }, ["path"]),
      annotations: ro,
      run: async (a) => {
        const n = await brain.read(needStr(a, "path"));
        const m = brain.meta(n.path);
        return { path: n.path, etag: n.etag, modified: new Date(n.mtime).toISOString(), tags: m.tags, frontmatter: m.frontmatter, content: n.content };
      },
    },
    {
      name: "list_notes",
      description: "List notes (and optionally attachments) in the vault or a folder.",
      inputSchema: obj({ folder: S.str("Folder path (default: whole vault)"), include_attachments: S.bool("Include non-markdown files"), limit: S.int("Max entries (default 500)") }),
      annotations: ro,
      run: async (a) => {
        const folder = optStr(a, "folder")?.replace(/^\/+|\/+$/g, "");
        const all = a.include_attachments === true;
        const files = [...brain.index.files.values()]
          .filter((f) => (all || f.md) && (!folder || f.path.startsWith(folder + "/")))
          .map((f) => f.path)
          .sort(naturalCompare);
        const limit = optInt(a, "limit", 500);
        return { total: files.length, notes: files.slice(0, limit), folders: [...brain.index.folders].filter((d) => !folder || d.startsWith(folder + "/")).sort(naturalCompare) };
      },
    },
    {
      name: "recent_notes",
      description: "Most recently modified notes.",
      inputSchema: obj({ limit: S.int("Max notes (default 20)") }),
      annotations: ro,
      run: async (a) =>
        [...brain.index.files.values()]
          .filter((f) => f.md)
          .sort((x, y) => y.mtime - x.mtime)
          .slice(0, optInt(a, "limit", 20))
          .map((f) => ({ path: f.path, modified: new Date(f.mtime).toISOString() })),
    },
    {
      name: "create_note",
      description: "Create a new note. Fails if it already exists. Parent folders are created automatically. '.md' is added if missing. Optionally render a template from the templates folder.",
      inputSchema: obj({ path: S.str("New note path, e.g. 'Ideas/New idea.md'"), content: S.str("Markdown content"), template: S.str("Optional template note to start from") }, ["path"]),
      annotations: rw,
      run: async (a) => {
        const p = needStr(a, "path");
        let content = optStr(a, "content") ?? "";
        const tpl = optStr(a, "template");
        if (tpl) content = (await brain.renderTemplate(tpl, p.split("/").pop()!.replace(/\.md$/i, ""))) + (content ? "\n" + content : "");
        return brain.create(p, content, src);
      },
    },
    {
      name: "append_to_note",
      description: "Append text to the end of a note (creates the note if missing). Safe for concurrent use.",
      inputSchema: obj({ path: S.str("Note path or name"), text: S.str("Markdown to append") }, ["path", "text"]),
      annotations: rw,
      run: async (a) => brain.append(needStr(a, "path"), needStr(a, "text"), src),
    },
    {
      name: "prepend_to_note",
      description: "Insert text at the top of a note, after its frontmatter (creates the note if missing).",
      inputSchema: obj({ path: S.str("Note path or name"), text: S.str("Markdown to prepend") }, ["path", "text"]),
      annotations: rw,
      run: async (a) => brain.prepend(needStr(a, "path"), needStr(a, "text"), src),
    },
    {
      name: "edit_note",
      description: "Replace an exact substring in a note (must be unique unless replace_all). Best for targeted edits.",
      inputSchema: obj(
        { path: S.str("Note path or name"), old_text: S.str("Exact text to replace"), new_text: S.str("Replacement text"), replace_all: S.bool("Replace every occurrence"), etag: S.str("Optional etag from read_note to guard against concurrent edits") },
        ["path", "old_text", "new_text"],
      ),
      annotations: rw,
      run: async (a) =>
        brain.replaceText(needStr(a, "path"), needStr(a, "old_text"), typeof a.new_text === "string" ? a.new_text : "", { replaceAll: a.replace_all === true, ifMatch: optStr(a, "etag"), source: src }),
    },
    {
      name: "replace_lines",
      description: "Replace lines from_line..to_line (1-based, inclusive) of a note with new text.",
      inputSchema: obj({ path: S.str("Note path or name"), from_line: S.int("First line (1-based)"), to_line: S.int("Last line (inclusive)"), text: S.str("Replacement text"), etag: S.str("Optional etag from read_note") }, [
        "path",
        "from_line",
        "to_line",
        "text",
      ]),
      annotations: rw,
      run: async (a) => brain.replaceLines(needStr(a, "path"), Number(a.from_line), Number(a.to_line), typeof a.text === "string" ? a.text : "", { ifMatch: optStr(a, "etag"), source: src }),
    },
    {
      name: "update_note",
      description: "Replace a note's entire content. Requires the etag from read_note; rejected if the note changed since (re-read and retry).",
      inputSchema: obj({ path: S.str("Note path"), content: S.str("New full markdown content"), etag: S.str("etag returned by read_note") }, ["path", "content", "etag"]),
      annotations: rw,
      run: async (a) => brain.write(brain.resolvePathArg(needStr(a, "path")), typeof a.content === "string" ? a.content : "", { ifMatch: needStr(a, "etag"), source: src }),
    },
    {
      name: "rename_note",
      description: "Rename or move a note or folder. All links pointing at it are updated automatically.",
      inputSchema: obj({ from: S.str("Current path"), to: S.str("New path") }, ["from", "to"]),
      annotations: rw,
      run: async (a) => brain.rename(needStr(a, "from"), needStr(a, "to"), src),
    },
    {
      name: "delete_note",
      description: "Soft-delete a note or folder (moved to .trash, recoverable). Only use when the user asks.",
      inputSchema: obj({ path: S.str("Note or folder path") }, ["path"]),
      annotations: destructive,
      run: async (a) => brain.delete(needStr(a, "path"), src),
    },
    {
      name: "get_backlinks",
      description: "Notes that link to the given note, with the linking line.",
      inputSchema: obj({ path: S.str("Note path or name") }, ["path"]),
      annotations: ro,
      run: async (a) => brain.backlinks(needStr(a, "path")).map((b) => ({ source: b.source, line: b.line + 1, context: b.context.slice(0, 300) })),
    },
    {
      name: "get_outgoing_links",
      description: "Links from a note to other notes, with their resolved target (null if the target does not exist).",
      inputSchema: obj({ path: S.str("Note path or name") }, ["path"]),
      annotations: ro,
      run: async (a) => brain.outgoing(needStr(a, "path")).map((o) => ({ link: o.link + o.subpath, resolved: o.resolved, line: o.line + 1, embed: o.embed })),
    },
    {
      name: "get_outline",
      description: "Headings of a note (outline).",
      inputSchema: obj({ path: S.str("Note path or name") }, ["path"]),
      annotations: ro,
      run: async (a) => brain.meta(needStr(a, "path")).headings.map((h) => ({ level: h.level, heading: h.heading, line: h.line + 1 })),
    },
    {
      name: "list_tags",
      description: "All tags with usage counts (nested tags also count toward parents).",
      inputSchema: obj({}),
      annotations: ro,
      run: async () => brain.index.tagCounts(),
    },
    {
      name: "get_notes_by_tag",
      description: "Notes carrying a tag (includes nested child tags).",
      inputSchema: obj({ tag: S.str("Tag with or without #") }, ["tag"]),
      annotations: ro,
      run: async (a) => brain.index.notesWithTag(needStr(a, "tag")),
    },
    {
      name: "get_properties",
      description: "Without path: all frontmatter property names in the vault with types and counts. With path: that note's frontmatter.",
      inputSchema: obj({ path: S.str("Optional note path or name") }),
      annotations: ro,
      run: async (a) => {
        const p = optStr(a, "path");
        return p ? brain.meta(p).frontmatter ?? {} : brain.index.properties();
      },
    },
    {
      name: "set_property",
      description: "Set a frontmatter property on a note (value may be string, number, boolean or list).",
      inputSchema: obj({ path: S.str("Note path or name"), key: S.str("Property name"), value: { description: "Value", type: ["string", "number", "boolean", "array", "null"] } }, ["path", "key", "value"]),
      annotations: rw,
      run: async (a) => brain.setProperty(needStr(a, "path"), needStr(a, "key"), a.value, src),
    },
    {
      name: "remove_property",
      description: "Remove a frontmatter property from a note.",
      inputSchema: obj({ path: S.str("Note path or name"), key: S.str("Property name") }, ["path", "key"]),
      annotations: rw,
      run: async (a) => brain.removeProperty(needStr(a, "path"), needStr(a, "key"), src),
    },
    {
      name: "daily_note",
      description: "Get today's (or a given date's) daily note, creating it if needed; optionally append text to it. Returns its path and content.",
      inputSchema: obj({ date: S.str("YYYY-MM-DD (default today)"), append: S.str("Optional text to append") }),
      annotations: rw,
      run: async (a) => {
        const ds = optStr(a, "date");
        const d = ds ? new Date(ds + "T12:00:00") : new Date();
        if (isNaN(d.getTime())) throw new HttpError(400, "Invalid date", "invalid");
        const { path } = await brain.daily(d, src);
        const text = optStr(a, "append");
        if (text) await brain.append(path, text, src);
        const n = await brain.read(path);
        return { path, date: formatDate(d, "YYYY-MM-DD"), etag: n.etag, content: n.content };
      },
    },
    {
      name: "list_unresolved_links",
      description: "Links that point to notes that do not exist yet, with counts and source notes.",
      inputSchema: obj({}),
      annotations: ro,
      run: async () => brain.index.unresolvedLinks(),
    },
    {
      name: "list_orphans",
      description: "Notes that no other note links to.",
      inputSchema: obj({}),
      annotations: ro,
      run: async () => brain.index.orphans(),
    },
    {
      name: "list_deadends",
      description: "Notes that have no outgoing links to existing notes.",
      inputSchema: obj({}),
      annotations: ro,
      run: async () => brain.index.deadends(),
    },
    {
      name: "list_templates",
      description: "Template notes available for create_note's template parameter.",
      inputSchema: obj({}),
      annotations: ro,
      run: async () => brain.templates(),
    },
  ];
}

interface RpcMsg {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
  result?: unknown;
  error?: unknown;
}

function rpcError(id: RpcMsg["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export class McpServer {
  tools: Tool[];
  private byName: Map<string, Tool>;

  constructor(brain: Brain) {
    this.tools = buildTools(brain);
    this.byName = new Map(this.tools.map((t) => [t.name, t]));
  }

  async handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req, 10 * 1024 * 1024)).toString("utf8"));
    } catch {
      sendJson(res, 400, rpcError(null, -32700, "Parse error"));
      return;
    }
    const batch = Array.isArray(body);
    const msgs = (batch ? body : [body]) as RpcMsg[];
    const out: unknown[] = [];
    for (const m of msgs) {
      const r = await this.dispatch(m);
      if (r) out.push(r);
    }
    if (out.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, batch ? out : out[0]);
  }

  private async dispatch(m: RpcMsg): Promise<unknown | null> {
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return rpcError(null, -32600, "Invalid Request");
    const isNotification = m.id === undefined;
    if (!m.method) return null; // a response from the client; ignore
    try {
      switch (m.method) {
        case "initialize": {
          const requested = String(m.params?.protocolVersion ?? "");
          const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
          return {
            jsonrpc: "2.0",
            id: m.id,
            result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS },
          };
        }
        case "ping":
          return isNotification ? null : { jsonrpc: "2.0", id: m.id, result: {} };
        case "tools/list":
          return {
            jsonrpc: "2.0",
            id: m.id,
            result: { tools: this.tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) },
          };
        case "tools/call": {
          const name = String(m.params?.name ?? "");
          const tool = this.byName.get(name);
          if (!tool) return rpcError(m.id, -32602, `Unknown tool: ${name}`);
          const args = (m.params?.arguments ?? {}) as Json;
          try {
            const value = await tool.run(args);
            const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
            return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }], isError: false } };
          } catch (e) {
            const msg = (e as Error).message ?? String(e);
            return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `Error: ${msg}` }], isError: true } };
          }
        }
        default:
          if (isNotification) return null; // notifications/initialized, cancelled, etc.
          return rpcError(m.id, -32601, `Method not found: ${m.method}`);
      }
    } catch (e) {
      return isNotification ? null : rpcError(m.id, -32603, (e as Error).message);
    }
  }
}
