/**
 * A deleted PDF's ink whose move into the trash fails at the end of the grace.
 *
 * After the grace a deleted PDF's ink that claims nothing else goes to the trash, so that no later copy of the same
 * bytes adopts it. The move can fail (a sync tool or a virus scanner holding the file, a storage card gone): the page
 * store logs that and resolves, and the ink file stays live, still claiming the deleted name. Taken as gone then, the
 * deletion ended and nothing tried again; the next same-bytes PDF opened anywhere in the vault adopted the orphan and
 * opened wearing the deleted PDF's ink. The deletion must stay waiting, and saved, until the file has left.
 *
 * Through the plugin and the real stores, with an in-memory vault (the same harness as PdfInkOlderBuildDeletes.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every notice shown, in order. */
const shown = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			shown.push(message);
		}
	},
}));

import HandwritingPlugin from "../main";
import { TFile, Notice } from "obsidian";
import pluginSettingsSource from "../settings/PluginSettings.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { parsePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

/** The PDF that is deleted. */
const NAME = "Form.pdf";
/** A same-bytes PDF that comes into the vault after the delete, at another path. */
const OTHER = "Downloads/Form.pdf";
/** Where this device keeps the deletions in their grace across a restart. */
const PENDING_KEY = "handwriting-pdf-pending-deletes";
const CARRIED_NOTICE = "Handwriting: this PDF changed on disk. Your ink was carried over to its new version.";

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
	shown.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
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
	const pdfBytes = new TextEncoder().encode(
		"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "x".repeat(5000) + "\n%%EOF\n"
	);
	const files = new Set<string>();
	/** This device's local storage, which outlives a plugin session. */
	const local = new Map<string, unknown>();
	function sidecar(id: string) {
		const bytes = adapter.files.get(`.handwriting/${id}.json`);
		return bytes === undefined ? undefined : parsePage(bytes, id).data;
	}
	/** The strokes of every ink file in the trash, one list per file. */
	function trashInk(): string[][] {
		return [...adapter.files.entries()]
			.filter(([p]) => p.includes("/trash/"))
			.map(([p, bytes]) => parsePage(bytes, p).data.strokes.map((s) => s.id));
	}
	/** The deletions this device has saved as waiting, by path. */
	function savedWaiting(): string[] {
		const raw = local.get(PENDING_KEY);
		if (raw === undefined) return [];
		return (JSON.parse(raw as string) as { path: string }[]).map((e) => e.path);
	}
	return { adapter, pdfBytes, files, local, sidecar, trashInk, savedWaiting };
}

function pdfFile(path: string) {
	return Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	});
}

/** A plugin session (fresh memory) over the shared vault, restoring and saving deletions in their grace as at load. */
function session(v: ReturnType<typeof vault>) {
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
		workspace: { layoutReady: true },
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
	/** The plugin quits: what is queued is written, and the deletions in their grace stop here (they stay saved). */
	async function quit() {
		await store.flush();
		plugin.unloaded = true;
		pdfStore.cancelPendingDeletes();
	}
	return { store, pdfStore, plugin, open, close, draw, deleteFile, createFile, quit };
}

/** NAME, inked in one session and closed again: its ink file claims NAME only. */
async function inkedName(v: ReturnType<typeof vault>) {
	v.files.add(NAME);
	const s = session(v);
	const o = await s.open(NAME);
	s.draw(o.id, stroke(10, "ink-0"));
	await s.store.flush();
	s.close(o.root);
	await s.quit();
	expect(v.sidecar(o.id)?.pdfPaths, "precondition: the ink file claims the name only").toEqual([NAME]);
	return o.id;
}

/** The vault's rename of `id`'s live ink file into the ink trash fails `times` times; every other rename works. */
function trashMoveFails(v: ReturnType<typeof vault>, id: string, times = 1) {
	const rename = v.adapter.rename.bind(v.adapter);
	const state = { left: times, failed: 0 };
	v.adapter.rename = async (from: string, to: string) => {
		if (state.left > 0 && from === `.handwriting/${id}.json` && to.includes("/trash/")) {
			state.left--;
			state.failed++;
			throw new Error("the ink file could not be moved to the trash");
		}
		return rename(from, to);
	};
	vi.spyOn(console, "error").mockImplementation(() => {});
	return state;
}

/**
 * A same-bytes PDF at OTHER, opened in session `s`: it is blank and no carried notice shows. With the deleted PDF's ink
 * file still live (`live`), it is on another ink file; once that file left, a blank may take its freed id again.
 */
async function opensBlankElsewhere(s: ReturnType<typeof session>, deleted: string, when: string, live = true) {
	const o = await s.open(OTHER);
	if (live) expect.soft(o.id, `${when}: the same-bytes PDF opened on the deleted PDF's ink file`).not.toBe(deleted);
	expect.soft(s.pdfStore.strokes(o.id).map((x) => x.id), `${when}: the same-bytes PDF opened wearing the deleted PDF's ink`).toEqual([]);
	expect.soft(shown, `${when}: a carried notice showed`).not.toContain(CARRIED_NOTICE);
	s.close(o.root);
}

