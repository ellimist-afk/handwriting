/**
 * A pane restored at launch can identify its PDF before the vault has listed every file. Two byte-same inked PDFs are
 * deleted in one grace, two copies arrive, the first opened ties and is held for both deletions; it is renamed in
 * Obsidian (the hold follows), and Obsidian quits inside the grace. At the next launch the other copy's pane opens
 * before the renamed copy is listed. Once the list is full, the other copy must take the first deleted ink by name, as
 * it does when opened after the layout is ready, and that ink must not go to the trash.
 *
 * The other copy's early open is run four ways: closed with its record kept, kept open through the grace, closed and
 * released, drawn on; and once with a quit inside the grace. Then the same early open where the full list would pair by
 * name with no hold at all: a tie only on the partial list, and a pair the full list gives another copy.
 *
 * Every cell passes. The cells that open a copy before the list is full were red before their cure, except the one
 * drawn on (its own stroke stays; a pin); the CONTROL cell and the tie after the layout is ready passed from the start.
 * A red in any of them is a regression, not an expected failure. Through the plugin and the real stores, with an
 * in-memory vault (the harness of PdfTiedHoldRenamedWhileOff.test.ts, copied).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every notice shown, in order. */
const shown = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			shown.push(message);
		}
	},
}));

import HandwritingPlugin from "../main";
import { TFile, Notice } from "obsidian";
import pluginSettingsSource from "../settings/PluginSettings.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { parsePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";


// Execute the production host registration, including its load options, rather
// than reconstructing that adapter in this fixture.
const source = pluginSettingsSource.replace(/\r\n/g, "\n");
const hostStart = "\t\tthis.pdfStore.attachHost({";
expect(source.split(hostStart)).toHaveLength(2);
const hostAt = source.indexOf(hostStart);
const hostEnd = source.indexOf("\n\t\t});", hostAt);
expect(hostEnd).toBeGreaterThan(hostAt);
const installPdfHost = new Function("Notice", source.slice(hostAt, hostEnd + "\n\t\t});".length));

function stroke(x: number, id: string): InkStroke {
	return {
		id,
		page: 1,
		tool: "pen",
		color: "#111111",
		width: 2,
		createdAt: 0,
		points: [
			{ x, y: 10, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x, y: 10, width: 10, height: 10 },
	};
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	shown.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** One vault (disk + file list) shared by any number of plugin sessions. */
function vault() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	adapter.list = async (folder: string) => {
		const files = [...adapter.files.keys()].filter(
			(p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")
		);
		return { files, folders: [] };
	};
	// Every PDF here holds the same bytes: "Make a copy" of one file.
	const pdfBytes = new TextEncoder().encode(
		"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "x".repeat(5000) + "\n%%EOF\n"
	);
	const files = new Set<string>();
	/** This device's local storage, which outlives a plugin session. */
	const local = new Map<string, unknown>();
	function sidecar(id: string) {
		const bytes = adapter.files.get(`.handwriting/${id}.json`);
		return bytes === undefined ? undefined : parsePage(bytes, id).data;
	}
	/** The strokes of every ink file in the trash, one list per file. */
	function trashInk(): string[][] {
		return [...adapter.files.entries()]
			.filter(([p]) => p.includes("/trash/"))
			.map(([p, bytes]) => parsePage(bytes, p).data.strokes.map((s) => s.id));
	}
	return { adapter, pdfBytes, files, local, sidecar, trashInk };
}

function pdfFile(path: string) {
	return Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	});
}

/**
 * A plugin session (fresh memory) over the shared vault. Its vault events are
 * the plugin's own registrations; `layoutReady` is the workspace's flag.
 * `pendingStore` restores and saves deletions in their grace the way the
 * plugin does at load.
 */
