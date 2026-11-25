/**
 * The D3 bound, shared by the note and PDF cells.
 *
 * A held highlighter's tip is placed on screen from the camera, never from the last pen sample: the
 * page reports the strip's last point m (the wet renderer's last ribbon point, the centre of the strip's end disc), the
 * disc's radius r = max(0.25, hw x zoom), and the head's two ends, all in client px. The read covers every screenshot
 * pixel whose centre lies inside the stroke's outline, `inset` px in from its long edges, from a half-width behind m to
 * the tip's front end.
 *
 * Against the trail: no channel more than 4 darker anywhere; none more than 14 lighter; every pixel more than 4 lighter
 * within 1.5 px of the disc's edge; none reading as paper.
 *
 * The strip's own pixels: the same frame is read a second time with the tail canvas hidden. A pixel the strip
 * alone already paints off the trail (more than 4 either way), and that the tail canvas leaves as the strip painted it
 * (within 1 of that second read), is the strip's: it is not counted toward darker or lighter, and the worst of them is
 * named. A pixel the tail canvas changes counts, whatever the strip alone reads there. The paper read covers every pixel.
 */
import { expect } from "vitest";
import type { Pt, RGB } from "./penMarks";

/** What a page reports of the live stroke, in client px (css). */
export type Raw = {
	zoom: number;
	last: (Pt & { hwWorld: number }) | null;
	r: number | null;
	from: Pt | null;
	to: Pt | null;
	hw: number | null;
};

/** The strip's end disc and the tip on screen, in client px: u runs from the tip's start to its front end. */
export type Placed = { m: Pt; r: number; from: Pt; to: Pt; u: Pt; len: number; hw: number };

/** A circle the strip's centre line follows behind m (the arc cell), in client px. */
export type Arc = { c: Pt; R: number };

/**
 * A screenshot box: RGB triples row by row, its corner in screenshot px, and screenshot px per css px. `alone` is the
 * same box of the same frame with the tail canvas hidden (the strip alone), when read.
 */
export type Shot = { data: number[]; alone?: number[]; x0: number; y0: number; w: number; h: number; k: number };

export type Px = { x: number; y: number; t: number; n: number; e: number; outside: boolean; rgb: RGB; alone: RGB | null };

export const white: RGB = [255, 255, 255];
export const gap = (a: RGB, b: RGB): number => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
export const darker = (p: RGB, ref: RGB): number => Math.max(...p.map((v, i) => ref[i]! - v));
export const lighter = (p: RGB, ref: RGB): number => Math.max(...p.map((v, i) => v - ref[i]!));
export const r2 = (v: number): number => Math.round(v * 100) / 100;
const pt2 = (p: Pt): Pt => ({ x: r2(p.x), y: r2(p.y) });

/** The bound's numbers. */
export const BOUND = { darker: 4, lighter: 14, lighterOffEdge: 4, edge: 1.5, paperGap: 40 } as const;
/** How near the full read must stay to the strip-alone read for a pixel to be the strip's own. */
export const ALONE_SAME = 1;

export function placedOf(raw: Raw, dir: Pt): Placed | null {
	if (!raw.last || raw.r === null || !raw.from || !raw.to || raw.hw === null) return null;
	const dx = raw.to.x - raw.from.x, dy = raw.to.y - raw.from.y, len = Math.hypot(dx, dy);
	const u = len > 0.5 ? { x: dx / len, y: dy / len } : dir;
	return { m: { x: raw.last.x, y: raw.last.y }, r: raw.r, from: raw.from, to: raw.to, u, len, hw: raw.hw };
}

export const placedRecord = (p: Placed | null) =>
	p && { m: pt2(p.m), r: r2(p.r), from: pt2(p.from), to: pt2(p.to), u: pt2(p.u), len: r2(p.len), hw: r2(p.hw) };

/** A point `d` css px behind m along the tip's line. */
export const behind = (p: Placed, d: number): Pt => ({ x: p.m.x - p.u.x * d, y: p.m.y - p.u.y * d });

