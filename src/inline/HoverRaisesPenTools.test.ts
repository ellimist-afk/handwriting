/**
 * A hovering pointer raises the pen toolbar when it can ink - on BOTH surfaces.
 *
 * ALAN REVERSED HIS OWN 1.4.6 RULING TO GET THIS, 2026-09-03. He was asked
 * directly and told plainly that it reverses him, with the old rationale
 * quoted back: "a mouse in the room, reticle off, raised the pen toolbar in
 * auto mode for a pointer that was never a pen" (1.4.6-design.md 5m/AF5). His
 * answer: "with mouse ink armed, yes a hovering mouse should bring toolbar
 * out". So the mouse AF5 refused is now two cases, and only the unarmed one is
 * still refused.
 *
 * The pdf half is driven through the controller in `PdfPenTools.test.ts`,
 * which already mounts one and counts strips. This file is the NOTE half and
 * the shared predicate underneath both, because the defect being closed is the
 * two surfaces answering the same question differently - a test of one surface
 * cannot see that, by construction.
 *
 * `showPenCursor` is private and the overlay is far too heavy to construct, so
 * it is called on the real prototype through `Object.create`, the idiom
 * `PanClearsSelection.test.ts` and `InlineEraserSelection.test.ts` already use
 * here. Two fields are enough to reach the two marks and stop: `ensurePenTools`
 * is stubbed (it builds a strip and is not the subject) and `penCursorEl` is
 * left null, which is where the method returns.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { InkOverlayPlugin } from "./InkOverlay";
import { setMouseInk } from "./MouseInk";
import {
	penHardwareSeen,
	penSeenThisSession,
	penToolsVisible,
	pointerRaisesPenTools,
	resetPenToolsForTest,
} from "./PenToolsMode";
import { PenSample } from "../input/PointerRouter";

const sample = (): PenSample => ({ x: 10, y: 10, pressure: 0, timestamp: 0, tiltX: 0, tiltY: 0 });

/** The note surface's `showPenCursor`, on the real prototype. */
function noteHover(): (pointerType?: string) => void {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	view.ensurePenTools = (): void => undefined;
	view.penCursorEl = null;
	const show = (
		view as unknown as { showPenCursor(s: PenSample, pt?: string): void }
	).showPenCursor.bind(view);
	return (pointerType?: string) => show(sample(), pointerType);
}

describe("the shared predicate: which pointers may raise the pen toolbar", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		setMouseInk(false);
	});

	it("a pen always may", () => {
		expect(pointerRaisesPenTools("pen")).toBe(true);
		setMouseInk(true);
		expect(pointerRaisesPenTools("pen")).toBe(true);
	});

	it("a mouse may only while mouse ink is armed", () => {
		// The reversal, and the half of AF5 that survives it, in one pair.
		expect(pointerRaisesPenTools("mouse")).toBe(false);
		setMouseInk(true);
		expect(pointerRaisesPenTools("mouse")).toBe(true);
	});

	it("touch never does, armed or not", () => {
		expect(pointerRaisesPenTools("touch")).toBe(false);
		setMouseInk(true);
		expect(pointerRaisesPenTools("touch")).toBe(false);
	});

	it("an absent pointer type never does", () => {
		// `onPenHover(sample, pointerType?)` declares it optional, and a call
		// site that drops it is exactly how the nib light died - a missing
		// type must fail closed rather than read as "anything".
		setMouseInk(true);
		expect(pointerRaisesPenTools(undefined)).toBe(false);
	});
});

describe("the note surface raises the toolbar for a hovering pointer that can ink", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		setMouseInk(false);
	});

	it("a mouse with ink armed raises it, and claims no hardware", () => {
		// Alan's ruling on the surface that already behaved this way. Pinned
		// here because the pdf was changed to match it, and a later edit that
		// "unified" them by moving the note instead would go red.
		setMouseInk(true);
		noteHover()("mouse");
		expect(penSeenThisSession()).toBe(true);
		expect(penToolsVisible("auto", false, penSeenThisSession())).toBe(true);
		// The line that keeps the fix from becoming the old bug: an armed
		// mouse is still not a pen. nibIsLit covers it through mouseInkOn().
		expect(penHardwareSeen()).toBe(false);
	});

	it("a mouse with ink off raises nothing", () => {
		noteHover()("mouse");
		expect(penSeenThisSession()).toBe(false);
		expect(penHardwareSeen()).toBe(false);
	});

	it("a real pen raises it and claims the hardware", () => {
		noteHover()("pen");
		expect(penHardwareSeen()).toBe(true);
		expect(penSeenThisSession()).toBe(true);
	});

	it("touch raises nothing even with mouse ink armed", () => {
		setMouseInk(true);
		noteHover()("touch");
		expect(penSeenThisSession()).toBe(false);
		expect(penHardwareSeen()).toBe(false);
	});
});
