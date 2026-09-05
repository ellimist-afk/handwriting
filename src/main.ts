import { requestUrl, App, MarkdownRenderChild, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, SettingDefinitionItem, TAbstractFile, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import { formatHost } from "./diag/PlatformCapabilities";
import { CameraState } from "./camera/coordinates";
import { HANDWRITING_PAGE_VIEW_TYPE, HandwritingHost, HandwritingPageView } from "./view/HandwritingPageView";
import {
	HANDWRITING_DIAGNOSTICS_VIEW_TYPE,
	PenDiagnosticsView,
} from "./input/PenDiagnosticsView";
import { HANDWRITING_PEN_LAB_VIEW_TYPE, PenLabView } from "./view/PenLabView";
import {
	addStripSurface,
	hidePenCursorsEverywhere,
	copyInlineInkMetrics,
	copyInlineZoomReport,
	copyPresentationReport,
	copyRegionCensus,
	deleteAllInkOn,
	getEraserRadiusPx,
	getInkSizeMult,
	getInlineEraserMode,
	getInlineLassoMode,
	getInlinePanMode,
	getInlineSpaceMode,
	getInlineTool,
	inkExternallyReloaded,
	inkOverlayExtension,
	inlineInk,
	inlineReloadCandidates,
	InkOverlayPlugin,
	overlayForPath,
	refreshPenToolsAll,
	refreshAllStrips,
	repaintAllInkOverlays,
	setEraserRadiusPx,
	setEraserWholeStrokes,
	setInkSizeMult,
	setInlineEraserMode,
	setInlineLassoMode,
	setInlinePanMode,
	setInlineSpaceMode,
	setInlineTool,
	setPenReticle,
	setPersistEraserMode,
	setPersistEraserRadius,
	setPersistInkSize,
	setShapeSnap,
	setToolbarCorner,
} from "./inline/InkOverlay";
import { destroyProbeMarkers } from "./inline/PenProbe";
import { captureInlinePenTrace, clearInlinePenTrace, formatInlinePenTrace } from "./inline/InlinePenRouter";
import {
	clearHitProbe,
	formatHitReport,
	isHitProbeEnabled,
	setHitProbeEnabled,
} from "./inline/PenHitProbe";
import { clearScrollProbe, formatScrollProbe } from "./inline/ScrollProbe";
import { surfaceExtents } from "./inline/SurfaceExtent";
import { claimMarkdown, reassignMarkdown } from "./inline/InlineClaim";
import { INK_SIZE_STEPS, clampInkSize, nextInkSize } from "./ink/InkSize";
import { DEFAULT_ERASER_RADIUS_PX, clampEraserRadius, nextEraserSize } from "./ink/EraserSize";
import { setPressureSensitivity, pressureSensitivityEnabled } from "./ink/PenStyle";
import { setInkShaping } from "./ink/InkShape";
import {
	HIGHLIGHTER_COLORS,
	PEN_COLORS,
	colorsFor,
	getInkColorHex,
	nextInkColor,
	normalizeInkColor,
	setInkColorHex,
	setPersistInkColor,
} from "./ink/InkColor";
import {
	diagnosticsEnabled,
	setDiagnosticsChangedListener,
	setDiagnosticsEnabled,
} from "./diag/DiagSwitch";
import { traceGuardVerdict } from "./diag/TraceGuard";
import {
	armMouseInkQuietly,
	consumeMousePutDown,
	mouseInkEnabled,
	setMouseInk,
} from "./inline/MouseInk";
import { setPrediction, setPredictionEink } from "./inline/StrokePrediction";
import { PaperStyle, nextPaperStyle, normalizePaperStyle, paperClass } from "./inline/Paper";
import { inkToSvg } from "./ink/SvgExport";
import { InkTool } from "./ink/Stroke";
import { appendInkToPdf, flattenedPdfPath } from "./ink/InkPdfAppend";
import { inkToPdf } from "./ink/InkPdf";
import { bytesOf } from "./pdf/PdfSyntax";
import { createFreshFile } from "./export/CreateFreshFile";
import { clipboardSize } from "./inline/InkClipboard";
import {
	attachEmbedInk,
	disarmPrintSwaps,
	teardownEmbedInk,
	embedInkChanged,
	embedInkRoot,
	initEmbedInkRefresh,
} from "./inline/EmbedInk";
import { notifyInkChanged, onInkChanged } from "./inline/InkEvents";
import {
	PenToolsMode,
	clearPenHardwareSeen,
	getPenToolsMode,
	markPenSeen,
	penSeenThisSession,
	nextPenToolsMode,
	normalizePenToolsMode,
	setPenToolsMode,
} from "./inline/PenToolsMode";
import { DiagnosticTextModal, showDiagnosticText } from "./diag/DiagnosticTextModal";
import { pdfInkReport } from "./pdf/PdfInkReport";
import { PdfInkController } from "./pdf/PdfInkController";
import { calibrationStrokes } from "./pdf/PdfCalibration";
import { PdfInkStore } from "./pdf/PdfInkStore";
import {
	InstanceClaim,
	chooseInstance,
	familyOf,
	isPdfInkId,
	pdfInkIdFromHead,
} from "./pdf/PdfIdentity";
import { HeadSource, RangedHandle, readPdfHead } from "./pdf/PdfHead";
import { applyOp } from "./pdf/PdfInkHistory";
import { isSafePageId, newPageId } from "./model/PageData";
import { PageIdIndex, RegisterVerdict } from "./model/PageIdIndex";
import { newPageMarkdown } from "./model/MarkdownPage";
import { PageStore } from "./persistence/PageStore";
import { runDetached } from "./util/Detached";
import { decideWhatsNew, whatsNewDurationMs, whatsNewFragment } from "./update/WhatsNew";
import {
	adoptInkFolder,
	changeFolder,
	DEFAULT_INK_FOLDER,
	inkFolderSyncs,
	migrateInkFolder,
	normalizeInkFolder,
	SYNCED_INK_FOLDER,
} from "./persistence/InkFolder";
import {
	DEFAULT_TOOLBAR_CORNER,
	TOOLBAR_CORNER_LABELS,
	ToolbarCorner,
	normalizeToolbarCorner,
} from "./inline/ToolbarCorner";
import {
	IOS_WEBKIT_CEILING,
	initPressureGain,
	resetPressureCalibration,
	setPressureStore,
} from "./ink/PressureGain";

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
 * How long a deleted note has to come back before its ink is recycled.
 *
 * Sync tools and git express a rename or a branch switch as delete+create,
 * and the pair can be seconds apart on a slow vault. Long enough to cover
 * that; short enough that a real delete's ink reaches the trash while the
 * user still remembers deleting it. Nothing is destroyed either way - the
 * recycle is a move into .handwriting/trash.
 */
const RECYCLE_GRACE_MS = 10_000;

/**
 * How long a note's page id may be unreadable before we believe it is gone.
 *
 * Long enough to cover a frontmatter block being edited - Obsidian re-parses
 * on every keystroke and an unfinished property reports no frontmatter at all
 * - and short enough that a genuine removal frees the id while the user is
 * still doing whatever prompted it.
 */
const DECLAIM_GRACE_MS = 2_000;

interface HandwritingSettings {
	/** Per-page camera, kept out of the synced note on purpose (§22). */
	cameras: Record<string, CameraState>;
	/** Nib size multipliers per tool (v0.13.6): 0.6 fine · 1 medium · 1.8 bold. */
	inkSizes: { pen: number; highlighter: number };
	/**
	 * Shaped ink rendering (v0.13.10): velocity thinning, filtered pressure
	 * Off pins pressure to its no-pressure value, so width stops following how
	 * hard you press. Speed thinning and the endpoint taper stay in both
	 * states. Applied at render time, so flipping this restyles every stroke
	 * ever written.
	 */
	pressureSensitivity: boolean;
	/** Shaped ribbon: velocity thinning and the start/end taper. */
	inkSmoothing: boolean;
	/** Vault folder holding the ink sidecars. Default `.handwriting`. */
	inkFolder: string;
	/** Which corner the floating pen toolbar parks in. Default top-right. */
	toolbarCorner: ToolbarCorner;
	/** Selected ink color per tool (v0.13.6), hex. */
	inkColors: { pen: string; highlighter: string };
	/**
	 * Which note owned each page id last session (v0.13.6). This is the
	 * cross-session evidence that lets a duplicate discovered at startup
	 * (a copy made while the app was closed) resolve safely: the remembered
	 * path is the original, everything else carrying the id is a copy.
	 */
	pageOwners: Record<string, string>;
	/** Eraser radius in screen px (v0.13.13): 8 fine, 14 medium, 28 bold. */
	eraserRadiusPx: number;
	/** Mouse-ink mode (v0.13.16): left mouse button draws like a pen tip. */
	mouseInk: boolean;
	strokePrediction: boolean;
	booxMode: boolean;
	/** Ruled paper background (v0.13.16): none, lines or grid. Per device. */
	paperStyle: PaperStyle;
	/** Pen tools strip (v0.13.16): auto (pen summons it), show, or hide. */
	penTools: PenToolsMode;
	/** What the eraser erases, globally (1.0.9): whole strokes by default. */
	eraserMode: "stroke" | "reticle";
	/** The reticle that follows the pen tip (1.0.5). On by default. */
	penReticle: boolean;
	/** Hold-at-end snaps the figure to a clean shape (1.0.14). Default on. */
	shapeSnap: boolean;
	/** Shows the developer diagnostics commands in the palette. */
	devDiagnostics: boolean;
	/** One command per colour and per nib size, for hotkeys. */
	colorSizeCommands: boolean;
	/**
	 * The version whose notes this vault has already been shown. Null until
	 * a release with notes has been seen. A brand new install is told apart
	 * by whether a settings file existed at all rather than trusting this.
	 */
	lastSeenVersion: string | null;
}

const DEFAULT_SETTINGS: HandwritingSettings = {
	cameras: {},
	inkSizes: { pen: 1, highlighter: 1 },
	pressureSensitivity: true,
	inkSmoothing: true,
	inkColors: { pen: PEN_COLORS[0]!.hex, highlighter: HIGHLIGHTER_COLORS[0]!.hex },
	pageOwners: {},
	eraserRadiusPx: DEFAULT_ERASER_RADIUS_PX,
	mouseInk: false,
	// On by default since 1.4.5. It was off for e-ink's sake (see
	// StrokePrediction.ts); e-ink has Boox mode now, so the default serves
	// everyone else.
	strokePrediction: true,
	booxMode: false,
	paperStyle: "none",
	penTools: "auto",
	eraserMode: "stroke",
	penReticle: true,
	shapeSnap: true,
	devDiagnostics: false,
	colorSizeCommands: false,
	lastSeenVersion: null,
	toolbarCorner: DEFAULT_TOOLBAR_CORNER,
	inkFolder: DEFAULT_INK_FOLDER,
};

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
 * How many one-second ticks to skip between sidecar checks.
 *
 * One second while ink is arriving, stretching to five when it is not. What
 * is being spread out is a filesystem stat per open document, which is this
 * plugin's largest standing cost when nothing at all is happening - it runs
 * whether or not a second device exists.
 */
function reloadStride(quietTicks: number): number {
	return Math.min(5, 1 + Math.floor(quietTicks / 5));
}

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

export default class HandwritingPlugin extends Plugin implements HandwritingHost {
	store!: PageStore;
	settings: HandwritingSettings = { ...DEFAULT_SETTINGS };
	/** Set at load: no settings file at all means a first-ever install. */
	private freshInstall = false;
	private settingsDirty = false;
	private settingsTimer: number | null = null;
	/** persistSettings' one-deep latch: another write wanted once this one lands. */
	private settingsWriteAgain = false;
	/** persistSettings' in-flight write, or null when nothing is writing. */
	private settingsWriting: Promise<void> | null = null;
	/** Files we are mid-swap on, so layout events don't fight each other. */
	private swapping = new Set<string>();

	/**
	 * Attach an ink controller to every open PDF view, and drop the ones whose
	 * views are gone.
	 *
	 * Keyed by root element, and swept by checking `isConnected`, because a
	 * leaf outlives the file in it: closing a PDF and opening another reuses
	 * the leaf, and a map keyed on the leaf would hand the new document the
	 * old document's overlays.
	 */
	private syncPdfControllers(): void {
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
					this.pdfIds.delete(root);
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
				(id) => this.pdfStore.save(id),
				// Both sources above are substituted under calibration, so the
				// document the controller reads is made up and nothing it works
				// out from it may be written. Set HERE, next to the
				// substitution, so a third synthetic source is one line from
				// being covered instead of one id prefix from being missed.
				() => this.pdfCalibration
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
			this.pdfInk.delete(root);
			this.pdfIds.delete(root);
			this.pdfFiles.delete(root);
		}
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
	private async resolvePdfId(
		leaf: WorkspaceLeaf,
		root: HTMLElement,
		controller: PdfInkController
	): Promise<void> {
		const file = (leaf.view as unknown as { file?: TFile }).file;
		if (!file) return;
		const path = file.path;
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
		if (!root.isConnected || this.pdfFiles.get(root) !== path) return;
		const family = await pdfInkIdFromHead(head, byteLength, window.crypto);
		if (!root.isConnected || this.pdfFiles.get(root) !== path) return;
		// Which INSTANCE of the content family this file is. Byte-identical
		// copies are one family, but each vault file is its own instance -
		// launch day proved why: a re-export of an unchanged OneNote page
		// arrived already wearing the original's ink (2026-09-01). The
		// sidecars' own path claims decide; see PdfIdentity.chooseInstance.
		const candidates: InstanceClaim[] = [];
		for (const cid of (await this.store.listIds(family)).filter((i) => familyOf(i) === family)) {
			const res = await this.store.load(cid);
			candidates.push({ id: cid, paths: res?.data.pdfPaths ?? [] });
		}
		if (!root.isConnected || this.pdfFiles.get(root) !== path) return;
		const choice = chooseInstance(
			family,
			path,
			candidates,
			(p) => this.app.vault.getFileByPath(p) !== null
		);
		this.pdfIds.set(root, choice.id);
		await this.pdfStore.ensureLoaded(choice.id);
		// The fourth await, and the guard the first three already carry: the
		// pane can change document across this one too, and what follows is
		// the durable half - claimPath writes this path into that sidecar, and
		// the refresh paints its ink. Without the re-check a resolution that
		// lost the race stamped the earlier document's path onto the later
		// document's sidecar. The id set above is deliberately before the
		// await - the controller must be able to ask for it the moment the
		// choice is made - and a stale one is corrected by the next sync,
		// which is what clears pdfIds when the pane's file changes.
		if (!root.isConnected || this.pdfFiles.get(root) !== path) return;
		// Always claimed: an adoption becomes durable at once, a fresh
		// instance merely remembers until its first stroke, and a repeat
		// claim is a no-op.
		this.pdfStore.claimPath(choice.id, path);
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
	private pdfHeadSource(file: TFile): HeadSource {
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
	 * The ink id of an open PDF, or null while it is still being hashed.
	 *
	 * By path rather than by pane, because the command acts on the active
	 * FILE. The same document open in two panes resolves to the same id, so
	 * which one answers does not matter.
	 */
	private pdfIdForPath(path: string): string | null {
		for (const [root, at] of this.pdfFiles) {
			if (at === path) return this.pdfIds.get(root) ?? null;
		}
		return null;
	}

	/**
	 * The confirmed pdf wipe. Same permanence invariant as the note wipe: the
	 * trash copy is made FIRST and a failed copy aborts everything -
	 * Handwriting never deletes ink it could not preserve. `preserve` also
	 * flushes any pending write, so the copy holds today's ink, not
	 * yesterday's file.
	 *
	 * The controllers' undo history is cleared rather than left holding ops
	 * against strokes that no longer exist: an undo replayed across the wipe
	 * would restore a fragment and call it the past. The trash copy is the
	 * recovery path, and the dialog said so.
	 */
	private async deleteAllPdfInk(id: string): Promise<void> {
		let kept: string | null = null;
		try {
			kept = await this.store.preserve(id);
		} catch (err) {
			console.error("[handwriting] delete-all-pdf-ink backup failed", err);
			new Notice(
				"Handwriting: could not copy this PDF's ink to the trash (disk error). Nothing was deleted."
			);
			return;
		}
		const n = this.pdfStore.strokes(id).length;
		this.pdfStore.replaceAll(id, []);
		for (const [root, controller] of this.pdfInk) {
			if (this.pdfIds.get(root) === id) {
				controller.forgetHistory();
				controller.refresh();
			}
		}
		const what = n === 1 ? "1 stroke" : `${n} strokes`;
		new Notice(
			kept
				? `Handwriting: removed ${what}. A copy is kept in ${kept}.`
				: `Handwriting: removed ${what}.`
		);
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
	private pdfControllerWithSelection(path: string): PdfInkController | null {
		for (const [root, at] of this.pdfFiles) {
			if (at !== path) continue;
			const c = this.pdfInk.get(root);
			if (c?.hasSelection) return c;
		}
		return null;
	}

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
	private activeInkSurface(): { kind: "inline"; overlay: InkOverlayPlugin } | { kind: "pdf"; controller: PdfInkController } | null {
		const file = this.app.workspace.getActiveFile();
		if (!file) return null;
		if (file.extension.toLowerCase() === "pdf") {
			const root = (this.app.workspace.activeLeaf?.view as unknown as { containerEl?: HTMLElement } | undefined)
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
		const overlay = overlayForPath(file.path);
		return overlay ? { kind: "inline", overlay } : null;
	}

	/**
	 * The first path in a numbered series that nothing occupies yet.
	 * `candidate(1)` is the plain name; the count only shows once it must.
	 *
	 * Asked of the adapter rather than the vault index: a file another
	 * device dropped in through sync exists on disk before the index has
	 * seen it, and the index saying "free" would have this overwrite it.
	 *
	 * This alone does not close the gap between choosing a name and writing
	 * it - two exports started close together can still land on the same
	 * answer. Every write site calls this through `createFreshFile`
	 * (src/export/CreateFreshFile.ts), which re-asks on a create failure
	 * instead of trusting a single answer from here; the guarantee that a
	 * second export does not overwrite the first lives there, not in this
	 * function.
	 */
	private async firstFreePath(candidate: (n: number) => string): Promise<string> {
		for (let n = 1; ; n++) {
			const path = normalizePath(candidate(n));
			if (!(await this.app.vault.adapter.exists(path))) return path;
		}
	}

	/** The note twin of snipPdf: ink on white, counted name, embed copied. */
	private async snipNote(file: TFile, overlay: InkOverlayPlugin): Promise<void> {
		const snip = await overlay.snipSelection();
		if (!snip.ok) {
			new Notice(`Handwriting: ${snip.reason}`);
			return;
		}
		const base = file.path.replace(/\.md$/, "");
		const out = await this.firstFreePath((n) => `${base}.snip-${n}.png`);
		const name = out.split("/").pop() ?? out;
		const taken = this.app.metadataCache.getFirstLinkpathDest(name, file.path) !== null;
		const md = `![[${taken ? out : name}]]
[[${file.basename}]]`;
		let copied = true;
		try {
			await navigator.clipboard.writeText(md);
		} catch {
			copied = false;
		}
		try {
			await this.app.vault.createBinary(out, snip.bytes.buffer as ArrayBuffer);
		} catch (e) {
			console.error("[handwriting] snip the selection", e);
			new Notice(
				copied
					? "Handwriting: the snip could not be written; the embed on your clipboard has nowhere to point"
					: "Handwriting: the snip could not be written"
			);
			return;
		}
		new Notice(
			copied
				? `Handwriting: snipped to ${name}; the embed is on your clipboard`
				: `Handwriting: snipped to ${name}; the clipboard refused the embed`
		);
	}

	/**
	 * Write the snip beside its PDF and put the markdown on the clipboard.
	 * The name counts up rather than overwriting: two snips of one figure
	 * are two attempts, and the second should not eat the first.
	 *
	 * The clipboard is written BEFORE the file. Everything the markdown
	 * needs is known once the name is chosen, and on iPadOS the clipboard
	 * only accepts a write while the tap that ran the command is still
	 * fresh; put it after the disk write and it refuses there every time,
	 * with nothing to say why. Should the write then fail, the notice says
	 * so and the embed on the clipboard points at a file that is not there
	 * - visible and recoverable, where the other order was a silent no.
	 *
	 * The embed is the bare name only while the vault has no other file by
	 * that name. Two `intro.pdf` in different folders both snip to
	 * `intro.snip-1.png`, and Obsidian resolves a bare name to whichever it
	 * finds first - the second paper's note would show the first paper's
	 * figure. The full path is unambiguous, so it is used exactly when the
	 * short one is not. The write goes through the vault so the file is
	 * indexed as it lands: an adapter write is invisible to link resolution
	 * until the watcher catches up, and the paste comes sooner than that.
	 */
	private async snipPdf(file: TFile, controller: PdfInkController): Promise<void> {
		const snip = await controller.snipSelection();
		if (!snip.ok) {
			new Notice(`Handwriting: ${snip.reason}`);
			return;
		}
		const base = file.path.replace(/\.pdf$/i, "");
		const out = await this.firstFreePath((n) => `${base}.snip-${n}.png`);
		const name = out.split("/").pop() ?? out;
		const taken = this.app.metadataCache.getFirstLinkpathDest(name, file.path) !== null;
		const md = `![[${taken ? out : name}]]
[[${file.name}#page=${snip.pageNumber}|${file.basename} p.${snip.pageNumber}]]`;
		let copied = true;
		try {
			await navigator.clipboard.writeText(md);
		} catch {
			copied = false;
		}
		try {
			await this.app.vault.createBinary(out, snip.bytes.buffer as ArrayBuffer);
		} catch (e) {
			console.error("[handwriting] snip the selection", e);
			new Notice(
				copied
					? "Handwriting: the snip could not be written; the embed on your clipboard has nowhere to point"
					: "Handwriting: the snip could not be written"
			);
			return;
		}
		new Notice(
			copied
				? `Handwriting: snipped to ${name}; the embed is on your clipboard`
				: `Handwriting: snipped to ${name}; the clipboard refused the embed`
		);
	}

	/**
	 * A copy of this PDF with its ink drawn in.
	 *
	 * A COPY, and the only step that ever puts ink inside a PDF. Everywhere
	 * else the document on disk stays exactly as it arrived and the ink is an
	 * overlay above it - which is why the viewer's thumbnail sidebar shows
	 * clean pages while the main view shows marked-up ones. That difference is
	 * load-bearing rather than cosmetic: inked thumbnails mean the file itself
	 * carries the ink, so this command's output is distinguishable at a glance
	 * from the original it came from. See PAGE_SELECTOR in PdfViewerProbe.
	 *
	 * The bytes are re-read here rather than kept from the open view: sync may
	 * have replaced the document on disk since it was opened, and flattening
	 * onto a stale copy writes a file that matches neither.
	 *
	 * A refusal is shown and nothing is written. `appendInkToPdf` says why in
	 * words, and its reasons are things the reader can act on - an encrypted
	 * document, a format this cannot restate - so they are repeated rather
	 * than flattened into "it did not work".
	 */
	private async flattenPdf(file: TFile, id: string): Promise<void> {
		const bytes = new Uint8Array(await this.app.vault.readBinary(file));
		const result = appendInkToPdf(bytes, this.pdfStore.strokes(id));
		if (!result.ok) {
			new Notice(`Handwriting: this PDF cannot be flattened - ${result.reason}`);
			return;
		}
		// Counted, not overwritten - the snip's bargain, now this one's too:
		// two flattens are two attempts, and the second must not eat the
		// first (alan, 2026-08-30). The plain name goes first; the count only
		// appears once it must.
		const base = flattenedPdfPath(file.path).replace(/\.pdf$/, "");
		const { path: out } = await createFreshFile(
			() => this.firstFreePath((n) => (n === 1 ? `${base}.pdf` : `${base}-${n}.pdf`)),
			(path) => this.app.vault.createBinary(path, result.bytes.buffer as ArrayBuffer)
		);
		new Notice(`Handwriting: exported ${out}`);
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
	private unloaded = false;

	/** One ink controller per open PDF view, keyed by its root element. */
	private pdfInk = new Map<HTMLElement, PdfInkController>();
	/**
	 * What the reload poll actually did, counted for the report.
	 *
	 * Before today every tick was a check: one stat per open document per
	 * second, forever. `hidden` and `spaced` are the checks not made.
	 */
	private pollStats = { ticks: 0, hidden: 0, spaced: 0, checks: 0 };
	/** Every open PDF's sidecar id, resolved from its bytes. */
	private pdfIds = new Map<HTMLElement, string>();
	/**
	 * Which file each PDF view is currently showing.
	 *
	 * A leaf outlives the file in it: opening a second PDF in the same pane
	 * reuses the view, the root element and therefore the controller. Without
	 * noticing the change, the second document's ink would be written into the
	 * FIRST document's sidecar - which is not a glitch, it is one document's
	 * annotations landing in another's file.
	 */
	private pdfFiles = new Map<HTMLElement, string>();
	/** Session ink for PDFs. Separate instance from the note store, by design. */
	private pdfStore = new PdfInkStore();
	/** M1 only: draw calibration crosses instead of real ink. Off by default. */
	private pdfCalibration = false;
	/** Notes the user explicitly opened as Markdown this session (§ no bounce-back). */
	private preferMarkdown = new Set<string>();
	/** Page-id ownership ledger (duplicate detection, v0.13.6). */
	private pageIds = new PageIdIndex();
	/** Collisions with no safe owner: id → the paths locked over it. */
	private ambiguousIds = new Map<string, string[]>();
	private pageIdWatchReady = false;
	/** Deleted pages waiting out the delete+create window. See scheduleRecycle. */
	private pendingRecycle = new Map<string, number>();
	/** Notes whose id went missing, waiting to be confirmed. See declaimLater. */
	private declaimTimers = new Map<string, number>();
	/** Notes already warned about an unusable page id; see warnUnusablePageId. */
	private badPageIds = new Set<string>();
	private resolvingDuplicates = new Set<string>();
	/** Paths the user deliberately opened on the canvas (host contract). */
	canvasIntent = new Set<string>();

	async onload(): Promise<void> {
		// Pressure calibration is per DEVICE, so it uses the app's per-vault
		// local store rather than data.json (which syncs, and would let one
		// device's range silence another's). Registered before init, which
		// reads through it.
		setPressureStore({
			load: (key) => this.app.loadLocalStorage(key) as string | null,
			save: (key, value) => this.app.saveLocalStorage(key, value),
		});
		initPressureGain(Platform.isIosApp ? IOS_WEBKIT_CEILING : 0);
		this.store = new PageStore(this.app);
		// Persistence must never fail silently: a write that keeps failing
		// after bounded retries, or an external revision preserved as a
		// conflict file, is surfaced once in words the reader can act on.
		//
		// RC4: both messages name the NOTE. A page id is Handwriting's bookkeeping
		// and is hidden from the Properties UI on purpose, so a truncated one
		// gave the reader nothing they could act on or even look up.
		this.store.onWriteError = (pageId, problem, preservedAs) => {
			new Notice(
				`Handwriting cannot save the ink on "${this.noteNameFor(pageId)}". It is still in this session and Handwriting keeps retrying. Check disk space and permissions.` +
					(preservedAs
						? ` A version of this note's ink from another device is safe at ${preservedAs}.`
						: "") +
					` (${problem})`,
				15000
			);
		};
		// Fires only after this session's save has landed on disk (PageStore
		// holds it back until the final rename), so both halves are true.
		this.store.onConflict = (pageId, keptAs) => {
			new Notice(
				`Handwriting: the ink file for "${this.noteNameFor(pageId)}" was changed outside this session, by sync or another device. That version is kept as ${keptAs}. This session's ink is now saved.`,
				15000
			);
		};
		// The corrupt-file recovery (persistence gate): the interrupted save
		// was complete and is now the main file; the corrupt bytes were kept.
		this.store.onRecovered = (pageId, keptAs) => {
			new Notice(
				`Handwriting recovered the ink on "${this.noteNameFor(pageId)}" from an interrupted save. The unreadable file is kept as ${keptAs}.`,
				15000
			);
		};
		await this.loadSettings();

		this.registerView(HANDWRITING_PAGE_VIEW_TYPE, (leaf) => new HandwritingPageView(leaf, this));
		this.registerView(HANDWRITING_PEN_LAB_VIEW_TYPE, (leaf) => new PenLabView(leaf));
		this.registerView(
			HANDWRITING_DIAGNOSTICS_VIEW_TYPE,
			(leaf) => new PenDiagnosticsView(leaf, this.manifest.version)
		);

		// One ribbon entry, for the standalone canvas. Inking on an ordinary
		// note needs no entry point at all. You write on it.
		// No ribbon icon. The canvas is the older surface, and the most
		// prominent button the plugin ships must not lead a first-time user
		// away from the product (ink on ordinary notes). The view, the
		// commands and the frontmatter routing all stay: existing canvas
		// pages keep working, the palette still reaches it. The icon comes
		// back if the canvas ever gets its own release.

		// Inline ink on the ordinary Markdown editor (architecture review +
		// OneNote-coordinates addendum). Pen-only capture; persistence follows
		// the identity rules: the awaited page-id write precedes any sidecar,
		// and an untouched note costs one metadata lookup and zero writes.
		inlineInk.attachHost({
			readPageId: (path) => {
				const file = this.app.vault.getFileByPath(path);
				if (!file) return null;
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				const id = fm?.["handwriting-page-id"] as unknown;
				// Frontmatter is text a person or a sync peer typed, and this
				// id goes straight into a sidecar path. Anything outside
				// isSafePageId is not "a page with an odd name": the note
				// counts as unclaimed, so the next stroke mints a fresh id
				// and the ink lands in the ink folder like everyone else's.
				if (typeof id === "string" && id.length > 0 && !isSafePageId(id)) {
					this.warnUnusablePageId(path);
					return null;
				}
				return isSafePageId(id) ? id : null;
			},
			claimId: async (path, proposedId) => {
				const file = this.app.vault.getFileByPath(path);
				if (!file) throw new Error(`Handwriting: no file at ${path}`);
				let out: { pageId: string; futureVersion?: number } = { pageId: proposedId };
				await this.app.vault.process(file, (data) => {
					const r = claimMarkdown(data, proposedId);
					out = { pageId: r.pageId, futureVersion: r.futureVersion };
					return r.content;
				});
				// A claim is a first sighting for the ownership ledger. The note
				// that mints an id owns it (duplicate detection, v0.13.6).
				if (out.futureVersion === undefined) {
					if (this.pageIds.register(path, out.pageId).kind === "registered") {
						this.persistOwners();
					}
				}
				return out;
			},
			loadSidecar: (pageId) => this.store.load(pageId),
			scheduleSidecar: (pageId, page) => this.store.schedule(pageId, page),
			scheduleSidecarNow: (pageId, page) => this.store.saveNow(pageId, page),
			notify: (message) => new Notice(message),
		});

		this.registerEditorExtension(inkOverlayExtension());

		// Ink in rendered markdown: embeds and reading view (roadmap). Each
		// section defers via a render child (the element is not in the
		// document during processing); on load it finds the rendered root and
		// the first one attaches the single ink layer. See EmbedInk.ts.
		this.registerMarkdownPostProcessor((el, ctx) => {
			const path = ctx.sourcePath;
			if (!path || !path.endsWith(".md")) return;
			const child = new MarkdownRenderChild(el);
			child.onload = () => {
				// Synchronously when the ink is already in the session, which
				// it is whenever the note is open. An export renders the note
				// and then SERIALIZES it, so ink that arrives on a later tick
				// arrives after the picture was taken - and awaiting a promise
				// that had nothing to do would lose the page its ink for the
				// sake of a microtask.
				if (inlineInk.isLoaded(path)) {
					const root = embedInkRoot(el);
					// Registered even with zero strokes: a note drawn on
					// AFTER its embed rendered still gains ink live.
					if (root) attachEmbedInk(root, path, inlineInk.strokes(path));
					return;
				}
				runDetached(
					inlineInk.ensureLoaded(path).then(() => {
						const root = embedInkRoot(el);
						if (root) attachEmbedInk(root, path, inlineInk.strokes(path));
					}),
					"render ink into an embed"
				);
			};
			ctx.addChild(child);
		});
		// Embed layers stop going stale: every persisted gesture repaints the
		// rendered roots showing that note. See EmbedInk.ts.
		initEmbedInkRefresh((p) => inlineInk.strokes(p));
		this.register(onInkChanged((p) => embedInkChanged(p)));
		this.addSettingTab(new HandwritingSettingTab(this.app, this));
		// A popout is born without the paper class; stamp it as it opens.
		this.registerEvent(
			this.app.workspace.on("window-open", (_ww, win) => {
				this.applyPaperTo(win.document, this.settings.paperStyle);
			})
		);
		// Live reload: ink synced in from another device appears without a
		// restart. One stat per open, quiet editor per check; the store
		// adopts a changed sidecar only when nothing local is unsaved and no
		// gesture is active, and the write-path conflict guard keeps its
		// last word. Dot-folders are invisible to vault events (sidecars
		// are not vault-indexed files), which is why this polls.
		let reloadTickBusy = false;
		// Idle backoff. This exists to notice another device's write, and every
		// tick that finds nothing still costs a stat per open document -
		// forever, on battery, whether or not a second device exists. Quiet
		// ticks get rarer; anything found puts it straight back to one second.
		let quietTicks = 0;
		let ticks = 0;
		let wasHidden = false;
		this.registerInterval(
			window.setInterval(() => {
				if (reloadTickBusy) return;
				this.pollStats.ticks++;
				// Nobody is watching ink arrive in a hidden window, and the
				// first visible tick catches up on everything missed.
				if (document.hidden) {
					wasHidden = true;
					this.pollStats.hidden++;
					return;
				}
				if (wasHidden) {
					wasHidden = false;
					quietTicks = 0;
				}
				ticks++;
				if (ticks % reloadStride(quietTicks) !== 0) {
					this.pollStats.spaced++;
					return;
				}
				this.pollStats.checks++;
				reloadTickBusy = true;
				runDetached(
					(async () => {
						let changed = false;
						// Open PDFs, on the same tick. Their sidecars live in
						// the same unindexed folder and change for the same
						// reason - another device wrote them - so they need the
						// same poll rather than a second one keeping its own
						// time.
						for (const [root, controller] of [...this.pdfInk]) {
							const id = this.pdfIds.get(root);
							if (!id || !controller.idle) continue;
							if (!(await this.store.externallyChanged(id))) continue;
							// The check above is a tick old and the stat was
							// awaited; a pen can have landed since. Re-asking
							// costs nothing and a swap mid-stroke costs the
							// stroke.
							if (!controller.idle) continue;
							// And a stroke that LANDED in that gap has queued a
							// write holding a pre-reload snapshot. Reloading
							// now refreshes the known mtime, which disarms the
							// write-path conflict guard, and that stale
							// snapshot then goes over the other device's ink
							// with no conflict copy. Skip the tick instead: the
							// write lands, and the next poll reloads cleanly.
							if (this.store.hasQueuedWrite(id)) continue;
							if (await this.pdfStore.reloadExternal(id)) {
								controller.refresh();
								changed = true;
							}
						}
						for (const path of inlineReloadCandidates()) {
							// Per note, because this list is walked in the same
							// order every tick: one note that reliably throws -
							// an unreadable sidecar, a stat that keeps failing -
							// would abort the pass at the same place forever and
							// STARVE every note behind it. Live reload would stop
							// for those notes silently, which reads as ink from
							// another device simply never arriving.
							try {
								const id = inlineInk.pageIdOf(path);
								if (!id || !(await this.store.externallyChanged(id))) continue;
								// The quiet check above is a tick old and the stat
								// awaited: a pen can have landed meanwhile. This
								// recheck runs in the same microtask as the
								// adopt, so no gesture can interleave.
								if (!inlineReloadCandidates().includes(path)) continue;
								// Same gap, the other half: a stroke that
								// FINISHED in it left a queued write carrying a
								// pre-reload snapshot, and reloading refreshes
								// the known mtime so the write-path conflict
								// guard no longer sees a reason to preserve
								// anything. Let the write land; the next poll
								// reloads against a mtime that matches it.
								if (this.store.hasQueuedWrite(id)) continue;
								if (await inlineInk.reloadExternal(path)) {
									inkExternallyReloaded(path);
									notifyInkChanged(path);
									// The release line owns this line, not the cherry-pick:
									// the quiet-tick backoff below reads it, and dropping it
									// would hold the poll at full stride forever.
									changed = true;
								}
							} catch (err) {
								console.error(`[handwriting] live-reload poll failed for ${path}`, err);
							}
						}
						quietTicks = changed ? 0 : quietTicks + 1;
					})().finally(() => {
						reloadTickBusy = false;
					}),
					"live-reload poll"
				);
			}, 1000)
		);
		// The nib on ordinary notes: pen or highlighter. A property of the tip,
		// not a mode. The eraser end and the side button keep their hardware meanings.
		this.addCommand({
			id: "inline-tool-pen",
			name: "Pen",
			callback: () => {
				// Asking for a pen tool is asking for the pen UI: without
				// this, the command worked invisibly when no pen had been seen
				// and the palette appeared to do nothing.
				markPenSeen();
				refreshPenToolsAll();
				// Picking a nib is also the exit from eraser and lasso modes:
				// on the strip, Pen LOOKS like the way out, so it has to be.
				setInlineTool("pen");
				setInlineEraserMode(false);
				setInlineLassoMode(false);
				setInlineSpaceMode(false);
				setInlinePanMode(false);
				new Notice("Handwriting: pen");
			},
		});
		// The eraser used to need a pen with an eraser end. Plenty of pens do
		// not have one (and remote-desktop input drops the flag even when they
		// do), so the mode makes the tip erase. Toggle rather than a one-way
		// switch: the same key gets you out.
		// Mouse ink is a MODE, not a default: claiming the mouse costs text
		// selection, so it stays off until someone without a pen asks for it.
		this.addCommand({
			id: "mouse-ink-toggle",
			name: "Mouse",
			callback: () => {
				const on = !mouseInkEnabled();
				setMouseInk(on);
				// THE LOUD PATH, and one of only two that write this down (the
				// settings switch is the other). Asking for the mode BY NAME is
				// what earns a place in data.json; the strip's quiet arm and
				// put-down do not, and no longer get one - alan, 2026-09-04,
				// "dont persist a quiet arm". See MouseInk.ts for the reports
				// that ruling came out of.
				this.settings.mouseInk = on;
				runDetached(this.persistSettings(), "save the mouse ink setting");
				// Turning mouse ink on IS declaring yourself a pen person: the
				// strip appears without waiting for hardware that never comes.
				// Off puts the nib light out instead (alan, 2026-09-03: dark
				// "until you touch with your pen", and off "at any point").
				// Both surfaces' strip buttons route here rather than
				// touching the mode themselves - their hosts execute this
				// command - so this one branch covers the strip, the palette
				// and the hotkey alike. The settings switch is the only
				// other writer and carries the same pair - see
				// `applyMouseInkUiFanout` for both halves and why each needs
				// what it calls.
				this.applyMouseInkUiFanout(on);
				// Named after the TOOL the mouse now holds, nothing else - no
				// "(mouse ink on)" rider. The mouse is a pen; a pen picking
				// up the highlighter says "highlighter" (alan, 2026-08-31).
				// The tip's CLAIM, not just the nib: armed while erasing,
				// "pen" would be a lie.
				const tip = getInlineEraserMode()
					? "eraser"
					: getInlineLassoMode()
						? "lasso"
						: getInlineSpaceMode()
							? "insert space"
							: getInlinePanMode()
								? "pan"
								: getInlineTool();
				new Notice(on ? `Handwriting: ${tip}` : "Handwriting: cursor");
			},
		});
		this.addCommand({
			id: "pen-tools-cycle",
			name: "Toolbar: auto / show / hide",
			callback: () => {
				const next = nextPenToolsMode(getPenToolsMode());
				setPenToolsMode(next);
				this.settings.penTools = next;
				runDetached(this.persistSettings(), "save the pen tools mode");
				refreshPenToolsAll();
				new Notice(`Handwriting: pen tools ${next}`);
			},
		});
		this.addCommand({
			id: "pressure-recalibrate",
			name: "Pen pressure: recalibrate",
			callback: () => {
				resetPressureCalibration();
				new Notice("Handwriting: pressure relearns from your next strokes");
			},
		});
		this.addCommand({
			id: "paper-cycle",
			name: "Paper: none / lines / grid",
			callback: () => {
				const next = nextPaperStyle(this.settings.paperStyle);
				this.settings.paperStyle = next;
				this.applyPaper(next);
				runDetached(this.persistSettings(), "save the paper style");
				new Notice(`Handwriting: paper ${next}`);
			},
		});
		this.addCommand({
			id: "inline-tool-eraser",
			name: "Eraser: toggle",
			callback: () => {
				const on = !getInlineEraserMode();
				setInlineEraserMode(on);
				this.enterTipMode(on);
				new Notice(on ? "Handwriting: eraser" : this.tipModeOffNotice());
			},
		});
		// Lasso as a mode: the side button was the only way in, and every
		// apple pencil and every mouse lacks one. Exclusive with the eraser.
		this.addCommand({
			id: "inline-tool-lasso",
			name: "Lasso: toggle",
			callback: () => {
				const on = !getInlineLassoMode();
				setInlineLassoMode(on);
				this.enterTipMode(on);
				new Notice(on ? "Handwriting: lasso" : this.tipModeOffNotice());
			},
		});
		// Insert space as a mode, same shape as lasso: plant a divider with
		// the tip, drag down to open room, drag up to close it. Pen exits.
		this.addCommand({
			id: "inline-tool-space",
			name: "Insert space: toggle",
			callback: () => {
				const on = !getInlineSpaceMode();
				setInlineSpaceMode(on);
				this.enterTipMode(on);
				new Notice(on ? "Handwriting: insert space" : this.tipModeOffNotice());
			},
		});
		// Pan as a mode: touch already pans by finger, but a pen on glass had
		// no way to move the page without marking it.
		this.addCommand({
			id: "inline-tool-pan",
			name: "Pan: toggle",
			callback: () => {
				const on = !getInlinePanMode();
				setInlinePanMode(on);
				this.enterTipMode(on);
				new Notice(on ? "Handwriting: pan" : this.tipModeOffNotice());
			},
		});
		this.addCommand({
			id: "eraser-size-cycle",
			name: "Eraser size: next",
			callback: () => {
				const next = nextEraserSize(getEraserRadiusPx());
				runDetached(this.setEraserSize(next.radiusPx, next.name), "save the eraser size", () =>
					new Notice("Handwriting: the eraser size changed, but the setting could not be saved")
				);
			},
		});
		this.addCommand({
			id: "ink-shaping-toggle",
			name: "Pressure sensitivity: toggle",
			callback: () => {
				const on = !pressureSensitivityEnabled();
				runDetached(this.applyPressureSensitivity(on), "save the pressure setting", () =>
					new Notice(
						"Handwriting: pressure sensitivity changed for this session, but the setting could not be saved."
					)
				);
			},
		});
		// Nib sizes (OneNote-style): three steps on the ACTIVE tool, plus a
		// cycle command for a hotkey. Applies from the next stroke; persisted.
		// Eleven per-colour and per-size entries buried the pen commands:
		// the palette shows the same colours as swatches you can see, and
		// the cycle commands cover the rest. Behind a setting for anyone who
		// wants one hotkey per colour.
		if (this.settings.colorSizeCommands)
			for (const step of INK_SIZE_STEPS) {
				this.addCommand({
					id: `ink-size-${step.name}`,
					name: `Ink size: ${step.name}`,
					callback: () => {
						runDetached(this.setInkSize(step.mult, step.name), "save the ink size", () =>
							new Notice("Handwriting: the ink size changed, but the setting could not be saved.")
						);
					},
				});
			}
		this.addCommand({
			id: "ink-size-cycle",
			name: "Ink size: next",
			callback: () => {
				const next = nextInkSize(getInkSizeMult(getInlineTool()));
				runDetached(this.setInkSize(next.mult, next.name), "save the ink size", () =>
					new Notice("Handwriting: the ink size changed, but the setting could not be saved")
				);
			},
		});
		// Ink colors: one command per palette name (union of both palettes),
		// acting on the ACTIVE tool, the same model as the size commands. A name
		// the active tool's palette lacks reports instead of guessing.
		{
			const names = [
				...new Set([...PEN_COLORS, ...HIGHLIGHTER_COLORS].map((c) => c.name)),
			];
			if (this.settings.colorSizeCommands) {
				for (const name of names) {
					this.addCommand({
						id: `ink-color-${name}`,
						name: `Ink color: ${name}`,
						callback: () => {
							const tool = getInlineTool();
							const choice = colorsFor(tool).find((c) => c.name === name);
							if (!choice) {
								new Notice(
									`Handwriting: the ${tool} has no ${name}. Its colors are ${colorsFor(tool)
										.map((c) => c.name)
										.join(", ")}.`
								);
								return;
							}
							// Picking a color from lasso or eraser mode picked
							// NOTHING up - white chosen, lasso still armed
							// (glass, 2026-08-31). Choosing a color reaches
							// for the nib that wears it, here like everywhere.
							this.pickUpNib(tool);
							runDetached(this.setInkColor(tool, choice.hex, choice.name), "save the ink color", () =>
								new Notice("Handwriting: the ink color changed, but the setting could not be saved.")
							);
						},
					});
				}
				// Highlighter by name: one hotkey takes you from anything to
				// highlighting in that color. Its own palette's names only,
				// so there is no wrong-tool case to report.
				for (const c of HIGHLIGHTER_COLORS) {
					this.addCommand({
						id: `highlighter-color-${c.name}`,
						name: `Highlighter color: ${c.name}`,
						callback: () => {
							this.pickUpNib("highlighter");
							runDetached(this.setInkColor("highlighter", c.hex, c.name), "save the ink color", () =>
								new Notice("Handwriting: the ink color changed, but the setting could not be saved.")
							);
						},
					});
				}
			}
		}
		// Delete all ink on the active note: explicit, and recoverable three
		// ways. The confirm dialog in front, a .handwriting/trash/ copy made FIRST,
		// and one Ctrl+Z (a single history entry) while the session lives.
		// Export: the ink's first existence outside the plugin. Same geometry
		// as the committed layer, written as an .svg BESIDE the note so vault
		// search and sync treat it as an ordinary attachment.
		this.addCommand({
			id: "export-ink-svg",
			// Named for what it is. "Export this note's ink as SVG" reads as a
			// page export to anyone not thinking about the distinction, and what
			// comes out is the drawing alone, cropped to itself, on no background.
			name: "Export ink as SVG (drawing only)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md" || !inlineInk.hasInk(file.path)) {
					return false;
				}
				if (!checking) {
					const svg = inkToSvg(inlineInk.strokes(file.path));
					if (!svg) {
						new Notice("Handwriting: no ink to export on this note");
						return true;
					}
					// Counted like the snip and the flatten: two exports are two
					// attempts, and the second must not eat the first.
					const svgBase = file.path.replace(/\.md$/, "") + ".ink";
					runDetached(
						createFreshFile(
							() => this.firstFreePath((n) => (n === 1 ? `${svgBase}.svg` : `${svgBase}-${n}.svg`)),
							(path) => this.app.vault.create(path, svg)
						).then(({ path: out }) => {
							new Notice(`Handwriting: exported ${out}`);
						}),
						"export ink as svg",
						() => new Notice("Handwriting: the SVG export could not be written")
					);
				}
				return true;
			},
		});
		// The same export as a PDF, for the places that will not take an SVG -
		// which is most of them outside a browser. ONE page, sized to the ink:
		// a PDF page may be any size up to 200 inches, so the drawing never
		// has to be cut into pieces or clipped to a paper size it was never
		// drawn for. That sidesteps both failures of printing through the
		// reading view.
		//
		// Ink only, and the name says so. Text would need a font embedded in
		// the file, which needs a subsetter, which is its own project; the
		// SVG export has the same problem and degrades to substitution rather
		// than failure. See pdf-plan.md, P2.
		this.addCommand({
			id: "export-ink-pdf",
			name: "Export ink as PDF (drawing only)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md" || !inlineInk.hasInk(file.path)) {
					return false;
				}
				if (!checking) {
					const pdf = inkToPdf(inlineInk.strokes(file.path));
					if (!pdf) {
						new Notice("Handwriting: no ink to export on this note");
						return true;
					}
					// Beside the note, like the SVG, and counted like every
					// other export now: the second must not eat the first.
					const pdfBase = file.path.replace(/\.md$/, "") + ".ink";
					runDetached(
						createFreshFile(
							() => this.firstFreePath((n) => (n === 1 ? `${pdfBase}.pdf` : `${pdfBase}-${n}.pdf`)),
							(path) => this.app.vault.createBinary(path, bytesOf(pdf).buffer as ArrayBuffer)
						).then(({ path: out }) => {
							new Notice(`Handwriting: exported ${out}`);
						}),
						"export ink as pdf",
						() => new Notice("Handwriting: the PDF export could not be written")
					);
				}
				return true;
			},
		});
		// Flatten: the same idea for a PDF, and the thing that makes ink on
		// one a feature rather than a private note to self. A document
		// annotated here is trapped here - copy the file anywhere and the
		// marks are gone, because they live in a sidecar. This writes a copy
		// with the ink drawn into the page, which anybody can open.
		this.addCommand({
			id: "flatten-pdf-ink",
			name: "Flatten ink into a copy of this PDF",
			checkCallback: (checking) => {
				// Listed on every pdf, the lesson the wipe command already
				// carries: a command hidden by a has-ink gate reads as "does
				// not exist" to someone searching for it - and it did, on the
				// first fresh vault anyone tried (emulation, 2026-08-30).
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension.toLowerCase() !== "pdf") return false;
				if (!checking) {
					const id = this.pdfIdForPath(file.path);
					if (!id) {
						new Notice("Handwriting: still identifying this PDF - try again in a moment");
						return true;
					}
					if (this.pdfStore.strokes(id).length === 0) {
						new Notice("Handwriting: no ink on this PDF to flatten");
						return true;
					}
					runDetached(
						this.flattenPdf(file, id),
						"flatten pdf ink",
						() => new Notice("Handwriting: the flattened PDF could not be written")
					);
				}
				return true;
			},
		});
		// Snip: the selected region leaves the PDF as an image a note can
		// hold. The lasso already marks the box; this renders page and ink
		// inside it to a PNG beside the PDF and puts the embed markdown on
		// the clipboard, with a link back to the page it came from - so the
		// figure lands in a note still knowing where it lives.
		this.addCommand({
			id: "snip-pdf-selection",
			name: "Snip the selection to an image",
			checkCallback: (checking) => {
				// One command, both surfaces: a snip is a snip whether the
				// lasso was drawn on a pdf page or a note.
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (file.extension.toLowerCase() === "pdf") {
					// Listed whenever a pdf is open, the flatten command's own
					// lesson: a command hidden by a has-selection gate reads
					// as "does not exist" to the person searching for it - and
					// it did, on the first pdf anyone tried to snip from the
					// palette. No selection is an ANSWER, not an absence.
					const controller = this.pdfControllerWithSelection(file.path);
					if (!checking && !controller) {
						new Notice("Handwriting: lasso the ink to snip first");
						return true;
					}
					if (!checking && controller) {
						runDetached(
							this.snipPdf(file, controller),
							"snip the selection",
							() => new Notice("Handwriting: the snip could not be written")
						);
					}
					return true;
				}
				if (file.extension === "md") {
					const overlay = overlayForPath(file.path);
					if (!overlay) return false;
					if (!checking && !overlay.hasSelection) {
						new Notice("Handwriting: lasso the ink to snip first");
						return true;
					}
					if (!checking && overlay.hasSelection) {
						runDetached(
							this.snipNote(file, overlay),
							"snip the selection",
							() => new Notice("Handwriting: the snip could not be written")
						);
					}
					return true;
				}
				return false;
			},
		});
		// The pdf twin of "Delete all ink on this note", for the same reason
		// that one exists: erasing a document's worth of test scribbles one
		// lasso at a time is how ink never gets cleaned up at all.
		this.addCommand({
			id: "delete-all-pdf-ink",
			name: "Delete all ink on this PDF",
			checkCallback: (checking) => {
				// Listed on every pdf, like the note command on every note: a
				// command hidden by a has-ink gate reads as "does not exist"
				// to someone searching for it.
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension.toLowerCase() !== "pdf") return false;
				if (!checking) {
					const id = this.pdfIdForPath(file.path);
					if (!id) {
						new Notice("Handwriting: still identifying this PDF - try again in a moment");
					} else {
						const count = this.pdfStore.strokes(id).length;
						if (count === 0) new Notice("Handwriting: no ink on this PDF");
						else {
							new ConfirmDeleteInkModal(this.app, count, "PDF", () => {
								runDetached(this.deleteAllPdfInk(id), `delete all ink on ${file.path}`);
							}).open();
						}
					}
				}
				return true;
			},
		});
		// Copy/paste ink, across notes too. The clipboard is the session's,
		// never the system's: note-space coordinates mean nothing to other
		// applications (the SVG export is for leaving the vault).
		this.addCommand({
			id: "delete-selected-ink",
			name: "Delete selected ink",
			checkCallback: (checking) => {
				const surface = this.activeInkSurface();
				if (!surface) return false;
				if (!checking) {
					if (surface.kind === "inline") {
						if (surface.overlay.deleteSelectedInk() === 0) new Notice("Handwriting: lasso some ink first");
					} else {
						// Notifies itself: an unidentified PDF and an empty
						// lasso both stop a delete, and only the controller
						// knows which (audit doc §5k/AD4).
						surface.controller.deleteSelectionCommand();
					}
				}
				return true;
			},
		});
		this.addCommand({
			id: "copy-selected-ink",
			name: "Copy selected ink",
			checkCallback: (checking) => {
				const surface = this.activeInkSurface();
				if (!surface) return false;
				if (!checking) {
					if (surface.kind === "inline") {
						const n = surface.overlay.copySelectedInk();
						new Notice(n > 0 ? `Handwriting: copied ${n} stroke(s)` : "Handwriting: lasso some ink first");
					} else {
						// Notifies itself, all three outcomes.
						surface.controller.copySelection();
					}
				}
				return true;
			},
		});
		this.addCommand({
			id: "cut-selected-ink",
			name: "Cut selected ink",
			checkCallback: (checking) => {
				const surface = this.activeInkSurface();
				if (!surface) return false;
				if (!checking) {
					if (surface.kind === "inline") {
						const n = surface.overlay.cutSelectedInk();
						new Notice(n > 0 ? `Handwriting: cut ${n} stroke(s)` : "Handwriting: lasso some ink first");
					} else {
						// Notifies itself, for the same reason delete does.
						surface.controller.cutSelectionCommand();
					}
				}
				return true;
			},
		});
		this.addCommand({
			id: "paste-ink",
			name: "Paste ink",
			checkCallback: (checking) => {
				// Listed whenever a note or PDF is open: a paste hidden by an
				// empty clipboard reads as broken, and the empty case can just
				// say so.
				const surface = this.activeInkSurface();
				if (!surface) return false;
				// Not offered until the document has an id, audit doc §5k/AD4:
				// syncPdfControllers inserts the controller before resolvePdfId
				// finishes, so the command listed itself in that window and
				// then pasted nothing, in silence.
				if (surface.kind === "pdf" && !surface.controller.identified) return false;
				if (!checking) {
					if (clipboardSize() === 0) {
						new Notice("Handwriting: the ink clipboard is empty, copy selected ink first");
					} else if (surface.kind === "inline") {
						const n = surface.overlay.pasteInkHere();
						new Notice(`Handwriting: pasted ${n} stroke(s)`);
					} else {
						// Notifies itself (success, or the note-ink-on-a-pdf refusal).
						surface.controller.pasteFromClipboard();
					}
				}
				return true;
			},
		});
		this.addCommand({
			id: "delete-all-ink",
			name: "Delete all ink on this note",
			checkCallback: (checking) => {
				// Listed on every note: a command hidden by a hasInk gate
				// reads as "does not exist" to someone searching for it.
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) {
					if (!inlineInk.hasInk(file.path)) {
						new Notice("Handwriting: no ink on this note");
					} else {
						this.confirmDeleteAllInk(file.path);
					}
				}
				return true;
			},
		});
		this.addCommand({
			id: "ink-color-cycle",
			name: "Ink color: next",
			callback: () => {
				const tool = getInlineTool();
				const next = nextInkColor(tool, getInkColorHex(tool));
				this.pickUpNib(tool);
				runDetached(this.setInkColor(tool, next.hex, next.name), "save the ink color", () =>
					new Notice("Handwriting: the ink color changed, but the setting could not be saved")
				);
			},
		});
		// "Ink color: next" answers for the tool in hand, and so do the
		// strip's swatches. These two each always mean their tool, and
		// choosing the color picks the tool up (pickUpNib) - one command
		// from anything to drawing in that color.
		this.addCommand({
			id: "highlighter-color-cycle",
			name: "Highlighter color: next",
			callback: () => {
				const next = nextInkColor("highlighter", getInkColorHex("highlighter"));
				this.pickUpNib("highlighter");
				runDetached(this.setInkColor("highlighter", next.hex, next.name), "save the ink color", () =>
					new Notice("Handwriting: the ink color changed, but the setting could not be saved")
				);
			},
		});
		this.addCommand({
			id: "pen-color-cycle",
			name: "Pen color: next",
			callback: () => {
				const next = nextInkColor("pen", getInkColorHex("pen"));
				this.pickUpNib("pen");
				runDetached(this.setInkColor("pen", next.hex, next.name), "save the ink color", () =>
					new Notice("Handwriting: the ink color changed, but the setting could not be saved")
				);
			},
		});
		this.addCommand({
			id: "inline-tool-highlighter",
			name: "Highlighter",
			callback: () => {
				// Asking for a pen tool is asking for the pen UI: without
				// this, the command worked invisibly when no pen had been seen
				// and the palette appeared to do nothing.
				markPenSeen();
				refreshPenToolsAll();
				setInlineTool("highlighter");
				setInlineEraserMode(false);
				setInlineLassoMode(false);
				setInlineSpaceMode(false);
				setInlinePanMode(false);
				new Notice("Handwriting: highlighter");
			},
		});
		this.addCommand({
			id: "inline-tool-toggle",
			name: "Pen / highlighter: switch",
			callback: () => {
				// Asking for a pen tool is asking for the pen UI: without
				// this, the command worked invisibly when no pen had been seen
				// and the palette appeared to do nothing.
				markPenSeen();
				refreshPenToolsAll();
				const next = getInlineTool() === "pen" ? "highlighter" : "pen";
				setInlineTool(next);
				new Notice(`Handwriting: ${next}`);
			},
		});
		// The pen lifecycle trace. To capture one failing stroke: turn
		// diagnostics recording on, clear the trace, draw the stroke, show the
		// trace, turn recording off.
		this.addCommand({
			id: "copy-inline-pen-trace",
			name: "Bug report: show as text",
			callback: () => {
				if (this.guardEmptyTrace()) return;
				// Viewing a report is the end of the capture: what you see
				// is what you deliver, and recording stops here so nobody
				// has to remember a toggle before they're done. Only Bug
				// report: record starts it again (Alan, 2026-09-02: "yes
				// viewing a bug report should stop recording" - "i dont
				// want them to have to toggle recording off, that's an
				// extra step no one will do").
				setDiagnosticsEnabled(false);
				this.syncRecordingBadge();
				refreshAllStrips();
				new DiagnosticTextModal(
					this.app,
					"Handwriting pen trace",
					formatInlinePenTrace(),
					undefined,
					() => {
						setDiagnosticsEnabled(false);
						// Cleared as well: a delivered report is DONE. Leaving the
						// rows made the next send show stale data while new
						// scribbles went unrecorded - the same dead-recorder trap
						// wearing a different face. The open modal keeps its own
						// snapshot, so every button in it still works.
						clearInlinePenTrace();
						this.syncRecordingBadge();
						refreshAllStrips();
					}
				).open();
			},
		});
		// The machine-readable twin: what becomes a replay fixture in
		// test/traces/. The table above stays for humans and GitHub issues;
		// this one carries floats, coalesced samples, and the world the
		// events landed in - a pointerdown at (400, 300) means nothing
		// without dpr, viewport and settings.
		this.addCommand({
			id: "copy-inline-pen-trace-json",
			name: "Bug report: send",
			callback: () => {
				if (this.guardEmptyTrace()) return;
				// Viewing a report is the end of the capture: what you see
				// is what you deliver, and recording stops here so nobody
				// has to remember a toggle before they're done. Only Bug
				// report: record starts it again (Alan, 2026-09-02: "yes
				// viewing a bug report should stop recording" - "i dont
				// want them to have to toggle recording off, that's an
				// extra step no one will do").
				setDiagnosticsEnabled(false);
				this.syncRecordingBadge();
				refreshAllStrips();
				const capture = captureInlinePenTrace({
					// Host flags, not navigator.userAgent: the directory review
					// reads a UA lookup as OS sniffing, and Platform answers the
					// same question honestly. The device model goes with it.
					host: formatHost({
						isDesktopApp: Platform.isDesktopApp,
						isMobileApp: Platform.isMobileApp,
						isIosApp: Platform.isIosApp,
						isAndroidApp: Platform.isAndroidApp,
						isTablet: Platform.isTablet,
						isPhone: Platform.isPhone,
					}),
					os: platformOs(),
					dpr: window.devicePixelRatio,
					viewport: { w: window.innerWidth, h: window.innerHeight },
					settings: {
						inkSmoothing: this.settings.inkSmoothing,
						strokePrediction: this.settings.strokePrediction,
						booxMode: this.settings.booxMode,
						pressureSensitivity: this.settings.pressureSensitivity,
						mouseInk: this.settings.mouseInk,
						// Both, because since the quiet arm stopped being written
						// down these two disagree: a mouse click on a tool arms
						// the mode for the session over a stored `false`, and a
						// trace that reported only the setting said the mouse was
						// not inking while the strokes in the same file came off
						// a mouse.
						mouseInkLive: mouseInkEnabled(),
						eraserMode: this.settings.eraserMode,
						eraserRadiusPx: this.settings.eraserRadiusPx,
					},
				});
				new DiagnosticTextModal(
					this.app,
					"Handwriting pen trace (replay JSON)",
					JSON.stringify(capture, null, "\t"),
					TRACE_UPLOAD_URL === ""
						? undefined
						: async (text: string) => {
								const res = await requestUrl({
									url: TRACE_UPLOAD_URL + "/upload",
									method: "POST",
									contentType: "application/json",
									body: text,
									throw: false,
								});
								// `json` is typed any: read the one field through a shape, so
								// nothing else in the body is trusted.
								const id: unknown = (res.json as { id?: unknown } | null | undefined)?.id;
								const accepted = typeof id === "number" || (typeof id === "string" && id !== "");
								if (res.status !== 200 || !accepted) {
									throw new Error(`upload refused (${res.status})`);
								}
								return String(id);
							}
,
					// Delivering the report - by ANY door - ends the recording.
					() => {
						setDiagnosticsEnabled(false);
						// Cleared as well: a delivered report is DONE. Leaving the
						// rows made the next send show stale data while new
						// scribbles went unrecorded - the same dead-recorder trap
						// wearing a different face. The open modal keeps its own
						// snapshot, so every button in it still works.
						clearInlinePenTrace();
						this.syncRecordingBadge();
						refreshAllStrips();
					}				).open();
			},
		});
		// The deep diagnostics are instruments, not features. Off by
		// default so the palette shows the pen before the probes; the
		// developer diagnostics setting brings them back after a reload.
		if (this.settings.devDiagnostics)
			this.addCommand({
			id: "toggle-pdf-ink-calibration",
			name: "Diagnostics: PDF ink calibration marks",
			callback: () => {
				// The M1 oracle: green crosses at the same coordinates the test
				// fixture prints its red registration marks at. If the two
				// coincide, ink stored in page points is drawn where those
				// points say. Page 1 and every tenth page, so page SELECTION is
				// checked too and not just position.
				this.pdfCalibration = !this.pdfCalibration;
				this.syncPdfControllers();
				for (const c of this.pdfInk.values()) c.refresh();
				new Notice(
					this.pdfCalibration
						? "Handwriting: PDF calibration marks on (page 1 and every 10th)"
						: "Handwriting: PDF calibration marks off"
				);
			},
		});
		if (this.settings.devDiagnostics)
			this.addCommand({
			id: "show-pdf-view-report",
			name: "Diagnostics: show PDF view report",
			callback: () => {
				const controllers = [...this.pdfInk.values()]
					.map((c, i) => `--- ink controller ${i + 1} ---\n${c.describe()}`)
					.join("\n");
				const body =
					`${pdfInkReport(this.app)}\n\n` +
					`reload poll: ${this.pollStats.ticks} ticks, ${this.pollStats.checks} checks ` +
					`(${this.pollStats.hidden} skipped hidden, ${this.pollStats.spaced} spaced ` +
					`out; every tick was a check before today)\n` +
					`calibration marks: ${this.pdfCalibration ? "ON" : "off"}\n` +
					`${controllers || "(no ink controller attached)"}`;
				showDiagnosticText(this.app, "Handwriting PDF view report", body);
			},
		});
		if (this.settings.devDiagnostics)
			this.addCommand({
			id: "show-ink-metrics",
			name: "Diagnostics: show ink metrics",
			callback: () => {
				showDiagnosticText(this.app, "Handwriting ink metrics", copyInlineInkMetrics());
			},
		});
		if (this.settings.devDiagnostics)
			this.addCommand({
			id: "clear-inline-pen-trace",
			name: "Diagnostics: clear pen trace",
			callback: () => {
				clearInlinePenTrace();
				new Notice("Handwriting: pen trace cleared");
			},
		});
		if (this.settings.devDiagnostics)
			this.addCommand({
			id: "copy-inline-zoom-report",
			name: "Diagnostics: show zoom report",
			callback: () => {
				showDiagnosticText(this.app, "Handwriting zoom report", copyInlineZoomReport());
			},
		});

		// Dead-region diagnosis: what the page has under a client point, and
		// what every pen pointerdown's dispatch actually looked like.
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "toggle-inline-hit-probe",
				name: "Diagnostics: toggle pointer hit probe",
				callback: () => {
					const on = !isHitProbeEnabled();
					setHitProbeEnabled(on);
					if (on) clearHitProbe();
					new Notice(`Handwriting: pointer hit probe ${on ? "on. Hover, then touch down." : "off"}`);
				},
			});
		}
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "copy-inline-hit-report",
				name: "Diagnostics: show pointer hit report",
				callback: () => {
					showDiagnosticText(this.app, "Handwriting pointer hit report", formatHitReport());
				},
			});
		}
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "clear-inline-hit-probe",
				name: "Diagnostics: clear pointer hit probe",
				callback: () => {
					clearHitProbe();
					new Notice("Handwriting: pointer hit probe cleared");
				},
			});
		}
		// Touchpad dead-zone diagnosis: the wheel/scroll/repaint pipeline,
		// always recording. Capture: clear -> touchpad-scroll -> draw inside
		// and outside the dead zone -> show the report. Then repeat with touchscreen
		// scrolling as the control.
		// Presentation ground truth: what is actually in the composited frame
		// and what paints above the ink at the last stroke's screen box.
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "copy-region-census",
				name: "Diagnostics: show region census",
				callback: () => {
					showDiagnosticText(this.app, "Handwriting region census", copyRegionCensus());
				},
			});
		}
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "copy-presentation-capture",
				name: "Diagnostics: show presentation capture",
				callback: () => {
					runDetached(
						copyPresentationReport().then((report) =>
							showDiagnosticText(this.app, "Handwriting presentation capture", report)
						),
						"prepare a presentation capture",
						() =>
							new Notice(
								"Handwriting: could not prepare the presentation capture. See the developer console."
							)
					);
				},
			});
		}
		// Investigation instruments (scroll trace, pen trace, presentation
		// capture) are kept but explicitly invoked: recording is OFF by
		// default and costs one boolean check per event while off.
		this.addCommand({
			id: "toggle-diagnostics",
			name: "Bug report: record",
			callback: () => {
				const on = !diagnosticsEnabled();
				setDiagnosticsEnabled(on);
				this.syncRecordingBadge();
				refreshAllStrips();
				new Notice(`Handwriting: recording ${on ? "on" : "off"}`);
			},
		});
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "copy-inline-scroll-trace",
				name: "Diagnostics: show scroll trace",
				callback: () => {
					showDiagnosticText(this.app, "Handwriting scroll trace", formatScrollProbe());
				},
			});
		}
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "clear-inline-scroll-trace",
				name: "Diagnostics: clear scroll trace",
				callback: () => {
					clearScrollProbe();
					new Notice("Handwriting: scroll trace cleared");
				},
			});
		}

		// The probe view is the whole point of this build, and a registered view
		// with nothing to open it is unreachable: there is no UI in Obsidian for
		// opening a view type by name. A remote tester needs one palette entry.
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "open-pen-diagnostics",
				name: "Diagnostics: open pen probe",
				callback: () => {
					runDetached(this.openPenDiagnostics(), "open the pen probe");
				},
			});
		}

		this.addCommand({
			id: "new-page",
			name: "New canvas page",
			callback: () => {
				runDetached(this.newPage(), "create a canvas page");
			},
		});
		this.addCommand({
			id: "open-as-canvas",
			name: "Open note on the canvas",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) {
					runDetached(this.openAsHandwriting(file), `open ${file.path} on the canvas`, () =>
						new Notice("Handwriting: could not open this note on the canvas.")
					);
				}
				return true;
			},
		});
		this.addCommand({
			id: "open-as-markdown",
			name: "Open canvas page as Markdown",
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				const isHandwriting = leaf?.view instanceof HandwritingPageView;
				if (!isHandwriting || !leaf) return false;
				if (!checking) {
					const file = (leaf.view as HandwritingPageView).file;
					// Remember the choice. Without this, a note carrying the
					// `handwriting:` marker gets swapped straight back to the canvas by
					// the file-open handler, and "Open as Markdown" looks broken.
					if (file) this.preferMarkdown.add(file.path);
					runDetached(
						leaf.setViewState({
							type: "markdown",
							state: { file: file?.path, mode: "source" },
						}),
						"open a canvas page as Markdown",
						() => new Notice("Handwriting: could not open this page as Markdown.")
					);
				}
				return true;
			},
		});
		for (const tool of ["pen", "highlighter", "eraser", "lasso"] as const) {
			this.addCommand({
				id: `tool-${tool}`,
				name: `Canvas tool: ${tool}`,
				checkCallback: (checking) => {
					const view = this.activeHandwritingView();
					if (!view) return false;
					if (!checking) view.setTool(tool);
					return true;
				},
			});
		}


		// Route Handwriting-marked notes to the canvas view.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) =>
				runDetached(this.maybeSwapView(file), "switch a marked note to its canvas view")
			)
		);
		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) return;
			runDetached(
				this.maybeSwapView(this.app.workspace.getActiveFile()),
				"switch the active marked note to its canvas view"
			);
		});

		// Two unrelated lifecycles share this stretch of vault events; an
		// earlier version of this comment described only the first and, read
		// against the handlers below it, implied the second needed no work.
		//
		// Below (delete): onFileDeleted recycles a deleted note's page-id-
		// keyed ink (§21). The sidecar needs no matching rename handler - its
		// path is <pageId>.json, derived from the id in the note's own
		// frontmatter rather than from the note's path, so a rename never
		// touches it.
		//
		// Next (rename, then its own delete): inline session records, the
		// canvas-intent set and a PDF's path claim are keyed by the note's
		// PATH instead, so unlike the sidecar they must move when the file
		// moves and drop when the file is gone, or the next file landing on
		// that path inherits state that was never its own.
		//
		// K4, audit-fixes-design.md 5k.
		this.registerEvent(
			this.app.vault.on("delete", (file) =>
				runDetached(this.onFileDeleted(file), "preserve ink for a deleted note")
			)
		);

		// Inline session ink is keyed by path (an unclaimed note has no other
		// identity), so renames must move it and deletes must drop it, or the
		// next note reusing the path inherits a dead note's ink.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile && file.extension === "md") {
					inlineInk.handleRename(oldPath, file.path);
					surfaceExtents.handleRename(oldPath, file.path);
					// Canvas intent is keyed by path for the same reason and
					// carries the same hazard: left behind, a NEW note later
					// created at the old path inherits "the user opened this
					// on the canvas" from a note that no longer exists.
					if (this.canvasIntent.delete(oldPath)) this.canvasIntent.add(file.path);
				}
				// A pdf renamed while OPEN: the pane keeps its id, and the
				// sidecar's path claim moves with the file - left stale, the
				// next resolution would read this file as a fresh copy and
				// open it blank. Renamed while closed, chooseInstance sees
				// the dead path and adopts; this is the live-pane mirror.
				if (file instanceof TFile && file.extension === "pdf") {
					for (const [root, p] of this.pdfFiles) {
						if (p !== oldPath) continue;
						this.pdfFiles.set(root, file.path);
						const id = this.pdfIds.get(root);
						if (id) this.pdfStore.renamePath(id, oldPath, file.path);
					}
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					inlineInk.handleDelete(file.path);
					surfaceExtents.handleDelete(file.path);
					this.canvasIntent.delete(file.path);
				}
			})
		);

		// Obsidian's status bar is a fixed overlay in the bottom-right corner
		// (word count, backlink/property counts, plugin items). On a Handwriting
		// page it sits ON TOP of the writing surface and the horizontal
		// scrollbar. There is no native setting to dodge or hide it, so:
		// while the ACTIVE note is a Handwriting page, `handwriting-active-page` on
		// <body> hides the strip (scoped CSS); every ordinary note keeps it.
		const updateStatusBarClass = () => {
			const file = this.app.workspace.getActiveFile();
			document.body.classList.toggle(
				"handwriting-active-page",
				!!file && file.extension === "md" && inlineInk.isHandwritingPage(file.path)
			);
		};
		this.registerEvent(this.app.workspace.on("active-leaf-change", updateStatusBarClass));
		// PDF ink controllers follow the open PDF views. Keyed by root element
		// rather than by leaf: a leaf can be reused for a different file, and
		// the element is what the overlays actually live inside.
		const syncPdfInk = () => this.syncPdfControllers();
		this.registerEvent(this.app.workspace.on("layout-change", syncPdfInk));
		this.registerEvent(this.app.workspace.on("active-leaf-change", syncPdfInk));
		this.register(() => {
			for (const c of this.pdfInk.values()) c.unmount();
			this.pdfInk.clear();
		});
		syncPdfInk();
		// Every way the recording switch flips, not just the command: showing
		// a report also ends the capture, and that path left "recording pen"
		// in the status bar with nothing recording.
		setDiagnosticsChangedListener(() => this.syncRecordingBadge());
		this.register(() => setDiagnosticsChangedListener(null));
		// Open PDFs carry a strip too, and the settings fan-outs only ever
		// walked the editor overlays - so changing the toolbar corner, or the
		// tip mode, moved every note's strip and left every open PDF's where
		// it was until something else happened to refresh it.
		this.register(
			addStripSurface(
				() => {
					for (const c of this.pdfInk.values()) c.refreshStrip();
				},
				// §5o: a tool switch away from lasso dissolves every open PDF's
				// selection too - Alan's device finding 2026-09-02.
				() => {
					for (const c of this.pdfInk.values()) c.dissolveSelection();
				},
				// And the render-time settings - Ink smoothing, pressure
				// sensitivity, Boox mode - change committed GEOMETRY without
				// touching a stroke, so a surface that is not an editor overlay
				// keeps its old shape until something else repaints it (§5l/AE6).
				() => {
					for (const c of this.pdfInk.values()) c.refresh();
					for (const leaf of this.app.workspace.getLeavesOfType(
						HANDWRITING_PAGE_VIEW_TYPE
					)) {
						const view = leaf.view;
						if (view instanceof HandwritingPageView) view.repaintInk();
					}
				},
				// And mouse ink going OFF strands the reticle on a PDF the
				// same way it does on a note: the pointer is still over the
				// pane, so neither pointerleave nor the watchdog the mouse is
				// exempt from will ever take the ring down. See
				// `hidePenCursorsEverywhere` (InkOverlay.ts), which is what
				// calls this.
				() => {
					for (const c of this.pdfInk.values()) c.hideCursor();
				}
			)
		);
		this.registerEvent(this.app.workspace.on("file-open", updateStatusBarClass));
		// The claim on a note's FIRST stroke changes its metadata. That is the
		// moment an ordinary note becomes a Handwriting page under the cursor.
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file.path === this.app.workspace.getActiveFile()?.path) {
					updateStatusBarClass();
				}
			})
		);
		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) return;
			updateStatusBarClass();
		});

		// After layout, not during onload: a modal that opens while the
		// workspace is still assembling fights the app for the screen.
		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) return;
			this.showWhatsNewIfDue();
		});

		// ---- background/freeze flush ------------------------------------------
		// On iOS and Android the webview is frozen or killed on background
		// with no further JS, so anything mid-debounce - ink sidecars,
		// settings - was silently lost: write on a Boox, swipe away, come
		// back to a note missing its last strokes. Both events, because iOS
		// does not reliably fire either one alone; both handlers DISPATCH
		// writes synchronously and never await, because nothing after a
		// freeze runs to hear a promise resolve. onunload still covers the
		// ordinary teardown path via finishPersistence().
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") this.flushOnHide();
		});
		this.registerDomEvent(window, "pagehide", () => this.flushOnHide());

		// ---- duplicate page-id watch (v0.13.6) --------------------------------
		// A page id must map to exactly one note; copying a note copies the id.
		// The census waits for `resolved` (the FULL metadata index). Deciding
		// ownership from a half-built cache would be iteration order, the one
		// evidence source this design forbids. Runtime sightings after the
		// census are true lifecycle evidence: the note that already held the
		// id is the original, the newcomer is the copy.
		const runCensus = () => {
			if (this.pageIdWatchReady) return;
			this.pageIdWatchReady = true;
			this.buildPageIdIndex();
		};
		this.registerEvent(this.app.metadataCache.on("resolved", runCensus));
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (this.pageIdWatchReady && file.extension === "md") {
					this.checkPageIdentity(file.path);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile && file.extension === "md") {
					this.pageIds.handleRename(oldPath, file.path);
					for (const paths of this.ambiguousIds.values()) {
						const i = paths.indexOf(oldPath);
						if (i >= 0) paths[i] = file.path;
					}
					if (this.pageIdWatchReady) this.persistOwners();
				}
			})
		);
	}

	// ---- duplicate page ids (v0.13.6) ---------------------------------------

	/**
	 * Startup census from the fully-resolved metadata cache. Unique ids
	 * register their owner. Collisions resolve against the persisted owner
	 * memory when it names one of the carriers (the copy was made while the
	 * app was closed); with no memory there is NO safe way to pick an
	 * original, so every carrier fails closed with a notice instead of
	 * either note or sidecar being rewritten on a guess.
	 */
	private buildPageIdIndex(): void {
		const entries: { path: string; id: string }[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const id = this.recentPageIdFor(f);
			if (id) entries.push({ path: f.path, id });
		}
		const { collisions } = this.pageIds.rebuild(entries);
		for (const [id, paths] of collisions) {
			const remembered = this.settings.pageOwners[id];
			if (remembered && paths.includes(remembered)) {
				this.pageIds.claimOwnership(id, remembered);
				for (const p of paths) {
					if (p !== remembered) {
						runDetached(
							this.resolveDuplicate(p, id, remembered),
							`repair duplicate page identity for ${p}`
						);
					}
				}
			} else {
				this.ambiguousIds.set(id, [...paths]);
				for (const p of paths) {
					const other = paths.find((q) => q !== p) ?? "another note";
					inlineInk.markDuplicateLocked(p, other);
				}
			}
		}
		this.persistOwners();
	}

	/** A note's cached frontmatter changed: keep the ownership ledger true. */
	private checkPageIdentity(path: string): void {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		const id = this.recentPageIdFor(file);
		if (!id) {
			// NOT immediately. See declaimLater: an id that has merely gone
			// unreadable for a keystroke must not take the note's ink off
			// the screen.
			this.declaimLater(path);
			return;
		}
		// It is back, or it never went: cancel anything waiting to declaim.
		const pending = this.declaimTimers.get(path);
		if (pending !== undefined) {
			window.clearTimeout(pending);
			this.declaimTimers.delete(path);
		}
		const v = this.pageIds.register(path, id);
		if (v.kind === "registered") {
			this.persistOwners();
			return;
		}
		if (v.kind === "same") return;
		this.resolveIdentityCollision(path, id, v);
	}

	/**
	 * Give up a note's identity, but only once it stays given up.
	 *
	 * `handwriting-page-id` lives in YAML frontmatter, and Obsidian re-parses
	 * that on every keystroke. Adding a property, or fixing a typo, makes the
	 * block momentarily invalid - and an unparseable block reports NO
	 * frontmatter, which is indistinguishable here from "the id line was
	 * deleted". Acting on it dropped the session record, so the note's ink
	 * vanished mid-edit and did not come back until it was reopened.
	 *
	 * A real declaim is not urgent: nothing is lost by confirming it a moment
	 * later, and the confirmation is just asking again.
	 */
	private declaimLater(path: string): void {
		if (this.declaimTimers.has(path)) return;
		this.declaimTimers.set(
			path,
			window.setTimeout(() => {
				this.declaimTimers.delete(path);
				const file = this.app.vault.getFileByPath(path);
				if (!file) return;
				if (this.recentPageIdFor(file)) return; // it came back
				this.declaimNow(path);
			}, DECLAIM_GRACE_MS)
		);
	}

	private declaimNow(path: string): void {
		{
			// The id line really is gone (duplicate resolution by hand, or an
			// external edit). Free anything this path owned, drop its stale
			// session record, and re-check collisions it participated in.
			const freed = this.pageIds.handleDelete(path);
			inlineInk.handleDeclaimed(path);
			for (const fid of freed) {
				const other = this.findOtherCarrier(fid, path);
				if (other) {
					this.pageIds.claimOwnership(fid, other);
					inlineInk.clearDuplicateLock(other);
				}
			}
			for (const [aid, paths] of [...this.ambiguousIds]) {
				if (paths.includes(path)) this.recheckCollision(aid);
			}
			if (freed.length > 0) this.persistOwners();
			return;
		}
	}

	private resolveIdentityCollision(
		path: string,
		id: string,
		v: Extract<RegisterVerdict, { kind: "duplicate" }>
	): void {
		// Duplicate sighting. Verify the recorded owner still exists and
		// still carries the id. If not, ownership transfers instead.
		const ownerFile = this.app.vault.getFileByPath(v.ownerPath);
		const ownerId = ownerFile ? this.recentPageIdFor(ownerFile) : null;
		if (ownerId !== id) {
			this.pageIds.transfer(id, path);
			this.persistOwners();
			return;
		}
		runDetached(
			this.resolveDuplicate(path, id, v.ownerPath),
			`repair duplicate page identity for ${path}`
		);
	}

	/** Ambiguous set changed: if exactly one carrier remains, it owns the id. */
	private recheckCollision(id: string): void {
		const paths = this.ambiguousIds.get(id);
		if (!paths) return;
		const carriers = paths.filter((p) => {
			const f = this.app.vault.getFileByPath(p);
			return f !== null && this.recentPageIdFor(f) === id;
		});
		if (carriers.length === 1) {
			this.ambiguousIds.delete(id);
			this.pageIds.claimOwnership(id, carriers[0]!);
			inlineInk.clearDuplicateLock(carriers[0]!);
			this.persistOwners();
		} else if (carriers.length === 0) {
			this.ambiguousIds.delete(id);
		}
	}

	/** Cached-metadata scan for another note carrying `id` (event paths only). */
	private findOtherCarrier(id: string, exceptPath: string): string | null {
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (f.path === exceptPath) continue;
			if (this.recentPageIdFor(f) === id) return f.path;
		}
		return null;
	}

	/**
	 * The copy at `copyPath` shares `id` with the original at `ownerPath`.
	 * Resolution order is chosen so no step can lose ink: the shared sidecar
	 * is CLONED under a fresh id first (source read-only; an interrupted run
	 * leaves at worst an orphan clone), then the copy's frontmatter is
	 * re-identified atomically, then live session state follows. The
	 * original note and its sidecar are never written.
	 */
	private async resolveDuplicate(
		copyPath: string,
		id: string,
		ownerPath: string
	): Promise<void> {
		if (this.resolvingDuplicates.has(copyPath)) return;
		this.resolvingDuplicates.add(copyPath);
		try {
			const file = this.app.vault.getFileByPath(copyPath);
			if (!file) return;
			const newId = newPageId();
			let cloned: "cloned" | "none" | "unreadable" | "exists";
			try {
				cloned = await this.store.clone(id, newId);
			} catch (err) {
				console.error("[handwriting] duplicate sidecar clone failed", err);
				inlineInk.markDuplicateLocked(copyPath, ownerPath);
				return; // fail closed: locked beats half-resolved
			}
			if (cloned === "exists") {
				inlineInk.markDuplicateLocked(copyPath, ownerPath);
				return;
			}
			let outcome: { changed: boolean; futureVersion?: number } = { changed: false };
			await this.app.vault.process(file, (data) => {
				const r = reassignMarkdown(data, newId);
				outcome = { changed: r.changed, futureVersion: r.futureVersion };
				return r.content;
			});
			if (!outcome.changed) {
				// The id line vanished meanwhile (nothing to do) or the note
				// declares a newer format (never write): clean the unused clone.
				if (cloned === "cloned") await this.store.remove(newId).catch(() => undefined);
				if (outcome.futureVersion !== undefined) {
					inlineInk.markDuplicateLocked(copyPath, ownerPath);
				}
				return;
			}
			this.pageIds.register(copyPath, newId);
			const verdict = inlineInk.reassignPage(copyPath, newId, ownerPath);
			// Anything the copy queued under the OLD id before resolution is
			// orphaned. Discard it only when this session provably has no other
			// writer for that id (no live owner record, no canvas view).
			const canvasOpen =
				this.app.workspace.getLeavesOfType(HANDWRITING_PAGE_VIEW_TYPE).length > 0;
			if (verdict === "old-queue-orphaned" && !canvasOpen) {
				this.store.discardPending(id);
			}
			const cam = this.settings.cameras[id];
			if (cam) this.settings.cameras[newId] = { ...cam };
			this.persistOwners();
			new Notice(
				`Handwriting: "${file.basename}" was a copy of another Handwriting note. It now has its own ink identity` +
					(cloned === "cloned"
						? " and an independent copy of the ink."
						: cloned === "unreadable"
							? ". Its ink could not be copied because the source file is unreadable. The original was left untouched."
							: ".")
			);
		} finally {
			this.resolvingDuplicates.delete(copyPath);
		}
	}

	/** Ownership memory rides the ordinary debounced settings flush. */
	private persistOwners(): void {
		this.settings.pageOwners = this.pageIds.snapshot();
		this.settingsDirty = true;
		if (this.settingsTimer !== null) window.clearTimeout(this.settingsTimer);
		this.settingsTimer = window.setTimeout(
			() => runDetached(this.flushSettings(), "flush ownership settings"),
			2000
		);
	}

	private async applyPressureSensitivity(on: boolean): Promise<void> {
		setPressureSensitivity(on);
		this.settings.pressureSensitivity = on;
		// Render-time law: a repaint restyles every committed stroke.
		repaintAllInkOverlays();
		await this.persistSettings();
		new Notice(
			on ? "Handwriting: pressure sensitivity on" : "Handwriting: pressure sensitivity off"
		);
	}

	/**
	 * Selecting a color picks up its tool: choosing "highlighter yellow" is
	 * reaching for the yellow highlighter, not annotating a preference for
	 * later (alan, 2026-08-31). The nib goes active and every tip mode ends,
	 * exactly as the tool's own command does it.
	 */
	private pickUpNib(tool: InkTool): void {
		markPenSeen();
		refreshPenToolsAll();
		setInlineTool(tool);
		setInlineEraserMode(false);
		setInlineLassoMode(false);
		setInlineSpaceMode(false);
		setInlinePanMode(false);
	}

	/**
	 * The COMMAND path for choosing a color. The strip's swatches take a
	 * different one (pickStripColor), and the two have to agree about the
	 * strip.
	 *
	 * They did not. pickStripColor ends in refreshAllStrips(); this ended in
	 * a save, so the palette button kept its old tint and the ring in the
	 * swatch pop stayed on the old color until something else happened to
	 * rebuild it. Opening the pop from the palette button rebuilds it, which
	 * is exactly the workaround the report describes: change the color, see
	 * nothing move, open the palette from the ink color icon, and the ring is
	 * suddenly right (StellarRaccoon, issue #5).
	 *
	 * "Ink color: next" made it worse. It calls pickUpNib first, which
	 * refreshes, and only then lands here to change the color - so the one
	 * refresh in the sequence ran against the value being replaced.
	 *
	 * Refresh BEFORE the save, and do not wait on it: the indicator answers
	 * for session state, which setInkColorHex has already changed, and it has
	 * no reason to wait on a disk write. If the save then fails the caller's
	 * handler says so, and the strip was not lying in the meantime.
	 */
	private async setInkColor(tool: InkTool, hex: string, name: string): Promise<void> {
		this.settings.inkColors[tool] = setInkColorHex(tool, hex);
		refreshAllStrips();
		await this.persistSettings();
		new Notice(`Handwriting: ${tool} ${name}`);
	}

	private async setInkSize(mult: number, name: string): Promise<void> {
		const tool = getInlineTool();
		setInkSizeMult(tool, mult);
		this.settings.inkSizes[tool] = clampInkSize(mult);
		await this.persistSettings();
		new Notice(`Handwriting: ${tool} size ${name}`);
	}

	private async setEraserSize(radiusPx: number, name: string): Promise<void> {
		setEraserRadiusPx(radiusPx);
		this.settings.eraserRadiusPx = clampEraserRadius(radiusPx);
		await this.persistSettings();
		new Notice(`Handwriting: eraser ${name}`);
	}

	/** "Delete all ink": confirm first. The count in the dialog is live. */
	private confirmDeleteAllInk(path: string): void {
		const count = inlineInk.strokes(path).length;
		if (count === 0) return;
		new ConfirmDeleteInkModal(this.app, count, "note", () => {
			runDetached(this.deleteAllInk(path), `delete all ink on ${path}`);
		}).open();
	}

	/**
	 * The confirmed wipe. Order matters and follows the permanence invariant:
	 * the .handwriting/trash/ safety copy is made BEFORE anything is removed, and a
	 * failed copy aborts the wipe entirely. Handwriting never deletes ink it could
	 * not first preserve. A damaged (unreadable) sidecar skips the copy: the
	 * file on disk is already the artifact being protected, the wipe writes
	 * nothing there (fail-closed lock), and only session strokes are cleared.
	 */
	private async deleteAllInk(path: string): Promise<void> {
		let kept: string | null = null;
		const pageId = inlineInk.pageIdOf(path);
		if (pageId && !inlineInk.isDamagedLocked(path)) {
			try {
				kept = await this.store.preserve(pageId);
			} catch (err) {
				console.error("[handwriting] delete-all-ink backup failed", err);
				new Notice(
					"Handwriting: could not copy this note's ink to the trash (disk error). Nothing was deleted."
				);
				return;
			}
		}
		const n = deleteAllInkOn(path);
		if (n === null) {
			new Notice("Handwriting: open the note in editing view to delete its ink.");
			return;
		}
		const what = n === 1 ? "1 stroke" : `${n} strokes`;
		new Notice(
			kept
				? `Handwriting: removed ${what}. Undo restores them; a copy is kept in ${kept}.`
				: `Handwriting: removed ${what}. Undo restores them.`
		);
	}

	/**
	 * The note a page id belongs to, for user-facing messages (RC4).
	 *
	 * The ownership ledger is the cheap answer and is right whenever the note
	 * has been seen this session. It can miss (a census that has not run, an
	 * id freed by a hand edit), so the vault is the fallback, and a page id
	 * that resolves to nothing at all degrades to the short id rather than
	 * printing an empty name. There is genuinely nothing better to say then.
	 */
	private noteNameFor(pageId: string): string {
		const known = this.pageIds.owner(pageId);
		if (known) return known;
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (this.recentPageIdFor(f) === pageId) return f.path;
		}
		return `an unnamed page (${pageId.slice(0, 8)}…)`;
	}


	/**
	 * Everything a tip-mode command does once its mode is set, in the order
	 * the order matters in.
	 *
	 * The two halves were both added for the same user report and they
	 * collided. `markPenSeen`/`refreshPenToolsAll` is the UI half - without
	 * it the strip never appears for someone who has not held a pen, and the
	 * palette entry looks like it did nothing. `armTipModeInput` is the
	 * FUNCTIONAL half - without it the mode is set and nothing can read it,
	 * because `InlinePenRouter.mouseActsAsPen` gates every mouse contact on
	 * `mouseInkEnabled()`.
	 *
	 * The functional half goes first because it declines once a pen has been
	 * seen, and the UI half's `markPenSeen` is what makes that true. Reversed,
	 * it can never fire from a command callback at all.
	 */
	private enterTipMode(on: boolean): void {
		// A tool is only reachable once the tip exists; see armTipModeInput.
		// FIRST: it declines once a pen has been seen, and markPenSeen below
		// is what makes that true. Reversed, it can never fire at all.
		if (on) this.armTipModeInput();
		// Asking for a pen tool is asking for the pen UI: without this, the
		// command worked invisibly when no pen had been seen and the palette
		// appeared to do nothing.
		markPenSeen();
		refreshPenToolsAll();
	}

	/**
	 * Everything the strip on every open surface needs to hear when mouse
	 * ink flips, on or off. The mouse-ink-toggle command and the settings
	 * switch are the only two writers of this mode (a9bf181) and both owe it
	 * the same pair, so it lives once here rather than twice at the call
	 * sites - the duplication a9bf181 accepted deliberately turned out to be
	 * exactly the kind this project keeps paying for.
	 *
	 * ON: `markPenSeen` may flip the strip's VISIBILITY (false to true, for
	 * someone who has never held a pen), which only `refreshPenToolsAll`'s
	 * `ensurePenTools` create-or-destroy sweep can do, and only on this
	 * file's own editor overlays - `PdfInkController` lives in a different
	 * map and is not in that sweep at all. Once a strip already exists (the
	 * ordinary case), that sweep is a no-op and the light on it never
	 * repaints, on EITHER surface.
	 *
	 * `refreshAllStrips` is what actually repaints an existing strip's
	 * light, and it is the one call that also reaches the PDF surface, via
	 * the `addStripSurface` registration below. So both directions need it:
	 * ON needs `refreshPenToolsAll` first for the rare create, then
	 * `refreshAllStrips` for the light; OFF needs only `refreshAllStrips` -
	 * `clearPenHardwareSeen` moves no surface's existence (`penSeen` is left
	 * alone on purpose, so the toolbar itself never disappears), so
	 * `refreshPenToolsAll` there was a guaranteed no-op and the light simply
	 * never moved until an unrelated tap repainted it (alan, hardware
	 * finding 2026-09-03: "you have to tap a couple times for pen to
	 * light").
	 */
	// Not private: HandwritingSettingTab is the mode's second writer
	// (a9bf181) and calls this through `this.plugin`, the same access
	// `applyBooxMode` already gets for the same reason.
	applyMouseInkUiFanout(on: boolean): void {
		if (on) {
			markPenSeen();
			refreshPenToolsAll();
		} else {
			clearPenHardwareSeen();
		}
		refreshAllStrips();
		// OFF also strands a reticle. The pointer that raised it is a mouse,
		// still sitting over the pane - no pointerleave is coming, and both
		// surfaces exempt an armed mouse from the hover watchdog that would
		// otherwise hide it. So the ring, and `cursor: none` with it, outlived
		// the mode that justified them until something unrelated repainted.
		// See `hidePenCursorsEverywhere` for the whole reasoning; it is the
		// hide half of exactly the fan-out this function is the light half of.
		if (!on) hidePenCursorsEverywhere();
	}

	/**
	 * What the eraser/lasso/insert-space/pan toggle commands say when they
	 * turn OFF. One place, called from all four, for the same reason
	 * `enterTipMode` is: a rule written at each of four call sites is a rule
	 * that drifts at one of them eventually.
	 *
	 * Ordinarily this just names the nib the tip fell back to - a pen or
	 * touch tap really did just pick that nib back up by putting the mode
	 * down, and the toast says so. `consumeMousePutDown` (MouseInk.ts) is the
	 * one exception: MobileTools.ts's strip sets that flag immediately before
	 * calling this command as part of a MOUSE put-down (b93edd1), where nothing
	 * was picked - the mouse only got its pointer back - and the nib name was
	 * wrong there (alan, hardware finding 2026-09-03: "it says highlighter
	 * after doing it"). That case gets the words the loud mouse-ink-toggle
	 * command's own OFF branch already uses, matched rather than invented, and
	 * still exactly one Notice - the flag is consumed (read-and-clear), never
	 * adding a second toast on top of this one.
	 */
	private tipModeOffNotice(): string {
		return consumeMousePutDown() ? "Handwriting: cursor" : `Handwriting: ${getInlineTool()}`;
	}

	/**
	 * A tip mode means nothing until the tip exists.
	 *
	 * Eraser, lasso, insert space and pan all say what the TIP does, and on a
	 * machine with no pen the mouse is not a tip until mouse ink is on. So a
	 * hotkey for any of them set a mode that nothing read, and the command
	 * looked simply broken: ctrl+shift+E did nothing at all until ctrl+shift+D
	 * had been pressed first (user report with video, 2026-08-30).
	 *
	 * Asking for a tool is asking to draw with it, so the tool turns the mouse
	 * on for someone who has not used a pen this session. A pen user's mouse is
	 * left alone - they did not ask for it, and claiming the mouse costs them
	 * text selection.
	 *
	 * FOR THIS SESSION ONLY (alan, 2026-09-04: "dont persist a quiet arm").
	 * This used to write `settings.mouseInk = true` and save, so one press of
	 * ctrl+shift+E was the reason mouse ink came up armed at every launch from
	 * then on - part of what users reported as mouse ink "keeps turning on by
	 * itself". The hotkey's user asked for the ERASER; the arm is the least
	 * that request needs to work at all, and it is not an answer to the
	 * question the mouse-ink toggle command asks. The load line
	 * (`setMouseInk(this.settings.mouseInk)`) is unchanged, so this is gone at
	 * the next launch and an explicit ON is not.
	 *
	 * Returns whether it turned mouse ink on. NOTHING READS THAT TODAY -
	 * `enterTipMode` discards it, and the `(mouse ink on)` notice suffix this
	 * sentence was written for was removed by the toast-wording pass. The
	 * value is kept rather than dropped because whether the notice should say
	 * so again is alan's call, and deleting it would settle that quietly.
	 */
	private armTipModeInput(): boolean {
		if (mouseInkEnabled() || penSeenThisSession()) return false;
		// `armMouseInkQuietly`, not the raw setter, and not because the two
		// differ today: since the persist came off this path they are the
		// same two lines, guard included, and a rule implemented twice is
		// this project's most expensive recurring defect. The quiet arm's
		// meaning - and every sentence about why it writes nothing - lives in
		// MouseInk.ts; this reads as the caller of that rule rather than a
		// second copy of it that a later change could silently fork. The raw
		// `setMouseInk` import stays for the loud writers below, which is what
		// MouseInkWriterInvariant.test.ts pins this file as.
		armMouseInkQuietly();
		markPenSeen();
		refreshPenToolsAll();
		return true;
	}
	onunload(): void {
		// First, so that anything still waiting on onLayoutReady finds it set.
		this.unloaded = true;
		// Pending recycles are DROPPED, never run early. A sidecar left in
		// place is an orphan somebody can delete; ink recycled for a note
		// that was about to come back is the failure this delay exists to
		// prevent, and unload is exactly when a sync is most likely still
		// mid-pair. The next session's delete will schedule it again.
		for (const timer of this.pendingRecycle.values()) window.clearTimeout(timer);
		this.pendingRecycle.clear();
		// Same reasoning for pending declaims: not confirming one leaves a
		// note holding an id it may no longer carry, which the next session's
		// census resolves. Confirming one at unload could free an id from a
		// note whose frontmatter was mid-edit when the plugin went down.
		for (const timer of this.declaimTimers.values()) window.clearTimeout(timer);
		this.declaimTimers.clear();
		this.applyPaper("none");
		document.body.classList.remove("handwriting-active-page");
		document.body.classList.remove("handwriting-boox");
		// loadSettings adds this on Android; a disabled plugin must not leave
		// the Android toolbar clearance CSS armed.
		document.body.classList.remove("handwriting-android");
		destroyProbeMarkers();
		// The print swap arms itself once per window and the guard is a WeakSet
		// in module scope, which a reload replaces - leaving the previous pair
		// on the window, calling into the old module on every print.
		disarmPrintSwaps();
		// And take the layers themselves back out. They live in rendered
		// views, hover previews and exported panes - someone else's DOM,
		// which Obsidian does not clean up for us - so without this a
		// disabled plugin kept showing ink until each section re-rendered.
		teardownEmbedInk();
		setHitProbeEnabled(false);
		// Obsidian's lifecycle contract is `onunload(): void`; it does not
		// wait for asynchronous cleanup. This is best effort, not crash
		// durability: a process killed before the I/O finishes can still
		// lose pending ink (README, Limitations).
		runDetached(this.finishPersistence(), "finish persistence during unload");
	}

	/** The first launch after an update says what changed, once. */
	private showWhatsNewIfDue(): void {
		const d = decideWhatsNew(
			this.manifest.version,
			this.settings.lastSeenVersion,
			this.freshInstall
		);
		if (d.show) {
			try {
				new Notice(
					whatsNewFragment(d.version, d.notes, d.groups),
					whatsNewDurationMs(d.notes.length)
				);
			} catch (err) {
				// Recording first would spend the one chance this user gets.
				// The notes appear on exactly ONE launch, so a popup that threw
				// is a popup nobody will ever read: leave the version
				// unrecorded and let the next launch try again.
				console.error("[handwriting] the what's new notice failed to open", err);
				return;
			}
		}
		if (d.record !== this.settings.lastSeenVersion) {
			this.settings.lastSeenVersion = d.record;
			runDetached(this.persistSettings(), "remember the version whose notes were shown");
		}
	}

	/** Status-bar dot while a bug-report recording is running. A toast was
	 * the only sign, and a toast is gone in seconds - people forgot it was
	 * on and wondered why nothing said so. */
	private recordingBadge: HTMLElement | null = null;

	syncRecordingBadge(): void {
		if (!this.recordingBadge) {
			this.recordingBadge = this.addStatusBarItem();
			this.recordingBadge.addClass("handwriting-recording-badge");
		}
		this.recordingBadge.setText(diagnosticsEnabled() ? "● recording pen" : "");
		this.recordingBadge.toggleClass("is-recording", diagnosticsEnabled());
	}

	/**
	 * FIRST call in both bug-report viewers, before any state change:
	 * an empty capture is an upload (or a text report) nobody can use,
	 * and stopping a still-running recording just to say so would end a
	 * reproduction the tester has not started yet. "Bug report: send"
	 * carried this guard alone; "Bug report: show as text" had none, so
	 * opening it on an empty trace could silently end a live recording
	 * (1.4.6-design.md §5g, Y1). Lifted here so both commands agree.
	 *
	 * Two different emptinesses get two different messages: recording
	 * never started, or it is running and the bug has not been
	 * reproduced yet. One message for both sent a tester in circles.
	 */
	private guardEmptyTrace(): boolean {
		const verdict = traceGuardVerdict(captureInlinePenTrace({}).events.length, diagnosticsEnabled());
		if (verdict === "proceed") return false;
		new Notice(
			verdict === "reproduce"
				? "Handwriting: recording is on - reproduce the bug with the pen, then send"
				: "Handwriting: nothing recorded - run Bug report: record first"
		);
		return true;
	}

	/** The background/freeze path: start every pending write, wait for none. */
	private flushOnHide(): void {
		this.store.flushDispatch();
		// flushSettings clears its timer and reaches saveData synchronously;
		// detached because its completion cannot be awaited under a freeze.
		runDetached(this.flushSettings(), "flush settings on hide");
	}

	/** Best-effort shutdown: settle in-flight claims and loads, then flush. */
	private async finishPersistence(): Promise<void> {
		try {
			await inlineInk.settle();
		} catch (err) {
			console.error("[handwriting] settle on unload failed", err);
		}
		try {
			await this.store.flush();
		} catch (err) {
			console.error("[handwriting] flush on unload failed", err);
		}
		try {
			await this.flushSettings();
		} catch (err) {
			console.error("[handwriting] settings flush on unload failed", err);
		}
	}

	// ---- HandwritingHost ----------------------------------------------------------

	getCamera(pageId: string): CameraState | undefined {
		return this.settings.cameras[pageId];
	}

	setCamera(pageId: string, cam: CameraState): void {
		const prev = this.settings.cameras[pageId];
		if (prev && prev.x === cam.x && prev.y === cam.y && prev.zoom === cam.zoom) return;
		this.settings.cameras[pageId] = cam;
		this.settingsDirty = true;
		if (this.settingsTimer !== null) window.clearTimeout(this.settingsTimer);
		this.settingsTimer = window.setTimeout(
			() => runDetached(this.flushSettings(), "flush camera settings"),
			2000
		);
	}

	// ---- pages --------------------------------------------------------------

	private async newPage(): Promise<void> {
		const folder = this.app.workspace.getActiveFile()?.parent?.path ?? "";
		const base = "Handwriting page";
		const path = await this.firstFreePath((n) => this.pathFor(folder, n === 1 ? base : `${base} ${n}`));
		const pageId = newPageId();
		try {
			const file = await this.app.vault.create(path, newPageMarkdown(pageId));
			const leaf = this.app.workspace.getLeaf(true);
			await leaf.setViewState({
				type: HANDWRITING_PAGE_VIEW_TYPE,
				state: { file: file.path },
				active: true,
			});
			await this.app.workspace.revealLeaf(leaf);
		} catch (err) {
			console.error("[handwriting] could not create page", err);
			new Notice("Handwriting: could not create the page. See the developer console.");
		}
	}

	private pathFor(folder: string, name: string): string {
		return normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
	}

	/**
	 * Open any note on the canvas.
	 *
	 * There is no conversion step, because there is nothing to convert to: this
	 * changes which view is showing the note, and touches the file not at all.
	 * The note's own body is what you see and can write next to; if you never
	 * draw, the file is never written.
	 */
	private async openAsHandwriting(file: TFile): Promise<void> {
		this.preferMarkdown.delete(file.path);
		this.canvasIntent.add(file.path);
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.setViewState({
			type: HANDWRITING_PAGE_VIEW_TYPE,
			state: { file: file.path },
			active: true,
		});
	}

	/** Open the pen probe in a new tab. Its own leaf, so the note stays put. */
	private async openPenDiagnostics(): Promise<void> {
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({
			type: HANDWRITING_DIAGNOSTICS_VIEW_TYPE,
			active: true,
		});
	}

	private activeHandwritingView(): HandwritingPageView | null {
		const view = this.app.workspace.getActiveViewOfType(HandwritingPageView);
		return view ?? null;
	}

	private isHandwritingPage(file: TFile): boolean {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const marker: unknown = fm?.["handwriting"];
		return marker === "page" || marker === true;
	}

	private async maybeSwapView(file: TFile | null): Promise<void> {
		if (!file || file.extension !== "md") return;
		// The marker is a preference, not a lock: the user asked for Markdown on
		// this note, so leave it in Markdown until they ask for the canvas again.
		if (this.preferMarkdown.has(file.path)) return;
		if (!this.isHandwritingPage(file)) return;
		if (this.swapping.has(file.path)) return;

		const leaves = this.app.workspace.getLeavesOfType("markdown");
		const target = leaves.find(
			(leaf) => (leaf.view as { file?: TFile }).file?.path === file.path
		);
		if (!target) return;
		this.swapping.add(file.path);
		try {
			await this.swapLeaf(target, file);
		} finally {
			this.swapping.delete(file.path);
		}
	}

	private async swapLeaf(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
		await leaf.setViewState({
			type: HANDWRITING_PAGE_VIEW_TYPE,
			state: { file: file.path },
			active: true,
		});
	}

	private async onFileDeleted(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || file.extension !== "md") return;
		// The metadata cache is already gone by now, so read the id we stored
		// in settings-free fashion: scan our camera map is not enough, so we
		// simply leave unknown sidecars alone rather than risk deleting data.
		const freed = this.pageIds.handleDelete(file.path);
		const pageId = this.recentPageIdFor(file) ?? freed[0];
		if (!pageId) return;
		// A note's frontmatter is free text and can name ANY id. One naming a
		// PDF's - a copied property, a hand edit, a template - meant deleting
		// that NOTE recycled the PDF's ink, taking a document's annotations
		// with a note that never owned them. A note never legitimately holds
		// a pdf id, so this is a refusal, not a heuristic.
		if (isPdfInkId(pageId)) return;
		// Duplicate guard: if ANOTHER note still carries this id (an
		// unresolved duplicate pair), the sidecar still belongs to a living
		// note. Recycling it now would take that note's ink with this one.
		const survivor = this.findOtherCarrier(pageId, file.path);
		if (survivor) {
			this.pageIds.claimOwnership(pageId, survivor);
			this.ambiguousIds.delete(pageId);
			inlineInk.clearDuplicateLock(survivor);
			this.persistOwners();
			return;
		}
		this.ambiguousIds.delete(pageId);
		this.scheduleRecycle(pageId);
	}

	/**
	 * Recycle a deleted note's ink, but not yet.
	 *
	 * Obsidian Sync, git and every folder-syncing tool express a rename, a
	 * branch switch or a conflict resolution as DELETE followed by CREATE.
	 * Recycling on the delete therefore took the ink out from under a note
	 * that was about to come straight back - on every device at once, since
	 * every device sees the same pair. The note returns with its page id
	 * intact, finds no sidecar, and opens blank.
	 *
	 * A real delete is still a delete: the ink goes to the trash a few
	 * seconds later. Waiting costs nothing (the sidecar is not in anyone's
	 * way meanwhile) and the failure it prevents is silent.
	 */
	private scheduleRecycle(pageId: string): void {
		const existing = this.pendingRecycle.get(pageId);
		if (existing !== undefined) window.clearTimeout(existing);
		this.pendingRecycle.set(
			pageId,
			window.setTimeout(() => {
				this.pendingRecycle.delete(pageId);
				runDetached(this.recycleIfStillGone(pageId), `recycle ink for ${pageId}`);
			}, RECYCLE_GRACE_MS)
		);
	}

	/**
	 * The grace period is over: recycle only if the note really is gone.
	 *
	 * Asked by ID, not by path, because the create half of a sync's
	 * delete+create can land at a DIFFERENT name - that is exactly what a
	 * rename arriving over sync looks like from here.
	 */
	private async recycleIfStillGone(pageId: string): Promise<void> {
		// No path is excluded from the search - the deleted one is gone, and
		// any file carrying this id now is the note come back.
		if (this.findOtherCarrier(pageId, "") !== null) return;
		await this.store.remove(pageId);
		delete this.settings.cameras[pageId];
		delete this.settings.pageOwners[pageId];
		this.settingsDirty = true;
		await this.flushSettings();
	}

	/**
	 * Best-effort page id for a file that has just been deleted. Deliberately
	 * conservative: if we cannot prove which sidecar belongs to it, we keep the
	 * sidecar. An orphaned file is recoverable; deleted ink is not.
	 */
	private recentPageIdFor(file: TFile): string | undefined {
		const cache = this.app.metadataCache.getCache(file.path);
		const fm = cache?.frontmatter;
		const id: unknown = fm?.["handwriting-page-id"];
		// The other frontmatter ingress, and the one the ownership ledger,
		// the duplicate check and sidecar deletion all read through. An id
		// that cannot be a path name is not an identity here either; see
		// isSafePageId.
		return isSafePageId(id) ? id : undefined;
	}

	/**
	 * Say once, per note, that its `handwriting-page-id` cannot be used.
	 *
	 * Once, because readPageId runs on every attach and every frontmatter
	 * change: a notice per call would be a wall. The note is otherwise
	 * untouched - nothing is rewritten until the user actually draws.
	 */
	private warnUnusablePageId(path: string): void {
		if (this.badPageIds.has(path)) return;
		this.badPageIds.add(path);
		new Notice(
			`Handwriting: the handwriting-page-id in ${path} is not a usable id, so this note counts as having no ink yet. Drawing on it will assign a new one.`
		);
	}

	// ---- settings -----------------------------------------------------------

	/** One ruled style at a time: clear both classes, then set the one asked for. */
	applyPaper(style: PaperStyle): void {
		// Every window, not just the main one: popout editors carry their
		// own document, and paper that stops at the popout border reads as
		// broken. window-open (registered at load) stamps late arrivals.
		const docs = new Set<Document>([document]);
		this.app.workspace.iterateAllLeaves((leaf) => {
			docs.add(leaf.view.containerEl.ownerDocument);
		});
		for (const doc of docs) this.applyPaperTo(doc, style);
	}

	private applyPaperTo(doc: Document, style: PaperStyle): void {
		doc.body.classList.remove("handwriting-paper-lines", "handwriting-paper-grid");
		const cls = paperClass(style);
		if (cls) doc.body.classList.add(cls);
	}

	/**
	 * Point the ink at a different folder, moving what is already there.
	 *
	 * Order matters: settle pending writes, MOVE the files, then repoint the
	 * store, then persist. Repointing first would send reads to a folder the
	 * files have not reached; moving without settling could race a debounced
	 * write into the folder being emptied.
	 *
	 * None of that ordering is load-bearing for the user's data, and it must
	 * not be: `PageStore.readPath` falls back to the default folder, so a move
	 * interrupted anywhere - including a settings save that never lands -
	 * leaves every page readable from wherever it actually is.
	 */
	async changeInkFolder(raw: string): Promise<void> {
		const next = normalizeInkFolder(raw);
		const outcome = await changeFolder(
			{
				// The inline store's claims AND the sidecar store's own queue.
				// Only the first was settled, so a debounced save could still
				// be sitting in its timer when the move began - and land in
				// the folder migrateInkFolder had just finished emptying,
				// where nothing would ever read it again.
				settle: async () => {
					if (!(await inlineInk.settle())) return false;
					await this.store.flush();
					return !this.store.busy;
				},
				migrate: (from, to) => migrateInkFolder(this.app.vault.adapter, from, to),
				repoint: (to) => this.store.useInkFolder(to),
				persist: async (to) => {
					this.settings.inkFolder = to;
					// saveSettingsNow is synchronous; awaiting it awaited undefined.
					this.saveSettingsNow();
				},
			},
			this.store.inkFolder(),
			next
		);
		if (outcome.kind === "unchanged") return;
		if (outcome.kind === "busy") {
			new Notice("Handwriting: ink is still saving, so the folder was not changed. Try again.");
			return;
		}
		if (outcome.kind === "unsupported") {
			new Notice("Handwriting: this vault cannot list files, so the ink was not moved.");
			return;
		}
		const { moved, skipped } = outcome.result;
		const left = skipped > 0 ? `, ${skipped} left behind (name already taken)` : "";
		new Notice(
			`Handwriting: ink folder is now "${next}". Moved ${moved} file(s)${left}.` +
				(inkFolderSyncs(next) ? "" : " This folder is hidden and will not sync.")
		);
	}

	private async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<HandwritingSettings> | null;
		// No settings file at all means nobody has ever run this plugin here.
		// An update always leaves one behind, so this - not a missing
		// lastSeenVersion - is what tells a new user from an updating one.
		this.freshInstall = raw === null;
		this.settings = {
			cameras: raw?.cameras && typeof raw.cameras === "object" ? raw.cameras : {},
			inkSizes: {
				pen: clampInkSize(raw?.inkSizes?.pen ?? 1),
				highlighter: clampInkSize(raw?.inkSizes?.highlighter ?? 1),
			},
			inkColors: {
				pen: normalizeInkColor("pen", raw?.inkColors?.pen),
				highlighter: normalizeInkColor("highlighter", raw?.inkColors?.highlighter),
			},
			// Vaults written before the rename carry `inkShaping`, which drove the
			// same toggle. Honour it once so nobody's choice is silently reset.
			pressureSensitivity:
				raw?.pressureSensitivity ??
				(raw as { inkShaping?: boolean } | undefined)?.inkShaping !== false,
			// Its own key, deliberately not the legacy `inkShaping` one above:
			// that key is already spoken for by the pressure toggle it was
			// renamed into, and reading it here would make one old choice
			// silently set two different things.
			inkSmoothing: raw?.inkSmoothing !== false,
			pageOwners:
				raw?.pageOwners && typeof raw.pageOwners === "object" ? raw.pageOwners : {},
			eraserRadiusPx: clampEraserRadius(raw?.eraserRadiusPx ?? DEFAULT_ERASER_RADIUS_PX),
			mouseInk: raw?.mouseInk === true,
			strokePrediction: raw?.strokePrediction !== false,
			booxMode: raw?.booxMode === true,
			paperStyle: normalizePaperStyle(raw?.paperStyle),
			penTools: normalizePenToolsMode(raw?.penTools),
			// A fresh key on purpose: the old boolean keys carried the OLD
			// default in every data.json (full-object saves), so reading
			// them pinned the whole fleet to reticle and the stroke default
			// reached nobody. Reticle is chosen from here on, never inherited.
			eraserMode: raw?.eraserMode === "reticle" ? "reticle" : "stroke",
			penReticle: raw?.penReticle !== false,
			shapeSnap: raw?.shapeSnap !== false,
			devDiagnostics: raw?.devDiagnostics === true,
			colorSizeCommands: raw?.colorSizeCommands === true,
			toolbarCorner: normalizeToolbarCorner(raw?.toolbarCorner),
			inkFolder: normalizeInkFolder(raw?.inkFolder),
			lastSeenVersion: typeof raw?.lastSeenVersion === "string" ? raw.lastSeenVersion : null,
		};
		// Android pulls its notification shade from the very top of the glass,
		// and that gesture wins over anything underneath it: a top-corner
		// toolbar sitting 8px down had its taps eaten outright (boox go 6,
		// 2026-08-30, reported by a user who could not press a single tool).
		// Marked here rather than handled in CSS alone, because the clearance
		// must NOT apply on ios, where the same 8px is correct and a shifted
		// toolbar would be a regression for everyone already using it.
		if (Platform.isAndroidApp) document.body.classList.add("handwriting-android");
		// No data.json means the folder choice is gone, not that the ink is.
		// A vault synced in compatibility mode carries `handwriting/` and not
		// this file, so a second device would start on `.handwriting`, read
		// nothing, and fork a second sidecar per page. Adopt the folder the
		// vault is visibly already using. Only when there is nothing to ask:
		// a stored choice, including the default, is always obeyed.
		if (this.freshInstall) {
			this.settings.inkFolder = await adoptInkFolder(this.app.vault.adapter);
		}
		setPenToolsMode(this.settings.penTools);
		setToolbarCorner(this.settings.toolbarCorner);
		// The store is constructed before settings are read, so it starts on
		// the default folder and is pointed at the real one here - before any
		// note is opened, so nothing ever reads from the wrong place.
		this.store.useInkFolder(this.settings.inkFolder);
		// The strip's eraser slider persists through here on release.
		setPersistEraserRadius((px) => {
			this.settings.eraserRadiusPx = px;
			runDetached(this.persistSettings(), "save the eraser size");
		});
		setPersistEraserMode((on) => {
			this.settings.eraserMode = on ? "stroke" : "reticle";
			runDetached(this.persistSettings(), "save the eraser mode");
		});
		// No writer for mouse ink beside these four, and its absence is the
		// rule rather than an omission: a quiet arm is for this session only
		// (alan, 2026-09-04) and the two places that DO write it - the
		// mouse-ink toggle command and the settings switch - write
		// `settings.mouseInk` themselves. See MouseInk.ts.
		setPersistInkColor((tool, hex) => {
			this.settings.inkColors[tool] = hex;
			runDetached(this.persistSettings(), "save the ink color");
		});
		setPersistInkSize((tool, mult) => {
			this.settings.inkSizes[tool] = clampInkSize(mult);
			runDetached(this.persistSettings(), "save the ink size");
		});
		// The pdf store writes through the same PageStore as notes: same
		// debounce, same conflict guard, same trash, same ink folder. Only the
		// id shape and the surface tag differ.
		this.pdfStore.attachHost({
			load: (id) => this.store.load(id),
			schedule: (id, data) => this.store.schedule(id, data),
			notice: (message) => void new Notice(message),
		});
		setMouseInk(this.settings.mouseInk);
		// applyPaper's iterateAllLeaves walks the workspace's restored layout;
		// called here, during onload before layout is restored, it would see
		// none of the popouts a reload is about to bring back (Obsidian plugin
		// guidelines: don't call iterateAllLeaves before onLayoutReady). The
		// plugin already gates the equivalent case for maybeSwapView, whose
		// own onLayoutReady registration sits beside the file-open handler, so
		// mirror that: stamp the main document now - it must never sit bare
		// while layout comes back - then run applyPaper in full once the
		// layout is restored. (The first version of this comment cited line
		// numbers for both, and both had moved by the time anyone read it.)
		this.applyPaperTo(document, this.settings.paperStyle);
		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) return;
			this.applyPaper(this.settings.paperStyle);
		});
		setInkSizeMult("pen", this.settings.inkSizes.pen);
		setInkSizeMult("highlighter", this.settings.inkSizes.highlighter);
		setPressureSensitivity(this.settings.pressureSensitivity);
		this.applyBooxMode();
		setInkColorHex("pen", this.settings.inkColors.pen);
		setInkColorHex("highlighter", this.settings.inkColors.highlighter);
		setEraserRadiusPx(this.settings.eraserRadiusPx);
		setEraserWholeStrokes(this.settings.eraserMode === "stroke");
		setShapeSnap(this.settings.shapeSnap);
	}

	/**
	 * Boox mode: the slice of e-ink latency the plugin owns. E-ink pays per
	 * redraw, so everything that redraws for polish goes quiet while it is
	 * on - prediction (draws ahead, then corrects), ink smoothing (reshapes
	 * behind the nib) and the chrome's animations (via body class). Runtime
	 * overrides, never setting rewrites: toggling off restores the user's
	 * own choices exactly.
	 */
	applyBooxMode(): void {
		const on = this.settings.booxMode;
		document.body.classList.toggle("handwriting-boox", on);
		// Prediction is EXTENDED on e-ink, not paused: the first NoteAir
		// trace (2026-09-01) measured the webview delivering pen events
		// 58-103ms late - the one delay prediction can mask, and the 12ms
		// default horizon vanishes inside it. Boox mode runs prediction
		// with e-ink caps; the user's own toggle returns when it is off.
		setPredictionEink(on);
		setPrediction(on || this.settings.strokePrediction);
		setInkShaping(this.settings.inkSmoothing && !on);
		// The reticle is a dot repainted under the pen on every event: a
		// second damaged region per frame, which e-ink pays for.
		setPenReticle(this.settings.penReticle && !on);
		// The settings tab's penReticle toggle routes through here, same as
		// Boox mode - without this, a showing PDF dot cleared only via the
		// 1s hide timer or the next unrelated fan-out (Z addendum).
		refreshAllStrips();
	}

	/** Settings-tab writes: persist now, quietly. */
	saveSettingsNow(): void {
		runDetached(this.persistSettings(), "save settings");
	}

	/**
	 * The one path to data.json. Until 2026-09-02 two paths wrote it: a
	 * debounced one (settingsDirty + settingsTimer -> flushSettings,
	 * awaiting one write at a time) and a direct one - fourteen call sites
	 * doing `runDetached(this.saveData(...), ...)` or a bare
	 * `await this.saveData(...)` on the settings object - that touched
	 * neither the dirty flag nor the timer. A direct write while a flush
	 * was pending raced it on the same data.json, and a direct write never
	 * cleared settingsDirty, so the flush that followed was a redundant
	 * third write of the same object. Obsidian's saveData is not
	 * documented atomic; overlapping writes of data.json is how the file
	 * gets truncated. See audit-fixes-design.md section 5d (E1), verified
	 * 2026-09-02.
	 *
	 * Every write goes through here now, serialized by a one-deep "write
	 * again after" latch rather than a queue: the payload passed to the
	 * adapter is always `this.settings`, the whole object, so whatever is
	 * current when a write finishes is the right thing to write next -
	 * there is nothing to queue.
	 *
	 * THE FREEZE RULE, same lesson as PageStore.flushDispatch (Slice B,
	 * commit fc08583): iOS and Android can freeze the webview on
	 * backgrounding with no further JS, so the write that has to beat the
	 * freeze is the one dispatched synchronously, with no await in front
	 * of it anywhere in the call path from flushOnHide down to here. The
	 * latch check below is synchronous and falls straight through to the
	 * adapter call with nothing awaited first; only the "write again
	 * after" continuation, chained with `.then`, awaits.
	 */
	private persistSettings(): Promise<void> {
		if (this.settingsTimer !== null) {
			window.clearTimeout(this.settingsTimer);
			this.settingsTimer = null;
		}
		this.settingsDirty = false;
		if (this.settingsWriting) {
			this.settingsWriteAgain = true;
			return this.settingsWriting;
		}
		const write = (): Promise<void> =>
			this.saveData(this.settings).then(
				() => {
					if (!this.settingsWriteAgain) {
						this.settingsWriting = null;
						return;
					}
					this.settingsWriteAgain = false;
					this.settingsWriting = write();
					return this.settingsWriting;
				},
				(err: unknown) => {
					this.settingsWriting = null;
					this.settingsWriteAgain = false;
					throw err;
				}
			);
		this.settingsWriting = write();
		return this.settingsWriting;
	}

	private async flushSettings(): Promise<void> {
		if (this.settingsTimer !== null) {
			window.clearTimeout(this.settingsTimer);
			this.settingsTimer = null;
		}
		if (!this.settingsDirty) return;
		return this.persistSettings();
	}
}

