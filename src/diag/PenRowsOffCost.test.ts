import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endRecordingForReport, setDiagnosticsEnabled } from "./DiagSwitch";
import { clearInlinePenTrace, formatInlinePenTrace } from "../inline/InlinePenRouterTrace";
import { stopMainThreadProbe } from "../inline/ScrollProbe";
import { holdKeyboardForEveryPen } from "../inline/InlineFocus";
import { mountOverlay, type MountedOverlay } from "../inline/mountRig.test.util";
import { noteCameras } from "../inline/NoteCamera";
import { resetTipModeForTest } from "../inline/TipMode";

/** Issue 66 pen-trace rows with recording off: no row, no layout read, no listener and no timer, and none left behind. */
const HAND_TYPES = ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "keydown"];
const NEW_ROWS = /ms {2}(note-open|camera-restore|scroll-jump|page-id-write|ink-reload|ink-dropped) /;

/** A window that counts the hand-input listeners on it, by type. */
function countingWindow() {
	const live = new Map<string, number>();
	const target = new EventTarget();
	const win = Object.assign(target, {
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
		clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		devicePixelRatio: 1,
	});
	const add = target.addEventListener.bind(target);
	const remove = target.removeEventListener.bind(target);
	win.addEventListener = ((type: string, fn: never, opts?: never) => {
		if (HAND_TYPES.includes(type)) live.set(type, (live.get(type) ?? 0) + 1);
		add(type, fn, opts);
	}) as never;
	win.removeEventListener = ((type: string, fn: never, opts?: never) => {
		if (HAND_TYPES.includes(type)) live.set(type, (live.get(type) ?? 0) - 1);
		remove(type, fn, opts);
	}) as never;
	// The pen mirror's own pointerdown and pointercancel listeners are there from the router's start, recording or not.
	const baseline = () => new Map(live);
	const added = (since: Map<string, number>) => HAND_TYPES.reduce((n, t) => n + (live.get(t) ?? 0) - (since.get(t) ?? 0), 0);
	return { win, baseline, added };
}

let m: MountedOverlay;
let w: ReturnType<typeof countingWindow>;
let heightReads = 0;
let focusReads = 0;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	resetTipModeForTest();
	setDiagnosticsEnabled(false);
	w = countingWindow();
	vi.stubGlobal("window", w.win);
	noteCameras.clear();
	m = mountOverlay("pen66/off.md");
	heightReads = 0;
	focusReads = 0;
	Object.defineProperty(m.scrollDOM, "scrollHeight", {
		configurable: true,
		get: () => {
			heightReads++;
			return 48000;
		},
	});
	const view = m.o.view as Record<string, unknown>;
	Object.defineProperty(view, "hasFocus", {
		configurable: true,
		get: () => {
			focusReads++;
			return true;
		},
	});
	view.requestMeasure = (spec: { write?: () => void }) => spec.write?.();
});
afterEach(() => {
	setDiagnosticsEnabled(false);
	clearInlinePenTrace();
	m.destroy();
	noteCameras.clear();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	resetTipModeForTest();
});

describe("issue 66 pen-trace rows cost nothing with recording off", () => {
	it("scroll events read no scrollHeight with recording off, and do with it on", () => {
		const scroll = (top: number) => {
			m.scrollDOM.scrollTop = top;
			(m.o.scrollFn as () => void)();
		};
		scroll(100);
		scroll(900);
		(m.o.wheelFn as (e: unknown) => void)({ deltaX: 0, deltaY: 10, deltaMode: 0, ctrlKey: false });
		expect(heightReads, "scrollHeight reads with recording off").toBe(0);
		setDiagnosticsEnabled(true);
		scroll(1000);
		expect(heightReads, "scrollHeight reads with recording on").toBeGreaterThan(0);
	});

	it("a note switch reads no editor focus with recording off, and does with it on", () => {
		const switchTo = (path: string) => {
			const view = m.o.view as { state: Record<string, unknown> };
			const info = { file: { path }, editor: {} };
			view.state = { ...view.state, field: () => info };
			(m.o as { update(u: unknown): void }).update({ transactions: [], docChanged: false, geometryChanged: false, viewportChanged: false });
		};
		switchTo("pen66/off-2.md");
		expect(focusReads, "focus reads by a switch with recording off").toBe(0);
		setDiagnosticsEnabled(true);
		switchTo("pen66/off-3.md");
		expect(focusReads, "focus reads by a switch with recording on").toBeGreaterThan(0);
	});

	it("no hand-input listener exists while recording is off, and none is left after stop, a report or the plugin's unload", () => {
		const before = w.baseline();
		expect(w.added(before), "listeners before any recording").toBe(0);
		setDiagnosticsEnabled(true);
		expect(w.added(before), "listeners while recording").toBeGreaterThanOrEqual(HAND_TYPES.length);
		setDiagnosticsEnabled(false);
		expect(w.added(before), "after the command stops recording").toBe(0);
		setDiagnosticsEnabled(true);
		expect(endRecordingForReport()).toBe(true);
		expect(w.added(before), "after a report").toBe(0);
		setDiagnosticsEnabled(true);
		stopMainThreadProbe();
		expect(w.added(before), "after the plugin's unload").toBe(0);
		(m.o.scrollFn as () => void)();
		expect(w.added(before), "a scroll after unload, switch still on, attaches nothing").toBe(0);
	});

	it("a pen-down with recording off asks for no frame and no timer, and no new row is ever written", () => {
		const frames = vi.fn(() => 0);
		const timers = vi.fn(() => 0);
		const content = Object.assign(new EventTarget(), {
			getAttribute: () => null,
			setAttribute: () => {},
			removeAttribute: () => {},
			ownerDocument: { activeElement: null, defaultView: { requestAnimationFrame: frames, setTimeout: timers, clearTimeout: () => {} } },
		});
		const root = new EventTarget();
		const release = holdKeyboardForEveryPen({ hasFocus: false, contentDOM: content as never, dom: root as never, scrollDOM: { scrollTop: 5 } as never }, () => null);
		root.dispatchEvent(Object.assign(new Event("pointerdown"), { pointerType: "pen" }));
		content.dispatchEvent(new Event("focusin"));
		vi.advanceTimersByTime(1000);
		expect(frames).not.toHaveBeenCalled();
		expect(timers).not.toHaveBeenCalled();
		release();
		setDiagnosticsEnabled(true);
		expect(formatInlinePenTrace().split("\n").filter((l) => NEW_ROWS.test(l)), "new rows from the off-recording work").toHaveLength(0);
	});
});
