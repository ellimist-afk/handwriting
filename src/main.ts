import { Command, Notice, Platform, Plugin, TFile, View } from "obsidian";
import {
	bindInkEscapeWindow,
	closeInlineInkDocument,
	peelInlineEscapeSelection,
	endLiveStrokesEverywhere,
	hidePenCursorsEverywhere,
	getInlineEraserMode,
	getInlineLassoMode,
	getInlinePanMode,
	getInlineSpaceMode,
	getInlineTool,
	InkOverlayPlugin,
	overlayForActiveEditor,
	refreshPenToolsAll,
	refreshAllStrips,
	setInlineEraserMode,
	setInlineLassoMode,
	setInlinePanMode,
	setInlineSpaceMode,
	setInlineTool,
} from "./inline/InkOverlay";
import { ownedNoticeHiders } from "./OwnedNotices";
import { InkTraceRecorder, resolveContentTracing } from "./diag/InkTrace";

declare const __HW_BUILD_SOURCE_COMMIT__: string;
declare const __HW_BUILD_SOURCE_TREE__: string;
declare const __HW_BUILD_DIRTY_STATUS__: string;
declare const __HW_BUILD_VERIFIED__: boolean;

function loadedBuild(version: string): {
	version: string;
	sourceCommit: string;
	sourceTree: string;
	dirtyStatus: string;
	verified: boolean;
} {
	return {
		version,
		sourceCommit: __HW_BUILD_SOURCE_COMMIT__,
		sourceTree: __HW_BUILD_SOURCE_TREE__,
		dirtyStatus: __HW_BUILD_DIRTY_STATUS__,
		verified: __HW_BUILD_VERIFIED__,
	};
}
import { NotePaper } from "./inline/NotePaper";
import {
	markPenSeen,
	penHardwareSeen,
	shouldRaiseStripOnPenOff,
} from "./inline/PenToolsMode";
// The per-note Infinite Canvas override: the plumbing is CanvasNoteOverride's,
// the instance and the two ways a user reaches it (the command below and the
// strip) are this file's.
import {
	CanvasNoteOverride,
} from "./inline/CanvasNoteOverride";
// The strip owns the fold list: the ids, their default order, and the rule
// that makes a saved order safe to use all live beside the row they describe -
// and `PEN_INK_TOGGLE`, the keyboard button's id, which outlived the palette
// command of the same name because saved fold orders are written in it.
import { PenCommandHost } from "./inline/PenCommand";
import { PdfInkController } from "./pdf/PdfInkController";
import { PdfInkStore } from "./pdf/PdfInkStore";
import { PageIdIndex } from "./model/PageIdIndex";
import { PageStore } from "./persistence/PageStore";
export { HandwritingSettingTab, gatedCommandGroups, type GatedCommandGroup, SYNC_ALL_TYPES_HINT } from "./settings/HandwritingSettingTab";
import { DEFAULT_SETTINGS, type HandwritingSettings } from "./settings/SettingsModel";
export type { HandwritingSettings } from "./settings/SettingsModel";
import { installPluginSettings } from "./settings/PluginSettings";
export { noticeBlocks } from "./view/Notices";
import { installDeleteAllInk } from "./ink/DeleteAllInk";
export { DELETE_ALL_REFUSED, DELETE_ALL_NO_INK, DELETE_ALL_TEMPORARY, DELETE_ALL_REFUSALS, deleteAllRefusalText, bindRecoveryNotices } from "./ink/DeleteAllInk";
import { installRecycleOnDelete } from "./ink/RecycleOnDelete";
import { installPdfClaims } from "./pdf/PdfClaims";
import { installPageIdentity } from "./persistence/PageIdentity";
import { installSnips } from "./export/Snips";
import { installHeaderActions } from "./view/HeaderActions";
import { installRegisterCommands } from "./commands/RegisterCommands";
import { installRegisterDiagCommands } from "./commands/RegisterDiagCommands";
import { installRegisterExportCommands } from "./commands/RegisterExportCommands";
import { installPluginApply } from "./PluginApply";
import { installPluginLifecycle } from "./PluginLifecycle";
import { installPluginOnload } from "./PluginOnload";
import { installPluginOnloadReload } from "./PluginOnloadReload";

/**
 * Where "Upload to developer" sends a replay recording. Empty string means
 * the button does not exist - recording and Copy/Save work entirely offline,
 * which keeps the no-required-network rule intact. The receiving end is
 * scripts/trace-worker/worker.mjs, deployed to Cloudflare with
 * `npx wrangler deploy` from that directory; nothing runs anywhere
 * between uploads.
 */
