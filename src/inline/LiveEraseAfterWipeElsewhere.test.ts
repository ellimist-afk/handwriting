/**
 * Two panes on one note. An erase is held in pane B (the pen still down) while pane A takes strokes off the note:
 * Delete all ink, a lasso delete, or the note read again from disk. Then pane B's erase is torn down with no lift.
 *
 * The teardown puts the note back as the erase found it (rollbackLiveGesture, InkOverlayGestureEnd.ts): the pieces it
 * cut come out and its originals go back in. Before this file, that put back what pane A had just taken off, and saved
 * it: Delete all ink in A, then a note switch in B, and the wiped strokes were on the note again, on screen and on disk.
 *
 * The contract checked here, in both eraser modes (whole stroke, the default, and the reticle that cuts pieces):
 * - no stroke comes back that a wipe or a lasso delete took off the note since the erase's pen-down;
 * - a stroke the erase cut and nobody deleted is on the note once, whole or as pieces, never both;
 * - every teardown that reaches the rollback: a note switch, the pane closed, Ctrl+Z in B with the pen down, the
 *   plugin turned off; each with a control showing the same teardown does put the note back when nothing was taken;
 * - the wipe's undo brings back what the wipe took, once each;
 * - through the command itself: the trash copy holds what the wipe's undo brings back; an erase begun in B during the
 *   copy refuses the wipe in the approved words and leaves the ink as it was; a damaged note's session-only wipe holds
 *   too; a pen stroke held in B is not dropped by the wipe.
 * Guards: a lasso drag or an insert-space drag held in B moves nothing back after the wipe, at teardown or at the lift.
 *
 * Rig: two REAL InkOverlayPlugin instances (the constructor registers each, mount stays inert), the REAL inlineInk store
 * with a host that keeps the last page written, the REAL eraseAt, lassoMove, lassoUp, deleteSelectedInk, applyInkOp,
 * clearAllInk, deleteAllInkOn, resetGestureState, destroy, setInlineInkEnabled and the plugin's deleteAllInk. Each
 * pane's editor dispatch is recorded instead of applied; an undo in A applies the inverse of the step A recorded, as
 * the editor history does. The erase fields pen-down sets are set as pen-down sets them. Same rig shape as
 * LiveGestureRollback.test.ts; the command half as InlineDeleteAllRouting.test.ts drives it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOverlayPlugin, inlineInk, deleteAllInkOn, setInlineInkEnabled } from "./InkOverlay";
import { invertInkOp, type InkOp } from "./InkHistory";
import { cutSource } from "./InlineInkStoreCommit";
import type { InlineInkHost } from "./InlineInkStore";
import { emptyPage, parsePage, serializePage, type PageData, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import { resetTipModeForTest } from "./TipMode";

const notices = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: string) { notices.list.push(message); }
			hide(): void { /* no-op */ }
		},
	};
});
import HandwritingPlugin, { deleteAllRefusalText } from "../main";

type Fields = Record<string, any>;
const noop = (): undefined => undefined;
let serial = 0;
const made: Fields[] = [];
const paths = new Set<string>();

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	resetTipModeForTest();
	notices.list.length = 0;
});
afterEach(() => {
	setInlineInkEnabled(true);
	for (const o of made.splice(0)) {
		try { (o.destroy as () => void)(); } catch { /* inert rig: teardown of unmounted parts */ }
	}
	for (const p of paths) inlineInk.handleDelete(p);
	paths.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function stroke(id: string, x: number, y: number): InkStroke {
	const points = [];
	for (let i = 0; i <= 10; i++) points.push({ x: x + i * 4, y: y + (i % 2) * 6, pressure: 0.5, t: i * 8 });
	return { id, tool: "pen", color: "#000000", width: 2, points, bbox: { x, y, width: 40, height: 6 }, createdAt: 0 };
}

function pane(path: () => string) {
	const win = {
		requestAnimationFrame: () => 1, cancelAnimationFrame: noop, setTimeout: () => 0, clearTimeout: noop,
		devicePixelRatio: 1, getComputedStyle: () => ({ fontSize: "16px" }),
	};
	const classList = { add: noop, remove: noop, contains: () => false, toggle: noop };
	const view = {
		dom: { isConnected: true, ownerDocument: { defaultView: win }, parentElement: null },
		scrollDOM: { addEventListener: noop, removeEventListener: noop, classList },
		contentDOM: {},
		state: { field: () => undefined },
	};
	const o = new InkOverlayPlugin(view as never) as unknown as Fields;
	made.push(o);
	const ops: InkOp[] = [];
	Object.assign(o, {
		container: { remove: noop }, scale: 1, cssScale: 1,
		filePath: path,
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 } },
		redrawSelectionUI: noop,
		dispatchInk: (op: InkOp) => { ops.push(op); },
		refreshStrip: noop,
		retirePanSettle: noop,
		indexDirty: true,
		// The wet layers and the tail a contact that ends without a lift clears (contactEndedWithoutLift).
		wet: { clear: noop }, highlightWet: { clear: noop }, highlightWetCanvas: { setCssStyles: noop },
		tail: { clearAll: noop, clear: noop, prepareLive: noop }, cssWidth: 800, cssHeight: 600,
	});
	return { o, ops };
}

