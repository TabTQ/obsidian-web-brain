// Service layer shared by the web API and MCP: notes CRUD, rename with link
// rewriting, properties, daily notes, templates, attachments, change events.

import { EventEmitter } from "node:events";
import { Document, isMap, parseDocument } from "yaml";
import { applyTemplate, formatDate, parseDate } from "./dates.js";
import { MetadataIndex } from "./metadata.js";
import { basename, dirname, extname, isHidden, isMarkdown, naturalCompare, safeVaultPath, stem } from "./paths.js";
import { parseFrontmatter } from "./parser.js";
import { search, type SearchResult } from "./search.js";
import { etagOf, HttpError, Vault, type ChangeSource } from "./vault.js";

export interface VaultSettings {
  dailyFolder: string;
  dailyFormat: string;
  dailyTemplate: string;
  templatesFolder: string;
  attachmentFolder: string;
  newNoteFolder: string;
}

export const DEFAULT_SETTINGS: VaultSettings = {
  dailyFolder: "",
  dailyFormat: "YYYY-MM-DD",
  dailyTemplate: "",
  templatesFolder: "Templates",
  attachmentFolder: "",
  newNoteFolder: "",
};

export interface BrainEvent {
  type: "change" | "delete" | "rename" | "folder" | "reload";
  path?: string;
  from?: string;
  to?: string;
  etag?: string;
  source?: ChangeSource;
}

export class Brain extends EventEmitter {
  index = new MetadataIndex();
  /** Serializes mutating operations so link rewrites never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(public vault: Vault, public getSettings: () => VaultSettings) {
    super();
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---------- loading & external changes ----------

  async load() {
    const { files, folders } = await this.vault.list();
    this.index = new MetadataIndex();
    for (const d of folders) this.index.folders.add(d);
    for (const f of files) {
      const content = isMarkdown(f.path) ? (await this.vault.readText(f.path)).content : undefined;
      this.index.setFile(f, content);
    }
    this.index.computeAllLinks();
    this.vault.on("externalChange", (p: string, source: ChangeSource) => void this.exclusive(() => this.onExternalChange(p, source)));
    this.vault.on("externalDelete", (p: string, source: ChangeSource) => void this.exclusive(() => this.onExternalDelete(p, source)));
    this.vault.on("externalFolder", (p: string) => {
      this.index.folders.add(p);
      this.emitEvent({ type: "folder", path: p });
    });
  }

  /** Full rescan, used after git operations replace many files at once. */
  async rescan(source: ChangeSource = "git") {
    return this.exclusive(async () => {
      const { files, folders } = await this.vault.list();
      const seen = new Set<string>();
      for (const f of files) {
        seen.add(f.path);
        const prev = this.index.files.get(f.path);
        if (prev && prev.mtime === f.mtime && prev.size === f.size) continue;
        const content = isMarkdown(f.path) ? (await this.vault.readText(f.path)).content : undefined;
        this.index.setFile(f, content);
        this.emit("changed", f.path, source);
      }
      for (const p of [...this.index.files.keys()]) {
        if (!seen.has(p)) {
          this.index.removeFile(p);
          this.emit("deleted", p, source);
        }
      }
      this.index.folders = new Set(folders);
      this.index.computeAllLinks();
      this.emitEvent({ type: "reload", source });
    });
  }

  private async onExternalChange(p: string, source: ChangeSource) {
    const st = await this.vault.stat(p);
    if (!st) return;
    const isNew = !this.index.files.has(p);
    const content = isMarkdown(p) ? (await this.vault.readText(p)).content : undefined;
    this.index.setFile(st, content);
    if (isNew) this.index.computeAllLinks();
    else if (isMarkdown(p)) this.index.computeLinks(p);
    this.emitEvent({ type: "change", path: p, etag: content !== undefined ? etagOf(content) : undefined, source });
    this.emit("changed", p, source);
  }

