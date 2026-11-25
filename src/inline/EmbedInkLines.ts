/**
 * READ-ONLY VIEWS DRAW INK ON ITS WORDS.
 *
 * Reading view, embeds, whole-note hover previews and print lay the note's text out by their own rules: blank lines fold
 * into paragraph margins, the Properties block is another element, headings and lists take other room. Ink held at its
 * page position came off its words there, by more the further down the note it sat.
 *
 * A stroke that carries a line anchor (Stroke.ts, LineAnchor.ts) is drawn in such a view at its page position plus one
 * correction: the top of its anchor line as this view lays it out, minus the line's top saved in the anchor. The same
 * shape as the editor's correction, read against the rendered blocks instead of the editor's lines. Points, bbox and the
 * file are untouched: the shown strokes are copies, and nothing here writes. Ink never follows text: this is a second
 * view drawing the same ink on the same words.
 *
 * Where a line's top comes from, in a view that knows each rendered block's source lines (0-based, inclusive):
 *  - the first source line of a block: the block's top, exact;
 *  - a later line of a block whose element shows one row per source line (`rowTopIn`): the block's top plus that
 *    row's offset in it, exact. A flat list's items, a code block's rows, a paragraph's lines after its hard breaks;
 *  - any other later line of a block of several source lines (a nested or loose list, a table, a quote): the block's
 *    top plus the line's share of the block's height, an estimate;
 *  - a blank line (no block), when every line between it and the block is blank (or frontmatter): the block below when
 *    it is the line right above that block; else the block above, at its distance under it; with no block above, the
 *    block below's top plus the run's blank lines above it, frontmatter not counted. The distance is the lines between
 *    times the block's line height, an estimate. A line of text whose block is not laid out has no top: the stroke keeps
 *    its page position.
 *
 * Guards, each falling back to the page position: an anchor on the stroke; its line inside the text; the stroke's own y
 * where the anchor says (a move by a build that does not know the field breaks the match, as in the editor); the
 * anchored line's text hashing to the anchor's key (the editor's own keyer); when the anchor carries a lines-above hash,
 * the text of every line above it hashing to it, so an edit above made where no anchor followed it keeps the page position
 * (an older build's anchor, without the hash, reads as that build read it); the line not a frontmatter line (the
 * Properties block is laid out by its own rules, and a fence read as a blank line rode the first paragraph's top).
 *
 * The signature, as the editor honours anchors (LineAnchor.ts underRatio): an anchor's top is its line's top under
 * the width and font it was taken at, so a later line's top carries that width's wrap. The editor leaves a stroke whose
 * anchor was taken under another width where it was drawn, unless width and font moved by one ratio (another text size
 * under a column held at the note's width times that ratio); this view does the same. The signature is the editor's
 * when one is open on the note (it keeps its last measured one while hidden in Reading view: a width of 0 is never
 * taken), else the newest anchored stroke's width and font.
 *
 * Stored coordinates and the anchor's top are world units: one px at the note's reference font. A view whose text is
 * at another size draws the ink at that size over the reference, as the editor does (`zoom`), so the correction is in
 * world units too: the line's top in this view, px, over the zoom, minus the anchor's top. At zoom 1 that is the px
 * correction itself.
 *
 * Everything here is numbers in and numbers out. EmbedInk.ts measures the blocks and hands their geometry in as
 * functions, so a block no stroke needs is never measured.
 */
import type { InkStroke } from "../ink/Stroke";
import { strokeRev } from "../ink/StrokeRev";
import { alignShown, cellStart, isOpaqueAttachment, resolveTarget, startsUndrawn, tableAround, tableCellIn, type AttachmentData } from "./InkAttachments";
import { aboveOf, lineKey, newAboveRun, shiftedStroke, underRatio, type AboveRun, type LineSignature } from "./LineAnchor";

/** A rendered block's place, px, in the layer's own frame (the frame the ink is drawn in). */
export interface BlockBox {
	top: number;
	height: number;
}

