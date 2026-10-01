/**
 * Live drags and the live eraser keep every pane's stroke index exact and
 * repaint the other panes of the same note by damage rect.
 *
 * Lasso and insert-space drags marked the index dirty on every pointer
 * sample, so the repaint that followed rebuilt the whole note's index once
 * per frame. The live eraser, the lasso and the space drag asked every OTHER
 * pane showing the note for a full repaint per sample: all of its ink
 * re-rasterized each frame.
 *
 * Rig: two REAL InkOverlayPlugin instances on one note (the constructor
 * registers both; mount stays inert on an empty editor state), the REAL
 * inlineInk store in memory mode, the REAL lassoMove, spaceMove, eraseAt,
 * scheduleRepaint, repaintPath and StrokeIndex. Selection UI and the frame
 * itself are not drawn: `frame()` runs only the index step of the partial
 * repaint (rebuild when dirty), which is the cost being counted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import type { BBox, InkStroke } from "../ink/Stroke";
import { StrokeIndex } from "../ink/StrokeIndex";
import { resetTipModeForTest } from "./TipMode";
import { SelectionModel } from "../objects/SelectionModel";

type Fields = Record<string, any>;
const noop = (): undefined => undefined;
let serial = 0;
const made: Fields[] = [];
const paths = new Set<string>();

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	resetTipModeForTest();
});
afterEach(() => {
	for (const o of made.splice(0)) {
		try { (o.destroy as () => void)(); } catch { /* inert rig: teardown of unmounted parts */ }
	}
	for (const p of paths) inlineInk.handleDelete(p);
	paths.clear();
	vi.unstubAllGlobals();
});

function stroke(id: string, x: number, y: number): InkStroke {
	const points = [];
	for (let i = 0; i <= 10; i++) points.push({ x: x + i * 4, y: y + (i % 2) * 6, pressure: 0.5, t: i * 8 });
	return { id, tool: "pen", color: "#000000", width: 2, points, bbox: { x, y, width: 40, height: 6 }, createdAt: 0 };
}

function overlay(path: string): Fields {
	const win = {
		requestAnimationFrame: () => 1, cancelAnimationFrame: noop, setTimeout: () => 0, clearTimeout: noop,
		devicePixelRatio: 1, getComputedStyle: () => ({ fontSize: "16px" }),
	};
	const view = {
		dom: { isConnected: true, ownerDocument: { defaultView: win }, parentElement: null },
		scrollDOM: { addEventListener: noop, removeEventListener: noop },
		contentDOM: {},
		state: { field: () => undefined },
	};
	const o = new InkOverlayPlugin(view as never) as unknown as Fields;
	made.push(o);
	Object.assign(o, {
		container: {}, scale: 1, cssScale: 1,
		filePath: () => path,
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 } },
		redrawSelectionUI: noop,
		indexDirty: true,
	});
	return o;
}

async function rig(n = 1500) {
	const path = `live-drag-index-${++serial}.md`;
	paths.add(path);
	await inlineInk.ensureLoaded(path);
	const strokes: InkStroke[] = [];
	for (let i = 0; i < n; i++) strokes.push(stroke(`s${i}`, (i % 12) * 50, Math.floor(i / 12) * 30));
	inlineInk.applyAddLive(path, strokes);
	const a = overlay(path), b = overlay(path);
	const rebuilds = new Map<Fields, number>([[a, 0], [b, 0]]);
	for (const o of [a, b]) {
		const idx = o.strokeIndex as StrokeIndex;
		const real = idx.rebuild.bind(idx);
		idx.rebuild = (s) => { rebuilds.set(o, rebuilds.get(o)! + 1); real(s); };
	}
	/** The index step of a partial repaint, on both panes. */
	const frame = () => {
		for (const o of [a, b]) {
			o.repaintQueued = false;
			if (o.indexDirty) { (o.strokeIndex as StrokeIndex).rebuild(inlineInk.strokes(path)); o.indexDirty = false; }
			o.damage.take();
		}
	};
	frame();
	for (const o of [a, b]) rebuilds.set(o, 0);
	/** Each pane's index answers as a fresh rebuild of the store would. */
	const exact = () => {
		const fresh = new StrokeIndex();
		fresh.rebuild(inlineInk.strokes(path));
		for (let k = 0; k < 40; k++) {
			const r: BBox = { x: (k * 37) % 600, y: (k * 211) % (n / 12 * 30), width: 90, height: 70 };
			const want = fresh.query(r).map((s) => s.id).sort();
			for (const o of [a, b]) {
				expect((o.strokeIndex as StrokeIndex).query(r).map((s) => s.id).sort(), `rect ${k}`).toEqual(want);
			}
		}
	};
	return { path, a, b, rebuilds, frame, exact };
}

const sample = (x: number, y: number) => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

