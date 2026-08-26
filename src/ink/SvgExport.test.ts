/**
 * The export is judged by structure: real viewBox from the ink's bounds,
 * ribbon path + discs per stroke, highlighter under the pen inside one
 * opacity group. Geometry itself is the committed renderer's, already
 * covered by the ribbon suites.
 */

import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "./Stroke";
import { inkToSvg, strokeToSvg } from "./SvgExport";

function stroke(tool: "pen" | "highlighter", xs: number[], y: number): InkStroke {
	const points = xs.map((x, i) => ({ x, y: y + i, pressure: 0.5, t: i * 8 }));
	return {
		id: `s-${tool}-${y}`,
		tool,
		color: tool === "pen" ? "#4b7bec" : "#ffd60a",
		width: 4,
		points,
		bbox: computeBBox(points, 4),
		createdAt: 0,
	};
}

describe("strokeToSvg", () => {
	it("a stroke becomes a filled ribbon path with cap discs", () => {
		const svg = strokeToSvg(stroke("pen", [10, 20, 30, 40], 50));
		expect(svg).toContain('<path d="M ');
		expect(svg).toContain('fill="#4b7bec"');
		expect((svg.match(/<circle /g) ?? []).length).toBeGreaterThanOrEqual(2);
	});

	it("a dot becomes one disc", () => {
		const svg = strokeToSvg(stroke("pen", [10], 50));
		expect(svg).toContain("<circle ");
		expect(svg).not.toContain("<path");
	});

	it("empty strokes emit nothing", () => {
		expect(strokeToSvg(stroke("pen", [], 0))).toBe("");
	});
});

describe("inkToSvg", () => {
	it("wraps everything in a sized svg with a real viewBox", () => {
		const svg = inkToSvg([stroke("pen", [10, 60], 100)]);
		expect(svg.startsWith("<svg ")).toBe(true);
		expect(svg).toContain("viewBox=");
		expect(svg).toContain("</svg>");
	});

	it("highlighter rides under the pen in one opacity group", () => {
		const svg = inkToSvg([stroke("pen", [10, 60], 100), stroke("highlighter", [10, 60], 100)]);
		const hi = svg.indexOf('opacity="0.35"');
		const pen = svg.indexOf('fill="#4b7bec"');
		expect(hi).toBeGreaterThan(-1);
		expect(hi).toBeLessThan(pen);
	});

	it("no ink, no document", () => {
		expect(inkToSvg([])).toBe("");
	});
});
