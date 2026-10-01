import { InkStroke } from "../ink/Stroke";
import { visualToNote } from "./ZoomScale";

/**
 * The note surface extends beyond the Markdown: OneNote semantics say ink may
 * live below the last line and to the right of the content column, and the
 * user must be able to SCROLL there. CodeMirror sizes its scroller from the
 * text alone, so Handwriting places one invisible 1×1 "extent" spacer inside the
 * scroller at (note origin + granted extent) in scroller-content coordinates.
 * scrollWidth/scrollHeight then cover the inked surface and native scrolling
 * reaches it. No wheel handling, no scroll hijacking.
 *
 * The granted extent GROWS in coarse chunks and does not shrink while ink is
 * being written, so the scroll range is stable while writing (a scrollbar that
 * pumps per stroke is nauseating). Growth is driven by the ink frontier,
 * the maximum x/y any stroke's bbox reaches on that note. The one way back
 * down is sideways, after ink is removed or Infinite Canvas is turned off
 * (`shrunkAxis`, `onScreenFloorX`, `SurfaceExtents.oweShrinkX`).
 *
 * RECONSTRUCTION NOTE (2026-08-21): this module was first written in the
 * session that produced the deployed hardware build of 2026-08-20 (the one
 * after `59d9349`); that session's container died before the source was
 * bundled. This file is reconstructed from the deployed main.js. Constants
 * and behavior match the deployed build exactly.
 */

/** Chunk the granted extent grows in, note-space px. */
export const EXTENT_CHUNK = 256;
/** Headroom past the frontier when growing, note-space px. */
export const EXTENT_HEADROOM = 256;
/**
 * How close the frontier must come to the granted edge before another grow.
 * Inside this margin the next chunk is granted preemptively.
 */
export const EXTENT_MARGIN = 120;

export interface Extent {
	readonly x: number;
	readonly y: number;
}

export const ZERO_EXTENT: Extent = Object.freeze({ x: 0, y: 0 });

interface ScrollRoom {
	left: number; top: number; width: number; height: number;
	/** Native scroll range subtracts the untransformed client size. */
	nativeWidth?: number; nativeHeight?: number;
	edgeX: number; edgeY: number; origin: { left: number; top: number };
	fontZoom: number; pinchScale: number;
}

/** Cheap offset sampling; layout is read only when a reserve is due. */
export class ScrollExpansionDemand {
	revision = 0;
	private path = "";
	private enabled = false;
	private left = 0;
	private top = 0;
	private pendingX = false;
	private pendingY = false;
	private room: ScrollRoom | null = null;
	private rebased = false;

	sample(path: string, enabled: boolean, left: number, top: number): number {
		if (path !== this.path || enabled !== this.enabled) {
			this.path = path; this.enabled = enabled; this.room = null;
			this.pendingX = this.pendingY = enabled;
			this.revision++;
		} else if (enabled && this.room) {
			const r = this.room;
			const x = left > this.left && r.edgeX - left - (r.nativeWidth ?? r.width) < r.width / 4;
			const y = top > this.top && r.edgeY - top - (r.nativeHeight ?? r.height) < r.height / 4;
			if ((x && !this.pendingX) || (y && !this.pendingY)) this.revision++;
			this.pendingX ||= x; this.pendingY ||= y;
		}
		this.left = left; this.top = top;
		return this.revision;
	}

 /** Programmatic navigation/resize rebases offsets without generating demand. */
 rebase(left:number,top:number,preserveDemand=false):void {
  this.left=left; this.top=top;
  this.rebased=true;
  if(this.room && !preserveDemand) { this.pendingX=false; this.pendingY=false; }
 }

