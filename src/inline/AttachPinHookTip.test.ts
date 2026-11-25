/**
 * The pin hooks the words under its tip. The pin's tip sits on its own line and its round head sits PIN_LIFT_PX
 * (13 css px) higher, over the line above. The drop must take the words under the tip as drawn: a flat drag stays on the
 * pin's line, and a drag one line up takes the line above. Before the fix a drag drew the pin with its head at the
 * contact and the drop read the contact (the head), so a flat drag took the line above.
 *
 * Driven on the bare overlay of attachTapRig.test.util.ts through the real lasso contact (lassoDown, lassoMove,
 * lassoUp) and the real drop (dropAttachPin, pinTargetAt), with a view whose line and word reads are worked out from the
 * rig's note. Lines are 40 world units tall from 0; a line's letters sit 4 below its top and are 24 tall; 14 units a
 * character from x 10. The pin's point is the top-left of its words' first letter, as the follow reads it, so the head is
 * over the line above at any zoom where 13 css px is more than 4 world units.
 *
 * Zoom is the note zoom (cssScale): 100% and 200%. The camera's own zoom (the font zoom) stays 1, so a contact's world
 * point is its sample, and the view's rects are visual px: world units times the zoom.
 *
 * A second rig, TIGHT, has the app's row: 16 px text at line height 1.5, so rows 24 tall with the letters 2.5 below a
 * row's top and 19 tall, and each line wraps into two rows ("line " on the first, "N words" on the second, from x 10
 * again). There the pin's point rests 2.5 below its row's top, so a hook read at the point alone takes the row above at
 * 3 px of upward drift. The want: the hook takes the visual row whose letters' top is nearest the pin's point, so under
 * half a row of drift up or down keeps the row, at every zoom and on a paragraph's first row too, even when the drift
 * takes the point over the empty line above that row or above the note's first line; across, the word whose letters
 * hold the point, else the row's paragraph. And the grab offset is kept: the pin as drawn and as hooked is its point at
 * the press plus the move, wherever on the head the contact landed, so the pin does not jump at the press. Note zooms
 * there: 100% and 50%.
 */
import { describe, expect, it } from "vitest";
import { Text, type TransactionSpec } from "@codemirror/state";
import { inlineInk } from "./InkOverlayRegistry";
import { attachPinsOf, PIN_LIFT_PX } from "./AttachDecoration";
import { invertInkOp, type InkOp } from "./InkHistory";
import { doc, line, record, ring, tapRig, type RigOpts } from "./attachTapRig.test.util";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const G1 = ["c1", "c2"];
const CHAR = 14, LEFT = 10;
const ZOOMS = [1, 2];

type Pt = { x: number; y: number };

/** A rig's text layout, world units. */
interface Geo {
	/** A visual row's height: the editor's line pitch. */
	pitch: number;
	/** The letters' top below their row's top, and their height. */
	down: number;
	tall: number;
	/** Each line wraps into two rows: "line " on the first, "N words" on the second, from x 10 again. */
	wrap: boolean;
	/** The note's lines, when not the rig's doc. An empty line is one row and holds no letters. */
	text?: Text;
}
/** The first cells' rig: rows 40 tall, the letters 4 below a row's top and 24 tall, a line one row. */
const LOOSE: Geo = { pitch: 40, down: 4, tall: 24, wrap: false };
/** The app's row: 16 px text at line height 1.5, the letters 2.5 below a row's top and 19 tall; a line two rows. */
const TIGHT: Geo = { pitch: 24, down: 2.5, tall: 19, wrap: true };
/** Where a wrapped line's second row starts: after "line ". */
const WRAP_AT = 5;

/** The note's lines a rig lays out. */
const textOf = (g: Geo) => g.text ?? doc;
/** Line n's rows: two when the rig wraps and the line has text, else one. */
const rowsIn = (g: Geo, n: number) => (g.wrap && textOf(g).line(n).length > 0 ? 2 : 1);
/** Line n's block top: its first row's top. */
const blockTopOf = (g: Geo, n: number) => {
	let top = 0;
	for (let k = 1; k < n; k++) top += rowsIn(g, k) * g.pitch;
	return top;
};
/** The line whose block holds height h: line 1 above the note, the last line below it. */
const lineAtHeight = (g: Geo, h: number) => {
	let n = 1;
	while (n < textOf(g).lines && blockTopOf(g, n + 1) <= h) n++;
	return n;
};
const PITCH = LOOSE.pitch, LETTERS_DOWN = LOOSE.down;
const lineTop = (n: number) => blockTopOf(LOOSE, n);

