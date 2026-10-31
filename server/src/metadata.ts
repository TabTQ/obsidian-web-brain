// In-memory metadata index: link resolution, backlinks, tags, properties, graph data.
// Resolution rules are designed to be compatible with Obsidian's link behavior.

import { basename, dirname, isMarkdown, naturalCompare, stem } from "./paths.js";
import { frontmatterAliases, frontmatterTags, parseNote, type LinkRef, type NoteMeta } from "./parser.js";
import type { FileStat } from "./vault.js";

export interface IndexedFile extends FileStat {
  md: boolean;
}

export interface Occurrence {
  source: string;
  line: number;
  original: string;
  context: string;
  embed: boolean;
  frontmatterKey?: string;
}

export type PropertyType = "text" | "number" | "checkbox" | "date" | "datetime" | "multitext" | "tags" | "aliases" | "unknown";

function depth(p: string) {
  return p.split("/").length;
}

/** Shortest path first (fewer segments, then shorter string), then alphabetical. */
function candidateOrder(a: IndexedFile, b: IndexedFile) {
  return depth(a.path) - depth(b.path) || a.path.length - b.path.length || naturalCompare(a.path, b.path);
}

export class MetadataIndex {
  files = new Map<string, IndexedFile>();
  folders = new Set<string>();
  meta = new Map<string, NoteMeta>();
  text = new Map<string, string>();
  private lookup = new Map<string, IndexedFile[]>();
  resolved = new Map<string, Map<string, number>>();
  unresolved = new Map<string, Map<string, number>>();

  // ---------- file set ----------

  setFile(stat: FileStat, content?: string) {
    const existed = this.files.has(stat.path);
    const f: IndexedFile = { ...stat, md: isMarkdown(stat.path) };
    this.files.set(stat.path, f);
    if (!existed) {
      const key = basename(stat.path).toLowerCase();
      const list = this.lookup.get(key) ?? [];
      list.push(f);
      this.lookup.set(key, list);
    } else {
      const list = this.lookup.get(basename(stat.path).toLowerCase())!;
      const i = list.findIndex((x) => x.path === stat.path);
      list[i] = f;
    }
    let d = dirname(stat.path);
    while (d) {
      this.folders.add(d);
      d = dirname(d);
    }
    if (f.md && content !== undefined) {
      this.text.set(stat.path, content);
      this.meta.set(stat.path, parseNote(content));
    }
    return !existed;
  }

  removeFile(p: string) {
    const f = this.files.get(p);
    if (!f) return false;
    this.files.delete(p);
    const key = basename(p).toLowerCase();
    const list = (this.lookup.get(key) ?? []).filter((x) => x.path !== p);
    if (list.length) this.lookup.set(key, list);
    else this.lookup.delete(key);
    this.meta.delete(p);
    this.text.delete(p);
    this.resolved.delete(p);
    this.unresolved.delete(p);
    return true;
  }

  removeFolder(p: string) {
    for (const f of [...this.files.keys()]) if (f.startsWith(p + "/")) this.removeFile(f);
    for (const d of [...this.folders]) if (d === p || d.startsWith(p + "/")) this.folders.delete(d);
  }

  // ---------- link resolution ----------

  /**
   * Candidates for a link path from a source note, best first.
   * Compatible with how Obsidian resolves link paths.
   */
  resolveAll(linkpath: string, sourcePath: string): IndexedFile[] {
    if (linkpath === "") {
      const self = this.files.get(sourcePath);
      return self ? [self] : [];
    }
    let o = linkpath.toLowerCase();
    let key = basename(o);
    let candidates: IndexedFile[] | undefined;
    if (key.includes(".")) candidates = this.lookup.get(key);
    if (!candidates) {
      o = (linkpath + ".md").toLowerCase();
      key = basename(o);
      candidates = this.lookup.get(key);
    }
    if (!candidates || candidates.length === 0) return [];
    if (key === o && candidates.length === 1) return [candidates[0]];

    let srcDir = dirname(sourcePath).toLowerCase();
    if (o.startsWith("./") || o.startsWith("../")) {
      if (o.startsWith("./../")) o = o.slice(2);
      if (o.startsWith("./")) o = (srcDir ? srcDir + "/" : "") + o.slice(2);
      else {
        while (o.startsWith("../")) {
          o = o.slice(3);
          srcDir = dirname(srcDir);
        }
        o = (srcDir ? srcDir + "/" : "") + o;
      }
      for (const c of candidates) if (c.path.toLowerCase() === o) return [c];
    }
    if (o.startsWith("/")) o = o.slice(1);
    for (const c of candidates) if (c.path.toLowerCase() === o) return [c];
    if (linkpath.startsWith("/")) return [];

    const near: IndexedFile[] = [];
    const far: IndexedFile[] = [];
    const prefix = dirname(sourcePath).toLowerCase();
    for (const c of candidates) {
      const lp = c.path.toLowerCase();
      if (lp === o || lp.endsWith("/" + o)) {
        if (prefix === "" || lp.startsWith(prefix + "/")) near.push(c);
        else far.push(c);
      }
    }
    near.sort(candidateOrder);
    far.sort(candidateOrder);
    return near.concat(far);
  }

