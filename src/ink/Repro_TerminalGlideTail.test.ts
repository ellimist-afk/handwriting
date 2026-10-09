import { describe, expect, it } from "vitest";

import { RELEASE_MAX_MS, StrokeBuilder } from "./StrokeBuilder";

describe("release filter: a long light ending that leaves the release band early is writing", () => {
	it("keeps a 180 ms light ending whose light samples only span its first 30 ms", () => {
		const b = new StrokeBuilder("pen", "#000", 2);
		b.start(1000);
		const drawn: number[] = [];
		const add = (x: number, p: number, t: number) => {
			if (b.add(x, 0, p, t)) drawn.push(x);
		};
		add(0, 0.4, 1000);
		add(4, 0.3, 1008);
		add(7, 0.02, 1012);
		add(10, 0.045, 1022);
		add(13, 0.015, 1032);
		add(16, 0.05, 1037);
		add(19, 0.02, 1042);
		for (let k = 1; k <= 15; k++) add(19 + 3 * k, 0.05, 1042 + 10 * k);
		expect(30).toBeLessThanOrEqual(RELEASE_MAX_MS);

		const strokes = b.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((p) => p.x), "the light ending the wet layer drew is committed").toEqual(drawn);
	});
});