async function rig() {
	const path = `live-erase-wipe-${++serial}.md`;
	paths.add(path);
	const pageId = `live-erase-wipe-id-${serial}`;
	let written: PageData | null = null;
	let disk: PageData | null = null;
	inlineInk.attachHost({
		readPageId: (p) => (p === path ? pageId : null),
		claimId: async () => ({ pageId }),
		loadSidecar: async (): Promise<ParseResult> => {
			if (disk) return { data: disk, recovered: false };
			const page = emptyPage(pageId);
			page.surface = "inline";
			return { data: page, recovered: false };
		},
		scheduleSidecar(_id, page) { written = page; },
		scheduleSidecarNow: async (_id, page) => { written = page; },
		notify() {},
	});
	await inlineInk.ensureLoaded(path);
	const strokes: InkStroke[] = [];
	for (let i = 0; i < 12; i++) strokes.push(stroke(`s${i}`, (i % 4) * 60, Math.floor(i / 4) * 40));
	inlineInk.applyAddLive(path, strokes);
	inlineInk.save(path);
	let currentB = path;
	const a = pane(() => path);
	const b = pane(() => currentB);
	return {
		path, pageId, a, b,
		ids: () => inlineInk.strokes(path).map((s) => s.id),
		saved: () => (written ? (written as PageData).strokes.map((s) => s.id) : null),
		switchB: (p: string) => { currentB = p; },
		/** The page another device wrote: what the next read from disk finds. */
		setDisk(list: readonly InkStroke[]) {
			const page = emptyPage(pageId);
			page.surface = "inline";
			page.strokes = list.map((s) => structuredClone(s));
			disk = page;
		},
	};
}
type Rig = Awaited<ReturnType<typeof rig>>;

const sample = (x: number, y: number) => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
const sorted = (ids: readonly string[]): string[] => [...ids].sort();
const ORIGINALS = Array.from({ length: 12 }, (_, i) => `s${i}`);

type EraserMode = "stroke" | "reticle";
const MODES: EraserMode[] = ["stroke", "reticle"];

/** An erase held in B, as pen-down sets it, then a pass through the middle of s1 and s5. */
function eraseInB(r: Rig, mode: EraserMode): void {
	const o = r.b.o;
	(o.erasePieces as Set<string>).clear();
	Object.assign(o, {
		mode: "erase", erased: [], eraseWhole: mode === "stroke",
		eraseFrom: [...inlineInk.strokes(r.path)],
		eraseHistoryIdentity: inlineInk.captureHistoryIdentity(r.path),
	});
	for (let y = 0; y <= 46; y += 4) o.eraseAt(sample(80, y));
	const ids = r.ids();
	expect(ids, "precondition: the erase took s1 and s5 off the note live").not.toContain("s1");
	expect(ids).not.toContain("s5");
	expect((o.erased as unknown[]).length, "precondition: originals recorded").toBe(2);
	const pieces = (o.erasePieces as Set<string>).size;
	if (mode === "stroke") expect(pieces, "precondition: the whole-stroke eraser cuts no pieces").toBe(0);
	else expect(pieces, "precondition: the reticle cut pieces").toBeGreaterThan(0);
}

/** Every piece on the note that was cut from `id`, by the store's own record of where each piece came from. */
function piecesOnNote(r: Rig, id: string): string[] {
	const rec = inlineInk.record(r.path);
	return r.ids().filter((x) => x !== id && cutSource(rec, x) === id);
}

