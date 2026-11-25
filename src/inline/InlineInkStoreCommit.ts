/**
 * The inline ink store's commit path: the commit of a gesture, the add and remove of strokes, the live insert and take, and the move of strokes.
 * They are methods of InlineInkStore, installed on its prototype when InlineInkStore.ts loads.
 */
import { InkStroke, type InkPoint } from "../ink/Stroke";
import type { PageData } from "../model/PageData";
import { scaleStroke, translateStroke } from "../objects/Selection";
import { bumpInkListRevision, bumpInkRevision, bumpStrokeRev } from "../ink/StrokeRev";
import { notifyInkChanged } from "./InkEvents";
import { installMethods } from "./InstallMethods";
import type { NoteRecord, InlineInkStore } from "./InlineInkStore";
import { attachmentMembership, replaceMembers } from "./InkAttachments";
import type { StrokeShape } from "./LassoTransform";

declare module "./InlineInkStore" {
	interface InlineInkStore {
		commit(path: string, stroke: InkStroke): void;
		commitGesture(path: string, strokes: readonly InkStroke[]): void;
		applyAdd(path: string, strokes: readonly InkStroke[], indices?: readonly number[], neighbours?: { next?: readonly (string | null)[]; prev?: readonly (string | null)[] }): void;
		applyAddLive(path: string, strokes: readonly InkStroke[], indices?: readonly number[]): void;
		reinsertLive(path: string, groups: ReadonlyArray<{ readonly index: number; readonly pieces: readonly InkStroke[]; readonly parent?: string; readonly fresh?: boolean }>): void;
		insert(rec: NoteRecord, strokes: readonly InkStroke[], indices?: readonly number[], neighbours?: { next?: readonly (string | null)[]; prev?: readonly (string | null)[] }): void;
		applyRemove(path: string, ids: readonly string[]): Array<{ stroke: InkStroke; index: number }>;
		takeLive(path: string, ids: readonly string[]): Array<{ stroke: InkStroke; index: number }>;
		standsAt(path: string, ids: readonly string[], from: ReadonlyArray<{ x: number; y: number }>): boolean;
		holdsAll(path: string, ids: readonly string[]): boolean;
		recordIds(path: string): string[];
		take(path: string, ids: readonly string[]): Array<{ stroke: InkStroke; index: number }>;
		moveStrokes(path: string, ids: readonly string[], dx: number, dy: number): void;
		rewriteStrokes(path: string, edits: ReadonlyArray<{ readonly id: string; readonly shape: StrokeShape }>): void;
	}
}

/**
 * Where each piece a partial erase cut on a note came from: the piece's id to the id of the stroke it was cut from. The
 * merge after a read of the note's file (adoptSidecar) reads it to put a piece the file does not hold yet where its source
 * stands there, under the strokes drawn across the source. Memory only, never saved; it goes with the note's record.
 */
const cutFrom = new WeakMap<NoteRecord, Map<string, string>>();

/** The id of the stroke this piece was cut from on the note, or undefined for a stroke no cut on it made. */
export function cutSource(rec: NoteRecord, id: string): string | undefined {
	return cutFrom.get(rec)?.get(id);
}

/**
 * The strokes a note changed since its page was last handed to a save or its file was read anew, each as it stood before
 * the first change: cut, erased, moved or reshaped. A stroke that came onto the note since (drawn, pasted, a piece of a
 * cut, put back by an undo) maps to null. The merge after a read of the note's file (adoptSidecar) reads it to tell
 * another note's pieces of a stroke changed here from new ink. Memory only, never saved; it goes with the note's record.
 */
const changedFrom = new WeakMap<NoteRecord, Map<string, InkStroke | null>>();

/** The note's strokes changed and not yet handed to a save, each as it stood before (see changedFrom). */
export function unsavedChanges(rec: NoteRecord): ReadonlyMap<string, InkStroke | null> | undefined {
	return changedFrom.get(rec);
}

