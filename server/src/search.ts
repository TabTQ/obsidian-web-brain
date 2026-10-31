// Vault search with Obsidian-compatible query operators (Obsidian-compatible subset).
// Unsupported in Obsidian and therefore here too: "case:" and trailing "*" wildcards.

import { basename, naturalCompare } from "./paths.js";
import type { MetadataIndex } from "./metadata.js";

type Node =
  | { t: "and"; c: Node[] }
  | { t: "or"; c: Node[] }
  | { t: "not"; c: Node }
  | { t: "term"; v: string }
  | { t: "regex"; re: RegExp; src: string }
  | { t: "op"; name: string; c: Node }
  | { t: "prop"; key: string; value: Node | null };

const OPS = new Set([
  "file", "path", "content", "tag", "line", "section", "block", "task", "task-todo", "task-done", "match-case", "ignore-case",
]);

export class QueryError extends Error {
  status = 400;
}

// ---------- tokenizer / parser ----------

class Parser {
  i = 0;
  constructor(private s: string) {}

  parse(): Node {
    const n = this.parseOr(false);
    this.ws();
    if (this.i < this.s.length) throw new QueryError(`Unexpected "${this.s[this.i]}" at ${this.i}`);
    return n;
  }

  private ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  private peekWord(w: string) {
    return this.s.startsWith(w, this.i) && (this.i + w.length >= this.s.length || /[\s()]/.test(this.s[this.i + w.length]));
  }

  private parseOr(inGroup: boolean): Node {
    const alts: Node[] = [this.parseAnd(inGroup)];
    for (;;) {
      this.ws();
      if (this.peekWord("OR")) {
        this.i += 2;
        alts.push(this.parseAnd(inGroup));
      } else break;
    }
    return alts.length === 1 ? alts[0] : { t: "or", c: alts };
  }

  private parseAnd(inGroup: boolean): Node {
    const items: Node[] = [];
    for (;;) {
      this.ws();
      if (this.i >= this.s.length) break;
      if (this.s[this.i] === ")") {
        if (!inGroup) throw new QueryError("Unbalanced )");
        break;
      }
      if (this.peekWord("OR")) break;
      items.push(this.parseUnary());
    }
    if (items.length === 0) return { t: "and", c: [] };
    return items.length === 1 ? items[0] : { t: "and", c: items };
  }

  private parseUnary(): Node {
    if (this.s[this.i] === "-" && this.i + 1 < this.s.length && !/\s/.test(this.s[this.i + 1])) {
      this.i++;
      return { t: "not", c: this.parseUnary() };
    }
    return this.parseAtom();
  }

  private parseAtom(): Node {
    const ch = this.s[this.i];
    if (ch === "(") {
      this.i++;
      const n = this.parseOr(true);
      this.ws();
      if (this.s[this.i] !== ")") throw new QueryError("Missing )");
      this.i++;
      return n;
    }
    if (ch === '"') return { t: "term", v: this.readQuoted() };
    if (ch === "/") {
      const end = this.findRegexEnd();
      if (end > this.i) {
        const src = this.s.slice(this.i + 1, end);
        this.i = end + 1;
        try {
          return { t: "regex", re: new RegExp(src, "m"), src };
        } catch (e) {
          throw new QueryError(`Invalid regex /${src}/: ${(e as Error).message}`);
        }
      }
    }
    if (ch === "[") {
      const end = this.s.indexOf("]", this.i);
      if (end !== -1) {
        const inner = this.s.slice(this.i + 1, end);
        this.i = end + 1;
        const colon = inner.indexOf(":");
        if (colon === -1) return { t: "prop", key: inner.trim(), value: null };
        const key = inner.slice(0, colon).trim();
        const valueSrc = inner.slice(colon + 1).trim();
        const value = valueSrc === "" ? null : new Parser(valueSrc).parse();
        return { t: "prop", key, value };
      }
    }
    // operator?
    const m = this.s.slice(this.i).match(/^([a-z-]+):/);
    if (m && OPS.has(m[1])) {
      this.i += m[0].length;
      if (this.i >= this.s.length || /\s/.test(this.s[this.i])) return { t: "op", name: m[1], c: { t: "and", c: [] } };
      return { t: "op", name: m[1], c: this.parseAtom() };
    }
    // bare word
    const start = this.i;
    while (this.i < this.s.length && !/[\s()]/.test(this.s[this.i])) this.i++;
    return { t: "term", v: this.s.slice(start, this.i) };
  }

