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
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { TailRenderer } from "../ink/TailRenderer";
import { AttachedLayer } from "./InkOverlayAttachedLayer";

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
	/** With `sized`: the overlay's canvases, each with what its context saw. */
	canvases?: SizedCanvases;
}

/**
 * Options for a rig whose resize arm runs. Without `sized` the rig is the one the purge cells use, unchanged: its canvases
 * keep no context and its resize pass stops before the arm.
 */
export interface RigOptions {
	/** The window's device pixel ratio, so the backing scale is not 1. Default 1. */
	dpr?: number;
	/**
	 * Every canvas the overlay owns is a fake that keeps its own context, its listeners and its clones; wet, highlight wet and
	 * tail are the real renderers on them; the pinch scale is 1, so the resize pass at open runs the arm, as mount's does.
	 */
	sized?: boolean;
	/** With `sized`: an attached layer on fake canvases, its tile canvases kept in `tiles`. */
	attached?: boolean;
	/** With `sized`: the highlight pair left at 0x0, as mount leaves it for a note with no highlighter stroke. */
	highlightDeferred?: boolean;
}

/** One fake canvas and what its context saw. */
export interface FakeCanvas {
	readonly el: HTMLCanvasElement;
	/** Every setTransform its context took, in order. */
	readonly transforms: number[][];
	/** The horizontal scale in force at each drawing call. */
	readonly drawScales: number[];
	/** The horizontal scale in force at each clearRect: a clear in css px leans on it as a draw does. */
	readonly clearScales: number[];
	/** The source of each drawImage, in order: a copy from a kept picture, where a path draw makes none. */
	readonly images: unknown[];
	/** Whether anything was drawn since the backing was last blanked (a size write or a restore). */
	readonly painted: boolean;
	/** The browser gives the backing back blank: the context at its default state, no pixels, then `contextrestored`. */
	restore(): void;
	/** How many listeners it holds for `type`. */
	listeners(type: string): number;
}

export interface SizedCanvases {
	committed: FakeCanvas;
	highlight: FakeCanvas;
	highlightWet: FakeCanvas;
	wet: FakeCanvas;
	wetTile: FakeCanvas;
	tail: FakeCanvas;
	attachedPen: FakeCanvas | null;
	attachedHl: FakeCanvas | null;
	/** The attached layer's tile canvases, in the order it made them. */
	tiles: FakeCanvas[];
	/** Canvases made by cloning one of these (a stand-in copy, an extent raster layer). */
	clones: FakeCanvas[];
}

/**
 * A canvas whose 2d context keeps its transform as a browser does: a size write or a restore puts it back to the identity and
 * empties the save stack. Drawing calls note the scale in force; any other call is taken and does nothing.
 */
export function fakeCanvas(clones: FakeCanvas[], onDraw?: () => void): FakeCanvas {
	let w = 300;
	let h = 150;
	let m = [1, 0, 0, 1, 0, 0];
	let stack: number[][] = [];
	let painted = false;
	const transforms: number[][] = [];
	const drawScales: number[] = [];
	const clearScales: number[] = [];
	const images: unknown[] = [];
	const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
	const blank = (): void => {
		m = [1, 0, 0, 1, 0, 0];
		stack = [];
		painted = false;
	};
	const drew = (): void => {
		drawScales.push(m[0]!);
		painted = true;
		onDraw?.();
	};
	const methods: Record<string, (...a: number[]) => unknown> = {
		setTransform: (...a: number[]) => {
			m = a.slice(0, 6);
			transforms.push([...m]);
		},
		resetTransform: () => {
			m = [1, 0, 0, 1, 0, 0];
		},
		save: () => void stack.push([...m]),
		restore: () => {
			const top = stack.pop();
			if (top) m = top;
		},
		scale: (x: number, y: number) => {
			m = [m[0]! * x, m[1]! * x, m[2]! * y, m[3]! * y, m[4]!, m[5]!];
		},
		translate: (x: number, y: number) => {
			m = [m[0]!, m[1]!, m[2]!, m[3]!, m[4]! + m[0]! * x + m[2]! * y, m[5]! + m[1]! * x + m[3]! * y];
		},
		stroke: drew,
		fill: drew,
		fillRect: drew,
		strokeRect: drew,
		fillText: drew,
		drawImage: (...a: number[]) => {
			images.push(a[0]);
			drew();
		},
		putImageData: drew,
		clearRect: () => void clearScales.push(m[0]!),
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
		measureText: () => ({ width: 0 }),
		getContextAttributes: () => ({ desynchronized: false }),
		isContextLost: () => false,
	};
	const props: Record<string, unknown> = {};
	const el = {
		setCssStyles: () => undefined,
		remove: () => undefined,
		classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined },
		style: { removeProperty: () => undefined },
		addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
			let set = listeners.get(type);
			if (!set) listeners.set(type, (set = new Set()));
			set.add(fn);
		},
		removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => void listeners.get(type)?.delete(fn),
		// No layout in this rig: a box of no size, which the drag picture's window reads as "the canvas's own rows".
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
		cloneNode: () => {
			const c = fakeCanvas(clones);
			clones.push(c);
			return c.el;
		},
		getContext: () => ctx,
	} as Record<string, unknown>;
	const ctx = new Proxy(props, {
		get(target, key) {
			if (key === "canvas") return el;
			if (typeof key === "string" && key in methods) return methods[key];
			if (key in target) return target[key as string];
			return () => undefined;
		},
		set(target, key, value) {
			target[key as string] = value;
			return true;
		},
	});
	Object.defineProperties(el, {
		width: { get: () => w, set: (v: number) => { w = v; blank(); } },
		height: { get: () => h, set: (v: number) => { h = v; blank(); } },
	});
	return {
		el: el as unknown as HTMLCanvasElement,
		transforms,
		drawScales,
		clearScales,
		images,
		get painted() { return painted; },
		restore() {
			blank();
			const ev = new Event("contextrestored");
			for (const fn of [...(listeners.get("contextrestored") ?? [])]) {
				if (typeof fn === "function") fn(ev);
				else fn.handleEvent(ev);
			}
		},
		listeners: (type: string) => listeners.get(type)?.size ?? 0,
	};
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

