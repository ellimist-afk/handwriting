import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(_message: string) {}
	},
}));

import HandwritingPlugin from "../main";
import { Notice, TFile } from "obsidian";
import { transformSync } from "esbuild";
import mainSource from "../main.ts?raw";
import commandsSource from "../commands/RegisterCommands.ts?raw";
import exportCommandsSource from "../commands/RegisterExportCommands.ts?raw";
import onloadSource from "../PluginOnload.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import type { InkStroke } from "../ink/Stroke";
import { createFreshFile } from "../export/CreateFreshFile";
import { inkToPdf } from "../ink/InkPdf";
import { bytesOf } from "./PdfSyntax";
import { isMarkdownPath, stripMarkdownExtension } from "../util/MarkdownPath";
import { document } from "../../test/pdf-fixture";

/**
 * The vault's rename and modify handlers, lifted from onload as written, so
 * a cell reaches the plugin through the events Obsidian sends.
 */
// The command registrations live in commands/RegisterCommands.ts and RegisterExportCommands.ts, read here with main.ts.
// The onload phases live in PluginOnload.ts, read here too.
const source = [mainSource, commandsSource, exportCommandsSource, onloadSource].join("\n").replace(/\r\n/g, "\n");
const eventsStart =
	'\t\tthis.registerEvent(\n\t\t\tthis.app.vault.on("rename", (file, oldPath) => {\n\t\t\t\tif (file instanceof TFile && file.extension === "md") {\n\t\t\t\t\tinlineInk.handleRename(';
const eventsEnd = "\t\t\tthis.pdfModifyTimers?.clear();\n\t\t});";
expect(source.split(eventsStart)).toHaveLength(2);
const eventsAt = source.indexOf(eventsStart);
const eventsStop = source.indexOf(eventsEnd, eventsAt);
expect(eventsStop).toBeGreaterThan(eventsAt);
const installVaultEvents = new Function(
	"TFile",
	"inlineInk",
	"embedInkRenamed",
	"surfaceExtents",
	"runDetached",
	"isMarkdownPath",
	source.slice(eventsAt, eventsStop + eventsEnd.length)
);

/** The "Export ink as PDF" command, lifted from onload as written. */
const exportStart = '\t\tthis.addCommand({\n\t\t\tid: "export-ink-pdf",';
expect(source.split(exportStart)).toHaveLength(2);
const exportAt = source.indexOf(exportStart);
const exportStop = source.indexOf("\n\t\t});", exportAt);
expect(exportStop).toBeGreaterThan(exportAt);
const registerExportPdf = new Function(
	"inlineInk",
	"inkToPdf",
	"bytesOf",
	"stripMarkdownExtension",
	"createFreshFile",
	"runDetached",
	"Notice",
	transformSync(source.slice(exportAt, exportStop + "\n\t\t});".length), { loader: "ts", target: "es2022" }).code
);

const vaultFile = (path: string) =>
	Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	});

function stroke(x: number, id: string): InkStroke {
	return {
		id, page: 1, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [{ x, y: 10, pressure: 0.5, t: 0 }, { x: x + 10, y: 20, pressure: 0.5, t: 8 }],
		bbox: { x, y: 10, width: 10, height: 10 },
	};
}
const pdf = (fill: string) =>
	new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + fill + "\n%%EOF\n");

