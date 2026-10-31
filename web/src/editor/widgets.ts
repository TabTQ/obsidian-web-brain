// CodeMirror widgets used by live preview.

import { WidgetType, type EditorView } from "@codemirror/view";
import { h } from "../dom";
import { renderEmbed, renderMarkdownHtml, renderMath, renderMermaid, hydrate, calloutKind } from "../render/markdown";
import { editorHooks } from "./hooks";

export class EmbedWidget extends WidgetType {
  constructor(readonly target: string, readonly display: string, readonly source: string, readonly inline: boolean) {
    super();
  }
  eq(o: EmbedWidget) {
    return o.target === this.target && o.display === this.display && o.source === this.source && o.inline === this.inline;
  }
  toDOM() {
    const el = h("span", { class: "cm-embed internal-embed" + (this.inline ? " is-inline" : "") });
    void renderEmbed(el, this.target, this.display, { source: this.source, depth: 1 }, (l, nt) => editorHooks.navigate(l, this.source, nt));
    return el;
  }
  ignoreEvent() {
    return true;
  }
  get estimatedHeight() {
    return 120;
  }
}

export class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) {
    super();
  }
  eq(o: MathWidget) {
    return o.tex === this.tex && o.display === this.display;
  }
  toDOM() {
    const el = h(this.display ? "div" : "span", { class: this.display ? "cm-math-block" : "cm-math-inline" });
    el.innerHTML = renderMath(this.tex, this.display);
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** Rendered markdown block (callouts, tables) that reveals its source on click. */
export class BlockWidget extends WidgetType {
  constructor(readonly src: string, readonly source: string, readonly kind: string, readonly from: number) {
    super();
  }
  eq(o: BlockWidget) {
    return o.src === this.src && o.kind === this.kind && o.source === this.source;
  }
  toDOM(view: EditorView) {
    const el = h("div", { class: `cm-block-widget cm-${this.kind}-widget markdown-rendered` });
    el.innerHTML = renderMarkdownHtml(this.src);
    hydrate(el, { source: this.source, depth: 1 }, (l, nt) => editorHooks.navigate(l, this.source, nt));
    const edit = h("button", { class: "cm-widget-edit", title: "Edit source", "aria-label": "Edit source" }, "</>");
    edit.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from + Math.min(3, this.src.length) } });
      view.focus();
    });
    el.append(edit);
    el.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("a, input, button, audio, video, iframe")) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from + Math.min(3, this.src.length) } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
  get estimatedHeight() {
    return 80;
  }
}

export class MermaidWidget extends WidgetType {
  constructor(readonly code: string, readonly from: number) {
    super();
  }
  eq(o: MermaidWidget) {
    return o.code === this.code;
  }
  toDOM(view: EditorView) {
    const el = h("div", { class: "cm-block-widget mermaid-block" });
    void renderMermaid(el, this.code);
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from + 4 } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

export class CodeHeaderWidget extends WidgetType {
  constructor(readonly lang: string, readonly code: string) {
    super();
  }
  eq(o: CodeHeaderWidget) {
    return o.lang === this.lang && o.code === this.code;
  }
  toDOM() {
    const copy = h("button", { class: "cm-code-copy", title: "Copy" }, "Copy");
    copy.addEventListener("mousedown", (e) => {
      e.preventDefault();
      void navigator.clipboard?.writeText(this.code).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      });
    });
    return h("div", { class: "cm-code-header" }, h("span", { class: "cm-code-lang" }, LANG_LABELS[this.lang] ?? this.lang), copy);
  }
  ignoreEvent() {
    return true;
  }
}

const LANG_LABELS: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript", py: "Python", python: "Python",
  sh: "Shell", bash: "Bash", zsh: "Zsh", json: "JSON", yaml: "YAML", yml: "YAML", md: "Markdown", html: "HTML", css: "CSS",
  go: "Go", rust: "Rust", rs: "Rust", java: "Java", c: "C", cpp: "C++", sql: "SQL", toml: "TOML", "": "",
};

export class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return h("span", { class: "cm-hr" }, h("hr"));
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly markerFrom: number) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.markerFrom === this.markerFrom;
  }
  toDOM(view: EditorView) {
    const box = h("input", { type: "checkbox", class: "task-checkbox", checked: this.checked }) as HTMLInputElement;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      // Find the marker "[ ]" after the bullet on this line.
      const line = view.state.doc.lineAt(pos);
      const m = line.text.match(/^(\s*(?:[-*+]|\d+[.)])\s+)\[(.)\]/);
      if (!m) return;
      const at = line.from + m[1].length + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === " " ? "x" : " " } });
    });
    return h("span", { class: "cm-task" }, h("span", { class: "cm-list-bullet-hidden" }), box);
  }
  ignoreEvent() {
    return false;
  }
}

export { calloutKind };
