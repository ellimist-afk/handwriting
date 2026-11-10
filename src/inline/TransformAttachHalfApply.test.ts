/**
 * T2-06: one undo of a step that carries an ink move or transform and an attach step, with one half made stale since by
 * another pane or device. The step is one undo: its halves go back together or neither does, as each half already does on
 * its own (addendum 3: one undo puts points, probe and shown place back together; addendum 1 item 4: a stale step applies
 * nothing). The steps: a resize or rotate over an attached group and free ink [transform, attach], a lasso drop of a group
 * [move, attach], and an Insert Space over a group whose words need reattachment [move, attach]. Insert Space's text change
 * is the editor's and always applies; only its ink halves are read here.
 *
 * Rigs copied: InkOverlayLassoTransform.test.ts's (a bare overlay with the real selection model and line anchors, a fake
 * view), with InkOverlayAttachLasso.test.ts's drop, and InsertSpaceAttached.test.ts's (its body-line editor stand-in and
 * the real spaceDown / spaceMove / spaceUp). Each undo is one editor transaction carrying the step's inverted halves in the
 * order the history's invertedEffects gives them, run through the overlay's update, where history's ink ops are applied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Text, Transaction, type ChangeSet, type TransactionSpec } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import type { InlineInkHost } from "./InlineInkStore";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage, type PageData } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { SelectionModel } from "../objects/SelectionModel";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import { inkEffect, invertInkOp, type InkOp } from "./InkHistory";
import { handlePoints } from "./LassoTransform";
import type { PenSample } from "../input/PointerRouter";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 40;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();
const word = "line 3 words";
/** The group is read 6 right and 12 down of its record. */
const READ = { x: 6, y: 92 };

function strokeAt(id: string, x: number, y: number, tool: "pen" | "highlighter" = "pen"): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool, color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function record(): AttachmentRecord {
	const from = DOC.indexOf(word);
	return { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: "s1", x: 10, y: 89 } };
}

const sample = (p: { x: number; y: number }): PenSample => ({ x: p.x, y: p.y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

function rig(path: string, attached = true, cssScale = 1) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: attached ? [record()] : [] };
	rec.strokes = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90), strokeAt("free", 10, 205)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	anchors.follow.setList(inlineInk.attachments(path));
	anchors.follow.measure({ inView: () => true, refAt: () => READ, blockTop: () => 80 });
	const sent: TransactionSpec[] = [];
	const selection = new SelectionModel();
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors,
		view: {
			scaleY: 1,
			state: { doc },
			lineBlockAt: () => ({ top: 80, bottom: 120 }),
			lineBlockAtHeight: (h: number) => {
				const line = doc.line(Math.min(LINES, Math.floor(h / 40) + 1));
				return { from: line.from, to: line.to, top: (line.number - 1) * 40, bottom: line.number * 40 };
			},
			requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
			dispatch: (spec: TransactionSpec) => sent.push(spec),
		},
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 } },
		scale: cssScale,
		cssScale,
		fontZoom: 1,
		paintedStrokeCount: 0,
		repaintQueued: true,
		lassoActive: false,
		lassoPts: [],
		dragTotal: null,
		damage: { addRect: () => {}, addAll: () => {} },
		filePath: () => path,
		strokesHere: () => anchors.strokesFor(path, inlineInk.strokes(path)),
		showLassoCursor: () => {},
		dropExtentBuild: () => {},
		endLiveGestureForHistory: () => {},
		scheduleRepaint: () => {},
		repaintPath: () => {},
		redrawSelectionUI: () => {},
		lineAnchorsMoved: () => {},
		currentIndexes: () => [],
		frontierCache: { invalidate: () => {} },
		spaceSnapshot: null,
		selection,
		followRefAt: () => ({ x: 3, y: 200 }),
		ownsMarkdownEditorRoot: () => false,
	});
	const shown = () => {
		anchors.follow.setList(inlineInk.attachments(path));
		return anchors.strokesFor(path, inlineInk.strokes(path)).map((s) => ({ id: s.id, points: s.points.map((p) => ({ x: p.x, y: p.y })) }));
	};
	const stored = () => inlineInk.strokes(path).map((s) => ({ id: s.id, width: s.width, points: s.points.map((p) => ({ ...p })) }));
	/** Grab the handle `handle` of the selection `ids`, move the pen to `to(handle centre, box)`, lift. */
	const gesture = (ids: string[], handle: "se" | "rotate", to: (at: { x: number; y: number }) => { x: number; y: number }, input: "pen" | "touch" = "pen") => {
		selection.selectExactly(ids);
		const box = overlay.selectionBounds()!;
		const at = handlePoints(box, 1)[handle];
		overlay.lassoDown(sample(at), input);
		const t = overlay.spaceSnapshot?.transform?.gesture;
		overlay.lassoMove([sample(to(at))], false);
		const accepted = t ? { ...t.accepted } : null;
		overlay.lassoUp();
		return { box, accepted };
	};
	/** A live drag already moved the store by (dx, dy) (no picture); the lift commits it (InkOverlayAttachLasso.test.ts). */
	const drop = (ids: string[], dx: number, dy: number) => {
		inlineInk.moveStrokes(path, ids, dx, dy);
		Object.assign(overlay, { dragTotal: { dx, dy }, dragIds: ids, dragBox: null, dragFrom: null });
		overlay.commitLiveDrag();
	};
	return { overlay, anchors, sent, shown, stored, gesture, drop, selection, path };
}

