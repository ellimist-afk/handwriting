/**
 * No sprite is built while the camera moves, and a group's
 * first read puts its members in the index instead of marking the whole index for a rebuild. Each cell is red with its
 * plant in. No browser: fake canvases, a bare overlay.
 */
import { describe, expect, it } from "vitest";
import { AttachedLayer, type AttachedGroup } from "./InkOverlayAttachedLayer";
import { StrokeIndex } from "../ink/StrokeIndex";
import { InkOverlayPlugin } from "./InkOverlay";
import { LineAnchors } from "./LineAnchor";
import { targetAt, type AttachmentRecord } from "./InkAttachments";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { translateStroke } from "../objects/Selection";
import { inlineInk } from "./InkOverlayRegistry";
import { InsertSpaceRows } from "./InsertSpace";
import { drawStroke, ribbonCacheStats } from "../ink/StrokeRenderer";
import { eraserRect, strokesHitByCircle } from "../ink/Eraser";

function fakeCanvas() {
	const ctx = new Proxy({} as Record<string, unknown>, {
		get: (target, key) => (key in target ? target[key as string] : key === "measureText" ? () => ({ width: 0 }) : () => undefined),
		set: (target, key, value) => { target[key as string] = value; return true; },
	});
	return { width: 300, height: 150, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const SIZE = { backingW: 800, backingH: 600, backing: 2, cssW: 400, cssH: 300 };
const group = (id: string, members: InkStroke[]): AttachedGroup => ({ id, members, offset: { dx: 0, dy: 0 }, shown: () => members });

describe("no sprite is built while the camera moves", () => {
	it("S1: a group brought into view by a moving camera draws by path, unbuilt; the next paint at the still camera builds it once", () => {
		// Defect: a fling frame builds every sprite the fling brings into view (9 or 10 in one frame, 11 to 13 ms).
		const layer = new AttachedLayer(fakeCanvas(), fakeCanvas(), fakeCanvas);
		const a = group("att-1", [strokeAt("s1", 10, 20)]), b = group("att-2", [strokeAt("s2", 10, 200)]);
		const at0 = { x: 0, y: 0, zoom: 1 }, at1 = { x: 0, y: 120, zoom: 1 };
		layer.paint(at0, [a], false, undefined, SIZE, layer.stillAt(at0));
		expect(layer.counts.built, "premise: the load builds the group in view").toBe(1);
		// A fling frame: the camera moved since the last paint, and group b comes into view.
		const moving = layer.stillAt(at1);
		layer.paint(at1, [a, b], false, undefined, SIZE, moving);
		expect([moving, layer.counts.built, layer.counts.byPath > 0, layer.buildWaits], "the moving frame builds nothing and draws b by path").toEqual([false, 1, true, true]);
		// The settle: one more paint at the same camera.
		layer.paint(at1, [a, b], false, undefined, SIZE, layer.stillAt(at1));
		expect([layer.counts.built, layer.buildWaits], "the still paint builds b once").toEqual([2, false]);
		layer.paint(at1, [a, b], true, undefined, SIZE, layer.stillAt(at1));
		expect(layer.counts.built, "and never again while nothing changes").toBe(2);
	});
});

describe("a group's first read goes into the index", () => {
	it("S2: a pending group read for the first time: its members enter the index at their shown place, no rebuild, no whole layer paint", () => {
		// Defect: each first read in a fling marks the whole index for a rebuild (4 ms over 28k strokes, per frame).
		const DOC = "Intro line.\nThe word benzene here.\nLast line.\n", from = DOC.indexOf("benzene");
		const record: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: 80 }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 10, y: 89 } };
		const anchors = new LineAnchors(() => null), follow = anchors.follow;
		follow.setList([record]);
		const stored = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 90)];
		// Pending: the surface asks for each member and gets null (not painted, not in the index).
		expect(stored.map((s) => follow.shown(s)), "premise: the group is pending").toEqual([null, null]);
		const calls: string[] = [], inserted: InkStroke[] = [];
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		Object.assign(overlay, {
			lineAnchorState: anchors, indexDirty: false,
			attachedLayer: { stillAt: () => true, moved: () => calls.push("moved"), invalidate: (why: string) => calls.push("invalidate:" + why) },
			strokeIndex: {
				remove: () => calls.push("remove"),
				insertLike: (s: InkStroke) => { calls.push("insert"); inserted.push(s); },
				insertFirst: (s: InkStroke) => { calls.push("insert"); inserted.push(s); return true; },
				holds: () => false,
			},
			camera: { snapshot: { x: 0, y: 0, zoom: 1 } },
			frontierCache: { invalidate: () => {} },
			scheduleRepaint: () => {},
			lineAnchorsMoved: () => calls.push("membership"),
		});
		const before = follow.snapshot();
		follow.measure({ inView: () => true, refAt: () => ({ x: 0, y: 92 }), blockTop: () => 80 });
		overlay.followMoved("attach-first-read.md", before);
		expect((overlay as unknown as { indexDirty: boolean }).indexDirty, "no whole index rebuild").toBe(false);
		expect(calls, "two inserts, one rect to the layer, no whole layer paint").toEqual(["insert", "insert", "moved"]);
		expect(inserted.map((s) => s.points[0]!.y), "at the shown place, 12 below the stored").toEqual([97, 102]);
	});
});

