/**
 * Ink attached to text, followed: the group map, the reference cache and the read cap.
 *
 * A group's ink is shown at its stored points plus one correction, the reference point now minus the stored one
 * (followOffset). This keeps the reference point now for each group, in world units, and answers each member stroke's
 * correction. Membership wins: a member's own line anchor is not read while it is in a group.
 *
 * Where the reference point now comes from:
 *  - A document change: the group's cached point moves down by its target line block's top delta, read from the height
 *    map, which CodeMirror allows inside an update. Typing above a group moves it at once, by whole lines.
 *  - A measure (outside an update): the visual line holding the target's first character is read through the layout,
 *    which gives x and the wrapped row's y. At most GROUP_READS_PER_MEASURE groups are read per measure; a target outside
 *    the view is not read. A read is kept for the layout epoch; a layout change marks every group for a new read, and
 *    the last correction holds until it comes.
 *  - Attach and Change attachment: the record's own point, read where the ink is shown, so nothing moves.
 * A group with no point yet is pending and is not painted: never shown at a place it is about to leave. A group whose
 * target needs reattachment is never read: it holds its last correction, or the one its record kept from the text change
 * that last moved it (a reopen), or shows its stored points when it has neither. A text change that moves a group keeps
 * its correction on its record, so the page written for that edit holds it.
 *
 * Nothing here reads the DOM or writes a stroke point. No point settles at a page write (settledRecord has no caller):
 * the store keeps the points a group was attached at, and every surface shows it at those plus a correction. An export
 * takes a group this pane has not read yet at the correction its record kept, as a held group is shown, moved by the
 * text changes above it in this pane since a measure seeded it; its record keeps that correction too.
 */
import type { ChangeDesc } from "@codemirror/state";
import type { BBox, InkStroke } from "../ink/Stroke";
import { strokeRev } from "../ink/StrokeRev";
import type { ReachBox } from "./FrontierCache";
import { reshift, shiftedStroke } from "./LineAnchor";
import {
	applyAttachStep,
	ATTACHMENT_CONTEXT,
	followOffset,
	isOpaqueAttachment,
	mapAttachments,
	mapTarget,
	refreshTarget,
	resolveTarget,
	type AttachmentData,
	type AttachmentRecord,
	type AttachmentStatus,
	type AttachmentTarget,
	type AttachStep,
} from "./InkAttachments";

/** The most groups whose reference point one measure reads through the layout. */
export const GROUP_READS_PER_MEASURE = 8;
/**
 * Corrections closer than this to 0, world units, are 0: a record holds its point to two places, so a read in the
 * record's own layout lands within 0.005 of it and must not shift every member by float noise.
 */
export const SAME_PLACE = 0.006;

export interface FollowOffset {
	dx: number;
	dy: number;
}

/** What a measure reads of the editor. Called outside an update only. */
export interface FollowMeasure {
	/** Whether `pos` is inside the drawn viewport. No layout read. */
	inView(pos: number): boolean;
	/** World top-left of the visual line holding `pos`; null when it is not laid out. A layout read. */
	refAt(pos: number): { x: number; y: number } | null;
	/** Editor-px top of the line block holding `pos`, from the height map. */
	blockTop(pos: number): number;
	/** As blockTop, for the block below a change's lines; blockTop when unset. */
	changedBlockTop?(pos: number): number;
}

/** This pane's text, as much of it as a held group's check reads: its length and a slice. */
export interface FollowText {
	readonly length: number;
	sliceString(from: number, to: number): string;
}

/** No collapsed document: a held group's check reads its own offsets only and never searches the text. */
const NO_SEARCH = { flat: "", starts: [], ends: [] };

/** A follow's epoch while a change's doubt over it waits for the next measure. */
const DOUBT = -2;

/** The groups below a change's lines, unread until the next measure judges them. */
interface Doubt {
	/** The layout epoch the change came in; a newer one reads every group anyway. */
	epoch: number;
	/** The nearest group target below the changed lines, and its line block's top before the change. */
	pos: number;
	top: number;
	ids: string[];
}

interface Follow {
	/** The reference point now, world units; null until the first read: the group is pending. */
	ref: { x: number; y: number } | null;
	/** Editor-px top of the target's line block when `ref` was set or last moved. */
	blockTop: number;
	/** The layout epoch `ref` was read in. Older: the next measure reads it again, and the last correction holds. */
	epoch: number;
	/** The correction shown, or null while pending. */
	offset: FollowOffset | null;
}

/**
 * A group this pane has not read yet, for an export: the correction it would show, seeded from its record's kept one at
 * a measure and moved by its target block's top change at each text change, and the top it was last moved from.
 */
interface Unread {
	/** Editor-px top of the target's line block at the seed or the last move. */
	base: number;
	/**
	 * The layout epoch of the seed or the last carry. At a newer one the entry keeps its correction and takes the block's
	 * top now as its base: a layout change alone (a scroll's measured heights) moves no unread group.
	 */
	epoch: number;
	offset: FollowOffset;
	/** The record's kept correction this entry last agreed with: another, stamped by another pane, seeds the entry again. */
	from: FollowOffset;
}

const ZERO: FollowOffset = Object.freeze({ dx: 0, dy: 0 });

/** Moves an unread entry by its block's top change since its base, `px` editor px per world unit; true when it moved. */
function carryUnread(u: Unread, top: number, px: number): boolean {
	if (!Number.isFinite(top) || top === u.base) return false;
	const dy = u.offset.dy + (top - u.base) / px;
	u.base = top;
	u.offset = Math.abs(dy) < SAME_PLACE && u.offset.dx === 0 ? ZERO : { dx: u.offset.dx, dy: Math.abs(dy) < SAME_PLACE ? 0 : dy };
	return true;
}

/** Each group's correction at one moment, and the membership it was taken under: the old side of a move (movesSince). */
export interface FollowSnapshot {
	readonly members: ReadonlyMap<string, string>;
	readonly offsets: ReadonlyMap<string, FollowOffset | null>;
}

/** A member a correction moved: the object this surface showed it as before (what the index and the canvas hold), and now. */
export interface FollowMove {
	old: InkStroke;
	now: InkStroke;
}

/**
 * A group's told move between two corrections, neither 0: its id, the offset then and now, its member ids,
 * its members' box then and now, and its shown copies, each moved in place to the new offset (reshift): the objects the
 * index and every list already hold. No per-member pair and no new copy.
 */