/** Where a document position sits, world units: its row's top plus `down`, `tall` tall; 14 a character from x 10. */
function placeOf(g: Geo, pos: number) {
	const l = textOf(g).lineAt(pos), col = pos - l.from, second = g.wrap && col >= WRAP_AT;
	const top = blockTopOf(g, l.number) + (second ? g.pitch : 0) + g.down;
	return { left: LEFT + (second ? col - WRAP_AT : col) * CHAR, top, bottom: top + g.tall };
}

/** Line n's word at character `col`, as the drop target should read it, in the rig's doc or `note`. */
const wordOn = (n: number, col: number, text: string, note: Text = doc) => ({ kind: "range", from: note.line(n).from + col, to: note.line(n).from + col + text.length, text });
/** Each line reads "line N words"; "words" starts at character 7 on lines 1 to 9: x 108 to 178. */
const WORDS_X = 140;

function hookRig(path: string, zoom: number, opts: RigOpts = {}, geo: Geo = LOOSE) {
	const r = tapRig(path, opts);
	const t = textOf(geo);
	const block = (n: number) => ({ top: blockTopOf(geo, n), bottom: blockTopOf(geo, n + 1) });
	Object.assign((r.overlay as unknown as { view: object }).view, {
		...(geo.text ? { state: { doc: geo.text } } : {}),
		scaleY: 1,
		// Visual px, so the drop's row pitch is the rig's pitch in world units at every zoom.
		defaultLineHeight: geo.pitch * zoom,
		viewport: { from: 0, to: t.length },
		lineBlockAt: (pos: number) => block(t.lineAt(pos).number),
		lineBlockAtHeight: (h: number) => {
			const l = t.line(lineAtHeight(geo, h));
			return { from: l.from, to: l.to, ...block(l.number) };
		},
		coordsAtPos: (pos: number) => {
			const p = placeOf(geo, pos);
			return { left: p.left * zoom, right: p.left * zoom, top: p.top * zoom, bottom: p.bottom * zoom };
		},
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
	});
	Object.assign(r.overlay, {
		cssScale: zoom,
		scale: zoom,
		fontZoom: 1,
		container: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
		inkInputPanX: () => 0,
		inkInputPanY: () => 0,
		pinchHeld: () => false,
		frame: { locked: true, begin: () => {}, end: () => {} },
		followRefAt: (pos: number) => ({ x: placeOf(geo, pos).left, y: placeOf(geo, pos).top }),
		endLiveGestureForHistory: () => {},
		repaintPath: () => {},
		lineAnchorsMoved: () => {},
		currentIndexes: () => [],
		frontierCache: { invalidate: () => {} },
	});
	// The follow reads each group's words where this view lays them out: a following group's pin point is the top-left
	// of its words' first letter.
	r.anchors.follow.layoutChanged();
	r.anchors.follow.measure({
		inView: () => true,
		refAt: (pos: number) => ({ x: placeOf(geo, pos).left, y: placeOf(geo, pos).top }),
		blockTop: (pos: number) => blockTopOf(geo, t.lineAt(pos).number),
	});
	const o = r.overlay as unknown as { lassoDown(s: object, input: string): void; lassoMove(s: object[]): void; lassoUp(): void };
	const sample = (x: number, y: number) => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
	/**
	 * A drag from (x0, y0) to (x1, y1), world units (the camera's zoom is 1), through the lasso. Returns the pin as drawn at
	 * the last move: the tail's last "pin x,y", its tip.
	 */
	const drag = (x0: number, y0: number, x1: number, y1: number, input: "pen" | "mouse") => {
		o.lassoDown(sample(x0, y0), input);
		r.calls.length = 0;
		o.lassoMove([sample((x0 + x1) / 2, y0 + (y1 - y0) / 2)]);
		o.lassoMove([sample(x1, y1)]);
		const drawn = r.calls.filter((c) => c.startsWith("pin ")).pop();
		o.lassoUp();
		return drawn;
	};
	/** The dragged pin's point as last drawn (the tail's last "pin x,y"), or null when none was drawn. */
	const drawnPin = (): Pt | null => {
		const c = r.calls.filter((s) => s.startsWith("pin ")).pop();
		if (!c) return null;
		const n = c.slice(4).split(",").map(Number);
		return { x: n[0]!, y: n[1]! };
	};
	/** A contact pressed at `from`, moved to each point in turn, then lifted: the pin as drawn after each move. */
	const dragThrough = (from: Pt, moves: readonly Pt[], input: "pen" | "mouse" | "touch"): (Pt | null)[] => {
		o.lassoDown(sample(from.x, from.y), input);
		const drawn = moves.map((m) => {
			r.calls.length = 0;
			o.lassoMove([sample(m.x, m.y)]);
			return drawnPin();
		});
		o.lassoUp();
		return drawn;
	};
	const group = (id: string) => inlineInk.attachments(path).find((a) => a.id === id) as AttachmentRecord;
	const pins = () => attachPinsOf(r.overlay as never, inlineInk.attachments(path), inlineInk.strokes(path), inlineInk.generation(path));
	return { ...r, drag, dragThrough, group, pins };
}

