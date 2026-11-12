/**
 * PDF highlights on pages the PDF file itself draws dark.
 *
 * No class marks such a page, so the plugin reads the viewer's whole-page
 * canvas: once per canvas element, at sync, only when the page has finished
 * drawing, only for pages that hold a highlight (or every live page while the
 * highlighter is the tool), and never while the app's own dark-page classes
 * decide. A dark page keeps the plain wash on the pen canvas, as a page the app
 * made dark does; a light page keeps the highlight layer.
 *
 * Driven through the controller's own sync, paint, pen, snip and root observer
 * callbacks over a small element fake that keeps a child list and writes the
 * records a browser would. The viewer probe's page list is injected and the
 * pixel read is stubbed to the shade each fake canvas is given: the cells here
 * prove which canvas is read, when, and what the answer does. What a real
 * canvas reads as is PdfPageShadeBrowser.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { computeBBox, InkStroke } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest } from "../inline/TipMode";
import { setInlineTool } from "../inline/InkOverlay";
import type { PdfPageAssumption } from "../ink/InkPdf";

const probe = vi.hoisted(() => ({ current: null as unknown, reads: [] as unknown[] }));
vi.mock("./PdfViewerProbe", async (importOriginal) => {
	const real = await importOriginal<typeof import("./PdfViewerProbe")>();
	return {
		...real,
		probeViewer: () => probe.current,
		// The pixel read, stubbed to the shade the fake canvas carries; every call logged.
		readCanvasDark: (canvas: { shade?: string }) => {
			probe.reads.push(canvas);
			return canvas.shade === "unreadable" ? null : canvas.shade === "dark";
		},
	};
});
vi.mock("../inline/MobileTools", () => ({
	MobileTools: class {
		setCorner() {}
		refresh() {}
		setInking() {}
		closeInkSliders() {}
		stale() {
			return false;
		}
		destroy() {}
	},
}));

import { PdfInkController } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";
import { OVERLAY_CLASS, setViewTurnSource } from "./PdfInkBand";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";

const PAGE_W = 600;
const PAGE_H = 800;
const GAP = 10;

// ---- records, delivered as a browser delivers them ----

interface Rec {
	type: "childList" | "attributes";
	target: El;
	attributeName: string | null;
	addedNodes: El[];
	removedNodes: El[];
}
interface Watch {
	mo: FakeObserver;
	target: El;
	opts: MutationObserverInit;
}
let watches: Watch[] = [];

/** The browser's MutationObserver as far as the root observer uses it: options honoured, one batch per microtask. */
class FakeObserver {
	private pending: Rec[] | null = null;
	constructor(private readonly cb: (records: MutationRecord[]) => void) {}
	observe(target: El, opts: MutationObserverInit): void {
		watches.push({ mo: this, target, opts });
	}
	disconnect(): void {
		watches = watches.filter((w) => w.mo !== this);
	}
	takeRecords(): MutationRecord[] {
		return [];
	}
	deliver(rec: Rec): void {
		if (!this.pending) {
			this.pending = [];
			queueMicrotask(() => {
				const batch = this.pending ?? [];
				this.pending = null;
				this.cb(batch as unknown as MutationRecord[]);
			});
		}
		this.pending.push(rec);
	}
}
class NoopResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

function within(el: El, top: El): boolean {
	for (let at: El | null = el; at; at = at.parentElement) if (at === top) return true;
	return false;
}
function emit(rec: Rec): void {
	for (const w of watches) {
		const here = rec.target === w.target || (w.opts.subtree === true && within(rec.target, w.target));
		if (!here) continue;
		if (rec.type === "childList" && !w.opts.childList) continue;
		if (rec.type === "attributes") {
			if (!w.opts.attributes) continue;
			if (w.opts.attributeFilter && !w.opts.attributeFilter.includes(rec.attributeName ?? "")) continue;
		}
		w.mo.deliver(rec);
	}
}
/** Let every queued microtask run, as the browser does between two tasks. */
async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

// ---- one canvas's 2d context, logged ----

/** One fill or stroke a canvas took, with the state it was taken in. */
interface Paint {
	op: string;
	alpha: number;
	composite: string;
}

