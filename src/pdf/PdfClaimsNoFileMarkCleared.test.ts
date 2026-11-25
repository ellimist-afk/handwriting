// A change check that meets a PDF view with no file, the view's file back before the check's retry.
//
// A change check that finds the view with no file at that instant (the viewer re-rendering, a layout change, a leaf
// becoming active) holds the pane, marks it, and asks again after the settle. The mark is how the plugin's sync knows,
// when the view's file comes back at the same path, that the pane still has a check owed. When the retry meets the file
// and identifies the pane itself, nothing is owed any more, and the mark must go there: left in place, the next sync on
// the same path (the next layout change or leaf activation) starts one more check over bytes that did not change, and
// that check, as every check that identifies a pane, forgets the tab's undo and selection.
//
// The rig is PdfChangedTwiceKeepsInk.test.ts's, cut down to what this needs: the real plugin's change check and
// identification over the real PageStore and PdfInkStore, a fake vault whose ops queue one behind another on the fake
// clock, desktop's ranged head read, and a pane whose controller counts each time its undo is forgotten.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { sha256 } from "./Sha256";
import type { InkStroke } from "../ink/Stroke";

/** One queued vault op, ms on the fake clock. */
const OP_MS = 5;
/** One head digest, off the queue, ms on the fake clock. */
const DIGEST_MS = 1;
/** Any ranged head read, outside the queue. */
const HEAD_MS = 1;

const after = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const desktopApp = Platform.isDesktopApp;
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
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

/** Run the fake clock far past every op and digest the work can start, then hand back its result. */
async function drive<T>(work: Promise<T>, ms = 10_000): Promise<T> {
	work.catch(() => {});
	await vi.advanceTimersByTimeAsync(ms);
	return work;
}

