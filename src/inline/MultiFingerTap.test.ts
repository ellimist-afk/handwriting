/**
 * Two fingers undo, three redo - and nothing else ever does.
 *
 * The first half drives the detector alone, as arithmetic. The second drives
 * the real InlinePenRouter on the shared router harness, so what is pinned is
 * that the router feeds every finger through, answers on the last lift, and
 * lets a palm beside the pen, a pen contact, a scroll or a pinch spoil it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MULTI_TAP_MAX_MS, MULTI_TAP_SLOP_PX, MultiFingerTap } from "./MultiFingerTap";
import { InlinePenRouter, type InlinePenCallbacks } from "./InlinePenRouter";
import { fakeEl, installFakeWindow, rafCallbacks } from "../../test/routerHarness";

describe("MultiFingerTap, alone", () => {
	function tap(fingers: number, opts: { heldMs?: number; travelPx?: number } = {}) {
		const t = new MultiFingerTap();
		for (let id = 1; id <= fingers; id++) t.down(id, 100 * id, 300, id * 10);
		if (opts.travelPx) t.move(1, 100 + opts.travelPx, 300);
		const liftAt = 10 + (opts.heldMs ?? 120);
		let answer: ReturnType<MultiFingerTap["up"]> = null;
		for (let id = 1; id <= fingers; id++) answer = t.up(id, liftAt + id) ?? answer;
		return answer;
	}

	it("answers 2 for two fingers and 3 for three, on the last lift only", () => {
		expect(tap(2)).toBe(2);
		expect(tap(3)).toBe(3);
		const t = new MultiFingerTap();
		t.down(1, 0, 0, 0);
		t.down(2, 50, 0, 5);
		expect(t.up(1, 80), "the first lift answered before the gesture ended").toBeNull();
		expect(t.up(2, 90)).toBe(2);
	});

	it("ignores one finger and four", () => {
		expect(tap(1)).toBeNull();
		expect(tap(4)).toBeNull();
	});

	it("a finger that travels past the slop is navigation", () => {
		expect(tap(2, { travelPx: MULTI_TAP_SLOP_PX - 1 })).toBe(2);
		expect(tap(2, { travelPx: MULTI_TAP_SLOP_PX + 1 })).toBeNull();
	});

	it("a gesture held past the window is a resting hand", () => {
		expect(tap(2, { heldMs: MULTI_TAP_MAX_MS - 40 })).toBe(2);
		expect(tap(2, { heldMs: MULTI_TAP_MAX_MS + 10 })).toBeNull();
	});

	it("a cancelled finger or an outside spoil rules the gesture out until every finger lifts", () => {
		const t = new MultiFingerTap();
		t.down(1, 0, 0, 0);
		t.down(2, 50, 0, 5);
		t.cancel(1);
		expect(t.up(2, 60)).toBeNull();
		t.down(3, 0, 0, 100);
		t.down(4, 50, 0, 105);
		t.spoil();
		t.up(3, 150);
		// A finger landing while the spoiled gesture is still down joins it, spoiled.
		t.down(5, 0, 0, 155);
		expect(t.up(4, 160)).toBeNull();
		expect(t.up(5, 170)).toBeNull();
		// The next clean gesture starts fresh.
		t.down(6, 0, 0, 300);
		t.down(7, 50, 0, 305);
		t.up(6, 380);
		expect(t.up(7, 390)).toBe(2);
	});
});

describe("MultiFingerTap, through the router", () => {
	let clock = 1000;
	let undoWindow: () => void;
	const routers: InlinePenRouter[] = [];

	beforeAll(() => {
		undoWindow = installFakeWindow();
	});
	afterAll(() => undoWindow());
	beforeEach(() => {
		clock = 1000;
		rafCallbacks.clear();
		vi.spyOn(performance, "now").mockImplementation(() => clock);
	});
	afterEach(() => {
		for (const r of routers.splice(0)) r.dispose();
		vi.restoreAllMocks();
	});

	function ptr(type: string, pointerType: string, pointerId: number, x: number, y: number, buttons: number): PointerEvent {
		return {
			type, pointerType, pointerId, isPrimary: pointerId === 1, clientX: x, clientY: y,
			pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0, timeStamp: clock,
			tiltX: 0, tiltY: 0, width: 0, height: 0,
			preventDefault: () => {}, stopPropagation: () => {},
			getCoalescedEvents: () => [],
		} as unknown as PointerEvent;
	}

	function rig(canvasOn: boolean) {
		const el = fakeEl() as ReturnType<typeof fakeEl> & Record<string, unknown>;
		let top = 0;
		Object.defineProperty(el, "scrollLeft", { configurable: true, get: () => 0, set: () => {} });
		Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => void (top = Math.max(0, v)) });
		Object.assign(el, { clientWidth: 900, clientHeight: 700, scrollWidth: 900, scrollHeight: 100_000 });
		const taps: number[] = [];
		const cb: InlinePenCallbacks = {
			onPenDown: () => {}, onPenHover: () => {}, onPenLeave: () => {}, onPinch: () => {},
			onPenRaw: () => {}, onPenMove: () => {}, onPenUp: () => {},
			pinchZoom: () => canvasOn,
			onMultiFingerTap: (n) => void taps.push(n),
		};
		const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb, () => 1);
		routers.push(router);
		const fire = (ev: PointerEvent) => {
			const h = el.handlers.get(ev.type);
			if (!h) throw new Error(`no handler for ${ev.type}`);
			h(ev);
		};
		el.scrollTop = 5000;
		const fingers = (n: number, opts: { travel?: number; cancel?: boolean } = {}) => {
			for (let id = 1; id <= n; id++) { r.fire(ptr("pointerdown", "touch", id, 200 + 100 * id, 400, 1)); clock += 10; }
			if (opts.travel) for (let step = 1; step <= 4; step++) {
				clock += 16;
				for (let id = 1; id <= n; id++) r.fire(ptr("pointermove", "touch", id, 200 + 100 * id, 400 - (opts.travel / 4) * step, 1));
			}
			clock += 80;
			for (let id = 1; id <= n; id++) {
				r.fire(ptr(opts.cancel && id === 1 ? "pointercancel" : "pointerup", "touch", id, 200 + 100 * id, 400 - (opts.travel ?? 0), 0));
				clock += 5;
			}
		};
		const r = { fire, taps, fingers };
		return r;
	}

	for (const canvasOn of [false, true]) {
		describe(canvasOn ? "Infinite Canvas on (the plugin's pinch)" : "Infinite Canvas off (the host's pinch)", () => {
			it("a two-finger tap undoes and a three-finger tap redoes", () => {
				const r = rig(canvasOn);
				r.fingers(2);
				clock += 400;
				r.fingers(3);
				expect(r.taps).toEqual([2, 3]);
			});

			it("a one-finger tap does neither", () => {
				const r = rig(canvasOn);
				r.fingers(1);
				expect(r.taps).toEqual([]);
			});

			it("a two-finger scroll or pinch does neither", () => {
				const r = rig(canvasOn);
				r.fingers(2, { travel: 80 });
				expect(r.taps).toEqual([]);
			});

			it("a gesture the browser cancelled does neither", () => {
				const r = rig(canvasOn);
				r.fingers(2, { cancel: true });
				expect(r.taps).toEqual([]);
			});

			it("two fingers held down a while do neither", () => {
				const r = rig(canvasOn);
				r.fire(ptr("pointerdown", "touch", 1, 300, 400, 1));
				r.fire(ptr("pointerdown", "touch", 2, 400, 400, 1));
				clock += MULTI_TAP_MAX_MS + 50;
				r.fire(ptr("pointerup", "touch", 1, 300, 400, 0));
				r.fire(ptr("pointerup", "touch", 2, 400, 400, 0));
				expect(r.taps).toEqual([]);
			});
		});
	}

	it("fingers that land while the pen is writing are a palm, never a tap", () => {
		const r = rig(false);
		r.fire(ptr("pointerdown", "pen", 9, 100, 100, 1));
		clock += 10;
		r.fire(ptr("pointerdown", "touch", 1, 300, 400, 1));
		r.fire(ptr("pointerdown", "touch", 2, 400, 400, 1));
		clock += 60;
		r.fire(ptr("pointerup", "touch", 1, 300, 400, 0));
		r.fire(ptr("pointerup", "touch", 2, 400, 400, 0));
		r.fire(ptr("pointerup", "pen", 9, 120, 100, 0));
		expect(r.taps).toEqual([]);
	});

	it("a pen contact during the tap spoils it", () => {
		const r = rig(false);
		clock += 5000; // well clear of any earlier pen
		r.fire(ptr("pointerdown", "touch", 1, 300, 400, 1));
		r.fire(ptr("pointerdown", "touch", 2, 400, 400, 1));
		clock += 20;
		r.fire(ptr("pointerdown", "pen", 9, 100, 100, 1));
		r.fire(ptr("pointerup", "pen", 9, 100, 100, 0));
		clock += 20;
		r.fire(ptr("pointerup", "touch", 1, 300, 400, 0));
		r.fire(ptr("pointerup", "touch", 2, 400, 400, 0));
		expect(r.taps).toEqual([]);
	});
});
