/**
 * An ink op belongs to a NOTE, not to a path (audit, 2026-09-01).
 *
 * The editor keeps its undo history across a rename. Ops carried only the
 * path they were recorded at, so an undo pressed afterwards named a location
 * nothing lived at: the ink was not restored on the real note, and it was put
 * into a record for the old name that a note created there later inherited.
 *
 * The page id is written in the file and does not move when the file does,
 * so it answers correctly across any number of renames. These pin the two
 * halves that make that work: the identity survives every inverse, and the
 * store can turn an id back into wherever the note is now.
 */

import { describe, expect, it } from "vitest";

import { InkStroke } from "../ink/Stroke";
import { InkOp, eraseRemovalIndices, invertInkOp } from "./InkHistory";
import { InlineInkStore } from "./InlineInkStore";

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000",
		width: 2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 5, y: 5, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 5, height: 5 },
		createdAt: 0,
	};
}

describe("invertInkOp keeps the page identity", () => {
	// An op that loses its id on the way to the undo stack is one rename away
	// from the bug the id exists to prevent - and redo is the leg that would
	// get it wrong, because redo applies the inverse of the inverse.
	const ops: InkOp[] = [
		{ type: "add", path: "a.md", pageId: "p1", strokes: [stroke("s")], indices: [0] },
		{ type: "remove", path: "a.md", pageId: "p1", strokes: [stroke("s")], indices: [0] },
		{ type: "move", path: "a.md", pageId: "p1", strokeIds: ["s"], dx: 3, dy: 4 },
		{
			type: "replace",
			path: "a.md",
			pageId: "p1",
			removed: [stroke("s")],
			removedAt: [0],
			inserted: [stroke("s1"), stroke("s2")],
			insertedAt: [0, 1],
		},
	];

	for (const op of ops) {
		it(`survives inverting a ${op.type}`, () => {
			expect(invertInkOp(op).pageId).toBe("p1");
		});

		it(`survives inverting a ${op.type} twice (undo then redo)`, () => {
			expect(invertInkOp(invertInkOp(op)).pageId).toBe("p1");
		});
	}

	it("stays undefined when it was never set, rather than inventing one", () => {
		// Unclaimed notes, and ops already in an open editor's history from
		// before this field existed. Both fall back to the path.
		const bare: InkOp = { type: "add", path: "a.md", strokes: [stroke("s")] };
		expect(invertInkOp(bare).pageId).toBeUndefined();
	});
});

describe("InlineInkStore.pathForPageId", () => {
	it("follows a note through a rename", async () => {
		const store = new InlineInkStore();
		store.attachHost({
			readPageId: (path) => (path === "old.md" ? "p1" : null),
			claimId: async (_p, id) => ({ pageId: id }),
			loadSidecar: async () => null,
			scheduleSidecar: () => {},
			notify: () => {},
		});
		await store.ensureLoaded("old.md");
		expect(store.pathForPageId("p1")).toBe("old.md");

		store.handleRename("old.md", "new.md");
		// The op recorded before the rename still says "old.md"; this is what
		// turns it back into where the note actually is.
		expect(store.pathForPageId("p1")).toBe("new.md");
		expect(store.pageIdOf("new.md")).toBe("p1");
	});

	it("returns null for a note that is not open, so an op is skipped not guessed", () => {
		const store = new InlineInkStore();
		expect(store.pathForPageId("nobody")).toBeNull();
	});
});

describe("eraseRemovalIndices", () => {
	// The eraser removes one pointer sample at a time, and each removal
	// reports the position the stroke held in whatever the list contained at
	// that instant. Those numbers do not share a frame of reference, so
	// undoing a multi-stroke erase put the ink back at the wrong depth - and
	// the more a single drag erased, the further out it got.
	const [a, b, c, d] = [stroke("a"), stroke("b"), stroke("c"), stroke("d")];
	const before = [a, b, c, d];

	it("reports positions in the pre-gesture list, not the shrinking one", () => {
		// A drag across b then d. By the time d goes, the live list is
		// [a, c, d] and its removal reports index 2 - but d sat at 3.
		const erased = [
			{ stroke: b, index: 1 },
			{ stroke: d, index: 2 },
		];
		expect(eraseRemovalIndices(before, erased)).toEqual([1, 3]);
	});

	it("is unchanged for a single-stroke erase, which always worked", () => {
		expect(eraseRemovalIndices(before, [{ stroke: c, index: 2 }])).toEqual([2]);
	});

	it("compounds the way the bug did, across a long drag", () => {
		// b, c and d taken in turn: the live indices collapse to 1, 1, 1
		// while the real positions are 1, 2, 3.
		const erased = [
			{ stroke: b, index: 1 },
			{ stroke: c, index: 1 },
			{ stroke: d, index: 1 },
		];
		expect(eraseRemovalIndices(before, erased)).toEqual([1, 2, 3]);
	});

	it("keeps the reported index for a stroke the gesture never saw", () => {
		// A piece created mid-gesture and then erased again is not in the
		// pre-gesture list; its own report is the only number there is.
		const piece = stroke("piece");
		expect(eraseRemovalIndices(before, [{ stroke: piece, index: 7 }])).toEqual([7]);
	});

	it("preserves the order the strokes were erased in", () => {
		// The op pairs removed[i] with removedAt[i], so the arrays must stay
		// aligned even when the gesture went backwards through the list.
		const erased = [
			{ stroke: d, index: 3 },
			{ stroke: a, index: 0 },
		];
		expect(eraseRemovalIndices(before, erased)).toEqual([3, 0]);
	});
});
