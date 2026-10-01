import { expect, it } from "vitest";
import { snipViewport } from "../pdf/PageMap";

it("C2-005 caps the final rounded snip canvas, not only the continuous area", () => {
	const cap = 4_000_000;
	const vp = snipViewport({ x: 0, y: 0, width: 250, height: 447 }, 0, 1000, 1000, 6, cap);
	expect(vp).not.toBeNull();
	const width = Math.max(1, Math.round((vp!.x1 - vp!.x0) * vp!.scale));
	const height = Math.max(1, Math.round((vp!.y1 - vp!.y0) * vp!.scale));
	// Both inline and PDF callers allocate these rounded integer dimensions. The continuous cap alone gave
	// 1496 x 2674 = 4,000,304; the rounded size now fits, one pixel narrower.
	expect([width, height]).toEqual([1495, 2673]);
	expect(width * height).toBeLessThanOrEqual(cap);
});