class Ctx {
	paints: Paint[] = [];
	log: string[] = [];
	private m: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
	private stack: Array<[number, number, number, number, number, number]> = [];
	private states: Array<Record<string, unknown>> = [];
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
		const paint = (op: string) => {
			self.paints.push({ op, alpha: Number(self.state.globalAlpha), composite: String(self.state.globalCompositeOperation) });
		};
		const fns: Record<string, (...a: number[]) => unknown> = {
			setTransform: (...a: number[]) => {
				self.m = (typeof a[0] === "object" ? [1, 0, 0, 1, 0, 0] : a.slice(0, 6)) as typeof self.m;
			},
			save: () => {
				self.stack.push(self.m);
				self.states.push({ ...self.state });
			},
			restore: () => {
				self.m = self.stack.pop() ?? self.m;
				const kept = self.states.pop();
				if (kept) Object.assign(self.state, kept);
			},
			getTransform: () => ({ a: self.m[0], b: self.m[1], c: self.m[2], d: self.m[3], e: self.m[4], f: self.m[5] }),
			fill: () => paint("fill"),
			stroke: () => paint("stroke"),
			drawImage: () => paint("drawImage"),
			getImageData: () => {
				paint("getImageData");
				throw new Error("a canvas of this rig was read back");
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
					self.log.push(`${key}(${args.map((x) => (typeof x === "number" ? x.toFixed(3) : typeof x)).join(",")})`);
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

// ---- an element fake with a real child list and the records a browser writes ----

interface Doc {
	body: El;
}

class El {
	readonly classes = new Set<string>();
	children: El[] = [];
	parentElement: El | null = null;
	ownerDocument: Doc | undefined;
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
	hidden = false;
	offsetParent: El | null = null;
	offsetLeft = 0;
	offsetTop = 0;
	ctx: Ctx | null = null;
	/** A canvas with no 2d context to give, as a browser at its canvas memory cap. */
	noContext = false;
	/** For a viewer canvas: what its pixels are, as the stubbed read reports them. */
	shade: "dark" | "light" | "unreadable" = "light";
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
	private setClass(c: string, on: boolean): void {
		if (this.classes.has(c) === on) return;
		if (on) this.classes.add(c);
		else this.classes.delete(c);
		emit({ type: "attributes", target: this, attributeName: "class", addedNodes: [], removedNodes: [] });
	}
	get classList() {
		return {
			contains: (c: string) => this.classes.has(c),
			add: (...c: string[]) => c.forEach((x) => this.setClass(x, true)),
			remove: (...c: string[]) => c.forEach((x) => this.setClass(x, false)),
			toggle: (c: string, on?: boolean) => this.setClass(c, on ?? !this.classes.has(c)),
		};
	}
	get className(): string {
		return [...this.classes].join(" ");
	}
	instanceOf(): boolean {
		return true;
	}
	/** Class selectors only (".a" or ".a, .b"), which is all the controller asks. */
	closest(selector: string): El | null {
		const want = selector.split(",").map((s) => s.trim());
		if (!want.every((s) => /^\.[\w-]+$/.test(s))) throw new Error(`the fake's closest takes class selectors, got ${selector}`);
		for (let at: El | null = this; at; at = at.parentElement) {
			if (want.some((s) => at!.classes.has(s.slice(1)))) return at;
		}
		return null;
	}
	private detach(): void {
		const p = this.parentElement;
		if (!p) return;
		p.children.splice(p.children.indexOf(this), 1);
		this.parentElement = null;
		emit({ type: "childList", target: p, attributeName: null, addedNodes: [], removedNodes: [this] });
	}
	insertBefore(n: El, ref: El | null): El {
		n.detach();
		const i = ref ? this.children.indexOf(ref) : -1;
		if (i < 0) this.children.push(n);
		else this.children.splice(i, 0, n);
		n.parentElement = this;
		emit({ type: "childList", target: this, attributeName: null, addedNodes: [n], removedNodes: [] });
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
	hasAttribute(k: string): boolean {
		return k in this.attrs;
	}
	setCssProps(p: Record<string, string>): void {
		Object.assign(this.css, p);
	}
	setCssStyles(p: Record<string, string>): void {
		Object.assign(this.css, p);
	}
	toggleClass(c: string, on: boolean): void {
		this.setClass(c, on);
	}
	getContext(): CanvasRenderingContext2D | null {
		if (this.noContext) return null;
		this.ctx ??= new Ctx(this);
		return this.ctx.proxy;
	}
	toBlob(done: (blob: Blob | null) => void): void {
		done(new Blob(["png"]));
	}
	/** The scroller's page lookup by number, the one selector the controller hands it. */
	querySelector(sel: string): El | null {
		const n = /data-page-number="(\d+)"/.exec(sel)?.[1];
		return n === undefined ? null : (this.all().find((c) => c.attrs["data-page-number"] === n) ?? null);
	}
	/** `canvas:not(.handwriting-pdf-ink)`, as the viewer probe asks it: every canvas under here that is not ours. */
	querySelectorAll(sel: string): El[] {
		if (sel !== `canvas:not(.${OVERLAY_CLASS})`) return [];
		return this.all().filter((c) => c.tag === "canvas" && !c.classes.has(OVERLAY_CLASS));
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

function stroke(id: string, tool: "pen" | "highlighter", cx: number, cy: number, color: string, page = 1): InkStroke {
	const points = [-20, 0, 20].map((d, i) => ({ x: cx + d, y: cy, pressure: 0.5, t: i * 8 }));
	return { id, tool, color, width: tool === "highlighter" ? 12 : 2, points, bbox: computeBBox(points, tool === "highlighter" ? 12 : 4), createdAt: 0, page };
}
const penAt = (id: string, cx: number, cy: number, page = 1) => stroke(id, "pen", cx, cy, "#000000", page);
const highlightAt = (id: string, cx: number, cy: number, page = 1) => stroke(id, "highlighter", cx, cy, "#ffd60a", page);
const saved = () => [penAt("a", 300, 200), highlightAt("h", 300, 200)];

function sample(x: number, y: number, t: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: t, tiltX: 0, tiltY: 0 };
}

// ---- the rig ----

interface Priv {
	mounted: boolean;
	boundScroller: unknown;
	pair: { wetCanvas: El; headCanvas: El } | null;
	overlays: Map<number, { canvas: El }>;
	sync(): void;
	invalidateProbe(): void;
	penDown(s: PenSample, ev?: PointerEvent): void;
	penRaw(s: PenSample[]): void;
	penUp(): void;
	frame: unknown;
	selectionPage: number;
	selected: string[];
	snipSelection(): Promise<{ ok: boolean; reason?: string }>;
	mount(): void;
	unmount(): void;
}

interface Look {
	/** Obsidian's mark on the viewer's container: "Adapt to theme" is on. */
	themed: boolean;
	/** The body class of the window the PDF is in. */
	dark: boolean;
	assumption?: PdfPageAssumption;
}

interface Rig {
	priv: Priv;
	look: Look;
	container: El;
	scroller: El;
	/** Page 1's div. */
	page: El;
	pageEl(n: number): El;
	/** The viewer's whole-page canvas on page n, as it is now. */
	viewer(n?: number): El;
	/** The viewer draws page n again: its canvas replaced by a new element with these pixels. */
	rerender(n: number, shade: El["shade"]): El;
	strokes(): InkStroke[];
	setStrokes(ink: InkStroke[]): void;
	sync(): void;
	/** Run every timer and animation frame the controller asked for, until none is left; how many ran. */
	drain(): number;
}

const cleanups: Array<() => void> = [];

/** A canvas of the viewer's own, spanning its page div, as pdf.js places one. */
function viewerCanvas(page: El, shade: El["shade"]): El {
	const c = new El("canvas");
	c.shade = shade;
	c.offsetParent = page;
	c.clientWidth = PAGE_W;
	c.clientHeight = PAGE_H;
	c.width = PAGE_W * 2;
	c.height = PAGE_H * 2;
	return c;
}

function rig(look: Look, ink: InkStroke[] = saved(), opts: { pages?: number; shade?: El["shade"]; loading?: boolean } = {}): Rig {
	resetTipModeForTest();
	const queued: Array<() => void> = [];
	let strokes = ink;
	const count = opts.pages ?? 1;
	const root = new El("div", "workspace-leaf-content");
	const container = root.createDiv({ cls: look.themed ? "pdf-container mod-themed" : "pdf-container" });
	const scroller = container.createDiv({ cls: "pdf-viewer-container" });
	const pages: El[] = [];
	for (let n = 1; n <= count; n++) {
		const page = scroller.createDiv({ cls: opts.loading ? "page loadingIcon" : "page" });
		page.attrs["data-page-number"] = String(n);
		page.appendChild(viewerCanvas(page, opts.shade ?? "light"));
		pages.push(page);
	}
	const body = new El("body", look.dark ? "theme-dark" : "theme-light");
	const doc: Doc = { body };
	container.ownerDocument = doc;
	vi.stubGlobal("document", doc);
	const size = () => {
		for (const page of pages) {
			page.clientWidth = PAGE_W;
			page.clientHeight = PAGE_H;
		}
		scroller.clientWidth = PAGE_W;
		scroller.clientHeight = PAGE_H;
		scroller.scrollWidth = PAGE_W;
		scroller.scrollHeight = count * PAGE_H + (count - 1) * GAP;
	};
	size();
	const boxes = () => pages.map((_, i) => ({ pageNumber: i + 1, leftPx: 0, topPx: i * (PAGE_H + GAP), widthPx: PAGE_W, heightPx: PAGE_H, hasCanvas: true }));
	probe.current = { scroller, scaleFactor: 1, scaleSource: "test", pages: boxes() };
	const win = {
		devicePixelRatio: 1,
		setTimeout: (cb: () => void) => {
			queued.push(cb);
			return queued.length;
		},
		clearTimeout: () => {},
		requestAnimationFrame: (cb: () => void) => {
			queued.push(cb);
			return queued.length;
		},
		cancelAnimationFrame: () => {},
		getComputedStyle: () => ({ position: "relative" }),
		navigator: { userAgent: "", platform: "", maxTouchPoints: 0 },
	};
	const controller = new PdfInkController(
		root as unknown as HTMLElement,
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
		() => look.assumption ?? "darken"
	);
	setViewTurnSource(controller, () => 0);
	const priv = controller as unknown as Priv;
	priv.mounted = true;
	priv.boundScroller = scroller;
	const pageEl = (n: number) => pages[n - 1]!;
	const viewer = (n = 1) => {
		const own = pageEl(n).children.filter((c) => c.tag === "canvas" && !c.classes.has(OVERLAY_CLASS));
		const c = own[own.length - 1];
		if (!c) throw new Error(`page ${n} has no viewer canvas`);
		return c;
	};
	return {
		priv,
		look,
		container,
		scroller,
		page: pages[0]!,
		pageEl,
		viewer,
		rerender: (n, shade) => {
			const page = pageEl(n);
			viewer(n).remove();
			return page.insertBefore(viewerCanvas(page, shade), page.children[0] ?? null);
		},
		strokes: () => strokes,
		setStrokes: (next) => {
			strokes = next;
		},
		sync: () => {
			size();
			priv.invalidateProbe();
			priv.sync();
		},
		drain: () => {
			let ran = 0;
			for (let cb = queued.shift(); cb; cb = queued.shift()) {
				if (++ran > 50) throw new Error("the controller keeps asking for timers or frames");
				cb();
			}
			return ran;
		},
	};
}

beforeEach(() => {
	watches = [];
	probe.reads = [];
	setInlineTool("pen");
	vi.stubGlobal("Element", El);
	vi.stubGlobal("MutationObserver", FakeObserver);
	vi.stubGlobal("ResizeObserver", NoopResizeObserver);
});
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
	setInlineTool("pen");
	probe.current = null;
	probe.reads = [];
	watches = [];
	vi.unstubAllGlobals();
});

/** How many times this canvas's pixels were read. */
const reads = (canvas: El) => probe.reads.filter((c) => c === canvas).length;

/** The page's highlight layer: a div of ours directly under the page, holding a canvas. */
function layerOf(page: El): { group: El; canvas: El } | null {
	const group = page.children.find((c) => c.tag === "div" && c.classes.has(OVERLAY_CLASS));
	const canvas = group?.children.find((c) => c.tag === "canvas" && c.classes.has(OVERLAY_CLASS));
	return group && canvas ? { group, canvas } : null;
}
/** The saved pen canvas: the page's own overlay. */
function penCanvasOf(r: Rig, n = 1): El {
	const a = r.priv.overlays.get(n);
	if (!a) throw new Error(`no saved-ink canvas on page ${n}`);
	return a.canvas;
}
const fillsOf = (el: El) => (el.ctx?.paints ?? []).filter((p) => p.op === "fill");
/** The plain wash on the pen canvas: no group, a fill at the highlighter's alpha, and the pen ink at full strength. */
function plainWash(r: Rig, what: string, n = 1): void {
	expect(layerOf(r.pageEl(n)), `${what}: a highlight group on the page`).toBeNull();
	const fills = fillsOf(penCanvasOf(r, n));
	expect(fills.some((p) => p.alpha === HIGHLIGHTER_ALPHA), `${what}: the pen canvas holds no highlight at the wash`).toBe(true);
	expect(fills.some((p) => p.alpha === 1), `${what}: the pen ink was not painted`).toBe(true);
}
/** The highlight layer: a group on the page, the highlight opaque inside it, nothing translucent on the pen canvas. */
function layered(r: Rig, what: string, n = 1): void {
	const layer = layerOf(r.pageEl(n));
	expect(layer, `${what}: no highlight group on the page`).not.toBeNull();
	expect(fillsOf(layer!.canvas).some((p) => p.alpha === 1), `${what}: the highlight is not painted in the group`).toBe(true);
	expect(fillsOf(penCanvasOf(r, n)).every((p) => p.alpha === 1), `${what}: a highlight is still at the wash on the pen canvas`).toBe(true);
}
/** A stroke on page 1, the highlighter's unless named: down, moved; the caller lifts it. */
function down(r: Rig, tool: "pen" | "highlighter" = "highlighter"): void {
	setInlineTool(tool);
	r.priv.penDown(sample(150, 400, 0), { pointerType: "pen" } as PointerEvent);
	r.priv.penRaw([sample(200, 400, 16), sample(250, 400, 32), sample(300, 400, 48)]);
}

describe("C1: a page still drawing is not read; the sync after its draw ends reads it", () => {
	it("light meanwhile and no read while loadingIcon is on the page div; the draw ends dark in the same element: no group, the wash", async () => {
		const r = rig({ themed: false, dark: false }, saved(), { loading: true });
		const canvas = r.viewer();
		r.priv.mount();
		cleanups.push(() => r.priv.unmount());
		r.drain();
		expect(reads(canvas), "C1 the page was read while it was still drawing").toBe(0);
		layered(r, "C1 light while the page draws");
		// The last pixels land in the same element; then the viewer takes the class off.
		canvas.shade = "dark";
		r.page.classList.remove("loadingIcon");
		await settle();
		expect(r.drain(), "C1 the end of the draw asked for no sync").toBeGreaterThan(0);
		expect(r.viewer(), "precondition: the same canvas element").toBe(canvas);
		expect(reads(canvas), "C1 the finished page was not read exactly once").toBe(1);
		plainWash(r, "C1");
	});
});

describe("C2: where the app made the pages dark, no pixel is read", () => {
	it("container themed, body dark, a finished light canvas: no group, no read", () => {
		const r = rig({ themed: true, dark: true }, saved(), { shade: "light" });
		r.sync();
		r.sync();
		expect(probe.reads.length, "C2 a canvas was read under the app's dark pages").toBe(0);
		plainWash(r, "C2");
	});
});

describe("C3: a gesture's page keeps its answer from pen-down to the lift", () => {
	it("pen-down on a page with no finished read; the page finishes dark; a sync before the lift reads nothing and moves nothing; the lift reads it: no group, the wash", () => {
		const r = rig({ themed: false, dark: false }, saved(), { loading: true });
		const canvas = r.viewer();
		r.sync();
		layered(r, "precondition");
		down(r);
		const pair = r.priv.pair!;
		const group = layerOf(r.page)?.group;
		expect(pair.wetCanvas.parentElement, "precondition: the live highlighter is in the group").toBe(group);
		const opacity = [pair.wetCanvas.css.opacity, pair.headCanvas.css.opacity];
		canvas.shade = "dark";
		r.page.classes.delete("loadingIcon");
		r.sync();
		expect(reads(canvas), "C3 the page was read before the lift").toBe(0);
		expect(pair.wetCanvas.parentElement, "C3 the live highlighter moved before the lift").toBe(group);
		expect([pair.wetCanvas.css.opacity, pair.headCanvas.css.opacity], "C3 the live highlighter's opacity changed before the lift").toEqual(opacity);
		expect(layerOf(r.page)?.group, "C3 the group went before the lift").toBe(group);
		r.priv.penUp();
		r.drain();
		expect(r.strokes().filter((s) => s.tool === "highlighter").length, "precondition: the highlight was committed").toBe(2);
		expect(reads(canvas), "C3 the lift did not read the page once").toBe(1);
		plainWash(r, "C3 after the lift");
		expect(pair.wetCanvas.parentElement, "C3 the pair is not back on the page after the lift").toBe(r.page);
	});

	it("the other way round: pen-down on a page read dark; the viewer draws it again light; a sync before the lift reads nothing and moves nothing; the lift reads it: the group", () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark" });
		r.sync();
		plainWash(r, "precondition");
		down(r);
		const pair = r.priv.pair!;
		expect(pair.wetCanvas.parentElement, "precondition: the live highlighter is on the page").toBe(r.page);
		const pen = penCanvasOf(r);
		expect(pair.wetCanvas.css.opacity, "precondition: the live highlighter is at the wash").toBe(String(HIGHLIGHTER_ALPHA));
		const fresh = r.rerender(1, "light");
		r.sync();
		expect(reads(fresh), "C3 the new canvas was read before the lift").toBe(0);
		expect(layerOf(r.page), "C3 a group appeared before the lift").toBeNull();
		expect(pair.wetCanvas.parentElement, "C3 the live highlighter moved before the lift").toBe(r.page);
		expect([pair.wetCanvas.css.opacity, pair.headCanvas.css.opacity], "C3 the live highlighter's opacity changed before the lift").toEqual([
			String(HIGHLIGHTER_ALPHA),
			String(HIGHLIGHTER_ALPHA),
		]);
		pen.ctx!.paints = [];
		r.priv.penUp();
		r.drain();
		expect(reads(fresh), "C3 the lift did not read the new canvas once").toBe(1);
		layered(r, "C3 after the lift");
	});
});

describe("C14: no pixel is read while a pen or finger is down; the lift's own sync reads the page", () => {
	/** The page was drawing at pen-down and finishes its draw, dark, before the lift; then a sync. */
	function finishMidStroke(r: Rig, canvas: El): void {
		expect(r.priv.frame, "precondition: no contact is open").not.toBeNull();
		canvas.shade = "dark";
		r.page.classes.delete("loadingIcon");
		r.sync();
	}
	it("pen: pen-down on a page that holds a highlight; the page finishes its draw; a sync before the lift reads nothing", () => {
		const r = rig({ themed: false, dark: false }, saved(), { loading: true });
		const canvas = r.viewer();
		r.sync();
		expect(reads(canvas), "precondition: the page was read while still drawing").toBe(0);
		down(r, "pen");
		finishMidStroke(r, canvas);
		expect(reads(canvas), "C14 the page was read while the pen was down").toBe(0);
	});
	it("highlighter: pen-down on a page with pen ink only; the page finishes its draw; a sync before the lift reads nothing", () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { loading: true });
		const canvas = r.viewer();
		setInlineTool("highlighter");
		r.sync();
		expect(reads(canvas), "precondition: the page was read while still drawing").toBe(0);
		down(r);
		finishMidStroke(r, canvas);
		expect(reads(canvas), "C14 the page was read while the highlighter was down").toBe(0);
	});
	it("guard: after the real lift and no other event, the page is read once and its answer shows: no group, the wash", () => {
		const r = rig({ themed: false, dark: false }, saved(), { loading: true });
		const canvas = r.viewer();
		r.sync();
		down(r);
		finishMidStroke(r, canvas);
		r.priv.penUp();
		expect(reads(canvas), "C14 the lift's own sync did not read the page once").toBe(1);
		r.drain();
		expect(reads(canvas), "C14 the page was read more than once").toBe(1);
		plainWash(r, "C14 after the lift");
	});
});

