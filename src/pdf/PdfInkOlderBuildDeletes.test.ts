/**
 * Ink files and waiting deletions left by an older build, met by this one after an update.
 *
 * An older build saved a deletion still in its grace with every path the vault listed at the delete, and that list
 * could hold the deleted name itself. Read by this build, that list must not turn the PDF's return to its name into
 * "another file was renamed onto it": the ink stays on the name, as the older build kept it.
 *
 * An ink file from before path claims claims nothing. Adopted by an open and then deleted before the adoption's
 * claim reached the disk, it must not be left on disk claiming nothing, where any copy of the same bytes adopts it:
 * the file is still the one the record was read from, so it goes to the trash whole. A file that claims nothing
 * because another device's revision synced in is left as it is (PdfIdentityRouting.test.ts, "the claim read again
 * at retirement").
 *
 * Through the plugin and the real stores, with an in-memory vault (the same harness as
 * PdfRenameOntoDeletedName.test.ts).
 */
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
import { FakeAdapter, gate } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

/** The PDF that was deleted. */
const NAME = "Form.pdf";
/** A same-bytes copy that is in the vault throughout. */
const COPY = "Form copy.pdf";
/** Another same-bytes PDF in the vault. */
const OTHER = "Form other.pdf";
/** Where this device keeps the deletions in their grace across a restart. */
const PENDING_KEY = "handwriting-pdf-pending-deletes";

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
	// Every PDF here holds the same bytes: "Make a copy" of one file.
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
	return { adapter, pdfBytes, files, local, sidecar, trashInk };
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
 * the plugin's own registrations. `pendingStore` restores and saves deletions
 * in their grace the way the plugin does at load.
 */
function session(v: ReturnType<typeof vault>, opts: { pendingStore?: boolean } = {}) {
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
	// The rename handler starts the no-pane claim move in the background. The move itself runs unchanged; it is
	// only kept here, so a rename can be waited for.
	const moves: Promise<void>[] = [];
	const moveClaim = HandwritingPlugin.prototype.movePdfClaimOnRename;
	plugin.movePdfClaimOnRename = (file: TFile, oldPath: string) => {
		const move = moveClaim.call(plugin, file, oldPath);
		moves.push(move);
		return move;
	};
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
	/** The vault moves the file, then every rename handler the plugin registered runs, and any claim move it started. */
	async function renameFile(from: string, to: string) {
		expect(v.files.has(from), `precondition: ${from} exists before the rename`).toBe(true);
		expect(vaultOn.get("rename")?.length, "precondition: the plugin listens for renames").toBeGreaterThan(0);
		v.files.delete(from);
		v.files.add(to);
		for (const handler of vaultOn.get("rename") ?? []) await handler(pdfFile(to), from);
		await Promise.all(moves.splice(0));
	}
	return { store, pdfStore, plugin, open, close, draw, deleteFile, createFile, renameFile };
}

/** A later session opens `path` and finds `id` with exactly this ink. */
async function expectOpens(v: ReturnType<typeof vault>, path: string, id: string, ink: string[]) {
	const s = session(v);
	const opened = await s.open(path);
	expect(opened.id, `${path} opened another ink file`).toBe(id);
	expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual(ink);
}

/** A later session opens `path` and finds it blank. */
async function expectBlank(v: ReturnType<typeof vault>, path: string) {
	const s = session(v);
	const opened = await s.open(path);
	expect(s.pdfStore.strokes(opened.id).map((x) => x.id), `${path} opened wearing ink`).toEqual([]);
}

/** NAME, inked in one session and closed again: its ink file claims NAME only. */
async function inkedName(v: ReturnType<typeof vault>) {
	v.files.add(NAME);
	const s = session(v);
	const o = await s.open(NAME);
	s.draw(o.id, stroke(10, "ink-0"));
	await s.store.flush();
	s.close(o.root);
	expect(v.sidecar(o.id)?.pdfPaths, "precondition: the ink file claims the name only").toEqual([NAME]);
	return o.id;
}

/** Run every grace out and let each retirement finish. */
async function settleGrace(s: ReturnType<typeof session>) {
	await vi.advanceTimersByTimeAsync(10_001);
	await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
	await s.store.flush();
}

/** An older build's waiting deletion of NAME, saved with these paths as the ones that existed at the delete. */
function savedByOlderBuild(v: ReturnType<typeof vault>, existingPaths: string[]) {
	v.local.set(PENDING_KEY, JSON.stringify([{ path: NAME, existingPaths }]));
}

/** A session that resumes the saved deletion of NAME, with COPY counted as existing at the delete. */
function resumed(v: ReturnType<typeof vault>) {
	const s = session(v, { pendingStore: true });
	expect(s.pdfStore.pendingClaims().get(NAME)?.has(COPY), "precondition: the deletion resumed, COPY existing at it").toBe(true);
	return s;
}

