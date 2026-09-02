import { describe, expect, it } from "vitest";
import { BUCKET_WORLD, StrokeIndex } from "./StrokeIndex";
import { InkPoint, InkStroke, computeBBox } from "./Stroke";
import { eraserRect, strokesHitByCircle } from "./Eraser";

function stroke(id: string, x: number, y: number, w = 10, h = 10): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000",
		width: 2,
		points: [{ x, y, pressure: 0.5, t: 0 }],
		bbox: { x, y, width: w, height: h },
		createdAt: 0,
	} as InkStroke;
}

describe("StrokeIndex", () => {
	it("finds strokes intersecting a rect and misses the rest", () => {
		const idx = new StrokeIndex();
		idx.rebuild([stroke("a", 0, 0), stroke("b", 1000, 1000), stroke("c", 40, 40)]);
		const hit = idx.query({ x: 0, y: 0, width: 60, height: 60 });
		expect(hit.map((s) => s.id)).toEqual(["a", "c"]);
	});

	it("a stroke spanning buckets is returned once", () => {
		const idx = new StrokeIndex();
		idx.rebuild([stroke("wide", 10, 10, BUCKET_WORLD * 3, 5)]);
		const hit = idx.query({ x: 0, y: 0, width: BUCKET_WORLD * 4, height: 100 });
		expect(hit.map((s) => s.id)).toEqual(["wide"]);
	});

	it("preserves z-order across buckets", () => {
		const idx = new StrokeIndex();
		const list = [
			stroke("under", BUCKET_WORLD + 5, 5),
			stroke("mid", 5, 5),
			stroke("over", BUCKET_WORLD + 6, 6),
		];
		idx.rebuild(list);
		const hit = idx.query({ x: 0, y: 0, width: BUCKET_WORLD * 2, height: 100 });
		expect(hit.map((s) => s.id)).toEqual(["under", "mid", "over"]);
	});

	it("negative coordinates bucket correctly", () => {
		const idx = new StrokeIndex();
		idx.rebuild([stroke("neg", -300, -300)]);
		expect(idx.query({ x: -320, y: -320, width: 50, height: 50 }).length).toBe(1);
		expect(idx.query({ x: 0, y: 0, width: 50, height: 50 }).length).toBe(0);
	});

	it("bbox test still applies inside a shared bucket", () => {
		const idx = new StrokeIndex();
		idx.rebuild([stroke("far", 5, 5), stroke("near", 200, 200)]);
		// same bucket (both under 256), disjoint rects
		expect(idx.query({ x: 190, y: 190, width: 30, height: 30 }).map((s) => s.id)).toEqual([
			"near",
		]);
	});

	it("rebuild replaces the previous contents", () => {
		const idx = new StrokeIndex();
		idx.rebuild([stroke("old", 0, 0)]);
		idx.rebuild([stroke("new", 0, 0)]);
		expect(idx.query({ x: 0, y: 0, width: 20, height: 20 }).map((s) => s.id)).toEqual(["new"]);
	});

	// A single huge coordinate used to make rebuild walk millions of cells
	// and never return (2026-09-01). Such a stroke is held aside instead and
	// still answers queries, in z-order with everything else.
	it("a stroke spanning more than MAX_STROKE_BUCKETS cells is held aside, not walked", () => {
		const idx = new StrokeIndex();
		const span = BUCKET_WORLD * 1_000_000;
		const started = performance.now();
		idx.rebuild([stroke("under", 5, 5), stroke("huge", -span / 2, -span / 2, span, span), stroke("over", 6, 6)]);
		expect(performance.now() - started).toBeLessThan(200);
		expect(idx.oversizedCount).toBe(1);
		const hit = idx.query({ x: 0, y: 0, width: 20, height: 20 });
		expect(hit.map((s) => s.id)).toEqual(["under", "huge", "over"]);
		// Far from everything bucketed, only the oversized stroke answers.
		expect(idx.query({ x: span / 4, y: span / 4, width: 1, height: 1 }).map((s) => s.id)).toEqual([
			"huge",
		]);
	});

	it("a non-finite bbox is held aside rather than silently dropped", () => {
		const idx = new StrokeIndex();
		idx.rebuild([stroke("nan", NaN, NaN, NaN, NaN), stroke("ok", 0, 0)]);
		expect(idx.oversizedCount).toBe(1);
		// It never intersects anything (NaN comparisons are false), but it is
		// counted and does not take the bucket walk down with it.
		expect(idx.query({ x: 0, y: 0, width: 20, height: 20 }).map((s) => s.id)).toEqual(["ok"]);
	});

	it("exactly MAX_STROKE_BUCKETS cells still buckets normally", () => {
		const idx = new StrokeIndex();
		// 64 x 64 cells = 4096, aligned to the grid so the count is exact.
		const side = BUCKET_WORLD * 64 - 1;
		idx.rebuild([stroke("edge", 0, 0, side, side)]);
		expect(idx.oversizedCount).toBe(0);
		expect(idx.query({ x: side - 1, y: side - 1, width: 1, height: 1 }).length).toBe(1);
	});
});

