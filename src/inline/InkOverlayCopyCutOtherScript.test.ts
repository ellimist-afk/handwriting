/**
 * Ctrl/Cmd+C and +X on lassoed note ink under a keyboard layout that types another script.
 *
 * A Russian, Greek or Arabic layout reports its own letter in `event.key` ("с" on the C key under Russian) while
 * `event.code` still names the physical key ("KeyC"). The note's copy and cut keys read `event.key` alone, so the press
 * fell through to the editor: Ctrl+X cut the caret's text line and Ctrl+C copied it, while the lassoed ink stayed. The
 * PDF surface's rule is the want (PdfInkCopyCutOtherScript.test.ts): a Latin `event.key` decides, however the layout is
 * remapped, and the physical key decides only when `event.key` is not a Latin letter.
 *
 * The rig is a real InkOverlayPlugin over a headless CodeMirror state with history, mounted as
 * InlineStripSelectionRouting.test.ts mounts one, with its real copy and cut. Each keydown goes to the editor's own dom
 * event handler (`inlineEditorHandlers.keydown`, the object the editor extension is given at Prec.highest). "The editor
 * gets nothing" is read as the two things CodeMirror and the browser go by: the handler answers true, so CodeMirror's
 * keymap does not run, and the default is prevented, so no native cut or copy event reaches the editor. "The editor's"
 * is the opposite: not claimed and not prevented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { history, undoDepth } from "@codemirror/commands";
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

import { InkOverlayPlugin, inlineEditorHandlers, inlineInk } from "./InkOverlay";
import { clearInkClipboard, clipboardSize } from "./InkClipboard";
import { inkApplied, inkEffect, inkHistorySupport, type InkOp } from "./InkHistory";
import { setRoutineNoticesVisible } from "../diag/RoutineNotices";

/** The gesture path rebinds, which constructs observers Node does not have. */
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

const DOC = "first line\nsecond line";
const COPIED = "Handwriting: copied 1 stroke(s)";
const CUT = "Handwriting: cut 1 stroke(s)";

type Rig = {
	path: string;
	overlay: InkOverlayPlugin;
	state: () => EditorState;
	lasso(): void;
	press(key: string, code: string, mods?: { ctrl?: boolean; meta?: boolean; alt?: boolean }): { claimed: boolean; prevented: boolean };
};

