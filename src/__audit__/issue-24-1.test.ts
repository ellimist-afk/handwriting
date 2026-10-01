/**
 * AUDIT PROBE issue-24-1 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: the markdown post-processor at main.ts:2071 has only a ".md" guard.
 * Obsidian 1.13.7 runs every registered post-processor inside Live Preview's
 * callout widget (I3.initDOM, verified in obsidian-1.13.7.asar at byte
 * ~3712235: s = createDiv("cm-embed-block " + "cm-callout"),
 * l = s.createDiv("markdown-rendered"), then $W.postProcess(app, {sourcePath:
 * r.path, addChild: e => t.addChild(e), containerEl: s, el: l, ...}); the
 * static postProcess at ~2736368 loops AW.postProcessors, which is where
 * Plugin.registerMarkdownPostProcessor puts ours (~3628253); zq.addChild is
 * this.editor.addChild(e), and Component.addChild loads the child at once
 * when the parent is loaded). The open note's ink is loaded, so attach runs
 * synchronously; embedInkRoot (EmbedInk.ts:201-207) falls through to
 * closest(".markdown-rendered"), which is l itself; paint appends a
 * canvas.handwriting-embed-ink with the whole note's ink into the callout,
 * and embedInkChanged repaints it after each saved gesture.
 *
 * Production code driven: the post-processor lambda sliced verbatim out of
 * main.ts and executed; the real attachEmbedInkOnceReady / embedInkChanged /
 * initEmbedInkRefresh / teardownEmbedInk; a fresh real InlineInkStore (the
 * class behind main's `inlineInk` singleton, InkOverlay.ts:927) loaded
 * through its own ensureLoaded; the real runDetached. Only the host (DOM
 * element shapes, ctx object, Component.addChild) is a stand-in, modelled on
 * the asar code quoted above.
 *
 * Assertions state the CORRECT behaviour: no ink canvas inside a Live
 * Preview widget. Green = no bug; red on the "ghost" assertions = bug.
 */
