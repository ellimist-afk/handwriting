/**
 * Audit probe L-perf-4: the PDF eraser's per-sample work must not scale with
 * ink the nib cannot reach (strokes on OTHER pages of the document).
 *
 * Harness copied from src/pdf/PdfInkController.test.ts: the real
 * PdfInkController, only the viewer probe stubbed. The stroke sources and the
 * op sink are main.ts's own wiring (main.ts:1241-1285) over the REAL
 * PdfInkStore and REAL applyOp: strokes(page) = pdfStore.strokesOnPage,
 * allStrokes = pdfStore.strokes, sink = applyLivePage for the eraser's page-local
 * live op, applyOp + replaceAllLive/replaceAll for the rest.
 *
 * Page-2 strokes carry counting getters on `page` and `id`. A page-1 eraser
 * cannot touch them, so a correct eraser reads them O(1) times per gesture,
 * not per coalesced sample. Asserts CORRECT behaviour: red only if every
 * sample walks the whole document (strokesOnPage filter, applyOp copies).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { setEraserRadiusPx, setEraserWholeStrokes } from "../inline/InkOverlay";

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
import { PdfInkStore } from "../pdf/PdfInkStore";
import { applyOp } from "../pdf/PdfInkHistory";
import type { InkOp } from "../inline/InkHistory";

const SCALE = 2; // css px per page point
const DOC = "doc-1";

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

/** A page-1 stroke along page-point y, from x0 to x1, a point every 2 units. */
function line(id: string, y: number, x0: number, x1: number, page = 1): InkStroke {
	const points = [];
	for (let x = x0, i = 0; x <= x1; x += 2, i++) points.push({ x, y, pressure: 0.5, t: i * 8 });
	return { id, tool: "pen", color: "#000000", width: 2, points, bbox: computeBBox(points, 2), createdAt: 0, page };
}

const counter = { reads: 0 };

/** A page-2 stroke whose `page` and `id` reads are counted. */
function farStroke(i: number, counted: boolean): InkStroke {
	const base = line(`far-${i}`, 50 + (i % 300), 20, 26, 2);
	if (!counted) return base;
	const { id, page, ...rest } = base;
	const s = { ...rest } as InkStroke;
	Object.defineProperty(s, "page", { enumerable: true, get: () => (counter.reads++, page) });
	Object.defineProperty(s, "id", { enumerable: true, get: () => (counter.reads++, id) });
	return s;
}

interface Pen {
	penDown(s: PenSample): void;
	penRaw(s: PenSample[]): void;
	penUp(): void;
}

function build(farCount: number, counted: boolean) {
	const store = new PdfInkStore(); // no host = session-memory mode
	const page1 = [
		line("hitme", 50, 20, 280), // the stroke the hit drag runs along
		line("p1-a", 350, 200, 280),
		line("p1-b", 380, 200, 280),
	];
	const far: InkStroke[] = [];
	for (let i = 0; i < farCount; i++) far.push(farStroke(i, counted));
	store.replaceAll(DOC, [...far, ...page1]);
	const ops: { op: InkOp; mode: string }[] = [];
	probe.current = {
		scroller: {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
		},
		scaleFactor: SCALE,
		scaleSource: "test",
		pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
	};
	const win = { devicePixelRatio: 1, clearTimeout: () => {}, setTimeout: () => 0, requestAnimationFrame: () => 0 };
	const controller = new PdfInkController(
		{} as HTMLElement,
		win as unknown as Window,
		(page) => store.strokesOnPage(DOC, page), // main.ts:1241-1246
		() => DOC,
		() => store.strokes(DOC), // main.ts:1255-1259
		(op, mode) => {
			// main.ts:1260-1285
			ops.push({ op, mode: mode ?? "commit" });
			// The eraser's page-local live op goes to the page alone, as main.ts routes it.
			if (mode === "live-page") {
				store.applyLivePage(op.path, op);
				return;
			}
			const next = applyOp(store.strokes(op.path), op);
			if (mode === "live") store.replaceAllLive(op.path, next);
			else store.replaceAll(op.path, next);
		}
	);
	return { store, ops, controller, pen: controller as unknown as Pen };
}

const K = 64; // coalesced samples in one drag
const BATCH = 4; // ~240 Hz pen at 60 fps

/** Drag the nib along content-px y from x0, 4 content px (2 page units) a sample. */
function drag(pen: Pen, x0: number, y: number): void {
	pen.penDown(sample(x0, y));
	counter.reads = 0;
	for (let i = 0; i < K; i += BATCH) {
		const batch: PenSample[] = [];
		for (let j = 0; j < BATCH; j++) batch.push(sample(x0 + 4 * (i + j + 1), y));
		pen.penRaw(batch);
	}
}