export interface FollowGroupMove {
	id: string;
	was: FollowOffset;
	now: FollowOffset;
	ids: readonly string[];
	before: BBox;
	after: BBox;
	shown: readonly InkStroke[];
	/** Each copy's box before the move, index for index with `shown`: where the index holds it. */
	boxesBefore: readonly BBox[];
}

const isZero = (o: FollowOffset): boolean => o === ZERO || (o.dx === 0 && o.dy === 0);

function offsetFrom(record: AttachmentRecord, ref: { x: number; y: number } | null): FollowOffset | null {
	const o = followOffset(record, ref);
	if (!o) return null;
	const dx = Math.abs(o.dx) < SAME_PLACE ? 0 : o.dx, dy = Math.abs(o.dy) < SAME_PLACE ? 0 : o.dy;
	return dx === 0 && dy === 0 ? ZERO : { dx, dy };
}

const sameOffset = (a: FollowOffset | null, b: FollowOffset | null): boolean =>
	a === b || (a !== null && b !== null && a.dx === b.dx && a.dy === b.dy);

/** A target with no text left (its text deleted): it needs reattachment and is never read. */
const collapsed = (r: AttachmentRecord): boolean => r.target.to <= r.target.from;

export class AttachFollow {
	private list: readonly AttachmentData[] = [];
	private records = new Map<string, AttachmentRecord>();
	/** Stroke id to group id. */
	private members = new Map<string, string>();
	private follows = new Map<string, Follow>();
	/** Groups whose target needs reattachment: never read, nothing moves. */
	private holds = new Set<string>();
	/** Each held group's record before the list last changed it: the one an Attach that ends the hold replaces. */
	private heldBefore = new Map<string, AttachmentRecord>();
	/**
	 * Groups an Attach took off hold: the record that was held and the one the Attach made. The undo of that Attach puts
	 * the held record back, and its hold with it; the redo puts the Attach's record back and ends the hold again.
	 */
	private lifted = new Map<string, { held: AttachmentRecord; attached: AttachmentRecord }>();
	/**
	 * Each record the list let go of (a Detach, the undo of an Attach, here or in another pane), mapped through every text
	 * change since, as the lifted records are: where the undo that puts it back finds its words first (putBack).
	 */
	private letGo = new Map<string, AttachmentRecord>();
	/**
	 * Groups held because their record, new to this pane, did not stand in its text when the list came (setList). The
	 * writer shares its list before this pane hears the change, so that text can be one change behind: each is checked
	 * again at this pane's own next text change (recheckNew). A list with a status, or a change to the record, ends it.
	 */
	private heldNew = new Set<string>();
	/** This pane's text now, for a held group's check against it; unset on a surface with no editor, which checks none. */
	paneText: (() => FollowText | null) | null = null;
	private layoutEpoch = 0;
	/** A document change moved a group's correction since the last takeEdited: a real edit, the page may be written. */
	private edited = false;
	/** Bumped whenever any correction this answers changes: the key for shown copies and lists. */
	generation = 0;
	private copies = new WeakMap<InkStroke, { dx: number; dy: number; rev: number; copy: InkStroke }>();
	/** Groups whose record left the list (a Detach), with their last read: an undo puts them back where they were. */
	private released = new Map<string, { record: AttachmentRecord; follow: Follow }>();
	/** The ids whose membership changed since takeMembershipChanges last read them. */
	private changedIds = new Set<string>();
	/** Each member's store stroke as shown() last answered it, by id: the stroke whose shown copy the surface holds. */
	private seen = new Map<string, InkStroke>();
	/** Each pending member's store stroke as shown() was last asked for it, by id: a first read inserts it. */
	private asked = new Map<string, InkStroke>();
	/** Each group's member box at stored points, per members map: freeFor gives a new map whenever ink or membership changes. */
	private storedBoxes = new WeakMap<object, Map<string, ReachBox>>();
	/** Groups a change left unread below its lines, judged at the next measure. */
	private doubt: Doubt | null = null;
	/**
	 * Groups not read here yet (pending, not painted): the correction an export takes, moved by text changes above them
	 * in this pane. Dropped at the first read, on hold, and when the record changes other than its kept correction.
	 */
	private unreadAt = new Map<string, Unread>();
	/**
	 * Editor px per world unit and layout epoch at the last change that mapped the list: a measure in that epoch or the next
	 * reads the change's lines as drawn (a keystroke keeps a line's old height, a split line starts at an estimate), so the
	 * move it finds for an unread group is the change's and is carried, whether it comes before or after the layout change
	 * it brings. A measure two or more epochs later carries nothing.
	 */
	private unreadSettle: { px: number; epoch: number } | null = null;
	/** Counters: groups read through the layout, and changed-line blocks measured instead. */
	readonly counts = { groupsMeasured: 0, blocksMeasured: 0 };
	/** Member pairs built for a told move (0 between two corrections), groups and copies moved in place. */
	readonly moveCounts = { pairs: 0, groups: 0, copies: 0 };
	/** Rig only: told of the unseen first read's parts, its members as stored and their shown copies. */
	onTime: ((part: string, ms: number) => void) | null = null;
	/** First-read lookups answered from a kept map, maps built, and (rig only) whether freeFor held. */
	readonly storedCounts = { hits: 0, builds: 0, freeHeld: 0, freeMiss: 0 };
	/**
	 * Each null movesAndFirsts returns, by its reason, and each membership rebuild in setList whose groups
	 * held the same ids in new strokeIds arrays.
	 */
	readonly nullCounts = { members: 0, offsetMissing: 0, firstNotAsked: 0, firstNotShown: 0, copyMismatch: 0, shownMissing: 0, noneSeen: 0, pendingEnd: 0, rebuildSameIds: 0, unseenFirst: 0 };

	/** The ids whose group changed (joined, left or moved group) since the last call; the set starts empty again. */
	takeMembershipChanges(): ReadonlySet<string> {
		const out = this.changedIds;
		this.changedIds = new Set();
		return out;
	}

	/** The records followed now. */
	get attachments(): readonly AttachmentData[] {
		return this.list;
	}

