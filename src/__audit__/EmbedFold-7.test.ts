/**
 * AUDIT PROBE EmbedFold-7 (read-only audit of 1.4.21, tag 1a05f62c).
 *
 * Claim: embedInkChanged (EmbedInk.ts:460-467) repaints every registered root
 * showing the path, and the only registry removal on that path is
 * `!root.isConnected` (EmbedInk.ts:477). Obsidian 1.13.7 keeps a MarkdownView's
 * reading view in the DOM when the tab switches to Live Preview: setMode runs
 * `n.hide(),this.currentMode=e,e.show()`, the preview mode's hide is
 * `this.containerEl.hide()` on the `.markdown-reading-view` div, and
 * enhance.js's HTMLElement.prototype.hide only sets `style.display = "none"`.
 * So once a note has been shown in reading view, every pen-up in Live
 * Preview in that tab redraws all of the note's ink into a canvas under a
 * display:none ancestor.
 *
 * Production code driven: the real InlineInkStore (fresh instance loaded
 * through ensureLoaded with a fake host, as InlineInkStore.reload.test.ts and
 * EmbedFold-1 do), its real commitGesture -> notifyInkChanged (InkEvents.ts),
 * the real attachEmbedInkOnceReady / initEmbedInkRefresh / embedInkChanged /
 * paint / drawStroke. The two wiring lines from main.ts (2124-2125) are
 * asserted present verbatim and then made with the same real functions.
 * The DOM is a minimal stand-in reproducing the element shapes Obsidian
 * 1.13.7 builds (MarkdownView contentEl > div.markdown-reading-view >
 * div.markdown-preview-view > div.markdown-preview-sizer > section) plus
 * display:none semantics (0x0 rect, null offsetParent) under a hidden
 * ancestor, which is what the browser gives.
 *
 * Assertions state the CORRECT behaviour (a pen-up does no drawing into a
 * canvas nobody can see): green = no bug, red = bug.
 */
import { afterEach, describe, expect, it } from "vitest";
import mainSource from "../main.ts?raw";
import {
	attachEmbedInkOnceReady,
	disarmPrintSwaps,
	embedInkLayerCount,
	embedInkChanged,
	initEmbedInkRefresh,
	teardownEmbedInk,
} from "../inline/EmbedInk";
import { onInkChanged } from "../inline/InkEvents";
import { InlineInkStore, InlineInkHost } from "../inline/InlineInkStore";
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import { InkStroke } from "../ink/Stroke";

// ---- the wiring main.ts does at plugin load (asserted verbatim) -------------
const source = mainSource.replace(/\r\n/g, "\n");
expect(source).toContain("\t\tinitEmbedInkRefresh((p) => inlineInk.strokes(p));\n");
expect(source).toContain("\t\tthis.register(onInkChanged((p) => embedInkChanged(p)));\n");

