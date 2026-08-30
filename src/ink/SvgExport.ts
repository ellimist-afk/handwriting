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

import { ribbonSides, jointIndices, RibbonPt } from "./Ribbon";
import { HIGHLIGHTER_ALPHA } from "./PenStyle";
import { InkStroke } from "./Stroke";
import { normalizeInkColor } from "./InkColor";
import { ribbonOf } from "./StrokeOutline";

const MARGIN_WORLD = 12;

const num = (v: number) => (Math.round(v * 100) / 100).toString();

/** A cap or joint disc as PATH DATA: two arcs, so it needs no element. */
function discData(p: RibbonPt): string {
	const r = Math.max(0.125, p.hw);
	return (
		`M ${num(p.x - r)} ${num(p.y)}` +
		` a ${num(r)} ${num(r)} 0 1 0 ${num(r * 2)} 0` +
		` a ${num(r)} ${num(r)} 0 1 0 ${num(-r * 2)} 0 Z`
	);
}

/**
 * One stroke's whole geometry as path data - outline and discs together, no
 * elements of its own.
 *
 * This is what lets many strokes share a single `<path>`. Emitting a group,
 * a path and a circle per cap and joint costs thousands of DOM nodes on a
 * heavy note, which is fine in a file and not fine in a live document.
 */
export function strokePathData(stroke: InkStroke): string {
	const ribbon = ribbonOf(stroke);
	if (ribbon.length === 0) return "";
	if (ribbon.length === 1) return discData(ribbon[0]!);
	const { left, right } = ribbonSides(ribbon);
	let d = `M ${num(left[0]!.x)} ${num(left[0]!.y)}`;
	for (let i = 1; i < left.length; i++) d += ` L ${num(left[i]!.x)} ${num(left[i]!.y)}`;
	for (let i = right.length - 1; i >= 0; i--) d += ` L ${num(right[i]!.x)} ${num(right[i]!.y)}`;
	d += " Z";
	return (
		d +
		discData(ribbon[0]!) +
		discData(ribbon[ribbon.length - 1]!) +
		jointIndices(ribbon).map((i) => discData(ribbon[i]!)).join("")
	);
}

/** One stroke's ribbon outline plus its cap/joint discs, as SVG elements. */
export function strokeToSvg(stroke: InkStroke): string {
	// Sanitized, not trusted. A stroke's colour is whatever the sidecar JSON
	// said, and this string is interpolated into markup - written to a file
	// that a browser will open, and (since the rendered layer became vector)
	// inserted into the live DOM. `normalizeInkColor` answers with a hex from
	// the palette or a hex that matched the pattern, and nothing else.
	const color = normalizeInkColor(stroke.tool, stroke.color);
	const ribbon = ribbonOf(stroke);
	if (ribbon.length === 0) return "";
	const circle = (p: RibbonPt) =>
		`<circle cx="${num(p.x)}" cy="${num(p.y)}" r="${num(Math.max(0.125, p.hw))}"/>`;
	if (ribbon.length === 1) {
		return `<g fill="${color}">${circle(ribbon[0]!)}</g>`;
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
	return `<g fill="${color}" fill-rule="nonzero"><path d="${d}"/>${discs}</g>`;
}

/**
 * Every stroke as SVG elements, in layer order: highlighter first and inside
 * one group carrying the layer opacity (painting each stroke translucent
 * would double-blend every overlap into a dark seam), then pen above it.
 *
 * Coordinates are note space, untranslated, so a viewBox anchored at the
 * origin puts the ink exactly where the note put it.
 */
export function inkSvgBody(strokes: readonly InkStroke[]): string {
	const hi = runMarkup(inkSvgRuns(strokes.filter((s) => s.tool === "highlighter")));
	const pen = runMarkup(inkSvgRuns(strokes.filter((s) => s.tool !== "highlighter")));
	return (hi ? `<g opacity="${HIGHLIGHTER_ALPHA}">${hi}</g>` : "") + pen;
}

/** One merged path: the fill colour and the path data, without markup. */
export interface InkSvgRun {
	color: string;
	d: string;
}

/**
 * The same runs inkSvgBody would render, handed over as data.
 *
 * A caller painting into a LIVE document builds elements from these
 * (createElementNS + setAttribute). Writing the markup into a live element
 * would do the same thing, and the community review flags that on sight,
 * safe content or not - so the string form stays for the .svg file export,
 * where it is a file write.
 */
export function inkSvgLayers(strokes: readonly InkStroke[]): {
	highlighter: InkSvgRun[];
	pen: InkSvgRun[];
} {
	return {
		highlighter: inkSvgRuns(strokes.filter((s) => s.tool === "highlighter")),
		pen: inkSvgRuns(strokes.filter((s) => s.tool !== "highlighter")),
	};
}

function runMarkup(runs: readonly InkSvgRun[]): string {
	let out = "";
	for (const r of runs) out += `<path fill="${r.color}" fill-rule="nonzero" d="${r.d}"/>`;
	return out;
}

/**
 * Consecutive strokes of one colour, collapsed into a single `<path>`.
 *
 * A heavy note is a few hundred strokes, and a group-plus-path-plus-discs per
 * stroke is thousands of DOM nodes for a document to lay out. Folded this way
 * a page written in one colour is ONE element, and the cost stops scaling
 * with how much you wrote.
 *
 * CONSECUTIVE, not grouped by colour: strokes paint in the order they were
 * drawn, and gathering every red in the note into one path would lift the
 * early reds above a blue that was drawn over them. A run breaks whenever the
 * colour changes, so z-order is preserved exactly and the worst case - every
 * stroke a different colour - is simply what we had before.
 *
 * `fill-rule: nonzero` unions the sub-paths, so strokes that overlap inside a
 * run merge instead of cancelling. That is also what the highlighter layer
 * wants: one flat wash rather than a dark seam at every crossing.
 */
function inkSvgRuns(strokes: readonly InkStroke[]): InkSvgRun[] {
	const out: InkSvgRun[] = [];
	let i = 0;
	while (i < strokes.length) {
		const color = normalizeInkColor(strokes[i]!.tool, strokes[i]!.color);
		let d = "";
		while (i < strokes.length && normalizeInkColor(strokes[i]!.tool, strokes[i]!.color) === color) {
			d += strokePathData(strokes[i]!);
			i++;
		}
		if (d !== "") out.push({ color, d });
	}
	return out;
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
	const body = inkSvgBody(inked);
	const w = num(x1 - x0);
	const h = num(y1 - y0);
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(x0)} ${num(y0)} ${w} ${h}"` +
		` width="${w}" height="${h}">${body}</svg>`
	);
}