/** One rendered block: its source lines, 0-based and inclusive, and its geometry, read only when a stroke needs it. */
export interface BlockLines {
	lineStart: number;
	lineEnd: number;
	/** The block's box in the layer's frame, or null when it is not laid out. */
	box(): BlockBox | null;
	/** One rendered line's height, px: what a blank line between two blocks is taken to be. */
	lineHeight(): number;
	/** The rows the block's element shows, by its kind, or null for an element of no such kind. Read only for a later line. */
	rows?(): BlockRows | null;
	/**
	 * The block's `index`-th table of the `count` its source lines hold, when the block draws its own tables one to one
	 * with them (`count` of them, an embed's, a quote's and a callout's left out) and that one shows `rows` rows (the
	 * header first) of `ncol` cells as its source reads; null otherwise. Read only for a link inside one of its cells
	 * (`tableMoves`).
	 */
	table?(index: number, count: number, rows: number, ncol: number): BlockTable | null;
}

/** A table a block draws, its cells by shown row (0 the header) and column. */
export interface BlockTable {
	/** The cell's drawn text, null for a cell not drawn. */
	text(row: number, col: number): string | null;
	/** The top-left of the cell's `k`-th drawn character, px in the layer's frame; null when it is not laid out. */
	charAt(row: number, col: number, k: number): { left: number; top: number } | null;
}

/**
 * The rows a block's element shows: a list's items, a code block's rows of code, a paragraph's lines as its hard breaks
 * start them. `count` is how many the element holds; `top(k)` is the k-th one's top from the block's top, px, or null
 * when it is not laid out.
 */
export interface BlockRows {
	kind: "list" | "code" | "breaks";
	count: number;
	top(k: number): number | null;
}

/** A fenced code block's opening or closing line. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Line `i`'s top from its block's top, px, where the block's element shows one row per source line: exact. Null where
 * the rows do not pair one to one with the block's lines (a nested, loose or continued list; a paragraph whose lines
 * are joined without hard breaks; a code block whose text is not its rows), and for a line no row shows (a closing
 * fence).
 */
export function rowTopIn(lines: readonly string[], b: BlockLines, i: number): number | null {
	const rows = b.rows?.() ?? null;
	if (!rows) return null;
	const n = b.lineEnd - b.lineStart + 1;
	let k = i - b.lineStart;
	if (rows.kind === "code") {
		// The fences are lines of the block and rows of none; an unclosed fence runs to the block's end.
		const open = FENCE.test(lines[b.lineStart] ?? "");
		const close = open && n > 1 && FENCE.test(lines[b.lineEnd] ?? "");
		if (rows.count !== n - (open ? 1 : 0) - (close ? 1 : 0)) return null;
		if (open) k -= 1;
	} else if (rows.count !== n) return null;
	if (k < 0 || k >= rows.count) return null;
	const top = rows.top(k);
	return top !== null && Number.isFinite(top) ? top : null;
}

/** What a view knows of the note's lines: the text, its rendered blocks in source order, and frontmatter. */
export interface LineSpans {
	/** The note's text, one entry per line, as the editor numbers them less one. */
	lines: readonly string[];
	/** The rendered blocks, ordered by lineStart, not overlapping. */
	blocks: readonly BlockLines[];
	/** Lines that have no block and are crossed as blank by the walk: frontmatter, 0-based and inclusive. */
	skip: readonly { from: number; to: number }[];
}

/** A stroke moved by an anchor further than this from the stroke's own bbox is not the stroke the anchor was taken on. */
const Y_SLACK = 0.5;
/** Corrections closer than this, world units, are the same correction: a reloaded anchor's float noise shows 0. */
const SAME_DY = 1e-3;

/**
 * The note's text as lines, numbered as the editor and the renderer number them: split at each line feed, a carriage
 * return before it dropped (the editor's line holds none; the renderer's line numbers count line feeds only).
 */
export function splitLines(text: string): string[] {
	const out = text.split("\n");
	for (let i = 0; i < out.length; i++) {
		const l = out[i]!;
		if (l.endsWith("\r")) out[i] = l.slice(0, -1);
	}
	return out;
}

function blankLine(spans: LineSpans, i: number): boolean {
	for (const r of spans.skip) if (i >= r.from && i <= r.to) return true;
	const l = spans.lines[i];
	return l !== undefined && l.trim() === "";
}

