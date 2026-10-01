/**
 * The document top settling under a stroke that has already been stored.
 *
 * THE REPORT (alan, relaying the owner, 1.4.11 from the store): brand new
 * vault, plugin just installed, note opened, and the first stroke drawn
 * immediately - "drew one stroke of an H, one of the strokes like didnt go
 * down right away, it teleported about an inch downwards, then i completed
 * the H, then i touched with eraser" and nothing erased, with no toast.
 *
 * WHAT A STORED STROKE'S POSITION ACTUALLY IS. Compose `syncCamera`
 * (InkOverlay.ts:2648) with `InlinePenRouter.sampleFrom` (:1957) and
 * `Camera.screenToWorld`, and the whole pipeline collapses to two terms:
 *
 *     world.x = (clientX - contentLeft) / scale
 *     world.y = (clientY - documentTop) / scale
 *
 * because the overlay's own rect appears once in the camera origin and once
 * in the sample and cancels. Ink is anchored to the TEXT COLUMN horizontally
 * and to the DOCUMENT TOP vertically, and to nothing else. The paint is the
 * same identity inverted (StrokeRenderer.ts:133-136, `(w - cam) * cam.zoom`
 * inside a container the camera origin was read from), so paint and store
 * agree exactly whenever they read the same camera - and disagree by exactly
 * the drift when they do not.
 *
 * THE X SIDE OF THIS IS ALREADY GUARDED. `contentLeft` has two compares that
 * exist purely to notice it moving without anything resizing:
 * `handleResize`'s unchanged arm (:2333) and `originLineResized` (:2489),
 * both against `lastSyncContentLeft`, both scheduling a repaint. That is the
 * Minimal column-origin work.
 *
 * THE Y SIDE HAD NOTHING, and that was the defect. `lastSyncDocumentTop` was
 * written by `syncCamera` and read only by the scroll probe, as a
 * diagnostic. Nothing compared it, so a document top that moves at a fixed
 * scroll position moved the camera the next time anything happened to sync
 * it - and repainted NOTHING, leaving the pixels at the old top. The three
 * ResizeObservers cannot cover the gap either: `.cm-content` moving down
 * because something ABOVE it in the scroller grew does not RESIZE
 * `.cm-content` (:1548), does not resize `.cm-editor` (:1542), and does not
 * resize the watched `.cm-line` (:1557). On a fresh mount that is not
 * hypothetical - `viewState.paddingTop` is 0 until CodeMirror's first
 * measure cycle (@codemirror/view, ViewState:5929/6065, and `documentTop` is
 * `contentDOM.getBoundingClientRect().top + viewState.paddingTop` at :8036),
 * and Obsidian's inline title, its properties block and any font swap all
 * live above `.cm-content` and settle on their own schedule.
 *
 * WHAT THESE TESTS PIN, in the order the owner met them:
 *
 *   1. the composition above, as an identity, through the real router
 *      mapping and the real `syncCamera`;
 *   2. THE TELEPORT - a stroke captured against the pre-settle document top
 *      is re-rasterized an inch lower the moment anything repaints;
 *   3. THE ERASER - with the same drift NOT yet repainted, a contact aimed
 *      at the ink the user can see probes an inch away from where the ink is
 *      stored, finds no hits, and returns having changed nothing, on a page
 *      whose store is not empty (so `penDown`'s empty-page toast, :2775, is
 *      not said either);
 *   4. that `handleResize` does not notice - it still does not, because the
 *      fix is not there and could not be: its callback is a ResizeObserver's
 *      and the failing case resizes nothing.
 *
 * AND WHAT THE FIX DOES, in the four that follow those. It is a compare in
 * `syncCamera` of the camera it just built against `lastPaintCam`, the one
 * the committed canvas was last drawn with, scheduling the repaint that
 * re-rasterizes when they differ. Against the CAMERA and not against the
 * document top, because `documentTop` is a screen coordinate that moves by
 * the whole delta on every scroll while the camera origin - that number
 * minus the band's own rect top, and the band scrolls with the text - does
 * not move at all. Test 7 is what holds that distinction.
 *
 *   5. the outcome - after a drift with nothing resizing, a contact where
 *      the raster is now showing the ink erases it;
 *   6. one repaint per drift, not one per sync;
 *   7. nothing at all for a sync where nothing moved, an ordinary scroll
 *      included;
 *   8. the SECOND teleport, which is a different defect on the same page:
 *      `handleResize` rewrote `cssScale` and re-based the router's rect
 *      mid-stroke, with no frame lock guard, so the rest of a letter jumped
 *      the moment anything resized under a planted pen.
 *
 * WHAT THEY DO NOT PIN. Which real-world thing moved the document top on the
 * owner's machine, or by how much. 96px is one inch and is used because that
 * is the number in the report; the mechanism is scale-free. Only hardware
 * can say whether it was the padding latch, the inline title, the properties
 * block or a font swap. Nor do they claim the ink returns to where it was
 * drawn: a stroke stored against a top that was wrong is wrong by that much
 * for good, and the heal makes the picture and the probe agree about where
 * it is, which is what stops the eraser missing it.
 */

import { describe, expect, it } from "vitest";

