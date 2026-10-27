/**
 * The column a print reads when the note is in Reading view.
 *
 * Reading view hides the editor, so the editor's column reads null, and a print with no column keeps the plain layout:
 * Alan's 10-23 export of Untitled 1 from Reading view printed its ink at full size over several pages, cut at the right.
 * The print falls back to the note's own Reading view column, its sizer's content width. Only a laid-out view of the
 * note itself counts: not the print container, not an embed of the note in another note, not a hover popover, not a
 * hidden view. With an editor laid out too, the editor's column wins. The render cell test/render/ExportShape.test.ts
 * prints the note; these cells pin the choice.
 */
import { afterEach, describe, expect, it } from "vitest";
import { attachEmbedInk, disarmPrintSwaps, initEmbedInkColumnWidth, initEmbedInkRefresh, layers, teardownEmbedInk } from "./EmbedInk";
import { readingColumnFor } from "./EmbedInkPrint";
import { InkStroke } from "../ink/Stroke";

interface Fake {
	isConnected: boolean;
	classList: { contains(c: string): boolean };
	closest(sel: string): unknown;
	querySelector(sel: string): unknown;
}

/** A `.markdown-preview-view` root; `sizer` null is a print container (no sizer). */
function view(opts: { sizer: { width: number; padLeft?: number; padRight?: number } | null; inside?: string; connected?: boolean }): Fake {
	const sizer = opts.sizer
		? {
				clientWidth: opts.sizer.width,
				ownerDocument: {
					defaultView: { getComputedStyle: () => ({ paddingLeft: `${opts.sizer!.padLeft ?? 0}px`, paddingRight: `${opts.sizer!.padRight ?? 0}px` }) },
				},
			}
		: null;
	return {
		isConnected: opts.connected ?? true,
		classList: { contains: (c: string) => c === "markdown-preview-view" },
		closest: (sel: string) => (opts.inside && sel.split(",").map((s) => s.trim()).includes(opts.inside) ? {} : null),
		querySelector: (sel: string) => (sel === ":scope > .markdown-preview-sizer" ? sizer : null),
	};
}

const added: Fake[] = [];
function show(root: Fake, path: string): void {
	layers.set(root as unknown as HTMLElement, path);
	added.push(root);
}

afterEach(() => {
	for (const r of added) layers.delete(r as unknown as HTMLElement);
	added.length = 0;
});

describe("the Reading view column a print falls back to", () => {
	it("the note's own Reading view: its sizer's content width", () => {
		show(view({ sizer: { width: 748, padLeft: 24, padRight: 24 } }), "a.md");
		expect(readingColumnFor("a.md")).toBe(700);
	});

	it("no Reading view of the note: null", () => {
		show(view({ sizer: { width: 700 } }), "other.md");
		expect(readingColumnFor("a.md")).toBeNull();
	});

	it("a hidden Reading view (the editor shown): no answer", () => {
		show(view({ sizer: { width: 0 } }), "a.md");
		expect(readingColumnFor("a.md")).toBeNull();
	});

	it("the print container is never its own column", () => {
		show(view({ sizer: null }), "a.md");
		expect(readingColumnFor("a.md")).toBeNull();
	});

	it("an embed of the note in another note, or a hover popover, is skipped", () => {
		show(view({ sizer: { width: 500 }, inside: ".markdown-embed" }), "a.md");
		show(view({ sizer: { width: 450 }, inside: ".popover" }), "a.md");
		expect(readingColumnFor("a.md")).toBeNull();
		show(view({ sizer: { width: 700 } }), "a.md");
		expect(readingColumnFor("a.md")).toBe(700);
	});

	it("a root the DOM dropped is skipped", () => {
		show(view({ sizer: { width: 700 }, connected: false }), "a.md");
		expect(readingColumnFor("a.md")).toBeNull();
	});
});

// EmbedPrintFit.test.ts's fake print container, copied: a real attach and a real beforeprint against a planted box.
// Two changes: a selector may name a class without a tag (`:scope > .markdown-preview-sizer`), and an element has a
// clientWidth, so a Reading view (a view with a sizer) can be built from the same fakes.
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
	clientWidth = 0;
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
		const m = /^:scope > ([a-z]*)\.([a-zA-Z0-9_-]+)$/.exec(sel);
		if (!m) return null;
		return this.children.find((k) => (m[1] === "" || k.tag === m[1]) && (k.attrs.get("class") ?? "").split(" ").includes(m[2]!)) ?? null;
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

describe("an editor and a Reading view of the note both laid out", () => {
	it("the print lays out at the editor's column, not the Reading view's", () => {
		const doc = new FDoc();
		const ink = [stroke("a", 20, 600)];
		initEmbedInkRefresh(() => ink);
		initEmbedInkColumnWidth(() => 700);
		// The note's Reading view: a view with a sizer, its content 500 px (564 less the theme's 32 px each side).
		const reading = new FEl("div", doc);
		reading.attrs.set("class", "markdown-preview-view markdown-rendered");
		reading.offsetParent = {};
		const sizer = reading.appendChild(new FEl("div", doc));
		sizer.attrs.set("class", "markdown-preview-sizer");
		sizer.clientWidth = 564;
		try {
			const { root } = printContainer(doc, 739);
			attachEmbedInk(root as unknown as HTMLElement, "a.md", ink);
			attachEmbedInk(reading as unknown as HTMLElement, "a.md", ink);
			expect(readingColumnFor("a.md"), "premise: the Reading view answers, with another width").toBe(500);
			doc.fire("beforeprint");
			// Border box: the column plus the 64 px of padding. The Reading view's 500 would give 564.
			expect(root.style.width).toBe("764px");
		} finally {
			disarmPrintSwaps();
			teardownEmbedInk();
			initEmbedInkColumnWidth(() => null);
		}
	});
});