describe("C4: the snip never reads pixels; it takes the answer the page has", () => {
	async function snip(r: Rig): Promise<El[]> {
		const made: El[] = [];
		vi.stubGlobal("createEl", (tag: string) => {
			const el = new El(tag);
			made.push(el);
			return el;
		});
		r.priv.selectionPage = 1;
		r.priv.selected = ["a", "h"];
		const result = await r.priv.snipSelection();
		expect(result.ok, `the snip failed: ${result.reason ?? ""}`).toBe(true);
		return made;
	}
	const multiplied = (made: El[]) => made.some((c) => (c.ctx?.paints ?? []).some((p) => p.composite === "multiply"));
	const readBack = (made: El[]) => made.some((c) => (c.ctx?.paints ?? []).some((p) => p.op === "getImageData"));

	it("a page read dark: no multiply composite, the plain wash, and no read during the snip", async () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark" });
		r.sync();
		expect(reads(r.viewer()), "precondition: the page was read at the sync").toBe(1);
		const made = await snip(r);
		expect(probe.reads.length, "C4 the snip read the page").toBe(1);
		expect(readBack(made), "C4 the snip read a canvas back").toBe(false);
		expect(made.length, "C4 the snip made a canvas for a highlight layer").toBe(1);
		expect(multiplied(made), "C4 the snip multiplied a highlight onto a dark page").toBe(false);
		expect(fillsOf(made[0]!).some((p) => p.alpha === HIGHLIGHTER_ALPHA), "C4 the snip has no highlight at the wash").toBe(true);
	});

	it("a page with no answer kept (still drawing): the snip reads nothing and paints the layer as today", async () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark", loading: true });
		r.sync();
		const made = await snip(r);
		expect(probe.reads.length, "C4 the snip read the page").toBe(0);
		expect(readBack(made), "C4 the snip read a canvas back").toBe(false);
		expect(multiplied(made), "C4 the snip of a page with no answer lost its layer").toBe(true);
	});
});

