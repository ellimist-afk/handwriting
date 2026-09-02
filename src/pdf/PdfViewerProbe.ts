/**
 * Every touchpoint with Obsidian's PDF view, in one file.
 *
 * The containment rule from the design: the PDF integration is DOM
 * OBSERVATION, not patching. We watch page divs and read geometry; we never
 * modify the viewer, never patch its methods, and never depend on an internal
 * API to function. That is what makes this survivable - Obsidian API churn
 * cannot break something that uses no API, and markup churn turns into a
 * clean disable rather than a crash, because every read below is feature
 * detected and every failure returns null.
 *
 * Null means "PDF ink is off this session". It never means a partial state,
 * and nothing here throws.
 *
 * M0 uses this to answer, from the live app, what the design could only
 * guess: which element scrolls, what a page div looks like, where the scale
 * lives, and whether the optional internal path exists.
 *
 * ---- M0 findings, Obsidian 1.13.7 desktop, 2026-08-28 ----
 *
 * V1  scroller is `.pdf-viewer-container` (first candidate, matched).
 *     Pages are `div.page[data-page-number]` inside it, as expected.
 *     `--scale-factor` is set on the PAGE DIV, *not* on the viewer container.
 *     The design expected the pdf.js#15929 container placement; walking up
 *     from the page and reporting where it was really found is what caught
 *     the difference, and is why that walk stays.
 *
 * V2  `clientWidth / --scale-factor` IS zoom-invariant. Measured across a
 *     3.5x zoom change: scale 3.3746 gave 338.70 x 245.95, scale 11.7733
 *     gave 338.99 x 245.98. The 0.29pt spread is `clientWidth` being an
 *     integer - one px at scale 3.37 is 0.30pt - so the higher zoom is the
 *     more accurate reading, not a drift.
 *     Checked against ground truth rather than against itself: the document
 *     was one this plugin generated, whose MediaBox is exactly [0 0 339 246].
 *     The derived base lands on it. **This is the per-page coordinate base.**
 *
 * V3  `view.viewer.child.pdfViewer` is present, but `currentScale` is NOT on
 *     it. Nothing is built on this; the geometric path needs no internals,
 *     which V2 confirms is sufficient.
 *
 * V5  **The page divs are NOT virtualized.** A 100-page document renders all
 *     100 `div.page` elements at once, and their `offsetTop` is stable and
 *     scroll-independent (linear stride 1494 = 1480 box + 14 gap; page 50 read
 *     identically from the top of the document and from page 50).
 *     The design assumed a handful of divs. It is wrong, and M1's "page
 *     canvases die with their divs" acceptance rule is wrong with it - nothing
 *     dies, so an overlay per div would be 100 overlays. Our own visibility
 *     windowing is required, and `hasCanvas` above is the signal to follow.
 *     Good news in it: any page's geometry can be computed without that page
 *     being visible.
 *
 * V6  The viewer windows CANVASES, not divs. Scrolled to page 50 of 100:
 *     6 canvases live, on pages 1, 50, 51, 52, 53, 54 - roughly five around
 *     the viewport, plus page 1 retained no matter where you are.
 *     So `hasCanvas` is the policy to mirror. Attaching where the viewer
 *     attached means inheriting thresholds Obsidian already tuned, instead of
 *     inventing our own and drifting from them at the next update.
 *
 * V4  iPad: not yet checked. Due before release, not before building.
 *
 * Re-run the report on each Obsidian minor; these are observations of someone
 * else's markup, not guarantees.
 */

/** What one rendered page looks like to us. */
export interface ProbedPage {
	/** 1-based, from the viewer's own attribute. */
	pageNumber: number;
	/** Layout box of the page div, css px at the current zoom. */
	widthPx: number;
	heightPx: number;
	/** Offset within the scroll container's content, css px. */
	topPx: number;
	leftPx: number;
	/**
	 * Does this page hold a rendered canvas?
	 *
	 * The page DIVS all exist at once (M0), so this is the only signal of what
	 * the viewer considers live. Our own overlay policy should follow it
	 * rather than the divs, or a hundred-page document gets a hundred
	 * overlays.
	 */
	hasCanvas: boolean;
	/**
	 * The viewer's OWN page canvas, measured inside the page div.
	 *
	 * The page div is not necessarily the page: a border, padding, or a
	 * centred inner canvas all put the rendered page somewhere other than the
	 * div's padding-box origin. Ink drawn against the div would then be
	 * offset by exactly that much - which is what hardware showed.
	 * Null when the page has no canvas yet.
	 */
	canvasBox: { leftPx: number; topPx: number; widthPx: number; heightPx: number } | null;
}

