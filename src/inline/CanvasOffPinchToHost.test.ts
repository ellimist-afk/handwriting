/**
 * WITH THE CANVAS OFF THE HOST OWNS THE TWO-FINGER GESTURE.
 *
 * THE SYMPTOM. Alan, 2026-09-20: "no it should not eliminate all pinch behavior. yes, it should
 * stay obsidian stock behavior". With the Infinite Canvas off the note zoomed for nothing at all -
 * the plugin refused to zoom it, and the host never got the chance to.
 *
 * THE MECHANISM. a4508b26 put the refusal in the overlay: `onPinch` returns at once when the
 * canvas is off, so no preview opens and no scale moves. The ROUTER was not told. It still
 * recorded the second contact, still called `applyGuard(this.manip.pinchStart(), "pinch")`, and
 * the guard puts `touch-action: none` on the scroller - so the browser's own pinch was cancelled
 * before it began. Two refusals, no behaviour.
 *
 * THE FIX. A `pinchZoom` callback beside `fingerInk` on the router's callback bag, asked BEFORE
 * the second contact is recorded or guarded. Undefined means yes, which is every existing caller
 * including the PDF surface. The overlay answers it with `this.canvasMode`.
 *
 * THE RIG. The real router on the shared element fake (test/routerHarness.ts), driven through
 * pointerdown the way the device drives it - NOT through `router.beginPinch`, which is what the
 * render-side refusal pin calls and is exactly why that pin cannot see this defect.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installFakeWindow, fakeEl, penEvent } from "../../test/routerHarness";
import { InlinePenRouter, type InlinePenCallbacks } from "./InlinePenRouter";

let uninstall: (() => void) | null = null;
beforeEach(() => { uninstall = installFakeWindow(); });
afterEach(() => { uninstall?.(); uninstall = null; });

/** Two fingers down, in order, on a surface whose host answers `pinchZoom` with `canvasOn`. */
function twoFingers(canvasOn: boolean | undefined) {
	const el = fakeEl();
	let pinches = 0;
	const cb: InlinePenCallbacks = {
		onPenDown: () => {},
		onPenHover: () => {},
		onPenLeave: () => {},
		onPinch: () => void pinches++,
		onPenRaw: () => {},
		onPenMove: () => {},
		onPenUp: () => {},
		...(canvasOn === undefined ? {} : { pinchZoom: () => canvasOn }),
	};
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb);
	const fire = (ev: PointerEvent) => {
		const h = el.handlers.get(ev.type);
		if (!h) throw new Error(`router registered no handler for ${ev.type}`);
		h(ev);
	};
	const t = performance.now();
	fire(penEvent("pointerdown", t, { pointerId: 861, pointerType: "touch", x: 300, y: 400, pressure: 0 }));
	fire(penEvent("pointerdown", t + 8, { pointerId: 862, pointerType: "touch", x: 500, y: 400, pressure: 0, isPrimary: false }));
	// `pinchLive` is NOT the signal here: it turns true only on a later move that passes
	// `pinchEngaged`. "The router is watching for a pinch" is `pinchStartSpread`, which
	// `beginPinch` sets from the two contacts and nothing else writes.
	const r = router as unknown as { touchPos: Map<number, unknown>; guardTouches: Set<number>; pinchStartSpread: number };
	return { el, router, get pinches() { return pinches; }, touches: r.touchPos.size, guarded: r.guardTouches.size, watched: r.pinchStartSpread };
}

/** One finger down, and what the guard wrote on the scroller when it landed. */
function oneFinger(canvasOn: boolean | undefined): { touchAction: string; touches: number } {
	const el = fakeEl();
	const cb: InlinePenCallbacks = {
		onPenDown: () => {}, onPenHover: () => {}, onPenLeave: () => {}, onPinch: () => {},
		onPenRaw: () => {}, onPenMove: () => {}, onPenUp: () => {},
		...(canvasOn === undefined ? {} : { pinchZoom: () => canvasOn }),
	};
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb);
	const h = el.handlers.get("pointerdown");
	if (!h) throw new Error("router registered no pointerdown handler");
	h(penEvent("pointerdown", performance.now(), { pointerId: 861, pointerType: "touch", x: 300, y: 400, pressure: 0 }));
	const r = router as unknown as { touchPos: Map<number, unknown> };
	return { touchAction: el.style.touchAction, touches: r.touchPos.size };
}

describe("canvas off: the second finger is the host's", () => {
	it("before the fix: the plugin claims nothing - the second contact is never recorded, never guarded, and no pinch is watched", () => {
		const s = twoFingers(false);
		expect(s.touches, "the second contact was recorded in touchPos").toBe(1);
		expect(s.guarded, "the second contact was added to the guard's touch set").toBe(1);
		expect(s.watched, "the router began watching a pinch with the canvas off").toBe(0);
		expect(s.pinches, "onPinch was called with the canvas off").toBe(0);
	});

	it("CANVAS ON: the same two fingers are still the plugin's - contact recorded, guard armed, pinch live", () => {
		const s = twoFingers(true);
		expect(s.touches, "premise: both contacts are tracked with the canvas on").toBe(2);
		expect(s.watched, "the router did not begin watching the pinch with the canvas on").toBeGreaterThan(0);
		expect(s.el.style.touchAction, "the guard did not take the surface for the pinch").toBe("none");
	});

	it("NO CALLBACK: a host that does not answer keeps the router's existing behaviour, which is what the PDF surface relies on", () => {
		const s = twoFingers(undefined);
		expect(s.touches, "an unanswered pinchZoom changed the contact bookkeeping").toBe(2);
		expect(s.watched, "an unanswered pinchZoom stopped the pinch being watched").toBeGreaterThan(0);
	});

	it("before the guard fix: the guard arms at pinch-zoom with the canvas off, so the browser still owns the two-finger zoom it decided about at the FIRST contact", () => {
		const s = oneFinger(false);
		expect(s.touches, "premise: the first finger is still ours, the assist pan needs it").toBe(1);
		expect(s.touchAction, "the scroller was armed at none, which takes the host's pinch away before the second finger lands").toBe("pinch-zoom");
	});

	it("CANVAS ON: the guard arms at none, exactly as it always has", () => {
		expect(oneFinger(true).touchAction, "the canvas-on guard changed").toBe("none");
	});

	it("NO CALLBACK: an unanswering host keeps the surface's own guard value", () => {
		expect(oneFinger(undefined).touchAction, "an unanswered pinchZoom changed the guard").toBe("none");
	});
});
