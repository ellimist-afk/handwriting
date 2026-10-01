/**
 * AUDIT PROBE EmbedFold-4 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: for `![[Note#Heading]]` and `![[Note#^block]]` Obsidian 1.13.7
 * renders only the section (QW.loadFile: `o=PD(r,i) ... o&&(a=ID(a,r,o).content)`)
 * but post-processes it with `sourcePath: n.path` - the whole file. The
 * post-processor at main.ts:2071-2120 reads only ctx.sourcePath (:2072), so it
 * attaches `inlineInk.strokes(path)` - every stroke of the note - to the
 * excerpt's `.markdown-embed-content` box. paint (EmbedInk.ts:971) draws them
 * all from the excerpt's top-left (CAM 0,0,1) and grows the box's min-height
 * to the bottom of the note's ink (:1006-1016).
 *
 * Production code driven: the post-processor lambda sliced verbatim out of
 * main.ts and executed; the real attachEmbedInkOnceReady / paint /
 * teardownEmbedInk (EmbedInk.ts); the real drawStroke/fillRibbon; the real
 * InlineInkStore, loaded through its own ensureLoaded with a fake host (as
 * the EmbedFold-1 probe and InlineInkStore.reload.test.ts do). The DOM is a
 * minimal stand-in reproducing the element shapes and the ctx object that
 * Obsidian 1.13.7 QW.loadFile builds (quoted below), with Component.addChild
 * semantics (`this._loaded && e.load()`).
 *
 * Assertions state the CORRECT behaviour (an excerpt shows no ink from other
 * parts of the note, and its box is not stretched to the whole note's ink):
 * green = no bug, red = bug.
 */