  private readQuoted(): string {
    this.i++;
    let out = "";
    while (this.i < this.s.length && this.s[this.i] !== '"') {
      if (this.s[this.i] === "\\" && this.i + 1 < this.s.length) {
        out += this.s[this.i + 1];
        this.i += 2;
      } else out += this.s[this.i++];
    }
    this.i++;
    return out;
  }

  private findRegexEnd(): number {
    for (let j = this.i + 1; j < this.s.length; j++) {
      if (this.s[j] === "\\") j++;
      else if (this.s[j] === "/") return j;
    }
    return -1;
  }
}

export function parseQuery(q: string): Node {
  return new Parser(q.trim()).parse();
}

// ---------- evaluation ----------

interface Scope {
  text: string; // haystack text
  name: string; // file-name haystack ("" when not applicable)
  caseSensitive: boolean;
  note: NoteCtx;
}

interface NoteCtx {
  path: string;
  content: string;
  lines: string[];
  tags: string[];
  frontmatter: Record<string, unknown> | null;
  sections: string[];
  blocks: string[];
  tasks: { status: string; text: string }[];
}

function contains(hay: string, needle: string, cs: boolean) {
  if (needle === "") return true;
  return cs ? hay.includes(needle) : hay.toLowerCase().includes(needle.toLowerCase());
}

function evalNode(n: Node, s: Scope): boolean {
  switch (n.t) {
    case "and":
      return n.c.every((c) => evalNode(c, s));
    case "or":
      return n.c.some((c) => evalNode(c, s));
    case "not":
      return !evalNode(n.c, s);
    case "term":
      return contains(s.text, n.v, s.caseSensitive) || (s.name !== "" && contains(s.name, n.v, s.caseSensitive));
    case "regex": {
      const re = s.caseSensitive || n.re.flags.includes("i") ? n.re : new RegExp(n.re.source, n.re.flags + "i");
      return re.test(s.text) || (s.name !== "" && re.test(s.name));
    }
    case "prop": {
      const fm = s.note.frontmatter;
      if (!fm) return false;
      const key = Object.keys(fm).find((k) => k.toLowerCase() === n.key.toLowerCase());
      if (key === undefined) return false;
      if (!n.value) return true;
      const v = fm[key];
      const vals = Array.isArray(v) ? v : [v];
      return vals.some((x) => evalNode(n.value!, { ...s, text: x === null ? "" : String(x), name: "" }));
    }
    case "op":
      return evalOp(n.name, n.c, s);
  }
}

