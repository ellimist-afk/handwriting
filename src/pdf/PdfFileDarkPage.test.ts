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
import { resetTipModeForTest, setTipModeListener, tipMode } from "../inline/TipMode";
import {
	addStripSurface,
	refreshAllStrips,
	setInlineEraserMode,
	setInlineLassoMode,
	setInlinePanMode,
	setInlineSpaceMode,
	setInlineTool,
} from "../inline/InkOverlay";
import type { PdfPageAssumption } from "../ink/InkPdf";
import { installFakeWindow, penEvent } from "../../test/routerHarness";
import { finishLiveStrokesOnHide } from "../inline/InlinePenRouter";

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
// The plugin class cannot be built here, so its wiring is read as source (C24).
import onloadSrc from "../PluginOnload.ts?raw";

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
 * A page read as dark since F1: a group on the page blending exactly normal, the highlight opaque inside it,
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
/** A stroke on page 1, the highlighter's unless named: down, moved; the caller lifts it. */
function down(r: Rig, tool: "pen" | "highlighter" = "highlighter"): void {
	setInlineTool(tool);
	r.priv.penDown(sample(150, 400, 0), { pointerType: "pen" } as PointerEvent);
	r.priv.penRaw([sample(200, 400, 16), sample(250, 400, 32), sample(300, 400, 48)]);
}
/**
 * A tool picked the way the app picks one, as an open PDF hears it: the tool
 * state, then the strip fan-out every pick command ends in, reaching this
 * controller through the five callbacks PluginOnload registers for each open
 * PDF; then the microtasks and frames a hand takes between a tap on the strip
 * and pen-down. No sync is asked for here but the one the strip refresh asks
 * for, as PluginOnload's does (C24 holds that the two agree). Returns how many
 * times the fan-out reached this PDF's strip.
 */
async function pick(r: Rig, tool: "pen" | "highlighter"): Promise<number> {
	const c = r.priv as unknown as PdfInkController;
	let reached = 0;
	const undo = addStripSurface(
		() => {
			reached++;
			c.refreshStrip();
			c.syncForTool();
		},
		() => c.dissolveSelection(),
		() => c.refresh(),
		() => c.hideCursor(),
		(preserveMouse = false) => c.endLiveStroke(preserveMouse)
	);
	try {
		setInlineTool(tool);
		refreshAllStrips();
		await settle();
		r.drain();
		await settle();
	} finally {
		undo();
	}
	return reached;
}
/**
 * A pick the way every pick entry makes it: the Highlighter command
 * (RegisterCommands), a colour command (PluginApply pickUpNib, then
 * setInkColor) and a preset chip or hotkey (InkPresetHost pickUpNibFor, then
 * its own refresh) each set the tool, put every tip mode away, then run the
 * strip fan-out. Reaches this controller through the same five callbacks as
 * `pick`, which stay registered for the whole call. With `inTask` the pen
 * comes down in the pick's own task: no microtask, timer or frame runs.
 * Returns how many times the fan-out reached this PDF's strip.
 */
async function entryPick(r: Rig, tool: "pen" | "highlighter", inTask = false): Promise<number> {
	const c = r.priv as unknown as PdfInkController;
	let reached = 0;
	const undo = addStripSurface(
		() => {
			reached++;
			c.refreshStrip();
			c.syncForTool();
		},
		() => c.dissolveSelection(),
		() => c.refresh(),
		() => c.hideCursor(),
		(preserveMouse = false) => c.endLiveStroke(preserveMouse)
	);
	// The app's tip-mode listener (InkOverlayToolState) runs the same fan-out
	// when a pick puts a tip mode away, and then, unless the tip is left on the
	// lasso, dissolves every open PDF's selection (PluginOnload's tip-mode
	// callback); the rig's reset clears it, so it is put back for the pick.
	setTipModeListener(() => {
		refreshAllStrips();
		if (tipMode() !== "lasso") c.dissolveSelection();
	});
	try {
		setInlineTool(tool);
		setInlineEraserMode(false);
		setInlineLassoMode(false);
		setInlineSpaceMode(false);
		setInlinePanMode(false);
		refreshAllStrips();
		if (!inTask) {
			await settle();
			r.drain();
			await settle();
		}
	} finally {
		setTipModeListener(null);
		undo();
	}
	return reached;
}
/** Run `act` with this PDF's strip on the fan-out, then let everything queued run; how many syncs it cost. */
async function syncsDuring(r: Rig, act: () => void): Promise<number> {
	const c = r.priv as unknown as PdfInkController;
	const undo = addStripSurface(
		() => {
			c.refreshStrip();
			c.syncForTool();
		},
		() => c.dissolveSelection(),
		() => c.refresh(),
		() => c.hideCursor(),
		(preserveMouse = false) => c.endLiveStroke(preserveMouse)
	);
	setTipModeListener(() => refreshAllStrips());
	const spy = vi.spyOn(r.priv, "sync");
	try {
		act();
		await settle();
		r.drain();
		await settle();
		return spy.mock.calls.length;
	} finally {
		spy.mockRestore();
		setTipModeListener(null);
		undo();
	}
}
/** Where the live pair sits: on the page div, in the page's highlight group, or elsewhere. */
function wherePair(r: Rig): string {
	const pair = r.priv.pair;
	if (!pair) return "no pair";
	const parent = pair.wetCanvas.parentElement;
	if (parent === r.page) return "page";
	const layer = layerOf(r.page);
	if (layer && parent === layer.group) return "group";
	return "other";
}

describe("C1: a page still drawing is not read; the sync after its draw ends reads it", () => {
	it("light meanwhile and no read while loadingIcon is on the page div; the draw ends dark in the same element: the group, blending normal", async () => {
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
		normalLayer(r, "C1");
	});
});

describe("C2: where the app made the pages dark, no pixel is read", () => {
	it("container themed, body dark, a finished light canvas: the group blending normal, no read", () => {
		const r = rig({ themed: true, dark: true }, saved(), { shade: "light" });
		r.sync();
		r.sync();
		expect(probe.reads.length, "C2 a canvas was read under the app's dark pages").toBe(0);
		normalLayer(r, "C2");
	});
});

