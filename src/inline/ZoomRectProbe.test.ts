/**
 * The engine check behind the CSS zoom path: two hidden boxes of one width,
 * at zoom 2 and zoom 1, compared by rect width. Scaled rects (ratio near 2)
 * keep the zoom path; unscaled rects (ratio near 1, WebKit before Safari
 * 26.4) take the transform path; no answer keeps today's choice and is asked
 * again. A real answer is asked once per window.
 */
import { describe, expect, it } from "vitest";
import * as ZoomScale from "./ZoomScale";

type Probe = (win: Window | undefined) => boolean | null;
const probe = (ZoomScale as unknown as { zoomScalesClientRects?: Probe }).zoomScalesClientRects;

/** A window whose boxes report `width(zoom)` for their rect width; counts every box made. */
function fakeWindow(width: (zoom: number) => number | "throw") {
	let made = 0, live = 0;
	const body = { appendChild: () => { live++; } };
	const createDiv = () => {
		made++;
		const style = { cssText: "" };
		return {
			style,
			remove: () => { live--; },
			getBoundingClientRect: () => {
				const z = Number(/zoom:([\d.]+)/.exec(style.cssText)?.[1] ?? 1);
				const w = width(z);
				if (w === "throw") throw new Error("no layout");
				return { width: w, height: 1, left: 0, top: 0, right: w, bottom: 1, x: 0, y: 0 };
			},
		};
	};
	return { win: { document: { body }, createDiv } as unknown as Window, made: () => made, live: () => live };
}

describe("zoom rect probe", () => {
	it("exists", () => {
		expect(typeof probe, "zoomScalesClientRects is missing").toBe("function");
	});

	it("scaled rects (current engines): the zoom-2 box reads twice as wide, answer true", () => {
		const f = fakeWindow((z) => 100 * z);
		expect(probe?.(f.win)).toBe(true);
		expect(f.live(), "the probe left boxes in the page").toBe(0);
	});

	it("unscaled rects (WebKit before 26.4): both boxes read the same width, answer false", () => {
		const f = fakeWindow(() => 100);
		expect(probe?.(f.win)).toBe(false);
		expect(f.live(), "the probe left boxes in the page").toBe(0);
	});

	it("a zoom on the body cancels out: ratio decides, not the absolute width", () => {
		expect(probe?.(fakeWindow((z) => 50 * z).win)).toBe(true);
		expect(probe?.(fakeWindow(() => 250).win)).toBe(false);
	});

	it("no answer (zero rect, a throw, no body, no window) is null and is asked again", () => {
		const zero = fakeWindow(() => 0);
		expect(probe?.(zero.win)).toBeNull();
		expect(probe?.(zero.win)).toBeNull();
		expect(zero.made(), "a null answer was remembered").toBe(4);
		const thrower = fakeWindow(() => "throw");
		expect(probe?.(thrower.win)).toBeNull();
		expect(thrower.live(), "a throw left boxes in the page").toBe(0);
		expect(probe?.({ document: { createElement: () => ({}) } } as unknown as Window)).toBeNull();
		expect(probe?.(undefined)).toBeNull();
	});

	it("a real answer is asked once per window", () => {
		const f = fakeWindow((z) => 100 * z);
		expect(probe?.(f.win)).toBe(true);
		expect(probe?.(f.win)).toBe(true);
		expect(probe?.(f.win)).toBe(true);
		expect(f.made(), "the probe ran more than once for one window").toBe(2);
		const g = fakeWindow(() => 100);
		expect(probe?.(g.win), "another window gets its own answer").toBe(false);
	});
});
