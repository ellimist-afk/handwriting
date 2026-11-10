/**
 * Insert Space and ink attached to text (PREP section 6 item 7, A16): a group moves whole with its target's first line,
 * by the text change alone, or not at all. Its members are never moved in the store as well: the text change already
 * moves the group (followDocChanged), so a member in both would move twice. Free ink moves as before.
 *
 * Rig: InsertSpaceFailedEdit's body-line editor stand-in, the real spaceDown / spaceMove / spaceUp and store; its
 * dispatch runs the overlay's document-change hook as the editor update does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction, type ChangeSet, type Text, type TransactionSpec } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { serializePage, type PageData } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import { LineAnchors } from "./LineAnchor";
import { insertSpaceMembers, targetAt, type AttachmentRecord } from "./InkAttachments";
import { rowsOf, strokeIdsBelow } from "./InsertSpace";
import { inkEffect, invertInkOp, type InkOp } from "./InkHistory";
import { inkToSvg } from "../ink/SvgExport";
import { inkToPdf } from "../ink/InkPdf";
import { bytesOf } from "../pdf/PdfSyntax";
import { shiftedStroke } from "./LineAnchor";
import { installRegisterExportCommands } from "../commands/RegisterExportCommands";

let serial = 0;
const paths = new Set<string>();
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	for (const p of paths) inlineInk.handleDelete(p);
	paths.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function stroke(id: string, y: number): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2,
		points: [{ x: 300, y, pressure: 0.5, t: 0 }, { x: 320, y: y + 8, pressure: 0.5, t: 8 }],
		bbox: { x: 300, y, width: 20, height: 8 }, createdAt: 1,
	} as InkStroke;
}

const BODY = 24; // 16 px * 1.5
const H1 = 1.2 * 1.618 * 16;
const HEADING_PAD = 16;

interface Row { n: number; from: number; to: number; top: number; pad: number; lh: number; height: number; textTop: number; kind: "h1" | "body"; el: FakeLine }
interface FakeLine { nodeType: 1; kind: "h1" | "body"; top: number; closest(sel: string): FakeLine | null; getBoundingClientRect(): { top: number; left: number } }

/** Browser stand-in: stacks one visual row per line with Obsidian's CSS. */
function layout(state: EditorState): Row[] {
	const doc = state.doc;
	const rows: Row[] = [];
	let top = 0;
	for (let n = 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		const isH1 = /^# /.test(line.text);
		const blank = line.text.trim() === "";
		const prev = n > 1 ? doc.line(n - 1).text : null;
		const prev2 = n > 2 ? doc.line(n - 2).text : null;
		let pad = 0;
		if (isH1) pad = prev !== null && prev.trim() === "" && prev2 !== null && /^#{1,6} /.test(prev2) ? 0 : HEADING_PAD;
		else if (!blank && prev !== null && /^#{1,6} /.test(prev)) pad = 0; // --p-spacing-empty: 0rem
		const lh = isH1 ? H1 : BODY;
		const kind = isH1 ? "h1" : "body";
		const el: FakeLine = {
			nodeType: 1, kind, top,
			closest(sel: string) { return sel === ".cm-line" ? this : null; },
			getBoundingClientRect() { return { top: this.top, left: 0 }; },
		};
		rows.push({ n, from: line.from, to: line.to, top, pad, lh, height: pad + lh, textTop: top + pad, kind, el });
		top += pad + lh;
	}
	return rows;
}

async function rig(text: string) {
	const path = `space-attached-${++serial}.md`;
	paths.add(path);
	const pageId = `space-attached-id-${serial}`;
	const written: PageData[] = [];
	inlineInk.attachHost({
		readPageId: (p) => (p === path ? pageId : null),
		claimId: async () => ({ pageId }),
		loadSidecar: async () => null,
		scheduleSidecar: (_id, page) => void written.push(page),
		notify() {},
	});
	await inlineInk.ensureLoaded(path);
	let failDispatch = false;
	const inkOps: InkOp[] = [];
	/** Each text change dispatched, with the ink ops it carried and the text before it: an undo and a redo replay it. */
	const steps: { ops: InkOp[]; changes: ChangeSet; startDoc: Text }[] = [];
	let state = EditorState.create({ doc: text });
	const rowAtY = (y: number) => {
		const rows = layout(state);
		return rows.find(r => y >= r.top && y < r.top + r.height) ?? (y < 0 ? rows[0]! : rows[rows.length - 1]!);
	};
	const rowAtPos = (pos: number) => {
		const n = state.doc.lineAt(pos).number;
		return layout(state)[n - 1]!;
	};
	const fakeWin = {
		getComputedStyle: (el: FakeLine) => ({ lineHeight: `${el.kind === "h1" ? H1 : BODY}px` }),
		requestAnimationFrame: () => 0, cancelAnimationFrame() {},
	};
	const view = {
		get state() { return state; },
		dom: { isConnected: true, ownerDocument: { defaultView: fakeWin } },
		contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
		documentTop: 0, scaleX: 1, scaleY: 1, defaultLineHeight: BODY,
		posAtCoords: ({ y }: { x: number; y: number }) => rowAtY(y).from,
		coordsAtPos: (pos: number) => { const r = rowAtPos(pos); return { top: r.textTop, bottom: r.textTop + r.lh, left: 0, right: 0 }; },
		domAtPos: (pos: number) => ({ node: rowAtPos(pos).el, offset: 0 }),
		lineBlockAt: (pos: number) => { const r = rowAtPos(pos); return { from: r.from, to: r.to, top: r.top, bottom: r.top + r.height, height: r.height }; },
		dispatch: (input: Transaction | TransactionSpec) => {
			if (failDispatch) throw new Error("injected dispatch failure");
			const tr = input instanceof Transaction ? input : state.update(input);
			state = tr.state;
			const ops = tr.effects.filter((e) => e.is(inkEffect)).map((e) => e.value as InkOp);
			inkOps.push(...ops);
			if (tr.docChanged) steps.push({ ops, changes: tr.changes, startDoc: tr.startState.doc });
			// The overlay's editor update: a document change moves attached groups (updateLineAnchors).
			if (tr.docChanged) overlay.followDocChanged(path, { changes: tr.changes } as unknown as ViewUpdate);
		},
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	Object.assign(overlay, {
		view, container: {}, scale: 1, cssScale: 1, contentStyle: undefined,
		spaceTextEnd: null, spacePreview: null, spacePlan: null, spaceHoverY: null, spaceFeedbackRaf: null,
		spaceIds: [], spaceBounds: null, spaceLineY: null, spaceTotalDy: 0, spaceFromY: 0,
		filePath: () => path,
		fontZoom: 1,
		lineAnchorState: new LineAnchors(() => null),
		shownSteps: Array.from({ length: 16 }, () => ({ step: 0, bound: null })),
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }) },
		damage: { addRect() {}, addAll() {} },
		selection: { prune() {} },
		frontierCache: { invalidate() {} },
		showSpaceCursor() {}, scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {},
	});
	return {
		overlay, path, written, inkOps, steps,
		failNextEdit: () => void (failDispatch = true),
		get state() { return state; },
		rows: () => layout(state),
		inkY: (id: string) => inlineInk.strokes(path).find(s => s.id === id)!.points[0]!.y,
		/** Pen-down at y, drag by `drag` in small steps, lift: the real tool path. */
		gesture(y: number, drag: number) {
			overlay.spaceDown({ x: 300, y, pressure: 0.5, t: 0 }, {} as PointerEvent);
			const plan = overlay.spacePlan;
			const n = 8;
			for (let i = 1; i <= n; i++) overlay.spaceMove([{ x: 300, y: y + drag * i / n, pressure: 0.5, t: i * 8 }]);
			overlay.spaceUp();
			return plan as { y: number; from: number; lineHeight: number; doc: unknown };
		},
	};
}


