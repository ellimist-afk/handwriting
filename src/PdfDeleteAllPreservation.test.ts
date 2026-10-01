/**
 * "Delete all ink" on a PDF must never destroy ink its backup does not hold.
 *
 * TWO CONFIRMED P1 FAILURE MODES, both reproduced on the published 1.4.12
 * (c6d0003) and on the frozen candidate (71780d2), and both closed here.
 *
 * 1. CHANGED DURING BACKUP. `deleteAllPdfInk` awaits `store.preserve(id)` and
 *    then reads the document again - count, `replaceAll`, history reset, all
 *    on the far side of the await. A stroke finished inside that gap is in
 *    neither copy: the backup was taken before it existed, and the clear
 *    removes it from the live sidecar. The notice still said a copy was kept.
 *
 * 2. NOT READY AT ALL. A damaged or future-version sidecar leaves the record
 *    locked, and `persist` then drops every scheduled write. Ink drawn in that
 *    session lives only in memory. Delete-all copied the original locked bytes
 *    - which never contained the session ink - cleared the live strokes, and
 *    cleared the undo history behind them. The original file stayed
 *    byte-perfect, so a content comparison alone sees nothing wrong, and the
 *    user had already been told their ink was not being saved. Then they were
 *    told a copy was kept.
 *
 * The two guards are proved SEPARATELY, and each is removed on its own to
 * show it carries a real loss (those removal receipts are in the handback,
 * not here). Content equality cannot cover mode 2 - live content is unchanged
 * across preserve there - and readiness cannot cover mode 1, so neither guard
 * is redundant with the other.
 *
 * WHAT IS REAL HERE: the actual imported `HandwritingPlugin.deleteAllPdfInk`,
 * the actual `PageStore` and its real `preserve`/write chain, the actual
 * `PdfInkStore` with a host attached, the actual `PdfInkController` history
 * and its `historyStep` undo/redo, the actual `applyOp`, and real serialized
 * bytes through a `FakeAdapter`. SUBSTITUTED, and labelled where it matters:
 * pane mounting, painting, the stroke builder's finish, and the adapter as
 * host transport. No physical UI execution is claimed anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { history, undo, undoDepth } from "@codemirror/commands";

const signals = vi.hoisted(() => ({ notices: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			signals.notices.push(message);
		}
	},
}));

import HandwritingPlugin from "./main";
import { PageStore } from "./persistence/PageStore";
import { FakeAdapter } from "./persistence/FakeAdapter";
import { PdfInkStore } from "./pdf/PdfInkStore";
import { PdfInkController } from "./pdf/PdfInkController";
import { PdfInkHistory, applyOp } from "./pdf/PdfInkHistory";
import { InkOverlayPlugin, inlineInk } from "./inline/InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport } from "./inline/InkHistory";
import { emptyPage, parsePage, serializePage } from "./model/PageData";
import { computeBBox, type InkStroke } from "./ink/Stroke";

/**
 * The exact strings production owns. Drift here is a user-visible change.
 *
 * Sentence case after the "Handwriting:" prefix, per Alan's 2026-09-08 ruling:
 * a sentence starts lowercase, "Handwriting" keeps its capital wherever it
 * appears, and a command keeps its own name - which is why "Delete all ink"
 * stays capitalised inside CHANGED.
 *
 * DISK_ERROR was originally left in Title case, because it was not one of the
 * four strings that ruling covered. **Alan reopened it later the same day**,
 * on the ground that it is the THIRD refusal of this one command: two of them
 * lowercase and one capitalised, inside a single function, is a visible
 * inconsistency in a way the product-wide spread is not. Its note-surface twin
 * in `deleteAllInk` moved with it, since it is the same sentence.
 *
 * The wider sweep is still NOT reopened - the inline and slides siblings and
 * the rest of the Title-case notices stay as they are.
 */
const NOT_READY = "Handwriting: this PDF's ink storage is not ready. nothing was deleted.";
const CHANGED =
	"Handwriting: the ink changed while its backup was being made. nothing was deleted. run Delete all ink again if you still want to remove it.";
const DISK_ERROR =
	"Handwriting: could not copy this PDF's ink to the trash (disk error). Nothing was deleted.";
const UNREADABLE =
	"Handwriting: this PDF's ink file could not be read. ink drawn on it is not saved.";
const FUTURE =
	"Handwriting: this PDF's ink was written by a newer version of Handwriting. ink drawn on it is not saved.";

const ID = "pdf-delete-preservation";
const SIDECAR = `.handwriting/${ID}.json`;