  resolve(linkpath: string, sourcePath: string): IndexedFile | null {
    return this.resolveAll(linkpath, sourcePath)[0] ?? null;
  }

  /** Link text for `target` using the "shortest" format (as Obsidian's default). */
  linktextFor(targetPath: string, _sourcePath: string): string {
    const f = this.files.get(targetPath);
    const name = f?.md ? targetPath.replace(/\.md$/i, "") : targetPath;
    const sameName = this.lookup.get(basename(targetPath).toLowerCase()) ?? [];
    if (sameName.length <= 1) return f?.md ? stem(targetPath) : basename(targetPath);
    return name;
  }

  /** Recompute resolved/unresolved link maps for one note. */
  computeLinks(p: string) {
    const meta = this.meta.get(p);
    const res = new Map<string, number>();
    const unres = new Map<string, number>();
    if (meta) {
      const refs: { link: string }[] = [...meta.links, ...meta.embeds, ...meta.frontmatterLinks];
      for (const r of refs) {
        if (r.link === "") continue; // self-references (#heading)
        const t = this.resolve(r.link, p);
        if (t) res.set(t.path, (res.get(t.path) ?? 0) + 1);
        else unres.set(r.link, (unres.get(r.link) ?? 0) + 1);
      }
    }
    this.resolved.set(p, res);
    this.unresolved.set(p, unres);
  }

  computeAllLinks() {
    for (const p of this.meta.keys()) this.computeLinks(p);
  }

  // ---------- queries ----------

  backlinks(target: string): Occurrence[] {
    const out: Occurrence[] = [];
    for (const [src, targets] of this.resolved) {
      if (!targets.has(target)) continue;
      const meta = this.meta.get(src);
      const text = this.text.get(src) ?? "";
      const lines = text.split("\n");
      if (!meta) continue;
      for (const r of [...meta.links, ...meta.embeds]) {
        if (r.link === "" ) continue;
        if (this.resolve(r.link, src)?.path !== target) continue;
        out.push({ source: src, line: r.pos.line, original: r.original, context: lines[r.pos.line] ?? "", embed: r.embed });
      }
      for (const r of meta.frontmatterLinks) {
        if (this.resolve(r.link, src)?.path !== target) continue;
        out.push({ source: src, line: r.pos.line, original: r.original, context: lines[r.pos.line] ?? "", embed: false, frontmatterKey: r.key });
      }
    }
    out.sort((a, b) => naturalCompare(a.source, b.source) || a.line - b.line);
    return out;
  }

  outgoing(source: string): { link: string; subpath: string; original: string; line: number; embed: boolean; resolved: string | null }[] {
    const meta = this.meta.get(source);
    if (!meta) return [];
    const refs: Array<LinkRef | (NoteMeta["frontmatterLinks"][number] & { embed?: boolean })> = [...meta.links, ...meta.embeds, ...meta.frontmatterLinks];
    return refs.map((r) => ({
      link: r.link,
      subpath: r.subpath,
      original: r.original,
      line: r.pos.line,
      embed: "embed" in r ? !!r.embed : false,
      resolved: r.link === "" ? source : this.resolve(r.link, source)?.path ?? null,
    }));
  }

  unresolvedLinks(): { link: string; count: number; sources: string[] }[] {
    const agg = new Map<string, { count: number; sources: string[] }>();
    for (const [src, m] of this.unresolved) {
      for (const [link, count] of m) {
        const e = agg.get(link) ?? { count: 0, sources: [] };
        e.count += count;
        e.sources.push(src);
        agg.set(link, e);
      }
    }
    return [...agg.entries()].map(([link, v]) => ({ link, ...v })).sort((a, b) => naturalCompare(a.link, b.link));
  }

  /** Files never targeted by a resolved link (markdown only unless all). */
  orphans(all = false): string[] {
    const targeted = new Set<string>();
    for (const m of this.resolved.values()) for (const t of m.keys()) targeted.add(t);
    return [...this.files.values()].filter((f) => (all || f.md) && !targeted.has(f.path)).map((f) => f.path).sort(naturalCompare);
  }

  /** Files with no resolved outgoing links. */
  deadends(all = false): string[] {
    return [...this.files.values()]
      .filter((f) => (all || f.md) && !((this.resolved.get(f.path)?.size ?? 0) > 0))
      .map((f) => f.path)
      .sort(naturalCompare);
  }

