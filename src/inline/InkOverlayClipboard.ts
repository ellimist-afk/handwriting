/**
 * The note surface's ink clipboard and snip commands: snip the selection to a PNG, copy, cut, paste and delete the
 * lasso selection. They are methods of InkOverlayPlugin, installed on its prototype when InkOverlay.ts loads.
 * The lasso, the insert-space drag and the selection chrome stay in InkOverlayLassoSpace.ts.
 */
import { installMethods } from "./InstallMethods";
import { Notice } from "obsidian";
import { CameraState } from "../camera/coordinates";
import { clipboardSize, copyInk, inkClipboardMarker, pasteInk } from "./InkClipboard";
import { withInkDestination } from "../ink/InkTheme";
import { InkStroke } from "../ink/Stroke";
import { drawStroke } from "../ink/StrokeRenderer";
import { snipViewport } from "../pdf/PageMap";
import { type DeleteSelectionOutcome, removeSelectedInlineStrokes } from "./InlineSelectionDelete";
import { visualToNote } from "./ZoomScale";
import { inlineInk, type CutSelectionOutcome, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		snipSelection(): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }>;
		copySelectedInk(): number;
		cutSelectedInk(): CutSelectionOutcome;
		pasteInkHere(): number;
		deleteSelectedInk(): DeleteSelectionOutcome;
	}
}

/** Whether one centerline segment crosses a screen-space viewport rectangle. */
function segmentIntersectsViewport(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	left: number,
	top: number,
	right: number,
	bottom: number,
): boolean {
	if (![ax, ay, bx, by].every(Number.isFinite)) return false;
	let enter = 0;
	let leave = 1;
	const dx = bx - ax;
	const dy = by - ay;
	for (const [p, q] of [
		[-dx, ax - left],
		[dx, right - ax],
		[-dy, ay - top],
		[dy, bottom - ay],
	] as const) {
		if (p === 0) {
			if (q < 0) return false;
			continue;
		}
		const ratio = q / p;
		if (p < 0) {
			if (ratio > leave) return false;
			if (ratio > enter) enter = ratio;
		} else {
			if (ratio < enter) return false;
			if (ratio < leave) leave = ratio;
		}
	}
	return true;
}

/** Actual stroke geometry, not its possibly-empty bounding-box interior. */
function strokeIntersectsViewport(
	stroke: InkStroke,
	cam: Readonly<CameraState>,
	viewW: number,
	viewH: number,
	offsetX: number,
	offsetY: number,
): boolean {
	if (stroke.points.length === 0 || viewW <= 0 || viewH <= 0) return false;
	const pad = Math.max(1, (stroke.width * cam.zoom) / 2);
	const screen = (point: InkStroke["points"][number]): { x: number; y: number } => ({
		x: (point.x - cam.x) * cam.zoom + offsetX,
		y: (point.y - cam.y) * cam.zoom + offsetY,
	});
	if (stroke.points.length === 1) {
		const point = screen(stroke.points[0]!);
		return point.x >= -pad && point.y >= -pad && point.x <= viewW + pad && point.y <= viewH + pad;
	}
	let from = screen(stroke.points[0]!);
	for (let i = 1; i < stroke.points.length; i++) {
		const to = screen(stroke.points[i]!);
		if (segmentIntersectsViewport(from.x, from.y, to.x, to.y, -pad, -pad, viewW + pad, viewH + pad)) {
			return true;
		}
		from = to;
	}
	return false;
}

/**
 * Put the ink marker on the system clipboard so ctrl+v can recognize it.
 * Best-effort by design: a denied clipboard (no user gesture, locked-down
 * platform) costs the keyboard paste and nothing else - the command and
 * the strip's paste button read module state and still work.
 *
 * Through the editor's own window: Chromium refuses a clipboard write from a
 * document that is not focused, and in a popout the main window's is not
 * (audit 60).
 */
function publishInkMarker(win: Window): void {
	const marker = inkClipboardMarker();
	if (marker === null) return;
	try {
		void win.navigator.clipboard?.writeText(marker).catch(() => {
			/* denied: keyboard paste falls back to the command */
		});
	} catch {
		/* no clipboard api at all */
	}
}

/** Same area cap as the pdf snip (MAX_OVERLAY_PX there): one budget for
 * every raster this plugin produces. */
const NOTE_SNIP_CAP_PX = 4_000_000;

/**
 * The page a note snip paints for itself, and therefore the destination its
 * ink has to be readable on. One constant so the fill and the readability
 * rule cannot be changed apart.
 */