/** Every op waits for the one before it to settle, then takes its time: CapacitorAdapter's `this.promise.then(t, t)`. */
function oneQueue(opMs: number) {
	let tail: Promise<unknown> = Promise.resolve();
	function run<T>(op: () => Promise<T>): Promise<T> {
		const step = async () => {
			await after(opMs);
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
/** The pane's controller as the change check reads it, with a count of the times its undo was forgotten. */
type Controller = { refresh(): void; refreshStrip(): void; forgetHistory(): void; idle: boolean; forgot: number };
type Pane = { root: HTMLElement; leaf: Leaf; id: string; controller: Controller };

function session() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
		getFullPath?: (path: string) => string;
	};
	adapter.list = async (folder) => ({
		files: [...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	// A is the inked PDF that changes (more than 64 KiB, so its head is a part of it).
	const pdfs = new Map([["A.pdf", pdf("a", 70000)]]);
	const queue = oneQueue(OP_MS);
	for (const name of ["exists", "read", "write", "rename", "remove", "mkdir", "stat", "list"] as const) {
		const own = (adapter[name] as (...args: unknown[]) => Promise<unknown>).bind(adapter);
		(adapter as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => queue.run(() => own(...args));
	}
	const readBinary = (file: { path: string }) => queue.run(async () => pdfs.get(file.path)!.slice().buffer);
	Platform.isDesktopApp = true;
	// The ranged read's node fs, as openRangedFile reaches it through the renderer's require.
	adapter.getFullPath = (path) => `/vault/${path}`;
	vi.stubGlobal("require", (mod: string) => {
		if (mod !== "fs") throw new Error(`no ${mod} here`);
		return {
			promises: {
				open: async (full: string) => {
					// An open handle reads the file it opened, also after a rename.
					const file = pdfs.get(full.slice("/vault/".length))!;
					return {
						read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
							await after(HEAD_MS);
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
	const store = new PageStore({ vault: { adapter } } as never);
	const pdfStore = new PdfInkStore();
	pdfStore.attachHost({
		load: (id, options) => store.load(id, options),
		schedule: (id, data) => store.schedule(id, data),
		notice: () => {},
		prepareExternalAdoption: (id, outgoing) => store.prepareExternalAdoption(id, outgoing, "pdf"),
		acceptExternalAdoption: (prepared) => store.acceptExternalAdoption(prepared),
	});
	const leaves: Leaf[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app: {
			workspace: { getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []) },
			vault: { adapter, readBinary, getFileByPath: (p: string) => (pdfs.has(p) ? { path: p, extension: "pdf" } : null) },
		},
		store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map(),
	});
	// Every identification, so the test can wait for each to end.
	const resolutions: Promise<void>[] = [];
	const resolve = plugin.resolvePdfId as (...args: unknown[]) => Promise<void>;
	plugin.resolvePdfId = function (this: unknown, ...args: unknown[]) {
		const done = resolve.apply(this, args);
		resolutions.push(done);
		return done;
	};
	// Every change check, the one a held pane's settle starts included.
	const passes: Promise<void>[] = [];
	const check = plugin.onPdfModified as (...args: unknown[]) => Promise<void>;
	plugin.onPdfModified = function (this: unknown, ...args: unknown[]) {
		const done = check.apply(this, args);
		passes.push(done);
		return done;
	};
	/** A tab opens the file: the plugin's sync mounts a controller and identifies the pane. */
	async function open(path: string): Promise<Pane> {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller: Controller = {
			refresh() {},
			refreshStrip() {},
			forgetHistory() {
				controller.forgot++;
			},
			idle: true,
			forgot: 0,
		};
		const leaf: Leaf = { view: { file: { path }, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await drive(plugin.resolvePdfId(leaf, root, controller));
		const id = plugin.pdfIds.get(root) as string;
		expect(id, "production resolution must bind a PDF identity").toMatch(/^pdf-[0-9a-f]+(?:-\d+)?$/);
		return { root, leaf, id, controller };
	}
	/** The view's file is back at its path: the leaf's file is set again, and the plugin's sync runs, as at the next layout
	 * change or leaf activation. */
	function fileBack(pane: { leaf: Leaf }, path: string) {
		pane.leaf.view.file = { path };
		plugin.syncPdfControllers();
	}
	return { pdfs, store, pdfStore, plugin, open, fileBack, resolutions, passes };
}
type Session = ReturnType<typeof session>;

/** Give A's bytes version `n`: a head byte, so each version is its own ink id. */
function version(s: Session, n: number) {
	const changed = s.pdfs.get("A.pdf")!.slice();
	changed[100] = 110 + n;
	s.pdfs.set("A.pdf", changed);
}

/** Every check, the held ones' retries included, and every identification, to their ends; then every write. */
async function settleAll(s: Session) {
	for (let n = 0; n < 3; n++) await drive(Promise.all([...s.passes, ...s.resolutions]));
	await drive(s.store.flush());
}

it("a change check meets the view with no file, the file is back before the retry and the retry identifies the tab: the next sync on the same path asks no further check, and the tab keeps its undo", async () => {
	const s = session();
	const pane = await s.open("A.pdf");
	s.pdfStore.commit(pane.id, stroke("a-ink"));
	await drive(s.store.flush());
	version(s, 1);
	const file = pane.leaf.view.file;
	pane.leaf.view.file = undefined;
	s.plugin.onPdfModified("A.pdf");
	pane.leaf.view.file = file;
	await settleAll(s);
	const checks = s.passes.length;
	const idNow = s.plugin.pdfIds.get(pane.root);
	expect(checks, "premise: the first check and its retry ran").toBe(2);
	expect(idNow, "premise: the retry identified the tab on A's new version").not.toBe(pane.id);
	const forgot = pane.controller.forgot;

	// The next layout change or leaf activation: the plugin's sync, with the view's file at the same path.
	s.fileBack(pane, "A.pdf");
	const waiting = s.plugin.pdfModifyTimers?.size ?? 0;
	await settleAll(s);
	expect.soft(waiting, "the sync left a check waiting").toBe(0);
	expect.soft(s.passes.length, "a further check ran after the sync").toBe(checks);
	expect.soft(pane.controller.forgot, "the tab's undo was forgotten after the sync").toBe(forgot);
	expect.soft(s.plugin.pdfIds.get(pane.root), "the tab stays on its id").toBe(idNow);
});
