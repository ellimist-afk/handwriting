/**
 * Saved PDF highlights as one layer of their own, under the saved pen ink.
 *
 * A page that holds a highlight gets a group below its saved pen canvas: the
 * group carries the wash once (opacity HIGHLIGHTER_ALPHA, multiply), and the
 * highlights are painted opaque on a canvas inside it. A live highlighter
 * draws inside the same group and goes back over the saved pen ink at the
 * lift. These cells hold the structure and its bookkeeping: which elements
 * exist, where the pair sits, what the root observer sees, what is released.
 * The pixels are the render cells' (test/render/PdfHighlightLayer.test.ts).
 *
 * Driven through the controller's own sync, paint and pen callbacks over a
 * small element fake that keeps a child list and writes the childList records
 * a browser would. Only the viewer probe is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { computeBBox, InkStroke } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest } from "../inline/TipMode";
import { setInlineTool } from "../inline/InkOverlay";
import type { PdfPageAssumption } from "../ink/InkPdf";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({
	probeViewer: () => probe.current,
	viewerCanvasOf: () => null,
	wholePageCanvasOf: () => null,
}));

import { PdfInkController } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";
import { HIGHLIGHT_CANVAS_CLASS, HIGHLIGHT_GROUP_CLASS, OVERLAY_CLASS, setViewTurnSource } from "./PdfInkBand";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";
import { HandwritingSettingTab } from "../settings/HandwritingSettingTab";
import css from "../../styles.css?raw";

/** Canvases that answer no 2d context, as a browser at its canvas memory cap does; null for none. */
let contextless: ((el: El) => boolean) | null = null;

const PAGE_W = 600;
const PAGE_H = 800;

// ---- an element fake with a real child list and the records a browser writes ----

interface Rec {
	type: "childList";
	target: El;
	addedNodes: El[];
	removedNodes: El[];
}
let records: Rec[] = [];
/**
 * The root observer, timed as a browser times it: the first record of a batch
 * queues one microtask, and every record written before it runs joins that
 * batch. Null: records are only kept in `records`.
 */
let observer: ((batch: Rec[]) => void) | null = null;
let pending: Rec[] | null = null;
function record(rec: Rec): void {
	records.push(rec);
	if (!observer) return;
	if (!pending) {
		pending = [];
		queueMicrotask(() => {
			const batch = pending ?? [];
			pending = null;
			observer?.(batch);
		});
	}
	pending.push(rec);
}
/** Let every queued microtask run, as the browser does between two input events. */
async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

