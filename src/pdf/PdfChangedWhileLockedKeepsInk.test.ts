/**
 * A PDF opened while its ink file was mid-sync is locked: ink drawn on it is kept on screen and not saved until the
 * file reads again. When the PDF's own bytes then change (a sync, a re-export over the file), its pane moves to a
 * new ink file and the user is told the ink drawn before the change "is kept in its old ink file". Nothing read the
 * old ink file again: the live-reload poll walks only the ids panes show, and the pane now shows the new one. The
 * ink drawn under the lock was in no file, and was gone at quit.
 *
 * These cells run the production change path (onPdfModified, resolvePdfId) and the production poll over a real page
 * store: once the old ink file reads sound in the session, pane or no pane, the ink drawn under the lock is saved to
 * it, merged with what the file holds. A file that still reads damaged is never written, a file that has not changed
 * is not read again, and a record a busy pane still shows is not read under its gesture. A pane that takes the old
 * ink while the poll reads it is repainted with the merged ink. Notice texts are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { parsePage } from "../model/PageData";
import { PdfInkStore } from "./PdfInkStore";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";
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

const KEPT_NOTICE = "Handwriting: this PDF changed on disk. Ink drawn before the change is kept in its old ink file; new ink goes to a new one.";
const LOCK_NOTICE = "Handwriting: this PDF's ink file could not be read yet. New ink on it is not saved until it loads.";
const changeNotices = () => shown.filter((m) => m.startsWith("Handwriting: this PDF changed on disk."));
// An ink file caught mid-write by a sync client: it does not parse.
const TRUNCATED = '{"surface":"pdf","strokes":[';

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

function stroke(id: string, x = 10): InkStroke {
	return {
		id, page: 1, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [{ x, y: 10, pressure: 0.5, t: 0 }, { x: x + 10, y: 20, pressure: 0.5, t: 8 }],
		bbox: { x, y: 10, width: 10, height: 10 },
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
	const bytes = new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(70000) + "\n%%EOF\n");
	return { adapter, pdfs: new Map([["Paper.pdf", bytes]]) };
}
type Vault = ReturnType<typeof vault>;

/** A re-export over the file: one head byte changes, so its ink id does. */
function mutate(v: Vault, at = 100, to = 121) {
	const after = v.pdfs.get("Paper.pdf")!.slice();
	after[at] = to;
	v.pdfs.set("Paper.pdf", after);
}

/** The PDF's first bytes, as vault() wrote them. */
const firstBytes = () => new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(70000) + "\n%%EOF\n");

/** The next read of `path` waits for `until`; `entered` says it has started. */
function holdRead(v: Vault, path: string, until: Promise<void>) {
	const read = v.adapter.read.bind(v.adapter);
	let entered = false;
	v.adapter.read = async (asked: string) => {
		if (asked === path && !entered) {
			entered = true;
			await until;
		}
		return read(asked);
	};
	return { entered: () => entered };
}

/**
 * One session: the production plugin methods over a real page store, and the production poll. `midSyncOnOpen`
 * makes the first ink read of the session find the file mid-write, as a sync client writing it between the claim
 * read and the load leaves it.
 */
