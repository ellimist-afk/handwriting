/**
 * Two edges of the one-page export of an Infinite Canvas note.
 *
 * A highlighter stroke's stored box is padded by twice its width (StrokeBuilder: computeBBox(points, width * 2)), 32 world
 * units at the default size, while the one-page predicate allows only the 16 px print pad left of and above the text. A
 * highlight over the first word of a line, or anywhere on the first line, therefore reads as ink that left the text's
 * pages, and a long note exports as one shrunk page where it should print as today.
 *
 * The screen call's zoom is kept at the print when the measured paper is at least as wide as the saved settings say. The
 * page's height is never checked, so a print on a shorter page than the saved settings (Letter portrait saved, landscape
 * printed; A4 saved, Letter printed) keeps a zoom fitted to the taller page, and the one page spills onto a second.
 *
 * The harness is EmbedPrintFit.test.ts's fake print container, copied.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	attachEmbedInk,
	disarmPrintSwaps,
	embedInkBounds,
	embedInkChanged,
	embedInkDiagLine,
	embedInkPrintSwaps,
	initEmbedInkColumnWidth,
	initEmbedInkDiagnostics,
	initEmbedInkRefresh,
	MIN_HEIGHT_ATTR,
	printColumnWidth,
	teardownEmbedInk,
} from "./EmbedInk";
import * as embedInk from "./EmbedInk";
import { initEmbedInkPrintCanvas, initEmbedInkPrintPaper, paperHeightFor, paperWidthFor } from "./EmbedInkPrint";
import { InkStroke } from "../ink/Stroke";
import { ribbonOf } from "../ink/StrokeOutline";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { HIGHLIGHTER_PEN } from "../ink/PenStyle";

/**
 * A native export prints the note in a container as wide as the paper, so the text wraps at the paper's width and
 * every word below the first re-wrapped line slides off its ink, which stays where it was drawn. The print swap
 * therefore lays the container out at the note's screen column width and shrinks it with `zoom` to the paper, and
 * puts everything back when the print ends. These cells drive the real attach and the real beforeprint and
 * afterprint events against a container whose paper width, padding and re-wrap are planted.
 */

function stroke(id: string, x0: number, x1: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: x0, y: 10, pressure: 0.5, t: 0 },
			{ x: x1, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: x0, y: 10, width: x1 - x0, height: 10 },
		createdAt: 0,
	} as InkStroke;
}

type Style = Record<string, string | undefined> & { removeProperty(p: string): void };

