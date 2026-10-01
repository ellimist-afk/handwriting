/**
 * A second editor can request ink while another reader owns its sidecar load.
 * Exercise the real store, loadInk, scheduleRepaint, resize, camera and draw
 * methods. Only the file read, editor DOM, canvas context and unrelated UI
 * hooks are faked. Paint callbacks are captured and delivered synchronously;
 * no browser frame, clock, timeout or timing assumption participates.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

// The overlay reaches window through winRef; the node environment has none,
// so mirror the other InkOverlay suites before the module graph is pulled in.
(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { emptyPage, type ParseResult } from "../model/PageData";
import { Camera } from "../camera/Camera";
import { StrokeFrame } from "./StrokeFrame";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DamageLedger } from "../ink/DamageLedger";
import { DEFAULT_PEN } from "../ink/PenStyle";
import type { InkStroke } from "../ink/Stroke";

let nextPath = 0;
/** The scroller once Obsidian has laid the leaf out. */
const SCROLLER_W = 900;
const SCROLLER_H = 800;
/** Where the text column sits, for the origin scan. */
const COLUMN_LEFT = 60;
/** A stroke near the top-left of the note, where the report was looking. */
const STROKE_AT = { x: 100, y: 50 };

type Fields = Record<string, unknown>;

function stroke(id: string, at: { x: number; y: number }): InkStroke {
	return {
		id,
		tool: "pen",
		color: DEFAULT_PEN.color,
		width: DEFAULT_PEN.baseWidth,
		points: [
			{ x: at.x, y: at.y, pressure: 0.5, t: 0 },
			{ x: at.x + 40, y: at.y + 10, pressure: 0.5, t: 8 },
			{ x: at.x + 80, y: at.y, pressure: 0.5, t: 16 },
		],
		bbox: { x: at.x, y: at.y, width: 80, height: 10 },
		createdAt: 0,
	};
}

function el(extra: Fields = {}): Fields {
	return {
		setCssStyles: () => undefined,
		remove: () => undefined,
		classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined },
		style: { removeProperty: () => undefined },
		...extra,
	};
}

/** One ordinary `.cm-line`, which is what the origin scan is looking for. */
function cmLine(left: number): Fields {
	return {
		classList: { contains: (name: string) => name === "cm-line" },
		children: [] as unknown[],
		getBoundingClientRect: () => ({
			left,
			top: 0,
			width: 400,
			height: 20,
			right: left + 400,
			bottom: 20,
		}),
	};
}

interface CanvasLog {
	/** Every backing-size assignment on the committed canvas, in order. */
	sizes: string[];
	/** Every clearRect and draw op on the committed context, with the canvas size then. */
	ops: string[];
}

interface Rig {
	overlay: Fields;
	trace: string[];
	canvas: CanvasLog;
	/** The scroller as Obsidian sizes it; 0x0 until `layout()` is called. */
	layout(w: number, h: number): void;
	/** The host ResizeObserver's callback, verbatim: `() => this.handleResize()`. */
	hostResized(): void;
	/** Deliver captured paint callbacks synchronously and report their count. */
	deliverPaintCallbacks(): number;
	/** The committed canvas's current backing size. */
	committedSize(): { width: number; height: number };
	/** Draw ops logged since the last clearRect, i.e. what the canvas holds now. */
	drawnSinceClear(): number;
	band(): { left: number; top: number; width: number; height: number } | null;
	/** Copy blits on the committed context: one per band carry, and nothing else draws with drawImage here. */
	blits(): number;
}