  private async onExternalDelete(p: string, source: ChangeSource) {
    if (this.index.files.has(p)) {
      this.index.removeFile(p);
      this.index.computeAllLinks();
      this.emitEvent({ type: "delete", path: p, source });
      this.emit("deleted", p, source);
    } else if (this.index.folders.has(p)) {
      this.index.removeFolder(p);
      this.index.computeAllLinks();
      this.emitEvent({ type: "folder", path: p, source });
    }
  }

  emitEvent(e: BrainEvent) {
    this.emit("event", e);
  }

  // ---------- reads ----------

  tree() {
    const files = [...this.index.files.values()].map((f) => ({ path: f.path, size: f.size, mtime: f.mtime, ctime: f.ctime }));
    return { files: files.sort((a, b) => naturalCompare(a.path, b.path)), folders: [...this.index.folders].sort(naturalCompare) };
  }

  async read(p: string) {
    const rel = this.resolvePathArg(p);
    const f = this.index.files.get(rel);
    if (!f) throw new HttpError(404, `Note not found: ${p}`, "not_found");
    if (!f.md) throw new HttpError(400, `Not a markdown note: ${rel}`, "not_markdown");
    const { content, etag } = await this.vault.readText(rel);
    return { path: rel, content, etag, mtime: f.mtime, ctime: f.ctime, size: f.size };
  }

  /** Accept exact path, path without .md, or a link-style name. */
  resolvePathArg(p: string, from = ""): string {
    const rel = safeVaultPath(p);
    if (this.index.files.has(rel)) return rel;
    if (this.index.files.has(rel + ".md")) return rel + ".md";
    const r = this.index.resolve(p.replace(/\.md$/i, ""), from);
    return r ? r.path : rel;
  }

  meta(p: string) {
    const rel = this.resolvePathArg(p);
    const m = this.index.meta.get(rel);
    if (!m) throw new HttpError(404, `Note not found: ${p}`, "not_found");
    return {
      path: rel,
      frontmatter: m.frontmatter,
      frontmatterError: m.frontmatterError,
      headings: m.headings.map((h) => ({ heading: h.heading, level: h.level, line: h.pos.line })),
      tags: this.index.noteTags(rel),
      aliases: this.index.aliases(rel),
      tasks: m.tasks,
      blocks: m.blocks,
    };
  }

  backlinks(p: string) {
    return this.index.backlinks(this.resolvePathArg(p));
  }

  outgoing(p: string) {
    return this.index.outgoing(this.resolvePathArg(p));
  }

  search(q: string, opts?: { limit?: number }): SearchResult[] {
    return search(this.index, q, opts);
  }

  /** Resolve a link from a source note (for the web UI). */
  resolveLink(link: string, source: string) {
    const f = this.index.resolve(link, source);
    return f ? f.path : null;
  }

  // ---------- writes ----------

  private mustBeNotePath(p: string): string {
    let rel = safeVaultPath(p);
    if (!rel) throw new HttpError(400, "Path is required", "invalid_path");
    if (isHidden(rel)) throw new HttpError(400, "Hidden paths are not allowed", "invalid_path");
    if (!extname(rel)) rel += ".md";
    return rel;
  }

  private async afterWrite(rel: string, content: string | undefined, source: ChangeSource, etag?: string) {
    const st = await this.vault.stat(rel);
    if (!st) return;
    const isNew = this.index.setFile(st, content);
    if (isNew) this.index.computeAllLinks();
    else if (content !== undefined) this.index.computeLinks(rel);
    this.emitEvent({ type: "change", path: rel, etag, source });
    this.emit("changed", rel, source);
  }

  async write(p: string, content: string, opts: { ifMatch?: string | null; source: ChangeSource; create?: boolean }) {
    return this.exclusive(async () => {
      const rel = this.mustBeNotePath(p);
      const r = await this.vault.writeText(rel, content, { ifMatch: opts.ifMatch, mustNotExist: opts.create, source: opts.source });
      await this.afterWrite(rel, isMarkdown(rel) ? content : undefined, opts.source, r.etag);
      return { path: rel, etag: r.etag, created: r.created };
    });
  }

