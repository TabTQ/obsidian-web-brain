import { api, type Meta, type TreeFile } from "../api";
import { basename, clear, debounce, dirname, h, highlightRanges, icon, isMd, stem } from "../dom";

// ---------------- context menu ----------------

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
}

export function contextMenu(e: MouseEvent, items: (MenuItem | "sep")[]) {
  e.preventDefault();
  document.querySelector(".menu")?.remove();
  const menu = h(
    "div",
    { class: "menu", role: "menu" },
    ...items.map((it) => (it === "sep" ? h("div", { class: "menu-sep" }) : h("div", { class: "menu-item" + (it.danger ? " danger" : ""), role: "menuitem", onclick: () => (menu.remove(), it.action()) }, it.label))),
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(e.clientX, window.innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - r.height - 8) + "px";
  const close = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener("mousedown", close, true);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close, true));
}

// ---------------- file tree ----------------

export interface TreeActions {
  open: (path: string, newTab: boolean) => void;
  newNote: (folder: string) => void;
  newFolder: (parent: string) => void;
  rename: (path: string, isFolder: boolean) => void;
  move: (from: string, toFolder: string) => void;
  remove: (path: string, isFolder: boolean) => void;
}

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: TreeFile[];
}

export class FileTree {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private collapsed: Set<string>;
  private active: string | null = null;
  private files: TreeFile[] = [];
  private folders: string[] = [];

  constructor(private actions: TreeActions) {
    try {
      this.collapsed = new Set(JSON.parse(localStorage.getItem("brain.collapsed") ?? "[]"));
    } catch {
      this.collapsed = new Set();
    }
    this.list = h("div", { class: "tree", role: "tree" });
    this.list.addEventListener("contextmenu", (e) => {
      if (e.target === this.list) contextMenu(e, [{ label: "New note", action: () => actions.newNote("") }, { label: "New folder", action: () => actions.newFolder("") }]);
    });
    this.dropTarget(this.list, "");
    this.el = h(
      "div",
      { class: "panel file-panel" },
      h(
        "div",
        { class: "panel-toolbar" },
        h("button", { class: "icon-btn", title: "New note", onclick: () => actions.newNote("") }, icon("edit")),
        h("button", { class: "icon-btn", title: "New folder", onclick: () => actions.newFolder("") }, icon("folderPlus")),
        h("button", { class: "icon-btn", title: "Collapse all", onclick: () => { this.folders.forEach((f) => this.collapsed.add(f)); this.saveCollapsed(); this.render(); } }, icon("collapse")),
      ),
      this.list,
    );
  }

  private saveCollapsed() {
    localStorage.setItem("brain.collapsed", JSON.stringify([...this.collapsed]));
  }

  setData(files: TreeFile[], folders: string[]) {
    this.files = files;
    this.folders = folders;
    this.render();
  }

  setActive(path: string | null) {
    this.active = path;
    this.list.querySelectorAll(".tree-item.is-active").forEach((e) => e.classList.remove("is-active"));
    if (!path) return;
    // expand parents
    let d = dirname(path);
    let changed = false;
    while (d) {
      if (this.collapsed.delete(d)) changed = true;
      d = dirname(d);
    }
    if (changed) {
      this.saveCollapsed();
      this.render();
    }
    this.list.querySelector(`.tree-item[data-path="${CSS.escape(path)}"]`)?.classList.add("is-active");
  }

  private build(): Dir {
    const root: Dir = { name: "", path: "", dirs: new Map(), files: [] };
    const dirFor = (p: string): Dir => {
      if (!p) return root;
      const parent = dirFor(dirname(p));
      let d = parent.dirs.get(basename(p));
      if (!d) {
        d = { name: basename(p), path: p, dirs: new Map(), files: [] };
        parent.dirs.set(d.name, d);
      }
      return d;
    };
    for (const f of this.folders) dirFor(f);
    for (const f of this.files) dirFor(dirname(f.path)).files.push(f);
    return root;
  }

