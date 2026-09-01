/**
 * The PDF lasso, driven through the controller's own pen callbacks.
 *
 * Nothing constructed this class before, which is how the lasso shipped
 * unreachable. Its branch in `penRaw` sat below a guard that returns unless a
 * stroke builder or the eraser is live, and a lasso has neither, so every
 * movement sample was dropped: pen-up closed a one-point polygon and nothing
 * was ever selected. Reading the lasso code did not show it, because the bug
 * was in the routing ABOVE it - which is the argument for driving the class
 * rather than testing its parts.
 *
 * The viewer probe is the only thing stubbed. The page geometry, the hit
 * test, the selection and the history are all the real code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { DEFAULT_PEN } from "../ink/PenStyle";

/**
 * The gesture path reaches sync, which rebinds, which constructs observers.
 * Node has neither, and neither does the plugin need them to be real here: a
 * no-op keeps the code path honest without pretending to observe anything.
 */
class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current }));

import { PdfInkController, pdfPenWidth, pointerScale } from "./PdfInkController";

/** css px per point, as `--scale-factor` reports it. */
const SCALE = 2;

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

/** A short stroke around page point (100,100) - content px (200,200). */
function inkAt(id: string): InkStroke {
	const points = [100, 105, 110].map((v, i) => ({ x: v, y: v, pressure: 0.5, t: i * 8 }));
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points,
		bbox: computeBBox(points, 4),
		createdAt: 0,
		page: 1,
	};
}

describe("PdfInkController lasso", () => {
	let strokes: InkStroke[];
	let ops: InkOp[];
	let controller: PdfInkController;
	let pen: {
		penDown(s: PenSample): void;
		penRaw(s: PenSample[]): void;
		penUp(): void;
	};

	beforeEach(() => {
		resetTipModeForTest();
		strokes = [inkAt("s1")];
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
			pages: [
				{
					pageNumber: 1,
					leftPx: 0,
					topPx: 0,
					widthPx: 600,
					heightPx: 800,
					hasCanvas: true,
				},
			],
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
			() => strokes,
			() => "doc-1",
			(op) => ops.push(op)
		);
		pen = controller as unknown as typeof pen;
	});

	/** Trace a closed loop through the given scroller-relative corners. */
	function lasso(corners: [number, number][]): void {
		const first = corners[0]!;
		pen.penDown(sample(first[0], first[1]));
		for (const [x, y] of corners.slice(1)) pen.penRaw([sample(x, y)]);
		pen.penRaw([sample(first[0], first[1])]);
		pen.penUp();
	}

	it("selects the ink the loop encircles", () => {
		setTipMode("lasso");
		lasso([
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		]);
		// deleteSelection is the public witness: true only if the lasso
		// actually holds those stroke ids.
		expect(controller.deleteSelection()).toBe(true);
		expect(ops).toEqual([
			{ type: "remove", path: "doc-1", strokes: [strokes[0]], indices: [0] },
		]);
	});

	it("selects nothing when the loop encircles nothing", () => {
		setTipMode("lasso");
		lasso([
			[450, 450],
			[550, 450],
			[550, 550],
			[450, 550],
		]);
		expect(controller.deleteSelection()).toBe(false);
		expect(ops).toEqual([]);
	});

	it("a second loop elsewhere drops the first selection", () => {
		setTipMode("lasso");
		lasso([
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		]);
		lasso([
			[450, 450],
			[550, 450],
			[550, 550],
			[450, 550],
		]);
		expect(controller.deleteSelection()).toBe(false);
	});

	it("dragging a selection moves it by the travel", () => {
		setTipMode("lasso");
		lasso([
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		]);
		ops = [];
		// Down inside the selection's bounds, then 20 css px right = 10 points.
		pen.penDown(sample(205, 205));
		pen.penRaw([sample(215, 205)]);
		pen.penRaw([sample(225, 205)]);
		pen.penUp();
		const moves = ops.filter((op) => op.type === "move");
		expect(moves.length).toBeGreaterThan(0);
		const dx = moves.reduce((sum, op) => sum + (op as { dx: number }).dx, 0);
		const dy = moves.reduce((sum, op) => sum + (op as { dy: number }).dy, 0);
		expect(dx).toBeCloseTo(10, 6);
		expect(dy).toBeCloseTo(0, 6);
		for (const op of moves) expect((op as { strokeIds: string[] }).strokeIds).toEqual(["s1"]);
	});

	it("a document switch mid-gesture leaves the pane able to sync again", () => {
		setTipMode("nib");
		pen.penDown(sample(200, 200));
		// A stroke is open, so the reload poll must leave this pane alone.
		expect(controller.idle).toBe(false);
		// The pane is reused for another document; the half-open gesture must
		// not be inherited, or `idle` never comes back and the pane silently
		// stops receiving the other device's ink.
		controller.forgetHistory();
		expect(controller.idle).toBe(true);
	});
});

