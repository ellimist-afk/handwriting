/**
 * PDF highlights on pages the app has made dark.
 *
 * With the PDF view's "Adapt to theme" on under a dark theme, Obsidian renders
 * the pages dark and marks it two ways: `mod-themed` on the viewer's
 * `.pdf-container`, and `theme-dark` on that window's body. A multiply wash
 * over a dark page leaves no colour band, so on those pages a highlight keeps
 * the plain wash on the saved pen canvas, the same path "Lighten for dark
 * pages" takes. Light pages keep the highlight layer.
 *
 * Driven through the controller's own sync, paint, pen, snip and root
 * observer callbacks over a small element fake that keeps a child list and
 * writes the records a browser would. Only the viewer probe (and the mobile
 * strip, which mount builds) is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { computeBBox, InkStroke } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest } from "../inline/TipMode";
import { setInlineTool } from "../inline/InkOverlay";
import type { PdfPageAssumption } from "../ink/InkPdf";

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({
	probeViewer: () => probe.current,
	viewerCanvasOf: () => null,
	wholePageCanvasOf: () => null,
}));
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
	fill: string;
	stroke: string;
}

class Ctx {
	paints: Paint[] = [];
	/** Every call, with its numeric arguments, and every paint's state: what the pixels are made of. */
	log: string[] = [];
	private m: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
	private stack: Array<[number, number, number, number, number, number]> = [];
	/** What `save` keeps beside the transform, as a browser's does: alpha, composite, styles. */
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
			const p: Paint = {
				op,
				alpha: Number(self.state.globalAlpha),
				composite: String(self.state.globalCompositeOperation),
				fill: String(self.state.fillStyle),
				stroke: String(self.state.strokeStyle),
			};
			self.paints.push(p);
			self.log.push(`${op} a=${p.alpha} c=${p.composite} f=${p.fill} s=${p.stroke} w=${String(self.state.lineWidth)}`);
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
	selectionPage: number;
	selected: string[];
	snipSelection(): Promise<{ ok: boolean; reason?: string }>;
	mount(): void;
	unmount(): void;
	refresh(): void;
}

interface Look {
	/** Obsidian's mark on the viewer's container: "Adapt to theme" is on. */
	themed: boolean;
	/** The body class of the window the PDF is in. */
	dark: boolean;
	assumption?: PdfPageAssumption;
	/** A popout window: the main window's body, which must not be the one read. */
	mainDark?: boolean;
}

interface Rig {
	priv: Priv;
	root: El;
	container: El;
	scroller: El;
	page: El;
	body: El;
	strokes(): InkStroke[];
	sync(): void;
	/** Run every timer and animation frame the controller asked for, until none is left; how many ran. */
	drain(): number;
}

const cleanups: Array<() => void> = [];

function rig(look: Look, ink: InkStroke[] = saved()): Rig {
	resetTipModeForTest();
	const queued: Array<() => void> = [];
	let strokes = ink;
	// The leaf, the viewer's container under it, the scroller under that, one page.
	const root = new El("div", "workspace-leaf-content");
	const container = root.createDiv({ cls: look.themed ? "pdf-container mod-themed" : "pdf-container" });
	const scroller = container.createDiv({ cls: "pdf-viewer-container" });
	const page = scroller.createDiv({ cls: "page" });
	page.attrs["data-page-number"] = "1";
	scroller.page = page;
	page.createEl("canvas");
	const body = new El("body", look.dark ? "theme-dark" : "theme-light");
	const doc: Doc = { body };
	container.ownerDocument = doc;
	// The main window's document: this window's own, unless the PDF is in a popout.
	const main: Doc = look.mainDark === undefined ? doc : { body: new El("body", look.mainDark ? "theme-dark" : "theme-light") };
	vi.stubGlobal("document", main);
	const size = () => {
		page.clientWidth = PAGE_W;
		page.clientHeight = PAGE_H;
		scroller.clientWidth = PAGE_W;
		scroller.clientHeight = PAGE_H;
		scroller.scrollWidth = PAGE_W;
		scroller.scrollHeight = PAGE_H;
	};
	size();
	const box = () => ({ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: PAGE_W, heightPx: PAGE_H });
	probe.current = { scroller, scaleFactor: 1, scaleSource: "test", pages: [{ ...box(), hasCanvas: true }] };
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
	return {
		priv,
		root,
		container,
		scroller,
		page,
		body,
		strokes: () => strokes,
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
	setInlineTool("pen");
	vi.stubGlobal("Element", El);
	vi.stubGlobal("MutationObserver", FakeObserver);
	vi.stubGlobal("ResizeObserver", NoopResizeObserver);
});
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
	setInlineTool("pen");
	probe.current = null;
	watches = [];
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
const fillsOf = (el: El) => (el.ctx?.paints ?? []).filter((p) => p.op === "fill");
/** The plain wash on the pen canvas: a fill at the highlighter's alpha, and the pen ink at full strength. */
function plainWash(r: Rig, what: string): void {
	const fills = fillsOf(penCanvasOf(r));
	expect(fills.some((p) => p.alpha === HIGHLIGHTER_ALPHA), `${what}: the pen canvas holds no highlight at the wash`).toBe(true);
	expect(fills.some((p) => p.alpha === 1), `${what}: the pen ink was not painted`).toBe(true);
}
/** The highlight layer: a group on the page, the highlight opaque inside it, nothing translucent on the pen canvas. */
function layered(r: Rig, what: string): void {
	const layer = layerOf(r.page);
	expect(layer, `${what}: no highlight group on the page`).not.toBeNull();
	expect(fillsOf(layer!.canvas).some((p) => p.alpha === 1), `${what}: the highlight is not painted in the group`).toBe(true);
	expect(fillsOf(penCanvasOf(r)).every((p) => p.alpha === 1), `${what}: a highlight is still at the wash on the pen canvas`).toBe(true);
}

