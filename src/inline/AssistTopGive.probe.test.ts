/**
 * PROBE: why a downward drag at the top gives at 72% and not at 400%.
 *
 * NOT A GATE CELL. This measures the router's own behaviour in two scroll regimes and
 * prints what it saw. It is deliberately assertion-light: the point is the numbers, and
 * the hypothesis under test is allowed to lose.
 *
 * THE HYPOTHESIS: at 72% the note FITS the pane, so the inner
 * scroller has no range, the assist pan is never what the writer feels, and the give
 * comes from the outer pane's native rubber band. At 400% the inner scroller HAS range,
 * the assist owns the gesture, and `carryScrollBy`'s clamp to [0, range] swallows the
 * whole drag.
 *
 * WHAT WOULD KILL IT: the router behaving DIFFERENTLY in the two regimes here. The fake
 * element has no outer pane and no native scrolling of any kind, so if the zero comes
 * out of the router in both regimes, the 72% give cannot be the router's and must be the
 * surface underneath it.
 *
 * Already measured elsewhere, and consistent with this: OverscrollEdgeBound.test.ts's
 * header records driving the same seam at scrollTop 0 and finding contentTop, viewTop
 * and scrollTop all still exactly 0 during the drag AND after release.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { InlinePenRouter } from "./InlinePenRouter";
import { resetPenToolsForTest } from "./PenToolsMode";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../../test/routerHarness";

let undoWindow: () => void;
const routers: InlinePenRouter[] = [];
const report: Record<string, unknown>[] = [];

beforeAll(() => {
	undoWindow = installFakeWindow();
});

afterAll(() => {
	undoWindow();
	// The probe's whole output: one line per regime, for the read that follows.
	console.log("ASSIST-TOP-GIVE " + JSON.stringify(report, null, 1));
});

afterEach(() => {
	for (const r of routers.splice(0)) r.dispose();
});

/**
 * `scale` is the note's zoom. `range` is the inner scroller's vertical range in layout
 * px: 0 models the note fitting the pane at 72%, 3000 models 400% with far more page
 * than pane.
 */
function rig(scale: number, range: number, momentumDisabled: boolean) {
	resetPenToolsForTest();
	const el: ReturnType<typeof fakeEl> & { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number; scrollTo(o: { left?: number; top?: number }): void } = Object.assign(fakeEl(), { scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0, scrollTo(o: { left?: number; top?: number }) { if (o.left !== undefined) el.scrollLeft = o.left; if (o.top !== undefined) el.scrollTop = o.top; } });
	Object.assign(el, { scrollWidth: 800, clientWidth: 800, scrollHeight: 600 + range, clientHeight: 600 });
	const record = recorder();
	const router = new InlinePenRouter(
		el as unknown as HTMLElement,
		el as unknown as HTMLElement,
		{ ...record.cb, fingerInk: () => false, penOff: () => false } as never,
		() => scale,
	);
	routers.push(router);
	if (momentumDisabled) router.setCanvasMomentumDisabled(true);

	function pointer(type: string, y: number): void {
		const ev = penEvent(type, type === "pointerdown" ? 10 : 700, {
			pointerId: 1,
			pointerType: "touch",
			x: 400,
			y,
			isPrimary: true,
			pressure: 0,
			buttons: type === "pointerup" ? 0 : 1,
		});
		const handler = el.handlers.get(type);
		if (!handler) throw new Error(`missing handler ${type}`);
		handler(ev);
	}

	return { el, router, pointer };
}

/** One finger down at the top of the pane, dragged DOWN 120 px in 20 px steps, then lifted. */
function dragDownAtTop(scale: number, range: number, momentumDisabled: boolean) {
	const h = rig(scale, range, momentumDisabled);
	h.el.scrollTop = 0;
	h.pointer("pointerdown", 100);
	for (let i = 1; i <= 6; i++) h.pointer("pointermove", 100 + i * 20);
	const duringDrag = {
		scrollTop: h.el.scrollTop,
		touchAction: h.el.style.touchAction,
		noMomentumClass: h.el.classList.contains("handwriting-no-momentum"),
		assistEngaged: (h.router as unknown as { assistEngaged: boolean }).assistEngaged,
		assistOwns: (h.router as unknown as { assistPointerId: number | null }).assistPointerId !== null,
		range: h.el.scrollHeight - h.el.clientHeight,
	};
	h.pointer("pointerup", 220);
	return { ...duringDrag, scrollTopAfterLift: h.el.scrollTop };
}

describe("a downward drag at the top of the note, per scroll regime", () => {
	for (const [name, scale, range] of [
		["72% zoom, note fits the pane (no inner range)", 0.72, 0],
		["400% zoom, note far taller than the pane", 4, 3000],
	] as const) {
		for (const momentumDisabled of [false, true]) {
			it(`${name}; Infinite Canvas ${momentumDisabled ? "ON" : "OFF"}`, () => {
				const seen = dragDownAtTop(scale, range, momentumDisabled);
				report.push({ regime: name, scale, momentumDisabled, ...seen });
				// The one claim this probe makes: a drag DOWN at the top never moves the
				// scroller, in either regime. Downward drag means scrollTop would have to
				// go negative, and the carry clamps at 0.
				expect(seen.scrollTop, "the scroller did not move during the drag").toBe(0);
				expect(seen.scrollTopAfterLift, "and is still at the top after the lift").toBe(0);
			});
		}
	}
});