describe("C3: a gesture's page keeps its answer from pen-down to the lift", () => {
	it("pen-down on a page with no finished read; the page finishes dark; a sync before the lift reads nothing and moves nothing; the lift reads it: the group blends normal", () => {
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
		normalLayer(r, "C3 after the lift");
		expect(pair.wetCanvas.parentElement, "C3 the pair is not back on the page after the lift").toBe(r.page);
	});

	it("the other way round: pen-down on a page read dark; the viewer draws it again light; a sync before the lift reads nothing and moves nothing; the lift reads it: the group keeps the stylesheet's multiply", () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark" });
		r.sync();
		normalLayer(r, "precondition");
		down(r);
		const pair = r.priv.pair!;
		const group = layerOf(r.page)!.group;
		expect(pair.wetCanvas.parentElement, "precondition: the live highlighter is in the group").toBe(group);
		expect(blendOf(group), "precondition: the group blends normal").toBe("normal");
		const pen = penCanvasOf(r);
		expect(pair.wetCanvas.css.opacity, "precondition: the live highlighter is at full opacity in the group").toBe("1");
		const fresh = r.rerender(1, "light");
		r.sync();
		expect(reads(fresh), "C3 the new canvas was read before the lift").toBe(0);
		expect(blendOf(group), "C3 the group's blend changed before the lift").toBe("normal");
		expect(pair.wetCanvas.parentElement, "C3 the live highlighter moved before the lift").toBe(group);
		expect([pair.wetCanvas.css.opacity, pair.headCanvas.css.opacity], "C3 the live highlighter's opacity changed before the lift").toEqual(["1", "1"]);
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
	it("guard: after the real lift and no other event, the page is read once and its answer shows: the group blends normal", () => {
		const r = rig({ themed: false, dark: false }, saved(), { loading: true });
		const canvas = r.viewer();
		r.sync();
		down(r);
		finishMidStroke(r, canvas);
		r.priv.penUp();
		expect(reads(canvas), "C14 the lift's own sync did not read the page once").toBe(1);
		r.drain();
		expect(reads(canvas), "C14 the page was read more than once").toBe(1);
		normalLayer(r, "C14 after the lift");
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

	it("a page read dark: no multiply composite, the highlight layer laid on once at the wash, and no read during the snip", async () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark" });
		r.sync();
		expect(reads(r.viewer()), "precondition: the page was read at the sync").toBe(1);
		const made = await snip(r);
		expect(probe.reads.length, "C4 the snip read the page").toBe(1);
		expect(readBack(made), "C4 the snip read a canvas back").toBe(false);
		expect(made.length, "C4 the snip made no canvas for a highlight layer").toBe(2);
		expect(multiplied(made), "C4 the snip multiplied a highlight onto a dark page").toBe(false);
		const laid = (made[0]!.ctx?.paints ?? []).filter((p) => p.op === "drawImage" && p.alpha === HIGHLIGHTER_ALPHA && p.composite === "source-over");
		expect(laid.length, "C4 the layer is not laid on once at the wash, normal").toBe(1);
		expect(fillsOf(made[0]!).some((p) => p.alpha === HIGHLIGHTER_ALPHA), "C4 a highlight is filled at the wash on the snip itself").toBe(false);
	});

	it("a page with no answer kept (still drawing): the snip reads nothing and paints the layer as today", async () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark", loading: true });
		r.sync();
		const made = await snip(r);
		expect(probe.reads.length, "C4 the snip read the page").toBe(0);
		expect(readBack(made), "C4 the snip read a canvas back").toBe(false);
		expect(multiplied(made), "C4 the snip of a page with no answer lost its layer").toBe(true);
	});

	it("a page read dark that the viewer is drawing again (a zoom settled): the screen keeps the page's dark answer until the new canvas is read, no multiply group, and the snip does too, reading nothing (BR3)", async () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark" });
		r.sync();
		const old = r.viewer();
		expect(reads(old), "precondition: the page was read at the sync").toBe(1);
		normalLayer(r, "precondition");
		penCanvasOf(r).ctx!.paints = [];
		// The viewer puts a new canvas on the page and marks the page drawing; its pixels are not final yet.
		const fresh = r.rerender(1, "light");
		r.page.classList.add("loadingIcon");
		r.sync();
		expect(r.viewer(), "precondition: the new canvas is the page's canvas").toBe(fresh);
		expect(reads(fresh), "precondition: the new canvas was read while it was still drawing").toBe(0);
		// One rig state for both: what the screen shows here is what the snip composes.
		notMultiplied(r, "C4 the page being drawn again");
		const made = await snip(r);
		expect(probe.reads.length, "C4 the snip read the page").toBe(1);
		expect(reads(old), "C4 the old canvas was read again").toBe(1);
		expect(reads(fresh), "C4 the snip read the new canvas").toBe(0);
		expect(readBack(made), "C4 the snip read a canvas back").toBe(false);
		expect(multiplied(made), "C4 the snip of a page read dark, being drawn again, multiplied a highlight").toBe(false);
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
	it("the highlighter picked the app's way, on a finished dark page with pen ink only: pen-down and its samples read nothing; the page is read once in all by the lift, and the group blending normal shows after it", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		expect(await pick(r, "highlighter"), "precondition: the pick reached this PDF's strip").toBe(1);
		const before = probe.reads.length;
		down(r);
		expect(probe.reads.length, "C6 pen-down read the page").toBe(before);
		r.priv.penUp();
		r.drain();
		expect(probe.reads.length, "C6 the page was not read exactly once by the lift").toBe(1);
		normalLayer(r, "C6 after the lift");
	});
});

describe("C16: the first highlighter stroke after a pick, with no viewer change between the pick and pen-down", () => {
	it("a finished dark page with pen ink only, last synced while the pen was the tool; the highlighter picked; pen-down: the live highlighter is in the group blending normal at full opacity, the page read once before pen-down, nothing new at the lift", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		expect(probe.reads.length, "precondition: no read while the pen is the tool").toBe(0);
		expect(await pick(r, "highlighter"), "precondition: the pick reached this PDF's strip").toBe(1);
		const before = reads(r.viewer());
		down(r);
		const pair = r.priv.pair!;
		expect(wherePair(r), "C16 where the first live highlighter after the pick is").toBe("group");
		expect(blendOf(layerOf(r.page)!.group), "C16 the group does not blend normal at pen-down").toBe("normal");
		expect(pair.wetCanvas.css.opacity, "C16 the live highlighter is not at full opacity in the group").toBe("1");
		expect(pair.headCanvas.css.opacity, "C16 the live head is not at full opacity in the group").toBe("1");
		expect(before, "C16 the page was not read once between the pick and pen-down").toBe(1);
		expect(reads(r.viewer()), "C16 pen-down read the page").toBe(before);
		r.priv.penUp();
		r.drain();
		expect(probe.reads.length, "C16 the page was read again at the lift").toBe(1);
		normalLayer(r, "C16 after the lift");
	});

	it("highlighter, pen, highlighter again: the page read dark while the highlighter was the tool; the pen picked and a sync; the highlighter picked again; pen-down: the live highlighter is in the group blending normal at full opacity, and the same canvas is not read twice", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		await pick(r, "highlighter");
		r.sync();
		expect(reads(r.viewer()), "precondition: read once with the highlighter as the tool").toBe(1);
		await pick(r, "pen");
		r.sync();
		expect(await pick(r, "highlighter"), "precondition: the pick reached this PDF's strip").toBe(1);
		down(r);
		const pair = r.priv.pair!;
		expect(wherePair(r), "C16 where the live highlighter is after the second pick").toBe("group");
		expect(blendOf(layerOf(r.page)!.group), "C16 the group does not blend normal after the second pick").toBe("normal");
		expect(pair.wetCanvas.css.opacity, "C16 the live highlighter is not at full opacity in the group").toBe("1");
		expect(probe.reads.length, "C16 the same canvas was read twice").toBe(1);
	});

	it("guard: a light page, the same order as the first cell: the live highlighter is in the group at full opacity", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "light" });
		r.sync();
		expect(await pick(r, "highlighter"), "precondition: the pick reached this PDF's strip").toBe(1);
		down(r);
		expect(wherePair(r), "C16 guard: where the live highlighter is on a light page").toBe("group");
		expect(blendOf(layerOf(r.page)!.group), "C16 guard: the group does not keep the stylesheet's multiply on a light page").toBe("");
		expect(r.priv.pair!.wetCanvas.css.opacity, "C16 guard: the live highlighter's opacity on a light page").toBe("1");
	});
});

/** The live highlighter on a page read as dark since F1: in the page's group, the group blending exactly normal, the pair at full opacity. */
function pairInNormalGroup(r: Rig, what: string): void {
	expect(wherePair(r), `${what}: where the live highlighter is`).toBe("group");
	expect(blendOf(layerOf(r.page)!.group), `${what}: the live highlighter's group does not blend normal`).toBe("normal");
	expect(r.priv.pair!.wetCanvas.css.opacity, `${what}: the live highlighter is not at full opacity in the group`).toBe("1");
	expect(r.priv.pair!.headCanvas.css.opacity, `${what}: the live head is not at full opacity in the group`).toBe("1");
}

describe("C17: the first highlighter stroke after a pick, whatever the pick puts away and however soon the pen comes down", () => {
	const starts: Array<[string, () => void]> = [
		["the pen", () => {}],
		["the lasso", () => setInlineLassoMode(true)],
		["the eraser", () => setInlineEraserMode(true)],
		["pan", () => setInlinePanMode(true)],
	];
	it.each(starts)("from %s, a finished dark page with pen ink only: the highlighter picked as every pick entry does it; pen-down: the live highlighter is in the group blending normal at full opacity", async (_name, start) => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		start();
		expect(await entryPick(r, "highlighter"), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		down(r);
		pairInNormalGroup(r, "C17 after the pick");
	});
	it("pen-down in the pick's own task, no microtask, timer or frame run between: the live highlighter is in the group blending normal at full opacity", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBe(1);
		down(r);
		pairInNormalGroup(r, "C17 pen-down in the pick's task");
	});
	it("a sync just before the pick, then pen-down in the pick's own task: the live highlighter is in the group blending normal at full opacity", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		// A sync just now: a fix that waits out a gap since the last sync would not have run by pen-down.
		r.sync();
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBe(1);
		down(r);
		pairInNormalGroup(r, "C17 pen-down right after a sync and the pick");
	});
});

