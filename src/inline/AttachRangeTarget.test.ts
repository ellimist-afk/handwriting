/**
 * Attach on ink inside one visual row targets the words under it, not the whole paragraph. A circle around a word in
 * the middle of a line slides with that word when text is typed in front of it, moves with it when it wraps to the next
 * row, and needs reattachment when the word is deleted. The words are those on the row under the box's centre whose
 * horizontal middle lies inside the box. A box taller than one row, or one over no word's middle, keeps the paragraph.
 * The selected group's label reads "Attached" on both; the mark on its text shows the words or the whole paragraph.
 *
 * A bare overlay over a fake view: every character CW world px wide but W, twice that, rows LH high, each line
 * word-wrapped at COLS characters as the editor wraps it. coordsAtPos reports the character's letters as the editor does:
 * FH high, centred on its row, shorter than the row. A text change tells the follow nothing about the layout, as in the
 * editor: the follow's own re-read moves the ink. A rig may give its own lines, a line drawn as a tall widget inside a
 * text line (an embed: its places are the widget's whole rect, TALL high), a widget block (Properties: TALL high,
 * not a text block, or WIDGET_H high where a cell says so), and a heading line (one row BIG high, its letters 1.6 LH
 * high by default, centred, overflowing the row where a cell asks for more).
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { BlockType, type ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, settleLineAnchors, type InkStroke } from "../ink/Stroke";
import { SelectionModel } from "../objects/SelectionModel";
import type { AttachmentRecord } from "./InkAttachments";
import { ATTACH_STRINGS, attachChrome, groupBoxes, setAttachTarget } from "./AttachDecoration";
import { shownStrokes, type LineSpans } from "./EmbedInkLines";

const CW = 14, LH = 40, FH = 26, COLS = 30, TALL = 160, BIG = 2 * LH, BIG_FH = 1.6 * LH;
const SIG = { width: COLS * CW, fontPx: 26, charWidth: CW };
const LINES = ["the quick brown fox jumps", "a second plain line", "third line here", "fourth line here"];

/** The rows of one line as the editor wraps it: [start, end) offsets, a row's trailing spaces kept on it. */
function rowsOf(text: string): { start: number; end: number }[] {
	const rows: { start: number; end: number }[] = [];
	let start = 0;
	for (const m of text.matchAll(/\S+\s*/g)) {
		const at = m.index!, len = m[0].trimEnd().length;
		if (at > start && at - start + len > COLS) {
			rows.push({ start, end: at });
			start = at;
		}
	}
	rows.push({ start, end: text.length });
	return rows;
}

/** The x of offset `o` on the row starting at `start` of `text`: W is two characters wide. */
const xAt = (text: string, start: number, o: number) => {
	let x = 0;
	for (let i = start; i < o; i++) x += text[i] === "W" ? 2 * CW : CW;
	return x;
};

/** A stroke through the given points, its box computed. */
function strokeOf(id: string, pts: [number, number][]): InkStroke {
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** A loop around [x0, x1] x [y0, y1]. */
const loop = (id: string, x0: number, x1: number, y0: number, y1: number) =>
	strokeOf(id, [[x0, (y0 + y1) / 2], [(x0 + x1) / 2, y0], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y1], [x0 + 2, (y0 + y1) / 2]]);

