/**
 * The copy from the extent raster lands on whole device pixels. A camera that moved since the build by layout jitter (a layout
 * unit is 1/64 css px, under 1/16 device px at any backing up to 4) still copies, to the nearest whole pixel; a move of a
 * half pixel or more is a real move and the copy refuses without touching the layers, so the caller paints by path.
 */
import { describe, expect, it } from "vitest";

import { InkOverlayPlugin } from "./InkOverlay";

type CopyFn = (this: object, ext: object, cam: object, rect: null) => boolean;

function copy(dx: number, dy: number, backing = 1): { ok: boolean; draws: number; clears: number } {
	let draws = 0, clears = 0;
	const ctx = { save() {}, restore() {}, setTransform() {}, clearRect() { clears++; }, drawImage() { draws++; } };
	const host = { committedCanvas: { width: 100, height: 100 }, committedCtx: ctx, highlightCtx: ctx, highlightPairDeferred: true };
	const ext = { cam0: { x: 0, y: 0, zoom: 1 }, backing, kx: 0, ky: 0, pen: {}, hl: null };
	const fn = (InkOverlayPlugin.prototype as unknown as { copyFromExtent: CopyFn }).copyFromExtent;
	const ok = fn.call(host, ext, { x: dx / backing, y: dy / backing, zoom: 1 }, null);
	return { ok, draws, clears };
}

describe("copyFromExtent tolerance", () => {
	it("copies when the camera moved by whole device pixels", () => {
		expect(copy(0, 0).ok).toBe(true);
		expect(copy(3, -2).ok).toBe(true);
	});

	it("copies through layout jitter well under a sixteenth of a device pixel", () => {
		for (const jitter of [0.00061, 0.002228, 0.01, 0.05]) {
			const r = copy(0, jitter);
			expect(r.ok, `y ${jitter}`).toBe(true);
			expect(r.draws, `y ${jitter} drew`).toBe(1);
			expect(copy(-jitter, 4 + jitter).ok, `x and y ${jitter}`).toBe(true);
		}
	});

	it("refuses a move of a sixteenth of a device pixel or more from a whole pixel, touching nothing", () => {
		for (const move of [0.07, 0.25, 0.4, 0.5, 0.6, 0.9]) {
			expect(copy(move, 0).ok, `x ${move}`).toBe(false);
			const r = copy(0, move);
			expect(r.ok, `y ${move}`).toBe(false);
			expect(r.draws + r.clears, `y ${move} touched the layers`).toBe(0);
		}
	});
});
