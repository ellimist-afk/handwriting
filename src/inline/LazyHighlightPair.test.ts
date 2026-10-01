/**
 * The highlighter's two canvases get a backing only when a note needs them.
 *
 * Every mounted note blended four full-size canvases per frame: committed ink,
 * the committed highlight layer, the wet layer and the wet highlight layer. On
 * a note with no highlighter ink the highlight pair is blank on every frame and
 * still costs a full-size layer each. The pair now stays at 0x0 (no layer, no
 * GPU resource) until the note needs it: a highlighter stroke to paint, or a
 * highlighter pen-down. Once given a backing it keeps one for the life of the
 * mount and is sized with the others. Nothing is hidden: a canvas that is drawn
 * while hidden makes Chromium block the main thread on the GPU every frame.
 *
 * The first block drives the real constructor and mount() up to the canvas
 * stack (InlinePenRouter's constructor throws a sentinel, as in
 * HighlighterTipWash.test.ts), then the real penDown(), penRaw(), penUp() and
 * paintCommittedWork(). That rig has no layout, so where a cell needs a sized
 * committed canvas it sets the committed backing the way handleResize leaves
 * it. The second block runs the real handleResize (the rig of
 * UnmountReleasesBackings.test.ts).
 */
import { describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

const SENTINEL = "stop mount after the canvas stack";

vi.mock("./InlinePenRouter", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class InlinePenRouter {
		constructor() {
			throw new Error("stop mount after the canvas stack");
		}
	}
	return { ...actual, InlinePenRouter };
});

import { InkOverlayPlugin, overlayForPath, setInlineTool, getInlineTool } from "./InkOverlay";

const PATH = "lazy-highlight-pair.md";

interface Paint {
	op: "fill" | "stroke";
	color: string;
	/** The backing of the canvas the paint landed on, at the moment of the paint. */
	backing: string;
}

class RecCtx {
	paints: Paint[] = [];
	draws = 0;
	/** Every method called on this context, by name, except the getContextAttributes query. */
	calls: string[] = [];
	private state: Record<string, unknown> = { globalAlpha: 1, fillStyle: "#000000", strokeStyle: "#000000" };
	private stack: Record<string, unknown>[] = [];
	proxy: CanvasRenderingContext2D;
	constructor(owner: El) {
		const self = this;
		this.proxy = new Proxy({} as Record<string, unknown>, {
			get(_t, prop) {
				if (typeof prop === "symbol") return undefined;
				const member = self.member(prop, owner);
				if (typeof member !== "function" || prop === "getContextAttributes") return member;
				return (...args: unknown[]) => {
					self.calls.push(prop);
					return (member as (...a: unknown[]) => unknown)(...args);
				};
			},
			set(_t, prop, value) {
				if (typeof prop === "string") self.state[prop] = value;
				return true;
			},
		}) as unknown as CanvasRenderingContext2D;
	}
	private member(prop: string, owner: El): unknown {
		const at = () => `${owner.width}x${owner.height}`;
		switch (prop) {
			case "getContextAttributes":
				return () => ({ desynchronized: false });
			case "save":
				return () => void this.stack.push({ ...this.state });
			case "restore":
				return () => {
					const s = this.stack.pop();
					if (s) this.state = s;
				};
			case "fill":
				return () => void this.paints.push({ op: "fill", color: String(this.state.fillStyle), backing: at() });
			case "stroke":
				return () => void this.paints.push({ op: "stroke", color: String(this.state.strokeStyle), backing: at() });
			case "canvas":
				return undefined;
			case "drawImage":
				// As in the browser: a source with a zero dimension throws InvalidStateError.
				return (src: { width: number; height: number }) => {
					if (!(src.width > 0) || !(src.height > 0)) throw new Error("InvalidStateError: drawImage source is 0x0");
					this.draws++;
				};
		}
		if (prop in this.state) return this.state[prop];
		// Every other member is a drawing method (beginPath, arc, moveTo, clearRect, ...).
		return () => undefined;
	}
}

