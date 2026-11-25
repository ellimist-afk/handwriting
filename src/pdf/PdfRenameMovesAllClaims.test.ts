/**
 * FOLLOWUPS 550: a PDF renamed while a pane shows it, and two ink files of its bytes claim its name. The rename moves the
 * claims of the panes' own ids only (PluginOnload's rename handler), so the other ink still claims the old name. A PDF of
 * other bytes made at the old name then opens wearing that ink: it reads as an older version of the new file, and its
 * ink is carried over. The rename should move every claim of the PDF's ink on the old name, as it does for a PDF no pane
 * holds (movePdfClaimOnRename).
 *
 * Cell R is the red cell. Cells G1-G4 are its guards, green at ae1c1ebd:
 * G1 a claim the deleted file's deletion holds at the old name stays; G2 another document's ink on the old name (a PDF
 * renamed off it whose claim move has not landed) stays; G3 a later file's deletion at the old name goes on to its grace;
 * G4 a pane still being identified moves its claim once (in the head read). G4 also holds R's want for a pane still
 * being identified, which holds the claim as a pane with an id does: both inks claim the new name; red at ae1c1ebd.
 *
 * Cells from a read for ways the fix could break: B1, the renamed-onto-a-deleted-name road with a second
 * ink, renamed again while the pane is identified, in the head read and in the load: the deleted PDF's deletion waits on
 * and its ink goes to the trash at its grace. B1 (load) is a guard, green at ae1c1ebd, and pins the base's two moves
 * of the pane's claim in the load (the second on the missed road). B1 (head read) is red at
 * ae1c1ebd with no 550 code: its own row, not 550's scope, kept here expected to fail at base,
 * with one pin beside it, the PDF opened again in a later session as ae1c1ebd does it. B3 (red at ae1c1ebd, for 550's
 * reason) the second ink's first read already running at the rename. B4 is in R (the second ink on disk only, not in
 * memory, with a stroke). B5 is G3. L1 and L2: B2's road, an older version's ink file on the old
 * name, with a pane and with none, a named limit pinned as ae1c1ebd does it.
 *
 * R2 is R's road read after a restart: the session ends, and a later session makes a PDF of other bytes at the old
 * name and opens it; 550's carry is read there.
 *
 * The second ink file of the PDF's bytes is written as a file (cells R, R2, G2, G3, G4, B1, B3), as another device or an
 * older build leaves it: its own id, its own stroke, a claim on the PDF's name. No leave is owed in any cell.
 *
 * Through the plugin and the real stores, with an in-memory vault: the harness of PdfLateClaimMove.test.ts, cut down
 * (its helpers are not exported, and that file is not edited here). Changes: notices are recorded; a rename can be
 * heard without waiting for the claim moves it starts; an open can be told which ink file the folder lists first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every notice said, in order. */
const notices = vi.hoisted(() => [] as string[]);

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			notices.push(message);
		}
	},
}));

import HandwritingPlugin from "../main";
import { TFile, Notice } from "obsidian";
import pluginSettingsSource from "../settings/PluginSettings.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { familyOf } from "./PdfIdentity";
import { parsePage, serializePage } from "../model/PageData";
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
	notices.length = 0;
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
	// kept here, so a rename can be waited for.
	const moves: Promise<void>[] = [];
	const moveClaim = HandwritingPlugin.prototype.movePdfClaimOnRename;
	plugin.movePdfClaimOnRename = (file: TFile, oldPath: string) => {
		const move = moveClaim.call(plugin, file, oldPath);
		moves.push(move);
		return move;
	};
	// The same for the move of the other inks' claims at a rename with a pane (at the rename, or once the pane's
	// identification ends), when the plugin has it.
	const moveBeside = HandwritingPlugin.prototype.movePdfClaimsBesidePane as ((...a: unknown[]) => Promise<void>) | undefined;
	if (moveBeside) {
		plugin.movePdfClaimsBesidePane = (...a: unknown[]) => {
			const move = moveBeside.apply(plugin, a);
			moves.push(move);
			return move;
		};
	}
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
	 * Then every rename handler the plugin registered runs. Returns every claim move the handlers started, as one
	 * promise, not waited for here (in an object, so the await of this does not wait for it); renameFile waits for them.
	 */
	async function hearRename(from: string, to: string): Promise<{ moves: Promise<unknown> }> {
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
		return { moves: Promise.all(moves.splice(0)) };
	}
	async function renameFile(from: string, to: string) {
		await (await hearRename(from, to)).moves;
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
	/** As claimMovesOf, each move with how renamePath was told to take it: "moved", or "passed over" (its missed road). */
	function markedClaimMovesOf(id: string): [string, string, string][] {
		const seen: [string, string, string][] = [];
		const renamePath = pdfStore.renamePath.bind(pdfStore);
		pdfStore.renamePath = ((i: string, from: string, to: string, missed?: boolean) => {
			if (i === id) seen.push([from, to, missed ? "passed over" : "moved"]);
			return renamePath(i, from, to, missed);
		}) as typeof pdfStore.renamePath;
		return seen;
	}
	async function settled() {
		await Promise.all(moves.splice(0));
		await pdfStore.settle();
		await store.flush();
	}
	return { store, pdfStore, plugin, start, open, holdPaneLoad, close, draw, deleteFile, createFile, hearRename, renameFile, claimMovesOf, markedClaimMovesOf, settled };
}

