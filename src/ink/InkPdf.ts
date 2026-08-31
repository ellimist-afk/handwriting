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
function num(v: number): string {
	const r = Math.round(v * 100) / 100;
	if (!Number.isFinite(r) || r === 0) return "0";
	const s = r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
	return s === "-0" ? "0" : s;
}

/** A colour as PDF's `r g b` in 0..1, from a validated hex. */
export function pdfColor(tool: InkStroke["tool"], hex: unknown): string {
	const safe = normalizeInkColor(tool, hex);
	const n = Number.parseInt(safe.slice(1), 16);
	return `${num(((n >> 16) & 0xff) / 255)} ${num(((n >> 8) & 0xff) / 255)} ${num((n & 0xff) / 255)}`;
}

/**
 * One disc as a closed sub-path of four beziers.
 *
 * KNOWN BUG, and deliberately not fixed here. This traces every disc the same
 * way regardless of which way its stroke's outline turns. Nonzero winding ADDS
 * the turns of every sub-path in a fill, so a disc going the other way
 * subtracts itself from the body it sits on and leaves a hole - one per cap
 * and joint, a nicked edge on a pen line and a row of bubbles on a
 * highlighter, whose discs are wide.
 *
 * It has never been visible because nothing on this line calls it: there is no
 * PDF export command here, only `export-ink-svg`, and this file is unreachable
 * and tree-shaken out of the bundle. It was found on the pdf branch, where
 * ink is genuinely written into documents, by rendering 61 real PDFs.
 *
 * The fix is dc01602 on rc4: measure the outline's turn per stroke - a stroke
 * drawn right to left closes the other way, so it cannot be assumed - and
 * mirror the disc's y offsets to match. Take it from there rather than
 * rewriting it, and take its tests with it. If you are here because you are
 * wiring PDF export on this line, this is the thing that would have shipped
 * holes.
 */
export function discOps(d: Disc): string {
	const { x, y, r } = d;
	const k = K * r;
	return (
		`${num(x + r)} ${num(y)} m ` +
		`${num(x + r)} ${num(y + k)} ${num(x + k)} ${num(y + r)} ${num(x)} ${num(y + r)} c ` +
		`${num(x - k)} ${num(y + r)} ${num(x - r)} ${num(y + k)} ${num(x - r)} ${num(y)} c ` +
		`${num(x - r)} ${num(y - k)} ${num(x - k)} ${num(y - r)} ${num(x)} ${num(y - r)} c ` +
		`${num(x + k)} ${num(y - r)} ${num(x + r)} ${num(y - k)} ${num(x + r)} ${num(y)} c h `
	);
}

function polyOps(left: readonly Pt[], right: readonly Pt[]): string {
	if (left.length === 0) return "";
	let s = `${num(left[0]!.x)} ${num(left[0]!.y)} m `;
	for (let i = 1; i < left.length; i++) s += `${num(left[i]!.x)} ${num(left[i]!.y)} l `;
	for (let i = right.length - 1; i >= 0; i--) s += `${num(right[i]!.x)} ${num(right[i]!.y)} l `;
	return s + "h ";
}

/** One stroke's path operators - outline and discs, no colour and no fill. */
export function strokePdfOps(stroke: InkStroke): string {
	const o = strokeOutline(stroke);
	if (!o) return "";
	return polyOps(o.left, o.right) + o.discs.map(discOps).join("");
}

/**
 * Consecutive strokes of one colour, sharing a path and a single fill.
 *
 * CONSECUTIVE and not grouped by colour: strokes paint in the order they were
 * drawn, and gathering every red in a note into one fill would lift the early
 * reds above a blue drawn over them.
 *
 * `f` is nonzero winding, which is what unions each outline with its discs -
 * see StrokeOutline for why that pairing is the shape.
 */
function runs(strokes: readonly InkStroke[]): string {
	let out = "";
	let i = 0;
	while (i < strokes.length) {
		const color = pdfColor(strokes[i]!.tool, strokes[i]!.color);
		let ops = "";
		while (i < strokes.length && pdfColor(strokes[i]!.tool, strokes[i]!.color) === color) {
			ops += strokePdfOps(strokes[i]!);
			i++;
		}
		if (ops !== "") out += `${color} rg ${ops}f `;
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
export function inkPdfContent(strokes: readonly InkStroke[], heightPx: number): string {
	const hi = strokes.filter((s) => s.tool === "highlighter");
	const pen = strokes.filter((s) => s.tool !== "highlighter");
	// Flip once: PDF counts y upward from the bottom, ink counts it downward
	// from the top. Everything after this is written in note coordinates.
	let out = `q 1 0 0 -1 0 ${num(heightPx)} cm `;
	if (hi.length > 0) out += `q /GSa gs ${runs(hi)}Q `;
	out += runs(pen);
	return out + "Q";
}

/** The box every stroke fits inside, in note px, plus a margin. */
export function inkPageBox(strokes: readonly InkStroke[]): { w: number; h: number } {
	let maxX = 0;
	let maxY = 0;
	for (const s of strokes) {
		if (s.points.length === 0) continue;
		maxX = Math.max(maxX, s.bbox.x + s.bbox.width);
		maxY = Math.max(maxY, s.bbox.y + s.bbox.height);
	}
	return { w: Math.ceil(maxX) + MARGIN_PX, h: Math.ceil(maxY) + MARGIN_PX };
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
	const wPt = num(widthPx * PX_TO_PT);
	const hPt = num(heightPx * PX_TO_PT);
	// The stream's flip is in px; the page box is in points. The page carries
	// the px-to-pt scale so the ink never has to know about units.
	const body = `q ${num(PX_TO_PT)} 0 0 ${num(PX_TO_PT)} 0 0 cm ${content} Q`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}]` +
			" /Contents 4 0 R /Resources << /ExtGState << /GSa 5 0 R >> >> >>",
		`<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
		`<< /Type /ExtGState /ca ${num(HIGHLIGHTER_ALPHA)} /CA ${num(HIGHLIGHTER_ALPHA)} >>`,
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

/** A note's ink as a standalone one-page PDF, sized to the ink. */
export function inkToPdf(strokes: readonly InkStroke[]): string {
	const inked = strokes.filter((s) => s.points.length > 0);
	if (inked.length === 0) return "";
	const { w, h } = inkPageBox(inked);
	return pdfDocument(w, h, inkPdfContent(inked, h));
}
