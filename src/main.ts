import { requestUrl, App, Command, MarkdownRenderChild, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, SettingDefinitionItem, type SettingGroup, type MarkdownView, TAbstractFile, TFile, View, WorkspaceLeaf, apiVersion, getIcon, normalizePath } from "obsidian";
import {
	clearGatedCommandAction,
	clearGatedCommandActions,
	gatedCommandActionIds,
	gatedCommands,
	inkColorNames,
	type PaletteCommand,
	planGatedCommands,
	runGatedCommand,
	setGatedCommandAction,
	setRetiredCommandAction,
} from "./CommandPaletteSplit";
import { formatHost } from "./diag/PlatformCapabilities";
import {
	HANDWRITING_DIAGNOSTICS_VIEW_TYPE,
	PenDiagnosticsView,
} from "./input/PenDiagnosticsView";
import { HANDWRITING_PEN_LAB_VIEW_TYPE, PenLabView } from "./view/PenLabView";
import {
	SlidesInkHost,
	activeSlidesActions,
	onSlidesCssChange,
	reloadSlidesExternal,
	scanForSlides,
	setSlidesInk,
	settleSlidesInk,
	SLIDES_SIDECAR_SUFFIX,
	slidesInkEnabled,
	slidesReloadCandidate,
} from "./slides/SlidesInkSurface";
import { mountSlidesTools, presentationCommands, requestSlidesAction } from "./slides/SlidesTools";
import {
	addStripSurface,
	bindInkEscapeWindow,
	closeInlineInkDocument,
	peelInlineEscapeSelection,
	applyToolbarPlacement,
	endLiveStrokesEverywhere,
	hidePenCursorsEverywhere,
	copyInlineInkMetrics,
	copyInlineZoomReport,
	copyPresentationReport,
	copyRegionCensus,
	copySelectionNotice,
	copySelectionNoticeIsRoutine,
	cutSelectionNotice,
	cutSelectionNoticeIsRoutine,
	deleteAllInkOn,
	getEraserRadiusPx,
	getEraserWholeStrokes,
	getInkSizeMult,
	getInlineEraserMode,
	getInlineLassoMode,
	getInlinePanMode,
	getInlineSpaceMode,
	getInlineTool,
	getToolbarCorner,
	inkExternallyReloaded,
	inkOverlayExtension,
	inlineInk,
	inlineReloadBindings,
	inlineReloadCandidates,
	captureInlineReloadAdmission,
	InkOverlayPlugin,
	overlayForActiveEditor,
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
	setPersistToolbarCorner,
	setShapeSnap,
	setToolbarCorner,
} from "./inline/InkOverlay";
import { destroyProbeMarkers } from "./inline/PenProbe";
import { lassoDeleteNotice } from "./inline/InlineSelectionDelete";
import { armForegroundRepaint } from "./inline/ForegroundRepaint";
import { captureInlinePenTrace, clearInlinePenTrace, formatInlinePenTrace } from "./inline/InlinePenRouter";
import { syncUndoTraceForDiagnostics } from "./diag/UndoHistoryTrace";
import {
	clearHitProbe,
	formatHitReport,
	isHitProbeEnabled,
	setHitProbeEnabled,
} from "./inline/PenHitProbe";
import { clearScrollProbe, formatScrollProbe } from "./inline/ScrollProbe";
import { surfaceExtents } from "./inline/SurfaceExtent";
import { UnreadableFrontmatterError, claimMarkdown, hasFrontmatterBlock, reassignMarkdown } from "./inline/InlineClaim";
import { INK_SIZE_STEPS, clampInkSize, nextInkSize } from "./ink/InkSize";
import { DEFAULT_ERASER_RADIUS_PX, clampEraserRadius, nextEraserSize } from "./ink/EraserSize";
import { DEFAULT_PEN, HIGHLIGHTER_PEN, setPressureSensitivity } from "./ink/PenStyle";
import {
	refreshInkTheme,
	setInkExportReadability,
	setInkThemeAdaptation,
} from "./ink/InkTheme";
import { setInkShaping } from "./ink/InkShape";
import { InkPreset, normalizeInkPresets, setInkPresets } from "./ink/InkPresets";
import { installInkPresetActions } from "./ink/InkPresetHost";
import { registerInkPresetCommands } from "./ink/InkPresetCommands";
import { consumeHintLagMs, discardHintSamples } from "./ink/LatencyEstimate";
import { noteLag, resetEinkHintProgress } from "./ink/EinkHint";
import { ownedNoticeHiders } from "./OwnedNotices";
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
	diagnosticsEpoch,
	endRecordingIfCurrent,
	setDiagnosticsChangedListener,
	setDiagnosticsEnabled,
} from "./diag/DiagSwitch";
import { isMarkdownPath, stripMarkdownExtension } from "./util/MarkdownPath";
import { deleteAllBackupFailureText } from "./util/DeleteAllBackupNotice";
import { routineNoticesVisible, setRoutineNoticesVisible } from "./diag/RoutineNotices";
import { traceGuardVerdict } from "./diag/TraceGuard";
import { InkTraceRecorder, resolveContentTracing, stopTraceAtUnload } from "./diag/InkTrace";

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
import {
	armMouseInkQuietly,
	consumeMousePutDown,
	mouseInkEnabled,
	setMouseInk,
} from "./inline/MouseInk";
import { setPrediction, setPredictionEink } from "./inline/StrokePrediction";
import { PaperStyle, nextPaperStyle, normalizePaperStyle, paperClass } from "./inline/Paper";
import { NotePaper, NotePaperPicker } from "./inline/NotePaper";
import { setScrollExpansionEnabled } from "./inline/InkOverlay";
import { inkToSvg } from "./ink/SvgExport";
import { InkTool } from "./ink/Stroke";
import { appendInkToPdf, flattenedPdfPath } from "./ink/InkPdfAppend";
import { inkToPdf, normalizePdfPageAssumption, PdfPageAssumption } from "./ink/InkPdf";
import { bytesOf } from "./pdf/PdfSyntax";
import { createFreshFile } from "./export/CreateFreshFile";
import { clipboardSize } from "./inline/InkClipboard";
import {
	attachEmbedInkOnceReady,
	embedInkIsLiveEditorBlock,
	disarmPrintSwaps,
	teardownEmbedInk,
	embedInkChanged,
	embedInkFileOpened,
	embedInkRenamed,
	embedInkRepaintAll,
	embedInkDiagLine,
	initEmbedInkDiagnostics,
	initEmbedInkRefresh,
} from "./inline/EmbedInk";
import { notifyInkChanged, onInkChanged } from "./inline/InkEvents";
import {
	PenToolsMode,
	clearPenHardwareSeen,
	markPenSeen,
	penHardwareSeen,
	penSeenThisSession,
	penToolsVisible,
	normalizePenToolsMode,
	persistPenHardwareSeenToStore,
	restorePenHardwareEverSeenFromStore,
	setPenHardwareStore,
	setPenToolsMode,
	setPersistPenHardwareSeen,
	shouldRaiseStripOnPenOff,
} from "./inline/PenToolsMode";
import {
	NoteZoomControlsMode,
	normalizeNoteZoomControlsMode,
	setNoteZoomControlsMode,
	setZoomBarCanvasEnabled,
} from "./inline/NoteZoomControlsMode";
// The per-note Infinite Canvas override: the plumbing is CanvasNoteOverride's,
// the instance and the two ways a user reaches it (the command below and the
// strip) are this file's.
import {
	CanvasNoteOverride,
	canvasForNote,
	onCanvasOverrideChanged,
	type NoteCanvasChoice,
} from "./inline/CanvasNoteOverride";
import { type BarsPair, normalizeBarsRestore } from "./inline/BarsToggle";
// The strip owns the fold list: the ids, their default order, and the rule
// that makes a saved order safe to use all live beside the row they describe -
// and `PEN_INK_TOGGLE`, the keyboard button's id, which outlived the palette
// command of the same name because saved fold orders are written in it.
import {
	DEFAULT_FOLD_ORDER,
	PEN_INK_TOGGLE,
	normalizeFoldOrder,
	refreshNoteZoomControlsAll,
	setStripFoldOrder,
} from "./inline/MobileTools";
import { PenCommandHost, penOnOff, togglePenInput } from "./inline/PenCommand";
import { FoldOrderControl, previewStripHost } from "./inline/FoldOrderControl";
import { DiagnosticTextModal, showDiagnosticText } from "./diag/DiagnosticTextModal";
import { pdfInkReport } from "./pdf/PdfInkReport";
import { PdfInkController } from "./pdf/PdfInkController";
import { clearPdfPanTrace, formatPdfPanTrace } from "./pdf/PdfPanTrace";
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
import { isSafePageId, newPageId, parsePage } from "./model/PageData";
import type { InkPresence, InlineDeleteCapture } from "./inline/InlineInkStore";
import { PageIdIndex, RegisterVerdict } from "./model/PageIdIndex";
import { PageStore, WRITE_ATTEMPTS, newPageWriter } from "./persistence/PageStore";
import { FORK_COPY_PLACEHOLDER, ForkHost, forkHostFor, refreshForks } from "./persistence/ForkResolution";
import { ForkResolutionModal } from "./persistence/ForkResolutionModal";
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
import { findSplitInk, splitInkReportText, type SplitInkReport } from "./persistence/SplitInk";
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
 *
 * Longer than Obsidian's own save-and-index delay: the editor saves on a 2 s
 * debounce and indexes a moment later, so a fix typed just after the block
 * went invalid is only readable ~2.35 s on. A 2 s grace declaimed first and
 * dropped the note's ink. A real removal waits 3 s longer, which
 * costs nothing.
 */
const DECLAIM_GRACE_MS = 5_000;

/**
 * The two refusals "Delete all ink" can give a PDF, written once because the
 * first of them is used from three places and three copies of a sentence are
 * three things that drift apart.
 *
 * TWO NARROW RULINGS, AND THEY ARE BOTH ABOUT PUNCTUATION AND CASING ONLY.
 *
 * 1. APPROVED BY ALAN, 2026-09-08: sentence case after the "Handwriting:"
 *    prefix - a sentence starts lowercase, "Handwriting" keeps its capital
 *    wherever it appears, and a command keeps its own name, which is why
 *    "Delete all ink" below is still capitalised.
 *
 * 2. APPROVED BY ALAN, 2026-09-09 18:41 CDT, shown both strings as they were
 *    and as they would be and asked yes or no with no wording touched either
 *    way. His answer, verbatim: "last period off, ones between sentences
 *    stay". So the TRAILING period came off both; both internal periods in
 *    the second string remain. Same rule as `DELETE_ALL_TEMPORARY`.
 *
 * 3. AND HE PUT THE TRAILING PERIOD BACK THE SAME DAY, 2026-09-09 17:14 CDT,
 *    which is the state below. Verbatim: "ehhhhhhhhhhhhhhhh we hsould be
 *    consistent, put a period back at end".
 *
 *    WHY, because the reason bounds it: a read found that OTHER messages on
 *    this same command always carried trailing periods and had never been
 *    shown to him - "open the note in editing view to delete its ink.",
 *    "removed N strokes. Undo restores them.", the disk-error line. Shown
 *    both readings, he chose consistency in the direction of RESTORING
 *    periods rather than stripping more. The unruled sentences therefore
 *    need nothing.
 *
 *    THE INTERNAL PERIODS ARE UNTOUCHED BY THIS - his 17:18 "yes that's fine
 *    good call" still binds - and no wording changed. One character each.
 *
 *    DO NOT STRIP THESE AGAIN ON THE STRENGTH OF THE 18:41 ENTRY. It is still
 *    on the record and still says the opposite; this paragraph is why. The
 *    authority is the decision recorded 2026-09-09 17:14 CDT, not this
 *    comment.
 *
 *    ONE SENTENCE IS RULED THE OTHER WAY and is not in this file: the
 *    ink-trash restore line stays BARE, because it ends in a file path where
 *    a period reads as part of the path. That asymmetry is deliberate.
 *
 * HE HAS NEVER SEEN THE WORDING OF EITHER SENTENCE, and neither ruling above
 * says anything about it. They are a casing convention and a trailing
 * character. DO NOT READ THIS BLOCK AS APPROVAL OF THE SENTENCES - two narrow
 * rulings stacked under one heading is exactly how an unapproved string comes
 * to look approved, and the shortest route to that is a third one added
 * without this paragraph.
 *
 * Still open with him and NOT to be pre-empted here: the delete-all refusal
 * reason `changed-during-backup` maps onto the second string below, on the
 * note surface it has an approved sentence, and whether that sentence should
 * be extended to this surface is his to rule.
 */
const PDF_INK_NOT_READY = "Handwriting: this PDF's ink storage is not ready. nothing was deleted.";
const PDF_INK_CHANGED_DURING_BACKUP =
	"Handwriting: the ink changed while its backup was being made. nothing was deleted. run Delete all ink again if you still want to remove it.";

interface HandwritingSettings {
	/** Named locations use their own schema; opaque records survive older builds. */
	savedViews: unknown[];
	/**
	 * Per-page camera, kept out of the synced note on purpose (§22). The retired
	 * canvas page's per-note cameras: read, copied and removed with their note,
	 * never interpreted.
	 */
	cameras: Record<string, Record<string, unknown>>;
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
	/**
	 * The same choice under a second key. A 1.4.20 build launching on a synced vault pins
	 * `pressureSensitivity` back to true and saves; it never touches this key, so this one keeps
	 * the real choice. Read first, and every save writes both. `pressureSensitivity` is never removed.
	 */
	pressureChoice: boolean;
	/** Shaped ribbon: velocity thinning and the start/end taper. */
	inkSmoothing: boolean;
	/**
	 * Draw near-black ink light on the DARK theme. Default on.
	 *
	 * One direction only: the light theme is left exactly as stored. Render
	 * time either way - the stroke keeps the colour it was written or
	 * imported with, and turning this off paints it again. It exists because
	 * OneNote exports its ink as #000000 and Obsidian's dark theme paints the
	 * page near-black, so an imported page reads as blank (alan, 2026-09-04).
	 */
	inkAdaptsToTheme: boolean;
	/**
	 * Guarantee exported ink is readable where it lands. Default ON.
	 *
	 * The opposite default to `inkAdaptsToTheme` above, and deliberately so
	 * (alan, 2026-09-08: "export toggle should default on"). On screen you are
	 * looking at your own canvas and the expected behaviour is the colour you
	 * picked; in an export you are producing something for elsewhere and the
	 * expected behaviour is that you can read it. Same principle, opposite
	 * answers - which is why the settings copy has to say so.
	 *
	 * Render time only, like the other one: nothing rewrites a stored colour.
	 */
	inkReadableInExports: boolean;
	/**
	 * Whether flattening ink into an existing PDF may assume that PDF's pages
	 * are white. Default true.
	 *
	 * Separate from the setting above because the two know different things.
	 * An export or a snip is a page Handwriting makes, so its colour is a fact;
	 * a flatten writes onto pages somebody else made, read as a dictionary and
	 * never as pixels, so white is a guess. It is the right guess for almost
	 * every document and the wrong one for grey or dark stock, where it makes
	 * light ink LESS readable than leaving it alone would. Render time only:
	 * nothing rewrites a stored colour.
	 */
	inkPdfColorMode: PdfPageAssumption;
	/** Vault folder holding the ink sidecars. Default `.handwriting`. */
	inkFolder: string;
	/** Which corner the floating pen toolbar parks in. Default top-right. */
	toolbarCorner: ToolbarCorner;
	/**
	 * The order the strip's buttons leave the first row in when the pane is
	 * too narrow for all of them (alan, 2026-09-05: "maybe we can have a way
	 * you can rearrange the symbols in the fold list").
	 *
	 * Command ids, and only ids that are allowed to fold - see
	 * `normalizeFoldOrder` in MobileTools.ts, which is what makes a file
	 * written by any build safe to read here. The default is
	 * `DEFAULT_FOLD_ORDER`, not restated in this file, so the ids have one
	 * home.
	 */
	stripFoldOrder: string[];
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
	/**
	 * Latch: has this vault already been told once that its ink is arriving
	 * late and Boox mode might help? Not a settings-UI row - it exists only
	 * so the hint (see EinkHint.ts) fires at most once per install rather
	 * than once per session.
	 */
	einkHintOffered: boolean;
	/**
	 * Latch: has this vault already seen the iPad Scribble warning? Internal
	 * persistence only, never a settings-UI row.
	 */
	scribbleHintOffered: boolean;
	/** Ruled paper background (v0.13.16): none, lines, grid or dots. Per device. */
	paperStyle: PaperStyle;
	extendCanvasWhileScrolling: boolean;
	/**
	 * Hide Obsidian's status bar while the ACTIVE note is a Handwriting page.
	 * OFF by default, so the status bar behaves exactly as Obsidian ships it.
	 *
	 * It exists because the bar is a fixed overlay in the bottom-right corner
	 * and on a Handwriting page it sits over the lower edge of the writing
	 * surface and the horizontal scrollbar, which no native setting moves.
	 * That is a real complaint, but it is not everyone's: the bar also carries
	 * word count, backlink and property counts and other plugins' items, and
	 * this shipped hiding it with no way to say no - the status bar vanished on
	 * every inked note, came back only by disabling the plugin, and survived a
	 * restart because the class is re-stamped at layout (Alan, 1.4.19). Hence
	 * opt-in: default behaviour is the expected one, the option is there for
	 * whoever wants the surface clear.
	 */
	hideStatusBarOnInkedNotes: boolean;
	/** Pen tools strip (v0.13.16): auto (pen summons it), show, or hide. */
	penTools: PenToolsMode;
	/** Note zoom bar: mirrors penTools exactly - auto steps aside while the
	 * pen inks, show is permanently on, hide is off. */
	noteZoomControls: NoteZoomControlsMode;
	/** What the "Toolbar on / off" command hid, put back by its next run; null when nothing is hidden by it. Only
	 * `penTools` is read back: the command stopped moving the zoom bar in 1.4.20, and the pair shape stays for data.json. */
	barsRestore: BarsPair | null;
	/** What the eraser erases, globally (1.0.9): whole strokes by default. */
	eraserMode: "stroke" | "reticle";
	/** The reticle that follows the pen tip (1.0.5). On by default. */
	penReticle: boolean;
	/** Hold-at-end snaps the figure to a clean shape (1.0.14). Default on. */
	shapeSnap: boolean;
	/** Shows the developer diagnostics commands in the palette. */
	devDiagnostics: boolean;
	/**
	 * Pen ink on the core Slides presentation (src/slides/SlidesInkSurface.ts).
	 *
	 * On by default: a reader who presents a note and draws on it expects the
	 * ink to be there next time, and the whole cost to a reader who never
	 * presents is one MutationObserver on `body` - which is not even installed
	 * while this is off.
	 */
	slidesInk: boolean;
	/** One command per colour and per nib size, for hotkeys. */
	colorSizeCommands: boolean;
	/**
	 * Quick pens (1.4.12 §4): the starred colour+size pairs, flat across both
	 * tools with each tool's own slot order preserved. Empty until somebody
	 * stars one - the feature costs a fresh install nothing but one small row
	 * inside a pop it already had.
	 */
	penPresets: InkPreset[];
	/**
	 * The version whose notes this vault has already been shown. Null until
	 * a release with notes has been seen. A brand new install is told apart
	 * by whether a settings file existed at all rather than trusting this.
	 */
	lastSeenVersion: string | null;
}

/**
 * Ink is stored as .json files, and Obsidian Sync leaves .json out unless "Sync all other types" is on, so
 * moving the ink folder out of hiding is not enough there on its own. Said in the settings row and the move notice.
 */
export const SYNC_ALL_TYPES_HINT =
	`Obsidian Sync users: also turn on "Sync all other types" in Obsidian Sync's settings, or it leaves the ink files out.`;

