import { describe, expect, it } from "vitest";
import { CAMERA_STILL_BACKING_PX, cameraWithin, committedRepaintPlan, InkOverlayPlugin, type RasterCamera } from "./InkOverlay";

/**
 * The committed raster redraws when the camera really moved, not when a DOM re-measure lands a hair off.
 *
 * On Orion a touch scroll at fractional offsets re-measured the camera a fraction of a device pixel away from
 * the camera the raster was painted with, and the exact compare redrew the whole layer on 59 of 67 still-band
 * scroll repaints. A move under a tenth of a backing pixel is no move; the compare is against the camera the
 * raster was painted with, which is kept while the camera stays inside the bar, so small steps add up and the
 * one that crosses the bar redraws once.
 */
const BACKING = 2;
const ZOOM = 1.1176426850344592;
/** One backing pixel in camera units at this backing and zoom. */
const PX = 1 / (BACKING * ZOOM);
const painted: RasterCamera = { x: -151.77, y: -265.41, zoom: ZOOM };
const none: never[] = [];

describe("the committed raster's camera test", () => {
	it("a camera move of 1e-6 with no damage paints nothing and keeps the painted camera", () => {
		const plan = committedRepaintPlan(painted, { x: painted.x + 1e-6, y: painted.y - 1e-6, zoom: ZOOM }, none, BACKING);
		expect(plan.work).toEqual([]);
		expect(plan.sources).toEqual([]);
		expect(plan.painted, "the record stays the camera the raster was painted with").toBe(painted);
	});

	it("a move of 0.2 backing pixel paints all and records the camera now", () => {
		const cam = { x: painted.x + 0.2 * PX, y: painted.y, zoom: ZOOM };
		const plan = committedRepaintPlan(painted, cam, none, BACKING);
		expect(plan.work).toBe("all");
		expect(plan.sources).toEqual(["camera"]);
		expect(plan.painted).toEqual(cam);
	});

	it("many small steps summing over the bar paint all once", () => {
		let rec: RasterCamera = painted;
		let x = painted.x;
		const alls: number[] = [];
		for (let i = 1; i <= 5; i++) {
			x += 0.03 * PX;
			const plan = committedRepaintPlan(rec, { x, y: painted.y, zoom: ZOOM }, none, BACKING);
			if (plan.work === "all") alls.push(i);
			rec = plan.painted;
		}
		// 0.03, 0.06, 0.09 stay under the bar; 0.12 crosses it and redraws; the fifth step is 0.03 from that redraw.
		expect(alls).toEqual([4]);
	});

	it("names each source of a full redraw", () => {
		expect(committedRepaintPlan(null, painted, none, BACKING).sources).toEqual(["first"]);
		expect(committedRepaintPlan(painted, { ...painted, zoom: ZOOM + 1e-9 }, none, BACKING).sources, "zoom stays exact").toEqual(["zoom"]);
		const damaged = committedRepaintPlan(painted, { ...painted, x: painted.x + 1e-6 }, "all", BACKING);
		expect(damaged.work).toBe("all");
		expect(damaged.sources).toEqual(["damage"]);
		expect(damaged.painted, "a full redraw paints at the camera now").toEqual({ ...painted, x: painted.x + 1e-6 });
		expect(committedRepaintPlan(painted, { ...painted, x: painted.x + 2 * PX }, "all", BACKING).sources).toEqual(["camera", "damage"]);
	});

	it("gives a carried frame no wider bar: half a backing pixel redraws", () => {
		const rect = { x: 0, y: 0, width: 10, height: 10 };
		const cam = { x: painted.x + 0.5 * PX, y: painted.y - 0.5 * PX, zoom: ZOOM };
		expect(committedRepaintPlan(painted, cam, [rect], BACKING).work).toBe("all");
		const near = { x: painted.x + 0.05 * PX, y: painted.y - 0.05 * PX, zoom: ZOOM };
		const kept = committedRepaintPlan(painted, near, [rect], BACKING);
		expect(kept.work, "inside the bar the damage rects are what is owed").toEqual([rect]);
		expect(kept.painted).toBe(painted);
	});

	it("at the bar on either axis and sign the camera is still; just past it the layer redraws", () => {
		const rect = { x: 0, y: 0, width: 10, height: 10 };
		for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
			const at = { x: painted.x + ax * 0.099 * PX, y: painted.y + ay * 0.099 * PX, zoom: ZOOM };
			const atPlan = committedRepaintPlan(painted, at, [rect], BACKING);
			expect(atPlan.work, `0.099 px along (${ax},${ay})`).toEqual([rect]);
			expect(atPlan.painted).toBe(painted);
			const past = { x: painted.x + ax * 0.101 * PX, y: painted.y + ay * 0.101 * PX, zoom: ZOOM };
			const pastPlan = committedRepaintPlan(painted, past, [rect], BACKING);
			expect(pastPlan.work, `0.101 px along (${ax},${ay})`).toBe("all");
			expect(pastPlan.sources).toEqual(["camera"]);
			expect(pastPlan.painted).toEqual(past);
		}
	});

	it("still repaints a real origin move, a zoom change, explicit damage and a band change", () => {
		const rect = { x: 5, y: 5, width: 20, height: 20 };
		const origin = committedRepaintPlan(painted, { ...painted, y: painted.y + 3 * PX }, none, BACKING);
		expect(origin.work, "the origin moved three backing pixels").toBe("all");
		const zoom = committedRepaintPlan(painted, { ...painted, zoom: ZOOM * 1.0001 }, none, BACKING);
		expect(zoom.work).toBe("all");
		expect(zoom.sources).toEqual(["zoom"]);
		const damage = committedRepaintPlan(painted, painted, [rect], BACKING);
		expect(damage.work, "damage with the camera still paints its rects").toEqual([rect]);
		const band = committedRepaintPlan(painted, { ...painted, x: painted.x + 101.10526315789474 }, none, BACKING);
		expect(band.work, "a band move that did not carry shifts the camera by the move").toBe("all");
		expect(band.sources).toEqual(["camera"]);
	});

	it("passes only an exact match when the backing cannot say how big a pixel is", () => {
		expect(cameraWithin(1, 2, ZOOM, 1, 2, ZOOM, 0, CAMERA_STILL_BACKING_PX)).toBe(true);
		expect(cameraWithin(1, 2, ZOOM, 1 + 1e-9, 2, ZOOM, 0, CAMERA_STILL_BACKING_PX)).toBe(false);
		expect(cameraWithin(1, 2, ZOOM, 1 + 1e-9, 2, ZOOM, Number.NaN, CAMERA_STILL_BACKING_PX)).toBe(false);
	});
});

