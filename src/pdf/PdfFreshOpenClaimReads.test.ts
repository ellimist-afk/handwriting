/**
 * Opening a PDF that has no ink looks for an older version's ink file that still claims its path (the carry of a PDF
 * changed while no pane showed it). That look reads the claims of every other PDF ink file. These cells pin its cost:
 * within a session, an ink file read once is not read again until it changes on disk, and the carry itself still
 * happens. Production identity, PDF store and PageStore run on synthetic storage.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import type { InkStroke } from "../ink/Stroke";

const shown = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class Notice {
		constructor(message: string) {
			shown.push(message);
		}
	}
	return { ...actual, Notice };
});

const CARRIED_NOTICE = "Handwriting: this PDF changed on disk. Your ink was carried over to its new version.";

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
	shown.length = 0;
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function stroke(id: string): InkStroke {
	return {
		id, page: 1, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [{ x: 10, y: 10, pressure: 0.5, t: 0 }, { x: 20, y: 20, pressure: 0.5, t: 8 }],
		bbox: { x: 10, y: 10, width: 10, height: 10 },
	};
}

/** A PDF whose first 64 KiB differ by `seed`, so each one is its own content family. */
function pdf(seed: number): Uint8Array {
	const bytes = new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(70000) + "\n%%EOF\n");
	bytes[100] = 65 + seed;
	return bytes;
}

function vault() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	adapter.list = async (folder) => ({
		files: [...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	return { adapter, pdfs: new Map<string, Uint8Array>() };
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
	const leaves: { view: { file: { path: string }; containerEl: HTMLElement } }[] = [];
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app: {
			workspace: { getLeavesOfType: (type: string) => type === "pdf" ? leaves : [] },
			vault: {
				adapter: v.adapter,
				readBinary: async (file: { path: string }) => v.pdfs.get(file.path)!.slice().buffer,
				getFileByPath: (path: string) => v.pdfs.has(path) ? { path, extension: "pdf" } : null,
			},
		},
		store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map(),
	});
	async function open(path: string) {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, idle: true };
		const leaf = { view: { file: { path }, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId(leaf, root, controller);
		const id = plugin.pdfIds.get(root) as string;
		expect(id, "production resolution must bind a PDF identity").toMatch(/^pdf-[0-9a-f]+(?:-\d+)?$/);
		return { root, id };
	}
	function close(root: HTMLElement) {
		leaves.splice(leaves.findIndex((l) => l.view.containerEl === root), 1);
		const was = plugin.pdfIds.get(root);
		plugin.pdfInk.delete(root);
		plugin.pdfIds.delete(root);
		plugin.pdfFiles.delete(root);
		if (was) plugin.releasePdfId(was);
	}
	return { store, pdfStore, open, close };
}

const K = 6;

/** K inked PDFs, each its own family, written and closed; then a fresh session, as after a restart. */
async function inkedVault() {
	const v = vault();
	const first = session(v);
	const inked: string[] = [];
	for (let k = 0; k < K; k++) {
		const path = `Inked ${k}.pdf`;
		v.pdfs.set(path, pdf(k));
		const opened = await first.open(path);
		first.pdfStore.commit(opened.id, stroke(`s${k}`));
		await first.store.flush();
		inked.push(await first.store.resolvePath(opened.id));
		first.close(opened.root);
	}
	await vi.advanceTimersByTimeAsync(5000);
	v.pdfs.set("Fresh.pdf", pdf(40));
	const s = session(v);
	const reads: string[] = [];
	const read = v.adapter.read.bind(v.adapter);
	v.adapter.read = async (path: string) => (reads.push(path), read(path));
	const inkReads = () => reads.filter((p) => inked.includes(p));
	return { v, s, inked, reads, inkReads };
}

it("a second open of a PDF with no ink reads no other ink file that has not changed since the first", async () => {
	const { s, inkReads, reads } = await inkedVault();
	const first = await s.open("Fresh.pdf");
	expect(inkReads(), "the first open reads each other ink file's claims once").toHaveLength(K);
	s.close(first.root);
	reads.length = 0;
	const second = await s.open("Fresh.pdf");
	expect(second.id).toBe(first.id);
	expect(inkReads(), "the second open reads none of them").toEqual([]);
});

it("another PDF with no ink, opened later in the session, reads none of them either", async () => {
	const { v, s, inkReads, reads } = await inkedVault();
	await s.open("Fresh.pdf");
	reads.length = 0;
	v.pdfs.set("Other fresh.pdf", pdf(41));
	await s.open("Other fresh.pdf");
	expect(inkReads()).toEqual([]);
});

it("an ink file that changed on disk between the opens is read again, and only that one", async () => {
	const { v, s, inked, inkReads, reads } = await inkedVault();
	const first = await s.open("Fresh.pdf");
	s.close(first.root);
	reads.length = 0;
	const changed = inked[2]!;
	await v.adapter.write(changed, v.adapter.files.get(changed)!);
	await s.open("Fresh.pdf");
	expect(inkReads()).toEqual([changed]);
});

it("the carry still happens: a PDF changed while closed reopens with its ink after an earlier open read every claim", async () => {
	const { v, s } = await inkedVault();
	const fresh = await s.open("Fresh.pdf");
	s.close(fresh.root);
	const before = v.pdfs.get("Inked 3.pdf")!;
	const after = before.slice();
	after[200] = 122;
	v.pdfs.set("Inked 3.pdf", after);
	const reopened = await s.open("Inked 3.pdf");
	expect(s.pdfStore.strokesOnPage(reopened.id, 1).map((x) => x.id)).toEqual(["s3"]);
	expect(shown).toContain(CARRIED_NOTICE);
});