const DEFAULT_SETTINGS: HandwritingSettings = {
	cameras: {},
	savedViews: [],
	inkSizes: { pen: 1, highlighter: 1 },
	pressureSensitivity: true,
	pressureChoice: true,
	inkSmoothing: true,
	/*
	 * OFF BY DEFAULT, on the owner's ruling: "leave it off default, because
	 * expected behaviour should be default and then the option if they need
	 * it". Black ink drawn black is what a reader expects; drawing it light
	 * on a dark theme is the surprising thing, however useful it is for an
	 * imported page that would otherwise read as blank.
	 *
	 * This arrived ON by default with the slides port, which would have
	 * changed how every dark-theme user's existing ink looked the moment
	 * they updated, with nothing in the release notes to warn them. The
	 * LOAD COERCION below has to agree with this line or the default here
	 * is decorative - a vault with no stored value is decided there, not
	 * here, and that is every existing user.
	 */
	inkAdaptsToTheme: false,
	/**
	 * ON by default, on Alan's ruling ("export toggle should default on") -
	 * the opposite answer to the line above, for the reason recorded on the
	 * interface field.
	 *
	 * THE SAME TRAP APPLIES HERE AND IT POINTS THE OTHER WAY. Two places
	 * decide a default and only the LOAD COERCION decides for a vault that
	 * has never stored the key, which is every existing user. For default-ON
	 * the coercion must read `!== false` (absence counts as on); `=== true`
	 * would leave this line decorative and ship the fix switched off for
	 * everyone who already has a vault - exactly how `inkAdaptsToTheme` went
	 * wrong once, with the signs reversed.
	 */
	inkReadableInExports: true,
	/**
	 * ON, on Alan's ruling of 2026-09-08 ("ink readable on white pages" then
	 * "with a toggle in the setings"): the common page is white, so the
	 * guarantee holds by default and the toggle is there for the pages where
	 * assuming white costs more than it pays. Its load coercion is `!== false`
	 * for the reason spelled out beside `inkReadableInExports`.
	 */
	inkPdfColorMode: "darken",
	inkColors: { pen: PEN_COLORS[0]!.hex, highlighter: HIGHLIGHTER_COLORS[0]!.hex },
	pageOwners: {},
	eraserRadiusPx: DEFAULT_ERASER_RADIUS_PX,
	mouseInk: false,
	// On by default since 1.4.5. It was off for e-ink's sake (see
	// StrokePrediction.ts); e-ink has Boox mode now, so the default serves
	// everyone else.
	strokePrediction: true,
	booxMode: false,
	einkHintOffered: false,
	scribbleHintOffered: false,
	paperStyle: "none",
	extendCanvasWhileScrolling: false,
	/*
	 * OFF, on Alan's ruling: status bar visible by default, with the toggle
	 * for people who want the old hide-on-inked-note behaviour. Default-OFF,
	 * so its load coercion below must read `=== true` - absence counts as off.
	 * `!== false` there would leave this line decorative and ship the hiding
	 * switched ON for every existing vault, which is the defect being fixed.
	 */
	hideStatusBarOnInkedNotes: false,
	penTools: "auto",
	noteZoomControls: "auto",
	barsRestore: null,
	eraserMode: "stroke",
	penReticle: true,
	shapeSnap: true,
	devDiagnostics: false,
	slidesInk: true,
	colorSizeCommands: false,
	penPresets: [],
	lastSeenVersion: null,
	toolbarCorner: DEFAULT_TOOLBAR_CORNER,
	// A COPY, not the exported array itself: this object is handed out as the
	// starting point for a vault's settings and is written through, and a
	// shared reference would let one vault's reorder rewrite the default every
	// other read of it sees.
	stripFoldOrder: [...DEFAULT_FOLD_ORDER],
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
function hideOwnedNotices(): void {
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

/**
 * A Notice whose blank-line-separated blocks actually render as blocks.
 *
 * `Notice` sets TEXT, and a newline in text does not become a line break
 * without a `white-space` rule we do not own - so a message written in blocks
 * arrives as one run-on line. Alan wants the breaks and the reason is
 * legibility: "i want the line break it helps with visibility" (1.4.13), for
 * this notice and for the boox and ipad hints.
 *
 * One block is still a plain string Notice, so nothing pays for a fragment it
 * does not use. Splits on a blank line only - a single newline inside a block
 * stays inside it, because wrapping is the theme's business and not ours.
 */
/**
 * The blocks a notice message is written in, blank-line separated.
 *
 * Exported and pure so the property Alan actually asked for - that the message
 * ARRIVES as more than one line - is pinned by a test rather than by reading
 * Obsidian's stylesheet. Someone collapsing the string to one line, or a
 * refactor losing the escape, fails `NoticeBlocks.test.ts` instead of shipping
 * a run-on toast nobody notices until a user reports it.
 */
export function noticeBlocks(message: string): string[] {
	return message.split(/\n\s*\n/).filter((s) => s.length > 0);
}

function blockNotice(message: string, durationMs?: number): Notice {
	const blocks = noticeBlocks(message);
	if (blocks.length < 2) return new Notice(message, durationMs);
	return new Notice(
		createFragment((f) => {
			for (const block of blocks) f.createDiv({ text: block });
		}),
		durationMs
	);
}

/**
 * Read the artifact `preserve` actually returned and check it holds the
 * captured ink, at the ordinary persisted precision a trash copy is
 * written with. A copy of a damaged or newer-schema file is not a copy we
 * may claim, and neither is one whose ink differs from what is on screen.
 */
async function backupHoldsCapture(
capture: InlineDeleteCapture,
at: string,
read: (path: string) => Promise<string>
): Promise<boolean> {
	try {
	const text = await read(at);
		const raw: unknown = JSON.parse(text);
		// THE ARTIFACT MUST DECLARE THE CAPTURED PAGE ITSELF, checked on the
		// RAW bytes and before the parse. `parsePage`'s third argument is a
		// fallback id, and `PageData.ts:646` substitutes it whenever the file
		// omits `pageId` or carries an unsafe one - so the parsed page would
		// come back wearing the very id it is about to be compared against, and
		// bytes that never named this page could pass as its backup.
		if ((raw as { pageId?: unknown } | null)?.pageId !== capture.pageId) return false;
		const parsed = parsePage(text, capture.pageId);
		if (parsed.damaged || parsed.futureVersion !== undefined) return false;
		// The artifact's own JSON goes on to the comparison too, so it can tell
		// a field the FILE never carried from one the copy lost. Without it a
		// sidecar written without `createdAt` is refused on every press,
		// forever, and each refusal leaves another trash generation behind.
		return inlineInk.backupMatchesCapture(capture, parsed.data, raw);
	} catch (err) {
		console.error("[handwriting] could not read back the delete-all backup", at, err);
		return false;
	}
}

/**
 * The note a delete-all was invoked on: the object AND the path it was
 * invoked under, captured together before any await.
 *
 * BOTH HALVES, because either alone lies after a rename. The path alone stops
 * naming this note; the object alone survives a rename and would follow the
 * note to its new name, deleting ink the user never confirmed. `null` means
 * the command started on something that is not a file in the vault.
 */
type DeleteAllTarget = Readonly<{ file: TFile; path: string; overlay?: InkOverlayPlugin | null }> | null;

/**
 * Why an inline delete-all refused. One reason per refusal return in
 * `deleteAllInk`, so a refusal can be reported without being inferred.
 */
export type DeleteAllRefusal =
	| "locked-future"
	| "locked-duplicate"
	| "locked-legacy"
	/** The note's ink file could not be read yet: nothing is cleared, it may be healthy. */
	| "locked-transient"
	/** No identity, and no ink in the record either: a note never drawn on. */
	| "unknown-readiness"
	/** No identity, but the record DOES hold ink - drawn before the claim landed. */
	| "unknown-holds-ink"
	/**
	 * The note was renamed, deleted or replaced while the backup ran.
	 *
	 * SEPARATE FROM `readiness-lost` BECAUSE THE SENTENCE DIFFERS. Readiness
	 * can be lost for reasons that really do clear - a lock arriving, a load
	 * starting - and Alan ruled those temporary. This one is not temporary in
	 * any sense: the note is gone, or the path now holds a different note, and
	 * telling that user to try again in a moment is false.
	 */
	| "target-lost"
	| "unsettled-record"
	| "no-capture"
	| "backup-missing"
	| "backup-unverified"
	| "readiness-lost"
	| "changed-during-backup";

/**
 * APPROVED BY ALAN, 2026-09-08, shown the ten refusal reasons and asked for a
 * line each - "okay delete-all just sy something like, your ink cannot be
 * deleted". Put back to him as the exact sentence below and not amended.
 *
 * SOURCE: the decision stamped 2026-09-09 09:12 CDT,
 * which also carries the second string below. An earlier revision of this
 * marker said the words had only been relayed and were not on the record; they
 * are now, and this line points at them instead.
 *
 * ONE SENTENCE AT NEARLY EVERY CALL SITE, and the sameness is the ruling
 * rather than an economy. The part that makes it safe: it claims NOTHING about
 * a copy in either direction. Some of these fire before anything has been
 * written and must not imply one exists; three fire after a trash generation
 * was kept and must not imply one does not.
 *
 * DO NOT VARY IT per reason, per surface, or because it reads oddly somewhere.
 * If a call site makes it read wrong, that is Alan's to rule on: name the call
 * site and leave the string alone. That is exactly how the second string below
 * came to exist.
 *
 * THE TRAILING PERIOD IS HIS, AND SO WAS ITS ABSENCE. The whole arc, because
 * half of it invites the next reader to undo the other half:
 *
 *   The period was OURS - added when the constants were formed, never typed by
 *   him. Shown that, he ruled it off all three on 2026-09-09 17:09: "get the
 *   periods OUT", then "GET EM OUT".
 *
 *   He then RESTORED it the same day, 17:14/17:21: "ehhhhhhhhhhhhhhhh we
 *   hsould be consistent, put a period back at end". The reason bounds it -
 *   other sentences on this same command still carry trailing periods because
 *   he was never shown them ("open the note in editing view to delete its
 *   ink.", "removed N strokes. Undo restores them.", the disk-error notice).
 *   Offered per-string or per-command, he chose consistency, restoring rather
 *   than stripping.
 *
 * Both decisions are recorded at their source, and
 * the earlier one still says the opposite - so read the date before acting on
 * either. A test asserts the BARE form appears in no shipped file.
 *
 * NOT EVERY APPROVED STRING ENDS IN A PERIOD. The trash-restore line is ruled
 * bare - "leave that last one bare" - because it ends in a file path where a
 * period reads as part of the path. It is another owner's, and nothing here
 * may assert a rule that would force it to match these three.
 */
export const DELETE_ALL_REFUSED = "Handwriting: your ink cannot be deleted.";

/**
 * APPROVED BY ALAN, 2026-09-09 09:12 CDT, and SCOPED TO ONE REASON.
 *
 * An attack found the sentence above is FALSE in one place: at
 * `unknown-readiness` on a note that has never been inked and is open in
 * editing view, there is no ink, so nothing "cannot be deleted" - the old code
 * said "removed 0 strokes" there. His ruling, verbatim: "okay, on a note
 * you've never inked you can say 'no ink on this note'", then "yes, correct
 * you got it" on this exact form.
 *
 * `unknown-readiness` ONLY. Every other refusal keeps the sentence above, and
 * the four cases where it reads as permanent when the truth is "not right now"
 * - `unsettled-record`, `readiness-lost`, `changed-during-backup`,
 * `backup-unverified` - are NOT ruled and must not borrow this one. It would
 * be false at all four: those notes DO have ink.
 *
 * THE PERIOD CAME OFF AND WENT BACK ON, both on his word. The history matters
 * more than the final form here, which is why it is recorded rather than
 * quietly shown - and it has now reversed twice:
 *
 *   His words this morning had no period: "you can say 'no ink on this note'".
 *   WE added one when the string was formed, and his "yes, correct you got it"
 *   was given to the form he was shown, not to punctuation he chose. Shown it
 *   later beside the bare version already live on the ordinary path, he ruled
 *   "no period" (2026-09-09 16:58).
 *
 *   Then, told that other sentences on this same command still carry trailing
 *   periods because he was never shown them, he restored it for consistency
 *   (17:14/17:21): "ehhhhhhhhhhhhhhhh we hsould be consistent, put a period
 *   back at end".
 *
 * All decisions are recorded at their source, and the
 * middle one still says the opposite - read the date before acting on either.
 * A test asserts the BARE form appears in no shipped file.
 */
export const DELETE_ALL_NO_INK = "Handwriting: no ink on this note.";

/**
 * APPROVED BY ALAN, 2026-09-09 12:34 CDT, and SCOPED TO FOUR REASONS.
 *
 * SOURCE: the 12:34 decision, recorded before the work began. The sentence below IS his
 * answer - he was shown all eleven reasons rendered as the notices a user
 * actually sees, plus three candidate sentences, and typed this one back
 * himself rather than directing anyone to write it.
 *
 * THE LOWERCASE `try` IS HIS AND IS NOT A TYPO. It matches his other lowercase
 * rulings the same night. No capital T, no em dash, no "please", no rewording.
 *
 * WHAT IT FIXES: at these four the general sentence reads as PERMANENT when
 * the truth is "not right now" - the note is still settling, it stopped being
 * ready mid-delete, or its ink moved while the copy was being made. Trying
 * again works, and the old wording told the user it would not.
 *
 * AND HE WAS OFFERED THE COPY-KEPT VARIANT AND DID NOT TAKE IT. One candidate
 * named the trash generation that three of these four keep. He passed over it
 * and chose the temporary-only sentence, so NOTHING here mentions a copy - not
 * in any form, however true it is of those three. That is recorded because it
 * is the clause a later reader is most likely to "improve" back in.
 *
 * The rule that produced three strings instead of one, kept verbatim because
 * following it twice is what got the wording right: if a call site makes an
 * approved string read wrong, NAME THE CALL SITE AND LEAVE THE STRING ALONE.
 *
 * TWO PERIODS, AND THE INTERNAL ONE NEVER MOVED. He ruled the trailing periods
 * off all three sentences on 2026-09-09 17:09 - "get the periods OUT", then
 * "GET EM OUT" - and RESTORED them the same day at 17:14/17:21 for consistency
 * with the sentences on this command he had never been shown:
 * "ehhhhhhhhhhhhhhhh we hsould be consistent, put a period back at end".
 *
 * Through both reversals the INTERNAL period after "right now" stayed. It
 * separates two sentences: removing it gives "cannot be deleted right now try
 * again in a moment", which is not a punctuation change but a different and
 * worse sentence, and a re-write is his to type rather than ours to attempt.
 * That reading was recorded in the 17:09 entry for him to veto and he did not.
 *
 * The lowercase `try` is his and did not move either.
 */
export const DELETE_ALL_TEMPORARY =
	"Handwriting: your ink cannot be deleted right now. try again in a moment.";

/**
 * WHAT EACH REFUSAL SAYS TO THE USER.
 *
 * Every reason maps to the one approved sentence. The table stays a table
 * rather than collapsing into a single constant at the call site, because it
 * is what makes a NEW reason a build error instead of a silent refusal: the
 * `Record<DeleteAllRefusal, ...>` type will not compile without an entry, and
 * the test beside it asserts every entry carries the approved string. Whoever
 * adds the eleventh reason has to decide, in the open, what it says.
 *
 * WHY THE STRING MATTERED MORE THAN "the user is confused". Refusals at the
 * verification steps happen AFTER `preserve` has written a trash generation,
 * which is kept on purpose, and `freeTrashPath` has no cap - so a button that
 * silently did nothing cost one more file on every press. Nothing downstream
 * mistook that silence for success (`runDetached` is clean), so it was an
 * unbounded-file-growth problem rather than a correctness one.
 */
const DELETE_ALL_REFUSAL_TEXT: Record<DeleteAllRefusal, string | null> = {
	"locked-future": DELETE_ALL_REFUSED,
	"locked-duplicate": DELETE_ALL_REFUSED,
	"locked-legacy": DELETE_ALL_REFUSED,
	"locked-transient":
		"Handwriting: this note's ink file could not be read yet. New ink on it is not saved until it loads.",
	// THE ONE THAT DIFFERS, and it differs because the other sentence was FALSE
	// here rather than merely awkward: this note has no ink at all.
	"unknown-readiness": DELETE_ALL_NO_INK,
	// The same readiness, but this note HAS ink - so the never-inked sentence
	// would be false here and it keeps the general one.
	"unknown-holds-ink": DELETE_ALL_REFUSED,
	// THE FOUR HE RULED TEMPORARY, and only these four. At each of them trying
	// again works, which the general sentence denied. Three of them keep a
	// trash generation and say nothing about it: he was shown that variant and
	// passed over it.
	"unsettled-record": DELETE_ALL_TEMPORARY,
	"readiness-lost": DELETE_ALL_TEMPORARY,
	"changed-during-backup": DELETE_ALL_TEMPORARY,
	"backup-unverified": DELETE_ALL_TEMPORARY,
	// NOT temporary, deliberately: `no-capture` and `backup-missing` are not
	// states that clear by waiting, and he was not shown them for this ruling.
	"no-capture": DELETE_ALL_REFUSED,
	"backup-missing": DELETE_ALL_REFUSED,
	// Nor this one, and it is the reason this key exists apart from
	// `readiness-lost`: a renamed, deleted or replaced note does not come back
	// in a moment, so the temporary sentence would be false about it.
	"target-lost": DELETE_ALL_REFUSED,
};

/**
 * Report a refused delete-all. THE ONLY THING IT DOES IS SPEAK.
 *
 * It reads no state that could change one, and it clears, persists, snapshots
 * and resets nothing - the old warning that reached the user as a side effect
 * of the wipe attempting to persist is not a reporting path, it was a symptom,
 * and it stopped firing the moment the command started refusing before it
 * touched the store.
 */
function reportDeleteAllRefusal(reason: DeleteAllRefusal): void {
	const text = DELETE_ALL_REFUSAL_TEXT[reason];
	if (text !== null) new Notice(text);
}

/** Every reason, for coverage that the table and the union stay in step. */
export const DELETE_ALL_REFUSALS = Object.keys(DELETE_ALL_REFUSAL_TEXT) as DeleteAllRefusal[];

/** The approved text for a refusal, or null while none has been approved. */
export function deleteAllRefusalText(reason: DeleteAllRefusal): string | null {
	return DELETE_ALL_REFUSAL_TEXT[reason];
}

/** The clear, the history entry and the notice: the only side effects. */
function finishDeleteAllInk(path: string, kept: string | null, overlay?: InkOverlayPlugin | null): void {
	if (overlay === undefined) {
		const n = deleteAllInkOn(path);
		reportDeleteAllResult(n, kept);
		return;
	}
	reportDeleteAllResult(deleteAllInkOn(path, overlay), kept);
}

function reportDeleteAllResult(n: number | null, kept: string | null): void {
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
 * The store's two RECOVERY notices, which are two different events.
 *
 * `onRecovered` is the corrupt-file promotion: the main file could not be read,
 * its own complete interrupted save was promoted, and the corrupt bytes are
 * quarantined under a new name. Its sentence is accurate for that and unchanged.
 *
 * `onInkTrashRestored` is an ink-trash restore: no live sidecar existed, a
 * readable generation was found in the trash and renamed back into place.
 * `restoredTo` is that live file - the restore is a rename, so there is no kept
 * copy to name. Its sentence is Alan's, approved 2026-09-09; the authority is
 * the decision stamped 2026-09-09 18:26 CDT, not this
 * comment. Lowercase `the`, curly quotes around the note, internal period kept,
 * no final period.
 *
 * EXTRACTED FROM `onload` ONLY so a test can execute the REAL callbacks rather
 * than a copy of them: built inline they were unreachable, and a test that
 * re-implements a notice proves nothing about the one that ships. It is called
 * from `onload` and nowhere else; there is no test-only formatter.
 */
export function bindRecoveryNotices(
	store: PageStore,
	noteNameFor: (pageId: string) => string
): void {
	store.onRecovered = (pageId, keptAs) => {
		new Notice(
			`Handwriting recovered the ink on "${noteNameFor(pageId)}" from an interrupted save. The unreadable file is kept as ${keptAs}.`,
			15000
		);
	};
	// NO TRAILING PERIOD, AND THAT IS RULED - not drafted, not an oversight.
	//
	// Alan restored the trailing period on six other approved strings the same
	// day ("put a period back at end", 2026-09-09 17:14 CDT) and was then asked
	// about this one specifically. His answer: "leave that last one bare"
	// (17:21 CDT). THE REASON IS THE PATH: this sentence ends in a file path,
	// and a period there reads as part of the path.
	//
	// SO THE ASYMMETRY IS DELIBERATE. Six punctuated, this one bare. Anyone
	// checking consistency will find this string the odd one and be tempted to
	// "fix" it - that is what this comment is for. The authority is the 17:21
	// decision as recorded, not this comment,
	// and `RecoveredAnnouncesTrashRestore.test.ts` reds if a period appears.
	//
	// The INTERNAL period after "trash" stays, as it always has.
	store.onInkTrashRestored = (pageId, restoredTo) => {
		new Notice(
			`Handwriting restored the ink on “${noteNameFor(pageId)}” from trash. the file is at ${restoredTo}`,
			15000
		);
	};
	// The two background-flush sentences end in a path too, so no trailing
	// period, as above.
	store.onFlushPromoted = (pageId, keptAs) => {
		new Notice(
			`Handwriting restored ink on "${noteNameFor(pageId)}" from a save that was cut off. The page as it was before is kept as ${keptAs}`,
			15000
		);
	};
	store.onFlushKeptAside = (pageId, keptAs) => {
		new Notice(
			`Handwriting found ink on "${noteNameFor(pageId)}" from a save that was cut off. It does not match the saved page, so the page was left as it was. That ink is kept as ${keptAs}`,
			15000
		);
	};
}

/** A map-like setting value: an object that is not an array and not null. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default class HandwritingPlugin extends Plugin {
	store!: PageStore;
	settings: HandwritingSettings = { ...DEFAULT_SETTINGS };
	/** Set at load: no settings file at all means a first-ever install. */
	private freshInstall = false;
	private settingsDirty = false;
	/**
	 * data.json existed but could not be read or parsed at launch, even after
	 * retrying. The session runs on defaults and NOTHING writes the file until
	 * a clean read (another device's save arriving, or the next launch), so the
	 * defaults can never replace the settings the file still holds.
	 */
	private settingsReadFailed = false;
	/**
	 * The settings as they were on disk when last read or written, in this
	 * build's normalised form. A key whose in-memory value differs from this is
	 * one this device changed; every other key follows the file.
	 */
	private settingsBaseline: Record<string, unknown> = {};
	private settingsTimer: number | null = null;
	/** persistSettings' one-deep latch: another write wanted once this one lands. */
	private settingsWriteAgain = false;
	/** persistSettings' in-flight write, or null when nothing is writing. */
	private settingsWriting: Promise<void> | null = null;
	/**
	 * Every gated command's definition, by bare id, as `addGatedCommand` saw it.
	 *
	 * Kept because "Extra commands for hotkeys" is a live switch now: turning it
	 * back on has to hand the same definitions to `addCommand` again, and onload
	 * is the only place that knows them. See `applyGatedCommandRegistration`.
	 */
	private readonly gatedCommandDefs = new Map<string, Command>();

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
				(id) => this.pdfStore.save(id),
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
	private releasePdfId(id: string): void {
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
		if (!root.isConnected || this.pdfFiles.get(root) !== path) return;
		const choice = chooseInstance(
			family,
			path,
			candidates,
			(p) => this.app.vault.getFileByPath(p) !== null,
			this.pdfStore.pendingClaims()
		);
		this.pdfIds.set(root, choice.id);
		// Kept past the pane: a save that fails or a conflict copy can be reported after the pane
		// closed and its own id and path maps were dropped, and the notice must still name the file.
		(this.pdfPathById ??= new Map()).set(choice.id, path);
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
	private pdfInkSnapshot(id: string): string | null {
		try {
			return JSON.stringify(this.pdfStore.strokes(id));
		} catch (err) {
			console.error("[handwriting] delete-all-pdf-ink could not read current ink", err);
			return null;
		}
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
	 *
	 * "Made FIRST" was doing more work than it could carry. The copy is made
	 * first in TIME, but `preserve` is awaited, and the wipe used to read the
	 * document again on the other side of that await - so ink drawn during the
	 * copy was cleared from the live file and absent from the copy, while the
	 * notice named the copy as the recovery path. The two guards below close
	 * that: the store must be able to write at all, and the ink must be the
	 * same ink, both immediately before anything is cleared.
	 */
	private async deleteAllPdfInk(id: string): Promise<void> {
		// The trash copy is only a safety net if the store can actually write.
		// In session-memory mode, mid-read, or under either lock, `persist`
		// drops every scheduled write: this session's ink has never reached
		// the disk and never will, so `preserve` copies a file that does not
		// contain it - or finds no file at all and returns null - and the
		// clear below destroys the only remaining copy while the notice says
		// one was kept. A locked document has already been told its ink is not
		// being saved; being told a copy was kept immediately after is the
		// same lie twice. Refuse before making the claim, not after.
		if (!this.pdfStore.canPersist(id)) {
			new Notice(PDF_INK_NOT_READY);
			return;
		}
		// What is on screen RIGHT NOW, frozen before the await. Everything
		// below reads the stroke array again once `preserve` has resolved, and
		// a stroke finished inside that gap is in neither copy: the backup was
		// taken before it existed, and the clear removes it from the live
		// document. Only a full-content value sees that. A count, an id set or
		// a bounding box all miss a stroke that replaced another, and
		// `inkFingerprint` is lossy by construction.
		const before = this.pdfInkSnapshot(id);
		if (before === null) {
			new Notice(PDF_INK_NOT_READY);
			return;
		}
		let kept: string | null = null;
		try {
			kept = await this.store.preserve(id);
		} catch (err) {
			console.error("[handwriting] delete-all-pdf-ink backup failed", err);
			new Notice(deleteAllBackupFailureText(err, "PDF"));
			return;
		}
		// Both guards again, and NOTHING may await between here and the clear.
		// Readiness is rechecked because the wait is long enough to lose it: a
		// poll that finds the sidecar half-written by a sync client locks the
		// record while the backup is in flight, and a copy taken before that
		// lock is not a copy of what is on screen now.
		if (!this.pdfStore.canPersist(id)) {
			new Notice(PDF_INK_NOT_READY);
			return;
		}
		// The copy that did complete is left where it is - it is a real
		// generation of real ink and deleting it would be its own small loss -
		// but nothing here claims it holds the strokes drawn since.
		if (this.pdfInkSnapshot(id) !== before) {
			new Notice(PDF_INK_CHANGED_DURING_BACKUP);
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

	/**
	 * The backlink both snips paste under the embed. Obsidian writes it, not
	 * this file: a bare `file.name` gave a second file of that name in another
	 * folder the link. The source path is empty because the paste lands in a
	 * note this code cannot see; linking from the file to itself would collapse
	 * to a self-link. The link is written verbatim. A name holding # ^ [ ] | has
	 * no working link in Obsidian, in either link mode, and Obsidian's own
	 * rename refuses those names, so nothing here tries to rescue one.
	 */
	private snipBacklink(file: TFile, subpath?: string, alias?: string): string {
		return this.app.fileManager.generateMarkdownLink(file, "", subpath, alias);
	}

	/** The note twin of snipPdf: ink on white, counted name, embed copied. */
	private async snipNote(file: TFile, overlay: InkOverlayPlugin): Promise<void> {
		const snip = await overlay.snipSelection();
		if (!snip.ok) {
			new Notice(`Handwriting: ${snip.reason}`);
			return;
		}
		const base = stripMarkdownExtension(file.path);
		// The bytes are already rendered and belong to THIS invocation; the turn
		// below only decides when they are written, never what they are.
		//
		// `copied` starts false rather than true: a chooser that rejects never
		// reaches the clipboard at all, and the failure notice must not then
		// claim an embed is sitting there waiting.
		let copied = false;
		try {
			const { path: out } = await createFreshFile(
				() => this.firstFreePath((n) => `${base}.snip-${n}.png`),
				async (path) => {
					// Built for the destination this turn was actually given. A name
					// predicted before queueing is a name another caller may take.
					const name = path.split("/").pop() ?? path;
					const taken = this.app.metadataCache.getFirstLinkpathDest(name, file.path) !== null;
					const md = `![[${taken ? path : name}]]
${this.snipBacklink(file)}`;
					try {
						// The focused window's clipboard: in a popout the main one refuses (audit 60).
						await (typeof activeWindow === "undefined" ? navigator : activeWindow.navigator).clipboard.writeText(md);
						copied = true;
					} catch {
						copied = false;
					}
					return this.app.vault.createBinary(path, snip.bytes.buffer as ArrayBuffer);
				},
				// One attempt, as this caller always made. The helper's default of
				// eight is for callers with no side effect to repeat; retrying here
				// would ask the clipboard again on every round.
				1
			);
			const name = out.split("/").pop() ?? out;
			new Notice(
				copied
					? `Handwriting: snipped to ${name}; the embed is on your clipboard`
					: `Handwriting: snipped to ${name}; the clipboard refused the embed`
			);
		} catch (e) {
			console.error("[handwriting] snip the selection", e);
			new Notice(
				copied
					? "Handwriting: the snip could not be written; the embed on your clipboard has nowhere to point"
					: "Handwriting: the snip could not be written"
			);
		}
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
		// The page number and the bytes belong to THIS invocation and are read
		// before the turn, so a snip that waits still describes what it captured.
		let copied = false;
		try {
			const { path: out } = await createFreshFile(
				() => this.firstFreePath((n) => `${base}.snip-${n}.png`),
				async (path) => {
					const name = path.split("/").pop() ?? path;
					const taken = this.app.metadataCache.getFirstLinkpathDest(name, file.path) !== null;
					const md = `![[${taken ? path : name}]]
${this.snipBacklink(file, `#page=${snip.pageNumber}`, `${file.basename} p.${snip.pageNumber}`)}`;
					try {
						// The focused window's clipboard: in a popout the main one refuses (audit 60).
						await (typeof activeWindow === "undefined" ? navigator : activeWindow.navigator).clipboard.writeText(md);
						copied = true;
					} catch {
						copied = false;
					}
					return this.app.vault.createBinary(path, snip.bytes.buffer as ArrayBuffer);
				},
				1
			);
			const name = out.split("/").pop() ?? out;
			new Notice(
				copied
					? `Handwriting: snipped to ${name}; the embed is on your clipboard`
					: `Handwriting: snipped to ${name}; the clipboard refused the embed`
			);
		} catch (e) {
			console.error("[handwriting] snip the selection", e);
			new Notice(
				copied
					? "Handwriting: the snip could not be written; the embed on your clipboard has nowhere to point"
					: "Handwriting: the snip could not be written"
			);
		}
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
		const result = appendInkToPdf(
			bytes,
			this.pdfStore.strokes(id),
			this.settings.inkPdfColorMode
		);
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
	/** The note whose sidecar `applyStatusBarVisibility` is reading; see there. */
	private statusBarReadFor: string | null = null;
	notePaper: NotePaper | null = null;
	canvasOverride: CanvasNoteOverride | null = null;
	private headerActionRefresh: (() => void) | null = null;

	refreshHeaderActions(): void {
		this.headerActionRefresh?.();
	}

	registerHeaderActions(): void {
		const actions = new Map<MarkdownView, { path: string; canvas: HTMLElement; paper: HTMLElement }>();
		const canvasIcon = getIcon("scan") !== null ? "scan" : "layout-grid";
		const paperIcon = getIcon("grid-3x-3") !== null
			? "grid-3x-3"
			: getIcon("grid-3x3") !== null ? "grid-3x3" : "layout-grid";
		const missingIcons = [
			...(canvasIcon === "layout-grid" ? ["scan"] : []),
			...(paperIcon === "layout-grid" ? ["paper grid"] : []),
		];
		if (missingIcons.length) console.warn(`Handwriting: ${missingIcons.join(", ")} unavailable in Obsidian ${apiVersion}; using layout-grid`);
		const loading = new Set<string>();
		const pickers = new Set<NotePaperPicker>();
		const remove = (view: MarkdownView): void => {
			const current = actions.get(view);
			if (!current) return;
			current.canvas.remove();
			current.paper.remove();
			actions.delete(view);
		};
		const refresh = (): void => {
			if (this.unloaded) return;
			let geometryChanged = false;
			const live = new Set<MarkdownView>();
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				const view = leaf.view as MarkdownView;
				live.add(view);
				const file = view.file;
				const path = file?.extension === "md" ? file.path : null;
				const presence = path ? inlineInk.inkPresence(path) : "none";
				const show = !Platform.isPhone && path !== null && presence === "ink";
				const current = actions.get(view);
				if (current && (!show || current.path !== path)) { remove(view); geometryChanged = true; }
				if (!show) {
					if (path && presence === "unknown" && !loading.has(path)) {
						loading.add(path);
						void inlineInk.ensureLoaded(path).then(refresh, () => {}).finally(() => loading.delete(path));
					}
					continue;
				}
				if (!actions.has(view)) {
					const canvas = view.addAction(canvasIcon, "Infinite canvas", () => {
						const active = view.file?.path;
						if (active !== path) return;
						this.applyCanvasChoice(path, !canvasForNote(path, this.settings.extendCanvasWhileScrolling));
					});
					canvas.classList.add("handwriting-canvas-action");
					const paper = view.addAction(paperIcon, "Paper background", () => {
						const active = view.file;
						if (!active || active.path !== path || !this.notePaper) return;
						const picker = new NotePaperPicker(this.app, path, this.notePaper.choice(active), async choice => {
							try { await this.notePaper?.save(active, choice); }
							catch { blockNotice("Could not save the paper background for this note."); }
						}, () => pickers.delete(picker));
						pickers.add(picker);
						picker.open();
					});
					actions.set(view, { path, canvas, paper });
					geometryChanged = true;
				}
				actions.get(view)?.canvas.classList.toggle("is-active", canvasForNote(path, this.settings.extendCanvasWhileScrolling));
			}
			for (const view of actions.keys()) if (!live.has(view)) { remove(view); geometryChanged = true; }
			// The strip watches pane size, not child changes in .view-actions.
			// Re-apply its existing corner once after the row gains or loses icons.
			if (geometryChanged) setToolbarCorner(getToolbarCorner());
		};
		this.headerActionRefresh = refresh;
		this.registerEvent(this.app.workspace.on("layout-change", refresh));
		this.registerEvent(this.app.workspace.on("file-open", refresh));
		this.registerEvent(this.app.metadataCache.on("changed", (file) => {
			if (this.app.workspace.getLeavesOfType("markdown").some(leaf => (leaf.view as MarkdownView).file?.path === file.path)) refresh();
		}));
		this.register(onInkChanged(path => {
			if (Platform.isPhone) return;
			if (!this.app.workspace.getLeavesOfType("markdown").some(leaf => (leaf.view as MarkdownView).file?.path === path)) return;
			const showing = [...actions.values()].some(action => action.path === path);
			if (showing !== (inlineInk.inkPresence(path) === "ink")) refresh();
		}));
		this.register(onCanvasOverrideChanged(refresh));
		this.register(() => {
			for (const picker of pickers) picker.close();
			pickers.clear();
			for (const view of actions.keys()) remove(view);
			this.headerActionRefresh = null;
		});
		refresh();
	}

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
	/** The vault path each PDF ink id was resolved from this session; outlives the pane. Cleared on unload. */
	private pdfPathById?: Map<string, string>;
	/** Session ink for PDFs. Separate instance from the note store, by design. */
	private pdfStore = new PdfInkStore();
	/** M1 only: draw calibration crosses instead of real ink. Off by default. */
	private pdfCalibration = false;
	/** Page-id ownership ledger (duplicate detection, v0.13.6). */
	private pageIds = new PageIdIndex();
	/** Collisions with no safe owner: id → the paths locked over it. */
	private ambiguousIds = new Map<string, string[]>();
	private pageIdWatchReady = false;
	/** Deleted pages waiting out the delete+create window. See scheduleRecycle. */
	private pendingRecycle = new Map<string, number>();
	/** Notes whose id went missing, waiting to be confirmed. See declaimLater. */
	private declaimTimers = new Map<string, number>();
	/** Notes whose record declaimNow dropped; reloaded if their id comes back. */
	private declaimedPaths = new Set<string>();
	/** Notes already warned about an unusable page id; see warnUnusablePageId. */
	private badPageIds = new Set<string>();
	private resolvingDuplicates = new Set<string>();

	/**
	 * Write one note's Infinite Canvas choice, from the menu or the command.
	 *
	 * The word on screen waits for the write. A frontmatter write can fail -
	 * the note can be deleted or replaced between the click and the write,
	 * which is the case `save` re-checks for - and a notice fired before the
	 * await would announce a choice the note never took.
	 */
	applyCanvasChoice(path: string, choice: NoteCanvasChoice): void {
		runDetached((async () => {
			const written = await this.canvasOverride?.saveForPath(path, choice);
			if (written !== true) {
				new Notice("Handwriting: that note is gone - infinite canvas not changed");
				return;
			}
			// The override announces the change to every strip over this note;
			// this covers the global-resolving surfaces in the same move, so
			// nothing waits for a rebuild.
			refreshNoteZoomControlsAll();
			new Notice(
				choice === "default"
					? `Handwriting: Infinite canvas follows the setting (${this.settings.extendCanvasWhileScrolling ? "on" : "off"})`
					: `Handwriting: Infinite canvas ${choice ? "on" : "off"} for this note`
			);
		})(), "save the note's Infinite canvas override", () => {
			new Notice("Handwriting: could not write infinite canvas to that note");
		});
	}

	/** One last Escape listener per window, including popouts already open at plugin load. */
	private installEscapeWindows(): {open(win: Window): void; close(win: Window): void} {
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
	private readonly inkTrace = new InkTraceRecorder(
		() => resolveContentTracing(),
		() => {
			const base = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
			return base && this.manifest.dir ? `${base}/${this.manifest.dir}` : null;
		}
	);

	async onload(): Promise<void> {
		// Pressure calibration is per DEVICE, so it uses the app's per-vault
		// local store rather than data.json (which syncs, and would let one
		// device's range silence another's). Registered before init, which
		// reads through it.
		setPressureStore({
			load: (key) => this.app.loadLocalStorage(key) as string | null,
			save: (key, value) => this.app.saveLocalStorage(key, value),
		});
		// The pen-hardware latch is per DEVICE for the same reason and through
		// the same door: data.json syncs, so a Surface's pen would otherwise
		// teach a mouse-only desktop that it has one and put a Keyboard button
		// on a machine that can never use it. Registered HERE, above the
		// `await this.loadSettings()` below, because the restore inside
		// `loadSettings` reads through this seam.
		setPenHardwareStore({
			// `string | boolean | null`, and the cast is the honest one: the
			// declared return is `string | null`, but `loadLocalStorage` reads
			// back through a JSON decode in some versions and hands the stored
			// `"true"` over as the boolean. The restore accepts both spellings
			// (PenToolsMode.ts); narrowing it here would only hide that.
			load: (key) => this.app.loadLocalStorage(key) as string | boolean | null,
			save: (key, value) => this.app.saveLocalStorage(key, value),
		});
		initPressureGain(Platform.isIosApp ? IOS_WEBKIT_CEILING : 0);
		this.store = new PageStore(this.app);
		// Recovery pairs record which install wrote them, so another device
		// reading a synced pair knows which side is its own. Kept in this
		// device's local storage, never in data.json, which syncs.
		this.store.useDeviceId(this.installId());
		// Persistence must never fail silently: a write that keeps failing
		// after bounded retries, or an external revision preserved as a
		// conflict file, is surfaced once in words the reader can act on.
		//
		// RC4: both messages name the NOTE. A page id is Handwriting's bookkeeping
		// and is hidden from the Properties UI on purpose, so a truncated one
		// gave the reader nothing they could act on or even look up.
		this.store.onWriteError = (pageId, problem, preservedAs) => {
			// The count is the store's own, spelled out.
			const tries = ["one", "two", "three", "four", "five", "six"][WRITE_ATTEMPTS - 1] ?? String(WRITE_ATTEMPTS);
			new Notice(
				`Handwriting could not save the ink on "${this.noteNameFor(pageId)}" after ${tries} tries. The ink stays on screen; your next change starts another try. Check disk space and permissions.` +
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
		bindRecoveryNotices(this.store, (pageId) => this.noteNameFor(pageId));
		await this.loadSettings();

		this.registerView(HANDWRITING_PEN_LAB_VIEW_TYPE, (leaf) => new PenLabView(leaf));
		this.registerView(
			HANDWRITING_DIAGNOSTICS_VIEW_TYPE,
			(leaf) => new PenDiagnosticsView(leaf, this.manifest.version)
		);

		// Inline ink on the ordinary Markdown editor (architecture review +
		// OneNote-coordinates addendum). Pen-only capture; persistence follows
		// the identity rules: the awaited page-id write precedes any sidecar,
		// and an untouched note costs one metadata lookup and zero writes.
		inlineInk.attachHost({
			readPageId: (path) => this.notePageId(path),
			claimId: (path, proposedId) => this.claimNotePageId(path, proposedId),
			loadSidecar: (pageId) => this.store.load(pageId),
			scheduleSidecar: (pageId, page) => this.store.schedule(pageId, page),
			scheduleSidecarNow: (pageId, page) => this.store.saveNow(pageId, page),
			// Adopting another device's ink is destructive to this device's
			// unless both revisions are made recoverable first. The store does
			// the preserving and the acknowledging; the record decides whether
			// the adoption is still safe between them. See adoptExternal.
			prepareExternalAdoption: (pageId, outgoing) =>
				this.store.prepareExternalAdoption(pageId, outgoing),
			acceptExternalAdoption: (prepared) => this.store.acceptExternalAdoption(prepared),
			sidecarChanged: (pageId) => this.store.externallyChanged(pageId),
			notify: (message) => blockNotice(message),
		});

		// The per-note Infinite Canvas override, started BEFORE the editor
		// extension: registering it mounts an overlay in every note already
		// open, and each overlay subscribes to `onCanvasOverrideChanged` as it
		// mounts. Before `start` that subscription is a no-op, so an overlay
		// mounted at enable never heard a per-note change until its note was
		// reopened. `start` registers its own metadata listener and
		// its own teardown on the plugin, so there is nothing to unregister here.
		this.canvasOverride = new CanvasNoteOverride(this.app);
		this.canvasOverride.start(this);

		this.registerEditorExtension(inkOverlayExtension());

		// Ink in rendered markdown: embeds and reading view (roadmap). Each
		// section defers via a render child; on load it finds the rendered
		// root and the first one attaches the single ink layer. See
		// EmbedInk.ts for why "on load" no longer means "attached to the
		// document" - the virtualised preview renderer loads a section's
		// child before inserting the section, so the root is resolved from
		// the section, or the renderer's own container, or by waiting for
		// the section to land. Which of the three applies is a property of
		// the reader's Obsidian, not of ours, so all three are covered.
		//
		// One line per section that resolved (or failed to resolve) a root,
		// naming the route it came by. Off unless developer diagnostics is on,
		// and the LINE is only built when it is - the sink takes the pieces.
		// This exists for reports from machines we cannot get at: it separates
		// "your renderer never gave us a root" from "we attached and drew
		// nothing", which are different bugs with the same symptom.
		initEmbedInkDiagnostics((via, path, waitedMs) => {
			if (!this.settings.devDiagnostics) return;
			console.debug(embedInkDiagLine(via, path, waitedMs));
		});
		const readNoteText = async (notePath: string): Promise<string | null> => {
			const file = this.app.vault.getFileByPath(notePath);
			return file ? this.app.vault.cachedRead(file) : null;
		};
		// A hover preview post-processes every section of the note, each with
		// its own ctx but the same renderer container. Whether that render is
		// the whole note is one answer for all of them, so it is worked out
		// once per container: a per-section check read and compared the whole
		// file once for every section.
		//
		// The container outlives a render. A popover open while its note is
		// saved renders the old text, compares it with the saved file and is
		// refused; then the same renderer renders the saved text into the same
		// container, post-processing only the sections that changed. So an
		// answer is kept only for the text it was given, and a different text
		// is compared afresh, even while the old comparison is still pending.
		//
		// Asking a render what text it holds costs a walk of the renderer's
		// sections (getSectionInfo scans them in order), so it is asked once
		// per render, not once per section: the sections of one render are
		// post-processed in one synchronous pass, and the answer is marked
		// fresh until that pass has finished.
		const hoverWholeNote = new WeakMap<
			object,
			{ rendered: string; verdict: Promise<boolean>; fresh: boolean }
		>();
		this.registerMarkdownPostProcessor((el, ctx) => {
			const path = ctx.sourcePath;
			if (!path || !isMarkdownPath(path)) return;
			// containerEl is not on MarkdownPostProcessorContext's declared
			// type - it is read off the shipped bundle - so it is duck-typed
			// rather than trusted, and instanceof is avoided on purpose:
			// against a popout's own window it would reject an element that
			// is perfectly real, just not an instance of THIS window's
			// HTMLElement.
			const containerEl = (ctx as { containerEl?: unknown }).containerEl;
			const container =
				containerEl && typeof (containerEl as HTMLElement).closest === "function"
					? (containerEl as HTMLElement)
					: null;
			// Live Preview also postprocesses its own table/callout blocks.
			// They are editor content, not a rendered second view of this note.
			if (embedInkIsLiveEditorBlock(el, container)) return;
			const child = new MarkdownRenderChild(el);
			let cancelRetry: (() => void) | null = null;
			// The child can unload while the sidecar load below is still in
			// flight, and the `.then` would then start a wait nothing holds a
			// canceller for. Recorded rather than inferred from cancelRetry,
			// which is still null at exactly that moment.
			let childUnloaded = false;
			const attach = () => {
				if (childUnloaded) return;
				cancelRetry = attachEmbedInkOnceReady(el, container, path, () =>
					inlineInk.strokes(path),
					// A hover preview rendered the whole note only when the text
					// its renderer holds is the file's own text; a heading or
					// block preview renders a slice of it.
					() => {
						const known = container ? hoverWholeNote.get(container) : undefined;
						if (known && known.fresh) return known.verdict;
						const rendered = ctx.getSectionInfo(el)?.text;
						// No answer from this section (a heading's own title has
						// none): no ink for it, and nothing remembered, so a later
						// section of the same render can still answer.
						if (rendered === undefined) return known ? known.verdict : Promise.resolve(false);
						const markFresh = (entry: { fresh: boolean }) => {
							entry.fresh = true;
							queueMicrotask(() => {
								entry.fresh = false;
							});
						};
						if (known && known.rendered === rendered) {
							markFresh(known);
							return known.verdict;
						}
						const entry = {
							rendered,
							fresh: false,
							verdict: readNoteText(path).then((file) => {
								if (file === null) return false;
								if (file === rendered) return true;
								const norm = (t: string) => t.replace(/\r\n/g, "\n").trimEnd();
								return norm(rendered) === norm(file);
							}),
						};
						markFresh(entry);
						if (container) hoverWholeNote.set(container, entry);
						return entry.verdict;
					}
				);
			};
			child.onload = () => {
				// Synchronously when the ink is already in the session, which
				// it is whenever the note is open. An export renders the note
				// and then SERIALIZES it, so ink that arrives on a later tick
				// arrives after the picture was taken - and awaiting a promise
				// that had nothing to do would lose the page its ink for the
				// sake of a microtask.
				if (inlineInk.isLoaded(path)) {
					// Registered even with zero strokes: a note drawn on
					// AFTER its embed rendered still gains ink live.
					attach();
					return;
				}
				runDetached(
					inlineInk.ensureLoaded(path).then(attach),
					"render ink into an embed"
				);
			};
			child.onunload = () => {
				childUnloaded = true;
				cancelRetry?.();
			};
			ctx.addChild(child);
		});
		// Embed layers stop going stale: every persisted gesture repaints the
		// rendered roots showing that note. See EmbedInk.ts.
		initEmbedInkRefresh((p) => inlineInk.strokes(p));
		this.register(onInkChanged((p) => embedInkChanged(p)));
		this.notePaper = new NotePaper(this.app, message => { blockNotice(message); });
		this.notePaper.start(this);
		this.registerHeaderActions();
		// The note's own Infinite Canvas, in the three-dot menu beside "Paper
		// background" (Alan, 09:3xZ: the paper picker is in the three-dot
		// menu, top right of the editor) - the same menu, the same
		// markdown-only guard, registered here rather than in NotePaper.ts
		// because that file belongs to the paper override.
		//
		// ONE LINE, A TICK, AND NO THIRD STATE (Alan, 09:4xZ: "i dont like
		// there being three lines... that's too many"). The override has three
		// values, but the menu is the TOGGLE the brief asked for and the third
		// value - "use the setting" - is the command's, not the menu's.
		//
		// The tick is the note's REAL mode, override or setting, not "this
		// note has an override": what a reader of this menu wants to know is
		// whether the note they are looking at is a canvas, and a tick that
		// answered a different question would be off on every untouched note.
		// So a click always writes an explicit value - the opposite of what
		// the tick shows - and a note goes back to following the setting
		// through the command.
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFile) || file.extension !== "md") return;
			(this as HandwritingPlugin & { slidesMenuFile?: { path: string; at: number } }).slidesMenuFile = {
				path: file.path, at: Date.now(),
			};
			const on = canvasForNote(file.path, this.settings.extendCanvasWhileScrolling);
			menu.addItem(item => item
				.setTitle("Infinite canvas")
				.setIcon("expand")
				.setChecked(on)
				.onClick(() => this.applyCanvasChoice(file.path, !on)));
		}));
		this.addSettingTab(new HandwritingSettingTab(this.app, this));
		const escapeWindows = this.installEscapeWindows();
		// A popout is born without the paper class; stamp it as it opens.
		this.registerEvent(
			this.app.workspace.on("window-open", (_ww, win) => {
				escapeWindows.open(win);
				this.applyPaperTo(win.document, this.settings.paperStyle);
				window.setTimeout(() => this.app.workspace.trigger("handwriting-slides-documents-change"), 0);
			})
		);
		this.registerEvent(this.app.workspace.on("window-close", (_ww, win) => {
			escapeWindows.close(win);
			window.setTimeout(() => this.app.workspace.trigger("handwriting-slides-documents-change"), 0);
		}));
		// Discovery for Boox mode: a slow present lag is the signal, checked
		// on a plain interval rather than off the ink path so a machine that
		// never writes still gets a periodic look. See checkEinkHint.
		//
		// Registered HERE, above the live-reload poll, on purpose: that poll's
		// registration block is sliced out of this file's source and EXECUTED by
		// src/testUtils/LiveReloadTestHarness.ts, which pins it to exactly one
		// `this.registerInterval(` and one `window.setInterval(`. An interval
		// added between `let reloadTickBusy` and the pen command lands inside
		// that window and fails those suites closed. Keep this outside it.
		this.registerInterval(window.setInterval(() => this.checkEinkHint(), 10_000));
		// Live reload: ink synced in from another device appears without a
		// restart. One stat per open, quiet editor per check; the store
		// adopts a changed sidecar only when nothing local is unsaved and no
		// gesture is active, and the write-path conflict guard keeps its
		// last word. Dot-folders are invisible to vault events (sidecars
		// are not vault-indexed files), which is why this polls.
		let reloadTickBusy = false;
		// A sidecar belongs to a document, but each live pane owns its repaint.
		// Keep exact bindings so a deferred repaint cannot reach a replacement.
		const pendingPdfRefreshes = new Map<HTMLElement, { id: string; controller: PdfInkController }>();
		const currentPdfPanes = (id: string) => [...this.pdfInk].filter(
			([root]) => root.isConnected && this.pdfIds.get(root) === id
		);
		const refreshPendingPdfPanes = (failed: Map<PdfInkController, "eligibility" | "refresh">) => {
			for (const [root, binding] of pendingPdfRefreshes) {
				const { id, controller } = binding;
				let phase: "eligibility" | "refresh" = "eligibility";
				try {
					if (!root.isConnected || this.pdfInk.get(root) !== controller || this.pdfIds.get(root) !== id) {
						pendingPdfRefreshes.delete(root);
						continue;
					}
					if (failed.has(controller) || !controller.idle) continue;
					phase = "refresh";
					controller.refresh();
					pendingPdfRefreshes.delete(root);
				} catch (err) {
					// Retry on the next visible tick, even without another mtime.
					// A fresh adoption later this tick must not retry the failure.
					failed.set(controller, phase);
					console.error(`[handwriting] live-reload poll failed for PDF ${id}`, err);
				}
			}
		};
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
				// first visible tick catches up on everything missed. Every
				// window holding a pane, not the main one alone (audit 56).
				if (this.reloadPanesHidden(document)) {
					wasHidden = true;
					this.pollStats.hidden++;
					return;
				}
				if (wasHidden) {
					wasHidden = false;
					quietTicks = 0;
				}
				// Display debt is independent of the stat cadence and never resets it.
				const failedPdfRefreshes = new Map<PdfInkController, "eligibility" | "refresh">();
				refreshPendingPdfPanes(failedPdfRefreshes);
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
						const pdfIds = new Set([...this.pdfInk.keys()].map(root => this.pdfIds.get(root)));
						for (const id of pdfIds) {
							if (!id) continue;
							try {
								let panes = currentPdfPanes(id);
								if (!panes.length || panes.some(([, controller]) =>
									failedPdfRefreshes.get(controller) === "eligibility" || !controller.idle
								)) continue;
								if (!(await this.store.externallyChanged(id))) continue;
								// Stat awaited: panes may have joined, switched or started
								// a gesture. Check every current binding before reloading
								// the record they all share.
								panes = currentPdfPanes(id);
								if (!panes.length || panes.some(([, controller]) =>
									failedPdfRefreshes.get(controller) === "eligibility" || !controller.idle
								)) continue;
								// A stroke completed during stat may have queued a stale
								// snapshot. Preserve the write-path conflict guard until
								// that write lands, then reload on a later poll.
								if (this.store.hasQueuedWrite(id)) continue;
								// Only a completed preserving adoption may replace an
								// established PDF record. Missing capability, unavailable
								// input, locks, preservation failures and stale qualification
								// all retain the record and baseline for a later poll/save.
								const expectedPanes = panes;
								const adoption = await this.pdfStore.adoptExternal?.(id, () => {
									const current = currentPdfPanes(id);
									if (current.length !== expectedPanes.length) return false;
									if (current.some(([, controller]) => !controller.idle)) return false;
									if (this.store.hasQueuedWrite(id)) return false;
									return expectedPanes.every(([root, controller], i) => {
										const binding = current[i];
										return binding?.[0] === root && binding[1] === controller;
									});
								});
								if (adoption?.outcome !== "adopted") continue;
								if (adoption.changed) {
									changed = true;
									// Loading still awaits file I/O; this bookkeeping does
									// not make shared-cache adoption atomic with gestures.
									// Include current panes and defer any that became busy.
									for (const [root, controller] of currentPdfPanes(id)) {
										pendingPdfRefreshes.set(root, { id, controller });
									}
									refreshPendingPdfPanes(failedPdfRefreshes);
								}
							} catch (err) {
								console.error(`[handwriting] live-reload poll failed for PDF ${id}`, err);
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
								if (!id) {
									// Loaded before the note had an id; sync has since
									// delivered one, and maybe its first ink.
									if (inlineInk.gainedPageId?.(path) && (await inlineInk.ensureLoaded(path))) {
										inkExternallyReloaded(path);
										notifyInkChanged(path);
										changed = true;
									}
									continue;
								}
								// Inline needs one fact the shared boolean intentionally
								// collapses: positively observed absence starts the existing
								// held-adoption notice. PDF and Slides keep boolean false for
								// absence, and stat/read errors remain ordinary unchanged.
								const sidecarChanged = await this.store.externallyChanged(id);
								const observation = sidecarChanged
									? "changed"
									: (this.store.externalChangeObservation?.(id) ?? "unchanged");
								if (observation === "unchanged") continue;
								// Stat and preservation both await. Capture the current
								// cohort now and recheck it at the final adoption boundary.
								const panesCurrent = captureInlineReloadAdmission(path);
								if (!panesCurrent) continue;
								// Same gap, the other half: a stroke that
								// FINISHED in it left a queued write carrying a
								// pre-reload snapshot, and reloading refreshes
								// the known mtime so the write-path conflict
								// guard no longer sees a reason to preserve
								// anything. Let the write land; the next poll
								// reloads against a mtime that matches it.
								if (this.store.hasQueuedWrite(id)) continue;
								// PRESERVE BOTH REVISIONS BEFORE ADOPTING ONE.
								// A sync replacement is not necessarily a
								// superset of what this device holds, and the
								// an unpreserved reload moves the save baseline to
								// the incoming file - after which nothing holds
								// the outgoing ink at all. The adopting route
								// writes both as independently recoverable
								// siblings first and only then swaps.
								//
								// Only a completed preserving adoption may replace
								// an established record. Missing capability,
								// unavailable preparation, locks and races all hold
								// the current base for a later poll/save. The method
								// stays optional for reduced test stand-ins; absence
								// is also a hold, never reload authority.
								const adoption = await inlineInk.adoptExternal?.(path, () => panesCurrent() &&
									inlineInk.pageIdOf(path) === id && !this.store.hasQueuedWrite(id));
								if (adoption?.outcome !== "adopted") continue;
								if (adoption.changed) {
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
						// A live presentation, on the same tick and for the same
						// reason: its `<pageId>.slides` sidecar sits in the same
						// unindexed folder and another device writes it while the
						// deck is open. Without this leg a deck kept its stale
						// copy for the whole presentation and then overwrote the
						// newer file at teardown. Its own try/catch, for the
						// starvation reason the inline loop states.
						try {
							const slidesId = slidesReloadCandidate();
							if (slidesId && (await this.store.externallyChanged(slidesId))) {
								// Re-asked in the same microtask as the adopt: the
								// answer above is a tick old and a pen can have
								// landed on the deck since.
								if (
									slidesReloadCandidate() === slidesId &&
									!this.store.hasQueuedWrite(slidesId) &&
									(await reloadSlidesExternal(slidesId))
								) {
									changed = true;
								}
							}
						} catch (err) {
							console.error("[handwriting] live-reload poll failed for the presentation", err);
						}
						quietTicks = changed ? 0 : quietTicks + 1;
					})().finally(() => {
						reloadTickBusy = false;
					}),
					"live-reload poll"
				);
			}, 1000)
		);
		// THE ONE PEN COMMAND (1.4.12). Alan, 2026-09-05: "there are two of
		// these Handwriting: Pen and Handwriting: toggle pen input on/off - i
		// think that's stupid there should only be one" -> "Pen on / off like
		// Mouse on / off". This kept the `inline-tool-pen` id, so a hotkey
		// bound to the old `Pen` still resolves; `pen-ink-toggle` left the
		// palette entirely, and only the palette - see `penInkCommandHost`
		// above and the `setRetiredCommandAction` call below for the strip's
		// keyboard button, which still flips the same switch by that same id.
		//
		// The rule is PenCommand.ts's, not this file's, so it can be tested
		// without an Obsidian; what stays here is the chrome the rule cannot
		// reach and the Notice, which is the pen toggle's own owned slot -
		// this command IS that toggle now, so it does not get a seventh.
		this.addCommand({
			id: "inline-tool-pen",
			name: "Pen on / off",
			callback: () => {
				// The toggle itself is NOT gated - `penOnOff` is what flips the
				// pen and it returns the new state. Only the toast is routine.
				const on = penOnOff(penInkCommandHost);
				if (routineNoticesVisible()) showPenToggleNotice(penToggleNoticeText(on));
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
			name: "Mouse on / off",
			// DECISION, "button should become the truth" addendum (2026-09-05):
			// on a pen-less device with a tool lit, this command's OFF press is
			// a NO-OP for whether the mouse actually draws. `mouseActsAsPen`
			// (MouseInk.ts) ORs this command's `enabled` flag with the derived
			// pen-less grant (`mouseDrawsFromLitTool`) precisely so a device
			// that has never seen a pen keeps drawing with whatever tool is lit
			// regardless of this flag - so toggling `enabled` off here leaves
			// the mouse still drawing via that grant, and the "Handwriting:
			// cursor" toast below is not fully true in that one case.
			// DELIBERATELY NOT CHANGED to compensate (e.g. by also turning pen
			// input off): every brief in this session repeats "leave
			// `mouse-ink-toggle` as the explicit override... exactly as it is",
			// and reaching into `setPenInk` from here to make the toast true
			// again would be exactly the opposite of that instruction. Left as
			// a stated, deliberate no-op rather than a silently-discovered one;
			// see the handoff for the same note.
			callback: () => {
				const on = !mouseInkEnabled();
				setMouseInk(on);
				// THE LOUD PATH, and the only one that writes this down (the
				// settings switch was the other, until 1.4.20 took the row
				// out). Asking for the mode BY NAME is
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
				// and the hotkey alike - see `applyMouseInkUiFanout` for both
				// halves and why each needs what it calls.
				this.applyMouseInkUiFanout(on);
				// NAMES THE STATE - not a device, not a tool (alan,
				// 2026-09-05: "maybe Handwriting: ink" "instead of
				// handwriting: pen when you select handwriting: mouse in
				// command palette").
				//
				// This used to name the TOOL the mouse had picked up, under
				// the 2026-08-31 ruling that a pen holding the highlighter
				// says "highlighter". That ruling still governs the pen and
				// highlighter tool commands; it is superseded HERE, and only
				// here, because what this toggle turns on was never about the
				// mouse: "what if we are Handwriting: mouse drawing on and
				// then the dude touches with a pen?". After the switch,
				// whatever touches the glass inks - so a device or a nib in
				// the message is wrong the moment a pen arrives, while "ink"
				// is the state itself and stays true for everything in the
				// room. Echoing the command's own name ("mouse drawing on")
				// was considered and rejected for the same reason.
				//
				// The OFF word is unchanged, and `tipModeOffNotice` matches
				// it deliberately - read its doc comment before editing it.
				showMouseInkToggleNotice(on ? "Handwriting: ink" : "Handwriting: cursor");
			},
		});
		// THE ONLY WAY A PERSON CAN REACH A PRESERVED FORK. Adoption keeps both
		// revisions and says nothing on success (`d50534a`, settled), and both
		// artifacts live in the ink folder - `.handwriting` by default, which
		// Obsidian will not browse. Nothing else in the plugin enumerates them:
		// every folder sweep skips `.conflict-` names on purpose. Registered
		// outside the live-reload block above because `LiveReloadTestHarness`
		// slices that block out of this file and executes it with a fixed list
		// of injected names.
		this.addCommand({
			id: "resolve-ink-fork",
			name: FORK_COPY_PLACEHOLDER.commandName,
			callback: () => {
				const host: ForkHost = forkHostFor({
					adapter: this.app.vault.adapter,
					store: this.store,
					deviceId: this.installId(),
					// A scanned pair carries only a page id; these two name it. The
					// note lookup is the startup census, so it answers after a
					// restart; a closed PDF is named by its sidecar's own path.
					pathForNote: (pageId) => this.notePathFor(pageId),
					// A sidecar keeps every path it was claimed at; the first that still
					// exists is the PDF now, else the newest claim.
					pathForPdf: async (pageId) => {
						const claimed = (await this.store.readPdfPaths(pageId)) ?? [];
						return claimed.find((p) => this.app.vault.getFileByPath(p) !== null) ?? claimed[claimed.length - 1] ?? null;
					},
					// A restored page goes through the open note or PDF that
					// holds it, so the screen shows it and the next save keeps it.
					restoreOpen: async (pageId, data) => {
						const path = await inlineInk.restoreRevision(pageId, data);
						if (path) {
							inkExternallyReloaded(path);
							return true;
						}
						if (this.pdfStore.restoreRevision(pageId, data)) {
							for (const [root, controller] of this.pdfInk) {
								if (this.pdfIds.get(root) === pageId) controller.refresh();
							}
						}
						return false;
					},
				});
				// Every folder a page can be served from: a fork found at load
				// is preserved beside the served copy, which need not be in the
				// configured folder.
				runDetached(
					(async () => {
						for (const folder of this.store.inkFolders()) await refreshForks(host, folder);
						new ForkResolutionModal(this.app, host).open();
					})(),
					"open the fork resolution list"
				);
			},
		});
		for (const command of presentationCommands(
			() => activeSlidesActions(typeof activeDocument === "undefined" ? document : activeDocument),
			(target, action) => requestSlidesAction(this.app, target, action)
		)) this.addCommand(command);
		this.addCommand({
			id: "slides-ink-toggle",
			name: "Toggle slides ink",
			callback: () => {
				const on = !slidesInkEnabled();
				this.settings.slidesInk = on;
				runDetached(this.persistSettings(), "save the slides ink setting");
				if (on) this.startSlidesInk();
				else {
					setSlidesInk(false);
					// The next switch-on makes a new writer; this one must not
					// keep claiming the sidecar (audit 125).
					if (this.slidesWriter) this.store.retireWriter(this.slidesWriter);
					this.slidesWriter = null;
				}
				new Notice(
					on
						? "Handwriting: slides ink on (start a presentation, then draw)"
						: "Handwriting: slides ink off"
				);
			},
		});
				this.addCommand({
			id: "paper-cycle",
			name: "Paper: none / lines / grid / dots",
			callback: () => {
				const next = nextPaperStyle(this.settings.paperStyle);
				this.settings.paperStyle = next;
				this.applyPaper(next);
				runDetached(this.persistSettings(), "save the paper style");
				if (routineNoticesVisible()) new Notice(`Handwriting: paper ${next}`);
			},
		});
		// INFINITE CANVAS FOR ONE NOTE. The setting is the default; a
		// note may say otherwise in its own frontmatter, exactly as it may
		// override the paper. Three choices, so one command cycles on -> off
		// -> use default rather than needing three ids or a modal: the same
		// shape as `paper-cycle` above, which is the command this feature was
		// asked to behave like.
		//
		// The notice is not gated on `routineNoticesVisible`, unlike the paper
		// cycle's: a frontmatter key is invisible until the user opens
		// Properties, so without a word on screen a three-way cycle gives no
		// way to tell which of the three you are now on.
		this.addCommand({
			id: "canvas-note-override-cycle",
			name: "Infinite canvas for this note",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				// Markdown only: the override is a frontmatter key, and
				// `saveForPath` would refuse a PDF or a canvas file anyway.
				// Checked before the command is offered rather than after it
				// is run, so the palette does not list an id that cannot work.
				if (!file || file.extension !== "md") return false;
				if (checking) return true;
				const current: NoteCanvasChoice = this.canvasOverride?.choice(file.path) ?? "default";
				this.applyCanvasChoice(file.path, current === "default" ? true : current === true ? false : "default");
				return true;
			},
		});
		// The toolbar off and on from the palette or a hotkey, without the settings tab. Writes the same setting the
		// Toolbar visibility row writes, through the same applier, and remembers what it hid.
		// Registered outright: with the toolbar hidden it is the way back.
		//
		// THE TOOLBAR ONLY, since 1.4.20. It used to move the zoom bar with it. The zoom bar now
		// answers to its own row AND to Infinite Canvas, so a command that hid it took a decision away from both -
		// and with the canvas off there is no zoom bar on screen for this command to put back. `barsRestore` keeps
		// its shape in data.json: the zoom bar's mode is carried into the memory unchanged and never read back out.
		// The id does not move - a hotkey bound to it still resolves.
		this.addCommand({
			id: "toolbar-zoom-bar-toggle",
			name: "Toolbar on / off",
			callback: () => {
				// Decided from what is ON SCREEN, not from the setting alone: under Auto on desktop the strip
				// stays off until a pen is seen, and treating that as "on" saved "hide" with nothing to hide.
				// A remembered mode that would still leave the strip off comes back as "show".
				const onScreen = (m: PenToolsMode): boolean => penToolsVisible(m, Platform.isMobileApp, penSeenThisSession());
				const hidden = !onScreen(this.settings.penTools);
				const remembered = this.settings.barsRestore?.penTools;
				const next: PenToolsMode = hidden ? (remembered && onScreen(remembered) ? remembered : "show") : "hide";
				this.settings.barsRestore = hidden
					? null
					: { penTools: this.settings.penTools, noteZoomControls: this.settings.noteZoomControls };
				this.settings.penTools = next;
				setPenToolsMode(next);
				refreshPenToolsAll();
				runDetached(this.persistSettings(), "save the toolbar visibility");
				if (routineNoticesVisible()) new Notice(`Handwriting: toolbar ${next === "hide" ? "off" : "on"}`);
			},
		});
		// THE SPLIT (1.4.12). "Extra commands for hotkeys" gates REGISTRATION -
		// what the palette lists and what a hotkey can bind - and nothing else.
		// EXACTLY ONE of the two routes is live per command: registered here, or
		// filed with `setGatedCommandAction` for the strip - filed for the ones
		// kept OUT of the palette, and only those. The pen toolbar's own eraser,
		// lasso, insert-space and pan buttons run these ids through
		// `executeCommandById`, so un-registering them alone would have left four
		// dead buttons on a default install; filing an action for a command the
		// palette DOES hold would give the strip a second answer for it. (An
		// earlier version of this comment said the action was filed "either way",
		// which the two lines below have never done.) See CommandPaletteSplit.ts,
		// which also holds the table the settings row and the test read, so the
		// list under the switch is the list that registers here - and
		// `planGatedCommands`, which keeps the one-route rule when the switch
		// moves without a reload.
		clearGatedCommandActions();
		this.gatedCommandDefs.clear();
		// THE ONE ID THE PALETTE NO LONGER HOLDS, filed here because the strip
		// still names it. `pen-ink-toggle` left the palette in 1.4.12 (alan:
		// "there should only be one"), but the keyboard button's `commandId`,
		// `DEFAULT_FOLD_ORDER` and every fold order already saved to disk are
		// all written in it, so the button's `exec` still arrives with it in
		// hand. `setRetiredCommandAction` answers it forever and is invisible
		// to the "Extra commands for hotkeys" plan - which would otherwise
		// unfile it the moment the switch went on and leave the button dead.
		// See CommandPaletteSplit.ts's `retired` map for that trap in full.
		//
		// The button's MEANING is unchanged: flip the pen-input switch, and
		// nothing else. It is only built where a pen has been seen, and a pen
		// user coming back from typing is not asking to have the highlighter
		// taken out of their hand - so this is `togglePenInput`, not the
		// command's `penOnOff`. One flag either way, so the two never disagree.
		setRetiredCommandAction(PEN_INK_TOGGLE, () => {
			// As above: `togglePenInput` performs the toggle. Gate the toast only.
			const on = togglePenInput(penInkCommandHost);
			if (routineNoticesVisible()) showPenToggleNotice(penToggleNoticeText(on));
		});
		const addGatedCommand = (cmd: Command): void => {
			// Copied, and copied BEFORE registration. `addCommand` hands the
			// command back (obsidian.d.ts) and the palette shows these under the
			// plugin's own id and name, so a definition that has been through it
			// once is not one to hand back to it later.
			this.gatedCommandDefs.set(cmd.id, { ...cmd });
			if (this.settings.colorSizeCommands) this.addCommand(cmd);
			else if (cmd.callback) setGatedCommandAction(cmd.id, cmd.callback);
		};
		addGatedCommand({
			id: "inline-tool-eraser",
			name: "Toggle eraser on / off",
			callback: () => {
				const on = !getInlineEraserMode();
				setInlineEraserMode(on);
				this.enterTipMode(on);
				if (routineNoticesVisible()) showEraserToggleNotice(on ? "Handwriting: eraser" : this.tipModeOffNotice());
			},
		});
		// Lasso as a mode: the side button was the only way in, and every
		// apple pencil and every mouse lacks one. Exclusive with the eraser.
		addGatedCommand({
			id: "inline-tool-lasso",
			name: "Toggle lasso on / off",
			callback: () => {
				const on = !getInlineLassoMode();
				setInlineLassoMode(on);
				this.enterTipMode(on);
				if (routineNoticesVisible()) showLassoToggleNotice(on ? "Handwriting: lasso" : this.tipModeOffNotice());
			},
		});
		// Insert space as a mode, same shape as lasso: plant a divider with
		// the tip, drag down to open room, drag up to close it. Pen exits.
		addGatedCommand({
			id: "inline-tool-space",
			name: "Toggle insert space on / off",
			callback: () => {
				const on = !getInlineSpaceMode();
				setInlineSpaceMode(on);
				this.enterTipMode(on);
				if (routineNoticesVisible()) showSpaceToggleNotice(on ? "Handwriting: insert space" : this.tipModeOffNotice());
			},
		});
		// Pan as a mode: touch already pans by finger, but a pen on glass had
		// no way to move the page without marking it.
		addGatedCommand({
			id: "inline-tool-pan",
			name: "Toggle pan on / off",
			callback: () => {
				const on = !getInlinePanMode();
				setInlinePanMode(on);
				this.enterTipMode(on);
				if (routineNoticesVisible()) showPanToggleNotice(on ? "Handwriting: pan" : this.tipModeOffNotice());
			},
		});
		addGatedCommand({
			id: "eraser-size-cycle",
			name: "Eraser size: next",
			callback: () => {
				const next = nextEraserSize(getEraserRadiusPx());
				runDetached(this.setEraserSize(next.radiusPx, next.name), "save the eraser size", () =>
					new Notice("Handwriting: the eraser size changed, but the setting could not be saved")
				);
			},
		});
		// Nib sizes (OneNote-style): three steps on the ACTIVE tool, plus a
		// cycle command for a hotkey. Applies from the next stroke; persisted.
		// Eleven per-colour and per-size entries buried the pen commands:
		// the palette shows the same colours as swatches you can see, and
		// the cycle commands cover the rest. Behind a setting for anyone who
		// wants one hotkey per colour.
		// Quick pens' sixteen entries (design §10), behind the same switch as
		// every other per-value command and registered from their own file so
		// this gains one line rather than sixteen blocks.
		//
		// Through `addGatedCommand`, not `this.addCommand` behind a second
		// reading of `colorSizeCommands`: the switch is spelled ONCE in this
		// method, which is the whole point of the helper. `registerInkPresetCommands`
		// only wants something with `addCommand`, so the helper stands in as
		// that host and the preset table needs no knowledge of the split.
		registerInkPresetCommands({ addCommand: addGatedCommand });
		for (const step of INK_SIZE_STEPS) {
			addGatedCommand({
				id: `ink-size-${step.name}`,
				name: `Ink size: ${step.name}`,
				callback: () => {
					runDetached(this.setInkSize(step.mult, step.name), "save the ink size", () =>
						new Notice("Handwriting: the ink size changed, but the setting could not be saved.")
					);
				},
			});
		}
		addGatedCommand({
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
			// The union, from the split table rather than spelled again here:
			// the settings row prints these names and this loop registers
			// them, and one list is the only way those two stay equal.
			const names = inkColorNames();
			{
				for (const name of names) {
					addGatedCommand({
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
					addGatedCommand({
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
				const strokes = file ? inlineInk.strokes(file.path) : undefined;
				if (!file || file.extension !== "md" || !strokes?.some((stroke) => stroke.points.length > 0)) {
					return false;
				}
				if (!checking) {
					const svg = inkToSvg(strokes);
					if (!svg) {
						new Notice("Handwriting: no ink to export on this note");
						return true;
					}
					// Counted like the snip and the flatten: two exports are two
					// attempts, and the second must not eat the first.
					const svgBase = stripMarkdownExtension(file.path) + ".ink";
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
				const strokes = file ? inlineInk.strokes(file.path) : undefined;
				if (!file || file.extension !== "md" || !strokes?.some((stroke) => stroke.points.length > 0)) {
					return false;
				}
				if (!checking) {
					const pdf = inkToPdf(strokes);
					if (!pdf) {
						new Notice("Handwriting: no ink to export on this note");
						return true;
					}
					// Beside the note, like the SVG, and counted like every
					// other export now: the second must not eat the first.
					const pdfBase = stripMarkdownExtension(file.path) + ".ink";
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
					const surface = this.activeInkSurface();
					const overlay = surface?.kind === "inline" ? surface.overlay : null;
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
							}, () => this.store.trashFolderFor(id)).open();
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
			name: "Lasso: delete selection",
			checkCallback: (checking) => {
				const surface = this.activeInkSurface();
				if (!surface) return false;
				if (!checking) {
					if (surface.kind === "inline") {
						// Two different failures, two different sentences; see
						// `lassoDeleteNotice`, which owns both strings so they are
						// pinned by execution rather than by reading this file.
						const said = lassoDeleteNotice(surface.overlay.deleteSelectedInk());
						if (said) new Notice(said);
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
			name: "Lasso: copy selection",
			checkCallback: (checking) => {
				const surface = this.activeInkSurface();
				if (!surface) return false;
				if (!checking) {
					if (surface.kind === "inline") {
						// One owner for both sentences; see `copySelectionNotice`.
						// The strings are unchanged - this moved where they live so
						// the strip button cannot drift from the command.
						// The copy itself runs either way; only the success sentence is routine.
						const copied = surface.overlay.copySelectedInk();
						if (routineNoticesVisible() || !copySelectionNoticeIsRoutine(copied))
							new Notice(copySelectionNotice(copied));
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
			name: "Lasso: cut selection",
			checkCallback: (checking) => {
				const surface = this.activeInkSurface();
				if (!surface) return false;
				if (!checking) {
					if (surface.kind === "inline") {
						// Three outcomes, not two; see `cutSelectionNotice`,
						// which owns all three sentences so they are pinned by
						// execution rather than by reading this file.
						const outcome = surface.overlay.cutSelectedInk();
						if (routineNoticesVisible() || !cutSelectionNoticeIsRoutine(outcome))
							new Notice(cutSelectionNotice(outcome));
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
			name: "Lasso: paste",
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
						if (n > 0 && routineNoticesVisible()) new Notice(`Handwriting: pasted ${n} stroke(s)`);
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
					const surface = this.activeInkSurface();
					this.deleteAllInkOrSaySo(file.path, surface?.kind === "inline" ? surface.overlay : null);
				}
				return true;
			},
		});
		this.addCommand({
			id: "check-split-ink",
			name: "Check for ink split across folders",
			callback: () => {
				void this.reportSplitInk();
			},
		});
		addGatedCommand({
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
		addGatedCommand({
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
		addGatedCommand({
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
				// The tool state alone does not repaint a toolbar: without this the
				// Highlighter button stayed unlit after the command (audit 104).
				refreshAllStrips();
				if (routineNoticesVisible()) new Notice("Handwriting: highlighter");
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
				const epochAtOpen = diagnosticsEpoch();
				new DiagnosticTextModal(
					this.app,
					"Handwriting pen trace",
					formatInlinePenTrace(),
					undefined,
					() => {
						// A newer recording began while this window was open: not ours to end.
						if (!endRecordingIfCurrent(epochAtOpen)) return;
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
					loadedBuild: loadedBuild(this.manifest.version),
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
				const epochAtOpen = diagnosticsEpoch();
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
						// A newer recording began while this window was open: not ours to end.
						if (!endRecordingIfCurrent(epochAtOpen)) return;
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
		if (this.settings.devDiagnostics) {
			// A Chromium trace of the ink pipeline, saved into the plugin folder.
			this.addCommand({
				id: "start-ink-trace",
				name: "Diagnostics: start ink trace",
				callback: async () => {
					new Notice(await this.inkTrace.start());
				},
			});
			this.addCommand({
				id: "stop-ink-trace",
				name: "Diagnostics: stop ink trace",
				callback: async () => {
					new Notice(await this.inkTrace.stop((text) => new Notice(text)));
				},
			});
		}
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
		// What this plugin costs on a moving pdf (PdfPanTrace.ts): one row per
		// Pan-tool move, and - since 1.4.12 - one per NATIVE scroll of the
		// viewer, which is the half a pan trace could never see. The command
		// keeps the name it was registered under; the rows say which kind
		// they are.
		//
		// The same pan measured on this desktop showed nothing at all, so the
		// columns that matter are the ones a desktop mouse could not vary -
		// the pointerType holding the page and whether Chromium delivered the
		// batch coalesced - beside the handler time and the wait for the next
		// animation frame.
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "copy-pdf-pan-trace",
				name: "Diagnostics: show PDF pan trace",
				callback: () => {
					showDiagnosticText(this.app, "Handwriting PDF pan trace", formatPdfPanTrace());
				},
			});
		}
		if (this.settings.devDiagnostics) {
			this.addCommand({
				id: "clear-pdf-pan-trace",
				name: "Diagnostics: clear PDF pan trace",
				callback: () => {
					clearPdfPanTrace();
					new Notice("Handwriting: PDF pan trace cleared");
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
					embedInkRenamed(oldPath, file.path);
					surfaceExtents.handleRename(oldPath, file.path);
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
				}
			})
		);

		// Obsidian's status bar is a fixed overlay in the bottom-right corner
		// (word count, backlink/property counts, plugin items). On a Handwriting
		// page it sits ON TOP of the writing surface and the horizontal
		// scrollbar, and no native setting moves it - so `handwriting-active-page`
		// on <body> hides the strip (scoped CSS) while the ACTIVE note is one.
		// BEHIND A SETTING, off by default: see `hideStatusBarOnInkedNotes`, and
		// `applyStatusBarVisibility`, which is the only reader of it.
		const updateStatusBarClass = (): void => this.applyStatusBarVisibility();
		this.registerEvent(this.app.workspace.on("active-leaf-change", updateStatusBarClass));
		// A theme switch arrives as `css-change` and nothing else. Ink adaptation
		// now reads the body class at draw time; `refreshInkTheme` is a compatibility
		// no-op, while every surface still needs repainting under the new theme.
		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				refreshInkTheme(document);
				repaintAllInkOverlays();
				// The strip previews ink - the tinted palette button and the
				// swatch pop - and a preview that disagrees with the stroke
				// beside it is a swatch lying about which pen it is.
				refreshAllStrips();
				// A live deck's ink theme is measured off `.reveal`'s own
				// paint, not read from this event, so a theme or snippet
				// switch mid-presentation has to re-arm that measurement
				// itself (GAP 16) - a no-op when no deck is live.
				onSlidesCssChange();
			})
		);
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
		// Slides ink. These two hooks are a courtesy re-scan and nothing more:
		// the core Slides presentation is a div on `<body>`, not a leaf, so
		// neither event ever fires for one opening or closing
		// (SlidesInkSurface S1). Its own MutationObserver is the real signal.
		// `scanForSlides` returns immediately while the feature is off, so this
		// costs nothing to a vault that has turned it off.
		this.registerEvent(this.app.workspace.on("layout-change", () => scanForSlides()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => scanForSlides()));
		if (this.settings.slidesInk) this.startSlidesInk();
		// Disposes the live deck, which flushes its save.
		this.register(() => setSlidesInk(false));
		// Every way the recording switch flips, not just the command: showing
		// a report also ends the capture, and that path left "recording pen"
		// in the status bar with nothing recording.
		setDiagnosticsChangedListener(() => {
			syncUndoTraceForDiagnostics();
			this.syncRecordingBadge();
			// The toolbars' recording dot reads the switch too: a report that ends
			// the recording must repaint it, or the dot stays lit and a hold on it
			// starts recording again.
			refreshAllStrips();
		});
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
				},
				// And mouse ink going OFF strands the reticle on a PDF the
				// same way it does on a note: the pointer is still over the
				// pane, so neither pointerleave nor the watchdog the mouse is
				// exempt from will ever take the ring down. See
				// `hidePenCursorsEverywhere` (InkOverlay.ts), which is what
				// calls this.
				() => {
					for (const c of this.pdfInk.values()) c.hideCursor();
				},
				// And the pen going OFF mid-stroke has to end that stroke on a
				// PDF the same way it does on a note, now that this surface
				// honours the state at all: the router refuses the NEXT claim
				// and never breaks the one it holds, so without this a pdf
				// stroke claimed a moment before the toggle would keep
				// `activePenId` set with the click suppressor armed behind it.
				// See `endLiveStrokesEverywhere` (InkOverlay.ts), which is what
				// calls this, and `PdfInkController.endLiveStroke` for why it
				// commits the stroke rather than dropping it.
				(preserveMouse = false) => {
					for (const c of this.pdfInk.values()) c.endLiveStroke(preserveMouse);
				}
			)
		);
		this.registerEvent(this.app.workspace.on("file-open", updateStatusBarClass));
		// A reading-view tab that opens a note with no content never runs the
		// post-processor, so its layer would keep the previous note's ink.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) embedInkFileOpened(this.app.workspace.getActiveViewOfType(View)?.containerEl ?? null, file.path);
			})
		);
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
		// Delete all ink (and the last stroke erased) empties the note without
		// touching its metadata, so the ink change itself re-decides the bar.
		this.register(
			onInkChanged((p) => {
				if (p === this.app.workspace.getActiveFile()?.path) updateStatusBarClass();
			})
		);

		// After layout, not during onload: a modal that opens while the
		// workspace is still assembling fights the app for the screen.
		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) return;
			this.showWhatsNewIfDue();
			this.showScribbleHintIfDue();
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

		// ---- foreground repaint (1.4.12 §14) ----------------------------------
		// The mirror of the flush above, on the way BACK. WebKit reclaims a
		// canvas's pixels under memory pressure and says nothing, and a
		// backgrounded or screen-locked app is where that is most likely; the
		// scroll repaint draws nothing while the camera is still, so purged
		// ink stayed gone until the band moved or the note was reopened -
		// exactly the iPad report, and exactly why switching notes "fixed" it.
		// All three events for the same reason the flush takes two: iOS fires
		// none of them reliably on its own. `armForegroundRepaint` coalesces
		// them into one repaint per return and hands back its own teardown,
		// which `register` calls on unload.
		//
		// `isMobileApp` GATES REGISTRATION ITSELF (auditor, 2026-09-05): this
		// call used to add all three listeners unconditionally, so every
		// desktop alt-tab back into Obsidian re-rasterised every visible
		// stroke on every open pane, for a WebKit purge desktop never has.
		// See `ForegroundHost.isMobileApp`.
		this.register(
			armForegroundRepaint(
				{ doc: document, win: window, isMobileApp: Platform.isMobileApp },
				() => repaintAllInkOverlays()
			)
		);

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
		// Obsidian can read the frontmatter again, or the block is gone: a
		// claim refused on it goes ahead now and the strokes held since save.
		// A block Obsidian cannot parse still yields a first section of type
		// "yaml" and no frontmatter; while that holds, nothing is retried, so
		// a still-broken note is not rewritten or re-announced on every edit.
		const cache = this.app.metadataCache.getCache(path);
		if (cache && (cache.frontmatter !== undefined || cache.sections?.[0]?.type !== "yaml")) {
			inlineInk.retryRefusedClaim(path);
		}
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
		// It came back after the grace ran out: frontmatter that stayed
		// unparseable longer than Obsidian's save-and-index delay. The record
		// was dropped, so read the sidecar again and repaint, rather than
		// leaving the note blank until it is reopened.
		if (this.declaimedPaths.delete(path)) {
			runDetached(
				inlineInk.ensureLoaded(path).then((changed) => {
					if (!changed) return;
					inkExternallyReloaded(path);
					notifyInkChanged(path);
				}),
				`reload ink for ${path} after its page id returned`
			);
		}
		// The note now carries a different id than an ambiguous one it shared:
		// the copy was fixed by editing its value. Re-check that collision, or
		// the original stays read-only all session.
		for (const [aid, paths] of [...this.ambiguousIds]) {
			if (aid !== id && paths.includes(path)) this.recheckCollision(aid);
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
			this.declaimedPaths.add(path);
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
			// writer for that id (no live owner record).
			if (verdict === "old-queue-orphaned") {
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
		// The file could not be read at launch: writing it would put this
		// session's defaults over the settings it still holds.
		if (this.settingsReadFailed) return;
		this.settingsDirty = true;
		if (this.settingsTimer !== null) window.clearTimeout(this.settingsTimer);
		this.settingsTimer = window.setTimeout(
			() => runDetached(this.flushSettings(), "flush ownership settings"),
			2000
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
		if (routineNoticesVisible()) new Notice(`Handwriting: ${tool} ${name}`);
	}

	private async setInkSize(mult: number, name: string): Promise<void> {
		const tool = getInlineTool();
		setInkSizeMult(tool, mult);
		this.settings.inkSizes[tool] = clampInkSize(mult);
		await this.persistSettings();
		if (routineNoticesVisible()) new Notice(`Handwriting: ${tool} size ${name}`);
	}

	private async setEraserSize(radiusPx: number, name: string): Promise<void> {
		setEraserRadiusPx(radiusPx);
		this.settings.eraserRadiusPx = clampEraserRadius(radiusPx);
		await this.persistSettings();
		if (routineNoticesVisible()) new Notice(`Handwriting: eraser ${name}`);
	}

	/**
	 * "Delete all ink" once the command has decided the note qualifies:
	 * either the confirm dialog, or the refusal that says why not.
	 *
	 * THE REFUSAL MUST NOT BE A GUESS. `hasInk` is a read of the session
	 * cache, and the cache is empty for every note whose sidecar has not been
	 * read yet - so on a note opened moments ago, or one this pane has never
	 * shown, the old code answered "Handwriting: no ink on this note" about a
	 * note full of ink. `inkPresence` separates "certainly empty" from "not
	 * looked up yet" (InlineInkStore.inkPresence), and the second one is
	 * answered by GOING AND LOOKING: one `ensureLoaded`, then the same
	 * decision on real information. The load is the cheap path in the common
	 * case - a note with no `handwriting-page-id` is already "none" off a
	 * metadata lookup, no file I/O - so this costs a read exactly when a read
	 * is the only honest way to answer.
	 *
	 * Deliberately still LISTED on every note, per the command's own comment:
	 * the fix is to stop lying in the refusal, not to hide the command.
	 */
	private deleteAllInkOrSaySo(path: string, overlay?: InkOverlayPlugin | null): void {
		// THE TARGET, captured before any await, as an object AND the path it
		// was invoked under. A string does not follow a rename, so every later
		// step compares against this pair rather than trusting the name.
		const target = this.captureDeleteAllTarget(path, overlay);
		if (target?.overlay === null) {
			new Notice("Handwriting: open the note in editing view to delete its ink.");
			return;
		}
		if (this.qualifiedDeleteAllPresence(target) === "unknown") {
			runDetached(
				// ONE attempt, and it requalifies the SAME capture afterwards.
				// An unresolved load must not become no-ink, and must not loop.
				inlineInk.ensureLoaded(path).then(() => this.deleteAllInkNow(target)),
				`read ink before deleting all of it on ${path}`
			);
			return;
		}
		this.deleteAllInkNow(target);
	}

	/**
	 * The note and pane this command was invoked on. The pane is captured before
	 * the confirmation or backup can yield, so a focus change cannot move undo
	 * into another editor. Older direct callers without a workspace editor keep
	 * the path-only behavior; product commands supply a pane or explicit null.
	 *
	 * `null` when the command started on something that is not a Markdown file
	 * in the vault, which is not a note we may delete ink from either.
	 */
	private captureDeleteAllTarget(path: string, overlay?: InkOverlayPlugin | null): DeleteAllTarget {
		const file = this.app.vault.getFileByPath(path);
		if (file === null) return null;
		const active = this.app.workspace?.activeEditor;
		const selected = overlay !== undefined
			? overlay
			: active
				? active.editor && active.file === file
					? overlayForActiveEditor(active.editor, file)
					: null
				: undefined;
		return { file, path, overlay: selected };
	}

	/**
	 * Is the captured target STILL the current one, synchronously, right now?
	 *
	 * Four clauses, and each is load-bearing (ruled 2026-09-09T07:31:28):
	 *
	 *  - `!this.unloaded` - the plugin itself is still live. Acting after
	 *    unload writes through a store nobody is maintaining.
	 *  - `extension === "md"` - it is still a note.
	 *  - `file.path === target.path` - NOT RENAMED. Obsidian moves the same
	 *    `TFile` object and updates its `path`, so the object surviving is not
	 *    evidence the name did.
	 *  - the vault entry AT that path IS that object - NOT REPLACED. Path
	 *    equality alone is insufficient: delete-then-recreate at the same path
	 *    produces a different `TFile` wearing the same name, and following the
	 *    string there would retarget the deletion at somebody else's ink.
	 *
	 * `getActiveFile()` is deliberately not consulted. The target is the note
	 * the command was invoked on, never whatever happens to be focused when the
	 * user finally clicks.
	 */
	private sameDeleteAllTarget(target: DeleteAllTarget): boolean {
		if (target === null) return false;
		return (
			!this.unloaded &&
			target.file.extension === "md" &&
			target.file.path === target.path &&
			this.app.vault.getAbstractFileByPath(target.path) === target.file
		);
	}

	/**
	 * Presence, but only when it is evidence about THIS note.
	 *
	 * `inkPresence` answers a question about a path; this answers a question
	 * about a target, and the difference is the whole seam. Three ways a bare
	 * `none` is not evidence of an empty note:
	 *
	 *  - THE TARGET IS GONE OR IS SOMEBODY ELSE. A note renamed away leaves no
	 *    record and no metadata under its old path, which is precisely the
	 *    shape `InlineInkStore.ts:453` answers `none` for. Identity first.
	 *  - NO HOST. Session-memory mode has nothing to look in, so `none` there
	 *    means "nothing looked", not "nothing to find".
	 *  - NO METADATA. A missing file cache cannot testify that the note has no
	 *    ink id; absent metadata is the absence of evidence. Metadata that IS
	 *    available and carries no ink id is real evidence and may be `none`.
	 *
	 * Returns `"invalid-target"` rather than throwing, so the caller decides
	 * what to say - and the caller says the generic refusal, never no-ink.
	 */
	private qualifiedDeleteAllPresence(target: DeleteAllTarget): InkPresence | "invalid-target" {
		if (!this.sameDeleteAllTarget(target)) return "invalid-target";
		if (!inlineInk.hasHost()) return "unknown";
		const presence = inlineInk.inkPresence(target!.path);
		if (presence !== "none") return presence;
		const cache = this.app.metadataCache.getFileCache(target!.file);
		return cache === null || cache === undefined ? "unknown" : "none";
	}

	/**
	 * The decision itself, on information already in hand.
	 *
	 * THE ORDINARY PATH USES ALAN'S SENTENCE TOO, on his ruling of 2026-09-09
	 * 16:49 - "yeah both use mine". This site and the `unknown-readiness`
	 * refusal were one character apart, and the difference was never a
	 * decision: the constant simply had not been carried here. He was told the
	 * two do not differ beyond the period, and that HIS sentence was on the
	 * rare path while the older wording was on the common one - so the ruling
	 * is about REACH, not wording.
	 *
	 * It stops at the note surface. The PDF sentence is still open with him.
	 *
	 * AND NO-INK IS NOW TWO CONDITIONS, NOT ONE. Alan's sentence says something
	 * about a specific note, so it may only be said when this is still that
	 * note AND its presence is a qualified `none`.
	 *
	 * `inkPresence` ALONE CANNOT CARRY IT, which is the trap in this seam and
	 * is why the identity check is not belt-and-braces. `InlineInkStore.ts:453`
	 * answers `none` when there is no record and the note carries no page id -
	 * and a note that has been renamed away has exactly that shape: no record
	 * under the old string, no metadata under it either. So `none` means both
	 * "a real empty note" and "no longer there", and only the captured object
	 * tells them apart. Swapping `hasInk` for `inkPresence` would have looked
	 * like the fix and left the seam open.
	 *
	 * `unknown` does not reach the sentence either: an unread record with an
	 * empty cache is not evidence of emptiness, it is the absence of evidence.
	 */
	private deleteAllInkNow(target: DeleteAllTarget): void {
		const presence = this.qualifiedDeleteAllPresence(target);
		if (presence === "ink") this.confirmDeleteAllInk(target);
		else if (presence === "none") new Notice(DELETE_ALL_NO_INK);
		else new Notice(DELETE_ALL_REFUSED);
	}

	/**
	 * "Delete all ink": confirm first. The count in the dialog is live.
	 *
	 * THE MODAL IS THE LONGEST AWAIT IN THIS COMMAND - it is however long the
	 * user takes - so the identity is checked again inside the callback,
	 * immediately before the wipe is dispatched. Checking only at the start
	 * would authorise a deletion against a note and then perform it against
	 * whatever holds that path by the time they click.
	 */
	private confirmDeleteAllInk(target: DeleteAllTarget): void {
		if (target === null) return;
		const count = inlineInk.strokes(target.path).length;
		if (count === 0) return;
		const id = inlineInk.pageIdOf(target.path);
		// The dialog names the folder the copy will go to.
		new ConfirmDeleteInkModal(this.app, count, "note", () =>
			this.confirmedDeleteAllInk(target)
		, () => (id ? this.store.trashFolderFor(id) : Promise.resolve(`${this.store.inkFolder()}/trash`))).open();
	}

	/**
	 * What the confirmation button actually does.
	 *
	 * A NAMED METHOD RATHER THAN AN INLINE CLOSURE, so the re-check has a
	 * caller a test can reach: `ConfirmDeleteInkModal` is not exported and
	 * nothing in the suite drives it, so a check living inside its callback
	 * could only ever be pinned by reading the source. This is the same
	 * decision, one indirection out, and it is executed instead.
	 */
	private confirmedDeleteAllInk(target: DeleteAllTarget): void {
		// A CONFIRMED CALL WITHOUT ITS ORIGINAL CAPTURE IS INVALID, and that is
		// not permission to reacquire one by path: the whole point of the
		// capture is that the path may no longer mean what it meant.
		if (!target || !this.sameDeleteAllTarget(target)) {
			new Notice(DELETE_ALL_REFUSED);
			return;
		}
		runDetached(this.deleteAllInk(target), `delete all ink on ${target.path}`);
	}

	/**
	 * The confirmed wipe. Order matters and follows the permanence invariant:
	 * the .handwriting/trash/ safety copy is made BEFORE anything is removed, and a
	 * failed copy aborts the wipe entirely. Handwriting never deletes ink it could
	 * not first preserve. A damaged (unreadable) sidecar skips the copy: the
	 * file on disk is already the artifact being protected, the wipe writes
	 * nothing there (fail-closed lock), and only session strokes are cleared.
	 */
	private async deleteAllInk(target: DeleteAllTarget): Promise<void> {
		// (0) THE TARGET, BEFORE THE READINESS. A confirmed call arriving
		// without its original capture is invalid, and reacquiring one from the
		// path would defeat the capture's whole purpose.
		if (!target || !this.sameDeleteAllTarget(target)) {
			reportDeleteAllRefusal("target-lost");
			return;
		}
		const path = target.path;

		// (1) READINESS BEFORE ANYTHING. A blocked note gets NO side effects at
		// all: no preservation, no trash write, no session change, no live
		// bytes, no history entry and no success notice. Not a quieter
		// success - nothing. Under these locks `snapshot()` refuses, so every
		// write this command would make dies silently, and a note that has
		// already been told its ink is not being saved must not then be told a
		// copy was kept.
		//
		// NO NOTICE IS RAISED HERE, deliberately. The store's own lock
		// reporting is the approved wording and it has already spoken; no new
		// copy is authorized for this path, and inventing one - or borrowing
		// the pdf route's - is out of scope. Named in the handback as the one
		// thing this repair leaves owed.
		const readiness = inlineInk.deleteAllReadiness(path);
		if (readiness.kind === "blocked") {
			reportDeleteAllRefusal(`locked-${readiness.lock}`);
			return;
		}

		// `unknown` REFUSES, on the 18:21 ruling, and this reverses what an
		// earlier revision of this command did. The measurement that revision
		// rested on still stands - an unclaimed record's ink has no sidecar and
		// cannot compose one, so there is nothing on disk to lose - but the
		// ruling is about what an UNPROVEN state may be permitted to do, which
		// is a different question: unknown does not prove eligibility, a valid
		// capture, an empty target or an adequate backup, so it may not reach a
		// destructive clear, a history entry or a success notice.
		//
		// NO EMPTINESS PROBE HERE, deliberately: discovering the target was
		// empty by calling the registry IS invoking the wipe. The
		// non-destructive no-op for an empty note already exists upstream in
		// `confirmDeleteAllInk`, which returns before the modal when the count
		// is zero, and it is untouched.
		if (readiness.kind === "unknown") {
			// TWO DIFFERENT NOTES REACH THIS ONE READINESS, and Alan's second
			// string is true of only one of them. He ruled on "a note you've
			// never inked"; `unknown` also covers a note that HAS been drawn on
			// but whose identity claim has not landed yet - a state measured in
			// this file's `unknown` cases, holding real strokes. Telling that
			// user "no ink on this note" would be a second false sentence of
			// exactly the kind the first one was corrected for, so the reason is
			// split here rather than the string being stretched to cover it.
			//
			// QUALIFIED PRESENCE, NOT A STROKE COUNT. An empty `strokes(path)`
			// is the same shape for "a note never drawn on" and for "a note
			// that is no longer there", and only the first of those may be
			// told there is no ink on it. So ONLY a qualified `none` takes the
			// no-ink arm; `ink`, `unknown` and an invalid target all take the
			// generic refusal.
			//
			// It remains a pure lookup: it inspects, and it does not invoke the
			// wipe to discover whether the target was empty.
			const presence = this.qualifiedDeleteAllPresence(target);
			reportDeleteAllRefusal(presence === "none" ? "unknown-readiness" : "unknown-holds-ink");
			return;
		}

		// AN UNSETTLED RECORD REFUSES FOR THE SAME REASON, and it is the arm
		// that matters most: mid-load its memory is empty while the sidecar can
		// be full, so the capture is empty, and an empty capture is the one the
		// backup verification below does not run. Letting it through would read
		// "I have not looked yet" as "there is nothing to preserve".
		if (readiness.kind === "unsettled") {
			reportDeleteAllRefusal("unsettled-record");
			return;
		}

		// `damaged` remains the EXISTING intentional session-only branch, kept
		// as a distinct explicit exception: the file on disk is already the
		// artifact being protected and the wipe writes nothing there.
		if (readiness.kind !== "ready") {
			finishDeleteAllInk(path, null, target.overlay);
			return;
		}

		// (2) THE CAPTURE, at the same boundary as the readiness check and
		// before any await: ordered, deep, immutable, and carrying each
		// targeted stroke's `unknownByObject` entry.
		//
		// A null capture REFUSES rather than clearing. `ready` already implies
		// a record with a page id so this is not reachable through readiness,
		// but "no valid capture" and "safe to destroy" must not be the same
		// branch: the ruling names a valid capture as one of the things an
		// unproven state does not establish.
		const capture = inlineInk.captureDeleteAll(path);
		if (capture === null) {
			reportDeleteAllRefusal("no-capture");
			return;
		}

		let kept: string | null = null;
		try {
			kept = await this.store.preserve(capture.pageId);
		} catch (err) {
			console.error("[handwriting] delete-all-ink backup failed", err);
			new Notice(deleteAllBackupFailureText(err, "note"));
			return;
		}

		// (3) THE BACKUP THAT CAME BACK HAS TO HOLD THE INK. `preserve` copies
		// whatever is at the live path and returns where it put it; its return
		// value does not certify that the file equals what is on screen. A
		// non-empty target therefore requires a real returned path AND a
		// readback that matches the capture at ordinary saved precision.
		// The empty-target case skips the verification below because there was
		// nothing to preserve - and that is only true because readiness has
		// already refused every unsettled record. An empty capture on a record
		// that has not finished loading means "not looked at yet", not "empty".
		if (capture.targets.length > 0) {
			// A REAL PATH, not merely a non-null one. `preserve` answering with
			// an empty or blank string is not a location a copy can be at, and
			// treating it as one would let "I could not preserve this" pass for
			// "preserved, carry on".
			if (kept === null || kept.trim() === "") {
				reportDeleteAllRefusal("backup-missing");
				return;
			}
			if (!(await backupHoldsCapture(capture, kept, (p) => this.app.vault.adapter.read(p)))) {
				reportDeleteAllRefusal("backup-unverified");
				return;
			}
		}

		// (4) AND NOTHING MAY AWAIT FROM HERE TO THE CLEAR. Readiness can be
		// lost during the copy, and content can change under it - including by
		// less than the persisted codec can represent, which is why the
		// current-content check is exact and unrounded while the backup check
		// above is not.
		//
		// On any refusal here the backup STAYS. It is a real generation of
		// real ink; deleting it to tidy up would be its own small loss, and
		// "no trash copy" stops being a truthful postcondition the moment
		// preservation has run.
		// THE SAME TARGET, RECHECKED HERE AND NOT EARLIER. Preservation is an
		// await, and a rename, delete or replacement during it leaves the path
		// naming a different note - or none. This is the last synchronous
		// moment before the mutation, so it is the only place the check is
		// worth anything.
		//
		// The backup already produced STAYS, and is neither retargeted nor
		// removed: it is a real generation of this note's real ink, and the
		// note having moved does not make it less so.
		if (!target || !this.sameDeleteAllTarget(target)) {
			// `target-lost`, NOT `readiness-lost`. Both refuse and both keep the
			// backup, but they say different things, and only one of them is
			// true here: the note is not coming back in a moment.
			reportDeleteAllRefusal("target-lost");
			return;
		}
		if (inlineInk.deleteAllReadiness(path).kind !== "ready") {
			reportDeleteAllRefusal("readiness-lost");
			return;
		}
		if (!inlineInk.currentMatchesCapture(capture)) {
			reportDeleteAllRefusal("changed-during-backup");
			return;
		}

		finishDeleteAllInk(path, kept, target.overlay);
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
		return this.notePathFor(pageId) ?? `an unnamed page (${pageId.slice(0, 8)}…)`;
	}

	/** The lookup half of `noteNameFor`: the note or open PDF a page id belongs to, or null. */
	private notePathFor(pageId: string): string | null {
		// A slides deck keeps its ink in `<note id>.slides`: the note is the file.
		const noteId = pageId.endsWith(SLIDES_SIDECAR_SUFFIX)
			? pageId.slice(0, -SLIDES_SIDECAR_SUFFIX.length)
			: pageId;
		const known = this.pageIds.owner(noteId);
		if (known) return known;
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (this.recentPageIdFor(f) === noteId) return f.path;
		}
		// An open PDF: its ink id is held per pane, next to the path it was read from.
		for (const [root, id] of this.pdfIds) {
			const at = id === pageId ? this.pdfFiles.get(root) : undefined;
			if (at) return at;
		}
		// A PDF whose pane has closed: the path this session resolved its id from.
		return this.pdfPathById?.get(pageId) ?? null;
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
	 * switch were the two writers of this mode (a9bf181) and both owed it
	 * the same pair, so it lives once here rather than twice at the call
	 * sites - the duplication a9bf181 accepted deliberately turned out to be
	 * exactly the kind this project keeps paying for. The switch went in
	 * 1.4.20; the command is the one caller now.
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
	// Not private: HandwritingSettingTab called this through `this.plugin`
	// as the mode's second writer (a9bf181) until 1.4.20 took its switch
	// out, and TipModeCommand.test.ts still drives it directly.
	/**
	 * The settings side of the fold order: write it, apply it, save it.
	 *
	 * THE CONTROL THAT CALLS THIS IS NOT BUILT YET - it waits on the owner
	 * choosing between arrows and drag handles, and the strip is the most
	 * visible part of the plugin ("we must be painstaking in our design"), so
	 * the shape of it is not a builder's call. The writer is here so that
	 * slice adds a row and nothing else, and so the model can be exercised
	 * before the UI exists.
	 *
	 * Normalises rather than trusting its caller: a control handing over a
	 * reordered array is exactly the place a duplicate or a dropped id would
	 * come from, and `setStripFoldOrder` re-folds every open strip the moment
	 * this returns.
	 */
	applyStripFoldOrder(order: readonly string[]): void {
		const next = normalizeFoldOrder(order);
		this.settings.stripFoldOrder = next;
		setStripFoldOrder(next);
		runDetached(this.persistSettings(), "save the toolbar fold order");
	}

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
		// A live trace would outlive this instance; stop it, saved nowhere in
		// the vault, but only when this recorder started one or diagnostics is
		// on. Unload tests run this on an Object.create instance, where field
		// initializers never ran and settings may be absent.
		void stopTraceAtUnload(this.inkTrace, this.settings?.devDiagnostics === true);
		this.pdfPathById?.clear();
		this.notePaper?.destroy();
		this.canvasOverride?.destroy();
		// Pending recycles are DROPPED, never run early. A sidecar left in
		// place is an orphan somebody can delete; ink recycled for a note
		// that was about to come back is the failure this delay exists to
		// prevent, and unload is exactly when a sync is most likely still
		// mid-pair. The next session's delete will schedule it again.
		for (const timer of this.pendingRecycle.values()) window.clearTimeout(timer);
		this.pendingRecycle.clear();
		this.pdfStore.cancelPendingDeletes();
		// Same reasoning for pending declaims: not confirming one leaves a
		// note holding an id it may no longer carry, which the next session's
		// census resolves. Confirming one at unload could free an id from a
		// note whose frontmatter was mid-edit when the plugin went down.
		for (const timer of this.declaimTimers.values()) window.clearTimeout(timer);
		this.declaimTimers.clear();
		this.applyPaper("none");
		// Unconditional, NOT gated on the setting: a plugin being disabled with
		// the toggle on must still hand the status bar back, and reading the
		// setting here would leave it hidden for exactly those users.
		document.body.classList.remove("handwriting-active-page");
		document.body.classList.remove("handwriting-boox");
		// loadSettings adds this on Android; a disabled plugin must not leave
		// the Android toolbar clearance CSS armed.
		document.body.classList.remove("handwriting-android");
		destroyProbeMarkers();
		// The last toggle's toast is Obsidian's DOM on Obsidian's timeout, so
		// a plugin disabled or reloaded inside that timeout left a toast on
		// screen naming the state of something no longer running.
		hideOwnedNotices();
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
		// One line to the vaults 1.4.20 caught. That release pinned pressure
		// sensitivity on and rewrote a stored `false` to `true` on the next
		// save, so a vault arriving from it draws its old ink under the
		// pressure law and nothing in data.json says whether its owner ever
		// chose that. 1.4.21 gives the row back; this says where it is, to the
		// one version that can have been caught, on the one launch that reads
		// `1.4.20` here - the record at the end then moves the version on.
		//
		// It goes FIRST, above the what's-new block. That block swallows its
		// own failure and returns early so its notes retry next launch, and
		// anything after it is skipped on that path - which would drop the one
		// message this release exists to deliver.
		//
		// Reads only. Nothing about the setting is changed for them: which of
		// these vaults wanted pressure on is not ours to guess.
		if (this.settings.lastSeenVersion === "1.4.20" && this.settings.pressureSensitivity === true) {
			try {
				new Notice(
					"Handwriting: ink too wide? Settings, pen, pressure sensitivity, off.",
					20000
				);
			} catch (err) {
				// Its own catch, deliberately: the record at the end is what
				// keeps the what's-new notes from repeating, and a toast that
				// failed to open must not cost that.
				console.error("[handwriting] the pressure notice failed to open", err);
			}
		}

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
		runDetached(this.flushSettings(true), "flush settings on hide");
	}

	/** Best-effort shutdown: settle in-flight claims and loads, then flush. */
	private async finishPersistence(): Promise<void> {
		try {
			await inlineInk.settle();
		} catch (err) {
			console.error("[handwriting] settle on unload failed", err);
		}
		try {
			// The presentation keeps its own claim and load promises, which
			// `inlineInk.settle()` cannot see: a deck torn down inside the
			// ~100-300 ms a first-stroke claim takes has a write parked behind
			// it, and flushing the store before that lands writes nothing.
			await settleSlidesInk();
		} catch (err) {
			console.error("[handwriting] slides settle on unload failed", err);
		}
		try {
			// Same reason, the PDF store: a stroke drawn while its sidecar is
			// still being read reaches the page store only when the read lands.
			await this.pdfStore.settle();
		} catch (err) {
			console.error("[handwriting] pdf settle on unload failed", err);
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

	/** Open the pen probe in a new tab. Its own leaf, so the note stays put. */
	private async openPenDiagnostics(): Promise<void> {
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({
			type: HANDWRITING_DIAGNOSTICS_VIEW_TYPE,
			active: true,
		});
	}

	private async onFileDeleted(file: TAbstractFile): Promise<void> {
		if (file instanceof TFile && file.extension === "pdf") {
			this.pdfStore.markDeletedPath(
				file.path,
				this.store,
				() => this.app.vault.getFiles().filter((f) => f.extension === "pdf").map((f) => f.path),
				async (path) => {
					const found = this.app.vault.getFileByPath(path);
					if (!found || found.extension !== "pdf") return null;
					const { head, byteLength } = await readPdfHead(this.pdfHeadSource(found));
					return pdfInkIdFromHead(head, byteLength, window.crypto);
				},
				RECYCLE_GRACE_MS
			);
			return;
		}
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
	 * Look for notes whose ink ended up in two folders, and show what was
	 * found. LOOKS ONLY - see SplitInk.ts. The adapter handed to the
	 * detector carries exists, list and read and nothing else, so no code
	 * path from this command can write, rename, create or delete anything.
	 *
	 * The three outcomes are deliberately three DIFFERENT reports. "Could
	 * not look" must never render as "nothing found": a vault whose adapter
	 * will not enumerate is exactly the vault most likely to be carrying the
	 * fork, and telling its owner they are clean is the worst answer
	 * available.
	 */
	private async reportSplitInk(): Promise<void> {
		const adapter = this.app.vault.adapter;
		let report: SplitInkReport;
		try {
			report = await findSplitInk(
				{
					exists: (p) => adapter.exists(p),
					list:
						typeof adapter.list === "function" ? (p) => adapter.list(p) : undefined,
					read: (p) => adapter.read(p),
				},
				this.settings.inkFolder
			);
		} catch (err) {
			// Even a thrown scan is an "I could not look", never a clean bill.
			console.error("[handwriting] split-ink check failed", err);
			report = {
				folders: [],
				scanned: 0,
				split: [],
				identicalOnly: 0,
				unreadable: [],
				enumerable: false,
			};
		}
		const names = this.noteNamesForPages(report.split.map((p) => p.pageId));
		new DiagnosticTextModal(
			this.app,
			"Ink split across folders",
			splitInkReportText(report, names)
		).open();
		new Notice(
			!report.enumerable
				? "Handwriting: could not list this vault, so nothing was checked"
				: report.split.length === 0
					? "Handwriting: no ink is split across folders"
					: "Handwriting: ink is split across folders - nothing was changed"
		);
	}

	/**
	 * Vault paths for the notes carrying these page ids.
	 *
	 * The sweep is over every markdown file's cached frontmatter, so it runs
	 * ONLY for pages already known to be split - never once per sidecar. On
	 * a clean vault (the overwhelmingly common case) the id list is empty
	 * and this returns without touching the file list at all.
	 */
	private noteNamesForPages(pageIds: string[]): Map<string, string> {
		const out = new Map<string, string>();
		const wanted = new Set(pageIds);
		if (wanted.size === 0) return out;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const id = this.recentPageIdFor(file);
			if (id !== undefined && wanted.has(id) && !out.has(id)) out.set(id, file.path);
		}
		return out;
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

	/**
	 * This install's id: made once, kept in Obsidian's per-device local
	 * storage (never data.json, which syncs). Names the device that wrote a
	 * recovery pair, so a device reading a synced pair knows its own side.
	 */
	private installId(): string {
		const key = "handwriting-install-id";
		const known = this.app.loadLocalStorage(key) as unknown;
		if (typeof known === "string" && known.length > 0) return known;
		const id = newPageId();
		this.app.saveLocalStorage(key, id);
		return id;
	}

	/**
	 * Read a note's claimed page id out of frontmatter, or null.
	 *
	 * Lifted out of the inline host's own closure when the slides surface
	 * arrived, so the two surfaces read the id through ONE function: a note
	 * presented as slides and a note written on directly must agree about
	 * what its id is, and two copies of this predicate would be the shape of
	 * the divergence InkSurfaces.ts is about.
	 */
	private notePageId(path: string): string | null {
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
	}

	/**
	 * Atomically stamp (or discover) a note's page id. The ONE Markdown write
	 * the ink model makes, and the only one - shared by the inline surface and
	 * the slides surface so a note claimed by drawing on a slide is claimed
	 * exactly the way a note claimed by writing on it is.
	 */
	private async claimNotePageId(
		path: string,
		proposedId: string,
		guard?: { file: TFile; markdown: string; current: () => boolean }
	): Promise<{ pageId: string; futureVersion?: number; content?: string }> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) throw new Error(`Handwriting: no file at ${path}`);
		let out: { pageId: string; futureVersion?: number; content?: string } = { pageId: proposedId };
		await this.app.vault.process(file, (data) => {
			if (guard && (file !== guard.file || !guard.current() || data !== guard.markdown))
				throw new Error("This canvas changed before its page identity could be saved.");
			// A block Obsidian cannot parse: refuse rather than write an id no
			// read will ever see.
			if (this.app.metadataCache.getFileCache(file)?.frontmatter === undefined && hasFrontmatterBlock(data)) {
				throw new UnreadableFrontmatterError();
			}
			const r = claimMarkdown(data, proposedId);
			out = { pageId: r.pageId, futureVersion: r.futureVersion, content: r.content };
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
	}

	/**
	 * Start slides ink, handing it everything it needs to know about Obsidian.
	 *
	 * The surface reads the nib through this host rather than importing the
	 * inline module's getters, so `src/slides` depends on `src/ink` and
	 * `src/model` and on no CodeMirror and no Obsidian API at all. Same nib the
	 * inline surface binds per stroke: a pen of its own would be a second set
	 * of colours and widths to keep in step for no reason.
	 *
	 * The sidecar goes through the SAME PageStore as every other surface, under
	 * a writer identity of its own: a presentation is a second in-process
	 * writer, and the store cannot tell two writers apart by anything else.
	 * Note that it never writes the note's own page id - always
	 * `<pageId>.slides` - so the note surface and this one can be live on the
	 * same file at once without either overwriting the other.
	 */
	private startSlidesInk(): void {
		const writer = newPageWriter("slides");
		this.slidesWriter = writer;
		const host: SlidesInkHost = {
			mountTools: (parent, actions) => mountSlidesTools(parent, actions, this.app, id => {
				const registry = this.app as unknown as { commands?: { executeCommandById(id: string): void } };
				registry.commands?.executeCommandById(id);
			}, message => blockNotice(message)),
			candidatePaths: () => {
				const ordered: string[] = [];
				const recent = (this as HandwritingPlugin & { slidesMenuFile?: { path: string; at: number } }).slidesMenuFile;
				if (recent && Date.now() - recent.at >= 0 && Date.now() - recent.at <= RECYCLE_GRACE_MS) {
					ordered.push(recent.path);
				}
				const active = this.app.workspace.getActiveFile();
				if (active && (active.extension === "md" || isMarkdownPath(active.path))) ordered.push(active.path);
				for (const leaf of this.app.workspace.getLeavesOfType?.("markdown") ?? []) {
					const file = (leaf.view as unknown as { file?: TFile }).file;
					if (file && (file.extension === "md" || isMarkdownPath(file.path))) ordered.push(file.path);
				}
				return [...new Set(ordered)];
			},
			documents: () => {
				const docs = new Set<Document>([document]);
				this.app.workspace.iterateAllLeaves?.(leaf => docs.add(leaf.view.containerEl.ownerDocument));
				return [...docs];
			},
			onDocumentChange: cb => {
				const events = this.app.workspace as unknown as {
					on(name: string, callback: () => void): unknown;
					offref(ref: unknown): void;
				};
				if (typeof events.on !== "function") return () => {};
				const ref = events.on("handwriting-slides-documents-change", cb);
				return () => events.offref(ref);
			},
			readSource: async (path) => {
				const file = this.app.vault.getFileByPath(path);
				if (!file) return null;
				// cachedRead: this is a read for hashing, not for editing, and
				// the presentation is already showing the rendered version.
				return this.app.vault.cachedRead(file);
			},
			readPageId: (path) => this.notePageId(path),
			claimId: (path, proposedId) => this.claimNotePageId(path, proposedId),
			newPageId: () => newPageId(),
			loadSidecar: (sidecarId) => this.store.load(sidecarId),
			scheduleSidecar: (sidecarId, page) => this.store.schedule(sidecarId, page, writer),
			hasQueuedSidecar: (sidecarId) => this.store.hasQueuedWrite(sidecarId),
			saveSidecarNow: (sidecarId, page) => this.store.saveNow(sidecarId, page, writer),
			nib: () => {
				const tool = getInlineTool();
				const base = tool === "highlighter" ? HIGHLIGHTER_PEN : DEFAULT_PEN;
				return {
					tool,
					color: getInkColorHex(tool),
					width: base.baseWidth * getInkSizeMult(tool),
				};
			},
			// The same live setting the inline eraser reads and `Next eraser
			// size` steps through - so the size picked there is the size that
			// erases here too, rather than a second, silently-ignored one.
			eraserRadiusPx: () => getEraserRadiusPx(),
			// And the same whole-vs-partial rule, from the same place: the
			// eraser mode setting (`eraserMode === "stroke"`) drives both
			// surfaces, so a slide erases the way that reader's notes do.
			eraseWholeStrokes: () => getEraserWholeStrokes(),
			notify: (message) => blockNotice(message),
			buildId: this.manifest.version,
		};
		setSlidesInk(true, host);
	}

	/** The writer identity of the running slides ink, or null while it is off. */
	private slidesWriter: string | null = null;

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
		this.notePaper?.refresh();
	}

	private applyPaperTo(doc: Document, style: PaperStyle): void {
		doc.body.classList.remove(
			"handwriting-paper-lines",
			"handwriting-paper-grid",
			"handwriting-paper-dots"
		);
		const cls = paperClass(style);
		if (cls) doc.body.classList.add(cls);
	}

	/**
	 * Whether the main window and every window holding a live-reload pane are
	 * all hidden, so the tick can skip. The bare `document` is always the main
	 * window's: minimizing it used to stop live reload for notes and PDFs open
	 * in a visible popout, and the next save there moved the other device's ink
	 * into a conflict file (audit 56). The main window still counts on its own,
	 * as it always did: it holds embeds and the slides deck.
	 */
	reloadPanesHidden(mainDoc: { hidden: boolean }): boolean {
		const docs = new Set<{ hidden: boolean }>([mainDoc]);
		for (const binding of inlineReloadBindings()) {
			const doc = (binding.attachment as { ownerDocument?: Document }).ownerDocument;
			if (doc) docs.add(doc);
		}
		for (const root of this.pdfInk.keys()) if (root.ownerDocument) docs.add(root.ownerDocument);
		for (const doc of docs) if (!doc.hidden) return false;
		return true;
	}

	/**
	 * Stamp or clear `handwriting-active-page`, which is the only thing
	 * styles.css turns into a hidden status bar.
	 *
	 * THE SETTING IS READ HERE AND NOWHERE ELSE, so there is one answer to
	 * "should the bar be hidden right now" rather than one per caller. Off -
	 * the default - takes the class off whatever is on screen and returns
	 * immediately, which is also what makes flipping the toggle off in the
	 * settings tab put the bar back NOW instead of at the next note change.
	 *
	 * A method rather than the closure this used to be: `setControlValue` has
	 * to reach it, the same way it reaches `applyPaper` and `applyBooxMode`.
	 */
	applyStatusBarVisibility(): void {
		if (!this.settings.hideStatusBarOnInkedNotes) {
			document.body.classList.remove("handwriting-active-page");
			return;
		}
		// Only the main window has a status bar, and `document` is the main
		// window's, so the main window's note decides: the active file follows
		// focus into a popout, and a popout's note used to hide or show the
		// main window's bar (audit 182). The most recent leaf in the root split
		// is the main window's note. A workspace with no root split (the
		// stand-ins in the status bar tests) keeps the active file.
		const ws = this.app.workspace;
		const mainLeaf = ws.rootSplit ? ws.getMostRecentLeaf(ws.rootSplit) : null;
		const file = ws.rootSplit ? (mainLeaf?.view as { file?: TFile | null } | undefined)?.file ?? null : ws.getActiveFile();
		const path = file && file.extension === "md" ? file.path : null;
		// Keyed on whether the note HAS STROKES, not on its page id: ids are
		// permanent, so a note whose ink was all deleted kept the bar hidden for
		// good. "unknown" (an id, sidecar not read yet) leaves the bar as it is
		// until the read lands, then this runs again and settles it, so neither
		// an emptied note nor an inked one flickers the bar on the way in.
		const presence = path ? inlineInk.inkPresence(path) : "none";
		if (presence !== "unknown") document.body.classList.toggle("handwriting-active-page", presence === "ink");
		// ONE READ PER TRIGGER. The pass the read's completion runs finds the read
		// still marked, so it settles the bar from what the read found and starts
		// no read of its own: a sidecar that stays unreadable stays "unknown", and
		// reading again from here reread it without bound. A still-unknown note
		// waits for the next outside trigger (a leaf change, an ink event, the
		// setting); a trigger while the read is in flight adds no second read.
		if (path && presence === "unknown" && this.statusBarReadFor !== path) {
			this.statusBarReadFor = path;
			void inlineInk
				.ensureLoaded(path)
				.then(() => {
					if (!this.unloaded && this.app.workspace.getActiveFile()?.path === path) this.applyStatusBarVisibility();
				})
				.finally(() => {
					if (this.statusBarReadFor === path) this.statusBarReadFor = null;
				});
		}
	}

	/** An ink-folder move is running or about to: from the first step of changeInkFolder, before the store holds writes. */
	private inkFolderMoveInFlight = false;

	/** Whether the settings row must keep its Turn on / Turn off button disabled. */
	inkFolderMoving(): boolean {
		return this.inkFolderMoveInFlight || this.store.movingFolder;
	}

	/**
	 * Point the ink at a different folder, moving what is already there.
	 *
	 * Order matters: settle pending writes, MOVE the files, then repoint the
	 * store, then persist. Repointing first would send reads to a folder the
	 * files have not reached; moving without settling could race a debounced
	 * write into the folder being emptied.
	 *
	 * HOW MUCH AN INTERRUPTION COSTS, corrected 2026-09-05 - the sentence
	 * here used to promise that it cost nothing, and named a `readPath` that
	 * has not existed for some time. The truth is narrower and depends on
	 * where the ink was going. Between the TWO WELL-KNOWN folders, an
	 * interruption anywhere still leaves every page readable, because
	 * resolution searches both. To a CUSTOM folder it does not: resolution
	 * searches the configured folder and the two well-known ones, so if the
	 * files reach `assets/ink` and the settings save never lands, the next
	 * launch is still configured for the old folder, finds nothing, and shows
	 * empty pages. NOTHING IS LOST - the sidecars are sitting in the folder
	 * the move put them in - and setting the folder to that destination in
	 * Settings brings every page back. See `changeFolder` (InkFolder.ts) for
	 * the same statement beside the code that does the moving.
	 */
	async changeInkFolder(raw: string): Promise<void> {
		const next = normalizeInkFolder(raw);
		// Set BEFORE the first await and cleared however the move ends: until the move holds writes, the
		// store does not report it, and a settings row rebuilt in that span offered a second move.
		this.inkFolderMoveInFlight = true;
		let outcome: Awaited<ReturnType<typeof changeFolder>>;
		try {
			outcome = await changeFolder(
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
					// Settling drains the queue ONCE. The move that follows spans a
					// list plus a rename per file with the store still pointed at
					// the old folder, so a stroke landing in that window used to
					// recreate the sidecar in the folder being emptied - and the
					// repoint then made the older migrated copy the one that loads.
					// Held writes requeue and land in the DESTINATION instead.
					holdWrites: () => this.store.holdWrites(),
					releaseWrites: () => this.store.releaseWrites(),
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
		} finally {
			this.inkFolderMoveInFlight = false;
		}
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
				(inkFolderSyncs(next) ? ` ${SYNC_ALL_TYPES_HINT}` : " This folder is hidden and will not sync.")
		);
	}

	private async loadSettings(): Promise<void> {
		// A file that is missing reads as null; one that exists but could not be
		// read or parsed (locked, truncated, not JSON) reads as undefined. Built
		// on as if empty, that became defaults, and the next automatic save put
		// the defaults over the user's settings. Read again a few times first;
		// if it still fails, run on defaults and write nothing (see
		// settingsReadFailed).
		let raw = (await this.loadData()) as Partial<HandwritingSettings> | null | undefined;
		for (let attempt = 0; raw === undefined && attempt < 3; attempt++) {
			await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
			raw = (await this.loadData()) as Partial<HandwritingSettings> | null | undefined;
		}
		this.settingsReadFailed = raw === undefined;
		if (this.settingsReadFailed) {
			new Notice(
				"Handwriting could not read its settings file, so it is using default settings for now and is not writing the file. Changes made now are saved once the file can be read again. Restart the app to try again.",
				15000
			);
		}
		// No settings file at all means nobody has ever run this plugin here.
		// An update always leaves one behind, so this - not a missing
		// lastSeenVersion - is what tells a new user from an updating one.
		this.freshInstall = raw === null;
		// EVERY KEY THIS BUILD DOES NOT KNOW RIDES THROUGH (auditor, 1.4.12).
		// The literal below is the WHOLE object `persistSettings` writes -
		// `saveData(this.settings)`, not a merge - so a key the literal does
		// not mention was not merely unread here, it was ERASED from data.json
		// by the first save of anything. A vault synced between a newer build
		// and this one, or between two parallel branches, lost the other
		// build's settings that way: the older build silently reset them.
		//
		// So the raw file is spread FIRST and every key this build does know
		// is written OVER it below. That order is the whole guarantee: a raw
		// value can never shadow a normalised one, so each known key keeps
		// exactly the normalisation it has here, and only keys with no line
		// below survive from `raw` untouched.
		//
		// Guarded, because `loadData` returns whatever the file parsed to. A
		// missing file (null), an array or a bare primitive is not a settings
		// object and carries nothing forward - spreading a string would spill
		// its characters in under numeric keys.
		this.settings = this.settingsFrom(raw);
		this.settingsBaseline = this.settingsSnapshot(this.settings);
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
		// An unreadable file has lost the choice for this session just as a
		// missing one has, so the folder is looked up the same way (a read).
		if (this.freshInstall || this.settingsReadFailed) {
			this.settings.inkFolder = await adoptInkFolder(this.app.vault.adapter);
		}
		// With the file unreadable, what was just looked up is not a change the
		// user made: a later clean read must not treat it as one and write it
		// over the choice the file holds.
		if (this.settingsReadFailed) this.settingsBaseline = this.settingsSnapshot(this.settings);
		// THE PEN LATCH, RESTORED, and restored HERE - inside the awaited
		// `loadSettings`, which `onload` awaits before
		// `registerEditorExtension(inkOverlayExtension())`. That ordering is
		// the whole feature: `ButtonSpec.shownOn` is read ONCE per strip, so a
		// restore that arrived after the first strip was built would leave a
		// pen device without its Keyboard button until something else happened
		// to rebuild the strip - exactly the defect the persistence is for.
		//
		// `restorePenHardwareEverSeenFromStore`, deliberately NOT
		// `markPenHardwareSeen`: a load is not a contact. It sets the latch
		// alone, leaving the present-tense flags (`penHardware`, `penSeen`)
		// untouched and firing no first-contact announcement. PenToolsMode.ts
		// spells out why each of those matters.
		//
		// It reads the DEVICE's local store, not `this.settings`: the latch
		// left data.json on 2026-09-05 because that file syncs. A synced
		// `penHardwareEverSeen: true` from another machine is ignored here.
		restorePenHardwareEverSeenFromStore();
		// Every setting a module reads at runtime, pushed in before any surface
		// builds its first strip (see applyRuntimeSettings).
		this.applyRuntimeSettings();
		// The store is constructed before settings are read, so it starts on
		// the default folder and is pointed at the real one here - before any
		// note is opened, so nothing ever reads from the wrong place.
		// The desired folder can sync before this device starts. Merely
		// repointing then leaves its existing hidden ink pinned by fallback,
		// while the settings button already says compatibility is enabled.
		// Reconcile that explicit saved choice before any surface is opened.
		// Never overwrite collisions; retire the source as recovery data so a
		// later startup cannot republish it after a synced removal. Genuine
		// failures and newly arrived source files remain retryable.
		if (!this.freshInstall && this.settings.inkFolder === SYNCED_INK_FOLDER) {
			this.store.holdWrites();
			try {
				const result = await migrateInkFolder(this.app.vault.adapter, DEFAULT_INK_FOLDER, SYNCED_INK_FOLDER, { preserveCollisions: true });
				if (result.preserved) {
					new Notice("Handwriting: conflicting ink was kept in recovery files in the sync folder.");
				}
				if (result.unsupported || result.skipped > 0) {
					new Notice("Handwriting: some existing ink could not be moved to the sync folder. The original files were kept.");
				}
			} catch (err) {
				console.error("[handwriting] existing ink could not be moved to the sync folder", err);
				new Notice("Handwriting: existing ink could not be moved to the sync folder. The original files were kept. Reload Handwriting to retry.");
			} finally {
				this.store.useInkFolder(this.settings.inkFolder);
				this.store.releaseWrites();
			}
		} else {
			this.store.useInkFolder(this.settings.inkFolder);
		}
		// The strip's eraser slider persists through here on release.
		setPersistEraserRadius((px) => {
			this.settings.eraserRadiusPx = px;
			runDetached(this.persistSettings(), "save the eraser size");
		});
		setPersistEraserMode((on) => {
			this.settings.eraserMode = on ? "stroke" : "reticle";
			runDetached(this.persistSettings(), "save the eraser mode");
		});
		// Drag-to-anchor's half of the placement (1.4.12). The strip can move
		// itself now, so the setting has a writer that is not the settings
		// tab, and `applyToolbarPlacement` calls this one for BOTH of them -
		// the dropdown included, which is why its case in `setControlValue`
		// no longer writes the field itself.
		setPersistToolbarCorner((corner) => {
			this.settings.toolbarCorner = corner;
			runDetached(this.persistSettings(), "save the toolbar placement");
		});
		// No writer for mouse ink beside these four, and its absence is the
		// rule rather than an omission: a quiet arm is for this session only
		// (alan, 2026-09-04) and the one place that DOES write it - the
		// mouse-ink toggle command; the settings switch went in 1.4.20 -
		// writes `settings.mouseInk` itself. See MouseInk.ts.
		setPersistInkColor((tool, hex) => {
			this.settings.inkColors[tool] = hex;
			runDetached(this.persistSettings(), "save the ink color");
		});
		setPersistInkSize((tool, mult) => {
			this.settings.inkSizes[tool] = clampInkSize(mult);
			runDetached(this.persistSettings(), "save the ink size");
		});
		// The pen latch's writer. NOT data.json any more: it writes this
		// DEVICE's local store, because the file syncs and the fact does not
		// travel (see `setPenHardwareStore` in `onload`).
		//
		// Reached from a `setTimeout(0)` that PenToolsMode schedules on the
		// first pen contact this device ever makes, never from the pen-down
		// itself - see `schedulePersistPenHardwareSeen` there. Registered
		// during `loadSettings`, which `onload` awaits before any surface
		// exists, so no contact can arrive before this seam is filled.
		//
		// No early return and no Notice, and neither is an omission. The write
		// is a synchronous local-store save rather than a vault file, so there
		// is nothing to await, nothing to conflict with, and nothing a reader
		// could act on if it failed. The once-per-session guard that the early
		// return used to provide lives where it always really lived: a device
		// already latched by the restore never reaches here, because
		// `schedulePersistPenHardwareSeen` fires on the false-to-true edge
		// only.
		setPersistPenHardwareSeen(persistPenHardwareSeenToStore);
		// The pdf store writes through the same PageStore as notes: same
		// debounce, same conflict guard, same trash, same ink folder. Only the
		// id shape and the surface tag differ.
		this.pdfStore.attachHost({
			load: (id, options) => this.store.load(id, options),
			schedule: (id, data) => this.store.schedule(id, data),
			notice: (message) => void new Notice(message),
			prepareExternalAdoption: (id, outgoing) =>
				this.store.prepareExternalAdoption(id, outgoing, "pdf"),
			acceptExternalAdoption: (prepared) => this.store.acceptExternalAdoption(prepared),
		});
		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) return;
			this.applyPaper(this.settings.paperStyle);
		});
		// Quick pens: the three actions the chips call. The bodies live in
		// InkPresetHost.ts (design §4); all this owns is the settings copy and
		// the save. The list itself goes in with the other runtime settings.
		installInkPresetActions({
			list: () => this.settings.penPresets,
			save: (next) => {
				this.settings.penPresets = [...next];
				runDetached(this.persistSettings(), "save the ink presets");
			},
		});
		// Pushed in ONCE, here, and deliberately not again from the settings
		// toggle: the `devDiagnostics` row promises "Takes effect after the
		// plugin reloads", so a live read would break its own promise. See
		// RoutineNotices.ts.
		setRoutineNoticesVisible(this.settings.devDiagnostics);
	}

	/**
	 * The settings object for a raw data.json value, normalised. Pure: it reads
	 * nothing but `raw` and changes nothing.
	 */
	private settingsFrom(raw: Partial<HandwritingSettings> | null | undefined): HandwritingSettings {
		const carried = raw !== null && raw !== undefined && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
		return {
			...carried,
			// The retired canvas page's named views: carried through untouched, so an older build still finds them.
			savedViews: Array.isArray(raw?.savedViews) ? raw.savedViews : [],
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
			//
			// 1.4.20 pinned this to `true` and the tab lost the row, so a vault
			// that had chosen off redrew every saved stroke under the pressure
			// law - up to 3.2 times wider on firm samples, reported as ink that
			// had become illegible. The stored value is read again, and the row
			// is back, because 1.4.20 also rewrote a stored `false` to `true` on
			// the next save: for those vaults the row is the only way back.
			pressureSensitivity: pressureChoiceFrom(raw),
			pressureChoice: pressureChoiceFrom(raw),
			// Its own key, deliberately not the legacy `inkShaping` one: that
			// key belonged to the pressure toggle it was renamed into, and
			// reading it here would make one old choice silently set a
			// different thing.
			inkSmoothing: raw?.inkSmoothing !== false,
			// `=== true`, NOT `!== false`: a vault with no stored value must come
			// back OFF to match the default above. `!== false` reads absence as
			// ON, which is how this shipped on by default.
			inkAdaptsToTheme: raw?.inkAdaptsToTheme === true,
			// `!== false`, NOT `=== true`: this one ships ON, so a vault with no
			// stored value must come back ON to match its default. The line above
			// is the same decision with the opposite sign, and the pair is why
			// both spellings appear in this object rather than one house style.
			inkReadableInExports: raw?.inkReadableInExports !== false,
			// An ENUM, so the boolean trap above becomes a different one: the
			// check is "anything I do not recognise is the default", which
			// covers the absent key AND a value from a newer version or a
			// hand-edited config. `normalizePdfPageAssumption` owns that
			// single answer so it cannot drift from the type.
			inkPdfColorMode: normalizePdfPageAssumption(raw?.inkPdfColorMode),
			pageOwners:
				raw?.pageOwners && typeof raw.pageOwners === "object" ? raw.pageOwners : {},
			eraserRadiusPx: clampEraserRadius(raw?.eraserRadiusPx ?? DEFAULT_ERASER_RADIUS_PX),
			mouseInk: raw?.mouseInk === true,
			strokePrediction: raw?.strokePrediction !== false,
			booxMode: raw?.booxMode === true,
			einkHintOffered: raw?.einkHintOffered === true,
			scribbleHintOffered: raw?.scribbleHintOffered === true,
			paperStyle: normalizePaperStyle(raw?.paperStyle),
			extendCanvasWhileScrolling: raw?.extendCanvasWhileScrolling === true,
			// `=== true`, NOT `!== false`: this ships OFF, so a vault that has
			// never stored the key - every vault that ever ran 1.4.19, where the
			// hiding was unconditional - must come back with the status bar
			// VISIBLE. Reading absence as on would re-ship the defect.
			hideStatusBarOnInkedNotes: raw?.hideStatusBarOnInkedNotes === true,
			penTools: normalizePenToolsMode(raw?.penTools),
			noteZoomControls: normalizeNoteZoomControlsMode(raw?.noteZoomControls),
			barsRestore: normalizeBarsRestore(raw?.barsRestore),
			// A fresh key on purpose: the old boolean keys carried the OLD
			// default in every data.json (full-object saves), so reading
			// them pinned the whole fleet to reticle and the stroke default
			// reached nobody. Reticle is chosen from here on, never inherited.
			eraserMode: raw?.eraserMode === "reticle" ? "reticle" : "stroke",
			penReticle: raw?.penReticle !== false,
			shapeSnap: raw?.shapeSnap !== false,
			devDiagnostics: raw?.devDiagnostics === true,
			// `!== false`, so a vault that has never heard of slides ink - and
			// every vault written by a build without it - gets the feature.
			// The old `slidesInkProbe` key is deliberately not read: it carried
			// the PROTOTYPE's off-by-default, and inheriting it would leave
			// slides ink dark on every machine that ever ran the probe.
			slidesInk: raw?.slidesInk !== false,
			colorSizeCommands: raw?.colorSizeCommands === true,
			// Not trusted a byte: `normalizeInkPresets` drops entries it
			// cannot read, clamps the two fields that have real fallbacks,
			// and caps each tool at its four slots.
			penPresets: normalizeInkPresets(raw?.penPresets),
			// There is deliberately no `penHardwareEverSeen` here any more. The
			// pen latch is a fact about a DEVICE and data.json syncs, so it
			// moved to this device's local store (`setPenHardwareStore` in
			// `onload`) on 2026-09-05: a Surface's pen was teaching a
			// mouse-only desktop that it had one. An old data.json that still
			// carries `penHardwareEverSeen: true` is IGNORED here - it may be
			// another machine's.
			//
			// IGNORED IS NOT DELETED, and since the `...carried` spread at the
			// top of this literal that distinction is real on disk too: the
			// key rides through from `raw` untouched and `persistSettings()`
			// writes it straight back, so this device's next save PRESERVES
			// it. That is what the spread is for - a machine still running a
			// build that DOES read the old key keeps its latch when this build
			// saves the file, instead of having it dropped by a build that
			// never wanted it. (Earlier drafts of this comment said the
			// opposite, correctly for the code as it then stood: the literal
			// was built field-by-field with nothing carried through, so the
			// next save of anything overwrote data.json with an object that
			// never had the key.)
			//
			// Carrying it costs this device nothing, because nothing here
			// reads it back: the local store is the only source
			// `restorePenHardwareEverSeenFromStore` trusts, and no other
			// reader of the key exists in this build.
			toolbarCorner: normalizeToolbarCorner(raw?.toolbarCorner),
			// Not trusted a byte, and it cannot be: a fold order is the one
			// setting whose value names buttons, so a file from another build
			// can name one this build does not have or miss one it does.
			stripFoldOrder: normalizeFoldOrder(raw?.stripFoldOrder),
			inkFolder: normalizeInkFolder(raw?.inkFolder),
			lastSeenVersion: typeof raw?.lastSeenVersion === "string" ? raw.lastSeenVersion : null,
		};
	}

	/** A deep copy of settings, for comparing against later. */
	private settingsSnapshot(settings: HandwritingSettings): Record<string, unknown> {
		return JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
	}

	/**
	 * Push the settings into the modules that read them at runtime. Called at
	 * load, before any surface builds its first strip, and again when another
	 * device's settings arrive, so the two can never apply different lists.
	 */
	private applyRuntimeSettings(): void {
		setPenToolsMode(this.settings.penTools);
		setNoteZoomControlsMode(this.settings.noteZoomControls);
		setToolbarCorner(this.settings.toolbarCorner);
		// Beside the corner, and for the same reason: both are strip facts the
		// settings own, and both must be in place before a surface builds its
		// first strip - a fold order applied after the fact would leave the
		// first pane of the session folding in the default order.
		setStripFoldOrder(this.settings.stripFoldOrder);
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
		setScrollExpansionEnabled(this.settings.extendCanvasWhileScrolling);
		// The zoom bar answers to Infinite Canvas as well as to
		// its own row. The strip cannot read the setting (it does not import
		// InkOverlay), so this file tells it, here at load and again at every
		// flip of the row - the two call sites MobileTools.test.ts pins.
		setZoomBarCanvasEnabled(this.settings.extendCanvasWhileScrolling);
		setInkSizeMult("pen", this.settings.inkSizes.pen);
		setInkSizeMult("highlighter", this.settings.inkSizes.highlighter);
		setInkPresets(this.settings.penPresets);
		setPressureSensitivity(this.settings.pressureSensitivity);
		setInkThemeAdaptation(this.settings.inkAdaptsToTheme);
		setInkExportReadability(this.settings.inkReadableInExports);
		// Compatibility call retained for callers from the former cached-theme
		// implementation; `refreshInkTheme` is now a no-op.
		refreshInkTheme(document);
		this.applyBooxMode();
		setInkColorHex("pen", this.settings.inkColors.pen);
		setInkColorHex("highlighter", this.settings.inkColors.highlighter);
		setEraserRadiusPx(this.settings.eraserRadiusPx);
		setEraserWholeStrokes(this.settings.eraserMode === "stroke");
		setShapeSnap(this.settings.shapeSnap);
	}

	/**
	 * THE SETTINGS FILE CHANGED ON DISK, usually because another device's save
	 * synced in. Obsidian calls this only if the plugin defines it; without it
	 * the file was read once, and this device's next save - often an automatic
	 * one - wrote its stale copy back over the other device's change.
	 *
	 * The file's values are taken for every key this device has not changed
	 * since it last read or wrote the file; its own changes are kept and then
	 * saved. A file that cannot be read now changes nothing.
	 */
	async onExternalSettingsChange(): Promise<void> {
		const fresh = (await this.loadData()) as Partial<HandwritingSettings> | null | undefined;
		if (fresh === undefined || fresh === null) return;
		// A clean read: the file is readable again, so saving is safe again.
		this.settingsReadFailed = false;
		const folderBefore = this.settings.inkFolder;
		const { merged, localChanges } = this.mergeSettings(fresh);
		Object.assign(this.settings, merged);
		this.settingsBaseline = this.settingsSnapshot(this.settingsFrom(fresh));
		this.applyRuntimeSettings();
		this.applyPaper(this.settings.paperStyle);
		if (this.settings.inkFolder !== folderBefore) this.store.useInkFolder(this.settings.inkFolder);
		if (localChanges) this.saveSettingsNow();
	}

	/**
	 * This device's changes laid over the file's current contents: every key
	 * whose in-memory value differs from `settingsBaseline` is this device's;
	 * every other key is the file's. A setting that is itself a map merges one
	 * level down the same way: the file's entries kept, except where this
	 * device added, changed or removed one.
	 */
	private mergeSettings(fresh: Partial<HandwritingSettings> | null | undefined): {
		merged: HandwritingSettings;
		localChanges: boolean;
	} {
		const disk = this.settingsFrom(fresh) as unknown as Record<string, unknown>;
		const base = this.settingsBaseline;
		const mine = this.settings as unknown as Record<string, unknown>;
		const out: Record<string, unknown> = { ...disk };
		let localChanges = false;
		const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
		for (const key of Object.keys(mine)) {
			if (same(mine[key], base[key])) continue;
			localChanges = true;
			const ours = mine[key];
			const theirs = disk[key];
			// A setting that is itself a map (colours per tool, sizes per tool,
			// page owners, saved cameras) merges entry by entry, so two devices
			// changing different entries both keep theirs. Arrays and plain
			// values are one setting and go whole.
			if (isPlainObject(ours) && isPlainObject(theirs)) {
				const was = isPlainObject(base[key]) ? base[key] : {};
				const entries: Record<string, unknown> = { ...theirs };
				for (const inner of new Set([...Object.keys(was), ...Object.keys(ours)])) {
					if (same(ours[inner], was[inner])) continue;
					if (inner in ours) entries[inner] = ours[inner];
					else delete entries[inner];
				}
				out[key] = entries;
			} else {
				out[key] = ours;
			}
		}
		return { merged: out as unknown as HandwritingSettings, localChanges };
	}

	/**
	 * The mode `applyBooxMode` last actually applied, so a real transition can
	 * be told from a reapplication. Undefined until the first call - field
	 * initialisers do not run for the `Object.create` instances the tests use -
	 * and that first call counts as a change, so a session starts with no
	 * pending hint evidence.
	 */
	private booxModeApplied: boolean | undefined;

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
		// A mode CHANGE invalidates hint evidence in both directions, and it is
		// cleared HERE rather than at the next tick because a user can toggle on
		// and off entirely between two ten-second checks: samples taken while
		// e-ink mode was on describe a different render path, and a partial run
		// from before the change describes a machine since reconfigured.
		// Reapplying the SAME mode - which the settings tab does for the toggles
		// next to this one - changes nothing and must not throw away a valid run.
		// The offer latch is never cleared here: told once is once.
		if (this.booxModeApplied !== on) {
			this.booxModeApplied = on;
			discardHintSamples();
			resetEinkHintProgress();
		}
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

	/**
	 * The gated ids that are in the palette right now.
	 *
	 * Derived rather than tallied, because the two halves are complements and
	 * the module already keeps one of them: every gated command is registered
	 * OR holds a strip fallback, so "registered" is the table minus the filed
	 * ones. `addGatedCommand` leaves load in exactly that state and
	 * `planGatedCommands` preserves it, which is what makes one stored set
	 * enough for both. CommandPaletteSplit.test.ts pins the assumption
	 * underneath it ("gives every gated command a callback"): a gated command
	 * with no `callback` could be filed nowhere, and would be miscounted here
	 * as registered.
	 */
	private registeredGatedCommandIds(): string[] {
		const mirrored = new Set(gatedCommandActionIds());
		return [...this.gatedCommandDefs.keys()].filter((id) => !mirrored.has(id));
	}

	/** The app's command registry, if this Obsidian exposes one. */
	private appCommandRegistry(): { removeCommand?(id: string): void } | undefined {
		return (this.app as unknown as { commands?: { removeCommand?(id: string): void } }).commands;
	}

	/**
	 * Whether "Extra commands for hotkeys" can be turned OFF without a reload.
	 *
	 * Turning it ON never needs anything but `addCommand`. Turning it off needs
	 * un-registration, and that is the half worth checking for: `removeCommand`
	 * is on `Plugin` in obsidian.d.ts (since 1.7.2, below this plugin's
	 * minAppVersion) but is reached through a `typeof` guard anyway, because a
	 * type declaration is a claim about the API, not about the app someone is
	 * running. Where neither route exists the row keeps its reload sentence and
	 * the plan leaves the palette alone - see `planGatedCommands`.
	 */
	gatedCommandRemovalAvailable(): boolean {
		if (typeof this.removeCommand === "function") return true;
		return typeof this.appCommandRegistry()?.removeCommand === "function";
	}

	/**
	 * Take one gated command out of the palette.
	 *
	 * Two spellings, because the id form is the undocumented part. `addCommand`
	 * is handed the BARE id and prefixes it, so `Plugin.removeCommand` - its
	 * counterpart - is given the bare id; the app's own registry is keyed by the
	 * prefixed id, the form `executeCommandById` is called with everywhere in
	 * this plugin. Whichever is the real route, the other names a command that
	 * is not registered, and removing one of those is a no-op rather than an
	 * error. Cheaper than being wrong: a command left in the palette while its
	 * action was filed for the strip is the one state the split forbids.
	 */
	private removeGatedCommand(id: string): void {
		if (typeof this.removeCommand === "function") this.removeCommand(id);
		const registry = this.appCommandRegistry();
		if (typeof registry?.removeCommand === "function") {
			registry.removeCommand(`${this.manifest.id}:${id}`);
		}
	}

	/**
	 * Move the gated commands to wherever the switch now points, live.
	 *
	 * The decision is `planGatedCommands`, which is pure and tested; this is the
	 * executor and holds no rules of its own. ADDS BEFORE DROPS, both ways
	 * round: the new route is in place before the old one goes, so a strip
	 * button pressed between two of these loops still finds an answer, and the
	 * worst a half-applied flip can do is hold both routes for the length of a
	 * synchronous call rather than neither.
	 *
	 * Hotkeys survive it. Obsidian keys a custom hotkey by command id, not by
	 * the command object, so a key bound to `handwriting:inline-tool-eraser`
	 * finds it again when the same id is registered a second time.
	 */
	applyGatedCommandRegistration(): void {
		const plan = planGatedCommands({
			registered: this.registeredGatedCommandIds(),
			mirrored: gatedCommandActionIds(),
			want: this.settings.colorSizeCommands,
			canRemove: this.gatedCommandRemovalAvailable(),
			ids: this.gatedCommandDefs.keys(),
		});
		for (const id of plan.toRegister) {
			const cmd = this.gatedCommandDefs.get(id);
			if (!cmd) continue;
			// A fresh object every time, for the reason `addGatedCommand` copies
			// the definition in the first place.
			const fresh: Command = { ...cmd };
			this.addCommand(fresh);
		}
		for (const id of plan.toMirror) {
			const run = this.gatedCommandDefs.get(id)?.callback;
			if (run) setGatedCommandAction(id, run);
		}
		for (const id of plan.toUnmirror) clearGatedCommandAction(id);
		for (const id of plan.toRemove) this.removeGatedCommand(id);
	}

	/**
	 * Apple Scribble can claim Pencil input over an ordinary editable note.
	 * There is no web-side fix for that platform feature, so this is a one-time
	 * warning, not a claim that Handwriting changed Scribble's behaviour.
	 *
	 * Obsidian's host flags are the gate: iOS AND tablet means its iPad app.
	 * The conjunction excludes iPhone, Android/e-ink tablets, and desktop
	 * hosts without guessing from a user agent.
	 */
	private showScribbleHintIfDue(): void {
		if (!Platform.isIosApp || !Platform.isTablet || this.settings.scribbleHintOffered) {
			return;
		}
		blockNotice(
			`IPAD USERS ONLY

if you are seeing black ink 'lift' up off the page and ink is disappearing

turn off scribble > iPad settings > Apple pencil > scribble toggle off

- alan :)`,
			0
		);
		// Burn the once-per-vault latch only after Notice construction returns.
		// If the toast never appeared, this session has not spent its one chance.
		this.settings.scribbleHintOffered = true;
		this.saveSettingsNow();
	}

	/**
	 * Discovery for a setting that already exists: `booxMode` is tuned
	 * against a real e-ink device, but nothing ever told a writer on a slow
	 * machine it was there. Polled rather than driven off the ink path
	 * itself, because the ink path is exactly what must not gain a single
	 * branch for this - see EinkHint.ts for the state machine and
	 * Prediction.ts:96-101 for why the caps themselves stay put.
	 *
	 * Two early-outs before the state machine is even asked: Boox mode
	 * already on means there is nothing to discover, and the latch already
	 * true means this vault has already been told.
	 *
	 * rAF sample age is a symptom, not a diagnosis: it cannot tell an e-ink
	 * panel from a slow machine, a background tab or a one-off stall that
	 * outlasted the freshness window. That is why the notice below leads
	 * with a CONDITION the reader checks for themselves rather than with a
	 * claim about their hardware: anyone it does not apply to stops at the
	 * first line. The wording, the block layout and the sticky duration are
	 * Alan's - see the comment at the Notice itself before changing any of
	 * them.
	 */
	private checkEinkHint(): void {
		// Every tick SPENDS the pending batch, whatever else happens to it.
		// Evidence left behind would age into the next interval and stop that
		// batch being disjoint, which is the defect this replaced: a check's
		// reading has to be about the interval that just ended and nothing else.
		if (this.settings.booxMode) {
			discardHintSamples();
			resetEinkHintProgress();
			return;
		}
		if (this.settings.einkHintOffered) {
			discardHintSamples();
			return;
		}
		if (!noteLag(consumeHintLagMs())) return;
		// STAYS UNTIL DISMISSED (alan, 1.4.13: "sticky toast it is").
		// This is a ONE-LAUNCH TOAST and the flag below burns it for the life
		// of the vault, so a timed toast missed once is gone forever - and the
		// whole point is telling someone who has never heard of Boox mode that
		// it exists. 15 s of a writer's attention while their pen is down is
		// not a fair bet against never saying it again. Sticky also survives
		// being stacked under the what's-new toast, which is the other
		// one-launch toast this plugin shows.
		//
		// Sticky and not a modal, which is what this looked like it would be:
		// the audience is BY CONSTRUCTION on slow-refreshing e-ink hardware -
		// that is what `noteLag` just measured - so a modal would force the
		// largest possible repaint on the one display whose repaint latency
		// prompted the message, and interrupt a stroke to do it. A toast
		// never blocks the hand and costs a fraction of that.
		// ALAN'S WORDING, VERBATIM (1.4.13), and the layout is his too - three
		// blocks, the condition first. That order is load-bearing rather than
		// styling: the gate below is measured SLOWNESS, not e-ink hardware
		// (there is no device detection anywhere in this path), so a fast-
		// enough machine having a bad run reaches this too. Leading with "IF
		// YOU ARE ON BOOX" lets everyone it does not apply to dismiss it
		// without reading further.
		//
		// A fragment rather than a "\n"-joined string: `Notice` sets text, and
		// newlines in text do not become line breaks without a white-space
		// rule we do not own. Three `div`s render the three blocks whatever
		// the theme does. Same `createFragment` idiom as `renderSupport`.
		new Notice(
			createFragment((f) => {
				f.createDiv({ text: "IF YOU ARE ON BOOX" });
				f.createDiv({ text: "try the boox toggle in handwriting settings" });
				f.createDiv({ text: "-alan :)" });
			}),
			0
		);
		// BURNED ONLY ONCE THE TOAST EXISTS, not before. This is the trap the
		// plugin already met once - "showWhatsNewIfDue would have spent the
		// one-launch toast on a session nobody saw" (see `unloaded`,
		// 1.4.6-design.md 5k/AD6). Writing and persisting the flag first meant
		// a `Notice` that threw, or a teardown between the two, spent the one
		// chance on a toast that never rendered. Nothing between the
		// construction above and this line can fail, so ordering it after is
		// free.
		this.settings.einkHintOffered = true;
		this.saveSettingsNow();
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
	private persistSettings(onHide = false): Promise<void> {
		if (this.settingsTimer !== null) {
			window.clearTimeout(this.settingsTimer);
			this.settingsTimer = null;
		}
		this.settingsDirty = false;
		// The file could not be read at launch: write nothing (settingsReadFailed).
		if (this.settingsReadFailed) return Promise.resolve();
		if (this.settingsWriting) {
			this.settingsWriteAgain = true;
			return this.settingsWriting;
		}
		// WHAT IS WRITTEN is this device's changes over the file as it is now,
		// never the whole in-memory object: another device's change that synced
		// in since the last read survives this device's save of something else.
		// On hide there is no time to read first (the freeze rule above), so the
		// changes go over the file as last read; the next ordinary save
		// reconciles.
		const payload = (fresh: Partial<HandwritingSettings> | null | undefined): HandwritingSettings => {
			const { merged } = this.mergeSettings(fresh ?? this.settingsBaseline);
			Object.assign(this.settings, merged);
			return merged;
		};
		const send = (data: HandwritingSettings): Promise<void> =>
			this.saveData(data).then(() => {
				this.settingsBaseline = this.settingsSnapshot(data);
			});
		const writeOnce = (): Promise<void> =>
			onHide
				? send(payload(undefined))
				: this.loadData().then((fresh) => send(payload(fresh as Partial<HandwritingSettings> | null | undefined)));
		const write = (): Promise<void> =>
			writeOnce().then(
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

	private async flushSettings(onHide = false): Promise<void> {
		if (this.settingsTimer !== null) {
			window.clearTimeout(this.settingsTimer);
			this.settingsTimer = null;
		}
		if (!this.settingsDirty) return;
		return this.persistSettings(onHide);
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
		private onConfirm: () => void,
		private trashDir: () => Promise<string>
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText(`Delete all ink on this ${this.noun}?`);
		const trashDir = await this.trashDir();
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
						`vault's ${trashDir} folder.`
					: `${what} will be removed from every page of this document. ` +
						"A copy of the saved ink is kept in the vault's " +
						`${trashDir} folder.`,
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
	// The mobile apps first: Obsidian sets isMacOS on iPhone and iPad too.
	if (Platform.isIosApp) return "ios";
	if (Platform.isAndroidApp) return "android";
	if (Platform.isWin) return "windows";
	if (Platform.isMacOS) return "macos";
	if (Platform.isLinux) return "linux";
	return "unknown";
}

/**
 * The stored pressure choice: `pressureChoice` when it is a boolean, else `pressureSensitivity`, else the
 * retired `inkShaping` key (a missing value is on). See `HandwritingSettings.pressureChoice`.
 */
function pressureChoiceFrom(
	raw: (Partial<HandwritingSettings> & { inkShaping?: boolean }) | null | undefined
): boolean {
	if (typeof raw?.pressureChoice === "boolean") return raw.pressureChoice;
	return raw?.pressureSensitivity ?? raw?.inkShaping !== false;
}

type SettingKey = keyof HandwritingSettings;

/** The legacy painter reads our own definition data, not newer host API objects. */
type LegacySettingControl =
	| { type: "toggle"; key: SettingKey; disabled?: boolean | (() => boolean) }
	| { type: "dropdown"; key: SettingKey; options: Readonly<Record<string, string>>; disabled?: boolean | (() => boolean) }
	| { type: "text" | "textarea" | "number" | "file" | "folder" | "slider" | "color" };

type LegacySettingItem =
	| { type: "page" }
	| { type: "group" | "list"; heading?: string; items?: readonly LegacySettingItem[] }
	| {
		name: string;
		desc?: string | DocumentFragment;
		render?: (setting: Setting, group: SettingGroup) => void | (() => void);
		control?: LegacySettingControl;
	};

const SUPPORT_LINE = "Handwriting is free. i'm still working on it almost every night.";

/** One line under "Extra commands for hotkeys": a label and its names. */
export interface GatedCommandGroup {
	/** The quiet label the line opens with. */
	readonly label: string;
	/** The ids on it, in table order. Every gated id is on exactly one line. */
	readonly ids: readonly string[];
	/** What the line prints, with the wording the label already carries taken off. */
	readonly names: readonly string[];
}

/**
 * WHICH LINE A GATED COMMAND GOES ON, from its id.
 *
 * "this is hilariously dense" (alan, 2026-09-06). The row under the switch
 * printed all forty-three names as one comma run. The list itself stays - it is
 * how anyone knows what there is to bind, and hiding it behind a disclosure
 * would leave the switch asking "which commands?" with no answer - but it reads
 * as a few short lines now, one per kind.
 *
 * FROM THE IDS, not from a second list of names. `PaletteCommand` has no kind
 * field, and adding membership by hand here would be exactly the drift
 * CommandPaletteSplit.ts exists to prevent: a colour added to `PEN_COLORS`
 * reaches this list through `gatedCommands()` and lands on the "Ink color" line
 * because its id starts that way, with nothing to update here. An id that
 * matches no rule still appears, under "Other" - a command may never fall out
 * of the list silently - and the test pins that bucket empty, so an id shape
 * nobody wrote a rule for is a red test rather than a shrug in the UI.
 *
 * ORDER MATTERS IN ONE PLACE: `ink-size-cycle` and `ink-color-cycle` both start
 * the way the per-value ids do, so the cycles are claimed first.
 */
const GATED_GROUPS: ReadonlyArray<{ label: string; holds: (id: string) => boolean }> = [
	{ label: "Tool toggles", holds: (id) => id.startsWith("inline-tool-") },
	{ label: "Cycles", holds: (id) => id.endsWith("-cycle") },
	{ label: "Ink size", holds: (id) => id.startsWith("ink-size-") },
	{ label: "Ink color", holds: (id) => id.startsWith("ink-color-") },
	{ label: "Highlighter color", holds: (id) => id.startsWith("highlighter-color-") },
	{ label: "Pen preset", holds: (id) => id.startsWith("ink-preset-pen-") },
	{ label: "Save current pen as preset", holds: (id) => id.startsWith("ink-preset-save-pen-") },
	{ label: "Highlighter preset", holds: (id) => id.startsWith("ink-preset-highlighter-") },
	{
		label: "Save current highlighter as preset",
		holds: (id) => id.startsWith("ink-preset-save-highlighter-"),
	},
];

/** Where every rule has failed. Empty in this build; see `GATED_GROUPS`. */
const GATED_OTHER = "Other";

/**
 * How many leading characters every one of these names shares, cut back so the
 * cut never lands inside a word.
 *
 * The boundary rule is the whole of it: a common prefix of "Ink color: bl"
 * across two blues is real and useless, so the count walks back to the last
 * character that is not a letter or a digit. One name shares nothing with
 * itself, so a group of one keeps its whole name.
 */
function sharedHead(names: readonly string[]): number {
	if (names.length < 2) return 0;
	const first = names[0] ?? "";
	let n = first.length;
	for (const name of names) {
		let i = 0;
		while (i < n && i < name.length && name[i] === first[i]) i++;
		n = i;
	}
	while (n > 0 && /[A-Za-z0-9]/.test(first[n - 1] ?? "")) n--;
	return n;
}

/** The same from the other end: " on / off", ": next". */
function sharedTail(names: readonly string[]): number {
	if (names.length < 2) return 0;
	const first = names[0] ?? "";
	let n = first.length;
	for (const name of names) {
		let i = 0;
		while (i < n && i < name.length && name[name.length - 1 - i] === first[first.length - 1 - i]) i++;
		n = i;
	}
	while (n > 0 && /[A-Za-z0-9]/.test(first[first.length - n] ?? "")) n--;
	return n;
}

/**
 * The names a line prints: each one with the wording the whole group shares
 * taken off, so "Ink color: blue, Ink color: black, ..." becomes a label and
 * "blue, black, ...".
 *
 * ALL OR NOTHING. If any name would come back empty - a group whose members are
 * one word apart, or one whose head and tail overlap - the full names are kept.
 * A line that is longer than it needs to be is a nuisance; a line with a blank
 * in it is a lie about what the palette holds.
 */
function trimmedNames(names: readonly string[]): string[] {
	const head = sharedHead(names);
	const tail = sharedTail(names);
	if (head + tail === 0) return [...names];
	const short = names.map((name) => name.slice(head, name.length - tail).trim());
	return short.every((name) => name.length > 0) ? short : [...names];
}

/**
 * The gated commands as lines. Pure: it takes the table, so a test can hand it
 * an id nobody has written a rule for and see where that lands.
 */
export function gatedCommandGroups(commands: readonly PaletteCommand[] = gatedCommands()): GatedCommandGroup[] {
	const buckets = new Map<string, PaletteCommand[]>();
	for (const command of commands) {
		const rule = GATED_GROUPS.find((g) => g.holds(command.id));
		const label = rule?.label ?? GATED_OTHER;
		const bucket = buckets.get(label);
		if (bucket) bucket.push(command);
		else buckets.set(label, [command]);
	}
	// The rules' order, then whatever "Other" caught, rather than the order the
	// ids happened to arrive in: the lines read tool toggles first and quick
	// pens last, which is the order the palette registers them in.
	const labels = [...GATED_GROUPS.map((g) => g.label), GATED_OTHER];
	const out: GatedCommandGroup[] = [];
	for (const label of labels) {
		const bucket = buckets.get(label);
		if (!bucket || bucket.length === 0) continue;
		out.push({
			label,
			ids: bucket.map((c) => c.id),
			names: trimmedNames(bucket.map((c) => c.name)),
		});
	}
	return out;
}

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
export class HandwritingSettingTab extends PluginSettingTab {
	/**
	 * The fold-order control, while the tab is open.
	 *
	 * Held so it can be given back. It owns a real `MobileTools` - five
	 * capturing document listeners, a resize observer and an entry in the
	 * strip registry - and a forgotten one would be re-folded forever on behalf
	 * of a settings pane that had closed.
	 */
	private foldOrder: FoldOrderControl | null = null;

	constructor(
		app: App,
		private plugin: HandwritingPlugin
	) {
		super(app, plugin);
	}

	/**
	 * The tab closed, or Obsidian moved to another one.
	 *
	 * Belt and braces with the `destroy()` at the top of `renderFoldOrder`:
	 * this is the hook that fires on the classic painter's own lifecycle, and
	 * the destroy-before-build there is what covers a renderer that draws the
	 * row again without ever calling this.
	 */
	hide(): void {
		this.foldOrder?.destroy();
		this.foldOrder = null;
	}

	getSettingDefinitions(): SettingDefinitionItem<SettingKey>[] {
		return [
			{
				name: `Version ${this.plugin.manifest.version}`,
			},
			{
				type: "group",
				heading: "Appearance",
				items: [
					{
						name: "Infinite canvas",
						desc: "Turns on Infinite canvas. Also turns on zoom bar. Default off.",
						control: { type: "toggle", key: "extendCanvasWhileScrolling" },
					},
					{
						name: "Hide status bar on handwriting notes",
						desc: "Hide Obsidian's status bar while a note with handwriting is open. It sits over the bottom edge of the writing surface and the horizontal scrollbar. Off by default; the status bar is shown as usual.",
						control: { type: "toggle", key: "hideStatusBarOnInkedNotes" },
					},
					{
						name: "Paper background",
						desc: "Lined, grid, or dotted paper. Global setting. Default none.",
						control: {
							type: "dropdown",
							key: "paperStyle",
							options: { none: "None", lines: "Lines", grid: "Grid", dots: "Dots" },
						},
					},
				],
			},
			{
				type: "group",
				heading: "Toolbar",
				items: [
					{
						name: "Toolbar visibility",
						desc: "Show or hide the toolbar. Default Auto.",
						control: {
							type: "dropdown",
							key: "penTools",
							options: { hide: "Off", show: "On", auto: "Auto" },
						},
					},
					{
						// Option labels match the Toolbar visibility row's above
						// verbatim - the two settings behave identically.
						name: "Zoom bar",
						desc: "Show or hide the zoom bar. Default Auto. Needs Infinite canvas.",
						control: {
							type: "dropdown",
							key: "noteZoomControls",
							options: { hide: "Off", show: "On", auto: "Auto" },
							// The zoom bar cannot show without the canvas, so the row
							// that decides when it shows cannot be used without it
							// either. A predicate, not a stored value: it is read at
							// render time, and `setControlValue` redraws the tab when
							// the canvas moves, so the greying follows at once.
							disabled: (): boolean => !this.plugin.settings.extendCanvasWhileScrolling,
						},
					},
					{
						name: "Toolbar placement",
						desc: "Where the toolbar sits. Default top right.",
						// "Corner" is what this row was called for two releases and
						// what the setting is still named in data.json, so it stays
						// searchable: the settings search indexes name, desc and
						// aliases and nothing else, and a rename with no alias makes
						// the old wording stop matching the row it belongs to. It is
						// also no longer strictly true - two of the six placements
						// are not corners - which is the whole reason for the rename.
						aliases: ["toolbar corner", "corner", "middle", "anchor", "position"],
						control: {
							type: "dropdown",
							key: "toolbarCorner",
							options: Object.fromEntries(TOOLBAR_CORNER_LABELS.map(({ value, label }) => [value, label])),
						},
					},
					{
						name: "Toolbar buttons",
						desc:
							"Drag to order which buttons are shown. " +
							"The bottom of the list disappears first.",
						// `render` rather than a `control`: there is no toggle or
						// dropdown shape for a reorderable list, and the two are
						// mutually exclusive on one row (obsidian.d.ts's
						// `SettingDefinitionRender`), which is the same reason
						// `renderSupport` is written this way.
						render: (setting) => this.renderFoldOrder(setting),
					},
				],
			},
			{
				type: "group",
				heading: "PDFs",
				items: [
					{
						// APPROVED BY ALAN AS WRITTEN, 2026-09-08 - "that
						// works", then "color btw american" / "not british".
						// AMERICAN SPELLING HERE ONLY: he ruled on this row,
						// not on the five other strings that still say
						// "colour", including the row directly above. Two
						// adjacent rows therefore disagree, deliberately, and
						// tidying them is a separate copy question that has
						// not been asked.
						//
						// FIVE earlier drafts died, and the first four failed
						// the same way: they explained. Two were named "Keep
						// flattened ink readable" - "wtf is this copy", then
						// "not clear, why is flattened ink unreadable,
						// question makes more questions then it answers". The
						// NAME was the fault, not the length: it asked the
						// reader a question it never answered, and "flattened"
						// is our word, not theirs.
						//
						// This one is shaped on the "Paper background" row
						// rather than invented - topic name, then a
						// description that lists the options and names the
						// default. Do not lengthen it; the option labels carry
						// the rest, and the mechanism lives in InkPdfAppend.ts
						// where it belongs.
						name: "Ink color on PDFs",
						desc: "Darken, lighten, or leave it alone. Default darken.",
						// Shipped in 1.4.18 as "Ink color when flattening PDFs".
						// Search indexes name, desc and aliases only, so the old
						// title stays findable here; see "Toolbar placement".
						aliases: ["Ink color when flattening PDFs", "flatten"],
						control: {
							type: "dropdown",
							key: "inkPdfColorMode",
							options: {
								darken: "Darken for light pages",
								lighten: "Lighten for dark pages",
								keep: "Keep original colors",
							},
						},
					},
				],
			},
			{
				type: "group",
				heading: "Export",
				items: [
					{
						name: "Ink color when exporting",
						desc: "Keep pen ink readable in exports, prints, and snips. Default automatic readability.",
						aliases: ["print", "snip", "highlighter"],
						control: {
							type: "dropdown", key: "inkReadableInExports",
							options: { auto: "Automatic readability", keep: "Keep original colors" },
						},
					},
				],
			},
			{
				type: "group",
				heading: "Latency",
				items: [
					{
						name: "Ink prediction",
						desc: "Reduce visible pen lag. Default on.",
						aliases: ["latency", "nib", "sharp corners"],
						control: {
							type: "toggle",
							key: "strokePrediction",
							disabled: () => this.plugin.settings.booxMode,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Pen",
				items: [
					{
						name: "Pressure sensitivity",
						desc: "Adjust line width with pen pressure. Default on.",
						// The ordinary control path, not 1.4.19's `render` one. That
						// row carried a Recalibrate button beside the toggle, and a
						// button can only reach a row through `render`; Recalibrate
						// has had its own Developer row since 1.4.20, so this row is
						// the toggle and nothing else.
						control: { type: "toggle", key: "pressureSensitivity" },
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
						desc: "Smooth and taper strokes. Default on.",
						aliases: ["shaping", "speed"],
						control: {
							type: "toggle",
							key: "inkSmoothing",
							disabled: () => this.plugin.settings.booxMode,
						},
					},
					{
						name: "Pen reticle",
						desc: "Show a dot at the pen tip. Default on.",
						aliases: ["cursor"],
						control: {
							type: "toggle",
							key: "penReticle",
							disabled: () => this.plugin.settings.booxMode,
						},
					},
					{
						name: "Shape snap",
						desc: "Hold at the end of a stroke to snap it into a shape. Default on.",
						control: { type: "toggle", key: "shapeSnap" },
					},
				],
			},
			{
				type: "group",
				heading: "Commands",
				items: [
					{
						name: "Extra commands for hotkeys",
						// Every name this row has carried. Settings search
						// indexes name, desc and aliases and nothing else, so a
						// rename with no alias makes the old wording match
						// nothing - and someone who updates, types what they
						// remember and finds an empty list concludes the toggle
						// was removed rather than renamed. The sync row below
						// carries six aliases for the same reason. 1.4.6's name
						// is the first entry; 1.4.11's is the last.
						aliases: [
							"A command per color and size",
							"command per color",
							"per color command",
							"Hotkeys for colors and sizes",
							"command palette",
						],
						desc:
							"Add tool, color, size, and quick pen commands for hotkeys. Default off." +
							(this.plugin.gatedCommandRemovalAvailable()
								? ""
								: " Turning it off takes effect after the plugin reloads."),
						control: { type: "toggle", key: "colorSizeCommands" },
					},
					{
						// Directly under the switch, ON OR OFF, because the
						// question the switch raises is "which commands?" and
						// a list you can only see by turning something on and
						// reloading is no answer. Rendered from the same table
						// registration reads (CommandPaletteSplit.ts), so it
						// cannot drift from what the palette actually gets.
						//
						// Its own row rather than more text on the one above:
						// `control` and `render` are mutually exclusive on a
						// single definition (obsidian.d.ts's
						// SettingDefinitionRender), and both renderers - 1.13's
						// declarative one and this file's `paint()` fallback -
						// draw a bare name+desc row the same way.
						name: "The commands it adds",
						// Out of search deliberately: the switch above owns the
						// terms, and two hits for one control reads as two
						// controls.
						searchable: false,
						// A few short labelled lines rather than one comma run
						// of forty-three names ("this is hilariously dense",
						// alan, 2026-09-06). `render` rather than `desc` for the
						// same reason the fold-order row uses it: a desc is one
						// string, and these are lines. The grouping is
						// `gatedCommandGroups`, above the class, and it still
						// reads the shared table.
						render: (setting) => this.renderGatedCommands(setting),
					},
				],
			},
			{
				type: "group",
				heading: "Storage",
				items: [
					{
						name: "Compatibility with Obsidian Sync, iCloud and Dropbox",
						desc: SYNC_ALL_TYPES_HINT,
						aliases: ["ink folder", "hidden folder", "sync", "obsidian sync", "icloud", "dropbox"],
						render: (setting) => this.renderSyncButton(setting),
					},
				],
			},
			{
				type: "group",
				heading: "Developer",
				items: [
					{
						name: "Developer diagnostics",
						desc:
							"Show diagnostic commands after reloading the plugin. Default off.",
						control: { type: "toggle", key: "devDiagnostics" },
					},
					{
						// Moved here from Latency, unchanged (1.4.20, Alan's settings
						// simplification). The rows it overrides keep their
						// `disabled` read of it wherever they sit.
						name: "Boox mode",
						desc: "Adjust pen input and animations for e-ink screens. Default off.",
						control: { type: "toggle", key: "booxMode" },
					},
					{
						// What is left of the Pen group's "Pressure sensitivity" row
						// (1.4.20, Alan: A3). The switch is gone - pressure is always
						// on, see `loadSettings` - but the button is a different
						// feature and still the only road to it: the palette's
						// "Pen pressure: recalibrate" was ruled out on 2026-09-05 in
						// favour of this button. The old row's name stays an alias
						// so settings search still lands somewhere.
						name: "Recalibrate pen pressure",
						desc: "Forget the pressure range learned on this device and relearn it from your next strokes.",
						aliases: ["pressure sensitivity", "recalibrate", "calibration"],
						render: (setting) => this.renderPressureRecalibrate(setting),
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
	 * restores the stored preference the moment the mode goes off. The rows
	 * were still reporting the STORED value, not the forced
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
		if (key === "inkReadableInExports") return this.plugin.settings.inkReadableInExports ? "auto" : "keep";
		if (this.overriddenByBoox(key)) return this.BOOX_OVERRIDES[key as SettingKey];
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
		else this.renderLegacySettings();
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
			case "extendCanvasWhileScrolling":
				s.extendCanvasWhileScrolling = on;
				setScrollExpansionEnabled(on);
				// The zoom bar's other half. The setter announces
				// to strips listening for a mode change; the push covers the
				// ones built before anyone subscribed, exactly as the fold
				// order is pushed.
				setZoomBarCanvasEnabled(on);
				refreshNoteZoomControlsAll();
				this.plugin.refreshHeaderActions();
				// The Zoom bar row is greyed out by this value, and its `disabled`
				// predicate is read at render time: without this the row keeps the
				// state it was drawn in until the tab is closed and opened again.
				this.rerender();
				break;
			case "pressureSensitivity":
				s.pressureSensitivity = on;
				s.pressureChoice = on;
				setPressureSensitivity(on);
				// Saved strokes are shaped at render time from their stored
				// samples, so the width law changes under ink already on the
				// page: every overlay has to draw again to show it.
				repaintAllInkOverlays();
				embedInkRepaintAll(); // reading view, embeds and hovers (audit 25)
				break;
			case "hideStatusBarOnInkedNotes":
				s.hideStatusBarOnInkedNotes = on;
				// Live, both ways. Turning it ON hides the bar if the note under
				// the cursor qualifies; turning it OFF hands the bar back now
				// rather than at the next leaf change, which is the half a user
				// is actually watching for when they undo a setting.
				this.plugin.applyStatusBarVisibility();
				break;
			case "strokePrediction":
				s.strokePrediction = on;
				this.plugin.applyBooxMode();
				break;
			case "inkSmoothing":
				s.inkSmoothing = on;
				this.plugin.applyBooxMode();
				repaintAllInkOverlays();
				embedInkRepaintAll();
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
				embedInkRepaintAll();
				// Two OTHER rows change what they report when this one moves.
				// `disabled` and getControlValue are both read at render time,
				// so nothing repaints them unless the tab is asked to render
				// again - and a Boox user flipping this would otherwise watch
				// two toggles keep insisting they were on.
				this.rerender();
				break;
			case "inkAdaptsToTheme":
				s.inkAdaptsToTheme = on;
				setInkThemeAdaptation(on);
				// Compatibility call retained from the former cached-theme path;
				// `refreshInkTheme` is now a no-op and the repaint reads live state.
				refreshInkTheme(document);
				repaintAllInkOverlays();
				refreshAllStrips();
				break;
			case "inkPdfColorMode":
				// Read at flatten time from `this.settings`, so there is no
				// renderer to notify and nothing to repaint: the next flatten
				// asks and gets the new answer. Normalised on the way in as
				// well as on load, so a control that somehow yields an unknown
				// string cannot store one.
				s.inkPdfColorMode = normalizePdfPageAssumption(str);
				break;
			case "inkReadableInExports":
				// Keep the persisted boolean and its existing renderer semantics.
				// Boolean callers remain compatible with the former toggle.
				s.inkReadableInExports = value === true || str === "auto";
				setInkExportReadability(s.inkReadableInExports);
				// No repaint: this setting cannot change a pixel on screen. It is
				// read only inside an export, a print swap or a snip, and every
				// one of those paints from scratch when it runs.
				break;
			case "shapeSnap":
				s.shapeSnap = on;
				setShapeSnap(on);
				break;
			case "colorSizeCommands":
				s.colorSizeCommands = on;
				// Live, not "after the plugin reloads": the gated commands go into
				// the palette or out of it now, and their strip fallbacks move the
				// other way in the same call, so the toolbar keeps working in both
				// states. The decision is `planGatedCommands` (pure, tested); this
				// is the same shape as every other case here - apply live, then
				// save. Turning it OFF is the half that needs `removeCommand`, and
				// the row's own description keeps the reload sentence where that is
				// missing.
				this.plugin.applyGatedCommandRegistration();
				break;
			case "devDiagnostics":
				s.devDiagnostics = on;
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
			case "noteZoomControls": {
				// No refreshPenToolsAll equivalent needed: unlike penTools, the
				// zoom bar's existence never changes with its mode - only its
				// in-place visibility, which each live MobileTools instance
				// re-applies itself via onNoteZoomControlsChanged (MobileTools.ts).
				const m = normalizeNoteZoomControlsMode(str);
				s.noteZoomControls = m;
				setNoteZoomControlsMode(m);
				break;
			}
			case "toolbarCorner": {
				// ONE ROAD with drag-to-anchor (1.4.12). This case used to do
				// the two halves itself - write `s.toolbarCorner`, call
				// `setToolbarCorner` - and a strip dragged to a new anchor
				// owes exactly the same two. `applyToolbarPlacement`
				// (InkOverlay.ts) is that pair, and both strip hosts call it,
				// so the dropdown and the drag cannot end up doing different
				// things to the same setting.
				//
				// RETURNS rather than breaks: the persist hook registered in
				// `loadSettings` has already written data.json, and falling
				// through to the tail's `saveSettingsNow` would write the
				// same object a second time - see `persistSettings` on why
				// this plugin has exactly one road to that file.
				applyToolbarPlacement(normalizeToolbarCorner(str));
				return;
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
		this.renderLegacySettings();
	}

	private renderLegacySettings(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.paint(containerEl, this.getSettingDefinitions());
	}

	/** Draw definitions with the classic Setting builder, one row each. */
	private paint(el: HTMLElement, items: readonly LegacySettingItem[]): void {
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
				const { key, options, disabled } = item.control;
				// Same reason as the toggle above, and the Zoom bar row is a
				// dropdown: a row the definitions mark unusable must not paint as
				// a live control here while 1.13 greys it.
				const off = typeof disabled === "function" ? disabled() : disabled === true;
				setting.addDropdown((d) => {
					for (const [value, label] of Object.entries(options)) d.addOption(value, label);
					const current = this.getControlValue(key);
					d.setValue(typeof current === "string" ? current : "").onChange((v) => {
						this.setControlValue(key, v);
					});
					if (off) d.setDisabled(true);
				});
			}
		}
	}

	/**
	 * The Recalibrate button, on its own row in Developer since 1.4.20 took
	 * the pressure switch it used to sit beside out of the tab.
	 *
	 * It runs exactly what the removed `pressure-recalibrate` command ran,
	 * notice included: `resetPressureCalibration()` then the same "relearns
	 * from your next strokes" text, word for word.
	 */
	private renderPressureRecalibrate(setting: Setting): void {
		setting.addButton((btn) =>
			btn.setButtonText("Recalibrate").onClick(() => {
				resetPressureCalibration();
				new Notice("Handwriting: pressure relearns from your next strokes");
			})
		);
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
	// the README, where someone goes when they want the reason. One line is
	// the exception: the Obsidian Sync file-type hint, which the row carries
	// as its description because nothing on screen would tell anyone else.
	private renderSyncButton(setting: Setting): void {
		const label = (): string => (inkFolderSyncs(this.plugin.settings.inkFolder) ? "Turn off" : "Turn on");
		let button: { setButtonText(text: string): unknown; setDisabled(off: boolean): unknown } | null = null;
		setting.setName("Compatibility with Obsidian Sync, iCloud and Dropbox").addButton((btn) =>
			(button = btn)
				.setButtonText(label())
				.setCta()
				// Read on every render: a row rebuilt while a move runs must not
				// hand out a fresh enabled button for a second move.
				.setDisabled(this.plugin.inkFolderMoving())
				.onClick(() => {
					if (this.plugin.inkFolderMoving()) return;
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
		// A row drawn mid-move has a button the move's own `.then` never sees,
		// so it is released here, when the move ends or the row goes away.
		if (this.plugin.inkFolderMoving()) {
			const timer = window.setInterval(() => {
				if (this.plugin.inkFolderMoving() && setting.settingEl.isConnected) return;
				window.clearInterval(timer);
				button?.setButtonText(label());
				button?.setDisabled(false);
			}, 500);
			this.plugin.registerInterval(timer);
		}
	}

	/**
	 * The fold-order list, drawn full-width BELOW the row's name.
	 *
	 * A reorderable list does not fit the narrow control column a settings row
	 * gives its widget, so the row itself is turned into a block and the control
	 * appended under the name - the same escape hatch `renderSupport` takes for
	 * a different reason. The control caps its own width; the row does not
	 * stretch it (alan, on the third mock: "it's too wide").
	 */
	private renderFoldOrder(setting: Setting): void {
		setting.settingEl.addClass("handwriting-fold-order-row");
		// A second render of the same row would otherwise leave the first
		// control's preview strip alive in the registry.
		this.foldOrder?.destroy();
		this.foldOrder = new FoldOrderControl(setting.settingEl, {
			order: () => this.plugin.settings.stripFoldOrder,
			apply: (order) => this.plugin.applyStripFoldOrder(order),
			corner: () => this.plugin.settings.toolbarCorner,
			previewHost: previewStripHost({
				toolColor: (tool) => getInkColorHex(tool as InkTool),
				paletteFor: (tool) => colorsFor(tool as InkTool),
				recordingOn: () => diagnosticsEnabled(),
			}),
		});
	}

	/**
	 * The commands behind the switch, one short line per kind.
	 *
	 * Under the row's name rather than in the narrow control column, the same
	 * escape hatch `renderFoldOrder` takes: there is no widget on this row, and
	 * a block of lines does not belong in a column sized for a toggle.
	 *
	 * The lines come from `gatedCommandGroups()`, which reads the same table
	 * registration reads - the property that makes this list worth printing at
	 * all - so nothing here knows a command name.
	 *
	 * Idempotent: 1.13 re-evaluates the definitions on `update()` and can call
	 * this again on a row it has already drawn, and a second pass must not
	 * leave two lists.
	 */
	private renderGatedCommands(setting: Setting): void {
		setting.settingEl.addClass("handwriting-gated-row");
		setting.settingEl.querySelector(".handwriting-gated-list")?.remove();
		const list = setting.settingEl.createDiv({ cls: "handwriting-gated-list" });
		for (const group of gatedCommandGroups()) {
			const line = list.createDiv({ cls: "handwriting-gated-group" });
			line.createSpan({ cls: "handwriting-gated-label", text: `${group.label}: ` });
			line.createSpan({ cls: "handwriting-gated-names", text: group.names.join(", ") });
		}
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
