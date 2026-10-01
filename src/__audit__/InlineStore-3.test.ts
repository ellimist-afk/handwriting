/**
 * AUDIT PROBE InlineStore-3 (1.4.21, tag 1a05f62c). Read-only audit; not part of the product suite.
 *
 * Claim: a lasso selection in pane A goes stale when the same note's strokes are removed from pane B
 * (Delete all ink run in B, or an undo/redo in B). Nothing prunes A's SelectionModel, so
 * InlineSelectionDeleteKeys.keydown (InlineSelectionDelete.ts:97-101) still sees hasSelection() true,
 * preventDefaults every fresh Backspace/Delete, calls deleteSelectedInk (which answers "unmatched" and
 * keeps the selection, InkOverlay.ts:10645-10652) and the keyboard caller drops the result (:1515-1518).
 * The selection box is not drawn because its bounds are null (:10256-10257), so the dead lasso is
 * invisible.
 *
 * Correct behaviour asserted here: once the lassoed ink no longer exists, Backspace in pane A reaches
 * the editor (not claimed, not preventDefault-ed); and any selection that can still claim keys is
 * visible (a box is drawn). Red only if the bug is real. Preconditions are asserted first.
 *
 * Rig: two real InkOverlayPlugin objects built off the prototype (the pattern K4.test.ts,
 * LassoDeleteHonestFailure.test.ts and FirstPaintSharedLoad.test.ts use), sharing the real module
 * `inlineInk` store (session-memory mode, no host), each with its own real SelectionModel. The real
 * prototype methods run: handleKeyDown, handleKeyUp, deleteSelectedInk, clearAllInk, applyInkOp,
 * redrawSelectionUI, selectionBounds, filePath. The one field built here, `selectionDeleteKeys`, is a
 * class-field initializer the prototype pattern cannot run; it is constructed with the exact wiring of
 * InkOverlay's selectionDeleteKeys initializer, and a source check below pins that wiring text.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin, inlineInk } from "../inline/InkOverlay";
import { InlineSelectionDeleteKeys } from "../inline/InlineSelectionDelete";
import { onInkChanged } from "../inline/InkEvents";
import { SelectionModel } from "../objects/SelectionModel";
import type { InkStroke } from "../ink/Stroke";

type Fields = Record<string, unknown>;
type Proto = {
	handleKeyDown(this: unknown, e: KeyboardEvent): boolean;
	handleKeyUp(this: unknown, e: KeyboardEvent): boolean;
	pruneSelectionOnInkChange(this: unknown, path: string): void;
	clearAllInk(this: unknown, path: string): number | null;
	applyInkOp(this: unknown, op: unknown): void;
	redrawSelectionUI(this: unknown): void;
	selectionBounds(this: unknown): unknown;
	filePath(this: unknown): string | null;
};
const proto = InkOverlayPlugin.prototype as unknown as Proto;

let n = 0;
const unsubscribers: Array<() => void> = [];

function stroke(id: string, x: number, y: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x, y, pressure: 0.5, t: 0 },
			{ x: x + 10, y: y + 10, pressure: 0.5, t: 8 },
		],
		bbox: { x, y, width: 10, height: 10 },
		createdAt: 1,
	};
}

/** One pane: a real overlay object showing `path`, its own SelectionModel, a recording tail. */
function pane(path: string) {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	const dispatched: unknown[] = [];
	o.view = {
		state: {
			field: () => ({ file: { path } }),
			selection: { main: { empty: true, from: 0, to: 0, anchor: 0, head: 0 } },
		},
		dom: { contains: () => true },
		dispatch: (spec: unknown) => void dispatched.push(spec),
	};
	o.selection = new SelectionModel();
	// Exact production class-field wiring, pinned by the source check below.
	o.selectionDeleteKeys = new InlineSelectionDeleteKeys(
		() => !(o.selection as SelectionModel).isEmpty,
		() => (o.deleteSelectedInk as () => void).call(o)
	);
	// Fields the exercised paths read.
	o.panAnchorHold = null;
	o.bouncedHold = null;
	o.damage = { addAll: () => undefined };
	o.indexDirty = false;
	o.repaintQueued = false;
	o.container = null; // scheduleRepaint stops before requesting a frame
	o.mobileTools = null;
	let stripRefreshes = 0;
	o.refreshStrip = () => void stripRefreshes++;
	const drawn = { box: 0, clears: 0 };
	o.tail = {
		clearAll: () => void drawn.clears++,
		drawLasso: () => undefined,
		drawSelectionBox: () => void drawn.box++,
		drawHead: () => undefined,
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
	};
	o.cssWidth = 800;
	o.cssHeight = 600;
	o.camera = { snapshot: { x: 0, y: 0, zoom: 1 } };
	o.lassoActive = false;
	o.lassoPts = [];
	o.spacePreview = null;
	o.spacePlan = null;
	o.builder = null;
	// The real store emits InkEvents; production's subscription calls this
	// same prototype method. Pin that call at the source-wiring test below.
	unsubscribers.push(onInkChanged((changed) => proto.pruneSelectionOnInkChange.call(o, changed)));
	return { o, dispatched, drawn, sel: () => o.selection as SelectionModel, stripRefreshes: () => stripRefreshes };
}

