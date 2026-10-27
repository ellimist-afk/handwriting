/**
 * A REAL `InkOverlay` driven through ONE REAL `repaint`, for claims that must
 * be executed rather than read as text.
 *
 * A source assertion is a spelling test: it proves a line is typed the way
 * someone typed it, never that the code does what the line was written for.
 * Claims about what one repaint does (what it draws, what it asks, what it
 * reads back) were pinned by reading `InkOverlay.ts` because nothing could
 * instantiate an overlay that far. This rig closes that gap. It was written on
 * the 1.5.0 line and ported to the 1.4.24 base as its own commit, so both lines
 * carry the same rig. It is derived from `FirstPaintSharedLoad.test.ts`'s
 * `makeRig` - the same construction through `inlineInk`, the same real
 * `loadInk`, `handleResize`, `syncBand`, `syncCamera` and drawing methods,
 * with only the file read, the editor DOM, the canvas contexts and unrelated
 * UI hooks faked - trimmed to what a repaint needs and given two hooks a test
 * can hang a scripted clock on:
 *
 *   - `onCommittedDraw` fires ONCE per repaint, on the first drawing call that
 *     lands on a committed context. Every such call is inside the bracket, so
 *     a test that advances the clock there advances it during the DRAW.
 *   - `onPostDraw` fires from the diagnostics-only work that shares the
 *     drawing branch (`countVisible`) and from the chrome after it
 *     (`redrawSelectionUI`) - both strictly AFTER the end points. A test that
 *     advances the clock by a different amount there gets a recorded `drawMs`
 *     that names which bracket ran.
 *
 * `FirstPaintSharedLoad.test.ts` is deliberately NOT edited to grow these
 * hooks: it is the release line's file, it keeps changing there, and
 * refactoring it here would buy a conflict at the next merge-up for nothing.
 *
 * Not a test file (no `.test.` in the name), so vitest does not collect it and
 * importing it cannot register another file's cases twice. Nothing that ships
 * imports this module.
 */

import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { emptyPage, type ParseResult } from "../model/PageData";
import { Camera } from "../camera/Camera";
import { StrokeFrame } from "./StrokeFrame";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DamageLedger } from "../ink/DamageLedger";
import { DEFAULT_PEN } from "../ink/PenStyle";
import type { BBox, InkStroke } from "../ink/Stroke";

let nextPath = 0;

/** The scroller once Obsidian has laid the leaf out. */
const SCROLLER_W = 900;
const SCROLLER_H = 800;
/** Where the text column sits, for the origin scan. */
const COLUMN_LEFT = 60;

type Fields = Record<string, unknown>;

export interface RigHooks {
	/**
	 * Once per repaint, at the first drawing call on a committed context -
	 * i.e. inside the bracket, whichever branch is drawing.
	 */
	onCommittedDraw(): void;
	/** The diagnostics-only work and the chrome that follow the end points. */
	onPostDraw(): void;
}

export interface RepaintRig {
	/** The overlay itself, for the fields a test has to arrange. */
	overlay: Fields;
	/** Mark the whole world dirty, so the next repaint takes the full path. */
	damageAll(): void;
	/** Mark one world rect dirty, so the next repaint takes the partial path. */
	damageRect(rect: BBox): void;
	/** Move the scroller, so the next repaint's `syncBand` reports a move. */
	scrollTo(top: number): void;
	/** Run ONE real repaint; returns the drawing calls it put on the committed context. */
	repaintNow(): number;
	/** Deliver captured rAF callbacks synchronously and report their count. */
	deliverPaintCallbacks(): number;
}

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

