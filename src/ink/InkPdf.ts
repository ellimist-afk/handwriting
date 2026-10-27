/**
 * Ink as a PDF.
 *
 * Two consumers, one writer. A note's page export needs a PDF CREATED, and a
 * flattened annotated PDF needs ink APPENDED to pages that already exist. The
 * drawing is identical in both; only the document surgery differs, so the
 * content stream is built separately from the file around it.
 *
 * Why a PDF at all, when the ink already exports as SVG: it is the format
 * people ask for, and a PDF page may be any size up to 200 inches. So this
 * emits ONE page sized to the content instead of paginating - which is what
 * sidesteps both failures of printing through the reading view, where a fixed
 * page width clips ink beside the text column and page breaks cut the surface
 * into pieces.
 *
 * Two coordinate facts, both easy to get wrong and both fixed here:
 *
 * - PDF's origin is BOTTOM-left with y increasing upward; ink lives in note
 *   space, top-left with y down. One `cm` at the head of the stream flips it,
 *   so every coordinate after that is written unchanged.
 * - PDF measures in points (1/72"), CSS in pixels (1/96"). The page box is
 *   converted; the ink is not, because the page carries that scale itself.
 *
 * Pure string building over pure geometry, like SvgExport. No DOM, no fs.
 */

import { InkStroke } from "./Stroke";
import { HIGHLIGHTER_ALPHA } from "./PenStyle";
import { normalizeInkColor } from "./InkColor";
import { exportInkColor } from "./InkTheme";
import { Disc, Pt, strokeOutline } from "./StrokeOutline";

/** CSS pixels to PDF points: 96 dpi to 72 dpi. */
export const PX_TO_PT = 0.75;

/** Margin around the ink, in note px, so strokes are not flush to the edge. */
const MARGIN_PX = 12;

/**
 * Kappa: the cubic control-point offset that approximates a quarter circle to
 * about one part in 4000. PDF has no arc operator, so a disc is four beziers.
 */
const K = 0.5522847498307936;

/**
 * A PDF number literal. Never exponent notation: `1e-7` is a syntax error
 * inside a content stream rather than a small number, and a stream that fails
 * to parse renders as a blank page with no other complaint.
 */
export function pdfNum(v: number): string {
	const r = Math.round(v * 100) / 100;
	if (!Number.isFinite(r) || r === 0) return "0";
	const s = r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
	return s === "-0" ? "0" : s;
}

/**
 * A colour as PDF's `r g b` in 0..1, from a validated hex.
 *
 * `destination` is the colour of the page this ink is being written onto -
 * `#ffffff` for both consumers, since a created page is white and a flattened
 * one is a document page. Passing it is what makes near-white ink readable in
 * the file instead of invisible on it. Omit it and the stored colour is used,
 * which is what every existing caller and every geometry test wants.
 */
export function pdfColor(
	tool: InkStroke["tool"],
	hex: unknown,
	destination?: string | null
): string {
	const safe = exportInkColor(normalizeInkColor(tool, hex), destination, tool);
	const n = Number.parseInt(safe.slice(1), 16);
	return `${pdfNum(((n >> 16) & 0xff) / 255)} ${pdfNum(((n >> 8) & 0xff) / 255)} ${pdfNum((n & 0xff) / 255)}`;
}

/**
 * One disc as a closed sub-path of four beziers.
 *
 * `turn` is which way the stroke's outline goes, and the disc has to agree
 * with it. Nonzero winding ADDS the turns of every sub-path in a fill, so a
 * disc going the other way subtracts itself from the body it sits on and
 * leaves a hole - one per cap and joint. On a pen line that is a nicked edge;
 * on a highlighter, whose discs are wide, it is a row of bubbles.
 */
