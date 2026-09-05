/**
 * Pane-width geometry probe (1.4.9 investigation, attempt five).
 *
 * The reported symptom is "the writing doesn't stay in place if you change
 * page side". Alan, first-hand, could NOT reproduce it: "ink didnt detach
 * when i toggled left sidebar".
 *
 * THAT NEGATIVE IS SOURCED, and so is the mobile-only framing - it came from
 * the 1.5.0 session, Alan first-hand. What has never been checked is its
 * BASIS, and it does not survive contact with the reporter: his own
 * screenshots show DESKTOP chrome - a left file-explorer tree with folder
 * names visible beside the note pane - so scoping to a platform is an
 * inference, and the wrong one.
 *
 * THE SHARPER TRIGGER, and where attempt six should start: whether the
 * COLUMN's width changes, not which device it is on. Ink is anchored to the
 * note surface and text re-wraps when the column width changes. Obsidian
 * caps the column at `--file-line-width`, so on a wide window a sidebar
 * toggle only re-CENTRES it - no re-wrap, no detach, which is exactly what
 * Alan measured. Narrow the window until the column IS the pane, or turn
 * readable line length off, and the same toggle re-wraps the text and the
 * ink detaches - desktop included. That explains his negative without
 * needing anyone to be on a phone, and it survives the reporter's
 * screenshots. The one-minute check is readable line length OFF, then
 * toggle the sidebar.
 *
 * AND THE TRIGGER IS NOT ON THIS LINE AT ALL. The 1.5.0 architect diagnosed
 * the detach on Alan's Surface and it needs a PINNED COLUMN to exist: the
 * boxed rule sets `width: var(--handwriting-box-w)` on `.cm-sizer`, a flex
 * child of CodeMirror's scroller with no `flex-shrink: 0`, so the variable
 * said 700px while the element rendered 659; and `handleResize` re-read the
 * pane width without re-placing the column, freezing the margin at the width
 * it was first styled in. Fixed on 1.5.0 at 9142449.
 *
 * `.cm-sizer` appears NOWHERE in 1.4.x - no pinned column, no
 * `--handwriting-box-w` - verified by grep across src and styles.css. So
 * every test here passes because there is nothing on this line to fail, and
 * a sixth attempt against 1.4.x would be hunting a mechanism that does not
 * exist here. If a 1.4.x user still reports detachment, it is the re-wrap
 * case above and a DIFFERENT defect from the one Alan saw.
 *
 * The paint reduces to
 *
 *     screen_x = contentLeft + x * scale
 *
 * so only a wrong `scale` or a wrong `contentLeft` can separate ink from the
 * text it was written over. `scale = cssScale * fontZoom`; the fontZoom half
 * is pinned by RemountFontRef.test.ts. This file is the cssScale/contentLeft
 * half, driven by the ONE trigger that is known to reproduce: a change in the
 * note pane's width.
 *
 * WHAT IS UNDER TEST IS THE REAL CODE. `syncBand`, `handleResize` and
 * `syncCamera` are called off the prototype against a DOM model in which the
 * container's box is whatever `syncBand` actually wrote, exactly as it is in
 * an editor - that feedback loop is the whole point, because `cssScale` is
 * the ratio of two reads of that same element.
 *
 * Every test here PASSES. What that means is NARROWER than this header used
 * to claim, and the difference is the whole lesson of 2026-09-03.
 *
 * It used to say: "on this path the scale and the origin are re-derived from
 * the DOM on every pane-width change, and none of the four questions the
 * dispatch asked turns up a live defect." The second half was FALSE. There
 * was a live defect, it was the reported one, and this file could not see it
 * - because every test here calls `syncBand`, `handleResize` and `syncCamera`
 * OFF THE PROTOTYPE, by hand. They prove the MATH is right once syncCamera
 * runs. They cannot prove syncCamera RUNS, and that was the bug: the
 * ResizeObserver watched `.cm-editor` only, whose box does not move when
 * Obsidian's Readable line length toggles, so nothing fired, `cam.x` kept its
 * pre-toggle value and the paint anchored to a stale content origin. Fixed at
 * a8209dc by observing `.cm-content` as well; the wiring is pinned by
 * ContentResizeObserved.test.ts, because `mount()` is too heavy to fixture -
 * the judgment PenToolsEscapeHatch.test.ts and PenContactRouting.test.ts both
 * reached independently.
 *
 * The first half stands, and so does the trigger this header named before
 * anyone confirmed it: "The one-minute check is readable line length OFF,
 * then toggle the sidebar." That is EXACTLY the recipe Alan reproduced on
 * 2026-09-03, and the sourced negative above ("ink didnt detach when i
 * toggled left sidebar") is superseded rather than wrong - the sidebar alone
 * re-centres and self-corrects; it is the TOGGLE that strands the camera.
 *
 * So the standing finding is: the reduced law holds, and the origin is
 * correctly re-derived WHEN ASKED. Whether anything asks is a wiring
 * question and lives in another file. A geometry suite that drives its own
 * callbacks can never answer it, and naming one as though it could is what
 * kept a green test over a live bug.
 */