/** A tile canvas that counts each draw into it (one getContext per tile per tool a build draws). */
function countedCanvas(n: { draws: number }) {
	const c = fakeCanvas();
	const get = c.getContext.bind(c);
	(c as unknown as { getContext: () => unknown }).getContext = () => { n.draws++; return get("2d"); };
	return c;
}

/** Seven strokes 520 css px apart on one line: one tile each at backing 2 (1024 device px a tile), seven tiles a group. */
const sevenTiles = (id: string, y: number): AttachedGroup =>
	group(id, [0, 1, 2, 3, 4, 5, 6].map((i) => strokeAt(`${id}-s${i}`, 10 + i * 520, y)));

describe("a still paint draws at most 16 tiles", () => {
	it("S3: a settle revealing 10 groups of 7 tiles draws 16 a paint, the rest by path, and asks a frame until all are drawn", () => {
		// Defect: the still paint after a fling pause builds every sprite the fling revealed, 9 or 10 groups in one frame.
		const n = { draws: 0 };
		const layer = new AttachedLayer(fakeCanvas(), fakeCanvas(), () => countedCanvas(n));
		const first = sevenTiles("att-0", 10), groups = Array.from({ length: 10 }, (_, j) => sevenTiles(`att-${j + 1}`, 30 + j * 20));
		const at0 = { x: 0, y: 0, zoom: 1 }, at1 = { x: 0, y: 20, zoom: 1 };
		layer.paint(at0, [first], false, undefined, SIZE, layer.stillAt(at0));
		layer.paint(at0, [first], false, undefined, SIZE, layer.stillAt(at0));
		expect([n.draws, layer.buildWaits], "premise: the load draws the first group's 7 tiles and waits for nothing").toEqual([7, false]);
		// A fling frame brings the 10 groups into view: nothing drawn while the camera moves.
		layer.paint(at1, [first, ...groups], false, undefined, SIZE, layer.stillAt(at1));
		expect([n.draws, layer.buildWaits], "premise: the moving frame draws no tile").toEqual([7, true]);
		const per: number[] = [], waits: boolean[] = [];
		for (let i = 0; i < 8 && (per.length === 0 || layer.buildWaits); i++) {
			const before = n.draws, byPath = layer.counts.byPathStrokes;
			layer.paint(at1, [first, ...groups], false, undefined, SIZE, layer.stillAt(at1));
			per.push(n.draws - before);
			waits.push(layer.buildWaits);
			if (i === 0) expect(layer.counts.byPathStrokes > byPath, "the first still paint draws the undrawn tiles' strokes by path").toBe(true);
		}
		expect(Math.max(...per), `no paint draws past 16 tiles: ${JSON.stringify(per)}`).toBeLessThanOrEqual(16);
		expect(waits[0], "the first still paint asks another frame").toBe(true);
		expect([per.length, per.reduce((a, b) => a + b, 0), layer.buildWaits], `all 70 drawn within ceil(70 / 16) = 5 paints: ${JSON.stringify(per)}`).toEqual([5, 70, false]);
		// Nothing left: a further paint draws nothing.
		layer.paint(at1, [first, ...groups], true, undefined, SIZE, layer.stillAt(at1));
		expect(n.draws, "a paint with nothing waiting draws no tile").toBe(77);
	});

	it("S3b: a fling resumed mid-build draws no tile; the next still paint carries on", () => {
		const n = { draws: 0 };
		const layer = new AttachedLayer(fakeCanvas(), fakeCanvas(), () => countedCanvas(n));
		const groups = Array.from({ length: 10 }, (_, j) => sevenTiles(`att-${j + 1}`, 30 + j * 20));
		const at0 = { x: 0, y: 0, zoom: 1 }, at1 = { x: 0, y: 20, zoom: 1 };
		layer.paint(at0, groups, false, undefined, SIZE, layer.stillAt(at0));
		expect([n.draws, layer.buildWaits], "premise: the load draws 16 and waits").toEqual([16, true]);
		layer.paint(at1, groups, false, undefined, SIZE, layer.stillAt(at1));
		expect([n.draws, layer.buildWaits], "the resumed fling draws no tile and still waits").toEqual([16, true]);
		layer.paint(at1, groups, false, undefined, SIZE, layer.stillAt(at1));
		expect(n.draws, "the still paint draws the next 16").toBe(32);
	});
});

