// A PDF replaced by its own flattened copy: the copy is the PDF's bytes and then one update of this plugin's Flatten,
// with the ink drawn into its pages. Saved over the PDF (copied over it in a file manager, saved from another app, or
// brought back by a sync), its bytes are new, so it opens on a fresh ink id, and the old version's ink file still
// claims the path. Both carry roads then laid that ink over the ink already drawn in: each stroke twice, highlights two
// coats, and the carried notice. With the tab open, the change check carries (onPdfModified). With it closed, the next
// open carries (carryFromOldContent).
//
// Want: a copy proven to be that version plus our own Flatten gets none of the old ink on either road. The tab shows
// the new id with no stroke of its own, the shipped kept notice is said once, and the old ink file is never written.
// Ink drawn after the copy was made stays in the old file too. A second open in the same app session says nothing
// more. Pins (green before the fix, and after): a head byte changed by another program, a flattened copy of another
// PDF saved over A, and A plus another program's incremental update each still carry A's ink with the carried notice.
//
// Added from the break read (addendum 1): a stroke drawn on the new id while the check may still read the file keeps
// the carry beside it, each once; the own copy with such a stroke keeps the stroke alone. A flattened copy of a version
// the tab was handed, arriving while that version's check runs, gets nothing from either older version. A flattened
// copy of a byte-identical twin (another instance of A's family) saved over A still carries A's own ink. A second open
// of the own copy reads the PDF whole once, for its id.
//
// The rig is PdfChangedWhileOpening.test.ts's, unchanged (copied by tools/gen-cells.sh, lines 35-321 less what these
// cells do not use). A is a real PDF built by test/pdf-fixture, over 64 KiB unless a cell says small, so its head is a
// part of it. The copy is appendInkToPdf's own output over A with A's stored strokes.
//
// Held back in 1.5.2 (FOLLOWUPS 556): neither road asks the proof, so a copy saved over its PDF carries as on 1.5.1.
// Every stroke shows, a stroke drawn on A after the copy was made included, and the drawn-in ones twice: in the copy's
// pages and on the carried overlay. The own-copy cells are expected failures (it.fails) until that row brings the
// no-carry back; the pins stay green. The cells at the end want the carry, on road 1, road 2 and a tab busy across the
// change.
import { appendInkToPdf } from "../ink/InkPdfAppend";
import { bytesOf } from "./PdfSyntax";
import { familyOf } from "./PdfIdentity";
import { document, streamObject, streamedDocument } from "../../test/pdf-fixture";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { parsePage } from "../model/PageData";
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
const KEPT_NOTICE = "Handwriting: this PDF changed on disk. Ink drawn before the change is kept in its old ink file; new ink goes to a new one.";

/** One queued vault op, ms on the fake clock. */
const OP_MS = 5;
/** One head digest, off the queue, ms on the fake clock. */
const DIGEST_MS = 1;
/** Mobile: the whole read of the big changed PDF, one queued op. */
const WHOLE_A_MS = 80;
/** Desktop: the changed PDF's ranged head read, outside the queue. */
const SLOW_HEAD_MS = 300;
/** Desktop: any other ranged head read. */
const FAST_HEAD_MS = 1;

