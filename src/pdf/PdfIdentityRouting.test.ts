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
import pluginSettingsSource from "../settings/PluginSettings.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const TEMPLATE = "Template.pdf";
const COPY = "Template 1.pdf";

// Execute the production host registration, including its load options, rather
// than reconstructing that adapter in this fixture.
const source = pluginSettingsSource.replace(/\r\n/g, "\n");
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
	/** This device's local storage, which outlives a plugin session. */
	const local = new Map<string, unknown>();
	function sidecars() {
		return [...adapter.files.keys()].filter((p) => p.startsWith(".handwriting/"));
	}
	function sidecar(id: string) {
		const bytes = adapter.files.get(`.handwriting/${id}.json`);
		return bytes === undefined ? undefined : parsePage(bytes, id).data;
	}
	function inTrash(id: string) {
		return [...adapter.files.keys()].some((p) => p.includes("/trash/") && p.includes(id));
	}
	return { adapter, pdfBytes, files, local, sidecars, sidecar, inTrash };
}

function pdfFile(path: string) {
	return Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	});
}

/**
 * A plugin session (fresh memory) over the shared vault. Its vault events are
 * the plugin's own registrations; `layoutReady` is the workspace's flag.
 * `pendingStore` restores and saves deletions in their grace the way the
 * plugin does at load.
 */
function session(v: ReturnType<typeof vault>, opts: { layoutReady?: boolean; pendingStore?: boolean } = {}) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	const vaultOn = new Map<string, ((...a: unknown[]) => unknown)[]>();
	const app = {
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files].map((path) => ({ path, extension: "pdf" })),
			readBinary: async (_file: { path: string }) => v.pdfBytes.slice().buffer,
			getFileByPath: (p: string) => (v.files.has(p) ? { path: p, extension: "pdf" } : null),
			on: (name: string, handler: (...a: unknown[]) => unknown) => {
				vaultOn.set(name, [...(vaultOn.get(name) ?? []), handler]);
				return {};
			},
		},
		workspace: { layoutReady: opts.layoutReady ?? true },
		loadLocalStorage: (key: string) => v.local.get(key) ?? null,
		saveLocalStorage: (key: string, value: unknown) => {
			if (value === null) v.local.delete(key);
			else v.local.set(key, value);
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
		registerEvent: () => {},
		register: () => {},
	});
	installPdfHost.call(plugin, Notice);
	plugin.onloadVaultEvents();
	if (opts.pendingStore) plugin.attachPdfPendingDeletes();
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
		await plugin.onFileDeleted(pdfFile(path));
	}
	/** The vault adds the file, then every create handler the plugin registered runs. */
	async function createFile(path: string) {
		v.files.add(path);
		for (const handler of vaultOn.get("create") ?? []) await handler(pdfFile(path));
	}
	/** The vault renames the file, then every rename handler the plugin registered runs. */
	async function renameFile(oldPath: string, newPath: string) {
		v.files.delete(oldPath);
		v.files.add(newPath);
		for (const handler of vaultOn.get("rename") ?? []) await handler(pdfFile(newPath), oldPath);
	}
	return { store, pdfStore, plugin, app, open, close, draw, deleteFile, createFile, renameFile };
}

/** A later session opens `path` and finds `id` with exactly this ink. */
async function expectOpens(v: ReturnType<typeof vault>, path: string, id: string, ink: string[]) {
	const s = session(v);
	const opened = await s.open(path);
	expect(opened.id, `${path} opened another ink file`).toBe(id);
	expect(s.pdfStore.strokes(opened.id).map((s) => s.id)).toEqual(ink);
}

/** A later session opens `path` and finds it blank. */
async function expectBlank(v: ReturnType<typeof vault>, path: string) {
	const s = session(v);
	const opened = await s.open(path);
	expect(s.pdfStore.strokes(opened.id).map((s) => s.id), `${path} opened wearing ink`).toEqual([]);
}

/** One session with one inked PDF per path, each closed again. */
async function inked<const P extends readonly string[]>(
	v: ReturnType<typeof vault>,
	paths: P,
	opts: { layoutReady?: boolean; pendingStore?: boolean } = {}
) {
	for (const p of paths) v.files.add(p);
	const s = session(v, opts);
	const ids: string[] = [];
	for (const [i, p] of paths.entries()) {
		const o = await s.open(p);
		s.draw(o.id, stroke(10 + 10 * i, `ink-${i}`));
		await s.store.flush();
		s.close(o.root);
		ids.push(o.id);
	}
	expect(new Set(ids).size, "precondition: each path has its own ink file").toBe(paths.length);
	return { s, ids: ids as { [K in keyof P]: string } };
}

