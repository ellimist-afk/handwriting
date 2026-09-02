import { InkStroke } from "../ink/Stroke";
import { Extent, inkFrontier } from "./SurfaceExtent";

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
export class FrontierCache {
	private byPath = new Map<string, { count: number; frontier: Extent }>();

	/** The frontier of `strokes`, computed at most once per invalidation. */
	get(path: string, strokes: readonly InkStroke[]): Extent {
		const hit = this.byPath.get(path);
		if (hit && hit.count === strokes.length) return hit.frontier;
		const frontier = inkFrontier(strokes);
		this.byPath.set(path, { count: strokes.length, frontier });
		return frontier;
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