describe("a first read goes in at its store depth", () => {
	it("S4: after a first read the index orders the note as a rebuild of it does", () => {
		// Defect: a first-read member went in at depth 0, under every stroke before it in the store.
		const DOC = "Intro line.\nThe word benzene here.\nLast line.\n", from = DOC.indexOf("benzene"), path = "attach-depth.md";
		const record: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: 80 }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 10, y: 89 } };
		const anchors = new LineAnchors(() => null), follow = anchors.follow;
		follow.setList([record]);
		// Store order: free a, member s1, free b, member s2, free c; all in one rect.
		const src = [strokeAt("a", 10, 90), strokeAt("s1", 12, 85), strokeAt("b", 14, 95), strokeAt("s2", 16, 90), strokeAt("c", 18, 100)];
		const index = new StrokeIndex();
		const rebuild = () => {
			const list = anchors.strokesFor(path, src);
			const order = (anchors as unknown as { storeOrder?: (l: readonly InkStroke[]) => { depths: readonly number[] | null; pending: ReadonlyMap<InkStroke, number> | null } | null }).storeOrder?.(list);
			index.rebuild(list, order?.depths, order?.pending);
			return list;
		};
		expect(rebuild().map((s) => s.id), "premise: the members are pending, out of the index").toEqual(["a", "b", "c"]);
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		Object.assign(overlay, {
			lineAnchorState: anchors, indexDirty: false, strokeIndex: index,
			attachedLayer: { stillAt: () => true, moved: () => {}, invalidate: () => {} },
			camera: { snapshot: { x: 0, y: 0, zoom: 1 } },
			frontierCache: { invalidate: () => {} },
			scheduleRepaint: () => {},
			lineAnchorsMoved: () => {},
		});
		const before = follow.snapshot();
		follow.measure({ inView: () => true, refAt: () => ({ x: 0, y: 92 }), blockTop: () => 80 });
		overlay.followMoved(path, before);
		expect((overlay as unknown as { indexDirty: boolean }).indexDirty, "premise: the first read edited the index, no rebuild").toBe(false);
		const rect = { x: -100, y: -100, width: 400, height: 400 };
		const afterRead = index.query(rect).map((s) => s.id);
		rebuild();
		const afterRebuild = index.query(rect).map((s) => s.id);
		expect(afterRebuild, "premise: the rebuild orders by store").toEqual(["a", "s1", "b", "s2", "c"]);
		expect(afterRead, "the first read's order equals the rebuild's").toEqual(afterRebuild);
	});
});

describe("a follow move that cannot be told exactly still re-places the rows at idle", () => {
	it("S5: movesAndFirsts null: the attached layer paints whole, the index is marked, and the rows idle is scheduled", () => {
		// Defect: the unknown-move arm returns before scheduleRowsIdle, so the first hover after such a move re-places the rows.
		const DOC = "Intro line.\nThe word benzene here.\nLast line.\n", from = DOC.indexOf("benzene");
		const record: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1"], target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: 80 }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 10, y: 89 } };
		const anchors = new LineAnchors(() => null), follow = anchors.follow;
		follow.setList([record]);
		const calls: string[] = [];
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		Object.assign(overlay, {
			lineAnchorState: anchors, indexDirty: false,
			attachedLayer: { stillAt: () => true, moved: () => calls.push("moved"), invalidate: (why: string) => calls.push("invalidate:" + why) },
			camera: { snapshot: { x: 0, y: 0, zoom: 1 } },
			frontierCache: { invalidate: () => {} },
			scheduleRepaint: (via?: string) => calls.push("repaint:" + (via ?? "other")),
			scheduleRowsIdle: () => calls.push("rowsIdle"),
			lineAnchorsMoved: () => calls.push("membership"),
		});
		const before = follow.snapshot();
		(follow as unknown as { movesAndFirsts: () => null }).movesAndFirsts = () => null;
		overlay.followMoved("attach-unknown-move.md", before);
		expect((overlay as unknown as { indexDirty: boolean }).indexDirty, "the index waits for a rebuild").toBe(true);
		expect(calls, "the layer whole, a partial repaint, and the rows idle").toEqual(["invalidate:follow", "repaint:partial", "rowsIdle"]);
	});
});

describe("a sprite lives while the attachments list holds its group", () => {
	it("S6: a drag that hides groups keeps their sprites; the release builds none; a group leaving the list drops its sprite", () => {
		// Defect: each paint drops the sprite of every group it does not draw, so a drag that lifts 9 groups makes the release
		// rebuild 9 sprites (58 tiles, 4.6 M px in row 9).
		const layer = new AttachedLayer(fakeCanvas(), fakeCanvas(), fakeCanvas);
		const a = group("att-1", [strokeAt("s1", 10, 20)]), b = group("att-2", [strokeAt("s2", 10, 60)]), c = group("att-3", [strokeAt("s3", 10, 100)]);
		const at = { x: 0, y: 0, zoom: 1 }, all = new Set(["att-1", "att-2", "att-3"]);
		layer.paint(at, [a, b, c], false, undefined, SIZE, layer.stillAt(at), all);
		layer.paint(at, [a, b, c], true, undefined, SIZE, layer.stillAt(at), all);
		expect(layer.counts.built, "premise: three sprites built").toBe(3);
		// The drag lifts b, then every group; each paint draws only what is not lifted.
		layer.paint(at, [a, c], true, undefined, SIZE, layer.stillAt(at), all);
		layer.paint(at, [], true, undefined, SIZE, layer.stillAt(at), all);
		// The release: all three drawn again.
		layer.paint(at, [a, b, c], true, undefined, SIZE, layer.stillAt(at), all);
		expect(layer.counts.built, "the release builds no sprite").toBe(3);
		// b's record leaves the list: its sprite goes, and coming back builds it once.
		layer.paint(at, [a, c], true, undefined, SIZE, layer.stillAt(at), new Set(["att-1", "att-3"]));
		layer.paint(at, [a, b, c], true, undefined, SIZE, layer.stillAt(at), all);
		expect(layer.counts.built, "a group back in the list builds once").toBe(4);
	});
});

