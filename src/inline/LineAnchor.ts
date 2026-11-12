/**
 * INK REMEMBERS ITS LINE (note surface only).
 *
 * The editor guesses the height of every line it has not drawn and corrects the guess when it draws or re-measures the line:
 * a zoom settling, a scroll through lines never drawn, a font or pane change. Each correction moves the text below it in the
 * document while ink, held at a page position, stayed where it was and came off the words it was written on.
 *
 * A stroke now carries a line anchor (Stroke.ts): the line under its bbox top and that line's top, taken when the line was laid
 * out. The note surface shows the stroke at its page position plus one correction, the line's top now minus the top in the
 * anchor. Points and bbox stay page coordinates and stay the truth of record; nothing here writes them.
 *
 * When a correction may change:
 *  - A layout update with no document change (a measure, a zoom settle, a width change): every correction is read again, and
 *    the ink moves with its line.
 *  - A document change: the correction every stroke shows stays the same, so typing moves no ink. The change walks no ink:
 *    it goes on the note's shift log as one entry (the changed lines, the lines it added, the height the changed lines
 *    gained, and their tops after it), and each anchor applies the entries newer than it the next time it is read (resolve):
 *    an anchor above the change stays; one below moves the lines added down and its top by the height gained, so it keeps
 *    its words and its correction; one on the changed lines is re-taken from where its stroke is shown, against the changed
 *    lines' tops as they were after the change. The height gained comes from the record of drawn lines' heights; a change to
 *    lines not drawn since their height last changed re-takes every anchor at and below it at once instead (the eager path).
 *    The editor lays the typed lines out under its old guess in that update and measures them in the next one; the height
 *    the changed lines gain or lose between the two goes on the log too (the rebase window), and every other height change
 *    in that measure moves the ink with its line. A changed line closes only at a measure that has read it, each range's
 *    runs of read lines closing on their own, their entry on the log then: a change the view leaves before its measure (an
 *    undo or redo scrolled elsewhere, the tail of a paste longer than the view) keeps its unread lines open until they are
 *    drawn and measured, a change made meanwhile carries them on, and a new signature drops the window with no entry. When
 *    the measure that empties the window leaves the first and last anchored lines at the corrections their strokes show,
 *    nothing else moved: every correction read stands, and none is read again. The log is folded (every anchor resolved, the log emptied) when it reaches SHIFT_LOG_CAP entries, when the
 *    note's list of strokes changes, when the surface shows another note, and before a page is written (settleLineAnchors,
 *    Stroke.ts).
 *  - A lasso drop (or its undo or redo): the moved strokes' anchors are re-taken where they are shown, as at a document change.
 *
 * Which strokes carry one: a stroke committed or pasted, from the line under it as laid out then. A stroke without one this
 * surface honours (an older build's, or one another width or font left) is anchored once its line and every line above it
 * have a measured height on record (the measured prefix: a height counts once a measure has read the line, after the update
 * that drew it), never under an estimate, and only once the editor is quiet: on the line whose measured top holds its bbox
 * top, at that measured top. It then shows on its words at once, wherever the editor's estimates put them, and settles to its
 * page position as the editor measures the lines above. Until then it shows at its page position, as it always has. The record keeps heights, not the fact of a draw: the editor's estimate refresh rebuilds
 * its own height map from estimates and leaves this record as it was.
 *
 * The line tops are read once per update however many strokes or halvings ask; the line text keys once per document change.
 * A keystroke costs one log entry and a few line tops; resolving costs the strokes read, when they are read. The eager path
 * works one anchored line at a time and changes each anchor in place: the lines below a change shift together, so a line is
 * first checked against the shift the line above it took (two line tops), and halved only when that misses; the keys of the
 * lines below move with those lines rather than being hashed again.
 *
 * Guards: an anchor whose line is gone, whose text or stroke has changed under it, whose layout signature (content width and
 * font size) is not the current one, or whose correction is larger than MAX_LINE_CORRECTION, shows the stroke at its page
 * position.
 */
import { holdLineAnchors, pieceAnchor, releaseLineAnchors, type InkPoint, type InkStroke, type LineAnchor } from "../ink/Stroke";
import { bumpCopyRev, inkListRevision, inkRevision, strokeRev, markCopy } from "../ink/StrokeRev";
import { AttachFollow, type FollowSnapshot } from "./AttachFollow";
import type { AttachmentData } from "./InkAttachments";

/** A store list's id to place map, with the stroke-list revision and the length it was built at. */
interface IdPlaces {
	readonly at: Map<string, number>;
	readonly rev: number;
	readonly len: number;
}

/**
 * A store stroke by id: an id to place map, built once per store list object and kept on it. The store
 * refills its list in place, so each answer is checked against the list at its place, and a miss builds the map again.
 */
const byIdOfList = new WeakMap<readonly InkStroke[], IdPlaces>();
export function strokeById(list: readonly InkStroke[], id: string, counts?: { hits: number; builds: number }): InkStroke | undefined {
	const p = byIdOfList.get(list);
	if (p) {
		const i = p.at.get(id), s = i === undefined ? undefined : list[i];
		if (s && s.id === id) {
			if (counts) counts.hits++;
			return s;
		}
	}
	if (counts) counts.builds++;
	const i = idPlaces(list).at.get(id);
	return i === undefined ? undefined : list[i];
}

/** The list's id to place map built again, one read per stroke, and kept on the list. */
function idPlaces(list: readonly InkStroke[]): IdPlaces {
	const at = new Map<string, number>();
	for (let i = 0; i < list.length; i++) at.set(list[i]!.id, i);
	const p = { at, rev: inkListRevision(), len: list.length };
	byIdOfList.set(list, p);
	return p;
}

/**
 * The list's id to place map as it stands: the kept one while the list has not changed in place since it was built (the
 * stroke-list revision and the length it was built at), else built again. Null when the list holds an id twice: a map
 * keeps one place per id, so it cannot answer for every stroke there.
 */
function freshIdPlaces(list: readonly InkStroke[]): IdPlaces | null {
	let p = byIdOfList.get(list);
	if (!p || p.rev !== inkListRevision() || p.len !== list.length) p = idPlaces(list);
	return p.at.size === list.length ? p : null;
}

/** CodeMirror's line geometry, as the anchors read it. Heights are the editor's own px, below the document top. */
export interface LineLayout {
	/** Lines in the document. */
	readonly lines: number;
	/** The text of 1-based line `n`. */
	lineText(n: number): string;
	/** The top of line `n`'s block; `lines + 1` is the bottom of the last line. */
	lineTop(n: number): number;
	/** Editor px per world unit: the editor's measured scale times the font zoom. */
	readonly pxPerWorld: number;
	/**
	 * The first line under the note's frontmatter (bodyFromOf); 1 when absent. No line above it is ever a stroke's anchor: the
	 * editor shows those lines hidden, drawn apart or as text, and a change between the three is not a change to the body.
	 */
	readonly bodyFrom?: number;
}

/** Each document's first body line, read once per document object (a document is never changed in place). */
const bodyFromOfDoc = new WeakMap<object, number>();

/**
 * The first line under a leading frontmatter block, 1-based: the line after its closing `---`. 1 when the document does not
 * open with a closed block, and 1 when nothing follows the block (no body line to hold ink).
 */
export function bodyFromOf(doc: { readonly lines: number; line(n: number): { text: string } }): number {
	const known = bodyFromOfDoc.get(doc);
	if (known !== undefined) return known;
	let from = 1;
	if (doc.lines > 2 && doc.line(1).text === "---") {
		for (let n = 2; n < doc.lines; n++) {
			if (doc.line(n).text === "---") {
				from = n + 1;
				break;
			}
		}
	}
	bodyFromOfDoc.set(doc, from);
	return from;
}

/**
 * Where a layout update came from (LineAnchors.layoutChanged): an editor transaction; the measure loop, whose measure read the
 * lines the update before it drew; a new signature, read in a measure or at a content resize; or the drawn lines' boxes, read in
 * a measure (LineAnchors.boxesRead).
 */
export type LayoutUpdate = "transaction" | "measure" | "signature" | "box";

/**
 * The 1-based line of `lines` whose block holds editor height `h`, found by halving over the line tops `top(n)`: line 1 above
 * the first top, the last line below the last. Never lineBlockAtHeight (see editorLineLayout). Lines that share one top (a
 * fold's hidden lines share the heading's block) are found at the first of them, the line the reader sees: one more top read,
 * and a second halving only inside such a run. No line above `from` is found: a height above its top is on `from`, so the
 * frontmatter's hidden lines, which share the first body line's top, are never the line under a stroke.
 */
export function lineUnder(h: number, lines: number, top: (n: number) => number, from = 1): number {
	let lo = from, hi = lines;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (top(mid) <= h) lo = mid;
		else hi = mid - 1;
	}
	if (lo === from) return lo;
	const t = top(lo);
	if (top(lo - 1) < t) return lo;
	let a = from;
	hi = lo - 1;
	while (a < hi) {
		const mid = (a + hi) >> 1;
		if (top(mid) < t) a = mid + 1;
		else hi = mid;
	}
	return a;
}

/** What the anchors read of CodeMirror's EditorView: the document and the height map, never the DOM. */
export interface LineView {
	readonly state: { readonly doc: { readonly lines: number; readonly length: number; line(n: number): { from: number; text: string } } };
	lineBlockAt(pos: number): { top: number; bottom: number };
}

/**
 * CodeMirror's line geometry at `pxPerWorld` editor px per world unit, read from the height map alone (lineBlockAt). Never
 * lineBlockAtHeight: it reads the layout, which CodeMirror refuses inside an update ("Reading the editor layout isn't allowed
 * during an update"), and a document change re-takes anchors there; CodeMirror then logs the throw and deactivates the whole
 * overlay. The line under a height is found by halving over the line tops (lineUnder).
 */
export function editorLineLayout(view: LineView, pxPerWorld: number): LineLayout {
	const doc = view.state.doc;
	return {
		lines: doc.lines,
		lineText: (n) => doc.line(n).text,
		lineTop: (n) => (n > doc.lines ? view.lineBlockAt(doc.length).bottom : view.lineBlockAt(doc.line(n).from).top),
		pxPerWorld,
		bodyFrom: bodyFromOf(doc),
	};
}

/**
 * The layout an anchor is honoured under: the editor's content width (integer layout px), its font size (px) and its default
 * character width (px). Widths within one character width of each other are one layout (underSignature): the width is set at
 * the first measure and kept through smaller moves (LineAnchors.setSignature), such as a sizer that grows by one character.
 */
export interface LineSignature {
	readonly width: number;
	readonly fontPx: number;
	readonly charWidth: number;
}

/**
 * Whether a layout (an anchor's, or a measured one) is the signature's own: the same font size, the width within one character.
 * Widths are integers and the character width is not, so one character is its width rounded up: one character more on a line
 * of an 8.8 px font moves an integer width by 9.
 */
export function underSignature(o: { readonly width: number; readonly fontPx: number }, sig: LineSignature | null): boolean {
	return sig !== null && Math.abs(o.fontPx - sig.fontPx) <= FONT_SLACK && Math.abs(o.width - sig.width) <= Math.ceil(sig.charWidth);
}

/** A run of changed lines, 1-based and inclusive, in the document as it is now. */
export interface LineRange {
	from: number;
	to: number;
}

/** A stroke moved by an anchor further than this from the stroke's own bbox is not the stroke the anchor was taken on. */
const Y_SLACK = 0.5;
/** No attached groups: freeFor's member map. */
const NO_MEMBERS: ReadonlyMap<string, readonly InkStroke[]> = new Map();
/** Corrections closer than this, world units, are the same correction: float noise never repaints the note. */
const SAME_DY = 1e-3;
/**
 * How far a drawn line's box top may sit from its height-map top, editor px, before the box answers the line's top (top()): the
 * 1/64 px layout quantum. The box is read at the rendered scale, the quotient CodeMirror measures its scaleY by, so while
 * CodeMirror's scale is that quotient both readers give the same top to float noise at every line. Under the bar the height map
 * answers, so the first box read after a settle moves no ink and the stand-in holds; past it, as the 3 px a 60.4 percent rest
 * leaves while CodeMirror keeps its old scale, the box answers.
 */
const BOX_AGREE_PX = 1 / 64;
/** boxLater's value for an anchor held under the height map until its line's box reads agree; no layout epoch is negative. */
const BOX_HELD = -1;
/** Font sizes this close are one: a file holds the size to a thousandth of a px, a computed size may carry more places. */
const FONT_SLACK = 1e-3;
/**
 * The largest correction honoured, world units. Fixed, so a zoom never changes which corrections are honoured: a cap tied to
 * the screen dropped a shown correction when a pinch shrank it. A legitimate correction is the sum of the undrawn block
 * heights above the line, each guessed one line until measured; 100,000 covers about 160 pictures of 600, where a
 * screenshot-heavy lecture note passes 33. A corrupt anchor is caught first by its key, its hash and Y_SLACK; this bound is
 * the last rail.
 */
export const MAX_LINE_CORRECTION = 100_000;
/**
 * The most document changes the shift log holds: the next one first folds it (every anchor resolved, the log emptied). A fold
 * walks the anchored ink once per entry held, so the cap bounds both that walk and the old documents the log keeps.
 */
export const SHIFT_LOG_CAP = 64;
/** The most strokes kept after they left the list (see `gone`); the oldest goes first. */
export const GONE_CAP = 4096;

