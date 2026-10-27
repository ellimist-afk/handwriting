/** J1D-80: a PDF deleted, then Obsidian quit inside the 10 s grace: the template must not adopt the deleted copy's ink. Harness copied from src/pdf/PdfIdentityRouting.test.ts. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(_message: string) {}
	},
}));

import HandwritingPlugin from "../main";
import { TFile, Notice } from "obsidian";
import pluginSettingsSource from "../settings/PluginSettings.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "../pdf/PdfInkStore";
import { parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const TEMPLATE = "Template.pdf";
const COPY = "Template 1.pdf";

const source = pluginSettingsSource.replace(/\r\n/g, "\n");
const hostStart = "\t\tthis.pdfStore.attachHost({";
expect(source.split(hostStart)).toHaveLength(2);
const hostAt = source.indexOf(hostStart);
const hostEnd = source.indexOf("\n\t\t});", hostAt);
expect(hostEnd).toBeGreaterThan(hostAt);
const installPdfHost = new Function("Notice", "blockNotice", source.slice(hostAt, hostEnd + "\n\t\t});".length));

function stroke(x: number, id: string): InkStroke {
	return {
		id, page: 1, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [
			{ x, y: 10, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x, y: 10, width: 10, height: 10 },
	};
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function vault() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	adapter.list = async (folder: string) => {
		const files = [...adapter.files.keys()].filter(
			(p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")
		);
		return { files, folders: [] };
	};
	const pdfBytes = new TextEncoder().encode(
		"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "x".repeat(5000) + "\n%%EOF\n"
	);
	const files = new Set<string>();
	// A file whose bytes differ from the rest.
	const bytes = new Map<string, Uint8Array>();
	// The app's per-vault local store, which outlives a session.
	const local = new Map<string, unknown>();
	function sidecars() {
		return [...adapter.files.keys()].filter((p) => p.startsWith(".handwriting/"));
	}
	function sidecar(id: string) {
		const bytes = adapter.files.get(`.handwriting/${id}.json`);
		return bytes === undefined ? undefined : parsePage(bytes, id).data;
	}
	return { adapter, pdfBytes, files, bytes, local, sidecars, sidecar };
}

function session(v: ReturnType<typeof vault>) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	const app = {
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files].map((path) => ({ path, extension: "pdf" })),
			readBinary: async (file: { path: string }) => (v.bytes.get(file.path) ?? v.pdfBytes).slice().buffer,
			getFileByPath: (p: string) => (v.files.has(p) ? { path: p, extension: "pdf" } : null),
		},
		loadLocalStorage: (key: string) => v.local.get(key) ?? null,
		saveLocalStorage: (key: string, data: unknown) => {
			if (data === null) v.local.delete(key);
			else v.local.set(key, data);
		},
	};
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, { app, store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map() });
	installPdfHost.call(plugin, Notice, (m: string) => new Notice(m));
	plugin.attachPdfPendingDeletes();
	async function open(path: string) {
		expect(v.files.has(path), `precondition: ${path} exists in the vault`).toBe(true);
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, idle: true };
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId({ view: { file: { path } } }, root, controller);
		return { root, id: plugin.pdfIds.get(root) as string };
	}
	function close(root: HTMLElement) {
		(root as unknown as { isConnected: boolean }).isConnected = false;
		plugin.pdfInk.delete(root);
		plugin.pdfIds.delete(root);
		plugin.pdfFiles.delete(root);
	}
	function draw(id: string, s: InkStroke) {
		pdfStore.replaceAll(id, [...pdfStore.strokes(id), s]);
	}
	async function deleteFile(path: string) {
		v.files.delete(path);
		const file = Object.assign(new TFile(), {
			path,
			extension: path.split(".").pop(),
			name: path.split("/").pop(),
			basename: path.replace(/\.[^.]+$/, ""),
		});
		await plugin.onFileDeleted(file);
	}
	return { store, pdfStore, plugin, open, close, draw, deleteFile };
}

it("J1D-80: delete a copy, quit within the grace, reopen: the template opens blank", async () => {
	const v = vault();
	v.files.add(TEMPLATE);
	v.files.add(COPY);
	const s1 = session(v);
	const c = await s1.open(COPY);
	s1.draw(c.id, stroke(50, "copy-stroke"));
	await s1.store.flush();
	s1.close(c.root);
	expect(v.sidecar(c.id)?.pdfPaths).toEqual([COPY]);

	vi.useFakeTimers();
	try {
		await s1.deleteFile(COPY);
		Object.assign(s1.plugin, {
			pendingRecycle: new Map(),
			declaimTimers: new Map(),
			applyPaper: () => {},
			finishPersistence: async () => {},
		});
		vi.stubGlobal("document", { body: { classList: { remove() {} } } });
		s1.plugin.onunload();
		await vi.advanceTimersByTimeAsync(10_001);
	} finally {
		vi.useRealTimers();
	}
	expect(v.files.has(COPY)).toBe(false);
	expect(v.files.has(TEMPLATE)).toBe(true);

	const s2 = session(v);
	const t = await s2.open(TEMPLATE);
	await s2.store.flush();
	expect(s2.pdfStore.strokes(t.id).map((s) => s.id), "template opened wearing the deleted copy's ink").toEqual([]);
	expect(v.sidecar(c.id)?.pdfPaths ?? [], "template path written into the deleted copy's sidecar").not.toContain(TEMPLATE);
});

it("a deletion restored at the next start whose file is back by then retires nothing", async () => {
	const v = vault();
	v.files.add(TEMPLATE);
	v.files.add(COPY);
	const s1 = session(v);
	const c = await s1.open(COPY);
	s1.draw(c.id, stroke(50, "copy-stroke"));
	await s1.store.flush();
	s1.close(c.root);

	vi.useFakeTimers();
	try {
		await s1.deleteFile(COPY);
		// What unload does with deletions still in their grace.
		s1.pdfStore.cancelPendingDeletes();
		expect(v.local.size, "the deletion was not kept for the next session").toBe(1);
		// A sync puts the file back before the next start.
		v.files.add(COPY);
		const s2 = session(v);
		expect(s2.pdfStore.pendingClaims().has(COPY), "the deletion was not restored").toBe(true);
		await vi.advanceTimersByTimeAsync(10_001);
		// Retiring reads sidecars and file heads after the grace; it is over
		// when the deletion leaves the pending list.
		vi.useRealTimers();
		await vi.waitFor(() => expect(s2.pdfStore.pendingClaims().has(COPY)).toBe(false));
		await s2.store.flush();
	} finally {
		vi.useRealTimers();
	}
	expect(v.sidecar(c.id)?.pdfPaths, "the restored deletion retired the claim of a file that is back").toEqual([COPY]);
	expect(v.local.size, "a settled deletion stayed saved").toBe(0);
	const s3 = session(v);
	const again = await s3.open(COPY);
	expect(s3.pdfStore.strokes(again.id).map((s) => s.id)).toEqual(["copy-stroke"]);
});

it("a deletion restored at the next start whose path holds a changed file by then keeps the deleted file's ink", async () => {
	const v = vault();
	v.files.add(TEMPLATE);
	v.files.add(COPY);
	const s1 = session(v);
	const c = await s1.open(COPY);
	s1.draw(c.id, stroke(50, "copy-stroke"));
	await s1.store.flush();
	s1.close(c.root);

	vi.useFakeTimers();
	try {
		await s1.deleteFile(COPY);
		s1.pdfStore.cancelPendingDeletes();
		// A sync puts a changed file at the path before the next start.
		v.files.add(COPY);
		v.bytes.set(COPY, new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "z".repeat(7000) + "\n%%EOF\n"));
		const s2 = session(v);
		expect(s2.pdfStore.pendingClaims().has(COPY), "the deletion was not restored").toBe(true);
		await vi.advanceTimersByTimeAsync(10_001);
		vi.useRealTimers();
		await vi.waitFor(() => expect(s2.pdfStore.pendingClaims().has(COPY)).toBe(false));
		await s2.store.flush();
	} finally {
		vi.useRealTimers();
	}
	expect(v.sidecar(c.id)?.pdfPaths, "the changed file at the deleted path retired the deleted file's ink").toEqual([COPY]);
	expect(v.local.size, "a settled deletion stayed saved").toBe(0);
});
