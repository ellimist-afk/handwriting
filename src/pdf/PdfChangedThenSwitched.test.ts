// A PDF with ink changes on disk (a sync brings in an edited copy). One second later onPdfModified identifies every idle
// pane on it again and, once those identifications end, carries the old ink into the id each pane holds at that moment
// (PdfClaims.ts:442-445). If the user switches one of those panes in place to another, un-inked PDF meanwhile, the
// switch starts that PDF's own identification (PdfClaims.ts:153-159), which sets the pane's id before it loads
// (PdfClaims.ts:684). When that load ends before the change check's wait does, the check reads the other PDF's id and
// carries the old PDF's ink into it, with the "carried over" notice, and the copy is saved to the other PDF's ink file.
//
// Want, in every cell: carry only into the id this resolution set. The other PDF shows no ink, gets no ink file and no
// "carried over" notice, and the old PDF's ink is still there for the old PDF.
//
// Each cell names the read order it models. Both platforms run every vault file op in one queue, one at a time, in
// call order, as Obsidian's adapters do (CapacitorAdapter on mobile; the desktop adapter queues its own ops the same
// way). Every queued op takes OP_MS on the fake clock. The SHA-256 of a head runs off the queue and takes DIGEST_MS; it
// is the platform digest's own algorithm (the shipped fallback, which the identity tests pin to the platform's output),
// timed on the fake clock so the order is the same on every run.
// - Desktop: the head read is ranged, through node fs, outside the queue (PdfClaims.ts:90-104, :751-761). The changed
//   PDF's head read is slow (SLOW_HEAD_MS: a file a sync tool has just written can be held open by it or by a
//   scanner); the other PDF's is fast. One pane.
// - Mobile: the head read is the whole file, inside the queue (PdfClaims.ts:752-753); the changed PDF is big, so its
//   whole read takes WHOLE_A_MS. With one pane, that pane's read ends first and the check finds no id, so it skips. With
//   two idle panes on the changed PDF, the check also waits for pane 2's identification. When the new bytes are a
//   version that already has its own ink file (bytes going back to an earlier copy), pane 2 reads that file's claims
//   and loads it, more queued reads than the other PDF's whole open, so the other PDF's ink file loads first and the
//   carry goes into it. With new bytes that have no ink file, pane 2 keeps one queued op ahead of the other PDF and
//   ends before the other PDF's ink file has loaded, so nothing is carried there (boundary cells, at three timings).
// - A pane mid-gesture at the change is left alone and asked again once the file has been still for another settle
//   (PdfClaims.ts:413-416, :430). That second check carries the same way, so a switch during its identification is
//   the same fault (desktop, one pane, the slow head read).
// - The digest's time grows with what it hashes in the pins: the changed PDF's 64 KiB head against the other PDF's
//   small one, at a slow rate (the other PDF's whole open ends before pane 2's identification) and a fast one (pane 2
//   ends first). The want holds in both orders.
// Controls: no switch (the ink reaches the changed PDF's new version, said once), the held pane asked again with no
// switch, and the pane's file renamed during the check: a pane that still shows the changed PDF is carried as before.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { sha256 } from "./Sha256";
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

/** One queued vault op, ms on the fake clock. */
let OP_MS = 5;
/** One head digest, off the queue, ms on the fake clock. */
let DIGEST_MS = 1;
/** When set, a digest takes this many ms per KiB it hashes (at least 1) instead of DIGEST_MS. */
let DIGEST_MS_PER_KIB: number | null = null;
/** PdfClaims.ts:52: how long the file must stay still before a held pane is asked again. */
const SETTLE_MS = 1_000;
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

/**
 * The change check on A, and, SWITCH_AT_MS into it, pane 1 switched in place to B. Runs every identification it
 * started to its end, then flushes.
 */
async function changeCheckWithSwitch(s: ReturnType<typeof session>, pane: Pane | null) {
	shown.length = 0;
	const pass = s.plugin.onPdfModified("A.pdf");
	await vi.advanceTimersByTimeAsync(SWITCH_AT_MS);
	if (pane) s.switchTo(pane, "B.pdf");
	await drive(pass);
	await drive(Promise.all(s.resolutions));
	await drive(s.store.flush());
}

/**
 * The cells' want, on B's id: no ink shown, no ink file written. The notice is said once per check, not per pane, so
 * "carried over" is a fault only where no pane still on A had ink carried into it (`carriedOnA` false).
 */
