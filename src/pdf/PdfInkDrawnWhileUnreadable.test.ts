import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeBBox, InkStroke } from "../ink/Stroke";
import { InkOp } from "../inline/InkHistory";
import { resetTipModeForTest } from "../inline/TipMode";
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import { PageBox } from "./PageMap";

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current, viewerCanvasOf: () => null }));
import { PdfInkController } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";
import { PdfInkStore } from "./PdfInkStore";

/**
 * Ink drawn on a PDF while its ink file cannot be read (a sync client mid-write) is shown but not written: the file
 * is not ours to overwrite while we cannot read it. Once a later read is sound, that ink has to be saved, merged with
 * the file's own strokes, or closing the PDF loses it. Every door that changes ink while the file is unreadable is
 * the same case: the pen, and also paste, delete, a dragged selection and undo.
 */

const ID = "pdf-a";

type Answer = "damaged" | "future" | "sound";

function stroke(id: string, page = 1): InkStroke {
	const points = [
		{ x: 100, y: 100, pressure: 0.5, t: 0 },
		{ x: 110, y: 110, pressure: 0.5, t: 8 },
	];
	return { id, tool: "pen", color: "#000000", width: 2, points, bbox: computeBBox(points, 2), createdAt: 0, page };
}

const ids = (page: PageData): string[] => page.strokes.map((s) => s.id);

/** Let queued promise callbacks run: twenty microtask turns, no timer. */
const drain = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A store over one ink file. Each read takes the next answer (sound once they run out); a save is what the file holds next. */
function rig(fileStrokes: InkStroke[], ...answers: Answer[]) {
	let disk: PageData = { ...emptyPage(ID), surface: "pdf", strokes: fileStrokes };
	const saved: PageData[] = [];
	const notices: string[] = [];
	let gate: Promise<void> | null = null;
	let release = (): void => {};
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
		schedule: (_id, page) => {
			saved.push(page);
			disk = page;
		},
		notice: (m) => void notices.push(m),
	});
	return {
		store,
		saved,
		notices,
		/** The next read waits until release(). */
		hold(): void {
			gate = new Promise<void>((resolve) => {
				release = (): void => {
					gate = null;
					resolve();
				};
			});
		},
		release: (): void => release(),
		onScreen: (): string[] => store.strokes(ID).map((s) => s.id),
	};
}

/** A pane on the PDF, its op sink the committed path the plugin wires: applyOp over the document, then replaceAll. */
function pane(store: PdfInkStore) {
	const boxes: PageBox[] = [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800 }];
	const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add() {}, remove() {} }, querySelector: () => null };
	probe.current = { scroller, scaleFactor: 1, scaleSource: "test", pages: boxes.map((b) => ({ ...b, hasCanvas: true })) };
	const win = {
		devicePixelRatio: 1, clearTimeout() {}, setTimeout: () => 0,
		requestAnimationFrame: () => 0, cancelAnimationFrame() {},
	};
	const controller = new PdfInkController({} as HTMLElement, win as unknown as Window,
		(page) => store.strokesOnPage(ID, page), () => ID, () => store.strokes(ID),
		(op) => {
			if (op.path) store.replaceAll(op.path, applyOp(store.strokes(op.path), op));
		});
	const pen = controller as unknown as { emit(op: InkOp): boolean; historyStep(redo: boolean): boolean };
	return {
		draw: (s: InkStroke): boolean => pen.emit({ type: "add", path: ID, strokes: [s] }),
		undo: (): boolean => pen.historyStep(false),
	};
}

beforeEach(() => resetTipModeForTest());