/** The bound for one stroke B's erase cut: on the note once, whole or as pieces, never both; or gone with nothing of it. */
function onceWholeOrPieces(r: Rig, id: string, want: "kept" | "gone"): void {
	const whole = r.ids().filter((x) => x === id).length;
	const pieces = piecesOnNote(r, id).length;
	if (want === "gone") {
		expect({ whole, pieces }, `${id} came back after it was taken off the note`).toEqual({ whole: 0, pieces: 0 });
		return;
	}
	expect(whole <= 1, `${id} twice on the note`).toBe(true);
	expect(whole === 1 && pieces > 0, `${id} on the note whole AND as pieces`).toBe(false);
	expect(whole === 1 || pieces > 0, `${id} lost: neither whole nor as pieces`).toBe(true);
}

function noIdTwice(r: Rig): void {
	const ids = r.ids();
	expect(new Set(ids).size, `a stroke id twice on the note: ${ids.join(",")}`).toBe(ids.length);
}

/** Delete all ink, from pane A: the command's own call into the registry with A as the pane it started in. */
function wipeInA(r: Rig): void {
	expect(deleteAllInkOn(r.path, r.a.o as unknown as InkOverlayPlugin), "Delete all ran in A").not.toBeNull();
	expect(r.ids(), "precondition: Delete all emptied the note").toEqual([]);
}

/** The note's last stroke, the one B drew last. */
const LAST = ORIGINALS[ORIGINALS.length - 1]!;

/** B's previous history step, which Ctrl+Z in B undoes: B drew the last stroke. */
function bLastStep(r: Rig): InkOp {
	const last = inlineInk.strokes(r.path).find((s) => s.id === LAST) ?? stroke(LAST, 180, 80);
	return { type: "remove", path: r.path, strokes: [last], indices: [ORIGINALS.length - 1] };
}

/** Every way B's erase is torn down with the pen still down. */
const teardowns: { name: string; run(r: Rig, undoStep: InkOp): void; controlLoses: string[] }[] = [
	{
		// What update()'s path-change branch runs when B's pane opens another note (InkOverlayReload.ts).
		name: "B's note switched",
		run(r) { r.switchB("another-note.md"); r.b.o.resetGestureState(); },
		controlLoses: [],
	},
	{
		// The editor plugin's destroy: the pane closed (unmount).
		name: "B's pane closed",
		run(r) { r.b.o.destroy(); },
		controlLoses: [],
	},
	{
		// Undo applied in B with the pen still down: applyInkOp ends the live gesture first.
		name: "Ctrl+Z in B with the pen down",
		run(r, undoStep) { r.b.o.applyInkOp(undoStep); },
		controlLoses: [LAST],
	},
	{
		// The plugin turned off: every pane unmounts.
		name: "the plugin turned off",
		run() { setInlineInkEnabled(false); },
		controlLoses: [],
	},
];

describe("an erase held in another pane, torn down after Delete all ink", () => {
	for (const mode of MODES) {
		for (const t of teardowns) {
			it(`${mode} eraser, ${t.name}: the wiped strokes stay gone, on screen and on disk`, async () => {
				const r = await rig();
				const undoStep = bLastStep(r);
				eraseInB(r, mode);
				wipeInA(r);
				t.run(r, undoStep);
				expect(r.ids(), "the teardown brought wiped strokes back").toEqual([]);
				expect(r.saved(), "the saved page holds wiped strokes").toEqual([]);
			});

			it(`control: ${mode} eraser, ${t.name} with nothing taken: the note is put back as the erase found it`, async () => {
				const r = await rig();
				const undoStep = bLastStep(r);
				const before = r.ids().filter((id) => !t.controlLoses.includes(id));
				eraseInB(r, mode);
				t.run(r, undoStep);
				expect(r.ids(), "this teardown did not reach the rollback").toEqual(before);
				expect(r.saved(), "the restored note was not saved").toEqual(before);
			});
		}
	}
});