const after = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const desktopApp = Platform.isDesktopApp;
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
	shown.length = 0;
	vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (_algorithm, data) => {
		const out = sha256(new Uint8Array(data as ArrayBuffer));
		await after(DIGEST_MS);
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

type Leaf = { view: { file: { path: string } | undefined; containerEl: HTMLElement } };
type Pane = { root: HTMLElement; leaf: Leaf; id: string };
type Opening = { root: HTMLElement; leaf: Leaf; done: Promise<void> };

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
		events.push(`load ${id}`);
		const loaded = await ensureLoaded(id);
		events.push(`loaded ${id}`);
		return loaded;
	};
	const leaves: Leaf[] = [];
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
		const path = (args[0] as Leaf).view.file?.path;
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
	/** A tab opens the file: the plugin's sync mounts a controller and starts the pane's identification (an opening). */
	function startOpen(path: string): Opening {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, idle: true };
		const leaf: Leaf = { view: { file: { path }, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		return { root, leaf, done: plugin.resolvePdfId(leaf, root, controller) };
	}
	async function open(path: string): Promise<Pane> {
		const { root, leaf, done } = startOpen(path);
		await drive(done);
		const id = plugin.pdfIds.get(root) as string;
		expect(id, "production resolution must bind a PDF identity").toMatch(/^pdf-[0-9a-f]+(?:-\d+)?$/);
		return { root, leaf, id };
	}
	/** The tab closes: syncPdfControllers' sweep of a pane whose view is gone (PdfClaims.ts:329-337). */
	async function close(pane: Pane) {
		leaves.splice(leaves.indexOf(pane.leaf), 1);
		plugin.pdfInk.delete(pane.root);
		plugin.pdfIds.delete(pane.root);
		plugin.pdfFiles.delete(pane.root);
		plugin.releasePdfId(pane.id);
		await drive(Promise.resolve());
	}
	/** The user opens another file in the same tab: the leaf's file changes, and the plugin's own sync sees it. */
	function switchTo(pane: { leaf: Leaf }, path: string) {
		events.push(`switch to ${path}`);
		pane.leaf.view.file = { path };
		plugin.syncPdfControllers();
	}
	/** The view's file is back at its path: the leaf's file is set again, and the plugin's sync runs, as at the next layout
	 * change or leaf activation (PluginOnload.ts:398-400). */
	function fileBack(pane: { leaf: Leaf }, path: string) {
		events.push(`file back ${path}`);
		pane.leaf.view.file = { path };
		plugin.syncPdfControllers();
	}
	/** Hold the next load of `id`'s ink file until released: the record waits with its load in flight. */
	function holdLoad(id: string) {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		let reached = false;
		const load = store.load.bind(store);
		store.load = (async (pageId: string, options?: { restore?: boolean }) => {
			if (pageId === id && !reached) {
				reached = true;
				await gate;
			}
			return load(pageId, options);
		}) as typeof store.load;
		return { reached: () => reached, release: () => release() };
	}
	return {
		adapter, pdfs, events, store, pdfStore, plugin, startOpen, open, close, switchTo, fileBack, holdLoad, resolutions, passes,
		slowHeadFor: (path: string | null) => (slowHead = path),
		saved: (id: string) => adapter.files.get(store.path(id)) ?? null,
	};
}
type Session = ReturnType<typeof session>;

/** Every check, the held ones' retries included, and every identification, to their ends; then every write. */
async function settleAll(s: Session) {
	for (let n = 0; n < 3; n++) await drive(Promise.all([...s.passes.map((p) => p.done), ...s.resolutions]));
	await drive(s.store.flush());
}

/** The want on a tab that stayed on A: A's ink on its newest version (`want`, in any order), the carried notice once for
 * each carry made, and the same ink at A's next open. */
async function expectCarried(s: Session, root: HTMLElement, oldId: string, oldFile: string | null, notices = [CARRIED_NOTICE],
	want = ["a-ink"]) {
	const now = s.plugin.pdfIds.get(root) as string | undefined;
	expect(now, "precondition: the tab is on an id").toBeDefined();
	expect(now, "precondition: the tab is on a new id").not.toBe(oldId);
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
	expect.soft(ids(s.pdfStore.strokes(now!)).sort(), "the tab shows A's ink on the new version").toEqual(want);
	expect.soft(shown, "said once for each carry made, the carry's own notice").toEqual(notices);
	const again = await s.open("A.pdf");
	expect.soft(again.id, "the tab is on A's newest version, the one a new tab opens").toBe(now);
	expect.soft(ids(s.pdfStore.strokes(again.id)).sort(), "A's next open shows its ink").toEqual(want);
}

/** The ink ids in `id`'s ink file on disk, sorted; null when there is no file. */
function onDisk(s: Session, id: string): string[] | null {
	const raw = s.saved(id);
	return raw === null ? null : ids(parsePage(raw, id).data.strokes).sort();
}

// ---- the PDFs: real ones, from the fixture, and the copies Flatten makes of them

