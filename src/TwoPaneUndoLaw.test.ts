/** One note in two panes, each with its own undo history, against the one ink store.
	* A move step applies to all of its strokes or to none, and only when each stands where the
	* step expects it; a removed stroke goes back next to the stroke it sat beside.
	* The headless overlay mount follows ActiveInkSurfaceOwnership.test.ts.
	*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { history, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import type { InkStroke } from "./ink/Stroke";

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	const { StateField } = await import("@codemirror/state");
	const editorInfoField = StateField.define<unknown>({
		create: () => null,
		update: (value) => value,
	});
	return { ...actual, editorInfoField };
});

import { TFile, editorInfoField } from "obsidian";
import type { Editor, MarkdownFileInfo } from "obsidian";
import { InkOverlayPlugin, inlineInk } from "./inline/InkOverlay";
import { clearInkClipboard } from "./inline/InkClipboard";
import { inkApplied, inkEffect, inkHistorySupport, type InkOp } from "./inline/InkHistory";

/** The gesture path rebinds, which constructs observers Node does not have. */
class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

function stroke(id: string, x: number): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x, y: 10, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: x - 2, y: 8, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

type FakeFile = TFile & { path: string; extension: string; basename: string };

function tfile(path: string): FakeFile {
	const file = new TFile() as FakeFile;
	file.path = path;
	file.extension = path.split(".").pop() ?? "md";
	file.basename = path.replace(/\.[^.]+$/, "");
	return file;
}

function editorNamed(name: string): Editor {
	return { name } as unknown as Editor;
}

/** The active-editor info the workspace hands back for a pane. */
function info(file: TFile | null, editor: Editor | undefined): MarkdownFileInfo {
	return { app: {}, file, editor, hoverPopover: null } as unknown as MarkdownFileInfo;
}

type Fixture = {
	overlay: InkOverlayPlugin;
	editor: Editor;
	info: MarkdownFileInfo;
	state: () => EditorState;
	dispatch: (tr: Transaction) => void;
	unmount(): void;
};

/**
 * A real `InkOverlayPlugin` in the real `instances` set, behind a REAL
 * CodeMirror state that carries `editorInfoField` - so `filePath()`,
 * `showsPath()` and the active-editor lookup all read the field the shipped
 * code reads - and a REAL history, so "the step went to B and not to A" is the
 * mechanism `undo` actually uses rather than a bookkeeping stand-in.
 *
 * Construction is two-phase for the reason `InlineStripSelectionRouting.test.ts`
 * gives: `mount()` builds canvases this environment has no DOM for, and it
 * bails when the field lookup is `undefined`, so it is allowed to bail and the
 * fields it would have set are supplied by hand afterwards. Only host chrome is
 * stubbed - repaints, the selection redraw, and the paste scroll-into-view,
 * which needs a laid-out canvas.
 */
