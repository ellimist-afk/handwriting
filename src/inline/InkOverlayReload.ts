/**
 * The note surface's reload and identity: the file and pane it shows, CodeMirror's update and the note switch, and
 * the external reload and its bindings. They are methods of InkOverlayPlugin, installed on its prototype when
 * InkOverlay.ts loads.
 */
import { ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type { Editor, TFile } from "obsidian";
import { stripPenUp } from "./StripPenChrome";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";
import { inkApplied, inkEffect } from "./InkHistory";
import { discardUndoTrace, unregisterUndoTraceView } from "../diag/UndoHistoryTrace";
import { MIN_PINCH_SCALE } from "./PinchScale";
import { canvasForNote } from "./CanvasNoteOverride";
import { installMethods } from "./InstallMethods";
import { enabled, inlineInk, instances, scrollExpansionEnabled, type InkOverlayPlugin, type InlineReloadBinding } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		showsPath(path: string): boolean;
		ownsActiveEditor(editor: Editor, file: TFile): boolean;
		filePath(): string | null;
		ownsMarkdownEditorRoot(): boolean;
		update(u: ViewUpdate): void;
		updateInner(u: ViewUpdate): void;
		noteExternallyReloaded(path: string): void;
		renamedFrom(lastPath: string | null, path: string | null, file: unknown): boolean;
		invalidateReloadBindings(...paths: (string | null)[]): void;
		reloadBinding(): InlineReloadBinding | null;
		reloadCandidatePath(): string | null;
		setCanvasMomentumDisabled(on: boolean): void;
	}
}

	/** Whether this mounted overlay is showing `path` right now. */
	function showsPath(this: InkOverlayPlugin, path: string): boolean {
		return this.container !== null && this.filePath() === path;
	}

	/**
	 * Whether this mounted overlay is the pane behind `editor`, showing
	 * `file`. The predicate half of `overlayForActiveEditor`, here because the
	 * view is private and stays that way.
	 *
	 * Read live from the same `editorInfoField` `filePath()` reads, and for
	 * the same reason it is read live: Obsidian reuses editors, so a cached
	 * answer can outlive the pairing it was true for.
	 */
	function ownsActiveEditor(this: InkOverlayPlugin, editor: Editor, file: TFile): boolean {
		if (this.container === null) return false;
		const info = this.view.state.field(editorInfoField, false);
		if (!info) return false;
		return info.editor === editor && info.file === file;
	}

	/** The file behind this editor, resolved live, because Obsidian reuses editors. */
	function filePath(this: InkOverlayPlugin): string | null {
		const info = this.view.state.field(editorInfoField, false);
		return info?.file?.path ?? null;
	}

	/**
	 * Table-cell editors inherit the note owner, but never own its ink surface.
	 * Neither do embedded editors (hover and footnote popovers, Canvas file
	 * cards, editable embeds): their owner names the whole note while their
	 * document can hold one section, so y = 0 is the section's first line and
	 * ink would be saved and erased against the wrong origin (audit #13).
	 */
	function ownsMarkdownEditorRoot(this: InkOverlayPlugin): boolean {
		const dom = this.view.dom;
		const root = dom.closest(".markdown-source-view");
		// Read live DOM in this view's document, including while detached. The
		// host removes a cell editor's own source-view class before initializing
		// it; after attachment, the parent's source view must not qualify it.
		return root !== null && root.ownerDocument === dom.ownerDocument
			&& (root === dom || root.querySelector(".cm-editor") === dom)
			&& !dom.parentElement?.closest(".cm-editor")
			&& !dom.closest(".table-cell-wrapper, .cm-table-widget")
			&& !dom.closest(".markdown-embed, .hover-popover");
	}

	function update(this: InkOverlayPlugin, u: ViewUpdate): void {
		// EVERY ROUTE OUT OF HERE IS INSIDE CODEMIRROR'S UPDATE. The routes
		// that can release the measure hold are handled by name (the file
		// switch's reset defers its measure; a font-size reflow's resize is
		// deferred whole, `resizeOutOfUpdate`). The flag is the net for a
		// route nobody named: a release under it defers its measure and says so.
		this.inUpdate = true;
		try { this.updateInner(u); } finally { this.inUpdate = false; }
	}

	function updateInner(this: InkOverlayPlugin, u: ViewUpdate): void {
		// Ink history ops re-dispatched by the editor's undo/redo. Original
		// gestures carry the inkApplied annotation (the store already reflects
		// them); anything else is history's work and gets applied here. The op
		// carries its own path, so undo after a file switch still acts on the
		// note where the ink lives. FIRST, before either return below: an undo
		// taken while the editor's root is lost (a tab being moved), or as the
		// update that mounts the overlay again, took the step off the editor's
		// history and never reached the ink, so the stroke stayed and the next
		// undo took something else (item 6b). The ops touch only the store.
		for (const tr of u.transactions) {
			if (tr.annotation(inkApplied)) continue;
			for (const effect of tr.effects) {
				if (effect.is(inkEffect)) this.applyInkOp(effect.value, tr.docChanged);
			}
		}
		// Attachment/reparenting can change ownership without changing the file.
		// Retire a surface that lost its root; a later valid update can remount it.
		if (!this.ownsMarkdownEditorRoot()) {
			if (this.container) this.unmount();
			return;
		}
		const hold = this.panAnchorHold;
		if (hold && u.transactions.some(tr => tr.docChanged || tr.selection || tr.scrollIntoView || tr.effects.some(effect => !hold.issuance.includes(effect)))) this.retirePanSettle("a transaction the settle did not issue");
		if(u.docChanged)this.clearSpaceFeedback();
		if (!this.container) {
			if (enabled) this.mount();
			return;
		}
		// Obsidian reuses the same editor across file switches. When a
		// different note takes over, NOTHING of the previous note's ink may
		// survive on screen: drop any in-flight stroke, wipe the transient
		// layers, and repaint committed ink from the new file's store entry
		// (which clears the canvas even when that entry is empty). Without
		// this the old bitmap sat there until the next repaint trigger: the
		// v0.9.1 cross-file ink leak.

		const path = this.filePath();
		const file = this.currentFile();
		if (path === this.lastPath) this.lastFile = file;
		else if (this.renamedFrom(this.lastPath, path, file)) {
			// A rename or move of the open note. The stores were re-keyed by the vault's rename handler; the
			// view keeps its scroll, zoom, selection and toolbar, which the note-switch reset below would drop.
			// An external-reload capture taken before the rename names the old path, so it is retired as a switch does.
			this.invalidateReloadBindings(this.lastPath, path);
			this.lastPath = path;
			this.updateHandwritingPageClass();
		} else {
			// The note leaving keeps its zoom and scroll for when it comes back; read before the reset below.
			this.saveNoteCamera();
			this.lastFile = file;
			this.endPreviewPaper("note-switch");
			this.cancelOverscrollBounce();
			this.cameraOriginY = null;
			this.invalidateReloadBindings(this.lastPath, path);
			this.reloadCameraSettlement = null;
			if (diagnosticsEnabled() && this.undoIdentity) {
				discardUndoTrace(this.undoIdentity);
				unregisterUndoTraceView(this.view.dom);
				this.undoIdentity = null;
				this.undoIdentityStale = false;
			} else if (this.undoIdentity) {
				this.undoIdentity = null;
				this.undoIdentityStale = true;
			}
   this.restoreViewportLayout();
   // The release took the paper off; the note that now opens paints with its
   // at-rest paper from its first frame, re-planned here from the last text
   // size and origin (updateExtent moves the phase if this note's origin differs).
   this.updatePaperSpacing();
   this.pinchScaleNow=1; this.zoomFloor=MIN_PINCH_SCALE; this.pinchRasterScale=1; this.rasterColumnLocal=null; this.previewAnchorStale=false;
   // The column-margin bookkeeping belongs to the camera just reset: a new note starts without a baseline or a debt.
   this.restingColumnMargin=null; this.columnMarginDebt=0;
   this.pinchPending=null; this.pinchAnchor=null; this.pinchRefScale=null;
   this.view.scrollDOM.scrollLeft=0; this.view.scrollDOM.scrollTop=0;
   this.scrollExpansion?.rebase(0,0);
			this.lastPath = path;
			this.armNoteCameraRestore(path);
			// The opened note's own canvas answer, as a mount takes it: the pane may have shown a note with the other answer.
			this.canvasMode = canvasForNote(path, scrollExpansionEnabled);
			this.router?.setCanvasMomentumDisabled(this.canvasMode);
			this.updateHandwritingPageClass();
			// A fresh note starts reading, so the strip starts as the pill.
			this.mobileTools?.closeInkSliders();
			this.mobileTools?.setCollapsed(true);
			this.builder = null;
			this.resetGestureState();
			// A stroke held across the switch left its frame ticker running on the
			// note that is gone (audit 109).
			this.stopFrameTicker();
			// A different note has heard nothing yet, so the empty-page refusal
			// is news again. Here rather than inside resetGestureState, which an
			// abandoned gesture also runs - on the same note, mid-scrub.
			this.emptyNotice.forgetAll();
			// resetGestureState() only clears the overlay's own drawing state
			// (mode, selection, drag...). The router is a separate object with
			// its own gesture memory - an in-flight stroke and the pen-click
			// ownership guard it arms - that survives a file switch untouched
			// unless told otherwise, because Obsidian reuses this editor (and
			// this router) across notes.
			//
			// A stroke abandoned here (a claimed pen contact whose lift was
			// lost across the switch - a finger resting on the glass through
			// it, same shape as the click-suppressor bug this call already
			// fixes) called stripPenDown -> setInking(true) on the OLD note
			// and, because abandonActiveStroke ends the gesture without a
			// PointerEvent, never reaches the normal onPenUp -> penUp ->
			// stripPenUp -> setInking(false) that would put it back. That
			// leaves the strip and its collapsed pill wearing `is-inking`
			// (opacity 0, pointer-events none - styles.css ".is-inking") on the
			// NEW note: not merely invisible but unhit-testable, so every pen
			// tap on the toolbar strip lands on whatever is under it instead
			// and nothing happens. abandonActiveStroke() reports whether it
			// actually tore down a live stroke; only then is there stale
			// pen-down chrome to undo, so stripPenUp runs exactly then and a
			// routine switch with nothing to abandon stays the no-op it was.
			if (this.router?.abandonActiveStroke()) {
				stripPenUp(this.mobileTools, this.noteZoomControls);
			}
			this.wet.clear(this.cssWidth, this.cssHeight);
			this.highlightWet.clear(this.cssWidth, this.cssHeight);
			// A file switch mid-handoff would otherwise strand the wet
			// highlighter element hidden for the next note.
			this.highlightWetCanvas.setCssStyles({ opacity: String(HIGHLIGHTER_ALPHA) });
			this.tail.clearAll(this.cssWidth, this.cssHeight);
			this.tail.prepareLive(null, null);
			this.spaceFeedbackKey = null;
			this.scheduleRepaint();
			this.loadInk(path);
			return;
		}
		// Reflow, resize, edits, viewport moves: committed ink repaints from
		// note-surface coordinates. Note what is NOT here: nothing repositions
		// strokes. Text edits are invisible to ink by construction.
		if (u.geometryChanged || u.viewportChanged || u.docChanged) {
			// Font-zoom edge: the quick-font-size reflow arrives here as a
			// geometry update. One string compare against a LIVE computed
			// style. No per-frame polling, no new style objects.
			if (
				u.geometryChanged &&
				this.contentStyle &&
				this.contentStyle.fontSize !== this.lastFontStr
			) {
				// Under a held preview this resize can reach commitCameraScale,
				// whose release runs CodeMirror's measure; that must not happen
				// inside CodeMirror's own update, and deferring only the release
				// would put the settle's scroll write before the fold. So the
				// WHOLE resize moves to a frame of its own (`resizeOutOfUpdate`).
				if (this.measureHold) this.resizeOutOfUpdate(); else this.handleResize();
			}
			// "scroll", not the default: the default marks the whole surface
			// damaged and the index dirty, so every keystroke in a note with
			// ink re-rasterized every visible stroke and rebuilt the index -
			// for an edit that cannot move ink, by construction. "scroll"
			// asks for a repaint without asserting damage, and repaint()
			// already upgrades ANY camera motion to a full one, which is what
			// a reflow actually produces. The paths that do move ink (the
			// lasso drag, insert-space and its correction) mark their own
			// damage and are unaffected.
			this.scheduleRepaint("scroll");
		}
		this.updateLineAnchors(u);
	}

	/** See inkExternallyReloaded. */
	function noteExternallyReloaded(this: InkOverlayPlugin, path: string): void {
		if (this.filePath() !== path) return;
		// The adopted file may name another font reference than the one latched
		// here; its ink is in that frame, and so is what is drawn from now on.
		this.adoptStoredFontRef(path);
		if (this.selection.clear()) this.redrawSelectionUI();
		this.scheduleRepaint("external-reload");
	}

	/**
	 * Is the open note at `path` the note last seen at `lastPath`, renamed or moved? Identity first: two known
	 * file objects decide alone, and the store's rename record is asked only when either is unknown. A record
	 * that a rename left behind could otherwise turn a later switch between two different files into a rename
	 * (a new note made at the freed path, then back to the renamed one), keeping the old view. The
	 * record is still consumed when identity recognises the rename, so it cannot linger; a second pane on the
	 * same note knows it by its file object.
	 */
	function renamedFrom(this: InkOverlayPlugin, lastPath: string | null, path: string | null, file: unknown): boolean {
		const history = lastPath !== null && path !== null;
		if (file !== null && this.lastFile !== null) {
			if (file !== this.lastFile) return false;
			if (history) inlineInk.consumeRename(lastPath, path);
			return true;
		}
		return history && inlineInk.consumeRename(lastPath, path);
	}

	function invalidateReloadBindings(this: InkOverlayPlugin, ...paths: (string | null)[]): void {
		// Invalidate existing captures even if a sibling joins and leaves before
		// the await completes. No retained path registry or new timer is needed.
		for (const pane of instances) {
			if (pane === this || (pane.container && paths.includes(pane.filePath()))) pane.reloadBindingEpoch++;
		}
	}

	/** Binding identity is available independently of this pane's busy state. */
	function reloadBinding(this: InkOverlayPlugin): InlineReloadBinding | null {
		if (!this.container?.isConnected || !this.view.dom.isConnected) return null;
		const info = this.view.state.field(editorInfoField, false);
		if (!info?.file?.path) return null;
		return { pane: this, attachment: this.container, epoch: this.reloadBindingEpoch, file: info.file,
			editor: info.editor, path: info.file.path,
			quiet: this.builder === null && this.mode === "ink" && this.selection.isEmpty &&
				!this.router?.isStroking && !this.router?.hasActiveNavigation && this.pinchRefScale === null &&
				!this.pinchPreview && this.pinchPending === null && this.pinchRaf === 0 && this.reloadCameraSettlement === null };
	}

	/** This editor's path, when no ink gesture or retained selection is active. */
	function reloadCandidatePath(this: InkOverlayPlugin): string | null {
		const binding = this.reloadBinding();
		return binding?.quiet ? binding.path : null;
	}

	function setCanvasMomentumDisabled(this: InkOverlayPlugin, on: boolean): void {
		if (this.panAnchorHold) this.panAnchorHold.expansion = null;
		this.scrollExpansion?.rebase(this.view.scrollDOM.scrollLeft, this.view.scrollDOM.scrollTop);
		this.router?.setCanvasMomentumDisabled(on);
	}

export function installReload(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		showsPath,
		ownsActiveEditor,
		filePath,
		ownsMarkdownEditorRoot,
		update,
		updateInner,
		noteExternallyReloaded,
		renamedFrom,
		invalidateReloadBindings,
		reloadBinding,
		reloadCandidatePath,
		setCanvasMomentumDisabled,
	});
}
