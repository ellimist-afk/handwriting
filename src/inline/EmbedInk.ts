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
 * Staleness (1.0.5): ink saves touch the sidecar and never the .md, so a
 * rendered embed used to keep its picture until Obsidian happened to
 * re-render it. Now every attached root sits in a registry, and one
 * ink-changed notification per persisted gesture repaints the roots showing
 * that path. The marker attribute carries a per-path revision, so attach
 * stays idempotent when nothing changed and repaints when the revision
 * moved. Disconnected roots are swept on every notification; the registry
 * holds at most a screenful of embeds between gestures.
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

/** Live rendered roots, each mapped to the note path it shows. */
const layers = new Map<HTMLElement, string>();
/** Bumped per path on every persisted change; part of the marker. */
const revisions = new Map<string, number>();
let strokesFor: ((path: string) => readonly InkStroke[]) | null = null;

/** The rendered document's root for a section element, if recognizable. */
export function embedInkRoot(sectionEl: HTMLElement): HTMLElement | null {
	return (
		(sectionEl.closest(".markdown-embed-content") as HTMLElement | null) ??
		(sectionEl.closest(".markdown-preview-sizer") as HTMLElement | null)
	);
}

/** Pure: the canvas extent that covers every stroke, capped. */
export function embedInkExtent(strokes: readonly InkStroke[]): { w: number; h: number } {
	let maxX = 0;
	let maxY = 0;
	for (const s of strokes) {
		maxX = Math.max(maxX, s.bbox.x + s.bbox.width);
		maxY = Math.max(maxY, s.bbox.y + s.bbox.height);
	}
	return {
		w: Math.min(Math.ceil(maxX), MAX_EXTENT_PX),
		h: Math.min(Math.ceil(maxY), MAX_EXTENT_PX),
	};
}

/** Pure: what the marker attribute holds for a (path, revision) pair. */
export function embedInkMarker(path: string, rev: number): string {
	return `${path}@${rev}`;
}

/** Where repaints read fresh strokes from. Wired once at plugin load. */
export function initEmbedInkRefresh(provider: (path: string) => readonly InkStroke[]): void {
	strokesFor = provider;
}

/**
 * A note's ink was persisted: bump its revision and repaint every connected
 * root showing it. Every notification also sweeps roots the DOM dropped.
 */
export function embedInkChanged(path: string): void {
	revisions.set(path, (revisions.get(path) ?? 0) + 1);
	for (const [root, p] of [...layers]) {
		if (!root.isConnected) {
			layers.delete(root);
			continue;
		}
		if (p !== path) continue;
		paint(root, path, strokesFor ? strokesFor(path) : []);
	}
}

/**
 * Attach (or refresh) the ink layer on a rendered document root and put it
 * in the registry. Idempotent per (root, path, revision): a second section
 * with the same path finds the marker and leaves the existing layer alone.
 * Registered even with zero strokes, so an embed rendered before its note
 * was ever drawn on still gains ink at the first gesture.
 */
export function attachEmbedInk(
	root: HTMLElement,
	path: string,
	strokes: readonly InkStroke[]
): void {
	layers.set(root, path);
	paint(root, path, strokes);
}

function paint(root: HTMLElement, path: string, strokes: readonly InkStroke[]): void {
	const marker = embedInkMarker(path, revisions.get(path) ?? 0);
	if (root.getAttribute(MARKER_ATTR) === marker) return;
	root.setAttribute(MARKER_ATTR, marker);
	let canvas = root.querySelector(
		":scope > canvas.handwriting-embed-ink"
	) as HTMLCanvasElement | null;
	const { w, h } = embedInkExtent(strokes);
	if (strokes.length === 0 || w <= 0 || h <= 0) {
		// The last stroke was erased: the picture goes too.
		canvas?.remove();
		return;
	}
	if (getComputedStyle(root).position === "static") {
		root.setCssStyles({ position: "relative" });
	}
	if (!canvas) {
		canvas = root.createEl("canvas", { cls: "handwriting-embed-ink" });
	}
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width = w;
		canvas.height = h;
		canvas.setCssStyles({ width: `${w}px`, height: `${h}px` });
	}
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	ctx.clearRect(0, 0, w, h);
	// Highlighter first and translucent as a layer would be; then pen.
	ctx.globalAlpha = 0.35;
	for (const s of strokes) if (s.tool === "highlighter") drawStroke(ctx, CAM, s, undefined, true);
	ctx.globalAlpha = 1;
	for (const s of strokes) if (s.tool !== "highlighter") drawStroke(ctx, CAM, s, undefined, true);
}
