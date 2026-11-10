/**
 * Re-attaching a group tagged "Needs reattachment" takes effect at once: the group follows its new text from the Attach
 * on, its tag goes, and a line typed above the new text moves it, with no reopen or later status in between. The real
 * attachAt on a bare overlay over a fake view whose line tops follow its document; no DOM.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text, type TransactionSpec } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord, type AttachmentStatus } from "./InkAttachments";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 40, LH = 40;
const START = Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`).join("\n");

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function rig(path: string) {
	const from = START.indexOf("line 3 words");
	const old: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(START, from, from + 12, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: "s1", x: 10, y: 89 } };
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [old] };
	rec.strokes = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const state = { doc: Text.of(START.split("\n")) };
	const layout = (): LineLayout => ({ lines: state.doc.lines, lineText: (n) => state.doc.line(n).text, lineTop: (n) => (n - 1) * LH, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	anchors.strokesFor(path, inlineInk.strokes(path));
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors,
		fontZoom: 1,
		view: {
			scaleY: 1,
			state,
			lineBlockAt: (pos: number) => ({ top: (state.doc.lineAt(pos).number - 1) * LH, bottom: state.doc.lineAt(pos).number * LH }),
			dispatch: (_spec: TransactionSpec) => {},
		},
		filePath: () => path,
		endLiveGestureForHistory: () => {},
		scheduleRepaint: () => {},
		repaintPath: () => {},
		redrawSelectionUI: () => {},
		lineAnchorsMoved: () => {},
		followMoved: () => {},
		currentIndexes: () => [],
		frontierCache: { invalidate: () => {} },
		selection: { size: 0, strokeIds: new Set<string>(), prune: () => {} },
	});
	const type = (at: number, text: string) => {
		const changes = ChangeSet.of([{ from: at, insert: text }], state.doc.length);
		const startState = { doc: state.doc };
		state.doc = changes.apply(state.doc);
		overlay.followDocChanged(path, { changes, startState, state: { doc: state.doc } } as unknown as ViewUpdate);
	};
	return { overlay, anchors, old, type, doc: () => state.doc.toString() };
}

describe("re-attaching a group tagged Needs reattachment takes effect at once", () => {
	it("Attach to new text: the tag goes, and a line typed above the new text moves the group by that line", () => {
		// Defect: the group stays held as needing reattachment after the Attach: it shows the tag and typing does not move it,
		// until a later load or status hands the follow a new state.
		const path = "attach-reattach-now.md";
		const { overlay, anchors, old, type, doc } = rig(path);
		anchors.follow.setList([old], new Map<string, AttachmentStatus>([["att-1", "needs-reattachment"]]));
		expect(anchors.follow.followsText("att-1"), "premise: tagged").toBe(false);
		const from = doc().indexOf("line 10 words");
		overlay.attachAt(path, "att-1", ["s1", "s2"], targetAt(doc(), from, from + 13, "range"), { x: 0, y: 9 * LH });
		expect(anchors.follow.followsText("att-1"), "followed, no tag").toBe(true);
		const before = anchors.follow.groupOffset("att-1");
		expect(before).not.toBeNull();
		type(doc().indexOf("line 5 words"), "a new line\n");
		const after = anchors.follow.groupOffset("att-1");
		expect(after!.dy - before!.dy).toBeCloseTo(LH, 9);
		expect(after!.dx - before!.dx).toBeCloseTo(0, 9);
	});

	it("control: a tagged group not attached again keeps its tag, and typing above it moves nothing", () => {
		const path = "attach-reattach-control.md";
		const { anchors, old, type, doc } = rig(path);
		anchors.follow.setList([old], new Map<string, AttachmentStatus>([["att-1", "needs-reattachment"]]));
		const before = anchors.follow.groupOffset("att-1");
		type(doc().indexOf("line 2 words"), "a new line\n");
		expect(anchors.follow.followsText("att-1")).toBe(false);
		expect(anchors.follow.groupOffset("att-1")).toEqual(before);
	});
});
