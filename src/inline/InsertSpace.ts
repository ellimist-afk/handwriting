/**
 * Insert space: the divider gesture's pure core.
 *
 * The gesture is overlay state (a world y, a frozen id list, an accumulated
 * dy) driving the SAME machinery the lasso drag uses: `moveStrokes` live,
 * one `move` op at release. What is genuinely new is the membership rule -
 * which strokes a divider takes with it - and that rule wants to be pure
 * and tested, because it is the part a user disagrees with when the gesture
 * "split the letters".
 *
 * Two rules were tried and both were wrong, for the same reason:
 *
 *   1. bbox TOP - tore a row apart, because a written row is not a band of
 *      uniform height and a divider in the gap between rows still sits
 *      below the tops of the taller letters in the lower row.
 *   2. the ink's centroid - better, and still wrong, because a letter is
 *      not always ONE stroke. The dot of an `i`, the cross of a `t`, the
 *      bar of an `A`: each is its own stroke with its own centroid, and a
 *      line drawn between a dot and its stem separates them.
 *
 * Both failed because they judge strokes INDIVIDUALLY. Any horizontal line
 * through a page of handwriting passes through something. So membership is
 * decided a ROW at a time instead. Rows wholly below the line move and rows
 * wholly above it stay. A row the line crosses, such as a drawing whose strokes
 * chain into one row, splits by each stroke's own middle, and its marks (dots,
 * full stops) go with their letters (strokeIdsBelow). The nearest row edge no
 * longer relocates the visible insertion guide.
 * The overlay previews crossing groups explicitly so the line cannot imply
 * that a letter or a large transitive group will be cut apart.
 */

import type { BBox, InkStroke } from "../ink/Stroke";
import { inkRevision, sourceOf, strokeRev } from "../ink/StrokeRev";

/** A row of writing: its vertical extent and the strokes that make it up. */
export interface InkRow {
	top: number;
	bottom: number;
	ids: string[];
}

/**
 * What a crossed row splits by, for every row rowsOf and InsertSpaceRows build: each stroke's middle (the centre of its
 * points' vertical extent), index for index with the row's ids, and each mark (a dot, a full stop) by id with the
 * stroke it goes with, a stroke of the row that is no mark. Kept beside the row, so a row is still its extent and ids. A
 * row built by hand has no entry (strokeIdsBelow, sameRowSides).
 */
const splits = new WeakMap<InkRow, {mids: readonly number[]; marks: ReadonlyMap<string, string>}>();

/** Register a built row's middles and marks. `marks` may name a mark as a host; each is followed to a stroke that is
 * no mark, and kept only when that stroke is in the row. */
function register(row: InkRow, byId: ReadonlyMap<string, Extent>, marks: ReadonlyMap<string, string>): InkRow {
	const inRow = new Set(row.ids), own = new Map<string, string>();
	for (const id of row.ids) {
		let host = marks.get(id);
		for (let n = marks.size; host !== undefined && marks.has(host) && n > 0; n--) host = marks.get(host);
		if (host !== undefined && !marks.has(host) && inRow.has(host)) own.set(id, host);
	}
	splits.set(row, {mids: row.ids.map((id) => { const e = byId.get(id)!; return (e.top + e.bottom) / 2; }), marks: own});
	return row;
}

/**
 * The stroke a mark the second pass attached goes with: the candidate overlapping it most in x, else the nearest in x;
 * the first on a tie. Only when the mark sits close over it, the gap from the mark's bottom to that stroke's top at most
 * the stroke's own height (a dot over its stem); a label high over a tall drawing goes by its own middle instead.
 */
function hostOf(mark: Extent, candidates: readonly Extent[]): string | undefined {
	let host: Extent | undefined, best = -Infinity;
	for (const c of candidates) {
		if (c.id === mark.id) continue;
		const overlap = Math.min(mark.right, c.right) - Math.max(mark.left, c.left);
		if (overlap > best) { best = overlap; host = c; }
	}
	return host !== undefined && host.top - mark.bottom <= host.bottom - host.top ? host.id : undefined;
}

/** A mark the second pass attached takes ONE host for all its strokes not already joined to a letter: hostOf on their
 * union extent, so a label of several strokes never tears. */
function markGroupHost(ids: readonly string[], byId: ReadonlyMap<string, Extent>, letters: readonly Extent[], marks: Map<string, string>): void {
	const own = ids.filter((id) => !marks.has(id)).map((id) => byId.get(id)!);
	if (own.length === 0) return;
	const union: Extent = { id: "", top: Math.min(...own.map((e) => e.top)), bottom: Math.max(...own.map((e) => e.bottom)),
		left: Math.min(...own.map((e) => e.left)), right: Math.max(...own.map((e) => e.right)) };
	const host = hostOf(union, letters);
	if (host !== undefined) for (const e of own) marks.set(e.id, host);
}

/** Hover must not rescan every point in the note. Moves mutate strokes in
 * place, so both object identity and the renderer's revision are significant.
 * Hover must not read every stroke either: an ask with the list, length and
 * ink revision of the last confirmed one is a hit without looking further. */
/** One confirmed stroke: its id, the object asked with, that object's revision and its store source's. */
type Entry = {id: string; stroke: InkStroke; rev: number; srev: number};
/** Why the rows cache fell back (InsertSpaceRows.onMiss, rig only). */
export type RowsMiss = {
	why: string; strokes: number; entries: number; idOff: number; copies: number; revOff: number; srevOff: number;
	deltas: Record<number, number>; offMoved: number; allMoved: number;
	/** shift:part-group only: the refusing group's ids not in the moved set, at most eight. */
	left?: string[];
};
const entryOf = (stroke: InkStroke): Entry => ({id: stroke.id, stroke, rev: strokeRev(stroke), srev: strokeRev(sourceOf(stroke))});
/**
 * Whether group `g` and box `b` (a stroke's extent, or another group's) join by the rule shift and replace judge with:
 * they overlap vertically and lie within three times the shorter height sideways, or the taller one's for a mark.
 * Judged by group extents and tallest strokes, so it only errs toward regrouping.
 */
const joins = (g: Group, b: {top: number; bottom: number; left: number; right: number}, h: number): boolean => {
	if (b.top > g.bottom || b.bottom < g.top) return false;
	const lo = Math.min(g.tallest, h), hi = Math.max(g.tallest, h);
	return Math.max(0, g.left - b.right, b.left - g.right) <= Math.max(3 * lo, hi) * (1 + 1e-9) + 1e-9;
};
/**
 * Whether two strokes join in groupsOf's first pass: an ordinary join (vertical spans overlap, gap at most
 * three times the shorter height) or the mark rule either way. A mark takes only its nearest such join; passing the rule
 * is enough to make the regroup decide.
 */
