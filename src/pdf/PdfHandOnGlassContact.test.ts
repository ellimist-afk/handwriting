/**
 * GitHub issue 53, the PDF half of the two-pane fix. A finger or palm landing in a pane whose own glass is empty fans
 * `onHandOnGlass` out to every live router (InlinePenRouterInput.ts:217). The note's callback returns while its own
 * pane holds a contact (InkOverlayLifecycle.ts, `if (this.router?.isStroking) return;`). The PDF's callback was a bare
 * `hideCursor` (PdfInkBind.ts), on the reasoning that the router asks only when its own `handOnGlass()` was false. The
 * fan-out breaks that: the router that asks is the other pane's. So a palm resting beside a PDF that a pen was erasing
 * or lassoing took the ring down mid-stroke and `handwriting-pdf-hover` off the viewer, which restyles it.
 *
 * The fix is the note's guard on the PDF: this pane's contact, not any pane's. A mouse ring parked over this PDF while
 * a pen writes in another pane is still stood down by a palm, as the 1.4.12 rule says.
 *
 * The PDF is a real `PdfInkController` bound to the harness element, as PdfMouseReticleUnderHand.test.ts builds one,
 * so its pen contact goes through the router's own pointerdown branch and its callbacks are the production ones. The
 * other pane is a bare real router on its own harness element, there only to be landed on.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { setPenReticle } from "../inline/InkOverlay";
import { setMouseInk } from "../inline/MouseInk";
import { resetPenInkForTest } from "../inline/PenInk";
import { type InlinePenCallbacks, InlinePenRouter } from "../inline/InlinePenRouter";
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
vi.mock("./PdfViewerProbe", () => ({
	probeViewer: () => probe.current,
	viewerCanvasOf: () => null,
}));

import { PdfInkController } from "./PdfInkController";

const HOVER = "handwriting-pdf-hover";

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

/** The cursor fixture with its owned clipping parent, as PdfMouseReticleUnderHand.test.ts builds it. */
function cursorChildren(createCursor: () => any): (options?: { cls?: string }) => any {
	return (options) => {
		const cursor = createCursor();
		if (options?.cls !== "handwriting-pdf-cursor-viewport") return cursor;
		const viewport = {
			parentElement: cursor.parentElement,
			classList: { contains: (cls: string) => cls === "handwriting-pdf-cursor-viewport" },
			setCssStyles() {},
			createDiv: () => cursor,
			remove() { cursor.remove(); viewport.parentElement = null; },
		};
		cursor.parentElement = viewport;
		return viewport;
	};
}

interface Router {
	cb: InlinePenCallbacks;
	activePenId: number | null;
	activeIsPen: boolean;
	isStroking: boolean;
	dispose(): void;
}

/** A bare real router on its own element: the next pane, only there to be landed on. */
function otherPane(): { router: InlinePenRouter; fire(ev: PointerEvent): void } {
	const el = fakeEl();
	const noop = (): void => undefined;
	const cb: InlinePenCallbacks = {
		onPenDown: noop, onPenHover: noop, onPenLeave: noop, onPinch: noop, onPenRaw: noop, onPenMove: noop, onPenUp: noop,
	};
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb);
	return {
		router,
		fire: (ev) => {
			const h = el.handlers.get(ev.type);
			if (!h) throw new Error(`router registered no handler for ${ev.type}`);
			h(ev);
		},
	};
}

