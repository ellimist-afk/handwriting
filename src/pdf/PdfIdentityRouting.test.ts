/** PDF instance routing through the plugin and real stores, with an in-memory vault. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { PdfInkStore } from "./PdfInkStore";
import { parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const TEMPLATE = "Template.pdf";
const COPY = "Template 1.pdf";

// Execute the production host registration, including its load options, rather
// than reconstructing that adapter in this fixture.
const source = mainSource.replace(/\r\n/g, "\n");
const hostStart = "\t\tthis.pdfStore.attachHost({";
expect(source.split(hostStart)).toHaveLength(2);
const hostAt = source.indexOf(hostStart);
const hostEnd = source.indexOf("\n\t\t});", hostAt);
expect(hostEnd).toBeGreaterThan(hostAt);
const installPdfHost = new Function("Notice", source.slice(hostAt, hostEnd + "\n\t\t});".length));

function stroke(x: number, id: string): InkStroke {
	return {
		id,
		page: 1,
		tool: "pen",
		color: "#111111",
		width: 2,
		createdAt: 0,
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

/** One vault (disk + file list) shared by any number of plugin sessions. */
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
	// Every PDF here holds the same bytes: "Make a copy" of the template.
	const pdfBytes = new TextEncoder().encode(
		"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "x".repeat(5000) + "\n%%EOF\n"
	);
	const files = new Set<string>();
	function sidecars() {
		return [...adapter.files.keys()].filter((p) => p.startsWith(".handwriting/"));
	}
	function sidecar(id: string) {
		const bytes = adapter.files.get(`.handwriting/${id}.json`);
		return bytes === undefined ? undefined : parsePage(bytes, id).data;
	}
	return { adapter, pdfBytes, files, sidecars, sidecar };
}

/** A plugin session (fresh memory) over the shared vault. */
function session(v: ReturnType<typeof vault>) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	const app = {
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files].map((path) => ({ path, extension: "pdf" })),
			readBinary: async (_file: { path: string }) => v.pdfBytes.slice().buffer,
			getFileByPath: (p: string) => (v.files.has(p) ? { path: p, extension: "pdf" } : null),
		},
	};
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app,
		store,
		pdfStore,
		pdfInk: new Map(),
		pdfIds: new Map(),
		pdfFiles: new Map(),
	});
	installPdfHost.call(plugin, Notice);
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
	/** The vault removes the file, then the plugin's real delete handler runs. */
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

