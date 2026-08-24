import { CameraState } from "../camera/coordinates";
import { PenStyle, widthForPressure } from "./PenStyle";
import { SmoothSegment } from "./Smoothing";
import { flattenStroke } from "./Ribbon";
import { flattenStrokeShaped, inkShapingEnabled } from "./InkShape";
import { fillRibbon } from "./RibbonRenderer";
import { InkPoint, InkStroke } from "./Stroke";

/**
 * Segment-based variable-width polyline rendering, shared by the wet layer
 * (incremental, screen-space) and the committed layer (full redraw on camera
 * change). The committed path is the ribbon outline from Ribbon.ts; the
 * incremental wet path is per-segment with round caps and joins.
 */

function strokeStyleFor(stroke: { color: string }): string {
	return stroke.color;
}

/**
 * Draw one segment between two world-space points onto a 2d context whose
 * transform is already set to identity in CSS pixels (dpr handled by caller
 * via ctx.scale).
 */
export function drawSegment(
	ctx: CanvasRenderingContext2D,
	cam: CameraState,
	style: PenStyle,
	from: InkPoint,
	to: InkPoint
): void {
	const x1 = (from.x - cam.x) * cam.zoom;
	const y1 = (from.y - cam.y) * cam.zoom;
	const x2 = (to.x - cam.x) * cam.zoom;
	const y2 = (to.y - cam.y) * cam.zoom;
	// Average the two samples' pressures for the segment width.
	const wWorld = widthForPressure(style, (from.pressure + to.pressure) / 2);
	ctx.strokeStyle = style.color;
	ctx.lineWidth = Math.max(0.5, wWorld * cam.zoom);
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.stroke();
}

/**
 * Draw one smoothed segment: a quadratic that bends around a real sample.
 * Same width law as drawSegment, so Raw and Smoothed differ only in geometry.
 */
export function drawSmoothSegment(
	ctx: CanvasRenderingContext2D,
	cam: CameraState,
	style: PenStyle,
	seg: SmoothSegment
): void {
	const sx = (seg.from.x - cam.x) * cam.zoom;
	const sy = (seg.from.y - cam.y) * cam.zoom;
	const cx = (seg.ctrl.x - cam.x) * cam.zoom;
	const cy = (seg.ctrl.y - cam.y) * cam.zoom;
	const ex = (seg.to.x - cam.x) * cam.zoom;
	const ey = (seg.to.y - cam.y) * cam.zoom;
	ctx.strokeStyle = style.color;
	ctx.lineWidth = Math.max(0.5, widthForPressure(style, seg.pressure) * cam.zoom);
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.beginPath();
	ctx.moveTo(sx, sy);
	ctx.quadraticCurveTo(cx, cy, ex, ey);
	ctx.stroke();
}

/** Redraw a full committed stroke (world space -> current camera). */
export function drawStroke(
	ctx: CanvasRenderingContext2D,
	cam: CameraState,
	stroke: InkStroke,
	styleOverride?: Partial<PenStyle>,
	smooth = false
): void {
	const pts = stroke.points;
	if (pts.length < 2) return;
	// A stroke describes its own pressure response through its tool, so it looks
	// right on any layer without the caller having to remember which it was.
	const flat = stroke.tool === "highlighter";
	const style: PenStyle = {
		color: stroke.color,
		baseWidth: stroke.width,
		minWidthFactor: styleOverride?.minWidthFactor ?? (flat ? 0.9 : 0.35),
		gamma: styleOverride?.gamma ?? (flat ? 1 : 0.75),
	};
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.strokeStyle = strokeStyleFor(stroke);
	if (smooth) {
		// One path, one fill, one antialiased edge. See Ribbon.ts for why
		// per-segment stroking looks beaded when magnified. Pen strokes take
		// the shaped geometry (InkShape) unless shaping is switched off; the
		// highlighter's flat chisel wash never shapes.
		const ribbon =
			!flat && inkShapingEnabled()
				? flattenStrokeShaped(pts, style, cam.zoom)
				: flattenStroke(pts, style, cam.zoom);
		fillRibbon(ctx, cam, ribbon, strokeStyleFor(stroke));
		return;
	}
	for (let i = 1; i < pts.length; i++) {
		drawSegment(ctx, cam, style, pts[i - 1]!, pts[i]!);
	}
}

/**
 * Redraw all committed strokes visible in the current viewport.
 * Strokes fully outside the viewport are skipped via their bbox.
 */
export function drawCommitted(
	ctx: CanvasRenderingContext2D,
	cam: CameraState,
	strokes: readonly InkStroke[],
	viewportCssWidth: number,
	viewportCssHeight: number,
	smooth = false,
	tool?: InkStroke["tool"]
): void {
	ctx.clearRect(0, 0, viewportCssWidth, viewportCssHeight);
	const worldLeft = cam.x;
	const worldTop = cam.y;
	const worldRight = cam.x + viewportCssWidth / cam.zoom;
	const worldBottom = cam.y + viewportCssHeight / cam.zoom;
	for (const s of strokes) {
		// Pen and highlighter live on separate canvases (§6): highlighter under
		// the text, pen over it.
		if (tool !== undefined && s.tool !== tool) continue;
		const b = s.bbox;
		if (
			b.x > worldRight ||
			b.y > worldBottom ||
			b.x + b.width < worldLeft ||
			b.y + b.height < worldTop
		) {
			continue;
		}
		drawStroke(ctx, cam, s, undefined, smooth);
	}
}
