// Live preview: one CodeMirror editor with a decoration layer that renders
// markdown and reveals syntax only where the selection touches it.
// Reveal rules (designed to feel like Obsidian's live preview):
//  - inline tokens (bold, italic, code, links, math, highlight): per token, inclusive boundaries
//  - headings, tasks, horizontal rules, embeds: per line
//  - callouts, fenced code, math blocks: per block
//  - tables: rendered widget; source shown when the cursor is placed inside (click "edit")
//  - nothing is revealed while the editor is not focused

import { syntaxTree } from "@codemirror/language";
import { EditorState, Facet, RangeSetBuilder, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { editorHooks } from "./hooks";
import { BlockWidget, CheckboxWidget, CodeHeaderWidget, EmbedWidget, HrWidget, MathWidget, MermaidWidget } from "./widgets";

export const notePathFacet = Facet.define<string, string>({ combine: (v) => v[0] ?? "" });

const setFocus = StateEffect.define<boolean>();
const focusField = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => {
    for (const e of tr.effects) if (e.is(setFocus)) return e.value;
    return v;
  },
});

const hide = Decoration.replace({});
const lineDeco = (cls: string) => Decoration.line({ class: cls });

function touches(state: EditorState, focused: boolean, from: number, to: number) {
  if (!focused) return false;
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

function linesTouched(state: EditorState, focused: boolean, from: number, to: number) {
  if (!focused) return false;
  const a = state.doc.lineAt(from).number;
  const b = state.doc.lineAt(to).number;
  for (const r of state.selection.ranges) {
    const ra = state.doc.lineAt(r.from).number;
    const rb = state.doc.lineAt(r.to).number;
    if (ra <= b && rb >= a) return true;
  }
  return false;
}

function child(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) return c;
  return null;
}
function children(node: SyntaxNode, name: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) out.push(c);
  return out;
}