import { afterEach, describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import { isMarkdownPath, stripMarkdownExtension } from "../util/MarkdownPath";
import mainSource from "../main.ts?raw";
import {
	attachEmbedInkOnceReady,
	embedInkIsLiveEditorBlock,
	disarmPrintSwaps,
	embedInkChanged,
	embedInkLayerCount,
	initEmbedInkRefresh,
	teardownEmbedInk,
} from "../inline/EmbedInk";
import { InlineInkStore, InlineInkHost } from "../inline/InlineInkStore";
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";
import { runDetached } from "../util/Detached";

// ---- the production post-processor, verbatim out of main.ts ---------------
const src = mainSource.replace(/\r\n/g, "\n");
const HEAD = "\t\tthis.registerMarkdownPostProcessor((el, ctx) => {\n";
const TAIL = "\n\t\t});\n\t\t// Embed layers stop going stale";
expect(src.split(HEAD)).toHaveLength(2);
expect(src.split(TAIL)).toHaveLength(2);
const bodyStart = src.indexOf(HEAD) + HEAD.length;
const body = src.slice(bodyStart, src.indexOf(TAIL, bodyStart));
expect(body).toContain('if (!path || !isMarkdownPath(path)) return;');
expect(body).toContain("if (inlineInk.isLoaded(path)) {");
expect(body).toContain("cancelRetry = attachEmbedInkOnceReady(el, container, path, () =>");
expect(body).toContain("ctx.addChild(child);");
expect(body).not.toMatch(/\bthis\./); // nothing from the plugin instance is needed
const makeProcessorRaw = new Function(
	"MarkdownRenderChild",
	"attachEmbedInkOnceReady",
	"inlineInk",
	"runDetached",
	"embedInkIsLiveEditorBlock",
	"isMarkdownPath",
	transformSync(`return (el: any, ctx: any) => {\n${body}\n};`, { loader: "ts", target: "es2022" }).code
) as (
	mrc: unknown,
	attach: typeof attachEmbedInkOnceReady,
	store: InlineInkStore,
	detached: typeof runDetached,
	liveBlock: typeof embedInkIsLiveEditorBlock,
	isMd: typeof isMarkdownPath
) => (el: unknown, ctx: unknown) => void;
// 1.4.22 lane R: the post-processor also calls embedInkIsLiveEditorBlock (issue 22 fix).
const makeProcessor = (
	mrc: unknown,
	attach: typeof attachEmbedInkOnceReady,
	store: InlineInkStore,
	detached: typeof runDetached
) => makeProcessorRaw(mrc, attach, store, detached, embedInkIsLiveEditorBlock, isMarkdownPath);

// ---- host Component semantics (app.js 1.13.7) ------------------------------
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
	// addChild=function(e){return this._children.push(e),this._loaded&&e.load(),e}
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

// ---- a minimal DOM with a real closest() and ":scope > x" ------------------
class Doc {
	readonly documentElement: El;
	readonly body: El;
	readonly defaultView = {
		devicePixelRatio: 2,
		getComputedStyle: (el: El) => ({ position: el.style.position || "static" }),
		addEventListener: (): void => {},
		removeEventListener: (): void => {},
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		setTimeout: (): number => 0,
		clearTimeout: (): void => {},
	};
	constructor() {
		this.documentElement = new El("html", this);
		this.body = this.documentElement.createEl("body");
	}
}
class El {
	readonly children: El[] = [];
	readonly classes = new Set<string>();
	readonly attrs = new Map<string, string>();
	readonly style: Record<string, string> & { removeProperty(p: string): void } = (() => {
		const rec: Record<string, string> = {};
		const camel = (p: string) => p.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
		return Object.assign(rec, { removeProperty: (p: string) => void delete rec[camel(p)] });
	})();
	parentElement: El | null = null;
	width = 0;
	height = 0;
	readonly drawCalls: string[] = [];
	readonly classList = {
		contains: (c: string) => this.classes.has(c),
		add: (c: string) => void this.classes.add(c),
		remove: (c: string) => void this.classes.delete(c),
	};
	constructor(readonly tagName: string, readonly ownerDocument: Doc, cls = "") {
		for (const c of cls.split(" ").filter(Boolean)) this.classes.add(c);
	}
	get isConnected(): boolean {
		let n: El = this;
		while (n.parentElement) n = n.parentElement;
		return n === this.ownerDocument.documentElement;
	}
	matches(sel: string): boolean {
		const m = /^([a-z]*)((?:\.[a-zA-Z0-9_-]+)*)$/.exec(sel);
		if (!m) throw new Error(`El: unsupported selector ${sel}`);
		if (m[1] && m[1] !== this.tagName) return false;
		return (m[2] ?? "").split(".").filter(Boolean).every((c) => this.classes.has(c));
	}
	closest<T = El>(sel: string): T | null {
		for (let n: El | null = this; n; n = n.parentElement) if (n.matches(sel)) return n as unknown as T;
		return null;
	}
	querySelector<T = El>(sel: string): T | null {
		const m = /^:scope > (.+)$/.exec(sel);
		if (!m) throw new Error(`El: unsupported querySelector ${sel}`);
		return (this.children.find((k) => k.matches(m[1]!)) ?? null) as unknown as T | null;
	}
	appendChild(c: El): El {
		c.parentElement?.children.splice(c.parentElement.children.indexOf(c), 1);
		this.children.push(c);
		c.parentElement = this;
		return c;
	}
	createEl(tag: string, opts: { cls?: string } = {}): El {
		return this.appendChild(new El(tag, this.ownerDocument, opts.cls ?? ""));
	}
	createDiv(cls: string | { cls?: string } = ""): El {
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
		return { left: 0, top: 0, width: 640, height: 90 };
	}
	getContext(): CanvasRenderingContext2D {
		const props: Record<string | symbol, unknown> = {};
		return new Proxy(props, {
			get: (_t, p) => (p in props ? props[p] : (..._a: unknown[]) => void this.drawCalls.push(String(p))),
			set: (_t, p, v) => ((props[p] = v), true),
		}) as unknown as CanvasRenderingContext2D;
	}
}

// ---- the open note: ink near the top, loaded through the real store -------
const NOTE = "Bug notes.md";
function stroke(id: string, y: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 60, y, pressure: 0.5, t: 0 },
			{ x: 160, y: y + 4, pressure: 0.5, t: 8 },
			{ x: 260, y, pressure: 0.5, t: 16 },
		],
		bbox: { x: 60, y, width: 200, height: 4 },
		createdAt: 0,
	} as InkStroke;
}
class Host implements InlineInkHost {
	readonly pages = new Map<string, ParseResult>();
	readPageId(p: string): string | null {
		return p === NOTE ? "pg1" : null;
	}
	async claimId(_p: string, id: string) {
		return { pageId: id };
	}
	async loadSidecar(id: string): Promise<ParseResult | null> {
		return this.pages.get(id) ?? null;
	}
	scheduleSidecar(): void {}
	notify(): void {}
}
async function openNote(): Promise<InlineInkStore> {
	const store = new InlineInkStore();
	const host = new Host();
	const page: PageData = emptyPage("pg1");
	page.surface = "inline";
	page.strokes = [stroke("a", 40), stroke("b", 900)];
	host.pages.set("pg1", { data: page, recovered: false, damaged: false } as ParseResult);
	store.attachHost(host);
	await store.ensureLoaded(NOTE);
	return store;
}

/** The note's Live Preview leaf; reading view is a SIBLING, never an ancestor. */
function livePreviewLeaf(doc: Doc) {
	const viewContent = doc.body.createDiv("workspace-leaf-content").createDiv("view-content");
	const sourceView = viewContent.createDiv("markdown-source-view cm-s-obsidian mod-cm6 is-live-preview");
	viewContent.createDiv("markdown-reading-view").createDiv("markdown-preview-view markdown-rendered");
	const cmContent = sourceView
		.createDiv("cm-editor")
		.createDiv("cm-scroller")
		.createDiv("cm-sizer")
		.createDiv("cm-contentContainer")
		.createDiv("cm-content");
	const editor = new Component();
	editor.load(); // the MarkdownView's editor is loaded while the note is open
	return { sourceView, cmContent, editor };
}