class FakeWin {
	devicePixelRatio = 1;
	frames: Array<(t: number) => void> = [];
	getComputedStyle(): { position: string } {
		return { position: "relative" };
	}
	requestAnimationFrame(cb: (t: number) => void): number {
		this.frames.push(cb);
		return this.frames.length;
	}
	cancelAnimationFrame(): void {}
	setTimeout(): number {
		return 1;
	}
	clearTimeout(): void {}
	matchMedia(): { matches: boolean; addEventListener: () => void; removeEventListener: () => void } {
		return { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
	}
}

class FakeDocument {
	defaultView = new FakeWin();
	body: El;
	constructor() {
		this.body = new El("body", this);
	}
}

class El {
	children: El[] = [];
	parentElement: El | null = null;
	style: Record<string, string> = {};
	classes = new Set<string>();
	attrs = new Map<string, string>();
	isConnected = true;
	scrollLeft = 0;
	scrollTop = 0;
	rec: RecCtx | null = null;
	// A new canvas element starts at 300x150, as in the browser.
	width = 300;
	height = 150;
	constructor(
		readonly tag: string,
		readonly ownerDocument: FakeDocument,
		cls?: string
	) {
		if (cls) for (const c of cls.split(" ")) this.classes.add(c);
	}
	createEl(tag: string, opts: { cls?: string } = {}): El {
		const e = new El(tag, this.ownerDocument, opts.cls);
		e.parentElement = this;
		this.children.push(e);
		return e;
	}
	createDiv(opts: { cls?: string } = {}): El {
		return this.createEl("div", opts);
	}
	setCssStyles(s: Record<string, string>): void {
		Object.assign(this.style, s);
	}
	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}
	addClass(c: string): void {
		this.classes.add(c);
	}
	removeClass(c: string): void {
		this.classes.delete(c);
	}
	toggleClass(c: string, on: boolean): void {
		if (on) this.classes.add(c);
		else this.classes.delete(c);
	}
	get classList() {
		return {
			add: (c: string) => this.classes.add(c),
			remove: (c: string) => this.classes.delete(c),
			contains: (c: string) => this.classes.has(c),
			toggle: (c: string, on?: boolean) => this.toggleClass(c, on ?? !this.classes.has(c)),
		};
	}
	closest(sel: string): El | null {
		if (sel === ".markdown-source-view" && this.classes.has("markdown-source-view")) return this;
		return null;
	}
	querySelector(): El | null {
		return null;
	}
	contains(n: unknown): boolean {
		return n === this || this.children.some((c) => c.contains(n));
	}
	addEventListener(): void {}
	removeEventListener(): void {}
	getBoundingClientRect() {
		return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
	}
	getContext(): CanvasRenderingContext2D {
		this.rec ??= new RecCtx(this);
		return this.rec.proxy;
	}
}

type O = Record<string, unknown> & {
	penDown(s: unknown, ev: unknown): void;
	penRaw(s: unknown[], ev: unknown): void;
	penUp(ev?: unknown): void;
	paintCommittedWork(cam: { x: number; y: number; zoom: number }, work: "all" | unknown[], strokes: unknown[]): boolean;
	carryBandUnderLock(want: { left: number; top: number; width: number; height: number }): "none" | "moved";
};

let built = 0;
function build(): O {
	// One note path per overlay: overlayForPath would otherwise return an earlier cell's overlay.
	const path = `${built++}-${PATH}`;
	const doc = new FakeDocument();
	const root = new El("div", doc, "markdown-source-view cm-editor");
	const scrollDOM = root.createDiv({ cls: "cm-scroller" });
	const contentDOM = scrollDOM.createDiv({ cls: "cm-content" });
	const view = {
		dom: root,
		scrollDOM,
		contentDOM,
		hasFocus: true,
		focus: () => {},
		state: { field: () => ({ file: { path }, editor: {} }) },
	};
	let thrown: unknown = null;
	try {
		new InkOverlayPlugin(view as never);
	} catch (e) {
		thrown = e;
	}
	expect((thrown as Error | null)?.message).toBe(SENTINEL);
	const o = overlayForPath(path) as unknown as O;
	expect(o).not.toBeNull();
	o.syncCamera = () => {};
	o.ensurePenTools = () => {};
	// The page class and metadata toggles read a DOM this rig does not have; they size no canvas.
	o.updateHandwritingPageClass = () => {};
	return o;
}

