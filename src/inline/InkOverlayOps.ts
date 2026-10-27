/**
 * The note surface's ink operations: stamping and dispatching a finished gesture into the editor's history, applying an op
 * from undo or redo, and repainting the other panes that show the same note. They are methods of InkOverlayPlugin,
 * installed on its prototype when InkOverlay.ts loads.
 */
import { isolateHistory } from "@codemirror/commands";
import { BBox, InkStroke } from "../ink/Stroke";
import { inkApplied, inkEffect, InkOp } from "./InkHistory";
import { notifyInkChanged } from "./InkEvents";
import { StrokeIndex } from "../ink/StrokeIndex";
import { scrollProbeSchedule } from "./ScrollProbe";
import { installMethods } from "./InstallMethods";
import { inlineInk, instances, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		stampInkIdentity(op: InkOp): InkOp;
		dispatchInk(op: InkOp): void;
		opPath(op: InkOp): string | null;
		applyInkOp(op: InkOp, docChanged?: boolean): void;
		repaintPath(path: string, damage?: readonly BBox[]): void;
		currentIndexes(path: string): StrokeIndex[];
		moveLive(path: string, ids: readonly string[], dx: number, dy: number): void;
		scheduleRepaint(via?: string): void;
	}
}

/**
 * What each replayed `remove` actually took, by the op's stroke array. invertInkOp hands
 * the same array to the inverse and back, so the redo of that undo finds it here and puts
 * back only those strokes: a stroke the undo did not take (another pane, or another device
 * through a sync adoption, removed or erased it first) does not come back over what is there.
 */
