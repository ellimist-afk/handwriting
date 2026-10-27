/**
 * The inline ink store's commit path: the commit of a gesture, the add and remove of strokes, the live insert and take, and the move of strokes.
 * They are methods of InlineInkStore, installed on its prototype when InlineInkStore.ts loads.
 */
import { InkStroke } from "../ink/Stroke";
import { translateStroke } from "../objects/Selection";
import { bumpInkRevision } from "../ink/StrokeRev";
import { notifyInkChanged } from "./InkEvents";
import { installMethods } from "./InstallMethods";
import type { NoteRecord, InlineInkStore } from "./InlineInkStore";

declare module "./InlineInkStore" {
	interface InlineInkStore {
		commit(path: string, stroke: InkStroke): void;
		commitGesture(path: string, strokes: readonly InkStroke[]): void;
		applyAdd(path: string, strokes: readonly InkStroke[], indices?: readonly number[], neighbours?: { next?: readonly (string | null)[]; prev?: readonly (string | null)[] }): void;
		applyAddLive(path: string, strokes: readonly InkStroke[], indices?: readonly number[]): void;
		reinsertLive(path: string, groups: ReadonlyArray<{ readonly index: number; readonly pieces: readonly InkStroke[] }>): void;
		insert(rec: NoteRecord, strokes: readonly InkStroke[], indices?: readonly number[], neighbours?: { next?: readonly (string | null)[]; prev?: readonly (string | null)[] }): void;
		applyRemove(path: string, ids: readonly string[]): Array<{ stroke: InkStroke; index: number }>;
		takeLive(path: string, ids: readonly string[]): Array<{ stroke: InkStroke; index: number }>;
		standsAt(path: string, ids: readonly string[], from: ReadonlyArray<{ x: number; y: number }>): boolean;
		holdsAll(path: string, ids: readonly string[]): boolean;
		recordIds(path: string): string[];
		take(path: string, ids: readonly string[]): Array<{ stroke: InkStroke; index: number }>;
		moveStrokes(path: string, ids: readonly string[], dx: number, dy: number): void;
	}
}


	// ---- committing -----------------------------------------------------------

	/** A finished stroke: visible immediately, persisted behind the id rules. */
	function commit(this: InlineInkStore, path: string, stroke: InkStroke): void {
		this.commitGesture(path, [stroke]);
	}

	/** One pen contact, possibly split around release travel: persist once. */
	function commitGesture(this: InlineInkStore, path: string, strokes: readonly InkStroke[]): void {
		if (strokes.length === 0) return;
		const rec = this.record(path);
		for (const stroke of strokes) {
			const at = rec.strokes.findIndex((saved) => saved.id === stroke.id);
			if (at < 0) rec.strokes.push(stroke);
			else rec.strokes[at] = stroke;
			rec.localStrokeIds.add(stroke.id);
		}
		bumpInkRevision();
		rec.mutationGeneration++;
		this.persist(path, rec);
		// Once per pen gesture: the most common mutation of all was the one
		// path that never told the embed layers (ultrareview 2026-08-26).
		notifyInkChanged(path);
	}

	// ---- ink operations (eraser / lasso / history) ------------------------------
	//
	// These are the do/undo/redo primitives. They take captured operands (full
	// strokes or frozen id lists), never live UI state, and every one persists.
	// An undone erase that only changed the screen would resurrect on reload.

	/**
	 * Insert strokes (idempotent by id; indices restore z-order on un-erase).
	 * `neighbours`, when given, puts each stroke back just before the stroke
	 * that followed it, else just after the one that preceded it, and by its
	 * index only when neither is in the note any more: another pane may have
	 * taken or added strokes since, and the index counts the list as it was.
	 */
	function applyAdd(this: InlineInkStore,
		path: string,
		strokes: readonly InkStroke[],
		indices?: readonly number[],
		neighbours?: { next?: readonly (string | null)[]; prev?: readonly (string | null)[] }
	): void {
		const rec = this.record(path);
		this.insert(rec, strokes, indices, neighbours);
		this.persist(path, rec);
	}

	/**
	 * Live-erase reinsertion: the same splice, NO persistence. The partner to
	 * takeLive, and the reason it exists.
	 *
	 * A partial erase takes each covered stroke out and puts its survivors
	 * back at the same index, once per pointer sample. Going through applyAdd
	 * meant every sample scheduled a write - a serialize of the whole page
	 * behind a debounce, at input rate, during the one gesture that is
	 * already doing splitting and repainting. The eraser's pen-up already
	 * calls save() and says so in a comment; this is what makes that true.
	 */
	function applyAddLive(this: InlineInkStore, path: string, strokes: readonly InkStroke[], indices?: readonly number[]): void {
		this.insert(this.record(path), strokes, indices);
	}

	/**
	 * Put back what one live partial erase left of the strokes `takeLive` just
	 * took, each stroke's pieces where that stroke was.
	 *
	 * The indices `takeLive` returns are positions in the list BEFORE any of
	 * the strokes came out. Putting each stroke's pieces back at its own index,
	 * one stroke at a time, placed the second stroke's pieces among the first
	 * stroke's: two strokes erased in one pass came back reordered, so a later
	 * stroke's surviving ink could paint under an earlier one's. Here every
	 * group is placed in one pass, shifted by the strokes taken before it and
	 * the pieces already put back before it.
	 *
	 * `groups` holds one entry for every stroke `takeLive` returned, with
	 * empty `pieces` for a stroke the eraser took whole: the shift counts
	 * entries as strokes taken, so a missing entry moves the rest too far.
	 */
	function reinsertLive(this: InlineInkStore,
		path: string,
		groups: ReadonlyArray<{ readonly index: number; readonly pieces: readonly InkStroke[] }>
	): void {
		const sorted = [...groups].sort((a, b) => a.index - b.index);
		const strokes: InkStroke[] = [];
		const at: number[] = [];
		let placed = 0;
		sorted.forEach((group, taken) => {
			group.pieces.forEach((piece, i) => {
				strokes.push(piece);
				at.push(group.index - taken + placed + i);
			});
			placed += group.pieces.length;
		});
		if (strokes.length > 0) this.insert(this.record(path), strokes, at);
	}

	function insert(this: InlineInkStore,
		rec: NoteRecord,
		strokes: readonly InkStroke[],
		indices?: readonly number[],
		neighbours?: { next?: readonly (string | null)[]; prev?: readonly (string | null)[] }
	): void {
		// Only the incoming ids can clash, so only they are looked up. A Set of
		// every id in the note was built here on each call, and the partial
		// eraser calls this once per hit: on a long note that was an array and
		// a Set of thousands of entries per pointer sample.
		const incoming = new Set<string>();
		for (const s of strokes) incoming.add(s.id);
		const present = new Set<string>();
		for (const s of rec.strokes) if (incoming.has(s.id)) present.add(s.id);
		const insertions: Array<{
			stroke: InkStroke;
			at: number | undefined;
			next: string | null | undefined;
			prev: string | null | undefined;
		}> = [];
		strokes.forEach((stroke, i) => {
			if (present.has(stroke.id)) return;
			present.add(stroke.id);
			insertions.push({ stroke, at: indices?.[i], next: neighbours?.next?.[i], prev: neighbours?.prev?.[i] });
		});
		// Captured indices share the pre-erase list, regardless of scrub order.
		// Deduplicate first so sorting cannot replace the first original operand.
		// Partial or malformed metadata keeps the existing traversal/fallback.
		// A lone insertion cannot be out of order, and the live eraser hands
		// over one stroke per sample: the hot path skips the scan and the sort.
		if (insertions.length > 1 && indices?.length === strokes.length &&
			strokes.every((_, i) => Number.isInteger(indices[i]) && indices[i]! >= 0)) {
			insertions.sort((a, b) => a.at! - b.at!);
		}
		insertions.forEach(({ stroke, at, next, prev }) => {
			rec.localStrokeIds.add(stroke.id);
			// Ascending order above puts a stroke taken out with its neighbour
			// back after that neighbour, so a neighbour from the same step is
			// found here once it is in again.
			const before = next ? rec.strokes.findIndex((s) => s.id === next) : -1;
			const after = before < 0 && prev ? rec.strokes.findIndex((s) => s.id === prev) : -1;
			if (before >= 0) {
				rec.strokes.splice(before, 0, stroke);
			} else if (after >= 0) {
				rec.strokes.splice(after + 1, 0, stroke);
			} else if (at !== undefined && at >= 0 && at <= rec.strokes.length) {
				rec.strokes.splice(at, 0, stroke);
			} else {
				rec.strokes.push(stroke);
			}
		});
		// Only a real insertion counts. The live eraser hands over strokes that
		// are already present at input rate, and a generation that moved
		// without the page changing would refuse adoptions for no reason.
		if (insertions.length > 0) {
			bumpInkRevision();
			rec.mutationGeneration++;
		}
	}

	/** Remove strokes by id. Returns what was removed, with original indices. */
	function applyRemove(this: InlineInkStore,
		path: string,
		ids: readonly string[]
	): Array<{ stroke: InkStroke; index: number }> {
		const removed = this.take(path, ids);
		if (removed.length > 0) {
			this.persist(path, this.record(path));
			// Deletes are never on the erase hot path (that is applyAdd
			// putting pieces back), so notifying here covers selection
			// delete, delete all, and the remove leg of undo/redo ops.
			notifyInkChanged(path);
		}
		return removed;
	}

	/**
	 * Live-erase removal: same capture, NO persistence. The eraser passes over
	 * strokes at input rate, and disk scheduling belongs at pen-up, not on the
	 * hot path. The caller persists once via save().
	 */
	function takeLive(this: InlineInkStore,
		path: string,
		ids: readonly string[]
	): Array<{ stroke: InkStroke; index: number }> {
		return this.take(path, ids);
	}

	/**
	 * Does each listed stroke's first point stand at the given place, within
	 * float rounding? History asks this before a move: one undone and redone
	 * subtracts what it added, so exact equality would refuse a clean step.
	 */
	function standsAt(this: InlineInkStore, path: string, ids: readonly string[], from: ReadonlyArray<{ x: number; y: number }>): boolean {
		const rec = this.byPath.get(path);
		if (!rec || from.length !== ids.length) return false;
		const byId = new Map(rec.strokes.map((s) => [s.id, s] as const));
		return ids.every((id, i) => {
			const p = byId.get(id)?.points[0];
			const want = from[i]!;
			return p !== undefined && Math.abs(p.x - want.x) <= 1e-6 && Math.abs(p.y - want.y) <= 1e-6;
		});
	}

	/**
	 * Does the note's record hold every one of these ids? Reads the record
	 * itself, not `strokes()`, which hides cached strokes while a reload is
	 * pending: the same list `take` takes from. History asks this before a
	 * replace, which applies whole or not at all.
	 */
	function holdsAll(this: InlineInkStore, path: string, ids: readonly string[]): boolean {
		const rec = this.byPath.get(path);
		if (!rec) return ids.length === 0;
		const held = new Set(rec.strokes.map((s) => s.id));
		return ids.every((id) => held.has(id));
	}

	/**
	 * Every stroke id in the note's record, in order. Reads the record itself,
	 * as holdsAll does: `strokes()` hides the other device's strokes while a
	 * reload is pending, and `take` counts its indices in this whole list.
	 */
	function recordIds(this: InlineInkStore, path: string): string[] {
		return this.byPath.get(path)?.strokes.map((s) => s.id) ?? [];
	}

	function take(this: InlineInkStore,
		path: string,
		ids: readonly string[]
	): Array<{ stroke: InkStroke; index: number }> {
		const rec = this.record(path);
		const wanted = new Set(ids);
		const removed: Array<{ stroke: InkStroke; index: number }> = [];
		for (let i = rec.strokes.length - 1; i >= 0; i--) {
			const s = rec.strokes[i]!;
			if (!wanted.has(s.id)) continue;
			removed.push({ stroke: s, index: i });
			rec.localStrokeIds.add(s.id);
			rec.strokes.splice(i, 1);
		}
		if (removed.length > 0) {
			bumpInkRevision();
			rec.mutationGeneration++;
		}
		removed.reverse(); // ascending original indices
		return removed;
	}

	/** Translate exactly the listed strokes. Missing ids are skipped. */
	function moveStrokes(this: InlineInkStore, path: string, ids: readonly string[], dx: number, dy: number): void {
		if (dx === 0 && dy === 0) return;
		const rec = this.record(path);
		const wanted = new Set(ids);
		let moved = 0;
		for (const s of rec.strokes) {
			if (wanted.has(s.id)) {
				translateStroke(s, dx, dy);
				rec.localStrokeIds.add(s.id);
				moved++;
			}
		}
		// This is the mutation that changes a stroke IN PLACE rather than
		// changing the list, so it is the one a reference-holding snapshot
		// would miss. See adoptExternal's second qualification.
		if (moved > 0) rec.mutationGeneration++;
	}

export function installInlineInkStoreCommit(proto: InlineInkStore): void {
	installMethods(proto, {
		commit,
		commitGesture,
		applyAdd,
		applyAddLive,
		reinsertLive,
		insert,
		applyRemove,
		takeLive,
		standsAt,
		holdsAll,
		recordIds,
		take,
		moveStrokes,
	});
}