describe("PdfInkController, the rest of what went wrong", () => {
	let strokes: InkStroke[];
	let ops: InkOp[];
	let notices: string[];
	let docId: string | null;
	let controller: PdfInkController;
	let pen: { penDown(s: PenSample, ev?: unknown): void; penRaw(s: PenSample[]): void; penUp(): void };

	/** Two pages, so a stroke can be asked to wander onto the second. */
	function probeTwoPages(scroller: unknown) {
		return {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
				{ pageNumber: 2, leftPx: 0, topPx: 810, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
	}

	beforeEach(() => {
		resetTipModeForTest();
		strokes = [inkAt("s1")];
		ops = [];
		notices = [];
		docId = "doc-1";
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
		};
		probe.current = probeTwoPages(scroller);
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
			() => docId,
			(op) => {
				ops.push(op);
				// A store that actually applies, so an erase can be measured
				// against what it left behind.
				if (op.type === "replace") {
					const gone = new Set(op.removed.map((s) => s.id));
					strokes = strokes.filter((s) => !gone.has(s.id)).concat(op.inserted);
				}
			},
			() => {},
			(message) => notices.push(message)
		);
		pen = controller as unknown as typeof pen;
		// Already bound, as it would be after the first sync in the app. Without
		// this the pen-up handoff rebinds a real router onto a fake scroller,
		// which is a different test than the one being written here.
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
	});

	it("refuses to start before the document is identified, and says so once", () => {
		docId = null;
		pen.penDown(sample(200, 200));
		pen.penUp();
		pen.penDown(sample(210, 210));
		pen.penUp();
		expect(ops).toEqual([]);
		// Once per wait, not once per contact: a notice on every touch of the
		// pen would be its own bug.
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("identifying");
	});

	it("starts drawing as soon as the document lands", () => {
		docId = null;
		pen.penDown(sample(200, 200));
		pen.penUp();
		docId = "doc-1";
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(230, 230), sample(260, 260)]);
		pen.penUp();
		expect(ops.filter((op) => op.type === "add")).toHaveLength(1);
	});

	it("keeps a stroke on the page it started on when samples cross onto the next", () => {
		// Down on page 1, then well past its bottom edge into page 2's box.
		pen.penDown(sample(200, 700));
		pen.penRaw([sample(200, 900), sample(200, 1100)]);
		pen.penUp();
		const add = ops.find((op) => op.type === "add") as { strokes: InkStroke[] };
		expect(add).toBeDefined();
		expect(add.strokes[0]!.page).toBe(1);
	});

	it("divides the pen width by the page scale, so pdf ink is note ink", () => {
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(230, 230), sample(260, 260)]);
		pen.penUp();
		const add = ops.find((op) => op.type === "add") as { strokes: InkStroke[] };
		// A note's 2.2 rendered at a page scale of 2 would be 4.4 css px; the
		// stored width is halved so it lands at 2.2 like everywhere else.
		expect(add.strokes[0]!.width).toBeCloseTo(DEFAULT_PEN.baseWidth / SCALE, 6);
	});

	it("records one history entry for a whole erase gesture, not one per sample", () => {
		setTipMode("eraser");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(205, 205), sample(210, 210), sample(215, 215)]);
		pen.penUp();
		const ring = controller as unknown as { history: { depth: { done: number } } };
		expect(ops.filter((op) => op.type === "replace").length).toBeGreaterThan(0);
		expect(ring.history.depth.done).toBe(1);
	});
});

describe("pdfPenWidth — the reticle and the stroke must agree", () => {
	// The dot promises the width of the line. It is drawn in css px; the
	// stroke is stored in page units and rendered times the scale. Those two
	// only stay equal if both go through this function, which they did not
	// until a dot came out twice the width of its line on hardware.
	it("renders at the same css width whatever the page scale", () => {
		for (const scale of [1, 1.8692810457516338, 3]) {
			const stored = pdfPenWidth(DEFAULT_PEN.baseWidth, 1, scale);
			expect(stored * scale).toBeCloseTo(DEFAULT_PEN.baseWidth, 6);
		}
	});

	it("carries the nib size multiplier through", () => {
		const stored = pdfPenWidth(DEFAULT_PEN.baseWidth, 2.5, 2);
		expect(stored * 2).toBeCloseTo(DEFAULT_PEN.baseWidth * 2.5, 6);
	});
});