describe("C5: the canvas read is the whole page's", () => {
	it("a whole canvas that is light, then a later canvas that is dark and covers a quarter of the page: light", () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "light" });
		const whole = r.viewer();
		const part = viewerCanvas(r.page, "dark");
		part.clientWidth = PAGE_W / 2;
		part.clientHeight = PAGE_H / 2;
		part.offsetLeft = PAGE_W / 4;
		part.offsetTop = PAGE_H / 4;
		r.page.insertBefore(part, whole.nextElementSibling);
		r.sync();
		expect(reads(part), "C5 the part canvas was read").toBe(0);
		expect(reads(whole), "C5 the whole canvas was not read").toBe(1);
		layered(r, "C5");
	});
});

describe("C6: pen-down reads nothing", () => {
	it("highlighter selected, a finished dark page with pen ink only: the answer is there after the sync; pen-down reads nothing; the pair is at the wash from the first sample; nothing changes at the lift", () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		setInlineTool("highlighter");
		r.sync();
		expect(reads(r.viewer()), "C6 the page's answer is not there after the sync").toBe(1);
		down(r);
		expect(probe.reads.length, "C6 pen-down read the page").toBe(1);
		const pair = r.priv.pair!;
		expect(pair.wetCanvas.parentElement, "C6 the live highlighter went into a group").toBe(r.page);
		expect(layerOf(r.page), "C6 a group appeared at pen-down").toBeNull();
		expect(pair.wetCanvas.css.opacity, "C6 the live highlighter is not at the wash").toBe(String(HIGHLIGHTER_ALPHA));
		expect(pair.headCanvas.css.opacity, "C6 the live head is not at the wash").toBe(String(HIGHLIGHTER_ALPHA));
		r.priv.penUp();
		r.drain();
		expect(probe.reads.length, "C6 the lift read the page again").toBe(1);
		plainWash(r, "C6 after the lift");
	});
});