	/**
	 * The note's records, and the groups whose target needs reattachment. Membership is rebuilt only when a group's
	 * members change; a record whose target moved is read again at the next measure, its last correction held meanwhile.
	 */
	setList(list: readonly AttachmentData[], status?: ReadonlyMap<string, AttachmentStatus>): void {
		if (status) {
			const holds = new Set<string>();
			for (const [id, s] of status) if (s === "needs-reattachment") holds.add(id);
			this.holds = holds;
			this.heldNew.clear();
		}
		if (list === this.list) {
			if (status) {
				for (const id of this.holds) this.unreadAt.delete(id);
				this.recompute();
			}
			return;
		}
		const prev = this.records, records = new Map<string, AttachmentRecord>();
		let rebuild = false;
		for (const a of list) {
			if (isOpaqueAttachment(a)) continue;
			records.set(a.id, a);
			this.letGo.delete(a.id);
			const p = prev.get(a.id);
			if (!p || p.strokeIds !== a.strokeIds) rebuild = true;
			// A record new here with no status (put back in another pane) whose words do not stand in this pane's text is
			// held: nothing shown here moves for it. This text may lag the list by one change: checked again (heldNew).
			if (!p && !status && !collapsed(a) && this.paneText?.() && !this.standsHere(a)) {
				this.holds.add(a.id);
				this.heldNew.add(a.id);
			}
			if (p && p !== a) {
				this.heldNew.delete(a.id);
				if (this.holds.has(a.id)) this.heldBefore.set(a.id, p);
				// A list with a status is the fresh truth: an Attach's records, kept for its undo, never override it.
				const l = status ? undefined : this.lifted.get(a.id);
				if (l && sameValue(unkept(a), unkept(l.held))) this.holds.add(a.id);
				else if (l && sameValue(unkept(a), unkept(l.attached))) this.holds.delete(a.id);
				// A held group whose record changed, whoever sent the list (an Attach in another pane): its hold follows this
				// pane's text, and ends when the record's words stand where it says. Its undo puts the hold back, as here.
				if (!status && this.holds.has(a.id) && this.standsHere(a)) {
					this.holds.delete(a.id);
					if (!l) this.lifted.set(a.id, { held: p, attached: a });
				}
			}
			const f = this.follows.get(a.id);
			if (f && p && p.target.from !== a.target.from) f.epoch = -1;
			if (p && p !== a && this.unreadAt.has(a.id) && !sameValue(unkept(p), unkept(a))) this.unreadAt.delete(a.id);
		}
		for (const id of this.unreadAt.keys()) if (!records.has(id) || this.holds.has(id)) this.unreadAt.delete(id);
		if (records.size !== prev.size) rebuild = true;
		for (const [id, r] of prev) {
			if (records.has(id)) continue;
			this.letGo.set(id, r);
			this.heldNew.delete(id);
		}
		for (const [id, f] of this.follows) {
			if (records.has(id)) continue;
			const r = prev.get(id);
			if (r) this.released.set(id, { record: r, follow: f });
			this.follows.delete(id);
		}
		this.list = list;
		this.records = records;
		if (rebuild) {
			if (records.size === prev.size) {
				let same = true;
				for (const [id, r] of records) {
					const p = prev.get(id);
					if (!p || p.strokeIds.length !== r.strokeIds.length || p.strokeIds.some((s, i) => s !== r.strokeIds[i])) { same = false; break; }
				}
				if (same) this.nullCounts.rebuildSameIds++;
			}
			const members = new Map<string, string>(), old = this.members, changed = this.changedIds;
			for (const r of records.values()) for (const id of r.strokeIds) members.set(id, r.id);
			// The ids whose group changed, for the free list's patch: two lookups per member.
			for (const [id, g] of old) if (members.get(id) !== g) changed.add(id);
			for (const [id, g] of members) if (old.get(id) !== g) changed.add(id);
			this.members = members;
			this.generation++;
		}
		this.recompute();
	}

	/**
	 * Whether a record's words and their context stand at its own offsets in this pane's text now. Reads a slice around the
	 * target, never the whole text, and searches nowhere else: false with no text to read.
	 */
	private standsHere(r: AttachmentRecord): boolean {
		const doc = this.paneText?.(), t = r.target;
		if (!doc || collapsed(r) || t.to > doc.length) return false;
		const lo = Math.max(0, t.from - ATTACHMENT_CONTEXT), near = { ...t, from: t.from - lo, to: t.to - lo };
		return resolveTarget(near, doc.sliceString(lo, Math.min(doc.length, t.to + ATTACHMENT_CONTEXT)), () => NO_SEARCH) === near;
	}

	/** The group a stroke belongs to, or undefined. */
	groupOf(strokeId: string): string | undefined {
		return this.members.get(strokeId);
	}

	/** Stroke id to group id: the same object until membership changes. */
	get memberMap(): ReadonlyMap<string, string> {
		return this.members;
	}

	/** The records followed now, by group. */
	groups(): IterableIterator<AttachmentRecord> {
		return this.records.values();
	}

	/** Whether any stroke is in a readable group. */
	get any(): boolean {
		return this.members.size > 0;
	}

	/**
	 * Whether a group this pane can read has no read here yet: a record with no follow, pending, left out of the paint
	 * until a measure reads it. A group that needs reattachment or whose target was deleted is never read, so never counts.
	 */
	get unread(): boolean {
		for (const r of this.records.values()) if (!this.follows.has(r.id) && !this.holds.has(r.id) && !collapsed(r)) return true;
		return false;
	}

	/**
	 * The correction a stroke is shown at: undefined for a stroke in no group (its own line anchor applies), null for a
	 * member of a pending group (not painted), else the group's.
	 */
	offsetOf(strokeId: string): FollowOffset | null | undefined {
		if (this.members.size === 0) return undefined;
		const id = this.members.get(strokeId);
		return id === undefined ? undefined : this.groupOffset(id);
	}

	/** Whether a stroke is a member shown away from its stored points, or pending (not painted). */
	moves(strokeId: string): boolean {
		if (this.members.size === 0) return false;
		const o = this.offsetOf(strokeId);
		return o === null || (o !== undefined && o !== ZERO);
	}

