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

function rig() {
	const points = [100, 105, 110].map((x) => ({ x, y: x, pressure: 0.5, t: x }));
	let ink: InkStroke[] = [{ id: "picked", points, bbox: computeBBox(points, 2), tool: "pen", color: "#000000", width: 2, createdAt: 0, page: 1 }];
	const ops: InkOp[] = [];
	let painted = false;
	const context = {
		clearRect: () => { painted = false; }, save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {},
		stroke: () => { painted = true; }, strokeRect: () => { painted = true; },
	};
	const boxes: PageBox[] = [1, 2].map((pageNumber) => ({ pageNumber, leftPx: 0, topPx: (pageNumber - 1) * 810, widthPx: 600, heightPx: 800 }));
	const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add() {}, remove() {} }, querySelector: () => null };
	probe.current = { scroller, scaleFactor: 2, scaleSource: "test", pages: boxes.map((b) => ({ ...b, hasCanvas: true })) };
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
		(op) => { ops.push(op); ink = applyOp(ink, op); }, () => {}, () => {}, persist);
	const pen = controller as unknown as {
		boundScroller: unknown; wetOn(page: number): unknown; cameraFor(box: PageBox): unknown;
		penDown(s: PenSample, ev?: PointerEvent): void; penRaw(s: PenSample[]): void; penUp(): void;
	};
	pen.boundScroller = scroller;
	pen.wetOn = () => ({ wetCanvas: { getContext: () => context }, wet: { clear: () => { painted = false; } } });
	pen.cameraFor = () => ({ x: 0, y: 0, zoom: 2 });
	const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); };
	const loop = () => {
		pen.penDown(sample(150, 150), { buttons: 2, button: 2, pointerType: "pen" } as PointerEvent);
		pen.penRaw([sample(250, 150), sample(250, 250), sample(150, 250), sample(150, 150)]);
		pen.penUp();
		expect(controller.hasSelection).toBe(true);
	};
	return { controller, pen, loop, ops, persist, flush, painted: () => painted, ink: () => ink };
}

describe("PDF selection state and short-loop cleanup", () => {
	beforeEach(() => resetTipModeForTest());
	for (const mode of ["pan", "space"] as const) {
		it(`${mode} contact outside the selection clears selection before taking the wet layer`, () => {
			const r = rig();
			setTipMode(mode);
			r.loop();
			r.pen.penDown(mode === "pan" ? sample(200, 1000) : sample(100, 100));
			expect(r.controller.hasSelection).toBe(false);
			expect(r.controller.deleteSelection()).toBe(false);
			expect(r.controller.cutSelection()).toBe(0);
			r.pen.penUp();
			expect(r.ink()).toHaveLength(1);
		});
		it(`${mode} still lets a bare tip grab selected ink`, () => {
			const r = rig(); setTipMode(mode); r.loop();
			r.pen.penDown(sample(205, 205));
			expect(r.controller.hasSelection).toBe(true);
			r.pen.penUp();
		});
	}
	for (const moves of [0, 1]) {
		it(`finishes a ${moves}-move lasso without dashed pixels or a write`, () => {
			const r = rig(); setTipMode("lasso");
			r.pen.penDown(sample(150, 150));
			if (moves) { r.pen.penRaw([sample(160, 160)]); r.flush(); expect(r.painted()).toBe(true); }
			r.pen.penUp(); r.flush();
			expect(r.painted()).toBe(false);
			expect(r.controller.hasSelection).toBe(false);
			expect(r.ops).toEqual([]);
			expect(r.persist).not.toHaveBeenCalled();
			r.loop();
			expect(r.painted()).toBe(true);
		});
	}
});