describe("C8: a read costs once per canvas element, and only where an answer is needed", () => {
	it("pen selected, pages with pen ink only: no read over ten syncs", () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200, 1), penAt("b", 300, 200, 2)], { pages: 2, shade: "dark" });
		for (let i = 0; i < 10; i++) r.sync();
		expect(probe.reads.length, "C8 a page with no highlight was read").toBe(0);
	});
	it("a page with a highlight: one read per canvas element over ten syncs, and one for each new element", () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark" });
		const first = r.viewer();
		for (let i = 0; i < 10; i++) r.sync();
		expect(reads(first), "C8 one canvas element was not read exactly once").toBe(1);
		plainWash(r, "C8");
		const second = r.rerender(1, "dark");
		for (let i = 0; i < 10; i++) r.sync();
		expect(reads(second), "C8 the new canvas element was not read exactly once").toBe(1);
		expect(probe.reads.length, "C8 reads beyond one per element").toBe(2);
	});
	it("a read that cannot be done: one try, light, never tried again", () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "unreadable" });
		for (let i = 0; i < 10; i++) r.sync();
		expect(reads(r.viewer()), "C8 an unreadable canvas was not tried exactly once").toBe(1);
		layered(r, "C8 unreadable is light");
	});
});

describe("C9: the layer dropped by a paint that stops short is painted at the next one", () => {
	it("the setting changes to Lighten for dark pages while the pen canvas has no 2d context; the next paint has one: the wash", () => {
		const r = rig({ themed: false, dark: false }, saved());
		r.sync();
		layered(r, "precondition");
		const pen = penCanvasOf(r);
		r.look.assumption = "lighten";
		pen.noContext = true;
		r.sync();
		expect(layerOf(r.page), "precondition: the layer was dropped").toBeNull();
		pen.noContext = false;
		pen.ctx!.paints = [];
		r.sync();
		plainWash(r, "C9 setting");
	});
	it("the viewer draws the page again dark while the pen canvas has no 2d context; the next paint has one: the wash", () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "light" });
		r.sync();
		layered(r, "precondition");
		const pen = penCanvasOf(r);
		r.rerender(1, "dark");
		pen.noContext = true;
		r.sync();
		expect(layerOf(r.page), "precondition: the layer was dropped").toBeNull();
		pen.noContext = false;
		pen.ctx!.paints = [];
		r.sync();
		plainWash(r, "C9 dark page");
	});
});

