/**
 * Ink attached to text through the overlay's editor update: a document change moves an
 * attached group by its line block's top delta read from the height map, writes the mapped list to the store as a real
 * edit and repaints; typing below it changes nothing and writes nothing. A bare overlay, a fake view: no DOM, no layout read.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const DOC = "Intro line.\nThe word benzene here.\nLast line.\n";
const LH = 30;

function rig(path: string) {
	const record: AttachmentRecord = (() => {
		const from = DOC.indexOf("benzene");
		return { v: 1, id: "att-1", strokeIds: ["s1"], target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: LH }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 1, y: 40 } };
	})();
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [record] };
	const writes: number[] = [];
	Object.defineProperty(inlineInk, "persist", { value: () => writes.push(1), configurable: true });
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const state = { doc: Text.of(DOC.split("\n")) };
	const view = { scaleY: 1, lineBlockAt: (pos: number) => ({ top: state.doc.lineAt(pos).number * LH - LH, bottom: state.doc.lineAt(pos).number * LH }) };
	const moved: string[] = [];
	Object.assign(overlay, { view, fontZoom: 1, lineAnchorState: new LineAnchors(() => null), lineAnchorsMoved: (p: string) => moved.push(p) });
	overlay.lineAnchors.follow.setList(inlineInk.attachments(path));
	overlay.lineAnchors.follow.attached(record, LH);
	const change = (pos: number, text: string) => {
		const changes = ChangeSet.of([{ from: pos, insert: text }], state.doc.length);
		state.doc = changes.apply(state.doc);
		overlay.followDocChanged(path, { changes } as unknown as ViewUpdate);
	};
	return { overlay, writes, moved, change };
}

describe("attached ink through the overlay's editor update", () => {
	it("two lines typed above move the group two lines, write the mapped list as a real edit and repaint", () => {
		// Defect: the overlay never feeds the follow a document change, so attached ink stays while its words move down.
		const path = "attach-overlay-above.md";
		const { overlay, writes, moved, change } = rig(path);
		change(0, "a\nb\n");
		expect(overlay.lineAnchors.follow.offsetOf("s1")).toEqual({ dx: 0, dy: 2 * LH });
		expect((inlineInk.attachments(path)[0] as AttachmentRecord).target.from).toBe(DOC.indexOf("benzene") + 4);
		expect(writes).toHaveLength(1);
		expect(moved).toEqual([path]);
	});

	it("typing below the group moves nothing, writes nothing and repaints nothing", () => {
		// Defect: every keystroke writes the sidecar or repaints the whole note.
		const path = "attach-overlay-below.md";
		const { overlay, writes, moved, change } = rig(path);
		change(DOC.length, "more");
		expect(overlay.lineAnchors.follow.offsetOf("s1")).toEqual({ dx: 0, dy: 0 });
		expect(writes).toHaveLength(0);
		expect(moved).toHaveLength(0);
	});
});

describe("a follow move while the index waits for its rebuild (row 1 counters)", () => {
	const strokeAt = (id: string, x: number, y: number): InkStroke => {
		const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
		return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
	};
	const view = (y: number) => ({ inView: () => true, refAt: () => ({ x: 0, y }), blockTop: () => y - 80 });

	function moveRig(indexDirty: boolean) {
		const from = DOC.indexOf("benzene");
		const record: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: 80 }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 10, y: 89 } };
		const anchors = new LineAnchors(() => null);
		const follow = anchors.follow;
		follow.setList([record]);
		follow.attached(record, 80);
		for (const s of [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90)]) follow.shown(s);
		const calls: string[] = [];
		const rects: { y: number; height: number }[][] = [];
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		Object.assign(overlay, {
			lineAnchorState: anchors, indexDirty,
			attachedLayer: { stillAt: () => true, moved: (r: { y: number; height: number }[]) => { calls.push("moved"); rects.push(r); }, invalidate: (why: string) => calls.push("invalidate:" + why) },
			strokeIndex: { remove: () => calls.push("remove"), insertLike: () => calls.push("insert"), replaceMoved: () => calls.push("replace") },
			camera: { snapshot: { x: 0, y: 0, zoom: 1 } },
			frontierCache: { invalidate: () => {} },
			scheduleRepaint: () => {},
			lineAnchorsMoved: () => calls.push("membership"),
		});
		const before = follow.snapshot();
		follow.layoutChanged();
		follow.measure(view(120));
		overlay.followMoved("attach-overlay-dirty.md", before);
		return { calls, rects, overlay };
	}

	it("an index waiting for its rebuild still hands the layer the swept rectangles: no whole paint, no index edit", () => {
		// Defect: a note just opened leaves the index dirty, every new line above a group takes the fallback, and the
		// attached layer paints whole on each line move (row 1 at f8f6bd0d: 5 layer paints, all whole, 0 index rebuilds).
		const { calls, rects, overlay } = moveRig(true);
		expect(calls).toEqual(["moved"]);
		// The swept rectangle reaches from the members' old top (85 + 4, padded) past their new bottom, 40 lower.
		expect(rects[0]).toHaveLength(1);
		expect(rects[0]![0]!.y).toBeLessThan(89);
		expect(rects[0]![0]!.y + rects[0]![0]!.height).toBeGreaterThan(40 + 90 + 4);
		expect(overlay.indexDirty, "the rebuild is still owed").toBe(true);
	});

	it("a built index takes each member from its old place to its new one, then the rectangles", () => {
		// Defect: the skip for a dirty index also skips a built one, and lasso and eraser hit the members where they were.
		// One replaceMoved per member (StrokeIndex X1 holds it to remove and insertLike).
		const { calls, overlay } = moveRig(false);
		expect(calls).toEqual(["replace", "replace", "moved"]);
		expect(overlay.indexDirty).toBe(false);
	});
});
