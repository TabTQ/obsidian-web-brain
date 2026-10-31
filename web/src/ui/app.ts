// Application shell: layout, tabs, navigation, commands, live updates.

import { api, ApiError, subscribe, type GitStatus, type TreeFile, type VaultEvent } from "../api";
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT, basename, clear, debounce, dirname, ext, fileUrl, h, icon, isMd, stem } from "../dom";
import { completionData, NoteEditor } from "../editor/editor";
import { editorHooks } from "../editor/hooks";
import { conflictsView, renderGitStatus } from "./git";
import { GraphView } from "./graph";
import { confirmDialog, notice, prompt, suggest, type SuggestItem } from "./modal";
import { openSettings } from "./settings";
import { FileTree, RightPanel, SearchPanel, TagsPanel, contextMenu } from "./sidebar";

type TabKind = "note" | "file" | "graph" | "conflicts" | "empty";

interface Tab {
  id: number;
  kind: TabKind;
  path: string | null;
  el: HTMLElement;
  header: HTMLElement;
  editor?: NoteEditor;
  graph?: GraphView;
  banner?: HTMLElement;
  titleInput?: HTMLInputElement;
}

interface Command {
  id: string;
  name: string;
  hotkey?: string;
  run: () => void | Promise<void>;
  when?: () => boolean;
}

let tabSeq = 0;