function rig(path: string, strokes: InkStroke[], opts: { lines?: string[]; tall?: number[]; widget?: number[]; big?: number[]; bigFh?: number; widgetH?: number; follow?: boolean } = {}) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	rec.attachments = undefined as unknown as typeof rec.attachments;
	rec.strokes = strokes;
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const state = { doc: Text.of(opts.lines ?? LINES) };
	const rowsAt = (n: number) => rowsOf(state.doc.line(n).text);
	const whole = (n: number) => !!opts.tall?.includes(n) || !!opts.widget?.includes(n);
	const wholeH = (n: number) => opts.widget?.includes(n) && opts.widgetH ? opts.widgetH : TALL;
	const bigFh = (opts.bigFh ?? BIG_FH / LH) * LH;
	const heightOf = (n: number) => whole(n) ? wholeH(n) : opts.big?.includes(n) ? BIG : rowsAt(n).length * LH;
	const topOf = (n: number) => {
		let top = 0;
		for (let i = 1; i < n; i++) top += heightOf(i);
		return top;
	};
	const blockOf = (n: number) => {
		const line = state.doc.line(n), top = topOf(n), type = opts.widget?.includes(n) ? BlockType.WidgetRange : BlockType.Text;
		return { from: line.from, to: line.to, top, bottom: top + heightOf(n), height: heightOf(n), type };
	};
	const layout = (): LineLayout => ({ lines: state.doc.lines, lineText: (n) => state.doc.line(n).text, lineTop: (n) => topOf(n), pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, state.doc.lines);
	anchors.drawn(1, state.doc.lines, true, true);
	const selection = new SelectionModel();
	const sent: unknown[] = [];
	const noop = () => {};
	const view = {
		scaleY: 1,
		defaultLineHeight: LH,
		state,
		get viewport() { return { from: 0, to: state.doc.length }; },
		lineBlockAt: (pos: number) => blockOf(state.doc.lineAt(pos).number),
		lineBlockAtHeight: (h: number) => {
			for (let n = 1; n <= state.doc.lines; n++) if (h < blockOf(n).bottom || n === state.doc.lines) return blockOf(n);
			return blockOf(1);
		},
		coordsAtPos: (pos: number, side: -1 | 1 = 1) => {
			const line = state.doc.lineAt(pos), o = pos - line.from, rows = rowsAt(line.number);
			if (whole(line.number)) {
				const left = xAt(line.text, 0, o), top = topOf(line.number);
				return { left, right: left, top, bottom: top + wholeH(line.number) };
			}
			if (opts.big?.includes(line.number)) {
				const left = xAt(line.text, 0, o), top = topOf(line.number) + (BIG - bigFh) / 2;
				return { left, right: left, top, bottom: top + bigFh };
			}
			let r = 0;
			if (side < 0) while (r < rows.length - 1 && o > rows[r]!.end) r++;
			else while (r < rows.length - 1 && o >= rows[r + 1]!.start) r++;
			const left = xAt(line.text, rows[r]!.start, o), top = topOf(line.number) + r * LH + (LH - FH) / 2;
			return { left, right: left, top, bottom: top + FH };
		},
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
		dispatch: (spec: unknown) => sent.push(spec),
		hasFocus: true,
		focus: noop,
		dom: { isConnected: true, ownerDocument: { defaultView: { requestAnimationFrame: () => 1, cancelAnimationFrame: noop } } },
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors,
		view,
		container: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 900, width: 900, height: 900 }) },
		inkInputPanX: () => 0,
		inkInputPanY: () => 0,
		pinchScaleNow: 1,
		pinchRefScale: null,
		pinchPreview: false,
		cssScale: 1,
		scale: 1,
		fontZoom: 1,
		camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) },
		filePath: () => path,
		strokesHere: () => anchors.strokesFor(path, inlineInk.strokes(path)),
		endLiveGestureForHistory: noop,
		scheduleRepaint: noop,
		repaintPath: noop,
		redrawSelectionUI: noop,
		lineAnchorsMoved: noop,
		followMoved: noop,
		currentIndexes: () => [],
		frontierCache: { invalidate: noop },
		spaceSnapshot: null,
		selection,
		lineAnchorPassTimer: 0,
		lineDrawnAt: 0,
		frame: { end: noop, begin: noop, locked: false },
		damage: { addRect: noop },
		refreshStrip: noop,
	});
	// With the follow live (opts.follow), a text change runs as the editor runs it: the line anchors hear it, then the follow;
	// the changed lines are drawn; then one measure cycle, CodeMirror's, with its requests queued one per key and every read
	// made before any write (the line window's write, asked first, before the follow's); then the measure loop's update marks
	// the lines it read. The follow's write is its own: the read stamps the record's kept move. The old-ink pass is run by the
	// cell (quiet), never by a timer.
	const queue: { key?: unknown; read: () => unknown; write: (m: unknown) => void }[] = [];
	if (opts.follow) {
		Object.assign(view, { requestMeasure: (req: (typeof queue)[number]) => { if (!queue.some((q) => q.key === req.key)) queue.push(req); } });
		Object.assign(overlay, {
			followMoved: InkOverlayPlugin.prototype.followMoved,
			armLineAnchorPass: noop,
			lineWindowMeasure: { key: {}, read: () => null, write: () => overlay.lineWindowMeasured() },
		});
	}
	const cycle = () => {
		const now = queue.splice(0), reads = now.map((q) => q.read());
		now.forEach((q, i) => q.write(reads[i]));
	};
	const edit = (from: number, to: number, insert: string) => {
		const changes = ChangeSet.of([{ from, to, insert }], state.doc.length);
		const startState = { doc: state.doc };
		state.doc = changes.apply(state.doc);
		const u = { changes, startState, state: { doc: state.doc }, docChanged: true } as unknown as ViewUpdate;
		if (!opts.follow) {
			overlay.followDocChanged(path, u);
			overlay.requestFollowMeasure();
			return;
		}
		const src = inlineInk.strokes(path);
		if (anchors.tracks(path, src)) {
			anchors.docChanged(path, src, startState.doc, changes, state.doc);
			if (anchors.windowOpen) view.requestMeasure(overlay.lineWindowMeasure);
		}
		overlay.followDocChanged(path, u);
		overlay.requestFollowMeasure();
		const changed = anchors.changedLines, first = Math.max(1, changed.from), last = Math.min(state.doc.lines, changed.to);
		if (first <= last) anchors.drawn(first, last, false);
		cycle();
		anchors.drawn(1, state.doc.lines, true, true);
	};
	/** The editor quiet: every line drawn and measured, then the old-ink pass. */
	const quiet = () => {
		anchors.drawn(1, state.doc.lines);
		anchors.drawn(1, state.doc.lines, true, true);
		return anchors.anchorMeasured(path, inlineInk.strokes(path));
	};
	/** Reading view and print of the note's text, each line one block laid out as the editor lays it out. */
	const spans = (): LineSpans => {
		const lines = state.doc.toString().split("\n");
		return {
			lines,
			skip: [],
			blocks: lines.map((_, i) => ({ lineStart: i, lineEnd: i, box: () => ({ top: topOf(i + 1), height: heightOf(i + 1) }), lineHeight: () => LH })),
		};
	};
	/** Where Reading view draws stroke `id`: its move from the stored place. It folds the editor's anchors first, as EmbedInk's render does. */
	const reading = (id: string) => {
		settleLineAnchors();
		const list = inlineInk.strokes(path), s = list.find((x) => x.id === id)!;
		const v = shownStrokes(list, spans(), 1, null, inlineInk.attachments(path)).find((x) => x.id === id)!;
		return { dx: v.bbox.x - s.bbox.x, dy: v.bbox.y - s.bbox.y };
	};
	const attach = async (ids: string[]) => {
		selection.selectExactly(ids);
		expect(overlay.attachSelected(), "Attach is offered").toBe(true);
		cycle();
		await Promise.resolve();
		cycle();
		const list = inlineInk.attachments(path);
		expect(list, "Attach made one record").toHaveLength(1);
		return list[0] as AttachmentRecord;
	};
	const tryAttach = (ids: string[]) => {
		selection.selectExactly(ids);
		return overlay.attachSelected();
	};
	const offset = (id: string) => anchors.follow.groupOffset(id);
	const text = () => state.doc.toString();
	return { overlay, anchors, attach, tryAttach, edit, offset, text, sent, quiet, reading };
}

