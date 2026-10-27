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
import { holdLineAnchors, InkStroke, releaseLineAnchors } from "../ink/Stroke";
import { lineKey } from "./LineAnchor";
import { recordLines } from "./EmbedInkMeasure";
import pluginOnloadSource from "../PluginOnload.ts?raw";
import registrySource from "./InkOverlayRegistry.ts?raw";
import { ribbonOf } from "../ink/StrokeOutline";

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

describe("a print lays the note out at its screen column width and shrinks it to the paper", () => {
	it("sets the container to the column width (border box: plus the padding) and zooms it to the paper", () => {
		const { root } = print(739);
		expect(root.style.width, "the text wraps at the column, not at the paper").toBe("764px");
		expect(Number(root.style.zoom)).toBeCloseTo(739 / 764, 5);
		expect(root.style.overflow, "no scrollbar to take 15 px off the text width").toBe("visible");
	});

	it("takes the box model from the theme: a content box gets the column width alone", () => {
		doc.computed = { position: "relative", paddingLeft: "32px", paddingRight: "32px", boxSizing: "content-box" };
		const { root } = print(739);
		expect(root.style.width).toBe("700px");
		expect(Number(root.style.zoom)).toBeCloseTo(739 / 764, 5);
	});

	it("never zooms past 1: a paper wider than the column keeps the column width at full size", () => {
		const { root } = print(1200);
		expect(root.style.width).toBe("764px");
		expect(root.style.zoom === undefined || Number(root.style.zoom) === 1, "no enlargement").toBe(true);
	});

	it("zooms to the ink when it runs past the column (ink right of the text is not cut)", () => {
		ink = [stroke("a", 20, 900)];
		const { root } = print(739);
		const inkRight = 900;
		expect(root.style.width, "the text still wraps at the column").toBe("764px");
		expect(Number(root.style.zoom)).toBeCloseTo(739 / (inkRight + 16 + 64), 5);
	});

	it("follows ink that grows past the column while the print runs", () => {
		const { root } = print(739);
		const before = Number(root.style.zoom);
		ink = [stroke("a", 20, 1400)];
		embedInkChanged("a.md");
		expect(Number(root.style.zoom), "wider ink, smaller zoom").toBeLessThan(before);
		expect(Number(root.style.zoom)).toBeCloseTo(739 / (1400 + 16 + 64), 5);
		expect(root.style.width).toBe("764px");
	});

	it("measures the anchor after the width is set, so the layer sits at the re-laid-out text", () => {
		const { root } = print(739);
		const svg = root.querySelector(":scope > svg.handwriting-embed-ink");
		expect(svg, "premise: the print swap built a vector layer").not.toBeNull();
		expect(svg!.style.top, "the first block's top at the column width, not at the paper width").toBe(`${TOP_AT_COLUMN}px`);
	});
});

describe("the paper is measured in the print layout", () => {
	it("a beforeprint in the screen layout sets the column's width and no zoom; the print layout that follows measures the paper", () => {
		const { root } = printContainer(doc, 816);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		doc.printMedia = false;
		doc.fire("beforeprint");
		expect(root.style.width, "the print counts its pages from the width the container has as the media flips").toBe("764px");
		expect(root.style.zoom, "the screen layout is not the paper").toBeUndefined();
		doc.printMedia = true;
		root.offsetWidth = 739;
		doc.fire("beforeprint");
		expect(root.style.width).toBe("764px");
		expect(Number(root.style.zoom), "zoomed to the print layout's 739, not the screen's 816").toBeCloseTo(739 / 764, 5);
	});
});

describe("the print layout goes back when the print ends", () => {
	it("afterprint puts the container's own width and zoom back", () => {
		const { root } = printContainer(doc, 739);
		root.style.width = "auto";
		root.style.zoom = "1";
		root.style.overflow = "auto";
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		doc.fire("beforeprint");
		expect(root.style.width, "premise: the print changed the width").toBe("764px");
		doc.fire("afterprint");
		expect(root.style.width).toBe("auto");
		expect(root.style.zoom).toBe("1");
		expect(root.style.overflow).toBe("auto");
	});

	it("afterprint takes off a width and zoom the container did not have", () => {
		const { root } = print(739);
		doc.fire("afterprint");
		expect(root.style.width).toBeUndefined();
		expect(root.style.zoom).toBeUndefined();
		expect(root.style.overflow).toBeUndefined();
	});

	it("a second print starts from the container's own layout, not from the first one's", () => {
		const { root } = print(739);
		doc.fire("afterprint");
		root.offsetWidth = 600;
		doc.fire("beforeprint");
		expect(Number(root.style.zoom)).toBeCloseTo(600 / 764, 5);
	});
});

describe("a print that has no column width keeps today's layout", () => {
	it("a provider with no answer changes nothing", () => {
		initEmbedInkColumnWidth(() => null);
		const { root } = print(739);
		expect(root.style.width).toBeUndefined();
		expect(root.style.zoom).toBeUndefined();
		expect(root.querySelector(":scope > svg.handwriting-embed-ink"), "the ink still prints").not.toBeNull();
	});

	it("a width that is not a positive number changes nothing", () => {
		for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
			initEmbedInkColumnWidth(() => bad);
			const { root } = print(739);
			expect(root.style.width, `width ${bad}`).toBeUndefined();
			expect(root.style.zoom, `width ${bad}`).toBeUndefined();
			doc.fire("afterprint");
		}
	});

	it("no provider registered changes nothing", () => {
		teardownEmbedInk();
		initEmbedInkRefresh(() => ink);
		const { root } = print(739);
		expect(root.style.width).toBeUndefined();
		expect(root.style.zoom).toBeUndefined();
	});

	it("a container that is not laid out is left alone", () => {
		const { root } = printContainer(doc, 739);
		root.offsetParent = null;
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		doc.fire("beforeprint");
		expect(root.style.width).toBeUndefined();
		expect(root.style.zoom).toBeUndefined();
	});

	it("an embed's content box is never resized", () => {
		const root = new FEl("div", doc);
		root.attrs.set("class", "markdown-embed-content");
		root.offsetWidth = 400;
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		doc.fire("beforeprint");
		expect(root.style.width).toBeUndefined();
		expect(root.style.zoom).toBeUndefined();
	});
});

describe("the column width a print lays out at", () => {
	it("takes the editor's column box when it has one", () => {
		expect(printColumnWidth(700, 650)).toBe(700);
	});
	it("falls through to the first line's width when the column box is 0", () => {
		expect(printColumnWidth(0, 650)).toBe(650);
	});
	it("falls through when there is no column box", () => {
		expect(printColumnWidth(undefined, 650)).toBe(650);
		expect(printColumnWidth(null, 650)).toBe(650);
	});
	it("has no answer when neither has width", () => {
		expect(printColumnWidth(0, 0)).toBeNull();
		expect(printColumnWidth(undefined, null)).toBeNull();
		expect(printColumnWidth(0, Number.NaN)).toBeNull();
	});
});

/** A stroke from `y0` to `y1` down the left of the page (the width fixtures above draw a short one near the top). */
function tall(id: string, y0: number, y1: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 40, y: y0, pressure: 0.5, t: 0 },
			{ x: 40, y: y1, pressure: 0.5, t: 8 },
		],
		bbox: { x: 40, y: y0, width: 2, height: y1 - y0 },
		createdAt: 0,
	} as InkStroke;
}

/** Block tops relative to the first block at the screen call, and where the paged print layout puts them. */
const SCREEN_SPANS = [0, 100, 200];
const PAGED_TOPS = [0, 130, 260];
const FIRST_TOP = 100;

/**
 * A print container of three blocks. The tops answer as the screen flow only while the print media is off and the
 * width is the column's; with the media on they answer as the paged layout, where the second and third blocks sit
 * lower by the space left at the foot of a page. Every read made in the screen layout records the width it saw.
 */
function blockContainer(doc: FDoc, paper: number): { root: FEl; blocks: FEl[]; widthsAtRead: Array<string | undefined> } {
	const root = new FEl("div", doc);
	root.attrs.set("class", "markdown-preview-view markdown-rendered");
	root.offsetParent = {};
	root.offsetWidth = paper;
	const widthsAtRead: Array<string | undefined> = [];
	const blocks = SCREEN_SPANS.map((_top, i) => {
		const block = root.appendChild(new FEl("div", doc));
		block.offsetParent = root;
		block.offsetLeft = 32;
		Object.defineProperty(block, "offsetTop", {
			get: () => {
				if (doc.printMedia) return FIRST_TOP + PAGED_TOPS[i]!;
				widthsAtRead.push(root.style.width);
				return FIRST_TOP + SCREEN_SPANS[i]!;
			},
		});
		block.getBoundingClientRect = () => {
			const top = FIRST_TOP + PAGED_TOPS[i]!;
			return { left: 0, top, width: 700, height: 24, bottom: top + 24 };
		};
		return block;
	});
	return { root, blocks, widthsAtRead };
}