	reserve(next: ScrollRoom, navigation?: { left: number; top: number }): Extent {
		if (!this.enabled || next.width <= 0 || next.height <= 0 || next.fontZoom <= 0) return ZERO_EXTENT;
		const old = this.room;
		const resized = !old || old.fontZoom !== next.fontZoom || old.pinchScale !== next.pinchScale;
		const x = this.pendingX || !old || (!this.rebased && (resized || old.width !== next.width));
		const y = this.pendingY || !old || (!this.rebased && (resized || old.height !== next.height));
		this.rebased = false;
		this.room = next;
		this.pendingX = this.pendingY = false;
		const nativeWidth = next.nativeWidth ?? next.width;
		const nativeHeight = next.nativeHeight ?? next.height;
		// A zoom-out can consume the entire native range. Seed that newly
		// stranded axis once, even after a camera rebase; stationary geometry
		// and navigation within an existing range do not request another grant.
		const strandedX = !!old && (resized || old.width !== next.width) && next.edgeX <= nativeWidth;
		const strandedY = !!old && (resized || old.height !== next.height) && next.edgeY <= nativeHeight;
		// A completed pinch supplies its accepted scroll demand before the
		// browser clamps the write. Preview never mutates the extent or raster.
		const left = navigation && Number.isFinite(navigation.left) ? Math.max(next.left, navigation.left) : next.left;
		const top = navigation && Number.isFinite(navigation.top) ? Math.max(next.top, navigation.top) : next.top;
		return {
			x: Math.max(strandedX ? Math.max(0, (nativeWidth + next.width - next.origin.left) / next.fontZoom) : 0,
				(x || left > next.left) && next.edgeX - left - nativeWidth < next.width
					? Math.max(0, (left + nativeWidth + next.width - next.origin.left) / next.fontZoom) : 0),
			y: Math.max(strandedY ? Math.max(0, (nativeHeight + next.height - next.origin.top) / next.fontZoom) : 0,
				(y || top > next.top) && next.edgeY - top - nativeHeight < next.height
					? Math.max(0, (top + nativeHeight + next.height - next.origin.top) / next.fontZoom) : 0),
		};
	}

	applied(edgeX: number, edgeY: number): void {
		if (!this.room) return;
		this.room.edgeX = Math.max(this.room.edgeX, edgeX);
		this.room.edgeY = Math.max(this.room.edgeY, edgeY);
	}
}

/** One axis of the chunked, never-shrinking grow rule. */
export function grownAxis(current: number, needed: number): number {
	if (!Number.isFinite(needed) || needed <= 0 || needed <= current - EXTENT_MARGIN) {
		return current;
	}
	const next = Math.ceil((needed + EXTENT_HEADROOM) / EXTENT_CHUNK) * EXTENT_CHUNK;
	return Math.max(current, next);
}

/** Returns the SAME object when nothing grew, so callers can cheap-compare. */
export function grownExtent(current: Extent, needed: Extent): Extent {
	const x = grownAxis(current.x, needed.x);
	const y = grownAxis(current.y, needed.y);
	return x === current.x && y === current.y ? current : { x, y };
}

/**
 * What the ink frontier asks of the x axis, in note px.
 *
 * Sideways room grows from ink. With Infinite Canvas on, any ink grows it
 * (frontier plus headroom, as before). With it off, ink grows it only once the
 * frontier comes within EXTENT_MARGIN of the pane's right edge, and the room
 * shrinks back when the ink retreats or is deleted. Growth after the first grant
 * follows the Y rule (grownAxis) in both modes.
 *
 * The margin is note px, scaled into the pane like the frontier.
 * `originLeft` and `clientWidth` are the scroller's content px; the frontier is
 * scaled into them by `fontZoom`.
 */
export function inkClaimX(g: {
	frontierX: number;
	originLeft: number;
	clientWidth: number;
	fontZoom: number;
	infiniteCanvas: boolean;
}): number {
	if (g.infiniteCanvas) return g.frontierX;
	if (!Number.isFinite(g.frontierX) || g.frontierX <= 0 || !Number.isFinite(g.fontZoom) || g.fontZoom <= 0) return 0;
	return g.originLeft + g.frontierX * g.fontZoom > g.clientWidth - EXTENT_MARGIN * g.fontZoom ? g.frontierX : 0;
}

