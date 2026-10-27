/**
 * The strip's button table, fold order and faces live in MobileToolsButtons.ts
 * and MobileTools.ts re-exports the names other files import, so every importer
 * keeps its import line. Three things a type check cannot see are held here.
 *
 * LOAD. This file imports the new module first. MobileTools.ts reads the table
 * while it loads (the default fold order and a filter over the buttons), so the
 * new file must not import a value back from MobileTools.ts: if it did, loading
 * it first would read the table before it existed and throw here, at load. The
 * new file imports only the MobileToolsHost type, which is erased at build.
 *
 * ONE COPY. Each re-exported name must be the very same function, array or
 * string from both files, not a second definition that happens to behave alike.
 *
 * BEHAVIOUR. A few calls through the re-export, so a name that came across
 * empty or wired to the wrong body fails here and not on a device.
 */
import { describe, expect, it } from "vitest";

import * as buttons from "./MobileToolsButtons";
import * as strip from "./MobileTools";
import { markPenHardwareSeen } from "./PenToolsMode";

/** Exported by the new file and re-exported, under the same name, by MobileTools.ts. */
const MOVED = [
	"PEN_INK_TOGGLE",
	"DEFAULT_FOLD_ORDER",
	"normalizeFoldOrder",
	"stripButtonFace",
	"stripBuildsButton",
	"NEVER_FOLDING_FACES",
	"nibIsLit",
	"nibInkColor",
] as const;

/** A strip host that answers only the reads `nibIsLit` makes. */
const fakeHost = (over: Record<string, unknown> = {}): strip.MobileToolsHost =>
	({
		eraserOn: () => false,
		lassoOn: () => false,
		spaceOn: () => false,
		panOn: () => false,
		activeTool: () => "pen",
		penInksHere: () => true,
		mouseInkOn: () => false,
		...over,
	}) as unknown as strip.MobileToolsHost;

describe("MobileTools.ts re-exports the strip's button table from MobileToolsButtons.ts", () => {
	it("loads with the new file imported first", () => {
		expect(buttons.BUTTONS).toBeDefined();
		expect(strip.DEFAULT_FOLD_ORDER).toBe(buttons.DEFAULT_FOLD_ORDER);
	});

	it.each(MOVED)("%s is one copy, the same from both files", (name) => {
		const fromButtons = (buttons as Record<string, unknown>)[name];
		const fromStrip = (strip as Record<string, unknown>)[name];
		expect(fromButtons).toBeDefined();
		expect(fromStrip).toBe(fromButtons);
	});

	it("the table has its twelve buttons", () => {
		expect(buttons.BUTTONS.length).toBe(12);
	});

	it("normalizeFoldOrder repairs a bad list to every default id once", () => {
		const fixed = strip.normalizeFoldOrder(["no-such-id", 7, null]);
		expect(fixed).toEqual([...buttons.DEFAULT_FOLD_ORDER]);
		expect(strip.normalizeFoldOrder("not a list")).toEqual([...buttons.DEFAULT_FOLD_ORDER]);
	});

	it("stripButtonFace answers the pen button and nothing for an unknown id", () => {
		const face = strip.stripButtonFace("handwriting:inline-tool-pen");
		expect(face?.commandId).toBe("handwriting:inline-tool-pen");
		expect(face?.inkTool).toBe("pen");
		expect(strip.stripButtonFace("handwriting:no-such-button")).toBeNull();
	});

	it("nibIsLit reads the host: lit once a pen was seen, dark when another mode owns the tip", () => {
		markPenHardwareSeen();
		expect(strip.nibIsLit(fakeHost(), "pen")).toBe(true);
		expect(strip.nibIsLit(fakeHost({ eraserOn: () => true }), "pen")).toBe(false);
		expect(strip.nibIsLit(fakeHost({ activeTool: () => "highlighter" }), "pen")).toBe(false);
	});
});
