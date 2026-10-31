// Git backup & sync (R13/R14): auto-commit on save, debounced push, manual sync,
// pull from remote, and conflict detection via `git merge-tree` so the working
// tree never contains conflict markers. Conflicts are resolved per file in the UI.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Brain } from "./brain.js";
import type { Config, GitConfig } from "./config.js";
import { HttpError, type ChangeSource } from "./vault.js";

// GitHub's published SSH host key fingerprints (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)
const GITHUB_FINGERPRINTS: Record<string, string> = {
  ed25519: "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
};

export interface ConflictFile {
  path: string;
  ours: string | null; // vault version (null = deleted locally)
  theirs: string | null; // remote version (null = deleted remotely)
  base: string | null;
  binary: boolean;
}

export interface GitStatus {
  enabled: boolean;
  remote: string;
  branch: string;
  hasKey: boolean;
  publicKey: string | null;
  ahead: number;
  behind: number;
  pendingCommit: number;
  lastCommitAt: number | null;
  lastPushAt: number | null;
  lastFetchAt: number | null;
  lastError: string | null;
  busy: string | null;
  conflicts: string[];
  nextPushAt: number | null;
}

interface RunOpts {
  cwd?: string;
  allowFail?: boolean;
  input?: string;
  maxBuffer?: number;
}

export class GitSync {
  private keyFile: string;
  private knownHosts: string;
  private pending = new Map<string, ChangeSource>();
  private commitTimer: NodeJS.Timeout | null = null;
  private pushTimer: NodeJS.Timeout | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private state = {
    ahead: 0,
    behind: 0,
    lastCommitAt: null as number | null,
    lastPushAt: null as number | null,
    lastFetchAt: null as number | null,
    lastError: null as string | null,
    busy: null as string | null,
    nextPushAt: null as number | null,
  };
  conflicts: ConflictFile[] = [];
  private conflictTarget: string | null = null;

  constructor(private cfg: Config, private brain: Brain, private vaultDir: string) {
    this.keyFile = path.join(cfg.dataDir, "deploy_key");
    this.knownHosts = path.join(cfg.dataDir, "known_hosts");
    brain.on("changed", (p: string, source: ChangeSource) => this.track(p, source));
    brain.on("deleted", (p: string, source: ChangeSource) => this.track(p, source));
    brain.on("renamed", (a: string, b: string, source: ChangeSource) => {
      this.track(a, source);
      this.track(b, source);
    });
  }

  get git(): GitConfig {
    return this.cfg.data.git;
  }

