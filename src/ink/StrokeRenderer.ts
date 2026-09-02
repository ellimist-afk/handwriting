import { CameraState } from "../camera/coordinates";
import {
	PenStyle,
	pressureSensitivityEnabled,
	shapeFor,
	widthForPressure,
} from "./PenStyle";
import { SmoothSegment } from "./Smoothing";
import { flattenStroke, RibbonPt } from "./Ribbon";
import { centerlineSmoothed, flattenStrokeShaped, inkShapingEnabled } from "./InkShape";
import { fillRibbon } from "./RibbonRenderer";
import { InkPoint, InkStroke } from "./Stroke";
import { strokeRev } from "./StrokeRev";

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
 * The ribbon cache: flattened committed geometry, remembered per stroke.
 *
 * The cause it removes: `drawStroke` re-flattened EVERY stroke on EVERY
 * repaint. A committed layer redraws in full on any camera change, so
 * scrolling a 3,000-stroke note ran 3,000 smoothing-plus-subdivision passes
 * per frame to produce, frame after frame, byte-identical geometry. The
 * flatten is the expensive half of the draw; `fillRibbon` is not.
 *
 * The trap the key is shaped around: committed strokes are MUTATED IN PLACE
 * (`translateStroke`, objects/Selection.ts - the lasso drag, the
 * insert-space drag and the undo/redo of both). Object identity alone would
 * therefore hand back geometry computed at the OLD position and the ink would
 * render where it was, which is why the entry carries a revision from
 * StrokeRev and a hit demands it match. Zoom is compared EXACTLY - the number
 * the flatten actually received - because it feeds the subdivision count, and
 * a rounded compare would serve coarse geometry at a finer zoom. Shaping is
 * the effective decision (InkShape's global toggle, the highlighter's flat
 * wash and the mouse law folded together), since flipping it changes the
 * half-width law. `smooth` is the CENTERLINE decision and is carried
 * separately because the two can disagree: a mouse stroke is never shaped, so
 * its `shaping` is false in both settings while its centerline still follows
 * the toggle - keyed on `shaping` alone, toggling the setting would have
 * served that stroke its stale ribbon forever.
 *
 * `pressure` is `pressureSensitivityEnabled()`, which `widthForPressure`
 * substitutes at EVERY sample and which neither `shaping` nor `smooth`
 * implies: it is its own setting with its own command, and both writers
 * (`applyPressureSensitivity` and the settings tab) repaint by calling
 * `repaintAllInkOverlays`, which found rev, zoom, shaping and smooth all
 * unchanged and handed back the ribbon built under the OTHER width law. A
 * page could show two, whichever strokes happened to be cached. `tool` is
 * here for completeness of the derivation - it decides `flat`, which decides
 * both `shaping` and `smooth` - and costs a comparison; no in-place tool
 * mutation exists today, so it is a guard and not a fix.
 *
 * Memory: a WeakMap holds nothing alive, so the cache is bounded by the
 * strokes the stores already hold. Ribbons for strokes scrolled far out of
 * view do stay resident until the stroke itself is collected - accepted: a
 * ribbon is a flat array of {x, y, hw}, and evicting by viewport would mean
 * re-flattening exactly the strokes a scroll is about to bring back.
 *
 * Pinch zoom misses on every frame by construction (the zoom changes), which
 * costs what today costs and no more.
 */
interface RibbonEntry {
	rev: number;
	zoom: number;
	shaping: boolean;
	smooth: boolean;
	pressure: boolean;
	tool: InkStroke["tool"];
	ribbon: RibbonPt[];
}

const ribbonCache = new WeakMap<InkStroke, RibbonEntry>();

let cacheHits = 0;
let cacheMisses = 0;
let flattens = 0;

/**
 * Repaint counters for the diagnostics dump. `flattens` counts every flatten
 * this module ran, cached path or not, and is the seam the cache tests
 * measure; `hits`/`misses` describe the cache alone.
 */
export function ribbonCacheStats(): { hits: number; misses: number; flattens: number } {
	return { hits: cacheHits, misses: cacheMisses, flattens };
}

/** Zero the counters. For tests and for a fresh diagnostics session. */
export function resetRibbonCacheStats(): void {
	cacheHits = 0;
	cacheMisses = 0;
	flattens = 0;
}

