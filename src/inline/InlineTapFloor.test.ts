/**
 * The tap floor, on the NOTE surface.
 *
 * The ruling: a tap draws at exactly the nib whatever the pressure (alan,
 * 2026-09-02). `WetInkRenderer.contactHalfWidth` is that ruling and
 * `WetInkRenderer.test.ts` pins its arithmetic - the floor is `baseWidth / 2`
 * and it wins at every pressure. What is pinned HERE is the part each surface
 * has to get right for itself and that no arithmetic test can see: WHICH
 * width its contact draw asks for, and that the moving head is left alone.
 *
 * Modelled on `PdfInkController.test.ts`'s "the contact draw is floored and
 * the moving draw is not", which was the only behavioural cover this rule had
 * on any of the three surfaces that carry it.
 *
 * WHY IT WAS NEEDED, measured rather than argued. On this branch at
 * `72f60a3`, before this file existed:
 *
 *   - replacing the contact site's argument with a literal `0` reddened
 *     exactly ONE test in the whole suite, `InkSurfaceRules.test.ts`'s
 *     presence row for this rule. Nothing observed the width;
 *   - and SWAPPING the two sites - the contact dot asking `liveHalfWidth` and
 *     the moving head asking `contactHalfWidth` - was FULLY GREEN at 1825.
 *     That one mutation kills the tap floor and the taper together, and it is
 *     invisible to a presence marker by construction, because both symbols
 *     are still in the file. The guard section of `1.4.9-design.md` says so
 *     in prose: "a build that floors the moving head passes this guard".
 *
 * The third defeat a marker used to have is CLOSED and this file does not
 * claim it. `codeOnly` blanks comments before the sweep, so a comment
 * spelling the symbol no longer satisfies the row - checked here rather than
 * inherited, in both comment forms, and the row stayed red for both.
 *
 * THE HARNESS. `InkOverlayPlugin` imports obsidian and cannot be constructed
 * in this suite, so `Object.create(prototype)` gives a real instance with real
 * methods and no field initialisers, and only the fields `penDown` and
 * `penRaw` read are assigned - the idiom `InlineTailWidth.test.ts`,
 * `InlineEraserSelection.test.ts` and `PanClearsSelection.test.ts` all use.
 * The wet layer is a stub, exactly as the pdf's version of this test uses one:
 * the number under test is the ARGUMENT, not the width computed from it, and a
 * real renderer would turn every assertion here into one about
 * `widthForPressure`'s arithmetic instead. The last case is the exception and
 * says why.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InkOverlayPlugin } from "./InkOverlay";
import { SelectionModel } from "../objects/SelectionModel";
import { DEFAULT_PEN, PenStyle } from "../ink/PenStyle";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest } from "./TipMode";
import { setPrediction } from "./StrokePrediction";

/**
 * Distinguishable answers, so every assertion below is about which question
 * was asked. Same values and the same reason as the pdf's harness.
 */
const LIVE_HW = 0.11;
const CONTACT_HW = 5;

/** A bare tip: contact, no side button (bit 2), no eraser end (bit 32). */
function tip(x: number, y: number): PointerEvent {
	return { buttons: 1, button: 0, clientX: x, clientY: y, timeStamp: 0 } as unknown as PointerEvent;
}

function sample(x: number, y: number, pressure = 0.5): PenSample {
	return { x, y, pressure, timestamp: x, tiltX: 0, tiltY: 0 };
}

interface Rig {
	penDown(s: PenSample): void;
	penRaw(s: PenSample[]): void;
	/** "contact" or "live", in the order the surface asked. */
	asked: string[];
	/** The half-width handed to each `tail.drawHead`, in order. */
	widths: number[];
	/** How many times the head canvas was cleared, for the tap case. */
	clears(): number;
}

/**
 * With `realFloor`, the stub's `contactHalfWidth` is WetInkRenderer's own
 * line rather than a sentinel, so the "whatever the pressure" half of the
 * ruling can be asserted THROUGH the surface instead of only in the
 * renderer's own file.
 */
