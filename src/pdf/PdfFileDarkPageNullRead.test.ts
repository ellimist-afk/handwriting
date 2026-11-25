/**
 * A page canvas whose pixels cannot be read, on a page div that has an answer
 * or has none.
 *
 * The band keeps the last read of each page div's canvas as the answer a new
 * canvas on that div gives until the new canvas is read. A read that cannot
 * be done is not an answer: it must not take the place of a real one, so the
 * next canvas on that div still gives the div's last real answer while it
 * waits for its read. And a div whose only read could not be done
 * must still spare the root observer's at-once sync a pixel read on its next
 * canvas, as a div with an answer does.
 *
 * The rig is PdfFileDarkPage.test.ts's, copied as it stands less the helpers
 * these cells do not use (settle, sample, the pen and pick drivers): the controller's
 * own sync over a small element fake, the viewer probe's page list injected
 * and the pixel read stubbed to the shade each fake canvas is given, with
 * "unreadable" read as null.
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
	/** Listeners by type, as the router, the pinch bridge and the palm shield add them; `fire` delivers to them. */
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		if (typeof fn !== "function") return;
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	removeEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type);
		if (list) this.listeners.set(type, list.filter((f) => f !== fn));
	}
	/** One event to every listener of its type, in the order they were added, as a browser dispatches it. */
	fire(ev: { type: string }): void {
		for (const fn of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
	}
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
	penUp(ev?: PointerEvent): void;
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
	/** Run the timers and frames queued now, once, as one frame passing; not the ones they queue. How many ran. */
	tick(): number;
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

function rig(look: Look, ink: InkStroke[] = saved(), opts: { pages?: number; shade?: El["shade"]; loading?: boolean; persist?: (id: string) => void } = {}): Rig {
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
		(id: string) => opts.persist?.(id),
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
		tick: () => {
			const now = queued.splice(0);
			for (const cb of now) cb();
			return now.length;
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
/** The group's inline blend as last written to it: "" leaves the stylesheet's multiply. */
const blendOf = (group: El) => group.css["mixBlendMode"] ?? "";
/**
 * A page read as dark: a group on the page blending exactly normal, the highlight opaque inside it,
 * nothing at the wash on the pen canvas, and the pen ink painted there at full strength.
 */
function normalLayer(r: Rig, what: string, n = 1): void {
	const layer = layerOf(r.pageEl(n));
	expect(layer, `${what}: no highlight group on the page`).not.toBeNull();
	expect(blendOf(layer!.group), `${what}: the group does not blend normal`).toBe("normal");
	expect(fillsOf(layer!.canvas).some((p) => p.alpha === 1), `${what}: the highlight is not painted opaque in the group`).toBe(true);
	const fills = fillsOf(penCanvasOf(r, n));
	expect(fills.some((p) => p.alpha === HIGHLIGHTER_ALPHA), `${what}: a highlight is at the wash on the pen canvas`).toBe(false);
	expect(fills.some((p) => p.alpha === 1), `${what}: the pen ink was not painted`).toBe(true);
}
/** The highlight layer: a group on the page, the highlight opaque inside it, nothing translucent on the pen canvas. */
function layered(r: Rig, what: string, n = 1): void {
	const layer = layerOf(r.pageEl(n));
	expect(layer, `${what}: no highlight group on the page`).not.toBeNull();
	expect(blendOf(layer!.group), `${what}: the group does not keep the stylesheet's multiply`).toBe("");
	expect(fillsOf(layer!.canvas).some((p) => p.alpha === 1), `${what}: the highlight is not painted in the group`).toBe(true);
	expect(fillsOf(penCanvasOf(r, n)).every((p) => p.alpha === 1), `${what}: a highlight is still at the wash on the pen canvas`).toBe(true);
}

function notMultiplied(r: Rig, what: string, n = 1): void {
	const layer = layerOf(r.pageEl(n));
	const blend = layer ? (layer.group.css["mixBlendMode"] ?? "") : "none";
	expect(blend === "none" || blend === "normal", `${what}: page ${n} has a multiply highlight group (inline blend "${blend}")`).toBe(true);
}

/** The root observer's call for a page shown bare: the at-once sync (`syncShownBare`), the probe made fresh as a record does. */
function atOnceSync(r: Rig): void {
	const priv = r.priv as unknown as { syncShownBare?: () => void };
	expect(typeof priv.syncShownBare, "precondition: the controller has its at-once sync").toBe("function");
	r.priv.invalidateProbe();
	priv.syncShownBare!.call(r.priv);
}

/** A page read dark, then drawn again on a canvas that cannot be read, which a sync tries once. */
function darkThenUnreadable(r: Rig): void {
	r.sync();
	expect(reads(r.viewer()), "precondition: the page's first canvas was read at the sync").toBe(1);
	normalLayer(r, "precondition: the page read dark");
	const unreadable = r.rerender(1, "unreadable");
	r.sync();
	expect(r.viewer(), "precondition: the unreadable canvas is the page's canvas").toBe(unreadable);
	expect(reads(unreadable), "precondition: the unreadable canvas was tried once").toBe(1);
	layered(r, "precondition: the unreadable canvas is light");
}

describe("a read that cannot be done never takes the place of a page div's real answer", () => {
	it("a page read dark; drawn again on a canvas that cannot be read, tried at a sync; a third canvas, finished, found by the root observer's at-once sync: no multiply group on the page, and that sync reads nothing", () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark" });
		darkThenUnreadable(r);
		const third = r.rerender(1, "dark");
		atOnceSync(r);
		expect(r.viewer(), "precondition: the third canvas is the page's canvas").toBe(third);
		notMultiplied(r, "the third canvas, before its read, on a div last read dark");
		expect(reads(third), "the at-once sync read the third canvas").toBe(0);
		r.sync();
		expect(reads(third), "the next sync did not read the third canvas once").toBe(1);
		normalLayer(r, "the third canvas read dark");
	});
	it("the same, the third canvas still drawing at a plain sync: no multiply group on the page, and no read while it draws", () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark" });
		darkThenUnreadable(r);
		const third = r.rerender(1, "dark");
		r.page.classList.add("loadingIcon");
		r.sync();
		expect(r.viewer(), "precondition: the third canvas is the page's canvas").toBe(third);
		notMultiplied(r, "the third canvas, still drawing, on a div last read dark");
		expect(reads(third), "the third canvas was read while it was still drawing").toBe(0);
	});
});

describe("after a read that cannot be done on a page div never read, the at-once sync reads no pixels", () => {
	it("a page's first canvas cannot be read, tried at a sync; the viewer draws the page again, finished, found by the root observer's at-once sync: no read in that sync; the next sync reads the new canvas once, dark", () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "unreadable" });
		r.sync();
		expect(reads(r.viewer()), "precondition: the first canvas was tried once").toBe(1);
		const second = r.rerender(1, "dark");
		atOnceSync(r);
		expect(r.viewer(), "precondition: the second canvas is the page's canvas").toBe(second);
		expect(reads(second), "the at-once sync read pixels on a div whose only read could not be done").toBe(0);
		r.sync();
		expect(reads(second), "the next sync did not read the new canvas once").toBe(1);
		normalLayer(r, "the new canvas read dark");
	});
});