export function discOps(d: Disc, turn = 1): string {
	const { x, y, r } = d;
	const k = K * r;
	// Only the y offsets take the sign: mirroring the circle top to bottom is
	// what reverses the direction it is traced in.
	const kt = k * turn;
	const rt = r * turn;
	return (
		`${pdfNum(x + r)} ${pdfNum(y)} m ` +
		`${pdfNum(x + r)} ${pdfNum(y + kt)} ${pdfNum(x + k)} ${pdfNum(y + rt)} ${pdfNum(x)} ${pdfNum(y + rt)} c ` +
		`${pdfNum(x - k)} ${pdfNum(y + rt)} ${pdfNum(x - r)} ${pdfNum(y + kt)} ${pdfNum(x - r)} ${pdfNum(y)} c ` +
		`${pdfNum(x - r)} ${pdfNum(y - kt)} ${pdfNum(x - k)} ${pdfNum(y - rt)} ${pdfNum(x)} ${pdfNum(y - rt)} c ` +
		`${pdfNum(x + k)} ${pdfNum(y - rt)} ${pdfNum(x + r)} ${pdfNum(y - kt)} ${pdfNum(x + r)} ${pdfNum(y)} c h `
	);
}

/**
 * Which way the closed outline turns: left side forward, right side back.
 *
 * Only the SIGN is wanted. It is not a constant - a stroke drawn right to
 * left closes the other way round - so it is measured per stroke rather than
 * assumed, and the discs are pointed to match.
 */
function outlineTurn(left: readonly Pt[], right: readonly Pt[]): number {
	const n = left.length + right.length;
	if (n < 3) return 1;
	const at = (i: number): Pt => (i < left.length ? left[i]! : right[n - 1 - i]!);
	let twice = 0;
	for (let i = 0; i < n; i++) {
		const p = at(i);
		const q = at((i + 1) % n);
		twice += p.x * q.y - q.x * p.y;
	}
	return twice < 0 ? -1 : 1;
}

function polyOps(left: readonly Pt[], right: readonly Pt[]): string {
	if (left.length === 0) return "";
	let s = `${pdfNum(left[0]!.x)} ${pdfNum(left[0]!.y)} m `;
	for (let i = 1; i < left.length; i++) s += `${pdfNum(left[i]!.x)} ${pdfNum(left[i]!.y)} l `;
	for (let i = right.length - 1; i >= 0; i--) s += `${pdfNum(right[i]!.x)} ${pdfNum(right[i]!.y)} l `;
	return s + "h ";
}

/** One stroke's path operators - outline and discs, no colour and no fill. */
export function strokePdfOps(stroke: InkStroke): string {
	const o = strokeOutline(stroke);
	if (!o) return "";
	const turn = outlineTurn(o.left, o.right);
	return polyOps(o.left, o.right) + o.discs.map((d) => discOps(d, turn)).join("");
}

/**
 * Consecutive strokes of one colour, sharing one colour setting.
 *
 * CONSECUTIVE and not grouped by colour: strokes paint in the order they were
 * drawn, and gathering every red in a note into one fill would lift the early
 * reds above a blue drawn over them.
 *
 * A pen stroke is filled on its own. A run used to share one path and one
 * fill, and a viewer draws a fill as one path: a note of 4,851 pen strokes
 * became 23 paths of about 34,000 segments each, and Obsidian's PDF viewer
 * took 7 s to draw the page (0.2 s one fill per stroke). Opaque ink paints the
 * same pixels either way, but for the smoothing of an edge where two strokes of
 * one colour overlap. A highlighter run keeps its single fill: filled one by
 * one, two crossing strokes would double the wash.
 *
 * `f` is nonzero winding, which is what unions each outline with its discs -
 * see StrokeOutline for why that pairing is the shape.
 */
function runs(strokes: readonly InkStroke[], destination?: string | null): string {
	let out = "";
	let i = 0;
	while (i < strokes.length) {
		// Grouped on the colour actually WRITTEN, so two stored colours that
		// adapt to one value share one colour setting instead of emitting it twice.
		const color = pdfColor(strokes[i]!.tool, strokes[i]!.color, destination);
		let ops = "";
		// Highlighter paths waiting for the run's one fill.
		let open = false;
		while (
			i < strokes.length &&
			pdfColor(strokes[i]!.tool, strokes[i]!.color, destination) === color
		) {
			const one = strokePdfOps(strokes[i]!);
			if (one !== "") {
				const pen = strokes[i]!.tool !== "highlighter";
				ops += pen ? `${one}f ` : one;
				open = !pen;
			}
			i++;
		}
		if (ops !== "") out += `${color} rg ${ops}${open ? "f " : ""}`;
	}
	return out;
}

