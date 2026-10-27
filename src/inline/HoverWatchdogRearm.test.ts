import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InkOverlayPlugin, releaseTipModes, setPenReticle } from "./InkOverlay";
import { Camera } from "../camera/Camera";
import { HOVER_GHOST_MS } from "./PenCursor";

// The hover watchdog keeps one timer. A hover sample stamps its time; the timer, when it fires, re-arms for the rest of
// the second if a sample came since, and hides the reticle only after a full second with none. These hold both halves:
// a pen that keeps hovering is never hidden and costs a handful of timers, not one per sample, and a pen that goes
// quiet is hidden exactly one second after its last sample.

function rig() {
	let timers = 0;
	const cursorStyle: Record<string, string> = {};
	const inst = Object.create(InkOverlayPlugin.prototype) as Record<string, any>;
	Object.assign(inst, {
		camera: new Camera(), cssScale: 1, penCursorPinned: false, penCursorShown: false, penCursorClient: null,
		hoverWatchdog: null, mode: "ink", spacePlan: null, router: null,
		penCursorEl: {
			classList: { add: () => undefined, remove: () => undefined },
			setCssStyles: (s: Record<string, string>) => Object.assign(cursorStyle, s),
		},
		view: {
			dom: { ownerDocument: { defaultView: {
				setTimeout: (fn: () => void, ms: number) => { timers++; return setTimeout(fn, ms); },
				clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
			} } },
			scrollDOM: { classList: { add: () => undefined, remove: () => undefined, contains: () => false } },
		},
		clearSpaceFeedback: () => undefined,
	});
	const hover = (x: number) => inst.showPenCursor({ x, y: 10, pressure: 0, timestamp: 0, tiltX: 0, tiltY: 0 }, "pen");
	return { inst, hover, cursorStyle, timers: () => timers };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
	setPenReticle(true);
	releaseTipModes();
});
afterEach(() => {
	vi.useRealTimers();
	setPenReticle(true);
	releaseTipModes();
});

it("25 hover samples 100 ms apart never hide the reticle, on at most 4 timers", () => {
	const r = rig();
	for (let i = 0; i < 25; i++) {
		r.hover(10 + i);
		expect(r.inst.penCursorShown, `hidden while hovering, sample ${i}`).toBe(true);
		vi.advanceTimersByTime(100);
		expect(r.inst.penCursorShown, `hidden 100 ms after sample ${i}`).toBe(true);
		expect(r.cursorStyle.opacity).not.toBe("0");
	}
	expect(r.timers()).toBeLessThanOrEqual(4);
});

it("silence after the last sample hides the reticle at exactly one second", () => {
	const r = rig();
	for (let i = 0; i < 5; i++) { r.hover(10 + i); vi.advanceTimersByTime(100); }
	r.hover(20);
	vi.advanceTimersByTime(HOVER_GHOST_MS - 1);
	expect(r.inst.penCursorShown, "hidden before a full second of silence").toBe(true);
	vi.advanceTimersByTime(1);
	expect(r.inst.penCursorShown, "still shown a full second after the last sample").toBe(false);
	expect(r.cursorStyle.opacity).toBe("0");
});
