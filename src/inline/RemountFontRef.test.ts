/**
 * Lifecycle probe for the fontZoom reference (1.4.9 investigation).
 *
 * `InkOverlayPlugin` is a CM6 ViewPlugin, so ONE instance exists per
 * EditorView and the class is built to be reused across mounts:
 * `setInlineInkEnabled` walks the live `instances` set calling
 * `mount()`/`unmount()` on the SAME objects, and `update()` re-`mount()`s
 * any instance whose container is null. Only `destroy()` retires one.
 *
 * READ THIS BEFORE TREATING THE .fails TEST AS A BUG REPORT.
 *
 * The reuse is architecturally real and operationally dead as of 1.4.9.
 * `setInlineInkEnabled` has no caller anywhere outside this file, and the
 * module-level `enabled` it writes is initialised `true`, so nothing ever
 * unmounts a mounted overlay. The other two unmount routes cannot latch a
 * reference first: `mount()`'s `getContext("2d")` bail runs BEFORE mount's
 * own `handleResize()` call, and `destroy()` drops the instance from
 * `instances` for good. So the drift below is a live edge in the class,
 * reachable the moment anyone wires a settings toggle to
 * `setInlineInkEnabled`, and NOT a path a shipped build walks today.
 *
 * Two instance fields feed `this.scale` and neither is cleared by
 * `unmount()`:
 *
 *   refFontPx    latched by the `refFontPx <= 0` guard in handleResize and
 *                never reset. Its own comment calls it "editor font size at
 *                overlay MOUNT", and fontZoomFactor's contract is "the ratio
 *                of the current editor font size to the size at overlay
 *                mount" - so a mount is supposed to start from fontZoom 1.
 *   contentStyle cached with `??=` against view.contentDOM.
 *
 * The paint reduces to `screen_x = contentLeft + x * scale`, so a wrong
 * `scale` separates ink from the text it was written over by an error
 * proportional to x. That is the reported signature.
 *
 * What these tests pin is NOT "which font size is the right reference" -
 * it is that the answer depends on history the overlay is not supposed to
 * be carrying. Two instances handed IDENTICAL DOM state produce different
 * `scale` values purely because one of them was mounted once before.
 */

import { describe, expect, it } from "vitest";