/**
 * The smallest x grant that keeps what is on screen scrollable, in note px:
 * the spacer must still reach the right edge of the view, or the browser pulls
 * scrollLeft back and the page jumps. Rounded up to whole chunks, so a shrink
 * that waits on the view steps down a chunk at a time as the view moves left
 * rather than moving the spacer on every scrolled frame. 0 at scrollLeft 0: the
 * pane itself is always in range.
 */
export function onScreenFloorX(g: {
	scrollLeft: number;
	clientWidth: number;
	originLeft: number;
	fontZoom: number;
}): number {
	if (!Number.isFinite(g.scrollLeft) || g.scrollLeft <= 0 || !Number.isFinite(g.fontZoom) || g.fontZoom <= 0) return 0;
	// One px spare for the spacer's own rounding (spacerPosition).
	const needed = (g.scrollLeft + g.clientWidth + 1 - g.originLeft) / g.fontZoom;
	return needed <= 0 ? 0 : Math.ceil(needed / EXTENT_CHUNK) * EXTENT_CHUNK;
}

/**
 * One axis of a grant re-measured after ink was removed: the grant `needed`
 * would earn from nothing (`grownAxis(0, needed)`, so the next stroke does not
 * immediately grow it back), held at `floor`, and never above `current`.
 * `complete` is false while the floor is what holds it up: the rest is still
 * owed, and comes off when the view moves left or at the next pass.
 */
export function shrunkAxis(current: number, needed: number, floor: number): { value: number; complete: boolean } {
	const settled = grownAxis(0, needed);
	const held = Number.isFinite(floor) && floor > settled ? floor : settled;
	return { value: Math.min(current, held), complete: held === settled || current <= settled };
}

/**
 * How long a scroll must have been still before a shrink the view held back
 * takes its next step, ms. A shrink never steps on a scrolled frame: it goes at
 * the pass that made it due, and after that only at the end of a gesture (a
 * pen, pan, space or pinch settle) or once the scroll has been quiet this long.
 * Wheel notches and touchpad frames arrive well inside it, so a scroll in
 * progress never sees the range move under it.
 */
export const SHRINK_SCROLL_IDLE_MS = 250;

/** The ink frontier: the furthest right/down any stroke's bbox reaches. */
export function inkFrontier(strokes: readonly InkStroke[]): Extent {
	let x = 0;
	let y = 0;
	for (const s of strokes) {
		const right = s.bbox.x + s.bbox.width;
		const bottom = s.bbox.y + s.bbox.height;
		if (right > x) x = right;
		if (bottom > y) y = bottom;
	}
	return { x, y };
}

/**
 * How far any stroke's bbox reaches LEFT of the origin, note px; 0 when none
 * does. The surface's x grant grows to the right only; this is the other side.
 */
export function inkLeftReach(strokes: readonly InkStroke[]): number {
	let reach = 0;
	for (const s of strokes) if (-s.bbox.x > reach) reach = -s.bbox.x;
	return Number.isFinite(reach) ? reach : 0;
}

/**
 * The scroll room a scroller holds left of its column for ink left of the
 * origin, layout px: none. The page is bounded by its top and left edges, so
 * ink left of the origin is drawn where it lies and never buys scroll past the
 * page's left edge, however far it reaches past the column's margin.
 */
export function leftReserve(_g: { reachNote: number; naturalMargin: number; fontZoom: number }): number {
	return 0;
}

/**
 * Where the note-surface origin sits in the scroller's CONTENT coordinate
 * space (the space `left`/`top` of an absolutely positioned child uses when
 * the scroller is the containing block). All rect inputs are visual px; the
 * result is layout px, which is what element styles take.
 */
