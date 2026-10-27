/**
 * PDF claims: which sidecar a PDF pane draws into, the panes' ink controllers, a PDF identified again after its bytes
 * change, claims moved on rename and retired on delete, and the ranged head read the id comes from. The methods are
 * methods of HandwritingPlugin, installed on its prototype when main.ts loads (installPdfClaims at its bottom). Bodies
 * moved unchanged from main.ts. This file imports only types from main.
 */
import { Notice, Platform, TFile, type WorkspaceLeaf } from "obsidian";
import { runGatedCommand } from "../CommandPaletteSplit";
import { installMethods } from "../inline/InstallMethods";
import { RECYCLE_GRACE_MS } from "../ink/RecycleOnDelete";
import type { InkStroke } from "../ink/Stroke";
import { calibrationStrokes } from "./PdfCalibration";
import { readPdfHead, type HeadSource, type RangedHandle } from "./PdfHead";
import { chooseInstance, familyOf, pdfInkIdFromHead, type InstanceClaim } from "./PdfIdentity";
import { PdfInkController } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";
import type { PdfDeleteContext } from "./PdfInkStore";
import { runDetached } from "../util/Detached";
import type { HandwritingPlugin } from "../main";

declare module "../main" {
	interface HandwritingPlugin {
		syncPdfControllers(): void;
		releasePdfId(id: string): void;
		schedulePdfModified(path: string, panes?: ReadonlySet<HTMLElement>): void;
		onPdfModified(path: string, panes?: ReadonlySet<HTMLElement> | null): Promise<void>;
		resolvePdfId(leaf: WorkspaceLeaf, root: HTMLElement, controller: PdfInkController): Promise<void>;
		pdfHeadSource(file: TFile): HeadSource;
		movePdfClaimOnRename(file: TFile, oldPath: string): Promise<void>;
		pdfIdForPath(path: string): string | null;
		pdfInkSnapshot(id: string): string | null;
		pdfControllerWithSelection(path: string): PdfInkController | null;
		pdfDeleteContext(): PdfDeleteContext;
		attachPdfPendingDeletes(): void;
	}
}

/** The per-vault local store key for PDF deletions still in their grace at quit. */
const PDF_PENDING_DELETES_KEY = "handwriting-pdf-pending-deletes";

/**
 * How long a PDF's bytes must stay still after a change before the panes
 * showing it are identified again. A sync can land one file in more than one
 * write, and the id is read from the file's head and length, so identifying
 * between writes reads a document that never existed.
 */
const PDF_MODIFY_SETTLE_MS = 1_000;

/** The slice of node's `fs` this needs, typed locally to avoid node typings. */
interface NodeFileHandle {
	read(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number
	): Promise<{ bytesRead: number }>;
	stat(): Promise<{ size: number }>;
	close(): Promise<void>;
}

/**
 * Open a file on disk for the ranged head read (PdfHead.ts).
 *
 * Obsidian ships an Electron renderer whose preload exposes `require`, which
 * is how PresentProbe.ts reaches @electron/remote (:180-191) and the pattern
 * copied here. It must stay a GUARDED, runtime require: a top-level `import`
 * from "fs" would be emitted into the bundle unconditionally and throw on
 * mobile the moment the plugin loads, taking every surface down with it.
 *
 * Throwing is a supported outcome - readPdfHead catches anything from here
 * and reads the whole file instead, which is what 1.4.5 always did.
 */
