/**
 * Attach and the follow read at a resting zoom other than 1, as a reader with the editor zoomed has it.
 * At any resting zoom the words' place is still read: Attach makes its record, and a group pending after load is read and
 * shown after one measure. Each cell runs at 1 (the control) and at 1.5 (the zoomed case). The real followRefAt on a bare
 * overlay, a fake view whose coordsAtPos reports the words' place scaled by the zoom, as the zoomed editor shows it.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { SelectionModel } from "../objects/SelectionModel";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 20;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();
const word = "line 3 words";

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function record(): AttachmentRecord {
	const from = DOC.indexOf(word);
	return { v: 1, id: "att-1", strokeIds: ["s1"], target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: "s1", x: 10, y: 89 } };
}

/**
 * A bare overlay at a resting zoom `zoom`: the editor shows each line 40 world high from 0, its first character at world
 * x 0, and coordsAtPos reports that place in screen px, scaled by the zoom, as the zoomed column shows it.
 */
function rig(path: string, zoom: number, attached: boolean, pinchPreview = false) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: attached ? [record()] : [] };
	rec.strokes = [strokeAt("s1", 10, 85), strokeAt("free", 10, 205)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	const reads: string[] = [];
	const sent: unknown[] = [];
	const selection = new SelectionModel();
	const noop = () => {};
	const view = {
		scaleY: 1,
		state: { doc },
		viewport: { from: 0, to: doc.length },
		lineBlockAt: (pos: number) => {
			const n = doc.lineAt(pos).number;
			return { top: (n - 1) * 40, bottom: n * 40 };
		},
		lineBlockAtHeight: (h: number) => {
			const line = doc.line(Math.max(1, Math.min(LINES, Math.floor(h / 40) + 1)));
			return { from: line.from, to: line.to, top: (line.number - 1) * 40, bottom: line.number * 40 };
		},
		coordsAtPos: (pos: number) => {
			reads.push("coords");
			const top = (doc.lineAt(pos).number - 1) * 40 * zoom;
			return { left: 0, right: 0, top, bottom: top + 40 * zoom };
		},
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
		dispatch: (spec: unknown) => sent.push(spec),
		hasFocus: true,
		focus: noop,
		// The overlay reaches its window through winRef, over the view's document: the ink load's box read asks it for a
		// frame, which never comes here.
		dom: { isConnected: true, ownerDocument: { defaultView: { requestAnimationFrame: () => 1, cancelAnimationFrame: noop } } },
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors,
		view,
		container: { getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 900, width: 900, height: 900 }) },
		inkInputPanX: () => 0,
		inkInputPanY: () => 0,
		pinchScaleNow: zoom,
		pinchRefScale: null,
		pinchPreview,
		cssScale: zoom,
		scale: zoom,
		fontZoom: 1,
		camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) },
		filePath: () => path,
		strokesHere: () => anchors.strokesFor(path, inlineInk.strokes(path)),
		endLiveGestureForHistory: noop,
		scheduleRepaint: noop,
		repaintPath: noop,
		redrawSelectionUI: noop,
		lineAnchorsMoved: noop,
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
	return { overlay, anchors, reads, sent, selection };
}

describe.each([1, 1.5])("Attach and the follow read at a resting zoom of %s", (zoom) => {
	it("Attach on free ink makes its record after the measure", async () => {
		// Defect: the words' place is refused at any resting zoom but 1, so the measure's write gets no point and
		// Attach does nothing: no record, no step.
		const path = `attach-zoom-${zoom}.md`;
		const { overlay, selection } = rig(path, zoom, false);
		selection.selectExactly(["free"]);
		expect(overlay.attachSelected()).toBe(true);
		await Promise.resolve();
		const made = inlineInk.attachments(path);
		expect(made, "Attach made one record").toHaveLength(1);
		expect((made[0] as AttachmentRecord).strokeIds).toEqual(["free"]);
	});

	it("a group pending after load is read and shown after one measure", () => {
		// Defect: the follow read refuses at any resting zoom but 1, so a group pending after load is never read and
		// its ink is never shown.
		const path = `attach-zoom-load-${zoom}.md`;
		const { overlay, anchors, reads } = rig(path, zoom, true);
		overlay.lineAnchorInkLoaded(path);
		expect(reads.length, "the measure read the words' place").toBeGreaterThan(0);
		expect(anchors.follow.groupOffset("att-1"), "read: shown, not pending").not.toBeNull();
	});
});

describe("a live pinch preview still owns the viewport", () => {
	it("at 1.5 with the preview live, Attach reads nothing and makes no record", async () => {
		// Defect: the words' place read while the preview's transform is on the raster lands the record at a preview frame's
		// layout, not the resting one.
		const path = "attach-zoom-preview.md";
		const { overlay, selection, reads } = rig(path, 1.5, false, true);
		selection.selectExactly(["free"]);
		overlay.attachSelected();
		await Promise.resolve();
		expect(reads, "no layout read while the preview is live").toEqual([]);
		expect(inlineInk.attachments(path), "no record").toHaveLength(0);
	});
});