export function surfaceOriginInScroller(g: {
	contentLeftVisual: number;
	documentTopVisual: number;
	scrollRectLeft: number;
	scrollRectTop: number;
	scrollLeft: number;
	scrollTop: number;
	scale: number;
}): { left: number; top: number } {
	return {
		left: visualToNote(g.contentLeftVisual - g.scrollRectLeft, g.scale) + g.scrollLeft,
		top: visualToNote(g.documentTopVisual - g.scrollRectTop, g.scale) + g.scrollTop,
	};
}

/**
 * The extent a pinch zoom needs, in note px, so the whole magnified note is
 * reachable.
 *
 * The transform sits on the editor and the scroller is inside it, so scaling
 * paints the scroller bigger but does not add ONE pixel of scroll range: at
 * 2x the right half of every line and the bottom of the viewport were simply
 * unreachable. The pane shows a `1/k` slice of the scroller, so bringing the
 * far edge of the content into view needs scroll up to `size * (1 - 1/k)`
 * past where `k = 1` needed - which is exactly what the extent spacer is
 * for. Zero at `k <= 1`, so an unzoomed note grants nothing.
 */
export function zoomFrontier(g: {
	clientWidth: number;
	clientHeight: number;
	/** Document bottom in scroller-content px, so vertical reach clears it. */
	contentBottom: number;
	origin: { left: number; top: number };
	pinchScale: number;
	fontZoom: number;
}): Extent {
	const k = g.pinchScale;
	if (!Number.isFinite(k) || k <= 1 || g.fontZoom <= 0) return ZERO_EXTENT;
	const over = 1 - 1 / k;
	const x = (g.clientWidth * (1 + over) - g.origin.left) / g.fontZoom;
	const y = (g.contentBottom + g.clientHeight * over - g.origin.top) / g.fontZoom;
	return { x: Math.max(0, x), y: Math.max(0, y) };
}

/**
 * How much of a viewport's height `writeFrontier` grants past the document
 * bottom, as a fraction of `clientHeight`.
 *
 * Phone-sized numbers (a folding phone's inner display, `clientHeight` ~700
 * css px, per the user report in 1.4.6 §5n): at 0.75 the grant is ~525px, so
 * once scrolled to the frontier the last written line sits roughly a quarter
 * of the way down the viewport, leaving about three quarters of the screen
 * blank below it to write in - enough that a hand no longer runs off the
 * bottom edge. 1.0 would push the last line off the TOP of the viewport
 * (the note looks empty); 0.5 only reaches mid-screen, which is close to
 * what the report already described as "quite low."
 */
export const WRITE_FRONTIER_VIEWPORT_FRACTION = 0.75;

/**
 * The write frontier: while a surface is being WRITTEN on, the vertical
 * extent must reach past the document bottom by most of a viewport, so the
 * line under the nib can always be scrolled up to a comfortable height.
 * Without this, vertical reach is `inkFrontier` alone (plus
 * `EXTENT_HEADROOM`/`EXTENT_CHUNK`): a note with nothing written low on the
 * page has no scroll reach below its text, so the only place left to write
 * is wherever content already reaches - the bottom of the screen on a
 * phone, which is where the hand falls off (1.4.6 §5n, the folding-phone
 * report).
 *
 * `clientHeight` is a SCREENFUL in the scroller's own coordinates, which is
 * not the same element at every zoom: below 1.0 the note viewport counter-
 * sizes the editor and scales it back down, so the screenful is the scroller's
 * client box and the takeover pane is a fraction of it.
 *
 * Same shape and units as `zoomFrontier`'s y: `origin.top` and
 * `contentBottom` are scroller-content px, the result is divided by
 * `fontZoom` (the spacer scales it back up), and it never goes negative.
 * `x` is always 0 - writing does not need extra horizontal reach.
 *
 * THE TRAP: `SurfaceExtents.grow` only ever takes the max of what it is
 * given and never shrinks (`grownAxis`/`grownExtent` above), so an extent
 * granted at one viewport size persists on that note's path for the rest of
 * the session. Rotating a phone or widening a window ratchets the extent up
 * and it stays up after rotating back or narrowing again. That is already
 * true of `zoomFrontier` and is accepted here for the same reason: the cost
 * is blank scroll range, not lost ink - but it must be written down rather
 * than rediscovered.
 *
 * Callers must compute this ONLY when `writeFrontierApplies` says so and pass
 * `ZERO_EXTENT` otherwise - a note nobody has inked, no pen has touched and
 * nobody has zoomed out must keep a byte-identical extent, so a typing-only
 * vault never gains phantom scroll.
 */
