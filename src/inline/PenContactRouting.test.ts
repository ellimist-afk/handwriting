/**
 * Both ink surfaces OBEY `penContactIntent`, rather than merely agreeing with
 * it today.
 *
 * `penContactIntent` (TipMode.ts) is the whole arbitration between the
 * hardware a pen has and the mode the strip is in - eraser end erases, side
 * button lassos, tip inks, and each meaning also has a mode for hardware with
 * neither button. It was written twice, once per surface, months apart, and
 * that is how the side button came to be honoured on a note and not on a pdf
 * (hardware, 2026-08-29). `2e46d1a` deleted both copies and pointed both
 * `penDown` methods at the one function.
 *
 * WHAT WAS NOT COVERED, and it is the whole reason this file exists. The
 * function's SEMANTICS are pinned hard by `TipMode.test.ts` - drop its
 * `m === "eraser"` arm and nine tests across both surfaces go red. What
 * nothing observed was that either surface still CALLS it. Reverse-applying
 * `2e46d1a` - both surfaces back to their own hand-written arbitration,
 * `penContactIntent` called by nothing in production, a comment naming it
 * left on each - was fully green. A unification nothing checks can silently
 * un-unify, and this project's most expensive recurring defect is a rule that
 * reached one surface and not the other.
 *
 * WHY THIS IS NOT A MARKER. A marker is what already failed here: the surface
 * registry's presence sweep asks whether a symbol appears in a file, and both
 * files can name the function in a comment, in an unused import, or in a call
 * whose answer they then ignore. So this drives each surface's real `penDown`
 * with `penContactIntent` REPLACED, and asserts the gesture the surface
 * enters is the one the replacement returned.
 *
 * The load-bearing case is the last pair: the event says ERASER END and the
 * stand-in answers "ink". Every correct hand-written arbitration ever written
 * on either surface answers "erase" to that event - `buttons & 32` is the
 * first line of all three versions of this rule - so a surface that has gone
 * back to deciding for itself cannot pass it. The other four cases are the
 * same shape held the other way round: a bare tip, whose own answer is "ink",
 * routed to each of the four gestures in turn.
 *
 * The arguments are asserted too, not only the answer. A surface that called
 * the shared function with the wrong event fields would obey a decision made
 * about something that did not happen.
 *
 * WHAT THIS DOES NOT PROVE: that the arbitration is RIGHT. That is
 * `TipMode.test.ts`'s job and it is a separate question. This proves only
 * that there is one arbitration and that both surfaces are downstream of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PenContactIntent, TipMode as TipModeName } from "./TipMode";
import { PenSample } from "../input/PointerRouter";
import { SelectionModel } from "../objects/SelectionModel";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { InkStroke } from "../ink/Stroke";

/**
 * The stand-in's state, hoisted because `vi.mock`'s factory runs before the
 * module body. `forced` null means "answer exactly as the real one would", so
 * the harness itself never depends on the override being set.
 */
const shared = vi.hoisted(() => ({
	forced: null as PenContactIntent | null,
	calls: [] as Array<{ buttons: number; button: number; mode: string }>,
}));

vi.mock("./TipMode", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./TipMode")>();
	return {
		...actual,
		penContactIntent: (buttons: number, button: number, mode: TipModeName) => {
			shared.calls.push({ buttons, button, mode });
			return shared.forced ?? actual.penContactIntent(buttons, button, mode);
		},
	};
});

/**
 * The viewer probe, the one thing the pdf harness stubs - page geometry, hit
 * testing, selection and history are all the real code, exactly as
 * `PdfInkController.test.ts` has it.
 */
const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../pdf/PdfViewerProbe", () => ({ probeViewer: () => probe.current }));

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

import { InkOverlayPlugin } from "./InkOverlay";
import { resetTipModeForTest, setTipMode } from "./TipMode";
import { PdfInkController } from "../pdf/PdfInkController";
import { applyOp } from "../pdf/PdfInkHistory";

/** css px per point, as `--scale-factor` reports it. */
const SCALE = 2;

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

