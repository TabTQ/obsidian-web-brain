// markdown-it renderer with Obsidian extensions: wikilinks, embeds, tags,
// ==highlight==, $math$, callouts, tasks, footnotes, mermaid placeholders.
// Raw HTML is disabled on purpose: vault content (incl. AI-written notes) must not run scripts.

import markdownit, { type MarkdownIt, type StateBlock, type StateCore, type StateInline, type Token } from "markdown-it";
import footnote from "markdown-it-footnote";
import katex from "katex";
import { api } from "../api";
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT, ext, fileUrl, h, stem } from "../dom";

export interface RenderEnv {
  source: string; // path of the note being rendered (for link resolution)
  depth: number;
}

function splitWiki(inner: string) {
  const m = inner.match(/^(.*?)(?:\\?\|(.*))?$/s)!;
  const target = m[1];
  const i = target.indexOf("#");
  return { target, path: i === -1 ? target : target.slice(0, i), subpath: i === -1 ? "" : target.slice(i), display: m[2] };
}

function wikiRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const src = state.src;
  const embed = src.charCodeAt(start) === 0x21; /* ! */
  const open = embed ? start + 1 : start;
  if (src.slice(open, open + 2) !== "[[") return false;
  const close = src.indexOf("]]", open + 2);
  if (close === -1) return false;
  const inner = src.slice(open + 2, close);
  if (!inner || inner.includes("\n") || inner.includes("[[")) return false;
  if (!silent) {
    const t = state.push(embed ? "obs_embed" : "obs_wikilink", "", 0);
    t.meta = splitWiki(inner);
  }
  state.pos = close + 2;
  return true;
}

function tagRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x23) return false;
  const prev = start > 0 ? state.src[start - 1] : " ";
  if (!/[\s(]/.test(prev)) return false;
  const m = state.src.slice(start + 1).match(/^[\p{L}\p{N}_\-/]+/u);
  if (!m || !/[^\d/]/.test(m[0])) return false;
  if (!silent) {
    const t = state.push("obs_tag", "", 0);
    t.content = m[0].replace(/\/+$/, "");
  }
  state.pos = start + 1 + m[0].length;
  return true;
}

function highlightRule(state: StateInline, silent: boolean): boolean {
  const s = state.src;
  const start = state.pos;
  if (s.slice(start, start + 2) !== "==") return false;
  const end = s.indexOf("==", start + 2);
  if (end === -1 || end === start + 2) return false;
  if (!silent) {
    state.push("mark_open", "mark", 1);
    const oldMax = state.posMax;
    state.pos = start + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.posMax = oldMax;
    state.push("mark_close", "mark", -1);
  }
  state.pos = end + 2;
  return true;
}

function commentRule(state: StateInline, silent: boolean): boolean {
  const s = state.src;
  const start = state.pos;
  if (s.slice(start, start + 2) !== "%%") return false;
  const end = s.indexOf("%%", start + 2);
  if (end === -1) return false;
  if (!silent) state.push("obs_comment", "", 0);
  state.pos = end + 2;
  return true;
}

function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const s = state.src;
  const start = state.pos;
  if (s[start] !== "$" || s[start + 1] === "$" || /\s/.test(s[start + 1] ?? " ")) return false;
  let end = start + 1;
  while ((end = s.indexOf("$", end)) !== -1) {
    if (s[end - 1] !== "\\") break;
    end++;
  }
  if (end === -1 || /\s/.test(s[end - 1]) || /\d/.test(s[end + 1] ?? "")) return false;
  if (!silent) {
    const t = state.push("math_inline", "", 0);
    t.content = s.slice(start + 1, end);
  }
  state.pos = end + 1;
  return true;
}

function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const first = state.src.slice(pos, max);
  if (!first.startsWith("$$")) return false;
  if (silent) return true;
  let content = "";
  let next = startLine;
  const rest = first.slice(2);
  if (rest.trim().endsWith("$$") && rest.trim().length >= 2) {
    content = rest.trim().slice(0, -2);
  } else {
    const lines: string[] = rest.trim() ? [rest] : [];
    for (next = startLine + 1; next < endLine; next++) {
      const l = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]);
      if (l.trim().endsWith("$$")) {
        lines.push(l.trim().slice(0, -2));
        break;
      }
      lines.push(l);
    }
    content = lines.join("\n");
  }
  state.line = next + 1;
  const t = state.push("math_block", "", 0);
  t.content = content;
  t.map = [startLine, state.line];
  return true;
}

