// A note editor: CodeMirror 6 + live preview, autosave with stale-write protection.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, indentOnInput, syntaxHighlighting, bracketMatching, foldKeymap } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, dropCursor, highlightActiveLine, keymap, placeholder, rectangularSelection } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { api, ApiError, type Note } from "../api";
import { debounce, h } from "../dom";
import { livePreview, notePathFacet, sourceModeStyling } from "./livePreview";
import { obsidianMarkdown } from "./markdownExt";

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700" },
  { tag: t.heading2, fontWeight: "700" },
  { tag: t.heading3, fontWeight: "650" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--link)" },
  { tag: t.url, color: "var(--text-faint)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)" },
  { tag: t.quote, color: "var(--text-muted)" },
  { tag: t.processingInstruction, color: "var(--text-faint)" },
  { tag: t.labelName, color: "var(--accent)" },
  { tag: t.comment, color: "var(--text-faint)" },
  { tag: t.keyword, color: "var(--code-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--code-string)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--code-number)" },
  { tag: [t.function(t.variableName), t.propertyName], color: "var(--code-function)" },
  { tag: [t.typeName, t.className], color: "var(--code-type)" },
  { tag: t.meta, color: "var(--text-faint)" },
  { tag: t.contentSeparator, color: "var(--text-faint)" },
]);

/** Shared completion sources. */
export const completionData = {
  files: [] as string[],
  tags: [] as string[],
  shortest: (path: string) => path,
};

