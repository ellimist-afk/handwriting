/**
 * The commands and reads the pen-tools strip takes from its host, as a type.
 * It is re-exported from MobileTools.ts, so every importer keeps its import line.
 */
import { ToolbarCorner } from "./ToolbarCorner";
import { type InkPreset } from "../ink/InkPresets";

export interface MobileToolsHost {
 noteViewport?: {
  getNoteViewportState():{zoom:number;busy:boolean;fitAvailable:boolean};
  zoomNoteBy(factor:number):boolean;
  resetNoteZoom():boolean;
  fitHandwriting():string;
 };

	/**
	 * The path of the note this strip is painted over, for the per-note
	 * Infinite Canvas override. OPTIONAL, and absent means "ask the
	 * global": a host that does not know its path - the fold-order preview
	 * strip, the PDF surface - has no per-note override to honour, and
	 * `canvasForNote(null, global)` already answers the global for it.
	 */
	notePath?: () => string | null;

	/** Execute a command by its full id (e.g. "handwriting:inline-tool-pen"). */
	exec(commandId: string): void;
	/** The active nib: "pen" or "highlighter". */
	activeTool(): string;
	/** Whether eraser mode currently overrides the nib. */
	eraserOn(): boolean;
	/** Eraser behavior, so the pop's Stroke | Reticle chips can show and flip it. */
	eraserWholeStroke(): boolean;
	setEraserWholeStroke(on: boolean): void;
	/** Whether lasso mode makes the tip lasso. */
	lassoOn(): boolean;
	/** Whether insert-space mode makes the tip plant a divider. */
	spaceOn(): boolean;
	/** Whether pan mode makes the tip drag the view. */
	panOn(): boolean;
	/**
	 * One tool's current ink color, for the TINTED NIB ICONS and for ringing
	 * the current swatch inside that tool's own pop.
	 *
	 * Parameterised, where this used to be `activeColor()` - the active
	 * tool's colour and nothing else. That was enough while one palette
	 * button carried the colour for whichever nib happened to be active; it
	 * is not enough now that the Pen and the Highlighter each wear their own
	 * colour AT ALL TIMES (alan, 2026-09-05: colour goes "into the pen pop
	 * fine but then pen should be colored to indicate color without having to
	 * touch anything"). Both buttons are painted on every refresh and only
	 * one of them is the active tool, so an active-tool read would leave the
	 * other one wearing its neighbour's ink.
	 */
	toolColor(tool: string): string;
	/** Eraser radius in screen px, for the slider. */
	eraserRadiusPx(): number;
	/** Live while dragging; commit=true on release persists. */
	setEraserRadiusPx(px: number, commit: boolean): void;
	/** Nib size multiplier for a tool, for the ink sliders. */
	inkSizeMult(tool: string): number;
	setInkSizeMult(tool: string, mult: number, commit: boolean): void;
	/** Editor history state, so undo/redo can dim when they would no-op. */
	canUndo(): boolean;
	canRedo(): boolean;
	/** Whether the ink clipboard holds anything, so paste can dim. */
	canPasteInk(): boolean;
	/** Mouse ink: on for people writing with a mouse instead of a pen. */
	mouseInkOn(): boolean;
	/** Arm without a toast: for arming that rides inside a tool click. */
	armMouseInkQuietly(): void;
	/**
	 * Disarm without a toast, and put the nib light out with it: for the
	 * put-down that rides inside a tool click. The mirror of the line above.
	 */
	disarmMouseInkQuietly(): void;
	/**
	 * Say one line to the user.
	 *
	 * This file's header says it invents nothing - every button execs the
	 * command the palette would, so notices stay in one place. The active-nib
	 * mouse click is the one branch with no command to exec: it changes only
	 * the mouse's claim on the pointer, and the command that would have said
	 * so is the LOUD toggle, which also writes data.json (alan, 2026-09-04:
	 * "dont persist a quiet arm"). So the words move here and the wording is
	 * copied verbatim from that command's own branches - `Handwriting: pen` /
	 * `Handwriting: highlighter` on the way in, `Handwriting: cursor` on the
	 * way out. Injected rather than importing `Notice`, the seam
	 * `PdfInkController`'s `notify` already is, so a test can read the words.
	 */
	toast(message: string): void;
	/** Bug-report recording state, for the strip's dot. */
	recordingOn(): boolean;
	/** Whether a lasso selection exists, so copy and trash can dim. */
	hasInkSelection(): boolean;
	/**
	 * One tool's palette, for the swatch row inside that tool's own pop.
	 *
	 * Parameterised for the same reason `toolColor` is: the pen's pop offers
	 * the eight pen inks and the highlighter's its own five, and a single
	 * active-tool read cannot answer for the pop that is not showing.
	 */
	paletteFor(tool: string): ReadonlyArray<{ name: string; hex: string }>;
	/**
	 * A swatch was tapped: apply the color, pick up its nib, toast it.
	 *
	 * Still un-parameterised, and that is safe rather than an oversight: both
	 * surfaces implement it as `pickStripColor`, which applies to
	 * `getInlineTool()`, and a swatch row is only ever REACHABLE inside a pop
	 * that `refreshNow` shows for the active tool alone (`hangUnder`'s
	 * `activeTool() === "pen"` / `=== "highlighter"` guards). So the tool the
	 * host picks for and the tool whose swatches were tapped are the same
	 * tool by construction. Pinned by a test rather than left to the reader.
	 */
	pickColor(name: string, hex: string): void;
	/**
	 * One tool's quick pens, in slot order, for the chip row at the top of
	 * that tool's pop (design §10).
	 *
	 * Parameterised like `paletteFor` and for the same reason: the pen's row
	 * and the highlighter's are different lists, and only the pop being drawn
	 * knows which. A host read rather than a module read here, even though
	 * the list IS module state, because everything else this strip draws
	 * comes through the host and a second road into the strip is a second
	 * road for the two surfaces to drift apart on.
	 */
	presetsFor(tool: string): ReadonlyArray<InkPreset>;
	/** A chip was tapped: wear that preset. */
	applyPreset(tool: string, index: number): void;
	/** The star was tapped: save the pair in hand. */
	starPreset(tool: string): void;
	/** A chip was held or right-clicked: drop that slot. */
	forgetPreset(tool: string, index: number): void;
	/**
	 * Give the editor the keyboard, or take it away: the pen-off button's
	 * other half (PenInk.ts, design §5).
	 *
	 * This is the one thing the strip does that no command can do for it.
	 * `pen-ink-toggle` flips the state from the palette, a hotkey or this
	 * button alike, but iOS and Android raise the software keyboard only for
	 * a programmatic focus made INSIDE A USER GESTURE - so the focus has to
	 * happen in the button's own click handler, where a gesture exists,
	 * rather than inside the command it execs. Turning the pen off focuses;
	 * turning it back on blurs, so the keyboard goes back down.
	 *
	 * A host method rather than a `.focus()` here for the reason
	 * StripPenChrome.test.ts's sweep names: the strip has no view to focus
	 * and must not learn about one. The note overlay routes it through
	 * `setKeyboardFocus` (InlineFocus.ts); the pdf surface has no editor and
	 * implements it as a no-op.
	 */
	setEditorFocus(focused: boolean): void;
	/**
	 * Whether the pen actually inks on THIS surface right now, for the
	 * keyboard button's light and the pill's "Pen off" label - a display
	 * read, not the state itself.
	 *
	 * BOTH REAL SURFACES ANSWER `penInkEnabled()` (PenInk.ts), because both
	 * routers now gate on it: the note has since the state existed, the pdf
	 * since the owner reversed the note-only rule ("why would you take
	 * keyboard mode away from pdf"). For two days the pdf answered an
	 * unconditional `true` here, which kept its strip's keyboard icon dark
	 * while the note's was lit - honest at the time, and a lie the moment the
	 * pdf started honouring the state.
	 *
	 * A HOST READ ALL THE SAME, rather than the module read this replaced.
	 * The strip is built for a host and knows nothing about which surface it
	 * is on; a surface that genuinely does not honour pen-off can only say so
	 * here, and the button's light must never again be a global standing in
	 * for a question about one pane.
	 */
	penInksHere(): boolean;
	/**
	 * Whether this surface supports explicit finger ink. Note-only and
	 * capability-shaped so Keyboard remains visible while pen input is off.
	 * Undefined is false; PDF and existing hosts therefore stay native.
	 */
	fingerInkAvailable?(): boolean;
	/**
	 * Commit the gesture guard before the next finger reaches the note. A
	 * browser snapshots touch-action before pointerdown, so entering finger
	 * ink cannot wait for the router's contact handler to close a native-scroll
	 * window left open by the preceding gesture.
	 */
	prepareFingerInk?(): void;
	/**
	 * Does this DEVICE have a touchscreen? For whether the Pan button gets
	 * BUILT (see `ButtonSpec.shownOn`) - a device fact, not a live reading.
	 *
	 * Both surfaces answer `deviceHasTouch()` (DeviceInput.ts), which is
	 * where the reasoning about `navigator.maxTouchPoints` versus
	 * `Platform.isMobile` lives; the rule is written once there and read
	 * through the host here for the same reason `penInksHere` is - a strip is
	 * built for a host and must not learn which surface it is on. The host
	 * seam is also what lets the suite ask for a phone's strip and a mouse's
	 * strip in the same run without a fake `navigator`.
	 */
	hasTouch(): boolean;
	/**
	 * The strip was DRAGGED to an anchor and let go: put it there, and
	 * remember it.
	 *
	 * BOTH HALVES, which is the whole reason this is a host call rather than
	 * a `setCorner` on itself. The settings dropdown's road does two things
	 * (`SettingsTab.setControlValue`, main.ts): it writes `settings
	 * .toolbarCorner` and it calls `setToolbarCorner`, which moves every open
	 * strip on every surface. A drop that only did the second would move the
	 * toolbar until the next restart and leave the dropdown reading the old
	 * placement; a drop that only did the first would persist a move nobody
	 * could see. Both surfaces wire this to `applyToolbarPlacement`
	 * (InkOverlay.ts), which is the one function the dropdown's case now
	 * calls too - so there is one road, not two that have to be kept level.
	 *
	 * A host method rather than a module-level setter like `setStripFoldOrder`
	 * for the reason the header gives: this file must not import InkOverlay,
	 * and everything else the strip reaches out to it reaches through the
	 * host, so a second road here would be a second road for the two surfaces
	 * to drift apart on.
	 */
	setPlacement(corner: ToolbarCorner): void;
}
