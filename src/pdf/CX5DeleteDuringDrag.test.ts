import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeBBox, InkStroke } from "../ink/Stroke";
import { InkOp } from "../inline/InkHistory";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { PenSample } from "../input/PointerRouter";
import { PageBox } from "./PageMap";

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current, viewerCanvasOf: () => null }));
import { PdfInkController } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";

const sample = (x: number, y: number): PenSample => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

function rig(scale = 2) {
	const points = Array.from({ length: 200 }, (_, i) => ({ x: 100 + (i%11), y: 100 + (i%11), pressure: 0.5, t: i }));
	let ink: InkStroke[] = [{ id: "picked", points, bbox: computeBBox(points, 2), tool: "pen", color: "#000000", width: 2, createdAt: 0, page: 1 }];
		const untouched = Array.from({ length: 1500 }, (_, i) => ({ ...ink[0]!, id: `other-${i}`, page: 2 }));
	ink.push(...untouched);
	const ops: InkOp[] = [];
	const counts = { lines: 0, paints: 0, copiedPoints: 0 };
	let painted = false;
	const context = {
		clearRect: () => { painted = false; }, save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() { counts.lines++; },
		stroke: () => { painted = true; counts.paints++; }, strokeRect: () => { painted = true; },
	};
	const boxes: PageBox[] = [1, 2].map((pageNumber) => ({ pageNumber, leftPx: 0, topPx: (pageNumber - 1) * 810, widthPx: 600, heightPx: 800 }));
	const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add() {}, remove() {} }, querySelector: () => null };
	probe.current = { scroller, scaleFactor: scale, scaleSource: "test", pages: boxes.map((b) => ({ ...b, hasCanvas: true })) };
	const frames = new Map<number, () => void>();
	let next = 0;
	const win = {
		devicePixelRatio: 1, clearTimeout() {}, setTimeout: () => 0,
		requestAnimationFrame: (fn: () => void) => { frames.set(++next, fn); return next; },
		cancelAnimationFrame: (id: number) => frames.delete(id),
	};
	const persist = vi.fn();
	const controller = new PdfInkController({} as HTMLElement, win as unknown as Window,
		(page) => ink.filter((s) => s.page === page), () => "pdf-id", () => ink,
		(op) => { ops.push(op); if (op.type === "move") counts.copiedPoints += ink.filter((s) => op.strokeIds.includes(s.id)).reduce((n,s) => n+s.points.length,0); ink = applyOp(ink, op); }, () => {}, () => {}, persist);
	const pen = controller as unknown as {
		boundScroller: unknown; wetOn(page: number): unknown; cameraFor(box: PageBox): unknown;
		penDown(s: PenSample, ev?: PointerEvent): void; penRaw(s: PenSample[]): void; penUp(ev?: PointerEvent): void; historyStep(redo: boolean): boolean; handleKeyDown(ev: KeyboardEvent): void; lassoPts: {x: number; y: number}[];
	};
	pen.boundScroller = scroller;
	pen.wetOn = () => ({ wetCanvas: { getContext: () => context }, wet: { clear: () => { painted = false; } } });
	pen.cameraFor = () => ({ x: 0, y: 0, zoom: scale });
	const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); };
	const loop = () => {
		pen.penDown(sample(150, 150), { buttons: 2, button: 2, pointerType: "pen" } as PointerEvent);
		pen.penRaw([sample(250, 150), sample(250, 250), sample(150, 250), sample(150, 150)]);
		pen.penUp();
		expect(controller.hasSelection).toBe(true);
	};
	return { controller, pen, loop, ops, persist, flush, counts, untouched, painted: () => painted, ink: () => ink };
}


describe("Delete during a live selection drag", () => {
    beforeEach(() => resetTipModeForTest());
    for (const drainBeforeDelete of [false, true]) {
        it(`one undo restores deleted moved ink, drainBeforeDelete=${drainBeforeDelete}`, () => {
            const r = rig(); r.loop();
            r.pen.penDown(sample(205,205));
            r.pen.penRaw([sample(225,235)]);
            if (drainBeforeDelete) r.flush();
            r.pen.handleKeyDown({key:"Delete",target:null,preventDefault(){}} as unknown as KeyboardEvent);
            expect(r.ink().filter(s=>s.id==="picked")).toHaveLength(0);
            r.pen.penUp(); r.flush();
            expect(r.pen.historyStep(false)).toBe(true);
            const restored = r.ink().find(s=>s.id==="picked");
            console.log(JSON.stringify({drainBeforeDelete, restored:!!restored, operations:r.ops.map(o=>o.type)}));
            expect(restored, "First undo must undo Delete, rather than a move on missing ink").toBeDefined();
            expect(restored!.points[0]!.x).toBe(110);
            expect(restored!.points[0]!.y).toBe(115);
        });
    }
});