/**
 * The native confirm in front of "Delete all ink". A command this destructive
 * is never one accidental palette hit away. Cancel holds focus, so Enter
 * dismisses rather than deletes.
 */
class ConfirmDeleteInkModal extends Modal {
	constructor(
		app: App,
		private count: number,
		private noun: "note" | "PDF",
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(`Delete all ink on this ${this.noun}?`);
		const what = this.count === 1 ? "1 stroke" : `${this.count} strokes`;
		// The promises differ because the recovery paths do. Note ink is one
		// pane's history away; pdf ink is wiped across every page and its
		// history is cleared with it, so the trash copy is the whole net and
		// the dialog must not promise more than that.
		this.contentEl.createEl("p", {
			text:
				this.noun === "note"
					? `${what} will be removed. Undo (Ctrl+Z) restores them while the ` +
						"note stays open, and a copy of the saved ink is kept in the " +
						"vault's .handwriting/trash folder."
					: `${what} will be removed from every page of this document. ` +
						"A copy of the saved ink is kept in the vault's " +
						".handwriting/trash folder.",
		});
		const row = this.contentEl.createDiv({ cls: "modal-button-container" });
		const del = row.createEl("button", { text: "Delete all ink", cls: "mod-warning" });
		del.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
		const cancel = row.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		cancel.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** The operating system as Platform reports it, for bug-report headers. */
function platformOs(): string {
	if (Platform.isWin) return "windows";
	if (Platform.isMacOS) return "macos";
	if (Platform.isLinux) return "linux";
	if (Platform.isIosApp) return "ios";
	if (Platform.isAndroidApp) return "android";
	return "unknown";
}

type SettingKey = keyof HandwritingSettings;

const SUPPORT_LINE = "Handwriting is free. i'm still working on it almost every night.";

/**
 * The device-level knobs, most of which already existed as commands. The
 * strip's sliders stay the source of truth for sizes and colors, so those
 * are not duplicated here.
 *
 * One list of definitions, two painters. Obsidian 1.13 renders the list
 * itself and indexes it for settings search (getSettingDefinitions); 1.12
 * has no such renderer and calls display(), which paints the same list by
 * hand. Neither path has a row the other lacks.
 */
class HandwritingSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: HandwritingPlugin
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		return [
			{
				type: "group",
				heading: "Pen",
				items: [
					{
						name: "Pressure sensitivity",
						desc:
							"Line width follows how hard you press. Off gives an even line; " +
							"strokes still thin with speed and taper at the ends. Default on.",
						control: { type: "toggle", key: "pressureSensitivity" },
					},
					{
						name: "Ink prediction",
						// The e-ink flicker advice came out with 1.3.9: that flicker was the
						// wet canvas asking for the low-latency path, not prediction, so
						// sending people here to fix it cost a boox user a pointless toggle
						// and told us nothing. Flicking past sharp corners is a real
						// prediction artefact and stays.
						desc:
							"Draws a little ahead of the pen to hide latency. " +
							"Turn it off if the line runs ahead of the nib or flicks past sharp corners. " +
							"Default on.",
						control: {
							type: "toggle",
							key: "strokePrediction",
							disabled: () => this.plugin.settings.booxMode,
						},
					},
					{
						// The smoothing users can actually feel. setInkShaping has been
						// honoured by the renderers all along but nothing ever called it: the
						// toggle that drove it was renamed into "pressure sensitivity" and the
						// shaping half lost its wiring, so the line has been permanently
						// shaped with no way to say otherwise. Two people asked for exactly
						// this on the same day (boox thread, 2026-08-30) and were told to turn
						// prediction off, which is a different feature and did nothing.
						name: "Ink smoothing",
						desc:
							"Shapes the line: thinner when you move fast, tapered at each end. " +
							"Off draws an unshaped stroke that follows the pen more literally. Default on.",
						control: {
							type: "toggle",
							key: "inkSmoothing",
							disabled: () => this.plugin.settings.booxMode,
						},
					},
					{
						name: "Shape snap",
						desc: "Hold the pen still at the end of a stroke to snap your drawing into a shape. Default on.",
						control: { type: "toggle", key: "shapeSnap" },
					},
					{
						name: "Mouse ink",
						desc: "Left click draws. Default off.",
						control: { type: "toggle", key: "mouseInk" },
					},
				],
			},
			{
				type: "group",
				heading: "Appearance",
				items: [
					{
						name: "Paper background",
						desc: "Lined or grid paper. Default none.",
						control: {
							type: "dropdown",
							key: "paperStyle",
							options: { none: "None", lines: "Lines", grid: "Grid" },
						},
					},
					{
						name: "Pen toolbar",
						// What this setting decides is whether the toolbar is
						// THERE, which "auto-hides when the pen is away" did not
						// say: auto shows it once a pen has been used this
						// session and then keeps it, rather than hiding and
						// showing as the pen comes and goes.
						//
						// The behaviour that wording described is real but is
						// not this setting: the strip steps aside on pen contact
						// and returns on pen-up, in EVERY mode, Show included
						// (setInking, InkOverlay.ts:1912/2001/2262). Two
						// behaviours, one of them configurable, and the
						// description was quietly claiming the wrong one.
						desc: "Shows the toolbar once you use a pen. Always on mobile. Default auto.",
						control: {
							type: "dropdown",
							key: "penTools",
							options: { auto: "Auto", show: "Show", hide: "Hide" },
						},
					},
					{
						name: "Toolbar corner",
						desc: "Where the floating pen toolbar sits. Default top right.",
						control: {
							type: "dropdown",
							key: "toolbarCorner",
							options: Object.fromEntries(TOOLBAR_CORNER_LABELS.map(({ value, label }) => [value, label])),
						},
					},
					{
						name: "Pen reticle",
						desc: "Shows a dot where the pen is. Default on.",
						control: {
							type: "toggle",
							key: "penReticle",
							disabled: () => this.plugin.settings.booxMode,
						},
					},
					// movableTextBoxes lands here on 1.5.0: it is about how the
					// note lays out rather than how the pen draws.
				],
			},
			{
				type: "group",
				heading: "E-ink",
				items: [
					{
						name: "Boox mode",
						desc:
							"For e-ink. Pen prediction sized for e-ink delays; smoothing, the pen reticle and animations " +
							"off - every redraw costs on e-ink. Your settings come back when it's off. Default off.",
						control: { type: "toggle", key: "booxMode" },
					},
				],
			},
			{
				type: "group",
				heading: "Storage",
				items: [
					{
						name: "Compatibility with Obsidian Sync, iCloud and Dropbox",
						aliases: ["ink folder", "hidden folder", "sync", "obsidian sync", "icloud", "dropbox"],
						render: (setting) => this.renderSyncButton(setting),
					},
				],
			},
			{
				type: "group",
				heading: "Commands",
				items: [
					{
						name: "Hotkeys for colors and sizes",
						// The name this row carried until 1.4.6. Settings search
						// indexes name, desc and aliases and nothing else, so a
						// rename with no alias makes the old wording match
						// nothing - and someone who updates, types what they
						// remember and finds an empty list concludes the toggle
						// was removed rather than renamed. The sync row below
						// carries six aliases for the same reason.
						aliases: ["A command per color and size", "command per color", "per color command"],
						desc:
							"Adds a separate command for every ink color and nib size, so each one can " +
							"take its own hotkey. Off by default - the palette button and the cycle " +
							"commands already reach both. Takes effect after the plugin reloads.",
						control: { type: "toggle", key: "colorSizeCommands" },
					},
				],
			},
			// Last, because these are for reporting a bug or reading a trace
			// rather than for writing: someone who wants them goes looking, and
			// someone who does not meets them only after every setting they
			// came for.
			{
				type: "group",
				heading: "Developer",
				items: [
					{
						name: "Developer diagnostics",
						desc:
							"Shows the developer diagnostics commands in the palette. " +
							"Takes effect after the plugin reloads.",
						control: { type: "toggle", key: "devDiagnostics" },
					},
					// INSIDE this group deliberately, and it is the last row of
					// the last one, so it is still the final thing on the page -
					// which is the whole point of it: someone who has been using
					// the thing ends up here, not someone deciding whether to
					// install it.
					//
					// Trailing the array instead put it in this section anyway on
					// 1.12, where `paint()` has no way to close a group - a
					// heading opens a run that only the next heading ends - while
					// 1.13's own renderer floated it outside. Same file, two
					// answers. Placing it here makes both renderers agree, and
					// makes the placement a decision rather than a side effect
					// (alan, 2026-09-02: "kofi support row can be in developer
					// that's fine").
					{
						name: SUPPORT_LINE,
						searchable: false,
						render: (setting) => this.renderSupport(setting),
					},
				],
			},
		];
	}

