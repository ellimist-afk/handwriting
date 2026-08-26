/**
 * The ink clipboard (roadmap: copy/paste ink + across notes).
 *
 * Module state, like the tool: one clipboard for the session, so a lasso
 * copied in one note pastes into any other. Never the system clipboard -
 * strokes are not text, and a paste of note-space coordinates has nothing
 * honest to say to another application (that's what the SVG export is for).
 *
 * Coordinates ride along unchanged: ink lives on a fixed grid, so a stroke
 * pasted into another note lands at the same place on that note's page.
 * Pasting back into the SOURCE note staggers by 16px per paste, or the copy
 * would sit invisibly on its original.
 *
 * Every paste mints fresh ids. The store skips ids it already holds
 * (applyAdd's duplicate guard), and undo tracks strokes by id, so a pasted
 * stroke must be a new individual, not a reference.
 */

import { InkStroke, newStrokeId } from "../ink/Stroke";

const PASTE_STAGGER_PX = 16;

let held: InkStroke[] = [];
let sourcePath: string | null = null;
let pastesIntoSource = 0;

const clone = (s: InkStroke): InkStroke => ({
	...s,
	points: s.points.map((p) => ({ ...p })),
	bbox: { ...s.bbox },
});

export function copyInk(strokes: readonly InkStroke[], fromPath: string): number {
	if (strokes.length === 0) return 0;
	held = strokes.map(clone);
	sourcePath = fromPath;
	pastesIntoSource = 0;
	return held.length;
}

export function clipboardSize(): number {
	return held.length;
}

/** Fresh strokes for one paste; empty when the clipboard is. */
export function pasteInk(intoPath: string): InkStroke[] {
	if (held.length === 0) return [];
	let dx = 0;
	if (intoPath === sourcePath) {
		pastesIntoSource++;
		dx = PASTE_STAGGER_PX * pastesIntoSource;
	}
	return held.map((s) => {
		const c = clone(s);
		c.id = newStrokeId();
		if (dx !== 0) {
			for (const p of c.points) {
				p.x += dx;
				p.y += dx;
			}
			c.bbox.x += dx;
			c.bbox.y += dx;
		}
		return c;
	});
}

/** Test seam. */
export function clearInkClipboard(): void {
	held = [];
	sourcePath = null;
	pastesIntoSource = 0;
}