function makeRig(path: string, hooks: RigHooks): RepaintRig {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	const proto = InkOverlayPlugin.prototype as unknown as Record<
		string,
		(...a: unknown[]) => unknown
	>;

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

	// ---- the band container: measured size is whatever `syncBand` last wrote
	const containerStyle = { left: 0, top: 0, width: 0, height: 0 };
	const container = el({
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
	// Accessors, defined after `el()`: a spread would copy their values once.
	Object.defineProperties(container, {
		offsetWidth: { get: () => containerStyle.width },
		offsetHeight: { get: () => containerStyle.height },
	});

	// ---- canvases: a fresh <canvas> is 300x150 until something sizes it.
	const canvas = (): Fields => {
		let w = 300;
		let h = 150;
		const c = el({ getContext: () => null });
		Object.defineProperties(c, {
			width: { get: () => w, set: (v: number) => { w = v; } },
			height: { get: () => h, set: (v: number) => { h = v; } },
		});
		return c;
	};
	const committedCanvas = canvas();
	const highlightCanvas = canvas();

	// ---- the drawing record and the clock hook
	let drawOps = 0;
	let armed = false;
	/**
	 * A 2d context that counts DRAWING calls (`stroke`, `fill`, `drawImage`)
	 * and nothing else - a `clearRect` happens on an empty page too, and the
	 * vacuity check exists to tell those apart.
	 */
	const recordingCtx = (): CanvasRenderingContext2D => {
		const drew = () => {
			drawOps++;
			if (armed) {
				armed = false;
				hooks.onCommittedDraw();
			}
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
			fill: drew,
			stroke: drew,
			drawImage: drew,
			clip() {},
			save() {},
			restore() {},
			clearRect() {},
			setTransform() {},
			getImageData: () => ({ data: new Uint8ClampedArray(4) }),
			fillRect() {},
		} as unknown as CanvasRenderingContext2D;
	};

	// ---- the scheduling boundary: no frame runs on its own in this rig
	const paintCallbacks: Array<() => void> = [];
	const win = {
		devicePixelRatio: 1,
		getComputedStyle: () => ({ fontSize: "16px", paddingTop: undefined, position: "relative" }),
		cancelAnimationFrame: () => undefined,
		clearTimeout: () => undefined,
		requestAnimationFrame: (fn: () => void) => {
			paintCallbacks.push(fn);
			return paintCallbacks.length;
		},
	};

	o.view = {
		dom: el({ ownerDocument: { defaultView: win }, parentElement: null }),
		scrollDOM,
		contentDOM: el({
			children: [cmLine(COLUMN_LEFT)],
			closest: () => null,
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

	// ---- state, as the field initializers leave it. `Object.create` runs
	// none of them, so every field `repaint` reads is set here by hand -
	// including the four the first-paint rig never needed because it never
	// reached the diagnostics record (`lastSyncRectLeft`, `lastSyncRectTop`,
	// `repaintVia`, `rasterBacking`).
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
	o.rasterBacking = 1;
	o.lastGoodColumnLeft = null;
	o.lastSyncContentLeft = 0;
	o.lastSyncDocumentTop = 0;
	o.lastSyncRectLeft = 0;
	o.lastSyncRectTop = 0;
	o.originLine = null;
	o.originLineObserver = null;
	o.band = null;
	o.router = null;
	o.createArm = { isArmed: false };
	o.armListeners = [];
	o.axisChecked = false;
	o.lastReach = null;
	o.resizeObserver = null;
	o.contentResizeObserver = null;
	o.committedCanvas = committedCanvas;
	o.wetCanvas = canvas();
	o.tailCanvas = canvas();
	o.highlightCanvas = highlightCanvas;
	o.highlightWetCanvas = canvas();
	o.committedCtx = recordingCtx();
	o.highlightCtx = recordingCtx();
	const layer = { applyDpr: () => undefined, clear: () => undefined, clearAll: () => undefined };
	o.wet = layer;
	o.highlightWet = layer;
	o.tail = layer;
	o.mode = "ink";
	o.builder = null;
	o.strokeIndex = new StrokeIndex();
	o.indexDirty = true;
	o.repaintQueued = false;
	o.repaintScrollOnly = false;
	o.repaintVia = "scroll";
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
	o.refreshBoxStyle = () => undefined;
	o.inkLoadedPath = null;

	// ---- the two post-draw hooks.
	// `countVisible` calls through to the real one, so `rasterized` still
	// means what it means; `redrawSelectionUI` needs the editor DOM and is
	// replaced outright - the point here is only that it runs after the end.
	o.countVisible = function (this: unknown, ...args: unknown[]) {
		hooks.onPostDraw();
		return proto.countVisible!.apply(this, args);
	};
	o.redrawSelectionUI = function () {
		hooks.onPostDraw();
	};

	const layout = (w: number, h: number): void => {
		scrollDOM.clientWidth = w;
		scrollDOM.clientHeight = h;
		scrollDOM.scrollWidth = w;
		scrollDOM.scrollHeight = Math.max(h, 6000);
	};
	layout(SCROLLER_W, SCROLLER_H);
	(proto.handleResize as () => void).call(o);

	return {
		overlay: o,
		damageAll: () => (o.damage as DamageLedger).addAll(),
		damageRect: (rect) => (o.damage as DamageLedger).addRect(rect),
		scrollTo: (top) => {
			scrollDOM.scrollTop = top;
		},
		repaintNow() {
			drawOps = 0;
			armed = true;
			(proto.repaint as () => void).call(o);
			return drawOps;
		},
		deliverPaintCallbacks() {
			const run = paintCallbacks.splice(0);
			for (const fn of run) fn();
			return run.length;
		},
	};
}

/**
 * A mounted overlay on a note carrying `strokeCount` real strokes, with the
 * sidecar read already resolved and the load's own paint delivered. The
 * strokes sit near the top-left of the note, inside the first band.
 */
export async function openRepaintRig(
	strokeCount: number,
	hooks: RigHooks
): Promise<RepaintRig> {
	const path = "drawms-" + ++nextPath + ".md";
	const pageId = "page-" + nextPath;
	const host: InlineInkHost = {
		readPageId: () => pageId,
		claimId: async (_path, id) => ({ pageId: id }),
		loadSidecar: async (): Promise<ParseResult | null> => {
			const data = emptyPage(pageId);
			data.surface = "inline";
			// Spread down the page, so a band move of a few hundred px still
			// has ink to draw and a scrolled repaint is not silently empty.
			data.strokes = Array.from({ length: strokeCount }, (_, i) =>
				stroke("s" + i, { x: 100, y: 50 + i * 300 })
			);
			return { data, recovered: false };
		},
		scheduleSidecar: () => undefined,
		notify: () => undefined,
	};
	inlineInk.attachHost(host);
	const rig = makeRig(path, hooks);
	(rig.overlay.loadInk as (p: string) => void)(path);
	await inlineInk.ensureLoaded(path);
	rig.deliverPaintCallbacks();
	return rig;
}
