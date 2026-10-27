/**
 * The phases of HandwritingPlugin.onload, moved from main.ts. Each is a method of HandwritingPlugin, installed on its prototype when main.ts loads and called by onload in the order the statements had.
 * Bodies moved unchanged.
 */
import { Notice, Platform, TFile, View } from "obsidian";
import { HANDWRITING_DIAGNOSTICS_VIEW_TYPE, PenDiagnosticsView } from "./input/PenDiagnosticsView";
import { HANDWRITING_PEN_LAB_VIEW_TYPE, PenLabView } from "./view/PenLabView";
import { onSlidesCssChange, scanForSlides, setSlidesInk } from "./slides/SlidesInkSurface";
import { addStripSurface, inkOverlayExtension, inlineInk, inlineReloadBindings, refreshAllStrips, repaintAllInkOverlays } from "./inline/InkOverlay";
import { armForegroundRepaint } from "./inline/ForegroundRepaint";
import { syncUndoTraceForDiagnostics } from "./diag/UndoHistoryTrace";
import { surfaceExtents } from "./inline/SurfaceExtent";
import { noteCameras } from "./inline/NoteCamera";
import { refreshInkTheme } from "./ink/InkTheme";
import { setDiagnosticsChangedListener } from "./diag/DiagSwitch";
import { isMarkdownPath } from "./util/MarkdownPath";
import { NotePaper } from "./inline/NotePaper";
import { embedInkChanged, embedInkFileOpened, embedInkRenamed, initEmbedInkFontRef, initEmbedInkRefresh } from "./inline/EmbedInk";
import { initEmbedInkPrintPaper } from "./inline/EmbedInkPrint";
import { onInkChanged } from "./inline/InkEvents";
import { setPenHardwareStore } from "./inline/PenToolsMode";
import { canvasForNote, CanvasNoteOverride } from "./inline/CanvasNoteOverride";
import { PageStore, WRITE_ATTEMPTS } from "./persistence/PageStore";
import { runDetached } from "./util/Detached";
import { initPressureGain, IOS_WEBKIT_CEILING, setPressureStore } from "./ink/PressureGain";
import { HandwritingSettingTab } from "./settings/HandwritingSettingTab";
import { blockNotice } from "./view/Notices";
import { bindRecoveryNotices } from "./ink/DeleteAllInk";
import { installMethods } from "./inline/InstallMethods";
import type { HandwritingPlugin } from "./main";

