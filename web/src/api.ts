// HTTP client for /api/v1 plus the live event stream.

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, raw?: BodyInit): Promise<T> {
  const headers: Record<string, string> = { "X-Brain-Request": "1" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch("/api/v1" + path, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    credentials: "same-origin",
  });
  const text = await r.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) {
    const d = data as { error?: string; code?: string } | null;
    if (r.status === 401 && d?.code === "unauthenticated") onUnauthorized?.();
    throw new ApiError(r.status, d?.error ?? `HTTP ${r.status}`, d?.code);
  }
  return data as T;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

const q = (o: Record<string, string | number | boolean | undefined | null>) =>
  "?" +
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

export interface Note {
  path: string;
  content: string;
  etag: string;
  mtime: number;
  ctime: number;
}
export interface TreeFile {
  path: string;
  size: number;
  mtime: number;
  ctime: number;
}
export interface SearchResult {
  path: string;
  matches: { line: number; text: string; ranges: [number, number][] }[];
  nameMatch: boolean;
}
export interface Backlink {
  source: string;
  line: number;
  original: string;
  context: string;
  embed: boolean;
  frontmatterKey?: string;
}
export interface Outgoing {
  link: string;
  subpath: string;
  original: string;
  line: number;
  embed: boolean;
  resolved: string | null;
}
export interface Meta {
  path: string;
  frontmatter: Record<string, unknown> | null;
  frontmatterError?: string;
  headings: { heading: string; level: number; line: number }[];
  tags: string[];
  aliases: string[];
  tasks: { status: string; text: string; line: number }[];
}
export interface Settings {
  dailyFolder: string;
  dailyFormat: string;
  dailyTemplate: string;
  templatesFolder: string;
  attachmentFolder: string;
  newNoteFolder: string;
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
export interface Conflict {
  path: string;
  ours: string | null;
  theirs: string | null;
  base: string | null;
  binary: boolean;
}
export interface GraphData {
  nodes: { id: string; type: "note" | "attachment" | "tag" | "unresolved"; label: string; weight: number }[];
  links: { source: string; target: string }[];
}

export const api = {
  setupStatus: () => request<{ setupComplete: boolean }>("GET", "/setup/status"),
  setup: (code: string, password: string) => request<{ ok: boolean; mcpToken: string }>("POST", "/setup", { code, password }),
  login: (password: string) => request<{ ok: boolean }>("POST", "/auth/login", { password }),
  logout: () => request("POST", "/auth/logout"),
  me: () => request("GET", "/auth/me"),
  token: () => request<{ token: string }>("GET", "/auth/token"),
  rotateToken: () => request<{ token: string }>("POST", "/auth/token/rotate"),
  changePassword: (current: string, next: string) => request("POST", "/auth/password", { current, next }),

  tree: () => request<{ files: TreeFile[]; folders: string[] }>("GET", "/tree"),
  note: (path: string) => request<Note>("GET", "/note" + q({ path })),
  meta: (path: string) => request<Meta>("GET", "/meta" + q({ path })),
  save: (path: string, content: string, etag?: string | null) => request<{ path: string; etag: string }>("PUT", "/note", { path, content, etag }),
  create: (path: string | undefined, content = "", template?: string) => request<{ path: string; etag: string }>("POST", "/note", { path, content, template }),
  append: (path: string, text: string) => request<{ path: string; etag: string }>("POST", "/note/append", { path, text }),
  rename: (from: string, to: string) => request<{ from: string; to: string; linksUpdated: number; filesUpdated: number }>("POST", "/rename", { from, to }),
  remove: (path: string) => request<{ path: string; trashedTo: string }>("DELETE", "/note" + q({ path })),
  mkdir: (path: string) => request("POST", "/folder", { path }),
  upload: (name: string, data: Blob, note?: string) => request<{ path: string; link: string }>("POST", "/attachment" + q({ name, note }), undefined, data),
  backlinks: (path: string) => request<Backlink[]>("GET", "/backlinks" + q({ path })),
  outgoing: (path: string) => request<Outgoing[]>("GET", "/outgoing" + q({ path })),
  resolve: (link: string, source: string) => request<{ path: string | null }>("GET", "/resolve" + q({ link, source })),
  search: (query: string, limit = 200) => request<{ query: string; results: SearchResult[] }>("GET", "/search" + q({ q: query, limit })),
  switcher: (query: string, limit = 50) => request<{ path: string; alias?: string; score: number; ranges: [number, number][] }[]>("GET", "/switcher" + q({ q: query, limit })),
  tags: () => request<Record<string, number>>("GET", "/tags"),
  properties: () => request<{ name: string; type: string; count: number }[]>("GET", "/properties"),
  propertyValues: (key: string) => request<unknown[]>("GET", "/properties/values" + q({ key })),
  setProperty: (path: string, key: string, value: unknown) => request("POST", "/property", { path, key, value }),
  removeProperty: (path: string, key: string) => request("DELETE", "/property" + q({ path, key })),
  graph: (o: { showTags?: boolean; showAttachments?: boolean; hideUnresolved?: boolean; showOrphans?: boolean }) =>
    request<GraphData>("GET", "/graph" + q({ showTags: o.showTags ? 1 : 0, showAttachments: o.showAttachments ? 1 : 0, hideUnresolved: o.hideUnresolved ? 1 : 0, showOrphans: o.showOrphans === false ? 0 : 1 })),
  templates: () => request<string[]>("GET", "/templates"),
  renderTemplate: (path: string, title: string) => request<{ text: string }>("GET", "/template/render" + q({ path, title })),
  daily: (date?: string) => request<{ path: string; created: boolean }>("POST", "/daily", { date }),
  adjacentDaily: (path: string, dir: "prev" | "next") => request<{ path: string | null }>("GET", "/daily/adjacent" + q({ path, dir })),
  trash: () => request<TreeFile[]>("GET", "/trash"),
  restore: (path: string) => request<{ path: string }>("POST", "/trash/restore", { path }),
  settings: () => request<Settings>("GET", "/settings"),
  saveSettings: (s: Partial<Settings>) => request<Settings>("PUT", "/settings", s),

  gitStatus: () => request<GitStatus>("GET", "/git/status"),
  gitLog: () => request<{ hash: string; date: string; author: string; subject: string }[]>("GET", "/git/log"),
  gitKey: (regenerate = false) => request<{ publicKey: string }>("POST", "/git/key", { regenerate }),
  gitHostKey: (remote: string) => request<{ host: string; fingerprint: string; pinned: string | null; matchesPinned: boolean | null }>("POST", "/git/hostkey", { remote }),
  gitConnect: (o: { remote: string; branch: string; authorName: string; authorEmail: string; fingerprint: string }) => request<{ connected: boolean; conflicts: string[] }>("POST", "/git/connect", o),
  gitDisconnect: () => request<GitStatus>("POST", "/git/disconnect"),
  gitCommit: (message?: string) => request<{ committed: boolean; status: GitStatus }>("POST", "/git/commit", { message }),
  gitSync: () => request<GitStatus>("POST", "/git/sync"),
  gitPull: () => request<GitStatus>("POST", "/git/pull"),
  gitConflicts: () => request<Conflict[]>("GET", "/git/conflicts"),
  gitResolve: (resolutions: Record<string, { choice: "ours" | "theirs" | "manual"; content?: string }>) => request<GitStatus>("POST", "/git/resolve", { resolutions }),
};

export interface VaultEvent {
  type: "change" | "delete" | "rename" | "folder" | "reload";
  path?: string;
  from?: string;
  to?: string;
  etag?: string;
  source?: string;
}

/** Subscribe to server-sent events; reconnects automatically. */
export function subscribe(handlers: { vault: (e: VaultEvent) => void; git: (s: GitStatus) => void; reconnect: () => void }) {
  let es: EventSource | null = null;
  let first = true;
  const open = () => {
    es = new EventSource("/api/v1/events");
    es.addEventListener("hello", () => {
      if (!first) handlers.reconnect();
      first = false;
    });
    es.addEventListener("vault", (m) => handlers.vault(JSON.parse((m as MessageEvent).data)));
    es.addEventListener("git", (m) => handlers.git(JSON.parse((m as MessageEvent).data)));
    es.onerror = () => {
      es?.close();
      setTimeout(open, 3000);
    };
  };
  open();
  return () => es?.close();
}
