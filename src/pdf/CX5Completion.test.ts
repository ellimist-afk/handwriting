import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { setPenReticle } from "../inline/InkOverlay";
import { setMouseInk } from "../inline/MouseInk";
import { fakeEl, installFakeWindow, penEvent } from "../../test/routerHarness";

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

const SCALE = 2;
const LEFT = 300;
const TOP = 80;

describe("a pen stroke that ends in pointercancel", () => {
	let uninstallWindow: () => void = () => {};
	beforeAll(() => {
		uninstallWindow = installFakeWindow();
	});
	afterAll(() => {
		uninstallWindow();
	});

	let controller: PdfInkController;
	let ops: InkOp[];
	let scroller: ReturnType<typeof fakeEl>;

	function fire(ev: PointerEvent): void {
		const h = scroller.handlers.get(ev.type);
		if (!h) throw new Error(`the router registered no handler for ${ev.type}`);
		h(ev as unknown as Event);
	}

	/** Pen down at client (400,180) = page (50,50), two moves to page (70,70). */
	function drawStroke(): void {
		setTipMode("nib");
		fire(penEvent("pointerdown", 100, { x: 400, y: 180 }));
		fire(penEvent("pointermove", 110, { x: 420, y: 200 }));
		fire(penEvent("pointermove", 120, { x: 440, y: 220 }));
	}

	/** What the engine dispatches: no position, no pressure, no buttons. */
	function engineCancel(ts: number): PointerEvent {
		return {
			type: "pointercancel",
			pointerType: "pen",
			pointerId: 7,
			isPrimary: true,
			clientX: 0,
			clientY: 0,
			pressure: 0,
			buttons: 0,
			button: -1,
			timeStamp: ts,
			tiltX: 0,
			tiltY: 0,
			width: 1,
			height: 1,
			preventDefault: () => {},
			stopPropagation: () => {},
		} as unknown as PointerEvent;
	}

	function committedPoints(): Array<{ x: number; y: number }> {
		expect(ops.length, "precondition: exactly one op committed").toBe(1);
		const op = ops[0] as Extract<InkOp, { type: "add" }>;
		expect(op.type, "precondition: the op is an add").toBe("add");
		expect(op.strokes.length).toBe(1);
		return op.strokes[0]!.points.map((p) => ({ x: p.x, y: p.y }));
	}

	beforeEach(() => {
		resetTipModeForTest();
		setPenReticle(true);
		setMouseInk(false);
		const el = fakeEl() as ReturnType<typeof fakeEl> & Record<string, unknown>;
		el.getBoundingClientRect = () => ({
			left: LEFT,
			top: TOP,
			right: LEFT + 800,
			bottom: TOP + 600,
			width: 800,
			height: 600,
			x: LEFT,
			y: TOP,
		});
		el.querySelector = () => null;
		el.createDiv = () => ({
			setAttribute: () => {},
			remove: () => {},
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			setCssStyles: () => {},
			parentElement: el,
		});
		scroller = el;
		probe.current = {
			scroller: el,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
		};
		const win = {
			devicePixelRatio: 1,
			navigator: { userAgent: "", platform: "", maxTouchPoints: 0 },
			setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
			clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
			requestAnimationFrame: () => 0,
			getComputedStyle: () => ({ position: "relative" }),
		};
		ops = [];
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => [],
			() => "doc-1",
			() => [],
			(op) => void ops.push(op)
		);
		(controller as unknown as { bindTo(el: unknown): void }).bindTo(el);
	});

	afterEach(() => {
		(controller as unknown as { router: { dispose(): void } | null }).router?.dispose();
		resetTipModeForTest();
		setPenReticle(true);
	});

	it("control: ended by pointerup, the stroke stays where it was drawn and the lift point is added", () => {
		drawStroke();
		fire(penEvent("pointerup", 130, { x: 450, y: 230, pressure: 0, buttons: 0 }));
		const pts = committedPoints();
		// Harness sanity: the coordinate chain maps client (400,180) to page (50,50).
		expect(pts[0]!.x).toBeCloseTo(50, 3);
		expect(pts[0]!.y).toBeCloseTo(50, 3);
		// The pointerup lift position (client 450,230 = page 75,75) is appended.
		const last = pts[pts.length - 1]!;
		expect(last.x).toBeCloseTo(75, 3);
		expect(last.y).toBeCloseTo(75, 3);
		for (const p of pts) {
			expect(p.x).toBeGreaterThanOrEqual(49);
			expect(p.y).toBeGreaterThanOrEqual(49);
		}
	});

	it("ended by the engine's coordinate-less pointercancel, no point lands at window (0,0)", () => {
		drawStroke();
		fire(engineCancel(130));
		const pts = committedPoints();
		// Precondition: the real samples reached the builder before the cancel.
		expect(pts[0]!.x).toBeCloseTo(50, 3);
		expect(pts[0]!.y).toBeCloseTo(50, 3);
		expect(pts.length, "precondition: the moves were fed").toBeGreaterThanOrEqual(2);
		const stray = pts.filter((p) => p.x < 49 || p.y < 49);
		expect(
			stray,
			`the cancel's window (0,0) was committed as a stroke point; points=${JSON.stringify(pts)}`
		).toEqual([]);
		const op = ops[0] as Extract<InkOp, { type: "add" }>;
		const bbox = op.strokes[0]!.bbox;
		expect(bbox.x, `bbox dragged toward window origin: ${JSON.stringify(bbox)}`).toBeGreaterThan(40);
		expect(bbox.y, `bbox dragged toward window origin: ${JSON.stringify(bbox)}`).toBeGreaterThan(40);
	});

	it("eventless completion retains the drawn fragment and its page", () => {
		drawStroke();
		(controller as unknown as { penUp(): void }).penUp();
		const points = committedPoints();
		expect(points[0]).toEqual({ x: 50, y: 50 });
		expect(points.every((p) => p.x >= 50 && p.x <= 70 && p.y >= 50 && p.y <= 70)).toBe(true);
		const op = ops[0] as Extract<InkOp, { type: "add" }>;
		expect(op.strokes[0]!.page).toBe(1);
		expect(op.strokes[0]!.points.every((p) => p.pressure > 0)).toBe(true);
	});
});
