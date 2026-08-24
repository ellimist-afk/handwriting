import { describe, expect, it } from "vitest";
import {
	CameraState,
	MAX_ZOOM,
	MIN_ZOOM,
	clampZoom,
	panBy,
	pinchUpdate,
	screenToWorld,
	worldToScreen,
	zoomAtPoint,
} from "./coordinates";

const cam = (x: number, y: number, zoom: number): CameraState => ({ x, y, zoom });

describe("screenToWorld / worldToScreen", () => {
	it("are inverses at various zooms", () => {
		const cases: CameraState[] = [
			cam(0, 0, 1),
			cam(-500, 1200, 0.25),
			cam(31.5, -17.25, 3.7),
			cam(1e6, -1e6, 0.1),
		];
		for (const c of cases) {
			for (const [sx, sy] of [[0, 0], [123.4, 567.8], [-50, 900]] as const) {
				const w = screenToWorld(c, sx, sy);
				const s = worldToScreen(c, w.x, w.y);
				expect(s.x).toBeCloseTo(sx, 6);
				expect(s.y).toBeCloseTo(sy, 6);
			}
		}
	});

	it("matches the handoff formula", () => {
		const c = cam(100, 200, 2);
		// worldX = screenX / zoom + cameraX
		expect(screenToWorld(c, 50, 30)).toEqual({ x: 125, y: 215 });
	});

	it("1 world unit = 1 css pixel at zoom 1", () => {
		const c = cam(0, 0, 1);
		expect(worldToScreen(c, 42, 42)).toEqual({ x: 42, y: 42 });
	});
});

describe("panBy", () => {
	it("moves camera opposite to drag, scaled by zoom", () => {
		const c = cam(0, 0, 2);
		const next = panBy(c, 100, -50);
		expect(next.x).toBeCloseTo(-50);
		expect(next.y).toBeCloseTo(25);
		expect(next.zoom).toBe(2);
	});

	it("keeps the dragged world point under the moved screen point", () => {
		const c = cam(300, -80, 0.5);
		const grabScreen = { x: 200, y: 150 };
		const grabWorld = screenToWorld(c, grabScreen.x, grabScreen.y);
		const next = panBy(c, 60, 90);
		const after = worldToScreen(next, grabWorld.x, grabWorld.y);
		expect(after.x).toBeCloseTo(grabScreen.x + 60, 6);
		expect(after.y).toBeCloseTo(grabScreen.y + 90, 6);
	});
});

describe("zoomAtPoint", () => {
	it("keeps the anchor world point stationary on screen", () => {
		const c = cam(120, 340, 1);
		const anchorScreen = { x: 400, y: 300 };
		const anchorWorld = screenToWorld(c, anchorScreen.x, anchorScreen.y);
		for (const z of [0.5, 2, 3.3, 0.1, 8]) {
			const next = zoomAtPoint(c, anchorScreen.x, anchorScreen.y, z);
			const after = worldToScreen(next, anchorWorld.x, anchorWorld.y);
			expect(after.x).toBeCloseTo(anchorScreen.x, 6);
			expect(after.y).toBeCloseTo(anchorScreen.y, 6);
			expect(next.zoom).toBe(z);
		}
	});

	it("clamps zoom to range", () => {
		const c = cam(0, 0, 1);
		expect(zoomAtPoint(c, 0, 0, 100).zoom).toBe(MAX_ZOOM);
		expect(zoomAtPoint(c, 0, 0, 0.0001).zoom).toBe(MIN_ZOOM);
	});
});

describe("clampZoom", () => {
	it("rejects non-finite values", () => {
		expect(clampZoom(NaN)).toBe(1);
		expect(clampZoom(Infinity)).toBe(1);
	});
});

describe("pinchUpdate", () => {
	it("scales zoom by distance ratio and tracks the midpoint", () => {
		const c = cam(0, 0, 1);
		const prevMid = { x: 300, y: 300 };
		const anchorWorld = screenToWorld(c, prevMid.x, prevMid.y);
		const next = pinchUpdate(c, prevMid, 100, { x: 320, y: 280 }, 200);
		expect(next.zoom).toBeCloseTo(2, 6);
		// world point under old midpoint is now under new midpoint
		const after = worldToScreen(next, anchorWorld.x, anchorWorld.y);
		expect(after.x).toBeCloseTo(320, 6);
		expect(after.y).toBeCloseTo(280, 6);
	});

	it("handles zero previous distance without blowing up", () => {
		const c = cam(5, 5, 1);
		const next = pinchUpdate(c, { x: 10, y: 10 }, 0, { x: 12, y: 10 }, 50);
		expect(next.zoom).toBe(1);
	});
});