	/**
	 * Boox mode overrides three rows at runtime, without writing any of the
	 * stored settings: ink smoothing and the pen reticle are forced OFF
	 * (`applyBooxMode`'s `&& !on`), while prediction is forced ON
	 * (`applyBooxMode`'s `on || settings.strokePrediction` - Boox EXTENDS
	 * prediction rather than pausing it, see applyBooxMode). `applyBooxMode`
	 * restores the stored preference the moment the mode goes off, which is
	 * the promise its description makes ("Your settings come back when it's
	 * off"). The rows were still reporting the STORED value, not the forced
	 * one, so a Boox user saw toggles that disagreed with what was actually
	 * happening, with no way to tell.
	 *
	 * So each row shows the value actually in force (this map, not an
	 * assumed false), and the control beside it is disabled while something
	 * else is deciding. The preference itself is untouched: turn Boox mode
	 * off and every row reports the choice the user made, because that
	 * choice was never overwritten (alan, 2026-09-02, on being asked whether
	 * "toggle off" meant rewriting them: the reversible one).
	 */
	private readonly BOOX_OVERRIDES: Readonly<Partial<Record<SettingKey, boolean>>> = {
		inkSmoothing: false,
		penReticle: false,
		strokePrediction: true,
	};

	private overriddenByBoox(key: string): boolean {
		return this.plugin.settings.booxMode && key in this.BOOX_OVERRIDES;
	}