import { describe, expect, it } from "vitest";

// The overlay reaches for window's timers through winRef; the node test
// environment has no window, so mirror the persistence suites' shim before
// the module graph is pulled in.
(globalThis as { window?: unknown }).window = globalThis;

import { Camera } from "../camera/Camera";
import { InkOverlayPlugin } from "./InkOverlay";
import { bandFor, bandMargin } from "./ScrollBand";

type Fields = Record<string, unknown>;

function el(extra: Fields = {}): Fields {
	return {
		setCssStyles: () => undefined,
		remove: () => undefined,
		classList: { add: () => undefined, remove: () => undefined },
		style: { removeProperty: () => undefined },
		...extra,
	};
}

/** Obsidian's readable-line-length cap, in layout px. */
const FILE_LINE_WIDTH = 700;

interface PaneState {
	/** `.cm-scroller` clientWidth: the note pane's inner width, layout px. */
	paneWidth: number;
	paneHeight: number;
	/** Where the pane's own box starts on screen, visual px. */
	paneScreenLeft: number;
	/** `scrollWidth`, which the extent spacer can push past `paneWidth`. */
	scrollWidth: number;
	scrollLeft: number;
	scrollTop: number;
	scrollHeight: number;
	/** A CSS transform on `.cm-editor` (the plugin's own pinch zoom). */
	transform: number;
	/** Readable line length on, as Obsidian ships it. */
	readableLineLength: boolean;
}

interface Band {
	left: number;
	top: number;
	width: number;
	height: number;
}

interface Rig {
	pane: PaneState;
	/** Device pixel ratio, read through winRef exactly as the overlay does. */
	setDpr(dpr: number): void;
	/**
	 * Obsidian's editor font size. Changes the resolved `font-size` on the
	 * ONE computed-style object the overlay caches, which is how a browser
	 * delivers it, and does NOT resize `.cm-editor` - matching the DOM
	 * consequence that makes this interesting: only the content observer
	 * fires, so `syncCamera` runs and `handleResize` does not.
	 */
	setFontPx(px: number): void;
	/** The real `handleResize`. Returns how many repaints it triggered. */
	resize(): number;
	/** The real `syncBand`. */
	syncBand(): "none" | "moved" | "resized";
	/** The real `syncCamera`. */
	syncCamera(): void;
	/** Freeze the frame, the way a pen-down does. */
	lock(locked: boolean): void;
	cssScale(): number;
	scale(): number;
	fontZoom(): number;
	cssWidth(): number;
	band(): Band | null;
	/** The font `update()` compares against, so its trigger can be checked. */
	lastFontStr(): string;
	/** What `update()` would decide on a geometry tick right now. */
	updateWouldResize(): boolean;
	lastSyncContentLeft(): number;
	lastSyncRectLeft(): number;
	/** `.cm-content`'s left edge on screen right now, visual px. */
	contentLeft(): number;
	/** The container's `offsetWidth`, layout px, as the DOM would round it. */
	containerOffsetWidth(): number;
	/**
	 * Where note-space x lands on screen, via the CAMERA - the composition
	 * the painter actually performs: world -> container layout px through
	 * the camera, then layout px -> visual px through cssScale, offset by
	 * the container's own on-screen left edge.
	 */
	paintedX(noteX: number): number;
	/** The same point by the reduced law, read fresh from the DOM. */
	trueX(noteX: number): number;
}