function session(
	v: ReturnType<typeof vault>,
	opts: { layoutReady?: boolean; pendingStore?: boolean; afterLayout?: (start: () => void) => void } = {}
) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	// afterLayout as the plugin hands it (main.ts): given, the restored deletions' grace starts only when the cell runs it.
	const pdfStore = new PdfInkStore(opts.afterLayout ? { afterLayout: opts.afterLayout } : {});
	const vaultOn = new Map<string, ((...a: unknown[]) => unknown)[]>();
	/** The open PDF panes, as the workspace lists them. */
	const leaves: { view: { file: { path: string }; containerEl: HTMLElement } }[] = [];
	const app = {
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files].map((path) => ({ path, extension: "pdf" })),
			readBinary: async (_file: { path: string }) => v.pdfBytes.slice().buffer,
			getFileByPath: (p: string) => (v.files.has(p) ? { path: p, extension: "pdf" } : null),
			on: (name: string, handler: (...a: unknown[]) => unknown) => {
				vaultOn.set(name, [...(vaultOn.get(name) ?? []), handler]);
				return {};
			},
		},
		workspace: { layoutReady: opts.layoutReady ?? true, getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []) },
		loadLocalStorage: (key: string) => v.local.get(key) ?? null,
		saveLocalStorage: (key: string, value: unknown) => {
			if (value === null) v.local.delete(key);
			else v.local.set(key, value);
		},
	};
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app,
		store,
		pdfStore,
		pdfInk: new Map(),
		pdfIds: new Map(),
		pdfFiles: new Map(),
		registerEvent: () => {},
		register: () => {},
	});
	// The rename handler starts the no-pane claim move in the background. The move itself runs unchanged; it is
	// only kept here, so a rename can be waited for.
	const moves: Promise<void>[] = [];
	const moveClaim = HandwritingPlugin.prototype.movePdfClaimOnRename;
	plugin.movePdfClaimOnRename = (file: TFile, oldPath: string) => {
		const move = moveClaim.call(plugin, file, oldPath);
		moves.push(move);
		return move;
	};
	// Every check that identifies a PDF's panes again; kept only, so a cell can wait for them.
	const checks: Promise<void>[] = [];
	const check = HandwritingPlugin.prototype.onPdfModified;
	plugin.onPdfModified = (path: string, panes?: ReadonlySet<HTMLElement> | null) => {
		const pass = check.call(plugin, path, panes);
		checks.push(pass);
		return pass;
	};
	// Ink found for a path that leaves it, its pane drawn on before it moved: kept too.
	const leave = (HandwritingPlugin.prototype as any).pairedInkLeaves as ((id: string, path: string, from: string) => Promise<void>) | undefined;
	if (leave) {
		plugin.pairedInkLeaves = (id: string, path: string, from: string) => {
			const left = leave.call(plugin, id, path, from);
			checks.push(left);
			return left;
		};
	}
	installPdfHost.call(plugin, Notice);
	plugin.onloadVaultEvents();
	if (opts.pendingStore) plugin.attachPdfPendingDeletes();
	async function open(path: string) {
		expect(v.files.has(path), `precondition: ${path} exists in the vault`).toBe(true);
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, unmount() {}, idle: true };
		const leaf = { view: { file: { path }, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId(leaf, root, controller);
		return { root, id: plugin.pdfIds.get(root) as string };
	}
	/** Every check started so far that identifies panes again, finished. */
	async function checked() {
		while (checks.length > 0) await Promise.all(checks.splice(0));
	}
	function close(root: HTMLElement) {
		const at = leaves.findIndex((l) => l.view.containerEl === root);
		if (at >= 0) leaves.splice(at, 1);
		(root as unknown as { isConnected: boolean }).isConnected = false;
		plugin.pdfInk.delete(root);
		plugin.pdfIds.delete(root);
		plugin.pdfFiles.delete(root);
	}
	function draw(id: string, s: InkStroke) {
		pdfStore.replaceAll(id, [...pdfStore.strokes(id), s]);
	}
	/** The vault removes the file, then the plugin's real delete handler runs. */
	async function deleteFile(path: string) {
		v.files.delete(path);
		await plugin.onFileDeleted(pdfFile(path));
	}
	/** The vault adds the file, then every create handler the plugin registered runs. */
	async function createFile(path: string) {
		v.files.add(path);
		for (const handler of vaultOn.get("create") ?? []) await handler(pdfFile(path));
	}
	/** The vault moves the file, then every rename handler the plugin registered runs, and any claim move it started. */
	async function renameFile(from: string, to: string) {
		expect(v.files.has(from), `precondition: ${from} exists before the rename`).toBe(true);
		expect(vaultOn.get("rename")?.length, "precondition: the plugin listens for renames").toBeGreaterThan(0);
		v.files.delete(from);
		v.files.add(to);
		for (const leaf of leaves) if (leaf.view.file.path === from) leaf.view.file = { path: to };
		for (const handler of vaultOn.get("rename") ?? []) await handler(pdfFile(to), from);
		await Promise.all(moves.splice(0));
	}
	return { store, pdfStore, plugin, open, close, draw, deleteFile, createFile, renameFile, checked };
}

/** A later session opens `path` and finds it blank. */
async function expectBlank(v: ReturnType<typeof vault>, path: string) {
	const s = session(v);
	const opened = await s.open(path);
	expect(s.pdfStore.strokes(opened.id).map((x) => x.id), `${path} opened wearing ink`).toEqual([]);
}

/** One session with one inked PDF per path, each closed again. */
async function inked<const P extends readonly string[]>(
	v: ReturnType<typeof vault>,
	paths: P,
	opts: { layoutReady?: boolean; pendingStore?: boolean } = {}
) {
	for (const p of paths) v.files.add(p);
	const s = session(v, opts);
	const ids: string[] = [];
	for (const [i, p] of paths.entries()) {
		const o = await s.open(p);
		s.draw(o.id, stroke(10 + 10 * i, `ink-${i}`));
		await s.store.flush();
		s.close(o.root);
		ids.push(o.id);
	}
	expect(new Set(ids).size, "precondition: each path has its own ink file").toBe(paths.length);
	for (const [i, id] of ids.entries()) {
		expect(v.sidecar(id)?.pdfPaths, `precondition: ink file ${i} claims its own path only`).toEqual([paths[i]]);
	}
	return { s, ids: ids as { [K in keyof P]: string } };
}

/** Run every grace out and let each retirement finish. */
async function settleGrace(s: ReturnType<typeof session>) {
	await vi.advanceTimersByTimeAsync(10_001);
	await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
	await s.store.flush();
}

/** The first deleted PDF (ink-0) and the second (ink-1, another file name, so it scores lower against both copies). */
const FIRST = "Notes/A.pdf";
const SECOND = "Work/C.pdf";
/** The two copies that arrive inside the grace. TIED is opened first and ties. */
const TIED = "Inbox/A.pdf";
const OTHER = "Archive/A.pdf";
const PENDING_KEY = "handwriting-pdf-pending-deletes";

/** Both deleted in one grace (FIRST then SECOND), then the two copies arrive. */
async function deleteBothThenCopies(s: ReturnType<typeof session>) {
	await s.deleteFile(FIRST);
	await vi.advanceTimersByTimeAsync(500);
	await s.deleteFile(SECOND);
	const waiting = s.pdfStore.pendingClaims();
	expect(waiting.has(FIRST) && waiting.has(SECOND), "precondition: both deletions wait out their grace").toBe(true);
	await s.createFile(TIED);
	await s.createFile(OTHER);
}