describe("C18: a pick while a stroke is open changes nothing that stroke has", () => {
	// A stroke keeps asking for frames until it lifts: no drain while it is open, one frame at a time (tick).
	it("a highlighter stroke open on a page read dark; the pen picked; more samples; the lift: a highlighter stroke, and the live highlighter stayed in the group blending normal at full opacity", async () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark" });
		setInlineTool("highlighter");
		r.sync();
		r.drain();
		const before = r.strokes().length;
		down(r);
		pairInNormalGroup(r, "precondition");
		expect(await entryPick(r, "pen", true), "precondition: the pick reached this PDF's strip").toBe(1);
		await settle();
		r.tick();
		pairInNormalGroup(r, "C18 a frame after the pick");
		r.priv.penRaw([sample(350, 400, 64), sample(400, 400, 80)]);
		r.tick();
		pairInNormalGroup(r, "C18 after more samples");
		r.priv.penUp();
		r.drain();
		const made = r.strokes().slice(before);
		expect(made.map((s) => s.tool), "C18 the stroke the pick fell inside").toEqual(["highlighter"]);
	});
	it("a pen stroke open on a dark page with pen ink only; the highlighter picked; the lift: a pen stroke; the next pen-down puts the live highlighter in the group blending normal at full opacity", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		const before = r.strokes().length;
		down(r, "pen");
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBe(1);
		await settle();
		r.tick();
		r.priv.penUp();
		r.drain();
		const made = r.strokes().slice(before);
		expect(made.map((s) => s.tool), "C18 the stroke the pick fell inside").toEqual(["pen"]);
		down(r);
		pairInNormalGroup(r, "C18 the next pen-down");
	});
	it("guard for the fix's shape: a pick between pen-down and the lift asks for no sync before the lift", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		down(r, "pen");
		r.tick();
		const spy = vi.spyOn(r.priv, "sync");
		r.tick();
		expect(spy.mock.calls.length, "precondition: the open stroke itself synced in a frame").toBe(0);
		await entryPick(r, "highlighter", true);
		await settle();
		r.tick();
		expect(spy.mock.calls.length, "C18 a sync ran while the stroke was open").toBe(0);
		spy.mockRestore();
	});
});

describe("C19: what a pick costs in syncs, and what costs none", () => {
	it("the highlighter picked from the pen: one sync", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		const spy = vi.spyOn(r.priv, "sync");
		await entryPick(r, "highlighter");
		expect(spy.mock.calls.length, "C19 syncs for one pick from the pen").toBe(1);
	});
	it("the highlighter picked from the lasso, so the fan-out runs twice: one sync", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		setInlineLassoMode(true);
		const spy = vi.spyOn(r.priv, "sync");
		expect(await entryPick(r, "highlighter"), "precondition: the fan-out reached this PDF's strip twice").toBe(2);
		expect(spy.mock.calls.length, "C19 syncs for one pick from the lasso").toBe(1);
	});
	it("the highlighter picked again while it is the tool: no sync", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		setInlineTool("highlighter");
		r.sync();
		r.drain();
		const spy = vi.spyOn(r.priv, "sync");
		await entryPick(r, "highlighter");
		expect(spy.mock.calls.length, "C19 syncs for the tool picked again").toBe(0);
	});
	it("the strips redrawn with the tool unchanged (the toolbar corner, a colour of the same tool, a setting): no sync", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		expect(await syncsDuring(r, () => refreshAllStrips()), "C19 syncs for a strip redraw").toBe(0);
	});
	it("the eraser on and off with the tool unchanged: no sync", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		const n = await syncsDuring(r, () => {
			setInlineEraserMode(true);
			setInlineEraserMode(false);
		});
		expect(n, "C19 syncs for the eraser on and off").toBe(0);
	});
});

describe("C20: a pick leaves saved ink as it is painted", () => {
	it("a dark page with saved highlights, read: the pen picked, then the highlighter: the pen canvas is not painted again and the group stays, blending normal", async () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark" });
		r.sync();
		r.drain();
		normalLayer(r, "precondition");
		penCanvasOf(r).ctx!.paints = [];
		await entryPick(r, "pen");
		await entryPick(r, "highlighter");
		expect(penCanvasOf(r).ctx!.paints, "C20 the pen canvas was painted again on a dark page").toEqual([]);
		expect(layerOf(r.page), "C20 the group went on a dark page").not.toBeNull();
		expect(blendOf(layerOf(r.page)!.group), "C20 the group does not blend normal on a dark page").toBe("normal");
	});
	it("a light page with saved highlights: the same two picks: the group stays and nothing is painted again", async () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "light" });
		r.sync();
		r.drain();
		layered(r, "precondition");
		const group = layerOf(r.page)!.group;
		penCanvasOf(r).ctx!.paints = [];
		layerOf(r.page)!.canvas.ctx!.paints = [];
		await entryPick(r, "pen");
		await entryPick(r, "highlighter");
		expect(layerOf(r.page)?.group, "C20 the group went or changed on a light page").toBe(group);
		expect(penCanvasOf(r).ctx!.paints, "C20 the pen canvas was painted again on a light page").toEqual([]);
		expect(layerOf(r.page)!.canvas.ctx!.paints, "C20 the highlight layer was painted again").toEqual([]);
	});
	it("a page with pen ink only: the same two picks: the pen canvas is not painted again", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		penCanvasOf(r).ctx!.paints = [];
		await entryPick(r, "highlighter");
		await entryPick(r, "pen");
		expect(penCanvasOf(r).ctx!.paints, "C20 the pen canvas was painted again with pen ink only").toEqual([]);
	});
});

describe("C21: a snip after a pick composes as one before it", () => {
	async function snipNow(r: Rig): Promise<Array<{ fills: number[]; composites: string[] }>> {
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
		return made.map((c) => ({
			fills: fillsOf(c).map((p) => p.alpha),
			composites: (c.ctx?.paints ?? []).map((p) => p.composite),
		}));
	}
	it("a dark page with saved highlights, read: a snip; the pen picked; a snip again: the same canvases and fills, the layer laid on at the wash, normal, no new read", async () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark" });
		r.sync();
		r.drain();
		const first = await snipNow(r);
		expect(first.length, "precondition: the snip made two canvases on a dark page, the snip and its layer").toBe(2);
		expect(first[0]!.fills, "precondition: a highlight is filled at the wash on the snip itself").not.toContain(HIGHLIGHTER_ALPHA);
		expect(first[0]!.composites, "precondition: the snip multiplied on a dark page").not.toContain("multiply");
		const reads = probe.reads.length;
		await entryPick(r, "pen");
		const second = await snipNow(r);
		expect(second, "C21 the snip after the pick differs from the one before").toEqual(first);
		expect(probe.reads.length, "C21 a page was read by the pick or the snip").toBe(reads);
	});
});

describe("C22: a PDF that is not mounted hears a pick and does nothing", () => {
	it("the controller not mounted: the highlighter picked: no canvas read, no live pair, nothing thrown", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		r.priv.mounted = false;
		const reads = probe.reads.length;
		await expect(entryPick(r, "highlighter"), "C22 the pick threw").resolves.toBe(1);
		expect(probe.reads.length, "C22 a page of a PDF not mounted was read").toBe(reads);
		expect(r.priv.pair, "C22 a live pair appeared on a PDF not mounted").toBeNull();
	});
});