/** The note's page was handed to a save, or its file is read anew over a page with nothing unsaved: no change is pending. */
export function changesHanded(rec: NoteRecord): void {
	changedFrom.delete(rec);
}

/**
 * A save a note handed its changes to: the page handed; the ids of the strokes it changed since the save before
 * (changedFrom's keys then; none for a save that changed no stroke); each changed stroke as it stood before that change
 * (changedFrom's values then, none for a stroke that came onto the note since); and the attached groups a user action
 * acted on since the save before (groupsActed then). Until the save is seen to land, all of it is still the note's own.
 */
interface HandedSave {
	readonly page: PageData;
	readonly ids: readonly string[];
	readonly before: ReadonlyArray<readonly [string, InkStroke]>;
	readonly groups: readonly string[];
}

/**
 * The saves a note handed its changes to and that have not been seen to land, oldest first. At most HANDED_MAX: past
 * that the oldest goes, and its changed ids, before-copies and groups pass to the next save kept. That save's page is a
 * later snapshot of the same note, so its landing, or a later one's, shows those changes are in the file too, as it
 * does below the cap. Memory only.
 */
const handedSaves = new WeakMap<NoteRecord, HandedSave[]>();
const HANDED_MAX = 64;

/**
 * Per stroke, the versions it stood at before each change a landed save put in the file: the file held each of them, so
 * the other side may hold any one and cut it. Memory only; forgotten with the page they belong to (forgetHanded).
 */
const landedFrom = new WeakMap<NoteRecord, Map<string, InkStroke[]>>();

/**
 * The strokes a note changed whose change a landed save put in its file, and not changed again since: a read of the file
 * that no longer holds one finds the other side's cut or erase of it, and its pieces in the file stand. Memory only.
 */
const savedChanges = new WeakMap<NoteRecord, Set<string>>();

/**
 * The note's page is handed to a save with the changes not yet handed (called before changesHanded). `landed` asks
 * whether a handed page's own write has landed: the saves seen to land move their changes into savedChanges first. `groups`
 * are the attached groups acted on since the save before, taken before they are counted saved. A host with no answer
 * keeps nothing, and every change stays the note's own.
 */
export function changesHandedTo(rec: NoteRecord, page: PageData, landed: ((page: PageData) => boolean) | undefined, groups?: ReadonlySet<string>): void {
	if (!landed) return;
	takeLandedChanges(rec, landed);
	// Every handed page is kept, one that changed no stroke too (an Attach, a second save): the store keeps one page per id
	// waiting, so this page can take an earlier one's place and land alone, and its landing closes the saves before it.
	const from = changedFrom.get(rec);
	const ids = [...(from?.keys() ?? [])];
	const before: Array<readonly [string, InkStroke]> = [];
	for (const [id, was] of from ?? []) if (was) before.push([id, was]);
	// Changed again: the change in the file is the older one until this save lands.
	const saved = savedChanges.get(rec);
	if (saved) for (const id of ids) saved.delete(id);
	let list = handedSaves.get(rec);
	if (!list) handedSaves.set(rec, (list = []));
	list.push({ page, ids, before, groups: [...(groups ?? [])] });
	if (list.length > HANDED_MAX) {
		const gone = list.shift()!;
		const next = list[0]!;
		list[0] = { ...next, ids: [...gone.ids, ...next.ids], before: [...gone.before, ...next.before], groups: [...gone.groups, ...next.groups] };
	}
}

/** The strokes changed by this note's saves not seen to land, each as it stood before each such change, oldest first. */
export function handedBefore(rec: NoteRecord): Array<readonly [string, InkStroke]> {
	return (handedSaves.get(rec) ?? []).flatMap((e) => e.before);
}

/** The ids of the strokes changed by this note's saves not seen to land. */
export function handedIds(rec: NoteRecord): Set<string> {
	return new Set((handedSaves.get(rec) ?? []).flatMap((e) => e.ids));
}