function session(v: Vault, midSyncOnOpen = false) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	const notices: string[] = [];
	let armed = midSyncOnOpen;
	let gate: Promise<void> | null = null;
	let entered = false;
	let heldLoad: { id: string; until: Promise<void> } | null = null;
	let heldLoadEntered = false;
	pdfStore.attachHost({
		load: async (id, options) => {
			if (armed) {
				armed = false;
				entered = true;
				if (gate) await gate;
				v.adapter.externalWrite(store.path(id), TRUNCATED);
			}
			if (heldLoad?.id === id) {
				const { until } = heldLoad;
				heldLoad = null;
				heldLoadEntered = true;
				await until;
			}
			return store.load(id, options);
		},
		schedule: (id, data) => store.schedule(id, data),
		notice: (message) => notices.push(message),
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	const leaves: { view: { file: { path: string }; containerEl: HTMLElement } }[] = [];
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	const errors: unknown[][] = [];
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
		pollStats: { ticks: 0, hidden: 0, spaced: 0, checks: 0 },
		registerInterval: (h: number) => h,
		reloadPanesHidden: (doc: { hidden: boolean }) => doc.hidden,
	});
	let fire!: () => void;
	let pending: Promise<void> = Promise.resolve();
	installLiveReloadPoll.call(
		plugin,
		{ setInterval(fn: () => void) { fire = fn; return 1; } },
		{ hidden: false },
		(work: Promise<void>) => { pending = work.catch((err: unknown) => void errors.push([err])); },
		() => [], {}, () => {}, () => {}, () => null, async () => false, { error: (...a: unknown[]) => void errors.push(a) }, () => null,
	);
	async function open(path = "Paper.pdf") {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh: vi.fn(), refreshStrip() {}, forgetHistory() {}, idle: true };
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
	/** One poll pass that checks the ink files (not one the idle backoff spaces out), run to its end. */
	async function checkedTick() {
		for (let i = 0; i < 10; i++) {
			const checks = plugin.pollStats.checks;
			fire();
			await pending;
			if (plugin.pollStats.checks > checks) return;
		}
		throw new Error("no poll pass checked the ink files");
	}
	/** Let every queued save land. */
	async function settle() {
		await vi.advanceTimersByTimeAsync(1000);
		await pdfStore.settle();
		await store.flush();
		for (let i = 0; i < 20; i++) await Promise.resolve();
	}
	/** The mid-sync load waits for `until` before it reads; `entered` says it has started. */
	function holdMidSyncLoad(until: Promise<void>) {
		gate = until;
	}
	/** The next load of `id` waits for `until` before it reads; `heldLoadEntered` says it has started. */
	function holdLoadOf(id: string, until: Promise<void>) {
		heldLoad = { id, until };
	}
	return {
		store, pdfStore, plugin, notices, errors, open, close, checkedTick, settle, holdMidSyncLoad, holdLoadOf,
		entered: () => entered, heldLoadEntered: () => heldLoadEntered,
	};
}

const strokesIn = (v: Vault, path: string): string[] => {
	const raw = v.adapter.files.get(path);
	expect(raw, `ink file exists: ${path}`).toBeDefined();
	return parsePage(raw!, "x").data.strokes.map((s) => s.id);
};

/**
 * Seed: an earlier session drew "disk-ink" on Paper.pdf and saved it. This session opens the PDF while a sync is
 * writing that ink file (locked), and draws "during" under the lock.
 */
async function seed(v: Vault) {
	const writer = session(v);
	const first = await writer.open();
	writer.pdfStore.commit(first.id, stroke("disk-ink"));
	await writer.store.flush();
	const oldPath = writer.store.path(first.id);
	const sound = v.adapter.files.get(oldPath)!;
	expect(strokesIn(v, oldPath), "precondition: the earlier session saved its ink").toEqual(["disk-ink"]);
	return { first, oldPath, sound };
}

async function lockedOpen(v: Vault) {
	const { first, oldPath, sound } = await seed(v);
	const s = session(v, true);
	const pane = await s.open();
	expect(pane.id, "precondition: the open found the old ink file's id").toBe(first.id);
	expect(s.pdfStore.inkReady(pane.id), "precondition: the mid-sync read locked the PDF").toBe(false);
	s.pdfStore.commit(pane.id, stroke("during", 200));
	await s.settle();
	expect(v.adapter.files.get(oldPath), "precondition: ink drawn under the lock is not written").toBe(TRUNCATED);
	expect(s.notices, "precondition: the lock was told once").toEqual([LOCK_NOTICE]);
	return { s, pane, oldPath, sound };
}

/** The PDF's bytes change while its ink file is locked: the pane moves to a new ink file, and the old one is "kept". */
async function changedWhileLocked(v: Vault) {
	const opened = await lockedOpen(v);
	const { s, pane } = opened;
	mutate(v);
	await s.plugin.onPdfModified("Paper.pdf");
	const now = s.plugin.pdfIds.get(pane.root) as string;
	expect(now, "precondition: the pane moved to the new bytes' ink file").not.toBe(pane.id);
	expect(changeNotices(), "precondition: the user was told the old ink is kept").toEqual([KEPT_NOTICE]);
	return { ...opened, now };
}

/**
 * The F8 road: the old ink file reads sound and the poll saves it, ink drawn on the new bytes is saved, the pane closes,
 * and the PDF changes again while no pane shows it. The third version opens on an ink file of its own.
 */
