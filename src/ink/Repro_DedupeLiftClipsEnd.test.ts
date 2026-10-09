import { describe, expect, it } from "vitest";

import { StrokeBuilder } from "./StrokeBuilder";

describe("release filter vs dedupe: a straight-up lift keeps the stroke's last segment", () => {
	it("keeps the final point reached at confident pressure (120 Hz digitizer, lift in place)", () => {
		const b = new StrokeBuilder("pen", "#000", 2);
		b.start(1000);
		const drawn: number[] = [];
		for (let k = 0; k <= 5; k++) {
			if (b.add(4 * k, 0, 0.4, 1000 + Math.round(8.3 * k))) drawn.push(4 * k);
		}
		expect(b.add(20.05, 0, 0.2, 1050)).toBeUndefined();
		expect(b.add(20.05, 0, 0.06, 1058)).toBeUndefined();
		expect(b.add(20.05, 0, 0.01, 1066)).toBeUndefined();

		const strokes = b.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((p) => p.x), "every point the wet layer drew is committed").toEqual(drawn);
	});

	it("does not open a gap mid-stroke where the pen paused and its pressure dipped", () => {
		const b = new StrokeBuilder("pen", "#000", 2);
		b.start(1000);
		const drawn: number[] = [];
		const add = (x: number, p: number, t: number) => {
			if (b.add(x, 0, p, t)) drawn.push(x);
		};
		add(0, 0.4, 1000);
		add(4, 0.4, 1008);
		add(8, 0.4, 1017);
		b.add(8.05, 0, 0.02, 1030);
		add(12, 0.3, 1060);
		add(16, 0.4, 1068);

		const strokes = b.finishReleaseFiltered();

		expect(strokes.flatMap((s) => s.points.map((p) => p.x)), "no committed ink is missing").toEqual(drawn);
	});
});
