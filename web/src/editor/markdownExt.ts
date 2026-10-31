// Lezer markdown extensions for Obsidian syntax used by the live-preview layer.

import type { BlockContext, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";

const BANG = 33, LBRACK = 91, RBRACK = 93, HASH = 35, EQ = 61, PCT = 37, DOLLAR = 36;

function isTagChar(c: number) {
  const ch = String.fromCharCode(c);
  return /[\p{L}\p{N}_\-/]/u.test(ch);
}

export const obsidianMarkdown: MarkdownConfig = {
  defineNodes: [
    { name: "Frontmatter", block: true },
    { name: "FrontmatterMark" },
    { name: "WikiLink", style: t.link },
    { name: "Embed", style: t.link },
    { name: "WikiMark", style: t.processingInstruction },
    { name: "Tag", style: t.labelName },
    { name: "Highlight" },
    { name: "HighlightMark", style: t.processingInstruction },
    { name: "Comment", style: t.comment },
    { name: "InlineMath", style: t.special(t.string) },
    { name: "BlockMath", block: true, style: t.special(t.string) },
    { name: "MathMark", style: t.processingInstruction },
  ],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx: BlockContext, line: Line) {
        if (cx.lineStart !== 0 || line.text !== "---") return false;
        const start = cx.lineStart;
        const marks = [cx.elt("FrontmatterMark", start, start + 3)];
        while (cx.nextLine()) {
          if (line.text === "---" || line.text === "...") {
            const end = cx.lineStart + line.text.length;
            marks.push(cx.elt("FrontmatterMark", cx.lineStart, end));
            cx.nextLine();
            cx.addElement(cx.elt("Frontmatter", start, end, marks));
            return true;
          }
        }
        // Unterminated: treat as frontmatter to the end of the document.
        cx.addElement(cx.elt("Frontmatter", start, cx.prevLineEnd(), marks));
        return true;
      },
    },
    {
      name: "BlockMath",
      before: "FencedCode",
      parse(cx: BlockContext, line: Line) {
        const rest = line.text.slice(line.pos);
        if (!rest.startsWith("$$")) return false;
        const start = cx.lineStart + line.pos;
        const after = rest.slice(2);
        if (after.trim().length >= 2 && after.trimEnd().endsWith("$$")) {
          const end = cx.lineStart + line.text.length;
          cx.nextLine();
          cx.addElement(cx.elt("BlockMath", start, end, [cx.elt("MathMark", start, start + 2), cx.elt("MathMark", end - 2, end)]));
          return true;
        }
        const children = [cx.elt("MathMark", start, start + 2)];
        while (cx.nextLine()) {
          const tr = line.text.trimEnd();
          if (tr.endsWith("$$")) {
            const end = cx.lineStart + tr.length;
            children.push(cx.elt("MathMark", end - 2, end));
            cx.nextLine();
            cx.addElement(cx.elt("BlockMath", start, end, children));
            return true;
          }
        }
        cx.addElement(cx.elt("BlockMath", start, cx.prevLineEnd(), children));
        return true;
      },
    },
  ],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse(cx: InlineContext, next: number, pos: number) {
        let start = pos;
        let embed = false;
        if (next === BANG) {
          if (cx.char(pos + 1) !== LBRACK || cx.char(pos + 2) !== LBRACK) return -1;
          embed = true;
          pos += 1;
        } else if (next !== LBRACK || cx.char(pos + 1) !== LBRACK) return -1;
        for (let i = pos + 2; i < cx.end - 1; i++) {
          const c = cx.char(i);
          if (c === 10 || c === LBRACK) return -1;
          if (c === RBRACK && cx.char(i + 1) === RBRACK) {
            if (i === pos + 2) return -1;
            const end = i + 2;
            return cx.addElement(
              cx.elt(embed ? "Embed" : "WikiLink", start, end, [cx.elt("WikiMark", start, pos + 2), cx.elt("WikiMark", i, end)]),
            );
          }
        }
        return -1;
      },
    },
    {
      name: "Tag",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== HASH) return -1;
        const prev = pos > cx.offset ? cx.char(pos - 1) : 32;
        if (prev !== 32 && prev !== 9 && prev !== 10 && prev !== 40 /* ( */ && pos !== cx.offset) return -1;
        let end = pos + 1;
        while (end < cx.end && isTagChar(cx.char(end))) end++;
        const body = cx.slice(pos + 1, end).replace(/\/+$/, "");
        if (!body || !/[^\d/]/.test(body)) return -1;
        return cx.addElement(cx.elt("Tag", pos, pos + 1 + body.length));
      },
    },
    {
      name: "Highlight",
      before: "Emphasis",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== EQ || cx.char(pos + 1) !== EQ) return -1;
        for (let i = pos + 3; i < cx.end - 1; i++) {
          if (cx.char(i) === EQ && cx.char(i + 1) === EQ) {
            return cx.addElement(cx.elt("Highlight", pos, i + 2, [cx.elt("HighlightMark", pos, pos + 2), cx.elt("HighlightMark", i, i + 2)]));
          }
        }
        return -1;
      },
    },
    {
      name: "Comment",
      before: "Emphasis",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== PCT || cx.char(pos + 1) !== PCT) return -1;
        for (let i = pos + 2; i < cx.end - 1; i++) {
          if (cx.char(i) === PCT && cx.char(i + 1) === PCT) return cx.addElement(cx.elt("Comment", pos, i + 2));
        }
        return -1;
      },
    },
    {
      name: "InlineMath",
      before: "Emphasis",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== DOLLAR || cx.char(pos + 1) === DOLLAR) return -1;
        const first = cx.char(pos + 1);
        if (first === 32 || first === 9 || first === -1) return -1;
        for (let i = pos + 2; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 10) return -1;
          if (c === 92 /* \ */) {
            i++;
            continue;
          }
          if (c === DOLLAR) {
            const before = cx.char(i - 1);
            const after = cx.char(i + 1);
            if (before === 32 || (after >= 48 && after <= 57)) return -1;
            return cx.addElement(cx.elt("InlineMath", pos, i + 1, [cx.elt("MathMark", pos, pos + 1), cx.elt("MathMark", i, i + 1)]));
          }
        }
        return -1;
      },
    },
  ],
};
