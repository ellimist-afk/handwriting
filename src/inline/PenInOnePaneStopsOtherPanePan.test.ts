/**
 * ONE HAND WRITES ACROSS A SPLIT: THE PEN LANDING IN ONE PANE STOPS THE HAND'S PAN IN THE OTHER.
 *
 * THE BUG. Two notes side by side. The hand lands in pane B before the pen is near
 * pane A (a pen with no hover, or a hand planted well before the hover), so B judges it a scroll finger and its assist
 * carries the pan. Then the pen writes in A while the hand slides in B. At the pen-down A dropped only ITS OWN assist
 * and pinch; the loop over every router ended stranded strokes and voided parole, nothing else. So B kept scrolling
 * (or, two fingers, zooming) under the writing hand, and flung at the lift.
 *
 * THE FIX. The pen-down's assist and pinch drop runs for every live router, in the loop that already treats the palm
 * in the other pane as the same hand. B's give past an end is released with its assist (its own lift can no longer
 * match the dropped pointer), and B's pinch stays down while any pane holds a pen (`updatePinch` asks `anyPenDown`).
 *
 * TWO RIGS, scroller-level paths only: `installFakeWindow`'s window handlers are one map per event type, so a second
 * router's window listeners overwrite the first's, and nothing here fires on the window.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePenRouter } from "./InlinePenRouter";
import { resetPenToolsForTest } from "./PenToolsMode";
import { fakeEl, installFakeWindow, rafCallbacks, recorder } from "../../test/routerHarness";

const ALLOWANCE = 96;
const PEN = 50;

let clock = 1000;
let undoWindow: () => void;
const routers: InlinePenRouter[] = [];

beforeAll(() => {
	undoWindow = installFakeWindow();
});

afterAll(() => {
	undoWindow();
});

beforeEach(() => {
	clock = 1000;
	rafCallbacks.clear();
	vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(() => {
	for (const r of routers.splice(0)) r.dispose();
	vi.restoreAllMocks();
});

type Pinch = { phase: string; ratio: number };

function event(type: string, pointerType: string, id: number, x: number, y: number, buttons: number, primary = true): PointerEvent {
	return {
		type, pointerType, pointerId: id, isPrimary: primary,
		clientX: x, clientY: y, offsetX: 0, offsetY: 0,
		pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0,
		timeStamp: clock, tiltX: 0, tiltY: 0, width: 0, height: 0,
		preventDefault: () => {}, stopPropagation: () => {},
	} as unknown as PointerEvent;
}

/** One pane: its own scroller, its own REAL router. `startTop` 0 is the top end; 3000 px of page below. */
function pane(startTop = 1000) {
	resetPenToolsForTest();
	const el = Object.assign(fakeEl(), { scrollWidth: 800, clientWidth: 800, scrollHeight: 3600, clientHeight: 600 });
	el.scrollTop = startTop;
	const pinches: Pinch[] = [];
	const pulls: { x: number; y: number }[] = [];
	/** The give's own story, in order: "pull" for each pull reported, "release" for each hand-back. */
	const give: string[] = [];
	let releases = 0;
	const router = new InlinePenRouter(
		el as unknown as HTMLElement,
		el as unknown as HTMLElement,
		{
			...recorder().cb,
			fingerInk: () => false,
			penOff: () => false,
			onPinch: (phase: string, ratio: number) => void pinches.push({ phase, ratio }),
			overscrollAllowancePx: () => ALLOWANCE,
			onOverscrollPull: (x: number, y: number) => {
				pulls.push({ x, y });
				give.push("pull");
			},
			onOverscrollRelease: () => {
				releases++;
				give.push("release");
			},
		} as never,
		() => 1,
	);
	routers.push(router);
	const fire = (ev: PointerEvent): void => {
		const h = el.handlers.get(ev.type);
		if (!h) throw new Error(`no handler ${ev.type}`);
		h(ev);
	};
	const touch = (type: string, id: number, x: number, y: number, primary = true): void => {
		clock += 16;
		fire(event(type, "touch", id, x, y, type === "pointerup" ? 0 : 1, primary));
	};
	const pen = (type: string, x = 400, y = 300): void => {
		clock += 16;
		fire(event(type, "pen", PEN, x, y, type === "pointerup" ? 0 : 1));
	};
	const flingRaf = (): number => (router as unknown as { flingRaf: number }).flingRaf;
	const standingPull = (): { x: number; y: number } => {
		const r = router as unknown as { overscrollPullX: number; overscrollPullY: number };
		return { x: r.overscrollPullX, y: r.overscrollPullY };
	};
	return { el, router, touch, pen, pinches, pulls, give, releases: () => releases, flingRaf, standingPull };
}

type Pane = ReturnType<typeof pane>;

/** One finger down at y, then `steps` moves of `stepPx`. Returns the finger's y. */
function slide(p: Pane, id: number, y: number, steps: number, stepPx: number, down = true): number {
	if (down) p.touch("pointerdown", id, 400, y);
	for (let i = 0; i < steps; i++) {
		y += stepPx;
		p.touch("pointermove", id, 400, y);
	}
	return y;
}

/** Two fingers down, then `steps` moves spreading them `stepPx` each side. Returns the half spread. */
function spread(p: Pane, half: number, steps: number, stepPx: number, down = true): number {
	if (down) {
		p.touch("pointerdown", 1, 400 - half, 300);
		p.touch("pointerdown", 2, 400 + half, 300, false);
	}
	for (let i = 0; i < steps; i++) {
		half += stepPx;
		p.touch("pointermove", 1, 400 - half, 300);
		p.touch("pointermove", 2, 400 + half, 300, false);
	}
	return half;
}

