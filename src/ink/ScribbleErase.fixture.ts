/**
 * Strokes for the scribble-to-erase cells: a page of handwriting, a scribble
 * over one word, and twenty ordinary strokes that must never erase anything.
 * World units; pen width 2.2, letters about 18 tall. Deterministic.
 */

import { computeBBox, type InkPoint, type InkStroke } from "./Stroke";

export const PEN_WIDTH = 2.2;

export function strokeFrom(id: string, pts: ReadonlyArray<{ x: number; y: number }>): InkStroke {
	const points: InkPoint[] = pts.map((p, i) => ({ x: p.x, y: p.y, pressure: 0.5, t: i * 4 }));
	return { id, tool: "pen", color: "#222222", width: PEN_WIDTH, points, bbox: computeBBox(points, PEN_WIDTH), createdAt: 1 };
}

function jitter(i: number, amp: number): number {
	return Math.sin(i * 12.9898) * amp;
}

/** Points along a curve given as x(t), y(t) for t in [0, 1], `n` samples. */
function curve(n: number, f: (t: number) => { x: number; y: number }): Array<{ x: number; y: number }> {
	const out: Array<{ x: number; y: number }> = [];
	for (let i = 0; i <= n; i++) out.push(f(i / n));
	return out;
}

/** A cursive-looking word: a wave moving right. */
export function word(id: string, x0: number, y0: number, w = 30, h = 18, cycles = 2): InkStroke {
	return strokeFrom(id, curve(40, (t) => ({ x: x0 + w * t, y: y0 + h / 2 + (h / 2) * Math.sin(t * cycles * Math.PI * 2) })));
}

/** Rows of words, the dense page the ordinary strokes are drawn over. */
export function densePage(): InkStroke[] {
	const out: InkStroke[] = [];
	for (let r = 0; r < 8; r++) {
		for (let c = 0; c < 14; c++) out.push(word(`page-${r}-${c}`, 40 + c * 40, 100 + r * 30, 30, 18, 1.5 + (c % 3) * 0.5));
	}
	return out;
}

/** The three strokes of one word, at x 100 to 200, y 100 to 118. */
export function threeStrokeWord(): InkStroke[] {
	return [word("w1", 100, 100, 30, 18, 2), word("w2", 135, 100, 30, 18, 2), word("w3", 170, 100, 30, 18, 1.5)];
}

/** Ink near the word that a scribble over the word must leave alone. */
export function wordNeighbours(): InkStroke[] {
	return [
		word("next-word", 215, 100),
		word("row-below", 100, 140, 100, 18, 5),
		strokeFrom("underline", curve(60, (t) => ({ x: 40 + 360 * t, y: 124 }))),
	];
}

/**
 * A dense back-and-forth scribble along a line: `legs` legs from x0 to x1,
 * drifting from y0 to y1, sampled every ~`step` units (3: a slow pen; 9: a fast one).
 */
export function scribble(id: string, x0: number, x1: number, y0: number, y1: number, legs = 8, step = 3): InkStroke {
	const pts: Array<{ x: number; y: number }> = [];
	const per = Math.max(4, Math.round(Math.abs(x1 - x0) / step));
	for (let l = 0; l < legs; l++) {
		for (let i = 0; i < per; i++) {
			const t = i / per;
			const u = l % 2 === 0 ? t : 1 - t;
			const k = pts.length;
			pts.push({ x: x0 + (x1 - x0) * u + jitter(k, 0.6), y: y0 + ((y1 - y0) * (l + t)) / legs + jitter(k + 5, 0.8) });
		}
	}
	return strokeFrom(id, pts);
}

/** A back-and-forth scribble with no jitter: `legs` legs from x0 to x1, drifting from y0 to y1, samples `step` apart. */
export function steppedScribble(id: string, x0: number, x1: number, y0: number, y1: number, legs: number, step: number): InkStroke {
	const pts: Array<{ x: number; y: number }> = [];
	const n = Math.max(1, Math.round((x1 - x0) / step));
	for (let l = 0; l < legs; l++) {
		for (let i = 0; i <= n; i++) {
			if (l > 0 && i === 0) continue;
			const t = i / n;
			const u = l % 2 === 0 ? t : 1 - t;
			pts.push({ x: x0 + (x1 - x0) * u, y: y0 + ((y1 - y0) * (l + t)) / legs });
		}
	}
	return strokeFrom(id, pts);
}

/** A box drawn in one stroke, clockwise from its top left corner, 20 samples a side. */
export function outlinedBox(id: string, x0: number, y0: number, w: number, h: number): InkStroke {
	const pts: Array<{ x: number; y: number }> = [];
	for (let i = 0; i <= 20; i++) pts.push({ x: x0 + (w * i) / 20, y: y0 });
	for (let i = 1; i <= 20; i++) pts.push({ x: x0 + w, y: y0 + (h * i) / 20 });
	for (let i = 1; i <= 20; i++) pts.push({ x: x0 + w - (w * i) / 20, y: y0 + h });
	for (let i = 1; i <= 20; i++) pts.push({ x: x0, y: y0 + h - (h * i) / 20 });
	return strokeFrom(id, pts);
}

