/**
 * The replay harness: a recorded pen trace, driven back through the REAL
 * router, so a stranger's Boox session becomes a regression test that runs
 * on this desk forever. The reference failure is Ink's issue #193 - a Wacom
 * regression its author cannot fix because the hardware is gone.
 *
 * Injection is at InlinePenRouter deliberately: every input bug actually
 * fought here lived in the router (cold-pen dead zone, palm parole, cancel
 * handling, the standing guard), and the trace already records the router's
 * own verdicts because it was built to debug exactly that layer.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { setMouseInk } from "./MouseInk";
import { markPenSeen, resetPenToolsForTest } from "./PenToolsMode";
import {
	captureInlinePenTrace,
	clearInlinePenTrace,
	summarizeAcquisitions,
	TraceCapture,
} from "./InlinePenRouter";
import { harness, installFakeWindow, penEvent } from "../../test/routerHarness";
import { replayTrace } from "../../test/replayTrace";

import chromiumStream from "../../test/traces/synthetic-chromium-stream.json";
import webkitStream from "../../test/traces/synthetic-webkit-stream.json";
import hoverOnly from "../../test/traces/synthetic-hover-only.json";

const FIXTURE_MAP: Record<string, unknown> = {
	"synthetic-chromium-stream.json": chromiumStream,
	"synthetic-webkit-stream.json": webkitStream,
	"synthetic-hover-only.json": hoverOnly,
};
// Through JSON.parse(JSON.stringify()) so a test mutating a fixture cannot
// leak into its neighbor - imports are shared module objects.
const fixture = (name: string): TraceCapture =>
	JSON.parse(JSON.stringify(FIXTURE_MAP[name])) as TraceCapture;

let uninstallWindow: () => void = () => {};
beforeAll(() => {
	uninstallWindow = installFakeWindow();
	setDiagnosticsEnabled(true);
});
afterAll(() => {
	setDiagnosticsEnabled(false);
	uninstallWindow();
});
afterEach(() => {
	clearInlinePenTrace();
	setMouseInk(false);
	resetPenToolsForTest();
	markPenSeen();
});

// ---- capture fidelity -------------------------------------------------------

describe("capture: the trace records what the ink consumed", () => {
	it("keeps fractional coordinates - the ink path uses them unrounded", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100, { x: 400.6, y: 300.4 }));
		h.fire(penEvent("pointerup", 120, { pressure: 0, buttons: 0 }));
		const cap = captureInlinePenTrace({ note: "test" });
		const down = cap.events.find((e) => e.type === "pointerdown");
		expect(down?.x).toBe(400.6);
		expect(down?.y).toBe(300.4);
	});

	it("keeps every coalesced sample, not just the dispatched event", () => {
		// The RC4 comment in the router says it plainly: the coalesced array
		// is NOT diagnostic, it IS the ink. A capture without it replays an
		// iPad's 4-samples-per-move stream as single points - different
		// geometry, silently.
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		h.fire(
			penEvent("pointerrawupdate", 116, {
				coalescedSamples: [
					{ t: 104, x: 101.5, y: 100.2, pressure: 0.41 },
					{ t: 108, x: 103.1, y: 100.9, pressure: 0.44 },
					{ t: 112, x: 105.0, y: 101.7, pressure: 0.46 },
					{ t: 116, x: 106.4, y: 102.1, pressure: 0.47 },
				],
			})
		);
		h.fire(penEvent("pointerup", 124, { pressure: 0, buttons: 0 }));
		const cap = captureInlinePenTrace({ note: "test" });
		const raw = cap.events.find((e) => e.type === "pointerrawupdate");
		expect(raw?.cs).toHaveLength(4);
		expect(raw?.cs?.[2]).toMatchObject({ x: 105.0, y: 101.7 });
	});

	it("unknown fields on a capture survive the round trip a fixture takes", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointerup", 110, { pressure: 0, buttons: 0 }));
		const cap = captureInlinePenTrace({ note: "test" });
		const json = JSON.parse(JSON.stringify(cap));
		json.futureField = "from-2.0";
		json.events[0].futureNote = "kept";
		const back = JSON.parse(JSON.stringify(json)) as TraceCapture & {
			futureField?: string;
		};
		expect(back.futureField).toBe("from-2.0");
		expect((back.events[0] as { futureNote?: string }).futureNote).toBe("kept");
	});
});

// ---- replay invariants ------------------------------------------------------

const FIXTURES = ["synthetic-chromium-stream.json", "synthetic-webkit-stream.json"];

describe("replay invariants, every fixture", () => {
	for (const name of FIXTURES) {
		describe(name, () => {
			it("every claimed pointerdown becomes exactly one stroke", () => {
				const r = replayTrace(fixture(name));
				expect(r.strokes.length).toBe(r.counts.claimed);
			});

			it("no stroke ends without an up or a cancel", () => {
				const r = replayTrace(fixture(name));
				expect(r.endsSeen).toBeGreaterThanOrEqual(r.strokes.length);
			});

			it("acquisition counts match the replayed router's own trace", () => {
				const r = replayTrace(fixture(name));
				const again = summarizeAcquisitions(r.traceRows);
				expect(again.claimed).toBe(r.counts.claimed);
			});
		});
	}

	it("a hover-only sequence produces zero strokes", () => {
		const r = replayTrace(fixture("synthetic-hover-only.json"));
		expect(r.strokes.length).toBe(0);
		expect(r.counts.claimed).toBe(0);
	});
});

// ---- goldens ---------------------------------------------------------------

describe("goldens: counts and rounded bboxes, never full point arrays", () => {
	// Full point snapshots churn on every legitimate retune (the prediction
	// horizon halved in 1.3.9 and would have broken all of them). Counts and
	// a rounded bbox catch "the letters came out wrong" without that.
	it("chromium stream", () => {
		const r = replayTrace(fixture("synthetic-chromium-stream.json"));
		expect(r.strokes.length).toBe(1);
		expect(r.strokes[0]!.points.length).toBe(6);
		// Painted extent, not point extent: computeBBox pads by the stroke
		// width, so the corner sits half a nib above-left of the first point.
		const b = r.strokes[0]!.bbox;
		expect([Math.round(b.x), Math.round(b.y)]).toEqual([97, 97]);
	});

	it("webkit stream", () => {
		const r = replayTrace(fixture("synthetic-webkit-stream.json"));
		expect(r.strokes.length).toBe(1);
		expect(r.strokes[0]!.points.length).toBe(6);
	});
});
