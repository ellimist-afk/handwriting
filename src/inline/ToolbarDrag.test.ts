/**
 * The two rules behind drag-to-anchor, attacked as arithmetic.
 *
 * Neither of them can be tested through the strip: the suite has no layout,
 * so a `MobileTools` built here measures zeros and every anchor is equidistant
 * from every drop. Split out for exactly that reason, the same split
 * `StripClearance.ts` and `StripOverflow.ts` already are, and what is left in
 * the class - the measuring, the painting, the pointer bookkeeping - is
 * covered by the drag tests at the foot of `MobileTools.test.ts`.
 */

import { describe, expect, it } from "vitest";
import css from "../../styles.css?raw";
import {
	DRAG_THRESHOLD_PX,
	TOOLBAR_ANCHOR_INSET_PX,
	anchorRestingCentre,
	dragPassedThreshold,
	nearestAnchor,
} from "./ToolbarDrag";
import {
	TOOLBAR_CORNERS,
	toolbarAnchorColumn,
	toolbarAnchorRow,
	toolbarCornerClass,
} from "./ToolbarCorner";
import type { ToolbarCorner } from "./ToolbarCorner";

/** A 1000x800 pane, big enough that no two anchors are near each other. */
const PANE = { left: 0, top: 0, right: 1000, bottom: 800 };
/** An expanded strip, and the collapsed pill's 34px square. */
const STRIP = { width: 400, height: 40 };
const PILL = { width: 34, height: 34 };

const drop = (
	x: number,
	y: number,
	size = STRIP,
	current: ToolbarCorner = "top-right"
): ToolbarCorner =>
	nearestAnchor({
		centre: { x, y },
		pane: PANE,
		size,
		inset: TOOLBAR_ANCHOR_INSET_PX,
		current,
	});

describe("dragPassedThreshold: a tap stays a tap", () => {
	it("a contact that has not moved is not a drag", () => {
		expect(dragPassedThreshold(0, 0)).toBe(false);
	});

	it("pen jitter is not a drag - the whole reason the pill can still be tapped", () => {
		// A pen on glass moves a pixel or two between contact and lift on
		// every tap ever made. If any of these read as a drag, the collapsed
		// pill could never be tapped open again.
		expect(dragPassedThreshold(1, 0)).toBe(false);
		expect(dragPassedThreshold(-2, 2)).toBe(false);
		expect(dragPassedThreshold(3, 4)).toBe(false); // exactly 5px
	});

	it("exactly the threshold is still a tap - BEYOND it is the drag", () => {
		expect(dragPassedThreshold(DRAG_THRESHOLD_PX, 0)).toBe(false);
		expect(dragPassedThreshold(0, -DRAG_THRESHOLD_PX)).toBe(false);
		expect(dragPassedThreshold(DRAG_THRESHOLD_PX + 1, 0)).toBe(true);
	});

	it("measures the distance, not either axis on its own", () => {
		// 5 across and 5 down is 7.07 travelled: a diagonal drag that a
		// per-axis test would refuse until it had gone half again as far.
		expect(dragPassedThreshold(5, 5)).toBe(true);
		expect(dragPassedThreshold(-5, -5)).toBe(true);
		// And the reverse: 4 and 4 is 5.66, which is not yet a drag.
		expect(dragPassedThreshold(4, 4)).toBe(false);
	});

	it("is symmetric in direction", () => {
		for (const [dx, dy] of [
			[9, 0],
			[-9, 0],
			[0, 9],
			[0, -9],
		]) {
			expect(dragPassedThreshold(dx!, dy!), `${dx},${dy}`).toBe(true);
		}
	});
});

describe("anchorRestingCentre: where the 3x3 grid puts the strip's middle", () => {
	it("returns all nine distinct expected centres for the expanded strip", () => {
		const expected: Record<ToolbarCorner, { x: number; y: number }> = {
			"top-left": { x: 208, y: 28 },
			"top-center": { x: 500, y: 28 },
			"top-right": { x: 792, y: 28 },
			"middle-left": { x: 208, y: 400 },
			"middle-center": { x: 500, y: 400 },
			"middle-right": { x: 792, y: 400 },
			"bottom-left": { x: 208, y: 772 },
			"bottom-center": { x: 500, y: 772 },
			"bottom-right": { x: 792, y: 772 },
		};
		for (const corner of TOOLBAR_CORNERS) {
			expect(anchorRestingCentre(corner, PANE, STRIP, 8), corner).toEqual(expected[corner]);
		}
		expect(new Set(Object.values(expected).map(({ x, y }) => `${x},${y}`))).toHaveLength(9);
	});

	it("uses the pane midline for the whole middle row in both toolbar sizes", () => {
		for (const size of [STRIP, PILL]) {
			for (const corner of ["middle-left", "middle-center", "middle-right"] as const) {
				expect(anchorRestingCentre(corner, PANE, size, 8).y, corner).toBe(400);
			}
		}
	});

	it("keeps the centre column centred as the toolbar width changes", () => {
		for (const size of [STRIP, PILL, { width: 984, height: 40 }]) {
			for (const corner of ["top-center", "middle-center", "bottom-center"] as const) {
				expect(anchorRestingCentre(corner, PANE, size, 8).x, corner).toBe(500);
			}
		}
	});

	it("keeps top and bottom edge centres concentric in the pill size", () => {
		expect(anchorRestingCentre("top-center", PANE, PILL, 8).y).toBe(25);
		expect(anchorRestingCentre("bottom-center", PANE, PILL, 8).y).toBe(775);
	});
});