function makeRig(initial: Partial<PaneState> = {}): Rig {
	const pane: PaneState = {
		paneWidth: 800,
		paneHeight: 600,
		paneScreenLeft: 300,
		scrollWidth: 800,
		scrollLeft: 0,
		scrollTop: 0,
		scrollHeight: 4000,
		transform: 1,
		readableLineLength: true,
		...initial,
	};

	// The container's box, in the scroller's CONTENT coordinates - i.e. what
	// syncBand last wrote into its inline style. Nothing else may set it.
	const box = { left: 0, top: 0, width: 0, height: 0 };
	const px = (v: unknown): number => Number.parseFloat(String(v));

	const columnWidth = (): number =>
		pane.readableLineLength ? Math.min(pane.paneWidth, FILE_LINE_WIDTH) : pane.paneWidth;
	/** `.cm-content`'s screen left: the column, centred in the pane. */
	const contentLeft = (): number =>
		pane.paneScreenLeft + ((pane.paneWidth - columnWidth()) / 2) * pane.transform;

	// The scroller's own rect. The pane's box is untransformed layout, the
	// transform on `.cm-editor` scales what reaches the screen.
	const scrollerRect = () => ({
		left: pane.paneScreenLeft,
		top: 100,
		width: pane.paneWidth * pane.transform,
		height: pane.paneHeight * pane.transform,
	});

	const canvas = (): Fields => el({ width: 0, height: 0, getContext: () => null });
	const canvases = [canvas(), canvas(), canvas(), canvas(), canvas()];

	const container = el({
		getBoundingClientRect: () => {
			const s = scrollerRect();
			return {
				left: s.left + (box.left - pane.scrollLeft) * pane.transform,
				top: s.top + (box.top - pane.scrollTop) * pane.transform,
				width: box.width * pane.transform,
				height: box.height * pane.transform,
				right: s.left + (box.left - pane.scrollLeft + box.width) * pane.transform,
				bottom: s.top + (box.top - pane.scrollTop + box.height) * pane.transform,
			};
		},
		setCssStyles: (s: Record<string, string>) => {
			if (s.left !== undefined) box.left = px(s.left);
			if (s.top !== undefined) box.top = px(s.top);
			if (s.width !== undefined) box.width = px(s.width);
			if (s.height !== undefined) box.height = px(s.height);
		},
	});
	// Defined rather than spread: an object spread would evaluate a getter
	// ONCE and copy the value, freezing the model at its initial size - which
	// is the opposite of what a live DOM does.
	//
	// `offsetWidth` is an integer and does not reflect transforms;
	// `getBoundingClientRect().width` is fractional and does. Both are read
	// off the SAME inline style, which is the real relationship and the whole
	// reason cssScale can only ever be the transform ratio.
	Object.defineProperties(container, {
		offsetWidth: { get: () => Math.round(box.width) },
		offsetHeight: { get: () => Math.round(box.height) },
	});

	const scrollDOM = el({
		getBoundingClientRect: () => scrollerRect(),
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	});
	Object.defineProperties(scrollDOM, {
		scrollLeft: { get: () => pane.scrollLeft },
		scrollTop: { get: () => pane.scrollTop },
		clientWidth: { get: () => pane.paneWidth },
		clientHeight: { get: () => pane.paneHeight },
		scrollWidth: { get: () => pane.scrollWidth },
		scrollHeight: { get: () => pane.scrollHeight },
	});

	// ONE object, returned by every `getComputedStyle` call, because a real
	// computed style is LIVE: `contentStyle` is cached with `??=` and the
	// overlay re-reads `fontSize` off the cached object. A fresh literal per
	// call would model a snapshot, and a font change would be invisible to
	// exactly the code path under test.
	const contentFont = { fontSize: "16px" };
	const win = {
		devicePixelRatio: 1,
		getComputedStyle: () => contentFont,
		cancelAnimationFrame: () => undefined,
		clearTimeout: () => undefined,
	};

	const dom = el({ ownerDocument: { defaultView: win }, parentElement: null });

	const o = Object.create(InkOverlayPlugin.prototype) as Fields;

	o.view = {
		dom,
		scrollDOM,
		contentDOM: el({
			// No `.cm-line` children: `contentOriginLeft` (1.4.9) falls back to
			// this element's own rect, which is exactly what this rig models -
			// stock geometry, where `.cm-content` IS the column. Empty rather
			// than absent so that fallback path is real, not `undefined.length`.
			children: [] as unknown[],
			getBoundingClientRect: () => ({
				left: contentLeft(),
				top: 100,
				width: columnWidth() * pane.transform,
				height: 3000,
				right: contentLeft() + columnWidth() * pane.transform,
				bottom: 3100,
			}),
		}),
		// CodeMirror's own measurement of the same transform.
		get scaleX() {
			return pane.transform;
		},
		get scaleY() {
			return pane.transform;
		},
		documentTop: 100,
	};

	o.container = container;
	o.committedCanvas = canvases[0];
	o.wetCanvas = canvases[1];
	o.tailCanvas = canvases[2];
	o.highlightCanvas = canvases[3];
	o.highlightWetCanvas = canvases[4];
	o.committedCtx = { setTransform: () => undefined };
	o.highlightCtx = { setTransform: () => undefined };
	const renderer = { applyDpr: () => undefined, clear: () => undefined };
	o.wet = renderer;
	o.highlightWet = renderer;
	o.tail = { applyDpr: () => undefined, clearAll: () => undefined };

	o.contentStyle = null;
	o.refFontPx = 0;
	o.lastFontStr = "";
	o.cssScale = 1;
	o.fontZoom = 1;
	o.scale = 1;
	o.dpr = 1;
	o.cssWidth = 0;
	o.cssHeight = 0;
	o.camera = new Camera();
	o.lastSyncRectLeft = 0;
	o.lastSyncRectTop = 0;
	o.lastSyncContentLeft = 0;
	o.lastSyncDocumentTop = 0;
	o.lastSyncScrollLeft = 0;
	o.lastSyncScrollTop = 0;

	o.frame = { locked: false, cancel: () => undefined };
	o.band = null;
	o.router = null;
	o.axisChecked = false;
	o.lastReach = null;
	o.indexDirty = true;
	o.lastPaintCam = null;
	o.damage = { addAll: () => undefined };
	o.builder = null;
	o.mode = "ink";
	o.selection = { clear: () => undefined, isEmpty: true };
	o.axisGuard = { restore: () => undefined, capture: () => undefined };
	o.penCursorEl = null;
	o.eraserEl = null;
	o.mobileTools = null;
	o.lastExtentInputs = null;
	o.spacer = null;
	o.spacerLeft = Number.NaN;
	o.spacerTop = Number.NaN;
	o.pinchScaleNow = 1;
	o.pinchRasterScale = 1;

	const proto = InkOverlayPlugin.prototype as unknown as {
		handleResize: () => void;
		syncBand: () => "none" | "moved" | "resized";
		syncCamera: () => void;
	};

	// `repaint` wants a real 2d context, so it is shadowed - but with its own
	// GEOMETRY PROLOGUE, which is the part this file is about. The real one
	// re-syncs the band, bails back into handleResize if that resized, and
	// otherwise re-syncs the camera before drawing a pixel.
	let repaints = 0;
	o.repaint = () => {
		repaints++;
		if (proto.syncBand.call(o) === "resized") {
			proto.handleResize.call(o);
			return;
		}
		proto.syncCamera.call(o);
	};
	o.scheduleRepaint = () => {
		repaints++;
	};

	return {
		pane,
		setDpr(dpr: number) {
			win.devicePixelRatio = dpr;
		},
		setFontPx(px: number) {
			contentFont.fontSize = `${px}px`;
		},
		resize() {
			repaints = 0;
			proto.handleResize.call(o);
			return repaints;
		},
		syncBand: () => proto.syncBand.call(o),
		syncCamera: () => proto.syncCamera.call(o),
		lock(locked: boolean) {
			(o.frame as { locked: boolean }).locked = locked;
		},
		cssScale: () => o.cssScale as number,
		scale: () => o.scale as number,
		fontZoom: () => o.fontZoom as number,
		cssWidth: () => o.cssWidth as number,
		band: () => o.band as Band | null,
		lastFontStr: () => o.lastFontStr as string,
		// `update()`'s trigger, verbatim from InkOverlay: a geometry update
		// calls `handleResize` when the live computed size differs from the
		// one it last recorded. Modelled rather than called because `update`
		// takes a real `ViewUpdate`.
		updateWouldResize: () => contentFont.fontSize !== (o.lastFontStr as string),
		lastSyncContentLeft: () => o.lastSyncContentLeft as number,
		lastSyncRectLeft: () => o.lastSyncRectLeft as number,
		contentLeft,
		containerOffsetWidth: () => container.offsetWidth as number,
		paintedX(noteX: number) {
			const cam = o.camera as Camera;
			const layout = cam.worldToScreen(noteX, 0).x;
			const rect = (
				container.getBoundingClientRect as () => { left: number }
			)();
			return rect.left + layout * (o.cssScale as number);
		},
		trueX(noteX: number) {
			return contentLeft() + noteX * (o.scale as number);
		},
	};
}

