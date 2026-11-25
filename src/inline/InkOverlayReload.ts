/**
 * The note surface's reload and identity: the file and pane it shows, CodeMirror's update and the note switch, and
 * the external reload and its bindings. They are methods of InkOverlayPlugin, installed on its prototype when
 * InkOverlay.ts loads.
 */
import { Annotation, EditorSelection, Transaction, type ChangeSet, type SelectionRange, type Text } from "@codemirror/state";
import { EditorView, ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type { Editor, TFile } from "obsidian";
import { stripPenUp } from "./StripPenChrome";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { traceInkReload, traceNoteOpen } from "../diag/NoteTraceRows";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";
import { inkApplied, inkEffect } from "./InkHistory";
import { discardUndoTrace, unregisterUndoTraceView } from "../diag/UndoHistoryTrace";
import { MIN_PINCH_SCALE } from "./PinchScale";
import { canvasForNote } from "./CanvasNoteOverride";
import { installMethods } from "./InstallMethods";
import { onPageIdClaim } from "./InlineInkStorePersist";
import { bodyFromOf } from "./LineAnchor";
import { enabled, inlineInk, instances, scrollExpansionEnabled, type InkOverlayPlugin, type InlineReloadBinding } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		showsPath(path: string): boolean;
		ownsActiveEditor(editor: Editor, file: TFile): boolean;
		filePath(): string | null;
		ownsMarkdownEditorRoot(): boolean;
		update(u: ViewUpdate): void;
		updateInner(u: ViewUpdate): void;
		noteExternallyReloaded(path: string, strokesChanged?: boolean): void;
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

	/** The character at an editor's top edge just before our page id write, waiting for that write to reach the editor. */
	interface ClaimAnchor { path: string; pageId: string; doc: Text; pos: number; fromBody: number; offset: number; scrollTop: number; at: number }

	/** The waiting anchor of each editor. */
	const claimAnchors = new WeakMap<InkOverlayPlugin, ClaimAnchor>();

	/** Marks the transaction that asks for the anchor's text back after the page id write. */
	const claimScrollKept = Annotation.define<true>();

	/** How long an anchor waits for the write to reach the editor, ms. */
	const CLAIM_KEEP_MS = 3000;

	/** How many characters at the anchor must read the same after the write. */
	const CLAIM_TEXT_CHECK = 32;

	/** Line length from which the editor draws a line in parts: lines wrapping, lines not wrapping. */
	const PARTS_WRAP = 20000, PARTS_NO_WRAP = 4000;

	/** The body's first character: the start of the line under a leading frontmatter block, 0 when there is none. */
	function bodyStart(doc: Text): number {
		return doc.line(bodyFromOf(doc)).from;
	}

	/** Whether the editor draws the line at `pos` in parts. */
	function drawnInParts(view: EditorView, doc: Text, pos: number): boolean {
		return doc.lineAt(pos).length >= (view.lineWrapping ? PARTS_WRAP : PARTS_NO_WRAP);
	}

	/** Whether the editor is inside its own update, where a layout read throws. */
	function editorUpdating(pane: InkOverlayPlugin): boolean {
		return pane.inUpdate || (pane.view as unknown as { updateState?: number }).updateState === 2;
	}

	/** A box's scale on screen against its layout size, 1 near 1, as the editor reads it for a scroll request. */
	function screenScale(onScreen: number, layout: number): number {
		const k = onScreen / layout;
		return !Number.isFinite(k) || (k > 0.995 && k < 1.005) || Math.abs(onScreen - layout) < 1 ? 1 : k;
	}

	/** The top on screen of the character at `pos`, px, from the page's own boxes; null with no box or a node outside the text. */
	function textTop(view: EditorView, pos: number): number | null {
		const at = view.domAtPos(pos);
		let node: Node = at.node, i = at.offset;
		if (!view.contentDOM.contains(node)) return null;
		if (node.nodeType !== 3) {
			const next = node.childNodes[i], prev = node.childNodes[i - 1];
			if (next) { node = next; i = 0; } else if (prev) { node = prev; i = prev.nodeType === 3 ? (prev as CharacterData).length : 0; }
		}
		let rect: { top: number; width: number; height: number } | undefined;
		if (node.nodeType === 3) {
			const len = (node as CharacterData).length, doc = node.ownerDocument;
			if (len === 0 || !doc) return null;
			const range = doc.createRange(), from = Math.min(i, len - 1);
			range.setStart(node, from);
			range.setEnd(node, from + 1);
			rect = range.getClientRects()[0];
		} else if (node.nodeType === 1) rect = (node as Element).getBoundingClientRect();
		return !rect || (rect.width === 0 && rect.height === 0) ? null : rect.top;
	}

	/** The character at the editor's top edge and its top's offset from that edge, px; null when the pane has no layout or that character is not inside the view both ways, on screen and inside the editor's margin cut. */
	function topAnchor(view: EditorView): { pos: number; offset: number } | null {
		const scroller = view.scrollDOM;
		if (scroller.clientHeight === 0) return null;
		const box = scroller.getBoundingClientRect();
		const { top, left } = box;
		const bottom = top + scroller.clientHeight * Math.min(screenScale(box.height, scroller.offsetHeight), 1);
		const right = left + scroller.clientWidth * screenScale(box.width, scroller.offsetWidth);
		const pos = view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + 1, y: top + 1 }, false);
		const at = view.coordsAtPos(pos, 1);
		if (!at || at.bottom <= top || at.top >= bottom || at.left < left || at.right > right) return null;
		const textAt = textTop(view, pos);
		return textAt === null ? null : { pos, offset: textAt - top };
	}

	/** Note the anchor of one editor of the note. */
	function armClaimAnchor(pane: InkOverlayPlugin, path: string, pageId: string): void {
		claimAnchors.delete(pane);
		if (!pane.showsPath(path) || !pane.ownsMarkdownEditorRoot()) return;
		try {
			const anchor = topAnchor(pane.view);
			const doc = pane.view.state.doc;
			const from = bodyStart(doc);
			if (anchor && anchor.pos >= from) claimAnchors.set(pane, { path, pageId, doc, ...anchor, fromBody: anchor.pos - from, scrollTop: pane.view.scrollDOM.scrollTop, at: performance.now() });
		} catch (err) {
			console.error("[handwriting] reading the text at the top before the page id write failed", err);
		}
	}

	/** Before our page id write: note the anchor of each open editor of the note, after any update it is inside. */
	function anchorTextForClaim(path: string, pageId: string): void {
		for (const pane of instances) {
			if (!pane.showsPath(path)) continue;
			if (editorUpdating(pane)) queueMicrotask(() => armClaimAnchor(pane, path, pageId));
			else armClaimAnchor(pane, path, pageId);
		}
	}

	/** After our page id claim: a claim that wrote nothing drops its anchors. */
	function settleClaimAnchors(path: string, pageId: string, written: boolean): void {
		if (written) return;
		for (const pane of instances) {
			const anchor = claimAnchors.get(pane);
			if (anchor && anchor.path === path && anchor.pageId === pageId) claimAnchors.delete(pane);
		}
	}

	/** Whether a change inserts text holding `text`, in any shape. */
	function insertsHolding(changes: ChangeSet, text: string): boolean {
		let holds = false;
		changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
			if (!holds && inserted.toString().includes(text)) holds = true;
		});
		return holds;
	}

	/** When our page id write reaches this editor, ask it once for the anchor's text at its offset, after the update, same task; never on a line drawn in parts. */
	function restoreAfterClaim(pane: InkOverlayPlugin, u: ViewUpdate): void {
		const anchor = claimAnchors.get(pane);
		if (!anchor || !u.docChanged) return;
		claimAnchors.delete(pane);
		if (performance.now() - anchor.at > CLAIM_KEEP_MS || pane.filePath() !== anchor.path || u.startState.doc !== anchor.doc) return;
		if (!insertsHolding(u.changes, anchor.pageId)) return;
		if (Math.abs(pane.view.scrollDOM.scrollTop - anchor.scrollTop) > 1) return;
		const doc = u.state.doc;
		const from = bodyStart(doc);
		const pos = from + anchor.fromBody;
		const len = Math.min(CLAIM_TEXT_CHECK, anchor.doc.length - anchor.pos);
		if (pos + len > doc.length || doc.sliceString(pos, pos + len) !== anchor.doc.sliceString(anchor.pos, anchor.pos + len)) return;
		if (drawnInParts(pane.view, doc, from) || drawnInParts(pane.view, doc, pos)) return;
		queueMicrotask(() => askClaimText(pane, anchor.path, doc, pos, anchor.offset));
	}

	/** The requests this file made after a page id write, by their own object, each with its anchor's offset from the view's top, px. */
	const claimRequests = new WeakMap<object, number>();

	/** In the editor's scroll handler, inside its update: our page id write's own request moves only the editor's scroll top, putting the anchor's text back at its offset, and never reaches the default; false for any other request, a lookalike too. */
	export function scrollClaimText(view: EditorView, range: SelectionRange, request: object | undefined): boolean {
		const offset = request === undefined ? undefined : claimRequests.get(request);
		if (offset === undefined) return false;
		try {
			const scroller = view.scrollDOM;
			if (scroller.clientHeight === 0) return true;
			const at = textTop(view, range.head);
			if (at === null) return true;
			const box = scroller.getBoundingClientRect();
			const move = (at - box.top - offset) / screenScale(box.height, scroller.offsetHeight);
			if (move !== 0) scroller.scrollTop += move;
		} catch (err) {
			console.error("[handwriting] keeping the text after the page id write failed", err);
		}
		return true;
	}

	/** Ask the editor once for the anchor's text at its offset. */
	function askClaimText(pane: InkOverlayPlugin, path: string, doc: Text, pos: number, offset: number): void {
		const view = pane.view;
		if (!pane.showsPath(path) || view.state.doc !== doc || view.scrollDOM.clientHeight === 0) return;
		try {
			const ask = EditorView.scrollIntoView(EditorSelection.cursor(pos, 1), { y: "start", yMargin: offset });
			claimRequests.set(ask.value as object, offset);
			view.dispatch({
				effects: ask,
				annotations: [claimScrollKept.of(true), Transaction.addToHistory.of(false)],
			});
		} catch (err) {
			console.error("[handwriting] keeping the text after the page id write failed", err);
		}
	}

	/** Whether an editor holds an anchor waiting for the page id write. */
	export function claimAnchorHeldForTest(pane: InkOverlayPlugin): boolean {
		return claimAnchors.has(pane);
	}

	/** Whether a transaction is a typed text edit: it changes the text with user event input.type, input.paste or delete. */
	function typedTextEdit(tr: Transaction): boolean {
		return tr.docChanged && (tr.isUserEvent("input.type") || tr.isUserEvent("input.paste") || tr.isUserEvent("delete"));
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
			const ops = tr.effects.filter((effect) => effect.is(inkEffect)).map((effect) => effect.value);
			// One step of several ink ops (a resize, rotate or drop with its groups' attach steps, an Insert Space with its
			// held groups') is one undo: every op is read against the store before any applies, and when one is spent (another
			// pane or device changed what it acts on) none applies and the step is spent. A live gesture ends first, as each
			// op's own apply would end it.
			if (ops.length > 1) {
				this.endLiveGestureForHistory();
				if (!ops.every((op) => this.inkOpStands(op, tr.docChanged))) continue;
			}
			for (const op of ops) this.applyInkOp(op, tr.docChanged);
		}
		// A typed text edit (a letter, a paste, a delete; their sub-events too, such as input.type.compose or delete.backward)
		// lets go of the ink selection. A finger tap that selected attached ink leaves the cursor where it was, so the next
		// letter lands there; a Backspace to take it back must be the text's, not a delete of the ink. A text change with no
		// such user event (another pane, a sync, a command) and a cursor move keep the selection.
		if (u.docChanged && u.transactions.some(typedTextEdit) && !this.selection.isEmpty) this.dissolveSelection();
		// Attachment/reparenting can change ownership without changing the file.
		// Retire a surface that lost its root; a later valid update can remount it.
		if (!this.ownsMarkdownEditorRoot()) {
			if (this.container) this.unmount();
			return;
		}
		const hold = this.panAnchorHold;
		if (hold && u.transactions.some(tr => !tr.annotation(claimScrollKept) && (tr.docChanged || tr.selection || tr.scrollIntoView || tr.effects.some(effect => !hold.issuance.includes(effect))))) this.retirePanSettle("a transaction the settle did not issue");
		restoreAfterClaim(this, u);
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
			// The layers still picture this note, and nothing repaints here: their record follows the note, or a note later
			// opened at the old path would match it and take this note's pixels as its stand-in (takeStandIn).
			if (this.paintedPath === this.lastPath) this.paintedPath = path;
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
			if (diagnosticsEnabled()) traceNoteOpen("switch", this.noteCameraRestore !== null, this.view.hasFocus);
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
			// style. No per-frame polling, no new style objects. The line height
			// too: a theme or snippet can move it with the font unchanged, and the
			// paper's pitch is the row height, re-read on the refresh path.
			if (
				u.geometryChanged &&
				this.contentStyle &&
				(this.contentStyle.fontSize !== this.lastFontStr || this.contentStyle.lineHeight !== this.lastLineHeightStr)
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
	function noteExternallyReloaded(this: InkOverlayPlugin, path: string, strokesChanged = true): void {
		if (this.filePath() !== path) return;
		traceInkReload(strokesChanged);
		// The adopted file may name another font reference than the one latched
		// here; its ink is in that frame, and so is what is drawn from now on.
		this.adoptStoredFontRef(path);
		// Its attached groups came with it, found again in this note's text.
		this.resolveAttachedText(path);
		// A selection holds stroke ids only; with the same strokes every one is still there.
		if (strokesChanged && this.selection.clear()) this.redrawSelectionUI();
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
	onPageIdClaim({ before: anchorTextForClaim, after: settleClaimAnchors });
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