function expectNothingCarriedInto(s: ReturnType<typeof session>, b: string, was: string, carriedOnA: boolean) {
	expect(b, "precondition: the switched pane is on B's own id").not.toBe(was);
	expect.soft(ids(s.pdfStore.strokes(b)), "B shows the old PDF's ink: carry only into the id this resolution set").toEqual([]);
	expect.soft(s.saved(b), "the old PDF's ink was saved to B's ink file: carry only into the id this resolution set").toBeNull();
	if (carriedOnA) expect.soft(shown.filter((m) => m === CARRIED_NOTICE), "one carry on A, said once").toHaveLength(1);
	else expect.soft(shown, "the user was told the old ink was carried over, and no pane on A had it carried").not.toContain(CARRIED_NOTICE);
}

/** Where an event happened: its first time, or its last ("identified A.pdf" is pane 1's early end, then pane 2's). */
const firstAt = (events: readonly string[], label: string) => events.indexOf(label);
const lastAt = (events: readonly string[], label: string) => events.lastIndexOf(label);
const inOrder = (a: number, b: number) => a >= 0 && b >= 0 && a < b;

it("desktop, one pane: switched to an un-inked PDF while the changed PDF's head read is slow, that PDF gets none of the old ink", async () => {
	const s = session("desktop");
	const pane = await s.open("A.pdf");
	s.pdfStore.commit(pane.id, stroke("a-ink"));
	await drive(s.store.flush());
	const oldFile = s.saved(pane.id);
	s.change();
	s.slowHeadFor("A.pdf");
	const from = s.events.length;
	await changeCheckWithSwitch(s, pane);
	const order = s.events.slice(from);
	expect(inOrder(lastAt(order, "identified B.pdf"), lastAt(order, "head read A.pdf")),`precondition, the order this cell models: B's open ends before A's head read; got ${order.join(", ")}`).toBe(true);
	const b = s.plugin.pdfIds.get(pane.root) as string;
	expectNothingCarriedInto(s, b, pane.id, false);
	expect.soft(s.saved(pane.id), "the old ink file is never written").toBe(oldFile);
	// Guard: A's ink is not lost. A opened again shows it on A's new version.
	const again = await s.open("A.pdf");
	expect(again.id, "A's new bytes, a new ink id").not.toBe(pane.id);
	expect.soft(ids(s.pdfStore.strokes(again.id)), "A's ink did not reach A's new version at its next open").toEqual(["a-ink"]);
});

const timings = [
	{ op: 5, digest: 1 },
	{ op: 1, digest: 100 },
	{ op: 20, digest: 1 },
];

for (const { op, digest } of timings) {
	it(`mobile, two panes, bytes back to a version with its own ink file (op ${op} ms, digest ${digest} ms): pane 1 switched to an un-inked PDF gets none of the old ink`, async () => {
		OP_MS = op;
		DIGEST_MS = digest;
		const s = session("mobile");
		const p1 = await s.open("A.pdf");
		const p2 = await s.open("A.pdf");
		s.pdfStore.commit(p1.id, stroke("first-version-ink"));
		await drive(s.store.flush());
		const first = s.pdfs.get("A.pdf")!;
		s.change();
		await drive(s.plugin.onPdfModified("A.pdf"));
		const second = s.plugin.pdfIds.get(p1.root) as string;
		expect(second, "precondition: the change gave A a new ink id").not.toBe(p1.id);
		expect(s.plugin.pdfIds.get(p2.root), "precondition: both panes moved").toBe(second);
		s.pdfStore.commit(second, stroke("second-version-ink"));
		await drive(s.store.flush());
		await vi.advanceTimersByTimeAsync(5000);
		expect(s.pdfStore.generation(p1.id), "precondition: the first version's record was forgotten, so its ink file is read again").toBeNull();
		s.pdfs.set("A.pdf", first);
		const from = s.events.length;
		await changeCheckWithSwitch(s, p1);
		const order = s.events.slice(from);
		const b = s.plugin.pdfIds.get(p1.root) as string;
		expect(inOrder(firstAt(order, `loaded ${b}`), lastAt(order, "identified A.pdf")),`precondition, the order this cell models: B's ink file loads before pane 2's identification ends; got ${order.join(", ")}`).toBe(true);
		expectNothingCarriedInto(s, b, second, false);
		// Guard: pane 2 is back on the first version's own ink file, with that file's ink.
		expect(s.plugin.pdfIds.get(p2.root), "pane 2 is on the first version's id").toBe(p1.id);
		expect.soft(ids(s.pdfStore.strokes(p1.id)), "pane 2 lost the first version's ink").toEqual(["first-version-ink"]);
	});
}

