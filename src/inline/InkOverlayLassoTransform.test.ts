/**
 * The lasso's resize and rotate on the note surface, through the overlay: the grab on a handle, the step, the lift, its one
 * history step and that step's undo and redo, on free ink and on ink attached to text. A bare overlay with the real selection
 * model, the real line anchors and a fake view: no DOM, no layout read, no paint.
 */
import { describe, expect, it } from "vitest";
import { Text, type TransactionSpec } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage, type TextBoxData } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { SelectionModel } from "../objects/SelectionModel";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import { invertInkOp, type InkOp } from "./InkHistory";
import { handlePoints, transformPoint, type TransformParams } from "./LassoTransform";
import type { PenSample } from "../input/PointerRouter";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 40;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();
const word = "line 3 words";
/** The group is read 6 right and 12 down of its record. */
const READ = { x: 6, y: 92 };

function strokeAt(id: string, x: number, y: number, tool: "pen" | "highlighter" = "pen"): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool, color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function record(): AttachmentRecord {
	const from = DOC.indexOf(word);
	return { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: "s1", x: 10, y: 89 } };
}

const sample = (p: { x: number; y: number }): PenSample => ({ x: p.x, y: p.y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

function rig(path: string, attached = true, cssScale = 1) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: attached ? [record()] : [] };
	rec.strokes = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90), strokeAt("free", 10, 205)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	anchors.follow.setList(inlineInk.attachments(path));
	anchors.follow.measure({ inView: () => true, refAt: () => READ, blockTop: () => 80 });
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
				const line = doc.line(Math.min(LINES, Math.floor(h / 40) + 1));
				return { from: line.from, to: line.to, top: (line.number - 1) * 40, bottom: line.number * 40 };
			},
			requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
			dispatch: (spec: TransactionSpec) => sent.push(spec),
		},
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 } },
		scale: cssScale,
		cssScale,
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
	const shown = () => {
		anchors.follow.setList(inlineInk.attachments(path));
		return anchors.strokesFor(path, inlineInk.strokes(path)).map((s) => ({ id: s.id, points: s.points.map((p) => ({ x: p.x, y: p.y })) }));
	};
	const stored = () => inlineInk.strokes(path).map((s) => ({ id: s.id, width: s.width, points: s.points.map((p) => ({ ...p })) }));
	/** Grab the handle `handle` of the selection `ids`, move the pen to `to(handle centre, box)`, lift. */
	const gesture = (ids: string[], handle: "se" | "rotate", to: (at: { x: number; y: number }) => { x: number; y: number }, input: "pen" | "touch" = "pen") => {
		selection.selectExactly(ids);
		const box = overlay.selectionBounds()!;
		const at = handlePoints(box, 1)[handle];
		overlay.lassoDown(sample(at), input);
		const t = overlay.spaceSnapshot?.transform?.gesture;
		overlay.lassoMove([sample(to(at))], false);
		const accepted = t ? { ...t.accepted } : null;
		overlay.lassoUp();
		return { box, accepted };
	};
	return { overlay, anchors, sent, shown, stored, gesture, selection, path };
}

const ops = (spec: TransactionSpec): InkOp[] => [spec.effects ?? []].flat().map((e) => (e as { value: InkOp }).value);
const apply = (overlay: InkOverlayPlugin, list: InkOp[]) => {
	for (const op of list) overlay.applyInkOp(op, false);
};
/** The pivot of a pull on the se corner: the ink box's nw corner as selected before the grab, not the nw handle. */
const nwOf = (overlay: InkOverlayPlugin) => { const b = overlay.selectionBounds()!; return { x: b.x, y: b.y }; };
const half = (at: { x: number; y: number }, pivot: { x: number; y: number }, k: number) => ({ x: pivot.x + (at.x - pivot.x) * k, y: pivot.y + (at.y - pivot.y) * k });
/** Each selected stroke's shown points after, against the preview's matrix applied to its shown points before. */
const landsWherePreviewed = (before: ReturnType<ReturnType<typeof rig>["shown"]>, after: ReturnType<ReturnType<typeof rig>["shown"]>, ids: string[], t: TransformParams) => {
	for (const id of ids) {
		const was = before.find((s) => s.id === id)!, now = after.find((s) => s.id === id)!;
		now.points.forEach((p, i) => {
			const want = transformPoint(was.points[i]!, t);
			expect(p.x, `${id} point ${i} x`).toBeCloseTo(want.x, 9);
			expect(p.y, `${id} point ${i} y`).toBeCloseTo(want.y, 9);
		});
	}
};