const TRACE_UPLOAD_URL: string = "https://handwriting-traces.trace-worker.workers.dev";

/**
 * Handwriting: pen ink on ordinary Markdown notes.
 *
 * The primary surface is the Markdown editor itself. The pen inks directly on
 * a note in Live Preview or source mode and the ink is stored beside the file.
 * The standalone canvas is still there for notes carrying `handwriting: page` in
 * their frontmatter. Opening one swaps the Markdown view for the canvas, and
 * it can always be opened as ordinary Markdown again. Either way the note stays
 * readable, linkable and indexable.
 */

/**
 * The pen-off toggle's Notice text, and nothing else: state -> message, no
 * Notice, no DOM. Split out from the command below so the wording can be
 * pinned by a plain test - see `ownedNotice` just after it for the half that
 * actually owns a Notice and rewrites it in place.
 */
export function penToggleNoticeText(on: boolean): string {
	return on ? "Handwriting: pen ink active" : "Handwriting: keyboard mode - pen ink paused, tap to type";
}

/**
 * One toggle's Notice, rewritten on every press instead of stacked.
 *
 * Alan, hardware report: "when spamming the toast for keyboard doesnt have
 * the current state last". Obsidian Notices queue, and each one runs its own
 * timeout - so five quick presses of the keyboard button left five toasts on
 * screen that expire in the order they were created, and the OLDEST one is
 * the last still standing, naming a state the pen has not been in for four
 * presses. The fix is not a queue to drain faster; it is a toggle that owns
 * exactly one Notice and overwrites it.
 *
 * The supported messageEl is connected only while its Notice is attached.
 * Optional chaining also handles older test doubles with no DOM element.
 * Hiding an already detached notice is skipped; a new notice gets a fresh timer.
 *
 * RESTARTING THE TIMEOUT: this does not call `setMessage`. obsidian.d.ts
 * documents it only as "Change the message of this notice", nothing about
 * the timer, and the one runtime this repo can see - test/obsidian-stub.ts's
 * `Notice` - is `export class Notice {}`, an empty class with no method on it
 * at all. Neither artifact says setMessage restarts the auto-hide clock, so
 * this does not claim that it does. Instead it hides the still-showing
 * Notice and constructs a fresh one, which is guaranteed a full new timeout
 * because the constructor's own `duration` parameter says so (obsidian.d.ts)
 * - correct whether or not setMessage would also have worked.
 *
 * Returns a shower function rather than exposing the slot it closes over:
 * called once per toggle, at module load (below), so each toggle keeps its
 * OWN Notice - pressing Eraser and then Lasso is two different pieces of
 * news, not one toggle's stale repeat of the other - while the rewrite-or-
 * recreate rule itself is written exactly once instead of five times.
 */
/**
 * Every owned slot's hider, in creation order, lives in `OwnedNotices.ts` -
 * a leaf module rather than a const here.
 *
 * A Notice outlives the plugin that made it: it is Obsidian's DOM, on
 * Obsidian's own timeout, and disabling or reloading the plugin between the
 * last toggle and that timeout left the final toast standing - naming a
 * state of a plugin that is no longer running. The slots are module scope
 * and closed over, so `onunload` cannot reach them one by one; the shared
 * array is how it reaches all of them at once, and it stays correct as slots
 * are added.
 *
 * SHARED rather than private here since 1.4.12: the quick-pen presets own a
 * Notice too (`ownedPresetNotice`, ink/InkPresetHost.ts) and a private array
 * was one unload could not reach. See that module's header for why the
 * registry moved out instead of main.ts exporting a registrar.
 */
function ownedNotice(): (message: string) => void {
	let notice: Notice | null = null;
	// The rewrite half and the unload half are the same act - put down
	// whatever this slot is still showing - so they are the same function.
	const clear = (): void => {
		if (notice?.messageEl?.isConnected) notice.hide();
		notice = null;
	};
	ownedNoticeHiders.push(clear);
	return (message: string) => {
		clear();
		notice = new Notice(message);
	};
}