	/**
	 * A stroke as this surface shows it when it is a member: the store's own object at no correction, a copy moved by
	 * the group's correction (made once per correction and stroke change), null while pending. Undefined for a stroke in
	 * no group.
	 */
	shown(s: InkStroke): InkStroke | null | undefined {
		if (this.members.size === 0) return undefined;
		const o = this.offsetOf(s.id);
		if (o === null) this.asked.set(s.id, s);
		if (o === undefined || o === null) return o;
		this.seen.set(s.id, s);
		if (o === ZERO) return s;
		const rev = strokeRev(s), c = this.copies.get(s);
		if (c && c.dx === o.dx && c.dy === o.dy && c.rev === rev) return c.copy;
		const copy = shiftedStroke(s, o.dy, o.dx);
		this.copies.set(s, { dx: o.dx, dy: o.dy, rev, copy });
		return copy;
	}

	/** A group's correction: null while pending. */
	groupOffset(id: string): FollowOffset | null {
		const f = this.follows.get(id);
		if (f?.offset) return f.offset;
		const r = this.records.get(id);
		return this.holds.has(id) || (r && collapsed(r)) ? r?.shown ?? ZERO : null;
	}

	/**
	 * A stroke for an export: a member where this surface shows it; a member of a group not read here yet (pending, not
	 * painted) at the correction its record kept, as a held group is shown; a free stroke as stored.
	 */
	exported(s: InkStroke): InkStroke {
		const v = this.shown(s);
		if (v !== null) return v ?? s;
		const id = this.members.get(s.id);
		if (id === undefined) return s;
		// An entry from before another pane's stamp is old: the stamp is taken until the next measure reseeds it.
		const u = this.unreadAt.get(id), kept = this.records.get(id)?.shown;
		return keptShown(s, u && sameOffset(u.from, kept ?? ZERO) ? u.offset : kept);
	}

	/**
	 * Each shown group's box where this surface shows it: the union of its members' boxes at
	 * stored points, kept per `members` (freeFor's map, group id to members as stored), plus the group's correction. A
	 * pending group is left out, as its members are of the shown list. About one box per group: the extent's frontier
	 * merges these with free ink's, and a follow never walks the note.
	 */
	shownBoxes(members: ReadonlyMap<string, readonly InkStroke[]>): ReachBox[] {
		let stored = this.storedBoxes.get(members);
		if (!stored) {
			stored = new Map();
			for (const [id, list] of members) {
				let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
				for (const s of list) {
					const b = s.bbox;
					if (b.x < x) x = b.x;
					if (b.y < y) y = b.y;
					if (b.x + b.width > right) right = b.x + b.width;
					if (b.y + b.height > bottom) bottom = b.y + b.height;
				}
				if (right >= x && bottom >= y) stored.set(id, { x, y, right, bottom });
			}
			this.storedBoxes.set(members, stored);
		}
		const out: ReachBox[] = [];
		for (const [id, b] of stored) {
			const o = this.groupOffset(id);
			if (!o) continue;
			out.push(o.dx === 0 && o.dy === 0 ? b : { x: b.x + o.dx, y: b.y + o.dy, right: b.right + o.dx, bottom: b.bottom + o.dy });
		}
		return out;
	}

	/** Each group's correction now: taken before a document change or a measure, for movesSince. */
	snapshot(): FollowSnapshot {
		const offsets = new Map<string, FollowOffset | null>();
		for (const id of this.records.keys()) offsets.set(id, this.groupOffset(id));
		return { members: this.members, offsets };
	}

	/**
	 * The groups whose correction changed since `before`. A move between two corrections, neither 0, is told per group
	 * (`groups`): its box then and now, its shown copies moved in place. A move from or to 0 changes which
	 * object the surface shows (the store's own or a copy), so it goes per member (`moves`): each member's shown object then
	 * and now. Null when a move cannot be told exactly, and the caller repaints whole: membership changed, a group was
	 * pending then or is pending now (a first read: it was never painted), or a member's old shown object is not known
	 * (the stroke changed since it was shown), or no member of a moved group was ever shown. A member id with no stroke
	 * shown (a dangling id) is passed over.
	 */
	movesSince(before: FollowSnapshot): { moves: FollowMove[][]; groups: FollowGroupMove[] } | null {
		const step = this.movesAndFirsts(before, false);
		return step ? { moves: step.moves, groups: step.groups } : null;
	}