describe("ink drawn on a PDF while its ink file could not be read", () => {
	it("is saved once the poll reads the file again, under the file's own strokes", async () => {
		const r = rig([stroke("old")], "damaged");
		await r.store.ensureLoaded(ID);
		expect(r.store.inkReady(ID), "precondition: the first read locked the PDF").toBe(false);
		r.store.commit(ID, stroke("during", 2));
		expect(r.saved.length, "precondition: nothing is written while the file cannot be read").toBe(0);

		await r.store.reloadExternal(ID);
		await drain();

		expect(r.store.inkReady(ID), "precondition: the sound read lifted the lock").toBe(true);
		expect(r.saved.length, "the stroke drawn while locked was not saved after the poll read the file again").toBe(1);
		expect(ids(r.saved[0]!), "the save lost the file's stroke or the one drawn while locked").toEqual(["old", "during"]);
		expect(r.notices.length, "the sound read said something new").toBe(1);
	});

	it("is saved once the PDF is opened again and the file reads, under the file's own strokes", async () => {
		const r = rig([stroke("old")], "damaged");
		await r.store.ensureLoaded(ID);
		expect(r.store.inkReady(ID), "precondition: the first read locked the PDF").toBe(false);
		r.store.commit(ID, stroke("during", 2));
		expect(r.saved.length, "precondition: nothing is written while the file cannot be read").toBe(0);

		await r.store.ensureLoaded(ID);
		await drain();

		expect(r.store.inkReady(ID), "precondition: the sound read lifted the lock").toBe(true);
		expect(r.saved.length, "the stroke drawn while locked was not saved after the open read the file again").toBe(1);
		expect(ids(r.saved[0]!), "the save lost the file's stroke or the one drawn while locked").toEqual(["old", "during"]);
	});

	it("is still there after the PDF is closed and opened again", async () => {
		const r = rig([stroke("old")], "damaged");
		await r.store.ensureLoaded(ID);
		r.store.commit(ID, stroke("during", 2));
		await r.store.reloadExternal(ID);
		await drain();
		expect(r.store.inkReady(ID), "precondition: the sound read lifted the lock").toBe(true);

		const generation = r.store.generation(ID);
		expect(generation, "precondition: the PDF is held").not.toBeNull();
		expect(r.store.forgetIfUnchanged(ID, generation!), "the closed PDF was kept in memory").toBe(true);
		await r.store.ensureLoaded(ID);

		expect(r.onScreen(), "the stroke drawn while locked was gone when the PDF was opened again").toEqual(["old", "during"]);
	});

	it("with nothing drawn while locked, the sound read writes nothing, and opening a PDF writes nothing", async () => {
		const r = rig([stroke("old")], "damaged");
		await r.store.ensureLoaded(ID);
		expect(r.store.inkReady(ID), "precondition: the first read locked the PDF").toBe(false);
		await r.store.reloadExternal(ID);
		await drain();
		expect(r.store.inkReady(ID), "precondition: the sound read lifted the lock").toBe(true);
		expect(r.saved.length, "a sound read with nothing drawn wrote the file").toBe(0);

		const opened = rig([stroke("old")]);
		await opened.store.ensureLoaded(ID);
		await drain();
		expect(opened.onScreen(), "precondition: the file's stroke is shown").toEqual(["old"]);
		expect(opened.saved.length, "opening a PDF wrote its ink file").toBe(0);
	});

	it("stays unsaved, on screen and locked when the file reads damaged again", async () => {
		const r = rig([stroke("old")], "damaged", "damaged");
		await r.store.ensureLoaded(ID);
		r.store.commit(ID, stroke("during", 2));

		await r.store.reloadExternal(ID);
		await drain();

		expect(r.store.inkReady(ID), "the PDF was unlocked by a damaged read").toBe(false);
		expect(r.saved.length, "a damaged read led to a write").toBe(0);
		expect(r.onScreen(), "the stroke drawn while locked left the screen").toEqual(["during"]);
	});

	it("is saved at the first sound read after a second damaged one", async () => {
		const r = rig([stroke("old")], "damaged", "damaged");
		await r.store.ensureLoaded(ID);
		r.store.commit(ID, stroke("during", 2));
		await r.store.reloadExternal(ID);
		await drain();
		expect(r.store.inkReady(ID), "precondition: the second read kept the lock").toBe(false);
		expect(r.saved.length, "precondition: nothing written yet").toBe(0);

		await r.store.reloadExternal(ID);
		await drain();

		expect(r.saved.length, "the stroke drawn while locked was not saved at the later sound read").toBe(1);
		expect(ids(r.saved[0]!), "the save lost the file's stroke or the one drawn while locked").toEqual(["old", "during"]);
	});

	it("is not written when the file then answers a newer format, and stays on screen", async () => {
		const r = rig([stroke("old")], "damaged", "future");
		await r.store.ensureLoaded(ID);
		r.store.commit(ID, stroke("during", 2));

		await r.store.ensureLoaded(ID);
		await drain();

		expect(r.store.inkReady(ID), "precondition: the newer format keeps the PDF locked").toBe(false);
		expect(r.saved.length, "a file in a newer format was written").toBe(0);
		expect(r.onScreen(), "the ink left the screen").toEqual(["old", "during"]);
	});

	it("a stroke drawn while the first read is still in flight is saved once after the merge", async () => {
		const r = rig([stroke("old")]);
		r.hold();
		const loading = r.store.ensureLoaded(ID);
		r.store.commit(ID, stroke("during", 2));
		expect(r.saved.length, "a save went out while the file was still being read").toBe(0);

		r.release();
		await loading;
		await drain();

		expect(r.saved.length, "the stroke drawn during the first read was not saved once").toBe(1);
		expect(ids(r.saved[0]!), "the save lost the file's stroke or the new one").toEqual(["old", "during"]);
	});

	it("a stroke drawn while the file is being read again, still locked, is saved after that read", async () => {
		const r = rig([stroke("old")], "damaged");
		await r.store.ensureLoaded(ID);
		r.store.commit(ID, stroke("before", 2));
		r.hold();
		const healing = r.store.ensureLoaded(ID);
		r.store.commit(ID, stroke("while-read", 2));
		expect(r.store.inkReady(ID), "precondition: still locked while the file is read again").toBe(false);
		expect(r.saved.length, "a save went out while the file was being read").toBe(0);

		r.release();
		await healing;
		await drain();

		expect(r.saved.length, "the strokes drawn while locked were not saved after the read").toBe(1);
		expect(ids(r.saved[0]!), "the save lost a stroke").toEqual(["old", "before", "while-read"]);
	});

	it("an undo pressed while locked is saved at the sound read, without the stroke it took back", async () => {
		const r = rig([stroke("old")], "damaged");
		await r.store.ensureLoaded(ID);
		expect(r.store.inkReady(ID), "precondition: the first read locked the PDF").toBe(false);
		const p = pane(r.store);
		expect(p.draw(stroke("kept")), "precondition: the first stroke went through the op door").toBe(true);
		expect(p.draw(stroke("undone")), "precondition: the second stroke went through the op door").toBe(true);
		expect(p.undo(), "precondition: the undo ran").toBe(true);
		expect(r.onScreen(), "precondition: the undo took the second stroke back").toEqual(["kept"]);
		expect(r.saved.length, "precondition: nothing is written while the file cannot be read").toBe(0);

		await r.store.reloadExternal(ID);
		await drain();

		expect(r.saved.length, "the ink changed by the undo while locked was not saved at the sound read").toBe(1);
		expect(ids(r.saved[0]!), "the save brought back the undone stroke or lost one").toEqual(["old", "kept"]);
	});
});