import { afterEach, describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import { isMarkdownPath, stripMarkdownExtension } from "../util/MarkdownPath";
import mainSource from "../main.ts?raw";
import {
	attachEmbedInkOnceReady,
	embedInkIsLiveEditorBlock,
	disarmPrintSwaps,
	teardownEmbedInk,
} from "../inline/EmbedInk";
import { InlineInkStore, InlineInkHost } from "../inline/InlineInkStore";
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";
import { runDetached } from "../util/Detached";

// ---- slice the production post-processor out of main.ts -------------------
const source = mainSource.replace(/\r\n/g, "\n");
const ppStart = "\t\tthis.registerMarkdownPostProcessor((el, ctx) => {\n";
const ppEnd = "\n\t\t});\n\t\t// Embed layers stop going stale";
expect(source.split(ppStart)).toHaveLength(2);
expect(source.split(ppEnd)).toHaveLength(2);
const ps = source.indexOf(ppStart) + ppStart.length;
const pe = source.indexOf(ppEnd, ps);
const ppBody = source.slice(ps, pe);
// It is the embed-ink processor, it takes the path from ctx.sourcePath, and it
// attaches the whole note's strokes.
expect(ppBody).toContain("const path = ctx.sourcePath;");
expect(ppBody).toContain("cancelRetry = attachEmbedInkOnceReady(el, container, path, () =>");
expect(ppBody).toContain("inlineInk.strokes(path)");
expect(ppBody).toContain("ctx.addChild(child);");
const makeProcessorRaw = new Function(
	"MarkdownRenderChild",
	"attachEmbedInkOnceReady",
	"inlineInk",
	"runDetached",
	"embedInkIsLiveEditorBlock",
	"readNoteText",
	"hoverWholeNote",
	"isMarkdownPath",
	transformSync(`return (el: any, ctx: any) => {\n${ppBody}\n};`, {
		loader: "ts",
		target: "es2022",
	}).code
);
// 1.4.22 lane R: the post-processor also calls embedInkIsLiveEditorBlock (issue 22 fix).
// The file text a hover preview's rendered text is compared with.
let noteFileText = "";
let noteReads = 0;
// While set, a read of the note does not resolve until it does: a comparison
// still pending when the popover renders again.
let readGate: Promise<void> | null = null;
const readNoteText = async (): Promise<string | null> => {
	noteReads++;
	if (readGate) await readGate;
	return noteFileText;
};
const makeProcessor = (...deps: unknown[]) =>
	makeProcessorRaw(...deps, embedInkIsLiveEditorBlock, readNoteText, new WeakMap<object, unknown>(), isMarkdownPath);

// ---- Obsidian Component / MarkdownRenderChild semantics --------------------
class Component {
	_loaded = false;
	_children: Component[] = [];
	onload(): void {}
	onunload(): void {}
	load(): void {
		if (this._loaded) return;
		this._loaded = true;
		this.onload();
		for (const c of this._children) c.load();
	}
	unload(): void {
		if (!this._loaded) return;
		this._loaded = false;
		for (const c of this._children) c.unload();
		this.onunload();
	}
	// app.js 1.13.7: addChild=function(e){return this._children.push(e),this._loaded&&e.load(),e}
	addChild<T extends Component>(c: T): T {
		this._children.push(c);
		if (this._loaded) c.load();
		return c;
	}
}
class MarkdownRenderChild extends Component {
	constructor(readonly containerEl: unknown) {
		super();
	}
}

// ---- minimal DOM with real closest / :scope > selectors --------------------
type Call = [string, unknown[]];
class MiniDoc {
	readonly documentElement: MiniEl;
	readonly body: MiniEl;
	readonly defaultView = {
		devicePixelRatio: 1,
		getComputedStyle: (el: MiniEl) => ({ position: el.style.position || "static" }),
		addEventListener: (): void => {},
		removeEventListener: (): void => {},
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		setTimeout: (): number => 0,
		clearTimeout: (): void => {},
	};
	constructor() {
		this.documentElement = new MiniEl("html", this);
		this.body = this.documentElement.createEl("body");
	}
}
class MiniEl {
	readonly children: MiniEl[] = [];
	readonly classes = new Set<string>();
	readonly attrs = new Map<string, string>();
	readonly style: Record<string, string> & { removeProperty(p: string): void } = (() => {
		const rec: Record<string, string> = {};
		const cssToJs = (p: string) => p.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
		return Object.assign(rec, { removeProperty: (p: string) => void delete rec[cssToJs(p)] });
	})();
	parentElement: MiniEl | null = null;
	width = 0;
	height = 0;
	text = "";
	readonly calls: Call[] = [];
	readonly classList = {
		contains: (c: string) => this.classes.has(c),
		add: (c: string) => void this.classes.add(c),
		remove: (c: string) => void this.classes.delete(c),
	};
	constructor(readonly tagName: string, readonly ownerDocument: MiniDoc, cls = "") {
		for (const c of cls.split(" ").filter(Boolean)) this.classes.add(c);
	}
	get isConnected(): boolean {
		let n: MiniEl = this;
		while (n.parentElement) n = n.parentElement;
		return n === this.ownerDocument.documentElement;
	}
	get textContent(): string {
		return this.text + this.children.map((k) => k.textContent).join("");
	}
	private matches(sel: string): boolean {
		const m = /^([a-z0-9]*)((?:\.[a-zA-Z0-9_-]+)*)$/.exec(sel);
		if (!m) throw new Error(`MiniEl: unsupported selector ${sel}`);
		if (m[1] && m[1] !== this.tagName) return false;
		return (m[2] ?? "").split(".").filter(Boolean).every((c) => this.classes.has(c));
	}
	closest<T = MiniEl>(sel: string): T | null {
		for (let n: MiniEl | null = this; n; n = n.parentElement) if (n.matches(sel)) return n as unknown as T;
		return null;
	}
	querySelector<T = MiniEl>(sel: string): T | null {
		const scoped = /^:scope > (.+)$/.exec(sel);
		if (!scoped) throw new Error(`MiniEl: unsupported querySelector ${sel}`);
		return (this.children.find((k) => k.matches(scoped[1]!)) ?? null) as unknown as T | null;
	}
	appendChild(c: MiniEl): MiniEl {
		c.parentElement?.children.splice(c.parentElement.children.indexOf(c), 1);
		this.children.push(c);
		c.parentElement = this;
		return c;
	}
	createEl(tag: string, opts: { cls?: string; text?: string } = {}): MiniEl {
		const el = this.appendChild(new MiniEl(tag, this.ownerDocument, opts.cls ?? ""));
		el.text = opts.text ?? "";
		return el;
	}
	createDiv(cls: string | { cls?: string } = ""): MiniEl {
		return this.createEl("div", { cls: typeof cls === "string" ? cls : cls.cls });
	}
	remove(): void {
		const p = this.parentElement;
		if (p) p.children.splice(p.children.indexOf(this), 1);
		this.parentElement = null;
	}
	setCssStyles(s: Record<string, string>): void {
		Object.assign(this.style, s);
	}
	getAttribute(k: string): string | null {
		return this.attrs.get(k) ?? null;
	}
	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}
	removeAttribute(k: string): void {
		this.attrs.delete(k);
	}
	getBoundingClientRect() {
		return { left: 0, top: 0, width: 600, height: 120 };
	}
	getContext(): CanvasRenderingContext2D {
		const set: Record<string | symbol, unknown> = {};
		return new Proxy(set, {
			get: (_t, prop) =>
				prop in set ? set[prop] : (...args: unknown[]) => void this.calls.push([String(prop), args]),
			set: (_t, prop, v) => ((set[prop] = v), true),
		}) as unknown as CanvasRenderingContext2D;
	}
}

