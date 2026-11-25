/**
 * The note snip's crop, through the note overlay's own snipSelection.
 *
 * A note has no page. Its ink can sit left of or above the note's origin (a stroke started near the left edge of the
 * text column reaches below x = 0), and the snip of a selection that holds such a stroke must keep all of it, with the
 * same air round it on every side. The crop is snipViewport's; the note caller passes no page, so nothing should hold
 * the crop's near edges at 0.
 *
 * What is real here: the installed snipSelection, snipViewport, the stroke renderer and the ink destination scope. What
 * is stood in: the overlay's host (no editor), the selection's box, and the canvas, which only records its size and the
 * transform the snip sets before it draws.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { InkOverlayPlugin } from "./InkOverlay";
import { computeBBox, type InkPoint, type InkStroke } from "../ink/Stroke";

/** The air the note snip leaves round the selection, in world units (InkOverlayClipboard.ts). */
const PAD = 8;

/** A pen stroke 2.76 wide through the given points, its box padded by half its width. */
function penStroke(id: string, xy: Array<[number, number]>): InkStroke {
	const points: InkPoint[] = xy.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
	return { id, tool: "pen", color: "#202020", width: 2.76, points, bbox: computeBBox(points, 1.38), createdAt: 0 };
}

/** One pen stroke from x -8 to 48.62; its box runs from x -9.38 to 50, and all of it lies below the note's top (y 0). */
function strokeLeftOfOrigin(): InkStroke {
	return penStroke("s-left-of-origin", [
		[-8, 20],
		[10, 22],
		[30, 24],
		[48.62, 26],
	]);
}

type Recorded = { width: number; height: number; transforms: number[][] };

/** A canvas that records its size and every transform set on it; enough of a 2d context for the stroke renderer. */
function stubCanvas(): Recorded {
	const rec: Recorded = { width: 0, height: 0, transforms: [] };
	const ctx = {
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 0,
		lineCap: "",
		lineJoin: "",
		globalAlpha: 1,
		beginPath() {},
		moveTo() {},
		lineTo() {},
		quadraticCurveTo() {},
		closePath() {},
		arc() {},
		fill() {},
		stroke() {},
		save() {},
		restore() {},
		fillRect() {},
		drawImage() {},
		setTransform(...m: number[]) {
			rec.transforms.push(m);
		},
	};
	vi.stubGlobal("createEl", () => {
		const canvas = {
			getContext: () => ctx,
			toBlob: (cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array([0x89])])),
		};
		// The snip zeroes the canvas in its finally; the size it drew at is the first non-zero one.
		Object.defineProperty(canvas, "width", {
			get: () => rec.width,
			set: (v: number) => {
				if (v > 0) rec.width = v;
			},
		});
		Object.defineProperty(canvas, "height", {
			get: () => rec.height,
			set: (v: number) => {
				if (v > 0) rec.height = v;
			},
		});
		return canvas;
	});
	return rec;
}

/** The note overlay's prototype with no host: a selection, its box, its strokes and a window at the given pixel ratio. */
function overlayWithSelection(stroke: InkStroke, dpr: number): InkOverlayPlugin {
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const own = (name: string, value: unknown) =>
		Object.defineProperty(overlay, name, { value, writable: true, configurable: true, enumerable: true });
	own("selection", { isEmpty: false });
	own("selectionBounds", () => ({ ...stroke.bbox }));
	own("strokesHere", () => [stroke]);
	Object.defineProperty(overlay, "winRef", { get: () => ({ devicePixelRatio: dpr }), configurable: true });
	return overlay;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the note snip keeps ink left of or above the note's origin", () => {
	it("crops from the stroke's own left edge less the pad, not from x 0", async () => {
		const stroke = strokeLeftOfOrigin();
		expect(stroke.bbox.x, "the stroke's box starts left of the origin").toBeCloseTo(-9.38, 9);
		expect(stroke.bbox.y - PAD, "and stays clear of the top, so only x is under test").toBeGreaterThan(0);
		const rec = stubCanvas();
		const dpr = 2;

		const result = await overlayWithSelection(stroke, dpr).snipSelection();
		expect(result.ok, result.ok ? "" : result.reason).toBe(true);

		const left = stroke.bbox.x - PAD;
		const right = stroke.bbox.x + stroke.bbox.width + PAD;
		expect.soft(rec.width, "canvas width: the whole box and the pad on both sides").toBe(Math.round((right - left) * dpr));
		expect(rec.transforms.length, "the snip sets one transform before it draws").toBeGreaterThan(0);
		const [, , , , shiftX] = rec.transforms[0]!;
		expect.soft(shiftX, "x shift: the ink left of the origin is moved onto the canvas").toBeCloseTo(-left * dpr, 9);
	});

	it("crops from the stroke's own top edge less the pad, not from y 0", async () => {
		const stroke = penStroke("s-above-origin", [
			[20, -6],
			[30, 4],
			[45, 18],
			[60, 30],
		]);
		expect(stroke.bbox.y, "the stroke's box starts above the origin").toBeLessThan(0);
		expect(stroke.bbox.x - PAD, "and stays clear of the left, so only y is under test").toBeGreaterThan(0);
		const rec = stubCanvas();
		const dpr = 2;

		const result = await overlayWithSelection(stroke, dpr).snipSelection();
		expect(result.ok, result.ok ? "" : result.reason).toBe(true);

		const top = stroke.bbox.y - PAD;
		const bottom = stroke.bbox.y + stroke.bbox.height + PAD;
		expect.soft(rec.height, "canvas height: the whole box and the pad above and below").toBe(Math.round((bottom - top) * dpr));
		expect(rec.transforms.length, "the snip sets one transform before it draws").toBeGreaterThan(0);
		const [, , , , , shiftY] = rec.transforms[0]!;
		expect.soft(shiftY, "y shift: the ink above the origin is moved onto the canvas").toBeCloseTo(-top * dpr, 9);
	});

	it("holds a crop grown past the origin to the note snip's area cap, and keeps all of it", async () => {
		/** NOTE_SNIP_CAP_PX in InkOverlayClipboard.ts. */
		const CAP = 4_000_000;
		const stroke = penStroke("s-wide", [
			[-1500, -700],
			[-200, 100],
			[500, 900],
		]);
		const rec = stubCanvas();
		const dpr = 2;

		const result = await overlayWithSelection(stroke, dpr).snipSelection();
		expect(result.ok, result.ok ? "" : result.reason).toBe(true);

		const left = stroke.bbox.x - PAD;
		const top = stroke.bbox.y - PAD;
		const right = stroke.bbox.x + stroke.bbox.width + PAD;
		const bottom = stroke.bbox.y + stroke.bbox.height + PAD;
		expect((right - left) * dpr * ((bottom - top) * dpr), "uncapped, this crop is past the cap").toBeGreaterThan(CAP);
		expect(rec.width * rec.height, "the canvas the snip allocates fits the cap").toBeLessThanOrEqual(CAP);
		const [, , , , shiftX, shiftY] = rec.transforms[0]!;
		const scale = shiftX! / -left;
		expect(scale, "the capped scale").toBeLessThan(dpr);
		expect.soft(shiftY, "the same scale moves the top edge onto the canvas").toBeCloseTo(-top * scale, 6);
		expect.soft(rec.width, "the whole width, at the capped scale").toBe(Math.max(1, Math.round((right - left) * scale)));
		expect.soft(rec.height, "the whole height, at the capped scale").toBe(Math.max(1, Math.round((bottom - top) * scale)));
	});
});
