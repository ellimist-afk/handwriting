import { describe, expect, it } from "vitest";

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

		expect(cursor).toEqual({ x: 97, y: 47, diameter: 6 });
	});

	it("keeps the minimum diameter at six visual pixels under page scaling", () => {
		const cursor = penCursorLayout({
			x: 100,
			y: 50,
			strokeWidth: 2,
			cameraZoom: 1,
			cssScale: 1.25,
		});

		expect(cursor.diameter * 1.25).toBeCloseTo(6);
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