	getControlValue(key: string): unknown {
		if (this.overriddenByBoox(key)) return this.BOOX_OVERRIDES[key as SettingKey];
		// Mouse ink is the one row whose LIVE value can differ from the saved
		// one, and it started to the day a quiet arm stopped being written
		// down (alan, 2026-09-04). A mouse click on a tool button turns the
		// mode on for this session; the stored `false` beside it is then not
		// what is in force, and a switch showing "off" over a mouse that is
		// inking is worse than wrong - its first press would ask for the state
		// it already has and look broken. Same reasoning as BOOX_OVERRIDES
		// just above: the row reports what is in force. `apply` still writes
		// the user's explicit answer, which is what makes it survive a
		// restart.
		if (key === "mouseInk") return mouseInkEnabled();
		return key in this.plugin.settings ? this.plugin.settings[key as SettingKey] : undefined;
	}

	/**
	 * Draw the tab again after a change that alters OTHER rows.
	 *
	 * 1.13 keeps the definitions and re-evaluates them on `update()`. 1.12 has
	 * no such hook, so the fallback redraws the list - cheap at this size, and
	 * the same work `display()` already does every time the tab opens. Both
	 * paths read `disabled` and `getControlValue` fresh, so both end up correct.
	 */
	private rerender(): void {
		const self = this as unknown as { update?: () => void };
		if (typeof self.update === "function") self.update();
		else this.display();
	}