const ops = (spec: TransactionSpec): InkOp[] => [spec.effects ?? []].flat().map((e) => (e as { value: InkOp }).value);

let spaceSerial = 0;
const paths = new Set<string>();
function spaceStroke(id: string, y: number): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2,
		points: [{ x: 300, y, pressure: 0.5, t: 0 }, { x: 320, y: y + 8, pressure: 0.5, t: 8 }],
		bbox: { x: 300, y, width: 20, height: 8 }, createdAt: 1,
	} as InkStroke;
}

const BODY = 24; // 16 px * 1.5
const H1 = 1.2 * 1.618 * 16;
const HEADING_PAD = 16;

interface SpaceRow { n: number; from: number; to: number; top: number; pad: number; lh: number; height: number; textTop: number; kind: "h1" | "body"; el: SpaceLine }
interface SpaceLine { nodeType: 1; kind: "h1" | "body"; top: number; closest(sel: string): SpaceLine | null; getBoundingClientRect(): { top: number; left: number } }

/** Browser stand-in: stacks one visual row per line with Obsidian's CSS. */
function spaceLayout(state: EditorState): SpaceRow[] {
	const doc = state.doc;
	const rows: SpaceRow[] = [];
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
		const el: SpaceLine = {
			nodeType: 1, kind, top,
			closest(sel: string) { return sel === ".cm-line" ? this : null; },
			getBoundingClientRect() { return { top: this.top, left: 0 }; },
		};
		rows.push({ n, from: line.from, to: line.to, top, pad, lh, height: pad + lh, textTop: top + pad, kind, el });
		top += pad + lh;
	}
	return rows;
}

