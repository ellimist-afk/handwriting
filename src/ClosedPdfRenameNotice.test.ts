/**
 * A NOTICE ABOUT A PDF THAT WAS RENAMED AFTER ITS PANE CLOSED NAMES THE FILE BY ITS CURRENT PATH.
 *
 * A save that fails or a conflict copy can be reported after the PDF's pane has closed. The notice names the file through
 * notePathFor, which for a PDF with no pane answers from `pdfPathById`, the path the session resolved the ink id from
 * (main.ts, resolvePdfId). The vault rename handler moves `pdfFiles` and the sidecar's path claim for a renamed PDF but does not
 * touch `pdfPathById`, so after "Lecture.pdf" is renamed to "Lecture 2.pdf" the notice still says "Lecture.pdf", a file that
 * is no longer there.
 *
 * Loads the real onload with a stub vault that keeps the rename handler, then fires the rename as Obsidian does.
 */
import { afterEach, describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import { installFakeWindow } from "../test/routerHarness";

installFakeWindow();

const classSink = { add: () => {}, remove: () => {}, contains: () => false, toggle: () => false };
(globalThis as Record<string, unknown>).document = {
	body: { classList: classSink, querySelector: () => null, querySelectorAll: () => [], appendChild: () => {} },
	documentElement: { classList: classSink },
	head: { appendChild: () => {} },
	createElement: () => ({ classList: classSink, style: {}, appendChild: () => {}, setAttribute: () => {} }),
	addEventListener: () => {},
	removeEventListener: () => {},
	querySelector: () => null,
	querySelectorAll: () => [],
};
(globalThis as Record<string, unknown>).MutationObserver = class {
	observe() {}
	disconnect() {}
	takeRecords() {
		return [];
	}
};
Object.assign(window, {
	setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
	clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
	document: (globalThis as Record<string, unknown>).document,
	matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
});

import HandwritingPlugin from "./main";

const noop = () => {};
const emptyEventRef = {};

async function loadPlugin() {
	const onExtension = noop;
	const note = Object.assign(new TFile(), { path: "open.md", extension: "md" });
	const changedHandlers: ((...args: unknown[]) => unknown)[] = [];
	const renameHandlers: ((...args: unknown[]) => unknown)[] = [];
	const app = {
		loadLocalStorage: () => null,
		saveLocalStorage: noop,
		vault: {
			adapter: {
				exists: async () => false,
				read: async () => "",
				write: async () => {},
				mkdir: async () => {},
				list: async () => ({ files: [], folders: [] }),
				stat: async () => null,
				remove: async () => {},
				rename: async () => {},
			},
			on: (name: string, handler: (...args: unknown[]) => unknown) => {
				if (name === "rename") renameHandlers.push(handler);
				return emptyEventRef;
			},
			getFileByPath: () => null,
			getMarkdownFiles: () => [],
			getFiles: () => [],
			getAbstractFileByPath: (path: string) => (path === note.path ? note : null),
			cachedRead: async () => "",
			readBinary: async () => new TextEncoder().encode("%PDF-1.4 " + "x".repeat(2000)).buffer,
			read: async () => "",
			configDir: ".obsidian",
		},
		workspace: {
			on: () => emptyEventRef,
			onLayoutReady: (fn: () => void) => fn(),
			getLeavesOfType: () => [],
			getActiveFile: () => null,
			getActiveViewOfType: () => null,
			activeLeaf: null,
			iterateAllLeaves: noop,
			trigger: noop,
		},
		metadataCache: {
			on: (name: string, handler: (...args: unknown[]) => unknown) => {
				if (name === "changed") changedHandlers.push(handler);
				return emptyEventRef;
			},
			getFileCache: () => null,
			getCache: () => null,
		},
		keymap: { pushScope: noop, popScope: noop },
		scope: {},
		fileManager: { processFrontMatter: async () => {} },
	};
	const plugin = new (HandwritingPlugin as unknown as new (
		app: unknown,
		manifest: unknown
	) => Record<string, unknown> & { onload(): Promise<void> })(app, {});
	Object.assign(plugin, {
		app,
		manifest: { id: "handwriting", version: "0.0.0-test", dir: ".obsidian/plugins/handwriting" },
		addCommand: (command: unknown) => command,
		registerView: noop,
		addSettingTab: noop,
		addRibbonIcon: () => ({ addClass: noop }),
		registerEvent: (ref: unknown) => ref,
		registerDomEvent: noop,
		registerInterval: noop,
		registerEditorExtension: onExtension,
		registerMarkdownPostProcessor: noop,
		registerObsidianProtocolHandler: noop,
		register: noop,
		loadData: async () => ({}),
		saveData: async () => {},
	});
	await plugin.onload();
	void changedHandlers;
	const rename = async (file: TFile, oldPath: string) => { for (const handler of renameHandlers) await handler(file, oldPath); };
	return { plugin: plugin as unknown as Record<string, unknown> & { notePathFor(id: string): string | null }, rename };
}


const ID = "0123456789abcdef0123456789abcdef-1";
const pdf = (path: string) => Object.assign(new TFile(), { path, extension: "pdf" });

describe("a notice about a renamed PDF", () => {
	it("control: a closed PDF that was not renamed is named by the path it was resolved from", async () => {
		const { plugin } = await loadPlugin();
		plugin.pdfPathById = new Map([[ID, "Lecture.pdf"]]);
		expect(plugin.notePathFor(ID)).toBe("Lecture.pdf");
	});

	it("control: an open PDF renamed is named by its new path", async () => {
		const { plugin, rename } = await loadPlugin();
		const root = {};
		plugin.pdfFiles = new Map([[root, "Lecture.pdf"]]);
		plugin.pdfIds = new Map([[root, ID]]);
		plugin.pdfPathById = new Map([[ID, "Lecture.pdf"]]);
		await rename(pdf("Lecture 2.pdf"), "Lecture.pdf");
		expect(plugin.notePathFor(ID)).toBe("Lecture 2.pdf");
	});

	it("a PDF renamed after its pane closed is named by its new path, not the old one", async () => {
		const { plugin, rename } = await loadPlugin();
		plugin.pdfFiles = new Map();
		plugin.pdfIds = new Map();
		plugin.pdfPathById = new Map([[ID, "Lecture.pdf"]]);
		await rename(pdf("Lecture 2.pdf"), "Lecture.pdf");
		expect(plugin.notePathFor(ID), "the notice would still name the file that is no longer there").toBe("Lecture 2.pdf");
	});
});
