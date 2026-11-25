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
export function mapTarget(target: AttachmentTarget, changes: ChangeDesc, swaps?: LinkSwaps): AttachmentTarget {
	if (target.to > target.from) {
		let replaced = false;
		changes.iterChangedRanges((fromA, toA) => {
			if (fromA <= target.from && toA >= target.to) replaced = true;
		});
		if (replaced) {
			// A picture's link replaced whole by a link to the same file (a resize): the target is the new link.
			const s = swaps?.find((w) => w.fromA === target.from && w.toA === target.to);
			if (s) return { ...target, from: s.fromB, to: s.toB };
			const at = changes.mapPos(target.from, 1);
			return { ...target, from: at, to: at };
		}
	}
	const from = changes.mapPos(target.from, 1), to = Math.max(from, changes.mapPos(target.to, -1));
	return from === target.from && to === target.to ? target : { ...target, from, to };
}

/** A picture link replaced whole by a link to the same file: the old link's range and the new one's. */
export interface LinkSwap {
	fromA: number;
	toA: number;
	fromB: number;
	toB: number;
}

export type LinkSwaps = readonly LinkSwap[];

/** The extensions Obsidian embeds as a picture (its own list, 1.15), compared in lower case as Obsidian does. */
const PICTURE_EXTENSIONS = new Set(["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"]);

/** The longest changed text read for a swap: a resize rewrites one link, so a long paste costs nothing. */
const SWAP_MAX = 1024;

/**
 * The file a picture link shows, or null when `text` is not exactly one picture link. Wiki form `![[path]]` or
 * `![[path|...]]`: the path before the first `|`. Markdown form `![alt](path)`, `![alt](<path>)`, with any alt and an
 * optional title: the link destination. Each answer is prefixed by its form, so only links of the same form compare
 * equal. The path's extension, in lower case, must be one Obsidian embeds as a picture.
 */
export function pictureLinkFile(text: string): string | null {
	let form: string, path: string;
	const wiki = /^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(text);
	if (wiki) { form = "w"; path = wiki[1]!; }
	else {
		const md = /^!\[[^\]]*\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)$/.exec(text);
		if (!md) return null;
		form = "m";
		path = md[1]!.startsWith("<") ? md[1]!.slice(1, -1) : md[1]!;
	}
	const dot = path.lastIndexOf(".");
	if (dot < 0 || !PICTURE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())) return null;
	return `${form}:${path}`;
}

/**
 * The change's picture links replaced whole by a link to the same file (a resize: the size added, changed or removed),
 * or null for none. Read only when the change holds one changed range alone, replacing text with text, of at most
 * SWAP_MAX characters each side: a resize, its undo and its redo are each one replace; a line move is two, and two
 * lines holding the same picture swapped by it collapse as any other whole replace does.
 */
export function sameFileLinkSwaps(changes: ChangeDesc, before: { sliceString(from: number, to: number): string }, after: { sliceString(from: number, to: number): string }): LinkSwaps | null {
	const ranges: LinkSwap[] = [];
	changes.iterChangedRanges((fromA, toA, fromB, toB) => { ranges.push({ fromA, toA, fromB, toB }); });
	if (ranges.length !== 1) return null;
	const out: LinkSwap[] = [];
	for (const w of ranges) {
		if (w.toA <= w.fromA || w.toB <= w.fromB || w.toA - w.fromA > SWAP_MAX || w.toB - w.fromB > SWAP_MAX) continue;
		const was = pictureLinkFile(before.sliceString(w.fromA, w.toA));
		if (was !== null && was === pictureLinkFile(after.sliceString(w.fromB, w.toB))) out.push(w);
	}
	return out.length > 0 ? out : null;
}

