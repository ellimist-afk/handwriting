import { afterEach, beforeEach, expect, it } from "vitest";
import { InkOverlayPlugin, releaseTipModes, setPenReticle } from "./InkOverlay";
import { Camera } from "../camera/Camera";
import { setTipMode } from "./TipMode";

// A hover sample moves the reticle and nothing else: its mode class and its fixed size, colour and opacity are written
// when the mode or the shown state changes, never per sample, and the scroller's hover class is added only when absent.
// A class or style write that changes nothing still sets the attribute, and the baseline's 60 class writes and 15
// scroller writes a second were all of that kind.

function rig() {
	const classWrites: string[] = [];
	const styleWrites: Record<string, string>[] = [];
	const scrollerClasses = new Set<string>();
	const scrollerWrites: string[] = [];
	const inst = Object.create(InkOverlayPlugin.prototype) as Record<string, any>;
	Object.assign(inst, {
		camera: new Camera(), cssScale: 1, penCursorPinned: false, penCursorShown: false, penCursorClient: null,
		hoverWatchdog: null, mode: "ink", spacePlan: null,
		router: null,
		penCursorEl: {
			classList: { add: (c: string) => classWrites.push("+" + c), remove: (c: string) => classWrites.push("-" + c) },
			setCssStyles: (s: Record<string, string>) => styleWrites.push(s),
		},
		view: {
			dom: { ownerDocument: { defaultView: { setTimeout: () => 1, clearTimeout: () => undefined } } },
			scrollDOM: { classList: {
				add: (c: string) => { scrollerWrites.push("+" + c); scrollerClasses.add(c); },
				remove: (c: string) => { scrollerWrites.push("-" + c); scrollerClasses.delete(c); },
				contains: (c: string) => scrollerClasses.has(c),
			} },
		},
		clearSpaceFeedback: () => undefined,
		queueSpaceFeedback: () => undefined,
	});
	const hover = (x: number, y: number) => inst.showPenCursor({ x, y, pressure: 0, timestamp: 0, tiltX: 0, tiltY: 0 }, "pen");
	return { inst, hover, classWrites, styleWrites, scrollerWrites };
}

beforeEach(() => { setPenReticle(true); releaseTipModes(); });
afterEach(() => { setPenReticle(true); releaseTipModes(); });

it("twenty hover samples in one mode write the class once, the fixed styles once, and then only the transform", () => {
	const r = rig();
	r.hover(10, 10);
	const firstClasses = r.classWrites.length;
	expect(r.styleWrites[0]).toMatchObject({ width: expect.any(String), opacity: expect.any(String) });
	r.styleWrites.length = 0;
	for (let i = 1; i <= 20; i++) r.hover(10 + i, 10 + i);
	expect(r.classWrites.length, "a hover sample wrote the mode classes again").toBe(firstClasses);
	expect(r.styleWrites.length).toBe(20);
	for (const s of r.styleWrites) expect(Object.keys(s)).toEqual(["transform"]);
	expect(r.scrollerWrites, "the scroller's hover class was written on every sample").toHaveLength(1);
});

it("a mode change writes the classes again, and hiding then showing writes the opacity again", () => {
	const r = rig();
	r.hover(10, 10);
	setTipMode("lasso");
	const before = r.classWrites.length;
	r.styleWrites.length = 0;
	r.hover(12, 12);
	expect(r.classWrites.length).toBeGreaterThan(before);
	expect(r.classWrites).toContain("+handwriting-pen-hover-lasso");
	expect(Object.keys(r.styleWrites[0]!)).toContain("width");
	r.inst.concealPenCursor();
	expect(r.styleWrites.at(-1)).toEqual({ opacity: "0" });
	r.styleWrites.length = 0;
	r.hover(14, 14);
	expect(r.styleWrites[0]).toMatchObject({ opacity: "1", transform: expect.any(String) });
});