	/**
	 * Every toggle and dropdown lands here. The value is applied live - the
	 * same call the command for that knob makes - and then saved. Unknown
	 * keys are ignored rather than written: the settings file is the
	 * plugin's, not the form's.
	 */
	setControlValue(key: string, value: unknown): void {
		const s = this.plugin.settings;
		const on = value === true;
		const str = typeof value === "string" ? value : "";
		switch (key) {
			case "pressureSensitivity":
				s.pressureSensitivity = on;
				setPressureSensitivity(on);
				repaintAllInkOverlays();
				break;
			case "strokePrediction":
				s.strokePrediction = on;
				this.plugin.applyBooxMode();
				break;
			case "inkSmoothing":
				s.inkSmoothing = on;
				this.plugin.applyBooxMode();
				repaintAllInkOverlays();
				break;
			case "booxMode":
				s.booxMode = on;
				this.plugin.applyBooxMode();
				// Boox mode overrides Ink smoothing at runtime, and since §5i that
				// setting decides committed GEOMETRY, not just the width law. The
				// inkSmoothing case has always repainted; this one changes the same
				// value and did not, so toggling the mode left ink on screen in its
				// old shape until an unrelated repaint (§5l/AE6).
				repaintAllInkOverlays();
				// Two OTHER rows change what they report when this one moves.
				// `disabled` and getControlValue are both read at render time,
				// so nothing repaints them unless the tab is asked to render
				// again - and a Boox user flipping this would otherwise watch
				// two toggles keep insisting they were on.
				this.rerender();
				break;
			case "shapeSnap":
				s.shapeSnap = on;
				setShapeSnap(on);
				break;
			case "colorSizeCommands":
				s.colorSizeCommands = on;
				break;
			case "devDiagnostics":
				s.devDiagnostics = on;
				break;
			case "mouseInk":
				s.mouseInk = on;
				setMouseInk(on);
				// The settings switch is the second writer of this mode
				// (a9bf181) and owes it the same fan-out as the command -
				// see `applyMouseInkUiFanout` for both halves. Written as a
				// call here rather than pushed into `setMouseInk` because
				// `MouseInk.ts` cannot import `PenToolsMode.ts` - that
				// module already imports `mouseActsAsPen` from it, and the
				// cycle would be real.
				this.plugin.applyMouseInkUiFanout(on);
				break;
			case "paperStyle": {
				const style = normalizePaperStyle(str);
				s.paperStyle = style;
				this.plugin.applyPaper(style);
				break;
			}
			case "penTools": {
				const m = normalizePenToolsMode(str);
				s.penTools = m;
				setPenToolsMode(m);
				refreshPenToolsAll();
				break;
			}
			case "toolbarCorner": {
				const corner = normalizeToolbarCorner(str);
				s.toolbarCorner = corner;
				setToolbarCorner(corner);
				break;
			}
			case "penReticle":
				s.penReticle = on;
				this.plugin.applyBooxMode();
				break;
			default:
				return;
		}
		this.plugin.saveSettingsNow();
	}

