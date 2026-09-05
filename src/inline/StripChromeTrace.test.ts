/**
 * Slice 1 of the strip-tap trace gap (1.4.10-strip-trace).
 *
 * The owner's own "Bug report" trace shows every failing pen tap as
 * `window-pointerdown ... composed path does NOT include a Handwriting
 * editor scroller` and then nothing - no claim, no click, no suppression.
 * That line alone cannot say whether the tap landed on the pen-toolbar
 * strip (mounted OUTSIDE the scroller by design - MobileTools.ts) or on
 * nothing at all, because InlinePenRouter.ts's window mirror never asked
 * the strip anything. `InlinePenCallbacks.describeChrome` is the seam: the
 * overlay hands the router an optional callback, and the mirror calls it -
 * ONLY for a pen pointerdown whose composed path misses every live
 * scroller - folding the answer into that SAME trace line.
 *
 * This pins the router's half of that seam against the real router (the
 * same harness TraceReplay.test.ts and AbandonStrokeOnSwitch.test.ts
 * drive): `describeChrome` is called with the pointerdown's actual hit
 * element, and its return value lands in the trace line. MobileTools' own
 * `traceState` - what a real overlay actually passes as `describeChrome` -
 * has no harness here that renders real CSS or a real DOM tree (the same
 * limitation AbandonStrokeOnSwitch.test.ts's header notes for `setInking`),
 * so it is stubbed, the same way that file stubs the overlay's callbacks.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import {
	captureInlinePenTrace,
	clearInlinePenTrace,
	InlinePenCallbacks,
	InlinePenRouter,
} from "./InlinePenRouter";
import { fakeEl, installFakeWindow, winHandlers } from "../../test/routerHarness";

let uninstallWindow: () => void = () => {};
beforeAll(() => {
	uninstallWindow = installFakeWindow();
	setDiagnosticsEnabled(true);
});
afterAll(() => {
	setDiagnosticsEnabled(false);
	uninstallWindow();
});
afterEach(() => {
	clearInlinePenTrace();
});

/** Every callback InlinePenCallbacks requires, all no-ops. */
function noopCallbacks(): InlinePenCallbacks {
	return {
		onPenDown: () => {},
		onPenHover: () => {},
		onPenLeave: () => {},
		onPinch: () => {},
		onPenRaw: () => {},
		onPenMove: () => {},
		onPenUp: () => {},
	};
}

/**
 * A pen pointerdown as the window-capture mirror sees it. `composedPath` is
 * what decides "for us" or not (same as production); `target` stands in for
 * `composedPath()[0]` here since this fake path is one element deep.
 */
function windowPenDown(hit: unknown): PointerEvent {
	return {
		type: "pointerdown",
		pointerType: "pen",
		pointerId: 9,
		buttons: 1,
		button: 0,
		pressure: 0.5,
		clientX: 40,
		clientY: 40,
		tiltX: 0,
		tiltY: 0,
		timeStamp: 1,
		target: hit,
		composedPath: () => [hit],
		preventDefault: () => {},
		stopPropagation: () => {},
	} as unknown as PointerEvent;
}

describe("InlinePenRouter window mirror: describeChrome (Slice 1)", () => {
	it("a scroller-missing pen down folds describeChrome's return into the trace line", () => {
		const scrollEl = fakeEl();
		const hitTarget = fakeEl();
		let seenTarget: unknown;
		const cb: InlinePenCallbacks = {
			...noopCallbacks(),
			describeChrome: (target) => {
				seenTarget = target;
				return "STUB-CHROME-STATE is-inking=false strip-part=pill";
			},
		};
		const router = new InlinePenRouter(
			scrollEl as unknown as HTMLElement,
			scrollEl as unknown as HTMLElement,
			cb
		);

		const fn = winHandlers.get("pointerdown");
		expect(fn).toBeDefined();
		fn!(windowPenDown(hitTarget));

		const events = captureInlinePenTrace({}).events;
		const line = events.find((e) => e.type === "window-pointerdown");
		expect(line).toBeDefined();
		expect(line!.note).toContain("does NOT include a Handwriting editor scroller");
		expect(line!.note).toContain("STUB-CHROME-STATE is-inking=false strip-part=pill");
		// describeChrome must see the actual hit element - composedPath()[0],
		// not a placeholder and not the event's own (possibly retargeted)
		// `target` read some other way.
		expect(seenTarget).toBe(hitTarget);

		router.dispose();
	});

	it("does not call describeChrome when the composed path DOES include the scroller", () => {
		const scrollEl = fakeEl();
		let called = false;
		const cb: InlinePenCallbacks = {
			...noopCallbacks(),
			describeChrome: () => {
				called = true;
				return "should never appear";
			},
		};
		const router = new InlinePenRouter(
			scrollEl as unknown as HTMLElement,
			scrollEl as unknown as HTMLElement,
			cb
		);

		const fn = winHandlers.get("pointerdown");
		fn!(windowPenDown(scrollEl));

		const events = captureInlinePenTrace({}).events;
		const line = events.find((e) => e.type === "window-pointerdown");
		expect(line).toBeDefined();
		expect(line!.note).toContain("includes a Handwriting editor scroller");
		expect(line!.note).not.toContain("should never appear");
		expect(called).toBe(false);

		router.dispose();
	});

	it("a router whose overlay leaves describeChrome undefined (the pdf surface) adds nothing extra", () => {
		const scrollEl = fakeEl();
		const hitTarget = fakeEl();
		const router = new InlinePenRouter(
			scrollEl as unknown as HTMLElement,
			scrollEl as unknown as HTMLElement,
			noopCallbacks()
		);

		const fn = winHandlers.get("pointerdown");
		fn!(windowPenDown(hitTarget));

		const events = captureInlinePenTrace({}).events;
		const line = events.find((e) => e.type === "window-pointerdown");
		expect(line).toBeDefined();
		expect(line!.note).toBe(
			"PAGE RECEIVED IT; composed path does NOT include a Handwriting editor scroller"
		);

		router.dispose();
	});
});