type Fields = Record<string, any>;
const noop = (): undefined => undefined;

describe("a band carry records the camera its pixels sit at", () => {
	it("the painted camera plus the shift, not the camera held, when the two sit a hair apart", () => {
		const o = Object.create(InkOverlayPlugin.prototype) as Fields;
		const ctx = { save: noop, restore: noop, setTransform: noop, drawImage: noop, globalCompositeOperation: "" };
		const held = { x: 0, y: 0, zoom: 1 };
		const rec = { x: 4e-7, y: -3e-7, zoom: 1 };
		Object.assign(o, {
			band: { left: 0, top: 0, width: 800, height: 1200 }, container: { setCssStyles: noop },
			committedBacking: 1, fontZoom: 1, cssWidth: 800, cssHeight: 1200,
			camera: { snapshot: held, setState: noop }, lastPaintCam: rec,
			committedCtx: ctx, committedCanvas: {}, highlightCtx: ctx, highlightCanvas: {},
			wet: { carry: noop }, highlightWet: { carry: noop }, tail: { carry: noop },
			damage: { addRect: noop }, router: { refreshRect: noop }, bandSyncDeferred: false,
			predReal: [], predLastTail: [],
		});
		expect(o.carryBandUnderLock({ left: 0, top: 300, width: 800, height: 1200 })).toBe("moved");
		expect(o.lastPaintCam).toEqual({ x: rec.x, y: rec.y + 300, zoom: 1 });
	});
});