/** A box filled in with a scribble: legs along x from x0 to x1, each moving down by `gap`, from y0. */
export function boxFill(id: string, x0: number, x1: number, y0: number, legs: number, gap: number): InkStroke {
	const pts: Array<{ x: number; y: number }> = [];
	for (let l = 0; l < legs; l++) {
		for (let i = 0; i <= 20; i++) {
			const t = l % 2 === 0 ? i / 20 : 1 - i / 20;
			pts.push({ x: x0 + (x1 - x0) * t, y: y0 + l * gap + (gap * i) / 20 });
		}
	}
	return strokeFrom(id, pts);
}

/** An ellipse round (cx, cy) traced `turns` times, 60 samples a turn: a phrase circled for emphasis. */
export function circled(id: string, cx: number, cy: number, rx: number, ry: number, turns: number): InkStroke {
	return strokeFrom(id, curve(60 * turns, (t) => ({ x: cx + rx * Math.cos(t * turns * 2 * Math.PI), y: cy + ry * Math.sin(t * turns * 2 * Math.PI) })));
}

/** Cursive arches: an m is three, minimum is ten. */
function arches(id: string, x0: number, y0: number, w: number, h: number, n: number): InkStroke {
	return strokeFrom(id, curve(30 * n, (t) => ({ x: x0 + w * t, y: y0 + h - h * Math.abs(Math.sin(Math.PI * n * t)) })));
}

/** A pointed zigzag moving right: a w is four legs. */
function zigzagRight(id: string, x0: number, y0: number, w: number, h: number, legs: number): InkStroke {
	return strokeFrom(
		id,
		curve(20 * legs, (t) => {
			const s = (t * legs) % 2;
			const tri = s < 1 ? s : 2 - s;
			return { x: x0 + w * t, y: y0 + h * tri };
		})
	);
}

/** Back and forth along a line, few legs: a double strike-through and its like. */
function strikes(id: string, x0: number, x1: number, y: number, legs: number, drift: number): InkStroke {
	return scribble(id, x0, x1, y, y + drift, legs);
}

/** One-stroke zigzag hatching over a box: legs on the diagonal, `gap` apart. */
function zigzagHatch(id: string, x0: number, y0: number, size: number, legs: number): InkStroke {
	const pts: Array<{ x: number; y: number }> = [];
	const gap = size / legs;
	for (let l = 0; l < legs; l++) {
		for (let i = 0; i <= 20; i++) {
			const t = l % 2 === 0 ? i / 20 : 1 - i / 20;
			pts.push({ x: x0 + l * gap + t * size * 0.5, y: y0 + size * t });
		}
	}
	return strokeFrom(id, pts);
}

/**
 * Twenty ordinary strokes, all drawn over the dense page: none is a scribble.
 * Names say what each is.
 */
export function ordinaryStrokes(): InkStroke[] {
	const out: InkStroke[] = [
		arches("m narrow", 300, 130, 20, 18, 3),
		arches("m wide", 340, 130, 30, 18, 3),
		zigzagRight("w", 380, 130, 28, 18, 4),
		arches("minimum in one stroke", 100, 160, 130, 18, 10),
		zigzagHatch("hatching in one stroke", 300, 190, 60, 10),
		strokeFrom("crossed-out word, one line", curve(40, (t) => ({ x: 100 + 100 * t, y: 109 }))),
		strikes("crossed-out word, double strike", 100, 200, 107, 2, 3),
		strikes("crossed-out word, zigzag strike", 100, 200, 103, 4, 12),
		strokeFrom("circle round a word", curve(60, (t) => ({ x: 150 + 60 * Math.cos(t * 2 * Math.PI), y: 109 + 16 * Math.sin(t * 2 * Math.PI) }))),
		strokeFrom("underline", curve(40, (t) => ({ x: 40 + 200 * t, y: 150 }))),
		strokeFrom("check mark", [
			...curve(10, (t) => ({ x: 400 + 8 * t, y: 220 + 10 * t })),
			...curve(20, (t) => ({ x: 408 + 20 * t, y: 230 - 30 * t })),
		]),
		strokeFrom("arrow", [
			...curve(30, (t) => ({ x: 100 + 150 * t, y: 250 })),
			...curve(6, (t) => ({ x: 250 - 12 * t, y: 250 - 8 * t })),
			...curve(6, (t) => ({ x: 238 + 12 * t, y: 242 + 8 * t })),
			...curve(6, (t) => ({ x: 250 - 12 * t, y: 250 + 8 * t })),
		]),
		strokeFrom("spiral", curve(150, (t) => ({ x: 500 + (3 + 20 * t) * Math.cos(t * 6 * Math.PI), y: 250 + (3 + 20 * t) * Math.sin(t * 6 * Math.PI) }))),
		strokeFrom("eee loops", curve(120, (t) => ({ x: 300 + 60 * t + 7 * Math.cos(t * 8 * Math.PI), y: 280 + 7 * Math.sin(t * 8 * Math.PI) }))),
		strokeFrom("figure 8", curve(80, (t) => ({ x: 450 + 8 * Math.sin(t * 4 * Math.PI), y: 280 + 16 * Math.sin(t * 2 * Math.PI) }))),
	];
	// Hatching drawn as separate lines, each its own stroke.
	for (let i = 0; i < 5; i++) {
		out.push(strokeFrom(`hatching line ${i + 1}`, curve(20, (t) => ({ x: 480 + i * 6 + 20 * t, y: 160 + 30 * t }))));
	}
	return out;
}