function evalOp(name: string, c: Node, s: Scope): boolean {
  const note = s.note;
  const sub = (text: string) => ({ ...s, text, name: "" });
  switch (name) {
    case "file":
      return evalNode(c, { ...s, text: basename(note.path), name: "" });
    case "path":
      return evalNode(c, { ...s, text: note.path, name: "" });
    case "content":
      return evalNode(c, sub(note.content));
    case "tag": {
      return note.tags.some((t) => {
        const tag = t.toLowerCase();
        return termsOf(c).every((needle) => {
          const nd = ("#" + needle.replace(/^#/, "")).toLowerCase();
          return tag === nd || tag.startsWith(nd + "/");
        });
      });
    }
    case "line":
      return note.lines.some((l) => evalNode(c, sub(l)));
    case "section":
      return note.sections.some((x) => evalNode(c, sub(x)));
    case "block":
      return note.blocks.some((x) => evalNode(c, sub(x)));
    case "task":
      return note.tasks.some((t) => evalNode(c, sub(t.text)));
    case "task-todo":
      return note.tasks.some((t) => t.status === " " && evalNode(c, sub(t.text)));
    case "task-done":
      return note.tasks.some((t) => t.status !== " " && evalNode(c, sub(t.text)));
    case "match-case":
      return evalNode(c, { ...s, caseSensitive: true });
    case "ignore-case":
      return evalNode(c, { ...s, caseSensitive: false });
  }
  return false;
}

function termsOf(n: Node): string[] {
  if (n.t === "term") return [n.v];
  if (n.t === "and" || n.t === "or") return n.c.flatMap(termsOf);
  return [];
}

/** Positive needles (for highlighting matching lines). */
function positiveNeedles(n: Node, neg = false, out: { text?: string; re?: RegExp; cs: boolean }[] = [], cs = false) {
  switch (n.t) {
    case "and":
    case "or":
      n.c.forEach((c) => positiveNeedles(c, neg, out, cs));
      break;
    case "not":
      positiveNeedles(n.c, !neg, out, cs);
      break;
    case "term":
      if (!neg && n.v) out.push({ text: n.v, cs });
      break;
    case "regex":
      if (!neg) out.push({ re: n.re, cs });
      break;
    case "op":
      if (["content", "line", "section", "block", "task", "task-todo", "task-done"].includes(n.name)) positiveNeedles(n.c, neg, out, cs);
      else if (n.name === "match-case") positiveNeedles(n.c, neg, out, true);
      else if (n.name === "ignore-case") positiveNeedles(n.c, neg, out, false);
      break;
  }
  return out;
}

function splitSections(lines: string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (/^#{1,6}\s/.test(l) && cur.length) {
      out.push(cur.join("\n"));
      cur = [];
    }
    cur.push(l);
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

function splitBlocks(content: string): string[] {
  return content.split(/\n\s*\n/).filter((b) => b.trim() !== "");
}

export interface SearchMatch {
  line: number;
  text: string;
  ranges: [number, number][];
}

export interface SearchResult {
  path: string;
  matches: SearchMatch[];
  /** true if the file name itself matched */
  nameMatch: boolean;
}

export function search(index: MetadataIndex, query: string, opts: { limit?: number; contextLines?: number; caseSensitive?: boolean } = {}): SearchResult[] {
  const q = query.trim();
  if (!q) return [];
  const ast = parseQuery(q);
  const needles = positiveNeedles(ast);
  const results: SearchResult[] = [];
  const limit = opts.limit ?? 200;
  const files = [...index.files.values()].sort((a, b) => naturalCompare(a.path, b.path));
  for (const f of files) {
    const content = f.md ? index.text.get(f.path) ?? "" : "";
    const meta = index.meta.get(f.path);
    const lines = content.split("\n");
    const note: NoteCtx = {
      path: f.path,
      content,
      lines,
      tags: index.noteTags(f.path),
      frontmatter: meta?.frontmatter ?? null,
      sections: splitSections(lines),
      blocks: splitBlocks(content),
      tasks: meta?.tasks ?? [],
    };
    const name = f.md ? basename(f.path).replace(/\.md$/i, "") : basename(f.path);
    const scope: Scope = { text: content, name, caseSensitive: !!opts.caseSensitive, note };
    if (!evalNode(ast, scope)) continue;
    const matches: SearchMatch[] = [];
    let nameMatch = false;
    for (const nd of needles) {
      const cs = nd.cs || !!opts.caseSensitive;
      if (nd.text && contains(name, nd.text, cs)) nameMatch = true;
    }
    if (needles.length) {
      for (let i = 0; i < lines.length && matches.length < 20; i++) {
        const ranges: [number, number][] = [];
        for (const nd of needles) {
          const cs = nd.cs || !!opts.caseSensitive;
          if (nd.text) {
            const hay = cs ? lines[i] : lines[i].toLowerCase();
            const needle = cs ? nd.text : nd.text.toLowerCase();
            let idx = hay.indexOf(needle);
            while (idx !== -1 && needle) {
              ranges.push([idx, idx + needle.length]);
              idx = hay.indexOf(needle, idx + needle.length);
            }
          } else if (nd.re) {
            const re = new RegExp(nd.re.source, "g" + (cs ? "" : "i"));
            let m: RegExpExecArray | null;
            while ((m = re.exec(lines[i])) && m[0] !== "") ranges.push([m.index, m.index + m[0].length]);
          }
        }
        if (ranges.length) matches.push({ line: i, text: lines[i], ranges: ranges.sort((a, b) => a[0] - b[0]) });
      }
    }
    results.push({ path: f.path, matches, nameMatch });
    if (results.length >= limit) break;
  }
  return results;
}

// ---------- fuzzy scoring (quick switcher), behavior per traced prepareFuzzySearch ----------

export function fuzzyScore(query: string, text: string): { score: number; ranges: [number, number][] } | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  if (!q) return { score: 0, ranges: [] };
  const ranges: [number, number][] = [];
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx === -1) return null;
    if (ranges.length && ranges[ranges.length - 1][1] === idx) ranges[ranges.length - 1][1] = idx + 1;
    else ranges.push([idx, idx + 1]);
    ti = idx + 1;
  }
  // Penalties: gaps, spread beyond query length, late start, long text.
  const gaps = ranges.length - 1;
  const spread = ranges[ranges.length - 1][1] - ranges[0][0] - q.length;
  const score = -gaps - spread / 10 - ranges[0][0] / 100 - text.length / 1000;
  return { score, ranges };
}