describe("C23: where no page is read, a pick reads none", () => {
	it("the app made the pages dark (Adapt to theme on, a dark body): the highlighter picked: no read; pen-down: the live highlighter is in the group blending normal at full opacity", async () => {
		const r = rig({ themed: true, dark: true }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		await entryPick(r, "highlighter");
		expect(probe.reads.length, "C23 a page was read under the app's dark pages").toBe(0);
		down(r);
		pairInNormalGroup(r, "C23 the app's dark pages");
	});
	it("Lighten for dark pages: the highlighter picked: no read; pen-down: the live highlighter is in the group blending normal at full opacity", async () => {
		const r = rig({ themed: false, dark: false, assumption: "lighten" }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		await entryPick(r, "highlighter");
		expect(probe.reads.length, "C23 a page was read under Lighten for dark pages").toBe(0);
		down(r);
		pairInNormalGroup(r, "C23 Lighten for dark pages");
	});
});

describe("C24: the plugin's strip refresh for open PDFs is the one the cells above drive", () => {
	it("PluginOnload's first strip-surface callback refreshes each PDF's strip and then asks it for a tool sync", () => {
		// Bounded at both ends by anchors asserted to exist: the registration,
		// and its second callback (the tip-mode one) that closes the first.
		const src = onloadSrc.replace(/\r\n/g, "\n");
		const from = src.indexOf("addStripSurface(");
		expect(from, "PluginOnload registers no strip surface").toBeGreaterThan(-1);
		const to = src.indexOf("c.dissolveSelection()", from);
		expect(to, "the anchor after the strip refresh moved").toBeGreaterThan(from);
		const first = src.slice(from, to);
		expect(first, "the strip refresh no longer reaches each PDF's strip").toContain("c.refreshStrip();");
		expect(first, "the strip refresh asks no PDF for a tool sync").toContain("c.syncForTool();");
		expect(first.indexOf("c.refreshStrip();"), "the tool sync runs before the strip refresh").toBeLessThan(first.indexOf("c.syncForTool();"));
		expect(first, "the strip refresh syncs every PDF from inside the loop").not.toContain("syncPdfControllers");
	});
});

describe("C25: a sync while a pen or finger is down does not count as the pages asked under the tool", () => {
	// Every lift asks the pages again under the tool when they were not asked
	// under it: a sync under the contact that marked the tool asked would make
	// that ask, and the second pick's, find nothing to do, and the page would go
	// unread. Written when a pan's lift ran no sync, and held a precondition that
	// it ran none; the lift's ask is the change that made that untrue, so the
	// precondition went with it, and the cell's question is the same.
	it("a finished dark page with pen ink only, last synced while the pen was the tool; a pan down; the highlighter picked during the pan; a sync before the lift; the pan lifts; the highlighter picked again, pen-down in that task: the page read once, the live highlighter in the group blending normal at full opacity", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		expect(probe.reads.length, "precondition: no read while the pen is the tool").toBe(0);
		setInlinePanMode(true);
		r.priv.penDown(sample(150, 400, 0), { pointerType: "pen" } as PointerEvent);
		expect(r.priv.frame, "precondition: the pan holds a frame").not.toBeNull();
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		r.sync();
		expect(probe.reads.length, "precondition: a page was read while the pan was down").toBe(0);
		r.priv.penUp();
		expect(r.priv.frame, "precondition: the lift left the frame open").toBeNull();
		expect(await entryPick(r, "highlighter", true), "precondition: the second pick reached this PDF's strip").toBe(1);
		expect(reads(r.viewer()), "C25 the page was not read between the second pick and pen-down").toBe(1);
		down(r);
		pairInNormalGroup(r, "C25 the first highlighter pen-down after the pan");
	});
});

describe("C26: a pick made while a contact that is not a stroke is down; that contact lifts; the first highlighter stroke, no second pick", () => {
	// The pick's tool sync stands down while a contact is open, and none of these
	// four lifts is a stroke's, whose own sync asks again: the lift has to ask
	// (penUp). Each contact: its mode on, pen-down, a few samples, everything the
	// controller queued run while the pen is still down; then the highlighter
	// picked in that task; the lift; everything queued run; highlighter pen-down.
	// The eraser runs a frame ticker while down, as a stroke does, so that start
	// steps one frame at a time (tick) while the pen is down, as C18 does.
	const contacts: Array<[string, () => void, PenSample, PenSample[], boolean]> = [
		["a pan", () => setInlinePanMode(true), sample(150, 400, 0), [sample(150, 420, 16), sample(150, 440, 32)], false],
		[
			"a lasso loop round no ink",
			() => setInlineLassoMode(true),
			sample(400, 550, 0),
			[sample(550, 550, 16), sample(550, 700, 32), sample(400, 700, 48), sample(400, 560, 64)],
			false,
		],
		["a space move above the ink", () => setInlineSpaceMode(true), sample(150, 100, 0), [sample(150, 110, 16), sample(150, 120, 32)], false],
		["an erase that touches no ink", () => setInlineEraserMode(true), sample(100, 600, 0), [sample(150, 600, 16), sample(200, 600, 32)], true],
	];
	it.each(contacts)("from %s, a finished dark page with pen ink only, last synced while the pen was the tool: the live highlighter is in the group blending normal at full opacity", async (name, start, at, moves, ticking) => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		expect(probe.reads.length, "precondition: no read while the pen is the tool").toBe(0);
		start();
		r.priv.penDown(at, { pointerType: "pen" } as PointerEvent);
		expect(r.priv.frame, `precondition: ${name} holds a frame`).not.toBeNull();
		r.priv.penRaw(moves);
		if (ticking) r.tick();
		else r.drain();
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		r.priv.penUp();
		expect(r.priv.frame, `precondition: ${name}'s lift left the frame open`).toBeNull();
		await settle();
		r.drain();
		await settle();
		const before = reads(r.viewer());
		down(r);
		pairInNormalGroup(r, `C26 the first highlighter pen-down after ${name}`);
		expect(before, `C26 the page was not read between ${name}'s lift and pen-down`).toBe(1);
	});
});

/** The saved pen stroke at (300, 200) selected by a lasso loop round it; lasso mode stays on, as the app leaves it. */
function selectInk(r: Rig): void {
	setInlineLassoMode(true);
	r.priv.penDown(sample(240, 160, 0), { pointerType: "pen" } as PointerEvent);
	r.priv.penRaw([sample(360, 160, 16), sample(360, 240, 32), sample(240, 240, 48), sample(240, 170, 64)]);
	r.priv.penUp();
	r.drain();
	expect(r.priv.selected, "precondition: the lasso selected the pen stroke").toEqual(["a"]);
}

/**
 * Every contact whose lift is not a stroke's: its setup, its mode, pen-down,
 * samples, and whether it asks for a frame every frame while down (then it is
 * stepped one frame at a time, as C18 steps a stroke).
 */
interface LiftStart {
	name: string;
	setup?: (r: Rig) => void;
	start: () => void;
	at: PenSample;
	moves: PenSample[];
	ticking: boolean;
	/** The pen-down's event, when it is not a bare tip's. */
	ev?: PointerEvent;
}
const liftStarts: LiftStart[] = [
	{ name: "a pan", start: () => setInlinePanMode(true), at: sample(150, 400, 0), moves: [sample(150, 420, 16), sample(150, 440, 32)], ticking: false },
	{
		name: "a lasso loop round no ink",
		start: () => setInlineLassoMode(true),
		at: sample(400, 550, 0),
		moves: [sample(550, 550, 16), sample(550, 700, 32), sample(400, 700, 48), sample(400, 560, 64)],
		ticking: false,
	},
	{ name: "a space move above the ink", start: () => setInlineSpaceMode(true), at: sample(150, 100, 0), moves: [sample(150, 110, 16), sample(150, 120, 32)], ticking: false },
	{ name: "an erase that touches no ink", start: () => setInlineEraserMode(true), at: sample(100, 600, 0), moves: [sample(150, 600, 16), sample(200, 600, 32)], ticking: true },
	{ name: "a selection drag", setup: selectInk, start: () => {}, at: sample(300, 200, 0), moves: [sample(300, 220, 16), sample(300, 240, 32)], ticking: false },
	// The lift with no stroke to save (no builder): a space press with no ink below
	// the line. A pen tap cannot make it: pen-down feeds its own sample and one
	// point is saved as a dot, so a tap lifts as a stroke.
	{ name: "a space press with no ink below the line", start: () => setInlineSpaceMode(true), at: sample(150, 400, 0), moves: [sample(150, 410, 16)], ticking: false },
	// A pick in lasso mode puts the lasso away and the loop with it (the tip-mode
	// listener dissolves the selection), so that lift leaves with no loop. A loop
	// drawn with the side button holds no tip mode, so it survives the pick and
	// lifts through the lasso's own exit.
	{
		name: "a side-button lasso loop round no ink",
		start: () => {},
		ev: { pointerType: "pen", buttons: 2, button: 2 } as PointerEvent,
		at: sample(400, 550, 0),
		moves: [sample(550, 550, 16), sample(550, 700, 32), sample(400, 700, 48), sample(400, 560, 64)],
		ticking: false,
	},
];
/** A finished dark page with pen ink only, last synced while the pen was the tool; the start's contact down and held. */
function holdContact(s: LiftStart): Rig {
	const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
	r.sync();
	r.drain();
	s.setup?.(r);
	expect(probe.reads.length, "precondition: no read while the pen is the tool").toBe(0);
	s.start();
	r.priv.penDown(s.at, s.ev ?? ({ pointerType: "pen" } as PointerEvent));
	expect(r.priv.frame, `precondition: ${s.name} holds a frame`).not.toBeNull();
	if (s.setup) expect((r.priv as unknown as { dragFrom: unknown }).dragFrom, `precondition: ${s.name} grabbed the selection`).not.toBeNull();
	if (s.moves.length > 0) r.priv.penRaw(s.moves);
	if (s.ticking) r.tick();
	else r.drain();
	return r;
}