/** A's one page draws text; `pad` adds an unreferenced stream so the file passes the 64 KiB head. */
function realPdf(text: string, pad: number, streamed = false): string {
	const after = [streamObject(`BT /F1 12 Tf (${text}) Tj ET`), ...(pad > 0 ? [streamObject("%" + text[0]!.repeat(pad))] : [])];
	return streamed ? streamedDocument(1, () => "/Contents 4 0 R ", after) : document(1, () => "/Contents 4 0 R ", "", after);
}
const BIG = 70_000;

/** The flattened copy Flatten writes of `base` with `strokes`. */
function flattened(base: Uint8Array, strokes: readonly InkStroke[]): Uint8Array {
	const r = appendInkToPdf(base, strokes);
	if (!r.ok) throw new Error(`precondition: Flatten refused: ${r.reason}`);
	expect(r.bytes.length, "precondition: the copy is longer than A").toBeGreaterThan(base.length);
	return r.bytes;
}

/** Another program's incremental update over a fixture document: its page gains a note annotation, its own table. */
function foreignUpdate(src: string): Uint8Array {
	const prev = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(src)![1]);
	const page = /\n3 0 obj\n(<<[^\n]*>>)\nendobj\n/.exec(src)![1]!;
	const size = Number(/\/Size (\d+)/.exec(src)![1]);
	const pad = (n: number) => String(n).padStart(10, "0");
	let out = src;
	const atPage = out.length;
	out += `3 0 obj\n${page.slice(0, -2)}/Annots [${size} 0 R] >>\nendobj\n`;
	const atNote = out.length;
	out += `${size} 0 obj\n<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (note) >>\nendobj\n`;
	const xref = out.length;
	out += `xref\n0 1\n0000000000 65535 f \n3 1\n${pad(atPage)} 00000 n \n${size} 1\n${pad(atNote)} 00000 n \n`;
	out += `trailer\n<< /Size ${size + 1} /Root 1 0 R /Prev ${prev} >>\nstartxref\n${xref}\n%%EOF\n`;
	return bytesOf(out);
}

const pen = stroke("a-ink");
const highlight: InkStroke = { ...stroke("a-hl"), tool: "highlighter", color: "#ffd60a", width: 12 };

/** A in one pane with a pen stroke and a highlight saved; its id and its ink file's bytes. */
async function inkedReal(s: Session, base: Uint8Array) {
	s.pdfs.set("A.pdf", new Uint8Array(base));
	const pane = await s.open("A.pdf");
	s.pdfStore.commit(pane.id, pen);
	s.pdfStore.commit(pane.id, highlight);
	await drive(s.store.flush());
	const oldFile = s.saved(pane.id);
	expect(oldFile, "precondition: A's ink file is on disk").not.toBeNull();
	expect(onDisk(s, pane.id), "precondition: A's ink file holds both strokes").toEqual(["a-hl", "a-ink"]);
	return { pane, oldId: pane.id, oldFile };
}

/** The want on a tab whose PDF is now its own flattened copy: no stroke on the new id, the kept notice once, the old
 * ink file as it was. */
function expectNotCarried(s: Session, root: HTMLElement, oldId: string, oldFile: string | null) {
	const now = s.plugin.pdfIds.get(root) as string | undefined;
	expect(now, "precondition: the tab is on an id").toBeDefined();
	expect(now, "precondition: the tab is on a new id").not.toBe(oldId);
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
	expect.soft(ids(s.pdfStore.strokes(now!)), "the copy's drawn-in ink is not laid over again: no stroke on its new id").toEqual([]);
	expect.soft(shown, "the shipped kept notice, once; never the carried notice").toEqual([KEPT_NOTICE]);
}

/** Road 1: A open in a tab, its file replaced by `copy`, the change check run. */
async function replacedWhileOpen(platform: "desktop" | "mobile", base: Uint8Array, copyOf: (strokes: readonly InkStroke[]) => Uint8Array) {
	const s = session(platform);
	const { pane, oldId, oldFile } = await inkedReal(s, base);
	s.pdfs.set("A.pdf", new Uint8Array(copyOf(s.pdfStore.strokes(oldId))));
	shown.length = 0;
	s.plugin.onPdfModified("A.pdf");
	await settleAll(s);
	return { s, pane, oldId, oldFile };
}