export interface ProbedViewer {
	/** The element that scrolls the pages. */
	scroller: HTMLElement;
	/** Where `--scale-factor` was found, and its value. */
	scaleFactor: number | null;
	scaleSource: string;
	pages: ProbedPage[];
}

/**
 * Candidate selectors, most specific first.
 *
 * A list rather than one string because the whole risk of this integration is
 * that the markup moves. Trying several and REPORTING which matched is what
 * turns a future rename into a one-line change instead of an investigation.
 */
const SCROLLER_SELECTORS = [
	".pdf-viewer-container",
	".pdfViewer",
	"#viewerContainer",
	".pdf-content-container",
] as const;

/**
 * A page the reader is READING - never a thumbnail.
 *
 * The sidebar's pages are `thumbnailView` / `thumbnailCanvas` elements and do
 * not carry `data-page-number`, so they fall outside this selector and outside
 * the scroller above. That is not an accident to be tidied up later: it is the
 * line between the two things a document can be here.
 *
 * The PDF on disk is never written to. Ink lives beside it in a sidecar, drawn
 * over the viewer's own pixels, and the thumbnail strip is the cheapest place
 * to SEE that - the document as it actually is, unmarked, a glance away from
 * the marked-up view. Flattening is the deliberate other half: it bakes the
 * ink into a COPY (`flattenPdf`), and that copy's thumbnails show ink because
 * by then the ink is genuinely in the document.
 *
 * So: clean thumbnails mean the original is untouched, inked thumbnails mean
 * you are looking at a flattened copy. Widening this selector to decorate the
 * sidebar would erase the one signal that tells those two apart.
 */
const PAGE_SELECTOR = "div.page[data-page-number]";

const num = (v: unknown): number | null => {
	const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
	return Number.isFinite(n) ? n : null;
};

/**
 * `--scale-factor` is what pdf.js multiplies page dimensions by, and it moved
 * onto the viewer container in pdf.js#15929. Walk up from the page: whoever
 * sets it wins, and the element that did is reported so a move is visible
 * rather than silent.
 */
export function findScaleFactor(
	from: HTMLElement,
	win: Window
): { value: number | null; source: string } {
	let el: HTMLElement | null = from;
	let hops = 0;
	while (el && hops < 8) {
		const raw = win.getComputedStyle(el).getPropertyValue("--scale-factor");
		const v = num(raw.trim());
		if (v !== null) {
			return { value: v, source: `${el.tagName.toLowerCase()}.${el.className || "(no class)"}` };
		}
		el = el.parentElement;
		hops++;
	}
	return { value: null, source: "(not set on any ancestor)" };
}

/**
 * The viewer's own canvas for a page - the one its pixels are on right now.
 *
 * A page div can hold more than one canvas that is not ours. During a zoom
 * pdf.js keeps the previous zoom's canvas in a `.zoomLayer` that precedes
 * the fresh `.canvasWrapper` in document order, and a first render paints
 * progressively into a canvas marked `hidden` until it is complete. The
 * FIRST match is therefore the stale one exactly when it matters; the last
 * visible match is the canvas the reader is looking at.
 */
export function viewerCanvasOf(pageEl: HTMLElement): HTMLCanvasElement | null {
	const all = [...pageEl.querySelectorAll<HTMLCanvasElement>("canvas:not(.handwriting-pdf-ink)")];
	for (let i = all.length - 1; i >= 0; i--) {
		const c = all[i]!;
		if (!c.hidden) return c;
	}
	return null;
}

/**
 * Where the viewer's page canvas sits within its page div.
 *
 * `offsetLeft`/`offsetTop` are relative to the nearest positioned ancestor,
 * which for a pdf.js page canvas is the page div itself - the same box our
 * overlay is positioned in, so the numbers are directly comparable and the
 * difference is the correction our overlay needs.
 */