describe("a moved group never shown is a first read", () => {
	it("S7: an Enter above a group shown only as stored: no whole layer paint, no index rebuild, the index hits it at its shown place", () => {
		// Defect: every correction 0, the surface takes the store's own list and never asks shown(); the Enter's move then
		// finds no member shown, cannot be told, and the attached layer paints whole and the index rebuilds (row 9, row 1).
		const DOC = "Intro line.\nThe word benzene here.\nLast line.\n", from = DOC.indexOf("benzene"), path = "attach-unseen.md";
		const record: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: 80 }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 12, y: 89 } };
		const anchors = new LineAnchors(() => null), follow = anchors.follow;
		follow.setList([record]);
		const src = [strokeAt("a", 10, 20), strokeAt("s1", 12, 85), strokeAt("s2", 16, 90)];
		// The store holds the note's strokes: the move reads the group's members as stored from it.
		inlineInk.record(path).strokes = src;
		follow.measure({ inView: () => true, refAt: () => ({ x: 0, y: 80 }), blockTop: () => 80 });
		expect(anchors.strokesFor(path, src), "premise: every correction 0, the store's own list").toBe(src);
		const index = new StrokeIndex();
		index.rebuild(src);
		const calls: string[] = [], rects: { y: number; height: number }[] = [];
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		Object.assign(overlay, {
			lineAnchorState: anchors, indexDirty: false, strokeIndex: index,
			attachedLayer: { stillAt: () => true, moved: (r: { y: number; height: number }[]) => { calls.push("moved"); rects.push(...r); }, invalidate: (why: string) => calls.push("invalidate:" + why) },
			camera: { snapshot: { x: 0, y: 0, zoom: 1 } },
			frontierCache: { invalidate: () => {} },
			scheduleRepaint: () => {},
			scheduleRowsIdle: () => {},
			lineAnchorsMoved: () => calls.push("membership"),
		});
		const before = follow.snapshot();
		follow.layoutChanged();
		follow.measure({ inView: () => true, refAt: () => ({ x: 0, y: 110 }), blockTop: () => 80 });
		expect(follow.groupOffset("att-1"), "premise: the Enter moved the group 30 down").toEqual({ dx: 0, dy: 30 });
		overlay.followMoved(path, before);
		expect([(overlay as unknown as { indexDirty: boolean }).indexDirty, calls], "no rebuild; one rect to the layer, no whole paint").toEqual([false, ["moved"]]);
		expect(rects.some((r) => r.y <= 115 && r.y + r.height >= 122), "the layer takes the group's box at its shown place").toBe(true);
		const at = (y: number) => index.query({ x: -100, y, width: 400, height: 12 }).filter((s) => s.id !== "a").map((s) => [s.id, s.points[0]!.y]);
		expect(at(112), "the index hits the members at their shown place").toEqual([["s1", 115], ["s2", 120]]);
		expect(at(82), "and no longer where they are stored").toEqual([]);
	});
});

describe("a held group moved whole keeps its sprite", () => {
	it("S8: every member moved in place by dy and the layer told: the next paint builds nothing, the sprite dy lower", () => {
		// Defect: Insert Space over a held group moves its members in the store; their revisions change and the release
		// draws the whole sprite again (8 tiles, 0.9 M px in row 9).
		const layer = new AttachedLayer(fakeCanvas(), fakeCanvas(), fakeCanvas);
		const ms = [strokeAt("h1", 10, 40), strokeAt("h2", 30, 44)], held = group("att-held", ms);
		const at = { x: 0, y: 0, zoom: 1 }, keep = new Set(["att-held"]);
		layer.paint(at, [held], false, undefined, SIZE, layer.stillAt(at), keep);
		layer.paint(at, [held], true, undefined, SIZE, layer.stillAt(at), keep);
		const box0 = (layer as unknown as { sprites: Map<string, { box: { y: number } }> }).sprites.get("att-held")!.box.y;
		expect(layer.counts.built, "premise: one sprite").toBe(1);
		for (const s of ms) translateStroke(s, 0, 25);
		layer.translated("att-held", 25);
		layer.paint(at, [held], true, undefined, SIZE, layer.stillAt(at), keep);
		const box1 = (layer as unknown as { sprites: Map<string, { box: { y: number } }> }).sprites.get("att-held")!.box.y;
		expect([layer.counts.built, layer.counts.translated, box1 - box0], "no build; the sprite 25 lower").toEqual([1, 1, 25]);
		// A member changed some other way (no tell): drawn again, as before.
		translateStroke(ms[0]!, 3, 0);
		layer.paint(at, [held], true, undefined, SIZE, layer.stillAt(at), keep);
		expect(layer.counts.built, "an untold change draws the sprite again").toBe(2);
	});
});

