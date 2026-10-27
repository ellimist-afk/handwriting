/**
 * Pasting with nothing on the ink clipboard does nothing at all. pasteInkHere asks the clipboard first and
 * returns 0, before the question of whether this editor owns the note. In a table cell or a cell editor that
 * second question fails, and it answers with a notice telling the user to click in the note to paste ink. With
 * nothing to paste that notice is wrong: no paste was attempted, so there is nothing to click out of.
 *
 * Held with the same non-owner editor the cell-paste ownership cell uses: an overlay with a file path and no
 * editor root. With ink on the clipboard that editor draws exactly one notice, which proves the recorder here
 * sees it; with the clipboard empty it draws none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notices: string[] = [];
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<object>()),
	Notice: class {
		constructor(message: string) { notices.push(message); }
	},
}));

import type { InkStroke } from "../ink/Stroke";
import { clearInkClipboard, clipboardSize, copyInk } from "./InkClipboard";
import { InkOverlayPlugin } from "./InkOverlay";

const path = "paste-empty-clipboard-unit.md";
const source: InkStroke = {
	id: "copied", tool: "pen", color: "#111", width: 2, createdAt: 1,
	points: [{ x: 10, y: 10, pressure: 0.5, t: 0 }, { x: 30, y: 30, pressure: 0.5, t: 1 }],
	bbox: { x: 8, y: 8, width: 24, height: 24 },
};

/** The production pasteInkHere on an unmounted overlay that has the note's path and no editor root. */
function nonOwnerOverlay() {
	const overlay = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const dispatched: unknown[] = [];
	overlay.view = { dom: { closest: () => null }, state: { field: () => ({ file: { path } }) } } as never;
	overlay.container = null;
	overlay.filePath = () => path;
	overlay.selection = { selectExactly: () => dispatched.push("select") } as never;
	overlay.dispatchInk = (op: unknown) => dispatched.push(op);
	overlay.scheduleRepaint = () => dispatched.push("repaint");
	overlay.repaintPath = () => dispatched.push("repaintPath");
	return { overlay: overlay as unknown as InkOverlayPlugin, dispatched };
}

describe("paste with an empty ink clipboard", () => {
	beforeEach(() => {
		clearInkClipboard();
		notices.length = 0;
	});
	afterEach(() => clearInkClipboard());

	it("returns 0 and shows no notice, where the same editor refuses a real paste with one", () => {
		const { overlay, dispatched } = nonOwnerOverlay();

		copyInk([source], path);
		expect(clipboardSize(), "premise: the clipboard holds the stroke").toBe(1);
		expect(overlay.pasteInkHere(), "premise: a non-owner editor refuses a real paste").toBe(0);
		expect(notices, "premise: and says so once").toEqual(["Handwriting: click in the note to paste ink."]);

		clearInkClipboard();
		notices.length = 0;
		expect(clipboardSize()).toBe(0);
		expect(overlay.pasteInkHere(), "an empty clipboard pastes nothing").toBe(0);
		expect(notices, "and the refusal notice is not shown for a paste that was never attempted").toEqual([]);
		expect(dispatched, "no history op, selection or repaint").toEqual([]);
	});
});
