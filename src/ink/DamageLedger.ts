import { BBox } from "./Stroke";

/**
 * Damage tracking for the committed-ink renderer (renderer debt, 2026-08-27).
 *
 * The committed canvases stopped being cleared-and-redrawn per repaint and
 * became their own cache: a repaint now shifts surviving pixels on scroll
 * and re-rasterizes only what this ledger says changed. The ledger is the
 * pure part - world-space rects in, a bounded work list out.
 *
 * "all" is the honest fallback and stays cheapest to reason about: reloads,
 * zoom changes, resizes and anything unsure marks everything. Rect damage
 * is for the hot cases that used to hurt - the eraser ring per frame, a
 * moved selection, an applied undo op.
 */

const MAX_RECTS = 12;
const PAD = 4;

export class DamageLedger {
	private rects: BBox[] = [];
	private everything = true; // first paint renders the world

	/** Mark a world-space rect dirty, padded so antialiased edges heal. */
	addRect(b: BBox): void {
		if (this.everything) return;
		if (this.rects.length >= MAX_RECTS) {
			// Too fragmented to be worth clipping twelve times: coalesce into
			// a full repaint rather than bookkeeping ourselves to death.
			this.everything = true;
			this.rects = [];
			return;
		}
		this.rects.push({
			x: b.x - PAD,
			y: b.y - PAD,
			width: b.width + 2 * PAD,
			height: b.height + 2 * PAD,
		});
	}

	addAll(): void {
		this.everything = true;
		this.rects = [];
	}

	get isAll(): boolean {
		return this.everything;
	}

	get isEmpty(): boolean {
		return !this.everything && this.rects.length === 0;
	}

	/** Consume the ledger: returns "all", a rect list, or [] for nothing. */
	take(): "all" | BBox[] {
		if (this.everything) {
			this.everything = false;
			this.rects = [];
			return "all";
		}
		const out = this.rects;
		this.rects = [];
		return out;
	}
}

/**
 * Pure scroll-shift plan: the camera moved by (dxWorld, dyWorld) at `zoom`
 * over a viewport of cssW x cssH. Returns the css-pixel blit shift plus the
 * newly exposed world-space bands that must be rendered fresh. A move
 * larger than the viewport degenerates to a full repaint (null).
 */
export function shiftPlan(
	dxWorld: number,
	dyWorld: number,
	zoom: number,
	camX: number,
	camY: number,
	cssW: number,
	cssH: number
): { shiftX: number; shiftY: number; exposed: BBox[] } | null {
	const shiftX = -dxWorld * zoom;
	const shiftY = -dyWorld * zoom;
	if (Math.abs(shiftX) >= cssW || Math.abs(shiftY) >= cssH) return null;
	if (shiftX === 0 && shiftY === 0) return { shiftX: 0, shiftY: 0, exposed: [] };
	const worldW = cssW / zoom;
	const worldH = cssH / zoom;
	const exposed: BBox[] = [];
	// Vertical band uncovered by a horizontal shift.
	if (shiftX < 0) {
		exposed.push({ x: camX + worldW + shiftX / zoom, y: camY, width: -shiftX / zoom, height: worldH });
	} else if (shiftX > 0) {
		exposed.push({ x: camX, y: camY, width: shiftX / zoom, height: worldH });
	}
	// Horizontal band uncovered by a vertical shift (excluding the corner
	// already covered by the vertical band).
	const bandX = shiftX > 0 ? camX + shiftX / zoom : camX;
	const bandW = worldW - Math.abs(shiftX) / zoom;
	if (shiftY < 0) {
		exposed.push({ x: bandX, y: camY + worldH + shiftY / zoom, width: bandW, height: -shiftY / zoom });
	} else if (shiftY > 0) {
		exposed.push({ x: bandX, y: camY, width: bandW, height: shiftY / zoom });
	}
	return { shiftX, shiftY, exposed };
}
