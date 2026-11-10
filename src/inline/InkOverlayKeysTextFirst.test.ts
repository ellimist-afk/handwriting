/**
 * Delete and Backspace while lassoed ink is selected and the editor holds text the user is working on.
 *
 * The keys reach the overlay only from the editor's own keydown (a dom event handler on the editor), so the editor
 * has focus whenever these cells run. What decides the key is the editor's selection: a swept text range means the
 * user is editing text, and the key is theirs, as Ctrl+C and Ctrl+X already leave a text range to the editor.
 */
import { describe, expect, it, vi } from "vitest";

import { InkOverlayPlugin } from "./InkOverlay";
import { InlineSelectionDeleteKeys } from "./InlineSelectionDelete";
import { SelectionModel } from "../objects/SelectionModel";

interface Main {
	empty: boolean;
	from: number;
	to: number;
	anchor: number;
	head: number;
}

function caret(at: number): Main {
	return { empty: true, from: at, to: at, anchor: at, head: at };
}

function range(from: number, to: number): Main {
	return { empty: false, from, to, anchor: from, head: to };
}

/** A real overlay with one stroke lassoed; the editor's main selection is set by the cell. */
function rig() {
	const o = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const state = { selection: { main: caret(4) } };
	o.view = { state, dom: { contains: () => true } };
	const selection = new SelectionModel();
	selection.selectExactly(["s1"]);
	o.selection = selection;
	const removed = vi.fn();
	o.deleteSelectedInk = removed;
	// The production wiring (InkOverlay.ts, the selectionDeleteKeys field), which Object.create skips.
	o.selectionDeleteKeys = new InlineSelectionDeleteKeys(
		() => !selection.isEmpty,
		() => (o.deleteSelectedInk as () => void).call(o)
	);
	o.retirePanSettle = () => undefined;
	o.attachPickOpen = () => false;
	const overlay = o as unknown as InkOverlayPlugin;
	return {
		state,
		removed,
		down(key: string) {
			const e = { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, preventDefault: vi.fn() };
			const claimed = overlay.handleKeyDown(e as unknown as KeyboardEvent);
			overlay.handleKeyUp({ ...e, preventDefault: vi.fn() } as unknown as KeyboardEvent);
			return { claimed, prevented: e.preventDefault.mock.calls.length > 0 };
		},
	};
}

describe("Delete and Backspace leave lassoed ink alone while the editor holds a text range", () => {
	it.each(["Backspace", "Delete"])("control: %s with a bare caret removes the lassoed ink", (key) => {
		const r = rig();

		const out = r.down(key);

		expect(r.removed).toHaveBeenCalledTimes(1);
		expect(out).toEqual({ claimed: true, prevented: true });
	});

	it.each(["Backspace", "Delete"])("%s over a swept text range keeps the ink and leaves the key to the editor", (key) => {
		const r = rig();
		r.state.selection.main = range(2, 9);

		const out = r.down(key);

		expect(r.removed, "the ink is kept").not.toHaveBeenCalled();
		expect(out, "the key is the editor's: not claimed, not prevented").toEqual({ claimed: false, prevented: false });
	});
});