describe("L-perf-4: PDF eraser per-sample cost vs ink on other pages", () => {
	beforeEach(() => {
		resetTipModeForTest();
		setTipMode("eraser");
		setEraserRadiusPx(12);
	});

	it("miss path: crossing blank paper on page 1 does not walk page 2's ink per sample", () => {
		const N = 5000;
		const { store, ops, controller, pen } = build(N, true);
		expect(store.strokes(DOC).length).toBe(N + 3); // precondition: big document
		drag(pen, 40, 400); // page-point y=200: blank on page 1
		const erasing = (controller as unknown as { erasing: boolean }).erasing;
		const readsDuringDrag = counter.reads;
		pen.penUp();
		expect(erasing).toBe(true); // precondition: eraser live through the drag
		expect(ops.filter((o) => o.op.type === "replace")).toEqual([]); // precondition: a pure miss
		console.log(`[L-perf-4 miss] ${K} samples, doc ${N + 3} strokes: page-2 stroke reads = ${readsDuringDrag} (${(readsDuringDrag / K).toFixed(0)} per sample)`);
		// Correct: page-2 ink is unreachable, so it is not walked once per sample.
		expect(readsDuringDrag).toBeLessThan(K);
	});

	it("hit path: erasing through page-1 ink does not walk page 2's ink per sample", () => {
		setEraserWholeStrokes(false); // reticle: every sample along the line hits
		const N = 5000;
		const { store, ops, pen } = build(N, true);
		expect(store.strokes(DOC).length).toBe(N + 3);
		drag(pen, 40, 100); // page-point y=50: along "hitme"
		const readsDuringDrag = counter.reads;
		pen.penUp();
		const liveReplaces = ops.filter((o) => o.op.type === "replace" && o.mode === "live-page").length;
		expect(liveReplaces).toBeGreaterThanOrEqual(K); // precondition: every sample hit and applied live
		console.log(`[L-perf-4 hit] ${K} samples, doc ${N + 3} strokes: page-2 stroke reads = ${readsDuringDrag} (${(readsDuringDrag / K).toFixed(0)} per sample), live replaces = ${liveReplaces}`);
		setEraserWholeStrokes(true);
		expect(readsDuringDrag).toBeLessThan(K);
	});

	it("timing: per-sample erase cost does not grow with ink on other pages", () => {
		setEraserWholeStrokes(false);
		const perSample = (far: number, y: number): number => {
			const { pen, ops } = build(far, false);
			const t0 = performance.now();
			drag(pen, 40, y);
			const dt = performance.now() - t0;
			pen.penUp();
			if (y === 100) expect(ops.filter((o) => o.mode === "live-page").length).toBeGreaterThanOrEqual(K);
			return dt / K;
		};
		// warm up the JIT
		perSample(1000, 400);
		perSample(1000, 100);
		const rows: string[] = [];
		const out: Record<string, number> = {};
		for (const far of [0, 10000, 50000]) {
			// Best of three drags: the cost is the floor, and one scheduler or GC pause under a parallel suite is
			// not cost. (Each drag includes its pen-down, where the one per-gesture pass over the document runs.)
			const miss = Math.min(perSample(far, 400), perSample(far, 400), perSample(far, 400));
			const hit = Math.min(perSample(far, 100), perSample(far, 100), perSample(far, 100));
			out[`miss${far}`] = miss;
			out[`hit${far}`] = hit;
			rows.push(`far=${far}: miss ${(miss * 1000).toFixed(1)} us/sample, hit ${(hit * 1000).toFixed(1)} us/sample, hit per 4-sample frame ${(hit * 4).toFixed(2)} ms`);
		}
		setEraserWholeStrokes(true);
		console.log(`[L-perf-4 timing]\n${rows.join("\n")}`);
		// Correct: cost independent of page-2 ink (allow 5x noise).
		expect(out.hit50000!).toBeLessThan(5 * Math.max(out.hit0!, 0.01));
	});

	it("per call: each erase sample, pen-down excluded, stays flat from 1k to 50k strokes and under 2 ms at 50k", () => {
		setEraserWholeStrokes(false);
		/** Per-sample times of one hit drag: pen-down untimed, every coalesced sample timed on its own. */
		const calls = (far: number): number[] => {
			const { pen } = build(far, false);
			pen.penDown(sample(40, 100));
			const times: number[] = [];
			for (let i = 0; i < K; i++) {
				const t0 = performance.now();
				pen.penRaw([sample(40 + 4 * (i + 1), 100)]);
				times.push(performance.now() - t0);
			}
			pen.penUp();
			return times;
		};
		const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
		calls(1000); // warm up the JIT
		const rows: string[] = [];
		const med: Record<number, number> = {};
		let worst50k = 0;
		for (const far of [1000, 10000, 50000]) {
			// Best of three drags, so one scheduler hiccup does not read as cost.
			const runs = [calls(far), calls(far), calls(far)];
			med[far] = Math.min(...runs.map(median));
			const worst = Math.min(...runs.map((r) => Math.max(...r)));
			if (far === 50000) worst50k = worst;
			rows.push(`far=${far}: median ${(med[far]! * 1000).toFixed(1)} us/call, slowest ${(worst * 1000).toFixed(1)} us/call`);
		}
		setEraserWholeStrokes(true);
		console.log(`[L-perf-4 per call]\n${rows.join("\n")}`);
		expect(med[50000]!, "median call at 50k within 2x of 1k").toBeLessThan(2 * Math.max(med[1000]!, 0.005));
		expect(worst50k, "slowest call at 50k, the first of the gesture included").toBeLessThan(2);
	});
});
