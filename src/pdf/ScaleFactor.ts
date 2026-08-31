/**
 * The one probe the release line needs from the 1.4 line's PdfViewerProbe:
 * the viewer's own scale factor, for the pinch bridge's anchor arithmetic.
 * Copied rather than imported so a future fold replaces this file with the
 * full probe instead of merging around it.
 */

const num = (v: unknown): number | null => {
	const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
	return Number.isFinite(n) ? n : null;
};

/**
 * `--scale-factor` is what pdf.js multiplies page dimensions by, and it moved
 * onto the viewer container in pdf.js#15929. Walk up from the page: whoever
 * sets it wins.
 */
export function findScaleFactor(from: HTMLElement, win: Window): number | null {
	let el: HTMLElement | null = from;
	let hops = 0;
	while (el && hops < 8) {
		const v = num(win.getComputedStyle(el).getPropertyValue("--scale-factor").trim());
		if (v !== null) return v;
		el = el.parentElement;
		hops++;
	}
	return null;
}