describe("a deleted PDF's ink whose move into the trash fails at the end of the grace", () => {
	it("nothing queued: the deletion stays waiting and saved, a same-bytes PDF opened at another path is blank on another ink file, the same after the next launch; once the move lands the ink is in the trash whole", async () => {
		const v = vault();
		const deleted = await inkedName(v);
		const s = session(v);
		const fail = trashMoveFails(v, deleted);
		vi.useFakeTimers();
		await s.deleteFile(NAME);
		await vi.advanceTimersByTimeAsync(10_001);
		await s.store.flush();
		expect(fail.failed, "precondition: the move into the trash failed").toBe(1);
		expect(s.store.hasQueuedWrite(deleted), "precondition: nothing is queued for the ink").toBe(false);
		expect(v.sidecar(deleted)?.pdfPaths, "precondition: the ink file is still live, claiming the deleted name").toEqual([NAME]);
		expect.soft(s.pdfStore.pendingClaims().has(NAME), "the deletion ended with the ink file still live").toBe(true);
		expect.soft(v.savedWaiting(), "the deletion is not saved as waiting").toContain(NAME);
		await s.createFile(OTHER);
		await opensBlankElsewhere(s, deleted, "in the session");
		await s.quit();
		vi.useRealTimers();

		// The launch arms each restored deletion's grace, so the clock it is armed on is the one advanced below.
		vi.useFakeTimers();
		const next = session(v);
		expect.soft(next.pdfStore.pendingClaims().has(NAME), "after the launch, the deletion is not waiting").toBe(true);
		await opensBlankElsewhere(next, deleted, "after the launch");
		// Every grace and retry run out; the move now lands.
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		await vi.waitFor(() => expect(next.pdfStore.pendingClaims().size).toBe(0));
		await next.store.flush();
		vi.useRealTimers();
		expect(v.sidecar(deleted), "the deleted PDF's ink file is still live once the move landed").toBeUndefined();
		expect(v.trashInk(), "the deleted PDF's ink is not in the trash whole").toContainEqual(["ink-0"]);
		expect(v.savedWaiting(), "the deletion is still saved once it ended").not.toContain(NAME);
	});

	it("a stroke queued at the end of the grace: the queued page goes to the trash, the live move fails; the deletion stays waiting and saved, a same-bytes PDF opened at another path is blank on another ink file, the same after the next launch", async () => {
		const v = vault();
		const deleted = await inkedName(v);
		const s = session(v);
		vi.useFakeTimers();
		await s.deleteFile(NAME);
		// The record read and a stroke put on it inside the save delay of the grace's end, so the save is queued at the
		// move into the trash.
		await s.pdfStore.ensureLoaded(deleted);
		await vi.advanceTimersByTimeAsync(9_800);
		s.draw(deleted, stroke(30, "late"));
		const fail = trashMoveFails(v, deleted);
		await vi.advanceTimersByTimeAsync(300);
		await vi.waitFor(() => expect(fail.failed, "precondition: the live move into the trash failed").toBe(1));
		expect(v.trashInk(), "precondition: the queued page went to the trash").toContainEqual(["ink-0", "late"]);
		expect(s.store.hasQueuedWrite(deleted), "precondition: the queued page is not queued again").toBe(false);
		expect(v.sidecar(deleted)?.pdfPaths, "precondition: the ink file is still live, claiming the deleted name").toEqual([NAME]);
		expect.soft(s.pdfStore.pendingClaims().has(NAME), "the deletion ended with the ink file still live").toBe(true);
		expect.soft(v.savedWaiting(), "the deletion is not saved as waiting").toContain(NAME);
		await s.createFile(OTHER);
		await opensBlankElsewhere(s, deleted, "in the session");
		await s.quit();
		vi.useRealTimers();

		// The launch arms each restored deletion's grace, so the clock it is armed on is the one advanced below.
		vi.useFakeTimers();
		const next = session(v);
		expect.soft(next.pdfStore.pendingClaims().has(NAME), "after the launch, the deletion is not waiting").toBe(true);
		await opensBlankElsewhere(next, deleted, "after the launch");
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		await vi.waitFor(() => expect(next.pdfStore.pendingClaims().size).toBe(0));
		await next.store.flush();
		vi.useRealTimers();
		expect(v.sidecar(deleted), "the deleted PDF's ink file is still live once the move landed").toBeUndefined();
		expect(v.savedWaiting(), "the deletion is still saved once it ended").not.toContain(NAME);
	});

	it("control: the move lands: the deletion ends at the grace's end, the ink in the trash whole, nothing saved, a same-bytes PDF opens blank", async () => {
		const v = vault();
		const deleted = await inkedName(v);
		const s = session(v);
		vi.useFakeTimers();
		await s.deleteFile(NAME);
		await vi.advanceTimersByTimeAsync(10_001);
		await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size, "the deletion did not end once the move landed").toBe(0));
		await s.store.flush();
		expect(v.sidecar(deleted), "the deleted PDF's ink file is still live").toBeUndefined();
		expect(v.trashInk(), "the deleted PDF's ink is not in the trash whole").toContainEqual(["ink-0"]);
		expect(v.savedWaiting(), "the deletion is still saved once it ended").not.toContain(NAME);
		await s.createFile(OTHER);
		await opensBlankElsewhere(s, deleted, "after the deletion", false);
		vi.useRealTimers();
	});
});