	/**
	 * movesSince, and the first reads apart: a group pending then and read now, each member's store stroke as
	 * shown() was asked for it while pending (never painted, not in the index) and its shown object now. Null as
	 * movesSince is, and when a first-read member was never asked for.
	 *
	 * A moved group none of whose members was ever shown here (the surface took the store's own list while
	 * every correction was 0, so shown() was never asked) is a first read too, when `stored` gives its members as stored:
	 * nothing of it was painted at a correction, so each member goes as its store stroke and its shown object now.
	 * `stored` finds a member's store stroke by id (a lookup kept per store list, never a walk of the note).
	 */
	movesAndFirsts(before: FollowSnapshot, firsts = true, stored?: (id: string) => InkStroke | undefined): { moves: FollowMove[][]; groups: FollowGroupMove[]; firsts: FollowMove[][] } | null {
		if (before.members !== this.members) return this.nul("members");
		const out: FollowMove[][] = [], first: FollowMove[][] = [], groups: FollowGroupMove[] = [];
		for (const r of this.records.values()) {
			if (!before.offsets.has(r.id)) return this.nul("offsetMissing");
			const was = before.offsets.get(r.id)!, now = this.groupOffset(r.id);
			if (sameOffset(was, now)) continue;
			if (firsts && was === null && now !== null) {
				const reads: FollowMove[] = [];
				for (const id of r.strokeIds) {
					const s = this.asked.get(id);
					if (this.members.get(id) !== r.id) continue;
					if (!s) return this.nul("firstNotAsked");
					const shown = this.shown(s);
					if (!shown) return this.nul("firstNotShown");
					reads.push({ old: s, now: shown });
				}
				if (reads.length > 0) first.push(reads);
				continue;
			}
			if (was === null || now === null) return this.nul("pendingEnd");
			const moves: FollowMove[] = [];
			if (!isZero(was) && !isZero(now)) {
				// Told per group: each member's copy at `was` moves in place to `now` and stays the copy.
				let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
				const shown: InkStroke[] = [], boxes: BBox[] = [];
				for (const id of r.strokeIds) {
					const s = this.seen.get(id);
					if (!s || this.members.get(id) !== r.id) continue;
					const c = this.copies.get(s);
					if (!c || c.dx !== was.dx || c.dy !== was.dy || c.rev !== strokeRev(s)) return this.nul("copyMismatch");
					const old = c.copy.bbox;
					if (!reshift(c.copy, now.dy, now.dx)) return this.nul("copyMismatch");
					c.dx = now.dx;
					c.dy = now.dy;
					const b = s.bbox;
					if (b.x < x) x = b.x;
					if (b.y < y) y = b.y;
					if (b.x + b.width > right) right = b.x + b.width;
					if (b.y + b.height > bottom) bottom = b.y + b.height;
					shown.push(c.copy);
					boxes.push(old);
				}
				if (shown.length > 0) {
					this.moveCounts.groups++;
					this.moveCounts.copies += shown.length;
					const w = right - x, h = bottom - y;
					groups.push({ id: r.id, was, now, ids: r.strokeIds, before: { x: x + was.dx, y: y + was.dy, width: w, height: h }, after: { x: x + now.dx, y: y + now.dy, width: w, height: h }, shown, boxesBefore: boxes });
					continue;
				}
			} else {
				for (const id of r.strokeIds) {
					const s = this.seen.get(id);
					if (!s || this.members.get(id) !== r.id) continue;
					let old: InkStroke;
					if (isZero(was)) old = s;
					else {
						const c = this.copies.get(s);
						if (!c || c.dx !== was.dx || c.dy !== was.dy || c.rev !== strokeRev(s)) return this.nul("copyMismatch");
						old = c.copy;
					}
					const shown = this.shown(s);
					if (!shown) return this.nul("shownMissing");
					moves.push({ old, now: shown });
				}
				this.moveCounts.pairs += moves.length;
			}
			// No member of a moved group was ever shown here: a first read, from the members as stored, or else unknown.
			if (moves.length === 0 && r.strokeIds.length > 0) {
				if (!firsts || !stored) return this.nul("noneSeen");
				const t0 = this.onTime ? performance.now() : 0;
				const ms: InkStroke[] = [];
				for (const id of r.strokeIds) {
					const s = stored(id);
					if (s && this.members.get(id) === r.id) ms.push(s);
				}
				const t1 = this.onTime ? performance.now() : 0;
				if (ms.length === 0) return this.nul("noneSeen");
				const reads: FollowMove[] = [];
				for (const s of ms) {
					const shown = this.shown(s);
					if (!shown) return this.nul("shownMissing");
					reads.push({ old: s, now: shown });
				}
				if (this.onTime) { this.onTime("first.stored", t1 - t0); this.onTime("first.shown", performance.now() - t1); }
				this.nullCounts.unseenFirst++;
				first.push(reads);
				continue;
			}
			if (moves.length > 0) out.push(moves);
		}
		return { moves: out, groups, firsts: first };
	}

	/** movesAndFirsts' null, counted by its reason. */
	private nul(why: Exclude<keyof AttachFollow["nullCounts"], "rebuildSameIds" | "unseenFirst">): null {
		this.nullCounts[why]++;
		return null;
	}

	/** Whether a text change moves this group: not when its target needs reattachment or was deleted. */
	followsText(id: string): boolean {
		const r = this.records.get(id);
		return !!r && !this.holds.has(id) && !collapsed(r);
	}

	/**
	 * A document change, in the update. The records are mapped through it; a group whose target moved is moved down by
	 * its target block's top delta (height map only) and read again at the next measure. Returns the mapped list, the
	 * same object when no target moved. A target past the end of the text before the change (a stale record kept for
	 * reattachment) is first brought to that end, as mapping past it throws.
	 */
	docChanged(changes: ChangeDesc, blockTop: (pos: number) => number, pxPerWorld: number, below?: number): readonly AttachmentData[] {
		const end = changes.length, inside = (a: AttachmentData) => isOpaqueAttachment(a) || a.target.to <= end;
		const list = this.list.every(inside) ? this.list : this.list.map((a) => inside(a) || isOpaqueAttachment(a) ? a : { ...a, target: { ...a.target, from: Math.min(a.target.from, end), to: end } });
		const mapped = mapAttachments(list as AttachmentData[], changes);
		this.rereadOnChangedLine(mapped, changes, blockTop);
		if (mapped === this.list) return mapped;
		// Which groups were read in this layout before the change; one below the changed lines that the
		// change leaves where it was is not read again unless those lines' height changed (measure).
		this.dropDoubt();
		const current = below === undefined ? null : new Set<string>();
		if (current) for (const [id, f] of this.follows) if (f.epoch === this.layoutEpoch) current.add(id);
		// This pane's own mapping moves targets: the unread entries are this pane's and carry over it.
		const unread = this.unreadAt.size > 0 ? new Map(this.unreadAt) : null;
		this.setList(mapped);
		if (unread) for (const [id, u] of unread) if (this.followsText(id) && !this.follows.has(id)) this.unreadAt.set(id, u);
		let moved = false;
		const kept = new Map<string, FollowOffset>();
		const doubt: Doubt = { epoch: this.layoutEpoch, pos: Infinity, top: 0, ids: [] };
		for (const r of this.records.values()) {
			const f = this.follows.get(r.id);
			if (!f?.ref || this.holds.has(r.id) || collapsed(r) || !(pxPerWorld > 0)) continue;
			const top = blockTop(r.target.from);
			if (current && top === f.blockTop && current.has(r.id) && r.target.from > below!) {
				f.epoch = DOUBT;
				doubt.ids.push(r.id);
				if (r.target.from < doubt.pos) { doubt.pos = r.target.from; doubt.top = top; }
			}
			if (!Number.isFinite(top) || top === f.blockTop) continue;
			f.ref = { x: f.ref.x, y: f.ref.y + (top - f.blockTop) / pxPerWorld };
			f.blockTop = top;
			const offset = offsetFrom(r, f.ref);
			if (sameOffset(offset, f.offset)) continue;
			f.offset = offset;
			if (offset) kept.set(r.id, offset);
			moved = true;
		}
		// A group not read here: its entry moves by its block's top change, and its record keeps the absolute correction
		// (never the record's plus a delta: a second pane reading the list must not add it twice). Not painted: no
		// generation, groupOffset stays null.
		let movedUnread = false;
		if (pxPerWorld > 0) for (const [id, u] of this.unreadAt) {
			const r = this.records.get(id);
			if (!r) continue;
			// Another pane stamped a new correction since this entry's seed: the entry starts from it.
			const was = r.shown ?? ZERO;
			if (!sameOffset(u.from, was)) { u.offset = was; u.from = was; }
			if (carryUnread(u, blockTop(r.target.from), pxPerWorld)) movedUnread = true;
			// Kept when this change moved it, or when a measure since the last write did (carried, not yet on the page).
			if (!sameOffset(u.offset, r.shown ?? ZERO)) kept.set(id, u.offset);
		}
		// The next measure reads this change's lines as drawn: the move it finds for an unread group is carried.
		this.unreadSettle = pxPerWorld > 0 && this.unreadAt.size > 0 ? { px: pxPerWorld, epoch: this.layoutEpoch } : null;
		if (moved || movedUnread) this.edited = true;
		if (moved) this.generation++;
		if (doubt.ids.length > 0) this.doubt = doubt;
		// The page this edit writes holds the correction each group shows at the write, not only the ones this change
		// moved: a move only the measure found, and a held or collapsed group's last correction, are kept too.
		for (const r of this.records.values()) {
			if (kept.has(r.id)) continue;
			const offset = this.groupOffset(r.id);
			if (offset && !sameOffset(offset, r.shown ?? ZERO)) kept.set(r.id, offset);
		}
		if (kept.size === 0) return mapped;
		// An unread entry agrees with the correction now stamped on its record.
		for (const [id, u] of this.unreadAt) if (kept.has(id)) u.from = u.offset;
		// The moved groups keep their correction on the record: the page this edit writes holds where each was shown.
		const stamped = mapped.map((a) => isOpaqueAttachment(a) || !kept.has(a.id) ? a : withShown(a, kept.get(a.id)!));
		this.setList(stamped);
		return stamped;
	}

