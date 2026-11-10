/**
 * Undoing a second erase over an attached piece keeps the piece in its group. A piece made by one erase gesture and cut
 * again by the next is in the first gesture's history step, so the second gesture's undo puts it back as a member, shown
 * with its group, not as free ink. Within one gesture a piece cut again still leaves the group (a long drag lists no
 * intermediate piece). The real eraseAt on a bare overlay, pen-up as it clears the gesture; no DOM.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { StrokeIndex } from "../ink/StrokeIndex";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const doc = Text.of(Array.from({ length: 40 }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();
/** The group is read 40 right and 12 down of its record: a wrong return shows as a jump in x and y. */
const READ = { x: 40, y: 92 };

function line(id: string, x0: number, x1: number, y: number): InkStroke {
	const points = Array.from({ length: (x1 - x0) / 2 + 1 }, (_, i) => ({ x: x0 + i * 2, y, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 1), createdAt: 1 };
}

function rig(path: string) {
	const from = DOC.indexOf("line 3 words");
	const group: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1"], target: targetAt(DOC, from, from + 12, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: "s1", x: 10, y: 100 } };
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), surface: "inline", attachments: [group] };
	rec.strokes = [line("s1", 10, 130, 100)];
	delete (rec as { attachments?: unknown }).attachments;
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, doc.lines);
	anchors.follow.setList(inlineInk.attachments(path));
	anchors.follow.measure({ inView: () => true, refAt: () => READ, blockTop: () => 80 });
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin & Record<string, unknown>;
	const index = new StrokeIndex();
	Object.assign(overlay, {
		lineAnchorState: anchors, filePath: () => path, scale: 1, mode: "erase", eraseWhole: false, erased: [], eraseFrom: [], erasePieces: new Set<string>(),
		strokeIndex: index, indexDirty: true, currentIndexes: () => [index], damage: { addRect: () => {}, addAll: () => {} },
		scheduleRepaint: () => {}, repaintPath: () => {}, camera: { screenToWorld: (x: number, y: number) => ({ x, y }) },
	});
	const ids = () => inlineInk.strokes(path).map((s) => s.id);
	/** One erase gesture at stored x: the ring where the group shows that point. Returns the gesture's history step. */
	const gesture = (x: number) => {
		const before = new Set(ids());
		(overlay as unknown as { eraseAt(s: unknown): void }).eraseAt({ x: x + READ.x, y: 100 + READ.y - 80, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
		const erased = (overlay.erased as Array<{ stroke: InkStroke; index: number }>).slice();
		const pieces = inlineInk.strokes(path).filter((s) => !before.has(s.id));
		// Pen-up, as InkOverlayPenPath clears the gesture.
		overlay.erased = [];
		overlay.eraseFrom = [];
		(overlay.erasePieces as Set<string>).clear();
		return { erased, pieces };
	};
	/** The gesture's replace op undone: its pieces out, what it erased back where it was. */
	const undo = (step: { erased: Array<{ stroke: InkStroke; index: number }>; pieces: InkStroke[] }) => {
		inlineInk.takeLive(path, step.pieces.map((p) => p.id));
		inlineInk.applyAddLive(path, step.erased.map((e) => e.stroke), step.erased.map((e) => e.index));
	};
	const shown = () => {
		anchors.follow.setList(inlineInk.attachments(path));
		return new Map(anchors.strokesFor(path, inlineInk.strokes(path)).map((s) => [s.id, s] as const));
	};
	const members = () => (inlineInk.attachments(path).find((a) => a.id === "att-1") as AttachmentRecord).strokeIds;
	return { gesture, undo, shown, members, anchors };
}

describe("undoing a second erase over an attached piece keeps the piece in its group", () => {
	it("erase cuts the member in two, a second erase cuts the left piece, undo of the second: the piece is a member, shown with its group", () => {
		// Defect: the second gesture drops the piece from its group because some earlier gesture made it, so its undo brings
		// the piece back as free ink, shown 40 left and 12 up of the group.
		const path = "attach-erase-twice.md";
		const r = rig(path);
		const first = r.gesture(90);
		expect(first.pieces.length, "premise: the ring cut s1 in two").toBe(2);
		const p1 = [...first.pieces].sort((a, b) => a.points[0]!.x - b.points[0]!.x)[0]!;
		const second = r.gesture(40);
		expect(second.erased.map((e) => e.stroke.id), "premise: the second gesture cut the left piece").toEqual([p1.id]);
		r.undo(second);
		expect(r.members()).toContain(p1.id);
		expect(r.anchors.follow.groupOf(p1.id)).toBe("att-1");
		const p = r.shown().get(p1.id)!.points[0]!;
		expect(p.x).toBeCloseTo(p1.points[0]!.x + READ.x, 9);
		expect(p.y).toBeCloseTo(p1.points[0]!.y + READ.y - 80, 9);
	});

	it("control: undo of the first erase alone puts the member back in its group", () => {
		const path = "attach-erase-once.md";
		const r = rig(path);
		const first = r.gesture(90);
		r.undo(first);
		expect(r.members()).toContain("s1");
		const p = r.shown().get("s1")!.points[0]!;
		expect(p.x).toBeCloseTo(10 + READ.x, 9);
	});
});
