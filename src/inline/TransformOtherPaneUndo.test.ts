/**
 * A lasso transform undone in one pane must not write over another pane's later move of the same strokes.
 *
 * Pane A lifts a scale of 1.5 on S about the opposite corner (the last point), so the first point moves: (0,0) to
 * (-5,-5). Pane B then moves S by +40 in x and records that move in its own history. Undo in A: the transform step is
 * inverted, so its `before` is the scaled shape the strokes should stand at now. The strokes no longer stand there (B
 * moved them), so A's undo must refuse and spend its step, as a move does (standsAt on op.before). A's undo leaves B's
 * move in place; B's own undo then returns S to exactly A's lifted shape, every point.
 * Before the fix the transform case checked holdsAll only, rewrote S to the original shape, and erased B's move.
 *
 * Control: the same pane, nothing moved since: undo applies (back to the original shape), redo applies (back to the
 * lifted shape). A check against op.after instead of op.before refuses here and fails the control.
 *
 * The real applyInkOp and CodeMirror history in both panes, over the real store; host I/O in memory, as in
 * RedoTwoPanes.test.ts.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState, Transaction, type StateCommand, type TransactionSpec } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport } from "./InkHistory";
import type { InlineInkHost } from "./InlineInkStore";
import type { StrokeShape } from "./LassoTransform";
import { SelectionModel } from "../objects/SelectionModel";
import { emptyPage, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const PATH = "transform-other-pane-undo.md";
const PAGE = "transform-other-pane-undo-id";

beforeEach(async () => {
	vi.stubGlobal("window", globalThis);
	inlineInk.attachHost({
		readPageId: (p) => (p === PATH ? PAGE : null),
		claimId: async () => ({ pageId: PAGE }),
		loadSidecar: async (): Promise<ParseResult> => {
			const page = emptyPage(PAGE);
			page.surface = "inline";
			return { data: page, recovered: false };
		},
		scheduleSidecar() {},
		notify() {},
	});
	await inlineInk.ensureLoaded(PATH);
});
afterEach(() => {
	inlineInk.handleDelete(PATH);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.unstubAllGlobals();
});

function stroke(id: string): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2, createdAt: 0,
		points: [{ x: 0, y: 0, pressure: 0.5, t: 0 }, { x: 10, y: 10, pressure: 0.5, t: 8 }],
		bbox: { x: 0, y: 0, width: 10, height: 10 },
	};
}

/** The stroke's shape scaled by `factor` about `pivot` (the opposite corner), as a lasso transform records it. */
function shapeOf(s: InkStroke, factor: number, pivot = { x: 0, y: 0 }): StrokeShape {
	const points = s.points.map((p) => ({
		...p,
		x: pivot.x + factor * (p.x - pivot.x),
		y: pivot.y + factor * (p.y - pivot.y),
	}));
	const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
	const x0 = Math.min(...xs), y0 = Math.min(...ys);
	return {
		points,
		width: s.width,
		bbox: { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 },
	};
}

/** One pane: an overlay with its own editor state and history, replaying ink ops through the real applyInkOp. */
function pane() {
	let state = EditorState.create({ doc: "note", extensions: [history(), inkHistorySupport()] });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	Object.assign(overlay, {
		filePath: () => PATH, selection: new SelectionModel(),
		scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {},
	});
	const dispatch = (input: Transaction | TransactionSpec) => {
		const tr = input instanceof Transaction ? input : state.update(input);
		state = tr.state;
		for (const e of tr.effects) if (e.is(inkEffect) && !tr.annotation(inkApplied)) overlay.applyInkOp(e.value);
	};
	overlay.view = { get state() { return state; }, dispatch };
	return {
		run: (c: StateCommand) => c({ state, dispatch }),
		draw(s: InkStroke) {
			inlineInk.commit(PATH, s);
			overlay.dispatchInk({ type: "add", path: PATH, strokes: [s] });
		},
		/** The lift about the opposite corner: the store takes the scaled shape, then the step is recorded in this pane. */
		scale(s: InkStroke, factor: number, pivot: { x: number; y: number }) {
			const before = shapeOf(s, 1);
			const after = shapeOf(s, factor, pivot);
			inlineInk.rewriteStrokes(PATH, [{ id: s.id, shape: after }]);
			overlay.dispatchInk({ type: "transform", path: PATH, strokeIds: [s.id], before: [before], after: [after] });
			return after;
		},
		/** A move of the stroke by dx in this pane, recorded in this pane's history; `from` is where it stood before. */
		move(id: string, dx: number, from: { x: number; y: number }) {
			inlineInk.moveStrokes(PATH, [id], dx, 0);
			overlay.dispatchInk({ type: "move", path: PATH, strokeIds: [id], dx, dy: 0, from: [from] });
		},
	};
}

const pts = (id: string) => inlineInk.strokes(PATH).find((s) => s.id === id)!.points.map((p) => ({ x: p.x, y: p.y }));

const ORIGINAL = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
const LIFTED = [{ x: -5, y: -5 }, { x: 10, y: 10 }];

it("an undo of a transform in one pane does not write over a move another pane made since, and the other pane's undo still works", () => {
	const a = pane(), b = pane();
	const s = stroke("S");
	a.draw(s);
	a.scale(s, 1.5, { x: 10, y: 10 });
	expect(pts("S"), "precondition: A's lift stands").toEqual(LIFTED);
	// Pane B moves the lifted stroke by +40 in x; its own history records that move.
	b.move("S", 40, LIFTED[0]!);
	expect(pts("S")[0]!.x, "precondition: B's move stands").toBe(35);
	expect(a.run(undo), "A's undo still spends its step").toBe(true);
	expect(pts("S")[0]!.x, "A's undo wrote over B's move").toBe(35);
	expect(b.run(undo), "B's own undo still works").toBe(true);
	expect(pts("S"), "B's undo does not return to A's lifted shape").toEqual(LIFTED);
});

it("control: in the same pane with nothing moved since, undo returns to the original shape and redo to the lifted one", () => {
	const a = pane();
	const s = stroke("S");
	a.draw(s);
	a.scale(s, 1.5, { x: 10, y: 10 });
	expect(pts("S")).toEqual(LIFTED);
	expect(a.run(undo), "undo applies").toBe(true);
	expect(pts("S"), "undo did not restore the original shape").toEqual(ORIGINAL);
	expect(a.run(redo), "redo applies").toBe(true);
	expect(pts("S"), "redo did not restore the lifted shape").toEqual(LIFTED);
});
