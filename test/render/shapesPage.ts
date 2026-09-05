/**
 * The page half of the note-shape sweep: a CodeMirror-shaped `.cm-content`
 * whose CHILDREN are the variable, measured by the REAL `contentOriginLeft`
 * the overlay calls.
 *
 * `columnPage.ts` (1.4.9) proved the measurement on ONE note shape: three
 * prose lines, a wide table line, a collapsed marker. This file exists to ask
 * the next question - `contentOriginLeft` only ever looks at the first twelve
 * children, so which real notes put twelve non-text children in front of the
 * text? Every child kind below is a block that Obsidian really renders as a
 * direct child of `.cm-content` in Live Preview, or that Minimal's own
 * stylesheet selects for as one (the theme's selectors are the evidence that
 * the shape occurs: `> .cm-content > div:has(table)`,
 * `> .cm-content > div:has(.image-embed)`, `> .cm-content > .bases-embed`,
 * `> .cm-content > img`, `> .cm-content > *:not(div)`).
 *
 * The node half (`MinimalNoteShapes.test.ts`) supplies the stylesheets, holds
 * every theme citation, and decides. Nothing here decides anything: it builds
 * DOM and reports rects.
 *
 * GROUND TRUTH. "Where is the text column" cannot be answered by the shape
 * under test - that is the question. So the page builds a SECOND pane, the
 * ruler, with the same wrapper classes, the same width and one ordinary prose
 * line in it, and reports that line's left. Both panes are block boxes at
 * body x=0 with the same width, so their columns coincide. Where the shape is
 * long enough for it (>= SCAN_LIMIT children), a prose line is also appended
 * PAST the scan window and reported separately, so the test can assert the
 * ruler and the real note agree before trusting either.
 */

import { contentOriginLeft } from "../../src/inline/ContentOrigin";

/**
 * A direct child of `.cm-content`. Names are the note feature, not the tag.
 *
 * `hidden`/`collapsed` mean what the ENGINE does with them, and both are
 * spelled out because they are different hazards: `htmlEmbedHidden` has a
 * real width and a correct left edge and is merely flat, while
 * `markerCollapsed` has no width at all and its left edge is a point in the
 * middle of the pane.
 */
export type ChildKind =
	/** An ordinary line of prose. The thing whose left edge IS the column. */
	| "prose"
	/** A heading line: still a `.cm-line`, larger type. */
	| "heading"
	/** An empty line - a `.cm-line` holding only a `<br>`. */
	| "blank"
	/** A list item line: `.cm-line` with Live Preview's hanging indent. */
	| "listItem"
	/** A line inside a fenced code block (source, not a rendered widget). */
	| "codeLine"
	/** A `.cm-line` that contains a rendered table - the 1.4.9 fixture's hazard. */
	| "tableSourceLine"
	/** Obsidian's rendered table widget: a block widget, NOT a `.cm-line`. */
	| "tableWidget"
	/** A dataview table block: matched by Minimal's dataview width rule. */
	| "dataviewTable"
	/** A Bases embed, a direct `.bases-embed` child. */
	| "basesEmbed"
	/** An image embed inside its own block wrapper: `div:has(.image-embed)`. */
	| "imageContainer"
	/** The embed element itself as the direct child: `> .cm-content > .image-embed`. */
	| "imageDirect"
	/** A bare `img` child - Minimal's `> .cm-content > img` and `> *:not(div)`. */
	| "externalImg"
	/** A rendered callout block widget. */
	| "callout"
	/** A rendered display-math block widget. */
	| "mathBlock"
	/**
	 * An HTML block that renders to nothing - the shape an HTML comment takes
	 * when Live Preview hides it. Zero HEIGHT, full column WIDTH, and its left
	 * edge is the column's: a perfectly good measurement that today's
	 * degenerate test throws away.
	 */
	| "htmlEmbedHidden"
	/** CodeMirror's viewport gap: `div.cm-gap` with an inline height. */
	| "gap"
	/** CodeMirror's `img.cm-widgetBuffer` - zero width by its own base theme. */
	| "widgetBuffer"
	/** A block marker collapsed to a point: zero width AND zero height. */
	| "markerCollapsed";

