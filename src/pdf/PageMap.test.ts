/**
 * The page coordinate model, checked against numbers measured from the live
 * viewer rather than invented for the test: Obsidian 1.13.7 rendering a
 * letter-size fixture at scale 1.8692810457516338, page boxes 1143x1480 at
 * x=14 with a uniform 1494px stride. Those are the M0 readings, so a change
 * that breaks the real viewer breaks these too.
 */

import { describe, expect, it } from "vitest";
import {
	PageBox,
	boxContains,
	fromPagePoint,
	livePages,
	pageAt,
	pageSizePt,
	snipViewport,
	strokePage,
	toPagePoint,
} from "./PageMap";

const SCALE = 1.8692810457516338;
const STRIDE = 1494;

function fixture(count = 100): PageBox[] {
	return Array.from({ length: count }, (_, i) => ({
		pageNumber: i + 1,
		leftPx: 14,
		topPx: i * STRIDE,
		widthPx: 1143,
		heightPx: 1480,
	}));
}

describe("pageSizePt", () => {
	it("recovers the page size in points from the measured box", () => {
		// The fixture is letter: 612 x 792. The error is bounded by ONE pixel
		// of `clientWidth` rounding, which is `1 / scale` points - about 0.53
		// here, and exactly what the live report showed (611.47 x 791.75).
		// Asserting the real bound rather than a loose tolerance means a
		// genuine drift cannot hide inside slack.
		const size = pageSizePt(fixture()[0]!, SCALE)!;
		const bound = 1 / SCALE;
		expect(Math.abs(size.w - 612)).toBeLessThan(bound);
		expect(Math.abs(size.h - 792)).toBeLessThan(bound);
	});

	it("refuses a scale that cannot divide", () => {
		expect(pageSizePt(fixture()[0]!, 0)).toBeNull();
		expect(pageSizePt(fixture()[0]!, Number.NaN)).toBeNull();
	});
});

describe("round trip", () => {
	it("returns a point to where it started", () => {
		// The property that matters: a stroke saved and redrawn lands on
		// itself. Anything that drifts here drifts on screen.
		const box = fixture()[49]!;
		for (const [cx, cy] of [
			[14, box.topPx],
			[600, box.topPx + 700],
			[1156, box.topPx + 1479],
		]) {
			const p = toPagePoint(box, SCALE, cx!, cy!)!;
			const back = fromPagePoint(box, SCALE, p.x, p.y);
			expect(back.x).toBeCloseTo(cx!, 6);
			expect(back.y).toBeCloseTo(cy!, 6);
		}
	});

	it("puts the page's top-left corner at the origin", () => {
		const box = fixture()[49]!;
		const p = toPagePoint(box, SCALE, box.leftPx, box.topPx)!;
		expect(p.x).toBeCloseTo(0, 9);
		expect(p.y).toBeCloseTo(0, 9);
		expect(p.pageNumber).toBe(50);
	});

	it("is independent of zoom", () => {
		// The same physical spot on the page, measured at two zooms, must
		// produce the same stored coordinate. This is the entire reason the
		// model divides by the scale factor, and the property that lets ink
		// drawn at one zoom be redrawn at another.
		//
		// The zoomed box is DERIVED from the first by one factor rather than
		// typed out: a hand-written second box quietly encodes a different
		// aspect ratio, and then the test fails on its own arithmetic instead
		// of on the model's.
		const lo: PageBox = { pageNumber: 3, leftPx: 14, topPx: 2988, widthPx: 1143, heightPx: 1480 };
		const k = 3.4916;
		const hi: PageBox = {
			pageNumber: 3,
			leftPx: 40,
			topPx: 9000,
			widthPx: lo.widthPx * k,
			heightPx: lo.heightPx * k,
		};
		const a = toPagePoint(lo, SCALE, lo.leftPx + lo.widthPx / 2, lo.topPx + lo.heightPx / 4)!;
		const b = toPagePoint(hi, SCALE * k, hi.leftPx + hi.widthPx / 2, hi.topPx + hi.heightPx / 4)!;
		expect(b.x).toBeCloseTo(a.x, 9);
		expect(b.y).toBeCloseTo(a.y, 9);
	});

	it("keeps honest coordinates for a point off the page", () => {
		// Not clamped: a stroke that wanders off the edge should record where
		// it actually went, and be clipped when drawn, rather than be bent
		// into a shape nobody drew.
		const box = fixture()[0]!;
		const p = toPagePoint(box, SCALE, box.leftPx - 100, box.topPx - 50)!;
		expect(p.x).toBeLessThan(0);
		expect(p.y).toBeLessThan(0);
	});
});

