/**
 * The zoom bar's + and − move on one grid, 100% x 1.25^n: each tap a quarter
 * larger or smaller, never a double or a half.
 *
 * The pure cells drive nextZoomStep with the bar's own floor and ceiling
 * (MIN_PINCH_SCALE, MAX_PINCH_SCALE). The last block builds the real
 * NoteZoomControls over a fake viewport whose zoomNoteBy keeps the real clamp,
 * clicks the buttons and reads the readout the user sees.
 */
import { describe, expect, it } from "vitest";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import { NoteZoomControls } from "./NoteZoomControls";
import { MAX_PINCH_SCALE, MIN_PINCH_SCALE } from "./PinchScale";
import { ZOOM_GRID_TOLERANCE, ZOOM_STEP_RATIO, nextZoomStep } from "./ZoomStep";

const plus = (z: number): number => nextZoomStep(z, 1, MIN_PINCH_SCALE, MAX_PINCH_SCALE);
const minus = (z: number): number => nextZoomStep(z, -1, MIN_PINCH_SCALE, MAX_PINCH_SCALE);
const grid = (n: number): number => Math.pow(ZOOM_STEP_RATIO, n);

/** Tap `count` times from `start`, each tap starting where the last one landed. */
function taps(step: (z: number) => number, start: number, count: number): number[] {
	const out: number[] = [];
	let z = start;
	for (let i = 0; i < count; i++) out.push(z = step(z));
	return out;
}

function expectScales(actual: number[], expected: number[], what: string): void {
	expect(actual.length, what).toBe(expected.length);
	actual.forEach((z, i) => expect(z, `${what}, tap ${i + 1}: got ${z}, want ${expected[i]}`).toBeCloseTo(expected[i]!, 10));
}

describe("zoom bar step grid", () => {
	it("the grid is a quarter per step through 100%", () => {
		expect(ZOOM_STEP_RATIO).toBe(1.25);
		expect(ZOOM_GRID_TOLERANCE).toBe(0.005);
		expect(MIN_PINCH_SCALE, "the floor this file is written against").toBe(0.1);
		expect(MAX_PINCH_SCALE, "the ceiling this file is written against").toBe(6);
	});

	it("eleven minus taps from 100% walk the grid down to the 10% floor, then stop", () => {
		expectScales(taps(minus, 1, 12), [
			0.8, 0.64, 0.512, 0.4096, 0.32768, 0.262144, 0.2097152, 0.16777216, 0.134217728, 0.1073741824,
			0.1, 0.1,
		], "minus from 100%");
	});

	it("plus taps from 100% walk the grid up to the 600% ceiling, then stop", () => {
		expectScales(taps(plus, 1, 10), [
			1.25, 1.5625, 1.953125, 2.44140625, 3.0517578125, 3.814697265625, 4.76837158203125, 5.9604644775390625,
			6, 6,
		], "plus from 100%");
	});

	it("from off the grid, a tap lands on the next grid value in its direction", () => {
		expect(plus(1.37), "137% plus").toBeCloseTo(1.5625, 10);
		expect(minus(1.37), "137% minus: round-to-nearest would skip 125% for 100%").toBeCloseTo(1.25, 10);
		expect(plus(1.5), "150% plus: round-to-nearest would skip 156% for 195%").toBeCloseTo(1.5625, 10);
		expect(minus(1.5), "150% minus").toBeCloseTo(1.25, 10);
		expect(plus(0.7), "70% plus").toBeCloseTo(0.8, 10);
		expect(minus(0.7), "70% minus").toBeCloseTo(0.64, 10);
	});

	it("within half a percent of a grid value counts as on it", () => {
		expect(plus(1.246), "124.6% is on 125%, so plus goes to 156%").toBeCloseTo(1.5625, 10);
		expect(minus(1.246), "124.6% is on 125%, so minus goes to 100%").toBeCloseTo(1, 10);
		expect(plus(1.254), "125.4% is on 125%, so plus goes to 156%").toBeCloseTo(1.5625, 10);
		expect(minus(1 + 1e-12), "float residue over 100%").toBeCloseTo(0.8, 10);
		expect(plus(1 - 1e-12), "float residue under 100%").toBeCloseTo(1.25, 10);
	});

	it("minus near the floor lands on 10%, and at or below it does nothing", () => {
		expect(minus(0.12), "12% minus: 10.7% is still a grid value above the floor").toBeCloseTo(0.1073741824, 10);
		expect(minus(0.105), "10.5% minus: the next grid value is under 10%, so 10%").toBe(MIN_PINCH_SCALE);
		expect(minus(0.1), "10% minus does nothing").toBe(0.1);
		expect(minus(0.07), "7% (after Fit) minus does nothing; Fit alone goes lower").toBe(0.07);
		expect(plus(0.07), "7% (after Fit) plus climbs onto the grid").toBeCloseTo(grid(-11), 10);
		expect(grid(-11)).toBeCloseTo(0.08589934592, 10);
		expect(plus(0.1), "10% plus").toBeCloseTo(0.1073741824, 10);
	});

	it("plus never passes the ceiling; the last tap lands on it", () => {
		expect(plus(5.5)).toBeCloseTo(5.9604644775390625, 10);
		expect(plus(5.9604644775390625)).toBe(MAX_PINCH_SCALE);
		expect(plus(6)).toBe(6);
		expect(minus(6), "600% is off the grid, so minus lands on 596%").toBeCloseTo(5.9604644775390625, 10);
	});

	it("no tap from anywhere on the bar's range ever doubles, halves, or moves the wrong way", () => {
		const most = ZOOM_STEP_RATIO * (1 + ZOOM_GRID_TOLERANCE) / (1 - ZOOM_GRID_TOLERANCE);
		for (let z = 0.05; z <= 6.2; z *= 1.0137) {
			const up = plus(z);
			const down = minus(z);
			expect(up, `plus from ${z}`).toBeGreaterThanOrEqual(z);
			expect(down, `minus from ${z}`).toBeLessThanOrEqual(z);
			expect(up / z, `plus from ${z} went to ${up}`).toBeLessThanOrEqual(most);
			expect(z / down, `minus from ${z} went to ${down}`).toBeLessThanOrEqual(most);
			if (z < MAX_PINCH_SCALE * (1 - ZOOM_GRID_TOLERANCE)) expect(up, `plus from ${z} did nothing`).toBeGreaterThan(z);
			if (z > MIN_PINCH_SCALE * (1 + ZOOM_GRID_TOLERANCE)) expect(down, `minus from ${z} did nothing`).toBeLessThan(z);
		}
	});
});

