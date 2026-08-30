import { describe, expect, it } from "vitest";
import { StrokeMetrics } from "./StrokeMetrics";

/**
 * Prediction state is per stroke, and `predMode` was the one field that was
 * not.
 *
 * Once any stroke had predicted, every later report said `pred on` - even
 * strokes drawn with the setting off. Combined with the tail counters, which
 * DO reset, that produced the reading "prediction is on and producing
 * nothing", and sent a flicker hunt after a feature that was not running
 * (alan, hardware, 2026-08-30). A Boox user reporting that toggling
 * prediction changed nothing either way was the same story from outside.
 */
describe("StrokeMetrics prediction reporting", () => {
	it("does not leak predMode from one stroke into the next", () => {
		const m = new StrokeMetrics();
		m.begin("ink", 0);
		m.setPrediction("on", "extrap");
		expect(m.end(10).predMode).toBe("on");

		// Second stroke with prediction off: nothing calls setPrediction.
		m.begin("ink", 20);
		const second = m.end(30);
		expect(second.predMode).toBe("off");
		expect(second.predApi).toBe("unknown");
	});

	it("reports on for a stroke that really did predict", () => {
		const m = new StrokeMetrics();
		m.begin("ink", 0);
		m.setPrediction("on", "chromium");
		const s = m.end(10);
		expect(s.predMode).toBe("on");
		expect(s.predApi).toBe("chromium");
	});

	// The pairing that made the stale mode legible: once a stroke predicts,
	// exactly one of these counters moves per event. Both at zero while the
	// mode reads "on" is not "producing nothing" - it is "never ran".
	it("tail counters reset per stroke, so zero means this stroke", () => {
		const m = new StrokeMetrics();
		m.begin("ink", 0);
		m.setPrediction("on", "extrap");
		m.recordTail(4, 12, 3);
		expect(m.end(10).predTails).toBe(1);

		m.begin("ink", 20);
		expect(m.end(30).predTails).toBe(0);
	});
});