  async create(p: string | undefined, content: string, source: ChangeSource) {
    const s = this.getSettings();
    let rel: string;
    if (p) rel = this.mustBeNotePath(p);
    else rel = this.availablePath(s.newNoteFolder, "Untitled", "md");
    if (this.index.files.has(rel)) throw new HttpError(409, `Note already exists: ${rel}`, "exists");
    return this.write(rel, content, { source, create: true });
  }

  availablePath(folder: string, name: string, ext: string): string {
    const dir = folder ? safeVaultPath(folder) + "/" : "";
    let candidate = `${dir}${name}.${ext}`;
    for (let i = 1; this.index.files.has(candidate) || this.index.folders.has(candidate); i++) candidate = `${dir}${name} ${i}.${ext}`;
    return candidate;
  }

  async append(p: string, text: string, source: ChangeSource, create = true) {
    return this.exclusive(async () => {
      const rel = this.mustBeNotePath(this.resolvePathArg(p));
      let current = "";
      let etag: string | null = null;
      if (this.index.files.has(rel)) ({ content: current, etag } = await this.vault.readText(rel));
      else if (!create) throw new HttpError(404, `Note not found: ${p}`, "not_found");
      const sep = current === "" || current.endsWith("\n") ? "" : "\n";
      const next = current + sep + text + (text.endsWith("\n") ? "" : "\n");
      const r = await this.vault.writeText(rel, next, { ifMatch: etag, source });
      await this.afterWrite(rel, next, source, r.etag);
      return { path: rel, etag: r.etag };
    });
  }

  async prepend(p: string, text: string, source: ChangeSource, create = true) {
    return this.exclusive(async () => {
      const rel = this.mustBeNotePath(this.resolvePathArg(p));
      let current = "";
      let etag: string | null = null;
      if (this.index.files.has(rel)) ({ content: current, etag } = await this.vault.readText(rel));
      else if (!create) throw new HttpError(404, `Note not found: ${p}`, "not_found");
      const fm = parseFrontmatter(current);
      const head = current.slice(0, fm.end);
      const body = current.slice(fm.end);
      const insert = text.endsWith("\n") ? text : text + "\n";
      const next = head + insert + body;
      const r = await this.vault.writeText(rel, next, { ifMatch: etag, source });
      await this.afterWrite(rel, next, source, r.etag);
      return { path: rel, etag: r.etag };
    });
  }

