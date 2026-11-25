/**
 * A PDF renamed onto the name of an inked PDF deleted moments before is another file. Its open must not carry the
 * deleted PDF's ink in as if the PDF had changed on disk: no strokes, no "changed on disk" notice, no write to either
 * ink file, inside the grace and after it. A file made new at the deleted name, a file changed in place, and a
 * renamed file with ink of its own keep what they do today.
 *
 * Through the plugin and the real stores, with an in-memory vault (PdfRenameOntoDeletedName.test.ts's harness), plus
 * the plugin's own rename, create and delete handlers. Here each path keeps its own bytes, so two files can be two
 * documents, and Notice records what it said.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import HandwritingPlugin from "../main";
import { TFile, Notice } from "obsidian";
import pluginSettingsSource from "../settings/PluginSettings.ts?raw";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { parsePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import { appendInkToPdf } from "../ink/InkPdfAppend";
import { document, streamObject } from "../../test/pdf-fixture";

const CARRIED_NOTICE = "Handwriting: this PDF changed on disk. Your ink was carried over to its new version.";

/** The inked PDF that is deleted. */
const NAME = "Report.pdf";
/** Another document, with other bytes, renamed onto NAME. */
const OTHER = "Report v2.pdf";

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

/** The bytes of one document. Another `tag` is another document (another content family). */
function doc(tag: string): Uint8Array {
	return new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n1 0 obj << /Type /Catalog >> endobj\n` + "x".repeat(5000) + "\n%%EOF\n");
}

/** A real one-page PDF from the fixture, over 64 KiB so its head is a part of it, that our Flatten can write into. */
function realPdf(text: string): Uint8Array {
	const after = [streamObject(`BT /F1 12 Tf (${text}) Tj ET`), streamObject("%" + "p".repeat(70_000))];
	return new TextEncoder().encode(document(1, () => "/Contents 4 0 R ", "", after));
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

/** One vault (disk + file list with each file's bytes) shared by any number of plugin sessions. */
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
	/** The vault's PDFs, path to bytes. */
	const files = new Map<string, Uint8Array>();
	/** This device's local storage, which outlives a plugin session. */
	const local = new Map<string, unknown>();
	function sidecar(id: string) {
		const bytes = adapter.files.get(`.handwriting/${id}.json`);
		return bytes === undefined ? undefined : parsePage(bytes, id).data;
	}
	/** The strokes of every ink file in the trash, one list per file, sorted. */
	function trashInk(): string[][] {
		return [...adapter.files.entries()]
			.filter(([p]) => p.includes("/trash/"))
			.map(([p, bytes]) => parsePage(bytes, p).data.strokes.map((s) => s.id))
			.sort();
	}
	/** Every ink file outside the trash, with its bytes and its write stamp: equal before and after = not written. */
	function inkFiles(): Map<string, string> {
		return new Map(
			[...adapter.files.entries()]
				.filter(([p]) => p.startsWith(".handwriting/") && p.endsWith(".json") && !p.includes("/trash/"))
				.map(([p, bytes]) => [p, `${adapter.mtimes.get(p)}\n${bytes}`])
		);
	}
	return { adapter, files, local, sidecar, trashInk, inkFiles };
}

function pdfFile(path: string) {
	return Object.assign(new TFile(), {
		path,
		extension: path.split(".").pop(),
		name: path.split("/").pop(),
		basename: path.replace(/\.[^.]+$/, ""),
	});
}

/** A plugin session (fresh memory) over the shared vault, with the plugin's own vault events, the layout ready. */
function session(v: ReturnType<typeof vault>) {
	const store = new PageStore({ vault: { adapter: v.adapter } } as never);
	const pdfStore = new PdfInkStore();
	const vaultOn = new Map<string, ((...a: unknown[]) => unknown)[]>();
	const app = {
		vault: {
			adapter: v.adapter,
			getFiles: () => [...v.files.keys()].map((path) => ({ path, extension: "pdf" })),
			readBinary: async (file: { path: string }) => {
				const bytes = v.files.get(file.path);
				if (!bytes) throw new Error(`no file at ${file.path}`);
				return bytes.slice().buffer;
			},
			getFileByPath: (p: string) => (v.files.has(p) ? { path: p, extension: "pdf" } : null),
			on: (name: string, handler: (...a: unknown[]) => unknown) => {
				vaultOn.set(name, [...(vaultOn.get(name) ?? []), handler]);
				return {};
			},
		},
		workspace: { layoutReady: true },
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
	installPdfHost.call(plugin, Notice);
	plugin.onloadVaultEvents();
	async function open(path: string) {
		expect(v.files.has(path), `precondition: ${path} exists in the vault`).toBe(true);
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, idle: true };
		plugin.pdfFiles.set(root, path);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId({ view: { file: { path } } }, root, controller);
		return { root, id: plugin.pdfIds.get(root) as string };
	}
	function close(root: HTMLElement) {
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
	/** The vault adds the file with these bytes, then every create handler the plugin registered runs. */
	async function createFile(path: string, bytes: Uint8Array) {
		v.files.set(path, bytes);
		for (const handler of vaultOn.get("create") ?? []) await handler(pdfFile(path));
	}
	/** The vault moves the file and its bytes, then every rename handler the plugin registered runs, and any claim move it started. */
	async function renameFile(from: string, to: string) {
		const bytes = v.files.get(from);
		expect(bytes, `precondition: ${from} exists before the rename`).toBeDefined();
		expect(v.files.has(to), `precondition: nothing is at ${to} before the rename`).toBe(false);
		v.files.delete(from);
		v.files.set(to, bytes!);
		for (const handler of vaultOn.get("rename") ?? []) await handler(pdfFile(to), from);
		await Promise.all(moves.splice(0));
	}
	return { store, pdfStore, plugin, open, close, draw, deleteFile, createFile, renameFile };
}

/** Open `path` in `s`, draw one stroke, save, close. Returns the ink id. */
async function inkOn(s: ReturnType<typeof session>, path: string, strokeId: string, x = 10): Promise<string> {
	const o = await s.open(path);
	s.draw(o.id, stroke(x, strokeId));
	await s.store.flush();
	s.close(o.root);
	return o.id;
}

/** NAME is inked and closed, OTHER (other bytes, no ink) is in the vault and closed. */
async function inkedNameAndBareOther(v: ReturnType<typeof vault>) {
	v.files.set(NAME, doc("report"));
	v.files.set(OTHER, doc("report v2"));
	const s = session(v);
	const deleted = await inkOn(s, NAME, "ink-0");
	expect(v.sidecar(deleted)?.pdfPaths, "precondition: the deleted PDF's ink file claims its name").toEqual([NAME]);
	return { s, deleted };
}

/** NAME is deleted with OTHER in the vault: the deletion counts OTHER as existing and NAME as gone. */
async function deleteName(s: ReturnType<typeof session>, other = OTHER) {
	await s.deleteFile(NAME);
	const existing = s.pdfStore.pendingClaims().get(NAME);
	expect(existing, "precondition: the delete of the name is waiting out its grace").toBeDefined();
	expect(existing?.has(other), "precondition: the other file existed at the delete").toBe(true);
	expect(existing?.has(NAME), "precondition: the deleted name is not among the paths that existed at the delete").toBe(false);
}

/** Run every grace out and let each retirement finish. */
async function settleGrace(s: ReturnType<typeof session>) {
	await vi.advanceTimersByTimeAsync(10_001);
	await vi.waitFor(() => expect(s.pdfStore.pendingClaims().size).toBe(0));
	await s.store.flush();
}

/**
 * Open NAME in `s`, now another document renamed onto it, and check it opens with no carried ink: no strokes, no
 * carried notice, the open's id has no ink file, and no ink file on disk was written.
 */
async function expectOpensBareUntouched(v: ReturnType<typeof vault>, s: ReturnType<typeof session>, deleted: readonly string[]) {
	const before = v.inkFiles();
	const opened = await s.open(NAME);
	await s.store.flush();
	expect(deleted, "the renamed-on file was handed the deleted PDF's own ink file").not.toContain(opened.id);
	expect(s.pdfStore.strokes(opened.id).map((x) => x.id), "the renamed-on file opened wearing the deleted PDF's ink").toEqual([]);
	expect(shown, "the renamed-on file said its ink was carried over").not.toContain(CARRIED_NOTICE);
	expect(v.sidecar(opened.id), "the renamed-on file's open wrote an ink file of its own").toBeUndefined();
	expect(v.inkFiles(), "the open wrote to an ink file").toEqual(before);
	return opened;
}

/** A later session opens NAME and finds it blank, with no notice. */
async function expectBlankLater(v: ReturnType<typeof vault>) {
	shown.length = 0;
	const later = session(v);
	const opened = await later.open(NAME);
	expect(later.pdfStore.strokes(opened.id).map((x) => x.id), `${NAME} opened later wearing ink`).toEqual([]);
	expect(shown, `${NAME} opened later said its ink was carried over`).not.toContain(CARRIED_NOTICE);
}

/**
 * The young-copy road: a flattened copy written a second before the inked PDF is deleted, renamed onto the name, and
 * opened inside the grace. Fake timers are on when it returns.
 */
async function youngCopyOpened(v: ReturnType<typeof vault>) {
	v.files.set(NAME, doc("report"));
	const s = session(v);
	const deleted = await inkOn(s, NAME, "ink-0");
	vi.useFakeTimers();
	const FLAT = "Report.flattened.pdf";
	await s.createFile(FLAT, doc("report, ink drawn in"));
	await vi.advanceTimersByTimeAsync(1_000);
	await s.deleteFile(NAME);
	expect(s.pdfStore.pendingClaims().get(NAME)?.has(FLAT), "precondition: the young copy is not counted as existing").toBe(false);
	await s.renameFile(FLAT, NAME);
	const opened = await s.open(NAME);
	expect(opened.id, "precondition: the copy has another ink id than the deleted PDF").not.toBe(deleted);
	return { s, opened, deleted };
}

describe("another PDF renamed onto the name of an inked PDF just deleted, then opened", () => {
	it("opened inside the grace: blank, no carried notice, no ink file written; after the grace the deleted ink is in the trash and the name opens blank", async () => {
		const v = vault();
		const { s, deleted } = await inkedNameAndBareOther(v);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		const opened = await expectOpensBareUntouched(v, s, [deleted]);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(deleted), "the deleted PDF's ink file still claims the name after the grace").toBeUndefined();
		expect(v.trashInk(), "the trash holds the deleted PDF's ink, strokes whole, and nothing else").toEqual([["ink-0"]]);
		await expectBlankLater(v);
	});

	it("the deleted PDF had changed on disk before (two of its ink files claim the name): opened inside the grace, nothing from either is carried", async () => {
		const v = vault();
		const { s, deleted: first } = await inkedNameAndBareOther(v);
		// The PDF changes while closed and is opened again: its ink is carried into a new ink file, and more is drawn.
		v.files.set(NAME, doc("report, edited"));
		const second = await inkOn(s, NAME, "ink-1", 30);
		expect(second, "precondition: the changed PDF has a new ink file").not.toBe(first);
		expect(s.pdfStore.strokes(second).map((x) => x.id), "precondition: the change carried the first ink in").toEqual(["ink-0", "ink-1"]);
		expect(v.sidecar(first)?.pdfPaths, "precondition: the older ink file still claims the name").toEqual([NAME]);
		expect(v.sidecar(second)?.pdfPaths, "precondition: the newer ink file claims the name").toEqual([NAME]);
		shown.length = 0;
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		const opened = await expectOpensBareUntouched(v, s, [first, second]);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		await expectBlankLater(v);
	});

	it("the other file is a flattened copy written well before the delete: opened inside the grace, blank, no carried notice, no ink file written", async () => {
		const v = vault();
		v.files.set(NAME, doc("report"));
		const s = session(v);
		const deleted = await inkOn(s, NAME, "ink-0");
		vi.useFakeTimers();
		// Flatten writes its copy through the vault alone (createBinary): the store sees only the create.
		const FLAT = "Report.flattened.pdf";
		await s.createFile(FLAT, doc("report, ink drawn in"));
		// Past a create's 90 s: the copy existed at the delete.
		await vi.advanceTimersByTimeAsync(90_001);
		await deleteName(s, FLAT);
		await s.renameFile(FLAT, NAME);
		const opened = await expectOpensBareUntouched(v, s, [deleted]);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.trashInk(), "the trash holds the deleted PDF's ink, strokes whole, and nothing else").toEqual([["ink-0"]]);
		await expectBlankLater(v);
	});

	it("a flattened copy written just before the delete, renamed onto the name and opened inside the grace: it opens on an ink id of its own, and after the grace the deleted PDF's ink is whole in exactly one place, its own ink file or the trash", async () => {
		const v = vault();
		const { s, opened, deleted } = await youngCopyOpened(v);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		// While the limit below stands, the grace trashes nothing on this road and the deleted PDF's own ink file keeps
		// its strokes; once it is cured, the grace moves that file to the trash. Either way the ink is in one place,
		// whole: never lost, never in both.
		const own = v.sidecar(deleted)?.strokes.map((x) => x.id);
		expect([...(own === undefined ? [] : [own]), ...v.trashInk()], "the deleted PDF's ink is whole in exactly one place, its own ink file or the trash, and the trash holds nothing else").toEqual([["ink-0"]]);
	});

	// Known limit, and it stands with the flattened-copy fix: a file made less than 90 s before the delete may be this
	// very file's new name (a sync rename that lands the create first), so the delete does not count it as existing,
	// and its rename onto the name is the deleted file's own return, which carries. The copy here is a PDF of other
	// bytes, not our Flatten's output over the deleted version (another document, though named a flattened copy), so
	// nothing proves it is that version's own copy and it still carries. Our own Flatten's copy on this road gets
	// nothing: the cells below. The road, its preconditions and where the deleted PDF's ink is after the grace are
	// checked in the cell above; this cell holds the limit's own lines only.
	it.fails("known limit: a PDF of other bytes, not our Flatten's, written just before the delete, renamed onto the name and opened inside the grace, is carried no strokes and no notice", async () => {
		const v = vault();
		const { s, opened } = await youngCopyOpened(v);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id), "the PDF of other bytes was carried the deleted PDF's strokes").toEqual([]);
		expect(shown, "the PDF of other bytes said its ink was carried over").not.toContain(CARRIED_NOTICE);
	});

	// Our own Flatten's copy of the deleted version (appendInkToPdf over its bytes with its stored stroke), written 1 s
	// or 60 s before the delete, takes the same road: not counted as existing, renamed onto the name, opened inside the
	// grace. Its pages hold that ink already, so a carry would lay it on twice. Held back in 1.5.2 (FOLLOWUPS 556): the
	// copy carries as on 1.5.1, so these cells are expected failures (it.fails) until that row brings the no-carry back.
	for (const ageMs of [1_000, 60_000]) {
		it.fails(`held back in 1.5.2: our own Flatten of the deleted version, written ${ageMs / 1000} s before the delete, renamed onto the name and opened inside the grace: no stroke carried, no carried notice, the deleted PDF's ink file whole and unwritten; after the grace that ink is whole in exactly one place`, async () => {
			const v = vault();
			v.files.set(NAME, realPdf("report"));
			const s = session(v);
			const deleted = await inkOn(s, NAME, "ink-0");
			const stored = v.sidecar(deleted)?.strokes ?? [];
			expect(stored.map((x) => x.id), "precondition: the deleted PDF's ink file holds its stroke").toEqual(["ink-0"]);
			const copy = appendInkToPdf(v.files.get(NAME)!, stored);
			if (!copy.ok) throw new Error(`precondition: Flatten refused: ${copy.reason}`);
			vi.useFakeTimers();
			// Flatten writes its copy through the vault alone (createBinary): the store sees only the create.
			const FLAT = "Report.flattened.pdf";
			await s.createFile(FLAT, copy.bytes);
			await vi.advanceTimersByTimeAsync(ageMs);
			await s.deleteFile(NAME);
			expect(s.pdfStore.pendingClaims().get(NAME), "precondition: the delete of the name is waiting out its grace").toBeDefined();
			expect(s.pdfStore.pendingClaims().get(NAME)?.has(FLAT), "precondition: the copy is not counted as existing").toBe(false);
			await s.renameFile(FLAT, NAME);
			const opened = await expectOpensBareUntouched(v, s, [deleted]);
			expect(v.sidecar(deleted)?.strokes.map((x) => x.id), "the deleted PDF's ink file lost its stroke").toEqual(["ink-0"]);
			s.close(opened.root);
			await settleGrace(s);
			vi.useRealTimers();
			const own = v.sidecar(deleted)?.strokes.map((x) => x.id);
			expect([...(own === undefined ? [] : [own]), ...v.trashInk()], "the deleted PDF's ink is whole in exactly one place, its own ink file or the trash, and the trash holds nothing else").toEqual([["ink-0"]]);
		});
	}

	it("opened only after the grace: blank, no carried notice, and the deleted ink is in the trash", async () => {
		const v = vault();
		const { s, deleted } = await inkedNameAndBareOther(v);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.trashInk(), "the trash holds the deleted PDF's ink, strokes whole, and nothing else").toEqual([["ink-0"]]);
		const opened = await expectOpensBareUntouched(v, s, [deleted]);
		s.close(opened.root);
		await expectBlankLater(v);
	});
});