type M = [number, number, number, number, number, number];
const mul = (m: M, a: number, b: number, c: number, d: number, e: number, f: number): M => [
	m[0] * a + m[2] * b,
	m[1] * a + m[3] * b,
	m[0] * c + m[2] * d,
	m[1] * c + m[3] * d,
	m[0] * e + m[2] * f + m[4],
	m[1] * e + m[3] * f + m[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const invert = (m: M): M => {
	const det = m[0] * m[3] - m[1] * m[2];
	return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};

/** One fill or stroke a canvas took, with the alpha it was taken at. */
interface Paint {
	op: string;
	alpha: number;
	composite: string;
}

/** What one canvas's 2d context was asked to do. */
class Ctx {
	paints: Paint[] = [];
	clears = 0;
	calls: string[] = [];
	/** Path points in device px, since the last setTransform on a cleared stack. */
	device: Array<[number, number]> = [];
	/** The transform the newest paint opened with. */
	base: M | null = null;
	private m: M = [1, 0, 0, 1, 0, 0];
	private stack: M[] = [];
	readonly state: Record<string, unknown> = {
		globalAlpha: 1,
		globalCompositeOperation: "source-over",
		fillStyle: "#000000",
		strokeStyle: "#000000",
		lineWidth: 1,
		lineCap: "butt",
		lineJoin: "miter",
		filter: "none",
		imageSmoothingEnabled: true,
	};
	readonly proxy: CanvasRenderingContext2D;
	constructor(readonly canvas: El) {
		const self = this;
		const point = (x: number, y: number): void => {
			self.device.push(apply(self.m, x, y));
		};
		const fns: Record<string, (...a: number[]) => unknown> = {
			setTransform: (...a: number[]) => {
				const t = (typeof a[0] === "object" ? (({ a: A, b, c, d, e, f }: DOMMatrix) => [A, b, c, d, e, f])(a[0] as unknown as DOMMatrix) : a) as M;
				if (self.stack.length === 0) {
					self.base = [...t] as M;
					self.device = [];
				}
				self.m = [...t] as M;
			},
			transform: (a, b, c, d, e, f) => {
				self.m = mul(self.m, a!, b!, c!, d!, e!, f!);
			},
			translate: (x, y) => {
				self.m = mul(self.m, 1, 0, 0, 1, x!, y!);
			},
			scale: (x, y) => {
				self.m = mul(self.m, x!, 0, 0, y!, 0, 0);
			},
			save: () => {
				self.stack.push(self.m);
			},
			restore: () => {
				self.m = self.stack.pop() ?? self.m;
			},
			getTransform: () => ({ a: self.m[0], b: self.m[1], c: self.m[2], d: self.m[3], e: self.m[4], f: self.m[5] }),
			clearRect: () => {
				self.clears++;
			},
			moveTo: (x, y) => point(x!, y!),
			lineTo: (x, y) => point(x!, y!),
			quadraticCurveTo: (_cx, _cy, x, y) => point(x!, y!),
			bezierCurveTo: (_a, _b, _c, _d, x, y) => point(x!, y!),
			arc: (x, y) => point(x!, y!),
			ellipse: (x, y) => point(x!, y!),
			fill: () => {
				self.paints.push({ op: "fill", alpha: Number(self.state.globalAlpha), composite: String(self.state.globalCompositeOperation) });
			},
			stroke: () => {
				self.paints.push({ op: "stroke", alpha: Number(self.state.globalAlpha), composite: String(self.state.globalCompositeOperation) });
			},
			drawImage: () => {
				self.paints.push({ op: "drawImage", alpha: Number(self.state.globalAlpha), composite: String(self.state.globalCompositeOperation) });
			},
			getContextAttributes: () => ({ desynchronized: false }),
		};
		this.proxy = new Proxy({} as Record<string, unknown>, {
			get(_t, p) {
				const key = String(p);
				if (key === "canvas") return self.canvas;
				if (key in self.state) return self.state[key];
				const fn = fns[key];
				return (...args: number[]) => {
					self.calls.push(key);
					return fn ? fn(...args) : undefined;
				};
			},
			set(_t, p, v) {
				self.state[String(p)] = v;
				return true;
			},
		}) as unknown as CanvasRenderingContext2D;
	}
}

class El {
	readonly classes = new Set<string>();
	children: El[] = [];
	parentElement: El | null = null;
	css: Record<string, string> = {};
	attrs: Record<string, string> = {};
	width = 300;
	height = 150;
	clientWidth = 0;
	clientHeight = 0;
	scrollLeft = 0;
	scrollTop = 0;
	scrollWidth = 0;
	scrollHeight = 0;
	ctx: Ctx | null = null;
	/** For the scroller: the page div the viewer would hand back. */
	page: El | null = null;
	constructor(readonly tag: string, cls?: string | string[]) {
		for (const c of cls === undefined ? [] : Array.isArray(cls) ? cls : cls.split(" ")) if (c) this.classes.add(c);
	}
	get lastElementChild(): El | null {
		return this.children[this.children.length - 1] ?? null;
	}
	get nextElementSibling(): El | null {
		const p = this.parentElement;
		if (!p) return null;
		return p.children[p.children.indexOf(this) + 1] ?? null;
	}
	get classList() {
		return {
			contains: (c: string) => this.classes.has(c),
			add: (...c: string[]) => c.forEach((x) => this.classes.add(x)),
			remove: (...c: string[]) => c.forEach((x) => this.classes.delete(x)),
			toggle: (c: string, on?: boolean) => ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)),
		};
	}
	get className(): string {
		return [...this.classes].join(" ");
	}
	instanceOf(): boolean {
		return true;
	}
	closest(): null {
		return null;
	}
	private detach(): void {
		const p = this.parentElement;
		if (!p) return;
		p.children.splice(p.children.indexOf(this), 1);
		this.parentElement = null;
		record({ type: "childList", target: p, addedNodes: [], removedNodes: [this] });
	}
	insertBefore(n: El, ref: El | null): El {
		n.detach();
		const i = ref ? this.children.indexOf(ref) : -1;
		if (i < 0) this.children.push(n);
		else this.children.splice(i, 0, n);
		n.parentElement = this;
		record({ type: "childList", target: this, addedNodes: [n], removedNodes: [] });
		return n;
	}
	appendChild(n: El): El {
		return this.insertBefore(n, null);
	}
	remove(): void {
		this.detach();
	}
	createEl(tag: string, o?: { cls?: string | string[] }): El {
		return this.appendChild(new El(tag, o?.cls));
	}
	createDiv(o?: { cls?: string | string[] }): El {
		return this.createEl("div", o);
	}
	setAttribute(k: string, v: string): void {
		this.attrs[k] = v;
	}
	getAttribute(k: string): string | null {
		return this.attrs[k] ?? null;
	}
	setCssProps(p: Record<string, string>): void {
		Object.assign(this.css, p);
	}
	setCssStyles(p: Record<string, string>): void {
		Object.assign(this.css, p);
	}
	toggleClass(c: string, on: boolean): void {
		if (on) this.classes.add(c);
		else this.classes.delete(c);
	}
	getContext(): CanvasRenderingContext2D | null {
		if (contextless?.(this)) return null;
		this.ctx ??= new Ctx(this);
		return this.ctx.proxy;
	}
	toBlob(done: (blob: Blob | null) => void): void {
		done(new Blob(["png"]));
	}
	querySelector(sel: string): El | null {
		return /data-page-number="1"/.test(sel) ? this.page : null;
	}
	querySelectorAll(): El[] {
		return [];
	}
	getBoundingClientRect() {
		return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight };
	}
	addEventListener(): void {}
	removeEventListener(): void {}
	setPointerCapture(): void {}
	releasePointerCapture(): void {}
	contains(): boolean {
		return false;
	}
	get style() {
		return this.css;
	}
	/** Every element under this one, depth first. */
	all(): El[] {
		return this.children.flatMap((c) => [c, ...c.all()]);
	}
}

