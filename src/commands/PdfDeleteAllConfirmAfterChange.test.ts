/**
 * Delete all ink on this PDF, its dialog left open while the PDF changes on disk, then confirmed.
 *
 * The command takes the PDF's ink id when the dialog opens and the confirm deleted that id. A change on disk while the
 * dialog was open moves the pane to a new id and carries the ink into it (onPdfModified). The confirm then acted on the
 * old id: with the old record already forgotten it said the ink storage was not ready, which is not so; with the old
 * record still held it cleared the old ink file and said "removed 1 stroke" while the same ink stayed on screen in the
 * new id.
 *
 * Want: a confirm made after the PDF's id changed deletes nothing and clears no ink file, and says so in the words the
 * command already shows for a PDF it cannot act on yet ("still identifying"). A confirm with the id unchanged, a change
 * on disk that keeps the id included, deletes as before.
 *
 * Rig: PdfChangedOnDiskKeepsInk.test.ts's session (real PageStore over FakeAdapter, real PdfInkStore, the plugin's own
 * resolvePdfId, onPdfModified and releasePdfId). The command is the real one, registered by
 * registerExportSelectionCommands with the PDF active; the delete is the plugin's real deleteAllPdfInk. Only the dialog is
 * a stand-in: it records its confirm, which the cell calls when the user would press Delete.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const shown = vi.hoisted(() => [] as string[]);
const dialogs = vi.hoisted(() => [] as { count: number; confirm: () => void }[]);
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class Notice {
		constructor(message: string) {
			shown.push(message);
		}
	}
	return { ...actual, Notice };
});
vi.mock("../ink/DeleteAllInk", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		ConfirmDeleteInkModal: class {
			constructor(_app: unknown, count: number, _kind: string, confirm: () => void) {
				dialogs.push({ count, confirm });
			}
			open(): void {}
		},
	};
});

import HandwritingPlugin from "../main";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "../pdf/PdfInkStore";
import type { InkStroke } from "../ink/Stroke";

const IDENTIFYING = "Handwriting: still identifying this PDF - try again in a moment";
const PATH = "Paper.pdf";

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.useFakeTimers();
	shown.length = 0;
	dialogs.length = 0;
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
const ids = (strokes: readonly InkStroke[]) => strokes.map((s) => s.id);

function vault() {
	const adapter = new FakeAdapter() as FakeAdapter & {
		list(folder: string): Promise<{ files: string[]; folders: string[] }>;
	};
	adapter.list = async (folder) => ({
		files: [...adapter.files.keys()].filter((p) => p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")),
		folders: [],
	});
	const bytes = new TextEncoder().encode("%PDF-1.4\n" + "x".repeat(70000) + "\n%%EOF\n");
	return { adapter, pdfs: new Map([[PATH, bytes]]) };
}

type Command = { id: string; checkCallback: (checking: boolean) => boolean };

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
	const commands = new Map<string, Command>();
	const file = { path: PATH, extension: "pdf", basename: "Paper", name: PATH };
	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	Object.assign(plugin, {
		app: {
			workspace: { getLeavesOfType: (type: string) => (type === "pdf" ? leaves : []), getActiveFile: () => file },
			vault: {
				adapter: v.adapter,
				readBinary: async (f: { path: string }) => v.pdfs.get(f.path)!.slice().buffer,
				getFileByPath: (path: string) => (v.pdfs.has(path) ? { path, extension: "pdf" } : null),
			},
		},
		store, pdfStore, pdfInk: new Map(), pdfIds: new Map(), pdfFiles: new Map(),
		addCommand: (command: Command) => {
			commands.set(command.id, command);
			return command;
		},
	});
	// Every delete the confirm starts, so a cell can wait for it to end.
	const deletes: Promise<void>[] = [];
	const deleteAll = plugin.deleteAllPdfInk as (id: string) => Promise<void>;
	plugin.deleteAllPdfInk = function (this: unknown, id: string) {
		const run = deleteAll.call(this, id);
		deletes.push(run);
		return run;
	};
	plugin.registerExportSelectionCommands();
	async function open() {
		const root = { isConnected: true } as unknown as HTMLElement;
		const controller = { refresh() {}, refreshStrip() {}, forgetHistory() {}, idle: true };
		const leaf = { view: { file: { path: PATH }, containerEl: root } };
		leaves.push(leaf);
		plugin.pdfFiles.set(root, PATH);
		plugin.pdfInk.set(root, controller);
		await plugin.resolvePdfId(leaf, root, controller);
		const id = plugin.pdfIds.get(root) as string;
		expect(id, "precondition: the pane has an id").toMatch(/^pdf-/);
		return { root, id, controller };
	}
	/** The command run with the PDF active: the dialog opens and waits for the user. */
	function openDialog(): () => Promise<void> {
		const command = commands.get("delete-all-pdf-ink")!;
		expect(command.checkCallback(false)).toBe(true);
		const dialog = dialogs.at(-1);
		expect(dialog, "precondition: the delete dialog opened").toBeDefined();
		return async () => {
			dialog!.confirm();
			await Promise.all(deletes.splice(0));
		};
	}
	return { store, pdfStore, plugin, open, openDialog };
}

