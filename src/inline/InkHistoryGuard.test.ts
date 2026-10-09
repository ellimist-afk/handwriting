import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, StateEffect, Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { history, invertedEffects, isolateHistory, redo, undo } from "@codemirror/commands";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { eraseRemovalIndices, inkApplied, inkEffect, inkHistorySupport } from "./InkHistory";
import type { InkStroke } from "../ink/Stroke";

const observations: Array<Record<string, unknown>> = [];
const queued: Array<() => Record<string, unknown>> = [];
vi.mock("../diag/UndoHistoryTrace", () => ({
	recordUndoObservation: (_identity: unknown, record: Record<string, unknown>) => void observations.push(record),
	queueUndoPostObservation: (_identity: unknown, _epoch: number, read: () => Record<string, unknown>) => void queued.push(read),
	undoTraceIdentityForView: () => ({}),
}));

/** An effect type from an earlier load of the plugin: not `inkEffect`, but carrying an ink op's shape. */
const legacy = StateEffect.define<unknown>();
const foreign = StateEffect.define<number>();

function editor() {
	let snapshots = 0;
	const snapshot = StateEffect.define<number>();
	const dispatched: Transaction[] = [];
	const view = {
		state: EditorState.create({
			doc: "hello",
			extensions: [
				history(),
				inkHistorySupport(),
				invertedEffects.of((tr) => tr.effects.filter((e) => e.is(legacy)).map((e) => legacy.of(e.value))),
				invertedEffects.of((tr) => tr.effects.filter((e) => e.is(foreign)).map((e) => foreign.of(-e.value))),
			],
		}),
		scrollDOM: { scrollLeft: 7, scrollTop: 9 },
		scrollSnapshot: () => snapshot.of(++snapshots),
		dispatch(spec: TransactionSpec | Transaction) {
			const tr = spec instanceof Transaction ? spec : this.state.update(spec);
			const startState = this.state;
			this.state = tr.state;
			dispatched.push(tr);
			const update = { view: this, startState, state: this.state, transactions: [tr] } as unknown as ViewUpdate;
			for (const listener of this.state.facet(EditorView.updateListener)) listener(update);
		},
	};
	const run = (command: typeof undo) => command({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
	const listener = () => view.state.facet(EditorView.updateListener)[0]!;
	return { view, run, snapshots: () => snapshots, dispatched, listener };
}

function withEffect(value: unknown): ReturnType<typeof editor> {
	const h = editor();
	h.view.dispatch({ effects: legacy.of(value), annotations: [isolateHistory.of("full")] });
	return h;
}

beforeEach(() => {
	observations.length = 0;
	queued.length = 0;
});
afterEach(() => setDiagnosticsEnabled(false));

describe("an ink step an earlier load of the plugin wrote is still known by its shape", () => {
	const known: Array<[string, unknown]> = [
		["add", { type: "add", path: "n.md", strokes: [] }],
		["remove", { type: "remove", path: "n.md", strokes: [] }],
		["move", { type: "move", path: "n.md", strokeIds: ["s"], dx: 1, dy: 2 }],
		["replace", { type: "replace", path: "n.md", removed: [], inserted: [] }],
	];
	for (const [name, op] of known) {
		it(`restores the viewport for an undone ${name}`, () => {
			const h = withEffect(op);
			expect(h.run(undo)).toBe(true);
			expect(h.snapshots()).toBe(1);
		});
	}

	const unknown: Array<[string, unknown]> = [
		["a null value", null],
		["a string value", "move"],
		["a number value", 3],
		["no path", { type: "move", strokeIds: ["s"], dx: 1, dy: 2 }],
		["a path that is not text", { type: "move", path: 4, strokeIds: ["s"], dx: 1, dy: 2 }],
		["a type it does not know", { type: "rotate", path: "n.md", strokes: [] }],
		["an add with no stroke list", { type: "add", path: "n.md", strokes: "x" }],
		["a remove with no stroke list", { type: "remove", path: "n.md" }],
		["a move with no ids", { type: "move", path: "n.md", dx: 1, dy: 2 }],
		["a move with a text dx", { type: "move", path: "n.md", strokeIds: ["s"], dx: "1", dy: 2 }],
		["a move with a text dy", { type: "move", path: "n.md", strokeIds: ["s"], dx: 1, dy: "2" }],
		["a replace with no inserted list", { type: "replace", path: "n.md", removed: [] }],
		["a replace with no removed list", { type: "replace", path: "n.md", inserted: [] }],
	];
	for (const [name, op] of unknown) {
		it(`leaves the viewport alone for ${name}`, () => {
			const h = withEffect(op);
			expect(h.run(undo)).toBe(true);
			expect(h.snapshots()).toBe(0);
		});
	}

	it("knows a current ink effect without reading its shape", () => {
		const h = editor();
		h.view.dispatch({
			effects: inkEffect.of({ type: "move", path: "n.md", strokeIds: ["s"], dx: 1, dy: 2 }),
			annotations: [inkApplied.of(true), isolateHistory.of("full")],
		});
		expect(h.run(undo)).toBe(true);
		expect(h.snapshots()).toBe(1);
		expect(h.run(redo)).toBe(true);
		expect(h.snapshots()).toBe(2);
	});
});

describe("the guard leaves anything that is not one undo of ink alone", () => {
	const inkOp = { type: "move" as const, path: "n.md", strokeIds: ["s"], dx: 1, dy: 2 };

	function undoTransaction(h: ReturnType<typeof editor>): Transaction {
		h.view.dispatch({ effects: inkEffect.of(inkOp), annotations: [inkApplied.of(true), isolateHistory.of("full")] });
		h.run(undo);
		const tr = h.dispatched.find((t) => t.isUserEvent("undo"));
		return tr!;
	}

	function call(h: ReturnType<typeof editor>, update: Partial<ViewUpdate> & { transactions: Transaction[] }): number {
		const before = h.dispatched.length;
		const startState = h.view.state;
		const full = { view: h.view, startState, state: h.view.state, ...update } as unknown as ViewUpdate;
		h.listener()(full);
		return h.dispatched.length - before;
	}

	it("acts on one undo of ink alone (the control for the cases below)", () => {
		const h = editor();
		const tr = undoTransaction(h);
		expect(call(h, { transactions: [tr] })).toBe(1);
	});

	it("does nothing when the view has moved on from the state of the update", () => {
		const h = editor();
		const tr = undoTransaction(h);
		const stale = EditorState.create({ doc: "other" });
		expect(call(h, { transactions: [tr], state: stale })).toBe(0);
	});

	it("does nothing for an update that carries two transactions", () => {
		const h = editor();
		const tr = undoTransaction(h);
		expect(call(h, { transactions: [tr, tr] })).toBe(0);
	});

	it("does nothing for an update that carries none", () => {
		const h = editor();
		undoTransaction(h);
		expect(call(h, { transactions: [] })).toBe(0);
	});

	it("does nothing for an undo that has no effects at all", () => {
		const h = editor();
		const tr = h.view.state.update({ userEvent: "undo" });
		expect(tr.effects).toHaveLength(0);
		expect(call(h, { transactions: [tr] })).toBe(0);
	});

	it("does nothing when an effect in the undo is not an ink step", () => {
		const h = editor();
		const tr = h.view.state.update({ userEvent: "undo", effects: [inkEffect.of(inkOp), foreign.of(1)] });
		expect(call(h, { transactions: [tr] })).toBe(0);
	});

	it("does nothing for an undo that changed the text", () => {
		const h = editor();
		const tr = h.view.state.update({ userEvent: "undo", changes: { from: 0, insert: "x" }, effects: [inkEffect.of(inkOp)] });
		expect(call(h, { transactions: [tr] })).toBe(0);
	});

	it("does nothing for an ink step that is neither an undo nor a redo", () => {
		const h = editor();
		const tr = h.view.state.update({ effects: [inkEffect.of(inkOp)] });
		expect(call(h, { transactions: [tr] })).toBe(0);
		const select = h.view.state.update({ userEvent: "select", effects: [inkEffect.of(inkOp)] });
		expect(call(h, { transactions: [select] })).toBe(0);
	});

	it("acts on a redo as it does on an undo", () => {
		const h = editor();
		const tr = h.view.state.update({ userEvent: "redo", effects: [inkEffect.of(inkOp)] });
		expect(call(h, { transactions: [tr] })).toBe(1);
	});
});

describe("with diagnostics on, the guard tells the trace what it decided and why", () => {
	const inkOp = { type: "move" as const, path: "n.md", strokeIds: ["s"], dx: 1, dy: 2 };

	function guards(): Array<Record<string, unknown>> {
		return observations.filter((o) => o.guard !== undefined).map((o) => o.guard as Record<string, unknown>);
	}

	function callWith(h: ReturnType<typeof editor>, update: Partial<ViewUpdate> & { transactions: Transaction[] }): void {
		const full = { view: h.view, startState: h.view.state, state: h.view.state, ...update } as unknown as ViewUpdate;
		h.listener()(full);
	}

	it("says nothing at all when diagnostics are off", () => {
		const h = editor();
		h.view.dispatch({ effects: inkEffect.of(inkOp), annotations: [inkApplied.of(true), isolateHistory.of("full")] });
		h.run(undo);
		expect(observations).toEqual([]);
		expect(queued).toEqual([]);
	});

	it("records each transaction it is handed, numbered from one", () => {
		setDiagnosticsEnabled(true);
		const h = editor();
		const tr = h.view.state.update({ userEvent: "undo", effects: [inkEffect.of(inkOp), foreign.of(1)] });
		callWith(h, { transactions: [tr, tr] });
		const txs = observations.filter((o) => o.transaction !== undefined && (o.transaction as { sequence?: number }).sequence !== undefined);
		expect(txs.map((o) => o.transaction)).toEqual([
			{ sequence: 1, count: 2, userEvent: "undo", docChanged: false, inkEffectCount: 1, foreignEffectCount: 1 },
			{ sequence: 2, count: 2, userEvent: "undo", docChanged: false, inkEffectCount: 1, foreignEffectCount: 1 },
		]);
	});

	it("names a redo and an unrelated transaction as such", () => {
		setDiagnosticsEnabled(true);
		const h = editor();
		const redoTr = h.view.state.update({ userEvent: "redo", effects: [inkEffect.of(inkOp)] });
		const eventsOf = () =>
			observations
				.filter((o) => o.transaction !== undefined && (o.transaction as { userEvent?: string }).userEvent !== undefined)
				.map((o) => (o.transaction as { userEvent: string }).userEvent);
		callWith(h, { transactions: [redoTr] });
		expect(eventsOf()[0]).toBe("redo");
		observations.length = 0;
		const plain = h.view.state.update({ effects: [] });
		callWith(h, { transactions: [plain] });
		expect(eventsOf()[0]).toBe("other");
	});

	const reasons: Array<[string, (h: ReturnType<typeof editor>) => Partial<ViewUpdate> & { transactions: Transaction[] }]> = [
		["stale-view", (h) => ({ transactions: [h.view.state.update({ userEvent: "undo", effects: [inkEffect.of(inkOp)] })], state: EditorState.create({ doc: "x" }) })],
		["multiple-transactions", (h) => {
			const tr = h.view.state.update({ userEvent: "undo", effects: [inkEffect.of(inkOp)] });
			return { transactions: [tr, tr] };
		}],
		// An update with no transaction at all reads as "multiple-transactions": the count is checked first.
		["multiple-transactions", () => ({ transactions: [] })],
		["document-change", (h) => ({ transactions: [h.view.state.update({ userEvent: "undo", changes: { from: 0, insert: "x" }, effects: [inkEffect.of(inkOp)] })] })],
		["non-history-transaction", (h) => ({ transactions: [h.view.state.update({ effects: [inkEffect.of(inkOp)] })] })],
		["no-effects", (h) => ({ transactions: [h.view.state.update({ userEvent: "undo" })] })],
		["foreign-effects", (h) => ({ transactions: [h.view.state.update({ userEvent: "undo", effects: [inkEffect.of(inkOp), foreign.of(1)] })] })],
	];
	for (const [reason, make] of reasons) {
		it(`records a skip for ${reason} and does not touch the view`, () => {
			setDiagnosticsEnabled(true);
			const h = editor();
			const update = make(h);
			const before = h.dispatched.length;
			callWith(h, update);
			expect(h.dispatched.length - before).toBe(0);
			expect(guards()).toEqual([{ decision: "skip", stage: "observed", reason }]);
			expect(queued).toHaveLength(0);
		});
	}

	it("records the restore it asks for, then reads the selection and scroll after the view settles", () => {
		setDiagnosticsEnabled(true);
		const h = editor();
		h.view.dispatch({ selection: { anchor: 2, head: 4 } });
		observations.length = 0;
		const tr = h.view.state.update({ userEvent: "undo", effects: [inkEffect.of(inkOp)] });
		callWith(h, { transactions: [tr] });
		expect(guards()[0]).toEqual({ decision: "restore", stage: "request", reason: "effect-only-history" });
		expect(h.dispatched.at(-1)?.annotation(Transaction.addToHistory)).toBe(false);
		expect(queued).toHaveLength(1);
		const post = queued[0]!();
		expect(post).toMatchObject({
			phase: "post",
			guard: { decision: "restore", stage: "observed", reason: "effect-only-history" },
			selection: { from: 2, to: 4, anchor: 2, head: 4, empty: false },
			scroll: { x: 7, y: 9, phase: "after", axes: "" },
		});
	});

	it("acts as it does with diagnostics off: one restore for one undo of ink", () => {
		setDiagnosticsEnabled(true);
		const h = editor();
		h.view.dispatch({ effects: inkEffect.of(inkOp), annotations: [inkApplied.of(true), isolateHistory.of("full")] });
		h.run(undo);
		expect(h.snapshots()).toBe(1);
	});
});

describe("the index a removal is restored to", () => {
	const s = (id: string) => ({ id }) as unknown as InkStroke;
	it("names the stroke's place in the list as the gesture found it, including the first place", () => {
		const a = s("a");
		const b = s("b");
		const c = s("c");
		expect(eraseRemovalIndices([a, b, c], [{ stroke: a, index: 5 }])).toEqual([0]);
		expect(eraseRemovalIndices([a, b, c], [{ stroke: c, index: 9 }, { stroke: b, index: 8 }])).toEqual([2, 1]);
	});
	it("keeps the index the removal reported for a stroke the list never held", () => {
		expect(eraseRemovalIndices([s("a")], [{ stroke: s("z"), index: 4 }])).toEqual([4]);
	});
});