const pairJoins = (a: Extent, b: Extent): boolean => {
	if (a.bottom <= b.top || b.bottom <= a.top) return false;
	const gap = Math.max(0, a.left - b.right, b.left - a.right), ha = a.bottom - a.top, hb = b.bottom - b.top;
	if (gap <= 3 * Math.min(ha, hb)) return true;
	const mark = (m: Extent, hm: number, o: Extent, ho: number) => hm <= ho / 4 && m.top >= o.top && m.bottom <= o.bottom && m.right - m.left <= ho * .34 && gap <= Math.max(3 * hm, ho);
	return mark(a, ha, b, hb) || mark(b, hb, a, ha);
};
/** A floating group this much of the editor's letter size or more is never a mark (withMarks): a dot is far smaller. */
const MARK_LETTER = .5;
const sameExtent = (a: Extent, b: Extent) => a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;

export class InsertSpaceRows {
	private entries: Entry[] = [];
	/**
	 * Counters: full localRowsOf runs (a point scan and a regroup of every stroke), regroups of every extent, and
	 * first-pass groups regrouped by a shift or a re-place.
	 */
	readonly counts = {rebuilds: 0, fullRegroups: 0, touchedRows: 0, replaces: 0,
		/** Groups a re-place tested, extents it regrouped, and (rig only) groups regrouped unchanged; a shift's regroup pool. */
		candidates: 0, replacePool: 0, unchanged: 0, shiftPool: 0};
	/** Each stroke's first-pass group and its place in `entries`, kept through shifts and re-places. */
	private groupOf = new Map<string, Group>();
	private indexOf = new Map<string, number>();
	/** The list and ink revision `entries` were last confirmed against. */
	private seen: {list: readonly InkStroke[]; ink: number} | null = null;
	private rows: InkRow[] = [];
	/** Each row's horizontal extent, index for index with `rows`. */
	private spans: {left: number; right: number}[] = [];
	/** The first-pass groups the rows were made from (localRowsOf). */
	private groups: Group[] = [];
	/** Each stroke's extent, index for index with `entries`. */
	private extents: Extent[] = [];
	/** The first pass's mark joins (groupsOf): a mark's id to the stroke it joined. */
	private markJoins = new Map<string, string>();
	/** A shift waiting for its task (queueShift). */
	private queued: {rows: readonly InkRow[]; ids: readonly string[]; steps: readonly number[]; textIds: readonly string[]} | null = null;
	/** Rig only: told why a shift or a confirm fell back. Unset in the plugin, so no miss is read twice. */
	onMiss: ((miss: RowsMiss) => void) | null = null;
	/** Rig only: a re-place's ms, by part. Unset in the plugin, so no clock is read. */
	onTime: ((part: string, ms: number) => void) | null = null;
	/** Rig names: a re-place inside a shift (its copies) reports its parts as "copies.*". */
	private part = "";
	/**
	 * The editor's letter size in note units (withMarks): a floating group of half of it or more is never a mark. None: the
	 * ratio rule against the host decides alone. A change of more than a tenth reads every stroke again at the next ask; a
	 * measure's rounding does not.
	 */
	letterPx: number | undefined = undefined;
	/** The letter size the rows were last built with. */
	private builtLetterPx: number | undefined = undefined;
	/** Whether the cache holds a read to keep current: never read, or emptied by a fallback, is not. */
	get primed(): boolean {
		return this.entries.length > 0;
	}
	get(strokes: readonly InkStroke[]): readonly InkRow[] {
		// An ask that comes before the queued shift's task runs the shift itself, once.
		if (this.queued) this.runQueued(strokes);
		const was = this.builtLetterPx, now = this.letterPx;
		if (was !== now && (was === undefined || now === undefined || !(Math.abs(now - was) <= was * .1))) {
			this.builtLetterPx = this.letterPx;
			this.entries = [];
			this.seen = null;
		}
		const ink = inkRevision(), seen = this.seen;
		if (seen && seen.list === strokes && seen.ink === ink && strokes.length === this.entries.length) return this.rows;
		if (!this.confirm(strokes)) {
			if (this.onMiss) this.onMiss(this.missOf("confirm", strokes, null, 0));
			this.full(strokes);
		}
		this.seen = {list: strokes, ink};
		return this.rows;
	}

	/**
	 * Why `strokes` no longer match the entries (rig only): ids out of place, and strokes whose own
	 * revision (same object) or source revision (a shown copy) is not the one expected, `step` more for a moved one;
	 * `deltas` counts each copy's found minus expected source revision; `moved` how many of the off strokes, and of all,
	 * have a shown extent other than the cached one.
	 */
	private missOf(why: string, strokes: readonly InkStroke[], moved: ReadonlySet<string> | null, step: number): RowsMiss {
		const m: RowsMiss = {why, strokes: strokes.length, entries: this.entries.length, idOff: 0, copies: 0, revOff: 0, srevOff: 0, deltas: {}, offMoved: 0, allMoved: 0};
		const n = Math.min(strokes.length, this.entries.length);
		for (let i = 0; i < n; i++) {
			const e = this.entries[i]!, s = strokes[i]!, x = this.extents[i];
			const k = moved?.has(s.id) ? step : 0, shifted = x && !sameExtent({id: s.id, ...extentOf(s)}, x);
			if (shifted) m.allMoved++;
			if (e.id !== s.id) { m.idOff++; continue; }
			let off = false;
			if (e.stroke === s) {
				off = strokeRev(s) !== e.rev + k;
				if (off) m.revOff++;
			} else {
				m.copies++;
				const d = strokeRev(sourceOf(s)) - (e.srev + k);
				if (d !== 0) { off = true; m.srevOff++; m.deltas[d] = (m.deltas[d] ?? 0) + 1; }
			}
			if (off && shifted) m.offMoved++;
		}
		return m;
	}

	/** A shift's fallback: false, the rig told why first. */
	private no(why: string, strokes: readonly InkStroke[], moved: ReadonlySet<string> | null, step: number, left?: readonly string[]): false {
		if (this.onMiss) this.onMiss({...this.missOf(why, strokes, moved, step), ...(left ? {left: [...left]} : {})});
		return false;
	}

	/** Every stroke read again: the point scan and the regroup of the whole note. */
	private full(strokes: readonly InkStroke[]): void {
		this.entries = strokes.map(entryOf);
		({extents:this.extents,groups:this.groups,markJoins:this.markJoins,rows:this.rows,spans:this.spans} = localRowsOf(strokes, this.letterPx));
		this.groupOf.clear();
		this.indexOf.clear();
		for (const g of this.groups) for (const id of g.ids) this.groupOf.set(id, g);
		strokes.forEach((s, i) => this.indexOf.set(s.id, i));
		this.counts.rebuilds++;
		this.counts.fullRegroups++;
	}

