/**
 * The inline delete-all's ROUTING and its REMOVAL - `deleteAllInkOn`
 * (`InkOverlay.ts:990`) and `clearAllInk` (`:5295`).
 *
 * WHAT WAS ALREADY COVERED, because this file exists to add the rest and not
 * to repeat it. `PdfDeleteAllPreservation.test.ts`'s calibration case, "the
 * inline surface's real registry and CodeMirror history restore everything a
 * wipe removed", builds a REAL `InkOverlayPlugin`, registers it in the real
 * `deleteAllInkOn` registry and drives the real `deleteAllInk` - so the happy
 * path (matching note, ink removed, undo restores it) is pinned there. It is
 * easy to miss by grep: it reaches `clearAllInk` through its caller and never
 * names it.
 *
 * WHAT IT DOES NOT COVER, and what every case below is for:
 *
 *  - the path guard's NEGATIVE. `clearAllInk` opens
 *    `if (this.filePath() !== path) return null;` and then operates on the
 *    PASSED path, not on its own. Delete that line and an overlay showing note
 *    A removes note B's ink and puts the undo step in A's editor - a note's
 *    content answered for a different note's file. That case uses one overlay
 *    and a matching path, so it cannot see this.
 *
 *  - the ROUTING across more than one overlay. That case registers exactly one.
 *
 *  - `0` versus `null`. They are different answers to the caller: `0` means
 *    "that note, no ink"; `null` means "no editor is showing it" and makes
 *    main.ts say "open the note in editing view" instead of a removal count.
 *
 *  - the PAIRING with the backup. `deleteAllInk` preserves first and returns
 *    on a throw. Nothing pinned that the removal really does not run.
 *
 * ONLY I/O AND PAINT ARE FAKE. Real `InlineInkStore` singleton, real
 * `InkOverlayPlugin` construction (so the real registry is populated), real
 * CodeMirror state and history.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { history, undoDepth } from "@codemirror/commands";
import { InkOverlayPlugin, inlineInk, deleteAllInkOn } from "./InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport } from "./InkHistory";
import { PARSER_INVENTED_STROKE_FIELDS, type InlineInkHost } from "./InlineInkStore";
import { emptyPage, parsePage, serializePage, type PageData } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import { codeOnly } from "../CodeOnly";
import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { undo } from "@codemirror/commands";

const notices = vi.hoisted(() => ({ list: [] as string[] }));
/**
 * Confirmation dialogs the command actually opened.
 *
 * `ConfirmDeleteInkModal` is not exported, so the only way to reach the REAL
 * callback is through its base class. Substituting `Modal` records each
 * instance and makes `open()` inert - `onOpen` never runs, so no DOM is
 * needed - while the derived constructor still stores its own `onConfirm`.
 * Invoking that is the user clicking the button, and it is production's
 * closure carrying production's captured target, not one a test supplied.
 */
const modals = vi.hoisted(() => ({ list: [] as Array<{ onConfirm?: () => void }> }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: string) {
				notices.list.push(message);
			}
			hide(): void {
				/* no-op */
			}
		},
		Modal: class {
			constructor(_app: unknown) {
				modals.list.push(this as { onConfirm?: () => void });
			}
			open(): void {
				/* the dialog is not painted; the callback is what matters */
			}
			close(): void {
				/* no-op */
			}
		},
	};
});

/** The confirmation the command last opened, as the user would click it. */
function clickConfirm(): void {
	const last = modals.list[modals.list.length - 1];
	if (!last?.onConfirm) throw new Error("no confirmation dialog was opened");
	last.onConfirm();
}

import HandwritingPlugin, {
	DELETE_ALL_NO_INK,
	DELETE_ALL_REFUSALS,
	DELETE_ALL_REFUSED,
	DELETE_ALL_TEMPORARY,
	deleteAllRefusalText,
} from "../main";

/** Shipped source text, the house pattern (`CommandPaletteNames.test.ts`). */
const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

/**
 * THE FAKE VAULT, shared so that production captures the identity rather than
 * the fixture handing a matching path to both halves.
 *
 * `fileFor` returns the SAME object for a path every time, so a stub's vault
 * lookup and the captured target agree by identity the way Obsidian's do - and
 * a test that wants a rename, a deletion or a replacement changes THIS map and
 * production notices, instead of the test asserting about a constant it also
 * supplied.
 */
const vaultFiles = new Map<string, { path: string; extension: string }>();

function fileFor(path: string): { path: string; extension: string } {
	const existing = vaultFiles.get(path);
	if (existing) return existing;
	const made = { path, extension: path.split(".").pop() ?? "md" };
	vaultFiles.set(path, made);
	return made;
}

/** The capture `deleteAllInkOrSaySo` would have made for this path. */
function targetFor(path: string): unknown {
	return { file: fileFor(path), path };
}

/**
 * A stub plugin with the vault and metadata the target guard reads.
 *
 * BUILT ON THE REAL PROTOTYPE, so `sameDeleteAllTarget` and
 * `qualifiedDeleteAllPresence` are the SHIPPED methods rather than anything a
 * fixture supplies. Only the vault lookup, the metadata cache and the store
 * are substituted; a bare object would silently take the fixture's word for
 * the very thing under test.
 */
function withVault<T extends object>(stub: T): T {
	const app = (stub as { app?: { vault?: object } }).app;
	return Object.assign(Object.create(HandwritingPlugin.prototype) as object, stub, {
		unloaded: false,
		app: {
			...(app ?? {}),
			vault: {
				...((app?.vault as object) ?? {}),
				getFileByPath: (p: string) => vaultFiles.get(p) ?? null,
				getAbstractFileByPath: (p: string) => vaultFiles.get(p) ?? null,
			},
			metadataCache: { getFileCache: () => ({}) },
		},
	}) as T;
}

let serial = 0;
const paths = new Set<string>();
const teardown: Array<() => void> = [];

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	notices.list.length = 0;
	modals.list.length = 0;
	// Mounting and painting are the only things substituted on the real
	// constructor; registration in the `deleteAllInkOn` registry is NOT, which
	// is the whole point of constructing rather than Object.create-ing here.
	vi.spyOn(InkOverlayPlugin.prototype, "mount").mockImplementation(() => {});
});

afterEach(() => {
	for (const undo of teardown.splice(0)) undo();
	for (const path of paths) inlineInk.handleDelete(path);
	paths.clear();
	vaultFiles.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 10, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 10 },
		createdAt: 0,
	};
}

const ids = (strokes: readonly InkStroke[]): string[] => strokes.map((s) => s.id);

/** One host for the whole case, so several notes can be loaded at once. */
function attachHost(): Map<string, PageData> {
	const metadata = new Map<string, string>();
	const sidecars = new Map<string, PageData>();
	const host: InlineInkHost = {
		readPageId: (p) => metadata.get(p) ?? null,
		claimId: async (_p, pageId) => ({ pageId }),
		loadSidecar: async (id) =>
			sidecars.has(id) ? { data: sidecars.get(id)!, recovered: false } : null,
		// Nothing here asserts on the scheduled write; the removal is read back
		// from the store, not from a serialized sidecar.
		scheduleSidecar: () => {},
		notify() {},
	};
	inlineInk.attachHost(host);
	(sidecars as unknown as { meta: Map<string, string> }).meta = metadata;
	return sidecars;
}

/** A loaded note with `initial` ink, plus a real registered overlay for it. */
async function note(
	sidecars: Map<string, PageData>,
	initial: InkStroke[]
): Promise<{
	path: string;
	overlay: InkOverlayPlugin;
	state: () => EditorState;
	strokes: () => readonly InkStroke[];
}> {
	const n = ++serial;
	const path = `delete-all-${n}.md`;
	const pageId = `delete-all-id-${n}`;
	paths.add(path);
	// The note exists in the fake vault too, so the command's own capture
	// resolves it the way Obsidian would.
	fileFor(path);
	const meta = (sidecars as unknown as { meta: Map<string, string> }).meta;
	meta.set(path, pageId);
	const page = emptyPage(pageId);
	page.surface = "inline";
	page.strokes = initial;
	sidecars.set(pageId, page);
	await inlineInk.ensureLoaded(path);

	let state = EditorState.create({
		doc: "note body",
		extensions: [history(), inkHistorySupport()],
	});
	const view = {
		get state() {
			return state;
		},
		dispatch(input: Transaction | TransactionSpec) {
			const tr = input instanceof Transaction ? input : state.update(input);
			state = tr.state;
			for (const effect of tr.effects) {
				if (effect.is(inkEffect) && !tr.annotation(inkApplied)) {
					(overlay as unknown as { applyInkOp(op: unknown): void }).applyInkOp(effect.value);
				}
			}
		},
	};
	const overlay = new InkOverlayPlugin(view as never);
	Object.assign(overlay, {
		filePath: () => path,
		selection: { clear() {}, prune() {} },
		scheduleRepaint() {},
		repaintPath() {},
		redrawSelectionUI() {},
		unmount() {},
	});
	teardown.push(() => (overlay as unknown as { destroy(): void }).destroy());
	return { path, overlay, state: () => state, strokes: () => inlineInk.strokes(path) };
}

type Clearable = { clearAllInk(path: string): number | null };

// ---- the path guard ---------------------------------------------------------

/**
 * Every notice, flattened and CASE-FOLDED.
 *
 * Alan has ruled on notice casing twice on 2026-09-08 - the four pdf notices
 * into sentence case, then "nothing was deleted" lowercased in the two
 * trash-copy failure notices - and his rule is "sentence case after the
 * 'Handwriting:' prefix". A test that hard-codes capitalisation blocks the
 * next such ruling from landing, which is exactly what happened here: an
 * assertion in this file held up his own approved copy.
 *
 * So these assert WHAT the user was told, not how it was capitalised.
 *
 * THE NEGATIVES MATTER MORE THAN THE POSITIVES. A stale positive assertion
 * FAILS, which is loud and gets fixed. A stale NEGATIVE silently PASSES and
 * quietly stops detecting the thing it was written for - so `not.toContain`
 * is the shape that must be case-folded, even though it is not the shape that
 * blocked anything today.
 */
const told = (): string => notices.list.join(" ").toLowerCase();

describe("clearAllInk's path guard", () => {
	it("refuses a note it is not showing: returns null, removes nothing, adds no history step", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		const b = await note(sidecars, [stroke("b-1"), stroke("b-2")]);
		const depthBefore = undoDepth(a.state());

		// A's overlay, asked to wipe B. Without the guard this removes B's ink
		// and puts the undo step in A - the note-for-a-different-file shape.
		const answer = (a.overlay as unknown as Clearable).clearAllInk(b.path);

		expect(answer).toBeNull();
		expect(ids(b.strokes())).toEqual(["b-1", "b-2"]);
		expect(ids(a.strokes())).toEqual(["a-1"]);
		expect(undoDepth(a.state())).toBe(depthBefore);
	});

	it("acts on the note it IS showing: removes exactly that ink and returns the count", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1"), stroke("a-2")]);
		const b = await note(sidecars, [stroke("b-1")]);

		const answer = (a.overlay as unknown as Clearable).clearAllInk(a.path);

		expect(answer).toBe(2);
		expect(ids(a.strokes())).toEqual([]);
		// The other note is untouched, which is the same claim from the far side.
		expect(ids(b.strokes())).toEqual(["b-1"]);
	});

	it("distinguishes 0 from null: its own note with no ink is 0, and adds no history step", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, []);
		const depthBefore = undoDepth(a.state());

		// `0` and `null` are different answers to main.ts: 0 reports "removed
		// 0 strokes", null makes it say "open the note in editing view".
		expect((a.overlay as unknown as Clearable).clearAllInk(a.path)).toBe(0);
		expect(undoDepth(a.state())).toBe(depthBefore);
	});
});