describe("what still carries, or shows its own ink", () => {
	it("a new file made at the deleted name inside the grace carries the deleted PDF's ink, with the notice", async () => {
		const v = vault();
		v.files.set(NAME, doc("report"));
		const s = session(v);
		const deleted = await inkOn(s, NAME, "ink-0");
		vi.useFakeTimers();
		await s.deleteFile(NAME);
		await s.createFile(NAME, doc("report, saved again"));
		const opened = await s.open(NAME);
		expect(opened.id, "precondition: the new file has another ink id").not.toBe(deleted);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id), "the new file at the deleted name was not carried the ink").toEqual(["ink-0"]);
		expect(shown.filter((m) => m === CARRIED_NOTICE), "the carried notice, once").toHaveLength(1);
		s.close(opened.root);
		vi.useRealTimers();
	});

	it("a PDF changed in place while closed carries its ink, with the notice", async () => {
		const v = vault();
		v.files.set(NAME, doc("report"));
		const s = session(v);
		const old = await inkOn(s, NAME, "ink-0");
		v.files.set(NAME, doc("report, edited elsewhere"));
		const opened = await s.open(NAME);
		expect(opened.id, "precondition: the changed PDF has another ink id").not.toBe(old);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id), "the changed PDF was not carried its ink").toEqual(["ink-0"]);
		expect(shown.filter((m) => m === CARRIED_NOTICE), "the carried notice, once").toHaveLength(1);
		s.close(opened.root);
	});

	it("a PDF with its own ink renamed onto the deleted name opens with its own ink only, no carried notice", async () => {
		const v = vault();
		const { s, deleted } = await inkedNameAndBareOther(v);
		const own = await inkOn(s, OTHER, "ink-own", 40);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		const opened = await s.open(NAME);
		expect(opened.id, "the renamed file opened with another ink file than its own").toBe(own);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id)).toEqual(["ink-own"]);
		expect(shown, "the renamed file said its ink was carried over").not.toContain(CARRIED_NOTICE);
		s.close(opened.root);
		await settleGrace(s);
		vi.useRealTimers();
		expect(v.sidecar(deleted), "the deleted PDF's ink file still claims the name after the grace").toBeUndefined();
		expect(v.trashInk(), "the trash holds the deleted PDF's ink, strokes whole, and nothing else").toEqual([["ink-0"]]);
	});

	it("another PDF renamed onto the deleted name, off it, back on and off again, then a new file made there: the new file carries the deleted ink, with the notice once", async () => {
		const v = vault();
		const { s, deleted } = await inkedNameAndBareOther(v);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		await s.renameFile(NAME, "Report s.pdf");
		await s.renameFile("Report s.pdf", NAME);
		await s.renameFile(NAME, "Report t.pdf");
		expect(s.pdfStore.pendingClaims().get(NAME)?.has(NAME), "precondition: nothing renamed on is on the name now").toBe(false);
		await s.createFile(NAME, doc("report, back"));
		const opened = await s.open(NAME);
		expect(opened.id, "precondition: the new file has another ink id").not.toBe(deleted);
		expect(s.pdfStore.strokes(opened.id).map((x) => x.id), "the deleted file's return was not carried its ink").toEqual(["ink-0"]);
		expect(shown.filter((m) => m === CARRIED_NOTICE), "the carried notice, once").toHaveLength(1);
		s.close(opened.root);
		vi.useRealTimers();
	});

	// The renamed-on file's own id arrived with it, so the name's pending claim does not count as taken for that id.
	it("another PDF renamed onto the deleted name, opened, inked and closed, then changed in place inside the grace: its own ink carries, with the notice once; the deleted PDF's ink does not", async () => {
		const v = vault();
		const { s, deleted } = await inkedNameAndBareOther(v);
		vi.useFakeTimers();
		await deleteName(s);
		await s.renameFile(OTHER, NAME);
		const first = await s.open(NAME);
		expect(first.id, "precondition: the renamed-on file has another ink id").not.toBe(deleted);
		s.draw(first.id, stroke(50, "ink-renamed"));
		await s.store.flush();
		s.close(first.root);
		expect(v.sidecar(first.id)?.pdfPaths, "precondition: the renamed-on file's own ink claims the name").toEqual([NAME]);
		expect(s.pdfStore.arrivedAt(NAME)?.has(first.id), "precondition: its id arrived with it").toBe(true);
		shown.length = 0;
		v.files.set(NAME, doc("report v2, edited"));
		const again = await s.open(NAME);
		expect(again.id, "precondition: the changed file has a new ink id").not.toBe(first.id);
		expect(s.pdfStore.strokes(again.id).map((x) => x.id), "the renamed-on file's own ink after its change").toEqual(["ink-renamed"]);
		expect(shown.filter((m) => m === CARRIED_NOTICE), "the carried notice, once").toHaveLength(1);
		s.close(again.root);
		vi.useRealTimers();
	});
});
