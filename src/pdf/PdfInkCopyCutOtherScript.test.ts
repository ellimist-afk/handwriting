/**
 * Ctrl/Cmd+C and +X on lassoed PDF ink under a keyboard layout that types another script.
 *
 * A Russian, Greek or Arabic layout reports its own letter in `ev.key` ("с" on the C key under Russian) while
 * `ev.code` still names the physical key ("KeyC"). Undo and redo already take the physical key in that case and only
 * then; copy and cut read `ev.key` alone, so the press fell through, nothing was copied or cut, and the next Ctrl+V
 * pasted whatever was copied before. The same key rule as undo is the want: a Latin `ev.key` decides, however the
 * layout is remapped, and the physical key decides only when `ev.key` is not a Latin letter.
 *
 * The harness is the keyboard block's in PdfInkController.test.ts: a real controller over a one-page probe, s1
 * selected through the real lasso path, a keydown handed to handleKeyDown, and "consumed" read as preventDefault.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { clearInkClipboard, clipboardSize } from "../inline/InkClipboard";
import { clearToolPicked, setMouseInk } from "../inline/MouseInk";

/** The gesture path reaches sync, which constructs observers; Node has neither. */
class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({
	probeViewer: () => probe.current,
	viewerCanvasOf: () => null,
	wholePageCanvasOf: () => null,
}));

import { PdfInkController } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";

/** css px per point, as `--scale-factor` reports it. */
const SCALE = 2;

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

/** A short stroke around page point (100,100) - content px (200,200). */
function inkAt(id: string): InkStroke {
	const points = [100, 105, 110].map((v, i) => ({ x: v, y: v, pressure: 0.5, t: i * 8 }));
	return { id, tool: "pen", color: "#000000", width: 2, points, bbox: computeBBox(points, 4), createdAt: 0, page: 1 };
}

const COPIED = "Handwriting: copied 1 stroke(s)";
const CUT = "Handwriting: cut 1 stroke(s)";