async function openRangedFile(fullPath: string): Promise<RangedHandle> {
	const w = window as { require?: (mod: string) => unknown };
	if (typeof w.require !== "function") throw new Error("no require: not an Electron renderer");
	const fs = w.require("fs") as { promises: { open(p: string, flags: string): Promise<NodeFileHandle> } };
	const handle = await fs.promises.open(fullPath, "r");
	return {
		read: async (into, at) => (await handle.read(into, 0, into.length, at)).bytesRead,
		// The size from THIS handle, never `file.stat.size`: the vault's
		// cached stat can lag an external write, and a length that disagrees
		// with the bytes being hashed changes the id - which would point a
		// document at a sidecar that does not exist.
		size: async () => Number((await handle.stat()).size),
		close: () => handle.close(),
	};
}

	/**
	 * Attach an ink controller to every open PDF view, and drop the ones whose
	 * views are gone.
	 *
	 * Keyed by root element, and swept by checking `isConnected`, because a
	 * leaf outlives the file in it: closing a PDF and opening another reuses
	 * the leaf, and a map keyed on the leaf would hand the new document the
	 * old document's overlays.
	 */
	function syncPdfControllers(this: HandwritingPlugin): void {
		const seen = new Set<HTMLElement>();
		for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
			const root = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl;
			if (!root) continue;
			seen.add(root);
			const path = (leaf.view as unknown as { file?: TFile }).file?.path ?? "";
			const existing = this.pdfInk.get(root);
			if (existing) {
				// Same pane, different document: forget the old id and hash the
				// new one before anything can be written under the wrong key.
				//
				// An EMPTY path is "not known yet", never "a different
				// document". `leaf.view.file` is momentarily undefined while
				// the viewer re-renders, on a layout change, and as a leaf
				// becomes active - all three of which run this sync - so a
				// bare `!==` read that transient as a document switch and
				// forgot the id, the history AND the selection under a user
				// who had done nothing but lasso some ink: "lasso'd it,
				// trashcan lit up, hit delete, trashcan and undo dimed, but
				// nothing deleted" (Alan, 2026-09-02). forgetHistory is the
				// only thing that empties the ring and the selection together,
				// which is why both lights went out at once.
				//
				// `resolvePdfId` already reads empty the same way: it returns
				// at `if (!file) return` rather than resolving an id for "",
				// and its post-await guards compare against a path that is
				// therefore always non-empty. Leaving the stored path alone
				// here keeps an in-flight resolution matching its own document
				// instead of aborting on a "" that was never a document.
				//
				// A pane whose PDF really closes is not lost by this: a leaf
				// that stops being a pdf leaf is not in `seen`, so the sweep
				// below unmounts it and drops both maps. A pdf leaf left
				// EMPTY keeps its stale id, which nothing can write under
				// while there is no document rendered to draw on, and the
				// next real path - any file, including a different one -
				// differs from the stored path and reclaims it.
				if (path !== "" && this.pdfFiles.get(root) !== path) {
					this.pdfFiles.set(root, path);
					const was = this.pdfIds.get(root);
					this.pdfIds.delete(root);
					if (was) this.releasePdfId(was);
					existing.forgetHistory();
					runDetached(this.resolvePdfId(leaf, root, existing), "identify a pdf for ink", () =>
						new Notice("Handwriting: could not identify this PDF - ink is disabled for it. Reopening the file retries.")
					);
				}
				continue;
			}
			this.pdfFiles.set(root, path);
			const win = root.ownerDocument.defaultView ?? window;
			const controller = new PdfInkController(
				root,
				win,
				(page) => {
					if (this.pdfCalibration) return calibrationStrokes(page);
					const id = this.pdfIds.get(root);
					return id ? this.pdfStore.strokesOnPage(id, page) : [];
				},
				// No id yet means the file is still being hashed. The controller
				// asks before every gesture and does nothing without one:
				// dropping a stroke is wrong and storing it under a guessed id
				// is worse.
				() => this.pdfIds.get(root) ?? null,
				// The whole document, in store order. This is the list the sink
				// below applies every op against, so it is the list the op's
				// indices have to be positions in. The page-filtered source
				// above is for hit-testing and painting only.
				() => {
					if (this.pdfCalibration) return [];
					const id = this.pdfIds.get(root);
					return id ? this.pdfStore.strokes(id) : [];
				},
				(op, mode) => {
					// The op's OWN document, never the pane's current one. An
					// undo pressed after this pane opened a different PDF must
					// act on the document the ink lives in; using whatever is on
					// screen would put strokes back into the wrong file.
					const id = op.path;
					if (!id) return;
					// The eraser's per-sample op: its indices are the page's, and
					// the store applies it to that page alone.
					if (mode === "live-page") {
						this.pdfStore.applyLivePage(id, op);
						return;
					}
					// One path for drawing, erasing and undoing: the op says what
					// changed, applyOp works out the resulting stroke list, and
					// the store writes it. Undo is then just the inverse op
					// arriving through the same door.
					const next = applyOp(this.pdfStore.strokes(id), op);
					// "live" means the gesture is still running: the screen
					// needs the new list, the disk does not. The controller
					// writes once at pen-up through the persist callback below.
					if (mode === "live") {
						this.pdfStore.replaceAllLive(id, next);
						return;
					}
					this.pdfStore.replaceAll(id, next);
					// Notes get this for free: InkOverlay's repaintPath fires at
					// every one of its twelve call sites, including the stroke
					// commit, and repaints every OTHER pane on the same note at
					// once. The PDF surface had no equivalent, so a second pane
					// on this document only learned ink had changed when the
					// disk poll below noticed a changed mtime - and that poll's
					// own backoff (reloadStride) stretches to five seconds once
					// it has been quiet, which writing in the first pane is
					// exactly what makes it. THE POLL IS NOT AT FAULT: it exists
					// to notice another DEVICE's write, and its backoff is
					// deliberate and argued in its own comment. The defect was
					// leaning on it as an in-process event bus instead of
					// telling the other pane directly, the way notes do.
					//
					// Mirrors repaintPath in the two places notes and PDFs
					// differ: COMMIT only, never "live" (the early return
					// above) - repaintPath also fires at gesture boundaries,
					// and a per-sample fan-out would repaint the other pane's
					// whole overlay dozens of times a second for a difference
					// nobody can see. And keyed on the document ID, not the
					// path - two panes can hold the same PDF under different
					// leaves, and the id is what the store is keyed by.
					//
					// One thing repaintPath has no equivalent of: a pane can be
					// mid-gesture. refresh() invalidates every overlay and
					// reschedules, and swapping ink under a live lasso, drag or
					// stroke tears it - the same reason the poll checks
					// `controller.idle` before reloading. A non-idle pane is
					// skipped here for the same reason and gets the same
					// fallback it already had: the next poll tick notices the
					// write, no worse off than before this fix existed.
					for (const [otherRoot, other] of this.pdfInk) {
						if (otherRoot === root) continue;
						if (this.pdfIds.get(otherRoot) !== id) continue;
						if (!other.idle) continue;
						other.refresh();
					}
				},
				// `commands` is not on the public App type, so it is reached
				// the way the note surface reaches it: a narrow cast behind a
				// typeof guard, and nothing happens if it is absent.
				(commandId) => {
					// A strip button whose command sits behind "Extra commands
					// for hotkeys" has no entry in the registry while the
					// setting is off, and executeCommandById would do nothing
					// at all. `runGatedCommand` holds exactly the actions that
					// were kept OUT of the palette, so it answers true only in
					// that case: the setting hides commands, it does not
					// remove tools. See CommandPaletteSplit.ts.
					if (runGatedCommand(commandId)) return;
					const commands = (this.app as unknown as {
						commands?: { executeCommandById(id: string): void };
					}).commands;
					if (typeof commands?.executeCommandById === "function") {
						commands.executeCommandById(commandId);
					}
				},
				// The controller does not import Notice - it observes the DOM
				// and nothing else, which is what keeps it constructible in a
				// test. Saying things is the plugin's job.
				(message) => {
					new Notice(message);
				},
				// The one write at the end of a gesture whose ops were applied
				// live. The controller decides when; the store decides how.
				// Live ops return before the other-pane refresh in the op sink
				// above, so the end of the gesture is where another pane on the
				// same PDF hears of it: an erase, lasso move or insert-space
				// otherwise left that pane showing the old ink. With one pane
				// open this is the save and one size check, nothing more.
				(id) => {
					this.pdfStore.save(id);
					if (this.pdfInk.size < 2) return;
					for (const [otherRoot, other] of this.pdfInk) {
						if (otherRoot === root || this.pdfIds.get(otherRoot) !== id || !other.idle) continue;
						other.refresh();
					}
				},
				// Both sources above are substituted under calibration, so the
				// document the controller reads is made up and nothing it works
				// out from it may be written. Set HERE, next to the
				// substitution, so a third synthetic source is one line from
				// being covered instead of one id prefix from being missed.
				() => this.pdfCalibration,
				// The page colour a snip's ink is made readable against: the
				// flatten's setting, read at each snip so a change applies to
				// the next one.
				() => this.settings.inkPdfColorMode,
				() => {
					const id = this.pdfIds.get(root);
					return id !== undefined && this.pdfStore.inkReady(id);
				}
			);
			controller.mount();
			this.pdfInk.set(root, controller);
			runDetached(this.resolvePdfId(leaf, root, controller), "identify a pdf for ink", () =>
				new Notice("Handwriting: could not identify this PDF - ink is disabled for it. Reopening the file retries.")
			);
		}
		for (const [root, controller] of [...this.pdfInk]) {
			if (seen.has(root) && root.isConnected) continue;
			controller.unmount();
			const was = this.pdfIds.get(root);
			this.pdfInk.delete(root);
			this.pdfIds.delete(root);
			this.pdfFiles.delete(root);
			if (was) this.releasePdfId(was);
		}
	}

	/**
	 * No pane shows this PDF id any more: once its ink is on disk, forget the
	 * session record, so the next open reads the sidecar as it is then - with
	 * whatever another device synced in meanwhile - instead of drawing on a
	 * stale copy whose next save would write over it. Kept when a pane shows
	 * the id again before this settles, when the write did not land, and in
	 * every case PdfInkStore.forgetIfUnchanged refuses.
	 */
	function releasePdfId(this: HandwritingPlugin, id: string): void {
		if ([...this.pdfIds.values()].includes(id)) return;
		const generation = this.pdfStore.generation(id);
		if (generation === null) return;
		runDetached(
			(async () => {
				await this.pdfStore.settle();
				if (!(await this.store.flushPage(id))) return;
				if ([...this.pdfIds.values()].includes(id)) return;
				this.pdfStore.forgetIfUnchanged(id, generation);
			})(),
			"forget a closed pdf's ink record"
		);
	}

	/**
	 * A PDF's bytes changed on disk: identify its panes again once the file is
	 * still. `panes` narrows that to the panes named; a wait already asking
	 * for every pane keeps asking for every pane.
	 */
	function schedulePdfModified(this: HandwritingPlugin, path: string, panes?: ReadonlySet<HTMLElement>): void {
		const timers = (this.pdfModifyTimers ??= new Map<string, { timer: number; panes: Set<HTMLElement> | null }>());
		const pending = timers.get(path);
		if (pending !== undefined) window.clearTimeout(pending.timer);
		let waiting: Set<HTMLElement> | null = null;
		if (panes && pending?.panes !== null) waiting = new Set([...(pending?.panes ?? []), ...panes]);
		timers.set(path, {
			timer: window.setTimeout(() => {
				timers.delete(path);
				runDetached(this.onPdfModified(path, waiting), `identify ${path} again after it changed`);
			}, PDF_MODIFY_SETTLE_MS),
			panes: waiting,
		});
	}

	/**
	 * The ink id is made from the file's content, so new bytes are a new
	 * document, and every pane showing the file is identified again the way a
	 * pane that switches file is. Kept, a pane replaced under it (a sync, a
	 * re-export over the file) went on drawing into the old content's
	 * sidecar, and that ink was gone when the file reopened under its new
	 * content. A pane mid-gesture is left alone and asked again after another
	 * settle, so the document never changes under a live stroke. Only that
	 * pane is asked again: identifying a pane forgets its undo, and a second
	 * pane on the file that was identified already would lose the undo of
	 * every stroke drawn in it since.
	 *
	 * The plugin's own PDF writes never arrive here: flatten, snip and export
	 * all create a new file beside the source and never modify one.
	 */
	async function onPdfModified(this: HandwritingPlugin, path: string, panes?: ReadonlySet<HTMLElement> | null): Promise<void> {
		const resolutions: Promise<void>[] = [];
		const held = new Set<HTMLElement>();
		// The panes whose old id held ink, with that ink and whether its record was sound, read before
		// releasePdfId: the release forgets the old record detached, and it can finish before the new id lands,
		// so asking after the await can miss the ink.
		const inked: { root: HTMLElement; was: string; strokes: readonly InkStroke[]; sound: boolean }[] = [];
		for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
			const root = (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl;
			if (!root || this.pdfFiles.get(root) !== path) continue;
			if (panes && !panes.has(root)) continue;
			const controller = this.pdfInk.get(root);
			if (!controller) continue;
			if (!controller.idle) {
				held.add(root);
				continue;
			}
			const was = this.pdfIds.get(root);
			if (was && this.pdfStore.hasInk(was)) {
				inked.push({ root, was, strokes: this.pdfStore.strokes(was), sound: this.pdfStore.inkReady(was) });
			}
			this.pdfIds.delete(root);
			if (was) this.releasePdfId(was);
			controller.forgetHistory();
			resolutions.push(
				this.resolvePdfId(leaf, root, controller).catch(() => {
					new Notice("Handwriting: could not identify this PDF - ink is disabled for it. Reopening the file retries.");
				})
			);
		}
		if (held.size > 0) this.schedulePdfModified(path, held);
		await Promise.all(resolutions);
		// New content means a new ink file (PdfIdentity). The ink drawn before the change is copied into it when
		// the new file is fresh and the old record was sound, so the page keeps its ink; the copy is the same
		// stroke objects, so saved ink looks exactly as it did. The old record and its file are never written.
		// A locked old record, or a new file that already has ink, keeps the old ink where it is. Said once per
		// file, not once per pane. No id means the resolution failed and has said so already.
		let changed = false, carried = false;
		for (const { root, was, strokes, sound } of inked) {
			const now = this.pdfIds.get(root);
			if (now === undefined || now === was) continue;
			changed = true;
			if (sound && this.pdfStore.inkReady(now) && !this.pdfStore.hasInk(now)) {
				this.pdfStore.replaceAll(now, strokes);
				for (const [pane, id] of this.pdfIds) if (id === now) this.pdfInk.get(pane)?.refresh();
				carried = true;
			}
		}
		if (carried) new Notice("Handwriting: this PDF changed on disk. Your ink was carried over to its new version.");
		else if (changed) new Notice("Handwriting: this PDF changed on disk. Ink drawn before the change is kept in its old ink file; new ink goes to a new one.");
	}

	/**
	 * Work out which sidecar this PDF's ink belongs in, then show it.
	 *
	 * Content-keyed, so this reads the file rather than any metadata - see
	 * PdfIdentity for why a PDF cannot carry an id of its own. Asynchronous by
	 * nature, which is why the controller mounts first and renders nothing
	 * until this lands: a blank page for a moment is fine, ink under the wrong
	 * id is not.
	 */
	async function resolvePdfId(this: HandwritingPlugin,
		leaf: WorkspaceLeaf,
		root: HTMLElement,
		controller: PdfInkController
	): Promise<void> {
		const file = (leaf.view as unknown as { file?: TFile }).file;
		if (!file) return;
		// The path the pane opened with, read before the first await. Never a
		// guard (those read file.path fresh, below): only the claim step uses it,
		// so a rename while the file is identified moves the claim instead of
		// leaving the old name in the ink file beside the new one.
		const started = file.path;
		const token = {};
		const tokens = (this.pdfResolveTokens ??= new WeakMap<HTMLElement, object>());
		tokens.set(root, token);
		// The guard after every await. The plugin can also be unloaded across
		// one: the continuation then outlives onunload and registered a path
		// claim, an id and a repaint for a plugin that is gone. Claims are
		// session memory, so stopping is enough; nothing needs releasing.
		const current = () => !this.unloaded && root.isConnected && this.pdfFiles.get(root) === file.path && tokens.get(root) === token;
		// `file.path` is read fresh at every step, never kept: a rename during
		// identification moves the same TFile, and the rename handler moves
		// pdfFiles with it, so the live path still matches the pane. A copy of
		// the old path stopped matching at the next guard and the pane was left
		// with no id until the PDF was reopened.
		// The head and the file's length, which is all the id is made of.
		// This used to be `readBinary(file)` - the whole document, so a
		// 200 MB scan was read into memory on every open to hash its first
		// 64 KiB. PdfHead reads just that much where the platform allows it
		// and falls back to the whole read everywhere else.
		const { head, byteLength } = await readPdfHead(this.pdfHeadSource(file));
		// Several awaits, and the pane can change document across any of
		// them. Checking only `isConnected` catches a closed view but not a
		// switched one: two resolutions racing in the same pane could finish
		// out of order and stamp the earlier document's id onto the later
		// one - so the guard repeats after every await.
		if (!current()) return;
		const family = await pdfInkIdFromHead(head, byteLength, window.crypto);
		if (!current()) return;
		// Which INSTANCE of the content family this file is. Byte-identical
		// copies are one family, but each vault file is its own instance -
		// launch day proved why: a re-export of an unchanged OneNote page
		// arrived already wearing the original's ink (2026-09-01). The
		// sidecars' own path claims decide; see PdfIdentity.chooseInstance.
		// Read without taking the sidecar as seen: a record still held for this
		// id must not have its write baseline moved to a revision it never
		// loaded (PageStore.readPdfPaths).
		const candidates: InstanceClaim[] = [];
		for (const cid of (await this.store.listIds(family)).filter((i) => familyOf(i) === family)) {
			const paths = (await this.store.readPdfPaths(cid));
			// An unreadable claim is not a legacy claimless sidecar. Choosing
			// an instance from a partial list can give another file this ink.
			if (paths === null) throw new Error(`could not read PDF ink claims for ${cid}`);
			candidates.push({ id: cid, paths });
		}
		// And the instances this session already handed out, whose claim may
		// not be on disk yet: an un-inked original has no sidecar, and without
		// its claim here a byte-identical copy was given the same id.
		for (const held of this.pdfStore.claimedInstances((i) => familyOf(i) === family)) {
			const known = candidates.find((c) => c.id === held.id);
			if (known) known.paths = [...new Set([...known.paths, ...held.paths])];
			else candidates.push(held);
		}
		// And the choices other panes have made but not claimed yet, because
		// their sidecar is still loading. Two copies of one template opened
		// together (a restored workspace, two quick tabs) otherwise both chose
		// the first free instance and shared one sidecar.
		const resolving = (this.pdfResolving ??= new Map<HTMLElement, { id: string; path: string }>());
		for (const [other, inFlight] of resolving) {
			if (other === root || familyOf(inFlight.id) !== family) continue;
			// The pane's path NOW, not when it chose: a rename during its load
			// moves pdfFiles, and a new file at the old name must not be handed
			// the renamed file's choice.
			const path = this.pdfFiles.get(other) ?? inFlight.path;
			const known = candidates.find((c) => c.id === inFlight.id);
			if (known) known.paths = [...new Set([...known.paths, path])];
			else candidates.push({ id: inFlight.id, paths: [path] });
		}
		if (!current()) return;
		const choice = chooseInstance(
			family,
			file.path,
			candidates,
			(p) => this.app.vault.getFileByPath(p) !== null,
			this.pdfStore.pendingClaims()
		);
		this.pdfIds.set(root, choice.id);
		// Kept past the pane: a save that fails or a conflict copy can be reported after the pane
		// closed and its own id and path maps were dropped, and the notice must still name the file.
		(this.pdfPathById ??= new Map()).set(choice.id, file.path);
		// Held only across the load: every return before this point comes
		// before the reservation, and the guard after it comes after the
		// release, so no path out of here leaves a choice reserved.
		const mine = { id: choice.id, path: file.path };
		resolving.set(root, mine);
		try {
			await this.pdfStore.ensureLoaded(choice.id);
		} finally {
			if (resolving.get(root) === mine) resolving.delete(root);
		}
		// The fourth await, and the guard the first three already carry: the
		// pane can change document across this one too, and what follows is
		// the durable half - claimPath writes this path into that sidecar, and
		// the refresh paints its ink. Without the re-check a resolution that
		// lost the race stamped the earlier document's path onto the later
		// document's sidecar. The id set above is deliberately before the
		// await - the controller must be able to ask for it the moment the
		// choice is made - and a stale one is corrected by the next sync,
		// which is what clears pdfIds when the pane's file changes.
		if (!current()) return;
		// Always claimed: an adoption becomes durable at once, a fresh
		// instance merely remembers until its first stroke, and a repeat
		// claim is a no-op. Renamed since the pane opened: the handler had no id
		// to move, or the ink file's load merged the old name back, so the claim
		// moves here.
		if (file.path !== started) this.pdfStore.renamePath(choice.id, started, file.path);
		else this.pdfStore.claimPath(choice.id, file.path);
		controller.refresh();
		// canPasteInk flips the moment documentId() stops being null, but
		// nothing repaints the strip for it: refresh() above only repaints
		// ink, and the only other PDF-wide refresh is the addStripSurface
		// fan-out on setting changes (§5f). Without this the paste button
		// worked as soon as identification finished but went on looking
		// dimmed until something unrelated redrew the strip (1.4.6-design.md
		// 5m/AF2).
		controller.refreshStrip();
	}

	/**
	 * Where this PDF's head can be read from, cheapest route first.
	 *
	 * `whole` is the vault read that has always worked and always will. The
	 * ranged route is offered only on desktop, where Obsidian is Electron and
	 * node `fs` exists, and only when the vault is on a real filesystem the
	 * adapter can name - a `FileSystemAdapter`. Anything else (mobile, a
	 * sandboxed build with no `require`, an adapter that keeps files
	 * somewhere that is not a path) leaves `openRanged` undefined and the
	 * read behaves exactly as it did in 1.4.5.
	 *
	 * Detected by the presence of `getFullPath` rather than `instanceof
	 * FileSystemAdapter`: `test/obsidian-stub.ts` does not export that class
	 * (nothing in the plugin needed it before), and an `instanceof` against
	 * an undefined import throws at runtime, which would break every test
	 * that loads this module rather than fail some check. Duck-typing also
	 * happens to be the honest test here - what is needed is an absolute
	 * path, not a class.
	 */
	function pdfHeadSource(this: HandwritingPlugin, file: TFile): HeadSource {
		const whole = () => this.app.vault.readBinary(file);
		if (!Platform.isDesktopApp) return { whole };
		const adapter = this.app.vault.adapter as unknown as {
			getFullPath?: (path: string) => string;
		};
		if (typeof adapter.getFullPath !== "function") return { whole };
		const full = adapter.getFullPath(file.path);
		if (typeof full !== "string" || full.length === 0) return { whole };
		return { openRanged: () => openRangedFile(full), whole };
	}

	/**
	 * A PDF renamed while no pane shows it: the sidecar claiming the old name
	 * now claims the new one. Left on the old name, the claim outlived the
	 * file: a file saved there later opened wearing this ink, and erasing on
	 * either erased both. Identification's own adoption keeps every claim, as
	 * it must - a claimed path can be missing only because that file has not
	 * synced here yet - so the move happens here, where the rename is known.
	 * Found by content, the way identification finds it. A rename made while
	 * Obsidian was closed, or by another program, sends no event and is not
	 * covered.
	 */
	async function movePdfClaimOnRename(this: HandwritingPlugin, file: TFile, oldPath: string): Promise<void> {
		// The plugin can be unloaded across any await below. The continuation
		// then outlived onunload: it moved a claim and released a record for a
		// plugin that is gone. Claims are session memory, so stopping is enough.
		const { head, byteLength } = await readPdfHead(this.pdfHeadSource(file));
		if (this.unloaded) return;
		const family = await pdfInkIdFromHead(head, byteLength, window.crypto);
		if (this.unloaded) return;
		const heldPaths = (id: string) => this.pdfStore.claimedInstances((i) => i === id)[0]?.paths;
		const ids = new Set((await this.store.listIds(family)).filter((i) => familyOf(i) === family));
		if (this.unloaded) return;
		for (const held of this.pdfStore.claimedInstances((i) => familyOf(i) === family)) ids.add(held.id);
		for (const id of ids) {
			const claimed = heldPaths(id) ?? (await this.store.readPdfPaths(id));
			if (this.unloaded) return;
			if (!claimed?.includes(oldPath)) continue;
			try {
				await this.pdfStore.ensureLoaded(id);
				// Loaded, the record's own claims are the ones to trust.
				if (!this.unloaded && heldPaths(id)?.includes(oldPath)) this.pdfStore.renamePath(id, oldPath, file.path);
			} finally {
				// Loaded here for a PDF no pane may show. Kept, the record stood in
				// for the sidecar at the next open, and ink another device added
				// meanwhile was missing. Released once what it holds is on disk;
				// releasePdfId keeps it while a pane shows it.
				if (!this.unloaded) this.releasePdfId(id);
			}
		}
	}

	/**
	 * The ink id of an open PDF, or null while it is still being hashed.
	 *
	 * By path rather than by pane, because the command acts on the active
	 * FILE. The same document open in two panes resolves to the same id, so
	 * which one answers does not matter.
	 */
	function pdfIdForPath(this: HandwritingPlugin, path: string): string | null {
		for (const [root, at] of this.pdfFiles) {
			if (at === path) return this.pdfIds.get(root) ?? null;
		}
		return null;
	}

	/**
	 * The whole of a PDF's ink as one comparable value, or null if it cannot
	 * be taken.
	 *
	 * Text, not a copy of the objects, because both mutation shapes defeat a
	 * copy: `commit` pushes into the live array in place, and
	 * `replaceAllLive` swaps the array for another. A reference compares
	 * equal to itself after the first, and a shallow copy shares the stroke
	 * objects with both. Serializing captures every point's coordinates,
	 * pressure and time along with style, page and anything else a stroke
	 * carries - which is the point, since the change this guards against can
	 * be one interior coordinate that the on-disk rounding would hide.
	 *
	 * Nothing here touches the live objects: no freeze, no sort, no mutation.
	 *
	 * Null when the ink cannot be serialized at all, and the caller then
	 * refuses the clear. "Cannot compare" must not read as "did not change" -
	 * that is the direction that loses ink.
	 */
	function pdfInkSnapshot(this: HandwritingPlugin, id: string): string | null {
		try {
			return JSON.stringify(this.pdfStore.strokes(id));
		} catch (err) {
			console.error("[handwriting] delete-all-pdf-ink could not read current ink", err);
			return null;
		}
	}

	/**
	 * The controller holding a selection ON THIS FILE, or null.
	 *
	 * Scoped to the file's own panes, where the first version scanned every
	 * open view and returned the first selection anywhere: two PDFs open,
	 * selection in the background one, and the snip rendered that selection
	 * while writing the image - and the embed link - beside the ACTIVE file.
	 * Wrong document, wrong backlink, silently. Pairing through the path
	 * makes divergence impossible, and the same file open twice still snips:
	 * either pane's selection is that document's ink.
	 */
	function pdfControllerWithSelection(this: HandwritingPlugin, path: string): PdfInkController | null {
		for (const [root, at] of this.pdfFiles) {
			if (at !== path) continue;
			const c = this.pdfInk.get(root);
			if (c?.hasSelection) return c;
		}
		return null;
	}

	/**
	 * What retiring a deleted PDF's claim needs, for a deletion seen now and
	 * for one restored from the session before.
	 */
	function pdfDeleteContext(this: HandwritingPlugin): PdfDeleteContext {
		return {
			store: this.store,
			listPdfPaths: () => this.app.vault.getFiles().filter((f) => f.extension === "pdf").map((f) => f.path),
			familyForPath: async (path) => {
				const found = this.app.vault.getFileByPath(path);
				if (!found || found.extension !== "pdf") return null;
				const { head, byteLength } = await readPdfHead(this.pdfHeadSource(found));
				return pdfInkIdFromHead(head, byteLength, window.crypto);
			},
			graceMs: RECYCLE_GRACE_MS,
			release: (id) => this.releasePdfId(id),
		};
	}

	/**
	 * PDF deletions still in their grace, kept per vault and per device: the
	 * app's local store, not data.json, which syncs and would hand one
	 * device's deletions to another, and not raw localStorage, which every
	 * vault on this device shares.
	 */
	function attachPdfPendingDeletes(this: HandwritingPlugin): void {
		this.pdfStore.attachPendingDeletes({
			load: () => this.app.loadLocalStorage(PDF_PENDING_DELETES_KEY) as unknown,
			save: (saved) => this.app.saveLocalStorage(PDF_PENDING_DELETES_KEY, saved),
			context: () => this.pdfDeleteContext(),
		});
	}

export function installPdfClaims(proto: HandwritingPlugin): void {
	installMethods(proto, {
		syncPdfControllers,
		releasePdfId,
		schedulePdfModified,
		onPdfModified,
		resolvePdfId,
		pdfHeadSource,
		movePdfClaimOnRename,
		pdfIdForPath,
		pdfInkSnapshot,
		pdfControllerWithSelection,
		pdfDeleteContext,
		attachPdfPendingDeletes,
	});
}
