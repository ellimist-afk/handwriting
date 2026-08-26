/**
 * Ink to SVG (roadmap: export/print ink).
 *
 * Until now ink had no existence outside the plugin: copy the .md anywhere
 * and the page is silently blank. This gives the ink a portable form. The
 * geometry is EXACTLY the committed layer's: the same flatten (shaped for
 * pen, flat for highlighter, mirroring drawStroke's style choices), the same
 * ribbonSides offsets, the same caps and joint discs - so the export looks
 * like the note, and improvements to the renderer reach the exporter for
 * free. Coordinates are world units (note-space CSS px at zoom 1); the
 * viewBox is the ink's bounding box plus a margin, so the file opens at the
 * size of what was written, wherever it lands.
 *
 * Highlighter strokes ride in a group with the layer's opacity, matching
 * the single-pass translucency rule from styles.css (painting each stroke
 * translucent would double-blend every overlap into a dark seam).
 *
 * Pure string building over pure geometry: no DOM, loads under vitest.
 */

import { flattenStroke } from "./Ribbon";
import { ribbonSides, jointIndices, RibbonPt } from "./Ribbon";
import { flattenStrokeShaped, inkShapingEnabled } from "./InkShape";
import { HIGHLIGHTER_ALPHA, PenStyle } from "./PenStyle";
import { InkStroke } from "./Stroke";

/** Density for curve flattening: world px are CSS px, 2 samples per px. */
const EXPORT_PX_PER_WORLD = 2;
const MARGIN_WORLD = 12;

const num = (v: number) => (Math.round(v * 100) / 100).toString();

/** One stroke's ribbon outline plus its cap/joint discs, as SVG elements. */
export function strokeToSvg(stroke: InkStroke): string {
	const pts = stroke.points;
	if (pts.length === 0) return "";
	const flat = stroke.tool === "highlighter";
	// drawStroke's exact style derivation, so the widths match the note.
	const style: PenStyle = {
		color: stroke.color,
		baseWidth: stroke.width,
		minWidthFactor: flat ? 0.9 : 0.35,
		gamma: flat ? 1 : 0.75,
	};
	const ribbon =
		!flat && stroke.device !== "mouse" && inkShapingEnabled()
			? flattenStrokeShaped(pts, style, EXPORT_PX_PER_WORLD)
			: flattenStroke(pts, style, EXPORT_PX_PER_WORLD);
	if (ribbon.length === 0) return "";
	const circle = (p: RibbonPt) =>
		`<circle cx="${num(p.x)}" cy="${num(p.y)}" r="${num(Math.max(0.125, p.hw))}"/>`;
	if (ribbon.length === 1) {
		return `<g fill="${stroke.color}">${circle(ribbon[0]!)}</g>`;
	}
	const { left, right } = ribbonSides(ribbon);
	let d = `M ${num(left[0]!.x)} ${num(left[0]!.y)}`;
	for (let i = 1; i < left.length; i++) d += ` L ${num(left[i]!.x)} ${num(left[i]!.y)}`;
	for (let i = right.length - 1; i >= 0; i--) d += ` L ${num(right[i]!.x)} ${num(right[i]!.y)}`;
	d += " Z";
	const discs = [
		circle(ribbon[0]!),
		circle(ribbon[ribbon.length - 1]!),
		...jointIndices(ribbon).map((i) => circle(ribbon[i]!)),
	].join("");
	// fill-rule nonzero unions the outline with its discs; the outline may
	// self-intersect inside tight turns, and the discs fill those pinches the
	// same way fillRibbon's do.
	return `<g fill="${stroke.color}" fill-rule="nonzero"><path d="${d}"/>${discs}</g>`;
}

/**
 * A whole note's ink as one standalone SVG document. Highlighter strokes are
 * painted FIRST (under the pen, matching the layer order) inside one group
 * carrying the layer opacity.
 */
export function inkToSvg(strokes: readonly InkStroke[]): string {
	const inked = strokes.filter((s) => s.points.length > 0);
	if (inked.length === 0) return "";
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const s of inked) {
		x0 = Math.min(x0, s.bbox.x);
		y0 = Math.min(y0, s.bbox.y);
		x1 = Math.max(x1, s.bbox.x + s.bbox.width);
		y1 = Math.max(y1, s.bbox.y + s.bbox.height);
	}
	x0 -= MARGIN_WORLD;
	y0 -= MARGIN_WORLD;
	x1 += MARGIN_WORLD;
	y1 += MARGIN_WORLD;
	const hi = inked.filter((s) => s.tool === "highlighter").map(strokeToSvg).join("");
	const pen = inked.filter((s) => s.tool !== "highlighter").map(strokeToSvg).join("");
	const body = (hi ? `<g opacity="${HIGHLIGHTER_ALPHA}">${hi}</g>` : "") + pen;
	const w = num(x1 - x0);
	const h = num(y1 - y0);
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(x0)} ${num(y0)} ${w} ${h}"` +
		` width="${w}" height="${h}">${body}</svg>`
	);
}