const BAND = "3192x2472";

/** The committed and wet backings handleResize leaves for a 1596x1236 css px band at dpr 2. */
function sizeAsResize(o: O): void {
	for (const c of [o.committedCanvas, o.wetCanvas] as unknown as El[]) {
		c.width = 3192;
		c.height = 2472;
	}
	o.committedBacking = 2;
	o.cssWidth = 1596;
	o.cssHeight = 1236;
}

const dims = (c: unknown): string => `${(c as El).width}x${(c as El).height}`;
const pair = (o: O): string => `highlight ${dims(o.highlightCanvas)}, highlight wet ${dims(o.highlightWetCanvas)}`;
const rec = (c: unknown): RecCtx => {
	(c as El).getContext();
	return (c as El).rec!;
};

const penEv = (t: number) =>
	({ pointerType: "pen", buttons: 1, button: 0, pointerId: 7, timeStamp: t, clientX: 0, clientY: 0 }) as unknown;

const run = Array.from({ length: 10 }, (_, i) => ({
	x: 100 + (i + 1) * 6, y: 100, pressure: 0.5, timestamp: (i + 1) * 4, tiltX: 0, tiltY: 0,
}));

function stroke(tool: "highlighter" | "pen", id: string, y = 100): Record<string, unknown> {
	const points = run.map((p) => ({ x: p.x, y, pressure: 0.5, t: p.timestamp }));
	return {
		id, tool, color: tool === "highlighter" ? "#ffd400" : "#000000", width: 12, points,
		bbox: { x: 100, y: y - 6, width: 60, height: 12 }, createdAt: 0,
	};
}
const cam0 = { x: 0, y: 0, zoom: 1 };

