/**
 * Alan: "yes native obsidian". WITH INFINITE CANVAS OFF, A SECOND
 * FINGER ENDS THE ASSIST PAN AND THE GESTURE IS THE HOST'S.
 *
 * Before: the earlier fix left the second contact unrecorded but kept finger one as an
 * assist pan, so finger one went on writing scroll offsets under the host's
 * two-finger gesture and the guard stayed armed. After: the router ends its
 * pan when the second finger lands - assist pointer released, the guard told
 * the way a lift tells it, no more scroll writes from finger one and no glide -
 * and records neither contact.
 *
 * THE RIG. The real router on the shared element fake (test/routerHarness.ts),
 * with the host answering `pinchZoom` false (canvas off), driven through
 * pointer events the way the device drives it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePenRouter } from "./InlinePenRouter";
import { fakeEl, installFakeWindow, rafCallbacks, recorder } from "../../test/routerHarness";

let clock = 1000;
let undoWindow: () => void;
const routers: InlinePenRouter[] = [];

beforeAll(() => { undoWindow = installFakeWindow(); });
afterAll(() => { undoWindow(); });
beforeEach(() => {
	clock = 1000;
	rafCallbacks.clear();
	vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(() => {
	for (const r of routers.splice(0)) r.dispose();
	vi.restoreAllMocks();
});

function ptr(type: string, pointerId: number, x: number, y: number, buttons: number, isPrimary = true): PointerEvent {
	return {
		type, pointerType: "touch", pointerId, isPrimary,
		clientX: x, clientY: y, pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0,
		timeStamp: clock, tiltX: 0, tiltY: 0, width: 0, height: 0,
		preventDefault: () => {}, stopPropagation: () => {},
	} as unknown as PointerEvent;
}

function rig(canvasOn: boolean) {
	const el = fakeEl() as ReturnType<typeof fakeEl> & Record<string, unknown>;
	let left = 5000;
	let top = 5000;
	const writes: string[] = [];
	Object.defineProperty(el, "scrollLeft", { configurable: true, get: () => left, set: (v: number) => { writes.push(`L${v}`); left = v; } });
	Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => { writes.push(`T${v}`); top = v; } });
	Object.assign(el, { clientWidth: 900, clientHeight: 700, scrollWidth: 1e6, scrollHeight: 1e6 });
	const cb = { ...recorder().cb, pinchZoom: () => canvasOn };
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb, () => 1);
	routers.push(router);
	const fire = (ev: PointerEvent) => {
		const h = el.handlers.get(ev.type);
		if (!h) throw new Error(`router registered no handler for ${ev.type}`);
		h(ev);
	};
	const r = router as unknown as {
		assistPointerId: number | null; guardApplied: boolean;
		touchPos: Map<number, unknown>; guardTouches: Set<number>;
	};
	return { el, fire, writes, r };
}

/** Finger one down and panning (assist engaged), then finger two lands. */
function panThenSecondFinger(canvasOn: boolean) {
	const s = rig(canvasOn);
	let x = 600;
	s.fire(ptr("pointerdown", 5, x, 300, 1));
	for (let i = 0; i < 4; i++) { x -= 10; clock += 16; s.fire(ptr("pointermove", 5, x, 300, 1)); }
	const panWrites = s.writes.length;
	const assisting = s.r.assistPointerId === 5;
	const guardedWhilePanning = s.r.guardApplied;
	clock += 16;
	s.fire(ptr("pointerdown", 6, 300, 300, 1, false));
	return { ...s, x, panWrites, assisting, guardedWhilePanning };
}

describe("canvas off: a second finger ends the assist pan", () => {
	it("finger one writes no scroll after finger two lands, and no glide follows its lift", () => {
		const s = panThenSecondFinger(false);
		expect(s.assisting, "premise: finger one was assist-panning").toBe(true);
		expect(s.panWrites, "premise: the pan wrote scroll offsets").toBeGreaterThan(0);
		const before = s.writes.length;
		let x = s.x;
		for (let i = 0; i < 4; i++) { x -= 10; clock += 16; s.fire(ptr("pointermove", 5, x, 300, 1)); }
		clock += 16;
		s.fire(ptr("pointerup", 5, x, 300, 0));
		for (let f = 0; f < 200 && rafCallbacks.size > 0; f++) {
			const [id, cb] = rafCallbacks.entries().next().value as [number, FrameRequestCallback];
			rafCallbacks.delete(id);
			clock += 16;
			cb(clock);
		}
		expect(s.writes.slice(before), "finger one kept scrolling under the host's gesture").toEqual([]);
	});

	it("the guard's touch-action is released and neither contact is recorded", () => {
		const s = panThenSecondFinger(false);
		expect(s.guardedWhilePanning, "premise: the guard was armed during the pan").toBe(true);
		expect(s.r.guardApplied, "the guard still holds the scroller after the second finger").toBe(false);
		expect(s.r.assistPointerId, "the assist pointer was not released").toBe(null);
		expect([s.r.touchPos.size, s.r.guardTouches.size], "a contact is still recorded").toEqual([0, 0]);
	});

	it("CANVAS ON: the same two fingers stay a plugin pinch, finger one still recorded", () => {
		const s = panThenSecondFinger(true);
		expect(s.r.touchPos.size).toBe(2);
		expect(s.r.guardApplied).toBe(true);
	});
});