/** Android WebView densities are the fractional dprs that actually ship. */
const DPRS = [1, 2, 2.625, 2.75, 3, 3.5];

describe("pane-width change: does cssScale move?", () => {
	it("is exactly 1 before and after, because both reads are of one element", () => {
		const r = makeRig();
		r.resize();
		expect(r.cssScale()).toBe(1);
		for (const w of [800, 799, 401, 393, 375, 320, 1201]) {
			r.pane.paneWidth = w;
			r.resize();
			expect(r.cssScale()).toBe(1);
			expect(r.scale()).toBe(1);
		}
	});

	it("survives a fractional device pixel ratio, which is the mobile case", () => {
		// Android WebViews run at densities like 2.625 and 3.5, so the
		// backing-store rounding in computeCanvasSize is NOT exact there.
		// It still cannot move ink: the context transform and the canvas's
		// css width are exact inverses, so the quantisation lands on the
		// canvas's own overflow, never on a coordinate.
		for (const dpr of DPRS) {
			const r = makeRig();
			r.setDpr(dpr);
			r.resize();
			expect(r.cssScale()).toBe(1);
			for (const w of [800, 393, 375, 320]) {
				r.pane.paneWidth = w;
				r.resize();
				expect(r.cssScale()).toBe(1);
				expect(r.paintedX(500)).toBeCloseTo(r.trueX(500), 9);
			}
		}
	});

	it("has no fractional width to be wrong about: syncBand writes integers", () => {
		// `cssScale` could only drift from 1 if the container's rect and its
		// offsetWidth disagreed - the fractional-vs-integer gap the dispatch
		// flagged. They cannot, because the only writer of that box is
		// syncBand, and `bandFor` is built out of clientWidth/clientHeight,
		// which the DOM reports as integers.
		for (const w of [393, 375, 801, 1207]) {
			for (const sw of [w, w + 1, w + 5000]) {
				const band = bandFor({
					scrollLeft: 0,
					scrollTop: 0,
					clientWidth: w,
					clientHeight: 601,
					scrollWidth: sw,
					scrollHeight: 4001,
				});
				expect(Number.isInteger(band.width)).toBe(true);
				expect(Number.isInteger(band.height)).toBe(true);
				expect(band.width).toBe(Math.round(band.width));
			}
		}
	});

	it("keeps cssScale equal to the transform, not to the width ratio", () => {
		// A pinch is the one thing that legitimately moves cssScale, and it
		// must keep doing so across a width change or the pinch regresses.
		const r = makeRig({ transform: 1.7115 });
		r.resize();
		expect(r.cssScale()).toBeCloseTo(1.7115, 10);
		r.pane.paneWidth = 393;
		r.resize();
		expect(r.cssScale()).toBeCloseTo(1.7115, 10);
	});

	it("never reaches effectiveScale's cmScaleX fallback on this path", () => {
		// The fallback fires only when offsetWidth <= 0 while rect.width > 0
		// - a sub-pixel container, which a mid-animation pane width could in
		// principle produce. It cannot here: bandFor returns the EMPTY band
		// at clientWidth <= 0, and handleResize's zero-size branch takes that
		// case before any scale is measured.
		const r = makeRig();
		r.resize();
		for (const w of [0, 1, 2, 3]) {
			r.pane.paneWidth = w;
			r.resize();
			const off = r.containerOffsetWidth();
			// Never a sub-pixel box: the only widths this element is ever
			// given are integers, so offsetWidth is either that integer or
			// a hard zero, and zero is caught upstream by the empty band.
			expect(Number.isInteger(off)).toBe(true);
			expect(off === 0).toBe(w === 0);
			expect(r.cssScale()).toBe(1);
		}
	});
});