// ---- minimal DOM with display:none semantics --------------------------------
type Call = [string, unknown[]];
class MiniDoc {
	readonly documentElement: MiniEl;
	readonly body: MiniEl;
	computedStyleReads = 0;
	readonly defaultView = {
		devicePixelRatio: 1,
		getComputedStyle: (el: MiniEl) => {
			this.computedStyleReads++;
			// Obsidian's stylesheet makes .markdown-preview-view position: relative.
			const cssPos = el.classes.has("markdown-preview-view") ? "relative" : "static";
			return { position: el.style.position || cssPos };
		},
		addEventListener: (): void => {},
		removeEventListener: (): void => {},
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		setTimeout: (): number => 0,
		clearTimeout: (): void => {},
		// Observers exist (as in Electron / mobile WebView); callbacks are
		// recorded so the probe could fire them, never fired implicitly.
		ResizeObserver: class {
			constructor(readonly cb: () => void) {}
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		},
		MutationObserver: class {
			constructor(readonly cb: () => void) {}
			observe(): void {}
			disconnect(): void {}
		},
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
	rectReads = 0;
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
	/** Rendered at all: connected and no display:none on itself or an ancestor. */
	get rendered(): boolean {
		if (!this.isConnected) return false;
		for (let n: MiniEl | null = this; n; n = n.parentElement) if (n.style.display === "none") return false;
		return true;
	}
	get offsetParent(): MiniEl | null {
		if (!this.rendered) return null;
		for (let n = this.parentElement; n; n = n.parentElement) {
			const pos = this.ownerDocument.defaultView.getComputedStyle(n).position;
			if (pos !== "static") return n;
		}
		return null;
	}
	get offsetLeft(): number {
		return this.rendered ? 48 : 0;
	}
	get offsetTop(): number {
		return this.rendered ? 0 : 0;
	}
	private matches(sel: string): boolean {
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
		this.rectReads++;
		return this.rendered
			? { left: 0, top: 0, width: 700, height: 900 }
			: { left: 0, top: 0, width: 0, height: 0 };
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

// ---- the note, loaded by the real store --------------------------------------
const NOTE = "note.md";
function stroke(id: string, y: number, points = 24): InkStroke {
	const pts = [];
	for (let i = 0; i < points; i++) pts.push({ x: 40 + i * 10, y: y + (i % 3), pressure: 0.5, t: i * 8 });
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2.2,
		points: pts,
		bbox: { x: 40, y, width: (points - 1) * 10, height: 2 },
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
async function openNoteWithInk(strokeCount: number): Promise<InlineInkStore> {
	const store = new InlineInkStore();
	const host = new FakeHost();
	const page: PageData = emptyPage("p1");
	page.surface = "inline";
	page.strokes = Array.from({ length: strokeCount }, (_, i) => stroke(`s${i}`, 30 + i * 12));
	host.sidecars.set("p1", { data: page, recovered: false, damaged: false } as ParseResult);
	store.attachHost(host);
	await store.ensureLoaded(NOTE);
	return store;
}

/** One MarkdownView tab: contentEl holding the source view and the reading view as siblings. */
function markdownTab(doc: MiniDoc) {
	const leaf = doc.body.createDiv("workspace-leaf-content");
	const contentEl = leaf.createDiv("view-content");
	contentEl.createDiv("markdown-source-view cm-s-obsidian mod-cm6 is-live-preview");
	// app.js 1.13.7 $W ctor: i = t.contentEl.createDiv("markdown-reading-view")
	const readingView = contentEl.createDiv("markdown-reading-view");
	const previewView = readingView.createDiv("markdown-preview-view markdown-rendered");
	const sizer = previewView.createDiv("markdown-preview-sizer markdown-preview-section");
	const section = sizer.createDiv();
	return { readingView, previewView, sizer, section };
}
/** Obsidian enhance.js HTMLElement.prototype.hide, verbatim semantics. */
function obsidianHide(el: MiniEl): void {
	const t = el.style.display;
	if (t !== "none") {
		el.style.display = "none";
		if (t) el.setAttribute("data-display", t);
		else el.removeAttribute("data-display");
	}
}
function inkCanvas(root: MiniEl): MiniEl | null {
	return root.children.find((k) => k.tagName === "canvas" && k.classes.has("handwriting-embed-ink")) ?? null;
}

let unsubscribe: (() => void) | null = null;
afterEach(() => {
	unsubscribe?.();
	unsubscribe = null;
	teardownEmbedInk();
	disarmPrintSwaps();
});

async function scenario(strokeCount: number) {
	const store = await openNoteWithInk(strokeCount);
	expect(store.isLoaded(NOTE)).toBe(true);
	expect(store.strokes(NOTE)).toHaveLength(strokeCount);
	// main.ts:2124-2125, same real functions.
	initEmbedInkRefresh((p) => store.strokes(p));
	unsubscribe = onInkChanged((p) => embedInkChanged(p));

	const doc = new MiniDoc();
	const tab = markdownTab(doc);
	// Control root: the same note embedded, visible, in another pane.
	const other = doc.body.createDiv("workspace-leaf-content").createDiv("view-content");
	const embedRoot = other.createDiv("internal-embed markdown-embed").createDiv("markdown-embed-content");
	const embedSection = embedRoot.createDiv("markdown-preview-sizer markdown-preview-section").createDiv();

	// 1. The note is shown in reading view: the post-processor's route 1
	//    (section already in the tree) attaches the layer to .markdown-preview-view.
	attachEmbedInkOnceReady(tab.section as unknown as HTMLElement, tab.sizer as unknown as HTMLElement, NOTE, () =>
		store.strokes(NOTE)
	);
	attachEmbedInkOnceReady(embedSection as unknown as HTMLElement, null, NOTE, () => store.strokes(NOTE));
	expect(embedInkLayerCount()).toBe(2);
	const hiddenCanvas = inkCanvas(tab.previewView);
	const embedCanvas = inkCanvas(embedRoot);
	expect(hiddenCanvas).not.toBeNull();
	expect(embedCanvas).not.toBeNull();
	// The counter works: the visible first paint drew.
	expect(hiddenCanvas!.calls.length).toBeGreaterThan(0);

	// 2. Ctrl+E: setMode -> previewMode.hide() -> containerEl.hide().
	obsidianHide(tab.readingView);
	expect(tab.readingView.style.display).toBe("none");
	expect(tab.previewView.isConnected).toBe(true); // hidden, not detached
	expect(tab.previewView.rendered).toBe(false);
	expect(hiddenCanvas!.rendered).toBe(false);

	hiddenCanvas!.calls.length = 0;
	embedCanvas!.calls.length = 0;
	tab.previewView.rectReads = 0;
	doc.computedStyleReads = 0;

	// 3. One pen-up in Live Preview: InkOverlay -> handoffFinishedStroke ->
	//    store() -> inlineInk.commitGesture (the real one).
	store.commitGesture(NOTE, [stroke("new1", 30 + strokeCount * 12)]);
	expect(store.strokes(NOTE)).toHaveLength(strokeCount + 1);
	// Control: the notification reached embedInkChanged and a visible root repainted.
	expect(embedCanvas!.calls.length).toBeGreaterThan(0);

	return {
		hiddenCalls: hiddenCanvas!.calls.length,
		hiddenStrokeCalls: hiddenCanvas!.calls.filter(([m]) => m === "fill" || m === "stroke").length,
		clears: hiddenCanvas!.calls.filter(([m]) => m === "clearRect").length,
		rectReads: tab.previewView.rectReads,
		computedStyleReads: doc.computedStyleReads,
		layers: embedInkLayerCount(),
	};
}

describe("EmbedFold-7: a pen-up must not redraw the note's ink into a hidden reading view", () => {
	it("small note (5 strokes): the hidden reading view's canvas gets no drawing on pen-up", async () => {
		const r = await scenario(5);
		expect(
			r.hiddenCalls,
			`hidden .markdown-preview-view canvas received ${r.hiddenCalls} ctx calls (${r.clears} clearRect, ` +
				`${r.hiddenStrokeCalls} fill/stroke) for one pen-up; layers=${r.layers}, ` +
				`root rect reads=${r.rectReads}, getComputedStyle reads=${r.computedStyleReads}`
		).toBe(0);
	});

	it("large note (200 strokes): the hidden reading view's canvas gets no drawing on pen-up", async () => {
		const r = await scenario(200);
		expect(
			r.hiddenCalls,
			`hidden .markdown-preview-view canvas received ${r.hiddenCalls} ctx calls (${r.clears} clearRect, ` +
				`${r.hiddenStrokeCalls} fill/stroke) for one pen-up; layers=${r.layers}, ` +
				`root rect reads=${r.rectReads}, getComputedStyle reads=${r.computedStyleReads}`
		).toBe(0);
	});
});
