import { describe, expect, it } from "vitest";
import { SelectionModel } from "./SelectionModel";
import type { InkPoint, InkStroke } from "../ink/Stroke";
import { computeBBox } from "../ink/Stroke";

function stroke(id: string, pts: Array<[number, number]>): InkStroke {
	const points: InkPoint[] = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
	return { id, tool: "pen", color: "#000", width: 2, points, bbox: computeBBox(points, 4), createdAt: 0 };
}

const square = (x0: number, y0: number, x1: number, y1: number) => [
	{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

describe("lasso majority is by ink, not by sample count", () => {
	const slowStart: Array<[number, number]> = [];
	for (let i = 0; i < 12; i++) slowStart.push([i * 0.25, 100]);
	for (let i = 1; i <= 8; i++) slowStart.push([3 + (197 * i) / 8, 100]);
	const underline = stroke("underline", slowStart);

	it("circling only the first word does not grab a long underline that merely starts there", () => {
		const sel = new SelectionModel();
		sel.selectByLasso(square(-10, 90, 20, 110), [underline], [], () => null);
		expect(sel.strokeIds).toEqual([]);
	});

	it("circling most of a line selects it even if its few inside samples are sparse", () => {
		const sel = new SelectionModel();
		sel.selectByLasso(square(5, 90, 210, 110), [underline], [], () => null);
		expect(sel.strokeIds).toEqual(["underline"]);
	});
});
