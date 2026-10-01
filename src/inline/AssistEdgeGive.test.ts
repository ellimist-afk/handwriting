/**
 * A FINGER AT AN END GIVES EVEN WHEN THERE IS NOTHING TO SCROLL.
 *
 * THE SYMPTOM, Alan on the device (vault test 2, 20c182e1, Infinite Canvas off): with the note
 * fitting the pane at 10 percent, a one-finger drag down at the top - or right at the left edge -
 * moves nothing at all. No give, no settle. And: "if I start a little not flush with the top, a
 * flick with momentum reproduces the bounce; if the viewport is flush with the top, one finger
 * cannot scroll to reproduce it."
 *
 * THE MECHANISM. The give is the remainder `carryScrollBy` refuses, and `carryScrollBy` only runs
 * while the ASSIST owns the drag. Ownership is decided once, at the contact, by the gate at
 * InlinePenRouter.ts:2711 - `canvasMomentumDisabled || (d.assistThisGesture && guardEnabled)`. When
 * that is false the touch is passed through to the native scroller instead, which is why a drag
 * that starts INSIDE the range looks fine: native scrolling carries it and nobody notices who owns
 * it. At an end native scrolling has nothing to do, so the gesture is dropped on the floor and
 * there is no refused remainder for the give to carry. The decision is made before any range
 * exists to carry, so it cannot be fixed later in the move.
 *
 * THE FIX. With an allowance on offer - which is Infinite Canvas OFF, since the host answers 0 when
 * it is on - the assist also takes a touch drag that BEGINS against an end, or with no range at all
 * on either axis. From there the give works exactly as it does at 400 percent: refused remainder,
 * capped at the allowance, released at the lift.
 *
 * WHAT MUST MOVE AND WHAT MUST NOT. Moving: a drag starting flush at an end now reports a pull and
 * a release, on a note that fits the pane and on one that does not. Not moving: a drag starting at
 * an end but heading INTO the range still scrolls and reports no pull; and the pen path is untouched -
 * this gate is inside the touch branch.
 *
 * THE GIVE MOVED INTO INFINITE CANVAS, so the flag's meaning is inverted and every row here is
 * restated against the new one. The rig now defaults to the canvas being ON, which is where a give
 * exists at all; the control at the bottom is the canvas being OFF, where the note scrolls like any
 * other Obsidian note and an end gives nothing.
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

/**
 * `rangeY` 0 models the note fitting the pane, which is Alan's 10 percent case; 3000 models a note
 * taller than its pane, where the same drag at the top still has an end under it.
 */