describe("C27: the same as C26 from a selection drag, a lift with no stroke to save and a side-button loop", () => {
	it.each(liftStarts.slice(4).map((s) => [s.name, s] as const))("from %s: the highlighter picked while it is down; the lift; the first highlighter stroke: the live highlighter is in the group blending normal at full opacity", async (name, s) => {
		const r = holdContact(s);
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		r.priv.penUp();
		expect(r.priv.frame, `precondition: ${name}'s lift left the frame open`).toBeNull();
		expect(r.strokes().length, `precondition: ${name} added a stroke`).toBe(1);
		await settle();
		r.drain();
		await settle();
		const before = reads(r.viewer());
		down(r);
		pairInNormalGroup(r, `C27 the first highlighter pen-down after ${name}`);
		expect(before, `C27 the page was not read between ${name}'s lift and pen-down`).toBe(1);
	});
});

describe("C28: what a lift asks for, when nothing was picked, inside a stroke, and under a viewer rebuild", () => {
	it.each(liftStarts.map((s) => [s.name, s] as const))("guard: %s with no pick: no sync from the lift on", async (name, s) => {
		const r = holdContact(s);
		const spy = vi.spyOn(r.priv, "sync");
		r.priv.penUp();
		await settle();
		r.drain();
		await settle();
		const n = spy.mock.calls.length;
		spy.mockRestore();
		expect(r.priv.frame, `precondition: ${name}'s lift left the frame open`).toBeNull();
		expect(n, `C28 syncs from ${name}'s lift on, with no pick`).toBe(0);
	});

	it("guard: the highlighter picked inside a pen stroke: the stroke's lift syncs once", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		down(r, "pen");
		r.tick();
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBe(1);
		r.tick();
		const spy = vi.spyOn(r.priv, "sync");
		r.priv.penUp();
		const n = spy.mock.calls.length;
		spy.mockRestore();
		expect(r.strokes().map((st) => st.tool), "precondition: the lift saved the pen stroke").toEqual(["pen", "pen"]);
		expect(n, "C28 syncs in the lift of a pen stroke with a pick inside it").toBe(1);
	});

	it("guard: the viewer rebuilt under a pan with a pick inside: one bind, and no sync runs inside a sync", async () => {
		const r = rig({ themed: false, dark: false }, [penAt("a", 300, 200)], { shade: "dark" });
		r.sync();
		r.drain();
		setInlinePanMode(true);
		r.priv.penDown(sample(150, 400, 0), { pointerType: "pen" } as PointerEvent);
		r.priv.penRaw([sample(150, 420, 16)]);
		r.drain();
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		expect(r.priv.frame, "precondition: the pan holds a frame").not.toBeNull();
		// The viewer rebuilt: the probe finds a new scroller.
		const next = r.container.createDiv({ cls: "pdf-viewer-container" });
		probe.current = { ...(probe.current as object), scroller: next };
		const proto = Object.getPrototypeOf(r.priv) as Priv;
		let depth = 0;
		let deepest = 0;
		const syncSpy = vi.spyOn(r.priv, "sync").mockImplementation(function (this: Priv) {
			depth++;
			deepest = Math.max(deepest, depth);
			try {
				proto.sync.call(this);
			} finally {
				depth--;
			}
		});
		const binder = r.priv as unknown as { bindTo(s: unknown): void };
		const bindSpy = vi.spyOn(binder, "bindTo").mockImplementation(function (this: Priv, s: unknown) {
			this.boundScroller = s;
		});
		try {
			r.sync();
			expect(r.priv.frame, "precondition: the rebuild ended the pan").toBeNull();
			expect(r.priv.boundScroller, "precondition: the rebuild bound the new scroller").toBe(next);
			expect(bindSpy.mock.calls.length, "C28 binds at the rebuild").toBe(1);
			expect(deepest, "C28 a sync ran inside a sync at the rebuild").toBe(1);
		} finally {
			bindSpy.mockRestore();
			syncSpy.mockRestore();
		}
	});
});

// ---- every lift asks: who ends a contact, a frame sync queued, a selection drag by how it was made ----

const pen = { pointerType: "pen" } as PointerEvent;
const pointerUp = { type: "pointerup", pointerType: "pen" } as PointerEvent;

/** A finished dark page, last synced while the pen was the tool; pen ink only unless named. */
function darkPage(ink: InkStroke[] = [penAt("a", 300, 200)], opts: Parameters<typeof rig>[2] = {}): Rig {
	return rig({ themed: false, dark: false }, ink, { shade: "dark", ...opts });
}

/** How many syncs `act` runs in its own task: no microtask, timer or frame is let run after it. */
function syncsIn(r: Rig, act: () => void): number {
	const spy = vi.spyOn(r.priv, "sync");
	try {
		act();
		return spy.mock.calls.length;
	} finally {
		spy.mockRestore();
	}
}

/** How many syncs `act` runs, counting everything it leaves queued. */
async function syncsFrom(r: Rig, act: () => void): Promise<number> {
	const spy = vi.spyOn(r.priv, "sync");
	try {
		act();
		await settle();
		r.drain();
		await settle();
		return spy.mock.calls.length;
	} finally {
		spy.mockRestore();
	}
}

interface RouterView {
	activePenId: number | null;
	dispose(): void;
}
interface Routed {
	/** A pen event at (x, y) on `el`, delivered to the listeners the real router put there. */
	pen(el: El, type: "pointerdown" | "pointerup", x: number, y: number, t: number): void;
	router(): RouterView | null;
}
/**
 * The pen through the real router: `bindTo` builds an InlinePenRouter on the
 * scroller, and each event reaches it through the fake's own listener lists,
 * as a browser dispatches it. Called before the rig's first sync. The router
 * there at the end of the cell is disposed with it.
 */
function routed(r: Rig): Routed {
	cleanups.push(installFakeWindow());
	const c = r.priv as unknown as { bindTo(s: unknown): void; router: RouterView | null };
	c.bindTo(r.scroller);
	cleanups.push(() => c.router?.dispose());
	return {
		pen: (el, type, x, y, t) => el.fire(penEvent(type, t, type === "pointerup" ? { x, y, pressure: 0, buttons: 0 } : { x, y })),
		router: () => c.router,
	};
}

/** The viewer rebuilt: a new scroller beside the old one, holding page 1 again, drawn dark; the probe finds it. */
function rebuildViewer(r: Rig): { scroller: El; page: El } {
	const scroller = r.container.createDiv({ cls: "pdf-viewer-container" });
	scroller.clientWidth = PAGE_W;
	scroller.clientHeight = PAGE_H;
	scroller.scrollWidth = PAGE_W;
	scroller.scrollHeight = PAGE_H;
	const page = new El("div", "page");
	page.attrs["data-page-number"] = "1";
	page.clientWidth = PAGE_W;
	page.clientHeight = PAGE_H;
	scroller.appendChild(page);
	page.appendChild(viewerCanvas(page, "dark"));
	probe.current = { ...(probe.current as object), scroller };
	r.priv.invalidateProbe();
	return { scroller, page };
}