/** FNV-1a over the line's UTF-16 code units, as an unsigned 32-bit number. */
export function lineKey(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** The lines-above hash of line 1: the hash of no lines. */
export const ABOVE_SEED = 0x811c9dc5;
/** The lines-above hash's base: odd, so a change to any one line's key always changes the hash of every line below it. */
const ABOVE_BASE = 0x9e3779b1;

/**
 * The lines-above hash one line further down: `h`, the hash of lines 1 to n - 1, times the base plus line n's text key, is
 * line n + 1's (mod 2^32). Order-sensitive, so lines swapped or moved read another hash; and linear, so a change to lines
 * above moves the hash of every line below by one number times a power of the base (LineAnchors.resolve), with no text read.
 */
export function aboveMix(h: number, key: number): number {
	return (Math.imul(h, ABOVE_BASE) + key) >>> 0;
}

/** The powers of the base, mod 2^32, as far as asked. */
let abovePows = new Uint32Array([1]);
function abovePow(d: number): number {
	if (d >= abovePows.length) {
		const was = abovePows, next = new Uint32Array(Math.max(d + 1, was.length * 2));
		next.set(was);
		for (let k = was.length; k < next.length; k++) next[k] = Math.imul(next[k - 1]!, ABOVE_BASE) >>> 0;
		abovePows = next;
	}
	return abovePows[d]!;
}

/** One text's lines-above hashes, built from line 1 as far down as asked: `at[n]` is line n's, good for lines 1 to `good`. */
export interface AboveRun {
	at: Uint32Array;
	good: number;
}

/** A run over a text, holding line 1's hash only. */
export function newAboveRun(): AboveRun {
	const at = new Uint32Array(64);
	at[1] = ABOVE_SEED;
	return { at, good: 1 };
}

/** Line `n`'s lines-above hash in the text whose line k has text key `key(k)` (lineKey), extending the run as far as `n`. */
export function aboveOf(run: AboveRun, n: number, key: (k: number) => number): number {
	if (n > run.good) {
		if (n >= run.at.length) {
			const at = new Uint32Array(Math.max(n + 1, run.at.length * 2));
			at.set(run.at.subarray(0, run.good + 1));
			run.at = at;
		}
		const at = run.at;
		for (let k = run.good; k < n; k++) at[k + 1] = aboveMix(at[k]!, key(k));
		run.good = n;
	}
	return run.at[n]!;
}

/** The anchor for a stroke laid out now: the line under its bbox top, that line's top, under the given signature. */
export function takeAnchor(stroke: InkStroke, layout: LineLayout, sig: LineSignature): LineAnchor | null {
	const px = layout.pxPerWorld;
	if (!(px > 0) || layout.lines < 1 || !Number.isFinite(stroke.bbox.y)) return null;
	const line = lineUnder(stroke.bbox.y * px, layout.lines, (n) => layout.lineTop(n), layout.bodyFrom);
	return {
		line,
		top: layout.lineTop(line) / px,
		y: stroke.bbox.y,
		key: lineKey(layout.lineText(line)),
		width: sig.width,
		fontPx: sig.fontPx,
		above: aboveOf(newAboveRun(), line, (k) => lineKey(layout.lineText(k))),
	};
}

/** Whether an anchor still names the line and the stroke it was taken on, under the current signature. */
export function anchorHolds(a: LineAnchor, stroke: InkStroke, layout: LineLayout, sig: LineSignature | null): boolean {
	return (
		underSignature(a, sig) &&
		Number.isInteger(a.line) &&
		a.line >= 1 &&
		a.line <= layout.lines &&
		Math.abs(a.y - stroke.bbox.y) <= Y_SLACK &&
		lineKey(layout.lineText(a.line)) === a.key
	);
}

/**
 * Shown copies whose points were built on a first read, and those among them whose source had changed in place since the
 * copy was made. Counted always; the rig reads them.
 */
export const shownPointCounts = { built: 0, recovered: 0 };

/**
 * The stroke as the note surface shows it: every point and the bbox moved down by `dy` and right by `dx`. A new object; the
 * store's is untouched. The bbox is moved now; the points on their first read, and every later read gets the same array
 *: most copies are only placed and culled by their box.
 *
 * A store stroke can change in place between the copy and that read (translateStroke, scaleStroke). The copy keeps the
 * source's revision and its bbox object as they were: both writers put a new bbox object and bump the revision, and both
 * map the points and the bbox by the same scale and offset per axis. On a first read with the revision moved, each point
 * is taken back through that map before the shift, so the copy shows the points as they were when it was made.
 */
export function shiftedStroke(s: InkStroke, dy: number, dx = 0): InkStroke {
	const st: CopyPlace = { rev: strokeRev(s), was: s.bbox, dx, dy, points: null };
	const was = st.was;
	const copy: InkStroke = {
		...s,
		get points(): InkPoint[] {
			return (st.points ??= shownPoints(s, st.rev, st.was, st.dx, st.dy));
		},
		set points(v: InkPoint[]) {
			st.points = v;
		},
		bbox: { x: was.x + dx, y: was.y + dy, width: was.width, height: was.height },
	};
	// The insert-space rows cache confirms a copy by its source's id and revision.
	markCopy(copy, s);
	shifts.set(copy, st);
	return copy;
}

/** A shown copy's offset from its source and its points once read: kept so a told move moves the copy in place. */
interface CopyPlace {
	rev: number;
	was: InkStroke["bbox"];
	dx: number;
	dy: number;
	points: InkPoint[] | null;
}
const shifts = new WeakMap<InkStroke, CopyPlace>();

/**
 * A shown copy moved in place to a new offset (a group's told move): the bbox now, the points on their next
 * read, and its own revision bumped without the ink revision, so a ribbon cache keyed on it draws it at the new place.
 * The same object stays THE copy every list and the index hold. False, nothing changed, when `copy` is no shiftedStroke.
 */
export function reshift(copy: InkStroke, dy: number, dx = 0): boolean {
	const st = shifts.get(copy);
	if (!st) return false;
	st.dx = dx;
	st.dy = dy;
	st.points = null;
	const w = st.was;
	copy.bbox = { x: w.x + dx, y: w.y + dy, width: w.width, height: w.height };
	bumpCopyRev(copy);
	return true;
}

/** A shown copy's points on first read: the source's moved by (dx, dy), taken back first to its bbox `was` if it changed since. */
function shownPoints(s: InkStroke, rev: number, was: InkStroke["bbox"], dx: number, dy: number): InkPoint[] {
	shownPointCounts.built++;
	const now = s.bbox;
	if (strokeRev(s) === rev || now === was) return s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
	shownPointCounts.recovered++;
	const kx = now.width > 0 ? was.width / now.width : 1, ky = now.height > 0 ? was.height / now.height : 1;
	return s.points.map((p) => ({ ...p, x: was.x + (p.x - now.x) * kx + dx, y: was.y + (p.y - now.y) * ky + dy }));
}

/**
 * The editor-px height of the changed lines above line `n`: for each range wholly above `n`, its first line's top to the top
 * of the line after it; for a range holding `n`, its first line's top to `n`'s top. Ranges at or below `n` add nothing.
 */
export function changedSpanAbove(ranges: readonly LineRange[], n: number, layout: Pick<LineLayout, "lineTop">): number {
	let span = 0;
	for (const r of ranges) {
		if (r.from >= n) continue;
		const end = Math.min(r.to + 1, n);
		span += layout.lineTop(end) - layout.lineTop(r.from);
	}
	return span;
}

/**
 * What the changed lines above line `n` gained between the guess and the measure, world units: changedSpanAbove as measured
 * less as guessed, over a measure's tops (MeasureShift).
 */
function measuredSpanAbove(e: MeasureShift, n: number): number {
	let gained = 0;
	for (let j = 0; j < e.ranges.length; j++) {
		const r = e.ranges[j]!;
		if (r.from >= n) break;
		const k = Math.min(r.to + 1, n) - r.from, g = e.guess[j]!, m = e.measured[j]!;
		gained += m[k]! - m[0]! - (g[k]! - g[0]!);
	}
	return gained;
}

/**
 * A run of lines after a change to lines `first` to `last` that left `shift` more lines: below the change it moves `shift`
 * lines on; one reaching past the change keeps its lines on both sides, one ending inside it stops above it.
 */
function movedRange(r: LineRange, first: number, last: number, shift: number): void {
	if (r.from > last) {
		r.from += shift;
		r.to += shift;
	} else if (r.to >= first) r.to = r.to > last ? r.to + shift : first - 1;
}

/** Sort and merge line ranges that touch or overlap. */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
	const sorted = [...ranges].sort((a, b) => a.from - b.from);
	const out: LineRange[] = [];
	for (const r of sorted) {
		const last = out.at(-1);
		if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
		else out.push({ from: r.from, to: r.to });
	}
	return out;
}

/** One document change as the rebase reads it: positions in the document before and after, CodeMirror's ChangeSet shape. */
export interface DocChange {
	/** Every changed range, before (A) and after (B). */
	iterChangedRanges(f: (fromA: number, toA: number, fromB: number, toB: number) => void): void;
	mapPos(pos: number, assoc: number): number;
}

/** The document before a change: where a line starts and ends, its text, and the line holding a position. */
export interface DocBefore {
	readonly lines: number;
	line(n: number): { from: number; to: number; text: string };
	lineAt(pos: number): { number: number };
}

/** The document after a change: its line count, a line's text and the line holding a position. */
export interface DocAfter {
	readonly lines: number;
	line(n: number): { text: string };
	lineAt(pos: number): { number: number };
}

/**
 * One document change on the shift log, as an anchor applies it (LineAnchors.resolve). Lines `first` to `last` (numbered
 * before it) changed; the lines below them are `shift` lines further on and `grew` world units lower, so an anchor there moves
 * by both and keeps its words and its correction. An anchor on the changed lines that named its line in `before` (heldIn) is
 * re-taken from where its stroke is shown against `tops`, the tops of lines `first` to `last + shift + 1` after the change
 * (world units), with `after`'s text, under `sig`; any other is left as it was.
 */
interface EditShift {
	readonly kind: "edit";
	readonly first: number;
	readonly last: number;
	readonly shift: number;
	readonly grew: number;
	readonly before: DocBefore;
	readonly after: DocAfter;
	readonly tops: Float64Array;
	readonly sig: LineSignature;
	/** The changed lines' keys, hashed once each: line n of `before` at n, of `after` at -n. */
	keys: Map<number, number> | null;
	/** Line `first`'s lines-above hash, the same before the change and after it. */
	readonly above: number;
	/**
	 * What the change added to the lines-above hash of the line after its lines (aboveMix): an anchor `d` lines below them adds
	 * this times the base to the d. Worked out when an anchor below first asks.
	 */
	gain: number | null;
}

/**
 * The measure that closed rebase window lines, on the shift log: for each run of changed lines it read (numbered as at the
 * measure, in order), the tops of its lines and the line after it under the old guess and as measured (world units). An
 * anchor moves by what the changed lines above its line gained between the two (changedSpanAbove), as the typed lines push
 * the text and not the ink.
 */
interface MeasureShift {
	readonly kind: "measure";
	readonly ranges: readonly LineRange[];
	readonly guess: readonly Float64Array[];
	readonly measured: readonly Float64Array[];
}

type Shift = EditShift | MeasureShift;

/**
 * The surfaces reading each store list, in the order they took it. Two panes on one note read the same list and the same
 * stroke objects, so a document change both put on their logs would move each shared anchor twice: one of them writes the
 * note's changes (LineAnchors.writer).
 */
const holdersOf = new WeakMap<readonly InkStroke[], LineAnchors[]>();

/**
 * One note surface's line anchors: the corrections it shows, the copies it paints, and the rebase window. Lives on the overlay;
 * one per pane, so two panes at different widths each honour only their own signature.
 */
export class LineAnchors {
	/** The signature anchors are taken and honoured under. Null until the editor has been measured once. */
	sig: LineSignature | null = null;
	/** Moves whenever a shown correction changed: the copies, the index, the rasters and the frontier are stale. */
	generation = 0;
	/**
	 * The open step, since the last takeStep: the summed bound of its moves (each read's largest change of a shown correction, world
	 * units), whether a generation move came from no read (another note, a remount: its size is not known), and whether a read moved one.
	 */
	private stepBound = 0;
	private stepUnknown = false;
	private stepSeen = false;
	/** Ink attached to text (AttachFollow.ts): a member is shown by its group's correction, never by its own anchor. */
	readonly follow = new AttachFollow();
	/**
	 * Moves whenever a correction can change: a layout update, another note. A correction read in an older epoch is read again.
	 * A document change leaves it: the anchors it re-takes keep the correction they show, and those it cannot are read again.
	 */
	private epoch = 0;
	/** Moves on every layout or document change: a line top read in an older one is read again. */
	private layoutEpoch = 0;
	/** The note the state below belongs to. */
	private path: string | null = null;
	/** The surfaces on the store list this one is listed under (holdersOf), itself included; null while it is under none. */
	private peers: LineAnchors[] | null = null;
	private heldSrc: readonly InkStroke[] | null = null;
	/** Each anchored stroke's correction, world units, as of an epoch. */
	private readonly dys = new WeakMap<InkStroke, { epoch: number; dy: number }>();
	/**
	 * The strokes whose memo was last written at a nonzero correction, and the strokes whose memo was
	 * dropped or that are new to the anchored list since. While `wholeAt` is the epoch, every anchored stroke of the list
	 * read at it is in `corrected` exactly when its correction is nonzero, or is in `unsure`.
	 */
	private readonly corrected = new Set<InkStroke>();
	private readonly unsure = new Set<InkStroke>();
	private wholeAt = -1;
	/** Each corrected stroke's index in the store list it was last found at, checked by identity before it is used. */
	private readonly correctedAt = new Map<InkStroke, number>();
	/** Each shown copy, at the correction and stroke revision it was made at. */
	private readonly copies = new WeakMap<InkStroke, { dy: number; rev: number; copy: InkStroke }>();
	/**
	 * The anchored strokes of the last list read, with the list's identity, length and the ink revision, and the strokes on its
	 * first and last anchored lines (the probes: their corrections tell a measure whether anything else moved). Stale when a
	 * stroke of it took another line in a way the probes cannot follow (a lasso drop, old ink anchored).
	 */
	private anchored: {
		src: readonly InkStroke[];
		len: number;
		ink: number;
		list: InkStroke[];
		/** Each anchored stroke's index in `src`. */
		at: number[];
		top: InkStroke | null;
		bottom: InkStroke | null;
		stale: boolean;
	} | null = null;
	/** The last free list `freeFor` answered, and what it was made from. */
	private free: { path: string; src: readonly InkStroke[]; len: number; ink: number; gen: number; map: ReadonlyMap<string, string>; anchored: boolean; out: { free: readonly InkStroke[]; members: ReadonlyMap<string, readonly InkStroke[]> }; base: InkStroke[]; listRev: number; freeSrc: InkStroke[]; copies: Map<InkStroke, number>; memberRevs: Map<InkStroke, number> } | null = null;
	/**
	 * FreeFor's calls, answers held at the same ink, answers kept across a store move in place, and builds; of the builds,
	 * the lists patched in one changed window, the strokes looked up and placed for them, and the whole builds a too wide
	 * window or a member joining forced, and the changed ids outside the window a patch skipped as in no list.
	 */
	readonly freeCounts = { calls: 0, held: 0, kept: 0, builds: 0, patched: 0, patchVisited: 0, whole: 0, wholeCold: 0, wholeMapOutside: 0, wholeWindowHalf: 0, absentSkipped: 0, baseReads: 0 };
	/**
	 * strokesFor's calls: answered with the held list, and otherwise why it missed and what it answered (the
	 * store's list, the held copies list refilled in place, a new copies list). Counted always; the rig reads them.
	 */
	readonly strokesForCounts = { calls: 0, held: 0, missPath: 0, missList: 0, missInk: 0, missGen: 0, missFollow: 0, store: 0, refilled: 0, built: 0, remade: 0, shownOf: 0, visited: 0, lookups: 0, fullReads: 0, byIdBuilds: 0 };
	/** Each member's index in the store list it was last found at, checked by id before it is used. */
	private readonly memberAt = new Map<string, number>();
	/** The last list `strokesFor` answered, and what it was made from. */
	private shown: { path: string; src: readonly InkStroke[]; len: number; ink: number; gen: number; fgen: number; out: readonly InkStroke[]; own: InkStroke[] | null; depths: number[] | null; pending: Map<InkStroke, number> | null } | null = null;
	/** Each line's top (editor px) as of a layout epoch: read once however many strokes sit on it or halvings pass through it. */
	private readonly tops = new Map<number, number>();
	private topsEpoch = -1;
	/**
	 * Each drawn anchored line's top as its line box was last read in a measure (boxesRead), world units: where the browser
	 * painted the text, at the rendered scale. CodeMirror's height map holds each line at the scale it was last measured at, and
	 * keeps its own scale until a zoom moves it more than 0.005: under that, the lines drawn are measured again at the painted
	 * scale and divided by the old one, so their height-map tops read high and a correction would move ink the text did not.
	 * A line read here answers its top from this when it sits more than BOX_AGREE_PX from the height map's, else from the height
	 * map; a line never read, from the height map. A line no longer drawn keeps its last read top, and so its correction,
	 * only while the height map still puts it where it did at that read (boxMaps): a zoom or a scroll can re-estimate the lines
	 * above it, and a box kept past that answers a top the text is no longer at, which the scroll can bring into view while the
	 * line is not drawn and so not read again. A text change drops the lines at and below it, another note or a new signature
	 * drops them all.
	 */
	private readonly boxTops = new Map<number, number>();
	/** The height map's top each line of boxTops was read against, world units: refreshed at every read of the line, goes with it. */
	private readonly boxMaps = new Map<number, number>();
	/**
	 * The lines the last box read that read boxes found drawn (its tops): one of these answers its box as boxTops says; any
	 * other answers it only while the height map agrees with boxMaps. A read that waited on the painted scale leaves it.
	 */
	private readonly boxDrawn = new Set<number>();
	/**
	 * The lines of boxTops whose box answered (sat more than BOX_AGREE_PX from the height map's top) when read, or when a top
	 * was later taken from it: a correction shown since may have been read against it.
	 */
	private readonly boxAnswered = new Set<number>();
	/**
	 * An edit dropped a box that answered: a correction shown against it outlives the drop (an epoch keeps its corrections), so
	 * no line with no top on record may be skipped at the next box read. Down when every correction is read again.
	 */
	private answeredDropped = false;
	/**
	 * Anchors taken under the height map on a line with no box read, after this surface read boxes: the text is painted off
	 * the map then, and the stroke was drawn at the painted line. Its line's first box read takes it again under the box when
	 * that read arrives in the layout epoch the anchor was taken in (the value here). A read after the layout moved (a zoom
	 * step, an edit) can catch a frame the text has not settled in, and a move from it would stay: the anchor is held
	 * (BOX_HELD), read against the height map where the stroke was drawn, until a read of its line agrees with the one before
	 * it (boxSettled).
	 */
	private readonly boxLater = new WeakMap<LineAnchor, number>();
	/** The layout epoch each line's first box read on record arrived in; goes with the line's box top. */
	private readonly boxReadEpoch = new Map<number, number>();
	/** Layout updates other than a box read's own (a transaction, the measure loop, a new signature), counted. */
	private layoutUpdates = 0;
	/** The layout update count at each line's first box read on record; goes with boxReadEpoch. */
	private readonly boxReadLayout = new Map<number, number>();
	/**
	 * Lines whose box read agreed with the top on record, marked only while an anchor is held: a held anchor on one is taken
	 * under its box at its next read. A replaced top, a dropped box or an empty record unmarks the line.
	 */
	private readonly boxSettled = new Set<number>();
	/**
	 * Strokes whose anchor was held at their last read: while any is, boxesRead marks the lines that settle. Emptied when a box
	 * read reads every correction again, which fills it with those still held.
	 */
	private readonly boxHeld = new Set<InkStroke>();
	/** An anchor top moved by its line's first box read (boxLater) since takeBoxTopMoved last asked: the page holds the old top. */
	private boxTopMoved = false;
	/** The line box reads: measures that read at least one box, and rect reads, for the hot-path checks. */
	readonly boxCounts = { measures: 0, reads: 0 };
	/**
	 * Each anchored line's text key. A layout update never changes a line's text, so the keys outlive the epoch: a document
	 * change drops them from its first changed line down, a signature change or another note drops them all.
	 */
	private readonly keys = new Map<number, number>();
	/**
	 * Each line's height as the editor's height map last gave it, world units, by line number (index 0 unused), and whether the
	 * line holds one. Written from the lines the editor has drawn (see drawn); an edit drops the edited lines' entries, a change
	 * in the line count moves the entries below it with their lines, and a new signature or another note drops them all.
	 */
	private heights = new Float64Array(0);
	private valid = new Uint8Array(0);
	/** How many lines hold a height. */
	private validCount = 0;
	/** No line past this one holds a height: copies and drops stop here. */
	private hiLine = 0;
	/** Line 1's measured top, world units; NaN until line 1 is drawn. */
	private base = NaN;
	/** The measured tops, world units: `trueTops[n]` is line n's, from line 1's top and the heights above n; good through `topsGood`. */
	private trueTops = new Float64Array(0);
	private topsGood = 0;
	/** Lines 1 to this one hold a measured height (the measured prefix): each one marked. */
	private measured = 0;
	/**
	 * Which lines' heights on record a measure has read (the mask), by line number. The heights of every drawn line go on record
	 * (drawn), estimates or not, as the document changes read them; only the measured prefix takes marked ones.
	 */
	private marked = new Uint8Array(0);
	/**
	 * The lines the last update showed that no measure has read since: CodeMirror draws a line after the plugins' update and
	 * reads its height at the next measure, so the height recorded for it at the update is the editor's estimate. That next
	 * measure reads them before it moves anything, so the update it makes marks them (viewed). Moved with their lines by later
	 * edits, as `fresh` is. Empty when `from` > `to`.
	 */
	private readonly pending: LineRange = { from: 1, to: 0 };
	/**
	 * The lines whose heights on record are the editor's own now: those the last update read whole (the lines drawn), moved
	 * with their lines by later edits. A line outside it may hold a height the editor has since replaced by an estimate. Empty
	 * when `from` > `to`.
	 */
	private readonly fresh: LineRange = { from: 1, to: 0 };
	/**
	 * The shift log: the document changes not yet applied to every anchor, oldest first. Entry i is generation floor + 1 + i;
	 * an anchor is at the generation in `gens`, or at `floor` when it has none, and applies the entries past it when read.
	 */
	private readonly log: Shift[] = [];
	private floor = 0;
	/** The generation each stroke's anchor was last resolved, taken or moved at (in memory only). */
	private readonly gens = new WeakMap<InkStroke, number>();
	/**
	 * The strokes whose anchors this surface has found, since it was mounted on the note, to name the text above their line
	 * as it reads now (`above`), or took or moved itself. The text may change unheard while no surface is mounted (another
	 * device, an older build, another editor), so an anchor read for the first time after a mount is honoured only when the
	 * lines above its line hash as they did when it was taken; from then on the live edits keep it current.
	 */
	private vouched = new WeakSet<InkStroke>();
	/** The current text's lines-above hashes, good from line 1 down to the first line a document change touched. */
	private readonly aboveRun = newAboveRun();
	/**
	 * Anchors this surface took or moved since the page was last written, whose lines-above hash waits for that write
	 * (settleLater): a pen commit, or the re-take after a document change, reads no text. Vouched for meanwhile, and left alone by the changes that move
	 * the hash of an anchor that has one.
	 */
	private later: InkStroke[] = [];
	private laterSet = new WeakSet<InkStroke>();
	/**
	 * The anchored strokes that left the note's list (erased, cut, deleted), by id, oldest first, at most GONE_CAP: a fold
	 * resolves them and a re-take at once takes them as it takes the list's, so one brought back by undo has applied the
	 * changes made while it was gone. A stroke whose id is in the list again leaves it; a list read again as new objects of
	 * the same ids (a reload) adds nothing. Emptied when the surface shows another note.
	 */
	private readonly gone = new Map<string, InkStroke>();
	/** Strokes compared by id at the list changes so far, for the cost cells (no product code reads it). */
	goneScanned = 0;
	/** The lines the last document change left changed, numbered after it, 1-based and inclusive. */
	readonly changedLines: LineRange = { from: 0, to: 0 };
	/**
	 * Open from a document change until a measure has read its lines: the changed lines (merged, numbered as now) and, for each
	 * range, the tops of its lines and the line after it under the editor's guess (world units). The measure that reads a run of
	 * a range's lines reads them again and closes that run; what its lines gained goes on the shift log, and every anchor taken
	 * before it applies that when next read.
	 */
	private window: { ranges: LineRange[]; guess: Float64Array[] } | null = null;
	/** Reused by each document change: the held strokes on the changed lines, those below them, and the keys that move. */
	private readonly atScratch: InkStroke[] = [];
	private readonly underScratch: InkStroke[] = [];
	private readonly movedScratch: number[] = [];
	/** Reused by each re-take: the correction each stroke of the list shows. */
	private readonly dyScratch: number[] = [];
	/**
	 * Document changes by the path they took, for the timing trace (no product code reads them): `lazy` onto the shift log (or
	 * nothing to log, with no anchored ink), `eager` re-taken at once or with no layout to read, and `why` the last eager one
	 * took that path: the record could not say what its lines gained.
	 */
	readonly changePaths = { lazy: 0, eager: 0, why: "" };