/** Run every grace out and let each retirement finish. */
async function settleGrace(s: ReturnType<typeof session>) {
	await vi.advanceTimersByTimeAsync(10_001);
	await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
	await s.store.flush();
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

describe("a PDF renamed on another device keeps its ink when the new file lands before the old one goes", () => {
	const OLD = "Old.pdf";
	const NEW = "New.pdf";

	afterEach(() => {
		vi.useRealTimers();
	});

	// A create's mark lives 90 s: a sync tool may send the new name first and the old name's removal up to a minute
	// later. The wait after the delete stays 10 s.
	it.each([
		[9_999, "keeps"],
		[10_000, "keeps"],
		[11_000, "keeps"],
		[60_000, "keeps"],
		[89_999, "keeps"],
		[90_000, "trash"],
		[91_000, "trash"],
	] as const)("the new file created %i ms before the delete: the ink %s", async (gap, outcome) => {
		const v = vault();
		const { s, ids: [old] } = await inked(v, [OLD]);
		vi.useFakeTimers();
		await s.createFile(NEW);
		await vi.advanceTimersByTimeAsync(gap);
		await s.deleteFile(OLD);
		await settleGrace(s);
		vi.useRealTimers();
		if (outcome === "keeps") {
			expect(v.inTrash(old), "the renamed file's ink went to the trash").toBe(false);
			expect(v.sidecar(old)?.pdfPaths).toEqual([NEW]);
			await expectOpens(v, NEW, old, ["ink-0"]);
		} else {
			expect(v.sidecar(old)).toBeUndefined();
			expect(v.inTrash(old)).toBe(true);
			await expectBlank(v, NEW);
		}
	});

	it.each([false, true])("an older template, created two minutes before the delete, past a create's 90 s, cannot take the ink (opened in the grace: %s)", async (openInGrace) => {
		const v = vault();
		const { s, ids: [old] } = await inked(v, [OLD]);
		vi.useFakeTimers();
		await s.createFile(TEMPLATE);
		await vi.advanceTimersByTimeAsync(120_000);
		await s.deleteFile(OLD);
		if (openInGrace) {
			const t = await s.open(TEMPLATE);
			expect(s.pdfStore.strokes(t.id).map((x) => x.id), "template opened wearing the deleted file's ink").toEqual([]);
			expect(t.id).not.toBe(old);
			s.close(t.root);
		}
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(old)).toBeUndefined();
		expect(v.inTrash(old)).toBe(true);
		await expectBlank(v, TEMPLATE);
	});

	it("a new file another ink file already claims is not taken, even when it was just created", async () => {
		const v = vault();
		// Both inked on another device: the second ink file claims New.
		const { ids: [old, other] } = await inked(v, [OLD, NEW]);
		v.files.delete(NEW);
		// This device: New arrives, then Old goes.
		const s = session(v);
		vi.useFakeTimers();
		await s.createFile(NEW);
		await vi.advanceTimersByTimeAsync(1_000);
		await s.deleteFile(OLD);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(old), "a claimed file took a second ink file").toBeUndefined();
		expect(v.inTrash(old)).toBe(true);
		expect(v.sidecar(other)?.pdfPaths).toEqual([NEW]);
		await expectOpens(v, NEW, other, ["ink-1"]);
	});

	it("a new file created after the delete, inside the grace, inherits the ink with its create seen", async () => {
		const v = vault();
		const { s, ids: [old] } = await inked(v, [OLD]);
		vi.useFakeTimers();
		await s.deleteFile(OLD);
		await vi.advanceTimersByTimeAsync(3_000);
		await s.createFile(NEW);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(old)?.pdfPaths).toEqual([NEW]);
		await expectOpens(v, NEW, old, ["ink-0"]);
	});

	it("the same path coming back inside the grace keeps its ink with its create seen", async () => {
		const v = vault();
		const { s, ids: [old] } = await inked(v, [OLD]);
		vi.useFakeTimers();
		await s.deleteFile(OLD);
		await vi.advanceTimersByTimeAsync(2_000);
		await s.createFile(OLD);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.inTrash(old)).toBe(false);
		expect(v.sidecar(old)?.pdfPaths).toEqual([OLD]);
		await expectOpens(v, OLD, old, ["ink-0"]);
	});

	it("a second delete of the same path keeps the new file fresh (one session)", async () => {
		const v = vault();
		const { s, ids: [old] } = await inked(v, [OLD]);
		vi.useFakeTimers();
		await s.createFile(NEW);
		await vi.advanceTimersByTimeAsync(85_000);
		await s.deleteFile(OLD);
		await vi.advanceTimersByTimeAsync(2_000);
		await s.createFile(OLD);
		await vi.advanceTimersByTimeAsync(4_000);
		// 91 s after New's create: past a create's 90 s, but the first delete left New out.
		await s.deleteFile(OLD);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.inTrash(old)).toBe(false);
		expect(v.sidecar(old)?.pdfPaths).toEqual([NEW]);
		await expectOpens(v, NEW, old, ["ink-0"]);
	});

	it("a second delete of the same path keeps the new file fresh (after a quit inside the grace)", async () => {
		const v = vault();
		const { s: first, ids: [old] } = await inked(v, [OLD], { pendingStore: true });
		vi.useFakeTimers();
		await first.createFile(NEW);
		await vi.advanceTimersByTimeAsync(9_000);
		await first.deleteFile(OLD);
		// Quit inside the grace: the deletion is saved, New's create time is not.
		first.pdfStore.cancelPendingDeletes();
		expect(v.local.size, "precondition: the deletion was saved").toBe(1);
		const next = session(v, { pendingStore: true });
		expect(next.pdfStore.pendingClaims().has(OLD), "precondition: the deletion resumed").toBe(true);
		await next.createFile(OLD);
		await vi.advanceTimersByTimeAsync(1_000);
		await next.deleteFile(OLD);
		await settleGrace(next);
		vi.useRealTimers();
		expect(v.inTrash(old)).toBe(false);
		expect(v.sidecar(old)?.pdfPaths).toEqual([NEW]);
		await expectOpens(v, NEW, old, ["ink-0"]);
	});

	it("a create seen before the layout is ready is startup's, not a rename: the ink goes to the trash", async () => {
		const v = vault();
		const { ids: [old] } = await inked(v, [OLD]);
		const s = session(v, { layoutReady: false });
		vi.useFakeTimers();
		await s.createFile(NEW);
		s.app.workspace.layoutReady = true;
		await vi.advanceTimersByTimeAsync(1_000);
		await s.deleteFile(OLD);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(old)).toBeUndefined();
		expect(v.inTrash(old)).toBe(true);
		await expectBlank(v, NEW);
	});

	it.each(["deletes first", "creates first"] as const)(
		"two inked same-bytes PDFs moved together each keep their own ink (%s)",
		async (order) => {
			const v = vault();
			const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
			vi.useFakeTimers();
			const deletes = async () => {
				await s.deleteFile("One/A.pdf");
				await s.deleteFile("One/B.pdf");
			};
			// The new paths arrive in the other order, so vault order alone pairs them wrong.
			const creates = async () => {
				await s.createFile("Two/B.pdf");
				await s.createFile("Two/A.pdf");
			};
			if (order === "deletes first") {
				await deletes();
				await creates();
			} else {
				await creates();
				await deletes();
			}
			await settleGrace(s);
			vi.useRealTimers();
			expect(v.sidecar(a)?.pdfPaths).toEqual(["Two/A.pdf"]);
			expect(v.sidecar(b)?.pdfPaths).toEqual(["Two/B.pdf"]);
			await expectOpens(v, "Two/A.pdf", a, ["ink-0"]);
			await expectOpens(v, "Two/B.pdf", b, ["ink-1"]);
		}
	);

	it("one moved under its own name and one renamed each keep their ink, the renamed one retiring first", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/B.pdf");
		await vi.advanceTimersByTimeAsync(500);
		await s.deleteFile("One/A.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("One/C.pdf");
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths).toEqual(["Two/A.pdf"]);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["One/C.pdf"]);
		await expectOpens(v, "Two/A.pdf", a, ["ink-0"]);
		await expectOpens(v, "One/C.pdf", b, ["ink-1"]);
	});

	it("two inks moved to names they share nothing with both go to the trash; neither new file shows ink", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/C.pdf");
		await s.createFile("Two/D.pdf");
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)).toBeUndefined();
		expect(v.sidecar(b)).toBeUndefined();
		expect(v.inTrash(a)).toBe(true);
		expect(v.inTrash(b)).toBe(true);
		await expectBlank(v, "Two/C.pdf");
		await expectBlank(v, "Two/D.pdf");
	});

	it("two inked same-bytes PDFs moved together and opened inside the grace, in the other order, each show their own ink", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Two/B.pdf");
		const openedB = await s.open("Two/B.pdf");
		expect(openedB.id, "Two/B.pdf opened with A's ink file").toBe(b);
		expect(s.pdfStore.strokes(openedB.id).map((x) => x.id)).toEqual(["ink-1"]);
		const openedA = await s.open("Two/A.pdf");
		expect(openedA.id, "Two/A.pdf opened with B's ink file").toBe(a);
		expect(s.pdfStore.strokes(openedA.id).map((x) => x.id)).toEqual(["ink-0"]);
		s.close(openedB.root);
		s.close(openedA.root);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths).toEqual(["Two/A.pdf"]);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["Two/B.pdf"]);
	});

	it("an open inside the grace that ties another new file gets a blank instance, and retirement pairs nothing for it", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		await s.createFile("Two/B.pdf");
		const opened = await s.open("Two/A.pdf");
		expect(opened.id, "Two/A.pdf took A's ink while Three/A.pdf ties it").not.toBe(a);
		expect(opened.id).not.toBe(b);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual([]);
		// The pane closes as the plugin closes one: its blank instance is let go.
		s.close(opened.root);
		s.plugin.releasePdfId(opened.id);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)).toBeUndefined();
		expect(v.inTrash(a)).toBe(true);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["Two/B.pdf"]);
		await expectBlank(v, "Two/A.pdf");
		await expectBlank(v, "Three/A.pdf");
		await expectOpens(v, "Two/B.pdf", b, ["ink-1"]);
	});

	it("an open inside the grace counts every new file the retirement counts: a tie on a name that shares nothing opens blank, and that ink goes to the trash", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["A/x.pdf", "B/y.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("A/x.pdf");
		await s.deleteFile("B/y.pdf");
		await s.createFile("C/x.pdf");
		await s.createFile("Z/A/x.pdf");
		await s.createFile("W/q.pdf");
		const opened = await s.open("C/x.pdf");
		expect(opened.id, "C/x.pdf took B's ink while W/q.pdf ties it").not.toBe(b);
		expect(opened.id, "C/x.pdf took A's ink, which Z/A/x.pdf matches better").not.toBe(a);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual([]);
		s.close(opened.root);
		s.plugin.releasePdfId(opened.id);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths).toEqual(["Z/A/x.pdf"]);
		expect(v.sidecar(b), "B's ink went to a file that ties another").toBeUndefined();
		expect(v.inTrash(b)).toBe(true);
		await expectOpens(v, "Z/A/x.pdf", a, ["ink-0"]);
		await expectBlank(v, "C/x.pdf");
		await expectBlank(v, "W/q.pdf");
	});

	it("ink whose best new names tie is not given a weaker one: it goes to the trash, and the other ink keeps its match", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		await s.createFile("Two/B.pdf");
		await s.createFile("X/C.pdf");
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a), "A's ink went to a file whose name matched nothing").toBeUndefined();
		expect(v.inTrash(a)).toBe(true);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["Two/B.pdf"]);
		await expectBlank(v, "X/C.pdf");
		await expectBlank(v, "Two/A.pdf");
		await expectBlank(v, "Three/A.pdf");
		await expectOpens(v, "Two/B.pdf", b, ["ink-1"]);
	});

	it("two new files that tie, opened at once, never share one ink file, and both open blank", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		await s.createFile("Two/B.pdf");
		const [x, y] = await Promise.all([s.open("Two/A.pdf"), s.open("Three/A.pdf")]);
		vi.useRealTimers();
		expect(x.id, "two files share one ink file").not.toBe(y.id);
		expect([x.id, y.id], "an A.pdf took B's ink").not.toContain(b);
		expect(s.pdfStore.strokes(x.id).map((k) => k.id), "the first to choose tied and opens blank").toEqual([]);
		expect(y.id, "the second took A's ink by elimination while the first holds its blank").not.toBe(a);
		expect(s.pdfStore.strokes(y.id).map((k) => k.id)).toEqual([]);
	});

	it("two new files that tie never share one ink file when the first is still loading its blank one as the second finishes its reads", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		await s.createFile("Two/B.pdf");
		// Three/A.pdf's open waits inside its reads of the other new files.
		const readBinary = s.app.vault.readBinary;
		let readHeld: () => void = () => {};
		let readReached: () => void = () => {};
		const reads = new Promise<void>((r) => (readHeld = r));
		const readWaits = new Promise<void>((r) => (readReached = r));
		let holdRead = true;
		s.app.vault.readBinary = async (file: { path: string }) => {
			if (holdRead && file.path === "Two/B.pdf") {
				holdRead = false;
				readReached();
				await reads;
			}
			return readBinary(file);
		};
		// Two/A.pdf's open chooses meanwhile, and waits loading its ink file.
		const load = s.store.load.bind(s.store);
		let loadHeld: () => void = () => {};
		let loadReached: () => void = () => {};
		const loads = new Promise<void>((r) => (loadHeld = r));
		const loadWaits = new Promise<void>((r) => (loadReached = r));
		let holdLoad = false;
		s.store.load = (async (...args: Parameters<typeof load>) => {
			if (holdLoad) {
				holdLoad = false;
				loadReached();
				await loads;
			}
			return load(...args);
		}) as typeof s.store.load;
		const second = s.open("Three/A.pdf");
		await readWaits;
		holdLoad = true;
		const first = s.open("Two/A.pdf");
		await loadWaits;
		readHeld();
		await vi.waitFor(() => expect(s.plugin.pdfIds.size).toBe(2));
		loadHeld();
		const [x, y] = await Promise.all([first, second]);
		vi.useRealTimers();
		expect(x.id, "two files share one ink file").not.toBe(y.id);
		expect([x.id, y.id], "an A.pdf took B's ink").not.toContain(b);
		expect(s.pdfStore.strokes(x.id).map((k) => k.id), "the first to choose tied and opens blank").toEqual([]);
		expect(y.id, "the second took A's ink by elimination while the first holds its blank").not.toBe(a);
		expect(s.pdfStore.strokes(y.id).map((k) => k.id)).toEqual([]);
	});

	it("an open inside the grace that ties another new file and stays open: retirement still pairs nothing for that ink", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		await s.createFile("Two/B.pdf");
		const opened = await s.open("Two/A.pdf");
		expect(opened.id, "Two/A.pdf took A's ink while Three/A.pdf ties it").not.toBe(a);
		expect(opened.id).not.toBe(b);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual([]);
		// The pane stays open through the grace, and its blank instance with it.
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths, "A's ink moved to the other tied file by elimination").toBeUndefined();
		expect(v.inTrash(a)).toBe(true);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["Two/B.pdf"]);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id), "the open pane").toEqual([]);
		await expectBlank(v, "Two/A.pdf");
		await expectBlank(v, "Three/A.pdf");
		await expectOpens(v, "Two/B.pdf", b, ["ink-1"]);
	});

	it("a stroke drawn on a tied open's blank instance stays, and retirement still pairs nothing for the tied ink", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		await s.createFile("Two/B.pdf");
		const opened = await s.open("Two/A.pdf");
		expect(opened.id, "Two/A.pdf took A's ink while Three/A.pdf ties it").not.toBe(a);
		expect(opened.id).not.toBe(b);
		s.draw(opened.id, stroke(70, "blank-ink"));
		await s.store.flush();
		expect(v.sidecar(opened.id)?.pdfPaths, "precondition: the blank instance's claim is on disk").toEqual(["Two/A.pdf"]);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths, "A's ink moved to the other tied file by elimination").toBeUndefined();
		expect(v.inTrash(a)).toBe(true);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["Two/B.pdf"]);
		expect(v.sidecar(opened.id)?.pdfPaths).toEqual(["Two/A.pdf"]);
		expect(v.sidecar(opened.id)?.strokes.map((x) => x.id)).toEqual(["blank-ink"]);
		await expectOpens(v, "Two/A.pdf", opened.id, ["blank-ink"]);
		await expectBlank(v, "Three/A.pdf");
		await expectOpens(v, "Two/B.pdf", b, ["ink-1"]);
	});

	it("a better name that lands after a tied open still takes the tied ink at retirement", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		await s.createFile("Two/B.pdf");
		const opened = await s.open("Two/A.pdf");
		expect(opened.id, "Two/A.pdf took A's ink while Three/A.pdf ties it").not.toBe(a);
		await s.createFile("Z/One/A.pdf");
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths).toEqual(["Z/One/A.pdf"]);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["Two/B.pdf"]);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id), "the open pane").toEqual([]);
		await expectOpens(v, "Z/One/A.pdf", a, ["ink-0"]);
		await expectBlank(v, "Three/A.pdf");
	});

	it("a tied open's hold on its path outlasts a quit inside the grace", async () => {
		const v = vault();
		const { s: first, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"], { pendingStore: true });
		vi.useFakeTimers();
		await first.deleteFile("One/A.pdf");
		await first.deleteFile("One/B.pdf");
		await first.createFile("Two/A.pdf");
		await first.createFile("Three/A.pdf");
		await first.createFile("Two/B.pdf");
		const opened = await first.open("Two/A.pdf");
		expect(opened.id, "Two/A.pdf took A's ink while Three/A.pdf ties it").not.toBe(a);
		first.draw(opened.id, stroke(70, "blank-ink"));
		await first.store.flush();
		// Quit inside the grace: the deletions are saved.
		first.pdfStore.cancelPendingDeletes();
		const next = session(v, { pendingStore: true });
		expect(next.pdfStore.pendingClaims().size, "precondition: both deletions resumed").toBe(2);
		await settleGrace(next);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths, "A's ink moved to the other tied file after the quit").toBeUndefined();
		expect(v.inTrash(a)).toBe(true);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["Two/B.pdf"]);
		await expectOpens(v, "Two/A.pdf", opened.id, ["blank-ink"]);
		await expectBlank(v, "Three/A.pdf");
	});

	it("after a tied open, the other ink opened at its new name leaves the tied ink alone at retirement, and it still pairs nothing", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		await s.createFile("Two/B.pdf");
		const opened = await s.open("Two/A.pdf");
		expect(opened.id, "Two/A.pdf took A's ink while Three/A.pdf ties it").not.toBe(a);
		const openedB = await s.open("Two/B.pdf");
		expect(openedB.id).toBe(b);
		expect(s.pdfStore.pendingClaims().has("One/B.pdf"), "precondition: B's open ended B's deletion").toBe(false);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths, "A's ink, alone in its grace, moved to the other tied file").toBeUndefined();
		expect(v.inTrash(a)).toBe(true);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["Two/B.pdf"]);
		await expectBlank(v, "Two/A.pdf");
		await expectBlank(v, "Three/A.pdf");
	});

	it("with no tied open, the other ink opened first at its new name leaves the tied ink alone at retirement, and it still pairs nothing", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		await s.createFile("Two/B.pdf");
		const openedB = await s.open("Two/B.pdf");
		expect(openedB.id).toBe(b);
		expect(s.pdfStore.pendingClaims().has("One/B.pdf"), "precondition: B's open ended B's deletion").toBe(false);
		expect(s.pdfStore.pendingClaims().has("One/A.pdf"), "precondition: A's deletion is still in its grace").toBe(true);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths, "A's ink, alone in its grace, went to the first tied file in vault order").toBeUndefined();
		expect(v.inTrash(a)).toBe(true);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["Two/B.pdf"]);
		await expectBlank(v, "Two/A.pdf");
		await expectBlank(v, "Three/A.pdf");
	});

	it("after a tied open and the other ink's open, a quit inside the grace: the tied ink still pairs nothing at retirement", async () => {
		const v = vault();
		const { s: first, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"], { pendingStore: true });
		vi.useFakeTimers();
		await first.deleteFile("One/A.pdf");
		await first.deleteFile("One/B.pdf");
		await first.createFile("Two/A.pdf");
		await first.createFile("Three/A.pdf");
		await first.createFile("Two/B.pdf");
		const opened = await first.open("Two/A.pdf");
		expect(opened.id, "Two/A.pdf took A's ink while Three/A.pdf ties it").not.toBe(a);
		const openedB = await first.open("Two/B.pdf");
		expect(openedB.id).toBe(b);
		await first.store.flush();
		// Quit inside the grace: the one deletion left is saved.
		first.pdfStore.cancelPendingDeletes();
		const next = session(v, { pendingStore: true });
		expect([...next.pdfStore.pendingClaims().keys()], "precondition: only A's deletion resumed").toEqual(["One/A.pdf"]);
		await settleGrace(next);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths, "A's ink, alone in its grace after the quit, moved to a tied file").toBeUndefined();
		expect(v.inTrash(a)).toBe(true);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["Two/B.pdf"]);
		await expectBlank(v, "Two/A.pdf");
		await expectBlank(v, "Three/A.pdf");
	});

	it("after a tied open and the other ink's open, the tied ink's old path comes back and goes again inside the grace: it still pairs nothing at retirement", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		await s.createFile("Two/B.pdf");
		const opened = await s.open("Two/A.pdf");
		expect(opened.id, "Two/A.pdf took A's ink while Three/A.pdf ties it").not.toBe(a);
		const openedB = await s.open("Two/B.pdf");
		expect(openedB.id).toBe(b);
		await s.createFile("One/A.pdf");
		await s.deleteFile("One/A.pdf");
		expect([...s.pdfStore.pendingClaims().keys()], "precondition: only A's deletion is in its grace").toEqual(["One/A.pdf"]);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths, "A's ink, deleted again alone in its grace, moved to the other tied file").toBeUndefined();
		expect(v.inTrash(a)).toBe(true);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["Two/B.pdf"]);
		await expectBlank(v, "Two/A.pdf");
		await expectBlank(v, "Three/A.pdf");
	});

	it("one deleted ink and two new files with no second deletion: the first new file in vault order takes the ink, as before", async () => {
		const v = vault();
		const { s, ids: [a] } = await inked(v, ["One/A.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths, "a lone deletion was paired by name").toEqual(["Two/A.pdf"]);
		await expectOpens(v, "Two/A.pdf", a, ["ink-0"]);
		await expectBlank(v, "Three/A.pdf");
	});

	/** Another device renamed the PDF and its ink file synced in: the file now claims `claims`, its ink unchanged. */
	function syncClaims(v: ReturnType<typeof vault>, id: string, claims: string[]) {
		const synced = v.sidecar(id)!;
		synced.pdfPaths = claims;
		v.adapter.files.set(`.handwriting/${id}.json`, serializePage(synced));
	}

	/** Every ink file and every file beside it (trash, conflict copies), with its bytes. */
	function inkFolder(v: ReturnType<typeof vault>) {
		return new Map([...v.adapter.files].filter(([p]) => p.startsWith(".handwriting/")));
	}

	/** A pane shows Old with this session's ink; that ink is saved. The record is this session's. */
	async function heldOnOld(v: ReturnType<typeof vault>) {
		v.files.add(OLD);
		const s = session(v);
		const opened = await s.open(OLD);
		s.draw(opened.id, stroke(50, "held-ink"));
		await s.store.flush();
		return { s, id: opened.id };
	}

	it("a record still held for the deleted path does not retire ink whose file already moved on another device", async () => {
		const v = vault();
		v.files.add(OLD);
		const s = session(v);
		// The pane stays open while the delete lands, so this session holds the record.
		const opened = await s.open(OLD);
		s.draw(opened.id, stroke(50, "held-ink"));
		await s.store.flush();
		vi.useFakeTimers();
		// Another device renamed Old to New and its ink file, now claiming New, synced in.
		const synced = v.sidecar(opened.id)!;
		synced.pdfPaths = [NEW];
		v.adapter.files.set(`.handwriting/${opened.id}.json`, serializePage(synced));
		await s.createFile(NEW);
		// Past a create's 90 s, so a recent create is not why the ink stays.
		await vi.advanceTimersByTimeAsync(91_000);
		await s.deleteFile(OLD);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.inTrash(opened.id), "ink whose file moved went to the trash").toBe(false);
		expect(v.sidecar(opened.id)?.pdfPaths).toContain(NEW);
		expect(v.sidecar(opened.id)?.strokes.map((x) => x.id)).toEqual(["held-ink"]);
	});

	it("a record still held for the deleted path retires ink whose file still claims that path alone, as before", async () => {
		const v = vault();
		const { s, id } = await heldOnOld(v);
		vi.useFakeTimers();
		await s.createFile(NEW);
		// Past a create's 90 s, so a recent create is not why the ink stays or goes.
		await vi.advanceTimersByTimeAsync(91_000);
		expect(v.sidecar(id)?.pdfPaths, "precondition: the ink file claims Old alone").toEqual([OLD]);
		await s.deleteFile(OLD);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(id), "the ink file of a PDF deleted for good stayed live").toBeUndefined();
		expect(v.inTrash(id)).toBe(true);
	});

	it("a record still held for the deleted path leaves the moved ink file byte for byte as it synced", async () => {
		const v = vault();
		const { s, id } = await heldOnOld(v);
		vi.useFakeTimers();
		syncClaims(v, id, [NEW]);
		await s.createFile(NEW);
		// Past a create's 90 s, so a recent create is not why the ink stays or goes.
		await vi.advanceTimersByTimeAsync(91_000);
		const before = inkFolder(v);
		await s.deleteFile(OLD);
		await settleGrace(s);
		vi.useRealTimers();
		expect(inkFolder(v), "the retirement wrote, moved or copied the moved ink file").toEqual(before);
	});

	it.each(["unparseable JSON", "a stroke this build cannot decode", "no ink file"] as const)(
		"a record still held for the deleted path, and on disk %s at the retirement",
		async (state) => {
			const v = vault();
			const { s, id } = await heldOnOld(v);
			vi.useFakeTimers();
			const path = `.handwriting/${id}.json`;
			if (state === "unparseable JSON") {
				// A sync client caught writing the file in place.
				v.adapter.files.set(path, v.adapter.files.get(path)!.slice(0, 40));
			} else if (state === "a stroke this build cannot decode") {
				// A newer build on the other device wrote a stroke this one cannot read; the claim itself is readable.
				const raw = JSON.parse(v.adapter.files.get(path)!) as { strokes: Record<string, unknown>[] };
				raw.strokes.push({ ...raw.strokes[0], id: null });
				v.adapter.files.set(path, JSON.stringify(raw));
				expect(parsePage(v.adapter.files.get(path)!, id).damaged, "precondition: the file decodes with loss").toBe(true);
			} else {
				v.adapter.files.delete(path);
			}
			await vi.advanceTimersByTimeAsync(11_000);
			expect(await s.store.readPdfPaths(id), "precondition: the claim cannot be read").toBeNull();
			const before = inkFolder(v);
			await s.deleteFile(OLD);
			await settleGrace(s);
			vi.useRealTimers();
			if (state === "no ink file") {
				expect(inkFolder(v), "nothing on disk to retire, and nothing written").toEqual(new Map());
				expect(s.pdfStore.generation(id), "the record of a PDF deleted for good was kept").toBeNull();
			} else {
				expect(inkFolder(v), "an ink file that could not be read was retired or written").toEqual(before);
			}
		}
	);

	it.each([
		["no longer claims the deleted path", [NEW, "Gone.pdf"]],
		["claims a path the record does not hold", [OLD, NEW, "Gone.pdf"]],
	] as const)("a record holding the deleted path and another does not write its claims over an ink file that %s", async (_case, disk) => {
		const v = vault();
		const { ids: [id] } = await inked(v, [OLD]);
		// The ink file claims Old and a path not in this vault, as a PDF renamed outside Obsidian leaves.
		syncClaims(v, id, [OLD, "Gone.pdf"]);
		const s = session(v);
		const opened = await s.open(OLD);
		expect(opened.id, "precondition: the pane holds that ink, both claims with it").toBe(id);
		vi.useFakeTimers();
		syncClaims(v, id, [...disk]);
		await s.createFile(NEW);
		// Past a create's 90 s, so a recent create is not why the ink stays or goes.
		await vi.advanceTimersByTimeAsync(91_000);
		const before = inkFolder(v);
		await s.deleteFile(OLD);
		await settleGrace(s);
		vi.useRealTimers();
		expect(inkFolder(v), "the stale record's claims were written, or the synced file set aside as a conflict copy").toEqual(before);
	});

	it("a PDF closed while its ink loads keeps a record no pane shows; deleting it later does not retire ink whose file moved on another device", async () => {
		const v = vault();
		const { ids: [id] } = await inked(v, [OLD]);
		const s = session(v);
		// The app's own close: the leaf is gone from the workspace and the sweep releases the id.
		(s.app.workspace as unknown as { getLeavesOfType: () => unknown[] }).getLeavesOfType = () => [];
		const sidecarPath = `.handwriting/${id}.json`;
		const read = v.adapter.read.bind(v.adapter);
		let reached!: () => void;
		const loading = new Promise<void>((r) => (reached = r));
		let landLoad!: () => void;
		const landed = new Promise<void>((r) => (landLoad = r));
		let held = false;
		vi.spyOn(v.adapter, "read").mockImplementation(async (p: string) => {
			// The ink file's load, once the pane has its id: the first read of it after the choice.
			if (p === sidecarPath && !held && s.plugin.pdfIds.size > 0) {
				held = true;
				reached();
				await landed;
			}
			return read(p);
		});
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, unmount() {}, forgetHistory() {}, idle: true };
		s.plugin.pdfFiles.set(root, OLD);
		s.plugin.pdfInk.set(root, controller);
		const resolving = s.plugin.resolvePdfId({ view: { file: { path: OLD } } }, root, controller);
		await loading;
		expect(s.plugin.pdfIds.get(root), "precondition: the pane was given this ink before its load").toBe(id);
		(root as unknown as { isConnected: boolean }).isConnected = false;
		s.plugin.syncPdfControllers();
		expect(s.plugin.pdfIds.size, "precondition: the sweep took the pane's id").toBe(0);
		landLoad();
		await resolving;
		vi.useFakeTimers();
		syncClaims(v, id, [NEW]);
		await s.createFile(NEW);
		// Past a create's 90 s, so a recent create is not why the ink stays or goes.
		await vi.advanceTimersByTimeAsync(91_000);
		expect(s.pdfStore.generation(id), "precondition: the record outlived its pane").not.toBeNull();
		expect(s.plugin.pdfIds.size, "precondition: no pane shows it").toBe(0);
		const before = inkFolder(v);
		await s.deleteFile(OLD);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.inTrash(id), "ink whose file moved went to the trash").toBe(false);
		expect(inkFolder(v), "the retirement wrote, moved or copied the moved ink file").toEqual(before);
		await expectOpens(v, NEW, id, ["ink-0"]);
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

