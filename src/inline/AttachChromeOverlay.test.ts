/**
 * Attached ink chrome through the overlay's own redraw and lasso contact: the outline is the group's union where this
 * pane shows it, the tag shows with nothing selected, a contact inside one of two selected groups narrows to it, the
 * mark follows the one selected group, and the strip is refreshed when Attach or Detach changes under a selection that
 * did not. A bare overlay, a fake view whose every layout read throws, a recording tail: no DOM, no layout.
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
import { attachButtonPoint, handlePoints, HANDLE_TOUCH_PX } from "./LassoTransform";

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

/** The members' union where this pane shows them: stored boxes moved by the group's correction (6, 12). */
function shownUnion(ids: string[]): string {
	const bs = inlineInkStrokes(ids).map((s) => s.bbox);
	const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
	const r = Math.max(...bs.map((b) => b.x + b.width)), bt = Math.max(...bs.map((b) => b.y + b.height));
	return `${x + READ.x},${y + READ.y - 80},${r - x},${bt - y}`;
}
let currentPath = "";
/** Whether the touch handle square at `p` overlaps a group's shown union (the first stroke's box, moved by the correction). */
const groupHit = (p: { x: number; y: number }, b: { x: number; y: number; width: number; height: number }) => {
	const half = HANDLE_TOUCH_PX / 2, x = b.x + READ.x, y = b.y + READ.y - 80;
	return p.x + half >= x && p.x - half <= x + b.width && p.y + half >= y && p.y - half <= y + b.height;
};
const inlineInkStrokes = (ids: string[]) => inlineInk.strokes(currentPath).filter((s) => ids.includes(s.id));

describe("the redraw draws attached ink's chrome from boxes and the camera", () => {
	it("one group selected: the selection box, then the group's outline at its shown union, labelled", () => {
		// Defect: the outline drawn round the stored boxes, 6 left and 12 up of the ink on screen.
		const r = rig((currentPath = "chrome-one.md"), [record("g1", ["s1", "s2"], "line 3 words")]);
		r.selection.selectExactly(["s1", "s2"]);
		const calls = r.redraw();
		const union = shownUnion(["s1", "s2"]);
		expect(calls).toContain(`box ${union}`);
		expect(calls.filter((c) => c.startsWith("tag "))).toEqual([`tag ${ATTACH_STRINGS.attached} @${union.split(",").slice(0, 2).join(",")}`]);
	});

	it("nothing selected, a group needing reattachment or all resolved: the compact tail, no chrome on it", () => {
		const held = rig((currentPath = "chrome-held.md"), [record("g1", ["s1", "s2"], "line 3 words")], { held: ["g1"] });
		expect(held.redraw()).toEqual(["clear", "live"]);
		const fine = rig((currentPath = "chrome-fine.md"), [record("g1", ["s1", "s2"], "line 3 words")]);
		expect(fine.redraw()).toEqual(["clear", "live"]);
	});

	it("a note with no groups draws what it drew before, and the loose Attach button under a free-ink selection", () => {
		const r = rig((currentPath = "chrome-none.md"), []);
		expect(r.redraw()).toEqual(["clear", "live"]);
		r.selection.selectExactly(["free"]);
		const calls = r.redraw();
		expect(calls.filter((c) => c.startsWith("tag ") || c === "full").length).toBe(1);
		expect(calls.filter((c) => c.startsWith("button "))).toEqual(["button loose"]);
	});

	it("a drag of the selection, grabbed inside it or at a corner, hides the Attach button and its hit until the lift; the lift draws it again", () => {
		// Defect: the redraw asks the button without the drag, so it rides a moving selection and a tap on it lands mid-drag.
		// This rig has no picture, so a corner grab is a plain drag here; LassoDragPicture.test.ts holds the resize and the turn.
		const r = rig((currentPath = "button-moving.md"), []);
		r.selection.selectExactly(["free"]);
		const o = r.overlay as unknown as {
			selectionBounds(): { x: number; y: number; width: number; height: number };
			lassoDown(s: { x: number; y: number }, input: string): void;
			lassoUp(): void;
			attachButtonAt(w: { x: number; y: number }, input: string): boolean;
			dragTotal: unknown;
		};
		const box = o.selectionBounds(), button = attachButtonPoint(box, 1);
		const buttons = () => r.redraw().filter((c) => c.startsWith("button "));
		expect(buttons(), "premise: the loose button shows before the grab").toEqual(["button loose"]);
		expect(o.attachButtonAt(button, "pen"), "premise: and takes a pen").toBe(true);
		const grabs: [string, { x: number; y: number }][] = [
			["the selection", { x: box.x + box.width / 2, y: box.y + box.height / 2 }],
			["the corner", handlePoints(box, 1).se],
		];
		for (const [name, at] of grabs) {
			o.lassoDown(at, "pen");
			expect(o.dragTotal, `${name}: a drag began`).not.toBeNull();
			expect(buttons(), `${name}: no button drawn mid-gesture`).toEqual([]);
			expect(o.attachButtonAt(button, "pen"), `${name}: no button hit mid-gesture`).toBe(false);
			o.lassoUp();
			expect(buttons(), `${name}: drawn again after the lift`).toEqual(["button loose"]);
			expect(o.attachButtonAt(button, "pen"), `${name}: hit again after the lift`).toBe(true);
		}
	});

	it("a camera move redraws the same world boxes with no layout read", () => {
		const r = rig((currentPath = "chrome-camera.md"), [record("g1", ["s1", "s2"], "line 3 words"), record("g2", ["s3"], "line 9 words")], { held: ["g2"] });
		r.selection.selectExactly(["s1", "s2"]);
		const first = r.redraw();
		(r.overlay as unknown as { camera: { snapshot: object } }).camera.snapshot = { x: 40, y: 120, zoom: 0.5 };
		expect(r.redraw()).toEqual(first);
	});
});