// ---- strokes ----

function stroke(id: string, tool: "pen" | "highlighter", cx: number, cy: number, color: string): InkStroke {
	const points = [-20, 0, 20].map((d, i) => ({ x: cx + d, y: cy, pressure: 0.5, t: i * 8 }));
	return { id, tool, color, width: tool === "highlighter" ? 12 : 2, points, bbox: computeBBox(points, tool === "highlighter" ? 12 : 4), createdAt: 0, page: 1 };
}
const penAt = (id: string, cx: number, cy: number) => stroke(id, "pen", cx, cy, "#000000");
const highlightAt = (id: string, cx: number, cy: number) => stroke(id, "highlighter", cx, cy, "#ffd60a");

function sample(x: number, y: number, t: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: t, tiltX: 0, tiltY: 0 };
}

// ---- the rig ----

interface Priv {
	mounted: boolean;
	boundScroller: unknown;
	pair: { wetCanvas: El; headCanvas: El } | null;
	wetHostPage: number;
	overlays: Map<number, { canvas: El }>;
	sync(): void;
	invalidateProbe(): void;
	penDown(s: PenSample, ev?: PointerEvent): void;
	penRaw(s: PenSample[]): void;
	penUp(): void;
	attachPair(pageEl: unknown, box: unknown): unknown;
	dropOverlays(): void;
	isOwnMutation(r: MutationRecord): boolean;
	drawLasso(box: unknown): void;
	selectionPage: number;
	selected: string[];
	snipSelection(): Promise<{ ok: boolean; reason?: string }>;
}

interface Rig {
	priv: Priv;
	page: El;
	scroller: El;
	viewerCanvas: El;
	strokes(): InkStroke[];
	setStrokes(s: InkStroke[]): void;
	/** The viewer still renders the page (true) or let go of it (false). */
	rendered(on: boolean): void;
	sync(): void;
	box(): { pageNumber: number; leftPx: number; topPx: number; widthPx: number; heightPx: number };
	turn(deg: 0 | 90 | 180 | 270): void;
	/** Run every animation frame the controller asked for, until none is left; how many ran. */
	frames(): number;
}

const cleanups: Array<() => void> = [];

function rig(saved: InkStroke[], assumption: PdfPageAssumption | (() => PdfPageAssumption) = "darken"): Rig {
	resetTipModeForTest();
	const assumed = typeof assumption === "function" ? assumption : () => assumption;
	// Frames are held, not run, unless a cell asks (frames()); the id stays 0 as before.
	const queued: Array<() => void> = [];
	let strokes = saved;
	let rendered = true;
	let deg: 0 | 90 | 180 | 270 = 0;
	const dims = () => (deg % 180 === 0 ? { w: PAGE_W, h: PAGE_H } : { w: PAGE_H, h: PAGE_W });
	const page = new El("div", "page");
	page.attrs["data-page-number"] = "1";
	const viewerCanvas = page.createEl("canvas");
	const scroller = new El("div", "pdfViewer");
	scroller.page = page;
	scroller.appendChild(page);
	const size = () => {
		page.clientWidth = dims().w;
		page.clientHeight = dims().h;
		scroller.clientWidth = dims().w;
		scroller.clientHeight = dims().h;
		scroller.scrollWidth = dims().w;
		scroller.scrollHeight = dims().h;
	};
	size();
	const box = () => ({ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: dims().w, heightPx: dims().h });
	const report = () => {
		probe.current = { scroller, scaleFactor: 1, scaleSource: "test", pages: [{ ...box(), hasCanvas: rendered }] };
	};
	report();
	const win = {
		devicePixelRatio: 1,
		setTimeout: () => 0,
		clearTimeout: () => {},
		requestAnimationFrame: (cb: () => void) => {
			queued.push(cb);
			return 0;
		},
		cancelAnimationFrame: () => {},
		getComputedStyle: () => ({ position: "relative" }),
		navigator: { userAgent: "", platform: "", maxTouchPoints: 0 },
	};
	const controller = new PdfInkController(
		{} as HTMLElement,
		win as unknown as Window,
		() => strokes,
		() => "doc-1",
		() => strokes,
		(op: InkOp) => {
			strokes = applyOp(strokes, op);
		},
		() => {},
		() => {},
		() => {},
		() => false,
		assumed
	);
	setViewTurnSource(controller, () => deg);
	const priv = controller as unknown as Priv;
	priv.mounted = true;
	priv.boundScroller = scroller;
	const sync = () => {
		size();
		report();
		priv.invalidateProbe();
		priv.sync();
	};
	return {
		priv,
		page,
		scroller,
		viewerCanvas,
		strokes: () => strokes,
		setStrokes: (s) => {
			strokes = s;
		},
		rendered: (on) => {
			rendered = on;
		},
		sync,
		box,
		turn: (d) => {
			deg = d;
			sync();
		},
		frames: () => {
			let ran = 0;
			for (let cb = queued.shift(); cb; cb = queued.shift()) {
				if (++ran > 50) throw new Error("the controller keeps asking for frames");
				cb();
			}
			return ran;
		},
	};
}

