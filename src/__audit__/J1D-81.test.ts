import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(_message: string) {}
	},
}));

import HandwritingPlugin from "../main";
import { TFile, Notice } from "obsidian";
import mainSource from "../main.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "../pdf/PdfInkStore";

const source = mainSource.replace(/\r\n/g, "\n");
const hostStart = "\t\tthis.pdfStore.attachHost({";
const hostAt = source.indexOf(hostStart);
const hostEnd = source.indexOf("\n\t\t});", hostAt);
const installPdfHost = new Function("Notice", "blockNotice", source.slice(hostAt, hostEnd + "\n\t\t});".length));

const renameStart = '\t\t\t\tif (file instanceof TFile && file.extension === "pdf") {\n\t\t\t\t\tfor (const [root, p] of this.pdfFiles) {';
expect(source.split(renameStart)).toHaveLength(2);
const renameAt = source.indexOf(renameStart);
const renameEnd = source.indexOf("\n\t\t\t\t}\n", renameAt);
const pdfRenameBranch = new Function("TFile", "file", "oldPath", source.slice(renameAt, renameEnd + "\n\t\t\t\t}\n".length));

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("J1D-81: a PDF renamed during identification is identified under its new path", async () => {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	adapter.list = async () => ({ files: [], folders: [] });
	const pdfBytes = new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(5000) + "\n%%EOF\n");
	const files = new Set<string>(["Old.pdf"]);
	let releaseRead: () => void = () => {};
	const readGate = new Promise<void>((r) => (releaseRead = r));
	let readStarted: () => void = () => {};
	const readEntered = new Promise<void>((r) => (readStarted = r));
	let firstRead = true;

	const file = Object.assign(new TFile(), { path: "Old.pdf", extension: "pdf", name: "Old.pdf", basename: "Old" });
	const root = { isConnected: true } as unknown as HTMLElement;
	const leaf = { view: { file, containerEl: root } };

	const store = new PageStore({ vault: { adapter } } as never);
	const pdfStore = new PdfInkStore();
	const app = {
		vault: {
			adapter,
			getFiles: () => [...files].map((path) => ({ path, extension: "pdf" })),
			readBinary: async () => {
				if (firstRead) {
					firstRead = false;
					readStarted();
					await readGate;
				}
				return pdfBytes.slice().buffer;
			},
			getFileByPath: (p: string) => (files.has(p) ? { path: p, extension: "pdf" } : null),
		},
		workspace: { getLeavesOfType: (type: string) => (type === "pdf" ? [leaf] : []) },
	};
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, { app, store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map() });
	installPdfHost.call(plugin, Notice, (m: string) => new Notice(m));

	const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, unmount() {}, idle: true };
	plugin.pdfFiles.set(root, "Old.pdf");
	plugin.pdfInk.set(root, controller);
	const resolving = plugin.resolvePdfId(leaf, root, controller);
	await readEntered;

	files.delete("Old.pdf");
	files.add("New.pdf");
	file.path = "New.pdf";
	file.name = "New.pdf";
	file.basename = "New";
	pdfRenameBranch.call(plugin, TFile, file, "Old.pdf");

	releaseRead();
	await resolving;
	plugin.syncPdfControllers();

	await vi.waitFor(
		() => expect(plugin.pdfIds.get(root), "pane left without an id: pen refuses with 'still identifying'").toBeDefined(),
		{ timeout: 1000 }
	);
	expect(plugin.pdfFiles.get(root)).toBe("New.pdf");
});