function rig(opts: { rangeX?: number; rangeY?: number; top?: number; left?: number; infiniteCanvas?: boolean } = {}) {
	const { rangeX = 0, rangeY = 0, top = 0, left = 0, infiniteCanvas = true } = opts;
	resetPenToolsForTest();
	const el: ReturnType<typeof fakeEl> & { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number; scrollTo(o: { left?: number; top?: number }): void } =
		Object.assign(fakeEl(), { scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0, scrollTo(o: { left?: number; top?: number }) { if (o.left !== undefined) el.scrollLeft = o.left; if (o.top !== undefined) el.scrollTop = o.top; } });
	Object.assign(el, { scrollWidth: 800 + rangeX, clientWidth: 800, scrollHeight: 600 + rangeY, clientHeight: 600 });
	el.scrollLeft = left;
	el.scrollTop = top;
	const pulls: { x: number; y: number }[] = [];
	let releases = 0;
	const record = recorder();
	const router = new InlinePenRouter(
		el as unknown as HTMLElement,
		el as unknown as HTMLElement,
		{
			...record.cb,
			fingerInk: () => false,
			penOff: () => false,
			// Mirrors the host (InkOverlay.ts `overscrollAllowancePx`): the canvas gives, canvas off does not.
			overscrollAllowancePx: () => (infiniteCanvas ? ALLOWANCE : 0),
			onOverscrollPull: (x: number, y: number) => pulls.push({ x, y }),
			onOverscrollRelease: () => void releases++,
		} as never,
		() => 1,
	);
	routers.push(router);

	function pointer(type: string, x: number, y: number, id = 31): void {
		const ev = penEvent(type, type === "pointerdown" ? 10 : 700, {
			pointerId: id, pointerType: "touch", x, y, isPrimary: id === 31, pressure: 0,
			buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
		});
		const handler = el.handlers.get(type);
		if (!handler) throw new Error(`missing handler ${type}`);
		handler(ev);
	}

	function pen(type: string, x: number, y: number): void {
		const ev = penEvent(type, type === "pointerdown" ? 10 : 700, {
			pointerId: 77, pointerType: "pen", x, y, isPrimary: true,
			pressure: type === "pointerup" ? 0 : 0.5,
			buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
		});
		const handler = el.handlers.get(type);
		if (!handler) throw new Error(`missing handler ${type}`);
		handler(ev);
	}

	/**
	 * One finger down and straight up again, with the event's own `preventDefault` recorded: a tap
	 * whose default is prevented never reaches the editor, and that is what swallowing a tap looks
	 * like from here.
	 */
	function tap(x: number, y: number): { defaultPrevented: boolean } {
		let prevented = false;
		for (const type of ["pointerdown", "pointerup"]) {
			const ev = {
				type, pointerType: "touch", pointerId: 31, isPrimary: true,
				clientX: x, clientY: y, pressure: 0, buttons: type === "pointerup" ? 0 : 1, button: 0,
				timeStamp: type === "pointerdown" ? 10 : 90, tiltX: 0, tiltY: 0, width: 0, height: 0,
				preventDefault: () => { prevented = true; }, stopPropagation: () => {},
			} as unknown as PointerEvent;
			const handler = el.handlers.get(type);
			if (!handler) throw new Error(`missing handler ${type}`);
			handler(ev);
		}
		return { defaultPrevented: prevented };
	}

	return {
		el, router, pointer, pen, tap, record, pulls,
		engaged: () => (router as unknown as { assistEngaged: boolean }).assistEngaged,
		panned: () => (router as unknown as { gesturePanned: boolean }).gesturePanned,
		lastPull: () => pulls.at(-1) ?? { x: 0, y: 0 },
		releaseCount: () => releases,
		/** Which side of the :2711 gate the contact went, as the router recorded it. */
		gate: () => (router as unknown as { assistGateReadout: Record<string, unknown> }).assistGateReadout,
	};
}

/** One finger down at `from`, dragged in `steps` of `stepPx` along `axis`, then lifted. */
function drag(h: ReturnType<typeof rig>, axis: "x" | "y", stepPx: number, steps: number, from = { x: 400, y: 100 }): void {
	const at = (i: number): { x: number; y: number } =>
		axis === "y" ? { x: from.x, y: from.y + i * stepPx } : { x: from.x + i * stepPx, y: from.y };
	h.pointer("pointerdown", at(0).x, at(0).y);
	for (let i = 1; i <= steps; i++) h.pointer("pointermove", at(i).x, at(i).y);
	h.pointer("pointerup", at(steps).x, at(steps).y);
}

describe("a lift against an end leaves the guard armed", () => {
	it("after a drag down at the top lifts, touch-action stays none: the next finger is ours, not the browser's", () => {
		const h = rig({ rangeX: 0, rangeY: 600, top: 0 });
		drag(h, "y", 20, 12);
		expect(h.pulls.length, "premise: the first drag pulled").toBeGreaterThan(0);
		expect(h.el.style.touchAction, "the native window opened against an end").toBe("none");
		drag(h, "y", 20, 12);
		expect(h.pulls.length, "the second drag pulled too").toBeGreaterThan(12);
		expect(h.el.style.touchAction, "still armed after the second lift").toBe("none");
	});
	it("CONTROL: a drag that lifts inside the range opens the native window as before", () => {
		const h = rig({ rangeX: 0, rangeY: 600, top: 300 });
		drag(h, "y", -20, 6);
		expect(h.panned() || h.pulls.length === 0, "premise: an ordinary scroll, no pull").toBe(true);
		expect(h.el.scrollTop, "premise: not at an end after the drag").toBeGreaterThan(0);
		expect(h.el.style.touchAction, "the native window did not open for an in-range lift").toBe("");
	});
});

