/**
 * The attach step through the overlay's undo and redo: applied only where the step left the
 * group and written as a real edit; a spent step changes and writes nothing; a detach re-takes its members where they are
 * shown. A bare overlay: no DOM.
 */
import { describe, expect, it } from "vitest";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { emptyPage } from "../model/PageData";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import type { InkOp } from "./InkHistory";
import { LineAnchors } from "./LineAnchor";
import { computeBBox } from "../ink/Stroke";

const DOC = "Intro line.\nThe word benzene here.\n";

function rig(path: string) {
	const from = DOC.indexOf("benzene");
	const record: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: 30 }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 1, y: 40 } };
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = emptyPage(rec.pageId);
	rec.strokes = ["s1", "s2"].map((id, i) => {
		const points = [0, 1].map((k) => ({ x: 1 + i * 10 + k, y: 40, pressure: 0.5, t: k }));
		return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
	});
	const writes: number[] = [];
	Object.defineProperty(inlineInk, "persist", { value: () => writes.push(1), configurable: true });
	const retaken: string[][] = [];
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		endLiveGestureForHistory: () => {},
		filePath: () => null,
		scheduleRepaint: () => {},
		repaintPath: () => {},
		retakeLineAnchors: (_: string, ids: readonly string[]) => retaken.push([...ids]),
	});
	const op = (before: AttachmentRecord | null, after: AttachmentRecord | null): InkOp => ({ type: "attach", path, id: "att-1", before, after });
	return { overlay, record, writes, retaken, op, path };
}

describe("the attach step through undo and redo", () => {
	it("applies where the step left the group and writes once; the same step again is spent and writes nothing", () => {
		// Defect: the step is ignored (Attach never undoes or redoes), or applied over a record another pane changed.
		const { overlay, record, writes, op, path } = rig("attach-op-apply.md");
		overlay.applyInkOp(op(null, record));
		expect(inlineInk.attachments(path)).toEqual([record]);
		expect(writes).toHaveLength(1);
		overlay.applyInkOp(op(null, record));
		expect(inlineInk.attachments(path)).toEqual([record]);
		expect(writes).toHaveLength(1);
	});

	it("a detach removes the record and re-takes its members where they are shown", () => {
		// Defect: a detach drops the group and leaves members with no anchor this surface honours, so they jump.
		const { overlay, record, writes, retaken, op, path } = rig("attach-op-detach.md");
		overlay.applyInkOp(op(null, record));
		overlay.applyInkOp(op(record, null));
		expect(inlineInk.attachments(path)).toEqual([]);
		expect(writes).toHaveLength(2);
		expect(retaken, "each applied step re-takes its members").toEqual([["s1", "s2"], ["s1", "s2"]]);
	});

	it("a redo of an attach on the pane showing the note paints the group on the first frame, not pending", () => {
		// Defect: the redone group has no reference point until the next measure and blinks out for a frame.
		const { overlay, record, op, path } = rig("attach-op-redo.md");
		Object.assign(overlay, {
			filePath: () => path,
			view: { lineBlockAt: () => ({ top: 30, bottom: 60 }), state: { doc: { length: DOC.length } } },
			lineAnchorState: new LineAnchors(() => null),
			selection: { size: 0, prune: () => {} },
		});
		overlay.applyInkOp(op(null, record));
		expect(overlay.lineAnchors.follow.offsetOf("s1")).toEqual({ dx: 0, dy: 0 });
	});
});
