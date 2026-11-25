// A PDF with ink is open and changes on disk; it changes again while the change check that followed is still
// identifying the pane (a sync that lands a big PDF in two writes more than a second apart, two quick saves from another
// app). The second check finds the pane with no id, or with the first identification's id and no ink, so it takes no
// ink record for it, and starts its own identification; the first check then skips the pane, because the pane's
// identification is no longer its own (the rule that keeps a tab switched to another PDF free of the changed one's
// ink). Nobody carries: the tab shows the newest version blank, nothing is said, and the next open in the session uses
// that version's claim, so the ink is not carried then either.
//
// Want: a pane that shows the changed PDF from the first change until the checks end has its old ink carried into the
// id it ends on, once, with today's notice, however many changes land while a check runs. The ink record a check took
// for a pane passes to the pane's newer identification of the same PDF; it is dropped only when the pane leaves that
// PDF. A pane switched to another PDF still gets nothing, and the changed PDF is carried at its next open.
//
// The rig is the one in PdfChangedThenSwitched.test.ts, unchanged: one queue for every vault op, the digest off it, the
// changed PDF's ranged head read slow on desktop. The first cell is a review's probe, copied as written.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { sha256 } from "./Sha256";
import { pdfInkId } from "./PdfIdentity";
import type { InkStroke } from "../ink/Stroke";

// What the plugin told the user through Obsidian's Notice. The stub's Notice is an empty class, so it is replaced here.
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
const KEPT_NOTICE = "Handwriting: this PDF changed on disk. Ink drawn before the change is kept in its old ink file; new ink goes to a new one.";

/** One queued vault op, ms on the fake clock. */
let OP_MS = 5;
/** One head digest, off the queue, ms on the fake clock. */
let DIGEST_MS = 1;
/** When set, a digest takes this many ms per KiB it hashes (at least 1) instead of DIGEST_MS. */
let DIGEST_MS_PER_KIB: number | null = null;
/** Mobile: the whole read of the big changed PDF, one queued op. */
const WHOLE_A_MS = 80;
/** Desktop: the changed PDF's ranged head read, outside the queue. */
const SLOW_HEAD_MS = 300;
/** Desktop: any other ranged head read. */
const FAST_HEAD_MS = 1;
/** How long after the check starts the user switches the pane: inside the changed PDF's head read on both platforms. */
const SWITCH_AT_MS = 10;