/**
 * When the vertical grant above is due.
 *
 * `writtenOn` is the original case: ink present, or the pen has been seen
 * this session. ZOOMING THE NOTE VIEWPORT OUT is the second, and it is a
 * handwriting act too - nobody pinches a text note down to a tenth to type
 * into it, they do it to see the page they are about to write on. Without
 * this, a note that has never been inked stops dead at the bottom of its own
 * text: the whole page nearly fits the screen and there is nothing below it
 * to scroll to, which reads as a scroll that only works sideways.
 *
 * Zoom IN grants nothing (`zoomFrontier` already covers the magnified
 * overhang), and at 1.0 an untouched note is byte-identical to what it gets
 * today.
 *
 * THE RATCHET applies here as well: grants never shrink, so a note zoomed
 * out and then returned to 1.0 keeps the room it was granted at the zoom,
 * in layout px, below its text for the rest of the session. Same trade
 * `writeFrontier` and `zoomFrontier` already take - blank scroll range, not
 * lost ink - and there is no shrink path.
 */
export function writeFrontierApplies(g: {
	writtenOn: boolean;
	pinchScale: number;
}): boolean {
	return g.writtenOn || g.pinchScale < 1;
}

export function writeFrontier(g: {
	clientHeight: number;
	/** Document bottom in scroller-content px, same value zoomFrontier used. */
	contentBottom: number;
	origin: { top: number };
	fontZoom: number;
}): Extent {
	if (!Number.isFinite(g.fontZoom) || g.fontZoom <= 0) return ZERO_EXTENT;
	const y =
		(g.contentBottom + g.clientHeight * WRITE_FRONTIER_VIEWPORT_FRACTION - g.origin.top) /
		g.fontZoom;
	return { x: 0, y: Math.max(0, y) };
}

/** Spacer style position: origin plus granted extent, whole px. */
export function spacerPosition(
	origin: { left: number; top: number },
	extent: Extent
): { left: number; top: number } {
	return {
		left: Math.round(origin.left + extent.x),
		top: Math.round(origin.top + extent.y),
	};
}

/** Does this computed overflow value let the user scroll that axis? */
export function isScrollableOverflow(value: string): boolean {
	const v = value.trim().toLowerCase();
	return v === "auto" || v === "scroll" || v === "overlay";
}

/**
 * Obsidian's `.cm-scroller` ships `overflow-x: hidden`: the extent spacer can
 * grow scrollWidth all it likes and the user still cannot scroll there. This
 * guard toggles a stylesheet class that flips exactly that one property to
 * `auto`. The stylesheet scopes the rule through `.handwriting-page` for
 * enough specificity against themes, and the class is dropped on unmount.
 * Any inline style the scroller carried is never touched, and neither is
 * overflow-y.
 */
export const HSCROLL_AXIS_CLASS = "handwriting-hscroll-axis";

export class ScrollAxisGuard {
	private on = false;

	get patched(): boolean {
		return this.on;
	}

	assert(el: HTMLElement, computedOverflowX: string): void {
		if (this.on) return;
		if (isScrollableOverflow(computedOverflowX)) return;
		el.classList.add(HSCROLL_AXIS_CLASS);
		this.on = true;
	}