describe("the highlighter pair gets a backing only when the note needs it", () => {
	it("1. a pen-only note: after mount and a full repaint the pair is 0x0, the pen layers are drawn, and a damage repaint keeps the pair blank", () => {
		const o = build();
		expect(pair(o), "the pair after mount").toBe("highlight 0x0, highlight wet 0x0");
		sizeAsResize(o);
		const pen = rec(o.committedCanvas);
		const before = pen.paints.length;
		o.paintCommittedWork(cam0, "all", [stroke("pen", "p1")]);
		expect(pen.paints.length - before, "the pen stroke painted on the committed layer").toBeGreaterThan(0);
		expect(`committed ${dims(o.committedCanvas)}, wet ${dims(o.wetCanvas)}`).toBe(`committed ${BAND}, wet ${BAND}`);
		expect(pair(o), "the pair after a full repaint of a pen-only note").toBe("highlight 0x0, highlight wet 0x0");
		expect(o.highlightBlank, "the empty highlight layer is marked blank").toBe(true);
		o.indexDirty = true;
		o.paintCommittedWork(cam0, [{ x: 90, y: 80, width: 80, height: 40 }], [stroke("pen", "p1")]);
		expect(pair(o), "the pair after a pen-only damage repaint").toBe("highlight 0x0, highlight wet 0x0");
		expect(o.highlightBlank, "a pen-only damage repaint leaves the 0x0 highlight layer blank").toBe(true);
	});

	it("2. a note that holds a highlighter stroke gives the pair the band backing before the repaint draws the stroke into the highlight layer", () => {
		const o = build();
		sizeAsResize(o);
		const layer = rec(o.highlightCanvas);
		const before = layer.paints.length;
		o.paintCommittedWork(cam0, "all", [stroke("pen", "p1", 300), stroke("highlighter", "h1")]);
		expect(pair(o), "the pair after the first full repaint").toBe(`highlight ${BAND}, highlight wet ${BAND}`);
		const drawn = layer.paints.slice(before);
		expect(drawn.length, "the highlighter stroke painted on the highlight layer").toBeGreaterThan(0);
		expect([...new Set(drawn.map((p) => p.backing))], "every highlight paint landed on the band backing").toEqual([BAND]);
		expect(o.highlightBlank, "the highlight layer is marked painted").toBe(false);
	});

	it("3. a highlighter pen-down on a pen-only note gives the pair its backing before the wet highlight layer's first write, and the stroke commits into the highlight layer", () => {
		const o = build();
		sizeAsResize(o);
		expect(pair(o), "premise: the pair is 0x0 before the pen-down").toBe("highlight 0x0, highlight wet 0x0");
		const order: string[] = [];
		const hw = o.highlightWet as { beginStroke: (...a: unknown[]) => unknown };
		const begin = hw.beginStroke.bind(hw);
		hw.beginStroke = (...a: unknown[]) => {
			order.push(`beginStroke on highlight wet ${dims(o.highlightWetCanvas)}`);
			return begin(...a);
		};
		const prev = getInlineTool();
		try {
			setInlineTool("highlighter");
			o.penDown({ x: 100, y: 100, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 }, penEv(0));
			expect(order, "the wet highlight layer had its backing at its first write, in the pen-down task").toEqual([`beginStroke on highlight wet ${BAND}`]);
			expect(pair(o), "the pair after the pen-down").toBe(`highlight ${BAND}, highlight wet ${BAND}`);
			expect(o.activeWet).toBe(o.highlightWet);
			const trail = rec(o.highlightWetCanvas);
			const wetBefore = trail.paints.length;
			o.penRaw(run.slice(0, 5), penEv(20));
			o.penRaw(run.slice(5), penEv(40));
			expect(trail.paints.length - wetBefore, "the wet highlight layer drew the stroke").toBeGreaterThan(0);
			const layer = rec(o.highlightCanvas);
			const before = layer.paints.length;
			o.penUp(penEv(60));
			const committed = layer.paints.slice(before);
			expect(committed.length, "the stroke committed into the highlight layer").toBeGreaterThan(0);
			expect([...new Set(committed.map((p) => p.backing))]).toEqual([BAND]);
			expect(o.highlightBlank, "the highlight layer is marked painted after the commit").toBe(false);
		} finally {
			setInlineTool(prev);
		}
	});

	it("5. a band shift under a pen stroke with the pair at 0x0 draws nothing from a 0x0 canvas and still carries the committed layer", () => {
		const o = build();
		sizeAsResize(o);
		o.band = { left: 0, top: 0, width: 1596, height: 1236 };
		const prev = getInlineTool();
		try {
			setInlineTool("pen");
			o.penDown({ x: 100, y: 100, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 }, penEv(0));
			expect(pair(o), "premise: the pair is 0x0 under a pen stroke").toBe("highlight 0x0, highlight wet 0x0");
			const committed = rec(o.committedCanvas);
			const before = committed.draws;
			let result: string | undefined;
			let thrown: unknown = null;
			try {
				result = o.carryBandUnderLock({ left: 0, top: -40, width: 1596, height: 1236 });
			} catch (e) {
				thrown = e;
			}
			expect((thrown as Error | null)?.message, "the band shift threw").toBeUndefined();
			expect(result).toBe("moved");
			expect(committed.draws - before, "the committed layer was carried once").toBe(1);
			expect(pair(o), "the pair after the shift").toBe("highlight 0x0, highlight wet 0x0");
		} finally {
			setInlineTool(prev);
		}
	});

	it("6. an undo or paste that brings a highlighter stroke into a pen-only note gives the pair its backing before the draw, and the stroke is drawn", () => {
		const o = build();
		sizeAsResize(o);
		o.paintCommittedWork(cam0, "all", [stroke("pen", "p1", 300)]);
		expect(pair(o), "premise: a pen-only note keeps the pair at 0x0").toBe("highlight 0x0, highlight wet 0x0");
		o.indexDirty = true;
		const layer = rec(o.highlightCanvas);
		const before = layer.paints.length;
		// The stroke came back (undo, paste, sync): its box is the damage.
		o.paintCommittedWork(cam0, [{ x: 90, y: 80, width: 80, height: 40 }], [stroke("pen", "p1", 300), stroke("highlighter", "h1")]);
		expect(pair(o), "the pair after the damage repaint").toBe(`highlight ${BAND}, highlight wet ${BAND}`);
		const drawn = layer.paints.slice(before);
		expect(drawn.length, "the highlighter stroke painted on the highlight layer").toBeGreaterThan(0);
		expect([...new Set(drawn.map((p) => p.backing))], "every highlight paint landed on the band backing").toEqual([BAND]);
		expect(o.highlightBlank, "the highlight layer is marked painted").toBe(false);
	});

	it("7. no 2D context call reaches the deferred pair through mount, a pen stroke with a band shift under it and its commit, an abandoned stroke, and the rest repaint that bakes a settled pan", () => {
		const o = build();
		sizeAsResize(o);
		o.band = { left: 0, top: 0, width: 1596, height: 1236 };
		const hl = rec(o.highlightCanvas), hw = rec(o.highlightWetCanvas);
		// The calls made since the last read, then cleared: each phase reports its own, and every phase reports.
		const calls = () => {
			const seen = [...hl.calls.map((c) => `highlight ${c}`), ...hw.calls.map((c) => `highlight wet ${c}`)];
			hl.calls.length = 0;
			hw.calls.length = 0;
			return seen;
		};
		expect(pair(o), "premise: the pair is 0x0 after mount").toBe("highlight 0x0, highlight wet 0x0");
		expect.soft(calls(), "context calls on the pair during mount").toEqual([]);
		const prev = getInlineTool();
		try {
			setInlineTool("pen");
			o.penDown({ x: 100, y: 100, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 }, penEv(0));
			o.penRaw(run.slice(0, 5), penEv(20));
			expect(o.carryBandUnderLock({ left: 0, top: -40, width: 1596, height: 1236 }), "premise: the band moved under the stroke").toBe("moved");
			o.penRaw(run.slice(5), penEv(40));
			o.penUp(penEv(60));
			expect.soft(calls(), "context calls on the pair through a pen stroke, a band shift under it and its commit").toEqual([]);
			o.penDown({ x: 100, y: 200, pressure: 0.5, timestamp: 80, tiltX: 0, tiltY: 0 }, penEv(80));
			o.penRaw(run.slice(0, 5), penEv(100));
			(o.strokeAbandoned as () => void)();
			expect.soft(calls(), "context calls on the pair through an abandoned stroke").toEqual([]);
		} finally {
			setInlineTool(prev);
		}
		// At rest after a fling: the settled pan is not in the raster yet, so repaint() bakes it (the
		// rasterPanNeedsBake branch clears both wet layers). The band is where it was.
		o.viewportPan = { x: -40, y: 0 };
		o.syncBand = () => "none";
		expect((o.rasterPanNeedsBake as () => boolean)(), "premise: a settled pan waits to be baked").toBe(true);
		(o.repaint as () => void)();
		expect(o.rasterPan, "premise: the repaint baked the pan").toEqual({ x: -40, y: 0 });
		expect.soft(calls(), "context calls on the pair through the rest repaint").toEqual([]);
		expect(pair(o), "the pair is still 0x0").toBe("highlight 0x0, highlight wet 0x0");
	});
});

