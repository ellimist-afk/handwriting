import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDiagnosticsEnabled } from "./DiagSwitch";
import { clearInlinePenTrace, formatInlinePenTrace } from "../inline/InlinePenRouterTrace";
import { mountOverlay, RigEl, type MountedOverlay } from "../inline/mountRig.test.util";
import { noteCameras } from "../inline/NoteCamera";
import { resetTipModeForTest } from "../inline/TipMode";

/** Issue 66 row: the note scroller moving with no hand scroll behind it, or by a big step during one. */
type Scroller = RigEl & { _top?: number };

const own = Object.getOwnPropertyDescriptor(RigEl.prototype, "scrollTop");
let win: EventTarget;
let m: MountedOverlay;
let s: Scroller;

/** A window the hand-input listeners attach to; its Element is the rig's, so the scroll-write hook can patch scrollTop. */
function fakeWindow(): EventTarget {
	return Object.assign(new EventTarget(), {
		Element: RigEl,
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
		clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		devicePixelRatio: 1,
	});
}

/** The scroller's scrollTop as a prototype accessor, as a browser's is, so script writes go through the hook. */
function accessorTop(el: Scroller): void {
	const top = el.scrollTop;
	delete (el as { scrollTop?: number }).scrollTop;
	el._top = top;
}

/** A move the browser made on its own: no script writer saw it. */
function nativeMove(top: number): void {
	s._top = top;
}

/** The overlay's own scroll listener, run for the scroller where it is now. */
function scrollEvent(): void {
	(m.o.scrollFn as () => void)();
}

function moveAndScroll(top: number): void {
	nativeMove(top);
	scrollEvent();
}

function input(type: string, fields: Record<string, unknown>, target: unknown): void {
	const ev = Object.assign(new Event(type), fields);
	Object.defineProperty(ev, "target", { value: target });
	win.dispatchEvent(ev);
}

const content = () => m.contentDOM;
const rows = () =>
	formatInlinePenTrace()
		.split("\n")
		.filter((line) => /ms {2}scroll-jump /.test(line));

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
	resetTipModeForTest();
	Object.defineProperty(RigEl.prototype, "scrollTop", {
		configurable: true,
		get(this: Scroller) {
			return this._top ?? 0;
		},
		set(this: Scroller, v: number) {
			this._top = Math.max(0, Number(v));
		},
	});
	win = fakeWindow();
	vi.stubGlobal("window", win);
	noteCameras.clear();
	m = mountOverlay("pen66/jump.md");
	s = m.scrollDOM as Scroller;
	accessorTop(s);
	s.scrollHeight = 48000;
	setDiagnosticsEnabled(true);
	clearInlinePenTrace();
	moveAndScroll(1000);
});
afterEach(() => {
	setDiagnosticsEnabled(false);
	clearInlinePenTrace();
	m.destroy();
	noteCameras.clear();
	if (own) Object.defineProperty(RigEl.prototype, "scrollTop", own);
	else delete (RigEl.prototype as { scrollTop?: number }).scrollTop;
	vi.unstubAllGlobals();
	vi.useRealTimers();
	resetTipModeForTest();
});