/** TIED opens blank and is held for every waiting deletion; its pane stays open. */
async function openTied(s: ReturnType<typeof session>, deleted: readonly string[]) {
	const tied = await s.open(TIED);
	expect(s.pdfStore.strokes(tied.id).map((x) => x.id), "precondition: the tied copy opens blank").toEqual([]);
	for (const d of deleted) {
		expect(s.pdfStore.heldPaths().get(d)?.has(TIED), `precondition: the tied copy is held for ${d}`).toBe(true);
	}
	return tied;
}

/** Inks X1 (FIRST) and X2 (SECOND) deleted, both copies in, TIED opened and held, pane open. */
async function tiedSetup(opts: { pendingStore?: boolean } = {}) {
	const v = vault();
	const { s, ids: [x1, x2] } = await inked(v, [FIRST, SECOND], opts);
	vi.useFakeTimers();
	await deleteBothThenCopies(s);
	const tied = await openTied(s, [FIRST, SECOND]);
	return { v, s, x1, x2, tied };
}

/** The ink files that claim `path` on disk. */
function claimersOnDisk(v: ReturnType<typeof vault>, ids: readonly string[], path: string) {
	return ids.filter((id) => v.sidecar(id)?.pdfPaths?.includes(path));
}

function endInSession(s: ReturnType<typeof session>) {
	s.pdfStore.cancelPendingDeletes();
	vi.useRealTimers();
}

/** TIED's new name, given in Obsidian: it pairs nothing by name. */
const MOVED = "Inbox/A2.pdf";

/**
 * The tied copy renamed in Obsidian (the hold follows it), then a quit inside the grace; at the next launch the vault
 * does not list the renamed copy yet. Returns the next session, its layout not ready (call `start` for that), with
 * the renamed copy listed again by `list`.
 */
async function renamedThenRelaunchedUnlisted() {
	const { v, s: first, x1, x2 } = await tiedSetup({ pendingStore: true });
	await first.renameFile(TIED, MOVED);
	for (const d of [FIRST, SECOND]) {
		expect(first.pdfStore.heldPaths().get(d)?.has(MOVED), `precondition: the hold for ${d} followed the rename`).toBe(true);
	}
	first.pdfStore.cancelPendingDeletes();
	const saved = JSON.parse(v.local.get(PENDING_KEY) as string) as { path: string; held?: string[] }[];
	for (const d of [FIRST, SECOND]) {
		expect(saved.find((e) => e.path === d)?.held, `precondition: the hold for ${d} was saved under the new name`).toEqual([MOVED]);
	}
	// The vault is still filling its list when the plugin loads: the renamed copy is listed only by layout ready.
	v.files.delete(MOVED);
	let start: (() => void) | undefined;
	const next = nextSession(v, (s) => {
		start = s;
	});
	expect(start, "precondition: the grace waits for the layout").toBeDefined();
	function layoutReady() {
		v.files.add(MOVED);
		start!();
	}
	return { v, next, x1, x2, layoutReady };
}

/** The next session, both deletions restored in their grace. */
function nextSession(v: ReturnType<typeof vault>, afterLayout?: (start: () => void) => void) {
	const next = session(v, { pendingStore: true, ...(afterLayout ? { afterLayout } : {}) });
	const waiting = next.pdfStore.pendingClaims();
	expect(waiting.has(FIRST) && waiting.has(SECOND), "precondition: both deletions resumed").toBe(true);
	return next;
}

/** Every stroke id kept: in the deleted inks' own files, or in the trash. */
function keptStrokes(v: ReturnType<typeof vault>, ids: readonly string[]): string[] {
	const live = ids.flatMap((id) => v.sidecar(id)?.strokes.map((s) => s.id) ?? []);
	return [...new Set([...live, ...v.trashInk().flat()])].sort();
}

