/**
 * The note surface's eraser: which strokes an eraser circle could touch, and the erase step for one pen sample (whole-stroke
 * and partial erase, with the index kept exact). They are methods of InkOverlayPlugin, installed on its prototype when
 * InkOverlay.ts loads.
 */
import { eraserRect, splitStrokeByCircle, strokesHitByCircle } from "../ink/Eraser";
import { BBox, InkStroke, newStrokeId } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { visualToNote } from "./ZoomScale";
import { installMethods } from "./InstallMethods";
import { inlineEraserRadiusPx, inlineInk, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		eraseCandidates(w: { x: number; y: number }, r: number): readonly InkStroke[];
		eraseAt(sample: PenSample): void;
	}
}

	/**
	 * The strokes an eraser circle at world `w`, radius `r`, could touch
	 * (design doc §5 C1, 2026-09-02).
	 *
	 * eraseAt used to hit-test `inlineInk.strokes(path)` - the whole note,
	 * every stroke, on every pointer sample - and the erase paths marked the
	 * index dirty after each sample, so a drag ALSO rebuilt the whole index
	 * once per frame. Querying the index instead was not possible while it
	 * was stale between samples: a piece made earlier in the same gesture
	 * was missing from it, and a stroke taken earlier was still in it. It is
	 * now kept exact by strokeIndex.remove/insertLike at the takeLive and
	 * applyAddLive sites in eraseAt, so the only rebuild left is the one
	 * that settles a load or a paste which dirtied the index since the last
	 * repaint - at most once per gesture, at pen-down.
	 */
	function eraseCandidates(this: InkOverlayPlugin, w: { x: number; y: number }, r: number): readonly InkStroke[] {
		if (this.indexDirty) {
			const path = this.filePath();
			const list = path ? this.noteStrokes(path) : [], order = this.lineAnchors.storeOrder(list);
			this.strokeIndex.rebuild(list, order?.depths, order?.pending);
			this.indexDirty = false;
		}
		return this.strokeIndex.query(eraserRect(w.x, w.y, r));
	}

	function eraseAt(this: InkOverlayPlugin, sample: PenSample): void {
		const path = this.filePath();
		if (!path) return;
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const r = visualToNote(inlineEraserRadiusPx, this.scale);
		const candidates = this.eraseCandidates(w, r);
		const hits = strokesHitByCircle(candidates, w.x, w.y, r);
		if (hits.length === 0) return;
		// What this pane's index and canvas hold for each hit: the store's stroke, or its copy shown on its line. The store and
		// the history take the store's own; the index, the damage and the cut take what is shown.
		const shown = new Map(candidates.map((s) => [s.id, s] as const));
		// Every current index showing this note, this pane's included (the
		// candidates call above has just made it current), and the rects the
		// other panes redraw.
		const indexes = this.currentIndexes(path);
		const changed: BBox[] = [];
		if (this.eraseWhole) {
			// Contact deletes the stroke, no split - v0.13.12's behavior,
			// back by request as a setting.
			for (const { stroke, index } of inlineInk.takeLive(path, hits)) {
				const seen = shown.get(stroke.id) ?? stroke;
				if (!this.erasePieces.delete(stroke.id)) {
					this.erased.push({ stroke, index });
				}
				this.damage.addRect(seen.bbox);
				changed.push(seen.bbox);
				for (const idx of indexes) idx.remove(seen);
			}
			this.scheduleRepaint("partial");
			this.repaintPath(path, changed);
			return;
		}
		// Partial erase: the ring takes what it covers and the rest of the
		// stroke stays. Each stroke comes out and its survivors go back in at
		// the same position, so z-order holds; all of this pass's survivors go
		// back in one call, which places them in the original order.
		const back: Array<{ index: number; pieces: InkStroke[]; parent: string; fresh?: boolean }> = [];
		// Pieces go in the index once their group membership is set: a member's piece is shown with its group.
		const placed: Array<{ piece: InkStroke; seen: InkStroke }> = [];
		for (const { stroke, index } of inlineInk.takeLive(path, hits)) {
			const seen = shown.get(stroke.id) ?? stroke;
			this.damage.addRect(seen.bbox);
			changed.push(seen.bbox);
			for (const idx of indexes) idx.remove(seen);
			// Cut in page coordinates: the ring moved by the correction this pane shows the stroke at (x for attached groups).
			const pieces = splitStrokeByCircle(stroke, w.x - (seen.bbox.x - stroke.bbox.x), w.y - (seen.bbox.y - stroke.bbox.y), r, newStrokeId);
			if (pieces.length === 1 && pieces[0] === stroke) {
				// Hit by the bbox-then-segment test but the ring never crossed
				// the line itself. Put it back exactly as it was.
				back.push({ index, pieces: [stroke], parent: stroke.id });
				for (const idx of indexes) idx.insertLike(seen, seen);
				continue;
			}
			// A piece this gesture made is cut again: not in any history step, so it leaves its group for its own pieces.
			const fresh = this.erasePieces.delete(stroke.id);
			if (!fresh) {
				this.erased.push({ stroke, index });
			}
			// A group even when the ring swallowed the whole stroke (no pieces):
			// reinsertLive counts groups as the strokes taken before each one.
			back.push({ index, pieces, parent: stroke.id, fresh });
			for (const piece of pieces) this.erasePieces.add(piece.id);
			for (const piece of pieces) this.lineAnchors.inherit(piece, stroke);
			for (const piece of pieces) placed.push({ piece, seen });
		}
		inlineInk.reinsertLive(path, back);
		if (placed.length > 0) this.lineAnchors.follow.setList(inlineInk.attachments(path));
		for (const idx of indexes) for (const { piece, seen } of placed) idx.insertLike(this.lineAnchors.shownOf(piece), seen);
		// Batched to the next frame, exactly like the canvas eraser.
		this.scheduleRepaint("partial");
		this.repaintPath(path, changed);
	}

export function installErase(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		eraseCandidates,
		eraseAt,
	});
}