describe("a waiting deletion an older build saved while the vault still listed the deleted name", () => {
	it("the PDF is back at its name, nothing opens it: the grace runs out with the ink still on the name and nothing in the trash", async () => {
		const v = vault();
		v.files.add(COPY);
		const deleted = await inkedName(v);
		savedByOlderBuild(v, [NAME, COPY]);
		vi.useFakeTimers();
		const s = resumed(v);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.trashInk(), "the ink of a PDF back at its name went to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths, "the ink file no longer claims the name").toEqual([NAME]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
	});

	it("the PDF is back at its name and opened inside the grace: it opens with its own ink, and that ink stays on the name", async () => {
		const v = vault();
		v.files.add(COPY);
		const deleted = await inkedName(v);
		savedByOlderBuild(v, [NAME, COPY]);
		vi.useFakeTimers();
		const s = resumed(v);
		const o = await s.open(NAME);
		expect(o.id, "the name opened another ink file").toBe(deleted);
		expect(s.pdfStore.strokes(o.id).map((x) => x.id), "the name opened without its ink").toEqual(["ink-0"]);
		s.close(o.root);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.trashInk(), "the ink of a PDF back at its name went to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths, "the ink file no longer claims the name").toEqual([NAME]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
	});

	it("the PDF comes back to its name by a create inside the grace (a sync delete then create): the ink keeps the name, nothing goes to the trash", async () => {
		const v = vault();
		v.files.add(COPY);
		const deleted = await inkedName(v);
		v.files.delete(NAME);
		savedByOlderBuild(v, [NAME, COPY]);
		vi.useFakeTimers();
		const s = resumed(v);
		await vi.advanceTimersByTimeAsync(2_000);
		await s.createFile(NAME);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.trashInk(), "a sync delete then create sent ink to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths, "the ink file no longer claims the name").toEqual([NAME]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
	});

	it("CONTROL: the list leaves the deleted name out (the vault had dropped it at the delete), the PDF is back at its name: the ink keeps the name", async () => {
		const v = vault();
		v.files.add(COPY);
		const deleted = await inkedName(v);
		savedByOlderBuild(v, [COPY]);
		vi.useFakeTimers();
		const s = resumed(v);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.trashInk(), "the ink of a PDF back at its name went to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths).toEqual([NAME]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
	});

	it("CONTROL: nothing comes back to the name: after the grace the ink is in the trash whole, and no ink file claims the name", async () => {
		const v = vault();
		v.files.add(COPY);
		const deleted = await inkedName(v);
		v.files.delete(NAME);
		savedByOlderBuild(v, [NAME, COPY]);
		vi.useFakeTimers();
		const s = resumed(v);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(deleted), "the deleted PDF's ink file still claims the name after the grace").toBeUndefined();
		expect(v.trashInk(), "the trash holds the deleted PDF's ink, strokes whole, and nothing else").toEqual([["ink-0"]]);
	});

	it("the list is saved again in this build (another PDF deleted), then a restart: the PDF back at its name still keeps its ink", async () => {
		const v = vault();
		v.files.add(COPY);
		v.files.add(OTHER);
		const deleted = await inkedName(v);
		savedByOlderBuild(v, [NAME, COPY]);
		vi.useFakeTimers();
		const first = resumed(v);
		await vi.advanceTimersByTimeAsync(2_000);
		await first.deleteFile(OTHER);
		const list = JSON.parse(v.local.get(PENDING_KEY) as string) as { path: string }[];
		expect(list.map((e) => e.path).sort(), "precondition: this build saved the list again, both deletions in it").toEqual([NAME, OTHER].sort());
		// Quit inside the grace.
		first.pdfStore.cancelPendingDeletes();
		const next = resumed(v);
		await settleGrace(next);
		vi.useRealTimers();
		expect(v.trashInk(), "the ink of a PDF back at its name went to the trash").toEqual([]);
		expect(v.sidecar(deleted)?.pdfPaths, "the ink file no longer claims the name").toEqual([NAME]);
		await expectOpens(v, NAME, deleted, ["ink-0"]);
	});

	it("CONTROL: a list saved by a build that wrote no mark but did write which ink came with the file renamed onto the name: still read as a rename onto the name", async () => {
		const v = vault();
		v.files.add(NAME);
		v.files.add(COPY);
		const first = session(v, { pendingStore: true });
		const ids: string[] = [];
		for (const [i, p] of [NAME, COPY].entries()) {
			const o = await first.open(p);
			first.draw(o.id, stroke(10 + 10 * i, `ink-${i}`));
			await first.store.flush();
			first.close(o.root);
			ids.push(o.id);
		}
		const [deleted, own] = ids as [string, string];
		expect(deleted, "precondition: each PDF has its own ink file").not.toBe(own);
		vi.useFakeTimers();
		await first.deleteFile(NAME);
		await first.renameFile(COPY, NAME);
		const o = await first.open(NAME);
		expect(o.id, "precondition: the copy opens with its own ink at the name").toBe(own);
		first.close(o.root);
		await first.store.flush();
		// Quit inside the grace, then the list as that build left it: everything this build writes but the mark.
		first.pdfStore.cancelPendingDeletes();
		const list = JSON.parse(v.local.get(PENDING_KEY) as string) as Record<string, unknown>[];
		expect(list, "precondition: one deletion saved").toHaveLength(1);
		expect(list[0]!.existingPaths, "precondition: the deletion's list holds the name").toContain(NAME);
		expect(list[0]!.arrived, "precondition: the copy's ink was saved as come with it").toEqual([own]);
		for (const entry of list) delete entry.onto;
		v.local.set(PENDING_KEY, JSON.stringify(list));
		const next = session(v, { pendingStore: true });
		expect(next.pdfStore.pendingClaims().has(NAME), "precondition: the deletion resumed").toBe(true);
		await settleGrace(next);
		vi.useRealTimers();
		expect(v.sidecar(deleted), "the deleted PDF's ink file still claims the name after the grace").toBeUndefined();
		expect(v.trashInk(), "the trash holds the deleted PDF's ink, strokes whole, and nothing else").toEqual([["ink-0"]]);
		expect(v.sidecar(own)?.pdfPaths).toEqual([NAME]);
		await expectOpens(v, NAME, own, ["ink-1"]);
	});
});