describe("a tied open's blank instance held through the grace", () => {
	it("only a fresh (tied) open pairs over B; A then ends by its old path coming back: B still pairs by name", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		await s.createFile("Two/B.pdf");
		const tied = await s.open("Two/A.pdf");
		expect(tied.id, "precondition: Two/A.pdf ties for A and opens blank").not.toBe(a);
		expect(tied.id).not.toBe(b);
		// A's old path comes back: A's deletion ends with no open and no pairing, so nothing else marks B.
		await s.createFile("One/A.pdf");
		await settleGrace(s);
		vi.useRealTimers();
		const out = `b.pdfPaths=${JSON.stringify(v.sidecar(b)?.pdfPaths)} b.inTrash=${v.inTrash(b)} a.pdfPaths=${JSON.stringify(v.sidecar(a)?.pdfPaths)}`;
		expect(v.sidecar(b)?.pdfPaths, `B, alone, did not pair by name (${out})`).toEqual(["Two/B.pdf"]);
		expect(v.sidecar(a)?.pdfPaths, `A did not stay on its returned path (${out})`).toEqual(["One/A.pdf"]);
	});

	it("a tied open holds Two/C for A and B; B adopts Two/B by name; A retires alone, paired: never onto the held path", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/C.pdf");
		const tied = await s.open("Two/C.pdf");
		expect(tied.id, "precondition: Two/C.pdf ties for A and B and opens blank").not.toBe(a);
		expect(tied.id).not.toBe(b);
		await s.createFile("Two/B.pdf");
		const ob = await s.open("Two/B.pdf");
		expect(ob.id, "precondition: Two/B.pdf pairs B by name and adopts it").toBe(b);
		expect([...s.pdfStore.pendingClaims().keys()], "precondition: only A's deletion is in its grace").toEqual(["One/A.pdf"]);
		await settleGrace(s);
		vi.useRealTimers();
		const out = `a.pdfPaths=${JSON.stringify(v.sidecar(a)?.pdfPaths)} a.inTrash=${v.inTrash(a)} tied.pdfPaths=${JSON.stringify(v.sidecar(tied.id)?.pdfPaths)} tiedStrokes=${JSON.stringify(s.pdfStore.strokes(tied.id).map((k) => k.id))}`;
		expect(v.sidecar(a)?.pdfPaths, `A's ink went onto the path a tied open holds (${out})`).toBeUndefined();
		expect(v.inTrash(a)).toBe(true);
	});
});