	/**
	 * Whether the rows hold for `strokes`: the same ids in the same order at the same store revisions. A shown
	 * copy made again (a group's correction moved), or the same copy moved in place (its own revision moved,
	 * its source's did not), is the same stroke: re-placed by its new extent. False when the id
	 * set or a revision changed: the caller reads every stroke again.
	 */
	private confirm(strokes: readonly InkStroke[]): boolean {
		if (strokes.length !== this.entries.length) return false;
		const changed: number[] = [];
		for (let i = 0; i < strokes.length; i++) {
			const e = this.entries[i]!, s = strokes[i]!;
			if (e.stroke === s) {
				if (strokeRev(s) === e.rev) continue;
				// A shown copy moved in place: its own revision moved, its source's did not. Re-placed.
				const src = sourceOf(s);
				if (src === s || strokeRev(src) !== e.srev) return false;
				changed.push(i);
				continue;
			}
			if (e.id !== s.id || strokeRev(sourceOf(s)) !== e.srev) return false;
			changed.push(i);
		}
		return changed.length === 0 || this.replace(strokes, changed);
	}

	/**
	 * Re-place strokes whose shown extent may have moved with their store stroke unchanged: each moved
	 * stroke leaves its first-pass group, which is regrouped with the groups the moved extents now meet, by the join rule
	 * shift judges with (so the check only errs toward regrouping). Free strokes beside them did not move, so a row may
	 * split. The work grows with the moved strokes and the groups they touch; the search for groups they meet walks the
	 * group list once. False, cache untouched but for extents, when the result would tie two groups on top and left.
	 */
	private replace(strokes: readonly InkStroke[], idx: readonly number[]): boolean {
		const moved: Extent[] = [];
		for (const i of idx) {
			const s = strokes[i]!, x = {id: s.id, ...extentOf(s)};
			this.entries[i] = entryOf(s);
			if (sameExtent(x, this.extents[i]!)) continue;
			this.extents[i] = x;
			moved.push(x);
		}
		if (moved.length === 0) return true;
		const hit = new Set<Group>();
		for (const x of moved) {
			const g = this.groupOf.get(x.id);
			if (!g) {
				// The cache no longer knows this stroke: the next ask reads every stroke.
				this.entries = [];
				return false;
			}
			hit.add(g);
		}
		const t0 = this.onTime ? performance.now() : 0;
		// A group a moved stroke now joins is regrouped; so is one that met a group a stroke left: the mark
		// rule joins a stop to its nearest candidate, so a member leaving can free a stop to join a group it never met.
		// Each box looks only at the groups in its vertical window of the top-sorted list (a group's top lies
		// within the tallest group's height above the box), and a moved stroke touches a candidate only when it and one of
		// the candidate's strokes pass groupsOf's own pair rule.
		const vacated = [...hit], groups = this.groups;
		let tallest = 0;
		for (const g of groups) tallest = Math.max(tallest, g.bottom - g.top);
		const from = (y: number) => {
			let lo = 0, hi = groups.length;
			while (lo < hi) { const mid = (lo + hi) >> 1; if (groups[mid]!.top < y) lo = mid + 1; else hi = mid; }
			return lo;
		};
		const visit = (top: number, bottom: number, test: (g: Group) => boolean) => {
			for (let i = from(top - tallest); i < groups.length && groups[i]!.top <= bottom; i++) {
				const g = groups[i]!;
				if (hit.has(g) || g.bottom < top) continue;
				this.counts.candidates++;
				if (test(g)) hit.add(g);
			}
		};
		for (const x of moved) visit(x.top, x.bottom, g => g.ids.some(id => pairJoins(x, this.extents[this.indexOf.get(id)!]!)));
		for (const v of vacated) visit(v.top, v.bottom, g => joins(g, v, v.tallest));
		const pool: Extent[] = [];
		for (const g of hit) for (const id of g.ids) pool.push(this.extents[this.indexOf.get(id)!]!);
		// In store order, as localRowsOf hands groupsOf its extents.
		pool.sort((a, b) => this.indexOf.get(a.id)! - this.indexOf.get(b.id)!);
		this.counts.replacePool += pool.length;
		const t1 = this.onTime ? performance.now() : 0;
		// A mark joins within its own group: the regrouped strokes take their joins anew, the others keep theirs.
		const markJoins = new Map(this.markJoins);
		for (const x of pool) markJoins.delete(x.id);
		const again = groupsOf(pool, markJoins);
		if (this.onTime) {
			this.onTime(this.part + "search", t1 - t0); this.onTime(this.part + "groupsOf", performance.now() - t1);
			// Rig only: regrouped groups that came out as they went in.
			const key = (ids: readonly string[]) => [...ids].sort().join(" ");
			const was = new Set([...hit].map(g => key(g.ids)));
			for (const g of again) if (was.has(key(g.ids))) this.counts.unchanged++;
		}
		const next: (Group & {src?: Group})[] = [];
		for (const g of this.groups) if (!hit.has(g)) next.push({...g, src: g});
		for (const g of again) next.push(g);
		next.sort((a, b) => a.top - b.top || a.left - b.left);
		for (let i = 1; i < next.length; i++) {
			const a = next[i - 1]!, b = next[i]!;
			if (a.top === b.top && a.left === b.left && !(a.src && b.src)) {
				// localRowsOf breaks this tie by grouping order: the next ask reads every stroke.
				this.entries = [];
				return false;
			}
		}
		// A kept group stays the same object, so groupOf holds for it; a regrouped one is entered anew.
		const nextGroups = next.map(n => n.src ?? n);
		for (const g of again) for (const id of g.ids) this.groupOf.set(id, g);
		this.groups = nextGroups;
		this.markJoins = markJoins;
		const t2 = this.onTime ? performance.now() : 0;
		({ rows: this.rows, spans: this.spans } = withMarks(nextGroups, this.extents, markJoins, this.letterPx));
		if (this.onTime) this.onTime(this.part + "withMarks", performance.now() - t2);
		this.counts.touchedRows += hit.size;
		this.counts.replaces++;
		return true;
	}

	/** Hold a shift (arguments as `shift`) for a task after the release paint, so
	 * the release frame does not pay it; runQueued or the next get runs it. */
	queueShift(rows: readonly InkRow[], ids: readonly string[], steps: readonly number[], textIds: readonly string[] = []): void {
		this.queued = {rows, ids, steps, textIds};
	}

	/** Run the queued shift against `strokes`, if one is waiting. */
	runQueued(strokes: readonly InkStroke[]): boolean {
		const q = this.queued;
		if (!q) return false;
		this.queued = null;
		return this.shift(strokes, q.rows, q.ids, q.steps, q.textIds);
	}