function stripsOf(block: FEl): FEl[] {
	return block.children.filter((c) => c.attrs.get("class") === "handwriting-embed-ink-strip");
}

/** The screen call, then the print-media call, as Chromium makes them for one export. */
function exportCalls(root: FEl, paper = 739): void {
	doc.printMedia = false;
	doc.fire("beforeprint");
	doc.printMedia = true;
	root.offsetWidth = paper;
	doc.fire("beforeprint");
}

describe("the ink follows its block across a page break", () => {
	beforeEach(() => {
		ink = [tall("a", 50, 150)];
		initEmbedInkRefresh(() => ink);
	});

	it("holds every block's top at the screen call, after the width is set, and keeps the width for the print", () => {
		const { root, widthsAtRead } = blockContainer(doc, 816);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		root.style.overflow = "auto";
		doc.printMedia = false;
		doc.fire("beforeprint");
		expect(widthsAtRead.length, "the block tops were read at the screen call").toBeGreaterThanOrEqual(3);
		expect(widthsAtRead.slice(0, 3), "the three held reads each saw the column's width").toEqual(["764px", "764px", "764px"]);
		expect(root.style.width, "the column's width stays through the media flip").toBe("764px");
		expect(root.style.overflow, "with no scrollbar to take width off the text").toBe("visible");
		expect(root.style.zoom, "nothing is zoomed before the paper is known").toBeUndefined();
		doc.fire("afterprint");
		expect(root.style.width, "a print that never flips the media still gives the layout back").toBeUndefined();
		expect(root.style.overflow, "and the container's own overflow").toBe("auto");
	});

	it("reads the paper at the print-media call with the container's own width, then puts the column's back", () => {
		const { root } = blockContainer(doc, 816);
		root.style.width = "auto";
		const seen: Array<string | undefined> = [];
		Object.defineProperty(root, "offsetWidth", {
			get: () => {
				if (doc.printMedia) seen.push(root.style.width);
				return 739;
			},
		});
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		doc.printMedia = false;
		doc.fire("beforeprint");
		doc.printMedia = true;
		doc.fire("beforeprint");
		// The column inset read (`columnInset`) also reads this width in the print layout, so there is more than the one paper read:
		// every read of it sees the container's own width, none the column's.
		expect(seen.length, "the paper was read").toBeGreaterThan(0);
		expect(new Set(seen), "the paper read saw the container's own width").toEqual(new Set(["auto"]));
		expect(root.style.width, "the column's width is back after it").toBe("764px");
		expect(Number(root.style.zoom)).toBeCloseTo(739 / 764, 5);
	});

	it("cuts the layer into one strip per block that meets the ink, from the held spans", () => {
		const { root, blocks } = blockContainer(doc, 816);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		exportCalls(root);
		const box = embedInkBounds(ink);
		const svg = root.querySelector(":scope > svg.handwriting-embed-ink")!;
		const boxLeft = parseFloat(svg.style.left!);
		const first = stripsOf(blocks[0]!);
		const second = stripsOf(blocks[1]!);
		expect(first.length, "the first block holds a strip").toBe(1);
		expect(second.length, "the second block holds a strip").toBe(1);
		expect(first[0]!.getAttribute("viewBox"), "the first span runs from the top of the ink to the second block's held top").toBe(`${box.x} ${box.y} ${box.w} ${SCREEN_SPANS[1]! - box.y}`);
		expect(first[0]!.style.top, "placed at the span start inside the block").toBe(`${box.y - SCREEN_SPANS[0]!}px`);
		expect(first[0]!.style.left, "left at the layer's own left").toBe(`${boxLeft - 32}px`);
		expect(second[0]!.getAttribute("viewBox"), "the second span runs from its held top to the foot of the ink").toBe(`${box.x} ${SCREEN_SPANS[1]!} ${box.w} ${box.y + box.h - SCREEN_SPANS[1]!}`);
		expect(second[0]!.style.top).toBe("0px");
		expect(first[0]!.style.position, "position comes from the stylesheet's strip class, not an inline style").toBeUndefined();
		expect(first[0]!.style.pointerEvents).toBeUndefined();
		expect(svg.classList.contains("is-stripped"), "the one box is hidden by class while strips stand").toBe(true);
		expect(svg.style.display, "and not by an inline style").toBeUndefined();
		for (const b of [blocks[0]!, blocks[1]!]) {
			expect(b.style.position, "strips are placed inside a positioned block").toBe("relative");
			expect(b.style.breakInside, "its lines move whole to the next page").toBe("avoid");
		}
	});

	it("builds each strip from only the strokes that meet its span, a stroke across two blocks in both", () => {
		const colored = (id: string, y0: number, y1: number, color: string): InkStroke => ({ ...tall(id, y0, y1), color });
		ink = [colored("a", 50, 90, "#ff0000"), colored("c", 80, 130, "#00aa00"), colored("b", 120, 180, "#0000ff"), colored("d", 250, 300, "#aa00aa")];
		initEmbedInkRefresh(() => ink);
		const { root, blocks } = blockContainer(doc, 816);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		exportCalls(root);
		const pathsIn = (block: FEl): string[] => stripsOf(block).flatMap((s) => s.children.filter((c) => c.tag === "path").map((p) => p.getAttribute("fill")!));
		expect(pathsIn(blocks[0]!).length, "first span [50,100): a and c").toBe(2);
		expect(pathsIn(blocks[1]!).length, "second span [100,200): c and b").toBe(2);
		expect(pathsIn(blocks[2]!).length, "third span [200,300]: d only").toBe(1);
		const [first, second, third] = [pathsIn(blocks[0]!), pathsIn(blocks[1]!), pathsIn(blocks[2]!)];
		const across = first.filter((f) => second.includes(f));
		expect(across.length, "exactly one colour, the stroke across the break, is in both strips").toBe(1);
		expect(third.some((f) => first.includes(f) || second.includes(f)), "d's colour is in no earlier strip").toBe(false);
	});

	it("cuts from the screen spans, not from where the paged layout put the blocks", () => {
		const { root, blocks } = blockContainer(doc, 816);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		exportCalls(root);
		expect(PAGED_TOPS[1], "premise: the paged layout reads the second block lower").not.toBe(SCREEN_SPANS[1]);
		expect(stripsOf(blocks[0]!)[0]!.getAttribute("viewBox")!.split(" ")[3], "the first span ends at the held top").toBe(`${SCREEN_SPANS[1]! - embedInkBounds(ink).y}`);
	});

	it("gives a block whose span meets no ink no strip, though its lines still stay together", () => {
		const { root, blocks } = blockContainer(doc, 816);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		exportCalls(root);
		expect(stripsOf(blocks[2]!).length).toBe(0);
		expect(blocks[2]!.style.breakInside, "every block moves whole, so the page count holds").toBe("avoid");
	});

	it("keeps the lines of every block together from the screen call on, before the print media flips", () => {
		const { root, blocks } = blockContainer(doc, 816);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		doc.printMedia = false;
		doc.fire("beforeprint");
		for (const b of blocks) {
			expect(b.style.breakInside, "the print takes its page count from the layout made as the media flips").toBe("avoid");
			expect(b.style.position).toBe("relative");
		}
		expect(blocks.flatMap(stripsOf).length, "strips wait for the print media").toBe(0);
		doc.fire("afterprint");
		for (const b of blocks) {
			expect(b.style.breakInside).toBeUndefined();
			expect(b.style.position).toBeUndefined();
		}
	});

	it("keeps the one box when no spans were held (the print media came first), and says so", () => {
		const lines: string[] = [];
		initEmbedInkDiagnostics((via, path, waited) => lines.push(embedInkDiagLine(via, path, waited)));
		const { root, blocks } = blockContainer(doc, 739);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		doc.printMedia = true;
		doc.fire("beforeprint");
		expect(blocks.flatMap(stripsOf).length).toBe(0);
		const svg = root.querySelector(":scope > svg.handwriting-embed-ink")!;
		expect(svg, "the single layer is built").not.toBeNull();
		expect(svg.classList.contains("is-stripped"), "and shown").toBe(false);
		expect(blocks[0]!.style.position).toBeUndefined();
		expect(lines.at(-1)).toContain("spans=none");
		expect(lines.at(-1)).toContain("strips=0");
	});

	it("keeps the one box when the block count changed between the calls", () => {
		const { root, blocks } = blockContainer(doc, 816);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		doc.printMedia = false;
		doc.fire("beforeprint");
		blocks[2]!.offsetParent = null;
		doc.printMedia = true;
		root.offsetWidth = 739;
		doc.fire("beforeprint");
		expect(blocks.flatMap(stripsOf).length).toBe(0);
		expect(root.querySelector(":scope > svg.handwriting-embed-ink")!.classList.contains("is-stripped")).toBe(false);
	});

	it("names the call, the spans, the blocks, the strips, the zoom, the paper, the column and the swaps in one line", () => {
		const lines: string[] = [];
		initEmbedInkDiagnostics((via, path, waited) => lines.push(embedInkDiagLine(via, path, waited)));
		const { root } = blockContainer(doc, 816);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		doc.printMedia = false;
		doc.fire("beforeprint");
		const swaps = embedInkPrintSwaps();
		expect(lines.at(-1)).toBe(`[handwriting] export fit phase=screen spans=held blocks=3 strips=0 zoom=- paper=- column=- swaps=${swaps}: a.md`);
		doc.printMedia = true;
		root.offsetWidth = 739;
		doc.fire("beforeprint");
		const zoom = Math.round((739 / 764) * 1000) / 1000;
		expect(lines.at(-1)).toBe(`[handwriting] export fit phase=print spans=held blocks=3 strips=2 zoom=${zoom} paper=739 column=700 swaps=${embedInkPrintSwaps()}: a.md`);
	});

	it("takes everything off at afterprint: strips, block styles, the box, the width and the zoom", () => {
		const { root, blocks } = blockContainer(doc, 816);
		blocks[0]!.style.position = "sticky";
		blocks[0]!.style.breakInside = "auto";
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		exportCalls(root);
		expect(blocks.flatMap(stripsOf).length, "premise: strips stand during the print").toBe(2);
		doc.fire("afterprint");
		expect(blocks.flatMap(stripsOf).length).toBe(0);
		expect(blocks[0]!.style.position, "the block's own position is back").toBe("sticky");
		expect(blocks[0]!.style.breakInside).toBe("auto");
		expect(blocks[1]!.style.position).toBeUndefined();
		expect(blocks[1]!.style.breakInside).toBeUndefined();
		expect(root.style.width).toBeUndefined();
		expect(root.style.zoom).toBeUndefined();
		expect(root.querySelector(":scope > svg.handwriting-embed-ink"), "the layer is gone with the print").toBeNull();
	});

	it("gives the box back at teardown too: no strips, no hidden box, the blocks as they were", () => {
		const { root, blocks } = blockContainer(doc, 816);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		exportCalls(root);
		const svg = root.querySelector(":scope > svg.handwriting-embed-ink")!;
		expect(svg.classList.contains("is-stripped"), "premise: hidden while strips stand").toBe(true);
		teardownEmbedInk();
		expect(blocks.flatMap(stripsOf).length).toBe(0);
		expect(svg.classList.contains("is-stripped")).toBe(false);
		expect(root.querySelector(":scope > svg.handwriting-embed-ink")).toBeNull();
		expect(blocks[0]!.style.breakInside).toBeUndefined();
	});

	it("forgets the held spans at afterprint, so a print whose screen call never came keeps the box", () => {
		const { root, blocks } = blockContainer(doc, 816);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		exportCalls(root);
		doc.fire("afterprint");
		doc.printMedia = true;
		root.offsetWidth = 739;
		doc.fire("beforeprint");
		expect(blocks.flatMap(stripsOf).length, "no strips from the last print's spans").toBe(0);
	});

	it("rebuilds the strips when the ink changes under the print, without stacking them", () => {
		const { root, blocks } = blockContainer(doc, 816);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		exportCalls(root);
		ink = [tall("a", 50, 250)];
		embedInkChanged("a.md");
		expect(blocks.map((b) => stripsOf(b).length), "one strip per block that meets the longer ink").toEqual([1, 1, 1]);
	});
});