/** The attached groups acted on by this note's saves not seen to land: they are still this note's own. */
export function handedGroups(rec: NoteRecord): Set<string> {
	return new Set((handedSaves.get(rec) ?? []).flatMap((e) => e.groups));
}

/** The versions stroke `id` stood at before each change of it a landed save put in the file (landedFrom). */
export function landedVersions(rec: NoteRecord, id: string): readonly InkStroke[] {
	return landedFrom.get(rec)?.get(id) ?? [];
}

/**
 * The note's page was replaced whole by its file's (its own ids emptied): the saves it handed, their landed changes and
 * the versions they held belong to the page replaced, and are forgotten.
 */
export function forgetHanded(rec: NoteRecord): void {
	handedSaves.delete(rec);
	savedChanges.delete(rec);
	landedFrom.delete(rec);
	// Every caller has handed the unsaved changes first (changesHanded), so no version the note keeps reads these shifts.
	shiftsOf.delete(rec);
}

/**
 * Every save up to the newest one whose page has landed is in the file: their changes are saved, except a stroke a later
 * save not yet landed changed again. Asked before a read of the file is merged into the note, and before each save.
 */
export function takeLandedChanges(rec: NoteRecord, landed: ((page: PageData) => boolean) | undefined): void {
	const list = handedSaves.get(rec);
	if (!list || !landed) return;
	let last = -1;
	for (let i = list.length - 1; i >= 0 && last < 0; i--) if (landed(list[i]!.page)) last = i;
	if (last < 0) return;
	const done = list.splice(0, last + 1);
	const later = new Set(list.flatMap((e) => e.ids));
	let saved = savedChanges.get(rec);
	if (!saved) savedChanges.set(rec, (saved = new Set()));
	for (const e of done) for (const id of e.ids) if (!later.has(id)) saved.add(id);
	let versions = landedFrom.get(rec);
	if (!versions) landedFrom.set(rec, (versions = new Map<string, InkStroke[]>()));
	for (const e of done) {
		for (const [id, was] of e.before) {
			const list = versions.get(id);
			if (list) list.push(was);
			else versions.set(id, [was]);
		}
	}
}

/**
 * Whether this note's own stroke `id` was changed here and that change is in the file by a landed save, not changed again
 * since (savedChanges). A stroke whose save is queued, failed, or was replaced in the queue before it was written is not.
 */
export function changeSaved(rec: NoteRecord, id: string): boolean {
	return rec.localStrokeIds.has(id) && (savedChanges.get(rec)?.has(id) ?? false) && !(changedFrom.get(rec)?.has(id) ?? false);
}

function changesOf(rec: NoteRecord): Map<string, InkStroke | null> {
	let map = changedFrom.get(rec);
	if (!map) {
		map = new Map();
		changedFrom.set(rec, map);
	}
	return map;
}

/**
 * A stroke on the note is about to change: kept as it stands, the first time only, points copied. A move keeps its own
 * version without the copy (MovedVersion).
 */
function changing(rec: NoteRecord, stroke: InkStroke): void {
	const map = changesOf(rec);
	if (map.has(stroke.id)) return;
	map.set(stroke.id, { ...stroke, points: stroke.points.map((p) => ({ ...p })), bbox: { ...stroke.bbox } });
}

/** A stroke came onto the note: nothing of it can be in the file as last read or saved. */
function arrived(rec: NoteRecord, id: string): void {
	const map = changesOf(rec);
	if (!map.has(id)) map.set(id, null);
}

/**
 * One change of points arrays in place: each point of each array now stands at where it stood before, times k, plus
 * (dx, dy). A move shifts (moveStrokes, k 1), and the read that moves a note's ink into its file's font size scales
 * (scaleKept, dx and dy 0). Those are the only writes that change a store stroke's points in place. It names the arrays,
 * not the strokes: a reshape gives the stroke a new array and never changes the old one again, and the undo of a cut puts
 * back the same stroke with the same array. A later move of the same arrays, with no version kept in it, adds to dx and
 * dy (moveStrokes).
 */
