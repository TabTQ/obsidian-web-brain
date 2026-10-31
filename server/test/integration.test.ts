import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type App } from "../src/app.js";

process.env.BRAIN_ALLOW_LOCAL_REMOTE = "1";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function boot(dataDir = tmp("brain-data-"), vaultDir = path.join(dataDir, "vault")) {
  const app = await createApp({ dataDir, vaultDir, host: "127.0.0.1", port: 0, webDir: tmp("brain-web-"), dev: true });
  const port = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";
  const req = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: { "Content-Type": "application/json", "X-Brain-Request": "1", ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: r.status, json: json as Record<string, unknown> & unknown[] };
  };
  return { app, base, req, dataDir, vaultDir, setCookie: (c: string) => (cookie = c) };
}

describe("http + auth + mcp", () => {
  let s: Awaited<ReturnType<typeof boot>>;
  let token = "";

  beforeAll(async () => {
    s = await boot();
  });
  afterAll(async () => {
    await s.app.close();
  });

  it("requires setup with the one-time code, then issues token and session", async () => {
    expect((await s.req("GET", "/api/v1/tree")).status).toBe(503);
    expect((await s.req("POST", "/api/v1/setup", { code: "wrong", password: "longpassword" })).status).toBe(403);
    const code = fs.readFileSync(path.join(s.dataDir, "setup-code.txt"), "utf8").trim();
    const r = await s.req("POST", "/api/v1/setup", { code, password: "longpassword" });
    expect(r.status).toBe(200);
    token = r.json.mcpToken as string;
    expect(token).toMatch(/^brain_/);
    expect(fs.existsSync(path.join(s.dataDir, "setup-code.txt"))).toBe(false);
    expect((fs.statSync(path.join(s.dataDir, "config.json")).mode & 0o777).toString(8)).toBe("600");
    expect((await s.req("GET", "/api/v1/tree")).status).toBe(200);
  });

  it("rejects unauthenticated, wrong password, and CSRF-less cookie writes", async () => {
    s.setCookie("");
    expect((await s.req("GET", "/api/v1/tree")).status).toBe(401);
    expect((await s.req("POST", "/api/v1/auth/login", { password: "nope-nope" })).status).toBe(401);
    expect((await s.req("POST", "/api/v1/auth/login", { password: "longpassword" })).status).toBe(200);
    const r = await fetch(s.base + "/api/v1/note", { method: "POST", headers: { Cookie: (await s.req("GET", "/api/v1/auth/me")) && "" }, body: "{}" });
    expect(r.status).toBe(401);
    const noHeader = await s.req("POST", "/api/v1/note", { path: "x.md" }, { "X-Brain-Request": "0" });
    expect(noHeader.status).toBe(403);
    const evil = await s.req("GET", "/api/v1/tree", undefined, { Origin: "http://evil.example" });
    expect(evil.status).toBe(403);
  });

  it("CRUD over HTTP with stale-write rejection", async () => {
    const c = await s.req("POST", "/api/v1/note", { path: "Inbox/First.md", content: "hello [[Second]]" });
    expect(c.status).toBe(200);
    const read = await s.req("GET", "/api/v1/note?path=" + encodeURIComponent("Inbox/First.md"));
    const etag = read.json.etag as string;
    expect((await s.req("PUT", "/api/v1/note", { path: "Inbox/First.md", content: "v2", etag })).status).toBe(200);
    const stale = await s.req("PUT", "/api/v1/note", { path: "Inbox/First.md", content: "v3", etag });
    expect(stale.status).toBe(409);
    expect(String(stale.json.error)).toMatch(/Stale write rejected/);
    expect((await s.req("GET", "/api/v1/note?path=../../etc/passwd")).status).toBe(400);
  });

  it("serves MCP to the official SDK client with bearer auth", async () => {
    const unauth = await fetch(s.base + "/mcp", { method: "POST", body: "{}" });
    expect(unauth.status).toBe(401);
    const client = new Client({ name: "test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(s.base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("search_notes");
    const created = await client.callTool({ name: "create_note", arguments: { path: "Memory/Decision.md", content: "We chose [[Postgres]] #decision" } });
    expect(created.isError).toBe(false);
    const found = await client.callTool({ name: "search_notes", arguments: { query: "tag:#decision" } });
    expect(JSON.stringify(found.content)).toContain("Memory/Decision.md");
    const read = await client.callTool({ name: "read_note", arguments: { path: "Decision" } });
    const note = JSON.parse((read.content as { text: string }[])[0].text);
    expect(note.content).toContain("Postgres");
    const stale = await client.callTool({ name: "update_note", arguments: { path: "Decision", content: "x", etag: "bogus" } });
    expect(stale.isError).toBe(true);
    const daily = await client.callTool({ name: "daily_note", arguments: { append: "- session summary" } });
    expect(JSON.stringify(daily.content)).toContain("session summary");
    const bad = await client.callTool({ name: "read_note", arguments: { path: "Missing note" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
}

describe("git sync", () => {
  it("connects to an empty remote, auto-commits, pulls remote edits, and resolves conflicts", async () => {
    const remote = tmp("brain-remote-");
    git(remote, "init", "-q", "--bare", "-b", "main");
    const s = await boot();
    s.app.cfg.data.git.commitDelaySec = 0.2;
    s.app.cfg.data.git.pushDelaySec = 3600;
    await s.app.cfg.setPassword("longpassword");
    s.app.cfg.rotateToken();
    await s.req("POST", "/api/v1/auth/login", { password: "longpassword" });

    await s.app.brain.write("A.md", "line1\n", { source: "ui" });
    const conn = await s.req("POST", "/api/v1/git/connect", { remote, branch: "main", authorName: "Me", authorEmail: "me@x", fingerprint: "" });
    expect(conn.status).toBe(200);
    expect(git(remote, "log", "--oneline", "main")).toMatch(/Initial vault commit/);

    // auto-commit on save
    await s.app.brain.write("B.md", "bee\n", { source: "ui" });
    await new Promise((r) => setTimeout(r, 900));
    const sync = await s.req("POST", "/api/v1/git/sync");
    expect(sync.status).toBe(200);
    expect(git(remote, "log", "--oneline", "main")).toMatch(/ui: B\.md/);

    // edit on the remote side (like editing on GitHub)
    const clone = tmp("brain-clone-");
    git(clone, "clone", "-q", remote, ".");
    fs.writeFileSync(path.join(clone, "Remote.md"), "from github\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-q", "-m", "remote edit");
    git(clone, "push", "-q", "origin", "main");
    await s.req("POST", "/api/v1/git/pull");
    expect(fs.readFileSync(path.join(s.vaultDir, "Remote.md"), "utf8")).toBe("from github\n");
    expect(s.app.brain.index.files.has("Remote.md")).toBe(true);

    // conflicting edits on both sides
    fs.writeFileSync(path.join(clone, "A.md"), "remote version\n");
    git(clone, "commit", "-qam", "remote A");
    git(clone, "push", "-q", "origin", "main");
    const { etag } = await s.app.brain.read("A.md");
    await s.app.brain.write("A.md", "local version\n", { source: "ui", ifMatch: etag });
    await new Promise((r) => setTimeout(r, 600));
    const st = await s.req("POST", "/api/v1/git/sync");
    expect((st.json as { conflicts: string[] }).conflicts).toEqual(["A.md"]);
    // working tree untouched (no conflict markers)
    expect(fs.readFileSync(path.join(s.vaultDir, "A.md"), "utf8")).toBe("local version\n");
    const conflicts = await s.req("GET", "/api/v1/git/conflicts");
    expect(conflicts.json[0]).toMatchObject({ path: "A.md", ours: "local version\n", theirs: "remote version\n" });
    const resolved = await s.req("POST", "/api/v1/git/resolve", { resolutions: { "A.md": { choice: "manual", content: "merged by hand\n" } } });
    expect(resolved.status).toBe(200);
    expect(fs.readFileSync(path.join(s.vaultDir, "A.md"), "utf8")).toBe("merged by hand\n");
    git(clone, "pull", "-q", "origin", "main");
    expect(fs.readFileSync(path.join(clone, "A.md"), "utf8")).toBe("merged by hand\n");
    expect(fs.readFileSync(path.join(clone, ".gitignore"), "utf8")).toContain(".trash/");
    await s.app.close();
  }, 30_000);
});