/** Let the measure's write and its microtask run. */
const settle = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

/** The pin's lift, world units, at this note zoom. */
const lift = (zoom: number) => PIN_LIFT_PX / zoom;

/**
 * A held group placed so its pin's point sits just below line 4's top at both zooms: its box's top is 129, so the point
 * is 129 - 8/zoom (121 at 100%, 125 at 200%) and the head 13/zoom above it, on line 3.
 */
function heldStrokes() {
	return [ring("c1", 40, 131, 160, 36), line("c2", 70, 160, 60), ring("d1", 10, 340, 160, 36), line("d2", 40, 370, 60), line("free", 10, 780, 160)];
}

describe("a following group's pin hooks the words under its tip", () => {
	it.each(ZOOMS)("zoom %d: a flat drag along line 3 keeps line 3 (line 2 is right above it)", async (zoom) => {
		const r = hookRig(`hook-flat-${zoom}.md`, zoom);
		r.selection.selectExactly(G1);
		r.redraw();
		const at = { x: LEFT, y: lineTop(3) + LETTERS_DOWN };
		expect(r.pins(), "premise: the pin's point is the top-left of line 3's first letter").toEqual([{ id: "g1", at, held: false }]);
		const head = { x: at.x, y: at.y - lift(zoom) };
		expect(head.y < lineTop(3), "premise: the head is over line 2").toBe(true);
		const drawn = r.drag(head.x, head.y, WORDS_X, head.y, "pen");
		expect(drawn, "premise: the dragged pin is drawn with its tip on line 3, under the contact").toBe(`pin ${WORDS_X},${at.y}`);
		await settle();
		expect(r.group("g1").target, "the hook: line 3's word under the tip").toMatchObject(wordOn(3, 7, "words"));
	});

	it.each(ZOOMS)("zoom %d: a drag one line up takes line 2", async (zoom) => {
		const r = hookRig(`hook-up-${zoom}.md`, zoom);
		r.selection.selectExactly(G1);
		r.redraw();
		const at = { x: LEFT, y: lineTop(3) + LETTERS_DOWN };
		expect(r.pins(), "premise: the pin's point").toEqual([{ id: "g1", at, held: false }]);
		const head = { x: at.x, y: at.y - lift(zoom) };
		const drawn = r.drag(head.x, head.y, WORDS_X, head.y - PITCH, "pen");
		expect(drawn, "premise: the dragged pin's tip is on line 2").toBe(`pin ${WORDS_X},${at.y - PITCH}`);
		await settle();
		expect(r.group("g1").target, "the hook: line 2's word under the tip").toMatchObject(wordOn(2, 7, "words"));
	});
});

describe("a held group's pin hooks the words under its tip", () => {
	it.each(ZOOMS)("zoom %d: a flat drag along line 4 keeps line 4 (line 3 is right above it)", async (zoom) => {
		const r = hookRig(`hook-held-flat-${zoom}.md`, zoom, { held: ["g1"], strokes: heldStrokes() });
		r.redraw();
		r.paint("all");
		const at = { x: 38 - 14 / zoom, y: 129 - 8 / zoom };
		expect(r.pins(), "premise: the held pin's point is just below line 4's top").toEqual([{ id: "g1", at, held: true }]);
		expect(at.y > lineTop(4), "premise: the point is on line 4").toBe(true);
		const head = { x: at.x, y: at.y - lift(zoom) };
		expect(head.y < lineTop(4), "premise: the head is over line 3").toBe(true);
		const drawn = r.drag(head.x, head.y, WORDS_X, head.y, "mouse");
		expect(drawn, "premise: the dragged pin's tip is on line 4").toBe(`pin ${WORDS_X},${at.y}`);
		await settle();
		expect(r.group("g1").target, "the hook: line 4's word under the tip").toMatchObject(wordOn(4, 7, "words"));
	});

	it.each(ZOOMS)("zoom %d: a drag one line up takes line 3", async (zoom) => {
		const r = hookRig(`hook-held-up-${zoom}.md`, zoom, { held: ["g1"], strokes: heldStrokes() });
		r.redraw();
		r.paint("all");
		const at = { x: 38 - 14 / zoom, y: 129 - 8 / zoom };
		expect(r.pins(), "premise: the held pin's point").toEqual([{ id: "g1", at, held: true }]);
		const head = { x: at.x, y: at.y - lift(zoom) };
		const drawn = r.drag(head.x, head.y, WORDS_X, head.y - PITCH, "mouse");
		expect(drawn, "premise: the dragged pin's tip is on line 3").toBe(`pin ${WORDS_X},${at.y - PITCH}`);
		await settle();
		expect(r.group("g1").target, "the hook: line 3's word under the tip").toMatchObject(wordOn(3, 7, "words"));
	});
});

