/**
 * The inline strip's trash button acts on its OWN overlay, never on
 * whichever editor `overlayForPath` happens to resolve.
 *
 * Measured on two refs: `activeInkSurface()` (main.ts)
 * routes an inline surface through `overlayForPath(file.path)`
 * (InkOverlay.ts), which answers the FIRST mounted overlay showing that
 * path. With two editors A then B open on the same note and B active,
 * pressing B's strip trash executes the REGISTERED command, which resolves
 * A. If A has no selection the user gets "lasso some ink first" while B
 * still has ink selected; if A has its own selection, B's trash deletes A's
 * stroke and sends the history op into A.
 *
 * `overlayForPath` itself is not touched here - see its own doc comment and
 * `OverlayPick`-shaped tests elsewhere for that lookup's own rules. This
 * file drives the STRIP HOST PATH: the `exec` closure `ensurePenToolsInner`
 * hands to `MobileTools` (InkOverlay.ts, ~1869), which is what a real strip
 * button calls. `commands.executeCommandById` is faked to do exactly what
 * the registered "delete-selected-ink" command does today (main.ts): ask
 * `overlayForPath` and act on whatever it returns - so the buggy fallback
 * path is the real bug, not a guess at it, and the fix is provably a
 * SEPARATE, EARLIER branch in the same `exec` closure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
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

/** The counting stand-in `PenToolsEscapeHatch.test.ts` uses, extended to
 *  hand back the `exec` each strip was built with - the thing a button
 *  press actually calls. */
const strips = vi.hoisted(() => ({ built: [] as Array<{ exec: (id: string) => void }> }));
vi.mock("./MobileTools", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class MobileTools {
		constructor(_host: unknown, opts: { exec: (id: string) => void }) {
			strips.built.push(opts);
		}
		setCorner(): void {}
		refresh(): void {}
		setInking(): void {}
		closeInkSliders(): void {}
		setCollapsed(): void {}
		destroy(): void {}
	}
	return { ...actual, MobileTools };
});

import { Notice } from "obsidian";
import { copySelectionNotice, InkOverlayPlugin, inlineInk, overlayForPath } from "./InkOverlay";
import { clipboardSize, pasteInk } from "./InkClipboard";
import { lassoDeleteNotice } from "./InlineSelectionDelete";
import { inkApplied, inkEffect, inkHistorySupport, type InkOp } from "./InkHistory";
import { resetPenToolsForTest, setPenToolsMode } from "./PenToolsMode";

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

/**
 * What the registered "delete-selected-ink" command does today (main.ts's
 * checkCallback, unmodified): resolve the surface through `overlayForPath`
 * and act on whatever it returns. This is `commands.executeCommandById`'s
 * whole job in these fixtures - the thing the strip's `exec` falls through
 * to for every id it does not intercept itself.
 */
function registeredDeleteCommand(path: string): (id: string) => void {
	return (id) => {
		if (id !== "handwriting:delete-selected-ink") return;
		const overlay = overlayForPath(path);
		if (!overlay) return;
		const said = lassoDeleteNotice(overlay.deleteSelectedInk());
		if (said) new Notice(said);
	};
}

type Fixture = { overlay: InkOverlayPlugin; exec: (id: string) => void; state: () => EditorState };

/**
 * A real `InkOverlayPlugin`, registered in the real `instances` set (so
 * `overlayForPath` sees it), with its strip's real `exec` closure captured
 * and a REAL headless CodeMirror history behind it - the mechanism `undo`
 * and `dispatchInk` actually use, proven the same way `InkHistory.test.ts`
 * proves it, not stood in for.
 *
 * Modeled on `PenToolsEscapeHatch.test.ts`'s `noteOverlay()`: `mount()`
 * bails on an undefined `editorInfoField` lookup at construction, so the
 * fields it would have set are supplied by hand afterward. `filePath` is
 * overridden directly rather than routed through `editorInfoField`, because
 * that fake field is asked for `app.commands` too (to build the strip) and
 * a single call cannot answer two different callers two different shapes.
 */