describe("the swap count, the disarm map, the zoom cap in the export line, and a print container without a box", () => {
	it("counts one swap for each beforeprint and none for afterprint", () => {
		const start = embedInkPrintSwaps();
		print(739);
		expect(embedInkPrintSwaps() - start, "one beforeprint, one swap").toBe(1);
		doc.fire("afterprint");
		expect(embedInkPrintSwaps() - start, "afterprint is not a swap").toBe(1);
		doc.fire("beforeprint");
		expect(embedInkPrintSwaps() - start, "the second print is the second swap").toBe(2);
	});

	it("empties the disarm map at the first disarm: a second one finds no callbacks to run", () => {
		let removed = 0;
		const view = doc.defaultView;
		const remove = view.removeEventListener;
		view.removeEventListener = (type, fn) => {
			removed++;
			remove(type, fn);
		};
		print(739);
		expect(doc.listeners.get("beforeprint")?.length, "premise: the window is armed").toBe(1);
		disarmPrintSwaps();
		expect(removed, "beforeprint, afterprint and pagehide come off").toBe(3);
		expect(doc.listeners.get("beforeprint")).toEqual([]);
		disarmPrintSwaps();
		expect(removed, "nothing is left to remove the second time").toBe(3);
	});

	it("reports zoom 1 in the export line when the paper is wider than the note wants", () => {
		const lines: string[] = [];
		initEmbedInkDiagnostics((via, path, waited) => lines.push(embedInkDiagLine(via, path, waited)));
		print(1200);
		expect(lines.at(-1), "full size, not 1200 / 764").toContain("zoom=1 paper=1200 column=700");
	});

	it("leaves a print container without a box ungrown, and grows the same container once it has one", () => {
		const { root } = printContainer(doc, 739);
		root.offsetParent = null;
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		doc.fire("beforeprint");
		expect(root.style.minHeight, "no box, no anchor to measure from").toBeUndefined();
		expect(root.getAttribute(MIN_HEIGHT_ATTR)).toBeNull();
		root.offsetParent = {};
		embedInkChanged("a.md");
		expect(root.style.minHeight, "premise: a laid-out print container does grow").toBeDefined();
		expect(root.getAttribute(MIN_HEIGHT_ATTR)).toBe(root.style.minHeight);
	});
});

/**
 * Text at half the note's reference font: the screen draws the ink at its text's size (world units through a camera
 * at s = 13 / 26 = 0.5), so paper must too. The svg box is px at s, its viewBox the same box in world units, the paths
 * the stored strokes as they are; the fit, the container's growth and the strips are in the same px.
 */