describe("the claim read again at retirement", () => {
	const OLD = "Old.pdf";
	const NEW = "New.pdf";
	function syncClaims(v: ReturnType<typeof vault>, id: string, claims: string[]) {
		const synced = v.sidecar(id)!;
		synced.pdfPaths = claims;
		v.adapter.files.set(`.handwriting/${id}.json`, serializePage(synced));
	}
	function inkFolder(v: ReturnType<typeof vault>) {
		return new Map([...v.adapter.files].filter(([p]) => p.startsWith(".handwriting/")));
	}
	async function heldOnOld(v: ReturnType<typeof vault>) {
		v.files.add(OLD);
		const s = session(v);
		const opened = await s.open(OLD);
		s.draw(opened.id, stroke(50, "held-ink"));
		await s.store.flush();
		return { s, id: opened.id };
	}

	it("the file claims only a path the record also holds, not the deleted one: no write", async () => {
		const v = vault();
		const { ids: [id] } = await inked(v, [OLD]);
		syncClaims(v, id, [OLD, "Gone.pdf"]);
		const s = session(v);
		const opened = await s.open(OLD);
		expect(opened.id, "precondition: the pane holds that ink, both claims with it").toBe(id);
		vi.useFakeTimers();
		syncClaims(v, id, ["Gone.pdf"]);
		await s.createFile(NEW);
		// Past a create's 90 s, so a recent create is not why the ink stays or goes.
		await vi.advanceTimersByTimeAsync(91_000);
		const before = inkFolder(v);
		await s.deleteFile(OLD);
		await settleGrace(s);
		vi.useRealTimers();
		const after = inkFolder(v);
		const out = `before=${JSON.stringify([...before.keys()])} after=${JSON.stringify([...after.keys()])} paths=${JSON.stringify(v.sidecar(id)?.pdfPaths)}`;
		expect(after, `the record's claims went over a file that does not claim the deleted path (${out})`).toEqual(before);
	});

	it("a legacy file (claims nothing) and a record held for the deleted path: neither removed nor written", async () => {
		const v = vault();
		const { s, id } = await heldOnOld(v);
		vi.useFakeTimers();
		syncClaims(v, id, []);
		await vi.advanceTimersByTimeAsync(11_000);
		expect(await s.store.readPdfPaths(id), "precondition: the file claims nothing").toEqual([]);
		const before = inkFolder(v);
		await s.deleteFile(OLD);
		await settleGrace(s);
		vi.useRealTimers();
		const after = inkFolder(v);
		const out = `before=${JSON.stringify([...before.keys()])} after=${JSON.stringify([...after.keys()])} inTrash=${v.inTrash(id)}`;
		expect(after, `a legacy ink file was removed or written (${out})`).toEqual(before);
	});
});