// ---- the routing ------------------------------------------------------------

describe("deleteAllInkOn's routing across mounted overlays", () => {
	it("wipes the note asked for, in ITS editor, leaving the other overlay untouched", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		const b = await note(sidecars, [stroke("b-1"), stroke("b-2")]);
		const depthA = undoDepth(a.state());
		const depthB = undoDepth(b.state());

		const removed = deleteAllInkOn(b.path);

		expect(removed).toBe(2);
		expect(ids(b.strokes())).toEqual([]);
		expect(ids(a.strokes())).toEqual(["a-1"]);
		// The undo step belongs to the pane that owns the note. A step landing
		// in A would be a wipe the user cannot reach with their own Ctrl+Z.
		expect(undoDepth(b.state())).toBeGreaterThan(depthB);
		expect(undoDepth(a.state())).toBe(depthA);
	});

	it("returns null when no mounted overlay shows the note, and removes nothing anywhere", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		// A loaded note with ink but no overlay of its own.
		const orphanPath = "delete-all-orphan.md";
		paths.add(orphanPath);
		const meta = (sidecars as unknown as { meta: Map<string, string> }).meta;
		meta.set(orphanPath, "delete-all-orphan-id");
		const page = emptyPage("delete-all-orphan-id");
		page.surface = "inline";
		page.strokes = [stroke("orphan-1")];
		sidecars.set("delete-all-orphan-id", page);
		await inlineInk.ensureLoaded(orphanPath);

		expect(deleteAllInkOn(orphanPath)).toBeNull();
		expect(ids(inlineInk.strokes(orphanPath))).toEqual(["orphan-1"]);
		expect(ids(a.strokes())).toEqual(["a-1"]);
	});
});

// ---- the pairing with the backup -------------------------------------------