/**
 * The six rapid-fire toggles whose Notice names an on/off (or on/fallback)
 * state, each with its own owned Notice: the pen-input switch - `Pen on / off`
 * and the strip's keyboard button, which write the same flag and therefore
 * share this one slot - and the four tip modes beside it on the strip - eraser,
 * lasso, insert space and pan - that already share `tipModeOffNotice` for
 * their OFF wording and now share this for how the toast behaves under a
 * spammed button; and `mouse-ink-toggle`, which is not a strip button but is
 * the same defect shape (Alan: "when spamming the toast for keyboard doesnt
 * have the current state last" describes this toggle just as well - it is a
 * hotkey, and a hotkey spams faster than a finger). Six separate slots, not
 * one shared: pressing Mouse and then Pen must read as two different pieces
 * of news, not one toggle's stale repeat of the other.
 */
const showPenToggleNotice = ownedNotice();
const showEraserToggleNotice = ownedNotice();
const showLassoToggleNotice = ownedNotice();
const showSpaceToggleNotice = ownedNotice();
const showPanToggleNotice = ownedNotice();
const showMouseInkToggleNotice = ownedNotice();

/**
 * Put every owned Notice down. Unload's half of `ownedNotice`.
 */
export function hideOwnedNotices(): void {
	for (const hide of ownedNoticeHiders) hide();
}

/**
 * Everything the pen-input rule (PenCommand.ts) needs and cannot reach: the
 * nib, the four tip modes, and the chrome that follows the switch.
 *
 * ONE OBJECT FOR BOTH PATHS - the `Pen on / off` command and the strip's
 * keyboard button - so neither can grow its own idea of what picking a pen
 * means or what has to be redrawn afterwards.
 *
 * `afterFlip` is the OLD `pen-ink-toggle` callback's tail, moved here
 * unchanged and in its own order; its comments are the reason each line is
 * there and none of them has stopped being true:
 *
	 *   - the live stroke first, before any chrome. OFF preserves an owned mouse
	 *   - OFF preserves an owned mouse until its own lift while committing
	 *     pen/touch; ON and other teardown callers retain the default forced
	 *     finish, with the pdf half riding the strip registry.
 *   - the pen UI on the ON side unconditionally, the rule every tool command
 *     follows, and it matters most here because the strip is the way BACK.
 *     OFF raises it only once a real pen has been seen on this device (alan,
 *     "and hide") - `shouldRaiseStripOnPenOff` is `penHardwareSeen`, not
 *     `penSeenThisSession`, and PenToolsMode.ts says why.
 *   - OFF strands a hover reticle exactly as mouse ink going off does: no
 *     further hover samples will arrive to redraw from, so the ring and
 *     `cursor: none` would sit there until the watchdog happened to fire.
 *
 * SESSION ONLY, still. Nothing here writes data.json, deliberately and unlike
 * `mouse-ink-toggle`: pen input defaults to ON at every launch so nobody opens
 * the app tomorrow to a plugin that looks broken (design §5).
 */
const penInkCommandHost: PenCommandHost = {
	tool: () => getInlineTool(),
	tipMode: () =>
		getInlineEraserMode() || getInlineLassoMode() || getInlineSpaceMode() || getInlinePanMode(),
	pickPen: () => {
		// Picking a nib is also the exit from eraser and lasso modes: on the
		// strip, Pen LOOKS like the way out, so it has to be.
		setInlineTool("pen");
		setInlineEraserMode(false);
		setInlineLassoMode(false);
		setInlineSpaceMode(false);
		setInlinePanMode(false);
	},
	afterFlip: (on: boolean) => {
		endLiveStrokesEverywhere(!on);
		if (on || shouldRaiseStripOnPenOff(penHardwareSeen())) markPenSeen();
		refreshPenToolsAll();
		refreshAllStrips();
		if (!on) hidePenCursorsEverywhere();
	},
};

export default class HandwritingPlugin extends Plugin {
	store!: PageStore;
	settings: HandwritingSettings = { ...DEFAULT_SETTINGS };
	/** Set at load: no settings file at all means a first-ever install. */
	freshInstall = false;
	settingsDirty = false;
	/**
	 * data.json existed but could not be read or parsed at launch, even after
	 * retrying. The session runs on defaults and NOTHING writes the file until
	 * a clean read (another device's save arriving, or the next launch), so the
	 * defaults can never replace the settings the file still holds.
	 */
	settingsReadFailed = false;
	/**
	 * The settings as they were on disk when last read or written, in this
	 * build's normalised form. A key whose in-memory value differs from this is
	 * one this device changed; every other key follows the file.
	 */
	settingsBaseline: Record<string, unknown> = {};
	settingsTimer: number | null = null;
	/** persistSettings' one-deep latch: another write wanted once this one lands. */
	settingsWriteAgain = false;
	/** persistSettings' in-flight write, or null when nothing is writing. */
	settingsWriting: Promise<void> | null = null;
	/**
	 * Every gated command's definition, by bare id, as `addGatedCommand` saw it.
	 *
	 * Kept because "Extra commands for hotkeys" is a live switch now: turning it
	 * back on has to hand the same definitions to `addCommand` again, and onload
	 * is the only place that knows them. See `applyGatedCommandRegistration`.
	 */
	readonly gatedCommandDefs = new Map<string, Command>();