/** The index of the block holding line `i`, or of the last block above it as a negative `-(index + 2)`. */
function blockAt(blocks: readonly BlockLines[], i: number): number {
	let lo = 0, hi = blocks.length - 1, above = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const b = blocks[mid]!;
		if (i < b.lineStart) hi = mid - 1;
		else if (i > b.lineEnd) {
			above = mid;
			lo = mid + 1;
		} else return mid;
	}
	return -(above + 2);
}

/**
 * The top of 0-based line `i` in the layer's frame, px, as this view lays it out; null when the view gives the line no
 * top (no block, not blank, nothing laid out on a clear path of blank lines).
 */
export function lineTopIn(spans: LineSpans, i: number): number | null {
	if (!Number.isInteger(i) || i < 0 || i >= spans.lines.length) return null;
	const at = blockAt(spans.blocks, i);
	if (at >= 0) {
		const b = spans.blocks[at]!;
		const box = b.box();
		if (!box) return null;
		if (i === b.lineStart) return box.top;
		const row = rowTopIn(spans.lines, b, i);
		if (row !== null) return box.top + row;
		// An estimate: the block's lines are taken to share its height evenly.
		return box.top + ((i - b.lineStart) * box.height) / (b.lineEnd - b.lineStart + 1);
	}
	if (!blankLine(spans, i)) return null;
	const aboveAt = -at - 2;
	const above = aboveAt >= 0 ? spans.blocks[aboveAt]! : null;
	const below = spans.blocks[aboveAt + 1] ?? null;
	const clear = (from: number, to: number): boolean => {
		for (let j = from; j <= to; j++) if (!blankLine(spans, j)) return false;
		return true;
	};
	const up = above && clear(above.lineEnd + 1, i - 1) ? i - above.lineEnd : Infinity;
	const down = below && clear(i + 1, below.lineStart - 1) ? below.lineStart - i : Infinity;
	if (up === Infinity && down === Infinity) return null;
	// Issue 67 (2026-11-22). The line right above a block rides it: ink written on a word pokes its top into that
	// line (the 10-18 case). Any other blank line keeps its distance under the block above; with no
	// block above on a clear path, the run of blank lines counts down from the block below's top, frontmatter not counted.
	// So a view that folds the blank lines never draws ink above where it was drawn under the text above it, nor above
	// the first block when the note starts blank. All are estimates: the editor's distance is taken as the lines between
	// times the block's rendered line height.
	if (down === 1) {
		const box = below!.box();
		return box ? box.top - below!.lineHeight() : null;
	}
	if (up !== Infinity) {
		const box = above!.box();
		return box ? box.top + box.height + (up - 1) * above!.lineHeight() : null;
	}
	let run = 0;
	for (let j = i - 1; j >= 0 && blankLine(spans, j); j--) if (!spans.skip.some((r) => j >= r.from && j <= r.to)) run++;
	const box = below!.box();
	return box ? box.top + run * below!.lineHeight() : null;
}

/** Each text's lines-above hashes (LineAnchor.ts aboveOf), by its lines array, built as far down as an anchor asks. */
const aboveRuns = new WeakMap<readonly string[], AboveRun>();

/** Line `i`'s (0-based) lines-above hash in the view's text. */
function aboveIn(lines: readonly string[], i: number): number {
	let run = aboveRuns.get(lines);
	if (!run) aboveRuns.set(lines, (run = newAboveRun()));
	return aboveOf(run, i + 1, (k) => lineKey(lines[k - 1]!));
}

/**
 * The correction a stroke is shown with in this view, world units, for a view drawing world units at `zoom` px each:
 * 0 when any guard fails. `sig` is the signature anchors are honoured under (`shownStrokes` always gives one: null
 * honours none); left out, the anchor's own is taken, for a caller reading one stroke's correction alone.
 */
export function embedInkDy(s: InkStroke, spans: LineSpans | null, zoom = 1, sig?: LineSignature | null): number {
	return anchoredDy(s, spans, zoom, sig) ?? 0;
}

