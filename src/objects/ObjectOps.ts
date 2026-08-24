import { Op } from "../history/History";
import { PageData } from "../model/PageData";
import { translateStroke } from "./Selection";

/**
 * Undoable operations on spatial objects.
 *
 * The rule these exist to enforce: **an operation captures its operands at
 * creation time and never consults live UI state.**
 *
 * The move operation used to close over the view's selection sets and filter by
 * "whatever is selected right now". Selection is cleared on tool switch, on
 * Escape, and at the start of every new lasso. So lasso, drag, switch to the
 * pen, then undo, and the operation matched nothing: the document did not move
 * back, yet the op still moved onto the redo stack. History and document
 * diverged silently and every later undo was off by one.
 *
 * Building ops here, from immutable id lists, makes that failure impossible to
 * reintroduce by imitation, and makes it testable without a DOM.
 */

export interface MoveTargets {
	strokeIds: readonly string[];
	boxIds: readonly string[];
	imageIds: readonly string[];
}

/** Translate exactly the listed objects. Ids that no longer exist are skipped. */
export function moveObjects(
	page: PageData,
	targets: MoveTargets,
	dx: number,
	dy: number
): void {
	if (dx === 0 && dy === 0) return;
	const strokeIds = new Set(targets.strokeIds);
	const boxIds = new Set(targets.boxIds);
	const imageIds = new Set(targets.imageIds);
	for (const stroke of page.strokes) {
		if (strokeIds.has(stroke.id)) translateStroke(stroke, dx, dy);
	}
	for (const box of page.textBoxes) {
		if (!boxIds.has(box.id)) continue;
		box.x += dx;
		box.y += dy;
	}
	for (const image of page.images) {
		if (!imageIds.has(image.id)) continue;
		image.x += dx;
		image.y += dy;
	}
}

/**
 * An undoable move of a fixed set of objects.
 *
 * `targets` is copied, so later changes to the caller's selection cannot alter
 * what this operation moves. The gesture has already been applied to the
 * document by the time this is created, so it is `push`ed, not `run`; `apply`
 * exists for redo.
 */
export function createMoveOp(
	page: PageData,
	targets: MoveTargets,
	dx: number,
	dy: number,
	onChange?: () => void
): Op {
	const frozen: MoveTargets = {
		strokeIds: [...targets.strokeIds],
		boxIds: [...targets.boxIds],
		imageIds: [...targets.imageIds],
	};
	const count =
		frozen.strokeIds.length + frozen.boxIds.length + frozen.imageIds.length;
	return {
		label: `Move ${count} object(s)`,
		apply: () => {
			moveObjects(page, frozen, dx, dy);
			onChange?.();
		},
		invert: () => {
			moveObjects(page, frozen, -dx, -dy);
			onChange?.();
		},
	};
}