  /** Replace an exact, unique substring (safe targeted edit for agents). */
  async replaceText(p: string, oldText: string, newText: string, opts: { ifMatch?: string; replaceAll?: boolean; source: ChangeSource }) {
    return this.exclusive(async () => {
      const rel = this.resolvePathArg(p);
      const { content, etag } = await this.vault.readText(rel);
      if (opts.ifMatch && opts.ifMatch !== etag) throw new HttpError(409, `Stale write rejected: "${rel}" changed since you read it. Re-read and retry.`, "stale");
      if (!oldText) throw new HttpError(400, "old_text must not be empty", "invalid");
      const count = content.split(oldText).length - 1;
      if (count === 0) throw new HttpError(400, `old_text not found in ${rel}`, "not_found_text");
      if (count > 1 && !opts.replaceAll) throw new HttpError(400, `old_text occurs ${count} times in ${rel}; make it unique or set replace_all`, "ambiguous");
      const next = opts.replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, () => newText);
      const r = await this.vault.writeText(rel, next, { ifMatch: etag, source: opts.source });
      await this.afterWrite(rel, next, opts.source, r.etag);
      return { path: rel, etag: r.etag, replacements: opts.replaceAll ? count : 1 };
    });
  }

  /** Replace lines [from, to] (1-based, inclusive). */
  async replaceLines(p: string, from: number, to: number, text: string, opts: { ifMatch?: string; source: ChangeSource }) {
    return this.exclusive(async () => {
      const rel = this.resolvePathArg(p);
      const { content, etag } = await this.vault.readText(rel);
      if (opts.ifMatch && opts.ifMatch !== etag) throw new HttpError(409, `Stale write rejected: "${rel}" changed since you read it. Re-read and retry.`, "stale");
      const lines = content.split("\n");
      if (from < 1 || from > lines.length) throw new HttpError(400, `Line ${from} is out of range (file has ${lines.length} lines).`, "range");
      if (to < from || to > lines.length) throw new HttpError(400, `Line ${to} is out of range (file has ${lines.length} lines).`, "range");
      lines.splice(from - 1, to - from + 1, ...text.split("\n"));
      const next = lines.join("\n");
      const r = await this.vault.writeText(rel, next, { ifMatch: etag, source: opts.source });
      await this.afterWrite(rel, next, opts.source, r.etag);
      return { path: rel, etag: r.etag };
    });
  }

  async uploadAttachment(name: string, data: Buffer, source: ChangeSource, forNote?: string) {
    return this.exclusive(async () => {
      const s = this.getSettings();
      const clean = basename(name).replace(/[\\/:*?"<>|#^[\]]/g, " ").trim() || "attachment";
      const ext = extname(clean) || "bin";
      let folder = s.attachmentFolder;
      if (folder.startsWith("./") && forNote) folder = dirname(forNote) + folder.slice(1);
      const rel = this.availablePath(folder.replace(/^\/+|\/+$/g, ""), stem(clean), ext);
      await this.vault.writeBinary(rel, data, source);
      await this.afterWrite(rel, undefined, source);
      return { path: rel, link: this.index.linktextFor(rel, forNote ?? "") };
    });
  }

  async writeAttachment(p: string, data: Buffer, source: ChangeSource) {
    return this.exclusive(async () => {
      const rel = safeVaultPath(p);
      await this.vault.writeBinary(rel, data, source);
      await this.afterWrite(rel, isMarkdown(rel) ? data.toString("utf8") : undefined, source);
      return { path: rel };
    });
  }

  async mkdir(p: string, source: ChangeSource) {
    const rel = safeVaultPath(p);
    await this.vault.mkdir(rel);
    let d = rel;
    while (d) {
      this.index.folders.add(d);
      d = dirname(d);
    }
    this.emitEvent({ type: "folder", path: rel, source });
  }

  async delete(p: string, source: ChangeSource) {
    return this.exclusive(async () => {
      const rel = this.index.files.has(p) || this.index.folders.has(p) ? p : this.resolvePathArg(p);
      const isFolder = this.index.folders.has(rel);
      if (!isFolder && !this.index.files.has(rel)) throw new HttpError(404, `Not found: ${p}`, "not_found");
      const removed = isFolder ? [...this.index.files.keys()].filter((f) => f.startsWith(rel + "/")) : [rel];
      const trashed = await this.vault.trash(rel, source);
      if (isFolder) this.index.removeFolder(rel);
      else this.index.removeFile(rel);
      this.index.computeAllLinks();
      for (const r of removed) this.emit("deleted", r, source);
      this.emitEvent({ type: isFolder ? "folder" : "delete", path: rel, source });
      return { path: rel, trashedTo: trashed, files: removed.length };
    });
  }

  async restore(trashPath: string, source: ChangeSource) {
    return this.exclusive(async () => {
      const target = await this.vault.restoreFromTrash(trashPath, source);
      const st = await this.vault.stat(target);
      if (st) this.index.setFile(st, isMarkdown(target) ? (await this.vault.readText(target)).content : undefined);
      this.index.computeAllLinks();
      this.emitEvent({ type: "change", path: target, source });
      this.emit("changed", target, source);
      return { path: target };
    });
  }

  /**
   * Rename or move a file or folder and rewrite every link pointing at the
   * moved files (always-update policy, R15). Returns rewrite statistics.
   */
  async rename(from: string, to: string, source: ChangeSource) {
    return this.exclusive(async () => {
      const a = this.index.files.has(from) || this.index.folders.has(from) ? from : this.resolvePathArg(from);
      const isFolder = this.index.folders.has(a);
      let b = safeVaultPath(to);
      if (!isFolder && !extname(b) && extname(a)) b += "." + extname(a);
      if (!isFolder && !this.index.files.has(a)) throw new HttpError(404, `Not found: ${from}`, "not_found");
      if (a === b) return { from: a, to: b, linksUpdated: 0, filesUpdated: 0 };
      if (this.index.files.has(b) || (this.index.folders.has(b) && a.toLowerCase() !== b.toLowerCase())) {
        throw new HttpError(409, `Destination exists: ${b}`, "exists");
      }

      const moves: Array<[string, string]> = isFolder
        ? [...this.index.files.keys()].filter((f) => f.startsWith(a + "/")).map((f) => [f, b + f.slice(a.length)])
        : [[a, b]];
      const moved = new Map(moves);

      // 1. Collect references to moved files before anything changes.
      type Ref = { start: number; end: number; subpath: string; kind: "wiki" | "markdown" | "fm"; angle?: boolean; target: string };
      const refsBySource = new Map<string, Ref[]>();
      for (const [src, meta] of this.index.meta) {
        const list: Ref[] = [];
        for (const r of [...meta.links, ...meta.embeds]) {
          if (r.link === "") continue;
          const t = this.index.resolve(r.link, src);
          if (t && moved.has(t.path)) list.push({ start: r.targetStart, end: r.targetEnd, subpath: r.subpath, kind: r.kind, angle: r.angle, target: t.path });
        }
        for (const r of meta.frontmatterLinks) {
          const t = this.index.resolve(r.link, src);
          if (t && moved.has(t.path)) list.push({ start: r.targetStart, end: r.targetEnd, subpath: r.subpath, kind: "fm", target: t.path });
        }
        if (list.length) refsBySource.set(src, list);
      }

      // 2. Move on disk and in the index.
      await this.vault.move(a, b, source);
      for (const [oldP, newP] of moves) {
        const text = this.index.text.get(oldP);
        const st = await this.vault.stat(newP);
        this.index.removeFile(oldP);
        if (st) this.index.setFile(st, text);
      }
      if (isFolder) {
        for (const d of [...this.index.folders]) {
          if (d === a || d.startsWith(a + "/")) {
            this.index.folders.delete(d);
            this.index.folders.add(b + d.slice(a.length));
          }
        }
      }
      let d = dirname(b);
      while (d) {
        this.index.folders.add(d);
        d = dirname(d);
      }

      // 3. Rewrite references (positions are from the pre-move parse of each source).
      let linksUpdated = 0;
      let filesUpdated = 0;
      for (const [srcOld, refs] of refsBySource) {
        const src = moved.get(srcOld) ?? srcOld;
        const text = this.index.text.get(src);
        if (text === undefined) continue;
        let next = text;
        for (const r of [...refs].sort((x, y) => y.start - x.start)) {
          const newTarget = moved.get(r.target)!;
          let linktext = this.index.linktextFor(newTarget, src);
          let replacement: string;
          if (r.kind === "markdown") {
            const withExt = this.index.files.get(newTarget)?.md && !/\.md$/i.test(linktext) ? linktext + ".md" : linktext;
            replacement = r.angle ? withExt + r.subpath : encodeMarkdownPath(withExt) + encodeMarkdownPath(r.subpath, true);
          } else {
            replacement = linktext + r.subpath;
          }
          next = next.slice(0, r.start) + replacement + next.slice(r.end);
          linksUpdated++;
        }
        if (next !== text) {
          const res = await this.vault.writeText(src, next, { ifMatch: etagOf(text), source });
          const st = await this.vault.stat(src);
          if (st) this.index.setFile(st, next);
          this.emitEvent({ type: "change", path: src, etag: res.etag, source });
          this.emit("changed", src, source);
          filesUpdated++;
        }
      }
      this.index.computeAllLinks();
      for (const [oldP, newP] of moves) this.emit("renamed", oldP, newP, source);
      this.emitEvent({ type: "rename", from: a, to: b, source });
      return { from: a, to: b, linksUpdated, filesUpdated };
    });
  }

  // ---------- properties ----------

  async setProperty(p: string, key: string, value: unknown, source: ChangeSource) {
    return this.editFrontmatter(p, source, (doc) => {
      doc.set(key, value);
    });
  }

  async removeProperty(p: string, key: string, source: ChangeSource) {
    return this.editFrontmatter(p, source, (doc) => {
      doc.delete(key);
    });
  }

  private async editFrontmatter(p: string, source: ChangeSource, fn: (doc: Document) => void) {
    return this.exclusive(async () => {
      const rel = this.resolvePathArg(p);
      const { content, etag } = await this.vault.readText(rel);
      const fm = parseFrontmatter(content);
      if (fm.end > 0 && fm.data === null) throw new HttpError(400, `Frontmatter of ${rel} is not valid YAML: ${fm.error}`, "yaml");
      const doc = fm.end > 0 ? parseDocument(fm.raw) : new Document({});
      if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
      fn(doc);
      let yaml = doc.toString();
      const empty = !isMap(doc.contents) || (doc.contents as { items: unknown[] }).items.length === 0;
      const body = content.slice(fm.end);
      const next = empty ? body : `---\n${yaml}${yaml.endsWith("\n") ? "" : "\n"}---\n${body}`;
      const r = await this.vault.writeText(rel, next, { ifMatch: etag, source });
      await this.afterWrite(rel, next, source, r.etag);
      return { path: rel, etag: r.etag };
    });
  }

  // ---------- templates & daily notes ----------

  templates(): string[] {
    const folder = safeVaultPath(this.getSettings().templatesFolder || "");
    if (!folder) return [];
    return [...this.index.files.values()].filter((f) => f.md && f.path.startsWith(folder + "/")).map((f) => f.path).sort(naturalCompare);
  }

  async renderTemplate(templatePath: string, title: string) {
    const rel = this.resolvePathArg(templatePath, safeVaultPath(this.getSettings().templatesFolder || "") + "/x.md");
    const { content } = await this.vault.readText(rel);
    return applyTemplate(content, { title });
  }

  dailyPath(date: Date): string {
    const s = this.getSettings();
    const name = formatDate(date, s.dailyFormat || "YYYY-MM-DD");
    const folder = safeVaultPath(s.dailyFolder || "");
    return (folder ? folder + "/" : "") + name + ".md";
  }

  /** Open (create if missing) the daily note for a date. */
  async daily(date = new Date(), source: ChangeSource = "ui") {
    const rel = this.dailyPath(date);
    if (this.index.files.has(rel)) return { path: rel, created: false };
    const s = this.getSettings();
    let content = "";
    if (s.dailyTemplate) {
      try {
        const tpl = this.resolvePathArg(s.dailyTemplate);
        content = applyTemplate((await this.vault.readText(tpl)).content, { title: stem(rel), now: date });
      } catch {
        content = "";
      }
    }
    await this.write(rel, content, { source, create: true }).catch((e) => {
      if (!(e instanceof HttpError && e.code === "exists")) throw e;
    });
    return { path: rel, created: true };
  }

  /** Previous/next existing daily note relative to a note path. */
  adjacentDaily(p: string, dir: -1 | 1): string | null {
    const s = this.getSettings();
    const fmt = s.dailyFormat || "YYYY-MM-DD";
    const folder = safeVaultPath(s.dailyFolder || "");
    const current = parseDate(stem(p), fmt);
    if (!current) return null;
    let best: { path: string; t: number } | null = null;
    for (const f of this.index.files.values()) {
      if (!f.md || dirname(f.path) !== folder) continue;
      const d = parseDate(stem(f.path), fmt);
      if (!d) continue;
      const diff = (d.getTime() - current.getTime()) * dir;
      if (diff <= 0) continue;
      if (!best || diff < best.t) best = { path: f.path, t: diff };
    }
    return best?.path ?? null;
  }
}

/** Encode a vault path for a markdown link URL (spaces -> %20, as Obsidian does). */
export function encodeMarkdownPath(p: string, isSubpath = false): string {
  return p
    .split("/")
    .map((seg) => encodeURI(seg).replace(/#/g, isSubpath ? "#" : "%23").replace(/\(/g, "%28").replace(/\)/g, "%29"))
    .join("/");
}
