/**
 * A pan bake below 100 percent carries its pixels on a note with attached ink. The repaint paints the free ink less a
 * drag's moving strokes (InkOverlayRepaint.ts: committedStrokes(freeStrokes(path))), records that count, and hands the
 * same count to carryBakedPan. The bake's target (rasterPanTarget) snaps to whole backing px only when bakeCanCarry
 * says the carry will run, so both must read one count. Counting every stroke on the note never matched once a group
 * was attached: each bake past the top edge went to the exact pan and redrew the whole layer (Orion, 34 percent:
 * 130 to 270 ms against 2.5 to 16 ms).
 *
 * Each cell does the bake's two steps as repaint() does them: rasterPan = rasterPanTarget(), the camera moves by the
 * baked pan over the font zoom (syncCamera), then carryBakedPan(cam, committedStrokes(freeStrokes(path)).length).
 * Real: rasterPanTarget, bakeCanCarry, carryBakedPan, slideCommittedPixels, freeStrokes, committedStrokes, LineAnchors.
 * Synthetic: a bare overlay, canvases that record their drawImage calls, an attached layer that records any call, and
 * the count the last whole paint left (paintedStrokeCount), set to the length of the list the repaint paints.
 * Not device acceptance.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINES = 40, LH = 40;
const START = Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`).join("\n");
/** 50 percent on a 2x screen: one backing px per layout px. */
const ZOOM = 0.5, BACKING = 1;
/** The page held 37.3 css px past its top edge: 74.6 layout px of pan, not a whole backing px. */
const PAST_TOP = 37.3;
const LAST = { x: 0, y: 100, zoom: ZOOM };

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

type Opts = { attached: boolean; lassoIds?: readonly string[] };

