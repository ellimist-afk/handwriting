/**
 * Calibration ink: the visual oracle for M1.
 *
 * The question M1 has to answer is whether ink stored in page coordinates is
 * drawn where those coordinates say. A hand-authored sidecar answers it only
 * if you already trust the sidecar; this answers it by drawing crosses at the
 * exact coordinates the test fixture prints its registration marks at, so the
 * check is "does our ink sit on their mark" and there is nothing to interpret.
 *
 * It also checks PAGE selection, not just position: marks are placed on page 1
 * and every tenth page. Ink appearing on page 7 would mean the page mapping is
 * wrong, which a same-on-every-page pattern could never reveal.
 *
 * Pure. Generated on demand, never stored, and no part of the feature - this
 * exists to be looked at once per coordinate change and otherwise switched off.
 */

import { InkStroke, computeBBox } from "../ink/Stroke";

/**
 * The fixture's registration marks, in points from the page's top-left.
 * These are the coordinates `make_fixture.py` labels on every page; if that
 * document is regenerated with different marks, these move with it.
 */
export const CALIBRATION_MARKS: ReadonlyArray<readonly [number, number]> = [
	[100, 100],
	[306, 396],
	[512, 692],
	[100, 692],
	[512, 100],
];

const ARM = 20;
const WIDTH = 1.5;

function line(id: string, x1: number, y1: number, x2: number, y2: number): InkStroke {
	// Several samples rather than two, so the stroke exercises the same
	// flatten path real ink does instead of a degenerate two-point case.
	const points = Array.from({ length: 9 }, (_, i) => {
		const t = i / 8;
		return { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t, pressure: 0.6, t: i * 8 };
	});
	return {
		id,
		tool: "pen",
		color: "#2ecc71",
		width: WIDTH,
		points,
		bbox: computeBBox(points, WIDTH),
		createdAt: 0,
	};
}

/** Does this page carry calibration marks? Page 1 and every tenth. */
export function calibratedPage(pageNumber: number): boolean {
	return pageNumber === 1 || pageNumber % 10 === 0;
}

/**
 * A cross at each registration mark, sized to overlay the fixture's own.
 *
 * Green against the fixture's red: if the two cross-hairs coincide the ink is
 * placed correctly, and any offset shows as two separate marks rather than as
 * a judgement about whether something looks about right.
 */
export function calibrationStrokes(pageNumber: number): InkStroke[] {
	if (!calibratedPage(pageNumber)) return [];
	const out: InkStroke[] = [];
	for (const [x, y] of CALIBRATION_MARKS) {
		out.push(line(`cal-${pageNumber}-${x}-${y}-h`, x - ARM, y, x + ARM, y));
		out.push(line(`cal-${pageNumber}-${x}-${y}-v`, x, y - ARM, x, y + ARM));
	}
	return out;
}
