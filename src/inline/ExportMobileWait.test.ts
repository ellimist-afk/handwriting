/**
 * A phone or tablet Export to PDF waits for an embedded note's ink, and never longer than its cap.
 *
 * The mobile export renders the note into `body > div.print`, awaits print() (which awaits the post-processors' returns),
 * then zooms and clones after 200 ms. An embedded note whose ink is not loaded yet gets its ink on a later tick, after the
 * picture was taken. So, on the mobile app and only for an element inside `body > div.print`, the production
 * post-processor returns a wait that settles once the ink is attached, never rejects, and gives up at a named 5 s cap.
 * Desktop, and any element outside the print container, returns nothing, as before.
 *
 * Harness: Issue22PostProcessor.test.ts's (the real plugin's onload with an Obsidian host sink); the element tree is
 * fake nodes whose closest() and matches() handle tag.class lists, [attr], and the child and descendant combinators.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { installFakeWindow } from "../../test/routerHarness";
import HandwritingPlugin from "../main";
import { inlineInk } from "./InkOverlay";
import { embedInkLayerCount, teardownEmbedInk } from "./EmbedInk";

installFakeWindow();
const noop = () => {};
const classes = { add: noop, remove: noop, contains: () => false, toggle: () => false };
const doc = { body: { classList: classes, querySelector: () => null, querySelectorAll: () => [], appendChild: noop },
	documentElement: { classList: classes }, head: { appendChild: noop },
	createElement: () => ({ classList: classes, style: {}, appendChild: noop, setAttribute: noop }),
	addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [] };
Object.assign(globalThis, { document: doc, MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } } });
Object.assign(window, { document: doc, setInterval, clearInterval,
	matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
	getComputedStyle: () => ({ getPropertyValue: () => "" }) });

function app() {
	const adapter = { exists: async () => false, read: async () => "", write: async () => {},
		mkdir: async () => {}, list: async () => ({ files: [], folders: [] }), stat: async () => null,
		remove: async () => {}, rename: async () => {} };
	return { loadLocalStorage: () => null, saveLocalStorage: noop,
		vault: { adapter, on: () => ({}), getFileByPath: () => null,
			getMarkdownFiles: () => [], getFiles: () => [], getAbstractFileByPath: () => null,
			cachedRead: async () => "", configDir: ".obsidian" },
		workspace: { on: () => ({}), onLayoutReady: (fn: () => void) => fn(),
			getLeavesOfType: () => [], getActiveFile: () => null, getActiveViewOfType: () => null,
			activeLeaf: null, iterateAllLeaves: noop, trigger: noop },
		metadataCache: { on: () => ({}), getFileCache: () => null, getCache: () => null },
		keymap: { pushScope: noop, popScope: noop }, scope: {},
		fileManager: { processFrontMatter: async () => {} } };
}

type Child = { onload?(): void; onunload?(): void };
type Ctx = { sourcePath: string; containerEl: HTMLElement; addChild(child: Child): void; getSectionInfo(el: HTMLElement): null };
type Callback = (el: HTMLElement, ctx: Ctx) => unknown;
async function registered() {
	const callbacks: Callback[] = [];
	const plugin = new (HandwritingPlugin as unknown as new (a: unknown, m: unknown) => Record<string, unknown> & { onload(): Promise<void> })(app(), {});
	Object.assign(plugin, { app: app(), manifest: { id: "handwriting", version: "1.5.2", dir: ".obsidian/plugins/handwriting" },
		addCommand: noop, registerView: noop, addSettingTab: noop,
		addRibbonIcon: () => ({ addClass: noop }), registerEvent: noop, registerDomEvent: noop,
		registerInterval: noop, registerEditorExtension: noop,
		registerMarkdownPostProcessor: (cb: Callback) => callbacks.push(cb),
		registerObsidianProtocolHandler: noop, register: noop, showWhatsNewIfDue: noop,
		loadData: async () => ({}), saveData: async () => {} });
	await plugin.onload();
	expect(callbacks).toHaveLength(1);
	return callbacks[0]!;
}

interface FakeEl {
	tagName: string; cls: string[]; attrs: Record<string, string>; parentElement: FakeEl | null; ownerDocument: { defaultView: Window; body?: FakeEl };
	isConnected: boolean; classList: { add(k: string): void; remove(k: string): void; contains(k: string): boolean; toggle(): boolean };
	style: { position: string; removeProperty(): void; setProperty(): void };
	closest(sel: string): FakeEl | null; matches(sel: string): boolean; contains(o: unknown): boolean;
	querySelector(): null; querySelectorAll(): never[]; getAttribute(n: string): string | null; setAttribute(n: string, v: string): void;
	removeAttribute(n: string): void; appendChild(): void;
}

function matchCompound(el: FakeEl, c: string): boolean {
	const m = /^([a-z][a-z0-9-]*|\*)?((?:\.[\w-]+)*)((?:\[[\w-]+\])*)$/i.exec(c);
	if (!m || c === "") return false;
	if (m[1] && m[1] !== "*" && m[1].toLowerCase() !== el.tagName.toLowerCase()) return false;
	const want = (m[2] ?? "").split(".").filter(Boolean);
	const attrs = [...(m[3] ?? "").matchAll(/\[([\w-]+)\]/g)].map(a => a[1]!);
	return want.every(k => el.cls.includes(k)) && attrs.every(a => a in el.attrs);
}
function matchComplex(el: FakeEl, sel: string): boolean {
	const toks = sel.trim().replace(/\s*>\s*/g, " > ").split(/\s+/);
	const walk = (node: FakeEl | null, i: number): boolean => {
		if (!node || !matchCompound(node, toks[i]!)) return false;
		if (i === 0) return true;
		if (toks[i - 1] === ">") return walk(node.parentElement, i - 2);
		for (let a = node.parentElement; a; a = a.parentElement) if (walk(a, i - 1)) return true;
		return false;
	};
	return walk(el, toks.length - 1);
}
const matches = (el: FakeEl, sel: string) => sel.split(",").some(s => matchComplex(el, s));