describe("live drags keep every pane's index exact without a per-frame rebuild", () => {
	it("lasso drag: no rebuild on either pane, the other pane repaints by rect, both indexes exact", async () => {
		const r = await rig();
		const ids = Array.from({ length: 24 }, (_, i) => `s${i}`);
		Object.assign(r.a, {
			selection: { strokeIds: ids, bounds: () => ({ x: 0, y: 0, width: 600, height: 60 }) },
			dragFrom: { x: 100, y: 100 }, dragTotal: { dx: 0, dy: 0 }, dragIds: ids,
		});
		const y0 = inlineInk.strokes(r.path).find((s) => s.id === "s0")!.bbox.y;
		let otherAll = 0;
		for (let i = 1; i <= 20; i++) {
			r.a.lassoMove([sample(100 + i * 3, 100 + i * 7)]);
			if (r.b.damage.isAll) otherAll++;
			r.frame();
		}
		expect(inlineInk.strokes(r.path).find((s) => s.id === "s0")!.bbox.y, "precondition: the drag moved the ink").not.toBe(y0);
		expect({ rebuildsA: r.rebuilds.get(r.a), rebuildsB: r.rebuilds.get(r.b), otherPaneFullRepaints: otherAll })
			.toEqual({ rebuildsA: 0, rebuildsB: 0, otherPaneFullRepaints: 0 });
		r.exact();
	});

	it("insert-space drag moving a tenth of the note: no rebuild on either pane, the other pane repaints by rect, both indexes exact", async () => {
		const r = await rig();
		const ids = Array.from({ length: 150 }, (_, i) => `s${1350 + i}`);
		Object.assign(r.a, {
			spaceLineY: 3365, spaceFromY: 3365, spaceIds: ids, spaceTotalDy: 0,
			spaceBounds: { x: 0, y: 3375, width: 600, height: 375 },
		});
		let otherAll = 0;
		for (let i = 1; i <= 20; i++) {
			r.a.spaceMove([sample(50, 3365 + i * 5)]);
			if (r.b.damage.isAll) otherAll++;
			r.frame();
		}
		expect({ rebuildsA: r.rebuilds.get(r.a), rebuildsB: r.rebuilds.get(r.b), otherPaneFullRepaints: otherAll })
			.toEqual({ rebuildsA: 0, rebuildsB: 0, otherPaneFullRepaints: 0 });
		r.exact();
	});

	it("insert-space drag moving most of the note: one rebuild per frame beats moving each stroke, the other pane still repaints by rect", async () => {
		const r = await rig();
		const ids = Array.from({ length: 900 }, (_, i) => `s${600 + i}`);
		Object.assign(r.a, {
			spaceLineY: 1490, spaceFromY: 1490, spaceIds: ids, spaceTotalDy: 0,
			spaceBounds: { x: 0, y: 1500, width: 600, height: 2250 },
		});
		let otherAll = 0;
		for (let i = 1; i <= 20; i++) {
			r.a.spaceMove([sample(50, 1490 + i * 5)]);
			if (r.b.damage.isAll) otherAll++;
			r.frame();
		}
		expect({ rebuildsA: r.rebuilds.get(r.a), rebuildsB: r.rebuilds.get(r.b), otherPaneFullRepaints: otherAll })
			.toEqual({ rebuildsA: 20, rebuildsB: 20, otherPaneFullRepaints: 0 });
		r.exact();
	});

	it("live partial erase: the other pane repaints by rect and its index stays exact", async () => {
		const r = await rig();
		r.a.eraseWhole = false;
		let otherAll = 0;
		for (let i = 0; i < 20; i++) {
			r.a.eraseAt(sample(10 + i * 6, 3 + (i % 3) * 30));
			if (r.b.damage.isAll) otherAll++;
			r.frame();
		}
		expect(inlineInk.strokes(r.path).length, "precondition: the eraser took or split strokes").not.toBe(1500);
		expect({ rebuildsB: r.rebuilds.get(r.b), otherPaneFullRepaints: otherAll })
			.toEqual({ rebuildsB: 0, otherPaneFullRepaints: 0 });
		r.exact();
	});

	it("a pane whose index is dirty is left to rebuild once, and is exact after it", async () => {
		const r = await rig();
		r.b.indexDirty = true;
		Object.assign(r.a, {
			selection: { strokeIds: ["s0", "s1"], bounds: () => ({ x: 0, y: 0, width: 100, height: 10 }) },
			dragFrom: { x: 0, y: 0 }, dragTotal: { dx: 0, dy: 0 }, dragIds: ["s0", "s1"],
		});
		const y0 = inlineInk.strokes(r.path).find((s) => s.id === "s0")!.bbox.y;
		for (let i = 1; i <= 5; i++) { r.a.lassoMove([sample(i * 10, i * 10)]); r.frame(); }
		expect(inlineInk.strokes(r.path).find((s) => s.id === "s0")!.bbox.y, "precondition: the drag moved the ink").not.toBe(y0);
		expect(r.rebuilds.get(r.b), "one rebuild at the first frame, none after").toBe(1);
		r.exact();
	});
});

