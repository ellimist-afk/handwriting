/**
 * The heavy note's ink for PrintStrokes.test.ts, apart from the page so a node script can count its paths.
 */
import type { InkStroke } from "../../src/ink/Stroke";

/** Seeded so every run draws the same note (mulberry32). */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function strokeOf(id: string, tool: "pen" | "highlighter", color: string, width: number, pts: Array<{ x: number; y: number }>): InkStroke {
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
	const pad = width;
	return {
		id, tool, color, width, createdAt: 0,
		points: pts.map((p, j) => ({ x: p.x, y: p.y, pressure: 0.5, t: j * 8 })),
		bbox: { x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad },
	} as InkStroke;
}

/**
 * `rows` rows of `perRow` pen strokes plus two highlighter strokes; note px, inside a 680 px column. The pen changes
 * colour at RUN_SHARES of the strokes, so the fold made runs of Untitled 1's sizes (26 pen runs, the largest five a
 * quarter, an eighth, a ninth, a tenth and a fourteenth of its path segments; the rest even). A stroke is a
 * smooth wave of 57 points, sized so the print layer of heavyInk(45, 129) emits about Untitled 1's path commands
 * (85,399 subpaths and 667,737 lines against its PDF's 76,177 and 668,806).
 */
/** Where the ink starts, note px: under the page's title and paragraphs, so the print keeps each run in one strip. */
const TOP = 300;

/** Each pen run's share of the strokes, in the order drawn: Untitled 1's five largest, then 21 even runs. */
const RUN_SHARES = [0.25, 0.116, 0.108, 0.098, 0.066, ...Array.from({ length: 21 }, () => 0.362 / 21)];
const RUN_ENDS = RUN_SHARES.map((_, i) => RUN_SHARES.slice(0, i + 1).reduce((a, b) => a + b, 0)).map((e, i, all) => (i === all.length - 1 ? Infinity : e));

export function heavyInk(rows: number, perRow: number): InkStroke[] {
	const rnd = seeded(20261023);
	const out: InkStroke[] = [];
	const cell = 680 / perRow;
	// Rows close up so the whole note stays on one page under its text however many there are; a stroke spans three cells, so
	// neighbours overlap as dense writing does.
	const gap = Math.min(22, 520 / rows);
	const span = Math.min(680, cell * 3);
	for (let r = 0; r < rows; r++) {
		for (let k = 0; k < perRow; k++) {
			const x0 = Math.min(k * cell, 680 - span) + 2, y0 = TOP + r * gap;
			const ph = rnd() * 6.28;
			const pts = Array.from({ length: 57 }, (_, j) => ({
				x: x0 + (j / 56) * (span - 4),
				y: y0 + Math.sin(j * 0.15 + ph) * 2.2,
			}));
			const at = (r * perRow + k) / (rows * perRow);
			const run = RUN_ENDS.findIndex((end) => at < end);
			out.push(strokeOf(`p-${r}-${k}`, "pen", run % 2 === 0 ? "#1e1e1e" : "#1565c0", 2, pts));
		}
	}
	for (let h = 0; h < 2; h++) {
		const y = TOP + h * gap;
		out.push(strokeOf(`h-${h}`, "highlighter", "#ffeb3b", 14, Array.from({ length: 40 }, (_, j) => ({ x: 10 + j * 16, y }))));
	}
	return out;
}