class FEl {
	readonly attrs = new Map<string, string>();
	readonly children: FEl[] = [];
	readonly style: Style = Object.assign({} as Record<string, string | undefined>, {
		removeProperty(this: Record<string, string | undefined>, p: string): void {
			delete this[p.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())];
		},
	});
	parentElement: FEl | null = null;
	isConnected = true;
	offsetParent: unknown = null;
	offsetTop = 0;
	offsetLeft = 0;
	offsetHeight = 24;
	offsetWidth = 0;
	constructor(readonly tag: string, readonly ownerDocument: FDoc) {}
	get firstChild(): FEl | null {
		return this.children[0] ?? null;
	}
	get classList() {
		const names = (): string[] => (this.attrs.get("class") ?? "").split(" ").filter(Boolean);
		return {
			contains: (c: string) => names().includes(c),
			add: (c: string) => {
				if (!names().includes(c)) this.attrs.set("class", [...names(), c].join(" "));
			},
			remove: (c: string) => this.attrs.set("class", names().filter((n) => n !== c).join(" ")),
		};
	}
	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}
	getAttribute(k: string): string | null {
		return this.attrs.get(k) ?? null;
	}
	removeAttribute(k: string): void {
		this.attrs.delete(k);
	}
	appendChild(c: FEl): FEl {
		c.parentElement?.removeChild(c);
		this.children.push(c);
		c.parentElement = this;
		return c;
	}
	removeChild(c: FEl): FEl {
		const i = this.children.indexOf(c);
		if (i >= 0) this.children.splice(i, 1);
		c.parentElement = null;
		return c;
	}
	remove(): void {
		this.parentElement?.removeChild(this);
	}
	cloneNode(deep: boolean): FEl {
		const copy = new FEl(this.tag, this.ownerDocument);
		for (const [k, v] of this.attrs) copy.attrs.set(k, v);
		Object.assign(copy.style, this.style);
		if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
		return copy;
	}
	querySelector(sel: string): FEl | null {
		// A bare tag (the title's `:scope > h1`).
		const t = /^:scope > ([a-z][a-z0-9]*)$/.exec(sel);
		if (t) return this.children.find((k) => k.tag === t[1]) ?? null;
		const m = /^:scope > ([a-z]+)\.([a-zA-Z0-9_-]+)$/.exec(sel);
		if (!m) return null;
		return this.children.find((k) => k.tag === m[1] && (k.attrs.get("class") ?? "").split(" ").includes(m[2]!)) ?? null;
	}
	createEl(tag: string, opts: { cls?: string } = {}): FEl {
		const el = new FEl(tag, this.ownerDocument);
		if (opts.cls) el.attrs.set("class", opts.cls);
		return this.appendChild(el);
	}
	setCssStyles(s: Record<string, string>): void {
		Object.assign(this.style, s);
	}
	getBoundingClientRect() {
		return { left: 0, top: 0, width: 300, height: 300 };
	}
	getContext() {
		return new Proxy({} as Record<string, unknown>, {
			get: (t, k) => (k in t ? t[k as string] : () => {}),
			set: (t, k, v) => ((t[k as string] = v), true),
		});
	}
	closest(): null {
		return null;
	}
}

class FDoc {
	readonly listeners = new Map<string, Array<() => void>>();
	/** The page height the print layout reports (0: none). */
	readonly documentElement = { clientHeight: 0 };
	/** What getComputedStyle answers for a print container: the paddings and the box model the theme sets. */
	/** Whether the print media is on: false in the screen layout `beforeprint` fires in, true once the print lays out. */
	printMedia = true;
	computed: Record<string, string> = { position: "relative", paddingLeft: "32px", paddingRight: "32px", boxSizing: "border-box" };
	readonly defaultView = {
		devicePixelRatio: 1,
		getComputedStyle: () => this.computed,
		addEventListener: (type: string, fn: () => void): void => {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
		},
		removeEventListener: (type: string, fn: () => void): void => {
			this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
		},
		matchMedia: () => ({ matches: this.printMedia, addEventListener: () => {}, removeEventListener: () => {} }),
		setTimeout: (): number => 0,
		clearTimeout: (): void => {},
	};
	createElementNS(_ns: string, tag: string): FEl {
		const el = new FEl(tag, this);
		// A div we add to a laid-out print container is laid out too.
		if (tag === "div") el.offsetParent = {};
		return el;
	}
	fire(type: string): void {
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
	}
}

/** Where the first block's top lands: lower when the text wraps at the paper's width (one more line above it). */
const TOP_AT_COLUMN = 100;
const TOP_AT_PAPER = 124;

/**
 * Obsidian's print container: a markdown-preview-view with no sizer, one block in a div, `paper` px wide in total.
 * The block's top depends on the width the print swap leaves on the container, as a re-wrap does.
 */
function printContainer(doc: FDoc, paper: number, columnWidth = 700, padShifts = false): { root: FEl; block: FEl } {
	const root = new FEl("div", doc);
	root.attrs.set("class", "markdown-preview-view markdown-rendered");
	root.offsetParent = {};
	root.offsetWidth = paper;
	const block = root.appendChild(new FEl("div", doc));
	block.offsetParent = root;
	block.offsetLeft = 32;
	Object.defineProperty(block, "offsetTop", {
		get: () => (Number.parseFloat(root.style.width ?? "") >= columnWidth ? TOP_AT_COLUMN : TOP_AT_PAPER) + (padShifts ? Number.parseFloat(root.style.paddingTop ?? "") || 0 : 0),
	});
	return { root, block };
}

