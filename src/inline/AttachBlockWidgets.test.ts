/**
 * Pin: Attach and the pin drop on a word inside a block widget other than a table (a callout, display math, a note
 * embed, a rendered code block, Properties) give today's result. Words inside those blocks are a later change; the table
 * fix must leave them exactly as they are.
 *
 * Today (1.5.0 to 1.5.2), as the attach sweep read it: a box centred inside such a block takes that block as its line;
 * every place in it is the widget's whole rect, flattened to its left edge at its first position and its right edge
 * everywhere else (a block widget with no coordsAt of its own, @codemirror/view 6.38.6 BlockWidgetView.coordsAt). So a
 * box over a word away from the widget's middle takes the whole block's source as a paragraph; a box over the widget's
 * middle takes its first token (">", "$$", the embed link, the code fence, "---") as a word. The pin drop there refuses.
 *
 * A bare overlay over a fake view, as AttachTable.test.ts builds it: every character CW world px wide, text rows LH high,
 * each block widget one block WH high over its source lines.
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
import type { AttachmentRecord } from "./InkAttachments";

const CW = 14, LH = 40, FH = 26, COLS = 60, WH = 120, W = 600;
const SIG = { width: COLS * CW, fontPx: 26, charWidth: CW };

/** A loop around [x0, x1] x [y0, y1]. */
function loop(id: string, x0: number, x1: number, y0: number, y1: number): InkStroke {
	const pts: [number, number][] = [[x0, (y0 + y1) / 2], [(x0 + x1) / 2, y0], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y1], [x0 + 2, (y0 + y1) / 2]];
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** `lines`, with lines `a` to `b` (1-based) drawn as one block widget WH high. */
function rig(path: string, lines: string[], a: number, b: number) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	rec.attachments = undefined as unknown as typeof rec.attachments;
	rec.strokes = [];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const state = { doc: Text.of(lines) };
	const inW = (n: number) => n >= a && n <= b;
	const heightOf = (n: number) => (inW(n) ? (n === a ? WH : 0) : LH);
	const topOf = (n: number) => {
		let top = 0;
		for (let i = 1; i < n; i++) top += heightOf(i);
		return top;
	};
	const wFrom = () => state.doc.line(a).from, wTo = () => state.doc.line(b).to;
	const blockOf = (n: number) => {
		if (inW(n)) return { from: wFrom(), to: wTo(), top: topOf(a), bottom: topOf(a) + WH, height: WH, type: BlockType.WidgetRange };
		const line = state.doc.line(n), top = topOf(n);
		return { from: line.from, to: line.to, top, bottom: top + LH, height: LH, type: BlockType.Text };
	};
	const blocks = () => {
		const out: ReturnType<typeof blockOf>[] = [];
		for (let n = 1; n <= state.doc.lines; n++) {
			const bl = blockOf(n);
			if (!out.length || out[out.length - 1]!.from !== bl.from) out.push(bl);
		}
		return out;
	};
	const layout = (): LineLayout => ({
		lines: state.doc.lines, lineText: (n) => state.doc.line(n).text, lineTop: (n) => (inW(n) ? topOf(a) : topOf(n)), pxPerWorld: 1,
	});
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
		get viewport() { return { from: 0, to: state.doc.length }; },
		lineBlockAt: (pos: number) => blockOf(state.doc.lineAt(pos).number),
		lineBlockAtHeight: (h: number) => {
			const all = blocks();
			for (const bl of all) if (h < bl.bottom) return bl;
			return all[all.length - 1]!;
		},
		coordsAtPos: (pos: number) => {
			if (pos >= wFrom() && pos <= wTo()) {
				const top = topOf(a), x = pos === wFrom() ? 0 : W;
				return { left: x, right: x, top, bottom: top + WH };
			}
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
	const attach = async (s: InkStroke) => {
		inlineInk.record(path).strokes = [s];
		selection.selectExactly([s.id]);
		expect(overlay.attachSelected(), "Attach is offered").toBe(true);
		await Promise.resolve();
		const list = inlineInk.attachments(path);
		expect(list, "Attach made one record").toHaveLength(1);
		return list[0] as AttachmentRecord;
	};
	/** The block's middle row, world y. */
	const mid = () => topOf(a) + WH / 2;
	return { attach, overlay, mid, from: wFrom, to: wTo };
}

const KINDS: { kind: string; lines: string[]; a: number; b: number; first: string }[] = [
	{ kind: "callout", lines: ["Text above here", "", "> [!note] Title", "> body words in the callout", "", "Text below here"], a: 3, b: 4, first: ">" },
	{ kind: "display math", lines: ["Text above here", "", "$$", "x = y + z", "$$", "", "Text below here"], a: 3, b: 5, first: "$$" },
	{ kind: "note embed", lines: ["Text above here", "", "![[Other]]", "", "Text below here"], a: 3, b: 3, first: "![[Other]]" },
	{ kind: "rendered code block", lines: ["Text above here", "", "```mermaid", "graph TD", "A --> B", "```", "", "Text below here"], a: 3, b: 6, first: "```mermaid" },
	{ kind: "Properties", lines: ["---", "tags: one two", "---", "", "Text below here"], a: 1, b: 3, first: "---" },
	// Table-shaped lines inside another block: still that block, never a table (a table is told by its widget, not by "|").
	{ kind: "callout holding a table", lines: ["Text above here", "", "> [!note] Title", "> | a | b |", "> | --- | --- |", "> | one | two |", "", "Text below here"], a: 3, b: 6, first: ">" },
	{ kind: "mermaid block with lines starting with a pipe", lines: ["Text above here", "", "```mermaid", "graph TD", "| A | B |", "|---|---|", "```", "", "Text below here"], a: 3, b: 7, first: "```mermaid" },
];

describe("pin: Attach and the pin drop inside a block widget other than a table give today's result", () => {
	for (const k of KINDS) {
		it(`${k.kind}: a box over a word away from the widget's middle takes the whole block as a paragraph`, async () => {
			const t = rig(`pin-block-${k.kind}-word.md`, k.lines, k.a, k.b);
			const r = await t.attach(loop("c", 40, 100, t.mid() - 14, t.mid() + 14));
			expect([r.target.kind, r.target.from, r.target.to]).toEqual(["paragraph", t.from(), t.to()]);
		});

		it(`${k.kind}: a box over the widget's middle takes its first token as a word`, async () => {
			const t = rig(`pin-block-${k.kind}-middle.md`, k.lines, k.a, k.b);
			const r = await t.attach(loop("c", W / 2 - 30, W / 2 + 30, t.mid() - 14, t.mid() + 14));
			expect([r.target.kind, r.target.text]).toEqual(["range", k.first]);
		});

		it(`${k.kind}: the pin drop on a word inside it refuses and keeps the group's target`, async () => {
			const t = rig(`pin-block-${k.kind}-drop.md`, k.lines, k.a, k.b);
			const r = await t.attach(loop("c", 40, 100, t.mid() - 14, t.mid() + 14));
			expect(t.overlay.dropAttachPin(r.id, { x: 60, y: t.mid() }), "the drop refuses").toBe(false);
			expect((inlineInk.attachments(`pin-block-${k.kind}-drop.md`)[0] as AttachmentRecord).target).toEqual(r.target);
		});
	}
});