	/**
	 * Re-identifications waiting for a changed PDF to settle, by path. `panes`
	 * is null for every pane on the file, or the panes a stroke held back.
	 */
	pdfModifyTimers?: Map<string, { timer: number; panes: Set<HTMLElement> | null }>;

	/**
	 * The newest identification started for each pane. A changed PDF can be
	 * identified again while an earlier identification of the same file is
	 * still reading it (a whole-file read on mobile, a large scan). Both pass a
	 * guard that checks only the pane and its path, so the one that finished
	 * last won, and that could be the older revision's id: the pane's ink went
	 * to the wrong sidecar. An identification that a newer one has overtaken
	 * stops at its next guard.
	 */
	pdfResolveTokens?: WeakMap<HTMLElement, object>;

	/**
	 * Which surface the PALETTE and the hotkeys act on: the inline overlay for
	 * the active note, or a PDF controller for the active PDF. Strip buttons
	 * do NOT come through here - a button knows the controller it is mounted
	 * on and asks it directly (PdfInkController.stripExec, audit doc §5k/AD1).
	 *
	 * Without this, `delete/copy/cut-selected-ink` and `paste-ink` only ever
	 * asked `overlayForPath`, so a focused PDF hid them from the palette and
	 * a hotkey learned on notes did nothing there - silently, the same
	 * failure the PDF strip's `exec` interception was worked around.
	 *
	 * Three answers, in this order, because the same PDF can be open in
	 * several panes and the first version took whichever pane the Map happened
	 * to hold first (audit doc §5k/AD2: lasso in the second pane, palette
	 * Delete, "lasso some ink first" with the lasso on screen):
	 *
	 * 1. The ACTIVE LEAF's own controller, the pane the user is looking at -
	 *    the same leaf-to-root mapping `syncPdfControllers` keys everything by.
	 * 2. Failing that, the controller holding a selection on this path, since
	 *    a selection is unambiguous evidence of which pane is meant.
	 * 3. Failing that, any controller on the path - a command with no
	 *    selection anywhere (paste) has to land somewhere, and every pane on
	 *    the path shows the same document's ink.
	 *
	 * Step 1 is checked first and returns before step 2 ever runs its own
	 * selection search: an active pane with no selection of its own still
	 * beats a background pane that happens to hold one. A selection is only
	 * the tiebreaker among panes that are NOT the one on screen - never a
	 * reason to reach past it. That is the design, not an oversight
	 * (1.4.6-design.md 5m/AF7).
	 */
	activeInkSurface(): { kind: "inline"; overlay: InkOverlayPlugin } | { kind: "pdf"; controller: PdfInkController } | null {
		const file = this.app.workspace.getActiveFile();
		if (!file) return null;
		if (file.extension.toLowerCase() === "pdf") {
			const root = this.app.workspace.getActiveViewOfType(View)
				?.containerEl;
			if (root && this.pdfFiles.get(root) === file.path) {
				const focused = this.pdfInk.get(root);
				if (focused) return { kind: "pdf", controller: focused };
			}
			const holding = this.pdfControllerWithSelection(file.path);
			if (holding) return { kind: "pdf", controller: holding };
			for (const [anyRoot, at] of this.pdfFiles) {
				if (at !== file.path) continue;
				const controller = this.pdfInk.get(anyRoot);
				if (controller) return { kind: "pdf", controller };
			}
			return null;
		}
		// The pane the user is IN, not the first pane that mounted this path.
		// The PDF branch above has asked which pane is active since 1.4.6
		// (AD2); this branch asked `overlayForPath(file.path)`, which answers
		// the first mounted overlay - so with two editors open on one note the
		// palette and the hotkeys deleted the other pane's ink, copied the
		// other pane's ink, and put the undo step in the other pane, where the
		// user's own Undo could not reach it.
		//
		// Identity on both halves, and null rather than a fallback: a path is
		// shared by every pane on the note, and a refused command is
		// recoverable where a delete in the wrong pane is not. This is also
		// what Paste follows - it is the fourth caller here, and it lands ink
		// in the active pane for the same reason the other three take from it.
		const active = this.app.workspace.activeEditor;
		const editor = active?.editor;
		if (!active || !editor || active.file !== file) return null;
		const overlay = overlayForActiveEditor(editor, file);
		return overlay ? { kind: "inline", overlay } : null;
	}

