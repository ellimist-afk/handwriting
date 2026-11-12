/**
 * Attach with the selection drawn below the last text line. The layout clamps a height below the last line to that line,
 * so the selection's centre must also sit inside the block it lands on, as the attach pick checks it. Ink drawn under
 * all the text does not attach to the last paragraph. A selection on the last line still attaches. Bare overlay, fake
 * layout, no DOM.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { SelectionModel } from "../objects/SelectionModel";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const LINES = ["Intro line with many more words so the context ends here.", "The word benzene here.", "Last line."];
const DOC = LINES.join("\n");
const LH = 30;

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** A note of three lines, the last one ending at the document's end; the selection box is in note px. */
function rig(path: string, box: { x: number; y: number; width: number; height: number }) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	rec.strokes = [strokeAt("s1", 10, 36)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const doc = Text.of(LINES);
	// As CodeMirror's layout reads it: a height below the last line lands on the last line.
	const lineBlockAtHeight = (h: number) => {
		const n = Math.min(LINES.length, Math.max(1, Math.floor(h / LH) + 1));
		const line = doc.line(n);
		return { from: line.from, to: line.to, top: (n - 1) * LH, bottom: n * LH };
	};
	const lineBlockAt = (pos: number) => lineBlockAtHeight(LH * (doc.lineAt(pos).number - 1));
	const view = { scaleY: 1, defaultLineHeight: LH, state: { doc }, lineBlockAtHeight, lineBlockAt, requestMeasure() {} };
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const anchors = new LineAnchors(() => null, () => false);
	anchors.sig = { width: 600, fontPx: 16, charWidth: 8 };
	const selection = new SelectionModel();
	selection.selectExactly(["s1"]);
	Object.assign(overlay, {
		view, fontZoom: 1, lineAnchorState: anchors, selection, filePath: () => path, selectionBounds: () => box,
	});
	anchors.tracks(path, inlineInk.strokes(path));
	return overlay;
}

describe("attach with the selection below the last text line", () => {
	it("a selection whose centre is below the last block does not attach", () => {
		// Defect: the layout clamps the height to the last line, and the attach takes that line as the target.
		const path = "attach-below-last-block.md";
		// The box runs 160..180: 70 under the last line, past the two-line reach (60).
		const overlay = rig(path, { x: 10, y: 160, width: 40, height: 20 });
		expect(overlay.attachSelected()).toBe(false);
	});

	it("a selection whose centre is above the first block does not attach", () => {
		// The layout clamps a height above the first line to that line, as it clamps one below the last.
		const path = "attach-above-first-block.md";
		// The box runs -100..-80: 80 over the first line, past the two-line reach (60).
		const overlay = rig(path, { x: 10, y: -100, width: 40, height: 20 });
		expect(overlay.attachSelected()).toBe(false);
	});

	it("control: a selection on the last line still attaches", () => {
		const path = "attach-on-last-line.md";
		const overlay = rig(path, { x: 10, y: 65, width: 40, height: 20 });
		expect(overlay.attachSelected()).toBe(true);
	});
});