beforeEach(() => {
	records = [];
	observer = null;
	pending = null;
	setInlineTool("pen");
	// The own-write filter asks each record's target `instanceOf(Element)`.
	vi.stubGlobal("Element", El);
});
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
	setInlineTool("pen");
	probe.current = null;
	contextless = null;
	vi.unstubAllGlobals();
});

/** The page's highlight layer: a div of ours directly under the page, holding a canvas. */
function layerOf(page: El): { group: El; canvas: El } | null {
	const group = page.children.find((c) => c.tag === "div" && c.classes.has(OVERLAY_CLASS));
	const canvas = group?.children.find((c) => c.tag === "canvas" && c.classes.has(OVERLAY_CLASS));
	return group && canvas ? { group, canvas } : null;
}
/** The saved pen canvas: the page's own overlay. */
function penCanvasOf(r: Rig): El {
	const a = r.priv.overlays.get(1);
	if (!a) throw new Error("no saved-ink canvas on page 1");
	return a.canvas;
}
/** Canvases under the page the viewer probe would count as the viewer's. */
/** The declarations of one selector's rule in the shipped stylesheet; the selector must have exactly one rule. */
function ruleOf(selector: string): Record<string, string> {
	const head = `${selector} {`;
	const at = css.indexOf(head);
	expect(at, `no rule for ${selector} in styles.css`).toBeGreaterThanOrEqual(0);
	expect(css.indexOf(head, at + 1), `two rules for ${selector} in styles.css`).toBe(-1);
	const body = css.slice(at + head.length, css.indexOf("}", at));
	const out: Record<string, string> = {};
	for (const d of body.split(";")) {
		const i = d.indexOf(":");
		if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
	}
	return out;
}

const viewerCanvases = (page: El) => page.all().filter((c) => c.tag === "canvas" && !c.classes.has(OVERLAY_CLASS));
/** Does anything from this element up to the page take the wash (opacity under 1)? */
function washedBetween(el: El, page: El): boolean {
	for (let at: El | null = el; at && at !== page; at = at.parentElement) {
		if (at.css.opacity !== undefined && Number(at.css.opacity) < 1) return true;
	}
	return false;
}
/** A highlighter (or pen) stroke on page 1, down and moved; `lift` ends it. */
function strokeDown(r: Rig, tool: "pen" | "highlighter", y = 300): void {
	setInlineTool(tool);
	r.priv.penDown(sample(150, y, 0), { pointerType: "pen" } as PointerEvent);
	r.priv.penRaw([sample(200, y, 16), sample(250, y, 32), sample(300, y, 48)]);
}