	/**
	 * Has `onunload` run? Read by every callback deferred to `onLayoutReady`.
	 *
	 * `onLayoutReady` is not cancellable and it is not a registered event, so
	 * Obsidian's teardown does not take these back the way it takes back
	 * `registerEvent` handlers: a plugin disabled between onload and the
	 * layout settling still gets its callbacks, into a vault that no longer
	 * has the plugin. V2's `applyPaper` re-added the paper class right after
	 * `onunload` removed it, updateStatusBarClass re-stamped the body, and
	 * showWhatsNewIfDue would have spent the one-launch toast on a session
	 * nobody saw (1.4.6-design.md §5k/AD6). One flag, checked at the top of
	 * all three, rather than three different answers to the same question.
	 */
	unloaded = false;
	/** The note whose sidecar `applyStatusBarVisibility` is reading; see there. */
	statusBarReadFor: string | null = null;
	notePaper: NotePaper | null = null;
	canvasOverride: CanvasNoteOverride | null = null;
	headerActionRefresh: (() => void) | null = null;

	/** One ink controller per open PDF view, keyed by its root element. */
	pdfInk = new Map<HTMLElement, PdfInkController>();
	/**
	 * What the reload poll actually did, counted for the report.
	 *
	 * Before today every tick was a check: one stat per open document per
	 * second, forever. `hidden` and `spaced` are the checks not made.
	 */
	pollStats = { ticks: 0, hidden: 0, spaced: 0, checks: 0 };
	/** Every open PDF's sidecar id, resolved from its bytes. */
	pdfIds = new Map<HTMLElement, string>();
	/**
	 * Which file each PDF view is currently showing.
	 *
	 * A leaf outlives the file in it: opening a second PDF in the same pane
	 * reuses the view, the root element and therefore the controller. Without
	 * noticing the change, the second document's ink would be written into the
	 * FIRST document's sidecar - which is not a glitch, it is one document's
	 * annotations landing in another's file.
	 */
	pdfFiles = new Map<HTMLElement, string>();
	/** The vault path each PDF ink id was resolved from this session; outlives the pane. Cleared on unload. */
	pdfPathById?: Map<string, string>;
	/**
	 * The id each pane's identification has chosen but not yet claimed, with
	 * the path it chose it for. resolvePdfId claims only after the sidecar has
	 * loaded, and a byte-identical copy identified during that load must still
	 * see the choice, or both files are handed one instance.
	 */
	pdfResolving?: Map<HTMLElement, { id: string; path: string }>;
	/** Session ink for PDFs. Separate instance from the note store, by design. */
	pdfStore = new PdfInkStore();
	/** M1 only: draw calibration crosses instead of real ink. Off by default. */
	pdfCalibration = false;
	/** Page-id ownership ledger (duplicate detection, v0.13.6). */
	pageIds = new PageIdIndex();
	/** Collisions with no safe owner: id → the paths locked over it. */
	ambiguousIds = new Map<string, string[]>();
	pageIdWatchReady = false;
	/** Deleted pages waiting out the delete+create window, with the path each was deleted at. See scheduleRecycle. */
	pendingRecycle = new Map<string, { timer: number; path: string }>();
	/** Notes whose id went missing, waiting to be confirmed. See declaimLater. */
	declaimTimers = new Map<string, number>();
	/** Notes whose record declaimNow dropped; reloaded if their id comes back. */
	declaimedPaths = new Set<string>();
	/** Notes already warned about an unusable page id; see warnUnusablePageId. */
	badPageIds = new Set<string>();
	/**
	 * Duplicate repairs in flight, keyed by the note's TFile: it keeps its
	 * identity through a rename, so a second call naming the renamed path
	 * while the first awaits is still the same note.
	 */
	resolvingDuplicates = new Set<TFile>();