describe("selection bounds read the selected strokes only", () => {
	it("S9: bounds visit the selected ids, never the note; a second ask is kept; a member is boxed where it shows", async () => {
		// Defect: selectionBounds walks the shown list of every stroke (28k), and building that list after the release's
		// store move costs 4 ms in the groups arm.
		const { SelectionModel } = await import("../objects/SelectionModel");
		const DOC = "Intro line.\nThe word benzene here.\nLast line.\n", from = DOC.indexOf("benzene"), path = "attach-selbounds.md";
		const record: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1"], target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: 80 }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 12, y: 89 } };
		const anchors = new LineAnchors(() => null), follow = anchors.follow;
		follow.setList([record]);
		const src = [...Array.from({ length: 200 }, (_, i) => strokeAt("f" + i, 10, 300 + i)), strokeAt("s1", 12, 85), strokeAt("x", 40, 20)];
		inlineInk.record(path).strokes = src;
		follow.measure({ inView: () => true, refAt: () => ({ x: 0, y: 110 }), blockTop: () => 80 });
		const selection = new SelectionModel();
		selection.selectExactly(["s1", "x"]);
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		Object.assign(overlay, { lineAnchorState: anchors, selection, filePath: () => path, dragBox: null, spaceSnapshot: null });
		const box = overlay.selectionBounds()!;
		const c = (overlay as unknown as { selBoundsCounts: { calls: number; kept: number; visited: number; selected: number } }).selBoundsCounts;
		expect([c.visited, c.selected], "the two selected ids, not 202 strokes").toEqual([2, 2]);
		expect([box.y <= 20, box.y + box.height >= 115 + 2], "s1 boxed at its shown place (30 down), x at its own").toEqual([true, true]);
		overlay.selectionBounds();
		expect([c.kept, c.visited], "the second ask is kept").toEqual([1, 2]);
		selection.selectExactly(["x"]);
		overlay.selectionBounds();
		expect(c.visited, "a new selection is read again").toBe(3);
	});
});
/**
 * A group shown at a correction, then an Enter above it: the told move from 30 to 60. The members sit
 * near y 200, so the move takes them across the index's bucket edge at 256.
 */
function toldRig(path: string) {
	const DOC = "Intro line.\nThe word benzene here.\nLast line.\n", from = DOC.indexOf("benzene");
	const record: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: 80 }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 12, y: 89 } };
	const anchors = new LineAnchors(() => null), follow = anchors.follow;
	follow.setList([record]);
	// Free ink in 20 more buckets, so a query of a few cells walks its cells, not every bucket.
	const src = [strokeAt("a", 10, 20), strokeAt("s1", 12, 200), strokeAt("s2", 16, 205), ...Array.from({ length: 20 }, (_, i) => strokeAt("f" + i, i * 300, 600 + i * 300))];
	inlineInk.record(path).strokes = src;
	follow.measure({ inView: () => true, refAt: () => ({ x: 0, y: 110 }), blockTop: () => 80 });
	const shown = anchors.strokesFor(path, src);
	const index = new StrokeIndex();
	index.rebuild(shown);
	const calls: string[] = [];
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors, indexDirty: false, strokeIndex: index,
		attachedLayer: { stillAt: () => true, moved: () => calls.push("moved"), invalidate: (why: string) => calls.push("invalidate:" + why) },
		camera: { snapshot: { x: 0, y: 0, zoom: 1 } },
		frontierCache: { invalidate: () => {} },
		scheduleRepaint: () => {},
		scheduleRowsIdle: () => {},
		lineAnchorsMoved: () => calls.push("membership"),
	});
	const enter = () => {
		const before = follow.snapshot();
		follow.layoutChanged();
		follow.measure({ inView: () => true, refAt: () => ({ x: 0, y: 140 }), blockTop: () => 80 });
		overlay.followMoved(path, before);
	};
	return { anchors, follow, src, shown, index, overlay, calls, enter };
}

describe("a told move is the group's: the shown copies move in place", () => {
	it("S10: an Enter moves the same copies; no pair is built; the index and the eraser find each member where it shows", () => {
		// Defect: a told move builds a pair and a new copy per member (row 1b at 2.4 us per member against 2.0), or the copy
		// moves but its index entry stays in the old bucket, so lasso and eraser miss it where it shows.
		const { follow, src, shown, index, overlay, calls, enter } = toldRig("attach-told.md");
		const held = shown.filter((s) => s.id.startsWith("s"));
		expect(held.map((s) => s.bbox.y - src.find((t) => t.id === s.id)!.bbox.y), "premise: the group shown 30 down").toEqual([30, 30]);
		const y0 = held[0]!.points[0]!.y;
		const pairs = follow.moveCounts.pairs;
		enter();
		expect(follow.groupOffset("att-1"), "premise: the Enter moved the group to 60").toEqual({ dx: 0, dy: 60 });
		const at = (y: number) => index.query({ x: -100, y, width: 400, height: 6 }).filter((s) => s.id.startsWith("s"));
		const now = at(src[1]!.bbox.y + 61);
		expect([now[0] === held[0], now[1] === held[1]], "the index holds the same copies, moved").toEqual([true, true]);
		expect([follow.moveCounts.pairs - pairs, follow.moveCounts.groups], "no member pair; one group").toEqual([0, 1]);
		expect([(overlay as unknown as { indexDirty: boolean }).indexDirty, calls], "no rebuild; one rect to the layer").toEqual([false, ["moved"]]);
		expect(at(src[1]!.bbox.y + 31), "nothing left at the old place").toEqual([]);
		expect(held[0]!.points[0]!.y - y0, "points read again at the new place").toBeCloseTo(30, 9);
		const p = src[1]!.points[0]!, hit = (dy: number) => strokesHitByCircle(index.query(eraserRect(p.x, p.y + dy, 2)), p.x, p.y + dy, 2);
		expect([hit(60).includes("s1"), hit(30).includes("s1")], "the eraser takes s1 where it shows, not where it was").toEqual([true, false]);
	});
});