export interface ShapeRequest {
	/** The children of `.cm-content`, in order. */
	kinds: ChildKind[];
	/** Obsidian's "Readable line length". Default true. */
	readable?: boolean;
	/** `.is-rtl` plus `direction: rtl`, as Obsidian sets for an RTL note. */
	rtl?: boolean;
	/** A Minimal per-note cssclass (`img-100`, `wide`, ...). Default none. */
	noteClass?: string;
	/** Pane width in px. Default 1400. */
	paneWidth?: number;
	/**
	 * Append one prose line AFTER the scan window. Only honoured when the
	 * shape already has at least `SCAN_WINDOW` children, so it can never
	 * change what the scan sees. Default true.
	 */
	tail?: boolean;
}

export interface ChildProbe {
	kind: ChildKind;
	/** The class list as rendered, so a mis-built fixture is visible. */
	cls: string;
	left: number;
	width: number;
	height: number;
	/** Whether `contentOriginLeft` would file it under `.cm-line`. */
	isLine: boolean;
	/** Whether today's degenerate test keeps it (`width > 0 && height > 0`). */
	usableToday: boolean;
}

export interface ShapeReading {
	/** `.cm-content`'s own left - the pre-1.4.9 origin, and today's fallback. */
	contentLeft: number;
	contentWidth: number;
	/** What `contentOriginLeft` returns: the origin the ink camera pins to. */
	originLeft: number;
	/**
	 * COUNTERFACTUAL, not production: today's scan with the `height <= 0` arm
	 * of the degenerate test removed. Isolates how much of an error is the
	 * over-rejection of flat-but-placed children.
	 */
	originWidthOnly: number;
	/**
	 * COUNTERFACTUAL, not production: the whole proposed measurement
	 * (`proposedOriginLeft` below). Its error column is the fix spec's
	 * evidence.
	 */
	originProposed: number;
	/** Ground truth from the ruler pane. */
	columnLeft: number;
	columnWidth: number;
	/** Ground truth from a prose line past the scan window, or null. */
	tailProseLeft: number | null;
	/** `originLeft - columnLeft`: signed, in px. The whole verdict. */
	error: number;
	childCount: number;
	/** The first `SCAN_WINDOW` children, as `contentOriginLeft` sees them. */
	window: ChildProbe[];
	/** How many of the scanned children are `.cm-line`s. */
	linesInWindow: number;
	/** How many of the scanned children survive today's degenerate test. */
	usableInWindow: number;
	/** How many `.cm-line`s exist in the whole rendered viewport. */
	linesInDoc: number;
}

/**
 * Mirrors `SCAN_LIMIT` in `src/inline/ContentOrigin.ts` for REPORTING only -
 * nothing here feeds the measurement. The test asserts the two agree by
 * reading the source, so this copy cannot drift silently.
 */
export const SCAN_WINDOW = 12;

/* -------------------------------------------------------------------------
 * Counterfactuals. NOT production code: two candidate measurements, kept
 * here so the sweep can print what each one would have returned for every
 * shape. If either is ever adopted it belongs in
 * `src/inline/ContentOrigin.ts`, and this copy should be deleted rather than
 * left to drift.
 * ---------------------------------------------------------------------- */

/** Today's rule with only the `height <= 0` arm of the degenerate test gone. */
export function widthOnlyOriginLeft(contentDOM: HTMLElement): number {
	const lines: number[] = [];
	const others: number[] = [];
	const children = contentDOM.children;
	const scanned = Math.min(children.length, SCAN_WINDOW);
	for (let i = 0; i < scanned; i++) {
		const child = children[i];
		if (!child) continue;
		const rect = child.getBoundingClientRect();
		if (rect.width <= 0) continue;
		(child.classList.contains("cm-line") ? lines : others).push(rect.left);
	}
	const candidates = lines.length > 0 ? lines : others;
	if (candidates.length === 0) return contentDOM.getBoundingClientRect().left;
	return Math.max(...candidates);
}

/** How many lines the head/tail sample measures at each end. */
const SAMPLE_END = 6;

