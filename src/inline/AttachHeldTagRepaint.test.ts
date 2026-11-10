/**
 * A redraw with nothing selected, no lasso and no preview builds no attached-ink boxes: it asks the anchors for no
 * member lists (freeFor), and a held group's tag moves in the committed repaint that paints its moved ink, with the
 * old and the new tag rects in that repaint's work. The chip and mark sync still runs in every redraw. A bare
 * overlay, a fake view whose every layout read throws, a recording tail and committed layer: no DOM, no layout.
 */
import { describe, expect, it } from "vitest";
import { Text, type TransactionSpec } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { SelectionModel } from "../objects/SelectionModel";
import { targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";
import { ATTACH_STRINGS, setAttachTarget } from "./AttachDecoration";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 40;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));
const DOC = doc.toString();
/** Each group is read 6 right and 12 down of its record. */
const READ = { x: 6, y: 92 };

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function record(id: string, strokeIds: string[], word: string): AttachmentRecord {
	const from = DOC.indexOf(word);
	return { v: 1, id, strokeIds, target: targetAt(DOC, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: strokeIds[0]!, x: 10, y: 89 } };
}

const layoutRead = () => { throw new Error("a layout read"); };

function rig(path: string, attachments: AttachmentData[], opts: { held?: string[] } = {}) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments };
	rec.attachments = undefined as unknown as typeof rec.attachments;
	rec.strokes = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90), strokeAt("s3", 300, 400), strokeAt("free", 600, 205)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	anchors.strokesFor(path, inlineInk.strokes(path));
	const status = new Map((opts.held ?? []).map((id) => [id, "needs-reattachment" as const]));
	anchors.follow.setList(inlineInk.attachments(path), status);
	anchors.follow.measure({ inView: () => true, refAt: () => READ, blockTop: () => 80 });
	const calls: string[] = [], sent: TransactionSpec[] = [];
	let refreshes = 0;
	const tail = {
		inlineGrid: null,
		restoreFullSurface: () => void calls.push("full"),
		drawAttachButton: (_c: unknown, _b: unknown, attached: boolean) => void calls.push(`button ${attached ? "attached" : "loose"}`),
		clearAll: () => void calls.push("clear"),
		prepareLive: () => void calls.push("live"),
		drawLasso: () => void calls.push("lasso"),
		drawHead: () => void calls.push("head"),
		drawSelectionBox: (_c: unknown, b: { x: number; y: number; width: number; height: number }) => void calls.push(`box ${b.x},${b.y},${b.width},${b.height}`),
		drawGroupTag: (_c: unknown, b: { x: number; y: number }, label: string) => void calls.push(`tag ${label} @${b.x},${b.y}`),
		// The selected group's pin (AttachPin.test.ts reads it); not recorded here.
		drawAttachPin: () => {},
	};
	const dom = { isConnected: true, getBoundingClientRect: layoutRead };
	const view = {
		state: { doc }, dom, dispatch: (spec: TransactionSpec) => void sent.push(spec),
		get scrollDOM() { return layoutRead(); }, get contentDOM() { return layoutRead(); },
		lineBlockAt: layoutRead, lineBlockAtHeight: layoutRead, coordsAtPos: layoutRead, posAtCoords: layoutRead,
	};
	const camera = { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) };
	// The committed layer and its damage: a recording context, every rect and every repaint asked for kept.
	const committed: string[] = [], damage: { x: number; y: number; width: number; height: number }[] = [];
	let repaints = 0;
	const recordingCtx = () => new Proxy({} as Record<string, unknown>, {
		get: (t, k) => k in t ? t[k as string] : k === "measureText" ? (text: string) => ({ width: text.length * 7 })
			: (...a: unknown[]) => void committed.push(`${String(k)} ${a.map((v) => typeof v === "number" ? Math.round(v * 100) / 100 : String(v)).join(",")}`),
		set: (t, k, v) => { t[k as string] = v; return true; },
	});
	const selection = new SelectionModel();
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors, view, tail, camera, selection,
		filePath: () => path,
		refreshStrip: () => void refreshes++,
		dressTail: () => {}, queueTailShrink: () => {}, showLassoCursor: () => {}, sayIfPageEmpty: () => {},
		beginLassoSnapshot: () => {}, captureHistoryIdentity: () => null,
		spaceTime: null, spacePreview: null, spacePlan: null, spaceSnapshot: null,
		spaceRowsCache: { get: () => null },
		builder: null, lassoActive: false, lassoPts: [], dragBox: null, dragTotal: null,
		cssWidth: 800, cssHeight: 600, cssScale: 1, scale: 1,
		strokesHere: () => inlineInk.strokes(path),
		committedCtx: recordingCtx(), highlightCtx: recordingCtx(), committedCanvas: { width: 800, height: 600 },
		committedBacking: 1, dpr: 1, extentMayBuild: false, extentArmAsked: false, standIn: null, extentBuild: null,
		highlightPairDeferred: true, indexDirty: false, paintMoving: false, strokeIndex: { query: () => [] },
		markCommittedPaint: () => {}, usableExtent: () => null, armExtentBuild: () => {}, paintAttached: () => {}, attachedLayer: null,
		damage: { addRect: (r: { x: number; y: number; width: number; height: number }) => void damage.push({ ...r }), addAll: () => void damage.push({ x: -Infinity, y: -Infinity, width: Infinity, height: Infinity }) },
		scheduleRepaint: () => void repaints++,
	});
	const redraw = () => {
		calls.length = 0;
		(overlay as unknown as { redrawSelectionUI(): void }).redrawSelectionUI();
		return [...calls];
	};
	const paint = (work: "all" | { x: number; y: number; width: number; height: number }[]) => {
		committed.length = 0;
		(overlay as unknown as { paintCommittedWork(c: object, w: unknown, s: readonly InkStroke[]): boolean }).paintCommittedWork(camera.snapshot, work, inlineInk.strokes(path));
		return [...committed];
	};
	return { overlay, anchors, selection, redraw, paint, damage, repaints: () => repaints, sent, refreshes: () => refreshes, calls };
}