describe("a moved copy draws at its new place", () => {
	it("S11: a by-path draw after an Enter flattens the moved copy again and paints it 30 lower", () => {
		// Defect: the copy moves in place under its old revision, and the ribbon cache paints it where it was.
		const { shown, enter } = toldRig("attach-told-draw.md");
		const copy = shown.find((s) => s.id === "s1")!;
		const ys: number[] = [];
		const ctx = new Proxy({} as Record<string, unknown>, {
			get: (target, key) => (key in target ? target[key as string] : key === "moveTo" || key === "lineTo" || key === "arc" ? (_x: number, y: number) => { ys.push(y); } : () => undefined),
			set: (target, key, value) => { target[key as string] = value; return true; },
		}) as unknown as CanvasRenderingContext2D;
		const cam = { x: 0, y: 0, zoom: 1 };
		drawStroke(ctx, cam, copy, undefined, true);
		const top0 = Math.min(...ys), f0 = ribbonCacheStats().flattens;
		expect(ys.length, "premise: the ribbon path drew").toBeGreaterThan(0);
		ys.length = 0;
		enter();
		drawStroke(ctx, cam, copy, undefined, true);
		expect([ribbonCacheStats().flattens - f0, Math.round(Math.min(...ys) - top0)], "flattened again, 30 lower").toEqual([1, 30]);
	});
});

describe("the rows take a moved copy as a re-place", () => {
	it("S12: the rows ask after an Enter: replaces 1, rebuilds 0", () => {
		// Defect: the rows cache sees the same copy at a new revision and reads every stroke again.
		const { anchors, src, shown, enter } = toldRig("attach-told-rows.md");
		const rows = new InsertSpaceRows();
		rows.get(shown);
		expect(rows.counts.rebuilds, "premise: one full read").toBe(1);
		enter();
		const after = anchors.strokesFor("attach-told-rows.md", src);
		expect(after.find((s) => s.id === "s1"), "premise: the same copy is shown").toBe(shown.find((s) => s.id === "s1"));
		rows.get(after);
		expect([rows.counts.replaces, rows.counts.rebuilds - 1]).toEqual([1, 0]);
	});
});

describe("a first read while the camera moves goes in the index at the still paint", () => {
	it("S13: a fling's first read leaves the index as it was; the still paint puts the members in, ordered as a rebuild", () => {
		// Defect: the fling frame that reads a group inserts every member in the index (insertFirst 0.9 ms in row 3's slowest
		// frames), work the still paint after the fling can do.
		const DOC = "Intro line.\nThe word benzene here.\nLast line.\n", from = DOC.indexOf("benzene"), path = "attach-moving.md";
		const record: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + 7, "range"), ref: { x: 0, y: 80 }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 10, y: 89 } };
		const anchors = new LineAnchors(() => null), follow = anchors.follow;
		follow.setList([record]);
		const src = [strokeAt("a", 10, 90), strokeAt("s1", 12, 85), strokeAt("b", 14, 95), strokeAt("s2", 16, 90), strokeAt("c", 18, 100)];
		const index = new StrokeIndex();
		const rebuild = () => {
			const list = anchors.strokesFor(path, src);
			const order = (anchors as unknown as { storeOrder?: (l: readonly InkStroke[]) => { depths: readonly number[] | null; pending: ReadonlyMap<InkStroke, number> | null } | null }).storeOrder?.(list);
			index.rebuild(list, order?.depths, order?.pending);
		};
		rebuild();
		let still = false;
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		Object.assign(overlay, {
			lineAnchorState: anchors, indexDirty: false, strokeIndex: index,
			attachedLayer: { stillAt: () => still, moved: () => {}, invalidate: () => {} },
			camera: { snapshot: { x: 0, y: 0, zoom: 1 } },
			frontierCache: { invalidate: () => {} },
			scheduleRepaint: () => {},
			scheduleRowsIdle: () => {},
			lineAnchorsMoved: () => {},
		});
		const rect = { x: -100, y: -100, width: 400, height: 400 };
		const before = follow.snapshot();
		follow.measure({ inView: () => true, refAt: () => ({ x: 0, y: 92 }), blockTop: () => 80 });
		overlay.followMoved(path, before);
		const o = overlay as unknown as { indexDirty: boolean; firstsWaiting: unknown[] | null };
		expect([o.indexDirty, index.query(rect).map((s) => s.id)], "the moving frame: no rebuild, the index as it was").toEqual([false, ["a", "b", "c"]]);
		expect(o.firstsWaiting?.length, "the two members wait for the still paint").toBe(2);
		still = true;
		overlay.placeFirstsWaiting();
		const placed = index.query(rect).map((s) => s.id);
		rebuild();
		expect([o.firstsWaiting, placed], "the still paint: the members in, in the order a rebuild gives").toEqual([null, index.query(rect).map((s) => s.id)]);
		expect(placed, "premise: the rebuild holds the members").toEqual(["a", "s1", "b", "s2", "c"]);
	});
});

