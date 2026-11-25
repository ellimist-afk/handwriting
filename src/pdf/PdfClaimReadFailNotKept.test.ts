/**
 * A claim read that fails after a good stat. Opening a PDF with no ink reads the claims of every other PDF ink file
 * (PageStore.readPdfClaim): the file is stat'ed, then its claims are read (readPdfPaths), and the answer is kept by
 * the file's mtime and size, so an unchanged file is not read again this session. A read that throws answers "no
 * claim" (paths null), and that null is kept the same way: until the ink file changes on disk, every later open takes
 * it as an ink file that claims nothing. A PDF changed while closed then reopens blank, nothing owed, for the session.
 *
 * Want: a failed read is not kept; the next look reads the file again. Written red-first at 64021dfb (test only).
 * Control: the last cell, the carry with no failed read, copied unchanged from PdfFreshOpenClaimReads.test.ts.
 * The rig is that file's, copied unchanged from its imports to its first cell (its helpers are not exported).
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
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

const CARRIED_NOTICE = "Handwriting: this PDF changed on disk. Your ink was carried over to its new version.";

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
		const id = plugin.pdfIds.get(root) as string;
		expect(id, "production resolution must bind a PDF identity").toMatch(/^pdf-[0-9a-f]+(?:-\d+)?$/);
		return { root, id };
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

const K = 6;

/** K inked PDFs, each its own family, written and closed; then a fresh session, as after a restart. */
async function inkedVault() {
	const v = vault();
	const first = session(v);
	const inked: string[] = [];
	for (let k = 0; k < K; k++) {
		const path = `Inked ${k}.pdf`;
		v.pdfs.set(path, pdf(k));
		const opened = await first.open(path);
		first.pdfStore.commit(opened.id, stroke(`s${k}`));
		await first.store.flush();
		inked.push(await first.store.resolvePath(opened.id));
		first.close(opened.root);
	}
	await vi.advanceTimersByTimeAsync(5000);
	v.pdfs.set("Fresh.pdf", pdf(40));
	const s = session(v);
	const reads: string[] = [];
	const read = v.adapter.read.bind(v.adapter);
	v.adapter.read = async (path: string) => (reads.push(path), read(path));
	const inkReads = () => reads.filter((p) => inked.includes(p));
	return { v, s, inked, reads, inkReads };
}

/** The next `times` reads of `path` throw, as a busy or locked file's read does after its stat answered. */
function readFails(v: ReturnType<typeof vault>, path: string, times = 1) {
	const read = v.adapter.read.bind(v.adapter);
	const state = { failed: 0 };
	v.adapter.read = async (p: string) => {
		if (p === path && state.failed < times) {
			state.failed++;
			throw new Error(`EBUSY injected read ${p}`);
		}
		return read(p);
	};
	return state;
}

const idOf = (file: string) => file.split("/").pop()!.slice(0, -".json".length);

it("store: an ink file whose claim read failed once after a good stat is read again while it is unchanged on disk", async () => {
	const { v, s, inked } = await inkedVault();
	const file = inked[3]!;
	const fail = readFails(v, file);
	const first = await s.store.readPdfClaim(idOf(file));
	expect(fail.failed, "precondition: the claim read failed once").toBe(1);
	expect(first?.paths, "precondition: the failed read answers no claim").toBeNull();
	expect(first?.mtime, "precondition: the stat answered (a failed look answers mtime 0)").toBeGreaterThan(0);
	const second = await s.store.readPdfClaim(idOf(file));
	expect(second?.paths, "a claim read that failed after a good stat was kept as no claim for the unchanged file").toEqual(["Inked 3.pdf"]);
});

it("open: a PDF changed while closed reopens with its ink after an earlier open's claim read of its ink file failed once", async () => {
	const { v, s, inked } = await inkedVault();
	const fail = readFails(v, inked[3]!);
	const fresh = await s.open("Fresh.pdf");
	expect(fail.failed, "precondition: the first open's claim read of Inked 3's ink file failed").toBe(1);
	s.close(fresh.root);
	const before = v.pdfs.get("Inked 3.pdf")!;
	const after = before.slice();
	after[200] = 122;
	v.pdfs.set("Inked 3.pdf", after);
	const reopened = await s.open("Inked 3.pdf");
	expect(reopened.id, "precondition: the changed PDF opened under a fresh id").not.toBe(idOf(inked[3]!));
	expect(s.pdfStore.strokesOnPage(reopened.id, 1).map((x) => x.id), "the PDF changed while closed reopened blank: the failed claim read was kept as no claim").toEqual(["s3"]);
	expect(shown, "the carried notice was not shown").toContain(CARRIED_NOTICE);
});