// ---- the note: ink near the top (Section A) and ink under Section B -------
//
// inked.md:
//   # Section A            <- editor y ~ 0
//   notes... (sA drawn here, note-space y = 30)
//   ... long section ...
//   # Section B            <- editor y ~ 780
//   One paragraph. ^blk    (sB drawn under it, note-space y = 800)
const NOTE = "inked.md";
const SECTION_A_Y = 30;
const SECTION_B_Y = 800;
function stroke(id: string, y: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2.2,
		points: [
			{ x: 40, y, pressure: 0.5, t: 0 },
			{ x: 140, y, pressure: 0.5, t: 8 },
			{ x: 240, y, pressure: 0.5, t: 16 },
		],
		bbox: { x: 40, y, width: 200, height: 0 },
		createdAt: 0,
	} as InkStroke;
}
class FakeHost implements InlineInkHost {
	sidecars = new Map<string, ParseResult>();
	readPageId(path: string): string | null {
		return path === NOTE ? "p1" : null;
	}
	async claimId(_p: string, id: string): Promise<{ pageId: string }> {
		return { pageId: id };
	}
	async loadSidecar(id: string): Promise<ParseResult | null> {
		return this.sidecars.get(id) ?? null;
	}
	scheduleSidecar(): void {}
	notify(): void {}
}
async function noteWithInk(): Promise<InlineInkStore> {
	const store = new InlineInkStore();
	const host = new FakeHost();
	const page: PageData = emptyPage("p1");
	page.surface = "inline";
	page.strokes = [stroke("sA", SECTION_A_Y), stroke("sB", SECTION_B_Y)];
	host.sidecars.set("p1", { data: page, recovered: false, damaged: false } as ParseResult);
	store.attachHost(host);
	await store.ensureLoaded(NOTE);
	return store;
}

/**
 * The host note's reading view, holding one `![[src]]` embed, rendered the
 * way Obsidian 1.13.7 renders it. Verbatim from app.js:
 *
 *   W1.load({app, linktext: k /* = w.getAttribute("src") *\/, sourcePath: i,
 *            containerEl: w, displayMode: !0, showInline: !0, depth: m})
 *   -> QW ctor: this.containerEl = t.containerEl; addClass("markdown-embed");
 *               this.subpath = i
 *   QW.loadFile: o = PD(r, i); a = cachedRead(n); o && (a = ID(a, r, o).content)
 *     h = this.containerEl.createDiv("markdown-embed-content")
 *     p = h.createDiv("markdown-preview-view markdown-rendered"); p.appendChild(u)
 *     $W.postProcess(this.app, {docId, sourcePath: n.path, frontmatter: l,
 *       promises: f, addChild: e => m.addChild(e), getSectionInfo: () => null,
 *       replace: () => null, containerEl: p, el: p, displayMode: !0})
 */
function renderEmbed(
	processor: (el: unknown, ctx: unknown) => void,
	src: string,
	excerpt: (p: MiniEl) => void
) {
	const doc = new MiniDoc();
	const hostSection = doc.body
		.createDiv("markdown-reading-view")
		.createDiv("markdown-preview-view markdown-rendered")
		.createDiv("markdown-preview-sizer markdown-preview-section")
		.createDiv();
	const w = hostSection.createEl("p").createEl("span", { cls: "internal-embed" });
	w.setAttribute("src", src);
	// QW: a Component the host's render context has already loaded.
	const qw = new Component();
	qw.load();
	w.classList.add("markdown-embed");
	const h = w.createDiv("markdown-embed-content");
	const p = h.createDiv("markdown-preview-view markdown-rendered");
	excerpt(p);
	let childLoaded = false;
	const ctx = {
		docId: "x",
		sourcePath: NOTE, // n.path: the WHOLE file, subpath or not
		frontmatter: undefined,
		promises: [],
		addChild: (c: Component) => {
			qw.addChild(c);
			childLoaded = c._loaded;
		},
		getSectionInfo: () => null,
		replace: () => null,
		containerEl: p,
		el: p,
		displayMode: true,
	};
	processor(p, ctx);
	return { embed: h, excerptEl: p, ctx, childLoaded: () => childLoaded };
}