describe("copy and cut of lassoed pdf ink under a layout whose letters are not Latin", () => {
	let strokes: InkStroke[];
	let ops: InkOp[];
	let notices: string[];
	let execs: string[];
	let controller: PdfInkController;
	let pen: { penDown(s: PenSample): void; penRaw(s: PenSample[]): void; penUp(): void };
	let keys: { handleKeyDown(ev: KeyboardEvent): void };
	/** What `win.getSelection()` answers; null is "no text selected anywhere". */
	let textSel: { isCollapsed: boolean; anchorNode: unknown } | null;
	/** A node the pane's root contains. */
	const inPane = {};

	beforeEach(() => {
		resetTipModeForTest();
		clearInkClipboard();
		strokes = [inkAt("s1")];
		ops = [];
		notices = [];
		execs = [];
		textSel = null;
		setMouseInk(false);
		clearToolPicked();
		const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add: () => {}, remove: () => {} }, querySelector: () => null };
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
		};
		const root = { contains: (n: unknown) => n === inPane } as unknown as HTMLElement;
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			cancelAnimationFrame: () => {},
			requestAnimationFrame: () => 0,
			getSelection: () => textSel,
		};
		controller = new PdfInkController(
			root,
			win as unknown as Window,
			() => strokes,
			() => "doc-1",
			() => strokes,
			(op) => {
				ops.push(op);
				strokes = applyOp(strokes, op);
			},
			(id) => execs.push(id),
			(message) => notices.push(message)
		);
		pen = controller as unknown as typeof pen;
		keys = controller as unknown as typeof keys;
	});

	afterEach(() => {
		clearInkClipboard();
	});

	/** A keydown with `key` and `code`, and whether it was consumed. */
	function press(key: string, code: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {}): boolean {
		let prevented = false;
		const ev = {
			key,
			code,
			ctrlKey: mods.ctrl ?? false,
			metaKey: mods.meta ?? false,
			altKey: mods.alt ?? false,
			shiftKey: false,
			target: null,
			preventDefault: () => {
				prevented = true;
			},
			stopPropagation: () => {},
		};
		keys.handleKeyDown(ev as unknown as KeyboardEvent);
		return prevented;
	}

	/** Select s1 through the real lasso path. */
	function select(): void {
		setTipMode("lasso");
		const corners: [number, number][] = [
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		];
		pen.penDown(sample(corners[0]![0], corners[0]![1]));
		for (const [x, y] of corners.slice(1)) pen.penRaw([sample(x, y)]);
		pen.penRaw([sample(corners[0]![0], corners[0]![1])]);
		pen.penUp();
		expect(controller.hasSelection, "premise: s1 is lassoed").toBe(true);
	}

	it("Ctrl+C with a Russian layout letter on the C key copies the lassoed ink and is consumed", () => {
		select();
		expect(press("с", "KeyC", { ctrl: true }), "the key press was not consumed").toBe(true);
		expect(clipboardSize(), "nothing was copied").toBe(1);
		expect(notices).toEqual([COPIED]);
		expect(strokes.map((s) => s.id), "a copy removed ink").toEqual(["s1"]);
		expect(execs).toEqual([]);
	});

	it("Ctrl+X with a Russian layout letter on the X key cuts the lassoed ink and is consumed", () => {
		select();
		expect(press("ч", "KeyX", { ctrl: true }), "the key press was not consumed").toBe(true);
		expect(clipboardSize(), "nothing was cut to the clipboard").toBe(1);
		expect(notices).toEqual([CUT]);
		expect(ops.map((o) => o.type), "the ink was not removed").toEqual(["remove"]);
		expect(strokes.map((s) => s.id)).toEqual([]);
	});

	it("Cmd+C with a Greek layout letter and Cmd+X with an Arabic one act on the lasso, as on macOS", () => {
		select();
		expect(press("ψ", "KeyC", { meta: true }), "Cmd+C under Greek was not consumed").toBe(true);
		expect(clipboardSize(), "Cmd+C under Greek copied nothing").toBe(1);
		expect(notices).toEqual([COPIED]);
		expect(press("ء", "KeyX", { meta: true }), "Cmd+X under Arabic was not consumed").toBe(true);
		expect(notices, "Cmd+X under Arabic cut nothing").toEqual([COPIED, CUT]);
		expect(strokes.map((s) => s.id)).toEqual([]);
	});

	it("a Latin layout that moves C and X keeps what the key types (Dvorak, AZERTY)", () => {
		select();
		// Dvorak: the key that types C sits where QWERTY has I, and the QWERTY C key types J.
		expect(press("j", "KeyC", { ctrl: true }), "Dvorak J on the QWERTY C key was taken as copy").toBe(false);
		expect(clipboardSize()).toBe(0);
		expect(press("c", "KeyI", { ctrl: true }), "Dvorak C was not taken as copy").toBe(true);
		expect(notices).toEqual([COPIED]);
		// Dvorak: X sits where QWERTY has B, and the QWERTY X key types Q.
		expect(press("q", "KeyX", { ctrl: true }), "Dvorak Q on the QWERTY X key was taken as cut").toBe(false);
		expect(strokes.map((s) => s.id)).toEqual(["s1"]);
		// AZERTY keeps C and X where QWERTY has them.
		expect(press("x", "KeyX", { ctrl: true }), "AZERTY X was not taken as cut").toBe(true);
		expect(notices).toEqual([COPIED, CUT]);
		expect(strokes.map((s) => s.id)).toEqual([]);
	});

	it("under a Russian layout, a live text selection in the pane, no lasso, or Ctrl+Alt still leave the key to the viewer", () => {
		// No lasso: the key reaches the viewer, so a PDF's own text still copies.
		expect(press("с", "KeyC", { ctrl: true }), "with nothing lassoed the key was taken").toBe(false);
		select();
		// Text selected in this pane: the copy is the text's.
		textSel = { isCollapsed: false, anchorNode: inPane };
		expect(press("с", "KeyC", { ctrl: true }), "a text selection's Ctrl+C was taken by the lasso").toBe(false);
		expect(press("ч", "KeyX", { ctrl: true }), "a text selection's Ctrl+X was taken by the lasso").toBe(false);
		textSel = null;
		// Ctrl+Alt is AltGr on a Windows layout: not ours.
		expect(press("с", "KeyC", { ctrl: true, alt: true }), "Ctrl+Alt was taken as copy").toBe(false);
		expect(clipboardSize()).toBe(0);
		expect(notices).toEqual([]);
		expect(strokes.map((s) => s.id)).toEqual(["s1"]);
	});
});
