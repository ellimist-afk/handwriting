/**
 * A PDF renamed while its pane is identified: the open moves its claim itself once its ink file is loaded (resolvePdfId's
 * claim step, `file.path !== started`). A deletion waiting at the old name by then that was not waiting there when the
 * rename was heard is a later file's (a PDF made at the old name inside the load, inked and deleted): it goes on to its
 * grace, the same deletion. A deletion that was waiting there at the rename (the file deleted and made again at its name,
 * as a sync tool's delete then create, then renamed in the grace) ends as before.
 *
 * Two orders. The rename in the head read, before the pane has its id: the rename handler moves nothing for the pane, and
 * the claim step is the rename's only move. The rename in the load, the id set: the handler moves the claim, and the claim
 * step moves it again (the load can merge the old name back). When the handler has moved the id off the old name, the
 * repeat ends no deletion: the handler did what the rename owed the deletion there. So a PDF renamed onto a deleted name
 * in its grace, opened there and renamed on in the load leaves the deleted PDF's deletion waiting, and its ink goes to the
 * trash at the grace.
 *
 * What the rename found is the first rename's, off the name the pane opened on: two renames before the id, or one before
 * and one in the load, still end a deletion that waited at that name at the first rename. "At the rename", not "at the
 * open": a deletion made after the pane opened and before the rename ends as before too.
 *
 * Through the plugin and the real stores, with an in-memory vault: the harness of PdfOwedLeaveLaterDeletion.test.ts, cut
 * down (its helpers are not exported, and that file is not edited here), with one change: a pane's file is one TFile that
 * the rename moves in place, as Obsidian does (PdfRenameDuringIdentifyKeepsOldClaim.test.ts), so the open reads the new
 * name after the rename.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(_message: string) {}
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

// The production host registration, including its load options, rather than a copy of that adapter here.
const source = pluginSettingsSource.replace(/\r\n/g, "\n");
const hostStart = "\t\tthis.pdfStore.attachHost({";
expect(source.split(hostStart)).toHaveLength(2);
const hostAt = source.indexOf(hostStart);
const hostEnd = source.indexOf("\n\t\t});", hostAt);
expect(hostEnd).toBeGreaterThan(hostAt);
const installPdfHost = new Function("Notice", "blockNotice", source.slice(hostAt, hostEnd + "\n\t\t});".length));

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

/** Every session a cell made: its deletions' grace timers are stopped after the cell. */
const sessions: { pdfStore: PdfInkStore }[] = [];

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});
afterEach(() => {
	for (const s of sessions.splice(0)) s.pdfStore.cancelPendingDeletes();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** Another document's bytes: another content family. */
const otherBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog /Other true >> endobj\n" + "y".repeat(6000) + "\n%%EOF\n");

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
	// Every PDF here holds the same bytes, unless bytesAt names others for its path.
	const pdfBytes = new TextEncoder().encode(
		"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n" + "x".repeat(5000) + "\n%%EOF\n"
	);
	const bytesAt = new Map<string, Uint8Array>();
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
	return { adapter, pdfBytes, bytesAt, files, local, sidecar, trashInk };
}

type Vault = ReturnType<typeof vault>;

function fileFields(path: string) {
	return {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	};
}

function pdfFile(path: string): TFile {
	return Object.assign(new TFile(), fileFields(path));
}

/** A hold on one await: `reached` settles when it is reached, and it lasts until `release`. */
function hold() {
	const gate = { held: false, release: (): void => {}, reach: (): void => {} };
	const reached = new Promise<void>((done) => (gate.reach = done));
	const released = new Promise<void>((done) => (gate.release = done));
	return { gate, reached, released };
}

/**
 * A plugin session (fresh memory) over the shared vault. Its vault events are the plugin's own registrations. A pane's
 * file is one TFile; a rename moves it in place.
 */
function session(v: Vault) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	sessions.push({ pdfStore });
	const vaultOn = new Map<string, ((...a: unknown[]) => unknown)[]>();
	/** The open PDF panes, as the workspace lists them. */
	const leaves: { view: { file: TFile; containerEl: HTMLElement } }[] = [];
	/** The head read of one file, held once (start's `holdHead`). */
	const heads = new Map<TFile, ReturnType<typeof hold>>();
	const app = {
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files].map((path) => ({ path, extension: "pdf" })),
			readBinary: async (file: TFile) => {
				const h = heads.get(file);
				if (h && !h.gate.held) {
					h.gate.held = true;
					h.gate.reach();
					await h.released;
				}
				return (v.bytesAt.get(file.path) ?? v.pdfBytes).slice().buffer;
			},
			getFileByPath: (p: string) => (v.files.has(p) ? { path: p, extension: "pdf" } : null),
			on: (name: string, handler: (...a: unknown[]) => unknown) => {
				vaultOn.set(name, [...(vaultOn.get(name) ?? []), handler]);
				return {};
			},
		},
		workspace: { layoutReady: true, getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []) },
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
	// The rename handler starts the no-pane claim move in the background. The move itself runs unchanged; it is only
	// counted and kept here, so a rename can be waited for.
	const moves: Promise<void>[] = [];
	const noPaneMoves: string[] = [];
	const moveClaim = HandwritingPlugin.prototype.movePdfClaimOnRename;
	plugin.movePdfClaimOnRename = (file: TFile, oldPath: string) => {
		noPaneMoves.push(`${oldPath} -> ${file.path}`);
		const move = moveClaim.call(plugin, file, oldPath);
		moves.push(move);
		return move;
	};
	installPdfHost.call(plugin, Notice, (m: string) => new Notice(m));
	plugin.onloadVaultEvents();
	/** A pane opened on `path`, its identification started and not awaited. `holdHead`: its head read is held. */
	function start(path: string, opts: { holdHead?: boolean } = {}) {
		expect(v.files.has(path), `precondition: ${path} exists in the vault`).toBe(true);
		const file = pdfFile(path);
		const head = opts.holdHead ? hold() : undefined;
		if (head) heads.set(file, head);
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, unmount() {}, idle: true };
		const leaf = { view: { file, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		const done = plugin.resolvePdfId(leaf, root, controller) as Promise<void>;
		return { root, file, head, done };
	}
	async function open(path: string) {
		const pane = start(path);
		await pane.done;
		return { root: pane.root, id: plugin.pdfIds.get(pane.root) as string };
	}
	/** The pane's own ink file load (the store's load of the id the pane chose), held once from now on. */
	function holdPaneLoad(root: HTMLElement) {
		const h = hold();
		const load = store.load.bind(store);
		store.load = (async (id: string, ...rest: unknown[]) => {
			if (!h.gate.held && id === plugin.pdfIds.get(root)) {
				h.gate.held = true;
				h.gate.reach();
				await h.released;
			}
			return (load as (...a: unknown[]) => Promise<unknown>)(id, ...rest);
		}) as typeof store.load;
		return h;
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
	/**
	 * The vault moves the file (and its bytes); the TFile a pane shows moves in place and is the one the event carries.
	 * Then every rename handler the plugin registered runs, and any claim move it started.
	 */
	async function renameFile(from: string, to: string) {
		expect(v.files.has(from), `precondition: ${from} exists before the rename`).toBe(true);
		expect(vaultOn.get("rename")?.length, "precondition: the plugin listens for renames").toBeGreaterThan(0);
		v.files.delete(from);
		v.files.add(to);
		const bytes = v.bytesAt.get(from);
		v.bytesAt.delete(from);
		if (bytes) v.bytesAt.set(to, bytes);
		else v.bytesAt.delete(to);
		const file = leaves.find((l) => l.view.file.path === from)?.view.file ?? pdfFile(from);
		Object.assign(file, fileFields(to));
		for (const handler of vaultOn.get("rename") ?? []) await handler(file, from);
		await Promise.all(moves.splice(0));
	}
	/** Every claim move the store makes for `id`, as [from, to], in order (renamePath, which runs unchanged). */
	function claimMovesOf(id: string): [string, string][] {
		const seen: [string, string][] = [];
		const renamePath = pdfStore.renamePath.bind(pdfStore);
		pdfStore.renamePath = ((i: string, from: string, to: string, ...rest: unknown[]) => {
			if (i === id) seen.push([from, to]);
			return (renamePath as (...a: unknown[]) => void)(i, from, to, ...rest);
		}) as typeof pdfStore.renamePath;
		return seen;
	}
	async function settled() {
		await Promise.all(moves.splice(0));
		await pdfStore.settle();
		await store.flush();
	}
	return { store, pdfStore, plugin, start, open, holdPaneLoad, close, draw, deleteFile, createFile, renameFile, claimMovesOf, settled, noPaneMoves };
}

type Session = ReturnType<typeof session>;

const OLD = "Notes/Lecture.pdf";
const NEW = "Notes/Lecture annotated.pdf";
/** A name between the old and the new, for two renames. */
const MID = "Notes/Lecture draft.pdf";
/** Another document's name, deleted before the PDF is renamed onto it. */
const ONTO = "Archive/Handout.pdf";

/** OLD inked in an earlier session and closed: its ink file claims OLD. */
async function inkedAtOld() {
	const v = vault();
	v.files.add(OLD);
	const first = session(v);
	const o = await first.open(OLD);
	first.draw(o.id, stroke(10, "ink"));
	await first.store.flush();
	first.close(o.root);
	expect(v.sidecar(o.id)?.pdfPaths, "precondition: the ink file claims the PDF's name").toEqual([OLD]);
	return { v, x: o.id };
}

/**
 * A PDF of other bytes made at `path`, opened, drawn on, closed and let go, then deleted: its deletion waits.
 * `beforeDelete`: run just before the delete (a cell that fakes the clock for the grace).
 */
async function madeInkedDeleted(v: Vault, s: Session, path: string, beforeDelete?: () => void) {
	v.bytesAt.set(path, otherBytes);
	await s.createFile(path);
	const made = await s.open(path);
	s.draw(made.id, stroke(70, "made"));
	await s.store.flush();
	s.close(made.root);
	s.plugin.releasePdfId(made.id);
	await s.store.flush();
	expect(v.sidecar(made.id)?.pdfPaths, "precondition: the made PDF's ink claims its name").toEqual([path]);
	beforeDelete?.();
	await s.deleteFile(path);
	const token = s.pdfStore.deletionAt(path);
	expect(token, `precondition: the deletion of ${path} waits in its grace`).toBeDefined();
	return { made, token };
}

/** The deletion at OLD waiting when the rename comes: OLD deleted, then made again at its name with its bytes. */
async function deletedAndBack(s: Session) {
	await s.deleteFile(OLD);
	const token = s.pdfStore.deletionAt(OLD);
	expect(token, "precondition: the deletion of the old name waits in its grace").toBeDefined();
	await s.createFile(OLD);
	expect(s.pdfStore.deletionAt(OLD), "precondition: the file back at its name leaves the deletion waiting").toBe(token);
	return token;
}

/** Waits for a hold, failing at once if the open ends first. */
async function reach(h: { reached: Promise<void> }, done: Promise<void>, what: string) {
	let ended = false;
	await Promise.race([h.reached, done.then(() => (ended = true))]);
	expect(ended, `precondition: the open ended before ${what}`).toBe(false);
}

/** On a faked clock: run every grace out and let each retirement finish. */
async function settleGrace(s: Session) {
	await vi.advanceTimersByTimeAsync(10_001);
	await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
	await s.store.flush();
}

describe("a PDF renamed before its pane has its id (in the head read): the open's late claim move", () => {
	it("a PDF made at the old name inside the load, inked and deleted: the late move leaves its deletion waiting, the same one", async () => {
		const { v, x } = await inkedAtOld();
		const s = session(v);
		const moved = s.claimMovesOf(x);
		const pane = s.start(OLD, { holdHead: true });
		const load = s.holdPaneLoad(pane.root);
		await reach(pane.head!, pane.done, "its head read");
		await s.renameFile(OLD, NEW);
		expect(s.plugin.pdfIds.has(pane.root), "precondition: the pane has no id at the rename").toBe(false);
		expect(s.pdfStore.deletionAt(OLD), "precondition: no deletion waits at the old name at the rename").toBeUndefined();
		expect([moved, s.noPaneMoves], "precondition: the rename moved no claim (the pane is being identified)").toEqual([[], []]);
		pane.head!.gate.release();
		await reach(load, pane.done, "its ink file's load");
		expect(s.plugin.pdfIds.get(pane.root), "precondition: the pane chose the ink that claims the old name").toBe(x);
		const { made, token } = await madeInkedDeleted(v, s, OLD);
		expect(made.id, "precondition: the made PDF has its own ink").not.toBe(x);
		expect(moved, "precondition: the claim step has not run").toEqual([]);
		load.gate.release();
		await pane.done;
		await s.settled();
		expect(moved, "precondition: the claim step moved the claim once, the rename's only move").toEqual([[OLD, NEW]]);
		const end = {
			sameDeletion: s.pdfStore.deletionAt(OLD) === token,
			pane: s.plugin.pdfIds.get(pane.root),
			claims: v.sidecar(x)?.pdfPaths,
			madeClaims: v.sidecar(made.id)?.pdfPaths,
		};
		console.log(`late claim move, rename in the head read, later deletion: ${JSON.stringify(end)}`);
		expect(end, "the open's late claim move ended the deletion of a PDF made at the old name after the rename").toEqual({
			sameDeletion: true,
			pane: x,
			claims: [NEW],
			madeClaims: [OLD],
		});
	});

	it("a deletion waiting at the old name when the rename comes (deleted, made again at its name, then renamed): the late move ends it as before", async () => {
		const { v, x } = await inkedAtOld();
		const s = session(v);
		const token = await deletedAndBack(s);
		const moved = s.claimMovesOf(x);
		const pane = s.start(OLD, { holdHead: true });
		const load = s.holdPaneLoad(pane.root);
		await reach(pane.head!, pane.done, "its head read");
		await s.renameFile(OLD, NEW);
		expect(s.plugin.pdfIds.has(pane.root), "precondition: the pane has no id at the rename").toBe(false);
		expect(s.pdfStore.deletionAt(OLD), "precondition: the deletion waits at the old name at the rename").toBe(token);
		expect([moved, s.noPaneMoves], "precondition: the rename moved no claim (the pane is being identified)").toEqual([[], []]);
		pane.head!.gate.release();
		await reach(load, pane.done, "its ink file's load");
		const chose = s.plugin.pdfIds.get(pane.root) as string;
		expect(s.pdfStore.deletionAt(OLD), "precondition: the same deletion still waits when the claim step comes").toBe(token);
		load.gate.release();
		await pane.done;
		await s.settled();
		const end = {
			ended: s.pdfStore.deletionAt(OLD) === undefined,
			pane: s.plugin.pdfIds.get(pane.root),
			chose,
			moved,
		};
		console.log(`late claim move, rename in the head read, deletion waiting at the rename: ${JSON.stringify(end)}`);
		expect(end, "the open's late claim move did not end, as before, the deletion waiting at the old name at the rename").toEqual({
			ended: true,
			pane: chose,
			chose: x,
			moved: [[OLD, NEW]],
		});
	});

	it("the deletion waiting at the old name made after the pane opened (deleted and made again at its name in the head read), then renamed: the late move ends it as before", async () => {
		const { v, x } = await inkedAtOld();
		const s = session(v);
		const moved = s.claimMovesOf(x);
		const pane = s.start(OLD, { holdHead: true });
		const load = s.holdPaneLoad(pane.root);
		await reach(pane.head!, pane.done, "its head read");
		expect(s.pdfStore.deletionAt(OLD), "precondition: no deletion waits at the old name when the pane opens").toBeUndefined();
		const token = await deletedAndBack(s);
		await s.renameFile(OLD, NEW);
		expect(s.plugin.pdfIds.has(pane.root), "precondition: the pane has no id at the rename").toBe(false);
		expect(s.pdfStore.deletionAt(OLD), "precondition: the deletion waits at the old name at the rename").toBe(token);
		expect([moved, s.noPaneMoves], "precondition: the rename moved no claim (the pane is being identified)").toEqual([[], []]);
		pane.head!.gate.release();
		await reach(load, pane.done, "its ink file's load");
		const chose = s.plugin.pdfIds.get(pane.root) as string;
		expect(s.pdfStore.deletionAt(OLD), "precondition: the same deletion still waits when the claim step comes").toBe(token);
		load.gate.release();
		await pane.done;
		await s.settled();
		const end = {
			ended: s.pdfStore.deletionAt(OLD) === undefined,
			pane: s.plugin.pdfIds.get(pane.root),
			chose,
			moved,
			claims: v.sidecar(x)?.pdfPaths,
		};
		console.log(`late claim move, deletion made after the open, before the rename: ${JSON.stringify(end)}`);
		expect(end, "the open's late claim move did not end, as before, a deletion made after the pane opened and waiting at the old name at the rename").toEqual({
			ended: true,
			pane: chose,
			chose: x,
			moved: [[OLD, NEW]],
			claims: [NEW],
		});
	});

	it("renamed twice before its id (the old name to a second name, then to the new name), a deletion waiting at the old name at the first rename: the late move ends it as before, and the claim is on the new name", async () => {
		const { v, x } = await inkedAtOld();
		const s = session(v);
		const token = await deletedAndBack(s);
		const moved = s.claimMovesOf(x);
		const pane = s.start(OLD, { holdHead: true });
		const load = s.holdPaneLoad(pane.root);
		await reach(pane.head!, pane.done, "its head read");
		await s.renameFile(OLD, MID);
		await s.renameFile(MID, NEW);
		expect(s.plugin.pdfIds.has(pane.root), "precondition: the pane has no id at either rename").toBe(false);
		expect(s.pdfStore.deletionAt(OLD), "precondition: the deletion waiting at the old name at the first rename waits still").toBe(token);
		expect(s.pdfStore.deletionAt(MID), "precondition: no deletion waits at the second name").toBeUndefined();
		expect([moved, s.noPaneMoves], "precondition: neither rename moved a claim (the pane is being identified)").toEqual([[], []]);
		pane.head!.gate.release();
		await reach(load, pane.done, "its ink file's load");
		const chose = s.plugin.pdfIds.get(pane.root) as string;
		expect(s.pdfStore.deletionAt(OLD), "precondition: the same deletion still waits when the claim step comes").toBe(token);
		load.gate.release();
		await pane.done;
		await s.settled();
		const end = {
			ended: s.pdfStore.deletionAt(OLD) === undefined,
			pane: s.plugin.pdfIds.get(pane.root),
			chose,
			moved,
			claims: v.sidecar(x)?.pdfPaths,
		};
		console.log(`late claim move, two renames in the head read, deletion waiting at the first: ${JSON.stringify(end)}`);
		expect(end, "after two renames before the id, the open's late claim move did not end, as before, the deletion waiting at the old name at the first rename").toEqual({
			ended: true,
			pane: chose,
			chose: x,
			moved: [[OLD, NEW]],
			claims: [NEW],
		});
	});
});

describe("a PDF renamed while its pane's ink file loads (the id set): the rename handler moves the claim, the open's claim step again", () => {
	it("a PDF made at the old name inside the load, inked and deleted: the late move leaves its deletion waiting, the same one", async () => {
		const { v, x } = await inkedAtOld();
		const s = session(v);
		const moved = s.claimMovesOf(x);
		const pane = s.start(OLD);
		const load = s.holdPaneLoad(pane.root);
		await reach(load, pane.done, "its ink file's load");
		expect(s.plugin.pdfIds.get(pane.root), "precondition: the pane chose the ink that claims the old name").toBe(x);
		await s.renameFile(OLD, NEW);
		expect([moved, s.noPaneMoves], "precondition: the rename handler moved the pane's claim, and no other move ran").toEqual([[[OLD, NEW]], []]);
		expect(s.pdfStore.deletionAt(OLD), "precondition: no deletion waits at the old name at the rename").toBeUndefined();
		const { made, token } = await madeInkedDeleted(v, s, OLD);
		expect(made.id, "precondition: the made PDF has its own ink").not.toBe(x);
		expect(moved, "precondition: the claim step has not run").toEqual([[OLD, NEW]]);
		load.gate.release();
		await pane.done;
		await s.settled();
		expect(moved, "precondition: the claim step moved the claim again").toEqual([
			[OLD, NEW],
			[OLD, NEW],
		]);
		const end = {
			sameDeletion: s.pdfStore.deletionAt(OLD) === token,
			pane: s.plugin.pdfIds.get(pane.root),
			claims: v.sidecar(x)?.pdfPaths,
			madeClaims: v.sidecar(made.id)?.pdfPaths,
		};
		console.log(`late claim move, rename in the load, later deletion: ${JSON.stringify(end)}`);
		expect(end, "the open's late claim move ended the deletion of a PDF made at the old name after the rename").toEqual({
			sameDeletion: true,
			pane: x,
			claims: [NEW],
			madeClaims: [OLD],
		});
	});

	it("a deletion waiting at the old name when the rename comes (deleted, made again at its name, then renamed): it ends as before (here the rename handler's move ends it)", async () => {
		const { v, x } = await inkedAtOld();
		const s = session(v);
		const token = await deletedAndBack(s);
		const moved = s.claimMovesOf(x);
		const pane = s.start(OLD);
		const load = s.holdPaneLoad(pane.root);
		await reach(load, pane.done, "its ink file's load");
		const chose = s.plugin.pdfIds.get(pane.root) as string;
		expect(s.pdfStore.deletionAt(OLD), "precondition: the deletion waits at the old name at the rename").toBe(token);
		await s.renameFile(OLD, NEW);
		const atRename = { waiting: s.pdfStore.deletionAt(OLD) === token, moved: [...moved], noPane: [...s.noPaneMoves] };
		load.gate.release();
		await pane.done;
		await s.settled();
		const end = {
			atRename,
			ended: s.pdfStore.deletionAt(OLD) === undefined,
			pane: s.plugin.pdfIds.get(pane.root),
			chose,
			moved,
		};
		console.log(`late claim move, rename in the load, deletion waiting at the rename: ${JSON.stringify(end)}`);
		expect(end, "the deletion waiting at the old name at the rename did not end as before").toEqual({
			atRename: { waiting: false, moved: [[OLD, NEW]], noPane: [] },
			ended: true,
			pane: chose,
			chose: x,
			moved: [
				[OLD, NEW],
				[OLD, NEW],
			],
		});
	});

	it("a PDF renamed onto a deleted PDF's name in its grace, opened there, renamed again while its ink file loads: the deleted PDF's deletion waits on, the same one, and its ink goes to the trash at its grace", async () => {
		const { v, x } = await inkedAtOld();
		const s = session(v);
		// Another document at ONTO, inked and deleted, the PDF at the old name standing at its delete. The clock is faked
		// from the delete, so its grace can be run out.
		const { made: gone, token } = await madeInkedDeleted(v, s, ONTO, () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
		expect(gone.id, "precondition: the deleted PDF has its own ink").not.toBe(x);
		await s.renameFile(OLD, ONTO);
		expect(s.pdfStore.deletionAt(ONTO), "precondition: the deletion waits on after the PDF is renamed onto its name, the same one").toBe(token);
		expect([...(s.pdfStore.arrivedAt(ONTO) ?? [])], "precondition: the renamed PDF's ink came with it onto the deleted name").toEqual([x]);
		const moved = s.claimMovesOf(x);
		const pane = s.start(ONTO);
		const load = s.holdPaneLoad(pane.root);
		await reach(load, pane.done, "its ink file's load");
		expect(s.plugin.pdfIds.get(pane.root), "precondition: the pane chose the renamed PDF's ink").toBe(x);
		await s.renameFile(ONTO, NEW);
		const atRename = {
			moved: [...moved],
			noPane: [...s.noPaneMoves],
			waiting: s.pdfStore.deletionAt(ONTO) === token,
			arrived: [...(s.pdfStore.arrivedAt(ONTO) ?? [])],
		};
		expect(atRename, "precondition: the rename handler moved the pane's claim and took its ink off the deleted name's arrivals, the deletion waiting on").toEqual({
			moved: [[ONTO, NEW]],
			noPane: [`${OLD} -> ${ONTO}`],
			waiting: true,
			arrived: [],
		});
		load.gate.release();
		await pane.done;
		await s.settled();
		const atClaimStep = { moved: [...moved], sameDeletion: s.pdfStore.deletionAt(ONTO) === token };
		await settleGrace(s);
		const end = {
			...atClaimStep,
			pane: s.plugin.pdfIds.get(pane.root),
			claims: v.sidecar(x)?.pdfPaths,
			goneLive: v.adapter.files.has(`.handwriting/${gone.id}.json`),
			goneInTrash: v.trashInk().some((t) => t.includes("made")),
		};
		console.log(`late claim move, renamed onto a deleted name, opened, renamed in the load: ${JSON.stringify(end)}`);
		expect(end, "the open's repeat of the rename handler's move ended the deleted PDF's deletion, or its ink did not reach the trash at its grace").toEqual({
			moved: [
				[ONTO, NEW],
				[ONTO, NEW],
			],
			sameDeletion: true,
			pane: x,
			claims: [NEW],
			goneLive: false,
			goneInTrash: true,
		});
	});
});

describe("a PDF renamed before its pane has its id and again while its ink file loads: the open's late claim move is the first name's only move", () => {
	it("a deletion waiting at the old name at the first rename (deleted, made again at its name): the late move ends it as before, and the claim is on the new name only", async () => {
		const { v, x } = await inkedAtOld();
		const s = session(v);
		const token = await deletedAndBack(s);
		const moved = s.claimMovesOf(x);
		const pane = s.start(OLD, { holdHead: true });
		const load = s.holdPaneLoad(pane.root);
		await reach(pane.head!, pane.done, "its head read");
		await s.renameFile(OLD, MID);
		expect(s.plugin.pdfIds.has(pane.root), "precondition: the pane has no id at the first rename").toBe(false);
		expect([moved, s.noPaneMoves], "precondition: the first rename moved no claim (the pane is being identified)").toEqual([[], []]);
		pane.head!.gate.release();
		await reach(load, pane.done, "its ink file's load");
		const chose = s.plugin.pdfIds.get(pane.root) as string;
		expect(chose, "precondition: the pane chose the ink that claims the old name").toBe(x);
		await s.renameFile(MID, NEW);
		expect([moved, s.noPaneMoves], "precondition: the rename handler moved the pane's claim off the second name only").toEqual([[[MID, NEW]], []]);
		expect(s.pdfStore.deletionAt(OLD), "precondition: the same deletion still waits at the old name when the claim step comes").toBe(token);
		load.gate.release();
		await pane.done;
		await s.settled();
		const end = {
			ended: s.pdfStore.deletionAt(OLD) === undefined,
			pane: s.plugin.pdfIds.get(pane.root),
			chose,
			moved,
			claims: v.sidecar(x)?.pdfPaths,
		};
		console.log(`late claim move, renamed in the head read and in the load, deletion waiting at the first rename: ${JSON.stringify(end)}`);
		expect(end, "the rename handler's move off the second name stopped the open's late claim move ending, as before, the deletion waiting at the old name at the first rename").toEqual({
			ended: true,
			pane: chose,
			chose: x,
			moved: [
				[MID, NEW],
				[OLD, NEW],
			],
			claims: [NEW],
		});
	});
});
