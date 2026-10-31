// Tiny HTTP toolkit: routing, JSON bodies, static files, errors.

import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { HttpError } from "./vault.js";

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: (k: string) => string | null;
  json: <T = Record<string, unknown>>() => Promise<T>;
  raw: (limit?: number) => Promise<Buffer>;
}

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler) {
    this.routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler) { return this.add("GET", p, h); }
  post(p: string, h: Handler) { return this.add("POST", p, h); }
  put(p: string, h: Handler) { return this.add("PUT", p, h); }
  delete(p: string, h: Handler) { return this.add("DELETE", p, h); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null | "method" {
    const segs = pathname.split("/").filter(Boolean);
    let methodMismatch = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        if (r.parts[i].startsWith(":")) params[r.parts[i].slice(1)] = decodeURIComponent(segs[i]);
        else if (r.parts[i] !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (r.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { handler: r.handler, params };
    }
    return methodMismatch ? "method" : null;
  }
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `Request body too large (limit ${Math.round(limit / 1048576)} MB)`, "too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function makeCtx(req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>): Ctx {
  let jsonCache: unknown;
  return {
    req,
    res,
    url,
    params,
    query: (k) => url.searchParams.get(k),
    json: async <T>() => {
      if (jsonCache !== undefined) return jsonCache as T;
      const buf = await readBody(req, 20 * 1024 * 1024);
      if (buf.length === 0) return (jsonCache = {}) as T;
      try {
        jsonCache = JSON.parse(buf.toString("utf8"));
      } catch {
        throw new HttpError(400, "Invalid JSON body", "bad_json");
      }
      return jsonCache as T;
    },
    raw: (limit = 200 * 1024 * 1024) => readBody(req, limit),
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

export function sendError(res: ServerResponse, e: unknown) {
  const status = (e as { status?: number }).status ?? 500;
  const code = (e as { code?: string }).code;
  const message = status >= 500 && !(e instanceof HttpError) ? "Internal server error" : (e as Error).message;
  if (status >= 500 && !(e instanceof HttpError && e.status === 503)) console.error("[http]", e);
  if (!res.headersSent) sendJson(res, status, { error: message, code });
  else res.end();
}

export const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  webm: "video/webm",
  mp4: "video/mp4",
  mov: "video/quicktime",
  ogv: "video/ogg",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  wasm: "application/wasm",
};

export function mimeOf(p: string) {
  const ext = path.extname(p).slice(1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/** Serve a file with HTTP Range support (needed for audio/video seeking). */
export function sendFile(req: IncomingMessage, res: ServerResponse, full: string, opts: { cache?: string; type?: string; untrusted?: boolean } = {}) {
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
    if (!st.isFile()) throw new Error();
  } catch {
    throw new HttpError(404, "Not found", "not_found");
  }
  const type = opts.type ?? mimeOf(full);
  const headers: Record<string, string | number> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": opts.cache ?? "no-cache",
    "Last-Modified": st.mtime.toUTCString(),
    "X-Content-Type-Options": "nosniff",
  };
  // Never let vault content run scripts in our origin.
  if (opts.untrusted && (type.startsWith("image/svg") || type.startsWith("text/html") || type.startsWith("application/xhtml"))) headers["Content-Security-Policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
    if (start >= st.size || start < 0 || end < start) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
      res.end();
      return;
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
    fs.createReadStream(full, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": st.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(full).pipe(res);
}

/** Static SPA serving with index.html fallback. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, webDir: string, pathname: string) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  const full = path.resolve(webDir, rel);
  if (!full.startsWith(path.resolve(webDir))) throw new HttpError(400, "Bad path");
  if (rel && fs.existsSync(full) && fs.statSync(full).isFile()) {
    const immutable = rel.startsWith("assets/");
    return sendFile(req, res, full, { cache: immutable ? "public, max-age=31536000, immutable" : "no-cache" });
  }
  const index = path.join(webDir, "index.html");
  if (!fs.existsSync(index)) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Web UI not built. Run: npm run build -w web");
    return;
  }
  return sendFile(req, res, index, { cache: "no-cache" });
}
