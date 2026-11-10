/**
 * Counter cells for the follow. Each cell counts layout reads, measures asked
 * for or membership rebuilds, never time, so a fix that takes a timed cost to 0 cannot hide one of these defects. Each
 * cell is red with its plant in. A bare follow or a bare overlay: no DOM, no layout.
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

const doc = Text.of(Array.from({ length: 40 }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();

function record(id: string, strokeIds: string[], line: number): AttachmentRecord {
	const word = `line ${line} words`, from = DOC.indexOf(word + "\n");
	return { v: 1, id, strokeIds, target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: strokeIds[0]!, x: 10, y: 100 } };
}

/** n groups on lines 2, 4, 6, ..., one member each. */
const groups = (n: number) => Array.from({ length: n }, (_, i) => record(`att-${i + 1}`, [`s${i + 1}`], 2 * i + 2));

/** A measure view that counts its layout reads; every target is in view and read at `at`. */
function counted(at: { x: number; y: number }) {
	const v = { reads: 0, inView: () => true, refAt: () => { v.reads++; return at; }, blockTop: () => 80 };
	return v;
}

describe("a measure reads only the groups not read in this layout or whose words moved", () => {
	it("C1: a group read in this layout is not read again; a keystroke that moves one group's words reads that one group", () => {
		// Defect: every measure reads every group in view again, each keystroke a layout read per group.
		const anchors = new LineAnchors(() => null), follow = anchors.follow, list = groups(3);
		follow.setList(list);
		const first = counted({ x: 0, y: 80 });
		follow.measure(first);
		expect(first.reads, "premise: the first measure reads the three groups").toBe(3);
		const again = counted({ x: 0, y: 80 });
		follow.measure(again);
		expect(again.reads, "a second measure with nothing changed reads no group").toBe(0);
		// One keystroke above the second group's words: its target moves by one, the others hold.
		const moved = list.map((a, i) => (i === 1 ? { ...a, target: { ...a.target, from: a.target.from + 1, to: a.target.to + 1 } } : a));
		follow.setList(moved);
		const key = counted({ x: 0, y: 80 });
		follow.measure(key);
		expect(key.reads, "the measure after the keystroke reads the one group whose words moved").toBe(1);
	});
});

describe("a measure reads at most eight groups and asks for another", () => {
	it("C2: twelve groups in view: a measure reads eight and asks for another", () => {
		// Defect: one measure reads every pending group in view, a long frame on a fling into many.
		const follow = new LineAnchors(() => null).follow;
		follow.setList(groups(12));
		const v = counted({ x: 0, y: 80 });
		const out = follow.measure(v);
		expect([v.reads, out.more], "eight reads, more left").toEqual([8, true]);
	});
});

describe("a layout change reads every group in view again", () => {
	it("C3: after a layout change the next measure reads every group in view once, and the groups take the new point", () => {
		// Defect: a width change leaves every group at its last read, off its words.
		const follow = new LineAnchors(() => null).follow;
		follow.setList(groups(2));
		follow.measure(counted({ x: 0, y: 80 }));
		follow.layoutChanged();
		const v = counted({ x: 0, y: 92 });
		follow.measure(v);
		expect(v.reads, "both groups read again").toBe(2);
		expect(follow.offsetOf("s1"), "the group shows at the new read").toEqual({ dx: 0, dy: 12 });
	});
});

describe("a width change that moves words sideways moves the group with them, x included", () => {
	it("C4: words read 37 right of the record after a width change: the group shows dx 37", () => {
		// Defect: only dy is applied, so after a width change the ink sits left of its words.
		const follow = new LineAnchors(() => null).follow;
		follow.setList(groups(1));
		follow.measure(counted({ x: 0, y: 80 }));
		expect(follow.offsetOf("s1"), "premise: read at the record's point, no correction").toEqual({ dx: 0, dy: 0 });
		follow.layoutChanged();
		follow.measure(counted({ x: 37, y: 80 }));
		expect(follow.offsetOf("s1"), "the group moves with its words, x included").toEqual({ dx: 37, dy: 0 });
	});
});

