// Persistent server configuration and secrets (kept outside the vault, mode 0600).

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_SETTINGS, type VaultSettings } from "./brain.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export interface GitConfig {
  enabled: boolean;
  remote: string;
  branch: string;
  authorName: string;
  authorEmail: string;
  pushDelaySec: number;
  commitDelaySec: number;
}

export interface ConfigData {
  version: 1;
  passwordHash: string | null;
  sessionSecret: string;
  mcpToken: string | null;
  settings: VaultSettings;
  git: GitConfig;
}

export const DEFAULT_GIT: GitConfig = {
  enabled: false,
  remote: "",
  branch: "main",
  authorName: "Brain",
  authorEmail: "brain@localhost",
  pushDelaySec: 45,
  commitDelaySec: 3,
};

export interface Env {
  dataDir: string;
  vaultDir: string;
  host: string;
  port: number;
  webDir: string;
  dev: boolean;
}

export function readEnv(): Env {
  const dataDir = path.resolve(process.env.BRAIN_DATA_DIR ?? "/var/lib/brain");
  return {
    dataDir,
    vaultDir: path.resolve(process.env.BRAIN_VAULT_DIR ?? path.join(dataDir, "vault")),
    host: process.env.BRAIN_HOST ?? "127.0.0.1",
    port: Number(process.env.BRAIN_PORT ?? 8090),
    webDir: path.resolve(process.env.BRAIN_WEB_DIR ?? path.join(path.dirname(new URL(import.meta.url).pathname), "../../web/dist")),
    dev: process.env.BRAIN_DEV === "1",
  };
}

export class Config {
  data: ConfigData;
  readonly file: string;
  /** One-time code required for first-run setup (printed to the service log). */
  setupCode: string | null = null;

  constructor(public dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(dataDir, "config.json");
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.data = {
        version: 1,
        passwordHash: raw.passwordHash ?? null,
        sessionSecret: raw.sessionSecret ?? randomBytes(32).toString("hex"),
        mcpToken: raw.mcpToken ?? null,
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
        git: { ...DEFAULT_GIT, ...(raw.git ?? {}) },
      };
    } else {
      this.data = {
        version: 1,
        passwordHash: null,
        sessionSecret: randomBytes(32).toString("hex"),
        mcpToken: null,
        settings: { ...DEFAULT_SETTINGS },
        git: { ...DEFAULT_GIT },
      };
      this.save();
    }
    if (!this.setupComplete) {
      const codeFile = path.join(dataDir, "setup-code.txt");
      this.setupCode = fs.existsSync(codeFile) ? fs.readFileSync(codeFile, "utf8").trim() : randomBytes(4).toString("hex");
      fs.writeFileSync(codeFile, this.setupCode + "\n", { mode: 0o600 });
    }
  }

  get setupComplete(): boolean {
    return !!this.data.passwordHash && !!this.data.mcpToken;
  }

  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  async setPassword(pw: string) {
    if (pw.length < 8) throw Object.assign(new Error("Password must be at least 8 characters"), { status: 400 });
    const salt = randomBytes(16);
    const N = 16384, r = 8, p = 1;
    const hash = await scrypt(pw, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
    this.data.passwordHash = `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
    // Invalidate existing sessions.
    this.data.sessionSecret = randomBytes(32).toString("hex");
    this.save();
  }

  async verifyPassword(pw: string): Promise<boolean> {
    const h = this.data.passwordHash;
    if (!h) return false;
    const [alg, N, r, p, salt, hash] = h.split("$");
    if (alg !== "scrypt") return false;
    const expected = Buffer.from(hash, "base64");
    const got = await scrypt(pw, Buffer.from(salt, "base64"), expected.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
    return timingSafeEqual(expected, got);
  }

  rotateToken(): string {
    this.data.mcpToken = "brain_" + randomBytes(24).toString("base64url");
    this.save();
    return this.data.mcpToken;
  }

  finishSetup() {
    this.setupCode = null;
    try {
      fs.unlinkSync(path.join(this.dataDir, "setup-code.txt"));
    } catch {
      /* ignore */
    }
  }

  checkToken(t: string): boolean {
    const want = this.data.mcpToken;
    if (!want || !t) return false;
    const a = Buffer.from(want);
    const b = Buffer.from(t);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