function buildDecorations(state: EditorState): DecorationSet {
  const focused = state.field(focusField);
  const source = state.facet(notePathFacet);
  const doc = state.doc;
  const decos: Range<Decoration>[] = [];
  const tree = syntaxTree(state);

  const lineClass = (from: number, to: number, cls: string) => {
    for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) decos.push(lineDeco(cls).range(doc.line(l).from));
  };
  const blockRange = (from: number, to: number) => ({ from: doc.lineAt(from).from, to: doc.lineAt(to).to });

  tree.iterate({
    enter: (n) => {
      const node = n.node;
      const name = n.name;
      switch (name) {
        case "Frontmatter":
          lineClass(n.from, n.to, "cm-frontmatter");
          return false;

        case "ATXHeading1": case "ATXHeading2": case "ATXHeading3": case "ATXHeading4": case "ATXHeading5": case "ATXHeading6": {
          const level = name.slice(-1);
          decos.push(lineDeco(`cm-heading cm-h${level}`).range(doc.lineAt(n.from).from));
          if (!linesTouched(state, focused, n.from, n.to)) {
            const marks = children(node, "HeaderMark");
            if (marks[0]) {
              let end = marks[0].to;
              while (end < n.to && /\s/.test(doc.sliceString(end, end + 1))) end++;
              decos.push(hide.range(marks[0].from, end));
            }
            if (marks[1] && marks[1].from > marks[0]!.to) {
              let start = marks[1].from;
              while (start > n.from && doc.sliceString(start - 1, start) === " ") start--;
              decos.push(hide.range(start, marks[1].to));
            }
          }
          return;
        }
        case "SetextHeading1": case "SetextHeading2":
          decos.push(lineDeco(`cm-heading cm-h${name.slice(-1)}`).range(doc.lineAt(n.from).from));
          return;

        case "Emphasis": case "StrongEmphasis": case "Strikethrough": case "InlineCode": case "Highlight": {
          if (name === "Highlight") decos.push(Decoration.mark({ class: "cm-highlight" }).range(n.from, n.to));
          if (name === "InlineCode") decos.push(Decoration.mark({ class: "cm-inline-code" }).range(n.from, n.to));
          if (!touches(state, focused, n.from, n.to)) {
            const markName = { Emphasis: "EmphasisMark", StrongEmphasis: "EmphasisMark", Strikethrough: "StrikethroughMark", InlineCode: "CodeMark", Highlight: "HighlightMark" }[name]!;
            for (const m of children(node, markName)) decos.push(hide.range(m.from, m.to));
          }
          return;
        }

        case "Link": {
          const marks = children(node, "LinkMark");
          const url = child(node, "URL");
          if (marks.length >= 2 && url && doc.sliceString(marks[0].from, marks[0].to) === "[") {
            const textFrom = marks[0].to;
            const textTo = marks[1].from;
            const href = doc.sliceString(url.from, url.to).replace(/^<|>$/g, "");
            const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
            if (textTo > textFrom) {
              decos.push(Decoration.mark({ class: external ? "cm-link-rendered cm-external" : "cm-link-rendered cm-internal", attributes: { "data-href": href } }).range(textFrom, textTo));
            }
            if (!touches(state, focused, n.from, n.to) && textTo > textFrom) {
              decos.push(hide.range(marks[0].from, marks[0].to));
              decos.push(hide.range(marks[1].from, n.to));
            }
          }
          return false;
        }

        case "Image": {
          const url = child(node, "URL");
          if (!url) return false;
          const href = decodeURIComponentSafe(doc.sliceString(url.from, url.to).replace(/^<|>$/g, ""));
          const altMarks = children(node, "LinkMark");
          const alt = altMarks.length >= 2 ? doc.sliceString(altMarks[0].to, altMarks[1].from) : "";
          if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
          embedDeco(n.from, n.to, href, alt);
          return false;
        }

        case "WikiLink": {
          const inner = doc.sliceString(n.from + 2, n.to - 2);
          const pipe = inner.search(/\\?\|/);
          const target = pipe === -1 ? inner : inner.slice(0, pipe);
          const linkPath = target.split("#")[0];
          const exists = linkPath === "" || editorHooks.linkExists(linkPath, source);
          const visFrom = pipe === -1 ? n.from + 2 : n.from + 2 + pipe + (inner[pipe] === "\\" ? 2 : 1);
          const visTo = n.to - 2;
          decos.push(Decoration.mark({ class: "cm-wikilink" + (exists ? "" : " is-unresolved"), attributes: { "data-href": target } }).range(visFrom, visTo > visFrom ? visTo : n.to));
          if (!touches(state, focused, n.from, n.to) && visTo > visFrom) {
            decos.push(hide.range(n.from, visFrom));
            decos.push(hide.range(visTo, n.to));
          }
          return false;
        }

        case "Embed": {
          const inner = doc.sliceString(n.from + 3, n.to - 2);
          const pipe = inner.search(/\\?\|/);
          const target = pipe === -1 ? inner : inner.slice(0, pipe);
          const display = pipe === -1 ? "" : inner.slice(pipe + (inner[pipe] === "\\" ? 2 : 1));
          embedDeco(n.from, n.to, target, display);
          return false;
        }

        case "Tag":
          decos.push(Decoration.mark({ class: "cm-tag", attributes: { "data-tag": doc.sliceString(n.from + 1, n.to) } }).range(n.from, n.to));
          return false;

        case "Comment":
          decos.push(Decoration.mark({ class: "cm-obs-comment" }).range(n.from, n.to));
          return false;

        case "InlineMath": {
          if (!touches(state, focused, n.from, n.to)) decos.push(Decoration.replace({ widget: new MathWidget(doc.sliceString(n.from + 1, n.to - 1), false) }).range(n.from, n.to));
          return false;
        }

        case "BlockMath": {
          const text = doc.sliceString(n.from, n.to);
          const tex = text.replace(/^\s*\$\$/, "").replace(/\$\$\s*$/, "");
          const { from, to } = blockRange(n.from, n.to);
          if (!linesTouched(state, focused, from, to)) {
            decos.push(Decoration.replace({ widget: new MathWidget(tex, true), block: true }).range(from, to));
          } else {
            lineClass(from, to, "cm-math-source");
            decos.push(Decoration.widget({ widget: new MathWidget(tex, true), block: true, side: 1 }).range(to));
          }
          return false;
        }

        case "FencedCode": {
          const info = child(node, "CodeInfo");
          const lang = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : "";
          const { from, to } = blockRange(n.from, n.to);
          const firstLine = doc.lineAt(from);
          const lastLine = doc.lineAt(to);
          const marks = children(node, "CodeMark");
          const closed = marks.length >= 2 && lastLine.number > firstLine.number;
          const bodyFrom = firstLine.number < doc.lines ? doc.line(firstLine.number + 1).from : firstLine.to;
          const bodyTo = closed ? doc.line(lastLine.number - 1).to : to;
          const code = bodyFrom <= bodyTo ? doc.sliceString(bodyFrom, bodyTo) : "";
          const revealed = linesTouched(state, focused, from, to);
          if (lang === "mermaid" && !revealed && closed) {
            decos.push(Decoration.replace({ widget: new MermaidWidget(code, from), block: true }).range(from, to));
            return false;
          }
          for (let l = firstLine.number; l <= lastLine.number; l++) {
            const cls = l === firstLine.number ? "cm-codeblock cm-codeblock-begin" : l === lastLine.number && closed ? "cm-codeblock cm-codeblock-end" : "cm-codeblock";
            decos.push(lineDeco(cls).range(doc.line(l).from));
          }
          if (!revealed && closed) {
            decos.push(Decoration.replace({ widget: new CodeHeaderWidget(lang, code), block: true }).range(firstLine.from, firstLine.to));
            decos.push(Decoration.replace({ block: true }).range(lastLine.from, lastLine.to));
          }
          return false;
        }

        case "Blockquote": {
          const { from, to } = blockRange(n.from, n.to);
          const first = doc.lineAt(from).text;
          const callout = first.match(/^\s*>\s*\[!([\w-]+)\]/);
          if (callout) {
            if (!linesTouched(state, focused, from, to)) {
              decos.push(Decoration.replace({ widget: new BlockWidget(doc.sliceString(from, to), source, "callout", from), block: true }).range(from, to));
              return false;
            }
            lineClass(from, to, "cm-callout-source");
            return;
          }
          lineClass(from, to, "cm-quote");
          return;
        }

        case "Table": {
          const { from, to } = blockRange(n.from, n.to);
          if (!linesTouched(state, focused, from, to)) {
            decos.push(Decoration.replace({ widget: new BlockWidget(doc.sliceString(from, to), source, "table", from), block: true }).range(from, to));
            return false;
          }
          lineClass(from, to, "cm-table-source");
          return false;
        }

        case "HorizontalRule": {
          if (!linesTouched(state, focused, n.from, n.to)) decos.push(Decoration.replace({ widget: new HrWidget() }).range(n.from, n.to));
          return false;
        }

        case "Task": {
          const marker = child(node, "TaskMarker");
          const item = node.parent;
          const listMark = item ? child(item, "ListMark") : null;
          if (marker && listMark) {
            const checked = /\[[^ ]\]/.test(doc.sliceString(marker.from, marker.to));
            const line = doc.lineAt(marker.from);
            if (checked) decos.push(lineDeco("cm-task-done").range(line.from));
            if (!linesTouched(state, focused, line.from, line.to)) {
              decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, marker.from) }).range(listMark.from, marker.to));
            }
          }
          return;
        }

        case "ListMark":
          decos.push(Decoration.mark({ class: "cm-list-mark" }).range(n.from, n.to));
          return;
      }
      return;
    },
  });

  function embedDeco(from: number, to: number, target: string, display: string) {
    const line = doc.lineAt(from);
    const alone = line.text.trim() === doc.sliceString(from, to).trim();
    const onLine = linesTouched(state, focused, from, to);
    const w = new EmbedWidget(target, display, source, !alone);
    if (!onLine) decos.push(Decoration.replace({ widget: w }).range(from, to));
    else decos.push(Decoration.widget({ widget: w, side: 1 }).range(to));
  }

  decos.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  let lastTo = -1;
  for (const d of decos) {
    // Drop overlapping replace ranges defensively (RangeSet requires sorted, non-conflicting replaces).
    const isReplace = (d.value as unknown as { point?: boolean }).point && d.from !== d.to;
    if (isReplace && d.from < lastTo) continue;
    builder.add(d.from, d.to, d.value);
    if (isReplace) lastTo = d.to;
  }
  return builder.finish();
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const livePreviewField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setFocus)) || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildDecorations(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const focusTracker = EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing));