/**
 * The proposal. Two things change:
 *
 * 1. `.cm-line` children are found by a class check over the WHOLE child
 *    list - which forces no layout - and the rect budget is then spent on
 *    lines only: the first `SAMPLE_END` and the last `SAMPLE_END` of them, so
 *    a leading run of wide blocks cannot monopolise the sample. Only when the
 *    viewport holds no line at all does it measure other children, and then
 *    the first `SCAN_WINDOW` as today.
 * 2. The degenerate test keeps `width <= 0` and drops `height <= 0`: a flat
 *    block still has a real left edge, a zero-width one does not.
 */
export function proposedOriginLeft(contentDOM: HTMLElement): number {
	const children = contentDOM.children;
	const lineIndices: number[] = [];
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (child && child.classList.contains("cm-line")) lineIndices.push(i);
	}
	const sampled =
		lineIndices.length <= SAMPLE_END * 2
			? lineIndices
			: [...lineIndices.slice(0, SAMPLE_END), ...lineIndices.slice(-SAMPLE_END)];
	const lefts: number[] = [];
	for (const index of sampled) {
		const child = children[index];
		if (!child) continue;
		const rect = child.getBoundingClientRect();
		if (rect.width > 0) lefts.push(rect.left);
	}
	if (lefts.length === 0) {
		const scanned = Math.min(children.length, SCAN_WINDOW);
		for (let i = 0; i < scanned; i++) {
			const child = children[i];
			if (!child) continue;
			const rect = child.getBoundingClientRect();
			if (rect.width > 0) lefts.push(rect.left);
		}
	}
	if (lefts.length === 0) return contentDOM.getBoundingClientRect().left;
	return Math.max(...lefts);
}

const el = (tag: string, cls: string): HTMLElement => {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	return node;
};

const withText = (node: HTMLElement, text: string): HTMLElement => {
	node.textContent = text;
	return node;
};

/** An `img` that renders at a real size without a network round trip. */
const sizedImg = (cls: string, w: number, h: number): HTMLElement => {
	const img = el("img", cls);
	img.style.width = `${w}px`;
	img.style.height = `${h}px`;
	return img;
};

const table = (): HTMLElement => {
	const t = document.createElement("table");
	const row = document.createElement("tr");
	const cell = document.createElement("td");
	cell.textContent = "cell";
	row.appendChild(cell);
	t.appendChild(row);
	return t;
};

const PROSE = "the quick brown fox jumps over the lazy dog";