	constructor(
		/** The editor's layout now, or null when it cannot be read. */
		private readonly layout: () => LineLayout | null,
		/** Whether this surface's editor has focus: of two panes on one note, that one writes its changes. */
		private readonly focused: () => boolean = () => false,
		/**
		 * Whether this surface's editor is on screen: in view, in a visible document. A measure reads no height otherwise (the
		 * editor hidden, or no frame running in a background tab), so nothing is marked measured then.
		 */
		private readonly onScreen: () => boolean = () => true
	) {}

	/** Forget everything tied to the previous note when the surface shows another. */
	private own(path: string): void {
		if (this.path === path) return;
		// The previous note's anchors take every change it logged before its state goes. Its text is no longer the layout's,
		// so an anchor still waiting on its hash keeps none and is not honoured after a remount (ink stays where drawn).
		this.foldLog();
		this.dropLater();
		this.unhold();
		this.path = path;
		this.boxTopMoved = false;
		this.gone.clear();
		this.window = null;
		this.anchored = null;
		this.wholeAt = -1;
		this.corrected.clear();
		this.unsure.clear();
		this.correctedAt.clear();
		this.shown = null;
		this.keys.clear();
		this.unvouch();
		this.forgetHeights();
		this.epoch++;
		this.layoutEpoch++;
		this.generation++;
		this.stepUnknown = true;
	}

	/** List this surface under the store list `src`, last, and under no other. */
	private hold(src: readonly InkStroke[]): void {
		this.unhold();
		let list = holdersOf.get(src);
		if (!list) holdersOf.set(src, (list = []));
		list.push(this);
		this.peers = list;
		this.heldSrc = src;
	}

	/** Take this surface off its note's list. */
	private unhold(): void {
		const list = this.peers;
		if (!list) return;
		this.peers = null;
		const i = list.indexOf(this);
		if (i >= 0) list.splice(i, 1);
		const src = this.heldSrc;
		this.heldSrc = null;
		if (list.length === 0 && src && holdersOf.get(src) === list) holdersOf.delete(src);
	}

	/**
	 * The surface that writes the note's document changes to its anchors: the one whose editor has focus, else the first to
	 * show the note. Only it logs a change or re-takes for one; every other pane moves its own keys and heights with the lines
	 * and reads each anchor as the writer leaves it. Read once per document change.
	 */
	private writer(): LineAnchors {
		const list = this.peers;
		if (!list || list.length < 2) return this;
		for (const h of list) if (h.focused()) return h;
		return list[0]!;
	}

	/**
	 * Whether this surface maps the note's attached targets through a document change and writes the list: the writer
	 * above, so of two panes on one note the targets move once. Read once per document change.
	 */
	get writesAttachments(): boolean {
		return this.writer() === this;
	}

	/** The list the writer mapped, taken by every other pane's follow on the note: each reads its groups again at its next measure. */
	shareAttachments(list: readonly AttachmentData[]): void {
		const peers = this.peers;
		if (peers && peers.length > 1) for (const h of peers) if (h !== this) h.follow.setList(list);
	}

	/** Every other surface on the note applies what it logged, so the writer's entries are the only ones held. */
	private foldPeers(): void {
		const list = this.peers;
		if (list && list.length > 1) for (const h of list) if (h !== this) h.foldLog();
	}

	/** A stroke anchored now, against the layout as it is: at the head of this surface's log and every other pane's on the note. */
	private stamp(s: InkStroke): void {
		this.gens.set(s, this.head);
		const list = this.peers;
		if (list && list.length > 1) for (const h of list) if (h !== this) h.gens.set(s, h.head);
	}

	/**
	 * Bring a stroke's anchor up to date: this surface's log, then that of any other pane on the note whose log holds entries.
	 * A pane folds every other before it logs a change, so at most one log on the note holds entries and the order is fixed;
	 * entries a pane logged before focus moved on reach every read. No focus is read here.
	 */
	private current(s: InkStroke): void {
		this.resolve(s);
		const list = this.peers;
		if (list && list.length > 1) for (const h of list) if (h !== this && h.log.length > 0) h.resolve(s);
	}

	/** Whether this note has anything for the anchors to do: anchored ink, or a window open. */
	tracks(path: string, src: readonly InkStroke[]): boolean {
		this.own(path);
		// Read first, open window or not: a changed list folds the log before the next change goes on it.
		const anchored = this.anchoredIn(src).length;
		return this.window !== null || anchored > 0;
	}

	/** How many strokes are kept after they left the list (see `gone`). */
	get goneCount(): number {
		return this.gone.size;
	}

	/** How many document changes wait on the shift log. */
	get pendingShifts(): number {
		return this.log.length;
	}

	/**
	 * The surface stops hearing the editor's updates (unmounted): the log is folded, and nothing read from the editor before
	 * is trusted after the remount, as the text and its heights may change unheard in between. The record of heights and the
	 * rebase window go, as for another note; the text keys go, as a key kept by line number would match words that moved
	 * there; every correction and line top is read again.
	 */
	detached(): void {
		this.fold();
		this.dropLater();
		this.unhold();
		this.window = null;
		this.keys.clear();
		this.unvouch();
		this.forgetHeights();
		this.epoch++;
		this.layoutEpoch++;
		this.generation++;
		this.stepUnknown = true;
	}

	/** Nothing read before is vouched for: the text may change unheard until the next read (see `vouched`). */
	private unvouch(): void {
		this.vouched = new WeakSet();
		this.aboveRun.good = 1;
	}

	/** Line `n`'s lines-above hash in the text now: each line above read once until a document change reaches it. */
	private above(n: number, layout: LineLayout): number {
		const run = this.aboveRun;
		return n <= run.good ? run.at[n]! : aboveOf(run, n, (k) => lineKey(layout.lineText(k)));
	}

	/** Vouch for a stroke's anchor on this surface and every other pane on the note. */
	private vouch(s: InkStroke): void {
		this.vouched.add(s);
		const list = this.peers;
		if (list && list.length > 1) for (const h of list) if (h !== this) h.vouched.add(s);
	}

	/** A stroke's anchor taken or moved here: vouched for, its lines-above hash due at the next page write (later). */
	private hashLater(s: InkStroke): void {
		this.vouch(s);
		delete s.lineAnchor!.above;
		if (this.laterSet.has(s)) return;
		this.laterSet.add(s);
		this.later.push(s);
		holdLineAnchors(this);
	}

	/** Every anchor waiting on its hash takes it from the text now (the layout's, with the log folded), and leaves the list. */
	private settleLater(): void {
		const later = this.later;
		if (later.length === 0) return;
		const layout = this.layout();
		for (const s of later) {
			const a = s.lineAnchor;
			if (!a) continue;
			if (layout && Number.isInteger(a.line) && a.line >= 1 && a.line <= layout.lines) a.above = this.above(a.line, layout);
			else delete a.above;
		}
		this.dropLater();
	}

	/** No anchor waits on its hash. */
	private dropLater(): void {
		this.later = [];
		this.laterSet = new WeakSet();
		if (this.log.length === 0) releaseLineAnchors(this);
	}

	/** The text changed from line `first` down: the lines-above hashes below it are hashed again when next asked. */
	private aboveFrom(first: number): void {
		this.aboveRun.good = Math.min(this.aboveRun.good, Math.max(first, 1));
	}

	/** Whether this surface or another pane on the note vouches for a stroke's anchor. */
	private vouchedAnywhere(s: InkStroke): boolean {
		return this.vouched.has(s) || this.peerVouched(s);
	}

	/** Whether another pane on the note vouches for a stroke's anchor. */
	private peerVouched(s: InkStroke): boolean {
		const list = this.peers;
		if (list && list.length > 1) for (const h of list) if (h !== this && h.vouched.has(s)) return true;
		return false;
	}

	/** Whether the rebase window is open. */
	get windowOpen(): boolean {
		return this.window !== null;
	}

	/**
	 * An editor update with a layout or document change that this surface had nothing to re-take or read again for (no
	 * anchored ink, no window). The line tops read so far describe an older layout, and after a document change the keys an
	 * older text: neither may answer the next anchor taken. A document change also moves the measured heights with their lines.
	 */
	skipped(before?: DocBefore, changes?: DocChange, after?: DocAfter): void {
		this.foldLog();
		this.epoch++;
		this.layoutEpoch++;
		if (!before || !changes || !after) return;
		let firstA = Infinity, lastA = -1;
		changes.iterChangedRanges((fromA, toA) => {
			firstA = Math.min(firstA, fromA);
			lastA = Math.max(lastA, toA);
		});
		if (firstA !== Infinity) this.rekey(before.lineAt(firstA).number, before.lineAt(lastA).number, after.lines - before.lines, true);
	}

	/**
	 * The text changed on lines `first` to `last` (numbered after the change; `last` Infinity when the lines below it were
	 * renumbered): their keys and their measured heights go, and the measured prefix stops above `first`.
	 */
	private edited(first: number, last = Infinity): void {
		this.aboveFrom(first);
		this.dropBoxes(first);
		if (last - first < this.keys.size) for (let n = first; n <= last; n++) this.keys.delete(n);
		else for (const n of this.keys.keys()) if (n >= first && n <= last) this.keys.delete(n);
		this.dropHeights(first, last);
		this.changedLines.from = first;
		this.changedLines.to = last;
	}

	/** The line box tops at and below line `first` go: those lines may have moved, and the height map answers until read again. */
	private dropBoxes(first: number): void {
		if (this.boxTops.size > 0)
			for (const n of this.boxTops.keys())
				if (n >= first) {
					this.boxTops.delete(n);
					this.boxMaps.delete(n);
					this.boxReadEpoch.delete(n);
					this.boxReadLayout.delete(n);
					this.boxSettled.delete(n);
					if (this.boxAnswered.delete(n)) this.answeredDropped = true;
				}
	}

	/**
	 * The lines anchored ink of `src` names between `from` and `to` (the lines CodeMirror has drawn), each once: the lines whose
	 * boxes a measure reads. Each anchor first takes the document changes logged since it was last read.
	 */
	boxLines(path: string, src: readonly InkStroke[], from: number, to: number): number[] {
		this.own(path);
		const out = new Set<number>();
		for (const s of this.anchoredIn(src)) {
			this.current(s);
			const n = s.lineAnchor?.line;
			if (n !== undefined && n >= from && n <= to) out.add(n);
		}
		return [...out];
	}