describe("Delete closes a selection drag before saving its operands", () => {
	beforeEach(() => resetTipModeForTest());
	const picked = (r: ReturnType<typeof rig>) => r.ink().find((stroke) => stroke.id === "picked");
	const otherInk = (r: ReturnType<typeof rig>) => r.ink().filter((stroke) => stroke.id !== "picked");
	const depth = (r: ReturnType<typeof rig>) =>
		(r.controller as unknown as { history: { depth: { done: number; undone: number } } }).history.depth;

	for (const drainBeforeDelete of [false, true]) {
		it(`round trip restores moved then original ink, drainBeforeDelete=${drainBeforeDelete}`, () => {
			const r = rig(); r.loop();
			const initial = structuredClone(picked(r)!);
			const moved = {
				...initial,
				points: initial.points.map((point) => ({ ...point, x: point.x + 10, y: point.y + 15 })),
				bbox: { ...initial.bbox, x: initial.bbox.x + 10, y: initial.bbox.y + 15 },
			};
			r.pen.penDown(sample(205, 205));
			r.pen.penRaw([sample(225, 235)]);
			if (drainBeforeDelete) r.flush();
			expect(r.controller.deleteSelection()).toBe(true);
			expect(picked(r)).toBeUndefined();
			expect(otherInk(r)).toEqual(r.untouched);
			r.pen.penUp(); r.flush();
			expect(r.pen.historyStep(false)).toBe(true);
			expect(picked(r), "Undo Delete restores every moved point and its bounds").toEqual(moved);
			expect(otherInk(r)).toEqual(r.untouched);
			expect(r.pen.historyStep(false), "A distinct move entry must precede Delete").toBe(true);
			expect(picked(r)).toEqual(initial);
			expect(otherInk(r)).toEqual(r.untouched);
			expect(r.pen.historyStep(false)).toBe(false);
			expect(r.pen.historyStep(true)).toBe(true);
			expect(picked(r)).toEqual(moved);
			expect(otherInk(r)).toEqual(r.untouched);
			expect(r.pen.historyStep(true)).toBe(true);
			expect(picked(r)).toBeUndefined();
			expect(otherInk(r)).toEqual(r.untouched);
			expect(r.pen.historyStep(true)).toBe(false);
		});

		it(`late raw and lift cannot alter deleted ink or history, drainBeforeDelete=${drainBeforeDelete}`, () => {
			const r = rig(); r.loop();
			r.pen.penDown(sample(205, 205));
			r.pen.penRaw([sample(225, 235)]);
			if (drainBeforeDelete) r.flush();
			expect(r.controller.deleteSelection()).toBe(true);
			expect(r.controller.hasSelection).toBe(false);
			expect(depth(r)).toEqual({ done: 2, undone: 0 });
			const inkAfterDelete = structuredClone(r.ink());
			const opsAfterDelete = r.ops.length;
			const persistsAfterDelete = r.persist.mock.calls.length;
			r.pen.penRaw([sample(295, 305)]); r.flush();
			r.pen.penUp({ type: "pointerup" } as PointerEvent); r.flush();
			expect(r.ink()).toEqual(inkAfterDelete);
			expect(r.ops).toHaveLength(opsAfterDelete);
			expect(r.persist).toHaveBeenCalledTimes(persistsAfterDelete);
			expect(depth(r)).toEqual({ done: 2, undone: 0 });
			expect(otherInk(r)).toEqual(r.untouched);
		});
	}

	it("a no-motion drag adds only Delete and round-trips without a phantom move", () => {
		const r = rig(); r.loop();
		const initial = structuredClone(picked(r)!);
		r.pen.penDown(sample(205, 205));
		r.pen.penRaw([sample(205, 205)]);
		expect(r.controller.deleteSelection()).toBe(true);
		expect(depth(r)).toEqual({ done: 1, undone: 0 });
		expect(r.ops.map((op) => op.type)).toEqual(["remove"]);
		expect(r.persist).not.toHaveBeenCalled();
		r.pen.penRaw([sample(295, 305)]); r.flush();
		r.pen.penUp({ type: "pointerup" } as PointerEvent); r.flush();
		expect(picked(r)).toBeUndefined();
		expect(r.ops.map((op) => op.type)).toEqual(["remove"]);
		expect(depth(r)).toEqual({ done: 1, undone: 0 });
		expect(r.pen.historyStep(false)).toBe(true);
		expect(picked(r)).toEqual(initial);
		expect(r.pen.historyStep(false)).toBe(false);
		expect(r.pen.historyStep(true)).toBe(true);
		expect(picked(r)).toBeUndefined();
		expect(r.pen.historyStep(true)).toBe(false);
		expect(otherInk(r)).toEqual(r.untouched);
	});

	it("refused deletion keeps the selected ink and reports failure", () => {
		const r = rig(); r.loop();
		const initial = structuredClone(r.ink());
		r.pen.penDown(sample(205, 205));
		r.pen.penRaw([sample(205, 205)]);
		(r.controller as unknown as { syntheticSources: () => boolean }).syntheticSources = () => true;
		expect(r.controller.deleteSelection()).toBe(false);
		expect(r.controller.hasSelection).toBe(true);
		expect(r.ink()).toEqual(initial);
		expect(r.ops).toHaveLength(0);
		expect(r.persist).not.toHaveBeenCalled();
		expect(depth(r)).toEqual({ done: 0, undone: 0 });
		r.pen.penUp(); r.flush();
		expect(r.controller.hasSelection).toBe(true);
		expect(r.ink()).toEqual(initial);
		expect(r.ops).toHaveLength(0);
	});
});
