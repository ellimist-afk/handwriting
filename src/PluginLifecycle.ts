/**
 * Unload, persistence and slides ink start, moved from main.ts. Each is a method of HandwritingPlugin, installed on its prototype when main.ts loads.
 * Bodies moved unchanged.
 */
import { Notice, TFile, type Tasks } from "obsidian";
import { HANDWRITING_DIAGNOSTICS_VIEW_TYPE } from "./input/PenDiagnosticsView";
import { finishSlidesGesture, setSlidesInk, settleSlidesInk, slidesParkedInk, SlidesInkHost } from "./slides/SlidesInkSurface";
import { mountSlidesTools } from "./slides/SlidesTools";
import { getEraserRadiusPx, getEraserWholeStrokes, getInkSizeMult, getInlineTool, inlineInk } from "./inline/InkOverlay";
import { destroyProbeMarkers } from "./inline/PenProbe";
import { captureInlinePenTrace, finishLiveStrokesOnHide } from "./inline/InlinePenRouter";
import { setHitProbeEnabled } from "./inline/PenHitProbe";
import { stopMainThreadProbe } from "./inline/ScrollProbe";
import { noteCameras } from "./inline/NoteCamera";
import { DEFAULT_PEN, HIGHLIGHTER_PEN } from "./ink/PenStyle";
import { getInkColorHex } from "./ink/InkColor";
import { diagnosticsEnabled } from "./diag/DiagSwitch";
import { isMarkdownPath } from "./util/MarkdownPath";
import { traceGuardVerdict } from "./diag/TraceGuard";
import { stopTraceAtUnload } from "./diag/InkTrace";
import { disarmPrintSwaps, teardownEmbedInk } from "./inline/EmbedInk";
import { newPageId } from "./model/PageData";
import { newPageWriter } from "./persistence/PageStore";
import { runDetached } from "./util/Detached";
import { decideWhatsNew, whatsNewDurationMs, whatsNewFragment, whatsNewStaysUntilTapped } from "./update/WhatsNew";
import { blockNotice } from "./view/Notices";
import { RECYCLE_GRACE_MS } from "./ink/RecycleOnDelete";
import { installMethods } from "./inline/InstallMethods";
import { hideOwnedNotices, type HandwritingPlugin } from "./main";
import { ownedNoticeHiders } from "./OwnedNotices";

