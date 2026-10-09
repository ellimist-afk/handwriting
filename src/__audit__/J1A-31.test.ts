import { describe, expect, it } from "vitest";

import { pointSegmentDistSq, splitStrokeByCircle, strokesHitByCircle } from "../ink/Eraser";
import { ribbonOf } from "../ink/StrokeOutline";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { ERASER_SIZE_STEPS } from "../ink/EraserSize";
import { HIGHLIGHTER_PEN } from "../ink/PenStyle";

let n = 0;
const makeId = () => `piece-${++n}`;

function highlight(width: number): InkStroke {
	const points = Array.from({ length: 41 }, (_, i) => ({ x: i * 5, y: 0, pressure: 0.5, t: 1000 + i * 8 }));
	return { id: "hl", tool: "highlighter", color: "#ffd60a", width, points, bbox: computeBBox(points, width * 2), createdAt: 1000 };
}

/** Painted half-width of the committed ribbon (max over samples). */
const paintedHw = (s: InkStroke): number => Math.max(...ribbonOf(s).map((p) => p.hw));

/** Is (x,y) inside any piece's painted ribbon? */
function painted(pieces: InkStroke[], x: number, y: number): boolean {
	for (const piece of pieces) {
		const rib = ribbonOf(piece);
		for (let i = 0; i < rib.length; i++) {
			const a = rib[i]!;
			const b = rib[Math.min(i + 1, rib.length - 1)]!;
			const hw = Math.max(a.hw, b.hw);
			if (pointSegmentDistSq(x, y, a.x, a.y, b.x, b.y) <= hw * hw) return true;
		}
	}
	return false;
}

const FINE = ERASER_SIZE_STEPS.find((s) => s.name === "fine")!.radiusPx; // 8

describe("J1A-31 eraser vs stroke width", () => {
	it("control: a circle on the centre line hits; a circle well clear of the ink misses", () => {
		const s = highlight(HIGHLIGHTER_PEN.baseWidth * 2);
		expect(strokesHitByCircle([s], 100, 0, FINE)).toEqual(["hl"]);
		expect(strokesHitByCircle([s], 100, paintedHw(s) + FINE + 2, FINE)).toEqual([]);
	});

	it("Stroke mode: a fine eraser inside the outer half of a 2x highlight (on painted ink) hits it", () => {
		const s = highlight(HIGHLIGHTER_PEN.baseWidth * 2); // nib mult 2
		const hw = paintedHw(s);
		const y = hw - 2; // well inside the painted band, past r from the centre line
		expect(painted([s], 100, y), "precondition: the eraser centre sits on painted ink").toBe(true);
		expect(y, "precondition: the eraser does not reach the centre line").toBeGreaterThan(FINE);
		expect(strokesHitByCircle([s], 100, y, FINE), `eraser r=${FINE} centred on ink ${y.toFixed(1)}px off a hw=${hw.toFixed(1)} highlight deleted nothing`).toEqual(["hl"]);
	});

	it("Partial: a fine eraser dabbed on a default highlight leaves no paint under its own centre", () => {
		const s = highlight(HIGHLIGHTER_PEN.baseWidth);
		const pieces = splitStrokeByCircle(s, 100, 0, FINE, makeId);
		expect(pieces.length, "precondition: the stroke was cut in two").toBe(2);
		const hw = paintedHw(s);
		// Under the eraser's footprint along the line, nothing may stay painted.
		const stillPainted = [-FINE / 2, 0, FINE / 2].filter((dx) => painted(pieces, 100 + dx, 0));
		expect(stillPainted, `round caps (hw=${hw.toFixed(2)}) regrew into the r=${FINE} cut: still painted at dx=${stillPainted.join(",")}`).toEqual([]);
	});
});