const flush = () => new Promise<void>((r) => queueMicrotask(r));

const targetOf = (spec: TransactionSpec) => [spec.effects ?? []].flat().filter((e) => (e as { is(t: unknown): boolean }).is(setAttachTarget)).map((e) => (e as { value: unknown }).value);
let currentPath = "";
const inlineInkStrokes = (ids: string[]) => inlineInk.strokes(currentPath).filter((s) => ids.includes(s.id));
const storedTopLeft = (ids: string[]) => {
	const bs = inlineInkStrokes(ids).map((s) => s.bbox);
	return `${Math.min(...bs.map((b) => b.x))},${Math.min(...bs.map((b) => b.y))}`;
};
/** The held tag's pixels at zoom 1: a pill 6 left of the box and up to 24 above it, as wide as its label. */
const tagArea = (box: string) => {
	const [x, y] = box.split(",").map(Number) as [number, number];
	return { x: x - 6, y: y - 24, width: ATTACH_STRINGS.needs.length * 7 + 8, height: 16 };
};
const tagsIn = (ops: string[]) => ops.filter((op) => op.startsWith(`fillText ${ATTACH_STRINGS.needs},`));
/** The rects a paint cleared, as world boxes (zoom 1, camera at 0). */
const cleared = (ops: string[]) => ops.filter((op) => op.startsWith("clearRect ")).map((op) => {
	const [x, y, width, height] = op.slice(10).split(",").map(Number) as [number, number, number, number];
	return { x, y, width, height };
});
const covers = (r: { x: number; y: number; width: number; height: number }, a: { x: number; y: number; width: number; height: number }) =>
	r.x <= a.x && r.y <= a.y && r.x + r.width >= a.x + a.width && r.y + r.height >= a.y + a.height;

/** Counts the anchors' freeFor calls from here on. */
function countFreeFor(anchors: LineAnchors): () => number {
	let n = 0;
	const real = anchors.freeFor.bind(anchors);
	anchors.freeFor = ((path: string, src: readonly InkStroke[]) => (n++, real(path, src))) as typeof anchors.freeFor;
	return () => n;
}

/** A store move of these strokes by dy: a new stroke list, as the Insert Space release hands the store. */
function moveStrokes(path: string, ids: string[], dy: number): void {
	const rec = inlineInk.record(path);
	rec.strokes = rec.strokes.map((s) => {
		if (!ids.includes(s.id)) return s;
		const points = s.points.map((p) => ({ ...p, y: p.y + dy }));
		return { ...s, points, bbox: computeBBox(points, 2) };
	});
}

