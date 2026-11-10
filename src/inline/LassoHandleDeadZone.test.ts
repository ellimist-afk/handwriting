/**
 * A TAP ON A LASSO HANDLE RECORDS NOTHING.
 *
 * Defect (TF-12): a pen set down on a corner handle or the knob and lifted moves a fraction of a px on the way. Any scale
 * other than 1 and any angle other than 0 is a step, so the lift rewrites the selected strokes, saves, and pushes a history
 * step that changes nothing the eye can see: the next undo seems to do nothing. A drag rounds to whole backing px first, so
 * the same jitter records no move.
 *
 * The bar: at backing 1 and zoom 1, a grab on the ne corner with one sample 0.3 px out along the grab's diagonal, or on the
 * knob with one sample 0.3 px to the side, then the lift, sends no history and leaves the store byte-equal. The control: a
 * 2 px pull on the same corner still records one transform step. Two more bars (addendum 30): the step the picture draws
 * through after a corner tap is already the identity before the lift (no floor at the lift alone, which would land the ink
 * off the picture); and at backing 8 the same 0.3 px tap moves a corner by 2.4 backing px, so it records one step (the
 * dead zone is half a backing px, not half a world px).
 *
 * The rig is InkOverlayLassoTransform.test.ts's: a bare overlay with the real selection model, the real line anchors and a
 * fake view; no DOM, no layout read, no paint.
 */
import { describe, expect, it } from "vitest";
import { Text, type TransactionSpec } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { SelectionModel } from "../objects/SelectionModel";
import type { InkOp } from "./InkHistory";
import { handlePoints, type TransformHandle } from "./LassoTransform";
import type { PenSample } from "../input/PointerRouter";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 40;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));

function strokeAt(id: string, x: number, y: number): InkStroke {
	// Mixed segment lengths, so no axis can agree by accident.
	const points = [0, 3, 10, 22, 31].map((d, i) => ({ x: x + d, y: y + 4 + (i % 2) * 7, pressure: 0.5, t: i * 8 }));
	return { id, tool: "pen", color: "#111", width: 2, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const sample = (p: { x: number; y: number }): PenSample => ({ x: p.x, y: p.y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

function rig(path: string, backing = 1) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	rec.strokes = [strokeAt("free", 60, 205)];
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
				const line = doc.line(Math.min(LINES, Math.floor(h / 40) + 1));
				return { from: line.from, to: line.to, top: (line.number - 1) * 40, bottom: line.number * 40 };
			},
			requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
			dispatch: (spec: TransactionSpec) => sent.push(spec),
		},
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 } },
		committedBacking: backing,
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
	/** The step the picture draws through after each gesture's sample, before its lift. */
	const seen: ({ scale: number; angle: number; shift?: { x: number; y: number } } | null)[] = [];
	const stored = () => inlineInk.strokes(path).map((s) => ({ id: s.id, width: s.width, bbox: { ...s.bbox }, points: s.points.map((p) => ({ ...p })) }));
	/** Grab `handle` on the selection, one sample at `to(handle centre, ink box)`, lift. True when the grab started a transform. */
	const gesture = (handle: TransformHandle, to: (at: { x: number; y: number }, box: { x: number; y: number; width: number; height: number }) => { x: number; y: number }) => {
		selection.selectExactly(["free"]);
		const box = overlay.selectionBounds()!;
		const at = handlePoints(box, 1)[handle];
		overlay.lassoDown(sample(at), "pen");
		const grabbed = !!overlay.spaceSnapshot?.transform;
		overlay.lassoMove([sample(to(at, box))], false);
		const acc = overlay.spaceSnapshot?.transform?.gesture.accepted;
		seen.push(acc ? { scale: acc.scale, angle: acc.angle, shift: acc.shift } : null);
		overlay.lassoUp();
		return grabbed;
	};
	return { sent, stored, gesture, seen };
}

const ops = (spec: TransactionSpec): InkOp[] => [spec.effects ?? []].flat().map((e) => (e as { value: InkOp }).value);
/** `d` px from the ne handle, outward along the line from the ink box's sw corner (the pivot) through the handle. */
const outFromSw = (d: number) => (at: { x: number; y: number }, box: { x: number; y: number; width: number; height: number }) => {
	const ux = at.x - box.x, uy = at.y - (box.y + box.height), len = Math.hypot(ux, uy);
	return { x: at.x + (ux / len) * d, y: at.y + (uy / len) * d };
};

describe("a tap on a lasso handle", () => {
	it("a corner tap with 0.3 px of pen jitter records nothing and leaves the store byte-equal", () => {
		const { sent, stored, gesture } = rig("handle-deadzone-corner.md");
		const was = stored();
		expect(gesture("ne", outFromSw(0.3)), "the grab started a transform").toBe(true);
		expect(sent.map((s) => ops(s).map((op) => op.type)), "a dead history step from a tap").toEqual([]);
		expect(stored(), "the store was rewritten by a tap").toEqual(was);
	});

	it("a knob tap with 0.3 px of pen jitter records nothing and leaves the store byte-equal", () => {
		const { sent, stored, gesture } = rig("handle-deadzone-knob.md");
		const was = stored();
		expect(gesture("rotate", (at) => ({ x: at.x + 0.3, y: at.y })), "the grab started a transform").toBe(true);
		expect(sent.map((s) => ops(s).map((op) => op.type)), "a dead history step from a tap").toEqual([]);
		expect(stored(), "the store was rewritten by a tap").toEqual(was);
	});

	it("control: a 2 px corner pull still records one transform step", () => {
		const { sent, stored, gesture } = rig("handle-deadzone-pull.md");
		const was = stored();
		expect(gesture("ne", outFromSw(2)), "the grab started a transform").toBe(true);
		expect(sent.map((s) => ops(s).map((op) => op.type))).toEqual([["transform"]]);
		expect(stored()).not.toEqual(was);
	});

	it("a corner tap's step under the pen is already the identity before the lift", () => {
		// Defect: the floor sits at the lift alone, so the picture shows the jitter's scale and the lift lands the ink off it.
		const { gesture, seen } = rig("handle-deadzone-picture.md");
		expect(gesture("ne", outFromSw(0.3)), "the grab started a transform").toBe(true);
		expect(seen, "the step the picture draws through after the tap").toEqual([{ scale: 1, angle: 0, shift: undefined }]);
	});

	it("at backing 8 a 0.3 px corner tap moves a corner past half a backing px and records one step", () => {
		// Defect: the dead zone ignores the backing and swallows a step the screen shows.
		const { sent, stored, gesture } = rig("handle-deadzone-backing-8.md", 8);
		const was = stored();
		expect(gesture("ne", outFromSw(0.3)), "the grab started a transform").toBe(true);
		expect(sent.map((s) => ops(s).map((op) => op.type)), "a tap the screen shows records one step").toEqual([["transform"]]);
		expect(stored(), "the store changed").not.toEqual(was);
	});
});