/**
 * For a deletion that is paired or has a held path, an open gives a waiting ink to a path where the retirement would,
 * and nowhere else.
 */
describe("an open gives a waiting ink only where its retirement would", () => {
	/** A and B are moved together inside one grace: Two/A.pdf and Three/A.pdf (a tie for A) and Two/B.pdf arrive. */
	async function movedWithTie(s: ReturnType<typeof session>) {
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		await s.createFile("Two/B.pdf");
	}

	/** The end the retirement gives A's tie: A's ink in the trash, both tied files blank, B on its new name. */
	async function expectTieEnd(v: ReturnType<typeof vault>, a: string, b: string) {
		expect(v.sidecar(a), "A's ink file was given a file its tie left to nobody").toBeUndefined();
		expect(v.inTrash(a)).toBe(true);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["Two/B.pdf"]);
		await expectBlank(v, "Two/A.pdf");
		await expectBlank(v, "Three/A.pdf");
	}

	it("after a tied open and the other ink's open, a quit: the tied file opened again in the next session inside the grace is not handed the tied ink", async () => {
		const v = vault();
		const { s: first, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"], { pendingStore: true });
		vi.useFakeTimers();
		await movedWithTie(first);
		const tied = await first.open("Two/A.pdf");
		expect(tied.id, "precondition: Two/A.pdf ties for A and opens blank").not.toBe(a);
		expect((await first.open("Two/B.pdf")).id, "precondition: Two/B.pdf takes B's ink by name").toBe(b);
		await first.store.flush();
		first.pdfStore.cancelPendingDeletes();
		const next = session(v, { pendingStore: true });
		expect([...next.pdfStore.pendingClaims().keys()], "precondition: only A's deletion resumed").toEqual(["One/A.pdf"]);
		const again = await next.open("Two/A.pdf");
		expect(again.id, "Two/A.pdf took A's ink, alone in its grace, though Three/A.pdf ties it").not.toBe(a);
		expect(next.pdfStore.strokes(again.id).map((x) => x.id)).toEqual([]);
		await next.store.flush();
		expect(v.sidecar(a)?.pdfPaths, "A's ink file was moved before its retirement").toEqual(["One/A.pdf"]);
		await settleGrace(next);
		vi.useRealTimers();
		await expectTieEnd(v, a, b);
	});

	it("the tied file's tab closed and opened again inside the grace, after the other ink's open, is not handed the tied ink", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await movedWithTie(s);
		const tied = await s.open("Two/A.pdf");
		expect(tied.id, "precondition: Two/A.pdf ties for A and opens blank").not.toBe(a);
		expect((await s.open("Two/B.pdf")).id, "precondition: Two/B.pdf takes B's ink by name").toBe(b);
		s.close(tied.root);
		s.plugin.releasePdfId(tied.id);
		const again = await s.open("Two/A.pdf");
		expect(again.id, "Two/A.pdf, opened again, took A's ink though Three/A.pdf ties it").not.toBe(a);
		expect(s.pdfStore.strokes(again.id).map((x) => x.id)).toEqual([]);
		await settleGrace(s);
		vi.useRealTimers();
		await expectTieEnd(v, a, b);
	});

	it("with no tied open, the other ink opened first by name; a tied file opened then opens blank and holds its path, and the retirement gives the other tied file nothing", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await movedWithTie(s);
		expect((await s.open("Two/B.pdf")).id, "precondition: Two/B.pdf takes B's ink by name").toBe(b);
		const opened = await s.open("Two/A.pdf");
		expect(opened.id, "Two/A.pdf took A's ink, alone in its grace, though Three/A.pdf ties it").not.toBe(a);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual([]);
		expect(s.pdfStore.heldPaths().get("One/A.pdf")?.has("Two/A.pdf"), "the tied open does not hold its path for A").toBe(true);
		// The pane stays open: its blank claims Two/A.pdf through the grace.
		await settleGrace(s);
		vi.useRealTimers();
		await expectTieEnd(v, a, b);
	});

	it("A and B moved together with no tie, B taken by name first: A's one best new name opened then takes A's ink", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Two/B.pdf");
		const ob = await s.open("Two/B.pdf");
		expect(ob.id, "precondition: Two/B.pdf takes B's ink by name").toBe(b);
		const oa = await s.open("Two/A.pdf");
		expect(oa.id, "Two/A.pdf, A's one best new name, did not take A's ink").toBe(a);
		expect(s.pdfStore.strokes(oa.id).map((x) => x.id)).toEqual(["ink-0"]);
		s.close(ob.root);
		s.close(oa.root);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths).toEqual(["Two/A.pdf"]);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["Two/B.pdf"]);
		expect(v.inTrash(a)).toBe(false);
	});

	it("a tied open, the other ink's open and a quit, then the tied file opened again and a second quit: the third session's retirement reaches the same end", async () => {
		const v = vault();
		const { s: first, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"], { pendingStore: true });
		vi.useFakeTimers();
		await movedWithTie(first);
		expect((await first.open("Two/A.pdf")).id, "precondition: Two/A.pdf ties for A and opens blank").not.toBe(a);
		expect((await first.open("Two/B.pdf")).id, "precondition: Two/B.pdf takes B's ink by name").toBe(b);
		await first.store.flush();
		first.pdfStore.cancelPendingDeletes();
		const second = session(v, { pendingStore: true });
		const again = await second.open("Two/A.pdf");
		expect(again.id, "Two/A.pdf took A's ink in the second session").not.toBe(a);
		await second.store.flush();
		second.pdfStore.cancelPendingDeletes();
		const third = session(v, { pendingStore: true });
		expect([...third.pdfStore.pendingClaims().keys()], "precondition: only A's deletion resumed again").toEqual(["One/A.pdf"]);
		expect(third.pdfStore.heldPaths().get("One/A.pdf")?.has("Two/A.pdf"), "precondition: the hold resumed").toBe(true);
		await settleGrace(third);
		vi.useRealTimers();
		await expectTieEnd(v, a, b);
	});

	/** A's ink file claims One/A.pdf and a second path still in the vault, as a sync can land it; then a fresh session. */
	async function aClaimsALivePathToo() {
		const v = vault();
		const { ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		v.files.add("Keep/X.pdf");
		const synced = v.sidecar(a)!;
		synced.pdfPaths = ["One/A.pdf", "Keep/X.pdf"];
		v.adapter.files.set(`.handwriting/${a}.json`, serializePage(synced));
		const s = session(v);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		return { v, s, a, b };
	}

	it("an ink file claiming one deleted and one live path, and another deleted ink, left alone: the retirement pairs by name and A takes Two/A.pdf", async () => {
		const { v, s, a, b } = await aClaimsALivePathToo();
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths).toEqual(["Keep/X.pdf", "Two/A.pdf"]);
		expect(v.sidecar(b)).toBeUndefined();
		expect(v.inTrash(b)).toBe(true);
	});

	it("the same, Two/A.pdf opened inside the grace: the open names the ink the retirement names, A's", async () => {
		const { v, s, a, b } = await aClaimsALivePathToo();
		const opened = await s.open("Two/A.pdf");
		expect(opened.id, "Two/A.pdf took B's ink by elimination; the retirement pairs A's by name").toBe(a);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual(["ink-0"]);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths).toEqual(["Keep/X.pdf", "Two/A.pdf"]);
		expect(v.sidecar(b)).toBeUndefined();
		expect(v.inTrash(b)).toBe(true);
	});

	/** Keep/X.pdf's open has chosen A's ink and its load is held until `release` is called. */
	async function keepXOpenStillLoading(s: ReturnType<typeof session>) {
		const load = s.store.load.bind(s.store);
		let release: () => void = () => {};
		let reached: () => void = () => {};
		const held = new Promise<void>((r) => (release = r));
		const loading = new Promise<void>((r) => (reached = r));
		let holdOnce = true;
		s.store.load = (async (...args: Parameters<typeof load>) => {
			if (holdOnce) {
				holdOnce = false;
				reached();
				await held;
			}
			return load(...args);
		}) as typeof s.store.load;
		const live = s.open("Keep/X.pdf");
		await loading;
		return { live, release };
	}

	it("the same, with Keep/X.pdf opened first and still loading A's ink when Two/A.pdf opens: the open names the ink the retirement names, A's", async () => {
		const { v, s, a, b } = await aClaimsALivePathToo();
		const { live, release } = await keepXOpenStillLoading(s);
		expect([...s.plugin.pdfIds.values()], "precondition: Keep/X.pdf's open chose A's ink and is still loading it").toEqual([a]);
		const opened = await s.open("Two/A.pdf");
		release();
		const kept = await live;
		expect(opened.id, "Two/A.pdf took B's ink because another pane was still loading A's; the retirement pairs A's by name").toBe(a);
		s.close(kept.root);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths).toEqual(["Keep/X.pdf", "Two/A.pdf"]);
		expect(v.sidecar(b), "B's ink file was kept and given a name").toBeUndefined();
		expect(v.inTrash(b)).toBe(true);
	});

	it("the same, with Keep/X.pdf's open finished before Two/A.pdf opens: the open names A's ink", async () => {
		const { v, s, a, b } = await aClaimsALivePathToo();
		const kept = await s.open("Keep/X.pdf");
		expect(kept.id, "precondition: Keep/X.pdf opens with A's ink").toBe(a);
		const opened = await s.open("Two/A.pdf");
		expect(opened.id, "Two/A.pdf took B's ink; the retirement pairs A's by name").toBe(a);
		s.close(kept.root);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths).toEqual(["Keep/X.pdf", "Two/A.pdf"]);
		expect(v.sidecar(b)).toBeUndefined();
		expect(v.inTrash(b)).toBe(true);
	});

	it("a plain single deletion, never paired: its open adopts and still lists and reads no other path", async () => {
		const v = vault();
		const { s, ids: [a] } = await inked(v, ["One/A.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		const listed = vi.spyOn(s.app.vault, "getFiles");
		const reads = vi.spyOn(s.app.vault, "readBinary");
		const context = vi.spyOn(s.plugin, "pdfDeleteContext");
		const ids = vi.spyOn(s.store, "listIds");
		const opened = await s.open("Two/A.pdf");
		vi.useRealTimers();
		expect(opened.id).toBe(a);
		expect(listed, "the open listed the vault's PDFs").not.toHaveBeenCalled();
		expect(context, "the open built a delete context").not.toHaveBeenCalled();
		expect(reads.mock.calls.map(([f]) => f.path).filter((p) => p !== "Two/A.pdf"), "the open read another PDF").toEqual([]);
		expect(ids.mock.calls.map(([prefix]) => prefix).filter((p) => p === "pdf-"), "the open read every family's ink files").toEqual([]);
	});
});