	/**
	 * A word group whose line changed before its words is read again at the next measure, whether or not its start
	 * moved: a replace of the same length before the words leaves the start where it was but may widen the text in front.
	 * The line is the target's line block, matched by its top in the text after the change, against the line the change
	 * ends on: a change that starts on the line above and runs into the word's line counts.
	 */
	private rereadOnChangedLine(mapped: readonly AttachmentData[], changes: ChangeDesc, blockTop: (pos: number) => number): void {
		if (this.follows.size === 0) return;
		for (const a of mapped) {
			if (isOpaqueAttachment(a) || a.target.kind !== "range") continue;
			const f = this.follows.get(a.id), from = a.target.from;
			if (!f || f.epoch === -1) continue;
			let top: number | undefined, hit = false;
			changes.iterChangedRanges((_fa, _ta, fb, tb) => {
				if (hit || tb > from) return;
				top ??= blockTop(from);
				if (blockTop(tb) === top) hit = true;
			});
			if (hit) f.epoch = -1;
		}
	}

	/** The groups a change left unread, read at the next measure after all (a second change before it, or a new layout). */
	private dropDoubt(): void {
		const d = this.doubt;
		if (!d) return;
		this.doubt = null;
		for (const id of d.ids) { const f = this.follows.get(id); if (f && f.epoch === DOUBT) f.epoch = -1; }
	}

	/** A layout change with no document change: every group is read again at the next measure; corrections hold. */
	layoutChanged(): void {
		this.dropDoubt();
		this.layoutEpoch++;
		this.released.clear();
	}

	/**
	 * A measure: up to `cap` (GROUP_READS_PER_MEASURE) groups in the view whose point is not of this layout epoch are read.
	 * `changed`: a correction changed (repaint). `more`: groups in the view are left to read (ask for another measure).
	 */
	measure(view: FollowMeasure, cap = GROUP_READS_PER_MEASURE): { changed: boolean; more: boolean } {
		const d = this.doubt;
		if (d) {
			// The first group below the changed lines, its line block's top as measured now. The lines between
			// are unchanged and the line count is the same, so an unchanged top means the changed lines kept their height and
			// nothing below them moved: the groups below keep this layout's read.
			this.doubt = null;
			let same = false;
			if (d.epoch === this.layoutEpoch) {
				this.counts.blocksMeasured++;
				same = (view.changedBlockTop ?? view.blockTop)(d.pos) === d.top;
			}
			for (const id of d.ids) { const f = this.follows.get(id); if (f && f.epoch === DOUBT) f.epoch = same ? this.layoutEpoch : -1; }
		}
		// The measure after a change, in the change's layout or the one its heights bring: the move it finds is the change's.
		const settle = this.unreadSettle, carry = settle && this.layoutEpoch - settle.epoch <= 1 ? settle.px : 0;
		// Every group not read here, before any read and with no read cap: seeded once from the record's kept correction and
		// its block's top now. Kept over a new layout epoch: its top is taken as the base, and the move the measure after a
		// change finds (a keystroke that kept its line's height, a split line's estimate) is carried, never dropped. A peer's
		// newer stamp is taken where the entry is used (exported, docChanged).
		for (const r of this.records.values()) {
			if (this.holds.has(r.id) || collapsed(r) || this.follows.has(r.id)) continue;
			const u = this.unreadAt.get(r.id), kept = r.shown ?? ZERO, top = view.blockTop(r.target.from);
			if (!u) this.unreadAt.set(r.id, { base: top, epoch: this.layoutEpoch, offset: kept, from: kept });
			else {
				if (carry > 0) carryUnread(u, top, carry);
				else if (u.epoch !== this.layoutEpoch && Number.isFinite(top)) u.base = top;
				u.epoch = this.layoutEpoch;
			}
		}
		// The change's window closes here: every unread group took the change's move in this pass, so a later layout change
		// (a scroll that measures lines above), even one before a capped run of reads ends, is not the change's move.
		if (settle) this.unreadSettle = null;
		let reads = 0, changed = false, more = false;
		for (const r of this.records.values()) {
			if (this.holds.has(r.id) || collapsed(r)) continue;
			const f = this.follows.get(r.id);
			if (f && f.epoch === this.layoutEpoch) continue;
			if (!view.inView(r.target.from)) continue;
			if (reads === cap) {
				more = true;
				break;
			}
			reads++;
			this.counts.groupsMeasured++;
			const ref = view.refAt(r.target.from);
			if (!ref || !Number.isFinite(ref.x) || !Number.isFinite(ref.y)) continue;
			const offset = offsetFrom(r, ref), blockTop = view.blockTop(r.target.from);
			if (f) {
				if (!sameOffset(offset, f.offset)) changed = true;
				f.ref = ref;
				f.blockTop = blockTop;
				f.epoch = this.layoutEpoch;
				f.offset = offset;
			} else {
				this.follows.set(r.id, { ref, blockTop, epoch: this.layoutEpoch, offset });
				this.unreadAt.delete(r.id);
				changed = true;
			}
		}
		if (changed) this.generation++;
		return { changed, more };
	}

