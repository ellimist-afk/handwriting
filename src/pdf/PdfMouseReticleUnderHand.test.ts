
/** Extend the existing cursor fixture with its owned clipping parent. */
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
/**
 * "Product ruling: hide the mouse reticle when a finger or pen is active."
 * (Alan, 1.4.12.) `MouseReticleUnderHand.test.ts` (src/inline/) is this rule
 * on the note surface; this is the PDF half, closed by this brief
 * (pdf-ring-under-hand) rather than left "found-not-fixed".
 *
 * THE SYMPTOM, on the current (pre-fix) code. `PdfInkController` builds its
 * stroke handling on the SAME `InlinePenRouter` the note surface does
 * (`this.router = new InlinePenRouter(...)`, PdfInkController.ts) and reads
 * `penReticleShown` from the same PenCursor.ts module - but it never asked
 * `router.handOnGlass()`, and `onHandOnGlass` was left `undefined` in the
 * callbacks object it hands the router (an OPTIONAL, note-only member,
 * InkSurfaces.ts's docstring on `onHandOnGlass?`). An undefined member reads
 * as "this surface has no reticle to stand down", so with mouse ink armed a
 * parked mouse's ring floated over a PDF the whole time a finger flung the
 * page or a pen wrote on it - the note's own defect, one release later, on
 * the other surface.
 *
 * THE FIX, reusing the door the note surface already built: `showCursor`
 * (the pdf's mouse-hover-reticle decision, mirroring `InkOverlay.showPenCursor`)
 * now reads `this.router?.handOnGlass?.()` and refuses to paint while a hand
 * is on the glass; the callbacks object's `onHandOnGlass` now stands the ring
 * down (`hideCursor`) on the edge a stale ring needs. No second notion of
 * "a hand is on the glass" - `handOnGlass()` is the note's own derived
 * boolean, read here rather than recomputed.
 *
 * WHAT THIS FILE DRIVES. A REAL `PdfInkController` bound (`bindTo`) to the
 * shared element fake (`test/routerHarness.ts`), so touch/pen pointerdown and
 * pointerup go through the router's own touch branch, palm gate and
 * `activePenId` bookkeeping before anything of this surface runs - the same
 * idiom `PdfInkController.test.ts`'s "an armed mouse leaving the pane" suite
 * (src/pdf/PdfInkController.test.ts:2954) uses for the same reason. The mouse
 * reticle itself is painted with a direct `showCursor` call, exactly as that
 * suite does: `onPenHover` reaching a mouse sample at all requires
 * `mouseActsAsPen` (mouse ink armed AND a lit tool AND a device that has
 * seen a pen), machinery this file has no need to stand up when the thing
 * under test is what `showCursor` does once a mouse sample already arrived.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest } from "../inline/TipMode";
import { setPenReticle } from "../inline/InkOverlay";
import { setMouseInk } from "../inline/MouseInk";
import { resetPenInkForTest, setPenInk } from "../inline/PenInk";
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

const SCALE = 2;

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

describe("PdfInkController reticle - the mouse stands down while a hand is on the glass", () => {
	let uninstallWindow: () => void = () => {};
	beforeAll(() => {
		uninstallWindow = installFakeWindow();
	});
	afterAll(() => {
		uninstallWindow();
	});

	let controller: PdfInkController;
	let priv: {
		showCursor(s: PenSample, pointerType?: string): string;
		router: { handOnGlass(): boolean; dispose(): void } | null;
	};
	let cursorStyle: Record<string, unknown>;
	let scroller: ReturnType<typeof fakeEl>;

	function fire(ev: PointerEvent): void {
		const h = scroller.handlers.get(ev.type);
		if (!h) throw new Error(`the router registered no handler for ${ev.type}`);
		h(ev as unknown as Event);
	}

	beforeEach(() => {
		resetTipModeForTest();
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
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = {
			devicePixelRatio: 1,
			// Desktop, non-Apple: the palm shield and the pinch bridge both
			// attach, and both take only touch events, so neither can shadow
			// the router's pointer handlers on this one-handler-per-type fake.
			navigator: { userAgent: "", platform: "", maxTouchPoints: 0 },
			setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
			clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
			requestAnimationFrame: () => 0,
			getComputedStyle: () => ({ position: "relative" }),
		};
		controller = new PdfInkController(
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
		priv.router?.dispose();
		setMouseInk(false);
		resetPenInkForTest();
		setPenReticle(true);
	});

	it("RED-WATCHED: a touch pointerdown hides the parked mouse's ring", () => {
		priv.showCursor(sample(10, 10), "mouse");
		expect(cursorStyle.display, "the mouse reticle never painted to begin with").toBe("block");

		// A real touch contact, through the router's own pointerdown branch -
		// this is `InlinePenRouter.handOnGlass()`'s FINGER term
		// (`guardTouches`), and the edge that fires `onHandOnGlass`.
		fire(penEvent("pointerdown", 1, { pointerType: "touch", x: 120, y: 300, buttons: 1 }));

		expect(
			cursorStyle.display,
			"the mouse's ring was left floating on the page under the writing hand"
		).toBe("none");
		expect(
			scroller.classList.contains("handwriting-pdf-hover"),
			"cursor:none was left over the scroller with no ring under it"
		).toBe(false);
	});

	it("RED-WATCHED: after that touch's pointerup, the next mouse hover brings the ring back", () => {
		priv.showCursor(sample(10, 10), "mouse");
		fire(penEvent("pointerdown", 1, { pointerType: "touch", x: 120, y: 300, buttons: 1 }));
		expect(cursorStyle.display).toBe("none");

		fire(penEvent("pointerup", 2, { pointerType: "touch", x: 120, y: 300, buttons: 0 }));
		expect(
			priv.router?.handOnGlass(),
			"the finger's lift did not clear the router's own touch bookkeeping"
		).toBe(false);

		const outcome = priv.showCursor(sample(10, 10), "mouse");
		expect(outcome, "the mouse hover was refused after the hand left the glass").toBe("wrote");
		expect(cursorStyle.display, "the mouse never got its reticle back").toBe("block");
	});

	it("RED-WATCHED: a pen pointerdown hides the parked mouse's ring, and a mouse nudged mid-stroke paints nothing", () => {
		priv.showCursor(sample(10, 10), "mouse");
		expect(cursorStyle.display).toBe("block");

		// A real claimed pen contact - `handOnGlass()`'s CLAIMED-PEN term
		// (`activePenId` + `activeIsPen`). `penDown`'s own
		// `if (!this.mouseStroke) this.hideCursor()` already takes the ring
		// down here on UNMODIFIED code too - that line predates this brief
		// and is not what is under test - so the case that actually
		// discriminates old code from new is the wrist-bump below: a stray
		// mouse sample arriving while the pen is still down.
		fire(penEvent("pointerdown", 1, { pointerType: "pen", x: 120, y: 300, buttons: 1 }));
		expect(
			cursorStyle.display,
			"the mouse's ring stayed up while a pen was writing on the page"
		).toBe("none");

		const outcome = priv.showCursor(sample(10, 10), "mouse");
		expect(
			outcome,
			"a mouse nudged mid pen-stroke painted its ring back under the writing hand"
		).toBe("hand-on-glass");
		expect(cursorStyle.display, "a refused mouse sample put the ring back").toBe("none");
	});

	it("RED-WATCHED: a pen HOVERING with no contact also hides the mouse's ring", () => {
		priv.showCursor(sample(10, 10), "mouse");
		expect(cursorStyle.display).toBe("block");

		// A pen approaching, never touching down - `handOnGlass()`'s
		// HOVERING-PEN term (the `HOVER_GHOST_MS` window off `penHoverAt`).
		// This paints the pen's own ring too (onPenHover -> showCursor
		// pointerType "pen"), so re-paint a mouse sample directly afterward
		// to ask what the MOUSE gets, same as the two suites above.
		fire(penEvent("pointermove", 1, { pointerType: "pen", x: 120, y: 300, buttons: 0 }));
		const outcome = priv.showCursor(sample(10, 10), "mouse");

		expect(
			outcome,
			"a mouse sample painted its ring while a pen was hovering with no contact"
		).toBe("hand-on-glass");
		expect(
			priv.router?.handOnGlass(),
			"a hovering pen with no contact was not read as a hand on the glass"
		).toBe(true);
	});

	it("NEGATIVE CONTROL: with no touch or pen anywhere, PDF mouse hover behaves exactly as today", () => {
		expect(
			priv.router?.handOnGlass(),
			"an untouched router claimed a hand was already on it"
		).toBe(false);

		const outcome = priv.showCursor(sample(10, 10), "mouse");

		expect(outcome).toBe("wrote");
		expect(cursorStyle.display).toBe("block");
		expect(scroller.classList.contains("handwriting-pdf-hover")).toBe(true);
	});

	it("Keyboard mode cannot repaint a claimed mouse reticle after the hide fanout", () => {
		priv.showCursor(sample(10, 10), "mouse");
		expect(cursorStyle.display).toBe("block");
		(priv as typeof priv & { mouseStroke: boolean }).mouseStroke = true;
		setPenInk(false);
		(controller as unknown as { hideCursor(): void }).hideCursor();
		const mouseOutcome = priv.showCursor(sample(20, 20), "mouse");
		const inGestureOutcome = priv.showCursor(sample(30, 30));
		expect(mouseOutcome).toBe("off");
		expect(inGestureOutcome).toBe("off");
		expect(cursorStyle.display).toBe("none");
		expect(scroller.classList.contains("handwriting-pdf-hover")).toBe(false);
	});
});