for (const { op, digest } of timings) {
	it(`boundary, mobile, two panes, new bytes with no ink file (op ${op} ms, digest ${digest} ms): pane 2 ends first, nothing goes to the switched pane's PDF`, async () => {
		OP_MS = op;
		DIGEST_MS = digest;
		const s = session("mobile");
		const p1 = await s.open("A.pdf");
		const p2 = await s.open("A.pdf");
		s.pdfStore.commit(p1.id, stroke("a-ink"));
		await drive(s.store.flush());
		s.change();
		const from = s.events.length;
		await changeCheckWithSwitch(s, p1);
		const order = s.events.slice(from);
		const b = s.plugin.pdfIds.get(p1.root) as string;
		expect(inOrder(lastAt(order, "identified A.pdf"), firstAt(order, `loaded ${b}`)),`precondition, the order this cell models: pane 2's identification ends before B's ink file loads; got ${order.join(", ")}`).toBe(true);
		expectNothingCarriedInto(s, b, p1.id, true);
		const a2 = s.plugin.pdfIds.get(p2.root) as string;
		expect(a2, "pane 2 moved to A's new version").not.toBe(p1.id);
		expect(ids(s.pdfStore.strokes(a2)), "pane 2's own identification carried A's ink into A's new version").toEqual(["a-ink"]);
	});
}

it("boundary, mobile, one pane: switched during the check, the pane's read ends first and nothing is carried", async () => {
	const s = session("mobile");
	const pane = await s.open("A.pdf");
	s.pdfStore.commit(pane.id, stroke("a-ink"));
	await drive(s.store.flush());
	s.change();
	await changeCheckWithSwitch(s, pane);
	expectNothingCarriedInto(s, s.plugin.pdfIds.get(pane.root) as string, pane.id, false);
});

it("control, desktop, one pane, no switch: the slow head read still ends with the ink carried into A's new version, said once", async () => {
	const s = session("desktop");
	const pane = await s.open("A.pdf");
	s.pdfStore.commit(pane.id, stroke("a-ink"));
	await drive(s.store.flush());
	s.change();
	s.slowHeadFor("A.pdf");
	await changeCheckWithSwitch(s, null);
	const now = s.plugin.pdfIds.get(pane.root) as string;
	expect(now).not.toBe(pane.id);
	expect(ids(s.pdfStore.strokes(now))).toEqual(["a-ink"]);
	expect(shown).toEqual([CARRIED_NOTICE]);
});

it("control, mobile, two panes, no switch: both panes end on A's new version with the ink, said once", async () => {
	const s = session("mobile");
	const p1 = await s.open("A.pdf");
	const p2 = await s.open("A.pdf");
	s.pdfStore.commit(p1.id, stroke("a-ink"));
	await drive(s.store.flush());
	s.change();
	await changeCheckWithSwitch(s, null);
	const now = s.plugin.pdfIds.get(p1.root) as string;
	expect(now).not.toBe(p1.id);
	expect(s.plugin.pdfIds.get(p2.root)).toBe(now);
	expect(ids(s.pdfStore.strokes(now))).toEqual(["a-ink"]);
	expect(shown).toEqual([CARRIED_NOTICE]);
});

for (const switched of [true, false]) {
	const label = switched
		? "desktop, one pane mid-gesture at the change, asked again after the settle, then switched to an un-inked PDF during that second identification: that PDF gets none of the old ink"
		: "control, desktop, one pane mid-gesture at the change, asked again after the settle, no switch: the ink reaches A's new version, said once";
	it(label, async () => {
		const s = session("desktop");
		const pane = await s.open("A.pdf");
		s.pdfStore.commit(pane.id, stroke("a-ink"));
		await drive(s.store.flush());
		const oldFile = s.saved(pane.id);
		s.change();
		s.slowHeadFor("A.pdf");
		const controller = s.plugin.pdfInk.get(pane.root) as { idle: boolean };
		controller.idle = false;
		shown.length = 0;
		const from = s.events.length;
		await s.plugin.onPdfModified("A.pdf");
		expect(s.plugin.pdfIds.get(pane.root), "precondition: the pane mid-gesture kept its id at the first check").toBe(pane.id);
		expect(s.events.length, "precondition: the first check identified nothing").toBe(from);
		controller.idle = true;
		const checks = s.passes.length;
		await vi.advanceTimersByTimeAsync(SETTLE_MS);
		const retry = s.passes[checks];
		expect(retry, "precondition: the held pane was asked again after the settle").toBeDefined();
		expect([...(retry!.panes ?? [])], "precondition: asked again for the held pane only").toEqual([pane.root]);
		expect(s.plugin.pdfIds.get(pane.root), "precondition: the second check is identifying the pane again").toBeUndefined();
		await vi.advanceTimersByTimeAsync(SWITCH_AT_MS);
		if (switched) s.switchTo(pane, "B.pdf");
		await drive(retry!.done);
		await drive(Promise.all(s.resolutions));
		await drive(s.store.flush());
		const order = s.events.slice(from);
		if (switched) {
			expect(inOrder(lastAt(order, "identified B.pdf"), lastAt(order, "head read A.pdf")), `precondition, the order this cell models: B's open ends before A's head read; got ${order.join(", ")}`).toBe(true);
			expectNothingCarriedInto(s, s.plugin.pdfIds.get(pane.root) as string, pane.id, false);
			expect.soft(s.saved(pane.id), "the old ink file is never written").toBe(oldFile);
			const again = await s.open("A.pdf");
			expect(again.id, "A's new bytes, a new ink id").not.toBe(pane.id);
			expect.soft(ids(s.pdfStore.strokes(again.id)), "A's ink did not reach A's new version at its next open").toEqual(["a-ink"]);
		} else {
			const now = s.plugin.pdfIds.get(pane.root) as string;
			expect(now, "the second check gave the pane A's new id").not.toBe(pane.id);
			expect(ids(s.pdfStore.strokes(now)), "the held pane's ink reached A's new version").toEqual(["a-ink"]);
			expect(shown, "said once").toEqual([CARRIED_NOTICE]);
			expect(s.saved(pane.id), "the old ink file is never written").toBe(oldFile);
		}
	});
}

