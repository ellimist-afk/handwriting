/**
 * Settings persistence: loading data.json, merging another device's saves, the debounced write queue, applying the
 * settings to the live surfaces, Boox mode and the ink-folder move. They are methods of HandwritingPlugin, installed on
 * its prototype when main.ts loads (installPluginSettings at its bottom). Bodies moved unchanged from the class. This
 * file imports only types from main.
 */
import { installMethods } from "../inline/InstallMethods";
import { Notice, Platform } from "obsidian";
import { inlineInk, refreshPenToolsAll, refreshAllStrips, repaintAllInkOverlays, setEraserRadiusPx, setEraserWholeStrokes, setInkSizeMult, setPenReticle, setPersistEraserMode, setPersistEraserRadius, setPersistInkSize, setPersistToolbarCorner, setShapeSnap, setToolbarCorner, setScrollExpansionEnabled } from "../inline/InkOverlay";
import { clampInkSize } from "../ink/InkSize";
import { DEFAULT_ERASER_RADIUS_PX, clampEraserRadius } from "../ink/EraserSize";
import { setPressureSensitivity } from "../ink/PenStyle";
import { refreshInkTheme, setInkExportReadability, setInkThemeAdaptation } from "../ink/InkTheme";
import { setInkShaping } from "../ink/InkShape";
import { normalizeInkPresets, setInkPresets } from "../ink/InkPresets";
import { installInkPresetActions } from "../ink/InkPresetHost";
import { discardHintSamples } from "../ink/LatencyEstimate";
import { resetEinkHintProgress } from "../ink/EinkHint";
import { normalizeInkColor, setInkColorHex, setPersistInkColor } from "../ink/InkColor";
import { setRoutineNoticesVisible } from "../diag/RoutineNotices";
import { setMouseInk } from "../inline/MouseInk";
import { setPrediction, setPredictionEink } from "../inline/StrokePrediction";
import { normalizePaperStyle } from "../inline/Paper";
import { normalizePdfPageAssumption } from "../ink/InkPdf";
import { embedInkRepaintAll } from "../inline/EmbedInk";
import { normalizePenToolsMode, persistPenHardwareSeenToStore, restorePenHardwareEverSeenFromStore, setPenToolsMode, setPersistPenHardwareSeen } from "../inline/PenToolsMode";
import { normalizeNoteZoomControlsMode, setNoteZoomControlsMode, setZoomBarCanvasEnabled } from "../inline/NoteZoomControlsMode";
import { normalizeBarsRestore } from "../inline/BarsToggle";
import { normalizeFoldOrder, refreshNoteZoomControlsAll, setStripFoldOrder } from "../inline/MobileTools";
import { runDetached } from "../util/Detached";
import { adoptInkFolder, changeFolder, DEFAULT_INK_FOLDER, inkFolderSyncs, migrateInkFolder, normalizeInkFolder, SYNCED_INK_FOLDER } from "../persistence/InkFolder";
import { normalizeToolbarCorner } from "../inline/ToolbarCorner";
import { SYNC_ALL_TYPES_HINT } from "./HandwritingSettingTab";
import { isPlainObject, pressureChoiceFrom, type HandwritingSettings } from "./SettingsModel";
import { blockNotice } from "../view/Notices";
import type { HandwritingPlugin } from "../main";