	/**
	 * An insert space that opened space moved whole rows straight down: bring
	 * the rows up to date without reading every point in the note. On a
	 * 28555-stroke note the rebuild took about 61 ms, on the first hover after
	 * every insert.
	 *
	 * `rows` is the array this cache returned when the gesture began, `ids` the
	 * strokes it moved, and `steps` every dy it moved them by, in order, one
	 * moveStrokes call each. A first-pass group the move carried and that
	 * meets no staying group shifts by the same additions in the same order
	 * as its points took: rounding is monotone, so its top and bottom land
	 * where a rescan would find them, and its joins are the ones it had. A new
	 * join needs a moved stroke and a staying one that overlap vertically
	 * after the move (a group crossing the seam carries strokes above it down
	 * beside the staying ones) and lie close enough sideways: an ordinary
	 * join reaches three times the shorter stroke's height, a mark's join the
	 * taller one's. The groups of every such pair, judged by group extents and
	 * each group's tallest stroke (so the check only errs toward regrouping),
	 * are grouped again from the cached stroke extents, a moved stroke's
	 * shifted by the same steps, so no point is read. The floating-mark pass
	 * then runs over all the groups, as localRowsOf runs it.
	 *
	 * Returns false with the cache untouched, so the next get rebuilds, when
	 * anything changed since `rows` other than these steps over these ids, a
	 * moved group or moved part did not end up lower, or two groups the shift
	 * placed share a top and left (localRowsOf breaks that tie by grouping
	 * order).
	 */
	shift(strokes: readonly InkStroke[], rows: readonly InkRow[], ids: readonly string[], steps: readonly number[], textIds: readonly string[] = []): boolean {
		if (rows !== this.rows || steps.length === 0 || strokes.length !== this.entries.length) return this.no("shift:rows-or-length", strokes, null, steps.length);
		// `ids` moved in the store (each revision one step on per move); `textIds` moved with their text, members of
		// a group the text change carries, their store strokes unmoved. Both moved for the group test and the extents.
		const stored = new Set(ids), text = new Set(textIds), moved = new Set([...ids, ...textIds]);
		if (stored.size !== ids.length || text.size !== textIds.length || moved.size !== ids.length + textIds.length) return this.no("shift:dup-ids", strokes, stored, steps.length);
		let found = 0;
		for (let i = 0; i < strokes.length; i++) {
			const e = this.entries[i]!, s = strokes[i]!;
			const m = moved.has(s.id);
			if (m) found++;
			// A shown copy (a group member) is confirmed by its source's id and revision, the same copy moved in place
			// too; a free stroke by itself.
			const step = stored.has(s.id) ? steps.length : 0, src = sourceOf(s);
			if (e.stroke === s && src === s ? strokeRev(s) !== e.rev + step : (e.id !== s.id || strokeRev(src) !== e.srev + step)) return this.no("shift:rev", strokes, stored, steps.length);
		}
		if (found !== moved.size) return this.no("shift:not-found", strokes, stored, steps.length);
		const f = (y: number) => { for (const d of steps) y += d; return y; };
		// A first-pass group moved in part (free strokes beside an attached group, the row and the group on
		// different sides) is taken as two, its moved strokes and its staying ones, each boxed from the cached extents.
		// Both halves are regrouped, with every group they or the whole they came from meet, so the work grows with the
		// part-moved groups, never with the note.
		const box = (ids: string[]): Group => {
			const g: Group = {top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity, tallest: 0, ids};
			for (const id of ids) {
				const x = this.extents[this.indexOf.get(id)!]!;
				g.top = Math.min(g.top, x.top); g.bottom = Math.max(g.bottom, x.bottom);
				g.left = Math.min(g.left, x.left); g.right = Math.max(g.right, x.right);
				g.tallest = Math.max(g.tallest, x.bottom - x.top);
			}
			return g;
		};
		const groups: Group[] = [], halves: {whole: Group; moved: Group; stay: Group}[] = [];
		let inGroups = 0;
		const isMoved: boolean[] = [];
		for (const g of this.groups) {
			let n = 0;
			for (const id of g.ids) if (moved.has(id)) n++;
			inGroups += n;
			const mv = n !== 0 && n !== g.ids.length ? g.ids.filter(id => moved.has(id)) : null;
			if (mv && mv.length > 0 && mv.length < g.ids.length) {
				const h = {whole: g, moved: box(mv), stay: box(g.ids.filter(id => !moved.has(id)))};
				if (!(f(h.moved.top) > h.moved.top)) return this.no("shift:not-lower", strokes, stored, steps.length);
				halves.push(h);
				groups.push(h.moved, h.stay);
				isMoved.push(true, false);
				continue;
			}
			if (n > 0 && !(f(g.top) > g.top)) return this.no("shift:not-lower", strokes, stored, steps.length);
			groups.push(g);
			isMoved.push(n > 0);
		}
		if (inGroups !== moved.size) return this.no("shift:in-groups", strokes, stored, steps.length);
		if (halves.length) {
			// Halves enter out of top order; the search below needs it.
			const order = groups.map((_, i) => i).sort((a, b) => groups[a]!.top - groups[b]!.top || groups[a]!.left - groups[b]!.left);
			const g2 = order.map(i => groups[i]!), m2 = order.map(i => isMoved[i]!);
			groups.splice(0, groups.length, ...g2);
			isMoved.splice(0, isMoved.length, ...m2);
		}
		// Groups are in top order and f keeps it, so the moved ones are in order of their new tops.
		const movedAt: number[] = [], stayAt: number[] = [];
		groups.forEach((_, i) => (isMoved[i] ? movedAt : stayAt).push(i));
		const ts0 = this.onTime ? performance.now() : 0;
		const newTop = movedAt.map(i => f(groups[i]!.top)), touched = new Set<number>();
		if (halves.length) {
			const at = (g: Group, m: boolean): Group => m ? {...g, top: f(g.top), bottom: f(g.bottom)} : g;
			const split = new Set<Group>();
			for (const h of halves) split.add(h.moved).add(h.stay);
			groups.forEach((g, i) => { if (split.has(g)) touched.add(i); });
			// Each half where it lands, and the whole where it was and where its moved part went (a stop freed by a
			// member leaving joins a group it never met).
			const probes: {b: Group; h: number}[] = [];
			for (const h of halves) probes.push({b: h.stay, h: h.stay.tallest}, {b: at(h.moved, true), h: h.moved.tallest}, {b: h.whole, h: h.whole.tallest}, {b: at(h.whole, true), h: h.whole.tallest});
			groups.forEach((g, i) => {
				if (touched.has(i)) return;
				const p = at(g, isMoved[i]!);
				if (probes.some(({b, h}) => joins(p, b, h))) touched.add(i);
			});
		}
		for (const si of stayAt) {
			const st = groups[si]!;
			for (let k = 0; k < movedAt.length && newTop[k]! <= st.bottom; k++) {
				const mv = groups[movedAt[k]!]!;
				if (f(mv.bottom) < st.top) continue;
				const apart = Math.max(0, st.left - mv.right, mv.left - st.right);
				const lo = Math.min(st.tallest, mv.tallest), hi = Math.max(st.tallest, mv.tallest);
				if (apart <= Math.max(3 * lo, hi) * (1 + 1e-9) + 1e-9) { touched.add(si); touched.add(movedAt[k]!); }
			}
		}
		const next: (Group & {kept: boolean; src?: Group})[] = [];
		groups.forEach((g, i) => {
			if (touched.has(i)) return;
			next.push(isMoved[i] ? { top: f(g.top), bottom: f(g.bottom), left: g.left, right: g.right, tallest: g.tallest, ids: g.ids, kept: false } : { ...g, kept: true, src: g });
		});
		// A moved stroke's extent is its cached one after the same steps (no point is read).
		const extents = this.extents.map(e => moved.has(e.id) ? { ...e, top: f(e.top), bottom: f(e.bottom) } : e);
		// A mark joins within its own group, so an untouched group keeps its joins and a regrouped one takes new ones.
		const markJoins = new Map(this.markJoins);
		const ts1 = this.onTime ? performance.now() : 0;
		if (touched.size) {
			const again = new Set<string>();
			for (const i of touched) for (const id of groups[i]!.ids) again.add(id);
			this.counts.shiftPool += again.size;
			for (const id of again) markJoins.delete(id);
			for (const g of groupsOf(extents.filter(e => again.has(e.id)), markJoins)) next.push({ ...g, kept: false });
		}
		if (this.onTime) { this.onTime("shift.search", ts1 - ts0); this.onTime("shift.groupsOf", performance.now() - ts1); }
		next.sort((a, b) => a.top - b.top || a.left - b.left);
		for (let i = 1; i < next.length; i++) {
			const a = next[i - 1]!, b = next[i]!;
			if (a.top === b.top && a.left === b.left && !(a.kept && b.kept)) return this.no("shift:tie", strokes, stored, steps.length);
		}
		// A kept group stays the same object (groupOf holds for it); a moved or regrouped one is entered anew.
		const nextGroups: Group[] = next.map(({ top, bottom, left, right, tallest, ids, src }) => src ?? ({ top, bottom, left, right, tallest, ids }));
		const copies: number[] = [];
		for (let i = 0; i < strokes.length; i++) {
			const s = strokes[i]!;
			if (!moved.has(s.id)) continue;
			this.entries[i] = entryOf(s);
			// A text-moved stroke's shifted extent is a guess (its text moved it, not these steps): re-placed by its read one.
			if (sourceOf(s) !== s || text.has(s.id)) copies.push(i);
		}
		this.extents = extents;
		this.groups = nextGroups;
		this.markJoins = markJoins;
		nextGroups.forEach((g, i) => { if (!next[i]!.src) for (const id of g.ids) this.groupOf.set(id, g); });
		const ts2 = this.onTime ? performance.now() : 0;
		({ rows: this.rows, spans: this.spans } = withMarks(nextGroups, extents, markJoins, this.letterPx));
		if (this.onTime) this.onTime("shift.withMarks", performance.now() - ts2);
		this.counts.touchedRows += touched.size;
		// A moved copy's extent is its source's moved plus its correction, which the steps alone need not give to the last
		// bit: each is read and, where it differs, re-placed.
		if (copies.length > 0) {
			this.part = "copies.";
			let ok: boolean;
			try { ok = this.replace(strokes, copies); } finally { this.part = ""; }
			if (!ok) return this.no("shift:copy-replace", strokes, stored, steps.length);
		}
		// Every entry was just checked against `strokes`, so the next ask can hit.
		this.seen = { list: strokes, ink: inkRevision() };
		return true;
	}
}