// The overlay reaches for window's timers through winRef; the node test
// environment has no window, so mirror the persistence suites' shim before
// the module graph is pulled in.
(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";

type Fields = Record<string, unknown>;

/** A live computed-style stand-in: `.fontSize` re-reads the host's size. */
function styleFor(host: { fontSize: string }): { fontSize: string } {
	return {
		get fontSize() {
			return host.fontSize;
		},
	};
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

interface Rig {
	/** The real `handleResize`, run with the editor at `fontPx`. */
	resize(fontPx: number): void;
	/**
	 * The real `handleResize` with the computed style reporting `raw` - the
	 * empty string is what both engines return for a detached element.
	 */
	resizeRaw(raw: string): void;
	/** The real `unmount`. */
	unmount(): void;
	/** Re-establish the container the way a real mount does. */
	remount(): void;
	scale(): number;
	fontZoom(): number;
	refFontPx(): number;
	contentStyleCached(): boolean;
}

/**
 * An overlay built off the prototype, the pattern the other InkOverlay
 * suites use (InlineEraseFresh, PanClearsSelection): `Object.create` skips
 * the constructor, so every field the exercised paths touch is set here.
 *
 * `repaint`/`scheduleRepaint` are shadowed with no-ops - rasterization is
 * not what is under test and it wants a real 2d context. Everything on the
 * scale path (`handleResize`, `backingNow`, `syncBand`) and the whole of
 * `unmount` is the real code.
 */
function makeRig(): Rig {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;

	// The editor's font, moved by the test to stand for a font-size change.
	const contentHost = { fontSize: "16px" };

	const canvas = (): Fields =>
		el({ width: 0, height: 0, getContext: () => null });
	const canvases = [canvas(), canvas(), canvas(), canvas(), canvas()];

	const container = el({
		getBoundingClientRect: () => ({
			left: 0,
			top: 0,
			width: 800,
			height: 600,
			right: 800,
			bottom: 600,
		}),
		offsetWidth: 800,
		offsetHeight: 600,
	});

	const scrollDOM = el({
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: 800,
		clientHeight: 600,
		scrollWidth: 800,
		scrollHeight: 600,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	});

	const win = {
		devicePixelRatio: 1,
		getComputedStyle: () => styleFor(contentHost),
		cancelAnimationFrame: () => undefined,
		clearTimeout: () => undefined,
	};

	const dom = el({ ownerDocument: { defaultView: win }, parentElement: null });

	o.view = {
		dom,
		scrollDOM,
		// handleResize's unchanged-guard now re-reads this on every call
		// (see CONTENT_ORIGIN_EPSILON in InkOverlay.ts) to notice a content
		// origin that moved without anything resizing. Font-zoom lifecycle is
		// what this file is about, not that path, so a fixed zero rect - a
		// real detached element's actual getBoundingClientRect - is enough to
		// keep it a no-op here.
		contentDOM: el({
			// No `.cm-line` children: `contentOriginLeft` (1.4.9) falls back to
			// this element's own (all-zero) rect, same value as before.
			children: [] as unknown[],
			getBoundingClientRect: () => ({
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				right: 0,
				bottom: 0,
			}),
		}),
		scaleX: 1,
		scaleY: 1,
		documentTop: 0,
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

	// Scale state, exactly as the field initializers leave it.
	o.contentStyle = null;
	o.refFontPx = 0;
	o.lastFontStr = "";
	o.cssScale = 1;
	o.fontZoom = 1;
	o.scale = 1;
	o.dpr = 1;
	o.cssWidth = 0;
	o.cssHeight = 0;

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
	o.erased = [];
	o.lassoPts = [];
	o.lassoActive = false;
	o.dragFrom = null;
	o.dragTotal = null;
	o.spaceLineY = null;
	o.spaceIds = [];
	o.spaceBounds = null;
	o.spaceClient = null;
	o.spaceTotalDy = 0;
	o.panLast = null;
	o.selection = { clear: () => undefined, isEmpty: true };
	o.selectionDeleteKeys = { reset: () => undefined };
	o.axisGuard = { restore: () => undefined, capture: () => undefined };
	o.penCursorEl = null;
	o.eraserEl = null;
	o.mobileTools = null;
	o.resizeObserver = null;
	o.scrollFn = null;
	o.wheelFn = null;
	o.mediaQuery = null;
	o.mediaFn = null;
	o.offInkChanged = null;
	o.lastExtentInputs = null;
	o.spacer = null;
	o.spacerLeft = Number.NaN;
	o.spacerTop = Number.NaN;
	o.metadataObserver = null;
	o.metadataFrame = null;
	o.pageClassHost = null;
	o.hoverWatchdog = null;
	o.frameTicking = false;
	o.pinchRaf = 0;
	o.pinchPending = null;
	o.pinchScaleNow = 1;
	o.pinchRasterScale = 1;
	o.pinchRefScale = null;
	o.pinchAnchor = null;
	o.pinchScrollAt = 0;
	o.scrollPositionPatched = false;
	o.hostPositionPatched = false;
	o.chromeHostPatched = null;

	// Not under test, and they want a real canvas context.
	o.repaint = () => undefined;
	o.scheduleRepaint = () => undefined;

	const proto = InkOverlayPlugin.prototype as unknown as {
		handleResize: () => void;
		unmount: () => void;
	};

	return {
		resize(fontPx: number) {
			contentHost.fontSize = `${fontPx}px`;
			proto.handleResize.call(o);
		},
		resizeRaw(raw: string) {
			contentHost.fontSize = raw;
			proto.handleResize.call(o);
		},
		unmount() {
			proto.unmount.call(o);
		},
		remount() {
			// What matters for the scale path is that the container is back.
			// The real mount() builds a fresh one; the reused instance's
			// scale fields are untouched either way.
			o.container = container;
		},
		scale: () => o.scale as number,
		fontZoom: () => o.fontZoom as number,
		refFontPx: () => o.refFontPx as number,
		contentStyleCached: () => o.contentStyle !== null,
	};
}

describe("fontZoom reference across an unmount/remount of the same instance", () => {
	it("a first mount latches the reference and leaves fontZoom at 1", () => {
		const rig = makeRig();
		rig.resize(16);
		expect(rig.refFontPx()).toBe(16);
		expect(rig.fontZoom()).toBe(1);
	});

	it("a live font change scales ink with the text - the feature, working", () => {
		const rig = makeRig();
		rig.resize(16);
		rig.resize(20);
		expect(rig.fontZoom()).toBeCloseTo(1.25, 10);
	});

	it("unmount() clears neither refFontPx nor contentStyle", () => {
		const rig = makeRig();
		rig.resize(16);
		expect(rig.refFontPx()).toBe(16);
		expect(rig.contentStyleCached()).toBe(true);

		rig.unmount();

		// Both survive teardown. This is the mechanism, stated as a fact
		// about the current code rather than as a prediction.
		expect(rig.refFontPx()).toBe(16);
		expect(rig.contentStyleCached()).toBe(true);
	});

	// FAILING ON PURPOSE - marked `.fails`, so the suite stays green and
	// goes red the day the drift is fixed. See the header: this pins that
	// `scale` depends on pre-unmount history, which is wrong under EITHER
	// answer to "what should the reference be".
	it.fails("a remount under a different font produces the same scale as a fresh mount", () => {
		// A: never mounted before. Sees font 20 for the first time.
		const fresh = makeRig();
		fresh.resize(20);

		// B: the SAME lifecycle a reused ViewPlugin instance goes through -
		// mounted at 16, torn down, remounted while the editor sits at 20.
		const reused = makeRig();
		reused.resize(16);
		reused.unmount();
		reused.remount();
		reused.resize(20);

		// Identical DOM, identical font, identical cssScale. The only
		// difference is that B was alive once before.
		expect(reused.scale()).toBe(fresh.scale());
	});

	it("documents the size of the drift the .fails test above pins", () => {
		const fresh = makeRig();
		fresh.resize(20);

		const reused = makeRig();
		reused.resize(16);
		reused.unmount();
		reused.remount();
		reused.resize(20);

		// Fresh instance: reference latches at 20, fontZoom 1, scale 1.
		expect(fresh.fontZoom()).toBe(1);
		expect(fresh.scale()).toBe(1);
		// Reused instance: reference is still the 16 from the previous
		// mount, so every note-space x is painted 25% further right than
		// the fresh instance would paint it.
		expect(reused.refFontPx()).toBe(16);
		expect(reused.fontZoom()).toBeCloseTo(1.25, 10);
		expect(reused.scale()).toBeCloseTo(1.25, 10);
	});
});

describe("contentStyle cached against a detached contentDOM", () => {
	/**
	 * Measured, not assumed. `scripts`-free playwright probe against this
	 * repo's own playwright build, both engines:
	 *
	 *   chromium / webkit, element detached:
	 *     getComputedStyle(el).fontSize        === ""
	 *     Number.parseFloat("")                === NaN
	 *   and a declaration cached while ATTACHED reports "" once the element
	 *   is removed, then comes back live (and reports the NEW size) on
	 *   re-attach. So the cache is not permanently poisoned - the failure
	 *   is a window, not a latch.
	 *
	 * fontZoomFactor guards non-finite input and returns 1, so during that
	 * window a real font zoom is silently discarded and `scale` collapses
	 * to cssScale.
	 */
	it("a detached read collapses fontZoom to 1 and discards a live zoom", () => {
		const rig = makeRig();
		rig.resize(16);
		rig.resize(20);
		expect(rig.fontZoom()).toBeCloseTo(1.25, 10);

		// The detached window: computed fontSize is "" on both engines.
		rig.resizeRaw("");
		expect(rig.fontZoom()).toBe(1);
		expect(rig.scale()).toBe(1);

		// ...and it heals as soon as the element is back in the document.
		rig.resize(20);
		expect(rig.fontZoom()).toBeCloseTo(1.25, 10);
	});

	it("a detached FIRST read does not poison the reference", () => {
		const rig = makeRig();
		rig.resizeRaw("");
		// The `Number.isFinite` guard on the latch holds: the reference is
		// simply not taken yet.
		expect(rig.refFontPx()).toBe(0);
		// But the style object is cached anyway, by `??=`, against whatever
		// element contentDOM was at that moment.
		expect(rig.contentStyleCached()).toBe(true);

		rig.resize(18);
		expect(rig.refFontPx()).toBe(18);
		expect(rig.fontZoom()).toBe(1);
	});
});