describe("U1: the highlight layer's elements are ours and the viewer's canvas count does not move", () => {
	it("a page with a saved highlight gets one group below the saved pen canvas, its highlights opaque inside it", () => {
		const r = rig([penAt("a", 300, 200), highlightAt("h", 300, 200)]);
		const before = viewerCanvases(r.page).length;
		r.sync();
		const layer = layerOf(r.page);
		expect(layer, "no highlight layer on a page that holds a highlight").not.toBeNull();
		const pen = penCanvasOf(r);
		const kids = r.page.children;
		expect(kids.indexOf(layer!.group), "the group is not below the saved pen canvas").toBeLessThan(kids.indexOf(pen));
		// The wash is the stylesheet's, on the group's class: the highlighter's alpha, multiplied.
		expect(layer!.group.classes.has(HIGHLIGHT_GROUP_CLASS), "the group does not carry the wash").toBe(true);
		const rule = ruleOf(`.${OVERLAY_CLASS}.${HIGHLIGHT_GROUP_CLASS}`);
		expect(rule.opacity, "the group's rule does not carry the wash").toBe(String(HIGHLIGHTER_ALPHA));
		expect(rule["mix-blend-mode"], "the group is not blended multiply").toBe("multiply");
		// Opaque inside the group: the wash is the group's, once.
		const hl = layer!.canvas.ctx!.paints.filter((p) => p.op === "fill");
		expect(hl.length, "the highlight was not painted on its own canvas").toBeGreaterThan(0);
		expect(hl.every((p) => p.alpha === 1), "a highlight was filled translucent inside the group").toBe(true);
		// The pen canvas takes no translucent fill: it holds pen ink only.
		const penFills = pen.ctx!.paints.filter((p) => p.op === "fill");
		expect(penFills.length, "the pen ink was not painted").toBeGreaterThan(0);
		expect(penFills.every((p) => p.alpha === 1), "a highlight is still filled at 0.35 on the pen canvas").toBe(true);
		// Every element the fix adds carries the overlay class, so the probe's
		// `canvas:not(.handwriting-pdf-ink)` count is the viewer's alone.
		for (const el of [layer!.group, layer!.canvas]) expect(el.classes.has(OVERLAY_CLASS), el.tag).toBe(true);
		expect(viewerCanvases(r.page).length).toBe(before);
		expect(before).toBe(1);
	});

	it("a page with pen ink only has no highlight layer", () => {
		const r = rig([penAt("a", 300, 200)]);
		r.sync();
		expect(penCanvasOf(r).parentElement).toBe(r.page);
		expect(layerOf(r.page)).toBeNull();
		expect(r.page.all().filter((c) => c.tag === "div")).toEqual([]);
	});
});

describe("U2: a highlighter pen-down and lift cause no sync from the root observer", () => {
	/** The records the root observer acts on, as it is handed them, one batch per microtask. */
	function watch(r: Rig): Array<string> {
		const acted: string[] = [];
		observer = (batch) => {
			for (const x of batch) {
				if (!r.priv.isOwnMutation(x as unknown as MutationRecord)) {
					acted.push(`${x.target.tag}.${x.target.className} +${x.addedNodes.map((n) => n.className).join(",")} -${x.removedNodes.map((n) => n.className).join(",")}`);
				}
			}
		};
		return acted;
	}

	it("on a page that already holds a highlight: the pair goes into the group and back, and every record is ours", async () => {
		const r = rig([penAt("a", 300, 200), highlightAt("h", 300, 200)]);
		r.sync();
		// A pen stroke first, so the pair, the cursor and the canvases all exist.
		strokeDown(r, "pen", 500);
		r.priv.penUp();
		await settle();
		records = [];
		const acted = watch(r);
		strokeDown(r, "highlighter");
		await settle();
		const layer = layerOf(r.page);
		expect(layer, "precondition: the page has its highlight layer").not.toBeNull();
		expect(r.priv.pair!.wetCanvas.parentElement, "the live highlighter is not inside the group").toBe(layer!.group);
		expect(r.priv.pair!.headCanvas.parentElement).toBe(layer!.group);
		r.priv.penUp();
		await settle();
		expect(r.priv.pair!.wetCanvas.parentElement, "the pair did not go back to the page").toBe(r.page);
		expect(records.length, "precondition: the stroke moved nothing").toBeGreaterThan(0);
		expect(acted, "the root observer would sync on these").toEqual([]);
	});

	it("on a page with pen ink only: the group appears at pen-down, and every record is ours", async () => {
		const r = rig([penAt("a", 300, 200)]);
		r.sync();
		strokeDown(r, "pen", 500);
		r.priv.penUp();
		await settle();
		records = [];
		const acted = watch(r);
		strokeDown(r, "highlighter");
		await settle();
		const layer = layerOf(r.page);
		expect(layer, "no group while a highlighter is drawing on the page").not.toBeNull();
		expect(r.priv.pair!.wetCanvas.parentElement).toBe(layer!.group);
		r.priv.penUp();
		await settle();
		expect(acted, "the root observer would sync on these").toEqual([]);
	});

	it("the filter is not blanket: a viewer write, and a later move of the pair by anything else, still count", async () => {
		const r = rig([penAt("a", 300, 200), highlightAt("h", 300, 200)]);
		r.sync();
		strokeDown(r, "highlighter");
		expect(layerOf(r.page), "precondition: the page has its highlight layer").not.toBeNull();
		r.priv.penUp();
		await settle();
		const acted = watch(r);
		// The viewer adds a canvas of its own to the page.
		r.page.createEl("canvas");
		await settle();
		expect(acted.length).toBe(1);
		// The pair is moved off the page by a write that is not a group move.
		const other = new El("div", "page");
		other.appendChild(r.priv.pair!.wetCanvas);
		await settle();
		expect(acted.length).toBe(3);
	});
});