type Session = ReturnType<typeof session>;

const OLD = "Notes/Lecture.pdf";
const NEW = "Notes/Lecture annotated.pdf";
/** A copy of the PDF's bytes (cell G1), renamed onto the old name after the PDF there is deleted. */
const COPY = "Notes/Lecture copy.pdf";
/** Another document's name, deleted before the PDF is renamed onto it (cells B1). */
const ONTO = "Archive/Handout.pdf";
/** The name another document is renamed to, off the old name (cell G2). */
const ELSEWHERE = "Archive/Other.pdf";
const OWED_KEY = "handwriting-pdf-owed-leaves";
const CARRIED = "Handwriting: this PDF changed on disk. Your ink was carried over to its new version.";

/** The ids of the live ink files (the ink folder, not its trash). */
function liveInkFiles(v: Vault): string[] {
	return [...v.adapter.files.keys()]
		.map((p) => /^\.handwriting\/([^/]+)\.json$/.exec(p)?.[1])
		.filter((id): id is string => id !== undefined)
		.sort();
}

/** Every live ink file that claims `path` on disk, sorted. */
function claimersOnDisk(v: Vault, path: string): string[] {
	return liveInkFiles(v).filter((id) => v.sidecar(id)?.pdfPaths?.includes(path) === true);
}

/** The ids of the strokes in a live ink file, sorted; [] for none or no file. */
function inkOf(v: Vault, id: string): string[] {
	return (v.sidecar(id)?.strokes ?? []).map((x) => x.id).sort();
}

/** An open lists the ink file `first` before every other, whatever the folder's order. */
function listFirst(s: Session, first: string) {
	const list = s.store.listIds.bind(s.store);
	s.store.listIds = (async (prefix: string) => {
		const ids = [...(await list(prefix))].sort();
		return [...ids.filter((i) => i === first), ...ids.filter((i) => i !== first)];
	}) as typeof s.store.listIds;
}

/**
 * An ink file written as another device or an older build leaves it: `id`, one stroke, a claim on `claims`. Dropped in
 * as a sync tool drops a file, with a modified time: a file with none has no newest claimant at a carry, and nothing is
 * carried.
 */
function writeInkFile(v: Vault, like: string, id: string, strokeId: string, claims: string[]) {
	const page = v.sidecar(like)!;
	page.pageId = id;
	page.strokes = [stroke(40, strokeId)];
	page.pdfPaths = claims;
	v.adapter.externalWrite(`.handwriting/${id}.json`, serializePage(page));
}

/**
 * The PDF at the old name inked in an earlier session and closed (ink x, stroke "own"), and a second ink file of its
 * bytes that claims the old name too (x2, stroke "second").
 */
async function twoInksAtOld() {
	const v = vault();
	v.files.add(OLD);
	const first = session(v);
	const o = await first.open(OLD);
	first.draw(o.id, stroke(10, "own"));
	await first.store.flush();
	first.close(o.root);
	first.plugin.releasePdfId(o.id);
	await first.store.flush();
	const x = o.id;
	const x2 = `${x}-2`;
	writeInkFile(v, x, x2, "second", [OLD]);
	expect(claimersOnDisk(v, OLD), "precondition: both inks claim the PDF's name").toEqual([x, x2]);
	expect(v.local.has(OWED_KEY), "precondition: no leave is owed").toBe(false);
	return { v, x, x2 };
}

/** A pane on the old name that shows x, in a fresh session. */
async function paneOnX(v: Vault, x: string) {
	const s = session(v);
	listFirst(s, x);
	const pane = await s.open(OLD);
	expect(pane.id, "precondition: the pane shows the first ink").toBe(x);
	expect(s.plugin.pdfPaneHoldsClaim(OLD), "precondition: a pane holds the old name's claim").toBe(true);
	return { s, pane };
}

/** Waits for a hold, failing at once if the open ends first. */
async function reach(h: { reached: Promise<void> }, done: Promise<void>, what: string) {
	let ended = false;
	await Promise.race([h.reached, done.then(() => (ended = true))]);
	expect(ended, `precondition: the open ended before ${what}`).toBe(false);
}

