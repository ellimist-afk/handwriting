/**
 * A PDF renamed while its ink file is locked (opened while a sync was writing it): the rename moves this session's
 * claim at once, but the save is refused under the lock, so the file on disk still claims the old name. When the file
 * next read sound, that read joined the file's claims with the session's, the old name came back, and the heal's save
 * wrote it: a same-bytes file at the old name later opened wearing this ink, and ink drawn or erased on either showed
 * on both.
 *
 * These cells run the production poll, open and claim move over a real page store, with the harness of
 * PdfChangedWhileLockedKeepsInk.test.ts. Once the file reads sound, pane or no pane, neither the record nor the file
 * claims a name this session renamed the claim off. Another device's claim on another name stays, and a name renamed
 * back or claimed again is a claim again. A rename while a pane shows the PDF moves the claim as the vault's rename
 * handler does (PluginOnload.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { parsePage, serializePage } from "../model/PageData";
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

const LOCK_NOTICE = "Handwriting: this PDF's ink file could not be read yet. New ink on it is not saved until it loads.";
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

/** The PDF's first bytes, as vault() wrote them. */
const firstBytes = () => new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(70000) + "\n%%EOF\n");

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

type Session = ReturnType<typeof session>;

const claimsIn = (v: Vault, path: string): string[] => {
	const raw = v.adapter.files.get(path);
	expect(raw, `ink file exists: ${path}`).toBeDefined();
	return [...(parsePage(raw!, "x").data.pdfPaths ?? [])].sort();
};

/** The paths the session holds for `id`, sorted; none once the record is released. */
const sessionClaims = (s: Session, id: string): string[] =>
	[...(s.pdfStore.claimedInstances((i) => i === id)[0]?.paths ?? [])].sort();

/** The vault keeps the PDF's bytes under its new name. */
function moveBytes(v: Vault, from: string, to: string) {
	v.pdfs.set(to, v.pdfs.get(from)!);
	v.pdfs.delete(from);
}

/** A vault rename while no pane shows the PDF: notePdfRenamed, then the claim move, as PluginOnload.ts wires it. */
async function renameUnshown(s: Session, v: Vault, from = "Paper.pdf", to = "Notes.pdf") {
	moveBytes(v, from, to);
	s.pdfStore.notePdfRenamed(from, to);
	const file = { path: to, extension: "pdf", name: to, basename: to.replace(/\.pdf$/, "") };
	await s.plugin.movePdfClaimOnRename(file as never, from);
	await s.settle();
}

/**
 * A vault rename while a pane shows the PDF: Obsidian moves the pane's file in place, and the rename handler
 * (PluginOnload.ts) notes it, then moves each pane's path and its id's claim.
 */
async function renameShown(s: Session, v: Vault, from = "Paper.pdf", to = "Notes.pdf") {
	moveBytes(v, from, to);
	for (const leaf of s.plugin.app.workspace.getLeavesOfType("pdf")) if (leaf.view.file.path === from) leaf.view.file.path = to;
	s.pdfStore.notePdfRenamed(from, to);
	for (const [root, p] of s.plugin.pdfFiles as Map<HTMLElement, string>) {
		if (p !== from) continue;
		s.plugin.pdfFiles.set(root, to);
		const id = s.plugin.pdfIds.get(root) as string | undefined;
		if (id) s.pdfStore.renamePath(id, from, to);
	}
	await s.settle();
}

/** The sync that was writing the ink file finishes: it reads sound, claiming `paths` when they are given. */
function syncFinishes(v: Vault, oldPath: string, sound: string, paths?: string[]) {
	v.adapter.externalWrite(oldPath, paths ? serializePage({ ...parsePage(sound, "x").data, pdfPaths: paths }) : sound);
}

/** As lockedOpen, but nothing is drawn under the lock. */
async function lockedOpenNothingDrawn(v: Vault) {
	const { first, oldPath, sound } = await seed(v);
	const s = session(v, true);
	const pane = await s.open();
	expect(pane.id, "precondition: the open found the old ink file's id").toBe(first.id);
	expect(s.pdfStore.inkReady(pane.id), "precondition: the mid-sync read locked the PDF").toBe(false);
	return { s, pane, oldPath, sound };
}

