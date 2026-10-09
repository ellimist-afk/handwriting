/**
 * J1C-69: after a pinch is interrupted with two fingers still down, the
 * re-engaged pinch must report ratios relative to where it re-engaged.
 * Fingers start 100 apart, spread to 200 (ratio 2), interruption, spread to 300:
 * correct re-engaged ratio is 1.5. Real code: InlinePenRouter on the element fake.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePenRouter } from "../inline/InlinePenRouter";
import { resetPenToolsForTest } from "../inline/PenToolsMode";
import { fakeEl, installFakeWindow, penEvent, recorder, winHandlers } from "../../test/routerHarness";

interface Pinch { phase: string; ratio: number }

let clock = 1000;
let undo: () => void;
const routers: InlinePenRouter[] = [];
beforeAll(() => { undo = installFakeWindow(); });
afterAll(() => undo());
beforeEach(() => { clock = 1000; vi.spyOn(performance, "now").mockImplementation(() => clock); });
afterEach(() => { for (const r of routers.splice(0)) r.dispose(); vi.restoreAllMocks(); });

function rig() {
	resetPenToolsForTest();
	const el = fakeEl();
	Object.assign(el, { scrollWidth: 2000, clientWidth: 800, scrollHeight: 2000, clientHeight: 600 });
	const pinches: Pinch[] = [];
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, {
		...recorder().cb,
		fingerInk: () => false,
		penOff: () => false,
		onPinch: (phase: string, ratio: number) => pinches.push({ phase, ratio }),
	} as never, () => 1);
	routers.push(router);
	const touch = (type: string, id: number, x: number, y: number) => {
		clock += 16;
		el.handlers.get(type)!(penEvent(type, clock, {
			pointerId: id, pointerType: "touch", x, y, isPrimary: id === 1, pressure: 0,
			buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
		}));
	};
	const pen = (type: string, x: number, y: number) => {
		clock += 16;
		el.handlers.get(type)!(penEvent(type, clock, { pointerId: 9, pointerType: "pen", x, y, pressure: 0.5, buttons: type === "pointerup" ? 0 : 1 }));
	};
	const native = (type: string, id: number, live: number[]) => winHandlers.get(type)!({
		type, target: el,
		changedTouches: [{ identifier: id, touchType: "direct", radiusX: 4, radiusY: 4 }],
		touches: live.map(identifier => ({ identifier, touchType: "direct" })),
		preventDefault() {}, stopPropagation() {},
	} as unknown as Event);
	const firstPinchTo2x = () => {
		touch("pointerdown", 1, 100, 100); native("touchstart", 501, [501]);
		touch("pointerdown", 2, 200, 100); native("touchstart", 502, [501, 502]);
		touch("pointermove", 2, 300, 100);
		expect(pinches.at(-1)).toEqual({ phase: "move", ratio: 2 });
	};
	return { touch, pen, native, pinches, firstPinchTo2x };
}

describe("J1C-69 a re-engaged pinch measures from where it re-engaged", () => {
	it("after a stray third contact lands and lifts", () => {
		const h = rig();
		h.firstPinchTo2x();
		h.touch("pointerdown", 3, 700, 500); h.native("touchstart", 503, [501, 502, 503]);
		h.touch("pointerup", 3, 700, 500); h.native("touchend", 503, [501, 502]);
		expect(h.pinches.at(-1)!.phase).toBe("end");
		const mark = h.pinches.length;
		h.touch("pointermove", 2, 400, 100);
		const moves = h.pinches.slice(mark).filter(p => p.phase === "move");
		expect(moves.length).toBeGreaterThan(0);
		expect(moves.at(-1)!.ratio).toBeCloseTo(1.5, 6);
	});

	it("after a pen tap during the pinch", () => {
		const h = rig();
		h.firstPinchTo2x();
		h.pen("pointerdown", 400, 300);
		h.pen("pointerup", 400, 300);
		expect(h.pinches.at(-1)!.phase).toBe("end");
		const mark = h.pinches.length;
		h.touch("pointermove", 2, 400, 100);
		const moves = h.pinches.slice(mark).filter(p => p.phase === "move");
		expect(moves.length).toBeGreaterThan(0);
		expect(moves.at(-1)!.ratio).toBeCloseTo(1.5, 6);
	});
});
