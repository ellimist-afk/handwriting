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
	formatInlinePenTrace,
	summarizeAcquisitions,
	TraceCapture,
} from "./InlinePenRouter";
import { harness, installFakeWindow, penEvent } from "../../test/routerHarness";
import { replayTrace } from "../../test/replayTrace";

import chromiumStream from "../../test/traces/synthetic-chromium-stream.json";
import webkitStream from "../../test/traces/synthetic-webkit-stream.json";
import hoverOnly from "../../test/traces/synthetic-hover-only.json";
import surfacePenFirstReal from "../../test/traces/surface-pen-first-real.json";

const FIXTURE_MAP: Record<string, unknown> = {
	"synthetic-chromium-stream.json": chromiumStream,
	"synthetic-webkit-stream.json": webkitStream,
	"synthetic-hover-only.json": hoverOnly,
	"surface-pen-first-real.json": surfacePenFirstReal,
};
// Through JSON.parse(JSON.stringify()) so a test mutating a fixture cannot
// leak into its neighbor - imports are shared module objects.
const fixture = (name: string): TraceCapture =>
	JSON.parse(JSON.stringify(FIXTURE_MAP[name])) as TraceCapture;

// replayTrace() now flips DiagSwitch itself (test/replayTrace.ts, audit doc
// §5j/J3), so the describes below that go through it no longer need the
// switch set here. The capture-fidelity describe still calls
// captureInlinePenTrace() directly, without a replay, so it keeps its own
// scoped on/off beside the tests that need it.
let uninstallWindow: () => void = () => {};
beforeAll(() => {
	uninstallWindow = installFakeWindow();
});
afterAll(() => {
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
	// These call captureInlinePenTrace() directly, not through replayTrace(),
	// so they still need the switch on themselves - trace rows are only
	// pushed while diagnosticsEnabled() (InlinePenRouter's tr()).
	beforeAll(() => setDiagnosticsEnabled(true));
	afterAll(() => setDiagnosticsEnabled(false));

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

// ---- suppressed native events -----------------------------------------------
//
// traceSuppressed() (the ownership guard's window-capture listener, armed for
// the life of a claimed stroke) does its own de-dupe bookkeeping - at most one
// "suppressed" trace line per native event TYPE per ownership window, tracked
// in a Set the router clears at the next armOwnership(). That bookkeeping must
// run strictly BEHIND the diagnostics gate: a type marked "already traced"
// while recording was off has never actually appeared in any trace, so it
// must still write its first line once recording turns on.

/** A native event the ownership guard's window listener can suppress. */
function nativeEvent(type: string): PointerEvent {
	let prevented = false;
	return {
		type,
		pointerType: undefined,
		preventDefault: () => void (prevented = true),
		stopPropagation: () => {},
		get defaultPrevented() {
			return prevented;
		},
	} as unknown as PointerEvent;
}

describe("suppressed native events: de-dupe bookkeeping stays behind the gate", () => {
	afterEach(() => setDiagnosticsEnabled(false));

	it("a type suppressed while OFF still gets its first trace line once ON", () => {
		setDiagnosticsEnabled(false);
		const h = harness();
		h.fire(penEvent("pointerdown", 100)); // claims the stroke, arms ownership

		h.fireWin(nativeEvent("click")); // suppressed, but recording is off

		setDiagnosticsEnabled(true);
		h.fireWin(nativeEvent("click")); // same type, now recording

		const events = captureInlinePenTrace({}).events;
		const suppressedLines = events.filter((e) => e.type === "suppressed");
		expect(suppressedLines).toHaveLength(1);
		expect(suppressedLines[0]?.note).toContain("click");
	});

	it("diagnostics OFF the whole time: no trace entry at all (unchanged)", () => {
		setDiagnosticsEnabled(false);
		const h = harness();
		h.fire(penEvent("pointerdown", 100));

		h.fireWin(nativeEvent("click"));

		expect(captureInlinePenTrace({}).events).toHaveLength(0);
	});

	it("SUMMARY carries the suppressed count, and it resets with the trace clear", () => {
		setDiagnosticsEnabled(true);
		const h1 = harness();
		h1.fire(penEvent("pointerdown", 100));
		h1.fireWin(nativeEvent("click"));
		h1.fireWin(nativeEvent("mousedown"));

		const before = formatInlinePenTrace();
		expect(before).toContain("2 native event(s) suppressed by the ownership guard");

		clearInlinePenTrace();

		// A fresh router: a fresh de-dupe set, so this is a clean single count
		// rather than a dedupe artifact of the router used above.
		const h2 = harness();
		h2.fire(penEvent("pointerdown", 200));
		h2.fireWin(nativeEvent("click"));

		const after = formatInlinePenTrace();
		expect(after).toContain("1 native event(s) suppressed by the ownership guard");
	});

	it("a new recording starts with the SAME router's de-dupe set empty", () => {
		// The test above says it out loud - "a fresh router: a fresh de-dupe
		// set" - and that was the only reason it could count at all. A bug
		// report is recorded from a pane that has been open all along, so the
		// router is the one that was already there: `clearInlinePenTrace()`
		// reset the buffer and the counter and left every live router's
		// `suppressedTraced` holding whatever the PREVIOUS recording had
		// already de-duped. The first click of the new recording - the strip
		// tap this trace exists to explain - then wrote nothing, and nothing
		// on the timeline said a line had been withheld.
		setDiagnosticsEnabled(true);
		const h = harness();
		h.fire(penEvent("pointerdown", 100)); // claims the stroke, arms ownership
		h.fireWin(nativeEvent("click"));
		expect(
			captureInlinePenTrace({}).events.filter((e) => e.type === "suppressed")
		).toHaveLength(1);

		// The recording the user actually keeps, started without the pen ever
		// lifting: the ownership window is the same one, so nothing calls
		// `armOwnership()` to clear the set on the way in.
		clearInlinePenTrace();
		h.fireWin(nativeEvent("click"));

		const lines = captureInlinePenTrace({}).events.filter((e) => e.type === "suppressed");
		expect(lines, "the type stayed de-duped from the previous recording").toHaveLength(1);
		expect(lines[0]?.note).toContain("click");
	});
});

// ---- replay invariants ------------------------------------------------------

// surface-pen-first-real.json is the one real device capture in the repo
// (a Surface pen, Obsidian 1.12.7 / Chromium) - the other three are
// synthetic. It gets the same invariants below, plus its own explicit case.
const FIXTURES = [
	"synthetic-chromium-stream.json",
	"synthetic-webkit-stream.json",
	"surface-pen-first-real.json",
];

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

	it("surface pen, real device capture: one claimed stroke, densely sampled", () => {
		// 370 events, one pointerdown/up pair, 185 pointerrawupdate rows - the
		// point count depends on prediction and coalescing tuning that legitimately
		// drifts, so this asserts "densely sampled" (> 100) rather than an exact
		// count. Audit doc §5j/J3.
		const r = replayTrace(fixture("surface-pen-first-real.json"));
		expect(r.counts.claimed).toBe(1);
		expect(r.strokes.length).toBe(1);
		expect(r.strokes[0]!.points.length).toBeGreaterThan(100);
	});
});