/** Every v1 record's target mapped through one change; a record whose target did not move is returned as it was. */
export function mapAttachments(list: AttachmentData[], changes: ChangeDesc, swaps?: LinkSwaps): AttachmentData[] {
	if (changes.empty) return list;
	let out: AttachmentData[] | null = null;
	for (let i = 0; i < list.length; i++) {
		const a = list[i]!;
		if (isOpaqueAttachment(a)) continue;
		const target = mapTarget(a.target, changes, swaps);
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

/** Text a change inserted: its range in the new document (`[from, to)`, the change's fromB to toB) and the text. */
export interface InsertedText {
	from: number;
	to: number;
	text: string;
}

/**
 * Targets an edit collapsed (their text deleted), looked for again when a change inserts text holding their words: the
 * undo of the delete, or the cut text pasted elsewhere. The one place holding the old text with its context, when it lies
 * whole inside a range the change inserted: the target takes it, so the group follows its words again in the session.
 * The same words left standing outside the change (a second week's copy of a rewritten line) are not taken: the target
 * stays collapsed. A change whose text holds no collapsed target's words costs no search.
 */
export function refindCollapsed(list: readonly AttachmentData[], inserted: readonly InsertedText[], doc: () => string): readonly AttachmentData[] {
	let out: AttachmentData[] | null = null, text: string | null = null, built: FlatText | null = null;
	for (let i = 0; i < list.length; i++) {
		const a = list[i]!;
		if (isOpaqueAttachment(a) || a.target.from !== a.target.to) continue;
		const core = normalizeText(a.target.text).trim();
		if (core === "" || !inserted.some((t) => normalizeText(t.text).includes(core))) continue;
		const d = (text ??= doc());
		const found = resolveTarget(a.target, d, () => (built ??= flatText(d)));
		if (found && found.to > found.from && inserted.some((t) => t.from <= found.from && found.to <= t.to)) (out ??= list.slice())[i] = { ...a, target: found };
	}
	return out ?? list;
}

/** One cell of a markdown table as its source holds it: its shown row (0 the header), its column, its text trimmed. */
export interface TableCell {
	row: number;
	col: number;
	/** Document offsets of the cell's text, `[from, to)`, its edge spaces left out; from equal to to for an empty cell. */
	from: number;
	to: number;
}

/**
 * A markdown table's source read as GFM reads it: the header's cell count is the table's; a body row's cells past it are
 * not drawn (left out here) and the ones it lacks are drawn empty (absent here). The separator row is no shown row.
 */
export interface TableRows {
	from: number;
	to: number;
	ncol: number;
	rows: TableCell[][];
}

const SEPARATOR_CELL = /^:?-+:?$/;

/** One row's cells, `[from, to)` of each cell's text in `src` plus `base`: unescaped pipes split; outer pipes optional. */
function rowCells(src: string, from: number, to: number, base: number): { from: number; to: number }[] {
	let a = from, b = to;
	while (a < b && /\s/.test(src[a]!)) a++;
	while (b > a && /\s/.test(src[b - 1]!)) b--;
	if (a < b && src[a] === "|") a++;
	if (b > a && src[b - 1] === "|" && src[b - 2] !== "\\") b--;
	const out: { from: number; to: number }[] = [];
	let s = a;
	for (let i = a; i <= b; i++) {
		if (i < b && !(src[i] === "|" && src[i - 1] !== "\\")) continue;
		let x = s, y = i;
		while (x < y && /\s/.test(src[x]!)) x++;
		while (y > x && /\s/.test(src[y - 1]!)) y--;
		out.push({ from: base + x, to: base + y });
		s = i + 1;
	}
	return out;
}

/**
 * `src` (the table's lines, from `base` in the document) as a table: a header row, a separator row of as many cells,
 * then body rows. Null when the second line is no separator for the first.
 */
export function tableRows(src: string, base: number): TableRows | null {
	const lines: { from: number; to: number }[] = [];
	for (let at = 0; ; ) {
		const nl = src.indexOf("\n", at), end = nl < 0 ? src.length : nl;
		lines.push({ from: at, to: end });
		if (nl < 0) break;
		at = nl + 1;
	}
	if (lines.length < 2) return null;
	const head = rowCells(src, lines[0]!.from, lines[0]!.to, 0), sep = rowCells(src, lines[1]!.from, lines[1]!.to, 0);
	if (head.length === 0 || sep.length !== head.length || !sep.every((c) => SEPARATOR_CELL.test(src.slice(c.from, c.to)))) return null;
	const ncol = head.length, rows: TableCell[][] = [];
	lines.forEach((l, i) => {
		if (i === 1) return;
		const row = rows.length;
		rows.push(rowCells(src, l.from, l.to, base).slice(0, ncol).map((c, col) => ({ row, col, from: c.from, to: c.to })));
	});
	return { from: base, to: base + src.length, ncol, rows };
}

/**
 * A code fence's line: its ``` or ~~~ after any indent (a fence in a nested list item sits four or more spaces in) and
 * after any list markers (a fence opened on the item's own line, "- ```"). An indented code block's line holding a fence
 * is taken as one too: the table after it reads as none, drawn as before tables were read.
 */
const FENCE = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)*(```|~~~)/;
/** A line a table runs over in the source: not blank, holding a pipe, not in a quote. */
const tableLine = (l: string) => l.trim() !== "" && l.includes("|") && !/^\s*>/.test(l);

/**
 * The table of `doc` whose lines hold `pos`, read from the text: the run of lines around it that hold a pipe, from the
 * header whose next line is its separator. Null outside a code fence's text, a quote, or any such run.
 */
export function tableAround(doc: string, pos: number): TableRows | null {
	const lineAt = (p: number) => {
		const from = doc.lastIndexOf("\n", p - 1) + 1, nl = doc.indexOf("\n", p);
		return { from, to: nl < 0 ? doc.length : nl };
	};
	const here = lineAt(Math.min(pos, doc.length));
	if (!tableLine(doc.slice(here.from, here.to))) return null;
	const runLines = [here];
	for (let l = here; l.from > 0; ) {
		const up = lineAt(l.from - 1);
		if (!tableLine(doc.slice(up.from, up.to))) break;
		runLines.unshift(up);
		l = up;
	}
	for (let l = here; l.to < doc.length; ) {
		const down = lineAt(l.to + 1);
		if (!tableLine(doc.slice(down.from, down.to))) break;
		runLines.push(down);
		l = down;
	}
	// A code fence opened above the run and not closed: its text, not a table.
	let fences = 0;
	for (const m of doc.slice(0, runLines[0]!.from).split("\n")) if (FENCE.test(m)) fences++;
	if (fences % 2 === 1) return null;
	// The first line of the run followed by its separator is the header: the lines above it are no table.
	for (let h = 0; h + 1 < runLines.length; h++) {
		const a = runLines[h]!.from, t = tableRows(doc.slice(a, runLines[runLines.length - 1]!.to), a);
		if (t) return a <= here.from ? t : null;
	}
	return null;
}

/** The cell of `t` whose text holds `[from, to)` whole, or null (a pipe, padding, more than one cell). */
export function tableCellIn(t: TableRows, from: number, to: number): TableCell | null {
	for (const row of t.rows) for (const c of row) if (c.to > c.from && from >= c.from && to <= c.to) return c;
	return null;
}

/** A cell's words: runs of non-space characters, a `<br>` splitting them and never a word itself. Document offsets. */
export function cellWords(doc: string, cell: { from: number; to: number }): { from: number; to: number }[] {
	const out: { from: number; to: number }[] = [];
	for (const m of doc.slice(cell.from, cell.to).matchAll(/\S+/g)) {
		const at = cell.from + m.index;
		let s = 0;
		for (const br of m[0].matchAll(/<br\s*\/?>/gi)) {
			if (br.index > s) out.push({ from: at + s, to: at + br.index });
			s = br.index + br[0].length;
		}
		if (s < m[0].length) out.push({ from: at + s, to: at + m[0].length });
	}
	return out;
}

/**
 * The document position of the first character at or after `pos` in `cell` that a table draws, as the source alone
 * tells: not hidden (hiddenInCell) and not a mark that opens or closes a pair (marksInCell). A lone mark ("~10", "=5",
 * "_id", an unclosed backtick) is drawn, and so is an escaped one (`\*` draws the `*`). The cell's end when none is.
 * Live Preview reads a position inside a cell at the first drawn character from it (cellCharBox).
 */
export function drawnFrom(doc: string, cell: { from: number; to: number }, pos: number): number {
	const src = doc.slice(cell.from, cell.to), hidden = hiddenInCell(src), marks = marksInCell(src, hidden);
	for (let i = Math.max(0, pos - cell.from); i < src.length; i++) if (!hidden[i] && !marks[i]) return cell.from + i;
	return cell.to;
}

/**
 * The mark characters of a cell's source that its drawing shows as formatting, not as text, as the source alone
 * tells: a code span's backtick runs (a run closed by the next run of the same length; nothing inside the span is a
 * mark), `~~` and `==` pairs, and `*` and `_` runs paired as emphasis (one that opens has a non-space after it, one that
 * closes a non-space before it, and an `_` does not open or close inside a word). A mark that pairs with none is drawn.
 * Hidden and escaped characters are never marks. 1 for each mark character.
 */
function marksInCell(src: string, hidden: Uint8Array): Uint8Array {
	const out = new Uint8Array(src.length), code = new Uint8Array(src.length);
	const plain = (i: number) => !hidden[i] && !(i > 0 && src[i - 1] === "\\" && hidden[i - 1] === 1);
	const runAt = (i: number) => {
		let j = i;
		while (j < src.length && src[j] === src[i] && plain(j)) j++;
		return j - i;
	};
	for (let i = 0; i < src.length;) {
		if (src[i] !== "`" || !plain(i)) { i++; continue; }
		const n = runAt(i);
		let j = i + n, close = -1;
		while (j < src.length && close < 0) {
			if (src[j] !== "`" || !plain(j)) { j++; continue; }
			const m = runAt(j);
			if (m === n) close = j;
			else j += m;
		}
		if (close < 0) { i += n; continue; }
		out.fill(1, i, i + n);
		out.fill(1, close, close + n);
		code.fill(1, i, close + n);
		i = close + n;
	}
	type Run = { ch: string; at: number; n: number };
	const space = (c: string | undefined) => c === undefined || /\s/.test(c);
	const inWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
	const open: Run[] = [];
	for (let i = 0; i < src.length;) {
		const c = src[i]!;
		if (code[i] || !/[*_~=]/.test(c) || !plain(i)) { i++; continue; }
		const n = runAt(i), before = src[i - 1], after = src[i + n];
		i += n;
		if ((c === "~" || c === "=") && n !== 2) continue;
		let opens = !space(after), closes = !space(before);
		if (c === "_") { opens &&= !inWord(before); closes &&= !inWord(after); }
		let left = n, at = i - n;
		for (let k = open.length - 1; closes && left > 0 && k >= 0; k--) {
			const o = open[k]!;
			if (o.ch !== c) continue;
			const m = Math.min(o.n, left);
			out.fill(1, o.at + o.n - m, o.at + o.n);
			out.fill(1, at, at + m);
			o.n -= m;
			left -= m;
			at += m;
			open.length = o.n > 0 ? k + 1 : k;
		}
		if (left > 0 && opens) open.push({ ch: c, at, n: left });
	}
	return out;
}