describe("a print draws the ink at its text's size, as the screen does", () => {
	const S = 0.5;
	beforeEach(() => {
		doc.computed = { ...doc.computed, fontSize: "13px" };
		embedInk.initEmbedInkFontRef?.(() => 26);
	});

	const pathDs = (svg: FEl): string[] => svg.children.filter((c) => c.tag === "path").map((p) => p.getAttribute("d")!);

	it("sizes the svg at s with its viewBox in world units, grows the container by that height, and keeps the paths", () => {
		const { root } = print(739);
		const svg = root.querySelector(":scope > svg.handwriting-embed-ink")!;
		// The stroke's world box 0..600 by 0..20 (the layer starts at the origin): 300 by 10 px at s.
		expect(svg.getAttribute("width"), "px at s").toBe(`${600 * S}`);
		expect(svg.getAttribute("height")).toBe(`${20 * S}`);
		expect(svg.getAttribute("viewBox"), "world units").toBe("0 0 600 20");
		expect(root.style.minHeight, "the foot of the layer at s").toBe(`${TOP_AT_COLUMN + 20 * S}px`);
		const at = pathDs(svg);
		doc.fire("afterprint");
		teardownEmbedInk();
		initEmbedInkRefresh(() => ink);
		initEmbedInkColumnWidth(() => 700);
		doc = new FDoc();
		const plain = print(739).root.querySelector(":scope > svg.handwriting-embed-ink")!;
		expect(at, "the stored strokes as they are: the camera maps them, the shape is the editor's").toEqual(pathDs(plain));
	});

	it("fits the column to the ink's right edge at s: column 700, stored right 1000, wanted from 500, zoom 1", () => {
		ink = [stroke("a", 20, 1000)];
		const { root } = print(800);
		expect(root.style.width).toBe("764px");
		expect(root.style.zoom, "500 + 16 fits in the 700 column: wanted 764, paper 800, no zoom").toBeUndefined();
		ink = [stroke("a", 20, 1600)];
		embedInkChanged("a.md");
		expect(Number(root.style.zoom), "stored right 1600 is 800 px at s").toBeCloseTo(800 / (1600 * S + 16 + 64), 5);
	});

	it("cuts the strips in px at s, each drawing world units, from the strokes that meet its span at s", () => {
		const colored = (id: string, y0: number, y1: number, color: string): InkStroke => ({ ...tall(id, y0, y1), color });
		// World 50..150 and 300..360 are px 25..75 and 150..180 at s: one stroke in each of the first two blocks.
		ink = [colored("a", 50, 150, "#ff0000"), colored("b", 300, 360, "#0000ff")];
		initEmbedInkRefresh(() => ink);
		const { root, blocks } = blockContainer(doc, 816);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		exportCalls(root);
		const strips = blocks.map(stripsOf);
		expect(strips.map((s) => s.length), "the ink's foot is 180 px: the third block meets none").toEqual([1, 1, 0]);
		const [first, second] = [strips[0]![0]!, strips[1]![0]!];
		// The layer's px box is 0..21 by 0..180; the first span 0..100 px, the second 100..180 px.
		expect(first.getAttribute("viewBox"), "the span in world units").toBe("0 0 42 200");
		expect(first.getAttribute("width")).toBe("21");
		expect(first.getAttribute("height")).toBe("100");
		expect(second.getAttribute("viewBox")).toBe("0 200 42 160");
		expect(second.getAttribute("height")).toBe("80");
		expect(second.style.top, "placed at the span's start in px").toBe("0px");
		const fills = (strip: FEl): string[] => strip.children.filter((c) => c.tag === "path").map((p) => p.getAttribute("fill")!);
		expect(fills(first).length, "a only").toBe(1);
		expect(fills(second).length, "b only").toBe(1);
		expect(fills(first)[0], "a different stroke in each strip").not.toBe(fills(second)[0]);
	});
});

/** A stroke over the box x0..x1, y0..y1. */
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

const NEAR = boxStroke("near", 20, 600, 10, 20);
const FAR_RIGHT = boxStroke("far-right", 70_000, 70_100, 10, 20);
const FAR_BELOW = boxStroke("far-below", 20, 120, 110_000, 110_040);

/**
 * A container is as tall as its text or its min-height, whichever is more, as a real one is. The canvas paint that runs
 * when the note is attached has already grown the container to the foot of the far ink by the time the print starts.
 */
function heightFollowsMinHeight(root: FEl, text: number): void {
	Object.defineProperty(root, "offsetHeight", { get: () => Math.max(text, Number.parseFloat(root.style.minHeight ?? "") || 0) });
	// The canvas the paint laid out is as tall as all the ink and overflows the box: the scroll height reaches its foot.
	Object.defineProperty(root, "scrollHeight", { get: () => Math.max(root.offsetHeight, 120_000) });
}

describe("without saved settings, an Infinite Canvas note is fitted in width alone", () => {
	const TEXT_FOOT = 300;

	/** What one export of the note measured, read at once: a window that printed answers the next print for its roots too. */
	function canvasPrint(strokes: InkStroke[], canvas: boolean): { zoom: number; minHeight: string | undefined; svg: { width: string | null; height: string | null; viewBox: string | null } | null } {
		doc = new FDoc();
		ink = strokes;
		initEmbedInkPrintCanvas(() => canvas);
		const { root } = printContainer(doc, 739);
		heightFollowsMinHeight(root, TEXT_FOOT);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		doc.fire("beforeprint");
		const svg = root.querySelector(":scope > svg.handwriting-embed-ink");
		return {
			zoom: Number(root.style.zoom),
			minHeight: root.style.minHeight,
			svg: svg ? { width: svg.getAttribute("width"), height: svg.getAttribute("height"), viewBox: svg.getAttribute("viewBox") } : null,
		};
	}

	it("counts a stroke that crosses the column's edge at its whole width", () => {
		const across = boxStroke("across", 650, 800, 280, 340);
		const printed = canvasPrint([NEAR, across], true);
		expect(printed.svg, "premise").not.toBeNull();
		expect(printed.zoom, "a crossing stroke counts at its whole width").toBeCloseTo(739 / (800 + 16 + 64), 5);
	});

	it("a note without Infinite Canvas prints the same strokes as before: every one, fitted to the farthest", () => {
		const printed = canvasPrint([NEAR, FAR_RIGHT, FAR_BELOW], false);
		expect(printed.zoom).toBeCloseTo(739 / (70_100 + 16 + 64), 6);
		expect(Number(printed.svg!.width), "the layer reaches the far stroke").toBeGreaterThan(70_000);
		expect(Number(printed.svg!.height)).toBeGreaterThan(109_000);
	});

	it("a note with no canvas answer prints as before", () => {
		ink = [NEAR, FAR_RIGHT];
		initEmbedInkPrintCanvas(null);
		const { root } = printContainer(doc, 739);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		doc.fire("beforeprint");
		expect(Number(root.style.zoom)).toBeCloseTo(739 / (70_100 + 16 + 64), 6);
	});
});

