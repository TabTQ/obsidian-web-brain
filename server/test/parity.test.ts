// Behavior-compatibility tests: expected results match how Obsidian behaves for the same vault.

import { describe, expect, it } from "vitest";
import { applyTemplate, formatDate, parseDate } from "../src/dates.js";
import { parseNote } from "../src/parser.js";
import { makeBrain } from "./helpers.js";

describe("link resolution tie-break", () => {
  const files = { "x/Dup.md": "", "y/Dup.md": "", "x/sub/Dup.md": "", "y/Only.md": "", "Alpha.md": "" };

  it("orders candidates: source folder first, then shortest path, then alphabetical", async () => {
    const { brain } = await makeBrain(files);
    const r = (link: string, src: string) => brain.index.resolveAll(link, src).map((f) => f.path);
    expect(r("Dup", "x/Alpha.md")).toEqual(["x/Dup.md", "x/sub/Dup.md", "y/Dup.md"]);
    expect(r("Dup", "y/Z.md")).toEqual(["y/Dup.md", "x/Dup.md", "x/sub/Dup.md"]);
    expect(r("Dup", "x/sub/N.md")).toEqual(["x/sub/Dup.md", "x/Dup.md", "y/Dup.md"]);
    expect(r("Dup", "x/sub/deep/N.md")).toEqual(["x/Dup.md", "y/Dup.md", "x/sub/Dup.md"]);
    expect(r("Dup", "q/N.md")).toEqual(["x/Dup.md", "y/Dup.md", "x/sub/Dup.md"]);
    expect(r("Dup", "Alpha.md")).toEqual(["x/Dup.md", "y/Dup.md", "x/sub/Dup.md"]);
  });

  it("root exact match wins alone; partial paths, case, absolute and relative forms", async () => {
    const { brain } = await makeBrain({ ...files, "Dup.md": "" });
    const r = (link: string, src: string) => brain.index.resolveAll(link, src).map((f) => f.path);
    expect(r("Dup", "x/Alpha.md")).toEqual(["Dup.md"]);
    expect(r("sub/Dup", "Alpha.md")).toEqual(["x/sub/Dup.md"]);
    expect(r("ONLY", "Alpha.md")).toEqual(["y/Only.md"]);
    expect(r("/x/Dup", "Alpha.md")).toEqual(["x/Dup.md"]);
    expect(r("../y/Dup", "x/N.md")).toEqual(["y/Dup.md"]);
  });

  it("absolute link with no exact match resolves to nothing", async () => {
    const { brain } = await makeBrain(files);
    expect(brain.index.resolveAll("/Dup", "Alpha.md")).toEqual([]);
  });

  it("aliases are not link targets", async () => {
    const { brain } = await makeBrain({ "T1.md": "---\naliases: [Tee]\n---\nx", "A.md": "[[Tee]]" });
    expect(brain.index.resolve("Tee", "A.md")).toBeNull();
    expect(brain.index.unresolvedLinks().map((u) => u.link)).toEqual(["Tee"]);
  });
});

describe("rename rewriting", () => {
  const src = [
    "wiki [[Target]]",
    "alias [[Target|shown]]",
    "head [[Target#Head]]",
    "blk [[Target#^blk1]]",
    "embed ![[Target]]",
    "md [t](Target.md)",
    "md2 [t](Target.md#Head)",
    "spaced [t](<Target.md>)",
    "inline code `[[Target]]`",
    "---",
    "",
  ].join("\n");

  it("rewrites wiki, alias, subpath, embed, markdown and frontmatter links; skips inline code", async () => {
    const { brain, read } = await makeBrain({
      "Target.md": "# Head\nbody ^blk1\n",
      "Src.md": src,
      "fm.md": '---\nrelated: "[[Target]]"\nlist:\n  - "[[Target]]"\n---\ntext\n',
    });
    const res = await brain.rename("Target.md", "Renamed Note.md", "ui");
    expect(res.linksUpdated).toBe(10);
    expect(res.filesUpdated).toBe(2);
    expect(read("Src.md")).toBe(
      [
        "wiki [[Renamed Note]]",
        "alias [[Renamed Note|shown]]",
        "head [[Renamed Note#Head]]",
        "blk [[Renamed Note#^blk1]]",
        "embed ![[Renamed Note]]",
        "md [t](Renamed%20Note.md)",
        "md2 [t](Renamed%20Note.md#Head)",
        "spaced [t](<Renamed Note.md>)",
        "inline code `[[Target]]`",
        "---",
        "",
      ].join("\n"),
    );
    expect(read("fm.md")).toBe('---\nrelated: "[[Renamed Note]]"\nlist:\n  - "[[Renamed Note]]"\n---\ntext\n');
  });

  it("keeps short links on unique move, uses path form when basename becomes ambiguous", async () => {
    const { brain, read } = await makeBrain({ "N.md": "x", "Src.md": "[[N]] and [t](N.md)\n" });
    await brain.rename("N.md", "Sub/N.md", "ui");
    expect(read("Src.md")).toBe("[[N]] and [t](N.md)\n");
    await brain.write("Other/N.md", "dup", { source: "ui", create: true });
    await brain.rename("Sub/N.md", "Zed/N.md", "ui");
    expect(read("Src.md")).toBe("[[Zed/N]] and [t](Zed/N.md)\n");
  });

  it("folder rename moves contents and rewrites links", async () => {
    const { brain, read, exists } = await makeBrain({ "A/One.md": "[[Two]]", "A/Two.md": "", "Root.md": "[[A/One]] [[Two]]" });
    await brain.rename("A", "B", "ui");
    expect(exists("B/One.md")).toBe(true);
    expect(read("Root.md")).toBe("[[One]] [[Two]]");
    expect(brain.index.resolve("Two", "B/One.md")?.path).toBe("B/Two.md");
  });

  it("rejects moving onto an existing file", async () => {
    const { brain } = await makeBrain({ "A.md": "", "B.md": "" });
    await expect(brain.rename("A.md", "B.md", "ui")).rejects.toMatchObject({ status: 409 });
  });
});