/**
 * Where a cell target made now starts: the cell's first drawn character (drawnFrom), so every reader reads its
 * reference point at the target's own first character and Source mode and Live Preview land on the same letter. The
 * cell's start when it draws no character.
 */
export function cellStart(doc: string, cell: { from: number; to: number }): number {
	const f = drawnFrom(doc, cell, cell.from);
	return f < cell.to ? f : cell.from;
}

/**
 * Whether a target inside `cell` starting at `from` was made before cell targets started at a drawn character (1.5.1's
 * Source Attach on a word with markup: "**beta**", "[gamma](g.md)"): its first character is not drawn. Such a target is
 * read as 1.5.1 read it, in every mode and view, so its saved ink does not move.
 */
export function startsUndrawn(doc: string, cell: { from: number; to: number }, from: number): boolean {
	return drawnFrom(doc, cell, from) !== from;
}

/** An HTML entity (a name, a decimal or a hex number, then `;`); hiddenInCell skips one with `\` right before it. */
const ENTITY = /&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/g;

/**
 * The characters of a cell's source that its drawing never shows as text, as the source alone tells: an HTML tag (a
 * `<br>` among them), a link's brackets, address and title, a wikilink's brackets and the target its alias covers (an
 * embed's size), an entity's name after its `&` (the `&` stands for the one character drawn), a `%%` comment whole, and
 * the backslash of an escape other than an escaped pipe. 1 for each of them.
 */
