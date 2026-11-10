/**
 * The lasso's resize and rotate on the note surface.
 *
 * Four corner handles scale the selected ink uniformly about the opposite corner, and one knob above the box turns it about
 * the box centre. There are no edge handles: a stretch in one axis has no single width factor and would change a stroke's
 * shape. Shift on a mouse snaps the turn to 15 degrees; no other modifier does anything.
 *
 * Everything here is in world units on the note as it is shown (each stroke's page position plus its line's correction), and
 * the gesture carries one set of numbers, `accepted`: the preview draws its picture through `previewMatrix(accepted)` and the
 * lift rewrites the strokes through `transformPoint` with the same numbers, so the ink lands exactly where the soft picture
 * showed it. The camera is applied by the caller on top, so a scroll or a pinch mid-gesture changes nothing here.
 *
 * The top and the left of the note are walls. Every step is accepted: one whose box would cross a wall slides inward onto
 * it (the step's shift), so ink at a wall still turns and resizes and the preview follows the pen, never freezing and then
 * jumping, while the preview never shows a box past a wall and the lift never lands one there. A box that already sits past
 * a wall at the grab is judged against where it started: no corner ends further past the wall than at the start. A corner
 * within 1e-6 of its wall is not past it, so a corner a step leaves in place is not slid for the float rounding of its
 * matrix. Judged on the ink's own box.
 *
 * The lift is an in-place rewrite (the store's `rewriteStrokes`): each stroke keeps its object and its id, so the history,
 * the ribbon cache (by stroke rev), other panes and the sync guard all keep naming the same stroke. The history keeps a
 * copy of the shape from before and from after, and undo and redo put those copies back byte for byte; a float inverse of a
 * turn would not.
 */
import type { CameraState } from "../camera/coordinates";
import type { Point2 } from "../ink/Smoothing";
import { BBox, computeBBox, InkPoint, InkStroke, LineAnchor } from "../ink/Stroke";
import { MAX_WIDTH } from "../model/PageData";

export type TransformHandle = "nw" | "ne" | "se" | "sw" | "rotate";
export type HandleInput = "pen" | "mouse" | "touch";

/** A transform about `pivot`: scale by `scale`, then turn by `angle` radians (clockwise on screen, y down). */
export interface TransformParams {
	readonly pivot: Point2;
	readonly scale: number;
	readonly angle: number;
	/** Where the step slid the result onto a wall it would cross, world units, added last; none when nothing was slid. */
	readonly shift?: Point2;
}

/** One resize or rotate, from the grab on a handle to the lift. `accepted` is the step the preview shows and the lift applies. */
export interface TransformGesture {
	readonly handle: TransformHandle;
	/** The selection's box at the grab, shown place, world units. */
	readonly box: BBox;
	readonly pivot: Point2;
	/** Where the grab landed on the handle. */
	readonly from: Point2;
	accepted: TransformParams;
	/** The selected strokes' thinnest and widest width at the grab; none, no width bound. */
	readonly widths?: WidthRange;
}

/** The thinnest and the widest width of a selection's strokes. */
export interface WidthRange {
	readonly min: number;
	readonly max: number;
}

/** The part of a stroke a transform rewrites. Copies, never the stroke's own arrays. */
export interface StrokeShape {
	points: InkPoint[];
	width: number;
	bbox: BBox;
	lineAnchor?: LineAnchor;
}

/** A finger's hit square per handle, css px. */
export const HANDLE_TOUCH_PX = 44;
/** A pen's or a mouse's hit square per handle, css px. */
export const HANDLE_POINTER_PX = 12;
/** The square drawn for a handle, css px: smaller than either hit square. */
export const HANDLE_DRAW_PX = 8;
/** How far above the drawn box's top the rotate knob sits, css px. */
export const ROTATE_KNOB_GAP_PX = 24;
/** The drawn selection box's pad around the ink's box, css px (TailRenderer.drawSelectionBox). */
const BOX_PAD_PX = 6;
/** The smallest scale a corner reaches: the ink never shrinks to nothing or turns inside out through the pivot. */
export const MIN_TRANSFORM_SCALE = 0.1;
/** The thinnest width a resize lands: the smallest the save's 3 places keep above 0. */
export const WIDTH_FLOOR = 0.001;
/** Shift on a mouse snaps a turn to steps of this many radians (15 degrees). */
export const ROTATE_SNAP = Math.PI / 12;

