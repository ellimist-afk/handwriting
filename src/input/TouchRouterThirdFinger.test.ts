import { describe, expect, it } from "vitest";
import { PointerRouter, type NavigationCamera } from "./PointerRouter";
import type { Point } from "../camera/coordinates";

function rig() {
	const handlers = new Map<string, (e: unknown) => void>();
	const root = {
		addEventListener: (t: string, fn: (e: unknown) => void) => void handlers.set(t, fn),
		removeEventListener: () => {},
		getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
		setPointerCapture: () => {},
		ownerDocument: { defaultView: null },
	};
	const pinches: { prevDist: number; nextDist: number; prevMid: Point; nextMid: Point }[] = [];
	const camera: NavigationCamera = {
		zoom: 1,
		panBy: () => {},
		zoomAt: () => {},
		pinch: (prevMid, prevDist, nextMid, nextDist) => void pinches.push({ prevMid, prevDist, nextMid, nextDist }),
	};
	new PointerRouter(root as unknown as HTMLElement, camera, {
		onPenDown: () => {}, onPenMove: () => {}, onPenUp: () => {}, onStatus: () => {},
	});
	const fire = (type: string, id: number, x: number, y = 100) =>
		handlers.get(type)!({
			type, pointerId: id, pointerType: "touch", clientX: x, clientY: y,
			target: null, preventDefault() {}, timeStamp: 0, pressure: 0.5, tiltX: 0, tiltY: 0, buttons: 1,
		});
	return { fire, pinches };
}

describe("PointerRouter: third finger, then one of the pinch pair lifts", () => {
	it("the third finger's small move after the lift is a small zoom, not a jump", () => {
		const h = rig();
		h.fire("pointerdown", 1, 100);
		h.fire("pointerdown", 2, 200);
		h.fire("pointerdown", 3, 600);      // third finger lands at x=600
		h.fire("pointermove", 3, 650);      // ...and slides to x=700 while the pair pinches
		h.fire("pointermove", 3, 700);
		h.fire("pointerup", 1, 100);        // finger 1 lifts: pair is now (2 @200, 3 @700)
		h.fire("pointermove", 3, 702);      // third finger moves 2px
		const last = h.pinches.at(-1)!;
		expect(last.nextDist / last.prevDist).toBeCloseTo(502 / 500, 2);
	});
});
