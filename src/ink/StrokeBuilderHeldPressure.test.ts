import { describe, expect, it } from "vitest";
import { StrokeBuilder } from "./StrokeBuilder";

/** One contact fed (x, y, pressure, t) samples after a start at time 0. */
function feed(b: StrokeBuilder, samples: Array<[number, number, number, number]>): void {
	b.start(0);
	for (const [x, y, p, t] of samples) b.add(x, y, p, t);
}

describe("a builder used for a second contact", () => {
	// A confident run, then a light tail that travels: the shape the release filter cuts at the lift.
	const tail: Array<[number, number, number, number]> = [
		[0, 0, 0.5, 0],
		[10, 0, 0.5, 10],
		[20, 0, 0.01, 20],
		[30, 0, 0.01, 30],
	];

	it("cuts the light tail the same way after a first contact that pressed hard at every place", () => {
		const fresh = new StrokeBuilder("pen", "#000000", 2);
		feed(fresh, tail);
		const reused = new StrokeBuilder("pen", "#000000", 2);
		feed(reused, [
			[0, 0, 0.9, 0],
			[10, 0, 0.9, 10],
			[20, 0, 0.9, 20],
			[30, 0, 0.9, 30],
		]);
		feed(reused, tail);
		expect(fresh.finishReleaseFiltered()[0]!.points, "the tail is cut on a fresh builder").toHaveLength(2);
		expect(reused.finishReleaseFiltered()[0]!.points, "and on a builder that held another contact first").toHaveLength(2);
	});
});