/** The screenshot box that holds the read, in screenshot px. */
export function boxOf(p: Placed, k: number): { x0: number; y0: number; w: number; h: number } {
	const pad = p.hw + 4;
	const x0 = Math.floor((Math.min(p.m.x, p.to.x) - pad) * k), y0 = Math.floor((Math.min(p.m.y, p.to.y) - pad) * k);
	const x1 = Math.ceil((Math.max(p.m.x, p.to.x) + pad) * k), y1 = Math.ceil((Math.max(p.m.y, p.to.y) + pad) * k);
	return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Every pixel of the read. Ahead of m: the tip's band, |n| <= hw - inset, out to the tip's front end. Behind m, to a
 * half-width back: the same band on a straight stroke, or the strip's annulus on an arc, plus the strip's end disc
 * shrunk by the inset (the wedge on a bend's outer side). e is the pixel's distance from the end disc's edge.
 */
export function readPx(shot: Shot, p: Placed, inset = 2, arc?: Arc): Px[] {
	const out: Px[] = [];
	for (let r = 0; r < shot.h; r++) {
		for (let c = 0; c < shot.w; c++) {
			const x = (shot.x0 + c + 0.5) / shot.k, y = (shot.y0 + r + 0.5) / shot.k;
			const dx = x - p.m.x, dy = y - p.m.y;
			const t = dx * p.u.x + dy * p.u.y, n = -dx * p.u.y + dy * p.u.x;
			const dm = Math.hypot(dx, dy);
			let inside: boolean;
			if (t >= 0) inside = t <= p.len && Math.abs(n) <= p.hw - inset;
			else if (t >= -p.hw) {
				// On an arc, only the annulus near m: the band behind m also crosses the circle's far side.
				const strip = arc
					? Math.abs(Math.hypot(x - arc.c.x, y - arc.c.y) - arc.R) <= p.hw - inset && dm <= 1.5 * p.hw
					: Math.abs(n) <= p.hw - inset;
				inside = strip || dm <= p.hw - inset;
			} else inside = false;
			if (!inside) continue;
			const i = (r * shot.w + c) * 3;
			const outside = arc ? Math.hypot(x - arc.c.x, y - arc.c.y) > arc.R : false;
			const alone: RGB | null = shot.alone ? [shot.alone[i]!, shot.alone[i + 1]!, shot.alone[i + 2]!] : null;
			out.push({ x: shot.x0 + c, y: shot.y0 + r, t, n, e: Math.abs(dm - p.r), outside, rgb: [shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!], alone });
		}
	}
	return out;
}

const at = (q: Px) => ({ x: q.x, y: q.y, t: r2(q.t), n: r2(q.n), e: r2(q.e), rgb: q.rgb, alone: q.alone });

/** Item 2: the strip alone paints this pixel off the trail, and the tail canvas leaves it as the strip painted it. */
export const stripsOwn = (q: Px, trail: RGB): boolean =>
	q.alone !== null &&
	(darker(q.alone, trail) > BOUND.lighterOffEdge || lighter(q.alone, trail) > BOUND.lighterOffEdge) &&
	gap(q.rgb, q.alone) <= ALONE_SAME;

/**
 * The worst pixel each way against the trail, the pixels more than 4 lighter and how far the farthest lies from the
 * disc's edge, the strip's own pixels (not counted) and their worst, the one nearest paper (every pixel).
 */
export function boundStats(px: Px[], trail: RGB) {
	const none = { by: 0, at: null as ReturnType<typeof at> | null };
	let dark = none, light = none, paper = { gap: Infinity, at: null as ReturnType<typeof at> | null };
	let outsidePaper = { gap: Infinity, at: null as ReturnType<typeof at> | null }, outsideCount = 0;
	let lightCount = 0, edgeWorst = 0, edgeAt: ReturnType<typeof at> | null = null;
	let ownCount = 0, ownWorst = { by: 0, at: null as ReturnType<typeof at> | null };
	let aloneRead = 0;
	for (const q of px) {
		const d = darker(q.rgb, trail), l = lighter(q.rgb, trail), w = gap(q.rgb, white);
		if (q.alone) aloneRead++;
		if (w < paper.gap) paper = { gap: w, at: at(q) };
		if (q.outside) {
			outsideCount++;
			if (w < outsidePaper.gap) outsidePaper = { gap: w, at: at(q) };
		}
		if (stripsOwn(q, trail)) {
			ownCount++;
			const g = gap(q.rgb, trail);
			if (g > ownWorst.by) ownWorst = { by: g, at: at(q) };
			continue;
		}
		if (d > dark.by) dark = { by: d, at: at(q) };
		if (l > light.by) light = { by: l, at: at(q) };
		if (l > BOUND.lighterOffEdge) {
			lightCount++;
			if (q.e > edgeWorst) {
				edgeWorst = q.e;
				edgeAt = at(q);
			}
		}
	}
	return {
		count: px.length,
		aloneRead,
		darker: dark,
		lighter: light,
		lighterThan4: { count: lightCount, farthestFromEdge: r2(edgeWorst), at: edgeAt },
		stripsOwn: { count: ownCount, worst: ownWorst },
		paper,
		outsideBend: { count: outsideCount, paper: outsidePaper },
	};
}

export type Stats = ReturnType<typeof boundStats>;

/** PREMISES of the placing: the tip starts at the strip's last point with the strip's half-width. */
export function expectPlaced(p: Placed | null, brief: string): asserts p is Placed {
	expect(p, `premise: the strip's last point and the head are known (${brief})`).not.toBeNull();
	expect(Math.hypot(p!.from.x - p!.m.x, p!.from.y - p!.m.y), `premise: the tip starts at the strip's last point (${brief})`).toBeLessThanOrEqual(0.05);
	expect(Math.abs(p!.r - p!.hw), `premise: the end disc's radius is the tip's half-width (${brief})`).toBeLessThanOrEqual(0.05);
}

/** THE BOUND, each claim read whatever the one before it gives. Premise: every pixel has its strip-alone read. */
export function expectBound(stats: Stats, trail: RGB, label: string): void {
	const s = JSON.stringify(stats);
	expect(stats.aloneRead, `premise: ${label}: every pixel read again with the tail canvas hidden; ${s}`).toBe(stats.count);
	expect.soft(stats.darker.by, `${label}: darker than the trail ${trail} at ${JSON.stringify(stats.darker.at)}; ${s}`).toBeLessThanOrEqual(BOUND.darker);
	expect.soft(stats.lighter.by, `${label}: lighter than the trail ${trail} at ${JSON.stringify(stats.lighter.at)}; ${s}`).toBeLessThanOrEqual(BOUND.lighter);
	expect.soft(stats.lighterThan4.farthestFromEdge, `${label}: a pixel more than 4 lighter lies off the end disc's edge ${JSON.stringify(stats.lighterThan4)}`).toBeLessThanOrEqual(BOUND.edge);
	expect.soft(stats.paper.gap, `${label}: a pixel reads as paper ${JSON.stringify(stats.paper.at)}`).toBeGreaterThanOrEqual(BOUND.paperGap);
}