describe("a redraw with nothing selected builds no group boxes", () => {
	it("after a store move, the redraw asks for no member lists", () => {
		const r = rig((currentPath = "sel-ui-nofree.md"), [record("g1", ["s1", "s2"], "line 3 words")], { held: ["g1"] });
		r.redraw();
		r.paint("all");
		const calls = countFreeFor(r.anchors);
		moveStrokes(currentPath, ["s1", "s2"], 30);
		expect(r.redraw()).toEqual(["clear", "live"]);
		expect(calls(), "freeFor calls in the redraw").toBe(0);
	});

	it("with a group held and nothing changed, the redraw asks no repaint and the next repaint asks for no member lists", () => {
		const r = rig((currentPath = "sel-ui-unchanged.md"), [record("g1", ["s1", "s2"], "line 3 words")], { held: ["g1"] });
		r.redraw();
		expect(tagsIn(r.paint("all")), "premise: the whole paint draws the held tag").toHaveLength(1);
		// The same held ids, the same attachment list and the same stroke list: nothing for the tags to work out.
		const calls = countFreeFor(r.anchors), before = r.repaints();
		r.redraw();
		r.paint([]);
		expect([r.repaints() - before, calls()], "[repaints asked, freeFor calls] over the redraw and the repaint after it").toEqual([0, 0]);
	});

	it("with no group held, a store move asks for no member lists and no repaint", () => {
		const r = rig((currentPath = "sel-ui-noheld.md"), [record("g1", ["s1", "s2"], "line 3 words")]);
		r.redraw();
		const calls = countFreeFor(r.anchors), before = r.repaints();
		moveStrokes(currentPath, ["free"], 30);
		r.redraw();
		expect([calls(), r.repaints() - before], "[freeFor calls, repaints asked]").toEqual([0, 0]);
	});
});

describe("a held group's tag moves in the repaint that paints its moved ink", () => {
	it("the redraw asks a repaint; that repaint clears the old tag, draws the new one, from its own work", () => {
		const r = rig((currentPath = "sel-ui-move.md"), [record("g1", ["s1", "s2"], "line 3 words")], { held: ["g1"] });
		r.redraw();
		expect(tagsIn(r.paint("all")), "premise: the whole paint draws the held tag").toHaveLength(1);
		const oldArea = tagArea(storedTopLeft(["s1", "s2"]));
		moveStrokes(currentPath, ["s1", "s2"], 30);
		const newArea = tagArea(storedTopLeft(["s1", "s2"]));
		const before = r.repaints();
		r.redraw();
		expect(r.repaints() - before, "repaints asked by the redraw").toBeGreaterThan(0);
		// The repaint's damage is whatever the store move left; the tag rects come from the repaint itself.
		const ops = r.paint([]);
		const rects = cleared(ops);
		expect([rects.some((c) => covers(c, oldArea)), rects.some((c) => covers(c, newArea))], `[old tag cleared, new tag cleared] ${JSON.stringify(rects)}`).toEqual([true, true]);
		expect(tagsIn(ops), "the tag drawn once, at the moved group").toHaveLength(1);
		const [x, y] = storedTopLeft(["s1", "s2"]).split(",").map(Number) as [number, number];
		expect(ops).toContain(`translate ${x - 6},${y - 6}`);
		// The next repaint with nothing changed carries no tag rect.
		expect(cleared(r.paint([])), "a repaint after it, nothing changed").toEqual([]);
	});
});

describe("the chip and mark sync still runs with nothing selected", () => {
	it("a deselect clears the mark and refreshes the strip once", async () => {
		const g1 = record("g1", ["s1", "s2"], "line 3 words");
		const r = rig((currentPath = "sel-ui-deselect.md"), [g1]);
		r.selection.selectExactly(["s1", "s2"]);
		r.redraw();
		await flush();
		const before = r.refreshes();
		r.selection.clear();
		r.redraw();
		await flush();
		expect([r.sent.flatMap(targetOf), r.refreshes() - before]).toEqual([[{ from: g1.target.from, to: g1.target.to }, null], 1]);
	});
});