declare module "./main" {
	interface HandwritingPlugin {
		onunload(): void;
		showWhatsNewIfDue(): void;
		syncRecordingBadge(): void;
		guardEmptyTrace(): boolean;
		flushOnHide(): void;
		flushOnQuit(tasks: Tasks): void;
		finishPersistence(): Promise<void>;
		openPenDiagnostics(): Promise<void>;
		startSlidesInk(): void;
	}
}

	/**
	 * The notes that stay until tapped, while they are up. They have no timeout, so nothing but a tap or this slot
	 * takes them down: unload walks the owned-notice hiders, and a plugin turned off or updated without a tap left
	 * them standing, a second copy beside them after a reload, and a late tap writing an old version over a new one.
	 * Registered once, at module load, like every other owned slot; a hidden notice is skipped as there.
	 */
	let whatsNewUntilTapped: Notice | null = null;
	ownedNoticeHiders.push(() => {
		if (whatsNewUntilTapped?.messageEl?.isConnected) whatsNewUntilTapped.hide();
		whatsNewUntilTapped = null;
	});

	function onunload(this: HandwritingPlugin): void {
		// First, so that anything still waiting on onLayoutReady finds it set.
		this.unloaded = true;
		// A live trace would outlive this instance; stop it, saved nowhere in
		// the vault, but only when this recorder started one or diagnostics is
		// on. Unload tests run this on an Object.create instance, where field
		// initializers never ran and settings may be absent.
		void stopTraceAtUnload(this.inkTrace, this.settings?.devDiagnostics === true);
		// The main-thread probe runs on its own while recording; a recording
		// left on would keep its timer and observer running in this unloaded
		// copy until Obsidian restarts. Stop the instrument, not the switch.
		stopMainThreadProbe();
		this.pdfPathById?.clear();
		// Each note's zoom and scroll is kept in local storage: a pending change is written now, then memory is emptied
		// and the store let go, so an editor torn down after this cannot rewrite the key.
		noteCameras.flush();
		noteCameras.clear();
		this.notePaper?.destroy();
		this.canvasOverride?.destroy();
		// Pending recycles are DROPPED, never run early. A sidecar left in
		// place is an orphan somebody can delete; ink recycled for a note
		// that was about to come back is the failure this delay exists to
		// prevent, and unload is exactly when a sync is most likely still
		// mid-pair. The next session's delete will schedule it again.
		for (const pending of this.pendingRecycle.values()) window.clearTimeout(pending.timer);
		this.pendingRecycle.clear();
		this.pdfStore.cancelPendingDeletes();
		// Same reasoning for pending declaims: not confirming one leaves a
		// note holding an id it may no longer carry, which the next session's
		// census resolves. Confirming one at unload could free an id from a
		// note whose frontmatter was mid-edit when the plugin went down.
		for (const timer of this.declaimTimers.values()) window.clearTimeout(timer);
		this.declaimTimers.clear();
		// No paper class and no page guides' off class on any window: a
		// disabled plugin leaves every body as Obsidian made it.
		this.applyPaper("none", false);
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
		// lose pending ink.
		runDetached(this.finishPersistence(), "finish persistence during unload");
	}

	/** The first launch after an update says what changed, once. */
	function showWhatsNewIfDue(this: HandwritingPlugin): void {
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
		// one version that can have been caught, once per device: at the launch
		// that first marks that vault's old-ink pressure pending on this device
		// (LegacyPressureLock.ts). Not keyed on `lastSeenVersion` alone: the
		// 1.5.0 notes record the version only on a tap, so `1.4.20` can be read
		// at every launch until then.
		//
		// It goes FIRST, above the what's-new block. That block swallows its
		// own failure and returns early so its notes retry next launch, and
		// anything after it is skipped on that path - which would drop the one
		// message this release exists to deliver.
		//
		// Reads only. Nothing about the setting is changed for them: which of
		// these vaults wanted pressure on is not ours to guess.
		if (this.legacyPressureNoticeDue === true) {
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

		const record = (): void => {
			// A tap on notes left up by an unloaded copy must not write: a newer copy may have recorded its own version.
			if (this.unloaded) return;
			if (d.record === this.settings.lastSeenVersion) return;
			this.settings.lastSeenVersion = d.record;
			runDetached(this.persistSettings(), "remember the version whose notes were shown");
		};
		if (d.show) {
			try {
				const untilTapped = whatsNewStaysUntilTapped(d.version);
				const notice = new Notice(
					whatsNewFragment(d.version, d.notes, d.groups),
					untilTapped ? 0 : whatsNewDurationMs(d.notes.length)
				);
				// No timeout, and seen only once tapped: a launch that ends without a tap shows the notes again.
				if (untilTapped) {
					whatsNewUntilTapped = notice;
					notice.containerEl.addEventListener("click", () => {
						notice.hide();
						record();
					});
					return;
				}
			} catch (err) {
				// Recording first would spend the one chance this user gets.
				// The notes appear on exactly ONE launch, so a popup that threw
				// is a popup nobody will ever read: leave the version
				// unrecorded and let the next launch try again.
				console.error("[handwriting] the what's new notice failed to open", err);
				return;
			}
		}
		record();
	}

	function syncRecordingBadge(this: HandwritingPlugin): void {
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
	function guardEmptyTrace(this: HandwritingPlugin): boolean {
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
	function flushOnHide(this: HandwritingPlugin): void {
		// A hide can come with no blur, so a stroke still on the glass is ended
		// here, committed as a blur commits it, before the dispatch writes it.
		finishLiveStrokesOnHide();
		finishSlidesGesture();
		this.store.flushDispatch();
		// flushSettings clears its timer and reaches saveData synchronously;
		// detached because its completion cannot be awaited under a freeze.
		runDetached(this.flushSettings(true), "flush settings on hide");
		// Ink parked behind a sidecar read or a claim reaches the store only when
		// that lands, and then waits out the quiet period. If JS still runs, write
		// it the moment it lands; a freeze before then is the known limit.
		runDetached(settleParkedThenDispatch(this), "flush parked ink on hide");
	}

	/** How long a close waits on unsaved ink before the window goes anyway. */
	const QUIT_CAP_MS = 3000;

	/**
	 * Closing the desktop app. Obsidian's quit hook triggers "quit" with a task list and, when a task was added,
	 * holds the window on "Saving..." until every task settles. The list waits with no timeout and a task that
	 * rejects stops the close, so the one task added here is capped and never rejects. No task when nothing is
	 * pending, so a close with no unsaved ink is not held at all. No notice: the window is going.
	 */
	function flushOnQuit(this: HandwritingPlugin, tasks: Tasks): void {
		try {
			finishLiveStrokesOnHide();
			finishSlidesGesture();
			this.store.flushDispatch();
		} catch (err) {
			console.error("[handwriting] dispatch at quit failed", err);
		}
		const pending =
			inlineInk.parkedInk() || slidesParkedInk() || this.pdfStore.parkedInk() || this.store.hasAnyQueuedWrite();
		if (!pending) return;
		tasks.add(() => {
			let timer = 0;
			const cap = new Promise<void>((resolve) => {
				timer = window.setTimeout(resolve, QUIT_CAP_MS);
			});
			const work = saveAtQuit(this).catch((err) => console.error("[handwriting] save at quit failed", err));
			return Promise.race([work, cap]).finally(() => window.clearTimeout(timer));
		});
	}

	/** The three settles together, then every queued page, then settings. A flush that throws still lets settings go. */
	async function saveAtQuit(plugin: HandwritingPlugin): Promise<void> {
		await Promise.allSettled([inlineInk.settle(), settleSlidesInk(), plugin.pdfStore.settle()]);
		try {
			await plugin.store.flush();
		} catch (err) {
			console.error("[handwriting] flush at quit failed", err);
		}
		await plugin.flushSettings();
	}

	/** finishPersistence's three settles, then a dispatch. Each settle is bounded; one that throws stops none. */
	async function settleParkedThenDispatch(plugin: HandwritingPlugin): Promise<void> {
		await Promise.allSettled([inlineInk.settle(), settleSlidesInk(), plugin.pdfStore.settle()]);
		plugin.store.flushDispatch();
	}

	/** Best-effort shutdown: settle in-flight claims and loads, then flush. */
	async function finishPersistence(this: HandwritingPlugin): Promise<void> {
		// A settle gives up at its deadline whenever a read or claim is still open.
		// Ink parked behind one is unsaved whether or not a write is queued, so it
		// counts toward the notice; an open read with no ink behind it does not,
		// or a slow read at quit warns about ink that was never at risk.
		let gaveUp = false;
		try {
			if ((await inlineInk.settle()) === false && inlineInk.parkedInk()) gaveUp = true;
		} catch (err) {
			console.error("[handwriting] settle on unload failed", err);
		}
		try {
			// The presentation keeps its own claim and load promises, which
			// `inlineInk.settle()` cannot see: a deck torn down inside the
			// ~100-300 ms a first-stroke claim takes has a write parked behind
			// it, and flushing the store before that lands writes nothing.
			if ((await settleSlidesInk()) === false && slidesParkedInk()) gaveUp = true;
		} catch (err) {
			console.error("[handwriting] slides settle on unload failed", err);
		}
		try {
			// Same reason, the PDF store: a stroke drawn while its sidecar is
			// still being read reaches the page store only when the read lands.
			if ((await this.pdfStore.settle()) === false && this.pdfStore.parkedInk()) gaveUp = true;
		} catch (err) {
			console.error("[handwriting] pdf settle on unload failed", err);
		}
		try {
			await this.store.flush();
		} catch (err) {
			console.error("[handwriting] flush on unload failed", err);
		}
		// A failed write goes back in the queue and `flush` still resolves, and
		// at unload no retry timer will ever run it: say so while the user can
		// still act.
		if (gaveUp || this.store.hasAnyQueuedWrite()) {
			new Notice(
				"Handwriting: the newest ink may not have been saved. Open the note and check it before you close Obsidian."
			);
		}
		try {
			await this.flushSettings();
		} catch (err) {
			console.error("[handwriting] settings flush on unload failed", err);
		}
	}

	/** Open the pen probe in a new tab. Its own leaf, so the note stays put. */
	async function openPenDiagnostics(this: HandwritingPlugin): Promise<void> {
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({
			type: HANDWRITING_DIAGNOSTICS_VIEW_TYPE,
			active: true,
		});
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
	function startSlidesInk(this: HandwritingPlugin): void {
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
			// The inline duplicate lock is the one record of an unresolved
			// shared id; the other note's name is for the notice.
			duplicateLockedWith: (path) => {
				if (!inlineInk.isDuplicateLocked(path)) return null;
				const id = this.notePageId(path);
				return (id ? this.findOtherCarrier(id, path) : null) ?? "another note";
			},
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

export function installPluginLifecycle(proto: HandwritingPlugin): void {
	installMethods(proto, {
		onunload,
		showWhatsNewIfDue,
		syncRecordingBadge,
		guardEmptyTrace,
		flushOnHide,
		flushOnQuit,
		finishPersistence,
		openPenDiagnostics,
		startSlidesInk,
	});
}