const removedByHistory = new WeakMap<readonly InkStroke[], ReadonlySet<string>>();

	/** Bind every live publication to its record before asynchronous claims settle. */
	function stampInkIdentity(this: InkOverlayPlugin, op: InkOp): InkOp {
		if (op.historyIdentity === undefined) {
			op = { ...op, historyIdentity: inlineInk.captureHistoryIdentity(op.path) };
		}
		if (op.pageId === undefined) {
			const id = inlineInk.pageIdOf(op.path);
			if (id) op = { ...op, pageId: id };
		}
		// Where the strokes stood, read now: both recorders publish after the
		// store already holds the gesture's result.
		if (op.type === "move" && op.from === undefined) {
			const byId = new Map(inlineInk.strokes(op.path).map((s) => [s.id, s] as const));
			const at = op.strokeIds.map((id) => byId.get(id)?.points[0]);
			if (at.every((p) => p !== undefined)) {
				const { dx, dy } = op;
				op = { ...op, from: at.map((p) => ({ x: p.x - dx, y: p.y - dy })) };
			}
		} else if (op.type === "remove" && op.next === undefined && Array.isArray(op.indices) && op.indices.length === op.strokes.length) {
			// A remove with no index list (an earlier shape) is left unstamped.
			// The list before the removal, rebuilt from what stayed and where
			// each removed stroke was; each stroke's neighbours are read from it.
			const before: string[] = inlineInk.recordIds(op.path);
			const indices = op.indices;
			const order = op.strokes.map((s, i) => ({ id: s.id, at: indices[i]! })).sort((a, b) => a.at - b.at);
			for (const { id, at } of order) before.splice(Math.min(Math.max(at, 0), before.length), 0, id);
			// One pass for the positions: Delete all removes every stroke here.
			const pos = new Map(before.map((id, i) => [id, i] as const));
			const next = op.strokes.map((s) => before[pos.get(s.id)! + 1] ?? null);
			const prev = op.strokes.map((s) => before[pos.get(s.id)! - 1] ?? null);
			op = { ...op, next, prev };
		}
		return op;
	}

	/**
	 * Record a finished gesture in the EDITOR's history, so unmodified Ctrl+Z /
	 * Redo covers ink in chronological order with text edits. The store
	 * already reflects the gesture (inkApplied), and isolateHistory keeps
	 * each gesture its own undo step; strokes never merge into one entry.
	 */
	function dispatchInk(this: InkOverlayPlugin, op: InkOp): void {
		op = this.stampInkIdentity(op);
		try {
			this.view.dispatch({
				effects: inkEffect.of(op),
				annotations: [inkApplied.of(true), isolateHistory.of("full")],
			});
		} catch (err) {
			console.error("[handwriting] ink history dispatch failed", err);
		}
	}

	/**
	 * Where an op from the editor's history should land now.
	 *
	 * The session token follows the record through renames and page-id
	 * reassignment, including before the first claim. A missing token target
	 * means the record was removed: skip without guessing by page id or path.
	 * Older ops without a token retain their page-id/path resolution.
	 */
	function opPath(this: InkOverlayPlugin, op: InkOp): string | null {
		if (op.historyIdentity !== undefined) {
			return inlineInk.pathForHistoryIdentity(op.historyIdentity);
		}
		if (op.pageId === undefined) return op.path;
		return inlineInk.pathForPageId(op.pageId);
	}

	/**
	 * Undo/redo handed us an op: apply it to the store and persist. `docChanged` when the same step changes the text (an insert
	 * space's undo or redo), whose document change then moves the line anchors.
	 */
	function applyInkOp(this: InkOverlayPlugin, op: InkOp, docChanged = false): void {
		this.endLiveGestureForHistory();
		const path = this.opPath(op);
		if (path === null) return;
		if (path !== op.path) op = { ...op, path };
		switch (op.type) {
			case "add": {
				const strokes = op.strokes, took = removedByHistory.get(strokes);
				const pick = (_: unknown, i: number): boolean => !took || took.has(strokes[i]!.id);
				inlineInk.applyAdd(op.path, strokes.filter(pick), op.indices?.filter(pick), {
					next: op.next?.filter(pick),
					prev: op.prev?.filter(pick),
				});
				// applyAdd is silent by design (erase hot path); an undone
				// remove is a gesture boundary, so the embeds hear it here.
				notifyInkChanged(op.path);
				break;
			}
			case "remove": {
				const gone = inlineInk.applyRemove(op.path, op.strokes.map((s) => s.id));
				removedByHistory.set(op.strokes, new Set(gone.map((g) => g.stroke.id)));
				break;
			}
			case "move":
				// Whole or not at all, and only where the step left them. Another
				// pane may have taken a stroke out (its undo of the stroke) or
				// already moved these strokes (its redo of a split puts back the
				// same, already moved, pieces): applying anyway moves a part, or
				// moves the same ink twice. The step is spent either way.
				if (!inlineInk.holdsAll(op.path, op.strokeIds)) return;
				if (op.from && !inlineInk.standsAt(op.path, op.strokeIds, op.from)) return;
				inlineInk.moveStrokes(op.path, op.strokeIds, op.dx, op.dy);
				// A lasso move's strokes ride the lines they land on. An insert space's ride their own lines, which the step's
				// document change moves, as at the gesture: a re-take here would put them on the moved lines, and the change
				// would then move them a second time.
				if (!docChanged) this.retakeLineAnchors(op.path, op.strokeIds);
				inlineInk.save(op.path);
				break;
			case "replace": {
				// Whole or not at all. A stroke this replace would take out is
				// gone (another device erased or split it, and the sync poll
				// adopted that): taking only the rest loses them, and putting
				// the inserted strokes back lays them over what is there now.
				if (!inlineInk.holdsAll(op.path, op.removed.map((st) => st.id))) return;
				// Order matters: take the old ones out before putting the new
				// ones back at their recorded positions, or the indices the op
				// carries describe a list that no longer exists.
				inlineInk.takeLive(op.path, op.removed.map((st) => st.id));
				inlineInk.applyAddLive(op.path, op.inserted, op.insertedAt);
				// Persist and notify only the complete replacement, never its removal half.
				inlineInk.save(op.path);
				break;
			}
		}
		const current = this.filePath();
		if (current === op.path) {
			const before = this.selection.size;
			this.selection.prune(
				new Set(inlineInk.strokes(current).map((s) => s.id)),
				new Set(),
				new Set()
			);
			// The repaint draws selection chrome only over a selection that is
			// still there; a box whose ink an undo just took stays drawn unless
			// the chrome is redrawn here.
			if (this.selection.size !== before) this.redrawSelectionUI();
		}
		this.scheduleRepaint();
		this.repaintPath(op.path);
	}



	/**
	 * Repaint every OTHER pane showing this note (ink belongs to the note).
	 *
	 * `damage` is for the per-sample gestures (live erase, lasso and space
	 * drags): those panes redraw only the rects that changed, where they
	 * used to re-rasterize the whole note every frame. Their stroke indexes
	 * are kept exact by the gesture through `currentIndexes`, so a partial
	 * repaint there finds the strokes where they now are. Without it, the
	 * whole note repaints, as for every boundary change.
	 */
	function repaintPath(this: InkOverlayPlugin, path: string, damage?: readonly BBox[]): void {
		for (const p of instances) {
			if (p === this || p.filePath() !== path) continue;
			// Rects in this pane's places mean nothing to a pane that shows the ink elsewhere: it repaints whole.
			if (damage && !this.lineAnchors.moved && !p.lineAnchors.moved) {
				for (const rect of damage) p.damage.addRect(rect);
				p.scheduleRepaint("partial");
			} else {
				p.scheduleRepaint();
			}
		}
	}

	/**
	 * The stroke index of every pane showing this note, this one included,
	 * that is current. A dirty one is left out: it rebuilds from the store at
	 * its next repaint, which reads the strokes as they are by then.
	 */
	function currentIndexes(this: InkOverlayPlugin, path: string): StrokeIndex[] {
		const out: StrokeIndex[] = [];
		for (const p of instances) {
			if (p.indexDirty || (p !== this && p.filePath() !== path)) continue;
			// Another pane showing ink moved to its lines holds its own copies, at its own corrections: it rebuilds from the store
			// at its next repaint instead.
			if (p !== this && (this.lineAnchors.moved || p.lineAnchors.moved)) {
				p.indexDirty = true;
				continue;
			}
			out.push(p.strokeIndex);
		}
		return out;
	}

	/**
	 * A live drag's translation, with every current index kept exact: each
	 * moved stroke leaves its old cells and enters its new ones. The drags
	 * used to mark the index dirty on every sample, and the repaint that
	 * followed rebuilt the whole note's index once per frame.
	 *
	 * Moving a stroke through the index costs about seven times what
	 * rebuilding it does (measured on 6000 strokes), so a drag that moves
	 * more than an eighth of the note (an insert-space drag near the top)
	 * marks the indexes dirty instead, and each pane rebuilds once at its
	 * next repaint.
	 */
	function moveLive(this: InkOverlayPlugin, path: string, ids: readonly string[], dx: number, dy: number): void {
		const indexes = this.currentIndexes(path);
		const all = inlineInk.strokes(path);
		if (indexes.length === 0 || ids.length * 8 > all.length) {
			inlineInk.moveStrokes(path, ids, dx, dy);
			for (const p of instances) {
				if (p === this || p.filePath() === path) p.indexDirty = true;
			}
			return;
		}
		const wanted = new Set(ids);
		const moving = all.filter((s) => wanted.has(s.id));
		// The index holds each stroke as shown; a moved stroke keeps its correction, and its copy is made again at the new
		// place, at the old copy's depth.
		const seen = moving.map((s) => this.lineAnchors.shownOf(s));
		for (const idx of indexes) for (const s of seen) idx.remove(s);
		inlineInk.moveStrokes(path, ids, dx, dy);
		for (const idx of indexes) moving.forEach((s, i) => idx.insertLike(this.lineAnchors.shownOf(s), seen[i]!));
	}

	function scheduleRepaint(this: InkOverlayPlugin, via = "other"): void {
		// Meaning is unchanged for every caller except the two hot paths:
		// "scroll" means only the camera moved (repaint blits and renders
		// the exposed bands), "partial" means the caller already added its
		// own damage rects. Everything else still repaints the world.
		if (via !== "scroll" && via !== "partial") {
			this.damage.addAll();
			this.indexDirty = true;
		}
		if (via === "scroll") this.lastScrollAskAt = performance.now();
		if (this.repaintQueued) {
			// A second request folded into the frame already queued. The
			// purged-canvas probe only fires on a frame that NOTHING but
			// scrolling asked for, so any other caller joining takes that
			// away - the frame is now doing work on somebody's behalf.
			if (via !== "scroll") this.repaintScrollOnly = false;
			return;
		}
		if (!this.container) return;
		this.repaintScrollOnly = via === "scroll";
		this.repaintQueued = true;
		scrollProbeSchedule(via);
		this.winRef.requestAnimationFrame(() => {
			this.repaintQueued = false;
			this.inQueuedFrame = true;
			try {
				this.repaint();
			} finally {
				this.inQueuedFrame = false;
			}
		});
	}

export function installInkOps(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		stampInkIdentity,
		dispatchInk,
		opPath,
		applyInkOp,
		repaintPath,
		currentIndexes,
		moveLive,
		scheduleRepaint,
	});
}