/** World x of column `c`. */
const X = (c: number) => c * CW;
const L1 = LINES[0]!, FOX = L1.indexOf("fox");

describe("a circle around a mid-line word targets that word", () => {
	it("the record targets the circled word as a range", async () => {
		const { attach } = rig("range-pick.md", [loop("c", X(FOX) - 4, X(FOX + 3) + 4, 4, 36)]);
		const r = await attach(["c"]);
		expect([r.target.kind, r.target.text, r.target.from, r.target.to]).toEqual(["range", "fox", FOX, FOX + 3]);
	});

	it("typing in front of the word moves the circle right by the width of the insert", async () => {
		const { attach, edit, offset } = rig("range-type.md", [loop("c", X(FOX) - 4, X(FOX + 3) + 4, 4, 36)]);
		const r = await attach(["c"]);
		expect(offset(r.id), "premise: no correction at Attach").toEqual({ dx: 0, dy: 0 });
		// Typed inside the line, after its first word: a paragraph target's start does not move, the word does.
		edit(L1.indexOf("quick"), L1.indexOf("quick"), "big ");
		expect(offset(r.id), "the circle slides with its word").toEqual({ dx: 4 * CW, dy: 0 });
	});

	it("a same-length replace in front of the word moves the circle by the new width", async () => {
		const { attach, edit, offset } = rig("range-same.md", [loop("c", X(FOX) - 4, X(FOX + 3) + 4, 4, 36)]);
		const r = await attach(["c"]);
		const Q = L1.indexOf("quick");
		edit(Q, Q + 5, "qWick");
		expect((inlineInk.attachments("range-same.md")[0] as AttachmentRecord).target.from, "premise: the word's start does not move").toBe(FOX);
		expect(offset(r.id), "the circle slides by the wider letter").toEqual({ dx: CW, dy: 0 });
	});

	it("a same-length replace from the end of the line above into the word's line moves the circle by the new width", async () => {
		const lines = ["a second plain line", L1];
		const { attach, edit, offset } = rig("range-same-across.md", [loop("c", X(FOX) - 4, X(FOX + 3) + 4, LH + 4, LH + 36)], { lines });
		const r = await attach(["c"]);
		expect([r.target.kind, r.target.text], "premise: the word on line 2").toEqual(["range", "fox"]);
		const end = lines[0]!.length;
		// "e\nt" becomes "e\nW": starts on the line above, ends on the word's line in front of the word.
		edit(end - 1, end + 2, "e\nW");
		expect((inlineInk.attachments("range-same-across.md")[0] as AttachmentRecord).target.from, "premise: the word's start does not move").toBe(end + 1 + FOX);
		expect(offset(r.id), "the circle slides by the wider letter").toEqual({ dx: CW, dy: 0 });
	});

	it("a wrap of the word to the next row moves the circle there", async () => {
		const { attach, edit, offset, text } = rig("range-wrap.md", [loop("c", X(FOX) - 4, X(FOX + 3) + 4, 4, 36)]);
		const r = await attach(["c"]);
		edit(0, 0, "and then a big ");
		const now = text().split("\n")[0]!, rows = rowsOf(now), at = now.indexOf("fox");
		expect(rows.length, "premise: the line now wraps before the word").toBe(2);
		expect(at >= rows[1]!.start, "premise: the word is on the second row").toBe(true);
		expect(offset(r.id), "the circle goes with the word").toEqual({ dx: X(at - rows[1]!.start) - X(FOX), dy: LH });
	});

	it("deleting the word leaves the group needing reattachment", async () => {
		const { anchors, attach, edit } = rig("range-delete.md", [loop("c", X(FOX) - 4, X(FOX + 3) + 4, 4, 36)]);
		const r = await attach(["c"]);
		expect(anchors.follow.followsText(r.id), "premise: follows").toBe(true);
		edit(FOX, FOX + 4, "");
		expect(anchors.follow.followsText(r.id), "the word is gone: Needs reattachment").toBe(false);
	});
});

