import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeBBox, InkStroke } from "../ink/Stroke";
import { InkOp } from "../inline/InkHistory";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { PenSample } from "../input/PointerRouter";
import type { ExternalAdoptionResult } from "../inline/InlineInkStore";
import { PageData, ParseResult, emptyPage } from "../model/PageData";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({
	probeViewer: () => probe.current,
	viewerCanvasOf: () => null,
	wholePageCanvasOf: () => null,
}));
import { PdfInkController } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";
import { PdfInkStore } from "./PdfInkStore";

/**
 * A PDF opened while its ink file was mid-sync is locked; ink drawn then is saved once the file reads again (the
 * heal). That save is this session's ink on its way to the file, so the file is not another device's fork of it.
 * An adoption prepared while the save is on its way finds the record holding a stroke the file lacks and writes a
 * recovery pair, which "fix ink de-sync" then lists, on every synced device, as a fork needing a decision. These
 * cells hold the store to: no adoption prepared while a save of the page is asked for and not yet written, whether
 * that save is parked behind the heal's read or already queued.
 */

const ID = "pdf-a";

type Answer = "damaged" | "sound";

function stroke(id: string, page = 1): InkStroke {
	const points = [100, 105, 110].map((v, i) => ({ x: v, y: v, pressure: 0.5, t: i * 8 }));
	return { id, tool: "pen", color: "#000000", width: 2, points, bbox: computeBBox(points, 4), createdAt: 0, page };
}

const ids = (page: PageData): string[] => page.strokes.map((s) => s.id);

/** Let queued promise callbacks run: twenty microtask turns, no timer. */
const drain = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

/**
 * A store over one ink file. Each read takes the next answer (sound once they run out). A save is queued, not
 * written: `queued` stays true, as the page store's 700 ms wait would leave it. `prepare` counts the adoption
 * preparations and answers with the file as it stands, with a pair only when the record holds a stroke the file lacks.
 */
function rig(fileStrokes: InkStroke[], ...answers: Answer[]) {
	let disk: PageData = { ...emptyPage(ID), surface: "pdf", strokes: fileStrokes };
	const saved: PageData[] = [];
	const notices: string[] = [];
	let queued = false;
	let prepared = 0;
	let heldRead: { promise: Promise<ParseResult>; answer: Answer | null } | null = null;
	const read = (id: string, answer: Answer): ParseResult => answer === "damaged"
		? { data: { ...emptyPage(id), surface: "pdf" }, recovered: false, damaged: true, problem: "mid-write" }
		: { data: { ...disk, pageId: id, strokes: [...disk.strokes] }, recovered: false };
	const store = new PdfInkStore();
	store.attachHost({
		load: (id) => {
			const answer = answers.shift() ?? "sound";
			if (heldRead) {
				// The very promise the store awaits, so a callback chained on it later runs after the store's read.
				heldRead.answer = answer;
				return heldRead.promise;
			}
			return Promise.resolve(read(id, answer));
		},
		schedule: (_id, page) => {
			queued = true;
			saved.push(page);
		},
		notice: (m) => void notices.push(m),
		prepareExternalAdoption: async (id, outgoing) => {
			prepared++;
			const fileIds = new Set(disk.strokes.map((s) => s.id));
			const diverges = outgoing.strokes.some((s) => !fileIds.has(s.id));
			return {
				kind: "prepared",
				prepared: {
					pageId: id,
					data: { ...disk, pageId: id, strokes: [...disk.strokes] },
					outgoingPath: diverges ? `.handwriting/${id}.conflict-external-t-outgoing.json` : undefined,
					incomingPath: diverges ? `.handwriting/${id}.conflict-external-t-incoming.json` : undefined,
					reused: false,
					mtime: 1,
					stamp: "s",
				},
			};
		},
		acceptExternalAdoption: () => {},
	});
	return {
		store,
		saved,
		notices,
		queued: (): boolean => queued,
		prepared: (): number => prepared,
		/** Another device's revision lands in the file. */
		external(strokes: InkStroke[]): void {
			disk = { ...disk, strokes };
		},
		/**
		 * The next read waits on a promise the cell settles. `settled` is the read's own promise: a callback chained on
		 * it after the store awaited it runs once the store's read has finished, before anything the store parked on
		 * that read.
		 */
		holdNextRead(): { settled: Promise<ParseResult>; answer(): void } {
			let resolve!: (result: ParseResult) => void;
			const promise = new Promise<ParseResult>((r) => {
				resolve = r;
			});
			const held = { promise, answer: null as Answer | null };
			heldRead = held;
			return {
				settled: promise,
				answer: () => {
					heldRead = null;
					resolve(read(ID, held.answer ?? "sound"));
				},
			};
		},
		onScreen: (): string[] => store.strokes(ID).map((s) => s.id),
	};
}