const cleanup: (() => void)[] = [];
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	signals.notices.length = 0;
});
afterEach(() => {
	for (const fn of cleanup.splice(0)) fn();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * One stroke's complete persisted content, for asking "did this exact ink
 * survive" of a file. Deliberately the SERIALIZED form: it is what a recovery
 * copy can actually give back.
 */
function persisted(s: InkStroke): string {
	const p = emptyPage("fingerprint");
	p.strokes = [s];
	return serializePage(p);
}

/** Three points, so an INTERIOR one can move without touching the bbox. */
function stroke(id: string, x0 = 10): InkStroke {
	const points = [
		{ x: x0, y: 20, pressure: 0.5, t: 0 },
		{ x: x0 + 10, y: 30, pressure: 0.6, t: 4 },
		{ x: x0 + 20, y: 40, pressure: 0.75, t: 8 },
	];
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		createdAt: 7,
		points,
		bbox: computeBBox(points, 4),
		page: 1,
	};
}

interface Stage {
	path: string;
	bytes: string;
	reject: boolean;
	release: () => void;
}

/**
 * Holds each trash write open until the test lets it go, so the window
 * between "backup bytes captured" and "backup complete" is a place the test
 * can stand. Each paused write gets its OWN stage and its own release, which
 * is what the two-simultaneous-deletions case needs.
 */
class BackupGateAdapter extends FakeAdapter {
	paused = false;
	readonly stages: Stage[] = [];
	private waiters: Array<((s: Stage) => void) | undefined> = [];

	/** The nth paused trash write, awaited whether or not it has arrived. */
	stage(n: number): Promise<Stage> {
		const existing = this.stages[n];
		if (existing) return Promise.resolve(existing);
		return new Promise<Stage>((resolve) => {
			this.waiters[n] = resolve;
		});
	}

	override async write(path: string, bytes: string): Promise<void> {
		if (this.paused && path.includes("/trash/")) {
			let release!: () => void;
			const gate = new Promise<void>((r) => {
				release = r;
			});
			const stage: Stage = { path, bytes, reject: false, release };
			const index = this.stages.length;
			this.stages.push(stage);
			this.waiters[index]?.(stage);
			await gate;
			if (stage.reject) throw new Error("EIO synthetic backup write");
		}
		await super.write(path, bytes);
	}
}

describe("audit recovery B1-002", () => {
	it.each([true, false])("backup covers B after an already-consumed write (fail: %s)", async (fail) => {
		vi.useFakeTimers();
		let release = () => {};
		try {
			const r = await rig({ lock: "none", host: true });
			await r.store.flush();
			const a = r.adapter.files.get(SIDECAR)!;
			drawWithPen(r, stroke("audit-B", 70));
			const before = clone(r.live());
			expect(before.map((s) => s.id)).toEqual(["old", "audit-B"]);
			expect(r.depth().done).toBeGreaterThan(0);
			let entered!: () => void;
			const entry = new Promise<void>((resolve) => { entered = resolve; });
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const write = r.adapter.write.bind(r.adapter);
			const events: string[] = [];
			let held = false;
			let requeuedAtBackup: string[] = [];
			r.adapter.write = async (path, bytes) => {
				events.push(`enter ${path}`);
				if (!held && path === `${SIDECAR}.tmp`) {
					held = true;
					expect(parsePage(bytes, ID).data.strokes.map((s) => s.id)).toContain("audit-B");
					entered();
					await gate;
					if (fail) {
						events.push(`fail ${path}`);
						throw new Error("audit B1-002 normal tmp before mutation");
					}
				}
				if (path.includes("/trash/")) {
					requeuedAtBackup = (r.store as any).pending.get(ID)?.strokes.map((s: InkStroke) => s.id) ?? [];
				}
				await write(path, bytes);
				events.push(`complete ${path}`);
			};
			const normal = r.store.flush();
			await entry;
			expect((r.store as any).pending.has(ID)).toBe(false);
			expect(r.store.hasQueuedWrite(ID)).toBe(true);
			expect(r.adapter.files.get(SIDECAR)).toBe(a);
			expect(r.adapter.files.has(`${SIDECAR}.tmp`)).toBe(false);
			// Observe the real private chain call; do not replace its implementation.
			// This is the barrier AFTER preserve's early pending check, not a sleep.
			const chain = vi.spyOn(r.store as any, "chain");
			const deletion = r.deleteAll();
			for (let i = 0; i < 50 && chain.mock.calls.length === 0; i++) await Promise.resolve();
			expect(chain.mock.calls).toHaveLength(1);
			expect(chain.mock.calls[0]![0]).toBe(ID);
			expect((r.store as any).pending.has(ID)).toBe(false);
			events.push("preserve joined page chain");
			release();
			await Promise.all([normal, deletion]);
			const notice = signals.notices.find((n) => n.includes("A copy is kept in "));
			const kept = notice?.match(/A copy is kept in (.+)\.$/)?.[1];
			const backup = kept ? parsePage(r.adapter.files.get(kept)!, ID).data.strokes : [];
			if (fail) {
				expect(events.filter((e) => e.startsWith("fail "))).toEqual([`fail ${SIDECAR}.tmp`]);
				expect(requeuedAtBackup).toContain("audit-B");
			}
			await r.store.flush(); // no original stroke/schedule replay
			const coldStore = new PageStore({ vault: { adapter: r.adapter } } as any);
			const coldPdf = new PdfInkStore();
			coldPdf.attachHost({ load: (id) => coldStore.load(id), schedule: () => {}, notice: () => {} });
			await coldPdf.ensureLoaded(ID);
			const recoveryIds = r.recoverable().map((s) => s.id);
			console.log("AUDIT-B1-002", JSON.stringify({ fail, events, requeuedAtBackup, kept, backupIds: backup.map((s) => s.id), liveIds: r.live().map((s) => s.id), coldIds: coldPdf.strokes(ID).map((s) => s.id), depth: r.depth(), recoveryIds }));
			const protectedB = backup.some((s) => persisted(s) === persisted(before.find((s) => s.id === "audit-B")!));
			const refusedWithB = !notice && r.live().some((s) => s.id === "audit-B") && r.depth().done > 0;
			expect.soft(protectedB || refusedWithB, "backup holds B or wipe refuses with B/history intact").toBe(true);
			expect.soft(recoveryIds, "B recoverable after writes resume without replay").toContain("audit-B");
			if (!fail) {
				expect(backup.map(persisted)).toEqual(before.map(persisted));
				expect(coldPdf.strokes(ID)).toEqual([]);
			}
		} finally {
			release();
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});

type Lock = "none" | "damaged" | "future";

interface Rig {
	drainFrame: () => void;
	adapter: BackupGateAdapter;
	store: PageStore;
	pdf: PdfInkStore;
	plugin: any;
	controller: any;
	errors: unknown[][];
	deleteAll: () => Promise<void>;
	live: () => readonly InkStroke[];
	depth: () => { done: number; undone: number };
	undoOnce: () => boolean;
	redoOnce: () => boolean;
	files: () => [string, string][];
	/** Everything on disk right now, parsed back into strokes. */
	recoverable: () => InkStroke[];
	freshRead: () => Promise<readonly InkStroke[]>;
}

/**
 * `lock` and `host` are required, with no defaults: a fixture option that
 * silently falls back builds the SAFE case while the test name promises the
 * dangerous one, and the test then passes for the wrong reason.
 */
async function rig(options: { lock: Lock; host: boolean }): Promise<Rig> {
	const adapter = new BackupGateAdapter();
	const store = new PageStore({ vault: { adapter } } as any);

	const page = emptyPage(ID);
	page.surface = "pdf";
	page.strokes = [stroke("old")];
	const seed = JSON.parse(serializePage(page));
	if (options.lock === "future") seed.schemaVersion = 999;
	const original =
		options.lock === "damaged" ? '{"schemaVersion":1,"strokes":[' : JSON.stringify(seed);
	adapter.externalWrite(SIDECAR, original);

	const pdf = new PdfInkStore();
	if (options.host) {
		pdf.attachHost({
			load: (pageId) => store.load(pageId),
			schedule: (pageId, data) => store.schedule(pageId, data),
			notice: (message) => signals.notices.push(message),
		});
		await pdf.ensureLoaded(ID);
	}

	const plugin = Object.create(HandwritingPlugin.prototype) as any;
	const frames = new Map<number, () => void>();
	let frameId = 0;
	const drainFrame = () => {
		const pending = [...frames.keys()];
		for (const id of pending) {
			const fn = frames.get(id);
			frames.delete(id);
			fn?.();
		}
	};
	const controller = Object.create(PdfInkController.prototype) as any;
	Object.assign(controller, {
		editFrame: null,
		editPaint: null,
		editTarget: null,
		editDelta: { dx: 0, dy: 0 },
		win: {
			requestAnimationFrame: (fn: () => void) => { frames.set(++frameId, fn); return frameId; },
			cancelAnimationFrame: (id: number) => { frames.delete(id); },
		},
		history: new PdfInkHistory(),
		pageSize: new Map(),
		rotated: new Set(),
		warnedRotated: new Set(),
		router: null,
		resetGestureState() {},
		refresh() {},
		refreshStrip() {},
		clearSelection() {},
		syntheticSources: () => false,
		documentId: () => ID,
		persist: (pageId: string) => pdf.save(pageId),
		// Host op wiring exactly as main binds it: real applyOp -> real store.
		onOp: (op: any, how: string) => {
			const next = applyOp(pdf.strokes(op.path), op);
			if (how === "live") pdf.replaceAllLive(op.path, next);
			else pdf.replaceAll(op.path, next);
		},
		endMetrics() {},
		tools: null,
		frame: null,
		panLast: null,
		spaceLineY: null,
		dragFrom: null,
		lassoPts: [],
		erasing: false,
		builder: null,
		strokePageNumber: 1,
		overlays: new Map(),
		wetOn: () => null,
		frameBox: () => null,
		sync() {},
		undressWet() {},
		drawLasso() {},
		hideLassoCursor() {},
		refreshPage() {},
	});
	const root = {};
	Object.assign(plugin, {
		store,
		pdfStore: pdf,
		pdfInk: new Map([[root, controller]]),
		pdfIds: new Map([[root, ID]]),
	});

	const errors: unknown[][] = [];
	vi.spyOn(console, "error").mockImplementation((...args) => {
		errors.push(args);
	});

	return {
		drainFrame,
		adapter,
		store,
		pdf,
		plugin,
		controller,
		errors,
		deleteAll: () => plugin.deleteAllPdfInk(ID),
		live: () => pdf.strokes(ID),
		depth: () => clone(controller.history.depth),
		undoOnce: () => controller.historyStep(false),
		redoOnce: () => controller.historyStep(true),
		files: () => [...adapter.files.entries()],
		recoverable: () =>
			[...adapter.files.entries()].flatMap(([, bytes]) => parsePage(bytes, ID).data.strokes),
		// A second store reading the same disk: retention on screen is not
		// durability, and only this can tell the two apart.
		freshRead: async () => {
			const reader = new PdfInkStore();
			reader.attachHost({
				load: (pageId) => store.load(pageId),
				schedule: () => {},
				notice: () => {},
			});
			await reader.ensureLoaded(ID);
			return reader.strokes(ID);
		},
	};
}

/**
 * A finished pen stroke through the real `penUp` -> emit -> apply/recordOp
 * path. Only the builder's `finish` is substituted - the submitted stroke and
 * the production persist/lock/history paths below it are real.
 */
function drawWithPen(r: Rig, s: InkStroke): void {
	r.controller.builder = { finish: () => s };
	r.controller.penUp();
	r.controller.builder = null;
}

// ---------------------------------------------------------------------------
// READINESS, proved on its own. Content is never in question in this block.
// ---------------------------------------------------------------------------

describe("readiness: a store that cannot write must not be told it made a backup", () => {
	it.each([
		["damaged", UNREADABLE],
		["future", FUTURE],
	] as const)(
		"%s lock, real completed pen: refuses BEFORE any backup and keeps ink, history and bytes",
		async (lock, lockNotice) => {
			const r = await rig({ lock, host: true });
			const original = r.adapter.files.get(SIDECAR)!;
			drawWithPen(r, stroke("session", 70));

			// The fixture is the dangerous one, asserted rather than assumed.
			expect(r.pdf.canPersist(ID)).toBe(false);
			expect(signals.notices).toContain(lockNotice);
			const before = clone(r.live());
			expect(before.some((s) => s.id === "session")).toBe(true);
			const depthBefore = r.depth();
			const filesBefore = r.files();
			signals.notices.length = 0;

			const preserveSpy = vi.spyOn(r.store, "preserve");
			await r.deleteAll();

			// Refused before the backup: `preserve` was never reached, so no
			// recovery file exists and none was implied.
			expect(preserveSpy).not.toHaveBeenCalled();
			expect(signals.notices).toEqual([NOT_READY]);
			expect(signals.notices.some((n) => n.includes("removed"))).toBe(false);
			expect(signals.notices.some((n) => n.includes("A copy is kept"))).toBe(false);

			expect(clone(r.live())).toEqual(before);
			expect(r.depth()).toEqual(depthBefore);
			expect(r.files()).toEqual(filesBefore);
			expect(r.adapter.files.get(SIDECAR), "locked bytes untouched").toBe(original);
			expect(r.errors).toEqual([]);

			// The session stroke is the one the old code destroyed. It is
			// still here, and undo still reaches it.
			expect(r.undoOnce()).toBe(true);
			expect(r.live().some((s) => s.id === "session")).toBe(false);
			expect(r.redoOnce()).toBe(true);
			expect(clone(r.live())).toEqual(before);
		}
	);

	it("session-memory mode (no host attached) refuses conservatively", async () => {
		const r = await rig({ lock: "none", host: false });
		drawWithPen(r, stroke("session", 70));
		expect(r.pdf.canPersist(ID)).toBe(false);
		const before = clone(r.live());

		const preserveSpy = vi.spyOn(r.store, "preserve");
		await r.deleteAll();

		expect(preserveSpy).not.toHaveBeenCalled();
		expect(signals.notices).toEqual([NOT_READY]);
		expect(clone(r.live())).toEqual(before);
		expect(r.undoOnce()).toBe(true);
	});

	it("a document whose sidecar has not been read yet refuses conservatively", async () => {
		// Host attached, `ensureLoaded` never called: load === "no". The
		// record cannot say what is in the file, so it cannot promise a copy.
		const r = await rig({ lock: "none", host: false });
		r.pdf.attachHost({
			load: (pageId) => r.store.load(pageId),
			schedule: (pageId, data) => r.store.schedule(pageId, data),
			notice: (message) => signals.notices.push(message),
		});
		drawWithPen(r, stroke("session", 70));
		expect(r.pdf.canPersist(ID)).toBe(false);
		const before = clone(r.live());

		const preserveSpy = vi.spyOn(r.store, "preserve");
		await r.deleteAll();

		expect(preserveSpy).not.toHaveBeenCalled();
		expect(signals.notices).toEqual([NOT_READY]);
		expect(clone(r.live())).toEqual(before);
	});

	it("a read still in flight refuses conservatively, and succeeds once it lands", async () => {
		const r = await rig({ lock: "none", host: false });
		let releaseLoad!: () => void;
		const held = new Promise<void>((resolve) => {
			releaseLoad = resolve;
		});
		r.pdf.attachHost({
			load: async (pageId) => {
				await held;
				return r.store.load(pageId);
			},
			schedule: (pageId, data) => r.store.schedule(pageId, data),
			notice: (message) => signals.notices.push(message),
		});
		const loading = r.pdf.ensureLoaded(ID);
		expect(r.pdf.canPersist(ID)).toBe(false); // loadInFlight

		drawWithPen(r, stroke("session", 70));
		const before = clone(r.live());
		const preserveSpy = vi.spyOn(r.store, "preserve");
		await r.deleteAll();

		expect(preserveSpy).not.toHaveBeenCalled();
		expect(signals.notices).toEqual([NOT_READY]);
		expect(clone(r.live())).toEqual(before);

		// Calibration: the refusal is about the IN-FLIGHT read, not a
		// permanent inability. Once the read lands the same document deletes.
		releaseLoad();
		await loading;
		await r.store.flush();
		expect(r.pdf.canPersist(ID)).toBe(true);
		signals.notices.length = 0;
		await r.deleteAll();
		expect(r.live()).toEqual([]);
		expect(signals.notices.some((n) => n.includes("A copy is kept"))).toBe(true);
	});

	it("readiness lost DURING the backup cancels before the clear, with no stroke changed", async () => {
		const r = await rig({ lock: "none", host: true });
		drawWithPen(r, stroke("session", 70));
		await r.store.flush();
		const before = clone(r.live());
		const depthBefore = r.depth();
		const snapshotBefore = JSON.stringify(r.live());

		r.adapter.paused = true;
		const deletion = r.deleteAll();
		const stage = await r.adapter.stage(0);

		// A REAL transition, not a poked flag: a sync client leaves the
		// sidecar half-written, the external-change poll re-reads it, the read
		// comes back damaged and the record locks - all while the backup is in
		// flight. `reloadExternal` restores the session strokes it kept, so
		// the ink is untouched and ONLY readiness has changed.
		r.adapter.externalWrite(SIDECAR, '{"schemaVersion":1,"strokes":[');
		const reloaded = await r.pdf.reloadExternal(ID);
		expect(reloaded).toBe(false);
		expect(r.pdf.canPersist(ID)).toBe(false);
		expect(JSON.stringify(r.live()), "content is identical; only readiness moved").toBe(
			snapshotBefore
		);

		stage.release();
		await deletion;

		expect(signals.notices).toContain(NOT_READY);
		expect(signals.notices.some((n) => n.includes("removed"))).toBe(false);
		expect(signals.notices.some((n) => n.includes("A copy is kept"))).toBe(false);
		expect(clone(r.live())).toEqual(before);
		expect(r.depth()).toEqual(depthBefore);

		// The copy that DID complete is left where it is - it is a real
		// generation of real ink - and nothing claimed it covers anything.
		expect(r.adapter.files.has(stage.path)).toBe(true);
		expect(r.adapter.files.get(stage.path)).toBe(stage.bytes);

		expect(r.undoOnce()).toBe(true);
		expect(r.redoOnce()).toBe(true);
		expect(clone(r.live())).toEqual(before);
	});
});

// ---------------------------------------------------------------------------
// CONTENT, proved on its own. Readiness holds throughout this block.
// ---------------------------------------------------------------------------

describe("content: ink that changes while the backup runs is not cleared", () => {
	it("a late stroke finished during the backup cancels the wipe and survives a reload", async () => {
		const r = await rig({ lock: "none", host: true });
		drawWithPen(r, stroke("old2", 40));
		await r.store.flush();
		const filesBefore = r.files();

		r.adapter.paused = true;
		const deletion = r.deleteAll();
		const stage = await r.adapter.stage(0);
		expect(stage.bytes).toBe(filesBefore.find(([p]) => p === SIDECAR)![1]);

		drawWithPen(r, stroke("late", 70));
		const beforeClear = clone(r.live());
		expect(beforeClear.some((s) => s.id === "late")).toBe(true);
		const depthBefore = r.depth();

		expect(r.pdf.canPersist(ID), "readiness is NOT what stops this one").toBe(true);
		stage.release();
		await deletion;
		await r.store.flush();

		expect(signals.notices).toContain(CHANGED);
		expect(signals.notices.some((n) => n.includes("removed"))).toBe(false);
		expect(signals.notices.some((n) => n.includes("A copy is kept"))).toBe(false);
		expect(clone(r.live())).toEqual(beforeClear);
		expect(r.depth()).toEqual(depthBefore);

		// The completed copy is kept, byte-exact, at the path preserve chose.
		expect(r.adapter.files.get(stage.path)).toBe(stage.bytes);

		// Durability, not just retention: the live sidecar was written and a
		// fresh store reading from disk sees every stroke including the late
		// one. Anything less is "still on screen", which is not recovery.
		expect(clone(await r.freshRead()).map(persisted)).toEqual(beforeClear.map(persisted));

		expect(r.undoOnce()).toBe(true);
		expect(r.live().some((s) => s.id === "late")).toBe(false);
		expect(r.redoOnce()).toBe(true);
		expect(clone(r.live())).toEqual(beforeClear);
	});

	it("same-array mutation through the store's own commit is seen", async () => {
		const r = await rig({ lock: "none", host: true });
		drawWithPen(r, stroke("old2", 40));
		await r.store.flush();
		const arrayBefore = r.live();

		r.adapter.paused = true;
		const deletion = r.deleteAll();
		const stage = await r.adapter.stage(0);

		// `commit` pushes into the SAME array the snapshot was taken from: a
		// reference or a shallow copy would compare equal to itself here.
		r.pdf.commit(ID, stroke("committed", 90));
		expect(r.live()).toBe(arrayBefore);

		const beforeClear = clone(r.live());
		stage.release();
		await deletion;

		expect(signals.notices).toContain(CHANGED);
		expect(clone(r.live())).toEqual(beforeClear);
		expect(r.live().some((s) => s.id === "committed")).toBe(true);
	});

	it("live replacement through replaceAllLive is seen, and retention is not yet a save", async () => {
		const r = await rig({ lock: "none", host: true });
		drawWithPen(r, stroke("old2", 40));
		await r.store.flush();

		r.adapter.paused = true;
		const deletion = r.deleteAll();
		const stage = await r.adapter.stage(0);

		// The live half of a gesture: a new array, no write scheduled.
		r.pdf.replaceAllLive(ID, [...r.live(), stroke("dragging", 120)]);
		const beforeClear = clone(r.live());
		stage.release();
		await deletion;

		expect(signals.notices).toContain(CHANGED);
		expect(clone(r.live())).toEqual(beforeClear);

		// RETENTION, not durability: nothing has written this yet, and saying
		// otherwise is the same overclaim this whole slice is about.
		await r.store.flush();
		expect((await r.freshRead()).some((s) => s.id === "dragging")).toBe(false);

		// Completing the gesture through the ordinary path is what makes it
		// recoverable, and then it is.
		r.pdf.save(ID);
		await r.store.flush();
		expect((await r.freshRead()).some((s) => s.id === "dragging")).toBe(true);
	});

	it("one interior coordinate moving 0.001 is seen, though the disk cannot show it", async () => {
		const r = await rig({ lock: "none", host: true });
		await r.store.flush();
		const beforeClear = clone(r.live());
		expect(beforeClear).toHaveLength(1);
		const target = r.live()[0]!;
		const bboxBefore = clone(target.bbox);
		const persistedBefore = persisted(target);
		const movedFrom = target.points[1]!.x;

		r.adapter.paused = true;
		const deletion = r.deleteAll();
		const stage = await r.adapter.stage(0);

		// Same id, same count, same order, same style, same page, same
		// pressure and time, same bounding box - the moved point is INTERIOR,
		// so the extremes do not change. And 0.001 is below the 2-decimal
		// rounding `serializePage` applies, so the file cannot show it either.
		target.points[1]!.x = movedFrom + 0.001;

		expect(clone(target.bbox)).toEqual(bboxBefore);
		expect(persisted(target), "on-disk form is byte-identical").toBe(persistedBefore);
		expect(r.live()).toHaveLength(beforeClear.length);
		expect(r.live().map((s) => s.id)).toEqual(beforeClear.map((s) => s.id));

		stage.release();
		await deletion;

		// Only a full in-memory comparison could catch this one.
		expect(signals.notices).toContain(CHANGED);
		expect(signals.notices.some((n) => n.includes("removed"))).toBe(false);
		expect(r.live()).toHaveLength(1);
		expect(r.live()[0]!.points[1]!.x).toBeCloseTo(movedFrom + 0.001, 6);
	});
});

// ---------------------------------------------------------------------------
// The ordinary paths, which must be exactly as they were.
// ---------------------------------------------------------------------------

describe("the deletions that should still happen, still happen", () => {
	it("a queued pen write does not read as unready: preserve settles it and the wipe proceeds", async () => {
		const r = await rig({ lock: "none", host: true });
		drawWithPen(r, stroke("session", 70));

		// Deliberately NOT flushed: there is a write in the queue, and an
		// over-eager readiness rule that asked "is the store busy" would
		// refuse every ordinary deletion right here.
		expect(r.store.hasQueuedWrite(ID)).toBe(true);
		expect(r.pdf.canPersist(ID)).toBe(true);
		const beforeClear = clone(r.live());

		await r.deleteAll();
		await r.store.flush();

		expect(r.live()).toEqual([]);
		const kept = signals.notices.find((n) => n.includes("A copy is kept"));
		expect(kept).toBeDefined();
		const keptPath = kept!.match(/A copy is kept in (.+)\.$/)![1]!;
		// The copy holds TODAY's ink, including the stroke that was still
		// queued when the command started.
		expect(parsePage(r.adapter.files.get(keptPath)!, ID).data.strokes.map(persisted)).toEqual(
			beforeClear.map(persisted)
		);
	});

	it("a completed lasso gesture deletes, with the whole current document in the copy", async () => {
		const r = await rig({ lock: "none", host: true });
		Object.assign(r.controller, {
			dragFrom: { x: 0, y: 0 },
			dragTotal: { dx: 0, dy: 0 },
			selected: ["old"],
			selectionPage: 1,
			pagePoint: () => ({ x: 25, y: 10 }),
		});
		// Real lassoMove -> replaceAllLive through the source-defined host
		// binding; selection and coordinates stand in for gesture setup.
		r.controller.lassoMove({ pageNumber: 1 }, 1, {}, {});
		r.drainFrame();
		expect(r.controller.liveDirty).toBe(true);
		r.controller.penUp();
		await r.store.flush();

		const beforeClear = clone(r.live());
		await r.deleteAll();
		await r.store.flush();

		expect(r.live()).toEqual([]);
		const kept = signals.notices.find((n) => n.includes("A copy is kept"));
		expect(kept).toBeDefined();
		const keptPath = kept!.match(/A copy is kept in (.+)\.$/)![1]!;
		expect(parsePage(r.adapter.files.get(keptPath)!, ID).data.strokes.map(persisted)).toEqual(
			beforeClear.map(persisted)
		);
	});

	it("unchanged ink clears, with the exact existing count-and-path notice", async () => {
		const r = await rig({ lock: "none", host: true });
		drawWithPen(r, stroke("session", 70));
		await r.store.flush();
		const beforeClear = clone(r.live());
		expect(beforeClear).toHaveLength(2);

		r.adapter.paused = true;
		const deletion = r.deleteAll();
		const stage = await r.adapter.stage(0);
		// Nothing happens in the window: no-new-ink must not read as changed.
		stage.release();
		await deletion;
		await r.store.flush();

		const keptPath = stage.path;
		expect(signals.notices).toEqual([
			`Handwriting: removed 2 strokes. A copy is kept in ${keptPath}.`,
		]);
		expect(r.live()).toEqual([]);
		// The existing matching-controller history policy, unchanged.
		expect(r.depth()).toEqual({ done: 0, undone: 0 });
		expect(r.undoOnce()).toBe(false);
		expect(r.redoOnce()).toBe(false);
		expect(r.errors).toEqual([]);
		expect(parsePage(r.adapter.files.get(keptPath)!, ID).data.strokes.map(persisted)).toEqual(
			beforeClear.map(persisted)
		);
	});

	it("the singular notice is still singular", async () => {
		const r = await rig({ lock: "none", host: true });
		await r.store.flush();
		expect(r.live()).toHaveLength(1);
		await r.deleteAll();
		expect(signals.notices.some((n) => n.includes("removed 1 stroke."))).toBe(true);
	});

	it("a rejected backup still refuses the wipe and keeps undo and redo working", async () => {
		const r = await rig({ lock: "none", host: true });
		drawWithPen(r, stroke("session", 70));
		await r.store.flush();
		const beforeClear = clone(r.live());
		const depthBefore = r.depth();

		r.adapter.paused = true;
		const deletion = r.deleteAll();
		const stage = await r.adapter.stage(0);
		stage.reject = true;
		stage.release();
		await deletion;

		expect(signals.notices).toEqual([DISK_ERROR]);
		expect(signals.notices.some((n) => n.includes("removed"))).toBe(false);
		expect(clone(r.live())).toEqual(beforeClear);
		expect(r.depth()).toEqual(depthBefore);
		expect(
			r.errors.map((a) => a.map(String)).some((a) => a.join(" ").includes("EIO"))
		).toBe(true);

		expect(r.undoOnce()).toBe(true);
		expect(r.live().some((s) => s.id === "session")).toBe(false);
		expect(r.redoOnce()).toBe(true);
		expect(clone(r.live())).toEqual(beforeClear);
	});
});

// ---------------------------------------------------------------------------
// Two people pressing Delete all at once on the same document.
// ---------------------------------------------------------------------------

describe("two confirmed deletions on the same PDF", () => {
	it("the second cannot erase ink drawn after the first one finished", async () => {
		const r = await rig({ lock: "none", host: true });
		await r.store.flush();

		r.adapter.paused = true;
		// Both start before either backup lands, so the second is holding a
		// snapshot that is about to go stale.
		const first = r.deleteAll();
		const second = r.deleteAll();

		const stage0 = await r.adapter.stage(0);
		stage0.release();
		await first;
		// Deliberately NOT flushed here. `flush` awaits every write-chain
		// tail, and the second deletion's `preserve` is already sitting on
		// that chain waiting for its own gate - so flushing now would wait on
		// a gate this test has not released yet. In-memory state is what the
		// assertion below needs anyway.
		expect(r.live()).toEqual([]);

		// New ink, after the first wipe completed. This is what the second
		// deletion must not take with it on the strength of an old reading.
		drawWithPen(r, stroke("after", 150));
		const afterFirst = clone(r.live());

		// PageStore serializes preserve on the page's write chain, so the
		// second stage only arrives now. It must arrive - a deadlock here
		// would be its own defect.
		const stage1 = await r.adapter.stage(1);
		stage1.release();
		await second;
		await r.store.flush();

		expect(clone(r.live()), "ink drawn after the first wipe survives").toEqual(afterFirst);
		expect(signals.notices).toContain(CHANGED);
		expect(signals.notices.filter((n) => n.includes("removed")).length).toBe(1);
		expect(r.adapter.stages).toHaveLength(2);
		// Every recovery generation is a distinct file; neither overwrote the
		// other, and both hold what they actually copied.
		expect(new Set(r.adapter.stages.map((s) => s.path)).size).toBe(2);
		for (const s of r.adapter.stages) expect(r.adapter.files.get(s.path)).toBe(s.bytes);
	});
});

// ---------------------------------------------------------------------------
// Calibration and an explicitly-unproven lead.
// ---------------------------------------------------------------------------

describe("calibration: this harness can see a complete undo when one exists", () => {
	it("the inline surface's real registry and CodeMirror history restore everything a wipe removed", async () => {
		// Kept from the audit instrument on purpose. The PDF assertions above
		// read `historyStep(...) === false` after a successful wipe, and that
		// is only meaningful if this harness can tell a working undo from a
		// cleared one. Here the same shape of test, on the surface whose
		// history is NOT cleared, sees a full restore.
		const adapter = new FakeAdapter();
		const store = new PageStore({ vault: { adapter } } as any);
		const plugin = Object.create(HandwritingPlugin.prototype) as any;
		plugin.store = store;
		// The SAME FakeAdapter the PageStore writes through, so the command
		// reads back the artifact preserve actually wrote, at the exact path
		// it returned. Nothing here fabricates a matching backup: an unwritten
		// or mismatched path throws or misses exactly as it would in a vault.
		plugin.app = { vault: { adapter } };
		const id = "inline-calibration";
		const path = "calibration.md";
		const page = emptyPage(id);
		page.surface = "inline";
		adapter.externalWrite(`.handwriting/${id}.json`, serializePage(page));

		inlineInk.attachHost({
			readPageId: () => id,
			claimId: async (_p: string, pageId: string) => ({ pageId }),
			loadSidecar: (pageId: string) => store.load(pageId),
			scheduleSidecar: (pageId: string, data: any) => store.schedule(pageId, data),
			notify: (message: string) => signals.notices.push(message),
		} as any);
		await inlineInk.ensureLoaded(path);

		let state = EditorState.create({
			doc: "synthetic note",
			extensions: [history(), inkHistorySupport()],
		});
		// The real constructor registers this overlay in the real
		// deleteAllInkOn registry. Only mounting/painting and the editor's
		// dispatch transport are substituted.
		vi.spyOn(InkOverlayPlugin.prototype, "mount").mockImplementation(() => {});
		const view: any = {
			get state() {
				return state;
			},
			dispatch(input: Transaction | TransactionSpec) {
				const tr = input instanceof Transaction ? input : state.update(input);
				state = tr.state;
				for (const effect of tr.effects) {
					if (effect.is(inkEffect) && !tr.annotation(inkApplied)) {
						overlay.applyInkOp(effect.value);
					}
				}
			},
		};
		const overlay = new InkOverlayPlugin(view) as any;
		Object.assign(overlay, {
			filePath: () => path,
			selection: { clear() {}, prune() {} },
			scheduleRepaint() {},
			repaintPath() {},
			redrawSelectionUI() {},
			unmount() {},
		});
		cleanup.push(() => {
			overlay.destroy();
			inlineInk.handleDelete(path);
			(inlineInk as any).host = null;
		});

		const s = stroke("inline-old");
		delete (s as { page?: number }).page;
		inlineInk.commit(path, s);
		overlay.dispatchInk({ type: "add", path, strokes: [s] });
		await store.flush();

		const beforeClear = clone(inlineInk.strokes(path));
		expect(beforeClear).toHaveLength(1);
		expect(undoDepth(state)).toBeGreaterThan(0);

		// The command now carries a captured note object rather than a path, so
		// a rename cannot retarget it mid-flight. This calibration is about
		// undo, not identity, so the target is simply valid throughout.
		const noteFile = { path, extension: "md" };
		Object.assign(plugin, {
			unloaded: false,
			app: {
				...(plugin.app ?? {}),
				vault: {
					...(plugin.app?.vault ?? {}),
					getFileByPath: (p: string) => (p === path ? noteFile : null),
					getAbstractFileByPath: (p: string) => (p === path ? noteFile : null),
				},
				metadataCache: { getFileCache: () => ({}) },
			},
		});

		await plugin.deleteAllInk({ file: noteFile, path });
		await store.flush();
		expect(clone(inlineInk.strokes(path))).toEqual([]);

		// The calibration itself: a real undo, through real CodeMirror
		// history, brings the whole stroke back.
		expect(undo({ state, dispatch: view.dispatch })).toBe(true);
		await store.flush();
		expect(clone(inlineInk.strokes(path)).map(persisted)).toEqual(beforeClear.map(persisted));
	});
});

describe("explicitly NOT a proven user reproduction", () => {
	it("records the unfinished-lasso ordering as an API-level lead only", async () => {
		// Calling the confirmed deletion BEFORE a gesture completes is
		// reachable through the API, and the guards treat it like any other
		// state. Whether ordinary input and the confirmation modal can produce
		// that order is UNPROVED - no host routing evidence exists for it - so
		// this is recorded, not asserted as a user-facing safety claim, and it
		// is not counted as a reproduction anywhere in the handback.
		const r = await rig({ lock: "none", host: true });
		Object.assign(r.controller, {
			dragFrom: { x: 0, y: 0 },
			dragTotal: { dx: 0, dy: 0 },
			selected: ["old"],
			selectionPage: 1,
			pagePoint: () => ({ x: 25, y: 10 }),
		});
		r.controller.lassoMove({ pageNumber: 1 }, 1, {}, {});
		r.drainFrame();
		expect(r.controller.liveDirty).toBe(true);

		// No penUp: the gesture is still live and unsaved, so the drag exists
		// only in memory - `replaceAllLive` schedules no write by design.
		const beforeClear = clone(r.live());
		await r.deleteAll();
		await r.store.flush();

		// WHAT ACTUALLY HAPPENS, recorded rather than blessed. Nothing changes
		// during the await, so both guards pass and the wipe proceeds - which
		// is the guards behaving exactly as specified. The backup therefore
		// holds the stroke at its PRE-DRAG position, and the un-saved drag is
		// not in any copy.
		const survived = [...r.recoverable(), ...clone(r.live())];
		const missing = beforeClear.filter(
			(s) => !survived.some((t) => persisted(t) === persisted(s))
		);

		// The stroke itself is in a recovery copy - its identity and its
		// last SAVED state both survive.
		expect(r.recoverable().some((s) => s.id === "old")).toBe(true);

		// And this is the honest limit, asserted as the lead it is rather
		// than as a safety claim. The un-committed live drag is absent from
		// every copy. This slice does NOT repair that and does not pretend
		// to: reaching a confirmed deletion before a gesture completes is an
		// API-level ordering only, with no supported host-routing evidence
		// that ordinary input and the confirmation modal can produce it. It
		// is unchanged by this repair - the same outcome on the base commit -
		// and it stays outside the proven user-facing fix, pending that
		// evidence. Promoting it to an expected pass here would be inventing
		// a reproduction.
		expect(
			missing.map((s) => s.id),
			"recorded lead: the unsaved live drag is in no copy; reachability unproved"
		).toEqual(["old"]);
	});
});