function inkCanvases(el: El): El[] {
	const out: El[] = [];
	const walk = (n: El) => {
		for (const k of n.children) {
			if (k.tagName === "canvas" && k.classes.has("handwriting-embed-ink")) out.push(k);
			walk(k);
		}
	};
	walk(el);
	return out;
}
const describeGhosts = (list: El[]) =>
	list.map((c) => ({
		in: [...(c.parentElement?.classes ?? [])].join(" "),
		css: `${c.style.width}x${c.style.height}`,
		backing: `${c.width}x${c.height}`,
		drawOps: c.drawCalls.length,
	}));

afterEach(() => {
	teardownEmbedInk();
	disarmPrintSwaps();
	initEmbedInkRefresh(() => []);
});

describe("issue-24-1: Live Preview callout/table widgets must not carry a copy of the note's ink", () => {
	it("control: a real embed of the note DOES get the layer (the probe can see one)", async () => {
		const store = await openNote();
		const pp = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const doc = new Doc();
		const embed = doc.body.createDiv("internal-embed markdown-embed").createDiv("markdown-embed-content");
		const sizer = embed.createDiv("markdown-preview-sizer markdown-preview-section");
		const section = sizer.createDiv();
		const parent = new Component();
		parent.load();
		pp(section, { sourcePath: NOTE, addChild: (c: Component) => parent.addChild(c), containerEl: sizer, el: section });
		const got = inkCanvases(embed);
		expect(got).toHaveLength(1);
		expect(got[0]!.drawCalls.length).toBeGreaterThan(0);
	});

	it("callout widget in Live Preview: no ink canvas in the callout, at render or after the next saved stroke", async () => {
		const store = await openNote();
		// Preconditions: the note is open with ink, so main.ts attaches synchronously.
		expect(store.isLoaded(NOTE)).toBe(true);
		expect(store.strokes(NOTE)).toHaveLength(2);
		const pp = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const doc = new Doc();
		const { sourceView, cmContent, editor } = livePreviewLeaf(doc);

		// I3.initDOM (L3 passes "cm-callout"), in the asar's order.
		const s = new El("div", doc, "cm-embed-block cm-callout");
		const l = s.createDiv("markdown-rendered");
		l.createDiv("callout").createDiv("callout-title");
		let loaded = 0;
		pp(l, {
			docId: "d1",
			sourcePath: NOTE,
			frontmatter: undefined,
			promises: [],
			addChild: (c: Component) => {
				editor.addChild(c); // zq.addChild -> this.editor.addChild(e)
				if (c._loaded) loaded++;
			},
			getSectionInfo: () => null,
			replace: () => null,
			containerEl: s,
			el: l,
			displayMode: false,
		});
		cmContent.appendChild(s); // CodeMirror inserts the widget DOM
		// 1.4.22 lane R: the fixed post-processor builds no render child for a Live
		// Preview widget, so the probe's render-child precondition held only at the
		// defect. The ink assertions below stand.
		expect(s.closest(".markdown-source-view")).toBe(sourceView);

		const atRender = describeGhosts(inkCanvases(s));
		// The user draws another stroke: commitGesture -> notifyInkChanged ->
		// main.ts onInkChanged -> embedInkChanged(path).
		initEmbedInkRefresh(() => [...store.strokes(NOTE), stroke("c", 120)]);
		embedInkChanged(NOTE);
		const afterStroke = describeGhosts(inkCanvases(s));

		expect(
			{ atRender, afterStroke, registeredRoots: embedInkLayerCount() },
			"ghost ink canvas inside a Live Preview callout"
		).toEqual({ atRender: [], afterStroke: [], registeredRoots: 0 });
	});

	it("table widget in Live Preview: no ink canvas in the table", async () => {
		const store = await openNote();
		expect(store.isLoaded(NOTE)).toBe(true);
		const pp = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const doc = new Doc();
		const { cmContent, editor } = livePreviewLeaf(doc);
		const widget = cmContent.createDiv("cm-embed-block cm-table-widget markdown-rendered");
		const cell = widget
			.createDiv("table-wrapper")
			.createEl("table", { cls: "table-editor" })
			.createEl("tbody")
			.createEl("tr")
			.createEl("td")
			.createDiv("table-cell-wrapper");
		let loaded = 0;
		pp(cell, {
			docId: "d2",
			sourcePath: NOTE,
			frontmatter: undefined,
			promises: [],
			addChild: (c: Component) => {
				editor.addChild(c);
				if (c._loaded) loaded++;
			},
			getSectionInfo: () => null,
			replace: () => null,
			containerEl: widget,
			el: cell,
			displayMode: false,
		});
		// 1.4.22 lane R: the fixed post-processor builds no render child for a Live
		// Preview widget, so the probe's render-child precondition held only at the
		// defect. The ink assertions below stand.
		expect(describeGhosts(inkCanvases(widget)), "ghost ink canvas inside a Live Preview table").toEqual([]);
	});
});