// The TIGHT rig. Line n's block is 48 tall from (n - 1) * 48: its first row holds "line" (x 10 to 66), its second "N"
// (x 10 to 24) and "words" (x 38 to 108 on lines 1 to 9), letters 2.5 below each row's top and 19 tall. Every drop is at
// x 60, inside "line" on a first row and "words" on a second, so a row taken is told by its word. Drift is css px, so
// world units px / zoom; half a row is 12 world units at every zoom.

const TIGHT_ZOOMS = [1, 0.5];
const X_DROP = 60;
const DOC = doc.toString();
type Row = "first" | "middle";
/**
 * The pin's point (the top-left of its words' first letter): g1 hooked to all of line 3 has it on line 3's first row; g1
 * hooked to line 3's "3 words" has it on line 3's second row, a middle row of its paragraph.
 */
const ROW_AT: Record<Row, Pt> = { first: { x: LEFT, y: 96 + 2.5 }, middle: { x: LEFT, y: 120 + 2.5 } };
/** The word at x 60 on the pin's own row, and on the row above it. */
const ROW_WORD: Record<Row, ReturnType<typeof wordOn>> = { first: wordOn(3, 0, "line"), middle: wordOn(3, 7, "words") };
const ROW_ABOVE: Record<Row, ReturnType<typeof wordOn>> = { first: wordOn(2, 7, "words"), middle: wordOn(3, 0, "line") };

/** g1 hooked to line 3's "3 words", so its pin's point is that row's first letter; g2 as the rig has it. */
function middleRowGroups(): AttachmentRecord[] {
	const l = doc.line(3);
	return [{ ...record("g1", G1, "line 3 words"), target: targetAt(DOC, l.from + WRAP_AT, l.to, "range") }, record("g2", ["d1", "d2"], "line 10 words")];
}

/** The TIGHT rig with g1 selected, its pin's point on the `row` row of line 3 (checked as a premise). */
function tightRig(path: string, zoom: number, row: Row) {
	const r = hookRig(path, zoom, row === "middle" ? { attachments: middleRowGroups() } : {}, TIGHT);
	r.selection.selectExactly(G1);
	r.redraw();
	const at = ROW_AT[row];
	expect(r.pins(), `premise: the pin's point is the first letter of line 3's ${row} row`).toEqual([{ id: "g1", at, held: false }]);
	return { ...r, at, head: { x: at.x, y: at.y - lift(zoom) } };
}

const near = (got: Pt | null | undefined, want: Pt, what: string) => {
	expect(got, `${what}: a pin is drawn`).toBeTruthy();
	expect(got!.x, `${what}, x`).toBeCloseTo(want.x, 9);
	expect(got!.y, `${what}, y`).toBeCloseTo(want.y, 9);
};

const ops = (spec: TransactionSpec): InkOp[] => [spec.effects ?? []].flat().map((e) => (e as { value: InkOp }).value);
const steps = (sent: TransactionSpec[]) => sent.filter((spec) => ops(spec).some((op) => typeof (op as { type?: unknown } | null)?.type === "string"));

