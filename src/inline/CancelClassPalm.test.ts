/**
 * A palm that lands while the pen writes is swallowed by the palm gate
 * (`swallowedTouches`, InlinePenRouter.ts ~2867). Only that palm's own
 * pointerup or pointercancel removes it (~3603). The two backstops for a lost
 * lift do not reach it: the window blur clears `touchPos` and `guardTouches`
 * (~1764), and the native "no touches left" touchend retires only `touchPos`
 * keys, and only when `touchPos` is non-empty (~1360). While the id stays in
 * the set, `handOnGlass()` reads true for good (the mouse ring is hidden in
 * every pane) and `resumeEaseIfIdle` never gives the edge ease back.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { InlinePenRouter } from "./InlinePenRouter";
import { harness as baseHarness, installFakeWindow, penEvent } from "../../test/routerHarness";

const built: InlinePenRouter[] = [];
function harness(): ReturnType<typeof baseHarness> {
	const h = baseHarness();
	built.push(h.router);
	return h;
}

let uninstall: () => void = () => {};
beforeAll(() => {
	uninstall = installFakeWindow();
});
afterAll(() => uninstall());
afterEach(() => {
	vi.restoreAllMocks();
	for (const r of built.splice(0)) r.dispose();
});

const PALM = 31;

function palmDown(): PointerEvent {
	return penEvent("pointerdown", 105, {
		pointerType: "touch",
		pointerId: PALM,
		isPrimary: false,
		x: 300,
		y: 300,
		pressure: 0.5,
	});
}

function nativeTouch(el: unknown, type: "touchstart" | "touchend", remaining: number[]): PointerEvent {
	return {
		type,
		target: el,
		touches: remaining.map((identifier) => ({ identifier })),
		changedTouches: [{ identifier: PALM }],
		preventDefault: () => {},
		stopPropagation: () => {},
	} as unknown as PointerEvent;
}

/** Ten seconds on: every hover stamp, gate tail and ghost window has lapsed. */
function later(): void {
	const t = performance.now() + 10_000;
	vi.spyOn(performance, "now").mockReturnValue(t);
}

describe("cancel class: a swallowed palm whose lift never arrives", () => {
	it("the native all-touches-ended touchend lets the hand off the glass", () => {
		const h = harness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const p = h.router as any;
		h.fire(penEvent("pointerdown", 100));
		h.fireWin(nativeTouch(h.el, "touchstart", [PALM]));
		h.fire(palmDown());
		expect(p.swallowedTouches.has(PALM), "the gate never swallowed the palm").toBe(true);
		h.fire(penEvent("pointerup", 110, { pressure: 0, buttons: 0 }));
		// The palm's pointerup is lost; the browser still says the hand is off.
		h.fireWin(nativeTouch(h.el, "touchend", []));
		later();
		expect(h.router.handOnGlass(), "the hand reads as on the glass for good").toBe(false);
	});

	it("a window blur lets the hand off the glass", () => {
		const h = harness();
		h.fire(penEvent("pointerdown", 100));
		h.fire(palmDown());
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((h.router as any).swallowedTouches.has(PALM), "the gate never swallowed the palm").toBe(true);
		h.fireWin({ type: "blur" } as unknown as PointerEvent);
		expect(h.rec.ups, "the stroke did not commit on blur").toBe(1);
		later();
		expect(h.router.handOnGlass(), "the hand reads as on the glass for good").toBe(false);
	});

	it("the native all-touches-ended touchend gives the edge ease back", () => {
		const h = harness();
		let lifted = 0;
		(h.rec.cb as unknown as { onAllContactsLifted?: () => void }).onAllContactsLifted = () => void lifted++;
		h.fire(penEvent("pointerdown", 100));
		h.fireWin(nativeTouch(h.el, "touchstart", [PALM]));
		h.fire(palmDown());
		h.fire(penEvent("pointerup", 110, { pressure: 0, buttons: 0 }));
		const beforeEnd = lifted;
		h.fireWin(nativeTouch(h.el, "touchend", []));
		expect(lifted - beforeEnd, "the hand left the glass and the ease stayed frozen").toBe(1);
	});
});
