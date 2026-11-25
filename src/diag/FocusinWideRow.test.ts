import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDiagnosticsEnabled } from "./DiagSwitch";
import { holdKeyboardForEveryPen } from "../inline/InlineFocus";
import { clearInlinePenTrace, formatInlinePenTrace } from "../inline/InlinePenRouterTrace";

/** Issue 66: the focusin row after a pen-down also carries the caret read at the pen-down and scrollTop at 3 frames and 500 ms. */
function rig(withWindow: boolean) {
	const frames: Array<() => void> = [];
	const win = {
		requestAnimationFrame: vi.fn((fn: () => void) => frames.push(fn)),
		setTimeout: vi.fn((fn: () => void, ms?: number) => setTimeout(fn, ms)),
		clearTimeout: vi.fn((id: ReturnType<typeof setTimeout>) => clearTimeout(id)),
	};
	const attrs = new Map<string, string>();
	const content = Object.assign(new EventTarget(), {
		getAttribute: (n: string) => attrs.get(n) ?? null,
		setAttribute: (n: string, v: string) => void attrs.set(n, v),
		removeAttribute: (n: string) => void attrs.delete(n),
		ownerDocument: { activeElement: null, defaultView: withWindow ? win : null },
	});
	const root = new EventTarget();
	const scroller = { scrollTop: 2000, getBoundingClientRect: () => ({ top: 30, left: 0, right: 800, bottom: 630, width: 800, height: 600 }) };
	const view = {
		hasFocus: false,
		contentDOM: content as never,
		dom: root as never,
		scrollDOM: scroller as never,
		documentTop: 50,
		state: { selection: { main: { head: 120 } }, doc: { lineAt: (pos: number) => ({ number: pos === 120 ? 7 : -1 }) } },
		lineBlockAt: (pos: number) => ({ top: pos === 120 ? 300 : -1 }),
	};
	const release = holdKeyboardForEveryPen(view, () => null);
	const penDown = () =>
		root.dispatchEvent(
			Object.assign(new Event("pointerdown"), { pointerType: "pen", pointerId: 2, buttons: 1, button: 0, pressure: 0.5, clientX: 10, clientY: 20, tiltX: 0, tiltY: 0 })
		);
	const frame = () => {
		const run = frames.splice(0);
		for (const fn of run) fn();
	};
	return { win, content, scroller, penDown, frame, release };
}

const rows = () =>
	formatInlinePenTrace()
		.split("\n")
		.filter((l) => l.includes("focusin after pen-down"));

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	setDiagnosticsEnabled(true);
	clearInlinePenTrace();
});
afterEach(() => {
	setDiagnosticsEnabled(false);
	clearInlinePenTrace();
	vi.useRealTimers();
});

describe("issue 66 wider focusin row", () => {
	it("one row at 500 ms after the focusin: the old fields first and unchanged, then caret line and top, then scrollTop at 3 frames and 500 ms", () => {
		const r = rig(true);
		r.penDown();
		r.scroller.scrollTop = 0;
		r.content.dispatchEvent(new Event("focusin"));
		r.scroller.scrollTop = 10;
		r.frame();
		r.scroller.scrollTop = 15;
		r.frame();
		r.scroller.scrollTop = 20;
		r.frame();
		r.scroller.scrollTop = 25;
		r.frame();
		vi.advanceTimersByTime(499);
		expect(rows(), "rows before 500 ms").toHaveLength(0);
		r.scroller.scrollTop = 30;
		vi.advanceTimersByTime(1);
		const got = rows();
		expect(got).toHaveLength(1);
		expect(got[0]).toMatch(/focusin after pen-down: active before=\S+ now=\S+, scrollTop at down=2000 at focusin=0 next frame=10, stack: /);
		const tail = got[0]!.split("; caret at pen-down ")[1];
		expect(tail, "the new fields come after the stack").toBe("line=7 top=2320, scrollTop after focusin at 3 frames=20 at 500ms=30, row time is the 500ms read");
		r.release();
	});

	it("an editor with no window writes the row at once, its later reads given as none", () => {
		const r = rig(false);
		r.penDown();
		r.content.dispatchEvent(new Event("focusin"));
		const got = rows();
		expect(got).toHaveLength(1);
		expect(got[0]).toContain("; caret at pen-down line=7 top=2320, scrollTop after focusin at 3 frames=none at 500ms=none");
		r.release();
	});

	it("a 500 ms read that comes before the third frame says the frame is still pending", () => {
		const r = rig(true);
		r.penDown();
		r.content.dispatchEvent(new Event("focusin"));
		r.frame();
		vi.advanceTimersByTime(500);
		expect(rows()[0]).toContain("at 3 frames=pending at 500ms=2000");
		r.release();
	});
});