let ink: InkStroke[];
let doc: FDoc;

beforeEach(() => {
	doc = new FDoc();
	ink = [stroke("a", 20, 600)];
	initEmbedInkRefresh(() => ink);
	initEmbedInkColumnWidth(() => 700);
});
afterEach(() => {
	disarmPrintSwaps();
	teardownEmbedInk();
});

function print(paper: number, columnWidth = 700): { root: FEl } {
	const { root } = printContainer(doc, paper, columnWidth);
	attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
	doc.fire("beforeprint");
	return { root };
}

/** A stroke over the box x0..x1, y0..y1, its box exactly its points: a far stroke whose pad does not matter here. */
function boxStroke(id: string, x0: number, x1: number, y0: number, y1: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: x0, y: y0, pressure: 0.5, t: 0 },
			{ x: x1, y: y1, pressure: 0.5, t: 8 },
		],
		bbox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
		createdAt: 0,
	} as InkStroke;
}

/** A highlighter stroke as the pen path builds it: the default width, its stored box from the builder. */
function highlight(id: string, x0: number, x1: number, y: number): InkStroke {
	const b = new StrokeBuilder("highlighter", HIGHLIGHTER_PEN.color, HIGHLIGHTER_PEN.baseWidth);
	b.start(0);
	const steps = 12;
	for (let i = 0; i <= steps; i++) b.add(x0 + ((x1 - x0) * i) / steps, y + (i % 2), 0.5, i * 8);
	const s = b.finish();
	if (!s) throw new Error("the builder made no stroke");
	return s;
}

function heightFollowsMinHeight(root: FEl, text: number): void {
	Object.defineProperty(root, "offsetHeight", { get: () => Math.max(text, Number.parseFloat(root.style.minHeight ?? "") || 0) });
	Object.defineProperty(root, "scrollHeight", { get: () => Math.max(root.offsetHeight, 120_000) });
	// The text ends where the box does: a container's one block reaches the text's foot.
	const block = root.children.length === 1 ? root.children[0] : undefined;
	if (block) Object.defineProperty(block, "offsetHeight", { get: () => Math.max(0, text - block.offsetTop) });
}

const LETTER_PORTRAIT = { pageSize: "Letter", landscape: false, margin: "0", downscalePercent: 100 };
const LETTER_LANDSCAPE = { ...LETTER_PORTRAIT, landscape: true };
const A4_PORTRAIT = { ...LETTER_PORTRAIT, pageSize: "A4" };
const NEAR = boxStroke("near", 20, 600, 10, 20);
const PAD = 16;

interface Exported {
	root: FEl;
	zoom: number;
	paddingLeft: string | undefined;
	paddingTop: string | undefined;
}

/** One export: the screen call under `saved`, then the print-media call measuring `paper`. */
function exportNote(strokes: InkStroke[], saved: unknown, paper: number, foot: number): Exported {
	const fdoc = new FDoc();
	doc = fdoc;
	ink = strokes;
	initEmbedInkPrintCanvas(() => true);
	initEmbedInkPrintPaper(() => saved);
	const { root } = printContainer(fdoc, paper, 700, true);
	heightFollowsMinHeight(root, foot);
	attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
	fdoc.printMedia = false;
	fdoc.fire("beforeprint");
	fdoc.printMedia = true;
	root.offsetWidth = paper;
	fdoc.fire("beforeprint");
	return { root, zoom: Number(root.style.zoom), paddingLeft: root.style.paddingLeft, paddingTop: root.style.paddingTop };
}

afterEach(() => {
	initEmbedInkPrintPaper(null);
	initEmbedInkPrintCanvas(null);
});