const IDENTITY_SCALE = 1;
/** How far past a wall, world units, a corner may sit before a step slides it back (float rounding of a corner left in place). */
const WALL_TOLERANCE = 1e-6;

/** Handles show only when the selection holds strokes alone; a selection with a text box or an image keeps today's drag. */
export function handlesShown(sel: { strokes: number; boxes: number; images: number }): boolean {
	return sel.strokes > 0 && sel.boxes === 0 && sel.images === 0;
}

/**
 * Each handle's centre, world units, at `zoom` (css px per world unit): the drawn box's corners and the knob over its top.
 * `cssScale` is the canvas zoom, screen px per css px: the corners sit on the dashed box, which is padded in css px, and the
 * knob's gap is screen px, so it stays the same distance over the box on screen at any canvas zoom.
 */
export function handlePoints(box: BBox, zoom: number, cssScale = 1): Record<TransformHandle, Point2> {
	const pad = BOX_PAD_PX / zoom;
	const left = box.x - pad;
	const top = box.y - pad;
	const right = box.x + box.width + pad;
	const bottom = box.y + box.height + pad;
	return {
		nw: { x: left, y: top },
		ne: { x: right, y: top },
		se: { x: right, y: bottom },
		sw: { x: left, y: bottom },
		rotate: { x: box.x + box.width / 2, y: top - ROTATE_KNOB_GAP_PX / (zoom * cssScale) },
	};
}

/** The frame the handles ride, world units: the drawn box's four corners, nw, ne, se, sw, and each handle's centre. */
export interface TransformFrame {
	readonly corners: readonly [Point2, Point2, Point2, Point2];
	readonly handles: Record<TransformHandle, Point2>;
	/** Where the knob's stem leaves the frame: the middle of its top edge. */
	readonly stemFoot: Point2;
}

/**
 * The frame shown while `t` is the step: the ink box's corners under `t`, then the box's pad and the knob's gap laid out
 * along the turned box's own axes, at their usual css and screen px, not scaled with the ink. The knob keeps its bearing
 * from the pivot, so it stays under the pen for the whole turn. With no turn this is handlePoints of the scaled box, the
 * frame a resize has always shown; with no scale it is each of handlePoints' points under `t`.
 */
export function framePoints(box: BBox, t: TransformParams, zoom: number, cssScale = 1): TransformFrame {
	const pad = BOX_PAD_PX / zoom;
	const gap = ROTATE_KNOB_GAP_PX / (zoom * cssScale);
	const ux = Math.cos(t.angle), uy = Math.sin(t.angle);
	const vx = -uy, vy = ux;
	const at = (x: number, y: number, du: number, dv: number): Point2 => {
		const p = transformPoint({ x, y }, t);
		return { x: p.x + du * ux + dv * vx, y: p.y + du * uy + dv * vy };
	};
	const right = box.x + box.width, bottom = box.y + box.height;
	const nw = at(box.x, box.y, -pad, -pad);
	const ne = at(right, box.y, pad, -pad);
	const se = at(right, bottom, pad, pad);
	const sw = at(box.x, bottom, -pad, pad);
	const stemFoot = at(box.x + box.width / 2, box.y, 0, -pad);
	const rotate = at(box.x + box.width / 2, box.y, 0, -pad - gap);
	return { corners: [nw, ne, se, sw], handles: { nw, ne, se, sw, rotate }, stemFoot };
}

/** No resize and no turn: the frame as the selection's box shows it at rest. */
export const IDENTITY_TRANSFORM: TransformParams = { pivot: { x: 0, y: 0 }, scale: 1, angle: 0 };

/**
 * The ink box's corner opposite a corner handle: what a pull scales about. Not the opposite handle, which sits out at the
 * box's pad: the user watches the far ink corner, and it stays put.
 */
