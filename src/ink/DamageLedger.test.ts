import { describe, expect, it } from "vitest";
import { DamageLedger, shiftPlan } from "./DamageLedger";

describe("DamageLedger", () => {
	it("first take is everything (the world needs a first paint)", () => {
		const d = new DamageLedger();
		expect(d.take()).toBe("all");
		expect(d.take()).toEqual([]);
	});

	it("rects accumulate padded and drain on take", () => {
		const d = new DamageLedger();
		d.take();
		d.addRect({ x: 10, y: 20, width: 30, height: 40 });
		const out = d.take();
		expect(out).not.toBe("all");
		const rects = out as { x: number; y: number; width: number; height: number }[];
		expect(rects).toHaveLength(1);
		expect(rects[0]!.x).toBeLessThan(10);
		expect(rects[0]!.width).toBeGreaterThan(30);
		expect(d.isEmpty).toBe(true);
	});

	it("addAll swallows pending rects", () => {
		const d = new DamageLedger();
		d.take();
		d.addRect({ x: 0, y: 0, width: 1, height: 1 });
		d.addAll();
		expect(d.take()).toBe("all");
	});

	// A stroke eraser zoomed out takes more than twelve strokes in one frame. Going to "all" there redrew every stroke on
	// screen by path; one rect around them all repaints only the place that changed.
	it("the thirteenth rect coalesces into one union rect covering every input, not everything", () => {
		const d = new DamageLedger();
		d.take();
		const inputs = Array.from({ length: 13 }, (_, i) => ({ x: i * 100 - 300, y: (i % 3) * 50, width: 10 + i, height: 20 }));
		for (const r of inputs) d.addRect(r);
		expect(d.isAll).toBe(false);
		expect(d.isEmpty).toBe(false);
		const out = d.take();
		expect(out).not.toBe("all");
		const rects = out as { x: number; y: number; width: number; height: number }[];
		expect(rects).toHaveLength(1);
		const u = rects[0]!;
		for (const r of inputs) {
			expect(u.x).toBeLessThan(r.x);
			expect(u.y).toBeLessThan(r.y);
			expect(u.x + u.width).toBeGreaterThan(r.x + r.width);
			expect(u.y + u.height).toBeGreaterThan(r.y + r.height);
		}
		// Padded like any rect, and no larger than the inputs' padded hull.
		expect(u).toEqual({ x: -304, y: -4, width: 1200 + 22 + 8, height: 100 + 20 + 8 });
		expect(d.take()).toEqual([]);
	});

	it("rects after the union keep growing it, and twelve rects stay separate", () => {
		const d = new DamageLedger();
		d.take();
		for (let i = 0; i < 20; i++) d.addRect({ x: i * 100, y: 0, width: 1, height: 1 });
		const out = d.take();
		expect(out).toEqual([{ x: -4, y: -4, width: 1900 + 1 + 8, height: 1 + 8 }]);
		for (let i = 0; i < 12; i++) d.addRect({ x: i * 100, y: 0, width: 1, height: 1 });
		expect(d.take()).toHaveLength(12);
	});

	it("addAll after a union still gives everything", () => {
		const d = new DamageLedger();
		d.take();
		for (let i = 0; i < 13; i++) d.addRect({ x: i * 100, y: 0, width: 1, height: 1 });
		d.addAll();
		expect(d.take()).toBe("all");
	});

	it("rects added while everything is pending are absorbed", () => {
		const d = new DamageLedger();
		d.addRect({ x: 0, y: 0, width: 5, height: 5 });
		expect(d.take()).toBe("all");
	});
});

describe("shiftPlan", () => {
	it("no movement plans nothing", () => {
		const p = shiftPlan(0, 0, 1, 100, 200, 800, 600);
		expect(p).toEqual({ shiftX: 0, shiftY: 0, exposed: [] });
	});

	it("scrolling down exposes a bottom band", () => {
		// camera moved +50 world in y at zoom 1
		const p = shiftPlan(0, 50, 1, 0, 250, 800, 600)!;
		expect(p.shiftY).toBe(-50);
		expect(p.exposed).toHaveLength(1);
		const band = p.exposed[0]!;
		expect(band.y).toBeCloseTo(250 + 600 - 50);
		expect(band.height).toBeCloseTo(50);
		expect(band.width).toBeCloseTo(800);
	});

	it("scrolling up exposes a top band", () => {
		const p = shiftPlan(0, -50, 1, 0, 200, 800, 600)!;
		expect(p.shiftY).toBe(50);
		const band = p.exposed[0]!;
		expect(band.y).toBeCloseTo(200);
		expect(band.height).toBeCloseTo(50);
	});

	it("diagonal shift exposes two non-overlapping bands", () => {
		const p = shiftPlan(30, 50, 1, 100, 200, 800, 600)!;
		expect(p.shiftX).toBe(-30);
		expect(p.shiftY).toBe(-50);
		expect(p.exposed).toHaveLength(2);
		const [v, h] = p.exposed;
		// vertical band on the right edge
		expect(v!.x).toBeCloseTo(100 + 800 - 30);
		expect(v!.width).toBeCloseTo(30);
		// horizontal band excludes the corner the vertical band owns
		expect(h!.width).toBeCloseTo(800 - 30);
		expect(h!.height).toBeCloseTo(50);
	});

	it("zoom scales world bands from css shift", () => {
		const p = shiftPlan(50, 0, 2, 0, 0, 800, 600)!;
		expect(p.shiftX).toBe(-100); // 50 world * zoom 2 in css
		const band = p.exposed[0]!;
		expect(band.width).toBeCloseTo(50);
		expect(band.height).toBeCloseTo(300); // 600 css / zoom 2
	});

	it("a jump beyond the viewport degenerates to full repaint", () => {
		expect(shiftPlan(900, 0, 1, 0, 0, 800, 600)).toBe(null);
	});
});
