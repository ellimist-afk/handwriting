import { BBox, InkStroke } from "./Stroke";

/**
 * Spatial index over a note's strokes (renderer debt, 2026-08-27).
 *
 * Repaint used to test every stroke's bbox against the viewport and then
 * rasterize every visible one from scratch - O(strokes) tests plus
 * O(visible) full ribbon draws per repaint, per erase FRAME while
 * scrubbing. The index buckets strokes into a fixed world-space grid so a
 * tile renderer asks "what overlaps this tile" and touches only those.
 *
 * Rebuilt whole per change: a rebuild is one pass over the strokes and
 * happens at gesture boundaries, which is orders cheaper than what the
 * per-repaint work used to be. Order within a bucket follows the input
 * array, so z-order survives bucket iteration.
 *
 * One exception, added for the note eraser (design doc §5 C1, 2026-09-02):
 * remove and insertLike edit the index in place so a drag does not have to
 * rebuild between pointer samples. rebuild is still the boundary operation
 * and the only thing that resets `zOf` and the oversized list.
 */

/** World units per bucket. Strokes are handwriting-sized; 256 keeps the
 * typical bucket at a handful of strokes without exploding bucket count. */
export const BUCKET_WORLD = 256;

/**
 * Most buckets one stroke is allowed to occupy before it is held aside.
 *
 * Bucketing walks every cell a bbox spans, so the cost is the AREA of the
 * bbox in cells, not the stroke's point count. A single sidecar coordinate
 * of 1e6 spans ~4000 cells per axis - 16 million cells, each allocating a
 * key and a list - and the note freezes with no error and nothing in the
 * console (reproduced 2026-09-01: rebuild had not returned after 15s at
 * 1e6, and never returns at 1e8). The parser now bounds coordinates
 * (PageData.MAX_COORD), so nothing this large should reach here; this is
 * the second line, for a stroke assembled in memory - a mis-scaled paste,
 * a bad camera transform - that never went through the parser.
 *
 * 4096 cells is a square kilometre of note surface, far past any real page,
 * and its rebuild cost is invisible.
 */
export const MAX_STROKE_BUCKETS = 4096;

export class StrokeIndex {
	private buckets = new Map<string, InkStroke[]>();
	private all: readonly InkStroke[] = [];
	/** Paint order per stroke, so query does not rescan `all` to restore it. */
	private zOf = new Map<InkStroke, number>();
	/**
	 * Strokes too large to bucket (see MAX_STROKE_BUCKETS) plus any whose
	 * bbox is not finite. They are tested against every query rect, which is
	 * what the index did for every stroke before it existed.
	 */
	private oversized: InkStroke[] = [];

	rebuild(strokes: readonly InkStroke[]): void {
		this.buckets.clear();
		this.zOf.clear();
		this.oversized = [];
		this.all = strokes;
		for (let z = 0; z < strokes.length; z++) {
			const s = strokes[z]!;
			this.zOf.set(s, z);
			const b = s.bbox;
			const x0 = Math.floor(b.x / BUCKET_WORLD);
			const y0 = Math.floor(b.y / BUCKET_WORLD);
			const x1 = Math.floor((b.x + b.width) / BUCKET_WORLD);
			const y1 = Math.floor((b.y + b.height) / BUCKET_WORLD);
			// Negated so a NaN span (a non-finite bbox) fails the test and is
			// held aside rather than silently skipping the loops below.
			const cells = (x1 - x0 + 1) * (y1 - y0 + 1);
			if (!(cells >= 1 && cells <= MAX_STROKE_BUCKETS)) {
				this.oversized.push(s);
				continue;
			}
			for (let by = y0; by <= y1; by++) {
				for (let bx = x0; bx <= x1; bx++) {
					const key = `${bx},${by}`;
					const list = this.buckets.get(key);
					if (list) list.push(s);
					else this.buckets.set(key, [s]);
				}
			}
		}
	}

	/**
	 * Drop `s` from the index in place (design doc §5 C1, 2026-09-02).
	 *
	 * The note eraser used to set `indexDirty` after every pointer sample,
	 * so a drag rebuilt the whole index once per FRAME - O(strokes) each -
	 * and between samples the index was stale, which is why the eraser
	 * hit-tested the flat stroke list instead of querying it. remove and
	 * insertLike keep the index exact through a gesture, so neither the
	 * per-frame rebuild nor the flat scan is needed.
	 *
	 * Uses the same guard as rebuild (see cellSpan): a stroke held aside as
	 * oversized was never in a bucket, so the bucket walk would not find it.
	 *
	 * The `zOf` entry deliberately SURVIVES the removal. The eraser calls
	 * remove(stroke) and then insertLike(piece, stroke) for the pieces that
	 * replace it, so the original's paint depth has to outlive it. The
	 * entries are dropped wholesale by the next rebuild.
	 */
	remove(s: InkStroke): void {
		const span = cellSpan(s.bbox);
		if (!span) {
			const at = this.oversized.indexOf(s);
			if (at >= 0) this.oversized.splice(at, 1);
			return;
		}
		for (let by = span.y0; by <= span.y1; by++) {
			for (let bx = span.x0; bx <= span.x1; bx++) {
				const key = `${bx},${by}`;
				const list = this.buckets.get(key);
				if (!list) continue;
				const at = list.indexOf(s);
				if (at >= 0) list.splice(at, 1);
				if (list.length === 0) this.buckets.delete(key);
			}
		}
	}

