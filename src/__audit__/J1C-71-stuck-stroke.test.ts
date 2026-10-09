/**
 * J1C-71, a stuck stroke across panes: a pen stroke in pane A that stops without any lift (no pointerup, no cancel,
 * no lost capture, no blur) leaves pane A's gate holding "a stroke is active", and the touch gate reads every pane,
 * so a finger in pane B is swallowed as a palm for as long as that flag stands. The pen cannot be down in two panes
 * at once: when it lands in pane B, the stroke still open in pane A is over. It is ended the way a blur ends it,
 * committed with its ink kept, and pane A's gate lets go, so once the pen lifts from pane B a finger there scrolls.
 * Two REAL routers. Stubbed: callbacks (recorder), window, performance.now. Only scroller-level events are fired.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { InlinePenRouter } from "../inline/InlinePenRouter";
import { resetPenToolsForTest } from "../inline/PenToolsMode";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../../test/routerHarness";

let clock = 1000;
let undo: () => void;
const routers: InlinePenRouter[] = [];
beforeAll(() => { undo = installFakeWindow(); });
afterAll(() => undo());
beforeEach(() => { clock = 1000; vi.spyOn(performance, "now").mockImplementation(() => clock); resetPenToolsForTest(); });
afterEach(() => { for (const r of routers.splice(0)) r.dispose(); vi.restoreAllMocks(); });

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
	const fire = (type: string, pointerType: string, id: number, x: number, y: number, buttons: number) => {
		clock += 16;
		el.handlers.get(type)!(penEvent(type, clock, { pointerId: id, pointerType, x, y, pressure: buttons ? 0.5 : 0, buttons }));
	};
	return { el, router, rec, fire };
}

describe("J1C-71 a pen stroke left open in pane A ends when the pen lands in pane B", () => {
	it("A's stroke is committed with its ink, A's gate lets go, and a finger in B scrolls after the pen lifts from B", () => {
		const a = pane();
		const b = pane();
		a.fire("pointerdown", "pen", 9, 200, 200, 1);
		a.fire("pointermove", "pen", 9, 220, 210, 1);
		expect(a.rec.downs, "premise: the pen is writing in A").toBe(1);
		// Silent stop: no pointerup, no cancel, no lostpointercapture, no blur reaches pane A.
		b.fire("pointerdown", "pen", 9, 300, 300, 1);
		b.fire("pointermove", "pen", 9, 320, 310, 1);
		expect(b.rec.downs, "premise: the pen is writing in B").toBe(1);
		expect.soft(a.rec.ups, "A's stroke was committed, not dropped").toBe(1);
		expect.soft((a.router as unknown as { gate: { isPenStrokeActive: boolean } }).gate.isPenStrokeActive, "A's gate let go").toBe(false);
		b.fire("pointerup", "pen", 9, 320, 310, 0);
		clock += 1000; // past every post-stroke and hover tail
		const blocked = b.router.palmsBlocked;
		const top = b.el.scrollTop;
		b.fire("pointerdown", "touch", 31, 400, 400, 1);
		for (let i = 1; i <= 6; i++) b.fire("pointermove", "touch", 31, 400, 400 - i * 10, 1);
		expect.soft(b.router.palmsBlocked, "the finger in B was not swallowed as a palm").toBe(blocked);
		expect.soft(b.el.scrollTop, "the finger in B scrolled it").not.toBe(top);
	});
});
