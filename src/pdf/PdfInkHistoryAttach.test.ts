/**
 * Ink attached to text on a PDF: the attach step (attach, and detach as its inverse) leaves a PDF's stroke list exactly
 * as it was, element by element, order included.
 */
import { describe, expect, it } from "vitest";
import { applyOp } from "./PdfInkHistory";
import { invertInkOp, type InkOp } from "../inline/InkHistory";
import { targetAt, type AttachmentRecord } from "../inline/InkAttachments";
import type { InkStroke } from "../ink/Stroke";

const stroke = (id: string, y: number): InkStroke => ({ id, tool: "pen", color: "#000000", width: 2, page: 1, createdAt: 0, points: [{ x: 10, y, pressure: 0.5, t: 0 }, { x: 20, y: y + 10, pressure: 0.5, t: 8 }], bbox: { x: 9, y: y - 1, width: 12, height: 12 } });
const DOC = "The word benzene sits here.\n";
const rec: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["a"], target: targetAt(DOC, 9, 16, "range"), ref: { x: 0, y: 0 }, layout: { width: 672, font: 19 }, probe: { id: "a", x: 10, y: 20 } };

describe("attach step on a PDF", () => {
	it("attach and detach return the stroke list unchanged", () => {
		// Plant pdf-drop: the attach case drops a stroke.
		const strokes = [stroke("a", 20), stroke("b", 40), stroke("c", 60)];
		const attach: InkOp = { type: "attach", path: "doc.pdf", id: "att-1", before: null, after: rec };
		const detach = invertInkOp(attach);
		expect(detach).toMatchObject({ type: "attach", before: rec, after: null });
		for (const op of [attach, detach]) {
			const out = applyOp(strokes, op);
			expect(out).toHaveLength(strokes.length);
			out.forEach((s, i) => expect(s).toBe(strokes[i]));
		}
	});
});