function el(tag: string, cls: string, parent: FakeEl | null, ownerDocument: FakeEl["ownerDocument"]): FakeEl {
	const node: FakeEl = {
		tagName: tag.toUpperCase(), cls: cls.split(" ").filter(Boolean), attrs: {}, parentElement: parent, ownerDocument, isConnected: true,
		classList: { add: k => { if (!node.cls.includes(k)) node.cls.push(k); }, remove: k => { node.cls = node.cls.filter(x => x !== k); },
			contains: k => node.cls.includes(k), toggle: () => false },
		style: { position: "", removeProperty: noop, setProperty: noop },
		closest(sel) { for (let n: FakeEl | null = node; n; n = n.parentElement) if (matches(n, sel)) return n; return null; },
		matches(sel) { return matches(node, sel); },
		contains(o) { for (let n = o as FakeEl | null; n; n = n.parentElement) if (n === node) return true; return false; },
		querySelector: () => null, querySelectorAll: () => [],
		getAttribute: n => node.attrs[n] ?? null, setAttribute: (n, v) => { node.attrs[n] = v; }, removeAttribute: n => { delete node.attrs[n]; },
		appendChild: noop,
	};
	return node;
}

/** body(.is-mobile) > div.print (or a workspace leaf) > root > embed > .markdown-embed-content > section. */
function tree(inPrint: boolean) {
	const ownerDocument: FakeEl["ownerDocument"] = { defaultView: window };
	const body = el("body", "is-mobile is-tablet theme-dark", null, ownerDocument);
	ownerDocument.body = body;
	const host = el("div", inPrint ? "print theme-light" : "workspace-leaf-content", body, ownerDocument);
	const root = el("div", "markdown-preview-view markdown-rendered", host, ownerDocument);
	const embed = el("div", "markdown-embed internal-embed inline-embed is-loaded", root, ownerDocument);
	embed.attrs.src = "Inner note";
	const content = el("div", "markdown-embed-content", embed, ownerDocument);
	const section = el("div", "", content, ownerDocument);
	return { section: section as unknown as HTMLElement, content: content as unknown as HTMLElement };
}

