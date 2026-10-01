import { beforeEach, describe, expect, it } from "vitest";
import { InkOverlayPlugin, inlineInk } from "../inline/InkOverlay";
import { InlineInkStore } from "../inline/InlineInkStore";
import { StrokeIndex } from "../ink/StrokeIndex";
import type { InkStroke } from "../ink/Stroke";

function stroke(id: string): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2,
		points: [{ x: 0, y: 0, pressure: 0.5, t: 0 }, { x: 40, y: 0, pressure: 0.5, t: 10 }],
		bbox: { x: 0, y: 0, width: 40, height: 0 }, createdAt: 0,
	};
}

it("C2-001 retains inter-original order after two live partial-erase survivor groups", () => {
	const path = "partial.md";
	const store = new InlineInkStore();
	store.applyAddLive(path, [stroke("A"), stroke("B")]);
	const hits = store.takeLive(path, ["A", "B"]);
	expect(hits.map(({ stroke, index }) => [stroke.id, index])).toEqual([["A", 0], ["B", 1]]);
	// The live eraser's reinsertion (InkOverlay.eraseAt): each hit's two
	// survivors, against its captured pre-removal index, in one pass.
	store.reinsertLive(
		path,
		hits.map(({ stroke: original, index }) => ({
			index,
			pieces: [stroke(`${original.id}L`), stroke(`${original.id}R`)],
		}))
	);
	expect(store.strokes(path).map((s) => s.id)).toEqual(["AL", "AR", "BL", "BR"]);
});

// W-1: the same order through the real InkOverlay.eraseAt, when the ring
// swallows one hit stroke whole (a dot, or a stroke shorter than the ring).
// eraseAt must hand reinsertLive a group for every stroke it took, an empty
// one for a swallowed stroke, or the pieces of a split stroke after it go
// back one place too far down and end up above ink drawn later. The rig is
// the one in InlineEraseFresh.test.ts: the plugin's prototype methods on a
// bare object, editor and painters stubbed, partial erase on.
describe("W-1 a partial erase that swallows one stroke whole keeps the order of the rest", () => {
	const PATH = "swallow.md";
	/** Where the eraser lands; the default ring is 14 px at scale 1. */
	const AT = { x: 100, y: 100 };

	/** A straight stroke from x0 to x1 at height y, a point every 2 px. */
	function line(id: string, x0: number, x1: number, y: number): InkStroke {
		const points = [];
		for (let x = x0; x <= x1; x += 2) points.push({ x, y, pressure: 0.5, t: x });
		return {
			id, tool: "pen", color: "#000000", width: 2,
			points, bbox: { x: x0, y, width: x1 - x0, height: 0 }, createdAt: 0,
		};
	}

	function eraseAt(at: { x: number; y: number }): void {
		const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
		view.mode = "erase";
		view.scale = 1;
		view.eraseWhole = false;
		view.erased = [];
		view.erasePieces = new Set<string>();
		view.strokeIndex = new StrokeIndex();
		view.indexDirty = true;
		view.damage = { addRect: () => undefined, addAll: () => undefined };
		view.camera = { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) };
		view.filePath = () => PATH;
		view.repaintPath = () => undefined;
		view.scheduleRepaint = () => undefined;
		const proto = InkOverlayPlugin.prototype as unknown as { eraseAt(this: unknown, sample: unknown): void };
		proto.eraseAt.call(view, { ...at, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
	}

	/**
	 * The note's strokes, bottom to top, each named by the stroke it came
	 * from (its height picks the original) and, for a piece, the side of the
	 * ring it is on. Piece ids are generated, so the geometry names them.
	 */
	function order(names: Record<number, string>): string[] {
		return inlineInk.strokes(PATH).map((s) => {
			const name = names[s.points[0]!.y] ?? s.id;
			if (s.id.length === 1) return name;
			return name + (s.points[0]!.x < AT.x ? "<" : ">");
		});
	}

	beforeEach(() => {
		inlineInk.applyRemove(PATH, inlineInk.strokes(PATH).map((s) => s.id));
	});

	it("swallowed then split: a dot the ring swallows, below a line it cuts, below a far stroke", () => {
		inlineInk.applyAddLive(PATH, [line("A", 100, 100, 98), line("B", 40, 160, 100), line("C", 400, 420, 400)]);
		eraseAt(AT);
		expect(order({ 100: "B", 400: "C" })).toEqual(["B<", "B>", "C"]);
	});

	it("split then swallowed: a line the ring cuts, below a dot it swallows, below a far stroke", () => {
		inlineInk.applyAddLive(PATH, [line("A", 40, 160, 100), line("B", 100, 100, 98), line("C", 400, 420, 400)]);
		eraseAt(AT);
		expect(order({ 100: "A", 400: "C" })).toEqual(["A<", "A>", "C"]);
	});

	it("split, swallowed, split: a short stroke the ring swallows between two lines it cuts", () => {
		inlineInk.applyAddLive(PATH, [
			line("A", 40, 160, 96),
			line("B", 98, 102, 100),
			line("C", 40, 160, 104),
			line("D", 400, 420, 400),
		]);
		eraseAt(AT);
		expect(order({ 96: "A", 104: "C", 400: "D" })).toEqual(["A<", "A>", "C<", "C>", "D"]);
	});
});
