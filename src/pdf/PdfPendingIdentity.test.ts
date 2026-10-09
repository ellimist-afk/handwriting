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

/**
 * Two identifications of PDFs that are still waiting on something: two
 * identifications of one file that finish out of order, and a pending choice
 * whose file was renamed while its ink file was still being read.
 *
 * The vault, the plugin session and the lifted vault events below are the
 * ones PdfInstanceClaims.test.ts builds, copied here so this file stands alone.
 */
const source = mainSource.replace(/\r\n/g, "\n");
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

const vaultFile = (path: string) =>
	Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	});

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
	return { store, pdfStore, plugin, open, send, detached, writes: () => writes };
}


it("a pane's identification that finishes after a newer one for the same file does not take the pane's id back", async () => {
	const v = vault();
	v.files.add("Paper.pdf");
	const s = session(v);
	const opened = await s.open("Paper.pdf");
	// Two revisions of Paper.pdf. The first one's head read is held; the second one's is not.
	let reads = 0;
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	s.plugin.app.vault.readBinary = async () => {
		reads++;
		if (reads === 1) {
			const bytes = pdf("y".repeat(6000));
			await gate;
			return bytes.slice().buffer;
		}
		return pdf("w".repeat(7000)).slice().buffer;
	};
	const older = s.plugin.onPdfModified("Paper.pdf");
	await vi.waitFor(() => expect(reads).toBe(1));
	// The file changes again; the second identification runs to the end while the first waits.
	await s.plugin.onPdfModified("Paper.pdf");
	const newer = s.plugin.pdfIds.get(opened.root) as string;
	expect(newer, "precondition: the newer revision was identified").toBeDefined();
	expect(newer, "precondition: the newer revision is not the one the pane opened with").not.toBe(opened.id);
	release();
	await older;
	expect(s.plugin.pdfIds.get(opened.root), "the older identification replaced the current revision's id").toBe(newer);
});

it("a file renamed while its chosen id is still loading, and a byte-identical file then opened at the old name, do not share one id", async () => {
	const v = vault();
	v.files.add("A.pdf");
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
	const firstOpen = s.open("A.pdf");
	await vi.waitFor(() => expect(s.plugin.pdfIds.size).toBe(1));
	const [paneA] = [...s.plugin.pdfIds.keys()] as HTMLElement[];
	const chosen = s.plugin.pdfIds.get(paneA) as string;
	// Obsidian renames the open file in place, then tells the vault listeners.
	const leaf = s.plugin.app.workspace.getLeavesOfType("pdf")[0];
	v.files.delete("A.pdf");
	v.files.add("B.pdf");
	leaf.view.file.path = "B.pdf";
	s.send("rename", vaultFile("B.pdf"), "A.pdf");
	// A byte-identical file takes the old name and opens before the first sidecar read ends.
	v.files.add("A.pdf");
	const second = await s.open("A.pdf");
	expect(second.id, "the new A.pdf was given the id the renamed file chose").not.toBe(chosen);
	release();
	await firstOpen;
});

it("control: two identifications of one file that finish in order leave the pane on the newer id", async () => {
	const v = vault();
	v.files.add("Paper.pdf");
	const s = session(v);
	const opened = await s.open("Paper.pdf");
	v.pdfBytes = pdf("y".repeat(6000));
	await s.plugin.onPdfModified("Paper.pdf");
	const older = s.plugin.pdfIds.get(opened.root) as string;
	v.pdfBytes = pdf("w".repeat(7000));
	await s.plugin.onPdfModified("Paper.pdf");
	const newer = s.plugin.pdfIds.get(opened.root) as string;
	expect(older).not.toBe(opened.id);
	expect(newer).not.toBe(older);
	expect(newer).not.toBe(opened.id);
});

it("control: a byte-identical file opened beside a pending one that was not renamed gets its own id", async () => {
	const v = vault();
	v.files.add("A.pdf");
	v.files.add("A copy.pdf");
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
	const firstOpen = s.open("A.pdf");
	await vi.waitFor(() => expect(s.plugin.pdfIds.size).toBe(1));
	const [paneA] = [...s.plugin.pdfIds.keys()] as HTMLElement[];
	const second = await s.open("A copy.pdf");
	expect(second.id).not.toBe(s.plugin.pdfIds.get(paneA));
	release();
	await firstOpen;
});
