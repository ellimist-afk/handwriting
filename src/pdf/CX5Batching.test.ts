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

describe("PDF live edits and lasso paint are frame bounded", () => {
	beforeEach(() => resetTipModeForTest());
	for (const mode of ["drag", "space"] as const) {
		it(`${mode} applies many raw/coalesced samples once per frame with exact undo/redo`, () => {
			const r = rig();
			if (mode === "drag") r.loop(); else setTipMode("space");
			const origin = mode === "drag" ? 205 : 100;
			r.pen.penDown(sample(origin, origin));
			const initial = JSON.parse(JSON.stringify(r.ink()[0]));
			const t0 = performance.now();
			for (let batch = 0; batch < 20; batch++) {
				r.pen.penRaw(Array.from({ length: 20 }, (_, j) => sample(origin + (mode === "drag" ? batch*20+j+1 : 0), origin+batch*20+j+1)));
			}
			r.flush();
			console.log(JSON.stringify({ mode, stage: 'first-frame', samples: 400, documentStrokes: 1501, liveMoves: r.ops.length, copiedPoints: r.counts.copiedPoints, elapsedMs: performance.now()-t0 }));
			expect(r.ops.filter((o) => o.type === "move")).toHaveLength(1);
			expect(r.counts.copiedPoints).toBe(initial.points.length);
			r.pen.penRaw([sample(origin-10, origin-20), sample(origin+20, origin+30)]);
			r.pen.penUp(); r.flush();
			const moved = r.ink()[0]!;
			expect(moved.points[0]!.x).toBe(initial.points[0].x + (mode === "drag" ? 10 : 0));
			expect(moved.points[0]!.y).toBe(initial.points[0].y + 15);
			expect(moved.bbox).toEqual(computeBBox(moved.points, moved.width));
			expect(r.ink().slice(1)).toEqual(r.untouched);
			expect(r.persist).toHaveBeenCalledTimes(1);
			expect(r.pen.historyStep(false)).toBe(true);
			expect(r.ink()[0]).toEqual(initial);
			expect(r.pen.historyStep(false)).toBe(false);
			expect(r.pen.historyStep(true)).toBe(true);
			expect(r.ink()[0]).toEqual(moved);
			console.log(JSON.stringify({ mode, samples: 402, documentStrokes: 1501, liveMoves: r.ops.length-2, copiedPoints: r.counts.copiedPoints, elapsedMs: performance.now()-t0 }));
		});
		it(`${mode} flushes a pending final move once on pointercancel`, () => {
			const r = rig(); if (mode === "drag") r.loop(); else setTipMode("space");
			const origin = mode === "drag" ? 205 : 100;
			r.pen.penDown(sample(origin,origin)); r.pen.penRaw([sample(origin+10,origin+20)]);
			r.pen.penUp({ type: "pointercancel" } as PointerEvent); r.flush();
			expect(r.ink()[0]!.points[0]!.y).toBe(110);
			expect(r.ops).toHaveLength(1); expect(r.persist).toHaveBeenCalledTimes(1);
		});
		it(`${mode} with no motion emits no move or persistence`, () => {
			const r=rig(); if(mode === "drag") r.loop(); else setTipMode("space");
			const origin=mode === "drag" ? 205 : 100;
			r.pen.penDown(sample(origin,origin)); r.pen.penRaw([sample(origin,origin)]); r.flush(); r.pen.penUp();
			expect(r.ops).toHaveLength(0); expect(r.persist).not.toHaveBeenCalled();
		});
	}
	for (const exit of ["Escape", "tool"] as const) {
		it(`keeps pending drag targets and one undo entry after ${exit}`, () => {
			const r=rig(); r.loop(); const initial=JSON.parse(JSON.stringify(r.ink()[0]));
			r.pen.penDown(sample(205,205)); r.pen.penRaw([sample(225,235)]);
			if(exit === "Escape") r.pen.handleKeyDown({ key: "Escape", target: null, preventDefault() {} } as unknown as KeyboardEvent);
			else { setTipMode("nib"); r.controller.dissolveSelection(); }
			r.flush(); r.pen.penUp(); r.flush();
			expect(r.ink()[0]!.points[0]!.x).toBe(110);
			expect(r.pen.historyStep(false)).toBe(true); expect(r.ink()[0]).toEqual(initial);
			expect(r.pen.historyStep(false)).toBe(false);
		});
	}
	it("unmount flushes pending live moves before its one persistence", () => {
		const r=rig(); r.loop(); r.pen.penDown(sample(205,205)); r.pen.penRaw([sample(225,235)]);
		r.controller.unmount(); r.flush();
		expect(r.ink()[0]!.points[0]!.x).toBe(110); expect(r.persist).toHaveBeenCalledTimes(1);
		expect(r.ops).toHaveLength(1);
	});
	it("file switch cancels queued work without late edits", () => {
		const r=rig(); r.loop(); r.pen.penDown(sample(205,205)); r.pen.penRaw([sample(225,235)]);
		r.controller.forgetHistory(); const after = JSON.stringify(r.ink()); const ops=r.ops.length;
		r.flush(); expect(JSON.stringify(r.ink())).toBe(after); expect(r.ops).toHaveLength(ops);
	});
	for (const scale of [1,2,4]) {
		it(`retains dense lasso geometry with one redraw per frame at scale ${scale}`, () => {
			const r=rig(scale); setTipMode("lasso");
			r.pen.penDown(sample(90*scale,90*scale));
			const path = [[120,90],[120,120],[90,120],[90,90]].flatMap(([x,y],edge) => {
				const from = [[90,90],[120,90],[120,120],[90,120]][edge]!;
				return Array.from({length:100},(_,j) => sample((from[0]!+(x!-from[0]!)*(j+1)/100)*scale,(from[1]!+(y!-from[1]!)*(j+1)/100)*scale));
			});
			for (let i=0;i<path.length;i+=20) r.pen.penRaw(path.slice(i,i+20));
			expect(r.pen.lassoPts).toHaveLength(401);
			r.flush(); expect(r.counts.paints).toBe(1); expect(r.counts.lines).toBe(400);
			r.pen.penUp(); r.flush(); expect(r.controller.hasSelection).toBe(true);
			expect(r.ops).toHaveLength(0); expect(r.persist).not.toHaveBeenCalled();
		});
	}
	it("lift before frame selects using the full loop and leaves no late dashed paint", () => {
		const r=rig(); r.loop(); const before=r.counts.paints; r.flush();
		expect(r.counts.paints).toBe(before); expect(r.controller.hasSelection).toBe(true);
	});
	it("abandoned lasso cannot paint in the next document", () => {
		const r=rig(); setTipMode("lasso"); r.pen.penDown(sample(150,150));
		r.pen.penRaw([sample(160,160),sample(170,180)]); r.controller.forgetHistory();
		const before=r.counts.paints; r.flush(); expect(r.counts.paints).toBe(before);
	});
	it("pen-up persists the completed drag and its backup without a pre-lift frame drain", async () => {
		vi.stubGlobal("window", globalThis);
		try {
			const r = rig();
			const id = "pending-drag";
			const sidecar = `.handwriting/${id}.json`;
			const adapter = new FakeAdapter();
			const store = new PageStore({ vault: { adapter } });
			const seed = emptyPage(id);
			seed.surface = "pdf";
			seed.strokes = [r.ink()[0]!];
			adapter.externalWrite(sidecar, serializePage(seed));
			const pdf = new PdfInkStore();
			pdf.attachHost({ load: (key) => store.load(key), schedule: (key, data) => store.schedule(key, data), notice() {} });
			await pdf.ensureLoaded(id);
			const saves = vi.fn((key: string) => pdf.save(key));
			Object.assign(r.controller, {
				documentId: () => id,
				allStrokes: () => pdf.strokes(id),
				strokes: (page: number) => pdf.strokes(id).filter((s) => s.page === page),
				onOp: (op: InkOp, mode: string) => {
					const next = applyOp(pdf.strokes(id), op);
					if (mode === "live") pdf.replaceAllLive(id, next); else pdf.replaceAll(id, next);
				},
				persist: saves,
			});
			r.loop();
			r.pen.penDown(sample(205,205));
			r.pen.penRaw([sample(225,235)]);
			expect(pdf.strokes(id)[0]!.points[0]!.x).toBe(100);
			expect(saves).not.toHaveBeenCalled();
			// No animation-frame drain: penUp itself must apply and persist the move.
			r.pen.penUp();
			expect(saves).toHaveBeenCalledTimes(1);
			expect(pdf.strokes(id)[0]!.points[0]!.x).toBe(110);
			expect(pdf.strokes(id)[0]!.points[0]!.y).toBe(115);
			await store.flush();
			const persisted = parsePage(adapter.files.get(sidecar)!, id).data.strokes;
			expect(persisted).toEqual(pdf.strokes(id));
			const backup = await store.preserve(id);
			expect(backup).not.toBeNull();
			expect(parsePage(adapter.files.get(backup!)!, id).data.strokes).toEqual(persisted);
			r.flush();
			expect(pdf.strokes(id)).toEqual(persisted);
			expect(saves).toHaveBeenCalledTimes(1);
		} finally { vi.unstubAllGlobals(); }
	});});