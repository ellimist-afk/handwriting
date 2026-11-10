/**
 * A sync tool's conflict copy of a PDF ink file is not a live page: the
 * live-page filter leaves it out, so when the PDF changes while no pane shows
 * it, the carry to the new version never counts the copy as an older
 * version's ink file, however new the copy is. The live ink file still
 * carries. Production identity, PDF store and PageStore run on synthetic
 * storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { isLiveSidecarName } from "./InkFolder";
import { PdfInkStore } from "../pdf/PdfInkStore";
import type { InkStroke } from "../ink/Stroke";

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, Notice: class { constructor(_m: string) {} } };
});

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
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
		return { root, id: plugin.pdfIds.get(root) as string };
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

const SYNCTHING = (id: string) => `${id}.sync-conflict-20261105-120000-ABCDEFG.json`;
/** The name a Syncthing release that wrote no device part gives the same copy. */
const SYNCTHING_NO_DEVICE = (id: string) => `${id}.sync-conflict-20170101-120000.json`;

/**
 * Doc.pdf inked with "kept" and closed. With `copy`, a Syncthing copy of its
 * ink file then lands, newer, claiming the same path and holding "erased"
 * (the other device's revision, from before that stroke was erased here).
 * Then the PDF changes while closed, and a fresh session opens it.
 */
async function changedWhileClosed(copy: boolean, name = SYNCTHING) {
	const v = vault();
	const first = session(v);
	v.pdfs.set("Doc.pdf", pdf(1));
	const opened = await first.open("Doc.pdf");
	first.pdfStore.commit(opened.id, stroke("kept"));
	await first.store.flush();
	const livePath = await first.store.resolvePath(opened.id);
	first.close(opened.root);
	await vi.advanceTimersByTimeAsync(5000);
	if (copy) {
		const text = await v.adapter.read(livePath);
		const other = JSON.parse(text) as { strokes: { id: string }[] };
		other.strokes = other.strokes.map((s) => ({ ...s, id: "erased" }));
		const folder = livePath.slice(0, livePath.lastIndexOf("/"));
		v.adapter.externalWrite(`${folder}/${name(opened.id)}`, JSON.stringify(other));
	}
	const after = v.pdfs.get("Doc.pdf")!.slice();
	after[200] = 122;
	v.pdfs.set("Doc.pdf", after);
	const s = session(v);
	const reopened = await s.open("Doc.pdf");
	return { s, reopened, oldId: opened.id };
}

describe("a sync tool's copy of a PDF ink file never counts toward a carry", () => {
	it("a newer Syncthing copy with the same path claim is not carried after the PDF changes; the live file is", async () => {
		const { s, reopened, oldId } = await changedWhileClosed(true);
		expect(reopened.id).not.toBe(oldId);
		expect(s.pdfStore.strokesOnPage(reopened.id, 1).map((x) => x.id)).toEqual(["kept"]);
	});

	it("the copy is not a live page id", async () => {
		const { s, oldId } = await changedWhileClosed(true);
		const ids = await s.store.listIds("pdf-");
		expect(ids).toContain(oldId);
		expect(ids.filter((id) => id.includes(".sync-conflict-"))).toEqual([]);
	});

	it("a newer Syncthing copy with no device part in its name is not carried either; the live file is", async () => {
		const { s, reopened, oldId } = await changedWhileClosed(true, SYNCTHING_NO_DEVICE);
		expect(reopened.id).not.toBe(oldId);
		expect(s.pdfStore.strokesOnPage(reopened.id, 1).map((x) => x.id)).toEqual(["kept"]);
		expect((await s.store.listIds("pdf-")).filter((id) => id.includes(".sync-conflict-"))).toEqual([]);
	});
});

describe("controls", () => {
	it("with no copy, the older version's live ink file still carries", async () => {
		const { s, reopened } = await changedWhileClosed(false);
		expect(s.pdfStore.strokesOnPage(reopened.id, 1).map((x) => x.id)).toEqual(["kept"]);
	});

	it.each([
		["Syncthing", SYNCTHING("pdf-9f2c41d07a5e6b38")],
		["Dropbox", "pdf-9f2c41d07a5e6b38 (Alan's conflicted copy 2026-11-05).json"],
		["iCloud", "pdf-9f2c41d07a5e6b38 2.json"],
		["Syncthing, no device part", SYNCTHING_NO_DEVICE("pdf-9f2c41d07a5e6b38")],
		["Syncthing, any other tail", "pdf-9f2c41d07a5e6b38.sync-conflict-20170101-120000-ab.json"],
	])("the live-page filter leaves out the %s copy", (_tool, name) => {
		expect(isLiveSidecarName(name)).toBe(false);
	});

	it.each([
		"pdf-9f2c41d07a5e6b38.json",
		"3b7d9e21-0c4a-4f6e-8a15-2d9c7b4e6f80.json",
		"pdf-9f2c41d07a5e6b38-2.json",
	])("the live-page filter keeps a live page name: %s", (name) => {
		expect(isLiveSidecarName(name)).toBe(true);
	});
});