describe("the backup and the removal are one decision", () => {
	const TRASH = ".handwriting/trash/kept.json";

	/**
	 * `deleteAllInk` now READS BACK the artifact `preserve` returned, so a
	 * stub that only answers with a path is no longer a copy - it is a claim
	 * about a file that does not exist. This rig gives the plugin a vault the
	 * copy actually lands in, so the command's own verification is exercised
	 * rather than stubbed past.
	 *
	 * `write` decides WHAT the copy contains, which is how the "backup holds
	 * different ink" case is expressed without touching PageStore.
	 */
	function pluginWith(
		preserve: () => Promise<string | null>,
		write?: () => string
	): HandwritingPlugin {
		const files = new Map<string, string>();
		return withVault({
			store: {
				preserve: async () => {
					const at = await preserve();
					if (at !== null && write) files.set(at, write());
					return at;
				},
			},
			app: {
				vault: {
					adapter: {
						read: async (at: string) => {
							const text = files.get(at);
							if (text === undefined) throw new Error(`no such file: ${at}`);
							return text;
						},
					},
				},
			},
		}) as unknown as HandwritingPlugin;
	}

	/** A correct trash copy: exactly the ink the note holds right now. */
	function copyOf(path: string): () => string {
		return () => {
			const page = emptyPage(inlineInk.pageIdOf(path) ?? "unknown");
			page.surface = "inline";
			page.strokes = [...inlineInk.strokes(path)];
			return serializePage(page);
		};
	}
	type Deleter = { deleteAllInk(target: unknown): Promise<void> };

	it("a backup that THROWS stops the wipe: the ink is still there and the notice says so", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1"), stroke("a-2")]);
		vi.spyOn(console, "error").mockImplementation(() => {});

		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => {
				throw new Error("disk error");
			}),
			targetFor(a.path)
		);

		// The permanence invariant: Handwriting never deletes ink it could not
		// first preserve.
		expect(ids(a.strokes())).toEqual(["a-1", "a-2"]);
		// The lane reached the same green by lowercasing the EXPECTATION alone,
		// which is correct for today's casing and breaks again if it moves.
		// `told()` folds both sides, so this asserts what the refusal says
		// rather than how it happens to be capitalised.
		expect(told()).toContain("nothing was deleted");
	});

	it("a backup that SUCCEEDS lets the wipe run, and names the copy", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);

		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => TRASH, copyOf(a.path)),
			targetFor(a.path)
		);

		expect(ids(a.strokes())).toEqual([]);
		expect(told()).toContain(TRASH);
	});

	// ---- Ruled 17:29: the backup that came back has to be verified ---------

	it("a backup that returns NO path stops the wipe: a non-empty note needs a real copy", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);

		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => null),
			targetFor(a.path)
		);

		expect(ids(a.strokes()), "nothing was preserved, so nothing may be cleared").toEqual(["a-1"]);
		expect(told()).not.toContain("removed");
	});

	it("a backup holding DIFFERENT ink stops the wipe, and the copy is kept", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		vi.spyOn(console, "error").mockImplementation(() => {});

		// The path comes back and the file exists - it just is not this note's
		// ink. A return value alone cannot certify that; only a readback can.
		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => TRASH, () => {
				const page = emptyPage(inlineInk.pageIdOf(a.path) ?? "unknown");
				page.surface = "inline";
				page.strokes = [stroke("somebody-elses-ink")];
				return serializePage(page);
			}),
			targetFor(a.path)
		);

		expect(ids(a.strokes())).toEqual(["a-1"]);
		expect(told()).not.toContain("removed");
	});

	it("ink that changes during the await stops the wipe, even under the SAME id", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);

		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => {
				// Readiness stays true throughout; only the content moves, and
				// it keeps its id, so an id-or-count comparison would miss it.
				// `moveStrokes` translates the record's LIVE stroke objects in
				// place, which is the mutation the note store's own comments
				// call out as invisible to anything but full content.
				inlineInk.moveStrokes(a.path, ["a-1"], 25, 25);
				return TRASH;
			}, copyOf(a.path)),
			targetFor(a.path)
		);

		expect(ids(a.strokes()), "the note still holds its ink").toEqual(["a-1"]);
		expect(told()).not.toContain("removed");
	});

	it("a SUB-CODEC edit during the await stops it too: the current check is unrounded", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);

		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => {
				// Smaller than the persisted codec can represent. A comparison
				// at saved precision would call this "unchanged" and clear ink
				// the copy does not describe.
				inlineInk.moveStrokes(a.path, ["a-1"], 0.0004, 0);
				return TRASH;
			}, copyOf(a.path)),
			targetFor(a.path)
		);

		expect(ids(a.strokes())).toEqual(["a-1"]);
		expect(told()).not.toContain("removed");
	});

	// ---- Ruled 18:34: ABA ------------------------------------------------------

	/**
	 * REMOVE AND RE-ADD OF IDENTICAL INK DURING THE AWAIT, which is the one
	 * change no content comparison can see - because there is no difference to
	 * see. The strokes afterwards are byte-for-byte what the capture recorded.
	 *
	 * What changed is the operation, not the ink. The wipe the user confirmed
	 * was authorized against a drawing that has since been taken apart and put
	 * back; the history entry it would bury is no longer the history it was
	 * agreed to, and the undo the success notice promises would land on a stack
	 * that has moved underneath it.
	 *
	 * This case is deliberately arranged so that EVERY OTHER GUARD PASSES:
	 * readiness stays ready, the page id and record identity are unchanged, the
	 * backup is real and its readback matches the capture exactly. The
	 * generation counter is the only thing standing between this and a wipe.
	 */
	it("ABA: ink removed and re-added identical during the await is REFUSED on generation alone", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		const depth = undoDepth(a.state());

		const before = inlineInk.captureDeleteAll(a.path);
		const files = new Map<string, string>();

		const plugin = withVault({
			store: {
				preserve: async () => {
					// The ABA itself: taken out and put back at the same index,
					// with the same stroke object. Two mutations, so the counter
					// moves twice, and the content lands exactly where it was.
					const removed = inlineInk.applyRemove(a.path, ["a-1"]);
					inlineInk.applyAdd(
						a.path,
						removed.map((r) => r.stroke),
						removed.map((r) => r.index)
					);
					files.set(TRASH, copyOf(a.path)());
					return TRASH;
				},
			},
			app: {
				vault: {
					adapter: {
						read: async (at: string) => {
							const text = files.get(at);
							if (text === undefined) throw new Error(`no such file: ${at}`);
							return text;
						},
					},
				},
			},
		}) as unknown as HandwritingPlugin;

		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(plugin, targetFor(a.path));

		const after = inlineInk.captureDeleteAll(a.path);

		// THE GENERATION MOVED AND THE CONTENT DID NOT. Both halves are asserted
		// because the case is only meaningful if the content really is
		// identical - otherwise it is just another content-change case wearing a
		// different name.
		expect(after!.generation, "the counter saw the remove and the re-add").not.toBe(
			before!.generation
		);
		expect(
			JSON.stringify(after!.targets),
			"and the ink itself is unchanged, which is the whole difficulty"
		).toBe(JSON.stringify(before!.targets));

		// So the wipe is refused, on the counter alone.
		expect(ids(a.strokes())).toEqual(["a-1"]);
		expect(told()).not.toContain("removed");

		// THE COMPLETED BACKUP STAYS. Preservation had already run and written a
		// real generation of real ink; a late refusal does not go back and tidy
		// it away, because "no trash copy" stopped being true the moment the
		// copy landed.
		expect(files.get(TRASH), "the copy preserve made is still there").toBeDefined();

		// And the refused command adds no undo step of its own. The remove and
		// the re-add are the user's own gestures and keep whatever history they
		// earned; this is only about the entry the wipe would have pushed.
		expect(undoDepth(a.state())).toBe(depth);
	});

	// ---- the codec is not idempotent over the FILE ----------------------------

	/**
	 * THE BACKUP CHECK COMPARES TWO DIFFERENT THINGS AND ASSUMED THEY WERE ONE.
	 *
	 * `preserve` copies the sidecar's BYTES (`PageStore.ts:1469` reads the file
	 * and writes it to the trash). The capture, by contrast, is memory - and
	 * memory came from `parsePage`, which INVENTS values for fields the file
	 * does not carry: `PageData.ts:813` is `createdAt: num(s.createdAt) ??
	 * Date.now()`.
	 *
	 * So for a stroke whose file has no `createdAt`, memory holds the value
	 * stamped when the note opened and the readback holds the value stamped at
	 * delete time. They never agree, so the copy is judged wrong and the wipe
	 * is refused - not once, but on every press, forever.
	 *
	 * AND THE REFUSAL IS NOT FREE. It happens AFTER `preserve` has written a
	 * trash generation, which is kept on purpose, and `freeTrashPath` has no
	 * cap. A user pressing a button that silently does nothing gets one more
	 * file every time they press it.
	 *
	 * REACH: every shipped writer since v0.2.0 writes `createdAt`, so this takes
	 * a foreign, hand-edited or tool-merged sidecar. Rare - but the next
	 * non-deterministic parser default reopens it for everyone, which is why the
	 * fix is not to name this one field.
	 */
	/** A correct copy of the note's ink, from a writer that stored no `createdAt`. */
	function copyWithoutCreatedAt(path: string): () => string {
		return () => {
			const raw = JSON.parse(copyOf(path)()) as { strokes: Array<Record<string, unknown>> };
			for (const s of raw.strokes) delete s.createdAt;
			return JSON.stringify(raw);
		};
	}

	it("a copy of a file that never stored `createdAt` is still this note's ink, and the wipe runs", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);

		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => TRASH, copyWithoutCreatedAt(a.path)),
			targetFor(a.path)
		);

		// The artifact holds every stroke, point and colour the capture holds.
		// The only difference is a field the FILE never had, which no copy of
		// that file could have carried and which the parser will re-invent on
		// restore exactly as it invented it on open.
		expect(ids(a.strokes()), "the copy is good, so the ink goes").toEqual([]);
		expect(told()).toContain("removed");
	});

	it("a returned path that is BLANK is not a location, and stops the wipe", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);

		// Not null - a string, and a useless one. "Non-null" is not the same
		// question as "a real place a copy is at", and only the second one
		// makes it safe to destroy the original.
		//
		// THE BYTES ARE DELIBERATELY READABLE AT THAT BLANK PATH. My first
		// version of this case left them absent, so the read threw and the
		// command refused for the wrong reason - it passed against a build with
		// no blank-path check at all. Making the copy retrievable means the
		// only thing left that can refuse is the path test itself.
		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => "   ", copyOf(a.path)),
			targetFor(a.path)
		);

		expect(ids(a.strokes())).toEqual(["a-1"]);
		expect(told()).not.toContain("removed");
	});

	it("an artifact that declares NO page id is refused, not fixed up by the parser", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		vi.spyOn(console, "error").mockImplementation(() => {});

		// The bytes are otherwise a perfect copy; they simply never say WHICH
		// page they belong to. `parsePage` would substitute the id we pass it -
		// the captured one - so the identity check would compare that id
		// against itself and pass. The raw preflight is what stops it.
		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => TRASH, () => {
				const raw = JSON.parse(copyOf(a.path)()) as Record<string, unknown>;
				delete raw.pageId;
				return JSON.stringify(raw);
			}),
			targetFor(a.path)
		);

		expect(ids(a.strokes()), "bytes that never named this page are not its backup").toEqual([
			"a-1",
		]);
		expect(told()).not.toContain("removed");
	});

	it("an artifact declaring a DIFFERENT page id is refused", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		vi.spyOn(console, "error").mockImplementation(() => {});

		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => TRASH, () => {
				const raw = JSON.parse(copyOf(a.path)()) as Record<string, unknown>;
				raw.pageId = "some-other-note";
				return JSON.stringify(raw);
			}),
			targetFor(a.path)
		);

		expect(ids(a.strokes())).toEqual(["a-1"]);
		expect(told()).not.toContain("removed");
	});

	it.each([
		["null", null],
		["a string", "1700000000000"],
		["NaN-ish", "not a time"],
	])("a `createdAt` that is PRESENT but unreadable (%s) is invented too, so the wipe runs", async (
		_name,
		bad
	) => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);

		// THE CONDITION THE FIRST FIX MISSED. It skipped the field when the key
		// was ABSENT, but the parser does not invent on absence - it invents
		// whenever `num()` cannot read the value. A present-but-unreadable
		// timestamp is stamped with `Date.now()` exactly like a missing one, so
		// memory and the readback disagree forever and every press leaves
		// another trash generation behind.
		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => TRASH, () => {
				const raw = JSON.parse(copyOf(a.path)()) as {
					strokes: Array<Record<string, unknown>>;
				};
				for (const s of raw.strokes) s.createdAt = bad;
				return JSON.stringify(raw);
			}),
			targetFor(a.path)
		);

		expect(ids(a.strokes()), "an unreadable timestamp is not this note's ink changing").toEqual(
			[]
		);
		expect(told()).toContain("removed");
	});

	it("PAIRED: a `createdAt` the file DOES carry is still compared, and a wrong one refuses", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		vi.spyOn(console, "error").mockImplementation(() => {});

		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => TRASH, () => {
				const raw = JSON.parse(copyOf(a.path)()) as {
					strokes: Array<Record<string, unknown>>;
				};
				// PRESENT, and wrong. The case above must not be read as
				// "createdAt is never checked" - it is checked whenever the
				// artifact has an opinion about it.
				for (const s of raw.strokes) s.createdAt = 999_999;
				return JSON.stringify(raw);
			}),
			targetFor(a.path)
		);

		expect(ids(a.strokes())).toEqual(["a-1"]);
		expect(told()).not.toContain("removed");
	});

	it("PAIRED: omitting `createdAt` does not excuse the rest - a moved point still refuses", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		vi.spyOn(console, "error").mockImplementation(() => {});

		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => TRASH, () => {
				const raw = JSON.parse(copyOf(a.path)()) as {
					strokes: Array<Record<string, unknown>>;
				};
				for (const s of raw.strokes) {
					delete s.createdAt;
					// Whatever the artifact DOES carry is compared in full.
					s.color = "#ff0000";
				}
				return JSON.stringify(raw);
			}),
			targetFor(a.path)
		);

		expect(ids(a.strokes())).toEqual(["a-1"]);
		expect(told()).not.toContain("removed");
	});

	/**
	 * THE ALARM ON THE LIST, because the list is the part that goes stale.
	 *
	 * `PARSER_INVENTED_STROKE_FIELDS` names the fields the comparison is
	 * allowed to skip. Adding a second clock-defaulted field to `parsePage`
	 * without adding it there would silently reopen the refuse-forever bug, so
	 * this parses ONE sidecar under two different clocks and requires the
	 * fields that disagree to be exactly that set - no more, and no fewer.
	 *
	 * The two clocks are the whole method. Two parses in the same millisecond
	 * agree by accident and this case would pass while proving nothing.
	 */
	it("GUARD: the fields two parses of one file disagree about are exactly the declared set", () => {
		const page = emptyPage("invented-probe");
		page.surface = "inline";
		page.strokes = [stroke("probe-1")];
		const raw = JSON.parse(serializePage(page)) as {
			strokes: Array<Record<string, unknown>>;
		};
		// EVERY OPTIONAL FIELD MADE UNREADABLE, not a named three.
		//
		// The first version of this probe deleted `createdAt`, `device` and
		// `page` and nothing else - so it could only ever catch a new clock
		// default on one of those. A `Date.now()` added to `color`, to `width`,
		// or inside the point payload would have left this GREEN while the
		// comparison began refusing correct backups, which is precisely the
		// failure the case exists to prevent. Anything the stroke still needs
		// in order to survive the parse at all is kept: its id, and its points.
		const REQUIRED = new Set(["id", "pts", "ptsd", "points"]);
		for (const s of raw.strokes) for (const f of Object.keys(s)) if (!REQUIRED.has(f)) delete s[f];
		const text = JSON.stringify(raw);

		const clock = vi.spyOn(Date, "now");
		clock.mockReturnValue(1_000_000);
		const first = parsePage(text, "invented-probe").data.strokes[0]! as unknown as Record<
			string,
			unknown
		>;
		clock.mockReturnValue(2_000_000);
		const second = parsePage(text, "invented-probe").data.strokes[0]! as unknown as Record<
			string,
			unknown
		>;

		const differ = Object.keys(first).filter(
			(k) => JSON.stringify(first[k]) !== JSON.stringify(second[k])
		);
		expect(differ.sort()).toEqual(Object.keys(PARSER_INVENTED_STROKE_FIELDS).sort());
	});

	it("GUARD: the declared predicates agree with what the parser actually invents", () => {
		// The set being right is one claim; each predicate answering correctly
		// for a PRESENT but unreadable value is another, and it is the one the
		// first fix got wrong. `null`, a string and NaN must all read as
		// "invented", while a real number must not.
		for (const [field, wouldInvent] of Object.entries(PARSER_INVENTED_STROKE_FIELDS)) {
			expect(wouldInvent(undefined), `${field}: absent is invented`).toBe(true);
			expect(wouldInvent(null), `${field}: null is invented`).toBe(true);
			expect(wouldInvent("1700000000000"), `${field}: a string is invented`).toBe(true);
			expect(wouldInvent(Number.NaN), `${field}: NaN is invented`).toBe(true);
			expect(wouldInvent(1_700_000_000_000), `${field}: a real value is NOT`).toBe(false);
			expect(wouldInvent(0), `${field}: zero is a real value`).toBe(false);
		}
	});

	// ---- Ruled 18:21: the refusal has a reporting path, and no copy ---------

	/**
	 * EVERY REFUSAL HAS A NAMED REASON, A CALL SITE, AND NOW ALAN'S SENTENCE.
	 *
	 * THIS CASE USED TO ASSERT THE OPPOSITE - that every entry was null - and
	 * it was re-pointed rather than deleted, because its job never was "the
	 * table is empty". Its job is that no wording reaches a user without having
	 * been approved. It did that by failing the moment an entry stopped being
	 * null; it does the same job now by failing the moment an entry stops being
	 * the approved sentence.
	 *
	 * SO A VARIANT FAILS HERE. A shortened version, a per-reason flavour, a
	 * tidied one - each of those is new copy, and each reds this case by name.
	 * That is deliberate: the ruling was one sentence for all of them.
	 *
	 * The union and the table cannot drift apart either - the table is typed
	 * `Record<DeleteAllRefusal, ...>`, so a new reason without an entry is a
	 * build error rather than a silent refusal.
	 */
	it("A NOTE NEVER INKED, through the command: Alan's second sentence and nothing else", async () => {
		// THE PREMISES ARE STATED, NOT RESTED ON. An earlier version of this
		// case leaned on the note being absent from `byPath`, and absence alone
		// is not this case: it is also what a deleted or renamed-away note
		// looks like. What makes this the never-inked note is that the file
		// EXISTS, a real host is configured, and its metadata is AVAILABLE and
		// simply carries no ink id.
		const path = `never-inked-${++serial}.md`;
		paths.add(path);
		const sidecars = attachHost();
		const target = targetFor(path);

		expect(vaultFiles.get(path), "the file exists in the vault").toBeDefined();
		expect(inlineInk.hasHost(), "a real inline host is configured").toBe(true);
		expect(
			(sidecars as unknown as { meta: Map<string, string> }).meta.get(path),
			"metadata is available and carries no ink id"
		).toBeUndefined();
		expect(inlineInk.inkPresence(path), "so presence is a qualified none").toBe("none");

		let preserveCalled = false;
		const stub = withVault({
			store: {
				preserve: async () => {
					preserveCalled = true;
					return null;
				},
			},
		}) as unknown as Record<string, unknown>;

		// THROUGH THE REGISTERED COMMAND'S OWN ENTRY POINT, not straight into
		// the confirmed wipe: the entry is where the capture is made, and a
		// case that skips it cannot show the capture happening.
		(
			stub as unknown as { deleteAllInkOrSaySo(p: string): void }
		).deleteAllInkOrSaySo.call(stub, path);

		expect(notices.list).toEqual([DELETE_ALL_NO_INK]);
		expect(preserveCalled, "no preservation").toBe(false);
		expect(ids(inlineInk.strokes(path)), "no clear").toEqual([]);

		// And the confirmed arm refuses the same note for the same reason,
		// rather than being reached at all.
		notices.list.length = 0;
		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(stub, target);
		expect(preserveCalled, "still no preservation").toBe(false);
	});

	it("A REFUSAL ACTUALLY SPEAKS: the sentence reaches the user, once, before anything is written", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);

		// A pre-write refusal: preservation returns no path, so nothing has
		// been written and the sentence must not imply a copy exists. It does
		// not - which is why one sentence can serve both halves.
		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => null),
			targetFor(a.path)
		);

		// THE TABLE BEING RIGHT IS NOT THE SAME CLAIM AS THE USER BEING TOLD,
		// and only this asserts the second one. Without it the approved string
		// could sit in the table, unreached, and every table test would pass.
		expect(notices.list).toEqual([DELETE_ALL_REFUSED]);
		expect(ids(a.strokes())).toEqual(["a-1"]);
	});

	it("a refusal AFTER the copy was written says the TEMPORARY sentence, and still no copy", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		vi.spyOn(console, "error").mockImplementation(() => {});

		// `backup-unverified` - one of the four Alan ruled temporary, and one of
		// the three that HAS written a trash generation by this point. It says
		// so is not: he was shown the copy-kept variant and passed over it.
		await (HandwritingPlugin.prototype as unknown as Deleter).deleteAllInk.call(
			pluginWith(async () => TRASH, () => {
				const page = emptyPage(inlineInk.pageIdOf(a.path) ?? "unknown");
				page.surface = "inline";
				page.strokes = [stroke("somebody-elses-ink")];
				return serializePage(page);
			}),
			targetFor(a.path)
		);

		expect(notices.list).toEqual([DELETE_ALL_TEMPORARY]);
		// The trash generation exists and is retained - and is NOT mentioned.
		expect(notices.list.join(" ").toLowerCase()).not.toContain("copy");
		expect(ids(a.strokes())).toEqual(["a-1"]);
	});

	it("every refusal reason carries the approved sentence FOR THAT REASON, and no variant", () => {
		// EXHAUSTIVE AND BY NAME, because there are two approved strings now and
		// "every entry is one of them" would stop distinguishing which. That is
		// the vacuous shape: it would pass with the never-inked sentence wired
		// to a note full of ink, which is the exact error the second string was
		// approved to fix.
		const expected: Record<string, string> = {
			"locked-future": DELETE_ALL_REFUSED,
			"locked-duplicate": DELETE_ALL_REFUSED,
			"locked-legacy": DELETE_ALL_REFUSED,
			"locked-transient":
				"Handwriting: this note's ink file could not be read yet. New ink on it is not saved until it loads.",
			"unknown-readiness": DELETE_ALL_NO_INK,
			"unknown-holds-ink": DELETE_ALL_REFUSED,
			"no-capture": DELETE_ALL_REFUSED,
			"backup-missing": DELETE_ALL_REFUSED,
			// Renamed, deleted or replaced. NOT temporary: this note is not
			// coming back in a moment, so it must not borrow that sentence.
			"target-lost": DELETE_ALL_REFUSED,
			// The four Alan ruled temporary on 2026-09-09.
			"unsettled-record": DELETE_ALL_TEMPORARY,
			"readiness-lost": DELETE_ALL_TEMPORARY,
			"changed-during-backup": DELETE_ALL_TEMPORARY,
			"backup-unverified": DELETE_ALL_TEMPORARY,
		};

		// A new reason with no expectation here fails rather than defaulting.
		expect(DELETE_ALL_REFUSALS.slice().sort()).toEqual(Object.keys(expected).sort());
		for (const reason of DELETE_ALL_REFUSALS) {
			expect(deleteAllRefusalText(reason), `wording for ${reason}`).toBe(expected[reason]);
		}

		// EACH SCOPED STRING IS PINNED TO ITS EXACT SET, both directions. "Every
		// reason has one of the three" would pass with any of them on the wrong
		// reason, which is the vacuous shape this test has already been fixed
		// out of once.
		const carrying = (text: string): string[] =>
			DELETE_ALL_REFUSALS.filter((r) => deleteAllRefusalText(r) === text).sort();

		expect(carrying(DELETE_ALL_NO_INK), "never-inked: one reason only").toEqual([
			"unknown-readiness",
		]);
		expect(carrying(DELETE_ALL_TEMPORARY), "temporary: the four he was shown").toEqual([
			"backup-unverified",
			"changed-during-backup",
			"readiness-lost",
			"unsettled-record",
		]);
		expect(carrying(DELETE_ALL_REFUSED), "the rest keep the general sentence").toEqual([
			"backup-missing",
			"locked-duplicate",
			"locked-future",
			"locked-legacy",
			"no-capture",
			"target-lost",
			"unknown-holds-ink",
		]);

		// AND NOT ONE OF THEM MENTIONS A COPY. He was offered the copy-kept
		// variant for the three temporary reasons that keep a trash generation
		// and passed over it, so this is scope, not style.
		for (const reason of DELETE_ALL_REFUSALS) {
			expect(deleteAllRefusalText(reason)!.toLowerCase(), `${reason} claims no copy`).not.toContain(
				"copy"
			);
		}
	});

	/**
	 * THE PUNCTUATED FORM APPEARS NOWHERE IN SHIPPED CODE.
	 *
	 * The map above cannot protect this. `deleteAllInkNow` speaks on the
	 * ORDINARY path - a note with no ink, no refusal, no reporter - so its
	 * notice is not a reason key and nothing in that table sees it.
	 *
	 * AND THE DIRECTION OF THIS ASSERTION IS ITSELF A CORRECTION. It was
	 * written the other way round, against the bare form, on the reading that
	 * the period was approved and the second site had drifted from it. That
	 * was backwards: Alan's words this morning had NO period, we added one when
	 * the string was formed, and his "yes, correct you got it" was given to the
	 * form he was shown. Seeing it later beside the bare version he ruled "no
	 * period" (2026-09-09 16:58). The drift was ours, and the bare sentence was
	 * always his.
	 *
	 * So the hazard is the opposite of what it looked like: a reader who tidies
	 * the missing period back in is re-introducing OUR error, and it would pass
	 * review by resemblance because the result looks like approved copy.
	 *
	 * A CONSTANT USED TWICE IS NOT THE GUARANTEE. The guarantee is that the
	 * un-approved form cannot reappear - by a re-type, or by a rebase
	 * resurrecting an older generation of this file, both of which have
	 * happened to this branch tonight.
	 *
	 * CODE ONLY, through the shared `codeOnly`, so the comments that
	 * legitimately QUOTE the punctuated form while explaining this history -
	 * including the marker beside the constant itself - cannot fail it. A guard
	 * a comment can defeat is no guard.
	 */
	it("no unpunctuated form of Alan's three sentences exists in shipped code", () => {
		const shipped = Object.entries(ALL_TS).filter(
			([path]) => !path.includes(".test.") && !path.endsWith("CodeOnly.ts")
		);
		expect(shipped.length, "the glob found the source tree").toBeGreaterThan(20);

		// A LITERAL TABLE, NOT A DERIVATION. Both the approved text and the
		// bare form it must not appear as are written out here. A needle
		// computed FROM the constant it guards moves with the constant and is
		// green whichever way the rule points - that flaw was caught by its own
		// control on this file and it does not care about the direction of the
		// ruling, which has now reversed twice.
		const RULED: Array<{ name: string; approved: string; bare: string }> = [
			{
				name: "DELETE_ALL_REFUSED",
				approved: "Handwriting: your ink cannot be deleted.",
				bare: "Handwriting: your ink cannot be deleted\"",
			},
			{
				name: "DELETE_ALL_NO_INK",
				approved: "Handwriting: no ink on this note.",
				bare: "Handwriting: no ink on this note\"",
			},
			{
				name: "DELETE_ALL_TEMPORARY",
				approved: "Handwriting: your ink cannot be deleted right now. try again in a moment.",
				bare: "Handwriting: your ink cannot be deleted right now. try again in a moment\"",
			},
		];
		const live: Record<string, string> = {
			DELETE_ALL_REFUSED,
			DELETE_ALL_NO_INK,
			DELETE_ALL_TEMPORARY,
		};

		for (const { name, approved, bare } of RULED) {
			// The constant is what the table says it is - checked against a
			// literal, so this cannot pass by comparing the value to itself.
			expect(live[name], `${name} is the approved sentence`).toBe(approved);

			const offenders = shipped
				.filter(([, src]) => codeOnly(src).includes(bare))
				.map(([path]) => path);
			expect(offenders, `the trailing period was stripped from ${name}`).toEqual([]);
		}

		// PINNED BY NAME, NOT AS A RULE ABOUT ALL APPROVED COPY. "Every
		// approved string ends in a period" is FALSE: the trash-restore line is
		// ruled bare, because it ends in a file path where a period reads as
		// part of the path. It belongs to another owner and nothing here may
		// force it to match these three.

		// The internal period in the temporary sentence is NOT a trailing one
		// and never moved through either reversal: without it the two sentences
		// run together into something he did not write.
		expect(DELETE_ALL_TEMPORARY).toContain("right now. try again");
	});
});