	/**
	 * Line box tops read in a measure (world units, by line). A line read again within float noise keeps its old top, so the
	 * corrections read nothing new and nothing repaints; when any top moved, every correction is read again in a new layout
	 * epoch. A line with no top on record (an edit dropped it, or it was never read) has moved only when, with the top read,
	 * it answers a top other than the one the epoch already gives it: a line that moved with an edit reads nothing again, so a
	 * keystroke above anchored ink walks none of it. True when any shown correction changed.
	 */
	boxesRead(path: string, src: readonly InkStroke[], tops: ReadonlyMap<number, number>, reads: number): boolean {
		this.own(path);
		if (reads > 0) {
			this.boxCounts.measures++;
			this.boxCounts.reads += reads;
		}
		const layout = this.layout();
		const arrived = this.layoutEpoch;
		const held = this.boxHeld.size > 0;
		let moved = false, settled = false;
		for (const [n, top] of tops) {
			const old = this.boxTops.get(n);
			if (old === undefined) {
				this.boxReadEpoch.set(n, arrived);
				this.boxReadLayout.set(n, this.layoutUpdates);
			}
			const inLayout = layout !== null && n >= 1 && n <= layout.lines;
			if (old !== undefined && Math.abs(top - old) < SAME_DY) {
				if (inLayout) {
					// A line drawn again whose box reads where it did: while it was not drawn the height map may have moved under the
					// box and answered; drawn, the box answers as read, and the corrections are read again when that moves its top.
					const px = layout.pxPerWorld, map = layout.lineTop(n);
					if (!this.boxDrawn.has(n) && Math.abs(this.boxTop(n, old, map, px, true) - this.top(n, layout)) >= SAME_DY * px) moved = true;
					this.boxMaps.set(n, map / px);
				}
				// Two reads of the line agree: an anchor held on it is taken under its box at the read of every correction below.
				if (held && !this.boxSettled.has(n)) {
					this.boxSettled.add(n);
					settled = true;
				}
				continue;
			}
			const answers = inLayout && Math.abs(top * layout.pxPerWorld - layout.lineTop(n)) > BOX_AGREE_PX;
			const mapAt = inLayout ? layout.lineTop(n) / layout.pxPerWorld : NaN;
			if (old === undefined && !this.answeredDropped && inLayout) {
				// The top line n answers with the box read (top's rule, fresh), against the one the epoch's corrections use, read
				// before the box goes on record. Only while no dropped box answered: then the epoch's tops are what the shown
				// corrections were read against.
				const was = this.top(n, layout), map = layout.lineTop(n), px = layout.pxPerWorld, box = top * px;
				const now = answers ? box : map;
				this.recordBox(n, top, answers, mapAt);
				if (Math.abs(now - was) < SAME_DY * px) continue;
			} else this.recordBox(n, top, answers, mapAt);
			moved = true;
		}
		// A read that read boxes names the anchored lines drawn now; one that read none while a rect was read (it waited on the
		// painted scale) names nothing, and the lines drawn stay as the last read found them.
		if (tops.size > 0 || reads === 0) {
			if (layout)
				for (const n of this.boxDrawn) {
					const box = this.boxTops.get(n);
					if (tops.has(n) || box === undefined || n < 1 || n > layout.lines) continue;
					// A line no longer drawn answers its box only while the height map has not moved under it since its last read.
					const px = layout.pxPerWorld;
					if (Math.abs(this.boxTop(n, box, layout.lineTop(n), px, false) - this.top(n, layout)) >= SAME_DY * px) moved = true;
				}
			this.boxDrawn.clear();
			for (const n of tops.keys()) this.boxDrawn.add(n);
		}
		if (!moved && !settled) return false;
		this.answeredDropped = false;
		// The held strokes are those still held once every correction is read again.
		this.boxHeld.clear();
		return this.layoutChanged(path, src, "box");
	}

	/**
	 * Whether an anchor top moved at its line's first box read since the last ask, which takes the answer: the move is in memory
	 * only, so the caller asks the store for a page write, or a reopen reads the top the stroke was committed with.
	 */
	takeBoxTopMoved(): boolean {
		const moved = this.boxTopMoved;
		this.boxTopMoved = false;
		return moved;
	}

	/** Line n's box top on record, the height map's top it was read against (world units), and whether it answered (sat off the map). */
	private recordBox(n: number, top: number, answers: boolean, map: number): void {
		this.boxTops.set(n, top);
		if (Number.isFinite(map)) this.boxMaps.set(n, map);
		else this.boxMaps.delete(n);
		if (this.boxSettled.size > 0) this.boxSettled.delete(n);
		if (answers) this.boxAnswered.add(n);
		else this.boxAnswered.delete(n);
	}

	/** Make room in the record for line `n` and the top of the line after it. */
	private roomFor(n: number): void {
		if (n + 2 <= this.heights.length) return;
		const size = Math.max(n + 2, this.heights.length * 2, 64);
		const heights = new Float64Array(size), valid = new Uint8Array(size), marked = new Uint8Array(size), tops = new Float64Array(size);
		heights.set(this.heights);
		valid.set(this.valid);
		marked.set(this.marked);
		tops.set(this.trueTops);
		this.heights = heights;
		this.valid = valid;
		this.marked = marked;
		this.trueTops = tops;
	}

	/** The record holds nothing: the mount, another note, a new signature. */
	private forgetHeights(): void {
		this.boxTops.clear();
		this.boxMaps.clear();
		this.boxDrawn.clear();
		this.boxReadEpoch.clear();
		this.boxReadLayout.clear();
		this.boxSettled.clear();
		this.boxHeld.clear();
		this.boxAnswered.clear();
		this.answeredDropped = false;
		this.valid.fill(0);
		this.marked.fill(0);
		this.validCount = 0;
		this.hiLine = 0;
		this.base = NaN;
		this.topsGood = 0;
		this.measured = 0;
		this.fresh.from = 1;
		this.fresh.to = 0;
		this.pending.from = 1;
		this.pending.to = 0;
	}

	/** Lines `first` to `last` hold no measured height: the prefix stops above `first`. */
	private dropHeights(first: number, last: number): void {
		const to = Math.min(last, this.hiLine);
		for (let n = Math.max(first, 1); n <= to; n++) {
			if (this.valid[n]) {
				this.valid[n] = 0;
				this.marked[n] = 0;
				this.validCount--;
			}
		}
		this.measured = Math.min(this.measured, first - 1);
		this.topsGood = Math.min(this.topsGood, first);
	}

	/**
	 * Lines `first` to `last` changed and the document now has `shift` more lines: after the change the changed lines are
	 * `first` to `last + shift` and hold no height, and every line below them keeps its height, `shift` lines on.
	 */
	private spliceHeights(first: number, last: number, shift: number): void {
		const hi = this.hiLine, end = last + shift;
		let removed = 0;
		for (let n = first; n <= Math.min(last, hi); n++) if (this.valid[n]) removed++;
		if (hi > last) {
			this.roomFor(hi + shift);
			this.heights.copyWithin(end + 1, last + 1, hi + 1);
			this.valid.copyWithin(end + 1, last + 1, hi + 1);
			this.marked.copyWithin(end + 1, last + 1, hi + 1);
			if (shift < 0) {
				this.valid.fill(0, hi + shift + 1, hi + 1);
				this.marked.fill(0, hi + shift + 1, hi + 1);
			}
			this.hiLine = hi + shift;
		} else this.hiLine = Math.min(hi, first - 1);
		this.roomFor(end);
		this.valid.fill(0, first, end + 1);
		this.marked.fill(0, first, end + 1);
		if (hi <= last) {
			this.valid.fill(0, first, Math.max(hi, end) + 1);
			this.marked.fill(0, first, Math.max(hi, end) + 1);
		}
		this.validCount -= removed;
		this.measured = Math.min(this.measured, first - 1);
		this.topsGood = Math.min(this.topsGood, first);
		this.changedLines.from = first;
		this.changedLines.to = end;
		// The heights below the change are the editor's still, `shift` lines on; the changed lines hold none until drawn. The
		// lines no measure has read yet move with them.
		movedRange(this.fresh, first, last, shift);
		movedRange(this.pending, first, last, shift);
	}

	/**
	 * The lines an editor update drew, 1-based and inclusive: each one's height in the editor's height map now goes on record
	 * (one line top read per line, nothing per stroke), measured or an estimate, as a document change reads its height from
	 * them. CodeMirror runs this update before it draws the lines new to it, and reads their heights at its next measure, so the
	 * measured prefix takes a height only once it is marked. `measure` when the update came from that measure loop, which
	 * carries no transaction: the measure read the lines the update before it drew (the pending lines) before it moved
	 * anything, so they are read again and marked, whether or not they are still drawn. A marked height that moves outside that
	 * is an estimate again until a measure reads it. `whole` when these are all the lines drawn now: the heights on record are
	 * then the editor's own for exactly these lines (a document change's height comes from them), and they become the pending
	 * lines; not for the changed lines of an edit alone, which join the pending lines as the edit moved them. Lines drawn
	 * away from the prefix keep their heights until the prefix reaches them. The editor's estimate refresh leaves the record as
	 * it was; a new signature or another note starts it again, and it is then seeded from the lines drawn, never from nothing.
	 * Called on every update that drew lines, from the mount on, whether or not the note's ink has loaded. True when the prefix
	 * grew.
	 */
	drawn(from: number, to: number, whole = true, measure = false): boolean {
		const layout = this.layout();
		if (!layout) return false;
		if (whole) {
			this.fresh.from = 1;
			this.fresh.to = 0;
		}
		from = Math.max(from, 1);
		to = Math.min(to, layout.lines);
		const p = this.pending, was = this.measured;
		// The pending lines a measure read are marked as they are read: those drawn now in the same pass as the rest.
		const markFrom = measure ? p.from : 1, markTo = measure ? Math.min(p.to, layout.lines) : 0;
		if (markFrom < from) this.record(markFrom, Math.min(markTo, from - 1), layout, markFrom, markTo);
		if (markTo > to) this.record(Math.max(markFrom, to + 1), markTo, layout, markFrom, markTo);
		if (this.record(from, to, layout, markFrom, markTo) && whole) {
			this.fresh.from = from;
			this.fresh.to = to;
		}
		if (from > to) return this.grow() > was;
		if (whole || p.from > p.to) {
			p.from = from;
			p.to = to;
		} else {
			// The rest of the lines shown are the pending ones as the edit moved them.
			p.from = Math.min(p.from, from);
			p.to = Math.max(p.to, to);
		}
		return this.grow() > was;
	}

	/**
	 * The pending lines, read again and marked: a measure has read them (the editor has been quiet since they were drawn, or this
	 * is that measure's write). Marked, they leave the pending range, so the next keystroke's write reads only the lines it drew.
	 * Nothing is marked while the editor is off screen.
	 */
	private markPending(): void {
		// Off screen, the measure that ran since read no height: the pending lines wait for one that does.
		if (!this.onScreen()) return;
		const layout = this.layout(), p = this.pending;
		if (!layout) return;
		const to = Math.min(p.to, layout.lines);
		if (this.record(p.from, to, layout, p.from, to) || p.from > to) {
			p.from = 1;
			p.to = 0;
		}
		this.grow();
	}

	/**
	 * Lines `from` to `to`'s heights from the layout go on record; those from `markFrom` to `markTo` are marked as a measure's,
	 * and any other marked height that moved loses its mark, the measured prefix stopping above it. False when a height could
	 * not be read.
	 */
	private record(from: number, to: number, layout: LineLayout, markFrom: number, markTo: number): boolean {
		const px = layout.pxPerWorld;
		if (!(px > 0) || to < from) return false;
		this.roomFor(to);
		let top = layout.lineTop(from), read = true;
		if (from === 1 && Number.isFinite(top) && top / px !== this.base) {
			this.base = top / px;
			this.topsGood = 0;
		}
		for (let n = from; n <= to; n++) {
			const next = layout.lineTop(n + 1), h = (next - top) / px;
			top = next;
			if (!(h >= 0) || !Number.isFinite(h)) {
				read = false;
				continue;
			}
			const mark = n >= markFrom && n <= markTo;
			if (mark) this.marked[n] = 1;
			if (!this.valid[n]) {
				this.valid[n] = 1;
				this.validCount++;
				if (n > this.hiLine) this.hiLine = n;
			} else if (this.heights[n] === h) continue;
			else if (!mark && this.marked[n]) {
				this.marked[n] = 0;
				if (n <= this.measured) this.measured = n - 1;
			}
			this.heights[n] = h;
			if (n < this.topsGood) this.topsGood = n;
		}
		return read;
	}

	/** The measured prefix runs on through every marked line below it: its last line. */
	private grow(): number {
		if (Number.isFinite(this.base)) {
			let m = this.measured;
			while (m < this.hiLine && this.marked[m + 1]) m++;
			this.measured = m;
		}
		return this.measured;
	}

	/** Whether marking the pending lines would grow the measured prefix: they start on or above the line after it, and reach past it. */
	get markable(): boolean {
		return this.pending.from <= this.measured + 1 && this.pending.to > this.measured;
	}

	/** Line `n`'s measured top, world units, for `n` up to one past the measured prefix. */
	private trueTop(n: number): number {
		const tops = this.trueTops;
		if (this.topsGood < 1) {
			tops[1] = this.base;
			this.topsGood = 1;
		}
		for (let k = this.topsGood; k < n; k++) tops[k + 1] = tops[k]! + this.heights[k]!;
		if (n > this.topsGood) this.topsGood = n;
		return tops[n]!;
	}

	/** Lines 1 to this one hold a measured height (see drawn). */
	get measuredThrough(): number {
		return this.measured;
	}

	/** The measured prefix of `path`'s note: 0 for a note this surface did not show until now. */
	measuredFor(path: string): number {
		this.own(path);
		return this.measured;
	}

	/** Whether no line holds a measured height: the mount, another note, a new signature, or every line on record edited. */
	get unseeded(): boolean {
		return this.validCount === 0;
	}

	/**
	 * Strokes a lasso drag (or its undo or redo) has just moved. A move keeps each anchor's line while it runs
	 * (translatedAnchor); at its end every honoured anchor is re-taken from where its stroke is shown, as a document change
	 * re-takes it, so the stroke keeps its place on screen and from then on rides the line it was dropped on, not the one it
	 * left. `dys` (an attach step): each is taken at the correction given, whatever its old anchor read. `src`: the note's
	 * store list now, whose panes have their lists marked as this one's peers do.
	 */
	retake(path: string, strokes: readonly InkStroke[], dys: readonly number[] | undefined, src: readonly InkStroke[]): void {
		this.own(path);
		const sig = this.sig, layout = this.layout();
		if (!sig || !layout) return;
		let took = false;
		for (const [i, s] of strokes.entries()) {
			const old = s.lineAnchor;
			const dy = dys ? dys[i]! : old ? this.honoured(s, old, layout) : null;
			if (dy === null) continue;
			const a = this.take(s, layout, sig, dy);
			if (!a) continue;
			// At the log head; taken under the typed lines' old guess, it takes in the measure's entry as a new stroke does.
			a.above = this.above(a.line, layout);
			s.lineAnchor = a;
			this.vouch(s);
			this.stamp(s);
			this.setDy(s, this.epoch, dy);
			if (dys) {
				for (const h of this.peers ?? []) if (h !== this) h.dropDy(s);
				// A pane listed under the store list handed in, while this one is still under an older one, drops its saved
				// correction too: its next read takes the one given here, as a pane listed with this one does.
				const listed = holdersOf.get(src);
				if (listed && listed !== this.peers) for (const h of listed) if (h !== this) h.dropDy(s);
			}
			took = true;
		}
		// The dropped strokes may now be the first or last anchored lines.
		if (took && this.anchored) this.anchored.stale = true;
		// The strokes are every pane's on the note: another pane's list may lack one anchored here, or name its first or last
		// line by one that took another line, so it is built again at its next read.
		const peers = this.peers;
		if (took && peers && peers.length > 1) for (const h of peers) if (h !== this && h.anchored) h.anchored.stale = true;
		// A pane may be listed under the store list handed in while this one is still under an older one: its list is built
		// again too.
		const held = holdersOf.get(src);
		if (took && held && held !== peers) for (const h of held) if (h !== this && h.anchored) h.anchored.stale = true;
	}

	/**
	 * Anchor every stroke of the note that has no anchor this surface honours, when the measured prefix reaches past its page
	 * position: on the line whose measured top holds its bbox top, at that measured top. Its correction is read as any other,
	 * the editor's top for the line now less the measured top, so the stroke shows on its words at once and settles to its page
	 * position as the editor measures the lines above. Never under an estimate: until the prefix reaches it the stroke stays as
	 * it was, shown at its page position (an older build's stroke, or one whose anchor another width, font or build left
	 * behind). Runs once the editor is quiet, never per scroll frame, and not while a rebase window holds a line no measure has
	 * read. The anchors reach the file at the next ordinary save. Answers how many it took; `generation` moves when one shows
	 * away from its page position.
	 */
	anchorMeasured(path: string, src: readonly InkStroke[]): number {
		this.own(path);
		const sig = this.sig, layout = this.layout();
		if (!sig || !layout) return 0;
		// The editor has been quiet since the last lines were drawn, so a measure has read them: the window's lines among them
		// close first, and a changed line still unread holds the pass off.
		this.markPending();
		if (this.window) {
			if (this.closeRead(layout)) this.readAgain(this.anchoredIn(src), layout);
			if (this.window) return 0;
		}
		if (this.measured < 1) return 0;
		// A reloaded list's anchors are read here first: the log folds over the old list before any of them is read.
		this.anchoredIn(src);
		const through = Math.min(this.measured, layout.lines), from = layout.bodyFrom ?? 1;
		// A bbox top above the measured top of the first line past the prefix sits on a measured line.
		const below = this.trueTop(through + 1);
		let took = 0, moved = false, most = 0;
		for (const s of src) {
			const old = s.lineAnchor;
			if (old && this.honoured(s, old, layout) !== null) {
				// An older build's anchor, honoured as that build read it, takes the hash of the text above its line as it is now,
				// its correction unchanged; the next save writes it, and from then an edit above made where no surface saw it is
				// caught. Hashed now for the same reason as a take below.
				if (old.above === undefined && !this.laterSet.has(s)) old.above = this.above(old.line, layout);
				continue;
			}
			// A member is shown by its group: anchored at the place its group shows it (the line under its stored top plus the
			// group's dy, that line's top less the dy), so a read-only view draws it on its words. A pending member waits for
			// its group's read. Free ink anchors at its stored top.
			const g = this.follow.offsetOf(s.id);
			if (g === null) continue;
			const gdy = g?.dy ?? 0, shownY = s.bbox.y + gdy;
			// Old ink waits for the first body line's measure: no frontmatter line is an anchor.
			if (!(shownY < below) || through < from) continue;
			const line = lineUnder(shownY, through, (n) => this.trueTop(n), from);
			const a: LineAnchor = { line, top: this.trueTop(line) - gdy, y: s.bbox.y, key: this.key(line, layout), width: sig.width, fontPx: sig.fontPx };
			// Hashed now, off the pen's path: an anchor that waited on the page write would change the ink a save captures.
			a.above = this.above(line, layout);
			s.lineAnchor = a;
			this.vouch(s);
			this.stamp(s);
			took++;
			// A member's correction is its group's: its anchor moves nothing in this surface.
			if (g !== undefined) continue;
			const dy = this.read(s, a, layout);
			this.setDy(s, this.epoch, dy);
			if (dy !== 0) moved = true;
			most = Math.max(most, Math.abs(dy));
		}
		// The anchored list is read again: these strokes now carry anchors.
		if (took > 0 && this.anchored) this.anchored.stale = true;
		// The strokes are every pane's on the note: another pane's list lacks the ones anchored here, so it is built again at
		// its next read.
		const peers = this.peers;
		if (took > 0 && peers && peers.length > 1) for (const h of peers) if (h !== this && h.anchored) h.anchored.stale = true;
		if (moved) {
			this.generation++;
			this.stepBound += most;
			this.stepSeen = true;
		}
		return took;
	}

