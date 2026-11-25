/**
 * Export ink as SVG and Export ink as PDF, with a pane on the note, take every stroke where that pane shows it, so
 * the file matches the screen. The pane shows a loose stroke at its page position plus its line's
 * correction (LineAnchor.ts), and an attached group's members at the group's correction. A layout change with no
 * document change (here the lines above measured again, the signature kept) moves both. The export took the group's
 * move and left loose ink where it was drawn, so one file held two frames.
 *
 * A group this pane has not read yet keeps its rule: the export takes it at the correction its record kept.
 *
 * A bare overlay over a fake view, as AttachRangeTarget.test.ts builds it: every character CW world px wide, rows LH
 * high, one row per line, coordsAtPos giving a character's letters FH high, centred on its row. `grow` makes a line
 * taller with no document change, as a measure that reads it taller than the editor's guess does.
 *
 * Each cell names the defect that must turn it red.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { BlockType } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { SelectionModel } from "../objects/SelectionModel";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";

const CW = 14, LH = 40, FH = 26, COLS = 30;
const SIG = { width: COLS * CW, fontPx: 26, charWidth: CW };
const LINES = ["the quick brown fox jumps", "a second plain line", "third line here", "fourth line here"];

/** A stroke through the given points, its box computed. */
function strokeOf(id: string, pts: [number, number][]): InkStroke {
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** A loop around [x0, x1] x [y0, y1]. */
const loop = (id: string, x0: number, x1: number, y0: number, y1: number) =>
	strokeOf(id, [[x0, (y0 + y1) / 2], [(x0 + x1) / 2, y0], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y1], [x0 + 2, (y0 + y1) / 2]]);

/** A short loose mark, its box top `y` - 2 (the box's pad). */
const mark = (id: string, x: number, y: number) => strokeOf(id, [[x, y], [x + 20, y + 10], [x + 40, y + 4]]);