const TEXT = "Intro paragraph\nSecond line\nThird line\nFourth line\n";

/** A group of `ids` attached to the paragraph `line`, shown where its points are. */
function attach(r: Awaited<ReturnType<typeof rig>>, id: string, ids: string[], line: string): void {
	const from = TEXT.indexOf(line);
	const top = r.rows()[r.state.doc.lineAt(from).number - 1]!.top;
	const record: AttachmentRecord = { v: 1, id, strokeIds: ids, target: targetAt(TEXT, from, from + line.length, "paragraph"), ref: { x: 0, y: top }, layout: { width: 600, font: 16 }, probe: { id: ids[0]!, x: 300, y: 0 } };
	inlineInk.setAttachments(r.path, [...inlineInk.attachments(r.path), record], false);
	r.overlay.lineAnchors.follow.setList(inlineInk.attachments(r.path));
	r.overlay.lineAnchors.follow.attached(record, top);
}

/** Where a stroke is shown: its points plus its group's correction. */
const shownY = (r: Awaited<ReturnType<typeof rig>>, id: string) => r.inkY(id) + (r.overlay.lineAnchors.follow.offsetOf(id)?.dy ?? 0);

describe("insert space and attached ink", () => {
	it("a group whose words are below the seam moves once, with its words, even where its ink is above the seam", async () => {
		// Defect: the members move in the store and again with the text change: twice the space.
		const r = await rig(TEXT);
		const thirdTop = r.rows()[2]!.textTop;
		inlineInk.applyAddLive(r.path, [stroke("free", 76), stroke("a1", thirdTop + 4), stroke("a2", 20)]);
		attach(r, "att-a", ["a1", "a2"], "Fourth line");
		const before = { free: shownY(r, "free"), a1: shownY(r, "a1"), a2: shownY(r, "a2") };
		r.gesture(46, 3 * BODY);
		expect(r.state.doc.lines, "premise: three lines opened").toBe(TEXT.split("\n").length + 3);
		expect(shownY(r, "free")).toBe(before.free + 3 * BODY);
		expect(shownY(r, "a1")).toBe(before.a1 + 3 * BODY);
		expect(shownY(r, "a2"), "a member above the seam moves with its group").toBe(before.a2 + 3 * BODY);
	});

	it("a group whose words are above the seam stays whole, even where its ink is below", async () => {
		// Defect: the rows rule moves the member below the seam and splits the group from its words.
		const r = await rig(TEXT);
		inlineInk.applyAddLive(r.path, [stroke("free", 76), stroke("h1", 80)]);
		attach(r, "att-h", ["h1"], "Intro paragraph");
		const before = { free: shownY(r, "free"), h1: shownY(r, "h1") };
		r.gesture(46, 3 * BODY);
		expect(shownY(r, "free")).toBe(before.free + 3 * BODY);
		expect(shownY(r, "h1")).toBe(before.h1);
	});

	it("the drag's picture carries a moving group whole and leaves a held group, ink above or below the seam", async () => {
		// Defect: the preview lists rows only, so the picture splits a group the lift then moves whole.
		const r = await rig(TEXT);
		const thirdTop = r.rows()[2]!.textTop;
		inlineInk.applyAddLive(r.path, [stroke("a1", thirdTop + 4), stroke("a2", 20), stroke("h1", 80)]);
		attach(r, "att-a", ["a1", "a2"], "Fourth line");
		attach(r, "att-h", ["h1"], "Intro paragraph");
		r.overlay.spaceDown({ x: 300, y: 46, pressure: 0.5, t: 0 }, {} as PointerEvent);
		expect([...r.overlay.spaceIds].sort()).toEqual(["a1", "a2"]);
	});

	it("a hover whose seam crosses a group's words, no ink row changing side, lists the group again", async () => {
		// Defect: the preview keeps the last lists while no row changes side, so the group keeps the side it had.
		const r = await rig(TEXT);
		inlineInk.applyAddLive(r.path, [stroke("g", 5)]);
		attach(r, "att-g", ["g"], "Fourth line");
		const at = (y: number) => (r.overlay.spacePreview = r.overlay.previewSpace({ y } as never));
		expect(at(40).moving).toEqual(["g"]);
		expect(at(100).moving).toEqual([]);
	});

	/** Pen-down at 46, drag three body lines in eight moves, lift: the picture's list at pen-down and at the last move. */
	function dragThree(r: Awaited<ReturnType<typeof rig>>): { down: string[]; last: string[] } {
		r.overlay.spaceDown({ x: 300, y: 46, pressure: 0.5, t: 0 }, {} as PointerEvent);
		const down = [...r.overlay.spaceIds].sort();
		for (let i = 1; i <= 8; i++) r.overlay.spaceMove([{ x: 300, y: 46 + 3 * BODY * i / 8, pressure: 0.5, t: i * 8 }]);
		const last = [...r.overlay.spaceIds].sort();
		r.overlay.spaceUp();
		return { down, last };
	}

	/** A group of `ids` on "Fourth line" whose words need reattachment: the text change never moves it. */
	function held(r: Awaited<ReturnType<typeof rig>>, id: string, ids: string[]): void {
		attach(r, id, ids, "Fourth line");
		r.overlay.lineAnchors.follow.setList(inlineInk.attachments(r.path), new Map([[id, "needs-reattachment"]]));
	}

	it("a group whose words need reattachment, wholly below the seam, moves once as free ink, in the picture and at the lift", async () => {
		// Defect: the group is sorted by its words' line and its members are left out of the store move, so the picture
		// moves it and the lift does not (the snap), or neither moves it and it is left behind in the opened lines.
		const r = await rig(TEXT);
		inlineInk.applyAddLive(r.path, [stroke("free", 76), stroke("n1", 80), stroke("n2", 90)]);
		held(r, "att-n", ["n1", "n2"]);
		const before = { free: shownY(r, "free"), n1: shownY(r, "n1"), n2: shownY(r, "n2") };
		const lists = dragThree(r);
		expect(lists, "the picture moves the group with the free ink").toEqual({ down: ["free", "n1", "n2"], last: ["free", "n1", "n2"] });
		expect(r.state.doc.lines, "premise: three lines opened").toBe(TEXT.split("\n").length + 3);
		expect(shownY(r, "free")).toBe(before.free + 3 * BODY);
		expect(shownY(r, "n1")).toBe(before.n1 + 3 * BODY);
		expect(shownY(r, "n2")).toBe(before.n2 + 3 * BODY);
	});

	it("a group whose words need reattachment, its top above the seam, does not move, in the picture or at the lift", async () => {
		// Defect: the rows rule splits the group; a member below the seam moves, the one above stays.
		const r = await rig(TEXT);
		inlineInk.applyAddLive(r.path, [stroke("free", 76), stroke("s1", 20), stroke("s2", 90)]);
		held(r, "att-s", ["s1", "s2"]);
		const before = { free: shownY(r, "free"), s1: shownY(r, "s1"), s2: shownY(r, "s2") };
		expect(dragThree(r)).toEqual({ down: ["free"], last: ["free"] });
		expect(shownY(r, "free")).toBe(before.free + 3 * BODY);
		expect(shownY(r, "s1")).toBe(before.s1);
		expect(shownY(r, "s2")).toBe(before.s2);
	});

	it("a group whose words were deleted, wholly below the seam, moves once as free ink, in the picture and at the lift", async () => {
		// Defect: as above, for a target collapsed to nothing, which the text change never moves either.
		const r = await rig(TEXT);
		inlineInk.applyAddLive(r.path, [stroke("free", 76), stroke("c1", 90)]);
		attach(r, "att-c", ["c1"], "Fourth line");
		const [rec] = inlineInk.attachments(r.path) as AttachmentRecord[];
		inlineInk.setAttachments(r.path, [{ ...rec!, target: { ...rec!.target, to: rec!.target.from } }], false);
		r.overlay.lineAnchors.follow.setList(inlineInk.attachments(r.path));
		const before = { free: shownY(r, "free"), c1: shownY(r, "c1") };
		expect(dragThree(r)).toEqual({ down: ["c1", "free"], last: ["c1", "free"] });
		expect(shownY(r, "free")).toBe(before.free + 3 * BODY);
		expect(shownY(r, "c1")).toBe(before.c1 + 3 * BODY);
	});

	it("a group whose words need reattachment, moved by the lift, has its record's reference point and probe moved with it", async () => {
		// Defect: the points move and the record stays, so a later reattachment reads a record that no longer agrees
		// with its points and settles the group by the inserted height instead of zero.
		const r = await rig(TEXT);
		inlineInk.applyAddLive(r.path, [stroke("n1", 80)]);
		held(r, "att-n", ["n1"]);
		const rec = () => inlineInk.attachments(r.path)[0] as AttachmentRecord;
		const before = { ref: rec().ref.y - r.inkY("n1"), probe: rec().probe.y - r.inkY("n1") };
		dragThree(r);
		expect(r.inkY("n1"), "premise: the lift moved the member").toBe(80 + 3 * BODY);
		expect(rec().ref.y - r.inkY("n1")).toBe(before.ref);
		expect(rec().probe.y - r.inkY("n1")).toBe(before.probe);
	});

	it("a group whose words need reattachment and whose shown top is below the seam, its stored top above, moves as free ink", async () => {
		// Defect: the group is sorted by its stored points, not where it is shown, so it stays while ink shown above it moves.
		const r = await rig(TEXT);
		inlineInk.applyAddLive(r.path, [stroke("free", 76), stroke("k1", 30)]);
		attach(r, "att-k", ["k1"], "Fourth line");
		const [rec] = inlineInk.attachments(r.path) as AttachmentRecord[];
		inlineInk.setAttachments(r.path, [{ ...rec!, ref: { x: rec!.ref.x, y: rec!.ref.y - 30 } }], false);
		r.overlay.lineAnchors.follow.setList(inlineInk.attachments(r.path));
		r.overlay.lineAnchors.follow.setList(inlineInk.attachments(r.path), new Map([["att-k", "needs-reattachment"]]));
		expect(shownY(r, "k1"), "premise: shown 30 below its points, past the seam").toBe(60);
		const before = { free: shownY(r, "free"), k1: shownY(r, "k1") };
		expect(dragThree(r)).toEqual({ down: ["free", "k1"], last: ["free", "k1"] });
		expect(shownY(r, "free")).toBe(before.free + 3 * BODY);
		expect(shownY(r, "k1")).toBe(before.k1 + 3 * BODY);
	});

	it("an undo and a redo of an Insert Space over a group whose words need reattachment, text and all, keep points, record and text together", async () => {
		// Defect: history applies the step before the record is mapped through the text, so the record no longer equals
		// the step's and the step is spent: the points go back and the record stays moved (and the mirror at a redo).
		const r = await rig(TEXT);
		inlineInk.applyAddLive(r.path, [stroke("n1", 80)]);
		held(r, "att-n", ["n1"]);
		const rec = () => inlineInk.attachments(r.path)[0] as AttachmentRecord;
		const at = () => ({ y: r.inkY("n1"), ref: rec().ref.y, probe: rec().probe.y, target: rec().target, text: r.state.doc.toString() });
		const before = at();
		dragThree(r);
		const lifted = at();
		expect(lifted.y, "premise: the lift moved the member").toBe(before.y + 3 * BODY);
		const { ops, changes, startDoc } = r.steps.splice(0)[0]!;
		// Undo: the ink ops first, with the text change of their step (InkOverlayReload), then the text maps the records.
		for (const op of [...ops].reverse()) r.overlay.applyInkOp(invertInkOp(op), true);
		r.overlay.view.dispatch({ changes: changes.invert(startDoc) });
		expect(at(), "after one undo").toEqual(before);
		for (const op of ops) r.overlay.applyInkOp(op, true);
		r.overlay.view.dispatch({ changes });
		expect(at(), "after one redo").toEqual(lifted);
	});

	it("a group whose words need reattachment and whose target lies past the end of the note: typing and a redo throw nothing, its ink stays", async () => {
		// Defect: mapping the record through the keystroke, or seeding the redo at its target's line, reads past the end.
		const r = await rig(TEXT);
		inlineInk.applyAddLive(r.path, [stroke("p1", 90)]);
		held(r, "att-p", ["p1"]);
		const [rec] = inlineInk.attachments(r.path) as AttachmentRecord[];
		const past: AttachmentRecord = { ...rec!, target: { ...rec!.target, from: TEXT.length + 40, to: TEXT.length + 50 } };
		inlineInk.setAttachments(r.path, [past], false);
		r.overlay.lineAnchors.follow.setList(inlineInk.attachments(r.path), new Map([["att-p", "needs-reattachment"]]));
		const before = shownY(r, "p1");
		expect(() => r.overlay.view.dispatch({ changes: { from: 0, insert: "x" } })).not.toThrow();
		expect(shownY(r, "p1")).toBe(before);
		const now = inlineInk.attachments(r.path)[0] as AttachmentRecord;
		const redo: InkOp = { type: "attach", path: r.path, id: "att-p", before: now, after: { ...now, ref: { x: now.ref.x, y: now.ref.y + 5 }, target: past.target } } as InkOp;
		expect(() => r.overlay.applyInkOp(redo)).not.toThrow();
		expect(shownY(r, "p1")).toBe(before);
	});

	it("strokeIdsBelow with groups: held members leave, moving members join, in store order", () => {
		// Defect: the rows rule alone decides, so a group straddling the seam splits.
		const strokes = [stroke("up", 10), stroke("g1", 10), stroke("down", 90), stroke("g2", 90)];
		const groups = { move: new Set(["g1"]), hold: new Set(["g2"]) };
		expect(strokeIdsBelow(strokes, 50, rowsOf(strokes), groups)).toEqual(["g1", "down"]);
		expect(strokeIdsBelow(strokes, 50, rowsOf(strokes))).toEqual(["down", "g2"]);
		expect(insertSpaceMembers([], 50, new Map())).toEqual({ move: new Set(), hold: new Set() });
	});
});