/** A bare tip: contact, no side button (bit 2), no eraser end (bit 32). */
const TIP = { buttons: 1, button: 0, clientX: 200, clientY: 200, timeStamp: 0 };
/** The eraser end, held. Every hand-written copy answers "erase" to this. */
const ERASER_END = { buttons: 32, button: 5, clientX: 200, clientY: 200, timeStamp: 0 };

/** The gesture a surface entered, in one word, however it records it. */
type Gesture = "erase" | "lasso" | "pan" | "space" | "ink";

interface Surface {
	/** A pen contact through the surface's own `penDown`. */
	contact(ev: Record<string, number>): void;
	gesture(): Gesture | "none";
}

// ---- the note surface ---------------------------------------------------

function noteSurface(): Surface {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	let gesture: Gesture | "none" = "none";

	const wet = {
		shape: true,
		beginStroke: () => undefined,
		appendPoint: () => undefined,
		head: () => undefined,
		liveHalfWidth: () => 1,
		contactHalfWidth: () => 1,
		liveWidthPx: () => 1,
	};

	view.mode = "ink";
	view.scale = 1;
	view.erased = [];
	view.eraseFrom = [];
	view.eraseWhole = true;
	view.penCursorEl = null;
	view.router = null;
	view.mobileTools = null;
	view.penStyle = { ...DEFAULT_PEN };
	view.highlighterStyle = { ...DEFAULT_PEN };
	view.wet = wet;
	view.highlightWet = wet;
	view.predReal = [];
	view.predLastTail = [];
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
	// Empty: the selection grab is a SEPARATE decision that deliberately did
	// not move into the shared function, and a live selection would let it
	// answer for a contact this file is asking a different question about.
	view.selection = new SelectionModel();
	view.tail = { clear: () => undefined, drawHead: () => undefined, draw: () => undefined };

	view.syncCamera = () => undefined;
	view.captureProbeGeometry = () => undefined;
	view.recordPenDownState = () => undefined;
	view.redrawSelectionUI = () => undefined;
	view.ensurePenTools = () => undefined;
	view.startFrameTicker = () => undefined;
	view.probeSample = () => undefined;
	view.schedulePresentProbe = () => undefined;
	view.drawPredictedTail = () => undefined;
	view.showEraserCursor = () => undefined;
	view.filePath = () => "";
	view.lassoDown = () => {
		gesture = "lasso";
	};
	view.spaceDown = () => {
		gesture = "space";
	};
	view.eraseAt = () => {
		gesture = "erase";
	};

	const proto = InkOverlayPlugin.prototype as unknown as {
		penDown(this: unknown, s: PenSample, ev: unknown): void;
	};
	return {
		contact(ev) {
			gesture = "none";
			proto.penDown.call(view, sample(200, 200), ev);
			// `mode` is the note surface's own record of which gesture it
			// entered, and it is set on every branch including ink. The
			// spies above are the corroboration, not the only witness.
			if (gesture === "none" && typeof view.mode === "string") {
				gesture = view.mode as Gesture;
			}
		},
		gesture: () => gesture,
	};
}

// ---- the pdf surface ----------------------------------------------------

