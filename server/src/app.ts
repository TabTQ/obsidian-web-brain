// Entry point: wires config, vault, index, git, REST API, MCP and the web UI.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildApi } from "./api.js";
import { authenticate, LoginThrottle } from "./auth.js";
import { Brain, type BrainEvent } from "./brain.js";
import { Config, type Env } from "./config.js";
import { GitSync } from "./git.js";
import { makeCtx, sendError, sendJson, serveStatic } from "./http.js";
import { McpServer } from "./mcp.js";
import { HttpError, Vault } from "./vault.js";

export interface App {
  server: ReturnType<typeof createServer>;
  brain: Brain;
  git: GitSync;
  cfg: Config;
  vault: Vault;
  listen: () => Promise<number>;
  close: () => Promise<void>;
}

export async function createApp(env: Env): Promise<App> {
  const cfg = new Config(env.dataDir);
  const vault = new Vault(env.vaultDir);
  const brain = new Brain(vault, () => cfg.data.settings);
  const git = new GitSync(cfg, brain, env.vaultDir);
  const throttle = new LoginThrottle();
  const api = buildApi({ brain, cfg, git, throttle });
  const mcp = new McpServer(brain);

  const PUBLIC = new Set(["GET /api/v1/setup/status", "POST /api/v1/setup", "POST /api/v1/auth/login", "POST /api/v1/auth/logout"]);

  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
  ].join("; ");

  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  // ----- server-sent events for live UI updates -----
  const clients = new Set<ServerResponse>();
  function broadcast(event: string, data: unknown) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  }
  brain.on("event", (e: BrainEvent) => broadcast("vault", e));
  let gitTimer: NodeJS.Timeout | null = null;
  brain.on("gitStatus", () => {
    if (gitTimer) return;
    gitTimer = setTimeout(() => {
      gitTimer = null;
      broadcast("git", git.status());
    }, 200);
  });
  const pingTimer = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
    vault.gc();
  }, 25_000).unref();

  function events(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: hello\ndata: {}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");

    if (pathname === "/mcp" || pathname === "/mcp/") {
      if (!originAllowed(req)) throw new HttpError(403, "Origin not allowed");
      if (authenticate(cfg, req) !== "token") {
        res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="brain"', "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing or invalid bearer token" }));
        return;
      }
      return mcp.handle(req, res);
    }

    if (pathname.startsWith("/api/")) {
      if (!originAllowed(req)) throw new HttpError(403, "Origin not allowed", "origin");
      const key = `${req.method} ${pathname}`;
      const kind = authenticate(cfg, req);
      if (!PUBLIC.has(key)) {
        if (!cfg.setupComplete) throw new HttpError(503, "Setup required", "setup_required");
        if (!kind) throw new HttpError(401, "Not logged in", "unauthenticated");
        // CSRF defence for cookie sessions: require a custom header on state changes.
        if (kind === "session" && req.method !== "GET" && req.method !== "HEAD" && req.headers["x-brain-request"] !== "1") {
          throw new HttpError(403, "Missing X-Brain-Request header", "csrf");
        }
      }
      if (pathname === "/api/v1/events" && req.method === "GET") return events(req, res);
      const m = api.match(req.method ?? "GET", pathname);
      if (m === null) throw new HttpError(404, "No such endpoint", "no_route");
      if (m === "method") throw new HttpError(405, "Method not allowed", "method");
      const out = await m.handler(makeCtx(req, res, url, m.params));
      if (!res.headersSent && !res.writableEnded) sendJson(res, 200, out ?? { ok: true });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    res.setHeader("Content-Security-Policy", CSP);
    return serveStatic(req, res, env.webDir, pathname);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => sendError(res, e));
  });
  server.requestTimeout = 0; // SSE connections are long-lived
  server.headersTimeout = 30_000;

  await brain.load();
  vault.startWatching();
  const timers: NodeJS.Timeout[] = [pingTimer];
  return {
    server,
    brain,
    git,
    cfg,
    vault,
    listen: () =>
      new Promise((resolve) => {
        server.listen(env.port, env.host, () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : env.port);
        });
      }),
    close: async () => {
      for (const t of timers) clearInterval(t);
      for (const c of clients) c.end();
      await new Promise<void>((r) => server.close(() => r()));
      vault.stopWatching();
    },
  };
}
