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
 * The granted extent GROWS in coarse chunks and never shrinks during a
 * session, so the scroll range is stable while writing (a scrollbar that
 * pumps per stroke is nauseating). Growth is driven by the ink frontier,
 * the maximum x/y any stroke's bbox reaches on that note.
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
 * Callers must compute this ONLY when the surface is being written on (ink
 * present, or the pen has been seen this session) and pass `ZERO_EXTENT`
 * otherwise - a note nobody has inked and no pen has touched must keep a
 * byte-identical extent, so a typing-only vault never gains phantom scroll.
 */
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

	get(path: string): Extent {
		return this.byPath.get(path) ?? ZERO_EXTENT;
	}

	grow(path: string, needed: Extent): Extent {
		const current = this.get(path);
		const next = grownExtent(current, needed);
		if (next !== current) this.byPath.set(path, next);
		return next;
	}

	handleRename(oldPath: string, newPath: string): void {
		const moved = this.byPath.get(oldPath);
		if (!moved) return;
		this.byPath.delete(oldPath);
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
	}
}

/** The one shared instance (extents belong to notes, not editors). */
export const surfaceExtents = new SurfaceExtents();