describe("U3: every drop of a page's saved ink takes its highlight layer with it", () => {
	function withLayer(): { r: Rig; layer: { group: El; canvas: El } } {
		const r = rig([penAt("a", 300, 200), highlightAt("h", 300, 200)]);
		r.sync();
		const layer = layerOf(r.page);
		expect(layer, "precondition: the page has its highlight layer").not.toBeNull();
		expect(layer!.canvas.width).toBeGreaterThan(0);
		return { r, layer: layer! };
	}
	const gone = (r: Rig, layer: { group: El; canvas: El }) => {
		expect(layer.group.parentElement, "the group is still on the page").toBeNull();
		expect([layer.canvas.width, layer.canvas.height], "the highlight canvas kept its backing store").toEqual([0, 0]);
		expect(layerOf(r.page)).toBeNull();
	};

	it("the viewer lets go of the page (sync's evict)", () => {
		const { r, layer } = withLayer();
		r.rendered(false);
		r.sync();
		expect(r.priv.overlays.has(1)).toBe(false);
		gone(r, layer);
	});

	it("the page's ink is all gone (paint's empty-page branch)", () => {
		const { r, layer } = withLayer();
		r.setStrokes([]);
		r.sync();
		expect(r.priv.overlays.has(1)).toBe(false);
		gone(r, layer);
	});

	it("the pane has no area (paint's off-band branch)", () => {
		const { r, layer } = withLayer();
		const priv = r.priv as unknown as { band: { width: number; height: number; left: number; top: number } | null };
		priv.band = { left: 0, top: 0, width: 0, height: 0 };
		(r.priv as unknown as { paint(p: unknown, b: unknown, s: number, z: boolean): void }).paint(r.page, r.box(), 1, false);
		expect(r.priv.overlays.has(1)).toBe(false);
		gone(r, layer);
	});

	it("unmount or a viewer rebuild (dropOverlays)", () => {
		const { r, layer } = withLayer();
		r.priv.dropOverlays();
		gone(r, layer);
	});

	it("the viewer took the saved pen canvas off the page (paint's rebuild): the old layer goes, a new one sits below the new canvas", () => {
		const { r, layer } = withLayer();
		penCanvasOf(r).remove();
		r.sync();
		expect(layer.group.parentElement, "the old group is still on the page").toBeNull();
		expect([layer.canvas.width, layer.canvas.height], "the old highlight canvas kept its backing store").toEqual([0, 0]);
		const fresh = layerOf(r.page);
		expect(fresh, "the rebuilt page has no highlight layer").not.toBeNull();
		expect(r.page.children.indexOf(fresh!.group)).toBeLessThan(r.page.children.indexOf(penCanvasOf(r)));
	});
});

describe("U4: with the pair in the group, attachPair on the same page and band neither moves nor clears it", () => {
	it("a re-attach mid-highlighter keeps the pair where it is and its pixels", () => {
		const r = rig([penAt("a", 300, 200), highlightAt("h", 300, 200)]);
		r.sync();
		strokeDown(r, "highlighter");
		const layer = layerOf(r.page);
		expect(layer, "precondition: the page has its highlight layer").not.toBeNull();
		const pair = r.priv.pair!;
		expect(pair.wetCanvas.parentElement, "precondition: the live highlighter is inside the group").toBe(layer!.group);
		const clears = pair.wetCanvas.ctx!.clears;
		records = [];
		r.priv.attachPair(r.page, r.box());
		expect(pair.wetCanvas.parentElement).toBe(layer!.group);
		expect(layer!.group.lastElementChild).toBe(pair.headCanvas);
		expect(pair.wetCanvas.ctx!.clears, "the re-attach cleared the live stroke").toBe(clears);
		expect(records, "the re-attach moved a node").toEqual([]);
		r.priv.penUp();
	});
});

describe("U5: after a highlighter lift the pair is back over the saved pen ink at full strength", () => {
	it("the pair is the page's last two children at opacity 1, and a lasso outline drawn then is not washed", () => {
		const r = rig([penAt("a", 300, 200), highlightAt("h", 300, 200)]);
		r.sync();
		strokeDown(r, "highlighter");
		const layer = layerOf(r.page);
		const pair = r.priv.pair!;
		expect(pair.wetCanvas.parentElement, "precondition: the live highlighter is inside the group").toBe(layer?.group);
		// Inside the group the pair itself is opaque: the group carries the wash once.
		expect(pair.wetCanvas.css.opacity).toBe("1");
		expect(pair.headCanvas.css.opacity).toBe("1");
		r.priv.penUp();
		const kids = r.page.children;
		expect(kids.slice(-2), "the pair is not the page's last two children").toEqual([pair.wetCanvas, pair.headCanvas]);
		expect(pair.wetCanvas.css.opacity).toBe("1");
		expect(pair.headCanvas.css.opacity).toBe("1");
		expect(kids.indexOf(layerOf(r.page)!.group)).toBeLessThan(kids.indexOf(penCanvasOf(r)));
		// A lasso outline now draws on the wet canvas, and nothing over it washes it.
		r.priv.drawLasso(r.box());
		expect(washedBetween(pair.wetCanvas, r.page), "the lasso outline would show at a third of its strength").toBe(false);
	});
});