describe("C11: another file's canvas starts with no answer", () => {
	it("page 1 of one file read dark; the pane opens another file whose page 1 is still drawing: light, its highlight in the group", () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark" });
		r.sync();
		plainWash(r, "precondition");
		// The other file: the viewer's page 1 is a new div with a new canvas, still drawing.
		const old = r.page;
		const page = new El("div", "page loadingIcon");
		page.attrs["data-page-number"] = "1";
		page.clientWidth = PAGE_W;
		page.clientHeight = PAGE_H;
		page.appendChild(viewerCanvas(page, "dark"));
		r.scroller.insertBefore(page, old);
		old.remove();
		r.setStrokes([penAt("b-a", 200, 300), highlightAt("b-h", 200, 300)]);
		r.priv.invalidateProbe();
		r.priv.sync();
		expect(probe.reads.length, "C11 the other file's page was read while drawing").toBe(1);
		const layer = layerOf(page);
		expect(layer, "C11 the other file's page 1 took the old file's answer").not.toBeNull();
	});
});

describe("C13: a canvas first seen while the app made the pages dark is never read", () => {
	it("a capped page, themed and dark, its canvas dark; Adapt to theme goes off; the same element, pixels still dark: the group is back, no read", () => {
		const r = rig({ themed: true, dark: true }, saved(), { shade: "dark" });
		const canvas = r.viewer();
		r.sync();
		plainWash(r, "precondition");
		penCanvasOf(r).ctx!.paints = [];
		r.container.classList.remove("mod-themed");
		r.sync();
		expect(r.viewer(), "precondition: the same canvas element").toBe(canvas);
		expect(reads(canvas), "C13 the canvas first seen under the app's dark pages was read").toBe(0);
		layered(r, "C13");
	});
	it("guard: a new canvas landing after Adapt to theme went off is read", () => {
		const r = rig({ themed: true, dark: true }, saved(), { shade: "dark" });
		r.sync();
		penCanvasOf(r).ctx!.paints = [];
		r.container.classList.remove("mod-themed");
		r.sync();
		layered(r, "precondition");
		const fresh = r.rerender(1, "dark");
		r.sync();
		expect(reads(fresh), "C13 the new canvas was not read").toBe(1);
		plainWash(r, "C13 guard");
	});
});