function oppositeInkCorner(box: BBox, handle: Exclude<TransformHandle, "rotate">): Point2 {
	return {
		x: handle === "nw" || handle === "sw" ? box.x + box.width : box.x,
		y: handle === "nw" || handle === "ne" ? box.y + box.height : box.y,
	};
}

/**
 * The handle under `at`, or null: each handle a square of the input's hit size in screen px around its centre, at any
 * canvas zoom (`cssScale`). Where squares overlap (a small box, a finger) the nearest centre wins; a tie goes to the knob,
 * then the corners in order. On a box under two finger widths both ways, a finger's corner square reaches into the drawn
 * box only as far as leaves a finger's width in its middle, so the box moves under a finger from inside; outside the box a
 * corner reaches as far as ever. A box wider or taller than that already leaves a band to move it by and is hit as before.
 */
export function hitTransformHandle(box: BBox, zoom: number, at: Point2, input: HandleInput, cssScale = 1): TransformHandle | null {
	const half = (input === "touch" ? HANDLE_TOUCH_PX : HANDLE_POINTER_PX) / 2 / (zoom * cssScale);
	const h = handlePoints(box, zoom, cssScale);
	const finger = HANDLE_TOUCH_PX / (zoom * cssScale);
	const small = h.ne.x - h.nw.x < 2 * finger && h.sw.y - h.nw.y < 2 * finger;
	const inside = input === "touch" && small && at.x > h.nw.x && at.x < h.ne.x && at.y > h.nw.y && at.y < h.sw.y;
	const inX = inside ? Math.min(half, Math.max(0, (h.ne.x - h.nw.x - finger) / 2)) : half;
	const inY = inside ? Math.min(half, Math.max(0, (h.sw.y - h.nw.y - finger) / 2)) : half;
	let best: TransformHandle | null = null, bestD = Infinity;
	for (const id of ["rotate", "nw", "ne", "se", "sw"] as const) {
		const dx = at.x - h[id].x, dy = at.y - h[id].y;
		if (Math.abs(dx) > half || Math.abs(dy) > half) continue;
		if (inside && id !== "rotate" && (Math.abs(dx) > inX || Math.abs(dy) > inY)) continue;
		const d = dx * dx + dy * dy;
		if (d < bestD) { best = id; bestD = d; }
	}
	return best;
}

/**
 * The grab on a handle: a corner scales about the ink box's opposite corner, the knob turns about the box centre. The
 * pivot no longer depends on the zoom (the handles' pad does); `_zoom` stays so the callers are unchanged. `widths` is the
 * thinnest and the widest selected stroke, which bound a corner's scale (stepTransform).
 */
export function beginTransform(box: BBox, handle: TransformHandle, at: Point2, _zoom: number, widths?: WidthRange): TransformGesture {
	const pivot =
		handle === "rotate"
			? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
			: oppositeInkCorner(box, handle);
	return { handle, box, pivot, from: { x: at.x, y: at.y }, accepted: { pivot, scale: IDENTITY_SCALE, angle: 0 }, widths };
}

/** The thinnest and the widest of `strokes`' widths, or undefined for none. */
export function widthRange(strokes: readonly { width: number }[]): WidthRange | undefined {
	if (strokes.length === 0) return undefined;
	let min = Infinity, max = 0;
	for (const s of strokes) { min = Math.min(min, s.width); max = Math.max(max, s.width); }
	return { min, max };
}

/**
 * A corner's scale bounded so every selected stroke's width stays one the save keeps and the reader takes back (at or above
 * WIDTH_FLOOR, at or under MAX_WIDTH): a wider one reopened as a 2.2 line. Bounded at the step, so the preview shows what
 * the lift lands. No room between the two bounds (widths a million apart): scale 1.
 */
function clampScaleToWidths(scale: number, widths: WidthRange | undefined): number {
	if (!widths) return scale;
	const lo = Math.max(MIN_TRANSFORM_SCALE, WIDTH_FLOOR / widths.min), hi = MAX_WIDTH / widths.max;
	return lo > hi ? IDENTITY_SCALE : Math.min(hi, Math.max(lo, scale));
}