describe("a lasso contact inside one of two selected groups narrows the selection to it", () => {
	const lassoDown = (o: InkOverlayPlugin, x: number, y: number) =>
		(o as unknown as { lassoDown(s: { x: number; y: number }): void }).lassoDown({ x, y });

	it("two groups selected: a contact in the second group's union selects its members only", () => {
		const r = rig((currentPath = "narrow-two.md"), [record("g1", ["s1", "s2"], "line 3 words"), record("g2", ["s3"], "line 9 words")]);
		r.selection.selectExactly(["s1", "s2", "s3"]);
		const s3 = inlineInkStrokes(["s3"])[0]!.bbox;
		lassoDown(r.overlay, s3.x + READ.x + 1, s3.y + READ.y - 80 + 1);
		expect(r.selection.strokeIds).toEqual(["s3"]);
	});

	it("a contact on a transform handle that also lies in a group's union resizes; it does not narrow", () => {
		// Defect: the narrow runs first, the box shrinks to one group, and the corner pull lands on nothing.
		const r = rig((currentPath = "narrow-handle.md"), [record("g1", ["s1", "s2"], "line 3 words"), record("g2", ["s3"], "line 9 words")]);
		r.selection.selectExactly(["s1", "s2", "s3"]);
		const o = r.overlay as unknown as { selectionBounds(): { x: number; y: number; width: number; height: number }; lassoDown(s: { x: number; y: number }, input: string): void };
		const nw = handlePoints(o.selectionBounds(), 1).nw;
		const s1 = inlineInkStrokes(["s1"])[0]!.bbox;
		expect(groupHit(nw, s1), "premise: the touch handle's square reaches the first group's union").toBe(true);
		o.lassoDown({ x: nw.x, y: nw.y }, "touch");
		expect(r.selection.strokeIds.sort()).toEqual(["s1", "s2", "s3"]);
	});

	it("one group selected, or a contact in no group: the selection is not narrowed", () => {
		const r = rig((currentPath = "narrow-one.md"), [record("g1", ["s1", "s2"], "line 3 words"), record("g2", ["s3"], "line 9 words")]);
		r.selection.selectExactly(["s1", "s2", "free"]);
		const s1 = inlineInkStrokes(["s1"])[0]!.bbox;
		lassoDown(r.overlay, s1.x + READ.x + 1, s1.y + READ.y - 80 + 1);
		expect(r.selection.strokeIds.sort()).toEqual(["free", "s1", "s2"]);
	});
});