function inkCanvas(root: MiniEl): MiniEl | null {
	return root.querySelector<MiniEl>(":scope > canvas.handwriting-embed-ink");
}

/** Every y the canvas's path calls touched, in canvas (= note, CAM 0,0,1) units. */
function drawnYs(canvas: MiniEl): number[] {
	const ys: number[] = [];
	for (const [name, args] of canvas.calls) {
		if (name === "moveTo" || name === "lineTo" || name === "arc") ys.push(args[1] as number);
		if (name === "quadraticCurveTo") ys.push(args[1] as number, args[3] as number);
	}
	return ys;
}
const near = (ys: number[], y: number) => ys.some((v) => Math.abs(v - y) < 10);

afterEach(() => {
	teardownEmbedInk();
	disarmPrintSwaps();
});

describe("EmbedFold-4: a section/block embed must not show the whole note's ink", () => {
	it("control: a whole-note embed ![[inked]] draws all the note's ink and grows to it (by design)", async () => {
		const store = await noteWithInk();
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const { embed, childLoaded } = renderEmbed(processor, "inked", (p) => {
			p.createEl("h1", { text: "Section A" });
			p.createEl("p", { text: "notes..." });
			p.createEl("h1", { text: "Section B" });
			p.createEl("p", { text: "One paragraph." });
		});
		expect(childLoaded()).toBe(true);
		const canvas = inkCanvas(embed);
		expect(canvas).not.toBeNull();
		const ys = drawnYs(canvas!);
		expect(near(ys, SECTION_A_Y)).toBe(true);
		expect(near(ys, SECTION_B_Y)).toBe(true);
		expect(embed.style.minHeight).toBe(`${SECTION_B_Y}px`);
	});

	for (const [label, src] of [
		["heading embed ![[inked#Section B]]", "inked#Section B"],
		["block embed ![[inked#^blk]]", "inked#^blk"],
	] as const) {
		it(`${label}: no Section A ink over the excerpt, and the box is not stretched to the whole note's ink`, async () => {
			const store = await noteWithInk();
			// Precondition: the embedded note has ink in two places.
			expect(store.isLoaded(NOTE)).toBe(true);
			expect(store.strokes(NOTE).map((s) => s.id)).toEqual(["sA", "sB"]);
			const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
			// Obsidian sliced the text to the section (ID(...).content), so the
			// excerpt holds only Section B's content.
			const { embed, excerptEl, ctx, childLoaded } = renderEmbed(processor, src, (p) => {
				if (src.includes("#^")) {
					p.createEl("p", { text: "One paragraph." });
				} else {
					p.createEl("h1", { text: "Section B" });
					p.createEl("p", { text: "One paragraph." });
				}
			});
			// Preconditions: a subpath embed, post-processed with the whole
			// file's path, whose DOM holds no Section A, and the production
			// processor ran its render child's onload.
			expect(embed.parentElement!.getAttribute("src")).toContain("#");
			expect(ctx.sourcePath).toBe(NOTE);
			expect(excerptEl.textContent).not.toContain("Section A");
			expect(childLoaded()).toBe(true);

			const canvas = inkCanvas(embed);
			const ys = canvas ? drawnYs(canvas) : [];
			// CORRECT: ink drawn beside Section A (note y = 30) is not drawn
			// over the Section B excerpt.
			expect
				.soft(
					near(ys, SECTION_A_Y),
					`Section A's stroke (note y=${SECTION_A_Y}) drawn over the excerpt; canvas css ${canvas?.style.width}x${canvas?.style.height}`
				)
				.toBe(false);
			// CORRECT: a one-paragraph excerpt's box is not grown to the bottom
			// of the WHOLE note's ink.
			expect
				.soft(embed.style.minHeight ?? "", "excerpt box min-height grown to the whole note's ink bottom")
				.not.toBe(`${SECTION_B_Y}px`);
		});
	}
});