export function hiddenInCell(src: string): Uint8Array {
	const out = new Uint8Array(src.length);
	const mark = (a: number, b: number) => out.fill(1, a, b);
	for (const m of src.matchAll(/<\/?[A-Za-z][^<>]*>/g)) mark(m.index, m.index + m[0].length);
	for (const m of src.matchAll(ENTITY)) if (src[m.index - 1] !== "\\") mark(m.index + 1, m.index + m[0].length);
	for (const m of src.matchAll(/%%[\s\S]*?%%/g)) mark(m.index, m.index + m[0].length);
	for (const m of src.matchAll(/(!?)\[\[([^\]]*)\]\]/g)) {
		const open = m.index, inner = open + m[1]!.length + 2, end = open + m[0].length, bar = m[2]!.search(/\\?\|/);
		mark(open, inner);
		mark(end - 2, end);
		if (bar < 0) continue;
		if (m[1]) mark(inner + bar, end - 2);
		else mark(inner, inner + bar + (m[2]![bar] === "\\" ? 2 : 1));
	}
	for (const m of src.matchAll(/(!?)\[([^\]]*)\]\(([^)]*)\)/g)) {
		const text = m.index + m[1]!.length + 1;
		mark(m.index, text);
		mark(text + m[2]!.length, m.index + m[0].length);
	}
	for (let i = 0; i + 1 < src.length; i++) {
		if (src[i] !== "\\") continue;
		if (src[i + 1] !== "|" && /[!-/:-@[-`{-~]/.test(src[i + 1]!)) out[i] = 1;
		i++;
	}
	return out;
}

/**
 * The drawn characters matched in order to the source characters not `hidden`, an escaped pipe's two to the one pipe
 * drawn. `exact`: null unless those source characters are the drawn text, character for character.
 */
function alignInOrder(src: string, shown: string, hidden: Uint8Array, exact: boolean): Int32Array | null {
	const out = new Int32Array(src.length).fill(-1);
	let j = 0;
	for (let i = 0; i < src.length; i++) {
		if (hidden[i]) continue;
		if (j >= shown.length) {
			if (exact) return null;
			break;
		}
		if (src[i] === "\\" && src[i + 1] === "|" && shown[j] === "|") {
			out[i] = out[i + 1] = j++;
			i++;
		} else if (src[i] === shown[j]) out[i] = j++;
		else if (exact) return null;
	}
	return exact && j !== shown.length ? null : out;
}

/** Above this many (source, drawn) pairs a cell is matched in order, not aligned: a byte of choices per pair. */
const ALIGN_PAIRS = 1 << 21;
/** The last cell aligned: the editor asks twice per cell (its resting text and the one shown), most often the same. */
let lastAlign: { src: string; shown: string; out: Int32Array } | null = null;

/**
 * Each character of a cell's source `src` matched, in order, to the cell's drawn text `shown`: its index there, or -1 for
 * a character the drawing does not show (markup, a link's address). An escaped pipe's two characters both match the one
 * pipe drawn. A word is placed one to one only when every character of it matches. The array is shared with the next
 * call on the same text: read it, never write it.
 *
 * A character the source marks as markup (hiddenInCell) takes a drawn character only where no other one can. When the
 * rest of the source is the drawn text, that is the map. Otherwise the match draws every drawn character it can, then
 * takes the fewest markup characters, then leaves its unmatched characters in the fewest runs; of equal matches, the
 * earlier source character. A cell of more than ALIGN_PAIRS pairs is matched in order on the characters not marked.
 */
export function alignShown(src: string, shown: string): Int32Array {
	if (lastAlign && lastAlign.src === src && lastAlign.shown === shown) return lastAlign.out;
	const out = alignCell(src, shown);
	lastAlign = { src, shown, out };
	return out;
}

function alignCell(src: string, shown: string): Int32Array {
	const n = src.length, m = shown.length, out = new Int32Array(n).fill(-1);
	if (src === shown) {
		for (let i = 0; i < n; i++) out[i] = i;
		return out;
	}
	const hidden = hiddenInCell(src);
	const exact = alignInOrder(src, shown, hidden, true);
	if (exact) return exact;
	if ((n + 1) * (m + 1) > ALIGN_PAIRS) return alignInOrder(src, shown, hidden, false)!;
	// Cost to the end from (i, j), by the last step taken (0 a match, 1 a source character skipped, 2 a drawn one): a
	// drawn character left unmatched costs more than every markup match can, a markup match more than every run can, and
	// each run of skips opens at 1.
	const R = n + m + 2, P = R, W = P * (n + 1) + R, w = m + 1;
	const choice = new Uint8Array((n + 1) * w);
	let next2 = [new Float64Array(w), new Float64Array(w), new Float64Array(w)];
	let next1 = [new Float64Array(w), new Float64Array(w), new Float64Array(w)];
	let row = [new Float64Array(w), new Float64Array(w), new Float64Array(w)];
	for (let i = n; i >= 0; i--) {
		for (let j = m; j >= 0; j--) {
			const step = j < m && i < n ? (src[i] === "\\" && src[i + 1] === "|" && shown[j] === "|" ? 2 : src[i] === shown[j] ? 1 : 0) : 0;
			const matched = (step === 2 ? next2[0]![j + 1]! : step === 1 ? next1[0]![j + 1]! : Infinity) + (hidden[i] ? P : 0);
			const skipSrc = i < n ? next1[1]![j]! : Infinity, skipShown = j < m ? W + row[2]![j + 1]! : Infinity;
			let packed = 0;
			for (let s = 0; s < 3; s++) {
				const b = skipSrc + (s === 1 ? 0 : 1), c = skipShown + (s === 2 ? 0 : 1);
				let best = i === n && j === m ? 0 : matched, pick = 0;
				if (b < best) { best = b; pick = 1; }
				if (c < best) { best = c; pick = 2; }
				row[s]![j] = best;
				packed |= pick << (2 * s);
			}
			choice[i * w + j] = packed;
		}
		[next2, next1, row] = [next1, row, next2];
	}
	for (let i = 0, j = 0, s = 0; i < n && j < m; ) {
		const pick = (choice[i * w + j]! >> (2 * s)) & 3;
		if (pick === 0) {
			out[i] = j;
			if (src[i] === "\\" && src[i + 1] === "|" && shown[j] === "|") out[++i] = j;
			i++;
			j++;
		} else if (pick === 1) i++;
		else j++;
		s = pick;
	}
	return out;
}

/**
 * Entries of `ok` paired with entries of `nk` by key (into `out` and `taken`), the rest left to the place rules. First
 * the entries the edit left in place from the start, then from the end (the start first: a row copied below its twin
 * leaves the ink on the upper one, where it was drawn). Then a key the rest of `ok` and `nk` hold as many times, in
 * order, so an entry moved keeps its text and equal entries keep their order. A key the edit added to or took from is
 * not paired here: in order, one entry's ink could be read on its twin.
 */
function pairSameKeys(ok: readonly string[], nk: readonly string[], out: number[], taken: boolean[]): void {
	const pair = (i: number, j: number) => { out[i] = j; taken[j] = true; };
	let p = 0, s = 0;
	for (; p < ok.length && p < nk.length && ok[p] === nk[p]; p++) pair(p, p);
	for (; p + s < ok.length && p + s < nk.length && ok[ok.length - 1 - s] === nk[nk.length - 1 - s]; s++) pair(ok.length - 1 - s, nk.length - 1 - s);
	const byKey = new Map<string, number[]>(), held = new Map<string, number>(), seen = new Map<string, number>();
	for (let j = p; j < nk.length - s; j++) { const l = byKey.get(nk[j]!); if (l) l.push(j); else byKey.set(nk[j]!, [j]); }
	for (let i = p; i < ok.length - s; i++) held.set(ok[i]!, (held.get(ok[i]!) ?? 0) + 1);
	for (let i = p; i < ok.length - s; i++) {
		const k = ok[i]!, l = byKey.get(k), n = seen.get(k) ?? 0;
		seen.set(k, n + 1);
		if (l && l.length === held.get(k)) pair(i, l[n]!);
	}
}

/**
 * Each of `ok` paired with one of `nk` (-1: none): by key (pairSameKeys); then each run of entries left between two
 * paired ones, by its place in the run, when the run between their pairs in `nk` holds as many entries not paired
 * (entries edited in place). Any other entry stays -1: entries neither their text nor their place tells apart are never
 * guessed between.
 */
function pairByKey(ok: readonly string[], nk: readonly string[]): number[] {
	const out = new Array<number>(ok.length).fill(-1), taken = new Array<boolean>(nk.length).fill(false);
	pairSameKeys(ok, nk, out, taken);
	for (let i = 0; i < ok.length; i++) {
		if (out[i]! >= 0) continue;
		let hi = i;
		while (hi < ok.length && out[hi]! < 0) hi++;
		const nlo = i > 0 ? out[i - 1]! : -1, nhi = hi < ok.length ? out[hi]! : nk.length, free: number[] = [];
		for (let j = nlo + 1; j < nhi; j++) if (!taken[j]) free.push(j);
		if (nlo < nhi && free.length === hi - i) free.forEach((j, k) => { out[i + k] = j; taken[j] = true; });
		i = hi;
	}
	return out;
}

/**
 * Where the cell `oc` of the table `ot` (in `oldDoc`) is in `nt` (in `newDoc`), by the table's own shape: columns by
 * their whole column's text (by header when the row count changed), at any column count, so a column moved keeps its
 * words; a column edited in place by its place between columns matched. Rows by their text in the columns kept; an
 * edited row by the one row in its place between rows matched. Null when its column or its row is gone.
 */
function cellMoved(oldDoc: string, ot: TableRows, oc: TableCell, newDoc: string, nt: TableRows): TableCell | null {
	const cellText = (doc: string, t: TableRows, r: number, c: number) => { const x = t.rows[r]?.[c]; return x ? doc.slice(x.from, x.to) : ""; };
	const same = ot.rows.length === nt.rows.length;
	const key = (doc: string, t: TableRows, c: number) => (same ? t.rows.map((_, r) => cellText(doc, t, r, c)).join("\u0000") : cellText(doc, t, 0, c));
	const cols = pairByKey(Array.from({ length: ot.ncol }, (_, c) => key(oldDoc, ot, c)), Array.from({ length: nt.ncol }, (_, c) => key(newDoc, nt, c)));
	const nc = cols[oc.col]!;
	if (nc < 0) return null;
	const kept = cols.map((j, c) => [c, j] as const).filter(([, j]) => j >= 0);
	const okeys = ot.rows.map((_, r) => kept.map(([c]) => cellText(oldDoc, ot, r, c)).join("\u0000"));
	const nkeys = nt.rows.map((_, r) => kept.map(([, j]) => cellText(newDoc, nt, r, j)).join("\u0000"));
	const rows = new Array<number>(ot.rows.length).fill(-1), taken = new Array<boolean>(nt.rows.length).fill(false);
	// Rows by their text (pairSameKeys): a row moved or sorted keeps its words; two equal rows are never swapped.
	pairSameKeys(okeys, nkeys, rows, taken);
	// An edited row: alone in its gap between matched rows, on both sides.
	if (rows[oc.row]! < 0) {
		let lo = oc.row - 1, hi = oc.row + 1;
		while (lo >= 0 && rows[lo]! < 0) lo--;
		while (hi < rows.length && rows[hi]! < 0) hi++;
		const nlo = lo >= 0 ? rows[lo]! : -1, nhi = hi < rows.length ? rows[hi]! : nt.rows.length;
		const oldGap = hi - lo - 1, free: number[] = [];
		for (let j = nlo + 1; j < nhi; j++) if (!taken[j]) free.push(j);
		if (nlo < nhi && free.length === oldGap) rows[oc.row] = free[oc.row - lo - 1]!;
	}
	const nr = rows[oc.row]!;
	const cell = nr >= 0 ? nt.rows[nr]?.[nc] : undefined;
	return cell && cell.to > cell.from ? cell : null;
}

/**
 * Targets inside one table cell that a change collapsed (it replaced their whole text: the app writes every table edit
 * as one replace of the whole table, and a typed character as a replace of its cell), found again in the table after it:
 * the same word in the same cell, by the table's shape (cellMoved), shifted by an edit beside it in the cell (text typed
 * in front of it, as the app writes it: the cell's whole span replaced). A word the edit reached, or one the edit leaves
 * at two places it cannot tell apart: its cell's text. A target that was its cell's whole text: the cell's new text
 * (from its first drawn character, cellStart; a target made before that, from the cell's start). Its cell or row gone: left
 * collapsed (needs reattachment, as today). Targets that were not inside one cell (a whole table, a pipe) are left as
 * the change left them. `before` is the list the change was mapped from.
 *
 * Also a cell target made now that the change left standing but reached at an edge (text typed at its first or last
 * character, which mapping leaves outside it, mapTarget): it stays its cell's text, the new cell's first drawn character
 * to its end. A word, and a target made before cell targets started at a drawn character (1.5.1's), keep the mapping.
 */
export function refindInTables(before: readonly AttachmentData[], mapped: readonly AttachmentData[], oldDoc: () => string, newDoc: () => string, changes: ChangeDesc): readonly AttachmentData[] {
	let out: AttachmentData[] | null = null, od: string | null = null, nd: string | null = null;
	const prev = new Map<string, AttachmentRecord>();
	for (const a of before) if (!isOpaqueAttachment(a)) prev.set(a.id, a);
	for (let i = 0; i < mapped.length; i++) {
		const a = mapped[i]!;
		if (isOpaqueAttachment(a)) continue;
		const b = prev.get(a.id)?.target;
		if (!b || b.kind !== "range" || b.to <= b.from) continue;
		const standing = a.target.from !== a.target.to;
		if (standing && !edgeReached(b, changes)) continue;
		const o = (od ??= oldDoc()), ot = tableAround(o, b.from), oc = ot && tableCellIn(ot, b.from, b.to);
		if (!ot || !oc) continue;
		const n = (nd ??= newDoc()), nt = tableAround(n, Math.min(changes.mapPos(ot.from, -1), n.length));
		const nc = nt && cellMoved(o, ot, oc, n, nt);
		if (!nc) continue;
		const was = o.slice(oc.from, oc.to), now = n.slice(nc.from, nc.to), s0 = b.from - oc.from, s1 = b.to - oc.from;
		// A cell target made now (from its cell's first drawn character) takes the new cell's from its first drawn one; one
		// made before (from the cell's start, its first character not drawn) keeps the cell's start, read as before.
		const old = startsUndrawn(o, oc, b.from), whole = s1 === was.length && (s0 === 0 || b.from === cellStart(o, oc));
		// Left standing: only a cell target made now (its cell's first drawn character to its end, a text no word target
		// has: CELL_TEXT) is taken. A one-word cell's target is its word's twin and keeps the mapping, as before.
		if (standing && (old || !whole || !CELL_TEXT.test(was.slice(s0)))) continue;
		let from = old ? nc.from : cellStart(n, nc), to = nc.to;
		if (!whole) {
			// The edit after the word: the cell's text up to the word's end kept. The edit before it: the text from the word's
			// start kept. Each is read on its own side, so a letter the typed text shares with the word ("big " in front of
			// "beta") does not make the word look reached. Both, at two places: the word cannot be placed one to one, its cell.
			let p = 0, s = 0;
			while (p < was.length && p < now.length && was[p] === now[p]) p++;
			while (s < was.length && s < now.length && was[was.length - 1 - s] === now[now.length - 1 - s]) s++;
			const d = now.length - was.length, after = s1 <= p, ahead = s0 >= was.length - s;
			if (after && (!ahead || d === 0)) { from = nc.from + s0; to = nc.from + s1; }
			else if (ahead && !after) { from = nc.from + s0 + d; to = nc.from + s1 + d; }
		}
		// A target made now never starts at a character the cell does not draw: its start moves on to the next drawn one.
		if (!old && startsUndrawn(n, nc, from)) { const f = drawnFrom(n, nc, from); if (f < to) from = f; }
		if (standing && from === a.target.from && to === a.target.to) continue;
		(out ??= mapped.slice())[i] = { ...a, target: { ...a.target, from, to } };
	}
	return out ?? mapped;
}

/** A cell target's text no word target has: a space between words, or markup (a word holding one takes its cell). */
const CELL_TEXT = /\s|[*_~=`$^[\]()<>\\%&]/;

/** Whether `changes` reach `t`'s first or last character: an edit at its start or its end, which mapping leaves outside it. */
function edgeReached(t: { from: number; to: number }, changes: ChangeDesc): boolean {
	let hit = false;
	changes.iterChangedRanges((fromA, toA) => {
		if ((fromA <= t.from && toA >= t.from) || (fromA <= t.to && toA >= t.to)) hit = true;
	});
	return hit;
}

/**
 * Whether refindInTables has a target to look at that the change left standing: one whose edge the change reached, on a
 * line holding a pipe, its text one no word target has (CELL_TEXT). `lineAt`: the line at a position before the change.
 * Reads one line per such target, never the note's text, and walks no table: a change that reaches no cell target
 * costs one pass over the list.
 */
export function cellEdgeReached(before: readonly AttachmentData[], changes: ChangeDesc, lineAt: (pos: number) => { from: number; text: string }): boolean {
	for (const a of before) {
		if (isOpaqueAttachment(a) || a.target.kind !== "range" || a.target.to <= a.target.from || !edgeReached(a.target, changes)) continue;
		const l = lineAt(a.target.from);
		if (l.text.includes("|") && CELL_TEXT.test(l.text.slice(a.target.from - l.from, a.target.to - l.from))) return true;
	}
	return false;
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
 * What Attach and Detach may do for a selection. Attach is on while anything is selected: it gives the union of the
 * selection and every group it touches, one group, under the first group's id (two groups or more: group attach).
 * Detach is on when every selected stroke belongs to the one group, and on for two groups or more, loose ink selected
 * or not: each group touched detaches whole and the loose ink stays loose.
 */
export function attachmentSelection(list: readonly AttachmentData[], ids: readonly string[]): { attach: boolean; detach: boolean; groupIds: string[]; expandedIds: string[] } {
	const members = attachmentMembership(list), selected = [...new Set(ids)];
	const groupIds = [...new Set(selected.flatMap((id) => (members.has(id) ? [members.get(id)!] : [])))];
	const grouped = new Set(groupIds);
	const expandedIds = [...new Set([...selected, ...list.flatMap((a) => (!isOpaqueAttachment(a) && grouped.has(a.id) ? a.strokeIds : []))])];
	return {
		attach: selected.length > 0,
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
 * it was. The selection never asks for that (a group attach detaches the other groups first, in the same history step);
 * the union of a group and free ink comes under that group's own id. No stroke point changes.
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