// Control, copied unchanged: no read fails, the carry happens.
it("the carry still happens: a PDF changed while closed reopens with its ink after an earlier open read every claim", async () => {
	const { v, s } = await inkedVault();
	const fresh = await s.open("Fresh.pdf");
	s.close(fresh.root);
	const before = v.pdfs.get("Inked 3.pdf")!;
	const after = before.slice();
	after[200] = 122;
	v.pdfs.set("Inked 3.pdf", after);
	const reopened = await s.open("Inked 3.pdf");
	expect(s.pdfStore.strokesOnPage(reopened.id, 1).map((x) => x.id)).toEqual(["s3"]);
	expect(shown).toContain(CARRIED_NOTICE);
});

// The cost, by call count: a claim that was read is read once a session while its file is unchanged on disk.

/** Every read of `path` from here on, failed ones too (wrap after readFails). */
function readsOf(v: ReturnType<typeof vault>, path: string) {
	const read = v.adapter.read.bind(v.adapter);
	const state = { count: 0 };
	v.adapter.read = async (p: string) => {
		if (p === path) state.count++;
		return read(p);
	};
	return state;
}

it("count: an unchanged ink file's claim is read once in a session, however often it is asked", async () => {
	const { v, s, inked } = await inkedVault();
	const file = inked[2]!;
	const reads = readsOf(v, file);
	for (let k = 0; k < 3; k++) expect((await s.store.readPdfClaim(idOf(file)))?.paths, `look ${k + 1}`).toEqual(["Inked 2.pdf"]);
	expect(reads.count, "an unchanged ink file's claim was read more than once").toBe(1);
});

it("count: after a failed read the next look reads the file once more, and the look after that reads nothing", async () => {
	const { v, s, inked } = await inkedVault();
	const file = inked[2]!;
	const fail = readFails(v, file);
	const reads = readsOf(v, file);
	const counts: number[] = [];
	const answers: (string[] | null | undefined)[] = [];
	for (let k = 0; k < 3; k++) {
		answers.push((await s.store.readPdfClaim(idOf(file)))?.paths);
		counts.push(reads.count);
	}
	expect(fail.failed, "precondition: the first read failed").toBe(1);
	expect(answers, "the claim the three looks answered").toEqual([null, ["Inked 2.pdf"], ["Inked 2.pdf"]]);
	expect(counts, "the reads after each look: one failed, one more, then none").toEqual([1, 2, 2]);
});

// The other road to a failed look kept as "no claim": the claim read asks `exists` before it reads, and Obsidian's
// `exists` answers false on any error (a denied access, a busy disk). Armed at the ink file's stat and held for the
// whole look: a single false on the first `exists` is taken by the second path resolve, which still lands on the same
// file, and the look then reads it.

/** From the next stat of `path` until the cell disarms it, `exists` answers false for `path`. */
function existsFalseFromStat(v: ReturnType<typeof vault>, path: string) {
	const stat = v.adapter.stat.bind(v.adapter);
	const exists = v.adapter.exists.bind(v.adapter);
	const state = { armed: false, stats: 0, falses: 0 };
	v.adapter.stat = async (p: string) => {
		if (p === path && state.stats++ === 0) state.armed = true;
		return stat(p);
	};
	v.adapter.exists = async (p: string) => {
		if (p === path && state.armed) {
			state.falses++;
			return false;
		}
		return exists(p);
	};
	return state;
}

it("store: an ink file whose exists answered false through one look after a good stat is read again while it is unchanged on disk", async () => {
	const { v, s, inked } = await inkedVault();
	const file = inked[3]!;
	const fault = existsFalseFromStat(v, file);
	const first = await s.store.readPdfClaim(idOf(file));
	fault.armed = false;
	expect(fault.stats, "precondition: the first look stat'ed the ink file, arming the fault").toBe(1);
	expect(first?.mtime, "precondition: the stat answered (a failed look answers mtime 0)").toBeGreaterThan(0);
	const second = await s.store.readPdfClaim(idOf(file));
	expect(second?.paths, "a look whose exists answered false after a good stat was kept as no claim for the unchanged file").toEqual(["Inked 3.pdf"]);
});

// A damaged ink file. `readPdfPaths` answers null for it as for a failed read and cannot say which, so its null is not
// kept either: an unchanged damaged file is read once per look and claims nothing each time (a pick: reads 2 over two
// looks, not 1). The claim read stays on `readPdfPaths`, the road the suite's rigs hook.
it("count: an unchanged damaged ink file is read again each look, and claims nothing each look", async () => {
	const { v, s, inked } = await inkedVault();
	const file = inked[4]!;
	v.adapter.externalWrite(file, "{ damaged");
	const reads = readsOf(v, file);
	const answers: (string[] | null | undefined)[] = [];
	for (let k = 0; k < 2; k++) answers.push((await s.store.readPdfClaim(idOf(file)))?.paths);
	expect(answers, "a damaged ink file claims nothing").toEqual([null, null]);
	expect(reads.count, "an unchanged damaged ink file's null was kept: read once over two looks").toBe(2);
});