describe("a PDF renamed while its ink file is locked: the old name's claim does not come back", () => {
	it("renamed with a sound ink file and no pane: the ink file claims the new name only", async () => {
		const v = vault();
		const { first, oldPath } = await seed(v);
		const s = session(v);
		const pane = await s.open();
		expect(pane.id).toBe(first.id);
		s.close(pane.root);
		await s.settle();
		await renameUnshown(s, v);
		expect(claimsIn(v, oldPath), "the old name's claim outlived the rename").toEqual(["Notes.pdf"]);
	});

	it("renamed under the lock with no pane, then the ink file reads sound: the healed file claims the new name only", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await lockedOpen(v);
		s.close(pane.root);
		await s.settle();
		await renameUnshown(s, v);
		expect(sessionClaims(s, pane.id), "precondition: the session moved the claim").toEqual(["Notes.pdf"]);
		syncFinishes(v, oldPath, sound);
		await s.checkedTick();
		await s.settle();
		expect(strokesIn(v, oldPath), "precondition: the heal saved the ink drawn under the lock").toEqual(["disk-ink", "during"]);
		expect(claimsIn(v, oldPath), "the healed ink file claims the old name again").toEqual(["Notes.pdf"]);
	});

	it("after that heal, a same-bytes file at the old name opens in a later session without the renamed file's ink", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await lockedOpen(v);
		s.close(pane.root);
		await s.settle();
		await renameUnshown(s, v);
		syncFinishes(v, oldPath, sound);
		await s.checkedTick();
		await s.settle();
		expect(strokesIn(v, oldPath), "precondition: the heal saved the ink drawn under the lock").toEqual(["disk-ink", "during"]);
		v.pdfs.set("Paper.pdf", firstBytes());
		const later = session(v);
		const copy = await later.open("Paper.pdf");
		expect(copy.id === pane.id, "a file at the old name opened wearing the renamed file's ink").toBe(false);
		expect(later.pdfStore.strokes(copy.id)).toEqual([]);
	});

	it("another device's claim on another name in the file stays; only the name this session renamed away is dropped", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await lockedOpen(v);
		s.close(pane.root);
		await s.settle();
		await renameUnshown(s, v);
		syncFinishes(v, oldPath, sound, ["Paper.pdf", "Elsewhere.pdf"]);
		await s.checkedTick();
		await s.settle();
		expect(strokesIn(v, oldPath), "precondition: the heal saved the ink drawn under the lock").toEqual(["disk-ink", "during"]);
		expect(claimsIn(v, oldPath), "the heal kept the wrong names").toEqual(["Elsewhere.pdf", "Notes.pdf"]);
	});

	it("renamed away under the lock and renamed back before the file reads sound: the old name is a claim again", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await lockedOpen(v);
		s.close(pane.root);
		await s.settle();
		await renameUnshown(s, v);
		await renameUnshown(s, v, "Notes.pdf", "Paper.pdf");
		expect(sessionClaims(s, pane.id), "precondition: the session moved the claim back").toEqual(["Paper.pdf"]);
		syncFinishes(v, oldPath, sound);
		await s.checkedTick();
		await s.settle();
		expect(strokesIn(v, oldPath), "precondition: the heal saved the ink drawn under the lock").toEqual(["disk-ink", "during"]);
		expect(claimsIn(v, oldPath), "the name renamed back lost its claim").toEqual(["Paper.pdf"]);
	});

	it("renamed away under the lock, then the old name claimed again (as an open there claims it) before the file reads sound: it is a claim again", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await lockedOpen(v);
		s.close(pane.root);
		await s.settle();
		await renameUnshown(s, v);
		s.pdfStore.claimPath(pane.id, "Paper.pdf");
		expect(sessionClaims(s, pane.id), "precondition: the session claims both names").toEqual(["Notes.pdf", "Paper.pdf"]);
		syncFinishes(v, oldPath, sound);
		await s.checkedTick();
		await s.settle();
		expect(strokesIn(v, oldPath), "precondition: the heal saved the ink drawn under the lock").toEqual(["disk-ink", "during"]);
		expect(claimsIn(v, oldPath), "the name claimed again lost its claim").toEqual(["Notes.pdf", "Paper.pdf"]);
	});

	it("with a pane showing the PDF: renamed under the lock, the pane's heal leaves the record and the file claiming the new name only", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await lockedOpen(v);
		await renameShown(s, v);
		expect(sessionClaims(s, pane.id), "precondition: the session moved the claim").toEqual(["Notes.pdf"]);
		syncFinishes(v, oldPath, sound);
		await s.checkedTick();
		await s.settle();
		expect(s.pdfStore.inkReady(pane.id), "precondition: the pane's heal read the file").toBe(true);
		expect(strokesIn(v, oldPath), "precondition: the heal saved the ink drawn under the lock").toEqual(["disk-ink", "during"]);
		expect({ record: sessionClaims(s, pane.id), file: claimsIn(v, oldPath) }, "the heal brought the old name's claim back").toEqual({ record: ["Notes.pdf"], file: ["Notes.pdf"] });
	});

	it("with a pane showing the PDF and nothing drawn under the lock: renamed, then healed, the file claims the new name only", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await lockedOpenNothingDrawn(v);
		await renameShown(s, v);
		expect(sessionClaims(s, pane.id), "precondition: the session moved the claim").toEqual(["Notes.pdf"]);
		syncFinishes(v, oldPath, sound);
		await s.checkedTick();
		await s.settle();
		expect(s.pdfStore.inkReady(pane.id), "precondition: the pane's heal read the file").toBe(true);
		expect({ record: sessionClaims(s, pane.id), file: claimsIn(v, oldPath) }, "the heal left the old name claimed").toEqual({ record: ["Notes.pdf"], file: ["Notes.pdf"] });
	});

	it("with no pane and nothing drawn under the lock: renamed, then the ink file reads sound, the file claims the new name only and keeps its ink", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await lockedOpenNothingDrawn(v);
		s.close(pane.root);
		await s.settle();
		await renameUnshown(s, v);
		expect(sessionClaims(s, pane.id), "precondition: the session moved the claim").toEqual(["Notes.pdf"]);
		syncFinishes(v, oldPath, sound);
		await s.checkedTick();
		await s.settle();
		expect({ claims: claimsIn(v, oldPath), ink: strokesIn(v, oldPath) }, "the file still claims the old name").toEqual({ claims: ["Notes.pdf"], ink: ["disk-ink"] });
	});

	it("renamed twice under the lock with no pane (Paper, Notes, Final), then the ink file reads sound: the healed file claims the last name only", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await lockedOpen(v);
		s.close(pane.root);
		await s.settle();
		await renameUnshown(s, v);
		await renameUnshown(s, v, "Notes.pdf", "Final.pdf");
		expect(sessionClaims(s, pane.id), "precondition: the session moved the claim twice").toEqual(["Final.pdf"]);
		expect(s.pdfStore.inkReady(pane.id), "precondition: still locked").toBe(false);
		syncFinishes(v, oldPath, sound);
		await s.checkedTick();
		await s.settle();
		expect(strokesIn(v, oldPath), "precondition: the heal saved the ink drawn under the lock").toEqual(["disk-ink", "during"]);
		expect(claimsIn(v, oldPath), "a name renamed off under the lock came back").toEqual(["Final.pdf"]);
	});

	it("with a pane showing the PDF: renamed twice under the lock (Paper, Notes, Final), the pane's heal leaves the record and the file claiming the last name only", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await lockedOpen(v);
		await renameShown(s, v);
		await renameShown(s, v, "Notes.pdf", "Final.pdf");
		expect(sessionClaims(s, pane.id), "precondition: the session moved the claim twice").toEqual(["Final.pdf"]);
		syncFinishes(v, oldPath, sound);
		await s.checkedTick();
		await s.settle();
		expect(s.pdfStore.inkReady(pane.id), "precondition: the pane's heal read the file").toBe(true);
		expect({ record: sessionClaims(s, pane.id), file: claimsIn(v, oldPath) }, "a name renamed off under the lock came back").toEqual({ record: ["Final.pdf"], file: ["Final.pdf"] });
	});

	it("another device's newer ink file, still naming the old name, is adopted after a rename", async () => {
		await adoptedAfterRename(vault());
	});

	// A known case kept apart from this fix: adopting another device's newer file can still bring the old name back.
	it.fails("after that adoption, the old name does not come back", async () => {
		const { s, pane } = await adoptedAfterRename(vault());
		expect(sessionClaims(s, pane.id), "the adoption brought the old name's claim back").toEqual(["Notes.pdf"]);
	});

	it("with a pane showing the PDF: renamed under the lock and healed, another device's later file claiming both names is adopted with both", async () => {
		const v = vault();
		const { s, pane, oldPath, sound } = await lockedOpen(v);
		await renameShown(s, v);
		syncFinishes(v, oldPath, sound);
		await s.checkedTick();
		await s.settle();
		expect({ record: sessionClaims(s, pane.id), file: claimsIn(v, oldPath) }, "precondition: the heal claims the new name only").toEqual({ record: ["Notes.pdf"], file: ["Notes.pdf"] });
		// After the heal's save, another device that has a file at the old name claims it beside the new one.
		const healed = parsePage(v.adapter.files.get(oldPath)!, "x").data;
		v.adapter.externalWrite(oldPath, serializePage({ ...healed, pdfPaths: ["Notes.pdf", "Paper.pdf"], strokes: [...healed.strokes, stroke("remote", 300)] }));
		await s.checkedTick();
		await s.settle();
		expect(s.pdfStore.strokes(pane.id).map((k) => k.id), "precondition: the other device's ink was adopted").toContain("remote");
		expect(sessionClaims(s, pane.id), "the other device's claim on the old name was dropped after the heal").toEqual(["Notes.pdf", "Paper.pdf"]);
	});

	// No pane and no ink file: the record is let go at the close, so the rename finds no claim to move; the pane's
	// path (a rename during the open) is pinned in PdfRenameDuringIdentifyKeepsOldClaim.test.ts.
	it("a PDF with no ink file, opened and closed, then renamed with no pane: no ink file is written", async () => {
		const v = vault();
		const s = session(v);
		const pane = await s.open();
		s.close(pane.root);
		await s.settle();
		expect(sessionClaims(s, pane.id), "precondition: closed, the record was let go").toEqual([]);
		await renameUnshown(s, v);
		expect({ files: [...v.adapter.files.keys()], claims: sessionClaims(s, pane.id) }, "a rename of a PDF with no ink file wrote one").toEqual({ files: [], claims: [] });
	});
});

/** A sound rename is saved; then a device that has not seen it adds a stroke and saves, and that file is adopted. */
async function adoptedAfterRename(v: Vault) {
	const { first, oldPath, sound } = await seed(v);
	const s = session(v);
	const pane = await s.open();
	expect(pane.id).toBe(first.id);
	await renameShown(s, v);
	expect(claimsIn(v, oldPath), "precondition: the rename was saved").toEqual(["Notes.pdf"]);
	// Its file still claims the old name.
	const theirs = parsePage(sound, "x").data;
	v.adapter.externalWrite(oldPath, serializePage({ ...theirs, pdfPaths: ["Paper.pdf"], strokes: [...theirs.strokes, stroke("remote", 300)] }));
	await s.checkedTick();
	await s.settle();
	expect(s.pdfStore.strokes(pane.id).map((k) => k.id), "precondition: the other device's ink was adopted").toContain("remote");
	return { s, pane };
}