// ---- the returned artifact, against a REAL store ----------------------------

/**
 * THE PRECEDING BLOCK STUBS PRESERVATION; THIS ONE DOES NOT.
 *
 * A stub that answers with a path and a string is a claim about a file. Here a
 * real `PageStore` writes a real trash generation through a map-backed
 * `FakeAdapter`, the command reads it back through that same adapter, and every
 * read is logged - so "the copy was verified" is checked against bytes that a
 * real preservation put on a real (fake) disk, at the path preserve returned.
 *
 * THE TRASH WRITE CAN BE HELD OPEN. `preserve` reads the live sidecar and then
 * writes those bytes to the trash; pausing between the two freezes a CORRECT
 * backup while live ink is mutated behind it. That is the only arrangement in
 * which a refusal can be attributed to the final synchronous requalification
 * rather than to a backup that merely disagreed - and the earlier stubbed
 * version of that case could not tell those apart.
 */
describe("the returned artifact, against a real store", () => {
	class GateAdapter extends FakeAdapter {
		pauseTrash = false;
		/**
		 * Corrupt the copy AS IT IS WRITTEN, rather than rewriting the file
		 * afterwards. Rewriting after the fact races the command's own readback
		 * and can land either side of it; this cannot.
		 */
		rewriteTrash: ((bytes: string) => string) | null = null;
		private release: (() => void) | null = null;
		private arrived: (() => void) | null = null;
		/** Resolves once a paused trash write has read its bytes and stopped. */
		whenHeld(): Promise<void> {
			return new Promise((r) => (this.arrived = r));
		}
		letGo(): void {
			this.release?.();
			this.release = null;
		}
		override async write(path: string, bytes: string): Promise<void> {
			if (path.includes("/trash/")) {
				if (this.pauseTrash) {
					this.pauseTrash = false;
					const gate = new Promise<void>((r) => (this.release = r));
					this.arrived?.();
					await gate;
				}
				if (this.rewriteTrash) bytes = this.rewriteTrash(bytes);
			}
			await super.write(path, bytes);
		}
	}

	interface RealRig {
		path: string;
		pageId: string;
		adapter: GateAdapter;
		store: PageStore;
		plugin: HandwritingPlugin;
		/** Every path the COMMAND read back, in order. */
		reads: string[];
		state: () => EditorState;
		dispatch: (input: Transaction | TransactionSpec) => void;
		strokes: () => readonly InkStroke[];
		deleteAll: () => Promise<void>;
		liveSidecar: () => string | undefined;
		trashFiles: () => Array<[string, string]>;
	}

	/**
	 * `unknownByObject` is a REQUIRED option with no default, deliberately. A
	 * fixture that quietly falls back to "no unknown keys" builds the easy case
	 * under a test name promising the hard one - and the per-stroke unknown
	 * comparison is precisely what had no fixture at all before this block.
	 */
	async function realNote(
		initial: InkStroke[],
		unknownByObject: Record<string, Record<string, unknown>>
	): Promise<RealRig> {
		const n = ++serial;
		const path = `real-delete-${n}.md`;
		const pageId = `real-delete-id-${n}`;
		paths.add(path);

		const adapter = new GateAdapter();
		const store = new PageStore({ vault: { adapter } } as never);
		const page = emptyPage(pageId);
		page.surface = "inline";
		page.strokes = initial;
		page.unknownByObject = unknownByObject;
		await adapter.externalWrite(`.handwriting/${pageId}.json`, serializePage(page));

		inlineInk.attachHost({
			readPageId: () => pageId,
			claimId: async (_p: string, id: string) => ({ pageId: id }),
			loadSidecar: (id: string) => store.load(id),
			scheduleSidecar: (id: string, data: PageData) => store.schedule(id, data),
			notify: (message: string) => notices.list.push(message),
		} as unknown as InlineInkHost);
		await inlineInk.ensureLoaded(path);

		let state = EditorState.create({
			doc: "note body",
			extensions: [history(), inkHistorySupport()],
		});
		const view = {
			get state() {
				return state;
			},
			dispatch(input: Transaction | TransactionSpec) {
				const tr = input instanceof Transaction ? input : state.update(input);
				state = tr.state;
				for (const effect of tr.effects) {
					if (effect.is(inkEffect) && !tr.annotation(inkApplied)) {
						(overlay as unknown as { applyInkOp(op: unknown): void }).applyInkOp(effect.value);
					}
				}
			},
		};
		const overlay = new InkOverlayPlugin(view as never);
		Object.assign(overlay, {
			filePath: () => path,
			selection: { clear() {}, prune() {} },
			scheduleRepaint() {},
			repaintPath() {},
			redrawSelectionUI() {},
			unmount() {},
		});
		teardown.push(() => (overlay as unknown as { destroy(): void }).destroy());

		const reads: string[] = [];
		const plugin = withVault({
			store,
			app: {
				vault: {
					adapter: {
						read: async (p: string) => {
							reads.push(p);
							return adapter.read(p);
						},
					},
				},
			},
		}) as unknown as HandwritingPlugin;

		return {
			path,
			pageId,
			adapter,
			store,
			plugin,
			reads,
			state: () => state,
			dispatch: (input) => view.dispatch(input),
			strokes: () => inlineInk.strokes(path),
			deleteAll: () =>
				(HandwritingPlugin.prototype as unknown as Deleter3).deleteAllInk.call(plugin, targetFor(path)),
			liveSidecar: () => adapter.files.get(`.handwriting/${pageId}.json`),
			trashFiles: () => [...adapter.files.entries()].filter(([p]) => p.includes("/trash/")),
		};
	}

	/** A stroke with geometry the persisted codec cannot represent exactly. */
	function fineStroke(id: string): InkStroke {
		const s = stroke(id);
		s.width = 2.00047;
		s.points = [
			{ x: 0.00041, y: 0, pressure: 0.5, t: 0 },
			{ x: 10.00042, y: 10, pressure: 0.5, t: 8 },
		];
		return s;
	}

	it("THE POSITIVE, full precision and end to end: one clear, a real copy, and a real undo", async () => {
		const r = await realNote([fineStroke("keep-1")], { "keep-1": { "vendor:note": { a: 1 } } });

		// An unrounded stroke committed into the session and NOT yet flushed,
		// so preserve's own flush is part of what is under test.
		const queued = fineStroke("keep-2");
		inlineInk.commit(r.path, queued);
		r.dispatch({ effects: inkEffect.of({ type: "add", path: r.path, strokes: [queued] }) });
		expect(r.strokes()).toHaveLength(2);
		const depthBefore = undoDepth(r.state());

		await r.deleteAll();
		await r.store.flush();

		// The ink is gone, once, and the notice names the copy.
		expect(ids(r.strokes())).toEqual([]);
		expect(told()).toContain("removed 2 strokes");
		expect(notices.list.filter((m) => m.includes("removed")).length).toBe(1);

		// THE COPY IS REAL AND WAS READ AT THE PATH PRESERVE RETURNED.
		const trash = r.trashFiles();
		expect(trash).toHaveLength(1);
		expect(r.reads, "the command read back exactly the returned path").toEqual([trash[0]![0]]);

		// And it holds BOTH strokes, including the one that was still queued.
		const kept = parsePage(trash[0]![1], r.pageId);
		expect(kept.damaged, "a clean parse leaves `damaged` unset").toBeFalsy();
		expect(kept.data.strokes.map((s) => s.id)).toEqual(["keep-1", "keep-2"]);
		expect(kept.data.unknownByObject["keep-1"]).toEqual({ "vendor:note": { a: 1 } });

		// The live sidecar is flushed and empty - the wipe reached disk.
		const live = parsePage(r.liveSidecar() ?? "", r.pageId);
		expect(live.data.strokes).toEqual([]);

		// And a REAL undo, through real CodeMirror history, brings it back.
		expect(undoDepth(r.state())).toBeGreaterThan(depthBefore);
		expect(undo({ state: r.state(), dispatch: r.dispatch })).toBe(true);
		expect(ids(r.strokes()).sort()).toEqual(["keep-1", "keep-2"]);
	});

	it("a sub-codec change to LIVE ink refuses, even though the backup bytes are correct", async () => {
		const r = await realNote([fineStroke("a-1")], {});
		const before = serializePage({
			...(parsePage(r.liveSidecar() ?? "", r.pageId).data as PageData),
		});

		// Hold the trash write open AFTER preserve has read the live bytes, so
		// the copy that lands is the correct pre-mutation one.
		r.adapter.pauseTrash = true;
		const held = r.adapter.whenHeld();
		const running = r.deleteAll();
		await held;

		// One interior point, below what the codec stores. Id, order, count and
		// bbox are untouched, so nothing coarser than the exact check can see it.
		const live = inlineInk.strokes(r.path)[0]!;
		const bboxBefore = JSON.stringify(live.bbox);
		live.points[0]!.x += 0.00004;
		expect(JSON.stringify(live.bbox), "the bbox is unchanged").toBe(bboxBefore);

		// ORDINARY SERIALIZED BYTES ARE STILL EQUAL - proof the mutation is
		// genuinely sub-codec, so a refusal here cannot be a rounding artifact.
		const nowPage = emptyPage(r.pageId);
		nowPage.surface = "inline";
		nowPage.strokes = [...inlineInk.strokes(r.path)];
		expect(serializePage(nowPage)).toBe(before);

		r.adapter.letGo();
		await running;
		await r.store.flush();

		// So the ONLY thing that can have refused is the final exact check.
		expect(ids(r.strokes()), "the ink stays").toEqual(["a-1"]);
		expect(told()).not.toContain("removed");
		// And the completed backup is kept, byte for byte.
		expect(r.trashFiles()).toHaveLength(1);
		expect(r.trashFiles()[0]![1]).toBe(before);
	});

	/**
	 * EVERY WAY A RETURNED ARTIFACT CAN FAIL TO BE THIS NOTE'S BACKUP.
	 *
	 * Each row corrupts the copy in exactly one way as it is written, leaving
	 * preservation, the returned path and the readback all real. The command
	 * must refuse every one of them AND keep the ink.
	 */
	const badArtifacts: Array<{ name: string; spoil: (bytes: string, pageId: string) => string }> = [
		{
			name: "per-stroke unknown content differs, on an identical known payload",
			spoil: (bytes, pageId) => {
				const page = parsePage(bytes, pageId).data;
				page.unknownByObject = { "a-1": { "vendor:keep": { v: 999 } } };
				return serializePage(page);
			},
		},
		{
			name: "the strokes are REORDERED",
			spoil: (bytes, pageId) => {
				const page = parsePage(bytes, pageId).data;
				page.strokes = [...page.strokes].reverse();
				return serializePage(page);
			},
		},
		{
			name: "the surface says pdf",
			spoil: (bytes) => {
				const raw = JSON.parse(bytes) as Record<string, unknown>;
				raw.surface = "pdf";
				return JSON.stringify(raw);
			},
		},
		{
			name: "the surface is missing entirely",
			spoil: (bytes) => {
				const raw = JSON.parse(bytes) as Record<string, unknown>;
				delete raw.surface;
				return JSON.stringify(raw);
			},
		},
		{
			name: "the bytes are malformed and parse as damaged",
			spoil: (bytes) => bytes.slice(0, Math.max(1, Math.floor(bytes.length / 2))),
		},
		{
			name: "the schema is from a NEWER Handwriting",
			spoil: (bytes) => {
				const raw = JSON.parse(bytes) as Record<string, unknown>;
				raw.schemaVersion = 999;
				return JSON.stringify(raw);
			},
		},
	];

	for (const bad of badArtifacts) {
		it(`refuses, and keeps the ink, when ${bad.name}`, async () => {
			const r = await realNote([stroke("a-1"), stroke("a-2")], {
				"a-1": { "vendor:keep": { v: 1 } },
			});
			vi.spyOn(console, "error").mockImplementation(() => {});

			r.adapter.rewriteTrash = (bytes) => bad.spoil(bytes, r.pageId);
			await r.deleteAll();
			await r.store.flush();

			expect(ids(r.strokes()), "the original is not destroyed for a bad copy").toEqual([
				"a-1",
				"a-2",
			]);
			expect(told()).not.toContain("removed");
			// The live sidecar still holds the ink too.
			const live = parsePage(r.liveSidecar() ?? "", r.pageId);
			expect(live.data.strokes.map((s) => s.id)).toEqual(["a-1", "a-2"]);
		});
	}

	it("a VISIBLE same-id move during the await is refused by the final check, not by the copy", async () => {
		const r = await realNote([stroke("a-1")], {});

		// THE TWIN OF THE STUBBED CASE, CALIBRATED. In the stubbed version the
		// backup bytes were generated AFTER the mutation, so the copy held
		// moved ink and the command refused at the backup comparison - which
		// means that case would also pass against a build with no final
		// content check at all. Holding the trash write freezes a CORRECT
		// pre-move copy, so the only thing left that can refuse is the final
		// synchronous requalification.
		// Measured, not assumed: the stored bbox is derived from the points, so
		// the baseline comes off the live sidecar rather than out of the fixture.
		const beforeX = parsePage(r.liveSidecar() ?? "", r.pageId).data.strokes[0]!.bbox.x;

		r.adapter.pauseTrash = true;
		const held = r.adapter.whenHeld();
		const running = r.deleteAll();
		await held;

		inlineInk.moveStrokes(r.path, ["a-1"], 25, 25);

		r.adapter.letGo();
		await running;
		await r.store.flush();

		expect(ids(r.strokes())).toEqual(["a-1"]);
		expect(told()).not.toContain("removed");

		// And the copy that was already made is kept, holding the PRE-move ink.
		const trash = r.trashFiles();
		expect(trash).toHaveLength(1);
		const kept = parsePage(trash[0]![1], r.pageId).data;
		expect(kept.strokes[0]!.bbox.x, "the copy is the ink as it was").toBe(beforeX);
		expect(
			inlineInk.strokes(r.path)[0]!.bbox.x,
			"and the live ink really did move, so the copy is genuinely stale"
		).toBe(beforeX + 25);
	});

	it("a DECOY beside the returned path is not mistaken for the copy", async () => {
		const r = await realNote([stroke("a-1")], {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		// A perfectly good copy of this note sits in the trash under another
		// name, while the artifact preserve actually returned is wrong. A
		// command that searched the trash instead of reading the path it was
		// given would find the decoy and clear.
		await r.adapter.externalWrite(
			".handwriting/trash/decoy-perfect.json",
			r.liveSidecar() ?? ""
		);
		r.adapter.rewriteTrash = (bytes) => {
			const page = parsePage(bytes, r.pageId).data;
			page.strokes = [];
			return serializePage(page);
		};

		await r.deleteAll();

		expect(ids(r.strokes())).toEqual(["a-1"]);
		expect(told()).not.toContain("removed");
		// It read the returned path, and only that.
		expect(r.reads.every((p) => !p.includes("decoy"))).toBe(true);
	});

	it("a read that FAILS is a refusal, not a pass", async () => {
		const r = await realNote([stroke("a-1")], {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		// Preservation succeeds and returns a real path; the file is then gone
		// before the readback reaches it. ONE rig, so the notice assertion below
		// is about this command and nothing else - an earlier version of this
		// case used two notes and had to weaken its assertion to a substring
		// that could never have matched, which proves nothing at all.
		const write = r.adapter.write.bind(r.adapter);
		(r.adapter as unknown as { write: typeof write }).write = async (p, b) => {
			await write(p, b);
			if (p.includes("/trash/")) r.adapter.files.delete(p);
		};

		await r.deleteAll();

		expect(ids(r.strokes()), "a copy that cannot be read is not a copy").toEqual(["a-1"]);
		expect(told()).not.toContain("removed");
	});

	it("a LOCK acquired during preservation stops the wipe, and the copy is kept", async () => {
		const r = await realNote([stroke("a-1")], {});

		r.adapter.pauseTrash = true;
		const held = r.adapter.whenHeld();
		const running = r.deleteAll();
		await held;

		// The note becomes unwritable while its backup is being made. The
		// final readiness re-check is what has to notice.
		const rec = (
			inlineInk as unknown as { byPath: Map<string, { futureLocked: boolean }> }
		).byPath.get(r.path)!;
		rec.futureLocked = true;

		r.adapter.letGo();
		await running;

		expect(ids(r.strokes())).toEqual(["a-1"]);
		expect(told()).not.toContain("removed");
		expect(r.trashFiles(), "the completed copy is retained").toHaveLength(1);
	});

	it("a REPLACEMENT record with the same path, page and content is refused", async () => {
		const r = await realNote([stroke("a-1")], {});

		r.adapter.pauseTrash = true;
		const held = r.adapter.whenHeld();
		const running = r.deleteAll();
		await held;

		// The note is closed and reopened during the copy: same path, same page
		// id, same ink - a different record, so a different history identity.
		// The undo the success notice promises would land in the old editor.
		inlineInk.handleDelete(r.path);
		await inlineInk.ensureLoaded(r.path);

		r.adapter.letGo();
		await running;

		expect(ids(r.strokes())).toEqual(["a-1"]);
		expect(told()).not.toContain("removed");
	});
});

type Deleter3 = { deleteAllInk(target: unknown): Promise<void> };

// ---- the note this command was invoked on is still that note ---------------

/**
 * IDENTITY BEFORE THE WIPE, on root's 2026-09-09 07:26 ruling.
 *
 * `path` is a STRING and every route to the wipe has an await in it - the
 * sidecar read, and then however long the user spends in the confirmation
 * modal. A string does not follow a rename, so by the time the delete runs it
 * can name nothing, or name somebody else's note.
 *
 * THE TRAP ROOT NAMED, and it is why presence alone is not the fix.
 * `inkPresence` answers `none` when there is no record AND the note carries no
 * page id (`InlineInkStore.ts:453`). A note renamed away has exactly that
 * shape under its old path: no record, no metadata. So `none` covers both "a
 * real empty note" and "not there any more", and swapping `hasInk` for
 * `inkPresence` would have read like the fix while leaving the seam open.
 *
 * Alan's no-ink sentence says something about a SPECIFIC note, so it needs
 * both halves: still that note, and a qualified `none`.
 */
describe("delete-all validates the note's identity, not just its path", () => {
	type Now = { deleteAllInkNow(target: unknown): void };
	type Confirmed = { confirmedDeleteAllInk(target: unknown): void };

	/** A plugin whose vault is the shared fake, with a metadata cache. */
	const plugin = (extra: object = {}): HandwritingPlugin =>
		withVault(extra) as unknown as HandwritingPlugin;

	/** A plugin whose metadata cache has nothing to say about any file. */
	function pluginWithoutMetadata(): HandwritingPlugin {
		const p = withVault({}) as unknown as { app: { metadataCache: object } };
		p.app.metadataCache = { getFileCache: () => null };
		return p as unknown as HandwritingPlugin;
	}

	it("a real, untouched, existing note with no ink says Alan's no-ink sentence", async () => {
		// The case that must keep working. This is not "refuse when in doubt":
		// a real existing file, a real host, and metadata that IS available and
		// simply carries no ink id.
		const sidecars = attachHost();
		const a = await note(sidecars, []);

		(HandwritingPlugin.prototype as unknown as Now).deleteAllInkNow.call(
			plugin(),
			targetFor(a.path)
		);

		expect(inlineInk.inkPresence(a.path), "a loaded, empty note").toBe("none");
		expect(notices.list).toEqual([DELETE_ALL_NO_INK]);
	});

	it("the same file with NO available metadata cannot claim none", async () => {
		// Absent metadata is the absence of evidence about the ink id, not
		// evidence that there is none. Same file, same host, same empty record.
		const sidecars = attachHost();
		const a = await note(sidecars, []);

		(HandwritingPlugin.prototype as unknown as Now).deleteAllInkNow.call(
			pluginWithoutMetadata(),
			targetFor(a.path)
		);

		expect(notices.list).toEqual([DELETE_ALL_REFUSED]);
	});

	it("THE TRAP: a stale renamed path reports presence `none` and must NOT get the no-ink sentence", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		const target = targetFor(a.path);

		// The rename: the SAME object moves, and the old string now names
		// nothing. Obsidian's own rename does exactly this - and the note's
		// FRONTMATTER travels with it, so the page id is no longer readable
		// under the old path either. Dropping the metadata as well as the
		// record is what makes this the real shape: leaving it behind reads as
		// `unknown`, which is a different case and would not test the trap.
		//
		// The fixture moves the VAULT, and production notices - it is not
		// handed a matching path constant for both halves.
		inlineInk.handleDelete(a.path);
		(sidecars as unknown as { meta: Map<string, string> }).meta.delete(a.path);
		const file = fileFor(a.path);
		vaultFiles.delete(a.path);
		file.path = "renamed.md";
		vaultFiles.set("renamed.md", file);

		// PRESENCE ALONE WOULD SAY "none" HERE - measured, not assumed, so the
		// case cannot be read as belt-and-braces.
		expect(inlineInk.inkPresence(a.path), "indistinguishable from an empty note").toBe("none");

		(HandwritingPlugin.prototype as unknown as Now).deleteAllInkNow.call(plugin(), target);

		expect(notices.list, "the note is gone, not empty").toEqual([DELETE_ALL_REFUSED]);
	});

	it("a DELETED note refuses rather than claiming it has no ink", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, []);
		const target = targetFor(a.path);

		vaultFiles.delete(a.path);

		(HandwritingPlugin.prototype as unknown as Now).deleteAllInkNow.call(plugin(), target);

		expect(notices.list).toEqual([DELETE_ALL_REFUSED]);
	});

	it("a REPLACED note refuses: the path resolves, but to somebody else's note", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, []);
		const target = targetFor(a.path);

		// DELETE-AND-RECREATE AT THE SAME PATH. The path is valid and a file is
		// there - it is simply a different `TFile`. Comparing paths cannot see
		// this at all, and this is the arm where getting it wrong deletes the
		// wrong note's ink.
		vaultFiles.delete(a.path);
		const impostor = fileFor(a.path);
		expect(impostor, "a genuinely different object at the same path").not.toBe(
			(target as { file: unknown }).file
		);

		(HandwritingPlugin.prototype as unknown as Now).deleteAllInkNow.call(plugin(), target);

		expect(notices.list).toEqual([DELETE_ALL_REFUSED]);
	});

	/**
	 * GROUP 2, THROUGH THE REGISTERED COMMAND, with the state the ruling names:
	 * metadata carries an ink id and the sidecar has NOT been read.
	 *
	 * An earlier version of this called the private `deleteAllInkNow` and used
	 * an unclaimed record instead, which is a different state and proves a
	 * different thing. The route matters: the command sees `unknown`, makes ONE
	 * `ensureLoaded` attempt, and requalifies the SAME capture afterwards.
	 */
	function unreadHost(id: string, sidecar: PageData | "damaged" | null): Map<string, PageData> {
		const metadata = new Map<string, string>();
		const sidecars = new Map<string, PageData>();
		inlineInk.attachHost({
			readPageId: (p: string) => metadata.get(p) ?? null,
			claimId: async (_p: string, pageId: string) => ({ pageId }),
			loadSidecar: async () =>
				sidecar === null
					? null
					: sidecar === "damaged"
						? ({ data: emptyPage(id), recovered: false, damaged: true } as never)
						: { data: sidecar, recovered: false },
			scheduleSidecar: () => {},
			notify() {},
		} as unknown as InlineInkHost);
		(sidecars as unknown as { meta: Map<string, string> }).meta = metadata;
		return sidecars;
	}

	it("GROUP 2: the command loads once, finds real ink, and opens confirmation", async () => {
		const path = `unread-ink-${++serial}.md`;
		const id = `unread-ink-id-${serial}`;
		paths.add(path);
		const page = emptyPage(id);
		page.surface = "inline";
		page.strokes = [stroke("saved-1")];
		fileFor(path);
		const sidecars = unreadHost(id, page);
		(sidecars as unknown as { meta: Map<string, string> }).meta.set(path, id);

		// The state the ruling names: an ink id in metadata, nothing read yet.
		expect(inlineInk.inkPresence(path), "unread, so unknown").toBe("unknown");

		const stub = plugin() as unknown as { deleteAllInkOrSaySo(p: string): void };
		stub.deleteAllInkOrSaySo.call(stub, path);
		await new Promise((r) => setTimeout(r, 0));

		// The empty cache never became no-ink; the load resolved to real ink
		// and the command asked before doing anything.
		expect(notices.list, "no sentence at all - it asked instead").toEqual([]);
		expect(modals.list.length, "confirmation opened").toBe(1);
	});

	it("GROUP 2: an UNRESOLVED load refuses, never becomes no-ink, and does not loop", async () => {
		const path = `unread-damaged-${++serial}.md`;
		const id = `unread-damaged-id-${serial}`;
		paths.add(path);
		fileFor(path);
		const sidecars = unreadHost(id, "damaged");
		(sidecars as unknown as { meta: Map<string, string> }).meta.set(path, id);

		expect(inlineInk.inkPresence(path)).toBe("unknown");

		const stub = plugin() as unknown as { deleteAllInkOrSaySo(p: string): void };
		stub.deleteAllInkOrSaySo.call(stub, path);
		await new Promise((r) => setTimeout(r, 0));

		// ONE attempt. Presence is still not evidence of emptiness, so the
		// command refuses rather than claiming no ink - and does not try again.
		expect(inlineInk.inkPresence(path), "still unresolved after the one attempt").toBe("unknown");
		expect(notices.list).toEqual([DELETE_ALL_REFUSED]);
		expect(modals.list.length, "nothing was confirmed").toBe(0);
	});

	it("GROUP 2: the confirmed arm refuses that same state without mutating", async () => {
		const path = `unread-confirmed-${++serial}.md`;
		const id = `unread-confirmed-id-${serial}`;
		paths.add(path);
		fileFor(path);
		const page = emptyPage(id);
		page.surface = "inline";
		page.strokes = [stroke("saved-1")];
		const sidecars = unreadHost(id, page);
		(sidecars as unknown as { meta: Map<string, string> }).meta.set(path, id);

		// The confirmed arm receives the SAME qualified target the command would
		// have captured, but the sidecar is still genuinely unread: metadata knows
		// its id while the store has no record from which readiness could be proven.
		const host = (inlineInk as unknown as { host: InlineInkHost }).host;
		const load = vi.spyOn(host, "loadSidecar");
		const write = vi.spyOn(host, "scheduleSidecar");
		let state = EditorState.create({
			doc: "note body",
			extensions: [history(), inkHistorySupport()],
		});
		const view = {
			get state() {
				return state;
			},
			dispatch(input: Transaction | TransactionSpec) {
				const tr = input instanceof Transaction ? input : state.update(input);
				state = tr.state;
				for (const effect of tr.effects) {
					if (effect.is(inkEffect) && !tr.annotation(inkApplied)) {
						(overlay as unknown as { applyInkOp(op: unknown): void }).applyInkOp(effect.value);
					}
				}
			},
		};
		const overlay = new InkOverlayPlugin(view as never);
		Object.assign(overlay, {
			filePath: () => path,
			selection: { clear() {}, prune() {} },
			scheduleRepaint() {},
			repaintPath() {},
			redrawSelectionUI() {},
			unmount() {},
		});
		teardown.push(() => (overlay as unknown as { destroy(): void }).destroy());
		const clear = vi.spyOn(overlay as unknown as Clearable, "clearAllInk");
		const historyBefore = undoDepth(
			(overlay as unknown as { view: { state: EditorState } }).view.state
		);
		const sidecarBefore = serializePage(page);
		const sessionBefore = ids(inlineInk.strokes(path));

		let preserveCalled = false;
		const stub = withVault({
			store: {
				preserve: async () => {
					preserveCalled = true;
					return null;
				},
			},
		}) as unknown as HandwritingPlugin;
		const target = (
			stub as unknown as { captureDeleteAllTarget(p: string): unknown }
		).captureDeleteAllTarget(path);

		expect(target, "production captured the vault file and path").not.toBeNull();
		expect(inlineInk.pageIdOf(path), "the sidecar has not been adopted").toBeNull();
		expect(inlineInk.inkPresence(path), "metadata id, unread sidecar").toBe("unknown");
		expect(inlineInk.deleteAllReadiness(path).kind, "confirmed entry readiness").toBe(
			"unknown"
		);

		await (HandwritingPlugin.prototype as unknown as Deleter3).deleteAllInk.call(
			stub,
			target
		);

		expect(notices.list).toEqual([DELETE_ALL_REFUSED]);
		expect(load, "the confirmed arm does not turn unknown into a load").not.toHaveBeenCalled();
		expect(preserveCalled, "no preservation").toBe(false);
		expect(clear, "no clear").not.toHaveBeenCalled();
		expect(write, "no storage write").not.toHaveBeenCalled();
		expect(
			undoDepth((overlay as unknown as { view: { state: EditorState } }).view.state),
			"no history entry"
		).toBe(historyBefore);
		expect(ids(inlineInk.strokes(path)), "no session-ink mutation").toEqual(sessionBefore);
		expect(serializePage(page), "no saved-ink mutation").toBe(sidecarBefore);
	});

	it("presence `unknown` is not `none`: an unread record is the absence of evidence", async () => {
		const sidecars = attachHost();
		const path = `unread-${++serial}.md`;
		paths.add(path);
		// A note that carries a page id but has never been read: a sidecar may
		// hold ink, and the cache being empty says nothing about it.
		const meta = (sidecars as unknown as { meta: Map<string, string> }).meta;
		meta.set(path, "unread-page-id");

		expect(inlineInk.inkPresence(path)).toBe("unknown");
		(HandwritingPlugin.prototype as unknown as Now).deleteAllInkNow.call(
			plugin(),
			targetFor(path)
		);

		expect(notices.list, "never told a note is empty on an unread cache").toEqual([
			DELETE_ALL_REFUSED,
		]);
	});

	it("NO HOST cannot claim none either: nothing looked is not nothing to find", async () => {
		const path = `hostless-${++serial}.md`;
		paths.add(path);
		// Session-memory mode. `inkPresence` answers `none` here by design, and
		// the preflight must not read that as evidence about a real note.
		(inlineInk as unknown as { host: unknown }).host = null;
		expect(inlineInk.inkPresence(path)).toBe("none");

		(HandwritingPlugin.prototype as unknown as Now).deleteAllInkNow.call(
			plugin(),
			targetFor(path)
		);

		expect(notices.list).toEqual([DELETE_ALL_REFUSED]);
	});

	it("losing the target DURING the backup keeps the backup and performs no destructive finish", async () => {
		// The backup is an await, and a rename during it leaves the path naming
		// a different note - or none. The final synchronous check before the
		// clear is the only place that can catch it, and the copy already made
		// is real ink and stays: it is neither retargeted nor removed.
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		const target = targetFor(a.path);
		const depth = undoDepth(a.state());
		const files = new Map<string, string>();
		const trashAt = ".handwriting/trash/mid-backup.json";

		await (HandwritingPlugin.prototype as unknown as Deleter3).deleteAllInk.call(
			withVault({
				store: {
					preserve: async () => {
						// A REAL copy of this note's ink is written first, so the
						// case can show it being RETAINED rather than merely absent.
						const page = emptyPage(inlineInk.pageIdOf(a.path) ?? "unknown");
						page.surface = "inline";
						page.strokes = [...inlineInk.strokes(a.path)];
						files.set(trashAt, serializePage(page));
						// Then the rename lands, while preservation is in flight.
						const file = fileFor(a.path);
						vaultFiles.delete(a.path);
						file.path = "moved-mid-backup.md";
						vaultFiles.set("moved-mid-backup.md", file);
						return trashAt;
					},
				},
				app: {
					vault: {
						adapter: {
							read: async (p: string) => {
								const text = files.get(p);
								if (text === undefined) throw new Error(`no such file: ${p}`);
								return text;
							},
						},
					},
				},
			}) as unknown as HandwritingPlugin,
			target
		);

		expect(ids(a.strokes()), "no destructive finish").toEqual(["a-1"]);
		expect(undoDepth(a.state()), "and no history entry").toBe(depth);
		expect(told()).not.toContain("removed");
		expect(files.get(trashAt), "the completed backup is retained, not removed").toBeDefined();

		// THE EXACT SENTENCE, and this is what A2 caught: the identity check
		// reported `readiness-lost`, which Alan ruled TEMPORARY, so a note that
		// had been renamed away was told to try again in a moment. It will not
		// work in a moment. The generic sentence is the true one here.
		expect(notices.list).toEqual([DELETE_ALL_REFUSED]);
		expect(notices.list, "never the temporary sentence").not.toContain(DELETE_ALL_TEMPORARY);
	});

	/**
	 * GROUP 3, END TO END, WITH NOTHING FABRICATED.
	 *
	 * The command opens the real confirmation; the real callback is kept; the
	 * note is then moved through the PRODUCTION rename route - `handleRename`
	 * on the store, and the vault and metadata with it - and only then is the
	 * button clicked.
	 *
	 * WHY THE PREVIOUS VERSION PROVED LESS THAN IT LOOKED. It built a target
	 * with `targetFor` and called the private confirmed method, so the test
	 * supplied BOTH halves of the identity comparison. A fixture that hands
	 * production the identity it is supposed to have captured cannot show the
	 * capture happening. Here production captures it at the command, and the
	 * test only moves the note.
	 */
	async function openConfirmationOn(path: string): Promise<{ wiped: () => boolean }> {
		let wipeStarted = false;
		const stub = plugin() as unknown as Record<string, unknown>;
		stub.deleteAllInk = async () => {
			wipeStarted = true;
		};
		(stub as unknown as { deleteAllInkOrSaySo(p: string): void }).deleteAllInkOrSaySo.call(
			stub,
			path
		);
		await new Promise((r) => setTimeout(r, 0));
		expect(modals.list.length, "the command opened a confirmation").toBe(1);
		return { wiped: () => wipeStarted };
	}

	it("GROUP 3: a RENAME through the production route, then the real button: refused", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		const opened = await openConfirmationOn(a.path);

		// THE PRODUCTION RENAME ROUTE, not a fixture poke: the store's own
		// handler moves the record, and the vault and metadata move with it.
		const renamed = "renamed-mid-confirm.md";
		paths.add(renamed);
		const meta = (sidecars as unknown as { meta: Map<string, string> }).meta;
		const id = meta.get(a.path)!;
		meta.delete(a.path);
		meta.set(renamed, id);
		inlineInk.handleRename(a.path, renamed);
		const file = fileFor(a.path);
		vaultFiles.delete(a.path);
		file.path = renamed;
		vaultFiles.set(renamed, file);

		clickConfirm();

		expect(opened.wiped(), "authorised against one note, never performed").toBe(false);
		expect(notices.list).toEqual([DELETE_ALL_REFUSED]);
		expect(ids(inlineInk.strokes(renamed)), "the ink moved with the note").toEqual(["a-1"]);
	});

	it("GROUP 3: DELETE AND RECREATE a different file at the same path, then the real button", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		const opened = await openConfirmationOn(a.path);

		// Same path, different `TFile`. Only object identity can see this.
		const original = vaultFiles.get(a.path);
		vaultFiles.delete(a.path);
		const recreated = fileFor(a.path);
		expect(recreated, "a genuinely different object").not.toBe(original);

		clickConfirm();

		expect(opened.wiped(), "the replacement's ink is never touched").toBe(false);
		expect(notices.list).toEqual([DELETE_ALL_REFUSED]);
		expect(ids(inlineInk.strokes(a.path))).toEqual(["a-1"]);
	});

	it("a rename DURING the confirmation refuses at the button, and dispatches no wipe", async () => {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		const target = targetFor(a.path);
		let wipeStarted = false;

		// The longest await in the command is the user. The identity is checked
		// again at the moment they click, not only when the modal opened.
		const file = fileFor(a.path);
		vaultFiles.delete(a.path);
		file.path = "renamed-while-open.md";
		vaultFiles.set("renamed-while-open.md", file);

		const stub = plugin() as unknown as Record<string, unknown>;
		stub.deleteAllInk = async () => {
			wipeStarted = true;
		};

		(HandwritingPlugin.prototype as unknown as Confirmed).confirmedDeleteAllInk.call(
			stub as unknown as HandwritingPlugin,
			target
		);

		expect(wipeStarted, "authorised against one note, never performed on another").toBe(false);
		expect(ids(a.strokes()), "and the ink is untouched").toEqual(["a-1"]);
		expect(notices.list).toEqual([DELETE_ALL_REFUSED]);
	});
});

