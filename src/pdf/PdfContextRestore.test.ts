/**
 * A PDF page's saved ink after a graphics reset.
 *
 * On desktop and Android a GPU reset gives each canvas back blank, at the same
 * size, and fires `contextrestored` on it. Nothing else about the page changed:
 * same scale, same strokes, same band, same turn, same layer. These cells hold
 * that the page whose saved pen canvas or highlight canvas came back blank is
 * painted again at the next sync, that the restore asks for that sync itself,
 * and that a page with no reset is not painted again.
 *
 * Driven through the controller's own sync and paint over a small element
 * fake that keeps a child list and its listeners. The viewer probe's page list
 * is injected and the pixel read is stubbed light.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { computeBBox, InkStroke } from "../ink/Stroke";
import { resetTipModeForTest } from "../inline/TipMode";
import { setInlineTool } from "../inline/InkOverlay";

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", async (importOriginal) => {
	const real = await importOriginal<typeof import("./PdfViewerProbe")>();
	return { ...real, probeViewer: () => probe.current, readCanvasDark: () => false };
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

const PAGE_W = 600;
const PAGE_H = 800;
const GAP = 10;

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
	takeRecords(): unknown[] {
		return [];
	}
}

/** What one canvas's 2d context was asked to do: clears and fills, nothing else kept. */
class Ctx {
	clears = 0;
	fills = 0;
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
		const fns: Record<string, () => unknown> = {
			clearRect: () => {
				self.clears++;
			},
			fill: () => {
				self.fills++;
			},
			getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
			getContextAttributes: () => ({ desynchronized: false }),
		};
		this.proxy = new Proxy({} as Record<string, unknown>, {
			get(_t, p) {
				const key = String(p);
				if (key === "canvas") return self.canvas;
				if (key in self.state) return self.state[key];
				const fn = fns[key];
				return () => (fn ? fn() : undefined);
			},
			set(_t, p, v) {
				self.state[String(p)] = v;
				return true;
			},
		}) as unknown as CanvasRenderingContext2D;
	}
}

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
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	constructor(readonly tag: string, cls?: string | string[]) {
		for (const c of cls === undefined ? [] : Array.isArray(cls) ? cls : cls.split(" ")) if (c) this.classes.add(c);
	}
	get lastElementChild(): El | null {
		return this.children[this.children.length - 1] ?? null;
	}
	get nextElementSibling(): El | null {
		const p = this.parentElement;
		return p ? (p.children[p.children.indexOf(this) + 1] ?? null) : null;
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
	closest(selector: string): El | null {
		const want = selector.split(",").map((s) => s.trim().slice(1));
		for (let at: El | null = this; at; at = at.parentElement) if (want.some((c) => at!.classes.has(c))) return at;
		return null;
	}
	private detach(): void {
		const p = this.parentElement;
		if (!p) return;
		p.children.splice(p.children.indexOf(this), 1);
		this.parentElement = null;
	}
	insertBefore(n: El, ref: El | null): El {
		n.detach();
		const i = ref ? this.children.indexOf(ref) : -1;
		if (i < 0) this.children.push(n);
		else this.children.splice(i, 0, n);
		n.parentElement = this;
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
		if (on) this.classes.add(c);
		else this.classes.delete(c);
	}
	getContext(): CanvasRenderingContext2D | null {
		this.ctx ??= new Ctx(this);
		return this.ctx.proxy;
	}
	querySelector(sel: string): El | null {
		const n = /data-page-number="(\d+)"/.exec(sel)?.[1];
		return n === undefined ? null : (this.all().find((c) => c.attrs["data-page-number"] === n) ?? null);
	}
	querySelectorAll(sel: string): El[] {
		if (sel !== `canvas:not(.${OVERLAY_CLASS})`) return [];
		return this.all().filter((c) => c.tag === "canvas" && !c.classes.has(OVERLAY_CLASS));
	}
	getBoundingClientRect() {
		return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight };
	}
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		if (typeof fn !== "function") return;
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	removeEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type);
		if (list) this.listeners.set(type, list.filter((f) => f !== fn));
	}
	/**
	 * The browser gives the backing back blank: the same size, the context at its
	 * default state, no pixels, then `contextrestored` to every listener.
	 */
	restoreBlank(): void {
		this.ctx = null;
		for (const fn of [...(this.listeners.get("contextrestored") ?? [])]) fn({ type: "contextrestored" });
	}
	setPointerCapture(): void {}
	releasePointerCapture(): void {}
	contains(): boolean {
		return false;
	}
	get style() {
		return this.css;
	}
	all(): El[] {
		return this.children.flatMap((c) => [c, ...c.all()]);
	}
}

