/**
 * What a resize lift costs in point copies, against the size of the selection and of the note.
 *
 * The lift of a corner pull applies the step to every selected stroke and records one history step holding each stroke's
 * shape before and after as copies. Counted on a note of FILL + 3 strokes with two of them selected: the selected points,
 * the point objects the history step keeps (before and after), the stored points that are new objects after the lift, and
 * every new point object reachable from the store and the step together. Printed as one JSON line; a measure, no bound.
 */
import { describe, expect, it } from "vitest";
import { appendFileSync } from "node:fs";
import { Text, type TransactionSpec } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { SelectionModel } from "../objects/SelectionModel";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import type { InkOp } from "./InkHistory";
import { handlePoints } from "./LassoTransform";
import type { PenSample } from "../input/PointerRouter";

declare module "node:fs" { export function appendFileSync(path: string, data: string): void; }
declare const process: { env: Record<string, string | undefined> };
const OUT = process.env.HW_SPEED_OUT ?? "";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 40;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();
const word = "line 3 words";
/** The group is read 6 right and 12 down of its record. */
const READ = { x: 6, y: 92 };
/** Strokes on the note beside the selection. */
const FILL = 200;

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
	rec.strokes = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90), strokeAt("free", 10, 205), ...Array.from({ length: FILL }, (_, i) => strokeAt(`fill-${i}`, 10 + (i % 20) * 30, 260 + Math.floor(i / 20) * 30))];
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

describe("a resize lift's point copies", () => {
	it("counts the points the step keeps and the new point objects, against the selection and the note", () => {
		const { gesture, sent, path } = rig("lift-copies.md", false);
		const ids = ["s1", "s2"];
		const before = new Set<object>();
		for (const s of inlineInk.strokes(path)) for (const p of s.points) before.add(p);
		const selectedPoints = inlineInk.strokes(path).filter((s) => ids.includes(s.id)).reduce((n, s) => n + s.points.length, 0);
		const notePoints = before.size;
		gesture(ids, "se", (at) => ({ x: at.x + 30, y: at.y + 20 }));
		expect(sent, "premise: the lift sent one history step").toHaveLength(1);
		const op = ops(sent[0]!).find((o) => o.type === "transform") as Extract<InkOp, { type: "transform" }> | undefined;
		expect(op, "premise: the step is a transform").toBeDefined();
		const kept = [...op!.before, ...op!.after].reduce((n, sh) => n + sh.points.length, 0);
		const reachable = new Set<object>();
		let storedNew = 0;
		for (const s of inlineInk.strokes(path)) for (const p of s.points) if (!before.has(p)) { storedNew++; reachable.add(p); }
		for (const sh of [...op!.before, ...op!.after]) for (const p of sh.points) if (!before.has(p)) reachable.add(p);
		const line = { noteStrokes: inlineInk.strokes(path).length, notePoints, selectedPoints, stepKeptPoints: kept, storedNewPoints: storedNew, newReachablePoints: reachable.size };
		// eslint-disable-next-line no-console
		console.log(`LIFT-COPIES ${JSON.stringify(line)}`);
		if (OUT) appendFileSync(OUT, `LIFT-COPIES ${JSON.stringify(line)}
`);
		expect(storedNew, "premise: the selected strokes' stored points changed").toBeGreaterThan(0);
	});
});
