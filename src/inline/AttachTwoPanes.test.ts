/**
 * Ink attached to text with the note open in two panes. Each pane hears the same document change; the attached targets
 * move through it once. One pane maps the note's list and writes it, the one the anchors' writer election names (the
 * focused pane, else the first to show the note); every other pane takes the list as that pane leaves it. Two bare
 * overlays on one note, each with its own fake view; no DOM.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const DOC = "Intro line with many more words so the context ends here.\nThe word benzene here.\nLast line.\n";
const LH = 30;
const FROM = DOC.indexOf("benzene");

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** One pane on `path`: its own document copy, its own anchors, the store shared. */
function pane(path: string, record: AttachmentRecord, focused = () => false) {
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const state = { doc: Text.of(DOC.split("\n")) };
	const view = { scaleY: 1, state, lineBlockAt: (pos: number) => ({ top: state.doc.lineAt(pos).number * LH - LH, bottom: state.doc.lineAt(pos).number * LH }) };
	const anchors = new LineAnchors(() => null, focused);
	Object.assign(overlay, { view, fontZoom: 1, lineAnchorState: anchors, lineAnchorsMoved: () => {}, followMoved: () => {} });
	anchors.follow.setList(inlineInk.attachments(path));
	anchors.follow.attached(record, LH);
	// As each editor update does first: the pane is listed under the note's strokes, beside every other pane on it.
	anchors.tracks(path, inlineInk.strokes(path));
	/** The editor's update for one change: its own document moves, then the follow hears it. */
	const hear = (changes: ChangeSet) => {
		const startState = { doc: state.doc };
		state.doc = changes.apply(state.doc);
		overlay.followDocChanged(path, { changes, startState, state: { doc: state.doc } } as unknown as ViewUpdate);
	};
	const target = () => (anchors.follow.attachments.find((a) => a.id === "att-1") as AttachmentRecord).target;
	return { hear, anchors, target, doc: () => state.doc };
}

function rig(path: string, focusA = () => false) {
	const record: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1"], target: targetAt(DOC, FROM, FROM + 7, "range"), ref: { x: 0, y: LH }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 1, y: 40 } };
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [record] };
	rec.strokes = [strokeAt("s1", 1, 36)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	return { record, a: pane(path, record, focusA), b: () => pane(path, record) };
}

const stored = (path: string) => (inlineInk.attachments(path).find((a) => a.id === "att-1") as AttachmentRecord).target;
const insertAtTop = () => ChangeSet.of([{ from: 0, insert: "abc\n" }], DOC.length);

describe("typing with the note in two panes moves each attached target once", () => {
	it("a line typed at the top, heard by both panes: the target moves by the line once, in the file and in both panes", () => {
		// Defect: each pane maps the store's list and writes it back, so the second pane maps the first's result again and
		// the target lands a line's length past its words.
		const path = "attach-two-panes-once.md";
		const { a, b: makeB } = rig(path);
		const b = makeB();
		const change = insertAtTop();
		a.hear(change);
		b.hear(change);
		expect(stored(path).from).toBe(FROM + 4);
		expect(stored(path).to).toBe(FROM + 11);
		expect(a.target()).toEqual(stored(path));
		expect(b.target()).toEqual(stored(path));
		expect(a.doc().sliceString(stored(path).from, stored(path).to)).toBe("benzene");
	});

	it("the same, heard first by the pane that does not write", () => {
		// Defect: the pane heard first maps the list whichever pane it is; the writer then maps it again.
		const path = "attach-two-panes-order.md";
		const { a, b: makeB } = rig(path);
		const b = makeB();
		const change = insertAtTop();
		b.hear(change);
		a.hear(change);
		expect(stored(path).from).toBe(FROM + 4);
		expect(a.target()).toEqual(stored(path));
		expect(b.target()).toEqual(stored(path));
	});

	it("the pane with focus writes; the other pane, heard first, takes its list", () => {
		// Defect: the first pane on the note writes even when the user types in the other.
		const path = "attach-two-panes-focus.md";
		let aFocused = false;
		const { a, b: makeB } = rig(path, () => aFocused);
		const b = makeB();
		aFocused = true;
		const change = insertAtTop();
		b.hear(change);
		a.hear(change);
		expect(stored(path).from).toBe(FROM + 4);
		expect(b.target()).toEqual(stored(path));
	});

	it("one pane closed, the other alone writes the next line typed", () => {
		// Defect: with no handover the pane left never writes (FROM + 4 stays), or the doubling of the first change carries on.
		const path = "attach-two-panes-handover.md";
		const { a, b: makeB } = rig(path);
		const b = makeB();
		const first = insertAtTop();
		a.hear(first);
		b.hear(first);
		a.anchors.detached();
		b.hear(ChangeSet.of([{ from: 0, insert: "abc\n" }], b.doc().length));
		expect(stored(path).from).toBe(FROM + 8);
		expect(b.target()).toEqual(stored(path));
		expect(b.doc().sliceString(stored(path).from, stored(path).to)).toBe("benzene");
	});

	it("control: one pane alone moves the target by the line once", () => {
		const path = "attach-two-panes-alone.md";
		const { a } = rig(path);
		a.hear(insertAtTop());
		expect(stored(path).from).toBe(FROM + 4);
		expect(a.target()).toEqual(stored(path));
	});
});