export interface SpaceBoundary { y: number; from: number; lineHeight: number; text?: boolean; blockFallback?: boolean }

export interface SpaceProtectedBlock { from: number; to: number; frontmatter?: boolean }

/** Block context for paragraph eligibility, cached per immutable CM document.
 * Setext underlines belong to the preceding nonblank paragraph; fence bodies
 * and leading YAML are not paragraphs even when their individual lines look
 * like ordinary words. Returned line numbers are one-based and inclusive. */
export function spaceProtectedBlocks(textAt:(line:number)=>string,count:number):SpaceProtectedBlock[] {
	const blocks:SpaceProtectedBlock[]=[];
	let paragraph=0,open:{from:number;mark:string;length:number;frontmatter?:boolean}|null=null;
	for(let n=1;n<=count;n++){
		const text=textAt(n);
		if(open){
			const close=open.frontmatter?/^(?:---|\.\.\.)\s*$/.test(text):
				new RegExp(`^ {0,3}${open.mark}{${open.length},}\\s*$`).test(text);
			if(close){blocks.push({from:open.from,to:n,frontmatter:open.frontmatter});open=null;}
			continue;
		}
		if(n===1&&/^\uFEFF?---\s*$/.test(text)){open={from:n,mark:"",length:0,frontmatter:true};paragraph=0;continue;}
		const fence=/^ {0,3}(`{3,}|~{3,})/.exec(text);
		if(fence){open={from:n,mark:fence[1]![0]!,length:fence[1]!.length};paragraph=0;continue;}
		if(!text.trim()){paragraph=0;continue;}
		if(paragraph&&/^ {0,3}(?:=+|-+)\s*$/.test(text)){
			blocks.push({from:paragraph,to:n});paragraph=0;continue;
		}
		if(!paragraph)paragraph=n;
	}
	if(open)blocks.push({from:open.from,to:count,frontmatter:open.frontmatter});
	return blocks;
}

/** Internal paragraph breaks are safe between ordinary words. Keep structured
 * Markdown lines whole rather than breaking a link, code span, emphasis,
 * heading or list marker across the new paragraph. No characters are removed. */
export function canSplitParagraph(text: string, offset: number): boolean {
	if(offset<=0||offset>=text.length)return false;
	if(!/\s/.test(text[offset-1]!)&&!/\s/.test(text[offset]!))return false;
	if(/^(?: {4}|\t| {0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|~{3}))/.test(text))return false;
	return !/[`*_\\[\]<>|$]/.test(text);
}

/** Nearest eligible text seam, independent of ink group extents. The caller
 * previews whole-group membership separately instead of moving the guide. */
export function nearestSpaceBoundary(
	y: number,
	at: (y: number, direction: -1 | 1) => SpaceBoundary | null
): SpaceBoundary | null {
	const candidates: SpaceBoundary[] = [];
	for (const direction of [-1,1] as const) {
		const boundary=at(y,direction);
		if (boundary && Number.isFinite(boundary.y)) candidates.push(boundary);
	}
	return candidates.sort((a,b)=>Math.abs(a.y-y)-Math.abs(b.y-y)||b.y-a.y)[0]??null;
}

function extentOf(stroke: InkStroke): { top: number; bottom: number; left:number; right:number } {
	const pts = stroke.points;
	if (pts.length === 0) return { top: stroke.bbox.y, bottom: stroke.bbox.y + stroke.bbox.height, left:stroke.bbox.x, right:stroke.bbox.x+stroke.bbox.width };
	let top = Infinity;
	let bottom = -Infinity;
	let left = Infinity, right = -Infinity;
	for (const p of pts) {
		if (p.y < top) top = p.y;
		if (p.y > bottom) bottom = p.y;
		if (p.x < left) left = p.x;
		if (p.x > right) right = p.x;
	}
	return { top, bottom, left, right };
}

/** Existing PDF grouping: retain its globally snapped guide contract. Ordinary
 * notes opt into local groups through InsertSpaceRows instead. */
export function rowsOf(strokes: readonly InkStroke[]): InkRow[] {
	const spans = new Map<string, { left: number; right: number }>();
	for (const s of strokes) spans.set(s.id, { left: s.bbox.x, right: s.bbox.x + s.bbox.width });
	const items = strokes
		.map((s) => ({ id: s.id, ...extentOf(s) }))
		.sort((a, b) => a.top - b.top);

	const rows: InkRow[] = [];
	for (const it of items) {
		const cur = rows[rows.length - 1];
		if (cur && it.top < cur.bottom) {
			cur.ids.push(it.id);
			if (it.bottom > cur.bottom) cur.bottom = it.bottom;
			continue;
		}
		rows.push({ top: it.top, bottom: it.bottom, ids: [it.id] });
	}

	// Second pass: attach floating marks to the row they belong to.
	//
	// A dot never touches its stem and a `t` bar often clears its own row's
	// tallest letter, so overlap alone leaves them stranded as rows of their
	// own - which is exactly how a letter came apart. Such a mark is small,
	// sits directly OVER one letter of the row beneath it, and is closer to
	// that row than a line of writing would be. Two genuine rows never match
	// all three: they are the same width as each other, not a fraction of it.
	//
	// Every mark is judged against its host as the first pass left it, kept in
	// `first`, so a row that already joined does not make the host taller or
	// wider for the next one and let a chain of marks pull in a line too far.
	const first = new Map(rows.map((r) => [r, { top: r.top, bottom: r.bottom, span: xSpan(r.ids, spans), ids: [...r.ids] }]));
	const byId = new Map(items.map((it) => [it.id, it]));
	// A full stop overlaps its word, so it shares the word's row here; the marks groupsOf joins say which letter it is with.
	const marks = new Map<string, string>();
	groupsOf(items, marks);
	for (let i = rows.length - 2; i >= 0; i--) {
		const mark = rows[i]!;
		const host = rows[i + 1]!;
		const base = first.get(host)!;
		const gap = base.top - mark.bottom;
		if (gap < 0 || gap > base.bottom - base.top) continue;
		const m = first.get(mark)!.span;
		const h = base.span;
		if (m === null || h === null) continue;
		const narrow = m.right - m.left <= (h.right - h.left) * 0.34;
		const over = m.left >= h.left - 1 && m.right <= h.right + 1;
		if (!narrow || !over) continue;
		const letters = base.ids.filter((id) => !marks.has(id)).map((id) => byId.get(id)!);
		markGroupHost(mark.ids, byId, letters, marks);
		host.ids.push(...mark.ids);
		host.top = Math.min(host.top, mark.top);
		rows.splice(i, 1);
	}
	for (const r of rows) register(r, byId, marks);
	return rows;
}

function xSpan(
	ids: readonly string[],
	spans: ReadonlyMap<string, { left: number; right: number }>
): { left: number; right: number } | null {
	let left = Infinity;
	let right = -Infinity;
	for (const id of ids) {
		const s = spans.get(id);
		if (!s) continue;
		if (s.left < left) left = s.left;
		if (s.right > right) right = s.right;
	}
	return left === Infinity ? null : { left, right };
}

/**
 * Local whole handwriting groups. Two strokes join when their vertical
 * spans overlap and their horizontal gap is at most THREE times the shorter
 * stroke's height. This permits loose letter spacing, while a tall drawing
 * cannot enlarge a small word's reach to consume a distant column. Compare
 * actual constituent spans, never a growing group's union box. Touching rows
 * remain separate. Ratios use note geometry, so zoom/translation/uniform
 * scaling do not change membership. Detached marks attach in a second pass.
 * Groups in different columns may overlap vertically; they are not bands.
 */
function localRowsOf(strokes: readonly InkStroke[], letterPx?: number): {extents: Extent[]; groups: Group[]; markJoins: Map<string, string>; rows: InkRow[]; spans: {left: number; right: number}[]} {
	const extents = strokes.map((s) => ({ id: s.id, ...extentOf(s) }));
	const markJoins = new Map<string, string>();
	const groups = groupsOf(extents, markJoins);
	return {extents, groups, markJoins, ...withMarks(groups, extents, markJoins, letterPx)};
}

/** One stroke's id and the extent of its points. */
type Extent = {id: string; top: number; bottom: number; left: number; right: number};

/** A first-pass group: one component of the joins below, before floating marks attach. */
type Group = InkRow & {left: number; right: number; tallest: number};

/** The first pass of localRowsOf: components of the stroke joins, in (top, left) order.
 * Extents in store order. `joins`, when given, also receives each mark join below:
 * the mark's id to the id of the stroke it joined. */
function groupsOf(extents: readonly Extent[], joins?: Map<string, string>): Group[] {
	const items = [...extents].sort((a, b) => a.top - b.top || a.left-b.left);
	const parents=items.map((_,i)=>i);
	const root=(i:number):number=>{
		while(parents[i]!==i){parents[i]=parents[parents[i]!]!;i=parents[i]!;}
		return i;
	};
	// A mark (a full stop, a comma, a colon's dots, a dash) is too short for
	// the rule below: a tapped dot has no height, so it joined nothing and
	// Insert space left it behind its word. A stroke is a mark beside another
	// when its height is at most a quarter of the other's, its vertical span
	// lies inside the other's, and its width is at most 0.34 of the other's
	// height; it may then join across a gap of up to the larger of three of
	// its own heights and the other's height. A mark takes ONE such join, to
	// the nearest candidate (the first in sort order on a tie), so a full stop
	// between its word and a tall drawing never joins the two. A stroke that
	// joins a neighbour the ordinary way is not a mark: a letter of a word
	// passes the mark test beside a tall drawing, and would carry its word in.
	const markTo=items.map(()=>-1),markGap=items.map(()=>Infinity),joined=items.map(()=>false);
	const markJoin=(m:number,o:number,gap:number)=>{
		const mk=items[m]!,ot=items[o]!,hm=mk.bottom-mk.top,ho=ot.bottom-ot.top;
		if(!(hm<=ho/4&&mk.top>=ot.top&&mk.bottom<=ot.bottom&&mk.right-mk.left<=ho*.34&&gap<=Math.max(3*hm,ho)))return;
		if(gap<markGap[m]!||(gap===markGap[m]!&&o<markTo[m]!)){markGap[m]=gap;markTo[m]=o;}
	};
	let active:number[]=[];
	for(let i=0;i<items.length;i++){
		const a=items[i]!;
		active=active.filter(j=>items[j]!.bottom>a.top);
		for(const j of active){
			const b=items[j]!;
			if(a.bottom<=b.top)continue;
			const gap=Math.max(0,a.left-b.right,b.left-a.right);
			if(gap<=3*Math.min(a.bottom-a.top,b.bottom-b.top)){parents[root(i)]=root(j);joined[i]=joined[j]=true;}
			markJoin(i,j,gap);markJoin(j,i,gap);
		}
		active.push(i);
	}
	markTo.forEach((o,m)=>{if(o>=0&&!joined[m]){parents[root(m)]=root(o);joins?.set(items[m]!.id,items[o]!.id);}});
	const grouped=new Map<number,Group>();
	items.forEach((s,i)=>{
		const key=root(i),row=grouped.get(key);
		if(row){row.ids.push(s.id);row.top=Math.min(row.top,s.top);row.bottom=Math.max(row.bottom,s.bottom);row.left=Math.min(row.left,s.left);row.right=Math.max(row.right,s.right);row.tallest=Math.max(row.tallest,s.bottom-s.top);}
		else grouped.set(key,{top:s.top,bottom:s.bottom,left:s.left,right:s.right,tallest:s.bottom-s.top,ids:[s.id]});
	});
	return [...grouped.values()].sort((a,b)=>a.top-b.top||a.left-b.left);
}

/** The second pass of localRowsOf: floating marks onto their hosts. Groups in
 * (top, left) order; they are copied, never changed. `extents` holds every
 * grouped stroke's extent and `joins` the first pass's mark joins, for each
 * row's middles and marks (register). `letterPx` is the editor's letter
 * size: a floating group of MARK_LETTER of it or more is never a mark. */
function withMarks(groups: readonly Group[], extents: readonly Extent[], joins: ReadonlyMap<string, string>, letterPx?: number): {rows: InkRow[]; spans: {left: number; right: number}[]} {
	const byId=new Map(extents.map(e=>[e.id,e]));
	const marks=new Map(joins);
	// `g` is the row's first-pass group, the only geometry a mark or a host is
	// judged by; top, left, right and ids grow as the row takes marks, for the
	// row it reports.
	const rows=groups.map((g,ord)=>({g,ord,top:g.top,left:g.left,right:g.right,ids:[...g.ids]}));
	// A floating mark chooses the nearest eligible LOCAL host below it,
	// regardless of interleaved groups in another column. The height-relative
	// width/overhang allowance also handles a dot above a lone vertical stem.
	//
	// A host is judged by its own group, never by the marks it has taken. A
	// host judged grown was taller and wider after every mark, which made the
	// next row above it a mark too: on a heavy page one low wide drawing took
	// row after row up the page, and a note of 19,736 strokes became one row
	// from near its top to near its bottom, so a divider anywhere moved or
	// kept that whole row. Judged by its own group, a host takes only what
	// lies within its own height above its own top.
	//
	// A host starts at or below the mark (gap >= 0) and no further below it
	// than its own height, so only rows whose top lies within the tallest
	// group's height under the mark can qualify. `byTop` keeps the live rows
	// ordered by their group's top, so each mark checks that window instead
	// of every row: the all-rows filter per mark was quadratic, 30-80 ms on a
	// note of one to two thousand written lines, after every ink change. The
	// choice is the one the filter-and-sort made: nearest gap, then centre
	// offset, then left, then the earlier row (`ord`, the stable sort's tie).
	const byTop=[...rows];
	const firstFrom=(y:number)=>{
		let lo=0,hi=byTop.length;
		while(lo<hi){const mid=(lo+hi)>>1;if(byTop[mid]!.g.top<y)lo=mid+1;else hi=mid;}
		return lo;
	};
	let tallest=0;
	for(const {g} of rows)tallest=Math.max(tallest,g.bottom-g.top);
	// A mark is small against the editor's letters as well as against its host: a label of letter height written above a
	// drawing is the drawing's ratio of a dot, and was taken as one. A floating group of MARK_LETTER of the editor's letter
	// size or more is never a mark. With no letter size handed in (PDF rows, rows built by hand) the ratio rule decides alone.
	for(const mark of [...rows].reverse()){
		const m=mark.g;
		if(letterPx!==undefined && m.bottom-m.top>=letterPx*MARK_LETTER)continue;
		let host:(typeof rows)[number]|null=null;
		for(let i=firstFrom(m.bottom);i<byTop.length;i++){
			const cand=byTop[i]!,c=cand.g;
			if(c.top-m.bottom>tallest)break;
			if(cand===mark)continue;
			const height=c.bottom-c.top,gap=c.top-m.bottom;
			if(!(height>0 && gap>=0 && gap<=height && m.bottom-m.top<=height*.34 &&
				m.right-m.left<=Math.max(c.right-c.left,height*.25)*.34 &&
				m.left>=c.left-height*.1 && m.right<=c.right+height*.1))continue;
			if(host){
				const h=host.g;
				const order=(c.top-m.bottom)-(h.top-m.bottom)||
					Math.abs(c.left+c.right-m.left-m.right)-Math.abs(h.left+h.right-m.left-m.right)||
					c.left-h.left||cand.ord-host.ord;
				if(!(order<0))continue;
			}
			host=cand;
		}
		if(!host)continue;
		const letters=host.g.ids.filter(id=>!marks.has(id)).map(id=>byId.get(id)!);
		markGroupHost(mark.ids,byId,letters,marks);
		host.ids.push(...mark.ids);host.top=mark.top;
		host.left=Math.min(host.left,mark.left);host.right=Math.max(host.right,mark.right);
		// Drop the mark, which has no other place to be and hosts nothing now.
		byTop.splice(byTop.indexOf(mark),1);
	}
	byTop.sort((a,b)=>a.top-b.top||a.left-b.left||a.ord-b.ord);
	return {rows:byTop.map(({top,g,ids})=>register({top,bottom:g.bottom,ids},byId,marks)),spans:byTop.map(({left,right})=>({left,right}))};
}

/**
 * Nearest group edge, for callers needing a snapped position. Local groups
 * may overlap, so consider all crossing edges. Insert Space membership must
 * NOT use this global position: it judges each group at the original guide.
 */
export function snapLine(rows: readonly InkRow[], lineY: number): number {
	return rows.filter(row=>lineY>row.top&&lineY<row.bottom).flatMap(row=>[row.top,row.bottom])
		.sort((a,b)=>Math.abs(a-lineY)-Math.abs(b-lineY)||b-a)[0]??lineY;
}

/**
 * Which strokes an insert-space divider at world y moves, in store order.
 *
 * Each group uses the ORIGINAL line. Groups wholly below move whole. A group
 * the line crosses splits stroke by stroke: a stroke moves when its own middle
 * is below the line, a middle on the line staying, and a mark goes with the
 * stroke it belongs to (see splits), so a dot or a full stop never leaves its
 * letter. One column's crossing group must never move the cut used by another
 * column.
 * Ink attached to text (`groups`, InkAttachments.insertSpaceMembers) moves whole with its target's first line or not at all.
 */
export function strokeIdsBelow(strokes: readonly InkStroke[], lineY: number, rows: readonly InkRow[] = rowsOf(strokes), groups?: { move: ReadonlySet<string>; hold: ReadonlySet<string> }): string[] {
	const moving = new Set<string>();
	let own: Map<string, number> | null = null;
	for (const row of rows) {
		const side = sideOf(row, lineY);
		if (side === "under") for (const id of row.ids) moving.add(id);
		if (side !== "crossed") continue;
		const split = splits.get(row);
		let mids = split?.mids;
		if (mids === undefined || mids.length !== row.ids.length) {
			// A row built by hand: the middles from the strokes themselves, and no marks.
			own ??= new Map(strokes.map((s) => { const e = extentOf(s); return [s.id, (e.top + e.bottom) / 2]; }));
			const at = own;
			mids = row.ids.map((id) => at.get(id) ?? NaN);
		}
		for (const id of crossedMoving(row, mids, split?.marks, lineY)) moving.add(id);
	}
	if (groups) {
		for (const id of groups.hold) moving.delete(id);
		for (const id of groups.move) moving.add(id);
	}
	// Store order, so z-order and the op's id list stay in the store's terms.
	return strokes.filter((s) => moving.has(s.id)).map((s) => s.id);
}

/** Where a row lies against a divider at world y: wholly below it, crossed by it, or wholly above it. */
function sideOf(row: InkRow, lineY: number): "under" | "crossed" | "over" {
	return row.top >= lineY ? "under" : lineY < row.bottom ? "crossed" : "over";
}

/** The strokes of a crossed row that move: each stroke's middle (its letter's, for a mark) below the line. */
function crossedMoving(row: InkRow, mids: readonly number[], marks: ReadonlyMap<string, string> | undefined, lineY: number): string[] {
	const at = new Map(row.ids.map((id, i) => [id, mids[i]!]));
	return row.ids.filter((id) => at.get(marks?.get(id) ?? id)! > lineY);
}

/**
 * Whether dividers at world y `a` and `b` move and keep the same strokes, so strokeIdsBelow and the staying list (a
 * crossed row's strokes that do not move) are the same at both. Every row lies on the same side of both lines, and in a
 * row both lines cross no stroke's middle lies between them (a mark goes with its letter, so only letters count). A
 * crossed row without middles is never the same.
 */
export function sameRowSides(rows: readonly InkRow[], a: number, b: number): boolean {
	if (a === b) return true;
	for (const row of rows) {
		const side = sideOf(row, a);
		if (side !== sideOf(row, b)) return false;
		if (side !== "crossed") continue;
		const split = splits.get(row);
		if (split === undefined || split.mids.length !== row.ids.length) return false;
		const mids = split.mids;
		for (let i = 0; i < mids.length; i++) {
			if (split.marks.has(row.ids[i]!)) continue;
			if ((mids[i]! > a) !== (mids[i]! > b)) return false;
		}
	}
	return true;
}

/** The union box of the named strokes, or null when none are named. */
export function boundsOf(strokes: readonly InkStroke[], ids: readonly string[]): BBox | null {
	const wanted = new Set(ids);
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let found = false;
	for (const s of strokes) {
		if (!wanted.has(s.id)) continue;
		found = true;
		const b = s.bbox;
		if (b.x < minX) minX = b.x;
		if (b.y < minY) minY = b.y;
		if (b.x + b.width > maxX) maxX = b.x + b.width;
		if (b.y + b.height > maxY) maxY = b.y + b.height;
	}
	if (!found) return null;
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The region a vertical shift of `dy` dirties: where the ink was, plus
 * where it lands, as ONE rect.
 *
 * Marking the whole page dirty per frame re-rasterized every stroke in the
 * note and the drag went visibly jagged on a full page. The moved ink is a
 * contiguous band travelling straight down, so its swept region is exactly
 * one rectangle - the shape the damage ledger is cheapest at, and the one
 * the lasso drag has always used.
 */
export function sweptRect(bounds: BBox, dy: number): BBox {
	return {
		x: bounds.x,
		y: dy < 0 ? bounds.y + dy : bounds.y,
		width: bounds.width,
		height: bounds.height + Math.abs(dy),
	};
}

/**
 * How many text lines a vertical shift is worth.
 *
 * Ink is world-anchored and text is not, so the two only stay aligned if
 * the ink lands on a whole number of line heights: the drag runs smooth,
 * and the release quantizes to the nearest line. Half a line of slack at
 * the end is invisible next to text and ink disagreeing forever.
 */
export function lineSteps(dyNote: number, lineHeightNote: number): number {
	if (!(lineHeightNote > 0)) return 0;
	return Math.round(dyNote / lineHeightNote);
}

/**
 * How many blank lines directly above `lineNumber` (1-based) may be taken
 * back, capped at `want`.
 *
 * Closing a gap must never eat writing. Dragging up removes only the empty
 * lines a previous insert-space put there; the moment a line has anything
 * on it the removal stops, and the ink simply moves further than the text
 * does - wrong by a line, where deleting a sentence would be unforgivable.
 */
export function blankLinesAbove(
	textAt: (lineNumber: number) => string,
	lineNumber: number,
	want: number
): number {
	// A reader rather than an array: the caller has a document, and
	// materializing every line of it to look at the handful directly above
	// the divider is work proportional to the whole note for an answer
	// bounded by `want`.
	let n = 0;
	let i = lineNumber - 1; // 1-based number of the line above
	while (n < want && i >= 1 && textAt(i).trim() === "") {
		n++;
		i--;
	}
	return n;
}