describe("pane-width change: is the paint fresh?", () => {
	it("re-derives the camera so painted x equals the reduced law", () => {
		const r = makeRig();
		r.resize();
		const before = r.paintedX(500);
		expect(before).toBeCloseTo(r.trueX(500), 9);

		// The pane narrows past the readable-line cap, so the column moves.
		r.pane.paneWidth = 393;
		r.resize();
		expect(r.contentLeft()).not.toBe(r.pane.paneScreenLeft + 50);
		expect(r.paintedX(500)).toBeCloseTo(r.trueX(500), 9);
		// And it actually MOVED - otherwise the assertion above is vacuous.
		expect(Math.abs(r.paintedX(500) - before)).toBeGreaterThan(1);
	});

	it("DOES detach when the camera is denied its resync - the probe has teeth", () => {
		// Without this the freshness assertions above prove nothing: a
		// harness that can never report a displacement would pass them by
		// construction. Freezing the frame is the one supported way to hold
		// the camera still across a geometry change (it is what a pen-down
		// does on purpose), and it produces EXACTLY the reported signature -
		// ink standing still while the text column moves out from under it.
		const r = makeRig();
		r.resize();
		const contentLeftBefore = r.contentLeft();
		const painted = r.paintedX(500);

		r.lock(true);
		r.pane.paneWidth = 393;
		r.resize();

		const moved = r.contentLeft() - contentLeftBefore;
		// 800px pane, column capped at 700, so the column sat 50px in; at
		// 393 the column IS the pane and the inset is gone.
		expect(moved).toBeCloseTo(-50, 9);
		// The camera never moved, so the ink is off by the column's motion.
		expect(r.paintedX(500) - r.trueX(500)).toBeCloseTo(-moved, 6);
		expect(painted).toBeCloseTo(r.paintedX(500), 6);

		// Release it and the next resize puts the ink back on the text.
		r.lock(false);
		r.resize();
		expect(r.paintedX(500)).toBeCloseTo(r.trueX(500), 9);
	});

	it("cannot take handleResize's unchanged early return on a width change", () => {
		// That return is the one ordering hazard on this path: it skips both
		// the repaint and the camera sync. Any change in pane width changes
		// band.width, which changes cssWidth, which defeats the guard.
		const r = makeRig();
		r.resize();
		for (const w of [799, 798, 400, 399, 393, 1200]) {
			const prevCss = r.cssWidth();
			r.pane.paneWidth = w;
			const repaints = r.resize();
			expect(r.cssWidth()).not.toBe(prevCss);
			expect(repaints).toBeGreaterThan(0);
		}
	});

	it("re-syncs when the column re-centres at CONSTANT width (sidebar toggle, readable line length on)", () => {
		// The other half of the 2026-09-03 hardware bug. Readable line length
		// caps the column at FILE_LINE_WIDTH and centres it in the pane.
		// Opening or closing a sidebar on a window wide enough for the cap to
		// bind does not touch paneWidth AT ALL - it moves paneScreenLeft, and
		// the column keeps its width and slides sideways with it. Every input
		// the previous test's guard turns on (scale, canvas dims,
		// cssWidth/cssHeight) stays exactly put, because none of them read
		// paneScreenLeft - so handleResize's `unchanged` branch is exactly the
		// one taken, and a ResizeObserver never fires either (nothing sized).
		// Without a resync on this path the camera keeps its pre-toggle
		// origin and every committed stroke paints against it - ink standing
		// still while the text column moves out from under it, same
		// signature as the locked-frame case above, but on the path a real
		// sidebar toggle actually takes.
		const r = makeRig({ paneWidth: 1400, paneScreenLeft: 300 });
		r.resize();
		expect(r.paintedX(500)).toBeCloseTo(r.trueX(500), 9);
		const contentLeftBefore = r.contentLeft();

		const prevCssWidth = r.cssWidth();
		r.pane.paneScreenLeft = 60;
		const repaints = r.resize();

		// The regression signature: nothing `unchanged` compares moved.
		expect(r.cssWidth()).toBe(prevCssWidth);
		// And the column itself genuinely did, so this is not a vacuous check.
		expect(Math.abs(r.contentLeft() - contentLeftBefore)).toBeCloseTo(240, 9);
		expect(repaints).toBeGreaterThan(0);
		expect(r.paintedX(500)).toBeCloseTo(r.trueX(500), 9);
	});

	it("settles the band before repaint runs, so no second resize recurses", () => {
		const r = makeRig();
		r.resize();
		r.pane.paneWidth = 393;
		r.resize();
		// handleResize sync'd the band first; repaint's own syncBand must be
		// a no-op, which is what stops the two from ping-ponging.
		expect(r.syncBand()).toBe("none");
	});

	it("refreshes every cached geometry field the resize invalidates", () => {
		// §5.4: the RemountFontRef pattern - a field surviving a lifecycle
		// event it should not. Across a pane-width change, nothing does.
		const r = makeRig();
		r.resize();
		const was = {
			band: { ...(r.band() as { width: number; left: number }) },
			cssWidth: r.cssWidth(),
			contentLeft: r.lastSyncContentLeft(),
			rectLeft: r.lastSyncRectLeft(),
		};
		r.pane.paneWidth = 393;
		r.pane.paneScreenLeft = 0;
		r.resize();
		expect((r.band() as { width: number }).width).not.toBe(was.band.width);
		expect(r.cssWidth()).not.toBe(was.cssWidth);
		expect(r.lastSyncContentLeft()).not.toBe(was.contentLeft);
		expect(r.lastSyncRectLeft()).not.toBe(was.rectLeft);
		// The stashed contentLeft is the one the camera was built from.
		expect(r.lastSyncContentLeft()).toBeCloseTo(r.contentLeft(), 9);
	});

	it("holds when the extent spacer has made the surface h-scrollable", () => {
		// Ink to the right flips bandFor's horizontal margin on, which moves
		// the container's left edge NEGATIVE inside the scroller. The camera
		// has to absorb that exactly, or every stroke shifts by the margin.
		const r = makeRig();
		r.resize();
		r.pane.scrollWidth = 5000;
		r.pane.paneWidth = 393;
		r.resize();
		expect(bandMargin(r.pane.paneHeight)).toBeGreaterThan(0);
		expect((r.band() as { left: number }).left).toBeLessThan(0);
		expect(r.paintedX(500)).toBeCloseTo(r.trueX(500), 9);
	});
});