	/** One last Escape listener per window, including popouts already open at plugin load. */
	installEscapeWindows(): {open(win: Window): void; close(win: Window): void} {
		const windows = new Map<Window, {doc: Document; dispose(): void}>();
		let disposed = false;
		const open = (win: Window): void => {
			if (disposed || windows.has(win)) return;
			const doc = win.document;
			const dispose = bindInkEscapeWindow(win, event => {
				if (peelInlineEscapeSelection(doc, event)) return true;
				for (const [root, controller] of this.pdfInk) {
					if (root.ownerDocument === doc && controller.peelEscapeSelection(event)) return true;
				}
				return false;
			});
			windows.set(win, {doc, dispose});
		};
		const close = (win: Window): void => {
			const entry = windows.get(win);
			if (!entry) return;
			entry.dispose();
			windows.delete(win);
			closeInlineInkDocument(entry.doc);
			for (const [root, controller] of [...this.pdfInk]) {
				if (root.ownerDocument !== entry.doc) continue;
				controller.unmount();
				const id = this.pdfIds.get(root);
				this.pdfInk.delete(root);
				this.pdfIds.delete(root);
				this.pdfFiles.delete(root);
				if (id) this.releasePdfId(id);
			}
		};
		open(window);
		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) return;
			this.app.workspace.iterateAllLeaves(leaf => {
				const win = leaf.view.containerEl.ownerDocument.defaultView;
				if (win) open(win);
			});
		});
		this.register(() => {
			disposed = true;
			for (const entry of windows.values()) entry.dispose();
			windows.clear();
		});
		return {open, close};
	}

	/**
	 * The ink trace commands' recorder, held here so unload can reach it. The
	 * trace itself runs in Electron's main process and would outlive this
	 * plugin. Resolved when a command or unload runs, never at load.
	 */
	readonly inkTrace = new InkTraceRecorder(
		() => resolveContentTracing(),
		() => {
			const base = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
			return base && this.manifest.dir ? `${base}/${this.manifest.dir}` : null;
		}
	);

	async onload(): Promise<void> {
		await this.onloadDevice();
		this.onloadStore();
		await this.loadSettings();
		// After the PDF host is attached in loadSettings: restoring a deletion
		// can load and write sidecars.
		this.attachPdfPendingDeletes();

		this.onloadViews();

		this.onloadEmbeds();
		this.onloadNoteChrome();
		this.onloadLiveReload();
		this.registerCommands({ TRACE_UPLOAD_URL, loadedBuild, penInkCommandHost, penToggleNoticeText, platformOs, showPenToggleNotice, showEraserToggleNotice, showLassoToggleNotice, showSpaceToggleNotice, showPanToggleNotice, showMouseInkToggleNotice });


		this.onloadVaultEvents();

		this.onloadWorkspace();

		this.onloadFlushAndForeground();

		this.onloadPageIdWatch();
	}

	/** Status-bar dot while a bug-report recording is running. A toast was
	 * the only sign, and a toast is gone in seconds - people forgot it was
	 * on and wondered why nothing said so. */
	recordingBadge: HTMLElement | null = null;

	/** The writer identity of the running slides ink, or null while it is off. */
	slidesWriter: string | null = null;

	/** An ink-folder move is running or about to: from the first step of changeInkFolder, before the store holds writes. */
	inkFolderMoveInFlight = false;

	/**
	 * The mode `applyBooxMode` last actually applied, so a real transition can
	 * be told from a reapplication. Undefined until the first call - field
	 * initialisers do not run for the `Object.create` instances the tests use -
	 * and that first call counts as a change, so a session starts with no
	 * pending hint evidence.
	 */
	booxModeApplied: boolean | undefined;
}

export { HandwritingPlugin };

/** The operating system as Platform reports it, for bug-report headers. */
function platformOs(): string {
	// The mobile apps first: Obsidian sets isMacOS on iPhone and iPad too.
	if (Platform.isIosApp) return "ios";
	if (Platform.isAndroidApp) return "android";
	if (Platform.isWin) return "windows";
	if (Platform.isMacOS) return "macos";
	if (Platform.isLinux) return "linux";
	return "unknown";
}

installPluginSettings(HandwritingPlugin.prototype);
installDeleteAllInk(HandwritingPlugin.prototype);
installRecycleOnDelete(HandwritingPlugin.prototype);
installPdfClaims(HandwritingPlugin.prototype);
installPageIdentity(HandwritingPlugin.prototype);
installSnips(HandwritingPlugin.prototype);
installHeaderActions(HandwritingPlugin.prototype);
installRegisterCommands(HandwritingPlugin.prototype);
installRegisterDiagCommands(HandwritingPlugin.prototype);
installRegisterExportCommands(HandwritingPlugin.prototype);
installPluginApply(HandwritingPlugin.prototype);
installPluginLifecycle(HandwritingPlugin.prototype);
installPluginOnload(HandwritingPlugin.prototype);
installPluginOnloadReload(HandwritingPlugin.prototype);