	/**
	 * A read moved groups since `before`. Each member whose anchor no longer shows its group's dy (a word that wrapped to
	 * another row of its own line: no line top moved with it) is anchored again at the group's dy now, as anchorMeasured
	 * anchors a member, so a read-only view draws it on its words with the sideways move its record keeps. A member whose
	 * shown top is past the measured prefix loses its anchor instead, and anchorMeasured takes it once the editor is quiet.
	 * An anchor this surface does not honour is left as it is. Answers how many lost theirs.
	 *
	 * The moved groups' members are reached by id, through the store list's id to place map (strokeById's, built once per
	 * change to the list): a keystroke reads the members of the groups it moved, never every stroke of the note. A stroke
	 * is taken only from a place that holds its id; a place that holds another id has the map built again, so free ink is
	 * never anchored to a group. A list that holds an id twice is walked whole, as each stroke there under a moved group's
	 * id is one of its members.
	 */
	retakeMembers(path: string, src: readonly InkStroke[], before: FollowSnapshot): number {
		const follow = this.follow, members = follow.memberMap;
		if (members.size === 0) return 0;
		let moved: Set<string> | null = null;
		for (const [id, was] of before.offsets) {
			const now = follow.groupOffset(id);
			if (now && (!was || was.dy !== now.dy)) (moved ??= new Set()).add(id);
		}
		if (!moved) return 0;
		this.own(path);
		const sig = this.sig, layout = this.layout();
		if (!sig || !layout) return 0;
		// As anchorMeasured: no anchor under an estimate, nor while a rebase window holds a line no measure has read.
		const through = this.window ? 0 : Math.min(this.measured, layout.lines), from = layout.bodyFrom ?? 1;
		const below = through >= from ? this.trueTop(through + 1) : -Infinity;
		let changed = false, cleared = 0;
		const retake = (s: InkStroke, old: LineAnchor, id: string): void => {
			const gdy = follow.groupOffset(id)!.dy, dy = this.honoured(s, old, layout);
			if (dy === null || Math.abs(dy - gdy) < SAME_DY) return;
			changed = true;
			const shownY = s.bbox.y + gdy;
			if (!(shownY < below)) {
				delete s.lineAnchor;
				cleared++;
				return;
			}
			const line = lineUnder(shownY, through, (n) => this.trueTop(n), from);
			const a: LineAnchor = { line, top: this.trueTop(line) - gdy, y: s.bbox.y, key: this.key(line, layout), width: sig.width, fontPx: sig.fontPx };
			a.above = this.above(line, layout);
			s.lineAnchor = a;
			this.vouch(s);
			this.stamp(s);
		};
		// A group's members are the ids its record lists that the member map gives to it (memberMap is built from them), each
		// with its group's id. Null when a place holds a stroke of another id: that place answers for neither stroke.
		const movedIds = moved;
		const byId = (p: IdPlaces): [InkStroke, string][] | null => {
			const found: [InkStroke, string][] = [];
			for (const r of follow.groups()) {
				if (!movedIds.has(r.id)) continue;
				for (const sid of r.strokeIds) {
					if (members.get(sid) !== r.id) continue;
					const i = p.at.get(sid), s = i === undefined ? undefined : src[i];
					if (!s) continue;
					if (s.id !== sid) return null;
					found.push([s, r.id]);
				}
			}
			return found;
		};
		let places = freshIdPlaces(src), found = places ? byId(places) : null;
		// The list changed in place with its revision as it was: the map is built again, once. A list that then holds an id
		// twice is walked whole.
		if (places && !found) {
			places = idPlaces(src);
			found = places.at.size === src.length ? byId(places) : null;
		}
		if (found) {
			for (const [s, id] of found) {
				const old = s.lineAnchor;
				if (old) retake(s, old, id);
			}
		} else {
			for (const s of src) {
				const old = s.lineAnchor, id = old ? members.get(s.id) : undefined;
				if (old && id !== undefined && moved.has(id)) retake(s, old, id);
			}
		}
		// No stroke joins this surface's anchored list here, so a list current for `src` (as anchoredIn keys it) is made again
		// from itself: the strokes that lost their anchors leave it with their places, and its first and last lines' strokes
		// are found again by the build's rule. A list that is not current is built again at its next read.
		const rec = this.anchored;
		if (changed && rec) {
			if (!rec.stale && rec.src === src && rec.len === src.length && rec.ink === inkRevision() && this.heldSrc === src) {
				const list: InkStroke[] = [], at: number[] = [];
				let top: InkStroke | null = null, bottom: InkStroke | null = null;
				for (let i = 0; i < rec.list.length; i++) {
					const s = rec.list[i]!, l = s.lineAnchor;
					if (!l) continue;
					list.push(s);
					at.push(rec.at[i]!);
					if (!top || l.line < top.lineAnchor!.line) top = s;
					if (!bottom || l.line > bottom.lineAnchor!.line) bottom = s;
				}
				this.anchored = { src, len: rec.len, ink: rec.ink, list, at, top, bottom, stale: false };
			} else rec.stale = true;
		}
		// The strokes are every pane's on the note: another pane's list may hold one whose anchor went or changed here, so it
		// is built again at its next read, before any of its anchors is read.
		const peers = this.peers;
		if (changed && peers && peers.length > 1) for (const h of peers) if (h !== this && h.anchored) h.anchored.stale = true;
		// A pane may be listed under the store list handed in while this one is still under an older one: its list is built
		// again too.
		const held = holdersOf.get(src);
		if (changed && held && held !== peers) for (const h of held) if (h !== this && h.anchored) h.anchored.stale = true;
		return cleared;
	}

	/** The stroke's correction, world units: 0 without an anchor this surface honours. */
	dyOf(s: InkStroke): number {
		const g = this.follow.offsetOf(s.id);
		if (g !== undefined) return g?.dy ?? 0;
		const a = s.lineAnchor;
		if (!a) return 0;
		const memo = this.dys.get(s);
		if (memo && memo.epoch === this.epoch) return memo.dy;
		const layout = this.layout();
		const dy = layout ? this.read(s, a, layout) : 0;
		this.setDy(s, this.epoch, dy);
		return dy;
	}

	/** The correction memo written, and the corrected set with it. */
	private setDy(s: InkStroke, epoch: number, dy: number): void {
		this.dys.set(s, { epoch, dy });
		if (dy !== 0 && epoch === this.epoch) this.corrected.add(s);
		else if (dy === 0 && epoch === this.epoch) this.corrected.delete(s);
		else this.unsure.add(s);
	}

	/** The correction memo dropped: the stroke is read again at the next build. */
	private dropDy(s: InkStroke): void {
		this.dys.delete(s);
		this.corrected.delete(s);
		this.unsure.add(s);
	}

	/** The correction an anchor gives now, with the checks of anchorHolds; 0 when any fails or it is past the bound. */
	private read(s: InkStroke, a: LineAnchor, layout: LineLayout): number {
		return this.honoured(s, a, layout) ?? 0;
	}

	/**
	 * The correction an anchor gives now when this surface honours it (anchorHolds, within the bound, and on its first read since
	 * the mount the text above its line as when it was taken); null when it does not. `a` is the stroke's own anchor, which
	 * first applies the document changes logged since it was last resolved.
	 */
	private honoured(s: InkStroke, a: LineAnchor, layout: LineLayout): number | null {
		this.current(s);
		if (!underSignature(a, this.sig) || !Number.isInteger(a.line) || a.line < 1 || a.line > layout.lines ||
			Math.abs(a.y - s.bbox.y) > Y_SLACK) return null;
		if (this.key(a.line, layout) !== a.key) return null;
		if (!this.vouched.has(s)) {
			// The first read since the mount: the text above the line may have changed unheard, and a blank or repeated line
			// hashes the same wherever it sits. An anchor that names that text is honoured only when it still hashes the same;
			// not honoured, the stroke shows where it was drawn. Another pane on the note that vouches for it has heard every
			// change. An anchor without the hash (an older build's) is read as that build read it.
			if (a.above !== undefined && !this.peerVouched(s) && a.above !== this.above(a.line, layout)) return null;
			this.vouch(s);
		}
		if (a.line < (layout.bodyFrom ?? 1)) this.ontoBody(s, a, layout);
		// Taken under the map before its line's box was read: the box is where the stroke was drawn against, so the anchor
		// moves to it and the stroke stays where it is shown (zero snap). At once for a first read in the epoch it was taken
		// in, while no layout update but the read's own has run since the read (a box read in one layout is not applied against
		// the height map of the next); a later one may be a frame the text has not settled in, so the anchor is held under the
		// map, where the stroke was drawn, until two reads of its line agree.
		const takenIn = this.boxLater.get(a);
		if (takenIn !== undefined && this.boxTops.has(a.line)) {
			const same = takenIn !== BOX_HELD && this.boxReadEpoch.get(a.line) === takenIn &&
				this.boxReadLayout.get(a.line) === this.layoutUpdates;
			if (!same && !this.boxSettled.has(a.line)) {
				if (takenIn !== BOX_HELD) this.boxLater.set(a, BOX_HELD);
				this.boxHeld.add(s);
				const held = layout.lineTop(a.line) / layout.pxPerWorld - a.top;
				if (!Number.isFinite(held) || Math.abs(held) > MAX_LINE_CORRECTION) return null;
				return Math.abs(held) < SAME_DY ? 0 : held;
			}
			this.boxLater.delete(a);
			const move = (this.top(a.line, layout) - layout.lineTop(a.line)) / layout.pxPerWorld;
			a.top += move;
			if (Math.abs(move) >= SAME_DY) this.boxTopMoved = true;
		}
		const dy = this.top(a.line, layout) / layout.pxPerWorld - a.top;
		if (!Number.isFinite(dy) || Math.abs(dy) > MAX_LINE_CORRECTION) return null;
		// Under float noise the stroke is where it was taken: an anchor read back from a file, its top to a thousandth, shows 0.
		return Math.abs(dy) < SAME_DY ? 0 : dy;
	}

	/**
	 * An older build's anchor on a frontmatter line, moved onto the first body line with the top it was saved with. Ink on
	 * the first body line got that anchor where the frontmatter shared the body line's top (the first line of a run of lines on
	 * one top is the one found), so its saved top is the body line's top in the view it was drawn in. Read from the body line,
	 * the stroke sits on its line in every view, whichever opens first; read from the fence, a view that shows the frontmatter
	 * would put the fence's top where the body line's was.
	 */
	private ontoBody(s: InkStroke, a: LineAnchor, layout: LineLayout): void {
		const from = layout.bodyFrom ?? 1;
		a.line = from;
		a.key = this.key(from, layout);
		this.hashLater(s);
		if (this.anchored) this.anchored.stale = true;
	}

	/** Line `n`'s top, editor px, read once per layout epoch. */
	private top(n: number, layout: LineLayout): number {
		if (this.topsEpoch !== this.layoutEpoch) {
			this.tops.clear();
			this.topsEpoch = this.layoutEpoch;
		}
		let top = this.tops.get(n);
		if (top === undefined) {
			const map = layout.lineTop(n), box = this.boxTops.get(n);
			if (box === undefined) top = map;
			else {
				top = this.boxTop(n, box, map, layout.pxPerWorld, this.boxDrawn.has(n));
				// The box answers now, whatever it did when read (the height map may have moved since): corrections read from here
				// stand on it, so dropping it must raise answeredDropped.
				if (top !== map) this.boxAnswered.add(n);
			}
			this.tops.set(n, top);
		}
		return top;
	}

	/**
	 * Line `n`'s top, editor px, with `box` (world units) on record and the height map at `map`. A drawn line's box answers while
	 * it sits more than BOX_AGREE_PX off the map. A line not drawn is not read again until it is drawn, so its box answers only
	 * while the map still sits within BOX_AGREE_PX of the top it was read against (boxMaps); once the map moved under it (a zoom
	 * or a scroll re-estimated the lines above), the map answers.
	 */
	private boxTop(n: number, box: number, map: number, px: number, drawn: boolean): number {
		if (Math.abs(box * px - map) <= BOX_AGREE_PX) return map;
		if (!drawn) {
			const at = this.boxMaps.get(n);
			if (at === undefined || !(Math.abs(at * px - map) <= BOX_AGREE_PX)) return map;
		}
		return box * px;
	}

	/** Line `n`'s text key, hashed once until the document changes there. */
	private key(n: number, layout: LineLayout): number {
		let key = this.keys.get(n);
		if (key === undefined) {
			key = lineKey(layout.lineText(n));
			this.keys.set(n, key);
		}
		return key;
	}

	/** The line under editor height `h`, by halving over the epoch's line tops. */
	private lineAt(h: number, layout: LineLayout): number {
		return lineUnder(h, layout.lines, (n) => this.top(n, layout), layout.bodyFrom);
	}

	/**
	 * The anchor for a stroke shown `dy` below its page position: the line under its shown bbox top, that line's top less the
	 * correction shown, so the stroke keeps the place it is shown at. Its lines-above hash is the caller's (hashLater).
	 */
	private take(s: InkStroke, layout: LineLayout, sig: LineSignature, dy: number): LineAnchor | null {
		const px = layout.pxPerWorld;
		if (!(px > 0) || layout.lines < 1 || !Number.isFinite(s.bbox.y)) return null;
		const line = this.lineAt((s.bbox.y + dy) * px, layout);
		const a: LineAnchor = { line, top: this.top(line, layout) / px - dy, y: s.bbox.y, key: this.key(line, layout), width: sig.width, fontPx: sig.fontPx };
		if (this.boxTops.size > 0 && !this.boxTops.has(line)) this.boxLater.set(a, this.layoutEpoch);
		return a;
	}

	/** The stroke as this surface shows it: the store's own object when its correction is 0, else a copy made once per move. */
	shownOf(s: InkStroke): InkStroke {
		const g = this.follow.shown(s);
		if (g !== undefined) return g ?? s;
		const dy = this.dyOf(s);
		if (dy === 0) return s;
		const rev = strokeRev(s), c = this.copies.get(s);
		if (c && c.dy === dy && c.rev === rev) return c.copy;
		const copy = shiftedStroke(s, dy);
		this.copies.set(s, { dy, rev, copy });
		return copy;
	}