  /** All tags of a note: frontmatter + inline, with leading "#". */
  noteTags(p: string): string[] {
    const meta = this.meta.get(p);
    if (!meta) return [];
    return [...frontmatterTags(meta.frontmatter), ...meta.tags.map((t) => t.tag)];
  }

  /** Tag counts; nested tags also count their parents (Obsidian-compatible). */
  tagCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const p of this.meta.keys()) {
      for (const tag of this.noteTags(p)) {
        const parts = tag.slice(1).split("/");
        for (let i = parts.length; i >= 1; i--) {
          const t = "#" + parts.slice(0, i).join("/");
          const key = Object.keys(counts).find((k) => k.toLowerCase() === t.toLowerCase()) ?? t;
          counts[key] = (counts[key] ?? 0) + 1;
        }
      }
    }
    return counts;
  }

  notesWithTag(tag: string): string[] {
    const t = ("#" + tag.replace(/^#/, "")).toLowerCase();
    return [...this.meta.keys()]
      .filter((p) => this.noteTags(p).some((x) => x.toLowerCase() === t || x.toLowerCase().startsWith(t + "/")))
      .sort(naturalCompare);
  }

  aliases(p: string): string[] {
    return frontmatterAliases(this.meta.get(p)?.frontmatter ?? null);
  }

  static inferType(key: string, v: unknown): PropertyType {
    const k = key.toLowerCase();
    if (k === "tags" || k === "tag") return "tags";
    if (k === "aliases" || k === "alias") return "aliases";
    if (Array.isArray(v)) return "multitext";
    if (typeof v === "boolean") return "checkbox";
    if (typeof v === "number") return "number";
    if (v instanceof Date) return "date";
    if (typeof v === "string") {
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return "date";
      if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return "datetime";
      return "text";
    }
    return "unknown";
  }

  /** Property names across the vault with inferred type and usage count. */
  properties(): { name: string; type: PropertyType; count: number }[] {
    const agg = new Map<string, { type: PropertyType; count: number }>();
    for (const m of this.meta.values()) {
      if (!m.frontmatter) continue;
      for (const [k, v] of Object.entries(m.frontmatter)) {
        const e = agg.get(k);
        if (e) e.count++;
        else agg.set(k, { type: MetadataIndex.inferType(k, v), count: 1 });
      }
    }
    return [...agg.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => naturalCompare(a.name, b.name));
  }

  propertyValues(key: string): unknown[] {
    const seen = new Map<string, unknown>();
    for (const m of this.meta.values()) {
      const v = m.frontmatter?.[key];
      if (v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [v]) seen.set(JSON.stringify(x), x);
    }
    return [...seen.values()];
  }

  /** Graph data for the graph view. */
  graph(opts: { showTags?: boolean; showAttachments?: boolean; hideUnresolved?: boolean; showOrphans?: boolean }) {
    type Node = { id: string; type: "note" | "attachment" | "tag" | "unresolved"; label: string };
    const nodes = new Map<string, Node>();
    const links: { source: string; target: string }[] = [];
    const edge = new Set<string>();
    const addEdge = (a: string, b: string) => {
      if (a === b) return;
      const k = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
      if (edge.has(k)) return;
      edge.add(k);
      links.push({ source: a, target: b });
    };
    for (const f of this.files.values()) {
      if (f.md) nodes.set(f.path, { id: f.path, type: "note", label: stem(f.path) });
      else if (opts.showAttachments) nodes.set(f.path, { id: f.path, type: "attachment", label: basename(f.path) });
    }
    for (const [src, targets] of this.resolved) {
      for (const t of targets.keys()) {
        if (!nodes.has(t)) continue;
        addEdge(src, t);
      }
    }
    if (!opts.hideUnresolved) {
      for (const [src, m] of this.unresolved) {
        for (const link of m.keys()) {
          const id = "unresolved:" + link.toLowerCase();
          if (!nodes.has(id)) nodes.set(id, { id, type: "unresolved", label: link });
          addEdge(src, id);
        }
      }
    }
    if (opts.showTags) {
      for (const p of this.meta.keys()) {
        for (const tag of this.noteTags(p)) {
          const id = "tag:" + tag.toLowerCase();
          if (!nodes.has(id)) nodes.set(id, { id, type: "tag", label: tag });
          addEdge(p, id);
        }
      }
    }
    // weight = number of distinct neighbors (Obsidian-compatible)
    const weight = new Map<string, number>();
    for (const l of links) {
      weight.set(l.source, (weight.get(l.source) ?? 0) + 1);
      weight.set(l.target, (weight.get(l.target) ?? 0) + 1);
    }
    let list = [...nodes.values()].map((n) => ({ ...n, weight: weight.get(n.id) ?? 0 }));
    if (opts.showOrphans === false) list = list.filter((n) => n.weight > 0);
    const ids = new Set(list.map((n) => n.id));
    return { nodes: list, links: links.filter((l) => ids.has(l.source) && ids.has(l.target)) };
  }
}