/**
 * Past every palm window a pen leaves behind (250 ms after a lift, 300 ms after a hover), so a finger landing next is
 * judged a finger, as when the writer reaches for a scroll a moment after writing.
 */
function waitOutPalmWindows(): void {
	clock += 1000;
}

/** Run any rAF chain to its end, 16 ms a frame. */
function runFrames(limit = 2000): number {
	let frames = 0;
	while (rafCallbacks.size > 0 && frames < limit) {
		const [id, cb] = rafCallbacks.entries().next().value as [number, FrameRequestCallback];
		rafCallbacks.delete(id);
		clock += 16;
		cb(clock);
		frames++;
	}
	return frames;
}

describe("the pen in one pane stops the hand's pan in the other (274)", () => {
	it("C1: B's finger pan stops when the pen lands in A", () => {
		const a = pane();
		const b = pane();
		const y = slide(b, 1, 300, 5, -20);
		expect(b.el.scrollTop, "premise: B's finger is panning B").toBeGreaterThan(1000);
		const atPen = b.el.scrollTop;
		a.pen("pointerdown");
		slide(b, 1, y, 4, -20, false);
		expect(b.el.scrollTop, "B does not scroll under the writing hand").toBe(atPen);
	});

	it("C2: B does not fling at the finger's lift while the pen writes in A", () => {
		const a = pane();
		const b = pane();
		let y = slide(b, 1, 300, 5, -20);
		a.pen("pointerdown");
		y = slide(b, 1, y, 4, -20, false);
		const atLift = b.el.scrollTop;
		b.touch("pointerup", 1, 400, y);
		expect(b.flingRaf(), "no glide starts at B's lift").toBe(0);
		runFrames();
		expect(b.el.scrollTop, "and B is where the pen found it").toBe(atLift);
	});

	it("C3: B's pinch ends when the pen lands in A, and does not start again while it writes", () => {
		const a = pane();
		const b = pane();
		const half = spread(b, 100, 5, 15);
		expect(b.pinches.some((p) => p.phase === "start"), "premise: B is pinching").toBe(true);
		const before = b.pinches.length;
		a.pen("pointerdown");
		const atPen = b.pinches.slice(before);
		expect(atPen, "the pen-down ends B's pinch once, at ratio 1 (the end lands where the scale is)").toEqual([{ phase: "end", ratio: 1 }]);
		const afterEnd = b.pinches.length;
		spread(b, half, 6, 15, false);
		expect(b.pinches.slice(afterEnd), "B's drifting pair starts no new pinch while the pen is down in A").toEqual([]);
	});

	it("C3b: after A's pen lifts, a pinch in B engages and zooms as before", () => {
		const a = pane();
		const b = pane();
		a.pen("pointerdown");
		a.pen("pointerup");
		waitOutPalmWindows();
		spread(b, 100, 6, 15);
		expect(b.pinches.some((p) => p.phase === "start"), "B's pinch engages").toBe(true);
		expect(b.pinches.at(-1)!.phase).toBe("move");
		expect(b.pinches.at(-1)!.ratio, "and zooms").toBeGreaterThan(1);
	});

	it("C4: the pen's own pane: its pan stops and its pinch ends, as before", () => {
		const a = pane();
		const y = slide(a, 1, 300, 5, -20);
		expect(a.el.scrollTop).toBeGreaterThan(1000);
		const atPen = a.el.scrollTop;
		a.pen("pointerdown");
		slide(a, 1, y, 4, -20, false);
		expect(a.el.scrollTop, "A's own pan stopped at its pen").toBe(atPen);
		a.pen("pointerup");
		a.touch("pointerup", 1, 400, y);
		waitOutPalmWindows();

		const c = pane();
		spread(c, 100, 5, 15);
		expect(c.pinches.some((p) => p.phase === "start"), "premise: the pane is pinching").toBe(true);
		const before = c.pinches.length;
		c.pen("pointerdown");
		expect(c.pinches.slice(before), "A's own pinch ends once at its pen").toEqual([{ phase: "end", ratio: 1 }]);
	});

	it("C5: CONTROL, no pen anywhere: B's finger pans and flings", () => {
		pane();
		const b = pane();
		const y = slide(b, 1, 300, 8, -20);
		expect(b.el.scrollTop).toBeGreaterThan(1000);
		b.touch("pointerup", 1, 400, y);
		expect(b.flingRaf(), "a released pan glides").not.toBe(0);
	});

	/**
	 * Base hands the give back at B's lift, and the glide that follows into the top makes a second give and hands that
	 * back too, so the count differs between base and fix; what may not differ is the end state: no give left standing.
	 */
	it("C6: B's give past its end is not left standing when the pen lands in A", () => {
		const a = pane();
		const b = pane(0);
		let y = slide(b, 1, 200, 5, 20);
		expect(b.pulls.length, "premise: B's drag at the top made a give").toBeGreaterThan(0);
		expect(b.releases(), "premise: not released yet").toBe(0);
		a.pen("pointerdown");
		y = slide(b, 1, y, 3, 20, false);
		b.touch("pointerup", 1, 400, y);
		runFrames();
		expect(b.releases(), "B's give was handed back").toBeGreaterThan(0);
		expect(b.give.at(-1), "the last word on B's give is a hand-back").toBe("release");
		expect(b.standingPull(), "and B holds no pull").toEqual({ x: 0, y: 0 });
	});
});
