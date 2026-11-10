/**
 * Ink attached to text: the model only.
 *
 * A group is a set of stroke ids with one record: the text it belongs to (a range of the note body, found by document
 * position plus its exact text and 32 characters of context each side), the reference point the ink follows, the
 * layout that point was read in, and a probe point of one member stroke. Pure functions on plain data: nothing here
 * reads the DOM, writes a stroke point or touches the overlay. The ink follows its text by a correction computed from
 * the reference point (followOffset); stored points settle only at a page write, wired with the overlay. There is no
 * "Check alignment" state: a target is resolved, or it needs reattachment, or its line is not measured yet.
 */
import type { ChangeDesc } from "@codemirror/state";

/** Characters of context kept on each side of a target. */
export const ATTACHMENT_CONTEXT = 32;

export interface AttachmentTarget {
	kind: "range" | "paragraph";
	/** Document offsets, `[from, to)`. */
	from: number;
	to: number;
	/** The target's text and its context, whitespace runs collapsed to one space. */
	text: string;
	before: string;
	after: string;
}

export interface AttachmentRecord {
	v: 1;
	id: string;
	strokeIds: string[];
	target: AttachmentTarget;
	/** Note-space top-left of the visual line holding `target.from` when the record was last settled. */
	ref: { x: number; y: number };
	/** Content width in layout px and editor font px that `ref` was read in. */
	layout: { width: number; font: number };
	/** The first point of one member stroke at the last save. */
	probe: { id: string; x: number; y: number };
	/**
	 * The correction the group was last shown at, world units, kept from the text change that last moved it; absent for
	 * none. A reopen that cannot find the target shows the group by it, so the ink stays where it was last shown; a found
	 * target is read again and this is not used. No stroke point moves for it.
	 */
	shown?: { dx: number; dy: number };
}

/**
 * A record this build cannot read: a later version, or a v1 record whose shape is wrong in a way the parser keeps rather
 * than drops. Kept as found and written back as found; its group shows "Needs reattachment" and nothing moves.
 */
export interface OpaqueAttachment {
	opaque: true;
	id: string;
	raw: Record<string, unknown>;
}

export type AttachmentData = AttachmentRecord | OpaqueAttachment;

export type AttachmentStatus = "resolved" | "needs-reattachment" | "pending";

/** The history step for Attach, Change attachment and Detach: the record before and after, null for none. */
export interface AttachStep {
	type: "attach";
	id: string;
	before: AttachmentRecord | null;
	after: AttachmentRecord | null;
	/**
	 * The members' stored points moved in the same step: Attach by each member's own
	 * correction, Detach by the group's, so nothing shown moves. Per member: the move and its first point before it.
	 */
	settle?: { strokeIds: string[]; dx: number[]; dy: number[]; from: Array<{ x: number; y: number }> };
}

export const KNOWN_ATTACHMENT = new Set(["v", "id", "strokeIds", "target", "ref", "layout", "probe", "shown"]);