/** The ink file for `id`, rewritten as a build from before path claims wrote it: no claimed paths at all. */
function makeLegacy(v: ReturnType<typeof vault>, id: string) {
	const legacy = v.sidecar(id)!;
	delete legacy.pdfPaths;
	v.adapter.files.set(`.handwriting/${id}.json`, serializePage(legacy));
	expect(v.sidecar(id)?.pdfPaths, "precondition: the ink file claims no path").toBeUndefined();
}

/**
 * Every write to this ink file fails until lifted: its saves cannot reach the disk. Writes of it into the trash fail
 * too when `trash` is set.
 */
function failInkWrites(v: ReturnType<typeof vault>, id: string, opts: { trash?: boolean } = {}) {
	const write = v.adapter.write.bind(v.adapter);
	const state = { on: true, failed: 0 };
	vi.spyOn(v.adapter, "write").mockImplementation(async (path: string, data: string) => {
		const live = path.startsWith(`.handwriting/${id}.`);
		const trashed = path.startsWith(`.handwriting/trash/${id}-`);
		if (state.on && (live || (opts.trash === true && trashed))) {
			state.failed++;
			throw new Error("EIO injected");
		}
		return write(path, data);
	});
	return state;
}

describe("an ink file from before path claims, adopted by an open and then deleted", () => {
	it("the adoption's claim never reached the disk: the ink file is not left claiming no path, and a same-bytes copy opens blank", async () => {
		const v = vault();
		v.files.add(COPY);
		const id = await inkedName(v);
		makeLegacy(v, id);
		const s = session(v);
		const writes = failInkWrites(v, id);
		vi.useFakeTimers();
		const o = await s.open(NAME);
		expect(o.id, "precondition: the name adopts the ink file that claims no path").toBe(id);
		s.close(o.root);
		await s.deleteFile(NAME);
		await vi.advanceTimersByTimeAsync(10_001);
		await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
		expect(writes.failed, "precondition: the adoption's claim was written and failed").toBeGreaterThan(0);
		expect(v.sidecar(id)?.pdfPaths, "precondition: the claim never reached the disk").toBeUndefined();
		expect(v.sidecar(id), "the deleted PDF's ink file was left on disk claiming no path").toBeUndefined();
		writes.on = false;
		await s.store.flush();
		vi.useRealTimers();
		expect(v.trashInk(), "the deleted PDF's ink is not in the trash").toContainEqual(["ink-0"]);
		await expectBlank(v, COPY);
	});

	it("CONTROL: the adoption's claim reached the disk: the ink goes to the trash, and a same-bytes copy opens blank", async () => {
		const v = vault();
		v.files.add(COPY);
		const id = await inkedName(v);
		makeLegacy(v, id);
		const s = session(v);
		vi.useFakeTimers();
		const o = await s.open(NAME);
		expect(o.id, "precondition: the name adopts the ink file that claims no path").toBe(id);
		s.close(o.root);
		await s.deleteFile(NAME);
		await vi.advanceTimersByTimeAsync(10_001);
		await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
		await s.store.flush();
		vi.useRealTimers();
		expect(v.sidecar(id), "the deleted PDF's ink file is still on disk").toBeUndefined();
		expect(v.trashInk(), "the deleted PDF's ink is not in the trash").toContainEqual(["ink-0"]);
		await expectBlank(v, COPY);
	});

	it("the adoption's claim still on its way to the disk when the grace runs out: once it lands, no live ink file is left for the deleted PDF", async () => {
		const v = vault();
		v.files.add(COPY);
		const id = await inkedName(v);
		makeLegacy(v, id);
		const s = session(v);
		const held = gate();
		vi.useFakeTimers();
		const o = await s.open(NAME);
		expect(o.id, "precondition: the name adopts the ink file that claims no path").toBe(id);
		s.close(o.root);
		const before = v.adapter.writeAttempts;
		v.adapter.writeGate = held.promise;
		await s.deleteFile(NAME);
		await vi.advanceTimersByTimeAsync(10_001);
		expect(v.adapter.writeAttempts, "precondition: the adoption's claim is on its way to the disk").toBeGreaterThan(before);
		expect(v.sidecar(id)?.pdfPaths, "precondition: the claim has not landed").toBeUndefined();
		v.adapter.writeGate = null;
		held.release();
		await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
		await s.store.flush();
		vi.useRealTimers();
		expect(v.sidecar(id), `the deleted PDF's ink file is live after the grace, claiming ${JSON.stringify(v.sidecar(id)?.pdfPaths)}`).toBeUndefined();
		expect(v.trashInk(), "the deleted PDF's ink is not in the trash").toContainEqual(["ink-0"]);
		await expectBlank(v, COPY);
	});

	it("the adoption's claim never reached the disk and the move into the trash fails too: once writes work again, no live ink file is left for the deleted PDF", async () => {
		const v = vault();
		v.files.add(COPY);
		const id = await inkedName(v);
		makeLegacy(v, id);
		const s = session(v);
		const writes = failInkWrites(v, id, { trash: true });
		vi.useFakeTimers();
		const o = await s.open(NAME);
		expect(o.id, "precondition: the name adopts the ink file that claims no path").toBe(id);
		s.close(o.root);
		await s.deleteFile(NAME);
		await vi.advanceTimersByTimeAsync(10_001);
		expect(writes.failed, "precondition: the adoption's claim was written and failed").toBeGreaterThan(0);
		writes.on = false;
		// Every retry and wait this build arms, run out.
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
		await s.store.flush();
		vi.useRealTimers();
		expect(v.sidecar(id), `the deleted PDF's ink file is live after the grace, claiming ${JSON.stringify(v.sidecar(id)?.pdfPaths)}`).toBeUndefined();
		expect(v.trashInk(), "the deleted PDF's ink is not in the trash").toContainEqual(["ink-0"]);
		await expectBlank(v, COPY);
	});

	it("the record also claims another PDF and its claims never reached the disk: once writes work again, the ink file claims that other PDF only", async () => {
		const v = vault();
		v.files.add(COPY);
		v.files.add(OTHER);
		const id = await inkedName(v);
		makeLegacy(v, id);
		const s = session(v);
		const writes = failInkWrites(v, id);
		vi.useFakeTimers();
		const o = await s.open(NAME);
		expect(o.id, "precondition: the name adopts the ink file that claims no path").toBe(id);
		s.close(o.root);
		// No open reaches a second claim here: a second same-bytes open is given a fresh ink file while this one is
		// held, and a rename moves the claim. The store's own call stands in.
		s.pdfStore.claimPath(id, OTHER);
		await s.deleteFile(NAME);
		await vi.advanceTimersByTimeAsync(10_001);
		await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
		expect(writes.failed, "precondition: the claims were written and failed").toBeGreaterThan(0);
		expect(v.sidecar(id)?.pdfPaths, "precondition: no claim reached the disk").toBeUndefined();
		writes.on = false;
		await s.store.flush();
		vi.useRealTimers();
		expect(v.sidecar(id)?.pdfPaths, "the ink file does not claim the other PDF only").toEqual([OTHER]);
		expect(v.trashInk(), "ink went to the trash").toEqual([]);
	});

	it("CONTROL: an ink file that claims no path and that no record holds: the deletion leaves it as it is", async () => {
		const v = vault();
		v.files.add(COPY);
		const id = await inkedName(v);
		makeLegacy(v, id);
		const before = v.adapter.files.get(`.handwriting/${id}.json`);
		const s = session(v);
		vi.useFakeTimers();
		await s.deleteFile(NAME);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.adapter.files.get(`.handwriting/${id}.json`), "the ink file that claims no path was written or removed").toBe(before);
		expect(v.trashInk(), "ink went to the trash").toEqual([]);
	});
});