function stroke(id: string, tool: "pen" | "highlighter", cx: number, cy: number, page: number): InkStroke {
	const points = [-20, 0, 20].map((d, i) => ({ x: cx + d, y: cy, pressure: 0.5, t: i * 8 }));
	const width = tool === "highlighter" ? 12 : 2;
	return { id, tool, color: tool === "highlighter" ? "#ffd60a" : "#000000", width, points, bbox: computeBBox(points, width), createdAt: 0, page };
}
/** Two pages, each with saved pen ink and a saved highlight crossing it. */
const twoPages = (): InkStroke[] => [
	stroke("a1", "pen", 300, 200, 1),
	stroke("h1", "highlighter", 300, 200, 1),
	stroke("a2", "pen", 300, 300, 2),
	stroke("h2", "highlighter", 300, 300, 2),
];

interface Priv {
	mounted: boolean;
	boundScroller: unknown;
	overlays: Map<number, { canvas: El }>;
	sync(): void;
	invalidateProbe(): void;
}

interface Rig {
	priv: Priv;
	pageEl(n: number): El;
	/** One sync of the controller's own, the probe fresh. */
	sync(): void;
	/** Run every timer and animation frame the controller asked for, until none is left; how many ran. */
	drain(): number;
}

function rig(ink: InkStroke[]): Rig {
	resetTipModeForTest();
	const queued: Array<() => void> = [];
	let strokes = ink;
	const root = new El("div", "workspace-leaf-content");
	const container = root.createDiv({ cls: "pdf-container" });
	const scroller = container.createDiv({ cls: "pdf-viewer-container" });
	const pages: El[] = [];
	for (let n = 1; n <= 2; n++) {
		const page = scroller.createDiv({ cls: "page" });
		page.attrs["data-page-number"] = String(n);
		const c = page.createEl("canvas");
		c.offsetParent = page;
		c.clientWidth = PAGE_W;
		c.clientHeight = PAGE_H;
		c.width = PAGE_W;
		c.height = PAGE_H;
		pages.push(page);
	}
	const doc: Doc = { body: new El("body", "theme-light") };
	container.ownerDocument = doc;
	vi.stubGlobal("document", doc);
	const size = () => {
		for (const page of pages) {
			page.clientWidth = PAGE_W;
			page.clientHeight = PAGE_H;
		}
		// Both pages in view, so both are in the band.
		scroller.clientWidth = PAGE_W;
		scroller.clientHeight = 2 * PAGE_H + GAP;
		scroller.scrollWidth = PAGE_W;
		scroller.scrollHeight = 2 * PAGE_H + GAP;
	};
	size();
	probe.current = {
		scroller,
		scaleFactor: 1,
		scaleSource: "test",
		pages: pages.map((_, i) => ({ pageNumber: i + 1, leftPx: 0, topPx: i * (PAGE_H + GAP), widthPx: PAGE_W, heightPx: PAGE_H, hasCanvas: true })),
	};
	const win = {
		devicePixelRatio: 1,
		setTimeout: (cb: () => void) => queued.push(cb),
		clearTimeout: () => {},
		requestAnimationFrame: (cb: () => void) => queued.push(cb),
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
		() => "darken"
	);
	setViewTurnSource(controller, () => 0);
	const priv = controller as unknown as Priv;
	priv.mounted = true;
	priv.boundScroller = scroller;
	return {
		priv,
		pageEl: (n) => pages[n - 1]!,
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
	setInlineTool("pen");
	vi.stubGlobal("Element", El);
	vi.stubGlobal("MutationObserver", NoopObserver);
	vi.stubGlobal("ResizeObserver", NoopObserver);
});
afterEach(() => {
	setInlineTool("pen");
	probe.current = null;
	vi.unstubAllGlobals();
});