describe("the zoom is decided at the screen call, from the export dialog's saved settings", () => {
	const LETTER_DEFAULT = { pageSize: "Letter", landscape: false, margin: "0", downscalePercent: 100 };
	const LETTER_DEFAULT_PAPER = 816 - 2 * 0.4 * 96;
	let settings: unknown;

	beforeEach(() => {
		settings = { ...LETTER_DEFAULT };
		initEmbedInkPrintPaper(() => settings);
	});
	afterEach(() => initEmbedInkPrintPaper(null));

	function screenCall(paper = 816): { root: FEl } {
		const { root } = printContainer(doc, paper);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		doc.printMedia = false;
		doc.fire("beforeprint");
		return { root };
	}

	function mediaCall(root: FEl, paper: number): void {
		doc.printMedia = true;
		root.offsetWidth = paper;
		doc.fire("beforeprint");
	}

	it("sets the zoom from the saved paper, with the column width", () => {
		const { root } = screenCall();
		expect(root.style.width).toBe("764px");
		expect(Number(root.style.zoom)).toBeCloseTo(LETTER_DEFAULT_PAPER / 764, 5);
	});

	it("sizes it to ink that runs past the column", () => {
		ink = [stroke("a", 20, 900)];
		const { root } = screenCall();
		expect(Number(root.style.zoom)).toBeCloseTo(LETTER_DEFAULT_PAPER / (900 + 16 + 64), 5);
	});

	it("takes the margin from the dialog's code: none, minimal and default", () => {
		expect(paperWidthFor({ ...LETTER_DEFAULT, margin: "1" })).toBeCloseTo(816, 5);
		expect(paperWidthFor({ ...LETTER_DEFAULT, margin: "2" })).toBeCloseTo(816 - 2 * 0.16 * 96, 5);
		expect(paperWidthFor({ ...LETTER_DEFAULT, margin: "0" })).toBeCloseTo(LETTER_DEFAULT_PAPER, 5);
	});

	it("swaps the sides for landscape, and knows the dialog's six sizes", () => {
		expect(paperWidthFor({ ...LETTER_DEFAULT, landscape: true, margin: "1" })).toBeCloseTo(11 * 96, 5);
		const widths = Object.fromEntries(["A3", "A4", "A5", "Legal", "Letter", "Tabloid"].map((pageSize) => [pageSize, paperWidthFor({ ...LETTER_DEFAULT, pageSize, margin: "1" })]));
		expect(widths.A3).toBeCloseTo(11.69 * 96, 5);
		expect(widths.A4).toBeCloseTo(8.27 * 96, 5);
		expect(widths.A5).toBeCloseTo(5.83 * 96, 5);
		expect(widths.Legal).toBeCloseTo(8.5 * 96, 5);
		expect(widths.Letter).toBeCloseTo(8.5 * 96, 5);
		expect(widths.Tabloid).toBeCloseTo(11 * 96, 5);
	});

	it("divides by the downscale, as Obsidian clamps it to 0.1 to 2", () => {
		expect(paperWidthFor({ ...LETTER_DEFAULT, downscalePercent: 50 })).toBeCloseTo(LETTER_DEFAULT_PAPER * 2, 5);
		expect(paperWidthFor({ ...LETTER_DEFAULT, downscalePercent: 1 })).toBeCloseTo(LETTER_DEFAULT_PAPER * 10, 5);
	});

	it("reads no paper from settings that are not the dialog's shape", () => {
		for (const bad of [null, undefined, 5, "Letter", [], {}, { ...LETTER_DEFAULT, pageSize: "B7" }, { ...LETTER_DEFAULT, pageSize: "toString" }, { ...LETTER_DEFAULT, margin: "3" }, { ...LETTER_DEFAULT, margin: 0 }, { ...LETTER_DEFAULT, landscape: "no" }, { ...LETTER_DEFAULT, downscalePercent: "100" }, { ...LETTER_DEFAULT, downscalePercent: Number.NaN }, { ...LETTER_DEFAULT, downscalePercent: 0 }]) {
			expect(paperWidthFor(bad), JSON.stringify(bad)).toBeNull();
		}
	});

	it("a paper wide enough for the column leaves full size at the screen call", () => {
		settings = { ...LETTER_DEFAULT, landscape: true };
		const { root } = screenCall();
		expect(root.style.width).toBe("764px");
		expect(root.style.zoom === undefined || Number(root.style.zoom) === 1).toBe(true);
	});

	it("keeps the screen call's zoom when the print layout's paper is as wide or wider", () => {
		const { root } = screenCall();
		const zoom = Number(root.style.zoom);
		mediaCall(root, 742);
		expect(Number(root.style.zoom), "not grown to 742 / 764").toBe(zoom);
		mediaCall(root, 900);
		expect(Number(root.style.zoom), "not grown to 900 / 764").toBe(zoom);
	});

	it("applies the exact zoom when the print layout's paper is narrower, and says both papers", () => {
		const lines: string[] = [];
		initEmbedInkDiagnostics((via, path, waited) => lines.push(embedInkDiagLine(via, path, waited)));
		const { root } = screenCall();
		mediaCall(root, 700);
		expect(Number(root.style.zoom), "700 / 764: never clipped").toBeCloseTo(700 / 764, 5);
		expect(lines.at(-1)).toContain("paper=700 column=700");
		expect(lines.at(-1)).toContain(`expected=${Math.round(LETTER_DEFAULT_PAPER * 10) / 10}`);
	});

	it("keeps full size when the screen call needed no zoom and the measured paper is as wide", () => {
		settings = { ...LETTER_DEFAULT, landscape: true };
		const { root } = screenCall();
		mediaCall(root, 979);
		expect(root.style.zoom === undefined || Number(root.style.zoom) === 1).toBe(true);
	});

	it("measures the paper with the zoom off, and puts the zoom back", () => {
		const { root } = printContainer(doc, 816);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		doc.printMedia = false;
		doc.fire("beforeprint");
		const zoom = root.style.zoom;
		expect(zoom, "premise: the screen call set a zoom").toBeDefined();
		const seen: Array<string | undefined> = [];
		Object.defineProperty(root, "offsetWidth", { get: () => (seen.push(root.style.zoom), 742) });
		doc.printMedia = true;
		doc.fire("beforeprint");
		expect(seen.length, "premise: the paper was read").toBeGreaterThan(0);
		expect(seen.every((z) => z === undefined || z === ""), "read with the zoom off").toBe(true);
		expect(root.style.zoom).toBe(zoom);
	});

	it("says both zooms and the computed paper in the export line", () => {
		const lines: string[] = [];
		initEmbedInkDiagnostics((via, path, waited) => lines.push(embedInkDiagLine(via, path, waited)));
		const { root } = screenCall();
		const screen = Math.round((LETTER_DEFAULT_PAPER / 764) * 1000) / 1000;
		const expected = Math.round(LETTER_DEFAULT_PAPER * 10) / 10;
		expect(lines.at(-1)).toContain("phase=screen");
		expect(lines.at(-1)).toContain(`screen=${screen} expected=${expected}`);
		mediaCall(root, 742);
		expect(lines.at(-1)).toContain("phase=print");
		expect(lines.at(-1)).toContain(`zoom=${screen} paper=742 column=700 screen=${screen} expected=${expected}`);
	});

	it("puts the container's own zoom back at afterprint", () => {
		const { root } = screenCall();
		mediaCall(root, 742);
		doc.fire("afterprint");
		expect(root.style.zoom).toBeUndefined();
		expect(root.style.width).toBeUndefined();
	});

	it("with no settings readable the screen call sets the width and no zoom, and the print-media call zooms to what it measures", () => {
		for (const none of [null, undefined, { pageSize: "B7" }]) {
			settings = none;
			const { root } = screenCall();
			expect(root.style.width).toBe("764px");
			expect(root.style.zoom, "no paper to compute from").toBeUndefined();
			mediaCall(root, 742);
			expect(Number(root.style.zoom)).toBeCloseTo(742 / 764, 5);
			doc.fire("afterprint");
		}
	});

	it("with no provider registered it is today's behaviour", () => {
		initEmbedInkPrintPaper(null);
		const { root } = screenCall();
		expect(root.style.zoom).toBeUndefined();
		mediaCall(root, 742);
		expect(Number(root.style.zoom)).toBeCloseTo(742 / 764, 5);
	});

	it("a provider that throws costs nothing but the settings", () => {
		initEmbedInkPrintPaper(() => {
			throw new Error("no config");
		});
		const { root } = screenCall();
		expect(root.style.width).toBe("764px");
		expect(root.style.zoom).toBeUndefined();
	});
});