describe("a load with groups asks for one measure and leaves no group pending", () => {
	it("C5: the load asks for one measure; it reads the groups in view and none is left pending", () => {
		// Defect: the load reads no layout, so every group stays pending (unpainted) until some
		// unrelated editor update asks for a measure.
		const path = "attach-counters-load.md", list = groups(2);
		const rec = inlineInk.record(path);
		rec.pageId = `page-${path}`;
		rec.basePage = { ...emptyPage(rec.pageId), surface: "inline", attachments: list };
		rec.strokes = [];
		delete (rec as { attachments?: unknown }).attachments;
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin & Record<string, unknown>;
		let asked = 0;
		Object.assign(overlay, { view: { state: { doc } }, lineAnchorState: new LineAnchors(() => null), lineAnchorPassTimer: 1, requestFollowMeasure: () => { asked++; } });
		(overlay as unknown as { lineAnchorInkLoaded(p: string): void }).lineAnchorInkLoaded(path);
		const follow = overlay.lineAnchors.follow, v = counted({ x: 0, y: 80 });
		expect(follow.any, "premise: the load set the groups").toBe(true);
		for (let i = 0; i < asked; i++) follow.measure(v);
		expect([asked, v.reads], "one measure asked for, two layout reads").toEqual([1, 2]);
		expect(list.map((a) => follow.groupOffset(a.id)), "no group pending").toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
	});
});

describe("an erase rebuilds membership only when it cuts a member", () => {
	const READ = { x: 40, y: 92 };
	function line(id: string, x0: number, x1: number, y: number): InkStroke {
		const points = Array.from({ length: (x1 - x0) / 2 + 1 }, (_, i) => ({ x: x0 + i * 2, y, pressure: 0.5, t: i }));
		return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 1), createdAt: 1 };
	}
	function rig(path: string) {
		const rec = inlineInk.record(path);
		rec.pageId = `page-${path}`;
		rec.basePage = { ...emptyPage(rec.pageId), surface: "inline", attachments: [record("att-1", ["s1"], 3)] };
		rec.strokes = [line("s1", 10, 90, 100), line("free", 10, 90, 300)];
		delete (rec as { attachments?: unknown }).attachments;
		Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
		const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
		const anchors = new LineAnchors(layout);
		anchors.setSignature({ width: 892, fontPx: 26, charWidth: 14 });
		anchors.drawn(1, doc.lines);
		anchors.follow.setList(inlineInk.attachments(path));
		anchors.follow.measure({ inView: () => true, refAt: () => READ, blockTop: () => 80 });
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin & Record<string, unknown>;
		const index = new StrokeIndex();
		Object.assign(overlay, {
			lineAnchorState: anchors, filePath: () => path, scale: 1, mode: "erase", eraseWhole: false, erased: [], erasePieces: new Set<string>(),
			strokeIndex: index, indexDirty: true, currentIndexes: () => [index], damage: { addRect: () => {}, addAll: () => {} },
			scheduleRepaint: () => {}, repaintPath: () => {}, camera: { screenToWorld: (x: number, y: number) => ({ x, y }) },
		});
		/** One erase sample; the membership rebuilds it caused (a rebuild gives a new member map, read without side effect). */
		const erase = (x: number, y: number) => {
			const before = anchors.follow.memberMap;
			(overlay as unknown as { eraseAt(s: unknown): void }).eraseAt({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
			return anchors.follow.memberMap === before ? 0 : 1;
		};
		return { erase, ids: () => inlineInk.strokes(path).map((s) => s.id) };
	}

	it("C6: cutting free ink rebuilds no membership; cutting a member rebuilds it once", () => {
		// Defect: every erase sample rebuilds the stroke-to-group map over every record.
		const r = rig("attach-counters-erase.md");
		expect(r.erase(50, 300), "a cut through free ink").toBe(0);
		expect(r.ids().filter((id) => id !== "s1" && id !== "free").length, "premise: the ring split the free line").toBe(2);
		expect(r.erase(50 + READ.x, 100 + READ.y - 80), "a cut through the member, where its group shows it").toBe(1);
	});
});
