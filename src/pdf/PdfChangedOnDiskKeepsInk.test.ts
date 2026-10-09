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
		return { root, id };
	}
	return { store, pdfStore, plugin, notices, open };
}

const ids = (strokes: readonly InkStroke[]) => strokes.map((s) => s.id);
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
