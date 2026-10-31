// Session cookies (UI) and bearer tokens (MCP / API clients).

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";

const COOKIE = "brain_session";
const SESSION_DAYS = 30;

export type AuthKind = "session" | "token" | null;

function sign(secret: string, payload: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueSession(cfg: Config, res: ServerResponse) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const payload = String(exp);
  const value = `${payload}.${sign(cfg.data.sessionSecret, payload)}`;
  res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`);
}

export function clearSession(res: ServerResponse) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const part of h.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function authenticate(cfg: Config, req: IncomingMessage): AuthKind {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return cfg.checkToken(auth.slice(7).trim()) ? "token" : null;
  const c = readCookie(req, COOKIE);
  if (!c || !cfg.data.passwordHash) return null;
  const [payload, sig] = c.split(".");
  if (!payload || !sig) return null;
  const want = sign(cfg.data.sessionSecret, payload);
  const a = Buffer.from(want);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(payload) < Date.now()) return null;
  return "session";
}

/** Simple global login throttle: exponential delay after repeated failures. */
export class LoginThrottle {
  private failures = 0;
  private lockedUntil = 0;

  check(): number {
    return Math.max(0, this.lockedUntil - Date.now());
  }

  fail() {
    this.failures++;
    if (this.failures >= 5) this.lockedUntil = Date.now() + Math.min(15 * 60_000, 1000 * 2 ** (this.failures - 5));
  }

  success() {
    this.failures = 0;
    this.lockedUntil = 0;
  }
}
