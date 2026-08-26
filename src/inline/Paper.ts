/**
 * Lined and grid paper (roadmap). A writing aid, not a document property:
 * the choice is per device, applied as a body class that styles.css turns
 * into a background on every editor scroller, and never written into any
 * note or sidecar. `background-attachment: local` makes the ruling scroll
 * with the text, so lines behave like paper instead of like a window decal.
 *
 * One style at a time, cycled by a single command: none -> lines -> grid.
 */

export type PaperStyle = "none" | "lines" | "grid";

export const PAPER_STYLES: readonly PaperStyle[] = ["none", "lines", "grid"];

export function nextPaperStyle(cur: PaperStyle): PaperStyle {
	const i = PAPER_STYLES.indexOf(cur);
	return PAPER_STYLES[(i + 1) % PAPER_STYLES.length] ?? "none";
}

/** The body class for a style; null for none. */
export function paperClass(style: PaperStyle): string | null {
	if (style === "lines") return "handwriting-paper-lines";
	if (style === "grid") return "handwriting-paper-grid";
	return null;
}

/** Normalize a persisted value; anything unrecognized is none. */
export function normalizePaperStyle(raw: unknown): PaperStyle {
	return raw === "lines" || raw === "grid" ? raw : "none";
}