function mountOverlay(file: TFile, editor: Editor): Fixture {
	const noop = (): void => undefined;
	// The note's own editor root, for the gate `pasteInkHere` now asks
	// (`ownsMarkdownEditorRoot`, issue 22): the editor is its own source view,
	// inside no other editor, table or embed.
	const dom: Record<string, unknown> = {
		closest: (sel: string) => (sel === ".markdown-source-view" ? dom : null),
		parentElement: { setCssStyles: noop, closest: () => null },
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
			getBoundingClientRect: () => ({ left: 0, top: 0 }),
			clientHeight: 800,
			clientWidth: 800,
			clientLeft: 0,
			clientTop: 0,
			scrollTop: 0,
			scrollLeft: 0,
		},
		// `mount()` reads this once at construction and stays inert on undefined.
		state: { field: () => undefined },
	};
	const overlay = new InkOverlayPlugin(view as never) as unknown as Record<string, unknown>;
	overlay.container = { nodeType: 1, remove: noop, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
	overlay.mobileTools = null;
	overlay.applyToolbarCorner = noop;
	overlay.redrawSelectionUI = noop;
	overlay.scheduleRepaint = noop;
	overlay.repaintPath = noop;
	overlay.updateExtent = noop;
	overlay.syncCamera = noop;
	// Chrome: a paste scrolls what it pasted into view, which needs a laid-out
	// canvas. WHERE the paste landed is asserted from the store, not from here.
	overlay.selectionBounds = () => null;

	const mine = info(file, editor);
	let cm = EditorState.create({
		doc: "",
		extensions: [history(), inkHistorySupport(), editorInfoField.init(() => mine)],
	});
	view.state = cm;
	const dispatch = (trOrSpec: unknown): void => {
		const tr = trOrSpec instanceof Transaction ? trOrSpec : cm.update(trOrSpec as never);
		cm = tr.state;
		view.state = cm;
		// What the real ViewPlugin's `update()` does first on every
		// transaction, with the same guard: the original gesture already put
		// its change in the store, so only a re-dispatch (undo/redo) applies.
		if (!tr.annotation(inkApplied)) {
			for (const effect of tr.effects) {
				if (effect.is(inkEffect)) {
					(overlay as unknown as { applyInkOp(op: InkOp): void }).applyInkOp(effect.value as InkOp);
				}
			}
		}
	};
	view.dispatch = dispatch;

	return {
		overlay: overlay as unknown as InkOverlayPlugin,
		editor,
		info: mine,
		state: () => cm,
		dispatch: dispatch as (tr: Transaction) => void,
		unmount: () => void ((overlay as unknown as { container: unknown }).container = null),
	};
}

/** Publish the gesture already applied to the store; production stamps its identity. */
function publish(f: Fixture, op: InkOp): void {
	(f.overlay as unknown as { dispatchInk(op: InkOp): void }).dispatchInk(op);
}

function depths(f: Fixture): number[] {
	return [undoDepth(f.state()), redoDepth(f.state())];
}

function undoIn(f: Fixture): void {
	expect(undo({ state: f.state(), dispatch: f.dispatch } as never)).toBe(true);
}

function redoIn(f: Fixture): void {
	expect(redo({ state: f.state(), dispatch: f.dispatch } as never)).toBe(true);
}

function ids(path: string): string[] {
	return inlineInk.strokes(path).map((s) => s.id);
}

function positions(path: string): string[] {
	return inlineInk.strokes(path).map((s) => `${s.id}@${s.points[0]!.x}`);
}

/** Translation must preserve point spacing, y, pressure and sample timestamps. */
function expectShape(s: InkStroke, width: number): void {
	expect(s.points).toHaveLength(2);
	expect(s.points[1]!.x - s.points[0]!.x).toBe(width);
	expect(s.points.map(({ y, pressure, t }) => ({ y, pressure, t }))).toEqual([
		{ y: 10, pressure: 0.5, t: 0 },
		{ y: 20, pressure: 0.5, t: 8 },
	]);
}