describe("issue 66 scroll-jump row", () => {
	it("no hand scroll and no script write: a move of any size writes one row with from, to and both heights", () => {
		s.scrollHeight = 48100;
		moveAndScroll(1001);
		const got = rows();
		expect(got, "rows for a 1 px move nobody asked for").toHaveLength(1);
		expect(got[0]).toContain("no hand scroll: scrollTop 1000 -> 1001 (+1) in one scroll event");
		expect(got[0]).toContain("scrollHeight at last scroll=48000 now=48100");
		expect(got[0]).toContain("scroll-write with it=no");
		expect(got[0]).toContain("ms since wheel=never touch=never key=never scrollbar=never");
		expect(got[0]).toContain("during stroke=no");
	});

	it("the first scroll event of a recording only takes the scroller's place, and so does the first after a new recording", () => {
		expect(rows(), "the seed in beforeEach").toHaveLength(0);
		setDiagnosticsEnabled(false);
		setDiagnosticsEnabled(true);
		clearInlinePenTrace();
		moveAndScroll(5000);
		expect(rows()).toHaveLength(0);
		moveAndScroll(4990);
		expect(rows()).toEqual([expect.stringContaining("scrollTop 5000 -> 4990 (-10)")]);
	});

	it("a wheel opens the 150 ms window: a small step writes nothing, 200 px or more writes a hand-scroll row naming the wheel", () => {
		const wheel = () => (m.o.wheelFn as (e: unknown) => void)({ deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false });
		wheel();
		moveAndScroll(1120);
		expect(rows(), "a 120 px wheel step").toHaveLength(0);
		vi.advanceTimersByTime(40);
		wheel();
		moveAndScroll(1380);
		const got = rows();
		expect(got).toHaveLength(1);
		expect(got[0]).toContain("hand scroll: scrollTop 1120 -> 1380 (+260)");
		expect(got[0]).toContain("ms since wheel=0ms touch=never");
		expect(got[0]).toContain("last input=wheel 0ms ago");
		vi.advanceTimersByTime(200);
		moveAndScroll(1385);
		expect(rows()[1], "the window closed").toContain("no hand scroll: scrollTop 1380 -> 1385 (+5)");
	});

	it("a finger's touch move and a key each open the window on their own scroller", () => {
		input("touchmove", { changedTouches: [{ touchType: "direct" }] }, content());
		moveAndScroll(1050);
		input("keydown", { key: "PageDown" }, content());
		vi.advanceTimersByTime(100);
		moveAndScroll(1100);
		expect(rows(), "steps under the window").toHaveLength(0);
		vi.advanceTimersByTime(151);
		moveAndScroll(1150);
		const got = rows();
		expect(got).toHaveLength(1);
		expect(got[0]).toContain("no hand scroll: scrollTop 1100 -> 1150 (+50)");
		expect(got[0]).toMatch(/touch=251ms key=251ms/);
		expect(got[0]).toContain("last input=key 251ms ago");
	});

	it("a scrollbar drag counts as a hand scroll for as long as it is held, then the window closes", () => {
		input("pointerdown", { pointerType: "mouse", buttons: 1, offsetX: 805, offsetY: 40 }, s);
		vi.advanceTimersByTime(1000);
		moveAndScroll(1150);
		expect(rows(), "a move while the bar is held").toHaveLength(0);
		input("pointerup", { pointerType: "mouse", buttons: 0 }, s);
		vi.advanceTimersByTime(200);
		moveAndScroll(1160);
		const got = rows();
		expect(got).toHaveLength(1);
		expect(got[0]).toContain("no hand scroll: scrollTop 1150 -> 1160 (+10)");
		expect(got[0]).toContain("scrollbar=200ms");
		expect(got[0]).toContain("last input=scrollbar 200ms ago");
	});

	it("a mouse press in the text is not a scrollbar drag", () => {
		input("pointerdown", { pointerType: "mouse", buttons: 1, offsetX: 300, offsetY: 40 }, content());
		moveAndScroll(1030);
		expect(rows()).toEqual([expect.stringContaining("no hand scroll: scrollTop 1000 -> 1030 (+30)")]);
		expect(rows()[0]).toContain("last input=mouse 0ms ago");
	});

	it("a pen tap opens no window, its touch events included: the row names the pen as the last input", () => {
		input("pointerdown", { pointerType: "pen", buttons: 1 }, content());
		input("touchstart", { changedTouches: [{ touchType: "stylus" }] }, content());
		input("touchmove", { changedTouches: [{ touchType: "direct" }] }, content());
		input("pointerup", { pointerType: "pen", buttons: 0 }, content());
		vi.advanceTimersByTime(20);
		moveAndScroll(700);
		const got = rows();
		expect(got).toHaveLength(1);
		expect(got[0]).toContain("no hand scroll: scrollTop 1000 -> 700 (-300)");
		expect(got[0]).toContain("touch=never");
		expect(got[0]).toContain("last input=pen 20ms ago");
	});

	it("a script write that put the scroller where the scroll event finds it writes no row; one that landed elsewhere does", () => {
		s.scrollTop = 400;
		scrollEvent();
		expect(rows(), "an explained move").toHaveLength(0);
		s.scrollTop = 600;
		moveAndScroll(800);
		expect(rows()).toEqual([expect.stringContaining("no hand scroll: scrollTop 400 -> 800 (+400)")]);
		expect(rows()[0]).toContain("scroll-write with it=yes, to 600");
		moveAndScroll(810);
		expect(rows()[1], "the write is spent at its scroll event").toContain("scroll-write with it=no");
	});

	it("a glide's small steps are capped per second and the count skipped is printed; a big jump inside the cap still writes", () => {
		for (let i = 1; i <= 12; i++) moveAndScroll(1000 + i * 5);
		expect(rows(), "small rows in one second").toHaveLength(8);
		moveAndScroll(1460);
		const got = rows();
		expect(got).toHaveLength(9);
		expect(got[8]).toContain("no hand scroll: scrollTop 1060 -> 1460 (+400)");
		expect(got[8]).toContain("4 small rows skipped by the cap before this");
		vi.advanceTimersByTime(1000);
		moveAndScroll(1463);
		expect(rows()).toHaveLength(10);
		expect(rows()[9]).not.toContain("skipped");
	});
});