describe("pane-width change: the mobile asymmetry", () => {
	it("re-wraps the text column on a phone and does not on a wide desktop", () => {
		// The one asymmetry this investigation found, and it is NOT a scale
		// or origin error. Obsidian caps the text column at
		// --file-line-width (700px by default). On a desktop window wide
		// enough for the cap to bind, toggling a sidebar changes only where
		// the column is CENTRED: the column keeps its width, the text does
		// not re-wrap, and the camera's contentLeft absorbs the move exactly
		// - which is what Alan measured ("ink didn't detach when i toggled
		// left sidebar"). On a phone the pane is narrower than the cap, so
		// the column width IS the pane width: changing it re-wraps every
		// line. Ink is anchored to the note surface, not to the glyphs, so
		// re-wrapped text slides out from under ink that is still exactly
		// where it was drawn.
		const wide = makeRig({ paneWidth: 1400 });
		const wideCol = Math.min(wide.pane.paneWidth, FILE_LINE_WIDTH);
		wide.pane.paneWidth = 1100;
		expect(Math.min(wide.pane.paneWidth, FILE_LINE_WIDTH)).toBe(wideCol);

		const phone = makeRig({ paneWidth: 393 });
		const phoneCol = Math.min(phone.pane.paneWidth, FILE_LINE_WIDTH);
		phone.pane.paneWidth = 320;
		expect(Math.min(phone.pane.paneWidth, FILE_LINE_WIDTH)).not.toBe(phoneCol);

		// Both cases still paint at the reduced law. The scale path is clean
		// in both; only the TEXT moved, and only on the narrow one.
		for (const r of [wide, phone]) {
			r.resize();
			expect(r.cssScale()).toBe(1);
			expect(r.paintedX(500)).toBeCloseTo(r.trueX(500), 9);
		}
	});
});