describe("a deleted PDF's ink must not reach the next file with the same bytes", () => {
	it("CONTROL: a PDF renamed while closed keeps its ink (the intended adopt path)", async () => {
		const v = vault();
		v.files.add("A.pdf");
		const s1 = session(v);
		const a = await s1.open("A.pdf");
		s1.draw(a.id, stroke(10, "a-stroke"));
		await s1.store.flush();
		s1.close(a.root);
		expect(v.sidecar(a.id)?.pdfPaths).toEqual(["A.pdf"]);
		// Renamed while closed: old path gone, new path present.
		v.files.delete("A.pdf");
		v.files.add("B.pdf");
		const s2 = session(v);
		const b = await s2.open("B.pdf");
		expect(b.id).toBe(a.id);
		expect(s2.pdfStore.strokes(b.id).map((s) => s.id)).toEqual(["a-stroke"]);
	});

	it("a template that existed at deletion cannot take the pending copy's ink", async () => {
		const v = vault();
		v.files.add(TEMPLATE); // the template, never drawn on, so no sidecar
		v.files.add(COPY); // "Make a copy"

		const s1 = session(v);
		const c = await s1.open(COPY);
		s1.draw(c.id, stroke(50, "copy-stroke"));
		await s1.store.flush();
		s1.close(c.root);
		// Precondition: exactly one sidecar, claiming only the copy.
		expect(v.sidecars()).toEqual([`.handwriting/${c.id}.json`]);
		expect(v.sidecar(c.id)?.pdfPaths).toEqual([COPY]);

		// The user deletes the copy; the plugin's real delete handler runs.
		await s1.deleteFile(COPY);
		await s1.store.flush();
		// Precondition: the copy is gone and the template is still there.
		expect(v.files.has(COPY)).toBe(false);
		expect(v.files.has(TEMPLATE)).toBe(true);
		// Before the grace expires, the existing template is not a new file.
		const t = await s1.open(TEMPLATE);
		const templateInk = s1.pdfStore.strokes(t.id).map((s) => s.id);
		expect(templateInk, "template opened wearing the deleted copy's ink").toEqual([]);
		expect(t.id).not.toBe(c.id);
		expect(v.sidecar(c.id)?.pdfPaths).not.toContain(TEMPLATE);
	});

	it("retires the last claim after the grace, then a reused name opens blank", async () => {
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
			await vi.advanceTimersByTimeAsync(10_001);
			await s1.store.flush();
		} finally {
			vi.useRealTimers();
		}
		expect(v.sidecar(c.id)).toBeUndefined();
		expect([...v.adapter.files.keys()].some((p) => p.includes("/trash/") && p.includes(c.id))).toBe(true);

		// A new copy may reuse the deleted path but not its ink.
		v.files.add(COPY);
		const s2 = session(v);
		const n = await s2.open(COPY);
		const ink = s2.pdfStore.strokes(n.id).map((s) => s.id);
		expect(ink, "new copy on the reused name opened wearing the deleted copy's ink").toEqual([]);
		expect([...v.adapter.files.keys()].some((p) => p.includes("/trash/") && p.includes(c.id))).toBe(true);
	});

	it("a new same-family path created in the grace inherits ink, even after the old template opens", async () => {
		const v = vault();
		v.files.add(TEMPLATE);
		v.files.add(COPY);
		const first = session(v);
		const copy = await first.open(COPY);
		first.draw(copy.id, stroke(50, "copy-stroke"));
		await first.store.flush();
		first.close(copy.root);
		vi.useFakeTimers();
		try {
			await first.deleteFile(COPY);
			const old = await first.open(TEMPLATE);
			expect(old.id).not.toBe(copy.id);
			v.files.add("Moved.pdf");
			// The create is in the grace, but nobody opens the new path until later.
			await vi.advanceTimersByTimeAsync(10_001);
			await vi.waitFor(() => expect(first.pdfStore.pendingClaims().has(COPY)).toBe(false));
			await first.store.flush();
		} finally {
			vi.useRealTimers();
		}
		const moved = await session(v).open("Moved.pdf");
		expect(moved.id).toBe(copy.id);
		expect(v.sidecar(copy.id)?.pdfPaths).toContain("Moved.pdf");
		expect(v.sidecar(copy.id)?.pdfPaths).not.toContain(COPY);
	});

	it("a same-path recreation inside the grace keeps its ink", async () => {
		const v = vault();
		v.files.add(COPY);
		const first = session(v);
		const copy = await first.open(COPY);
		first.draw(copy.id, stroke(50, "copy-stroke"));
		await first.store.flush();
		first.close(copy.root);
		vi.useFakeTimers();
		try {
			await first.deleteFile(COPY);
			v.files.add(COPY);
			const during = await first.open(COPY);
			expect(during.id).toBe(copy.id);
			expect(first.pdfStore.strokes(during.id).map((s) => s.id)).toEqual(["copy-stroke"]);
			first.close(during.root);
			await vi.advanceTimersByTimeAsync(10_001);
		} finally {
			vi.useRealTimers();
		}
		const returned = await session(v).open(COPY);
		expect(returned.id).toBe(copy.id);
		expect(v.sidecar(copy.id)?.strokes.map((s) => s.id)).toEqual(["copy-stroke"]);
	});

	it("plugin unload cancels a pending retirement instead of writing later", async () => {
		const v = vault();
		v.files.add(COPY);
		const s = session(v);
		const copy = await s.open(COPY);
		s.draw(copy.id, stroke(50, "copy-stroke"));
		await s.store.flush();
		vi.useFakeTimers();
		try {
			await s.deleteFile(COPY);
			// Exercise the plugin boundary: unloading must cancel the PDF timer.
			Object.assign(s.plugin, {
				pendingRecycle: new Map(),
				declaimTimers: new Map(),
				applyPaper: () => {},
				finishPersistence: async () => {},
			});
			vi.stubGlobal("document", { body: { classList: { remove() {} } } });
			s.plugin.onunload();
			await vi.advanceTimersByTimeAsync(10_001);
		} finally {
			vi.useRealTimers();
		}
		expect(v.sidecar(copy.id)?.pdfPaths).toEqual([COPY]);
		expect(v.sidecar(copy.id)?.strokes.map((stroke) => stroke.id)).toEqual(["copy-stroke"]);
	});

	it("after the grace, an inked template keeps only its own ink", async () => {
		const v = vault();
		v.files.add(TEMPLATE);
		v.files.add(COPY);
		const first = session(v);
		const template = await first.open(TEMPLATE);
		first.draw(template.id, stroke(10, "template-ink"));
		await first.store.flush();
		first.close(template.root);
		const copy = await first.open(COPY);
		first.draw(copy.id, stroke(50, "copy-ink"));
		await first.store.flush();
		first.close(copy.root);
		// Deletion can arrive in a later plugin session with no PDF record held.
		const deleter = session(v);
		vi.useFakeTimers();
		try {
			await deleter.deleteFile(COPY);
			await vi.advanceTimersByTimeAsync(10_001);
			await vi.waitFor(() => expect(deleter.pdfStore.pendingClaims().has(COPY)).toBe(false));
			await deleter.store.flush();
		} finally {
			vi.useRealTimers();
		}
		const reopened = await session(v).open(TEMPLATE);
		expect(reopened.id).toBe(template.id);
		expect(v.sidecar(copy.id)).toBeUndefined();
		expect(v.sidecar(template.id)?.strokes.map((s) => s.id)).toEqual(["template-ink"]);
	});
});

