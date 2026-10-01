/**
 * A live erase or selection drag that never reaches its pen-up, and the keys
 * and tool changes that clear a selection with the pen still down.
 *
 * Erase and drag change the store live and save and record their undo step
 * only at pen-up. A file switch, rename, close or window blur mid-gesture
 * tears the gesture down with no pen-up: the change stayed on screen, reached
 * the disk with the next save, and no undo could take it back. Escape, Delete
 * or a tool change mid-drag cleared the selection first, so the pen-up saved
 * the part-moved ink with a move op that named no strokes, and a Delete's
 * step came before the move it followed.
 *
 * Also here: undo taking the selected ink away, and Delete all, left the
 * dashed selection box drawn around empty space.
 *
 * Rig: a REAL InkOverlayPlugin (the constructor registers it; mount stays
 * inert on an empty editor state), the REAL inlineInk store in memory mode,
 * the REAL eraseAt, lassoMove, lassoUp, resetGestureState, dissolveSelection,
 * deleteSelectedInk, applyInkOp, clearAllInk and SelectionModel. The editor
 * dispatch is recorded instead of applied (`dispatchInk` is the boundary to
 * CodeMirror's history), and the chrome redraw is counted, not drawn. The
 * gesture fields pen-down sets are set as pen-down sets them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import type { InkStroke } from "../ink/Stroke";
import type { InkOp } from "./InkHistory";
import { resetTipModeForTest } from "./TipMode";

type Fields = Record<string, any>;
const noop = (): undefined => undefined;
let serial = 0;
const made: Fields[] = [];
const paths = new Set<string>();

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	resetTipModeForTest();
});
afterEach(() => {
	for (const o of made.splice(0)) {
		try { (o.destroy as () => void)(); } catch { /* inert rig: teardown of unmounted parts */ }
	}
	for (const p of paths) inlineInk.handleDelete(p);
	paths.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function stroke(id: string, x: number, y: number): InkStroke {
	const points = [];
	for (let i = 0; i <= 10; i++) points.push({ x: x + i * 4, y: y + (i % 2) * 6, pressure: 0.5, t: i * 8 });
	return { id, tool: "pen", color: "#000000", width: 2, points, bbox: { x, y, width: 40, height: 6 }, createdAt: 0 };
}

/** What the note holds, in order: id and first point. */
const snapshot = (path: string) => inlineInk.strokes(path).map((s) => `${s.id}@${s.points[0]!.x},${s.points[0]!.y}`);

function overlay(path: () => string) {
	const win = {
		requestAnimationFrame: () => 1, cancelAnimationFrame: noop, setTimeout: () => 0, clearTimeout: noop,
		devicePixelRatio: 1, getComputedStyle: () => ({ fontSize: "16px" }),
	};
	const classList = { add: noop, remove: noop, contains: () => false, toggle: noop };
	const view = {
		dom: { isConnected: true, ownerDocument: { defaultView: win }, parentElement: null },
		scrollDOM: { addEventListener: noop, removeEventListener: noop, classList },
		contentDOM: {},
		state: { field: () => undefined },
	};
	const o = new InkOverlayPlugin(view as never) as unknown as Fields;
	made.push(o);
	const ops: InkOp[] = [];
	let chromeRedraws = 0;
	Object.assign(o, {
		container: {}, scale: 1, cssScale: 1,
		filePath: path,
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 } },
		redrawSelectionUI: () => { chromeRedraws++; },
		dispatchInk: (op: InkOp) => { ops.push(op); },
		refreshStrip: noop,
		retirePanSettle: noop,
		indexDirty: true,
	});
	return { o, ops, chromeRedraws: () => chromeRedraws };
}

async function rig() {
	const path = `live-gesture-rollback-${++serial}.md`;
	paths.add(path);
	await inlineInk.ensureLoaded(path);
	const strokes: InkStroke[] = [];
	for (let i = 0; i < 12; i++) strokes.push(stroke(`s${i}`, (i % 4) * 60, Math.floor(i / 4) * 40));
	inlineInk.applyAddLive(path, strokes);
	let current = path;
	const pane = overlay(() => current);
	return { path, ...pane, switchTo: (p: string) => { current = p; } };
}

const sample = (x: number, y: number) => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