// ---- real handleResize ------------------------------------------------------------------------------
// The rig below is UnmountReleasesBackings.test.ts's: the real handleResize, syncBand and backing
// allocation, with recording canvases. Its overlay is built without mount(), so the cell puts the pair
// in the state mount() leaves it: 0x0, no backing given yet.

type Fields = Record<string, unknown>;

const noop = (): undefined => undefined;

function rigEl(extra: Fields = {}): Fields {
	return {
		setCssStyles: noop,
		remove: noop,
		classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
		style: { removeProperty: noop, setProperty: noop },
		...extra,
	};
}

function cmLine(left: number): Fields {
	return {
		classList: { contains: (name: string) => name === "cm-line" },
		children: [] as unknown[],
		getBoundingClientRect: () => ({ left, top: 0, width: 400, height: 20, right: left + 400, bottom: 20 }),
	};
}

const RESIZE_NAMES = ["committed", "wet", "tail", "highlight", "highlightWet"] as const;

function makeResizeRig(dpr: number) {
	const frames: Array<() => void> = [];
	const win = {
		devicePixelRatio: dpr,
		getComputedStyle: () => ({ fontSize: "16px", paddingTop: undefined, position: "relative" }),
		cancelAnimationFrame: noop,
		clearTimeout: noop,
		requestAnimationFrame: (fn: () => void) => {
			frames.push(fn);
			return frames.length;
		},
	};
	const scrollDOM = rigEl({
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: 0,
		clientHeight: 0,
		scrollWidth: 0,
		scrollHeight: 0,
		clientLeft: 0,
		clientTop: 0,
		addEventListener: noop,
		removeEventListener: noop,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
	});
	const view: Fields = {
		dom: rigEl({ ownerDocument: { defaultView: win }, parentElement: rigEl() }),
		scrollDOM,
		contentDOM: rigEl({
			children: [cmLine(60)],
			getBoundingClientRect: () => ({ left: 60, top: 0, width: 1024, height: 0, right: 1084, bottom: 0 }),
		}),
		scaleX: 1,
		scaleY: 1,
		documentTop: 0,
		// `mount()` stays inert on undefined (the constructor's mount bails here).
		state: { field: () => undefined },
	};

	const o = new InkOverlayPlugin(view as never) as unknown as Fields;

	const containerStyle = { left: 0, top: 0, width: 0, height: 0 };
	const container = rigEl({
		nodeType: 1,
		setCssStyles: (styles: Record<string, string>) => {
			for (const key of ["left", "top", "width", "height"] as const) {
				if (styles[key] !== undefined) containerStyle[key] = Number.parseFloat(styles[key]);
			}
		},
		getBoundingClientRect: () => ({
			left: containerStyle.left,
			top: containerStyle.top,
			width: containerStyle.width,
			height: containerStyle.height,
			right: containerStyle.left + containerStyle.width,
			bottom: containerStyle.top + containerStyle.height,
		}),
	});
	Object.defineProperties(container, {
		offsetWidth: { get: () => containerStyle.width },
		offsetHeight: { get: () => containerStyle.height },
	});

	const canvas = (name: string): Fields => {
		let w = 300;
		let h = 150;
		const c = rigEl({ getContext: () => null, __name: name });
		Object.defineProperties(c, {
			width: { get: () => w, set: (v: number) => { w = v; } },
			height: { get: () => h, set: (v: number) => { h = v; } },
		});
		return c;
	};
	const ctx = (): CanvasRenderingContext2D => ({
		beginPath: noop, moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
		arc: noop, ellipse: noop, rect: noop, closePath: noop, fill: noop, stroke: noop, clip: noop,
		save: noop, restore: noop, clearRect: noop, setTransform: noop, fillRect: noop,
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
	}) as unknown as CanvasRenderingContext2D;

	const canvases = {
		committed: canvas("committed"),
		wet: canvas("wet"),
		tail: canvas("tail"),
		highlight: canvas("highlight"),
		highlightWet: canvas("highlightWet"),
	};
	o.container = container;
	o.committedCanvas = canvases.committed;
	o.wetCanvas = canvases.wet;
	o.tailCanvas = canvases.tail;
	o.highlightCanvas = canvases.highlight;
	o.highlightWetCanvas = canvases.highlightWet;
	o.committedCtx = ctx();
	o.highlightCtx = ctx();
	const layer = {
		applyDpr: noop, clear: noop, clearAll: noop,
		configureInlineBacking: noop,
		placeInline: noop,
		restoreFullSurface: noop,
		prepareLive: noop,
	};
	o.wet = layer;
	o.highlightWet = layer;
	o.tail = layer;
	o.mobileTools = null;
	o.router = null;

	// Shadowed exactly as FirstPaintEmptyBand.test.ts does: editor state,
	// DOM class toggles, the spacer, other panes. None of them sizes a canvas.
	o.filePath = () => "probe.md";
	o.updateHandwritingPageClass = noop;
	o.updateExtent = noop;
	o.repaintPath = noop;

	return {
		overlay: o,
		canvases,
		layout(w: number, h: number) {
			scrollDOM.clientWidth = w;
			scrollDOM.clientHeight = h;
			scrollDOM.scrollWidth = w;
			scrollDOM.scrollHeight = h * 4;
		},
		hostResized: () => (o.handleResize as () => void)(),
		sizes: () => RESIZE_NAMES.map((n) => `${n} ${canvases[n].width as number}x${canvases[n].height as number}`),
	};
}

