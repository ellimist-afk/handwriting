import { describe, expect, it } from "vitest";
import { embedInkScale } from "./EmbedInk";
import { embedInkTile, embedInkTileHolds, embedInkUsesTile, embedInkVisible, TILE_PX, TILE_PX_MOBILE } from "./EmbedInkTile";

// Alan's note in Reading view on Orion: an ink box of 9,241 x 6,025 css px, a 1,400 x 900 view, dpr 1.8257.
const BOX = { w: 9241, h: 6025 };
const DPR = 1.8257;
const VIEW = { x: 0, y: 1000, w: 1400, h: 900 };
const desk = (w: number, h: number) => embedInkScale(w, h, DPR, TILE_PX);

describe("embedInkUsesTile", () => {
	it("a huge note's own Reading view draws a tile: its whole box is drawn under the display's ratio", () => {
		const whole = embedInkScale(BOX.w, BOX.h, DPR);
		expect(whole).toBeLessThan(0.3);
		expect(embedInkUsesTile(true, whole, DPR)).toBe(true);
	});

	it("a one-page note keeps the whole box: it is drawn at the display's ratio already", () => {
		const whole = embedInkScale(700, 1000, DPR);
		expect(whole).toBe(DPR);
		expect(embedInkUsesTile(true, whole, DPR)).toBe(false);
	});

	it("an embed or a hover preview of the huge note keeps the whole box", () => {
		expect(embedInkUsesTile(false, embedInkScale(BOX.w, BOX.h, DPR), DPR)).toBe(false);
	});
});

describe("embedInkTile", () => {
	it("covers the visible rect grown a quarter view each side, cut to the box, at the display's ratio", () => {
		const t = embedInkTile(BOX, VIEW, desk)!;
		expect(t.scale).toBe(DPR);
		// x: 0 - 350 is cut to the box's left; y: 1000 - 225.
		expect(t.x).toBe(0);
		expect(t.y).toBeLessThanOrEqual(775);
		expect(t.y).toBeGreaterThan(775 - 1 / DPR);
		expect(t.x + t.w).toBeGreaterThanOrEqual(1750);
		expect(t.y + t.h).toBeGreaterThanOrEqual(2125);
		expect(t.bw * t.bh).toBeLessThanOrEqual(TILE_PX);
	});

	it("starts on a whole backing px, so two tiles of one box shift a stroke by whole device px", () => {
		const a = embedInkTile(BOX, VIEW, desk)!;
		const b = embedInkTile(BOX, { ...VIEW, x: 333, y: 1900 }, desk)!;
		for (const t of [a, b]) {
			expect(Number.isInteger(t.bx)).toBe(true);
			expect(Number.isInteger(t.by)).toBe(true);
		}
		expect(a.scale).toBe(b.scale);
		// A stroke point in device px of each backing store: the same point, a whole pixel apart.
		const p = { x: 1201.37, y: 1888.91 };
		const dx = (p.x * a.scale - a.bx) - (p.x * b.scale - b.bx), dy = (p.y * a.scale - a.by) - (p.y * b.scale - b.by);
		expect(Math.abs(dx - Math.round(dx))).toBeLessThan(1e-6);
		expect(Math.abs(dy - Math.round(dy))).toBeLessThan(1e-6);
	});

	it("stops at the box's far edge", () => {
		const t = embedInkTile(BOX, { x: BOX.w - 700, y: BOX.h - 450, w: 1400, h: 900 }, desk)!;
		expect(t.bx + t.bw).toBeLessThanOrEqual(Math.ceil(BOX.w * t.scale));
		expect(t.by + t.bh).toBeLessThanOrEqual(Math.ceil(BOX.h * t.scale));
	});

	it("draws an edge tile at the same scale as an interior one when the budget binds, a whole px shift apart", () => {
		// A budget the grown view exceeds: the scale is the budget's, and must not rise for a tile the box's edge cuts.
		const tight = (w: number, h: number) => embedInkScale(w, h, DPR, 2_000_000);
		const inside = embedInkTile(BOX, { x: 3000, y: 2000, w: 1400, h: 900 }, tight)!;
		const corner = embedInkTile(BOX, { x: BOX.w - 700, y: BOX.h - 450, w: 1400, h: 900 }, tight)!;
		expect(inside.scale).toBeLessThan(DPR);
		expect(corner.scale).toBe(inside.scale);
		const p = { x: 8888.37, y: 5800.91 };
		const dx = (p.x * inside.scale - inside.bx) - (p.x * corner.scale - corner.bx);
		const dy = (p.y * inside.scale - inside.by) - (p.y * corner.scale - corner.by);
		expect(Math.abs(dx - Math.round(dx))).toBeLessThan(1e-6);
		expect(Math.abs(dy - Math.round(dy))).toBeLessThan(1e-6);
	});

	it("is none when the view shows none of the box", () => {
		expect(embedInkTile(BOX, { x: 0, y: BOX.h + 10, w: 1400, h: 900 }, desk)).toBeNull();
		expect(embedInkVisible(BOX, { x: 0, y: BOX.h + 10, w: 1400, h: 900 })).toBeNull();
	});

	it("on mobile a view too big for the half budget is drawn under the display's ratio rather than over the budget", () => {
		const mob = (w: number, h: number) => embedInkScale(w, h, 3, TILE_PX_MOBILE);
		const t = embedInkTile(BOX, { x: 0, y: 0, w: 2400, h: 1600 }, mob)!;
		expect(t.scale).toBeLessThan(3);
		expect(t.bw * t.bh).toBeLessThanOrEqual(TILE_PX_MOBILE * 1.01);
		const phone = embedInkTile(BOX, { x: 0, y: 0, w: 400, h: 800 }, mob)!;
		expect(phone.scale).toBe(3);
	});
});

describe("embedInkTileHolds", () => {
	const t = embedInkTile(BOX, VIEW, desk);

	it("holds a scroll that stays inside the margin", () => {
		expect(embedInkTileHolds(t, BOX, { ...VIEW, y: VIEW.y + 200 })).toBe(true);
		expect(embedInkTileHolds(t, BOX, { ...VIEW, y: VIEW.y - 200 })).toBe(true);
	});

	it("does not hold a scroll of one view", () => {
		expect(embedInkTileHolds(t, BOX, { ...VIEW, y: VIEW.y + VIEW.h })).toBe(false);
	});

	it("needs no repaint while the view shows none of the box, and a repaint once it does with no tile", () => {
		expect(embedInkTileHolds(null, BOX, { x: 0, y: BOX.h + 10, w: 1400, h: 900 })).toBe(true);
		expect(embedInkTileHolds(null, BOX, VIEW)).toBe(false);
	});
});
