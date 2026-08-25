import { describe, expect, it } from "vitest";
import { MIN_CURSOR_VISUAL_PX } from "./PenCursor";
import overlaySrc from "./InkOverlay.ts?raw";
import css from "../../styles.css?raw";

function overlaySource(): string {
	return overlaySrc;
}

function cursorCss(): string {
	return css;
}

import { isPenCompatMouseMove, penCursorLayout } from "./PenCursor";

describe("inline pen cursor layout", () => {
	it("centers a visible minimum-size cursor under a thin pen", () => {
		const cursor = penCursorLayout({
			x: 100,
			y: 50,
			strokeWidth: 2,
			cameraZoom: 1,
			cssScale: 1,
		});

		// Pinned to the constant, not a literal: the floor is a presentation
		// choice that moved once already (6px was a speck under the nib).
		const d = MIN_CURSOR_VISUAL_PX;
		expect(cursor).toEqual({ x: 100 - d / 2, y: 50 - d / 2, diameter: d });
	});

	it("keeps the minimum diameter constant in VISUAL pixels under page scaling", () => {
		const cursor = penCursorLayout({
			x: 100,
			y: 50,
			strokeWidth: 2,
			cameraZoom: 1,
			cssScale: 1.25,
		});

		expect(cursor.diameter * 1.25).toBeCloseTo(MIN_CURSOR_VISUAL_PX);
		expect(cursor.x + cursor.diameter / 2).toBe(100);
		expect(cursor.y + cursor.diameter / 2).toBe(50);
	});

	it("shows the selected stroke width when it is larger than the minimum", () => {
		const cursor = penCursorLayout({
			x: 40,
			y: 30,
			strokeWidth: 18,
			cameraZoom: 1.2,
			cssScale: 1,
		});

		expect(cursor.diameter).toBeCloseTo(21.6);
		expect(cursor.x + cursor.diameter / 2).toBeCloseTo(40);
		expect(cursor.y + cursor.diameter / 2).toBeCloseTo(30);
	});
});

describe("inline pen cursor ownership", () => {
	it("keeps the pen cursor through an immediate same-point mouse-compatible move", () => {
		expect(
			isPenCompatMouseMove({
				now: 1050,
				lastPenHoverAt: 1000,
				mouseX: 401,
				mouseY: 299,
				penX: 400,
				penY: 300,
			})
		).toBe(true);
	});

	it("lets a real mouse at another point restore the editor cursor", () => {
		expect(
			isPenCompatMouseMove({
				now: 1050,
				lastPenHoverAt: 1000,
				mouseX: 450,
				mouseY: 300,
				penX: 400,
				penY: 300,
			})
		).toBe(false);
	});

	it("lets a later mouse move restore the editor cursor at the same point", () => {
		expect(
			isPenCompatMouseMove({
				now: 1201,
				lastPenHoverAt: 1000,
				mouseX: 400,
				mouseY: 300,
				penX: 400,
				penY: 300,
			})
		).toBe(false);
	});
});

describe("the cursors have to be shown with a real display value", () => {
	// Both cursors sat at display:none in the stylesheet and were "shown"
	// with setCssStyles({ display: "" }). An empty string REMOVES the inline
	// declaration, so the element fell back to the stylesheet and neither the
	// pen reticle nor the eraser ring ever appeared on screen. They were
	// positioned and sized correctly every frame, invisibly.
	const source = overlaySource();

	it("never uses an empty display string to reveal a cursor", () => {
		const showBlocks = source.match(/(penCursorEl|eraserEl)\.setCssStyles\(\{[^}]*\}/gs) ?? [];
		expect(showBlocks.length).toBeGreaterThan(0);
		for (const block of showBlocks) {
			if (!block.includes("display")) continue;
			expect(block).not.toMatch(/display:\s*""/);
		}
	});

	it("keeps the stylesheet default that made the bug possible", () => {
		// If this rule ever goes away the empty-string form would start
		// working by accident, which is worse than failing loudly.
		expect(cursorCss()).toMatch(/\.handwriting-pen-cursor[\s\S]*?display:\s*none/);
	});
});