function makeRig(realFloor = false): Rig {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const asked: string[] = [];
	const widths: number[] = [];
	let clears = 0;

	const wet = {
		shape: true,
		beginStroke: () => undefined,
		appendPoint: () => undefined,
		// A head to draw, so the moving branch is reached at all: without one
		// `penRaw` skips its draw and the "not floored" half would be vacuous.
		head: () => ({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, pressure: 0.5 }),
		liveHalfWidth: (_style: PenStyle, _pressure: number) => {
			asked.push("live");
			return LIVE_HW;
		},
		contactHalfWidth: (style: PenStyle, _pressure: number) => {
			asked.push("contact");
			return realFloor ? Math.max(LIVE_HW, style.baseWidth / 2) : CONTACT_HW;
		},
		liveWidthPx: () => 1,
	};

	view.mode = "ink";
	view.scale = 1;
	view.penCursorEl = null;
	view.router = null;
	view.mobileTools = null;
	view.penStyle = { ...DEFAULT_PEN };
	view.highlighterStyle = { ...DEFAULT_PEN };
	view.wet = wet;
	view.highlightWet = wet;
	view.predReal = [];
	view.predLastTail = [];
	// focusClaimedPenEditor's whole contract: already focused, nothing to do.
	view.view = { hasFocus: true, focus: () => undefined };
	view.frame = {
		locked: false,
		begin: () => undefined,
		end: () => undefined,
		cancel: () => undefined,
	};
	view.camera = {
		snapshot: { x: 0, y: 0, zoom: 1 },
		screenToWorld: (x: number, y: number) => ({ x, y }),
	};
	// Empty, so `penDown` reaches the ink branch rather than the selection
	// grab. The real class, not a stand-in: Object.create skips initialisers.
	view.selection = new SelectionModel();
	view.tail = {
		clear: () => {
			clears++;
		},
		drawHead: (
			_cam: unknown,
			_style: unknown,
			_from: unknown,
			_to: unknown,
			_pressure: number,
			hw: number
		) => {
			widths.push(hw);
		},
		draw: () => undefined,
	};

	// Own properties, so the prototype's versions never run: each reaches the
	// editor, the store, the canvas or a diagnostic, and none is the subject.
	view.syncCamera = () => undefined;
	view.captureProbeGeometry = () => undefined;
	view.recordPenDownState = () => undefined;
	view.redrawSelectionUI = () => undefined;
	view.ensurePenTools = () => undefined;
	view.startFrameTicker = () => undefined;
	view.probeSample = () => undefined;
	view.schedulePresentProbe = () => undefined;
	view.drawPredictedTail = () => undefined;

	const proto = InkOverlayPlugin.prototype as unknown as {
		penDown(this: unknown, s: PenSample, ev: PointerEvent): void;
		penRaw(this: unknown, s: PenSample[], ev: PointerEvent): void;
	};
	return {
		penDown: (s) => proto.penDown.call(view, s, tip(s.x, s.y)),
		penRaw: (s) => proto.penRaw.call(view, s, tip(0, 0)),
		asked,
		widths,
		clears: () => clears,
	};
}

describe("the note surface's contact draw is floored and its moving draw is not", () => {
	beforeEach(() => {
		resetTipModeForTest();
		// The predicted tail draws onto the same canvas and is not the
		// subject; off, so `widths` holds head draws only.
		setPrediction(false);
	});
	afterEach(() => resetTipModeForTest());

	it("asks for the floored width at contact and the live width after", () => {
		const rig = makeRig();

		rig.penDown(sample(100, 100));
		rig.penRaw([sample(130, 130)]);
		rig.penRaw([sample(160, 160)]);

		// The first accepted sample is the contact dot; everything after it
		// is the moving head and must stay unfloored or the stroke cannot
		// taper. The pdf surface's version asserts the same pair.
		expect(rig.asked[0]).toBe("contact");
		expect(rig.asked.slice(1)).not.toContain("contact");
		expect(rig.asked.slice(1)).toContain("live");
		expect(rig.widths[0]).toBe(CONTACT_HW);
		expect(rig.widths.length).toBeGreaterThan(1);
		expect(rig.widths.slice(1).every((w) => w === LIVE_HW)).toBe(true);
	});

	it("a tap that never moves is drawn once, at the floored width", () => {
		const rig = makeRig();

		// Down and no further. On this surface the contact draw is the whole
		// of a tap: it is the ONE head draw not gated on `head()`, and pen-up
		// commits the stroke rather than drawing again. So if this asked for
		// the bare live width a tap would be the 12% speck the floor exists
		// to prevent.
		rig.penDown(sample(100, 100));

		expect(rig.asked).toEqual(["contact"]);
		expect(rig.widths).toEqual([CONTACT_HW]);
		expect(rig.clears()).toBe(1);
	});

	it("draws a tap at exactly the nib whatever the pressure", () => {
		// The ruling in its own words, through the surface. The stub carries
		// the renderer's real floor here, so a contact site pointed at the
		// bare live width fails on the NUMBER and not merely on the name.
		const nib = DEFAULT_PEN.baseWidth / 2;
		expect(LIVE_HW).toBeLessThan(nib);

		for (const pressure of [0, 0.05, 0.5, 0.9, 1]) {
			const rig = makeRig(true);

			rig.penDown(sample(100, 100, pressure));

			expect(rig.widths, `pressure ${pressure}`).toEqual([nib]);
		}
	});
});
