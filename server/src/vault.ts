// File-system layer for the vault: safe paths, atomic writes, etags, trash, watching.

import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { basename, dirname, isHidden, safeVaultPath, PathError } from "./paths.js";

export interface FileStat {
  path: string;
  size: number;
  mtime: number;
  ctime: number;
}

export type ChangeSource = "ui" | "mcp" | "api" | "external" | "git";

export interface VaultEvents {
  change: (p: string, source: ChangeSource) => void;
  delete: (p: string, source: ChangeSource) => void;
  rename: (from: string, to: string, source: ChangeSource) => void;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export const TRASH_DIR = ".trash";

export function etagOf(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 20);
}

export class Vault extends EventEmitter {
  readonly root: string;
  /** Hashes of writes made by this process, used to ignore our own watcher events. */
  private ownWrites = new Map<string, { hash: string; at: number }>();
  private watcher: fs.FSWatcher | null = null;
  private pending = new Map<string, NodeJS.Timeout>();
  /** When > 0, watcher events are attributed to git and not auto-committed. */
  gitDepth = 0;

  constructor(root: string) {
    super();
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  abs(p: string): string {
    const rel = safeVaultPath(p);
    const full = path.join(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new PathError("Path escapes vault");
    return full;
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fsp.access(this.abs(p));
      return true;
    } catch {
      return false;
    }
  }

  async stat(p: string): Promise<FileStat | null> {
    try {
      const s = await fsp.stat(this.abs(p));
      if (!s.isFile()) return null;
      return { path: safeVaultPath(p), size: s.size, mtime: s.mtimeMs, ctime: s.birthtimeMs || s.ctimeMs };
    } catch {
      return null;
    }
  }

  /** Recursively list files and folders (excluding hidden ones like .git/.trash). */
  async list(): Promise<{ files: FileStat[]; folders: string[] }> {
    const files: FileStat[] = [];
    const folders: string[] = [];
    const walk = async (rel: string) => {
      const dir = rel ? path.join(this.root, rel) : this.root;
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          folders.push(childRel.normalize("NFC"));
          await walk(childRel);
        } else if (e.isFile()) {
          const s = await fsp.stat(path.join(dir, e.name));
          files.push({ path: childRel.normalize("NFC"), size: s.size, mtime: s.mtimeMs, ctime: s.birthtimeMs || s.ctimeMs });
        }
      }
    };
    await walk("");
    return { files, folders };
  }

  async readText(p: string): Promise<{ content: string; etag: string; stat: FileStat }> {
    const full = this.abs(p);
    let buf: Buffer;
    try {
      buf = await fsp.readFile(full);
    } catch {
      throw new HttpError(404, `Not found: ${p}`, "not_found");
    }
    const stat = (await this.stat(p))!;
    return { content: buf.toString("utf8"), etag: etagOf(buf), stat };
  }

  async readBinary(p: string): Promise<Buffer> {
    try {
      return await fsp.readFile(this.abs(p));
    } catch {
      throw new HttpError(404, `Not found: ${p}`, "not_found");
    }
  }

  async currentEtag(p: string): Promise<string | null> {
    try {
      return etagOf(await fsp.readFile(this.abs(p)));
    } catch {
      return null;
    }
  }

  private async atomicWrite(full: string, data: string | Buffer) {
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${randomBytes(4).toString("hex")}.tmp`);
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, full);
  }

  private markOwn(p: string, data: string | Buffer | null) {
    this.ownWrites.set(p, { hash: data === null ? "" : etagOf(data), at: Date.now() });
  }

  /**
   * Write a text file. If ifMatch is given, the current content must match it
   * (stale writes are rejected with 409). If mustNotExist, the file must not exist.
   */
  async writeText(
    p: string,
    content: string,
    opts: { ifMatch?: string | null; mustNotExist?: boolean; source: ChangeSource },
  ): Promise<{ etag: string; created: boolean }> {
    const rel = safeVaultPath(p);
    if (!rel || isHidden(rel)) throw new HttpError(400, "Invalid file path", "invalid_path");
    const full = this.abs(rel);
    const current = await this.currentEtag(rel);
    if (opts.mustNotExist && current !== null) throw new HttpError(409, `File already exists: ${rel}`, "exists");
    if (opts.ifMatch && current !== null && current !== opts.ifMatch) {
      throw new HttpError(409, `Stale write rejected: "${rel}" was changed since you read it (expected version ${opts.ifMatch}, current ${current}). Re-read the note and apply your change again.`, "stale");
    }
    if (opts.ifMatch && current === null) throw new HttpError(409, `Stale write rejected: "${rel}" no longer exists.`, "stale");
    this.markOwn(rel, content);
    await this.atomicWrite(full, content);
    this.emit("change", rel, opts.source);
    return { etag: etagOf(content), created: current === null };
  }

  async writeBinary(p: string, data: Buffer, source: ChangeSource): Promise<void> {
    const rel = safeVaultPath(p);
    if (!rel || isHidden(rel)) throw new HttpError(400, "Invalid file path", "invalid_path");
    this.markOwn(rel, data);
    await this.atomicWrite(this.abs(rel), data);
    this.emit("change", rel, source);
  }

  async mkdir(p: string): Promise<void> {
    const rel = safeVaultPath(p);
    if (!rel || isHidden(rel)) throw new HttpError(400, "Invalid folder path", "invalid_path");
    await fsp.mkdir(this.abs(rel), { recursive: true });
  }

  /** Low-level move; caller handles link updates. */
  async move(from: string, to: string, source: ChangeSource): Promise<void> {
    const a = safeVaultPath(from);
    const b = safeVaultPath(to);
    if (!a || !b || isHidden(b)) throw new HttpError(400, "Invalid path", "invalid_path");
    if (a === b) return;
    if (!(await this.exists(a))) throw new HttpError(404, `Not found: ${a}`, "not_found");
    if ((await this.exists(b)) && a.toLowerCase() !== b.toLowerCase()) throw new HttpError(409, `Destination exists: ${b}`, "exists");
    await fsp.mkdir(path.dirname(this.abs(b)), { recursive: true });
    this.markOwn(a, null);
    this.markOwn(b, null);
    await fsp.rename(this.abs(a), this.abs(b));
    this.emit("rename", a, b, source);
  }

  /** Soft delete: move into .trash/ keeping the relative path. */
  async trash(p: string, source: ChangeSource): Promise<string> {
    const rel = safeVaultPath(p);
    if (!rel) throw new HttpError(400, "Invalid path", "invalid_path");
    const full = this.abs(rel);
    let st: fs.Stats;
    try {
      st = await fsp.stat(full);
    } catch {
      throw new HttpError(404, `Not found: ${rel}`, "not_found");
    }
    let dest = path.join(this.root, TRASH_DIR, rel);
    if (fs.existsSync(dest)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const ext = path.extname(dest);
      dest = dest.slice(0, dest.length - ext.length) + ` ${stamp}` + ext;
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    this.markOwn(rel, null);
    await fsp.rename(full, dest);
    if (st.isDirectory()) this.emit("deleteFolder", rel, source);
    else this.emit("delete", rel, source);
    return path.relative(this.root, dest).split(path.sep).join("/");
  }

  async listTrash(): Promise<FileStat[]> {
    const out: FileStat[] = [];
    const base = path.join(this.root, TRASH_DIR);
    const walk = async (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const s = await fsp.stat(full);
          out.push({ path: path.relative(base, full).split(path.sep).join("/"), size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs });
        }
      }
    };
    await walk(base);
    return out;
  }

  async restoreFromTrash(trashRel: string, source: ChangeSource): Promise<string> {
    const rel = safeVaultPath(trashRel);
    const src = path.join(this.root, TRASH_DIR, rel);
    if (!fs.existsSync(src)) throw new HttpError(404, `Not in trash: ${rel}`, "not_found");
    let target = rel.replace(/ \d{4}-\d{2}-\d{2}T[\d-]+Z(?=\.[^.]+$|$)/, "");
    if (await this.exists(target)) throw new HttpError(409, `A file already exists at ${target}`, "exists");
    await fsp.mkdir(path.dirname(this.abs(target)), { recursive: true });
    this.markOwn(target, null);
    await fsp.rename(src, this.abs(target));
    this.emit("change", target, source);
    return target;
  }

  /** Watch for changes made outside this process (manual edits, git). */
  startWatching() {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_ev, filename) => {
        if (!filename) return;
        const rel = filename.toString().split(path.sep).join("/").normalize("NFC");
        if (isHidden(rel) || rel.endsWith(".tmp")) return;
        // Debounce bursts per path.
        clearTimeout(this.pending.get(rel));
        this.pending.set(rel, setTimeout(() => this.onFsEvent(rel), 150));
      });
    } catch (e) {
      console.warn("[vault] file watching unavailable:", (e as Error).message);
    }
  }

  stopWatching() {
    this.watcher?.close();
    this.watcher = null;
  }

  private async onFsEvent(rel: string) {
    this.pending.delete(rel);
    const own = this.ownWrites.get(rel);
    let st: fs.Stats | null = null;
    try {
      st = await fsp.stat(this.abs(rel));
    } catch {
      st = null;
    }
    const source: ChangeSource = this.gitDepth > 0 ? "git" : "external";
    if (!st) {
      if (own && Date.now() - own.at < 5000) return;
      this.emit("externalDelete", rel, source);
      return;
    }
    if (st.isDirectory()) {
      this.emit("externalFolder", rel, source);
      return;
    }
    if (own && Date.now() - own.at < 5000) {
      if (own.hash === "") return;
      const cur = await this.currentEtag(rel);
      if (cur === own.hash) return;
    }
    this.emit("externalChange", rel, source);
  }

  /** Prune own-write records periodically. */
  gc() {
    const now = Date.now();
    for (const [k, v] of this.ownWrites) if (now - v.at > 10000) this.ownWrites.delete(k);
  }
}

export { basename, dirname };
