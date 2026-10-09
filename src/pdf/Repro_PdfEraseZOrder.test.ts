import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { getEraserRadiusPx, setEraserRadiusPx, setEraserWholeStrokes } from "../inline/InkOverlay";

class NoopObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current, viewerCanvasOf: () => null, wholePageCanvasOf: () => null }));

import { PdfInkController } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";
import { PdfInkStore } from "./PdfInkStore";

const SCALE = 2;
function sample(x: number, y: number): PenSample { return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 }; }
function line(id: string, pts: Array<[number, number]>): InkStroke {
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
	return { id, tool: "pen", color: "#000000", width: 2, points, bbox: computeBBox(points, 4), createdAt: 0, page: 1 };
}

describe("pdf partial erase keeps z-order when one sample cuts two strokes", () => {
	let strokes: InkStroke[];
	let store: PdfInkStore | null = null;
	let pen: { penDown(s: PenSample): void; penRaw(s: PenSample[]): void; penUp(): void };
	let savedRadius: number;

	beforeEach(() => {
		resetTipModeForTest();
		savedRadius = getEraserRadiusPx();
		setEraserRadiusPx(10);
		setEraserWholeStrokes(false);
		const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add: () => {}, remove: () => {} }, querySelector: () => null };
		probe.current = { scroller, scaleFactor: SCALE, scaleSource: "test", pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }] };
		const win = { devicePixelRatio: 1, clearTimeout: () => {}, setTimeout: () => 0, cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0 };
		const controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			(page) => (store ? store.strokesOnPage("doc-1", page) : strokes.filter((s) => (s.page ?? 1) === page)),
			() => "doc-1",
			() => (store ? store.strokes("doc-1") : strokes),
			(op: InkOp, mode?: string) => {
				if (!store) { strokes = applyOp(strokes, op); return; }
				if (mode === "live-page") store.applyLivePage("doc-1", op);
				else store.replaceAll("doc-1", applyOp(store.strokes("doc-1"), op));
			}
		);
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
		pen = controller as unknown as typeof pen;
	});

	afterEach(() => { store = null; setEraserRadiusPx(savedRadius); resetTipModeForTest(); });

	it("a later stroke's survivors stay above the stroke drawn between them", () => {
		const a = line("a", [[80, 100], [120, 100]]);
		const b = line("b", [[300, 300], [320, 300]]);
		const c = line("c", [[100, 80], [100, 120]]);
		const d = line("d", [[400, 400], [420, 400]]);
		strokes = [a, b, c, d];
		setTipMode("eraser");
		pen.penDown(sample(200, 200));
		pen.penUp();
		const order = strokes.map((s) => (s.id.length === 1 ? s.id : s.points[0]!.x === 100 ? "c*" : "a*"));
		expect(order).toEqual(["a*", "a*", "b", "c*", "c*", "d"]);
	});

	it("through the real PdfInkStore with a second page interleaved", () => {
		const a = line("a", [[80, 100], [120, 100]]);
		const x = { ...line("x", [[100, 80], [100, 120]]), page: 2 };
		const b = line("b", [[300, 300], [320, 300]]);
		const c = line("c", [[100, 80], [100, 120]]);
		const d = line("d", [[400, 400], [420, 400]]);
		store = new PdfInkStore();
		store.replaceAll("doc-1", [a, x, b, c, d]);
		setTipMode("eraser");
		pen.penDown(sample(200, 200));
		pen.penUp();
		const order = store.strokes("doc-1").map((s) => (s.id.length === 1 ? s.id : s.points[0]!.x === 100 ? "c*" : "a*"));
		expect(order).toEqual(["a*", "a*", "x", "b", "c*", "c*", "d"]);
	});
});