beforeEach(() => resetTipModeForTest());

describe("a locked PDF read again: no adoption is prepared while its save is on the way", () => {
	it("C1: the file still has no stroke, a stroke drawn under the lock is queued to save: the adoption prepares nothing", async () => {
		const r = rig([], "damaged");
		await r.store.ensureLoaded(ID);
		expect(r.store.inkReady(ID), "precondition: the first read locked the PDF").toBe(false);
		r.store.commit(ID, stroke("during"));
		expect(r.saved.length, "precondition: nothing is saved while locked").toBe(0);

		expect(await r.store.reloadExternal(ID), "precondition: the heal answers no change (the file added no stroke)").toBe(false);
		expect(r.store.inkReady(ID), "precondition: the sound read lifted the lock").toBe(true);
		expect(r.queued(), "precondition: the stroke drawn under the lock is queued to save").toBe(true);

		const adoption = await r.store.adoptExternal(ID, () => !r.queued());

		expect(r.prepared(), "an adoption was prepared over a page whose save is queued: it writes a recovery pair").toBe(0);
		expect(adoption.outcome, "the adoption went ahead while a save of the page was queued").toBe("held");
		expect(r.onScreen(), "the stroke drawn under the lock left the record").toEqual(["during"]);
		expect(r.saved.map(ids), "the save of the stroke drawn under the lock changed").toEqual([["during"]]);
	});

	it("C1b: the file adds a stroke at the heal, the merged page is queued to save: the adoption prepares nothing", async () => {
		const r = rig([], "damaged");
		await r.store.ensureLoaded(ID);
		r.store.commit(ID, stroke("during"));
		r.external([stroke("remote")]);

		expect(await r.store.reloadExternal(ID), "precondition: the heal answers changed (the file added a stroke)").toBe(true);
		expect(r.queued(), "precondition: the merged page is queued to save").toBe(true);

		const adoption = await r.store.adoptExternal(ID, () => !r.queued());

		expect(r.prepared(), "an adoption was prepared over a page whose save is queued").toBe(0);
		expect(adoption.outcome).toBe("held");
		expect(r.onScreen(), "the merged page changed").toEqual(["remote", "during"]);
	});

	it("C2: asked in the moment the heal's read has settled and its save is parked, not yet queued: the adoption prepares nothing", async () => {
		const r = rig([], "damaged");
		await r.store.ensureLoaded(ID);
		r.store.commit(ID, stroke("during"));

		const read = r.holdNextRead();
		const healing = r.store.reloadExternal(ID);
		let seen: { ready: boolean; parked: boolean; queued: boolean } | null = null;
		let inWindow: Promise<ExternalAdoptionResult> | null = null;
		void read.settled.then(() => {
			seen = { ready: r.store.inkReady(ID), parked: r.store.parkedInk(), queued: r.queued() };
			inWindow = r.store.adoptExternal(ID, () => !r.queued());
		});
		read.answer();
		expect(await healing, "precondition: the heal answers no change").toBe(false);
		const adoption = await inWindow!;
		await drain();

		expect(seen, "precondition: asked after the read settled, with the save parked and not yet queued").toEqual({
			ready: true,
			parked: true,
			queued: false,
		});
		expect(r.prepared(), "an adoption was prepared while the page's save was parked behind the read").toBe(0);
		expect(adoption!.outcome).toBe("held");
		expect(r.saved.map(ids), "the parked save did not land once, with the stroke drawn under the lock").toEqual([["during"]]);
	});
});