describe("copy and cut of lassoed note ink under a layout whose letters are not Latin", () => {
	let live: InkOverlayPlugin[] = [];
	let serial = 0;

	beforeEach(() => {
		notices.said = [];
		live = [];
		clearInkClipboard();
		// The copied and cut counts are routine toasts; shown here so the cells can read which one the key gave.
		setRoutineNoticesVisible(true);
	});

	afterEach(() => {
		for (const o of live) (o as unknown as { destroy(): void }).destroy();
		clearInkClipboard();
		setRoutineNoticesVisible(false);
	});

	/**
	 * A real overlay on a note holding one stroke, s1, with the caret in the text (`selection` a caret at 3 unless the
	 * cell sweeps a range). `mount()` bails on an undefined `editorInfoField` at construction, so the fields it would
	 * have set are supplied by hand afterward, as InlineStripSelectionRouting.test.ts does.
	 */
	function rig(selection: EditorSelection = EditorSelection.single(3)): Rig {
		const path = `other-script-${++serial}.md`;
		inlineInk.applyAdd(path, [stroke("s1")]);
		let mounted = false;
		const noop = (): void => undefined;
		const dom = {
			parentElement: { setCssStyles: noop },
			ownerDocument: {
				defaultView: { getComputedStyle: () => ({ position: "relative" }), cancelAnimationFrame: noop },
			},
			style: { removeProperty: noop },
			setCssStyles: noop,
			contains: () => true,
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
		const o = new InkOverlayPlugin(view as never) as unknown as Record<string, unknown>;
		mounted = true;
		o.container = { nodeType: 1, remove: noop };
		o.mobileTools = null;
		o.applyToolbarCorner = noop;
		o.filePath = () => path;
		o.redrawSelectionUI = noop;
		o.scheduleRepaint = noop;
		o.repaintPath = noop;
		// A real editor state and history: the caret or swept range the copy and cut keys test, and the history a cut
		// lands in.
		let cm = EditorState.create({ doc: DOC, selection, extensions: [history(), inkHistorySupport()] });
		view.state = cm;
		view.dispatch = (trOrSpec: unknown) => {
			const tr = trOrSpec instanceof Transaction ? trOrSpec : cm.update(trOrSpec as never);
			cm = tr.state;
			view.state = cm;
			if (!tr.annotation(inkApplied)) {
				for (const effect of tr.effects) {
					if (effect.is(inkEffect)) (o as unknown as { applyInkOp(op: InkOp): void }).applyInkOp(effect.value as InkOp);
				}
			}
		};
		const overlay = o as unknown as InkOverlayPlugin;
		live.push(overlay);
		const editorView = { plugin: () => overlay } as never;
		return {
			path,
			overlay,
			state: () => cm,
			lasso() {
				(o.selection as { selectExactly(ids: string[]): void }).selectExactly(["s1"]);
			},
			press(key, code, mods = {}) {
				let prevented = false;
				const ev = {
					key,
					code,
					ctrlKey: mods.ctrl ?? false,
					metaKey: mods.meta ?? false,
					altKey: mods.alt ?? false,
					shiftKey: false,
					repeat: false,
					defaultPrevented: false,
					target: null,
					preventDefault() {
						prevented = true;
						ev.defaultPrevented = true;
					},
					stopPropagation() {},
				};
				const claimed = inlineEditorHandlers.keydown!(ev as unknown as KeyboardEvent, editorView) === true;
				inlineEditorHandlers.keyup!({ ...ev, preventDefault: noop } as unknown as KeyboardEvent, editorView);
				return { claimed, prevented };
			},
		};
	}

	const ink = (r: Rig): string[] => inlineInk.strokes(r.path).map((s) => s.id);
	const ours = { claimed: true, prevented: true };
	const editors = { claimed: false, prevented: false };

	it("Ctrl+C with a Russian layout letter on the C key copies the lassoed ink and the editor gets nothing", () => {
		const r = rig();
		r.lasso();

		expect(r.press("с", "KeyC", { ctrl: true }), "the key went to the editor, which copies the caret's line").toEqual(ours);
		expect(clipboardSize(), "nothing was copied").toBe(1);
		expect(notices.said).toEqual([COPIED]);
		expect(ink(r), "a copy removed ink").toEqual(["s1"]);
	});

	it("Ctrl+X with a Russian layout letter on the X key cuts the lassoed ink and the editor gets nothing", () => {
		const r = rig();
		r.lasso();

		expect(r.press("ч", "KeyX", { ctrl: true }), "the key went to the editor, which cuts the caret's line").toEqual(ours);
		expect(clipboardSize(), "nothing was cut to the clipboard").toBe(1);
		expect(notices.said).toEqual([CUT]);
		expect(ink(r), "the lassoed ink stayed").toEqual([]);
		expect(undoDepth(r.state()), "the cut is one history step").toBe(1);
	});

	it("Cmd+C with a Greek layout letter and Cmd+X with an Arabic one act on the lasso, as on macOS", () => {
		const r = rig();
		r.lasso();

		expect(r.press("ψ", "KeyC", { meta: true }), "Cmd+C under Greek went to the editor").toEqual(ours);
		expect(clipboardSize(), "Cmd+C under Greek copied nothing").toBe(1);
		expect(notices.said).toEqual([COPIED]);
		expect(r.press("ء", "KeyX", { meta: true }), "Cmd+X under Arabic went to the editor").toEqual(ours);
		expect(notices.said, "Cmd+X under Arabic cut nothing").toEqual([COPIED, CUT]);
		expect(ink(r)).toEqual([]);
	});

	it("pin: a Latin layout that moves C and X keeps what the key types (Dvorak, AZERTY)", () => {
		const r = rig();
		r.lasso();

		// Dvorak: the key that types C sits where QWERTY has I, and the QWERTY C key types J.
		expect(r.press("j", "KeyC", { ctrl: true }), "Dvorak J on the QWERTY C key was taken as copy").toEqual(editors);
		expect(clipboardSize()).toBe(0);
		expect(r.press("c", "KeyI", { ctrl: true }), "Dvorak C was not taken as copy").toEqual(ours);
		expect(notices.said).toEqual([COPIED]);
		// Dvorak: X sits where QWERTY has B, and the QWERTY X key types Q.
		expect(r.press("q", "KeyX", { ctrl: true }), "Dvorak Q on the QWERTY X key was taken as cut").toEqual(editors);
		expect(ink(r)).toEqual(["s1"]);
		// AZERTY keeps C and X where QWERTY has them.
		expect(r.press("x", "KeyX", { ctrl: true }), "AZERTY X was not taken as cut").toEqual(ours);
		expect(notices.said).toEqual([COPIED, CUT]);
		expect(ink(r)).toEqual([]);
	});

	it("pin: with no ink lassoed, a Russian layout's Ctrl+C and Ctrl+X are the editor's", () => {
		const r = rig();

		expect(r.press("с", "KeyC", { ctrl: true }), "with nothing lassoed Ctrl+C was taken").toEqual(editors);
		expect(r.press("ч", "KeyX", { ctrl: true }), "with nothing lassoed Ctrl+X was taken").toEqual(editors);
		expect(clipboardSize()).toBe(0);
		expect(notices.said).toEqual([]);
		expect(ink(r)).toEqual(["s1"]);
	});

	it("pin: with text swept in the editor, a Russian layout's Ctrl+C and Ctrl+X are the editor's and the lasso is kept", () => {
		const r = rig(EditorSelection.single(0, 5));
		r.lasso();

		expect(r.press("с", "KeyC", { ctrl: true }), "a text range's Ctrl+C was taken by the lasso").toEqual(editors);
		expect(r.press("ч", "KeyX", { ctrl: true }), "a text range's Ctrl+X was taken by the lasso").toEqual(editors);
		expect(clipboardSize()).toBe(0);
		expect(notices.said).toEqual([]);
		expect(ink(r)).toEqual(["s1"]);
	});

	it("pin: Ctrl+Alt under a Russian layout is AltGr on Windows, and stays the editor's", () => {
		const r = rig();
		r.lasso();

		expect(r.press("с", "KeyC", { ctrl: true, alt: true }), "Ctrl+Alt was taken as copy").toEqual(editors);
		expect(r.press("ч", "KeyX", { ctrl: true, alt: true }), "Ctrl+Alt was taken as cut").toEqual(editors);
		expect(clipboardSize()).toBe(0);
		expect(notices.said).toEqual([]);
		expect(ink(r)).toEqual(["s1"]);
	});
});