  private serial<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(async () => {
      this.state.busy = name;
      this.emitStatus();
      try {
        return await fn();
      } finally {
        this.state.busy = null;
        this.emitStatus();
      }
    });
    this.lock = run.catch(() => undefined);
    return run;
  }

  private emitStatus() {
    this.brain.emit("gitStatus");
  }

  private env() {
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: `ssh -i "${this.keyFile}" -o IdentitiesOnly=yes -o UserKnownHostsFile="${this.knownHosts}" -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=15`,
      GIT_AUTHOR_NAME: this.git.authorName,
      GIT_AUTHOR_EMAIL: this.git.authorEmail,
      GIT_COMMITTER_NAME: this.git.authorName,
      GIT_COMMITTER_EMAIL: this.git.authorEmail,
    };
  }

  run(args: string[], opts: RunOpts = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        ["-c", "core.quotepath=false", "-c", "core.autocrlf=false", ...args],
        { cwd: opts.cwd ?? this.vaultDir, env: this.env(), maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, encoding: "utf8" },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
          if (code !== 0 && !opts.allowFail) {
            reject(new HttpError(500, `git ${args[0]} failed: ${(stderr || stdout || String(err)).trim().slice(0, 600)}`, "git"));
          } else resolve({ code, stdout, stderr });
        },
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
    });
  }

  private runCmd(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(cmd, args, { encoding: "utf8", timeout: 30_000 }, (err, stdout, stderr) => {
        resolve({ code: err ? 1 : 0, stdout, stderr: stderr || (err ? String(err.message) : "") });
      });
    });
  }

  isRepo(): boolean {
    return fs.existsSync(path.join(this.vaultDir, ".git"));
  }

  publicKey(): string | null {
    try {
      return fs.readFileSync(this.keyFile + ".pub", "utf8").trim();
    } catch {
      return null;
    }
  }

  // ---------- setup ----------

  /** Generate (once) an ed25519 deploy key and return its public half. */
  async ensureKey(regenerate = false): Promise<string> {
    if (regenerate) {
      for (const f of [this.keyFile, this.keyFile + ".pub"]) fs.rmSync(f, { force: true });
    }
    if (!fs.existsSync(this.keyFile)) {
      const r = await this.runCmd("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "brain-deploy-key", "-f", this.keyFile, "-q"]);
      if (r.code !== 0) throw new HttpError(500, `ssh-keygen failed: ${r.stderr}`, "keygen");
      fs.chmodSync(this.keyFile, 0o600);
    }
    return this.publicKey()!;
  }

  static parseRemote(remote: string): { host: string; port?: string } {
    const scp = remote.match(/^[^@\s]+@([^:\s]+):/);
    if (scp) return { host: scp[1] };
    const url = remote.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\//);
    if (url) return { host: url[1], port: url[2] };
    throw new HttpError(400, "Use an SSH remote such as git@github.com:you/vault.git", "remote");
  }

  /** Fetch the remote host key and its fingerprint (GitHub keys are pinned). */
  async scanHostKey(remote: string) {
    const { host, port } = GitSync.parseRemote(remote);
    const args = ["-t", "ed25519", ...(port ? ["-p", port] : []), host];
    const r = await this.runCmd("ssh-keyscan", args);
    const line = r.stdout.split("\n").find((l) => l && !l.startsWith("#"));
    if (!line) throw new HttpError(502, `Could not fetch the SSH host key of ${host}: ${r.stderr.trim()}`, "hostkey");
    const tmp = this.knownHosts + ".scan";
    fs.writeFileSync(tmp, line + "\n");
    const fp = await this.runCmd("ssh-keygen", ["-lf", tmp]);
    fs.rmSync(tmp, { force: true });
    const fingerprint = fp.stdout.split(/\s+/)[1] ?? "";
    const pinned = host === "github.com" ? GITHUB_FINGERPRINTS.ed25519 : null;
    return { host, line, fingerprint, pinned, matchesPinned: pinned ? pinned === fingerprint : null };
  }

  /**
   * Connect the vault to a remote. Handles: empty remote (push vault), empty
   * vault (clone remote), both non-empty (merge with unrelated histories; any
   * conflicts go to the resolver).
   */
  async connect(opts: { remote: string; branch: string; authorName: string; authorEmail: string; acceptFingerprint: string }) {
    return this.serial("connect", async () => {
      // Test hook: local bare repositories (no SSH) when explicitly allowed.
      const local = process.env.BRAIN_ALLOW_LOCAL_REMOTE === "1" && (opts.remote.startsWith("/") || opts.remote.startsWith("file://"));
      if (!local) {
        if (!fs.existsSync(this.keyFile)) throw new HttpError(400, "Generate the deploy key first", "nokey");
        const scan = await this.scanHostKey(opts.remote);
        if (scan.pinned && !scan.matchesPinned) throw new HttpError(400, `Host key for ${scan.host} does not match GitHub's published fingerprint. Refusing to connect.`, "hostkey");
        if (scan.fingerprint !== opts.acceptFingerprint) throw new HttpError(400, "The confirmed host fingerprint does not match the scanned one", "hostkey");
        fs.writeFileSync(this.knownHosts, scan.line + "\n", { mode: 0o600 });
      }

      Object.assign(this.cfg.data.git, {
        remote: opts.remote.trim(),
        branch: opts.branch.trim() || "main",
        authorName: opts.authorName.trim() || "Brain",
        authorEmail: opts.authorEmail.trim() || "brain@localhost",
      });

      const ls = await this.run(["ls-remote", "--heads", opts.remote], { cwd: this.cfg.dataDir, allowFail: true });
      if (ls.code !== 0) {
        throw new HttpError(400, `Cannot access the repository. Make sure the deploy key is added with write access. git said: ${ls.stderr.trim().slice(0, 400)}`, "access");
      }
      const branch = this.git.branch;
      const remoteHasBranch = ls.stdout.split("\n").some((l) => l.endsWith(`refs/heads/${branch}`));
      const remoteEmpty = ls.stdout.trim() === "";
      if (!remoteHasBranch && !remoteEmpty) {
        throw new HttpError(400, `Branch "${branch}" does not exist on the remote. Existing: ${ls.stdout.split("\n").filter(Boolean).map((l) => l.split("refs/heads/")[1]).join(", ")}`, "branch");
      }

      this.brain.vault.gitDepth++;
      try {
        if (!this.isRepo()) {
          await this.run(["init", "-q", "-b", branch]);
        }
        await this.ensureGitignore();
        await this.run(["remote", "remove", "origin"], { allowFail: true });
        await this.run(["remote", "add", "origin", this.git.remote]);
        await this.run(["add", "-A"]);
        const hasHead = (await this.run(["rev-parse", "--verify", "HEAD"], { allowFail: true })).code === 0;
        const staged = (await this.run(["diff", "--cached", "--quiet"], { allowFail: true })).code !== 0;
        if (staged || !hasHead) await this.run(["commit", "-q", "--allow-empty", "-m", "Initial vault commit"]);
        await this.run(["branch", "-M", branch]);

        if (remoteHasBranch) {
          await this.run(["fetch", "-q", "origin", branch]);
          await this.run(["branch", "--set-upstream-to", `origin/${branch}`], { allowFail: true });
          const merged = await this.mergeRemote(true);
          if (!merged) {
            this.git.enabled = true;
            this.cfg.save();
            return { connected: true, conflicts: this.conflicts.map((c) => c.path) };
          }
        }
        await this.run(["push", "-q", "-u", "origin", `HEAD:refs/heads/${branch}`]);
        this.state.lastPushAt = Date.now();
      } finally {
        setTimeout(() => this.brain.vault.gitDepth--, 1500);
      }
      this.git.enabled = true;
      this.cfg.save();
      await this.refreshCounts();
      return { connected: true, conflicts: [] as string[] };
    });
  }

  private async ensureGitignore() {
    const gi = path.join(this.vaultDir, ".gitignore");
    const want = [".trash/", "*.tmp", ".DS_Store"];
    let cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
    const missing = want.filter((w) => !cur.split("\n").includes(w));
    if (missing.length) {
      cur = (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + missing.join("\n") + "\n";
      fs.writeFileSync(gi, cur);
    }
  }

  disconnect() {
    this.git.enabled = false;
    this.cfg.save();
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.state.nextPushAt = null;
    this.emitStatus();
  }

  // ---------- auto-commit / push ----------

  private track(p: string, source: ChangeSource) {
    if (!this.git.enabled || source === "git") return;
    this.pending.set(p, source);
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => void this.commitPending().catch((e) => this.fail(e)), this.git.commitDelaySec * 1000);
    this.emitStatus();
  }

  private fail(e: unknown) {
    this.state.lastError = (e as Error).message ?? String(e);
    console.warn("[git]", this.state.lastError);
    this.emitStatus();
  }

  async commitPending(message?: string): Promise<boolean> {
    if (!this.git.enabled || !this.isRepo()) return false;
    return this.serial("commit", async () => this.commitPendingLocked(message));
  }

  private async commitPendingLocked(message?: string): Promise<boolean> {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    const entries = [...this.pending.entries()];
    this.pending.clear();
    // Stage everything (also picks up deletions/renames and external edits).
    await this.run(["add", "-A"]);
    const staged = (await this.run(["diff", "--cached", "--quiet"], { allowFail: true })).code !== 0;
    if (!staged) return false;
    const msg = message ?? commitMessage(entries);
    await this.run(["commit", "-q", "-m", msg]);
    this.state.lastCommitAt = Date.now();
    this.state.lastError = null;
    this.state.ahead++;
    this.schedulePush();
    return true;
  }

  private schedulePush() {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    const delay = this.git.pushDelaySec * 1000;
    this.state.nextPushAt = Date.now() + delay;
    this.pushTimer = setTimeout(() => {
      this.state.nextPushAt = null;
      void this.sync("auto").catch((e) => this.fail(e));
    }, delay);
    this.emitStatus();
  }

  // ---------- sync ----------

  /** Commit pending changes, fetch, merge remote changes (if no conflicts), push. */
  async sync(_reason: "auto" | "manual" | "pull" = "manual") {
    if (!this.git.enabled) throw new HttpError(400, "Git sync is not configured", "git_disabled");
    return this.serial("sync", async () => {
      await this.commitPendingLocked();
      await this.run(["fetch", "-q", "origin", this.git.branch]);
      this.state.lastFetchAt = Date.now();
      await this.refreshCounts();
      if (this.state.behind > 0) {
        const ok = await this.mergeRemote(false);
        if (!ok) return this.status();
      } else {
        this.conflicts = [];
        this.conflictTarget = null;
      }
      if (this.state.ahead > 0) {
        const push = await this.run(["push", "-q", "origin", `HEAD:refs/heads/${this.git.branch}`], { allowFail: true });
        if (push.code !== 0) {
          this.state.lastError = `Push failed: ${push.stderr.trim().slice(0, 300)}`;
          // Retry later (e.g. remote moved on); a later sync will merge first.
          this.schedulePush();
        } else {
          this.state.lastPushAt = Date.now();
          this.state.lastError = null;
          if (this.pushTimer) clearTimeout(this.pushTimer);
          this.state.nextPushAt = null;
        }
      }
      await this.refreshCounts();
      return this.status();
    });
  }

  private async refreshCounts() {
    const r = await this.run(["rev-list", "--left-right", "--count", `HEAD...origin/${this.git.branch}`], { allowFail: true });
    if (r.code === 0) {
      const [a, b] = r.stdout.trim().split(/\s+/).map(Number);
      this.state.ahead = a || 0;
      this.state.behind = b || 0;
    } else {
      const c = await this.run(["rev-list", "--count", "HEAD"], { allowFail: true });
      this.state.ahead = Number(c.stdout.trim()) || 0;
      this.state.behind = 0;
    }
  }

  /**
   * Merge origin/<branch> into HEAD. Uses merge-tree first; if conflicts exist,
   * nothing in the working tree is touched and conflicts are stored for the UI.
   * Returns true when merged (or nothing to merge).
   */
  private async mergeRemote(allowUnrelated: boolean): Promise<boolean> {
    const theirs = `origin/${this.git.branch}`;
    const mt = await this.run(["merge-tree", "--write-tree", "--name-only", ...(allowUnrelated ? ["--allow-unrelated-histories"] : []), "HEAD", theirs], { allowFail: true });
    if (mt.code > 1) throw new HttpError(500, `git merge-tree failed: ${mt.stderr.trim()}`, "git");
    if (mt.code === 0) {
      this.brain.vault.gitDepth++;
      try {
        const ff = await this.run(["merge", "-q", "--ff-only", theirs], { allowFail: true });
        if (ff.code !== 0) await this.run(["merge", "-q", "--no-edit", ...(allowUnrelated ? ["--allow-unrelated-histories"] : []), theirs]);
      } finally {
        setTimeout(() => this.brain.vault.gitDepth--, 1500);
      }
      this.conflicts = [];
      this.conflictTarget = null;
      await this.brain.rescan("git");
      await this.refreshCounts();
      return true;
    }
    // Conflicts: parse file names (lines after the tree OID up to the first blank line).
    const lines = mt.stdout.split("\n");
    const names: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "") break;
      names.push(lines[i]);
    }
    const baseR = await this.run(["merge-base", "HEAD", theirs], { allowFail: true });
    const base = baseR.code === 0 ? baseR.stdout.trim() : null;
    const show = async (rev: string | null, p: string) => {
      if (!rev) return null;
      const r = await this.run(["show", `${rev}:${p}`], { allowFail: true });
      return r.code === 0 ? r.stdout : null;
    };
    const theirsRev = (await this.run(["rev-parse", theirs])).stdout.trim();
    this.conflicts = [];
    for (const p of [...new Set(names)]) {
      const ours = await show("HEAD", p);
      const th = await show(theirsRev, p);
      const b = await show(base, p);
      const binary = [ours, th, b].some((x) => x !== null && x.includes("\0"));
      this.conflicts.push({ path: p, ours, theirs: th, base: b, binary });
    }
    this.conflictTarget = theirsRev;
    this.state.lastError = `${this.conflicts.length} file(s) changed both in the vault and on the remote. Resolve them to continue syncing.`;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.state.nextPushAt = null;
    this.emitStatus();
    return false;
  }

  /** Apply per-file choices and complete the merge. Every conflicted file must be resolved. */
  async resolve(resolutions: Record<string, { choice: "ours" | "theirs" | "manual"; content?: string }>) {
    return this.serial("resolve", async () => {
      if (!this.conflicts.length || !this.conflictTarget) throw new HttpError(400, "There are no conflicts to resolve", "no_conflicts");
      for (const c of this.conflicts) {
        const r = resolutions[c.path];
        if (!r) throw new HttpError(400, `Missing resolution for ${c.path}`, "incomplete");
        if (r.choice === "manual" && typeof r.content !== "string") throw new HttpError(400, `Manual resolution for ${c.path} needs content`, "incomplete");
      }
      await this.commitPendingLocked();
      const target = this.conflictTarget;
      const head = (await this.run(["rev-parse", "HEAD"])).stdout.trim();
      this.brain.vault.gitDepth++;
      try {
        const unrelated = (await this.run(["merge-base", "HEAD", target], { allowFail: true })).code !== 0;
        await this.run(["merge", "--no-commit", "--no-ff", ...(unrelated ? ["--allow-unrelated-histories"] : []), target], { allowFail: true });
        for (const c of this.conflicts) {
          const r = resolutions[c.path];
          const full = path.join(this.vaultDir, c.path);
          const content = r.choice === "ours" ? c.ours : r.choice === "theirs" ? c.theirs : r.content!;
          if (content === null) {
            fs.rmSync(full, { force: true });
            await this.run(["rm", "-q", "--cached", "--ignore-unmatch", "--", c.path]);
          } else {
            if (c.binary && r.choice !== "manual") {
              const rev = r.choice === "ours" ? head : target;
              await this.run(["checkout", rev, "--", c.path]);
            } else {
              fs.mkdirSync(path.dirname(full), { recursive: true });
              fs.writeFileSync(full, content);
            }
            await this.run(["add", "--", c.path]);
          }
        }
        const left = (await this.run(["diff", "--name-only", "--diff-filter=U"])).stdout.trim();
        if (left) throw new HttpError(500, `Unresolved files remain: ${left}`, "git");
        await this.run(["commit", "-q", "--no-edit", "-m", `Merge remote changes (resolved ${this.conflicts.length} conflict(s))`]);
      } catch (e) {
        await this.run(["merge", "--abort"], { allowFail: true });
        throw e;
      } finally {
        setTimeout(() => this.brain.vault.gitDepth--, 1500);
      }
      this.conflicts = [];
      this.conflictTarget = null;
      this.state.lastError = null;
      await this.brain.rescan("git");
      await this.refreshCounts();
      const push = await this.run(["push", "-q", "origin", `HEAD:refs/heads/${this.git.branch}`], { allowFail: true });
      if (push.code === 0) this.state.lastPushAt = Date.now();
      else this.state.lastError = `Push failed after resolving: ${push.stderr.trim().slice(0, 300)}`;
      await this.refreshCounts();
      return this.status();
    });
  }

  async log(limit = 30) {
    if (!this.isRepo()) return [];
    const r = await this.run(["log", `-n${limit}`, "--date=iso-strict", "--pretty=format:%H%x1f%ad%x1f%an%x1f%s"], { allowFail: true });
    if (r.code !== 0) return [];
    return r.stdout.split("\n").filter(Boolean).map((l) => {
      const [hash, date, author, subject] = l.split("\x1f");
      return { hash, date, author, subject };
    });
  }

  status(): GitStatus {
    return {
      enabled: this.git.enabled,
      remote: this.git.remote,
      branch: this.git.branch,
      hasKey: fs.existsSync(this.keyFile),
      publicKey: this.publicKey(),
      ahead: this.state.ahead,
      behind: this.state.behind,
      pendingCommit: this.pending.size,
      lastCommitAt: this.state.lastCommitAt,
      lastPushAt: this.state.lastPushAt,
      lastFetchAt: this.state.lastFetchAt,
      lastError: this.state.lastError,
      busy: this.state.busy,
      conflicts: this.conflicts.map((c) => c.path),
      nextPushAt: this.state.nextPushAt,
    };
  }

  /** Called at startup: commit anything changed while the server was down, then sync. */
  async start() {
    if (!this.git.enabled || !this.isRepo()) return;
    try {
      await this.serial("startup", async () => {
        await this.commitPendingLocked("Changes made while the server was offline");
      });
      await this.sync("auto");
    } catch (e) {
      this.fail(e);
    }
    // Periodic fetch so GitHub-side edits show up (every 5 minutes).
    setInterval(() => {
      if (this.git.enabled && !this.conflicts.length) void this.sync("auto").catch((e) => this.fail(e));
    }, 5 * 60_000).unref();
  }
}

function commitMessage(entries: [string, ChangeSource][]): string {
  if (entries.length === 0) return "Update vault";
  const sources = [...new Set(entries.map(([, s]) => s))].join("+");
  if (entries.length === 1) return `${sources}: ${entries[0][0]}`;
  const list = entries.slice(0, 10).map(([p]) => p);
  return `${sources}: ${entries.length} files\n\n${list.join("\n")}${entries.length > 10 ? "\n…" : ""}`;
}