const UNREADABLE = "Handwriting: this PDF's ink file could not be read yet. New ink on it is not saved until it loads.";
const NEWER = "Handwriting: this PDF's ink was written by a newer version of Handwriting. ink drawn on it is not saved.";

/**
 * Each lock says its own notice, once. The unreadable notice says new ink is not saved "until it loads"; when the file
 * then loads as a newer version's, that ink is still not saved, for a new reason, and the user is told so.
 */
describe("the lock notices on a PDF, one per kind of lock", () => {
	it("S1 a damaged read, then a newer version's file: both notices, each once", async () => {
		const r = rig([stroke("old")], "damaged", "future");
		await r.store.ensureLoaded(ID);
		r.store.commit(ID, stroke("during", 2));

		await r.store.ensureLoaded(ID);
		await drain();

		expect(r.store.inkReady(ID), "precondition: the newer format keeps the PDF locked").toBe(false);
		expect(r.notices, "the newer-version notice was dropped after the unreadable one").toEqual([UNREADABLE, NEWER]);
	});

	it("S2 control: a newer version's file from the first read: its notice, once", async () => {
		const r = rig([stroke("old")], "future");
		await r.store.ensureLoaded(ID);
		r.store.commit(ID, stroke("during", 2));

		await r.store.reloadExternal(ID);
		await drain();

		expect(r.notices, "the newer-version notice is said once").toEqual([NEWER]);
	});

	it("S3 control: two damaged reads: the unreadable notice, once", async () => {
		const r = rig([stroke("old")], "damaged", "damaged");
		await r.store.ensureLoaded(ID);
		r.store.commit(ID, stroke("during", 2));

		await r.store.reloadExternal(ID);
		await drain();

		expect(r.store.inkReady(ID), "precondition: the second read kept the lock").toBe(false);
		expect(r.notices, "a second damaged read said the unreadable notice again").toEqual([UNREADABLE]);
	});
});