/**
 * The step for a move to `at`: the scale of a corner pull (its projection on the grab's diagonal, so one factor, floored at
 * MIN_TRANSFORM_SCALE) or the angle of a knob turn (snapped for Shift on a mouse). A step whose box would cross the top or
 * the left wall slides inward onto the wall (slideInsideWalls); every step is accepted. With `k` (the camera's zoom times the
 * backing), a step that moves no corner of the box by half a backing px is the identity: a tap's jitter shows nothing, so the
 * lift records nothing, as a drag's whole-px rounding does.
 */
export function stepTransform(g: TransformGesture, at: Point2, opts: { shift: boolean; input: HandleInput; k?: number }): TransformParams {
	const { pivot, from } = g;
	let next: TransformParams;
	if (g.handle === "rotate") {
		let angle = Math.atan2(at.y - pivot.y, at.x - pivot.x) - Math.atan2(from.y - pivot.y, from.x - pivot.x);
		if (angle > Math.PI) angle -= 2 * Math.PI;
		else if (angle <= -Math.PI) angle += 2 * Math.PI;
		if (opts.shift && opts.input === "mouse") angle = Math.round(angle / ROTATE_SNAP) * ROTATE_SNAP;
		next = { pivot, scale: IDENTITY_SCALE, angle };
	} else {
		const dx = from.x - pivot.x;
		const dy = from.y - pivot.y;
		const len2 = dx * dx + dy * dy;
		const k = len2 > 0 ? ((at.x - pivot.x) * dx + (at.y - pivot.y) * dy) / len2 : IDENTITY_SCALE;
		next = { pivot, scale: clampScaleToWidths(Math.max(MIN_TRANSFORM_SCALE, k), g.widths), angle: 0 };
	}
	if (opts.k !== undefined && opts.k > 0 && cornerMove(g.box, next) * opts.k < 0.5) next = { pivot, scale: IDENTITY_SCALE, angle: 0 };
	g.accepted = slideInsideWalls(g.box, next);
	return g.accepted;
}

/** The most any corner of `box` moves under `t`, world units. */
function cornerMove(box: BBox, t: TransformParams): number {
	let most = 0;
	for (const [x, y] of [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]] as const) {
		const p = transformPoint({ x, y }, t);
		most = Math.max(most, Math.hypot(p.x - x, p.y - y));
	}
	return most;
}

/**
 * `t`, slid onto the top and left walls where its box would cross one: each wall at 0, or where the grab's box already was
 * past it. A corner within WALL_TOLERANCE of its wall stays; past that, the box lands on the wall exactly.
 */
function slideInsideWalls(box: BBox, t: TransformParams): TransformParams {
	const { x, y } = wallSlide(box, transformedBox(box, t));
	return x === 0 && y === 0 ? t : { ...t, shift: { x, y } };
}

/**
 * The shift that puts `out` back on the top and left walls, `box` being where it was at the grab: each wall at 0, or where
 * `box` already was past it. A side within WALL_TOLERANCE of its wall stays (0); past that, `out` lands on the wall exactly.
 */
export function wallSlide(box: BBox, out: BBox): { x: number; y: number } {
	const wallX = Math.min(0, box.x), wallY = Math.min(0, box.y);
	return {
		x: out.x < wallX - WALL_TOLERANCE ? wallX - out.x : 0,
		y: out.y < wallY - WALL_TOLERANCE ? wallY - out.y : 0,
	};
}