	/**
	 * The note's strokes as this surface shows them. The store's own list when every correction is 0, so a note without moved
	 * ink costs one scan per change of its list and nothing per call. Otherwise one list of copies, kept the same object while
	 * only the store's contents change (as the store keeps its own), and a new object when a correction changes.
	 */
	strokesFor(path: string, src: readonly InkStroke[]): readonly InkStroke[] {
		this.own(path);
		const ink = inkRevision(), v = this.shown, fgen = this.follow.generation, n = this.strokesForCounts;
		n.calls++;
		if (v && v.path === path && v.src === src && v.len === src.length && v.ink === ink && v.gen === this.generation && v.fgen === fgen) {
			n.held++;
			return v.out;
		}
		// Why the held list missed, first reason only.
		if (!v || v.path !== path) n.missPath++;
		else if (v.src !== src || v.len !== src.length) n.missList++;
		else if (v.ink !== ink) n.missInk++;
		else if (v.gen !== this.generation) n.missGen++;
		else n.missFollow++;
		// A repaint may be the first to read a changed list: the log folds over the old one before any stroke of it is read.
		const anchored = this.anchoredIn(src), at = this.anchored!.at;
		// The copies list is refilled in place only while it is the list being answered, as the store refills its own.
		let own = v && v.path === path && v.src === src && v.gen === this.generation && v.fgen === fgen && v.out === v.own ? v.own : null;
		// The shown list is the store list sliced and patched. Only the anchored strokes and the members are
		// visited: an anchored stroke with a correction is patched with its copy; a member (found at its last index, checked
		// by id, else by one lookup) with its group's copy, or left out while pending. Every other stroke is shown as itself.
		const map = this.follow.memberMap, len = src.length, idx: number[] = [], obj: (InkStroke | null)[] = [];
		let byId: Map<string, number> | null = null, pends = false;
		if (this.wholeAt !== this.epoch) {
			// The set is not whole for this epoch: every anchored stroke is read, which makes it whole.
			n.fullReads++;
			for (let k = 0; k < anchored.length; k++) {
				const s = anchored[k]!;
				n.visited++;
				if (map.has(s.id) || this.dyOf(s) === 0) continue;
				n.shownOf++;
				idx.push(at[k]!);
				obj.push(this.shownOf(s));
			}
			this.unsure.clear();
			this.wholeAt = this.epoch;
		} else {
			// The unsure are read first (each lands in the set or not), then only the corrected are
			// visited, each at its last index, checked by identity, else found in the anchored list.
			for (const s of this.unsure) {
				n.visited++;
				if (s.lineAnchor && !map.has(s.id)) this.dyOf(s);
			}
			this.unsure.clear();
			let atOf: Map<InkStroke, number> | null = null;
			for (const s of this.corrected) {
				n.visited++;
				if (map.has(s.id)) continue;
				let i = this.correctedAt.get(s);
				if (i === undefined || src[i] !== s) {
					n.lookups++;
					if (!atOf) {
						atOf = new Map();
						for (let k = 0; k < anchored.length; k++) atOf.set(anchored[k]!, at[k]!);
					}
					i = atOf.get(s);
					if (i === undefined) {
						this.corrected.delete(s);
						this.correctedAt.delete(s);
						continue;
					}
					this.correctedAt.set(s, i);
				}
				if (this.dyOf(s) === 0) continue;
				n.shownOf++;
				idx.push(i);
				obj.push(this.shownOf(s));
			}
			// The members' patches below take their indices in any order; the anchored ones are patched by index too.
		}
		for (const id of map.keys()) {
			n.visited++;
			let i = this.memberAt.get(id);
			if (i === undefined || src[i]?.id !== id) {
				n.lookups++;
				if (!byId) {
					n.byIdBuilds++;
					byId = new Map();
					for (let j = 0; j < len; j++) byId.set(src[j]!.id, j);
				}
				i = byId.get(id);
				if (i === undefined) {
					this.memberAt.delete(id);
					continue;
				}
				this.memberAt.set(id, i);
			}
			const s = src[i]!, g = this.follow.shown(s);
			if (g === undefined || g === s) continue;
			if (g === null) pends = true;
			idx.push(i);
			obj.push(g);
		}
		if (idx.length === 0) {
			this.shown = { path, src, len: src.length, ink, gen: this.generation, fgen, out: src, own, depths: null, pending: null };
			n.store++;
			return src;
		}
		if (own) n.refilled++;
		else n.built++;
		own ??= [];
		n.remade += idx.length;
		let depths: number[] | null = null, pending: Map<InkStroke, number> | null = null;
		if (!pends) {
			// Each shown stroke at its store index: the list's positions are the store's depths.
			own.length = len;
			for (let i = 0; i < len; i++) own[i] = src[i]!;
			for (let k = 0; k < idx.length; k++) own[idx[k]!] = obj[k]!;
		} else {
			// A pending group's members are left out: one pass places each shown stroke with its store depth.
			const put = new Map<number, InkStroke | null>();
			for (let k = 0; k < idx.length; k++) put.set(idx[k]!, obj[k]!);
			own.length = 0;
			depths = [];
			pending = new Map();
			for (let i = 0; i < len; i++) {
				const s = src[i]!, o = put.has(i) ? put.get(i)! : s;
				if (o === null) {
					pending.set(s, i);
					continue;
				}
				own.push(o);
				depths.push(i);
			}
		}
		this.shown = { path, src, len: src.length, ink, gen: this.generation, fgen, out: own, own, depths, pending };
		return own;
	}

	/**
	 * Store order for a list strokesFor returned: each stroke's place in the store (null: the list is the
	 * store's own, so its position), and each member left out as pending, by its store stroke. Null for any other list.
	 */
	storeOrder(list: readonly InkStroke[]): { depths: readonly number[] | null; pending: ReadonlyMap<InkStroke, number> | null } | null {
		const v = this.shown;
		return v && v.out === list ? { depths: v.depths, pending: v.pending } : null;
	}

	/**
	 * One store stroke as this surface shows it, as strokesFor places it in its list: a member at its
	 * group's correction, an anchored free stroke at its line's, else itself. Null for a member of a pending group, which
	 * strokesFor leaves out.
	 */
	shownOne(s: InkStroke): InkStroke | null {
		const g = this.follow.shown(s);
		if (g === null) return null;
		return g ?? (s.lineAnchor ? this.shownOf(s) : s);
	}

	/** Whether freeFor would answer its held lists for `src` now, without a walk (rig counters only). */
	freeHeld(path: string, src: readonly InkStroke[]): boolean {
		const v = this.free;
		return this.follow.memberMap.size === 0 || (!!v && v.path === path && v.src === src && v.len === src.length && v.ink === inkRevision() && v.map === this.follow.memberMap);
	}

	/**
	 * The note's shown strokes that are in no attached group, and each group's member strokes as stored: the committed
	 * layers and the extent raster hold free ink only, the attached layer the groups.
	 * The store's own list when no stroke is in a group. Otherwise one list, kept the same object while only the store's
	 * contents change (as the store keeps its own) and across a follow move, which changes no free stroke; a new object
	 * when a line correction or the membership changes.
	 */
	freeFor(path: string, src: readonly InkStroke[]): { free: readonly InkStroke[]; members: ReadonlyMap<string, readonly InkStroke[]> } {
		const follow = this.follow, map = follow.memberMap;
		if (map.size === 0) return { free: this.strokesFor(path, src), members: NO_MEMBERS };
		this.own(path);
		const ink = inkRevision(), v = this.free, fc = this.freeCounts;
		fc.calls++;
		if (v && v.path === path && v.src === src && v.len === src.length && v.ink === ink && v.map === map) {
			// A line correction changes no free stroke unless one is anchored to a line: the list stays the same object, so
			// the extent raster keyed on it survives a keystroke above attached groups.
			if (v.gen === this.generation) {
				fc.held++;
				return v.out;
			}
			if (!v.anchored) {
				v.gen = this.generation;
				fc.held++;
				return v.out;
			}
		}
		// The ink changed, the list did not. A store move in place (Insert Space, a lasso drag) keeps every
		// stroke the same object in the same place: the free list and the member lists hold the same objects, so the answer
		// holds, unless a free stroke shown as a copy (its line correction) changed under it. One identity test per stroke.
		if (v && v.path === path && v.src === src && v.len === src.length && v.map === map && (v.gen === this.generation || !v.anchored)) {
			let same = true;
			const base = v.base, listRev = inkListRevision();
			// The store changed no list in place since the base was taken: the same objects stand in the same places.
			if (v.listRev !== listRev) {
				let i = 0;
				for (; i < base.length; i++) if (src[i] !== base[i]) { same = false; break; }
				fc.baseReads += i;
				if (same) v.listRev = listRev;
			}
			if (same) for (const [s, rev] of v.copies) if (strokeRev(s) !== rev) { same = false; break; }
			if (same) {
				v.ink = ink;
				v.gen = this.generation;
				fc.kept++;
				// A member moved in place: the same lists in a new map, so a box kept per map (shownBoxes) is taken again.
				let movedMember = false;
				for (const [s, rev] of v.memberRevs) if (strokeRev(s) !== rev) { movedMember = true; v.memberRevs.set(s, strokeRev(s)); }
				if (movedMember) v.out = { free: v.out.free, members: new Map(v.out.members) };
				return v.out;
			}
		}
		fc.builds++;
		// The list changed in one window (an erase takes strokes out and puts its pieces in, a cut member's pieces join its
		// group): only the window is placed again, by the membership now.
		const changed = follow.takeMembershipChanges();
		if (v && v.path === path && v.gen === this.generation) {
			const patched = this.patchFree(v, src, ink, map, changed);
			if (patched) return patched;
		} else {
			fc.whole++;
			fc.wholeCold++;
		}
		this.anchoredIn(src);
		const keep = v && v.path === path && v.src === src && v.gen === this.generation && v.map === map ? v.out : null;
		const free: InkStroke[] = keep ? (keep.free as InkStroke[]) : [];
		free.length = 0;
		const members = new Map<string, InkStroke[]>(), copies = new Map<InkStroke, number>(), memberRevs = new Map<InkStroke, number>();
		const freeSrc: InkStroke[] = [];
		let anchored = false;
		for (const s of src) {
			const g = map.get(s.id);
			if (g === undefined) {
				freeSrc.push(s);
				if (s.lineAnchor) {
					anchored = true;
					const o = this.shownOf(s);
					if (o !== s) copies.set(s, strokeRev(s));
					free.push(o);
				} else free.push(s);
				continue;
			}
			memberRevs.set(s, strokeRev(s));
			const list = members.get(g);
			if (list) list.push(s);
			else members.set(g, [s]);
		}
		const out = { free, members };
		this.free = { path, src, len: src.length, ink, gen: this.generation, map, anchored, out, base: src.slice(), listRev: inkListRevision(), freeSrc, copies, memberRevs };
		return out;
	}

	/**
	 * The free list and the member lists patched for one changed window of the store list, or null for a whole build.
	 * Identity compares against the last list find the window; only its strokes are looked up and placed. A leaver leaves the free list or its old group's list, a joiner joins the free list or its group's,
	 * in store order. A window over half the list, or a membership change outside it (an Attach, a Detach, an undo), is a
	 * whole build, counted by its reason.
	 */
	private patchFree(v: NonNullable<LineAnchors["free"]>, src: readonly InkStroke[], ink: number, map: ReadonlyMap<string, string>, changed: ReadonlySet<string>): { free: readonly InkStroke[]; members: ReadonlyMap<string, readonly InkStroke[]> } | null {
		// The anchors fold their log over the changed list first, as a whole build does.
		this.anchoredIn(src);
		const base = v.base, fsrc = v.freeSrc, was = v.map, fc = this.freeCounts, bl = base.length, sl = src.length, m = Math.min(bl, sl);
		const whole = (why: "wholeMapOutside" | "wholeWindowHalf"): null => {
			fc.whole++;
			fc[why]++;
			return null;
		};
		let p = 0;
		while (p < m && src[p] === base[p]) p++;
		let q = 0;
		while (q < m - p && src[sl - 1 - q] === base[bl - 1 - q]) q++;
		const be = bl - q, se = sl - q;
		if (2 * (be - p + se - p) > sl) return whole("wholeWindowHalf");
		let visited = 0;
		if (changed.size > 0) {
			// Every changed id must be a stroke of the window: one that left it or one that came in.
			const inWindow = new Set<string>();
			for (let i = p; i < be; i++) inWindow.add(base[i]!.id);
			for (let i = p; i < se; i++) inWindow.add(src[i]!.id);
			// One outside it changes no list if it is in neither list now (an erased original stays in its
			// record): proven by its old group's held list, which holds exactly the base strokes of that group; outside the
			// window base and src agree, so it is absent from both. An id that was free before is not proven absent.
			for (const id of changed) {
				if (inWindow.has(id)) continue;
				const g = was.get(id), held = g === undefined ? undefined : v.out.members.get(g);
				if (g === undefined) return whole("wholeMapOutside");
				if (held) for (const x of held) { visited++; if (x.id === id) return whole("wholeMapOutside"); }
				fc.absentSkipped++;
			}
		}
		// The free list holds base's non-members in order: its entries before the window, then those inside it.
		let fs = 0;
		for (let i = 0; i < p && fs < fsrc.length; i++) if (fsrc[fs] === base[i]) fs++;
		let fe = fs;
		const leftMembers: InkStroke[] = [];
		for (let i = p; i < be; i++) {
			const s = base[i]!;
			if (fe < fsrc.length && fsrc[fe] === s) fe++;
			else leftMembers.push(s);
		}
		const joinFree: InkStroke[] = [], joinSrc: InkStroke[] = [], joinCopies: [InkStroke, number][] = [];
		const joinMembers = new Map<string, InkStroke[]>();
		let anchored = v.anchored;
		for (let i = p; i < se; i++) {
			const s = src[i]!, g = map.get(s.id);
			visited++;
			if (g !== undefined) {
				const js = joinMembers.get(g);
				if (js) js.push(s);
				else joinMembers.set(g, [s]);
				continue;
			}
			joinSrc.push(s);
			if (s.lineAnchor) {
				anchored = true;
				const o = this.shownOf(s);
				if (o !== s) joinCopies.push([s, strokeRev(s)]);
				joinFree.push(o);
			} else joinFree.push(s);
		}
		let members = v.out.members;
		if (leftMembers.length > 0 || joinMembers.size > 0) {
			const next = new Map(members);
			// The list position each group's first leaver held: that group's joiners go there.
			const at = new Map<string, number>();
			for (const s of leftMembers) {
				visited++;
				const g = was.get(s.id), list = g === undefined ? undefined : next.get(g);
				if (g === undefined || !list) continue;
				const k = list.indexOf(s);
				if (k < 0) continue;
				if (!at.has(g)) at.set(g, k);
				next.set(g, list.filter((x) => x !== s));
			}
			for (const [g, js] of joinMembers) {
				const list = next.get(g) ?? [];
				let k = at.get(g);
				if (k === undefined) {
					// No leaver of this group in the window: the joiners go before its first member after the window,
					// each member's place read from its kept index and checked by identity.
					k = list.length;
					for (let j = 0; j < list.length; j++) {
						visited++;
						const x = list[j]!, i = this.memberAt.get(x.id);
						if (i === undefined) return whole("wholeMapOutside");
						if (i < p && src[i] === x) continue;
						if (i >= be && src[i - (bl - sl)] === x) {
							k = j;
							break;
						}
						return whole("wholeMapOutside");
					}
				}
				next.set(g, [...list.slice(0, k), ...js, ...list.slice(k)]);
			}
			for (const [g, list] of next) if (list.length === 0) next.delete(g);
			members = next;
		}
		for (let k = fs; k < fe; k++) v.copies.delete(fsrc[k]!);
		for (const [s, rev] of joinCopies) v.copies.set(s, rev);
		for (const s of leftMembers) v.memberRevs.delete(s);
		for (const js of joinMembers.values()) for (const s of js) v.memberRevs.set(s, strokeRev(s));
		const free = v.src === src && v.map === map ? (v.out.free as InkStroke[]) : v.out.free.slice();
		free.splice(fs, fe - fs, ...joinFree);
		fsrc.splice(fs, fe - fs, ...joinSrc);
		const out = { free, members };
		fc.patched++;
		fc.patchVisited += visited;
		Object.assign(v, { src, len: sl, ink, map, anchored, out, base: src.slice(), listRev: inkListRevision() });
		return out;
	}

	/** Whether this surface currently shows any stroke away from its page position. */
	get moved(): boolean {
		const v = this.shown;
		return v !== null && v.out !== v.src;
	}

	/**
	 * The note's anchored strokes, read once per change of its list. A changed list first folds the shift log over the old
	 * one, so a stroke new to the list (another pane's, the file's, a piece) starts at the log head, as taken.
	 */
	private anchoredIn(src: readonly InkStroke[]): InkStroke[] {
		const ink = inkRevision(), a = this.anchored;
		if (a && !a.stale && a.src === src && a.len === src.length && a.ink === ink && this.heldSrc === src) return a.list;
		// The list is every pane's: each one's log folds over the old one, so a new stroke starts at every head.
		this.foldLog();
		if (this.heldSrc !== src) this.hold(src);
		this.foldPeers();
		const list: InkStroke[] = [], at: number[] = [];
		let top: InkStroke | null = null, bottom: InkStroke | null = null;
		// The same walk keeps each group member's index, so strokesFor finds every member without a second walk.
		// Only while some member has no index yet: a full map is checked by id in strokesFor, so later walks skip the lookup.
		const members = this.follow.memberMap, withMembers = members.size > 0 && this.memberAt.size < members.size;
		for (let i = 0; i < src.length; i++) {
			const s = src[i]!, l = s.lineAnchor;
			if (withMembers && members.has(s.id)) this.memberAt.set(s.id, i);
			if (!l) continue;
			list.push(s);
			at.push(i);
			if (!top || l.line < top.lineAnchor!.line) top = s;
			if (!bottom || l.line > bottom.lineAnchor!.line) bottom = s;
		}
		if (a) {
			if (!this.readFirst(a.list, list)) this.newIn(a.list, list);
			this.left(a.list, list);
		} else this.wholeAt = -1;
		this.anchored = { src, len: src.length, ink, list, at, top, bottom, stale: false };
		return list;
	}

