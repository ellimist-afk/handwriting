/**
 * The lasso's resize and rotate step in the editor history: its inverse swaps the before and after copies, and an undo of it
 * is an ink step, never a foreign effect, including one an earlier load of the plugin wrote (known by its shape).
 */
import { describe, expect, it, vi } from "vitest";
import { EditorState, StateEffect, Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { history, invertedEffects, isolateHistory, undo } from "@codemirror/commands";
import { inkEffect, inkHistorySupport, invertInkOp, type InkOp } from "./InkHistory";
import type { StrokeShape } from "./LassoTransform";

vi.mock("../diag/UndoHistoryTrace", () => ({
	recordUndoObservation: () => {},
	queueUndoPostObservation: () => {},
	undoTraceIdentityForView: () => ({}),
}));

/** An effect type from an earlier load of the plugin: not `inkEffect`, but carrying an ink op's shape. */
const legacy = StateEffect.define<unknown>();

function editor() {
	let snapshots = 0;
	const snapshot = StateEffect.define<number>();
	const view = {
		state: EditorState.create({
			doc: "hello",
			extensions: [history(), inkHistorySupport(), invertedEffects.of((tr) => tr.effects.filter((e) => e.is(legacy)).map((e) => legacy.of(e.value)))],
		}),
		scrollDOM: { scrollLeft: 7, scrollTop: 9 },
		scrollSnapshot: () => snapshot.of(++snapshots),
		dispatch(spec: TransactionSpec | Transaction) {
			const tr = spec instanceof Transaction ? spec : this.state.update(spec);
			const startState = this.state;
			this.state = tr.state;
			const update = { view: this, startState, state: this.state, transactions: [tr] } as unknown as ViewUpdate;
			for (const listener of this.state.facet(EditorView.updateListener)) listener(update);
		},
	};
	const run = () => undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
	return { view, run, snapshots: () => snapshots };
}

const shape = (x: number, width: number): StrokeShape => ({
	points: [{ x, y: 2, pressure: 0.5, t: 0 }],
	width,
	bbox: { x, y: 2, width: 0, height: 0 },
});

function transformOp(): InkOp {
	return { type: "transform", path: "n.md", strokeIds: ["s"], before: [shape(1, 1)], after: [shape(5, 2)] };
}

describe("the transform step in the history", () => {
	it("inverts by swapping its before and after copies, the same objects, ids and identity kept", () => {
		// Defect: the inverse recomputes the shapes, or drops the identity, so the undo cannot find its note.
		const id = Symbol("note");
		const op = { ...transformOp(), historyIdentity: id, pageId: "p" } as InkOp & { before: StrokeShape[]; after: StrokeShape[] };
		const inv = invertInkOp(op) as typeof op;
		expect(inv).toMatchObject({ type: "transform", path: "n.md", strokeIds: ["s"], historyIdentity: id, pageId: "p" });
		expect(inv.before).toBe(op.after);
		expect(inv.after).toBe(op.before);
		expect((invertInkOp(inv) as typeof op).after).toBe(op.after);
	});

	it("an undo of it is an ink step: the viewport is restored, as for a move (control: a current ink effect)", () => {
		// Defect: the guard reads the transform as a foreign effect and the undo scrolls to an old caret.
		const h = editor();
		h.view.dispatch({ effects: inkEffect.of(transformOp()), annotations: [isolateHistory.of("full")] });
		expect(h.run()).toBe(true);
		expect(h.snapshots()).toBe(1);
	});

	it("one an earlier load wrote is known by its shape; one missing a copy list is not", () => {
		// Defect: a reload of the plugin leaves the transform steps in the history unknown to the guard.
		const known = editor();
		known.view.dispatch({ effects: legacy.of(transformOp()), annotations: [isolateHistory.of("full")] });
		expect(known.run()).toBe(true);
		expect(known.snapshots()).toBe(1);
		const broken = editor();
		broken.view.dispatch({ effects: legacy.of({ ...transformOp(), after: undefined }), annotations: [isolateHistory.of("full")] });
		expect(broken.run()).toBe(true);
		expect(broken.snapshots()).toBe(0);
	});
});
