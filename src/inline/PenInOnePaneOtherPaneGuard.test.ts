/**
 * THE PEN IN ONE PANE STOPS THE OTHER PANE'S FINGER, AND THAT PANE'S GUARD HEARS IT.
 *
 * Two panes side by side, one hand. The pen landing in pane A already stops the finger pan and the pinch the hand
 * was running in pane B: those fingers are the writing hand now. But B's own guard was never told. It stayed in its
 * finger state with the gesture marked as panned, so when the hand lifted off B the lift opened B's native touch
 * window for a second, and the edge of the writing hand landing in B inside that second was handed to the browser
 * and panned the other note.
 *
 * THE FIX tells B's guard what a pen in B itself would: the standing guard is up and those fingers are palm. Nothing
 * else of B's moves: no new guard, no timer, no palm timing, and B's "this gesture panned" mark stays as it is, so a
 * lift of a finger that panned is never mistaken for a tap.
 *
 * Every pane here is its own element fake and its own real router; they share only the fake window, and nothing
 * these cells drive is delivered through it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { clearInlinePenTrace, InlinePenRouter } from "./InlinePenRouter";
import { resetPenToolsForTest } from "./PenToolsMode";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../../test/routerHarness";

let undoWindow: () => void;
const routers: InlinePenRouter[] = [];

beforeAll(() => {
	undoWindow = installFakeWindow();
	setDiagnosticsEnabled(true);
});

afterAll(() => {
	setDiagnosticsEnabled(false);
	undoWindow();
});

afterEach(() => {
	for (const r of routers.splice(0)) r.dispose();
	clearInlinePenTrace();
	vi.useRealTimers();
});

const PEN = 77;
/** The second finger of a pair in pane B. */
const SECOND = 32;

/** The router state these cells read, none of it public. */
interface Peek {
	manip: { current: string };
	rearmTimer: unknown;
	gesturePanned: boolean;
	assistPointerId: number | null;
	pinchLive: boolean;
	touchPos: Map<number, unknown>;
}

/**
 * One pane: a scroller in the middle of a page that scrolls both ways, so no lift lands against an end. "note" is
 * built with the defaults (the note surface keeps the native window); "pdf" the way the PDF surface builds it.
 */
function pane(surface: "note" | "pdf" = "note") {
	resetPenToolsForTest();
	const el: ReturnType<typeof fakeEl> & { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number; scrollTo(o: { left?: number; top?: number }): void } =
		Object.assign(fakeEl(), { scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0, scrollTo(o: { left?: number; top?: number }) { if (o.left !== undefined) el.scrollLeft = o.left; if (o.top !== undefined) el.scrollTop = o.top; } });
	Object.assign(el, { scrollWidth: 1600, clientWidth: 800, scrollHeight: 1200, clientHeight: 600 });
	el.scrollTop = 300;
	el.scrollLeft = 400;
	let taps = 0;
	const cb = { ...recorder().cb, fingerInk: () => false, penOff: () => false, onTapLift: () => { taps++; return true; } } as never;
	const router =
		surface === "pdf"
			? new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb, () => 1, "pinch-zoom", undefined, false)
			: new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb, () => 1);
	routers.push(router);
	const peek = router as unknown as Peek;

	function fire(type: string, id: number, x: number, y: number, t: number, pointerType = "touch", down = type !== "pointerup" && type !== "pointercancel"): void {
		// The second finger of a pair lands while the first is down, so it is not the primary touch: a primary one
		// would tell the router the first finger's lift was lost.
		const ev = penEvent(type, t, {
			pointerId: id, pointerType, x, y, isPrimary: id !== SECOND,
			pressure: pointerType === "pen" && down ? 0.5 : 0,
			buttons: down ? 1 : 0,
		});
		const handler = el.handlers.get(type);
		if (!handler) throw new Error(`missing handler ${type}`);
		handler(ev);
	}

	return {
		el,
		router,
		peek,
		taps: () => taps,
		guard: () => peek.manip.current,
		fire,
		/** One finger down at (x, y), dragged up in `steps` 10 px steps; left down. */
		fingerPan(id: number, x: number, y: number, steps: number, t0 = 10): void {
			fire("pointerdown", id, x, y, t0);
			for (let i = 1; i <= steps; i++) fire("pointermove", id, x, y - i * 10, t0 + i * 16);
		},
		lift(id: number, x: number, y: number, t: number): void {
			fire("pointerup", id, x, y, t);
		},
		penDown(x: number, y: number, t: number): void {
			fire("pointerdown", PEN, x, y, t, "pen");
		},
		penUp(x: number, y: number, t: number): void {
			fire("pointerup", PEN, x, y, t, "pen");
		},
	};
}