function run(callback: Callback, t: ReturnType<typeof tree>): unknown {
	return callback(t.section, { sourcePath: "Inner note.md", containerEl: t.content,
		addChild(child) { child.onload?.(); }, getSectionInfo: () => null });
}
const isThenable = (v: unknown) => v !== null && v !== undefined && typeof (v as { then?: unknown }).then === "function";
function track(v: unknown) {
	const s = { settled: false, rejected: false, value: "unset" as unknown };
	Promise.resolve(v).then(x => { s.settled = true; s.value = x; }, () => { s.settled = true; s.rejected = true; });
	return s;
}
function mobile(on: boolean) {
	Platform.isMobileApp = on;
	Platform.isMobile = on;
}
function notLoaded(load: () => Promise<boolean>) {
	vi.spyOn(inlineInk, "isLoaded").mockReturnValue(false);
	vi.spyOn(inlineInk, "strokes").mockReturnValue([]);
	vi.spyOn(inlineInk, "ensureLoaded").mockImplementation(load);
}

afterEach(() => { teardownEmbedInk(); vi.restoreAllMocks(); vi.useRealTimers(); mobile(false); });

describe("mobile Export to PDF waits for an embedded note's ink", () => {
	it("C2: ink loads after 300 ms: the post-processor returns a wait that settles once the layer is attached", async () => {
		const callback = await registered();
		vi.useFakeTimers();
		mobile(true);
		notLoaded(() => new Promise(r => setTimeout(() => r(true), 300)));
		const ret = run(callback, tree(true));
		expect(isThenable(ret), "the post-processor returns a wait for print() to await").toBe(true);
		const s = track(ret);
		await vi.advanceTimersByTimeAsync(299);
		const before = { settled: s.settled, layers: embedInkLayerCount() };
		await vi.advanceTimersByTimeAsync(1);
		const after = { settled: s.settled, rejected: s.rejected, layers: embedInkLayerCount() };
		console.log("EXPORT-MOBILE-WAIT C2", JSON.stringify({ before, after }));
		expect(before, "at 299 ms").toEqual({ settled: false, layers: 0 });
		expect(after, "at 300 ms").toEqual({ settled: true, rejected: false, layers: 1 });
	});

	it("C3a: the ink load rejects: the wait settles with nothing, no layer, no rejection for print() to fail on", async () => {
		const callback = await registered();
		vi.useFakeTimers();
		mobile(true);
		notLoaded(() => Promise.reject(new Error("PLANTED-LOAD-REJECT")));
		const ret = run(callback, tree(true));
		expect(isThenable(ret), "the post-processor returns a wait").toBe(true);
		const s = track(ret);
		await vi.advanceTimersByTimeAsync(0);
		console.log("EXPORT-MOBILE-WAIT C3a", JSON.stringify(s));
		expect({ settled: s.settled, rejected: s.rejected, value: s.value, layers: embedInkLayerCount() }).toEqual({ settled: true, rejected: false, value: undefined, layers: 0 });
	});

	it("C3b: the ink load never settles: the wait is pending at 4999 ms and settles at the 5 s cap", async () => {
		const callback = await registered();
		vi.useFakeTimers();
		mobile(true);
		notLoaded(() => new Promise<boolean>(() => {}));
		const ret = run(callback, tree(true));
		expect(isThenable(ret), "the post-processor returns a wait").toBe(true);
		const s = track(ret);
		await vi.advanceTimersByTimeAsync(4999);
		const before = s.settled;
		await vi.advanceTimersByTimeAsync(1);
		console.log("EXPORT-MOBILE-WAIT C3b", JSON.stringify({ before, after: s }));
		expect({ at4999: before, at5000: s.settled, rejected: s.rejected }).toEqual({ at4999: false, at5000: true, rejected: false });
	});

	it("desktop: the same render returns nothing, as before", async () => {
		const callback = await registered();
		mobile(false);
		notLoaded(() => new Promise(r => setTimeout(() => r(true), 300)));
		expect(run(callback, tree(true))).toBeUndefined();
	});

	it("mobile, an element outside body > div.print: returns nothing", async () => {
		const callback = await registered();
		mobile(true);
		notLoaded(() => new Promise(r => setTimeout(() => r(true), 300)));
		expect(run(callback, tree(false))).toBeUndefined();
	});
});
