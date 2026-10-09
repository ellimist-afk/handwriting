/**
 * Ink data model (handoff §10). All coordinates are WORLD coordinates.
 * This is the in-memory shape; PageData serializes it for the sidecar.
 */

import type { PressureProfile, StrokeWidthMode } from "./StrokeWidth";

export interface InkPoint {
	x: number;
	y: number;
	/** 0..1; mouse/unknown devices are normalized to 0.5 by the builder. */
	pressure: number;
	/** ms, relative to stroke start (keeps numbers small for later storage). */
	t: number;
	tiltX?: number;
	tiltY?: number;
}

export interface BBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type InkTool = "pen" | "highlighter";

export interface InkStroke {
	id: string;
	tool: InkTool;
	color: string;
	/** Base width in world units at pressure ≈ mid. */
	width: number;
	points: InkPoint[];
	bbox: BBox;
	createdAt: number;
	/** Present on new finger strokes whose selected width stays constant. */
	widthMode?: StrokeWidthMode;
	/** Geometry generation used for newly-authored pressure-aware ink. */
	pressureProfile?: PressureProfile;
	/**
	 * The pressure setting the stroke was written under. A stroke that carries
	 * it is painted, cached and exported under that value whatever the switch
	 * says now; absent, the switch decides, as it always has. The profile
	 * still picks the width law; this only says whether pressure moves width
	 * inside it. Any other value in a file reads as absent and is written back
	 * as found.
	 */
	pressureSensitivity?: "on" | "off";
	/**
	 * Present only for mouse-drawn strokes (v0.13.16). A mouse has no
	 * pressure and its speed says nothing about intent, so the shaped width
	 * law (velocity thinning, taper) does not apply to it - at mouse speeds
	 * the thinning filter oscillates around its floor and the width flicker
	 * reads as scratchiness. Absent = a pen drew it.
	 */
	device?: "mouse";
	/**
	 * Which PDF page this stroke lives on, 1-based, matching the viewer's own
	 * `data-page-number`. Present only on the pdf surface.
	 *
	 * A stroke belongs to exactly ONE page - the one its first sample landed
	 * on. Splitting a boundary-crossing stroke would make one gesture into two
	 * objects that erase and undo separately; see PageMap.strokePage.
	 */
	page?: number;
}

export function computeBBox(points: InkPoint[], padWorld: number): BBox {
	if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of points) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	return {
		x: minX - padWorld,
		y: minY - padWorld,
		width: maxX - minX + padWorld * 2,
		height: maxY - minY + padWorld * 2,
	};
}

let counter = 0;
export function newStrokeId(): string {
	// crypto.randomUUID exists in Obsidian's Electron; fall back just in case.
	try {
		return crypto.randomUUID();
	} catch {
		return `stroke-${Date.now()}-${counter++}`;
	}
}