describe("pageAt", () => {
	const boxes = fixture();

	it("finds the page a point is on", () => {
		expect(pageAt(boxes, 500, 0)!.pageNumber).toBe(1);
		expect(pageAt(boxes, 500, 73206 + 10)!.pageNumber).toBe(50);
		expect(pageAt(boxes, 500, 147906 + 1479)!.pageNumber).toBe(100);
	});

	it("takes the nearest page from the gap between two", () => {
		// The 14px gutter between pages is not nothing: a pen landing there
		// means the page it is closest to, not no page at all.
		const gap = 1480 + 5; // just past page 1's bottom edge
		expect(pageAt(boxes, 500, gap)!.pageNumber).toBe(1);
		const nearNext = STRIDE - 3; // just above page 2's top
		expect(pageAt(boxes, 500, nearNext)!.pageNumber).toBe(2);
	});

	it("takes the nearest page from beyond the document", () => {
		expect(pageAt(boxes, 500, -500)!.pageNumber).toBe(1);
		expect(pageAt(boxes, 500, 999999)!.pageNumber).toBe(100);
	});

	it("has nothing to say about an empty document", () => {
		expect(pageAt([], 0, 0)).toBeNull();
	});

	it("boxContains is exclusive of nothing at the edges", () => {
		const b = boxes[0]!;
		expect(boxContains(b, b.leftPx, b.topPx)).toBe(true);
		expect(boxContains(b, b.leftPx + b.widthPx, b.topPx + b.heightPx)).toBe(true);
		expect(boxContains(b, b.leftPx - 1, b.topPx)).toBe(false);
	});
});

describe("strokePage", () => {
	it("binds a stroke to where it started, not where it ends", () => {
		// A descender crossing onto the next page stays part of the letter it
		// belongs to. Re-deciding per sample would tear the stroke in half.
		const boxes = fixture();
		const start = strokePage(boxes, 500, 1400)!; // near the bottom of page 1
		expect(start.pageNumber).toBe(1);
	});
});

describe("livePages", () => {
	it("mirrors the viewer's own window instead of guessing one", () => {
		// M0: scrolled to page 50 of 100, the viewer kept canvases on pages
		// 1 and 50-54 while retaining all 100 divs.
		const live = new Set([1, 50, 51, 52, 53, 54]);
		const got = livePages(fixture(), (n) => live.has(n)).map((b) => b.pageNumber);
		expect(got).toEqual([1, 50, 51, 52, 53, 54]);
	});

	it("carries nothing when the viewer has rendered nothing", () => {
		expect(livePages(fixture(), () => false)).toEqual([]);
	});
});

describe("snipViewport", () => {
	// Letter page in points, and a viewer rendering it at 2px per point.
	const W = 612;
	const H = 792;

	const CAP = 4_000_000;

	it("pads the selection on every side", () => {
		const vp = snipViewport({ x: 100, y: 200, width: 50, height: 30 }, 8, W, H, 2, CAP);
		expect(vp).toEqual({ x0: 92, y0: 192, x1: 158, y1: 238, scale: 2 });
	});

	it("clamps the pad at the page edges instead of leaving the page", () => {
		const vp = snipViewport({ x: 2, y: 2, width: 608, height: 788 }, 8, W, H, 2, CAP);
		expect(vp).toEqual({ x0: 0, y0: 0, x1: W, y1: H, scale: 2 });
	});

	it("caps the scale so the output AREA fits, and keeps the crop", () => {
		// 600 x 100 pt at 10 px/pt is 6000 x 1000 = 6,000,000 px. A cap of a
		// quarter of that halves the scale (area goes with its square), so the
		// crop is unchanged and the output is exactly the cap.
		const vp = snipViewport({ x: 0, y: 0, width: 600, height: 100 }, 0, W, H, 10, 1_500_000);
		expect(vp).not.toBeNull();
		expect(vp!.scale).toBeCloseTo(5, 10);
		expect((vp!.x1 - vp!.x0) * vp!.scale * ((vp!.y1 - vp!.y0) * vp!.scale)).toBeCloseTo(1_500_000, 4);
	});

	it("a page-shaped crop is held to the same budget as a strip", () => {
		// The case a per-side cap gets wrong: a whole letter page at 6 px/pt
		// is 3672 x 4752, under 4096 on neither side but 17 Mpx in area.
		const vp = snipViewport({ x: 0, y: 0, width: W, height: H }, 0, W, H, 6, CAP)!;
		const area = (vp.x1 - vp.x0) * vp.scale * ((vp.y1 - vp.y0) * vp.scale);
		expect(area).toBeLessThanOrEqual(CAP + 1);
		expect(area).toBeGreaterThan(CAP * 0.99);
	});

	it("a selection entirely off the page is null, not an empty image", () => {
		expect(snipViewport({ x: 700, y: 100, width: 40, height: 40 }, 8, W, H, 2, CAP)).toBeNull();
	});

	it("degenerate inputs are null", () => {
		const b = { x: 10, y: 10, width: 20, height: 20 };
		expect(snipViewport(b, 8, 0, H, 2, CAP)).toBeNull();
		expect(snipViewport(b, 8, W, H, 0, CAP)).toBeNull();
		expect(snipViewport(b, 8, W, H, 2, 0)).toBeNull();
	});
});