/**
 * A hover preview, in the shape Obsidian 1.13.7 builds it: the popover's embed
 * renders through the preview renderer, which post-processes the note one
 * section at a time. Each section gets its own ctx (el = the section,
 * containerEl = the renderer's sizer), and getSectionInfo answers from the
 * renderer with the text it holds: the whole file for a whole-note preview,
 * one slice of it for a heading or block preview. The popover carries no
 * `src` naming a subpath, and every ctx has the whole file's path.
 *
 * `sections` builds one section element each; `renderedText` null means the
 * renderer gives no section info.
 */
function renderPopover(
	processor: (el: unknown, ctx: unknown) => void,
	sections: Array<(sec: MiniEl) => void>,
	renderedText: string | null = null
) {
	const doc = new MiniDoc();
	const embed = doc.body.createDiv("popover hover-popover").createDiv("markdown-embed");
	const owner = new Component();
	owner.load();
	const h = embed.createDiv("markdown-embed-content");
	const p = h.createDiv("markdown-preview-view markdown-rendered");
	const sizer = p.createDiv("markdown-preview-sizer markdown-preview-section");
	let infos = 0;
	for (const build of sections) {
		const sec = sizer.createDiv();
		build(sec);
		const ctx = {
			docId: "x",
			sourcePath: NOTE,
			frontmatter: undefined,
			promises: [],
			addChild: (c: Component) => owner.addChild(c),
			getSectionInfo: () => {
				infos++;
				return renderedText === null ? null : { text: renderedText, lineStart: 0, lineEnd: 0 };
			},
			replace: () => null,
			containerEl: sizer,
			el: sec,
		};
		processor(sec, ctx);
	}
	const inkRoots = () => [h, p, sizer].filter((r) => inkCanvas(r) !== null).length;
	return { embed: h, excerptEl: p, inkRoots, sectionInfoCalls: () => infos };
}

describe("EmbedFold-4: a hover preview of one section must not show the whole note's ink", () => {
	it("hover popover of [[inked#Section B]]: no ink canvas, and the box is not stretched", async () => {
		const store = await noteWithInk();
		expect(store.strokes(NOTE).map((s) => s.id)).toEqual(["sA", "sB"]);
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const { embed, excerptEl, inkRoots } = renderPopover(processor, [
			(sec) => sec.createEl("h1", { text: "Section B" }),
			(sec) => sec.createEl("p", { text: "One paragraph." }),
		]);
		expect(excerptEl.textContent).not.toContain("Section A");
		expect(inkRoots(), "an ink canvas was painted in the hover popover").toBe(0);
		expect(embed.style.minHeight ?? "", "popover box grown to the whole note's ink bottom").not.toBe(`${SECTION_B_Y}px`);
	});

	it("control: the same excerpt as a page embed without a subpath still gets its ink", async () => {
		const store = await noteWithInk();
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const { embed } = renderEmbed(processor, "inked", (p) => {
			p.createEl("h1", { text: "Section B" });
		});
		expect(inkCanvas(embed)).not.toBeNull();
	});
});

describe("EmbedFold-4: a hover preview draws ink only when it rendered the whole note", () => {
	const FILE = "# Section A\nnotes...\n# Section B\nOne paragraph.\n";
	const drain = async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	};

	it("whole-note hover: the rendered text is the file, so the note's ink is drawn", async () => {
		noteFileText = FILE;
		const store = await noteWithInk();
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const { inkRoots } = renderPopover(
			processor,
			[(sec) => sec.createEl("h1", { text: "Section A" }), (sec) => sec.createEl("h1", { text: "Section B" })],
			FILE.replace(/\n/g, "\r\n")
		);
		await drain();
		expect(inkRoots(), "a whole-note hover preview got no ink").toBe(1);
	});

	it("heading hover: the rendered text is one section, so no ink is drawn", async () => {
		noteFileText = FILE;
		const store = await noteWithInk();
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const { inkRoots } = renderPopover(
			processor,
			[(sec) => sec.createEl("h1", { text: "Section B" }), (sec) => sec.createEl("p", { text: "One paragraph." })],
			"# Section B\nOne paragraph.\n"
		);
		await drain();
		expect(inkRoots(), "a heading hover preview drew the whole note's ink").toBe(0);
	});

	it("no section info: no ink, the safe answer", async () => {
		noteFileText = FILE;
		const store = await noteWithInk();
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const { inkRoots } = renderPopover(processor, [(sec) => sec.createEl("h1", { text: "Section B" })]);
		await drain();
		expect(inkRoots()).toBe(0);
	});

	it("a long whole-note hover reads the file and asks for section info once per popover, not once per section", async () => {
		const sections = 200;
		const text = Array.from({ length: sections }, (_, i) => `Paragraph ${i}.`).join("\n\n") + "\n";
		noteFileText = text;
		noteReads = 0;
		const store = await noteWithInk();
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const { inkRoots, sectionInfoCalls } = renderPopover(
			processor,
			Array.from({ length: sections }, (_, i) => (sec: MiniEl) => sec.createEl("p", { text: `Paragraph ${i}.` })),
			text
		);
		await drain();
		expect(noteReads, "the file was read once per section").toBe(1);
		expect(sectionInfoCalls(), "section info was asked once per section").toBe(1);
		expect(inkRoots(), "premise: the whole-note popover drew its ink once").toBe(1);
	});
});