	/**
	 * Add `s` at `original`'s paint depth (design doc §5 C1, 2026-09-02).
	 *
	 * For the eraser's pieces: a split stroke's survivors are spliced into
	 * the store at the ORIGINAL's index, so they paint at its depth. Pieces
	 * of one stroke do not overlap each other, so the z ties among them are
	 * harmless. Bucketed under the same guard as rebuild, so an oversized or
	 * non-finite piece takes the same path it would have taken there.
	 *
	 * Position within a bucket list does not carry order - query sorts its
	 * hits by `zOf` - so appending is enough.
	 */
	insertLike(s: InkStroke, original: InkStroke): void {
		// ?? 0 matches query's own fallback for a stroke with no recorded
		// depth; in practice the original was indexed or the caller would
		// have rebuilt first.
		this.zOf.set(s, this.zOf.get(original) ?? 0);
		const span = cellSpan(s.bbox);
		if (!span) {
			this.oversized.push(s);
			return;
		}
		for (let by = span.y0; by <= span.y1; by++) {
			for (let bx = span.x0; bx <= span.x1; bx++) {
				const key = `${bx},${by}`;
				const list = this.buckets.get(key);
				if (list) list.push(s);
				else this.buckets.set(key, [s]);
			}
		}
	}

	/**
	 * The length of the list the last rebuild was given. The incremental
	 * ops (remove, insertLike) do not move it - nothing outside diagnostics
	 * and tests reads it, and keeping a live count would mean tracking
	 * membership the queries do not need.
	 */
	get size(): number {
		return this.all.length;
	}

	/** How many strokes bypassed bucketing. Diagnostics and tests. */
	get oversizedCount(): number {
		return this.oversized.length;
	}

	/**
	 * Strokes whose bbox intersects the world rect, in stable z-order,
	 * deduplicated (a stroke spanning buckets appears once).
	 */
	query(rect: BBox): InkStroke[] {
		const x0 = Math.floor(rect.x / BUCKET_WORLD);
		const y0 = Math.floor(rect.y / BUCKET_WORLD);
		const x1 = Math.floor((rect.x + rect.width) / BUCKET_WORLD);
		const y1 = Math.floor((rect.y + rect.height) / BUCKET_WORLD);
		const seen = new Set<InkStroke>();
		for (let by = y0; by <= y1; by++) {
			for (let bx = x0; bx <= x1; bx++) {
				const list = this.buckets.get(`${bx},${by}`);
				if (!list) continue;
				for (const s of list) {
					if (hits(s.bbox, rect)) seen.add(s);
				}
			}
		}
		for (const s of this.oversized) {
			if (hits(s.bbox, rect)) seen.add(s);
		}
		// Bucket iteration order is not z-order across buckets. Sorting the
		// hits by their recorded paint order costs O(k log k) in the number
		// of hits; the previous restore walked all N strokes on every rect,
		// and repaint issues up to 12 rects per frame.
		if (seen.size === 0) return [];
		const out = [...seen];
		out.sort((a, b) => (this.zOf.get(a) ?? 0) - (this.zOf.get(b) ?? 0));
		return out;
	}
}

/**
 * Rect overlap, written so a non-finite bbox matches NOTHING.
 *
 * Every comparison against NaN is false, so the plain negated form
 * ("not separated on any axis") answers TRUE for a NaN bbox and such a
 * stroke would be returned by every query once it sits in the oversized
 * list. Before the oversized list existed it was unreachable instead,
 * because `Math.floor(NaN)` bucket loops never ran. Keep that: a stroke
 * with no real geometry stays out of repaint and hit-testing rather than
 * being dragged into all of both.
 */
function hits(b: BBox, rect: BBox): boolean {
	if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.width) || !Number.isFinite(b.height)) {
		return false;
	}
	return !(
		b.x > rect.x + rect.width ||
		b.y > rect.y + rect.height ||
		b.x + b.width < rect.x ||
		b.y + b.height < rect.y
	);
}

/**
 * The bucket cells a bbox spans, or null when it must be held aside.
 *
 * Mirrors the guard inside rebuild - more than MAX_STROKE_BUCKETS cells, or
 * a non-finite bbox, whose NaN span fails the negated test - because the
 * incremental ops (remove, insertLike, design doc §5 C1) have to place and
 * find a stroke in exactly the cells rebuild would use. Keep the two in
 * step; StrokeIndex.test.ts checks a gesture's index against a fresh
 * rebuild of the same list, which is what catches a drift here.
 */
function cellSpan(b: BBox): { x0: number; y0: number; x1: number; y1: number } | null {
	const x0 = Math.floor(b.x / BUCKET_WORLD);
	const y0 = Math.floor(b.y / BUCKET_WORLD);
	const x1 = Math.floor((b.x + b.width) / BUCKET_WORLD);
	const y1 = Math.floor((b.y + b.height) / BUCKET_WORLD);
	const cells = (x1 - x0 + 1) * (y1 - y0 + 1);
	if (!(cells >= 1 && cells <= MAX_STROKE_BUCKETS)) return null;
	return { x0, y0, x1, y1 };
}
