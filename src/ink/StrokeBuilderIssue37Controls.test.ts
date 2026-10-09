import { describe, expect, it } from "vitest";

import { StrokeBuilder } from "./StrokeBuilder";

/**
 * GitHub issue 37 controls. These pass at the base and must keep passing under
 * any fix for the mid-stroke dip: the release filter's real job stays done.
 * The red cell is StrokeBuilderIssue37Red.test.ts.
 */
function builder(): StrokeBuilder {
	const value = new StrokeBuilder("pen", "#377dff", 2);
	value.start(1000);
	return value;
}

describe("issue 37 controls: the release filter still does its job", () => {
	it("a real lift still trims the tail: pressure falls and stays low while the nib travels", () => {
		const value = builder();
		value.add(0, 0, 0.3, 1000);
		value.add(2, 0, 0.3, 1006);
		value.add(4, 0, 0.01, 1010);
		value.add(7, 0, 0.01, 1016);
		value.add(11, 0, 0.005, 1022);
		value.add(15, 0, 0, 1028);

		const strokes = value.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x)).toEqual([0, 2]);
	});

	it("a hover trail after the lift is still dropped: falling pressure then travel at zero", () => {
		const value = builder();
		value.add(0, 0, 0.4, 1000);
		value.add(3, 0, 0.35, 1005);
		value.add(6, 1, 0.012, 1012);
		value.add(12, 3, 0.003, 1020);
		value.add(20, 5, 0, 1028);
		value.add(30, 8, 0, 1036);

		const strokes = value.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x)).toEqual([0, 3]);
	});

	it("a short wobble under the gates stays in the one stroke: 6 ms and under 3 px", () => {
		const value = builder();
		value.add(0, 0, 0.3, 1000);
		value.add(2, 0, 0.3, 1006);
		// One light sample 4 ms after the last good one, 1 px of travel: under both gates.
		value.add(3, 0, 0.01, 1010);
		value.add(5, 0, 0.3, 1013);
		value.add(9, 0, 0.3, 1019);

		const strokes = value.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x)).toEqual([0, 2, 3, 5, 9]);
	});

	it("a light ending under the time gate or the travel gate stays in the stroke; at both gates it is trimmed", () => {
		// Only a light run with no recovery is trimmed now, so the 8 ms and 3 px gates guard the stroke's end.
		// Each ending is one light sample after the last confident one at x = 2, t = 1006.
		const ending = (x: number, t: number): number[] => {
			const value = builder();
			value.add(0, 0, 0.3, 1000);
			value.add(2, 0, 0.3, 1006);
			value.add(x, 0, 0.01, t);
			return value.finishReleaseFiltered().flatMap((stroke) => stroke.points.map((point) => point.x));
		};

		expect(ending(8, 1013), "7 ms and 6 px: under the time gate").toEqual([0, 2, 8]);
		expect(ending(3, 1014), "8 ms and 1 px: under the travel gate").toEqual([0, 2, 3]);
		expect(ending(5, 1014), "8 ms and 3 px: at both gates, release travel").toEqual([0, 2]);
	});

	it("a dip that recovers stays whole at every length: 7 ms, 8 ms (the old time gate) and 50 ms (the old ceiling)", () => {
		// The old filter split from 8 ms up to the ceiling. Every length keeps one stroke with every sample.
		const dip = (lastLightAt: number): number[][] => {
			const value = builder();
			value.add(0, 0, 0.3, 1000);
			value.add(2, 0, 0.3, 1006);
			value.add(4, 0, 0.01, 1010);
			value.add(7, 0, 0.01, lastLightAt);
			value.add(10, 0, 0.3, lastLightAt + 6);
			value.add(14, 0, 0.3, lastLightAt + 12);
			return value.finishReleaseFiltered().map((stroke) => stroke.points.map((point) => point.x));
		};

		for (const lastLightAt of [1013, 1014, 1060]) {
			expect(dip(lastLightAt), `last light sample at ${lastLightAt}`).toEqual([[0, 2, 4, 7, 10, 14]]);
		}
	});
});