// ---- readiness answers the state it is actually in --------------------------

/**
 * TWO STATES THE DISCRIMINATOR USED TO GET WRONG, and both are reachable.
 *
 * These reach into the record to build the state directly. That is deliberate
 * and is named rather than hidden: the production routes to them are a lock
 * marked before a claim lands, and a sidecar read still in flight, and neither
 * can be held open from outside the store. What is under test is the ANSWER
 * `deleteAllReadiness` gives about a state, not how the state arose.
 */
describe("deleteAllReadiness classifies locks and unsettled records", () => {
	type Rec = {
		pageId: string | null;
		load: string;
		reloading: boolean;
		loadInFlight: Promise<boolean> | null;
		futureLocked: boolean;
		strokes: InkStroke[];
	};
	const recordFor = (path: string): Rec =>
		(inlineInk as unknown as { byPath: Map<string, Rec> }).byPath.get(path)!;

	async function loadedNote(): Promise<{ path: string; rec: Rec }> {
		const sidecars = attachHost();
		const a = await note(sidecars, [stroke("a-1")]);
		return { path: a.path, rec: recordFor(a.path) };
	}

	it("a KNOWN LOCK is named even when the page id has not landed yet", async () => {
		const { path, rec } = await loadedNote();

		// The lock is real and the identity is not yet there. Answering
		// `unknown` here would throw away a reason the store already holds -
		// and would route a locked note into the wrong arm of the command.
		rec.futureLocked = true;
		rec.pageId = null;

		const answer = inlineInk.deleteAllReadiness(path);
		expect(answer.kind).toBe("blocked");
		expect((answer as { lock: string }).lock).toBe("future");
	});

	it("DAMAGED sits BENEATH the other locks: a note carrying both is blocked, not session-only", async () => {
		const { path, rec } = await loadedNote();
		const both = rec as unknown as { damagedLocked: boolean; futureLocked: boolean };

		// A note can carry both, and the order decides what happens to it. The
		// damaged branch is session-only BY DESIGN - it clears memory and
		// writes nothing, which is correct when damage is the ONLY reason the
		// write would not land. Under a future lock that is no longer true, so
		// damaged must not be the answer.
		both.damagedLocked = true;
		both.futureLocked = true;

		const answer = inlineInk.deleteAllReadiness(path);
		expect(answer.kind, "not the session-only branch").toBe("blocked");
		expect((answer as { lock: string }).lock).toBe("future");

		// And with the future lock gone it is the damaged branch again.
		both.futureLocked = false;
		expect(inlineInk.deleteAllReadiness(path).kind).toBe("damaged");
	});

	it("a record still LOADING is unsettled, not ready", async () => {
		const { path, rec } = await loadedNote();

		// Mid-read. Memory is whatever was cached; the sidecar may hold more.
		rec.load = "loading";
		expect(inlineInk.deleteAllReadiness(path).kind).toBe("unsettled");

		// And the same for a reload, which is the one that filters `strokes()`
		// to local ids while `captureDeleteAll` still reads the raw list.
		rec.load = "yes";
		rec.reloading = true;
		expect(inlineInk.deleteAllReadiness(path).kind).toBe("unsettled");

		rec.reloading = false;
		expect(inlineInk.deleteAllReadiness(path).kind, "settled again").toBe("ready");
	});

	it("THE FAIL-OPEN: an unsettled note with EMPTY memory refuses instead of clearing", async () => {
		const { path, rec } = await loadedNote();
		let preserveCalled = false;

		// The dangerous shape in full: nothing in memory, a load still running,
		// and a sidecar that may be full of ink. An empty capture is the one
		// case the command does not verify a backup for, so a `ready` answer
		// here would clear on the strength of "I have not looked yet".
		rec.strokes.length = 0;
		rec.load = "loading";

		await (HandwritingPlugin.prototype as unknown as Deleter3).deleteAllInk.call(
			withVault({
				store: {
					preserve: async () => {
						preserveCalled = true;
						return null;
					},
				},
			}) as unknown as HandwritingPlugin,
			targetFor(path)
		);

		expect(preserveCalled, "it does not even start").toBe(false);
		expect(told()).not.toContain("removed");

		// `unsettled-record`, one of the four Alan ruled TEMPORARY - and the
		// truthful answer here, because this note is mid-load and trying again
		// once it settles works. The general sentence said it never would.
		expect(notices.list).toEqual([DELETE_ALL_TEMPORARY]);
	});
});