function mountOverlay(path: string, executeCommandById: (id: string) => void): Fixture {
	let mounted = false;
	const noop = (): void => undefined;
	const zoomChrome = () => ({
		createEl: () => ({ addEventListener: noop, textContent: "", disabled: false }),
		toggleClass: noop,
		remove: noop,
	});
	const dom = {
		parentElement: { setCssStyles: noop, createDiv: zoomChrome },
		ownerDocument: {
			defaultView: { getComputedStyle: () => ({ position: "relative" }), cancelAnimationFrame: noop },
		},
		style: { removeProperty: noop },
		setCssStyles: noop,
	};
	const view: Record<string, unknown> = {
		dom,
		scrollDOM: {
			removeEventListener: noop,
			addEventListener: noop,
			classList: { add: noop, remove: noop },
			setCssStyles: noop,
			style: { removeProperty: noop },
		},
		state: {
			field: () => (mounted ? { app: { commands: { executeCommandById } } } : undefined),
		},
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

	// Build the strip NOW, while `view.state` is still the fake `.field()`
	// shim above - `ensurePenToolsInner` reads `app.commands` off exactly
	// that, once, to close over it in `exec`.
	const before = strips.built.length;
	(overlay as unknown as { ensurePenTools(): void }).ensurePenTools();
	const exec = strips.built[before]!.exec;

	// From here on `view.state`/`view.dispatch` are the real thing: what
	// proves the op went "only to B" and that B's own undo restores it is
	// this overlay's own CodeMirror history actually holding (or not
	// holding) the step, not a bookkeeping stand-in for it.
	let cm = EditorState.create({ doc: "", extensions: [history(), inkHistorySupport()] });
	view.state = cm;
	view.dispatch = (trOrSpec: unknown) => {
		const tr = trOrSpec instanceof Transaction ? trOrSpec : cm.update(trOrSpec as never);
		cm = tr.state;
		view.state = cm;
		// The real ViewPlugin's `update()` does this first, on every
		// transaction: apply whatever undo/redo just re-dispatched. The
		// ORIGINAL gesture (marked `inkApplied`) already put its change in
		// the store directly, so it is skipped here exactly as `update()`
		// skips it - the same guard, InkOverlay.ts's own `update()`.
		if (!tr.annotation(inkApplied)) {
			for (const effect of tr.effects) {
				if (effect.is(inkEffect)) {
					(overlay as unknown as { applyInkOp(op: InkOp): void }).applyInkOp(effect.value as InkOp);
				}
			}
		}
	};

	return { overlay: overlay as unknown as InkOverlayPlugin, exec, state: () => cm };
}

const EMPTY_NOTICE = "Handwriting: lasso some ink first";
const UNMATCHED_NOTICE = "Handwriting: could not remove the selected ink - the lasso has been kept";

describe("the inline strip's trash acts on its own overlay", () => {
	let live: InkOverlayPlugin[] = [];

	beforeEach(() => {
		strips.built = [];
		notices.said = [];
		live = [];
		resetPenToolsForTest();
		// The strip is built by `ensurePenTools()` gated on visibility; "show"
		// is the one mode that puts a strip on a desktop with no pen ever
		// seen, without touching anything this fix cares about (`penSeen`,
		// mouse ink) the way the two hatches in `PenToolsEscapeHatch.test.ts`
		// do not either.
		setPenToolsMode("show");
	});

	afterEach(() => {
		for (const o of live) (o as unknown as { destroy(): void }).destroy();
		resetPenToolsForTest();
	});

	function mount(path: string, executeCommandById: (id: string) => void): Fixture {
		const f = mountOverlay(path, executeCommandById);
		live.push(f.overlay);
		return f;
	}

	function selection(overlay: InkOverlayPlugin): { selectExactly(ids: string[]): void; strokeIds: string[] } {
		return (overlay as unknown as { selection: { selectExactly(ids: string[]): void; strokeIds: string[] } })
			.selection;
	}

	it("only B has a selection: B's own trash removes it, and does not say the lasso is empty", () => {
		const path = "case1.md";
		inlineInk.applyAdd(path, [stroke("b")]);
		const a = mount(path, registeredDeleteCommand(path));
		const b = mount(path, registeredDeleteCommand(path));
		// A has nothing selected; B does.
		selection(b.overlay).selectExactly(["b"]);

		b.exec("handwriting:delete-selected-ink");

		expect(inlineInk.strokes(path).map((s) => s.id)).toEqual([]);
		expect(notices.said).toEqual([]);
		void a;
	});

	it("A and B each hold a selection: B's trash removes ONLY b, sends the op only to B, and B's own undo restores it", () => {
		const path = "case2.md";
		inlineInk.applyAdd(path, [stroke("a"), stroke("b")]);
		const a = mount(path, registeredDeleteCommand(path));
		const b = mount(path, registeredDeleteCommand(path));
		selection(a.overlay).selectExactly(["a"]);
		selection(b.overlay).selectExactly(["b"]);

		b.exec("handwriting:delete-selected-ink");

		expect(inlineInk.strokes(path).map((s) => s.id)).toEqual(["a"]);
		expect(undoDepth(a.state())).toBe(0);
		expect(undoDepth(b.state())).toBe(1);

		b.exec("editor:undo");

		expect(inlineInk.strokes(path).map((s) => s.id).sort()).toEqual(["a", "b"]);
		expect(undoDepth(a.state())).toBe(0);
	});

	it("pin: one editor, a normal delete still works", () => {
		const path = "case3.md";
		inlineInk.applyAdd(path, [stroke("x")]);
		const m = mount(path, registeredDeleteCommand(path));
		selection(m.overlay).selectExactly(["x"]);

		m.exec("handwriting:delete-selected-ink");

		expect(inlineInk.strokes(path).map((s) => s.id)).toEqual([]);
		expect(notices.said).toEqual([]);
	});

	it("the empty-owner gate: B's OWN selection empty says the old sentence, even while A holds one", () => {
		const path = "case4.md";
		inlineInk.applyAdd(path, [stroke("a")]);
		const a = mount(path, registeredDeleteCommand(path));
		const b = mount(path, registeredDeleteCommand(path));
		selection(a.overlay).selectExactly(["a"]);
		// B: nothing selected.

		b.exec("handwriting:delete-selected-ink");

		expect(notices.said).toEqual([EMPTY_NOTICE]);
		// A's stroke is untouched: B's own empty gate must not reach past B.
		expect(inlineInk.strokes(path).map((s) => s.id)).toEqual(["a"]);
	});

	it("pin: an unmatched delete on B keeps B's selection and gives the honest notice", () => {
		const path = "case5.md";
		const a = mount(path, registeredDeleteCommand(path));
		const b = mount(path, registeredDeleteCommand(path));
		// Nothing in the store matches "ghost" - the predecessor box's
		// failure shape (InlineSelectionDelete.ts / LassoDeleteHonestFailure).
		selection(b.overlay).selectExactly(["ghost"]);

		b.exec("handwriting:delete-selected-ink");

		expect(notices.said).toEqual([UNMATCHED_NOTICE]);
		expect(selection(b.overlay).strokeIds).toEqual(["ghost"]);
		void a;
	});
});

/**
 * THE SAME DEFECT AS THE TRASH, in the two buttons beside it.
 *
 * The strip's copy and cut still fell through to `executeCommandById`, which
 * resolves through `activeInkSurface` and `overlayForPath`, and that returns
 * the FIRST mounted overlay showing the path. With two editors on one note,
 * A then B, B active: B's copy took A's ink and B's cut DELETED from A. Cut
 * is the worse of the two - it destroys rather than misreads.
 *
 * Ownership is observed by EFFECT, never by which sentence appeared: the
 * clipboard's contents for copy, the store and each overlay's own undo depth
 * for cut. The two strokes carry different colours so the clipboard can say
 * WHOSE stroke it took - `pasteInk` re-mints ids, so an id cannot answer it.
 */
describe("the inline strip's copy and cut act on their own overlay", () => {
	let live: InkOverlayPlugin[] = [];

	beforeEach(() => {
		strips.built = [];
		notices.said = [];
		live = [];
		resetPenToolsForTest();
		setPenToolsMode("show");
	});

	afterEach(() => {
		for (const o of live) (o as unknown as { destroy(): void }).destroy();
		resetPenToolsForTest();
	});

	function mount(path: string, executeCommandById: (id: string) => void): Fixture {
		const f = mountOverlay(path, executeCommandById);
		live.push(f.overlay);
		return f;
	}

	function selection(overlay: InkOverlayPlugin): { selectExactly(ids: string[]): void } {
		return (overlay as unknown as { selection: { selectExactly(ids: string[]): void } }).selection;
	}

	/** A stroke the clipboard can be asked about later. */
	const tinted = (id: string, color: string): InkStroke => ({ ...stroke(id), color });

	/**
	 * The registered commands as they route TODAY: through `overlayForPath`,
	 * which answers the first mounted overlay. Written out rather than
	 * imported so the red below is the real routing and not a stand-in.
	 */
	function registeredCopyCommand(path: string): (id: string) => void {
		return (id) => {
			if (id !== "handwriting:copy-selected-ink") return;
			const overlay = overlayForPath(path);
			if (!overlay) return;
			overlay.copySelectedInk();
		};
	}

	function registeredCutCommand(path: string): (id: string) => void {
		return (id) => {
			if (id !== "handwriting:cut-selected-ink") return;
			const overlay = overlayForPath(path);
			if (!overlay) return;
			overlay.cutSelectedInk();
		};
	}

	it("B's copy takes B's ink, not the ink A had selected", () => {
		const path = "copy-owner.md";
		inlineInk.applyAdd(path, [tinted("a", "#aaaaaa"), tinted("b", "#bbbbbb")]);
		const a = mount(path, registeredCopyCommand(path));
		const b = mount(path, registeredCopyCommand(path));
		selection(a.overlay).selectExactly(["a"]);
		selection(b.overlay).selectExactly(["b"]);

		b.exec("handwriting:copy-selected-ink");

		expect(clipboardSize()).toBe(1);
		const held = pasteInk(path);
		expect(held.length).toBe(1);
		expect(held[0]!.color, "the clipboard holds the OTHER editor's stroke").toBe("#bbbbbb");
		void a;
	});

	it("B's cut removes b and only b, sends the op only to B, and B's own undo restores it", () => {
		const path = "cut-owner.md";
		inlineInk.applyAdd(path, [tinted("a", "#aaaaaa"), tinted("b", "#bbbbbb")]);
		const a = mount(path, registeredCutCommand(path));
		const b = mount(path, registeredCutCommand(path));
		selection(a.overlay).selectExactly(["a"]);
		selection(b.overlay).selectExactly(["b"]);

		b.exec("handwriting:cut-selected-ink");

		expect(inlineInk.strokes(path).map((s) => s.id)).toEqual(["a"]);
		expect(pasteInk(path)[0]!.color, "the clipboard holds the wrong editor's stroke").toBe("#bbbbbb");
		expect(undoDepth(a.state()), "the op landed in the WRONG editor's history").toBe(0);
		expect(undoDepth(b.state())).toBe(1);

		b.exec("editor:undo");

		expect(inlineInk.strokes(path).map((s) => s.id).sort()).toEqual(["a", "b"]);
		expect(undoDepth(a.state())).toBe(0);
	});

	it("pin: one editor, copy and cut still work", () => {
		const path = "solo-copy.md";
		inlineInk.applyAdd(path, [tinted("s", "#555555")]);
		const only = mount(path, registeredCutCommand(path));
		selection(only.overlay).selectExactly(["s"]);

		only.exec("handwriting:cut-selected-ink");

		expect(inlineInk.strokes(path).map((s) => s.id)).toEqual([]);
		expect(undoDepth(only.state())).toBe(1);
	});
});

/**
 * The copy sentences MOVED, they were not rewritten.
 *
 * `main.ts` produced both of these from an inline ternary until this box;
 * `copySelectionNotice` owns them now so the strip button and the registered
 * command cannot drift. Pinned by EXECUTION, because the template's variable
 * was renamed (`${n}` -> `${copied}`) and only running it can show that the
 * rendered sentence is unchanged - reading the source cannot.
 */
describe("copySelectionNotice owns both copy sentences, unchanged", () => {
	it("says the same thing the ternary said when something was copied", () => {
		expect(copySelectionNotice(1)).toBe("Handwriting: copied 1 stroke(s)");
		expect(copySelectionNotice(4)).toBe("Handwriting: copied 4 stroke(s)");
	});

	it("keeps the empty-selection sentence byte for byte - it has survived four boxes", () => {
		expect(copySelectionNotice(0)).toBe("Handwriting: lasso some ink first");
	});
});
