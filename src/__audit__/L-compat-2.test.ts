/**
 * AUDIT PROBE L-compat-2 (1.4.21, tag 1a05f62c). Read-only audit; not part of the product suite.
 *
 * Claim: publishInkMarker (InkOverlay.ts :866-876) writes the paste marker through the bare global
 * `navigator.clipboard`, which is the MAIN window's Clipboard. A popout editor's keydown/copy runs in
 * the main realm, so the write goes to the main window's clipboard even while the popout has focus.
 * Chromium rejects async clipboard writes whose own document is not focused, so in a popout the
 * marker never reaches the system clipboard; Ctrl+V then finds no marker and handlePaste returns false.
 *
 * What this probe runs for real: InkOverlayPlugin (constructed as InlineStripSelectionRouting.test.ts
 * does), its real handleKeyDown Ctrl+C branch, real copySelectedInk -> copyInk -> publishInkMarker, and
 * the real handlePaste. What it SIMULATES: two windows, each with its own Clipboard object whose
 * writeText follows Chromium's rule (reject NotAllowedError "Document is not focused." unless that
 * window's own document has focus), sharing one system clipboard string. The popout has focus.
 *
 * Correct behaviour asserted: after Ctrl+C on lassoed ink in a focused popout editor, the system
 * clipboard carries the ink marker and a Ctrl+V paste event is recognised as ink (handlePaste true).
 * A control cell (main-window editor, main focused) proves the rig passes when the right Clipboard is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import type { InkStroke } from "../ink/Stroke";

const notices = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class Notice {
		constructor(message: string) {
			notices.said.push(message);
		}
	}
	return { ...actual, Notice };
});

import { InkOverlayPlugin, inlineInk } from "../inline/InkOverlay";
import { markerToken } from "../inline/InkClipboard";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

function stroke(id: string): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x: 10, y: 10, pressure: 0.5, t: 0 },
			{ x: 20, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: 8, y: 8, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

/** One system clipboard, shared by every window (as the OS clipboard is). */
const system = { text: "stale text the user copied earlier" };
const writes: Array<{ window: string; ok: boolean; text: string }> = [];

type FakeWin = {
	name: string;
	document: { hasFocus(): boolean };
	navigator: { clipboard: { writeText(t: string): Promise<void> } };
	getComputedStyle: () => { position: string };
	cancelAnimationFrame: () => void;
	requestAnimationFrame: () => number;
	setTimeout: typeof setTimeout;
	clearTimeout: typeof clearTimeout;
	devicePixelRatio: number;
};

/** A window whose Clipboard follows Chromium's focus rule for ITS OWN document. */
function makeWin(name: string, focus: { focused: string }): FakeWin {
	const document = { hasFocus: () => focus.focused === name };
	return {
		name,
		document,
		navigator: {
			clipboard: {
				writeText(t: string): Promise<void> {
					if (!document.hasFocus()) {
						writes.push({ window: name, ok: false, text: t });
						return Promise.reject(new DOMException("Document is not focused.", "NotAllowedError"));
					}
					writes.push({ window: name, ok: true, text: t });
					system.text = t;
					return Promise.resolve();
				},
			},
		},
		getComputedStyle: () => ({ position: "relative" }),
		cancelAnimationFrame: () => undefined,
		requestAnimationFrame: () => 0,
		setTimeout,
		clearTimeout,
		devicePixelRatio: 1,
	};
}

function mountOverlay(path: string, win: FakeWin): InkOverlayPlugin {
	let mounted = false;
	const noop = (): void => undefined;
	const dom = {
		parentElement: { setCssStyles: noop },
		ownerDocument: { defaultView: win },
		style: { removeProperty: noop },
		setCssStyles: noop,
		contains: () => false,
	};
	const view: Record<string, unknown> = {
		dom,
		scrollDOM: {
			removeEventListener: noop,
			addEventListener: noop,
			classList: { add: noop, remove: noop },
			setCssStyles: noop,
			style: { removeProperty: noop },
			scrollLeft: 0,
			scrollTop: 0,
		},
		state: { field: () => (mounted ? { app: { commands: { executeCommandById: noop } } } : undefined) },
	};
	const overlay = new InkOverlayPlugin(view as never) as unknown as Record<string, unknown>;
	mounted = true;
	overlay.container = { nodeType: 1, remove: noop };
	overlay.mobileTools = null;
	overlay.applyToolbarCorner = noop;
	overlay.filePath = () => path;
	overlay.redrawSelectionUI = noop;
	overlay.scheduleRepaint = noop;
	overlay.repaintPath = noop;
	// Real, empty editor selection: the Ctrl+C branch requires it.
	view.state = EditorState.create({ doc: "" });
	return overlay as unknown as InkOverlayPlugin;
}