  private render() {
    const scroll = this.list.scrollTop;
    clear(this.list);
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const renderDir = (d: Dir, depth: number, into: HTMLElement) => {
      const dirs = [...d.dirs.values()].sort((a, b) => coll.compare(a.name, b.name));
      for (const sub of dirs) {
        const isCollapsed = this.collapsed.has(sub.path);
        const row = h(
          "div",
          { class: "tree-item tree-folder" + (isCollapsed ? " is-collapsed" : ""), style: { paddingLeft: 8 + depth * 14 + "px" }, dataset: { path: sub.path }, draggable: true },
          h("span", { class: "tree-chevron" }, icon("chevron", 12)),
          h("span", { class: "tree-name" }, sub.name),
        );
        row.addEventListener("click", () => {
          if (isCollapsed) this.collapsed.delete(sub.path);
          else this.collapsed.add(sub.path);
          this.saveCollapsed();
          this.render();
        });
        row.addEventListener("contextmenu", (e) =>
          contextMenu(e, [
            { label: "New note", action: () => this.actions.newNote(sub.path) },
            { label: "New folder", action: () => this.actions.newFolder(sub.path) },
            "sep",
            { label: "Rename…", action: () => this.actions.rename(sub.path, true) },
            { label: "Delete", danger: true, action: () => this.actions.remove(sub.path, true) },
          ]),
        );
        this.dragSource(row, sub.path);
        this.dropTarget(row, sub.path);
        into.append(row);
        if (!isCollapsed) renderDir(sub, depth + 1, into);
      }
      for (const f of [...d.files].sort((a, b) => coll.compare(basename(a.path), basename(b.path)))) {
        const md = isMd(f.path);
        const row = h(
          "div",
          { class: "tree-item tree-file" + (f.path === this.active ? " is-active" : "") + (md ? "" : " is-attachment"), style: { paddingLeft: 22 + depth * 14 + "px" }, dataset: { path: f.path }, draggable: true, title: f.path },
          h("span", { class: "tree-name" }, md ? stem(f.path) : basename(f.path)),
          md ? null : h("span", { class: "tree-ext" }, f.path.split(".").pop()!.toUpperCase()),
        );
        row.addEventListener("click", (e) => this.actions.open(f.path, e.ctrlKey || e.metaKey));
        row.addEventListener("auxclick", (e) => e.button === 1 && this.actions.open(f.path, true));
        row.addEventListener("contextmenu", (e) =>
          contextMenu(e, [
            { label: "Open in new tab", action: () => this.actions.open(f.path, true) },
            { label: "Rename…", action: () => this.actions.rename(f.path, false) },
            { label: "Copy path", action: () => void navigator.clipboard?.writeText(f.path) },
            "sep",
            { label: "Delete", danger: true, action: () => this.actions.remove(f.path, false) },
          ]),
        );
        this.dragSource(row, f.path);
        into.append(row);
      }
    };
    renderDir(this.build(), 0, this.list);
    this.list.scrollTop = scroll;
  }

  private dragSource(el: HTMLElement, path: string) {
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("application/x-brain-path", path);
      e.dataTransfer?.setData("text/plain", `[[${isMd(path) ? stem(path) : basename(path)}]]`);
    });
  }

  private dropTarget(el: HTMLElement, folder: string) {
    el.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("application/x-brain-path")) {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add("is-drop");
      }
    });
    el.addEventListener("dragleave", () => el.classList.remove("is-drop"));
    el.addEventListener("drop", (e) => {
      el.classList.remove("is-drop");
      const p = e.dataTransfer?.getData("application/x-brain-path");
      if (!p) return;
      e.preventDefault();
      e.stopPropagation();
      if (p === folder || folder.startsWith(p + "/") || dirname(p) === folder) return;
      this.actions.move(p, folder);
    });
  }
}

// ---------------- search ----------------

export class SearchPanel {
  readonly el: HTMLElement;
  readonly input: HTMLInputElement;
  private results: HTMLElement;
  private info: HTMLElement;
  private run = debounce(() => void this.search(), 250);

  constructor(private open: (path: string, line: number | null, newTab: boolean) => void) {
    this.input = h("input", { class: "input", type: "search", placeholder: "Search… (file: path: tag: line:() [prop:value] /regex/)", spellcheck: false }) as HTMLInputElement;
    this.input.addEventListener("input", () => this.run());
    this.input.addEventListener("keydown", (e) => e.key === "Enter" && this.run.flush());
    this.info = h("div", { class: "search-info muted" });
    this.results = h("div", { class: "search-results" });
    this.el = h("div", { class: "panel search-panel" }, h("div", { class: "panel-pad" }, this.input, this.info), this.results);
  }

  setQuery(q: string) {
    this.input.value = q;
    void this.search();
    this.input.focus();
  }

  refresh() {
    if (this.input.value.trim()) this.run();
  }