describe("an Infinite Canvas note whose ink leaves the text's pages exports as one page: the text and every stroke fitted together, never above 100 percent", () => {
	const SETTINGS = { pageSize: "Letter", landscape: false, margin: "0", downscalePercent: 100 };
	/** Letter portrait with the default margins, in css px at the dialog's scale of 100: the page area one page holds. */
	const PAPER_W = 8.5 * 96 - 2 * 0.4 * 96;
	const PAPER_H = 11 * 96 - 2 * 0.4 * 96;
	const TEXT_FOOT = 300;
	const PAD = 16;
	const RED = "#cc0000";
	const BLUE = "#0000cc";

	beforeEach(() => initEmbedInkPrintPaper(() => SETTINGS));
	afterEach(() => initEmbedInkPrintPaper(null));

	interface Exported {
		root: FEl;
		fdoc: FDoc;
		zoom: number;
		minHeight: string | undefined;
		paddingLeft: string | undefined;
		paddingTop: string | undefined;
		layers: FEl[];
		tiles: number;
	}

	/** One export up to the call named, the screen call and then the print-media call by default, with the dialog's settings in place. */
	function exportOnePage(strokes: InkStroke[], opts: { canvas?: boolean; through?: "screen" | "media"; settings?: unknown; foot?: number } = {}): Exported {
		const fdoc = new FDoc();
		doc = fdoc;
		ink = strokes;
		initEmbedInkPrintCanvas(() => opts.canvas !== false);
		if ("settings" in opts) initEmbedInkPrintPaper(() => opts.settings);
		// The padding moves the first block down, as the theme's padding does.
		const { root } = printContainer(fdoc, 739, 700, true);
		heightFollowsMinHeight(root, opts.foot ?? TEXT_FOOT);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		fdoc.printMedia = false;
		fdoc.fire("beforeprint");
		if (opts.through !== "screen") {
			fdoc.printMedia = true;
			root.offsetWidth = 739;
			fdoc.fire("beforeprint");
		}
		return {
			root,
			fdoc,
			zoom: Number(root.style.zoom),
			minHeight: root.style.minHeight,
			paddingLeft: root.style.paddingLeft,
			paddingTop: root.style.paddingTop,
			layers: root.children.filter((c) => c.tag === "svg" && (c.attrs.get("class") ?? "").split(" ").includes("handwriting-embed-ink")),
			tiles: root.children.filter((c) => (c.attrs.get("class") ?? "").includes("tile")).length,
		};
	}

	const redWide = { ...boxStroke("wide", 6000, 6300, 3600, 3700), color: RED } as InkStroke;
	const redFar = { ...boxStroke("far-right", 70_000, 70_100, 10, 20), color: RED } as InkStroke;
	const blueFar = { ...boxStroke("far-below", 20, 120, 110_000, 110_040), color: BLUE } as InkStroke;

	/** Everything an export left on the container and its layers, as one string: two exports are the same when these are. */
	function snapshot(out: Exported): string {
		return JSON.stringify({
			style: Object.entries(out.root.style).filter(([, v]) => typeof v === "string").sort(),
			zoom: out.root.style.zoom,
			width: out.root.style.width,
			minHeight: out.minHeight,
			paddingLeft: out.paddingLeft,
			paddingTop: out.paddingTop,
			layers: out.layers.map((l) => ({
				viewBox: l.getAttribute("viewBox"),
				width: l.getAttribute("width"),
				height: l.getAttribute("height"),
				top: l.style.top,
				left: l.style.left,
				paths: l.children.map((c) => [c.getAttribute("fill"), c.getAttribute("d")]),
			})),
			tiles: out.tiles,
		});
	}

	it("knows the page's height as it knows its width: the dialog's size, margins and downscale, the sides swapped for landscape", () => {
		expect(paperHeightFor(SETTINGS)).toBeCloseTo(PAPER_H, 5);
		expect(paperHeightFor({ ...SETTINGS, landscape: true })).toBeCloseTo(8.5 * 96 - 2 * 0.4 * 96, 5);
		expect(paperHeightFor({ ...SETTINGS, pageSize: "A4", margin: "1" })).toBeCloseTo(11.69 * 96, 5);
		expect(paperHeightFor({ ...SETTINGS, downscalePercent: 50 })).toBeCloseTo(PAPER_H * 2, 5);
		for (const bad of [null, "Letter", {}, { ...SETTINGS, pageSize: "Foolscap" }, { ...SETTINGS, margin: "9" }, { ...SETTINGS, landscape: "no" }, { ...SETTINGS, downscalePercent: 0 }]) {
			expect(paperHeightFor(bad), JSON.stringify(bad)).toBeNull();
		}
	});

	it("a 6300 by 3700 px drawing lies inside the paper at the width fit's zoom: today's layout, the zoom is the page's width over the box's, no tile, no padding", () => {
		const out = exportOnePage([NEAR, redWide]);
		const box = 64 + 6300 + PAD;
		expect(out.zoom, "width-bound").toBeCloseTo(PAPER_W / box, 6);
		expect(PAPER_H / (TOP_AT_COLUMN + 3700 + PAD), "premise: the width is the tighter side here").toBeGreaterThan(PAPER_W / box);
		expect(TOP_AT_COLUMN + 3700, "premise: the ink's foot is within a page of the text's foot at that zoom").toBeLessThan(TEXT_FOOT + PAPER_H / (PAPER_W / box));
		expect(out.minHeight, "the container reaches the ink's foot, text top plus ink bottom").toBe(`${TOP_AT_COLUMN + 3700}px`);
		expect(out.tiles, "no page of drawing after the text").toBe(0);
		expect(out.layers.length, "one layer").toBe(1);
		expect(out.paddingLeft).toBeUndefined();
		expect(snapshot(out), "the same export as a note that is not a canvas").toBe(snapshot(exportOnePage([NEAR, redWide], { canvas: false })));
	});

	it("a drawing at x 70,000 and at y 110,000: the page's height decides the zoom, and one layer holds every stroke", () => {
		const out = exportOnePage([NEAR, redFar, blueFar]);
		const widthZoom = PAPER_W / (64 + 70_100 + PAD);
		const heightZoom = PAPER_H / (TOP_AT_COLUMN + 110_040 + PAD);
		expect(heightZoom, "premise: the height is the tighter side here").toBeLessThan(widthZoom);
		expect(out.zoom).toBeCloseTo(heightZoom, 8);
		expect(out.tiles, "no page of drawing after the text").toBe(0);
		expect(out.layers.length, "one layer").toBe(1);
		const layer = out.layers[0]!;
		const [vx, vy, vw, vh] = layer.getAttribute("viewBox")!.split(" ").map(Number) as [number, number, number, number];
		expect([vx, vy], "from the text's origin").toEqual([0, 0]);
		expect(vx + vw, "the layer reaches the stroke at x 70,000").toBeGreaterThanOrEqual(70_100);
		expect(vy + vh, "the layer reaches the stroke at y 110,000").toBeGreaterThanOrEqual(110_040);
		expect(layer.children.map((p) => p.getAttribute("fill")).sort(), "every stroke is in it").toEqual(["#000000", BLUE, RED].sort());
		expect(out.minHeight).toBe(`${TOP_AT_COLUMN + 110_040}px`);
	});

	it("the zoom is decided at the screen call and the print-media call keeps it", () => {
		const screen = exportOnePage([NEAR, redFar, blueFar], { through: "screen" });
		const media = exportOnePage([NEAR, redFar, blueFar]);
		expect(screen.zoom).toBeCloseTo(PAPER_H / (TOP_AT_COLUMN + 110_040 + PAD), 8);
		expect(media.zoom).toBe(screen.zoom);
	});

	it("never above 100 percent: a drawing that fits the page is not enlarged", () => {
		const out = exportOnePage([NEAR]);
		expect(out.zoom).toBeCloseTo(PAPER_W / (64 + 700), 6);
		expect(out.zoom).toBeLessThan(1);
		const roomy = exportOnePage([NEAR], { through: "screen", settings: { ...SETTINGS, downscalePercent: 50 } });
		expect(roomy.root.style.zoom, "a page more than wide enough keeps full size").toBeUndefined();
	});

	it("ink left of the text and above it sets the container's padding by the negative reach", () => {
		const left = boxStroke("left", -200, -100, 40, 80);
		const above = boxStroke("above", 20, 120, -60, -10);
		const out = exportOnePage([NEAR, left, above]);
		expect(out.paddingLeft, "32 px of the theme's padding plus the reach").toBe("232px");
		expect(out.paddingTop, "no padding of the theme's above, plus the reach").toBe("60px");
		expect(out.root.style.width, "the border box grows by the reach, the column is unchanged").toBe(`${700 + 64 + 200}px`);
		const box = 64 + 200 + PAD + 700;
		expect(out.zoom, "the left reach counts in the width").toBeCloseTo(PAPER_W / box, 6);
	});

	it("takes the padding, the width and the zoom off at afterprint", () => {
		const out = exportOnePage([NEAR, boxStroke("left", -200, -100, 40, 80), boxStroke("above", 20, 120, -60, -10), redFar]);
		expect(out.paddingLeft, "premise").toBe("232px");
		out.fdoc.fire("afterprint");
		expect(out.root.style.paddingLeft).toBeUndefined();
		expect(out.root.style.paddingTop).toBeUndefined();
		expect(out.root.style.width).toBeUndefined();
		expect(out.root.style.zoom).toBeUndefined();
	});

	it("a note with no drawing and a note whose drawing lies in the column above the text's foot print as a note that is not a canvas does", () => {
		const bare = exportOnePage([]);
		expect(bare.layers.length).toBe(0);
		expect(bare.minHeight).toBeUndefined();
		expect(bare.paddingLeft).toBeUndefined();
		expect(snapshot(bare)).toBe(snapshot(exportOnePage([], { canvas: false })));
		const fitting = exportOnePage([NEAR]);
		expect(fitting.layers.length, "premise: the drawing is printed").toBe(1);
		expect(snapshot(fitting)).toBe(snapshot(exportOnePage([NEAR], { canvas: false })));
		expect(fitting.paddingLeft).toBeUndefined();
	});

	it("a note without Infinite Canvas keeps the width fit alone, whatever the page's height: every stroke, no height fit, no padding", () => {
		const out = exportOnePage([NEAR, redFar, blueFar], { canvas: false });
		expect(out.zoom).toBeCloseTo(PAPER_W / (70_100 + PAD + 64), 6);
		expect(out.paddingLeft).toBeUndefined();
		expect(out.tiles).toBe(0);
	});

	it("with no saved settings a canvas note fits the width alone, as a note always did", () => {
		const out = exportOnePage([NEAR, redFar, blueFar], { settings: null });
		expect(out.zoom).toBeCloseTo(739 / (70_100 + PAD + 64), 6);
	});

	it("a long text with a little ink in its column keeps the plain layout: the text's pages, the width fit alone", () => {
		const fdoc = new FDoc();
		doc = fdoc;
		ink = [NEAR];
		initEmbedInkPrintCanvas(() => true);
		const { root } = printContainer(fdoc, 739);
		heightFollowsMinHeight(root, 4000);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		fdoc.printMedia = false;
		fdoc.fire("beforeprint");
		expect(Number(root.style.zoom), "the width fit, not the page's height over the text's foot").toBeCloseTo(PAPER_W / (64 + 700), 6);
	});

	const bit = (id: string, x0: number, x1: number, y0: number, y1: number): InkStroke => ({ ...boxStroke(id, x0, x1, y0, y1), color: RED }) as InkStroke;
	/** The width fit's zoom for ink as wide as the column: the page's width over the container's padding and the column. */
	const WIDTH_ZOOM = PAPER_W / (64 + 700);

	it("ink beside the column that fits the paper is today's width fit: no tile, no padding, no height fit", () => {
		const out = exportOnePage([NEAR, bit("beside", 800, 1000, 280, 340)]);
		expect(out.zoom).toBeCloseTo(PAPER_W / (64 + 1000 + PAD), 6);
		expect(out.paddingLeft).toBeUndefined();
		expect(out.tiles).toBe(0);
		expect(snapshot(out)).toBe(snapshot(exportOnePage([NEAR, bit("beside", 800, 1000, 280, 340)], { canvas: false })));
	});

	it("ink one page below the text's foot is today's grow: the container reaches the ink, two pages, the width fit's zoom", () => {
		const below = bit("below-1", 20, 120, 900, 1000);
		const out = exportOnePage([NEAR, below]);
		expect(TOP_AT_COLUMN + 1000, "premise: within a page of the foot at the width fit's zoom").toBeLessThanOrEqual(TEXT_FOOT + PAPER_H / WIDTH_ZOOM);
		expect(out.zoom).toBeCloseTo(WIDTH_ZOOM, 6);
		expect(out.minHeight).toBe(`${TOP_AT_COLUMN + 1000}px`);
		expect((TOP_AT_COLUMN + 1000) * out.zoom, "premise: that is more than one page tall").toBeGreaterThan(PAPER_H);
		expect(out.paddingTop).toBeUndefined();
		expect(snapshot(out)).toBe(snapshot(exportOnePage([NEAR, below], { canvas: false })));
	});

	it("ink two pages below the text's foot is one page: the zoom is the page's height over the box, the layer holds every stroke", () => {
		const out = exportOnePage([NEAR, bit("below-2", 20, 120, 2000, 2100)]);
		expect(TOP_AT_COLUMN + 2100, "premise: past a page of the foot at the width fit's zoom").toBeGreaterThan(TEXT_FOOT + PAPER_H / WIDTH_ZOOM);
		expect(out.zoom).toBeCloseTo(PAPER_H / (TOP_AT_COLUMN + 2100 + PAD), 8);
		expect(out.zoom).toBeLessThan(WIDTH_ZOOM);
		expect(out.minHeight).toBe(`${TOP_AT_COLUMN + 2100}px`);
		expect(out.layers.length).toBe(1);
		expect(out.layers[0]!.children.length, "both strokes").toBe(2);
		expect(out.paddingLeft).toBeUndefined();
	});

	it("a stroke above the text's top and ink two pages below is one page at the height that includes the top reach: the layer is placed again inside the padding", () => {
		const out = exportOnePage([NEAR, bit("above-top", 20, 120, -60, -10), bit("below-2", 20, 120, 2000, 2100)]);
		expect(out.paddingTop, "no padding of the theme's above, plus the reach").toBe("60px");
		// The padding moves the text down by the reach, so the ink's foot is the text top, the reach and the ink's bottom.
		expect(out.minHeight, "the container reaches the ink's foot inside the padding").toBe(`${TOP_AT_COLUMN + 60 + 2100}px`);
		expect(out.zoom).toBeCloseTo(PAPER_H / (TOP_AT_COLUMN + 60 + 2100 + PAD + PAD), 8);
		expect(out.zoom).toBeLessThan(WIDTH_ZOOM);
		expect(out.layers.length).toBe(1);
	});

	it("a stroke above the text's top over a long text: the box is the text's foot below the reach, and the pad above the ink", () => {
		const out = exportOnePage([NEAR, bit("above-top", 20, 120, -60, -10)], { foot: 4000 });
		expect(out.paddingTop).toBe("60px");
		expect(out.zoom, "the text's foot plus the reach plus the pad above the ink").toBeCloseTo(PAPER_H / (4000 + 60 + PAD), 8);
	});

	it("a stroke 20 px left of the text's origin is one page with the container padded by it", () => {
		const out = exportOnePage([NEAR, bit("left-20", -20, 40, 100, 140)]);
		expect(out.paddingLeft, "32 px of the theme's padding plus the 20 px reach").toBe("52px");
		expect(out.zoom, "the reach and the pad count in the width").toBeCloseTo(PAPER_W / (64 + 20 + PAD + 700), 6);
		expect(out.layers.length).toBe(1);
	});

	it("the edge is the print pad: a stroke 16 px left or above keeps the plain layout, one more px is one page", () => {
		for (const [stroke, padded] of [[bit("on-edge", -16, 40, 100, 140), false], [bit("over-edge", -17, 40, 100, 140), true], [bit("above-edge", 20, 80, -16, 20), false], [bit("above-over", 20, 80, -17, 20), true]] as const) {
			const out = exportOnePage([NEAR, stroke]);
			expect(out.paddingLeft !== undefined || out.paddingTop !== undefined, stroke.id).toBe(padded);
		}
	});

	it("the edge below is the text's foot plus one page at the width fit's zoom", () => {
		const edge = TEXT_FOOT + PAPER_H / WIDTH_ZOOM - TOP_AT_COLUMN;
		const at = exportOnePage([NEAR, bit("at-edge", 20, 120, edge - 44, edge - 4)]);
		const over = exportOnePage([NEAR, bit("over", 20, 120, edge - 34, edge + 6)]);
		expect(at.zoom, "at the edge: the width fit").toBeCloseTo(WIDTH_ZOOM, 6);
		expect(over.zoom, "past it: the height decides").toBeLessThan(at.zoom);
	});

});

