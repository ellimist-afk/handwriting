/**
 * Moving an attached group leaves the free-ink raster in place. A line typed above a group's text moves the group and
 * writes its record, but no free stroke changed, so the extent raster of the free ink is still the picture a whole
 * redraw would give and is kept. An Attach or a Detach changes which strokes are free, and a stroke drawn changes the
 * free ink: each still lets the raster go. The real followDocChanged, attachAt, detachAttachment and usableExtent on a
 * bare overlay; the raster is its record only (no canvas), as the build leaves it. followMoved is told, not run: by its
 * own contract it leaves the extent raster untouched.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text, type TransactionSpec } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { inkLookKey } from "./InkOverlayConstants";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 40, LH = 40;
const START = Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`).join("\n");
const CAM = { x: 0, y: 0, zoom: 1 };

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function rig(path: string) {
	const from = START.indexOf("line 10 words");
	const group: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["g1"], target: targetAt(START, from, from + 13, "range"), ref: { x: 0, y: 9 * LH }, layout: { width: 892, font: 26 }, probe: { id: "g1", x: 10, y: 9 * LH + 5 } };
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [group] };
	rec.strokes = [strokeAt("g1", 10, 9 * LH + 1), strokeAt("f1", 10, 20 * LH + 1), strokeAt("f2", 60, 22 * LH + 1)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const state = { doc: Text.of(START.split("\n")) };
	const layout = (): LineLayout => ({ lines: state.doc.lines, lineText: (n) => state.doc.line(n).text, lineTop: (n) => (n - 1) * LH, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	anchors.strokesFor(path, inlineInk.strokes(path));
	const moved: string[] = [];
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin & Record<string, unknown>;
	Object.assign(overlay, {
		lineAnchorState: anchors,
		fontZoom: 1,
		shownMoves: 0,
		shownSteps: Array.from({ length: 16 }, () => ({ step: 0, bound: null })),
		committedBacking: 1,
		dpr: 1,
		highlightPairDeferred: false,
		extentRaster: null,
		extentToStandIn: () => {},
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
		followMoved: (p: string) => moved.push(p),
		currentIndexes: () => [],
		frontierCache: { invalidate: () => {} },
		selection: { size: 0, strokeIds: new Set<string>(), prune: () => {} },
	});
	anchors.follow.setList(inlineInk.attachments(path));
	anchors.follow.attached(group, 9 * LH);
	/** The extent raster as its build leaves it: the free ink now, at this camera. */
	const build = () => {
		const strokes = overlay.freeStrokes(path);
		const ext = { path, cam0: { ...CAM }, backing: 1, dpr: 1, look: inkLookKey(), strokes, count: strokes.length, generation: inlineInk.generation(path), shownMoves: overlay.shownMoves, hl: null };
		overlay.extentRaster = ext as unknown as InkOverlayPlugin["extentRaster"];
		return ext;
	};
	const usable = () => overlay.usableExtent(CAM, overlay.freeStrokes(path));
	const type = (at: number, text: string) => {
		const changes = ChangeSet.of([{ from: at, insert: text }], state.doc.length);
		const startState = { doc: state.doc };
		state.doc = changes.apply(state.doc);
		overlay.followDocChanged(path, { changes, startState, state: { doc: state.doc } } as unknown as ViewUpdate);
	};
	return { overlay, anchors, build, usable, type, moved, doc: () => state.doc.toString(), path };
}

describe("moving an attached group leaves the free-ink raster in place", () => {
	it("a line typed above the group's text: the group moves and its record is written, the raster is kept", () => {
		// Defect: the record's write counts as a change of the note's strokes, so the raster of free ink that did not change
		// is let go and rebuilt piece by piece after every line typed above attached ink.
		const r = rig("attach-move-raster.md");
		const ext = r.build();
		const written = inlineInk.record(r.path).mutationGeneration;
		r.type(r.doc().indexOf("line 5 words"), "\n");
		expect(r.moved, "premise: the group moved").toEqual([r.path]);
		expect(inlineInk.record(r.path).mutationGeneration, "premise: the record was written").toBe(written + 1);
		expect(r.usable()).toBe(ext);
	});

	it("control: an Attach of a free stroke lets the raster go", () => {
		const r = rig("attach-move-raster-attach.md");
		r.build();
		const from = r.doc().indexOf("line 21 words");
		r.overlay.attachAt(r.path, "att-2", ["f1"], targetAt(r.doc(), from, from + 13, "range"), { x: 0, y: 20 * LH });
		expect(inlineInk.attachments(r.path).map((a) => a.id), "premise: attached").toEqual(["att-1", "att-2"]);
		expect(r.usable()).toBeNull();
	});

	it("control: a Detach lets the raster go", () => {
		const r = rig("attach-move-raster-detach.md");
		r.build();
		expect(r.overlay.detachAttachment(r.path, "att-1")).toBe(true);
		expect(r.usable()).toBeNull();
	});

	it("control: a free stroke drawn lets the raster go", () => {
		const r = rig("attach-move-raster-draw.md");
		r.build();
		inlineInk.commit(r.path, strokeAt("f3", 90, 25 * LH + 1));
		expect(r.usable()).toBeNull();
	});
});