/** Road 2: A inked and its tab closed, its file replaced by `copy` while no tab showed it, then opened. */
async function replacedWhileClosed(platform: "desktop" | "mobile", base: Uint8Array, copyOf: (strokes: readonly InkStroke[]) => Uint8Array,
	late?: InkStroke) {
	const s = session(platform);
	const { pane, oldId } = await inkedReal(s, base);
	const copy = copyOf(s.pdfStore.strokes(oldId));
	if (late) {
		s.pdfStore.commit(oldId, late);
		await drive(s.store.flush());
	}
	const oldFile = s.saved(oldId);
	await s.close(pane);
	expect(s.pdfStore.generation(oldId), "precondition: A's ink record was forgotten at the close").toBeNull();
	s.pdfs.set("A.pdf", new Uint8Array(copy));
	shown.length = 0;
	const again = await s.open("A.pdf");
	await settleAll(s);
	return { s, pane: again, oldId, oldFile };
}

const A_BIG = () => bytesOf(realPdf("hello", BIG));
const ownCopy = (base: Uint8Array) => (strokes: readonly InkStroke[]) => flattened(base, strokes);

// The cells: A replaced by its own flattened copy.

it.fails("held back in 1.5.2: own copy, road 1 desktop: A open, its file replaced by its flattened copy; no ink laid over the drawn-in ink, the kept notice", async () => {
	const base = A_BIG();
	const { s, pane, oldId, oldFile } = await replacedWhileOpen("desktop", base, ownCopy(base));
	expectNotCarried(s, pane.root, oldId, oldFile);
});

it.fails("held back in 1.5.2: own copy, road 1 mobile: A open, its file replaced by its flattened copy; no ink laid over the drawn-in ink, the kept notice", async () => {
	const base = A_BIG();
	const { s, pane, oldId, oldFile } = await replacedWhileOpen("mobile", base, ownCopy(base));
	expectNotCarried(s, pane.root, oldId, oldFile);
});

it.fails("held back in 1.5.2: own copy, road 1 desktop, streamed table: A's newest table is a stream, replaced by its flattened copy; no ink laid over, the kept notice", async () => {
	const base = bytesOf(realPdf("hello", BIG, true));
	const { s, pane, oldId, oldFile } = await replacedWhileOpen("desktop", base, ownCopy(base));
	expectNotCarried(s, pane.root, oldId, oldFile);
});

it.fails("held back in 1.5.2: own copy, road 2 desktop: A closed, its file replaced by its flattened copy, A opened; no ink laid over the drawn-in ink, the kept notice", async () => {
	const base = A_BIG();
	const { s, pane, oldId, oldFile } = await replacedWhileClosed("desktop", base, ownCopy(base));
	expectNotCarried(s, pane.root, oldId, oldFile);
});

it.fails("held back in 1.5.2: own copy, road 2 mobile: A closed, its file replaced by its flattened copy, A opened; no ink laid over the drawn-in ink, the kept notice", async () => {
	const base = A_BIG();
	const { s, pane, oldId, oldFile } = await replacedWhileClosed("mobile", base, ownCopy(base));
	expectNotCarried(s, pane.root, oldId, oldFile);
});

it.fails("held back in 1.5.2: own copy, road 2 desktop, small A: A under 64 KiB, so the copy's head reaches into the update; no ink laid over, the kept notice", async () => {
	const base = bytesOf(realPdf("hello", 0));
	expect(base.length, "precondition: A is under the 64 KiB head").toBeLessThan(64 * 1024);
	const { s, pane, oldId, oldFile } = await replacedWhileClosed("desktop", base, ownCopy(base));
	expectNotCarried(s, pane.root, oldId, oldFile);
});

it.fails("held back in 1.5.2: own copy, road 2 desktop, ink drawn after the copy was made: that stroke stays in A's ink file and is not carried either", async () => {
	const base = A_BIG();
	const { s, pane, oldId, oldFile } = await replacedWhileClosed("desktop", base, ownCopy(base), stroke("a-late"));
	expect(onDisk(s, oldId), "precondition: A's ink file holds the stroke drawn after the copy").toEqual(["a-hl", "a-ink", "a-late"]);
	expectNotCarried(s, pane.root, oldId, oldFile);
});

