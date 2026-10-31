// Extracts note metadata (links, embeds, tags, headings, blocks, tasks, frontmatter)
// from markdown text. Behavior is compatible with Obsidian's markdown conventions.

import { parse as parseYaml } from "yaml";

export interface Pos {
  start: number; // offset in file
  end: number;
  line: number; // 0-based
}

export interface LinkRef {
  /** Link path without subpath, e.g. "Folder/Note". Decoded for markdown links. */
  link: string;
  /** Subpath including "#", e.g. "#Heading" or "#^block". */
  subpath: string;
  /** Alias / display text, if any. */
  display?: string;
  /** Exact source text of the whole link. */
  original: string;
  kind: "wiki" | "markdown";
  embed: boolean;
  /** For markdown links: whether the URL used the <angle bracket> form. */
  angle?: boolean;
  pos: Pos;
  /** Range of the target text (path + subpath) inside original, as file offsets. */
  targetStart: number;
  targetEnd: number;
}

export interface FrontmatterLink {
  key: string;
  link: string;
  subpath: string;
  display?: string;
  original: string;
  pos: Pos;
  targetStart: number;
  targetEnd: number;
}

export interface Heading {
  heading: string;
  level: number;
  pos: Pos;
}

export interface TagRef {
  tag: string; // with leading "#"
  pos: Pos;
}

export interface TaskItem {
  status: string; // " " or "x" etc.
  text: string;
  line: number;
}

export interface Section {
  type: "frontmatter" | "heading" | "paragraph" | "code" | "math" | "list" | "blockquote" | "table" | "hr" | "comment";
  startLine: number;
  endLine: number; // inclusive
}

export interface NoteMeta {
  frontmatter: Record<string, unknown> | null;
  frontmatterError?: string;
  frontmatterEnd: number; // offset after the closing --- line (0 if none)
  frontmatterLines: number; // number of lines incl. delimiters
  frontmatterLinks: FrontmatterLink[];
  links: LinkRef[];
  embeds: LinkRef[];
  headings: Heading[];
  tags: TagRef[]; // inline tags only
  blocks: Record<string, { line: number }>;
  tasks: TaskItem[];
  sections: Section[];
}

const WIKI_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const MD_LINK_RE = /(!?)\[((?:\\.|[^\]\\\n])*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
// Tag: "#" at line start or after whitespace; allowed chars per Obsidian (letters, digits, _ - /).
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\-/\p{Emoji_Presentation}]+)/gu;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const BLOCK_ID_RE = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/;
const TASK_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[(.)\][ \t]+(.*)$/;
const LIST_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;
const HR_RE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** Split "Note#Heading|Alias" style wikilink inner text. */
export function splitWikiInner(inner: string): { target: string; display?: string } {
  // Escaped pipe "\|" is used inside tables; treat it as the separator too.
  const m = inner.match(/^(.*?)(?:\\?\|(.*))?$/s)!;
  return { target: m[1], display: m[2] };
}

export function splitSubpath(target: string): { path: string; subpath: string } {
  const i = target.indexOf("#");
  if (i === -1) return { path: target, subpath: "" };
  return { path: target.slice(0, i), subpath: target.slice(i) };
}

function isExternalUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Replace inline code spans and inline math with spaces so they are not parsed. */
function maskInline(line: string): string {
  let out = line.replace(/(`+)([^`]|[^`].*?[^`])\1(?!`)/g, (m) => " ".repeat(m.length));
  out = out.replace(/%%.*?%%/g, (m) => " ".repeat(m.length));
  out = out.replace(/(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (m) => " ".repeat(m.length));
  return out;
}

export function parseFrontmatter(text: string): {
  data: Record<string, unknown> | null;
  error?: string;
  end: number;
  lines: number;
  raw: string;
  rawStart: number;
} {
  if (!text.startsWith("---")) return { data: null, end: 0, lines: 0, raw: "", rawStart: 0 };
  const firstNl = text.indexOf("\n");
  if (firstNl === -1 || text.slice(0, firstNl).trim() !== "---") return { data: null, end: 0, lines: 0, raw: "", rawStart: 0 };
  let idx = firstNl + 1;
  let lineCount = 1;
  while (idx <= text.length) {
    let nl = text.indexOf("\n", idx);
    if (nl === -1) nl = text.length;
    const line = text.slice(idx, nl).replace(/\r$/, "");
    lineCount++;
    if (line === "---" || line === "...") {
      const raw = text.slice(firstNl + 1, idx);
      const end = Math.min(nl + 1, text.length);
      try {
        const data = raw.trim() === "" ? {} : parseYaml(raw, { logLevel: "silent" });
        if (data !== null && typeof data === "object" && !Array.isArray(data)) {
          return { data: data as Record<string, unknown>, end, lines: lineCount, raw, rawStart: firstNl + 1 };
        }
        return { data: {}, error: "Frontmatter is not a mapping", end, lines: lineCount, raw, rawStart: firstNl + 1 };
      } catch (e) {
        return { data: null, error: String((e as Error).message), end, lines: lineCount, raw, rawStart: firstNl + 1 };
      }
    }
    if (nl >= text.length) break;
    idx = nl + 1;
  }
  return { data: null, end: 0, lines: 0, raw: "", rawStart: 0 };
}

/** Tags declared in frontmatter ("tags"/"tag"), normalized with leading "#". */
export function frontmatterTags(fm: Record<string, unknown> | null): string[] {
  if (!fm) return [];
  const out: string[] = [];
  for (const key of ["tags", "tag"]) {
    const v = fm[key];
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : [];
    for (const t of list) {
      if (typeof t !== "string" && typeof t !== "number") continue;
      const s = String(t).trim().replace(/^#/, "");
      if (s && isValidTag(s)) out.push("#" + s);
    }
  }
  return out;
}

export function frontmatterAliases(fm: Record<string, unknown> | null): string[] {
  if (!fm) return [];
  const out: string[] = [];
  for (const key of ["aliases", "alias"]) {
    const v = fm[key];
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
    for (const a of list) if (typeof a === "string" && a.trim()) out.push(a.trim());
  }
  return out;
}

export function isValidTag(t: string): boolean {
  // Must contain at least one non-numeric character (Obsidian rule).
  return /[^\d/]/.test(t) && !/^\//.test(t);
}

export function parseNote(text: string): NoteMeta {
  const fm = parseFrontmatter(text);
  const meta: NoteMeta = {
    frontmatter: fm.data,
    frontmatterError: fm.error,
    frontmatterEnd: fm.end,
    frontmatterLines: fm.lines,
    frontmatterLinks: [],
    links: [],
    embeds: [],
    headings: [],
    tags: [],
    blocks: {},
    tasks: [],
    sections: [],
  };

  if (fm.end > 0) {
    meta.sections.push({ type: "frontmatter", startLine: 0, endLine: fm.lines - 1 });
    collectFrontmatterLinks(text, fm.rawStart, fm.raw, meta);
  }

  // Line iteration with block state.
  const lines = text.split("\n");
  let offset = 0;
  let lineNo = 0;
  // Skip frontmatter lines
  for (; lineNo < fm.lines; lineNo++) offset += lines[lineNo].length + 1;

  let fence: string | null = null;
  let inMath = false;
  let inComment = false;
  let blockStart = -1;
  let blockType: Section["type"] | null = null;

  const closeBlock = (endLine: number) => {
    if (blockType && blockStart >= 0) meta.sections.push({ type: blockType, startLine: blockStart, endLine });
    blockType = null;
    blockStart = -1;
  };

  for (; lineNo < lines.length; lineNo++) {
    const rawLine = lines[lineNo].replace(/\r$/, "");
    const lineStart = offset;
    offset += lines[lineNo].length + 1;

    if (fence) {
      if (rawLine.trim().startsWith(fence[0].repeat(fence.length)) && rawLine.trim().replace(new RegExp(`^\\${fence[0]}+`), "").trim() === "") {
        fence = null;
        closeBlock(lineNo);
      }
      continue;
    }
    if (inMath) {
      if (rawLine.trim().endsWith("$$")) {
        inMath = false;
        closeBlock(lineNo);
      }
      continue;
    }
    if (inComment) {
      if (rawLine.includes("%%")) {
        inComment = false;
        closeBlock(lineNo);
      }
      continue;
    }

    const fenceMatch = rawLine.match(FENCE_RE);
    if (fenceMatch) {
      closeBlock(lineNo - 1);
      fence = fenceMatch[1];
      blockType = "code";
      blockStart = lineNo;
      continue;
    }
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("$$")) {
      closeBlock(lineNo - 1);
      blockType = "math";
      blockStart = lineNo;
      if (!(trimmed.length > 2 && trimmed.endsWith("$$"))) inMath = true;
      else closeBlock(lineNo);
      continue;
    }
    if (trimmed.startsWith("%%") && !trimmed.slice(2).includes("%%")) {
      closeBlock(lineNo - 1);
      blockType = "comment";
      blockStart = lineNo;
      inComment = true;
      continue;
    }

    if (trimmed === "") {
      closeBlock(lineNo - 1);
      continue;
    }

    const heading = rawLine.match(HEADING_RE);
    let type: Section["type"];
    if (heading) type = "heading";
    else if (HR_RE.test(rawLine)) type = "hr";
    else if (/^[ \t]{0,3}>/.test(rawLine)) type = "blockquote";
    else if (LIST_RE.test(rawLine)) type = "list";
    else if (/^\s*\|/.test(rawLine)) type = "table";
    else type = "paragraph";

    if (type === "heading" || type === "hr") {
      closeBlock(lineNo - 1);
      meta.sections.push({ type, startLine: lineNo, endLine: lineNo });
    } else if (blockType !== type || (type === "list" && blockType !== "list")) {
      // Lists continue across item lines; paragraphs/quotes/tables continue while same type.
      if (!(blockType === "list" && type === "paragraph")) {
        closeBlock(lineNo - 1);
        blockType = type;
        blockStart = lineNo;
      }
    }

    if (heading) {
      meta.headings.push({
        heading: heading[2].replace(/\s+\^[A-Za-z0-9-]+$/, ""),
        level: heading[1].length,
        pos: { start: lineStart, end: lineStart + rawLine.length, line: lineNo },
      });
    }

    const masked = maskInline(rawLine);
    collectLinks(masked, rawLine, lineStart, lineNo, meta);
    collectTags(masked, lineStart, lineNo, meta, !!heading);

    const blockId = masked.match(BLOCK_ID_RE);
    if (blockId) meta.blocks[blockId[1].toLowerCase()] = { line: lineNo };

    const task = rawLine.match(TASK_RE);
    if (task) meta.tasks.push({ status: task[1], text: task[2], line: lineNo });
  }
  closeBlock(lines.length - 1);
  if (fence || inMath) {
    // unterminated block runs to end; already closed above
  }
  return meta;
}

function collectLinks(masked: string, raw: string, lineStart: number, lineNo: number, meta: NoteMeta) {
  WIKI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const taken: Array<[number, number]> = [];
  while ((m = WIKI_RE.exec(masked))) {
    const original = raw.slice(m.index, m.index + m[0].length);
    const inner = original.slice(m[1].length + 2, -2);
    const { target, display } = splitWikiInner(inner);
    const { path, subpath } = splitSubpath(target);
    const start = lineStart + m.index;
    const ref: LinkRef = {
      link: path.trim(),
      subpath,
      display,
      original,
      kind: "wiki",
      embed: m[1] === "!",
      pos: { start, end: start + m[0].length, line: lineNo },
      targetStart: start + m[1].length + 2,
      targetEnd: start + m[1].length + 2 + target.length,
    };
    (ref.embed ? meta.embeds : meta.links).push(ref);
    taken.push([m.index, m.index + m[0].length]);
  }
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(masked))) {
    if (taken.some(([a, b]) => m!.index < b && m!.index + m![0].length > a)) continue;
    let url = m[3];
    const angle = url.startsWith("<");
    if (angle) url = url.slice(1, -1);
    if (isExternalUrl(url)) continue;
    const original = raw.slice(m.index, m.index + m[0].length);
    const decoded = angle ? url : safeDecode(url);
    const { path, subpath } = splitSubpath(decoded);
    const start = lineStart + m.index;
    // Position of the url inside the original text
    let urlIdx = m[1].length + 1 + m[2].length + 2; // "!" + "[" + text + "]("
    while (original[urlIdx] === " " || original[urlIdx] === "\t") urlIdx++;
    const urlLen = m[3].length;
    const ref: LinkRef = {
      link: path,
      subpath,
      display: m[2],
      original,
      kind: "markdown",
      embed: m[1] === "!",
      angle,
      pos: { start, end: start + m[0].length, line: lineNo },
      targetStart: start + urlIdx + (angle ? 1 : 0),
      targetEnd: start + urlIdx + urlLen - (angle ? 1 : 0),
    };
    if (path === "" && subpath === "") continue;
    (ref.embed ? meta.embeds : meta.links).push(ref);
  }
}

function collectTags(masked: string, lineStart: number, lineNo: number, meta: NoteMeta, isHeading: boolean) {
  // Strip links so "#" inside [[Note#Heading]] is not a tag.
  let s = masked.replace(/!?\[\[[^\]\n]*\]\]/g, (x) => " ".repeat(x.length));
  s = s.replace(/\]\([^)\n]*\)/g, (x) => " ".repeat(x.length));
  s = s.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, (x) => " ".repeat(x.length));
  if (isHeading) s = s.replace(/^#{1,6}[ \t]/, (x) => " ".repeat(x.length));
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(s))) {
    const tag = m[2].replace(/\/+$/, "");
    if (!isValidTag(tag)) continue;
    const start = lineStart + m.index + m[1].length;
    meta.tags.push({ tag: "#" + tag, pos: { start, end: start + 1 + tag.length, line: lineNo } });
  }
}

function collectFrontmatterLinks(text: string, rawStart: number, raw: string, meta: NoteMeta) {
  // Map each wikilink in the raw YAML back to its top-level key.
  const lines = raw.split("\n");
  let off = rawStart;
  let currentKey = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const keyMatch = line.match(/^([^\s#:][^:]*):/);
    if (keyMatch) currentKey = keyMatch[1].trim();
    WIKI_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_RE.exec(line))) {
      if (m[1] === "!") continue;
      const inner = m[2];
      const { target, display } = splitWikiInner(inner);
      const { path, subpath } = splitSubpath(target);
      const start = off + m.index;
      meta.frontmatterLinks.push({
        key: currentKey,
        link: path.trim(),
        subpath,
        display,
        original: m[0],
        pos: { start, end: start + m[0].length, line: i + 1 },
        targetStart: start + 2,
        targetEnd: start + 2 + target.length,
      });
    }
    off += line.length + 1;
  }
  void text;
}