/** The page's saved pen canvas. */
function penCanvas(r: Rig, n: number): El {
	const a = r.priv.overlays.get(n);
	if (!a) throw new Error(`no saved-ink canvas on page ${n}`);
	return a.canvas;
}
/** The page's highlight canvas, inside the group of ours directly under the page. */
function highlightCanvas(r: Rig, n: number): El {
	const group = r.pageEl(n).children.find((c) => c.tag === "div" && c.classes.has(OVERLAY_CLASS));
	const canvas = group?.children.find((c) => c.tag === "canvas" && c.classes.has(OVERLAY_CLASS));
	if (!canvas) throw new Error(`no highlight canvas on page ${n}`);
	return canvas;
}
/** Clears and fills since the context was last made: a blank backing starts from none. */
const painted = (c: El) => ({ clears: c.ctx?.clears ?? 0, fills: c.ctx?.fills ?? 0 });

/** Both pages painted once, settled, and every canvas's context counts started fresh. */
/** Each page's two canvases: the saved pen canvas and the highlight canvas. */
type Canvases = { pen1: El; hl1: El; pen2: El; hl2: El };

function paintedTwice(): { r: Rig; canvases: () => Canvases } {
	const r = rig(twoPages());
	r.sync();
	r.drain();
	const canvases = (): Canvases => ({ pen1: penCanvas(r, 1), hl1: highlightCanvas(r, 1), pen2: penCanvas(r, 2), hl2: highlightCanvas(r, 2) });
	const before = canvases();
	for (const [name, c] of Object.entries(before)) {
		expect(painted(c).fills, `precondition: ${name} painted`).toBeGreaterThan(0);
		c.ctx = null;
	}
	return { r, canvases };
}

describe("a PDF page's saved ink comes back after a graphics reset", () => {
	it("guard: with no reset, the next sync paints neither page again", () => {
		const { r, canvases } = paintedTwice();
		r.sync();
		r.drain();
		for (const [name, c] of Object.entries(canvases())) expect(painted(c), `${name} after a sync with no reset`).toEqual({ clears: 0, fills: 0 });
	});

	it("the pen canvas given back blank: the next sync paints that page again and only that page, on the same canvases", () => {
		const { r, canvases } = paintedTwice();
		const was = canvases();
		was.pen1.restoreBlank();
		r.sync();
		const now = canvases();
		for (const name of Object.keys(was) as Array<keyof Canvases>) expect(now[name], `${name} is the same element`).toBe(was[name]);
		expect(painted(now.pen1).clears, "page 1's pen canvas cleared at the next sync").toBe(1);
		expect(painted(now.pen1).fills, "page 1's pen ink painted again at the next sync").toBeGreaterThan(0);
		expect(painted(now.hl1).fills, "page 1's highlight painted again at the next sync").toBeGreaterThan(0);
		expect(painted(now.pen2), "page 2's pen canvas, no reset").toEqual({ clears: 0, fills: 0 });
		expect(painted(now.hl2), "page 2's highlight canvas, no reset").toEqual({ clears: 0, fills: 0 });
	});

	it("the highlight canvas given back blank: the next sync paints that page's highlights again and only that page", () => {
		const { r, canvases } = paintedTwice();
		const was = canvases();
		was.hl1.restoreBlank();
		r.sync();
		const now = canvases();
		for (const name of Object.keys(was) as Array<keyof Canvases>) expect(now[name], `${name} is the same element`).toBe(was[name]);
		expect(painted(now.hl1).clears, "page 1's highlight canvas cleared at the next sync").toBe(1);
		expect(painted(now.hl1).fills, "page 1's highlight painted again at the next sync").toBeGreaterThan(0);
		expect(painted(now.pen2), "page 2's pen canvas, no reset").toEqual({ clears: 0, fills: 0 });
		expect(painted(now.hl2), "page 2's highlight canvas, no reset").toEqual({ clears: 0, fills: 0 });
	});

	it("the restore asks for the sync itself: with nothing else happening, the frames it asks for paint the page again", () => {
		const { r, canvases } = paintedTwice();
		const was = canvases();
		was.pen1.restoreBlank();
		expect(r.drain(), "frames asked by the restore").toBeGreaterThan(0);
		expect(painted(was.pen1).fills, "page 1's pen ink painted again with no outside sync").toBeGreaterThan(0);
		expect(painted(was.pen2), "page 2's pen canvas, no reset").toEqual({ clears: 0, fills: 0 });
	});
});