describe("the read itself never throws", () => {
	it("no size, no createEl to make the sample, a createEl that throws, no context, a draw that throws: null each time", async () => {
		const { readCanvasDark } = await vi.importActual<typeof import("./PdfViewerProbe")>("./PdfViewerProbe");
		// The sample canvas comes from Obsidian's global createEl, shimmed here per case.
		const make = (create: unknown) => vi.stubGlobal("createEl", create);
		const canvas = (w: number, h: number) => ({ width: w, height: h }) as unknown as HTMLCanvasElement;
		make(() => null);
		expect(readCanvasDark(canvas(0, 10))).toBeNull();
		make(undefined);
		expect(readCanvasDark(canvas(10, 10))).toBeNull();
		make(() => {
			throw new Error("no canvas here");
		});
		expect(readCanvasDark(canvas(10, 10))).toBeNull();
		make(() => ({ width: 0, height: 0, getContext: () => null }));
		expect(readCanvasDark(canvas(10, 10))).toBeNull();
		make(() => ({
			width: 0,
			height: 0,
			getContext: () => ({
				fillRect: () => {},
				drawImage: () => {
					throw new Error("the draw failed");
				},
			}),
		}));
		expect(readCanvasDark(canvas(10, 10))).toBeNull();
	});
});

/**
 * C15 counts calls, not pixels. In the app the page canvas can be a GPU
 * canvas, and a draw from it costs about the whole canvas, not the patch it
 * names: 256 patch draws from a 2051 x 2660 page canvas held the page for
 * about 1.6 s on one machine, while a test machine reads 16 million pixels in a
 * few ms. So the bound is the number of calls that take pixels out of the page
 * canvas, which does not depend on the machine: one drawImage, at any size, and
 * no other way in (its own context, a bitmap, a data URL, a blob).
 */