describe("U6: a turned page paints the highlight canvas through the same turn matrix", () => {
	/** Where the upright page point (x, y) shows on the page turned clockwise by `deg`. */
	function turned(deg: 0 | 90 | 180 | 270, x: number, y: number): [number, number] {
		switch (deg) {
			case 0:
				return [x, y];
			case 90:
				return [PAGE_H - y, x];
			case 180:
				return [PAGE_W - x, PAGE_H - y];
			case 270:
				return [y, PAGE_W - x];
		}
	}
	function centre(ctx: Ctx): [number, number] {
		if (!ctx.base || ctx.device.length === 0) throw new Error("the newest paint drew no ink");
		const inv = invert(ctx.base);
		const css = ctx.device.map(([x, y]) => apply(inv, x, y));
		const xs = css.map((q) => q[0]);
		const ys = css.map((q) => q[1]);
		return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
	}
	const near = (got: [number, number], want: [number, number], what: string) => {
		expect(Math.abs(got[0] - want[0]), `${what} x ${got[0].toFixed(1)} want ${want[0].toFixed(1)}`).toBeLessThanOrEqual(1);
		expect(Math.abs(got[1] - want[1]), `${what} y ${got[1].toFixed(1)} want ${want[1].toFixed(1)}`).toBeLessThanOrEqual(1);
	};
	for (const deg of [90, 180, 270] as const) {
		it(`turned ${deg}: the highlight lands where the upright one did, turned with the page, as the pen ink does`, () => {
			const r = rig([penAt("a", 100, 200), highlightAt("h", 400, 600)]);
			r.sync();
			const layer0 = layerOf(r.page);
			expect(layer0, "no highlight layer on the upright page").not.toBeNull();
			// Where each mark's ink sits upright, measured, not assumed: the
			// highlighter's chisel ends are not symmetric about its samples.
			const hl0 = centre(layer0!.canvas.ctx!);
			const pen0 = centre(penCanvasOf(r).ctx!);
			r.turn(deg);
			const layer = layerOf(r.page);
			expect(layer, "no highlight layer on the turned page").not.toBeNull();
			near(centre(layer!.canvas.ctx!), turned(deg, hl0[0], hl0[1]), "highlight");
			near(centre(penCanvasOf(r).ctx!), turned(deg, pen0[0], pen0[1]), "pen");
			// And the upright highlight is where it was drawn, within its chisel ends.
			expect(Math.abs(hl0[0] - 400)).toBeLessThanOrEqual(4);
			expect(Math.abs(hl0[1] - 600)).toBeLessThanOrEqual(4);
		});
	}
});

describe("control: where the reader declares dark pages, the plain wash stays", () => {
	it("no layer; the saved highlight is filled at 0.35 on the pen canvas and the live one is dressed at 0.35 on the page", () => {
		const r = rig([penAt("a", 300, 200), highlightAt("h", 300, 200)], "lighten");
		r.sync();
		expect(layerOf(r.page)).toBeNull();
		const fills = penCanvasOf(r).ctx!.paints.filter((p) => p.op === "fill");
		expect(fills.some((p) => p.alpha === 0.35)).toBe(true);
		expect(fills.some((p) => p.alpha === 1)).toBe(true);
		strokeDown(r, "highlighter");
		const pair = r.priv.pair!;
		expect(pair.wetCanvas.parentElement).toBe(r.page);
		expect(pair.wetCanvas.css.opacity).toBe("0.35");
		expect(pair.headCanvas.css.opacity).toBe("0.35");
		r.priv.penUp();
		expect(pair.wetCanvas.css.opacity).toBe("1");
		expect(layerOf(r.page)).toBeNull();
	});
});