describe("Reading view and PDF draw a moved group where the editor shows it", () => {
	const anchorOf = (path: string, id: string) => inlineInk.strokes(path).find((s) => s.id === id)!.lineAnchor;

	it("control: a wrap of the word to the next row: Reading view draws the circle on the second row", async () => {
		const { attach, edit, offset, quiet, reading, text } = rig("range-wrap-read.md", [loop("c", X(FOX) - 4, X(FOX + 3) + 4, 4, 36)], { follow: true });
		const r = await attach(["c"]);
		quiet();
		expect(anchorOf("range-wrap-read.md", "c"), "premise: the member is anchored").toBeDefined();
		expect(reading("c"), "premise: Reading view draws it where it was drawn").toEqual({ dx: 0, dy: 0 });
		edit(0, 0, "and then a big ");
		const now = text().split("\n")[0]!, rows = rowsOf(now), at = now.indexOf("fox");
		expect(at >= rows[1]!.start, "premise: the word is on the second row").toBe(true);
		const shown = { dx: X(at - rows[1]!.start) - X(FOX), dy: LH };
		expect(offset(r.id), "premise: the editor shows the circle on the second row").toEqual(shown);
		quiet();
		expect(reading("c"), "Reading view draws it where the editor shows it").toEqual(shown);
	});

	it("control: an unwrap of the word back to the first row: Reading view draws the circle on the first row", async () => {
		const lines = ["and then a big " + L1, ...LINES.slice(1)];
		const was = lines[0]!, wasRows = rowsOf(was), wasAt = was.indexOf("fox"), x0 = X(wasAt - wasRows[1]!.start);
		expect(wasAt >= wasRows[1]!.start, "premise: the word starts on the second row").toBe(true);
		const { attach, edit, offset, quiet, reading } = rig("range-unwrap-read.md", [loop("c", x0 - 4, x0 + X(3) + 4, LH + 4, LH + 36)], { lines, follow: true });
		const r = await attach(["c"]);
		expect([r.target.kind, r.target.text], "premise: the word").toEqual(["range", "fox"]);
		quiet();
		expect(anchorOf("range-unwrap-read.md", "c"), "premise: the member is anchored").toBeDefined();
		edit(0, "and then a big ".length, "");
		const shown = { dx: X(FOX) - x0, dy: -LH };
		expect(offset(r.id), "premise: the editor shows the circle on the first row").toEqual(shown);
		quiet();
		expect(reading("c"), "Reading view draws it where the editor shows it").toEqual(shown);
	});

	const paragraph = async (path: string) => {
		const t = rig(path, [loop("c", X(2) - 4, X(8) + 4, LH + 4, LH + 70)], { follow: true });
		const r = await t.attach(["c"]);
		expect([r.target.kind, r.target.text], "premise: the paragraph").toEqual(["paragraph", LINES[1]!]);
		t.quiet();
		expect(anchorOf(path, "c"), "premise: the member is anchored").toBeDefined();
		expect(t.reading("c"), "premise: Reading view draws it where it was drawn").toEqual({ dx: 0, dy: 0 });
		t.edit(0, 0, "a new first line\n");
		expect(t.offset(r.id), "premise: the editor shows it one line down").toEqual({ dx: 0, dy: LH });
		return t;
	};

	it("a paragraph group under a line typed above: once the editor is quiet, Reading view draws it one line down", async () => {
		const { quiet, reading } = await paragraph("range-para-read.md");
		quiet();
		expect(reading("c"), "Reading view draws it where the editor shows it").toEqual({ dx: 0, dy: LH });
	});

	it("a paragraph group under a line typed above: before the editor is quiet, Reading view draws it at its stored place", async () => {
		const { reading } = await paragraph("range-para-gap.md");
		expect(reading("c"), "no sideways move without its line's").toEqual({ dx: 0, dy: 0 });
	});

	it("control: free ink under a line typed above stays where it was drawn in Reading view", () => {
		const path = "range-free-read.md";
		const { anchors, edit, quiet, reading } = rig(path, [loop("c", X(2) - 4, X(8) + 4, LH + 4, LH + 36)], { follow: true });
		// The note mounted: the surface takes the path, then its lines are drawn and measured.
		anchors.tracks(path, inlineInk.strokes(path));
		quiet();
		expect(anchorOf(path, "c"), "premise: the stroke is anchored").toBeDefined();
		expect(inlineInk.attachments(path), "premise: it is attached to nothing").toHaveLength(0);
		edit(0, 0, "a new first line\n");
		expect(reading("c"), "before the editor is quiet").toEqual({ dx: 0, dy: 0 });
		quiet();
		expect(reading("c"), "once the editor is quiet").toEqual({ dx: 0, dy: 0 });
	});
});