describe("a band reallocation and the highlighter pair", () => {
	it("4. the real handleResize leaves a pair with no backing at 0x0, and a pair that has one follows the new band size", () => {
		const rig = makeResizeRig(2);
		// What mount() leaves: the pair at 0x0, no backing given.
		rig.overlay.highlightPairDeferred = true;
		for (const n of ["highlight", "highlightWet"] as const) {
			rig.canvases[n].width = 0;
			rig.canvases[n].height = 0;
		}
		rig.layout(1596, 1236);
		rig.hostResized();
		const first = rig.sizes().join(", ");
		const band = `${rig.canvases.committed.width as number}x${rig.canvases.committed.height as number}`;
		// Premise: the pen layers got a full backing.
		for (const n of ["committed", "wet"] as const) {
			expect(rig.canvases[n].width as number, `${n} allocated; ${first}`).toBeGreaterThan(300);
			expect(`${rig.canvases[n].width as number}x${rig.canvases[n].height as number}`, first).toBe(band);
		}
		for (const n of ["highlight", "highlightWet"] as const) {
			expect(`${n} ${rig.canvases[n].width as number}x${rig.canvases[n].height as number}`, first).toBe(`${n} 0x0`);
		}
		// The note needed the highlighter: the pair has its backing. The band then changes size.
		(rig.overlay.allocateHighlightPair as (() => void) | undefined)?.call(rig.overlay);
		expect(`${rig.canvases.highlight.width as number}x${rig.canvases.highlight.height as number}`, "premise: the pair has the band backing").toBe(band);
		rig.layout(1200, 900);
		rig.hostResized();
		const second = rig.sizes().join(", ");
		const band2 = `${rig.canvases.committed.width as number}x${rig.canvases.committed.height as number}`;
		expect(band2, `premise: the band changed size; ${second}`).not.toBe(band);
		for (const n of ["highlight", "highlightWet"] as const) {
			expect(`${n} ${rig.canvases[n].width as number}x${rig.canvases[n].height as number}`, second).toBe(`${n} ${band2}`);
		}
	});

	it("8. the real handleResize makes no context call on a highlight layer that is still 0x0, and sets its transform once the pair has a backing", () => {
		const rig = makeResizeRig(2);
		rig.overlay.highlightPairDeferred = true;
		for (const n of ["highlight", "highlightWet"] as const) {
			rig.canvases[n].width = 0;
			rig.canvases[n].height = 0;
		}
		const calls: string[] = [];
		const counting = new Proxy({} as Record<string, unknown>, {
			get: (_t, prop) => (...args: unknown[]) => void calls.push(`${String(prop)}(${args.join(",")})`),
		});
		rig.overlay.highlightCtx = counting;
		rig.layout(1596, 1236);
		rig.hostResized();
		expect(`${rig.canvases.highlight.width as number}x${rig.canvases.highlight.height as number}`, "premise: the pair is still 0x0").toBe("0x0");
		expect(calls, "context calls on the 0x0 highlight layer during the resize").toEqual([]);
		(rig.overlay.allocateHighlightPair as () => void).call(rig.overlay);
		rig.layout(1200, 900);
		rig.hostResized();
		expect(calls.filter((c) => c.startsWith("setTransform(")).length, "the sized pair takes its transform on the resize").toBeGreaterThan(0);
	});
});
