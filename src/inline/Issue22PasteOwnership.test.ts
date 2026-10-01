import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InkStroke } from "../ink/Stroke";
import { clearInkClipboard, copyInk, inkClipboardMarker } from "./InkClipboard";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";

const path = "issue22-cell-paste-unit.md";
const source: InkStroke = {
	id: "copied", tool: "pen", color: "#111", width: 2, createdAt: 1,
	points: [{ x: 10, y: 10, pressure: 0.5, t: 0 }, { x: 30, y: 30, pressure: 0.5, t: 1 }],
	bbox: { x: 8, y: 8, width: 24, height: 24 },
};

/** The production methods on an unmounted cell plugin with inherited note identity. */
function cellOverlay() {
	const overlay = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const dispatched: unknown[] = [];
	const selections: string[][] = [];
	const scroll = { clientWidth: 500, clientHeight: 300, clientLeft: 0, clientTop: 0,
		scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
	overlay.view = {
		dom: { closest: () => null, parentElement: null, ownerDocument: { defaultView: globalThis.window } },
		state: { field: () => ({ file: { path } }) },
		scrollDOM: scroll, dispatch: (spec: unknown) => dispatched.push(spec),
	} as never;
	overlay.container = null;
	overlay.selection = { selectExactly: (ids: string[]) => selections.push(ids) } as never;
	overlay.camera = { snapshot: { x: 0, y: 0, zoom: 1 } } as never;
	overlay.scheduleRepaint = () => {};
	overlay.repaintPath = () => {};
	overlay.redrawSelectionUI = () => {};
	overlay.updateExtent = () => {};
	overlay.syncCamera = () => {};
	overlay.dispatchInk = (op: unknown) => dispatched.push(op);
	overlay.mobileTools = null;
	return { overlay: overlay as unknown as InkOverlayPlugin, dispatched, selections };
}

describe("Issue 22 cell paste ownership", () => {
	beforeEach(() => {
		clearInkClipboard();
		copyInk([source], path);
	});
	afterEach(() => clearInkClipboard());

	it("direct paste refuses a non-owner before changing note ink or history", () => {
		const { overlay, dispatched, selections } = cellOverlay();
		const before = inlineInk.strokes(path).map(s => s.id);
		expect(overlay.pasteInkHere()).toBe(0);
		expect(inlineInk.strokes(path).map(s => s.id)).toEqual(before);
		expect(dispatched).toEqual([]);
		expect(selections).toEqual([]);
	});

	it("a recognized marker is consumed in a non-owner editor without ink", () => {
		const { overlay, dispatched } = cellOverlay();
		const marker = inkClipboardMarker();
		expect(marker).not.toBeNull();
		const events: string[] = [];
		const event = {
			clipboardData: { getData: () => marker },
			preventDefault: () => events.push("prevent"),
			stopPropagation: () => events.push("stop"),
		} as unknown as ClipboardEvent;
		const before = inlineInk.strokes(path).map(s => s.id);
		expect(overlay.handlePaste(event)).toBe(true);
		expect(events).toEqual(["prevent", "stop"]);
		expect(inlineInk.strokes(path).map(s => s.id)).toEqual(before);
		expect(dispatched).toEqual([]);
	});
});