/** `p` under the transform: scaled and turned about the pivot. */
export function transformPoint(p: Point2, t: TransformParams): Point2 {
	const m = previewMatrix(t);
	return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/**
 * The transform as a canvas matrix [a, b, c, d, e, f] in world units, the form `setTransform` takes: the preview composes it
 * with the camera, and `transformPoint` (the lift) is this same matrix, so the two cannot disagree.
 */
export function previewMatrix(t: TransformParams): [number, number, number, number, number, number] {
	const c = Math.cos(t.angle) * t.scale;
	const s = Math.sin(t.angle) * t.scale;
	const { x, y } = t.pivot, shift = t.shift;
	return [c, s, -s, c, x - c * x + s * y + (shift ? shift.x : 0), y - s * x - c * y + (shift ? shift.y : 0)];
}

/** The axis-aligned box of `box`'s four corners under the transform: what the walls are judged on. */
export function transformedBox(box: BBox, t: TransformParams): BBox {
	const corners = [
		transformPoint({ x: box.x, y: box.y }, t),
		transformPoint({ x: box.x + box.width, y: box.y }, t),
		transformPoint({ x: box.x, y: box.y + box.height }, t),
		transformPoint({ x: box.x + box.width, y: box.y + box.height }, t),
	];
	const xs = corners.map((p) => p.x);
	const ys = corners.map((p) => p.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** A deep copy of the part of `stroke` a transform rewrites: the history's before copy. */
export function shapeOf(stroke: InkStroke): StrokeShape {
	const shape: StrokeShape = {
		points: stroke.points.map((p) => ({ ...p })),
		width: stroke.width,
		bbox: { ...stroke.bbox },
	};
	if (stroke.lineAnchor) shape.lineAnchor = { ...stroke.lineAnchor };
	return shape;
}

/**
 * `p`, a stored point of a stroke the note shows moved by `dx` and `dy` (its line's or its attached group's correction),
 * under the transform: moved to where it is shown, transformed there, and the correction taken back off. Every point the
 * lift writes goes this way, and so does an attached group's probe, a stored point of its probe stroke, so the probe stays
 * the point of that stroke it was.
 */
export function transformStorePoint(p: Point2, t: TransformParams, dy: number, dx = 0): Point2 {
	const q = transformPoint({ x: p.x + dx, y: p.y + dy }, t);
	return { x: q.x - dx, y: q.y - dy };
}

/**
 * `stroke` under the transform, as the lift writes it. `dy` and `dx` are how far the note shows the stroke from its page
 * position (its line's correction, or its attached group's in both axes): each point is moved in the shown place and the
 * correction taken back off (transformStorePoint), so the stroke lands where the preview showed it. The width scales with
 * the ink; the bbox is taken from the new points as a built stroke's is; the line anchor keeps its line and top and moves its
 * y with the bbox, so it still names the stroke for the drop's retake. Pressure and tilt stay on each point. The times scale
 * about the first with the ink (scaledTime), so the shaped law sees the speed the stroke was drawn at and the resized
 * stroke lands as a scaled copy of the preview's picture, not thinner (larger) or thicker (smaller).
 */
export function transformedShape(stroke: InkStroke, t: TransformParams, dy: number, dx = 0): StrokeShape {
	const t0 = stroke.points[0]?.t ?? 0;
	const points = stroke.points.map((p) => {
		const q = transformStorePoint(p, t, dy, dx);
		return { ...p, x: q.x, y: q.y, t: scaledTime(p.t, t0, t.scale) };
	});
	const width = stroke.width * t.scale;
	const bbox = computeBBox(points, width * 2);
	const shape: StrokeShape = { points, width, bbox };
	if (stroke.lineAnchor) shape.lineAnchor = { ...stroke.lineAnchor, y: stroke.lineAnchor.y + (bbox.y - stroke.bbox.y) };
	return shape;
}

/**
 * `time` scaled about `t0` by `scale`, in whole ms as the note stores times: a stroke scaled in space is scaled in time too,
 * so its speed, which thins the shaped width, stays the speed it was drawn at. Scale 1 (a drag or a turn) leaves it. Exact for
 * a scale down to 1 over the smallest gap in ms (the shaped law floors a gap at 1 ms); a smaller copy lands a little thinner.
 */
export function scaledTime(time: number, t0: number, scale: number): number {
	return scale === 1 ? time : Math.round(t0 + (time - t0) * scale);
}

/** The handle input a pointer gives: a finger, a mouse, or (anything else) a pen. */
export function handleInput(pointerType: string): HandleInput {
	return pointerType === "touch" ? "touch" : pointerType === "mouse" ? "mouse" : "pen";
}

/** What the lift writes and the history keeps: the strokes by id, each one's shape before and after. */
export interface TransformEdits {
	readonly strokeIds: readonly string[];
	readonly before: readonly StrokeShape[];
	readonly after: readonly StrokeShape[];
}

/**
 * The lift's edits for the strokes of `ids` among `strokes` (the store's own, page coordinates), in the store's order:
 * each one's shape now and under the transform. `dyOf` is the note's correction for a stroke in y, `dxOf` in x (an attached
 * group's; none for free ink). A stroke the list no longer holds is left out, so the edits and the history name only strokes
 * that are there.
 */
export function transformEdits(
	strokes: readonly InkStroke[],
	ids: readonly string[],
	t: TransformParams,
	dyOf: (stroke: InkStroke) => number,
	dxOf?: (stroke: InkStroke) => number
): TransformEdits {
	const wanted = new Set(ids);
	const strokeIds: string[] = [];
	const before: StrokeShape[] = [];
	const after: StrokeShape[] = [];
	for (const s of strokes) {
		if (!wanted.has(s.id)) continue;
		strokeIds.push(s.id);
		before.push(shapeOf(s));
		after.push(transformedShape(s, t, dyOf(s), dxOf ? dxOf(s) : 0));
	}
	return { strokeIds, before, after };
}

/**
 * The matrix the preview draws the gesture's picture through, in tail backing px: the picture holds the ink at the grab,
 * rastered at the camera `cam` with `k` backing px per world unit (zoom times backing), and this takes each of its pixels to
 * where `previewMatrix(t)` puts the world point under it. The camera is the one the picture was rastered at, so a camera
 * that moves makes a new picture and a new matrix, and the world numbers of the step never change.
 */
export function pictureMatrix(t: TransformParams, cam: CameraState, k: number): [number, number, number, number, number, number] {
	const [a, b, c, d, e, f] = previewMatrix(t);
	// backing = k * (M(world) - cam), world = backing / k + cam.
	const ex = k * (a * cam.x + c * cam.y + e - cam.x);
	const fy = k * (b * cam.x + d * cam.y + f - cam.y);
	return [a, b, c, d, ex, fy];
}

/** The part of a 2D context the handles draw with. */
export interface HandleContext {
	save(): void;
	restore(): void;
	beginPath(): void;
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
	arc(x: number, y: number, r: number, start: number, end: number): void;
	rect(x: number, y: number, w: number, h: number): void;
	fill(): void;
	stroke(): void;
	setLineDash(segments: number[]): void;
	fillStyle: string | CanvasGradient | CanvasPattern;
	strokeStyle: string | CanvasGradient | CanvasPattern;
	lineWidth: number;
}

/**
 * Draw the four corner squares and the rotate knob, with its stem from the box's top, in the selection box's css px frame
 * (the frame drawSelectionBox draws in): each at its handle's centre, the squares HANDLE_DRAW_PX screen px across at any
 * canvas zoom (`cssScale`, screen px per css px). During a resize or turn `t` is the step the preview shows and the handles
 * ride the frame it turns (framePoints); at rest it is the identity.
 */
export function drawTransformHandles(ctx: HandleContext, box: BBox, cam: CameraState, color: string, cssScale = 1, t: TransformParams = IDENTITY_TRANSFORM): void {
	const frame = framePoints(box, t, cam.zoom, cssScale), h = frame.handles, foot = frame.stemFoot;
	const sx = (p: Point2) => (p.x - cam.x) * cam.zoom;
	const sy = (p: Point2) => (p.y - cam.y) * cam.zoom;
	const side = HANDLE_DRAW_PX / cssScale, half = side / 2;
	ctx.save();
	ctx.setLineDash([]);
	ctx.lineWidth = 1.5;
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	const knob = h.rotate;
	ctx.beginPath();
	ctx.moveTo(sx(foot), sy(foot));
	ctx.lineTo(sx(knob), sy(knob));
	ctx.stroke();
	ctx.beginPath();
	ctx.arc(sx(knob), sy(knob), half, 0, Math.PI * 2);
	ctx.fill();
	ctx.beginPath();
	for (const id of ["nw", "ne", "se", "sw"] as const) ctx.rect(sx(h[id]) - half, sy(h[id]) - half, side, side);
	ctx.fill();
	ctx.restore();
}

/** The Attach button's drawn circle, css px across. */
export const ATTACH_BUTTON_DRAW_PX = 28;
/** A pen's or a mouse's hit square on the Attach button, css px: the drawn circle's own width. A finger's is HANDLE_TOUCH_PX. */
export const ATTACH_BUTTON_POINTER_PX = 28;
/** How far below the drawn box's bottom the Attach button's top sits, css px. */
export const ATTACH_BUTTON_GAP_PX = 12;

/**
 * The Attach button's centre, world units, at `zoom`: under the drawn box's bottom centre, ATTACH_BUTTON_GAP_PX screen px
 * clear of it at any canvas zoom (`cssScale`).
 */
export function attachButtonPoint(box: BBox, zoom: number, cssScale = 1): Point2 {
	const bottom = box.y + box.height + BOX_PAD_PX / zoom;
	return { x: box.x + box.width / 2, y: bottom + (ATTACH_BUTTON_GAP_PX + ATTACH_BUTTON_DRAW_PX / 2) / (zoom * cssScale) };
}

/** Whether `at` is on the Attach button: a square of the input's hit size round its centre. */
export function hitAttachButton(box: BBox, zoom: number, at: Point2, input: HandleInput, cssScale = 1): boolean {
	const half = (input === "touch" ? HANDLE_TOUCH_PX : ATTACH_BUTTON_POINTER_PX) / 2 / (zoom * cssScale);
	const p = attachButtonPoint(box, zoom, cssScale);
	return Math.abs(at.x - p.x) <= half && Math.abs(at.y - p.y) <= half;
}

/** What decides whether the Attach button shows: the selection's Attach and Detach states, what it holds, and the gesture. */
export interface AttachButtonState {
	attach: boolean;
	detach: boolean;
	kinds: { strokes: number; boxes: number; images: number };
	/** A loop is being drawn. */
	lassoActive: boolean;
	/** The selection is being moved, resized or turned. */
	moving: boolean;
}

/**
 * The button shows when the selection can attach or detach and holds strokes, and no loop, drag, resize or turn is under
 * way. A selection of text boxes or images alone has nothing to attach.
 */
export function attachButtonShown(s: AttachButtonState): boolean {
	return (s.attach || s.detach) && s.kinds.strokes > 0 && !s.lassoActive && !s.moving;
}

/** The colours the Attach button draws in. */
export interface AttachButtonColours {
	/** The fill when the selection is attached: the selection colour. */
	attached: string;
	/** The fill when the selection is loose: the theme's muted text colour. */
	loose: string;
	/** The page's background: the link mark on either fill. */
	background: string;
}

/**
 * Draw the Attach button in the selection box's css px frame: a circle ATTACH_BUTTON_DRAW_PX across at attachButtonPoint,
 * filled in the attached colour when the selection is attached, else in the loose colour, with a two-link mark inside in
 * the page's background. Solid lines whatever dash the box left.
 */
export function drawAttachButton(ctx: HandleContext, box: BBox, cam: CameraState, attached: boolean, colours: AttachButtonColours, cssScale = 1): void {
	const p = attachButtonPoint(box, cam.zoom, cssScale);
	// Sizes in screen px at any canvas zoom: one screen px is 1 / cssScale of this frame's px. Line widths stay as the box's.
	const u = 1 / cssScale;
	const x = (p.x - cam.x) * cam.zoom, y = (p.y - cam.y) * cam.zoom, r = (ATTACH_BUTTON_DRAW_PX / 2) * u;
	ctx.save();
	ctx.setLineDash([]);
	ctx.lineWidth = 1.5;
	const fill = attached ? colours.attached : colours.loose;
	ctx.fillStyle = fill;
	ctx.strokeStyle = fill;
	ctx.beginPath();
	ctx.arc(x, y, r - u, 0, Math.PI * 2);
	ctx.fill();
	ctx.stroke();
	ctx.strokeStyle = colours.background;
	ctx.lineWidth = 2;
	for (const dx of [-3, 3]) {
		ctx.beginPath();
		ctx.arc(x + dx * u, y, 4 * u, 0, Math.PI * 2);
		ctx.stroke();
	}
	ctx.restore();
}