/**
 * Every stroke as one content stream, in layer order.
 *
 * Highlighter runs sit inside a `q ... Q` carrying the layer alpha, so a
 * crossing stays one flat wash instead of doubling into a dark seam - the
 * same single-pass rule the canvas layers use.
 */
export function inkPdfContent(
	strokes: readonly InkStroke[],
	heightPx: number,
	gsName = "GSa",
	destination?: string | null
): string {
	const hi = strokes.filter((s) => s.tool === "highlighter");
	const pen = strokes.filter((s) => s.tool !== "highlighter");
	// Flip once: PDF counts y upward from the bottom, ink counts it downward
	// from the top. Everything after this is written in note coordinates.
	let out = `q 1 0 0 -1 0 ${pdfNum(heightPx)} cm `;
	if (hi.length > 0) out += `q /${gsName} gs ${runs(hi, destination)}Q `;
	out += runs(pen, destination);
	return out + "Q";
}

/** Preserve the note origin unless negative ink requires an earlier page edge. */
function inkPageBounds(strokes: readonly InkStroke[]): { x: number; y: number; w: number; h: number } {
	let minX = 0, minY = 0;
	let maxX = -Infinity, maxY = -Infinity;
	for (const s of strokes) {
		if (s.points.length === 0) continue;
		if (s.bbox.x < 0) minX = Math.min(minX, Math.floor(s.bbox.x) - MARGIN_PX);
		if (s.bbox.y < 0) minY = Math.min(minY, Math.floor(s.bbox.y) - MARGIN_PX);
		maxX = Math.max(maxX, s.bbox.x + s.bbox.width);
		maxY = Math.max(maxY, s.bbox.y + s.bbox.height);
	}
	if (maxX === -Infinity) return { x: 0, y: 0, w: MARGIN_PX, h: MARGIN_PX };
	return { x: minX, y: minY, w: Math.ceil(maxX) - minX + MARGIN_PX, h: Math.ceil(maxY) - minY + MARGIN_PX };
}

/** The box every stroke fits inside, in note px, plus a margin. */
export function inkPageBox(strokes: readonly InkStroke[]): { w: number; h: number } {
	const { w, h } = inkPageBounds(strokes);
	return { w, h };
}

/** The largest page side, in default user-space units, that strict readers follow (PDF 1.7 implementation limit). */
export const MAX_PAGE_UNITS = 14400;

/**
 * The /UserUnit a page needs: 1 inside the limit, otherwise the smallest whole number that brings both sides inside.
 * A reader that ignores the key shows a smaller nominal page and loses nothing; the geometry is whole either way.
 */
export function pdfUserUnit(widthPx: number, heightPx: number): number {
	const longest = Math.max(widthPx, heightPx) * PX_TO_PT;
	return longest > MAX_PAGE_UNITS ? Math.ceil(longest / MAX_PAGE_UNITS) : 1;
}

/** A scale to eight places: `pdfNum` stops at two, which would turn 0.375 into 0.38 and stretch a long note by a percent. */
function pdfScale(v: number): string {
	return v.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * A one-page PDF around a content stream.
 *
 * Assembled rather than templated because the cross-reference table is a list
 * of BYTE OFFSETS: every object's position has to be measured as the file is
 * built, and a table that disagrees with the bytes by one byte produces a file
 * that some readers open and others reject. The offsets here are taken from
 * the string as it grows, never computed ahead of it.
 *
 * Everything written is ASCII, so a character is a byte and `length` is the
 * offset. Nothing user-authored reaches the document: colours are validated
 * hex and every other value is a formatted number.
 */
export function pdfDocument(widthPx: number, heightPx: number, content: string): string {
	const unit = pdfUserUnit(widthPx, heightPx);
	const wPt = pdfNum((widthPx * PX_TO_PT) / unit);
	const hPt = pdfNum((heightPx * PX_TO_PT) / unit);
	// The stream's flip is in px; the page box is in points. The page carries
	// the px-to-pt scale so the ink never has to know about units. Past the
	// page-size limit the box and the scale both shrink by the UserUnit.
	const scale = unit === 1 ? pdfNum(PX_TO_PT) : pdfScale(PX_TO_PT / unit);
	const body = `q ${scale} 0 0 ${scale} 0 0 cm ${content} Q`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}]${unit === 1 ? "" : ` /UserUnit ${unit}`}` +
			" /Contents 4 0 R /Resources << /ExtGState << /GSa 5 0 R >> >> >>",
		`<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
		`<< /Type /ExtGState /ca ${pdfNum(HIGHLIGHTER_ALPHA)} /CA ${pdfNum(HIGHLIGHTER_ALPHA)} >>`,
	];
	let out = "%PDF-1.7\n";
	const offsets: number[] = [];
	objects.forEach((obj, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
	});
	const startxref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
	return out;
}