describe("StrokeIndex z-order", () => {
	it("restores paint order over many buckets without touching unrelated strokes", () => {
		const idx = new StrokeIndex();
		const list: InkStroke[] = [];
		for (let i = 0; i < 500; i++) list.push(stroke(`s${i}`, (i % 25) * BUCKET_WORLD, Math.floor(i / 25) * BUCKET_WORLD));
		idx.rebuild(list);
		const hit = idx.query({ x: 0, y: 0, width: BUCKET_WORLD * 3 + 1, height: BUCKET_WORLD * 3 + 1 });
		const ids = hit.map((s) => Number(s.id.slice(1)));
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		expect(ids.length).toBe(16);
	});
});

/**
 * Incremental ops (design doc §5 C1, 2026-09-02).
 *
 * The note eraser queries the index for candidates instead of scanning the
 * whole note, and keeps it exact through the gesture with remove/insertLike
 * rather than marking it dirty after every pointer sample (which rebuilt it
 * once per FRAME and left it stale in between). Everything load-bearing about
 * that lives here: the overlay itself is DOM-bound and not testable.
 */
describe("StrokeIndex incremental", () => {
	it("remove drops a stroke from every bucket it spanned", () => {
		const idx = new StrokeIndex();
		const wide = stroke("wide", 10, 10, BUCKET_WORLD * 3, 5);
		idx.rebuild([wide, stroke("keep", 10, 10)]);
		idx.remove(wide);
		for (let b = 0; b <= 3; b++) {
			const hit = idx.query({ x: b * BUCKET_WORLD + 20, y: 10, width: 4, height: 4 });
			expect(hit.map((s) => s.id)).not.toContain("wide");
		}
		// The bucket it shared with another stroke still answers for that one.
		expect(idx.query({ x: 10, y: 10, width: 5, height: 5 }).map((s) => s.id)).toEqual(["keep"]);
	});

	it("insertLike gives the piece the original's paint depth", () => {
		const idx = new StrokeIndex();
		const under = stroke("under", 5, 5);
		const mid = stroke("mid", 6, 6);
		const over = stroke("over", 7, 7);
		idx.rebuild([under, mid, over]);
		const piece = stroke("piece", 6, 6);
		idx.remove(mid);
		idx.insertLike(piece, mid);
		// Order proves the z: the piece paints where its original did, not on
		// top, which is what the store does by splicing it at the same index.
		const hit = idx.query({ x: 0, y: 0, width: 40, height: 40 });
		expect(hit.map((s) => s.id)).toEqual(["under", "piece", "over"]);
	});

	it("insertLike buckets a piece into every cell it spans", () => {
		const idx = new StrokeIndex();
		const orig = stroke("orig", 10, 10, 5, 5);
		idx.rebuild([orig]);
		idx.remove(orig);
		idx.insertLike(stroke("piece", 10, 10, BUCKET_WORLD * 2 + 30, 5), orig);
		for (let b = 0; b <= 2; b++) {
			const hit = idx.query({ x: b * BUCKET_WORLD + 20, y: 12, width: 2, height: 2 });
			expect(hit.map((s) => s.id)).toEqual(["piece"]);
		}
	});

	it("an oversized stroke goes out and back through the oversized list", () => {
		const idx = new StrokeIndex();
		const span = BUCKET_WORLD * 1_000_000;
		const huge = stroke("huge", -span / 2, -span / 2, span, span);
		idx.rebuild([stroke("small", 5, 5), huge]);
		expect(idx.oversizedCount).toBe(1);
		idx.remove(huge);
		expect(idx.oversizedCount).toBe(0);
		expect(idx.query({ x: 0, y: 0, width: 20, height: 20 }).map((s) => s.id)).toEqual(["small"]);
		const piece = stroke("hugePiece", -span / 2, -span / 2, span, span);
		idx.insertLike(piece, huge);
		expect(idx.oversizedCount).toBe(1);
		// Still answers every query, near and far, and at the original's depth.
		expect(idx.query({ x: 0, y: 0, width: 20, height: 20 }).map((s) => s.id)).toEqual([
			"small",
			"hugePiece",
		]);
		expect(idx.query({ x: span / 4, y: span / 4, width: 1, height: 1 }).map((s) => s.id)).toEqual(
			["hugePiece"]
		);
	});

	it("a non-finite piece takes the same held-aside path insertLike-side", () => {
		const idx = new StrokeIndex();
		const orig = stroke("orig", 0, 0);
		idx.rebuild([orig]);
		idx.remove(orig);
		idx.insertLike(stroke("nan", NaN, NaN, NaN, NaN), orig);
		expect(idx.oversizedCount).toBe(1);
		expect(idx.query({ x: 0, y: 0, width: 20, height: 20 })).toEqual([]);
	});

	it("is exact through a gesture: same answers as a rebuild of the final list", () => {
		// One erase drag: strokes come out (takeLive) and some are replaced by
		// a survivor spliced in at the same index (applyAddLive). With one
		// piece per cut the final list keeps its shape, so a fresh rebuild is
		// a true oracle for ORDER as well as membership.
		const list: InkStroke[] = [];
		for (let i = 0; i < 120; i++) {
			list.push(stroke(`s${i}`, (i % 12) * 90, Math.floor(i / 12) * 90, 40, 40));
		}
		const idx = new StrokeIndex();
		idx.rebuild(list);
		const final: (InkStroke | null)[] = [...list];
		for (let i = 5; i < 120; i += 11) {
			const orig = list[i]!;
			idx.remove(orig);
			if (i % 2 === 0) {
				final[final.indexOf(orig)] = null;
				continue;
			}
			const piece = stroke(`${orig.id}p`, orig.bbox.x + 5, orig.bbox.y + 5, 20, 20);
			idx.insertLike(piece, orig);
			final[final.indexOf(orig)] = piece;
		}
		const fresh = new StrokeIndex();
		fresh.rebuild(final.filter((s): s is InkStroke => s !== null));
		for (let qx = -50; qx < 1150; qx += 57) {
			for (let qy = -50; qy < 500; qy += 61) {
				const rect = { x: qx, y: qy, width: 70, height: 70 };
				expect(idx.query(rect).map((s) => s.id)).toEqual(fresh.query(rect).map((s) => s.id));
			}
		}
	});

	it("two pieces of one stroke both answer, at the original's depth", () => {
		// A cut through the middle leaves two survivors. They share the
		// original's z - the tie the design doc calls harmless, because pieces
		// of one stroke do not overlap - so membership is what is asserted.
		const idx = new StrokeIndex();
		const orig = stroke("orig", 0, 0, BUCKET_WORLD * 2, 10);
		idx.rebuild([stroke("below", 0, 500), orig, stroke("above", 0, 600)]);
		idx.remove(orig);
		const left = stroke("left", 0, 0, 20, 10);
		const right = stroke("right", BUCKET_WORLD * 2 - 20, 0, 20, 10);
		idx.insertLike(left, orig);
		idx.insertLike(right, orig);
		const hit = idx.query({ x: -10, y: -10, width: BUCKET_WORLD * 3, height: 40 });
		expect(new Set(hit.map((s) => s.id))).toEqual(new Set(["left", "right"]));
	});
});

