/**
 * J1C-70: a contact whose pointerDown sent onViewportInput (cancels the ease)
 * and that owned nothing must, by the time it ends, have been followed by
 * onAllContactsLifted (resumes the stranded pan). Finger tap = control.
 * Real code: InlinePenRouter. Stubbed: callbacks (logged), window, performance.now.
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
beforeEach(() => { clock = 1000; vi.spyOn(performance, "now").mockImplementation(() => clock); });
afterEach(() => { for (const r of routers.splice(0)) r.dispose(); vi.restoreAllMocks(); });

function rig(penOff = false) {
	resetPenToolsForTest();
	const el = fakeEl();
	Object.assign(el, { scrollWidth: 2000, clientWidth: 800, scrollHeight: 2000, clientHeight: 600 });
	const log: string[] = [];
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, {
		...recorder().cb,
		fingerInk: () => false,
		penOff: () => penOff,
		onViewportInput: () => log.push("cancel"),
		onAllContactsLifted: () => log.push("resume"),
	} as never, () => 1);
	routers.push(router);
	const fire = (type: string, pointerType: string, id: number, buttons: number, x = 300, y = 300) => {
		clock += 16;
		el.handlers.get(type)!(penEvent(type, clock, { pointerId: id, pointerType, x, y, pressure: buttons ? 0.5 : 0, buttons }));
	};
	const easeGivenBack = () => {
		const lastCancel = log.lastIndexOf("cancel");
		return lastCancel === -1 || log.indexOf("resume", lastCancel) !== -1;
	};
	return { fire, log, easeGivenBack };
}

describe("J1C-70 a contact that cancels the ease resumes it when it ends", () => {
	it("control: a finger tap", () => {
		const h = rig();
		h.fire("pointerdown", "touch", 1, 1);
		h.fire("pointerup", "touch", 1, 0);
		expect(h.log.at(-1)).toBe("resume");
		expect(h.easeGivenBack()).toBe(true);
	});

	it("a mouse click (mouse ink off)", () => {
		const h = rig();
		h.fire("pointerdown", "mouse", 1, 1);
		h.fire("pointerup", "mouse", 1, 0);
		expect(h.log).toContain("cancel");
		expect(h.easeGivenBack()).toBe(true);
	});

	it("a pen tap with the pen off", () => {
		const h = rig(true);
		h.fire("pointerdown", "pen", 9, 1);
		h.fire("pointerup", "pen", 9, 0);
		expect(h.log).toContain("cancel");
		expect(h.easeGivenBack()).toBe(true);
	});

	it("a palm the gate swallowed (pen hovering nearby)", () => {
		const h = rig();
		h.fire("pointermove", "pen", 9, 0, 500, 500);
		h.fire("pointerdown", "touch", 1, 1);
		h.fire("pointerup", "touch", 1, 0);
		expect(h.log).toContain("cancel");
		expect(h.easeGivenBack()).toBe(true);
	});
});
