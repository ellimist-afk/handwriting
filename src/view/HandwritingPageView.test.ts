/**
 * The canvas page view's pen-down, exercised for the first time.
 *
 * `HandwritingPageView.ts` is 59 KB and, until this file, was imported by
 * exactly zero tests (1.4.7-design.md C2): the surface every divergence hunt
 * has skipped, because it is the one that cannot simply be constructed - the
 * constructor and `onOpen` want a real Obsidian leaf and a real DOM, and this
 * suite runs in node with no document at all.
 *
 * So the view is not constructed. `Object.create(prototype)` gives a real
 * instance with real methods and no field initialisers, and each test assigns
 * only the fields the path under test reads. That is deliberately a small,
 * declared surface rather than a general harness: what it can drive is
 * `penDown`, and what it asserts is selection state, which is pure model.
 *
 * The stubs standing in for the paint and metrics calls are no-ops by design,
 * but the SELECTION is seeded for real and the seeding is asserted before
 * every act. An empty selection would make `clearSelection` a no-op and every
 * assertion below would pass against the unfixed code as happily as against
 * the fixed one.
 */

import { describe, expect, it } from "vitest";
import { HandwritingPageView } from "./HandwritingPageView";
import { SelectionModel } from "../objects/SelectionModel";
import { DEFAULT_PEN, HIGHLIGHTER_PEN, PenStyle, widthForPressure } from "../ink/PenStyle";
import type { PenSample } from "../input/PointerRouter";

type Tool = "pen" | "highlighter" | "eraser" | "lasso";

const SAMPLE: PenSample = { x: 10, y: 12, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };

/** A bare tip: contact, no side button, no eraser end. */
const TIP = { buttons: 1, button: 0 } as unknown as PointerEvent;
/** Side button held - the temporary lasso override (§52). */
const SIDE = { buttons: 3, button: 0 } as unknown as PointerEvent;
/** The eraser end, reported as bit 5 of `buttons` (§25). */
const ERASER_END = { buttons: 32, button: 0 } as unknown as PointerEvent;

interface Harness {
	penDown(sample: PenSample, ev: PointerEvent): void;
	selection: SelectionModel;
	redraws: number;
	lassoDowns: number;
	loaded: boolean;
}

function makeView(tool: Tool): Harness {
	const view = Object.create(HandwritingPageView.prototype) as Record<string, unknown>;
	const selection = new SelectionModel();
	selection.selectExactly(["stroke-a", "stroke-b"]);
	view.selection = selection;
	view.lassoPts = [];
	view.lassoActive = false;
	view.tool = tool;
	view.loaded = true;
	view.inkRefusalSaid = null;
	// Only the three fields inkRefusal reads; a real PageDocument wants a
	// vault behind it.
	view.doc = { spatialFutureVersion: undefined, spatialDamaged: false };
	view.textLayer = { isEditing: false };
	view.metrics = { begin: () => {} };
	view.penStyle = { ...DEFAULT_PEN };
	view.camera = { screenToWorld: (x: number, y: number) => ({ x, y }) };
	view.wetInk = { beginStroke: () => {} };
	view.redraws = 0;
	view.lassoDowns = 0;
	view.redrawSelectionUI = () => {
		(view.redraws as number)++;
	};
	view.lassoDown = () => {
		(view.lassoDowns as number)++;
	};
	view.startTicker = () => {};
	view.showEraserCursor = () => {};
	view.eraseAt = () => {};
	return view as unknown as Harness;
}