/** As embedInkDy, but null when a guard fails: 0 then means the anchor holds and its line has not moved. */
function anchoredDy(s: InkStroke, spans: LineSpans | null, zoom: number, sig?: LineSignature | null): number | null {
	const a = s.lineAnchor;
	if (!a || !spans) return null;
	if (sig !== undefined && !underRatio(a, sig)) return null;
	if (!Number.isInteger(a.line) || a.line < 1 || a.line > spans.lines.length) return null;
	if (Math.abs(a.y - s.bbox.y) > Y_SLACK) return null;
	// The anchor's line is 1-based (the editor's); the view's lines are 0-based (the renderer's).
	const i = a.line - 1;
	if (spans.skip.some((r) => i >= r.from && i <= r.to)) return null;
	if (lineKey(spans.lines[i]!) !== a.key) return null;
	if (a.above !== undefined && a.above !== aboveIn(spans.lines, i)) return null;
	const top = lineTopIn(spans, i);
	if (top === null) return null;
	const dy = top / zoom - a.top;
	if (!Number.isFinite(dy)) return null;
	return Math.abs(dy) < SAME_DY ? 0 : dy;
}

/** Shown copies, one per stroke shown away from its page position, kept while its correction and geometry stand. */
const copies = new WeakMap<InkStroke, { dx: number; dy: number; rev: number; copy: InkStroke }>();

/**
 * Each member's sideways correction, world units: its group's kept dx (the record's `shown`), the move the editor shows
 * it at sideways. Its dy is never taken here: the member's anchor, taken at the place its group shows it, carries it.
 * Null when no group is moved sideways.
 */
export function attachedDx(records: readonly AttachmentData[] | null | undefined): ReadonlyMap<string, number> | null {
	if (!records) return null;
	let out: Map<string, number> | null = null;
	for (const r of records) {
		if (isOpaqueAttachment(r)) continue;
		const dx = r.shown?.dx ?? 0;
		if (!Number.isFinite(dx) || Math.abs(dx) < SAME_DY) continue;
		for (const id of r.strokeIds) (out ??= new Map()).set(id, dx);
	}
	return out;
}

/** Whether any group's target is a range of text: one that may lie inside a table cell (`tableMoves`). */
export function mayLinkInTable(records: readonly AttachmentData[] | null | undefined): boolean {
	return !!records?.some((r) => !isOpaqueAttachment(r) && r.target.kind === "range" && r.target.to > r.target.from);
}

/** Each text's lines joined as the editor's document holds them, by its lines array. */
const joined = new WeakMap<readonly string[], string>();

/**
 * The index in the cell's drawn text of the character a link's reference point was read at: the target's first, when
 * every character of the target is drawn one to one; for a target that is the cell's whole text, its first drawn
 * character (as the editor reads it). -1 otherwise: the view does not draw the word as the text has it.
 */
function drawnAt(map: Int32Array, from: number, to: number, whole: boolean): number {
	let all = true;
	for (let i = from; i < to && all; i++) all = map[i]! >= 0;
	if (all) return map[from]!;
	if (!whole) return -1;
	for (let i = from; i < map.length; i++) if (map[i]! >= 0) return map[i]!;
	return -1;
}

/**
 * The tables the source holds in lines `a` to `b` (0-based, inclusive) of `text`, which is `lines` joined: each one's
 * first offset, in order. A table is read as `tableAround` reads one (none in a code fence's text or a quote).
 */
function sourceTables(text: string, lines: readonly string[], a: number, b: number): readonly number[] {
	const out: number[] = [];
	let at = 0;
	for (let i = 0; i < a && i < lines.length; i++) at += lines[i]!.length + 1;
	for (let i = a; i <= b && i < lines.length; ) {
		const t = lines[i]!.includes("|") ? tableAround(text, at) : null;
		if (!t) {
			at += lines[i]!.length + 1;
			i++;
			continue;
		}
		if (out[out.length - 1] !== t.from) out.push(t.from);
		// The table's other lines are its own: step past them.
		while (i <= b && i < lines.length && at <= t.to) {
			at += lines[i]!.length + 1;
			i++;
		}
	}
	return out;
}

/**
 * Each member's correction, world units, for a group whose target lies inside one table cell: the word as the table this
 * view draws places it, less the group's reference point (the word's place when the group last settled, which its
 * members' stored points settled with). No anchor and no kept move an editor wrote is read. A group is left out (it is
 * drawn as before) when its layout is one `sig` does not honour, its target is not found in the view's text (it needs
 * reattachment), it is not inside one cell (a link made before tables were read: the whole table, a pipe), it starts at
 * a character its cell does not draw (made by 1.5.1: startsUndrawn), the view's block draws its own tables in another
 * count than its source lines hold (a raw HTML table, text the source reads as a table and the view does not), or the
 * view does not draw its table, its cell or its word as the text has them. The table is the block's drawn table of the
 * index the target's table has among the source's tables in the block's lines (two tables in one list block). Null
 * when no group is placed so.
 */