export function isOpaqueAttachment(a: AttachmentData): a is OpaqueAttachment {
	return (a as OpaqueAttachment).opaque === true;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const offset = (n: unknown): n is number => finite(n) && Number.isInteger(n) && n >= 0;

/**
 * One sidecar entry, read. `null` when it has no usable id (the caller drops and counts it). A `v` other than 1 is kept
 * opaque. A v1 entry with a wrong field is dropped: this build wrote it, so a bad field is damage, not a newer format.
 */
export function readAttachment(raw: Record<string, unknown>, safeId: (id: unknown) => id is string): AttachmentData | null {
	if (!safeId(raw.id)) return null;
	const id = raw.id;
	if (raw.v !== 1) return { opaque: true, id, raw };
	const t = raw.target as Record<string, unknown> | null, ref = raw.ref as Record<string, unknown> | null;
	const layout = raw.layout as Record<string, unknown> | null, probe = raw.probe as Record<string, unknown> | null;
	if (!Array.isArray(raw.strokeIds) || !raw.strokeIds.every((s) => typeof s === "string")) return null;
	if (!t || typeof t !== "object" || (t.kind !== "range" && t.kind !== "paragraph")) return null;
	if (!offset(t.from) || !offset(t.to) || t.to < t.from) return null;
	if (typeof t.text !== "string" || typeof t.before !== "string" || typeof t.after !== "string") return null;
	if (!ref || !finite(ref.x) || !finite(ref.y)) return null;
	if (!layout || !finite(layout.width) || !finite(layout.font)) return null;
	if (!probe || typeof probe.id !== "string" || !finite(probe.x) || !finite(probe.y)) return null;
	// The kept correction is optional: a page without it, or with one this build cannot use, reads as no correction.
	const shown = raw.shown as Record<string, unknown> | null | undefined;
	const kept = shown && typeof shown === "object" && finite(shown.dx) && finite(shown.dy) && (shown.dx !== 0 || shown.dy !== 0);
	return {
		v: 1,
		id,
		strokeIds: [...new Set(raw.strokeIds)],
		target: { kind: t.kind, from: t.from, to: t.to, text: t.text, before: t.before, after: t.after },
		ref: { x: ref.x, y: ref.y },
		layout: { width: layout.width, font: layout.font },
		probe: { id: probe.id, x: probe.x, y: probe.y },
		...(kept ? { shown: { dx: shown.dx as number, dy: shown.dy as number } } : {}),
	};
}

/**
 * The load rule for members: ids of strokes the page no longer holds leave the group, and a group left with none is
 * dropped (an erase leaves an empty group in the session; it goes at the next load). Opaque records are untouched.
 */
export function liveAttachments(list: AttachmentData[], strokeIds: ReadonlySet<string>): AttachmentData[] {
	const out: AttachmentData[] = [];
	for (const a of list) {
		if (isOpaqueAttachment(a)) { out.push(a); continue; }
		const strokes = a.strokeIds.filter((id) => strokeIds.has(id));
		if (strokes.length === 0) continue;
		out.push(strokes.length === a.strokeIds.length ? a : { ...a, strokeIds: strokes });
	}
	return out;
}

export const normalizeText = (text: string): string => text.replace(/\s+/g, " ");

/** The target for `[from, to)` of `doc`, text and context read from the document. */
export function targetAt(doc: string, from: number, to: number, kind: AttachmentTarget["kind"]): AttachmentTarget {
	return {
		kind,
		from,
		to,
		text: normalizeText(doc.slice(from, to)),
		before: normalizeText(doc.slice(Math.max(0, from - ATTACHMENT_CONTEXT), from)),
		after: normalizeText(doc.slice(to, to + ATTACHMENT_CONTEXT)),
	};
}

/** One word's place as laid out: its world left and right on its visual row, and that row's top and bottom. */
export interface WordPlace {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/** The words of `[from, to)` of `doc`, each a run of non-space characters, in order. */
export function wordsIn(doc: string, from: number, to: number): { from: number; to: number }[] {
	const out: { from: number; to: number }[] = [];
	for (const m of doc.slice(from, to).matchAll(/\S+/g)) out.push({ from: from + m.index, to: from + m.index + m[0].length });
	return out;
}

/**
 * The words a box over one visual row takes, or null for the paragraph. A word's place is its letters' rect, which is
 * shorter than the row it sits on, so its row is a band: L is the larger of `lineHeight` (the editor's line pitch, in the
 * places' units) and the letters' height, and the band runs L/2 above and below the letters' centre. The box is on a row
 * when its centre is in that band or up to L/4 below it (an underline under the descenders); in two bands, the upper row
 * wins. A word of that row belongs when its horizontal middle lies inside the box, so a wide circle that clips a
 * neighbour's letter does not take the neighbour. Null when the box is taller than 1.5 L or no word's middle is inside
 * it. `placeOf` reads one word's place (null when it cannot); words come in document order, so the walk stops at the
 * first word whose band starts below the centre. The range runs from the first taken word's start to the last one's end.
 */
export function wordRangeUnder(
	words: readonly { from: number; to: number }[],
	box: { x: number; y: number; width: number; height: number },
	placeOf: (w: { from: number; to: number }) => WordPlace | null,
	lineHeight = 0,
): { from: number; to: number } | null {
	const cy = box.y + box.height / 2, right = box.x + box.width;
	let from = -1, to = -1, row: { c: number; l: number } | null = null;
	for (const w of words) {
		const p = placeOf(w);
		if (!p) continue;
		const c = (p.top + p.bottom) / 2, l = Math.max(Number.isFinite(lineHeight) ? lineHeight : 0, p.bottom - p.top);
		if (row) {
			// Past the chosen row: a word whose letters' centre is half a row or more below it is on a later row.
			if (Math.abs(c - row.c) >= row.l / 2) break;
		} else {
			if (c - l / 2 > cy) break;
			if (cy > c + l / 2 + l / 4) continue;
			if (box.height > 1.5 * l) return null;
			row = { c, l };
		}
		const mid = (p.left + p.right) / 2;
		if (mid <= box.x || mid >= right) continue;
		if (from < 0) from = w.from;
		to = w.to;
	}
	return from < 0 ? null : { from, to };
}

/**
 * A local edit, mapped. An insertion exactly at `from` or exactly at `to` stays outside the target, one inside
 * grows it. Text and context are kept as stored: they are refreshed from the document at the next save (refreshTarget),
 * and a target the edit collapsed keeps its old text so an undo or a paste elsewhere can find it again.
 *
 * A change that replaces the target's whole text collapses it, the same as a delete: a list item moved up or down is
 * swapped with its neighbour by two replaces, and mapping the replaced range alone would hand the target the
 * neighbour's words in the same place.
 */
export function mapTarget(target: AttachmentTarget, changes: ChangeDesc): AttachmentTarget {
	if (target.to > target.from) {
		let replaced = false;
		changes.iterChangedRanges((fromA, toA) => {
			if (fromA <= target.from && toA >= target.to) replaced = true;
		});
		if (replaced) {
			const at = changes.mapPos(target.from, 1);
			return { ...target, from: at, to: at };
		}
	}
	const from = changes.mapPos(target.from, 1), to = Math.max(from, changes.mapPos(target.to, -1));
	return from === target.from && to === target.to ? target : { ...target, from, to };
}

/** Every v1 record's target mapped through one change; a record whose target did not move is returned as it was. */
export function mapAttachments(list: AttachmentData[], changes: ChangeDesc): AttachmentData[] {
	if (changes.empty) return list;
	let out: AttachmentData[] | null = null;
	for (let i = 0; i < list.length; i++) {
		const a = list[i]!;
		if (isOpaqueAttachment(a)) continue;
		const target = mapTarget(a.target, changes);
		if (target === a.target) continue;
		(out ??= list.slice())[i] = { ...a, target };
	}
	return out ?? list;
}

/** The stored text and context brought up to the document, for a resolved target at save. */
export function refreshTarget(target: AttachmentTarget, doc: string): AttachmentTarget {
	const next = targetAt(doc, target.from, target.to, target.kind);
	return next.text === target.text && next.before === target.before && next.after === target.after ? target : next;
}

/**
 * Where the target is in `doc` now, or null: "Needs reattachment". First the stored
 * offsets, with the same text and context there; else the one place in the document holding the text with that context.
 * No match, or more than one: null. No partial or fuzzy match. An empty target never resolves; a collapsed one (from
 * equal to to) skips the stored offsets and is found by the search only.
 */
/** A document with its whitespace runs collapsed to one space, and each collapsed character's offsets in the original. */
export interface FlatText {
	flat: string;
	starts: number[];
	ends: number[];
}

/** The collapsed document a target search reads: built once per document and shared by every target searched in it. */
export function flatText(doc: string): FlatText {
	const starts: number[] = [], ends: number[] = [];
	let flat = "";
	for (const m of doc.matchAll(/\s+|[^\s]/g)) {
		starts.push(m.index);
		ends.push(m.index + m[0].length);
		flat += m[0].length > 1 || /\s/.test(m[0]) ? " " : m[0];
	}
	return { flat, starts, ends };
}

/**
 * `flat`: the collapsed document, asked for only when the stored offsets miss; resolveAttachments hands one build to every
 * group, so a note with many stale groups builds it once.
 */
export function resolveTarget(target: AttachmentTarget, doc: string, flat: () => FlatText = () => flatText(doc)): AttachmentTarget | null {
	const text = normalizeText(target.text), before = normalizeText(target.before), after = normalizeText(target.after);
	const core = text.trim();
	if (core === "") return null;
	if (target.to > target.from && target.to <= doc.length) {
		const at = targetAt(doc, target.from, target.to, target.kind);
		if (at.text === text && at.before === before && at.after === after) return target;
	}
	// Search the whitespace-collapsed document, keeping each collapsed character's offsets in the original.
	const { flat: flatDoc, starts, ends } = flat();
	// The context and the target are collapsed once, together: where a context's edge space meets the target's (a line's
	// indent after the line break before it, trailing spaces before the next), the document holds one run, so one space.
	// Stored text and context were each collapsed alone, so a target stored either way reads the same here.
	const lead = text.startsWith(" "), trail = text.endsWith(" ");
	const head = normalizeText(before + (lead ? " " : "")), needle = head + core + normalizeText((trail ? " " : "") + after);
	let found = -1;
	for (let i = flatDoc.indexOf(needle); i !== -1; i = flatDoc.indexOf(needle, i + 1)) {
		if (found !== -1) return null;
		found = i;
	}
	if (found === -1) return null;
	const first = found + head.length, last = first + core.length - 1;
	let from = starts[first]!, to = ends[last]!;
	// The target's edge whitespace is its part of the run it shares with the context: from the line break when the run
	// holds one (a whole line starts after it and ends before it), else the whole run when the context has no space there.
	if (lead) {
		const s = starts[first - 1]!, e = ends[first - 1]!, br = doc.lastIndexOf("\n", e - 1);
		from = br >= s ? br + 1 : before.endsWith(" ") ? e - 1 : s;
	}
	if (trail) {
		const s = starts[last + 1]!, e = ends[last + 1]!, br = doc.indexOf("\n", s);
		to = br !== -1 && br < e ? br : after.startsWith(" ") ? s + 1 : e;
	}
	return { ...target, from, to };
}

/**
 * Targets an edit collapsed (their text deleted), looked for again when a change inserts text holding their words: the
 * undo of the delete, or the cut text pasted elsewhere. The one place holding the old text with its context: the target
 * takes it, so the group follows its words again in the session. A change whose text holds no collapsed target's words
 * costs no search.
 */
export function refindCollapsed(list: readonly AttachmentData[], inserted: readonly string[], doc: () => string): readonly AttachmentData[] {
	let out: AttachmentData[] | null = null, text: string | null = null, built: FlatText | null = null;
	for (let i = 0; i < list.length; i++) {
		const a = list[i]!;
		if (isOpaqueAttachment(a) || a.target.from !== a.target.to) continue;
		const core = normalizeText(a.target.text).trim();
		if (core === "" || !inserted.some((t) => normalizeText(t).includes(core))) continue;
		const d = (text ??= doc());
		const found = resolveTarget(a.target, d, () => (built ??= flatText(d)));
		if (found && found.to > found.from) (out ??= list.slice())[i] = { ...a, target: found };
	}
	return out ?? list;
}

/**
 * Each group's state in `doc`: opaque records and unresolvable targets need reattachment; the rest are resolved, with
 * their offsets rewritten where the text was found elsewhere. Never changes a ref, a layout or a probe: nothing moves.
 * This is also the whole of what adopting a synced sidecar or a synced text does: resolve, never move.
 */
export function resolveAttachments(list: AttachmentData[], doc: string): { list: AttachmentData[]; status: Map<string, AttachmentStatus> } {
	const status = new Map<string, AttachmentStatus>();
	let out: AttachmentData[] | null = null;
	let built: FlatText | null = null;
	const flat = () => (built ??= flatText(doc));
	for (let i = 0; i < list.length; i++) {
		const a = list[i]!;
		if (isOpaqueAttachment(a)) { status.set(a.id, "needs-reattachment"); continue; }
		const target = resolveTarget(a.target, doc, flat);
		if (!target) { status.set(a.id, "needs-reattachment"); continue; }
		status.set(a.id, "resolved");
		if (target !== a.target) (out ??= list.slice())[i] = { ...a, target };
	}
	return { list: out ?? list, status };
}

/**
 * How far the group's ink is shown from its stored points: the reference point now minus the stored one. Pure; writes
 * nothing. `null` when the target's line is not measured (the group is pending and is not painted until it is).
 */
export function followOffset(record: AttachmentRecord, refNow: { x: number; y: number } | null): { dx: number; dy: number } | null {
	if (!refNow || !finite(refNow.x) || !finite(refNow.y)) return null;
	return { dx: refNow.x - record.ref.x, dy: refNow.y - record.ref.y };
}

/** Stroke id to group id, over v1 records. */
export function attachmentMembership(list: readonly AttachmentData[]): Map<string, string> {
	const members = new Map<string, string>();
	for (const a of list) if (!isOpaqueAttachment(a)) for (const id of a.strokeIds) members.set(id, a.id);
	return members;
}

/**
 * What Attach and Detach may do for a selection. Groups touched by the selection: none or one, Attach gives the
 * union of the selection and that group; two or more, Attach is off until the user chooses one. Detach is on when
 * every selected stroke belongs to the one group, and on for two groups or more, loose ink selected or not: each
 * group touched detaches whole and the loose ink stays loose.
 */
export function attachmentSelection(list: readonly AttachmentData[], ids: readonly string[]): { attach: boolean; detach: boolean; groupIds: string[]; expandedIds: string[] } {
	const members = attachmentMembership(list), selected = [...new Set(ids)];
	const groupIds = [...new Set(selected.flatMap((id) => (members.has(id) ? [members.get(id)!] : [])))];
	const grouped = new Set(groupIds);
	const expandedIds = [...new Set([...selected, ...list.flatMap((a) => (!isOpaqueAttachment(a) && grouped.has(a.id) ? a.strokeIds : []))])];
	return {
		attach: selected.length > 0 && groupIds.length <= 1,
		detach: groupIds.length > 1 || (groupIds.length === 1 && selected.every((id) => members.has(id))),
		groupIds,
		expandedIds,
	};
}

/** The list with `id`'s record replaced by `record`, removed when null, appended when new. */
function withRecord(list: readonly AttachmentData[], id: string, record: AttachmentRecord | null): AttachmentData[] {
	const at = list.findIndex((a) => a.id === id);
	if (at === -1) return record ? [...list, record] : list.slice();
	const out = list.slice();
	if (record) out[at] = record;
	else out.splice(at, 1);
	return out;
}

/**
 * Attach, or Change attachment when the group exists: the record as given. One history step, or none: a stroke belongs
 * to at most one group, so a record reaching a stroke of another readable group is refused and the list is returned as
 * it was. The selection never asks for that (two groups turn Attach off); the union of a group and free ink comes under
 * that group's own id. No stroke point changes.
 */
export function attachGroup(list: readonly AttachmentData[], record: AttachmentRecord): { list: AttachmentData[]; step: AttachStep | null } {
	const members = new Set(record.strokeIds);
	if (list.some((a) => !isOpaqueAttachment(a) && a.id !== record.id && a.strokeIds.some((id) => members.has(id)))) return { list: list.slice(), step: null };
	const before = list.find((a): a is AttachmentRecord => a.id === record.id && !isOpaqueAttachment(a)) ?? null;
	return { list: withRecord(list, record.id, record), step: { type: "attach", id: record.id, before, after: record } };
}

/** Detach the chosen group, by its id, never by selection: the record goes, the ink stays. One step, or none. */
export function detachGroup(list: readonly AttachmentData[], id: string): { list: AttachmentData[]; step: AttachStep | null } {
	const before = list.find((a): a is AttachmentRecord => a.id === id && !isOpaqueAttachment(a)) ?? null;
	if (!before) return { list: list.slice(), step: null };
	return { list: withRecord(list, id, null), step: { type: "attach", id, before, after: null } };
}

/** A step applied (undo applies its inversion): the record becomes `after`. */
export function applyAttachStep(list: readonly AttachmentData[], step: AttachStep): AttachmentData[] {
	return withRecord(list, step.id, step.after);
}

export function invertAttachStep(step: AttachStep): AttachStep {
	const s = step.settle;
	if (!s) return { type: "attach", id: step.id, before: step.after, after: step.before };
	const settle = { strokeIds: s.strokeIds, dx: s.dx.map((d) => -d), dy: s.dy.map((d) => -d), from: s.from.map((p, i) => ({ x: p.x + s.dx[i]!, y: p.y + s.dy[i]! })) };
	return { type: "attach", id: step.id, before: step.after, after: step.before, settle };
}

/**
 * An erase, as membership: a partially erased member's pieces take its place in its group; a fully erased one
 * leaves it. A group left empty stays in the session (an undo of the erase brings its strokes back) and is dropped at
 * the next load (liveAttachments). `pieces` maps each removed stroke id to the ids of its surviving pieces.
 */
export function replaceMembers(list: readonly AttachmentData[], pieces: ReadonlyMap<string, readonly string[]>): AttachmentData[] {
	if (pieces.size === 0) return list.slice();
	return list.map((a) => {
		if (isOpaqueAttachment(a) || !a.strokeIds.some((id) => pieces.has(id))) return a;
		return { ...a, strokeIds: [...new Set(a.strokeIds.flatMap((id) => (pieces.has(id) ? [...pieces.get(id)!] : [id])))] };
	});
}

/**
 * Insert Space's rule for groups (wired with the overlay): a group moves whole, by its target's first line. The
 * strokes of every group whose target's first line is at or below the seam; none of a group whose line is above, even
 * where some of its strokes lie below. `firstLineY` is keyed by group id; a group with no entry is not moved.
 */
export function insertSpaceMembers(list: readonly AttachmentData[], seam: number, firstLineY: ReadonlyMap<string, number>): { move: Set<string>; hold: Set<string> } {
	const move = new Set<string>(), hold = new Set<string>();
	for (const a of list) {
		if (isOpaqueAttachment(a)) continue;
		const y = firstLineY.get(a.id);
		for (const id of a.strokeIds) (y !== undefined && y >= seam ? move : hold).add(id);
	}
	return { move, hold };
}