/**
 * The colour a PDF page is when nothing paints one.
 *
 * This module writes no background - there is no `rg`+`re`+`f` covering the
 * media box anywhere in it - and a PDF page with no painted background is
 * white in every reader. So the destination is not a guess here the way it is
 * for an SVG: it is what the file will look like.
 */
export const PDF_PAGE_WHITE = "#ffffff";

/**
 * The page colour assumed when the user says their PDF pages are DARK.
 *
 * `#2d2d2d` and deliberately NOT `#000000`, which is the worst available
 * choice and was measured before this constant was picked. Contrast is
 * compressed at the dark end - `(L + 0.05) / 0.05` - so ink lightened just
 * enough to clear 3:1 against pure black lands at luminance 0.1 and then
 * FAILS on a `#1a1a1a` page (2.53:1), which is what a dark-mode export
 * actually looks like. Assuming black served 1 of 6 sampled dark pages;
 * `#2d2d2d` serves 4, spanning every realistic dark page (#121212, #1a1a1a,
 * #1e1e1e, #212121, #2d2d2d) and clearing 3:1 at BOTH ends of that range
 * (4.67:1 on black, 3.06:1 on #2d2d2d itself).
 *
 * The principle, and it is the same one that makes white right on the other
 * side: assume the LIGHTEST page in the range the user just declared dark,
 * because that is the worst case for a lightening adjustment - exactly as
 * white is the worst case for a darkening one.
 */
export const PDF_PAGE_DARK = "#2d2d2d";

/**
 * What the user says the pages they write on look like.
 *
 * The code cannot see them - `InkPdfAppend` reads a page dictionary, never
 * pixels - and a boolean could only offer "guess white" or "guess nothing",
 * neither of which is "the page is dark". Alan asked for the third state
 * himself after finding black ink invisible on a dark page.
 */
export type PdfPageAssumption = "darken" | "lighten" | "keep";

/**
 * The destination to adapt against for an assumption, or `null` to adapt at
 * all - `exportInkColor` returns its input unchanged for `null`.
 *
 * Anything unrecognised is `"darken"`, which is the shipped default: a value
 * this does not know is a value from a newer version or a hand-edited config,
 * and the safe answer is the one almost every page wants.
 */
export function pdfPageDestination(assumption: PdfPageAssumption): string | null {
	if (assumption === "keep") return null;
	return assumption === "lighten" ? PDF_PAGE_DARK : PDF_PAGE_WHITE;
}

/** Coerce stored or user input to an assumption; anything unknown is `darken`. */
export function normalizePdfPageAssumption(raw: unknown): PdfPageAssumption {
	return raw === "lighten" || raw === "keep" ? raw : "darken";
}

/**
 * A note's ink as a standalone one-page PDF, sized to the ink.
 *
 * Destination defaults to the page's own white, which is the whole point of
 * the slice: this is the command the Reddit complaint used, and near-white
 * ink written on a dark theme arrived invisible on it.
 */
export function inkToPdf(
	strokes: readonly InkStroke[],
	destination: string | null = PDF_PAGE_WHITE
): string {
	const inked = strokes.filter((s) => s.points.length > 0);
	if (inked.length === 0) return "";
	const { x, y, w, h } = inkPageBounds(inked);
	const content = inkPdfContent(inked, h, "GSa", destination);
	// Translation is in PDF's y-up space, outside the existing content flip.
	// Keep positive-only documents byte-identical and appended PDF ink untouched.
	return pdfDocument(w, h, x === 0 && y === 0 ? content :
		`q 1 0 0 1 ${pdfNum(-x)} ${pdfNum(y)} cm ${content} Q`);
}
