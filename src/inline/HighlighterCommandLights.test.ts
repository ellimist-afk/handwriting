/**
 * Red cell for audit 104 (lane C1): the Highlighter command leaves every toolbar still lighting Pen.
 *
 * Root cause read: the command marks the pen seen and rebuilds the strips (refreshPenToolsAll builds or removes
 * them, it does not repaint their lights) BEFORE it changes the tool, and setInlineTool's own release of the tip
 * mode returns early when a nib already holds the tip, so nothing repaints the strips after the tool changes.
 *
 * The real command callback is sliced out of main.ts and run against the real tool state and a real MobileTools
 * strip on the shared fake DOM. Asserted: after the command and the frames the strip queues, Pen is not lit and
 * Highlighter is. It goes green once anything repaints the strips after the tool is set.
 *
 * Written red-first behind HANDWRITING_C1_CELLS=1; the fix commit (lane EI2) dropped the gate.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "../main.ts?raw";
import { MobileTools, type MobileToolsHost } from "./MobileTools";
import {
	addStripSurface,
	getInlineTool,
	refreshAllStrips,
	refreshPenToolsAll,
	setInlineEraserMode,
	setInlineLassoMode,
	setInlinePanMode,
	setInlineSpaceMode,
	setInlineTool,
} from "./InkOverlay";
import { clearToolPicked } from "./MouseInk";
import { markPenHardwareSeen, markPenSeen, resetPenToolsForTest } from "./PenToolsMode";
import { penInkEnabled, resetPenInkForTest } from "./PenInk";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import { routineNoticesVisible } from "../diag/RoutineNotices";

const source = mainSource.replace(/\r\n/g, "\n");

function highlighterCommand(): () => void {
	const at = source.indexOf('id: "inline-tool-highlighter",');
	expect(at, "the Highlighter command is registered in main.ts").toBeGreaterThan(0);
	const end = source.indexOf("\n\t\t});", at);
	expect(end).toBeGreaterThan(at);
	const js = transformSync(`return { ${source.slice(at, end)} };`, { loader: "ts", target: "es2022" }).code;
	const names = [
		"markPenSeen",
		"refreshPenToolsAll",
		"refreshAllStrips",
		"setInlineTool",
		"setInlineEraserMode",
		"setInlineLassoMode",
		"setInlineSpaceMode",
		"setInlinePanMode",
		"routineNoticesVisible",
		"Notice",
	];
	const deps: Record<string, unknown> = {
		markPenSeen,
		refreshPenToolsAll,
		refreshAllStrips,
		setInlineTool,
		setInlineEraserMode,
		setInlineLassoMode,
		setInlineSpaceMode,
		setInlinePanMode,
		routineNoticesVisible,
		Notice: class {},
	};
	const spec = new Function(...names, js)(...names.map((n) => deps[n])) as { callback: () => void };
	return spec.callback;
}

const host = (): MobileToolsHost => ({
	exec: () => {},
	activeTool: () => getInlineTool(),
	setPlacement: () => {},
	eraserOn: () => false,
	eraserWholeStroke: () => false,
	setEraserWholeStroke: () => {},
	lassoOn: () => false,
	spaceOn: () => false,
	panOn: () => false,
	toolColor: () => "#000000",
	eraserRadiusPx: () => 10,
	setEraserRadiusPx: () => {},
	inkSizeMult: () => 1,
	setInkSizeMult: () => {},
	canUndo: () => false,
	canRedo: () => false,
	canPasteInk: () => false,
	mouseInkOn: () => false,
	armMouseInkQuietly: () => {},
	disarmMouseInkQuietly: () => {},
	toast: () => {},
	recordingOn: () => false,
	hasInkSelection: () => false,
	paletteFor: () => [],
	pickColor: () => {},
	presetsFor: () => [],
	applyPreset: () => {},
	starPreset: () => {},
	forgetPreset: () => {},
	setEditorFocus: () => {},
	penInksHere: () => penInkEnabled(),
	hasTouch: () => true,
});

function lit(pane: FakeEl, label: string): boolean {
	const button = pane.findByTipLabel(label);
	expect(button, `the ${label} button is on the strip`).not.toBeNull();
	return button!.classes.has("is-active");
}

describe("audit 104: the Highlighter command repaints every toolbar", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		resetPenInkForTest();
		clearToolPicked();
		markPenHardwareSeen();
		setInlineTool("pen");
	});
	afterEach(() => {
		setInlineTool("pen");
		resetPenToolsForTest();
	});

	it("control: with Pen selected the strip lights Pen and not Highlighter", () => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = new MobileTools(pane as unknown as HTMLElement, host());
		doc.flushFrames();
		expect(lit(pane, "Pen")).toBe(true);
		expect(lit(pane, "Highlighter")).toBe(false);
		strip.destroy();
	});

	it("after the Highlighter command the strip lights Highlighter and not Pen", () => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = new MobileTools(pane as unknown as HTMLElement, host());
		// The strip is registered the way a PDF's is, so refreshAllStrips reaches it.
		const unregister = addStripSurface(() => strip.refresh());
		doc.flushFrames();
		highlighterCommand()();
		doc.flushFrames();
		expect(getInlineTool(), "the command set the tool").toBe("highlighter");
		expect(lit(pane, "Highlighter"), "Highlighter is lit").toBe(true);
		expect(lit(pane, "Pen"), "Pen is still lit: no repaint after the tool changed").toBe(false);
		unregister();
		strip.destroy();
	});
});
