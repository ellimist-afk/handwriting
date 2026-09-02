/**
 * The ink clipboard (roadmap: copy/paste ink + across notes).
 *
 * Module state, like the tool: one clipboard for the session, so a lasso
 * copied in one note pastes into any other. The STROKES never go on the
 * system clipboard - a paste of note-space coordinates has nothing honest
 * to say to another application (that's what the SVG export is for) - but
 * a one-line MARKER does, because ctrl+v has nothing else to go on. See
 * inkClipboardMarker below.
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
let token: string | null = null;

/**
 * The line ink copy leaves on the system clipboard.
 *
 * Without it ctrl+v had no way to know the last copy was ink: the strokes
 * sat in module state, the system clipboard still held whatever text was
 * there before, and pasting did that instead (reported 1.1.2 - the copy
 * notice appears, the paste does nothing). The marker is an identity
 * card, never the data: it names the ink this session holds, so a marker
 * left over from an earlier run is recognized and refused rather than
 * pasting whatever ink happens to be loaded now.
 *
 * Copying anything else replaces the marker, which is exactly the
 * disambiguation a private clipboard could not do: text copied after ink
 * pastes as text. A clipboard manager keeps the line in its history, so
 * pasting that entry again pastes the ink again.
 */
const MARKER_PREFIX = "handwriting-ink/v1 ";

/** The marker for the ink now held, or null when the clipboard is empty. */
export function inkClipboardMarker(): string | null {
	if (held.length === 0 || token === null) return null;
	const plural = held.length === 1 ? "" : "s";
	return `${MARKER_PREFIX}${token} (${held.length} stroke${plural})`;
}

/** The token inside a pasted payload; null when it is not our marker. */
export function markerToken(text: string): string | null {
	const line = text.trim();
	if (!line.startsWith(MARKER_PREFIX)) return null;
	const tok = line.slice(MARKER_PREFIX.length).trim().split(" ")[0] ?? "";
	return tok === "" ? null : tok;
}

/** True when a pasted marker names the ink this session is holding. */
export function markerIsCurrent(text: string): boolean {
	const tok = markerToken(text);
	return tok !== null && token !== null && tok === token && held.length > 0;
}

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
	token = newStrokeId();
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
			// dx offsets BOTH axes on purpose: one stagger value moves each
			// repeated paste diagonally instead of stacking pastes exactly.
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
	token = null;
}
