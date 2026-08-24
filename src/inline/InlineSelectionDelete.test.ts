import { describe, expect, it, vi } from "vitest";
import type { InkStroke } from "../ink/Stroke";
import { InlineInkStore } from "./InlineInkStore";
import {
	InlineSelectionDeleteKeys,
	removeSelectedInlineStrokes,
} from "./InlineSelectionDelete";

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 10, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 10 },
		createdAt: 1,
	};
}

function keyEvent(key: string, mods: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey">> = {}) {
	return {
		key,
		altKey: mods.altKey ?? false,
		ctrlKey: mods.ctrlKey ?? false,
		metaKey: mods.metaKey ?? false,
		preventDefault: vi.fn(),
	};
}

describe("inline lasso deletion", () => {
	it("deletes every selected segment from one pen contact and restores both", () => {
		const store = new InlineInkStore();
		store.commitGesture("note.md", [stroke("left"), stroke("right")]);

		const op = removeSelectedInlineStrokes(store, "note.md", ["left", "right"]);

		expect(store.strokes("note.md")).toHaveLength(0);
		store.applyAdd("note.md", op!.strokes, op!.indices);
		expect(store.strokes("note.md").map((item) => item.id)).toEqual(["left", "right"]);
	});

	it("removes the selected strokes and captures their original order for undo", () => {
		const store = new InlineInkStore();
		store.commit("note.md", stroke("a"));
		store.commit("note.md", stroke("b"));
		store.commit("note.md", stroke("c"));

		const op = removeSelectedInlineStrokes(store, "note.md", ["a", "c"]);

		expect(store.strokes("note.md").map((item) => item.id)).toEqual(["b"]);
		expect(op?.strokes.map((item) => item.id)).toEqual(["a", "c"]);
		expect(op?.indices).toEqual([0, 2]);
		store.applyAdd("note.md", op!.strokes, op!.indices);
		expect(store.strokes("note.md").map((item) => item.id)).toEqual(["a", "b", "c"]);
	});

	it.each(["Delete", "Backspace"])("claims %s only while ink is selected", (key) => {
		let selected = true;
		const remove = vi.fn(() => {
			selected = false;
		});
		const keys = new InlineSelectionDeleteKeys(() => selected, remove);
		const down = keyEvent(key);

		expect(keys.keydown(down)).toBe(true);
		expect(down.preventDefault).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledOnce();

		const up = keyEvent(key);
		expect(keys.keyup(up)).toBe(true);
		expect(up.preventDefault).toHaveBeenCalledOnce();

		const ordinaryDelete = keyEvent(key);
		expect(keys.keydown(ordinaryDelete)).toBe(false);
		expect(ordinaryDelete.preventDefault).not.toHaveBeenCalled();
	});

	it("swallows held-key repeats after the first event clears the ink selection", () => {
		let selected = true;
		const remove = vi.fn(() => {
			selected = false;
		});
		const keys = new InlineSelectionDeleteKeys(() => selected, remove);

		expect(keys.keydown(keyEvent("Delete"))).toBe(true);
		const repeat = keyEvent("Delete");
		expect(keys.keydown(repeat)).toBe(true);
		expect(repeat.preventDefault).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledOnce();
	});

	it("leaves modified shortcuts and ordinary Markdown keys alone", () => {
		const keys = new InlineSelectionDeleteKeys(() => true, vi.fn());
		for (const event of [
			keyEvent("Delete", { ctrlKey: true }),
			keyEvent("Backspace", { altKey: true }),
			keyEvent("z"),
		]) {
			expect(keys.keydown(event)).toBe(false);
			expect(event.preventDefault).not.toHaveBeenCalled();
		}
	});
});