it("control, desktop, one pane, the file renamed during the check's slow head read: the pane still shows the changed PDF, so the ink reaches its new version, said once", async () => {
	const s = session("desktop");
	const pane = await s.open("A.pdf");
	s.pdfStore.commit(pane.id, stroke("a-ink"));
	await drive(s.store.flush());
	const oldFile = s.saved(pane.id);
	s.change();
	s.slowHeadFor("A.pdf");
	shown.length = 0;
	const from = s.events.length;
	const pass = s.plugin.onPdfModified("A.pdf");
	await vi.advanceTimersByTimeAsync(SWITCH_AT_MS);
	s.rename(pane, "C.pdf");
	expect(s.plugin.pdfPaneHoldsClaim("C.pdf"), "precondition: the pane being identified holds the claim, so the handler moves none").toBe(true);
	await drive(pass);
	await drive(Promise.all(s.resolutions));
	await drive(s.store.flush());
	const order = s.events.slice(from);
	expect(inOrder(firstAt(order, "rename to C.pdf"), lastAt(order, "head read A.pdf")), `precondition: renamed inside A's head read; got ${order.join(", ")}`).toBe(true);
	const now = s.plugin.pdfIds.get(pane.root) as string;
	expect(s.plugin.pdfFiles.get(pane.root), "the pane is on the new name").toBe("C.pdf");
	expect(now, "the check gave the pane the new bytes' id").not.toBe(pane.id);
	expect(ids(s.pdfStore.strokes(now)), "the renamed pane's ink reached its new version").toEqual(["a-ink"]);
	expect(shown, "said once").toEqual([CARRIED_NOTICE]);
	expect(s.saved(pane.id), "the old ink file is never written").toBe(oldFile);
});

// The digest's time grows with what it hashes: A's head is 64 KiB, B's about 3 KiB. Slow: 3 ms per KiB, so pane 2's
// digest of A outlasts B's whole open and B's ink file loads first. Fast: 1 ms each, and pane 2 ends first.
const digestRates = [
	{ rate: 3, name: "slow, 3 ms per KiB", bFirst: true },
	{ rate: 1 / 64, name: "fast, 1 ms each", bFirst: false },
];

for (const { rate, name, bFirst } of digestRates) {
	it(`pin, mobile, two panes, new bytes with no ink file, the digest growing with the head's size (${name}): nothing goes to the switched pane's PDF, pane 2 has the ink`, async () => {
		const s = session("mobile");
		const p1 = await s.open("A.pdf");
		const p2 = await s.open("A.pdf");
		s.pdfStore.commit(p1.id, stroke("a-ink"));
		await drive(s.store.flush());
		s.change();
		DIGEST_MS_PER_KIB = rate;
		const from = s.events.length;
		await changeCheckWithSwitch(s, p1);
		const order = s.events.slice(from);
		const b = s.plugin.pdfIds.get(p1.root) as string;
		const bLoaded = firstAt(order, `loaded ${b}`);
		const pane2Ended = lastAt(order, "identified A.pdf");
		expect(bFirst ? inOrder(bLoaded, pane2Ended) : inOrder(pane2Ended, bLoaded), `precondition, the order this cell models: ${bFirst ? "B's ink file loads before pane 2's identification ends" : "pane 2's identification ends before B's ink file loads"}; got ${order.join(", ")}`).toBe(true);
		expectNothingCarriedInto(s, b, p1.id, true);
		const a2 = s.plugin.pdfIds.get(p2.root) as string;
		expect(a2, "pane 2 moved to A's new version").not.toBe(p1.id);
		expect(ids(s.pdfStore.strokes(a2)), "pane 2's own identification carried A's ink into A's new version").toEqual(["a-ink"]);
	});
}