export function tableMoves(records: readonly AttachmentData[] | null | undefined, spans: LineSpans | null, zoom: number, sig: LineSignature | null): ReadonlyMap<string, { dx: number; dy: number }> | null {
	if (!spans || !mayLinkInTable(records)) return null;
	let text = joined.get(spans.lines);
	let out: Map<string, { dx: number; dy: number }> | null = null;
	const inBlock = new Map<number, readonly number[]>();
	for (const r of records!) {
		if (isOpaqueAttachment(r) || r.target.kind !== "range" || r.target.to <= r.target.from) continue;
		if (!r.layout || !underRatio({ width: r.layout.width, fontPx: r.layout.font }, sig)) continue;
		if (text === undefined) joined.set(spans.lines, (text = spans.lines.join("\n")));
		const target = resolveTarget(r.target, text);
		const t = target && tableAround(text, target.from), cell = t && tableCellIn(t, target.from, target.to);
		// A target starting at a character its cell does not draw was made before cell targets started at a drawn one
		// (1.5.1's Source Attach on a word with markup): drawn as before, at its stored place.
		if (!target || !t || !cell || startsUndrawn(text, cell, target.from)) continue;
		let line = 0;
		for (let i = text.indexOf("\n"); i !== -1 && i < target.from; i = text.indexOf("\n", i + 1)) line++;
		const at = blockAt(spans.blocks, line), b = at >= 0 ? spans.blocks[at]! : null;
		let own = b ? inBlock.get(at) : undefined;
		if (b && !own) inBlock.set(at, (own = sourceTables(text, spans.lines, b.lineStart, b.lineEnd)));
		const index = own ? own.indexOf(t.from) : -1;
		const table = b && own && index >= 0 ? b.table?.(index, own.length, t.rows.length, t.ncol) ?? null : null;
		const shown = table?.text(cell.row, cell.col) ?? null;
		if (!table || shown === null) continue;
		const k = drawnAt(alignShown(text.slice(cell.from, cell.to), shown), target.from - cell.from, target.to - cell.from, target.from === cellStart(text, cell) && target.to === cell.to);
		const p = k >= 0 ? table.charAt(cell.row, cell.col, k) : null;
		if (!p) continue;
		const dx = p.left / zoom - r.ref.x, dy = p.top / zoom - r.ref.y;
		if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
		for (const id of r.strokeIds) (out ??= new Map()).set(id, { dx: Math.abs(dx) < SAME_DY ? 0 : dx, dy: Math.abs(dy) < SAME_DY ? 0 : dy });
	}
	return out;
}

/**
 * The signature anchors are honoured under with no editor open on the note: the newest anchored stroke's width and
 * font, the width exact (no character width is known here). Null when no stroke carries an anchor.
 */
export function newestAnchorSignature(strokes: readonly InkStroke[]): LineSignature | null {
	let newest: InkStroke | null = null;
	for (const s of strokes) if (s.lineAnchor && (!newest || s.createdAt >= newest.createdAt)) newest = s;
	const a = newest?.lineAnchor;
	return a ? { width: a.width, fontPx: a.fontPx, charWidth: 0 } : null;
}

/**
 * The strokes as this view shows them: the list itself when no correction moves any, else a new list holding a copy of
 * each moved stroke (the stored one untouched) and every other stroke as it is. `zoom` as for `embedInkDy`. `live` is
 * the signature of an editor open on the note, or null for none (the newest anchored stroke's is taken). `records` are
 * the note's attached groups: a member is drawn at its anchor's dy plus its group's kept dx (`attachedDx`), the dx only
 * while its anchor passes every guard; a member with an anchor, of a group inside a table cell, by the table this view
 * draws (`tableMoves`). A member with no anchor is drawn at its stored place, as before tables were read.
 */
