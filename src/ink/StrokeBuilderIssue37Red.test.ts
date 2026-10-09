import { describe, expect, it } from "vitest";

import { StrokeBuilder } from "./StrokeBuilder";

/**
 * GitHub issue 37: "when drawing lines, occasionally the line gets interrupted"
 * (Surface Pen 2, Linux, 1.3.7). Hypothesis under test: a pressure dip in the
 * MIDDLE of one contact, short and travelling a few pixels, is read by the
 * release filter as release travel, so one drawn line is saved as two strokes
 * with the dipped samples removed between them.
 *
 * This file holds the RED cell only. It fails at the base while the hypothesis
 * stands. The control cells that must stay green live in
 * StrokeBuilderIssue37Controls.test.ts.
 */
function builder(): StrokeBuilder {
	const value = new StrokeBuilder("pen", "#377dff", 2);
	value.start(1000);
	return value;
}

describe("issue 37: a mid-stroke pressure dip inside one contact", () => {
	it("keeps one stroke with every sample when pressure dips to 0.01 for 10 ms over 5 px and recovers to 0.3", () => {
		const value = builder();
		// Confident contact, steady rightward line.
		value.add(0, 0, 0.3, 1000);
		value.add(2, 0, 0.3, 1006);
		// The dip: two light samples, 10 ms from the last good sample, 5 px of travel.
		value.add(4, 0, 0.01, 1010);
		value.add(7, 0, 0.01, 1016);
		// Pressure comes straight back; the same contact, no lift between.
		value.add(10, 0, 0.3, 1020);
		value.add(14, 0, 0.3, 1026);

		const strokes = value.finishReleaseFiltered();

		// One line was drawn, so one stroke with all six samples is expected.
		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x)).toEqual([0, 2, 4, 7, 10, 14]);
	});
});
