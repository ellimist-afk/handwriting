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
 */

/** World units per bucket. Strokes are handwriting-sized; 256 keeps the
 * typical bucket at a handful of strokes without exploding bucket count. */
export const BUCKET_WORLD = 256;

export class StrokeIndex {
	private buckets = new Map<string, InkStroke[]>();
	private all: readonly InkStroke[] = [];

	rebuild(strokes: readonly InkStroke[]): void {
		this.buckets.clear();
		this.all = strokes;
		for (const s of strokes) {
			const b = s.bbox;
			const x0 = Math.floor(b.x / BUCKET_WORLD);
			const y0 = Math.floor(b.y / BUCKET_WORLD);
			const x1 = Math.floor((b.x + b.width) / BUCKET_WORLD);
			const y1 = Math.floor((b.y + b.height) / BUCKET_WORLD);
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

	get size(): number {
		return this.all.length;
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
					const b = s.bbox;
					if (
						b.x > rect.x + rect.width ||
						b.y > rect.y + rect.height ||
						b.x + b.width < rect.x ||
						b.y + b.height < rect.y
					) {
						continue;
					}
					seen.add(s);
				}
			}
		}
		// Set preserves insertion order, but bucket iteration order is not
		// z-order across buckets: restore it against the source array.
		if (seen.size === 0) return [];
		const out: InkStroke[] = [];
		for (const s of this.all) if (seen.has(s)) out.push(s);
		return out;
	}
}
