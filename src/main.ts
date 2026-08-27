import { App, MarkdownRenderChild, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import { CameraState } from "./camera/coordinates";
import { HANDWRITING_PAGE_VIEW_TYPE, HandwritingHost, HandwritingPageView } from "./view/HandwritingPageView";
import {
	HANDWRITING_DIAGNOSTICS_VIEW_TYPE,
	PenDiagnosticsView,
} from "./input/PenDiagnosticsView";
import { HANDWRITING_PEN_LAB_VIEW_TYPE, PenLabView } from "./view/PenLabView";
import {
	copyInlineInkMetrics,
	copyInlineZoomReport,
	copyPresentationReport,
	copyRegionCensus,
	deleteAllInkOn,
	getInlineTool,
	getInkSizeMult,
	setInkSizeMult,
	inkOverlayExtension,
	inlineInk,
	setInlineTool,
	getInlineEraserMode,
	setInlineEraserMode,
	getEraserRadiusPx,
	setEraserRadiusPx,
	repaintAllInkOverlays,
	overlayForPath,
	refreshPenToolsAll,
	stripQuiet,
	inlineReloadCandidates,
	inkExternallyReloaded,
	getInlineLassoMode,
	getInlineSpaceMode,
	setInlineLassoMode,
	setInlineSpaceMode,
	setPersistEraserRadius,
	setPersistInkSize,
	setPenReticle,
	setEraserWholeStrokes,
	setShapeSnap,
	setPersistEraserMode,
} from "./inline/InkOverlay";
import { destroyProbeMarkers } from "./inline/PenProbe";
import { attachFontZoomHost } from "./inline/EditorFontZoom";
import { clearInlinePenTrace, formatInlinePenTrace } from "./inline/InlinePenRouter";
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
import { inkShapingEnabled, setInkShaping } from "./ink/InkShape";
import {
	HIGHLIGHTER_COLORS,
	PEN_COLORS,
	colorsFor,
	getInkColorHex,
	nextInkColor,
	normalizeInkColor,
	setInkColorHex,
} from "./ink/InkColor";
import { diagnosticsEnabled, setDiagnosticsEnabled } from "./diag/DiagSwitch";
import { mouseInkEnabled, setMouseInk } from "./inline/MouseInk";
import { PaperStyle, nextPaperStyle, normalizePaperStyle, paperClass } from "./inline/Paper";
import { inkToSvg } from "./ink/SvgExport";
import { clipboardSize } from "./inline/InkClipboard";
import { attachEmbedInk, embedInkChanged, embedInkRoot, initEmbedInkRefresh } from "./inline/EmbedInk";
import { notifyInkChanged, onInkChanged } from "./inline/InkEvents";
import {
	PenToolsMode,
	getPenToolsMode,
	markPenSeen,
	nextPenToolsMode,
	normalizePenToolsMode,
	setPenToolsMode,
} from "./inline/PenToolsMode";
import { showDiagnosticText } from "./diag/DiagnosticTextModal";
import { newPageId } from "./model/PageData";
import { PageIdIndex } from "./model/PageIdIndex";
import { newPageMarkdown } from "./model/MarkdownPage";
import { PageStore } from "./persistence/PageStore";
import { runDetached } from "./util/Detached";
import {
	IOS_WEBKIT_CEILING,
	initPressureGain,
	resetPressureCalibration,
	setPressureStore,
} from "./ink/PressureGain";

interface HandwritingSettings {
	/** Per-page camera, kept out of the synced note on purpose (§22). */
	cameras: Record<string, CameraState>;
	/**
	 * Smoothed rendering geometry (live raw head + retrospectively smoothed
	 * tail). On by default as of the geometry checkpoint. The scheduling and
	 * pressure pipeline underneath is unchanged and frozen.
	 */
	smoothInk: boolean;
	/** Nib size multipliers per tool (v0.13.6): 0.6 fine · 1 medium · 1.8 bold. */
	inkSizes: { pen: number; highlighter: number };
	/**
	 * Shaped ink rendering (v0.13.10): velocity thinning, filtered pressure
	 * and endpoint taper, applied to pen strokes at render time. Stored ink is
	 * untouched, so flipping this restyles every stroke ever written.
	 */
	inkShaping: boolean;
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
}

const DEFAULT_SETTINGS: HandwritingSettings = {
	cameras: {},
	smoothInk: true,
	inkSizes: { pen: 1, highlighter: 1 },
	inkShaping: true,
	inkColors: { pen: PEN_COLORS[0]!.hex, highlighter: HIGHLIGHTER_COLORS[0]!.hex },
	pageOwners: {},
	eraserRadiusPx: DEFAULT_ERASER_RADIUS_PX,
	mouseInk: false,
	paperStyle: "none",
	penTools: "auto",
	eraserMode: "stroke",
	penReticle: true,
	shapeSnap: true,
};

/**
 * Handwriting: pen ink on ordinary Markdown notes.
 *
 * The primary surface is the Markdown editor itself. The pen inks directly on
 * a note in Live Preview or source mode and the ink is stored beside the file.
 * The standalone canvas is still there for notes carrying `handwriting: page` in
 * their frontmatter. Opening one swaps the Markdown view for the canvas, and
 * it can always be opened as plain Markdown again. Either way the note stays
 * readable, linkable and indexable.
 */
export default class HandwritingPlugin extends Plugin implements HandwritingHost {
	store!: PageStore;
	settings: HandwritingSettings = { ...DEFAULT_SETTINGS };
	private settingsDirty = false;
	private settingsTimer: number | null = null;
	/** Files we are mid-swap on, so layout events don't fight each other. */
	private swapping = new Set<string>();
	/** Notes the user explicitly opened as Markdown this session (§ no bounce-back). */
	private preferMarkdown = new Set<string>();
	/** Page-id ownership ledger (duplicate detection, v0.13.6). */
	private pageIds = new PageIdIndex();
	/** Collisions with no safe owner: id → the paths locked over it. */
	private ambiguousIds = new Map<string, string[]>();
	private pageIdWatchReady = false;
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
		// conflict file, is surfaced once in plain language.
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
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) return null;
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				const id = fm?.["handwriting-page-id"] as unknown;
				return typeof id === "string" && id.length > 0 ? id : null;
			},
			claimId: async (path, proposedId) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) throw new Error(`Handwriting: no file at ${path}`);
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
		// Pinch-to-zoom drives Obsidian's own base font size, the same value
		// its Ctrl+scroll quick-adjust moves. That setting is not part of the
		// public API, so the reach for it lives here, in one place, behind a
		// host the inline layer can only call through. If a future Obsidian
		// drops these calls, pinch stops resizing and nothing else notices.
		const appConfig = this.app.vault as unknown as {
			getConfig?(key: string): unknown;
			setConfig?(key: string, value: unknown): void;
		};
		attachFontZoomHost({
			read: () => {
				const px = appConfig.getConfig?.("baseFontSize");
				return typeof px === "number" ? px : null;
			},
			write: (px) => appConfig.setConfig?.("baseFontSize", px),
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
				runDetached(
					inlineInk.ensureLoaded(path).then(() => {
						// Registered even with zero strokes: a note drawn on
						// AFTER its embed rendered still gains ink live.
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
		// restart. One stat per open, quiet editor every second; the store
		// adopts a changed sidecar only when nothing local is unsaved and no
		// gesture is active, and the write-path conflict guard keeps its
		// last word. Dot-folders are invisible to vault events (sidecars
		// are not vault-indexed files), which is why this polls.
		let reloadTickBusy = false;
		this.registerInterval(
			window.setInterval(() => {
				if (reloadTickBusy) return;
				reloadTickBusy = true;
				runDetached(
					(async () => {
						for (const path of inlineReloadCandidates()) {
							const id = inlineInk.pageIdOf(path);
							if (!id || !(await this.store.externallyChanged(id))) continue;
							// The quiet check above is a tick old and the stat
							// awaited: a pen can have landed meanwhile. This
							// recheck runs in the same microtask as the
							// record drop, so no gesture can interleave.
							if (!inlineReloadCandidates().includes(path)) continue;
							if (await inlineInk.reloadExternal(path)) {
								inkExternallyReloaded(path);
								notifyInkChanged(path);
							}
						}
					})().finally(() => {
						reloadTickBusy = false;
					}),
					"live-reload poll"
				);
			}, 1000)
		);
		// The nib on ordinary notes: pen or highlighter. A property of the tip,
		// not a mode. The eraser end and the barrel keep their hardware meanings.
		this.addCommand({
			id: "inline-tool-pen",
			name: "Pen",
			callback: () => {
				// Picking a nib is also the exit from eraser and lasso modes:
				// on the strip, Pen LOOKS like the way out, so it has to be.
				setInlineTool("pen");
				setInlineEraserMode(false);
				setInlineLassoMode(false);
				setInlineSpaceMode(false);
				if (!stripQuiet()) new Notice("Handwriting: pen");
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
			name: "Mouse ink: toggle",
			callback: () => {
				const on = !mouseInkEnabled();
				setMouseInk(on);
				this.settings.mouseInk = on;
				runDetached(this.saveData(this.settings), "save the mouse ink setting");
				// Turning mouse ink on IS declaring yourself a pen person: the
				// strip appears without waiting for hardware that never comes.
				if (on) {
					markPenSeen();
					refreshPenToolsAll();
				}
				new Notice(on ? "Handwriting: mouse draws (left button)" : "Handwriting: mouse is a mouse again");
			},
		});
		this.addCommand({
			id: "pen-tools-cycle",
			name: "Pen tools: cycle (auto / show / hide)",
			callback: () => {
				const next = nextPenToolsMode(getPenToolsMode());
				setPenToolsMode(next);
				this.settings.penTools = next;
				runDetached(this.saveData(this.settings), "save the pen tools mode");
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
			name: "Paper: cycle (none / lines / grid)",
			callback: () => {
				const next = nextPaperStyle(this.settings.paperStyle);
				this.settings.paperStyle = next;
				this.applyPaper(next);
				runDetached(this.saveData(this.settings), "save the paper style");
				new Notice(`Handwriting: paper ${next}`);
			},
		});
		this.addCommand({
			id: "inline-tool-eraser",
			name: "Eraser: toggle",
			callback: () => {
				const on = !getInlineEraserMode();
				setInlineEraserMode(on);
				if (!stripQuiet()) new Notice(on ? "Handwriting: eraser" : `Handwriting: ${getInlineTool()}`);
			},
		});
		// Lasso as a mode: the barrel button was the only way in, and every
		// apple pencil and every mouse lacks one. Exclusive with the eraser.
		this.addCommand({
			id: "inline-tool-lasso",
			name: "Lasso: toggle",
			callback: () => {
				const on = !getInlineLassoMode();
				setInlineLassoMode(on);
				if (!stripQuiet()) new Notice(on ? "Handwriting: lasso (tip selects)" : `Handwriting: ${getInlineTool()}`);
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
				if (!stripQuiet()) new Notice(on ? "Handwriting: insert space (tip shifts ink below)" : `Handwriting: ${getInlineTool()}`);
			},
		});
		this.addCommand({
			id: "eraser-size-cycle",
			name: "Eraser size: next",
			callback: () => {
				const next = nextEraserSize(getEraserRadiusPx());
				runDetached(this.setEraserSize(next.radiusPx, next.name), "save the eraser size", () =>
					new Notice("Handwriting: the eraser size changed, but the setting could not be saved.")
				);
			},
		});
		this.addCommand({
			id: "ink-shaping-toggle",
			name: "Pressure sensitivity: toggle",
			callback: () => {
				const on = !inkShapingEnabled();
				runDetached(this.applyInkShaping(on), "save the ink shaping setting", () =>
					new Notice(
						"Handwriting: ink shaping changed for this session, but the setting could not be saved."
					)
				);
			},
		});
		// Nib sizes (OneNote-style): three steps on the ACTIVE tool, plus a
		// cycle command for a hotkey. Applies from the next stroke; persisted.
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
					new Notice("Handwriting: the ink size changed, but the setting could not be saved.")
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
						runDetached(this.setInkColor(choice.hex, choice.name), "save the ink color", () =>
							new Notice("Handwriting: the ink color changed, but the setting could not be saved.")
						);
					},
				});
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
			name: "Export this note's ink as SVG",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md" || !inlineInk.hasInk(file.path)) {
					return false;
				}
				if (!checking) {
					const svg = inkToSvg(inlineInk.strokes(file.path));
					if (!svg) {
						new Notice("Handwriting: no ink to export on this note.");
						return true;
					}
					const out = normalizePath(file.path.replace(/\.md$/, "") + ".ink.svg");
					runDetached(
						this.app.vault.adapter.write(out, svg).then(() => {
							new Notice(`Handwriting: exported ${out}`);
						}),
						"export ink as svg",
						() => new Notice("Handwriting: the SVG export could not be written.")
					);
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
				const file = this.app.workspace.getActiveFile();
				const overlay = file ? overlayForPath(file.path) : null;
				if (!overlay) return false;
				if (!checking) {
					const n = overlay.deleteSelectedInk();
					if (n === 0) new Notice("Handwriting: lasso some ink first");
				}
				return true;
			},
		});
		this.addCommand({
			id: "copy-selected-ink",
			name: "Copy selected ink",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const overlay = file ? overlayForPath(file.path) : null;
				if (!overlay) return false;
				if (!checking) {
					const n = overlay.copySelectedInk();
					new Notice(n > 0 ? `Handwriting: copied ${n} stroke(s)` : "Handwriting: lasso some ink first");
				}
				return true;
			},
		});
		this.addCommand({
			id: "cut-selected-ink",
			name: "Cut selected ink",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const overlay = file ? overlayForPath(file.path) : null;
				if (!overlay) return false;
				if (!checking) {
					const n = overlay.cutSelectedInk();
					new Notice(n > 0 ? `Handwriting: cut ${n} stroke(s)` : "Handwriting: lasso some ink first");
				}
				return true;
			},
		});
		this.addCommand({
			id: "paste-ink",
			name: "Paste ink",
			checkCallback: (checking) => {
				// Listed whenever a note is open: a paste hidden by an empty
				// clipboard reads as broken, and the empty case can just say so.
				const file = this.app.workspace.getActiveFile();
				const overlay = file ? overlayForPath(file.path) : null;
				if (!overlay) return false;
				if (!checking) {
					if (clipboardSize() === 0) {
						new Notice("Handwriting: the ink clipboard is empty. Copy selected ink first.");
					} else {
						const n = overlay.pasteInkHere();
						new Notice(`Handwriting: pasted ${n} stroke(s)`);
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
						new Notice("Handwriting: no ink on this note.");
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
				runDetached(this.setInkColor(next.hex, next.name), "save the ink color", () =>
					new Notice("Handwriting: the ink color changed, but the setting could not be saved.")
				);
			},
		});
		this.addCommand({
			id: "inline-tool-highlighter",
			name: "Highlighter",
			callback: () => {
				setInlineTool("highlighter");
				setInlineEraserMode(false);
				setInlineLassoMode(false);
				setInlineSpaceMode(false);
				if (!stripQuiet()) new Notice("Handwriting: highlighter");
			},
		});
		this.addCommand({
			id: "inline-tool-toggle",
			name: "Switch between pen and highlighter",
			callback: () => {
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
			name: "Diagnostics: show pen trace",
			callback: () => {
				showDiagnosticText(this.app, "Handwriting pen trace", formatInlinePenTrace());
			},
		});
		this.addCommand({
			id: "show-ink-metrics",
			name: "Diagnostics: show ink metrics",
			callback: () => {
				showDiagnosticText(this.app, "Handwriting ink metrics", copyInlineInkMetrics());
			},
		});
		this.addCommand({
			id: "clear-inline-pen-trace",
			name: "Diagnostics: clear pen trace",
			callback: () => {
				clearInlinePenTrace();
				new Notice("Handwriting: pen trace cleared");
			},
		});
		this.addCommand({
			id: "copy-inline-zoom-report",
			name: "Diagnostics: show zoom report",
			callback: () => {
				showDiagnosticText(this.app, "Handwriting zoom report", copyInlineZoomReport());
			},
		});
		// Dead-region diagnosis: what the page has under a client point, and
		// what every pen pointerdown's dispatch actually looked like.
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
		this.addCommand({
			id: "copy-inline-hit-report",
			name: "Diagnostics: show pointer hit report",
			callback: () => {
				showDiagnosticText(this.app, "Handwriting pointer hit report", formatHitReport());
			},
		});
		this.addCommand({
			id: "clear-inline-hit-probe",
			name: "Diagnostics: clear pointer hit probe",
			callback: () => {
				clearHitProbe();
				new Notice("Handwriting: pointer hit probe cleared");
			},
		});
		// Touchpad dead-zone diagnosis: the wheel/scroll/repaint pipeline,
		// always recording. Capture: clear -> touchpad-scroll -> draw inside
		// and outside the dead zone -> show the report. Then repeat with touchscreen
		// scrolling as the control.
		// Presentation ground truth: what is actually in the composited frame
		// and what paints above the ink at the last stroke's screen box.
		this.addCommand({
			id: "copy-region-census",
			name: "Diagnostics: show region census",
			callback: () => {
				showDiagnosticText(this.app, "Handwriting region census", copyRegionCensus());
			},
		});
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
		// Investigation instruments (scroll trace, pen trace, presentation
		// capture) are kept but explicitly invoked: recording is OFF by
		// default and costs one boolean check per event while off.
		this.addCommand({
			id: "toggle-diagnostics",
			name: "Diagnostics: toggle recording",
			callback: () => {
				const on = !diagnosticsEnabled();
				setDiagnosticsEnabled(on);
				new Notice(`Handwriting: diagnostics ${on ? "on, traces recording" : "off"}`);
			},
		});
		this.addCommand({
			id: "copy-inline-scroll-trace",
			name: "Diagnostics: show scroll trace",
			callback: () => {
				showDiagnosticText(this.app, "Handwriting scroll trace", formatScrollProbe());
			},
		});
		this.addCommand({
			id: "clear-inline-scroll-trace",
			name: "Diagnostics: clear scroll trace",
			callback: () => {
				clearScrollProbe();
				new Notice("Handwriting: scroll trace cleared");
			},
		});

		// The probe view is the whole point of this build, and a registered view
		// with nothing to open it is unreachable: there is no UI in Obsidian for
		// opening a view type by name. A remote tester needs one palette entry.
		this.addCommand({
			id: "open-pen-diagnostics",
			name: "Diagnostics: open pen probe",
			callback: () => {
				runDetached(this.openPenDiagnostics(), "open the pen probe");
			},
		});

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
			runDetached(
				this.maybeSwapView(this.app.workspace.getActiveFile()),
				"switch the active marked note to its canvas view"
			);
		});

		// Sidecar upkeep (§21): the sidecar is keyed by page id, so renames are
		// harmless. Deletes should not leave orphans behind, though.
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
		this.app.workspace.onLayoutReady(updateStatusBarClass);

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
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const id = this.recentPageIdFor(file);
		if (!id) {
			// The id line is gone (duplicate resolution by hand, or an
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
		const v = this.pageIds.register(path, id);
		if (v.kind === "registered") {
			this.persistOwners();
			return;
		}
		if (v.kind === "same") return;
		// Duplicate sighting. Verify the recorded owner still exists and
		// still carries the id. If not, ownership transfers instead.
		const ownerFile = this.app.vault.getAbstractFileByPath(v.ownerPath);
		const ownerId =
			ownerFile instanceof TFile ? this.recentPageIdFor(ownerFile) : null;
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
			const f = this.app.vault.getAbstractFileByPath(p);
			return f instanceof TFile && this.recentPageIdFor(f) === id;
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
			const file = this.app.vault.getAbstractFileByPath(copyPath);
			if (!(file instanceof TFile)) return;
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

	private async applyInkShaping(on: boolean): Promise<void> {
		setInkShaping(on);
		this.settings.inkShaping = on;
		// Render-time law: a repaint restyles every committed stroke.
		repaintAllInkOverlays();
		await this.saveData(this.settings);
		new Notice(on ? "Handwriting: ink shaping on" : "Handwriting: ink shaping off");
	}

	private async setInkColor(hex: string, name: string): Promise<void> {
		const tool = getInlineTool();
		this.settings.inkColors[tool] = setInkColorHex(tool, hex);
		await this.saveData(this.settings);
		new Notice(`Handwriting: ${tool} ${name}`);
	}

	private async setInkSize(mult: number, name: string): Promise<void> {
		const tool = getInlineTool();
		setInkSizeMult(tool, mult);
		this.settings.inkSizes[tool] = clampInkSize(mult);
		await this.saveData(this.settings);
		new Notice(`Handwriting: ${tool} size ${name}`);
	}

	private async setEraserSize(radiusPx: number, name: string): Promise<void> {
		setEraserRadiusPx(radiusPx);
		this.settings.eraserRadiusPx = clampEraserRadius(radiusPx);
		await this.saveData(this.settings);
		new Notice(`Handwriting: eraser ${name}`);
	}

	/** "Delete all ink": confirm first. The count in the dialog is live. */
	private confirmDeleteAllInk(path: string): void {
		const count = inlineInk.strokes(path).length;
		if (count === 0) return;
		new ConfirmDeleteInkModal(this.app, count, () => {
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

	onunload(): void {
		this.applyPaper("none");
		document.body.classList.remove("handwriting-active-page");
		destroyProbeMarkers();
		setHitProbeEnabled(false);
		attachFontZoomHost(null);
		// Obsidian's lifecycle contract is `onunload(): void`; it does not
		// wait for asynchronous cleanup. This is best effort, not crash
		// durability: a process killed before the I/O finishes can still
		// lose pending ink (README, Limitations).
		runDetached(this.finishPersistence(), "finish persistence during unload");
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
		let name = base;
		let n = 2;
		while (await this.app.vault.adapter.exists(this.pathFor(folder, name))) {
			name = `${base} ${n++}`;
		}
		const pageId = newPageId();
		try {
			const file = await this.app.vault.create(
				this.pathFor(folder, name),
				newPageMarkdown(pageId)
			);
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
		return typeof id === "string" ? id : undefined;
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

	private async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<HandwritingSettings> | null;
		this.settings = {
			cameras: raw?.cameras && typeof raw.cameras === "object" ? raw.cameras : {},
			smoothInk: raw?.smoothInk !== false,
			inkSizes: {
				pen: clampInkSize(raw?.inkSizes?.pen ?? 1),
				highlighter: clampInkSize(raw?.inkSizes?.highlighter ?? 1),
			},
			inkColors: {
				pen: normalizeInkColor("pen", raw?.inkColors?.pen),
				highlighter: normalizeInkColor("highlighter", raw?.inkColors?.highlighter),
			},
			inkShaping: raw?.inkShaping !== false,
			pageOwners:
				raw?.pageOwners && typeof raw.pageOwners === "object" ? raw.pageOwners : {},
			eraserRadiusPx: clampEraserRadius(raw?.eraserRadiusPx ?? DEFAULT_ERASER_RADIUS_PX),
			mouseInk: raw?.mouseInk === true,
			paperStyle: normalizePaperStyle(raw?.paperStyle),
			penTools: normalizePenToolsMode(raw?.penTools),
			// A fresh key on purpose: the old boolean keys carried the OLD
			// default in every data.json (full-object saves), so reading
			// them pinned the whole fleet to reticle and the stroke default
			// reached nobody. Reticle is chosen from here on, never inherited.
			eraserMode: raw?.eraserMode === "reticle" ? "reticle" : "stroke",
			penReticle: raw?.penReticle !== false,
			shapeSnap: raw?.shapeSnap !== false,
		};
		setPenToolsMode(this.settings.penTools);
		// The strip's eraser slider persists through here on release.
		setPersistEraserRadius((px) => {
			this.settings.eraserRadiusPx = px;
			runDetached(this.saveData(this.settings), "save the eraser size");
		});
		setPersistEraserMode((on) => {
			this.settings.eraserMode = on ? "stroke" : "reticle";
			runDetached(this.saveData(this.settings), "save the eraser mode");
		});
		setPersistInkSize((tool, mult) => {
			this.settings.inkSizes[tool] = clampInkSize(mult);
			runDetached(this.saveData(this.settings), "save the ink size");
		});
		setMouseInk(this.settings.mouseInk);
		this.applyPaper(this.settings.paperStyle);
		setInkSizeMult("pen", this.settings.inkSizes.pen);
		setInkSizeMult("highlighter", this.settings.inkSizes.highlighter);
		setInkShaping(this.settings.inkShaping);
		setInkColorHex("pen", this.settings.inkColors.pen);
		setInkColorHex("highlighter", this.settings.inkColors.highlighter);
		setEraserRadiusPx(this.settings.eraserRadiusPx);
		setEraserWholeStrokes(this.settings.eraserMode === "stroke");
		setPenReticle(this.settings.penReticle);
		setShapeSnap(this.settings.shapeSnap);
	}

	/** Settings-tab writes: persist now, quietly. */
	saveSettingsNow(): void {
		runDetached(this.saveData(this.settings), "save settings");
	}

	private async flushSettings(): Promise<void> {
		if (this.settingsTimer !== null) {
			window.clearTimeout(this.settingsTimer);
			this.settingsTimer = null;
		}
		if (!this.settingsDirty) return;
		this.settingsDirty = false;
		try {
			await this.saveData(this.settings);
		} catch (err) {
			console.error("[handwriting] settings save failed", err);
		}
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
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Delete all ink on this note?");
		const what = this.count === 1 ? "1 stroke" : `${this.count} strokes`;
		this.contentEl.createEl("p", {
			text:
				`${what} will be removed. Undo (Ctrl+Z) restores them while the ` +
				"note stays open, and a copy of the saved ink is kept in the " +
				"vault's .handwriting/trash folder.",
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

/**
 * The device-level knobs, most of which already existed as commands. The
 * strip's sliders stay the source of truth for sizes and colors, so those
 * are not duplicated here.
 */
class HandwritingSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: HandwritingPlugin
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName("Pen toolbar")
			.setDesc("Determines when the toolbar appears. Default auto.")
			.addDropdown((d) =>
				d
					.addOption("auto", "Auto")
					.addOption("show", "Show")
					.addOption("hide", "Hide")
					.setValue(this.plugin.settings.penTools)
					.onChange((v) => {
						const m = normalizePenToolsMode(v);
						this.plugin.settings.penTools = m;
						setPenToolsMode(m);
						refreshPenToolsAll();
						this.plugin.saveSettingsNow();
					})
			);
		new Setting(containerEl)
			.setName("Paper background")
			.setDesc("Lined or grid paper. Default none.")
			.addDropdown((d) =>
				d
					.addOption("none", "None")
					.addOption("lines", "Lines")
					.addOption("grid", "Grid")
					.setValue(this.plugin.settings.paperStyle)
					.onChange((v) => {
						const style = normalizePaperStyle(v);
						this.plugin.settings.paperStyle = style;
						this.plugin.applyPaper(style);
						this.plugin.saveSettingsNow();
					})
			);
		new Setting(containerEl)
			.setName("Mouse ink")
			.setDesc("Left click draws. Default off.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.mouseInk).onChange((on) => {
					this.plugin.settings.mouseInk = on;
					setMouseInk(on);
					if (on) {
						markPenSeen();
						refreshPenToolsAll();
					}
					this.plugin.saveSettingsNow();
				})
			);
		new Setting(containerEl)
			.setName("Pressure sensitivity")
			.setDesc("Default on.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.inkShaping).onChange((on) => {
					this.plugin.settings.inkShaping = on;
					setInkShaping(on);
					repaintAllInkOverlays();
					this.plugin.saveSettingsNow();
				})
			);
		new Setting(containerEl)
			.setName("Shape snap")
			.setDesc("Hold the pen still after drawing a shape. Default on.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.shapeSnap).onChange((on) => {
					this.plugin.settings.shapeSnap = on;
					setShapeSnap(on);
					this.plugin.saveSettingsNow();
				})
			);
		new Setting(containerEl)
			.setName("Eraser")
			.setDesc("What the eraser erases. Default stroke.")
			.addDropdown((d) =>
				d
					.addOption("stroke", "Stroke")
					.addOption("reticle", "Reticle")
					.setValue(this.plugin.settings.eraserMode)
					.onChange((v) => {
						const mode = v === "reticle" ? "reticle" : "stroke";
						this.plugin.settings.eraserMode = mode;
						setEraserWholeStrokes(mode === "stroke");
						this.plugin.saveSettingsNow();
					})
			);
		new Setting(containerEl)
			.setName("Pen reticle")
			.setDesc("Default on.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.penReticle).onChange((on) => {
					this.plugin.settings.penReticle = on;
					setPenReticle(on);
					this.plugin.saveSettingsNow();
				})
			);
	}
}