export function shownStrokes(strokes: readonly InkStroke[], spans: LineSpans | null, zoom = 1, live: LineSignature | null = null, records?: readonly AttachmentData[] | null): readonly InkStroke[] {
	if (!spans) return strokes;
	const sig = live ?? newestAnchorSignature(strokes);
	const dxs = attachedDx(records), cells = tableMoves(records, spans, zoom, sig);
	let out: InkStroke[] | null = null;
	for (let k = 0; k < strokes.length; k++) {
		const s = strokes[k]!, cell = s.lineAnchor ? cells?.get(s.id) : undefined;
		// A member's dx is its group's shown move, which its anchor was taken at: with the anchor failing a guard (an edit
		// made outside the plugin, another width or font) the member is drawn at its stored place, never moved sideways only.
		const a = cell ? null : anchoredDy(s, spans, zoom, sig);
		const dy = cell ? cell.dy : a ?? 0, dx = cell ? cell.dx : a === null ? 0 : dxs?.get(s.id) ?? 0;
		if (dy === 0 && dx === 0) {
			if (out) out.push(s);
			continue;
		}
		out ??= strokes.slice(0, k);
		const rev = strokeRev(s), held = copies.get(s);
		if (held && held.dy === dy && held.dx === dx && held.rev === rev) {
			out.push(held.copy);
			continue;
		}
		const copy = shiftedStroke(s, dy, dx);
		copies.set(s, { dx, dy, rev, copy });
		out.push(copy);
	}
	return out ?? strokes;
}

/** One of the note's sections as Obsidian's metadata cache holds it: its type and its lines, 0-based and inclusive. */
export interface CachedSection {
	type: string;
	lineStart: number;
	lineEnd: number;
}

/** Cached sections a render draws no top-level element for. */
const UNRENDERED = new Set(["yaml", "comment", "footnoteDefinition"]);

/** The element a section of each bound type renders as; every other type (a paragraph among them) takes any element. */
const RENDERED_AS: Record<string, RegExp> = {
	heading: /^H[1-6]$/,
	list: /^(UL|OL)$/,
	code: /^PRE$/,
	table: /^TABLE$/,
	thematicBreak: /^HR$/,
};

/**
 * For a render that gives no section info (an embed, an export): the cached sections laid onto the render's top-level
 * blocks in order. `tags` holds, per block, its own tag and its first element child's (a print wraps each block in a
 * div). Null unless every block pairs with one section and each pair agrees on type: one mismatch and the whole render
 * keeps page positions.
 */
export function mapCachedSections(
	sections: readonly CachedSection[],
	tags: readonly (readonly [string, string | null])[]
): CachedSection[] | null {
	const rendered = sections.filter((s) => !UNRENDERED.has(s.type));
	if (rendered.length !== tags.length) return null;
	for (let k = 0; k < rendered.length; k++) {
		const want = RENDERED_AS[rendered[k]!.type];
		if (!want) continue;
		const [own, child] = tags[k]!;
		if (!want.test(own.toUpperCase()) && !(child !== null && want.test(child.toUpperCase()))) return null;
	}
	return rendered;
}

/** The frontmatter's lines, 0-based and inclusive, when the note opens with it; null otherwise. */
export function frontmatterOf(lines: readonly string[]): { from: number; to: number } | null {
	if (lines[0] !== "---") return null;
	for (let i = 1; i < lines.length; i++) if (lines[i] === "---" || lines[i] === "...") return { from: 0, to: i };
	return null;
}

/**
 * The lines of a render that gives no section info, from the note's cached sections and text laid onto its top-level
 * blocks (`mapCachedSections`). Null while the text is not read yet, and when the sections do not match the blocks:
 * the render keeps page positions until both hold.
 */
export function spansFromCache<B>(
	cache: { sections: readonly CachedSection[]; text: string } | null,
	blocks: readonly B[],
	tagsOf: (block: B) => readonly [string, string | null],
	linesOf: (block: B, lineStart: number, lineEnd: number) => BlockLines
): LineSpans | null {
	if (!cache) return null;
	const mapped = mapCachedSections(cache.sections, blocks.map(tagsOf));
	if (!mapped) return null;
	const lines = splitLines(cache.text);
	const skip = frontmatterOf(lines);
	return { lines, blocks: mapped.map((s, k) => linesOf(blocks[k]!, s.lineStart, s.lineEnd)), skip: skip ? [skip] : [] };
}
