import { h, clear, highlightRanges } from "../dom";

export function notice(message: string, kind: "info" | "error" | "success" = "info", ms = 4000) {
  let host = document.querySelector<HTMLElement>(".notices");
  if (!host) {
    host = h("div", { class: "notices" });
    document.body.append(host);
  }
  const el = h("div", { class: `notice notice-${kind}`, role: "status" }, message);
  el.addEventListener("click", () => el.remove());
  host.append(el);
  if (ms > 0) setTimeout(() => el.remove(), ms);
  return el;
}

export class Modal {
  readonly root: HTMLElement;
  readonly box: HTMLElement;
  readonly content: HTMLElement;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  };
  onClose: (() => void) | null = null;

  constructor(title?: string, cls = "") {
    this.content = h("div", { class: "modal-content" });
    this.box = h(
      "div",
      { class: `modal ${cls}`, role: "dialog", "aria-modal": "true" },
      title ? h("div", { class: "modal-title" }, title) : null,
      h("button", { class: "modal-close", "aria-label": "Close", onclick: () => this.close() }, "×"),
      this.content,
    );
    this.root = h("div", { class: "modal-bg" }, this.box);
    this.root.addEventListener("mousedown", (e) => {
      if (e.target === this.root) this.close();
    });
  }

  open() {
    document.body.append(this.root);
    document.addEventListener("keydown", this.onKey, true);
    return this;
  }

  close() {
    document.removeEventListener("keydown", this.onKey, true);
    this.root.remove();
    this.onClose?.();
  }
}

export function prompt(title: string, initial = "", opts: { placeholder?: string; okText?: string; selectStem?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const m = new Modal(title, "modal-prompt");
    let done = false;
    const input = h("input", { class: "input", type: "text", value: initial, placeholder: opts.placeholder ?? "" }) as HTMLInputElement;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose = () => finish(null);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(input.value.trim() || null);
      }
    });
    m.content.append(
      input,
      h("div", { class: "modal-buttons" }, h("button", { class: "btn", onclick: () => finish(null) }, "Cancel"), h("button", { class: "btn btn-primary", onclick: () => finish(input.value.trim() || null) }, opts.okText ?? "OK")),
    );
    m.open();
    input.focus();
    if (opts.selectStem) {
      const dot = initial.lastIndexOf(".");
      const slash = initial.lastIndexOf("/");
      input.setSelectionRange(slash + 1, dot > slash ? dot : initial.length);
    } else input.select();
  });
}

export function confirmDialog(title: string, message: string, okText = "OK", danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const m = new Modal(title);
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    m.onClose = () => finish(false);
    const ok = h("button", { class: `btn ${danger ? "btn-danger" : "btn-primary"}`, onclick: () => finish(true) }, okText);
    m.content.append(h("p", null, message), h("div", { class: "modal-buttons" }, h("button", { class: "btn", onclick: () => finish(false) }, "Cancel"), ok));
    m.open();
    ok.focus();
  });
}

/** Fuzzy scoring (same algorithm as the server, from the traced prepareFuzzySearch). */
export function fuzzy(query: string, text: string): { score: number; ranges: [number, number][] } | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, ranges: [] };
  const tl = text.toLowerCase();
  const ranges: [number, number][] = [];
  let ti = 0;
  for (const ch of q) {
    const idx = tl.indexOf(ch, ti);
    if (idx === -1) return null;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === idx) last[1] = idx + 1;
    else ranges.push([idx, idx + 1]);
    ti = idx + 1;
  }
  const gaps = ranges.length - 1;
  const spread = ranges[ranges.length - 1][1] - ranges[0][0] - q.length;
  return { score: -gaps - spread / 10 - ranges[0][0] / 100 - text.length / 1000, ranges };
}

export interface SuggestItem<T> {
  label: string;
  detail?: string;
  hint?: string;
  value: T;
}

/** Keyboard-driven fuzzy picker (quick switcher, command palette, template picker). */
export function suggest<T>(opts: {
  placeholder: string;
  items: () => SuggestItem<T>[];
  onChoose: (item: SuggestItem<T>, e: KeyboardEvent | MouseEvent) => void;
  emptyText?: string;
  extra?: (query: string) => SuggestItem<T> | null;
  instructions?: string;
}) {
  const m = new Modal(undefined, "modal-suggest");
  const input = h("input", { class: "input suggest-input", type: "text", placeholder: opts.placeholder }) as HTMLInputElement;
  const list = h("div", { class: "suggest-list", role: "listbox" });
  const all = opts.items();
  let shown: { item: SuggestItem<T>; ranges: [number, number][] }[] = [];
  let sel = 0;
  const render = () => {
    const q = input.value;
    const scored: { item: SuggestItem<T>; ranges: [number, number][]; score: number }[] = [];
    for (const it of all) {
      const s = fuzzy(q, it.label);
      if (!s) continue;
      // Prefer matches inside the last path segment (file name), like Obsidian's switcher.
      const cut = it.label.lastIndexOf("/") + 1;
      const tail = cut > 0 ? fuzzy(q, it.label.slice(cut)) : null;
      if (tail && tail.score + 1 > s.score) scored.push({ item: it, ranges: tail.ranges.map(([a, b]) => [a + cut, b + cut] as [number, number]), score: tail.score + 1 });
      else scored.push({ item: it, ranges: s.ranges, score: s.score });
    }
    if (q) scored.sort((a, b) => b.score - a.score);
    shown = scored.slice(0, 80);
    const extra = opts.extra?.(q);
    if (extra) shown.push({ item: extra, ranges: [] });
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    clear(list);
    if (!shown.length) list.append(h("div", { class: "suggest-empty" }, opts.emptyText ?? "No matches"));
    shown.forEach((s, i) => {
      const row = h(
        "div",
        { class: "suggest-item" + (i === sel ? " is-selected" : ""), role: "option" },
        h("div", { class: "suggest-label" }, highlightRanges(s.item.label, s.ranges)),
        s.item.detail ? h("div", { class: "suggest-detail" }, s.item.detail) : null,
        s.item.hint ? h("span", { class: "suggest-hint" }, s.item.hint) : null,
      );
      row.addEventListener("mousemove", () => {
        if (sel !== i) {
          sel = i;
          updateSel();
        }
      });
      row.addEventListener("click", (e) => {
        m.close();
        opts.onChoose(s.item, e);
      });
      list.append(row);
    });
  };
  const updateSel = () => {
    [...list.children].forEach((c, i) => c.classList.toggle("is-selected", i === sel));
    list.children[sel]?.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", () => {
    sel = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      sel = Math.min(shown.length - 1, sel + 1);
      updateSel();
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      sel = Math.max(0, sel - 1);
      updateSel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = shown[sel];
      if (s) {
        m.close();
        opts.onChoose(s.item, e);
      }
    }
  });
  m.content.append(input, list, opts.instructions ? h("div", { class: "suggest-instructions" }, opts.instructions) : "");
  m.open();
  input.focus();
  render();
  return m;
}