/**
 * A path whose content cannot be read decides nothing at an open, as at the retirement. Where leaving it in or out
 * would change who gets the file, the file opens blank and holds nothing, and the retirement decides.
 */
describe("a new PDF that cannot be read at an open decides nothing there", () => {
	/** `path` cannot be read at its first read; after that it reads as another document. */
	function unreadableOnceThenOther(s: ReturnType<typeof session>, path: string) {
		const readBinary = s.app.vault.readBinary;
		let failed = 0;
		s.app.vault.readBinary = async (file: { path: string }) => {
			if (file.path !== path) return readBinary(file);
			if (failed++ === 0) throw new Error("mid-sync");
			return new TextEncoder().encode("%PDF-1.4\n% another document\n" + "y".repeat(6000) + "\n%%EOF\n").buffer;
		};
		return () => failed;
	}

	it("Three/S.pdf ties A and B; Z/Two/S.pdf, unreadable once and really another document, would take B by name if it were this one: Three/S.pdf opens blank and holds nothing", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/S.pdf", "Two/S.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/S.pdf");
		await s.deleteFile("Two/S.pdf");
		await s.createFile("Three/S.pdf");
		await s.createFile("Z/Two/S.pdf");
		const reads = unreadableOnceThenOther(s, "Z/Two/S.pdf");
		const opened = await s.open("Three/S.pdf");
		vi.useRealTimers();
		expect(reads(), "precondition: the open tried to read Z/Two/S.pdf").toBeGreaterThan(0);
		expect(opened.id, "an unreadable path, counted as this document, gave Three/S.pdf A's ink").not.toBe(a);
		expect(opened.id).not.toBe(b);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual([]);
		expect([...s.pdfStore.heldPaths()], "Three/S.pdf is held for a tie an unreadable path made").toEqual([]);
	});

	it("a tie made by an unreadable path holds nothing, so once the path reads as another document and the blank is closed, the retirement gives A its one best name", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		const reads = unreadableOnceThenOther(s, "Three/A.pdf");
		const opened = await s.open("Two/A.pdf");
		expect(reads(), "precondition: the open tried to read Three/A.pdf").toBeGreaterThan(0);
		expect(opened.id, "precondition: in or out, the unreadable path changes who gets Two/A.pdf: it opens blank").not.toBe(a);
		s.close(opened.root);
		s.plugin.releasePdfId(opened.id);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths, "A's ink was kept off its one best name by a hold an unreadable path made").toEqual(["Two/A.pdf"]);
		expect(v.inTrash(b)).toBe(true);
		await expectOpens(v, "Two/A.pdf", a, ["ink-0"]);
	});

	it("an unreadable path that cannot change the answer (it ties nothing and takes nothing from Two/A.pdf): the open still pairs by name and takes A's ink", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Two/B.pdf");
		await s.createFile("X/q.pdf");
		const reads = unreadableOnceThenOther(s, "X/q.pdf");
		const opened = await s.open("Two/A.pdf");
		vi.useRealTimers();
		expect(reads(), "precondition: the open tried to read X/q.pdf").toBeGreaterThan(0);
		expect(opened.id, "an unreadable path that cannot change the pairing stopped A's ink").toBe(a);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual(["ink-0"]);
		expect(b).not.toBe(a);
	});
});

/**
 * What is new for a deferred deletion is fixed when its retirement first defers: every path new then stays offered,
 * read or not, and under a later name a vault rename gives it; a path created after is not new for it, at a retry
 * or at an open. The retry runs without a relaunch, retires no ink
 * while an offered path is unread, its delay doubles from 10 s to a ceiling of 5 min, it stops at unload, and the
 * freeze is saved. Both roads, the open and the retirement, single and paired, use the same rule.
 */