describe("tags, properties, orphans, dead-ends", () => {
  it("counts nested tags with parents, frontmatter and inline", async () => {
    const { brain } = await makeBrain({
      "T1.md": "---\ntags: [alpha, beta/gamma]\ndue: 2026-11-01\nn: 3\ndone: true\nlinks: [\"[[Beta]]\"]\ntitle: T\n---\ninline #inline/deep and #alpha\n",
      "T2.md": "no fm #alpha and ## not#tag\n",
    });
    expect(brain.index.tagCounts()).toEqual({ "#alpha": 3, "#beta/gamma": 1, "#beta": 1, "#inline/deep": 1, "#inline": 1 });
    const types = Object.fromEntries(brain.index.properties().map((p) => [p.name, p.type]));
    expect(types).toMatchObject({ tags: "tags", due: "date", n: "number", done: "checkbox", links: "multitext", title: "text" });
  });

  it("orphans = never targeted by a resolved link; dead-ends = no resolved outgoing links", async () => {
    const { brain } = await makeBrain({ "A.md": "[[B]] [[Missing]]", "B.md": "", "C.md": "[[Missing]]" });
    expect(brain.index.orphans()).toEqual(["A.md", "C.md"]);
    expect(brain.index.deadends()).toEqual(["B.md", "C.md"]);
  });
});

describe("search operators", () => {
  const corpus = {
    "S/apple pie.md": "# Apple Pie\nSweet apple and cinnamon.\n\n## Notes\nbake at 180 #dessert\n",
    "S/banana bread.md": "---\nstatus: draft\nrating: 5\n---\n# Banana\nbanana and apple mash #dessert/quick\n",
    "S/Cherry.md": "cherry only, no fruit mix. Apple? no.\n- [ ] todo item\n",
    "S/code.md": "function foo() { return 42 }\nFOO upper\n",
    "Other.md": "nothing",
  };
  const cases: Array<[string, string[]]> = [
    ["apple", ["S/apple pie.md", "S/banana bread.md", "S/Cherry.md"]],
    ["apple banana", ["S/banana bread.md"]],
    ["apple OR cherry", ["S/apple pie.md", "S/banana bread.md", "S/Cherry.md"]],
    ['"apple pie"', ["S/apple pie.md"]],
    ["apple -banana", ["S/apple pie.md", "S/Cherry.md"]],
    ["file:cherry", ["S/Cherry.md"]],
    ["path:S/", ["S/apple pie.md", "S/banana bread.md", "S/Cherry.md", "S/code.md"]],
    ["tag:#dessert", ["S/apple pie.md", "S/banana bread.md"]],
    ["tag:#dessert/quick", ["S/banana bread.md"]],
    ["content:cinnamon", ["S/apple pie.md"]],
    ["line:(apple sweet)", ["S/apple pie.md"]],
    ["section:(notes bake)", ["S/apple pie.md"]],
    ["[status:draft]", ["S/banana bread.md"]],
    ["[rating:5]", ["S/banana bread.md"]],
    ["/fo+/", ["S/code.md"]],
    ["match-case:foo", ["S/code.md"]],
    ["task:todo", ["S/Cherry.md"]],
    ["task-todo:item", ["S/Cherry.md"]],
    ["block:(apple cinnamon)", ["S/apple pie.md"]],
    ['file:"apple pie"', ["S/apple pie.md"]],
    ["ban*", []],
    ["case:FOO", []],
  ];
  for (const [q, expected] of cases) {
    it(q, async () => {
      const { brain } = await makeBrain(corpus);
      expect(brain.search(q).map((r) => r.path).sort()).toEqual([...expected].sort());
    });
  }
  it("negation alone returns files without the term", async () => {
    const { brain } = await makeBrain(corpus);
    expect(brain.search("-apple").map((r) => r.path).sort()).toEqual(["Other.md", "S/code.md"]);
  });
});

