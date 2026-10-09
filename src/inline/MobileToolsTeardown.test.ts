/**
 * Teardown cells for the pen-tools strip, run on the shared fake DOM now that it tracks listeners.
 *
 * Until the fake counted listeners its removeEventListener did nothing, so a strip whose destroy() forgot a
 * document listener (or removed it with the wrong capture flag, which the DOM treats as "not found") left every unit
 * test green. The strip registers seven document listeners (MobileTools.ts, constructor) and removes them in destroy().
 * These cells read the document's live count: a strip that is built has some, a strip that is destroyed has none.
 *
 * Plant (not committed): drop any one of the removeEventListener lines in MobileTools.destroy, or give one the wrong
 * capture flag, and the second cell goes red naming the type left behind.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MobileTools, type MobileToolsHost } from "./MobileTools";
import { getInlineTool } from "./InkOverlay";
import { clearToolPicked } from "./MouseInk";
import { markPenHardwareSeen, resetPenToolsForTest } from "./PenToolsMode";
import { penInkEnabled, resetPenInkForTest } from "./PenInk";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";

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

const DOCUMENT_TYPES = ["click", "keydown", "pointercancel", "pointerdown", "pointerup"];

describe("MobileTools teardown on the listener-tracking fake DOM", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		resetPenInkForTest();
		clearToolPicked();
		markPenHardwareSeen();
	});

	it("control: a built strip has registered document listeners of every type it removes later", () => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = new MobileTools(pane as unknown as HTMLElement, host());
		for (const type of DOCUMENT_TYPES) {
			expect(doc.documentListenerCount(type), `a live strip listens for ${type} on its document`).toBeGreaterThan(0);
		}
		expect(doc.documentListenerCount(), "the strip registers seven document listeners").toBe(7);
		strip.destroy();
	});

	it("destroy leaves no document listener behind", () => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = new MobileTools(pane as unknown as HTMLElement, host());
		strip.destroy();
		const left = DOCUMENT_TYPES.filter((type) => doc.documentListenerCount(type) > 0);
		expect(left, "document listener types still registered after destroy").toEqual([]);
		expect(doc.documentListenerCount()).toBe(0);
	});

	it("a second strip on the same document does not share or steal the first one's listeners", () => {
		const doc = new FakeDoc();
		const first = new MobileTools(new FakeEl("div", doc) as unknown as HTMLElement, host());
		const second = new MobileTools(new FakeEl("div", doc) as unknown as HTMLElement, host());
		expect(doc.documentListenerCount()).toBe(14);
		first.destroy();
		expect(doc.documentListenerCount(), "destroying one strip removes only its own seven").toBe(7);
		second.destroy();
		expect(doc.documentListenerCount()).toBe(0);
	});
});