describe("which words the box takes", () => {
	it("a circle wider than its word takes only that word, not the neighbours it clips", async () => {
		// Clips the last letter of "brown" and the first of "jumps": neither middle is inside.
		const { attach } = rig("range-wide.md", [loop("c", X(FOX) - 20, X(FOX + 3) + 20, 2, 38)]);
		const r = await attach(["c"]);
		expect([r.target.kind, r.target.text]).toEqual(["range", "fox"]);
	});

	it("an underline just below a word takes that word", async () => {
		const { attach } = rig("range-underline.md", [strokeOf("u", [[X(FOX), 35], [X(FOX + 1.5), 36], [X(FOX + 3), 35]])]);
		const r = await attach(["u"]);
		expect([r.target.kind, r.target.text]).toEqual(["range", "fox"]);
	});

	it("a loop taller than the letters, up to one and a half rows, takes the word", async () => {
		const c = loop("c", X(FOX) - 4, X(FOX + 3) + 4, -6, 46);
		expect(c.bbox.height > FH && c.bbox.height <= 1.5 * LH, "premise: taller than the letters, within 1.5 rows").toBe(true);
		const { attach } = rig("range-loop-tall.md", [c]);
		const r = await attach(["c"]);
		expect([r.target.kind, r.target.text]).toEqual(["range", "fox"]);
	});

	it("an underline a little below the last row of its line takes that word, not the one on the line below", async () => {
		// Centred under the row, within a quarter row of it: in the next line's block, over its word "line".
		const u = strokeOf("u", [[X(FOX), 47], [X(FOX + 1.5), 48], [X(FOX + 3), 47]]);
		const cy = u.bbox.y + u.bbox.height / 2;
		expect(cy > LH && cy <= LH + LH / 4, "premise: centred below the row, within a quarter row").toBe(true);
		const { attach } = rig("range-underline-low.md", [u]);
		const r = await attach(["u"]);
		expect([r.target.kind, r.target.text]).toEqual(["range", "fox"]);
	});

	it("a circle around two words takes both", async () => {
		const B = L1.indexOf("brown");
		const { attach } = rig("range-two.md", [loop("c", X(B) - 4, X(FOX + 3) + 4, 4, 36)]);
		const r = await attach(["c"]);
		expect([r.target.kind, r.target.text]).toEqual(["range", "brown fox"]);
	});

	it("control: a box taller than one row keeps the paragraph", async () => {
		const { attach } = rig("range-tall.md", [loop("c", X(FOX) - 4, X(FOX + 3) + 4, 4, 70)]);
		const r = await attach(["c"]);
		expect([r.target.kind, r.target.text]).toEqual(["paragraph", L1]);
	});

	it("control: a box 1.6 rows tall keeps the paragraph", async () => {
		const c = loop("c", X(FOX) - 4, X(FOX + 3) + 4, -2, 58);
		expect(c.bbox.height, "premise: 1.6 rows").toBe(1.6 * LH);
		const { attach } = rig("range-tall-16.md", [c]);
		const r = await attach(["c"]);
		expect([r.target.kind, r.target.text]).toEqual(["paragraph", L1]);
	});

	it("control: a box over no word's middle keeps the paragraph", async () => {
		const { attach } = rig("range-none.md", [loop("c", X(L1.length) + 20, X(L1.length) + 60, 4, 36)]);
		const r = await attach(["c"]);
		expect([r.target.kind, r.target.text]).toEqual(["paragraph", L1]);
	});
});