describe("a resize or rotate of free ink", () => {
	it("a corner pull lands where the preview showed it and records one transform step", () => {
		// Defect: the handle is not grabbed (the box moves instead), or the lift lands somewhere the preview did not show.
		const { overlay, shown, gesture, sent } = rig("transform-free.md", false);
		const before = shown();
		const { accepted } = gesture(["free"], "se", (at) => half(at, nwOf(overlay), 1.5));
		expect(accepted, "the grab started a transform").not.toBeNull();
		expect(accepted!.scale).toBeCloseTo(1.5, 9);
		landsWherePreviewed(before, shown(), ["free"], accepted!);
		expect(sent).toHaveLength(1);
		expect(ops(sent[0]!).map((op) => op.type)).toEqual(["transform"]);
	});

	it("one undo puts the points and widths back byte-equal; redo gives the after copy", () => {
		// Defect: the undo inverts the turn in floats, so a point comes back a bit off; or redo writes something else.
		const { overlay, stored, gesture, sent } = rig("transform-undo.md", false);
		const was = stored();
		gesture(["free"], "rotate", (at) => ({ x: at.x + 30, y: at.y + 25 }));
		const after = stored();
		expect(after.find((s) => s.id === "free")!.points).not.toEqual(was.find((s) => s.id === "free")!.points);
		const step = ops(sent[0]!);
		apply(overlay, step.map(invertInkOp));
		expect(stored()).toEqual(was);
		apply(overlay, step);
		expect(stored()).toEqual(after);
	});

	it("a step whose stroke another pane erased since applies nothing", () => {
		// Defect: the undo rewrites the strokes still there and leaves the group half turned back.
		const { overlay, stored, gesture, sent, path } = rig("transform-stale.md", false);
		gesture(["s1", "s2"], "se", (at) => ({ x: at.x + 20, y: at.y + 20 }));
		inlineInk.applyRemove(path, ["s2"]);
		const now = stored();
		apply(overlay, ops(sent[0]!).map(invertInkOp));
		expect(stored()).toEqual(now);
	});

	it("a lift with no step records nothing", () => {
		// Defect: a tap on a handle writes an empty transform into the history.
		const { stored, gesture, sent } = rig("transform-tap.md", false);
		const was = stored();
		gesture(["free"], "se", (at) => at);
		expect(sent).toHaveLength(0);
		expect(stored()).toEqual(was);
	});
});

describe("a resize or rotate of ink attached to text", () => {
	it("the group lands where previewed against its words, and its probe is its probe stroke's first point", () => {
		// Defect: the rewrite is made in stored places and the group shows 6 right and 12 down of the preview, or the probe
		// stays where the ink was.
		const { shown, gesture, sent, path } = rig("transform-attached.md");
		const before = shown();
		const { accepted } = gesture(["s1", "s2"], "rotate", (at) => ({ x: at.x + 40, y: at.y + 30 }));
		expect(accepted!.angle).not.toBe(0);
		landsWherePreviewed(before, shown(), ["s1", "s2"], accepted!);
		const rec = inlineInk.attachments(path)[0] as AttachmentRecord;
		const s1 = inlineInk.strokes(path).find((s) => s.id === "s1")!;
		expect(rec.probe).toEqual({ id: "s1", x: s1.points[0]!.x, y: s1.points[0]!.y });
		expect(rec.ref).toEqual(record().ref);
		expect(rec.target).toEqual(record().target);
		expect(rec.layout).toEqual(record().layout);
		expect(sent).toHaveLength(1);
		expect(ops(sent[0]!).map((op) => op.type)).toEqual(["transform", "attach"]);
	});

	it("one undo puts points, probe and shown place back together, byte-equal; redo gives the after state", () => {
		// Defect: the undo turns the ink back and leaves the probe at the turned place, so the group is read off its ink.
		const { overlay, shown, stored, gesture, sent, path } = rig("transform-attached-undo.md");
		const was = { stored: stored(), shown: shown() };
		gesture(["s1", "s2"], "se", (at) => ({ x: at.x + 18, y: at.y + 18 }));
		const after = { stored: stored(), shown: shown(), list: inlineInk.attachments(path) };
		const step = ops(sent[0]!);
		apply(overlay, step.map(invertInkOp));
		expect(stored()).toEqual(was.stored);
		expect(inlineInk.attachments(path)).toEqual([record()]);
		expect(shown()).toEqual(was.shown);
		apply(overlay, step);
		expect(stored()).toEqual(after.stored);
		expect(inlineInk.attachments(path)).toEqual(after.list);
		expect(shown()).toEqual(after.shown);
	});

	it("a transform of free ink beside a group writes no attach step and leaves the record", () => {
		// Defect: every transform carries an attach step, or rewrites a record whose ink it did not touch.
		const { gesture, sent, path } = rig("transform-beside.md");
		gesture(["free"], "se", (at) => ({ x: at.x + 10, y: at.y + 10 }));
		expect(ops(sent[0]!).map((op) => op.type)).toEqual(["transform"]);
		expect(inlineInk.attachments(path)).toEqual([record()]);
	});
});

