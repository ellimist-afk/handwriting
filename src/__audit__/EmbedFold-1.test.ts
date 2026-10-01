/**
 * AUDIT PROBE EmbedFold-1 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: the markdown post-processor registered at main.ts:2071 has no Live
 * Preview guard. Obsidian 1.13.7 runs plugin post-processors for Live Preview
 * callout widgets (I3.initDOM: el = new div.markdown-rendered inside
 * div.cm-embed-block.cm-callout, containerEl = that block) and table cells
 * (rerenderCell -> postProcess: el = cell contentEl, containerEl =
 * div.cm-embed-block.cm-table-widget.markdown-rendered). embedInkRoot's last
 * fallback ".markdown-rendered" (EmbedInk.ts:206) matches, so a
 * canvas.handwriting-embed-ink with the whole note's ink, in note coordinates
 * from 0,0, is painted inside the callout / table widget, on top of the ink
 * overlay's own copy.
 *
 * Production code driven: the post-processor lambda sliced verbatim out of
 * main.ts (2071-2121) and executed; the real attachEmbedInkOnceReady /
 * embedInkChanged / teardownEmbedInk (EmbedInk.ts); the real InlineInkStore
 * class (fresh instance, loaded through its own ensureLoaded with a fake
 * host, as InlineInkStore.reload.test.ts does); the real runDetached.
 * The DOM is a minimal stand-in reproducing exactly the element shapes and
 * the ctx object Obsidian 1.13.7 app.js builds (quoted in the finding), and
 * Component.addChild semantics (`this._loaded && e.load()`).
 *
 * Assertions state the CORRECT behaviour (no second, read-only copy of the
 * note's ink inside a Live Preview widget): green = no bug, red = bug.
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
// It is the embed-ink processor and it has only the ".md" guard.
expect(ppBody).toContain('if (!path || !isMarkdownPath(path)) return;');
expect(ppBody).toContain("cancelRetry = attachEmbedInkOnceReady(el, container, path, () =>");
expect(ppBody).toContain("ctx.addChild(child);");
const makeProcessorRaw = new Function(
	"MarkdownRenderChild",
	"attachEmbedInkOnceReady",
	"inlineInk",
	"runDetached",
	"embedInkIsLiveEditorBlock",
	"isMarkdownPath",
	transformSync(`return (el: any, ctx: any) => {\n${ppBody}\n};`, {
		loader: "ts",
		target: "es2022",
	}).code
);
// 1.4.22 lane R: the post-processor also calls embedInkIsLiveEditorBlock (issue 22 fix).
const makeProcessor = (...deps: unknown[]) => makeProcessorRaw(...deps, embedInkIsLiveEditorBlock, isMarkdownPath);

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
	private matches(sel: string): boolean {
		// tag, .class, tag.class, .a.b
		const m = /^([a-z]*)((?:\.[a-zA-Z0-9_-]+)*)$/.exec(sel);
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
	createEl(tag: string, opts: { cls?: string } = {}): MiniEl {
		return this.appendChild(new MiniEl(tag, this.ownerDocument, opts.cls ?? ""));
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

// ---- the note: one stroke near the top, loaded by the real store -----------
const NOTE = "note.md";
function topStroke(id: string, y = 30): InkStroke {
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
async function openNoteWithInk(): Promise<InlineInkStore> {
	const store = new InlineInkStore();
	const host = new FakeHost();
	const page: PageData = emptyPage("p1");
	page.surface = "inline";
	page.strokes = [topStroke("s1")];
	host.sidecars.set("p1", { data: page, recovered: false, damaged: false } as ParseResult);
	store.attachHost(host);
	await store.ensureLoaded(NOTE); // what the overlay does when the note opens
	return store;
}

/** The Live Preview editor of the open note, as the ancestors Obsidian gives it. */
function liveEditor(doc: MiniDoc) {
	const leaf = doc.body.createDiv("workspace-leaf-content");
	const view = leaf.createDiv("view-content");
	const source = view.createDiv("markdown-source-view cm-s-obsidian mod-cm6 is-live-preview");
	// Reading view is a SIBLING of the source view, never an ancestor.
	view.createDiv("markdown-reading-view").createDiv("markdown-preview-view markdown-rendered");
	const content = source
		.createDiv("cm-editor")
		.createDiv("cm-scroller")
		.createDiv("cm-sizer")
		.createDiv("cm-contentContainer")
		.createDiv("cm-content");
	// The MarkdownView's editor component: loaded while the note is open.
	const editor = new Component();
	editor.load();
	return { content, editor };
}

function inkCanvases(el: MiniEl): MiniEl[] {
	const out: MiniEl[] = [];
	const walk = (n: MiniEl) => {
		for (const k of n.children) {
			if (k.tagName === "canvas" && k.classes.has("handwriting-embed-ink")) out.push(k);
			walk(k);
		}
	};
	walk(el);
	return out;
}

afterEach(() => {
	teardownEmbedInk();
	disarmPrintSwaps();
});