/**
 * WHAT `unknown` READINESS ACTUALLY IS.
 *
 * `deleteAllReadiness` answers `unknown` for three states: no record, no host,
 * or a record with no page id. Cases (1) and (2) measure that state; (3) pins
 * what the command does with it.
 *
 * THE MEASUREMENT AND THE RULING POINT DIFFERENT WAYS, and both are kept here
 * on purpose. (1) and (2) show that the only `unknown` state holding real ink -
 * a note drawn on before its identity claim lands - is disk-isolated: no page
 * id, so `snapshot()` never composes a write and no sidecar can exist to lose.
 * On that measurement an earlier revision of this command let `unknown` proceed
 * to a no-copy wipe.
 *
 * It was ruled the other way on 2026-09-08, and the ruling does not contradict
 * the measurement - it answers a different question. `unknown` proves nothing:
 * not eligibility, not a valid capture, not an empty target, not an adequate
 * backup. An unproven state may not reach a destructive clear, a history entry
 * or a success notice, and "the old code did it" is not a reason to keep it.
 * So (1) and (2) stand as measured and (3) is now the refusal.
 */
describe("what `unknown` readiness actually is", () => {
	/**
	 * A note drawn on while its claim is still in flight. The claim is HELD
	 * open rather than raced, so the window is deterministic: `readPageId`
	 * knows nothing about this path and `claimId` never resolves, which is
	 * exactly the state between a first stroke and its page id landing.
	 */
	function unclaimedHost(): { writes: string[]; release: () => void } {
		const writes: string[] = [];
		let release: () => void = () => {};
		const held = new Promise<{ pageId: string }>((r) => {
			release = () => r({ pageId: "late-id" });
		});
		const host: InlineInkHost = {
			readPageId: () => null,
			claimId: () => held,
			loadSidecar: async () => null,
			scheduleSidecar: (id) => void writes.push(id),
			notify() {},
		};
		inlineInk.attachHost(host);
		return { writes, release };
	}

	function unclaimedOverlay(path: string): InkOverlayPlugin {
		let state = EditorState.create({
			doc: "note body",
			extensions: [history(), inkHistorySupport()],
		});
		const view = {
			get state() {
				return state;
			},
			dispatch(input: Transaction | TransactionSpec) {
				const tr = input instanceof Transaction ? input : state.update(input);
				state = tr.state;
				for (const effect of tr.effects) {
					if (effect.is(inkEffect) && !tr.annotation(inkApplied)) {
						(overlay as unknown as { applyInkOp(op: unknown): void }).applyInkOp(effect.value);
					}
				}
			},
		};
		const overlay = new InkOverlayPlugin(view as never);
		Object.assign(overlay, {
			filePath: () => path,
			selection: { clear() {}, prune() {} },
			scheduleRepaint() {},
			repaintPath() {},
			redrawSelectionUI() {},
			unmount() {},
		});
		teardown.push(() => (overlay as unknown as { destroy(): void }).destroy());
		return overlay;
	}

	type Ready = { deleteAllReadiness(path: string): { kind: string } };

	it("(1) a note drawn on before its claim lands holds REAL INK and reports unknown", () => {
		const path = `unclaimed-${++serial}.md`;
		paths.add(path);
		unclaimedHost();
		unclaimedOverlay(path);

		inlineInk.commit(path, stroke("drawn-now"));

		// Both halves of the dangerous shape, in one place: ink present, and
		// the readiness discriminator unable to say anything about it.
		expect(ids(inlineInk.strokes(path))).toEqual(["drawn-now"]);
		expect(inlineInk.pageIdOf(path)).toBeNull();
		expect((inlineInk as unknown as Ready).deleteAllReadiness(path).kind).toBe("unknown");
	});

	it("(2) and NOTHING it holds can reach disk: no page id, so no sidecar is ever scheduled", async () => {
		const path = `unclaimed-${++serial}.md`;
		paths.add(path);
		const { writes, release } = unclaimedHost();
		unclaimedOverlay(path);

		inlineInk.commit(path, stroke("drawn-now"));

		// THIS IS WHAT SETTLES THE RULING. `snapshot()` refuses without a page
		// id, so the write dies before it is composed - there is no sidecar for
		// this note, and a backup of one could not exist to be lost.
		expect(writes, "no write can be composed for a note with no id").toEqual([]);

		// THE PAIRED POSITIVE, because an empty array on its own proves only
		// that nothing was recorded. Let the claim land and draw again: the
		// SAME recorder now fills. So the silence above is the missing page id
		// talking, not a harness that cannot see a write.
		release();
		for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
		expect(inlineInk.pageIdOf(path), "the claim landed").toBe("late-id");
		inlineInk.commit(path, stroke("drawn-after-the-claim"));
		expect(writes.length, "the same recorder does see a write once an id exists").toBeGreaterThan(0);
	});

	it("(3) RULED: so the delete REFUSES, with no clear, no history, and it says so", async () => {
		const path = `unclaimed-${++serial}.md`;
		paths.add(path);
		const { writes } = unclaimedHost();
		const overlay = unclaimedOverlay(path);
		inlineInk.commit(path, stroke("drawn-now"));

		const before = undoDepth(
			(overlay as unknown as { view: { state: EditorState } }).view.state
		);

		let preserveCalled = false;
		await (HandwritingPlugin.prototype as unknown as Deleter2).deleteAllInk.call(
			withVault({
				store: {
					preserve: async () => {
						preserveCalled = true;
						return TRASH2;
					},
				},
			}) as unknown as HandwritingPlugin,
			targetFor(path)
		);

		// THE INK STAYS. This is the reversal: the same input that used to be
		// wiped is now refused, because nothing about this state established
		// that wiping it was safe.
		expect(ids(inlineInk.strokes(path))).toEqual(["drawn-now"]);

		// AND THE REFUSAL IS FREE OF SIDE EFFECTS, which is the part the ruling
		// is strict about. Not a quieter success: nothing at all.
		expect(preserveCalled, "an unproven state must not even reach preservation").toBe(false);
		expect(told()).not.toContain("removed");
		expect(told()).not.toContain("undo restores them");
		expect(told()).not.toContain("a copy is kept");
		expect(writes).toEqual([]);

		// AND IT SAYS THE TRUE ONE OF THE TWO. This note HAS ink - it was drawn
		// on before its claim landed - so the never-inked sentence would be
		// false here even though the readiness is the same `unknown`.
		expect(notices.list).toEqual([DELETE_ALL_REFUSED]);

		// No history entry of its own: a refused command has nothing to undo,
		// and leaving one would let a later undo "restore" ink that never left.
		expect(
			undoDepth((overlay as unknown as { view: { state: EditorState } }).view.state)
		).toBe(before);
	});
});

type Deleter2 = { deleteAllInk(target: unknown): Promise<void> };
const TRASH2 = ".handwriting/trash/kept.json";
