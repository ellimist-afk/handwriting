import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { harness, installFakeWindow, penEvent } from "../../test/routerHarness";

// Exercise the installed window capture listener, then model editor propagation
// and the browser default action separately. This is not a device reproduction.
type Rig = ReturnType<typeof harness>;
let uninstall: () => void;
let now = 1000;
let listeners: Map<string, Set<EventListener>>;
const rigs: Rig[] = [];
beforeAll(() => { uninstall = installFakeWindow(); });
afterAll(() => uninstall());
beforeEach(() => {
	now = 1000;
	listeners = new Map();
	vi.spyOn(performance, "now").mockImplementation(() => now);
	vi.spyOn(window, "addEventListener").mockImplementation((type, listener) => {
		if (!listeners.has(type)) listeners.set(type, new Set());
		listeners.get(type)!.add(listener as EventListener);
	});
	vi.spyOn(window, "removeEventListener").mockImplementation((type, listener) => {
		listeners.get(type)?.delete(listener as EventListener);
	});
});
afterEach(() => {
	for (const h of rigs.splice(0)) h.router.dispose();
	vi.restoreAllMocks();
});
function rig() { const h = harness(); rigs.push(h); return h; }
function pen(h: Rig, type = "pointermove", buttons = 0) {
	h.fire(penEvent(type, now, { pointerId: 7, buttons, pressure: buttons ? 0.5 : 0 }));
}
function touch(h: Rig, type: string, ids: number[], down = ids, target: unknown = h.el, radius?: number) {
	let prevented = false, stopped = false;
	let editorFocusCalls = 0, defaultActionCalls = 0;
	const contact = (identifier: number) => ({ identifier, radiusX: radius, radiusY: radius });
	const event = {
		type, target, changedTouches: ids.map(contact), touches: down.map(contact),
		preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; },
	} as unknown as Event;
	for (const listener of listeners.get(type) ?? []) listener(event);
	if (!stopped) editorFocusCalls++;
	if (!prevented) defaultActionCalls++;
	return { prevented, stopped, editorFocusCalls, defaultActionCalls };
}
const blocked = { prevented: true, stopped: true, editorFocusCalls: 0, defaultActionCalls: 0 };
const native = { prevented: false, stopped: false, editorFocusCalls: 1, defaultActionCalls: 1 };

describe("native touch uses the real router palm gate and native contact lifetime", () => {
	it.each([undefined, 2])("hover at 1000 blocks missing/small radius %s before editor focus", radius => {
		const h = rig(); pen(h);
		const pointer = penEvent("pointerdown", now, { pointerType: "touch", pointerId: 91, buttons: 1 });
		let pointerPrevented = false;
		pointer.preventDefault = () => { pointerPrevented = true; };
		h.fire(pointer);
		expect(pointerPrevented).toBe(true);
		expect(h.router.palmsBlocked).toBe(1);
		// Native identifier intentionally differs from pointerId.
		expect(touch(h, "touchstart", [501], [501], h.el, radius)).toEqual(blocked);
	});
	it("release at 1010 blocks a new native contact at 1100 without an active stroke", () => {
		const h = rig(); pen(h, "pointerdown", 1);
		now = 1010; pen(h, "pointerup");
		expect(h.rec.ups).toBe(1);
		now = 1100;
		expect(touch(h, "touchstart", [502])).toEqual(blocked);
	});
	it.each(["touchend", "touchcancel"])("blocked contact survives timer expiry through %s, then identifier reuse is native", ending => {
		const h = rig(); pen(h);
		expect(touch(h, "touchstart", [503])).toEqual(blocked);
		now = 2000;
		expect(touch(h, "touchmove", [503])).toEqual(blocked);
		expect(touch(h, ending, [503], [])).toEqual(blocked);
		expect(touch(h, "touchstart", [503])).toEqual(native);
	});
	it("cross-pane hover rejects a new native contact only inside an owned editor", () => {
		const a = rig(), b = rig(); pen(a);
		expect(touch(b, "touchstart", [504])).toEqual(blocked);
		expect(touch(b, "touchstart", [505], [505], {})).toEqual(native);
	});
	it("pen-off keyboard input overrides a blocked contact and keeps bookkeeping coherent", () => {
		const h = rig(); pen(h);
		expect(touch(h, "touchstart", [506])).toEqual(blocked);
		h.rec.cb.penOff = () => true;
		expect(touch(h, "touchmove", [506])).toEqual(native);
		expect(touch(h, "touchend", [506], [])).toEqual(native);
		expect(touch(h, "touchstart", [507])).toEqual(native);
	});
	it("no pen signal permits a normal finger through its whole lifetime", () => {
		const h = rig();
		for (const type of ["touchstart", "touchmove", "touchend"]) {
			expect(touch(h, type, [508], type === "touchend" ? [] : [508])).toEqual(native);
		}
	});
	it("a finger already down before hover and stroke keeps its continuation and cleanup", () => {
		const h = rig();
		expect(touch(h, "touchstart", [509])).toEqual(native);
		now = 1010; pen(h);
		expect(touch(h, "touchmove", [509])).toEqual(native);
		pen(h, "pointerdown", 1);
		expect(touch(h, "touchmove", [509])).toEqual(native);
		expect(touch(h, "touchend", [509], [])).toEqual(native);
	});
	it("a second contact is gated without reclassifying the earlier finger", () => {
		const h = rig();
		expect(touch(h, "touchstart", [510])).toEqual(native);
		pen(h);
		expect(touch(h, "touchstart", [511], [510, 511])).toEqual(blocked);
		expect(touch(h, "touchmove", [510], [510, 511])).toEqual(native);
		now = 2000;
		expect(touch(h, "touchcancel", [511], [510])).toEqual(blocked);
		expect(touch(h, "touchend", [510], [])).toEqual(native);
	});
	it("dispose removes native listeners; a new router does not inherit blocked identifiers", () => {
		const h = rig(); pen(h);
		expect(touch(h, "touchstart", [512])).toEqual(blocked);
		h.router.dispose(); rigs.splice(rigs.indexOf(h), 1);
		now = 2000;
		expect(touch(h, "touchmove", [512])).toEqual(native);
		const fresh = rig();
		expect(touch(fresh, "touchstart", [512])).toEqual(native);
	});
});