describe("the mark and the strip follow the selection", () => {
	it("one group selected marks its text; a cleared selection clears the mark", async () => {
		const g1 = record("g1", ["s1", "s2"], "line 3 words");
		const r = rig((currentPath = "mark.md"), [g1]);
		r.selection.selectExactly(["s1"]);
		r.redraw();
		await flush();
		expect(r.sent.flatMap(targetOf)).toEqual([{ from: g1.target.from, to: g1.target.to }]);
		r.selection.clear();
		r.redraw();
		await flush();
		expect(r.sent.flatMap(targetOf)).toEqual([{ from: g1.target.from, to: g1.target.to }, null]);
		r.redraw();
		await flush();
		expect(r.sent, "no dispatch when nothing changed").toHaveLength(2);
	});

	it("a held group's text is not marked", async () => {
		const r = rig((currentPath = "mark-held.md"), [record("g1", ["s1", "s2"], "line 3 words")], { held: ["g1"] });
		r.selection.selectExactly(["s1"]);
		r.redraw();
		await flush();
		expect(r.sent.flatMap(targetOf)).toEqual([]);
	});

	it("the strip refreshes once when Detach turns off under the same selection", async () => {
		// Defect: the strip keeps a lit Detach after the group went, until the next selection change.
		const r = rig((currentPath = "strip-refresh.md"), [record("g1", ["s1", "s2"], "line 3 words")]);
		r.selection.selectExactly(["s1", "s2"]);
		r.redraw();
		await flush();
		const before = r.refreshes();
		inlineInk.setAttachments(currentPath, [], true);
		r.redraw();
		await flush();
		expect(r.refreshes() - before).toBe(1);
		r.redraw();
		await flush();
		expect(r.refreshes() - before).toBe(1);
	});
});

/** A held group is not read: it shows at its stored points, so its tag sits at the stored union's top-left. */
const storedTopLeft = (ids: string[]) => {
	const bs = inlineInkStrokes(ids).map((s) => s.bbox);
	return `${Math.min(...bs.map((b) => b.x))},${Math.min(...bs.map((b) => b.y))}`;
};

/** The held tag's pixels at zoom 1: a pill 6 left of the box and up to 24 above it, as wide as its label. */
const tagArea = (box: string) => {
	const [x, y] = box.split(",").map(Number) as [number, number];
	return { x: x - 6, y: y - 24, width: ATTACH_STRINGS.needs.length * 7 + 8, height: 16 };
};
const covers = (r: { x: number; y: number; width: number; height: number }, a: { x: number; y: number; width: number; height: number }) =>
	r.x <= a.x && r.y <= a.y && r.x + r.width >= a.x + a.width && r.y + r.height >= a.y + a.height;
const tagsIn = (ops: string[]) => ops.filter((op) => op.startsWith(`fillText ${ATTACH_STRINGS.needs},`));
/** The rects a committed paint cleared, as world boxes (zoom 1, camera at 0). */
const clearedIn = (ops: string[]) => ops.filter((op) => op.startsWith("clearRect ")).map((op) => {
	const [x, y, width, height] = op.slice(10).split(",").map(Number) as [number, number, number, number];
	return { x, y, width, height };
});