export function canvasBoxOf(
	pageEl: HTMLElement
): { leftPx: number; topPx: number; widthPx: number; heightPx: number } | null {
	const c = viewerCanvasOf(pageEl);
	if (!c) return null;
	// Only trust the offset when it is genuinely relative to this page div.
	// `offsetLeft` is measured against the nearest POSITIONED ancestor, and a
	// page div that happens to be static hands back a number relative to
	// something further up - which would place the overlay off the page
	// entirely. Refusing is the safe answer: the caller falls back to the div.
	if (c.offsetParent !== pageEl) return null;
	return {
		leftPx: c.offsetLeft,
		topPx: c.offsetTop,
		widthPx: c.clientWidth,
		heightPx: c.clientHeight,
	};
}

/** The scrolling container for a PDF view's root element, if recognizable. */
export function findScroller(root: HTMLElement): { el: HTMLElement | null; matched: string } {
	for (const sel of SCROLLER_SELECTORS) {
		const el = root.querySelector<HTMLElement>(sel);
		if (el) return { el, matched: sel };
	}
	return { el: null, matched: "(none matched)" };
}

/**
 * Read the rendered pages of a PDF view. Null when the markup is not what we
 * expect, which is the disable path rather than an error path.
 *
 * Only rendered pages exist: pdf.js virtualizes, so a 100-page document holds
 * a handful of divs. Anything built on this must treat pages as appearing and
 * disappearing, never as a stable list.
 */
export function probeViewer(root: HTMLElement, win: Window): ProbedViewer | null {
	const { el: scroller } = findScroller(root);
	if (!scroller) return null;
	const pageEls = Array.from(scroller.querySelectorAll<HTMLElement>(PAGE_SELECTOR));
	const first = pageEls[0];
	const scale = first
		? findScaleFactor(first, win)
		: { value: null, source: "(no page rendered)" };
	return {
		scroller,
		scaleFactor: scale.value,
		scaleSource: scale.source,
		pages: pageEls.map((el) => ({
			pageNumber: num(el.getAttribute("data-page-number")) ?? 0,
			widthPx: el.clientWidth,
			heightPx: el.clientHeight,
			// Plus the border, or the two halves of this box disagree about
			// which box they describe. `offsetTop` is the div's OUTER corner;
			// `clientWidth` - and the overlay, and the viewer's own canvas -
			// are the padding box INSIDE the border. Mixing them put every
			// pen-down a border-width down-right of the ink it produced:
			// measured at (6.5, 7.0) css px on the stock viewer, constant at
			// every zoom, and present for pen and mouse alike (the report's
			// DELTA line, 2026-08-30). `clientTop`/`clientLeft` are exactly
			// that border, straight from the DOM.
			topPx: el.offsetTop + el.clientTop,
			leftPx: el.offsetLeft + el.clientLeft,
			// Our OWN overlay is a canvas inside the page div, so a bare
			// "canvas" query answers true for a page pdf.js has evicted as
			// soon as we have drawn on it - and hasCanvas is what livePages
			// reads to decide the page is still rendered. Same exclusion
			// viewerCanvasOf already makes, for the same reason.
			hasCanvas: el.querySelector("canvas:not(.handwriting-pdf-ink)") !== null,
			canvasBox: canvasBoxOf(el),
		})),
	};
}

/**
 * The OPTIONAL internal path, read behind `typeof` guards and never required.
 *
 * Reported by M0 so we know whether it exists per Obsidian version; nothing is
 * built on it. If it is absent the integration is unaffected, because the
 * primary path is geometric and needs no internals at all.
 */
export function probeInternalPath(view: unknown): string {
	const step = (obj: unknown, key: string): unknown =>
		obj !== null && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
	const path: string[] = [];
	let cur: unknown = view;
	for (const key of ["viewer", "child", "pdfViewer"]) {
		cur = step(cur, key);
		if (cur === undefined || cur === null) return `${path.join(".") || "view"} -> ${key}: absent`;
		path.push(key);
	}
	const cs = step(cur, "currentScale");
	return `view.${path.join(".")} present; currentScale ${typeof cs === "number" ? cs : "absent"}`;
}