interface Shift {
	readonly arrays: readonly InkPoint[][];
	readonly k: number;
	dx: number;
	dy: number;
	/** The arrays as a set, built on the first read that needs one. */
	set: Set<InkPoint[]> | null;
}

/**
 * Per note, its shifts in order since its first version kept without a copy of its points (MovedVersion): a version reads
 * its points back through the shifts after the one it was kept at. A move adds one shift, not one per stroke, and moves
 * of the same strokes with no version kept between them add none after the first. Memory only; forgotten with the
 * versions, when the page is replaced whole (forgetHanded).
 */
const shiftsOf = new WeakMap<NoteRecord, Shift[]>();

/** How many shifts the note holds (a count for cells; reads nothing else). */
export function keptShifts(rec: NoteRecord): number {
	return shiftsOf.get(rec)?.length ?? 0;
}

/** Whether the shift changed this array. */
function shifted(e: Shift, points: InkPoint[]): boolean {
	if (e.arrays.length <= 16) return e.arrays.includes(points);
	return (e.set ??= new Set(e.arrays)).has(points);
}

/** The same arrays in the same order. */
function sameArrays(a: readonly InkPoint[][], b: readonly InkPoint[][]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * A stroke as it stood before a move, kept without a copy of its points: a large move (Insert Space on a long note moves
 * every stroke below the gap) would otherwise copy every point it moves. Every field but the points is taken as it stood
 * (the bbox and line anchor objects are shared: every writer replaces them, none changes one in place). The points are
 * built on their first read from the live array, taken back through the note's shifts of that array since the version
 * was kept, and kept from then on. So x and y are the numbers they stood at up to rounding (well inside the merge's NEAR),
 * and every other point field is the live point's, which no move or scale changes.
 */
class MovedVersion implements InkStroke {
	id: string;
	tool: InkStroke["tool"];
	color: string;
	width: number;
	bbox: InkStroke["bbox"];
	createdAt: number;
	widthMode: InkStroke["widthMode"];
	pressureProfile: InkStroke["pressureProfile"];
	pressureSensitivity: InkStroke["pressureSensitivity"];
	device: InkStroke["device"];
	page: InkStroke["page"];
	lineAnchor: InkStroke["lineAnchor"];
	#from: InkPoint[] | null;
	#shifts: readonly Shift[] | null;
	readonly #at: number;
	#points: InkPoint[] | null = null;

	constructor(s: InkStroke, shifts: readonly Shift[], at: number) {
		this.id = s.id;
		this.tool = s.tool;
		this.color = s.color;
		this.width = s.width;
		this.bbox = s.bbox;
		this.createdAt = s.createdAt;
		this.widthMode = s.widthMode;
		this.pressureProfile = s.pressureProfile;
		this.pressureSensitivity = s.pressureSensitivity;
		this.device = s.device;
		this.page = s.page;
		this.lineAnchor = s.lineAnchor;
		this.#from = s.points;
		this.#shifts = shifts;
		this.#at = at;
	}

	get points(): InkPoint[] {
		if (this.#points) return this.#points;
		const from = this.#from!;
		const shifts = this.#shifts!;
		// Since the version was kept, each point went to p * k + (ox, oy): the shifts of this array, in order.
		let k = 1, ox = 0, oy = 0;
		for (let i = this.#at; i < shifts.length; i++) {
			const e = shifts[i]!;
			if (!shifted(e, from)) continue;
			k *= e.k;
			ox = ox * e.k + e.dx;
			oy = oy * e.k + e.dy;
		}
		const points = k === 1
			? from.map((p) => ({ ...p, x: p.x - ox, y: p.y - oy }))
			: from.map((p) => ({ ...p, x: (p.x - ox) / k, y: (p.y - oy) / k }));
		this.#points = points;
		this.#from = null;
		this.#shifts = null;
		return points;
	}

	set points(points: InkPoint[]) {
		this.#points = points;
		this.#from = null;
		this.#shifts = null;
	}
}

/**
 * Scale strokes of the note in place (scaleStroke), keeping every version kept without a copy of its points
 * (MovedVersion) as it stood: one shift for all of them. The read that moves the note's ink into its file's font size
 * calls it.
 */
export function scaleKept(rec: NoteRecord, strokes: readonly InkStroke[], k: number): void {
	for (const stroke of strokes) scaleStroke(stroke, k);
	const shifts = shiftsOf.get(rec);
	if (shifts && strokes.length > 0) shifts.push({ arrays: strokes.map((s) => s.points), k, dx: 0, dy: 0, set: null });
}

/**
 * Notes where the pieces of one live partial erase came from (reinsertLive's groups). A stroke the ring missed and put
 * back whole is no cut. A piece this same gesture made and cut again (`fresh`) is in no history step and leaves the page:
 * its pieces take its own source, and it leaves the map.
 */
function noteCuts(rec: NoteRecord, groups: ReadonlyArray<{ readonly pieces: readonly InkStroke[]; readonly parent?: string; readonly fresh?: boolean }>): void {
	for (const g of groups) {
		if (g.parent === undefined || (g.pieces.length === 1 && g.pieces[0]!.id === g.parent)) continue;
		let map = cutFrom.get(rec);
		if (!map) {
			map = new Map();
			cutFrom.set(rec, map);
		}
		const source = (g.fresh ? map.get(g.parent) : undefined) ?? g.parent;
		if (g.fresh) map.delete(g.parent);
		for (const piece of g.pieces) map.set(piece.id, source);
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
			if (at < 0) {
				arrived(rec, stroke.id);
				rec.strokes.push(stroke);
			} else {
				changing(rec, rec.strokes[at]!);
				rec.strokes[at] = stroke;
			}
			rec.localStrokeIds.add(stroke.id);
		}
		bumpInkRevision();
		bumpInkListRevision();
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
	 *
	 * `parent`, the id of the stroke an entry's pieces were cut from: they
	 * join its attached groups. An original stays listed while
	 * erased, so the erase's undo and redo change no record; a parent that
	 * is itself a piece of this session leaves when its pieces join. No
	 * write: the pen-up save carries the list. The cut is the user's: each
	 * group whose members it changes is this note's own until saved.
	 */
	function reinsertLive(this: InlineInkStore,
		path: string,
		groups: ReadonlyArray<{ readonly index: number; readonly pieces: readonly InkStroke[]; readonly parent?: string; readonly fresh?: boolean }>
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
		if (strokes.length > 0) {
			const rec = this.record(path);
			this.insert(rec, strokes, at);
			noteCuts(rec, groups);
		}
		const list = this.attachments(path);
		if (list.length === 0) return;
		// A parent stays listed beside its pieces: an undo of the gesture puts it back as a member. Only a piece the same
		// gesture made (`fresh`) leaves for its own pieces, so a long drag lists no intermediate piece; a piece an earlier
		// gesture made is in that gesture's history step and stays.
		const family = new Map<string, string[]>();
		for (const g of groups) {
			if (g.parent === undefined || (g.pieces.length === 1 && g.pieces[0]!.id === g.parent)) continue;
			const ids = g.pieces.map((p) => p.id);
			family.set(g.parent, g.fresh ? ids : [g.parent, ...ids]);
		}
		if (family.size === 0) return;
		const next = replaceMembers(list, family);
		if (next.some((a, i) => a !== list[i])) this.setAttachments(path, next, false, true);
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
			arrived(rec, stroke.id);
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
			bumpInkListRevision();
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
			changing(rec, s);
			rec.localStrokeIds.add(s.id);
			rec.strokes.splice(i, 1);
		}
		if (removed.length > 0) {
			bumpInkRevision();
			bumpInkListRevision();
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
		let changes: Map<string, InkStroke | null> | null = null;
		let shifts = shiftsOf.get(rec);
		let kept = false;
		const arrays: InkPoint[][] = [];
		for (const s of rec.strokes) {
			if (wanted.has(s.id)) {
				// Kept as it stands the first time only, as changing does, but without a copy of its points: its version
				// reads them back through this move's shift and every later one of the same array. So does every version
				// kept on the array before, the ones handed to a save or put in the file by one too.
				changes ??= changesOf(rec);
				if (!changes.has(s.id)) {
					if (!shifts) shiftsOf.set(rec, (shifts = []));
					changes.set(s.id, new MovedVersion(s, shifts, shifts.length));
					kept = true;
				}
				translateStroke(s, dx, dy);
				arrays.push(s.points);
				rec.localStrokeIds.add(s.id);
				moved++;
			}
		}
		if (shifts && arrays.length > 0) {
			// The same arrays moved again and no version kept in this call (a lasso drag with no picture moves the store
			// once per pen sample): the move goes into the last shift, after its own change, and every version that reads
			// that shift reads both. A version kept in this call reads from this call's shift on, so the call adds one; so
			// does a move of other arrays. Only this function keeps a version that reads the shifts, and each call that
			// keeps one ends with its own shift, so no version kept before this call starts after the last shift.
			const last = shifts[shifts.length - 1];
			if (!kept && last && sameArrays(last.arrays, arrays)) {
				last.dx += dx;
				last.dy += dy;
			} else {
				shifts.push({ arrays, k: 1, dx, dy, set: null });
			}
		}
		// This is the mutation that changes a stroke IN PLACE rather than
		// changing the list, so it is the one a reference-holding snapshot
		// would miss. See adoptExternal's second qualification.
		if (moved > 0) rec.mutationGeneration++;
	}

	/**
	 * Give exactly the listed strokes a new shape in place: points, width, bbox and the line anchor's y, each a copy of the shape's, so
	 * the shape the history keeps never becomes the live stroke's. The lasso's resize and rotate lands here, and its undo and redo
	 * put back the before and after copies. Like moveStrokes, the objects and ids stay, which the history, the other panes and
	 * the ribbon cache (by stroke rev) depend on; the ids go local and the generation moves, so a reference-holding snapshot and
	 * the sync guard see the change. Missing ids are skipped.
	 */
	function rewriteStrokes(this: InlineInkStore, path: string, edits: ReadonlyArray<{ readonly id: string; readonly shape: StrokeShape }>): void {
		if (edits.length === 0) return;
		const rec = this.record(path);
		const byId = new Map(edits.map((e) => [e.id, e.shape]));
		// Stroke ids of the note's attached groups, read once and only when a copy without an anchor meets a stroke with one.
		let members: ReadonlyMap<string, string> | null = null;
		let changed = 0;
		for (const s of rec.strokes) {
			const shape = byId.get(s.id);
			if (!shape) continue;
			changing(rec, s);
			s.points = shape.points.map((p) => ({ ...p }));
			s.width = shape.width;
			s.bbox = { ...shape.bbox };
			// The line the stroke rides stays the live one, as a move's does (translatedAnchor): text typed since the copy was
			// taken, here or in another pane, has moved that line, and the copy's would put the ink back off it. Only y follows the shape.
			if (shape.lineAnchor) s.lineAnchor = s.lineAnchor ? { ...s.lineAnchor, y: shape.lineAnchor.y } : { ...shape.lineAnchor };
			// A copy taken before an attached member was anchored holds none. The member keeps the anchor it holds now, y the
			// shape's top: Reading view, an embed and Export to PDF draw a member by its anchor. Free ink with no anchor in the
			// copy comes back with none.
			else if (s.lineAnchor && (members ??= attachmentMembership(this.attachments(path))).has(s.id)) s.lineAnchor = { ...s.lineAnchor, y: shape.bbox.y };
			else delete s.lineAnchor;
			bumpStrokeRev(s);
			rec.localStrokeIds.add(s.id);
			changed++;
		}
		if (changed > 0) rec.mutationGeneration++;
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
		rewriteStrokes,
	});
}
