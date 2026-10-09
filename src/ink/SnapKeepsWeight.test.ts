import { describe, expect, it } from "vitest";
import { snapStroke } from "./ShapeSnap";
import { StrokeBuilder } from "./StrokeBuilder";
import { flattenStrokeShaped } from "./InkShape";
import { strokeWidthPolicy } from "./StrokeWidth";
import { EXP7_PEN } from "./PenStyle";
import type { InkPoint } from "./Stroke";

// A snapped figure keeps the weight it was drawn with.

const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]!;
// Median committed full width, exactly as drawStroke flattens a pen stroke.
function inkWidth(points: readonly InkPoint[], baseWidth: number): number {
	const style = strokeWidthPolicy({ ...EXP7_PEN, baseWidth }, undefined, "exp7").style;
	return 2 * median(flattenStrokeShaped(points, style, 1).map(q => q.hw));
}

describe("a snapped figure keeps the weight it was written with", () => {
	for (const pressure of [0.15, 0.8]) for (const size of [1.1, 2.2, 6]) {
		it(`circle at pressure ${pressure}, size ${size}`, () => {
			const b = new StrokeBuilder("pen", "#000", size);
			b.start(0);
			for (let i = 0; i <= 64; i++) {
				const a = (i / 64) * Math.PI * 2;
				b.add(50 + 30 * Math.cos(a), 50 + 30 * Math.sin(a), pressure, i * 8);
			}
			const drawn = b.finish()!;
			const snapped = snapStroke(drawn, true); // the dwell the overlay confirmed
			expect(snapped).not.toBeNull();
			const before = inkWidth(drawn.points, size);
			const after = inkWidth(snapped!.points, size);
			expect(Math.abs(after - before) / before).toBeLessThan(0.1);
		});
	}
});

describe("a snapped figure's weight comes from the drawn body only", () => {
	it("takes the upper median of an even body, not a fixed 0.5", () => {
		const b = new StrokeBuilder("pen", "#000", 2.2);
		b.start(0);
		for (let i = 0; i < 64; i++) {
			const a = (i / 64) * Math.PI * 2;
			b.add(50 + 30 * Math.cos(a), 50 + 30 * Math.sin(a), i < 32 ? 0.2 : 0.3, i * 8);
		}
		const snapped = snapStroke(b.finish()!, true)!;
		expect(new Set(snapped.points.map(p => p.pressure))).toEqual(new Set([0.3]));
	});
});
