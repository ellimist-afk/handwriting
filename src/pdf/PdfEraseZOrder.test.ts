// JOB6A: a partial erase that also takes a stroke BELOW the split one lifts
// the split stroke's surviving pieces above ink drawn after it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { setEraserWholeStrokes } from "../inline/InkOverlay";

class NoopObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../pdf/PdfViewerProbe", () => ({
	probeViewer: () => probe.current,
	viewerCanvasOf: () => null,
	wholePageCanvasOf: () => null,
}));

import { PdfInkController } from "../pdf/PdfInkController";
import { applyOp } from "../pdf/PdfInkHistory";
import { PdfInkStore } from "../pdf/PdfInkStore";

const SCALE = 2;
const sample = (x: number, y: number): PenSample => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

function line(id: string, pts: [number, number][]): InkStroke {
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i * 8 }));
	return { id, tool: "pen", color: "#000000", width: 2, points, bbox: computeBBox(points, 4), createdAt: 0, page: 1 };
}

describe("PDF partial erase keeps z-order", () => {
	let store: PdfInkStore;
	let pen: { penDown(s: PenSample): void; penRaw(s: PenSample[]): void; penUp(): void };

	beforeEach(() => {
		resetTipModeForTest();
		setEraserWholeStrokes(false);
		store = new PdfInkStore();
		const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add() {}, remove() {} }, querySelector: () => null };
		probe.current = {
			scroller, scaleFactor: SCALE, scaleSource: "test",
			pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
		};
		const win = { devicePixelRatio: 1, clearTimeout() {}, setTimeout: () => 0, cancelAnimationFrame() {}, requestAnimationFrame: () => 0 };
		const controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			(page) => store.strokesOnPage("doc", page),
			() => "doc",
			() => store.strokes("doc"),
			// main.ts's sink, verbatim in shape.
			(op: InkOp, mode?: string) => {
				if (mode === "live-page") return store.applyLivePage(op.path, op);
				const next = applyOp(store.strokes(op.path), op);
				if (mode === "live") return store.replaceAllLive(op.path, next);
				store.replaceAll(op.path, next);
			},
			() => {},
			() => {},
			(id) => store.save(id)
		);
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
		pen = controller as unknown as typeof pen;
	});

	it("a split stroke's pieces stay under the stroke that was drawn over it", () => {
		// Drawn in this order: a dot, a horizontal line through it, then a
		// vertical line crossing the horizontal one well away from the eraser.
		const dot = line("dot", [[100, 100], [101, 100]]);
		const under = line("under", [[20, 100], [60, 100], [100, 100], [140, 100], [180, 100]]);
		const over = line("over", [[160, 60], [160, 100], [160, 140]]);
		store.replaceAll("doc", [dot, under, over]);

		setTipMode("eraser");
		// One tap of the eraser at page point (100,100): it swallows the dot
		// whole and cuts "under" in two.
		pen.penDown(sample(200, 200));
		pen.penUp();

		const order = store.strokes("doc").map((s) => s.id);
		expect(order).not.toContain("dot");
		expect(order).not.toContain("under");
		expect(order).toContain("over");
		// Every piece of "under" must still paint BELOW "over".
		const overAt = order.indexOf("over");
		const piecesAbove = order.slice(overAt + 1);
		expect(piecesAbove, `stroke order after the erase: ${order.join(", ")}`).toEqual([]);
	});
});