describe("a build in the stand-in's pieces takes a camera a hair off the last paint as still", () => {
	it("S14: buildIn at a camera 4e-7 world units off the last whole paint builds the sprite off the view, on the layer's backing or another", () => {
		// Defect: a landing on a stand-in recomputes the camera about 4e-6 world units off where the layer painted; the exact
		// still test then refused the build, so groups past the old view had no sprite at the first preview frame of the next run.
		const off = { x: 0, y: 4e-7, zoom: 1 };
		const rect = { x: 0, y: 1500, width: 400, height: 1000 };
		const builds = (backing: number) => {
			const layer = new AttachedLayer(fakeCanvas(), fakeCanvas(), fakeCanvas);
			const a = group("att-1", [strokeAt("s1", 10, 20)]), b = group("att-2", [strokeAt("s2", 10, 2000)]);
			const at0 = { x: 0, y: 0, zoom: 1 };
			layer.paint(at0, [a, b], false, undefined, SIZE, layer.stillAt(at0));
			const before = layer.counts.built;
			const waits = layer.buildIn(off, [a, b], rect, undefined, backing, () => true);
			return [before, layer.counts.built, waits];
		};
		expect(off.y * off.zoom * SIZE.backing, "premise: the camera is off by far under 1/16 device px").toBeLessThan(1 / 16);
		expect(builds(SIZE.backing), "the layer's backing: b off the view is built, a only by the paint").toEqual([1, 2, false]);
		expect(builds(3), "a build backing other than the layer's still builds b").toEqual([1, 2, false]);
	});
});

describe("held tiles sit where the last whole paint copied them", () => {
	it("S15: heldTiles at a camera 4e-7 world units off the last whole paint on either axis, the sprite's place at .5 device px on both, places each tile where the paint did", () => {
		// Defect: heldTiles rounded each tile's place from the camera it was given and paint() from where it painted; with the
		// sprite's place at .5 device px a camera a hair off rounds the other way, and the held tile sits 1 device px off the paint.
		// One camera off on each axis alone, so either axis going back to the camera fails here.
		const layer = new AttachedLayer(fakeCanvas(), fakeCanvas(), fakeCanvas);
		const a = group("att-1", [strokeAt("s1", 10, 20)]);
		const at0 = { x: 0, y: 0, zoom: 1 };
		layer.paint(at0, [a], false, undefined, SIZE, layer.stillAt(at0));
		const sp = (layer as unknown as { sprites: Map<string, { ox: number; oy: number }> }).sprites.get("att-1")!;
		// A whole paint with the sprite 20.5 device px right of and below the camera: it copies the tiles at Math.round(20.5) = 21.
		const at1 = { x: sp.ox - 10.25, y: sp.oy - 10.25, zoom: 1 };
		const offY = { x: at1.x, y: at1.y + 4e-7, zoom: 1 }, offX = { x: at1.x + 4e-7, y: at1.y, zoom: 1 };
		layer.paint(at1, [a], false, undefined, SIZE, layer.stillAt(at1));
		const k = at1.zoom * SIZE.backing, rect = { x: at1.x, y: at1.y, width: 400, height: 300 };
		expect([(sp.ox - at1.x) * k, (sp.oy - at1.y) * k, layer.counts.built], "premise: the sprite's place at the paint is at .5 device px on x and y, built once").toEqual([20.5, 20.5, 1]);
		expect(Math.max((offX.x - at1.x) * k, (offY.y - at1.y) * k), "premise: each camera is off by far under 1/16 device px").toBeLessThan(1 / 16);
		const place = (cam: { x: number; y: number; zoom: number }) => layer.heldTiles(cam, [a], rect, undefined, SIZE.backing)?.pen.map((t) => [t.x, t.y]) ?? null;
		const atPaint = place(at1);
		expect(atPaint?.length ?? 0, "premise: the paint's camera holds the group's tiles").toBeGreaterThan(0);
		expect(place(offY), "the camera a hair off on y holds them at the paint's device px").toEqual(atPaint);
		expect(place(offX), "the camera a hair off on x holds them at the paint's device px").toEqual(atPaint);
	});
});