describe("the pen landing in one pane tells the other pane's guard about the fingers it stopped", () => {
	it("a finger pan in B, the pen down in A, B's finger lifts: B's touch window stays shut", () => {
		const a = pane();
		const b = pane();
		b.fingerPan(31, 400, 300, 3);
		expect(b.peek.assistPointerId, "premise: B's finger pan is carried by the assist").toBe(31);
		expect(b.peek.gesturePanned, "premise: B's gesture panned").toBe(true);
		expect(b.guard(), "premise: B's guard is in its finger state").toBe("armed-assist");
		a.penDown(300, 300, 100);
		expect(b.peek.assistPointerId, "premise: the pen in A dropped B's assist").toBeNull();
		b.lift(31, 400, 270, 150);
		expect(b.guard(), "B's guard stays up").toBe("armed");
		expect(b.el.style.touchAction, "B's scroller keeps the guard's touch-action").toBe("none");
		expect(b.peek.rearmTimer, "no re-arm is pending in B: the window never opened").toBeNull();
	});

	it("a pinch in B that grew out of a pan, ended by the pen in A: B's touch window stays shut when both fingers lift", () => {
		const a = pane();
		const b = pane();
		b.fingerPan(31, 400, 300, 2);
		expect(b.peek.gesturePanned, "premise: the first finger panned").toBe(true);
		b.fire("pointerdown", 32, 500, 280, 60);
		expect(b.peek.assistPointerId, "premise: the second finger turned the gesture into a pinch").toBeNull();
		b.fire("pointermove", 32, 540, 280, 76);
		expect(b.peek.pinchLive, "premise: the pinch is live").toBe(true);
		a.penDown(300, 300, 100);
		expect(b.peek.pinchLive, "premise: the pen in A ended B's pinch").toBe(false);
		b.lift(31, 400, 280, 150);
		b.lift(32, 540, 280, 160);
		expect(b.guard(), "B's guard stays up").toBe("armed");
		expect(b.el.style.touchAction, "B's scroller keeps the guard's touch-action").toBe("none");
		expect(b.peek.rearmTimer, "no re-arm is pending in B: the window never opened").toBeNull();
	});

	it("a pair resting in B after a pan, not yet pinching, the pen down in A: B's touch window stays shut when both lift", () => {
		const a = pane();
		const b = pane();
		b.fingerPan(31, 400, 300, 2);
		b.fire("pointerdown", 32, 500, 280, 60);
		expect(b.peek.pinchLive, "premise: the pair is watched, not yet pinching").toBe(false);
		expect(b.peek.gesturePanned, "premise: the gesture panned before the pair formed").toBe(true);
		a.penDown(300, 300, 100);
		b.lift(31, 400, 280, 150);
		b.lift(32, 500, 280, 160);
		expect(b.guard(), "B's guard stays up").toBe("armed");
		expect(b.el.style.touchAction, "B's scroller keeps the guard's touch-action").toBe("none");
		expect(b.peek.rearmTimer, "no re-arm is pending in B: the window never opened").toBeNull();
	});

	it("a finger that panned in B by a wiggle and lifts where it landed is not taken for a tap after the pen lands in A", () => {
		const a = pane();
		const b = pane();
		b.fire("pointerdown", 31, 400, 300, 10);
		b.fire("pointermove", 31, 406, 300, 60);
		b.fire("pointermove", 31, 400, 300, 110);
		expect(b.peek.gesturePanned, "premise: the wiggle's path engaged the assist").toBe(true);
		a.penDown(300, 300, 200);
		b.lift(31, 400, 300, 300);
		expect(b.taps(), "B heard no tap").toBe(0);
	});
});