const after = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const desktopApp = Platform.isDesktopApp;
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
	shown.length = 0;
	OP_MS = 5;
	DIGEST_MS = 1;
	DIGEST_MS_PER_KIB = null;
	vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (_algorithm, data) => {
		const bytes = new Uint8Array(data as ArrayBuffer);
		const out = sha256(bytes);
		await after(DIGEST_MS_PER_KIB === null ? DIGEST_MS : Math.max(1, Math.ceil((bytes.byteLength / 1024) * DIGEST_MS_PER_KIB)));
		return out.slice().buffer;
	});
});
afterEach(() => {
	Platform.isDesktopApp = desktopApp;
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
const ids = (strokes: readonly InkStroke[]) => strokes.map((s) => s.id);

/** Run the fake clock far past every op and digest the work can start, then hand back its result. */
async function drive<T>(work: Promise<T>, ms = 10_000): Promise<T> {
	work.catch(() => {});
	await vi.advanceTimersByTimeAsync(ms);
	return work;
}

/** Every op waits for the one before it to settle, then takes its time: CapacitorAdapter's `this.promise.then(t, t)`. */
function oneQueue(opMs: (label: string) => number) {
	let tail: Promise<unknown> = Promise.resolve();
	function run<T>(label: string, op: () => Promise<T>): Promise<T> {
		const step = async () => {
			await after(opMs(label));
			return op();
		};
		const next = tail.then(step, step);
		tail = next.then(() => undefined, () => undefined);
		return next;
	}
	return { run };
}

function pdf(fill: string, length: number) {
	return new TextEncoder().encode("%PDF-1.4\n" + fill.repeat(length) + "\n%%EOF\n");
}

type Pane = { root: HTMLElement; leaf: { view: { file: { path: string }; containerEl: HTMLElement } }; id: string };

function session(platform: "desktop" | "mobile") {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
		getFullPath?: (path: string) => string;
	};
	adapter.list = async (folder) => ({
		files: [...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	// A is the inked PDF that changes (more than 64 KiB, so its head is a part of it); B is a small un-inked PDF.
	const pdfs = new Map([["A.pdf", pdf("a", 70000)], ["B.pdf", pdf("b", 3000)]]);
	const queue = oneQueue((label) => (label === "readBinary A.pdf" ? WHOLE_A_MS : OP_MS));
	for (const name of ["exists", "read", "write", "rename", "remove", "mkdir", "stat", "list"] as const) {
		const own = (adapter[name] as (...args: unknown[]) => Promise<unknown>).bind(adapter);
		(adapter as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => queue.run(`${name} ${String(args[0])}`, () => own(...args));
	}
	const readBinary = (file: { path: string }) => queue.run(`readBinary ${file.path}`, async () => pdfs.get(file.path)!.slice().buffer);
	/** What happened, in order: head reads ended, ink files loaded, identifications ended, switches. */
	const events: string[] = [];
	let slowHead: string | null = null;
	Platform.isDesktopApp = platform === "desktop";
	if (platform === "desktop") {
		// The ranged read's node fs, as openRangedFile reaches it through the renderer's require.
		adapter.getFullPath = (path) => `/vault/${path}`;
		vi.stubGlobal("require", (mod: string) => {
			if (mod !== "fs") throw new Error(`no ${mod} here`);
			return {
				promises: {
					open: async (full: string) => {
						const path = full.slice("/vault/".length);
						// An open handle reads the file it opened, also after a rename.
						const file = pdfs.get(path)!;
						return {
							read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
								await after(path === slowHead ? SLOW_HEAD_MS : FAST_HEAD_MS);
								events.push(`head read ${path}`);
								const bytes = file.subarray(position, position + length);
								buffer.set(bytes, offset);
								return { bytesRead: bytes.length };
							},
							stat: async () => ({ size: file.length }),
							close: async () => {},
						};
					},
				},
			};
		});
	}
	const store = new PageStore({ vault: { adapter } } as never);
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({
		load: (id, options) => store.load(id, options),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	const ensureLoaded = pdfStore.ensureLoaded.bind(pdfStore);
	pdfStore.ensureLoaded = async (id: string) => {
		const loaded = await ensureLoaded(id);
		events.push(`loaded ${id}`);
		return loaded;
	};
	const leaves: Pane["leaf"][] = [];
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app: {
			workspace: { getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []) },
			vault: { adapter, readBinary, getFileByPath: (p: string) => (pdfs.has(p) ? { path: p, extension: "pdf" } : null) },
		},
		store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map(),
	});
	// Every identification, the one the in-place switch starts included, so a cell can wait for each to end.
	const resolutions: Promise<void>[] = [];
	const resolve = plugin.resolvePdfId as (...args: unknown[]) => Promise<void>;
	plugin.resolvePdfId = function (this: unknown, ...args: unknown[]) {
		const path = (args[0] as Pane["leaf"]).view.file.path;
		const done = resolve.apply(this, args);
		resolutions.push(done);
		done.then(() => events.push(`identified ${path}`), () => {});
		return done;
	};
	// Every change check, the one a held pane's settle starts included, with the panes it was asked for.
	const passes: { panes: ReadonlySet<HTMLElement> | null | undefined; done: Promise<void> }[] = [];
	const check = plugin.onPdfModified as (...args: unknown[]) => Promise<void>;
	plugin.onPdfModified = function (this: unknown, ...args: unknown[]) {
		const done = check.apply(this, args);
		passes.push({ panes: args[1] as ReadonlySet<HTMLElement> | null | undefined, done });
		return done;
	};
	async function open(path: string): Promise<Pane> {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, idle: true };
		const leaf = { view: { file: { path }, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await drive(plugin.resolvePdfId(leaf, root, controller));
		const id = plugin.pdfIds.get(root) as string;
		expect(id, "production resolution must bind a PDF identity").toMatch(/^pdf-[0-9a-f]+(?:-\d+)?$/);
		return { root, leaf, id };
	}
	/** The user opens another file in the same tab: the leaf's file changes, and the plugin's own sync sees it. */
	function switchTo(pane: Pane, path: string) {
		events.push(`switch to ${path}`);
		pane.leaf.view.file = { path };
		plugin.syncPdfControllers();
	}
	/**
	 * The pane's file renamed: the TFile moves, then the live-pane half of the plugin's "rename" handler
	 * (PluginOnload.ts:298-312), its own calls in its order. Its last step, a claim move for a path no pane holds
	 * (:320), does not run for a pane being identified (pdfPaneHoldsClaim); the cell checks that premise.
	 */
	function rename(pane: Pane, to: string) {
		const from = pane.leaf.view.file.path;
		events.push(`rename to ${to}`);
		pdfs.set(to, pdfs.get(from)!);
		pdfs.delete(from);
		pane.leaf.view.file.path = to;
		pdfStore.notePdfRenamed(from, to);
		for (const [root, p] of plugin.pdfFiles as Map<HTMLElement, string>) {
			if (p !== from) continue;
			plugin.pdfFiles.set(root, to);
			const id = plugin.pdfIds.get(root);
			if (id) pdfStore.renamePath(id, from, to);
		}
		plugin.movePdfModifiedOnRename(from, to);
	}
	/** Change A's bytes: a head byte, so A's new version is a new ink id. */
	function change() {
		const changed = pdfs.get("A.pdf")!.slice();
		changed[100] = changed[100] === 121 ? 122 : 121;
		pdfs.set("A.pdf", changed);
	}
	return {
		adapter, pdfs, events, store, pdfStore, plugin, open, switchTo, rename, change, resolutions, passes,
		slowHeadFor: (path: string | null) => (slowHead = path),
		saved: (id: string) => adapter.files.get(store.path(id)) ?? null,
	};
}

/** Give A's bytes version `n`: a head byte, so each version is its own ink id, and no two versions here are equal. */
function version(s: ReturnType<typeof session>, n: number) {
	const changed = s.pdfs.get("A.pdf")!.slice();
	changed[100] = 110 + n;
	s.pdfs.set("A.pdf", changed);
}

/** A open in one pane with one stroke saved; its ink file's bytes. */
async function inkedA(s: ReturnType<typeof session>) {
	const pane = await s.open("A.pdf");
	s.pdfStore.commit(pane.id, stroke("a-ink"));
	await drive(s.store.flush());
	return { pane, oldFile: s.saved(pane.id) };
}

/** The want on a pane that stayed on A: A's ink on the id it ends on, said once, and there again at A's next open. */
async function expectCarriedOnce(s: ReturnType<typeof session>, pane: Pane, oldFile: string | null) {
	const now = s.plugin.pdfIds.get(pane.root) as string;
	expect(now, "precondition: the pane is on a new id").not.toBe(pane.id);
	expect(s.saved(pane.id), "the old ink file is never written").toBe(oldFile);
	expect.soft(ids(s.pdfStore.strokes(now)), "the tab that stayed shows A's ink on the newest version").toEqual(["a-ink"]);
	expect.soft(shown, "said once, the carry's own notice").toEqual([CARRIED_NOTICE]);
	const again = await s.open("A.pdf");
	expect.soft(ids(s.pdfStore.strokes(again.id)), "A's next open shows its ink").toEqual(["a-ink"]);
}

it("desktop, one pane, no switch: A changes, and changes again while the first check's slow head read runs; the tab that stayed shows A's ink on the newest version", async () => {
	const s = session("desktop");
	const pane = await s.open("A.pdf");
	s.pdfStore.commit(pane.id, stroke("a-ink"));
	await drive(s.store.flush());
	const oldFile = s.saved(pane.id);
	s.change();
	s.slowHeadFor("A.pdf");
	shown.length = 0;
	const pass1 = s.plugin.onPdfModified("A.pdf");
	await vi.advanceTimersByTimeAsync(SWITCH_AT_MS);
	s.change();
	const pass2 = s.plugin.onPdfModified("A.pdf");
	await drive(pass1);
	await drive(pass2);
	await drive(Promise.all(s.resolutions));
	await drive(s.store.flush());
	const now = s.plugin.pdfIds.get(pane.root) as string;
	expect(now, "precondition: the pane is on a new id").not.toBe(pane.id);
	expect(s.saved(pane.id), "the old ink file is never written").toBe(oldFile);
	expect.soft(ids(s.pdfStore.strokes(now)), "the tab that stayed shows no ink until the PDF is opened again").toEqual(["a-ink"]);
	expect.soft(shown, "nothing was said").toEqual([CARRIED_NOTICE]);
	const again = await s.open("A.pdf");
	expect.soft(ids(s.pdfStore.strokes(again.id)), "A's ink did not come back at its next open").toEqual(["a-ink"]);
});

it("N1-three desktop, one pane: A changes three times, each while the check before it still reads A's head; the tab shows A's ink on the newest version, said once", async () => {
	const s = session("desktop");
	const { pane, oldFile } = await inkedA(s);
	s.slowHeadFor("A.pdf");
	shown.length = 0;
	version(s, 1);
	const pass1 = s.plugin.onPdfModified("A.pdf");
	await vi.advanceTimersByTimeAsync(SWITCH_AT_MS);
	version(s, 2);
	const pass2 = s.plugin.onPdfModified("A.pdf");
	await vi.advanceTimersByTimeAsync(SWITCH_AT_MS);
	version(s, 3);
	const pass3 = s.plugin.onPdfModified("A.pdf");
	await drive(Promise.all([pass1, pass2, pass3]));
	await drive(Promise.all(s.resolutions));
	await drive(s.store.flush());
	expect(s.events.filter((e) => e === "head read A.pdf").length, "precondition: each check's identification read A's head").toBeGreaterThanOrEqual(3);
	await expectCarriedOnce(s, pane, oldFile);
});

it("N1-load desktop, one pane: A changes again while the first check's identification loads the new version's ink file, the pane already on that id; the tab shows A's ink on the newest version, said once", async () => {
	const s = session("desktop");
	const { pane, oldFile } = await inkedA(s);
	version(s, 1);
	let pass2: Promise<void> | null = null;
	let loading = "";
	let held: string | undefined;
	const load = s.pdfStore.ensureLoaded;
	s.pdfStore.ensureLoaded = async (id: string) => {
		if (pass2 === null && id !== pane.id) {
			loading = id;
			held = s.plugin.pdfIds.get(pane.root) as string | undefined;
			version(s, 2);
			pass2 = s.plugin.onPdfModified("A.pdf");
		}
		return load(id);
	};
	shown.length = 0;
	const pass1 = s.plugin.onPdfModified("A.pdf");
	await drive(pass1);
	expect(pass2, "precondition: the second change came during the first identification's load").not.toBeNull();
	expect(held, "precondition: the second check found the pane on the first identification's id").toBe(loading);
	await drive(pass2!);
	await drive(Promise.all(s.resolutions));
	await drive(s.store.flush());
	await expectCarriedOnce(s, pane, oldFile);
});

it("N1-two-panes desktop: A open in two idle panes changes again during the first check; both tabs show A's ink on the newest version, said once", async () => {
	const s = session("desktop");
	const { pane, oldFile } = await inkedA(s);
	const second = await s.open("A.pdf");
	expect(second.id, "precondition: both panes on A's one ink file").toBe(pane.id);
	s.slowHeadFor("A.pdf");
	shown.length = 0;
	version(s, 1);
	const pass1 = s.plugin.onPdfModified("A.pdf");
	await vi.advanceTimersByTimeAsync(SWITCH_AT_MS);
	version(s, 2);
	const pass2 = s.plugin.onPdfModified("A.pdf");
	await drive(Promise.all([pass1, pass2]));
	await drive(Promise.all(s.resolutions));
	await drive(s.store.flush());
	const other = s.plugin.pdfIds.get(second.root) as string;
	expect.soft(ids(s.pdfStore.strokes(other)), "the second tab shows A's ink on the newest version").toEqual(["a-ink"]);
	await expectCarriedOnce(s, pane, oldFile);
});

it("N1-switch desktop, one pane: A changes, changes again during the first check, and the tab is switched to B during the second; B gets nothing, nothing is said, and A's next open carries its ink", async () => {
	const s = session("desktop");
	const { pane, oldFile } = await inkedA(s);
	s.slowHeadFor("A.pdf");
	shown.length = 0;
	version(s, 1);
	const pass1 = s.plugin.onPdfModified("A.pdf");
	await vi.advanceTimersByTimeAsync(SWITCH_AT_MS);
	version(s, 2);
	const pass2 = s.plugin.onPdfModified("A.pdf");
	await vi.advanceTimersByTimeAsync(SWITCH_AT_MS);
	s.switchTo(pane, "B.pdf");
	await drive(Promise.all([pass1, pass2]));
	await drive(Promise.all(s.resolutions));
	await drive(s.store.flush());
	const b = s.plugin.pdfIds.get(pane.root) as string;
	expect(b, "precondition: the switched pane is on B's own id").not.toBe(pane.id);
	expect.soft(ids(s.pdfStore.strokes(b)), "B shows A's ink").toEqual([]);
	expect.soft(s.saved(b), "A's ink was saved to B's ink file").toBeNull();
	expect.soft(shown, "a notice for a tab that left A").toEqual([]);
	expect(s.saved(pane.id), "the old ink file is never written").toBe(oldFile);
	const again = await s.open("A.pdf");
	expect(again.id, "A's newest bytes, a new ink id").not.toBe(pane.id);
	expect.soft(ids(s.pdfStore.strokes(again.id)), "A's ink did not reach A's newest version at its next open").toEqual(["a-ink"]);
	expect.soft(shown, "A's next open says it carried").toEqual([CARRIED_NOTICE]);
});

it("N1-switch-then-B-changes desktop, one pane: A changes, the tab is switched to B during A's check, and B changes while the switch still identifies B; B gets nothing, nothing is said, and A's next open carries its ink", async () => {
	const s = session("desktop");
	const { pane, oldFile } = await inkedA(s);
	s.slowHeadFor("A.pdf");
	shown.length = 0;
	version(s, 1);
	const pass1 = s.plugin.onPdfModified("A.pdf");
	await vi.advanceTimersByTimeAsync(SWITCH_AT_MS);
	s.switchTo(pane, "B.pdf");
	expect(s.events.includes("identified B.pdf"), "precondition: the switch's identification of B is still running").toBe(false);
	const changedB = s.pdfs.get("B.pdf")!.slice();
	changedB[100] = 120;
	s.pdfs.set("B.pdf", changedB);
	const passB = s.plugin.onPdfModified("B.pdf");
	await drive(Promise.all([pass1, passB]));
	await drive(Promise.all(s.resolutions));
	await drive(s.store.flush());
	expect(s.events.filter((e) => e === "identified B.pdf").length, "precondition: B's check identified the pane again").toBeGreaterThanOrEqual(2);
	const b = s.plugin.pdfIds.get(pane.root) as string;
	expect(b, "precondition: the switched pane is on B's own id").not.toBe(pane.id);
	expect.soft(ids(s.pdfStore.strokes(b)), "B shows A's ink").toEqual([]);
	expect.soft(s.saved(b), "A's ink was saved to B's ink file").toBeNull();
	expect.soft(shown, "a notice for a tab that left A").toEqual([]);
	expect(s.saved(pane.id), "the old ink file is never written").toBe(oldFile);
	const again = await s.open("A.pdf");
	expect(again.id, "A's newest bytes, a new ink id").not.toBe(pane.id);
	expect.soft(ids(s.pdfStore.strokes(again.id)), "A's ink did not reach A's newest version at its next open").toEqual(["a-ink"]);
	expect.soft(shown, "A's next open says it carried").toEqual([CARRIED_NOTICE]);
});

// The cells below pin the hand-off's own edges: what a check took for a pane and passed on is dropped only when the
// pane leaves the PDF, a pane busy at a change is left to the check that holds it, and nothing a check took outlives
// the check.

/** The second tab's load of A's middle version ends this long after the first tab's identification ended. */
const SECOND_TAB_LOAD_MS = 100;

it("N1-own-beside desktop, two panes: A's middle version has an ink file of its own; one tab is on it, showing that ink, while the other is still identified, and A changes again while the other tab is mid-stroke; the tab that stayed shows A's old ink beside the middle version's on the newest version", async () => {
	const s = session("desktop");
	const { pane, oldFile } = await inkedA(s);
	const second = await s.open("A.pdf");
	expect(second.id, "precondition: both panes on A's one ink file").toBe(pane.id);
	// The middle version, with an ink file of its own that claims A.pdf (synced in from another device), released.
	version(s, 1);
	const middle = await drive(pdfInkId(s.pdfs.get("A.pdf")!, globalThis.crypto));
	await drive(s.pdfStore.ensureLoaded(middle));
	s.pdfStore.claimPath(middle, "A.pdf");
	s.pdfStore.commit(middle, stroke("middle-ink"));
	await drive(s.store.flush());
	s.plugin.releasePdfId(middle);
	await drive(Promise.resolve());
	const middleFile = s.saved(middle);
	expect(middleFile, "precondition: the middle version's own ink file is on disk").not.toBeNull();
	// The second ask to load the middle version's ink file returns at once, the first one's read still out
	// (PdfInkStore.loadRecord); here it ends only after that read landed, and late, so that tab's identification
	// runs on after the other's.
	let loads = 0;
	const load = s.pdfStore.ensureLoaded;
	s.pdfStore.ensureLoaded = async (id: string) => {
		const late = id === middle && ++loads === 2;
		const loaded = await load(id);
		if (late) {
			for (let ms = 0; ms < 2_000 && !s.pdfStore.inkReady(middle); ms++) await after(1);
			await after(SECOND_TAB_LOAD_MS);
		}
		return loaded;
	};
	shown.length = 0;
	const before = s.resolutions.length;
	const pass1 = s.plugin.onPdfModified("A.pdf");
	const tabs = [pane, second];
	const ended = [false, false];
	s.resolutions.slice(before).forEach((r, n) => void r.then(() => (ended[n] = true)));
	for (let ms = 0; ms < 2_000 && !ended[0] && !ended[1]; ms++) await vi.advanceTimersByTimeAsync(1);
	expect(ended[0] !== ended[1],
		`precondition: one tab's identification ended while the other's runs (${ended.join(", ")}, loads ${loads}; ${s.events.join(", ")})`).toBe(true);
	// The tab identified first stays on A, idle; the other is mid-stroke when A changes again.
	const stayed = ended[0] ? tabs[0]! : tabs[1]!;
	const held = ended[0] ? tabs[1]! : tabs[0]!;
	expect(s.plugin.pdfIds.get(stayed.root), "precondition: the tab that stays is on the middle version").toBe(middle);
	expect(ids(s.pdfStore.strokes(middle)),
		`precondition: the tab that stays shows the middle version's own ink (read landed ${s.pdfStore.inkReady(middle)})`).toEqual(["middle-ink"]);
	// A changes again while the other tab is mid-stroke: that check holds it, and asks it again after the stroke.
	const busy = s.plugin.pdfInk.get(held.root) as { idle: boolean };
	busy.idle = false;
	version(s, 2);
	s.slowHeadFor("A.pdf");
	const pass2 = s.plugin.onPdfModified("A.pdf");
	busy.idle = true;
	await drive(Promise.all([pass1, pass2]));
	await drive(Promise.all(s.passes.map((p) => p.done)));
	await drive(Promise.all(s.resolutions));
	await drive(s.store.flush());
	expect(s.passes.some((p) => p.panes?.has(held.root) === true), "precondition: the busy tab was asked again after its stroke").toBe(true);
	const now = s.plugin.pdfIds.get(stayed.root) as string;
	expect(now, "precondition: the tab that stayed is on A's newest version").not.toBe(middle);
	expect(now, "precondition: the tab that stayed is on a new id").not.toBe(pane.id);
	expect(s.plugin.pdfIds.get(held.root), "precondition: the busy tab ends on the newest version too").toBe(now);
	expect(s.saved(pane.id), "the old ink file is never written").toBe(oldFile);
	expect(s.saved(middle), "the middle version's own ink file is never written").toBe(middleFile);
	expect.soft(ids(s.pdfStore.strokes(now)).sort(), "the tab that stayed shows A's old ink beside the middle version's").toEqual(["a-ink", "middle-ink"]);
	expect.soft(shown, "the busy tab's check finds the middle version with ink of its own, the tab that stayed carries").toEqual([KEPT_NOTICE, CARRIED_NOTICE]);
	const again = await s.open("A.pdf");
	expect.soft(ids(s.pdfStore.strokes(again.id)).sort(), "A's next open shows both").toEqual(["a-ink", "middle-ink"]);
});

it("N2-held desktop, one pane: A changes, and changes again while the tab is mid-stroke during the first check; the first check carries into the version it found, and the check that waited for the stroke carries that on to the newest version", async () => {
	const s = session("desktop");
	const { pane, oldFile } = await inkedA(s);
	const busy = s.plugin.pdfInk.get(pane.root) as { idle: boolean };
	s.slowHeadFor("A.pdf");
	shown.length = 0;
	version(s, 1);
	const pass1 = s.plugin.onPdfModified("A.pdf");
	let middle: string | undefined;
	let middleInk: string[] = [];
	void pass1.then(() => {
		middle = s.plugin.pdfIds.get(pane.root) as string | undefined;
		middleInk = middle === undefined ? [] : ids(s.pdfStore.strokes(middle));
	});
	await vi.advanceTimersByTimeAsync(SWITCH_AT_MS);
	busy.idle = false;
	version(s, 2);
	const pass2 = s.plugin.onPdfModified("A.pdf");
	busy.idle = true;
	await drive(Promise.all([pass1, pass2]));
	await drive(Promise.all(s.passes.map((p) => p.done)));
	await drive(Promise.all(s.resolutions));
	await drive(s.store.flush());
	expect(s.passes.some((p) => p.panes?.has(pane.root) === true), "precondition: the busy tab was asked again after its stroke").toBe(true);
	expect(middle, "precondition: the first check put the tab on a new id").toBeDefined();
	expect(middle, "precondition: the first check put the tab on a new id").not.toBe(pane.id);
	expect.soft(middleInk, "the first check carried A's ink into the version it found").toEqual(["a-ink"]);
	const now = s.plugin.pdfIds.get(pane.root) as string;
	expect(now, "precondition: the tab ends on A's newest version").not.toBe(middle);
	expect(now, "precondition: the tab ends on a new id").not.toBe(pane.id);
	expect(s.saved(pane.id), "the old ink file is never written").toBe(oldFile);
	expect.soft(ids(s.pdfStore.strokes(now)), "the check that waited for the stroke carried A's ink on").toEqual(["a-ink"]);
	expect.soft(shown, "each check says its own carry").toEqual([CARRIED_NOTICE, CARRIED_NOTICE]);
	const again = await s.open("A.pdf");
	expect.soft(ids(s.pdfStore.strokes(again.id)), "A's next open shows its ink").toEqual(["a-ink"]);
});

it("N1-later desktop, one pane: A changes and its ink is carried; the user erases that stroke and draws another; A changes again long after; the newest version shows only what the tab showed", async () => {
	const s = session("desktop");
	const { pane, oldFile } = await inkedA(s);
	shown.length = 0;
	version(s, 1);
	await drive(s.plugin.onPdfModified("A.pdf"));
	await drive(Promise.all(s.resolutions));
	const middle = s.plugin.pdfIds.get(pane.root) as string;
	expect(middle, "precondition: the first check put the tab on a new id").not.toBe(pane.id);
	expect(ids(s.pdfStore.strokes(middle)), "precondition: the first check carried A's ink").toEqual(["a-ink"]);
	s.pdfStore.replaceAll(middle, []);
	s.pdfStore.commit(middle, stroke("b-ink"));
	await drive(s.store.flush());
	version(s, 2);
	await drive(s.plugin.onPdfModified("A.pdf"));
	await drive(Promise.all(s.resolutions));
	await drive(s.store.flush());
	const now = s.plugin.pdfIds.get(pane.root) as string;
	expect(now, "precondition: the tab ends on A's newest version").not.toBe(middle);
	expect(s.saved(pane.id), "the old ink file is never written").toBe(oldFile);
	expect.soft(ids(s.pdfStore.strokes(now)), "the erased stroke stays erased on the newest version").toEqual(["b-ink"]);
	expect.soft(shown, "each check says its own carry").toEqual([CARRIED_NOTICE, CARRIED_NOTICE]);
	const again = await s.open("A.pdf");
	expect.soft(ids(s.pdfStore.strokes(again.id)), "A's next open shows what the tab showed").toEqual(["b-ink"]);
});

it("N1-third-after-first desktop, one pane: A changes, changes again during the first check, and a third time just as the first check ends while the second still reads A's head; the tab shows A's ink on the newest version, said once", async () => {
	const s = session("desktop");
	const { pane, oldFile } = await inkedA(s);
	s.slowHeadFor("A.pdf");
	shown.length = 0;
	version(s, 1);
	const pass1 = s.plugin.onPdfModified("A.pdf");
	await vi.advanceTimersByTimeAsync(SWITCH_AT_MS);
	version(s, 2);
	const pass2 = s.plugin.onPdfModified("A.pdf");
	let idAtThird: string | null | undefined = null;
	const pass3 = pass1.then(() => {
		idAtThird = s.plugin.pdfIds.get(pane.root) as string | undefined;
		version(s, 3);
		return s.plugin.onPdfModified("A.pdf");
	});
	await drive(Promise.all([pass1, pass2, pass3]));
	await drive(Promise.all(s.resolutions));
	await drive(s.store.flush());
	expect(idAtThird, "precondition: the first check ended while the second check's identification ran").toBeUndefined();
	await expectCarriedOnce(s, pane, oldFile);
});
