// Graph view: canvas renderer + d3-force simulation.
// Option defaults chosen to match Obsidian's graph view.

import { forceCenter, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { api, type GraphData } from "../api";
import { h } from "../dom";

interface GNode extends SimulationNodeDatum {
  id: string;
  type: "note" | "attachment" | "tag" | "unresolved";
  label: string;
  weight: number;
}
type GLink = SimulationLinkDatum<GNode> & { source: GNode | string; target: GNode | string };

export interface GraphOptions {
  search: string;
  showTags: boolean;
  showAttachments: boolean;
  hideUnresolved: boolean;
  showOrphans: boolean;
  showArrow: boolean;
  textFadeMultiplier: number;
  nodeSizeMultiplier: number;
  lineSizeMultiplier: number;
  centerStrength: number;
  repelStrength: number;
  linkStrength: number;
  linkDistance: number;
  local: boolean;
  localDepth: number;
}

export const DEFAULT_GRAPH: GraphOptions = {
  search: "",
  showTags: false,
  showAttachments: false,
  hideUnresolved: false,
  showOrphans: true,
  showArrow: false,
  textFadeMultiplier: 0,
  nodeSizeMultiplier: 1,
  lineSizeMultiplier: 1,
  centerStrength: 0.52,
  repelStrength: 10,
  linkStrength: 1,
  linkDistance: 250,
  local: false,
  localDepth: 1,
};

function loadOpts(): GraphOptions {
  try {
    return { ...DEFAULT_GRAPH, ...JSON.parse(localStorage.getItem("brain.graph") ?? "{}") };
  } catch {
    return { ...DEFAULT_GRAPH };
  }
}

export class GraphView {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sim: Simulation<GNode, GLink> | null = null;
  private nodes: GNode[] = [];
  private links: GLink[] = [];
  private neighbors = new Map<string, Set<string>>();
  private opts = loadOpts();
  private scale = 1;
  private panX = 0;
  private panY = 0;
  private hover: GNode | null = null;
  private drag: GNode | null = null;
  private raf = 0;
  private dirty = true;
  private ro: ResizeObserver;
  private dpr = window.devicePixelRatio || 1;
  private colors = { note: "", tag: "", attachment: "", unresolved: "", line: "", text: "", accent: "", bg: "" };
  private filterSet: Set<string> | null = null;

  constructor(private getActive: () => string | null, private open: (path: string, newTab: boolean) => void) {
    this.canvas = h("canvas", { class: "graph-canvas" });
    this.ctx = this.canvas.getContext("2d")!;
    this.el = h("div", { class: "graph-view" }, this.canvas, this.controls());
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    this.bindPointer();
    void this.reload();
    const loop = () => {
      if (this.dirty) {
        this.draw();
        this.dirty = false;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private save() {
    localStorage.setItem("brain.graph", JSON.stringify(this.opts));
  }

  private controls() {
    const section = (title: string, ...rows: Node[]) => {
      const body = h("div", { class: "graph-section-body" }, ...rows);
      const head = h("div", { class: "graph-section-title", onclick: () => body.classList.toggle("is-collapsed") }, title);
      body.classList.add("is-collapsed");
      return h("div", { class: "graph-section" }, head, body);
    };
    const toggle = (label: string, key: keyof GraphOptions, reload = true) => {
      const cb = h("input", { type: "checkbox", checked: !!this.opts[key] }) as HTMLInputElement;
      cb.addEventListener("change", () => {
        (this.opts as unknown as Record<string, unknown>)[key] = cb.checked;
        this.save();
        if (reload) void this.reload();
        else this.dirty = true;
      });
      return h("label", { class: "graph-row" }, h("span", null, label), cb);
    };
    const slider = (label: string, key: keyof GraphOptions, min: number, max: number, step: number, apply: () => void) => {
      const r = h("input", { type: "range", min, max, step, value: String(this.opts[key]) }) as HTMLInputElement;
      r.addEventListener("input", () => {
        (this.opts as unknown as Record<string, unknown>)[key] = Number(r.value);
        this.save();
        apply();
      });
      return h("label", { class: "graph-row" }, h("span", null, label), r);
    };
    const search = h("input", { class: "input", type: "search", placeholder: "Search files…", value: this.opts.search }) as HTMLInputElement;
    let t: ReturnType<typeof setTimeout>;
    search.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        this.opts.search = search.value;
        this.save();
        void this.applyFilter();
      }, 300);
    });
    const forces = () => this.applyForces();
    return h(
      "div",
      { class: "graph-controls" },
      section("Filters", search, toggle("Tags", "showTags"), toggle("Attachments", "showAttachments"), toggle("Existing files only", "hideUnresolved"), toggle("Orphans", "showOrphans"), toggle("Local graph (active note)", "local"), slider("Depth", "localDepth", 1, 5, 1, () => void this.reload())),
      section("Display", toggle("Arrows", "showArrow", false), slider("Text fade threshold", "textFadeMultiplier", -3, 3, 0.1, () => (this.dirty = true)), slider("Node size", "nodeSizeMultiplier", 0.1, 5, 0.1, () => (this.dirty = true)), slider("Link thickness", "lineSizeMultiplier", 0.1, 5, 0.1, () => (this.dirty = true))),
      section("Forces", slider("Center force", "centerStrength", 0, 1, 0.01, forces), slider("Repel force", "repelStrength", 0, 20, 0.1, forces), slider("Link force", "linkStrength", 0, 1, 0.01, forces), slider("Link distance", "linkDistance", 30, 500, 1, forces)),
      h("button", { class: "btn btn-small", onclick: () => { this.opts = { ...DEFAULT_GRAPH }; this.save(); this.el.querySelector(".graph-controls")?.replaceWith(this.controls()); void this.reload(); } }, "Restore defaults"),
    );
  }

  async reload() {
    let data: GraphData;
    try {
      data = await api.graph(this.opts);
    } catch {
      return;
    }
    if (this.opts.local) data = this.localSubgraph(data);
    const old = new Map(this.nodes.map((n) => [n.id, n]));
    this.nodes = data.nodes.map((n) => {
      const o = old.get(n.id);
      return o ? Object.assign(o, n) : { ...n, x: (Math.random() - 0.5) * 400, y: (Math.random() - 0.5) * 400 };
    });
    this.links = data.links.map((l) => ({ ...l }));
    this.neighbors.clear();
    for (const l of data.links) {
      if (!this.neighbors.has(l.source)) this.neighbors.set(l.source, new Set());
      if (!this.neighbors.has(l.target)) this.neighbors.set(l.target, new Set());
      this.neighbors.get(l.source)!.add(l.target);
      this.neighbors.get(l.target)!.add(l.source);
    }
    this.sim?.stop();
    this.sim = forceSimulation<GNode, GLink>(this.nodes)
      .force("link", forceLink<GNode, GLink>(this.links).id((d) => d.id))
      .force("charge", forceManyBody<GNode>())
      .force("center", forceCenter(0, 0))
      .force("x", forceX<GNode>(0))
      .force("y", forceY<GNode>(0))
      .alphaDecay(0.02)
      .velocityDecay(0.35)
      .on("tick", () => (this.dirty = true));
    this.applyForces();
    await this.applyFilter();
  }

  private localSubgraph(data: GraphData): GraphData {
    const center = this.getActive();
    if (!center) return { nodes: [], links: [] };
    const adj = new Map<string, string[]>();
    for (const l of data.links) {
      (adj.get(l.source) ?? adj.set(l.source, []).get(l.source)!).push(l.target);
      (adj.get(l.target) ?? adj.set(l.target, []).get(l.target)!).push(l.source);
    }
    const keep = new Set([center]);
    let frontier = [center];
    for (let d = 0; d < this.opts.localDepth; d++) {
      const next: string[] = [];
      for (const n of frontier) for (const m of adj.get(n) ?? []) if (!keep.has(m)) (keep.add(m), next.push(m));
      frontier = next;
    }
    return { nodes: data.nodes.filter((n) => keep.has(n.id)), links: data.links.filter((l) => keep.has(l.source) && keep.has(l.target)) };
  }

  private async applyFilter() {
    const q = this.opts.search.trim();
    if (!q) this.filterSet = null;
    else {
      try {
        const r = await api.search(q, 5000);
        this.filterSet = new Set(r.results.map((x) => x.path));
      } catch {
        this.filterSet = null;
      }
    }
    this.dirty = true;
  }

  private applyForces() {
    if (!this.sim) return;
    const o = this.opts;
    (this.sim.force("link") as ReturnType<typeof forceLink<GNode, GLink>>).distance(o.linkDistance * 0.4).strength(o.linkStrength);
    (this.sim.force("charge") as ReturnType<typeof forceManyBody<GNode>>).strength(-(o.repelStrength ** 1.6) * 4 - 5).distanceMax(600);
    (this.sim.force("x") as ReturnType<typeof forceX<GNode>>).strength(o.centerStrength * 0.08);
    (this.sim.force("y") as ReturnType<typeof forceY<GNode>>).strength(o.centerStrength * 0.08);
    this.sim.alpha(0.6).restart();
  }

  private readColors() {
    const s = getComputedStyle(this.el);
    const v = (n: string) => s.getPropertyValue(n).trim();
    this.colors = { note: v("--graph-node"), tag: v("--graph-tag"), attachment: v("--graph-attachment"), unresolved: v("--graph-unresolved"), line: v("--graph-line"), text: v("--text-normal"), accent: v("--accent"), bg: v("--bg-primary") };
  }

  private resize() {
    const r = this.el.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, r.width * this.dpr);
    this.canvas.height = Math.max(1, r.height * this.dpr);
    this.canvas.style.width = r.width + "px";
    this.canvas.style.height = r.height + "px";
    this.readColors();
    this.dirty = true;
  }

  private radius(n: GNode) {
    return (4 + Math.sqrt(n.weight) * 1.6) * this.opts.nodeSizeMultiplier;
  }

  private toWorld(cx: number, cy: number) {
    const w = this.canvas.width / this.dpr;
    const hgt = this.canvas.height / this.dpr;
    return { x: (cx - w / 2 - this.panX) / this.scale, y: (cy - hgt / 2 - this.panY) / this.scale };
  }

  private nodeAt(cx: number, cy: number): GNode | null {
    const p = this.toWorld(cx, cy);
    let best: GNode | null = null;
    let bd = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot((n.x ?? 0) - p.x, (n.y ?? 0) - p.y);
      const r = this.radius(n) + 4 / this.scale;
      if (d < r && d < bd) (best = n), (bd = d);
    }
    return best;
  }

  private visible(n: GNode) {
    return !this.filterSet || this.filterSet.has(n.id);
  }

  private draw() {
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr;
    const hgt = this.canvas.height / this.dpr;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    ctx.translate(w / 2 + this.panX, hgt / 2 + this.panY);
    ctx.scale(this.scale, this.scale);
    const focus = this.hover ?? this.drag;
    const nb = focus ? this.neighbors.get(focus.id) ?? new Set() : null;
    const active = this.getActive();

    ctx.lineWidth = (1 * this.opts.lineSizeMultiplier) / Math.max(0.5, this.scale) ;
    for (const l of this.links) {
      const s = l.source as GNode;
      const t = l.target as GNode;
      if (!this.visible(s) || !this.visible(t)) continue;
      const hl = focus && (s === focus || t === focus);
      ctx.strokeStyle = hl ? this.colors.accent : this.colors.line;
      ctx.globalAlpha = focus && !hl ? 0.15 : hl ? 0.9 : 0.5;
      ctx.beginPath();
      ctx.moveTo(s.x ?? 0, s.y ?? 0);
      ctx.lineTo(t.x ?? 0, t.y ?? 0);
      ctx.stroke();
      if (this.opts.showArrow) {
        const ang = Math.atan2((t.y ?? 0) - (s.y ?? 0), (t.x ?? 0) - (s.x ?? 0));
        const r = this.radius(t);
        const ax = (t.x ?? 0) - Math.cos(ang) * r;
        const ay = (t.y ?? 0) - Math.sin(ang) * r;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - Math.cos(ang - 0.4) * 6, ay - Math.sin(ang - 0.4) * 6);
        ctx.lineTo(ax - Math.cos(ang + 0.4) * 6, ay - Math.sin(ang + 0.4) * 6);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    const textAlpha = Math.min(1, Math.max(0, (this.scale - 0.6 + this.opts.textFadeMultiplier * 0.2) * 2));
    ctx.font = `${12 / Math.max(0.6, this.scale)}px var(--font-ui), sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const n of this.nodes) {
      if (!this.visible(n)) continue;
      const dim = focus && n !== focus && !nb!.has(n.id);
      ctx.globalAlpha = dim ? 0.2 : 1;
      const r = this.radius(n);
      ctx.fillStyle = n === focus || n.id === active ? this.colors.accent : this.colors[n.type === "note" ? "note" : n.type];
      ctx.beginPath();
      ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, Math.PI * 2);
      ctx.fill();
      const showText = n === focus || (nb && nb.has(n.id)) || textAlpha > 0;
      if (showText) {
        ctx.globalAlpha = dim ? 0.15 : n === focus || (nb && nb.has(n.id)) ? 1 : textAlpha;
        ctx.fillStyle = this.colors.text;
        ctx.fillText(n.label, n.x ?? 0, (n.y ?? 0) + r + 3 / this.scale);
      }
    }
    ctx.globalAlpha = 1;
  }

  private bindPointer() {
    let panning: { x: number; y: number; px: number; py: number } | null = null;
    let moved = false;
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      moved = false;
      const n = this.nodeAt(e.offsetX, e.offsetY);
      if (n) {
        this.drag = n;
        n.fx = n.x;
        n.fy = n.y;
        this.sim?.alphaTarget(0.3).restart();
      } else panning = { x: e.clientX, y: e.clientY, px: this.panX, py: this.panY };
    });
    c.addEventListener("pointermove", (e) => {
      if (this.drag) {
        moved = true;
        const p = this.toWorld(e.offsetX, e.offsetY);
        this.drag.fx = p.x;
        this.drag.fy = p.y;
        this.dirty = true;
      } else if (panning) {
        moved = true;
        this.panX = panning.px + (e.clientX - panning.x);
        this.panY = panning.py + (e.clientY - panning.y);
        this.dirty = true;
      } else {
        const n = this.nodeAt(e.offsetX, e.offsetY);
        if (n !== this.hover) {
          this.hover = n;
          c.style.cursor = n ? "pointer" : "default";
          this.dirty = true;
        }
      }
    });
    c.addEventListener("pointerup", (e) => {
      if (this.drag) {
        const n = this.drag;
        n.fx = null;
        n.fy = null;
        this.sim?.alphaTarget(0);
        this.drag = null;
        if (!moved && (n.type === "note" || n.type === "attachment")) this.open(n.id, e.ctrlKey || e.metaKey);
        if (!moved && n.type === "tag") window.dispatchEvent(new CustomEvent("brain:search", { detail: `tag:${n.label}` }));
      }
      panning = null;
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const before = this.toWorld(e.offsetX, e.offsetY);
        this.scale = Math.min(8, Math.max(0.05, this.scale * Math.exp(-e.deltaY * 0.0015)));
        const after = this.toWorld(e.offsetX, e.offsetY);
        this.panX += (after.x - before.x) * this.scale;
        this.panY += (after.y - before.y) * this.scale;
        this.dirty = true;
      },
      { passive: false },
    );
  }

  refreshTheme() {
    this.readColors();
    this.dirty = true;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.sim?.stop();
    this.ro.disconnect();
  }
}