function pdfSurface(): Surface {
	const scroller = {
		scrollLeft: 0,
		scrollTop: 0,
		classList: { add: () => {}, remove: () => {} },
		querySelector: () => null,
	};
	probe.current = {
		scroller,
		scaleFactor: SCALE,
		scaleSource: "test",
		pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
	};
	const win = {
		devicePixelRatio: 1,
		clearTimeout: () => {},
		setTimeout: () => 0,
		requestAnimationFrame: () => 0,
	};
	let strokes: InkStroke[] = [];
	const controller = new PdfInkController(
		{} as HTMLElement,
		win as unknown as Window,
		() => strokes,
		() => "doc-1",
		() => strokes,
		(op) => {
			strokes = applyOp(strokes, op);
		}
	);
	let gesture: Gesture | "none" = "none";

	const priv = controller as unknown as {
		pair: unknown;
		wetHostPage: number;
		pageSize: Map<number, { wPt: number; hPt: number }>;
		panLast: unknown;
		erasing: boolean;
		builder: unknown;
		lassoDown: unknown;
		eraseAt: unknown;
		notify: unknown;
		startFrameTicker: unknown;
	};
	// The page's size in points, which `cameraFor` needs and only a measured
	// page element would otherwise supply. 600 css px / 300 pt is SCALE.
	priv.pageSize.set(1, { wPt: 300, hPt: 400 });
	priv.pair = {
		wetCanvas: { setCssProps: () => {} },
		headCanvas: { setCssProps: () => {} },
		wet: {
			clear: () => {},
			shape: true,
			beginStroke: () => {},
			appendPoint: () => {},
			finishStroke: () => {},
			head: () => undefined,
			liveHalfWidth: () => 1,
			contactHalfWidth: () => 1,
			liveWidthPx: () => 1,
		},
		tail: { clear: () => {}, clearAll: () => {}, draw: () => {}, drawHead: () => {} },
	};
	priv.wetHostPage = 1;
	// Own properties on the instance, shadowing the prototype's: each of
	// these reaches a canvas or a Notice, and the branch taken is the subject.
	priv.startFrameTicker = () => undefined;
	priv.lassoDown = () => {
		gesture = "lasso";
	};
	priv.eraseAt = () => {
		gesture = "erase";
	};
	// The space branch's own refusal, and nothing else in `penDown` says it:
	// a pdf page cannot grow, so with no ink below the line it declines here.
	priv.notify = (msg: string) => {
		if (msg.includes("no ink below the line")) gesture = "space";
	};

	const pen = controller as unknown as {
		penDown(this: unknown, s: PenSample, ev: unknown): void;
	};
	return {
		contact(ev) {
			gesture = "none";
			priv.builder = undefined;
			priv.panLast = null;
			pen.penDown(sample(200, 200), ev);
			if (gesture !== "none") return;
			// No spy fired, so it is one of the two silent branches: pan
			// parks a drag origin, ink builds a stroke.
			if (priv.panLast) gesture = "pan";
			else if (priv.builder) gesture = "ink";
		},
		gesture: () => gesture,
	};
}

const SURFACES: Array<[string, () => Surface]> = [
	["note", noteSurface],
	["pdf", pdfSurface],
];

describe("both ink surfaces route their contact decision through penContactIntent", () => {
	beforeEach(() => {
		resetTipModeForTest();
		shared.forced = null;
		shared.calls.length = 0;
	});
	afterEach(() => {
		shared.forced = null;
		resetTipModeForTest();
	});

	for (const [name, make] of SURFACES) {
		describe(name, () => {
			it("hands the shared function this event's own buttons and the live tip mode", () => {
				setTipMode("pan");
				const surface = make();
				shared.calls.length = 0;

				surface.contact(ERASER_END);

				// One arbitration, asked once, about the contact that
				// happened. A surface that asked about something else would
				// be obeying a decision made about a different gesture.
				expect(shared.calls).toHaveLength(1);
				expect(shared.calls[0]).toEqual({ buttons: 32, button: 5, mode: "pan" });
			});

			// A bare tip answers "ink" to every arbitration ever written on
			// either surface, so each of these four is a gesture the surface
			// can only reach by taking the shared function's word for it.
			for (const forced of ["erase", "lasso", "pan", "space"] as const) {
				it(`follows the shared function into ${forced} on a bare tip`, () => {
					const surface = make();
					shared.forced = forced;

					surface.contact(TIP);

					expect(surface.gesture()).toBe(forced);
				});
			}

			it("inks on the eraser end when the shared function says ink", () => {
				// The case a hand-written copy cannot pass. `buttons & 32` is
				// the first line of every version of this rule, so a surface
				// still deciding for itself erases here whatever it was told.
				const surface = make();
				shared.forced = "ink";

				surface.contact(ERASER_END);

				expect(surface.gesture()).toBe("ink");
			});
		});
	}
});