it.fails("held back in 1.5.2: own copy, road 2 desktop, opened again in the same app session: the kept notice is not said a second time", async () => {
	const base = A_BIG();
	const { s, pane, oldId, oldFile } = await replacedWhileClosed("desktop", base, ownCopy(base));
	expectNotCarried(s, pane.root, oldId, oldFile);
	await s.close(pane);
	const again = await s.open("A.pdf");
	await settleAll(s);
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
	expect.soft(ids(s.pdfStore.strokes(again.id)), "the second open lays nothing over either").toEqual([]);
	expect.soft(shown, "said once in the app session").toEqual([KEPT_NOTICE]);
});

// The pins: A's ink still carries when the new bytes are not A plus our own Flatten.

it("pin, road 2 desktop: a head byte of A changed by another program; A's ink is carried, said once", async () => {
	const base = A_BIG();
	const { s, pane, oldId, oldFile } = await replacedWhileClosed("desktop", base, () => {
		const changed = base.slice();
		changed[100] = 0x20;
		return changed;
	});
	await expectCarried(s, pane.root, oldId, oldFile, [CARRIED_NOTICE], ["a-hl", "a-ink"]);
});

it("pin, road 2 desktop: a flattened copy of another PDF saved over A; A's ink is carried, said once", async () => {
	const other = bytesOf(realPdf("other", BIG));
	const { s, pane, oldId, oldFile } = await replacedWhileClosed("desktop", A_BIG(), ownCopy(other));
	await expectCarried(s, pane.root, oldId, oldFile, [CARRIED_NOTICE], ["a-hl", "a-ink"]);
});

it("pin, road 1 mobile: a flattened copy of another PDF saved over A while open; A's ink is carried, said once", async () => {
	const other = bytesOf(realPdf("other", BIG));
	const { s, pane, oldId, oldFile } = await replacedWhileOpen("mobile", A_BIG(), ownCopy(other));
	await expectCarried(s, pane.root, oldId, oldFile, [CARRIED_NOTICE], ["a-hl", "a-ink"]);
});

it("pin, road 2 desktop: A plus another program's incremental update (a note added); A's ink is carried, said once", async () => {
	const src = realPdf("hello", BIG);
	const { s, pane, oldId, oldFile } = await replacedWhileClosed("desktop", bytesOf(src), () => foreignUpdate(src));
	await expectCarried(s, pane.root, oldId, oldFile, [CARRIED_NOTICE], ["a-hl", "a-ink"]);
});

it("pin, road 1 desktop: A plus another program's incremental update while open; A's ink is carried, said once", async () => {
	const src = realPdf("hello", BIG);
	const { s, pane, oldId, oldFile } = await replacedWhileOpen("desktop", bytesOf(src), () => foreignUpdate(src));
	await expectCarried(s, pane.root, oldId, oldFile, [CARRIED_NOTICE], ["a-hl", "a-ink"]);
});

// ---- added from the break read (addendum 1)

/** A stroke is drawn this long after the tab's identification in a change check ended. With the fix that is inside the
 * proof's reads, which start once every identification of the check has ended; at the base the check has already
 * ended (its carry runs in microtasks after the identification). */
const DRAW_AFTER_MS = 2;

/** Start a change check of A.pdf, run the clock until the tab's identification in it ends, then DRAW_AFTER_MS more. */
async function checkUntilIdentified(s: Session) {
	const before = s.resolutions.length;
	s.plugin.onPdfModified("A.pdf");
	expect(s.resolutions.length, "precondition: the change check identifies the tab again").toBe(before + 1);
	let ended = false;
	s.resolutions[before]!.then(() => { ended = true; }, () => { ended = true; });
	for (let n = 0; n < 10_000 && !ended; n++) await vi.advanceTimersByTimeAsync(1);
	expect(ended, "precondition: the tab's identification in the change check ended").toBe(true);
	await vi.advanceTimersByTimeAsync(DRAW_AFTER_MS);
}

/** Road 1 with a stroke: A open, its file replaced by `copy`, and `drawn` drawn on the tab's new id DRAW_AFTER_MS after
 * the tab was identified again. */