	/**
	 * A first list (the old one empty, or no stroke kept at either end) is read here, at the pass that marks it, not left
	 * unsure for the next build: on a large note that build runs inside a pen release. The set is whole for this epoch
	 * once every stroke of it is read; a later layout change starts a new epoch and reads again. False with no layout.
	 */
	private readFirst(was: readonly InkStroke[], now: readonly InkStroke[]): boolean {
		if (now.length === 0 || (was.length > 0 && (was[0] === now[0] || was[was.length - 1] === now[now.length - 1]))) return false;
		if (!this.layout()) return false;
		for (const s of now) {
			this.dyOf(s);
			this.unsure.delete(s);
		}
		if (this.unsure.size === 0) this.wholeAt = this.epoch;
		return true;
	}

	/** The strokes of `now` that `was` did not hold at their place (both in store order) are unsure. */
	private newIn(was: readonly InkStroke[], now: readonly InkStroke[]): void {
		const n = Math.min(was.length, now.length);
		let i = 0;
		while (i < n && was[i] === now[i]) i++;
		let j = was.length - 1, k = now.length - 1;
		while (j >= i && k >= i && was[j] === now[k]) {
			j--;
			k--;
		}
		for (let m = i; m <= k; m++) this.unsure.add(now[m]!);
	}

	/**
	 * Keep the strokes that left the list between `was` and `now`. Both keep the store's order, so the part the change left
	 * alone at either end is found by identity alone, and only the part between is compared by id: a stroke committed costs
	 * a walk of the list and no id read.
	 */
	private left(was: readonly InkStroke[], now: readonly InkStroke[]): void {
		const n = Math.min(was.length, now.length);
		let i = 0;
		while (i < n && was[i] === now[i]) i++;
		let j = was.length - 1, k = now.length - 1;
		while (j >= i && k >= i && was[j] === now[k]) {
			j--;
			k--;
		}
		if (j < i && this.gone.size === 0) return;
		const ids = new Set<string>();
		for (let m = i; m <= k; m++) {
			ids.add(now[m]!.id);
			if (this.gone.size > 0) this.gone.delete(now[m]!.id);
		}
		for (let m = i; m <= j; m++) {
			const s = was[m]!;
			if (!ids.has(s.id)) this.gone.set(s.id, s);
		}
		this.goneScanned += Math.max(0, k - i + 1) + Math.max(0, j - i + 1);
		for (const id of this.gone.keys()) {
			if (this.gone.size <= GONE_CAP) break;
			this.gone.delete(id);
		}
	}

	/**
	 * A layout update with no document change, from `from`: a transaction, the measure loop (whose measure read the lines the
	 * update before it drew, marked before this is called), or a new signature. At the measure loop's update the window's lines
	 * the measure read close first: what they gained since the guess goes on the shift log, for every anchor taken
	 * before it, before any correction is read; when that empties the window and the first and last anchored lines then read the
	 * corrections their strokes show, nothing else moved and every correction read stands. A new signature drops the window
	 * with no entry: its guess holds the old layout's tops, so a measure of it would carry the re-wrap to every anchor. Otherwise
	 * every correction is read again, and the lines no measure has read stay open. True when any shown correction changed.
	 */
	layoutChanged(path: string, src: readonly InkStroke[], from: LayoutUpdate = "transaction"): boolean {
		this.own(path);
		const layout = this.layout();
		if (!layout) return false;
		// Every line top is read again, once; the text keys stand, as no text changed.
		this.layoutEpoch++;
		if (from !== "box") this.layoutUpdates++;
		const list = this.anchoredIn(src);
		if (from === "signature") this.window = null;
		else if (from === "measure" && this.window && this.closeRead(layout) !== null && !this.window) {
			const first = this.anchored?.top ?? null, last = this.anchored?.bottom ?? null;
			if (first && last && this.steady(first, layout) && this.steady(last, layout)) return false;
		}
		return this.readAgain(list, layout);
	}

	/**
	 * An update from the measure loop that changed no layout (the view moved, no height did): its measure read the lines the
	 * update before it drew, marked before this is called, and the window's lines among them close. A correction is read
	 * again only when their entry moved a line, as when an earlier measure read some of their lines. True when any shown
	 * correction changed.
	 */
	windowViewed(path: string, src: readonly InkStroke[]): boolean {
		this.own(path);
		const layout = this.layout();
		if (!layout || !this.window || !this.closeRead(layout)) return false;
		return this.readAgain(this.anchoredIn(src), layout);
	}

	/** Every correction of `list` read again, in a new epoch. True when any shown correction changed. */
	private readAgain(list: readonly InkStroke[], layout: LineLayout): boolean {
		this.epoch++;
		let changed = false, most = 0;
		for (const s of list) {
			const old = this.lastDy(s);
			const dy = this.read(s, s.lineAnchor!, layout);
			// Within float noise the old value stays, so a correction never creeps.
			if (Math.abs(dy - old) < SAME_DY) this.setDy(s, this.epoch, old);
			else {
				this.setDy(s, this.epoch, dy);
				changed = true;
				most = Math.max(most, Math.abs(dy - old));
			}
		}
		// Every anchored stroke of the list was read in this epoch, so the corrected set is whole for it.
		if (list === this.anchored?.list) {
			this.unsure.clear();
			this.wholeAt = this.epoch;
		}
		if (changed) {
			this.generation++;
			this.stepBound += most;
			this.stepSeen = true;
		}
		return changed;
	}

	/**
	 * The open step's summed bound, world units: no shown correction moved further than it since the last take. Null when no read
	 * moved one since then, or a generation move came from no read; either way the step closes.
	 */
	takeStep(): number | null {
		const bound = this.stepSeen && !this.stepUnknown ? this.stepBound : null;
		this.stepBound = 0;
		this.stepUnknown = false;
		this.stepSeen = false;
		return bound;
	}

	/**
	 * The lines of the window a measure has read (marked; the caller marks what its measure read first) close: each range splits
	 * into its runs of read lines and of the rest, each run with its slice of the range's guess (the tops of its lines and the
	 * line after it). The read runs' tops are read again, and what they gained since their guess goes on the log, one entry for
	 * the runs closed together; the runs partition the range, so their entries add up to the whole range's gain. A run of lines
	 * no measure has read stays in the window as a range, which is gone once none remains. Null when no line was read, else
	 * whether an entry went on.
	 */
	private closeRead(layout: LineLayout): boolean | null {
		const w = this.window;
		if (!w) return null;
		const marked = this.marked;
		// Nothing is built while no line of the window has been read.
		if (!w.ranges.some((r) => {
			for (let n = r.from; n <= r.to; n++) if (marked[n]) return true;
			return false;
		})) return null;
		const closed: { ranges: LineRange[]; guess: Float64Array[] } = { ranges: [], guess: [] };
		const open: { ranges: LineRange[]; guess: Float64Array[] } = { ranges: [], guess: [] };
		for (let j = 0; j < w.ranges.length; j++) {
			const r = w.ranges[j]!, g = w.guess[j]!;
			for (let from = r.from; from <= r.to; ) {
				const read = !!marked[from];
				let to = from;
				while (to < r.to && !!marked[to + 1] === read) to++;
				const part = read ? closed : open;
				part.ranges.push({ from, to });
				part.guess.push(g.subarray(from - r.from, to - r.from + 2));
				from = to + 1;
			}
		}
		this.window = open.ranges.length > 0 ? open : null;
		this.layoutEpoch++;
		return this.measureWindow(closed, layout);
	}

	/** Whether this surface honours a stroke's anchor and reads it, now, at the correction the stroke is shown at. */
	private steady(s: InkStroke, layout: LineLayout): boolean {
		const a = s.lineAnchor, memo = this.dys.get(s);
		if (!a || !memo || memo.epoch !== this.epoch) return false;
		const dy = this.honoured(s, a, layout);
		return dy !== null && Math.abs(dy - memo.dy) < SAME_DY;
	}

	/**
	 * A document change. No stroke shown moves, and the change walks no ink when the record of drawn heights says what the
	 * changed lines gained: it goes on the shift log (EditShift) and each anchor applies it when next read. A change to lines
	 * whose heights are not on record (not drawn since their height last changed, another pane's edit off screen) cannot say
	 * that, and takes the eager path: the log is folded and every honoured anchor at or below the change is re-taken now from
	 * where its stroke is shown. Either way the changed lines open (or widen) the rebase window.
	 */
	docChanged(path: string, src: readonly InkStroke[], before: DocBefore, changes: DocChange, after: DocAfter): void {
		this.own(path);
		// Read first: it lists the surface under the note's store list.
		const list = this.anchoredIn(src);
		if (this.writer() !== this) {
			// Another pane on the note writes this change to the shared anchors: this one logs nothing and re-takes nothing. Its
			// window, numbered before the change, closes.
			this.window = null;
			this.skipped(before, changes, after);
			return;
		}
		// Whatever another pane logged while it wrote the note goes first, so one log holds the note's entries.
		this.foldPeers();
		const layout = this.layout();
		this.layoutEpoch++;
		if (!layout) {
			this.changePaths.eager++;
			this.changePaths.why = "no layout";
			this.foldLog();
			this.epoch++;
			this.window = null;
			this.edited(1);
			return;
		}
		let firstA = Infinity, lastA = -1;
		const ranges: LineRange[] = [];
		changes.iterChangedRanges((fromA, toA, fromB, toB) => {
			firstA = Math.min(firstA, fromA);
			lastA = Math.max(lastA, toA);
			ranges.push({ from: after.lineAt(fromB).number, to: after.lineAt(toB).number });
		});
		if (firstA === Infinity) return;
		// The open window's ranges, numbered after the change: one the change leaves untouched keeps its slice of the guess it
		// was opened with, as no measure has closed it since; one it touches joins the change's lines and is guessed again now.
		const kept: { range: LineRange; guess: Float64Array }[] = [];
		const w = this.window;
		if (w) {
			const changed = mergeRanges(ranges);
			for (let j = 0; j < w.ranges.length; j++) {
				const r = w.ranges[j]!;
				if (r.from > before.lines || r.to > before.lines) continue;
				const m = {
					from: after.lineAt(changes.mapPos(before.line(r.from).from, -1)).number,
					to: after.lineAt(changes.mapPos(before.line(r.to).to, 1)).number,
				};
				if (m.to - m.from === r.to - r.from && changed.every((c) => c.from > m.to + 1 || c.to < m.from - 1)) kept.push({ range: m, guess: w.guess[j]! });
				else ranges.push(m);
			}
		}
		const merged = mergeRanges(kept.length > 0 ? ranges.concat(kept.map((k) => k.range)) : ranges);
		// Lines above the first changed one keep their numbers, their text and their tops; lines below the last one keep their
		// text and move `shift` lines on. After the change the changed lines are `firstBefore` to `lastBefore + shift`.
		const firstBefore = before.lineAt(firstA).number, lastBefore = before.lineAt(lastA).number;
		const shift = after.lines - before.lines;
		const sig = this.sig, tops = this.topsOf(firstBefore, lastBefore + shift + 1, layout);
		const grew = sig ? this.grewOf(firstBefore, lastBefore, tops) : NaN;
		if (sig && Number.isFinite(grew)) {
			this.changePaths.lazy++;
			// The lines above the change read as before it: their hash comes from the keys held for the text before it.
			if (list.length > 0) {
				const above = this.above(firstBefore, layout);
				this.append({ kind: "edit", first: firstBefore, last: lastBefore, shift, grew, before, after, tops, sig, keys: null, above, gain: null });
			}
			this.rekey(firstBefore, lastBefore, shift, false);
		} else {
			this.changePaths.eager++;
			this.changePaths.why = this.staleWhy(firstBefore, lastBefore, tops);
			this.retakeNow(list, before, firstBefore, lastBefore, shift, layout);
		}
		const guess = merged.map((r) => {
			const k = kept.find((k) => k.range.from === r.from && k.range.to === r.to);
			if (k) return k.guess;
			return r.from === firstBefore && r.to === lastBefore + shift ? tops : this.topsOf(r.from, r.to + 1, layout);
		});
		this.window = { ranges: merged, guess };
	}

	/**
	 * The eager path of a document change (see docChanged): the log folded, every honoured anchor at or below the change is
	 * re-taken from where its stroke is shown (the line under the shown bbox top, that line's top less the correction shown).
	 * When the change keeps the line count and the first and last anchored lines below it at the tops their strokes were shown
	 * against, every line below kept its number, its text and its top: those anchors already say where their strokes are shown
	 * and only the anchors on the changed lines are re-taken. Otherwise the lines below the change keep their text and move
	 * together, and their anchors are re-taken one line at a time, in place.
	 */
	private retakeNow(list: readonly InkStroke[], before: DocBefore, firstBefore: number, lastBefore: number, shift: number, layout: LineLayout): void {
		this.foldLog();
		// Which anchors held before the change, read against the keys of the document before it, which the cache still holds.
		// Below the change only the first and last anchored lines are looked at, unless they show the lines below have moved.
		const at = this.atScratch, under = this.underScratch;
		at.length = 0;
		under.length = 0;
		let top: InkStroke | null = null, bottom: InkStroke | null = null, first: InkStroke | null = null, last: InkStroke | null = null;
		for (const s of list) {
			const a = s.lineAnchor!;
			if (!top || a.line < top.lineAnchor!.line) top = s;
			if (!bottom || a.line > bottom.lineAnchor!.line) bottom = s;
			// Above the change: its line and top stand.
			if (a.line < firstBefore) continue;
			if (a.line > lastBefore) {
				if (!first || a.line < first.lineAnchor!.line) first = s;
				if (!last || a.line > last.lineAnchor!.line) last = s;
				continue;
			}
			// On the changed lines: re-taken when it held before the change; otherwise left as it is, at its page position, and
			// read again when next asked.
			if (this.heldBefore(s, a, before)) at.push(s);
			else this.dropDy(s);
		}
		// A stroke out of the list (erased) is re-taken as it would be in it, from where it last showed, and names no end.
		for (const s of this.gone.values()) {
			const a = s.lineAnchor;
			if (!a || a.line < firstBefore || a.line > lastBefore) continue;
			if (this.heldBefore(s, a, before)) at.push(s);
			else this.dropDy(s);
		}
		const still = shift === 0 && (first === null ||
			(this.heldBefore(first, first.lineAnchor!, before) && this.heldBefore(last!, last!.lineAnchor!, before) &&
				this.shownAgainst(first, layout) && this.shownAgainst(last!, layout)));
		if (!still) {
			for (const s of list) {
				const a = s.lineAnchor!;
				if (a.line <= lastBefore) continue;
				if (this.heldBefore(s, a, before)) under.push(s);
				else this.dropDy(s);
			}
			for (const s of this.gone.values()) {
				const a = s.lineAnchor;
				if (!a || a.line <= lastBefore) continue;
				if (this.heldBefore(s, a, before)) under.push(s);
				else this.dropDy(s);
			}
		}
		// The changed lines' keys before the change, while the cache holds them: what the change adds to the hashes below.
		let was = 0;
		if (still) for (let n = firstBefore; n <= lastBefore; n++) was = aboveMix(was, this.keyBefore(n, before));
		this.rekey(firstBefore, lastBefore, shift, true);
		if (still) {
			// The lines below kept their numbers and tops, and the text above them changed: their hashes move by the change's gain.
			let now = 0;
			for (let n = firstBefore; n <= lastBefore; n++) now = aboveMix(now, this.key(n, layout));
			const gain = (now - was) >>> 0;
			for (const s of list) if (s.lineAnchor!.line > lastBefore) this.aboveBelow(s, gain, lastBefore);
			for (const s of this.gone.values()) if (s.lineAnchor && s.lineAnchor.line > lastBefore) this.aboveBelow(s, gain, lastBefore);
		}
		const sig = this.sig!;
		this.retakeByLine(at, layout, sig);
		this.retakeByLine(under, layout, sig);
		if (this.anchored) {
			this.anchored.top = top;
			this.anchored.bottom = bottom;
		}
		at.length = 0;
		under.length = 0;
	}

	/**
	 * An anchor below changed lines ending at `last` (the line count kept), whose change added `gain` to the hash of the line
	 * after them: its own hash moves by `gain` times the base to the lines between. Linear, so a hash that no longer matched
	 * its text before the change still does not after it.
	 */
	private aboveBelow(s: InkStroke, gain: number, last: number): void {
		if (this.laterSet.has(s)) return;
		const a = s.lineAnchor!;
		if (a.above !== undefined) a.above = (a.above + Math.imul(gain, abovePow(a.line - 1 - last))) >>> 0;
	}

	/** The tops of lines `from` to `to`, world units, over the epoch's line tops. */
	private topsOf(from: number, to: number, layout: LineLayout): Float64Array {
		const px = layout.pxPerWorld, out = new Float64Array(Math.max(to - from + 1, 0));
		for (let n = from; n <= to; n++) out[n - from] = this.top(n, layout) / px;
		return out;
	}

