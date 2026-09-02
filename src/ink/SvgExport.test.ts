/**
 * The export is judged by structure: real viewBox from the ink's bounds,
 * ribbon path + discs per stroke, highlighter under the pen inside one
 * opacity group. Geometry itself is the committed renderer's, already
 * covered by the ribbon suites.
 */

import { afterEach, describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "./Stroke";
import { setInkShaping } from "./InkShape";
import { inkSvgBody, inkSvgLayers, inkToSvg, strokeToSvg } from "./SvgExport";

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

describe("export shaping (§5n: SVG export is always shaped)", () => {
	// Same decision as InkPdf.test.ts's block of this name: StrokeOutline's
	// ribbonOf stopped reading inkShapingEnabled() for exports (Alan,
	// 2026-09-02), so the exported SVG is now byte-identical whichever way
	// the toggle sits for a pen stroke, and a mouse/highlighter stroke - never
	// shaped - was already unaffected by it.
	afterEach(() => setInkShaping(true));

	it("a pen stroke's svg is unaffected by the ink-shaping toggle", () => {
		const s = stroke("pen", [10, 20, 40, 60, 90], 100);
		setInkShaping(true);
		const shapedOn = inkToSvg([s]);
		setInkShaping(false);
		const shapedOff = inkToSvg([s]);
		expect(shapedOff).toBe(shapedOn);
	});

	it("a mouse stroke's svg is unaffected by the toggle (it was never shaped)", () => {
		const s: InkStroke = { ...stroke("pen", [10, 20, 40, 60, 90], 100), device: "mouse" };
		setInkShaping(true);
		const shapedOn = inkToSvg([s]);
		setInkShaping(false);
		const shapedOff = inkToSvg([s]);
		expect(shapedOff).toBe(shapedOn);
	});

	it("a highlighter stroke's svg is unaffected by the toggle (it was never shaped)", () => {
		const s = stroke("highlighter", [10, 20, 40, 60, 90], 100);
		setInkShaping(true);
		const shapedOn = inkToSvg([s]);
		setInkShaping(false);
		const shapedOff = inkToSvg([s]);
		expect(shapedOff).toBe(shapedOn);
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

describe("inkSvgLayers (what the reading view builds elements from)", () => {
	it("splits the layers and keeps one run per colour", () => {
		const layers = inkSvgLayers([
			stroke("highlighter", [0, 10], 0),
			stroke("pen", [0, 10], 20),
			stroke("pen", [0, 10], 40),
		]);
		expect(layers.highlighter).toHaveLength(1);
		// both pen strokes share a colour, so they merge into one path
		expect(layers.pen).toHaveLength(1);
		expect(layers.pen[0]!.d.length).toBeGreaterThan(0);
	});

	it("a colour change breaks the run, so z-order survives", () => {
		const a = stroke("pen", [0, 10], 0);
		const b = { ...stroke("pen", [0, 10], 20), color: "#e74c3c" };
		const c = stroke("pen", [0, 10], 40);
		const layers = inkSvgLayers([a, b, c]);
		// three runs, in the order drawn - collapsing by colour would lift
		// the first stroke above the red one drawn over it
		expect(layers.pen).toHaveLength(3);
		expect(layers.pen[1]!.color).toBe("#e74c3c");
	});

	it("empty in, empty out", () => {
		const layers = inkSvgLayers([]);
		expect(layers.highlighter).toEqual([]);
		expect(layers.pen).toEqual([]);
	});

	it("the runs and the file export still describe the same paths", () => {
		// the .svg download keeps the string builder; this pins the two
		// forms together so the refactor cannot drift them apart
		const strokes = [stroke("highlighter", [0, 10], 0), stroke("pen", [0, 10], 20)];
		const body = inkSvgBody(strokes);
		const layers = inkSvgLayers(strokes);
		for (const run of [...layers.highlighter, ...layers.pen]) {
			expect(body).toContain(`d="${run.d}"`);
			expect(body).toContain(`fill="${run.color}"`);
		}
	});
});