async function thirdOpenedWithNoPane(v: Vault) {
	const { s, pane, oldPath, sound, now } = await changedWhileLocked(v);
	// The sync client finishes the old ink file; then the user draws on the new bytes, and that ink is saved.
	v.adapter.externalWrite(oldPath, sound);
	s.pdfStore.commit(now, stroke("after", 300));
	await s.settle();
	expect(strokesIn(v, s.store.path(now)), "precondition: the new bytes' ink file holds the ink drawn on them").toEqual(["after"]);
	await s.checkedTick();
	await s.settle();
	s.close(pane.root);
	await s.settle();
	// The PDF changes again while no pane shows it.
	mutate(v, 101, 122);

	const third = await s.open();
	await s.settle();

	expect(third.id, "precondition: the third bytes have an ink file of their own").not.toBe(now);
	expect(third.id, "precondition: the third bytes have an ink file of their own").not.toBe(pane.id);
	return { s, oldPath, third };
}

const loadsOf = (load: { mock: { calls: unknown[][] } }, id: string) => load.mock.calls.filter(([asked]) => asked === id).length;
const readsOf = (read: { mock: { calls: unknown[][] } }, path: string) => read.mock.calls.filter(([asked]) => asked === path).length;

describe("a PDF whose bytes change while its ink file is locked", () => {
	it("F1: once the old ink file reads sound, the poll saves the ink drawn under the lock to it; the new file and the notices stay as they were", async () => {
		const v = vault();
		const { s, pane, oldPath, sound, now } = await changedWhileLocked(v);
		// The sync client finishes writing the old ink file.
		v.adapter.externalWrite(oldPath, sound);

		await s.checkedTick();
		await s.settle();

		expect(strokesIn(v, oldPath), "the ink drawn under the lock is in no file").toEqual(["disk-ink", "during"]);
		expect(v.adapter.files.has(s.store.path(now)), "the new bytes' ink file was written").toBe(false);
		expect(s.pdfStore.strokes(now).map((x) => x.id), "the ink drawn under the lock was carried to the new bytes").toEqual([]);
		expect(changeNotices(), "a change notice was added or changed").toEqual([KEPT_NOTICE]);
		expect(s.notices, "the heal told the user something").toEqual([LOCK_NOTICE]);
		expect(s.errors, "the poll failed").toEqual([]);

		// The old bytes come back in a later session: their ink file opens with the ink drawn under the lock.
		v.pdfs.set("Paper.pdf", new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(70000) + "\n%%EOF\n"));
		const later = session(v);
		const reopened = await later.open();
		expect(reopened.id).toBe(pane.id);
		expect(later.pdfStore.strokes(reopened.id).map((x) => x.id), "the reopened old bytes lack the ink drawn under the lock").toEqual(["disk-ink", "during"]);
	});

	it("F2: an old ink file that still reads damaged is never written: the lock holds and the ink stays in the session", async () => {
		const v = vault();
		const { s, pane, oldPath } = await changedWhileLocked(v);
		// The sync client writes more of the file, still mid-write.
		v.adapter.externalWrite(oldPath, `${TRUNCATED}{`);

		await s.checkedTick();
		await s.settle();

		expect(v.adapter.files.get(oldPath), "a file that read damaged was written over").toBe(`${TRUNCATED}{`);
		expect(s.pdfStore.inkReady(pane.id), "a damaged read lifted the lock").toBe(false);
		expect(s.pdfStore.strokes(pane.id).map((x) => x.id), "the ink drawn under the lock left the session").toEqual(["during"]);
		expect(s.pdfStore.generation(pane.id), "the locked record was forgotten with its unsaved ink").not.toBeNull();
		expect(s.errors).toEqual([]);
	});

	it("F3: a locked PDF whose pane closed has the ink drawn under the lock saved once its ink file reads sound", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await lockedOpen(v);
		s.close(pane.root);
		await s.settle();
		expect(s.pdfStore.generation(pane.id), "precondition: the locked record is kept past its pane").not.toBeNull();
		v.adapter.externalWrite(oldPath, sound);

		await s.checkedTick();
		await s.settle();

		expect(strokesIn(v, oldPath), "the ink drawn under the lock is in no file").toEqual(["disk-ink", "during"]);
		expect(s.errors).toEqual([]);
	});

	it("F4: once that save has landed, the old record is released as a closed PDF's is, so a later open reads the file as it is then", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await changedWhileLocked(v);
		v.adapter.externalWrite(oldPath, sound);

		await s.checkedTick();
		await s.settle();

		expect(strokesIn(v, oldPath), "precondition: the save landed").toEqual(["disk-ink", "during"]);
		expect(s.pdfStore.generation(pane.id), "the healed record no pane shows was kept in memory").toBeNull();
	});

	it("F5: a locked old ink file that has not changed is not loaded again, tick after tick; its bytes are compared at most once per 5 s", async () => {
		const v = vault();
		const { s, pane, oldPath } = await changedWhileLocked(v);
		const load = vi.spyOn(s.store, "load");
		const read = vi.spyOn(v.adapter, "read");

		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(5000);
			await s.checkedTick();
		}

		expect(loadsOf(load, pane.id), "an unchanged locked ink file was loaded again by the poll").toBe(0);
		expect(readsOf(read, oldPath), "the unchanged locked ink file was read more than once per 5 s pass").toBeLessThanOrEqual(3);
		const spaced = readsOf(read, oldPath);
		await s.checkedTick();
		await s.checkedTick();
		expect(readsOf(read, oldPath), "the unchanged locked ink file was read again inside 5 s").toBe(spaced);
		expect(s.pdfStore.inkReady(pane.id)).toBe(false);
		expect(s.errors).toEqual([]);
	});

	it("F6: a locked record a busy pane still shows is not read under its gesture; the ink is saved once that pane has moved on", async () => {
		const v = vault();
		const { first, oldPath, sound } = await seed(v);
		// Two panes opened together (a restored workspace): both read the ink file's claim before the first load
		// finds the file mid-write.
		const s = session(v, true);
		let release!: () => void;
		s.holdMidSyncLoad(new Promise<void>((r) => (release = r)));
		const opening = s.open();
		await vi.waitFor(() => expect(s.entered(), "precondition: the first pane's load started").toBe(true));
		const second = await s.open();
		release();
		const pane = await opening;
		expect(pane.id, "precondition: the open found the old ink file's id").toBe(first.id);
		expect(second.id, "precondition: both panes show the same ink").toBe(pane.id);
		expect(s.pdfStore.inkReady(pane.id), "precondition: the mid-sync read locked the PDF").toBe(false);
		s.pdfStore.commit(pane.id, stroke("during", 200));
		await s.settle();
		expect(v.adapter.files.get(oldPath), "precondition: ink drawn under the lock is not written").toBe(TRUNCATED);
		second.controller.idle = false;
		const passes: Promise<void>[] = [];
		const onPdfModified = s.plugin.onPdfModified;
		s.plugin.onPdfModified = function (this: unknown, ...args: unknown[]) {
			const pass = onPdfModified.apply(this, args);
			passes.push(pass);
			return pass;
		};
		mutate(v);
		await s.plugin.onPdfModified("Paper.pdf");
		expect(s.plugin.pdfIds.get(second.root), "precondition: the busy pane is left on the locked ink").toBe(pane.id);
		v.adapter.externalWrite(oldPath, sound);
		const load = vi.spyOn(s.store, "load");
		const read = vi.spyOn(v.adapter, "read");

		await s.checkedTick();

		expect(loadsOf(load, pane.id), "the locked ink was read while a busy pane shows it").toBe(0);
		expect(readsOf(read, oldPath), "the locked ink file was checked while a busy pane shows it").toBe(0);
		expect(v.adapter.files.get(oldPath), "the locked ink was written while a busy pane shows it").toBe(sound);

		second.controller.idle = true;
		const before = passes.length;
		await vi.advanceTimersByTimeAsync(1000);
		expect(passes.length, "precondition: the busy pane's retry ran").toBe(before + 1);
		await passes[passes.length - 1];
		expect(s.plugin.pdfIds.get(second.root), "precondition: the busy pane moved on").not.toBe(pane.id);
		await vi.advanceTimersByTimeAsync(5000);
		await s.checkedTick();
		await s.settle();

		expect(strokesIn(v, oldPath), "the ink drawn under the lock is in no file").toEqual(["disk-ink", "during"]);
		expect(s.errors).toEqual([]);
	});

	it("F7: a pane that takes the old ink while the poll is reading it is repainted with the merged ink, and the record is kept", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await changedWhileLocked(v);
		v.adapter.externalWrite(oldPath, sound);
		let release!: () => void;
		s.holdLoadOf(pane.id, new Promise<void>((r) => (release = r)));
		const tick = s.checkedTick();
		await vi.waitFor(() => expect(s.heldLoadEntered(), "the poll did not read the old ink file").toBe(true));
		// While that read is out, the PDF's bytes go back to the old version: the pane moves back to the old ink, whose
		// load is already under way, so its open paints what the session holds now.
		const painted: string[][] = [];
		pane.controller.refresh.mockImplementation(() => void painted.push(s.pdfStore.strokes(pane.id).map((x) => x.id)));
		v.pdfs.set("Paper.pdf", firstBytes());
		await s.plugin.onPdfModified("Paper.pdf");
		expect(s.plugin.pdfIds.get(pane.root), "precondition: the pane is back on the old ink").toBe(pane.id);
		const before = painted.length;

		release();
		await tick;
		await s.settle();

		expect(strokesIn(v, oldPath), "the ink drawn under the lock is in no file").toEqual(["disk-ink", "during"]);
		expect(painted.slice(before).at(-1), "the pane still shows the ink from before the read landed").toEqual(["disk-ink", "during"]);
		expect(s.pdfStore.generation(pane.id), "a record a pane shows was released").not.toBeNull();
		expect(s.errors).toEqual([]);
	});

	it("F8 road: a third version opened while no pane shows the PDF leaves the ink drawn under the lock in its old ink file", async () => {
		const v = vault();
		const { s, oldPath } = await thirdOpenedWithNoPane(v);
		expect(strokesIn(v, oldPath), "the ink drawn under the lock is in no file").toEqual(["disk-ink", "during"]);
		expect(s.errors).toEqual([]);
	});

	// Known limit, expected to fail: a PDF changed with no pane carries
	// from the claimant with the newest file time, and the poll's save of the old ink file makes it that
	// claimant. The want stays; a later fix to which ink a changed PDF carries turns it green. The road and the checks
	// that must hold on it are the cell above; this cell holds the limit's own line only.
	it.fails("F8 KNOWN LIMIT, expected to fail: a third version opened while no pane shows the PDF should carry the ink of the version it changed from; it carries the old file the poll saved", async () => {
		const v = vault();
		const { s, third } = await thirdOpenedWithNoPane(v);
		expect(s.pdfStore.strokes(third.id).map((x) => x.id), "the third version opened with the ink of an older version than the one it changed from").toEqual(["after"]);
	});

	it("F9: a pane that takes the old ink while the poll checks its file reads it itself; the poll does not read it again", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await changedWhileLocked(v);
		v.adapter.externalWrite(oldPath, sound);
		let release!: () => void;
		const check = holdRead(v, oldPath, new Promise<void>((r) => (release = r)));
		const tick = s.checkedTick();
		await vi.waitFor(() => expect(check.entered(), "the poll did not check the old ink file").toBe(true));
		// While that check is out, the bytes go back to the old version: the pane's own open reads the file and saves.
		v.pdfs.set("Paper.pdf", firstBytes());
		await s.plugin.onPdfModified("Paper.pdf");
		expect(s.plugin.pdfIds.get(pane.root), "precondition: the pane is back on the old ink").toBe(pane.id);
		await s.settle();
		expect(strokesIn(v, oldPath), "precondition: the pane's own read saved the ink drawn under the lock").toEqual(["disk-ink", "during"]);
		const load = vi.spyOn(s.store, "load");
		const written = v.adapter.files.get(oldPath);

		release();
		await tick;
		await s.settle();

		expect(loadsOf(load, pane.id), "the poll read again a record a pane took while it checked the file").toBe(0);
		expect(v.adapter.files.get(oldPath), "the poll wrote the old ink file again").toBe(written);
		expect(s.pdfStore.generation(pane.id), "a record a pane shows was released").not.toBeNull();
		expect(s.errors).toEqual([]);
	});
});

describe("pins", () => {
	it("PIN: a locked PDF a pane still shows heals through the pane's own pass, as before", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await lockedOpen(v);
		v.adapter.externalWrite(oldPath, sound);

		await s.checkedTick();
		await s.settle();

		expect(s.pdfStore.inkReady(pane.id), "the pane's pass did not lift the lock").toBe(true);
		expect(strokesIn(v, oldPath), "the pane's heal did not save the ink drawn under the lock").toEqual(["disk-ink", "during"]);
		expect(s.pdfStore.generation(pane.id), "a record a pane shows was released").not.toBeNull();
		expect(pane.controller.refresh, "the pane was not repainted with the file's ink").toHaveBeenCalled();
	});
});