describe("the wipe's undo after B's teardown", () => {
	for (const mode of MODES) {
		it(`${mode} eraser: one undo in A brings back each stroke the wipe took, once, and no piece beside its original`, async () => {
			const r = await rig();
			eraseInB(r, mode);
			wipeInA(r);
			const wipe = r.a.ops[r.a.ops.length - 1]!;
			expect(wipe.type, "precondition: A recorded the wipe").toBe("remove");
			const took = wipe.type === "remove" ? wipe.strokes.map((s) => s.id) : [];
			r.switchB("another-note.md");
			r.b.o.resetGestureState();
			r.a.o.applyInkOp(invertInkOp(wipe));
			expect(sorted(r.ids()), "the wipe's undo did not bring back exactly what the wipe took").toEqual(sorted(took));
			noIdTwice(r);
			for (const id of ["s1", "s5"]) {
				if (r.ids().includes(id)) expect(piecesOnNote(r, id), `a piece beside its original ${id}`).toEqual([]);
			}
			expect(sorted(r.saved() ?? []), "the saved page after the undo").toEqual(sorted(took));
		});
	}
});

describe("an erase held in another pane, torn down after a lasso delete or a read from disk", () => {
	it("reticle eraser: A lasso-deletes B's pieces of s1, B's note switched: s1 stays gone, s5 is on the note once", async () => {
		const r = await rig();
		eraseInB(r, "reticle");
		const gone = piecesOnNote(r, "s1");
		expect(gone.length, "precondition: s1 was cut into pieces").toBeGreaterThan(0);
		(r.a.o.selection as { selectExactly(ids: readonly string[]): void }).selectExactly(gone);
		r.a.o.deleteSelectedInk();
		expect(r.ids().some((id) => gone.includes(id)), "precondition: the lasso delete took them").toBe(false);
		r.switchB("another-note.md");
		r.b.o.resetGestureState();
		onceWholeOrPieces(r, "s1", "gone");
		onceWholeOrPieces(r, "s5", "kept");
		noIdTwice(r);
		for (const id of ORIGINALS.filter((x) => x !== "s1" && x !== "s5")) expect(r.ids(), `${id} lost`).toContain(id);
		expect(sorted(r.saved() ?? []), "the saved page is not the note").toEqual(sorted(r.ids()));
	});

	it("reticle eraser: A lasso-deletes ONE of B's pieces of s1, B's note switched: the rest of s1's pieces stay, once each", async () => {
		const r = await rig();
		eraseInB(r, "reticle");
		const all = piecesOnNote(r, "s1");
		expect(all.length, "precondition: s1 was cut into two or more pieces").toBeGreaterThan(1);
		const one = all[0]!;
		const rest = all.slice(1);
		(r.a.o.selection as { selectExactly(ids: readonly string[]): void }).selectExactly([one]);
		r.a.o.deleteSelectedInk();
		expect(r.ids(), "precondition: the lasso delete took the one piece").not.toContain(one);
		expect(sorted(piecesOnNote(r, "s1")), "precondition: the lasso delete took only that piece").toEqual(sorted(rest));
		r.switchB("another-note.md");
		r.b.o.resetGestureState();
		expect(r.ids(), "s1 came back whole after a piece of it was deleted").not.toContain("s1");
		expect(r.ids(), "the deleted piece came back").not.toContain(one);
		expect(sorted(piecesOnNote(r, "s1")), "a piece of s1 nobody deleted is gone").toEqual(sorted(rest));
		onceWholeOrPieces(r, "s5", "kept");
		noIdTwice(r);
		for (const id of ORIGINALS.filter((x) => x !== "s1" && x !== "s5")) expect(r.ids(), `${id} lost`).toContain(id);
		expect(sorted(r.saved() ?? []), "the saved page is not the note").toEqual(sorted(r.ids()));
	});

	it("reticle eraser: A lasso-deletes s0 and B's pieces of s5, B's pane closed: s0, s5 stay gone, s1 is on the note once", async () => {
		const r = await rig();
		eraseInB(r, "reticle");
		const gone = ["s0", ...piecesOnNote(r, "s5")];
		(r.a.o.selection as { selectExactly(ids: readonly string[]): void }).selectExactly(gone);
		r.a.o.deleteSelectedInk();
		r.b.o.destroy();
		expect(r.ids()).not.toContain("s0");
		onceWholeOrPieces(r, "s5", "gone");
		onceWholeOrPieces(r, "s1", "kept");
		noIdTwice(r);
	});

	it("stroke eraser: A lasso-deletes s0, B's note switched: s1 and s5 come back, s0 stays gone", async () => {
		const r = await rig();
		eraseInB(r, "stroke");
		(r.a.o.selection as { selectExactly(ids: readonly string[]): void }).selectExactly(["s0"]);
		r.a.o.deleteSelectedInk();
		r.switchB("another-note.md");
		r.b.o.resetGestureState();
		const want = ORIGINALS.filter((id) => id !== "s0");
		expect(sorted(r.ids()), "the erase was not put back, or the deleted stroke came back").toEqual(sorted(want));
		expect(sorted(r.saved() ?? [])).toEqual(sorted(want));
	});

	it("reticle eraser: the note read from disk without B's pieces of s1, B's note switched: s1 does not come back", async () => {
		const r = await rig();
		eraseInB(r, "reticle");
		const gone = piecesOnNote(r, "s1");
		const kept = inlineInk.strokes(r.path).filter((s) => !gone.includes(s.id));
		r.setDisk(kept);
		expect(await inlineInk.reloadExternal(r.path), "precondition: the read from disk ran").toBe(true);
		expect(sorted(r.ids()), "precondition: the read took s1's pieces").toEqual(sorted(kept.map((s) => s.id)));
		r.switchB("another-note.md");
		r.b.o.resetGestureState();
		onceWholeOrPieces(r, "s1", "gone");
		onceWholeOrPieces(r, "s5", "kept");
		noIdTwice(r);
	});

	for (const mode of MODES) {
		it(`${mode} eraser: s1 put back on the note by a read from disk, B's note switched: s1 is on the note once`, async () => {
			const r = await rig();
			const all = [...inlineInk.strokes(r.path)];
			eraseInB(r, mode);
			r.setDisk(all);
			expect(await inlineInk.reloadExternal(r.path), "precondition: the read from disk ran").toBe(true);
			expect(r.ids(), "precondition: the read put s1 back").toContain("s1");
			r.switchB("another-note.md");
			r.b.o.resetGestureState();
			onceWholeOrPieces(r, "s1", "kept");
			onceWholeOrPieces(r, "s5", "kept");
			noIdTwice(r);
		});
	}
});

