/**
 * Drive a recorded TraceCapture back through the REAL InlinePenRouter and a
 * REAL StrokeBuilder, and report what came out. A stranger's Boox session
 * becomes a regression test that runs on any desk.
 *
 * The router is the injection point deliberately: every input bug actually
 * fought in this plugin lived there, and the trace already records its
 * verdicts. The builder rides along for free because the router feeds it -
 * so geometry regressions surface here too, without a CodeMirror view.
 */

import {
	captureInlinePenTrace,
	clearInlinePenTrace,
	summarizeAcquisitions,
	TraceCapture,
	TraceEntry,
} from "../src/inline/InlinePenRouter";
import { StrokeBuilder } from "../src/ink/StrokeBuilder";
import { InkStroke } from "../src/ink/Stroke";
import { PenSample } from "../src/input/PointerRouter";
import { diagnosticsEnabled, setDiagnosticsEnabled } from "../src/diag/DiagSwitch";
import { harness, penEvent } from "./routerHarness";

export interface ReplayResult {
	strokes: InkStroke[];
	counts: ReturnType<typeof summarizeAcquisitions>;
	/** The router's OWN rows from the replay run, for re-summarizing. */
	traceRows: TraceEntry[];
	/** pointerup + pointercancel rows dispatched, for the no-orphan check. */
	endsSeen: number;
}

/** The event types the router registers on the element; everything else in
 * a capture (guard rows, window-pointerdown, suppressed) is the router's
 * own commentary and is not replayed - the replay must REPRODUCE those. */
const DISPATCHED = new Set([
	"pointerdown",
	"pointermove",
	"pointerrawupdate",
	"pointerup",
	"pointercancel",
]);

export function replayTrace(cap: TraceCapture): ReplayResult {
	clearInlinePenTrace();

	// Trace rows are only pushed while diagnosticsEnabled() (InlinePenRouter's
	// tr(), gated at the top) - a caller that forgot to flip the switch would
	// get claimed = 0 silently, and an assertion like toBe(0) would pass for
	// the wrong reason. So the replay records the switch's own state, forces
	// it on for itself, and restores it - the switch is session-scoped by
	// design (DiagSwitch.ts) and a replay is not a session. Audit doc §5j/J3.
	const wasEnabled = diagnosticsEnabled();
	setDiagnosticsEnabled(true);
	try {
		const h = harness();

		// A real builder, wired the way the overlay wires it: begin on down,
		// samples from onPenRaw, finish on up. Fixed style - the capture's job
		// is input fidelity; color and width change nothing about routing.
		let builder: StrokeBuilder | null = null;
		const strokes: InkStroke[] = [];
		h.rec.cb.onPenDown = (sample: PenSample) => {
			builder = new StrokeBuilder("pen", "#000000", 2);
			builder.add(sample.x, sample.y, sample.pressure, sample.timestamp);
		};
		h.rec.cb.onPenRaw = (samples: PenSample[]) => {
			for (const s of samples) builder?.add(s.x, s.y, s.pressure, s.timestamp);
		};
		h.rec.cb.onPenUp = () => {
			const done = builder?.finish();
			if (done) strokes.push(done);
			builder = null;
		};

		let endsSeen = 0;
		// Deduplicate: the ink-fed move path writes its own row AND the raw
		// handler writes one per event, but each DISPATCH appears once in the
		// capture per (type, t). Replay rows in order; rows that share type and
		// timestamp with the previous replayed row are the router's second
		// annotation of the same dispatch, not a second dispatch.
		let prevKey = "";
		for (const row of cap.events) {
			if (!DISPATCHED.has(row.type)) continue;
			const key = `${row.type}@${row.t}`;
			if (key === prevKey) continue;
			prevKey = key;
			if (row.type === "pointerup" || row.type === "pointercancel") endsSeen++;
			h.fire(
				penEvent(row.type, row.t, {
					x: row.x,
					y: row.y,
					pressure: row.pressure,
					buttons: row.buttons,
					pointerType: row.ptr || "pen",
					tiltX: row.tx,
					tiltY: row.ty,
					coalescedSamples: row.cs?.map((c) => ({
						t: c.t,
						x: c.x,
						y: c.y,
						pressure: c.p,
					})),
				})
			);
		}

		const traceRows = captureInlinePenTrace({}).events;
		return {
			strokes,
			counts: summarizeAcquisitions(traceRows),
			traceRows,
			endsSeen,
		};
	} finally {
		setDiagnosticsEnabled(wasEnabled);
	}
}
