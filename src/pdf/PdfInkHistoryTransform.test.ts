/**
 * The lasso's resize and rotate step on a PDF: only the note surface transforms ink in this build, so the step leaves a
 * PDF's stroke list exactly as it was, element by element, order included, both ways.
 */
import { describe, expect, it } from "vitest";
import { applyOp } from "./PdfInkHistory";
import { invertInkOp, type InkOp } from "../inline/InkHistory";
import type { InkStroke } from "../ink/Stroke";

const stroke = (id: string, y: number): InkStroke => ({ id, tool: "pen", color: "#000000", width: 2, page: 1, createdAt: 0, points: [{ x: 10, y, pressure: 0.5, t: 0 }, { x: 20, y: y + 10, pressure: 0.5, t: 8 }], bbox: { x: 9, y: y - 1, width: 12, height: 12 } });
const shape = (x: number) => ({ points: [{ x, y: 20, pressure: 0.5, t: 0 }], width: 3, bbox: { x, y: 20, width: 0, height: 0 } });

describe("transform step on a PDF", () => {
	it("the step and its inverse return the stroke list unchanged", () => {
		// Defect: the switch has no transform case and the list comes back undefined, or a stroke is dropped or reordered.
		const strokes = [stroke("a", 20), stroke("b", 40), stroke("c", 60)];
		const op: InkOp = { type: "transform", path: "doc.pdf", strokeIds: ["b"], before: [shape(1)], after: [shape(9)] };
		for (const step of [op, invertInkOp(op)]) {
			const out = applyOp(strokes, step);
			expect(out).toHaveLength(strokes.length);
			out.forEach((s, i) => expect(s).toBe(strokes[i]));
		}
	});
});