function linkCompletion(ctx: CompletionContext): CompletionResult | null {
  const before = ctx.matchBefore(/!?\[\[[^\]\n]*$/);
  if (!before) return null;
  const open = before.text.indexOf("[[") + 2;
  const typed = before.text.slice(open);
  const from = before.from + open;
  const hashIdx = typed.indexOf("#");
  // Insert the link text and step over an existing (auto-inserted) "]]".
  const applyLink = (text: string) => (view: EditorView, _c: Completion, f: number, t: number) => {
    const close = view.state.sliceDoc(t, t + 2) === "]]";
    view.dispatch({ changes: { from: f, to: close ? t + 2 : t, insert: text + "]]" }, selection: { anchor: f + text.length + 2 } });
  };
  if (hashIdx !== -1) {
    // heading completion
    const notePart = typed.slice(0, hashIdx);
    const cached = headingCache.get(notePart.toLowerCase());
    if (!cached) fetchHeadings(notePart, ctx);
    return { from: from + hashIdx + 1, options: (cached ?? []).map((hd) => ({ label: hd, apply: applyLink(hd) })) };
  }
  return {
    from,
    options: completionData.files.map((p) => {
      const label = completionData.shortest(p);
      return { label, detail: p.includes("/") ? p : undefined, apply: applyLink(label), type: p.endsWith(".md") ? "text" : "file" };
    }),
    validFor: /^[^\]#|\n]*$/,
  };
}

const headingCache = new Map<string, string[]>();
function fetchHeadings(note: string, ctx: CompletionContext) {
  const key = note.toLowerCase();
  if (headingCache.has(key)) return;
  headingCache.set(key, []);
  const source = ctx.state.facet(notePathFacet);
  void api
    .resolve(note || source, source)
    .then((r) => (r.path ? api.meta(r.path) : null))
    .then((m) => {
      if (m) headingCache.set(key, m.headings.map((x) => x.heading));
      setTimeout(() => headingCache.delete(key), 30_000);
    });
}

function tagCompletion(ctx: CompletionContext): CompletionResult | null {
  const before = ctx.matchBefore(/(?:^|[\s(])#[\p{L}\p{N}_\-/]*$/u);
  if (!before) return null;
  const hash = before.text.lastIndexOf("#");
  if (before.text.length - hash === 1 && !ctx.explicit) {
    // just "#" typed: offer tags (but not at line start — that might be a heading)
    const line = ctx.state.doc.lineAt(ctx.pos);
    if (line.text.slice(0, ctx.pos - line.from).trim() === "#") return null;
  }
  return { from: before.from + hash, options: completionData.tags.map((tg) => ({ label: tg, type: "keyword" })), validFor: /^#[\p{L}\p{N}_\-/]*$/u };
}

function wrapSelection(view: EditorView, mark: string) {
  view.dispatch(
    view.state.changeByRange((r) => {
      const text = view.state.sliceDoc(r.from, r.to);
      if (text.startsWith(mark) && text.endsWith(mark) && text.length >= mark.length * 2) {
        return { changes: { from: r.from, to: r.to, insert: text.slice(mark.length, -mark.length) }, range: EditorSelection.range(r.from, r.to - mark.length * 2) };
      }
      return { changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }], range: EditorSelection.range(r.from + mark.length, r.to + mark.length) };
    }),
  );
  return true;
}

export interface EditorCallbacks {
  onSaved: (path: string, etag: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onConflict: (message: string) => void;
  onError: (message: string) => void;
}

export class NoteEditor {
  view: EditorView;
  path: string;
  etag: string | null = null;
  dirty = false;
  private saving = false;
  private lp = new Compartment();
  private pathComp = new Compartment();
  private livePreviewOn: boolean;
  private save = debounce(() => void this.saveNow(), 1000);
  readonly el: HTMLElement;

  constructor(note: Note, private cb: EditorCallbacks, livePreviewOn = true) {
    this.path = note.path;
    this.etag = note.etag;
    this.livePreviewOn = livePreviewOn;
    this.el = h("div", { class: "editor-host" });
    this.view = new EditorView({
      parent: this.el,
      state: EditorState.create({ doc: note.content, extensions: this.extensions() }),
    });
  }

  private extensions(): Extension[] {
    return [
      this.pathComp.of(notePathFacet.of(this.path)),
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorView.lineWrapping,
      placeholder("Start writing…"),
      markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [obsidianMarkdown], addKeymap: true }),
      syntaxHighlighting(highlight),
      this.lp.of(this.livePreviewOn ? livePreview() : sourceModeStyling()),
      autocompletion({ override: [linkCompletion, tagCompletion], activateOnTyping: true, maxRenderedOptions: 60 }),
      keymap.of([
        { key: "Mod-s", run: () => (void this.saveNow(), true), preventDefault: true },
        { key: "Mod-b", run: (v) => wrapSelection(v, "**") },
        { key: "Mod-i", run: (v) => wrapSelection(v, "*") },
        { key: "Mod-Shift-h", run: (v) => wrapSelection(v, "==") },
        { key: "Mod-`", run: (v) => wrapSelection(v, "`") },
        {
          key: "Mod-k",
          run: (v) => {
            const r = v.state.selection.main;
            const text = v.state.sliceDoc(r.from, r.to);
            v.dispatch({ changes: { from: r.from, to: r.to, insert: `[[${text}]]` }, selection: { anchor: r.from + 2 + text.length } });
            return true;
          },
        },
        ...closeBracketsKeymap,
        ...markdownKeymap,
        ...completionKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          if (!this.dirty) {
            this.dirty = true;
            this.cb.onDirtyChange(true);
          }
          this.save();
        }
      }),
      EditorView.domEventHandlers({
        paste: (e) => this.handleFiles(e.clipboardData?.files, e),
        drop: (e) => this.handleFiles(e.dataTransfer?.files, e),
      }),
    ];
  }

  private handleFiles(files: FileList | undefined | null, e: Event): boolean {
    if (!files || files.length === 0) return false;
    e.preventDefault();
    const pos = e instanceof DragEvent ? this.view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? this.view.state.selection.main.head : this.view.state.selection.main.head;
    void (async () => {
      const links: string[] = [];
      for (const f of Array.from(files)) {
        try {
          const name = f.name && f.name !== "image.png" ? f.name : `Pasted image ${new Date().toISOString().replace(/[:T]/g, "").slice(0, 14)}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`;
          const r = await api.upload(name, f, this.path);
          links.push(`![[${r.link}]]`);
        } catch (err) {
          this.cb.onError(`Upload failed: ${(err as Error).message}`);
        }
      }
      if (links.length) this.view.dispatch({ changes: { from: pos, insert: links.join("\n") }, selection: { anchor: pos + links.join("\n").length } });
    })();
    return true;
  }

  setLivePreview(on: boolean) {
    this.livePreviewOn = on;
    this.view.dispatch({ effects: this.lp.reconfigure(on ? livePreview() : sourceModeStyling()) });
  }
  get isLivePreview() {
    return this.livePreviewOn;
  }

  setPath(p: string) {
    this.path = p;
    this.view.dispatch({ effects: this.pathComp.reconfigure(notePathFacet.of(p)) });
  }

  getValue() {
    return this.view.state.doc.toString();
  }

  /** Replace content from the server (external change) keeping the cursor where possible. */
  replaceContent(content: string, etag: string) {
    const cur = this.getValue();
    this.etag = etag;
    if (cur === content) return;
    const sel = this.view.state.selection.main;
    this.view.dispatch({
      changes: { from: 0, to: cur.length, insert: content },
      selection: { anchor: Math.min(sel.anchor, content.length), head: Math.min(sel.head, content.length) },
      annotations: [],
    });
    this.save.cancel();
    this.dirty = false;
    this.cb.onDirtyChange(false);
  }

  async saveNow(force = false) {
    this.save.cancel();
    if (!this.dirty && !force) return;
    if (this.saving) {
      this.save();
      return;
    }
    this.saving = true;
    const content = this.getValue();
    try {
      const r = await api.save(this.path, content, force ? null : this.etag);
      this.etag = r.etag;
      if (this.getValue() === content) {
        this.dirty = false;
        this.cb.onDirtyChange(false);
      } else this.save();
      this.cb.onSaved(this.path, r.etag);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) this.cb.onConflict(e.message);
      else this.cb.onError(`Save failed: ${(e as Error).message}`);
    } finally {
      this.saving = false;
    }
  }

  scrollToLine(line: number) {
    const l = this.view.state.doc.line(Math.min(Math.max(1, line + 1), this.view.state.doc.lines));
    this.view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
    this.view.focus();
  }

  insertAtCursor(text: string) {
    const r = this.view.state.selection.main;
    this.view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length } });
    this.view.focus();
  }

  focus() {
    this.view.focus();
  }

  destroy() {
    if (this.dirty) void this.saveNow();
    this.view.destroy();
  }
}