/**
 * Anchored ink is placed on its line, and every place that places or paints a layer knows the text's size. Each cell
 * pins one hand-off that, undone, left the rest green: the editor's anchors read before a placement, the block tops held
 * before a print pages its layout, the text size in a placement's key, in the skip that stands a paint down, in the
 * paint fallback, in the print placement and in the plugin's wiring, and the provider's end at teardown.
 */
describe("anchored ink and the text's size reach every placement", () => {
	const S = 0.5;
	const NOTE = ["alpha", "", "beta", "", "gamma"].join("\n");
	const LINE_TOP = 48;
	const anchoredStroke = (): InkStroke =>
		({ ...tall("anchored", LINE_TOP + 4, LINE_TOP + 24), lineAnchor: { line: 3, top: LINE_TOP, y: LINE_TOP + 4, key: lineKey("beta"), width: 700, fontPx: 26, above: 3802466213 /* lines "alpha", "" above (LineAnchor.ts aboveOf) */ } }) as InkStroke;
	/** Each block is one note paragraph: blocks 0, 1, 2 are lines 0, 2, 4 of NOTE (0-based). */
	function recordBlocks(root: FEl, blocks: FEl[]): void {
		blocks.forEach((block, i) => recordLines(root as unknown as HTMLElement, block as unknown as HTMLElement, {
			section: () => ({ text: NOTE, lineStart: 2 * i, lineEnd: 2 * i }),
			cached: () => null,
		}));
	}
	/** The world y the layer's box ends at, from the origin: the shown stroke's bottom. */
	const layerBottom = (root: FEl): number => {
		const [, y, , h] = root.querySelector(":scope > svg.handwriting-embed-ink")!.getAttribute("viewBox")!.split(" ").map(Number) as [number, number, number, number];
		return y + h;
	};

	it("reads the editor's anchors up to date before it places anchored ink, and reads nothing for ink with no anchor", () => {
		const { root, blocks } = blockContainer(doc, 816);
		recordBlocks(root, blocks);
		doc.printMedia = false;
		let folds = 0;
		const holder = { fold: () => { folds++; } };
		holdLineAnchors(holder);
		try {
			embedInk.placeStrokes(root as unknown as HTMLElement, [anchoredStroke()]);
			expect(folds, "the anchors were read once").toBe(1);
			embedInk.placeStrokes(root as unknown as HTMLElement, [tall("plain", 1, 9)]);
			expect(folds, "ink with no anchor reads nothing").toBe(1);
		} finally {
			releaseLineAnchors(holder);
		}
	});

	it("places anchored ink from the anchor the editor settled: a line moved by typing is the line the ink follows", () => {
		const { root, blocks } = blockContainer(doc, 816);
		recordBlocks(root, blocks);
		doc.printMedia = false;
		const s = anchoredStroke();
		// The editor folds a typed line into the anchor when it is read: this holder moves the anchor's line top down by 12.
		const holder = { fold: () => { s.lineAnchor!.top = LINE_TOP + 12; } };
		holdLineAnchors(holder);
		try {
			const shown = embedInk.placeStrokes(root as unknown as HTMLElement, [s]).strokes[0]!;
			// The block of the line is 100 px under the first (screen flow): the correction is that over the settled top.
			expect(shown.bbox.y).toBe(LINE_TOP + 4 + (SCREEN_SPANS[1]! - (LINE_TOP + 12)));
		} finally {
			releaseLineAnchors(holder);
		}
	});

	it("a print places anchored ink from the block tops held before it paged the layout, not from where the pages put them", () => {
		ink = [anchoredStroke()];
		initEmbedInkRefresh(() => ink);
		const { root, blocks } = blockContainer(doc, 816);
		recordBlocks(root, blocks);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		exportCalls(root);
		// Held: the middle block 100 px under the first, so the stroke moves by 100 - 48. Paged: 130 under, 130 - 48.
		expect(layerBottom(root), "the held top").toBe(LINE_TOP + 24 + (SCREEN_SPANS[1]! - LINE_TOP));
		expect(PAGED_TOPS[1], "premise: the pages moved the block").not.toBe(SCREEN_SPANS[1]);
	});

	it("a print places anchored ink at the text's size: world units through the zoom, the held top over s", () => {
		doc.computed = { ...doc.computed, fontSize: "13px" };
		embedInk.initEmbedInkFontRef(() => 26);
		ink = [anchoredStroke()];
		initEmbedInkRefresh(() => ink);
		const { root, blocks } = blockContainer(doc, 816);
		recordBlocks(root, blocks);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		exportCalls(root);
		// The held top is px; the correction is in world units: 100 px at s is 100 / s world units, over the anchor's top.
		expect(layerBottom(root)).toBe(LINE_TOP + 24 + (SCREEN_SPANS[1]! / S - LINE_TOP));
	});

	it("a print honours anchors under the open editor's signature, as Reading view does: an anchor taken at another width stays where it was drawn", () => {
		// The editor is open at 420 px; the stroke was anchored at 700. The editor leaves it, so Reading view and the print do.
		embedInk.initEmbedInkLineSignature((p) => (p === "a.md" ? { width: 420, fontPx: 26, charWidth: 8.8 } : null));
		try {
			ink = [anchoredStroke()];
			initEmbedInkRefresh(() => ink);
			const { root, blocks } = blockContainer(doc, 816);
			recordBlocks(root, blocks);
			doc.printMedia = false;
			const el = root as unknown as HTMLElement;
			expect(embedInk.placeStrokes(el, ink, undefined, 1, "a.md").strokes[0], "Reading view leaves it").toBe(ink[0]);
			expect(embedInk.placeStrokes(el, ink).strokes[0]!.bbox.y, "premise: with no signature the newest stroke's moves it").not.toBe(ink[0]!.bbox.y);
			attachEmbedInk(el, "a.md", ink);
			exportCalls(root);
			expect(layerBottom(root), "the print places it where Reading view does").toBe(LINE_TOP + 24);
		} finally {
			embedInk.initEmbedInkLineSignature(null);
		}
	});

	it("Reading view's paint and its replace both place anchored ink under the open editor's signature", async () => {
		embedInk.initEmbedInkLineSignature((p) => (p === "a.md" ? { width: 420, fontPx: 26, charWidth: 8.8 } : null));
		try {
			ink = [anchoredStroke()];
			initEmbedInkRefresh(() => ink);
			const { root, blocks } = blockContainer(doc, 816);
			recordBlocks(root, blocks);
			doc.printMedia = false;
			const el = root as unknown as HTMLElement;
			// The layer's box runs from the origin to the shown stroke's bottom: its css height is where the ink ends.
			const bottom = (shown: readonly InkStroke[]): number => { const b = embedInk.embedInkBounds(shown); return b.y + b.h; };
			const painted = (): number => parseFloat((root.querySelector(":scope > canvas.handwriting-embed-ink") as unknown as HTMLElement).style.height);
			expect(bottom(embedInk.placeStrokes(el, ink).strokes), "premise: with no signature the stroke moves").not.toBe(LINE_TOP + 24);
			attachEmbedInk(el, "a.md", ink);
			expect(painted(), "the paint leaves it where it was drawn").toBe(LINE_TOP + 24);
			const paints = await paintsDuring(() => embedInk.queueReplace(el));
			expect(paints, "the replace finds the paint's placement").toBe(0);
			expect(painted(), "the replace leaves it where it was drawn").toBe(LINE_TOP + 24);
		} finally {
			embedInk.initEmbedInkLineSignature(null);
		}
	});

	it("the note surface hands the open editor's signature to the embed ink", () => {
		const wired = registrySource.replace(/\r\n/g, "\n");
		expect(wired).toMatch(/initEmbedInkLineSignature\(\((\w+)\) => overlayForPath\(\1\)\?\.lineAnchorState\?\.sig \?\? null\);/);
		expect(wired, "never wired as none").not.toMatch(/initEmbedInkLineSignature\(null\)/);
	});

	it("the zoom is named in a placement's key, so a new text size is a new placement", () => {
		const root = new FEl("div", doc) as unknown as HTMLElement;
		expect(embedInk.placeStrokes(root, [tall("plain", 1, 9)]).key, "at 1 the key is empty").toBe("");
		expect(embedInk.placeStrokes(root, [tall("plain", 1, 9)], undefined, S).key).toBe(`@${S};`);
		expect(embedInk.placeStrokes(root, [tall("plain", 1, 9)], undefined, 2).key).not.toBe(embedInk.placeStrokes(root, [tall("plain", 1, 9)], undefined, S).key);
	});

	/** The 2D contexts the cell's canvases hand out while `run` and the microtasks it queued go by: one per paint. */
	async function paintsDuring(run: () => void): Promise<number> {
		const real = FEl.prototype.getContext;
		let paints = 0;
		FEl.prototype.getContext = function (this: FEl) {
			paints++;
			return real.call(this);
		};
		try {
			run();
			await new Promise<void>((resolve) => queueMicrotask(resolve));
		} finally {
			FEl.prototype.getContext = real;
		}
		return paints;
	}

	/** A print container attached at the text size `font` over the 26 px reference, painted once. */
	function attachedAt(font: number): FEl {
		embedInk.initEmbedInkFontRef(() => 26);
		doc.computed = { ...doc.computed, fontSize: `${font}px` };
		ink = [tall("plain", 1, 99)];
		initEmbedInkRefresh(() => ink);
		const { root } = printContainer(doc, 739);
		attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
		expect(root.querySelector(":scope > canvas.handwriting-embed-ink"), "premise: a layer is painted").not.toBeNull();
		return root;
	}

	it("a note whose text changes size is painted again when it is attached again, though its ink and placement stand", async () => {
		const root = attachedAt(26);
		doc.computed = { ...doc.computed, fontSize: "13px" };
		const paints = await paintsDuring(() => attachEmbedInk(root as unknown as HTMLElement, "a.md", ink));
		expect(paints, "the paint does not stand down on a marker alone").toBeGreaterThan(0);
	});

	it("a note whose text changes size is placed again by a replace: the size is in the placement key", async () => {
		const root = attachedAt(26);
		doc.computed = { ...doc.computed, fontSize: "13px" };
		const paints = await paintsDuring(() => embedInk.queueReplace(root as unknown as HTMLElement));
		expect(paints, "the replace paints at the new size").toBeGreaterThan(0);
	});

	it("a layer first painted at a text size is placed at that size: a replace finds nothing to change", async () => {
		const root = attachedAt(13);
		const paints = await paintsDuring(() => embedInk.queueReplace(root as unknown as HTMLElement));
		expect(paints, "the paint's own placement already names the size").toBe(0);
	});

	it("the plugin hands the note surface's reference font to the embed ink at load", () => {
		const wired = pluginOnloadSource.replace(/\r\n/g, "\n");
		expect(wired).toMatch(/initEmbedInkFontRef\(\(\w+\) => inlineInk\.fontRefPx\(\w+\)\);/);
		expect(wired, "never wired as none").not.toMatch(/initEmbedInkFontRef\(null\)/);
	});

	it("the teardown lets the reference font go: with no provider the ink is drawn at one px per world unit", () => {
		const root = new FEl("div", doc) as unknown as HTMLElement;
		doc.computed = { ...doc.computed, fontSize: "13px" };
		embedInk.initEmbedInkFontRef(() => 26);
		expect(embedInk.inkZoomOf(root, "a.md"), "premise: the provider answers").toBe(S);
		teardownEmbedInk();
		expect(embedInk.inkZoomOf(root, "a.md")).toBe(1);
	});
});