/** A selection drag under way: what lassoDown sets when the pen lands inside a selection. */
function startDrag(o: Fields, path: string, ids: string[]): void {
	(o.selection as { selectExactly(ids: readonly string[]): void }).selectExactly(ids);
	o.mode = "lasso";
	o.dragFrom = { x: 10, y: 10 };
	o.dragTotal = { dx: 0, dy: 0 };
	o.dragIds = [...ids];
	o.dragHistoryIdentity = inlineInk.captureHistoryIdentity(path);
}

describe("a live erase or drag torn down mid-gesture puts the note back", () => {
	it("erase: a note switch with the pen down restores the note as the gesture found it, and saves that", async () => {
		const r = await rig();
		const before = snapshot(r.path);
		const save = vi.spyOn(inlineInk, "save");
		// Erase pen-down, as penDown sets it (partial erase).
		Object.assign(r.o, {
			mode: "erase", eraseWhole: false,
			eraseFrom: [...inlineInk.strokes(r.path)],
			eraseHistoryIdentity: inlineInk.captureHistoryIdentity(r.path),
		});
		// A pass through the middle of s1 and s5: both split live.
		for (let y = 0; y <= 46; y += 4) r.o.eraseAt(sample(80, y));
		const during = snapshot(r.path);
		expect(during, "precondition: the live erase changed the note").not.toEqual(before);
		expect((r.o.erased as unknown[]).length, "precondition: originals recorded").toBeGreaterThan(0);

		r.switchTo("another-note.md");
		r.o.resetGestureState();

		expect(snapshot(r.path), "the note as the gesture found it").toEqual(before);
		expect(save.mock.calls.some(([p]) => p === r.path), "the restored note is saved").toBe(true);
		expect(r.ops, "no history step for a gesture that never finished").toEqual([]);
	});

	it("drag: a note switch with the pen down moves the ink back and saves that", async () => {
		const r = await rig();
		const before = snapshot(r.path);
		const save = vi.spyOn(inlineInk, "save");
		startDrag(r.o, r.path, ["s0", "s5"]);
		for (let i = 1; i <= 5; i++) r.o.lassoMove([sample(10 + i * 7, 10 + i * 3)]);
		expect(snapshot(r.path), "precondition: the live drag moved the ink").not.toEqual(before);

		r.switchTo("another-note.md");
		r.o.resetGestureState();

		expect(snapshot(r.path)).toEqual(before);
		expect(save.mock.calls.some(([p]) => p === r.path)).toBe(true);
		expect(r.ops).toEqual([]);
	});

	it("control: a drag that finishes at pen-up keeps its move and records it", async () => {
		const r = await rig();
		startDrag(r.o, r.path, ["s0", "s5"]);
		for (let i = 1; i <= 5; i++) r.o.lassoMove([sample(10 + i * 7, 10 + i * 3)]);
		const moved = snapshot(r.path);
		r.o.lassoUp();
		r.o.resetGestureState();
		expect(snapshot(r.path), "a finished drag is not rolled back by a later reset").toEqual(moved);
		expect(r.ops.map((op) => op.type)).toEqual(["move"]);
	});
});

describe("Escape, Delete and a tool change mid-drag", () => {
	const dragged = async () => {
		const r = await rig();
		startDrag(r.o, r.path, ["s0", "s5"]);
		for (let i = 1; i <= 5; i++) r.o.lassoMove([sample(10 + i * 7, 10 + i * 3)]);
		return r;
	};
	const moveOf = (op: InkOp | undefined) => op && op.type === "move" ? { ids: [...op.strokeIds].sort(), dx: op.dx, dy: op.dy } : op;

	it("a tool change: the move so far is recorded at the lift as a move of the dragged strokes, once", async () => {
		const r = await dragged();
		r.o.dissolveSelection();
		r.o.lassoUp();
		expect(r.ops.map(moveOf)).toEqual([{ ids: ["s0", "s5"], dx: 35, dy: 15 }]);
	});

	it("Escape deselects, and the move so far is recorded at the lift as a move of the dragged strokes", async () => {
		const r = await dragged();
		const handled = r.o.handleKeyDown({ key: "Escape", preventDefault: noop } as unknown as KeyboardEvent);
		expect(handled).toBe(true);
		expect((r.o.selection as { isEmpty: boolean }).isEmpty).toBe(true);
		r.o.lassoUp();
		expect(r.ops.map(moveOf)).toEqual([{ ids: ["s0", "s5"], dx: 35, dy: 15 }]);
	});

	it("Delete commits the move so far, then deletes: two steps, move first", async () => {
		const r = await dragged();
		r.o.deleteSelectedInk();
		r.o.lassoUp();
		expect(r.ops.map((op) => op.type)).toEqual(["move", "remove"]);
		expect(moveOf(r.ops[0])).toEqual({ ids: ["s0", "s5"], dx: 35, dy: 15 });
	});
});