	restore(el: HTMLElement): void {
		if (!this.on) return;
		this.on = false;
		el.classList.remove(HSCROLL_AXIS_CLASS);
	}
}

/**
 * Granted extents per note path, session-lifetime like the undo history.
 * Rename moves the grant with the note (keeping the larger when the target
 * already has one); delete drops it.
 */
export class SurfaceExtents {
	private byPath = new Map<string, Extent>();
	/** Notes whose x grant is due to be re-measured from their ink, each with the generation it fell due at. */
	private owedX = new Map<string, number>();
	private owedGeneration = 0;
	/** How many times each note's x grant has shrunk, so every pane showing it can tell. */
	private shrinks = new Map<string, number>();

	get(path: string): Extent {
		return this.byPath.get(path) ?? ZERO_EXTENT;
	}

	grow(path: string, needed: Extent): Extent {
		const current = this.get(path);
		const next = grownExtent(current, needed);
		if (next !== current) this.byPath.set(path, next);
		return next;
	}

	/**
	 * Re-measure this note's x grant at its next extent pass: ink left it. The
	 * shrink is the editor's to make, because only an editor knows what is on
	 * screen (onScreenFloorX); this only remembers that one is due, across
	 * editors and across note switches.
	 */
	oweShrinkX(path: string): void {
		if (this.get(path).x > 0) this.owedX.set(path, ++this.owedGeneration);
	}

	/** Every note holding sideways room is due: Infinite Canvas was turned off. */
	oweShrinkXEverywhere(): void {
		for (const [path, extent] of this.byPath) if (extent.x > 0) this.owedX.set(path, ++this.owedGeneration);
	}

	owesShrinkX(path: string): boolean {
		return this.owedX.has(path);
	}

	/**
	 * The generation this note's shrink fell due at, or undefined when none is
	 * due. A new one each time it falls due again, so an editor can tell a fresh
	 * shrink (take it now) from the remainder of one it has already made.
	 */
	shrinkDue(path: string): number | undefined {
		return this.owedX.get(path);
	}

	settleShrinkX(path: string): void {
		this.owedX.delete(path);
	}

	/** Changes exactly when this note's x grant shrinks. */
	shrinkCount(path: string): number {
		return this.shrinks.get(path) ?? 0;
	}

	/** Lower the x grant to `x` (never raise it); the SAME object when nothing changed. */
	shrinkX(path: string, x: number): Extent {
		const current = this.get(path);
		if (!Number.isFinite(x) || x >= current.x) return current;
		const next = { x: Math.max(0, x), y: current.y };
		this.byPath.set(path, next);
		this.shrinks.set(path, this.shrinkCount(path) + 1);
		return next;
	}

	handleRename(oldPath: string, newPath: string): void {
		const moved = this.byPath.get(oldPath);
		if (!moved) return;
		this.byPath.delete(oldPath);
		const owed = this.owedX.get(oldPath);
		// Merged like the grant: keep the larger count and the newer due generation.
		if (owed !== undefined) { this.owedX.delete(oldPath); this.owedX.set(newPath, Math.max(owed, this.owedX.get(newPath) ?? owed)); }
		const shrinks = this.shrinks.get(oldPath);
		if (shrinks !== undefined) { this.shrinks.delete(oldPath); this.shrinks.set(newPath, Math.max(shrinks, this.shrinkCount(newPath))); }
		const existing = this.byPath.get(newPath);
		this.byPath.set(
			newPath,
			existing
				? { x: Math.max(existing.x, moved.x), y: Math.max(existing.y, moved.y) }
				: moved
		);
	}

	handleDelete(path: string): void {
		this.byPath.delete(path);
		this.owedX.delete(path);
		this.shrinks.delete(path);
	}
}

/** The one shared instance (extents belong to notes, not editors). */
export const surfaceExtents = new SurfaceExtents();