describe("pins: what the heal and the adoption already do", () => {
	it("PIN: a real fork on an unlocked PDF with no save queued still prepares its pair and is adopted", async () => {
		const r = rig([stroke("a"), stroke("b")]);
		await r.store.ensureLoaded(ID);
		expect(r.store.inkReady(ID), "precondition: a sound open").toBe(true);
		r.external([stroke("a")]);

		const adoption = await r.store.adoptExternal(ID, () => !r.queued());

		expect(r.prepared(), "the real fork was not prepared").toBe(1);
		expect(adoption.outcome, "the real fork was not adopted").toBe("adopted");
		expect(adoption.outcome === "adopted" && adoption.outgoingPath, "the real fork wrote no pair").toBeTruthy();
		expect(r.onScreen(), "the record is not the file's revision").toEqual(["a"]);
		expect(r.saved.length, "an adoption saved").toBe(0);
	});

	it("PIN: a heal whose read is still unsound keeps the lock, prepares nothing and writes nothing", async () => {
		const r = rig([], "damaged", "damaged");
		await r.store.ensureLoaded(ID);
		r.store.commit(ID, stroke("during"));

		expect(await r.store.reloadExternal(ID)).toBe(false);
		const adoption = await r.store.adoptExternal(ID, () => !r.queued());
		await drain();

		expect(r.store.inkReady(ID), "a damaged read lifted the lock").toBe(false);
		expect(adoption).toMatchObject({ outcome: "held", reason: "existing-lock" });
		expect(r.prepared(), "a locked PDF prepared an adoption").toBe(0);
		expect(r.saved.length, "a damaged read led to a save").toBe(0);
		expect(r.onScreen(), "the stroke drawn under the lock left the screen").toEqual(["during"]);
	});

	it("PIN: after a heal that answers no change, the eraser works on the next stroke without a reopen", async () => {
		const r = rig([], "damaged");
		await r.store.ensureLoaded(ID);
		const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add: () => {}, remove: () => {} }, querySelector: () => null };
		probe.current = {
			scroller, scaleFactor: 2, scaleSource: "test",
			pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
		};
		const win = { devicePixelRatio: 1, clearTimeout: () => {}, setTimeout: () => 0, cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0 };
		const controller = new (PdfInkController as unknown as new (...args: unknown[]) => PdfInkController)(
			{} as HTMLElement, win as unknown as Window,
			(page: number) => r.store.strokesOnPage(ID, page), () => ID, () => r.store.strokes(ID),
			(op: InkOp, mode?: string) => {
				if (mode === "live-page") r.store.applyLivePage(ID, op);
				else r.store.replaceAll(ID, applyOp(r.store.strokes(ID), op));
			},
			() => {}, (message: string) => r.notices.push(message), (id: string) => r.store.save(id),
			() => false, () => "darken", () => r.store.inkReady(ID)
		);
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
		const pen = controller as unknown as { penDown(s: PenSample): void; penUp(): void };
		const at = (x: number, y: number): PenSample => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
		r.store.commit(ID, stroke("during"));
		setTipMode("eraser");
		pen.penDown(at(200, 200));
		pen.penUp();
		expect(r.onScreen(), "precondition: the eraser is refused while locked").toEqual(["during"]);

		expect(await r.store.reloadExternal(ID), "precondition: the heal answers no change").toBe(false);
		await drain();
		pen.penDown(at(200, 200));
		pen.penUp();

		expect(r.onScreen(), "the eraser did not work after the heal without a reopen").toEqual([]);
	});
});