// The overlay reaches window through winRef; the node environment has none,
// so mirror the other InkOverlay suites before the module graph is pulled in.
(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { InlinePenRouter } from "./InlinePenRouter";
import { Camera } from "../camera/Camera";
// The renderer's own transform, not a copy of it: `rasterClient` below has to
// answer for a camera the overlay is no longer holding, which the Camera
// object cannot represent, and re-implementing the arithmetic would let a
// stale raster look correct because the test did the sum a second way.
import { worldToScreen } from "../camera/coordinates";
import { StrokeFrame } from "./StrokeFrame";
import { StrokeIndex } from "../ink/StrokeIndex";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { DEFAULT_PEN } from "../ink/PenStyle";
import type { InkStroke } from "../ink/Stroke";

const PATH = "note.md";

/** Where the overlay's band sits on screen, in client px. */
const OVERLAY_LEFT = 200;
const OVERLAY_TOP = 100;
const OVERLAY_W = 800;
const OVERLAY_H = 600;
/** The text column's left edge, from the one `.cm-line` in the viewport. */
const COLUMN_LEFT = 260;
/** `view.documentTop` before the page has finished settling. */
const DOC_TOP_EARLY = 40;
/**
 * `.cm-content`'s top padding: Minimal's `0.5em` at 16px, the number measured
 * on a real editor in `test/render/UnsettledTopMechanisms.test.ts`.
 */
const PADDING = 8;
/** One inch of drift, the number in the report. */
const INCH = 96;
/** Where the pen touched down, in client px. */
const PEN_CLIENT = { x: 400, y: 300 };
/** The eraser's world radius at scale 1; the default is 14 visual px. */
const ERASER_R = 14;

type Fields = Record<string, unknown>;

/**
 * A 2d context that records nothing. `drawStroke` runs for real on the
 * commit path, so every method it can reach has to exist; none of them is
 * what is under test.
 */
function fakeCtx(): CanvasRenderingContext2D {
	return {
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 0,
		lineCap: "",
		lineJoin: "",
		beginPath() {},
		moveTo() {},
		lineTo() {},
		quadraticCurveTo() {},
		bezierCurveTo() {},
		arc() {},
		ellipse() {},
		rect() {},
		closePath() {},
		fill() {},
		stroke() {},
		clip() {},
		save() {},
		restore() {},
		clearRect() {},
		setTransform() {},
	} as unknown as CanvasRenderingContext2D;
}

function el(extra: Fields = {}): Fields {
	return {
		setCssStyles: () => undefined,
		remove: () => undefined,
		classList: { add: () => undefined, remove: () => undefined },
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

interface Rig {
	/** The editor's document top, as the test moves it. */
	setDocumentTop(top: number): void;
	/** ...and what it is now, since `scrollBy` moves it too. */
	documentTop(): number;
	/**
	 * An ordinary SCROLL, which is the case that must cost nothing.
	 *
	 * It moves the document top - `documentTop` is a screen coordinate that
	 * CodeMirror documents as going negative when the editor is scrolled
	 * down - and it moves the ink band by the identical amount, because the
	 * band is a child of the scroller and scrolls with the text. So the two
	 * move together and the camera origin, which is their difference, does
	 * not move at all. That is the whole reason scrolling is free here, and
	 * it is why the drift compare is against the CAMERA and not against the
	 * document top on its own.
	 */
	scrollBy(delta: number): void;
	/**
	 * The overlay's VISUAL width, which is the numerator of the measured
	 * scale (`ZoomScale.effectiveScale`: visual rect over untransformed
	 * `offsetWidth`). Moving it is how a pinch or a window zoom reaches
	 * `handleResize`, and the layout box deliberately does not move with it.
	 */
	setVisualWidth(width: number): void;
	/** The real `syncCamera`, which is the one line `penDown` runs at contact. */
	syncCamera(): void;
	/** The real `handleResize`, the observer path that might have noticed. */
	handleResize(): void;
	/** `frame.begin()`: pen-down has happened and the stroke owns the frame. */
	beginStroke(): void;
	/** `frame.end()`: the gesture is over and the frame is live again. */
	endStroke(): void;
	/** How many times the (shadowed) repaint was asked for. */
	repaints(): number;
	/** The overlay itself, for the bounce cells that set its bounce fields directly. */
	raw(): Fields;
	/**
	 * The real `InlinePenRouter.sampleFrom` over the overlay's current box:
	 * how a client coordinate becomes the sample `penDown`/`penRaw` receive.
	 */
	sample(client: { x: number; y: number }): {
		x: number;
		y: number;
		pressure: number;
		timestamp: number;
		tiltX: number;
		tiltY: number;
	};
	/** Commit a contact at a client point through the real `penUp`. */
	draw(client: { x: number; y: number }): readonly InkStroke[];
	/** The real `eraseAt`, at a client point, through the real hit test. */
	eraseAt(client: { x: number; y: number }): void;
	/**
	 * Where a stored world point is PAINTED, in client px.
	 *
	 * `drawStroke` writes `(w - cam) * cam.zoom` into a canvas whose layout
	 * box is the container's, and the container is scaled by `cssScale`
	 * before it reaches the glass. Same arithmetic, through the real
	 * `Camera.worldToScreen`, so a camera the test never touched cannot be
	 * accidentally right here and wrong in the renderer.
	 */
	paintedClient(world: { x: number; y: number }): { x: number; y: number };
	/**
	 * Where the COMMITTED RASTER is currently showing a stored world point,
	 * in client px - which is the only thing the user can aim at.
	 *
	 * `paintedClient` above answers with the LIVE camera, and the live camera
	 * and the store can never disagree: that identity is the first test. The
	 * pixels on the glass are a different question. They were drawn once, by
	 * the commit (`InkOverlay.ts:3345-3352`, with `this.camera.snapshot`) or
	 * by the last repaint, and they stay exactly where that draw put them
	 * until something re-rasterizes them. So this reads the camera captured
	 * at the last of those, and it is what a contact aimed at visible ink
	 * has to be mapped through.
	 */
	rasterClient(world: { x: number; y: number }): { x: number; y: number };
	cameraY(): number;
	/**
	 * The world point `eraseAt` would probe for a client point: the real
	 * router sample through the real `Camera.screenToWorld`, which is
	 * verbatim what InkOverlay.ts:4154 does with the sample it is handed.
	 */
	probedWorld(client: { x: number; y: number }): { x: number; y: number };
	/**
	 * What `.cm-content`'s stylesheet says its top padding is, as a computed
	 * style value - `undefined` for "no style object held", which is what
	 * every test written before the padding fix gets and is why none of them
	 * changes behaviour.
	 *
	 * This is the DECLARATION. It is in force on the text from the moment the
	 * editor mounts, whatever CodeMirror currently believes.
	 */
	setDeclaredPadding(css: string | undefined): void;
	/**
	 * CodeMirror's first measure cycle: the belief becomes the declaration.
	 *
	 * `documentTop` moves by the difference, because it is
	 * `contentDOM.getBoundingClientRect().top + viewState.paddingTop` and only
	 * the second term changed - the content rect and every line in it stay
	 * exactly where they were. That is the whole distinction between this and
	 * `setDocumentTop`, which moves the rect term and therefore moves the text
	 * with it. Measured on a real editor in
	 * `test/render/UnsettledTopMechanisms.test.ts`.
	 */
	latchPadding(px: number): void;
}

function makeRig(): Rig {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
 o.pinchScaleNow = 1;

	let documentTop = DOC_TOP_EARLY;
	/** What CodeMirror believes `.cm-content`'s top padding is. 0 at mount. */
	let believedPadding = 0;
	/** What the stylesheet says it is. `undefined` = no style object held. */
	let declaredPadding: string | undefined = undefined;
	let repaints = 0;
	/**
	 * The camera the pixels currently on the committed canvas were drawn
	 * with. Latched by the commit and by every (shadowed) repaint, because
	 * those are the two things in the real overlay that put committed ink on
	 * a canvas. `null` until something has painted.
	 */
	let rasterCam: { x: number; y: number; zoom: number } | null = null;

	const overlayRect = {
		left: OVERLAY_LEFT,
		top: OVERLAY_TOP,
		width: OVERLAY_W,
		height: OVERLAY_H,
		right: OVERLAY_LEFT + OVERLAY_W,
		bottom: OVERLAY_TOP + OVERLAY_H,
	};
	const container = el({
		getBoundingClientRect: () => overlayRect,
		offsetWidth: OVERLAY_W,
		offsetHeight: OVERLAY_H,
	});

	const canvas = (): Fields => el({ width: 0, height: 0, getContext: () => null });
	const canvases = [canvas(), canvas(), canvas(), canvas(), canvas()];

	const scrollDOM = el({
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: OVERLAY_W,
		clientHeight: OVERLAY_H,
		scrollWidth: OVERLAY_W,
		scrollHeight: OVERLAY_H,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	});

	const contentHost = { fontSize: "16px" };
	const win = {
		devicePixelRatio: 1,
		getComputedStyle: () => ({
			get fontSize() {
				return contentHost.fontSize;
			},
			// Live, and `undefined` unless a test declares one: that is the
			// reading `anchorTop` treats as "cannot say", so every test here
			// that predates the padding fix keeps CodeMirror's own answer and
			// keeps its numbers.
			get paddingTop() {
				return declaredPadding;
			},
		}),
		cancelAnimationFrame: () => undefined,
		clearTimeout: () => undefined,
		requestAnimationFrame: () => 0,
	};

	o.view = {
		dom: el({ ownerDocument: { defaultView: win }, parentElement: null }),
		scrollDOM,
		contentDOM: el({
			children: [cmLine(COLUMN_LEFT)],
			// The RECT TERM of `documentTop`, derived rather than declared, so
			// the identity `documentTop = rect.top + believedPadding` holds in
			// this rig the way it holds in CodeMirror. `setDocumentTop` moves
			// this with the top (something above the content grew: the text
			// moves too); `latchPadding` leaves it exactly where it is (only
			// the belief changed: no text moves).
			getBoundingClientRect: () => ({
				left: OVERLAY_LEFT,
				top: documentTop - believedPadding,
				width: OVERLAY_W,
				height: 0,
				right: OVERLAY_LEFT + OVERLAY_W,
				bottom: documentTop - believedPadding,
			}),
		}),
		scaleX: 1,
		scaleY: 1,
		get documentTop() {
			return documentTop;
		},
	};

	// ---- camera and scale state, exactly as the field initializers leave it
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
	// Null on purpose: `watchOriginLine` returns before touching anything, so
	// the sync under test is the arithmetic and not the observer bookkeeping.
	o.originLineObserver = null;
	o.band = null;
	o.router = null;
	o.axisChecked = false;
	o.lastReach = null;
	o.resizeObserver = null;
	o.contentResizeObserver = null;

	// ---- canvases and layers
	o.committedCanvas = canvases[0];
	o.wetCanvas = canvases[1];
	o.tailCanvas = canvases[2];
	o.highlightCanvas = canvases[3];
	o.highlightWetCanvas = canvases[4];
	o.committedCtx = fakeCtx();
	o.highlightCtx = fakeCtx();
	const wetLayer = {
		applyDpr: () => undefined,
		clear: () => undefined,
		clearStroke: () => undefined,
		countPainted: () => 0,
	};
	o.wet = wetLayer;
	o.highlightWet = { ...wetLayer };
	o.activeWet = wetLayer;
	o.tail = {
		applyDpr: () => undefined, clear: () => undefined, clearAll: () => undefined,
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
	};

	// ---- gesture and erase state
	o.mode = "ink";
	o.builder = null;
	o.mouseStroke = false;
	o.strokePenGesture = false;
	o.strokeRawMax = 0;
	o.rawLastMoveT = 0;
	o.frameTicking = false;
	o.scrollsDuringStroke = 0;
	o.erased = [];
	o.erasePieces = new Set<string>();
	o.eraseFrom = [];
	o.eraseWhole = true;
	o.strokeIndex = new StrokeIndex();
	o.indexDirty = true;
	o.repaintQueued = false;
	o.lastPaintCam = null;
	o.damage = { addRect: () => undefined, addAll: () => undefined };
	o.eraserEl = null;
	o.mobileTools = null;
	o.viewportPan = { x: 0, y: 0 };
	o.previewInkOffset = 0;
	o.boundReadout = { floorX: 0, floorY: 0, bx: 0, width: 0, rawX: 0, cx: 0, rawY: 0, cy: 0,
		dragFrame: false, neverZoomed: false, steady: false, next: 0, fromScale: 0, fromScaleValid: false,
		restCeilX: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, bounded: false, settling: false };

	// Own properties, so the prototype's versions never run: each of these
	// reaches the editor, the strip, another pane or the file system, and
	// none of them is the subject here. `repaint` is COUNTED rather than run,
	// because a real repaint calls `syncCamera` - which is exactly the healing
	// the fourth test is asking whether anything performs.
	//
	// It also LATCHES the camera - twice, because a real repaint latches it
	// twice. `lastPaintCam` is the overlay's OWN record of what the committed
	// canvas was drawn with (InkOverlay.ts:5152-5166, where any camera motion
	// since it upgrades the frame to a full redraw), and the fix reads it;
	// `rasterCam` is this rig's copy of the same fact, for `rasterClient`.
	// Latched for `scheduleRepaint` too, at the moment of the request rather
	// than a frame later: there is no rAF here, and every caller under test
	// has already finished moving the camera before it asks.
	const paintNow = (): void => {
		repaints++;
		const cam = (o.camera as Camera).snapshot;
		o.lastPaintCam = { x: cam.x, y: cam.y, zoom: cam.zoom };
		rasterCam = { x: cam.x, y: cam.y, zoom: cam.zoom };
	};
	o.filePath = () => PATH;
	o.updateHandwritingPageClass = () => undefined;
	o.dispatchInk = () => undefined;
	o.repaintPath = () => undefined;
	o.updateExtent = () => undefined;
	o.recordCommitDiagnostics = () => undefined;
	o.scheduleRepaint = paintNow;
	o.repaint = paintNow;

	const proto = InkOverlayPlugin.prototype as unknown as {
		syncCamera(this: unknown): void;
		handleResize(this: unknown): void;
		penUp(this: unknown): void;
		eraseAt(this: unknown, sample: unknown): void;
	};

	// The real router mapping, off the prototype: no listeners, no window, no
	// editor - just `this.rect` and `this.scaleProvider`, which is the whole
	// of what `sampleFrom` reads.
	const routerRig = Object.create(InlinePenRouter.prototype) as Fields;
	routerRig.rect = overlayRect;
	routerRig.scaleProvider = () => o.cssScale as number;
	const sampleFrom = (
		InlinePenRouter.prototype as unknown as {
			sampleFrom(this: unknown, e: unknown): {
				x: number;
				y: number;
				pressure: number;
				timestamp: number;
				tiltX: number;
				tiltY: number;
			};
		}
	).sampleFrom;

	const sample = (client: { x: number; y: number }) =>
		sampleFrom.call(routerRig, {
			clientX: client.x,
			clientY: client.y,
			pressure: 0.5,
			pointerType: "pen",
			timeStamp: 0,
			tiltX: 0,
			tiltY: 0,
		});

	return {
		setDocumentTop(top) {
			documentTop = top;
		},
		documentTop: () => documentTop,
		setDeclaredPadding(css) {
			declaredPadding = css;
		},
		latchPadding(px) {
			documentTop += px - believedPadding;
			believedPadding = px;
		},
		scrollBy(delta) {
			// The content moves up by the delta...
			documentTop -= delta;
			// ...and so does the band, by exactly the same amount.
			overlayRect.top -= delta;
			overlayRect.bottom -= delta;
			scrollDOM.scrollTop = (scrollDOM.scrollTop as number) + delta;
		},
		setVisualWidth(width) {
			overlayRect.width = width;
			overlayRect.right = overlayRect.left + width;
		},
		syncCamera() {
			proto.syncCamera.call(o);
		},
		handleResize() {
			proto.handleResize.call(o);
		},
		beginStroke() {
			(o.frame as StrokeFrame).begin();
		},
		endStroke() {
			(o.frame as StrokeFrame).end();
		},
		repaints: () => repaints,
		raw: () => o,
		sample,
		draw(client) {
			const cam = o.camera as Camera;
			const before = new Set(inlineInk.strokes(PATH).map((k) => k.id));
			const builder = new StrokeBuilder("pen", DEFAULT_PEN.color, DEFAULT_PEN.baseWidth);
			builder.start(0);
			// A short horizontal run through the contact point, mapped exactly
			// as `penDown`/`penRaw` map it: sample first, then
			// `camera.screenToWorld` (InkOverlay.ts:2871, :2960).
			for (let i = 0; i < 6; i++) {
				const step = sample({ x: client.x + i * 2, y: client.y });
				const w = cam.screenToWorld(step.x, step.y);
				builder.add(w.x, w.y, 0.5, i * 8);
			}
			o.builder = builder;
			o.mode = "ink";
			// A lift, not a dwell: the shape-snap branch in `penUp` would
			// otherwise replace the stroke and move the coordinates under test.
			o.rawLastMoveT = performance.now();
			proto.penUp.call(o);
			// The commit painted the finished stroke onto the committed
			// canvas with `this.camera.snapshot` (InkOverlay.ts:3345-3352),
			// so THIS is the camera the pixels the user can see were drawn
			// with, until something re-rasterizes them.
			const snap = cam.snapshot;
			rasterCam = { x: snap.x, y: snap.y, zoom: snap.zoom };
			return inlineInk.strokes(PATH).filter((k) => !before.has(k.id));
		},
		eraseAt(client) {
			o.mode = "erase";
			proto.eraseAt.call(o, sample(client));
			o.mode = "ink";
		},
		paintedClient(world) {
			const cam = o.camera as Camera;
			const p = cam.worldToScreen(world.x, world.y);
			const s = o.cssScale as number;
			return { x: OVERLAY_LEFT + p.x * s, y: OVERLAY_TOP + p.y * s };
		},
		rasterClient(world) {
			if (!rasterCam) throw new Error("nothing has painted yet");
			// Same arithmetic as `paintedClient`, through the same real
			// `worldToScreen`, against the LATCHED camera instead of the live
			// one. The two answers are equal exactly while the raster is
			// fresh, and differ by the drift while it is stale.
			const p = worldToScreen(rasterCam, world.x, world.y);
			const s = o.cssScale as number;
			return { x: OVERLAY_LEFT + p.x * s, y: OVERLAY_TOP + p.y * s };
		},
		cameraY: () => (o.camera as Camera).y,
		probedWorld(client) {
			const s = sample(client);
			return (o.camera as Camera).screenToWorld(s.x, s.y);
		},
	};
}

function idsInStore(): string[] {
	return inlineInk.strokes(PATH).map((s) => s.id);
}

/** Session-memory mode (no host), so each test starts from a clean note. */
function clearNote(): void {
	inlineInk.applyRemove(PATH, idsInStore());
}

describe("a document top that settles after the ink was already stored", () => {
	it("anchors a stored stroke to the document top and nothing else", () => {
		clearNote();
		const rig = makeRig();
		rig.syncCamera();

		const drawn = rig.draw(PEN_CLIENT);
		expect(drawn).toHaveLength(1);
		const first = drawn[0]!.points[0]!;

		// The composition, as an identity: world y is the pen's client y
		// measured down from the document top, and world x is its client x
		// measured across from the text column. Both at scale 1.
		expect(first.y).toBeCloseTo(PEN_CLIENT.y - DOC_TOP_EARLY, 6);
		expect(first.x).toBeCloseTo(PEN_CLIENT.x - COLUMN_LEFT, 6);
		// And it paints back exactly under the pen, which is what the owner
		// saw while the stroke was wet.
		expect(rig.paintedClient(first).y).toBeCloseTo(PEN_CLIENT.y, 6);
		expect(rig.paintedClient(first).x).toBeCloseTo(PEN_CLIENT.x, 6);
	});

	it("teleports the committed stroke by the whole drift on the next repaint", () => {
		clearNote();
		const rig = makeRig();
		rig.syncCamera();
		const first = rig.draw(PEN_CLIENT)[0]!.points[0]!;
		expect(rig.paintedClient(first).y).toBeCloseTo(PEN_CLIENT.y, 6);

		// The page finishes settling: whatever sits above `.cm-content` in the
		// scroller has grown by an inch, so the document top is an inch lower
		// at the same scroll position. Nothing about the stored stroke changes.
		rig.setDocumentTop(DOC_TOP_EARLY + INCH);
		rig.syncCamera();

		// THE TELEPORT. Ink is anchored to the document top, and this stroke
		// was captured against the old one, so it is now an inch too far down
		// - "it teleported about an inch downwards", in the report's direction.
		expect(rig.paintedClient(first).y).toBeCloseTo(PEN_CLIENT.y + INCH, 6);
		// Horizontally untouched: the column did not move.
		expect(rig.paintedClient(first).x).toBeCloseTo(PEN_CLIENT.x, 6);
	});

	it("leaves the eraser probing an inch away from the ink on the glass", () => {
		clearNote();
		const rig = makeRig();
		rig.syncCamera();
		const drawn = rig.draw(PEN_CLIENT);
		expect(idsInStore()).toEqual([drawn[0]!.id]);

		// Precondition, so a later empty hit list cannot be blamed on the
		// index or the router: with paint and camera agreeing, a contact where
		// the ink is drawn erases it.
		const probe = makeRig();
		probe.syncCamera();
		probe.eraseAt(PEN_CLIENT);
		expect(idsInStore()).toEqual([]);

		// Now the real sequence. Redraw, then drift the document top WITHOUT
		// repainting - which is the state the overlay is actually left in,
		// since no observer watches for it (see the header).
		clearNote();
		const again = makeRig();
		again.syncCamera();
		const stroke = again.draw(PEN_CLIENT)[0]!;
		expect(idsInStore()).toEqual([stroke.id]);
		again.setDocumentTop(DOC_TOP_EARLY + INCH);

		// The committed raster on screen still shows the stroke at the camera
		// it was painted with, so the ink the owner can SEE is still here.
		const seenAt = PEN_CLIENT;

		// The eraser contact. `penDown` syncs the camera at the moment of
		// contact (InkOverlay.ts:2682) and `eraseAt` reads it three lines
		// later (:4154), so the probe uses the NEW document top while the
		// glass still shows the OLD one.
		again.syncCamera();
		again.eraseAt(seenAt);

		// Nothing erased. The store is untouched...
		expect(idsInStore()).toEqual([stroke.id]);
		// ...and it is NOT empty, so `penDown`'s empty-page toast (:2757-2776)
		// has nothing to say either. Silent, which is the half of the report
		// that ruled out every refusal the router can make.
		expect(inlineInk.strokes(PATH).length).toBeGreaterThan(0);

		// And the distance is the whole drift: the probe looked an inch above
		// the stored ink, against an eraser radius of 14.
		const probed = again.probedWorld(seenAt);
		expect(stroke.points[0]!.y - probed.y).toBeCloseTo(INCH, 6);
		// ...and only vertically: the column never moved, so the probe is
		// on the ink's own x. Nothing but the document top is in play.
		expect(probed.x).toBeCloseTo(stroke.points[0]!.x, 6);
		expect(INCH).toBeGreaterThan(ERASER_R);
	});

	it("is invisible to handleResize, so nothing heals it on its own", () => {
		clearNote();
		const rig = makeRig();
		// Settle everything: the first resize allocates the canvases and asks
		// for the sync repaint, so a second one with nothing changed takes the
		// `unchanged` arm (InkOverlay.ts:2310-2338).
		rig.handleResize();
		rig.syncCamera();
		const settledCameraY = rig.cameraY();
		const repaintsBefore = rig.repaints();

		// The ONLY thing that changes is the document top. Same pane, same
		// band, same font, same column - so no ResizeObserver has anything to
		// report and the unchanged arm's compare, which is against the column
		// LEFT alone, sees nothing.
		rig.setDocumentTop(DOC_TOP_EARLY + INCH);
		rig.handleResize();

		expect(rig.cameraY()).toBe(settledCameraY);
		expect(rig.repaints()).toBe(repaintsBefore);
	});

	// ---- the fix -----------------------------------------------------------
	//
	// `syncCamera` is where the compare went, and not the two places the
	// column-left compare lives. Both of those are behind a ResizeObserver,
	// and the failing case is a top that moves with NOTHING resizing: the
	// test above is the proof that `handleResize` is not reached, and it
	// still passes, unchanged, because the fix did not touch that arm.
	// `syncCamera` is the one function every path that could be first to
	// notice goes through - `repaint`, `originLineResized`,
	// `contentResizeObserver`, the reallocating arm of `handleResize`, and
	// pen-down's one sync.
	//
	// It compares the camera it just built against `lastPaintCam`, the camera
	// the committed canvas was last drawn with, and NOT `documentTop` against
	// the last one seen. That distinction is the difference between a fix and
	// a performance disaster, and the third test below is what holds it: the
	// document top is a screen coordinate and moves on every scroll, while
	// the camera origin is scroll-invariant by construction.

	it("erases the ink where the drift left it drawn, instead of nothing at all", () => {
		clearNote();
		const rig = makeRig();
		// A settled mount: the canvases are allocated and the note is painted
		// once, so there is a `lastPaintCam` - which is what "the pixels
		// currently on the glass" means. Two calls, because the shadowed
		// repaint does not sync the way the real one does; the real
		// `handleResize` reaches both through `repaint`.
		rig.handleResize();
		rig.syncCamera();
		const stroke = rig.draw(PEN_CLIENT)[0]!;
		expect(idsInStore()).toEqual([stroke.id]);
		// The commit painted it under the pen, which is the state the third
		// test starts from too.
		expect(rig.rasterClient(stroke.points[0]!).y).toBeCloseTo(PEN_CLIENT.y, 6);

		// The page settles an inch, with nothing resizing anywhere.
		rig.setDocumentTop(DOC_TOP_EARLY + INCH);
		// The next sync for any reason at all. In the reported sequence this
		// is pen-down's own (InkOverlay.ts:2682), the earliest one the
		// failing case gets - but a scroll, an edit or a reflow reaches the
		// same line, and whichever arrives first is the one that heals it.
		rig.syncCamera();

		// THE OUTCOME. A contact where the committed raster is NOW showing
		// the ink erases it. On the shipped code nothing re-rasterized, so
		// that point was still the pre-drift one and the probe landed an inch
		// above the stroke - the silent no-op in the report.
		rig.eraseAt(rig.rasterClient(stroke.points[0]!));
		expect(idsInStore()).toEqual([]);
	});

	it("asks for the repaint once per drift, not once per sync", () => {
		clearNote();
		const rig = makeRig();
		rig.handleResize();
		rig.syncCamera();
		const repaintsBefore = rig.repaints();

		rig.setDocumentTop(DOC_TOP_EARLY + INCH);
		rig.syncCamera();
		expect(rig.repaints()).toBe(repaintsBefore + 1);

		// The frame that request queues is what consumes it: it re-rasterizes
		// at the new camera and latches it, so the syncs that follow - and a
		// scroll produces one a frame, through `repaint` - find the pixels
		// already agreeing and cost the compare alone. This is the e-ink
		// guard: a re-raster is expensive enough that "repaint whenever the
		// camera is synced" would be worse than the defect.
		rig.syncCamera();
		rig.syncCamera();
		rig.syncCamera();
		expect(rig.repaints()).toBe(repaintsBefore + 1);
	});

	it("schedules nothing for a sync where nothing moved, a scroll included", () => {
		clearNote();
		const rig = makeRig();
		rig.handleResize();
		rig.syncCamera();
		const repaintsBefore = rig.repaints();
		const settledCameraY = rig.cameraY();

		// Ten syncs with everything where it was.
		for (let i = 0; i < 10; i++) rig.syncCamera();
		expect(rig.repaints()).toBe(repaintsBefore);

		// AND A SCROLL, which is the case that must stay free. `documentTop`
		// moves by the whole delta here - it is a screen coordinate, and
		// CodeMirror documents it as going negative when the editor is
		// scrolled down - so a compare against the LAST DOCUMENT TOP would
		// fire on every one of these, and with a via that asserts damage it
		// would re-rasterize every visible stroke and rebuild the index once
		// per scrolled frame, on a plugin that runs on e-ink. The band moved
		// with the text, so the camera did not move at all, and neither did
		// the request count.
		for (let i = 0; i < 10; i++) {
			rig.scrollBy(37);
			rig.syncCamera();
		}
		expect(rig.cameraY()).toBeCloseTo(settledCameraY, 6);
		expect(rig.repaints()).toBe(repaintsBefore);

		// The control, so "quiet" above means the compare found nothing
		// rather than that there is no compare: the same rig, one real drift.
		rig.setDocumentTop(rig.documentTop() + INCH);
		rig.syncCamera();
		expect(rig.repaints()).toBe(repaintsBefore + 1);
	});

	// ---- the second teleport, mid-stroke -----------------------------------

	it("does not re-scale a live stroke's samples when the editor resizes under it", () => {
		clearNote();
		const rig = makeRig();
		rig.handleResize();
		rig.syncCamera();

		// Pen-down: `penDown` syncs once and freezes the frame
		// (InkOverlay.ts:2682-2684). From here the camera belongs to the
		// stroke and every sample is inverted through it.
		rig.beginStroke();
		const first = rig.probedWorld(PEN_CLIENT);

		// The editor is scaled under the planted pen - a pinch settling, a
		// window zoom, the ios keyboard. `handleResize` is a ResizeObserver
		// callback and runs whether or not a stroke owns the frame.
		rig.setVisualWidth(OVERLAY_W * 1.5);
		rig.handleResize();

		// Every sample after this point is divided by `cssScale`
		// (`InlinePenRouter.sampleFrom`, through the overlay's own
		// `scaleProvider`) while the camera that inverts it stays frozen at
		// pen-down - a forward/inverse mismatch inside one stroke, which is
		// the shear `scrollFn` (:1606) and `syncBand` (:5264) both refuse to
		// cause. It draws as the rest of the stroke jumping toward the
		// top-left, mid-letter.
		const later = rig.probedWorld(PEN_CLIENT);
		expect(later.x).toBeCloseTo(first.x, 6);
		expect(later.y).toBeCloseTo(first.y, 6);

		// And the deferral is not a leak: the scale is measured afresh by the
		// next unlocked `syncCamera` (:2584, which reads it rather than
		// trusting what `handleResize` cached), so pen-up's repaint adopts it.
		rig.endStroke();
		rig.syncCamera();
		expect(rig.probedWorld(PEN_CLIENT).x).not.toBeCloseTo(first.x, 6);
	});

	// ---- storing against the real padding ----------------------------------
	//
	// The heal above makes the picture and the eraser agree about where a
	// stroke IS. It cannot make the stroke right: by the time it runs, the
	// wrong anchor is already inside the persisted coordinate. One of the two
	// mechanisms that move the document top is a store error of exactly that
	// kind, and it is knowable at store time.
	//
	// `documentTop` is `contentDOM.getBoundingClientRect().top +
	// viewState.paddingTop`, and the second term is a BELIEF - 0 from
	// construction until CodeMirror's first measure cycle. The CSS padding is
	// in force on the text the whole time, so in that window the reported top
	// is short by the padding while nothing has moved, and a stroke stored
	// there is stored that far off its line for good. `anchorTop`
	// (`DocumentTop.ts`) takes the padding from the computed style instead,
	// with CodeMirror's own `parseInt`/`scaleY` expression, so once the belief
	// is true the two answers are the same number and nothing changes.
	//
	// THE REAL MEASUREMENT IS `test/render/UnsettledTopMechanisms.test.ts`,
	// on a real `EditorView` in a real engine, because that is the only place
	// the belief and the declaration genuinely differ. These two are the
	// arithmetic pin: that the fix lands in `syncCamera`'s y term, and that it
	// changes only the padding term.

	it("stores a pre-measure stroke where a post-measure stroke of the same point goes", () => {
		clearNote();
		const rig = makeRig();
		// A fresh mount under Minimal: `.cm-content` has 8px of top padding
		// and CodeMirror has not measured it yet.
		rig.setDeclaredPadding(`${PADDING}px`);
		rig.handleResize();
		rig.syncCamera();
		const early = rig.draw(PEN_CLIENT)[0]!.points[0]!;

		// The measure cycle. The belief becomes the declaration; no text moves.
		rig.latchPadding(PADDING);
		rig.syncCamera();
		const late = rig.draw(PEN_CLIENT)[0]!.points[0]!;

		// THE OUTCOME. Same pen point, same stored coordinate, either side of
		// the cycle - so the first stroke sits at the same offset from its
		// line as the second.
		expect(early.y).toBeCloseTo(late.y, 6);
		// And the number is the pen measured down from where the text really
		// starts: the content rect plus the padding the stylesheet applies.
		expect(early.y).toBeCloseTo(PEN_CLIENT.y - (DOC_TOP_EARLY + PADDING), 6);
		// Horizontally untouched. The padding term is the y anchor's alone.
		expect(early.x).toBeCloseTo(PEN_CLIENT.x - COLUMN_LEFT, 6);
	});

	it("is the padding term alone: a top that moves with its text still moves nothing", () => {
		clearNote();
		const rig = makeRig();
		rig.setDeclaredPadding(`${PADDING}px`);
		rig.handleResize();
		// Settled: the belief is already true, so the fix is a no-op here and
		// this is the ordinary steady state.
		rig.latchPadding(PADDING);
		rig.syncCamera();
		const stroke = rig.draw(PEN_CLIENT)[0]!.points[0]!;
		expect(rig.paintedClient(stroke).y).toBeCloseTo(PEN_CLIENT.y, 6);

		// Something above `.cm-content` grows by an inch. The RECT term moves,
		// so `.cm-content` and every line in it move by the same inch - the
		// stroke is still on the line it was drawn on, and the camera must
		// follow the top exactly as it did before. A "fix" that also corrected
		// for this would leave the ink an inch above the words permanently;
		// mechanism R in the render suite is where that is measured.
		rig.setDocumentTop(rig.documentTop() + INCH);
		rig.syncCamera();
		expect(rig.paintedClient(stroke).y).toBeCloseTo(PEN_CLIENT.y + INCH, 6);

		// THE CONTROL, so the equality above is the fix declining to act and
		// not the fix being absent: with the padding unreadable the same rig
		// gives the same answer, and with the belief still 0 it does not.
		const blind = makeRig();
		blind.handleResize();
		blind.syncCamera();
		const shipped = blind.draw(PEN_CLIENT)[0]!.points[0]!;
		expect(shipped.y).toBeCloseTo(PEN_CLIENT.y - DOC_TOP_EARLY, 6);
		expect(stroke.y - shipped.y).toBeCloseTo(-PADDING, 6);
	});
});

// ---- a bounce off the page's edge ------------------------------------------
//
// ON ORION every frame of an edge bounce re-rastered all the committed ink (the
// scroll probe of 2026-09-29: sched runs via "scroll" 3.4 to 5.3 ms before each
// repaint, camera unchanged to 0.01 px). The compare at the end of `syncCamera`
// is exact, and during a bounce the camera is built from rects that ride the
// bounce translate plus a pan that carries the same offset: the two cancel on
// paper and not bit for bit, so every repaint's own sync queued the next one.
// The cure: while a bounce lives, the camera still syncs but asks for no
// repaint; the bounce's last frame syncs once, and that sync asks for the one
// repaint a real move owes.
describe("a bounce off the page's edge", () => {
	/** A clock and a frame queue the bounce runs on, in place of the window's. */
	function bounceClock(o: Fields) {
		let now = 1000;
		const queue: ((t: number) => void)[] = [];
		// An own property over the prototype's getter, which reads the editor's window.
		Object.defineProperty(o, "winRef", { configurable: true, value: {
			performance: { now: () => now },
			requestAnimationFrame: (cb: (t: number) => void) => { queue.push(cb); return queue.length; },
			cancelAnimationFrame: () => undefined,
		} });
		o.bounceOffset = { x: 0, y: 0 };
		o.bounceState = null;
		o.beginPreviewPaper = () => undefined;
		o.endPreviewPaper = () => undefined;
		o.writeViewportPan = () => undefined;
		return {
			/** Run one frame `dt` ms on; false when no frame was queued. */
			frame(dt = 16): boolean {
				const cb = queue.shift();
				if (!cb) return false;
				now += dt;
				cb(now);
				return true;
			},
		};
	}
	/** Every repaint request's via, in order, in place of the rig's counter. */
	function recordVias(o: Fields): string[] {
		const vias: string[] = [];
		const paint = o.repaint as () => void;
		o.scheduleRepaint = (via?: string) => { vias.push(via ?? "other"); paint(); };
		return vias;
	}
	const proto = InkOverlayPlugin.prototype as unknown as {
		startOverscrollBounce(this: unknown, hold: object, dx: number, dy: number): boolean;
		syncCamera(this: unknown): void;
	};

	it("asks for no repaint while a bounce lives, when the camera is a hair off the one last painted", () => {
		clearNote();
		const rig = makeRig();
		rig.handleResize();
		rig.syncCamera();
		const o = rig.raw();
		const vias = recordVias(o);
		const cam = (o.camera as Camera).snapshot;
		// A bounce is live, and the camera last painted differs from this one by rounding noise alone.
		o.bounceState = { hold: {}, fromX: 20, fromY: 0, startedAt: 0, raf: 0 };
		o.lastPaintCam = { x: cam.x + 1e-9, y: cam.y, zoom: cam.zoom };
		rig.syncCamera();
		expect(vias, "a bounce frame's sync queued a repaint").toEqual([]);
		// The camera itself still syncs: a real move during the bounce lands on it.
		rig.setDocumentTop(rig.documentTop() + INCH);
		rig.syncCamera();
		expect(vias, "a bounce frame's sync queued a repaint").toEqual([]);
		expect(rig.cameraY(), "the camera stopped syncing during the bounce").toBeCloseTo(cam.y - INCH, 6);
	});

	it("asks for exactly one repaint when the bounce ends with the camera moved since the last paint", () => {
		clearNote();
		const rig = makeRig();
		rig.handleResize();
		rig.syncCamera();
		const o = rig.raw();
		const clock = bounceClock(o);
		const vias = recordVias(o);
		expect(proto.startOverscrollBounce.call(o, {}, 20, 0), "premise: the bounce started").toBe(true);
		// Mid-bounce, the painted camera falls a px behind the live one.
		clock.frame();
		const painted = o.lastPaintCam as { x: number; y: number; zoom: number };
		o.lastPaintCam = { x: painted.x - 1, y: painted.y, zoom: painted.zoom };
		let frames = 1;
		while (o.bounceState !== null && clock.frame()) frames++;
		expect(o.bounceState, `premise: the bounce ended (${frames} frames)`).toBeNull();
		expect(vias, "the bounce's end did not ask once for the repaint the moved camera owes").toEqual(["scroll"]);
	});

	it("asks for nothing at the bounce's end when the camera did not move", () => {
		clearNote();
		const rig = makeRig();
		rig.handleResize();
		rig.syncCamera();
		const o = rig.raw();
		const clock = bounceClock(o);
		const vias = recordVias(o);
		expect(proto.startOverscrollBounce.call(o, {}, 20, 0), "premise: the bounce started").toBe(true);
		while (o.bounceState !== null && clock.frame()) { /* run it out */ }
		expect(o.bounceState, "premise: the bounce ended").toBeNull();
		expect(vias, "a still camera asked for a repaint at the bounce's end").toEqual([]);
	});
});