  private async search() {
    const q = this.input.value.trim();
    clear(this.results);
    this.info.textContent = "";
    if (!q) return;
    try {
      const r = await api.search(q);
      this.info.textContent = `${r.results.length} result${r.results.length === 1 ? "" : "s"}`;
      for (const res of r.results) {
        const group = h("div", { class: "search-result" });
        const title = h("div", { class: "search-result-title", onclick: (e: MouseEvent) => this.open(res.path, null, e.ctrlKey || e.metaKey) }, isMd(res.path) ? res.path.replace(/\.md$/, "") : res.path);
        group.append(title);
        for (const m of res.matches.slice(0, 8)) {
          const start = Math.max(0, (m.ranges[0]?.[0] ?? 0) - 60);
          const text = m.text.slice(start, start + 200);
          const ranges = m.ranges.map(([a, b]) => [a - start, b - start] as [number, number]).filter(([a, b]) => a >= 0 && b <= text.length);
          group.append(h("div", { class: "search-match", onclick: (e: MouseEvent) => this.open(res.path, m.line, e.ctrlKey || e.metaKey) }, highlightRanges(text, ranges)));
        }
        this.results.append(group);
      }
    } catch (e) {
      this.info.textContent = (e as Error).message;
    }
  }
}

// ---------------- tags ----------------

export class TagsPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  constructor(private onTag: (tag: string) => void) {
    this.list = h("div", { class: "tags-list" });
    this.el = h("div", { class: "panel tags-panel" }, this.list);
  }
  async refresh() {
    const tags = await api.tags().catch(() => ({}) as Record<string, number>);
    clear(this.list);
    const entries = Object.entries(tags).sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" }));
    if (!entries.length) this.list.append(h("p", { class: "muted panel-pad" }, "No tags yet."));
    for (const [tag, n] of entries) {
      const depth = tag.split("/").length - 1;
      this.list.append(h("div", { class: "tag-row", style: { paddingLeft: 10 + depth * 14 + "px" }, onclick: () => this.onTag(tag) }, h("span", { class: "tag-name" }, depth ? tag.split("/").pop()! : tag), h("span", { class: "tag-count" }, String(n))));
    }
    return entries.map(([t]) => t);
  }
}

// ---------------- right sidebar ----------------