describe("K1: on a page the app made dark, a saved highlight is the plain wash on the pen canvas", () => {
	it("container themed, body dark, default setting: no group; the pen canvas paints exactly what \"Lighten for dark pages\" paints", () => {
		const r = rig({ themed: true, dark: true });
		r.sync();
		expect(layerOf(r.page), "K1 a highlight group on a page the app made dark").toBeNull();
		expect(r.page.all().filter((c) => c.tag === "div"), "K1 a div of ours on the page").toEqual([]);
		plainWash(r, "K1");
		const lighten = rig({ themed: true, dark: true, assumption: "lighten" });
		lighten.sync();
		expect(layerOf(lighten.page), "precondition: the lighten page has no group").toBeNull();
		expect(penCanvasOf(r).ctx!.log, "K1 the pen canvas did not paint what the lighten path paints").toEqual(penCanvasOf(lighten).ctx!.log);
	});
});

describe("K2, K3: the group stays unless both marks are there", () => {
	it("K2 container themed, body light: the group stays", () => {
		const r = rig({ themed: true, dark: false });
		r.sync();
		layered(r, "K2");
	});
	it("K3 body dark, container not themed: the group stays", () => {
		const r = rig({ themed: false, dark: true });
		r.sync();
		layered(r, "K3");
	});
});

describe("K4: an open PDF follows the change with no reopen", () => {
	/** The viewer draws its page again, as `setBackground` makes it: its own canvas replaced. */
	function rerender(r: Rig): void {
		const own = r.page.children.find((c) => c.tag === "canvas" && !c.classes.has(OVERLAY_CLASS));
		own?.remove();
		r.page.insertBefore(new El("canvas"), r.page.children[0] ?? null);
	}

	it("the container turns themed and the pages render again: the group goes and the wash is on the pen canvas; back: the group returns", async () => {
		const r = rig({ themed: false, dark: true });
		r.priv.mount();
		cleanups.push(() => r.priv.unmount());
		r.drain();
		layered(r, "precondition");
		const pen = penCanvasOf(r);
		pen.ctx!.paints = [];
		// What onCSSChange does when the option goes on: the class, then the pages.
		r.container.classList.add("mod-themed");
		rerender(r);
		await settle();
		expect(r.drain(), "K4 nothing repainted after the container turned themed").toBeGreaterThan(0);
		expect(layerOf(r.page), "K4 the group stayed after the container turned themed").toBeNull();
		expect(penCanvasOf(r), "K4 the pen canvas was rebuilt").toBe(pen);
		plainWash(r, "K4");
		pen.ctx!.paints = [];
		r.container.classList.remove("mod-themed");
		rerender(r);
		await settle();
		expect(r.drain(), "K4 nothing repainted after the container turned back").toBeGreaterThan(0);
		layered(r, "K4 back");
		expect(penCanvasOf(r)).toBe(pen);
	});

	it("with the option on, a theme switch (the css-change fan-out refreshes every open PDF): light to dark the group goes; back it returns", () => {
		const r = rig({ themed: true, dark: false });
		r.sync();
		layered(r, "precondition");
		const pen = penCanvasOf(r);
		pen.ctx!.paints = [];
		r.body.classList.remove("theme-light");
		r.body.classList.add("theme-dark");
		r.priv.refresh();
		expect(r.drain(), "K4 the refresh asked for no repaint").toBeGreaterThan(0);
		expect(layerOf(r.page), "K4 the group stayed after the switch to dark").toBeNull();
		plainWash(r, "K4 dark");
		pen.ctx!.paints = [];
		r.body.classList.remove("theme-dark");
		r.body.classList.add("theme-light");
		r.priv.refresh();
		r.drain();
		layered(r, "K4 light again");
		expect(penCanvasOf(r)).toBe(pen);
	});
});