describe("canvas pen-down and the live selection", () => {
	it("a bare tip dissolves the selection", () => {
		const view = makeView("pen");
		// The seeding, asserted: without a real selection every case below
		// passes on both sides of the fix, because clearSelection returns
		// early when there is nothing to clear.
		expect(view.selection.isEmpty).toBe(false);

		view.penDown(SAMPLE, TIP);

		// InkOverlay.ts: "Tip and eraser return the pen to normal behavior:
		// selection dissolves." The canvas did not, until 1.4.7.
		expect(view.selection.isEmpty).toBe(true);
		expect(view.redraws).toBeGreaterThan(0);
	});

	it("the eraser end dissolves the selection", () => {
		const view = makeView("pen");
		expect(view.selection.isEmpty).toBe(false);

		view.penDown(SAMPLE, ERASER_END);

		expect(view.selection.isEmpty).toBe(true);
	});

	it("the eraser tool dissolves the selection", () => {
		const view = makeView("eraser");
		expect(view.selection.isEmpty).toBe(false);

		view.penDown(SAMPLE, TIP);

		expect(view.selection.isEmpty).toBe(true);
	});

	it("a lasso gesture keeps the selection it is about to act on", () => {
		// The half that breaks if the dissolve is placed one branch too
		// early: the lasso path owns the selection, and landing inside an
		// existing one is how a move starts.
		const view = makeView("lasso");
		expect(view.selection.isEmpty).toBe(false);

		view.penDown(SAMPLE, TIP);

		expect(view.lassoDowns).toBe(1);
		expect(view.selection.isEmpty).toBe(false);
	});

	it("the side button keeps the selection too", () => {
		const view = makeView("pen");
		expect(view.selection.isEmpty).toBe(false);

		view.penDown(SAMPLE, SIDE);

		expect(view.lassoDowns).toBe(1);
		expect(view.selection.isEmpty).toBe(false);
	});

	it("a refused page leaves the selection alone", () => {
		// Ordering: the refusal returns before any of this, so a page whose
		// ink cannot be saved does not silently drop what was selected.
		const view = makeView("pen");
		view.loaded = false;
		expect(view.selection.isEmpty).toBe(false);

		view.penDown(SAMPLE, TIP);

		expect(view.selection.isEmpty).toBe(false);
	});
});

/**
 * The predicted tail's style source (1.4.7-design D5).
 *
 * `updateOverlay`'s tail block sits behind `if (!this.predictionOn) return;`,
 * and `predictionOn` is flipped only by `togglePrediction()`, which has no
 * callers anywhere in the tree (C9) - so nothing that drives the plugin can
 * reach this code. The prototype harness owns the field directly, which is
 * the only reason the fix below is testable rather than merely reviewable.
 * The gate itself is untouched: whether the canvas honours the prediction
 * setting is C9's decision, not this test's.
 */
