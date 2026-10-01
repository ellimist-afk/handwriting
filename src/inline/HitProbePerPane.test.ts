/**
 * Audit 176: the pointer hit probe kept one context slot for the whole app. Every overlay mount overwrote it and
 * every unmount cleared it, so a report showed another pane's note coordinates, showed none after any other
 * editor closed, and in a popout listened on and read element stacks from the main window only.
 *
 * Rig: the real PenHitProbe module over fake panes. A pane is a root element with its own document and window;
 * each overlay registers a context provider for its own root (setHitProbeContext(provider, root)) and removes
 * only its own (setHitProbeContext(null, root)). A provider answers noteX 111 for pane A and 222 for pane B, so
 * the report line "note(111," names the pane whose context was used. The main window and document are stubbed
 * globals that record what is asked of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearHitProbe,
	formatHitReport,
	hitProbeDown,
	setHitProbeContext,
	setHitProbeEnabled,
	type HitProbeContext,
} from "./PenHitProbe";

type Listener = (e: Event) => void;

function fakeWindow() {
	const listeners: Array<{ type: string; fn: Listener }> = [];
	return {
		listeners,
		addEventListener: (type: string, fn: Listener) => void listeners.push({ type, fn }),
		removeEventListener: (type: string, fn: Listener) => {
			const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
			if (i >= 0) listeners.splice(i, 1);
		},
		getComputedStyle: () => ({ pointerEvents: "auto", touchAction: "none", zIndex: "0", position: "static", overflowX: "visible", overflowY: "visible" }),
	};
}

function fakeDocument(win: ReturnType<typeof fakeWindow>, topClass: string) {
	const top = { tagName: "DIV", id: "", className: topClass, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }) };
	return { defaultView: win, elementFromPoint: () => top, elementsFromPoint: () => [top] };
}

/** A pane: root, a target inside it, its own document and window. */
function pane(topClass: string, win = fakeWindow()) {
	const doc = fakeDocument(win, topClass);
	const target: Record<string, unknown> = { tagName: "DIV", id: "", className: "cm-scroller", ownerDocument: doc };
	const root = { ownerDocument: doc, contains: (n: unknown) => n === target || n === root };
	return { root: root as unknown as Element, target, doc, win };
}

const ctx = (noteX: number): HitProbeContext => ({ noteX, noteY: 5, scrollLeft: 0, scrollTop: 0, grantedX: 1000, grantedY: 1000, scale: 1 });
const provider = (noteX: number) => () => ctx(noteX);

function down(p: ReturnType<typeof pane>): void {
	const e = { pointerType: "pen", pointerId: 1, clientX: 10, clientY: 10, target: p.target, composedPath: () => [p.target] };
	hitProbeDown(e as unknown as PointerEvent, true, p.target as unknown as Element);
}

const register = setHitProbeContext as unknown as (fn: (() => HitProbeContext) | null, root: Element) => void;

let mainWindow: ReturnType<typeof fakeWindow>;

beforeEach(() => {
	mainWindow = fakeWindow();
	vi.stubGlobal("window", mainWindow);
	vi.stubGlobal("document", fakeDocument(mainWindow, "main-window-element"));
	vi.stubGlobal("getComputedStyle", mainWindow.getComputedStyle);
	clearHitProbe();
	setHitProbeEnabled(true);
});
afterEach(() => {
	setHitProbeEnabled(false);
	vi.unstubAllGlobals();
});

describe("audit 176: the pointer hit probe reads each pane's own context", () => {
	it("two panes: a pen down in the first pane reports the first pane's note point, not the pane mounted last", () => {
		const a = pane("pane-a");
		const b = pane("pane-b");
		register(provider(111), a.root);
		register(provider(222), b.root);
		down(a);
		expect(formatHitReport()).toContain("note(111,");
		// And the other way round: a provider that answered for every pane would pass the line above alone.
		down(b);
		expect(formatHitReport()).toContain("note(222,");
		register(null, a.root);
		register(null, b.root);
	});

	it("another pane closing leaves this pane's context in place", () => {
		const a = pane("pane-a");
		const b = pane("pane-b");
		register(provider(111), a.root);
		register(provider(222), b.root);
		register(null, b.root); // pane B's overlay unmounts
		down(a);
		expect(formatHitReport()).toContain("note(111,");
		register(null, a.root);
	});

	it("a popout: the probe listens on the popout's window and reads the stack from the popout's document", () => {
		const popout = pane("popout-element");
		register(provider(333), popout.root);
		setHitProbeEnabled(false);
		setHitProbeEnabled(true);
		expect(popout.win.listeners.map((l) => l.type), "the popout window gets the capture listener").toContain("pointerdown");
		down(popout);
		const report = formatHitReport();
		expect(report, "the stack is the popout document's").toContain("top: div.popout-element");
		expect(report).toContain("note(333,");
		register(null, popout.root);
	});
});