/** Turn "> [!type] title" blockquotes into callouts. */
function calloutCore(state: StateCore) {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "blockquote_open") continue;
    const inl = tokens[i + 2];
    if (!inl || inl.type !== "inline") continue;
    const m = inl.content.match(/^\[!([\w-]+)\]([+-]?)[ \t]*(.*)?/);
    if (!m) continue;
    const type = m[1].toLowerCase();
    tokens[i].attrSet("class", `callout callout-${calloutKind(type)}`);
    tokens[i].attrSet("data-callout", type);
    if (m[2]) tokens[i].attrSet("data-fold", m[2]);
    const firstLineEnd = inl.content.indexOf("\n");
    const title = (m[3] ?? "").split("\n")[0] || type[0].toUpperCase() + type.slice(1);
    tokens[i].meta = { calloutTitle: title };
    // Remove the marker line from the first paragraph.
    inl.content = firstLineEnd === -1 ? "" : inl.content.slice(firstLineEnd + 1);
    inl.children = [];
    state.md.inline.parse(inl.content, state.md, state.env, inl.children);
  }
}

export function calloutKind(t: string) {
  const map: Record<string, string> = {
    note: "note", info: "info", todo: "info", abstract: "abstract", summary: "abstract", tldr: "abstract",
    tip: "tip", hint: "tip", important: "tip", success: "success", check: "success", done: "success",
    question: "question", help: "question", faq: "question", warning: "warning", caution: "warning", attention: "warning",
    failure: "danger", fail: "danger", missing: "danger", danger: "danger", error: "danger", bug: "danger",
    example: "example", quote: "quote", cite: "quote",
  };
  return map[t] ?? "note";
}

const md: MarkdownIt = markdownit({ html: false, linkify: true, breaks: true, typographer: false });
md.use(footnote);
md.inline.ruler.before("link", "obs_wiki", wikiRule);
md.inline.ruler.before("emphasis", "obs_highlight", highlightRule);
md.inline.ruler.before("emphasis", "obs_comment", commentRule);
md.inline.ruler.after("escape", "math_inline", mathInlineRule);
md.inline.ruler.push("obs_tag", tagRule);
md.block.ruler.before("fence", "math_block", mathBlockRule, { alt: ["paragraph", "reference", "blockquote", "list"] });
md.core.ruler.push("callouts", calloutCore);

const esc = md.utils.escapeHtml;

md.renderer.rules.obs_wikilink = (tokens, idx) => {
  const m = tokens[idx].meta as ReturnType<typeof splitWiki>;
  const text = m.display ?? (m.subpath ? `${m.path}${m.subpath.replace("#", " > ")}` : m.path);
  return `<a class="internal-link" data-href="${esc(m.target)}" href="#">${esc(text || m.subpath)}</a>`;
};
md.renderer.rules.obs_embed = (tokens, idx) => {
  const m = tokens[idx].meta as ReturnType<typeof splitWiki>;
  return `<span class="internal-embed" data-src="${esc(m.target)}" data-display="${esc(m.display ?? "")}"></span>`;
};
md.renderer.rules.obs_tag = (tokens, idx) => `<a class="tag" data-tag="${esc(tokens[idx].content)}" href="#">#${esc(tokens[idx].content)}</a>`;
md.renderer.rules.obs_comment = () => "";
md.renderer.rules.math_inline = (tokens, idx) => renderMath(tokens[idx].content, false);
md.renderer.rules.math_block = (tokens, idx) => `<div class="math-block">${renderMath(tokens[idx].content, true)}</div>`;

const defaultBq = md.renderer.rules.blockquote_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.blockquote_open = (tokens, idx, opts, env, self) => {
  const t = tokens[idx];
  if (t.meta?.calloutTitle !== undefined) {
    return `<div class="${t.attrGet("class")}" data-callout="${esc(String(t.attrGet("data-callout") ?? ""))}"><div class="callout-title">${md.renderInline(String(t.meta.calloutTitle))}</div><div class="callout-content">`;
  }
  return defaultBq(tokens, idx, opts, env, self);
};
md.renderer.rules.blockquote_close = (tokens, idx, opts, env, self) => {
  // find matching open
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    if (tokens[i].type === "blockquote_close") depth++;
    else if (tokens[i].type === "blockquote_open") {
      depth--;
      if (depth === 0) return tokens[i].meta?.calloutTitle !== undefined ? "</div></div>" : self.renderToken(tokens, idx, opts);
    }
  }
  return self.renderToken(tokens, idx, opts);
};

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
  const t = tokens[idx];
  const lang = t.info.trim().split(/\s+/)[0].toLowerCase();
  if (lang === "mermaid") return `<div class="mermaid-pending" data-code="${esc(t.content)}"></div>`;
  return defaultFence(tokens, idx, opts, env, self);
};

