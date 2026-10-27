/**
 * Ink controls and setting appliers, moved from main.ts. Each is a method of HandwritingPlugin, installed on its prototype when main.ts loads.
 * Bodies moved unchanged.
 */
import { Command, Notice, Platform, TFile } from "obsidian";
import { clearGatedCommandAction, gatedCommandActionIds, planGatedCommands, setGatedCommandAction } from "./CommandPaletteSplit";
import { setSlidesInk } from "./slides/SlidesInkSurface";
import { getInlineTool, hidePenCursorsEverywhere, inlineInk, inlineReloadBindings, refreshAllStrips, refreshPenToolsAll, setEraserRadiusPx, setInkSizeMult, setInlineEraserMode, setInlineLassoMode, setInlinePanMode, setInlineSpaceMode, setInlineTool } from "./inline/InkOverlay";
import { clampInkSize } from "./ink/InkSize";
import { clampEraserRadius } from "./ink/EraserSize";
import { consumeHintLagMs, discardHintSamples } from "./ink/LatencyEstimate";
import { noteLag, resetEinkHintProgress } from "./ink/EinkHint";
import { setInkColorHex } from "./ink/InkColor";
import { routineNoticesVisible } from "./diag/RoutineNotices";
import { armMouseInkQuietly, consumeMousePutDown, mouseInkEnabled } from "./inline/MouseInk";
import { paperClass, PaperStyle } from "./inline/Paper";
import { InkTool } from "./ink/Stroke";
import { clearPenHardwareSeen, markPenSeen, penSeenThisSession } from "./inline/PenToolsMode";
import { normalizeFoldOrder, setStripFoldOrder } from "./inline/MobileTools";
import { runDetached } from "./util/Detached";
import { blockNotice } from "./view/Notices";
import { installMethods } from "./inline/InstallMethods";
import type { HandwritingPlugin } from "./main";

declare module "./main" {
	interface HandwritingPlugin {
		pickUpNib(tool: InkTool): void;
		setInkColor(tool: InkTool, hex: string, name: string): Promise<void>;
		setInkSize(mult: number, name: string): Promise<void>;
		setEraserSize(radiusPx: number, name: string): Promise<void>;
		enterTipMode(on: boolean): void;
		applyStripFoldOrder(order: readonly string[]): void;
		applyMouseInkUiFanout(on: boolean): void;
		tipModeOffNotice(): string;
		armTipModeInput(): boolean;
		applySlidesInk(on: boolean): void;
		applyPaper(style: PaperStyle): void;
		applyPaperTo(doc: Document, style: PaperStyle): void;
		reloadPanesHidden(mainDoc: { hidden: boolean }): boolean;
		applyStatusBarVisibility(): void;
		registeredGatedCommandIds(): string[];
		appCommandRegistry(): { removeCommand?(id: string): void } | undefined;
		gatedCommandRemovalAvailable(): boolean;
		removeGatedCommand(id: string): void;
		applyGatedCommandRegistration(): void;
		showScribbleHintIfDue(): void;
		checkEinkHint(): void;
	}
}


	/**
	 * Selecting a color picks up its tool: choosing "highlighter yellow" is
	 * reaching for the yellow highlighter, not annotating a preference for
	 * later (alan, 2026-08-31). The nib goes active and every tip mode ends,
	 * exactly as the tool's own command does it.
	 */
	function pickUpNib(this: HandwritingPlugin, tool: InkTool): void {
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
	async function setInkColor(this: HandwritingPlugin, tool: InkTool, hex: string, name: string): Promise<void> {
		this.settings.inkColors[tool] = setInkColorHex(tool, hex);
		refreshAllStrips();
		await this.persistSettings();
		if (routineNoticesVisible()) new Notice(`Handwriting: ${tool} ${name}`);
	}

	async function setInkSize(this: HandwritingPlugin, mult: number, name: string): Promise<void> {
		const tool = getInlineTool();
		setInkSizeMult(tool, mult);
		this.settings.inkSizes[tool] = clampInkSize(mult);
		await this.persistSettings();
		if (routineNoticesVisible()) new Notice(`Handwriting: ${tool} size ${name}`);
	}

	async function setEraserSize(this: HandwritingPlugin, radiusPx: number, name: string): Promise<void> {
		setEraserRadiusPx(radiusPx);
		this.settings.eraserRadiusPx = clampEraserRadius(radiusPx);
		await this.persistSettings();
		if (routineNoticesVisible()) new Notice(`Handwriting: eraser ${name}`);
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
	function enterTipMode(this: HandwritingPlugin, on: boolean): void {
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
	function applyStripFoldOrder(this: HandwritingPlugin, order: readonly string[]): void {
		const next = normalizeFoldOrder(order);
		this.settings.stripFoldOrder = next;
		setStripFoldOrder(next);
		runDetached(this.persistSettings(), "save the toolbar fold order");
	}

	function applyMouseInkUiFanout(this: HandwritingPlugin, on: boolean): void {
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
	function tipModeOffNotice(this: HandwritingPlugin): string {
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
	function armTipModeInput(this: HandwritingPlugin): boolean {
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

	function applySlidesInk(this: HandwritingPlugin, on: boolean): void {
		if (on) this.startSlidesInk();
		else {
			setSlidesInk(false);
			// The next switch-on makes a new writer; this one must not
			// keep claiming the sidecar (audit 125).
			if (this.slidesWriter) this.store.retireWriter(this.slidesWriter);
			this.slidesWriter = null;
		}
	}

	// ---- settings -----------------------------------------------------------

	/** One ruled style at a time: clear both classes, then set the one asked for. */
	function applyPaper(this: HandwritingPlugin, style: PaperStyle): void {
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

	function applyPaperTo(this: HandwritingPlugin, doc: Document, style: PaperStyle): void {
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
	function reloadPanesHidden(this: HandwritingPlugin, mainDoc: { hidden: boolean }): boolean {
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
	function applyStatusBarVisibility(this: HandwritingPlugin): void {
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
	function registeredGatedCommandIds(this: HandwritingPlugin): string[] {
		const mirrored = new Set(gatedCommandActionIds());
		return [...this.gatedCommandDefs.keys()].filter((id) => !mirrored.has(id));
	}

	/** The app's command registry, if this Obsidian exposes one. */
	function appCommandRegistry(this: HandwritingPlugin): { removeCommand?(id: string): void } | undefined {
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
	function gatedCommandRemovalAvailable(this: HandwritingPlugin): boolean {
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
	function removeGatedCommand(this: HandwritingPlugin, id: string): void {
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
	function applyGatedCommandRegistration(this: HandwritingPlugin): void {
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
	function showScribbleHintIfDue(this: HandwritingPlugin): void {
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
	function checkEinkHint(this: HandwritingPlugin): void {
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

export function installPluginApply(proto: HandwritingPlugin): void {
	installMethods(proto, {
		pickUpNib,
		setInkColor,
		setInkSize,
		setEraserSize,
		enterTipMode,
		applyStripFoldOrder,
		applyMouseInkUiFanout,
		tipModeOffNotice,
		armTipModeInput,
		applySlidesInk,
		applyPaper,
		applyPaperTo,
		reloadPanesHidden,
		applyStatusBarVisibility,
		registeredGatedCommandIds,
		appCommandRegistry,
		gatedCommandRemovalAvailable,
		removeGatedCommand,
		applyGatedCommandRegistration,
		showScribbleHintIfDue,
		checkEinkHint,
	});
}