function makeRig(path: string, hooks: RigHooks, opts: RigOptions = {}): RepaintRig {
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
		devicePixelRatio: opts.dpr ?? 1,
		getComputedStyle: () => ({ fontSize: "16px", paddingTop: undefined, position: "relative" }),
		cancelAnimationFrame: () => undefined,
		// Inert: the idle index rebuild never fires here, so a paint that leaves the index dirty has it rebuilt at the next read.
		setTimeout: () => 0,
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

	// ---- sized: the canvases mount makes, in mount's order, on fakes that keep their contexts
	let canvases: SizedCanvases | undefined;
	if (opts.sized) {
		const clones: FakeCanvas[] = [];
		const tiles: FakeCanvas[] = [];
		const committedDraw = (): void => {
			drawOps++;
			if (armed) {
				armed = false;
				hooks.onCommittedDraw();
			}
		};
		const highlight = fakeCanvas(clones, committedDraw);
		const highlightWet = fakeCanvas(clones);
		const attachedHl = opts.attached ? fakeCanvas(clones) : null;
		const committed = fakeCanvas(clones, committedDraw);
		const attachedPen = opts.attached ? fakeCanvas(clones) : null;
		const wet = fakeCanvas(clones);
		const wetTile = fakeCanvas(clones);
		const tail = fakeCanvas(clones);
		canvases = { committed, highlight, highlightWet, wet, wetTile, tail, attachedPen, attachedHl, tiles, clones };
		o.highlightCanvas = highlight.el;
		o.highlightWetCanvas = highlightWet.el;
		o.committedCanvas = committed.el;
		o.wetCanvas = wet.el;
		o.wetTileCanvas = wetTile.el;
		o.tailCanvas = tail.el;
		o.tailWashed = false;
		if (attachedPen && attachedHl) {
			o.attachedLayer = new AttachedLayer(attachedPen.el, attachedHl.el, () => {
				const t = fakeCanvas(clones);
				tiles.push(t);
				return t.el;
			});
		}
		o.committedCtx = committed.el.getContext("2d");
		o.highlightCtx = highlight.el.getContext("2d");
		const wetRenderer = new WetInkRenderer(wet.el, false);
		wetRenderer.smooth = true;
		wetRenderer.shape = true;
		const highlightWetRenderer = new WetInkRenderer(highlightWet.el, false);
		highlightWetRenderer.smooth = true;
		o.wet = wetRenderer;
		o.highlightWet = highlightWetRenderer;
		o.activeWet = wetRenderer;
		o.tail = new TailRenderer(tail.el);
		o.highlightPairDeferred = !!opts.highlightDeferred;
		if (opts.highlightDeferred) {
			for (const c of [highlight.el, highlightWet.el]) {
				c.width = 0;
				c.height = 0;
			}
			highlightWetRenderer.noteBackingCleared();
		}
		o.highlightBlank = true;
		o.wetDeferred = false;
		o.pinchScaleNow = 1;
		// Mount's step before its resize observers: the restore listeners, where the overlay has them.
		proto.watchBackingRestore?.call(o);
	}

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
		canvases,
	};
}

/**
 * A mounted overlay on a note carrying `strokeCount` real strokes, with the
 * sidecar read already resolved and the load's own paint delivered. The
 * strokes sit near the top-left of the note, inside the first band.
 */
export async function openRepaintRig(
	strokeCount: number,
	hooks: RigHooks,
	opts: RigOptions = {},
	/** Which of the strokes are highlighter strokes, by index. */
	highlighter: (i: number) => boolean = () => false
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
			data.strokes = Array.from({ length: strokeCount }, (_, i) => {
				const s = stroke("s" + i, { x: 100, y: 50 + i * 300 });
				return highlighter(i) ? { ...s, tool: "highlighter" as const } : s;
			});
			return { data, recovered: false };
		},
		scheduleSidecar: () => undefined,
		notify: () => undefined,
	};
	inlineInk.attachHost(host);
	const rig = makeRig(path, hooks, opts);
	(rig.overlay.loadInk as (p: string) => void)(path);
	await inlineInk.ensureLoaded(path);
	rig.deliverPaintCallbacks();
	return rig;
}