describe("selection chrome follows the ink it surrounds", () => {
	it("undo taking the selected ink away redraws the chrome", async () => {
		const r = await rig();
		(r.o.selection as { selectExactly(ids: readonly string[]): void }).selectExactly(["s0"]);
		const s0 = inlineInk.strokes(r.path).find((s) => s.id === "s0")!;
		const before = r.chromeRedraws();
		// The undo of a paste: a remove op for what the paste added.
		r.o.applyInkOp({ type: "remove", path: r.path, strokes: [s0], indices: [0] });
		expect((r.o.selection as { isEmpty: boolean }).isEmpty, "precondition: prune emptied the selection").toBe(true);
		expect(r.chromeRedraws() - before, "chrome redrawn once the box has nothing in it").toBeGreaterThan(0);
	});

	it("Delete all ink with a selection redraws the chrome", async () => {
		const r = await rig();
		(r.o.selection as { selectExactly(ids: readonly string[]): void }).selectExactly(["s0", "s1"]);
		const before = r.chromeRedraws();
		expect(r.o.clearAllInk(r.path)).toBe(12);
		expect(r.chromeRedraws() - before).toBeGreaterThan(0);
	});

	it("control: an undo that leaves the selection whole does not redraw the chrome", async () => {
		const r = await rig();
		(r.o.selection as { selectExactly(ids: readonly string[]): void }).selectExactly(["s0"]);
		const s9 = inlineInk.strokes(r.path).find((s) => s.id === "s9")!;
		const before = r.chromeRedraws();
		r.o.applyInkOp({ type: "remove", path: r.path, strokes: [s9], indices: [9] });
		expect(r.chromeRedraws() - before).toBe(0);
	});
});

/**
 * With the pen still down after Escape or a tool change let go
 * of the selection, further movement kept adding to the recorded move while the ink it named no longer moved, so
 * one undo overshot the originals by the part after the let-go. Letting go ends the move: the ink stays where it
 * was let go for the rest of the contact, and the lift records, and undo reverses, exactly what moved.
 */
describe("movement after Escape or a tool change lets go of the selection", () => {
	const letGo = async (clear: "escape" | "tool") => {
		const r = await rig();
		const before = snapshot(r.path);
		startDrag(r.o, r.path, ["s0", "s5"]);
		r.o.lassoMove([sample(45, 25)]);
		if (clear === "escape") r.o.handleKeyDown({ key: "Escape", preventDefault: noop } as unknown as KeyboardEvent);
		else r.o.dissolveSelection();
		const atLetGo = snapshot(r.path);
		r.o.lassoMove([sample(80, 40)]);
		expect(snapshot(r.path), "the ink stays where it was let go").toEqual(atLetGo);
		return { ...r, before };
	};

	for (const clear of ["escape", "tool"] as const) {
		it(`${clear}: the lift records only the move that happened, and one undo puts the ink back exactly`, async () => {
			const r = await letGo(clear);
			r.o.lassoUp();
			expect(r.ops).toHaveLength(1);
			const op = r.ops[0]!;
			expect(op.type === "move" ? { ids: [...op.strokeIds].sort(), dx: op.dx, dy: op.dy } : op).toEqual({ ids: ["s0", "s5"], dx: 35, dy: 15 });
			const { invertInkOp } = await import("./InkHistory");
			r.o.applyInkOp(invertInkOp(op));
			expect(snapshot(r.path), "undo reverses exactly the movement applied").toEqual(r.before);
		});

		it(`${clear}: a note switch before the lift puts the ink back exactly and records nothing`, async () => {
			const r = await letGo(clear);
			r.switchTo("another-note.md");
			r.o.resetGestureState();
			expect(snapshot(r.path), "the rollback reverses exactly the movement applied").toEqual(r.before);
			expect(r.ops).toEqual([]);
		});
	}
});