/**
 * The other pane's partial repaint draws only its damage rects, so the rects
 * it is handed must cover every stroke the gesture changed, where it was and
 * where it is now. Without them that pane keeps showing moved ink in its old
 * place, or ink already erased.
 */
describe("the other pane is handed rects covering everything a live gesture changed", () => {
	const EPS = 1e-6;
	const covered = (rects: readonly BBox[], b: BBox) => rects.some((r) =>
		r.x <= b.x + EPS && r.y <= b.y + EPS &&
		r.x + r.width >= b.x + b.width - EPS && r.y + r.height >= b.y + b.height - EPS);
	const boxes = (path: string, ids?: ReadonlySet<string>) => new Map(inlineInk.strokes(path)
		.filter((s) => !ids || ids.has(s.id)).map((s) => [s.id, { ...s.bbox }] as const));
	/** Pane B's pending damage for this frame, then the frame itself. */
	const handed = (r: Awaited<ReturnType<typeof rig>>): BBox[] => {
		const got = r.b.damage.take() as "all" | BBox[];
		expect(got, "a full repaint would hide a missing rect").not.toBe("all");
		r.frame();
		return got as BBox[];
	};
	const expectCovered = (rects: BBox[], changed: Iterable<BBox>, what: string) => {
		for (const b of changed) expect(covered(rects, b), `${what}: ${JSON.stringify(b)} not in ${rects.length} rect(s)`).toBe(true);
	};

	it("lasso drag: the moved strokes' old and new boxes", async () => {
		const r = await rig();
		const ids = Array.from({ length: 24 }, (_, i) => `s${i}`);
		const selection = new SelectionModel();
		selection.selectExactly(ids);
		Object.assign(r.a, { selection, dragFrom: { x: 100, y: 100 }, dragTotal: { dx: 0, dy: 0 }, dragIds: ids });
		const set = new Set(ids);
		for (let i = 1; i <= 10; i++) {
			const before = boxes(r.path, set);
			r.a.lassoMove([sample(100 + i * 3, 100 + i * 7)]);
			const after = boxes(r.path, set);
			expect(after.get("s0")!.y, "precondition: the drag moved the ink").not.toBe(before.get("s0")!.y);
			const rects = handed(r);
			expectCovered(rects, before.values(), "old place");
			expectCovered(rects, after.values(), "new place");
		}
	});

	it("insert-space drag: the moved strokes' old and new boxes", async () => {
		const r = await rig();
		// Every stroke below the divider, and their real bounds, as spaceDown would plan them.
		const ids = Array.from({ length: 144 }, (_, i) => `s${1356 + i}`);
		const set = new Set(ids);
		const below = inlineInk.strokes(r.path).filter((s) => set.has(s.id));
		const x0 = Math.min(...below.map((s) => s.bbox.x)), y0 = Math.min(...below.map((s) => s.bbox.y));
		const x1 = Math.max(...below.map((s) => s.bbox.x + s.bbox.width)), y1 = Math.max(...below.map((s) => s.bbox.y + s.bbox.height));
		Object.assign(r.a, {
			spaceLineY: 3380, spaceFromY: 3380, spaceIds: ids, spaceTotalDy: 0,
			spaceBounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
		});
		for (let i = 1; i <= 10; i++) {
			const before = boxes(r.path, set);
			r.a.spaceMove([sample(50, 3380 + i * 5)]);
			const after = boxes(r.path, set);
			expect(after.get(ids[0]!)!.y, "precondition: the drag moved the ink").not.toBe(before.get(ids[0]!)!.y);
			const rects = handed(r);
			expectCovered(rects, before.values(), "old place");
			expectCovered(rects, after.values(), "new place");
		}
	});

	it("live partial erase: the boxes of the strokes it cut or took, and of the pieces it left", async () => {
		const r = await rig();
		r.a.eraseWhole = false;
		let touched = 0;
		for (let i = 0; i < 20; i++) {
			const before = boxes(r.path);
			r.a.eraseAt(sample(10 + i * 6, 3 + (i % 3) * 30));
			const after = boxes(r.path);
			const gone = [...before].filter(([id]) => !after.has(id)).map(([, b]) => b);
			const added = [...after].filter(([id]) => !before.has(id)).map(([, b]) => b);
			touched += gone.length;
			const rects = handed(r);
			expectCovered(rects, gone, "erased");
			expectCovered(rects, added, "piece");
		}
		expect(touched, "precondition: the eraser took or split strokes").toBeGreaterThan(0);
	});
});
