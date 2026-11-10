import { afterEach, beforeEach, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { familyOf } from "./PdfIdentity";
import type { InkStroke } from "../ink/Stroke";

// What the plugin told the user through Obsidian's Notice. The stub's Notice is an empty class, so it is
// replaced here; the production module and this file share the mock.
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

// The notice for a PDF that changed on disk while it had ink, when the ink stays in the old ink file.
const KEPT_NOTICE = "Handwriting: this PDF changed on disk. Ink drawn before the change is kept in its old ink file; new ink goes to a new one.";
// The notice when the ink drawn before the change was copied into the new ink file.
const CARRIED_NOTICE = "Handwriting: this PDF changed on disk. Your ink was carried over to its new version.";
const changeNotices = () => shown.filter((m) => m.startsWith("Handwriting: this PDF changed on disk."));

// Synthetic storage only. Production identity, PDF store and PageStore execute;
// these cells do not reproduce Obsidian rendering.
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

function stroke(id: string, page = 1): InkStroke {
	return {
		id, page, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [{ x: 10, y: 10, pressure: 0.5, t: 0 }, { x: 20, y: 20, pressure: 0.5, t: 8 }],
		bbox: { x: 10, y: 10, width: 10, height: 10 },
	};
}

function vault() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	adapter.list = async (folder) => ({
		files: [...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	// More than 64 KiB separates a length-only change from a head change.
	const bytes = new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(70000) + "\n%%EOF\n");
	return { adapter, pdfs: new Map([["Paper.pdf", bytes]]) };
}

function session(v: ReturnType<typeof vault>) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	const notices: string[] = [];
	pdfStore.attachHost({
		load: (id, options) => store.load(id, options),
		schedule: (id, data) => store.schedule(id, data),
		notice: (message) => notices.push(message),
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
	async function open(path = "Paper.pdf") {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, idle: true };
		const leaf = { view: { file: { path }, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId(leaf, root, controller);
		const id = plugin.pdfIds.get(root) as string;
		expect(id, "production resolution must bind a PDF identity").toMatch(/^pdf-[0-9a-f]+(?:-\d+)?$/);
		return { root, id, controller };
	}
	/** Close a pane the way syncPdfControllers does: drop its maps, then release its id. */
	function close(root: HTMLElement) {
		leaves.splice(leaves.findIndex((l) => l.view.containerEl === root), 1);
		const was = plugin.pdfIds.get(root);
		plugin.pdfInk.delete(root);
		plugin.pdfIds.delete(root);
		plugin.pdfFiles.delete(root);
		if (was) plugin.releasePdfId(was);
	}
	return { store, pdfStore, plugin, notices, open, close };
}

const ids = (strokes: readonly InkStroke[]) => strokes.map((s) => s.id);

/**
 * Every identification pass the plugin starts, the retry its timer starts included, so a cell can wait for the retry
 * itself to finish rather than for a number of timer steps: the retry reads the file and hashes it, which is real async
 * work the fake clock does not drive.
 */
function recordPasses(plugin: { onPdfModified: unknown }): Promise<void>[] {
	const passes: Promise<void>[] = [];
	const onPdfModified = plugin.onPdfModified as (...args: unknown[]) => Promise<void>;
	plugin.onPdfModified = function (this: unknown, ...args: unknown[]) {
		const pass = onPdfModified.apply(this, args);
		passes.push(pass);
		return pass;
	};
	return passes;
}

/** A held pane's retry is due within the plugin's settle time (1 s, PdfClaims.ts): it runs once, and this waits for it to end. */
async function heldRetry(passes: Promise<void>[]): Promise<void> {
	const before = passes.length;
	await vi.advanceTimersByTimeAsync(1000);
	expect(passes.length, "the held pane's retry ran once").toBe(before + 1);
	await passes[passes.length - 1];
}

// Taken before any cell fakes the clock: the late digest below waits on the real one.
const realTimeout = globalThis.setTimeout;

/**
 * Make the platform digest land `ms` of real time late, as a loaded machine's thread pool can. A PDF's
 * identity is a SHA-256 the platform computes off the main thread, so it resolves in real time, which the
 * fake clock does not move.
 */
function lateDigest(ms: number) {
	const subtle = globalThis.crypto.subtle;
	const digest = subtle.digest.bind(subtle);
	vi.spyOn(subtle, "digest").mockImplementation(async (algorithm, data) => {
		await new Promise((resolve) => realTimeout(resolve, ms));
		return digest(algorithm, data);
	});
}
function disk(v: ReturnType<typeof vault>, path: string) {
	const raw = v.adapter.files.get(path);
	expect(raw, `sidecar exists: ${path}`).toBeDefined();
	return JSON.parse(raw!);
}

it("A0 control: unchanged bytes retain identity, both pages, and saved ink after re-identification", async () => {
	const v = vault();
	const s = session(v);
	const opened = await s.open();
	s.pdfStore.commit(opened.id, stroke("page-one"));
	s.pdfStore.commit(opened.id, stroke("page-two", 2));
	await s.store.flush();
	await s.plugin.onPdfModified("Paper.pdf");
	const bound = s.plugin.pdfIds.get(opened.root);
	expect(bound).toBe(opened.id);
	expect(ids(s.pdfStore.strokesOnPage(bound, 1))).toEqual(["page-one"]);
	expect(ids(s.pdfStore.strokesOnPage(bound, 2))).toEqual(["page-two"]);
	expect(ids(disk(v, s.store.path(bound)).strokes)).toEqual(["page-one", "page-two"]);
	expect(changeNotices(), "same id after the change: nothing to tell").toEqual([]);
});

/** Change the PDF the way each mutation names: a head byte (a re-export) or one byte appended (an incremental save). */
function mutate(v: ReturnType<typeof vault>, mutation: "head" | "length-only") {
	const before = v.pdfs.get("Paper.pdf")!;
	const after = mutation === "head" ? before.slice() : new Uint8Array(before.length + 1);
	if (mutation === "head") after[100] = 121;
	else after.set(before);
	if (mutation === "head") expect(after.length).toBe(before.length);
	else expect([...after.subarray(0, 65536)]).toEqual([...before.subarray(0, 65536)]);
	v.pdfs.set("Paper.pdf", after);
}

for (const mutation of ["head", "length-only"] as const) {
	it(`A-${mutation}: the modify path binds a new sidecar, carries the ink into it, leaves the old file as it was, and tells the user once`, async () => {
		const v = vault();
		const s = session(v);
		const opened = await s.open();
		s.pdfStore.commit(opened.id, stroke("before-change"));
		await s.store.flush();
		const oldPath = s.store.path(opened.id);
		const oldBytes = v.adapter.files.get(oldPath);
		mutate(v, mutation);
		// The production method calls releasePdfId and resolvePdfId. No substituted id chooser.
		await s.plugin.onPdfModified("Paper.pdf");
		const bound = s.plugin.pdfIds.get(opened.root) as string;
		const visible = ids(s.pdfStore.strokesOnPage(bound, 1));
		expect(bound).not.toBe(opened.id);
		expect(changeNotices()).toEqual([CARRIED_NOTICE]);
		expect(visible).toEqual(["before-change"]);
		expect(v.adapter.files.get(oldPath)).toBe(oldBytes);
		s.pdfStore.commit(bound, stroke("after-change"));
		await s.store.flush();
		// Saved ink never changes look: the carried stroke is written field for field as the old file holds it.
		expect(JSON.stringify(disk(v, s.store.path(bound)).strokes[0])).toBe(JSON.stringify(disk(v, oldPath).strokes[0]));
		const restarted = session(v);
		const reopened = await restarted.open();
		expect(reopened.id).toBe(bound);
		expect(ids(restarted.pdfStore.strokesOnPage(bound, 1))).toEqual(["before-change", "after-change"]);
		expect(v.adapter.files.get(oldPath)).toBe(oldBytes);
	});
}

it("A-two-panes: two panes on the changed file get the ink once and one notice, not one each", async () => {
	const v = vault();
	const s = session(v);
	const first = await s.open();
	const second = await s.open();
	expect(second.id, "both panes show the same ink").toBe(first.id);
	s.pdfStore.commit(first.id, stroke("before-change"));
	await s.store.flush();
	mutate(v, "head");
	await s.plugin.onPdfModified("Paper.pdf");
	expect(s.plugin.pdfIds.get(first.root)).not.toBe(first.id);
	expect(s.plugin.pdfIds.get(second.root)).not.toBe(first.id);
	expect(changeNotices()).toEqual([CARRIED_NOTICE]);
	expect(ids(s.pdfStore.strokesOnPage(s.plugin.pdfIds.get(first.root), 1))).toEqual(["before-change"]);
});

it("A-closed: a PDF changed while no pane shows it reopens with its ink, and the old file is left as it was", async () => {
	const v = vault();
	const s = session(v);
	const opened = await s.open();
	s.pdfStore.commit(opened.id, stroke("before-change"));
	await s.store.flush();
	const oldPath = s.store.path(opened.id);
	const oldBytes = v.adapter.files.get(oldPath);
	s.close(opened.root);
	await vi.advanceTimersByTimeAsync(5000);
	mutate(v, "head");
	await s.plugin.onPdfModified("Paper.pdf");
	const reopened = await s.open();
	expect(reopened.id, "new bytes, new ink file").not.toBe(opened.id);
	expect(ids(s.pdfStore.strokesOnPage(reopened.id, 1))).toEqual(["before-change"]);
	expect(changeNotices()).toEqual([CARRIED_NOTICE]);
	await s.store.flush();
	expect(v.adapter.files.get(oldPath), "the old ink file is never written").toBe(oldBytes);
	const restarted = session(v);
	const again = await restarted.open();
	expect(again.id).toBe(reopened.id);
	expect(ids(restarted.pdfStore.strokesOnPage(again.id, 1))).toEqual(["before-change"]);
});

it("A-closed-restart: a PDF changed while Obsidian was closed reopens with its ink", async () => {
	const v = vault();
	const s = session(v);
	const opened = await s.open();
	s.pdfStore.commit(opened.id, stroke("before-change"));
	await s.store.flush();
	const oldPath = s.store.path(opened.id);
	const oldBytes = v.adapter.files.get(oldPath);
	mutate(v, "head");
	const restarted = session(v);
	const reopened = await restarted.open();
	expect(reopened.id).not.toBe(opened.id);
	expect(ids(restarted.pdfStore.strokesOnPage(reopened.id, 1))).toEqual(["before-change"]);
	expect(changeNotices()).toEqual([CARRIED_NOTICE]);
	await restarted.store.flush();
	expect(v.adapter.files.get(oldPath), "the old ink file is never written").toBe(oldBytes);
});

for (const late of [0, 50]) {
const digestNote = late ? ` (the digest lands ${late} ms late)` : "";
it(`A-two-panes-held: a stroke drawn in the pane busy during the change reaches the new ink file${digestNote}`, async () => {
	if (late) lateDigest(late);
	const v = vault();
	const s = session(v);
	const first = await s.open();
	const second = await s.open();
	const passes = recordPasses(s.plugin);
	s.pdfStore.commit(first.id, stroke("before-change"));
	await s.store.flush();
	second.controller.idle = false;
	mutate(v, "head");
	await s.plugin.onPdfModified("Paper.pdf");
	const now = s.plugin.pdfIds.get(first.root) as string;
	expect(now, "the idle pane moved to the new ink file").not.toBe(first.id);
	expect(s.plugin.pdfIds.get(second.root), "the busy pane is left on the old one").toBe(first.id);
	await vi.advanceTimersByTimeAsync(1000);
	s.pdfStore.commit(first.id, stroke("during"));
	second.controller.idle = true;
	await heldRetry(passes);
	expect(s.plugin.pdfIds.get(second.root), "the busy pane moved once it went idle").toBe(now);
	expect(ids(s.pdfStore.strokesOnPage(now, 1))).toEqual(["before-change", "during"]);
});
}

it("A-closed-twice: ink added between two changes made while closed carries from the second version, not the first", async () => {
	const v = vault();
	const s = session(v);
	const first = await s.open();
	s.pdfStore.commit(first.id, stroke("v1-ink"));
	await s.store.flush();
	s.close(first.root);
	await vi.advanceTimersByTimeAsync(5000);
	mutate(v, "head");
	const second = await s.open();
	expect(ids(s.pdfStore.strokesOnPage(second.id, 1))).toEqual(["v1-ink"]);
	s.pdfStore.commit(second.id, stroke("v2-ink"));
	await s.store.flush();
	s.close(second.root);
	await vi.advanceTimersByTimeAsync(5000);
	mutate(v, "length-only");
	const third = await s.open();
	expect(third.id).not.toBe(second.id);
	expect(third.id).not.toBe(first.id);
	expect(ids(s.pdfStore.strokesOnPage(third.id, 1))).toEqual(["v1-ink", "v2-ink"]);
});

for (const late of [0, 50]) {
const digestNote = late ? ` (the digest lands ${late} ms late)` : "";
it(`A-two-panes-held-erase: a carried stroke erased in the new file stays erased when the busy pane catches up${digestNote}`, async () => {
	if (late) lateDigest(late);
	const v = vault();
	const s = session(v);
	const first = await s.open();
	const second = await s.open();
	const passes = recordPasses(s.plugin);
	s.pdfStore.commit(first.id, stroke("before-change"));
	await s.store.flush();
	second.controller.idle = false;
	mutate(v, "head");
	await s.plugin.onPdfModified("Paper.pdf");
	const now = s.plugin.pdfIds.get(first.root) as string;
	expect(ids(s.pdfStore.strokesOnPage(now, 1)), "precondition: carried by the idle pane").toEqual(["before-change"]);
	s.pdfStore.replaceAll(now, []);
	await vi.advanceTimersByTimeAsync(1000);
	s.pdfStore.commit(first.id, stroke("during"));
	second.controller.idle = true;
	await heldRetry(passes);
	expect(s.plugin.pdfIds.get(second.root)).toBe(now);
	expect(ids(s.pdfStore.strokesOnPage(now, 1))).toEqual(["during"]);
});
}

it("A-revert-open: bytes back to a version with its own ink file keep that file's ink only, and say so", async () => {
	const v = vault();
	const s = session(v);
	const opened = await s.open();
	s.pdfStore.commit(opened.id, stroke("v1-ink"));
	await s.store.flush();
	const v1Path = s.store.path(opened.id);
	const v1Bytes = v.adapter.files.get(v1Path);
	const v1 = v.pdfs.get("Paper.pdf")!;
	mutate(v, "head");
	await s.plugin.onPdfModified("Paper.pdf");
	const v2 = s.plugin.pdfIds.get(opened.root) as string;
	expect(v2, "precondition: the change gave a new ink file").not.toBe(opened.id);
	s.pdfStore.commit(v2, stroke("v2-ink"));
	await s.store.flush();
	shown.length = 0;
	v.pdfs.set("Paper.pdf", v1);
	await s.plugin.onPdfModified("Paper.pdf");
	const back = s.plugin.pdfIds.get(opened.root) as string;
	expect(back, "the old bytes find their own ink file").toBe(opened.id);
	expect(ids(s.pdfStore.strokes(back))).toEqual(["v1-ink"]);
	expect(changeNotices()).toEqual([KEPT_NOTICE]);
	await s.store.flush();
	await vi.advanceTimersByTimeAsync(5000);
	await s.store.flush();
	expect(v.adapter.files.get(v1Path), "the first version's ink file is never written").toBe(v1Bytes);
});

it("A-no-ink: a changed PDF that had no ink says nothing", async () => {
	const v = vault();
	const s = session(v);
	const opened = await s.open();
	mutate(v, "head");
	await s.plugin.onPdfModified("Paper.pdf");
	expect(s.plugin.pdfIds.get(opened.root)).not.toBe(opened.id);
	expect(changeNotices()).toEqual([]);
});

it("A-released: the old record is forgotten before the new id lands, and its ink is still carried", async () => {
	const v = vault();
	const s = session(v);
	const opened = await s.open();
	s.pdfStore.commit(opened.id, stroke("before-change"));
	await s.store.flush();
	mutate(v, "head");
	// A real head read takes time; the release of the old id runs detached meanwhile and can finish first.
	const read = s.plugin.app.vault.readBinary;
	s.plugin.app.vault.readBinary = async (file: { path: string }) => {
		await vi.advanceTimersByTimeAsync(5000);
		return read(file);
	};
	await s.plugin.onPdfModified("Paper.pdf");
	expect(s.pdfStore.generation(opened.id), "precondition: the release forgot the old record during the resolution").toBeNull();
	expect(s.plugin.pdfIds.get(opened.root)).not.toBe(opened.id);
	expect(changeNotices()).toEqual([CARRIED_NOTICE]);
	expect(ids(s.pdfStore.strokesOnPage(s.plugin.pdfIds.get(opened.root), 1))).toEqual(["before-change"]);
});

it("A-locked-old: an old record locked by a damaged sidecar is not carried, is left as it is, and the user is told", async () => {
	const v = vault();
	const s = session(v);
	const opened = await s.open();
	s.pdfStore.commit(opened.id, stroke("before-change"));
	await s.store.flush();
	const oldPath = s.store.path(opened.id);
	v.adapter.files.set(oldPath, "{broken-json");
	await s.pdfStore.reloadExternal(opened.id);
	expect(s.pdfStore.inkReady(opened.id), "precondition: the old record is locked").toBe(false);
	expect(s.pdfStore.hasInk(opened.id), "precondition: the old record still holds its session ink").toBe(true);
	mutate(v, "head");
	await s.plugin.onPdfModified("Paper.pdf");
	const bound = s.plugin.pdfIds.get(opened.root) as string;
	expect(bound).not.toBe(opened.id);
	expect(ids(s.pdfStore.strokesOnPage(bound, 1))).toEqual([]);
	expect(changeNotices()).toEqual([KEPT_NOTICE]);
	await s.store.flush();
	expect(v.adapter.files.get(oldPath), "the damaged old ink file is never written").toBe("{broken-json");
});

it("B control: identical copy gets separate ink without stealing the original's binding", async () => {
	const v = vault();
	const s = session(v);
	const original = await s.open();
	s.pdfStore.commit(original.id, stroke("original-ink"));
	await s.store.flush();
	v.pdfs.set("Copy.pdf", v.pdfs.get("Paper.pdf")!.slice());
	const copy = await s.open("Copy.pdf");
	const copyBefore = ids(s.pdfStore.strokesOnPage(copy.id, 1));
	await s.plugin.onPdfModified("Paper.pdf");
	const originalAfter = s.plugin.pdfIds.get(original.root);
	expect(familyOf(copy.id)).toBe(familyOf(original.id));
	expect(copy.id).not.toBe(original.id);
	expect(copyBefore).toEqual([]);
	expect(originalAfter).toBe(original.id);
	expect(ids(s.pdfStore.strokesOnPage(originalAfter, 1))).toEqual(["original-ink"]);
	s.pdfStore.commit(copy.id, stroke("copy-ink"));
	await s.store.flush();
	expect(disk(v, s.store.path(original.id)).pdfPaths).toEqual(["Paper.pdf"]);
	expect(disk(v, s.store.path(copy.id)).pdfPaths).toEqual(["Copy.pdf"]);
	const restarted = session(v);
	// Reverse allocation order so missing persisted claims cannot pass by chance.
	const copyAgain = await restarted.open("Copy.pdf");
	const originalAgain = await restarted.open();
	expect(originalAgain.id).toBe(original.id);
	expect(copyAgain.id).toBe(copy.id);
	expect(ids(restarted.pdfStore.strokesOnPage(originalAgain.id, 1))).toEqual(["original-ink"]);
	expect(ids(restarted.pdfStore.strokesOnPage(copyAgain.id, 1))).toEqual(["copy-ink"]);
});

const fixedId = "pdf-0123456789abcdef0123456789abcdef";
async function seeded() {
	const v = vault();
	const writer = session(v);
	await writer.pdfStore.ensureLoaded(fixedId);
	writer.pdfStore.commit(fixedId, stroke("disk-ink"));
	await writer.store.flush();
	const path = writer.store.path(fixedId);
	return { v, path, bytes: v.adapter.files.get(path)! };
}

for (const failure of ["damaged", "read-throws"] as const) {
	it(`C-${failure} control: real PageStore read locks saves and leaves session ink visible`, async () => {
		const { v, path, bytes } = await seeded();
		if (failure === "damaged") v.adapter.files.set(path, "{broken-json");
		const diskBefore = v.adapter.files.get(path);
		const read = v.adapter.read.bind(v.adapter);
		const injection = failure === "read-throws" ? vi.spyOn(v.adapter, "read").mockImplementation(async (p) => {
			if (p === path) throw new Error("ISSUE40 synthetic read failure");
			return read(p);
		}) : null;
		const s = session(v);
		const load = vi.spyOn(s.store, "load");
		await s.pdfStore.ensureLoaded(fixedId);
		const loadResult = await load.mock.results[0]!.value;
		const writesBefore = v.adapter.writeAttempts;
		s.pdfStore.commit(fixedId, stroke("unsaved-session-ink"));
		await s.store.flush();
		expect(loadResult).not.toBeNull();
		expect(loadResult.damaged).toBe(true);
		if (failure === "read-throws") expect(loadResult.transient).toBe(true);
		expect(s.pdfStore.inkReady(fixedId)).toBe(false);
		expect(ids(s.pdfStore.strokesOnPage(fixedId, 1))).toEqual(["unsaved-session-ink"]);
		expect(v.adapter.writeAttempts).toBe(writesBefore);
		expect(v.adapter.files.get(path)).toBe(diskBefore);
		expect(s.notices.length).toBeGreaterThan(0);
		injection?.mockRestore();
		v.adapter.files.set(path, bytes); // Restore synthetic storage, then start fresh memory.
		const restarted = session(v);
		await restarted.pdfStore.ensureLoaded(fixedId);
		expect(ids(restarted.pdfStore.strokesOnPage(fixedId, 1))).toEqual(["disk-ink"]);
	});
}

it("D-null control: false-negative existence returns null; actual save preserves displaced disk ink", async () => {
	const { v, path, bytes } = await seeded();
	const exists = v.adapter.exists.bind(v.adapter);
	// Explicit fault injection: an existing live sidecar is reported absent during load.
	// This proves the consequence of that input, not that any real adapter does this.
	const injection = vi.spyOn(v.adapter, "exists").mockImplementation(async (p) => p === path ? false : exists(p));
	const s = session(v);
	const load = vi.spyOn(s.store, "load");
	await s.pdfStore.ensureLoaded(fixedId);
	const result = await load.mock.results[0]!.value;
	injection.mockRestore();
	expect(result, "the injected adapter fault must actually reach PageStore's null path").toBeNull();
	expect(v.adapter.files.get(path)).toBe(bytes);
	s.pdfStore.commit(fixedId, stroke("new-session-ink"));
	await s.store.flush();
	const carriers = [...v.adapter.files].filter(([p]) => p.endsWith(".json")).map(([p, raw]) => ({ path: p, ids: ids(JSON.parse(raw).strokes), raw }));
	expect(ids(s.pdfStore.strokesOnPage(fixedId, 1))).toEqual(["new-session-ink"]);
	expect(ids(disk(v, path).strokes)).toEqual(["new-session-ink"]);
	expect(carriers.some((c) => c.path !== path && c.raw === bytes), "old disk bytes survive in a distinct recovery carrier").toBe(true);
});

it("D-sound control: successful real load merges disk and session ink into the live sidecar", async () => {
	const { v, path } = await seeded();
	const s = session(v);
	await s.pdfStore.ensureLoaded(fixedId);
	s.pdfStore.commit(fixedId, stroke("new-session-ink"));
	await s.store.flush();
	const visible = ids(s.pdfStore.strokesOnPage(fixedId, 1));
	const saved = ids(disk(v, path).strokes);
	expect(visible).toEqual(["disk-ink", "new-session-ink"]);
	expect(saved).toEqual(visible);
});
