/**
 * Headless reproduction of the first-paint report: "when i'm top left no ink
 * shows, then i have to scroll down to see ink, then scroll back up and ink
 * reappears" - traced on the REAL `handleResize`, `syncBand`, `scheduleRepaint`
 * and `repaint`, with nothing on that path replaced.
 *
 * THE HYPOTHESIS UNDER TEST. A note opened while its scroller measures 0x0
 * gets an empty band (`bandFor`, ScrollBand.ts:131). When the scroller then
 * gains size, the host `ResizeObserver` calls `handleResize`; the claim was
 * that it measures the still-0x0 container, takes its `unchanged` arm, and
 * schedules nothing - so the band stays empty until the first scroll.
 *
 * WHAT THIS RIG DOES AND DOES NOT REPLACE. `handleResize`, `syncBand`,
 * `scheduleRepaint`, `repaint` and `syncCamera` run off the prototype; the
 * instance wraps each one only to append its name to a trace and call
 * straight through. `DamageLedger`, `StrokeIndex`, `Camera`, `StrokeFrame`
 * and `bandFor` are the real classes. The container is a fake whose measured
 * rect and `offsetWidth`/`offsetHeight` FOLLOW the styles `syncBand` writes,
 * the way an absolutely positioned box follows its own width/height once
 * layout is forced by `getBoundingClientRect`. The canvases record every
 * backing-size assignment; the committed context records every `clearRect`
 * and every draw op with the canvas size at that moment - "what the committed
 * canvas holds" is read off that log. Own properties shadow only what needs
 * an editor or the file system and paints nothing: `filePath` (editor state),
 * `updateHandwritingPageClass` (DOM class toggle), `updateExtent` (the scroll
 * spacer), `repaintPath` (other panes). The load's resolution is modelled as
 * exactly what `loadInk`'s `.then` runs (InkOverlay.ts:1748-1753): the store
 * gains the strokes (`applyAdd`, which is what `adoptSidecar` does), then the
 * real `scheduleRepaint()` with its default via. `requestAnimationFrame` is a
 * queue the test flushes by hand, so the order of the load's frame against the
 * resize is the test's to choose.
 *
 * WHAT THE TRACE SHOWS is in each test's assertions, in the order it happens.
 */

import { describe, expect, it } from "vitest";

// The overlay reaches window through winRef; the node environment has none,
// so mirror the other InkOverlay suites before the module graph is pulled in.
(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { bandFor, emptyBand } from "./ScrollBand";
import { Camera } from "../camera/Camera";
import { StrokeFrame } from "./StrokeFrame";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DamageLedger } from "../ink/DamageLedger";
import { DEFAULT_PEN } from "../ink/PenStyle";
import type { InkStroke } from "../ink/Stroke";

const PATH = "first-paint.md";
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

function idsInStore(): string[] {
	return inlineInk.strokes(PATH).map((s) => s.id);
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
	/** `loadInk`'s `.then` body, after the sidecar's strokes reached the store. */
	loadResolved(strokes: InkStroke[]): void;
	/** Run every queued animation frame, in order, and say how many ran. */
	flushFrames(): number;
	/** The committed canvas's current backing size. */
	committedSize(): { width: number; height: number };
	/** Draw ops logged since the last clearRect, i.e. what the canvas holds now. */
	drawnSinceClear(): number;
	band(): { left: number; top: number; width: number; height: number } | null;
}

function makeRig(): Rig {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
 o.pinchScaleNow = 1;
	const trace: string[] = [];
	const canvasLog: CanvasLog = { sizes: [], ops: [] };

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
		} as unknown as CanvasRenderingContext2D;
	};

	// ---- animation frames, flushed by the test
	const frames: Array<() => void> = [];
	const win = {
		devicePixelRatio: 1,
		getComputedStyle: () => ({ fontSize: "16px", paddingTop: undefined, position: "relative" }),
		cancelAnimationFrame: () => undefined,
		clearTimeout: () => undefined,
		requestAnimationFrame: (fn: () => void) => {
			frames.push(fn);
			trace.push("rAF queued");
			return frames.length;
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
	};
	o.wet = layer;
	o.highlightWet = layer;
	o.tail = layer;
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
	o.filePath = () => PATH;
	o.updateHandwritingPageClass = () => undefined;
	o.updateExtent = () => undefined;
	o.repaintPath = () => undefined;

	// ---- traced, NOT replaced: each wrapper calls the prototype's method
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
			scrollDOM.scrollHeight = h;
			trace.push(`scroller ${w}x${h}`);
		},
		hostResized() {
			trace.push("ResizeObserver(host)");
			(o.handleResize as () => void)();
		},
		loadResolved(strokes) {
			inlineInk.applyAdd(PATH, strokes);
			trace.push(`load resolved (${strokes.length} strokes)`);
			(o.updateHandwritingPageClass as () => void)();
			(o.scheduleRepaint as () => void)();
		},
		flushFrames() {
			const run = frames.splice(0);
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
	};
}