describe("a widget on the line above never wins the row", () => {
	it("a circle around a word on the first row under a tall embed takes the word", async () => {
		// The embed line's places are the widget's whole rect: TALL high, so its band would reach well below it.
		const lines = ["![[pic.png]] tall embed", L1];
		const c = loop("c", X(FOX) - 4, X(FOX + 3) + 4, TALL + 4, TALL + 36);
		const { attach } = rig("range-under-embed.md", [c], { lines, tall: [1] });
		const r = await attach(["c"]);
		expect([r.target.kind, r.target.text]).toEqual(["range", "fox"]);
	});

	it("a circle around a heading word, its letters 1.6 lines tall, on its own line, takes the word", async () => {
		// A heading's letters in a wide UI font can be taller than 1.5 line heights: only the line above skips such places.
		const lines = ["# Big heading", L1], B = lines[0]!.indexOf("Big");
		const c = loop("c", X(B) - 4, X(B + 3) + 4, 4, BIG - 4);
		expect(BIG_FH > 1.5 * LH && c.bbox.height <= 1.5 * BIG_FH, "premise: letters over 1.5 lines, the circle within 1.5 of them").toBe(true);
		const { attach } = rig("range-heading.md", [c], { lines, big: [1] });
		const r = await attach(["c"]);
		expect([r.target.kind, r.target.text]).toEqual(["range", "Big"]);
	});

	it("an underline under a heading word, a text line straight under the heading, takes the word", async () => {
		// The heading's letters overflow its line block, so an underline under them centres in the next line's block,
		// with the heading as the line above.
		const lines = ["# Big heading", L1], B = lines[0]!.indexOf("Big");
		const u = strokeOf("u", [[X(B), 84], [X(B + 1.5), 86], [X(B + 3), 84]]);
		const cy = u.bbox.y + u.bbox.height / 2;
		expect(cy > BIG && cy - (BIG + BIG_FH) / 2 <= BIG / 4 + 8, "premise: in the next line's block, within the band's quarter-row slack").toBe(true);
		const { attach } = rig("range-heading-underline.md", [u], { lines, big: [1] });
		const r = await attach(["u"]);
		expect([r.target.kind, r.target.text]).toEqual(["range", "Big"]);
	});

	it("the same underline under heading letters 2.2 lines tall takes the word", async () => {
		const lines = ["# Big heading", L1], B = lines[0]!.indexOf("Big");
		const u = strokeOf("u", [[X(B), 84], [X(B + 1.5), 86], [X(B + 3), 84]]);
		const cy = u.bbox.y + u.bbox.height / 2;
		expect(cy > BIG, "premise: in the next line's block").toBe(true);
		const { attach } = rig("range-heading-underline-22.md", [u], { lines, big: [1], bigFh: 2.2 });
		const r = await attach(["u"]);
		expect([r.target.kind, r.target.text]).toEqual(["range", "Big"]);
	});

	it("a widget block above, its rect 2 lines tall, is not read: a circle on the first row under it takes the word", async () => {
		// Properties measured whole, short enough that the height alone would not skip it; its first word sits over "the".
		const lines = ["tags: one two", L1];
		const c = loop("c", X(0) - 4, X(3) + 4, 2 * LH + 4, 2 * LH + 24);
		const { attach } = rig("range-under-props-2.md", [c], { lines, widget: [1], widgetH: 2 * LH });
		const r = await attach(["c"]);
		expect([r.target.kind, r.target.text]).toEqual(["range", "the"]);
	});

	it("control: the same underline centred inside the heading's block takes the word", async () => {
		const lines = ["# Big heading", L1], B = lines[0]!.indexOf("Big");
		const u = strokeOf("u", [[X(B), 74], [X(B + 1.5), 76], [X(B + 3), 74]]);
		const { attach } = rig("range-heading-underline-in.md", [u], { lines, big: [1] });
		const r = await attach(["u"]);
		expect([r.target.kind, r.target.text]).toEqual(["range", "Big"]);
	});

	it("control: with no line above, the same circle takes the word", async () => {
		const { attach } = rig("range-under-embed-none.md", [loop("c", X(FOX) - 4, X(FOX + 3) + 4, 4, 36)]);
		const r = await attach(["c"]);
		expect([r.target.kind, r.target.text]).toEqual(["range", "fox"]);
	});
});