describe("a drag that starts against an end", () => {
	it("the note FITS the pane: a finger dragged down still gives, capped at the allowance, and springs back on the lift", () => {
		// Alan's case: 10 percent, nothing to scroll in either direction.
		const h = rig({ rangeX: 0, rangeY: 0 });
		drag(h, "y", 20, 12);
		expect(h.pulls.length, `the drag reported a pull (gate ${JSON.stringify(h.gate())})`).toBeGreaterThan(0);
		expect(h.lastPull().y, "the give is downward and capped at the allowance").toBeCloseTo(ALLOWANCE, 5);
		expect(h.el.scrollTop, "and the scroller never left the top").toBe(0);
		expect(h.releaseCount(), "the lift released it").toBe(1);
	});

	it("flush at the top WITH range below: the same drag down gives, rather than being dropped", () => {
		// Alan's second sighting: a flick from a little way down reproduces the bounce, but flush at
		// the top one finger does nothing. Same page, same finger, different starting offset.
		const h = rig({ rangeY: 3000, top: 0 });
		drag(h, "y", 20, 12);
		expect(h.pulls.length, `the drag reported a pull (gate ${JSON.stringify(h.gate())})`).toBeGreaterThan(0);
		expect(h.lastPull().y, "capped at the allowance").toBeCloseTo(ALLOWANCE, 5);
		expect(h.el.scrollTop, "the scroller stayed at the top: this was all give").toBe(0);
		expect(h.releaseCount(), "and the lift released it").toBe(1);
	});

	it("at the left edge: a finger dragged right gives on x", () => {
		const h = rig({ rangeX: 0, rangeY: 3000, left: 0, top: 1200 });
		drag(h, "x", 20, 12);
		expect(h.pulls.length, `the drag reported a pull (gate ${JSON.stringify(h.gate())})`).toBeGreaterThan(0);
		expect(h.lastPull().x, "the give is rightward and capped at the allowance").toBeCloseTo(ALLOWANCE, 5);
		expect(h.el.scrollLeft, "and the scroller never left the left edge").toBe(0);
	});

	/**
	 * THE SECOND TRY, which is what a person actually does when the first does nothing.
	 *
	 * The assist only takes the FIRST finger of a gesture while the guard is armed. The guard starts
	 * armed, so a first drag is owned - which is why every cell above passes without any fix. It
	 * leaves the guard open on the lift and re-arms a second later, on a timer. A second drag inside
	 * that second is therefore NOT owned, is handed to the native scroller, and at an end the native
	 * scroller has nothing to do: no movement, no give, nothing to spring back from.
	 */
	it("a SECOND drag straight after the first, still at the end: it gives too", () => {
		const h = rig({ rangeX: 0, rangeY: 0 });
		drag(h, "y", 20, 12);
		const afterFirst = h.pulls.length;
		expect(afterFirst, "premise: the first drag gave").toBeGreaterThan(0);
		drag(h, "y", 20, 12);
		expect(h.pulls.length, `the second drag gave as well (gate ${JSON.stringify(h.gate())})`).toBeGreaterThan(afterFirst);
		expect(h.releaseCount(), "and both lifts released").toBe(2);
	});

	it("CONTROL: flush at the top but dragging INTO the range - the page scrolls and nothing is given", () => {
		const h = rig({ rangeY: 3000, top: 0 });
		drag(h, "y", -20, 12);
		expect(h.pulls, "nothing was refused, so nothing was pulled").toEqual([]);
		expect(h.el.scrollTop, "the scroller took the whole gesture").toBeGreaterThan(0);
		expect(h.releaseCount(), "and there was nothing to release").toBe(0);
	});

	/**
	 * A TAP IS NOT A DRAG, and on a note that fits the pane EVERY touch now begins against an end,
	 * so every touch takes the edge branch - including the tap that places the caret. The review's
	 * read, and the right one to check: taking the assist must not swallow a tap.
	 *
	 * What is asserted is what a swallowed tap would break: the contact's default is not prevented,
	 * so it still reaches the editor; the assist never ENGAGES, which is what claims the pointer and
	 * takes the gesture off the editor; the gesture is not marked as panned; and nothing is pulled
	 * or released. Ownership at the contact is recorded rather than denied - `took` is true - because
	 * that is exactly what changed, and a row that hid it would be lying about the mechanism.
	 */
	it("CONTROL: a tap on a fitting note still reaches the editor - ownership is taken, but nothing is engaged, pulled or prevented", () => {
		const h = rig({ rangeX: 0, rangeY: 0 });
		expect(h.tap(400, 100).defaultPrevented, "the tap's default was left alone").toBe(false);
		expect(h.engaged(), "the assist never engaged: the editor keeps the gesture").toBe(false);
		expect(h.panned(), "and the gesture was never marked as panned").toBe(false);
		expect(h.pulls, "nothing was pulled").toEqual([]);
		expect(h.releaseCount(), "and nothing released").toBe(0);
		expect(h.gate().took, "premise: the contact DID take the edge branch - this is the case under test").toBe(true);
	});

	it("CONTROL: a tap that wobbles under the slop is still a tap, not a give", () => {
		const h = rig({ rangeX: 0, rangeY: 0 });
		h.pointer("pointerdown", 400, 100);
		// ASSIST_SLOP_PX is 8; 3 px of wobble across two moves stays under it either way it is summed.
		h.pointer("pointermove", 401, 101);
		h.pointer("pointermove", 400, 102);
		h.pointer("pointerup", 400, 102);
		expect(h.engaged(), "under the slop the assist never engaged").toBe(false);
		expect(h.pulls, "so nothing was refused and nothing pulled").toEqual([]);
		expect(h.releaseCount(), "and nothing released").toBe(0);
	});

	/**
	 * THE OWNERSHIP MUST NOT STEAL A PEN. The edge condition is evaluated inside the touch branch,
	 * after the two-finger check, so neither a pen nor a second finger can reach it - but that is an
	 * argument about the code, and the whole point of this file is that such arguments have been
	 * wrong. These two rows measure it instead.
	 */
	it("CONTROL: a pen landing straight after a finger drag at the end is still a pen, not a give", () => {
		const h = rig({ rangeX: 0, rangeY: 0 });
		drag(h, "y", 20, 12);
		const pullsAfterFinger = h.pulls.length;
		expect(pullsAfterFinger, "premise: the finger drag gave").toBeGreaterThan(0);
		h.pen("pointerdown", 400, 300);
		for (let i = 1; i <= 6; i++) h.pen("pointermove", 400 + 20 * i, 300);
		h.pen("pointerup", 520, 300);
		expect(h.record.downs, "the pen stroke went down the pen path").toBe(1);
		expect(h.record.ups, "and came up it").toBe(1);
		expect(h.pulls.length, "the pen made no give of its own").toBe(pullsAfterFinger);
	});

	it("CONTROL: a second finger at the end is still a pinch, not a second give", () => {
		const h = rig({ rangeX: 0, rangeY: 0 });
		h.pointer("pointerdown", 400, 100);
		h.pointer("pointerdown", 460, 100, 32);
		for (let i = 1; i <= 6; i++) { h.pointer("pointermove", 400, 100 + 20 * i); h.pointer("pointermove", 460, 100 + 20 * i, 32); }
		expect(h.pulls, "two fingers dragged at the end: the pinch owns it, nothing is pulled").toEqual([]);
	});

	it("CONTROL: with the canvas OFF the note scrolls like any other, so an end gives nothing", () => {
		const h = rig({ rangeX: 0, rangeY: 0, infiniteCanvas: false });
		drag(h, "y", 20, 12);
		expect(h.pulls, "canvas off: the host offers no allowance, so nothing is refused into a pull").toEqual([]);
		expect(h.releaseCount()).toBe(0);
	});
});