describe("one note in two panes: undo and redo", () => {
	let live: InkOverlayPlugin[] = [];
	beforeEach(() => {
		live = [];
		clearInkClipboard();
	});
	afterEach(() => {
		try {
			for (const overlay of live) overlay.destroy();
		} finally {
			clearInkClipboard();
		}
	});

	function twoPanes(path: string): { a: Fixture; b: Fixture } {
		const file = tfile(path);
		const a = mountOverlay(file, editorNamed("A"));
		live.push(a.overlay);
		const b = mountOverlay(file, editorNamed("B"));
		live.push(b.overlay);
		expect(a.info.file).toBe(b.info.file);
		expect(a.editor).not.toBe(b.editor);
		expect(a.state()).not.toBe(b.state());
		expect(depths(a)).toEqual([0, 0]);
		expect(depths(b)).toEqual([0, 0]);
		return { a, b };
	}

	function control(path: string): () => void {
		const other = `${path}.unrelated.md`;
		const untouched = stroke("unrelated", 500);
		inlineInk.commit(other, untouched);
		const before = JSON.stringify(inlineInk.strokes(other));
		return () => {
			expect(inlineInk.strokes(other)).toHaveLength(1);
			expect(inlineInk.strokes(other)[0]).toBe(untouched);
			expect(JSON.stringify(inlineInk.strokes(other))).toBe(before);
		};
	}


	function xs(path: string): string[] {
		return positions(path);
	}

	function removeIn(f: Fixture, path: string, strokeIds: string[]): void {
		const got = inlineInk.applyRemove(path, strokeIds);
		expect(got.map((g) => g.stroke.id).sort()).toEqual([...strokeIds].sort());
		publish(f, { type: "remove", path, strokes: got.map((g) => g.stroke), indices: got.map((g) => g.index) });
	}

	function moveIn(f: Fixture, path: string, strokeIds: string[], dx: number): void {
		inlineInk.moveStrokes(path, strokeIds, dx, 0);
		inlineInk.save(path);
		publish(f, { type: "move", path, strokeIds: [...strokeIds], dx, dy: 0 });
	}

	it("a split stroke's pieces moved in the other pane end 100 px away after both panes undo and redo, not 200", () => {
		const path = "two-pane-split-then-move.md";
		const s1 = stroke("s1", 10);
		s1.points[1]!.x = 50;
		s1.bbox = { x: 8, y: 8, width: 46, height: 16 };
		inlineInk.commit(path, s1);
		const { a, b } = twoPanes(path);
		const checkControl = control(path);
		const p1 = stroke("p1", 10);
		const p2 = stroke("p2", 40);
		inlineInk.takeLive(path, ["s1"]);
		inlineInk.applyAddLive(path, [p1, p2], [0, 1]);
		inlineInk.save(path);
		publish(b, { type: "replace", path, removed: [s1], removedAt: [0], inserted: [p1, p2], insertedAt: [0, 1] });
		moveIn(a, path, ["p1", "p2"], 100);
		expect(xs(path)).toEqual(["p1@110", "p2@140"]);

		undoIn(b);
		undoIn(a);
		redoIn(b);
		redoIn(a);

		checkControl();
		expect(xs(path), "the pieces were moved twice").toEqual(["p1@110", "p2@140"]);
	});

	it("recorded outcome: a move undone in its pane after the other pane undid the stroke is spent, and the stroke returns moved, once", () => {
		const path = "two-pane-move-spent.md";
		const { a, b } = twoPanes(path);
		const s1 = stroke("s1", 10);
		inlineInk.commit(path, s1);
		publish(a, { type: "add", path, strokes: [s1], indices: [0] });
		moveIn(b, path, ["s1"], 100);

		undoIn(a);
		expect(ids(path)).toEqual([]);
		undoIn(b);
		expect(ids(path)).toEqual([]);
		redoIn(a);

		expect(xs(path)).toEqual(["s1@110"]);
	});

	it("a move whose strokes no longer stand where it left them is refused whole on undo", () => {
		const path = "two-pane-move-refused.md";
		inlineInk.commit(path, stroke("s1", 10));
		inlineInk.commit(path, stroke("s2", 40));
		const { a, b } = twoPanes(path);
		moveIn(a, path, ["s1", "s2"], 100);
		moveIn(b, path, ["s2"], 50);
		expect(xs(path)).toEqual(["s1@110", "s2@190"]);

		undoIn(a);

		expect(xs(path), "part of the move was undone").toEqual(["s1@110", "s2@190"]);
	});

	it("control: one pane, a lasso move goes back and forth exactly on undo and redo", () => {
		const path = "one-pane-move.md";
		inlineInk.commit(path, stroke("s1", 10));
		const { a } = twoPanes(path);
		moveIn(a, path, ["s1"], 100);

		undoIn(a);
		expect(xs(path)).toEqual(["s1@10"]);
		redoIn(a);
		expect(xs(path)).toEqual(["s1@110"]);
		undoIn(a);
		expect(xs(path)).toEqual(["s1@10"]);
	});

	it("two panes each undo a delete: the strokes go back beside the strokes they sat next to", () => {
		const path = "two-pane-depth.md";
		for (const [id, x] of [["U", 10], ["S", 12], ["T", 14]] as const) inlineInk.commit(path, stroke(id, x));
		const { a, b } = twoPanes(path);
		removeIn(a, path, ["S"]);
		removeIn(b, path, ["U"]);

		undoIn(a);
		undoIn(b);

		// S went back before T, its neighbour after; U went back before T, its
		// neighbour after when it was deleted. U's step never saw S after it.
		expect(ids(path)).toEqual(["S", "U", "T"]);
	});

	it("a deleted stroke whose later neighbour is gone goes back right after its earlier one, not at its old number", () => {
		const path = "two-pane-depth-prev.md";
		for (const [id, x] of [["V", 8], ["U", 10], ["S", 12], ["T", 14]] as const) inlineInk.commit(path, stroke(id, x));
		const { a, b } = twoPanes(path);
		removeIn(a, path, ["S"]);
		removeIn(b, path, ["V", "T"]);
		const w = stroke("W", 16);
		inlineInk.commit(path, w);
		publish(b, { type: "add", path, strokes: [w] });
		expect(ids(path)).toEqual(["U", "W"]);

		undoIn(a);

		expect(ids(path)).toEqual(["U", "S", "W"]);
	});

	it("control: one pane, two neighbouring strokes deleted in one step come back in their order", () => {
		const path = "one-pane-depth.md";
		for (const [id, x] of [["U", 10], ["S", 12], ["T", 14]] as const) inlineInk.commit(path, stroke(id, x));
		const { a } = twoPanes(path);
		removeIn(a, path, ["S", "T"]);
		expect(ids(path)).toEqual(["U"]);

		undoIn(a);

		expect(ids(path)).toEqual(["U", "S", "T"]);
	});

	it("a stroke deleted while a sync reload is pending goes back at its depth, beside the other device's stroke it sat next to", () => {
		const path = "two-pane-depth-reload.md";
		for (const [id, x] of [["U", 10], ["O", 11], ["S", 12], ["T", 14]] as const) inlineInk.commit(path, stroke(id, x));
		const { a } = twoPanes(path);
		// O came from the other device: while the reload is pending the
		// store shows only this device's strokes, but the record holds all.
		const rec = (inlineInk as unknown as { byPath: Map<string, { reloading: boolean; localStrokeIds: Set<string> }> }).byPath.get(path)!;
		rec.localStrokeIds.delete("O");
		rec.reloading = true;
		expect(ids(path)).toEqual(["U", "S", "T"]);
		removeIn(a, path, ["S"]);
		rec.reloading = false;
		expect(ids(path)).toEqual(["U", "O", "T"]);

		undoIn(a);

		expect(ids(path), "the stroke went back at the wrong depth").toEqual(["U", "O", "S", "T"]);
	});

	it("a stroke the other pane drew between a deleted stroke's old neighbours: the undone stroke goes back just under its old upper neighbour", () => {
		const path = "two-pane-depth-between.md";
		for (const [id, x] of [["U", 10], ["S", 12], ["T", 14]] as const) inlineInk.commit(path, stroke(id, x));
		const { a, b } = twoPanes(path);
		removeIn(a, path, ["S"]);
		const x = stroke("X", 13);
		inlineInk.applyAdd(path, [x], [1]);
		publish(b, { type: "add", path, strokes: [x], indices: [1] });
		expect(ids(path)).toEqual(["U", "X", "T"]);

		undoIn(a);

		expect(ids(path)).toEqual(["U", "X", "S", "T"]);
	});

	it("a move made in steps of 0.1 and 2.3 is undone and redone exactly, float sums and all", () => {
		const path = "one-pane-move-fractions.md";
		inlineInk.commit(path, stroke("s1", 10));
		const { a } = twoPanes(path);
		const at = (): number => inlineInk.strokes(path)[0]!.points[0]!.x;
		moveIn(a, path, ["s1"], 0.1);
		moveIn(a, path, ["s1"], 2.3);
		expect(at()).toBeCloseTo(12.4, 9);

		undoIn(a);
		expect(at()).toBeCloseTo(10.1, 9);
		undoIn(a);
		expect(at()).toBeCloseTo(10, 9);
		redoIn(a);
		expect(at()).toBeCloseTo(10.1, 9);
		redoIn(a);
		expect(at()).toBeCloseTo(12.4, 9);
	});
});