async function spaceRig(text: string) {
	const path = `space-attached-${++spaceSerial}.md`;
	paths.add(path);
	const pageId = `space-attached-id-${spaceSerial}`;
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
		const rows = spaceLayout(state);
		return rows.find(r => y >= r.top && y < r.top + r.height) ?? (y < 0 ? rows[0]! : rows[rows.length - 1]!);
	};
	const rowAtPos = (pos: number) => {
		const n = state.doc.lineAt(pos).number;
		return spaceLayout(state)[n - 1]!;
	};
	const fakeWin = {
		getComputedStyle: (el: SpaceLine) => ({ lineHeight: `${el.kind === "h1" ? H1 : BODY}px` }),
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
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }) },
		damage: { addRect() {}, addAll() {} },
		selection: { prune() {} },
		frontierCache: { invalidate() {} },
		showSpaceCursor() {}, scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {},
		ownsMarkdownEditorRoot: () => false, unmount() {},
	});
	return {
		overlay, path, written, inkOps, steps,
		failNextEdit: () => void (failDispatch = true),
		get state() { return state; },
		rows: () => spaceLayout(state),
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


const SPACE_TEXT = "Intro paragraph\nSecond line\nThird line\nFourth line\n";

/** A group of `ids` attached to the paragraph `line`, shown where its points are. */
function spaceAttach(r: Awaited<ReturnType<typeof spaceRig>>, id: string, ids: string[], line: string): void {
	const from = SPACE_TEXT.indexOf(line);
	const top = r.rows()[r.state.doc.lineAt(from).number - 1]!.top;
	const record: AttachmentRecord = { v: 1, id, strokeIds: ids, target: targetAt(SPACE_TEXT, from, from + line.length, "paragraph"), ref: { x: 0, y: top }, layout: { width: 600, font: 16 }, probe: { id: ids[0]!, x: 300, y: 0 } };
	inlineInk.setAttachments(r.path, [...inlineInk.attachments(r.path), record], false);
	r.overlay.lineAnchors.follow.setList(inlineInk.attachments(r.path));
	r.overlay.lineAnchors.follow.attached(record, top);
}

/** Pen-down at 46, drag three body lines in eight moves, lift: the picture's list at pen-down and at the last move. */
function spaceDragThree(r: Awaited<ReturnType<typeof spaceRig>>): { down: string[]; last: string[] } {
	r.overlay.spaceDown({ x: 300, y: 46, pressure: 0.5, t: 0 }, {} as PointerEvent);
	const down = [...r.overlay.spaceIds].sort();
	for (let i = 1; i <= 8; i++) r.overlay.spaceMove([{ x: 300, y: 46 + 3 * BODY * i / 8, pressure: 0.5, t: i * 8 }]);
	const last = [...r.overlay.spaceIds].sort();
	r.overlay.spaceUp();
	return { down, last };
}

/** A group of `ids` on "Fourth line" whose words need reattachment: the text change never moves it. */
function spaceHeld(r: Awaited<ReturnType<typeof spaceRig>>, id: string, ids: string[]): void {
	spaceAttach(r, id, ids, "Fourth line");
	r.overlay.lineAnchors.follow.setList(inlineInk.attachments(r.path), new Map([[id, "needs-reattachment"]]));
}

/** One undo of `step` as the editor runs it: one transaction with every inverted half (and `changes`, the text's), through update. */
function undo(overlay: InkOverlayPlugin, step: InkOp[], state = EditorState.create({ doc: DOC }), changes?: ChangeSet): void {
	const tr = state.update({ changes, effects: step.map((op) => inkEffect.of(invertInkOp(op))) });
	overlay.update({ transactions: [tr] } as unknown as ViewUpdate);
}

/** The group and the free stroke beside it turned together: the step and the state it left. */
function turned(path: string) {
	const r = rig(path);
	r.gesture(["s1", "s2", "free"], "rotate", (at) => ({ x: at.x + 40, y: at.y + 30 }));
	return { ...r, step: ops(r.sent[0]!) };
}

describe("one undo of a step with an ink half and an attach half, one half stale", () => {
	it("control: a resize or rotate over a group and free ink, nothing stale: the undo puts points and record back", () => {
		const { overlay, stored, step, path } = turned("t2-06-control.md");
		expect(step.map((op) => op.type), "premise: one step with both halves").toEqual(["transform", "attach"]);
		undo(overlay, step);
		expect(inlineInk.attachments(path)).toEqual([record()]);
		expect(stored().find((s) => s.id === "s1")!.points[0]).toMatchObject({ x: 10, y: 89 });
	});

	it("a resize or rotate, the free stroke erased in another pane: the undo leaves the group's record as it leaves its points", () => {
		const { overlay, stored, step, path } = turned("t2-06-erased.md");
		inlineInk.applyRemove(path, ["free"]);
		const now = { stored: stored(), list: inlineInk.attachments(path) };
		undo(overlay, step);
		expect(stored(), "premise: the transform half is spent").toEqual(now.stored);
		expect(inlineInk.attachments(path), "the attach half went back alone: the probe no longer names its stroke's first point").toEqual(now.list);
	});

	it("a resize or rotate, the record remapped by a character typed above: the undo leaves the points as it leaves the record", () => {
		const { overlay, stored, step, path } = turned("t2-06-remapped.md");
		const rec = inlineInk.attachments(path)[0] as AttachmentRecord, from = DOC.indexOf(word) + 1;
		inlineInk.setAttachments(path, [{ ...rec, target: targetAt("x" + DOC, from, from + word.length, "range") }], false);
		const now = { stored: stored(), list: inlineInk.attachments(path) };
		undo(overlay, step);
		expect(inlineInk.attachments(path), "premise: the attach half is spent").toEqual(now.list);
		expect(stored(), "the transform half went back alone: the points turned back with the probe still turned").toEqual(now.stored);
	});

	it("a lasso drop of a group, one member erased in another pane: the undo leaves the record as it leaves the points", () => {
		const { overlay, stored, drop, sent, path } = rig("t2-06-drop.md");
		drop(["s1", "s2"], 5, 7);
		const step = ops(sent[0]!);
		expect(step.map((op) => op.type), "premise: one step with both halves").toEqual(["move", "attach"]);
		inlineInk.applyRemove(path, ["s2"]);
		const now = { stored: stored(), list: inlineInk.attachments(path) };
		undo(overlay, step);
		expect(stored(), "premise: the move half is spent").toEqual(now.stored);
		expect(inlineInk.attachments(path), "the attach half went back alone: the probe back where the ink no longer is").toEqual(now.list);
	});
});

describe("one undo of an Insert Space over a held group, its record gone", () => {
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

	it("the group detached in another pane: the undo moves no ink back, as it puts no record back", async () => {
		const r = await spaceRig(SPACE_TEXT);
		inlineInk.applyAddLive(r.path, [spaceStroke("n1", 80), spaceStroke("f1", 70)]);
		spaceHeld(r, "att-n", ["n1"]);
		spaceDragThree(r);
		expect(r.inkY("n1"), "premise: the lift moved the member").toBe(80 + 3 * BODY);
		const { ops: step, changes, startDoc } = r.steps.splice(0)[0]!;
		expect(step.map((op) => op.type), "premise: one step with the move and the held group's attach").toEqual(["move", "attach"]);
		inlineInk.setAttachments(r.path, inlineInk.attachments(r.path).filter((a) => a.id !== "att-n"), false);
		const now = { n1: r.inkY("n1"), f1: r.inkY("f1"), list: inlineInk.attachments(r.path) };
		undo(r.overlay, step, r.state, changes.invert(startDoc));
		expect(inlineInk.attachments(r.path), "premise: the attach half is spent").toEqual(now.list);
		expect({ n1: r.inkY("n1"), f1: r.inkY("f1") }, "the move half went back alone").toEqual({ n1: now.n1, f1: now.f1 });
	});
});
