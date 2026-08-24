/**
 * Ink ops as CodeMirror history citizens — proven against the REAL
 * @codemirror/commands history plugin, headless. This is the mechanism that
 * makes plain Ctrl+Z / Redo cover ink: if these pass, the editor's own undo
 * emits our inverted effects in chronological order, interleaved with text.
 */

import { describe, expect, it } from "vitest";
import { EditorState, StateCommand, TransactionSpec } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { isolateHistory } from "@codemirror/commands";
import { InkStroke } from "../ink/Stroke";
import { InkOp, inkApplied, inkEffect, inkHistorySupport, invertInkOp } from "./InkHistory";

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

describe("invertInkOp", () => {
	it("add ↔ remove carries the same captured strokes and indices", () => {
		const add: InkOp = { type: "add", path: "n.md", strokes: [stroke("s1")] };
		const rem = invertInkOp(add);
		expect(rem.type).toBe("remove");
		if (rem.type === "remove") expect(rem.strokes[0]!.id).toBe("s1");

		const remove: InkOp = {
			type: "remove",
			path: "n.md",
			strokes: [stroke("a"), stroke("b")],
			indices: [0, 3],
		};
		const back = invertInkOp(remove);
		expect(back.type).toBe("add");
		if (back.type === "add") {
			expect(back.strokes.map((s) => s.id)).toEqual(["a", "b"]);
			expect(back.indices).toEqual([0, 3]); // z-order restored on un-erase
		}
	});

	it("move inverts to the exact negative displacement of the SAME ids", () => {
		const mv: InkOp = { type: "move", path: "n.md", strokeIds: ["a", "b"], dx: 12, dy: -7 };
		const inv = invertInkOp(mv);
		expect(inv).toEqual({ type: "move", path: "n.md", strokeIds: ["a", "b"], dx: -12, dy: 7 });
	});
});

/** A tiny headless editor: real EditorState, real history plugin. */
class Harness {
	state: EditorState;
	/** Ink ops emitted by transactions NOT marked inkApplied (i.e. history's). */
	applied: InkOp[] = [];

	constructor(doc: string) {
		this.state = EditorState.create({
			doc,
			extensions: [history(), inkHistorySupport()],
		});
	}

	/** What the overlay does for a finished gesture. */
	gesture(op: InkOp): void {
		this.dispatchSpec({
			effects: inkEffect.of(op),
			annotations: [inkApplied.of(true), isolateHistory.of("full")],
		});
	}

	type(from: number, insert: string): void {
		this.dispatchSpec({ changes: { from, insert } });
	}

	run(cmd: StateCommand): boolean {
		return cmd({
			state: this.state,
			dispatch: (tr) => {
				if (!tr.annotation(inkApplied)) {
					for (const e of tr.effects) {
						if (e.is(inkEffect)) this.applied.push(e.value);
					}
				}
				this.state = tr.state;
			},
		});
	}

	private dispatchSpec(spec: TransactionSpec): void {
		const tr = this.state.update(spec);
		this.state = tr.state;
	}

	get doc(): string {
		return this.state.doc.toString();
	}
}

describe("plain undo/redo over the real history plugin", () => {
	it("undoing an ink add emits the inverse remove; redo re-adds", () => {
		const h = new Harness("hello");
		h.gesture({ type: "add", path: "n.md", strokes: [stroke("s1")] });

		expect(h.run(undo)).toBe(true);
		expect(h.applied).toHaveLength(1);
		expect(h.applied[0]!.type).toBe("remove");

		expect(h.run(redo)).toBe(true);
		expect(h.applied).toHaveLength(2);
		expect(h.applied[1]!.type).toBe("add");
	});

	it("a pen contact split around release travel remains one undo step", () => {
		const h = new Harness("hello");
		h.gesture({ type: "add", path: "n.md", strokes: [stroke("left"), stroke("right")] });

		expect(h.run(undo)).toBe(true);
		expect(h.applied).toHaveLength(1);
		expect(h.applied[0]).toMatchObject({
			type: "remove",
			path: "n.md",
			strokes: [{ id: "left" }, { id: "right" }],
		});
		expect(h.run(undo)).toBe(false);
	});

	it("undoing a lasso delete restores the captured strokes at their original indices", () => {
		const h = new Harness("hello");
		h.gesture({
			type: "remove",
			path: "n.md",
			strokes: [stroke("s1"), stroke("s2")],
			indices: [1, 4],
		});

		expect(h.run(undo)).toBe(true);
		expect(h.applied).toEqual([
			{
				type: "add",
				path: "n.md",
				strokes: expect.arrayContaining([
					expect.objectContaining({ id: "s1" }),
					expect.objectContaining({ id: "s2" }),
				]),
				indices: [1, 4],
			},
		]);
	});

	it("history is chronological: text and ink interleave in order", () => {
		const h = new Harness("hello");
		h.gesture({ type: "add", path: "n.md", strokes: [stroke("s1")] }); // 1: ink
		h.type(5, " world"); // 2: text

		// Undo #1: the text edit, no ink op.
		expect(h.run(undo)).toBe(true);
		expect(h.doc).toBe("hello");
		expect(h.applied).toHaveLength(0);

		// Undo #2: the ink add → inverse remove.
		expect(h.run(undo)).toBe(true);
		expect(h.applied).toHaveLength(1);
		expect(h.applied[0]!.type).toBe("remove");

		// Redo walks forward in the same order.
		expect(h.run(redo)).toBe(true); // ink back
		expect(h.applied[1]!.type).toBe("add");
		expect(h.run(redo)).toBe(true); // text back
		expect(h.doc).toBe("hello world");
	});

	it("each gesture is its own undo step (no stroke merging)", () => {
		const h = new Harness("x");
		h.gesture({ type: "add", path: "n.md", strokes: [stroke("s1")] });
		h.gesture({ type: "add", path: "n.md", strokes: [stroke("s2")] });

		expect(h.run(undo)).toBe(true);
		expect(h.applied).toHaveLength(1); // only s2's inverse
		const first = h.applied[0]!;
		if (first.type === "remove") expect(first.strokes[0]!.id).toBe("s2");

		expect(h.run(undo)).toBe(true);
		expect(h.applied).toHaveLength(2);
	});

	it("a move op undoes with its FROZEN ids and exact negative delta", () => {
		const h = new Harness("x");
		h.gesture({ type: "move", path: "n.md", strokeIds: ["a", "b"], dx: 30, dy: 40 });
		expect(h.run(undo)).toBe(true);
		expect(h.applied[0]).toEqual({
			type: "move",
			path: "n.md",
			strokeIds: ["a", "b"],
			dx: -30,
			dy: -40,
		});
	});

	it("ops carry their note: the path survives undo across a file switch", () => {
		const h = new Harness("x");
		h.gesture({ type: "add", path: "original-note.md", strokes: [stroke("s1")] });
		// (the pane may show a different file by the time undo is pressed)
		expect(h.run(undo)).toBe(true);
		expect(h.applied[0]!.path).toBe("original-note.md");
	});

	it("normal Markdown undo is untouched when no ink is involved", () => {
		const h = new Harness("abc");
		h.type(3, "def");
		expect(h.run(undo)).toBe(true);
		expect(h.doc).toBe("abc");
		expect(h.applied).toHaveLength(0);
		expect(h.run(redo)).toBe(true);
		expect(h.doc).toBe("abcdef");
	});
});
