/**
 * The attached layer: a note with no groups costs the layer nothing; a follow move copies
 * sprites and draws no stroke; a sprite is drawn again when a member's points change. Each cell names the defect that
 * must turn it red. No browser: the canvases are fakes whose contexts take any call and record the copies.
 */
import { describe, expect, it } from "vitest";
import { AttachedLayer, spriteLayerMaxDevicePx, type AttachedGroup } from "./InkOverlayAttachedLayer";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { bumpStrokeRev } from "../ink/StrokeRev";

type Copy = { x: number; y: number };

function fakeCanvas(log: { contexts: number; copies: Copy[] }) {
	const c = { width: 300, height: 150, getContext: () => { log.contexts++; return ctx; } } as unknown as HTMLCanvasElement;
	const ctx = new Proxy({} as Record<string, unknown>, {
		get(target, key) {
			if (key in target) return target[key as string];
			if (key === "drawImage") return (_img: unknown, x: number, y: number) => void log.copies.push({ x, y });
			if (key === "measureText") return () => ({ width: 0 });
			return () => undefined;
		},
		set(target, key, value) {
			target[key as string] = value;
			return true;
		},
	});
	return c;
}

function setup() {
	const log = { contexts: 0, copies: [] as Copy[] };
	const sprites = { made: 0 };
	const layer = new AttachedLayer(fakeCanvas(log), fakeCanvas(log), () => {
		sprites.made++;
		return fakeCanvas({ contexts: 0, copies: [] });
	});
	return { layer, log, sprites };
}

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

const SIZE = { backingW: 800, backingH: 600, backing: 2, cssW: 400, cssH: 300 };
const CAM = { x: 0, y: 0, zoom: 1 };
const group = (members: InkStroke[], dy = 0): AttachedGroup => ({ id: "att-1", members, offset: { dx: 0, dy }, shown: () => members });

