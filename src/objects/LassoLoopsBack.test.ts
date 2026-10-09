import { describe, expect, it } from "vitest";
import { SelectionModel } from "./SelectionModel";
import type { InkPoint, InkStroke } from "../ink/Stroke";
import { computeBBox } from "../ink/Stroke";

function stroke(id: string, pts: Array<[number, number]>): InkStroke {
	const points: InkPoint[] = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
	return { id, tool: "pen", color: "#000", width: 2, points, bbox: computeBBox(points, 4), createdAt: 0 };
}

function loop(cx: number, cy: number, r: number, degrees: number): Array<{ x: number; y: number }> {
	const out: Array<{ x: number; y: number }> = [];
	for (let d = 0; d <= degrees; d += 5) {
		const a = ((d - 90) * Math.PI) / 180;
		out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
	}
	return out;
}

const word = stroke("word", [[40, 50], [45, 45], [50, 55], [55, 45], [60, 50]]);
const nearStart = stroke(
	"near-start",
	[-70, -65, -60, -55, -50].map((deg): [number, number] => [
		50 + 38 * Math.cos((deg * Math.PI) / 180),
		50 + 38 * Math.sin((deg * Math.PI) / 180),
	])
);

describe("lasso drawn the way people draw loops", () => {
	it("a loop that goes round twice still selects what it encircles", () => {
		const sel = new SelectionModel();
		sel.selectByLasso(loop(50, 50, 40, 720), [word], [], () => null);
		expect(sel.strokeIds).toEqual(["word"]);
	});

	it("a loop that overshoots its start still selects ink under the overlap", () => {
		const sel = new SelectionModel();
		sel.selectByLasso(loop(50, 50, 40, 420), [word, nearStart], [], () => null);
		expect(sel.strokeIds.sort()).toEqual(["near-start", "word"]);
	});
});
