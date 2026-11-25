/**
 * A PDF loaded sound and shown in a pane, whose ink file a sync client is writing when the live-reload poll reads it:
 * the poll's read finds the file damaged. Read through the store's own reload of a loaded record, that read locks the
 * record and keeps what it showed, and the next sound read joins the file and the session by stroke id, so a stroke
 * erased on either side comes back and is saved back. These cells run the production poll, open and save over a real
 * page store, with the harness of PdfRenamedWhileLockedClaim.test.ts, and ask the same of the app's own road:
 *
 * - the ink file reads damaged at a poll, then sound with another device's erase;
 * - the same, with the stroke erased here in between and the file then reading sound as it was.
 *
 * Either way the erase stands: the stroke is not on screen once the file reads sound, and not in the next save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { parsePage, serializePage } from "../model/PageData";
import { PdfInkStore } from "./PdfInkStore";
import { installLiveReloadPoll } from "../testUtils/LiveReloadTestHarness";
import type { InkStroke } from "../ink/Stroke";

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class Notice {
		constructor(_message: string) {}
	}
	return { ...actual, Notice };
});

// An ink file caught mid-write by a sync client: it does not parse.
const TRUNCATED = '{"surface":"pdf","strokes":[';

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
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

/** One session: the production plugin methods over a real page store, and the production poll. */
function session(v: Vault) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({
		load: (id, options) => store.load(id, options),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => undefined,
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
	return { store, pdfStore, plugin, errors, open, checkedTick, settle };
}

type Session = ReturnType<typeof session>;

const strokesIn = (v: Vault, path: string): string[] => {
	const raw = v.adapter.files.get(path);
	expect(raw, `ink file exists: ${path}`).toBeDefined();
	return parsePage(raw!, "x").data.strokes.map((s) => s.id);
};

/** What the pane draws for `id`. */
const onScreen = (s: Session, id: string): string[] => s.pdfStore.strokes(id).map((k) => k.id);

/** The same ink file with one stroke erased, as another device writes it. */
function erasedThere(sound: string, strokeId: string): string {
	const page = parsePage(sound, "x").data;
	return serializePage({ ...page, strokes: page.strokes.filter((k) => k.id !== strokeId) });
}

/**
 * An earlier session drew "old" and "keep" on Paper.pdf and saved them. This session opens the PDF and reads the
 * file sound; then a sync client is writing the ink file when the poll reads it, so that read finds it damaged. A
 * few seconds pass after that poll.
 */
async function loadedThenDamagedAtPoll(v: Vault) {
	const writer = session(v);
	const first = await writer.open();
	writer.pdfStore.commit(first.id, stroke("old"));
	writer.pdfStore.commit(first.id, stroke("keep", 100));
	await writer.store.flush();
	const path = writer.store.path(first.id);
	const sound = v.adapter.files.get(path)!;
	expect(strokesIn(v, path), "precondition: the earlier session saved its ink").toEqual(["old", "keep"]);

	const s = session(v);
	const pane = await s.open();
	expect(pane.id, "precondition: the open found the ink file's id").toBe(first.id);
	expect({ ready: s.pdfStore.inkReady(pane.id), screen: onScreen(s, pane.id) }, "precondition: the PDF loaded sound").toEqual({ ready: true, screen: ["old", "keep"] });

	v.adapter.externalWrite(path, TRUNCATED);
	await s.checkedTick();
	await s.settle();
	expect(s.store.externalChangeObservation(pane.id), "precondition: the poll read the file while it was damaged").toBe("changed");
	expect({ screen: onScreen(s, pane.id), file: v.adapter.files.get(path) }, "precondition: the damaged read kept the screen and wrote nothing").toEqual({ screen: ["old", "keep"], file: TRUNCATED });
	await vi.advanceTimersByTimeAsync(5000);
	return { s, pane, path, sound };
}

describe("a loaded PDF whose ink file reads damaged at a poll: an erase stands once the file reads sound", () => {
	it("the file then reads sound with another device's erase: the stroke stays off the screen and out of the next save", async () => {
		const v = vault();
		const { s, pane, path, sound } = await loadedThenDamagedAtPoll(v);
		v.adapter.externalWrite(path, erasedThere(sound, "old"));
		const refreshes = pane.controller.refresh.mock.calls.length;
		await s.checkedTick();
		await s.settle();
		const screen = { strokes: onScreen(s, pane.id), repainted: pane.controller.refresh.mock.calls.length > refreshes };
		s.pdfStore.commit(pane.id, stroke("next", 200));
		await s.settle();
		expect({ screen, saved: strokesIn(v, path) }, "the other device's erase was undone").toEqual({ screen: { strokes: ["keep"], repainted: true }, saved: ["keep", "next"] });
	});

	it("the stroke erased here in between, then the file reads sound as it was: the stroke stays off the screen and out of the next save", async () => {
		const v = vault();
		const { s, pane, path, sound } = await loadedThenDamagedAtPoll(v);
		// A finished erase reaches the store as the PDF op sink sends it at pen-up (PdfClaims.ts): the whole new list.
		s.pdfStore.replaceAll(pane.id, s.pdfStore.strokes(pane.id).filter((k) => k.id !== "old"));
		v.adapter.externalWrite(path, sound);
		await s.checkedTick();
		await s.settle();
		await s.checkedTick();
		await s.settle();
		const screen = onScreen(s, pane.id);
		s.pdfStore.commit(pane.id, stroke("next", 200));
		await s.settle();
		expect({ screen, saved: strokesIn(v, path) }, "the stroke erased here came back").toEqual({ screen: ["keep"], saved: ["keep", "next"] });
	});
});