// Task list items
const defaultText = md.renderer.rules.text!;
md.renderer.rules.text = (tokens, idx, opts, env, self) => {
  const t = tokens[idx];
  if (idx === 0) {
    const m = t.content.match(/^\[([ xX\-/<>!?*])\] /);
    if (m) return `<input type="checkbox" class="task-checkbox" disabled ${m[1] !== " " ? "checked" : ""}> ${esc(t.content.slice(4))}`;
  }
  return defaultText(tokens, idx, opts, env, self);
};

md.validateLink = (url) => !/^\s*(javascript|vbscript|data):/i.test(url) || /^\s*data:image\//i.test(url);
const defaultLinkOpen = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  const t = tokens[idx];
  const href = String(t.attrGet("href") ?? "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    t.attrSet("target", "_blank");
    t.attrSet("rel", "noopener noreferrer");
    t.attrJoin("class", "external-link");
  } else {
    t.attrSet("data-href", decodeURIComponent(href.replace(/\.md(#|$)/i, "$1")));
    t.attrSet("href", "#");
    t.attrJoin("class", "internal-link");
  }
  return defaultLinkOpen(tokens, idx, opts, env, self);
};
const defaultImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, opts, env, self) => {
  const t = tokens[idx];
  const src = String(t.attrGet("src") ?? "");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(src)) {
    return `<span class="internal-embed" data-src="${esc(decodeURIComponent(src))}" data-display="${esc(t.content)}"></span>`;
  }
  return defaultImage(tokens, idx, opts, env, self);
};

export function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore", trust: false, output: "html" });
  } catch (e) {
    return `<span class="math-error">${esc(String((e as Error).message))}</span>`;
  }
}

export function renderMarkdownHtml(src: string): string {
  // Drop YAML frontmatter.
  const text = src.replace(/^---\r?\n[\s\S]*?\r?\n(---|\.\.\.)\r?\n?/, "");
  return md.render(text);
}

/** Render markdown into an element and hydrate embeds, mermaid, links. */
export function renderMarkdown(el: HTMLElement, src: string, env: RenderEnv, onNavigate: (link: string, newTab: boolean) => void) {
  el.innerHTML = renderMarkdownHtml(src);
  hydrate(el, env, onNavigate);
}

export function hydrate(el: HTMLElement, env: RenderEnv, onNavigate: (link: string, newTab: boolean) => void) {
  el.querySelectorAll<HTMLElement>(".internal-embed").forEach((e) => void renderEmbed(e, e.dataset.src ?? "", e.dataset.display ?? "", env, onNavigate));
  el.querySelectorAll<HTMLElement>(".mermaid-pending").forEach((e) => void renderMermaid(e, e.dataset.code ?? ""));
  el.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) =>
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onNavigate(a.dataset.href ?? "", ev.ctrlKey || ev.metaKey);
    }),
  );
  el.querySelectorAll<HTMLAnchorElement>("a.tag").forEach((a) =>
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      window.dispatchEvent(new CustomEvent("brain:search", { detail: `tag:#${a.dataset.tag}` }));
    }),
  );
}

/** Size spec "120" or "120x60" from embed display text. */
function sizeOf(display: string): { w?: number; h?: number } {
  const m = display.match(/^(\d+)(?:x(\d+))?$/);
  return m ? { w: +m[1], h: m[2] ? +m[2] : undefined } : {};
}