it("holds a copy unresolved when an existing sidecar's claims cannot be read", async () => {
	const v = vault();
	v.files.add(TEMPLATE);
	v.files.add(COPY);
	const first = session(v);
	const original = await first.open(TEMPLATE);
	first.draw(original.id, stroke(10, "original-ink"));
	await first.store.flush();
	first.close(original.root);
	const second = session(v);
	const read = second.store.readPdfPaths.bind(second.store);
	vi.spyOn(second.store, "readPdfPaths").mockImplementation((id) => id === original.id ? Promise.resolve(null) : read(id));
	await expect(second.open(COPY)).rejects.toThrow(/could not read.*PDF.*claims/i);
	expect(second.plugin.pdfIds.size).toBe(0);
	expect(v.sidecar(original.id)?.pdfPaths).toEqual([TEMPLATE]);
	expect(v.sidecar(original.id)?.strokes.map((s) => s.id)).toEqual(["original-ink"]);
});

it("still adopts a readable legacy sidecar with no path claims", async () => {
	const v = vault();
	v.files.add(TEMPLATE);
	const first = session(v);
	const original = await first.open(TEMPLATE);
	first.draw(original.id, stroke(10, "legacy-ink"));
	await first.store.flush();
	first.close(original.root);
	const legacy = v.sidecar(original.id)!;
	delete legacy.pdfPaths;
	v.adapter.files.set(`.handwriting/${original.id}.json`, serializePage(legacy));
	v.files.delete(TEMPLATE);
	v.files.add(COPY);
	const second = session(v);
	const copy = await second.open(COPY);
	expect(copy.id).toBe(original.id);
	expect(second.pdfStore.strokes(copy.id).map((s) => s.id)).toEqual(["legacy-ink"]);
});
