// REST API v1 used by the web UI and future clients (same token as MCP).

import * as path from "node:path";
import { issueSession, clearSession, LoginThrottle } from "./auth.js";
import type { Brain, VaultSettings } from "./brain.js";
import { DEFAULT_SETTINGS } from "./brain.js";
import type { Config } from "./config.js";
import type { GitSync } from "./git.js";
import { Router, sendFile, type Ctx } from "./http.js";
import { safeVaultPath } from "./paths.js";
import { fuzzyScore } from "./search.js";
import { HttpError } from "./vault.js";

function str(v: unknown, name: string, required = true): string {
  if (typeof v === "string") return v;
  if (!required && (v === undefined || v === null)) return "";
  throw new HttpError(400, `"${name}" must be a string`, "invalid");
}

export function buildApi(deps: { brain: Brain; cfg: Config; git: GitSync; throttle: LoginThrottle }) {
  const { brain, cfg, git, throttle } = deps;
  const r = new Router();
  const src = (ctx: Ctx) => (ctx.req.headers.authorization ? "api" : "ui") as "api" | "ui";

  // ----- setup & auth (unauthenticated routes are whitelisted in main.ts) -----
  r.get("/api/v1/setup/status", () => ({ setupComplete: cfg.setupComplete }));
  r.post("/api/v1/setup", async (ctx) => {
    if (cfg.setupComplete) throw new HttpError(409, "Setup is already complete", "done");
    const b = await ctx.json<{ code?: string; password?: string }>();
    if (!cfg.setupCode || str(b.code, "code").trim() !== cfg.setupCode) throw new HttpError(403, "Wrong setup code. Find it in the service log or in setup-code.txt in the data directory.", "bad_code");
    await cfg.setPassword(str(b.password, "password"));
    const token = cfg.rotateToken();
    cfg.finishSetup();
    issueSession(cfg, ctx.res);
    return { ok: true, mcpToken: token };
  });
  r.post("/api/v1/auth/login", async (ctx) => {
    const wait = throttle.check();
    if (wait > 0) throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 1000)} s.`, "throttled");
    const b = await ctx.json<{ password?: string }>();
    const ok = await cfg.verifyPassword(str(b.password, "password"));
    if (!ok) {
      throttle.fail();
      throw new HttpError(401, "Wrong password", "bad_password");
    }
    throttle.success();
    issueSession(cfg, ctx.res);
    return { ok: true };
  });
  r.post("/api/v1/auth/logout", (ctx) => {
    clearSession(ctx.res);
    return { ok: true };
  });
  r.get("/api/v1/auth/me", () => ({ ok: true }));
  r.get("/api/v1/auth/token", () => ({ token: cfg.data.mcpToken }));
  r.post("/api/v1/auth/token/rotate", () => ({ token: cfg.rotateToken() }));
  r.post("/api/v1/auth/password", async (ctx) => {
    const b = await ctx.json<{ current?: string; next?: string }>();
    if (!(await cfg.verifyPassword(str(b.current, "current")))) throw new HttpError(401, "Current password is wrong", "bad_password");
    await cfg.setPassword(str(b.next, "next"));
    issueSession(cfg, ctx.res);
    return { ok: true };
  });

  // ----- vault reads -----
  r.get("/api/v1/tree", () => brain.tree());
  r.get("/api/v1/note", async (ctx) => brain.read(str(ctx.query("path"), "path")));
  r.get("/api/v1/meta", (ctx) => brain.meta(str(ctx.query("path"), "path")));
  r.get("/api/v1/backlinks", (ctx) => brain.backlinks(str(ctx.query("path"), "path")));
  r.get("/api/v1/outgoing", (ctx) => brain.outgoing(str(ctx.query("path"), "path")));
  r.get("/api/v1/resolve", (ctx) => ({ path: brain.resolveLink(str(ctx.query("link"), "link"), ctx.query("source") ?? "") }));
  r.get("/api/v1/search", (ctx) => {
    const q = ctx.query("q") ?? "";
    return { query: q, results: brain.search(q, { limit: Number(ctx.query("limit") ?? 200) }) };
  });
  r.get("/api/v1/switcher", (ctx) => {
    const q = ctx.query("q") ?? "";
    const out: { path: string; alias?: string; score: number; ranges: [number, number][] }[] = [];
    for (const f of brain.index.files.values()) {
      const label = f.md ? f.path.replace(/\.md$/i, "") : f.path;
      const s = fuzzyScore(q, label);
      if (s) out.push({ path: f.path, score: s.score, ranges: s.ranges });
      for (const a of brain.index.aliases(f.path)) {
        const sa = fuzzyScore(q, a);
        if (sa) out.push({ path: f.path, alias: a, score: sa.score - 0.001, ranges: sa.ranges });
      }
    }
    out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return out.slice(0, Number(ctx.query("limit") ?? 50));
  });
  r.get("/api/v1/recent", (ctx) => {
    const n = Number(ctx.query("limit") ?? 20);
    return [...brain.index.files.values()].filter((f) => f.md).sort((a, b) => b.mtime - a.mtime).slice(0, n).map((f) => ({ path: f.path, mtime: f.mtime }));
  });
  r.get("/api/v1/tags", () => brain.index.tagCounts());
  r.get("/api/v1/tags/notes", (ctx) => brain.index.notesWithTag(str(ctx.query("tag"), "tag")));
  r.get("/api/v1/properties", () => brain.index.properties());
  r.get("/api/v1/properties/values", (ctx) => brain.index.propertyValues(str(ctx.query("key"), "key")));
  r.get("/api/v1/unresolved", () => brain.index.unresolvedLinks());
  r.get("/api/v1/orphans", (ctx) => brain.index.orphans(ctx.query("all") === "1"));
  r.get("/api/v1/deadends", (ctx) => brain.index.deadends(ctx.query("all") === "1"));
  r.get("/api/v1/graph", (ctx) =>
    brain.index.graph({
      showTags: ctx.query("showTags") === "1",
      showAttachments: ctx.query("showAttachments") === "1",
      hideUnresolved: ctx.query("hideUnresolved") === "1",
      showOrphans: ctx.query("showOrphans") !== "0",
    }),
  );
  r.get("/api/v1/file", (ctx) => {
    const p = brain.resolvePathArg(str(ctx.query("path"), "path"), ctx.query("source") ?? "");
    if (!brain.index.files.has(p)) throw new HttpError(404, "Not found", "not_found");
    return sendFile(ctx.req, ctx.res, brain.vault.abs(p), { cache: "private, no-cache", untrusted: true });
  });

  // ----- vault writes -----
  r.put("/api/v1/note", async (ctx) => {
    const b = await ctx.json<{ path?: string; content?: string; etag?: string }>();
    return brain.write(str(b.path, "path"), str(b.content, "content"), { ifMatch: b.etag ?? null, source: src(ctx) });
  });
  r.post("/api/v1/note", async (ctx) => {
    const b = await ctx.json<{ path?: string; content?: string; template?: string }>();
    let content = str(b.content, "content", false);
    const p = b.path ? str(b.path, "path") : undefined;
    if (b.template) content = await brain.renderTemplate(str(b.template, "template"), p ? path.basename(p).replace(/\.md$/i, "") : "Untitled");
    return brain.create(p, content, src(ctx));
  });
  r.post("/api/v1/note/append", async (ctx) => {
    const b = await ctx.json<{ path?: string; text?: string }>();
    return brain.append(str(b.path, "path"), str(b.text, "text"), src(ctx));
  });
  r.post("/api/v1/note/prepend", async (ctx) => {
    const b = await ctx.json<{ path?: string; text?: string }>();
    return brain.prepend(str(b.path, "path"), str(b.text, "text"), src(ctx));
  });
  r.post("/api/v1/rename", async (ctx) => {
    const b = await ctx.json<{ from?: string; to?: string }>();
    return brain.rename(str(b.from, "from"), str(b.to, "to"), src(ctx));
  });
  r.delete("/api/v1/note", (ctx) => brain.delete(str(ctx.query("path"), "path"), src(ctx)));
  r.post("/api/v1/folder", async (ctx) => {
    const b = await ctx.json<{ path?: string }>();
    await brain.mkdir(str(b.path, "path"), src(ctx));
    return { ok: true };
  });
  r.post("/api/v1/attachment", async (ctx) => {
    const name = str(ctx.query("name"), "name");
    const data = await ctx.raw();
    return brain.uploadAttachment(name, data, src(ctx), ctx.query("note") ?? undefined);
  });
  r.post("/api/v1/property", async (ctx) => {
    const b = await ctx.json<{ path?: string; key?: string; value?: unknown }>();
    return brain.setProperty(str(b.path, "path"), str(b.key, "key"), b.value, src(ctx));
  });
  r.delete("/api/v1/property", (ctx) => brain.removeProperty(str(ctx.query("path"), "path"), str(ctx.query("key"), "key"), src(ctx)));

  // ----- templates & daily -----
  r.get("/api/v1/templates", () => brain.templates());
  r.get("/api/v1/template/render", (ctx) => brain.renderTemplate(str(ctx.query("path"), "path"), ctx.query("title") ?? "").then((text) => ({ text })));
  r.post("/api/v1/daily", async (ctx) => {
    const b = await ctx.json<{ date?: string }>();
    const d = b.date ? new Date(b.date + "T12:00:00") : new Date();
    if (isNaN(d.getTime())) throw new HttpError(400, "Invalid date", "invalid");
    return brain.daily(d, src(ctx));
  });
  r.get("/api/v1/daily/adjacent", (ctx) => ({ path: brain.adjacentDaily(str(ctx.query("path"), "path"), ctx.query("dir") === "prev" ? -1 : 1) }));

  // ----- trash -----
  r.get("/api/v1/trash", () => brain.vault.listTrash());
  r.post("/api/v1/trash/restore", async (ctx) => {
    const b = await ctx.json<{ path?: string }>();
    return brain.restore(str(b.path, "path"), src(ctx));
  });

  // ----- settings -----
  r.get("/api/v1/settings", () => cfg.data.settings);
  r.put("/api/v1/settings", async (ctx) => {
    const b = await ctx.json<Partial<VaultSettings>>();
    const next = { ...cfg.data.settings };
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof VaultSettings)[]) {
      if (b[k] === undefined) continue;
      const v = str(b[k], k);
      next[k] = k === "dailyFormat" ? v.trim() || "YYYY-MM-DD" : v.trim() ? safeVaultPath(v.trim()) || "" : "";
      if (k === "attachmentFolder" && v.trim().startsWith("./")) next[k] = v.trim();
    }
    cfg.data.settings = next;
    cfg.save();
    return next;
  });

  // ----- git -----
  r.get("/api/v1/git/status", () => git.status());
  r.get("/api/v1/git/log", () => git.log());
  r.post("/api/v1/git/key", async (ctx) => {
    const b = await ctx.json<{ regenerate?: boolean }>();
    return { publicKey: await git.ensureKey(!!b.regenerate) };
  });
  r.post("/api/v1/git/hostkey", async (ctx) => {
    const b = await ctx.json<{ remote?: string }>();
    const s = await git.scanHostKey(str(b.remote, "remote"));
    return { host: s.host, fingerprint: s.fingerprint, pinned: s.pinned, matchesPinned: s.matchesPinned };
  });
  r.post("/api/v1/git/connect", async (ctx) => {
    const b = await ctx.json<{ remote?: string; branch?: string; authorName?: string; authorEmail?: string; fingerprint?: string }>();
    return git.connect({
      remote: str(b.remote, "remote"),
      branch: str(b.branch, "branch", false) || "main",
      authorName: str(b.authorName, "authorName", false),
      authorEmail: str(b.authorEmail, "authorEmail", false),
      acceptFingerprint: str(b.fingerprint, "fingerprint"),
    });
  });
  r.post("/api/v1/git/disconnect", () => {
    git.disconnect();
    return git.status();
  });
  r.post("/api/v1/git/commit", async (ctx) => {
    const b = await ctx.json<{ message?: string }>();
    const committed = await git.commitPending(b.message ? str(b.message, "message") : "Manual commit");
    return { committed, status: git.status() };
  });
  r.post("/api/v1/git/sync", () => git.sync("manual"));
  r.post("/api/v1/git/pull", () => git.sync("pull"));
  r.get("/api/v1/git/conflicts", () => git.conflicts);
  r.post("/api/v1/git/resolve", async (ctx) => {
    const b = await ctx.json<{ resolutions?: Record<string, { choice: "ours" | "theirs" | "manual"; content?: string }> }>();
    if (!b.resolutions || typeof b.resolutions !== "object") throw new HttpError(400, "resolutions required", "invalid");
    return git.resolve(b.resolutions);
  });

  return r;
}