const FACTORY: Record<ChildKind, () => HTMLElement> = {
	prose: () => withText(el("div", "cm-line"), PROSE),
	heading: () => {
		const line = el("div", "cm-line HyperMD-header HyperMD-header-2");
		line.appendChild(withText(el("span", "cm-header cm-header-2"), "A heading"));
		return line;
	},
	blank: () => {
		const line = el("div", "cm-line");
		line.appendChild(document.createElement("br"));
		return line;
	},
	listItem: () => {
		const line = el("div", "cm-line HyperMD-list-line HyperMD-list-line-1");
		// Live Preview writes the hanging indent inline on the line. It moves
		// the TEXT, never the line's own border box - which is the point of
		// including it.
		line.style.textIndent = "-26px";
		line.style.paddingInlineStart = "26px";
		return withText(line, `- ${PROSE}`);
	},
	codeLine: () =>
		withText(el("div", "cm-line HyperMD-codeblock HyperMD-codeblock-bg"), "const x = 1;"),
	tableSourceLine: () => {
		const line = el("div", "cm-line");
		line.appendChild(table());
		return line;
	},
	tableWidget: () => {
		const block = el("div", "cm-embed-block cm-table-widget markdown-rendered");
		block.appendChild(table());
		return block;
	},
	dataviewTable: () => {
		const block = el("div", "");
		const dv = el("div", "block-language-dataview");
		dv.appendChild(table());
		block.appendChild(dv);
		return block;
	},
	basesEmbed: () => {
		const block = el("div", "bases-embed");
		block.appendChild(withText(el("div", "bases-view"), "base"));
		return block;
	},
	imageContainer: () => {
		const block = el("div", "cm-embed-block");
		const embed = el("div", "internal-embed image-embed is-loaded");
		embed.appendChild(sizedImg("", 320, 180));
		block.appendChild(embed);
		return block;
	},
	imageDirect: () => {
		const embed = el("div", "internal-embed image-embed is-loaded");
		embed.appendChild(sizedImg("", 320, 180));
		return embed;
	},
	externalImg: () => sizedImg("", 200, 120),
	callout: () => {
		const block = el("div", "cm-embed-block cm-callout");
		const callout = el("div", "callout");
		callout.appendChild(withText(el("div", "callout-title"), "Note"));
		callout.appendChild(withText(el("div", "callout-content"), PROSE));
		block.appendChild(callout);
		return block;
	},
	mathBlock: () => {
		const block = el("div", "cm-embed-block math math-block");
		block.appendChild(withText(el("span", "math"), "∑ x"));
		return block;
	},
	htmlEmbedHidden: () => {
		const block = el("div", "");
		// Empty: an HTML comment renders to nothing. The wrapper still takes
		// its width from the theme, so its left edge is the column's.
		block.appendChild(el("div", "cm-html-embed"));
		return block;
	},
	gap: () => {
		// BlockGapWidget, verbatim: `elt.className = "cm-gap"` and an inline
		// height (@codemirror/view/dist/index.js:1690-1707).
		const gap = el("div", "cm-gap");
		gap.style.height = "420px";
		return gap;
	},
	widgetBuffer: () => {
		// WidgetBufferView, verbatim: an `img.cm-widgetBuffer` with
		// aria-hidden and no src (@codemirror/view/dist/index.js:1011-1018).
		const img = el("img", "cm-widgetBuffer");
		img.setAttribute("aria-hidden", "true");
		return img;
	},
	markerCollapsed: () => {
		const marker = el("div", "hw-block-marker");
		// Inline width beats the theme's `width: var(--line-width)`, which is
		// not `!important` - unlike the `margin-inline: auto` beside it. A
		// zero-WIDTH box under auto margins centres on a point.
		marker.style.width = "0px";
		marker.style.height = "0px";
		return marker;
	},
};

interface Pane {
	view: HTMLElement;
	content: HTMLElement;
}

/** The wrapper chain Minimal's selectors require, built once per pane. */
function buildPane(id: string, req: ShapeRequest): Pane {
	const pane = el("div", "workspace-leaf-content hw-pane");
	pane.style.width = `${req.paneWidth ?? 1400}px`;
	const viewClasses = [
		"markdown-source-view",
		"cm-s-obsidian",
		"mod-cm6",
		"is-live-preview",
	];
	if (req.readable !== false) viewClasses.push("is-readable-line-width");
	if (req.rtl) viewClasses.push("is-rtl");
	if (req.noteClass) viewClasses.push(req.noteClass);
	const view = el("div", viewClasses.join(" "));
	if (req.rtl) view.style.direction = "rtl";
	const editor = el("div", "cm-editor");
	const scroller = el("div", "cm-scroller");
	const sizer = el("div", "cm-sizer");
	const container = el("div", "cm-contentContainer");
	// `cm-lineWrapping` is on `.cm-content` whenever line wrapping is on, and
	// Obsidian always has it on (@codemirror/view/dist/index.js:6552-6558).
	const content = el("div", "cm-content cm-lineWrapping");
	content.id = id;
	container.appendChild(content);
	sizer.appendChild(container);
	scroller.appendChild(sizer);
	editor.appendChild(scroller);
	view.appendChild(editor);
	pane.appendChild(view);
	document.body.appendChild(pane);
	return { view, content };
}

let kinds: ChildKind[] = [];

function build(req: ShapeRequest): void {
	document.body.innerHTML = "";
	kinds = [...req.kinds];
	const shape = buildPane("shape", req);
	for (const kind of kinds) shape.content.appendChild(FACTORY[kind]());
	if (req.tail !== false && kinds.length >= SCAN_WINDOW) {
		const tail = FACTORY.prose();
		tail.id = "tail";
		shape.content.appendChild(tail);
	}
	// The ruler: same wrapper, same width, one ordinary line.
	const ruler = buildPane("ruler", req);
	const line = FACTORY.prose();
	line.id = "rulerline";
	ruler.content.appendChild(line);
}