export class RightPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tab: "backlinks" | "outgoing" | "outline" | "properties";
  private path: string | null = null;
  private tabsEl: HTMLElement;

  constructor(private open: (path: string, line: number | null, newTab: boolean) => void, private onCreate: (link: string, source: string) => void) {
    this.tab = (localStorage.getItem("brain.rightTab") as RightPanel["tab"]) ?? "backlinks";
    this.body = h("div", { class: "right-body" });
    const tabBtn = (id: RightPanel["tab"], ic: string, title: string) => h("button", { class: "icon-btn right-tab", title, dataset: { tab: id }, onclick: () => this.show(id) }, icon(ic));
    this.tabsEl = h("div", { class: "panel-toolbar right-tabs" }, tabBtn("backlinks", "link", "Backlinks"), tabBtn("outgoing", "chevron", "Outgoing links"), tabBtn("outline", "list", "Outline"), tabBtn("properties", "tag", "Properties"));
    this.el = h("div", { class: "panel right-panel" }, this.tabsEl, this.body);
    this.markTab();
  }

  private markTab() {
    this.tabsEl.querySelectorAll(".right-tab").forEach((b) => b.classList.toggle("is-active", (b as HTMLElement).dataset.tab === this.tab));
  }

  show(tab: RightPanel["tab"]) {
    this.tab = tab;
    localStorage.setItem("brain.rightTab", tab);
    this.markTab();
    void this.refresh();
  }

  setNote(path: string | null) {
    this.path = path;
    void this.refresh();
  }

  async refresh() {
    const path = this.path;
    clear(this.body);
    if (!path || !isMd(path)) {
      this.body.append(h("p", { class: "muted panel-pad" }, "No note open."));
      return;
    }
    try {
      if (this.tab === "backlinks") await this.backlinks(path);
      else if (this.tab === "outgoing") await this.outgoing(path);
      else if (this.tab === "outline") await this.outline(path);
      else await this.properties(path);
    } catch (e) {
      this.body.append(h("p", { class: "muted panel-pad" }, (e as Error).message));
    }
  }

  private async backlinks(path: string) {
    const bl = await api.backlinks(path);
    const bySource = new Map<string, typeof bl>();
    for (const b of bl) (bySource.get(b.source) ?? bySource.set(b.source, []).get(b.source)!).push(b);
    this.body.append(h("div", { class: "right-heading" }, `Linked mentions (${bySource.size})`));
    if (!bl.length) this.body.append(h("p", { class: "muted panel-pad" }, "No backlinks found."));
    for (const [src, items] of bySource) {
      const g = h("div", { class: "backlink-group" }, h("div", { class: "backlink-title", onclick: (e: MouseEvent) => this.open(src, null, e.ctrlKey || e.metaKey) }, stem(src), h("span", { class: "count" }, String(items.length))));
      for (const it of items) g.append(h("div", { class: "backlink-context", onclick: (e: MouseEvent) => this.open(src, it.line, e.ctrlKey || e.metaKey) }, it.frontmatterKey ? `${it.frontmatterKey}: ` : "", it.context.trim().slice(0, 240)));
      this.body.append(g);
    }
  }

  private async outgoing(path: string) {
    const out = await api.outgoing(path);
    const resolved = out.filter((o) => o.resolved && o.resolved !== path);
    const unresolved = out.filter((o) => !o.resolved);
    const uniq = <T,>(arr: T[], key: (x: T) => string) => [...new Map(arr.map((x) => [key(x), x])).values()];
    this.body.append(h("div", { class: "right-heading" }, `Links (${uniq(resolved, (o) => o.resolved!).length})`));
    for (const o of uniq(resolved, (o) => o.resolved!)) this.body.append(h("div", { class: "link-row", onclick: (e: MouseEvent) => this.open(o.resolved!, null, e.ctrlKey || e.metaKey) }, isMd(o.resolved!) ? stem(o.resolved!) : basename(o.resolved!)));
    this.body.append(h("div", { class: "right-heading" }, `Unresolved (${uniq(unresolved, (o) => o.link).length})`));
    for (const o of uniq(unresolved, (o) => o.link)) this.body.append(h("div", { class: "link-row is-unresolved", title: "Click to create", onclick: () => this.onCreate(o.link, path) }, o.link));
  }

  private async outline(path: string) {
    const m = await api.meta(path);
    if (!m.headings.length) this.body.append(h("p", { class: "muted panel-pad" }, "No headings."));
    const min = Math.min(...m.headings.map((x) => x.level));
    for (const hd of m.headings) this.body.append(h("div", { class: "outline-row", style: { paddingLeft: 10 + (hd.level - min) * 14 + "px" }, onclick: () => this.open(path, hd.line, false) }, hd.heading));
  }

  private async properties(path: string) {
    const m: Meta = await api.meta(path);
    const fm = m.frontmatter ?? {};
    if (m.frontmatterError) this.body.append(h("p", { class: "error-text panel-pad" }, "Invalid frontmatter: " + m.frontmatterError));
    const table = h("div", { class: "props" });
    const fmt = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
    const parse = (old: unknown, s: string): unknown => {
      if (Array.isArray(old)) return s.split(",").map((x) => x.trim()).filter(Boolean);
      if (typeof old === "number") return Number(s);
      if (typeof old === "boolean") return s === "true";
      return s;
    };
    for (const [k, v] of Object.entries(fm)) {
      let input: HTMLInputElement;
      if (typeof v === "boolean") {
        input = h("input", { type: "checkbox", checked: v }) as HTMLInputElement;
        input.addEventListener("change", () => void api.setProperty(path, k, input.checked));
      } else {
        input = h("input", { class: "input prop-value", value: fmt(v) }) as HTMLInputElement;
        input.addEventListener("change", () => void api.setProperty(path, k, parse(v, input.value)));
      }
      table.append(h("div", { class: "prop-row" }, h("span", { class: "prop-key", title: k }, k), input, h("button", { class: "icon-btn", title: "Remove property", onclick: async () => { await api.removeProperty(path, k); void this.refresh(); } }, icon("x", 14))));
    }
    const key = h("input", { class: "input", placeholder: "Property name" }) as HTMLInputElement;
    const val = h("input", { class: "input", placeholder: "Value" }) as HTMLInputElement;
    const add = async () => {
      if (!key.value.trim()) return;
      const raw = val.value.trim();
      const value: unknown = raw === "true" ? true : raw === "false" ? false : raw !== "" && !isNaN(Number(raw)) ? Number(raw) : raw.includes(",") ? raw.split(",").map((x) => x.trim()) : raw;
      await api.setProperty(path, key.value.trim(), value);
      void this.refresh();
    };
    val.addEventListener("keydown", (e) => e.key === "Enter" && void add());
    this.body.append(h("div", { class: "right-heading" }, "Properties"), table, h("div", { class: "prop-add" }, key, val, h("button", { class: "btn btn-small", onclick: () => void add() }, "Add")));
    if (m.tags.length) this.body.append(h("div", { class: "right-heading" }, "Tags"), h("div", { class: "panel-pad" }, ...m.tags.map((t) => h("span", { class: "tag-pill", onclick: () => window.dispatchEvent(new CustomEvent("brain:search", { detail: `tag:${t}` })) }, t))));
  }
}