describe("an underline on the blank line under a paragraph", () => {
	/** An underline under "fox", centred `dy` below the top `y`. */
	const under = (id: string, y: number, x0 = X(FOX), x1 = X(FOX + 3)) => strokeOf(id, [[x0, y], [(x0 + x1) / 2, y], [x1, y]]);
	const centre = (s: InkStroke) => s.bbox.y + s.bbox.height / 2;

	it("an underline centred an eighth of a line below a one-line paragraph, a blank line under it, takes the word", async () => {
		const u = under("u", LH + LH / 8);
		expect(centre(u), "premise: centred L/8 below the line, in the blank line").toBe(LH + LH / 8);
		const { attach } = rig("blank-under.md", [u], { lines: [L1, "", "third line here"] });
		const r = await attach(["u"]);
		expect([r.target.kind, r.target.text]).toEqual(["range", "fox"]);
	});

	it("an underline centred an eighth of a line below the note's last line takes the word", async () => {
		const u = under("u", 2 * LH + LH / 8);
		const { attach } = rig("blank-under-last.md", [u], { lines: ["a second plain line", L1] });
		const r = await attach(["u"]);
		expect([r.target.kind, r.target.text]).toEqual(["range", "fox"]);
	});

	it("control: a quarter line and 2 px below gives no text", async () => {
		const { tryAttach } = rig("blank-under-low.md", [under("u", LH + LH / 4 + 2)], { lines: [L1, "", "third line here"] });
		expect(tryAttach(["u"])).toBe(false);
	});

	it("control: below the note's last line, a quarter line and 2 px below gives no text", async () => {
		const { tryAttach } = rig("blank-under-last-low.md", [under("u", 2 * LH + LH / 4 + 2)], { lines: ["a second plain line", L1] });
		expect(tryAttach(["u"])).toBe(false);
	});

	it("control: under no word's middle gives the paragraph", async () => {
		const u = under("u", LH + LH / 8, X(L1.length) + 20, X(L1.length) + 60);
		const { attach } = rig("blank-under-none.md", [u], { lines: [L1, "", "third line here"] });
		const r = await attach(["u"]);
		expect([r.target.kind, r.target.text]).toEqual(["paragraph", L1]);
	});

	it("control: under Properties, a widget block, gives no text", async () => {
		const { tryAttach } = rig("blank-under-props.md", [under("u", TALL + LH / 8, X(0), X(4))], { lines: ["tags: one two", "", L1], widget: [1] });
		expect(tryAttach(["u"])).toBe(false);
	});
});