beforeEach(() => vi.stubGlobal("window", globalThis));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** One vault (disk + PDF list); every PDF holds `pdfBytes`. */
function vault() {
	const adapter = new FakeAdapter() as FakeAdapter & { list(folder: string): Promise<{ files: string[]; folders: string[] }> };
	adapter.list = async (folder: string) => ({
		files: [...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	return { adapter, pdfBytes: pdf("x".repeat(5000)), files: new Set<string>() };
}

/** A plugin session (fresh memory) over the shared vault, wired as main.ts wires the PDF host. */
function session(v: ReturnType<typeof vault>) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({
		load: (id, options) => store.load(id, options),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	const leaves: { view: { file: { path: string }; containerEl: HTMLElement } }[] = [];
	const events = new Map<string, (...args: unknown[]) => void>();
	const detached: Promise<unknown>[] = [];
	let writes = 0;
	const app = {
		workspace: {
			getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []),
			getActiveFile: () => vaultFile("Notes.md"),
		},
		metadataCache: { getFirstLinkpathDest: () => null },
		fileManager: { generateMarkdownLink: (file: { path: string }) => `[[${file.path}]]` },
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files].map((path) => ({ path, extension: "pdf" })),
			readBinary: async (_f: { path: string }) => v.pdfBytes.slice().buffer,
			getFileByPath: (p: string) => (v.files.has(p) ? { path: p, extension: "pdf" } : null),
			on: (name: string, handler: (...args: unknown[]) => void) => {
				events.set(name, handler);
				return { name };
			},
			// What Obsidian does with a new file: write it, then send "create".
			createBinary: async (path: string, _data: ArrayBuffer) => {
				if (await v.adapter.exists(path)) throw new Error(`${path} already exists`);
				writes++;
				v.adapter.files.set(path, "");
				if (path.endsWith(".pdf")) v.files.add(path);
				const file = vaultFile(path);
				events.get("create")?.(file);
				return file;
			},
			// And with new bytes for a file that exists: write them, then send "modify".
			modifyBinary: async (file: { path: string }, data: ArrayBuffer) => {
				writes++;
				v.pdfBytes = new Uint8Array(data);
				events.get("modify")?.(file);
			},
		},
	};
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app, store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map(),
		settings: { inkPdfColorMode: "darken" },
		registerEvent: () => {},
		register: () => {},
	});
	installVaultEvents.call(plugin, TFile, {}, () => {}, {}, (work: Promise<unknown>) => detached.push(work), isMarkdownPath);
	/** Obsidian sends a vault event; a name nothing listens for goes nowhere. */
	function send(name: string, ...args: unknown[]) {
		events.get(name)?.(...args);
	}
	async function open(path: string) {
		expect(v.files.has(path), `precondition: ${path} exists`).toBe(true);
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, idle: true };
		const leaf = { view: { file: { path }, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId(leaf, root, controller);
		return { root, id: plugin.pdfIds.get(root) as string };
	}
	function close(root: HTMLElement) {
		(root as unknown as { isConnected: boolean }).isConnected = false;
		leaves.splice(leaves.findIndex((l) => l.view.containerEl === root), 1);
		plugin.pdfInk.delete(root);
		plugin.pdfIds.delete(root);
		plugin.pdfFiles.delete(root);
	}
	function draw(id: string, s: InkStroke) {
		pdfStore.replaceAll(id, [...pdfStore.strokes(id), s]);
	}
	return { store, pdfStore, plugin, open, close, draw, send, detached, writes: () => writes };
}

it("two byte-identical PDFs identified concurrently get different instances", async () => {
	const v = vault();
	v.files.add("Template.pdf");
	v.files.add("Template 1.pdf");
	const s = session(v);
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const load = s.store.load.bind(s.store);
	let first = true;
	vi.spyOn(s.store, "load").mockImplementation(async (id, o) => {
		if (first) {
			first = false;
			await gate;
		}
		return load(id, o);
	});
	const pa = s.open("Template.pdf");
	await vi.waitFor(() => expect(s.plugin.pdfIds.size).toBe(1));
	const pb = s.open("Template 1.pdf");
	await new Promise((r) => setTimeout(r, 20));
	release();
	const [a, b] = await Promise.all([pa, pb]);
	s.draw(b.id, stroke(50, "copy-ink"));
	await s.store.flush();
	expect(s.pdfStore.strokes(a.id).map((x) => x.id), "the original shows ink drawn on the copy").toEqual([]);
	expect(a.id).not.toBe(b.id);
});

it("a choice dropped because its pane changed document during the load is not left reserved", async () => {
	const v = vault();
	v.files.add("Template.pdf");
	v.files.add("Template 1.pdf");
	const s = session(v);
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const load = s.store.load.bind(s.store);
	let first = true;
	vi.spyOn(s.store, "load").mockImplementation(async (id, o) => {
		if (first) {
			first = false;
			await gate;
		}
		return load(id, o);
	});
	const pa = s.open("Template.pdf");
	await vi.waitFor(() => expect(s.plugin.pdfIds.size).toBe(1));
	const [paneA] = [...s.plugin.pdfIds.keys()];
	const chosen = s.plugin.pdfIds.get(paneA);
	// The pane moves to another document while the sidecar loads, so this
	// resolution stops at the guard after the load and claims nothing.
	s.plugin.pdfFiles.set(paneA, "Elsewhere.pdf");
	release();
	await pa;
	expect(s.plugin.pdfResolving?.size ?? 0, "a reservation outlived its resolution").toBe(0);
	const b = await s.open("Template 1.pdf");
	expect(b.id, "the dropped choice is free for the next file").toBe(chosen);
});

