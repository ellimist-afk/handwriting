import { beforeEach, describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { InkStroke } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest } from "../inline/TipMode";
import { PageBox, boxContains, pageAt } from "../pdf/PageMap";
import { PinchBridge } from "./PinchBridge";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../pdf/PdfViewerProbe", () => ({
	probeViewer: () => probe.current,
	viewerCanvasOf: () => null,
}));

import { PdfInkController } from "../pdf/PdfInkController";
import { applyOp } from "../pdf/PdfInkHistory";

const SCALE = 2;
const W = 600;
const H = 800;
const GUTTER = 8; // two 4px transparent borders, as Obsidian's `.spread .page` CSS gives
const ROWGAP = 10;

/** Two-page spread: rows [1,2], [3,4]; pages in a row share topPx. */
const SPREAD: PageBox[] = [
	{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: W, heightPx: H },
	{ pageNumber: 2, leftPx: W + GUTTER, topPx: 0, widthPx: W, heightPx: H },
	{ pageNumber: 3, leftPx: 0, topPx: H + ROWGAP, widthPx: W, heightPx: H },
	{ pageNumber: 4, leftPx: W + GUTTER, topPx: H + ROWGAP, widthPx: W, heightPx: H },
];

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

/** Euclidean distance from a point to a box (0 inside). */
function distTo(b: PageBox, x: number, y: number): number {
	const dx = Math.max(0, b.leftPx - x, x - (b.leftPx + b.widthPx));
	const dy = Math.max(0, b.topPx - y, y - (b.topPx + b.heightPx));
	return Math.hypot(dx, dy);
}

describe("pageAt, spread layout (pure, production PageMap)", () => {
	const cases: { name: string; x: number; y: number; want: number }[] = [
		{ name: "7px right of the right-hand page 2", x: 2 * W + GUTTER + 7, y: 200, want: 2 },
		{ name: "in the gutter, 2px left of page 2", x: W + GUTTER - 2, y: 200, want: 2 },
		{ name: "row gap, 4px above page 4 (6px below page 2)", x: 900, y: H + 6, want: 4 },
	];
	for (const c of cases) {
		it(c.name, () => {
			// Precondition: the point is in no box (fallback path), and the
			// intended page is strictly the nearest one.
			expect(SPREAD.some((b) => boxContains(b, c.x, c.y)), "precondition: point is off every page").toBe(false);
			const nearest = [...SPREAD].sort((a, b) => distTo(a, c.x, c.y) - distTo(b, c.x, c.y));
			expect(nearest[0]!.pageNumber, "precondition: intended page is nearest").toBe(c.want);
			expect(distTo(nearest[0]!, c.x, c.y)).toBeLessThan(distTo(nearest[1]!, c.x, c.y));

			const got = pageAt(SPREAD, c.x, c.y);
			expect(got?.pageNumber, `pageAt bound the point to page ${got?.pageNumber}, not the page beside it`).toBe(c.want);
		});
	}
	it("preserves exact hits, inclusive edges and empty maps", () => {
		for (const b of SPREAD) {
			expect(pageAt(SPREAD, b.leftPx, b.topPx)).toBe(b);
			expect(pageAt(SPREAD, b.leftPx + W, b.topPx + H)).toBe(b);
		}
		expect(pageAt([], 0, 0)).toBeNull();
	});
	it("chooses the nearest column beyond document ends", () => {
		expect(pageAt(SPREAD, 100, -100)?.pageNumber).toBe(1);
		expect(pageAt(SPREAD, 900, 2000)?.pageNumber).toBe(4);
	});
});

describe("spread pinch anchor and settle", () => {
	for (const [x, y, wanted] of [[1215, 200, 2], [606, 200, 2], [900, 806, 4], [900, 200, 2]]) {
		it(`anchors (${x}, ${y}) to page ${wanted}`, () => {
			let scale = 1;
			const elements = SPREAD.map((box) => ({
				getAttribute: () => String(box.pageNumber),
				getBoundingClientRect: () => ({
					left: box.leftPx * scale + (scale > 1 ? box.pageNumber * 10 : 0),
					top: box.topPx * scale,
					right: (box.leftPx + W) * scale,
					bottom: (box.topPx + H) * scale,
				}),
			}));
			const el = {
				scrollLeft: 0, scrollTop: 0,
				addEventListener: () => {}, removeEventListener: () => {},
				querySelectorAll: () => elements,
				querySelector: (selector: string) => elements.find((e) => selector.includes(`"${e.getAttribute()}"`)),
			};
			const bridge = new PinchBridge(() => true, () => scale);
			bridge.attach(el as unknown as HTMLElement);
			const access = bridge as unknown as {
				startCentroid: { x: number; y: number };
				pending: { pageNo: string } | null;
				armAnchor(scale: number): void; settle(): void;
			};
			access.startCentroid = { x: x!, y: y! };
			access.armAnchor(1);
			expect(access.pending?.pageNo).toBe(String(wanted));
			scale = 2;
			access.settle();
			expect(el.scrollLeft).toBeCloseTo(x! + wanted! * 10);
			expect(el.scrollTop).toBeCloseTo(y!);
			expect(access.pending).toBeNull();
			bridge.dispose();
		});
	}
});

describe("PdfInkController pen path, spread layout", () => {
	let strokes: InkStroke[];
	let ops: InkOp[];
	let controller: PdfInkController;
	let pen: { penDown(s: PenSample, ev?: unknown): void; penRaw(s: PenSample[]): void; penUp(): void };

	beforeEach(() => {
		resetTipModeForTest();
		strokes = [];
		ops = [];
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
		};
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: SPREAD.map((b) => ({ ...b, hasCanvas: true })),
		};
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			requestAnimationFrame: () => 0,
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			(page) => strokes.filter((s) => (s.page ?? 1) === page),
			() => "doc-1",
			() => strokes,
			(op) => {
				ops.push(op);
				strokes = applyOp(strokes, op);
			},
			() => {},
			() => {},
			() => {}
		);
		pen = controller as unknown as typeof pen;
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
	});

	it("a stroke that starts 7px right of the right-hand page and moves onto it belongs to page 2", () => {
		const x0 = 2 * W + GUTTER + 7; // 1215: pane margin right of page 2
		pen.penDown(sample(x0, 200));
		pen.penRaw([sample(1150, 250), sample(1100, 300), sample(1000, 350)]);
		pen.penUp();

		const add = ops.find((op) => op.type === "add") as { strokes: InkStroke[] } | undefined;
		expect(add, "precondition: the pen gesture produced a stroke").toBeDefined();
		const s = add!.strokes[0]!;
		const maxX = Math.max(...s.points.map((p) => p.x));
		const minX = Math.min(...s.points.map((p) => p.x));
		// Report the bound page and the stored x range in the failure message.
		expect(
			s.page,
			`stroke saved on page ${s.page} with page-x ${minX.toFixed(1)}..${maxX.toFixed(1)} pt (page width ${W / SCALE} pt)`
		).toBe(2);
	});
	it("keeps the initial page when later samples cross another page", () => {
		pen.penDown(sample(900, 200));
		pen.penRaw([sample(500, 250), sample(400, 900)]);
		pen.penUp();
		const op = ops.find((op) => op.type === "add") as Extract<InkOp, { type: "add" }>;
		expect(op.strokes[0]!.page).toBe(2);
		expect(op.strokes[0]!.points.some((point) => point.x < 0)).toBe(true);
	});
});