/**
 * The first read of `id`'s ink file from now on (its load, its claims, its claim for a carry) held once, until
 * `release`. `disarm`: no read is held from then on.
 */
function holdFirstRead(s: Session, id: string) {
	const h = hold();
	let armed = true;
	const wrap = <K extends "load" | "readPdfPaths" | "readPdfClaim">(name: K) => {
		const real = (s.store[name] as (...a: unknown[]) => Promise<unknown>).bind(s.store);
		(s.store as unknown as Record<K, unknown>)[name] = async (i: string, ...rest: unknown[]) => {
			if (armed && i === id && !h.gate.held) {
				h.gate.held = true;
				h.gate.reach();
				await h.released;
			}
			return real(i, ...rest);
		};
	};
	wrap("load");
	wrap("readPdfPaths");
	wrap("readPdfClaim");
	return { ...h, disarm: () => (armed = false) };
}

/**
 * Lets every step started so far that waits on nothing held run to its end: microtask turns only (the stores here are
 * in memory; a timer may be faked). Raced against a rename's claim moves, so a move that waits on a hold cannot wedge
 * the cell.
 */
async function drain() {
	for (let i = 0; i < 1000; i++) await Promise.resolve();
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

/** On a faked clock: run every grace out and let each retirement finish. */
async function settleGrace(s: Session) {
	await vi.advanceTimersByTimeAsync(10_001);
	await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
	await s.store.flush();
}

/**
 * The road of PdfLateClaimMove.test.ts's "renamed onto a deleted PDF's name in its grace" with a second
 * ink file of the PDF's bytes: both inks claim the old name; another document at ONTO, inked and deleted; the PDF
 * renamed onto ONTO in that grace with no pane, so both claims move there and arrive with it. The clock is faked from
 * the delete, so the grace can be run out.
 */
async function twoInksOntoDeleted() {
	const { v, x, x2 } = await twoInksAtOld();
	const s = session(v);
	const { made: gone, token } = await madeInkedDeleted(v, s, ONTO, () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
	expect([x, x2], "precondition: the deleted PDF has its own ink").not.toContain(gone.id);
	await s.renameFile(OLD, ONTO);
	expect(s.pdfStore.deletionAt(ONTO), "precondition: the deletion waits on after the PDF is renamed onto its name, the same one").toBe(token);
	expect([...(s.pdfStore.arrivedAt(ONTO) ?? [])].sort(), "precondition: both inks of the renamed PDF came with it onto the deleted name").toEqual([x, x2]);
	await s.store.flush();
	expect(claimersOnDisk(v, ONTO), "precondition: the deleted PDF's ink and both inks of the renamed PDF claim the name").toEqual([gone.id, x, x2].sort());
	return { v, s, x, x2, gone, token };
}

/** The PDF's bytes saved again in place while it was closed: another content family. */
const changedBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog /Version 2 >> endobj\n" + "z".repeat(5200) + "\n%%EOF\n");

/**
 * B2's road up to the rename: the PDF at the old name inked (ink x, stroke "v1") in an earlier session and closed; its
 * bytes changed while it was closed; opened in a fresh session on a fresh ink id of its new bytes, which carries v1's
 * ink over, with the notice. x, read and let go, still claims the old name.
 */
async function changedWhileClosed() {
	const v = vault();
	v.files.add(OLD);
	const first = session(v);
	const o = await first.open(OLD);
	first.draw(o.id, stroke(10, "v1"));
	await first.store.flush();
	first.close(o.root);
	first.plugin.releasePdfId(o.id);
	await first.store.flush();
	const x = o.id;
	v.bytesAt.set(OLD, changedBytes);
	const s = session(v);
	notices.length = 0;
	const pane = await s.open(OLD);
	await s.settled();
	const opened = {
		freshFamily: familyOf(pane.id) !== familyOf(x),
		ink: s.pdfStore.strokes(pane.id).map((k) => k.id),
		notices: [...notices],
		olderClaims: v.sidecar(x)?.pdfPaths,
	};
	expect(opened, "precondition: the changed PDF opened on its new bytes' ink, carried v1's ink over with the notice, and v1's file still claims the old name").toEqual({
		freshFamily: true,
		ink: ["v1"],
		notices: [CARRIED],
		olderClaims: [OLD],
	});
	return { v, s, x, pane };
}

describe("a PDF renamed while a pane shows one of the two inks that claim it", () => {
	it("R: the rename moves both claims to the new name and leaves none on the old; a PDF of other bytes made at the old name opens blank, with no notice", async () => {
		const { v, x, x2 } = await twoInksAtOld();
		const { s } = await paneOnX(v, x);
		// B4: the second ink is on disk only, not in this session's memory, so a move must find it through the ink folder.
		const secondInMemoryAtRename = s.pdfStore.claimedInstances((i) => i === x2).length > 0;
		await s.renameFile(OLD, NEW);
		await s.settled();
		const claims = { secondInMemoryAtRename, newClaimers: claimersOnDisk(v, NEW), oldClaimers: claimersOnDisk(v, OLD) };
		v.bytesAt.set(OLD, otherBytes);
		await s.createFile(OLD);
		notices.length = 0;
		const made = await s.open(OLD);
		await s.settled();
		expect([x, x2], "precondition: the PDF made at the old name has ink of its own").not.toContain(made.id);
		const end = {
			...claims,
			madeInk: s.pdfStore.strokes(made.id).map((k) => k.id).sort(),
			notices: [...notices],
			renamedInk: inkOf(v, x),
			secondInk: inkOf(v, x2),
		};
		console.log(`R: ${JSON.stringify(end)}`);
		expect(end, "the rename left the second ink's claim on the old name, and a PDF made there opened wearing that ink").toEqual({
			secondInMemoryAtRename: false,
			newClaimers: [x, x2],
			oldClaimers: [],
			madeInk: [],
			notices: [],
			renamedInk: ["own"],
			secondInk: ["second"],
		});
	});

	it("R2: the rename moves both claims to the new name and leaves none on the old; after a restart, a PDF of other bytes made at the old name opens blank, with no notice", async () => {
		const { v, x, x2 } = await twoInksAtOld();
		const { s, pane } = await paneOnX(v, x);
		const secondInMemoryAtRename = s.pdfStore.claimedInstances((i) => i === x2).length > 0;
		await s.renameFile(OLD, NEW);
		await s.settled();
		const claims = { secondInMemoryAtRename, newClaimers: claimersOnDisk(v, NEW), oldClaimers: claimersOnDisk(v, OLD) };
		// The session ends, as at a restart: its pane closed and its ink let go.
		s.close(pane.root);
		s.plugin.releasePdfId(pane.id);
		await s.store.flush();
		const later = session(v);
		v.bytesAt.set(OLD, otherBytes);
		await later.createFile(OLD);
		notices.length = 0;
		const made = await later.open(OLD);
		await later.settled();
		expect([x, x2], "precondition: the PDF made at the old name has ink of its own").not.toContain(made.id);
		const end = {
			...claims,
			madeInk: later.pdfStore.strokes(made.id).map((k) => k.id).sort(),
			notices: [...notices],
			renamedInk: inkOf(v, x),
			secondInk: inkOf(v, x2),
		};
		console.log(`R2: ${JSON.stringify(end)}`);
		expect(end, "the rename left the second ink's claim on the old name, and after a restart a PDF made there opened wearing that ink").toEqual({
			secondInMemoryAtRename: false,
			newClaimers: [x, x2],
			oldClaimers: [],
			madeInk: [],
			notices: [],
			renamedInk: ["own"],
			secondInk: ["second"],
		});
	});
});

describe("guards: what a rename with a pane must not move or end", () => {
	it("G1: a copy renamed onto the name of a deleted PDF in its grace, then renamed on with its pane open: the deleted PDF's claim on that name stays for its retirement, and its deletion waits, the same one", async () => {
		const v = vault();
		v.files.add(OLD);
		v.files.add(COPY);
		const first = session(v);
		const o = await first.open(OLD);
		first.draw(o.id, stroke(10, "deleted-ink"));
		await first.store.flush();
		first.close(o.root);
		first.plugin.releasePdfId(o.id);
		await first.store.flush();
		const deleted = o.id;
		const s = session(v);
		const copy = await s.open(COPY);
		expect(copy.id, "precondition: the copy has ink of its own").not.toBe(deleted);
		s.draw(copy.id, stroke(30, "copy-ink"));
		await s.store.flush();
		await s.deleteFile(OLD);
		expect(s.pdfStore.deletionAt(OLD), "precondition: the deletion of the old name waits in its grace").toBeDefined();
		await s.renameFile(COPY, OLD);
		await s.settled();
		const token = s.pdfStore.deletionAt(OLD);
		expect(token, "precondition: the deletion still waits after the copy is renamed onto its name").toBeDefined();
		expect(s.plugin.pdfPaneHoldsClaim(OLD), "precondition: the copy's pane holds the name's claim").toBe(true);
		expect(claimersOnDisk(v, OLD), "precondition: the deleted PDF's ink and the copy's both claim the name").toEqual([deleted, copy.id].sort());
		await s.renameFile(OLD, NEW);
		await s.settled();
		const end = {
			deletedClaims: v.sidecar(deleted)?.pdfPaths,
			deletedInk: inkOf(v, deleted),
			sameDeletion: s.pdfStore.deletionAt(OLD) === token,
			copyClaims: v.sidecar(copy.id)?.pdfPaths,
		};
		console.log(`G1: ${JSON.stringify(end)}`);
		expect(end, "the rename took the deleted PDF's claim off the name its deletion holds, or ended that deletion").toEqual({
			deletedClaims: [OLD],
			deletedInk: ["deleted-ink"],
			sameDeletion: true,
			copyClaims: [NEW],
		});
	});

	// Another document's ink, never the renamed PDF's own older version: that road is the
	// named limit of cells L1 and L2.
	it("G2: another document renamed off the old name, its claim move held; the PDF renamed onto that name, opened, renamed on with its pane: the other document's ink is not moved with it, and goes to its own PDF's new name when its move lands", async () => {
		const v = vault();
		v.files.add(OLD);
		v.bytesAt.set(OLD, otherBytes);
		v.files.add(COPY);
		const first = session(v);
		// Another document at the old name, inked in an earlier session, closed and let go.
		const o = await first.open(OLD);
		first.draw(o.id, stroke(50, "other-doc"));
		await first.store.flush();
		first.close(o.root);
		first.plugin.releasePdfId(o.id);
		await first.store.flush();
		const other = o.id;
		// The PDF at COPY, inked the same way, and a second ink file of its bytes claiming COPY too.
		const c = await first.open(COPY);
		first.draw(c.id, stroke(10, "own"));
		await first.store.flush();
		first.close(c.root);
		first.plugin.releasePdfId(c.id);
		await first.store.flush();
		const x = c.id;
		const x2 = `${x}-2`;
		writeInkFile(v, x, x2, "second", [COPY]);
		expect(familyOf(other), "precondition: the other document's ink is of another content family").not.toBe(familyOf(x));
		const s = session(v);
		// The other document renamed off the old name (no pane): its claim move waits at its ink file's first read.
		const read = holdFirstRead(s, other);
		const { moves: otherMove } = await s.hearRename(OLD, ELSEWHERE);
		const held = await Promise.race([read.reached.then(() => true), otherMove.then(() => false)]);
		expect(held, "precondition: the other document's claim move waits at its ink file's read").toBe(true);
		// The PDF renamed onto the old name (no pane): both its claims move there.
		await s.renameFile(COPY, OLD);
		await s.store.flush();
		expect(claimersOnDisk(v, OLD), "precondition: both inks of the PDF and the other document's ink claim the old name").toEqual([x, x2, other].sort());
		listFirst(s, x);
		const pane = await s.open(OLD);
		expect(pane.id, "precondition: the pane shows the PDF's first ink").toBe(x);
		expect(s.plugin.pdfPaneHoldsClaim(OLD), "precondition: a pane holds the old name's claim").toBe(true);
		await s.renameFile(OLD, NEW);
		await s.store.flush();
		const atRename = { otherClaims: v.sidecar(other)?.pdfPaths, renamedClaims: v.sidecar(x)?.pdfPaths };
		read.gate.release();
		await otherMove;
		await s.settled();
		const end = { atRename, otherClaims: v.sidecar(other)?.pdfPaths, otherInk: inkOf(v, other) };
		console.log(`G2: ${JSON.stringify(end)}`);
		expect(end, "the rename moved another document's ink claim with the PDF, or that document's own move did not land").toEqual({
			atRename: { otherClaims: [OLD], renamedClaims: [NEW] },
			otherClaims: [ELSEWHERE],
			otherInk: ["other-doc"],
		});
	});

	it("G3: a PDF of other bytes made at the old name after the rename, inked and deleted while a claim move of the rename waits: its deletion goes on, the same one", async () => {
		const { v, x, x2 } = await twoInksAtOld();
		const { s } = await paneOnX(v, x);
		const read = holdFirstRead(s, x2);
		const { moves } = await s.hearRename(OLD, NEW);
		expect(s.pdfStore.deletionAt(OLD), "precondition: no deletion waits at the old name at the rename").toBeUndefined();
		// Held only when a claim move of the rename reads the second ink; none does at ae1c1ebd, and the hold is dropped.
		const heldByMove = await Promise.race([read.reached.then(() => true), moves.then(() => false)]);
		if (!heldByMove) read.disarm();
		v.bytesAt.set(OLD, otherBytes);
		await s.createFile(OLD);
		const made = await s.open(OLD);
		s.draw(made.id, stroke(70, "made"));
		await s.store.flush();
		s.close(made.root);
		s.plugin.releasePdfId(made.id);
		await s.store.flush();
		await s.deleteFile(OLD);
		const token = s.pdfStore.deletionAt(OLD);
		expect(token, "precondition: the made PDF's deletion waits in its grace").toBeDefined();
		read.gate.release();
		await moves;
		await s.settled();
		const end = { sameDeletion: s.pdfStore.deletionAt(OLD) === token, madeClaims: v.sidecar(made.id)?.pdfPaths };
		console.log(`G3: ${JSON.stringify({ heldByMove, ...end })}`);
		expect(end, "a claim move of the rename ended the deletion of a PDF made at the old name after it").toEqual({
			sameDeletion: true,
			madeClaims: [OLD],
		});
	});

	// The guard is asserted first, then the want: a pane still being identified holds the claim as a pane with an id
	// does, so the second ink's claim moves too. At ae1c1ebd the guard holds and the want is red.
	it("G4: renamed while its pane is being identified (in the head read): the pane's ink claim moves once, to the new name; once the identification ends, both inks claim the new name on disk, none the old", async () => {
		const { v, x, x2 } = await twoInksAtOld();
		const s = session(v);
		listFirst(s, x);
		const moved = s.claimMovesOf(x);
		const pane = s.start(OLD, { holdHead: true });
		await reach(pane.head!, pane.done, "its head read");
		await s.renameFile(OLD, NEW);
		expect(s.plugin.pdfIds.has(pane.root), "precondition: the pane has no id at the rename").toBe(false);
		pane.head!.gate.release();
		await pane.done;
		await s.settled();
		const end = { pane: s.plugin.pdfIds.get(pane.root), moves: moved, claims: v.sidecar(x)?.pdfPaths };
		const both = { claims: v.sidecar(x)?.pdfPaths, secondClaims: v.sidecar(x2)?.pdfPaths };
		console.log(`G4: ${JSON.stringify({ ...end, secondClaims: both.secondClaims })}`);
		expect(end, "the pane's ink claim did not move exactly once to the new name").toEqual({
			pane: x,
			moves: [[OLD, NEW]],
			claims: [NEW],
		});
		expect(both, "the rename left the second ink's claim on the old name while the pane was being identified").toEqual({
			claims: [NEW],
			secondClaims: [NEW],
		});
	});
});

describe("the renamed-onto-a-deleted-name road with a second ink, renamed again while the pane is identified", () => {
	// Any claim move the rename starts is let land before the pane's claim step runs (raced against a drain, so a move
	// that waits on the held read cannot wedge the cell). The second ink is not asserted here: its claim is cell R's.
	//
	// Expected to fail at ae1c1ebd (it.fails), with no 550 code: run at the base, the pane took a fresh id, x kept
	// ONTO, the deletion ended and the deleted PDF's ink stayed live. By reading: no id at the
	// rename, so the handler moves none; the choice runs at the new name while the inks claim only ONTO (PdfClaims.ts:1810);
	// the late step moves the fresh id with no mark and ends the deletion (:1881-1884, PdfInkStore.ts:2148-2152). Its own
	// row, not 550's scope. After the 550 fix: green, flip this back to it() and the row closes with 550; still red, the
	// row's own fix.
	it.fails("B1 (head read): renamed onto a deleted PDF's name in its grace, opened there, renamed again in the pane's head read: the deleted PDF's deletion waits on, the same one, and its ink goes to the trash at its grace", async () => {
		const { v, s, x, x2, gone, token } = await twoInksOntoDeleted();
		listFirst(s, x);
		const moved = s.claimMovesOf(x);
		const pane = s.start(ONTO, { holdHead: true });
		await reach(pane.head!, pane.done, "its head read");
		const { moves } = await s.hearRename(ONTO, NEW);
		expect(s.plugin.pdfIds.has(pane.root), "precondition: the pane has no id at the rename").toBe(false);
		expect(s.pdfStore.deletionAt(ONTO), "precondition: the deletion waits on at the rename, the same one").toBe(token);
		await Promise.race([moves, drain()]);
		const beforeClaimStep = { moved: [...moved], arrived: [...(s.pdfStore.arrivedAt(ONTO) ?? [])].sort() };
		pane.head!.gate.release();
		await pane.done;
		await moves;
		await s.settled();
		const atClaimStep = { sameDeletion: s.pdfStore.deletionAt(ONTO) === token };
		await settleGrace(s);
		const end = {
			...atClaimStep,
			pane: s.plugin.pdfIds.get(pane.root),
			claims: v.sidecar(x)?.pdfPaths,
			goneLive: v.adapter.files.has(`.handwriting/${gone.id}.json`),
			goneInTrash: v.trashInk().some((t) => t.includes("made")),
		};
		console.log(`B1 head: ${JSON.stringify({ beforeClaimStep, moved, secondClaims: v.sidecar(x2)?.pdfPaths, ...end })}`);
		expect(end, "a claim move of the rename, or the open's late claim move after it, ended the deleted PDF's deletion, or its ink did not reach the trash at its grace").toEqual({
			sameDeletion: true,
			pane: x,
			claims: [NEW],
			goneLive: false,
			goneInTrash: true,
		});
	});

	// One pin more: B1 (head read)'s road, then the PDF opened again in a later session,
	// pinned as ae1c1ebd does it. Not a want: a change here is a fact for the fix and its review, not a red to fix here.
	it("B1 (head read), later session: B1's road, the session ended, the PDF opened again: it opens on its first ink, which takes the new name beside the deleted one; the second ink and the deleted PDF's ink keep the deleted name", async () => {
		const { v, s, x, x2, gone, token } = await twoInksOntoDeleted();
		listFirst(s, x);
		const pane = s.start(ONTO, { holdHead: true });
		await reach(pane.head!, pane.done, "its head read");
		const { moves } = await s.hearRename(ONTO, NEW);
		expect(s.plugin.pdfIds.has(pane.root), "precondition: the pane has no id at the rename").toBe(false);
		expect(s.pdfStore.deletionAt(ONTO), "precondition: the deletion waits on at the rename, the same one").toBe(token);
		await Promise.race([moves, drain()]);
		pane.head!.gate.release();
		await pane.done;
		await moves;
		await s.settled();
		const sameDeletion = s.pdfStore.deletionAt(ONTO) === token;
		await settleGrace(s);
		const firstPane = s.plugin.pdfIds.get(pane.root) as string;
		const first = { pane: firstPane, paneOnDisk: v.adapter.files.has(`.handwriting/${firstPane}.json`), sameDeletion };
		// The session ends, as at a restart: its pane closed and its ink let go.
		s.close(pane.root);
		s.plugin.releasePdfId(firstPane);
		await s.store.flush();
		vi.useRealTimers();
		const later = session(v);
		listFirst(later, x);
		notices.length = 0;
		const again = await later.open(NEW);
		await later.settled();
		const end = {
			pane: again.id,
			paneInk: later.pdfStore.strokes(again.id).map((k) => k.id).sort(),
			claims: v.sidecar(x)?.pdfPaths,
			secondClaims: v.sidecar(x2)?.pdfPaths,
			goneLive: v.adapter.files.has(`.handwriting/${gone.id}.json`),
			goneClaims: v.sidecar(gone.id)?.pdfPaths,
			notices: [...notices],
		};
		console.log(`B1 later: ${JSON.stringify({ first, ...end })}`);
		expect(end, "the pin changed: B1 (head read)'s road opened again in a later session").toEqual({
			pane: x,
			paneInk: ["own"],
			claims: [ONTO, NEW],
			secondClaims: [ONTO],
			goneLive: true,
			goneClaims: [ONTO],
			notices: [],
		});
	});

	// The pane's claim moves twice in the load at ae1c1ebd: the rename handler moves it, and the open's claim step moves it
	// again on the missed road, which ends no deletion. That count is pinned; the fix adds no move of the pane's own id.
	it("B1 (load): renamed onto a deleted PDF's name in its grace, opened there, renamed again while the pane's ink file loads: the deleted PDF's deletion waits on, the same one, and its ink goes to the trash at its grace", async () => {
		const { v, s, x, x2, gone, token } = await twoInksOntoDeleted();
		listFirst(s, x);
		const moved = s.markedClaimMovesOf(x);
		const pane = s.start(ONTO);
		const load = s.holdPaneLoad(pane.root);
		await reach(load, pane.done, "its ink file's load");
		expect(s.plugin.pdfIds.get(pane.root), "precondition: the pane chose the renamed PDF's first ink").toBe(x);
		const { moves } = await s.hearRename(ONTO, NEW);
		expect(s.pdfStore.deletionAt(ONTO), "precondition: the deletion waits on at the rename, the same one").toBe(token);
		await Promise.race([moves, drain()]);
		const beforeClaimStep = { moved: [...moved], arrived: [...(s.pdfStore.arrivedAt(ONTO) ?? [])].sort() };
		load.gate.release();
		await pane.done;
		await moves;
		await s.settled();
		const atClaimStep = { sameDeletion: s.pdfStore.deletionAt(ONTO) === token };
		await settleGrace(s);
		const end = {
			...atClaimStep,
			pane: s.plugin.pdfIds.get(pane.root),
			claims: v.sidecar(x)?.pdfPaths,
			moved,
			goneLive: v.adapter.files.has(`.handwriting/${gone.id}.json`),
			goneInTrash: v.trashInk().some((t) => t.includes("made")),
		};
		console.log(`B1 load: ${JSON.stringify({ beforeClaimStep, secondClaims: v.sidecar(x2)?.pdfPaths, ...end })}`);
		expect(end, "a claim move of the rename, or the open's claim step after it, ended the deleted PDF's deletion, or its ink did not reach the trash at its grace, or the pane's claim moves are not the base's two (the second passed over)").toEqual({
			sameDeletion: true,
			pane: x,
			claims: [NEW],
			moved: [
				[ONTO, NEW, "moved"],
				[ONTO, NEW, "passed over"],
			],
			goneLive: false,
			goneInTrash: true,
		});
	});
});

describe("the second ink's first read already running at the rename", () => {
	it("B3: a pane shows the first ink; the second ink's first read is started and held; the PDF renamed, then the read lands: both claim the new name on disk, none the old", async () => {
		const { v, x, x2 } = await twoInksAtOld();
		const { s } = await paneOnX(v, x);
		const read = holdFirstRead(s, x2);
		const running = s.pdfStore.ensureLoaded(x2);
		const reached = await Promise.race([read.reached.then(() => true), running.then(() => false)]);
		expect(reached, "precondition: the second ink's first read runs, held").toBe(true);
		expect(s.pdfStore.inkReady(x2), "precondition: the second ink's read has not landed").toBe(false);
		const { moves } = await s.hearRename(OLD, NEW);
		await Promise.race([moves, drain()]);
		read.gate.release();
		await running;
		await moves;
		await s.settled();
		const end = { newClaimers: claimersOnDisk(v, NEW), oldClaimers: claimersOnDisk(v, OLD), secondInk: inkOf(v, x2) };
		console.log(`B3: ${JSON.stringify(end)}`);
		expect(end, "the rename passed over the second ink whose read was running, and left its claim on the old name").toEqual({
			newClaimers: [x, x2],
			oldClaimers: [],
			secondInk: ["second"],
		});
	});
});

// Named limit: an older version's ink file is not moved at the rename, pane or not, as in every
// shipped build; with rows 322 and 330. Pinned as ae1c1ebd does it: a change here is a ruling's, not this fix's.
describe("named limit: an older version's ink file stays on the old name at the rename", () => {
	it("L1 (with a pane): inked, changed while closed, reopened (v1's ink carried over), renamed with its pane: v1's file still claims the old name, and a PDF of other bytes made there opens wearing v1's ink, with the notice", async () => {
		const { v, s, x, pane } = await changedWhileClosed();
		expect(s.plugin.pdfPaneHoldsClaim(OLD), "precondition: a pane holds the old name's claim").toBe(true);
		await s.renameFile(OLD, NEW);
		await s.settled();
		const claims = { olderClaims: v.sidecar(x)?.pdfPaths, renamedClaims: v.sidecar(pane.id)?.pdfPaths };
		v.bytesAt.set(OLD, otherBytes);
		await s.createFile(OLD);
		notices.length = 0;
		const made = await s.open(OLD);
		await s.settled();
		expect([x, pane.id], "precondition: the PDF made at the old name has ink of its own").not.toContain(made.id);
		const end = { ...claims, madeInk: s.pdfStore.strokes(made.id).map((k) => k.id).sort(), notices: [...notices] };
		console.log(`L1: ${JSON.stringify(end)}`);
		expect(end, "the named limit changed: an older version's ink file at the rename with a pane").toEqual({
			olderClaims: [OLD],
			renamedClaims: [NEW],
			madeInk: ["v1"],
			notices: [CARRIED],
		});
	});

	it("L2 (no pane): inked, changed while closed, reopened (v1's ink carried over), closed, renamed: v1's file still claims the old name, and a PDF of other bytes made there opens wearing v1's ink, with the notice", async () => {
		const { v, s, x, pane } = await changedWhileClosed();
		s.close(pane.root);
		s.plugin.releasePdfId(pane.id);
		await s.store.flush();
		expect(s.plugin.pdfPaneHoldsClaim(OLD), "precondition: no pane holds the old name's claim").toBe(false);
		await s.renameFile(OLD, NEW);
		await s.settled();
		const claims = { olderClaims: v.sidecar(x)?.pdfPaths, renamedClaims: v.sidecar(pane.id)?.pdfPaths };
		v.bytesAt.set(OLD, otherBytes);
		await s.createFile(OLD);
		notices.length = 0;
		const made = await s.open(OLD);
		await s.settled();
		expect([x, pane.id], "precondition: the PDF made at the old name has ink of its own").not.toContain(made.id);
		const end = { ...claims, madeInk: s.pdfStore.strokes(made.id).map((k) => k.id).sort(), notices: [...notices] };
		console.log(`L2: ${JSON.stringify(end)}`);
		expect(end, "the named limit changed: an older version's ink file at the rename with no pane").toEqual({
			olderClaims: [OLD],
			renamedClaims: [NEW],
			madeInk: ["v1"],
			notices: [CARRIED],
		});
	});
});