describe("C15: a read takes the page canvas's pixels in one draw at any canvas size, and by no other road", () => {
	type Read = { dark: boolean | null; pageDraws: number; pageOther: string[] };
	/**
	 * One read of a w x h page canvas whose pixels are all `grey` (0 to 255).
	 * The sample canvas comes from Obsidian's global createEl: a fake 2d context
	 * that answers every method, counts each drawImage whose source is the page
	 * canvas, names every other call that names the page canvas or runs on it,
	 * and reads back pixels of that grey.
	 */
	const readOnce = async (w: number, h: number, grey: number): Promise<Read> => {
		const { readCanvasDark } = await vi.importActual<typeof import("./PdfViewerProbe")>("./PdfViewerProbe");
		const out: Read = { dark: null, pageDraws: 0, pageOther: [] };
		const page: Record<string, unknown> = { width: w, height: h };
		for (const name of ["getContext", "toDataURL", "toBlob", "transferControlToOffscreen", "captureStream"]) {
			page[name] = () => {
				out.pageOther.push(`page.${name}`);
				return null;
			};
		}
		vi.stubGlobal("createImageBitmap", (src: unknown) => {
			if (src === page) out.pageOther.push("createImageBitmap");
			return Promise.reject(new Error("no bitmaps in this cell"));
		});
		vi.stubGlobal("createEl", () => {
			const fields: Record<string | symbol, unknown> = {};
			const ctx = new Proxy(fields, {
				get(t, key) {
					if (key in t) return t[key];
					if (typeof key === "symbol" || key === "then") return undefined;
					return (...a: unknown[]) => {
						if (key === "drawImage" && a[0] === page) out.pageDraws++;
						else if (a.includes(page)) out.pageOther.push(`ctx.${key}`);
						if (key !== "getImageData") return undefined;
						const gw = Number(a[2]);
						const gh = Number(a[3]);
						const data = new Uint8ClampedArray(gw * gh * 4).fill(grey);
						for (let i = 3; i < data.length; i += 4) data[i] = 255;
						return { data, width: gw, height: gh };
					};
				},
				set(t, key, v) {
					t[key] = v;
					return true;
				},
			});
			return { width: 0, height: 0, getContext: () => ctx };
		});
		out.dark = readCanvasDark(page as unknown as HTMLCanvasElement);
		return out;
	};
	/** A small page, a page at 140 percent and one at 200 percent on a 1.8 device ratio, and 4000 x 4000. */
	const SIZES = [
		{ w: 205, h: 266 },
		{ w: 2051, h: 2660 },
		{ w: 2933, h: 3801 },
		{ w: 4000, h: 4000 },
	];
	it("205 x 266, 2051 x 2660, 2933 x 3801 and 4000 x 4000: one drawImage from the page canvas per read, nothing else on it", async () => {
		const reads: Read[] = [];
		for (const s of SIZES) reads.push(await readOnce(s.w, s.h, 255));
		// eslint-disable-next-line no-console
		console.log(`SHADE READ COUNT ${JSON.stringify(reads.map((r, i) => ({ ...SIZES[i], ...r })))}`);
		expect(reads.map((r) => r.dark), "precondition: a white page did not read light at every size").toEqual(SIZES.map(() => false));
		expect(reads.map((r) => r.pageDraws), "C15 the read drew from the page canvas more than once, or never").toEqual(SIZES.map(() => 1));
		expect(reads.map((r) => r.pageOther), "C15 the read reached the page canvas by another road than one drawImage").toEqual(SIZES.map(() => []));
	});
	it("a black page reads dark in the call that reads it", async () => {
		const r = await readOnce(2051, 2660, 0);
		expect(r.dark, "C15 a dark page did not answer dark in the call that read it").toBe(true);
	});
});
