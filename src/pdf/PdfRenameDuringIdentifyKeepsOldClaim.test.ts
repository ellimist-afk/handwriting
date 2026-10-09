// A PDF renamed while its pane is still being identified must not keep its old
// name in the ink file's claim, or a later file with the same bytes at the old
// name opens wearing this file's ink. The harness is the one in
// PdfInstanceClaims.test.ts, with the pane's file kept as one mutable TFile so a
// rename can move it mid-identification, the way Obsidian moves a TFile.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(_message: string) {}
	},
}));

import HandwritingPlugin from "../main";
import { TFile } from "obsidian";
import mainSource from "../main.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { isMarkdownPath } from "../util/MarkdownPath";
import type { InkStroke } from "../ink/Stroke";

const source = mainSource.replace(/\r\n/g, "\n");
const eventsStart =
	'\t\tthis.registerEvent(\n\t\t\tthis.app.vault.on("rename", (file, oldPath) => {\n\t\t\t\tif (file instanceof TFile && file.extension === "md") {\n\t\t\t\t\tinlineInk.handleRename(';
const eventsEnd = "\t\t\tthis.pdfModifyTimers?.clear();\n\t\t});";
expect(source.split(eventsStart)).toHaveLength(2);
const eventsAt = source.indexOf(eventsStart);
const eventsStop = source.indexOf(eventsEnd, eventsAt);
const installVaultEvents = new Function(
	"TFile",
	"inlineInk",
	"embedInkRenamed",
	"surfaceExtents",
	"runDetached",
	"isMarkdownPath",
	source.slice(eventsAt, eventsStop + eventsEnd.length)
);

const vaultFile = (path: string) =>
	Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	});
function moveTo(file: TFile, path: string): void {
	Object.assign(file, vaultFile(path));
}
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

