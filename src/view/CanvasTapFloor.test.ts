/**
 * The tap floor, on the CANVAS page surface.
 *
 * Same ruling and same subject as `InlineTapFloor.test.ts` and as the pdf's
 * "the contact draw is floored and the moving draw is not": a tap draws at
 * exactly the nib whatever the pressure (alan, 2026-09-02), and each surface
 * has to ask for the floored width at CONTACT while leaving the moving head
 * on the bare live width, or the stroke stops tapering.
 *
 * Here the split is two named methods rather than two inline arguments -
 * `drawContact` and `updateOverlay` - and the header on `drawContact` says
 * exactly why there are two. Neither had a behavioural test. On this branch
 * at `72f60a3`, replacing `drawContact`'s width argument with a literal `0`
 * reddened one thing in the whole suite: `InkSurfaceRules.test.ts`'s presence
 * row for this rule, which is a symbol sweep over the file and cannot see
 * which site the symbol is at. `1.4.9-design.md`'s guard section states that
 * limit in prose - "a build that floors the moving head passes this guard" -
 * and this file is the part that does not.
 *
 * The harness is `HandwritingPageView.test.ts`'s, which is `Object.create` on
 * the prototype for the reason that file gives at length: the constructor and
 * `onOpen` want a real Obsidian leaf and a real DOM and this suite has
 * neither. What is added here is a recording wet layer and a recording tail,
 * and a stroke that MOVES, so the second half of the rule is observed rather
 * than assumed. Nothing is called that the pen path does not call: pen-down
 * and then the raw handler, which is how a stroke arrives.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HandwritingPageView } from "./HandwritingPageView";
import { SelectionModel } from "../objects/SelectionModel";
import { DEFAULT_PEN, PenStyle } from "../ink/PenStyle";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest } from "../inline/TipMode";

/** Distinguishable answers, so each assertion is about which was asked. */
const LIVE_HW = 0.11;
const CONTACT_HW = 5;

/** A bare tip: contact, no side button (bit 2), no eraser end (bit 32). */
const TIP = { buttons: 1, button: 0, timeStamp: 0 } as unknown as PointerEvent;

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
}

/**
 * With `realFloor`, `contactHalfWidth` is WetInkRenderer's own line rather
 * than a sentinel, so "whatever the pressure" is asserted through the surface
 * and not only in the renderer's own file.
 */
function makeRig(realFloor = false): Rig {
	const view = Object.create(HandwritingPageView.prototype) as Record<string, unknown>;
	const asked: string[] = [];
	const widths: number[] = [];

	const wet = {
		beginStroke: () => undefined,
		appendPoint: () => undefined,
		// A head to draw, so `updateOverlay`'s live branch is reached at all.
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

	view.tool = "pen";
	view.loaded = true;
	view.inkRefusalSaid = null;
	view.lassoPts = [];
	view.lassoActive = false;
	view.dragFrom = null;
	view.erasing = false;
	view.predictionOn = false;
	view.penHistory = [];
	view.lastTail = [];
	view.caretEl = null;
	// Empty, so pen-down reaches the ink branch rather than the grab. The
	// real class: Object.create skips field initialisers.
	view.selection = new SelectionModel();
	// Only the three fields `inkRefusal` reads; a real PageDocument wants a
	// vault behind it.
	view.doc = {
		spatialFutureVersion: undefined,
		spatialDamaged: false,
		page: { strokes: [], textBoxes: [], images: [] },
	};
	view.textLayer = { isEditing: false, rectOf: () => null };
	view.imageLayer = { rectOf: () => null };
	view.metrics = {
		begin: () => undefined,
		recordEvent: () => undefined,
		recordCorrection: () => undefined,
		recordAccepted: () => undefined,
		recordDraw: () => undefined,
		recordHandler: () => undefined,
	};
	view.penStyle = { ...DEFAULT_PEN };
	view.highlighterStyle = { ...DEFAULT_PEN };
	view.camera = {
		zoom: 1,
		snapshot: { x: 0, y: 0, zoom: 1 },
		screenToWorld: (x: number, y: number) => ({ x, y }),
	};
	view.wetInk = wet;
	view.wetHighlight = wet;
	view.tail = {
		clear: () => undefined,
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
	// DOM, a global `window` or a diagnostic, and none is the subject.
	view.redrawSelectionUI = () => undefined;
	view.lassoDown = () => undefined;
	view.startTicker = () => undefined;
	view.showEraserCursor = () => undefined;
	view.eraseAt = () => undefined;
	view.schedulePresentProbe = () => undefined;

	const proto = HandwritingPageView.prototype as unknown as {
		penDown(this: unknown, s: PenSample, ev: PointerEvent): void;
		penRaw(this: unknown, s: PenSample[], ev: PointerEvent, predicted: PenSample[]): void;
	};
	return {
		penDown: (s) => proto.penDown.call(view, s, TIP),
		penRaw: (s) => proto.penRaw.call(view, s, TIP, []),
		asked,
		widths,
	};
}

describe("the canvas surface's contact draw is floored and its moving draw is not", () => {
	beforeEach(() => resetTipModeForTest());
	afterEach(() => resetTipModeForTest());

	it("asks for the floored width at contact and the live width after", () => {
		const rig = makeRig();

		rig.penDown(sample(100, 100));
		rig.penRaw([sample(130, 130)]);
		rig.penRaw([sample(160, 160)]);

		// `drawContact` first, then `updateOverlay` for every move. Sharing
		// one site would have forced a choice between a tap drawn at the
		// shaper's 12% tip floor and a stroke that never tapers.
		expect(rig.asked[0]).toBe("contact");
		expect(rig.asked.slice(1)).not.toContain("contact");
		expect(rig.asked.slice(1)).toContain("live");
		expect(rig.widths[0]).toBe(CONTACT_HW);
		expect(rig.widths.length).toBeGreaterThan(1);
		expect(rig.widths.slice(1).every((w) => w === LIVE_HW)).toBe(true);
	});

	it("a tap that never moves is drawn once, at the floored width", () => {
		const rig = makeRig();

		// `drawContact` is ungated on `head()` precisely so this case draws:
		// the smoother has nothing to report at pen-down, and with smoothing
		// off (boox) it never will, so a gated draw would put a tap back to
		// nothing at all.
		rig.penDown(sample(100, 100));

		expect(rig.asked).toEqual(["contact"]);
		expect(rig.widths).toEqual([CONTACT_HW]);
	});

	it("draws a tap at exactly the nib whatever the pressure", () => {
		const nib = DEFAULT_PEN.baseWidth / 2;
		expect(LIVE_HW).toBeLessThan(nib);

		for (const pressure of [0, 0.05, 0.5, 0.9, 1]) {
			const rig = makeRig(true);

			rig.penDown(sample(100, 100, pressure));

			expect(rig.widths, `pressure ${pressure}`).toEqual([nib]);
		}
	});
});