it("a PDF renamed while no pane shows it takes its claim along: a new file at the old name opens blank", async () => {
	const v = vault();
	v.files.add("Lecture.pdf");
	const s1 = session(v);
	const a = await s1.open("Lecture.pdf");
	s1.draw(a.id, stroke(10, "annotated"));
	await s1.store.flush();
	s1.close(a.root);
	v.files.delete("Lecture.pdf");
	v.files.add("Lecture annotated.pdf");
	// Obsidian's rename event, for a PDF no pane shows.
	s1.send("rename", vaultFile("Lecture annotated.pdf"), "Lecture.pdf");
	await Promise.all(s1.detached);
	await s1.store.flush();
	v.files.add("Lecture.pdf");
	const s2 = session(v);
	const fresh = await s2.open("Lecture.pdf");
	expect(s2.pdfStore.strokes(fresh.id).map((s) => s.id), "new file at the old name opened wearing the renamed file's ink").toEqual([]);
	const renamed = await s2.open("Lecture annotated.pdf");
	expect(s2.pdfStore.strokes(renamed.id).map((s) => s.id), "the renamed file lost its ink").toEqual(["annotated"]);
	expect(fresh.id, "both files now write one sidecar").not.toBe(renamed.id);
});

it("ink drawn on a PDF after its bytes were replaced is still there when the file reopens", async () => {
	const v = vault();
	v.files.add("Paper.pdf");
	const s1 = session(v);
	const opened = await s1.open("Paper.pdf");
	v.pdfBytes = pdf("y".repeat(6000));
	await s1.plugin.onPdfModified?.("Paper.pdf");
	s1.draw(s1.plugin.pdfIds.get(opened.root), stroke(30, "on-new-revision"));
	await s1.store.flush();
	s1.close(opened.root);
	const s2 = session(v);
	const again = await s2.open("Paper.pdf");
	expect(s2.pdfStore.strokes(again.id).map((s) => s.id), "ink drawn on the current revision vanished on reopen").toEqual(["on-new-revision"]);
});

it("a PDF changed under a pane mid-stroke is identified again only once the stroke ends", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const v = vault();
		v.files.add("Paper.pdf");
		const s = session(v);
		const opened = await s.open("Paper.pdf");
		const controller = s.plugin.pdfInk.get(opened.root);
		controller.idle = false;
		v.pdfBytes = pdf("y".repeat(6000));
		// Obsidian's modify event, then the settle.
		s.send("modify", vaultFile("Paper.pdf"));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(s.plugin.pdfIds.get(opened.root), "the document changed under a live stroke").toBe(opened.id);
		controller.idle = true;
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(s.plugin.pdfIds.get(opened.root)).toBeDefined());
		expect(s.plugin.pdfIds.get(opened.root), "never identified again after the stroke ended").not.toBe(opened.id);
	} finally {
		vi.useRealTimers();
	}
});

/** Two panes on Paper.pdf; the second is mid-stroke. Counts how often each pane's undo is forgotten. */
async function twoPanes() {
	const v = vault();
	v.files.add("Paper.pdf");
	const s = session(v);
	const idle = await s.open("Paper.pdf");
	const drawing = await s.open("Paper.pdf");
	const forgot = { idle: 0, drawing: 0 };
	s.plugin.pdfInk.get(idle.root).forgetHistory = () => forgot.idle++;
	s.plugin.pdfInk.get(drawing.root).forgetHistory = () => forgot.drawing++;
	s.plugin.pdfInk.get(drawing.root).idle = false;
	return { v, s, idle, drawing, forgot };
}

it("two panes on a PDF that changes while one draws: the idle pane is identified again once, not again when the stroke ends", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const { v, s, idle, drawing, forgot } = await twoPanes();
		v.pdfBytes = pdf("y".repeat(6000));
		s.send("modify", vaultFile("Paper.pdf"));
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(s.plugin.pdfIds.get(idle.root)).toBeDefined());
		expect(s.plugin.pdfIds.get(idle.root), "precondition: the idle pane was identified again").not.toBe(idle.id);
		expect(s.plugin.pdfIds.get(drawing.root), "the document changed under a live stroke").toBe(drawing.id);
		s.plugin.pdfInk.get(drawing.root).idle = true;
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(s.plugin.pdfIds.get(drawing.root)).toBeDefined());
		expect(s.plugin.pdfIds.get(drawing.root), "the pane that was drawing was never identified again").not.toBe(drawing.id);
		expect(forgot.drawing, "the pane that was drawing lost its undo other than once").toBe(1);
		expect(forgot.idle, "the idle pane was identified again when the other pane's stroke ended, and lost the undo of what it drew in the wait").toBe(1);
	} finally {
		vi.useRealTimers();
	}
});