describe("a highlight near the text's left edge or on its first line, in a long Infinite Canvas note", () => {
	const PAPER_W = paperWidthFor(LETTER_PORTRAIT)!;
	const FOOT = 3000;
	const WIDTH_ZOOM = PAPER_W / (64 + 700);

	it("premise: the builder's box reaches 32 past the highlight's points", () => {
		const h = highlight("hl", 2, 80, 150);
		expect(h.width).toBe(16);
		expect(h.bbox.x).toBeLessThan(-PAD);
	});

	it("control: a highlight 40 px in from the left edge prints as today, the width fit", () => {
		const out = exportNote([NEAR, highlight("hl", 40, 120, 150)], LETTER_PORTRAIT, PAPER_W, FOOT);
		expect(out.paddingLeft).toBeUndefined();
		expect(out.zoom).toBeCloseTo(WIDTH_ZOOM, 6);
	});

	it("a highlight over the first word of a line prints as today, not as one shrunk page", () => {
		const out = exportNote([NEAR, highlight("hl", 2, 80, 150)], LETTER_PORTRAIT, PAPER_W, FOOT);
		expect(out.paddingLeft, "no left reach").toBeUndefined();
		expect(out.zoom, "the width fit").toBeCloseTo(WIDTH_ZOOM, 6);
	});

	it("a highlight on the first line prints as today, not as one shrunk page", () => {
		const out = exportNote([NEAR, highlight("hl", 100, 300, 12)], LETTER_PORTRAIT, PAPER_W, FOOT);
		expect(out.paddingTop, "no top reach").toBeUndefined();
		expect(out.zoom, "the width fit").toBeCloseTo(WIDTH_ZOOM, 6);
	});
});

describe("a one-page export printed on a shorter page than the saved settings", () => {
	// Ink two thousand px below a short text: the note exports as one page fitted to the page's height.
	const strokes = (): InkStroke[] => [NEAR, boxStroke("below", 20, 120, 2000, 2100)];

	it("Letter portrait saved, Letter landscape printed: the zoom fits the landscape page's height", () => {
		// What the same export fits to when the landscape page is the one saved: the reference zoom for that page.
		const ref = exportNote(strokes(), LETTER_LANDSCAPE, paperWidthFor(LETTER_LANDSCAPE)!, 300);
		expect(ref.zoom).toBeLessThan(1);
		const stale = exportNote(strokes(), LETTER_PORTRAIT, paperWidthFor(LETTER_LANDSCAPE)!, 300);
		expect(stale.zoom, `kept ${stale.zoom} against the landscape fit ${ref.zoom}`).toBeLessThanOrEqual(ref.zoom + 1e-9);
	});

	it("A4 portrait saved, Letter portrait printed: the zoom fits the Letter page's height", () => {
		const ref = exportNote(strokes(), LETTER_PORTRAIT, paperWidthFor(LETTER_PORTRAIT)!, 300);
		expect(ref.zoom).toBeLessThan(1);
		const stale = exportNote(strokes(), A4_PORTRAIT, paperWidthFor(LETTER_PORTRAIT)!, 300);
		expect(stale.zoom, `kept ${stale.zoom} against the Letter fit ${ref.zoom}`).toBeLessThanOrEqual(ref.zoom + 1e-9);
	});
});