export class App {
  private root: HTMLElement;
  private files: TreeFile[] = [];
  private folders: string[] = [];
  private byName = new Map<string, string[]>(); // lowercase basename -> paths
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private tabBar!: HTMLElement;
  private tabContent!: HTMLElement;
  private leftPane!: HTMLElement;
  private rightPane!: HTMLElement;
  private leftTab: "files" | "search" | "tags" = "files";
  private tree!: FileTree;
  private searchPanel!: SearchPanel;
  private tagsPanel!: TagsPanel;
  private right!: RightPanel;
  private status!: HTMLElement;
  private gitEl!: HTMLElement;
  private wordCount!: HTMLElement;
  private git: GitStatus | null = null;
  private commands: Command[] = [];
  livePreviewDefault = localStorage.getItem("brain.livePreview") !== "0";
  private refreshTree = debounce(() => void this.loadTree(), 250);
  private refreshRight = debounce(() => void this.right.refresh(), 400);

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async start() {
    this.buildLayout();
    this.installHooks();
    this.registerCommands();
    this.installKeys();
    await this.loadTree();
    this.git = await api.gitStatus().catch(() => null);
    this.renderGit();
    setInterval(() => this.renderGit(), 5000);
    subscribe({
      vault: (e) => this.onVaultEvent(e),
      git: (s) => {
        this.git = s;
        this.renderGit();
      },
      reconnect: () => {
        void this.loadTree();
        for (const t of this.tabs) if (t.kind === "note") void this.reloadIfChanged(t);
      },
    });
    window.addEventListener("brain:search", (e) => this.openSearch((e as CustomEvent).detail));
    window.addEventListener("beforeunload", (e) => {
      if (this.tabs.some((t) => t.editor?.dirty)) {
        for (const t of this.tabs) void t.editor?.saveNow();
        e.preventDefault();
      }
    });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.applyTheme());
    this.applyTheme();
    await this.restoreTabs();
  }

  private applyTheme() {
    const pref = localStorage.getItem("brain.theme") ?? "system";
    const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("theme-dark", dark);
    document.documentElement.classList.toggle("theme-light", !dark);
    for (const t of this.tabs) t.graph?.refreshTheme();
  }

  // ---------------- layout ----------------

  private buildLayout() {
    const ribbonBtn = (ic: string, title: string, fn: () => void) => h("button", { class: "icon-btn ribbon-btn", title, "aria-label": title, onclick: fn }, icon(ic, 18));
    const ribbon = h(
      "div",
      { class: "ribbon" },
      ribbonBtn("sidebarLeft", "Toggle left sidebar", () => this.toggleLeft()),
      ribbonBtn("files", "Files", () => this.showLeft("files")),
      ribbonBtn("search", "Search (Ctrl+Shift+F)", () => this.openSearch()),
      ribbonBtn("tag", "Tags", () => this.showLeft("tags")),
      ribbonBtn("graph", "Graph view", () => this.openGraph()),
      ribbonBtn("calendar", "Open today's daily note (Ctrl+Shift+D)", () => void this.openDaily()),
      ribbonBtn("command", "Command palette (Ctrl+P)", () => this.openPalette()),
      h("div", { class: "ribbon-spacer" }),
      ribbonBtn("settings", "Settings", () => this.settings()),
    );
    this.tree = new FileTree({
      open: (p, nt) => void this.openFile(p, nt),
      newNote: (folder) => void this.newNote(folder),
      newFolder: (parent) => void this.newFolder(parent),
      rename: (p, isFolder) => void this.renamePrompt(p, isFolder),
      move: (from, toFolder) => void this.doRename(from, (toFolder ? toFolder + "/" : "") + basename(from)),
      remove: (p, isFolder) => void this.deletePath(p, isFolder),
    });
    this.searchPanel = new SearchPanel((p, line, nt) => void this.openFile(p, nt, line ?? undefined));
    this.tagsPanel = new TagsPanel((tag) => this.openSearch(`tag:${tag}`));
    this.right = new RightPanel(
      (p, line, nt) => void this.openFile(p, nt, line ?? undefined),
      (link, source) => void this.openLink(link, source, false),
    );
    this.leftPane = h("div", { class: "sidebar sidebar-left" + (localStorage.getItem("brain.left") === "0" ? " is-collapsed" : "") });
    this.rightPane = h("div", { class: "sidebar sidebar-right" + (localStorage.getItem("brain.right") === "0" ? " is-collapsed" : "") }, this.right.el);
    this.tabBar = h("div", { class: "tab-bar" });
    this.tabContent = h("div", { class: "tab-content" });
    this.gitEl = h("span", { class: "status-git" });
    this.wordCount = h("span", { class: "status-item muted" });
    this.status = h("div", { class: "status-bar" }, this.wordCount, h("span", { class: "status-spacer" }), this.gitEl);
    const main = h(
      "div",
      { class: "main" },
      h("div", { class: "tab-strip" }, this.tabBar, h("button", { class: "icon-btn", title: "New tab", onclick: () => this.newEmptyTab() }, icon("plus")), h("button", { class: "icon-btn", title: "Toggle right sidebar", onclick: () => this.toggleRight() }, icon("sidebarRight"))),
      this.tabContent,
    );
    this.root.replaceChildren(h("div", { class: "app" }, ribbon, this.leftPane, main, this.rightPane), this.status);
    this.addResizer(this.leftPane, "left");
    this.addResizer(this.rightPane, "right");
    this.showLeft("files");
  }

  private addResizer(pane: HTMLElement, side: "left" | "right") {
    const key = `brain.width.${side}`;
    const w = Number(localStorage.getItem(key));
    if (w) pane.style.width = w + "px";
    const handle = h("div", { class: `resizer resizer-${side}` });
    pane.append(handle);
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = pane.getBoundingClientRect().width;
      const move = (ev: PointerEvent) => {
        const nw = Math.min(600, Math.max(180, startW + (side === "left" ? ev.clientX - startX : startX - ev.clientX)));
        pane.style.width = nw + "px";
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        localStorage.setItem(key, String(Math.round(pane.getBoundingClientRect().width)));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  private showLeft(tab: "files" | "search" | "tags") {
    this.leftTab = tab;
    this.leftPane.classList.remove("is-collapsed");
    localStorage.setItem("brain.left", "1");
    const resizer = this.leftPane.querySelector(".resizer");
    const panel = tab === "files" ? this.tree.el : tab === "search" ? this.searchPanel.el : this.tagsPanel.el;
    this.leftPane.replaceChildren(
      h(
        "div",
        { class: "panel-tabs" },
        ...(["files", "search", "tags"] as const).map((t) => h("button", { class: "panel-tab" + (t === tab ? " is-active" : ""), onclick: () => this.showLeft(t) }, t[0].toUpperCase() + t.slice(1))),
      ),
      panel,
    );
    if (resizer) this.leftPane.append(resizer);
    if (tab === "tags") void this.tagsPanel.refresh();
  }

  private toggleLeft() {
    const c = this.leftPane.classList.toggle("is-collapsed");
    localStorage.setItem("brain.left", c ? "0" : "1");
  }
  private toggleRight() {
    const c = this.rightPane.classList.toggle("is-collapsed");
    localStorage.setItem("brain.right", c ? "0" : "1");
  }

  openSearch(q?: string) {
    this.showLeft("search");
    if (q !== undefined) this.searchPanel.setQuery(q);
    else this.searchPanel.input.focus();
  }

  private renderGit() {
    renderGitStatus(this.gitEl, this.git, { openConflicts: () => this.openConflicts(), openSettings: () => this.settings("Git sync") });
  }

  private settings(tab?: string) {
    openSettings({
      tab,
      onChange: () => {
        void this.loadTree();
        void api.gitStatus().then((s) => {
          this.git = s;
          this.renderGit();
        });
      },
      prefs: {
        livePreview: this.livePreviewDefault,
        setLivePreview: (v) => {
          this.livePreviewDefault = v;
          localStorage.setItem("brain.livePreview", v ? "1" : "0");
          for (const t of this.tabs) t.editor?.setLivePreview(v);
        },
      },
    });
  }

  // ---------------- data ----------------

  private async loadTree() {
    const t = await api.tree();
    this.files = t.files;
    this.folders = t.folders;
    this.byName.clear();
    for (const f of t.files) {
      const k = basename(f.path).toLowerCase();
      (this.byName.get(k) ?? this.byName.set(k, []).get(k)!).push(f.path);
    }
    this.tree.setData(t.files, t.folders);
    this.tree.setActive(this.active?.path ?? null);
    completionData.files = t.files.map((f) => f.path).sort((a, b) => Number(isMd(b)) - Number(isMd(a)));
    if (this.leftTab === "tags") void this.tagsPanel.refresh();
    void api.tags().then((tags) => (completionData.tags = Object.keys(tags)));
  }

  private shortestLink(path: string) {
    const same = this.byName.get(basename(path).toLowerCase()) ?? [];
    if (same.length <= 1) return isMd(path) ? stem(path) : basename(path);
    return isMd(path) ? path.replace(/\.md$/i, "") : path;
  }

  private linkExists(link: string) {
    const l = link.replace(/^\/+/, "");
    const key = basename(l).toLowerCase();
    const cands = this.byName.get(key) ?? this.byName.get(key + ".md");
    if (!cands) return false;
    if (!l.includes("/")) return true;
    const lp = l.toLowerCase();
    return cands.some((c) => c.toLowerCase() === lp || c.toLowerCase() === lp + ".md" || c.toLowerCase().endsWith("/" + lp) || c.toLowerCase().endsWith("/" + lp + ".md"));
  }

  private installHooks() {
    editorHooks.navigate = (link, source, newTab) => void this.openLink(link, source, newTab);
    editorHooks.linkExists = (link) => this.linkExists(link);
    editorHooks.searchTag = (tag) => this.openSearch(`tag:#${tag}`);
    completionData.shortest = (p) => this.shortestLink(p);
  }

  // ---------------- tabs ----------------

  private makeTab(kind: TabKind, path: string | null): Tab {
    const tab: Tab = { id: ++tabSeq, kind, path, el: h("div", { class: "view" }), header: h("div", { class: "tab" }) };
    return tab;
  }

  private renderTabHeader(t: Tab) {
    clear(t.header);
    t.header.className = "tab" + (t === this.active ? " is-active" : "") + (t.editor?.dirty ? " is-dirty" : "");
    const title = t.kind === "graph" ? "Graph view" : t.kind === "conflicts" ? "Sync conflicts" : t.kind === "empty" ? "New tab" : isMd(t.path!) ? stem(t.path!) : basename(t.path!);
    t.header.title = t.path ?? title;
    t.header.append(h("span", { class: "tab-title" }, title), h("button", { class: "tab-close", title: "Close", onclick: (e: Event) => { e.stopPropagation(); this.closeTab(t); } }, icon("x", 12)));
    t.header.onclick = () => this.activate(t);
    t.header.onauxclick = (e) => e.button === 1 && this.closeTab(t);
    t.header.oncontextmenu = (e) => contextMenu(e, [{ label: "Close", action: () => this.closeTab(t) }, { label: "Close others", action: () => this.tabs.filter((x) => x !== t).forEach((x) => this.closeTab(x)) }]);
  }

  private addTab(t: Tab, replace: boolean) {
    if (replace && this.active) {
      const i = this.tabs.indexOf(this.active);
      this.destroyTab(this.active);
      this.tabs[i] = t;
      this.active.header.replaceWith(t.header);
    } else {
      this.tabs.push(t);
      this.tabBar.append(t.header);
    }
    this.activate(t);
  }

  activate(t: Tab) {
    this.active = t;
    for (const x of this.tabs) this.renderTabHeader(x);
    this.tabContent.replaceChildren(t.el);
    this.tree.setActive(t.path);
    this.right.setNote(t.kind === "note" ? t.path : null);
    this.updateWordCount();
    document.title = (t.path ? stem(t.path) + " — " : "") + "Brain";
    t.header.scrollIntoView({ block: "nearest", inline: "nearest" });
    this.persistTabs();
  }

  private destroyTab(t: Tab) {
    t.editor?.destroy();
    t.graph?.destroy();
  }

  closeTab(t: Tab) {
    const i = this.tabs.indexOf(t);
    if (i === -1) return;
    this.destroyTab(t);
    this.tabs.splice(i, 1);
    t.header.remove();
    if (this.active === t) {
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next);
      else this.newEmptyTab();
    }
    this.persistTabs();
  }

  newEmptyTab() {
    const t = this.makeTab("empty", null);
    t.el.append(
      h(
        "div",
        { class: "empty-state" },
        h("h2", null, "No file is open"),
        h("div", { class: "empty-actions" }, h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); void this.newNote(""); } }, "Create new note (Ctrl+N)"), h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); this.openSwitcher(); } }, "Go to file (Ctrl+O)"), h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); void this.openDaily(); } }, "Open today's daily note"), h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); this.openGraph(); } }, "Open graph view")),
      ),
    );
    this.addTab(t, false);
  }

  private persistTabs() {
    const state = { tabs: this.tabs.filter((t) => t.path || t.kind === "graph").map((t) => ({ kind: t.kind, path: t.path })), active: this.active ? this.tabs.indexOf(this.active) : 0 };
    localStorage.setItem("brain.tabs", JSON.stringify(state));
  }

  private async restoreTabs() {
    let state: { tabs: { kind: TabKind; path: string | null }[]; active: number } | null = null;
    try {
      state = JSON.parse(localStorage.getItem("brain.tabs") ?? "null");
    } catch {
      state = null;
    }
    const valid = (state?.tabs ?? []).filter((t) => t.kind === "graph" || (t.path && this.files.some((f) => f.path === t.path)));
    if (!valid.length) return this.newEmptyTab();
    for (const t of valid) {
      if (t.kind === "graph") this.openGraph(true);
      else await this.openFile(t.path!, true);
    }
    const a = this.tabs[Math.min(state?.active ?? 0, this.tabs.length - 1)];
    if (a) this.activate(a);
  }

  // ---------------- opening ----------------

  private findTab(path: string) {
    return this.tabs.find((t) => t.path === path);
  }

  async openFile(path: string, newTab = false, line?: number, subpath?: string) {
    const existing = this.findTab(path);
    if (existing) {
      this.activate(existing);
      if (line !== undefined) existing.editor?.scrollToLine(line);
      else if (subpath) void this.scrollToSubpath(existing, subpath);
      return;
    }
    const replace = !newTab && !!this.active && (this.active.kind === "empty" || (this.active.kind !== "conflicts" && !this.active.editor?.dirty));
    if (isMd(path)) {
      let note;
      try {
        note = await api.note(path);
      } catch (e) {
        notice((e as Error).message, "error");
        return;
      }
      const t = this.makeTab("note", path);
      this.buildNoteView(t, note);
      this.addTab(t, replace);
      if (line !== undefined) t.editor!.scrollToLine(line);
      else if (subpath) void this.scrollToSubpath(t, subpath);
    } else {
      const t = this.makeTab("file", path);
      this.buildFileView(t);
      this.addTab(t, replace);
    }
  }

  private async scrollToSubpath(t: Tab, subpath: string) {
    if (!t.editor) return;
    const text = t.editor.getValue().split("\n");
    const sp = subpath.replace(/^#/, "");
    let idx = -1;
    if (sp.startsWith("^")) idx = text.findIndex((l) => new RegExp(`\\s\\^${sp.slice(1)}\\s*$`, "i").test(l) || l.trim() === `^${sp.slice(1)}`);
    else {
      const want = sp.split("#").pop()!.trim().toLowerCase();
      idx = text.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s+/, "").replace(/\s+#+\s*$/, "").trim().toLowerCase() === want);
    }
    if (idx >= 0) t.editor.scrollToLine(idx);
  }

  async openLink(link: string, source: string, newTab: boolean) {
    const hash = link.indexOf("#");
    const linkPath = hash === -1 ? link : link.slice(0, hash);
    const subpath = hash === -1 ? "" : link.slice(hash);
    if (!linkPath) {
      const t = this.findTab(source);
      if (t && subpath) void this.scrollToSubpath(t, subpath);
      return;
    }
    const r = await api.resolve(linkPath, source).catch(() => ({ path: null }));
    if (r.path) return this.openFile(r.path, newTab, undefined, subpath || undefined);
    // Unresolved: create the note (Obsidian behavior).
    const settings = await api.settings();
    const target = (linkPath.includes("/") ? linkPath : (settings.newNoteFolder ? settings.newNoteFolder + "/" : "") + linkPath).replace(/\.md$/i, "") + ".md";
    try {
      const c = await api.create(target, "");
      await this.loadTree();
      await this.openFile(c.path, newTab);
    } catch (e) {
      notice((e as Error).message, "error");
    }
  }

  private buildNoteView(t: Tab, note: { path: string; content: string; etag: string; mtime: number; ctime: number }) {
    const titleInput = h("input", { class: "inline-title", value: stem(note.path), spellcheck: false }) as HTMLInputElement;
    t.titleInput = titleInput;
    const commitTitle = () => {
      const v = titleInput.value.trim().replace(/[\\/:*?"<>|#^[\]]/g, " ").trim();
      if (!v || v === stem(t.path!)) return void (titleInput.value = stem(t.path!));
      const dir = dirname(t.path!);
      void this.doRename(t.path!, (dir ? dir + "/" : "") + v + ".md");
    };
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitTitle();
        t.editor?.focus();
      } else if (e.key === "Escape") {
        titleInput.value = stem(t.path!);
        t.editor?.focus();
      }
    });
    titleInput.addEventListener("blur", commitTitle);
    const crumbs = h("div", { class: "view-crumbs" });
    const modeBtn = h("button", { class: "icon-btn", title: "Toggle live preview / source (Ctrl+E)" }, icon("book"));
    const moreBtn = h("button", { class: "icon-btn", title: "More" }, icon("list"));
    const header = h("div", { class: "view-header" }, crumbs, h("div", { class: "view-actions" }, modeBtn, moreBtn));
    const banner = h("div", { class: "view-banner", hidden: true });
    t.banner = banner;
    const editor = new NoteEditor(
      note,
      {
        onSaved: () => {
          this.renderTabHeader(t);
          this.refreshRight();
          this.updateWordCount();
        },
        onDirtyChange: () => this.renderTabHeader(t),
        onConflict: (msg) => this.showConflictBanner(t, msg),
        onError: (msg) => notice(msg, "error", 8000),
      },
      this.livePreviewDefault,
    );
    t.editor = editor;
    const setCrumbs = () => {
      clear(crumbs);
      const dir = dirname(t.path!);
      if (dir) crumbs.append(h("span", { class: "crumb muted" }, dir.split("/").join(" / ") + " / "));
      crumbs.append(h("span", { class: "crumb" }, stem(t.path!)));
      modeBtn.replaceChildren(icon(editor.isLivePreview ? "book" : "edit"));
      modeBtn.title = editor.isLivePreview ? "Live preview (click for source mode)" : "Source mode (click for live preview)";
    };
    setCrumbs();
    (t as Tab & { setCrumbs?: () => void }).setCrumbs = setCrumbs;
    modeBtn.addEventListener("click", () => {
      editor.setLivePreview(!editor.isLivePreview);
      setCrumbs();
    });
    moreBtn.addEventListener("click", (e) =>
      contextMenu(e, [
        { label: "Rename / move…", action: () => void this.renamePrompt(t.path!, false) },
        { label: "Copy path", action: () => void navigator.clipboard?.writeText(t.path!) },
        { label: "Copy wikilink", action: () => void navigator.clipboard?.writeText(`[[${this.shortestLink(t.path!)}]]`) },
        { label: "Open local graph", action: () => this.openGraph(false, true) },
        { label: "Insert template…", action: () => void this.insertTemplate() },
        "sep",
        { label: "Delete note", danger: true, action: () => void this.deletePath(t.path!, false) },
      ]),
    );
    editor.view.dom.addEventListener("keyup", () => this.updateWordCount());
    t.el.className = "view note-view";
    t.el.replaceChildren(header, banner, h("div", { class: "note-scroll" }, h("div", { class: "note-inner" }, titleInput, editor.el)));
  }

  private buildFileView(t: Tab) {
    const p = t.path!;
    const e = ext(p);
    const url = fileUrl(p);
    let body: HTMLElement;
    if (IMAGE_EXT.has(e)) body = h("img", { src: url, class: "file-image", alt: basename(p) });
    else if (e === "pdf") body = h("iframe", { src: url, class: "file-pdf", title: p });
    else if (AUDIO_EXT.has(e) && e !== "webm") body = h("audio", { src: url, controls: true });
    else if (VIDEO_EXT.has(e)) body = h("video", { src: url, controls: true, class: "file-video" });
    else body = h("div", { class: "empty-state" }, h("p", null, "This file type can't be previewed."), h("a", { href: url, target: "_blank", rel: "noopener" }, "Download " + basename(p)));
    t.el.className = "view file-view";
    t.el.replaceChildren(h("div", { class: "view-header" }, h("div", { class: "view-crumbs" }, p)), h("div", { class: "file-body" }, body));
  }

  openGraph(newTab = false, local = false) {
    const existing = this.tabs.find((t) => t.kind === "graph");
    if (existing && !local) return this.activate(existing);
    if (local) localStorage.setItem("brain.graph", JSON.stringify({ ...JSON.parse(localStorage.getItem("brain.graph") ?? "{}"), local: true }));
    const activePath = this.active?.kind === "note" ? this.active.path : null;
    const t = this.makeTab("graph", null);
    const g = new GraphView(() => activePath ?? this.tabs.find((x) => x.kind === "note")?.path ?? null, (p, nt) => void this.openFile(p, nt));
    t.graph = g;
    t.el.className = "view graph-tab";
    t.el.append(g.el);
    this.addTab(t, !newTab && this.active?.kind === "empty");
    if (existing && local) this.closeTab(existing);
  }

  openConflicts() {
    const existing = this.tabs.find((t) => t.kind === "conflicts");
    if (existing) {
      existing.el.replaceChildren(conflictsView(() => void this.afterResolve()));
      return this.activate(existing);
    }
    const t = this.makeTab("conflicts", null);
    t.el.className = "view conflicts-tab";
    t.el.append(conflictsView(() => void this.afterResolve()));
    this.addTab(t, false);
  }

  private async afterResolve() {
    await this.loadTree();
    for (const t of this.tabs) if (t.kind === "note") await this.reloadIfChanged(t);
  }

  // ---------------- actions ----------------

  async newNote(folder: string, name = "Untitled") {
    const settings = await api.settings().catch(() => null);
    const dir = folder || settings?.newNoteFolder || "";
    let n = name;
    for (let i = 1; this.files.some((f) => f.path.toLowerCase() === ((dir ? dir + "/" : "") + n + ".md").toLowerCase()); i++) n = `${name} ${i}`;
    try {
      const r = await api.create((dir ? dir + "/" : "") + n + ".md", "");
      await this.loadTree();
      await this.openFile(r.path, false);
      const t = this.findTab(r.path);
      t?.titleInput?.focus();
      t?.titleInput?.select();
    } catch (e) {
      notice((e as Error).message, "error");
    }
  }

  async newFolder(parent: string) {
    const name = await prompt("New folder", "", { placeholder: "Folder name" });
    if (!name) return;
    try {
      await api.mkdir((parent ? parent + "/" : "") + name);
      await this.loadTree();
    } catch (e) {
      notice((e as Error).message, "error");
    }
  }

  async renamePrompt(path: string, isFolder: boolean) {
    const next = await prompt(isFolder ? "Rename folder" : "Rename / move note", path, { okText: "Rename", selectStem: !isFolder });
    if (!next || next === path) return;
    await this.doRename(path, isFolder || ext(next) ? next : next + (isMd(path) ? ".md" : ""));
  }

  async doRename(from: string, to: string) {
    const t = this.findTab(from);
    if (t?.editor?.dirty) await t.editor.saveNow();
    try {
      const r = await api.rename(from, to);
      if (r.linksUpdated) notice(`Updated ${r.linksUpdated} link${r.linksUpdated === 1 ? "" : "s"} in ${r.filesUpdated} file${r.filesUpdated === 1 ? "" : "s"}.`, "success");
      this.applyRename(r.from, r.to);
      await this.loadTree();
    } catch (e) {
      notice((e as Error).message, "error");
      if (t?.titleInput) t.titleInput.value = stem(from);
    }
  }

  private applyRename(from: string, to: string) {
    for (const t of this.tabs) {
      if (!t.path) continue;
      let np: string | null = null;
      if (t.path === from) np = to;
      else if (t.path.startsWith(from + "/")) np = to + t.path.slice(from.length);
      if (!np) continue;
      t.path = np;
      t.editor?.setPath(np);
      if (t.titleInput) t.titleInput.value = stem(np);
      (t as Tab & { setCrumbs?: () => void }).setCrumbs?.();
      this.renderTabHeader(t);
    }
    this.tree.setActive(this.active?.path ?? null);
    if (this.active?.kind === "note") this.right.setNote(this.active.path);
    this.persistTabs();
  }

  async deletePath(path: string, isFolder: boolean) {
    const ok = await confirmDialog(isFolder ? "Delete folder" : "Delete note", `Move "${path}" ${isFolder ? "and everything inside it " : ""}to the trash? You can restore it from Settings → Trash.`, "Delete", true);
    if (!ok) return;
    try {
      await api.remove(path);
      for (const t of [...this.tabs]) if (t.path === path || t.path?.startsWith(path + "/")) this.closeTab(t);
      await this.loadTree();
    } catch (e) {
      notice((e as Error).message, "error");
    }
  }

  async openDaily(date?: string) {
    try {
      const r = await api.daily(date);
      if (r.created) await this.loadTree();
      await this.openFile(r.path, false);
    } catch (e) {
      notice((e as Error).message, "error");
    }
  }

  private async adjacentDaily(dir: "prev" | "next") {
    if (!this.active?.path) return;
    const r = await api.adjacentDaily(this.active.path, dir);
    if (r.path) await this.openFile(r.path, false);
    else notice(`No ${dir === "prev" ? "previous" : "next"} daily note found.`);
  }

  async insertTemplate() {
    const t = this.active;
    if (!t?.editor) return notice("Open a note first.");
    const list = await api.templates();
    if (!list.length) return notice("No templates found. Put notes in the template folder (Settings → Vault).");
    suggest({
      placeholder: "Choose a template…",
      items: () => list.map((p) => ({ label: stem(p), detail: p, value: p })),
      onChoose: async (it) => {
        const r = await api.renderTemplate(it.value, stem(t.path!));
        t.editor?.insertAtCursor(r.text);
      },
    });
  }

  private insertDate(kind: "date" | "time") {
    const t = this.active;
    if (!t?.editor) return;
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    t.editor.insertAtCursor(kind === "date" ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`);
  }

  openSwitcher() {
    const recent = new Map(this.files.map((f) => [f.path, f.mtime]));
    suggest<string | null>({
      placeholder: "Find or create a note…",
      instructions: "↑↓ navigate · ↵ open · Ctrl+↵ open in new tab · Shift+↵ create",
      items: () =>
        [...this.files]
          .sort((a, b) => (recent.get(b.path) ?? 0) - (recent.get(a.path) ?? 0))
          .map((f) => ({ label: isMd(f.path) ? f.path.replace(/\.md$/i, "") : f.path, value: f.path as string | null })),
      extra: (q) => (q.trim() ? { label: `Create "${q.trim()}"`, value: null, hint: "Shift ↵" } : null),
      onChoose: (it, e) => {
        const q = (document.querySelector(".suggest-input") as HTMLInputElement | null)?.value?.trim();
        if (it.value === null || (e as KeyboardEvent).shiftKey) {
          const name = q || "Untitled";
          void this.openLink(name, this.active?.path ?? "", e.ctrlKey || e.metaKey);
        } else void this.openFile(it.value, e.ctrlKey || e.metaKey);
      },
    });
  }

  openPalette() {
    suggest<Command>({
      placeholder: "Type a command…",
      items: () => this.commands.filter((c) => !c.when || c.when()).map((c): SuggestItem<Command> => ({ label: c.name, hint: c.hotkey, value: c })),
      onChoose: (it) => void it.value.run(),
    });
  }

  private registerCommands() {
    const hasNote = () => this.active?.kind === "note";
    const git = (fn: () => Promise<unknown>, ok: string) => async () => {
      try {
        await fn();
        notice(ok, "success");
      } catch (e) {
        notice((e as Error).message, "error");
      }
    };
    this.commands = [
      { id: "switcher", name: "Quick switcher: open note", hotkey: "Ctrl+O", run: () => this.openSwitcher() },
      { id: "new", name: "Create new note", hotkey: "Ctrl+N", run: () => this.newNote("") },
      { id: "new-folder", name: "Create new folder", run: () => this.newFolder("") },
      { id: "daily", name: "Daily notes: open today's note", hotkey: "Ctrl+Shift+D", run: () => this.openDaily() },
      { id: "daily-prev", name: "Daily notes: open previous daily note", run: () => this.adjacentDaily("prev"), when: hasNote },
      { id: "daily-next", name: "Daily notes: open next daily note", run: () => this.adjacentDaily("next"), when: hasNote },
      { id: "template", name: "Templates: insert template", run: () => this.insertTemplate(), when: hasNote },
      { id: "date", name: "Templates: insert current date", run: () => this.insertDate("date"), when: hasNote },
      { id: "time", name: "Templates: insert current time", run: () => this.insertDate("time"), when: hasNote },
      { id: "search", name: "Search: search in all files", hotkey: "Ctrl+Shift+F", run: () => this.openSearch() },
      { id: "find", name: "Search: find in current note", hotkey: "Ctrl+F", run: () => this.active?.editor?.focus(), when: hasNote },
      { id: "graph", name: "Graph view: open graph view", hotkey: "Ctrl+G", run: () => this.openGraph() },
      { id: "local-graph", name: "Graph view: open local graph", run: () => this.openGraph(false, true), when: hasNote },
      { id: "toggle-lp", name: "Toggle live preview / source mode", hotkey: "Ctrl+E", run: () => this.toggleMode(), when: hasNote },
      { id: "rename", name: "Rename / move current note", run: () => this.renamePrompt(this.active!.path!, false), when: hasNote },
      { id: "delete", name: "Delete current note", run: () => this.deletePath(this.active!.path!, false), when: hasNote },
      { id: "copy-link", name: "Copy wikilink to current note", run: () => void navigator.clipboard?.writeText(`[[${this.shortestLink(this.active!.path!)}]]`), when: hasNote },
      { id: "outline", name: "Show outline", run: () => this.showRight("outline"), when: hasNote },
      { id: "backlinks", name: "Show backlinks", run: () => this.showRight("backlinks"), when: hasNote },
      { id: "outgoing", name: "Show outgoing links", run: () => this.showRight("outgoing"), when: hasNote },
      { id: "properties", name: "Show properties", run: () => this.showRight("properties"), when: hasNote },
      { id: "close", name: "Close current tab", hotkey: "Ctrl+W", run: () => this.active && this.closeTab(this.active) },
      { id: "left", name: "Toggle left sidebar", run: () => this.toggleLeft() },
      { id: "right", name: "Toggle right sidebar", run: () => this.toggleRight() },
      { id: "git-commit", name: "Git: commit now", run: git(() => api.gitCommit("Manual commit"), "Committed") },
      { id: "git-sync", name: "Git: sync now (commit, pull, push)", run: git(() => api.gitSync(), "Synced") },
      { id: "git-pull", name: "Git: pull from remote", run: git(() => api.gitPull(), "Pulled") },
      { id: "git-conflicts", name: "Git: resolve conflicts", run: () => this.openConflicts() },
      { id: "settings", name: "Open settings", hotkey: "Ctrl+,", run: () => this.settings() },
      { id: "mcp", name: "Show MCP access (token & Claude Code command)", run: () => this.settings("MCP access") },
      { id: "trash", name: "Open trash", run: () => this.settings("Trash") },
      {
        id: "theme",
        name: "Toggle light/dark theme",
        run: () => {
          const cur = document.documentElement.classList.contains("theme-dark") ? "dark" : "light";
          localStorage.setItem("brain.theme", cur === "dark" ? "light" : "dark");
          this.applyTheme();
        },
      },
      { id: "logout", name: "Log out", run: async () => { await api.logout(); location.reload(); } },
    ];
  }

  private showRight(tab: "backlinks" | "outgoing" | "outline" | "properties") {
    this.rightPane.classList.remove("is-collapsed");
    this.right.show(tab);
  }

  private toggleMode() {
    const t = this.active;
    if (!t?.editor) return;
    t.editor.setLivePreview(!t.editor.isLivePreview);
    (t as Tab & { setCrumbs?: () => void }).setCrumbs?.();
  }

  private installKeys() {
    document.addEventListener(
      "keydown",
      (e) => {
        const mod = e.ctrlKey || e.metaKey;
        if (!mod) return;
        const k = e.key.toLowerCase();
        const run = (fn: () => void) => {
          e.preventDefault();
          e.stopPropagation();
          fn();
        };
        if (k === "o" && !e.shiftKey) run(() => this.openSwitcher());
        else if (k === "p" && !e.shiftKey) run(() => this.openPalette());
        else if (k === "n" && !e.shiftKey) run(() => void this.newNote(""));
        else if (k === "e" && !e.shiftKey) run(() => this.toggleMode());
        else if (k === "f" && e.shiftKey) run(() => this.openSearch());
        else if (k === "d" && e.shiftKey) run(() => void this.openDaily());
        else if (k === "g" && !e.shiftKey) run(() => this.openGraph());
        else if (k === "w" && !e.shiftKey && this.active) run(() => this.closeTab(this.active!));
        else if (k === ",") run(() => this.settings());
      },
      true,
    );
  }

  private updateWordCount() {
    const t = this.active;
    if (!t?.editor) {
      this.wordCount.textContent = "";
      return;
    }
    const text = t.editor.getValue().replace(/^---\n[\s\S]*?\n---\n?/, "");
    const words = (text.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
    this.wordCount.textContent = `${words} word${words === 1 ? "" : "s"} · ${text.length} characters`;
  }

  // ---------------- live updates ----------------

  private showConflictBanner(t: Tab, msg: string) {
    const b = t.banner!;
    b.hidden = false;
    b.replaceChildren(
      h("span", null, icon("alert", 14), " ", msg),
      h("button", { class: "btn btn-small", onclick: async () => { b.hidden = true; await this.reloadIfChanged(t, true); } }, "Load latest (discard my unsaved edits)"),
      h("button", { class: "btn btn-small btn-danger", onclick: async () => { b.hidden = true; await t.editor?.saveNow(true); } }, "Overwrite with mine"),
    );
  }

  private async reloadIfChanged(t: Tab, force = false) {
    if (!t.editor || !t.path) return;
    try {
      const n = await api.note(t.path);
      if (n.etag === t.editor.etag && !force) return;
      if (t.editor.dirty && !force) return this.showConflictBanner(t, "This note was changed elsewhere (another device or Claude) while you have unsaved edits.");
      t.editor.replaceContent(n.content, n.etag);
      this.renderTabHeader(t);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) this.closeTab(t);
    }
  }

  private onVaultEvent(e: VaultEvent) {
    if (e.type === "rename" && e.from && e.to) this.applyRename(e.from, e.to);
    if (e.type === "delete" && e.path) {
      for (const t of [...this.tabs]) if (t.path === e.path && !t.editor?.dirty) this.closeTab(t);
    }
    if (e.type === "change" && e.path) {
      const t = this.findTab(e.path);
      if (t?.editor && e.etag !== t.editor.etag) void this.reloadIfChanged(t);
    }
    if (e.type === "reload") for (const t of this.tabs) if (t.kind === "note") void this.reloadIfChanged(t);
    this.refreshTree();
    this.refreshRight();
    this.searchPanel.refresh();
    for (const t of this.tabs) if (t.graph) void t.graph.reload();
  }
}