/** `sync` wrapped to count how deep the calls nest; the deepest seen. */
function nestingOf(r: Rig): { deepest(): number; restore(): void } {
	const proto = Object.getPrototypeOf(r.priv) as Priv;
	let depth = 0;
	let deepest = 0;
	const spy = vi.spyOn(r.priv, "sync").mockImplementation(function (this: Priv) {
		depth++;
		deepest = Math.max(deepest, depth);
		try {
			proto.sync.call(this);
		} finally {
			depth--;
		}
	});
	return { deepest: () => deepest, restore: () => spy.mockRestore() };
}

describe("C29: every lift asks, whoever ends the contact, and never from inside a sync", () => {
	it("the pan lifted with its pointerup event: one sync in the lift's task; the first highlighter stroke: the live highlighter is in the group blending normal at full opacity", async () => {
		const r = holdContact(liftStarts[0]!);
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		const n = syncsIn(r, () => r.priv.penUp(pointerUp));
		expect(r.priv.frame, "precondition: the pan's lift left the frame open").toBeNull();
		expect(n, "C29 syncs in the pan's lift with its event").toBe(1);
		down(r);
		pairInNormalGroup(r, "C29 the first highlighter pen-down after the pan's lift with its event");
	});

	it("a pan through the router, ended with no event (the router finishes the live contact, as a hover-out, blur or pen-off does): one sync in that task; the first highlighter stroke: the live highlighter is in the group blending normal at full opacity", async () => {
		const r = darkPage();
		const via = routed(r);
		r.sync();
		r.drain();
		setInlinePanMode(true);
		via.pen(r.scroller, "pointerdown", 150, 400, 0);
		expect(r.priv.frame, "precondition: the router's pen-down opened the pan").not.toBeNull();
		expect(via.router()?.activePenId ?? null, "precondition: the router holds the pen").not.toBeNull();
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		const n = syncsIn(r, () => (r.priv as unknown as PdfInkController).endLiveStroke());
		expect(r.priv.frame, "precondition: the finish ended the pan").toBeNull();
		expect(n, "C29 syncs in the router's finish of a pan, no event").toBe(1);
		down(r);
		pairInNormalGroup(r, "C29 the first highlighter pen-down after the router's finish");
	});

	it("an erase ended by the root observer (its page resized under it): one sync in the observer's task and none in the real pointerup after; the first highlighter stroke: the live highlighter is in the group blending normal at full opacity", async () => {
		const r = darkPage();
		r.priv.mount();
		cleanups.push(() => r.priv.unmount());
		r.sync();
		r.drain();
		await settle();
		r.drain();
		setInlineEraserMode(true);
		r.priv.penDown(sample(100, 600, 0), pen);
		r.priv.penRaw([sample(150, 600, 16), sample(200, 600, 32)]);
		r.tick();
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		expect(r.priv.frame, "precondition: the erase holds a frame").not.toBeNull();
		const spy = vi.spyOn(r.priv, "sync");
		// A zoom as the root observer sees it: the page div is wider, and a record arrives.
		r.page.clientWidth = PAGE_W + 100;
		r.page.classList.add("zoomed");
		await settle();
		const inObserver = spy.mock.calls.length;
		spy.mockRestore();
		expect(r.priv.frame, "precondition: the observer ended the erase").toBeNull();
		expect(inObserver, "C29 syncs in the observer's task that ended the erase").toBe(1);
		const later = syncsIn(r, () => r.priv.penUp(pointerUp));
		expect(later, "C29 syncs in the real pointerup after the observer's end").toBe(0);
		r.page.clientWidth = PAGE_W;
		await settle();
		r.drain();
		await settle();
		down(r);
		pairInNormalGroup(r, "C29 the first highlighter pen-down after the observer's end");
	});

	it("guard: the viewer rebuilt under a pan with a pick inside, the rebuilt page drawn dark: one bind, no sync inside a sync, and the rebuilt page has its saved-ink canvas", async () => {
		const r = holdContact(liftStarts[0]!);
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		const next = rebuildViewer(r);
		const nesting = nestingOf(r);
		const bindSpy = vi.spyOn(r.priv as unknown as { bindTo(s: unknown): void }, "bindTo").mockImplementation(function (this: Priv, s: unknown) {
			this.boundScroller = s;
		});
		try {
			r.priv.sync();
			expect(r.priv.frame, "precondition: the rebuild ended the pan").toBeNull();
			expect(bindSpy.mock.calls.length, "C29 binds at the rebuild").toBe(1);
			expect(nesting.deepest(), "C29 a sync ran inside a sync at the rebuild").toBe(1);
			expect(r.priv.overlays.get(1)?.canvas.parentElement, "C29 the rebuilt page has no saved-ink canvas").toBe(next.page);
		} finally {
			bindSpy.mockRestore();
			nesting.restore();
		}
	});
});

describe("C30: a lift through the router that finds the viewer rebuilt", () => {
	it("a pan with a pick inside; the viewer rebuilt with no sync since and a frame sync queued; the pointerup through the router: nothing thrown, the lift binds the rebuilt viewer once, the old router holds no pen, the queued sync runs once and binds nothing, and the new router's pen-down draws in the rebuilt page's group, blending normal, at full opacity", async () => {
		const r = darkPage();
		const via = routed(r);
		r.sync();
		r.drain();
		setInlinePanMode(true);
		via.pen(r.scroller, "pointerdown", 150, 400, 0);
		expect(r.priv.frame, "precondition: the router's pen-down opened the pan").not.toBeNull();
		const old = via.router();
		expect(old?.activePenId ?? null, "precondition: the router holds the pen").not.toBeNull();
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		const next = rebuildViewer(r);
		(r.priv as unknown as { schedule(): void }).schedule();
		const bindSpy = vi.spyOn(r.priv as unknown as { bindTo(s: unknown): void }, "bindTo");
		try {
			expect(() => via.pen(r.scroller, "pointerup", 150, 420, 50), "C30 the pointerup threw").not.toThrow();
			expect(r.priv.frame, "precondition: the lift ended the pan").toBeNull();
			expect(old?.activePenId ?? null, "C30 the old router still holds the pen").toBeNull();
			expect(bindSpy.mock.calls.length, "C30 binds in the lift").toBe(1);
			const queued = syncsIn(r, () => r.drain());
			expect(queued, "C30 syncs the queued frame ran").toBe(1);
			expect(bindSpy.mock.calls.length, "C30 binds over the lift and the queued sync").toBe(1);
		} finally {
			bindSpy.mockRestore();
		}
		expect(r.priv.boundScroller, "C30 the scroller bound").toBe(next.scroller);
		expect(via.router(), "C30 no new router").not.toBe(old);
		via.pen(next.scroller, "pointerdown", 150, 400, 100);
		expect((r.priv.frame as { scroller: unknown } | null)?.scroller, "C30 the new router's pen-down is not on the rebuilt viewer").toBe(next.scroller);
		const nextGroup = layerOf(next.page)?.group;
		expect(nextGroup, "C30 no group on the rebuilt page").toBeDefined();
		expect(blendOf(nextGroup!), "C30 the rebuilt page's group does not blend normal").toBe("normal");
		expect(r.priv.pair?.wetCanvas.parentElement, "C30 the live highlighter is not in the rebuilt page's group").toBe(nextGroup);
		expect(r.priv.pair!.wetCanvas.css.opacity, "C30 the live highlighter is not at full opacity in the group").toBe("1");
		via.pen(next.scroller, "pointerup", 150, 400, 120);
	});
});