describe("attached layer", () => {
	it("a note with no groups gives the layer no backing, no context and no paint", () => {
		// Defect: the layer allocates or clears a full-size backing on every note, and every existing note pays for it.
		const { layer, log } = setup();
		layer.paint(CAM, [], true, undefined, SIZE);
		layer.paint(CAM, [], false, undefined, SIZE);
		expect([layer.pen.width, layer.hl.width, log.contexts, layer.counts.paints, layer.live]).toEqual([0, 0, 0, 0, false]);
	});

	it("a follow move copies the group's sprite at its new place and draws no stroke again", () => {
		// Defect: a move redraws the members by path (the 20 ms row 1 miss), or copies off the device grid.
		const { layer, log } = setup();
		const members = [strokeAt("s1", 40, 40), strokeAt("s2", 60, 44)];
		layer.paint(CAM, [group(members)], true, undefined, SIZE);
		expect([layer.counts.built, layer.counts.blits]).toEqual([1, 1]);
		const first = log.copies.at(-1)!;
		layer.moved([{ x: 30, y: 30, width: 60, height: 60 }]);
		layer.paint(CAM, [group(members, 10.3)], false, undefined, SIZE);
		expect([layer.counts.built, layer.counts.blits, layer.counts.byPath]).toEqual([1, 2, 0]);
		const second = log.copies.at(-1)!;
		// 10.3 world units at zoom 1 and backing 2 is 20.6 device px: the copy lands 20 or 21 px down, on whole pixels.
		expect(second.x - first.x).toBe(0);
		expect([20, 21]).toContain(second.y - first.y);
		expect(Number.isInteger(second.y)).toBe(true);
	});

	it("nothing moved at the same camera: no paint at all", () => {
		// Defect: every committed frame (a scroll band, a pen commit elsewhere) copies every group again.
		const { layer } = setup();
		const members = [strokeAt("s1", 40, 40)];
		layer.paint(CAM, [group(members)], true, undefined, SIZE);
		const paints = layer.counts.paints;
		layer.paint(CAM, [group(members)], false, undefined, SIZE);
		expect(layer.counts.paints).toBe(paints);
	});

	it("a point edit on a member draws its sprite again: never a stale picture", () => {
		// Defect: the sprite key leaves out the stroke revision, and an edited stroke keeps showing its old shape.
		const { layer } = setup();
		const members = [strokeAt("s1", 40, 40), strokeAt("s2", 60, 44)];
		layer.paint(CAM, [group(members)], true, undefined, SIZE);
		members[1]!.points[0]!.x += 3;
		bumpStrokeRev(members[1]!);
		layer.invalidate("follow");
		layer.paint(CAM, [group(members)], false, undefined, SIZE);
		expect(layer.counts.built).toBe(2);
	});

	it("an erase inside a group draws it by path under the rect and leaves the sprite to the next whole paint", () => {
		// Defect: each scrub frame that takes a member draws the whole group's sprite again (the (g) scrub miss).
		const { layer } = setup();
		const members = [strokeAt("s1", 40, 40), strokeAt("s2", 60, 44), strokeAt("s3", 80, 48)];
		// A fresh list per read, as freeFor gives one: the sprite keeps the list it was drawn from.
		layer.paint(CAM, [group([...members])], true, undefined, SIZE);
		expect(layer.counts.built).toBe(1);
		for (let i = 0; i < 2; i++) {
			members.pop();
			layer.moved([{ x: 30, y: 30, width: 70, height: 30 }]);
			layer.paint(CAM, [group([...members])], false, undefined, SIZE);
		}
		expect([layer.counts.built, layer.counts.byPath]).toEqual([1, 2]);
		layer.paint(CAM, [group([...members])], true, undefined, SIZE);
		expect([layer.counts.built, layer.counts.byPath]).toEqual([2, 2]);
	});

	it("each whole paint counts why it was whole, once: first, committed, a request for all with its asker, the backing, the camera", () => {
		// Defect: the counters print whole paints with no cause, and the next fix guesses (row 1 at f8f6bd0d).
		const { layer } = setup();
		const members = [strokeAt("s1", 40, 40)];
		const c = layer.counts;
		const why = () => [c.wholeFirst, c.wholeCommitted, c.wholeDirty, c.wholeBacking, c.wholeCamera];
		layer.paint(CAM, [group(members)], true, undefined, SIZE);
		expect(why()).toEqual([1, 0, 0, 0, 0]);
		layer.paint(CAM, [group(members)], true, undefined, SIZE);
		expect(why()).toEqual([1, 1, 0, 0, 0]);
		layer.invalidate("follow");
		layer.paint(CAM, [group(members)], false, undefined, SIZE);
		expect(why()).toEqual([1, 1, 1, 0, 0]);
		expect([c.invalidFollow, c.invalidLayout, c.invalidLift]).toEqual([1, 0, 0]);
		layer.paint({ x: 0, y: 0.5, zoom: 1 }, [group(members)], false, undefined, SIZE);
		expect(why()).toEqual([1, 1, 1, 0, 1]);
		expect(c.whole).toBe(4);
		// A rect paint is not whole and counts no cause.
		layer.moved([{ x: 30, y: 30, width: 60, height: 60 }]);
		layer.paint({ x: 0, y: 0.5, zoom: 1 }, [group(members)], false, undefined, SIZE);
		expect([c.whole, ...why()]).toEqual([4, 1, 1, 1, 0, 1]);
	});

	it("a tall group allocates only the tiles its members touch: one build, two tiles, no path draw", () => {
		// Defect: a group whose box passes the cap draws by path on every paint though its ink fills two tiles.
		const { layer } = setup();
		const tall = [strokeAt("s1", 40, 40), strokeAt("s2", 40, 40 + 5_000_000)];
		layer.paint(CAM, [group(tall)], true, undefined, SIZE);
		expect([layer.counts.built, layer.counts.tiles, layer.counts.byPath]).toEqual([1, 2, 0]);
		expect(layer.counts.spritePx).toBeLessThanOrEqual(2 * 1024 * 1024);
	});

	// Small strokes on a grid of `step` world units: at zoom 1 and backing 2 a step of 256 touches every tile.
	const grid = (prefix: string, cols: number, rows: number, step: number): InkStroke[] => {
		const out: InkStroke[] = [];
		for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) out.push(strokeAt(`${prefix}-${i}-${j}`, 40 + i * step, 40 + j * step));
		return out;
	};

	it("a dense group past the cap draws by path, and a one-line rect strokes only the members it touches", () => {
		// Defect: the by-path fallback strokes every member on every paint, the whole group for a one-line move.
		const { layer } = setup();
		const dense = grid("d", 7, 7, 256);
		layer.paint(CAM, [group(dense)], true, undefined, SIZE);
		expect([layer.counts.built, layer.counts.byPath]).toEqual([0, 1]);
		expect(layer.counts.byPathPxMax).toBeGreaterThan(8_000_000);
		const before = layer.counts.byPathStrokes;
		expect(before, "a whole paint strokes only the members in view").toBeLessThan(dense.length);
		layer.moved([{ x: 0, y: 30, width: 400, height: 20 }]);
		layer.paint(CAM, [group(dense)], false, undefined, SIZE);
		const drawn = layer.counts.byPathStrokes - before;
		expect(drawn).toBeGreaterThan(0);
		expect(drawn).toBeLessThan(7);
	});

	it("a rect paint across a tile seam copies the same tiles to the same device px as a whole paint", () => {
		// Defect: tiles overlap at a seam (alpha taken twice) or a rect paint places a tile off the whole paint's grid.
		// The sprite origin is 3 css px left of the first box (x 38): the seam at device x 1024 is world x 547.
		const { layer, log } = setup();
		const across = [strokeAt("a", 40, 40), strokeAt("b", 560, 44)];
		// A camera whose view holds both tiles: the second starts at world x 547.
		const cam = { x: 300, y: 0, zoom: 1 };
		layer.paint(cam, [group(across)], true, undefined, SIZE);
		expect(layer.counts.tiles).toBe(2);
		const whole = log.copies.slice(-2).map((c) => [c.x, c.y]);
		expect(whole[1]![0]! - whole[0]![0]!).toBe(1024);
		layer.moved([{ x: 540, y: 30, width: 20, height: 30 }]);
		layer.paint(cam, [group(across)], false, undefined, SIZE);
		expect(log.copies.slice(-2).map((c) => [c.x, c.y])).toEqual(whole);
	});

	it("a group past the layer total draws by path, in paint order, and the counter says so", () => {
		// Defect: the layer allocates tiles without bound, one cap per group, past the WebView's canvas area limit.
		const { layer } = setup();
		const groups: AttachedGroup[] = [];
		// Each group: 3 by 3 strokes 512 world units apart, a stroke in each of 9 tiles, about 4.4 million device px.
		for (let n = 0; n < 8; n++) {
			const members = grid("g" + n, 3, 3, 512);
			groups.push({ id: "att-" + n, members, offset: { dx: 0, dy: 0 }, shown: () => members });
		}
		layer.paint(CAM, groups, true, undefined, SIZE);
		expect([layer.counts.built, layer.counts.byPathBudget, layer.counts.byPath]).toEqual([7, 1, 1]);
		expect(layer.counts.spritePx).toBeLessThanOrEqual(4 * 8_000_000);
	});

	it("erasing every highlighter stroke of a pen and highlighter group leaves no highlight on the next scroll", () => {
		// Defect: the rebuilt sprite keeps the old tile's highlight canvas, and a paint after the erase copies the erased ink back.
		const pen = { contexts: 0, copies: [] as Copy[] }, hl = { contexts: 0, copies: [] as Copy[] };
		const layer = new AttachedLayer(fakeCanvas(pen), fakeCanvas(hl), () => fakeCanvas({ contexts: 0, copies: [] }));
		const p = strokeAt("p", 40, 40), h = { ...strokeAt("h", 44, 42), tool: "highlighter" as const };
		layer.paint(CAM, [group([p, h])], true, undefined, SIZE);
		expect([pen.copies.length, hl.copies.length]).toEqual([1, 1]);
		// The erase: a rect paint with the highlighter member gone, then a scroll paints whole.
		layer.moved([{ x: 30, y: 30, width: 40, height: 30 }]);
		layer.paint(CAM, [group([p])], false, undefined, SIZE);
		const scrolled = { x: 0, y: 2, zoom: 1 };
		const hlBefore = hl.copies.length, penBefore = pen.copies.length;
		layer.paint(scrolled, [group([p])], false, undefined, SIZE);
		expect(layer.counts.built).toBe(2);
		expect(pen.copies.length - penBefore, "the pen ink is copied").toBe(1);
		expect(hl.copies.length - hlBefore, "no highlight copied after the erase").toBe(0);
		expect(layer.heldTiles(scrolled, [group([p])], { x: 0, y: 0, width: 400, height: 300 }, undefined, 2)?.hl).toEqual([]);
	});

	it("erasing every pen stroke of a pen and highlighter group leaves no pen ink on the next scroll", () => {
		// Defect: the same reuse keeps the old tile's pen canvas once the group holds highlighter ink alone.
		const pen = { contexts: 0, copies: [] as Copy[] }, hl = { contexts: 0, copies: [] as Copy[] };
		const layer = new AttachedLayer(fakeCanvas(pen), fakeCanvas(hl), () => fakeCanvas({ contexts: 0, copies: [] }));
		const p = strokeAt("p", 40, 40), h = { ...strokeAt("h", 44, 42), tool: "highlighter" as const };
		layer.paint(CAM, [group([p, h])], true, undefined, SIZE);
		layer.moved([{ x: 30, y: 30, width: 40, height: 30 }]);
		layer.paint(CAM, [group([h])], false, undefined, SIZE);
		const penBefore = pen.copies.length, hlBefore = hl.copies.length;
		layer.paint({ x: 0, y: 2, zoom: 1 }, [group([h])], false, undefined, SIZE);
		expect(layer.counts.built).toBe(2);
		expect(hl.copies.length - hlBefore, "the highlight is copied").toBe(1);
		expect(pen.copies.length - penBefore, "no pen ink copied after the erase").toBe(0);
	});

	it("a stand-in build over an off-view group at an old zoom, near the layer total, counts its old tiles off once", () => {
		// Defect: the old sprite's px leave the total when it is replaced, and again when the room-making pass lets it go,
		// so the total runs low and the layer holds more tiles than its cap.
		const { layer } = setup();
		const inner = layer as unknown as { spritePx: number; sprites: Map<string, { px: number }> };
		const held = () => [...inner.sprites.values()].reduce((n, sp) => n + sp.px, 0);
		const mk = (id: string, members: InkStroke[]): AttachedGroup => ({ id, members, offset: { dx: 0, dy: 0 }, shown: () => members });
		// Six groups of 3 by 3 strokes 256 apart near the origin, and one of 4 by 3 far off to the right.
		const fill = Array.from({ length: 6 }, (_, n) => mk("f" + n, grid("f" + n, 3, 3, 256)));
		const far = mk("far", grid("far", 4, 3, 256).map((s) => ({ ...s, points: s.points.map((q) => ({ ...q, x: q.x + 100_000 })), bbox: { ...s.bbox, x: s.bbox.x + 100_000 } })));
		const all = [...fill, far];
		// Zoom 1 over the far group: its sprite is built there.
		layer.paint({ x: 100_000, y: 0, zoom: 1 }, all, true, undefined, SIZE);
		expect(inner.sprites.has("far")).toBe(true);
		// Zoom 2 at the origin: the six are shown and built, the far group is off view and keeps its zoom 1 sprite.
		const cam2 = { x: 0, y: 0, zoom: 2 };
		layer.paint(cam2, all, true, undefined, SIZE);
		expect(inner.sprites.size).toBe(7);
		expect(inner.spritePx).toBe(held());
		// The stand-in build over the far group at zoom 2: past the total, so the room-making pass runs.
		layer.buildIn(cam2, [far], { x: 99_000, y: 0, width: 5_000, height: 2_000 }, undefined, 2, () => false);
		expect(inner.spritePx, "the total equals the tiles held").toBe(held());
		expect(held(), "the layer holds no more than its cap").toBeLessThanOrEqual(spriteLayerMaxDevicePx());
	});
});
