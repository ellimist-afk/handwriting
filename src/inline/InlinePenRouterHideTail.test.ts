// A hide only finishes a live stroke. Inside the tail after a lift, or on a second hide, it must leave the standing
// touch-action guard armed: a hide is not a loss of continuity.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { finishLiveStrokesOnHide } from "./InlinePenRouter";
import { harness, installFakeWindow, penEvent } from "../../test/routerHarness";

let undo: () => void = () => undefined;
beforeAll(() => { undo = installFakeWindow(); });
afterAll(() => undo());

describe("hide inside the 350 ms tail after a lift", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("control: a lift with no hide leaves the guard armed", () => {
		const h = harness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const p = h.router as any;
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointerup", 140));
		expect(h.rec.ups, "premise: lift committed").toBe(1);
		expect(p.guardApplied, "control guard").toBe(true);
		expect(h.el.style.touchAction, "control touchAction").toBe("none");
		h.router.dispose();
	});

	it("lift, then a hide 50 ms later, leaves the guard armed", () => {
		const h = harness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const p = h.router as any;
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointerup", 140));
		vi.advanceTimersByTime(50);
		finishLiveStrokesOnHide();
		expect(h.rec.ups, "no second commit").toBe(1);
		expect(h.rec.abandons, "abandon callback after a lifted stroke").toBe(0);
		expect(p.guardApplied, "hide in tail pulled the guard").toBe(true);
		expect(h.el.style.touchAction, "hide in tail touchAction").toBe("none");
		h.router.dispose();
	});

	it("pen on glass, visibilitychange then pagehide (two hides), leaves the guard armed", () => {
		const h = harness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const p = h.router as any;
		h.fire(penEvent("pointerdown", 100));
		finishLiveStrokesOnHide();
		expect(h.rec.ups, "first hide commits").toBe(1);
		expect(p.guardApplied, "after first hide").toBe(true);
		finishLiveStrokesOnHide();
		expect(h.rec.ups, "second hide no second commit").toBe(1);
		expect(p.guardApplied, "second hide pulled the guard").toBe(true);
		expect(h.el.style.touchAction, "second hide touchAction").toBe("none");
		h.router.dispose();
	});

	it("control: after the tail expires, a hide changes nothing", () => {
		const h = harness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const p = h.router as any;
		h.fire(penEvent("pointerdown", 100));
		h.fire(penEvent("pointerup", 140));
		vi.advanceTimersByTime(1000);
		finishLiveStrokesOnHide();
		expect(p.guardApplied, "late hide pulled the guard").toBe(true);
		h.router.dispose();
	});
});
