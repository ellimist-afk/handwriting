/**
 * A FLICK THAT RUNS OUT OF PAGE COMES BACK.
 *
 * THE SYMPTOM, on the device: flick the note toward an end and it stops about an inch
 * past the end and stays there, with the paper still riding its preview element, until a
 * finger touches the glass again. No spring back at all. Measured in review on the
 * tip that first carried the give: 57.80 painted px still held when the glide stopped,
 * and zero releases.
 *
 * THE MECHANISM. Line 7's give is the remainder `carryScrollBy` could not spend, accrued
 * into `overscrollPullX`/`overscrollPullY` and reported to the host, which paints it. The
 * fling tick calls `carryScrollBy` on every frame of its chain, so a glide is just as
 * able to make a give as a finger is - and `endAssist` hands the FINGER'S give back
 * before it starts the fling, so the glide's give is a second one, made after the only
 * release site the gesture had. The chain then ends on its own physics or against the
 * end, and returns. Nothing releases. The page is left held out.
 *
 * THE FIX, and what this cell fails on if it is removed: the tick releases at its own
 * end, and `cancelFling` releases when a glide is cut short with a give standing.
 *
 * WHAT MUST MOVE AND WHAT MUST NOT. Moving: a fling into an end now ends with the give
 * handed back. Not moving: a fling that stays inside the range reports no give and no
 * release, and the drag's own give is still released once at the lift, not twice.
 *
 * Not a render cell: this reads the router against the fake window, so the whole glide
 * runs on a driven clock instead of real frames.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePenRouter } from "./InlinePenRouter";
import { resetPenToolsForTest } from "./PenToolsMode";
import { fakeEl, installFakeWindow, rafCallbacks, recorder } from "../../test/routerHarness";

/** The allowance the host offers, painted px. */
const ALLOWANCE = 96;

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

function touch(type: string, y: number, buttons: number): PointerEvent {
	return {
		type, pointerType: "touch", pointerId: 7, isPrimary: true,
		clientX: 400, clientY: y, pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0,
		timeStamp: clock, tiltX: 0, tiltY: 0, width: 0, height: 0,
		preventDefault: () => {}, stopPropagation: () => {},
	} as unknown as PointerEvent;
}

/** `room` is the scroller's vertical range: 3000 leaves plenty of page above the start. */
function rig(startTop: number, room = 3000) {
	resetPenToolsForTest();
	const el = Object.assign(fakeEl(), { scrollWidth: 800, clientWidth: 800, scrollHeight: 600 + room, clientHeight: 600 });
	el.scrollTop = startTop;
	const pulls: { x: number; y: number }[] = [];
	let releases = 0;
	const router = new InlinePenRouter(
		el as unknown as HTMLElement,
		el as unknown as HTMLElement,
		{
			...recorder().cb,
			fingerInk: () => false,
			penOff: () => false,
			overscrollAllowancePx: () => ALLOWANCE,
			onOverscrollPull: (x: number, y: number) => pulls.push({ x, y }),
			onOverscrollRelease: () => void releases++,
		} as never,
		() => 1,
	);
	routers.push(router);
	const fire = (ev: PointerEvent): void => {
		const h = el.handlers.get(ev.type);
		if (!h) throw new Error(`no handler ${ev.type}`);
		h(ev);
	};
	return { el, router, fire, pulls, releases: () => releases };
}

/**
 * One finger down, past the assist's slop, then `steps` fast moves DOWN, then a lift.
 * Content follows the hand, so `scrollTop` runs toward 0 and the glide carries on that
 * way after the lift. Returns what was true at the lift, before any glide frame.
 */
function flickDown(h: ReturnType<typeof rig>, steps: number, stepPx: number) {
	let y = 200;
	h.fire(touch("pointerdown", y, 1));
	y += 10; clock += 16; h.fire(touch("pointermove", y, 1));
	for (let i = 0; i < steps; i++) { y += stepPx; clock += 16; h.fire(touch("pointermove", y, 1)); }
	const atLift = { pulls: h.pulls.length, releases: h.releases(), scrollTop: h.el.scrollTop as number };
	clock += 16;
	h.fire(touch("pointerup", y, 0));
	return atLift;
}

/** Run the rAF chain to its own end, 16 ms a frame. Returns how many frames it ran. */
function runGlide(limit = 2000): number {
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

describe("the give a flick makes on its own", () => {
	it("a flick into the top ends with the give handed back, not left standing", () => {
		const h = rig(400);
		const atLift = flickDown(h, 6, 40);
		// PREMISE 1: the drag stayed inside the range, so nothing below is the drag's give
		// under another name. This is what makes the release count discriminating.
		expect(atLift.pulls, `premise: the drag itself made no give (scrollTop at lift ${atLift.scrollTop})`).toBe(0);
		expect(atLift.releases, "premise: and released nothing at the lift").toBe(0);
		const frames = runGlide();
		// PREMISE 2: the glide ran, reached the end, and made a give there. Without this row
		// the claim below is satisfied by a flick that never reached an end at all.
		expect(frames, "premise: the glide ran frames").toBeGreaterThan(0);
		expect(h.el.scrollTop, "premise: the glide reached the top").toBe(0);
		expect(h.pulls.length, `premise: and made a give against it (pulls ${h.pulls.length}, last ${JSON.stringify(h.pulls.at(-1))})`).toBeGreaterThan(0);
		// THE CLAIM. Without the release at the tick's end this is 0: the page stays held
		// out by the last pull's distance until something else touches the glass.
		expect(h.releases(), "the glide's give was handed back when the glide ended").toBeGreaterThan(0);
	});

	it("a glide cut short by a new contact hands its give back too, not on the next gesture", () => {
		const h = rig(400);
		flickDown(h, 6, 40);
		// Part way through the glide - far enough in to be past the end and holding a give.
		let frames = 0;
		while (rafCallbacks.size > 0 && frames < 2000) {
			const [id, cb] = rafCallbacks.entries().next().value as [number, FrameRequestCallback];
			rafCallbacks.delete(id);
			clock += 16;
			cb(clock);
			frames++;
			if (h.pulls.length > 0) break;
		}
		expect(h.pulls.length, "premise: the glide made a give before the new contact").toBeGreaterThan(0);
		const before = h.releases();
		clock += 16;
		h.fire(touch("pointerdown", 300, 1));
		expect(h.releases(), "the new contact ended the glide and handed its give back").toBeGreaterThan(before);
	});

	it("CONTROL: a flick that never runs out of page makes no give and releases nothing", () => {
		// Starting low with room above: the glide is spent long before the top.
		const h = rig(2600);
		const atLift = flickDown(h, 3, 12);
		const frames = runGlide();
		expect(frames, "premise: the glide ran").toBeGreaterThan(0);
		expect(h.el.scrollTop, "premise: and stopped short of the top").toBeGreaterThan(0);
		expect(h.pulls, "nothing was refused, so nothing was given").toEqual([]);
		expect(h.releases(), "and nothing was handed back, because nothing was held").toBe(0);
	});
});
