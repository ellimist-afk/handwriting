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