/** A note viewport whose zoomNoteBy keeps the real clamp (InkOverlayZoomApi.ts). */
function fakeViewport(start = 1) {
	let zoom = start;
	const factors: number[] = [];
	return {
		factors,
		zoom: (): number => zoom,
		viewport: {
			getNoteViewportState: () => ({ zoom, busy: false, fitAvailable: true }),
			zoomNoteBy: (factor: number): boolean => {
				factors.push(factor);
				zoom = Math.max(Math.min(MIN_PINCH_SCALE, zoom), Math.min(MAX_PINCH_SCALE, zoom * factor));
				return true;
			},
			resetNoteZoom: (): boolean => { zoom = 1; return true; },
			fitHandwriting: (): string => "ok",
		},
	};
}

function mountBar(start = 1) {
	const pane = new FakeEl("div", new FakeDoc());
	const fake = fakeViewport(start);
	const controls = new NoteZoomControls(pane as unknown as HTMLElement, { noteViewport: fake.viewport, notePath: () => null });
	const buttons = (controls.element as unknown as FakeEl).children.filter(c => c.tagName.toLowerCase() === "button");
	const [out, readout, into] = [buttons[0]!, buttons[1]!, buttons[2]!];
	return {
		fake,
		readout: (): string => readout.textContent,
		tapPlus: (): string => { into.fire("click"); return readout.textContent; },
		tapMinus: (): string => { out.fire("click"); return readout.textContent; },
		destroy: (): void => controls.destroy(),
	};
}

describe("zoom bar buttons on the grid", () => {
	it("a tap on + from 100% shows 125% in the readout", () => {
		const bar = mountBar();
		try {
			expect(bar.readout()).toBe("100%");
			expect(bar.tapPlus()).toBe("125%");
			expect(bar.fake.zoom()).toBeCloseTo(1.25, 12);
		} finally { bar.destroy(); }
	});

	it("the readout walks the grid both ways, as today's three-digit rounding shows it", () => {
		const bar = mountBar();
		try {
			const up = Array.from({ length: 10 }, () => bar.tapPlus());
			expect(up).toEqual(["125%", "156%", "195%", "244%", "305%", "381%", "477%", "596%", "600%", "600%"]);
			bar.fake.viewport.resetNoteZoom();
			const down = Array.from({ length: 12 }, () => bar.tapMinus());
			expect(down).toEqual(["80%", "64%", "51.2%", "41%", "32.8%", "26.2%", "21%", "16.8%", "13.4%", "10.7%", "10%", "10%"]);
		} finally { bar.destroy(); }
	});

	it("no button tap passes a factor of 2 or 0.5 to the viewport", () => {
		const bar = mountBar();
		try {
			for (let i = 0; i < 12; i++) bar.tapMinus();
			for (let i = 0; i < 12; i++) bar.tapPlus();
			expect(bar.fake.factors.length).toBeGreaterThan(0);
			for (const f of bar.fake.factors) {
				expect(f, `factor ${f}`).toBeLessThanOrEqual(1.26);
				expect(f, `factor ${f}`).toBeGreaterThanOrEqual(0.79);
			}
		} finally { bar.destroy(); }
	});

	it("taps stay on the grid, so a tap after ten taps is still exactly a quarter", () => {
		const bar = mountBar();
		try {
			for (let i = 0; i < 7; i++) bar.tapPlus();
			for (let i = 0; i < 7; i++) bar.tapMinus();
			expect(bar.fake.zoom()).toBeCloseTo(1, 12);
			expect(bar.readout()).toBe("100%");
		} finally { bar.destroy(); }
	});

	it("from off the grid (after a pinch) the buttons land on the next grid value", () => {
		const bar = mountBar(1.37);
		try {
			expect(bar.tapPlus()).toBe("156%");
			expect(bar.tapMinus()).toBe("125%");
		} finally { bar.destroy(); }
	});
});