describe("the held tag never forces the full tail", () => {
	// Defect (85e5174a): a note holding a group that needs reattachment restored the full-size tail on every redraw, the
	// selection's cost with nothing selected, for the tag alone.
	it("1. a held group, nothing selected: the tail stays compact and draws no tag", () => {
		const r = rig((currentPath = "add5-compact.md"), [record("g1", ["s1", "s2"], "line 3 words")], { held: ["g1"] });
		expect(r.redraw()).toEqual(["clear", "live"]);
	});

	it("2. a held group, nothing selected: the committed layer's whole repaint draws the tag at the group's top-left", () => {
		const r = rig((currentPath = "add5-whole.md"), [record("g1", ["s1", "s2"], "line 3 words")], { held: ["g1"] });
		r.redraw();
		const ops = r.paint("all");
		expect(tagsIn(ops)).toHaveLength(1);
		const [x, y] = storedTopLeft(["s1", "s2"]).split(",").map(Number) as [number, number];
		expect(ops).toContain(`translate ${x - 6},${y - 6}`);
	});

	it("3. a damage rect over the tag repaints it; a damage rect elsewhere draws no tag", () => {
		const r = rig((currentPath = "add5-rect.md"), [record("g1", ["s1", "s2"], "line 3 words")], { held: ["g1"] });
		r.redraw();
		expect(tagsIn(r.paint([tagArea(storedTopLeft(["s1", "s2"]))]))).toHaveLength(1);
		expect(tagsIn(r.paint([{ x: 500, y: 500, width: 40, height: 40 }]))).toHaveLength(0);
	});

	it("4. a group turning held asks a repaint that paints its tag's rect, and the tail stays compact", () => {
		const list = [record("g1", ["s1", "s2"], "line 3 words")];
		const r = rig((currentPath = "add5-held.md"), list);
		r.redraw();
		const before = r.repaints();
		r.anchors.follow.setList(inlineInk.attachments(currentPath), new Map([["g1", "needs-reattachment" as const]]));
		expect(r.redraw()).toEqual(["clear", "live"]);
		expect(r.repaints() - before).toBeGreaterThan(0);
		// Read before it turned held: it keeps its last correction, so its tag sits at the shown union. The repaint adds
		// the tag's rect to its own work.
		const area = tagArea(shownUnion(["s1", "s2"]));
		const ops = r.paint([]);
		expect(clearedIn(ops).some((d) => covers(d, area)), JSON.stringify(clearedIn(ops))).toBe(true);
		expect(tagsIn(ops)).toHaveLength(1);
	});

	it("5. a held group resolving asks a repaint that clears its tag's rect and draws no tag", () => {
		const r = rig((currentPath = "add5-resolved.md"), [record("g1", ["s1", "s2"], "line 3 words")], { held: ["g1"] });
		r.redraw();
		r.paint("all");
		const before = r.repaints();
		r.anchors.follow.setList(inlineInk.attachments(currentPath), new Map());
		expect(r.redraw()).toEqual(["clear", "live"]);
		expect(r.repaints() - before).toBeGreaterThan(0);
		const area = tagArea(storedTopLeft(["s1", "s2"]));
		const ops = r.paint([]);
		expect(clearedIn(ops).some((d) => covers(d, area)), JSON.stringify(clearedIn(ops))).toBe(true);
		expect(tagsIn(ops)).toHaveLength(0);
	});
});

describe("nothing selected reads only the held groups' boxes", () => {
	// Defect (5368a198): with nothing selected the redraw after an Insert Space release built every group's union, about
	// 0.7 ms on the heavy note (row 9), for the one held group's tag.
	it("6. nothing selected, one group held of two: the unheld group's member boxes are not read", () => {
		const r = rig((currentPath = "add5-lazy.md"), [record("g1", ["s1", "s2"], "line 3 words"), record("g2", ["s3"], "line 9 words")], { held: ["g2"] });
		let reads = 0;
		for (const s of inlineInkStrokes(["s1", "s2"])) {
			const b = s.bbox;
			Object.defineProperty(s, "bbox", { get: () => (reads++, b), configurable: true });
		}
		expect(r.redraw()).toEqual(["clear", "live"]);
		expect(reads, "bbox reads of the unheld group's members").toBe(0);
		expect(tagsIn(r.paint("all"))).toHaveLength(1);
	});
});