/**
 * The regression this slice has to not have: a candidate set that misses a
 * hit the flat scan would have found. Seeded, so a failure is reproducible;
 * the seed is printed with any mismatch.
 */
describe("StrokeIndex / eraser equivalence", () => {
	const SEED = 0x5eed1234;

	function rng(seed: number): () => number {
		let a = seed >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	function inked(id: string, rand: () => number): InkStroke {
		const n = 2 + Math.floor(rand() * 4);
		const x0 = rand() * 4000 - 200;
		const y0 = rand() * 4000 - 200;
		const points: InkPoint[] = [];
		for (let i = 0; i < n; i++) {
			points.push({ x: x0 + rand() * 300, y: y0 + rand() * 300, pressure: 0.5, t: i });
		}
		return {
			id,
			tool: "pen",
			color: "#000",
			width: 2,
			points,
			// Padded like a real stroke, so some candidates the index
			// returns fail the segment test - both sides see the same bbox.
			bbox: computeBBox(points, 2),
			createdAt: 0,
		} as InkStroke;
	}

	it("index candidates hit exactly what the flat list hits", () => {
		const rand = rng(SEED);
		const strokes: InkStroke[] = [];
		for (let i = 0; i < 300; i++) strokes.push(inked(`s${i}`, rand));
		const idx = new StrokeIndex();
		idx.rebuild(strokes);
		const bad: string[] = [];
		let touching = 0;
		for (let i = 0; i < 200; i++) {
			const cx = rand() * 4400 - 400;
			const cy = rand() * 4400 - 400;
			const r = 5 + rand() * 60;
			const flat = strokesHitByCircle(strokes, cx, cy, r);
			const viaIndex = strokesHitByCircle(idx.query(eraserRect(cx, cy, r)), cx, cy, r);
			if (flat.length > 0) touching++;
			if (JSON.stringify(flat) !== JSON.stringify(viaIndex)) {
				bad.push(
					`seed=0x${SEED.toString(16)} i=${i} circle=(${cx},${cy},${r}) flat=[${flat}] index=[${viaIndex}]`
				);
			}
		}
		expect(bad).toEqual([]);
		// A run where no circle touched anything would prove nothing.
		expect(touching).toBeGreaterThan(20);
	});
});