function inkFile(v: ReturnType<typeof vault>, path: string): string[] | undefined {
	const raw = v.adapter.files.get(path);
	return raw === undefined ? undefined : ids(JSON.parse(raw).strokes);
}
const trashFiles = (v: ReturnType<typeof vault>) => [...v.adapter.files.keys()].filter((p) => p.includes("/trash/"));

/** A head byte changed: another version of the PDF, so another id. */
function change(v: ReturnType<typeof vault>) {
	const after = v.pdfs.get(PATH)!.slice();
	after[100] = 121;
	v.pdfs.set(PATH, after);
}

it("A: the PDF changed while the dialog was open and the old ink record is forgotten: the confirm deletes nothing and says the PDF is still being identified", async () => {
	const v = vault();
	const s = session(v);
	const pane = await s.open();
	s.pdfStore.commit(pane.id, stroke("s"));
	await s.store.flush();
	const confirm = s.openDialog();
	change(v);
	await s.plugin.onPdfModified(PATH);
	await vi.advanceTimersByTimeAsync(5000);
	await s.store.flush();
	const moved = s.plugin.pdfIds.get(pane.root) as string;
	expect(moved, "precondition: the pane moved to the new id").not.toBe(pane.id);
	expect(ids(s.pdfStore.strokes(moved)), "precondition: the ink was carried into the new id").toEqual(["s"]);
	expect(s.pdfStore.generation(pane.id), "precondition: the old record is forgotten").toBeNull();
	const oldFile = s.store.path(pane.id);
	const newFile = s.store.path(moved);
	const before = { old: v.adapter.files.get(oldFile), now: v.adapter.files.get(newFile) };
	shown.length = 0;
	await confirm();
	expect(shown, "the confirm's words").toEqual([IDENTIFYING]);
	expect(ids(s.pdfStore.strokes(moved)), "the ink on screen was deleted").toEqual(["s"]);
	expect({ old: v.adapter.files.get(oldFile), now: v.adapter.files.get(newFile) }, "an ink file was written").toEqual(before);
	expect(trashFiles(v), "a trash copy was made").toEqual([]);
});