describe("the band born empty under a 0x0 scroller", () => {
	it("mount at 0x0: the first handleResize writes an empty band and releases the canvases", () => {
		inlineInk.applyRemove(PATH, idsInStore());
		const rig = makeRig();

		// The constructor's own first call (InkOverlay.ts:1599), with the
		// leaf not yet laid out.
		rig.hostResized();

		expect(rig.band()).toEqual(emptyBand());
		expect(rig.trace).toEqual([
			"ResizeObserver(host)",
			"handleResize",
			"syncBand",
			"container.style 0x0",
			"  syncBand -> resized",
		]);
		// The zero-size arm: the 300x150 defaults are released, nothing is
		// scheduled, and nothing is drawn.
		expect(rig.committedSize()).toEqual({ width: 0, height: 0 });
		expect(rig.canvas.ops).toEqual([]);
	});

	it("a load resolving at 0x0 repaints into the empty band and draws nothing", () => {
		inlineInk.applyRemove(PATH, idsInStore());
		const rig = makeRig();
		rig.hostResized();
		rig.trace.length = 0;

		rig.loadResolved([stroke("s1", STROKE_AT)]);
		expect(rig.flushFrames()).toBe(1);

		// The frame runs the real repaint: dpr unchanged, syncBand finds the
		// empty band still right for the empty viewport, the world is cleared
		// and every stroke is culled by a 0-wide camera window.
		expect(rig.trace).toEqual([
			"load resolved (1 strokes)",
			"scheduleRepaint",
			"rAF queued",
			"rAF fires",
			"repaint",
			"syncBand",
			"  syncBand -> none",
			"syncCamera",
		]);
		expect(rig.band()).toEqual(emptyBand());
		expect(rig.canvas.ops).toEqual(["clearRect 0x0 @0x0"]);
		expect(rig.drawnSinceClear()).toBe(0);
		// And the damage the load asserted is now spent.
		expect((rig.overlay.damage as DamageLedger).isEmpty).toBe(true);
	});

	it("then the scroller gains size: handleResize resizes the band FIRST, reallocates, and paints the ink synchronously", () => {
		inlineInk.applyRemove(PATH, idsInStore());
		const rig = makeRig();
		rig.hostResized();
		rig.loadResolved([stroke("s1", STROKE_AT)]);
		rig.flushFrames();
		rig.trace.length = 0;
		rig.canvas.ops.length = 0;
		rig.canvas.sizes.length = 0;

		// Obsidian lays the leaf out; the host observer fires once.
		rig.layout(SCROLLER_W, SCROLLER_H);
		rig.hostResized();

		const want = bandFor({
			scrollLeft: 0,
			scrollTop: 0,
			clientWidth: SCROLLER_W,
			clientHeight: SCROLLER_H,
			scrollWidth: SCROLLER_W,
			scrollHeight: SCROLLER_H,
		});
		expect(rig.band()).toEqual(want);
		expect(want.width).toBe(SCROLLER_W);
		expect(want.height).toBeGreaterThan(SCROLLER_H);

		// The order that actually runs. `syncBand` is handleResize's first
		// statement (:2301), so the container is already the real band when
		// the rect is measured; the canvases (0x0) differ from the wanted
		// backing, so `unchanged` is false, the backings are reallocated, and
		// the in-task `repaint()` (:5470) paints the world.
		expect(rig.trace).toEqual([
			`scroller ${SCROLLER_W}x${SCROLLER_H}`,
			"ResizeObserver(host)",
			"handleResize",
			"syncBand",
			`container.style ${want.width}x${want.height}`,
			"  syncBand -> resized",
			"repaint",
			"syncBand",
			"  syncBand -> none",
			"syncCamera",
		]);
		expect(rig.canvas.sizes).toEqual([`width=${want.width}`, `height=${want.height}`]);
		expect(rig.committedSize()).toEqual({ width: want.width, height: want.height });
		// What the committed canvas holds: one clear at the band size, then
		// the stroke's draw ops on a sized canvas. No frame was queued.
		expect(rig.canvas.ops[0]).toBe(`clearRect ${want.width}x${want.height} @${want.width}x${want.height}`);
		expect(rig.drawnSinceClear()).toBeGreaterThan(0);
		expect(rig.trace).not.toContain("rAF queued");
		expect((rig.overlay.cssWidth as number)).toBe(want.width);
		expect((rig.overlay.cssHeight as number)).toBe(want.height);
	});

	it("the other order - size first, load after - also lands the ink, through the load's own frame", () => {
		inlineInk.applyRemove(PATH, idsInStore());
		const rig = makeRig();
		rig.hostResized();
		rig.layout(SCROLLER_W, SCROLLER_H);
		rig.hostResized();
		// Sized, painted, nothing to paint yet: the store is cold.
		expect(rig.drawnSinceClear()).toBe(0);
		expect(rig.committedSize().width).toBe(SCROLLER_W);
		rig.trace.length = 0;

		rig.loadResolved([stroke("s1", STROKE_AT)]);
		expect(rig.flushFrames()).toBe(1);

		// The default via asserts `damage.addAll()`, so the frame's repaint
		// finds "all" and draws even though the camera did not move.
		expect(rig.trace).toEqual([
			"load resolved (1 strokes)",
			"scheduleRepaint",
			"rAF queued",
			"rAF fires",
			"repaint",
			"syncBand",
			"  syncBand -> none",
			"syncCamera",
		]);
		expect(rig.drawnSinceClear()).toBeGreaterThan(0);
	});

	it("a load frame that fires after the resize repaints nothing and keeps the pixels", () => {
		inlineInk.applyRemove(PATH, idsInStore());
		const rig = makeRig();
		rig.hostResized();
		rig.loadResolved([stroke("s1", STROKE_AT)]);
		// The load's frame is still queued when the leaf lays out.
		rig.layout(SCROLLER_W, SCROLLER_H);
		rig.hostResized();
		const painted = rig.canvas.ops.length;
		expect(rig.drawnSinceClear()).toBeGreaterThan(0);

		expect(rig.flushFrames()).toBe(1);
		// Same camera, damage already spent by the synchronous repaint: the
		// frame does no work, and the committed canvas is not cleared.
		expect(rig.canvas.ops.length).toBe(painted);
		expect(rig.drawnSinceClear()).toBeGreaterThan(0);
	});
});
