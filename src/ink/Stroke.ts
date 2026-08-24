/**
 * Ink data model (handoff §10). All coordinates are WORLD coordinates.
 * This is the in-memory shape; PageData serializes it for the sidecar.
 */

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
