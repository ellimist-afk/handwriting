/**
 * J1C-68: a third contact during a pinch must not make the pinch settle on
 * client (0,0). Real code: InlinePenRouter on the shared element fake.
 * Stubbed: callbacks (onPinch recorded), window, performance.now.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePenRouter } from "../inline/InlinePenRouter";
import { resetPenToolsForTest } from "../inline/PenToolsMode";
import { fakeEl, installFakeWindow, penEvent, recorder, winHandlers } from "../../test/routerHarness";

interface Pinch { phase: string; ratio: number; c: { x: number; y: number } }

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
		onPinch: (phase: string, ratio: number, c: { x: number; y: number }) => pinches.push({ phase, ratio, c: { ...c } }),
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
	const pinchThenThird = () => {
		touch("pointerdown", 1, 100, 100); native("touchstart", 501, [501]);
		touch("pointerdown", 2, 200, 100); native("touchstart", 502, [501, 502]);
		touch("pointermove", 2, 300, 100);
		touch("pointerdown", 3, 700, 500); native("touchstart", 503, [501, 502, 503]);
	};
	const lastMove = () => [...pinches].reverse().find(p => p.phase === "move")!;
	const ends = () => pinches.filter(p => p.phase === "end");
	return { touch, pen, native, pinches, pinchThenThird, lastMove, ends };
}

describe("J1C-68 the pinch end with a third contact down", () => {
	it("control: a clean two-finger pinch lift settles on its focal point", () => {
		const h = rig();
		h.touch("pointerdown", 1, 100, 100);
		h.touch("pointerdown", 2, 200, 100);
		h.touch("pointermove", 2, 300, 100);
		h.touch("pointerup", 2, 300, 100);
		expect(h.ends()).toHaveLength(1);
		expect(h.ends()[0]!.c).toEqual({ x: 200, y: 100 });
	});

	it("lift of the stray third contact: end centroid is the pinch's focal point, not (0,0)", () => {
		const h = rig();
		h.pinchThenThird();
		expect(h.lastMove().c).toEqual({ x: 200, y: 100 });
		h.touch("pointerup", 3, 700, 500);
		expect(h.ends()).toHaveLength(1);
		expect(h.ends()[0]!.c).toEqual({ x: 200, y: 100 });
	});

	it("lift of a pinching finger while the third is down: end centroid is not (0,0)", () => {
		const h = rig();
		h.pinchThenThird();
		h.touch("pointerup", 1, 100, 100);
		expect(h.ends()).toHaveLength(1);
		expect(h.ends()[0]!.c).not.toEqual({ x: 0, y: 0 });
	});

	it("pen claim with three contacts down: end centroid is not (0,0)", () => {
		const h = rig();
		h.pinchThenThird();
		h.pen("pointerdown", 400, 300);
		expect(h.ends()).toHaveLength(1);
		expect(h.ends()[0]!.c).not.toEqual({ x: 0, y: 0 });
	});

	it("native all-touches-ended recovery with three contacts tracked: end centroid is not (0,0)", () => {
		const h = rig();
		h.pinchThenThird();
		h.native("touchcancel", 503, []);
		expect(h.ends()).toHaveLength(1);
		expect(h.ends()[0]!.c).not.toEqual({ x: 0, y: 0 });
	});
});