	/**
	 * The height changed lines `first` to `last` (numbered before the change) gained, world units: their span after the change
	 * (`tops`, first to last) less the heights on record for them. NaN when the record cannot say: a line outside the lines
	 * whose heights are the editor's own (fresh), or with no height on record.
	 */
	private grewOf(first: number, last: number, tops: Float64Array): number {
		const f = this.fresh;
		if (first < f.from || last > f.to || tops.length < 2) return NaN;
		let was = 0;
		for (let n = first; n <= last; n++) {
			if (!this.valid[n]) return NaN;
			was += this.heights[n]!;
		}
		return tops[tops.length - 1]! - tops[0]! - was;
	}

	/** Why the record cannot say what changed lines `first` to `last` gained (grewOf NaN), for the timing trace. */
	private staleWhy(first: number, last: number, tops: Float64Array): string {
		const f = this.fresh;
		if (!this.sig) return "no signature";
		if (f.from > f.to) return "no lines read whole since the record last changed";
		if (first < f.from || last > f.to) return `lines ${first}-${last} outside the lines drawn ${f.from}-${f.to}`;
		for (let n = first; n <= last; n++) if (!this.valid[n]) return `line ${n} has no height on record`;
		return tops.length < 2 ? "no tops" : "a top that is not a number";
	}

	/** Whether a stroke's anchor line has, now, the top the stroke was last shown against: its correction reads the same. */
	private shownAgainst(s: InkStroke, layout: LineLayout): boolean {
		const a = s.lineAnchor!;
		return Math.abs(this.top(a.line, layout) / layout.pxPerWorld - a.top - this.lastDy(s)) < SAME_DY;
	}

	/**
	 * The keys after a change to lines `first` to `last` (numbered before it) that left `shift` more lines: the changed lines'
	 * keys go, those below move `shift` lines on with their text (`move`; otherwise they all go, and are hashed again when next
	 * asked, as moving them is a walk over every key), and so do their measured heights; the measured prefix stops above
	 * `first`.
	 */
	private rekey(first: number, last: number, shift: number, move: boolean): void {
		this.aboveFrom(first);
		this.dropBoxes(first);
		if (shift === 0) this.edited(first, last);
		else if (!move) {
			this.keys.clear();
			this.spliceHeights(first, last, shift);
		} else {
			const moved = this.movedScratch;
			moved.length = 0;
			for (const [n, key] of this.keys) {
				if (n < first) continue;
				if (n > last) moved.push(n + shift, key);
				this.keys.delete(n);
			}
			for (let i = 0; i < moved.length; i += 2) this.keys.set(moved[i]!, moved[i + 1]!);
			this.spliceHeights(first, last, shift);
		}
	}

	/**
	 * The correction a re-take reads a stroke at, world units. A member is shown by its group, so it is its group's dy (0 for
	 * a pending group) and it keeps no memo of its own, as anchorMeasured anchors it; free ink's is its memo, kept for this
	 * epoch, or 0 without one.
	 */
	private retakeDy(s: InkStroke): number {
		const g = this.follow.offsetOf(s.id);
		if (g !== undefined) return g?.dy ?? 0;
		const memo = this.dys.get(s), dy = memo ? memo.dy : 0;
		if (!memo || memo.epoch !== this.epoch) this.setDy(s, this.epoch, dy);
		return dy;
	}

	/**
	 * Re-take each stroke's anchor from where it is shown, at the correction it shows, one anchor line at a time and in place.
	 * The lines below a change move together, so a line is first checked against the shift the line before it took (its top and
	 * the next line's); when that misses, one halving for the line's lowest shown top and one for its highest. When those land
	 * on two lines next to each other, each stroke goes to the one its shown top is on; further apart, it is halved on its own.
	 */
	private retakeByLine(strokes: InkStroke[], layout: LineLayout, sig: LineSignature): void {
		const px = layout.pxPerWorld;
		if (!(px > 0) || layout.lines < 1 || strokes.length === 0) return;
		// Stable, and one pass over a list already in line order, as the store's usually is.
		strokes.sort((p, q) => p.lineAnchor!.line - q.lineAnchor!.line);
		const dys = this.dyScratch;
		dys.length = strokes.length;
		let offset = NaN;
		for (let i = 0; i < strokes.length; ) {
			const line = strokes[i]!.lineAnchor!.line;
			let j = i, lo = Infinity, hi = -Infinity;
			for (; j < strokes.length && strokes[j]!.lineAnchor!.line === line; j++) {
				const s = strokes[j]!, dy = this.retakeDy(s), h = (s.bbox.y + dy) * px;
				dys[j] = dy;
				if (h < lo) lo = h;
				if (h > hi) hi = h;
			}
			let n = line + offset, m = n;
			if (!(n >= 1 && n <= layout.lines && this.covers(n, lo, hi, layout))) {
				n = this.lineAt(lo, layout);
				m = hi === lo ? n : this.lineAt(hi, layout);
			}
			offset = m === n ? n - line : NaN;
			const top = this.top(n, layout) / px, key = this.key(n, layout);
			const split = m === n + 1 ? this.top(m, layout) : NaN;
			for (let k = i; k < j; k++) {
				const s = strokes[k]!, dy = dys[k]!;
				if (!Number.isFinite(s.bbox.y)) continue;
				const h = (s.bbox.y + dy) * px;
				if (m === n || h < split) this.place(s, n, top, key, dy, sig);
				else {
					const l = m === n + 1 ? m : this.lineAt(h, layout);
					this.place(s, l, this.top(l, layout) / px, this.key(l, layout), dy, sig);
				}
			}
			i = j;
		}
	}

	/**
	 * Whether line `n` holds every height from `lo` to `hi`, as lineUnder finds it: three line tops. A line sharing its top with
	 * the line before it (a fold's hidden line) holds none: lineUnder finds the first line of the run. A frontmatter line holds
	 * none; the first body line holds every height above it.
	 */
	private covers(n: number, lo: number, hi: number, layout: LineLayout): boolean {
		const from = layout.bodyFrom ?? 1;
		if (n < from) return false;
		if (n === from) return n === layout.lines || hi < this.top(n + 1, layout);
		const t = this.top(n, layout);
		return t <= lo && this.top(n - 1, layout) < t && (n === layout.lines || hi < this.top(n + 1, layout));
	}

	/** Point a stroke's anchor, in place, at line `n` (top `top`, world units, and text key `key`) with correction `dy` shown. */
	private place(s: InkStroke, n: number, top: number, key: number, dy: number, sig: LineSignature): void {
		const a = s.lineAnchor!;
		a.line = n;
		a.top = top - dy;
		a.y = s.bbox.y;
		a.key = key;
		a.width = sig.width;
		a.fontPx = sig.fontPx;
		this.hashLater(s);
	}

	/**
	 * Whether an anchor named its line and its stroke in the document before a change, under the current signature. The line's
	 * key comes from the per-line cache, which describes the document before this change until the change drops its keys; a
	 * line the cache lacks is hashed once and kept, so no stroke costs a hash of its own.
	 */
	private heldBefore(s: InkStroke, a: LineAnchor, before: DocBefore): boolean {
		if (!underSignature(a, this.sig) || !Number.isInteger(a.line) || a.line < 1 ||
			a.line > before.lines || Math.abs(a.y - s.bbox.y) > Y_SLACK) return false;
		return this.keyBefore(a.line, before) === a.key;
	}

	/** Line `n`'s key in the document before a change, from the cache, which describes it until the change drops its keys. */
	private keyBefore(n: number, before: DocBefore): number {
		let key = this.keys.get(n);
		if (key === undefined) {
			key = lineKey(before.line(n).text);
			this.keys.set(n, key);
		}
		return key;
	}

	/** The correction last read for a stroke, whatever the epoch: what the surface is showing. */
	private lastDy(s: InkStroke): number {
		return this.dys.get(s)?.dy ?? 0;
	}

	/**
	 * A piece cut from `parent`, or the clean shape a freehand stroke became, sits on the parent's line: the parent's anchor,
	 * brought up to the log head (the log alone, no layout read on the eraser's path), is the piece's (pieceAnchor), and the
	 * piece is shown at the parent's correction until the next layout read.
	 */
	inherit(piece: InkStroke, parent: InkStroke): void {
		this.current(parent);
		if (parent.lineAnchor) piece.lineAnchor = pieceAnchor(parent, piece);
		if (piece.lineAnchor && this.laterSet.has(parent)) this.hashLater(piece);
		else if (piece.lineAnchor && this.vouchedAnywhere(parent)) this.vouch(piece);
		this.stamp(piece);
		const memo = this.dys.get(parent);
		if (memo && piece.lineAnchor) this.setDy(piece, memo.epoch, memo.dy);
	}

	/**
	 * The measure after a document change, its write: it read the pending lines, so they are marked, and the window's marked
	 * lines close; the rest stay open for a later measure. A correction is read again only when their entry moved a line. True
	 * when any shown correction changed.
	 */
	closeWindow(path: string, src: readonly InkStroke[]): boolean {
		this.own(path);
		this.markPending();
		const layout = this.layout();
		if (!layout || !this.window || !this.closeRead(layout)) return false;
		return this.readAgain(this.anchoredIn(src), layout);
	}

	/**
	 * Anchor a stroke being committed now, against the line under it as laid out now, at the log head. A stroke committed inside
	 * the rebase window takes in the measure's entry, so the typed lines' measure does not move it either.
	 */
	anchorNew(path: string, s: InkStroke): void {
		this.own(path);
		// No signature yet means the editor was never measured: there is no layout to anchor against, so none is read.
		const sig = this.sig;
		if (!sig) return;
		const layout = this.layout();
		if (!layout) return;
		const a = this.take(s, layout, sig, 0);
		if (!a) return;
		s.lineAnchor = a;
		this.hashLater(s);
		this.stamp(s);
		this.setDy(s, this.epoch, 0);
	}

	/** The generation of the newest entry on the shift log: an anchor at it has applied every change. */
	private get head(): number {
		return this.floor + this.log.length;
	}

	/** Put a change on the shift log, folding it first when full. */
	private append(e: Shift): void {
		if (this.log.length >= SHIFT_LOG_CAP) this.foldLog();
		if (this.log.length === 0) holdLineAnchors(this);
		this.log.push(e);
	}

	/**
	 * Every anchor of the note's last list read, and of every stroke that left it (one an erase took out may come back by
	 * undo), applies the changes logged since it was resolved, and the log empties: a stroke without a generation of
	 * its own is from then on at the head. On a full log, a changed list, another note, the eager path, and before a page is
	 * written (settleLineAnchors). Needs no layout.
	 */
	fold(): void {
		this.foldLog();
		this.settleLater();
	}

	/** The log folded (see fold) without the hashes waiting on a page write: for a fold made while the text is mid-change. */
	private foldLog(): void {
		if (this.log.length === 0) return;
		const list = this.anchored?.list;
		if (list) for (const s of list) this.resolve(s);
		for (const s of this.gone.values()) this.resolve(s);
		this.floor += this.log.length;
		this.log.length = 0;
		if (this.later.length === 0) releaseLineAnchors(this);
	}

	/**
	 * Apply to a stroke's anchor the logged changes newer than it, oldest first, in place: above a change nothing; below it the
	 * lines it added and the height its lines gained (EditShift); on its changed lines a re-take from where the stroke is
	 * shown, against the changed lines' tops after it, when the anchor named its line before it (otherwise it is left as it was,
	 * as the eager path leaves it, and no later change applies); a measure's entry moves it by what the changed lines above it
	 * gained (MeasureShift). The correction the stroke shows stays the same. Reads no layout.
	 */
	private resolve(s: InkStroke): void {
		const log = this.log;
		if (log.length === 0) return;
		const head = this.head, g = this.gens.get(s) ?? this.floor;
		if (g >= head) return;
		this.gens.set(s, head);
		const a = s.lineAnchor;
		if (!a) return;
		// An anchor that names the text above its line carries that hash through each change above it, by arithmetic: a hash
		// that matched its text still does, one that did not still does not. A re-take on its own line names it again.
		const track = !this.laterSet.has(s);
		const carry = track && a.above !== undefined;
		for (let i = Math.max(0, g - this.floor); i < log.length; i++) {
			const e = log[i]!;
			if (e.kind === "measure") {
				a.top += measuredSpanAbove(e, a.line);
				continue;
			}
			if (a.line < e.first) continue;
			if (a.line > e.last) {
				if (carry) a.above = (a.above! + Math.imul(this.gainOf(e), abovePow(a.line - 1 - e.last))) >>> 0;
				a.line += e.shift;
				a.top += e.grew;
				continue;
			}
			if (!this.heldIn(s, a, e) || !Number.isFinite(s.bbox.y)) {
				this.dropDy(s);
				return;
			}
			this.retakeIn(s, a, e);
			this.vouch(s);
		}
	}

	/**
	 * What a logged change added to the lines-above hash of the line after its lines: from line `first`'s hash, the changed
	 * lines' keys after the change less before it, mixed in order. Worked out once per change.
	 */
	private gainOf(e: EditShift): number {
		if (e.gain !== null) return e.gain;
		let was = e.above, now = e.above;
		for (let n = e.first; n <= e.last; n++) was = aboveMix(was, this.shiftKey(e, n, true));
		for (let n = e.first; n <= e.last + e.shift; n++) now = aboveMix(now, this.shiftKey(e, n, false));
		e.gain = (now - was) >>> 0;
		return e.gain;
	}

	/** Whether an anchor on a logged change's lines named its line and its stroke in the document before the change. */
	private heldIn(s: InkStroke, a: LineAnchor, e: EditShift): boolean {
		if (!underSignature(a, e.sig) || !Number.isInteger(a.line) || a.line < 1 || a.line > e.before.lines ||
			Math.abs(a.y - s.bbox.y) > Y_SLACK) return false;
		return a.key === this.shiftKey(e, a.line, true);
	}

	/**
	 * Re-take an anchor on a logged change's lines from where its stroke is shown (its page y plus the correction last read),
	 * against the changed lines' tops after the change: the changed line under the shown top (the first or last when the shown
	 * top is outside them), that line's top less the correction, so the stroke keeps its place. As the eager path's re-take.
	 */
	private retakeIn(s: InkStroke, a: LineAnchor, e: EditShift): void {
		const dy = this.retakeDy(s);
		const t = e.tops, y = s.bbox.y + dy;
		let lo = 0, hi = t.length - 2;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (t[mid]! <= y) lo = mid;
			else hi = mid - 1;
		}
		const n = e.first + lo;
		a.line = n;
		a.top = t[lo]! - dy;
		a.y = s.bbox.y;
		a.key = this.shiftKey(e, n, false);
		a.width = e.sig.width;
		a.fontPx = e.sig.fontPx;
		let above = e.above;
		for (let k = e.first; k < n; k++) above = aboveMix(above, this.shiftKey(e, k, false));
		a.above = above;
	}

	/** Line `n`'s text key in a logged change's document before it, or after it, hashed once per change. */
	private shiftKey(e: EditShift, n: number, before: boolean): number {
		const keys = (e.keys ??= new Map<number, number>());
		const at = before ? n : -n;
		let key = keys.get(at);
		if (key === undefined) {
			key = lineKey((before ? e.before : e.after).line(n).text);
			keys.set(at, key);
		}
		return key;
	}

	/**
	 * The measure that closes runs of rebase window lines (closeRead): each run's tops are read again, and when any of their lines
	 * gained or lost height since the guess, the runs go on the shift log together (MeasureShift) for every anchor taken
	 * before it. True when they went on.
	 */
	private measureWindow(w: { ranges: LineRange[]; guess: Float64Array[] }, layout: LineLayout): boolean {
		const px = layout.pxPerWorld;
		let moved = false;
		const measured = w.ranges.map((r, j) => {
			const g = w.guess[j]!, m = new Float64Array(g.length);
			for (let k = 0; k < g.length; k++) {
				m[k] = this.top(r.from + k, layout) / px;
				if (m[k]! - m[0]! !== g[k]! - g[0]!) moved = true;
			}
			return m;
		});
		if (!moved || (this.anchored?.list.length ?? 0) === 0) return false;
		this.append({ kind: "measure", ranges: w.ranges, guess: w.guess, measured });
		return true;
	}

	/**
	 * A signature from a measure. True when it is a new one, so every correction has to be read again, keys included, and every
	 * measured height is of another layout. The width is sticky: a measured width within one character width (the editor's
	 * latest) of the current signature's re-wraps nothing, and keeps the signature's width and the record (a scrollbar or the
	 * ink's reach moving the content box). The character width the anchors are honoured within is the editor's latest.
	 */
	setSignature(sig: LineSignature): boolean {
		const old = this.sig;
		if (old && underSignature(old, sig)) {
			if (old.charWidth !== sig.charWidth) this.sig = { ...old, charWidth: sig.charWidth };
			return false;
		}
		this.sig = sig;
		this.keys.clear();
		this.forgetHeights();
		return true;
	}
}