async function replacedWhileOpenDrawn(platform: "desktop" | "mobile", base: Uint8Array,
	copyOf: (strokes: readonly InkStroke[]) => Uint8Array, drawn: InkStroke) {
	const s = session(platform);
	const { pane, oldId, oldFile } = await inkedReal(s, base);
	s.pdfs.set("A.pdf", new Uint8Array(copyOf(s.pdfStore.strokes(oldId))));
	shown.length = 0;
	await checkUntilIdentified(s);
	const now = s.plugin.pdfIds.get(pane.root) as string | undefined;
	expect(now, "precondition: the tab is on an id when the stroke is drawn").toBeDefined();
	expect(now, "precondition: the tab is on the new version's id when the stroke is drawn").not.toBe(oldId);
	expect(s.pdfStore.inkReady(now!), "precondition: the new id's ink file is ready to draw on").toBe(true);
	s.pdfStore.commit(now!, drawn);
	await settleAll(s);
	return { s, pane, oldId, oldFile };
}

/** Count the vault's whole reads of `path` from now on. */
function wholeReads(s: Session, path: string) {
	const vault = s.plugin.app.vault as { readBinary: (file: { path: string }) => Promise<ArrayBuffer> };
	const read = vault.readBinary;
	let n = 0;
	vault.readBinary = (file) => {
		if (file.path === path) n++;
		return read(file);
	};
	return () => n;
}

it("pin, road 1 mobile: A plus another program's update while open, a stroke drawn while the check may still read; A's ink is carried beside it, each once", async () => {
	const src = realPdf("hello", BIG);
	const { s, pane, oldId, oldFile } = await replacedWhileOpenDrawn("mobile", bytesOf(src), () => foreignUpdate(src), stroke("a-new"));
	await expectCarried(s, pane.root, oldId, oldFile, [CARRIED_NOTICE], ["a-hl", "a-ink", "a-new"]);
});

it("pin, road 1 desktop: A plus another program's update while open, a stroke drawn while the check may still read; A's ink is carried beside it, each once", async () => {
	const src = realPdf("hello", BIG);
	const { s, pane, oldId, oldFile } = await replacedWhileOpenDrawn("desktop", bytesOf(src), () => foreignUpdate(src), stroke("a-new"));
	await expectCarried(s, pane.root, oldId, oldFile, [CARRIED_NOTICE], ["a-hl", "a-ink", "a-new"]);
});

it.fails("held back in 1.5.2: own copy, road 1 mobile, a stroke drawn while the check may still read: that stroke alone on the new id, the kept notice", async () => {
	const base = A_BIG();
	const { s, pane, oldId, oldFile } = await replacedWhileOpenDrawn("mobile", base, ownCopy(base), stroke("a-new"));
	const now = s.plugin.pdfIds.get(pane.root) as string;
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
	expect.soft(ids(s.pdfStore.strokes(now)).sort(), "the stroke drawn on the copy, alone: the drawn-in ink is not laid over").toEqual(["a-new"]);
	expect.soft(shown, "the shipped kept notice, once; never the carried notice").toEqual([KEPT_NOTICE]);
});