describe("TIGHT: the hook takes the row whose letters' top is nearest the pin's point", () => {
	const drift = TIGHT_ZOOMS.flatMap((zoom) => (["first", "middle"] as const).flatMap((row) => [-3, 3].map((px) => ({ zoom, row, px }))));
	it.each(drift)("zoom $zoom, the pin on line 3's $row row, a drag along it ending $px px down (minus is up): that row's word", async ({ zoom, row, px }) => {
		const r = tightRig(`hook-drift-${row}-${zoom}-${px}.md`, zoom, row);
		const d = px / zoom;
		const drawn = r.dragThrough(r.head, [{ x: (r.head.x + X_DROP) / 2, y: r.head.y + d / 2 }, { x: X_DROP, y: r.head.y + d }], "pen");
		near(drawn[1], { x: X_DROP, y: r.at.y + d }, "premise: the pin is drawn at its point at the press plus the move");
		await settle();
		expect(r.group("g1").target, `the hook: the ${row} row's word at the pin's point`).toMatchObject(ROW_WORD[row]);
	});

	const over = TIGHT_ZOOMS.flatMap((zoom) => (["first", "middle"] as const).map((row) => ({ zoom, row })));
	it.each(over)("zoom $zoom, the pin on line 3's $row row, a drag ending 0.6 of a row up: the row above's word", async ({ zoom, row }) => {
		const r = tightRig(`hook-over-${row}-${zoom}.md`, zoom, row);
		const d = -0.6 * TIGHT.pitch;
		const drawn = r.dragThrough(r.head, [{ x: (r.head.x + X_DROP) / 2, y: r.head.y + d / 2 }, { x: X_DROP, y: r.head.y + d }], "pen");
		near(drawn[1], { x: X_DROP, y: r.at.y + d }, "premise: the pin is drawn at its point at the press plus the move");
		await settle();
		expect(r.group("g1").target, "the hook: the row above's word").toMatchObject(ROW_ABOVE[row]);
	});
});

// The TIGHT rig's edges: a paragraph's first row under an empty line, and the note's first line. An empty line is one
// row, so with line 2 empty line 3's block starts at 72 and its first row's letters at 74.5; line 1's letters are at 2.5.
// A 3 px upward drift takes the pin's point over the empty line (71.5 at 100%, 68.5 at 50%) or above the note (-0.5,
// -3.5), where no line has text, yet that first row's letters' top is still the nearest.

/** The rig's note with line 2 empty. */
const BLANK_LINE_2 = Text.of(Array.from({ length: doc.lines }, (_, i) => (i === 1 ? "" : doc.line(i + 1).text)));
const TIGHT_BLANK: Geo = { ...TIGHT, text: BLANK_LINE_2 };

/** g1 hooked to all of line 3 of the note with line 2 empty, g2 to all of its line 10. */
function blankLineGroups(): AttachmentRecord[] {
	const s = BLANK_LINE_2.toString(), all = (n: number) => targetAt(s, BLANK_LINE_2.line(n).from, BLANK_LINE_2.line(n).to, "range");
	return [{ ...record("g1", G1, "line 3 words"), target: all(3) }, { ...record("g2", ["d1", "d2"], "line 10 words"), target: all(10) }];
}

/** g1 hooked to all of line 1, g2 as the rig has it. */
function firstLineGroups(): AttachmentRecord[] {
	return [record("g1", G1, "line 1 words"), record("g2", ["d1", "d2"], "line 10 words")];
}

const EDGE = {
	blank: { geo: TIGHT_BLANK, groups: blankLineGroups, line: 3, at: { x: LEFT, y: 72 + 2.5 } },
	top: { geo: TIGHT, groups: firstLineGroups, line: 1, at: { x: LEFT, y: 2.5 } },
};

/** The TIGHT rig with g1 selected, its pin's point on the first row of line 3 under the empty line 2, or of line 1. */
function edgeRig(path: string, zoom: number, edge: keyof typeof EDGE) {
	const e = EDGE[edge];
	const r = hookRig(path, zoom, { attachments: e.groups() }, e.geo);
	r.selection.selectExactly(G1);
	r.redraw();
	expect(blockTopOf(e.geo, e.line) + e.geo.down, `premise: line ${e.line}'s first row's letters' top`).toBe(e.at.y);
	expect(r.pins(), `premise: the pin's point is the first letter of line ${e.line}'s first row`).toEqual([{ id: "g1", at: e.at, held: false }]);
	return { ...r, at: e.at, head: { x: e.at.x, y: e.at.y - lift(zoom) } };
}

