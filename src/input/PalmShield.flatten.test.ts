import { describe, expect, it } from "vitest";
import { palmVerdict } from "./PalmShield";

describe("a palm that flattens after landing", () => {
	it("is caught by the move verdict once its radius crosses the line", () => {
		// Lands gently: fingertip-sized, passes.
		const start = palmVerdict([{ identifier: 7, radiusX: 8, radiusY: 8 }], new Set());
		expect(start.veto).toBe(false);
		expect(start.begin).toEqual([]);
		// Settles: same contact, palm-sized now.
		const move = palmVerdict([{ identifier: 7, radiusX: 30, radiusY: 24 }], new Set());
		expect(move.veto).toBe(true);
		expect(move.begin).toEqual([7]);
	});
});
