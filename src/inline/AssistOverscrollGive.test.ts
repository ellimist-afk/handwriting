/**
 * THE PAGE GIVES A LITTLE AT THE END, AND SPRINGS BACK.
 *
 * THE SYMPTOM, Alan, two sightings of one bug. (line 7) At 400% zoom, a one-finger drag
 * down at the top of the note moves nothing at all; at 72% the same drag gives about
 * 90 px and settles back. (line 5) A two-finger pan past the floor-side end gives
 * nothing either. He wants the give at every zoom, about an inch, then a spring back.
 *
 * THE MECHANISM. Both gestures are the same path: the assist pan, not the pinch
 * (read at the time). `carryScrollBy` writes `scrollLeft`/`scrollTop`
 * through `carryStep`, which is hard-clamped to `[0, range]`. At an end the requested
 * delta is dropped on the floor - no transient offset, no visual - so the page cannot
 * move by one px and there is nothing to spring back from. Measured in
 * AssistTopGive.probe: the assist owns the gesture at 0.72 and at 4.0 alike, and
 * scrollTop stays 0 during the drag and after the lift.
 *
 * THE FIX. The remainder the clamp refuses becomes a transient PULL, capped at the
 * allowance A (96 painted px x the external scale, the ruled constant), reported to the
 * host through `onOverscrollPull`. The host paints it on `viewportPan`. On the lift
 * `onOverscrollRelease` folds it into the standing pan and hands it to the existing
 * `resumeStrandedPan` - the one return a lift already has, which eases it to zero through
 * the same bounce the pinch settle uses. Infinite Canvas OFF only: with
 * IC on, a page pushed past an end is showing room it can grow into, and there is no
 * boundary to bounce off (the rule `startOverscrollBounce` already states).
 *
 * SCOPE: line 7 only. Line 5's two-finger pan never reaches this path at all - see the
 * second cell, which pins that gap rather than hiding it.
 *
 * WHAT MUST MOVE AND WHAT MUST NOT. Moving: a one-finger drag at an end now reports a
 * pull, capped at A, and a release at the lift. Not moving: scrolling INSIDE the range reports no
 * pull at all and scrolls exactly as before; with Infinite Canvas on nothing is reported;
 * and the scroller's own offset is never pushed out of `[0, range]` by any of this.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { InlinePenRouter } from "./InlinePenRouter";
import { resetPenToolsForTest } from "./PenToolsMode";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../../test/routerHarness";

/** The allowance the host offers, painted px. 96 x external scale; external is 1 here. */
const ALLOWANCE = 96;

let undoWindow: () => void;
const routers: InlinePenRouter[] = [];

beforeAll(() => {
	undoWindow = installFakeWindow();
});

afterAll(() => {
	undoWindow();
});

afterEach(() => {
	for (const r of routers.splice(0)) r.dispose();
});

interface Pull {
	x: number;
	y: number;
}

function rig(opts: { scale?: number; rangeX?: number; rangeY?: number; infiniteCanvas?: boolean } = {}) {
	const { scale = 1, rangeX = 0, rangeY = 3000, infiniteCanvas = false } = opts;
	resetPenToolsForTest();
	const el: ReturnType<typeof fakeEl> & { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number; scrollTo(o: { left?: number; top?: number }): void } = Object.assign(fakeEl(), { scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0, scrollTo(o: { left?: number; top?: number }) { if (o.left !== undefined) el.scrollLeft = o.left; if (o.top !== undefined) el.scrollTop = o.top; } });
	Object.assign(el, { scrollWidth: 800 + rangeX, clientWidth: 800, scrollHeight: 600 + rangeY, clientHeight: 600 });
	const record = recorder();
	const pulls: Pull[] = [];
	let releases = 0;
	const router = new InlinePenRouter(
		el as unknown as HTMLElement,
		el as unknown as HTMLElement,
		{
			...record.cb,
			fingerInk: () => false,
			penOff: () => false,
			overscrollAllowancePx: () => (infiniteCanvas ? 0 : ALLOWANCE),
			onOverscrollPull: (x: number, y: number) => pulls.push({ x, y }),
			onOverscrollRelease: () => void releases++,
		} as never,
		() => scale,
	);
	routers.push(router);

	function pointer(type: string, id: number, x: number, y: number, primary = true): void {
		const ev = penEvent(type, type === "pointerdown" ? 10 : 700, {
			pointerId: id,
			pointerType: "touch",
			x,
			y,
			isPrimary: primary,
			pressure: 0,
			buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
		});
		const handler = el.handlers.get(type);
		if (!handler) throw new Error(`missing handler ${type}`);
		handler(ev);
	}

	return {
		el,
		pointer,
		pulls,
		lastPull: () => pulls.at(-1) ?? { x: 0, y: 0 },
		releaseCount: () => releases,
	};
}