describe("export of attached ink", () => {
	it("a lasso move of attached ink, a page write, one undo: the move undoes, and the write moves no stored point", async () => {
		// Defect: a write that settles stored points spends the move's undo, as its `from` no longer stands.
		const r = await rig(TEXT);
		inlineInk.applyAddLive(r.path, [stroke("g1", 76)]);
		attach(r, "att-g", ["g1"], "Fourth line");
		const rec = () => inlineInk.attachments(r.path)[0] as AttachmentRecord;
		const before = { y: r.inkY("g1"), shown: shownY(r, "g1"), rec: rec() };
		r.overlay.moveLive(r.path, ["g1"], 0, 30);
		r.overlay.dispatchDrop(r.path, ["g1"], 0, 30);
		inlineInk.save(r.path);
		await Promise.resolve();
		if (r.written.length) serializePage(r.written[r.written.length - 1]!);
		expect(r.inkY("g1"), "the write moved no stored point").toBe(before.y + 30);
		const ops = r.inkOps.splice(0);
		for (const op of [...ops].reverse()) r.overlay.applyInkOp(invertInkOp(op));
		expect({ y: r.inkY("g1"), shown: shownY(r, "g1"), rec: rec() }).toEqual(before);
	});

	it("after typing above, the SVG and PDF exports show the group where it is shown, and free ink where it is stored", async () => {
		// Defect: export reads the store, and with no point settle at a write the stored points stay where the group was
		// attached, so the exported drawing puts it a line above its words.
		const r = await rig(TEXT);
		inlineInk.applyAddLive(r.path, [stroke("free", 20), stroke("g1", 76)]);
		attach(r, "att-g", ["g1"], "Fourth line");
		r.overlay.view.dispatch({ changes: { from: 0, insert: "New first line\n" } });
		expect(shownY(r, "g1"), "premise: the group follows its words down one line").toBe(76 + BODY);
		const store = inlineInk.strokes(r.path);
		const shown = store.map((s) => (s.id === "g1" ? shiftedStroke(s, BODY) : s));
		const exported = r.overlay.exportStrokes(r.path) as InkStroke[];
		expect(exported.map((s) => s.points[0]!.y)).toEqual([20, 76 + BODY]);
		expect(exported[0], "free ink is the store's own stroke").toBe(store[0]);
		expect(inkToSvg(exported)).toBe(inkToSvg(shown));
		expect(inkToSvg(exported)).not.toBe(inkToSvg(store));
		expect(bytesOf(inkToPdf(exported)!)).toEqual(bytesOf(inkToPdf(shown)!));
	});
});