describe("what the pen in one pane leaves alone", () => {
	it("CONTROL: a lone finger pan in a note with no pen anywhere still opens its native window on the lift", () => {
		const b = pane();
		b.fingerPan(31, 400, 300, 3);
		b.lift(31, 400, 270, 150);
		expect(b.guard()).toBe("touch-linger");
		expect(b.el.style.touchAction).toBe("");
	});

	it("a pane the pen took nothing from keeps its open native window, and it re-arms on its own timer", () => {
		vi.useFakeTimers();
		const a = pane();
		const b = pane();
		const c = pane();
		c.fingerPan(41, 400, 300, 3);
		c.lift(41, 400, 270, 150);
		expect(c.guard(), "premise: C's pan opened C's window").toBe("touch-linger");
		vi.advanceTimersByTime(200);
		b.fingerPan(31, 400, 300, 3, 200);
		a.penDown(300, 300, 300);
		expect(c.guard(), "C's window is still open").toBe("touch-linger");
		expect(c.el.style.touchAction).toBe("");
		vi.advanceTimersByTime(799);
		expect(c.guard(), "C's own re-arm has not fired yet").toBe("touch-linger");
		vi.advanceTimersByTime(1);
		expect(c.guard(), "C's own re-arm fired on its own time").toBe("armed");
	});

	it("a pane with a finger already scrolling natively keeps its open window when the pen lands in another pane", () => {
		vi.useFakeTimers();
		const a = pane();
		const c = pane();
		c.fingerPan(41, 400, 300, 3);
		c.lift(41, 400, 270, 150);
		c.fire("pointerdown", 42, 400, 300, 200);
		expect(c.guard(), "premise: C's second finger went to the browser's native window").toBe("touch-open");
		a.penDown(300, 300, 300);
		expect(c.guard(), "C's guard is untouched").toBe("touch-open");
		expect(c.el.style.touchAction).toBe("");
	});

	it("a pen hovering in A drops nothing in B and leaves B's guard alone", () => {
		const a = pane();
		const b = pane();
		b.fingerPan(31, 400, 300, 3);
		a.fire("pointermove", PEN, 300, 300, 100, "pen", false);
		a.fire("pointermove", PEN, 310, 300, 116, "pen", false);
		expect(a.guard(), "premise: the hover reached A's guard").toBe("armed");
		expect(b.peek.assistPointerId, "B's assist still carries its finger").toBe(31);
		expect(b.guard(), "B's guard is still in its finger state").toBe("armed-assist");
	});

	it("the pen's own pane arms on its pen-down, with its window open and no finger anywhere", () => {
		vi.useFakeTimers();
		const a = pane();
		pane();
		a.fingerPan(31, 400, 300, 3);
		a.lift(31, 400, 270, 150);
		expect(a.guard(), "premise: A's pan opened A's window").toBe("touch-linger");
		a.penDown(300, 300, 300);
		expect(a.guard()).toBe("armed");
		expect(a.el.style.touchAction).toBe("none");
		expect(a.peek.rearmTimer, "A's pending re-arm was cancelled").toBeNull();
	});

	it("a PDF as the other pane keeps its own armed touch-action, pinch zoom included", () => {
		const a = pane();
		const b = pane("pdf");
		b.fingerPan(31, 400, 300, 3);
		expect(b.el.style.touchAction, "premise: the PDF scroller's armed value").toBe("pinch-zoom");
		a.penDown(300, 300, 100);
		expect(b.el.style.touchAction).toBe("pinch-zoom");
		b.lift(31, 400, 270, 150);
		expect(b.guard()).toBe("armed");
		expect(b.el.style.touchAction).toBe("pinch-zoom");
	});

	it("a new finger in B while A's pen is down is still refused as palm", () => {
		const a = pane();
		const b = pane();
		b.fingerPan(31, 400, 300, 3);
		a.penDown(300, 300, 100);
		b.fire("pointerdown", 32, 500, 300, 120);
		expect(b.peek.touchPos.has(32), "the new contact in B is not taken as a finger").toBe(false);
		a.penUp(300, 300, 200);
	});
});
