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
	/**
	 * Where the stroke sat against the note's text, note surface only. The
	 * points and bbox stay page coordinates and the truth of record; the note
	 * surface shows the stroke moved by however far its line has moved since
	 * (LineAnchor.ts). Absent, the stroke shows at its page position, as it
	 * always has. Older builds keep the field through the unknown-field path.
	 */
	lineAnchor?: LineAnchor;
}

/**
 * A stroke's place against one line of the note's text, taken when the line
 * was laid out. All lengths are world units.
 */
export interface LineAnchor {
	/** 1-based editor line under the stroke's bbox top when the anchor was taken. */
	line: number;
	/** That line's top when the anchor was taken. The stroke is shown moved by the line's top now minus this. */
	top: number;
	/** The stroke's bbox.y when the anchor was taken. A move by a build that does not know the field breaks the match. */
	y: number;
	/** A 32-bit hash of the line's text when the anchor was taken: an edit made where no anchor followed it breaks the match. */
	key: number;
	/** The editor's content width, layout px, when the anchor was taken. */
	width: number;
	/** The editor's font size, px, when the anchor was taken. */
	fontPx: number;
	/**
	 * A 32-bit hash of the text of every line above `line` when the anchor was taken or last moved by a live edit. Read once
	 * after a surface mounts: an edit above made where no anchor followed it breaks the match. Absent in older files, where
	 * the anchor is not honoured until a surface takes it again.
	 */
	above?: number;
}

/** The same anchor on a stroke moved down by `dy` in page coordinates: the line and its top stay, the stroke's own y moves. */
export function translatedAnchor(a: LineAnchor, dy: number): LineAnchor {
	return { ...a, y: a.y + dy };
}

/** The same anchor on a stroke scaled about the note origin by `k`: world lengths scale with it. */
export function scaledAnchor(a: LineAnchor, k: number): LineAnchor {
	return { ...a, top: a.top * k, y: a.y * k };
}

/**
 * Holders of line anchors that document changes have not reached yet: a note surface applies typing to its anchors when it
 * next reads them (LineAnchors in inline/LineAnchor.ts), and holds them here meanwhile. Each `fold` brings its anchors up to
 * date and lets go.
 */
const unsettledAnchors = new Set<{ fold(): void }>();

export function holdLineAnchors(holder: { fold(): void }): void {
	unsettledAnchors.add(holder);
}

export function releaseLineAnchors(holder: { fold(): void }): void {
	unsettledAnchors.delete(holder);
}

/** Bring every line anchor up to date with its note's text: before a page's strokes are written. */
export function settleLineAnchors(): void {
	for (const holder of unsettledAnchors) holder.fold();
}

/**
 * The anchor of a piece cut from `parent`: the parent's line and top, and the parent's anchor y moved by the piece's bbox
 * offset, so a parent anchor that had stopped matching its stroke stops matching on the piece too.
 */
export function pieceAnchor(parent: InkStroke, piece: InkStroke): LineAnchor | undefined {
	const a = parent.lineAnchor;
	return a ? { ...a, y: a.y + (piece.bbox.y - parent.bbox.y) } : undefined;
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
