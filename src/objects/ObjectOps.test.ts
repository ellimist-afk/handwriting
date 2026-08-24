import { describe, expect, it } from "vitest";
import { History } from "../history/History";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PageData, emptyPage } from "../model/PageData";
import { createMoveOp, moveObjects } from "./ObjectOps";

function stroke(id: string, x: number, y: number): InkStroke {
	const points = [
		{ x, y, pressure: 0.5, t: 0 },
		{ x: x + 10, y: y + 10, pressure: 0.5, t: 4 },
	];
	return {
		id,
		tool: "pen",
		color: "#000",
		width: 2,
		points,
		bbox: computeBBox(points, 4),
		createdAt: 0,
	};
}

function samplePage(): PageData {
	const page = emptyPage("p1");
	page.strokes.push(stroke("s1", 0, 0), stroke("s2", 100, 100));
	page.textBoxes.push(
		{ id: "b1", x: 10, y: 20, width: 320, z: 0 },
		{ id: "b2", x: 500, y: 500, width: 320, z: 1 }
	);
	return page;
}

describe("moveObjects", () => {
	it("moves only the listed objects", () => {
		const page = samplePage();
		moveObjects(page, { strokeIds: ["s1"], boxIds: ["b1"], imageIds: [] }, 5, -5);
		expect(page.strokes[0]!.points[0]).toMatchObject({ x: 5, y: -5 });
		expect(page.strokes[1]!.points[0]).toMatchObject({ x: 100, y: 100 });
		expect(page.textBoxes[0]).toMatchObject({ x: 15, y: 15 });
		expect(page.textBoxes[1]).toMatchObject({ x: 500, y: 500 });
	});

	it("keeps stroke bounding boxes in step", () => {
		const page = samplePage();
		const before = page.strokes[0]!.bbox.x;
		moveObjects(page, { strokeIds: ["s1"], boxIds: [], imageIds: [] }, 30, 0);
		expect(page.strokes[0]!.bbox.x).toBe(before + 30);
	});

	it("ignores ids that no longer exist", () => {
		const page = samplePage();
		expect(() =>
			moveObjects(page, { strokeIds: ["ghost"], boxIds: ["ghost"], imageIds: [] }, 10, 10)
		).not.toThrow();
		expect(page.strokes[0]!.points[0]).toMatchObject({ x: 0, y: 0 });
	});
});

describe("createMoveOp — operands are captured, not consulted", () => {
	it("undoes the move even after the selection is cleared", () => {
		// The exact regression: lasso, drag, switch tools (which clears the
		// selection), then Ctrl+Z. The old implementation filtered by the live
		// selection, matched nothing, and left history and document diverged.
		const page = samplePage();
		const liveSelectionStrokes = new Set(["s1"]);
		const liveSelectionBoxes = new Set(["b1"]);

		// The gesture already moved things, as the drag does.
		moveObjects(
			page,
			{ strokeIds: [...liveSelectionStrokes], boxIds: [...liveSelectionBoxes], imageIds: [] },
			40,
			-15
		);
		const op = createMoveOp(
			page,
			{ strokeIds: [...liveSelectionStrokes], boxIds: [...liveSelectionBoxes], imageIds: [] },
			40,
			-15
		);
		const history = new History();
		history.push(op);

		// The user switches tools: selection is gone.
		liveSelectionStrokes.clear();
		liveSelectionBoxes.clear();

		history.undo();
		expect(page.strokes[0]!.points[0]).toMatchObject({ x: 0, y: 0 });
		expect(page.textBoxes[0]).toMatchObject({ x: 10, y: 20 });

		history.redo();
		expect(page.strokes[0]!.points[0]).toMatchObject({ x: 40, y: -15 });
		expect(page.textBoxes[0]).toMatchObject({ x: 50, y: 5 });
	});

	it("is unaffected by a later, different selection", () => {
		const page = samplePage();
		moveObjects(page, { strokeIds: ["s1"], boxIds: [], imageIds: [] }, 10, 0);
		const op = createMoveOp(page, { strokeIds: ["s1"], boxIds: [], imageIds: [] }, 10, 0);

		// Something else gets selected and moved afterwards.
		moveObjects(page, { strokeIds: ["s2"], boxIds: [], imageIds: [] }, 7, 7);

		op.invert();
		expect(page.strokes[0]!.points[0]).toMatchObject({ x: 0, y: 0 });
		// The other stroke keeps its own movement.
		expect(page.strokes[1]!.points[0]).toMatchObject({ x: 107, y: 107 });
	});

	it("survives repeated undo/redo without drifting", () => {
		const page = samplePage();
		const targets = { strokeIds: ["s1", "s2"], boxIds: ["b1", "b2"], imageIds: [] };
		moveObjects(page, targets, 12.5, -3.25);
		const history = new History();
		history.push(createMoveOp(page, targets, 12.5, -3.25));

		for (let i = 0; i < 5; i++) {
			history.undo();
			history.redo();
		}
		history.undo();
		expect(page.strokes[0]!.points[0]!.x).toBeCloseTo(0, 9);
		expect(page.textBoxes[1]).toMatchObject({ x: 500, y: 500 });
	});

	it("notifies on both directions so the caller can repaint and save", () => {
		const page = samplePage();
		let calls = 0;
		const op = createMoveOp(page, { strokeIds: ["s1"], boxIds: [], imageIds: [] }, 1, 1, () => calls++);
		op.apply();
		op.invert();
		expect(calls).toBe(2);
	});
});