	/**
	 * Obsidian 1.12 fallback. Newer versions never call this: they render
	 * the definitions themselves.
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.paint(containerEl, this.getSettingDefinitions());
	}

	/** Draw definitions with the classic Setting builder, one row each. */
	private paint(el: HTMLElement, items: readonly SettingDefinitionItem<SettingKey>[]): void {
		for (const item of items) {
			if ("type" in item) {
				if (item.type === "page") continue;
				if (item.heading !== undefined) new Setting(el).setName(item.heading).setHeading();
				this.paint(el, item.items ?? []);
				continue;
			}
			const setting = new Setting(el).setName(item.name);
			if (item.desc !== undefined) setting.setDesc(item.desc);
			if (item.render) {
				// The rows rendered here never read the second argument the
				// newer renderer passes, so calling them with the Setting alone
				// is safe. Not a version gap: SettingGroup has existed since
				// 1.11.0. What differs is only who does the painting.
				(item.render as (setting: Setting) => void)(setting);
			} else if (item.control?.type === "toggle") {
				const { key, disabled } = item.control;
				// `disabled` is honoured here too. The newer renderer applies it
				// itself; this painter would otherwise leave a live toggle on a
				// row whose value is being decided elsewhere - a control that
				// looks available, moves when pressed, and changes nothing,
				// which is worse than one that plainly cannot be pressed.
				const off = typeof disabled === "function" ? disabled() : disabled === true;
				setting.addToggle((t) => {
					t.setValue(this.getControlValue(key) === true).onChange((v) => {
						this.setControlValue(key, v);
					});
					if (off) t.setDisabled(true);
				});
			} else if (item.control?.type === "dropdown") {
				const { key, options } = item.control;
				setting.addDropdown((d) => {
					for (const [value, label] of Object.entries(options)) d.addOption(value, label);
					const current = this.getControlValue(key);
					d.setValue(typeof current === "string" ? current : "").onChange((v) => {
						this.setControlValue(key, v);
					});
				});
			}
		}
	}

