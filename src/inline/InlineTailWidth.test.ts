/**
 * The note surface's predicted tail is sized from the pressure the wet ribbon
 * consumed (1.4.7-design C21 / §5n - the seventh instance of P1).
 *
 * `InkOverlayPlugin` feeds its wet layer `gainedPressure(sample.pressure)`,
 * which is the adaptive gain plus `normalizeInlinePenPressure`, and used to
 * ask `liveWidthPx` for the tail width with the RAW sample pressure. Two
 * inputs, one width law, so the guessed ink ahead of the nib and the ribbon
 * behind it disagreed.
 *
 * SCOPE, and it is narrow: `liveHalfWidth` ignores its `pressure` argument on
 * the SHAPED branch (it returns `shaper.last()`), so the argument is dead for
 * a shaped pen stroke. It is live only on the UNSHAPED branch - every mouse
 * stroke (`wet.shape = !fromMouse` at pen-down) and every highlighter (`flat`
 * forces it). Both cases below therefore run unshaped: the stubbed wet layer
 * stands in for that branch and records what it was asked, which is the
 * question at issue.
 *
 * The stub, not the real `WetInkRenderer`, because the number under test is
 * the ARGUMENT and not the width computed from it. A real renderer on the
 * unshaped branch would fold the pressure into a width and the assertion
 * would then be about `widthForPressure`'s arithmetic rather than about which
 * pressure reached it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { InkOverlayPlugin } from "./InkOverlay";
import { CameraState } from "../camera/coordinates";
import { DEFAULT_PEN, PenStyle } from "../ink/PenStyle";
import { InkPoint } from "../ink/Stroke";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { resetLatencyEstimate } from "../ink/LatencyEstimate";
import { PenSample } from "../input/PointerRouter";
import { setPrediction } from "./StrokePrediction";

describe("the note predicted tail takes the pressure the ribbon consumed", () => {
	/**
	 * Gain 2 with a raw 0.4 gives a gained 0.8, so the two numbers are far
	 * apart and neither is a clamp artefact. `strokeGain` is frozen at
	 * pen-down for the whole stroke, so setting it on the harness is exactly
	 * what pen-down would have left there.
	 */
	const GAIN = 2;
	const RAW = 0.4;
	const GAINED = 0.8;
	/** Rejected by the dedupe below; gains to 1.0, which is neither of the above. */
	const RAW_LATE = 0.9;
	const GAINED_LATE = 1;
	/**
	 * World units of travel the builder needs before it accepts a sample.
	 * Larger than the 0.15 default so a deliberately-rejected sample can sit
	 * 2 px behind the last accepted one and still leave the recent path fast
	 * enough for `buildTail`'s speed gate.
	 */
	const MIN_DIST = 3;
	const CAM: CameraState = { x: 0, y: 0, zoom: 2 };
	/** Straight and quick: clears the parked-pen speed gate, no turn to guard. */
	const HISTORY: PenSample[] = Array.from({ length: 8 }, (_, i) => ({
		x: i * 6,
		y: 5,
		pressure: RAW,
		timestamp: i * 4,
		tiltX: 0,
		tiltY: 0,
	}));
	/** One predicted sample, inside DEFAULT_CAPS' 12 ms horizon and 10 px reach. */
	const PREDICTED: PenSample[] = [
		{ x: 46, y: 5, pressure: RAW, timestamp: 30, tiltX: 0, tiltY: 0 },
	];
	/** A sentinel width, so no assertion can be satisfied by a width law. */
	const LIVE_PX = 0.375;

	/** What the tail asked the wet layer for, recorded verbatim. */
	interface WidthAsk {
		zoom: number;
		style: PenStyle;
		pressure: number;
	}
	interface RawHarness {
		penRaw(samples: PenSample[], ev: PointerEvent): void;
	}
	interface Rig {
		view: RawHarness;
		/** Pressures the ribbon was actually handed, in order. */
		consumed: number[];
		asks: WidthAsk[];
		draws: number[];
		/** Swapped between events; the router's answer for the next one. */
		setPredicted(samples: PenSample[]): void;
		rawMax(): number;
	}

	function makeRig(): Rig {
		const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
		const consumed: number[] = [];
		const asks: WidthAsk[] = [];
		const draws: number[] = [];
		let predicted: PenSample[] = PREDICTED;

		const builder = new StrokeBuilder("pen", DEFAULT_PEN.color, DEFAULT_PEN.baseWidth, MIN_DIST);
		builder.start(0);
		view.builder = builder;
		view.mode = "ink";
		view.activeStyle = { ...DEFAULT_PEN };
		view.strokeGain = GAIN;
		view.strokeRawMax = 0;
		view.rawLastMoveT = 0;
		view.rawLastMoveX = 0;
		view.rawLastMoveY = 0;
		view.predReal = [];
		view.predLastTail = [];
		view.presentProbePending = false;
		view.camera = {
			snapshot: CAM,
			screenToWorld: (x: number, y: number) => ({ x, y }),
		};
		view.router = { predictedSamples: () => predicted };
		// `winRef` is a getter over the editor's own window, so the harness
		// reaches it the way the class does rather than assigning past it.
		view.view = {
			dom: { ownerDocument: { defaultView: { requestAnimationFrame: () => 0 } } },
		};
		view.activeWet = {
			appendPoint: (_cam: CameraState, _style: PenStyle, point: InkPoint) => {
				// The number, not the point: `StrokeBuilder.add` mutates the
				// retained point's pressure when it rejects a later sample,
				// so a reference here would silently change under the test.
				consumed.push(point.pressure);
			},
			// No live head: a raw centerline returns undefined from head()
			// anyway, and the assertions below are about the tail alone.
			head: () => undefined,
			liveWidthPx: (cam: CameraState, style: PenStyle, pressure: number) => {
				asks.push({ zoom: cam.zoom, style, pressure });
				return LIVE_PX;
			},
		};
		view.tail = {
			clear: () => undefined,
			drawHead: () => undefined,
			draw: (
				_x: number,
				_y: number,
				_points: PenSample[],
				_color: string,
				widthPx: number
			) => {
				draws.push(widthPx);
			},
		};

		return {
			view: view as unknown as RawHarness,
			consumed,
			asks,
			draws,
			setPredicted: (s: PenSample[]) => {
				predicted = s;
			},
			rawMax: () => view.strokeRawMax as number,
		};
	}

	const EVENT = { timeStamp: 0 } as unknown as PointerEvent;

	beforeEach(() => {
		// `adaptiveCaps(presentLagMs())` falls back to DEFAULT_CAPS while the
		// estimate is empty, which is the horizon the fixtures are sized for.
		resetLatencyEstimate();
		setPrediction(true);
	});

	it("the tail is asked with the gained pressure, not the raw sample", () => {
		const rig = makeRig();
		// Preconditions: the two pressures have to genuinely differ, or the
		// assertion below is satisfied by the code it is meant to reject.
		expect(GAINED).not.toBeCloseTo(RAW);

		rig.view.penRaw(HISTORY, EVENT);

		// A ribbon that consumed nothing, or a tail that drew nothing, would
		// make every width assertion here vacuous.
		expect(rig.consumed.length).toBeGreaterThan(0);
		expect(rig.consumed[rig.consumed.length - 1]).toBeCloseTo(GAINED);
		expect(rig.draws).toEqual([LIVE_PX]);

		expect(rig.asks).toHaveLength(1);
		expect(rig.asks[0]!.pressure).toBe(rig.consumed[rig.consumed.length - 1]);
		expect(rig.asks[0]!.pressure).not.toBeCloseTo(RAW);
		// The camera and the active style still reach the accessor unchanged.
		expect(rig.asks[0]!.zoom).toBe(CAM.zoom);
		expect(rig.asks[0]!.style.baseWidth).toBe(DEFAULT_PEN.baseWidth);
	});

	it("a sample the dedupe rejected never sizes the tail", () => {
		const rig = makeRig();
		rig.view.penRaw(HISTORY, EVENT);
		const consumedByRibbon = rig.consumed.length;

		// 2 world units behind the last accepted sample, so the builder keeps
		// its point and the ribbon is handed nothing - but `gainedPressure`
		// has still seen it, which is why re-deriving the tail's pressure
		// from the newest sample is not the same thing as reading what the
		// ribbon consumed.
		const late: PenSample[] = [
			{ x: 44, y: 5, pressure: RAW_LATE, timestamp: 32, tiltX: 0, tiltY: 0 },
		];
		rig.setPredicted([{ x: 48, y: 5, pressure: RAW_LATE, timestamp: 36, tiltX: 0, tiltY: 0 }]);

		rig.view.penRaw(late, EVENT);

		// Preconditions: the ribbon really did refuse the sample, the tail
		// really was drawn a second time, and the three candidate pressures
		// are three different numbers.
		expect(rig.consumed).toHaveLength(consumedByRibbon);
		expect(rig.draws).toHaveLength(2);
		expect(rig.asks).toHaveLength(2);
		expect(GAINED_LATE).not.toBeCloseTo(GAINED);
		expect(RAW_LATE).not.toBeCloseTo(GAINED);

		expect(rig.asks[1]!.pressure).toBe(rig.consumed[rig.consumed.length - 1]);
		expect(rig.asks[1]!.pressure).toBeCloseTo(GAINED);
		// Not the raw sample, and not that sample re-gained either: a second
		// `gainedPressure` call at the tail site would land on GAINED_LATE,
		// and would also push the sample into `strokeRawMax` twice.
		expect(rig.asks[1]!.pressure).not.toBeCloseTo(RAW_LATE);
		expect(rig.asks[1]!.pressure).not.toBeCloseTo(GAINED_LATE);
		// The gain's running maximum is the raw loop's business alone, and
		// the raw loop saw this sample exactly once.
		expect(rig.rawMax()).toBeCloseTo(RAW_LATE);
	});
});