describe("export of a group this pane has not read yet", () => {
	/**
	 * A reopened note: a group moved 40 down by typing above it, its record keeping that correction, and nothing read
	 * since (it is out of view). A free stroke beside it.
	 */
	async function reopened() {
		const r = await rig(TEXT);
		inlineInk.applyAddLive(r.path, [stroke("free", 20), stroke("g1", 76)]);
		const from = TEXT.indexOf("Fourth line");
		const record: AttachmentRecord = {
			v: 1, id: "att-g", strokeIds: ["g1"], target: targetAt(TEXT, from, from + "Fourth line".length, "paragraph"),
			ref: { x: 0, y: 72 }, layout: { width: 600, font: 16 }, probe: { id: "g1", x: 300, y: 0 }, shown: { dx: 0, dy: 40 },
		};
		inlineInk.setAttachments(r.path, [record], false);
		return r;
	}

	it("the editor's export draws the group at its record's kept correction, and free ink where it is stored", async () => {
		const r = await reopened();
		const store = inlineInk.strokes(r.path);
		const exported = r.overlay.exportStrokes(r.path) as InkStroke[];
		expect(r.overlay.lineAnchors.follow.offsetOf("g1"), "premise: the group is unread here").toBeNull();
		expect.soft(exported.map((s) => s.points[0]!.y), "the group 40 below its stored points").toEqual([20, 76 + 40]);
		expect.soft(exported[0], "free ink is the store's own stroke").toBe(store[0]);
		expect.soft(inkToSvg(exported)).toBe(inkToSvg([store[0]!, shiftedStroke(store[1]!, 40)]));
	});

	it("with no editor on the note, the export draws each group at its record's kept correction, and free ink where it is stored", async () => {
		const r = await reopened();
		const store = inlineInk.strokes(r.path);
		const proto = {} as { exportedStrokes(path: string): readonly InkStroke[] };
		installRegisterExportCommands(proto as never);
		const exported = proto.exportedStrokes.call({ app: { workspace: {} } }, r.path);
		expect.soft(exported.map((s) => s.points[0]!.y), "the group 40 below its stored points").toEqual([20, 76 + 40]);
		expect.soft(exported[0], "free ink is the store's own stroke").toBe(store[0]);
		expect.soft(inkToSvg(exported)).toBe(inkToSvg([store[0]!, shiftedStroke(store[1]!, 40)]));
	});
});