/** One finger, dragged in `steps` of `stepPx` along `axis`, then lifted. */
function drag(
	h: ReturnType<typeof rig>,
	axis: "x" | "y",
	stepPx: number,
	steps: number,
	fingers = 1,
): void {
	const at = (i: number): { x: number; y: number } =>
		axis === "y" ? { x: 400, y: 100 + i * stepPx } : { x: 400 + i * stepPx, y: 300 };
	for (let f = 1; f <= fingers; f++) {
		const p = at(0);
		h.pointer("pointerdown", f, p.x + (f - 1) * 60, p.y, f === 1);
	}
	for (let i = 1; i <= steps; i++) {
		const p = at(i);
		for (let f = 1; f <= fingers; f++) h.pointer("pointermove", f, p.x + (f - 1) * 60, p.y, f === 1);
	}
	for (let f = fingers; f >= 1; f--) {
		const p = at(steps);
		h.pointer("pointerup", f, p.x + (f - 1) * 60, p.y, f === 1);
	}
}

describe("the assist pan gives at an end and springs back", () => {
	it("one finger dragged down at the top, 400%: the page gives, capped at the allowance", () => {
		const h = rig({ scale: 4, rangeY: 3000 });
		h.el.scrollTop = 0;
		drag(h, "y", 20, 6);
		expect(h.pulls.length, "the drag reported a pull").toBeGreaterThan(0);
		expect(h.lastPull().y, "the give is downward and capped at A").toBeCloseTo(ALLOWANCE, 5);
		expect(h.el.scrollTop, "and the scroller itself never left the top").toBe(0);
		expect(h.releaseCount(), "the lift released it").toBe(1);
	});

	/**
	 * LINE 5 IS NOT FIXED BY THIS WRITE, and this cell records why rather than pretending.
	 *
	 * The ruling's premise was that a two-finger pan reaches `carryScrollBy` like the
	 * one-finger drag. It does not: `beginPinch` clears `assistPointerId`,
	 * `assistEngaged` and the samples on the SECOND contact, so with two fingers down
	 * there is no assist pointer, `assistMove` returns false for both, and the carry is
	 * never called. A two-finger drag whose spread holds steady therefore moves the page
	 * not at all - neither pan nor pinch - and there is no refused remainder for the give
	 * to carry. Measured, not read: pull stays 0 and the scroller never moves.
	 *
	 * This asserts today's behaviour so the gap is visible and pinned. When a ruling
	 * rules where line 5's give belongs - the pinch settle's clamp, or beginPinch ceasing
	 * to cancel the assist - this cell is the one to turn red first.
	 */
	it("two fingers at the floor-side end: no pan, no give - the gap line 5 still has", () => {
		const h = rig({ scale: 1, rangeX: 0, rangeY: 0 });
		h.el.scrollLeft = 0;
		drag(h, "x", 20, 4, 2);
		expect(h.pulls, "no assist, so nothing was refused and nothing was pulled").toEqual([]);
		expect(h.el.scrollLeft, "and the scroller never moved").toBe(0);
		expect(h.releaseCount(), "nothing to release").toBe(0);
	});

	it("CONTROL: scrolling inside the range is untouched - no pull, and the scroller moves", () => {
		const h = rig({ scale: 1, rangeY: 3000 });
		h.el.scrollTop = 1000;
		drag(h, "y", -20, 6);
		expect(h.pulls, "nothing was refused, so nothing was pulled").toEqual([]);
		expect(h.el.scrollTop, "the scroller took the whole gesture").toBeGreaterThan(1000);
		expect(h.releaseCount(), "and there was nothing to release").toBe(0);
	});

	it("CONTROL: with Infinite Canvas on, an end is not a boundary and nothing is pulled", () => {
		const h = rig({ scale: 4, rangeY: 3000, infiniteCanvas: true });
		h.el.scrollTop = 0;
		drag(h, "y", 20, 6);
		expect(h.pulls, "IC on: no give, the page grows into the room instead").toEqual([]);
		expect(h.el.scrollTop).toBe(0);
		expect(h.releaseCount()).toBe(0);
	});
});