/**
 * One popover whose renderer renders more than once into the same sizer, as
 * Obsidian 1.13.7's hover embed does when the note changes under it
 * (onFileChanged -> loadFile -> renderer.set). The renderer keeps a section
 * whose html did not change and post-processes only new ones (parseFinish
 * reuses a section by html, app.js ~1969330). By default `render` replaces
 * every section, the most a render can post-process; `only` replaces just the
 * listed sections and keeps the rest, as a small edit does.
 *
 * `sectionInfoCalls` counts calls; `sectionScan` adds what each call costs
 * Obsidian: getSectionForElement walks the sections in order until one
 * contains the element, so asking about the k-th section costs k.
 */
function openPopover(processor: (el: unknown, ctx: unknown) => void) {
	const doc = new MiniDoc();
	const embed = doc.body.createDiv("popover hover-popover").createDiv("markdown-embed");
	const owner = new Component();
	owner.load();
	const h = embed.createDiv("markdown-embed-content");
	const p = h.createDiv("markdown-preview-view markdown-rendered");
	const sizer = p.createDiv("markdown-preview-sizer markdown-preview-section");
	let infos = 0;
	let scan = 0;
	let shown: MiniEl[] = [];
	// The renderer's text, as getSectionInfo reports it for any of its sections.
	let lastText = "";
	return {
		render(sections: Array<(sec: MiniEl) => void>, renderedText: string, only?: readonly number[]) {
			lastText = renderedText;
			const next: MiniEl[] = [];
			const fresh: Array<{ sec: MiniEl; build: (sec: MiniEl) => void }> = [];
			sections.forEach((build, i) => {
				if (only && !only.includes(i) && shown[i]) {
					next.push(shown[i]!);
					return;
				}
				shown[i]?.remove();
				const sec = sizer.createDiv();
				next.push(sec);
				fresh.push({ sec, build });
			});
			for (const old of shown.slice(sections.length)) old.remove();
			shown = next;
			for (const { sec, build } of fresh) {
				build(sec);
				processor(sec, {
					docId: "x",
					sourcePath: NOTE,
					frontmatter: undefined,
					promises: [],
					addChild: (c: Component) => owner.addChild(c),
					getSectionInfo: (e: unknown) => {
						infos++;
						const k = shown.indexOf((e ?? sec) as MiniEl);
						scan += k < 0 ? shown.length : k + 1;
						return { text: lastText, lineStart: 0, lineEnd: 0 };
					},
					replace: () => null,
					containerEl: sizer,
					el: sec,
				});
			}
		},
		inkRoots: () => [h, p, sizer].filter((r) => inkCanvas(r) !== null).length,
		sectionInfoCalls: () => infos,
		sectionScan: () => scan,
	};
}