	/**
	 * Attach or Change attachment on this pane: the record's point was read where the ink is shown, in this layout, so
	 * the group shows at once with no correction and no pending frame. A group that needed reattachment is attached
	 * now: it follows its new text from here, with no tag.
	 */
	attached(record: AttachmentRecord, blockTop: number): void {
		const held = this.holds.delete(record.id) ? this.heldBefore.get(record.id) : undefined;
		if (held) this.lifted.set(record.id, { held, attached: record });
		this.place(record, blockTop);
	}

	/** A group's point read in this layout where its ink is shown: no correction. */
	private place(record: AttachmentRecord, blockTop: number): void {
		const f: Follow = { ref: { ...record.ref }, blockTop, epoch: this.layoutEpoch, offset: ZERO };
		this.follows.set(record.id, f);
		this.unreadAt.delete(record.id);
	}

	/**
	 * A text change, for the two records each Attach that ended a hold keeps for its undo and redo, and each record let
	 * go of: all mapped through it as the note's list is, so the step finds them where the change left them. Every pane
	 * maps its own, writer of the list or not: each pane has its own history. A target past the end of the text before
	 * the change is first brought to that end, as in docChanged.
	 */
	carryLifted(changes: ChangeDesc): void {
		if (changes.empty || (this.lifted.size === 0 && this.letGo.size === 0)) return;
		const end = changes.length;
		const map = (r: AttachmentRecord): AttachmentRecord => {
			const t = r.target.to <= end ? r.target : { ...r.target, from: Math.min(r.target.from, end), to: end };
			const target = mapTarget(t, changes);
			return target === r.target ? r : { ...r, target };
		};
		for (const [id, l] of this.lifted) this.lifted.set(id, { held: map(l.held), attached: map(l.attached) });
		for (const [id, r] of this.letGo) this.letGo.set(id, map(r));
	}

	/**
	 * This pane's own text change, before anything reads the list (an unchanged list returns from setList at once): each
	 * group held as new here is checked again against this pane's text now and freed when its words stand where its
	 * record says. Words truly gone stay held.
	 */
	recheckNew(): void {
		if (this.heldNew.size === 0) return;
		let freed = false;
		for (const id of this.heldNew) {
			const r = this.records.get(id);
			if (!r || !this.holds.has(id)) this.heldNew.delete(id);
			else if (this.standsHere(r)) {
				this.holds.delete(id);
				this.heldNew.delete(id);
				freed = true;
			}
		}
		if (freed) this.recompute();
	}

	/**
	 * Where a record put back by history (the undo of a Detach, the redo of an Attach) stands in `doc`, this pane's text
	 * now; null: it needs reattachment. First the place the record this pane let go of was carried to: the record's words
	 * there, it takes that place with its context read again, as a live group's is. Else the one place holding its words
	 * with their context (resolveTarget). Never its words alone. The record's own target when it stands as it is.
	 */
	putBack(record: AttachmentRecord, doc: string): AttachmentTarget | null {
		const k = this.letGo.get(record.id), t = record.target;
		if (k && sameBesideOffsets(k, record) && k.target.to > k.target.from && k.target.to <= doc.length) {
			const at = refreshTarget({ ...t, from: k.target.from, to: k.target.to }, doc);
			if (at.text === t.text) return at.from === t.from && at.to === t.to && at.before === t.before && at.after === t.after ? t : at;
		}
		return resolveTarget(t, doc);
	}

	/**
	 * An attach step from history, with its records at the offsets this pane carried them to since it was made: history
	 * keeps a step's records as they were, and a text change since moves the record it finds. Only the undo or the redo of
	 * an Attach that ended a hold here, and only when `now`, the note's record of that id, is the one the step leaves, at
	 * the carried offsets (its text and context may have been read again since); the step as it came otherwise. The redo's
	 * attached target reads its text and context from `doc`, the note's text now, at the carried offsets: words changed
	 * since in another pane would otherwise be saved as they were at the Attach, and a reopen would not find them. The
	 * undo's held record keeps the words it was stored with, as a held target does at any text change.
	 */
	carried(step: AttachStep, now: AttachmentData | undefined, doc?: () => string): AttachStep {
		const l = this.lifted.get(step.id);
		if (!l || !step.before || !step.after || !now || isOpaqueAttachment(now)) return step;
		const undo = sameBesideOffsets(step.before, l.attached) && sameBesideOffsets(step.after, l.held);
		if (!undo && !(sameBesideOffsets(step.before, l.held) && sameBesideOffsets(step.after, l.attached))) return step;
		const left = undo ? l.attached : l.held, put = undo ? l.held : l.attached;
		if (!sameAt(now, left)) return step;
		const t = step.after.target, at = put.target;
		let target = t.from === at.from && t.to === at.to ? t : { ...t, from: at.from, to: at.to };
		if (!undo && doc && target.from < target.to) target = refreshTarget(target, doc());
		const after = target === t ? step.after : { ...step.after, target };
		return after === step.after && now === step.before ? step : { ...step, before: now, after };
	}

	/**
	 * A record put back by history (the redo of an attach): shown at once at its own reference point, the line block's top
	 * from the height map, and read again at the next measure as any group is. Never pending.
	 * The undo of a Detach in the layout it was made in takes back the group's last read, so it shows where it was.
	 * With no read of this layout to take, the group is seeded at `carry`, the correction the step carries (where its ink
	 * was shown before the step minus where it is stored after), and left to be read: true then, so the caller asks the
	 * next measure. Nothing moves at the step; a layout that changed since the record's point was read moves it once, at
	 * that measure.
	 */
	seeded(record: AttachmentRecord, blockTop: number, carry?: FollowOffset): boolean {
		const held = this.released.get(record.id), live = this.follows.get(record.id);
		this.released.delete(record.id);
		if (live?.ref && live.epoch === this.layoutEpoch) {
			// A record changed in place (the undo of a drop): the target's read of this layout stands.
			live.offset = offsetFrom(record, live.ref);
		} else if (held?.follow.ref && held.follow.epoch === this.layoutEpoch && held.follow.blockTop === blockTop && sameValue(unkept(held.record), unkept(record))) {
			this.follows.set(record.id, { ...held.follow, offset: offsetFrom(record, held.follow.ref) });
			this.unreadAt.delete(record.id);
		} else {
			this.place(record, blockTop);
			const f = this.follows.get(record.id)!;
			f.epoch = -1;
			if (carry) f.offset = { dx: carry.dx, dy: carry.dy };
			this.generation++;
			return true;
		}
		this.generation++;
		return false;
	}