describe("C31: an erase's lift while the frame sync its ops queued has not run", () => {
	const ink = () => [penAt("a", 300, 200), penAt("b", 300, 500)];
	/** An erase across stroke b: its ops land live and queue a frame sync, which is not let run. */
	function eraseAcrossB(r: Rig): void {
		setInlineEraserMode(true);
		r.priv.penDown(sample(100, 500, 0), pen);
		r.priv.penRaw([sample(300, 500, 16), sample(400, 500, 32)]);
		expect(r.strokes().map((s) => s.id), "precondition: the erase took stroke b").not.toEqual(["a", "b"]);
		expect((r.priv as unknown as { syncQueued: boolean }).syncQueued, "precondition: the erase queued a frame sync").toBe(true);
	}
	it("the highlighter picked inside the erase; the lift; pen-down before any frame runs: one sync in the lift's task, and the live highlighter is in the group blending normal at full opacity", async () => {
		const r = darkPage(ink());
		r.sync();
		r.drain();
		eraseAcrossB(r);
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		const n = syncsIn(r, () => r.priv.penUp());
		expect(n, "C31 syncs in the erase's lift with a frame sync queued").toBe(1);
		down(r);
		pairInNormalGroup(r, "C31 the highlighter pen-down before the queued frame");
	});
	it("guard: the same erase with no pick: no sync in the lift's task (the queued frame's sync is not the lift's)", () => {
		const r = darkPage(ink());
		r.sync();
		r.drain();
		eraseAcrossB(r);
		expect(syncsIn(r, () => r.priv.penUp()), "C31 syncs in the erase's lift with no pick").toBe(0);
	});
});

describe("C32: the lift with no stroke to save leaves by the no-builder exit", () => {
	it("guard: the space press with no ink below the line: no divider, builder, erase, drag, loop or pan at its lift; the lift clears no trail and emits nothing", () => {
		const r = holdContact(liftStarts[5]!);
		const p = r.priv as unknown as { spaceLineY: number | null; builder: unknown; erasing: boolean; dragFrom: unknown; lassoPts: unknown[]; panLast: unknown };
		expect([p.spaceLineY, p.builder, p.erasing, p.dragFrom, p.lassoPts.length, p.panLast], "C32 the state the space press's lift starts from").toEqual([null, null, false, null, 0, null]);
		const host = r.priv as unknown as { clearWetTrail(n: number): void; emit(op: InkOp): boolean };
		const clear = vi.spyOn(host, "clearWetTrail");
		const emit = vi.spyOn(host, "emit");
		try {
			r.priv.penUp();
			expect([clear.mock.calls.length, emit.mock.calls.length], "C32 the lift cleared a trail or emitted an op").toEqual([0, 0]);
		} finally {
			clear.mockRestore();
			emit.mockRestore();
		}
	});
});

/** The selection outline on the live layer: the last box drawn after its last clear sits round the selected strokes. */
function outlineAt(r: Rig, what: string): void {
	const log = r.priv.pair?.wetCanvas.ctx?.log ?? [];
	const lastClear = log.map((l) => l.startsWith("clearRect(")).lastIndexOf(true);
	const lastBox = log.map((l) => l.startsWith("strokeRect(")).lastIndexOf(true);
	expect(lastBox, `${what}: no outline after the live layer's last clear`).toBeGreaterThan(lastClear);
	const [x, y, w] = /strokeRect\(([^)]*)\)/.exec(log[lastBox]!)![1]!.split(",").map(Number) as [number, number, number];
	const picked = r.strokes().filter((s) => r.priv.selected.includes(s.id));
	expect(picked.length, `${what}: nothing selected`).toBe(1);
	const b = picked[0]!.bbox;
	const zoom = w / b.width;
	expect([x / zoom, y / zoom].map((v) => Math.round(v * 100) / 100), `${what}: the outline is not round the selected strokes`).toEqual([b.x, b.y].map((v) => Math.round(v * 100) / 100));
}

/** The saved pen stroke at (300, 200) selected by a loop drawn with the pen's side button held: the tip stays on the nib. */
function selectInkSideButton(r: Rig): void {
	const side = { pointerType: "pen", buttons: 2, button: 2 } as PointerEvent;
	r.priv.penDown(sample(240, 160, 0), side);
	r.priv.penRaw([sample(360, 160, 16), sample(360, 240, 32), sample(240, 240, 48), sample(240, 170, 64)]);
	r.priv.penUp();
	r.drain();
	expect(r.priv.selected, "precondition: the side-button loop selected the pen stroke").toEqual(["a"]);
	expect(tipMode(), "precondition: the side-button loop left the tip on the nib").toBe("nib");
}

type MoveOp = Extract<InkOp, { type: "move" }>;
/** The move ops `act` records, as [dx, dy]. */
function movesRecorded(r: Rig, act: () => void): Array<[number, number]> {
	const spy = vi.spyOn(r.priv as unknown as { recordOp(op: InkOp): void }, "recordOp");
	try {
		act();
		return spy.mock.calls.map(([op]) => op).filter((op): op is MoveOp => op.type === "move").map((op) => [op.dx, op.dy]);
	} finally {
		spy.mockRestore();
	}
}

describe("C33: a pick inside a selection drag, by how the selection was made", () => {
	it("a selection made with the side button, dragged with the bare tip, the highlighter picked mid-drag: the selection stays; the lift records one move and runs one sync, the outline stays round the moved stroke; the first highlighter stroke: the live highlighter is in the group blending normal at full opacity", async () => {
		const r = darkPage();
		r.sync();
		r.drain();
		selectInkSideButton(r);
		const y0 = r.strokes()[0]!.bbox.y;
		r.priv.penDown(sample(300, 200, 0), { pointerType: "pen", buttons: 1, button: 0 } as PointerEvent);
		expect((r.priv as unknown as { dragFrom: unknown }).dragFrom, "precondition: the bare tip grabbed the selection").not.toBeNull();
		r.priv.penRaw([sample(300, 220, 16), sample(300, 240, 32)]);
		r.drain();
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		expect(r.priv.selected, "precondition: the side-button selection survived the pick").toEqual(["a"]);
		let n = -1;
		const moves = movesRecorded(r, () => {
			n = syncsIn(r, () => r.priv.penUp());
		});
		expect(moves, "C33 the side-button drag's lift recorded one move").toEqual([[0, 40]]);
		expect(r.strokes()[0]!.bbox.y - y0, "C33 the stored stroke is not where the drag left it").toBe(40);
		expect(n, "C33 syncs in the side-button drag's lift").toBe(1);
		outlineAt(r, "C33 after the lift's sync");
		await settle();
		r.drain();
		await settle();
		outlineAt(r, "C33 after everything the lift queued");
		down(r);
		pairInNormalGroup(r, "C33 the first highlighter pen-down after the side-button drag");
	});

	it("a selection made and dragged in lasso mode, the highlighter picked mid-drag: the pick puts the lasso away and the selection with it; the lift records the drag's one move and runs one sync, and the stroke is stored where the drag left it on screen", async () => {
		const r = holdContact(liftStarts[4]!);
		const y0 = penAt("a", 300, 200).bbox.y;
		expect(r.strokes()[0]!.bbox.y - y0, "precondition: the drag moved the stroke on screen").toBe(40);
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		expect(r.priv.selected, "precondition: the pick dissolved the lasso-mode selection").toEqual([]);
		let n = -1;
		const moves = movesRecorded(r, () => {
			n = syncsIn(r, () => r.priv.penUp());
		});
		expect(moves, "C33 the lasso-mode drag's lift recorded one move").toEqual([[0, 40]]);
		expect(r.strokes()[0]!.bbox.y - y0, "C33 the stored stroke is not where the drag left it").toBe(40);
		expect(n, "C33 syncs in the lasso-mode drag's lift").toBe(1);
	});
});

describe("C34: the outline after a lasso lift's sync, the band held back during the loop", () => {
	it("guard: three pages; a side-button lasso loop round the saved stroke, the highlighter picked inside it and the viewer scrolled half a page meanwhile; the lift: the outline is round the selected stroke after the lift and after everything it queued, and the live layer was not moved by them", async () => {
		const r = darkPage([penAt("a", 300, 200)], { pages: 3 });
		r.sync();
		r.drain();
		r.priv.penDown(sample(240, 160, 0), { pointerType: "pen", buttons: 2, button: 2 } as PointerEvent);
		r.priv.penRaw([sample(360, 160, 16), sample(360, 240, 32), sample(240, 240, 48), sample(240, 170, 64)]);
		r.drain();
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		r.scroller.scrollTop = PAGE_H / 2;
		(r.priv as unknown as { onScroll(): void }).onScroll();
		const live = r.priv.pair!.wetCanvas;
		const placed = () => JSON.stringify([live.css, live.width, live.height, live.parentElement === r.page]);
		r.priv.penUp();
		expect(r.priv.selected, "precondition: the loop selected the stroke").toEqual(["a"]);
		const atLift = placed();
		outlineAt(r, "C34 after the lift");
		await settle();
		r.drain();
		await settle();
		outlineAt(r, "C34 after everything the lift queued");
		expect(placed(), "C34 the live layer moved after the lift without its outline drawn again").toBe(atLift);
	});
});

