import { describe, expect, it } from "vitest";

import { StrokeBuilder } from "./StrokeBuilder";

function builder(): StrokeBuilder {
	const value = new StrokeBuilder("pen", "#377dff", 2);
	value.start(1000);
	return value;
}

describe("inline pen release filtering", () => {
	it("drops terminal travel reported after a confident Surface pen contact", () => {
		const value = builder();
		value.add(0, 0, 0.403, 1000);
		value.add(2, 0, 0.306, 1004);
		value.add(5, 1, 0.012, 1008);
		value.add(12, 3, 0.015, 1016);
		value.add(22, 6, 0.003, 1025);
		value.add(30, 8, 0, 1030);

		const strokes = value.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x)).toEqual([0, 2]);
		expect(strokes[0]!.bbox.x + strokes[0]!.bbox.width).toBeLessThan(8);
	});

	it("counts the jump into the first low-pressure sample as release travel", () => {
		const value = builder();
		value.add(0, 0, 0.4, 1000);
		value.add(2, 0, 0.3, 1008);
		value.add(9, 0, 0.01, 1017);

		const strokes = value.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.at(-1)!.x).toBe(2);
	});

	it("turns a confirmed release gap followed by renewed contact into two strokes", () => {
		const value = builder();
		value.add(0, 0, 0.4, 1000);
		value.add(10, 0, 0.3, 1006);
		value.add(12, 0, 0.012, 1010);
		value.add(24, 1, 0.014, 1022);
		value.add(28, 2, 0.04, 1027);
		value.add(31, 3, 0.08, 1032);
		value.add(40, 5, 0.2, 1040);

		const strokes = value.finishReleaseFiltered();

		expect(strokes).toHaveLength(2);
		expect(strokes[0]!.points.at(-1)!.x).toBe(10);
		expect(strokes[1]!.points[0]!.x).toBe(28);
		expect(strokes[0]!.id).not.toBe(strokes[1]!.id);
	});

	it("handles repeated release gaps and removes the final release tail", () => {
		const value = builder();
		for (const [x, pressure, time] of [
			[0, 0.3, 1000],
			[5, 0.2, 1005],
			[10, 0.01, 1014],
			[20, 0.01, 1024],
			[23, 0.04, 1028],
			[25, 0.09, 1032],
			[30, 0.2, 1038],
			[35, 0.01, 1047],
			[45, 0.01, 1057],
			[48, 0.04, 1061],
			[50, 0.1, 1065],
			[55, 0.2, 1070],
			[70, 0.01, 1080],
			[85, 0, 1090],
		] as const) {
			value.add(x, 0, pressure, time);
		}

		const strokes = value.finishReleaseFiltered();

		expect(strokes).toHaveLength(3);
		expect(strokes.map((stroke) => [stroke.points[0]!.x, stroke.points.at(-1)!.x])).toEqual([
			[0, 5],
			[23, 30],
			[48, 55],
		]);
	});

	it("preserves a short low-pressure wobble that is too small to prove a release", () => {
		const value = builder();
		value.add(0, 0, 0.3, 1000);
		value.add(10, 0, 0.25, 1008);
		value.add(11, 0, 0.015, 1010);
		value.add(12, 0, 0.014, 1015);
		value.add(13, 0, 0.09, 1018);
		value.add(20, 0, 0.2, 1025);

		const strokes = value.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x)).toEqual([0, 10, 11, 12, 13, 20]);
	});

	it("preserves a genuinely light stroke when no confident contact preceded it", () => {
		const value = builder();
		value.add(0, 0, 0.012, 1000);
		value.add(10, 2, 0.016, 1010);
		value.add(20, 4, 0.02, 1020);

		const strokes = value.finishReleaseFiltered();

		expect(strokes).toHaveLength(1);
		expect(strokes[0]!.points.map((point) => point.x)).toEqual([0, 10, 20]);
	});

	it("leaves the ordinary finish path unchanged for non-inline surfaces", () => {
		const value = builder();
		value.add(0, 0, 0.4, 1000);
		value.add(10, 0, 0.3, 1008);
		value.add(25, 2, 0.01, 1020);

		const stroke = value.finish();

		expect(stroke!.points.map((point) => point.x)).toEqual([0, 10, 25]);
	});
});