/**
 * The other half of `scale`, on the same rig: the FONT zoom, and whether
 * `syncCamera` alone keeps it current.
 *
 * `RemountFontRef.test.ts` pins what `refFontPx` means across a remount. This
 * is the narrower question 1.4.10 fixed: an editor font-size change makes the
 * lines taller, so it resizes `.cm-content` and NOT `.cm-editor`. Only
 * `contentResizeObserver` fires, and that observer calls `syncCamera`, which
 * until 1.4.10 re-measured `cssScale` from a fresh rect and reused whatever
 * `fontZoom` `handleResize` had last cached. The camera was then rebuilt with
 * a scale short by the whole font ratio - 48px of displacement at a 1400px
 * pane going 16px to 20px, measured against a real engine in
 * `test/render/MinimalCameraScale.test.ts`, and theme-independent.
 *
 * The rig drives this directly because `syncCamera` is called off the
 * prototype here and the computed style it reads is one live object.
 */
describe("syncCamera and the editor font size", () => {
	it("refreshes the font zoom, so `scale` is right without a handleResize", () => {
		const r = makeRig({ paneWidth: 1400 });
		// Mount: `handleResize` latches `refFontPx` at the font in force.
		r.resize();
		expect(r.fontZoom()).toBe(1);
		const mounted = r.scale();

		// The font change, delivered the way the DOM delivers it: the style
		// object now says 20px, and `handleResize` is never called - only the
		// content observer's `syncCamera`.
		r.setFontPx(20);
		r.syncCamera();

		expect(r.fontZoom()).toBeCloseTo(20 / 16, 12);
		expect(r.scale()).toBeCloseTo(r.cssScale() * (20 / 16), 12);
		expect(r.scale()).not.toBe(mounted);
	});

	it("leaves the reference font alone, so persisted coordinates keep meaning", () => {
		// `refFontPx` latches at mount and every stored stroke is expressed
		// against it. Re-latching it here would make the zoom read 1 again and
		// silently redefine the note's coordinate system.
		const r = makeRig({ paneWidth: 1400 });
		r.resize();
		r.setFontPx(20);
		r.syncCamera();
		r.setFontPx(24);
		r.syncCamera();
		expect(r.fontZoom()).toBeCloseTo(24 / 16, 12);
	});

	it("does not disarm update()'s own handleResize trigger", () => {
		// TWO TRIGGERS, ONE FIELD, until 1.4.10. `update()` calls
		// `handleResize` on a geometry update when the live `fontSize`
		// differs from `lastFontStr`; `syncCamera` learned to re-derive
		// `fontZoom` for itself and wrote that same field. Whichever observer
		// fired first consumed the difference, and the one left holding a
		// font that "had not changed" was `handleResize` - the only writer of
		// the canvas backing store.
		const r = makeRig({ paneWidth: 1400 });
		r.resize();
		expect(r.updateWouldResize()).toBe(false);

		// The content observer wins the race, as it does whenever taller
		// lines resize `.cm-content` without resizing `.cm-editor`.
		r.setFontPx(20);
		r.syncCamera();

		// The sync path saw it...
		expect(r.fontZoom()).toBeCloseTo(20 / 16, 12);
		// ...and the update path still can.
		expect(r.lastFontStr()).toBe("16px");
		expect(r.updateWouldResize()).toBe(true);

		// And once `handleResize` does run, both are settled.
		r.resize();
		expect(r.updateWouldResize()).toBe(false);
		expect(r.fontZoom()).toBeCloseTo(20 / 16, 12);
	});

	it("costs one string compare when the font did not change", () => {
		// The hot-path claim, in the only form this rig can state it: a second
		// sync at the same font must not move the scale at all. `syncCamera`
		// runs on resize and scroll ticks and at pen-down, so a font read that
		// did work every frame would be work on every scroll.
		const r = makeRig({ paneWidth: 1400 });
		r.resize();
		r.setFontPx(20);
		r.syncCamera();
		const after = r.scale();
		r.syncCamera();
		r.syncCamera();
		expect(r.scale()).toBe(after);
	});
});