/** Clicks on rendered links navigate (as in Obsidian); Ctrl/Cmd opens a new tab. */
const linkClicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    const t = e.target as HTMLElement;
    if (e.button !== 0) return false;
    const wl = t.closest<HTMLElement>(".cm-wikilink, .cm-link-rendered, .cm-tag");
    if (!wl) return false;
    // Only when the syntax is hidden (rendered); when revealed, clicks edit as usual.
    const pos = view.posAtDOM(wl);
    let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1);
    while (node && !["WikiLink", "Link", "Tag"].includes(node.name)) node = node.parent;
    const revealed = !!node && touches(view.state, view.hasFocus, node.from, node.to);
    if (revealed && !(e.ctrlKey || e.metaKey)) return false;
    e.preventDefault();
    if (wl.classList.contains("cm-tag")) {
      editorHooks.searchTag(wl.dataset.tag ?? "");
      return true;
    }
    const href = wl.dataset.href ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) editorHooks.openExternal(href);
    else editorHooks.navigate(decodeURIComponentSafe(href.replace(/\.md(#|$)/i, "$1")), view.state.facet(notePathFacet), e.ctrlKey || e.metaKey);
    return true;
  },
});

export function livePreview(): Extension {
  return [focusField, focusTracker, livePreviewField, linkClicks, EditorView.editorAttributes.of({ class: "is-live-preview" })];
}

/** Source mode still gets heading/code line styling but no hiding or widgets. */
export function sourceModeStyling(): Extension {
  return StateField.define<DecorationSet>({
    create: (s) => sourceDecos(s),
    update: (v, tr) => (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? sourceDecos(tr.state) : v),
    provide: (f) => EditorView.decorations.from(f),
  });
}

function sourceDecos(state: EditorState): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  syntaxTree(state).iterate({
    enter: (n) => {
      if (/^ATXHeading\d$/.test(n.name)) b.add(doc.lineAt(n.from).from, doc.lineAt(n.from).from, lineDeco(`cm-heading-src cm-h${n.name.slice(-1)}-src`));
      if (n.name === "FencedCode") {
        for (let l = doc.lineAt(n.from).number; l <= doc.lineAt(n.to).number; l++) b.add(doc.line(l).from, doc.line(l).from, lineDeco("cm-codeblock"));
        return false;
      }
      if (n.name === "Frontmatter") {
        for (let l = doc.lineAt(n.from).number; l <= doc.lineAt(n.to).number; l++) b.add(doc.line(l).from, doc.line(l).from, lineDeco("cm-frontmatter"));
        return false;
      }
      return;
    },
  });
  return b.finish();
}
