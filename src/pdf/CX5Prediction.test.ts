import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PenSample } from "../input/PointerRouter";
import { InkOp } from "../inline/InkHistory";
import { resetTipModeForTest } from "../inline/TipMode";
import { setPrediction } from "../inline/StrokePrediction";
const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current, viewerCanvasOf: () => null }));
import { PdfInkController } from "./PdfInkController";

function rig(contactOnly = false) {
	let head = false, tail = false;
	let last = { x: 0, y: 0, pressure: 0.5 };
	const pair = {
		tail: {
			clear: vi.fn(() => { head = false; tail = false; }),
			drawHead: () => { head = true; }, draw: vi.fn(() => { tail = true; }),
		},
		wet: { clear() {}, clearStroke() {}, shape: true,
			beginStroke: (point: typeof last) => { last = point; },
			appendPoint: (_camera: unknown, _style: unknown, point: typeof last) => { last = point; },
			head: () => contactOnly ? null : ({ from: last, to: last, pressure: last.pressure }),
			contactHalfWidth: () => 1, liveHalfWidth: () => 1, liveWidthPx: () => 2,
		},
	};
	const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add() {}, remove() {} }, querySelector: () => null };
	probe.current = { scroller, scaleFactor: 2, scaleSource: "test", pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }] };
	const win = { devicePixelRatio: 1, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0 };
	const ops: InkOp[] = [];
	const controller = new PdfInkController({} as HTMLElement, win as unknown as Window, () => [], () => "pdf-id", () => [], (op) => { ops.push(op); });
	const pen = controller as unknown as {
		boundScroller: unknown; wetOn(): unknown; cameraFor(): unknown;
		penDown(s: PenSample, ev?: PointerEvent): void; penRaw(s: PenSample[], ev?: PointerEvent): void; penUp(): void;
	};
	pen.boundScroller = scroller;
	pen.wetOn = () => pair;
	pen.cameraFor = () => ({ x: 0, y: 0, zoom: 2 });
	const point = (x: number, t: number): PenSample => ({ x, y: 100, timestamp: t, pressure: 0.5, tiltX: 0, tiltY: 0 });
	const event = (t: number) => ({ pointerType: "pen", buttons: 1, button: 0, timeStamp: t } as PointerEvent);
	return { pen, pair, ops, point, event, head: () => head, tail: () => tail };
}

describe("PDF prediction clears on rejected jitter batches", () => {
	beforeEach(() => { resetTipModeForTest(); setPrediction(true); });
	afterEach(() => setPrediction(false));
	it("clears a moving tail when sub-spacing jitter suppresses prediction, retaining head and saved ink", () => {
		const r = rig();
		r.pen.penDown(r.point(100, 0), r.event(0));
		expect(r.head()).toBe(true);
		for (let i = 1; i <= 5; i++) r.pen.penRaw([r.point(100 + i * 10, i * 8)], r.event(i * 8));
		expect(r.pair.tail.draw).toHaveBeenCalled();
		expect(r.tail()).toBe(true);
		for (let i = 1; i <= 15; i++) r.pen.penRaw([r.point(150 + (i % 2) * 0.02, 40 + i * 16)], r.event(40 + i * 16));
		expect(r.tail()).toBe(false);
		expect(r.head()).toBe(true);
		r.pen.penUp();
		const op = r.ops[0] as Extract<InkOp, { type: "add" }>;
		expect(op.strokes[0]!.points).toHaveLength(6);
		expect(Math.max(...op.strokes[0]!.points.map((p) => p.x))).toBe(75);
	});
	it("retains the contact dot without a smoothed head during rejected jitter", () => {
		const r = rig(true);
		r.pen.penDown(r.point(100, 0), r.event(0));
		for (let i = 1; i <= 15; i++) r.pen.penRaw([r.point(100 + (i % 2) * 0.02, i * 16)], r.event(i * 16));
		expect(r.head()).toBe(true);
		expect(r.tail()).toBe(false);
		r.pen.penUp();
		expect(r.ops).toHaveLength(1);
		const op = r.ops[0] as Extract<InkOp, { type: "add" }>;
		expect(op.strokes[0]!.points[0]!.x).toBe(50);
	});
	it("prediction-off keeps the contact/head and stores the accepted geometry", () => {
		setPrediction(false);
		const r = rig(); r.pen.penDown(r.point(100, 0), r.event(0));
		expect(r.head()).toBe(true);
		r.pen.penRaw([r.point(120, 8)], r.event(8));
		expect(r.head()).toBe(true);
		expect(r.pair.tail.draw).not.toHaveBeenCalled();
		r.pen.penUp(); expect(r.ops).toHaveLength(1);
	});
});