describe("C35: the app hidden with an erase down and a pick inside", () => {
	it("the hide finishes the erase through the router: its write is asked before its one sync, and the store holds what the erase left", async () => {
		const log: string[] = [];
		const r = darkPage([penAt("a", 300, 200), penAt("b", 300, 500)], { persist: () => log.push("persist") });
		const via = routed(r);
		r.sync();
		r.drain();
		setInlineEraserMode(true);
		via.pen(r.scroller, "pointerdown", 100, 500, 0);
		expect(r.priv.frame, "precondition: the router's pen-down opened the erase").not.toBeNull();
		r.priv.penRaw([sample(300, 500, 16), sample(400, 500, 32)]);
		const left = r.strokes().map((s) => s.id);
		expect(left, "precondition: the erase took stroke b").not.toEqual(["a", "b"]);
		r.tick();
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		const proto = Object.getPrototypeOf(r.priv) as Priv;
		const spy = vi.spyOn(r.priv, "sync").mockImplementation(function (this: Priv) {
			log.push("sync");
			proto.sync.call(this);
		});
		try {
			finishLiveStrokesOnHide();
		} finally {
			spy.mockRestore();
		}
		expect(r.priv.frame, "precondition: the hide ended the erase").toBeNull();
		expect(log, "C35 what the hide's lift asked for, in order").toEqual(["persist", "sync"]);
		expect(r.strokes().map((s) => s.id), "C35 the store after the hide").toEqual(left);
	});
});

describe("C36: what a lift costs once one has asked", () => {
	it("guard: a pan with a pick inside lifts; then a second pan with no pick: no sync from the second lift on", async () => {
		const r = holdContact(liftStarts[0]!);
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBeGreaterThanOrEqual(1);
		r.priv.penUp();
		await settle();
		r.drain();
		await settle();
		setInlinePanMode(true);
		r.priv.penDown(sample(150, 400, 0), pen);
		r.priv.penRaw([sample(150, 420, 16)]);
		r.drain();
		expect(await syncsFrom(r, () => r.priv.penUp()), "C36 syncs from the second pan's lift on").toBe(0);
	});

	it("guard: the highlighter picked inside a pen stroke, and no viewer found at the lift (the stroke's own sync stops before the pages are asked): that one sync, no second", async () => {
		const r = darkPage();
		r.sync();
		r.drain();
		down(r, "pen");
		r.tick();
		expect(await entryPick(r, "highlighter", true), "precondition: the pick reached this PDF's strip").toBe(1);
		r.tick();
		probe.current = null;
		r.priv.invalidateProbe();
		const n = syncsIn(r, () => r.priv.penUp());
		expect(r.strokes().map((s) => s.tool), "precondition: the lift saved the pen stroke").toEqual(["pen", "pen"]);
		expect(n, "C36 syncs in a pen stroke's lift with no viewer found").toBe(1);
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
		normalLayer(r, "C8");
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

describe("C9: a paint that stops short as the page turns dark keeps the layer, blending normal, for the next one", () => {
	it("the setting changes to Lighten for dark pages while the pen canvas has no 2d context; the next paint has one: the layer blending normal", () => {
		const r = rig({ themed: false, dark: false }, saved());
		r.sync();
		layered(r, "precondition");
		const pen = penCanvasOf(r);
		r.look.assumption = "lighten";
		pen.noContext = true;
		r.sync();
		expect(layerOf(r.page), "precondition: the layer stayed").not.toBeNull();
		pen.noContext = false;
		pen.ctx!.paints = [];
		r.sync();
		// Only the blend changed: the pen canvas holds the same pixels either way and takes no wash.
		expect(blendOf(layerOf(r.page)!.group), "C9 setting: the group does not blend normal").toBe("normal");
		expect(fillsOf(pen).some((p) => p.alpha === HIGHLIGHTER_ALPHA), "C9 setting: a highlight went onto the pen canvas at the wash").toBe(false);
	});
	it("the viewer draws the page again dark while the pen canvas has no 2d context; the next paint has one: the layer blending normal", () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "light" });
		r.sync();
		layered(r, "precondition");
		const pen = penCanvasOf(r);
		r.rerender(1, "dark");
		pen.noContext = true;
		r.sync();
		expect(layerOf(r.page), "precondition: the layer stayed").not.toBeNull();
		pen.noContext = false;
		pen.ctx!.paints = [];
		r.sync();
		expect(blendOf(layerOf(r.page)!.group), "C9 dark page: the group does not blend normal").toBe("normal");
		expect(fillsOf(pen).some((p) => p.alpha === HIGHLIGHTER_ALPHA), "C9 dark page: a highlight went onto the pen canvas at the wash").toBe(false);
	});
});

describe("C11: another file's canvas starts with no answer", () => {
	it("page 1 of one file read dark; the pane opens another file whose page 1 is still drawing: light, its highlight in the group", () => {
		const r = rig({ themed: false, dark: false }, saved(), { shade: "dark" });
		r.sync();
		normalLayer(r, "precondition");
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
		normalLayer(r, "precondition");
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
		expect(layerOf(r.page), "C13 guard: the group went").not.toBeNull();
		expect(blendOf(layerOf(r.page)!.group), "C13 guard: the group does not blend normal").toBe("normal");
		expect(fillsOf(penCanvasOf(r)).some((p) => p.alpha === HIGHLIGHTER_ALPHA), "C13 guard: a highlight went onto the pen canvas at the wash").toBe(false);
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

/** No multiply highlight group on page n: no group at all, or one whose inline blend is normal. */
function notMultiplied(r: Rig, what: string, n = 1): void {
	const layer = layerOf(r.pageEl(n));
	const blend = layer ? (layer.group.css["mixBlendMode"] ?? "") : "none";
	expect(blend === "none" || blend === "normal", `${what}: page ${n} has a multiply highlight group (inline blend "${blend}")`).toBe(true);
}

describe("W2: a pen or finger down on one page does not take another dark page's answer while that page's new canvas waits for its read", () => {
	it("two pages read dark; both get a new finished canvas through the root observer's at-once sync; a highlighter goes down on page 1 and a sync runs: page 2 keeps no multiply group, and the lift reads each new canvas", () => {
		const ink = [penAt("a", 300, 200, 1), highlightAt("h", 300, 200, 1), penAt("b", 300, 200, 2), highlightAt("k", 300, 200, 2)];
		const r = rig({ themed: false, dark: false }, ink, { pages: 2, shade: "dark" });
		r.sync();
		expect(probe.reads.length, "precondition: both pages were read").toBe(2);
		notMultiplied(r, "precondition", 1);
		notMultiplied(r, "precondition", 2);
		const fresh = [r.rerender(1, "dark"), r.rerender(2, "dark")];
		// The root observer's call for a page shown bare: syncShownBare, or the plain sync where a build has none.
		const priv = r.priv as unknown as { syncShownBare?: () => void; sync(): void };
		r.priv.invalidateProbe();
		(priv.syncShownBare ?? priv.sync).call(priv);
		notMultiplied(r, "precondition: after the at-once sync", 2);
		down(r);
		expect(r.priv.frame, "precondition: a contact is open").not.toBeNull();
		const readBefore = reads(fresh[1]!);
		r.sync();
		expect(reads(fresh[1]!) - readBefore, "W2 page 2's new canvas was read while the pen was down").toBe(0);
		notMultiplied(r, "W2 a sync while the pen is down on page 1", 2);
		r.priv.penUp();
		r.drain();
		expect(reads(fresh[0]!) + reads(fresh[1]!), "W2 each new canvas was not read once").toBe(2);
		notMultiplied(r, "W2 after the lift", 2);
	});
});
