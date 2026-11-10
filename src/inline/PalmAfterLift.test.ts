/**
 * The palm tails after a pen lift: 250 ms after the lift and 300 ms after the last hover. Once both have run out, one
 * finger is a plain finger and pans at once; inside them a resting palm stays still. Through a real router.
 * Stubbed: callbacks, window, performance.now.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePenRouter } from "./InlinePenRouter";
import { resetPenToolsForTest } from "./PenToolsMode";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../../test/routerHarness";

let clock = 1000;
let undo: () => void;
const routers: InlinePenRouter[] = [];
beforeAll(() => { undo = installFakeWindow(); });
afterAll(() => undo());
beforeEach(() => { clock = 1000; vi.spyOn(performance, "now").mockImplementation(() => clock); resetPenToolsForTest(); });
afterEach(() => {
	for (const r of routers.splice(0)) r.dispose();
	vi.restoreAllMocks();
});

function pane() {
	const el = fakeEl() as ReturnType<typeof fakeEl> & Record<string, unknown>;
	Object.assign(el, {
		clientWidth: 800, clientHeight: 600, scrollWidth: 100_000, scrollHeight: 100_000,
		scrollTo(o: { left: number; top: number }) { el.scrollLeft = o.left; el.scrollTop = o.top; },
	});
	el.scrollLeft = 5000;
	el.scrollTop = 5000;
	const rec = recorder();
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement,
		{ ...rec.cb, fingerInk: () => false, penOff: () => false } as never, () => 1);
	routers.push(router);
	router.setCanvasMomentumDisabled(true);
	/** Fire one scroller-level event `dt` ms after the last one. */
	const fire = (type: string, pointerType: string, id: number, x: number, y: number, buttons: number, dt = 16) => {
		clock += dt;
		el.handlers.get(type)!(penEvent(type, clock, { pointerId: id, pointerType, x, y, pressure: buttons ? 0.5 : 0, buttons }));
	};
	/** One pen stroke, then the pen leaves the glass with no hover after it: the lift is the last event. */
	const write = () => {
		fire("pointerdown", "pen", 9, 200, 200, 1);
		fire("pointermove", "pen", 9, 220, 210, 1);
		fire("pointerup", "pen", 9, 220, 210, 0);
		expect(rec.downs, "premise: the pen wrote").toBe(1);
	};
	/** One finger lands `dt` ms after the last event and travels `px` straight up in `moves` moves 16 ms apart. */
	const drag = (dt: number, px: number, moves: number) => {
		fire("pointerdown", "touch", 21, 300, 400, 1, dt);
		for (let i = 1; i <= moves; i++) fire("pointermove", "touch", 21, 300, 400 - Math.round((px * i) / moves), 1);
		fire("pointerup", "touch", 21, 300, 400 - px, 0);
	};
	const top = () => el.scrollTop as number;
	return { el, router, rec, fire, write, drag, top };
}

describe("one finger after a pen lift, with no hover", () => {
	it("a finger landing 300 ms after the lift pans", () => {
		const p = pane();
		p.write();
		const before = p.top();
		p.drag(300, 120, 15);
		expect(p.top(), "the page moved with the finger").not.toBe(before);
	});

	it("a finger landing 500 ms after the lift pans", () => {
		const p = pane();
		p.write();
		const before = p.top();
		p.drag(500, 120, 15);
		expect(p.top(), "the page moved with the finger").not.toBe(before);
	});

	it("a resting palm landing 100 ms after the lift, travelling under the parole distance, does not move the page", () => {
		const p = pane();
		p.write();
		const before = p.top();
		p.drag(100, 10, 10);
		expect(p.top(), "the page stayed").toBe(before);
	});
});