describe("nearestAnchor: which cell of the 3x3 grid a drop landed on", () => {
	it("a drop right on an anchor's resting centre chooses that anchor", () => {
		for (const corner of TOOLBAR_CORNERS) {
			const at = anchorRestingCentre(corner, PANE, STRIP, TOOLBAR_ANCHOR_INSET_PX);
			// `current` deliberately set to something else, so a pass here
			// cannot be the tie-break answering.
			expect(drop(at.x, at.y, STRIP, "bottom-right"), corner).toBe(corner);
			expect(drop(at.x, at.y, STRIP, "top-left"), corner).toBe(corner);
		}
	});

	it("retains top and bottom drops and adds all three centre-height drops", () => {
		expect(drop(208, 100)).toBe("top-left");
		expect(drop(500, 100)).toBe("top-center");
		expect(drop(792, 100)).toBe("top-right");
		expect(drop(208, 400)).toBe("middle-left");
		expect(drop(500, 400)).toBe("middle-center");
		expect(drop(792, 400)).toBe("middle-right");
		expect(drop(208, 700)).toBe("bottom-left");
		expect(drop(500, 700)).toBe("bottom-center");
		expect(drop(792, 700)).toBe("bottom-right");
	});

	/**
	 * THE SIZE IS PART OF THE ANSWER, and this is the case that says so.
	 *
	 * The same point on the glass, the same pane, the same drag - and the
	 * right answer differs depending on whether what the user is holding is
	 * the full strip or the 34px pill. A 400px strip parked top-left has its
	 * middle 208px in from the edge, so a drop at x=350 is nearer to top-left
	 * than to the pane's centre; a pill parked top-left has its middle 25px
	 * in, so the same drop is much nearer the centre. Computing against a
	 * fixed size - or against the expanded strip's size while the pill is
	 * what is on screen - would fly the toolbar past the anchor the user
	 * aimed at.
	 */
	it("the same drop lands differently for the strip and for the collapsed pill", () => {
		expect(drop(350, 28, STRIP, "bottom-right")).toBe("top-left");
		expect(drop(350, 28, PILL, "bottom-right")).toBe("top-center");
	});

	/**
	 * THE TIE IS REAL, not a hypothetical: `.handwriting-mobile-tools` is
	 * capped at `calc(100% - 16px)`, which is exactly the width at which a
	 * left-anchored strip and a right-anchored one have the same centre - so
	 * on a phone, where the strip routinely sits at that cap, all three
	 * anchors on an edge ARE the same point. Whatever is chosen looks
	 * identical; what must not happen is the setting silently changing under
	 * a drag that expressed no preference.
	 */
	it("a strip as wide as the pane allows leaves the placement where it was", () => {
		const wide = { width: PANE.right - 2 * TOOLBAR_ANCHOR_INSET_PX, height: 40 };
		for (const corner of ["top-left", "top-right", "top-center"] as ToolbarCorner[]) {
			expect(anchorRestingCentre(corner, PANE, wide, TOOLBAR_ANCHOR_INSET_PX).x).toBe(500);
			expect(drop(500, 28, wide, corner), corner).toBe(corner);
		}
	});

	it("but a tie never pins the strip to the edge it started on", () => {
		const wide = { width: PANE.right - 2 * TOOLBAR_ANCHOR_INSET_PX, height: 40 };
		// Dragged from the top edge to the bottom one. All three bottom
		// anchors are the same point at this width and the current anchor is
		// none of them, so the tie falls to the vocabulary's own order
		// (TOOLBAR_CORNERS, ToolbarCorner.ts) - which is a deterministic
		// answer and, at this width, a visually identical one. What matters
		// is that the strip moved edge.
		expect(drop(500, 772, wide, "top-left")).toBe("bottom-right");
		// And a tie the current anchor is part of still keeps it.
		expect(drop(500, 772, wide, "bottom-center")).toBe("bottom-center");
	});
});

/**
 * The one number this module copies out of the stylesheet, pinned to it.
 *
 * `TOOLBAR_ANCHOR_INSET_PX` is only a tie-breaker - it shifts the outer rows
 * and columns inward, and the landing itself is measured rather than
 * predicted - but a copied constant with nothing holding it to its original
 * is a copied constant that drifts. This is the same assertion-on-stylesheet-
 * text `CornerSafeArea.test.ts` uses, and for the same reason: the value is
 * one the code depends on and no unit test can observe.
 */
describe("styles.css - the anchor inset the drop rule assumes is the one the sheet uses", () => {
	const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ");

	it("every base corner rule holds the strip that far off the pane's edge", () => {
		for (const corner of TOOLBAR_CORNERS) {
			const selector = `.handwriting-mobile-tools.${toolbarCornerClass(corner)}`;
			const rule = bare.match(
				new RegExp(`(?:^|,|\\})[^{}]*${selector.replace(/\./g, "\\.")}\\s*(?:,[^{}]*)?\\{([^{}]*)\\}`)
			);
			expect(rule, `rule missing: ${selector}`).not.toBeNull();
			const vertical =
				toolbarAnchorRow(corner) === "middle"
					? (["top", "bottom"] as const)
					: ([toolbarAnchorRow(corner)] as const);
			const column = toolbarAnchorColumn(corner);
			const horizontal = column === "center" ? [] : [column];
			for (const edge of [...vertical, ...horizontal]) {
				expect(
					rule![1],
					`${selector} does not hold the strip ${TOOLBAR_ANCHOR_INSET_PX}px off the ${edge} bound`
				).toMatch(
					new RegExp(
						`${edge}:\\s*calc\\(\\s*env\\([^)]*\\)\\s*\\+\\s*${TOOLBAR_ANCHOR_INSET_PX}px\\s*\\)`
					)
				);
			}
		}
	});
});