it.fails("held back in 1.5.2: own copy of a version the tab was handed, road 1 mobile: X0's ink carried into X1, back to X0, X1 again, and X1's flattened copy arriving while that check runs; nothing laid over from either", async () => {
	const s = session("mobile");
	const x0 = A_BIG();
	const { pane, oldId } = await inkedReal(s, x0);
	// X1: another program changed one letter of A's text. The check carries A's ink into X1's own id.
	const x1 = bytesOf(realPdf("hellp", BIG));
	s.pdfs.set("A.pdf", x1.slice());
	s.plugin.onPdfModified("A.pdf");
	await settleAll(s);
	const x1Id = s.plugin.pdfIds.get(pane.root) as string;
	expect(x1Id, "precondition: X1 is on its own id").not.toBe(oldId);
	expect(ids(s.pdfStore.strokes(x1Id)).sort(), "precondition: A's ink was carried into X1").toEqual(["a-hl", "a-ink"]);
	const x1Strokes = s.pdfStore.strokes(x1Id);
	// Back to X0, whose own ink file holds its ink: kept, and the tab is on X0's id again.
	s.pdfs.set("A.pdf", x0.slice());
	s.plugin.onPdfModified("A.pdf");
	await settleAll(s);
	expect(s.plugin.pdfIds.get(pane.root), "precondition: the tab is back on X0's id").toBe(oldId);
	const files = { x0: s.saved(oldId), x1: s.saved(x1Id) };
	expect(files.x1, "precondition: X1's ink file is on disk").not.toBeNull();
	// X1 again. While that check runs, X1's own flattened copy arrives (made from X1 with its ink, on another device).
	const x2 = flattened(x1, x1Strokes);
	shown.length = 0;
	s.pdfs.set("A.pdf", x1.slice());
	await checkUntilIdentified(s);
	expect(s.plugin.pdfIds.get(pane.root), "precondition: the tab is on X1's id when the copy arrives").toBe(x1Id);
	s.pdfs.set("A.pdf", x2.slice());
	s.plugin.onPdfModified("A.pdf");
	await settleAll(s);
	const now = s.plugin.pdfIds.get(pane.root) as string | undefined;
	expect(now, "precondition: the tab is on an id").toBeDefined();
	expect([oldId, x1Id], "precondition: the tab is on the copy's own id").not.toContain(now);
	expect(s.saved(oldId), "X0's ink file is never written").toBe(files.x0);
	expect(s.saved(x1Id), "X1's ink file is never written").toBe(files.x1);
	expect.soft(ids(s.pdfStore.strokes(now!)), "the copy's drawn-in ink is not laid over, from X1 or from X0").toEqual([]);
	expect.soft(shown, "the shipped kept notice, once; never the carried notice").toEqual([KEPT_NOTICE]);
});

it("pin, road 2 desktop: A.pdf and Y.pdf byte-identical, each inked, Y's flattened copy saved over A.pdf; A's own ink is carried, said once", async () => {
	const s = session("desktop");
	const base = A_BIG();
	s.pdfs.set("A.pdf", base.slice());
	s.pdfs.set("Y.pdf", base.slice());
	const a = await s.open("A.pdf");
	s.pdfStore.commit(a.id, pen);
	s.pdfStore.commit(a.id, highlight);
	const y = await s.open("Y.pdf");
	expect(familyOf(y.id), "precondition: Y is A's content family").toBe(familyOf(a.id));
	expect(y.id, "precondition: Y is its own instance").not.toBe(a.id);
	const yInk = stroke("y-ink");
	s.pdfStore.commit(y.id, yInk);
	await drive(s.store.flush());
	expect(onDisk(s, a.id), "precondition: A's ink file holds A's strokes").toEqual(["a-hl", "a-ink"]);
	expect(onDisk(s, y.id), "precondition: Y's ink file holds Y's stroke").toEqual(["y-ink"]);
	const copy = flattened(base, [yInk]);
	const oldFile = s.saved(a.id);
	await s.close(a);
	await s.close(y);
	s.pdfs.set("A.pdf", copy.slice());
	shown.length = 0;
	const again = await s.open("A.pdf");
	await settleAll(s);
	await expectCarried(s, again.root, a.id, oldFile, [CARRIED_NOTICE], ["a-hl", "a-ink"]);
});

it.fails("held back in 1.5.2: own copy, road 2 mobile, opened again in the same app session: one whole read of the PDF at that open, the id's own; nothing laid over, nothing more said", async () => {
	const base = A_BIG();
	const { s, pane, oldId, oldFile } = await replacedWhileClosed("mobile", base, ownCopy(base));
	expectNotCarried(s, pane.root, oldId, oldFile);
	await s.close(pane);
	const reads = wholeReads(s, "A.pdf");
	const again = await s.open("A.pdf");
	await settleAll(s);
	expect(s.saved(oldId), "the old ink file is never written").toBe(oldFile);
	expect.soft(ids(s.pdfStore.strokes(again.id)), "the second open lays nothing over either").toEqual([]);
	expect.soft(shown, "said once in the app session").toEqual([KEPT_NOTICE]);
	expect.soft(reads(), "one whole read at the second open: the id's own, none for a proof already made").toBe(1);
});

// ---- held back in 1.5.2: a flattened copy saved over its PDF carries as on 1.5.1 (FOLLOWUPS 556)

const lateStroke = stroke("a-late");

