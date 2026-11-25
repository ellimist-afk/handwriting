import { afterEach, describe, expect, it } from "vitest";
import { setDiagnosticsEnabled } from "./DiagSwitch";
import { clearInlinePenTrace } from "../inline/InlinePenRouterTrace";
import { scrollWriterTrace, type ScrollWriterWindow } from "./ScrollWriterTrace";
import { fakeScrollWindow, scrollRows, writerSlots } from "./ScrollWriterTrace.fixture";

/** The scroll-writer hook on its own: which writes leave a row, what a row says, and what it leaves behind. */
afterEach(() => {
	scrollWriterTrace(false);
	setDiagnosticsEnabled(false);
	clearInlinePenTrace();
});

function on() {
	const f = fakeScrollWindow();
	const own = writerSlots(f.El.prototype);
	setDiagnosticsEnabled(true);
	clearInlinePenTrace();
	scrollWriterTrace(true, f.win);
	return { ...f, own };
}

const via = (row: string) => /via (\S+?),/.exec(row)?.[1];

describe("scroll-writer hook", () => {
	it("each scroll method that moves a note's scroller leaves one row naming the method", () => {
		const r = on();
		const s = r.scroller(1000);
		const line = r.child(s, 300);
		s.scrollTo(0, 900);
		s.scroll({ top: 800 });
		s.scrollBy(0, -100);
		line.scrollIntoView();
		s.scrollTop = 1000;
		line.scrollIntoViewIfNeeded();
		const rows = scrollRows();
		expect(rows.map(via)).toEqual(["scrollTo", "scroll", "scrollBy", "scrollIntoView", "scrollTop=1000", "scrollIntoViewIfNeeded"]);
		expect(rows[0]).toContain("scrollTop 1000 -> 900 via scrollTo");
		expect(rows[2]).toContain("scrollTop 800 -> 700 via scrollBy");
		expect(rows[3]).toContain("scrollTop 700 -> 300 via scrollIntoView");
		expect(rows[4]).toContain("scrollTop 300 -> 1000 via scrollTop=1000");
	});

	it("a write that leaves the scroller where it was, and a write on any other element, leave no row", () => {
		const r = on();
		const s = r.scroller(400);
		s.scrollTop = 400;
		s.scrollTo(0, 400);
		r.child(s, 400).scrollIntoView();
		const o = r.other(900);
		o.scrollTop = 0;
		o.scrollTo(0, 100);
		r.child(o as never, 50).scrollIntoView();
		expect(scrollRows()).toHaveLength(0);
		expect(o.top, "the other element still moved").toBe(100);
	});

	it("a clamped write prints what was asked and where it landed", () => {
		const r = on();
		const s = r.scroller(100);
		s.scrollTop = -40.26;
		expect(scrollRows()[0]).toContain("scrollTop 100 -> 0 via scrollTop=-40.3");
	});

	it("the stack names the writer and its callers by function and origin only", () => {
		const r = on();
		const s = r.scroller(2000);
		function caretReveal() {
			s.scrollTop = 0;
		}
		function focusStandIn() {
			caretReveal();
		}
		focusStandIn();
		const stack = scrollRows()[0]!.split("stack: ")[1]!;
		expect(stack.startsWith("caretReveal (script) | focusStandIn (script)"), stack).toBe(true);
		expect(stack, "no path, line or column").not.toMatch(/[\\/]|:\d/);
	});

	it("recording stopped: every slot is the window's own again and a write reads no scrollTop", () => {
		const r = on();
		expect(writerSlots(r.El.prototype), "slots while recording").not.toEqual(r.own);
		scrollWriterTrace(false);
		expect(writerSlots(r.El.prototype), "slots after stop").toEqual(r.own);
		const s = r.scroller(900);
		r.reads.count = 0;
		s.scrollTop = 0;
		r.child(s, 10).scrollIntoView();
		expect(r.reads.count).toBe(0);
		expect(scrollRows()).toHaveLength(0);
	});

	it("switch off with the hook still in place: writes pass straight through and read nothing", () => {
		const r = on();
		setDiagnosticsEnabled(false);
		const s = r.scroller(900);
		r.reads.count = 0;
		s.scrollTop = 0;
		s.scrollTo(0, 50);
		expect(s.top).toBe(50);
		expect(r.reads.count).toBe(0);
		setDiagnosticsEnabled(true);
		expect(scrollRows()).toHaveLength(0);
	});

	it("a writer patched over ours keeps its place when recording stops, and ours under it only passes through", () => {
		const r = on();
		const ours = Object.getOwnPropertyDescriptor(r.El.prototype, "scrollTop")!;
		let theirs = 0;
		Object.defineProperty(r.El.prototype, "scrollTop", {
			...ours,
			set(this: unknown, v: number) {
				theirs++;
				ours.set!.call(this, v);
			},
		});
		const layered = Object.getOwnPropertyDescriptor(r.El.prototype, "scrollTop")!.set;
		scrollWriterTrace(false);
		expect(Object.getOwnPropertyDescriptor(r.El.prototype, "scrollTop")!.set, "their setter is not removed").toBe(layered);
		const s = r.scroller(600);
		r.reads.count = 0;
		s.scrollTop = 10;
		expect(theirs).toBe(1);
		expect(s.top).toBe(10);
		expect(r.reads.count, "ours reads nothing once stopped").toBe(0);
		expect(scrollRows()).toHaveLength(0);
	});

	it("the writer's own throw and return value reach the caller unchanged, recording or not", () => {
		const r = on();
		const s = r.scroller(300);
		const ret = r.El.prototype.scrollBy.call(s, 0, 10);
		expect(ret).toBeUndefined();
		expect(() => {
			(s as unknown as { scrollTop: unknown }).scrollTop = "x";
		}).toThrow(TypeError);
		expect(s.top).toBe(310);
		scrollWriterTrace(false);
		expect(() => {
			(s as unknown as { scrollTop: unknown }).scrollTop = "x";
		}).toThrow(TypeError);
		expect(scrollRows()).toHaveLength(1);
	});

	it("a window with no Element, or no window at all, is left alone", () => {
		setDiagnosticsEnabled(true);
		expect(() => scrollWriterTrace(true, {} as ScrollWriterWindow)).not.toThrow();
		expect(() => scrollWriterTrace(true, null)).not.toThrow();
		expect(() => scrollWriterTrace(true)).not.toThrow();
	});
});