describe("the extent build's last piece builds sprites at a camera a hair off the last paint", () => {
	it("S16: the last piece, lastPaintCam 4e-7 world units off the attached layer's last whole paint, builds the group off the view inside the world rect", () => {
		// Defect: the piece gated the build on the exact stillAt(lastPaintCam); a landing on a stand-in leaves the camera about
		// 4e-6 world units off the paint, so the groups past the old view got no sprite before the next run's first preview frame.
		const layer = new AttachedLayer(fakeCanvas(), fakeCanvas(), fakeCanvas);
		const a = group("att-1", [strokeAt("s1", 10, 20)]), b = group("att-2", [strokeAt("s2", 10, 2000)]);
		const at0 = { x: 0, y: 0, zoom: 1 }, off = { x: 0, y: 4e-7, zoom: 1 };
		layer.paint(at0, [a, b], false, undefined, SIZE, layer.stillAt(at0));
		const o = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
		const asked: string[] = [];
		const build = {
			path: "extent-piece.md", cam0: { ...at0 }, at: { ...at0 }, kx: 1, ky: 1, w: 800, h: 600, world: { x0: 0, y0: 1500, x1: 400, y1: 2500 },
			backing: SIZE.backing, dpr: 1, look: 0, floor: undefined, strokes: [], count: 0, generation: 0, hasHl: false,
			pen: fakeCanvas(), hl: null, next: 0, timer: 0, shownMoves: 0,
		};
		// Own properties, as the overlay's fields are: no prototype setter runs.
		const fields: Record<string, unknown> = {
			extentBuild: build, retiring: false, extentBuildHolds: () => true, extentPieceAllowed: () => true, attachedLayer: layer,
			lastPaintCam: off, attachedGroups: () => [a, b], committedBacking: SIZE.backing, dpr: 1, extentRaster: null,
			scheduleExtentPiece: () => asked.push("piece"), repaintOverStandIn: () => asked.push("repaint"),
		};
		for (const [key, value] of Object.entries(fields)) Object.defineProperty(o, key, { value, writable: true, configurable: true, enumerable: true });
		expect([layer.live, layer.stillAt(off), layer.counts.built], "premise: painted at at0, the camera not exactly still, a built alone").toEqual([true, false, 1]);
		(o as unknown as InkOverlayPlugin).runExtentPiece();
		expect([layer.counts.built, o.extentRaster !== null, asked], "the last piece builds b and hands the raster over").toEqual([2, true, ["repaint"]]);
	});
});

describe("a group the view shows without a current sprite holds no tiles note-wide", () => {
	it("S17: an in-view group drawn by path makes heldTiles null though another group's sprite is current", () => {
		// Guard: the hold then leaves the attached canvases shown, as before tiles; leaving the group out would show the others as
		// tiles and this one nowhere, and a fallback per group would paint the others twice.
		const layer = new AttachedLayer(fakeCanvas(), fakeCanvas(), fakeCanvas);
		const a = group("att-1", [strokeAt("s1", 10, 150)]), b = group("att-2", [strokeAt("s2", 10, 350)]);
		const at0 = { x: 0, y: 0, zoom: 1 }, at1 = { x: 0, y: 100, zoom: 1 }, view1 = { x: 0, y: 100, width: 400, height: 300 };
		layer.paint(at0, [a], false, undefined, SIZE, layer.stillAt(at0));
		const moving = layer.stillAt(at1), byPath = layer.counts.byPath;
		layer.paint(at1, [a, b], false, undefined, SIZE, moving);
		expect([moving, layer.counts.built, layer.counts.byPath > byPath], "premise: a moving whole paint draws b by path, a from its sprite").toEqual([false, 1, true]);
		expect(layer.heldTiles(at1, [a], view1, undefined, SIZE.backing)?.pen.length ?? 0, "premise: a alone holds tiles").toBeGreaterThan(0);
		expect(layer.heldTiles(at1, [a, b], view1, undefined, SIZE.backing), "b by path in the view: no tiles").toBeNull();
	});

	it("S17b: an in-view group with tiles pending makes heldTiles null though the other groups' sprites are current", () => {
		const at0 = { x: 0, y: 0, zoom: 1 }, view0 = { x: 0, y: 0, width: 400, height: 300 };
		const capped = new AttachedLayer(fakeCanvas(), fakeCanvas(), fakeCanvas);
		const groups = [sevenTiles("att-p0", 10), sevenTiles("att-p1", 30), sevenTiles("att-p2", 50)];
		capped.paint(at0, groups, false, undefined, SIZE, capped.stillAt(at0));
		const pending = (capped as unknown as { sprites: Map<string, { pending: number }> }).sprites.get("att-p2")?.pending ?? 0;
		expect([capped.buildWaits, pending > 0], "premise: the tile cap leaves the third group's tiles pending").toEqual([true, true]);
		expect(capped.heldTiles(at0, groups.slice(0, 2), view0, undefined, SIZE.backing)?.pen.length ?? 0, "premise: the first two hold tiles").toBeGreaterThan(0);
		expect(capped.heldTiles(at0, groups, view0, undefined, SIZE.backing), "the third pending in the view: no tiles").toBeNull();
	});
});
