/**
 * Flatten and Delete all on a PDF whose ink is not ready refuse, and write nothing.
 *
 * The pane has the PDF's id before its ink file is read. Until a sound read lands, the store's list for that id is only
 * what was drawn this session: empty while the read is in flight, and under a damaged file's lock only the strokes
 * drawn since. Flatten counted that list and painted it, so it said "no ink" on a PDF that has ink, or wrote a copy
 * holding one stroke and said "exported". Delete all counted the same list, so it said "no ink" or asked to delete a
 * count that is not the PDF's ink. Each now says the ink is not ready, in the words already shipped for it, and
 * neither starts its write or opens its dialog. Ready again after a sound read, each goes ahead as before.
 *
 * Real code: the two commands as registerExportSelectionCommands registers them, on a plugin built without its
 * constructor, over a real PdfInkStore whose host answers each read as a damaged file, a newer version's file or a
 * sound one. The flatten and the delete themselves are recorded, not run: what they would write is theirs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";

const seen = vi.hoisted(() => ({ notices: [] as string[], dialogs: [] as { count: number; kind: string }[] }));

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: string) {
				seen.notices.push(message);
			}
		},
	};
});
vi.mock("../ink/DeleteAllInk", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		ConfirmDeleteInkModal: class {
			constructor(_app: unknown, count: number, kind: string) {
				seen.dialogs.push({ count, kind });
			}
			open(): void {}
		},
	};
});

import deleteAllSource from "../ink/DeleteAllInk.ts?raw";
import penPathSource from "../pdf/PdfInkPenPath.ts?raw";
import { HandwritingPlugin } from "../main";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { emptyPage, type PageData, type ParseResult } from "../model/PageData";
import { PdfInkStore } from "../pdf/PdfInkStore";

const ID = "pdf-a";
const FILE = { path: "papers/a.pdf", extension: "pdf", basename: "a", name: "a.pdf" } as unknown as TFile;

/** The shipped words: the pen's refusal on a PDF whose ink is not ready, and Delete all's own. */
const FLATTEN_NOT_READY = "Handwriting: this PDF's ink is not ready - try again in a moment";
const DELETE_NOT_READY = "Handwriting: this PDF's ink storage is not ready. nothing was deleted.";
const FLATTEN_NO_INK = "Handwriting: no ink on this PDF to flatten";
const DELETE_NO_INK = "Handwriting: no ink on this PDF";
const IDENTIFYING = "Handwriting: still identifying this PDF - try again in a moment";

type Answer = "damaged" | "future" | "sound";

function stroke(id: string, page = 1): InkStroke {
	const points = [
		{ x: 100, y: 100, pressure: 0.5, t: 0 },
		{ x: 110, y: 110, pressure: 0.5, t: 8 },
	];
	return { id, tool: "pen", color: "#000000", width: 2, points, bbox: computeBBox(points, 2), createdAt: 0, page };
}

/** Let queued promise callbacks run: twenty microtask turns, no timer. */
const drain = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

const releases: (() => void)[] = [];

/** A store over one ink file holding `fileStrokes`. Each read takes the next answer (sound once they run out). */
function storeOver(fileStrokes: InkStroke[], ...answers: Answer[]) {
	const disk: PageData = { ...emptyPage(ID), surface: "pdf", strokes: fileStrokes };
	const saved: PageData[] = [];
	let gate: Promise<void> | null = null;
	const store = new PdfInkStore();
	store.attachHost({
		load: async (id): Promise<ParseResult> => {
			const answer = answers.shift() ?? "sound";
			if (gate) await gate;
			const data: PageData = { ...disk, pageId: id, strokes: [...disk.strokes] };
			if (answer === "damaged") {
				return { data: { ...emptyPage(id), surface: "pdf" }, recovered: false, damaged: true, problem: "mid-write" };
			}
			if (answer === "future") return { data, recovered: false, futureVersion: 99 };
			return { data, recovered: false };
		},
		schedule: (_id, page) => void saved.push(page),
		notice: () => {},
	});
	return {
		store,
		saved,
		/** The next read waits until the cell ends. */
		hold(): void {
			gate = new Promise<void>((resolve) => releases.push(resolve));
		},
	};
}

type Command = { id: string; checkCallback: (checking: boolean) => boolean };

/** The two commands on a bare plugin, the PDF active, its id known (or not), the flatten and the delete recorded. */
function commandsOn(store: PdfInkStore, id: string | null = ID) {
	const commands = new Map<string, Command>();
	const flattened: string[][] = [];
	const deleted: string[] = [];
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown> & {
		registerExportSelectionCommands(): void;
	};
	plugin.addCommand = (command: Command) => {
		commands.set(command.id, command);
		return command;
	};
	plugin.app = { workspace: { getActiveFile: () => FILE } };
	plugin.pdfStore = store;
	plugin.store = { trashFolderFor: () => ".handwriting/trash" };
	plugin.pdfIdForPath = (path: string) => (path === FILE.path ? id : null);
	plugin.flattenPdf = async (_file: TFile, of: string) => void flattened.push(store.strokes(of).map((s) => s.id));
	plugin.deleteAllPdfInk = async (of: string) => void deleted.push(of);
	plugin.registerExportSelectionCommands();
	const run = (name: string): void => {
		expect(commands.get(name)!.checkCallback(true), "premise: listed on every PDF").toBe(true);
		expect(commands.get(name)!.checkCallback(false)).toBe(true);
	};
	return {
		flatten: () => run("flatten-pdf-ink"),
		deleteAll: () => run("delete-all-pdf-ink"),
		flattened,
		deleted,
	};
}

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await drain();
	seen.notices.length = 0;
	seen.dialogs.length = 0;
});