describe("pan and space on a pdf", () => {
	// Both buttons were on this surface's strip from day one, and both modes
	// DREW. This suite is the routing regression net the lasso taught us to
	// keep: a mode's whole failure can live above its code, in penDown.
	let ops: InkOp[];
	let notices: string[];
	let strokes: InkStroke[];
	let scroller: { scrollLeft: number; scrollTop: number };
	let pen: { penDown(s: PenSample, ev?: unknown): void; penRaw(s: PenSample[]): void; penUp(): void };

	beforeEach(() => {
		resetTipModeForTest();
		ops = [];
		notices = [];
		strokes = [];
		const sc = {
			scrollLeft: 500,
			scrollTop: 500,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
		};
		scroller = sc;
		probe.current = {
			scroller: sc,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
		};
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			requestAnimationFrame: () => 0,
		};
		const controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			(page) => strokes.filter((st) => (st.page ?? 1) === page),
			() => "doc-1",
			(op) => ops.push(op),
			() => {},
			(message) => notices.push(message)
		);
		pen = controller as unknown as typeof pen;
		(controller as unknown as { boundScroller: unknown }).boundScroller = sc;
	});

	it("pan drags the scroller and never inks", () => {
		setTipMode("pan");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(210, 190)]);
		pen.penRaw([sample(230, 170)]);
		pen.penUp();
		// Content follows the pen: +30 right of travel pulls scrollLeft down.
		expect(scroller.scrollLeft).toBe(470);
		expect(scroller.scrollTop).toBe(530);
		expect(ops).toEqual([]);
	});

	it("space with nothing below the line says so and moves nothing", () => {
		setTipMode("space");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(200, 260)]);
		pen.penUp();
		expect(ops).toEqual([]);
		expect(notices.some((n) => n.includes("below the line"))).toBe(true);
	});

	it("space shoves the rows below the divider, and only those", () => {
		// This suite's scroller sits at scrollTop 500 and the scale is 2, so
		// a sample's page y is (y + 500) / 2: the pen can only reach page y
		// 250 and down. The ink goes at page y ~350, the divider at 300.
		const pts = [100, 105, 110].map((v, i) => ({ x: v, y: 348 + i * 2, pressure: 0.5, t: i * 8 }));
		strokes = [
			{
				id: "s1",
				tool: "pen",
				color: "#000000",
				width: 2,
				points: pts,
				bbox: computeBBox(pts, 4),
				createdAt: 0,
				page: 1,
			},
		];
		setTipMode("space");
		pen.penDown(sample(200, 100)); // page y 300, above the ink at 348
		pen.penRaw([sample(200, 140)]); // page y 320: 20 page units down
		pen.penUp();
		const moves = ops.filter((op) => op.type === "move");
		expect(moves.length).toBeGreaterThan(0);
		const dy = moves.reduce((sum, op) => sum + (op as { dy: number }).dy, 0);
		const dx = moves.reduce((sum, op) => sum + (op as { dx: number }).dx, 0);
		expect(dy).toBeCloseTo(20, 6);
		expect(dx).toBe(0);
		for (const op of moves) expect((op as { strokeIds: string[] }).strokeIds).toEqual(["s1"]);
	});

	it("a live space gesture holds the pane against the reload poll", () => {
		// idle=true mid-shove let the poll swap the strokes out from under a
		// frozen id list. Every gesture that touches the store must hold it.
		const pts = [100, 105, 110].map((v, i) => ({ x: v, y: 348 + i * 2, pressure: 0.5, t: i * 8 }));
		strokes = [
			{
				id: "s1",
				tool: "pen",
				color: "#000000",
				width: 2,
				points: pts,
				bbox: computeBBox(pts, 4),
				createdAt: 0,
				page: 1,
			},
		];
		setTipMode("space");
		const c = pen as unknown as { idle: boolean; forgetHistory(): void };
		pen.penDown(sample(200, 100));
		expect(c.idle).toBe(false);
		// A document switch mid-shove must free the pane, or it never syncs
		// again - the exact failure the drag already guards against.
		c.forgetHistory();
		expect(c.idle).toBe(true);
	});

	it("the nib still inks once pan is left", () => {
		setTipMode("pan");
		pen.penDown(sample(200, 200));
		pen.penUp();
		setTipMode("nib");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(230, 200)]);
		pen.penUp();
		expect(ops.some((op) => op.type === "add")).toBe(true);
	});
});

describe("the scale a pointer sample is converted with", () => {
	// The offset this prevents: input converted with `--scale-factor` while
	// the ink was drawn at the box's own scale. Settled, the two agree and
	// nothing shows. Mid-zoom they do not, and the ink lands where the
	// pointer was at the PREVIOUS zoom - growing with the distance moved,
	// then healing when the viewer catches up (alan, on hardware).
	it("comes from the box when the page has been measured", () => {
		// A page of 612pt shown 2145px wide is at 3.5, whatever the viewer
		// variable happens to say this frame.
		expect(pointerScale(2145, 612, 1.87)).toBeCloseTo(3.5049, 4);
	});

	it("agrees with the viewer once it has settled", () => {
		expect(pointerScale(612 * 1.87, 612, 1.87)).toBeCloseTo(1.87, 10);
	});

	it("falls back to the viewer for a page nobody has painted", () => {
		expect(pointerScale(2145, 0, 1.87)).toBe(1.87);
	});

	it("falls back rather than dividing by a box with no width", () => {
		expect(pointerScale(0, 612, 1.87)).toBe(1.87);
		expect(Number.isFinite(pointerScale(0, 0, 1.87))).toBe(true);
	});
});