it("a second change while a stroke holds one pane back identifies every pane on the PDF again", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const { v, s, idle, drawing, forgot } = await twoPanes();
		v.pdfBytes = pdf("y".repeat(6000));
		s.send("modify", vaultFile("Paper.pdf"));
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(s.plugin.pdfIds.get(idle.root)).toBeDefined());
		const first = s.plugin.pdfIds.get(idle.root);
		expect(first, "precondition: the idle pane was identified again").not.toBe(idle.id);
		// The file changes again before the stroke ends.
		v.pdfBytes = pdf("w".repeat(7000));
		s.send("modify", vaultFile("Paper.pdf"));
		s.plugin.pdfInk.get(drawing.root).idle = true;
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => {
			expect(s.plugin.pdfIds.get(idle.root)).toBeDefined();
			expect(s.plugin.pdfIds.get(drawing.root)).toBeDefined();
		});
		expect(s.plugin.pdfIds.get(idle.root), "the second change never reached the idle pane").not.toBe(first);
		expect(forgot.idle, "the idle pane was not identified once per change").toBe(2);
		expect(s.plugin.pdfIds.get(drawing.root), "the pane that was drawing was never identified again").not.toBe(drawing.id);
	} finally {
		vi.useRealTimers();
	}
});

it("a change to some other PDF, such as a flattened copy being written, leaves the pane alone", async () => {
	const v = vault();
	v.files.add("Paper.pdf");
	const s = session(v);
	const opened = await s.open("Paper.pdf");
	v.files.add("Paper.flattened.pdf");
	await s.plugin.onPdfModified("Paper.flattened.pdf");
	expect(s.plugin.pdfIds.get(opened.root)).toBe(opened.id);
});

it("the plugin's own writes - flatten, snip, export - leave an open pane's document, ink and undo alone past the settle", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const v = vault();
		v.pdfBytes = Uint8Array.from(document(1), (c) => c.charCodeAt(0) & 0xff);
		v.files.add("Paper.pdf");
		const s = session(v);
		const opened = await s.open("Paper.pdf");
		const controller = s.plugin.pdfInk.get(opened.root);
		let forgot = 0;
		controller.forgetHistory = () => forgot++;
		controller.snipSelection = async () => ({ ok: true, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), pageNumber: 1 });
		s.draw(opened.id, stroke(100, "kept"));
		// Each write through its own code: flatten and snip on the open PDF,
		// and the ink export from a note, which writes a PDF beside it.
		await s.plugin.flattenPdf(vaultFile("Paper.pdf"), opened.id);
		await s.plugin.snipPdf(vaultFile("Paper.pdf"), controller);
		let exportPdf: { checkCallback(checking: boolean): boolean } | undefined;
		registerExportPdf.call(
			Object.assign(Object.create(s.plugin), { addCommand: (spec: typeof exportPdf) => (exportPdf = spec) }),
			{ strokes: () => [stroke(10, "note-ink")] },
			inkToPdf,
			bytesOf,
			stripMarkdownExtension,
			createFreshFile,
			(work: Promise<unknown>) => s.detached.push(work),
			Notice
		);
		exportPdf!.checkCallback(false);
		await Promise.all(s.detached);
		expect(s.writes(), "precondition: flatten, snip and export each wrote one file").toBe(3);
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.waitFor(() => expect(s.plugin.pdfIds.get(opened.root)).toBeDefined());
		expect(s.plugin.pdfIds.get(opened.root), "the plugin's own write gave the pane a new document").toBe(opened.id);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id), "the pane's ink is gone").toEqual(["kept"]);
		expect(forgot, "the pane's undo was forgotten").toBe(0);
	} finally {
		vi.useRealTimers();
	}
});

it("the plugin writes PDFs only as new files, so its own writes never reach the modify handler", () => {
	const all = import.meta.glob("/src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
	const sources = Object.fromEntries(Object.entries(all).filter(([file]) => !file.endsWith(".test.ts")));
	expect(Object.keys(sources).length, "the source scan found the source").toBeGreaterThan(50);
	for (const [file, text] of Object.entries(sources)) {
		expect(text, `${file} modifies a file's bytes in place`).not.toMatch(/\b(modifyBinary|writeBinary)\s*\(|\bvault\.modify\s*\(/);
	}
	const snips = sources["/src/export/Snips.ts"]!.replace(/\r\n/g, "\n");
	const start = snips.indexOf("async function flattenPdf(");
	const end = snips.indexOf("\n\t}\n", start);
	expect(start > 0 && end > start, "flattenPdf found whole").toBe(true);
	const flatten = snips.slice(start, end);
	expect(flatten, "flatten writes a fresh file").toMatch(/createFreshFile\(/);
	expect(flatten).toMatch(/createBinary\(/);
});