describe("a restored pane on the other copy opened before the vault lists the renamed tied copy", () => {
	// The harness's close() does not release the id (the app's releasePdfId): these two run with the closed pane's blank
	// record still in the store, as when its release has not landed. The released road is its own cell below.
	it("closed, its record kept, opened again after the layout is ready, inside the grace: it shows the first deleted ink", async () => {
		const { next, x1, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		expect(next.pdfStore.strokes(early.id).map((x) => x.id), "before the list is full the other copy opened wearing the second deleted ink").not.toContain("ink-1");
		next.close(early.root);
		layoutReady();
		const again = await next.open(OTHER);
		expect(again.id, "opened again once listed, the other copy did not take the first deleted ink by name").toBe(x1);
		expect(next.pdfStore.strokes(again.id).map((x) => x.id), "opened again once listed, the other copy did not show its ink").toEqual(["ink-0"]);
		endInSession(next);
	});

	it("closed, its record kept, the grace run out after the layout is ready: the other copy opens with the first deleted ink, and the trash does not hold it", async () => {
		const { v, next, x1, x2, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		next.close(early.root);
		layoutReady();
		await settleGrace(next);
		vi.useRealTimers();
		expect(v.trashInk().flat(), "the first deleted ink went to the trash").not.toContain("ink-0");
		expect(keptStrokes(v, [x1, x2]), "a deleted ink was lost, neither kept nor in the trash").toEqual(["ink-0", "ink-1"]);
		const later = session(v);
		const opened = await later.open(OTHER);
		expect(opened.id, "after the grace the other copy did not open with the first deleted ink").toBe(x1);
		expect(later.pdfStore.strokes(opened.id).map((x) => x.id), "after the grace the other copy did not show its ink").toEqual(["ink-0"]);
	});

	it("CONTROL: the other copy opened only after the layout is ready: it shows the first deleted ink", async () => {
		const { next, x1, layoutReady } = await renamedThenRelaunchedUnlisted();
		layoutReady();
		const other = await next.open(OTHER);
		expect(other.id, "the other copy did not pair the first deleted ink by name").toBe(x1);
		expect(next.pdfStore.strokes(other.id).map((x) => x.id)).toEqual(["ink-0"]);
		endInSession(next);
	});

	it("its pane kept open through the grace, then closed and opened again: it shows the first deleted ink, and the trash does not hold it", async () => {
		const { v, next, x1, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		layoutReady();
		await settleGrace(next);
		next.close(early.root);
		const again = await next.open(OTHER);
		vi.useRealTimers();
		expect(v.trashInk().flat(), "the first deleted ink went to the trash").not.toContain("ink-0");
		expect(again.id, "opened again after the grace, the other copy did not open with the first deleted ink").toBe(x1);
		expect(next.pdfStore.strokes(again.id).map((x) => x.id), "opened again after the grace, the other copy did not show its ink").toEqual(["ink-0"]);
	});

	it("its pane closed and its id released before the layout is ready, the grace run out: it opens with the first deleted ink, and the trash does not hold it", async () => {
		const { v, next, x1, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		next.close(early.root);
		next.plugin.releasePdfId(early.id);
		await vi.waitFor(() => expect(next.pdfStore.generation(early.id), "precondition: the closed blank's record was released").toBeNull());
		layoutReady();
		await settleGrace(next);
		const again = await next.open(OTHER);
		vi.useRealTimers();
		expect(v.trashInk().flat(), "the first deleted ink went to the trash").not.toContain("ink-0");
		expect(again.id, "after the grace the other copy did not open with the first deleted ink").toBe(x1);
		expect(next.pdfStore.strokes(again.id).map((x) => x.id), "after the grace the other copy did not show its ink").toEqual(["ink-0"]);
	});

	it("drawn on while blank before the layout is ready: after the grace it shows that stroke, one ink file claims it, and the first deleted ink is kept whole", async () => {
		const { v, next, x1, x2, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		next.draw(early.id, stroke(60, "own"));
		await next.store.flush();
		layoutReady();
		await settleGrace(next);
		next.close(early.root);
		const again = await next.open(OTHER);
		vi.useRealTimers();
		expect(next.pdfStore.strokes(again.id).map((x) => x.id), "the other copy does not show the stroke drawn on it").toEqual(["own"]);
		expect(claimersOnDisk(v, [x1, x2, early.id], OTHER), "not one ink file claims the other copy on disk").toEqual([early.id]);
		expect(keptStrokes(v, [x1, x2]), "a deleted ink was lost, neither kept nor in the trash").toEqual(["ink-0", "ink-1"]);
	});

	it("drawn on while blank before the layout is ready, opened in a second pane after, before the stroke is written: the second pane shows that stroke", async () => {
		const { v, next, x1, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		next.draw(early.id, stroke(60, "own"));
		expect(v.sidecar(early.id), "precondition: the stroke is not written yet").toBeUndefined();
		layoutReady();
		const second = await next.open(OTHER);
		expect(second.id, "the second pane was given the first deleted ink over the stroke drawn on the copy").not.toBe(x1);
		expect(next.pdfStore.strokes(second.id).map((x) => x.id), "the second pane does not show the stroke drawn on the copy").toEqual(["own"]);
		endInSession(next);
	});

	it("its pane kept open through the grace, then drawn on, closed and opened again: it shows that stroke, one ink file claims it, and the first deleted ink is kept whole", async () => {
		const { v, next, x1, x2, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		layoutReady();
		await settleGrace(next);
		// The pane is identified again for the ink the grace found (the change check's settle), then drawn on.
		await vi.advanceTimersByTimeAsync(1_001);
		await next.checked();
		next.draw(next.plugin.pdfIds.get(early.root) as string, stroke(60, "own"));
		await next.store.flush();
		next.close(early.root);
		const again = await next.open(OTHER);
		vi.useRealTimers();
		expect(next.pdfStore.strokes(again.id).map((x) => x.id), "the other copy does not show the stroke drawn on it").toContain("own");
		expect(claimersOnDisk(v, [x1, x2, early.id], OTHER), "not one ink file claims the other copy on disk").toHaveLength(1);
		// The pane drew on the first deleted ink once it moved there: that stroke is kept beside them.
		expect(keptStrokes(v, [x1, x2]).filter((s) => s !== "own"), "a deleted ink was lost, neither kept nor in the trash").toEqual(["ink-0", "ink-1"]);
	});

	it("its pane kept open, the same copy opened in a second pane after the layout is ready, inside the grace: both panes hold the first deleted ink", async () => {
		const { next, x1, x2, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		layoutReady();
		const second = await next.open(OTHER);
		await vi.advanceTimersByTimeAsync(1_001);
		await next.checked();
		const first = next.plugin.pdfIds.get(early.root) as string;
		const name = (id: string) => (id === x1 ? "x1" : id === x2 ? "x2" : id === early.id ? "early" : id);
		const shows = (id: string) => JSON.stringify(next.pdfStore.strokes(id).map((x) => x.id));
		console.log(`SECONDPANE first=${name(first)} ${shows(first)} second=${name(second.id)} ${shows(second.id)}`);
		expect(name(second.id), "the second pane did not open with the first deleted ink").toBe("x1");
		expect(name(first), "the first pane is not on the ink the second pane paired").toBe("x1");
		expect(next.pdfStore.strokes(first).map((x) => x.id), "the first pane does not show the first deleted ink").toEqual(["ink-0"]);
		endInSession(next);
	});

	it("its pane kept open, a stroke drawn on its blank as the grace pairs the first deleted ink onto it: after, the pane shows that stroke, one ink file claims the copy, and the first deleted ink is kept whole", async () => {
		const { v, next, x1, x2, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		expect([x1, x2], "precondition: the other copy opened on a blank").not.toContain(early.id);
		// The stroke lands just after the retirement moves the first deleted ink's claim onto the copy: after the
		// pairing, before anything moves the pane.
		const renamePath = next.pdfStore.renamePath.bind(next.pdfStore);
		let drawn = false;
		next.pdfStore.renamePath = (id: string, from: string, to: string) => {
			renamePath(id, from, to);
			if (!drawn && id === x1 && to === OTHER) {
				drawn = true;
				queueMicrotask(() => next.draw(next.plugin.pdfIds.get(early.root) as string, stroke(60, "own")));
			}
		};
		layoutReady();
		await settleGrace(next);
		expect(drawn, "precondition: the grace paired the first deleted ink onto the other copy").toBe(true);
		// Any check that identifies the pane again settles and ends.
		await vi.advanceTimersByTimeAsync(1_001);
		await next.checked();
		await next.pdfStore.settle();
		await next.store.flush();
		const at = next.plugin.pdfIds.get(early.root) as string;
		vi.useRealTimers();
		// As for a stroke drawn on the blank before the pairing: the stroke and the copy stay the blank's, and the first
		// deleted ink leaves the copy, into the trash whole.
		expect(at, "the pane left the ink file it drew on").toBe(early.id);
		expect(next.pdfStore.strokes(at).map((x) => x.id), "the pane does not show the stroke drawn on it").toEqual(["own"]);
		expect(claimersOnDisk(v, [x1, x2, early.id], OTHER), "not one ink file claims the other copy on disk").toEqual([early.id]);
		expect(v.trashInk(), "the trash does not hold the first deleted ink whole").toContainEqual(["ink-0"]);
		expect(keptStrokes(v, [x1, x2]), "a deleted ink was lost, neither kept nor in the trash").toEqual(["ink-0", "ink-1"]);
		expect(shown, "a notice showed").toEqual([]);
	});

	it("its pane kept open, mid-stroke on its blank as the grace pairs the first deleted ink onto it, the stroke ending inside the settle: the pane shows that stroke, one ink file claims the copy, the first deleted ink is kept whole, and no notice shows", async () => {
		const { v, next, x1, x2, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		const controller = next.plugin.pdfInk.get(early.root) as { idle: boolean };
		// The pen is on the glass as the retirement moves the first deleted ink's claim onto the copy.
		const renamePath = next.pdfStore.renamePath.bind(next.pdfStore);
		let paired = false;
		next.pdfStore.renamePath = (id: string, from: string, to: string) => {
			renamePath(id, from, to);
			if (id === x1 && to === OTHER) {
				paired = true;
				controller.idle = false;
			}
		};
		layoutReady();
		await settleGrace(next);
		expect(paired, "precondition: the grace paired the first deleted ink onto the other copy").toBe(true);
		// The stroke ends inside the settle.
		await vi.advanceTimersByTimeAsync(300);
		const during = next.plugin.pdfIds.get(early.root) as string;
		next.draw(during, stroke(60, "own"));
		controller.idle = true;
		await next.store.flush();
		// Every retry runs and ends.
		await vi.advanceTimersByTimeAsync(3_001);
		await next.checked();
		await next.pdfStore.settle();
		await next.store.flush();
		const at = next.plugin.pdfIds.get(early.root) as string;
		vi.useRealTimers();
		const panes = next.pdfStore.strokes(at).map((x) => x.id);
		expect(panes, "the pane does not show the stroke drawn on it").toContain("own");
		const claimers = claimersOnDisk(v, [x1, x2, early.id], OTHER);
		expect(claimers, "not one ink file claims the other copy on disk").toHaveLength(1);
		if (claimers[0] === x1) expect(panes, "the first deleted ink claims the copy, and the pane does not show it").toContain("ink-0");
		expect(keptStrokes(v, [x1, x2]), "a deleted ink was lost, neither kept nor in the trash").toEqual(expect.arrayContaining(["ink-0", "ink-1"]));
		expect(shown, "a notice showed").toEqual([]);
	});

	it("its pane kept open, a stroke written on its blank while the grace loads the first deleted ink to pair it: one ink file claims the copy, the pane shows that stroke, and the first deleted ink is kept whole", async () => {
		const { v, next, x1, x2, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		// The retirement's load of the first deleted ink waits until the cell lets it go.
		const load = next.store.load.bind(next.store);
		let letGo: () => void = () => {};
		const gate = new Promise<void>((r) => (letGo = r));
		let held = false;
		next.store.load = (async (id: string, options?: unknown) => {
			if (id === x1 && !held) {
				held = true;
				await gate;
			}
			return load(id, options as never);
		}) as typeof next.store.load;
		layoutReady();
		await vi.advanceTimersByTimeAsync(10_001);
		await vi.waitFor(() => expect(held, "precondition: the grace loads the first deleted ink").toBe(true));
		next.draw(early.id, stroke(60, "own"));
		await next.store.flush();
		expect(v.sidecar(early.id)?.pdfPaths, "precondition: the stroke is written, its file claiming the copy").toEqual([OTHER]);
		letGo();
		await settleGrace(next);
		await vi.advanceTimersByTimeAsync(1_001);
		await next.checked();
		await next.pdfStore.settle();
		await next.store.flush();
		const at = next.plugin.pdfIds.get(early.root) as string;
		vi.useRealTimers();
		const panes = next.pdfStore.strokes(at).map((x) => x.id);
		const claimers = claimersOnDisk(v, [x1, x2, early.id], OTHER);
		expect(claimers, "not one ink file claims the other copy on disk").toHaveLength(1);
		expect(panes, "the pane does not show the stroke drawn on it").toContain("own");
		if (claimers[0] === x1) expect(panes, "the first deleted ink claims the copy, and the pane does not show it").toContain("ink-0");
		expect(keptStrokes(v, [x1, x2]), "a deleted ink was lost, neither kept nor in the trash").toEqual(expect.arrayContaining(["ink-0", "ink-1"]));
	});

	it("PIN: its pane kept open, drawn on and undone, the save landed, the grace run out, then a restart: the copy opens on the ink file it drew on, one ink file claims it, and the first deleted ink is kept whole", async () => {
		const { v, next, x1, x2, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		next.draw(early.id, stroke(60, "own"));
		await next.store.flush();
		next.pdfStore.replaceAll(early.id, []);
		await next.store.flush();
		expect(v.sidecar(early.id)?.pdfPaths, "precondition: the undone blank's file is on disk claiming the copy").toEqual([OTHER]);
		expect(v.sidecar(early.id)?.strokes, "precondition: the undone blank's file holds no stroke").toEqual([]);
		layoutReady();
		await settleGrace(next);
		await vi.advanceTimersByTimeAsync(1_001);
		await next.checked();
		await next.pdfStore.settle();
		await next.store.flush();
		vi.useRealTimers();
		// Drawn on, it is no blank, though undone (as for a stroke kept): the copy stays its, and the first deleted ink is
		// not moved onto it.
		expect(next.plugin.pdfIds.get(early.root), "the pane left the ink file it drew on").toBe(early.id);
		expect(claimersOnDisk(v, [x1, x2, early.id], OTHER), "not one ink file claims the other copy on disk").toEqual([early.id]);
		expect(keptStrokes(v, [x1, x2]), "a deleted ink was lost, neither kept nor in the trash").toEqual(["ink-0", "ink-1"]);
		const later = session(v);
		const opened = await later.open(OTHER);
		expect(opened.id, "after a restart the copy opened on another ink file than the one drawn on").toBe(early.id);
		expect(later.pdfStore.strokes(opened.id).map((x) => x.id), "after a restart the copy opened wearing ink").toEqual([]);
	});

	it("its pane kept open on its blank, the copy opened in a second pane after the layout is ready, a stroke on the first pane before it moves, then the second pane closed: one ink file claims the copy, the first pane shows that stroke, and the first deleted ink is kept whole", async () => {
		const { v, next, x1, x2, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		layoutReady();
		const second = await next.open(OTHER);
		expect(second.id, "precondition: the second pane opened on the first deleted ink").toBe(x1);
		expect(next.plugin.pdfIds.get(early.root), "precondition: the first pane is still on its blank").toBe(early.id);
		next.draw(early.id, stroke(60, "own"));
		await next.store.flush();
		await vi.advanceTimersByTimeAsync(1_001);
		await next.checked();
		await settleGrace(next);
		await movesSettled(next);
		const secondAt = next.plugin.pdfIds.get(second.root) as string;
		expect(next.pdfStore.strokes(secondAt).map((x) => x.id), "precondition: the second pane lost the ink it shows").toEqual(["ink-0"]);
		// Closed as the workspace closes a pane: it leaves the plugin's panes, and its id is released.
		next.close(second.root);
		next.plugin.releasePdfId(secondAt);
		await movesSettled(next);
		await movesSettled(next);
		const first = next.plugin.pdfIds.get(early.root) as string;
		vi.useRealTimers();
		await vi.waitFor(() => expect(claimersOnDisk(v, [x1, x2, early.id], OTHER), "not one ink file claims the copy on disk").toEqual([early.id]));
		expect(next.pdfStore.strokes(first).map((x) => x.id), "the first pane does not show its stroke").toEqual(["own"]);
		expect(keptStrokes(v, [x1, x2]), "a deleted ink was lost, neither kept nor in the trash").toEqual(["ink-0", "ink-1"]);
		const later = session(v);
		const reopened = await later.open(OTHER);
		expect(later.pdfStore.strokes(reopened.id).map((x) => x.id), "the copy does not open with the stroke drawn on it").toEqual(["own"]);
	});

	it("opened before the layout is ready, then a quit inside the grace, and the next launch lists every file: it opens with the first deleted ink", async () => {
		const { v, next, x1, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		next.close(early.root);
		layoutReady();
		// The quit, inside the grace: the deletions are saved as they stand.
		next.pdfStore.cancelPendingDeletes();
		const third = nextSession(v);
		const opened = await third.open(OTHER);
		expect(opened.id, "after the next launch the other copy did not open with the first deleted ink").toBe(x1);
		expect(third.pdfStore.strokes(opened.id).map((x) => x.id), "after the next launch the other copy did not show its ink").toEqual(["ink-0"]);
		endInSession(third);
	});
});

/**
 * Two inked PDFs of the same bytes at `deleted`, deleted in one grace; the copies arrive inside it; a quit inside the
 * grace; the next launch, its layout not ready, lists every copy but `unlisted`. `layoutReady` lists them and starts
 * the grace.
 */
async function deletedCopiesThenRelaunched(deleted: readonly [string, string], copies: readonly string[], unlisted: readonly string[]) {
	const v = vault();
	const { s, ids } = await inked(v, deleted, { pendingStore: true });
	vi.useFakeTimers();
	await s.deleteFile(deleted[0]);
	await vi.advanceTimersByTimeAsync(500);
	await s.deleteFile(deleted[1]);
	for (const c of copies) await s.createFile(c);
	s.pdfStore.cancelPendingDeletes();
	for (const u of unlisted) v.files.delete(u);
	let start: (() => void) | undefined;
	const next = session(v, { pendingStore: true, afterLayout: (st) => (start = st) });
	const waiting = next.pdfStore.pendingClaims();
	expect(waiting.has(deleted[0]) && waiting.has(deleted[1]), "precondition: both deletions resumed").toBe(true);
	expect(start, "precondition: the grace waits for the layout").toBeDefined();
	function layoutReady() {
		for (const u of unlisted) v.files.add(u);
		start!();
	}
	return { v, next, ids, layoutReady };
}

describe("an open before the vault lists every copy, where the full list would pair by name", () => {
	it("a copy that ties only on the partial list: once every copy is listed and the grace run out, each copy opens with the ink its name pairs", async () => {
		const X1_AT = "Proj/Notes/A.pdf";
		const X2_AT = "Old/A.pdf";
		const P1 = "Inbox/A.pdf";
		const P2 = "Archive/Old/A.pdf";
		const { next, ids: [x1, x2], layoutReady } = await deletedCopiesThenRelaunched([X1_AT, X2_AT], [P1, P2], [P2]);
		const early = await next.open(P1);
		next.close(early.root);
		layoutReady();
		await settleGrace(next);
		const p1 = await next.open(P1);
		const p2 = await next.open(P2);
		vi.useRealTimers();
		expect(p1.id, "the first copy did not take the ink its name pairs").toBe(x1);
		expect(next.pdfStore.strokes(p1.id).map((x) => x.id)).toEqual(["ink-0"]);
		expect(p2.id, "the second copy did not take the ink its name pairs").toBe(x2);
		expect(next.pdfStore.strokes(p2.id).map((x) => x.id)).toEqual(["ink-1"]);
	});

	it("a copy the partial list pairs with an ink the full list gives another copy: it is not given that ink", async () => {
		const XA_AT = "Proj/Notes/A.pdf";
		const XB_AT = "Old/A.pdf";
		const P1 = "Inbox/Notes/A.pdf";
		const P2 = "Sub/Proj/Notes/A.pdf";
		const { next, ids: [xa, xb], layoutReady } = await deletedCopiesThenRelaunched([XA_AT, XB_AT], [P1, P2], [P2]);
		const early = await next.open(P1);
		expect(early.id, "before the list is full the first copy was given the ink the full list gives the other").not.toBe(xa);
		expect(next.pdfStore.strokes(early.id).map((x) => x.id), "before the list is full the first copy opened wearing the other's ink").not.toContain("ink-0");
		next.close(early.root);
		layoutReady();
		await settleGrace(next);
		const p2 = await next.open(P2);
		const p1 = await next.open(P1);
		vi.useRealTimers();
		expect(p2.id, "the copy whose name pairs the first ink best did not take it").toBe(xa);
		expect(p1.id, "the other copy did not take the ink left to it").toBe(xb);
	});

	it("PIN: a copy opened blank before the layout is ready, its pane kept, opened in a second pane after, where its name ties: both panes show the one blank", async () => {
		const { next, ids: [x1, x2], layoutReady } = await deletedCopiesThenRelaunched([FIRST, SECOND], [TIED, OTHER], []);
		const early = await next.open(TIED);
		expect([x1, x2], "before the list is full the copy was handed a deleted ink").not.toContain(early.id);
		layoutReady();
		const second = await next.open(TIED);
		expect(second.id, "the second pane on the copy was given another blank than the first").toBe(early.id);
		endInSession(next);
	});

	it("PIN: a copy opened blank before the layout is ready, its pane kept; after, the other copy ties with it by name: that copy opens blank and is held", async () => {
		const { next, ids: [x1, x2], layoutReady } = await deletedCopiesThenRelaunched([FIRST, SECOND], [TIED, OTHER], []);
		const early = await next.open(TIED);
		expect([x1, x2], "before the list is full the copy was handed a deleted ink").not.toContain(early.id);
		layoutReady();
		const other = await next.open(OTHER);
		expect([x1, x2], "the other copy was handed a deleted ink though its name ties").not.toContain(other.id);
		expect(next.pdfStore.heldPaths().get(FIRST)?.has(OTHER), "the other copy, tied by name, is not held for the first deleted ink").toBe(true);
		endInSession(next);
	});

	it("PIN: every copy listed, a real tie after the layout is ready: the copy opens blank and is held for both", async () => {
		const X1_AT = "Proj/Notes/A.pdf";
		const X2_AT = "Old/A.pdf";
		const P1 = "Inbox/A.pdf";
		const { next, ids: [x1, x2], layoutReady } = await deletedCopiesThenRelaunched([X1_AT, X2_AT], [P1], []);
		layoutReady();
		const p1 = await next.open(P1);
		expect([x1, x2], "the tied copy was handed a deleted ink").not.toContain(p1.id);
		expect(next.pdfStore.strokes(p1.id).map((x) => x.id), "the tied copy opened wearing ink").toEqual([]);
		for (const d of [X1_AT, X2_AT]) {
			expect(next.pdfStore.heldPaths().get(d)?.has(P1), `the tied copy is not held for ${d}`).toBe(true);
		}
		endInSession(next);
	});
});

/** A second PDF of the same bytes, still in the vault, that the deleted ink file claims too. */
const KEPT = "Shelf/B.pdf";

/**
 * One inked PDF (FIRST) deleted, its ink file claiming KEPT as well, a copy (TIED) arriving in its grace, a quit inside
 * it; the next launch, its layout not ready (call `layoutReady`), the deletion restored. The ink claims a PDF still in
 * the vault, so an open of the copy does not take it and the copy opens blank; the grace gives the ink to the copy by
 * bytes alone, no name pairing.
 */
async function oneDeletedThenRelaunched() {
	const v = vault();
	const { s, ids: [x1] } = await inked(v, [FIRST], { pendingStore: true });
	v.files.add(KEPT);
	const again = await s.open(FIRST);
	s.pdfStore.claimPath(again.id, KEPT);
	await s.pdfStore.settle();
	await s.store.flush();
	s.close(again.root);
	expect(v.sidecar(x1)?.pdfPaths, "precondition: the ink file claims both PDFs").toEqual([FIRST, KEPT]);
	vi.useFakeTimers();
	await s.deleteFile(FIRST);
	await s.createFile(TIED);
	s.pdfStore.cancelPendingDeletes();
	let start: (() => void) | undefined;
	const next = session(v, { pendingStore: true, afterLayout: (st) => (start = st) });
	expect(next.pdfStore.pendingClaims().has(FIRST), "precondition: the deletion resumed").toBe(true);
	expect(start, "precondition: the grace waits for the layout").toBeDefined();
	return { v, next, x1, layoutReady: () => start!() };
}

/** Each check that identifies a pane again settles and ends, and what it starts. */
async function movesSettled(s: ReturnType<typeof session>) {
	await vi.advanceTimersByTimeAsync(3_001);
	await s.checked();
	await s.pdfStore.settle();
	await s.store.flush();
}

describe("a pane on a blank opened before the vault lists every file, when the grace finds ink for its path", () => {
	it("one deleted PDF, its ink also on a PDF still in the vault, its copy opened early and kept open: after the grace the pane shows the deleted ink, and one ink file claims the copy", async () => {
		const { v, next, x1, layoutReady } = await oneDeletedThenRelaunched();
		const early = await next.open(TIED);
		expect(early.id, "precondition: the copy opened on a blank").not.toBe(x1);
		layoutReady();
		await settleGrace(next);
		await movesSettled(next);
		const at = next.plugin.pdfIds.get(early.root) as string;
		vi.useRealTimers();
		expect(at, "the pane did not move to the deleted ink").toBe(x1);
		expect(next.pdfStore.strokes(at).map((x) => x.id), "the pane does not show the deleted ink").toEqual(["ink-0"]);
		expect(claimersOnDisk(v, [x1, early.id], TIED), "not one ink file claims the copy on disk").toEqual([x1]);
		expect(shown, "a notice showed").toEqual([]);
	});

	it("the same, a stroke written on its blank while the grace loads the deleted ink: one ink file claims the copy, the pane shows that stroke, and the deleted ink is kept whole", async () => {
		const { v, next, x1, layoutReady } = await oneDeletedThenRelaunched();
		const early = await next.open(TIED);
		expect(early.id, "precondition: the copy opened on a blank").not.toBe(x1);
		const load = next.store.load.bind(next.store);
		let letGo: () => void = () => {};
		const gate = new Promise<void>((r) => (letGo = r));
		let held = false;
		next.store.load = (async (id: string, options?: unknown) => {
			if (id === x1 && !held) {
				held = true;
				await gate;
			}
			return load(id, options as never);
		}) as typeof next.store.load;
		layoutReady();
		await vi.advanceTimersByTimeAsync(10_001);
		await vi.waitFor(() => expect(held, "precondition: the grace loads the deleted ink").toBe(true));
		next.draw(early.id, stroke(60, "own"));
		await next.store.flush();
		letGo();
		await settleGrace(next);
		await movesSettled(next);
		const at = next.plugin.pdfIds.get(early.root) as string;
		vi.useRealTimers();
		expect(claimersOnDisk(v, [x1, early.id], TIED), "not one ink file claims the copy on disk").toEqual([early.id]);
		expect(next.pdfStore.strokes(at).map((x) => x.id), "the pane does not show the stroke drawn on it").toEqual(["own"]);
		expect(keptStrokes(v, [x1]), "the deleted ink was lost, neither kept nor in the trash").toEqual(["ink-0"]);
	});

	it("two deleted, a stroke drawn on the blank as the grace pairs the first deleted ink onto it, the pane closed before it moves: the copy keeps that ink file, and the first deleted ink is kept whole", async () => {
		const { v, next, x1, x2, layoutReady } = await renamedThenRelaunchedUnlisted();
		const early = await next.open(OTHER);
		const renamePath = next.pdfStore.renamePath.bind(next.pdfStore);
		next.pdfStore.renamePath = (id: string, from: string, to: string) => {
			renamePath(id, from, to);
			if (id === x1 && to === OTHER) {
				queueMicrotask(() => {
					next.draw(early.id, stroke(60, "own"));
					next.close(early.root);
				});
			}
		};
		layoutReady();
		await settleGrace(next);
		await movesSettled(next);
		vi.useRealTimers();
		expect(claimersOnDisk(v, [x1, x2, early.id], OTHER), "not one ink file claims the other copy on disk").toEqual([early.id]);
		expect(keptStrokes(v, [x1, x2]), "a deleted ink was lost, neither kept nor in the trash").toEqual(["ink-0", "ink-1"]);
		const later = session(v);
		const opened = await later.open(OTHER);
		expect(later.pdfStore.strokes(opened.id).map((x) => x.id), "the copy does not open with the stroke drawn on it").toEqual(["own"]);
	});

	for (const released of [false, true]) {
		it(`CONTROL: two deleted, the blank's pane closed${released ? " and its id released" : ", its record kept,"} as the grace pairs the first deleted ink onto it: the copy keeps that ink`, async () => {
			const { v, next, x1, x2, layoutReady } = await renamedThenRelaunchedUnlisted();
			const early = await next.open(OTHER);
			const renamePath = next.pdfStore.renamePath.bind(next.pdfStore);
			next.pdfStore.renamePath = (id: string, from: string, to: string) => {
				renamePath(id, from, to);
				if (id === x1 && to === OTHER) {
					queueMicrotask(() => {
						next.close(early.root);
						if (released) next.plugin.releasePdfId(early.id);
					});
				}
			};
			layoutReady();
			await settleGrace(next);
			await movesSettled(next);
			vi.useRealTimers();
			expect(claimersOnDisk(v, [x1, x2, early.id], OTHER), "not one ink file claims the other copy on disk").toEqual([x1]);
			const later = session(v);
			const opened = await later.open(OTHER);
			expect(opened.id, "the copy did not open with the first deleted ink").toBe(x1);
			expect(later.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual(["ink-0"]);
		});
	}
});