describe("TIGHT: a paragraph's first row keeps the hook when the drift takes the pin's point off the note's text", () => {
	const zooms = TIGHT_ZOOMS.map((zoom) => ({ zoom }));
	it.each(zooms)("zoom $zoom, the pin on line 3's first row right under an empty line 2, a flat drag ending 3 px up: that row's word", async ({ zoom }) => {
		const r = edgeRig(`hook-blank-above-${zoom}.md`, zoom, "blank");
		const d = -3 / zoom, y = r.at.y + d;
		expect(BLANK_LINE_2.line(2).length === 0 && y >= blockTopOf(TIGHT_BLANK, 2) && y < blockTopOf(TIGHT_BLANK, 3), "premise: the point at the drop is over the empty line 2").toBe(true);
		const drawn = r.dragThrough(r.head, [{ x: (r.head.x + X_DROP) / 2, y: r.head.y + d / 2 }, { x: X_DROP, y: r.head.y + d }], "pen");
		near(drawn[1], { x: X_DROP, y }, "premise: the pin is drawn at its point at the press plus the move");
		await settle();
		expect(r.group("g1").target, "the hook: line 3's first row's word at the pin's point").toMatchObject(wordOn(3, 0, "line", BLANK_LINE_2));
	});

	it.each(zooms)("zoom $zoom, the pin on line 1's first row, a flat drag ending 3 px up, over the note's top: that row's word", async ({ zoom }) => {
		const r = edgeRig(`hook-note-top-${zoom}.md`, zoom, "top");
		const d = -3 / zoom, y = r.at.y + d;
		expect(y < blockTopOf(TIGHT, 1), "premise: the point at the drop is above line 1").toBe(true);
		const drawn = r.dragThrough(r.head, [{ x: (r.head.x + X_DROP) / 2, y: r.head.y + d / 2 }, { x: X_DROP, y: r.head.y + d }], "pen");
		near(drawn[1], { x: X_DROP, y }, "premise: the pin is drawn at its point at the press plus the move");
		await settle();
		expect(r.group("g1").target, "the hook: line 1's first row's word at the pin's point").toMatchObject(wordOn(1, 0, "line"));
	});
});

describe("TIGHT: the grab offset is kept, so the pin does not jump and hooks by its own point", () => {
	// A finger's hit square on the head is 44 css px, a pen's 20: a finger may land 19 px below the head's centre, a pen 8.
	const low = TIGHT_ZOOMS.flatMap((zoom) => [{ zoom, input: "touch" as const, px: 19 }, { zoom, input: "pen" as const, px: 8 }]);
	it.each(low)("zoom $zoom, a $input pressed $px px below the head's centre, a flat drag: the word on the pin's own row", async ({ zoom, input, px }) => {
		const r = tightRig(`hook-low-${input}-${zoom}.md`, zoom, "first");
		const from = { x: r.head.x, y: r.head.y + px / zoom };
		r.dragThrough(from, [{ x: from.x + 25, y: from.y }, { x: X_DROP, y: from.y }], input);
		await settle();
		expect(r.group("g1").target, "the hook: the row under the pin's point, not under the contact").toMatchObject(ROW_WORD.first);
	});

	it.each(low)("zoom $zoom, a $input pressed $px px below the head's centre: no jump at the first frame; the hook is the word under the pin drawn at the lift", async ({ zoom, input, px }) => {
		const r = tightRig(`hook-nojump-${input}-${zoom}.md`, zoom, "first");
		const from = { x: r.head.x, y: r.head.y + px / zoom };
		const drawn = r.dragThrough(from, [{ x: from.x + 30, y: from.y }, { x: X_DROP, y: from.y }], input);
		near(drawn[0], { x: r.at.x + 30, y: r.at.y }, "no jump: at the first frame past the pad the pin is its point at the press plus the move");
		near(drawn[1], { x: X_DROP, y: r.at.y }, "the pin drawn at the lift");
		await settle();
		expect(r.group("g1").target, "the hook: the word under the pin drawn at the lift").toMatchObject(ROW_WORD.first);
	});

	it("zoom 1, a flat drag on line 3's first row: one history step, the attach alone, whose undo puts the old hook back", async () => {
		const r = tightRig("hook-undo.md", 1, "first");
		const old = r.group("g1").target;
		r.dragThrough(r.head, [{ x: (r.head.x + X_DROP) / 2, y: r.head.y }, { x: X_DROP, y: r.head.y }], "pen");
		await settle();
		expect(r.group("g1").target, "the hook: the first row's word").toMatchObject(ROW_WORD.first);
		const s = steps(r.sent);
		expect(s, "one history step").toHaveLength(1);
		const step = ops(s[0]!);
		expect(step.map((op) => op.type), "the step is the attach alone").toEqual(["attach"]);
		const undo = invertInkOp(step[0]!) as { after: AttachmentRecord | null };
		expect(undo.after?.target, "its undo puts the old hook back").toEqual(old);
	});
});