function vault() {
	const adapter = new FakeAdapter() as FakeAdapter & { list(folder: string): Promise<{ files: string[]; folders: string[] }> };
	adapter.list = async (folder: string) => ({
		files: [...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	return { adapter, pdfBytes: pdf("x".repeat(5000)), files: new Set<string>() };
}

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
	const leaves: { view: { file: TFile; containerEl: HTMLElement } }[] = [];
	const events = new Map<string, (...args: unknown[]) => void>();
	const detached: Promise<unknown>[] = [];
	let readGate: Promise<void> | null = null;
	const app = {
		workspace: { getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []) },
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files].map((path) => ({ path, extension: "pdf" })),
			readBinary: async (_f: { path: string }) => {
				if (readGate) await readGate;
				return v.pdfBytes.slice().buffer;
			},
			getFileByPath: (p: string) => (v.files.has(p) ? { path: p, extension: "pdf" } : null),
			on: (name: string, handler: (...args: unknown[]) => void) => {
				events.set(name, handler);
				return { name };
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
	function start(file: TFile) {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, idle: true };
		const leaf = { view: { file, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, file.path);
		plugin.pdfInk.set(root, controller);
		return { root, done: plugin.resolvePdfId(leaf, root, controller) as Promise<void> };
	}
	async function open(path: string) {
		const s = start(vaultFile(path));
		await s.done;
		return { root: s.root, id: plugin.pdfIds.get(s.root) as string };
	}
	function close(root: HTMLElement) {
		(root as unknown as { isConnected: boolean }).isConnected = false;
		leaves.splice(leaves.findIndex((l) => l.view.containerEl === root), 1);
		plugin.pdfInk.delete(root);
		plugin.pdfIds.delete(root);
		plugin.pdfFiles.delete(root);
	}
	return {
		store, pdfStore, plugin, start, open, close, detached,
		send: (name: string, ...args: unknown[]) => events.get(name)?.(...args),
		gateReads(g: Promise<void> | null) { readGate = g; },
	};
}

/** Session 1: Lecture.pdf annotated and saved; its sidecar claims "Lecture.pdf". */
async function annotated() {
	const v = vault();
	v.files.add("Lecture.pdf");
	const s1 = session(v);
	const a = await s1.open("Lecture.pdf");
	s1.pdfStore.replaceAll(a.id, [stroke(10, "annotated")]);
	await s1.store.flush();
	s1.close(a.root);
	return { v, id: a.id };
}

/** Rename Lecture.pdf -> Lecture annotated.pdf as Obsidian does: TFile moved, then "rename". */
function rename(v: ReturnType<typeof vault>, s: ReturnType<typeof session>, file: TFile) {
	v.files.delete("Lecture.pdf");
	v.files.add("Lecture annotated.pdf");
	moveTo(file, "Lecture annotated.pdf");
	s.send("rename", file, "Lecture.pdf");
}

/** Session 3: a same-bytes file appears at the old name again (re-download, re-export). */
async function reuseOldName(v: ReturnType<typeof vault>) {
	v.files.add("Lecture.pdf");
	const s3 = session(v);
	const fresh = await s3.open("Lecture.pdf");
	const renamed = await s3.open("Lecture annotated.pdf");
	return { s3, fresh, renamed };
}

it("renamed while its head is being read, the sidecar stops claiming the old name", async () => {
	const { v, id } = await annotated();
	const s2 = session(v);
	let release!: () => void;
	s2.gateReads(new Promise<void>((r) => (release = r)));
	const file = vaultFile("Lecture.pdf");
	const pane = s2.start(file);
	await new Promise((r) => setTimeout(r, 0));
	rename(v, s2, file);
	release();
	await pane.done;
	await Promise.all(s2.detached);
	await s2.store.flush();
	expect(s2.plugin.pdfIds.get(pane.root)).toBe(id);
	// Before the fix: ["Lecture.pdf", "Lecture annotated.pdf"]
	expect(await s2.store.readPdfPaths(id), "the sidecar still claims the name the file left").toEqual(["Lecture annotated.pdf"]);
	const { s3, fresh } = await reuseOldName(v);
	// Before the fix: the new file shows "annotated"
	expect(s3.pdfStore.strokes(fresh.id).map((s) => s.id), "a new file at the old name opened wearing the renamed file's ink").toEqual([]);
});

it("renamed while its sidecar is loading, the renamed file keeps its ink and the old name is free", async () => {
	const { v, id } = await annotated();
	const s2 = session(v);
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const load = s2.store.load.bind(s2.store);
	vi.spyOn(s2.store, "load").mockImplementation(async (pageId, o) => {
		await gate;
		return load(pageId, o);
	});
	const file = vaultFile("Lecture.pdf");
	const pane = s2.start(file);
	// The id is chosen and set before the sidecar load is awaited.
	await vi.waitFor(() => expect(s2.plugin.pdfIds.get(pane.root)).toBe(id));
	rename(v, s2, file);
	release();
	await pane.done;
	await Promise.all(s2.detached);
	await s2.store.flush();
	// Before the fix: disk still ["Lecture.pdf"]; memory ["Lecture.pdf", "Lecture annotated.pdf"]
	expect(await s2.store.readPdfPaths(id), "the claim did not follow the rename").toEqual(["Lecture annotated.pdf"]);
	const { s3, fresh, renamed } = await reuseOldName(v);
	// Before the fix: the old-name file takes the ink, the renamed file opens blank
	expect(s3.pdfStore.strokes(fresh.id).map((s) => s.id), "a new file at the old name opened wearing the renamed file's ink").toEqual([]);
	expect(s3.pdfStore.strokes(renamed.id).map((s) => s.id), "the renamed file lost its ink").toEqual(["annotated"]);
});

it("a PDF with no ink file, renamed while its head is being read, writes nothing and claims only the new name", async () => {
	const v = vault();
	v.files.add("Lecture.pdf");
	const s = session(v);
	let release!: () => void;
	s.gateReads(new Promise<void>((r) => (release = r)));
	const file = vaultFile("Lecture.pdf");
	const pane = s.start(file);
	await new Promise((r) => setTimeout(r, 0));
	rename(v, s, file);
	release();
	await pane.done;
	await Promise.all(s.detached);
	await s.store.flush();
	const id = s.plugin.pdfIds.get(pane.root) as string;
	expect(id).toBeTruthy();
	expect([...v.adapter.files.keys()], "merely opening a PDF writes no file").toEqual([]);
	expect(s.pdfStore.claimedInstances((x) => x === id)).toEqual([{ id, paths: ["Lecture annotated.pdf"] }]);
});