describe("the handles", () => {
	it("a finger takes the knob from 15 px off its centre, a pen there lassos", () => {
		// Defect: a finger has the pen's 12 px target, so a touch beside the knob starts a loop.
		for (const [input, grabs] of [["touch", true], ["pen", false]] as const) {
			const { overlay, selection } = rig(`transform-touch-${input}.md`, false);
			selection.selectExactly(["free"]);
			const knob = handlePoints(overlay.selectionBounds()!, 1).rotate;
			overlay.lassoDown(sample({ x: knob.x + 15, y: knob.y }), input);
			expect(!!overlay.spaceSnapshot?.transform, input).toBe(grabs);
			expect(overlay.lassoActive, input).toBe(!grabs);
		}
	});

	it("a selection with a text box shows no handles: the knob's place lassos and the grab moves", () => {
		// Defect: a mixed selection gets handles, and a resize would leave its text box behind.
		const { overlay, selection } = rig("transform-mixed.md", false);
		const loop = [{ x: 0, y: 190 }, { x: 60, y: 190 }, { x: 60, y: 230 }, { x: 0, y: 230 }];
		const boxes = [{ id: "b1" } as TextBoxData];
		selection.selectByLasso(loop, inlineInk.strokes("transform-mixed.md"), boxes, () => ({ x: 20, y: 200, width: 10, height: 10 }));
		expect(selection.boxIds).toEqual(["b1"]);
		const knob = handlePoints(overlay.selectionBounds()!, 1).rotate;
		expect(overlay.transformHandleAt(knob, "pen")).toBeNull();
		overlay.lassoDown(sample(knob), "pen");
		expect(overlay.spaceSnapshot?.transform ?? null).toBeNull();
	});
});

describe("the handles at a canvas zoom below 1", () => {
	it.each([0.5, 0.25])("a pen 4.9 screen px off the nw corner's centre at a css scale of %s grabs nw", (cssScale) => {
		// Defect: the hit square is sized in note px at the camera's zoom alone, so the canvas zoom shrinks it on screen
		// (about 3 px across at 0.25) and the contact lands in the grab pad: the ink moves instead of resizing.
		const { overlay, selection } = rig(`transform-zoomed-${cssScale}.md`, false, cssScale);
		selection.selectExactly(["free"]);
		const nw = handlePoints(overlay.selectionBounds()!, 1).nw;
		// Samples and world units are note px here (camera zoom 1); one screen px is 1 / cssScale of them. 3.5 screen px a
		// side is past the old 6 px pen square at either scale (7 and 14 note px against 6) and inside a 12 screen px one.
		const off = 3.5 / cssScale;
		overlay.lassoDown(sample({ x: nw.x - off, y: nw.y - off }), "pen");
		const handle = overlay.spaceSnapshot?.transform?.gesture.handle ?? null;
		overlay.lassoUp();
		expect(handle, "the grab started a transform on the nw corner").toBe("nw");
	});
});

describe("the frame drawn during a turn", () => {
	it("is the grab's box under the step the preview shows, and after the lift the committed ink's box with no step", () => {
		const { overlay, selection } = rig("transform-frame-turn.md", false);
		selection.selectExactly(["free"]);
		const grabBox = overlay.selectionBounds()!;
		const h = handlePoints(grabBox, 1);
		overlay.lassoDown(sample(h.rotate), "pen");
		const pivot = overlay.spaceSnapshot!.transform!.gesture.pivot;
		// A quarter turn clockwise about the pivot: the pen goes from over the pivot to its right.
		overlay.lassoMove([sample({ x: pivot.x + (pivot.y - h.rotate.y), y: pivot.y })], false);
		const accepted = { ...overlay.spaceSnapshot!.transform!.gesture.accepted };
		expect(Math.abs(accepted.angle), "precondition: the step turns").toBeGreaterThan(1);
		const during = overlay.selectionFrame();
		expect(during?.box, "the frame is the grab's box").toEqual(grabBox);
		expect(during?.step, "the frame turns by the step the preview shows").toEqual(accepted);
		overlay.lassoUp();
		const after = overlay.selectionFrame();
		expect(after?.step, "after the lift the frame takes no step").toBeUndefined();
		expect(after?.box).toEqual(overlay.selectionBounds());
	});
});
