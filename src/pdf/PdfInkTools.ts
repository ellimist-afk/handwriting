/**
 * The pdf surface's pen tools strip and its pane lifecycle: building and destroying the strip, the strip's command dispatch, and
 * mount, unmount and the in-place document switch. They are methods of PdfInkController, installed on its prototype when PdfInkController.ts loads.
 */
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { InkTool } from "../ink/Stroke";
import { Platform } from "obsidian";
import { getPenToolsMode, onPenToolsChanged, penSeenThisSession, penToolsVisible } from "../inline/PenToolsMode";
import { deviceHasTouch } from "../inline/DeviceInput";
import { getInkColorHex } from "../ink/InkColor";
import { armMouseInkQuietlyEverywhere, getInkSizeMult, getInlineTool, penReticleEnabled, pickStripColor, releaseMouseInkQuietlyEverywhere } from "../inline/InkOverlay";
import { applyInkSize, applyToolbarPlacement, commitEraserRadius, getEraserRadiusPx, getEraserWholeStrokes, getInlineEraserMode, getInlineLassoMode, getInlinePanMode, getInlineSpaceMode, getToolbarCorner, persistEraserModeNow, setEraserRadiusPx, setEraserWholeStrokes, setInkSizeMult } from "../inline/InkOverlay";
import { mouseInkEnabled } from "../inline/MouseInk";
import { penInkEnabled } from "../inline/PenInk";
import { MobileTools } from "../inline/MobileTools";
import { clipboardSize } from "../inline/InkClipboard";
import { colorsFor } from "../ink/InkColor";
import { applyInkPreset, forgetInkPreset, inkPresetsFor, starInkPreset } from "../ink/InkPresets";
import { installMethods } from "../inline/InstallMethods";
import type { PdfInkController } from "./PdfInkController";