declare module "./main" {
	interface HandwritingPlugin {
		onloadDevice(): Promise<void>;
		onloadStore(): void;
		onloadViews(): void;
		onloadNoteChrome(): void;
		onloadVaultEvents(): void;
		onloadWorkspace(): void;
		onloadFlushAndForeground(): void;
		onloadPageIdWatch(): void;
	}
}


	/** Device-local stores: pressure calibration, pen-hardware latch and side-button choice, then the pressure gain. */
	async function onloadDevice(this: HandwritingPlugin): Promise<void> {
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
		// The side-button choice belongs to this device, never synced settings.
		const { setSideButtonStore } = await import("./inline/TipMode");
		setSideButtonStore({
			load: (key) => this.app.loadLocalStorage(key) as unknown,
			save: (key, value) => this.app.saveLocalStorage(key, value),
			defaultErases: Platform.isAndroidApp,
		});
		initPressureGain(Platform.isIosApp ? IOS_WEBKIT_CEILING : 0);
	}

	/** The page store and its write-error, conflict and recovery notices. */
	function onloadStore(this: HandwritingPlugin): void {
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
	}

	/** Pen lab and diagnostics views, the inline ink host, the per-note canvas override and the editor extension. */
	function onloadViews(this: HandwritingPlugin): void {
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
			hasQueuedWrite: (pageId) => this.store.hasQueuedWrite(pageId),
			panesQuiet: (path) => inlineReloadBindings().every(binding => binding.path !== path || binding.quiet),
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
	}


	/** Embed refresh, note paper, header actions, the file menu, the settings tab, popout windows and the e-ink hint poll. */
	function onloadNoteChrome(this: HandwritingPlugin): void {
		// Embed layers stop going stale: every persisted gesture repaints the
		// rendered roots showing that note. See EmbedInk.ts.
		initEmbedInkRefresh((p) => inlineInk.strokes(p));
		initEmbedInkFontRef((p) => inlineInk.fontRefPx(p));
		// A native export is sized to the paper the export dialog last saved (see EmbedInkPrint.ts); the config key is not public API.
		initEmbedInkPrintPaper(() => (this.app.vault as unknown as { getConfig(key: string): unknown }).getConfig("pdfExportSettings"));
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
	}


	/** Vault events: page-id recycling on delete, inline session records on rename and delete, PDF content changes. */
	function onloadVaultEvents(this: HandwritingPlugin): void {
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
					noteCameras.handleRename(oldPath, file.path);
				} else if (file instanceof TFile && isMarkdownPath(oldPath)) {
					// Renamed away from Markdown (note.md -> note.mdenc): nothing at
					// the old path is this note any more, so the next file there starts clean.
					inlineInk.handleDelete(oldPath);
					surfaceExtents.handleDelete(oldPath);
					noteCameras.handleDelete(oldPath);
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
					// The path a closed pane's notices name moves too: a save failure or a
					// conflict copy reported after the rename must name the file as it is now.
					const byId = this.pdfPathById;
					for (const [id, p] of byId ?? []) {
						if (p === oldPath) byId?.set(id, file.path);
					}
				}
				// Renamed while no pane shows it: the claim still has to move.
				if (file instanceof TFile && file.extension === "pdf" && ![...this.pdfFiles.values()].includes(file.path)) {
					runDetached(this.movePdfClaimOnRename(file, oldPath), `move the ink claim of ${oldPath} to ${file.path}`);
				}
			})
		);
		// A PDF changed in place is a new document to the content-keyed id;
		// see onPdfModified.
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "pdf") this.schedulePdfModified(file.path);
			})
		);
		this.register(() => {
			for (const pending of this.pdfModifyTimers?.values() ?? []) window.clearTimeout(pending.timer);
			this.pdfModifyTimers?.clear();
		});
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					inlineInk.handleDelete(file.path);
					surfaceExtents.handleDelete(file.path);
					noteCameras.handleDelete(file.path);
				}
			})
		);
	}

	/** Workspace hooks: status bar class, theme change, PDF and slides ink, recording badge, PDF strips, file open, delete-all-ink. */
	function onloadWorkspace(this: HandwritingPlugin): void {
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
	}

	/** The what's-new notice after layout, the background flush and the foreground repaint. */
	function onloadFlushAndForeground(this: HandwritingPlugin): void {
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
	}

	/** The duplicate page-id census. */
	function onloadPageIdWatch(this: HandwritingPlugin): void {
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
					// The declaim grace and the declaimed set are keyed by path: follow the note.
					const pending = this.declaimTimers.get(oldPath);
					if (pending !== undefined) {
						window.clearTimeout(pending);
						this.declaimTimers.delete(oldPath);
						this.declaimLater(file.path);
					}
					if (this.declaimedPaths.delete(oldPath)) this.declaimedPaths.add(file.path);
					for (const paths of this.ambiguousIds.values()) {
						const i = paths.indexOf(oldPath);
						if (i >= 0) paths[i] = file.path;
					}
					if (this.pageIdWatchReady) this.persistOwners();
				} else if (file instanceof TFile && isMarkdownPath(oldPath)) {
					if (this.pageIds.handleDelete(oldPath).length > 0 && this.pageIdWatchReady) this.persistOwners();
				}
			})
		);
		// Turned on or updated while Obsidian runs: the index finished before
		// this load and no "resolved" comes until some file changes, so until
		// then a note and its copy would write one ink file. When the layout is
		// ready and every markdown file already has a cache, the index is whole:
		// run the census now. A cold start, or a file still unindexed, waits for
		// "resolved" as before; runCensus runs once either way.
		if (
			this.app.workspace.layoutReady &&
			this.app.vault.getMarkdownFiles().every((f) => this.app.metadataCache.getFileCache(f) !== null)
		) {
			runCensus();
		}
	}

export function installPluginOnload(proto: HandwritingPlugin): void {
	installMethods(proto, {
		onloadDevice,
		onloadStore,
		onloadViews,
		onloadNoteChrome,
		onloadVaultEvents,
		onloadWorkspace,
		onloadFlushAndForeground,
		onloadPageIdWatch,
	});
}