/** `viewTo`: the last line in the editor's viewport (all by default); a group below it is not read by this pane's measure. */
function rig(path: string, strokes: InkStroke[], attachments: AttachmentData[] = [], viewTo?: number) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments };
	rec.attachments = undefined as unknown as typeof rec.attachments;
	rec.strokes = strokes;
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const state = { doc: Text.of(LINES) };
	/** Extra height on a line, editor px: the measure read it taller than one row, with no document change. */
	const extra = new Map<number, number>();
	const heightOf = (n: number) => LH + (extra.get(n) ?? 0);
	const topOf = (n: number) => {
		let top = 0;
		for (let i = 1; i < n; i++) top += heightOf(i);
		return top;
	};
	const blockOf = (n: number) => {
		const line = state.doc.line(n), top = topOf(n);
		return { from: line.from, to: line.to, top, bottom: top + heightOf(n), height: heightOf(n), type: BlockType.Text };
	};
	const layout = (): LineLayout => ({ lines: state.doc.lines, lineText: (n) => state.doc.line(n).text, lineTop: (n) => topOf(n), pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, state.doc.lines);
	anchors.drawn(1, state.doc.lines, true, true);
	const selection = new SelectionModel();
	const noop = () => {};
	const view = {
		scaleY: 1,
		defaultLineHeight: LH,
		state,
		get viewport() { return { from: 0, to: viewTo ? state.doc.line(viewTo).to : state.doc.length }; },
		lineBlockAt: (pos: number) => blockOf(state.doc.lineAt(pos).number),
		lineBlockAtHeight: (h: number) => {
			for (let n = 1; n <= state.doc.lines; n++) if (h < blockOf(n).bottom || n === state.doc.lines) return blockOf(n);
			return blockOf(1);
		},
		coordsAtPos: (pos: number) => {
			const line = state.doc.lineAt(pos), left = (pos - line.from) * CW, top = topOf(line.number) + (LH - FH) / 2;
			return { left, right: left, top, bottom: top + FH };
		},
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
		dispatch: noop,
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
	/** Every stroke anchored to the line under it now, as a stroke committed in this layout is. */
	const anchorAll = () => {
		for (const s of inlineInk.strokes(path)) anchors.anchorNew(path, s);
	};
	const attach = async (ids: string[]) => {
		selection.selectExactly(ids);
		expect(overlay.attachSelected(), "Attach is offered").toBe(true);
		await Promise.resolve();
		const list = inlineInk.attachments(path);
		expect(list, "Attach made one record").toHaveLength(1);
		return list[0] as AttachmentRecord;
	};
	/** Line `n` measured `px` taller, no document change: every correction read again, then the follow's measure. */
	const grow = (n: number, px: number) => {
		extra.set(n, (extra.get(n) ?? 0) + px);
		anchors.layoutChanged(path, inlineInk.strokes(path), "measure");
		anchors.follow.layoutChanged();
		overlay.requestFollowMeasure();
	};
	/** Each stroke's box top: as this pane shows it (noteStrokes) and as the drawing export takes it (exportStrokes). */
	const tops = () => {
		const at = (list: readonly InkStroke[]) => new Map(list.map((s) => [s.id, s.bbox.y]));
		return { shown: at(overlay.noteStrokes(path)), exported: at(overlay.exportStrokes(path)) };
	};
	const stored = (id: string) => inlineInk.strokes(path).find((s) => s.id === id)!.bbox.y;
	/** The correction this pane's line anchors give stroke `id` now (lineAnchorDy): 0 when no layout was read. */
	const dy = (id: string) => overlay.lineAnchorDy(inlineInk.strokes(path).find((s) => s.id === id)!);
	/** The stroke ids in the store's order and in the export's. */
	const ids = () => ({ store: inlineInk.strokes(path).map((s) => s.id), exported: overlay.exportStrokes(path).map((s) => s.id) });
	return { overlay, anchors, anchorAll, attach, grow, tops, stored, dy, ids, topOf, doc: () => state.doc.toString() };
}

/** World x of column `c`. */
const X = (c: number) => c * CW;
/** "line" on line 3 ("third line here", from column 6), circled inside its row (80 to 120). */
const L3 = LINES[2]!.indexOf("line");
const circleL3 = () => loop("g", X(L3) - 4, X(L3 + 4) + 4, 84, 116);

describe("the drawing export takes every stroke where this pane shows it", () => {
	it("E1: lines above measured taller, no text change: each loose stroke is exported where the pane shows it, beside an attached group", async () => {
		// Defect: exportStrokes passes a stroke in no group through as stored (AttachFollow.exported :439), so a loose
		// stroke is written where it was drawn while the pane shows it moved with its line.
		const t = rig("export-e1.md", [mark("top", 300, 10), circleL3(), mark("f", 250, 130)]);
		t.anchorAll();
		const r = await t.attach(["g"]);
		expect(r.strokeIds, "premise: the group is the circle alone").toEqual(["g"]);
		const before = t.tops();
		for (const id of ["top", "g", "f"]) expect(before.exported.get(id), `premise: ${id} exported where shown before any change`).toBe(before.shown.get(id));
		// Line 1 measured 40 taller (lines 2 on move 40), line 3 measured 24 taller (line 4 moves 64): mixed moves.
		t.grow(1, 40);
		t.grow(3, 24);
		const { shown, exported } = t.tops();
		expect(t.dy("f"), "premise: a layout was read, the line 4 stroke's correction is 64 (over one line)").toBeCloseTo(64, 6);
		expect(shown.get("g")! - t.stored("g"), "premise: the pane shows the group moved with its word").toBeCloseTo(40, 6);
		expect(shown.get("f")! - t.stored("f"), "premise: the pane shows the loose stroke on line 4 moved with its line").toBeCloseTo(64, 6);
		expect(shown.get("top")! - t.stored("top"), "premise: the loose stroke on line 1 does not move").toBeCloseTo(0, 6);
		expect(exported.get("g"), "the group's member is exported where the pane shows it (as base)").toBeCloseTo(shown.get("g")!, 6);
		expect(exported.get("top"), "the unmoved loose stroke is exported where the pane shows it").toBeCloseTo(shown.get("top")!, 6);
		expect(exported.get("f"), "the moved loose stroke is exported where the pane shows it, not where it was drawn").toBeCloseTo(shown.get("f")!, 6);
	});

	it("E2: no group in the note: a loose stroke is exported where the pane shows it after the lines above are measured taller", () => {
		// Defect: with no group exportStrokes answers the store's own list (InkOverlayLineAnchors.ts :755), so loose ink
		// moved with its line is written where it was drawn.
		const t = rig("export-e2.md", [mark("top", 300, 10), mark("f", 250, 130)]);
		t.anchorAll();
		t.grow(1, 40);
		t.grow(3, 24);
		const { shown, exported } = t.tops();
		expect(t.dy("f"), "premise: a layout was read, the line 4 stroke's correction is 64 (over one line)").toBeCloseTo(64, 6);
		expect(shown.get("f")! - t.stored("f"), "premise: the pane shows the loose stroke on line 4 moved with its line").toBeCloseTo(64, 6);
		expect(shown.get("top")! - t.stored("top"), "premise: the loose stroke on line 1 does not move").toBeCloseTo(0, 6);
		expect(exported.get("top"), "the unmoved loose stroke is exported where the pane shows it").toBeCloseTo(shown.get("top")!, 6);
		expect(exported.get("f"), "the moved loose stroke is exported where the pane shows it, not where it was drawn").toBeCloseTo(shown.get("f")!, 6);
	});

	it("E3: a group this pane has not read yet is exported at the correction its record kept, and loose ink where the pane shows it", () => {
		// Defect: the export takes a pending group's member as stored, or as the pane's shown list (which leaves it out),
		// dropping the correction its record kept (AttachFollow.exported :441-442).
		const g = circleL3(), doc = LINES.join("\n"), from = doc.indexOf("line", doc.indexOf("third"));
		const kept: AttachmentRecord = {
			v: 1, id: "att-e3", strokeIds: ["g"], target: targetAt(doc, from, from + 4, "range"),
			ref: { x: X(L3), y: 80 }, layout: { width: SIG.width, font: SIG.fontPx }, probe: { id: "g", x: g.points[0]!.x, y: g.points[0]!.y },
			shown: { dx: 0, dy: 40 },
		};
		// The viewport ends at line 2: the group's word (line 3) is out of view, so this pane's measure does not read it.
		const t = rig("export-e3.md", [g, mark("f", 250, 130)], [kept], 2);
		t.anchorAll();
		t.grow(1, 40);
		const { shown, exported } = t.tops();
		expect(shown.has("g"), "premise: the pane has not read the group, so it does not paint it").toBe(false);
		expect(t.dy("f"), "premise: a layout was read, the loose stroke's correction is 40 (one line)").toBeCloseTo(40, 6);
		expect(shown.get("f")! - t.stored("f"), "premise: the pane shows the loose stroke moved with its line").toBeCloseTo(40, 6);
		// Defect: an export built from the pane's shown list leaves the pending member out, and its ink is lost.
		const order = t.ids();
		expect(order.exported, "every stored stroke is exported once, in store order, the pending member too").toEqual(order.store);
		expect(exported.get("g")! - t.stored("g"), "the pending group's member is exported at the correction its record kept").toBeCloseTo(40, 6);
		expect(exported.get("f"), "the loose stroke is exported where the pane shows it").toBeCloseTo(shown.get("f")!, 6);
	});
});