describe("the text foot of a canvas note is its text's, not the print container's box", () => {
	// The app's print container has a fixed box (800 px in the app, whatever the text's length); the text runs past it. Each
	// block is one line, LINE px tall, the first at the column-width top: the text's foot is TOP_AT_COLUMN + lines * LINE.
	const LINE = 20;
	const PAPER_W = paperWidthFor(LETTER_PORTRAIT)!;
	const PAGE = paperHeightFor(LETTER_PORTRAIT)!;
	const WIDTH_ZOOM = PAPER_W / (64 + 700);
	/** The one-page limit past the text's foot: one page at the width fit, which wantsOnePage caps at 1. */
	const LIMIT = PAGE / Math.min(1, WIDTH_ZOOM);

	/** One export of a note `lines` lines long in a container whose box is `box` px (grown only by our min-height). */
	function exportText(strokes: InkStroke[], lines: number, box: number, laidOut?: (root: FEl) => void): Exported {
		const fdoc = new FDoc();
		doc = fdoc;
		ink = strokes;
		initEmbedInkPrintCanvas(() => true);
		initEmbedInkPrintPaper(() => LETTER_PORTRAIT);
		const { root, block } = printContainer(fdoc, PAPER_W, 700, true);
		block.offsetHeight = LINE;
		for (let i = 1; i < lines; i++) {
			const b = root.appendChild(new FEl("div", fdoc));
			b.offsetParent = root;
			b.offsetLeft = 32;
			b.offsetHeight = LINE;
			Object.defineProperty(b, "offsetTop", { get: () => block.offsetTop + i * LINE });
		}
		heightFollowsMinHeight(root, box);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		laidOut?.(root);
		fdoc.printMedia = false;
		fdoc.fire("beforeprint");
		fdoc.printMedia = true;
		root.offsetWidth = PAPER_W;
		fdoc.fire("beforeprint");
		return { root, zoom: Number(root.style.zoom), paddingLeft: root.style.paddingLeft, paddingTop: root.style.paddingTop };
	}
	/** A stroke on the last of `lines` lines, world y from the first line's top. */
	const onLastLine = (lines: number): InkStroke => boxStroke("last", 40, 300, (lines - 1) * LINE + 2, (lines - 1) * LINE + 18);
	const fullSize = (out: Exported, what: string): void => {
		expect(out.paddingTop, `${what}: no top reach`).toBeUndefined();
		expect(out.zoom, `${what}: the width fit, not one shrunk page`).toBeCloseTo(WIDTH_ZOOM, 6);
	};

	it("premise: the fixture's text foot passes an 800 px box plus a page at 151 lines, not at 51", () => {
		expect(TOP_AT_COLUMN + 151 * LINE).toBeGreaterThan(800 + LIMIT);
		expect(TOP_AT_COLUMN + 51 * LINE).toBeLessThan(800 + LIMIT);
	});

	it("a box shorter than its text: ink on the text's last line prints full size", () => {
		const lines = 100;
		fullSize(exportText([NEAR, onLastLine(lines)], lines, 800), `box 800, text foot ${TOP_AT_COLUMN + lines * LINE}`);
	});

	it("a box taller than its text: ink far below a short text makes one page", () => {
		const out = exportText([NEAR, boxStroke("below", 20, 120, 2000, 2100)], 3, 4000);
		expect(out.zoom, `box 4000, text foot ${TOP_AT_COLUMN + 3 * LINE}, ink foot past it plus a page`).toBeLessThan(WIDTH_ZOOM - 1e-6);
	});

	it("the foot does not follow our min-height: ink far below a short text in a box that is only the min-height makes one page", () => {
		const out = exportText([NEAR, boxStroke("below", 20, 120, 2000, 2100)], 3, 0);
		expect(out.zoom, `text foot ${TOP_AT_COLUMN + 3 * LINE}, the container grown to the ink`).toBeLessThan(WIDTH_ZOOM - 1e-6);
	});

	it("the foot does not follow the ink layer: a laid-out canvas as tall as the ink is not text", () => {
		const out = exportText([NEAR, boxStroke("below", 20, 120, 2000, 2100)], 3, 0, (root) => {
			const layer = root.children.find((c) => c.tag === "canvas" && c.classList.contains("handwriting-embed-ink"));
			expect(layer, "the paint's canvas layer").toBeDefined();
			layer!.offsetParent = root;
			layer!.offsetTop = 0;
			layer!.offsetHeight = TOP_AT_COLUMN + 2200;
		});
		expect(out.zoom, `text foot ${TOP_AT_COLUMN + 3 * LINE}, the layer reaching ${TOP_AT_COLUMN + 2200}`).toBeLessThan(WIDTH_ZOOM - 1e-6);
	});

	it.each([3, 51, 151, 301])("a canvas note of %i lines, an 800 px box, ink on its last line: full size", (lines) => {
		fullSize(exportText([NEAR, onLastLine(lines)], lines, 800), `${lines} lines`);
	});

	/**
	 * One export of a canvas note with no laid-out block: its title only (an h1, TITLE_TOP to TITLE_FOOT) or nothing at all,
	 * in the app's fixed 800 px box, the box taller than the title. The text's foot is the title's bottom, or 0 with no title.
	 */
	const TITLE_TOP = 20;
	const TITLE_FOOT = TITLE_TOP + 40;
	function exportNoBlock(strokes: InkStroke[], title: boolean): Exported & { h1: FEl | null } {
		const fdoc = new FDoc();
		doc = fdoc;
		ink = strokes;
		initEmbedInkPrintCanvas(() => true);
		initEmbedInkPrintPaper(() => LETTER_PORTRAIT);
		const root = new FEl("div", fdoc);
		root.attrs.set("class", "markdown-preview-view markdown-rendered");
		root.offsetParent = {};
		root.offsetWidth = PAPER_W;
		root.offsetHeight = 800;
		let h1: FEl | null = null;
		if (title) {
			h1 = root.appendChild(new FEl("h1", fdoc));
			h1.offsetParent = root;
			h1.offsetLeft = 32;
			h1.offsetTop = TITLE_TOP;
			h1.offsetHeight = TITLE_FOOT - TITLE_TOP;
		}
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		fdoc.printMedia = false;
		fdoc.fire("beforeprint");
		fdoc.printMedia = true;
		root.offsetWidth = PAPER_W;
		fdoc.fire("beforeprint");
		return { root, h1, zoom: Number(root.style.zoom), paddingLeft: root.style.paddingLeft, paddingTop: root.style.paddingTop };
	}
	/** Ink 1300 to 1400 below the note's top: past the title's foot (or 0) plus a page, short of the 800 px box plus a page. */
	const BELOW_TITLE = boxStroke("below", 20, 120, 1300, 1400);

	it("premise: ink below a title-only note passes the title's foot plus a page, not the 800 px box plus a page", () => {
		expect(TITLE_FOOT + 1300).toBeGreaterThan(TITLE_FOOT + LIMIT);
		expect(TITLE_FOOT + 1400 + PAD).toBeLessThan(800 + LIMIT);
	});

	it("control: a title-only canvas note, ink on the title's page: full size", () => {
		fullSize(exportNoBlock([NEAR, boxStroke("near-title", 20, 120, 200, 300)], true), `title foot ${TITLE_FOOT}, ink 200 to 300`);
	});

	it("a title-only canvas note, its box taller than the title, ink below it: the foot is the title's, one page", () => {
		const out = exportNoBlock([NEAR, BELOW_TITLE], true);
		expect(out.root.querySelector(":scope > h1"), "premise: the title is the container's h1").toBe(out.h1);
		expect(out.zoom, `title foot ${TITLE_FOOT}, box 800, ink foot past the title's foot plus a page`).toBeLessThan(WIDTH_ZOOM - 1e-6);
	});

	it("an empty canvas note, no title and no block, its box 800, ink below: the foot is 0, one page", () => {
		const out = exportNoBlock([NEAR, BELOW_TITLE], false);
		expect(out.root.querySelector(":scope > h1"), "premise: no title").toBeNull();
		expect(out.root.children.filter((c) => c.offsetParent === out.root).length, "premise: no block of text laid out").toBe(0);
		expect(out.zoom, "text foot 0, box 800, ink foot past a page").toBeLessThan(WIDTH_ZOOM - 1e-6);
	});

	it("a one-page export holds all the text: the one-page box is no shorter than the text's foot", () => {
		const lines = 151;
		const textFoot = TOP_AT_COLUMN + lines * LINE;
		const out = exportText([NEAR, boxStroke("left", -200, -120, 100, 200)], lines, 800);
		expect(out.paddingLeft, "the ink left of the text makes one page").toBeDefined();
		expect(out.zoom, `zoom ${out.zoom}, the text's foot ${textFoot} fits at ${PAGE / textFoot}`).toBeLessThanOrEqual(PAGE / textFoot + 1e-9);
	});
});
