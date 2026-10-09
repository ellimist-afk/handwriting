import { describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { history, isolateHistory, undo } from "@codemirror/commands";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { splitStrokeByCircle } from "../ink/Eraser";
import { ParseResult, emptyPage } from "../model/PageData";
import { InlineInkHost, InlineInkStore } from "./InlineInkStore";
import { InkOp, eraseRemovalIndices, inkApplied, inkEffect, inkHistorySupport } from "./InkHistory";

const PATH = "note.md";

class Host implements InlineInkHost {
	readPageId(path: string): string | null { return path === PATH ? "p1" : null; }
	async claimId(_path: string, proposedId: string): Promise<{ pageId: string }> { return { pageId: proposedId }; }
	async loadSidecar(): Promise<ParseResult | null> {
		const page = emptyPage("p1");
		page.surface = "inline";
		return { data: page, recovered: false, damaged: false } as ParseResult;
	}
	scheduleSidecar(): void {}
	notify(): void {}
}

function pane(store: InlineInkStore) {
	let state = EditorState.create({ doc: "", extensions: [history(), inkHistorySupport()] });
	const apply = (op: InkOp): void => {
		switch (op.type) {
			case "add": store.applyAdd(op.path, op.strokes, op.indices); break;
			case "remove": store.applyRemove(op.path, op.strokes.map((s) => s.id)); break;
			case "move": store.moveStrokes(op.path, op.strokeIds, op.dx, op.dy); break;
			case "replace":
				store.takeLive(op.path, op.removed.map((s) => s.id));
				store.applyAddLive(op.path, op.inserted, op.insertedAt);
				break;
		}
	};
	const target = {
		get state() { return state; },
		dispatch(tr: Transaction) {
			state = tr.state;
			if (tr.annotation(inkApplied)) return;
			for (const e of tr.effects) if (e.is(inkEffect)) apply(e.value);
		},
	};
	return {
		publish(op: InkOp): void {
			target.dispatch(state.update({ effects: inkEffect.of(op), annotations: [inkApplied.of(true), isolateHistory.of("full")] }));
		},
		undo: () => undo(target),
	};
}

function line(id: string): InkStroke {
	const points = [];
	for (let i = 0; i <= 10; i++) points.push({ x: i * 10, y: 50, pressure: 0.5, t: i * 8 });
	return { id, tool: "pen", color: "#000", width: 2, points, bbox: computeBBox(points, 4), createdAt: 0 } as InkStroke;
}

const geometry = (s: InkStroke) => s.points.map((p) => [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000]);

describe("two panes on one note: undo of an erase after the other pane moved a piece", () => {
	it("pane A's undo restores the erased stroke exactly as it was drawn", async () => {
		const store = new InlineInkStore();
		store.attachHost(new Host());
		await store.ensureLoaded(PATH);
		const a = pane(store);
		const b = pane(store);

		const s = line("s");
		const drawn = geometry(s);
		store.commitGesture(PATH, [s]);
		a.publish({ type: "add", path: PATH, strokes: [s] });

		const eraseFrom = [...store.strokes(PATH)];
		let n = 0;
		const back: Array<{ index: number; pieces: InkStroke[] }> = [];
		const erased: Array<{ stroke: InkStroke; index: number }> = [];
		for (const { stroke, index } of store.takeLive(PATH, ["s"])) {
			const pieces = splitStrokeByCircle(stroke, 50, 50, 8, () => `piece${++n}`);
			erased.push({ stroke, index });
			back.push({ index, pieces });
		}
		store.reinsertLive(PATH, back);
		const pieces = [...store.strokes(PATH)];
		expect(pieces.map((p) => p.id)).toEqual(["piece1", "piece2"]);
		a.publish({
			type: "replace", path: PATH,
			removed: erased.map((e) => e.stroke),
			removedAt: eraseRemovalIndices(eraseFrom, erased),
			inserted: pieces,
			insertedAt: pieces.map((_, i) => i),
		});

		store.moveStrokes(PATH, ["piece1"], 0, 100);
		b.publish({ type: "move", path: PATH, strokeIds: ["piece1"], dx: 0, dy: 100 });

		expect(a.undo()).toBe(true);

		const now = store.strokes(PATH);
		expect(now.map((x) => x.id)).toEqual(["s"]);
		expect(geometry(now[0]!), "the restored stroke is the line that was drawn").toEqual(drawn);
	});
});