describe("a deferred deletion is tried again without a relaunch, offered what was new when it deferred", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** Advance the clock, then let every retirement it started finish and every write land. */
	async function advance(s: ReturnType<typeof session>, ms: number) {
		await vi.advanceTimersByTimeAsync(ms);
		await (s.pdfStore as unknown as { retiring: Promise<void> }).retiring;
		await s.store.flush();
	}

	/** Past the grace: the first retirement runs. */
	const GRACE = 10_001;
	/** Past the longest retry delay: a retry runs, wherever the doubling stands. */
	const RETRY = 300_001;

	/**
	 * `path` cannot be read until `readable()`; after that it reads as this document ("same") or another ("other").
	 * `reads()` gives the clock at every read of it.
	 */
	function unreadableUntil(s: ReturnType<typeof session>, path: string, as: "same" | "other") {
		const readBinary = s.app.vault.readBinary;
		let blocked = true;
		const at: number[] = [];
		s.app.vault.readBinary = async (file: { path: string }) => {
			if (file.path !== path) return readBinary(file);
			at.push(Date.now());
			if (blocked) throw new Error("mid-sync");
			if (as === "same") return readBinary(file);
			return new TextEncoder().encode("%PDF-1.4\n% another document\n" + "y".repeat(6000) + "\n%%EOF\n").buffer;
		};
		return {
			readable: () => {
				blocked = false;
			},
			reads: () => at,
		};
	}

	/** A's file deleted and its new name Two/A.pdf landed, unreadable; the grace runs out and the retirement defers. */
	async function aDeferredOnItsNewName(opts: { pendingStore?: boolean } = {}) {
		const v = vault();
		const { s, ids: [a] } = await inked(v, ["One/A.pdf"], opts);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.createFile("Two/A.pdf");
		const two = unreadableUntil(s, "Two/A.pdf", "same");
		await advance(s, GRACE);
		expect(two.reads().length, "precondition: the retirement tried Two/A.pdf").toBe(1);
		expect([...s.pdfStore.pendingClaims().keys()], "precondition: A's deletion deferred").toEqual(["One/A.pdf"]);
		expect(v.sidecar(a)?.pdfPaths, "precondition: A's ink file untouched").toEqual(["One/A.pdf"]);
		return { v, s, a, two };
	}

	it("A, B and an unrelated U: A and B moved together while U, new and unrelated, cannot be read; once U reads, the retry without a relaunch puts each ink on its new name", async () => {
		const v = vault();
		const { s, ids: [a, b] } = await inked(v, ["One/A.pdf", "One/B.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/A.pdf");
		await s.deleteFile("One/B.pdf");
		await s.createFile("Two/A.pdf");
		await s.createFile("Two/B.pdf");
		await s.createFile("U/u.pdf");
		const u = unreadableUntil(s, "U/u.pdf", "other");
		await advance(s, GRACE);
		expect(u.reads().length, "precondition: both retirements tried U").toBe(2);
		expect([...s.pdfStore.pendingClaims().keys()].sort(), "precondition: both deferred on U").toEqual(["One/A.pdf", "One/B.pdf"]);
		expect(v.sidecar(a)?.pdfPaths).toEqual(["One/A.pdf"]);
		expect(v.sidecar(b)?.pdfPaths).toEqual(["One/B.pdf"]);
		u.readable();
		await advance(s, RETRY);
		expect(v.sidecar(a)?.pdfPaths, "A's ink is not on its new name after U read").toEqual(["Two/A.pdf"]);
		expect(v.sidecar(b)?.pdfPaths, "B's ink is not on its new name after U read").toEqual(["Two/B.pdf"]);
		expect([...s.pdfStore.pendingClaims().keys()]).toEqual([]);
		vi.useRealTimers();
		expect(v.inTrash(a)).toBe(false);
		expect(v.inTrash(b)).toBe(false);
		await expectOpens(v, "Two/A.pdf", a, ["ink-0"]);
		await expectOpens(v, "Two/B.pdf", b, ["ink-1"]);
	});

	/**
	 * X deleted for good and deferred on an unrelated U it cannot read, and still waiting after its first retry; U
	 * then reads; a sync renames C to D (delete, create), so C's retirement comes before X's second retry.
	 */
	async function xDeferredThenCToD() {
		const v = vault();
		const { s, ids: [x, c] } = await inked(v, ["One/X.pdf", "One/C.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/X.pdf");
		await s.createFile("U/u.pdf");
		const u = unreadableUntil(s, "U/u.pdf", "other");
		await advance(s, GRACE);
		expect(u.reads().length, "precondition: X's retirement tried U").toBe(1);
		expect([...s.pdfStore.pendingClaims().keys()], "precondition: X deferred on U").toEqual(["One/X.pdf"]);
		await advance(s, 10_000);
		expect([...s.pdfStore.pendingClaims().keys()], "precondition: X still waits on U after its first retry").toEqual(["One/X.pdf"]);
		u.readable();
		await s.deleteFile("One/C.pdf");
		await s.createFile("One/D.pdf");
		return { v, s, x, c };
	}

	it("C renamed to D after X deferred, at an open: D, made after X deferred, is not new for X; opened inside C's grace it takes C's ink", async () => {
		const { v, s, x, c } = await xDeferredThenCToD();
		const opened = await s.open("One/D.pdf");
		expect(opened.id, "D tied C's ink with X's, though D was made after X deferred").toBe(c);
		expect(s.pdfStore.strokes(opened.id).map((k) => k.id)).toEqual(["ink-1"]);
		s.close(opened.root);
		await advance(s, RETRY);
		vi.useRealTimers();
		expect(v.sidecar(c)?.pdfPaths).toEqual(["One/D.pdf"]);
		expect(v.inTrash(c)).toBe(false);
		// X had no new name: deleted for good, its ink goes to the trash at the retry.
		expect(v.sidecar(x)).toBeUndefined();
		expect(v.inTrash(x)).toBe(true);
	});

	it("C renamed to D after X deferred, at the retirement: D is not opened; C's retirement gives C's ink to D, nothing tied, nothing of C's trashed", async () => {
		const { v, s, x, c } = await xDeferredThenCToD();
		await advance(s, RETRY);
		vi.useRealTimers();
		expect(v.sidecar(c)?.pdfPaths, "C's retirement tied D with X, though D was made after X deferred").toEqual(["One/D.pdf"]);
		expect(v.inTrash(c)).toBe(false);
		expect(v.sidecar(x)).toBeUndefined();
		expect(v.inTrash(x)).toBe(true);
		await expectOpens(v, "One/D.pdf", c, ["ink-1"]);
	});

	it("the single road's twin, at an open: a same-bytes copy made after A deferred opens blank; A's new name, once it reads, takes A's ink at the retry", async () => {
		const { v, s, a, two } = await aDeferredOnItsNewName();
		await s.createFile("Copy/A.pdf");
		const copy = await s.open("Copy/A.pdf");
		expect(copy.id, "a copy made after the defer took A's ink").not.toBe(a);
		expect(s.pdfStore.strokes(copy.id).map((k) => k.id)).toEqual([]);
		s.close(copy.root);
		s.plugin.releasePdfId(copy.id);
		two.readable();
		await advance(s, RETRY);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths, "A's ink is not on its new name after it read").toEqual(["Two/A.pdf"]);
		expect(v.inTrash(a)).toBe(false);
		await expectOpens(v, "Two/A.pdf", a, ["ink-0"]);
		await expectBlank(v, "Copy/A.pdf");
	});

	it("the single road's twin, at the retry: a same-bytes copy made after A deferred is not new for A; while A's new name still cannot be read the retry moves and trashes nothing, and once it reads A's ink goes there", async () => {
		const { v, s, a, two } = await aDeferredOnItsNewName();
		await s.createFile("Copy/A.pdf");
		await advance(s, RETRY);
		expect(two.reads().length, "no retry ran without a relaunch").toBeGreaterThan(1);
		expect(v.sidecar(a)?.pdfPaths, "the retry gave A's ink to a copy made after the defer").toEqual(["One/A.pdf"]);
		expect([...s.pdfStore.pendingClaims().keys()]).toEqual(["One/A.pdf"]);
		expect(v.inTrash(a)).toBe(false);
		two.readable();
		await advance(s, RETRY);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths).toEqual(["Two/A.pdf"]);
		expect(v.inTrash(a)).toBe(false);
		await expectBlank(v, "Copy/A.pdf");
	});

	it("a quit between the defer and the retry: the freeze is saved; a same-bytes copy made while the app was closed is not new for A in the next session, and A's new name takes A's ink once it reads", async () => {
		const { v, s: first, a } = await aDeferredOnItsNewName({ pendingStore: true });
		first.pdfStore.cancelPendingDeletes();
		v.files.add("Copy/A.pdf");
		const next = session(v, { pendingStore: true });
		expect([...next.pdfStore.pendingClaims().keys()], "precondition: A's deletion resumed").toEqual(["One/A.pdf"]);
		const two = unreadableUntil(next, "Two/A.pdf", "same");
		await advance(next, GRACE);
		expect(two.reads().length, "precondition: the next session's retirement tried Two/A.pdf").toBe(1);
		expect(v.sidecar(a)?.pdfPaths, "the next session gave A's ink to a copy made after the defer").toEqual(["One/A.pdf"]);
		expect(v.inTrash(a)).toBe(false);
		two.readable();
		await advance(next, RETRY);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths).toEqual(["Two/A.pdf"]);
		await expectBlank(v, "Copy/A.pdf");
	});

	it("a vault rename of a path new for A at its defer carries it: A's new name renamed again before the retry takes A's ink under its later name", async () => {
		const { v, s, a, two } = await aDeferredOnItsNewName();
		two.readable();
		await s.renameFile("Two/A.pdf", "Three/A.pdf");
		await advance(s, RETRY);
		vi.useRealTimers();
		expect(v.sidecar(a)?.pdfPaths, "A's ink did not follow its new name's vault rename").toEqual(["Three/A.pdf"]);
		expect(v.inTrash(a)).toBe(false);
		await expectOpens(v, "Three/A.pdf", a, ["ink-0"]);
	});

	it("the retry delay doubles from 10 s to a ceiling of 5 min", async () => {
		const { s, two } = await aDeferredOnItsNewName();
		await advance(s, 910_000);
		const at = two.reads();
		const gaps = at.slice(1).map((t, i) => Math.round((t - at[i]!) / 1000));
		expect(gaps, "seconds between tries of the unread path").toEqual([10, 20, 40, 80, 160, 300, 300]);
	});

	it("a path new for A that never reads: A stays pending through every retry, nothing moved, nothing trashed", async () => {
		const { v, s, a } = await aDeferredOnItsNewName();
		await advance(s, 30 * 60_000);
		vi.useRealTimers();
		expect([...s.pdfStore.pendingClaims().keys()]).toEqual(["One/A.pdf"]);
		expect(v.sidecar(a)?.pdfPaths).toEqual(["One/A.pdf"]);
		expect(v.sidecar(a)?.strokes.map((k) => k.id)).toEqual(["ink-0"]);
		expect(v.inTrash(a)).toBe(false);
	});

	it("unload stops the retry: after the defer and an unload, no try and no write however long", async () => {
		const { v, s, a, two } = await aDeferredOnItsNewName();
		Object.assign(s.plugin, {
			pendingRecycle: new Map(),
			declaimTimers: new Map(),
			applyPaper: () => {},
			finishPersistence: async () => {},
		});
		vi.stubGlobal("document", { body: { classList: { remove() {} } } });
		s.plugin.onunload();
		two.readable();
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		vi.useRealTimers();
		expect(two.reads().length, "a retry ran after unload").toBe(1);
		expect(v.sidecar(a)?.pdfPaths).toEqual(["One/A.pdf"]);
		expect(v.inTrash(a)).toBe(false);
	});

	it("a known gap: a path new for A at its defer, moved again by a sync delete and create before the retry, is not followed: A's ink goes to the trash whole and the later name opens blank", async () => {
		const { v, s, a } = await aDeferredOnItsNewName();
		await s.deleteFile("Two/A.pdf");
		await s.createFile("Three/A.pdf");
		await advance(s, RETRY);
		vi.useRealTimers();
		expect(v.sidecar(a)).toBeUndefined();
		expect(v.inTrash(a)).toBe(true);
		await expectBlank(v, "Three/A.pdf");
	});

	/** X deleted, and its retirement deferred on an unrelated U it cannot read. */
	async function xDeferredOnU() {
		const v = vault();
		const { s, ids: [x] } = await inked(v, ["One/X.pdf"]);
		vi.useFakeTimers();
		await s.deleteFile("One/X.pdf");
		await s.createFile("U/u.pdf");
		const u = unreadableUntil(s, "U/u.pdf", "other");
		await advance(s, GRACE);
		expect(u.reads().length, "precondition: X's retirement tried U").toBe(1);
		expect([...s.pdfStore.pendingClaims().keys()], "precondition: X deferred on U").toEqual(["One/X.pdf"]);
		expect(v.sidecar(x)?.pdfPaths, "precondition: X's ink untouched").toEqual(["One/X.pdf"]);
		return { v, s, x, u };
	}

	/** Before the retry, X's file comes back and a sync moves it (One/X.pdf deleted, Two/X.pdf created); U then reads. */
	async function xBackThenMoved() {
		const r = await xDeferredOnU();
		await r.s.createFile("One/X.pdf");
		await r.s.deleteFile("One/X.pdf");
		await r.s.createFile("Two/X.pdf");
		expect([...r.s.pdfStore.pendingClaims().keys()], "precondition: X's second delete waits").toEqual(["One/X.pdf"]);
		r.u.readable();
		return r;
	}

	it("a deferred PDF's file comes back and a sync moves it before the retry: that second delete is a new one, and X's ink follows the file to Two/X", async () => {
		const { v, s, x } = await xBackThenMoved();
		await advance(s, RETRY);
		vi.useRealTimers();
		expect({ paths: v.sidecar(x)?.pdfPaths, trash: v.inTrash(x) }, "X's ink did not follow its file's move").toEqual({ paths: ["Two/X.pdf"], trash: false });
		await expectOpens(v, "Two/X.pdf", x, ["ink-0"]);
	});

	it("the same, with Two/X opened in the grace: it opens with X's ink", async () => {
		const { s, x } = await xBackThenMoved();
		const opened = await s.open("Two/X.pdf");
		expect(opened.id, "Two/X opened without X's ink").toBe(x);
		expect(s.pdfStore.strokes(opened.id).map((k) => k.id)).toEqual(["ink-0"]);
		s.close(opened.root);
	});

	/** X deferred on U; a same-bytes copy made after the defer; the retries (U still unread) until the copy is past a create's 90 s. */
	async function xDeferredThenCopy() {
		const r = await xDeferredOnU();
		await r.s.createFile("Copy/X.pdf");
		await advance(r.s, GRACE);
		expect(r.u.reads().length, "precondition: the first retry tried U again").toBe(2);
		await advance(r.s, 80_000);
		expect(r.u.reads().length, "precondition: two more retries tried U, 30 s and 70 s after the defer").toBe(4);
		expect([...r.s.pdfStore.pendingClaims().keys()], "precondition: X still waits on U").toEqual(["One/X.pdf"]);
		expect(r.v.sidecar(r.x)?.pdfPaths, "precondition: X's ink untouched after the first retry").toEqual(["One/X.pdf"]);
		return r;
	}

	/** Before the next retry, X's file comes back and goes again, a sync moving it to `moveTo` when named; U then reads. */
	async function xBackAndGone(r: Awaited<ReturnType<typeof xDeferredOnU>>, moveTo?: string) {
		await r.s.createFile("One/X.pdf");
		await r.s.deleteFile("One/X.pdf");
		if (moveTo) await r.s.createFile(moveTo);
		expect([...r.s.pdfStore.pendingClaims().keys()], "precondition: X's second delete waits").toEqual(["One/X.pdf"]);
		r.u.readable();
	}

	it("a same-bytes copy made after X deferred, then X's file back and gone: the copy is not new for that second delete either, and X's ink goes to the trash", async () => {
		const r = await xDeferredThenCopy();
		await xBackAndGone(r);
		await advance(r.s, RETRY);
		vi.useRealTimers();
		expect({ paths: r.v.sidecar(r.x)?.pdfPaths, trash: r.v.inTrash(r.x) }, "a copy made after X deferred took X's ink at the second delete").toEqual({ paths: undefined, trash: true });
		await expectBlank(r.v, "Copy/X.pdf");
	});

	it("the same copy opened in that second delete's grace, once U reads: it opens blank, and X's ink goes to the trash", async () => {
		const r = await xDeferredThenCopy();
		await xBackAndGone(r);
		const copy = await r.s.open("Copy/X.pdf");
		expect(copy.id, "a copy made after X deferred opened with X's ink").not.toBe(r.x);
		expect(r.s.pdfStore.strokes(copy.id).map((k) => k.id)).toEqual([]);
		r.s.close(copy.root);
		r.s.plugin.releasePdfId(copy.id);
		await advance(r.s, RETRY);
		vi.useRealTimers();
		expect({ paths: r.v.sidecar(r.x)?.pdfPaths, trash: r.v.inTrash(r.x) }).toEqual({ paths: undefined, trash: true });
	});

	it("the same, and a sync moves X's file to Two/X: X's ink follows it to Two/X and the copy stays blank", async () => {
		const r = await xDeferredThenCopy();
		await xBackAndGone(r, "Two/X.pdf");
		await advance(r.s, RETRY);
		vi.useRealTimers();
		expect({ paths: r.v.sidecar(r.x)?.pdfPaths, trash: r.v.inTrash(r.x) }, "X's ink did not follow its file's move past the copy").toEqual({ paths: ["Two/X.pdf"], trash: false });
		await expectOpens(r.v, "Two/X.pdf", r.x, ["ink-0"]);
		await expectBlank(r.v, "Copy/X.pdf");
	});

	it("A deferred on its own new name, unread past a grace; A's old file back and gone: the new name stays new for that second delete, and once it reads A's ink goes there", async () => {
		const { v, s, a, two } = await aDeferredOnItsNewName();
		await advance(s, GRACE);
		expect(two.reads().length, "precondition: the first retry tried Two/A.pdf again").toBe(2);
		await s.createFile("One/A.pdf");
		await s.deleteFile("One/A.pdf");
		expect([...s.pdfStore.pendingClaims().keys()], "precondition: A's second delete waits").toEqual(["One/A.pdf"]);
		two.readable();
		await advance(s, RETRY);
		vi.useRealTimers();
		expect({ paths: v.sidecar(a)?.pdfPaths, trash: v.inTrash(a) }, "A's ink did not follow to its new name").toEqual({ paths: ["Two/A.pdf"], trash: false });
		await expectOpens(v, "Two/A.pdf", a, ["ink-0"]);
	});
});