function key(k: "Backspace" | "Delete") {
	const preventDefault = vi.fn();
	const e = { key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, defaultPrevented: false, target: null, preventDefault } as unknown as KeyboardEvent;
	return { e, preventDefault };
}

/** A fresh press: keydown then keyup, as a real key tap. */
function press(o: Fields, k: "Backspace" | "Delete") {
	const down = key(k);
	const claimed = proto.handleKeyDown.call(o, down.e);
	const up = key(k);
	proto.handleKeyUp.call(o, up.e);
	return { claimed, prevented: down.preventDefault.mock.calls.length > 0 };
}

/** Lasso both strokes in `p` with a real polygon, as a pen lasso would. */
function lassoAll(p: ReturnType<typeof pane>, path: string) {
	const poly = [
		{ x: -50, y: -50 },
		{ x: 500, y: -50 },
		{ x: 500, y: 500 },
		{ x: -50, y: 500 },
	];
	p.sel().selectByLasso(poly, inlineInk.strokes(path), [], () => null);
}

function seed() {
	const path = "inlinestore3-" + ++n + ".md";
	inlineInk.commitGesture(path, [stroke("s1-" + n, 10, 10), stroke("s2-" + n, 100, 100)]);
	return path;
}

afterEach(() => {
	for (const off of unsubscribers.splice(0)) off();
	vi.restoreAllMocks();
});

describe("InlineStore-3 source wiring", () => {
	it("the keyboard handler is wired as the probe rig wires it", () => {
		const src = readFileSync(fileURLToPath(new URL("../inline/InkOverlay.ts", import.meta.url)), "utf8");
		const allLines = src.split(/\r?\n/);
		const start = allLines.findIndex((line) => line.includes("private readonly selectionDeleteKeys = new InlineSelectionDeleteKeys("));
		expect(start).toBeGreaterThan(0);
		const lines = allLines.slice(start, start + 4).map((l) => l.trim());
		expect(lines).toEqual([
			"private readonly selectionDeleteKeys = new InlineSelectionDeleteKeys(",
			"() => !this.selection.isEmpty,",
			"() => this.deleteSelectedInk()",
			");",
		]);
		const handlerStart = src.indexOf("this.offInkChanged = onInkChanged((p) => {");
		const handlerEnd = src.indexOf("\n\t\t});", handlerStart);
		expect(handlerStart).toBeGreaterThan(0);
		expect(handlerEnd).toBeGreaterThan(handlerStart);
		expect(src.slice(handlerStart, handlerEnd)).toContain("this.pruneSelectionOnInkChange(p);");
	});
});

describe("InlineStore-3 rig controls", () => {
	it("with nothing selected, Backspace goes to the editor; with a live lasso it deletes the ink", () => {
		const path = seed();
		const a = pane(path);
		expect(proto.filePath.call(a.o)).toBe(path);
		// Nothing selected: the rig CAN answer "not claimed".
		const idle = press(a.o, "Backspace");
		expect(idle).toEqual({ claimed: false, prevented: false });
		// A live lasso: the rig CAN answer "claimed", and the real delete removes the strokes.
		lassoAll(a, path);
		expect(a.sel().strokeIds.length).toBe(2);
		const live = press(a.o, "Backspace");
		expect(live).toEqual({ claimed: true, prevented: true });
		expect(inlineInk.strokes(path).length).toBe(0);
		expect(a.sel().isEmpty).toBe(true);
		// ...and the next press is the editor's again.
		expect(press(a.o, "Backspace")).toEqual({ claimed: false, prevented: false });
	});
});