describe("an outside change reaching both panes moves each attached target once", () => {
	/** As each editor update does: the pane is listed under the note's strokes as they are now, then it hears the change. */
	const update = (p: ReturnType<typeof pane>, path: string, changes: ChangeSet) => {
		p.anchors.tracks(path, inlineInk.strokes(path));
		p.hear(changes);
	};
	const freePoints = () => strokeAt("f1", 1, 66).points;
	const free = (path: string) => inlineInk.strokes(path).find((s) => s.id === "f1") as InkStroke;

	it("the strokes replaced, then the change heard first by the pane without focus: the target moves by the line once", () => {
		// Defect: the pane without focus, alone under the new strokes, maps and writes the list; the focused pane then joins,
		// is the writer too and maps that list through the same change again, so the target lands a line past its words.
		const path = "attach-two-panes-replaced.md";
		let aFocused = false;
		const { a, b: makeB } = rig(path, () => aFocused);
		const b = makeB();
		aFocused = true;
		inlineInk.record(path).strokes = [...inlineInk.strokes(path), strokeAt("f1", 1, 66)];
		const change = insertAtTop();
		update(b, path, change);
		update(a, path, change);
		expect(stored(path).from).toBe(FROM + 4);
		expect(stored(path).to).toBe(FROM + 11);
		expect(a.target()).toEqual(stored(path));
		expect(b.target()).toEqual(stored(path));
		expect(a.doc().sliceString(stored(path).from, stored(path).to)).toBe("benzene");
		expect(free(path).points).toEqual(freePoints());
	});

	it("control: typing in the focused pane, the other pane told after, moves the target once and leaves free ink", () => {
		const path = "attach-two-panes-typed.md";
		let aFocused = false;
		const { a, b: makeB } = rig(path, () => aFocused);
		const b = makeB();
		aFocused = true;
		(inlineInk.record(path).strokes as InkStroke[]).push(strokeAt("f1", 1, 66));
		const change = insertAtTop();
		update(a, path, change);
		update(b, path, change);
		expect(stored(path).from).toBe(FROM + 4);
		expect(a.target()).toEqual(stored(path));
		expect(b.target()).toEqual(stored(path));
		expect(free(path).points).toEqual(freePoints());
	});

	it("control: a second change of the same length after the first still moves the target", () => {
		// Defect guarded: a change already applied is told by its document, not by its length alone.
		const path = "attach-two-panes-second.md";
		let aFocused = false;
		const { a, b: makeB } = rig(path, () => aFocused);
		const b = makeB();
		aFocused = true;
		const first = insertAtTop();
		update(a, path, first);
		update(b, path, first);
		expect(stored(path).from).toBe(FROM + 4);
		const doc1 = a.doc();
		const second = ChangeSet.of([{ from: 0, to: 4, insert: "" }, { from: doc1.length, insert: "wxyz" }], doc1.length);
		expect(second.apply(doc1).length).toBe(doc1.length);
		update(a, path, second);
		update(b, path, second);
		expect(stored(path).from).toBe(FROM);
		expect(a.target()).toEqual(stored(path));
		expect(b.target()).toEqual(stored(path));
		expect(a.doc().sliceString(stored(path).from, stored(path).to)).toBe("benzene");
	});
});
