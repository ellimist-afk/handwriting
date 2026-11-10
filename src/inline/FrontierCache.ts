import { InkStroke } from "../ink/Stroke";
import { Extent, inkFrontier, inkLeftReach } from "./SurfaceExtent";

/**
 * The ink frontier, remembered per note.
 *
 * `updateExtent` runs at the end of every repaint, so a scroll of a note with
 * 3,000 strokes walked 3,000 bboxes per frame to re-derive a number that only
 * changes when the ink does (audit doc §5g/G1). The walk is `inkFrontier`,
 * `SurfaceExtent.ts`; nothing about it is wrong, it was just being asked the
 * same question sixty times a second.
 *
 * Two things keep an entry honest. The overlay invalidates on `onInkChanged`
 * and explicitly at the two gesture ends that mutate without notifying until
 * their save. And a hit requires the stroke COUNT to match: the store mutates
 * `rec.strokes` in place, so array identity proves nothing, but every path
 * that can change the frontier without an event - the lazy sidecar load
 * (`ensureLoaded` does NOT notify), the add leg of undo/redo - changes the
 * count. A move at a constant count is exactly the lasso case, which is
 * invalidated by hand.
 *
 * The frontier object is returned BY IDENTITY on a hit, so a caller can use
 * `===` to ask "is this the same frontier as last time" without comparing
 * fields.
 */
/** An attached group's box where this surface shows it, note px. */
export interface ReachBox {
	readonly x: number;
	readonly y: number;
	readonly right: number;
	readonly bottom: number;
}

/** The ink's reach for `updateExtent`: the frontier (by identity, as `get`) and how far it reaches left of the origin. */
export interface InkReach {
	readonly frontier: Extent;
	readonly left: number;
}

export class FrontierCache {
	private byPath = new Map<string, { count: number; frontier: Extent; left: number }>();
	/** The last merged reach per note: kept while its x and y hold, across a recompute of the free part. */
	private mergedByPath = new Map<string, { frontier: Extent; left: number }>();
	/** Walks over a whole stroke list (inkFrontier and inkLeftReach), for the budget rig. */
	passes = 0;

	/** The frontier of `strokes`, computed at most once per invalidation. */
	get(path: string, strokes: readonly InkStroke[]): Extent {
		return this.entry(path, strokes).frontier;
	}

	/** How far the ink reaches left of the origin (`inkLeftReach`), on the same entry as the frontier. */
	leftReach(path: string, strokes: readonly InkStroke[]): number {
		return this.entry(path, strokes).left;
	}

	/**
	 * The reach of free ink (`free`, cached as `get` is) merged with attached groups' shown boxes. A follow moves
	 * groups and no free stroke, so it costs a merge over the boxes, not a walk over the note. The frontier is the prior
	 * object while x and y are equal, so `sameExtentInputs` skips the layout reads; a changed value is a new object, so a
	 * group moving down grows the extent and moving up shrinks it, both exactly. No boxes: the free entry itself.
	 */
	reach(path: string, free: readonly InkStroke[], boxes: readonly ReachBox[]): InkReach {
		const e = this.entry(path, free);
		if (boxes.length === 0) return e;
		let x = e.frontier.x, y = e.frontier.y, left = e.left;
		for (const b of boxes) {
			if (b.right > x) x = b.right;
			if (b.bottom > y) y = b.bottom;
			if (-b.x > left && Number.isFinite(b.x)) left = -b.x;
		}
		const was = this.mergedByPath.get(path);
		if (was && was.frontier.x === x && was.frontier.y === y) {
			was.left = left;
			return was;
		}
		const next = { frontier: { x, y }, left };
		this.mergedByPath.set(path, next);
		return next;
	}

	private entry(path: string, strokes: readonly InkStroke[]): { count: number; frontier: Extent; left: number } {
		const hit = this.byPath.get(path);
		if (hit && hit.count === strokes.length) return hit;
		this.passes++;
		const next = { count: strokes.length, frontier: inkFrontier(strokes), left: inkLeftReach(strokes) };
		this.byPath.set(path, next);
		return next;
	}

	/** Forget one note's frontier; the next `get` recomputes it. */
	invalidate(path: string): void {
		this.byPath.delete(path);
	}
}

/**
 * Everything `updateExtent`'s result depends on that can be read WITHOUT
 * touching layout. When two of these are equal the four layout reads the
 * method would make next (two `getBoundingClientRect`, the origin, the spacer
 * position) cannot produce a different answer, so they can be skipped.
 *
 * The camera covers scrolling. `fontZoom`, `pinchScale` and `cssScale` cover
 * the zooms, which reflow the text with the camera standing still.
 * `cssWidth`/`cssHeight` cover a viewport resize: `zoomFrontier` reads the
 * scroller's client box, and `handleResize` writes these two from the same
 * box before anything reaches here. `writtenOn` covers `writeFrontier`'s
 * on/off state (1.4.6 §5n): it can flip true on pen contact alone, before
 * any stroke lands in `frontier`, so it must be its own field or that
 * flip is invisible to this comparison and the skip holds a stale extent.
 */
export interface ExtentInputs {
	readonly scrollRevision?: number;
	readonly granted?: Extent;
	readonly path: string;
	readonly frontier: Extent;
	readonly writtenOn: boolean;
	readonly camX: number;
	readonly camY: number;
	readonly camZoom: number;
	readonly fontZoom: number;
	readonly pinchScale: number;
	readonly cssScale: number;
	readonly cssWidth: number;
	readonly cssHeight: number;
}

/** True when `b` cannot have a different extent than the already-applied `a`. */
export function sameExtentInputs(a: ExtentInputs | null, b: ExtentInputs): boolean {
	return (
		a !== null &&
		a.scrollRevision === b.scrollRevision &&
		a.granted === b.granted &&
		a.path === b.path &&
		// Identity: FrontierCache hands back the same object until invalidated.
		a.frontier === b.frontier &&
		a.writtenOn === b.writtenOn &&
		a.camX === b.camX &&
		a.camY === b.camY &&
		a.camZoom === b.camZoom &&
		a.fontZoom === b.fontZoom &&
		a.pinchScale === b.pinchScale &&
		a.cssScale === b.cssScale &&
		a.cssWidth === b.cssWidth &&
		a.cssHeight === b.cssHeight
	);
}