/** Road 1 with a stroke drawn on A after the copy was made: A open and inked, the copy made of A's ink, then
 * `lateStroke` drawn on A and saved, then the copy over A and the change check run. With `busy` the tab is mid-gesture
 * when the copy lands: the check holds it on A's ink, the gesture ends with `lateStroke` drawn there, and the tab is
 * asked again once idle. */
async function lateWhileOpen(platform: "desktop" | "mobile", busy: boolean) {
	const s = session(platform);
	const base = A_BIG();
	const { pane, oldId } = await inkedReal(s, base);
	const copy = flattened(base, s.pdfStore.strokes(oldId));
	const controller = s.plugin.pdfInk.get(pane.root) as { idle: boolean };
	if (busy) controller.idle = false;
	else {
		s.pdfStore.commit(oldId, lateStroke);
		await drive(s.store.flush());
	}
	s.pdfs.set("A.pdf", copy.slice());
	shown.length = 0;
	if (busy) {
		// Past the settle: the tab is asked again while still busy, and held again.
		await drive(s.plugin.onPdfModified("A.pdf"));
		expect(s.plugin.pdfIds.get(pane.root), "precondition: the check held the busy tab on A's ink").toBe(oldId);
		s.pdfStore.commit(oldId, lateStroke);
		await drive(s.store.flush());
		expect(s.plugin.pdfIds.get(pane.root), "precondition: still held while the gesture is live").toBe(oldId);
		controller.idle = true;
	} else s.plugin.onPdfModified("A.pdf");
	expect(onDisk(s, oldId), "precondition: A's ink file holds the stroke drawn after the copy").toEqual(["a-hl", "a-ink", "a-late"]);
	const oldFile = s.saved(oldId);
	await settleAll(s);
	return { s, pane, oldId, oldFile };
}

it("carry as on 1.5.1, road 1 desktop, ink drawn after the copy was made: A open, its flattened copy saved over it; that stroke shows on the new version, A's ink with it", async () => {
	const { s, pane, oldId, oldFile } = await lateWhileOpen("desktop", false);
	await expectCarried(s, pane.root, oldId, oldFile, [CARRIED_NOTICE], ["a-hl", "a-ink", "a-late"]);
});

it("carry as on 1.5.1, road 1 mobile, tab busy across the change: a stroke ended on A's ink while the check held the tab shows on the new version once the tab is idle, A's ink with it", async () => {
	const { s, pane, oldId, oldFile } = await lateWhileOpen("mobile", true);
	await expectCarried(s, pane.root, oldId, oldFile, [CARRIED_NOTICE], ["a-hl", "a-ink", "a-late"]);
});

it("carry as on 1.5.1, road 2 desktop, ink drawn after the copy was made: A closed, its flattened copy saved over it, A opened; that stroke shows on the new version, A's ink with it", async () => {
	const base = A_BIG();
	const { s, pane, oldId, oldFile } = await replacedWhileClosed("desktop", base, ownCopy(base), lateStroke);
	expect(onDisk(s, oldId), "precondition: A's ink file holds the stroke drawn after the copy").toEqual(["a-hl", "a-ink", "a-late"]);
	await expectCarried(s, pane.root, oldId, oldFile, [CARRIED_NOTICE], ["a-hl", "a-ink", "a-late"]);
});

// The ink drawn into the copy shows twice on screen: in the copy's pages and on the overlay. A unit cell sees the
// overlay: A's ink carried onto the new version.

it("carry as on 1.5.1, road 1 desktop: A open, its file replaced by its flattened copy; the drawn-in ink is carried onto the new version too, the carried notice", async () => {
	const base = A_BIG();
	const { s, pane, oldId, oldFile } = await replacedWhileOpen("desktop", base, ownCopy(base));
	await expectCarried(s, pane.root, oldId, oldFile, [CARRIED_NOTICE], ["a-hl", "a-ink"]);
});

it("carry as on 1.5.1, road 2 desktop: A closed, its file replaced by its flattened copy, A opened; the drawn-in ink is carried onto the new version too, the carried notice", async () => {
	const base = A_BIG();
	const { s, pane, oldId, oldFile } = await replacedWhileClosed("desktop", base, ownCopy(base));
	await expectCarried(s, pane.root, oldId, oldFile, [CARRIED_NOTICE], ["a-hl", "a-ink"]);
});