describe("H1: changing \"Ink color on PDFs\" repaints an open PDF at once", () => {
	it("to \"Lighten for dark pages\": the group goes and the pen canvas holds the plain wash; back: the group returns", () => {
		const settings = { inkPdfColorMode: "darken" as PdfPageAssumption };
		const r = rig([penAt("a", 300, 200), highlightAt("h", 300, 200)], () => settings.inkPdfColorMode);
		r.sync();
		r.frames();
		expect(layerOf(r.page), "precondition: a highlighted page has its group").not.toBeNull();
		// The settings tab over the one open PDF, as the plugin holds it.
		const tab = Object.create(HandwritingSettingTab.prototype) as { plugin: unknown; setControlValue(key: string, value: unknown): void };
		tab.plugin = { settings, saveSettingsNow: () => {}, pdfInk: new Map([[r.scroller, r.priv]]) };
		const pen = penCanvasOf(r);
		pen.ctx!.paints = [];
		tab.setControlValue("inkPdfColorMode", "lighten");
		expect(settings.inkPdfColorMode).toBe("lighten");
		expect(r.frames(), "H1 the setting change asked the open PDF for no repaint").toBeGreaterThan(0);
		expect(layerOf(r.page), "H1 the group stayed after the change to the plain wash").toBeNull();
		const washed = pen.ctx!.paints.filter((p) => p.op === "fill");
		expect(washed.some((p) => p.alpha === HIGHLIGHTER_ALPHA), "H1 the pen canvas does not hold the highlight's plain wash").toBe(true);
		expect(washed.some((p) => p.alpha === 1), "H1 the pen ink was not painted again").toBe(true);
		pen.ctx!.paints = [];
		tab.setControlValue("inkPdfColorMode", "darken");
		expect(r.frames(), "H1 changing back asked for no repaint").toBeGreaterThan(0);
		const back = layerOf(r.page);
		expect(back, "H1 the group did not come back").not.toBeNull();
		expect(back!.canvas.ctx!.paints.some((p) => p.op === "fill" && p.alpha === 1), "H1 the highlight is not painted in the group").toBe(true);
		expect(pen.ctx!.paints.filter((p) => p.op === "fill").every((p) => p.alpha === 1), "H1 the plain wash stayed on the pen canvas").toBe(true);
	});
});

describe("H2, H3: a highlight canvas with no 2d context leaves today's plain wash", () => {
	it("H2 the page: the pen canvas takes the highlight at the wash", () => {
		contextless = (el) => el.classes.has(HIGHLIGHT_CANVAS_CLASS);
		const r = rig([penAt("a", 300, 200), highlightAt("h", 300, 200)]);
		r.sync();
		const fills = penCanvasOf(r).ctx!.paints.filter((p) => p.op === "fill");
		expect(fills.some((p) => p.alpha === HIGHLIGHTER_ALPHA), "H2 the highlight was dropped: the pen canvas has no fill at the wash").toBe(true);
		expect(fills.some((p) => p.alpha === 1), "H2 the pen ink was not painted").toBe(true);
	});

	it("H3 the snip: the snip's canvas takes the highlight at the wash", async () => {
		const r = rig([penAt("a", 300, 200), highlightAt("h", 300, 200)]);
		r.sync();
		const made: El[] = [];
		vi.stubGlobal("createEl", (tag: string) => {
			const el = new El(tag);
			made.push(el);
			return el;
		});
		// The snip's own canvas has a context; the second one it makes, for the highlights, has none.
		contextless = (el) => made.indexOf(el) === 1;
		r.priv.selectionPage = 1;
		r.priv.selected = ["a", "h"];
		const result = await r.priv.snipSelection();
		expect(result.ok, `the snip failed: ${result.reason ?? ""}`).toBe(true);
		expect(made.length, "precondition: the snip made a canvas for the highlights").toBe(2);
		const fills = made[0]!.ctx!.paints.filter((p) => p.op === "fill");
		expect(fills.some((p) => p.alpha === HIGHLIGHTER_ALPHA), "H3 the highlight was dropped: the snip has no fill at the wash").toBe(true);
		expect(fills.some((p) => p.alpha === 1), "H3 the pen ink was not painted").toBe(true);
	});
});

describe("H4: a sync while a highlighter is down keeps the live pair in the group", () => {
	it("on a page with pen ink only, the group stays through the sync and the pair stays in it, opaque", () => {
		const r = rig([penAt("a", 300, 200)]);
		r.sync();
		strokeDown(r, "highlighter");
		const before = layerOf(r.page);
		expect(before, "precondition: the group appears at pen-down").not.toBeNull();
		expect(r.priv.pair!.wetCanvas.parentElement, "precondition: the pair is in the group").toBe(before!.group);
		r.sync();
		const layer = layerOf(r.page);
		expect(layer, "H4 a sync mid-stroke dropped the live group").not.toBeNull();
		expect(r.priv.pair!.wetCanvas.parentElement, "H4 a sync mid-stroke took the live pair out of the group").toBe(layer!.group);
		expect(r.priv.pair!.wetCanvas.css.opacity, "H4 live pair not opaque inside the group").toBe("1");
		r.priv.penUp();
	});
});