declare module "../main" {
	interface HandwritingPlugin {
		inkFolderMoving(): boolean;
		changeInkFolder(raw: string): Promise<void>;
		loadSettings(): Promise<void>;
		settingsFrom(raw: Partial<HandwritingSettings> | null | undefined): HandwritingSettings;
		settingsFileIsBlank(): Promise<boolean>;
		settingsSnapshot(settings: HandwritingSettings): Record<string, unknown>;
		applyRuntimeSettings(): void;
		onExternalSettingsChange(): Promise<void>;
		inkShapingKey(): string;
		takeMergedSettings(merged: HandwritingSettings): void;
		refreshSettingSurfaces(): void;
		mergeSettings(fresh: Partial<HandwritingSettings> | null | undefined): {
			merged: HandwritingSettings;
			localChanges: boolean;
		};
		applyBooxMode(): void;
		saveSettingsNow(): void;
		persistSettings(onHide?: boolean): Promise<void>;
		flushSettings(onHide?: boolean): Promise<void>;
	}
}

	/** Whether the settings row must keep its Turn on / Turn off button disabled. */
	function inkFolderMoving(this: HandwritingPlugin): boolean {
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
	async function changeInkFolder(this: HandwritingPlugin, raw: string): Promise<void> {
		const next = normalizeInkFolder(raw);
		// With the settings file unreadable the plugin writes none of it, so a
		// move now would be undone at the next start with the ink left behind.
		if (this.settingsReadFailed) {
			new Notice(
				"Handwriting: the ink folder was not changed. The plugin settings could not be read at startup; restart Obsidian and try again."
			);
			return;
		}
		const previous = this.store.inkFolder();
		let saveFailed = false;
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
					// The move stays whatever the save does: the files are already
					// in the new folder. A failed save leaves the setting in memory
					// and marked unsaved, so the next save or unload writes it.
					persist: async (to) => {
						this.settings.inkFolder = to;
						try {
							await this.persistSettings();
						} catch (err) {
							console.error("[handwriting] ink folder setting not saved", err);
							saveFailed = true;
						}
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
		if (saveFailed) {
			new Notice(
				`Handwriting: ink moved to ${next}, but the setting could not be saved. Change any Handwriting setting to save it, or the ink folder goes back to ${previous} at the next start.`
			);
			return;
		}
		const { moved, skipped } = outcome.result;
		const left = skipped > 0 ? `, ${skipped} left behind (name already taken)` : "";
		new Notice(
			`Handwriting: ink folder is now "${next}". Moved ${moved} file(s)${left}.` +
				(inkFolderSyncs(next) ? ` ${SYNC_ALL_TYPES_HINT}` : " This folder is hidden and will not sync.")
		);
	}

	async function loadSettings(this: HandwritingPlugin): Promise<void> {
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
		// An empty file is no settings, not a file that could not be read. It
		// parses as nothing, like a truncated one, but holds nothing a write
		// could lose. Taken as a failed read it stayed empty for good: every
		// change was lost at the next launch and the notice showed at every
		// start. Text that is empty or only whitespace loads as an empty object
		// and saves normally; any other text that does not parse stays a failed
		// read.
		const blank = raw === undefined && (await this.settingsFileIsBlank());
		if (blank) raw = {};
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
		const { restoreSideButtonErases } = await import("../inline/TipMode");
		restoreSideButtonErases();
		if (Platform.isAndroidApp) document.body.classList.add("handwriting-android");
		// No data.json means the folder choice is gone, not that the ink is.
		// A vault synced in compatibility mode carries `handwriting/` and not
		// this file, so a second device would start on `.handwriting`, read
		// nothing, and fork a second sidecar per page. Adopt the folder the
		// vault is visibly already using. Only when there is nothing to ask:
		// a stored choice, including the default, is always obeyed.
		// An unreadable file has lost the choice for this session just as a
		// missing one has, so the folder is looked up the same way (a read).
		// An empty file has lost the choice too. What is looked up is kept as a
		// change of this device's and saved, as on a first install.
		if (this.freshInstall || this.settingsReadFailed || blank) {
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
		// The stored mouse setting, once, at load. Later only a changed stored
		// value is applied (takeMergedSettings): re-applying it on every settings
		// change turned off the arm that lasts only for this session.
		setMouseInk(this.settings.mouseInk);
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
			notice: (message) => void blockNotice(message),
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
	function settingsFrom(this: HandwritingPlugin, raw: Partial<HandwritingSettings> | null | undefined): HandwritingSettings {
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

	/** data.json's text is empty or only whitespace. False when it holds anything else or cannot be read. */
	async function settingsFileIsBlank(this: HandwritingPlugin): Promise<boolean> {
		const dir = this.manifest.dir;
		if (!dir) return false;
		try {
			return (await this.app.vault.adapter.read(`${dir}/data.json`)).trim() === "";
		} catch {
			return false;
		}
	}

	/** A deep copy of settings, for comparing against later. */
	function settingsSnapshot(this: HandwritingPlugin, settings: HandwritingSettings): Record<string, unknown> {
		return JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
	}

	/**
	 * Push the settings into the modules that read them at runtime. Called at
	 * load, before any surface builds its first strip, and again when another
	 * device's settings arrive, so the two can never apply different lists.
	 */
	function applyRuntimeSettings(this: HandwritingPlugin): void {
		setPenToolsMode(this.settings.penTools);
		setNoteZoomControlsMode(this.settings.noteZoomControls);
		setToolbarCorner(this.settings.toolbarCorner);
		// Beside the corner, and for the same reason: both are strip facts the
		// settings own, and both must be in place before a surface builds its
		// first strip - a fold order applied after the fact would leave the
		// first pane of the session folding in the default order.
		setStripFoldOrder(this.settings.stripFoldOrder);
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
	async function onExternalSettingsChange(this: HandwritingPlugin): Promise<void> {
		const fresh = (await this.loadData()) as Partial<HandwritingSettings> | null | undefined;
		if (fresh === undefined || fresh === null) return;
		// A clean read: the file is readable again, so saving is safe again.
		this.settingsReadFailed = false;
		const { merged, localChanges } = this.mergeSettings(fresh);
		this.takeMergedSettings(merged);
		this.settingsBaseline = this.settingsSnapshot(this.settingsFrom(fresh));
		this.applyRuntimeSettings();
		this.applyPaper(this.settings.paperStyle);
		if (localChanges) this.saveSettingsNow();
	}

	/** The settings that change how saved ink draws: pressure, smoothing, Boox mode, theme adaptation. */
	function inkShapingKey(this: HandwritingPlugin): string {
		const s = this.settings;
		return `${s.pressureSensitivity}|${s.inkSmoothing}|${s.booxMode}|${s.inkAdaptsToTheme}`;
	}

	/**
	 * Take merged settings into this.settings, and act on the two that cannot
	 * wait: the ink folder the store writes to, and the stored mouse setting.
	 * Both the change report and a save's merge come through here, because a
	 * save can be the first to read another device's file; the change report
	 * that follows then sees nothing changed. The mouse is set only when the
	 * stored value changed, so the arm that lasts only for this session
	 * survives a sync that does not touch it. No ink file moves here: startup
	 * does that. Synchronous, so the save's hide path stays free of awaits.
	 */
	function takeMergedSettings(this: HandwritingPlugin, merged: HandwritingSettings): void {
		const folderBefore = this.settings.inkFolder;
		const mouseBefore = this.settings.mouseInk;
		const slidesBefore = this.settings.slidesInk;
		const shapedBefore = this.inkShapingKey();
		const before = JSON.stringify(this.settingsSnapshot(this.settings));
		Object.assign(this.settings, merged);
		if (this.settings.inkFolder !== folderBefore) this.store.useInkFolder(this.settings.inkFolder);
		if (this.settings.mouseInk !== mouseBefore) setMouseInk(this.settings.mouseInk);
		// Here and not in the change report: a save that read the file first takes
		// another device's value through this method, and the report that follows
		// then finds nothing changed. The hide path merges over the file as last
		// read, so it changes no value and does no extra work. Every key counts:
		// whatever another device changed is applied and refreshed as the settings tab does.
		// A refresh that throws must not stop the save that took the values or the
		// change report that moves the baseline: report it and carry on.
		if (JSON.stringify(this.settingsSnapshot(this.settings)) !== before) {
			try {
				this.applyRuntimeSettings();
				this.refreshSettingSurfaces();
				// Saved strokes are shaped and coloured at draw time: whichever of a
				// save or the change report takes another device's value, it redraws.
				if (this.inkShapingKey() !== shapedBefore) {
					repaintAllInkOverlays();
					embedInkRepaintAll();
				}
				if (this.settings.slidesInk !== slidesBefore) this.applySlidesInk(this.settings.slidesInk);
			} catch (err) {
				console.error("[handwriting] refreshing the screens after a synced setting failed", err);
			}
		}
	}

	/** What the settings tab refreshes after it flips a row, for a value that arrived from another device. */
	function refreshSettingSurfaces(this: HandwritingPlugin): void {
		refreshNoteZoomControlsAll();
		this.refreshHeaderActions();
		refreshPenToolsAll();
		this.applyStatusBarVisibility();
		this.applyGatedCommandRegistration();
	}

	/**
	 * This device's changes laid over the file's current contents: every key
	 * whose in-memory value differs from `settingsBaseline` is this device's;
	 * every other key is the file's. A setting that is itself a map merges one
	 * level down the same way: the file's entries kept, except where this
	 * device added, changed or removed one.
	 */
	function mergeSettings(this: HandwritingPlugin, fresh: Partial<HandwritingSettings> | null | undefined): {
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
	 * Boox mode: the slice of e-ink latency the plugin owns. E-ink pays per
	 * redraw, so everything that redraws for polish goes quiet while it is
	 * on - prediction (draws ahead, then corrects), ink smoothing (reshapes
	 * behind the nib) and the chrome's animations (via body class). Runtime
	 * overrides, never setting rewrites: toggling off restores the user's
	 * own choices exactly.
	 */
	function applyBooxMode(this: HandwritingPlugin): void {
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

	/** Settings-tab writes: persist now, quietly. */
	function saveSettingsNow(this: HandwritingPlugin): void {
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
	function persistSettings(this: HandwritingPlugin, onHide = false): Promise<void> {
		if (this.settingsTimer !== null) {
			window.clearTimeout(this.settingsTimer);
			this.settingsTimer = null;
		}
		this.settingsDirty = false;
		// The file could not be read at launch: write nothing (settingsReadFailed).
		if (this.settingsReadFailed) return Promise.resolve();
		// At hide the write goes over the settings as last read, with no time to
		// read first. With no change of this device's own it can only put back
		// an older value of a setting another device synced in: write nothing.
		if (onHide && !this.mergeSettings(this.settingsBaseline).localChanges) return Promise.resolve();
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
			this.takeMergedSettings(merged);
			return merged;
		};
		// The baseline is what went to the disk, snapshotted BEFORE the write:
		// `data` shares its colour and size maps with the live settings (the
		// merge assigns shallow), so a pick during the write would otherwise
		// enter the baseline without reaching the disk, and the next save would
		// read it as no change and write the old value back.
		const send = (data: HandwritingSettings): Promise<void> => {
			const sent = this.settingsSnapshot(data);
			return this.saveData(data).then(() => {
				this.settingsBaseline = sent;
			});
		};
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
					// Nothing reached the disk, and dirty was cleared before
					// the write: without this a change waiting on the latch
					// is forgotten, and the flush at quit or hide skips it.
					this.settingsDirty = true;
					throw err;
				}
			);
		this.settingsWriting = write();
		return this.settingsWriting;
	}

	async function flushSettings(this: HandwritingPlugin, onHide = false): Promise<void> {
		if (this.settingsTimer !== null) {
			window.clearTimeout(this.settingsTimer);
			this.settingsTimer = null;
		}
		if (!this.settingsDirty) return;
		return this.persistSettings(onHide);
	}

export function installPluginSettings(proto: HandwritingPlugin): void {
	installMethods(proto, {
		inkFolderMoving,
		changeInkFolder,
		loadSettings,
		settingsFrom,
		settingsFileIsBlank,
		settingsSnapshot,
		applyRuntimeSettings,
		onExternalSettingsChange,
		inkShapingKey,
		takeMergedSettings,
		refreshSettingSurfaces,
		mergeSettings,
		applyBooxMode,
		saveSettingsNow,
		persistSettings,
		flushSettings,
	});
}