describe("guards: a drag or an insert-space move held in B moves nothing back after the wipe", () => {
	function dragInB(r: Rig): void {
		const o = r.b.o;
		(o.selection as { selectExactly(ids: readonly string[]): void }).selectExactly(["s0", "s5"]);
		Object.assign(o, {
			mode: "lasso", dragFrom: { x: 10, y: 10 }, dragTotal: { dx: 0, dy: 0 }, dragIds: ["s0", "s5"],
			dragHistoryIdentity: inlineInk.captureHistoryIdentity(r.path),
		});
		for (let i = 1; i <= 5; i++) o.lassoMove([sample(10 + i * 7, 10 + i * 3)]);
	}
	function spaceInB(r: Rig): void {
		const o = r.b.o;
		Object.assign(o, {
			mode: "space", spaceHistoryIdentity: inlineInk.captureHistoryIdentity(r.path),
			spaceLineY: -5, spaceIds: ["s5"], spaceTotalDy: 30,
		});
		inlineInk.moveStrokes(r.path, ["s5"], 0, 30);
	}
	const ends: { name: string; run(r: Rig): void }[] = [
		{ name: "B's note switched", run(r) { r.switchB("another-note.md"); r.b.o.resetGestureState(); } },
		{ name: "B's pane closed", run(r) { r.b.o.destroy(); } },
	];
	for (const e of ends) {
		it(`lasso drag, ${e.name}: the note holds no stroke and no save adds one`, async () => {
			const r = await rig();
			dragInB(r);
			wipeInA(r);
			e.run(r);
			expect(r.ids()).toEqual([]);
			expect(r.saved()).toEqual([]);
		});
		it(`insert-space move, ${e.name}: the note holds no stroke and no save adds one`, async () => {
			const r = await rig();
			spaceInB(r);
			wipeInA(r);
			e.run(r);
			expect(r.ids()).toEqual([]);
			expect(r.saved()).toEqual([]);
		});
	}
	it("lasso drag, B lifted: the note holds no stroke and no save adds one", async () => {
		const r = await rig();
		dragInB(r);
		wipeInA(r);
		r.b.o.lassoUp();
		r.b.o.resetGestureState();
		expect(r.ids()).toEqual([]);
		expect(r.saved()).toEqual([]);
	});
});