declare module "./PdfInkController" {
	interface PdfInkController {
		ensureTools(): void;
		ensureToolsInner(): void;
		buildTools(): void;
		stripExec(id: string): void;
		refreshStrip(): void;
		mount(): void;
		unmount(): void;
		forgetHistory(): void;
	}
}


	/**
	 * The floating pen strip, on the PDF view.
	 *
	 * The same component the note surface uses, against the same global tool
	 * state - so switching to the eraser on a PDF and switching back on a note
	 * are one setting, not two that drift. Almost every method here delegates
	 * to a module-level accessor for exactly that reason.
	 *
	 * Whether there is one at all is `penToolsVisible` (PenToolsMode.ts) and
	 * nothing else - the same call, with the same three arguments, that the
	 * note surface makes in `ensurePenToolsInner`. That rule had exactly ONE
	 * caller in the tree until 1.4.8, and it was not this one: this method
	 * built a strip on the first pen contact and consulted nothing, so
	 * Settings → Appearance → Pen toolbar → Hide hid the strip on notes and
	 * left it floating over every PDF (alan, 2026-09-02). Sixth entry on
	 * StripPenChrome.ts's list, and the call below is now pinned by that
	 * file's repo-wide sweep: any file constructing a MobileTools has to ask
	 * the rule, or say in writing why it does not.
	 *
	 * On a desktop with no pen and the rule left on "auto" this still builds
	 * nothing, which is what it did before - but now because the rule says so
	 * rather than because nothing happened to call it, so "show" gives a pane
	 * a strip with no pen anywhere near it, exactly as a note gets one.
	 */
	function ensureTools(this: PdfInkController): void {
		try {
			this.ensureToolsInner();
		} catch (err) {
			// A strip that cannot mount must never take the ink down with it.
			// The note surface learned this on release day, on an iPad, where
			// chrome failing stopped the pen working entirely.
			console.error("[handwriting] pdf pen tools strip failed to mount", err);
		}
	}

	/**
	 * Create or destroy, not create-only.
	 *
	 * "Hide" chosen while a PDF is open has to take away the strip that is
	 * already on screen, and "auto" on a desktop that has not seen a pen has
	 * to do the same - so this answers the rule in both directions, the way
	 * `ensurePenToolsInner` does, and the subscription in `mount` is what
	 * calls it when the answer moves. `this.mounted` stands where the note
	 * surface asks `this.container !== null`: a controller whose pane has
	 * closed has no strip and grows none, whatever the setting does next.
	 */
	function ensureToolsInner(this: PdfInkController): void {
		const want =
			this.mounted &&
			penToolsVisible(getPenToolsMode(), Platform.isMobileApp, penSeenThisSession());
		// Same rebuild the note surface makes, for the same reason and in the
		// same place: `ButtonSpec.shownOn` is read once per strip, and the pen
		// latch behind the Keyboard button has a false-to-true edge that the
		// create-or-destroy test below cannot see. Written here as well as
		// there because the two surfaces owning one rule between them is what
		// this project's nine one-surface divergences were all made of.
		if (want && this.tools?.stale()) {
			this.tools.destroy();
			this.tools = null;
		}
		if (want === (this.tools !== null)) return;
		if (!want) {
			this.tools?.destroy();
			this.tools = null;
			return;
		}
		this.buildTools();
	}

	function buildTools(this: PdfInkController): void {
		this.tools = new MobileTools(this.root, {
			// Mouse ink is a global mode; the toggle command flips it and the
			// strip lights follow the input here exactly as on notes.
			mouseInkOn: () => mouseInkEnabled(),
			recordingOn: () => diagnosticsEnabled(),
			armMouseInkQuietly: () => armMouseInkQuietlyEverywhere(),
			disarmMouseInkQuietly: () => releaseMouseInkQuietlyEverywhere(),
			toast: (message) => this.notify(message),
			exec: (id) => this.stripExec(id),
			activeTool: () => getInlineTool(),
			// Drag to anchor: the SAME call the note surface makes, which is
			// the same call the settings dropdown makes. A placement dragged
			// on a pdf is the placement a note opens with, and it survives a
			// restart, because there is one road (`applyToolbarPlacement`,
			// InkOverlay.ts) and not a copy of it here.
			setPlacement: (corner) => applyToolbarPlacement(corner),
			eraserOn: () => getInlineEraserMode(),
			eraserWholeStroke: () => getEraserWholeStrokes(),
			// Same pairing the note host makes inline (InkOverlay.ts:1888-1891);
			// this host builds its spec in a different file and reaches the
			// module-private persist hook through `persistEraserModeNow`.
			setEraserWholeStroke: (on) => {
				setEraserWholeStrokes(on);
				persistEraserModeNow(on);
			},
			lassoOn: () => getInlineLassoMode(),
			spaceOn: () => getInlineSpaceMode(),
			panOn: () => getInlinePanMode(),
			toolColor: (tool) => getInkColorHex(tool as InkTool),
			eraserRadiusPx: () => getEraserRadiusPx(),
			setEraserRadiusPx: (px, commit) => {
				setEraserRadiusPx(px);
				if (commit) commitEraserRadius();
			},
			// This view's own ring, not the editor's history - there is no
			// CodeMirror here to ask.
			canUndo: () => this.history.depth.done > 0,
			canRedo: () => this.history.depth.undone > 0,
			// The id gate as well as the clipboard, audit doc §5k/AD4: a paste
			// offered while the document is still being hashed reached
			// `pasteFromClipboard`'s `if (!id) return` and did nothing at all,
			// with a lit button as the only account of it.
			canPasteInk: () => clipboardSize() > 0 && this.documentId() !== null,
			// The bounds, not the raw id list - the same question `hasSelection`
			// answers, and for the reason its own comment gives: ids outlive a
			// sidecar reload, so a selection whose strokes were deleted on
			// another device is a list of ids that match nothing.
			// `deleteSelection` resolves those ids against live strokes and
			// returns false when none match, and `idle` is true while a
			// completed selection is held, so the reload poll can run exactly
			// then - leaving a lit trash button, a click that passed the
			// enablement gate, and "lasso some ink first" over a visible
			// lasso. One question, one answer.
			hasInkSelection: () => this.hasSelection,
			paletteFor: (tool) => colorsFor(tool as InkTool),
			pickColor: (name, hex) => pickStripColor(name, hex),
			// The same four as the note strip: one feature, two surfaces.
			presetsFor: (tool) => inkPresetsFor(tool as InkTool),
			applyPreset: (tool, index) => applyInkPreset(tool as InkTool, index),
			starPreset: (tool) => starInkPreset(tool as InkTool),
			forgetPreset: (tool, index) => forgetInkPreset(tool as InkTool, index),
			inkSizeMult: (tool) => getInkSizeMult(tool as InkTool),
			// A drag moves the size; the release also saves it, the same road the note strip takes.
			setInkSizeMult: (tool, mult, commit) => {
				if (commit) applyInkSize(tool as InkTool, mult);
				else setInkSizeMult(tool as InkTool, mult);
			},
			// A NO-OP, and still the honest one now that this surface honours
			// pen off. There is no editor here to hand the keys to:
			// `armStripPenFocus` gives this root a `tabindex="-1"` so the
			// pen's own gestures can claim the keys, but that is not a
			// contenteditable and focusing it would raise no software
			// keyboard. Nothing is lost by that. Turning the pen off here is
			// a request to stop CLAIMING it (`penOff` on this controller's
			// router), and what the freed pen then taps - a form field, the
			// viewer's own search box - raises the keyboard itself, which is
			// what the note's forced focus is standing in for.
			setEditorFocus: () => {},
			// The same read the note host makes, because this router now
			// gates on the same flag (`penOff`, below). It answered an
			// unconditional `true` for two days, on the note-only rule the
			// owner then reversed - "why would you take keyboard mode away
			// from pdf" - and that left this strip's keyboard button dark
			// while the pen it describes was off (MobileTools.ts's
			// `penInksHere`).
			penInksHere: () => penInkEnabled(),
			// The same one implementation the note surface reads, for the same
			// reason it reads it there: a device fact must not have two
			// answers depending on which surface asked (DeviceInput.ts).
			hasTouch: () => deviceHasTouch(),
		});
		this.tools.setCorner(getToolbarCorner());
	}

	/**
	 * What a button on THIS controller's strip does.
	 *
	 * editor:undo/redo are native keybindings rather than plugin commands, so
	 * they were always answered here - this view has no CodeMirror to undo.
	 *
	 * The selection buttons are answered here too, audit doc §5k/AD1. Z moved
	 * their dispatch out to the commands on the reasoning that one
	 * implementation should have one caller; the implementation is shared (the
	 * commands call these same methods), but the DISPATCH cannot be, because
	 * the commands resolve a surface from the workspace and a strip button
	 * never takes focus - MobileTools preventDefaults pointerdown so the pen
	 * does not leave the page. Note left and active with a live lasso, PDF
	 * right, lasso on the PDF, press the PDF strip's trash: the command
	 * resolved the NOTE and deleted the note's strokes, and a paste put
	 * page-stamped PDF strokes into a note. The button knows its controller;
	 * the palette does not, so the palette keeps `activeInkSurface` and the
	 * button asks the controller it is mounted on.
	 */
	function stripExec(this: PdfInkController, id: string): void {
		if (id === "editor:undo" || id === "editor:redo") {
			this.historyStep(id === "editor:redo");
			return;
		}
		if (id === "handwriting:delete-selected-ink") {
			this.deleteSelectionCommand();
			return;
		}
		if (id === "handwriting:copy-selected-ink") {
			this.copySelection();
			return;
		}
		if (id === "handwriting:cut-selected-ink") {
			this.cutSelectionCommand();
			return;
		}
		if (id === "handwriting:paste-ink") {
			this.pasteFromClipboard();
			return;
		}
		this.exec(id);
	}

	/** The strip's active-tool marks are stale; recompute them. */
	function refreshStrip(this: PdfInkController): void {
		this.tools?.setCorner(getToolbarCorner());
		this.tools?.refresh();
		// Audit doc §5f: this is the fan-out that already runs on setting
		// changes for PDFs (addStripSurface, main.ts). If "Pen reticle" (or
		// Boox mode) turned off while the dot was showing - the pen held
		// still, no further hover sample to hit the new gate in showCursor -
		// the existing hide path is enough; no new plumbing needed.
		if (!penReticleEnabled()) this.hideCursor();
	}

	function mount(this: PdfInkController): void {
		this.mounted = true;
		// Focus belongs to the bound scroll container; key events bubble to this root.
		// The strip follows the setting for the life of this pane, not only at
		// pen contact. Notes hear about a change through `refreshPenToolsAll`
		// (InkOverlay.ts), which walks InkOverlay's own set of open editors and
		// has never known that a PDF pane exists - so this surface listens to
		// the rule itself instead of waiting to be told by a fan-out that was
		// never going to reach it.
		//
		// Dropped-then-taken rather than added to: mount is the one place that
		// binds, and a controller mounted twice must still hold exactly one
		// subscription.
		this.unwatchPenTools?.();
		this.unwatchPenTools = onPenToolsChanged(() => this.ensureTools());
		// And asked once now, so "show" - or "auto" on mobile, where the strip
		// is the only path to the tools - has a strip on a pane nobody has
		// inked yet. The note surface calls the same thing at its own mount.
		this.ensureTools();
		// No probe gate here. The viewer is not necessarily built when the leaf
		// appears, and a controller that returned early here stayed inert for
		// the life of the pane with nothing to say for itself - the same silent
		// death as binding to a viewer that was later replaced. Watching the
		// leaf costs nothing until there is something to see, and the first sync
		// that finds a scroller binds the pen to it.

		// The viewer's own windowing is a DOM mutation - canvases appearing
		// and disappearing inside page divs - so that is what we watch. A
		// scroll listener would fire far more often and tell us less: page
		// geometry does not move with scroll (M0).
		// Attributes as well as children. A trackpad pinch changes the zoom by
		// restyling pages and resizing the existing canvases - no element is
		// added or removed - so childList alone never fires and the overlays
		// are left at the old scale (hardware: the marks vanished on a
		// two-finger zoom). Every sync is coalesced into one frame, so a noisy
		// filter costs a boolean per mutation and nothing more.
		// Observed on the LEAF container, not on the scroller. The viewer
		// element can be replaced inside a leaf that survives, and an observer
		// bound to the old one never fires again - which is the difference
		// between noticing the swap and never syncing another frame. The root
		// contains the scroller, so every signal the old placement saw still
		// arrives here.
		const mo = new MutationObserver((mutations) => {
			// Audit doc §5b/D1: filter our own writes before anything else
			// runs, so a hovering pen - which only ever touches the reticle
			// and the scroller's hover class - stops re-invalidating the
			// probe cache it just filled. See `isOwnMutation`.
			const records = mutations.filter((m) => !this.isOwnMutation(m));
			if (records.length === 0) return;
			this.invalidateProbe();
			// A zoom that lands MID-GESTURE breaks the frozen frame's whole
			// contract: the wet preview keeps drawing in pre-zoom geometry on
			// a canvas the page just stretched - offset ink and blurred lines
			// until pen-up snapped it true (alan, 2026-08-30). The stroke's
			// samples are page units and survive the zoom untouched, so the
			// honest move is to END the gesture at the moment its page
			// provably resized, committing what was drawn. Checked against
			// the stroke's own page div, one direct read, so the storm of
			// unrelated mutations (canvas swaps while scrolling) costs one
			// comparison and commits nothing.
			const frame = this.frame;
			if (frame && !this.idle) {
				const el = this.pageElement(frame.scroller, this.strokePageNumber);
				const box = frame.boxes.find((b) => b.pageNumber === this.strokePageNumber);
				if (el && box && Math.abs(el.clientWidth - box.widthPx) > 1) {
					this.penUp();
				}
			}
			// Throttled, which is what scheduleThrottled was written for and
			// never actually got: this fires on every viewer reflow, and each
			// sync probes every page div. A zoom or a fast scroll produced
			// sixty of them a second.
			this.scheduleThrottled();
		});
		mo.observe(this.root, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["style", "width", "height", "class"],
		});
		this.disposers.push(() => mo.disconnect());

		// The pen binds on the first sync that finds a scroller, and rebinds
		// whenever that element is replaced.
		this.disposers.push(() => {
			this.router?.dispose();
			this.ro?.disconnect();
			this.boundScroller?.removeEventListener("scroll", this.onScroll);
		});

		// Undo scoped to this view, not a global command. Obsidian's own undo
		// stack owns Ctrl+Z everywhere else, and a global binding would fight
		// it in every editor in the vault.
		this.root.addEventListener("keydown", this.handleKeyDown, { capture: true });
		this.disposers.push(() =>
			this.root.removeEventListener("keydown", this.handleKeyDown, { capture: true })
		);

		this.schedule();
	}

	function unmount(this: PdfInkController): void {
		// A stroke in flight when the pane closes (a pane or pop-out closed
		// mid-stroke) is committed and saved, as a window blur commits it; the
		// router is disposed below, so this is the last moment it can end.
		this.router?.finishActiveStroke();
		this.flushEditFrame(false);
		// A gesture interrupted by the pane closing has applied live ops that
		// nothing has written yet. Before this batching existed every sample
		// wrote, so an interrupted erase was already durable; it has to stay
		// that way.
		this.persistLive();
		// main.ts rebuilds the controller whenever the leaf's file changes
		// (the comment below), so this one call covers both the note
		// surface's "file switch" and "teardown" forgetAll() sites.
		this.emptyPageNotice.forgetAll();
		this.claimedPages.clear();
		// Before anything else: a sync already queued for the next frame,
		// or a refresh() arriving from the store after the pane closed,
		// would otherwise reach bindTo and install capture listeners and a
		// router on a controller that is gone - the leak unmount exists to
		// prevent, rebuilt one frame later.
		this.mounted = false;
		this.releaseFocusBinding();
		// With the gate above and before the strip goes below: a mode change
		// arriving after this line must not find a listener holding a dead
		// controller. The viewer under a PDF pane is rebuilt routinely and
		// main.ts rebuilds the controller whenever the leaf's file changes, so
		// one leaked per teardown is a session's worth of them by evening.
		this.unwatchPenTools?.();
		this.unwatchPenTools = null;
		this.palmShield.dispose();
		this.pinchBridge.dispose();
		// A trailing sync outlives the controller otherwise, and fires into a
		// viewer that is gone.
		if (this.trailingSync !== null) {
			this.win.clearTimeout(this.trailingSync);
			this.trailingSync = null;
		}
		// Disposers FIRST. One of them disposes the router, and nulling the
		// field before running them meant it never was - the router installs
		// capture listeners ahead of the whole page, and one was left behind
		// per closed pdf.
		for (const d of this.disposers) d();
		this.disposers = [];
		this.router = null;
		this.resetGestureState();
		this.tools?.destroy();
		this.tools = null;
		this.dropOverlays();
		this.boundScroller = null;
		this.cursorScroller = null;
		this.band = null;
	}

	/**
	 * The view is showing a different document now.
	 *
	 * The ring is dropped rather than kept. Its ops name the old document, so
	 * they would still be applied correctly - but offering an undo for ink
	 * that is no longer on screen, in a file the user has navigated away from,
	 * is a surprise with no upside.
	 */
	function forgetHistory(this: PdfInkController): void {
		// FIRST, before anything below can forget what the gesture was.
		//
		// This is the pdf's in-place file switch (main.ts, the branch that
		// compares a non-empty path against `pdfFiles`), and the pane is
		// REUSED - so is the router, and so is whatever contact it was
		// tracking. `7c95c39` fixed exactly this on the note surface and this
		// file never got it: a pen contact whose lift was lost across the
		// switch (a finger resting on the glass, landing on a document the
		// router never saw a pointerdown for) leaves `activePenId` set
		// forever, which keeps `armOwnership`'s window-capture click
		// suppressor armed forever, which eats every future pen tap on the
		// strip. `f5f2333` is the other half, also missing here: the
		// abandoned stroke already ran `stripPenDown` -> `setInking(true)`,
		// and abandoning ends the stroke with no PointerEvent, so nothing
		// reaches `penUp()` to put it back.
		//
		// Ahead of `resetGestureState()` below on purpose: that clears
		// `builder` and `erasing`, and a teardown that wants to say what the
		// gesture WAS has to run while they still say it. Harmless when
		// nothing is live - `abandonActiveStroke` returns false and changes
		// no state at all (its own header states that contract), and the
		// stand-down is gated on true so a routine switch stays the no-op it
		// already was.
		//
		// `strokeAbandoned` itself, not a hand-copied half of it. This line
		// used to be `stripPenUp(this.tools)` alone, so the two ways into one
		// teardown answered differently: the blur path (which abandoned too,
		// until the 2026-09-04 ruling made it commit) put the reticle away and
		// this did not, and the ring - with `handwriting-pdf-hover`'s `cursor:
		// none` over the whole viewer - was carried onto the new document.
		// That is the divergence this whole branch was written to close,
		// reproduced inside the fix. One method; today one caller, and the
		// callback wiring kept for the contract's sake (InkSurfaces.ts).
		//
		// WHAT THIS SWITCH NOW SHARES, AND WHAT IT DELIBERATELY DOES NOT.
		// `abandonActiveStroke` is the note surface's teardown, whole, so an
		// in-place document switch here also stands down the stroke, the
		// ownership tail and the fling. Its touch BOOKKEEPING - `touchPos`,
		// `liveTouchIds`, `guardTouches` - is narrower than that (`e0ff9c3`):
		// a switch wipes them only when a claimed pen stroke was torn down,
		// `hadStroke`, because only then did those contacts belong to the
		// gesture being dropped. A mid-pinch switch leaves them alone - the
		// fingers are still on the glass, and wiping the maps while the
		// assist/pinch quartet survived left the two halves of the touch
		// model disagreeing about what was still down (1.4.10-design.md §17
		// deferral (2)). A switch with nothing live still touches none of it
		// (2e880b4: abandon is a true no-op with nothing live, `guardApplied`
		// included).
		// The ASSIST-PAN stand-down was left out of this round on purpose. It
		// is the other thing a switch could plausibly reset, and resetting it
		// would un-protect a contact that is still on the glass: the assist
		// pan exists to carry a two-finger gesture that is mid-flight, and a
		// document switch underneath one does not lift the fingers. Standing
		// it down would hand a live contact straight back to the viewer's own
		// scroll handling in the middle of the motion. Whether a switch should
		// end an assist pan at all is a question about the gesture, not about
		// this teardown, and it is not answered here.
		if (this.router?.abandonActiveStroke()) this.strokeAbandoned();
		this.history.clear();
		this.pageSize.clear();
		this.rotated.clear();
		this.warnedRotated.clear();
		// The selection names strokes in the OLD document - a Delete pressed
		// after switching files would ask this one to remove ids it has never
		// heard of - and a gesture caught mid-air is inherited whole.
		this.resetGestureState();
		// And the unwritten-change flag, here and not in resetGestureState. At a
		// switch it belongs to the document being let go of: main.ts has already
		// released that document's id, so nothing writes it now, and kept, it made
		// the new document's first gesture write the new file with nothing changed.
		// Everywhere else resetGestureState runs (an abandoned stroke, teardown,
		// a viewer rebuild) the document stays, and the flag is what makes the
		// next gesture end write a live erase or move already in the store.
		this.liveDirty = false;
		// A new document is a new wait, so it may say so once more.
		this.warnedNoId = false;
		this.warnedInkNotReady = false;
	}

export function installPdfTools(proto: PdfInkController): void {
	installMethods(proto, {
		ensureTools,
		ensureToolsInner,
		buildTools,
		stripExec,
		refreshStrip,
		mount,
		unmount,
		forgetHistory,
	});
}