describe("how the user sees the target", () => {
	it("selecting the group marks exactly the target words", async () => {
		const { overlay, attach, sent } = rig("range-mark.md", [loop("c", X(FOX) - 4, X(FOX + 3) + 4, 4, 36)]);
		await attach(["c"]);
		const { attachChromeOf } = await import("./AttachDecoration");
		sent.length = 0;
		attachChromeOf(overlay as never, inlineInk.attachments("range-mark.md"), inlineInk.strokes("range-mark.md"), 1);
		await Promise.resolve();
		const marks = sent.flatMap((s) => [(s as { effects?: unknown }).effects ?? []].flat())
			.filter((e) => (e as { is(t: unknown): boolean }).is(setAttachTarget)).map((e) => (e as { value: unknown }).value);
		expect(marks.at(-1)).toEqual({ from: FOX, to: FOX + 3 });
	});

	it("selecting a paragraph group marks its whole paragraph, every wrapped row of it", async () => {
		const long = "the quick brown fox jumps over the lazy dog by the river bank";
		const path = "range-mark-para.md", lines = [long, "a second plain line", "third line here"];
		const { overlay, attach, sent } = rig(path, [loop("p", X(FOX) - 4, X(FOX + 3) + 4, 4, 70)], { lines });
		expect(rowsOf(long).length, "premise: the paragraph wraps").toBeGreaterThan(1);
		const r = await attach(["p"]);
		expect([r.target.kind, r.target.from, r.target.to], "premise: a paragraph group on the whole first line").toEqual(["paragraph", 0, long.length]);
		const { attachChromeOf } = await import("./AttachDecoration");
		sent.length = 0;
		attachChromeOf(overlay as never, inlineInk.attachments(path), inlineInk.strokes(path), 1);
		await Promise.resolve();
		const marks = sent.flatMap((s) => [(s as { effects?: unknown }).effects ?? []].flat())
			.filter((e) => (e as { is(t: unknown): boolean }).is(setAttachTarget)).map((e) => (e as { value: unknown }).value);
		expect(marks.at(-1)).toEqual({ from: 0, to: long.length });
	});

	it("the label reads Attached on a word group and on a paragraph group", async () => {
		const word = rig("range-label-word.md", [loop("c", X(FOX) - 4, X(FOX + 3) + 4, 4, 36)]);
		const w = await word.attach(["c"]);
		const para = rig("range-label-para.md", [loop("p", X(FOX) - 4, X(FOX + 3) + 4, 4, 70)]);
		const p = await para.attach(["p"]);
		expect([w.target.kind, p.target.kind], "premise: one word group, one paragraph group").toEqual(["range", "paragraph"]);
		const label = (r: ReturnType<typeof rig>, rec: AttachmentRecord, path: string) => {
			const follow = r.anchors.follow;
			const boxes = groupBoxes([rec], r.anchors.freeFor(path, inlineInk.strokes(path)).members, (id) => follow.groupOffset(id), (id) => follow.followsText(id), () => undefined);
			return attachChrome(boxes, [rec.id]).labels.map((l) => l.text);
		};
		expect(label(word, w, "range-label-word.md"), "the word group's label").toEqual(["Attached"]);
		expect(label(para, p, "range-label-para.md"), "the paragraph group's label").toEqual(["Attached"]);
		expect(ATTACH_STRINGS.attached).toBe("Attached");
	});
});