/** The PDF's states in which its ink is not ready, each with what the store's list holds then. */
const notReady: { name: string; make: () => Promise<PdfInkStore>; listed: string[] }[] = [
	{
		name: "its ink file still being read",
		listed: [],
		make: async () => {
			const r = storeOver([stroke("in-file")]);
			r.hold();
			void r.store.ensureLoaded(ID);
			await drain();
			return r.store;
		},
	},
	{
		name: "its ink file still being read, one stroke drawn meanwhile",
		listed: ["drawn"],
		make: async () => {
			const r = storeOver([stroke("in-file")]);
			r.hold();
			void r.store.ensureLoaded(ID);
			await drain();
			r.store.commit(ID, stroke("drawn"));
			return r.store;
		},
	},
	{
		name: "its ink file damaged, one stroke drawn since",
		listed: ["drawn"],
		make: async () => {
			const r = storeOver([stroke("in-file")], "damaged");
			await r.store.ensureLoaded(ID);
			r.store.commit(ID, stroke("drawn"));
			return r.store;
		},
	},
	{
		name: "its ink file written by a newer version",
		listed: ["in-file"],
		make: async () => {
			const r = storeOver([stroke("in-file")], "future");
			await r.store.ensureLoaded(ID);
			return r.store;
		},
	},
];

describe("Flatten on a PDF whose ink is not ready: says so, writes no copy", () => {
	for (const state of notReady) {
		it(`${state.name}: the not-ready notice, no copy written`, async () => {
			const store = await state.make();
			expect(store.strokes(ID).map((s) => s.id), "premise: what the store's list holds then").toEqual(state.listed);
			const c = commandsOn(store);
			c.flatten();
			expect(seen.notices.at(-1), "the notice").toBe(FLATTEN_NOT_READY);
			expect(c.flattened, "a flattened copy was started").toEqual([]);
			expect(store.strokes(ID).map((s) => s.id)).toEqual(state.listed);
		});
	}
});

describe("Delete all on a PDF whose ink is not ready: says so, opens no dialog, deletes nothing", () => {
	for (const state of notReady) {
		it(`${state.name}: the not-ready notice, no dialog, nothing deleted`, async () => {
			const store = await state.make();
			expect(store.strokes(ID).map((s) => s.id), "premise: what the store's list holds then").toEqual(state.listed);
			const c = commandsOn(store);
			c.deleteAll();
			expect(seen.notices.at(-1), "the notice").toBe(DELETE_NOT_READY);
			expect(seen.dialogs, "the delete dialog opened").toEqual([]);
			expect(c.deleted, "a delete was started").toEqual([]);
			expect(store.strokes(ID).map((s) => s.id)).toEqual(state.listed);
		});
	}
});

describe("a PDF whose ink is ready, or not yet identified: as before", () => {
	it("control: ink read soundly: Flatten starts the copy of all of it, no notice", async () => {
		const r = storeOver([stroke("in-file"), stroke("also-in-file")]);
		await r.store.ensureLoaded(ID);
		const c = commandsOn(r.store);
		c.flatten();
		expect(c.flattened).toEqual([["in-file", "also-in-file"]]);
		expect(seen.notices).toEqual([]);
	});

	it("control: ink read soundly: Delete all opens its dialog with the PDF's count", async () => {
		const r = storeOver([stroke("in-file"), stroke("also-in-file")]);
		await r.store.ensureLoaded(ID);
		const c = commandsOn(r.store);
		c.deleteAll();
		expect(seen.dialogs).toEqual([{ count: 2, kind: "PDF" }]);
		expect(seen.notices).toEqual([]);
	});

	it("control: a sound read of no ink: each says there is no ink, and starts nothing", async () => {
		const r = storeOver([]);
		await r.store.ensureLoaded(ID);
		const c = commandsOn(r.store);
		c.flatten();
		expect(seen.notices.at(-1)).toBe(FLATTEN_NO_INK);
		c.deleteAll();
		expect(seen.notices.at(-1)).toBe(DELETE_NO_INK);
		expect(c.flattened).toEqual([]);
		expect(seen.dialogs).toEqual([]);
	});

	it("control: no id yet: each says the PDF is still being identified, and starts nothing", async () => {
		const r = storeOver([stroke("in-file")]);
		await r.store.ensureLoaded(ID);
		const c = commandsOn(r.store, null);
		c.flatten();
		expect(seen.notices.at(-1)).toBe(IDENTIFYING);
		c.deleteAll();
		expect(seen.notices.at(-1)).toBe(IDENTIFYING);
		expect(c.flattened).toEqual([]);
		expect(seen.dialogs).toEqual([]);
	});

	it("control: a damaged read, then a sound one: Flatten goes ahead with the file's ink and the stroke drawn between", async () => {
		const r = storeOver([stroke("in-file")], "damaged", "sound");
		await r.store.ensureLoaded(ID);
		r.store.commit(ID, stroke("drawn"));
		await r.store.ensureLoaded(ID);
		expect(r.store.inkReady(ID), "premise: the sound read lifted the lock").toBe(true);
		const c = commandsOn(r.store);
		c.flatten();
		expect(c.flattened).toEqual([["in-file", "drawn"]]);
		expect(seen.notices).toEqual([]);
	});

	it("control: the cells' not-ready words are the shipped lines", () => {
		const crlf = (s: string): string => s.replace(/\r\n/g, "\n");
		expect(crlf(penPathSource)).toContain(`this.notify(${JSON.stringify(FLATTEN_NOT_READY)});`);
		expect(crlf(deleteAllSource)).toContain(`const PDF_INK_NOT_READY = ${JSON.stringify(DELETE_NOT_READY)};`);
	});
});