describe("EmbedFold-1: Live Preview widgets must not get a copy of the note's ink", () => {
	it("control: a real embed (.markdown-embed-content) does get the ink layer, so the probe can see one", async () => {
		const store = await openNoteWithInk();
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const doc = new MiniDoc();
		const embed = doc.body.createDiv("internal-embed markdown-embed").createDiv("markdown-embed-content");
		const sizer = embed.createDiv("markdown-preview-sizer markdown-preview-section");
		const section = sizer.createDiv();
		const parent = new Component();
		parent.load();
		processor(section, {
			sourcePath: NOTE,
			addChild: (c: Component) => parent.addChild(c),
			containerEl: sizer,
			el: section,
		});
		expect(inkCanvases(embed)).toHaveLength(1);
	});

	it("callout widget (I3.initDOM, cm-callout): no ink canvas inside the callout", async () => {
		const store = await openNoteWithInk();
		// Precondition: the note is open and has ink near its top.
		expect(store.isLoaded(NOTE)).toBe(true);
		expect(store.strokes(NOTE)).toHaveLength(1);
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const doc = new MiniDoc();
		const { content, editor } = liveEditor(doc);

		// app.js 1.13.7 I3.initDOM, verbatim shape:
		//   s = this.containerEl = createDiv("cm-embed-block " + a)   // a = "cm-callout"
		//   l = s.createDiv("markdown-rendered"); l.appendChild(html)
		//   $W.postProcess(app, {sourcePath: r.path, addChild: e => t.addChild(e),
		//     containerEl: s, el: l, ...})  -> for each AW.postProcessors: p(el, ctx)
		// t.addChild is zq.addChild: this.editor.addChild(e), this.children.push(e)
		const s = new MiniEl("div", doc, "cm-embed-block cm-callout");
		const l = s.createDiv("markdown-rendered");
		l.createDiv("callout").createDiv("callout-title");
		const widgetChildren: Component[] = [];
		let onloadRan = false;
		const addChild = (c: Component) => {
			const orig = c.onload;
			c.onload = function (this: Component) {
				onloadRan = true;
				return orig.call(this);
			};
			editor.addChild(c);
			widgetChildren.push(c);
		};
		processor(l, {
			docId: "x",
			sourcePath: NOTE,
			frontmatter: undefined,
			promises: [],
			addChild,
			getSectionInfo: () => null,
			replace: () => null,
			containerEl: s,
			el: l,
			displayMode: false,
		});
		// CodeMirror then inserts the widget DOM into .cm-content.
		content.appendChild(s);

		// Precondition: the production processor did run to its child's onload.

		// CORRECT: the overlay already draws the note's ink in place; the
		// callout widget must not carry a second, read-only copy of it.
		const ghosts = inkCanvases(s);
		expect(
			ghosts.map((g) => ({
				parent: [...(g.parentElement?.classes ?? [])].join(" "),
				cssSize: `${g.style.width}x${g.style.height}`,
				firstMoveTo: g.calls.find(([n]) => n === "moveTo")?.[1],
			})),
			"ink canvas painted inside a Live Preview callout widget"
		).toEqual([]);
	});

	it("table widget (rerenderCell -> postProcess): no ink canvas inside the table, and none added on the next pen-up", async () => {
		const store = await openNoteWithInk();
		expect(store.isLoaded(NOTE)).toBe(true);
		const processor = makeProcessor(MarkdownRenderChild, attachEmbedInkOnceReady, store, runDetached);
		const doc = new MiniDoc();
		const { content, editor } = liveEditor(doc);

		// app.js 1.13.7 table widget:
		//   o.containerEl = createDiv({cls: "cm-embed-block cm-table-widget markdown-rendered"})
		//   postProcess(e): $W.postProcess(i, {sourcePath: a.path, addChild: n => (r.get(e).push(n), t.addChild(n)),
		//     containerEl: o, el: s /* = e.contentEl */, ...})
		const widget = content.createDiv("cm-embed-block cm-table-widget markdown-rendered");
		const cell = widget
			.createDiv("table-wrapper")
			.createEl("table", { cls: "table-editor" })
			.createEl("tbody")
			.createEl("tr")
			.createEl("td")
			.createDiv("table-cell-wrapper");
		const cellChildren: Component[] = [];
		processor(cell, {
			docId: "y",
			sourcePath: NOTE,
			frontmatter: undefined,
			promises: [],
			addChild: (c: Component) => {
				cellChildren.push(c);
				editor.addChild(c);
			},
			getSectionInfo: () => null,
			replace: () => null,
			containerEl: widget,
			el: cell,
			displayMode: false,
		});

		const before = inkCanvases(widget).length;
		const layersBefore = embedInkLayerCount();
		// The user draws another stroke: InkOverlay notifyInkChanged ->
		// main.ts:2125 embedInkChanged(path) repaints every registered root.
		const store2Strokes = [...store.strokes(NOTE), topStroke("s2", 60)];
		const { initEmbedInkRefresh } = await import("../inline/EmbedInk");
		initEmbedInkRefresh(() => store2Strokes);
		embedInkChanged(NOTE);
		const canvases = inkCanvases(widget);
		const moveTos = canvases.flatMap((c) => c.calls.filter(([n]) => n === "moveTo").map(([, a]) => a));

		// CORRECT: no copy of the note's ink lives in the table widget.
		expect(
			{ atPostProcess: before, registeredRoots: layersBefore, afterPenUp: canvases.length, moveTos },
			"ink canvas painted inside a Live Preview table widget"
		).toEqual({ atPostProcess: 0, registeredRoots: 0, afterPenUp: 0, moveTos: [] });
	});
});
