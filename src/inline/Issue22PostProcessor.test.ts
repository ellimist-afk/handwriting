/** Actual production postprocessor registration, with an Obsidian host sink. */
import { afterEach, describe, expect, it, vi } from "vitest";
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
type Callback = (el: HTMLElement, ctx: { sourcePath: string; containerEl: HTMLElement; addChild(child: Child): void }) => void;
async function registered() {
	const callbacks: Callback[] = [];
	const plugin = new (HandwritingPlugin as unknown as new (a: unknown, m: unknown) => Record<string, unknown> & { onload(): Promise<void> })(app(), {});
	Object.assign(plugin, { app: app(), manifest: { id: "handwriting", version: "1.4.21", dir: ".obsidian/plugins/handwriting" },
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

/** Same ancestry and detached-section fallback shape as Obsidian's table postProcess. */
function liveBlock() {
	const editor = { classList: { contains: (name: string) => name === "cm-editor" }, parentElement: null };
	const block = {
		isConnected: true, ownerDocument: { defaultView: window }, classList: classes,
		parentElement: editor,
		style: { position: "", removeProperty: noop }, querySelector: () => null,
		getAttribute: () => null, setAttribute: noop, removeAttribute: noop,
		closest(sel: string): unknown {
			if (sel === ".markdown-rendered") return block;
			if (sel === ".cm-editor" || sel === ".markdown-source-view") return editor;
			return null;
		},
	};
	const section = { ownerDocument: { defaultView: window, body: doc.body },
		isConnected: false, parentElement: null, classList: classes, closest: () => null };
	return { block: block as unknown as HTMLElement, section: section as unknown as HTMLElement };
}

afterEach(() => { teardownEmbedInk(); vi.restoreAllMocks(); });

function attachedRoot(kind: "markdown-embed-content" | "markdown-preview-view" | "markdown-rendered", inEditor: boolean) {
	const editor = { classList: { contains: (name: string) => name === "cm-editor" }, parentElement: null };
	const root = {
		isConnected: true, parentElement: inEditor ? editor : null,
		ownerDocument: { defaultView: window },
		classList: { contains: (name: string) => name === kind },
		style: { position: "", removeProperty: noop },
		querySelector: () => null, getAttribute: () => null, setAttribute: noop, removeAttribute: noop,
		closest(sel: string): unknown { return sel === `.${kind}` ? root : null; },
	};
	const section = { isConnected: true, parentElement: root, classList: classes,
		ownerDocument: { defaultView: window, body: doc.body },
		closest(sel: string): unknown { return sel === `.${kind}` ? root : null; } };
	return { root: root as unknown as HTMLElement, section: section as unknown as HTMLElement };
}

describe("Issue 22 production Markdown postprocessor", () => {
	it("never registers an own-note Live Preview table block as static ink", async () => {
		const callback = await registered();
		const { block, section } = liveBlock();
		const children: Child[] = [];
		vi.spyOn(inlineInk, "isLoaded").mockReturnValue(true);
		vi.spyOn(inlineInk, "strokes").mockReturnValue([]);
		callback(section, { sourcePath: "issue22-note.md", containerEl: block,
			addChild(child) { children.push(child); child.onload?.(); } });
		expect(children).toHaveLength(0);
		expect(embedInkLayerCount()).toBe(0);
	});

	it("rejects an attached own-note callout before addChild", async () => {
		const callback = await registered();
		const { root, section } = attachedRoot("markdown-rendered", true);
		let children = 0;
		callback(section, { sourcePath: "issue22-note.md", containerEl: root,
			addChild() { children++; } });
		expect(children).toBe(0);
		expect(embedInkLayerCount()).toBe(0);
	});

	it("keeps a Reading view and a same-path explicit embed inside Live Preview", async () => {
		const callback = await registered();
		vi.spyOn(inlineInk, "isLoaded").mockReturnValue(true);
		vi.spyOn(inlineInk, "strokes").mockReturnValue([]);
		let children = 0;
		for (const [kind, nested] of [["markdown-preview-view", false],
			["markdown-embed-content", true]] as const) {
			const { root, section } = attachedRoot(kind, nested);
			callback(section, { sourcePath: "issue22-note.md", containerEl: root,
				addChild(child) { children++; child.onload?.(); } });
		}
		expect(children).toBe(2);
		expect(embedInkLayerCount()).toBe(2);
	});
});
