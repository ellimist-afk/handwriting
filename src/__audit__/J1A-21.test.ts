import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePenRouter, type InlinePenCallbacks } from "../inline/InlinePenRouter";
import { fakeEl, installFakeWindow, rafCallbacks } from "../../test/routerHarness";

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

let prevented = 0;
function ptr(type: string, pointerId: number, x: number, y: number, buttons: number, isPrimary = true): PointerEvent {
	return {
		type, pointerType: "touch", pointerId, isPrimary, clientX: x, clientY: y,
		pressure: buttons === 0 ? 0 : 0.5, buttons, button: 0, timeStamp: clock,
		tiltX: 0, tiltY: 0, width: 0, height: 0,
		preventDefault: () => void prevented++, stopPropagation: () => {},
	} as unknown as PointerEvent;
}

function rig(canvasOn: boolean) {
	const el = fakeEl() as ReturnType<typeof fakeEl> & Record<string, unknown>;
	let top = 0;
	Object.defineProperty(el, "scrollLeft", { configurable: true, get: () => 0, set: () => {} });
	Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (v: number) => void (top = Math.max(0, v)) });
	Object.assign(el, { clientWidth: 900, clientHeight: 700, scrollWidth: 900, scrollHeight: 100_000 });
	const cb: InlinePenCallbacks = {
		onPenDown: () => {}, onPenHover: () => {}, onPenLeave: () => {}, onPinch: () => {},
		onPenRaw: () => {}, onPenMove: () => {}, onPenUp: () => {},
		pinchZoom: () => canvasOn,
	};
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb, () => 1);
	routers.push(router);
	const fire = (ev: PointerEvent) => {
		const h = el.handlers.get(ev.type);
		if (!h) throw new Error(`no handler for ${ev.type}`);
		h(ev);
	};
	el.scrollTop = 5000;
	return { el, fire, top: () => (el.scrollTop as number) };
}

function runFrames() {
	let frames = 0;
	while (rafCallbacks.size > 0 && frames < 500) {
		const [id, cb] = rafCallbacks.entries().next().value as [number, FrameRequestCallback];
		rafCallbacks.delete(id);
		clock += 16;
		cb(clock);
		frames++;
	}
	return frames;
}

describe("J1A-21 canvas off: second finger hands the gesture to the host", () => {
	it("finger one already assist-panning: second finger ends the pan, no further scroll, no fling", () => {
		const r = rig(false);
		r.fire(ptr("pointerdown", 1, 300, 400, 1));
		for (let i = 1; i <= 4; i++) { clock += 16; r.fire(ptr("pointermove", 1, 300, 400 - 10 * i, 1)); }
		expect(r.top(), "precondition: finger one assist-panned").toBeGreaterThan(5000);
		clock += 8;
		r.fire(ptr("pointerdown", 2, 500, 400, 1, false));
		const atSecond = r.top();
		for (let i = 1; i <= 4; i++) {
			clock += 16;
			r.fire(ptr("pointermove", 1, 300, 360 - 20 * i, 1));
			r.fire(ptr("pointermove", 2, 500, 400 - 20 * i, 1, false));
		}
		expect(r.top(), "finger one kept assist-panning after finger two landed").toBe(atSecond);
		clock += 16;
		r.fire(ptr("pointerup", 1, 300, 280, 0));
		r.fire(ptr("pointerup", 2, 500, 320, 0, false));
		runFrames();
		expect(r.top(), "finger one flung the note on lift").toBe(atSecond);
	});

	it("two fingers landing together (a pinch/two-finger drag, finger one not yet past slop): router does not scroll", () => {
		const r = rig(false);
		r.fire(ptr("pointerdown", 1, 300, 400, 1));
		clock += 8;
		r.fire(ptr("pointerdown", 2, 500, 400, 1, false));
		prevented = 0;
		for (let i = 1; i <= 6; i++) {
			clock += 16;
			r.fire(ptr("pointermove", 1, 300, 400 - 20 * i, 1));
			r.fire(ptr("pointermove", 2, 500, 400 - 20 * i, 1, false));
		}
		const duringGesture = r.top() - 5000;
		const preventedMoves = prevented;
		clock += 16;
		r.fire(ptr("pointerup", 1, 300, 280, 0));
		r.fire(ptr("pointerup", 2, 500, 280, 0, false));
		runFrames();
		const total = r.top() - 5000;
		expect({ duringGesture, total, preventedMoves }, "the plugin assist-panned/flung a two-finger gesture the host owns").toEqual({ duringGesture: 0, total: 0, preventedMoves: 0 });
	});

	it("control: canvas ON, the same two fingers are the plugin's pinch, not a one-finger pan", () => {
		const r = rig(true);
		r.fire(ptr("pointerdown", 1, 300, 400, 1));
		clock += 8;
		r.fire(ptr("pointerdown", 2, 500, 400, 1, false));
		expect(r.top()).toBe(5000);
	});
});