export async function renderEmbed(el: HTMLElement, target: string, display: string, env: RenderEnv, onNavigate: (link: string, newTab: boolean) => void) {
  const hashIdx = target.indexOf("#");
  const linkPath = hashIdx === -1 ? target : target.slice(0, hashIdx);
  const subpath = hashIdx === -1 ? "" : target.slice(hashIdx + 1);
  el.classList.add("is-loading");
  const resolved = (await api.resolve(linkPath, env.source).catch(() => ({ path: null }))).path;
  el.classList.remove("is-loading");
  el.textContent = "";
  if (!resolved) {
    el.classList.add("is-unresolved");
    el.append(h("span", { class: "embed-missing" }, `"${linkPath}" could not be found.`));
    return;
  }
  const e = ext(resolved);
  const url = fileUrl(resolved);
  if (IMAGE_EXT.has(e)) {
    const { w, h: hh } = sizeOf(display);
    el.classList.add("image-embed");
    el.append(h("img", { src: url, alt: display && !w ? display : stem(resolved), width: w, height: hh, loading: "lazy" }));
  } else if (AUDIO_EXT.has(e) && e !== "webm") {
    el.classList.add("audio-embed");
    el.append(h("audio", { src: url, controls: true, preload: "metadata" }));
  } else if (VIDEO_EXT.has(e)) {
    el.classList.add("video-embed");
    el.append(h("video", { src: url, controls: true, preload: "metadata" }));
  } else if (e === "pdf") {
    // Browser's built-in PDF viewer (no bundled PDF.js); #page=N is honored.
    el.classList.add("pdf-embed");
    const page = subpath.match(/page=(\d+)/)?.[1];
    el.append(h("iframe", { src: url + (page ? `#page=${page}` : ""), title: resolved, loading: "lazy" }));
  } else if (e === "md") {
    el.classList.add("markdown-embed");
    if (env.depth >= 3) {
      el.append(h("div", { class: "embed-missing" }, "Embed depth limit reached."));
      return;
    }
    const title = h("div", { class: "markdown-embed-title" }, h("a", { href: "#", onclick: (ev: Event) => { ev.preventDefault(); onNavigate(target, false); } }, stem(resolved) + (subpath ? " › " + subpath.replace(/^\^/, "^") : "")));
    const body = h("div", { class: "markdown-embed-content" });
    el.append(title, body);
    try {
      const note = await api.note(resolved);
      const part = subpath ? extractSubpath(note.content, subpath) : note.content;
      renderMarkdown(body, part, { source: resolved, depth: env.depth + 1 }, onNavigate);
    } catch (err) {
      body.textContent = String((err as Error).message);
    }
  } else {
    el.classList.add("file-embed");
    el.append(h("a", { href: url, target: "_blank", rel: "noopener" }, resolved));
  }
}

/** Extract a heading section or block (^id) from markdown. */
export function extractSubpath(src: string, subpath: string): string {
  const lines = src.split("\n");
  if (subpath.startsWith("^")) {
    const id = subpath.slice(1).toLowerCase();
    const i = lines.findIndex((l) => new RegExp(`(?:^|\\s)\\^${id}\\s*$`, "i").test(l));
    if (i === -1) return `*Block ^${id} not found*`;
    let s = i;
    while (s > 0 && lines[s - 1].trim() !== "") s--;
    return lines.slice(s, i + 1).join("\n").replace(/\s\^[\w-]+\s*$/, "");
  }
  const parts = subpath.split("#").filter(Boolean).map((p) => p.trim().toLowerCase());
  const want = parts[parts.length - 1];
  const i = lines.findIndex((l) => {
    const m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    return m && m[2].toLowerCase() === want;
  });
  if (i === -1) return `*Heading "${subpath}" not found*`;
  const level = lines[i].match(/^#+/)![0].length;
  let e = i + 1;
  while (e < lines.length && !(/^(#{1,6})\s/.test(lines[e]) && lines[e].match(/^#+/)![0].length <= level)) e++;
  return lines.slice(i, e).join("\n");
}

let mermaidLoader: Promise<typeof import("mermaid").default> | null = null;
let mermaidCounter = 0;
export async function renderMermaid(el: HTMLElement, code: string) {
  el.className = "mermaid-block";
  try {
    mermaidLoader ??= import("mermaid").then((m) => {
      const dark = document.documentElement.classList.contains("theme-dark");
      m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
      return m.default;
    });
    const mermaid = await mermaidLoader;
    const { svg } = await mermaid.render(`mmd-${++mermaidCounter}`, code);
    el.innerHTML = svg;
  } catch (e) {
    el.textContent = "";
    el.append(h("pre", { class: "mermaid-error" }, String((e as Error).message ?? e)));
  }
}
