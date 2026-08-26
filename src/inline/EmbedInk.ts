/**
 * Ink in rendered markdown (roadmap: ink showing in embeds).
 *
 * The overlay only ever painted the live editor. Everywhere else a note's
 * markdown is RENDERED - an ![[embed]] of it, or its own reading view - the
 * page showed text and no ink. This paints the committed strokes there,
 * read-only, using the committed renderer.
 *
 * Anchoring is the fixed-grid doctrine applied honestly: strokes live at
 * note-space coordinates, so they draw at those coordinates from the
 * rendered content's top-left. A rendered page wraps its text differently
 * than the editor did (narrower embed, different padding), and the ink does
 * not chase the text - it never does.
 *
 * Mechanics: markdown post-processors run once per SECTION, and the section
 * element is not attached to the document yet when the processor runs. So
 * each section registers a MarkdownRenderChild; on load (now attached) it
 * walks up to the rendered document's root and attaches ONE ink layer
 * there, keyed by a data attribute so the other sections' children see it
 * and stand down.
 *
 * Known limit, on purpose: ink saves touch the sidecar and never the .md,
 * so an already-rendered embed keeps its picture until it re-renders.
 */

import { CameraState } from "../camera/coordinates";
import { drawStroke } from "../ink/StrokeRenderer";
import { InkStroke } from "../ink/Stroke";

/**
 * Rendered ink never exceeds this extent, whatever the page holds. 2048 on
 * a side caps one layer at 16MB of RGBA; hover previews and multi-embed
 * notes each pay for their own canvas, so this is a battery bound as much
 * as a memory one.
 */
const MAX_EXTENT_PX = 2048;
const MARKER_ATTR = "data-handwriting-embed-ink";

const CAM: CameraState = { x: 0, y: 0, zoom: 1 };

/** The rendered document's root for a section element, if recognizable. */
export function embedInkRoot(sectionEl: HTMLElement): HTMLElement | null {
	return (
		(sectionEl.closest(".markdown-embed-content") as HTMLElement | null) ??
		(sectionEl.closest(".markdown-preview-sizer") as HTMLElement | null)
	);
}

/**
 * Attach (or refresh) the ink layer on a rendered document root. Idempotent
 * per (root, path): a second section with the same path finds the marker and
 * leaves the existing layer alone.
 */
export function attachEmbedInk(
	root: HTMLElement,
	path: string,
	strokes: readonly InkStroke[]
): void {
	if (strokes.length === 0) return;
	if (root.getAttribute(MARKER_ATTR) === path) return;
	root.setAttribute(MARKER_ATTR, path);
	let maxX = 0;
	let maxY = 0;
	for (const s of strokes) {
		maxX = Math.max(maxX, s.bbox.x + s.bbox.width);
		maxY = Math.max(maxY, s.bbox.y + s.bbox.height);
	}
	const w = Math.min(Math.ceil(maxX), MAX_EXTENT_PX);
	const h = Math.min(Math.ceil(maxY), MAX_EXTENT_PX);
	if (w <= 0 || h <= 0) return;
	if (getComputedStyle(root).position === "static") {
		root.setCssStyles({ position: "relative" });
	}
	const canvas = root.createEl("canvas", { cls: "handwriting-embed-ink" });
	canvas.width = w;
	canvas.height = h;
	canvas.setCssStyles({ width: `${w}px`, height: `${h}px` });
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	// Highlighter first and translucent as a layer would be; then pen.
	ctx.globalAlpha = 0.35;
	for (const s of strokes) if (s.tool === "highlighter") drawStroke(ctx, CAM, s, undefined, true);
	ctx.globalAlpha = 1;
	for (const s of strokes) if (s.tool !== "highlighter") drawStroke(ctx, CAM, s, undefined, true);
}