describe("K5: a highlighter on a page the app made dark", () => {
	/** A highlighter stroke on page 1: down, moved; the caller lifts it. */
	function down(r: Rig): void {
		setInlineTool("highlighter");
		r.priv.penDown(sample(150, 400, 0), { pointerType: "pen" } as PointerEvent);
		r.priv.penRaw([sample(200, 400, 16), sample(250, 400, 32), sample(300, 400, 48)]);
	}
	it("the live pair stays on the page at the wash alpha, and nothing changes at the lift", () => {
		const r = rig({ themed: true, dark: true });
		r.sync();
		down(r);
		const pair = r.priv.pair!;
		expect(pair.wetCanvas.parentElement, "K5 the live highlighter went into a group").toBe(r.page);
		expect(layerOf(r.page), "K5 a group appeared at pen-down").toBeNull();
		expect(pair.wetCanvas.css.opacity, "K5 the live highlighter is not at the wash").toBe(String(HIGHLIGHTER_ALPHA));
		expect(pair.headCanvas.css.opacity, "K5 the live head is not at the wash").toBe(String(HIGHLIGHTER_ALPHA));
		r.priv.penUp();
		r.drain();
		expect(layerOf(r.page), "K5 a group appeared at the lift").toBeNull();
		expect(r.strokes().filter((s) => s.tool === "highlighter").length, "precondition: the highlight was committed").toBe(2);
		// The committed highlight takes the same wash the live one wore.
		const washed = fillsOf(penCanvasOf(r)).filter((p) => p.alpha === HIGHLIGHTER_ALPHA);
		expect(washed.length, "K5 the lifted highlight is not at the wash on the pen canvas").toBeGreaterThan(0);
		// And the same as "Lighten for dark pages" after the same stroke.
		const lighten = rig({ themed: true, dark: true, assumption: "lighten" });
		lighten.sync();
		down(lighten);
		lighten.priv.penUp();
		lighten.drain();
		expect(penCanvasOf(r).ctx!.log, "K5 after the lift the pen canvas differs from the lighten path's").toEqual(penCanvasOf(lighten).ctx!.log);
	});
});

describe("K6: the snip of a page the app made dark", () => {
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
	const noStyle = (log: string[]) => log.map((l) => l.replace(/ f=\S+ s=\S+/, ""));
	const penFills = (el: El) => fillsOf(el).filter((p) => p.alpha === 1 && p.composite === "source-over").map((p) => p.fill);

	it("no multiply composite; the same snip as \"Lighten for dark pages\", the pen ink in the setting's colours", async () => {
		const r = rig({ themed: true, dark: true });
		r.sync();
		const made = await snip(r);
		expect(made.length, "K6 the snip made a canvas for a highlight layer").toBe(1);
		const paints = made[0]!.ctx!.paints;
		expect(paints.some((p) => p.composite === "multiply"), "K6 the snip multiplied a highlight onto the page").toBe(false);
		expect(paints.some((p) => p.op === "fill" && p.alpha === HIGHLIGHTER_ALPHA), "K6 the snip has no highlight at the wash").toBe(true);
		const lighten = rig({ themed: true, dark: true, assumption: "lighten" });
		lighten.sync();
		const lmade = await snip(lighten);
		expect(lmade.length).toBe(1);
		expect(noStyle(made[0]!.ctx!.log), "K6 the snip is not drawn as the lighten snip is").toEqual(noStyle(lmade[0]!.ctx!.log));
		// The pen ink keeps the colours the setting gives it: the same as a light page's snip.
		const light = rig({ themed: false, dark: false });
		light.sync();
		const pmade = await snip(light);
		expect(penFills(made[0]!), "K6 the pen ink's colour changed in the snip").toEqual(penFills(pmade[0]!));
	});
});

describe("K7: a PDF in a popout window reads that window's body", () => {
	it("the popout dark, the main window light: no group", () => {
		const r = rig({ themed: true, dark: true, mainDark: false });
		r.sync();
		expect(layerOf(r.page), "K7 the main window's body was read").toBeNull();
		plainWash(r, "K7");
	});
	it("the popout light, the main window dark: the group stays", () => {
		const r = rig({ themed: true, dark: false, mainDark: true });
		r.sync();
		layered(r, "K7");
	});
});