const SNIP_PAGE = "#ffffff";

	/**
	 * The lassoed region as a PNG: ink on white, cropped to the selection
	 * plus a little air. The pdf surface composites the page under its
	 * strokes; a note's ground is live editor DOM, which is not honestly
	 * rasterizable, so this is the drawing alone - the same bargain the SVG
	 * export states. Same crop math and area cap as the pdf snip, so the
	 * two commands cannot drift apart in kind.
	 */
	async function snipSelection(this: InkOverlayPlugin): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }> {
		if (this.selection.isEmpty) return { ok: false, reason: "nothing is selected to snip" };
		const bounds = this.selectionBounds();
		if (!bounds) return { ok: false, reason: "nothing is selected to snip" };
		const strokes = this.strokesHere();
		const pxPerWorld = this.winRef.devicePixelRatio || 1;
		// No page to clamp to: a note's canvas is as big as its ink.
		const vp = snipViewport(bounds, 8, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, pxPerWorld, NOTE_SNIP_CAP_PX);
		if (!vp) return { ok: false, reason: "the selection could not be framed" };
		const out = createEl("canvas");
		try {
			out.width = Math.max(1, Math.round((vp.x1 - vp.x0) * vp.scale));
			out.height = Math.max(1, Math.round((vp.y1 - vp.y0) * vp.scale));
			const ctx = out.getContext("2d");
			if (!ctx) return { ok: false, reason: "the image could not be drawn" };
			// ONE constant for the page and the destination, because the two
			// must not drift: the ink is made readable against exactly the
			// rectangle that was just painted under it.
			ctx.fillStyle = SNIP_PAGE;
			ctx.fillRect(0, 0, out.width, out.height);
			ctx.setTransform(1, 0, 0, 1, -vp.x0 * vp.scale, -vp.y0 * vp.scale);
			const cam = { x: 0, y: 0, zoom: vp.scale };
			// A snip PNG is NOT transparent and does not inherit the note's
			// theme - it lands on the white rectangle above whatever theme it
			// was taken under - so its destination is known here and the ink
			// adapts to it, same direction as the PDF and for the same reason.
			//
			// The scope, rather than an argument: these strokes are drawn by
			// the shared committed renderer, whose colour accessor is the hot
			// path and may not grow a per-stroke parameter.
			withInkDestination(SNIP_PAGE, () => {
				// The pdf snip's layering exactly: highlighter as a wash under
				// the pen, both from committed geometry.
				ctx.globalAlpha = 0.35;
				for (const st of strokes) if (st.tool === "highlighter") drawStroke(ctx, cam, st, undefined, true);
				ctx.globalAlpha = 1;
				for (const st of strokes) if (st.tool !== "highlighter") drawStroke(ctx, cam, st, undefined, true);
			});
			const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
			if (!blob) return { ok: false, reason: "the image could not be encoded" };
			return { ok: true, bytes: new Uint8Array(await blob.arrayBuffer()) };
		} finally {
			out.width = 0;
			out.height = 0;
		}
	}

	/**
	 * Copy the lasso selection to the session ink clipboard (roadmap:
	 * copy/paste ink). Returns how many strokes were copied; 0 = no selection.
	 */
	function copySelectedInk(this: InkOverlayPlugin): number {
		const path = this.filePath();
		if (!path || this.selection.isEmpty) return 0;
		const ids = new Set(this.selection.strokeIds);
		const strokes = this.strokesHere().filter((s) => ids.has(s.id));
		const n = copyInk(strokes, path, inlineInk.fontRefPx(path));
		if (n > 0) publishInkMarker(this.winRef);
		return n;
	}

	/** Copy, then delete as one normal history step. */
	function cutSelectedInk(this: InkOverlayPlugin): CutSelectionOutcome {
		const n = this.copySelectedInk();
		if (n === 0) return { kind: "empty" };
		// A cut is a copy AND a delete. When the delete removes nothing the
		// ink is still on the page, so answering "cut" here would report a
		// cut that did not happen - the clipboard holds the strokes and so
		// does the note. `cutSelectionNotice` owns the honest sentence for
		// that case, the same way `lassoDeleteNotice` owns the delete one.
		const outcome = this.deleteSelectedInk();
		return outcome.kind === "deleted" ? { kind: "cut", count: n } : { kind: "unmatched", count: n };
	}

	/**
	 * Paste the clipboard into this note as one history step. Coordinates
	 * are kept (fixed grid); pastes into the source note stagger. Returns
	 * how many strokes landed.
	 */
	function pasteInkHere(this: InkOverlayPlugin): number {
		const path = this.filePath();
		if (clipboardSize() === 0) return 0;
		// A cell editor inherits the note's file identity and this extension, but
		// its effects-only ink history never reaches the note editor. Refuse
		// before pasteInk advances the source stagger or mints stroke IDs.
		if (!path || !this.container || !this.ownsMarkdownEditorRoot()) {
			const inTable = this.view.dom.closest(".table-cell-wrapper, .cm-table-widget") !== null;
			new Notice(inTable
				? "Handwriting: click outside the table to paste ink."
				: "Handwriting: click in the note to paste ink.");
			return 0;
		}
		const strokes = pasteInk(path, inlineInk.fontRefPx(path));
		if (strokes.length === 0) return 0;
		// The copy left its line behind; the pasted ink remembers the line it lands on, as a new stroke does.
		for (const s of strokes) this.lineAnchors.anchorNew(path, s);
		inlineInk.applyAdd(path, strokes);
		inlineInk.save(path);
		this.dispatchInk({ type: "add", path, strokes });
		this.scheduleRepaint();
		this.repaintPath(path);
		// Seamlessness: what was pasted is SELECTED, so it is visible and
		// movable at once - and if the fixed-grid coordinates put it outside
		// the viewport, scroll to it rather than pasting into the void.
		this.selection.selectExactly(strokes.map((st) => st.id));
		this.redrawSelectionUI();
		// A blank note has no extent spacer yet. Grow it synchronously before
		// writing either scroll offset: browsers clamp an early write to the
		// old zero range, and the repaint that later creates the spacer does
		// not retry it. Fixed-grid ink can be offscreen on either axis.
		this.updateExtent(true);
		// Re-read the camera AFTER that layout change. The viewport mapping
		// below also reads fresh element rects, and a cached pre-extent camera
		// combined with post-extent rects would mix two coordinate frames.
		// syncCamera itself respects the active-stroke frame lock.
		this.syncCamera();
		const cam = this.camera.snapshot;
		const scroller = this.view.scrollDOM;
		const viewW = scroller.clientWidth;
		const viewH = scroller.clientHeight;
		// Camera screen coordinates are relative to the moving canvas BAND,
		// while scroll offsets and client sizes describe the scroller viewport.
		// Carry the band's current visual offset into the same layout-px space.
		const overlayRect = this.container?.getBoundingClientRect();
		const viewportRect = overlayRect ? scroller.getBoundingClientRect() : null;
		const offsetX = overlayRect && viewportRect
			? visualToNote(overlayRect.left - viewportRect.left, this.cssScale) - scroller.clientLeft
			: 0;
		const offsetY = overlayRect && viewportRect
			? visualToNote(overlayRect.top - viewportRect.top, this.cssScale) - scroller.clientTop
			: 0;
		const pastedInkIsVisible = strokes.some((stroke) =>
			strokeIntersectsViewport(stroke, cam, viewW, viewH, offsetX, offsetY)
		);
		if (!pastedInkIsVisible) {
			// A sparse selection can span the pane while its union bbox starts
			// in an EMPTY in-view corner (one stroke far right, one far below).
			// One bent stroke's bbox can do the same. Reveal a real centerline
			// point, not either kind of empty bounding-box corner.
			const target = strokes.find((stroke) => stroke.points.length > 0)?.points[0];
			if (target) {
				const leftX = (target.x - cam.x) * cam.zoom + offsetX;
				const topY = (target.y - cam.y) * cam.zoom + offsetY;
				if (leftX < 0 || leftX > viewW - 40) {
					scroller.scrollLeft += leftX - Math.min(120, viewW / 4);
				}
				if (topY < 0 || topY > viewH - 40) {
					scroller.scrollTop += topY - Math.min(120, viewH / 4);
				}
			}
		}
		this.mobileTools?.refresh();
		return strokes.length;
	}

	/**
	 * Delete the current lasso selection as one normal editor-history step.
	 * Returns how many strokes went, so callers can say "nothing selected".
	 */
	function deleteSelectedInk(this: InkOverlayPlugin): DeleteSelectionOutcome {
		// Mid-drag, the move so far is its own step, before the delete's.
		this.commitLiveDrag();
		const path = this.filePath();
		// Copied before the store is asked: the ids are the evidence the
		// unresolved root-cause question needs, and on both failure paths
		// below the selection must survive to be logged AND to stay on
		// screen.
		const ids = [...this.selection.strokeIds];
		const n = ids.length;
		if (!path) {
			// A live selection with no resolvable path is not "nothing
			// selected" either - the user did lasso something, there is just
			// nowhere to look it up. Reuses "unmatched" rather than a third
			// kind: from the caller's side this and a selection the store
			// matched nothing in are the same fact, a real selection that
			// could not be removed, so they earn the same honest sentence and
			// the same kept lasso.
			if (n === 0) return { kind: "empty" };
			console.error("[handwriting] lasso delete with no resolvable path", { path: null, strokeIds: ids });
			return { kind: "unmatched", count: n };
		}
		const op = removeSelectedInlineStrokes(inlineInk, path, ids);
		// THE CHECK COMES BEFORE THE CLEAR. It used to come after, so a delete
		// that removed nothing still destroyed the lasso, and the user was told
		// to "lasso some ink first" with their selection already wiped -
		// re-lassoing the same strokes then failed identically.
		if (!op && n > 0) {
			// The one thing nobody was collecting. Which of the two candidate
			// causes this is - a selection holding ids an external sidecar
			// reload replaced, or `filePath()` resolving somewhere the strokes
			// are not stored - is not decided here, and these two values are
			// what decides it.
			console.error("[handwriting] lasso delete matched no strokes", { path, strokeIds: ids });
			return { kind: "unmatched", count: n };
		}
		this.selection.clear();
		this.redrawSelectionUI();
		if (!op) return { kind: "empty" };
		this.dispatchInk(op);
		this.scheduleRepaint();
		this.repaintPath(path);
		return { kind: "deleted", count: n };
	}

export function installInkOverlayClipboard(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		snipSelection,
		copySelectedInk,
		cutSelectedInk,
		pasteInkHere,
		deleteSelectedInk,
	});
}