	// One button, not a path field. "Where should the ink live" is not a
	// question anyone wants asked - the only reason to move it is that
	// Obsidian Sync skips hidden folders, so the control offers exactly
	// that and nothing else. No free text also means no path to validate,
	// no nested folder to create, and no way to typo your ink somewhere
	// strange.
	//
	// No description. The name is the description - Alan's rule, and
	// three attempts at wording proved it: a status line, a paragraph
	// of mechanics, and a one-line effect were all worse than the
	// name plus a button that says Turn on. The explanation lives in
	// the README, where someone goes when they want the reason.
	private renderSyncButton(setting: Setting): void {
		const label = (): string => (inkFolderSyncs(this.plugin.settings.inkFolder) ? "Turn off" : "Turn on");
		setting.setName("Compatibility with Obsidian Sync, iCloud and Dropbox").addButton((btn) =>
			btn
				.setButtonText(label())
				.setCta()
				.onClick(() => {
					btn.setDisabled(true);
					const target = inkFolderSyncs(this.plugin.settings.inkFolder) ? DEFAULT_INK_FOLDER : SYNCED_INK_FOLDER;
					runDetached(
						this.plugin.changeInkFolder(target).then(() => {
							// The button names the next move, which depends on
							// where the ink actually is now.
							btn.setButtonText(label()).setDisabled(false);
						}),
						"move the ink folder",
						() => {
							btn.setDisabled(false);
							new Notice("Handwriting: the ink folder could not be changed");
						}
					);
				})
		);
	}

	private renderSupport(setting: Setting): void {
		setting.settingEl.addClass("handwriting-support");
		setting.setName(
			createFragment((f) => {
				f.appendText(`${SUPPORT_LINE} `);
				f.createEl("a", {
					text: "Buy me a coffee :)",
					href: "https://ko-fi.com/ellimistafk",
				});
			})
		);
	}
}