function flattenFor(
	pts: readonly InkPoint[],
	style: PenStyle,
	zoom: number,
	shaping: boolean,
	smooth: boolean
): RibbonPt[] {
	flattens++;
	// Shaping implies the smoothed centerline: the shaped width law is
	// computed per sample and interpolated ALONG the quadratic segments, so
	// there is no raw variant of it and none is wanted - the setting that
	// turns the centerline raw is the same setting that turns shaping off.
	return shaping
		? flattenStrokeShaped(pts, style, zoom)
		: flattenStroke(pts, style, zoom, smooth);
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

/**
 * Redraw a full committed stroke (world space -> current camera).
 *
 * `cacheRibbon` is how a caller says "this object is not a committed stroke":
 * the wet stroke is rebuilt from a growing point list on every frame, so it
 * has nothing to reuse and no business holding an entry. Only src/site's demo
 * passes a wet stroke here at all - every real surface draws its wet layer
 * through WetInkRenderer's per-segment path - and it passes false. A
 * `styleOverride` also bypasses the cache: the override changes the width law
 * the ribbon is flattened under, and it is not part of the key (PenLabView is
 * the only caller that passes one).
 *
 * `ribbon` was called `smooth` until 1.4.6 and never meant smoothing. It
 * selects the RENDERING: the one-fill ribbon outline (true) or the legacy
 * chain of separately stroked capsules (false, and why Ribbon.ts exists).
 * Every surface passes true; only PenLabView's Raw/Smoothed mode buttons pass
 * false, and they pass it to WetInkRenderer.smooth for the same axis. The
 * name is the whole reason this slice had to look twice: "Ink smoothing" in
 * settings, `smooth` here and `smoothSegments` in Smoothing.ts named three
 * different things, and the one the setting claimed to control - the
 * centerline - was the one with no switch at all. The centerline decision is
 * now read from `centerlineSmoothed` and nowhere else, so a caller cannot
 * override the user's setting with a literal.
 */
export function drawStroke(
	ctx: CanvasRenderingContext2D,
	cam: CameraState,
	stroke: InkStroke,
	styleOverride?: Partial<PenStyle>,
	ribbon = false,
	cacheRibbon = true
): void {
	const pts = stroke.points;
	if (pts.length < 2) return;
	// A stroke describes its own pressure response through its tool, so it looks
	// right on any layer without the caller having to remember which it was.
	const flat = stroke.tool === "highlighter";
	const style: PenStyle = {
		color: stroke.color,
		baseWidth: stroke.width,
		minWidthFactor: styleOverride?.minWidthFactor ?? shapeFor(flat).minWidthFactor,
		gamma: styleOverride?.gamma ?? shapeFor(flat).gamma,
	};
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.strokeStyle = strokeStyleFor(stroke);
	if (ribbon) {
		// One path, one fill, one antialiased edge. See Ribbon.ts for why
		// per-segment stroking looks beaded when magnified. Pen strokes take
		// the shaped geometry (InkShape) unless shaping is switched off; the
		// highlighter's flat chisel wash never shapes.
		// Mouse strokes take the flat law: no pressure, and velocity says
		// nothing about intent (see InkStroke.device).
		const shaping = !flat && stroke.device !== "mouse" && inkShapingEnabled();
		// The centerline follows the setting even where the width law does
		// not. A mouse stroke is unshaped in both settings but still smoothed
		// when smoothing is on, and the highlighter is smoothed in both.
		const smooth = centerlineSmoothed(flat);
		// A raw centerline is offset per segment and joined with discs. The
		// shared per-point normal `ribbonSides` uses is the angle bisector
		// only where sample spacing is even, which is true of the smoothed
		// path (subdivision re-spaces it) and false of the samples
		// themselves - see fillRibbon's header for what that does to the
		// edge. Shaping implies a smoothed centerline, so this is exactly
		// the setting-off pen and nothing else.
		const perSegment = !smooth;
		if (!cacheRibbon || styleOverride !== undefined) {
			fillRibbon(
				ctx,
				cam,
				flattenFor(pts, style, cam.zoom, shaping, smooth),
				strokeStyleFor(stroke),
				perSegment
			);
			return;
		}
		const rev = strokeRev(stroke);
		const pressure = pressureSensitivityEnabled();
		const hit = ribbonCache.get(stroke);
		if (
			hit !== undefined &&
			hit.rev === rev &&
			hit.zoom === cam.zoom &&
			hit.shaping === shaping &&
			hit.smooth === smooth &&
			hit.pressure === pressure &&
			hit.tool === stroke.tool
		) {
			cacheHits++;
			fillRibbon(ctx, cam, hit.ribbon, strokeStyleFor(stroke), perSegment);
			return;
		}
		cacheMisses++;
		const pts2 = flattenFor(pts, style, cam.zoom, shaping, smooth);
		ribbonCache.set(stroke, {
			rev,
			zoom: cam.zoom,
			shaping,
			smooth,
			pressure,
			tool: stroke.tool,
			ribbon: pts2,
		});
		fillRibbon(ctx, cam, pts2, strokeStyleFor(stroke), perSegment);
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
/**
 * Redraw one world-space rect of a committed layer in place: clip, clear,
 * draw the given strokes (pre-queried by the caller's spatial index). The
 * damage-repaint path (renderer debt, 2026-08-27) - the full-viewport
 * clear-and-redraw lives on in drawCommitted for the "all" cases.
 */
export function drawRegion(
	ctx: CanvasRenderingContext2D,
	cam: CameraState,
	strokes: readonly InkStroke[],
	rect: { x: number; y: number; width: number; height: number },
	ribbon = false,
	tool?: InkStroke["tool"]
): void {
	const cssX = (rect.x - cam.x) * cam.zoom;
	const cssY = (rect.y - cam.y) * cam.zoom;
	const cssW = rect.width * cam.zoom;
	const cssH = rect.height * cam.zoom;
	ctx.save();
	ctx.beginPath();
	ctx.rect(cssX, cssY, cssW, cssH);
	ctx.clip();
	ctx.clearRect(cssX, cssY, cssW, cssH);
	for (const s of strokes) {
		if (tool !== undefined && s.tool !== tool) continue;
		drawStroke(ctx, cam, s, undefined, ribbon);
	}
	ctx.restore();
}

export function drawCommitted(
	ctx: CanvasRenderingContext2D,
	cam: CameraState,
	strokes: readonly InkStroke[],
	viewportCssWidth: number,
	viewportCssHeight: number,
	ribbon = false,
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
		drawStroke(ctx, cam, s, undefined, ribbon);
	}
}