function probe(child: Element, kind: ChildKind): ChildProbe {
	const rect = child.getBoundingClientRect();
	return {
		kind,
		cls: child.className,
		left: rect.left,
		width: rect.width,
		height: rect.height,
		isLine: child.classList.contains("cm-line"),
		usableToday: rect.width > 0 && rect.height > 0,
	};
}

function read(): ShapeReading {
	const content = document.getElementById("shape");
	const rulerLine = document.getElementById("rulerline");
	const rulerContent = document.getElementById("ruler");
	if (
		!(content instanceof HTMLElement) ||
		!(rulerLine instanceof HTMLElement) ||
		!(rulerContent instanceof HTMLElement)
	) {
		throw new Error("shape fixture not built");
	}
	const tail = document.getElementById("tail");
	const c = content.getBoundingClientRect();
	const col = rulerLine.getBoundingClientRect();
	const window_: ChildProbe[] = [];
	for (let i = 0; i < Math.min(content.children.length, SCAN_WINDOW); i++) {
		const child = content.children[i];
		const kind = kinds[i];
		if (!child || !kind) continue;
		window_.push(probe(child, kind));
	}
	// The real production measurement, bundled from src. The whole point of
	// the file: not a copy of the rule, the rule.
	const originLeft = contentOriginLeft(content) ?? c.left;
	return {
		contentLeft: c.left,
		contentWidth: c.width,
		originLeft,
		originWidthOnly: widthOnlyOriginLeft(content),
		originProposed: proposedOriginLeft(content),
		columnLeft: col.left,
		columnWidth: col.width,
		tailProseLeft: tail ? tail.getBoundingClientRect().left : null,
		error: originLeft - col.left,
		childCount: content.children.length,
		window: window_,
		linesInWindow: window_.filter((p) => p.isLine).length,
		usableInWindow: window_.filter((p) => p.usableToday).length,
		linesInDoc: content.querySelectorAll(":scope > .cm-line").length,
	};
}

/**
 * What a candidate measurement COSTS, counted rather than timed.
 *
 * `getBoundingClientRect` is the expensive call - it can force a layout - and
 * a count of it is the same number on every machine, unlike a millisecond
 * reading. `visited` is the cheap half: class checks that force nothing.
 */
export interface CostProbe {
	childCount: number;
	todayRects: number;
	proposedRects: number;
	proposedVisited: number;
}

function countRects(run: (content: HTMLElement) => number | null, content: HTMLElement): number {
	const proto = Element.prototype as unknown as {
		getBoundingClientRect: () => DOMRect;
	};
	const original = proto.getBoundingClientRect;
	let count = 0;
	proto.getBoundingClientRect = function (this: Element): DOMRect {
		count++;
		return original.call(this);
	};
	try {
		run(content);
	} finally {
		proto.getBoundingClientRect = original;
	}
	return count;
}

/**
 * Builds a note of `childCount` prose lines and counts what each measurement
 * reads. This is the hot-path question: `contentOriginLeft` runs inside
 * `syncCamera`, which runs on resize and scroll ticks and at pen-down, so a
 * cost that scales with note length is a cost that scales with every scroll.
 */
function cost(childCount: number): CostProbe {
	build({ kinds: rep("prose", childCount), tail: false });
	const content = document.getElementById("shape");
	if (!(content instanceof HTMLElement)) throw new Error("shape fixture not built");
	// One warm read so the counts below are steady-state, not first-layout.
	content.getBoundingClientRect();
	return {
		childCount: content.children.length,
		todayRects: countRects(contentOriginLeft, content),
		proposedRects: countRects(proposedOriginLeft, content),
		proposedVisited: content.children.length,
	};
}

const rep = (kind: ChildKind, n: number): ChildKind[] =>
	Array.from({ length: n }, () => kind);

interface ShapesApi {
	measure(req: ShapeRequest): ShapeReading;
	cost(childCount: number): CostProbe;
}

declare global {
	interface Window {
		__hwshapes: ShapesApi;
	}
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
	window.__hwshapes = {
		measure(req: ShapeRequest): ShapeReading {
			build(req);
			return read();
		},
		cost,
	};
}