describe("a hand landing in another pane leaves this PDF's ring and hover class alone while the pen is down here", () => {
	let uninstallWindow: () => void = () => {};
	beforeAll(() => {
		uninstallWindow = installFakeWindow();
	});
	afterAll(() => {
		uninstallWindow();
	});

	let priv: {
		showCursor(s: PenSample, pointerType?: string): string;
		router: Router | null;
	};
	let cursorStyle: Record<string, unknown>;
	let scroller: ReturnType<typeof fakeEl>;
	let panes: InlinePenRouter[];

	function fire(ev: PointerEvent): void {
		const h = scroller.handlers.get(ev.type);
		if (!h) throw new Error(`the router registered no handler for ${ev.type}`);
		h(ev as unknown as Event);
	}

	function pane(): ReturnType<typeof otherPane> {
		const p = otherPane();
		panes.push(p.router);
		return p;
	}

	/** A pen down on this PDF, through the router's own pointerdown branch, with the in-gesture ring painted. */
	function penDownWithRing(): void {
		fire(penEvent("pointerdown", 1, { pointerType: "pen", pointerId: 7, x: 120, y: 300, buttons: 1 }));
		expect(priv.router?.isStroking, "precondition: the pen's contact was not claimed here").toBe(true);
		// The in-gesture paint the eraser, lasso and space rings use (showEraserCursor and its twins).
		priv.showCursor(sample(120, 300));
		expect(cursorStyle.display, "precondition: the eraser's ring did not paint mid-stroke").toBe("block");
		expect(scroller.classList.contains(HOVER), "precondition: the ring's paint did not put the hover class on").toBe(true);
	}

	beforeEach(() => {
		panes = [];
		resetTipModeForTest();
		setTipMode("eraser");
		setPenReticle(true);
		setMouseInk(false);
		resetPenInkForTest();
		cursorStyle = { display: "none" };
		const el = fakeEl() as ReturnType<typeof fakeEl> & Record<string, unknown>;
		el.querySelector = () => null;
		el.createDiv = cursorChildren(() => ({
			setAttribute: () => {},
			remove: () => {},
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			setCssStyles: (styles: Record<string, unknown>) => {
				Object.assign(cursorStyle, styles);
			},
			parentElement: el,
		}));
		scroller = el;
		probe.current = {
			scroller: el,
			scaleFactor: 2,
			scaleSource: "test",
			pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
		};
		const win = {
			devicePixelRatio: 1,
			// Desktop, non-Apple, as PdfMouseReticleUnderHand.test.ts: the palm shield and the pinch bridge take only
			// touch events, so neither shadows the router's pointer handlers on this one-handler-per-type fake.
			navigator: { userAgent: "", platform: "", maxTouchPoints: 0 },
			setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
			clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
			requestAnimationFrame: () => 0,
			getComputedStyle: () => ({ position: "relative" }),
		};
		const controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => [],
			() => "doc-1",
			() => [],
			() => {}
		);
		priv = controller as unknown as typeof priv;
		(controller as unknown as { bindTo(el: unknown): void }).bindTo(el);
	});

	afterEach(() => {
		for (const r of panes) r.dispose();
		if (priv.router) {
			priv.router.activePenId = null;
			priv.router.activeIsPen = false;
		}
		priv.router?.dispose();
		resetTipModeForTest();
		setMouseInk(false);
		resetPenInkForTest();
		setPenReticle(true);
	});

	it("a palm landing in the next pane while the pen erases here leaves the ring and the hover class on", () => {
		penDownWithRing();
		const other = pane();
		other.fire(penEvent("pointerdown", 2, { pointerType: "touch", pointerId: 2, x: 120, y: 300, buttons: 1 }));
		expect(cursorStyle.display, "a palm in the next pane took this PDF's ring down mid-stroke").toBe("block");
		expect(scroller.classList.contains(HOVER), "a palm in the next pane restyled this PDF mid-stroke").toBe(true);
	});

	it("this PDF's own stand-down, called while its pen is down, changes neither the ring nor the class", () => {
		penDownWithRing();
		priv.router?.cb.onHandOnGlass?.();
		expect(cursorStyle.display, "the stand-down took the ring down during this pane's own contact").toBe("block");
		expect(scroller.classList.contains(HOVER), "the stand-down took the hover class off during the contact").toBe(true);
	});

	// The guard is THIS pane's contact, not any pane's: a mouse ring parked over this PDF, with a pen writing in the
	// next pane, is still stood down by a palm, as the 1.4.12 rule says.
	it("control: a pen down in the next pane does not keep a mouse ring parked on this PDF up under a palm", () => {
		priv.showCursor(sample(10, 10), "mouse");
		expect(cursorStyle.display, "precondition: the mouse ring did not paint").toBe("block");
		const other = pane();
		const r = other.router as unknown as Router;
		r.activePenId = 7;
		r.activeIsPen = true;
		try {
			priv.router?.cb.onHandOnGlass?.();
		} finally {
			r.activePenId = null;
			r.activeIsPen = false;
		}
		expect(cursorStyle.display, "the mouse ring under the palm was left up").toBe("none");
		expect(scroller.classList.contains(HOVER), "cursor:none was left on with no ring under it").toBe(false);
	});

	it("control: with no pen down anywhere, a palm landing in the next pane stands this PDF's mouse ring down", () => {
		priv.showCursor(sample(10, 10), "mouse");
		expect(cursorStyle.display, "precondition: the mouse ring did not paint").toBe("block");
		const other = pane();
		other.fire(penEvent("pointerdown", 2, { pointerType: "touch", pointerId: 2, x: 120, y: 300, buttons: 1 }));
		expect(cursorStyle.display, "a palm in the next pane no longer stands this PDF's mouse ring down").toBe("none");
		expect(scroller.classList.contains(HOVER), "cursor:none was left on with no ring under it").toBe(false);
	});
});