describe("templates and daily notes", () => {
  it("applies variables case-insensitively and leaves unknown ones", () => {
    const now = new Date(2026, 9, 31, 15, 41);
    const out = applyTemplate("title={{title}}|date={{date}}|time={{time}}|d2={{date:YYYY/MM/DD}}|t2={{time:HH}}|x={{foo}}|DT={{Date}}", { title: "TplTarget", now });
    expect(out).toBe("title=TplTarget|date=2026-10-31|time=15:41|d2=2026/10/31|t2=15|x={{foo}}|DT=2026-10-31");
  });

  it("formats and parses dates", () => {
    const d = new Date(2026, 0, 5, 7, 3, 9);
    expect(formatDate(d, "YYYY-MM-DD HH:mm:ss dddd [W]ww")).toBe("2026-01-05 07:03:09 Monday W02");
    expect(parseDate("2026-01-05", "YYYY-MM-DD")?.getDate()).toBe(5);
    expect(parseDate("nope", "YYYY-MM-DD")).toBeNull();
  });

  it("creates YYYY-MM-DD.md at the vault root, empty by default; finds prev/next", async () => {
    const { brain, read } = await makeBrain({ "2026-10-29.md": "", "2026-11-02.md": "" });
    const r = await brain.daily(new Date(2026, 9, 31));
    expect(r).toEqual({ path: "2026-10-31.md", created: true });
    expect(read("2026-10-31.md")).toBe("");
    expect(brain.adjacentDaily("2026-10-31.md", -1)).toBe("2026-10-29.md");
    expect(brain.adjacentDaily("2026-10-31.md", 1)).toBe("2026-11-02.md");
  });
});

describe("parser", () => {
  it("ignores links and tags in code, comments and math", () => {
    const m = parseNote("```\n[[InCode]] #nottag\n```\n%% [[Hidden]] %%\n$x#y$ `[[Inline]]` [[Real]] #real\n$$\n[[InMath]]\n$$\n");
    expect(m.links.map((l) => l.link)).toEqual(["Real"]);
    expect(m.tags.map((t) => t.tag)).toEqual(["#real"]);
  });

  it("extracts headings, blocks, tasks, subpaths and aliases", () => {
    const m = parseNote("# Title\npara ^abc\n- [ ] open\n- [x] done\n[[Note#Head|Alias]] ![[img.png|120]] [x](https://e.com) [y](Folder/My%20Note.md#H)\n");
    expect(m.headings.map((h) => [h.heading, h.level])).toEqual([["Title", 1]]);
    expect(m.blocks).toEqual({ abc: { line: 1 } });
    expect(m.tasks.map((t) => t.status)).toEqual([" ", "x"]);
    expect(m.links.map((l) => [l.link, l.subpath, l.display])).toEqual([["Note", "#Head", "Alias"], ["Folder/My Note.md", "#H", "y"]]);
    expect(m.embeds.map((l) => [l.link, l.display])).toEqual([["img.png", "120"]]);
  });

  it("does not treat numeric-only or heading markers as tags", () => {
    const m = parseNote("#123 #a1 ## heading\n#tag/sub/ text");
    expect(m.tags.map((t) => t.tag)).toEqual(["#a1", "#tag/sub"]);
  });
});

describe("writes", () => {
  it("rejects stale writes with a clear error", async () => {
    const { brain } = await makeBrain({ "N.md": "one" });
    const { etag } = await brain.read("N.md");
    await brain.write("N.md", "two", { ifMatch: etag, source: "ui" });
    await expect(brain.write("N.md", "three", { ifMatch: etag, source: "mcp" })).rejects.toMatchObject({ status: 409, code: "stale" });
  });

  it("prepends after frontmatter, appends with newline, soft-deletes to .trash", async () => {
    const { brain, read, exists } = await makeBrain({ "N.md": "---\na: 1\n---\nbody" });
    await brain.prepend("N", "top", "mcp");
    await brain.append("N", "end", "mcp");
    expect(read("N.md")).toBe("---\na: 1\n---\ntop\nbody\nend\n");
    await brain.delete("N.md", "mcp");
    expect(exists("N.md")).toBe(false);
    expect(exists(".trash/N.md")).toBe(true);
    await brain.restore("N.md", "ui");
    expect(exists("N.md")).toBe(true);
  });

  it("rejects path traversal", async () => {
    const { brain } = await makeBrain({});
    await expect(brain.write("../escape.md", "x", { source: "ui" })).rejects.toMatchObject({ status: 400 });
    await expect(brain.write(".git/config", "x", { source: "ui" })).rejects.toMatchObject({ status: 400 });
  });

  it("sets and removes properties preserving body", async () => {
    const { brain, read } = await makeBrain({ "N.md": "---\na: 1\n---\nbody\n", "M.md": "plain\n" });
    await brain.setProperty("N", "status", "done", "mcp");
    expect(read("N.md")).toBe("---\na: 1\nstatus: done\n---\nbody\n");
    await brain.setProperty("M", "tags", ["x", "y"], "mcp");
    expect(read("M.md")).toBe("---\ntags:\n  - x\n  - y\n---\nplain\n");
    await brain.removeProperty("M", "tags", "mcp");
    expect(read("M.md")).toBe("plain\n");
  });
});
