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
 *  - a blank line (no block): the nearest block by source lines, a tie going down, when every line between is blank
 *    (or frontmatter); the distance to that block's edge is the blank lines between times the block's line height, an
 *    estimate. A line of text whose block is not laid out has no top: the stroke keeps its page position.
 *
 * Guards, each falling back to the page position: an anchor on the stroke; its line inside the text; the stroke's own y
 * where the anchor says (a move by a build that does not know the field breaks the match, as in the editor); the
 * anchored line's text hashing to the anchor's key (the editor's own keyer); when the anchor carries a lines-above hash,
 * the text of every line above it hashing to it, so an edit above made where no anchor followed it keeps the page position
 * (an older build's anchor, without the hash, reads as that build read it); the line not a frontmatter line (the
 * Properties block is laid out by its own rules, and a fence read as a blank line rode the first paragraph's top).
 *
 * The signature, as the editor honours anchors (LineAnchor.ts underSignature): an anchor's top is its line's top under
 * the width and font it was taken at, so a later line's top carries that width's wrap. The editor leaves a stroke whose
 * anchor was taken under another width where it was drawn; this view does the same. The signature is the editor's
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
import { aboveOf, lineKey, newAboveRun, shiftedStroke, underSignature, type AboveRun, type LineSignature } from "./LineAnchor";

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
	// The nearer block, a tie going down. Both are estimates: the editor's distance from the blank line's top to the
	// block's edge is taken as the blank lines between times the block's rendered line height.
	if (down <= up) {
		const box = below!.box();
		return box ? box.top - down * below!.lineHeight() : null;
	}
	const box = above!.box();
	return box ? box.top + box.height + (up - 1) * above!.lineHeight() : null;
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
	const a = s.lineAnchor;
	if (!a || !spans) return 0;
	if (sig !== undefined && !underSignature(a, sig)) return 0;
	if (!Number.isInteger(a.line) || a.line < 1 || a.line > spans.lines.length) return 0;
	if (Math.abs(a.y - s.bbox.y) > Y_SLACK) return 0;
	// The anchor's line is 1-based (the editor's); the view's lines are 0-based (the renderer's).
	const i = a.line - 1;
	if (spans.skip.some((r) => i >= r.from && i <= r.to)) return 0;
	if (lineKey(spans.lines[i]!) !== a.key) return 0;
	if (a.above !== undefined && a.above !== aboveIn(spans.lines, i)) return 0;
	const top = lineTopIn(spans, i);
	if (top === null) return 0;
	const dy = top / zoom - a.top;
	if (!Number.isFinite(dy) || Math.abs(dy) < SAME_DY) return 0;
	return dy;
}

/** Shown copies, one per stroke shown away from its page position, kept while its correction and geometry stand. */
const copies = new WeakMap<InkStroke, { dy: number; rev: number; copy: InkStroke }>();

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
 * the signature of an editor open on the note, or null for none (the newest anchored stroke's is taken).
 */
export function shownStrokes(strokes: readonly InkStroke[], spans: LineSpans | null, zoom = 1, live: LineSignature | null = null): readonly InkStroke[] {
	if (!spans) return strokes;
	const sig = live ?? newestAnchorSignature(strokes);
	let out: InkStroke[] | null = null;
	for (let k = 0; k < strokes.length; k++) {
		const s = strokes[k]!;
		const dy = embedInkDy(s, spans, zoom, sig);
		if (dy === 0) {
			if (out) out.push(s);
			continue;
		}
		out ??= strokes.slice(0, k);
		const rev = strokeRev(s), held = copies.get(s);
		if (held && held.dy === dy && held.rev === rev) {
			out.push(held.copy);
			continue;
		}
		const copy = shiftedStroke(s, dy);
		copies.set(s, { dy, rev, copy });
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
