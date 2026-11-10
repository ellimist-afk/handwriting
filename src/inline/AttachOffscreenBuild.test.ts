/**
 * The attached layer builds sprites only for the groups a paint can show. Thirty groups, five in the view and
 * twenty-five below it, off-screen groups first in store order: a zoom step draws again the five on screen, in one still
 * paint, and none of the twenty-five; a group that scrolls into view is built once and copied once; a group that leaves
 * keeps its sprite. Control: a paint at a still camera with no zoom step builds nothing and copies what it copied before.
 * Each cell names the defect that must turn it red. No browser: the canvases are fakes whose contexts take any call.
 */
import { Platform } from "obsidian";
import { describe, expect, it } from "vitest";
import { AttachedLayer, spriteLayerMaxDevicePx, spriteMaxDevicePx, type AttachedGroup } from "./InkOverlayAttachedLayer";
import { computeBBox, type InkStroke } from "../ink/Stroke";

function fakeCanvas() {
	const ctx = new Proxy({} as Record<string, unknown>, {
		get(target, key) {
			if (key in target) return target[key as string];
			if (key === "measureText") return () => ({ width: 0 });
			return () => undefined;
		},
		set(target, key, value) {
			target[key as string] = value;
			return true;
		},
	});
	return { width: 300, height: 150, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** A small group at (x, y): three strokes, one tile at any zoom here. */
function groupAt(id: string, x: number, y: number): AttachedGroup {
	const members = [strokeAt(id + "-a", x, y), strokeAt(id + "-b", x + 20, y + 4), strokeAt(id + "-c", x + 40, y + 8)];
	return { id, members, offset: { dx: 0, dy: 0 }, shown: () => members };
}

const SIZE = { backingW: 800, backingH: 600, backing: 2, cssW: 400, cssH: 300 };

/**
 * Five groups in the view at zoom 1 and 0.9 (y 40 to 240), twenty-five below it, 400 apart from y 2000; the
 * twenty-five come first in store order, so a budget spent in store order goes to them first.
 */
function setup() {
	const on = [0, 1, 2, 3, 4].map((i) => groupAt("on-" + i, 40 + (i % 2) * 150, 40 + Math.floor(i / 2) * 90));
	const off = Array.from({ length: 25 }, (_, i) => groupAt("off-" + i, 40, 2000 + i * 400));
	const groups = [...off, ...on];
	const layer = new AttachedLayer(fakeCanvas(), fakeCanvas(), fakeCanvas);
	const built: string[] = [];
	layer.onSprite = (id) => void built.push(id);
	const c = layer.counts;
	/** One paint; what it built, the tiles it drew into sprites and by path, and the copies it made. */
	const paint = (cam: { x: number; y: number; zoom: number }, build: boolean) => {
		const before = { tilesByPath: c.tilesByPath, blits: c.blits, paints: c.paints, n: built.length };
		layer.paint(cam, groups, false, undefined, SIZE, build);
		return { built: built.slice(before.n), tiles: c.tilesLastPaint, tilesByPath: c.tilesByPath - before.tilesByPath, blits: c.blits - before.blits, painted: c.paints - before.paints };
	};
	/** A camera move: one paint while it moves, then still paints until nothing waits. */
	const settle = (cam: { x: number; y: number; zoom: number }) => {
		const moving = paint(cam, false);
		const still: ReturnType<typeof paint>[] = [];
		for (let i = 0; i < 20; i++) {
			still.push(paint(cam, true));
			if (!layer.buildWaits) break;
		}
		return { moving, still };
	};
	return { layer, groups, paint, settle, built };
}

const sum = (rows: { tiles: number }[]) => rows.reduce((a, r) => a + r.tiles, 0);

describe("attached layer, groups off screen", () => {
	it("a zoom step draws again only the five groups on screen, in one still paint, and no group off screen", () => {
		// Defect: the paint asks every group for its sprite before its on-screen test, so the step draws all thirty again
		// and the per-paint tile budget goes to the twenty-five off screen first.
		const { paint, settle } = setup();
		const cam1 = { x: 0, y: 0, zoom: 1 };
		paint(cam1, true);
		const step = settle({ x: 0, y: 0, zoom: 0.9 });
		const built = step.still.flatMap((p) => p.built);
		expect(built.filter((id) => id.startsWith("off-"))).toEqual([]);
		expect(built.filter((id) => id.startsWith("on-")).sort()).toEqual(["on-0", "on-1", "on-2", "on-3", "on-4"]);
		expect([sum(step.still), step.still.length, step.still[0]!.tilesByPath]).toEqual([5, 1, 0]);
	});

	it("the five groups on screen take the tile budget before any group off screen, at the load too", () => {
		// Defect: the budget goes in store order, so with the off-screen groups first the groups on screen draw by path
		// and finish a paint later.
		const { paint } = setup();
		const first = paint({ x: 0, y: 0, zoom: 1 }, true);
		expect([first.built.length, first.tiles, first.tilesByPath, first.blits]).toEqual([5, 5, 0, 5]);
	});

	it("a group that scrolls into view after the step is built once and copied once", () => {
		// Defect: the step drew it again while it was off screen (its build counted where nobody sees it), or its entry
		// draws it twice.
		const { paint, settle } = setup();
		paint({ x: 0, y: 0, zoom: 1 }, true);
		settle({ x: 0, y: 0, zoom: 0.9 });
		// View y 1950 to 2283 at zoom 0.9 holds group off-0 (y 2000 to about 2020) and nothing else.
		const entry = settle({ x: 0, y: 1950, zoom: 0.9 });
		const built = [entry.moving, ...entry.still].flatMap((p) => p.built);
		expect(built).toEqual(["off-0"]);
		expect([sum(entry.still), [entry.moving, ...entry.still].reduce((a, p) => a + p.blits, 0)]).toEqual([1, 1]);
	});

	it("a group that leaves the view keeps its sprite: scrolling back to it builds nothing", () => {
		// Defect: a fix that lets go of every sprite the view leaves, so each scroll back draws the group again.
		const { paint, settle } = setup();
		paint({ x: 0, y: 0, zoom: 1 }, true);
		settle({ x: 0, y: 1950, zoom: 1 });
		settle({ x: 0, y: 0, zoom: 1 });
		const back = settle({ x: 0, y: 1950, zoom: 1 });
		expect([back.moving, ...back.still].flatMap((p) => p.built)).toEqual([]);
		// The kept sprite is copied by the moving paint itself; the still paint after it has nothing to do.
		expect([back.moving, ...back.still].reduce((a, p) => a + p.blits, 0)).toBe(1);
	});

	it("a group left with tiles undrawn when it scrolls off asks no more paints and finishes when it comes back", () => {
		// Defect: the paint draws the undrawn tiles of groups off screen, or a group off screen with tiles waiting asks
		// a paint every frame for tiles it never draws.
		const groups = Array.from({ length: 20 }, (_, i) => groupAt("g-" + i, 20 + (i % 4) * 90, 20 + Math.floor(i / 4) * 50));
		const layer = new AttachedLayer(fakeCanvas(), fakeCanvas(), fakeCanvas);
		const c = layer.counts;
		const home = { x: 0, y: 0, zoom: 1 }, away = { x: 0, y: 5000, zoom: 1 };
		layer.paint(home, groups, false, undefined, SIZE, true);
		// Twenty tiles in view, sixteen a paint: four wait.
		expect([c.tilesLastPaint, layer.buildWaits]).toEqual([16, true]);
		layer.paint(away, groups, false, undefined, SIZE, false);
		layer.paint(away, groups, false, undefined, SIZE, true);
		expect([c.tilesLastPaint, layer.buildWaits]).toEqual([0, false]);
		const built = c.built;
		layer.paint(home, groups, false, undefined, SIZE, false);
		layer.paint(home, groups, false, undefined, SIZE, true);
		expect([c.built - built, c.tilesLastPaint, layer.buildWaits]).toEqual([0, 4, false]);
	});

	it("on mobile, sprites left at another zoom by groups off screen give their pixels back, so a group shown now builds", () => {
		// Defect: the layer total counts every sprite ever kept, so four large groups toured at zoom 4 fill it and a fifth
		// group shown at zoom 1 is refused its sprite and draws by path on every paint.
		const wasMobile = Platform.isMobileApp;
		Platform.isMobileApp = true;
		try {
			/** One stroke corner to corner over a side x side box at (x, y): its sprite allocates every tile of the box. */
			const square = (id: string, x: number, y: number, side: number): AttachedGroup => {
				const points = [0, 1].map((i) => ({ x: x + i * side, y: y + i * side, pressure: 0.5, t: i }));
				const members = [{ id: id + "-a", tool: "pen" as const, color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 }];
				return { id, members, offset: { dx: 0, dy: 0 }, shown: () => members };
			};
			const tour = [0, 1, 2, 3].map((i) => square("tour-" + i, 0, 5000 + i * 1000, 165));
			const shown = square("shown", 0, 0, 500);
			const groups = [...tour, shown];
			const px = new Map<string, number>();
			const fresh = () => {
				const layer = new AttachedLayer(fakeCanvas(), fakeCanvas(), fakeCanvas);
				layer.onSprite = (id, _why, _tiles, p) => void px.set(id, p);
				const settle = (cam: { x: number; y: number; zoom: number }) => {
					layer.paint(cam, groups, false, undefined, SIZE, false);
					for (let i = 0; i < 20; i++) {
						layer.paint(cam, groups, false, undefined, SIZE, true);
						if (!layer.buildWaits) break;
					}
				};
				return { layer, settle };
			};
			// What the group shown at zoom 1 needs, read off a layer that holds nothing else.
			fresh().settle({ x: 0, y: 0, zoom: 1 });
			const need = px.get("shown") ?? 0;
			const { layer, settle } = fresh();
			for (const g of tour) settle({ x: g.members[0]!.points[0]!.x, y: g.members[0]!.points[0]!.y, zoom: 4 });
			// Premises from the pixels the layer reports: each toured sprite is under the one-group cap, the four fit the
			// layer total, and the group shown at zoom 1 fits the cap but not the room the four leave.
			const toured = tour.map((g) => px.get(g.id) ?? 0);
			const room = spriteLayerMaxDevicePx() - toured.reduce((a, p) => a + p, 0);
			expect(toured.every((p) => p > 0 && p <= spriteMaxDevicePx())).toBe(true);
			expect(room).toBeGreaterThanOrEqual(0);
			expect([need > room, need <= spriteMaxDevicePx()]).toEqual([true, true]);
			const c = layer.counts, refused = c.byPathBudget, byPath = c.byPath;
			settle({ x: 0, y: 0, zoom: 1 });
			expect([c.byPathBudget - refused, layer.buildWaits]).toEqual([0, false]);
			// The moving paint draws it by path once; no still paint does.
			expect(c.byPath - byPath).toBe(1);
		} finally {
			Platform.isMobileApp = wasMobile;
		}
	});

	it("control: a paint at a still camera with no zoom step builds nothing and copies the five on screen, as today", () => {
		// Defect: the on-screen test drops a group the view shows, or a still paint draws a sprite again.
		const { layer, paint } = setup();
		const cam = { x: 0, y: 0, zoom: 1 };
		// The load ends when nothing waits, whatever it built: the still paints after it are the ones read.
		for (let i = 0; i < 20; i++) {
			paint(cam, true);
			if (!layer.buildWaits) break;
		}
		layer.invalidate("follow");
		const whole = paint(cam, true);
		expect([whole.built.length, whole.tiles, whole.tilesByPath, whole.blits, whole.painted]).toEqual([0, 0, 0, 5, 1]);
		layer.moved([{ x: 30, y: 30, width: 80, height: 30 }]);
		const rect = paint(cam, true);
		expect([rect.built.length, rect.blits, rect.painted]).toEqual([0, 1, 1]);
	});
});
