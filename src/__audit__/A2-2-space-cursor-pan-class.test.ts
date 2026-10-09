// The Insert-space reticle drops the pan styling after a pan hover.
//
// Hover with the Pan tool, pick Insert space, hover again: the seam reticle should be the dashed line, but the
// space branch of paintPenCursor never removes the pan class, and styles.css puts the pan rule after the space
// rule at the same specificity, so the reticle keeps the pan ring's solid border and shadow.
//
// Drives the real paintPenCursor on an overlay built with Object.create and a fake reticle element that records
// its classes. Expected: red until the space branch drops the pan class.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InkOverlayPlugin } from "../inline/InkOverlay";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";

function fakeEl() {
	const classes = new Set<string>();
	return {
		classes,
		classList: {
			add: (c: string) => classes.add(c),
			remove: (c: string) => classes.delete(c),
			contains: (c: string) => classes.has(c),
			toggle: (c: string, on?: boolean) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c), classes.has(c)),
		},
		setCssStyles: () => {},
		style: {},
	};
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	resetTipModeForTest();
});
afterEach(() => {
	resetTipModeForTest();
	vi.unstubAllGlobals();
});

it("the Insert-space reticle drops the pan class after a pan hover", () => {
	const el = fakeEl();
	const o = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	o.penCursorEl = el;
	o.camera = { zoom: 1, screenToWorld: (x: number, y: number) => ({ x, y }) };
	o.cssScale = 1;
	const paint = (InkOverlayPlugin.prototype as unknown as { paintPenCursor: (...a: unknown[]) => void }).paintPenCursor;
	const sample = { x: 100, y: 100, pressure: 0, timestamp: 0, tiltX: 0, tiltY: 0 };

	setTipMode("pan");
	paint.call(o, sample, 1, 1, null);
	expect(el.classes.has("handwriting-pen-hover-pan"), "precondition: the pan hover set the pan class").toBe(true);

	setTipMode("space");
	paint.call(o, sample, 1, 1, null);
	expect(el.classes.has("handwriting-pen-hover-space"), "precondition: the space hover set the space class").toBe(true);
	expect(el.classes.has("handwriting-pen-hover-pan"), "pan class still on the Insert-space reticle").toBe(false);
});