	/** Whether a document change moved a correction since the last call: a real edit. Clears it. */
	takeEdited(): boolean {
		const e = this.edited;
		this.edited = false;
		return e;
	}

	/**
	 * Each read group's correction against its record now. A group whose target needs reattachment or was deleted is
	 * never read: its correction holds, even when its record moves with its points (Insert Space).
	 */
	private recompute(): void {
		let changed = false;
		for (const [id, f] of this.follows) {
			const r = this.records.get(id);
			if (!r || !f.ref || this.holds.has(id) || collapsed(r)) continue;
			const offset = offsetFrom(r, f.ref);
			if (sameOffset(offset, f.offset)) continue;
			f.offset = offset;
			changed = true;
		}
		if (changed) this.generation++;
	}
}

/**
 * A group settled at a page write: the reference point moves by the correction to the point now, the layout is the
 * writer's, and the probe moves with the points. The caller moves every member's points by the same correction.
 */
export function settledRecord(record: AttachmentRecord, offset: FollowOffset, layout: { width: number; font: number }): AttachmentRecord {
	if (offset.dx === 0 && offset.dy === 0 && record.layout.width === layout.width && record.layout.font === layout.font) return record;
	return {
		...record,
		ref: { x: record.ref.x + offset.dx, y: record.ref.y + offset.dy },
		layout: { width: layout.width, font: layout.font },
		probe: { ...record.probe, x: record.probe.x + offset.dx, y: record.probe.y + offset.dy },
	};
}

/** A stroke moved by a record's kept correction: the same object at none. */
function keptShown(s: InkStroke, shown: FollowOffset | undefined): InkStroke {
	return shown && !isZero(shown) ? shiftedStroke(s, shown.dy, shown.dx) : s;
}

/**
 * The note's strokes for an export where no pane shows the note: each group's members at the correction its record
 * kept, free ink as stored (the store's own objects). The same list when no record keeps one.
 */
export function keptShownStrokes(strokes: readonly InkStroke[], list: readonly AttachmentData[]): readonly InkStroke[] {
	const by = new Map<string, FollowOffset>();
	for (const a of list) {
		if (isOpaqueAttachment(a) || !a.shown || isZero(a.shown)) continue;
		for (const id of a.strokeIds) by.set(id, a.shown);
	}
	return by.size === 0 ? strokes : strokes.map((s) => keptShown(s, by.get(s.id)));
}

/**
 * `list` with each group's kept correction the one `follow` shows now, so the page's next write of any kind holds it: a
 * move only the measure found too. A pending group keeps its own. The same list when every record holds it already.
 */
export function shownList(follow: AttachFollow, list: readonly AttachmentData[]): readonly AttachmentData[] {
	let out: AttachmentData[] | null = null;
	for (let i = 0; i < list.length; i++) {
		const a = list[i]!;
		if (isOpaqueAttachment(a)) continue;
		const offset = follow.groupOffset(a.id);
		if (!offset || sameOffset(offset, a.shown ?? ZERO)) continue;
		(out ??= list.slice())[i] = withShown(a, offset);
	}
	return out ?? list;
}

/** A record with `offset` as its kept correction: none at 0. The same object when it already holds that. */
function withShown(r: AttachmentRecord, offset: FollowOffset): AttachmentRecord {
	if (isZero(offset)) {
		if (!r.shown) return r;
		const rest = { ...r };
		delete rest.shown;
		return rest;
	}
	if (r.shown && r.shown.dx === offset.dx && r.shown.dy === offset.dy) return r;
	return { ...r, shown: { dx: offset.dx, dy: offset.dy } };
}

/** A record without its kept correction, for comparing records: where a group was last shown is not what it is. */
function unkept(r: AttachmentRecord | null): AttachmentRecord | null {
	if (!r?.shown) return r;
	const rest = { ...r };
	delete rest.shown;
	return rest;
}

/** Two records the same but for where their targets sit: a record and the same one moved by text changes. */
function sameBesideOffsets(a: AttachmentRecord, b: AttachmentRecord): boolean {
	const bare = (r: AttachmentRecord) => ({ ...unkept(r), target: { ...r.target, from: 0, to: 0 } });
	return sameValue(bare(a), bare(b));
}

/** A record at `r`'s offsets, the same in all but its target's text and context, which a change near it reads again. */
function sameAt(now: AttachmentRecord, r: AttachmentRecord): boolean {
	const placed = (x: AttachmentRecord) => ({ ...unkept(x), target: { kind: x.target.kind, from: x.target.from, to: x.target.to } });
	return sameValue(placed(now), placed(r));
}

function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const ka = Object.keys(a), kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	for (const k of ka) if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
	return true;
}

/**
 * An attach step from history, on this note's list: applied only when the record now equals the step's `before` (none
 * for null); otherwise the step is spent and null is returned. An opaque record of that id is never replaced.
 * `docChanged`: the step's transaction changes the text too, and history applies the step before that change maps the
 * records, so the target is left out of the comparison and the record keeps its own target, which the text change then
 * maps.
 */
export function applyAttachOp(list: readonly AttachmentData[], step: AttachStep, docChanged = false): AttachmentData[] | null {
	const now = list.find((a) => a.id === step.id);
	if (now && isOpaqueAttachment(now)) return null;
	if (!docChanged) return sameValue(unkept(now ?? null), unkept(step.before)) ? applyAttachStep(list, step) : null;
	const bare = (r: AttachmentRecord | null) => (r ? { ...unkept(r), target: null } : null);
	if (!sameValue(bare(now ?? null), bare(step.before))) return null;
	return applyAttachStep(list, now && step.after ? { ...step, after: { ...step.after, target: now.target } } : step);
}