describe("InlineStore-3: stale lasso in pane A after the ink is removed from pane B", () => {
	it("Delete all ink run in pane B: Backspace in pane A still reaches the editor", () => {
		const path = seed();
		const a = pane(path);
		const b = pane(path);
		lassoAll(a, path);

		// Preconditions: both panes show the note; A holds a live lasso of both strokes; B holds none.
		expect(proto.filePath.call(a.o)).toBe(path);
		expect(proto.filePath.call(b.o)).toBe(path);
		expect(inlineInk.strokes(path).map((s) => s.id)).toEqual(a.sel().strokeIds);
		expect(a.sel().strokeIds.length).toBe(2);
		expect(b.sel().isEmpty).toBe(true);

		// Trigger: Delete all ink lands on pane B (deleteAllInkOn picks the first instance showing the note).
		expect(proto.clearAllInk.call(b.o, path)).toBe(2);
		expect(inlineInk.strokes(path).length).toBe(0);
		expect(b.dispatched.length).toBe(1);
		expect(a.sel().isEmpty, "the ink-change event pruned A before a key press").toBe(true);
		expect(a.stripRefreshes()).toBe(1);

		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const presses = [press(a.o, "Backspace"), press(a.o, "Backspace"), press(a.o, "Delete")];
		const staleIdsLeft = a.sel().strokeIds.length;
		const unmatchedLogs = errors.mock.calls.filter((c) => String(c[0]).includes("lasso delete matched no strokes")).length;

		// CORRECT: the lassoed ink is gone, so text-editing keys in pane A belong to the editor.
		expect(
			presses,
			`pane A swallowed the keys: presses=${JSON.stringify(presses)} staleIdsLeft=${staleIdsLeft} unmatchedLogs=${unmatchedLogs}`
		).toEqual([
			{ claimed: false, prevented: false },
			{ claimed: false, prevented: false },
			{ claimed: false, prevented: false },
		]);
	});

	it("undo/redo in pane B removes the strokes: Backspace in pane A still reaches the editor", () => {
		const path = seed();
		const a = pane(path);
		const b = pane(path);
		lassoAll(a, path);
		const strokes = [...inlineInk.strokes(path)];
		expect(a.sel().strokeIds.length).toBe(2);

		// Trigger: pane B's editor history re-dispatches a remove op (undo of B's add, or redo of a delete).
		proto.applyInkOp.call(b.o, { type: "remove", path, strokes, indices: [0, 1] });
		expect(inlineInk.strokes(path).length).toBe(0);
		expect(a.sel().isEmpty, "undo/redo removal notified A").toBe(true);

		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const presses = [press(a.o, "Backspace"), press(a.o, "Backspace")];
		const unmatchedLogs = errors.mock.calls.filter((c) => String(c[0]).includes("lasso delete matched no strokes")).length;
		expect(
			presses,
			`pane A swallowed the keys: presses=${JSON.stringify(presses)} staleIdsLeft=${a.sel().strokeIds.length} unmatchedLogs=${unmatchedLogs}`
		).toEqual([
			{ claimed: false, prevented: false },
			{ claimed: false, prevented: false },
		]);
	});

	it("a selection that can still claim keys in pane A is visible (a box is drawn)", () => {
		const path = seed();
		const a = pane(path);
		const b = pane(path);
		lassoAll(a, path);

		// Control: with the ink present, pane A draws the selection box.
		proto.redrawSelectionUI.call(a.o);
		expect(a.drawn.box).toBe(1);

		expect(proto.clearAllInk.call(b.o, path)).toBe(2);
		expect(a.sel().isEmpty).toBe(true);
		expect(a.stripRefreshes()).toBe(1);
		a.drawn.box = 0;
		proto.redrawSelectionUI.call(a.o);

		const canClaim = !a.sel().isEmpty;
		// CORRECT: either the stale selection is gone, or the user can see it.
		expect(
			!canClaim || a.drawn.box > 0,
			`invisible live selection: ids=${JSON.stringify(a.sel().strokeIds)} bounds=${JSON.stringify(proto.selectionBounds.call(a.o))} boxesDrawn=${a.drawn.box}`
		).toBe(true);
	});

	it("keeps text protected when a live selected stroke is present but removal refuses", () => {
		const path = seed();
		const a = pane(path);
		lassoAll(a, path);
		vi.spyOn(inlineInk, "applyRemove").mockReturnValue([]);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(press(a.o, "Backspace")).toEqual({ claimed: true, prevented: true });
		expect(a.sel().strokeIds.length).toBe(2);
		expect(inlineInk.strokes(path).length).toBe(2);
	});

	it("removes a surviving selected stroke when another selected id has gone stale", () => {
		const path = seed();
		const a = pane(path);
		const b = pane(path);
		lassoAll(a, path);
		const removed = inlineInk.strokes(path)[0]!;
		proto.applyInkOp.call(b.o, { type: "remove", path, strokes: [removed], indices: [0] });
		expect(inlineInk.strokes(path)).toHaveLength(1);
		expect(a.sel().strokeIds).toHaveLength(1);
		expect(a.stripRefreshes()).toBe(1);
		expect(press(a.o, "Delete")).toEqual({ claimed: true, prevented: true });
		expect(inlineInk.strokes(path)).toHaveLength(0);
		expect(a.sel().isEmpty).toBe(true);
	});

	it("keeps the other pane's lasso during a live gesture and prunes it at gesture-end notification", () => {
		const path = seed();
		const a = pane(path);
		lassoAll(a, path);
		const selectedIds = a.sel().strokeIds;
		inlineInk.takeLive(path, selectedIds);
		expect(inlineInk.strokes(path)).toHaveLength(0);
		expect(a.sel().strokeIds).toEqual(selectedIds);
		expect(a.stripRefreshes()).toBe(0);
		inlineInk.save(path);
		expect(a.sel().isEmpty).toBe(true);
		expect(a.stripRefreshes()).toBe(1);
	});

	it("protects text if removal throws before the key decision", () => {
		const down = key("Backspace");
		const keys = new InlineSelectionDeleteKeys(
			() => true,
			() => { throw new Error("refused"); }
		);
		expect(() => keys.keydown(down.e)).toThrow("refused");
		expect(down.preventDefault).toHaveBeenCalledOnce();
	});
});