function rig(path: string, opts: Opts) {
	const from = START.indexOf("line 10 words");
	const group: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["g1"], target: targetAt(START, from, from + 13, "range"), ref: { x: 0, y: 9 * LH }, layout: { width: 892, font: 26 }, probe: { id: "g1", x: 10, y: 9 * LH + 5 } };
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: opts.attached ? [group] : [] };
	rec.strokes = [strokeAt("g1", 10, 9 * LH + 1), strokeAt("f1", 10, 20 * LH + 1), strokeAt("f2", 60, 22 * LH + 1)];
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
	const state = { doc: Text.of(START.split("\n")) };
	const layout = (): LineLayout => ({ lines: state.doc.lines, lineText: (n) => state.doc.line(n).text, lineTop: (n) => (n - 1) * LH, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature(SIG);
	anchors.drawn(1, LINES);
	anchors.drawn(1, LINES, true, true);
	anchors.strokesFor(path, inlineInk.strokes(path));
	const slid: string[] = [];
	const ctxFor = (name: string) => ({
		globalCompositeOperation: "source-over",
		save: () => {}, restore: () => {}, setTransform: () => {},
		drawImage: (_c: unknown, x: number, y: number) => slid.push(`${name} ${x},${y}`),
	});
	const attachedCalls: string[] = [];
	const attachedLayer = new Proxy({}, { get: (_t, key) => (...args: unknown[]) => { attachedCalls.push(`${String(key)}(${args.length})`); } });
	const damage: unknown[] = [];
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin & Record<string, unknown>;
	Object.assign(overlay, {
		lineAnchorState: anchors,
		fontZoom: ZOOM,
		cssScale: ZOOM,
		cssWidth: 800,
		cssHeight: 1000,
		dpr: 2,
		committedBacking: BACKING,
		rasterPan: { x: 0, y: 0 },
		viewportPan: { x: 0, y: PAST_TOP },
		lastPaintCam: { ...LAST },
		camera: { snapshot: { ...LAST } },
		spaceSnapshot: opts.lassoIds ? { kind: "lasso", col: 0, ids: new Set(opts.lassoIds), source: [], staying: [] } : null,
		committedCanvas: { width: 1600, height: 2000 },
		highlightCanvas: { width: 1600, height: 2000 },
		committedCtx: ctxFor("committed"),
		highlightCtx: ctxFor("highlight"),
		highlightPairDeferred: false,
		attachedLayer,
		damage: { addRect: (r: unknown) => damage.push(r), addAll: () => damage.push("all") },
		view: { scaleY: 1, state, lineBlockAt: (pos: number) => ({ top: (state.doc.lineAt(pos).number - 1) * LH, bottom: state.doc.lineAt(pos).number * LH }), dispatch: () => {} },
		filePath: () => path,
		requestFollowMeasure: () => {},
		scheduleRepaint: () => {},
	});
	anchors.follow.setList(inlineInk.attachments(path));
	if (opts.attached) anchors.follow.attached(group, 9 * LH);
	/** The list the repaint paints, as InkOverlayRepaint.ts reads it. */
	const painted = () => overlay.committedStrokes(overlay.freeStrokes(path));
	// The last whole paint put that list on the raster (paintCommittedWork "all" sets the count from it).
	overlay.paintedStrokeCount = painted().length;
	/** The bake, as repaint() runs it: the target, the camera at the baked pan, then the carry. */
	const bake = () => {
		const exact = { x: overlay.restPanX() / ZOOM, y: overlay.restPanY() / ZOOM };
		const to = overlay.rasterPanTarget();
		overlay.rasterPan = to;
		const cam = { x: LAST.x - to.x / ZOOM, y: LAST.y - to.y / ZOOM, zoom: ZOOM };
		(overlay.camera as { snapshot: typeof cam }).snapshot = cam;
		overlay.carryBakedPan(cam, painted().length);
		return { exact, to, cam };
	};
	return { overlay, bake, slid, attachedCalls, damage, painted, path };
}

describe("a pan bake below 100 percent carries on a note with attached ink", () => {
	it("free strokes and one attached stroke, page past the top edge: the target snaps and the carry runs", () => {
		const r = rig("bake-carry-attached.md", { attached: true });
		expect(inlineInk.strokes(r.path).length, "premise: three strokes on the note").toBe(3);
		expect(r.painted().map((s) => s.id), "premise: the raster holds the free ink only").toEqual(["f1", "f2"]);
		const { exact, to, cam } = r.bake();
		expect(exact.y, "premise: the resting pan is not a whole backing px").toBeCloseTo(74.6, 9);
		expect(to, "the target snaps to whole backing px").toEqual({ x: 0, y: 75 });
		expect(r.slid, "the carry slid the committed and highlight layers by 75 backing px").toEqual(["committed 0,75", "highlight 0,75"]);
		expect(r.overlay.lastPaintCam, "the carry recorded the camera the slid pixels sit at").toEqual(cam);
		expect(r.damage.length, "only the strip the slide uncovers is owed").toBeGreaterThan(0);
		expect(r.damage, "no whole-layer damage").not.toContain("all");
	});

	it("control: attached ink is not on the carried layers; the carry makes no call on the attached layer", () => {
		const r = rig("bake-carry-attached-layer.md", { attached: true });
		r.bake();
		expect(r.slid.length, "premise: the carry ran").toBe(2);
		expect(r.slid.every((s) => s.startsWith("committed ") || s.startsWith("highlight ")), "only the free-ink layers slide").toBe(true);
		expect(r.attachedCalls, "the attached layer is left to its own paint at the camera now").toEqual([]);
	});

	it("control: a free-only note, page past the top edge: the target snaps and the carry runs", () => {
		const r = rig("bake-carry-free.md", { attached: false });
		expect(r.painted().length, "premise: every stroke is free").toBe(3);
		const { to } = r.bake();
		expect(to).toEqual({ x: 0, y: 75 });
		expect(r.slid).toEqual(["committed 0,75", "highlight 0,75"]);
	});

	it("a lasso drag on a free-only note: the raster holds the strokes that stay; the target snaps and the carry runs", () => {
		const r = rig("bake-carry-lasso.md", { attached: false, lassoIds: ["f1"] });
		expect(r.painted().map((s) => s.id), "premise: the moving stroke is off the raster").toEqual(["g1", "f2"]);
		const { to } = r.bake();
		expect(to, "the target snaps to whole backing px").toEqual({ x: 0, y: 75 });
		expect(r.slid, "the carry slid the layers").toEqual(["committed 0,75", "highlight 0,75"]);
	});

	it("in every state, a snapped target means the carry runs", () => {
		for (const [name, opts] of [["free", { attached: false }], ["attached", { attached: true }], ["lasso", { attached: false, lassoIds: ["f1"] }]] as const) {
			const r = rig(`bake-carry-pair-${name}.md`, opts);
			const { exact, to } = r.bake();
			const snapped = to.x !== exact.x || to.y !== exact.y;
			expect({ name, snapped, carried: r.slid.length > 0 }, `${name}: the target and the carry read one count`).toEqual({ name, snapped, carried: snapped });
		}
	});
});