describe("the canvas predicted tail takes the active tool's style", () => {
	/** Straight and quick: clears the parked-pen speed gate, no turn to guard. */
	const HISTORY: PenSample[] = Array.from({ length: 8 }, (_, i) => ({
		x: i * 2,
		y: 5,
		// 0.8 survives normalizePressure unchanged, so the expected width can
		// be computed here without reaching for that module-private helper.
		pressure: 0.8,
		timestamp: i * 4,
		tiltX: 0,
		tiltY: 0,
	}));
	/** One predicted sample, inside DEFAULT_CAPS' 12 ms horizon and 10 px reach. */
	const PREDICTED: PenSample[] = [{ x: 17, y: 5, pressure: 0.8, timestamp: 34, tiltX: 0, tiltY: 0 }];
	const ZOOM = 2;

	interface TailDraw {
		color: string;
		widthPx: number;
	}
	/** What the tail asked the wet layer for, recorded verbatim. */
	interface WidthAsk {
		zoom: number;
		style: PenStyle;
		pressure: number;
	}
	interface OverlayHarness {
		updateOverlay(predicted: PenSample[]): void;
	}

	/**
	 * The stubbed `liveWidthPx` defaults to the accessor's OWN unshaped
	 * branch - `liveHalfWidth * 2 * cam.zoom` reduces to exactly
	 * `widthForPressure * zoom` there - so the two style cases below keep
	 * asserting what they were written for, which style object reaches the
	 * width law, and are indifferent to where the number is computed. Pass
	 * `livePx` to stand in for a shaped stroke, the state where the ribbon's
	 * width and raw pressure's disagree.
	 */
	function makeOverlayView(
		tool: Tool,
		livePx?: number
	): { view: OverlayHarness; draws: TailDraw[]; asks: WidthAsk[] } {
		const view = Object.create(HandwritingPageView.prototype) as Record<string, unknown>;
		const draws: TailDraw[] = [];
		const asks: WidthAsk[] = [];
		view.tool = tool;
		view.penStyle = { ...DEFAULT_PEN };
		view.highlighterStyle = { ...HIGHLIGHTER_PEN };
		view.predictionOn = true;
		view.camera = { zoom: ZOOM, snapshot: { x: 0, y: 0, zoom: ZOOM } };
		view.penHistory = HISTORY;
		view.lastTail = [];
		view.tail = {
			clear: () => {},
			drawHead: () => {},
			draw: (_x: number, _y: number, _pts: readonly PenSample[], color: string, widthPx: number) =>
				draws.push({ color, widthPx }),
		};
		// No live head, so the assertions below are about the tail alone. A
		// raw centerline returns undefined from head() anyway.
		view.wet = () => ({
			head: () => undefined,
			liveWidthPx: (cam: { zoom: number }, style: PenStyle, pressure: number) => {
				asks.push({ zoom: cam.zoom, style, pressure });
				return livePx ?? widthForPressure(style, pressure) * cam.zoom;
			},
		});
		return { view: view as unknown as OverlayHarness, draws, asks };
	}

	it("a highlighter tail is drawn in the highlighter's colour and width", () => {
		const { view, draws } = makeOverlayView("highlighter");

		view.updateOverlay(PREDICTED);

		// Length first: if buildTail returned nothing the two assertions
		// after it would be vacuous rather than failing.
		expect(draws).toHaveLength(1);
		expect(draws[0]!.color).toBe(HIGHLIGHTER_PEN.color);
		expect(draws[0]!.widthPx).toBeCloseTo(widthForPressure(HIGHLIGHTER_PEN, 0.8) * ZOOM);
	});

	it("a pen tail is drawn in the pen's colour and width", () => {
		const { view, draws } = makeOverlayView("pen");

		view.updateOverlay(PREDICTED);

		expect(draws).toHaveLength(1);
		expect(draws[0]!.color).toBe(DEFAULT_PEN.color);
		expect(draws[0]!.widthPx).toBeCloseTo(widthForPressure(DEFAULT_PEN, 0.8) * ZOOM);
	});

	/**
	 * The seam (1.4.7-design D5, and `WetInkRenderer.liveWidthPx`'s own
	 * header citing the hardware report of 2026-08-29). The tail is the ink
	 * guessed ahead of the nib and the wet ribbon is the ink behind it, so
	 * they have to be the same width or the join shows. The note surface
	 * (`InkOverlay`) and the pdf (`PdfInkController`) both ask the wet layer;
	 * the canvas computed its own from raw pressure, missing velocity
	 * thinning, the start taper and the smoothed pressure the ribbon uses.
	 *
	 * The sentinel is deliberately nothing like the raw width: with shaping
	 * OFF `liveWidthPx` returns exactly what this method used to compute, so
	 * a stub echoing the unshaped branch would pass on both sides of the fix.
	 */
	const SHAPED_PX = 0.375;

	it("the tail width is the wet layer's, not one computed from raw pressure", () => {
		const { view, draws, asks } = makeOverlayView("pen", SHAPED_PX);
		const rawPx = widthForPressure(DEFAULT_PEN, 0.8) * ZOOM;
		// The sentinel has to be distinguishable from the raw width, or the
		// assertion below is satisfied by the code it is meant to reject.
		expect(SHAPED_PX).not.toBeCloseTo(rawPx);

		view.updateOverlay(PREDICTED);

		// Preconditions first: a buildTail that returned no points would
		// draw nothing and every width assertion here would be vacuous.
		expect(draws).toHaveLength(1);
		expect(draws[0]!.widthPx).toBe(SHAPED_PX);
		expect(draws[0]!.widthPx).not.toBeCloseTo(rawPx);
		expect(asks).toHaveLength(1);
	});

	it("the wet layer is asked with the active tool's style and the view's camera", () => {
		// Highlighter, because `penStyle` and `strokeStyle()` differ only
		// there - the bug this method carried two lines above until 1.4.7.
		const { view, draws, asks } = makeOverlayView("highlighter", SHAPED_PX);

		view.updateOverlay(PREDICTED);

		expect(draws).toHaveLength(1);
		expect(asks).toHaveLength(1);
		expect(asks[0]!.style.color).toBe(HIGHLIGHTER_PEN.color);
		expect(asks[0]!.style.baseWidth).toBe(HIGHLIGHTER_PEN.baseWidth);
		// A CameraState, not the bare zoom: `liveWidthPx` takes the camera
		// and does the css-px conversion itself, which is why the call site
		// needs no arithmetic.
		expect(asks[0]!.zoom).toBe(ZOOM);
		expect(asks[0]!.pressure).toBe(0.8);
	});
});