describe("through the Delete all ink command, with an erase in another pane", () => {
	const TRASH = ".handwriting/trash/kept.json";
	type Deleter = { deleteAllInk(target: unknown): Promise<void> };

	/** The plugin as the command sees it: a vault holding the note, and a trash copy written where preserve says. */
	function plugin(r: Rig, duringCopy?: () => void) {
		const file = { path: r.path, extension: "md" };
		const files = new Map<string, string>();
		const p = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
			unloaded: false,
			store: {
				preserve: async () => {
					// The copy is what the file holds as preserve reads it.
					const page = emptyPage(r.pageId);
					page.surface = "inline";
					page.strokes = [...inlineInk.strokes(r.path)];
					files.set(TRASH, serializePage(page));
					duringCopy?.();
					return TRASH;
				},
			},
			app: {
				vault: {
					getFileByPath: (x: string) => (x === r.path ? file : null),
					getAbstractFileByPath: (x: string) => (x === r.path ? file : null),
					adapter: {
						read: async (at: string) => {
							const text = files.get(at);
							if (text === undefined) throw new Error(`no such file: ${at}`);
							return text;
						},
					},
				},
				metadataCache: { getFileCache: () => ({}) },
			},
		});
		const target = { file, path: r.path, overlay: r.a.o };
		return {
			run: () => (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(p, target),
			copy: () => {
				const text = files.get(TRASH);
				return text === undefined ? null : parsePage(text, r.pageId).data?.strokes.map((s) => s.id) ?? null;
			},
		};
	}

	for (const mode of MODES) {
		it(`${mode} eraser held in B: the trash copy holds exactly what the wipe's undo brings back`, async () => {
			const r = await rig();
			eraseInB(r, mode);
			const cmd = plugin(r);
			await cmd.run();
			expect(r.ids(), "the command did not wipe").toEqual([]);
			const wipe = r.a.ops[r.a.ops.length - 1]!;
			expect(wipe.type).toBe("remove");
			r.switchB("another-note.md");
			r.b.o.resetGestureState();
			expect(r.ids(), "the teardown brought wiped strokes back").toEqual([]);
			r.a.o.applyInkOp(invertInkOp(wipe));
			expect(sorted(cmd.copy() ?? []), "the trash copy is not what the wipe's undo brings back").toEqual(sorted(r.ids()));
			noIdTwice(r);
		});

		it(`${mode} eraser begun in B during the copy: the wipe is refused in the approved words, the copy kept, the ink as it was`, async () => {
			const r = await rig();
			const cmd = plugin(r, () => eraseInB(r, mode));
			await cmd.run();
			const words = deleteAllRefusalText("changed-during-backup");
			expect(words, "precondition: the refusal has approved words").not.toBeNull();
			expect(notices.list, "the wipe was not refused in the approved words").toContain(words);
			expect(cmd.copy(), "the copy was not kept").not.toBeNull();
			r.switchB("another-note.md");
			r.b.o.resetGestureState();
			expect(sorted(r.ids()), "the ink is not as it was").toEqual(sorted(ORIGINALS));
		});

		it(`${mode} eraser held in B, a damaged note's session-only wipe: B's teardown brings nothing back`, async () => {
			const r = await rig();
			eraseInB(r, mode);
			(inlineInk.record(r.path) as unknown as { damagedLocked: boolean }).damagedLocked = true;
			expect(inlineInk.deleteAllReadiness(r.path).kind, "precondition: the note reads as damaged").toBe("damaged");
			await plugin(r).run();
			expect(r.ids(), "the damaged route did not wipe").toEqual([]);
			r.switchB("another-note.md");
			r.b.o.resetGestureState();
			expect(r.ids(), "the teardown brought wiped strokes back").toEqual([]);
		});
	}

	it("a pen stroke held in B is not dropped by the wipe: B's contact and its stroke builder stay", async () => {
		const r = await rig();
		const builder = { held: true };
		const router = { abandonActiveStroke: vi.fn(() => true), finishActiveStroke: noop, dispose: noop };
		Object.assign(r.b.o, { mode: "ink", builder, router });
		await plugin(r).run();
		expect(r.ids(), "the command did not wipe").toEqual([]);
		expect(router.abandonActiveStroke, "the wipe dropped B's pen contact").not.toHaveBeenCalled();
		expect(r.b.o.builder, "the wipe dropped B's stroke in flight").toBe(builder);
		expect(r.b.o.mode).toBe("ink");
	});
});
