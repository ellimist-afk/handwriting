/**
 * A RESIZED STROKE REOPENS AT THE WIDTH IT LANDED AT.
 *
 * Defect (TF-14): a corner pull scales each selected stroke's width with the ink and has no absolute floor or ceiling. The
 * save rounds a width to 3 places and the reader puts back 2.2 for a width not above 0 or over MAX_WIDTH (1000). A highlighter
 * dash of width 16 pulled out to 70 times lands at 1120 and reopens as a 2.2 line; a thin stroke at 0.004 shrunk to the 0.1
 * floor lands at 0.0004, saves 0, and reopens as a 2.2 blob.
 *
 * The bar, through the real lift: (1) the lift lands the width the preview showed, the original width times the step's scale
 * (no jump at the lift); (2) the page saved and parsed again gives each stroke the width it landed at, within the save's
 * rounding, and inside the reader's range (above 0, at or under MAX_WIDTH). The control: a 2 times pull of a width 16 stroke
 * keeps 32 through the reload.
 *
 * The rig is InkOverlayLassoTransform.test.ts's: a bare overlay with the real selection model, the real line anchors and a
 * fake view; no DOM, no layout read, no paint. The save is the real serializePage and parsePage.
 */
import { describe, expect, it } from "vitest";
import { Text, type TransactionSpec } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage, MAX_WIDTH, parsePage, serializePage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { SelectionModel } from "../objects/SelectionModel";
import { handlePoints } from "./LassoTransform";
import type { PenSample } from "../input/PointerRouter";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 40;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));

function strokeAt(id: string, x: number, y: number, width: number, tool: "pen" | "highlighter"): InkStroke {
	// Mixed segment lengths, so no axis can agree by accident.
	const points = [0, 3, 10, 22, 31].map((d, i) => ({ x: x + d, y: y + 4 + (i % 2) * 7, pressure: 0.5, t: i * 8 }));
	return { id, tool, color: "#111", width, points, bbox: computeBBox(points, width * 2), createdAt: 1 };
}

const sample = (p: { x: number; y: number }): PenSample => ({ x: p.x, y: p.y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

function rig(path: string, stroke: InkStroke) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	rec.strokes = [stroke];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	anchors.follow.setList(inlineInk.attachments(path));
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
				const line = doc.line(Math.max(1, Math.min(LINES, Math.floor(h / 40) + 1)));
				return { from: line.from, to: line.to, top: (line.number - 1) * 40, bottom: line.number * 40 };
			},
			requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
			dispatch: (spec: TransactionSpec) => sent.push(spec),
		},
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 } },
		committedBacking: 1,
		scale: 1,
		cssScale: 1,
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
	});
	/** Grab the se corner, one sample at `factor` times the handle's offset from the ink box's nw corner (the pivot), lift. */
	const pull = (factor: number) => {
		selection.selectExactly([stroke.id]);
		const box = overlay.selectionBounds()!;
		const at = handlePoints(box, 1).se;
		overlay.lassoDown(sample(at), "pen");
		const g = overlay.spaceSnapshot?.transform?.gesture;
		overlay.lassoMove([sample({ x: box.x + (at.x - box.x) * factor, y: box.y + (at.y - box.y) * factor })], false);
		const scale = g ? g.accepted.scale : null;
		overlay.lassoUp();
		return scale;
	};
	const landed = () => inlineInk.strokes(path).find((s) => s.id === stroke.id)!;
	const reopened = () => {
		const page = { ...emptyPage("p"), strokes: inlineInk.strokes(path).map((s) => ({ ...s })) };
		return parsePage(serializePage(page), "p").data.strokes.find((s) => s.id === stroke.id)!;
	};
	return { sent, pull, landed, reopened };
}

function check(path: string, stroke: InkStroke, factor: number) {
	// The lift rewrites the stroke object in place, so the width before is read now.
	const before = stroke.width;
	const { pull, landed, reopened } = rig(path, stroke);
	const scale = pull(factor);
	expect(scale, "the grab started a transform").not.toBeNull();
	const w = landed().width;
	expect(w, "the lift lands the width the preview showed").toBeCloseTo(before * scale!, 9);
	const back = reopened().width;
	expect(back, "reopened width inside the reader's range").toBeGreaterThan(0);
	expect(back, "reopened width inside the reader's range").toBeLessThanOrEqual(MAX_WIDTH);
	expect(Math.abs(back - w), `reopened at ${back}, landed at ${w}: the look changed on reload`).toBeLessThanOrEqual(0.0005);
}

describe("a resized stroke's width through a save and a reopen", () => {
	it("a width 16 highlighter pulled out 70 times reopens at the width it landed at", () => {
		check("width-reload-grow.md", strokeAt("dash", 20, 85, 16, "highlighter"), 70);
	});

	it("a width 0.004 pen shrunk to the 0.1 floor reopens at the width it landed at", () => {
		check("width-reload-shrink.md", strokeAt("thin", 20, 85, 0.004, "pen"), 0.02);
	});

	it("control: a width 16 highlighter pulled out 2 times reopens at 32", () => {
		check("width-reload-control.md", strokeAt("dash", 20, 85, 16, "highlighter"), 2);
	});
});