function ctrlC(): KeyboardEvent & { prevented: boolean } {
	const ev = {
		key: "c",
		ctrlKey: true,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		defaultPrevented: false,
		target: null,
		prevented: false,
		preventDefault() {
			ev.prevented = true;
			ev.defaultPrevented = true;
		},
		stopPropagation() {},
	};
	return ev as unknown as KeyboardEvent & { prevented: boolean };
}

/** Ctrl+V: the paste event carries whatever the system clipboard holds. */
function pasteEvent(): ClipboardEvent {
	const text = system.text;
	return {
		clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") },
		preventDefault() {},
		stopPropagation() {},
	} as unknown as ClipboardEvent;
}

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("L-compat-2: ink copy marker in a popout window", () => {
	const focus = { focused: "main" };
	const mainWin = makeWin("main", focus);
	let live: InkOverlayPlugin[] = [];

	beforeEach(() => {
		notices.said = [];
		writes.length = 0;
		system.text = "stale text the user copied earlier";
		live = [];
		// The plugin's realm is the main window: its bare `navigator` is the main window's navigator.
		vi.stubGlobal("navigator", mainWin.navigator);
	});

	afterEach(() => {
		for (const o of live) {
			try {
				(o as unknown as { destroy(): void }).destroy();
			} catch {
				/* rig teardown only */
			}
		}
		vi.unstubAllGlobals();
	});

	function selectAndCopy(overlay: InkOverlayPlugin, id: string): { handled: boolean; prevented: boolean } {
		(overlay as unknown as { selection: { selectExactly(ids: string[]): void } }).selection.selectExactly([id]);
		const ev = ctrlC();
		const handled = overlay.handleKeyDown(ev);
		return { handled, prevented: ev.prevented };
	}

	it("control: main-window editor with the main window focused - marker lands, Ctrl+V pastes ink", async () => {
		focus.focused = "main";
		const path = "lc2-main.md";
		inlineInk.applyAdd(path, [stroke("m1")]);
		const o = mountOverlay(path, mainWin);
		live.push(o);
		(o as unknown as { pasteInkHere(): number }).pasteInkHere = () => 1;

		const r = selectAndCopy(o, "m1");
		await flush();
		expect(r.handled, "Ctrl+C branch taken").toBe(true);
		expect(r.prevented, "native copy suppressed").toBe(true);
		expect(markerToken(system.text), "marker on the system clipboard").not.toBeNull();
		expect(o.handlePaste(pasteEvent()), "Ctrl+V recognised as ink").toBe(true);
	});

	it("popout editor with the popout focused - marker lands, Ctrl+V pastes ink", async () => {
		focus.focused = "popout";
		const popoutWin = makeWin("popout", focus);
		const path = "lc2-popout.md";
		inlineInk.applyAdd(path, [stroke("p1")]);
		const o = mountOverlay(path, popoutWin);
		live.push(o);
		(o as unknown as { pasteInkHere(): number }).pasteInkHere = () => 1;

		// Preconditions: the editor lives in the popout, the popout has focus, the main window does not.
		expect((o as unknown as { winRef: FakeWin }).winRef, "editor's own window is the popout").toBe(popoutWin);
		expect(popoutWin.document.hasFocus()).toBe(true);
		expect(mainWin.document.hasFocus()).toBe(false);

		const r = selectAndCopy(o, "p1");
		await flush();
		expect(r.handled, "Ctrl+C branch taken").toBe(true);
		expect(r.prevented, "native copy suppressed (system clipboard only changes via the marker write)").toBe(true);
		expect(notices.said.some((s) => /copied 1 stroke/.test(s)) || notices.said.length === 0).toBe(true);

		// Correct behaviour: the marker reached the system clipboard.
		expect.soft(
			markerToken(system.text),
			`marker missing from system clipboard; writes=${JSON.stringify(writes)}; clipboard="${system.text}"`,
		).not.toBeNull();
		expect.soft(o.handlePaste(pasteEvent()), `Ctrl+V recognised as ink (clipboard="${system.text}")`).toBe(true);
	});
});
