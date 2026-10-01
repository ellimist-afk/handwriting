/**
 * A notice about a PDF names the file, also after its pane has closed (audit 201). The pane's id-to-path pair is
 * dropped when the pane unmounts, but a save that fails or a conflict copy that is written can come after that,
 * so the plugin keeps its own id-to-path record for the session. The real resolvePdfId and sweep run over the real
 * stores, as in PdfReopenReload.test.ts, whose harness this copies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(_message: string) {}
	},
}));

import HandwritingPlugin from "./main";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { PdfInkStore } from "./pdf/PdfInkStore";

const PDF = "Lecture.pdf";

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function harness() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	adapter.list = async (folder: string) => {
		const files = [...adapter.files.keys()].filter(
			(p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")
		);
		return { files, folders: [] };
	};
	const store = new PageStore({ vault: { adapter } } as never);
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({
		load: (id) => store.load(id),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	const pdfBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "y".repeat(4000) + "\n%%EOF\n");
	const leaves: { view: { containerEl: HTMLElement; file: { path: string } } }[] = [];
	const app = {
		vault: {
			adapter,
			readBinary: async () => pdfBytes.slice().buffer,
			getFileByPath: (p: string) => (p === PDF ? { path: p } : null),
			getMarkdownFiles: () => [],
		},
		workspace: { getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []) },
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, { app, store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map(), pageIds: { owner: () => null } });

	/** A pane showing the PDF: the controller mount() would have built, then the real resolvePdfId. */
	async function open() {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, unmount() {}, forgetHistory() {}, idle: true };
		leaves.push({ view: { containerEl: root, file: { path: PDF } } });
		plugin.pdfFiles.set(root, PDF);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId({ view: { file: { path: PDF } } }, root, controller);
		return { root, id: plugin.pdfIds.get(root) as string };
	}
	/** The pane closes: its leaf is gone and the next workspace sync runs the real sweep. */
	function close(root: HTMLElement) {
		leaves.splice(leaves.findIndex((l) => l.view.containerEl === root), 1);
		(root as unknown as { isConnected: boolean }).isConnected = false;
		plugin.syncPdfControllers();
	}
	const live = (id: string) => `.handwriting/${id}.json`;
	const inkFiles = () => [...adapter.files.keys()].filter((p) => p.startsWith(".handwriting/"));
	return { adapter, store, pdfStore, plugin, open, close, live, inkFiles };
}

describe("a PDF's notice names the file after its pane closed (audit 201)", () => {
	it("while the pane is open", async () => {
		const h = harness();
		const a = await h.open();
		expect(h.plugin.noteNameFor(a.id)).toBe(PDF);
	});

	it("after the pane closed and the sweep dropped its maps", async () => {
		const h = harness();
		const a = await h.open();
		h.close(a.root);
		expect(h.plugin.pdfIds.size, "the pane's own map is gone").toBe(0);
		expect(h.plugin.noteNameFor(a.id)).toBe(PDF);
	});

	it("an id that was never opened is still the short id", async () => {
		const h = harness();
		expect(h.plugin.noteNameFor("pdf-00000000-abcdef")).toMatch(/^an unnamed page \(/);
	});
});