function makeRig(path: string): Rig {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
 o.pinchScaleNow = 1;
	const trace: string[] = [];
	const canvasLog: CanvasLog = { sizes: [], ops: [] };
	let blitCount = 0;

	// ---- the scroller, 0x0 until layout
	const scrollDOM = el({
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: 0,
		clientHeight: 0,
		scrollWidth: 0,
		scrollHeight: 0,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	});

	// ---- the band container: an absolutely positioned box whose measured
	// size is whatever `syncBand` last wrote, and 0x0 before it writes.
	const containerStyle = { left: 0, top: 0, width: 0, height: 0 };
	const container = el({
		setCssStyles: (styles: Record<string, string>) => {
			for (const key of ["left", "top", "width", "height"] as const) {
				if (styles[key] !== undefined) containerStyle[key] = Number.parseFloat(styles[key]);
			}
			trace.push(`container.style ${containerStyle.width}x${containerStyle.height}`);
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
	// Accessors, defined after `el()`: a spread would copy their values once.
	Object.defineProperties(container, {
		offsetWidth: { get: () => containerStyle.width },
		offsetHeight: { get: () => containerStyle.height },
	});

	// ---- canvases: a fresh <canvas> is 300x150 until something sizes it.
	const canvas = (name: string): Fields => {
		let w = 300;
		let h = 150;
		const c = el({ getContext: () => null });
		Object.defineProperties(c, {
			width: {
				get: () => w,
				set: (v: number) => {
					w = v;
					if (name === "committed") canvasLog.sizes.push(`width=${v}`);
				},
			},
			height: {
				get: () => h,
				set: (v: number) => {
					h = v;
					if (name === "committed") canvasLog.sizes.push(`height=${v}`);
				},
			},
		});
		return c;
	};
	const committedCanvas = canvas("committed");
	const sizeNow = () => `${committedCanvas.width as number}x${committedCanvas.height as number}`;

	/** A 2d context that logs what lands on it. Draw ops are `stroke`/`fill`. */
	const recordingCtx = (log: boolean): CanvasRenderingContext2D => {
		const op = (name: string) => () => {
			if (log) canvasLog.ops.push(`${name} @${sizeNow()}`);
		};
		return {
			fillStyle: "",
			strokeStyle: "",
			lineWidth: 0,
			lineCap: "",
			lineJoin: "",
			globalCompositeOperation: "",
			globalAlpha: 1,
			beginPath() {},
			moveTo() {},
			lineTo() {},
			quadraticCurveTo() {},
			bezierCurveTo() {},
			arc() {},
			ellipse() {},
			rect() {},
			closePath() {},
			fill: op("fill"),
			stroke: op("stroke"),
			clip() {},
			save() {},
			restore() {},
			clearRect(x: number, y: number, w: number, h: number) {
				if (log) canvasLog.ops.push(`clearRect ${w}x${h} @${sizeNow()}`);
			},
			setTransform() {},
			getImageData: () => ({ data: new Uint8ClampedArray(4) }),
			fillRect() {},
			// A band carry slides the painted pixels with a copy blit: it moves what is there and draws nothing new.
			drawImage() {
				if (log) blitCount++;
			},
		} as unknown as CanvasRenderingContext2D;
	};

	// ---- the scheduling boundary: no frame or clock runs in this test
	const paintCallbacks: Array<() => void> = [];
	const win = {
		devicePixelRatio: 1,
		getComputedStyle: () => ({ fontSize: "16px", paddingTop: undefined, position: "relative" }),
		cancelAnimationFrame: () => undefined,
		clearTimeout: () => undefined,
		requestAnimationFrame: (fn: () => void) => {
			paintCallbacks.push(fn);
			trace.push("rAF queued");
			return paintCallbacks.length;
		},
	};

	o.view = {
		dom: el({ ownerDocument: { defaultView: win }, parentElement: null }),
		scrollDOM,
		contentDOM: el({
			children: [cmLine(COLUMN_LEFT)],
			getBoundingClientRect: () => ({
				left: COLUMN_LEFT,
				top: 0,
				width: SCROLLER_W,
				height: 0,
				right: COLUMN_LEFT + SCROLLER_W,
				bottom: 0,
			}),
		}),
		scaleX: 1,
		scaleY: 1,
		documentTop: 0,
	};

	// ---- state, as the field initializers leave it
	o.camera = new Camera();
	o.frame = new StrokeFrame();
	o.container = container;
	o.contentStyle = null;
	o.refFontPx = 0;
	o.lastFontStr = "";
	o.lastSyncFontStr = "";
	o.cssScale = 1;
	o.fontZoom = 1;
	o.scale = 1;
	o.dpr = 1;
	o.cssWidth = 0;
	o.cssHeight = 0;
	o.lastGoodColumnLeft = null;
	o.lastSyncContentLeft = 0;
	o.lastSyncDocumentTop = 0;
	o.originLine = null;
	o.originLineObserver = null;
	o.band = null;
	o.router = null;
	o.axisChecked = false;
	o.lastReach = null;
	o.resizeObserver = null;
	o.contentResizeObserver = null;
	o.committedCanvas = committedCanvas;
	o.wetCanvas = canvas("wet");
	o.tailCanvas = canvas("tail");
	o.highlightCanvas = canvas("highlight");
	o.highlightWetCanvas = canvas("highlightWet");
	o.committedCtx = recordingCtx(true);
	o.highlightCtx = recordingCtx(false);
	const layer = {
		applyDpr: () => undefined, clear: () => undefined, clearAll: () => undefined,
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
		carry: () => undefined,
	};
	o.wet = layer;
	o.highlightWet = layer;
	o.tail = layer;
	o.predReal = [];
	o.predLastTail = [];
	o.mode = "ink";
	o.builder = null;
	o.strokeIndex = new StrokeIndex();
	o.indexDirty = true;
	o.repaintQueued = false;
	o.repaintScrollOnly = false;
	o.lastPaintCam = null;
	o.lastPurgeProbe = Number.NEGATIVE_INFINITY;
	o.damage = new DamageLedger();
	o.selection = { isEmpty: true };
	o.lassoActive = false;
	o.spaceLineY = null;

	// ---- shadowed: needs an editor, the DOM or the file system; paints nothing
	o.filePath = () => path;
	o.updateHandwritingPageClass = () => undefined;
	o.updateExtent = () => undefined;
	o.repaintPath = () => undefined;

	// ---- traced, NOT replaced: each wrapper calls the prototype"s method
	const proto = InkOverlayPlugin.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
	const through = (name: string, label?: (result: unknown, args: unknown[]) => string) => {
		const real = proto[name];
		if (real === undefined) throw new Error(`not on the prototype: ${name}`);
		o[name] = function (this: unknown, ...args: unknown[]) {
			trace.push(`${name}${args.length ? `(${String(args[0])})` : ""}`);
			const result = real.apply(this, args);
			if (label) trace.push(label(result, args));
			return result;
		};
	};
	through("handleResize");
	through("syncBand", (r) => `  syncBand -> ${String(r)}`);
	through("scheduleRepaint");
	through("repaint");
	through("syncCamera");

	return {
		overlay: o,
		trace,
		canvas: canvasLog,
		layout(w, h) {
			scrollDOM.clientWidth = w;
			scrollDOM.clientHeight = h;
			scrollDOM.scrollWidth = w;
			scrollDOM.scrollHeight = Math.max(h, 6000);
			trace.push(`scroller ${w}x${h}`);
		},
		hostResized() {
			trace.push("ResizeObserver(host)");
			(o.handleResize as () => void)();
		},
		deliverPaintCallbacks() {
			const run = paintCallbacks.splice(0);
			for (const fn of run) {
				trace.push("rAF fires");
				fn();
			}
			return run.length;
		},
		committedSize: () => ({
			width: committedCanvas.width as number,
			height: committedCanvas.height as number,
		}),
		drawnSinceClear() {
			const ops = canvasLog.ops;
			let i = ops.length - 1;
			while (i >= 0 && !(ops[i] ?? "").startsWith("clearRect")) i--;
			return ops.slice(i + 1).length;
		},
		band: () => o.band as ReturnType<Rig["band"]>,
		blits: () => blitCount,
	};
}


function pendingLoad() {
	const path = "joined-load-" + (++nextPath) + ".md";
	let resolve!: (result: ParseResult | null) => void;
	const pending = new Promise<ParseResult | null>((done) => { resolve = done; });
	const host: InlineInkHost = {
		readPageId: () => "page-" + nextPath,
		claimId: async (_path, pageId) => ({ pageId }),
		loadSidecar: vi.fn(() => pending),
		scheduleSidecar: vi.fn(),
		notify: vi.fn(),
	};
	inlineInk.attachHost(host);
	const loaded = vi.spyOn(inlineInk, "ensureLoaded"); // calls through unchanged
	return {
		path, host, loaded,
		async finish() {
			const data = emptyPage("page-" + nextPath);
			data.surface = "inline";
			data.strokes = [stroke("saved", STROKE_AT)];
			resolve({ data, recovered: false });
			await Promise.all(loaded.mock.results.map((result) => result.value));
		},
	};
}

function openOverlay(path: string): Rig {
	const rig = makeRig(path);
	rig.layout(SCROLLER_W, SCROLLER_H);
	rig.hostResized();
	(rig.overlay.loadInk as (path: string) => void)(path);
	return rig;
}

afterEach(() => vi.restoreAllMocks());

describe("first paint while a shared sidecar read is pending", () => {
	it.each(["background", "visible"])("paints the visible note with an unselected same-note tab when the %s viewer starts the read", async (owner) => {
		const load = pendingLoad();
		const background = makeRig(load.path);
		background.hostResized();
		const visible = makeRig(load.path);
		visible.layout(SCROLLER_W, SCROLLER_H);
		visible.hostResized();
		const viewers = owner === "background" ? [background, visible] : [visible, background];
		for (const viewer of viewers) (viewer.overlay.loadInk as (path: string) => void)(load.path);
		await load.finish();
		background.deliverPaintCallbacks();
		visible.deliverPaintCallbacks();
		expect(background.committedSize()).toEqual({ width: 0, height: 0 });
		expect(visible.drawnSinceClear(), "the visible viewer must paint even when a zero-size background viewer owns the read").toBeGreaterThan(0);
		expect(load.host.loadSidecar).toHaveBeenCalledTimes(1);
		background.layout(SCROLLER_W, SCROLLER_H);
		background.hostResized();
		expect(background.drawnSinceClear(), "fronting the background tab restores its released canvas from cached ink").toBeGreaterThan(0);
		expect(load.host.loadSidecar).toHaveBeenCalledTimes(1);
	});
	it("paints a second editor when the read started by another consumer completes", async () => {
		const load = pendingLoad();
		void inlineInk.ensureLoaded(load.path);
		const rig = openOverlay(load.path);
		expect(rig.drawnSinceClear()).toBe(0);
		await load.finish();
		rig.deliverPaintCallbacks();
		expect(inlineInk.strokes(load.path)).toHaveLength(1);
		expect(load.host.loadSidecar).toHaveBeenCalledTimes(1);
		expect(rig.drawnSinceClear(), "saved ink reached the store but the joining editor never repainted").toBeGreaterThan(0);
	});

	it("paints the replacement editor when the original reader switches files before resolution", async () => {
		const load = pendingLoad();
		const original = openOverlay(load.path);
		original.overlay.filePath = () => "another-note.md";
		const replacement = openOverlay(load.path);
		await load.finish();
		original.deliverPaintCallbacks();
		replacement.deliverPaintCallbacks();
		expect(original.drawnSinceClear()).toBe(0);
		expect(replacement.drawnSinceClear(), "the original reader left and the replacement lost the load completion").toBeGreaterThan(0);
	});

	it("paints when the editor itself starts the read", async () => {
		const load = pendingLoad();
		const rig = openOverlay(load.path);
		await load.finish();
		rig.deliverPaintCallbacks();
		expect(rig.drawnSinceClear()).toBeGreaterThan(0);
	});

	it("paints a cached note on its initial resize without another sidecar read", async () => {
		const load = pendingLoad();
		void inlineInk.ensureLoaded(load.path);
		await load.finish();
		const rig = openOverlay(load.path);
		await Promise.all(load.loaded.mock.results.map((result) => result.value));
		rig.deliverPaintCallbacks();
		expect(rig.drawnSinceClear()).toBeGreaterThan(0);
		expect(load.host.loadSidecar).toHaveBeenCalledTimes(1);
	});

	it("a real size change can recover the loaded ink without starting another read", async () => {
		const load = pendingLoad();
		void inlineInk.ensureLoaded(load.path);
		const rig = openOverlay(load.path);
		await load.finish();
		rig.deliverPaintCallbacks();
		const before = rig.canvas.ops.length;
		rig.hostResized();
		expect(rig.canvas.ops.length).toBe(before); // unchanged dimensions do not force paint
		rig.layout(SCROLLER_W + 10, SCROLLER_H);
		rig.hostResized();
		expect(rig.canvas.ops.length).toBeGreaterThan(before);
		expect(rig.drawnSinceClear()).toBeGreaterThan(0);
		expect(load.host.loadSidecar).toHaveBeenCalledTimes(1);
	});

	it("scrolling the band away and back can recover the loaded ink", async () => {
		const load = pendingLoad();
		void inlineInk.ensureLoaded(load.path);
		const rig = openOverlay(load.path);
		await load.finish();
		rig.deliverPaintCallbacks();
		const view = rig.overlay.view as { scrollDOM: { scrollTop: number } };
		for (const top of [1000, 0]) {
			view.scrollDOM.scrollTop = top;
			(rig.overlay.scheduleRepaint as (via: string) => void)("scroll");
			rig.deliverPaintCallbacks();
			if (top === 1000) expect(rig.drawnSinceClear()).toBe(0);
		}
		expect(rig.drawnSinceClear()).toBeGreaterThan(0);
		expect(load.host.loadSidecar).toHaveBeenCalledTimes(1);
	});

	// A band move at rest slides the painted pixels and owes only the strips it uncovers. That is right only while the
	// raster holds what the store holds: ink that reached the store after the last paint, with no repaint asked for, is
	// on no pixel, and a slide would keep it missing until something repainted the whole band.
	const scrollBandTo = (rig: Rig, top: number) => {
		(rig.overlay.view as { scrollDOM: { scrollTop: number } }).scrollDOM.scrollTop = top;
		(rig.overlay.scheduleRepaint as (via: string) => void)("scroll");
		rig.deliverPaintCallbacks();
	};
	it("a band move carries the painted pixels when the raster holds the store's strokes (control: the carry path is reached)", async () => {
		const load = pendingLoad();
		void inlineInk.ensureLoaded(load.path);
		const rig = openOverlay(load.path);
		await load.finish();
		rig.deliverPaintCallbacks(); // the loaded ink is painted: raster and store agree
		scrollBandTo(rig, 1000);
		expect(rig.blits(), "the band moved and slid its pixels").toBeGreaterThan(0);
	});
	it("a band move does not carry when ink reached the store after the last paint", async () => {
		const load = pendingLoad();
		void inlineInk.ensureLoaded(load.path);
		const rig = openOverlay(load.path);
		rig.deliverPaintCallbacks(); // painted while the store was empty
		await load.finish(); // the store now holds a stroke no paint has seen
		scrollBandTo(rig, 1000);
		expect(rig.blits(), "a slide would have kept the loaded ink missing").toBe(0);
		expect(rig.band()!.top, "the band did move").toBeGreaterThan(0);
	});
	it("a partial paint does not stand in for the whole raster: ink that arrived unpainted stays owed to a band move", async () => {
		const load = pendingLoad();
		void inlineInk.ensureLoaded(load.path);
		const rig = openOverlay(load.path);
		await load.finish();
		rig.deliverPaintCallbacks(); // the saved stroke is painted: raster and store agree
		// A second stroke reaches the store with no repaint asked for (a shared load finishing after the first paint).
		inlineInk.applyAdd(load.path, [stroke("late", { x: 100, y: 500 })]);
		// Then the user draws one stroke: the frame repaints only that stroke's rect, and never reaches the late one.
		const drawn = stroke("drawn", { x: 400, y: 50 });
		inlineInk.applyAdd(load.path, [drawn]);
		(rig.overlay.damage as { addRect(r: { x: number; y: number; width: number; height: number }): void }).addRect(drawn.bbox);
		(rig.overlay.scheduleRepaint as (via: string) => void)("partial");
		rig.deliverPaintCallbacks();
		expect(inlineInk.strokes(load.path)).toHaveLength(3);
		scrollBandTo(rig, 1000);
		expect(rig.blits(), "a slide would have kept the late stroke missing: the partial paint must not record the store's count").toBe(0);
		expect(rig.band()!.top, "the band did move").toBeGreaterThan(0);
	});
});

describe("first paint while an external reload restores session ink", () => {
	it.each(["missing", "damaged"])("paints the restored ink for a joining editor after a %s read", async (failure) => {
		const load = pendingLoad();
		void inlineInk.ensureLoaded(load.path);
		await load.finish();
		let resolve!: (result: ParseResult | null) => void;
		const read = new Promise<ParseResult | null>((done) => { resolve = done; });
		vi.mocked(load.host.loadSidecar).mockImplementation(() => read);
		const reload = inlineInk.reloadExternal(load.path);
		const rig = openOverlay(load.path);
		expect(rig.drawnSinceClear()).toBe(0);
		const data = emptyPage("page-" + nextPath);
		data.surface = "inline";
		resolve(failure === "missing" ? null : { data, recovered: false, damaged: true });
		expect(await reload, "unchanged session ink must not force every existing viewer to redraw").toBe(false);
		await Promise.all(load.loaded.mock.results.map((result) => result.value));
		rig.deliverPaintCallbacks();
		expect(inlineInk.strokes(load.path).map((s) => s.id)).toEqual(["saved"]);
		expect(rig.drawnSinceClear(), "the reload restored ink but the joining editor missed that completion").toBeGreaterThan(0);
		expect(load.host.loadSidecar).toHaveBeenCalledTimes(2);
		expect(load.host.scheduleSidecar).not.toHaveBeenCalled();
	});
});