describe("EmbedFold-4: a hover preview rendered mid-save gains its ink when it renders the saved text", () => {
	const drain = async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	};
	const OLD = "# Section A\nnotes...\n# Section B\nOne paragraph.\n";
	const SAVED = "# Section A\nnotes, and a line added.\n# Section B\nOne paragraph.\n";

	it("the same popover renders the old text against the saved file, then the saved text: one ink root", async () => {
		noteFileText = SAVED;
		noteReads = 0;
		const store = await noteWithInk();
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const popover = openPopover(processor);
		const sections = [
			(sec: MiniEl) => sec.createEl("h1", { text: "Section A" }),
			(sec: MiniEl) => sec.createEl("h1", { text: "Section B" }),
		];
		popover.render(sections, OLD);
		await drain();
		expect(popover.inkRoots(), "premise: the render that lags the file gets no ink").toBe(0);
		popover.render(sections, SAVED);
		await drain();
		expect(popover.inkRoots(), "the popover stayed inkless after it rendered the saved text").toBe(1);
		expect(noteReads, "the saved render was never compared with the file").toBe(2);
	});

	it("control: a heading popover rendered twice with the same slice stays inkless and reads the file once", async () => {
		noteFileText = SAVED;
		noteReads = 0;
		const store = await noteWithInk();
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const popover = openPopover(processor);
		const slice = "# Section B\nOne paragraph.\n";
		const sections = [
			(sec: MiniEl) => sec.createEl("h1", { text: "Section B" }),
			(sec: MiniEl) => sec.createEl("p", { text: "One paragraph." }),
		];
		popover.render(sections, slice);
		await drain();
		popover.render(sections, slice);
		await drain();
		expect(popover.inkRoots(), "a heading hover preview drew the whole note's ink").toBe(0);
		expect(noteReads, "the same slice was compared with the file again").toBe(1);
	});
});

describe("EmbedFold-4: a popover asks its render for its text once per render, and a new render is compared afresh", () => {
	const drain = async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve();
	};
	const OLD = "# Section A\nnotes...\n# Section B\nOne paragraph.\n";
	const SAVED = "# Section A\nnotes, and a line added.\n# Section B\nOne paragraph.\n";
	const two = [
		(sec: MiniEl) => sec.createEl("h1", { text: "Section A" }),
		(sec: MiniEl) => sec.createEl("h1", { text: "Section B" }),
	];

	/**
	 * A heading hover is always refused. Asking its render for its text walks
	 * the renderer's sections, so asking once per section costs about n*n/2
	 * per render; once per render costs n at most.
	 */
	it("a refused 200-section heading popover rendered three times asks once per render", async () => {
		noteFileText = SAVED;
		noteReads = 0;
		const store = await noteWithInk();
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const popover = openPopover(processor);
		const n = 200;
		const slice = "# Section B\n" + Array.from({ length: n - 1 }, (_, i) => `Paragraph ${i}.`).join("\n\n") + "\n";
		const sections = Array.from({ length: n }, (_, i) => (sec: MiniEl) => sec.createEl("p", { text: `Paragraph ${i}.` }));
		for (let r = 0; r < 3; r++) {
			popover.render(sections, slice);
			await drain();
		}
		expect(popover.inkRoots(), "premise: a heading popover stays inkless").toBe(0);
		expect(noteReads, "the same slice was compared with the file again").toBe(1);
		expect(popover.sectionInfoCalls(), "section info was asked per section, not per render").toBe(3);
		expect(popover.sectionScan(), "the asks walked the renderer's sections per section").toBeLessThanOrEqual(3 * n);
	});

	it("the saved text rendered while the old comparison is still pending is compared afresh: one ink root", async () => {
		noteFileText = SAVED;
		noteReads = 0;
		const store = await noteWithInk();
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const popover = openPopover(processor);
		let release!: () => void;
		readGate = new Promise<void>((r) => (release = r));
		try {
			popover.render(two, OLD);
			await drain();
			expect(noteReads, "premise: the old render's comparison has started").toBe(1);
			popover.render(two, SAVED);
			await drain();
		} finally {
			readGate = null;
			release();
		}
		await drain();
		expect(popover.inkRoots(), "the saved render took the old render's pending answer").toBe(1);
		expect(noteReads, "the saved render was never compared with the file").toBe(2);
	});

	it("an edit that re-renders only the changed section still compares the saved text: one ink root", async () => {
		noteFileText = SAVED;
		noteReads = 0;
		const store = await noteWithInk();
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const popover = openPopover(processor);
		popover.render(two, OLD);
		await drain();
		expect(popover.inkRoots(), "premise: the render that lags the file gets no ink").toBe(0);
		popover.render(two, SAVED, [0]);
		await drain();
		expect(popover.inkRoots(), "the popover stayed inkless after it rendered the saved text").toBe(1);
		expect(noteReads).toBe(2);
	});
});