it("B: the PDF changed while the dialog was open and the old ink record is still held: the confirm clears no ink file and says the PDF is still being identified", async () => {
	const v = vault();
	const s = session(v);
	const pane = await s.open();
	const other = await s.open();
	expect(other.id, "precondition: both panes on one id").toBe(pane.id);
	s.pdfStore.commit(pane.id, stroke("s"));
	await s.store.flush();
	const confirm = s.openDialog();
	change(v);
	// The second pane is mid-stroke at the change, so it stays on the old id until its retry (the busy-pane window);
	// the pen lifts before the retry runs.
	other.controller.idle = false;
	await s.plugin.onPdfModified(PATH);
	other.controller.idle = true;
	await s.store.flush();
	const moved = s.plugin.pdfIds.get(pane.root) as string;
	expect(moved, "precondition: the idle pane moved to the new id").not.toBe(pane.id);
	expect(s.plugin.pdfIds.get(other.root), "precondition: the busy pane is still on the old id").toBe(pane.id);
	expect(ids(s.pdfStore.strokes(pane.id)), "precondition: the old record is held, with its ink").toEqual(["s"]);
	expect(ids(s.pdfStore.strokes(moved)), "precondition: the ink was carried into the new id").toEqual(["s"]);
	const oldFile = s.store.path(pane.id);
	const newFile = s.store.path(moved);
	const before = { old: v.adapter.files.get(oldFile), now: v.adapter.files.get(newFile) };
	shown.length = 0;
	await confirm();
	await s.store.flush();
	expect(shown, "the confirm's words").toEqual([IDENTIFYING]);
	expect(ids(s.pdfStore.strokes(pane.id)), "the old record was cleared").toEqual(["s"]);
	expect(ids(s.pdfStore.strokes(moved)), "the new id's ink was deleted").toEqual(["s"]);
	expect({ old: v.adapter.files.get(oldFile), now: v.adapter.files.get(newFile) }, "an ink file was written").toEqual(before);
	expect(trashFiles(v), "a trash copy was made").toEqual([]);
});

it("B2: as B with the busy pane opened first: the confirm clears no ink file and says the PDF is still being identified", async () => {
	const v = vault();
	const s = session(v);
	const busy = await s.open();
	const idle = await s.open();
	expect(idle.id, "precondition: both panes on one id").toBe(busy.id);
	s.pdfStore.commit(busy.id, stroke("s"));
	await s.store.flush();
	const confirm = s.openDialog();
	change(v);
	// The first-opened pane is mid-stroke at the change, so it stays on the old id until its retry; the pen lifts
	// before the retry runs.
	busy.controller.idle = false;
	await s.plugin.onPdfModified(PATH);
	busy.controller.idle = true;
	await s.store.flush();
	const moved = s.plugin.pdfIds.get(idle.root) as string;
	expect(moved, "precondition: the idle pane moved to the new id").not.toBe(busy.id);
	expect(s.plugin.pdfIds.get(busy.root), "precondition: the busy pane is still on the old id").toBe(busy.id);
	expect(ids(s.pdfStore.strokes(busy.id)), "precondition: the old record is held, with its ink").toEqual(["s"]);
	expect(ids(s.pdfStore.strokes(moved)), "precondition: the ink was carried into the new id").toEqual(["s"]);
	const oldFile = s.store.path(busy.id);
	const newFile = s.store.path(moved);
	const before = { old: v.adapter.files.get(oldFile), now: v.adapter.files.get(newFile) };
	shown.length = 0;
	await confirm();
	await s.store.flush();
	expect(shown, "the confirm's words").toEqual([IDENTIFYING]);
	expect(ids(s.pdfStore.strokes(busy.id)), "the old record was cleared").toEqual(["s"]);
	expect(ids(s.pdfStore.strokes(moved)), "the new id's ink was deleted").toEqual(["s"]);
	expect({ old: v.adapter.files.get(oldFile), now: v.adapter.files.get(newFile) }, "an ink file was written").toEqual(before);
	expect(trashFiles(v), "a trash copy was made").toEqual([]);
});

it("pin: the PDF written again with the same bytes while the dialog was open (the id unchanged): the confirm deletes as before", async () => {
	const v = vault();
	const s = session(v);
	const pane = await s.open();
	s.pdfStore.commit(pane.id, stroke("s"));
	await s.store.flush();
	const confirm = s.openDialog();
	await s.plugin.onPdfModified(PATH);
	await s.store.flush();
	expect(s.plugin.pdfIds.get(pane.root), "precondition: the id is unchanged").toBe(pane.id);
	shown.length = 0;
	await confirm();
	await s.store.flush();
	expect(ids(s.pdfStore.strokes(pane.id)), "the ink was not deleted").toEqual([]);
	expect(inkFile(v, s.store.path(pane.id)), "the ink file was not cleared").toEqual([]);
	expect(trashFiles(v), "no trash copy").toHaveLength(1);
	expect(shown, "the delete's words").toHaveLength(1);
	expect(shown[0], "the delete's words").toMatch(/^Handwriting: removed 1 stroke\. A copy is kept in .+\.$/);
});
