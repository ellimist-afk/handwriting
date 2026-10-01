/**
 * The floating pen-tools strip for inline notes.
 *
 * Every Handwriting control lives in the command palette, and on an iPad the
 * palette lives in the toolbar above the keyboard - and the stylus fix keeps
 * the keyboard DOWN, which is correct for writing and fatal for discovery: a
 * pencil-only user has no path to the eraser, the highlighter, or anything
 * else. This strip is that path. It invents nothing: every button executes
 * the same command id the palette would, so persistence, notices and behavior
 * stay in one place.
 *
 * Where it mounts matters. It sits on the EDITOR element (`view.dom`), a
 * sibling of the scroller, not inside it - the router's capture listeners
 * live on the scroller, so a pencil tap on a button never enters the pen
 * pipeline and lands as an ordinary click. Top-right, because the writing
 * palm owns the bottom of the glass and a palm-planted strip would switch
 * tools mid-word.
 *
 * The host hands in command execution and current-state reads so this file
 * imports nothing from InkOverlay (no import cycle).
 *
 * Collapse: the strip minimizes to a single pen pill (the PencilKit move -
 * every serious note app keeps tools permanently reachable but shrinkable).
 * The collapsed state is per-strip and per-session: chrome preference, not
 * document state, and not worth a setting.
 */

import { setIcon } from "obsidian";
import {
	ToolbarCorner,
	allToolbarCornerClasses,
	collapseChevronGlyph,
	collapseChevronIcon,
	toolbarCornerClass,
} from "./ToolbarCorner";
import {
	TOOLBAR_ANCHOR_INSET_PX,
	dragPassedThreshold,
	nearestAnchor,
} from "./ToolbarDrag";
import { stripEscapeVerdict } from "./StripEscape";
import { gridColumns, overflowPlan, type OverflowPlan } from "./StripOverflow";
import { popRightOffset } from "./PopPlacement";
import { stripClearance } from "./StripClearance";
import { deviceHasNeverSeenAPen, getPenToolsMode, onPenToolsChanged, penHardwareEverSeen, penHardwareSeen } from "./PenToolsMode";
import {
	getNoteZoomControlsMode,
	getZoomBarCanvasEnabled,
	noteZoomControlsVisibleWithCanvas,
	onNoteZoomControlsChanged,
} from "./NoteZoomControlsMode";
// The per-note override of Infinite Canvas. Read-only from here: the strip
// asks what this note's mode is and subscribes to changes; who may write the
// override is main.ts's business, not the strip's.
import { canvasForNote, onCanvasOverrideChanged } from "./CanvasNoteOverride";
import { markMousePutDown, markToolPicked, mouseDrawsFromLitTool, toolIsLit } from "./MouseInk";
import { penInkEnabled, setPenInk } from "./PenInk";
import { DEFAULT_PEN, HIGHLIGHTER_PEN } from "../ink/PenStyle";
import { type InkPreset, presetChips, starReplaces } from "../ink/InkPresets";
import { describeEl } from "./PenHitProbe";
import { traceStripClick } from "./InlinePenRouter";
import { MAX_PINCH_SCALE } from "./PinchScale";

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

/**
 * The tip inks only when nothing has taken it over. A nib button asked
 * only whether the eraser was on, so turning on lasso - or insert space,
 * which copied lasso's shape - left Pen lit alongside the mode that had
 * actually claimed the tip, and the strip showed two active tools at once
 * (alan, 2026-08-27). Every mode that steals the tip belongs in here.
 */
const tipInks = (h: MobileToolsHost): boolean =>
	!h.eraserOn() && !h.lassoOn() && !h.spaceOn() && !h.panOn();

/**
 * DOES THE PEN ITSELF ACTUALLY DRAW ON THIS SURFACE RIGHT NOW?
 *
 * The mirror of `mouseDrawsHere` below, and the half that was missing.
 * `penHardwareSeen()` says a real digitizer has fired here; `h.penInksHere()`
 * says the router will still claim it. Both, or the pen is not drawing.
 *
 * ALAN, 2026-09-06: "unlit while the keyboard mode is on", under his standing
 * rule for this strip - "button should become the truth". `nibIsLit` asked
 * `tipInks` (has some OTHER tool taken the tip?) and `penHardwareSeen()` (is
 * there a pen at all?) and never once asked whether the pen could ink, so
 * keyboard mode - the state whose entire meaning is that the tip does nothing
 * - left the Pen button lit while the pen placed carets. That is the original
 * "lit and not drawing" symptom, reached by the one door nothing had shut.
 *
 * ONLY THIS DISJUNCT, never the whole predicate, and the distinction is the
 * load-bearing part of this fix. Keyboard mode is a gate on THE PEN: every
 * `penOff()` site in InlinePenRouter.ts is `e.pointerType === "pen" &&
 * this.penOff()`, and the mouse reaches the tip through `mouseActsAsPen`,
 * whose explicit `enabled` half is not gated on pen ink at all. So a pen-less
 * user with mouse ink armed by name still draws with the mouse in keyboard
 * mode - and wrapping `h.penInksHere()` around the whole expression would
 * darken that button while it drew, which is the same lie inverted. The
 * mouse's own answer is `mouseDrawsHere`'s to give, and it already gives it:
 * the DERIVED pen-less grant reads pen ink through `toolIsLit`, so that half
 * follows keyboard mode on its own, exactly as the router's copy does.
 *
 * NOT A PUT-DOWN, and that is why this reads the flag rather than clearing
 * anything. `setPenInk(false)` (PenInk.ts) already unpicks the tool for the
 * pen-less device's derived grant, deliberately; the nominal tool -
 * `h.activeTool()` - is untouched by it, so a pen user who turns keyboard
 * mode on and off again gets the light back on THE SAME NIB, highlighter
 * included. There is no new state here to fall out of step: one flag, read
 * where the router reads it.
 */
const penDrawsHere = (h: MobileToolsHost): boolean => penHardwareSeen() && h.penInksHere();

/** The selected nib genuinely draws with touch on the note-only iPhone host. */
const fingerDrawsHere = (h: MobileToolsHost): boolean =>
	(h.fingerInkAvailable?.() ?? false) && toolIsLit(h.penInksHere());

/**
 * Whether a nib button's LIGHT (and the collapsed pill) should show it lit:
 * the tip must nominally hold this tool AND the tip must actually ink with
 * it - true once a real PEN has been seen this session, or for a mouse user
 * only while mouse ink is armed.
 *
 * `penHardwareSeen`, not `penSeenThisSession`. The latter is the strip's
 * VISIBILITY flag and every tool command sets it, so on a mouse-only machine
 * it went true on the user's first click and this whole predicate collapsed
 * to `isActive` for the rest of the session - the light could then never
 * follow mouse ink going off, which is the defect this function was extracted
 * to fix and did not (alan, 2026-09-02, shipped unfixed in 1.4.6-1.4.8).
 * Pulled out as a pure function of (host, tool) -
 * this needs only a fake MobileToolsHost, so MobileTools.test.ts pins it
 * directly, with no element tree at all. (That comment used to say the class
 * itself "cannot be constructed under the suite"; the C16 test in that same
 * file constructs it against a fake tree now, so the claim is gone rather
 * than left standing - P5.) See ButtonSpec.isLit for why this is a separate
 * read from isActive, which the click chain still branches on.
 *
 * WIDENED for "button should become the truth" (2026-09-05) and its
 * addendum: the headline of that ruling is that the light and the actual
 * draw must never disagree, in EITHER direction. `InlinePenRouter
 * .mouseActsAsPen` (InlinePenRouter.ts) already lets the mouse draw with
 * whichever tool is lit on a device that reads as pen-less, with no arm
 * step - so a command-palette or hotkey "Pen" press on such a device makes
 * the mouse draw, and this light must say so or it is lying the other way
 * now (dark, not drawing - the exact inverse of alan's original symptom,
 * lit and not drawing).
 *
 * CALLS `mouseDrawsFromLitTool` (MouseInk.ts) DIRECTLY rather than
 * re-deriving its AND locally: that is the ONE function `InlinePenRouter
 * .mouseActsAsPen` also calls to answer this same question, and a rule
 * computed twice - even correctly, even today - is the exact "second
 * notion of lit" PenToolsMode.ts documents by name and the addendum's "no
 * second flag that could drift" was written to rule out for a second
 * COMPUTATION just as much as a second flag. `h.penInksHere()` is this
 * host's existing, pre-existing-to-this-brief reading of "does the tip do
 * anything at all right now" (wired to `penInkEnabled()` on both real
 * surfaces, same as the router's own `!penOff()` - see
 * InlinePenRouter.ts's comment on that call site for why the two are the
 * same underlying flag read through two different, both pre-existing,
 * seams) - not a second notion of "lit", just this caller's existing way
 * of reaching the one PenInk.ts flag the router reaches through its own
 * callback.
 *
 * The persisted/armed switch, `h.mouseInkOn()`, is NOT read through the
 * shared function either - each caller keeps its own pre-existing,
 * independently-tested reading of that (the router's raw `enabled`; this
 * host's `mouseInkOn()`, a test seam neither test double nor real host
 * routes through the module's raw flag identically) - because that half of
 * the rule PREDATES this addendum and is not what it changed.
 *
 * TIGHTENED, same day: `h.penInksHere()` alone is the pen-ink switch, whose
 * DEFAULT IS TRUE, so this said "lit" on a pen-less device at launch with
 * nothing picked - and the router, reading the same wrong half, inked a
 * plain left-drag that should have selected text. `toolIsLit` (MouseInk.ts)
 * is the tightened predicate and takes this same host read; the pair still
 * agree because they still share one function.
 *
 * TIGHTENED AGAIN, 2026-09-06, and this time on the PEN's side: the first
 * disjunct was the bare `penHardwareSeen()` and is now `penDrawsHere` -
 * hardware seen AND the pen still claimed here. See that function for the
 * ruling ("unlit while the keyboard mode is on") and for why the gate sits
 * inside this one disjunct rather than around the pair.
 */
export const nibIsLit = (h: MobileToolsHost, tool: "pen" | "highlighter"): boolean =>
	tipInks(h) &&
	h.activeTool() === tool &&
	(penDrawsHere(h) || fingerDrawsHere(h) || mouseDrawsHere(h));

/**
 * DOES THE MOUSE ACTUALLY DRAW ON THIS SURFACE RIGHT NOW - either switch?
 *
 * The two ways in, as one read: the explicit/armed mode (`h.mouseInkOn()`)
 * and the derived pen-less grant. It exists because the SECOND of those had
 * no put-down. The strip's three mouse branches below - the nib put-down,
 * the eraser/lasso/space/pan put-down, and the arm that mirrors them - each
 * asked `h.mouseInkOn()`, which the derived grant never sets, so on a device
 * that has never seen a pen a tool picked from the palette drew with the
 * mouse and clicking that lit button again did nothing at all. The only exit
 * left was the pen-ink toggle, whose strip button is hidden on exactly the
 * devices that needed it (`shownOn`, below).
 *
 * Named and shared rather than spelled out three times for the reason the
 * file keeps repeating: the arm and its two put-downs are one rule seen from
 * both ends, and a fourth mouse branch added later must not have to
 * rediscover which of the two switches to ask about.
 */
const mouseDrawsHere = (h: MobileToolsHost): boolean =>
	h.penInksHere() &&
	(h.mouseInkOn() || mouseDrawsFromLitTool(deviceHasNeverSeenAPen(), toolIsLit(h.penInksHere())));

/**
 * Pixel<->multiplier conversion for the nib sliders (Alan, 2026-09: "aligning
 * the stroke width and eraser slider to either both be pixel or both be
 * multiplier" - PIXELS, matching "Eraser size"). The STORED setting is
 * unchanged: setInkSizeMult/getInkSizeMult (InkOverlay.ts) and
 * this.settings.inkSizes (main.ts) still hold a multiplier, clamped there
 * exactly as before by clampInkSize (InkSize.ts) - only what this control
 * shows and drags in changes, converting at the edges. Rounded to 3dp:
 * DEFAULT_PEN.baseWidth (2.2) is not an integer, so raw px/base division
 * carries float noise (2.2 * 3 === 6.6000000000000005 in JS) that would
 * otherwise leak into the stored multiplier and the slider's own bounds.
 */
const pxToMult = (px: number, base: number): number => Math.round((px / base) * 1000) / 1000;
const multToPx = (mult: number, base: number): number => Math.round(mult * base * 1000) / 1000;
/**
 * What a built slider hands back: its parts.
 *
 * THE VALUE READOUT, AND WHY IT CAN EXIST AGAIN. One went with the rotated
 * slider in 1.4.12 because it was what made the pop judder:
 *
 * "Weird distortion on the pen slider as i slide it up and down, like the
 * slider is just vibrating" (alan, on hardware, 2026-09-02) - and it was the
 * POP that moved, not the thumb. The pop was a centred column with no width
 * of its own, so its width was its widest child, which was the readout; and
 * `hangUnder` re-centres the pop from its own measured `offsetWidth` on every
 * refresh. So any change in the readout's text width slid the whole pop, and
 * the slider inside it, sideways under the finger. `constantWidthLabel` -
 * fixed decimals plus U+2007 FIGURE SPACE padding - made every label the same
 * run of digit-width glyphs so that could not happen, and `.handwriting-
 * slider-val` pinned a monospace family so a serif theme could not undo it.
 *
 * The number is BACK on the owner's ruling (2026-09-06, asked whether the
 * value should return: "as well"), because a slider with no readout leaves a
 * user on glass with only the thumb's position to go on - "if the number is
 * there then it is easier to set on ones liking", "it will be difficult to
 * remember one like" (a second user, the same day).
 *
 * It cannot judder now, for two independent reasons. The flat pop DECLARES
 * its own width (styles.css), so the pop's width no longer depends on
 * anything the pop CONTAINS - a stronger guarantee than a constant-width
 * string was, since it holds for the preset row, the swatch grid and the
 * eraser's mode chips too, none of which the label trick ever covered. And
 * the readout sits on its OWN ROW under the track, in a box of fixed width
 * (`.handwriting-slider-num`), so the track's width and left edge do not
 * depend on the digits either. Both are measured, separately, in
 * `test/render/PopGeometry.test.ts`.
 *
 * So `constantWidthLabel` is not needed and does not return: a padded string
 * was a way of holding a width still from the inside, and the width is held
 * still from the outside now. The readout says the input's value verbatim.
 */
interface SliderParts {
	pop: HTMLElement;
	input: HTMLInputElement;
	/** Which nib's pop this is, or null for the eraser's. */
	tool: "pen" | "highlighter" | null;
	/** The swatch row inside a nib's pop; null where `tool` is. */
	colors: HTMLElement | null;
	/** The quick-pen chips, ABOVE the swatches; null where `tool` is. */
	presets: HTMLElement | null;
	/** The live value under the track; painted by `paintValue`. */
	num: HTMLElement;
	/**
	 * How many decimals this slider's readout shows, taken from THIS
	 * slider's own step - see `paintValue`. Carried per slider because the
	 * three pops do not agree: the nibs step by 0.1 and the eraser by 1.
	 */
	decimals: number;
}

/**
 * Paint the slider's value into its readout, IN PIXELS AND SAYING SO.
 *
 * This is the format the shipped 1.4.11 pop used - `${v.toFixed(decimals)}px`
 * at MobileTools.ts:252 on that tag - restored on the owner's ruling. The
 * unit is accurate rather than decorative: the nibs' bounds are built with
 * `multToPx` and the callback converts back with `pxToMult`, and the
 * eraser's slider is identity pixels, so every number here is a real width.
 *
 * THE DECIMALS COME FROM THE CONTROL'S OWN STEP, which is the half that
 * matters. `input.value` can carry precision the slider cannot be set to -
 * a stored multiplier converts to 2.86 on a 2.2 base - and printing it raw
 * is how a bare "2.86" reached the owner's screen. Rounding to the step
 * makes the number one a reader can return to deliberately, which is the
 * whole reason it is on screen: "it's just to make sure they can get the
 * same exact width" (alan), for the user who asked for it (samuel).
 *
 * Still ONE textContent write and no layout read. This runs on every input
 * event of a drag and a style flush here would be under the finger; a
 * `toFixed` on a number already in hand is not one. The compare stays, so
 * a drag inside one step does not touch the DOM at all.
 */
const paintValue = (s: SliderParts): void => {
	const text = `${Number(s.input.value).toFixed(s.decimals)}px`;
	if (s.num.textContent !== text) s.num.textContent = text;
};

interface ButtonSpec {
	icon: string;
	/** Two-char fallback shown when the icon set has no such glyph. */
	glyph: string;
	label: string;
	commandId: string;
	/**
	 * Whether this button belongs on the strip AT ALL - evaluated ONCE, at
	 * build time, against the host that strip was built for; omitted =
	 * always shown. Unlike `isActive`/`isLit`/`isEnabled`, which are LIVE
	 * reads re-run on every refresh, this runs once when the buttons are
	 * created. A button ruled out here is not DISABLED, it is ABSENT.
	 *
	 * BACK, AND NARROWER THAN IT WAS. `6ad3730` (pen-off-on-pdf) removed this
	 * field along with `MobileToolsHost.penCanTurnOff`, and it was right to:
	 * the only predicate on it said the pdf surface has no keyboard button,
	 * and the owner reversed exactly that ruling - "why would you take
	 * keyboard mode away from pdf". The Keyboard button belongs on every
	 * strip and does again. What came back with this field is a DIFFERENT
	 * class of question: not "can this surface honour the button", which is
	 * what `penCanTurnOff` asked and what Alan overruled, but "does this
	 * DEVICE have any use for it" - a touchscreen making Pan redundant, a
	 * machine that has never held a pen making Keyboard so.
	 *
	 * DEVICE-LEVEL FACTS ONLY, and the restriction is load-bearing rather
	 * than stylistic. This is read once, so a predicate over anything that
	 * MOVES would freeze at whatever it said when the strip happened to be
	 * built - which for a phone is "at mount, before anything happened". The
	 * two facts below are chosen to be honest under that: a digitizer is not
	 * added mid-session, and the pen latch only ever goes false-to-true (see
	 * `penHardwareEverSeen`). Even the one edge the latch does have needs
	 * help - `MobileTools.stale()` and the surfaces' ensure-calls rebuild the
	 * strip when an answer here changes, because without that the first pen
	 * contact would produce no Keyboard button until something else recreated
	 * the strip. Since 1.4.12 the latch is restored from settings before any
	 * strip is built, so on a device that has already held a pen the button is
	 * there from the first build and that edge never arrives at all.
	 */
	shownOn?: (host: MobileToolsHost) => boolean;
	/** Marks the button active from current state; omitted = never marked. */
	isActive?: (host: MobileToolsHost) => boolean;
	/**
	 * What the LIGHT (and the collapsed pill) show; omitted = same as
	 * isActive. Split from isActive because the click chain below branches
	 * on isActive to disarm/re-arm mouse ink (:570-680-ish) - collapsing the
	 * two into one predicate made the second click of "click the lit pen
	 * button, click it again" land on a different branch with a different
	 * toast than today (alan, 2026-09-02, traced by hand before this was
	 * written). isActive keeps meaning "the nominal tool"; isLit answers
	 * "does the tip actually ink with this right now" - the tip only inks
	 * for a mouse user when mouse ink is armed, or for anyone once a real PEN
	 * has fired a real event (penHardwareSeen, PenToolsMode.ts).
	 *
	 * That last clause used to read "once a pen has been seen this session
	 * (penSeenThisSession, PenToolsMode.ts)", and it was FALSE. It is the same
	 * citation that hid the nib-light bug for three releases: penSeenThisSession
	 * is the strip's VISIBILITY flag, which every tool command, the mouse-ink
	 * toggle and the settings switch also set, so on a mouse-only machine it
	 * went true on the first click and isLit collapsed to isActive from then on.
	 * `cff850d` moved nibIsLit onto penHardwareSeen, which only genuine pen
	 * contact or pen hover sets; this doc is the half that did not move with it.
	 * Left as a correction rather than a quiet rewrite, because the wrong
	 * citation was believed for three releases precisely by being tidy.
	 */
	isLit?: (host: MobileToolsHost) => boolean;
	/** Dims the button when false; omitted = always enabled. */
	isEnabled?: (host: MobileToolsHost) => boolean;
	/**
	 * The nib whose ink this button WEARS: its icon is painted that tool's
	 * colour on every refresh, and its tooltip names the colour beside the
	 * tool. Omitted = the theme's own colour, like every other button.
	 *
	 * The mechanism is the old palette button's, generalised rather than
	 * rewritten: it answered "which colour" by BEING it - `setCssStyles({
	 * color: hex })` plus a tooltip carrying the colour's name. The palette
	 * button is gone (its cycle moved into the nib pops as a swatch row), and
	 * its one good idea moves onto the two buttons that now have to carry the
	 * answer: Pen and Highlighter wear their own ink AT ALL TIMES, so the
	 * colour is readable "without having to touch anything" (alan,
	 * 2026-09-05).
	 *
	 * A TOOL NAME rather than a `(host) => hex` thunk, because the colour is
	 * not the only thing the render path needs it for - naming the swatch
	 * requires that tool's palette too, and a thunk that returned only the
	 * hex would have left the second read to guess the tool back out of the
	 * command id.
	 */
	inkTool?: "pen" | "highlighter";
	/**
	 * Draw a divider BEFORE this button. The strip carries two different
	 * kinds of control - modes, where exactly one is always winning, and
	 * one-shot actions - and they were laid out identically, so the most
	 * important distinction in the whole strip was invisible.
	 */
	startsGroup?: boolean;
}

/**
 * Four groups, divided by SUBJECT rather than by widget type: the nibs, the
 * other things the tip can be, what to do with a selection, and the note's
 * history.
 *
 * Colour used to be a fifth thing in the first group - an "Ink color" button
 * that cycled the palette, sitting among the modes because it changes
 * whichever nib is active. It is not a button any more. "13 buttons is too
 * much, especially on phone" (alan, 2026-09-05), and colour was the entry
 * with somewhere better to be: it now lives INSIDE each nib's own pop as a
 * row of that nib's swatches, and the two nib icons are painted with their
 * own ink so the answer is on screen without opening anything. The
 * `handwriting:ink-color-cycle` command is untouched - it is in the palette's
 * always-registered set (main.ts) and is still the hotkey path to the same
 * cycle.
 *
 * Keyboard closes the second group and is the odd one in it: every other
 * entry there makes the tip do something ELSE, and this one makes the tip do
 * NOTHING - the pen goes back to the app and taps place a caret (PenInk.ts).
 * It belongs with them anyway, because from the writer's side it answers the
 * same question the eraser and the pan answer, "what happens when I touch the
 * page", and it is the last answer on that list: none of ours.
 */
/**
 * Named once: the click handler and the collapsed pill both single this
 * button out, and a third spelling of the id is a third chance to mistype it
 * into a branch that then silently never runs.
 *
 * EXPORTED SINCE 1.4.12, and it is now the ONLY place in `src` that spells
 * this id. The palette command it used to name is gone (alan, 2026-09-05:
 * "there should only be one"), so nothing registers it any more - but the
 * button, `DEFAULT_FOLD_ORDER` below and every fold order already saved to a
 * user's data.json all still identify this button by it, which is why the id
 * survives the command. main.ts files its action under this constant with
 * `setRetiredCommandAction`, so the one road from this button to the pen-input
 * switch is the one road it has always taken: `host.exec(spec.commandId)`.
 */
export const PEN_INK_TOGGLE = "handwriting:pen-ink-toggle";

const BUTTONS: ButtonSpec[] = [
	{
		icon: "pen",
		glyph: "P",
		label: "Pen",
		commandId: "handwriting:inline-tool-pen",
		isActive: (h) => tipInks(h) && h.activeTool() === "pen",
		// alan, 2026-09-02: "can we make sure that the pen button unhilights
		// when we click it with mouse and moes ink turns off?" A mouse click
		// on the lit pen button turns mouse ink off (:570 below) and the
		// mouse goes back to text; the light must follow that, not just the
		// nominal tool.
		//
		// This comment used to end "Pen/touch users always have
		// penSeenThisSession() true from their first stroke, so this reduces
		// to isActive for them - only a mouse-without-a-pen user ever sees it
		// diverge." That was FALSE and it is why nobody re-checked this for
		// three releases: a mouse-without-a-pen user's penSeenThisSession()
		// also goes true on their very first click, because the tool command
		// the click execs calls markPenSeen() to raise the strip. So the
		// predicate reduced to isActive for EVERYONE, isLit was dead, and the
		// fix Alan asked for never worked in 1.4.6, 1.4.7 or 1.4.8. nibIsLit
		// reads penHardwareSeen() now, which only real pen events set.
		isLit: (h) => nibIsLit(h, "pen"),
		inkTool: "pen",
	},
	{
		icon: "highlighter",
		glyph: "H",
		label: "Highlighter",
		commandId: "handwriting:inline-tool-highlighter",
		isActive: (h) => tipInks(h) && h.activeTool() === "highlighter",
		isLit: (h) => nibIsLit(h, "highlighter"),
		inkTool: "highlighter",
	},
	{
		icon: "eraser",
		glyph: "E",
		label: "Eraser",
		commandId: "handwriting:inline-tool-eraser",
		isActive: (h) => h.eraserOn(),
		startsGroup: true,
	},
	{
		icon: "lasso",
		glyph: "L",
		label: "Lasso",
		commandId: "handwriting:inline-tool-lasso",
		isActive: (h) => h.lassoOn(),
	},
	{
		icon: "unfold-vertical",
		glyph: "S",
		label: "Insert space",
		commandId: "handwriting:inline-tool-space",
		isActive: (h) => h.spaceOn(),
	},
	{
		icon: "hand",
		glyph: "M",
		label: "Pan",
		commandId: "handwriting:inline-tool-pan",
		isActive: (h) => h.panOn(),
		// BUILT EVERYWHERE, and it folds like everything else.
		//
		// It was mouse-only for a day: panning with the tip is a workaround
		// for not having a finger, so a phone was spending width on a gesture
		// the user's other hand was doing anyway ("13 buttons is too much,
		// especially on phone"). The owner then ruled that the width problem
		// belongs to the FOLD, not to the button's existence - "pan in the
		// fold list fine", and "this is just the default, where the pan button
		// sits on the strip because we are making a customization thing in
		// settings" (alan, 2026-09-05). So Pan is built on every device, sits
		// second in the default fold order, and a narrow pane sends it under
		// the chevron instead of deleting it.
	},
	{
		icon: "keyboard",
		glyph: "K",
		label: "Keyboard mode (pen input off)",
		commandId: PEN_INK_TOGGLE,
		// ON EVERY SURFACE, the pdf's included. It was built only where the
		// host said it could be honoured for two days, and the owner reversed
		// that - "why would you take keyboard mode away from pdf" - so there
		// is no surface left that cannot honour it and no reason to ask.
		// `shownOn` below rules on the DEVICE, never on the surface, and that
		// distinction is the whole of why the field is back at all.
		//
		// ONCE A PEN HAS BEEN ON THIS DEVICE, OR ON AN ORDINARY-NOTE IPHONE.
		// The latter needs this as the explicit exit from finger drawing and it
		// stays present while off so Pen/Highlighter can re-enter. Elsewhere,
		// Alan's 2026-09-05 device rule remains:
		// directly: "yeah mouse only users should never see it, i think" - a
		// machine with no pen has no pen to turn off, and the button is a slot
		// on a row he had just called too wide for a phone.
		//
		// THE LATCH, NOT EITHER FLAG BESIDE IT, and the brief named the wrong
		// one. It asked for `penSeen` (`penSeenThisSession`), which every tool
		// command, the mouse-ink toggle and the settings switch also set - so
		// it is a constant `true` for a mouse-only user from their first press
		// of the strip onward, and the button would appear for exactly the
		// people the ruling is about. That is the same misreading that hid the
		// `nibIsLit` bug for three releases; PenToolsMode.ts says so at the
		// head of the file.
		//
		// `penHardwareSeen()` is the honest present-tense read and is wrong
		// HERE for a different reason: `clearPenHardwareSeen` puts it back to
		// false on every mouse-ink-off, deliberately, while deliberately
		// sparing `penSeen` - because keying the toolbar's existence off
		// something that goes false is what produced "why the fuck would the
		// toolbar disappear". A button whose existence went false the same way
		// is that complaint at one button's scale, and this slice's brief
		// forbids it outright: nothing may disappear based on state.
		//
		// So: the latched fact, which only ever goes false-to-true. See
		// `penHardwareEverSeen` for the full three-flag account.
		//
		// AND IT SURVIVES A RESTART, since 1.4.12. Alan, 2026-09-05: "mouse
		// only users should never see it" - which the session-scoped latch
		// honoured, at the price of the pen user losing the button at every
		// launch until the nib next touched the glass. main.ts restores the
		// latch from THIS DEVICE's local store before any strip is built, so a
		// pen device opens with the button and a mouse-only device never grows
		// one - not even one syncing its data.json from a device that has a pen
		// (see `PEN_HARDWARE_SEEN_KEY` in PenToolsMode.ts).
		shownOn: (h) => penHardwareEverSeen() || (h.fingerInkAvailable?.() ?? false),
		//
		// LIT WHILE THE PEN IS OFF - the light means "the keyboard has the
		// note", not "this button is armed to do something". Every other
		// light on the strip is a tool the tip is holding; this one is the
		// absence of all of them, and it is lit precisely when nothing else
		// on this row can be.
		//
		// Through the host rather than straight off the module: both surfaces
		// answer `penInkEnabled()` today, and the seam is what stops a future
		// surface's light being a global's answer to a question about some
		// other pane (`MobileToolsHost.penInksHere`).
		isActive: (h) => !h.penInksHere(),
	},
	{
		icon: "trash-2",
		glyph: "D",
		label: "Delete selection",
		startsGroup: true,
		commandId: "handwriting:delete-selected-ink",
		isEnabled: (h) => h.hasInkSelection(),
	},
	{
		icon: "copy",
		glyph: "Cp",
		label: "Lasso: copy selection",
		commandId: "handwriting:copy-selected-ink",
		isEnabled: (h) => h.hasInkSelection(),
	},
	{
		icon: "clipboard-paste",
		glyph: "V",
		label: "Lasso: paste",
		commandId: "handwriting:paste-ink",
		isEnabled: (h) => h.canPasteInk(),
	},
	{
		icon: "undo-2",
		glyph: "U",
		label: "Undo",
		commandId: "editor:undo",
		isEnabled: (h) => h.canUndo(),
		startsGroup: true,
	},
	{ icon: "redo-2", glyph: "R", label: "Redo", commandId: "editor:redo", isEnabled: (h) => h.canRedo() },
];

/**
 * The order buttons leave the first row in, when it will not fit.
 *
 * ALAN'S, and amended by him after reading the first version (2026-09-05):
 * "delete and keyboard mode should be swapped, and keyboard mode wont even
 * appear if they dont use a pen right?" - so Delete is NOT in this list at
 * all. It is the frequent action, and keeping it on the row is the same
 * ruling that made the selection three dim rather than hide earlier the same
 * day.
 *
 * Read as a sentence: the history's second half goes first, then Pan - the
 * tip mode a device with a finger has least use for - then the button a
 * device that has never held a pen does not even have, then the clipboard
 * pair from the least-used end, and only then does another tip mode go. What
 * is left on a phone is the two nibs, the two tip modes worth reaching,
 * Delete, Undo and the chevron.
 *
 * Ids, not indices into BUTTONS, because two of these buttons may not exist
 * on a given device and an index-based list would silently mean a different
 * button on a phone than it means on a desktop.
 */
export const DEFAULT_FOLD_ORDER: readonly string[] = [
	"editor:redo",
	"handwriting:inline-tool-pan",
	PEN_INK_TOGGLE,
	"handwriting:paste-ink",
	"handwriting:copy-selected-ink",
	"handwriting:inline-tool-space",
];

/**
 * A saved fold order, made safe to use.
 *
 * The order is a SETTING now (alan, 2026-09-05: "maybe we can have a way you
 * can rearrange the symbols in the fold list, for some customization" ->
 * "it goes out in 1.4.12"), which means the array reaching this function came
 * off disk and can say anything: an id from a build that had a button this one
 * does not, an id this build gained after the file was written, the same id
 * twice, a button that must never fold, or something that is not an array at
 * all.
 *
 * The rules, in this order, and each one is a defect it prevents rather than a
 * tidiness:
 *  - only ids in the demotable set survive. `pen`, `highlighter`, `eraser`,
 *    `lasso`, Delete and Undo are not in it and never fold: a saved order that
 *    named one of them would otherwise fold a button the row is meant to keep.
 *  - duplicates drop, keeping the FIRST. A repeated id would demote nothing the
 *    second time (it is already gone) but would silently shorten the fold list
 *    by one, so a row one button too wide would stop folding early.
 *  - every missing demotable id is appended in default order. Without this, a
 *    file written by a build with fewer foldable buttons would leave the new
 *    ones unfoldable, and a narrow row would simply overflow.
 *
 * So the result always contains exactly the demotable set, once each, in the
 * user's order where they gave one. It cannot lose a button and it cannot fold
 * one that must not fold, whatever the file says.
 */
export function normalizeFoldOrder(raw: unknown): string[] {
	const demotable = new Set(DEFAULT_FOLD_ORDER);
	const out: string[] = [];
	if (Array.isArray(raw)) {
		for (const value of raw) {
			if (typeof value !== "string") continue;
			if (!demotable.has(value)) continue;
			if (out.includes(value)) continue;
			out.push(value);
		}
	}
	for (const id of DEFAULT_FOLD_ORDER) if (!out.includes(id)) out.push(id);
	return out;
}

/**
 * What the strip DRAWS for one button, and nothing about what it does.
 *
 * The settings control has to show the same icon and the same name the strip
 * shows, for buttons it must never be able to press. Handing it a `ButtonSpec`
 * would hand it the live predicates and the whole click chain behind them;
 * handing it a face hands it the four fields a row actually needs.
 *
 * `commandId` rides along because the fold order is written in ids: the
 * control reorders ids and hands ids back to `applyStripFoldOrder`, and a face
 * with no id would need a parallel array to say which button it was.
 */
export interface StripButtonFace {
	commandId: string;
	/** The icon name `setIcon` is called with, so a second drawer calls the same. */
	icon: string;
	/** The two-char fallback drawn when the icon set has no such glyph. */
	glyph: string;
	label: string;
	/** The nib whose ink this button wears at all times, if it wears one. */
	inkTool?: "pen" | "highlighter";
}

const faceOf = (spec: ButtonSpec): StripButtonFace => ({
	commandId: spec.commandId,
	icon: spec.icon,
	glyph: spec.glyph,
	label: spec.label,
	inkTool: spec.inkTool,
});

/** One id's face, or null for an id this build has no button for. */
export function stripButtonFace(commandId: string): StripButtonFace | null {
	const spec = BUTTONS.find((b) => b.commandId === commandId);
	return spec ? faceOf(spec) : null;
}

/**
 * Would a strip built for this host carry this button AT ALL?
 *
 * `shownOn` rules a button absent rather than disabled (see `ButtonSpec`), and
 * Keyboard is absent on a machine that has never held a pen. Anything drawing a
 * list of "the buttons that can move" has to ask the same question the strip
 * asks, or it offers the user a row for a button that is not on their toolbar -
 * and, worse, counts it. `overflowPlan` skips an id it cannot find and carries
 * on demoting, so a list that included the missing one would be one row out of
 * step with the strip beside it.
 *
 * The host, not a global, for the same reason every other read here takes one:
 * a strip is built for a host and the suite has to be able to ask for a
 * mouse-only device and a pen device in the same run.
 */
export function stripBuildsButton(commandId: string, host: MobileToolsHost): boolean {
	const spec = BUTTONS.find((b) => b.commandId === commandId);
	return spec !== undefined && (spec.shownOn?.(host) ?? true);
}

/**
 * The buttons that NEVER fold, in the order they sit on the strip.
 *
 * DERIVED - `BUTTONS` less everything the fold order may demote - rather than
 * a second hand-written list of the same six ids. The two lists are one fact
 * seen from opposite ends, and a build that made a seventh button foldable
 * would otherwise leave it standing in the settings tab's "always on the first
 * row" legend while the strip quietly folded it away.
 *
 * `shownOn` is deliberately NOT consulted: this is the legend for the strip in
 * general, not a reading of the strip in some pane, and all six of these are
 * built on every device anyway.
 */
export const NEVER_FOLDING_FACES: readonly StripButtonFace[] = BUTTONS.filter(
	(spec) => !DEFAULT_FOLD_ORDER.includes(spec.commandId)
).map(faceOf);

/**
 * How a strip differs from the one the editor builds. Empty for a real strip.
 */
export interface MobileToolsOptions {
	/** Surface capabilities are fixed for one mounted strip. */
	supportedCommands?: ReadonlySet<string>;
	additionalButtons?: readonly ButtonSpec[];
	/**
	 * A strip built to be LOOKED AT rather than used: the settings tab's
	 * fold-order preview, and nothing else today.
	 *
	 * It changes exactly two things, and both are about what a strip reaches
	 * OUTSIDE its own parent:
	 *
	 *  - the collapsed state is neither inherited nor, and this is the half
	 *    that matters, WRITTEN. `setCollapsed` is the session's setter - it
	 *    assigns `collapsedSession` - so a preview calling it to make itself
	 *    visible would collapse or expand every real strip in the window. A
	 *    preview born collapsed is `display: none`, measures zero and folds
	 *    nothing, which is a preview of nothing; a preview that fixed that by
	 *    calling the setter would be a settings tab quietly changing the
	 *    editor. So it simply never asks.
	 *
	 *  - the header clearance is skipped on the two paths this flag controls,
	 *    the first pass and the resize observer. It hunts `.view-actions` in the
	 *    parent and dodges it; a settings pane has no such row, so on every
	 *    resize frame it would clear two transforms and measure nothing. NOT
	 *    skipped everywhere: `setCorner` calls it unguarded, so a preview does
	 *    run it once, harmlessly - it returns at the missing `.view-actions`
	 *    before it measures anything.
	 *
	 * Everything else is the real strip ON PURPOSE: the same buttons, the same
	 * `layoutOverflow`, the same `overflowPlan`. A preview drawn any other way
	 * is a drawing, and a drawing is free to disagree with the strip.
	 */
	preview?: boolean;
}

/**
 * The live fold order, and every strip currently showing one.
 *
 * The same shape as `setToolbarCorner` (InkOverlay.ts): a module variable the
 * setting writes, then pushed into every strip already on screen so a change
 * lands at once instead of waiting for the next rebuild. It lives HERE rather
 * than beside that setter because this file deliberately does not import
 * InkOverlay - the fold order is a fact about the strip, and the import would
 * be a cycle.
 *
 * `liveStrips` is what makes the push possible, and it is a leak if it is
 * wrong: a strip registers once it is in the tree and drops itself in
 * `destroy()`, the same lifetime its resize observer and its three document
 * listeners already have. A strip left in this set would be re-folded after
 * its pane had gone.
 *
 * Normalised on the way in as well as on the way off disk. It costs nothing
 * and it means this setter is safe for a caller that has not normalised -
 * a future settings control, say - rather than trusting every call site to
 * remember.
 */
let foldOrder: readonly string[] = DEFAULT_FOLD_ORDER;
const liveStrips = new Set<MobileTools>();
const liveNoteZoomControls = new Set<NoteZoomControls>();

export function setStripFoldOrder(order: readonly string[]): void {
	foldOrder = normalizeFoldOrder(order);
	for (const strip of liveStrips) strip.applyFoldOrder();
}

/**
 * Push a canvas change into every strip already on screen.
 *
 * `setStripFoldOrder`'s shape, for its reason, and needed for the same kind of
 * change: the global Infinite Canvas row is written in main.ts and the zoom
 * bar's own mode has a listener while the canvas has none, so without this a
 * user turning the canvas off would keep a zoom bar until the pane was rebuilt
 * - the "only applies on restart" defect the override's listener was written
 * to avoid. The per-note case comes in through each control's own subscription;
 * this is the global half.
 */
export function refreshNoteZoomControlsAll(): void {
	for (const controls of liveNoteZoomControls) controls.refresh();
}

/** Note zoom chrome has its own lifetime; a note need not have a pen strip. */
/**
 * How long the chrome stays invisible after a lift before it fades back
 * (styles.css: the base rules' `opacity 60ms linear 160ms`).
 */
const STEP_BACK_MS = 160;

/**
 * One step-aside edge for a set of chrome elements that hide together.
 *
 * `is-inking` fades them out by opacity and makes them unhittable. When it
 * comes off, they are still invisible for STEP_BACK_MS, and `visibility`
 * used to keep them unhittable through that delay; a visibility transition
 * cannot run on the compositor, so it is gone, and `is-stepping-back` carries
 * the delay instead: on at the lift, off when the fade starts, or at once if
 * the pen comes down again first. Class toggles and one timer, no reads.
 */
class StepAside {
	private hidden = false;
	private timer: number | null = null;
	private win: Window | null = null;
	constructor(private readonly els: () => readonly HTMLElement[]) {}
	set(hide: boolean): void {
		// refresh() re-applies the current state; that must not cut a
		// running return delay short.
		if (hide === this.hidden) return;
		this.hidden = hide;
		this.cancel();
		const els = this.els();
		// The window the chrome lives in (a popout has its own); none for a
		// detached element, which has no delay to keep.
		const view = els[0]?.ownerDocument?.defaultView;
		const win = typeof view?.setTimeout === "function" ? view : null;
		const lifted = !hide && win !== null;
		for (const el of els) {
			el.toggleClass("is-inking", hide);
			el.toggleClass("is-stepping-back", lifted);
		}
		if (!lifted) return;
		this.win = win;
		this.timer = win.setTimeout(() => {
			this.timer = null;
			for (const el of this.els()) el.toggleClass("is-stepping-back", false);
		}, STEP_BACK_MS);
	}
	cancel(): void {
		if (this.timer === null) return;
		this.win?.clearTimeout(this.timer);
		this.timer = null;
	}
}

export class NoteZoomControls {
	readonly element: HTMLElement;
	private readonly buttons: HTMLButtonElement[] = [];
	private inking = false;
	private readonly stepAside = new StepAside(() => [this.element]);
	private stopModeWatch: (() => void) | null = null;
	private stopCanvasOverrideWatch: (() => void) | null = null;

	constructor(parent: HTMLElement, private readonly host: Pick<MobileToolsHost, "noteViewport" | "notePath">) {
		const viewport = host.noteViewport;
		if (!viewport) throw new Error("note zoom controls need a note viewport");
		this.element = parent.createDiv({cls:"handwriting-note-viewport-controls",attr:{role:"group","aria-label":"Note zoom"}});
		for (const [label, value, action] of [
			["Zoom out", "−", () => viewport.zoomNoteBy(.5)],
			["Reset note zoom to 100%", "100%", () => viewport.resetNoteZoom()],
			["Zoom in", "+", () => viewport.zoomNoteBy(2)],
			["Fit handwriting", "Fit", () => viewport.fitHandwriting()],
		] as const) {
			const button = this.element.createEl("button", {text:value,attr:{type:"button","aria-label":label,title:label}});
			button.addEventListener("pointerdown", e => e.preventDefault());
			button.addEventListener("click", () => { action(); this.refresh(); });
			this.buttons.push(button);
		}
		this.refresh();
		liveNoteZoomControls.add(this);
		this.stopModeWatch = onNoteZoomControlsChanged(() => this.refresh());
		this.stopCanvasOverrideWatch = onCanvasOverrideChanged(path => {
			if (this.host.notePath?.() === path) this.refresh();
		});
	}

	refresh(): void {
		const state = this.host.noteViewport?.getNoteViewportState();
		if (state) this.buttons.forEach((button, i) => {
			button.disabled = state.busy || (i === 3 && !state.fitAvailable) || (i === 2 && state.zoom >= MAX_PINCH_SCALE);
			if (i === 1) button.textContent = `${Number((state.zoom * 100).toPrecision(3))}%`;
		});
		const path = this.host.notePath?.() ?? null;
		this.element.toggleClass("is-hidden", !noteZoomControlsVisibleWithCanvas(
			getNoteZoomControlsMode(), canvasForNote(path, getZoomBarCanvasEnabled())
		));
		this.setInking(this.inking);
	}

	setInking(on: boolean): void {
		this.inking = on;
		this.stepAside.set(on && getNoteZoomControlsMode() === "auto");
	}

	penUp(): void {
		this.setInking(false);
		// The gesture clears mode and builder after this call. Read the ready state then.
		queueMicrotask(() => { if (liveNoteZoomControls.has(this)) this.refresh(); });
	}

	destroy(): void {
		this.stopModeWatch?.();
		this.stopCanvasOverrideWatch?.();
		this.stopModeWatch = null;
		this.stopCanvasOverrideWatch = null;
		this.stepAside.cancel();
		liveNoteZoomControls.delete(this);
		this.element.remove();
	}
}

export function ensureNoteZoomControls(
	current: NoteZoomControls | null,
	container: HTMLElement | null,
	parent: () => HTMLElement,
	host: Pick<MobileToolsHost, "noteViewport" | "notePath">
): NoteZoomControls | null {
	return current ?? (container ? new NoteZoomControls(parent(), host) : null);
}

export function destroyNoteZoomControls(current: NoteZoomControls | null): null {
	current?.destroy();
	return null;
}

/**
 * The specs whose presence is a QUESTION, precomputed.
 *
 * `stale()` runs on paths a pointer can drive - the pdf surface calls
 * `ensureTools` from its cursor path - so it walks these two rather than all
 * thirteen buttons, and allocates nothing while doing it. Derived from
 * `BUTTONS` rather than listed by hand, so a third `shownOn` is covered by
 * adding the field and nothing else.
 */
const CONDITIONAL_BUTTONS: readonly ButtonSpec[] = BUTTONS.filter(
	(spec) => spec.shownOn !== undefined
);

/**
 * Collapsed is a SESSION preference, not a per-note one: collapsing the
 * strip in one note means "get out of my way", and it would be rude to
 * reappear full-size on the next note. New strips are born matching it.
 */
let collapsedSession = false;

/**
 * How long the strip takes to fly from where it was dropped to the anchor it
 * landed on. Declared here and in `styles.css`'s `.is-anchoring` rule, which
 * is the pair a test pins: this number only decides when the class comes back
 * OFF, and a value shorter than the transition would cut the flight short.
 */
export const ANCHOR_FLIGHT_MS = 160;

/** One live drag of the toolbar by a handle. See `armDrag`. */
interface ToolbarDragState {
	pointerId: number;
	handle: HTMLElement;
	startX: number;
	startY: number;
	/** Has it passed the threshold? Until it has, this is still a tap. */
	moved: boolean;
	/** The box the strip rested in when the drag began, measured once. */
	box: { left: number; top: number; right: number; bottom: number };
	/**
	 * The actions-row dodge that was IN that box when it was measured.
	 *
	 * `box` comes off the live element, so it carries whatever
	 * `applyHeaderClearance` had translated the strip by - up to a hundred px
	 * on a pdf whose three-dots row the strip's corner sits under. The anchor
	 * rule knows nothing about that dodge: `anchorRestingCentre` answers where
	 * the STYLESHEET puts a strip, with no dodge term in it. Comparing the one
	 * against the other compares two different frames, and a ten-px nudge on
	 * the grip was landing a hundred px from where the drop was aimed - far
	 * enough to change the answer for a gesture that expressed no move at all.
	 *
	 * Kept from the MEASUREMENT rather than read again at the drop, because
	 * the dodge can change mid-drag (the pdf surface reaches `setCorner` on
	 * every strip refresh) and the strip moves with it: subtracting today's
	 * dodge from a box measured under yesterday's would put the error back in
	 * with the opposite sign.
	 */
	dodge: { x: number; y: number };
}

export class MobileTools {
	private el: HTMLElement;
	private buttons: Array<{ el: HTMLElement; spec: ButtonSpec }> = [];
	/**
	 * The command ids this strip was actually BUILT with, so `stale()` can
	 * tell a changed `shownOn` answer from an unchanged one. A set of ids
	 * rather than a recorded snapshot of the predicates: what matters is
	 * which buttons are on the strip, and a future `shownOn` is covered
	 * without this field learning anything about it.
	 */
	private readonly built = new Set<string>();
	/**
	 * The second row, and the "More" button that opens it (item 4).
	 *
	 * Both always exist; the row is empty and the chevron hidden whenever the
	 * first row fits, which is every desktop and every tablet. Built rather
	 * than created on demand because `layoutOverflow` runs from a
	 * ResizeObserver callback, and a path that may or may not have an element
	 * to move a button into is a path that will one day not.
	 */
	private moreRow!: HTMLElement;
	private moreBtn!: HTMLElement;
	/** Whether the second row is showing. Closed by a tool pick and by a tap
	 * outside, per the brief; not wired into `hasOpenPop`, because Escape's
	 * job there is the pops and a folded row is not one. */
	private moreOpen = false;
	/**
	 * Every node of the first row in its canonical order - dividers and
	 * buttons alike - so a button coming BACK from the second row lands
	 * between the right neighbours instead of at the end.
	 *
	 * Without this the restore would have to reason about which divider a
	 * returning button belongs after, which is exactly the bookkeeping
	 * `startsGroup` exists to avoid anybody doing by hand.
	 */
	private readonly rowOrder: HTMLElement[] = [];
	/** The plan last APPLIED, so an unchanged one costs no DOM moves. */
	private appliedPlan = "";
	private appliedOrder = "";
	/**
	 * The grid last WRITTEN - `"<columns>:<cell px>"` - for the same reason
	 * `appliedPlan` exists. Both custom properties are re-derived on every
	 * resize frame and change on almost none of them, and a style write that
	 * sets a property to the value it already holds still invalidates it.
	 */
	private appliedGrid = "";
	private resizeWatch: { disconnect(): void } | null = null;
	private inking = false;
	private readonly stepAside = new StepAside(() => [this.el, this.pill]);
	private stopModeWatch: (() => void) | null = null;
	/**
	 * The corner this strip is parked in, kept because item 5's clearance
	 * needs to know which way to dodge and `setCorner` otherwise wrote the
	 * answer straight into a class and forgot it.
	 */
	private corner: ToolbarCorner = "top-right";
	/**
	 * THE TWO WRITERS OF `transform`, kept as numbers so that ONE function
	 * writes the property.
	 *
	 * `applyHeaderClearance` sets an inline transform to dodge the pane's
	 * actions row and REPLACES the whole property while doing it - that is
	 * documented in `CornerSafeArea.test.ts`, which pins the middles to auto
	 * margins precisely because a `translateX(-50%)` in the stylesheet would
	 * be erased by it. A drag wants to write the same property, and the two
	 * would clobber each other: the resize observer fires
	 * `applyHeaderClearance` on rotation, on a split being dragged and on the
	 * sidebar opening, every one of which can happen with a finger still on
	 * the grip, and the dodge landing mid-drag would put the strip back where
	 * the pointer is not.
	 *
	 * So neither of them writes `transform`. They write these, and
	 * `paintTransform` composes the one string. The dodge is a translate the
	 * strip keeps whether or not it is being dragged; the drag is a DELTA
	 * from wherever the strip already was, which is what makes composing them
	 * by addition the right answer rather than a compromise - the strip
	 * tracks the pointer exactly, and a dodge that changes mid-drag moves it
	 * by the amount the actions row actually moved.
	 */
	private dodge: { x: number; y: number } = { x: 0, y: 0 };
	private dragOffset: { x: number; y: number } = { x: 0, y: 0 };
	/**
	 * The live drag, or null. `moved` is the threshold: until it flips this
	 * is a contact that may yet turn out to be a tap, and nothing has been
	 * painted, no pop has been closed and the pill's click still works.
	 */
	private drag: ToolbarDragState | null = null;
	/**
	 * A drag ended on a handle, so the click the browser synthesizes from
	 * that same release must not be taken as a tap. Set on the drop, cleared
	 * by the pill's click and by the next contact, so it can never outlive
	 * the gesture that armed it.
	 */
	private dragClickArmed = false;
	/** The `.is-anchoring` sweep-off, so a second drop cannot leave the
	 * class on and animate the next dodge. */
	private anchorTimer: number | null = null;
	/** The grip: six dots at the strip's leading end, and the drag handle. */
	private grip!: HTMLElement;
	private slider!: SliderParts;
	private penSlider!: SliderParts;
	private hlSlider!: SliderParts;
	/** Which nib's size slider is open; tap the active tool again to toggle. */
	private openInkSlider: "pen" | "highlighter" | null = null;
	private sliderHoverTimer: number | null = null;
	/**
	 * THE HOLD TIMERS, held here rather than in the closures that arm them.
	 *
	 * Both were `let holdTimer` inside the listener that started them, which
	 * meant nothing outside that closure could stop them - and this class is
	 * destroyed and rebuilt on a pen edge (`stale()`), so a 600ms hold armed
	 * just before a rebuild fired against a strip that no longer existed. The
	 * preset one is the defect with teeth: `paintPresets` empties and rebuilds
	 * the chip row, so a hold armed on a chip that has since been redrawn
	 * fired `forgetPreset` against an INDEX that now names a different pen -
	 * a starred pen deleted after the finger lifted (review, 2026-09-05).
	 */
	private recordingHoldTimer: number | null = null;
	private presetHoldTimer: number | null = null;
	/** Set true the instant a hold-timer forgets a preset, before the finger
	 * has physically lifted. `paintPresets` empties and rebuilds the row right
	 * there, so the button under the finger is destroyed and whatever now
	 * sits at that screen position (often the former neighbour) is a BRAND
	 * NEW button with its own fresh `held = false` closure. On Windows the
	 * release still fires a contextmenu after the hold, and it lands on that
	 * new button - which has no memory of the hold that just ran, and would
	 * forget a second preset (item 73 audit, "press-and-hold delete on a
	 * preset chip also deletes its neighbour"). This flag lives on the strip,
	 * not on a chip closure, so it survives the rebuild the closure does not. */
	private suppressNextPresetContextMenu = false;
	private recordingDot!: HTMLElement;
	/** Whether the dot was last drawn lit, so a flip can re-plan the fold. */
	private recordingShown = false;
	private collapseBtn!: HTMLElement;
	/** True when HOVER opened the slider - only those evaporate on leave.
	 * A clicked-open slider is a decision and stays until a click, a tap
	 * elsewhere, or writing closes it (the pen LEAVES a button it just
	 * tapped, and 300ms later the slider it asked for was gone). */
	private sliderFromHover = false;

	/**
	 * The slider input under a finger right now, or null.
	 *
	 * `hangUnder` will not write a value into this one. Writing into a
	 * control the user is holding is wrong whatever the value is: the thumb
	 * is answering to two masters, and on any engine where an assignment
	 * disturbs a drag in flight the two take turns setting it - "weird
	 * distortion on the pen slider as i slide it up and down, like the
	 * slider is just vibrating" (alan, on hardware, 2026-09-02).
	 *
	 * Held by input IDENTITY rather than a flag per slider, so the release
	 * is one document listener for all three and a fourth slider inherits
	 * the guard just by being built through `dropSlider`. A drag flag, not
	 * `document.activeElement`: a range input keeps focus after the pointer
	 * lifts, so an activeElement test would suppress every later write-back
	 * until focus moved on, and focus is the part least likely to behave the
	 * same in an Android WebView as it does on desktop.
	 */
	private heldSlider: HTMLInputElement | null = null;

	/**
	 * There is no `colorsOpen` any more, and its absence is the whole of item
	 * 1: the swatches used to live in a pop of their own, hung under an "Ink
	 * color" button, and exactly one pop could be open at a time - so every
	 * branch that opened a size slider closed the colours, and vice versa.
	 * The swatches are now a ROW INSIDE each nib's size pop, so opening a
	 * nib's options IS opening its colours and there is no second state to
	 * keep in step with the first.
	 */
	private strokeChip!: HTMLElement;
	private reticleChip!: HTMLElement;

	/**
	 * The eraser's size/behavior pop (`this.slider`, built at :561 by the
	 * same `dropSlider` helper as the pen/highlighter pops) is a third
	 * object Slice P never knew about: `hangUnder`'s call for it (refreshNow,
	 * :768) shows it for as long as `eraserOn()` is true, full stop, so
	 * Escape found nothing to consume while erasing (alan, 2026-09-02).
	 * `closeInkSliders` sets this now, the same as every other pop it closes
	 * - pen contact, an outside tap and Escape all put the eraser pop away
	 * exactly like the size and colour pops (alan, 2026-09-02: "you eraser
	 * pop should close when pen touches down... we did it for other tools
	 * but never did it for eraser" - the "leave it alone for pen-down and
	 * outside taps" reasoning this comment used to give was the omission he
	 * meant, not a decision). It clears itself the next time the eraser is
	 * switched ON - the false-to-true edge `refreshNow` watches below -
	 * covering the strip button, the palette command and a hotkey alike,
	 * since none of those paths run through this object's own click handler.
	 * That edge was the only way back to the pop once contact closed it
	 * until §5p (alan, 2026-09-02: "pressing the eraser while it is already
	 * active should reopen its size pop, not switch the tool off" - a mouse
	 * excepted, "mouse sould disable"): the click handler's eraser branch
	 * now CLEARS this bit directly too, so the way back is one tap. It only
	 * clears - it never sets - because a press made while the pop is already
	 * showing is not asking for the pop, and is left to switch the tool off
	 * the way it always did. So the only things that SET it are
	 * `closeInkSliders` and the hover-leave timer in `scheduleSliderClose`,
	 * and the only things that clear it are the activation edge, the
	 * mouse-hover preview and that tap.
	 */
	private eraserPopClosed = false;

	/** True when HOVER is what opened the eraser pop - mirrors
	 * `sliderFromHover` above, kept as a separate bit rather than folded
	 * into that field because the eraser was never a member of the union
	 * it protects (`openInkSlider` is `"pen" | "highlighter" | null`); the
	 * eraser's pop is driven by `eraserPopClosed` instead, so "don't
	 * auto-close what a tap opened" needs a flag pointed at that bit
	 * specifically (§5p AI CONFIRMED, item 1). Set only by the eraser's
	 * mouse-only hover-open in the `pointerenter` handler below - see
	 * there for why pen does not share this path - and consumed the same
	 * way `sliderFromHover` is, in `scheduleSliderClose`. */
	private eraserPopFromHover = false;

	/** The `eraserOn()` seen on the last `refreshNow`, so the eraser pop's
	 * OFF-to-ON edge can be told apart from "still on" - see
	 * `eraserPopClosed`. Seeded from the host in the constructor, NOT left at
	 * this default: the mode is global and this bit is per-strip, so a strip
	 * that mounts into an eraser session is arriving mid-mode and has watched
	 * no switch at all. */
	private wasEraserOn = false;

	private pill: HTMLElement;

	/**
	 * The ctor's `parent`, kept by name. Escape's ownership test needs the
	 * pane itself, not just the elements built inside it (§5p): a strip
	 * consumes Escape only when the event's target sits inside its OWN pane,
	 * `this.pane.contains(...)`, never `this.el` alone (the pill and the
	 * strip are both children of it, and so is everything the editor draws).
	 */
	private readonly pane: HTMLElement;

	/**
	 * Whether the eraser's size/behavior pop is currently showing - the
	 * SAME condition `refreshNow`'s `hangUnder` call uses to drive its
	 * `is-showing` class (below), not a second copy of it: `eraserOn()`
	 * gates the pop the way `openInkSlider` gates the others, and
	 * `eraserPopClosed` is the one bit this object adds to suppress it
	 * without touching the tool.
	 *
	 * The `!colorsOpen` conjunct that used to sit here has gone with the
	 * colour pop it protected: the swatches are a row inside the nib pops
	 * now, so nothing can be showing over the eraser's pop that the eraser's
	 * own mode does not already exclude.
	 */
	private eraserPopOpen(): boolean {
		return this.host.eraserOn() && !this.eraserPopClosed;
	}

	/** Something open enough that Escape (or a stray tap) should close it. */
	private hasOpenPop(): boolean {
		return this.openInkSlider !== null || this.eraserPopOpen();
	}

	/** Closes open pops when a tap lands anywhere that is not the strip. */
	private readonly outsideTap = (ev: PointerEvent): void => {
		// `contains`, never instanceof: a popout window's elements belong to
		// another realm and instanceof refuses them, so this returned early
		// on every tap in a popout and the pops never dismissed there. The
		// note below describes fixing exactly that on glass - it was only
		// ever fixed for the main window. Same rule the routers already
		// spell out twice (InlinePenRouter: "a popout window's elements
		// belong to another realm"); contains works across realms.
		const t = ev.target as Node | null;
		if (!t) return;
		if (this.el.contains(t) || this.pill.contains(t)) return;
		// The folded row is a menu and dismisses like one (item 4: "tapping
		// outside or picking a tool closes it"). Here rather than inside
		// `closeInkSliders`, because that call is also what a PEN CONTACT
		// makes, and Escape's consume-or-ignore verdict is computed from
		// whether a POP was open - folding a row into that would have Escape
		// swallowed by a strip whose only open thing is a menu.
		this.setMoreOpen(false);
		// On glass there is no pen-down-over-the-page moment to hide behind:
		// a slider opened with a finger just STAYED, over whatever the next
		// tap was about, until another tool was pressed (ipad, 2026-08-30).
		// Desktop never felt it because writing closes the pops.
		this.closeInkSliders();
	};

	/**
	 * Trace-only: did a click reach the strip or the pill? Diagnosis for the
	 * tool-dependent strip-tap bug (InlinePenRouter.ts's window mirror):
	 * when a pen tap's `window-pointerdown` trace line says the composed
	 * path missed the editor scroller - the strip's normal position, since
	 * it mounts as a SIBLING of the scroller - that line alone cannot tell
	 * "the pointerdown hit the strip but no click was ever synthesized"
	 * from "a click arrived and the strip's own handler did nothing". This
	 * is the other half: a capture-phase listener on this strip's own pane,
	 * same as `outsideTap` beside it, so it sees the click before anything
	 * on the strip could stop it. `traceStripClick` gates on whether tracing
	 * is actually running, so the cost here while it is not is two cheap
	 * `contains()` calls - the same shape `outsideTap` already pays on
	 * every pointerdown in the document, unconditionally.
	 */
	private readonly traceClick = (ev: MouseEvent): void => {
		const t = ev.target as Node | null;
		if (!t || !(this.el.contains(t) || this.pill.contains(t))) return;
		traceStripClick(t as Element);
	};

	/**
	 * A slider drag ends wherever the pointer happens to be, and for a
	 * 28x104 slot that is very often NOT on the input: the pen lifts past
	 * the edge of the slot, or a gesture cancels the pointer outright.
	 * Listening on the document, in capture beside outsideTap and torn down
	 * beside it, is what keeps a slider from staying "held" for the rest of
	 * the session and silently suppressing every write-back after it.
	 */
	private readonly releaseSlider = (): void => {
		this.heldSlider = null;
	};

	/**
	 * Escape closes an open pop, the way it dismisses everything else
	 * transient here: a lasso selection and a held tip mode both already go
	 * that way (InkOverlay), and so does the pdf selection. The size and
	 * colour pops were the exception - once open, only a tap somewhere else
	 * would put them away, which is fine on glass and wrong on a keyboard
	 * (alan, hardware, 2026-09-02: "esc should close the slider").
	 *
	 * Consumed ONLY when a pop was actually open. Escape has other jobs in
	 * this editor, and a toolbar that swallows it whenever the strip exists
	 * would take the key away from clearing a selection - trading one missing
	 * dismissal for a worse one.
	 *
	 * Capture, beside outsideTap and torn down beside it, so it is heard
	 * before anything in the editor can stop it. No realm check is possible
	 * or needed: this reads the key, never the target.
	 *
	 * Split view is why "a pop was open" is not enough to consume. Every
	 * pane has its own MobileTools and its own capture listener on the SAME
	 * document, so one press reaches every strip in the window. A pop open
	 * in pane A and Escape pressed while working in pane B must close A's
	 * pop AND still let B's own Escape handling (its selection, its held
	 * tip) see the key - if A consumed it, B's selection would never clear.
	 * `stripEscapeVerdict` (`StripEscape.ts`, §5p) is what tells A apart
	 * from B: ownership, `this.pane.contains(ev.target)`, decides who is
	 * allowed to consume, not who happened to have something open.
	 */
	private readonly escapeKey = (ev: KeyboardEvent): void => {
		// A LIVE DRAG TAKES ESCAPE FIRST, and takes it unconditionally.
		//
		// `stripEscapeVerdict`'s ownership rule exists because every strip in
		// a window hears every Escape, so a pop open in pane A must not eat a
		// key meant for pane B. A drag has no such ambiguity: exactly one
		// strip in the window has a pointer captured on its handle, and it is
		// this one. Asking `ownsTarget` here would refuse the key whenever
		// focus sat in the editor - which is where it sits during every drag
		// ever made, since a strip button never takes focus.
		if (ev.key === "Escape" && !ev.defaultPrevented && this.drag?.moved === true) {
			this.cancelDrag(true);
			ev.preventDefault();
			ev.stopPropagation();
			return;
		}
		const verdict = stripEscapeVerdict({
			key: ev.key,
			defaultPrevented: ev.defaultPrevented,
			anyOpen: this.hasOpenPop() || this.moreOpen,
			ownsTarget: this.pane.contains(ev.target as Node | null),
		});
		if (verdict === "ignore") return;
		// The More row is an Escape layer without changing pen-contact dismissal.
		this.setMoreOpen(false);
		this.closeInkSliders();
		if (verdict === "close-consume") {
			ev.preventDefault();
			ev.stopPropagation();
		}
	};

	private viewportControls: NoteZoomControls | null = null;

	constructor(parent: HTMLElement, private host: MobileToolsHost, opts: MobileToolsOptions = {}) {
		// Read once into a local: the flag is consulted from the resize
		// observer's callback, which outlives this call, and a closure over one
		// boolean is cheaper to reason about than a field nothing else reads.
		const preview = opts.preview === true;
		this.pane = parent;
  if (host.noteViewport && !preview) this.viewportControls = new NoteZoomControls(parent, host);

		// The collapsed form: one small pen button that brings the strip back.
		this.pill = parent.createEl("button", {
			cls: "handwriting-pen-pill",
			attr: { "aria-label": "Pen tools", type: "button" },
		});
		// Obsidian's mobile swipe recogniser ignores touch-action and stands down only for a target under
		// `data-ignore-swipe`, so a finger dragging the pill would also open a sidebar or the palette.
		this.pill.dataset.ignoreSwipe = "true";
		setIcon(this.pill, "pen");
		if (!this.pill.querySelector("svg")) this.pill.setText("P");
		// Buttons must not take focus from the editor: undo/redo route to the
		// active editor, and a focus-stealing toolbar makes that a coin flip.
		// preventDefault here kills the compat mouse events that drive CSS
		// :active, so a pressed button showed NOTHING on touch until the click
		// landed at finger-lift (emulation, 2026-08-30). The pressed state is
		// a class managed on the same events instead.
		const noFocus = (el: HTMLElement) => {
			el.addEventListener("pointerdown", (ev) => {
				ev.preventDefault();
				el.classList.add("is-pressed");
				// A contact is a decision, not a hover preview: the diagnosis's
				// probe found a direct-manipulation pen (no hover) fires
				// pointerenter AT CONTACT, marking whatever pop that opened as
				// hover-opened even though the pen has already landed. Clearing
				// both flags here, rather than waiting for the click that
				// normally does it (below), means the close timer armed by this
				// same press's own pointerleave - or by a click that is late or
				// never arrives at all (pointercancel from tap drift) - has
				// nothing left to close.
				this.sliderFromHover = false;
				this.eraserPopFromHover = false;
			});
			const release = () => el.classList.remove("is-pressed");
			el.addEventListener("pointerup", release);
			el.addEventListener("pointerleave", release);
			el.addEventListener("pointercancel", release);
		};
		noFocus(this.pill);
		// The pill has its OWN tip, on the strip's parent beside it. The shared tip lives inside the strip,
		// which is display:none while the strip is folded, so a tip shown from the pill was never painted.
		this.pillTip = parent.createDiv({ cls: "handwriting-pill-tip" });
		this.attachTip(this.pill, () => this.pillTip);
		this.pill.addEventListener("click", (ev) => {
			ev.preventDefault();
			// A DRAG IS NOT A TAP. Pointer capture keeps the whole gesture on
			// the pill, so a drag that started here also ends here and the
			// browser synthesizes a click for it - which would expand the
			// strip at the far end of a gesture that was only ever about
			// moving it. `armDrag` leaves the flag up for exactly this check
			// and clears it on the next contact.
			if (this.consumeDragClick()) return;
			this.setCollapsed(false);
		});
		// The pill IS the handle while the strip is folded away: it is the
		// only thing on screen, and a collapsed toolbar is the state a phone
		// spends most of its time in. Same threshold, so the tap above still
		// reads as a tap.
		this.armDrag(this.pill);
		parent.ownerDocument.addEventListener("pointerdown", this.outsideTap, { capture: true });
		parent.ownerDocument.addEventListener("keydown", this.escapeKey, { capture: true });
		parent.ownerDocument.addEventListener("pointerup", this.releaseSlider, { capture: true });
		parent.ownerDocument.addEventListener("pointercancel", this.releaseSlider, { capture: true });
		parent.ownerDocument.addEventListener("pointerup", this.endDrag, { capture: true });
		parent.ownerDocument.addEventListener("pointercancel", this.endDrag, { capture: true });
		parent.ownerDocument.addEventListener("click", this.traceClick, { capture: true });
		this.el = parent.createDiv({ cls: "handwriting-mobile-tools" });
		// The whole strip, its grip and its pops included: see the pill above.
		this.el.dataset.ignoreSwipe = "true";
		// THE GRIP, and it is first so it is the strip's leading end - the row
		// is a plain flex row, so dom order is what the user sees left to
		// right, and the handle of a draggable thing belongs at its edge
		// rather than buried between two buttons.
		//
		// HIDDEN FROM ASSISTIVE TECH, deliberately: an aria-label on a bare
		// div is dropped by most screen readers anyway, and the keyboard route
		// to placement is the settings dropdown, which names all nine anchors. A
		// half-announced handle that cannot be operated is worse than a silent
		// one.
		//
		// A DIV, NOT A BUTTON. Every button on this strip runs a command on
		// click and is reached by the keyboard; the grip does neither - it is
		// a place to put a finger. Making it a button would put a dead stop in
		// the tab order and offer a press that does nothing.
		//
		// The dots are painted by the stylesheet on a fixed-size child rather
		// than by six spans: six elements to draw six dots is six more things
		// for `layoutOverflow` to walk and for a theme to disagree with.
		this.grip = this.el.createDiv({
			cls: "handwriting-tools-grip",
			attr: { "aria-hidden": "true" },
		});
		this.grip.dataset.ignoreSwipe = "true";
		this.grip.createDiv({ cls: "handwriting-tools-grip-dots" });
		this.armDrag(this.grip);
		// The recording indicator lives HERE, not the status bar: status
		// bars get hidden by themes and snippets, and an indicator nobody
		// can see indicates nothing. The strip is the plugin's own chrome.
		// An INDICATOR, not a button - it appears when recording starts and
		// disappears when recording ends, and does nothing when touched.
		this.recordingDot = this.el.createSpan({
			cls: "handwriting-recording-dot",
			attr: {
				"aria-label":
					"from Alan: records how your pen behaves - nothing from your notes 🙈 press and hold to stop",
			},
		});
		// Obsidian's tooltip machinery answers MOUSE hover only - a hovering
		// pen showed nothing (surface, windows ink). And it was not just the
		// dot: EVERY strip button relied on aria-label, so the whole toolbar
		// explained nothing on hover. One shared tip serves them all now,
		// driven by pointerenter, which every input fires. Text comes from
		// each element's aria-label - one source, editable in one place.
		this.tip = this.el.createDiv({ cls: "handwriting-strip-tip" });
		this.recordingDot.setText("●");
		this.attachTip(this.recordingDot);
		// The grip is built first, so that it is the row's leading element,
		// but named here: `attachTip` shows `this.tip`, which did not exist
		// until the line above.
		this.attachTip(this.grip);
		// Touch has no hover and deserves an exit: press and HOLD the dot to
		// stop recording. A hold, not a tap, so a stray finger cannot end a
		// recording someone is mid-way through reproducing a bug for. Runs
		// the real toggle command so every indicator syncs.
		const cancelHold = (): void => this.cancelRecordingHold();
		this.recordingDot.addEventListener("pointerdown", (ev) => {
			ev.preventDefault();
			cancelHold();
			this.recordingHoldTimer = window.setTimeout(() => {
				this.recordingHoldTimer = null;
				this.host.exec("handwriting:toggle-diagnostics");
			}, 600);
		});
		this.recordingDot.addEventListener("pointerup", cancelHold);
		this.recordingDot.addEventListener("pointerleave", cancelHold);
		this.recordingDot.addEventListener("pointercancel", cancelHold);
		const collapse = this.el.createEl("button", {
			cls: "handwriting-mobile-tool handwriting-tools-collapse",
			attr: { "aria-label": "Collapse pen tools", type: "button" },
		});
		this.collapseBtn = collapse;
		setIcon(collapse, "chevron-right");
		if (!collapse.querySelector("svg")) collapse.setText(">");
		noFocus(collapse);
		this.attachTip(collapse);
		collapse.addEventListener("click", (ev) => {
			ev.preventDefault();
			this.setCollapsed(true);
		});
		for (const spec of [...BUTTONS, ...(opts.additionalButtons ?? [])]) {
			if (opts.supportedCommands && !opts.supportedCommands.has(spec.commandId)) continue;
			// AHEAD of the divider, so a skipped button that opens a group
			// cannot leave an orphan divider standing where it was. Neither
			// of today's two skippable buttons starts a group - Pan sits mid
			// tip-group and Keyboard closes it - so this changes no divider
			// yet; it is written this way because the next one might.
			if (!(spec.shownOn?.(host) ?? true)) continue;
			if (spec.startsGroup) {
				this.rowOrder.push(this.el.createDiv({ cls: "handwriting-mobile-tools-divider" }));
			}
			const b = this.el.createEl("button", {
				cls: "handwriting-mobile-tool",
				attr: { "aria-label": spec.label, type: "button" },
			});
			this.rowOrder.push(b);
			setIcon(b, spec.icon);
			// If the icon set yields no svg, the button says its initial.
			if (!b.querySelector("svg")) b.setText(spec.glyph);
			noFocus(b);
			// Older WebKit sends a plain MouseEvent for click. Keep the type of
			// this button's contact so its click still takes the touch path.
			let contactType: string | null = null;
			b.addEventListener("pointerdown", (ev) => { contactType = ev.pointerType; });
			b.addEventListener("pointercancel", () => { contactType = null; });
			b.addEventListener("pointerenter", (ev) => {
				if (ev.pointerType === "touch") return;
				const hoverNib =
					spec.commandId === "handwriting:inline-tool-pen"
						? "pen"
						: spec.commandId === "handwriting:inline-tool-highlighter"
							? "highlighter"
							: null;
				// THE LIT predicate, not the active one (alan, 2026-09-03: "plain
				// mouse without mouse ink armed should not open the slider
				// popout, correct?" - he is right). `isActive` means "the
				// NOMINAL tool" and deliberately ignores mouse ink, so a plain
				// mouse with ink off used to hover the Pen button and be handed
				// a size slider for a tool that cannot lay down a stroke. Same
				// family as the dead-looking button that produced
				// `armMouseInkQuietly`, and the light was already telling the
				// truth beside it - this is the preview catching up to it.
				//
				// `spec.isLit ?? spec.isActive` is the render path's own
				// resolution (:1046 and the pill at :1093), so a button with no
				// `isLit` of its own - every one but the two nibs - is
				// untouched, and the eraser's preview branch below keeps its
				// separate §5p ruling.
				//
				// HOVER ONLY. The click path below still branches on `isActive`
				// and must: clicking an unlit nib is exactly how a mouse user
				// arms mouse ink (the final `else`'s `armMouseInkQuietly`), and
				// gating that would leave them no way in at all. Hover previews,
				// click decides.
				if (hoverNib && (spec.isLit ?? spec.isActive)?.(this.host)) {
					// The `if (this.colorsOpen) return` that used to guard this -
					// "crossing this button on the way to the palette must not
					// close what a CLICK opened" - guarded a pop that no longer
					// exists. The colours are a row inside the pop this branch
					// opens, so there is nothing left for a hover to cross to.
					this.cancelSliderClose();
					if (this.openInkSlider !== hoverNib) {
						this.openInkSlider = hoverNib;
						this.sliderFromHover = true;
						this.refresh();
					}
					return;
				}
				// The eraser has no slot in `hoverNib` - its pop rides
				// `eraserPopClosed`, not `openInkSlider` - so it needs its own
				// preview branch, and MOUSE ONLY (§5p AI CONFIRMED, item 1).
				// Pen is not excluded above, only touch is, so a pen reaches
				// this point too; it is turned away here on purpose, and the
				// reason is stronger than it was. The eraser's tap branch
				// below reads the pop's state: with the pop SHOWING, a
				// pen/touch press on the active eraser falls through to
				// exec() and switches the tool off. So a pen hover that
				// opened the pop first would turn the tap that followed it
				// into a tool-off - the pointer merely crossing the button on
				// its way there would change what pressing it does. The nib
				// case above has no such hazard: its pen branch only confirms
				// the slider open, and re-tapping a nib never puts it down.
				if (
					ev.pointerType === "mouse" &&
					spec.commandId === "handwriting:inline-tool-eraser" &&
					spec.isActive?.(this.host)
				) {
					this.cancelSliderClose();
					if (this.eraserPopClosed) {
						this.eraserPopClosed = false;
						this.eraserPopFromHover = true;
						this.refresh();
					}
				}
			});
			b.addEventListener("pointerleave", (ev) => {
				if (ev.pointerType === "touch") return;
				this.scheduleSliderClose();
			});
			b.addEventListener("click", (ev) => {
				ev.preventDefault();
				// A button drawn as unavailable must BE unavailable. Delete,
				// copy, paste, undo and redo dim to 0.35 when their predicate
				// says no, but nothing used to stop the click: the command ran
				// and answered with a toast saying what the dimming had
				// already said - "lasso some ink first" on a button greyed out
				// precisely because there is no selection. Worse, the press
				// animation is suppressed for a dimmed button, so it felt dead
				// and then scolded you.
				//
				// Guarded here rather than with pointer-events: none, which
				// would also take the tooltip away. A disabled control that
				// still explains itself on hover is the more useful one.
				//
				// The refresh on the way out is the whole reason this branch
				// is not just `return` (design doc §5i, C16). `isEnabled` is
				// read LIVE here; `is-disabled` is a class written by
				// `refresh()` and left alone until the next one, and nothing
				// on this surface refreshes the strip when the document
				// changes. So Redo lights after an undo, a keystroke drops
				// CodeMirror's redo stack, and the button goes on LOOKING
				// available while its predicate says no - and the bare return
				// skipped the trailing refresh at the bottom of this handler,
				// so it kept looking available and kept doing nothing on
				// every press after that. Refreshing here recomputes the
				// class from the same live predicate the guard just asked,
				// which costs one wasted press and then the button tells the
				// truth. Deliberately NOT a toast: the user asked for nothing
				// and a notice for pressing a button that looked pressable is
				// noise (the eraser/Backspace ruling, 2026-09-02). The button
				// stops lying rather than explaining itself.
				if (!(spec.isEnabled?.(this.host) ?? true)) {
					this.refresh();
					return;
				}
				// The GoodNotes pattern: tapping the tool you are already
				// holding opens its options instead of re-picking it.
				const nib =
					spec.commandId === "handwriting:inline-tool-pen"
						? "pen"
						: spec.commandId === "handwriting:inline-tool-highlighter"
							? "highlighter"
							: null;
				// A mouse only draws because its owner has no pen, so for
				// them the nib button IS the mode: clicking the active tool
				// hands the mouse back to text. Pen and touch keep the tap
				// (hover already opened the slider for anything that hovers).
				// A synthetic click has no pointerdown. On a touch device, a
				// legacy WebKit click with no pointerType is a finger tap unless a
				// preceding pointerdown identified a mouse or pen.
				const ptr = ev.pointerType || contactType || (this.host.hasTouch() ? "touch" : "mouse");
				contactType = null;
				const claimsTip =
					nib !== null ||
					spec.commandId === "handwriting:inline-tool-eraser" ||
					spec.commandId === "handwriting:inline-tool-lasso" ||
					spec.commandId === "handwriting:inline-tool-space" ||
					spec.commandId === "handwriting:inline-tool-pan";
				// `mouseDrawsHere`, not `mouseInkOn()`: on a pen-less device the
				// mouse draws because a tool is PICKED, with nothing armed, so
				// the old guard left that user's lit button unable to put
				// itself down at all.
				if (claimsTip && !this.host.penInksHere()) {
					// A paused tool is selected, not put down. Run Pen while still
					// paused so its command cannot toggle a newly lit pen off.
					if (nib === "pen" || !spec.isActive?.(this.host)) this.host.exec(spec.commandId);
					markToolPicked();
					if (!this.host.penInksHere()) this.host.exec(PEN_INK_TOGGLE);
					if (ptr === "mouse" && !this.host.mouseInkOn()) this.host.armMouseInkQuietly();
					if (nib) this.host.prepareFingerInk?.();
					this.host.setEditorFocus(false);
					// The iPhone first-tap rule (below: a tap that GRANTS a nib
					// its first ink, rather than adjusting one already drawing,
					// picks the tool without opening its pop) applies here too.
					// Leaving Keyboard mode reaches THIS branch, not that one -
					// ink is off in Keyboard mode, so `!penInksHere()` is true
					// and this branch runs first - so without this check the
					// pop opened over the note on every Keyboard exit (item 200).
					const iphoneFirstTap =
						nib !== null && ptr === "touch" && (this.host.fingerInkAvailable?.() ?? false);
					this.openInkSlider = iphoneFirstTap ? null : nib;
					this.sliderFromHover = false;
					if (spec.commandId === "handwriting:inline-tool-eraser") {
						this.eraserPopClosed = false;
						this.eraserPopFromHover = false;
					}
				} else if (
					nib &&
					ptr === "touch" &&
					(this.host.fingerInkAvailable?.() ?? false) &&
					!(spec.isLit ?? spec.isActive)?.(this.host)
				) {
					// On iPhone an apparent/default nib is not a grant. Its first
					// tap must pick the tool (or re-enter from Keyboard), not open
					// an options pop for a tool that cannot draw yet.
					this.host.exec(spec.commandId);
					setPenInk(true);
					this.host.prepareFingerInk?.();
					this.host.setEditorFocus(false);
					this.openInkSlider = null;
					this.sliderFromHover = false;
				} else if (nib && spec.isActive?.(this.host) && ptr === "mouse" && mouseDrawsHere(this.host)) {
					// Clicking the tool you are drawing with hands the mouse
					// back to text. Click it again and it draws again.
					//
					// QUIET, SINCE 1.4.10. This used to call `host.setMouseInk
					// (false)`, which both surfaces wired to the LOUD toggle
					// command - so putting the nib down wrote `mouseInk: false`
					// to data.json, and picking it back up wrote `true`. That
					// is the fourth path the "dont persist a quiet arm" ruling
					// (alan, 2026-09-04) was about and the one it missed: the
					// two edges below are the same session-only edges the four
					// tip tools take, and the rule is now written once for all
					// six buttons. Someone who turned the mode on BY NAME still
					// has it tomorrow; a nib click moves this session's pointer
					// and nothing else.
					//
					// The LIGHT is unchanged, which is the point of routing
					// through the wrappers rather than the bare module
					// functions: `releaseMouseInkQuietlyEverywhere` clears
					// `penHardware` and repaints every strip, which is exactly
					// what `applyMouseInkUiFanout(false)` did on the way past.
					// A nib put-down darkening the pen-hardware light is right
					// for the same reason the tip tools' put-down is - the
					// light says "something can ink with this", the mouse just
					// stopped being that something, and a mouse user has no
					// hardware for the flag to be true about (alan, 2026-09-03:
					// off "at any point").
					this.host.disarmMouseInkQuietly();
					// The words the loud command's off branch used, said here
					// because there is no exec on this branch to say them.
					this.host.toast("Handwriting: cursor");
					this.openInkSlider = null;
				} else if (nib && spec.isActive?.(this.host) && ptr === "mouse") {
					// Cold or warm: clicking the ACTIVE tool with a mouse is
					// meaningless for a pen (it is already selected), so it can
					// only mean "give the mouse this tool". Clicking again hands
					// the mouse back - the branch above. The toggle's own toast
					// names the tool picked up.
					//
					// This pair is Alan's rule for every mouse-without-a-pen
					// branch here, not just this one - the eraser's
					// ptr !== "mouse" guard below reads the same way. His
					// words, in order (alan, 2026-09-02): "yes tapping a tool
					// should turn it off", then "yes for mouse users without
					// a pen" - the second sentence scopes the first. Tapping
					// an active tool turns it off for a mouse without a pen;
					// pen and touch keep what they have. A mouse has nothing
					// to put the tool DOWN to; a pen does - putting a tool
					// down means picking the nib back up, and the nib buttons
					// already do that, which is why re-tapping a nib was
					// never allowed to deselect it (alan, 2026-08-31: "the
					// nib buttons pick, they never put down"). Lasso,
					// insert-space and pan need no branch of their own: for a
					// mouse their command is still a plain toggle
					// (toggleTipMode in TipMode.ts), so tapping the active
					// one already lands on off.
					//
					// Quiet, and session-only, for the reason its mirror above
					// is. `armMouseInkQuietlyEverywhere` is the arm half of the
					// same fan-out, so the second open pane's nib lights with
					// this one exactly as it did through the command.
					this.host.armMouseInkQuietly();
					// AND THE PICK, because this is the one button press that
					// gives the mouse a tool without an exec: the nib is
					// already the NOMINAL active tool (that is what put the
					// press in this branch), so no command runs and neither
					// `setInlineTool` nor `setTipMode` - the two places a pick
					// is normally recorded - is reached. Without this line the
					// strip's Pen button would arm the mouse while the tool
					// stayed unpicked, which is the same disagreement between
					// the light and the draw that the whole rule exists to
					// forbid. Harmless on a device that has seen a pen:
					// nothing there reads the flag.
					markToolPicked();
					// `isActive` for a nib is `tipInks(h) && activeTool() ===
					// nib`, so no tip mode is on and the loud command's own
					// `tip` expression can only have come out as this nib -
					// the same words it would have shown.
					this.host.toast(`Handwriting: ${nib}`);
					this.openInkSlider = nib;
					this.sliderFromHover = false;
				} else if (nib && spec.isActive?.(this.host) && ptr === "touch") {
					// Touch has no hover, so the tap is the toggle.
					// This lit branch executes no command, so explicitly reach the
					// same eligibility-scoped preparation as a real nib pick.
					this.host.prepareFingerInk?.();
					this.openInkSlider = this.openInkSlider === nib ? null : nib;
					this.sliderFromHover = false;
				} else if (nib && spec.isActive?.(this.host)) {
					this.sliderFromHover = false;
					// A pen hovers BEFORE it taps, so hover has already opened
					// the slider; a toggle here would flash it shut under the
					// nib. The tap just makes sure it is open. Re-tapping the
					// tool you already hold RESELECTS it - a deselect-to-pen
					// was tried and unwanted (alan, 2026-08-31): the nib
					// buttons pick, they never put down.
					this.openInkSlider = nib;
				} else if (
					spec.commandId === "handwriting:inline-tool-eraser" &&
					spec.isActive?.(this.host) &&
					ptr !== "mouse" &&
					!this.eraserPopOpen()
				) {
					// Mirrors the nib branches above: pressing the tool you
					// already hold reopens its pop instead of picking it again.
					// The eraser command is a plain toggle in main.ts
					// (on = !getInlineEraserMode()), so without this branch it
					// fell to the generic exec() below on every press and the
					// only way back to the pop once AH's pen-contact close had
					// hidden it was two taps through the OFF->ON edge
					// eraserPopClosed clears on, below (alan, 2026-09-02,
					// design doc 5p). A mouse keeps switching the tool off
					// instead ("mouse sould disable", alan, ~19:52): a mouse
					// only draws because its owner has no pen, so for them the
					// eraser button IS the mode, exactly the reasoning the
					// nibs' ptr === "mouse" branches give above - it falls
					// through to exec() untouched.
					//
					// The `!eraserPopOpen()` half is what keeps pen and touch
					// able to put the eraser DOWN. As first written this
					// branch took EVERY non-mouse press on the active eraser,
					// and since the pop is showing whenever the eraser was
					// just picked up, the ordinary re-tap - the one that had
					// switched the tool off since before the strip existed -
					// only toggled the pop shut and back. Shipped in 1.4.6.
					// The tool was still escapable by picking a nib, which is
					// what the Pen button is for, but the eraser's OWN button
					// no longer answered a press the way it looked like it
					// would. Reading the pop's own state splits
					// the two intents the one press carries: pop hidden means
					// pen contact took it away and the press is asking for it
					// back, which is the case the branch was added for; pop
					// showing means the user is looking at the thing this
					// branch would reopen, so the press can only mean the
					// other thing, and it falls through to exec() the way a
					// mouse click does. Each intent costs one tap and neither
					// is reachable only through the other.
					this.eraserPopClosed = false;
					// A tap is a decision, same as the nib branches' own
					// `sliderFromHover = false`: whatever hover was previewing
					// is settled now, so the leave timer must not later undo it.
					this.eraserPopFromHover = false;
				} else {
					// Selecting a nib leaves its slider OUT: the pointer is
					// already sitting on the button it just clicked, so no
					// pointerenter will ever fire to open it - the slider
					// needed a leave-and-return to appear (glass, 2026-08-31).
					this.openInkSlider = nib;
					this.sliderFromHover = false;
					// A mouse picking a tool it cannot use means "give the
					// mouse this tool" - nib, eraser, lasso, space or pan
					// alike. Without arming, the mode switched but the mouse
					// still could not use it: a dead-looking button (glass,
					// 2026-08-31). Only on the way IN - clicking an active
					// mode toggles it off, and turning a thing off must not
					// claim the mouse. The exec's own toast names what was
					// picked; the arming is silent beside it.
					const wasActive = spec.isActive?.(this.host) ?? false;
					// Computed BEFORE exec, and now that matters in two ways
					// rather than one. It always had to be: exec is what
					// actually flips the mode, and `markMousePutDown` below
					// has to be in place before it runs so the command's own
					// Notice can see it while it is building.
					//
					// It ALSO has to be, since `mouseDrawsHere` replaced
					// `mouseInkOn()` here. None of these four commands touches
					// mouse ink - that half still cannot change underneath us -
					// but every one of them re-picks a tool on its way through
					// `setTipMode` (TipMode.ts), including the OFF direction
					// that hands the tip back to the nib. Read after exec, the
					// derived half would therefore always say "drawing" and a
					// put-down could never be told from a pick. Read here, it
					// is the state the CLICK met, which is the question.
					const puttingDown = claimsTip && wasActive && ptr === "mouse" && mouseDrawsHere(this.host);
					if (puttingDown) {
						// Tell the command its own toast is about to be wrong.
						// The exec's toast names the nib the tip fell back to,
						// which is correct for a pen or touch tap actually
						// picking that nib and false here - a mouse put-down
						// picked nothing, it got its cursor back (alan,
						// hardware finding 2026-09-03: "it says highlighter
						// after doing it"). `consumeMousePutDown` reads this
						// while composing that Notice and substitutes the
						// words the loud mouse-ink-toggle command already
						// uses for "off" - matching, not inventing. See
						// MouseInk.ts for why the command cannot infer this
						// itself from `mouseInkEnabled()` alone.
						markMousePutDown();
					}
					this.host.exec(spec.commandId);
					// THE KEYBOARD, INSIDE THE GESTURE. The exec above has
					// already flipped the state, so `penInkEnabled()` now
					// reads the NEW answer: off means the user asked to type,
					// and focusing the editor here - in a click handler, which
					// is a user gesture - is the only thing that raises the
					// soft keyboard on iOS and Android. The command cannot do
					// it: reached from a hotkey or the palette it has no
					// gesture behind it and both platforms ignore the focus.
					// On means the pen is writing again, so the keyboard is
					// dismissed and the glass goes back to the ink.
					//
					// This is the one place the strip does something its
					// command does not, and the file's header says it invents
					// nothing - so the exception is stated rather than
					// smuggled: the STATE is still the command's, and only the
					// focus, which is not state at all, is the button's.
					// `noFocus`'s pointerdown preventDefault (above) is what
					// keeps every OTHER button off the editor, and this call
					// deliberately steps past it for this one.
					if (spec.commandId === PEN_INK_TOGGLE) {
						this.host.setEditorFocus(!penInkEnabled());
					}
					if (claimsTip && !wasActive && ptr === "mouse" && !this.host.mouseInkOn()) {
						// Quietly: the exec above already toasted the tool.
						// One click, one toast (alan, 2026-08-31).
						this.host.armMouseInkQuietly();
					} else if (puttingDown) {
						// PUTTING IT DOWN, the mirror of the arm above (alan,
						// 2026-09-03). The two nibs already did this - their own
						// branches near the top - but through the loud toggle
						// command, which toasted right and wrote data.json with
						// it; they take this same quiet edge since 1.4.10 and
						// say the command's words themselves. These four tools
						// went through the generic exec above instead, whose
						// toast is written for a different caller of the same
						// off edge (see `markMousePutDown` above for the fix).
						// The eraser, lasso, insert-space and pan only toggled
						// back to the last nib, and for a MOUSE that is not
						// putting anything down: the pointer is still claimed
						// and still cannot select text, so the only way back to
						// the cursor was to click a button you were not using.
						// His words: "much more consistent for them all to be
						// dropped and revert back to mouse cursor".
						//
						// The `exec` above has already toggled the tool off, so
						// this only has to release the pointer. Quiet, and for
						// a different reason than the arm now: the toast this
						// time is `markMousePutDown`'s, consumed inside the
						// exec above, not a second Notice stacked on top of it.
						//
						// MOUSE ONLY, and the guard is what keeps it that way.
						// A pen's resting state is the nib, so returning there
						// IS its put-down and nothing about pen or touch should
						// move; he asked for the two to stay as they are while
						// he thinks the flow through. The nibs never reach here
						// with a mouse - their branches catch that case first -
						// so this is exactly the four tools.
						this.host.disarmMouseInkQuietly();
					}
				}
				// PICKING A TOOL CLOSES THE SECOND ROW (item 4). Every button
				// this handler runs for is a pick or an action, and the folded
				// row is a menu: a menu that stayed open over the thing it was
				// used to reach would be covering the page the tool is for.
				// Placed here rather than in each branch so a button added
				// later cannot forget it, and after the branches so a branch
				// that reads the row's state still sees what the press met.
				this.setMoreOpen(false);
				this.refresh();
			});
			this.attachTip(b);
			this.buttons.push({ el: b, spec });
			this.built.add(spec.commandId);
		}
		// THE "MORE" BUTTON AND THE SECOND ROW (item 4).
		//
		// Built after every tool button, so the chevron sits at the END of the
		// row where the brief puts it, and so nothing that indexes the strip's
		// children by button position is disturbed by it.
		//
		// Always built, never conditional: `layoutOverflow` runs from a
		// ResizeObserver and has to have somewhere to put a button at the
		// moment it decides to. It shows only when the row does not fit, which
		// is `is-more-needed` below, and a strip that always fits carries two
		// empty elements and no chevron.
		this.moreBtn = this.el.createEl("button", {
			cls: "handwriting-mobile-tool handwriting-tools-more",
			attr: { "aria-label": "More tools", type: "button" },
		});
		setIcon(this.moreBtn, "chevron-down");
		if (!this.moreBtn.querySelector("svg")) this.moreBtn.setText("v");
		noFocus(this.moreBtn);
		this.attachTip(this.moreBtn);
		this.moreBtn.addEventListener("click", (ev) => {
			ev.preventDefault();
			this.setMoreOpen(!this.moreOpen);
		});
		this.moreRow = this.el.createDiv({ cls: "handwriting-mobile-tools-more" });
		// THE RECORDING DOT SITS AT THE ROW'S FAR END, not beside the grip
		// (alan, 2026-09-06: "it already has a pulse, probably move it to
		// trailing or far edge"). It is BUILT up with the grip because the
		// shared tooltip has to be wired before the buttons are made, and
		// MOVED here, once every element that precedes it exists. Nothing
		// else changes: `layoutOverflow` prices it by `offsetWidth` and not
		// by position, and it is still absent from `rowOrder`, so it cannot
		// fold and it still costs the budget the same width when visible.
		// BEFORE the More chevron, not after it: the chevron is the row's own
		// affordance and a test pins it as the last labelled control, so the
		// dot takes the last place a TOOL can hold rather than the last place
		// in the row.
		this.el.insertBefore(this.recordingDot, this.moreBtn);
		// Drop-down sliders. No noFocus here: a range input needs its native
		// pointerdown to start a drag on webkit. Focus loss is tolerable for
		// a slider; a slider that will not slide is not.
		// Each slider rides in a pop with a live value readout: on glass
		// without hover there is otherwise NO feedback while dragging.
		const dropSlider = (
			aria: string,
			min: string,
			max: string,
			step: string,
			onValue: (v: number, commit: boolean) => void,
			/**
			 * Whose pop this is. A nib's pop carries that nib's SWATCH ROW
			 * under the slider (item 1); the eraser passes nothing and gets
			 * the pop it always had. The row's element is built here and
			 * FILLED in `refreshNow`, the same split the old colour pop used:
			 * a palette is tiny, and rebuilding it per refresh is what keeps
			 * the current-colour ring honest without a second listener.
			 */
			tool: "pen" | "highlighter" | null = null
		): SliderParts => {
			const pop = this.el.createDiv({ cls: "handwriting-slider-pop" });
			// FLAT, and the flatness is the whole of the redesign (1.4.12,
			// panel B). The slider used to ride a 28x104 slot ROTATED a
			// quarter turn, with a live number chip under it, and the two of
			// them made the pop half again as tall as everything else in it
			// put together. Unrotated it is one row across the pop's own
			// width: the same range, the same step, more travel than the
			// rotated slot ever had, and a pop that is dramatically shorter
			// hanging over the page. "It's supposed to be small and out of
			// the way, the UI, that's why people like it" (alan, 2026-09-05).
			//
			// A READOUT, on the owner's ruling of 2026-09-06 ("as well", asked
			// whether the number should come back with the rest) - the thumb's
			// own position is feedback, but it is not a number, and "if the
			// number is there then it is easier to set on ones liking", "it
			// will be difficult to remember one like" (a second user, the same
			// day). It goes on its OWN ROW under the track, in a box of fixed
			// width (`.handwriting-slider-num`), never inline beside the
			// track: inline it would eat the travel that widening the pop was
			// for. What makes it safe at all is that the pop's width is
			// declared in the stylesheet now, so nothing the pop holds can
			// move it - see `SliderParts` for the judder this replaces.
			//
			// NO STROKE PREVIEW, though: that was tried and refused. The ink
			// under the pop is already redrawing live as the value moves
			// (`onValue(..., false)` previews on every input event), so a
			// swatch of it inside the pop would be the same information twice,
			// in the one place there is no room for it.
			const input = pop.createEl("input", {
				cls: "handwriting-eraser-slider",
				attr: { type: "range", min, max, step, "aria-label": aria },
			});
			// As Obsidian's own range slider does: a thumb dragged sideways is not a sidebar swipe.
			input.dataset.ignoreSwipe = "true";
			// Under the track and above the hairline, so the nib's pop reads
			// slider, value, saved pens, palette, and the eraser's reads
			// chips, slider, value: the number belongs to the control it
			// describes and to nothing below it.
			const num = pop.createDiv({ cls: "handwriting-slider-num" });
			// A hairline between sections, drawn as its OWN element rather
			// than as a border-top on the row below it. The rows are built
			// once and emptied per refresh, and a nib whose palette or preset
			// row is momentarily empty would otherwise show a rule with
			// nothing under it. An element can simply not be built.
			const rule = (): HTMLElement | null =>
				tool === null ? null : pop.createDiv({ cls: "handwriting-pop-rule" });
			rule();
			// Presets ABOVE the swatches, which is the one placement relation
			// design §10 cares about (a preset is reached before the colour it
			// would otherwise be assembled from), and both below the slider,
			// which is where the slider already was.
			const presets = tool === null ? null : pop.createDiv({ cls: "handwriting-pop-presets" });
			rule();
			const colors = tool === null ? null : pop.createDiv({ cls: "handwriting-pop-colors" });
			// The parts BEFORE the listeners, so the input listener can paint
			// through the same object every other caller of `paintValue`
			// holds. There is one slider per parts object and one parts object
			// per slider; building it here rather than at the return is what
			// lets the two agree without a second reference to the element.
			// From the step, so a control that cannot be set to a hundredth
			// never claims one. `Number(step)` rather than a parse: the
			// callers pass "1", "0.1" and "1" as literals.
			const decimals = Number(step) < 1 ? 1 : 0;
			const parts: SliderParts = { pop, input, tool, colors, presets, num, decimals };
			// Which input is under a finger, for hangUnder's guard. On the
			// input rather than the pop: the eraser's pop carries mode chips
			// too, and pressing one of those is not holding the slider.
			input.addEventListener("pointerdown", () => {
				this.heldSlider = input;
			});
			input.addEventListener("input", () => {
				paintValue(parts);
				onValue(Number(input.value), false);
			});
			input.addEventListener("change", () => onValue(Number(input.value), true));
			return parts;
		};
		this.slider = dropSlider("Eraser size", "3", "64", "1", (v, c) =>
			this.host.setEraserRadiusPx(v, c)
		);
		// The eraser's pop leads with its behavior: Stroke deletes what the
		// ring touches whole, Reticle takes only what it covers. Same
		// setting as the tab, so the two always agree.
		{
			const chips = this.slider.pop.createDiv({ cls: "handwriting-mode-chips" });
			this.slider.pop.insertBefore(chips, this.slider.pop.firstChild);
			const chip = (label: string, whole: boolean): HTMLElement => {
				const el = chips.createEl("button", {
					cls: "handwriting-mode-chip",
					text: label,
					attr: { type: "button" },
				});
				el.addEventListener("pointerdown", (ev) => ev.preventDefault());
				el.addEventListener("click", (ev) => {
					ev.preventDefault();
					this.host.setEraserWholeStroke(whole);
					this.refresh();
				});
				return el;
			};
			this.strokeChip = chip("Stroke", true);
			this.reticleChip = chip("Reticle", false);
		}
		// Bounds are the OLD slider's own multiplier range (0.3-3) times the
		// pen's base width, so dragging to either end of this px slider
		// produces exactly the multiplier the old slider produced at that
		// same end - never a mult outside what clampInkSize already allows.
		// Step 0.1px, not a mechanically converted 0.05 mult (0.11px): the
		// pen's whole range is under 6px, where 0.1px is already a finer
		// grain than the eye can place, and it reads as a round number.
		this.penSlider = dropSlider(
			"Pen size",
			String(multToPx(0.3, DEFAULT_PEN.baseWidth)),
			String(multToPx(3, DEFAULT_PEN.baseWidth)),
			// A grid from this fractional min (0.66) never lands exactly on the
			// default (1x = 2.2px) or the max (3x = 6.6px) at a 0.1 step either -
			// both sat 0.04px off the nearest grid point (item 137). 0.01 divides
			// evenly into both distances from this min, so dragging to either
			// lands on it exactly.
			"0.01",
			(v, c) => this.host.setInkSizeMult("pen", pxToMult(v, DEFAULT_PEN.baseWidth), c),
			"pen"
		);
		// The highlighter runs a narrower range: its base is already wide,
		// and past 1.5x it stops being a highlighter and starts being paint.
		// Its OWN multiplier bounds (0.25-1.5), not the pen's (0.3-3) - each
		// nib's pixel range is its own base times its own existing range,
		// not one shared range. Step 1px, same grain as the eraser's own
		// integer-px slider, over a 4-24px span wide enough to want it.
		this.hlSlider = dropSlider(
			"Highlighter size",
			String(multToPx(0.25, HIGHLIGHTER_PEN.baseWidth)),
			String(multToPx(1.5, HIGHLIGHTER_PEN.baseWidth)),
			"1",
			(v, c) => this.host.setInkSizeMult("highlighter", pxToMult(v, HIGHLIGHTER_PEN.baseWidth), c),
			"highlighter"
		);
		for (const pop of [this.slider.pop, this.penSlider.pop, this.hlSlider.pop]) {
			pop.addEventListener("pointerenter", (ev: PointerEvent) => {
				if (ev.pointerType !== "touch") this.cancelSliderClose();
			});
			pop.addEventListener("pointerleave", (ev: PointerEvent) => {
				if (ev.pointerType !== "touch") this.scheduleSliderClose();
			});
			// Same rule as the button's `noFocus` pointerdown above: a contact
			// on the pop itself - dragging the slider, tapping a mode chip - is
			// a decision too. Without this, a hover-opened pop still died 300ms
			// after the pen lifted OFF THE SLIDER: this pop's own pointerleave
			// (above) re-armed the close timer, and nothing had told it the
			// preview was over. The native pointerdown the range input needs
			// for its own drag (see dropSlider's comment) bubbles here first.
			pop.addEventListener("pointerdown", (ev: PointerEvent) => {
				if (ev.pointerType !== "touch") {
					this.sliderFromHover = false;
					this.eraserPopFromHover = false;
				}
			});
		}
		// The tip mode is GLOBAL and this pair of bits is per-strip, so a
		// strip built while the eraser was already on has to be told that it
		// arrived mid-mode rather than watching a switch. Seeded here, before
		// the first refresh, because the constructor's own `refreshNow` is
		// what read the unseeded values and fired the OFF-to-ON edge: every
		// new pane, split and popout opened the eraser's size pop with no
		// user action behind it. `eraserPopClosed` needs seeding too - the
		// edge is not the only route in, since `eraserPopOpen` is true on a
		// fresh strip whose flag still says nothing has closed the pop.
		//
		// With the eraser off both values are the ones the fields already
		// declare, and the switch that turns it on later is still the real
		// edge - which is the route this must not take away.
		this.wasEraserOn = host.eraserOn();
		this.eraserPopClosed = this.wasEraserOn;
		this.refreshNow();
		// A preview is born expanded and tells the session nothing about it:
		// `setCollapsed` writes `collapsedSession`, which every real strip in
		// the window reads. See `MobileToolsOptions.preview`.
		if (!preview) this.setCollapsed(collapsedSession);
		// ON LAYOUT and on resize (item 4). The first pass runs here, after
		// the strip is in the tree and has widths to read; the observer
		// catches every later change - rotation, a split pane being dragged,
		// the sidebar opening, a popout being resized.
		//
		// Observe the two INPUTS, never the strip. The parent's width is the
		// available room; the collapse button's width is the grid cell. The
		// latter matters at startup: Obsidian can construct the plugin before
		// its stylesheet settles, while the button's screen-reader label is
		// still in flow and makes the first cell measurement about 175px. The
		// stylesheet then makes the button 40px without resizing the absolutely
		// positioned strip's parent. Watching the button repairs that stale
		// plan; watching the strip would feed this calculation's own output back
		// into itself whenever folding changed its width.
		// In the tree and measurable, so it can be re-folded from here on: the
		// fold order is a setting, and a change to it has to reach the strips
		// that are already open. Dropped again in `destroy()`.
		liveStrips.add(this);
		if (!preview) this.stopModeWatch = onPenToolsChanged(() => this.setInking(this.inking));
		this.layoutOverflow();
		// Item 5 rides the same two triggers as item 4 - a first pass now, and
		// the observer below - because they answer the same question about the
		// same pane: how much room there is and who else is using it. A pane
		// that gets narrower moves the actions row under the strip just as
		// surely as it makes the row too wide.
		if (!preview) this.applyHeaderClearance();
		const win = this.el.ownerDocument.defaultView;
		const Observer = (win as { ResizeObserver?: new (cb: () => void) => { observe(el: Element): void; disconnect(): void } } | null)
			?.ResizeObserver;
		// Guarded, not assumed: this class is constructed under a suite with
		// no DOM at all, and a strip that throws in its constructor takes the
		// pen down with it - the iPad lesson this file's every other bulkhead
		// was written for. The presence check covers the suite (no
		// `ResizeObserver` on the fake window at all); the try/catch covers a
		// real engine refusing the element, which is the case a presence
		// check cannot see.
		if (Observer) {
			try {
				const watch = new Observer(() => {
					this.layoutOverflow();
					if (!preview) this.applyHeaderClearance();
				});
				watch.observe(parent);
				watch.observe(this.collapseBtn);
				this.resizeWatch = watch;
			} catch (err) {
				console.error("[handwriting] strip overflow observer failed", err);
			}
		}
	}

	/**
	 * Fold the row, or unfold it, to match the space the pane actually has.
	 *
	 * The DECISION is `overflowPlan` (StripOverflow.ts) and is pure; this is
	 * only the measuring and the moving. Both halves are here rather than in
	 * `refreshNow` because this reads layout - it is the expensive kind of
	 * pass - and it has nothing to say on the events `refresh` coalesces:
	 * a tool change moves no button between rows.
	 */
	private layoutOverflow(): void {
		const parent = this.el.parentElement;
		if (!parent) return;
		// A COLLAPSED strip is `display: none` and measures zero on every
		// axis, so a plan computed here would read "everything fits", unfold
		// the row and clear the chevron - and the strip would come back from
		// its pill overflowing, until something else resized the pane. The
		// plan it already has is the right one to keep: it was computed for
		// this pane at this width, and collapsing changed neither.
		if (this.el.classList.contains("is-collapsed")) return;
		// The gap the stylesheet gives the row, and the padding it gives the
		// strip. Read as constants rather than from computed style: both are
		// declared once, within a few lines of the `flex-wrap: wrap` failsafe
		// this replaces, and a getComputedStyle per resize to re-learn a 2 and
		// a 4 would cost more than it could ever catch. The render suite
		// measures what the two of them actually produce, so a stylesheet that
		// moves either turns a test red instead of drifting quietly.
		const gap = 2;
		const pad = 4;
		// The same budget the stylesheet gives the strip - `max-width:
		// calc(100% - 16px)` - less the strip's own border and padding, which
		// no button can use.
		//
		// `offsetWidth - clientWidth` IS THE BORDER AND NOT THE PADDING:
		// clientWidth is the PADDING box, so the padding sits inside both
		// terms and cancels out of the difference. This line used to be that
		// subtraction alone, under a comment claiming it was "padding and
		// border", so every budget was 8px too generous - the plan called the
		// row a fit, the row overflowed by those 8px, `flex-wrap: wrap` took
		// the last button, and the next demotion put it back. Together with
		// the 24px the dividers' margins used to hide (see their rule in
		// styles.css) that is the whole of "it also still flickers when
		// narrowing the window with window slider" (alan, 2026-09-06). Dragging
		// one pane from 520px to 116px, two pixels a frame, the strip dropped
		// from two rows back to one FOUR times - at 460, 426, 392 and 358 -
		// each of them a line of toolbar appearing and vanishing under the
		// hand. Measured, and pinned by StripDragFlicker.test.ts.
		const chrome = this.el.offsetWidth - this.el.clientWidth + 2 * pad;
		const available = parent.clientWidth - 16 - chrome;
		// Nothing to measure against: a detached strip, a pane not laid out
		// yet, or the unit suite, whose elements answer 0 to every dimension.
		// Bailing leaves the row exactly as built - one row, no chevron -
		// which is the honest answer when the width is unknown, and it is
		// what every existing test in this file therefore still sees.
		if (available <= 0) return;
		// MEASURED WITH THE TWO HIDDEN BOXES SHOWN, and put back before
		// anything moves.
		//
		// `display: none` gives an element no box at all, and this method reads
		// two that are display:none most of the time: the chevron
		// (`.handwriting-tools-more`, painted only under `is-more-needed`) and
		// every button already parked on the second row
		// (`.handwriting-mobile-tools-more`, painted only under
		// `is-more-open`). Measured as they sit, the chevron costs 0 where it
		// costs 32, so a row that has just stopped fitting folds one button too
		// few; and a folded button costs 0, so the plan hands it back to the
		// first row it did not fit on. Both errors are corrected by the NEXT
		// pass, which is how they survived: the strip settles a frame later and
		// looks right. What does not settle is anything that reads the plan
		// BETWEEN the two passes - the settings preview's fold line, which is
		// drawn from `foldedIds` the moment `applyFoldOrder` returns and never
		// again. That is the whole of "i narrowed the window and it didnt
		// update the more line" (alan, 2026-09-05).
		//
		// The toggles are written and read back inside one synchronous block,
		// so the engine never paints the forced state, and this stays ONE
		// measurement per event: what it removes is the corrective second pass,
		// which was more layout, not less.
		//
		// `is-wrapped` IS FORCED OFF for the same span, and that one is a
		// bulkhead rather than an accounting fix. The wrapped strip hides its
		// dividers, and a divider that is `display: none` measures zero: read
		// as it sits, a wrapped strip prices its row 27px cheaper than an
		// unwrapped one, which is enough for the plan to call it a fit, clear
		// `is-wrapped`, bring the dividers back and overflow again on the
		// next frame - a two-state oscillation driven by nothing but the
		// pane sitting still. Measured unwrapped every time, the answer
		// depends only on the pane's width and the buttons' own sizes, which
		// is the property the observer on the PARENT was chosen for.
		const wasNeeded = this.el.classList.contains("is-more-needed");
		const wasOpen = this.el.classList.contains("is-more-open");
		const wasWrapped = this.el.classList.contains("is-wrapped");
		this.el.toggleClass("is-more-needed", true);
		this.el.toggleClass("is-more-open", true);
		this.el.toggleClass("is-wrapped", false);
		let plan: OverflowPlan;
		// The button box, which is also the grid's cell: one measurement
		// serving two answers rather than a second read of the same number.
		let cell = 0;
		// Whether the recording indicator is on the row and owns a cell.
		let dot = false;
		try {
			cell = this.collapseBtn.offsetWidth;
			let fixed = cell + gap;
			// The grip is 24px that no button can use, and it never folds - it
			// is the handle, and a handle on the second row would be a toolbar
			// you have to open before you can move it. Counted here or the row
			// plans itself 26px wider than it is and overflows by one button on
			// a phone.
			fixed += this.grip.offsetWidth + gap;
			dot = this.recordingDot.offsetWidth > 0;
			fixed += dot ? this.recordingDot.offsetWidth + gap : 0;
			for (const node of this.rowOrder) {
				// The dividers - everything in the row order that is not a
				// button this plan may move. They never fold: a divider on the
				// second row would be dividing nothing.
				//
				// `offsetWidth` EXCLUDES MARGIN, which is why the divider is a
				// 9px box with its hairline painted down the middle rather
				// than a 1px rule with 4px either side: written the second
				// way, three dividers hid 24px from this sum and the plan
				// called rows a fit that were 24px too wide. See the rule in
				// styles.css. Nothing on this row may carry a horizontal
				// margin - that is the invariant this loop rests on.
				if (!this.buttons.some((b) => b.el === node)) fixed += node.offsetWidth + gap;
			}
			const items = this.buttons.map(({ el, spec }) => ({
				id: spec.commandId,
				width: el.offsetWidth + gap,
			}));
			plan = overflowPlan({
				available,
				fixed,
				items,
				chevron: this.moreBtn.offsetWidth + gap,
				demote: foldOrder,
			});
		} finally {
			// In a `finally` because the restore is not optional: a throw
			// between here and there would leave every strip in the window
			// wearing an open second row it was never asked for.
			this.el.toggleClass("is-more-needed", wasNeeded);
			this.el.toggleClass("is-more-open", wasOpen);
			this.el.toggleClass("is-wrapped", wasWrapped);
		}
		// THE WRAP, as a state the strip wears rather than as something the
		// stylesheet does behind the layout's back.
		//
		// `plan.fits` is false only when every demotable button has already
		// gone and the row is STILL wider than the pane. That is the one case
		// the flex wrap used to take, greedily, leaving the dividers standing
		// at the end of lines they divided nothing on. Under `is-wrapped` the
		// strip is a grid instead: dividers off, one cell per control, and
		// the columns below.
		//
		// EVERY NUMBER HERE IS ALREADY IN HAND - `available` off the pane,
		// `cell` off the collapse button, the counts off the plan. Nothing
		// new is measured, and nothing here reads layout.
		const perLine = Math.max(1, Math.floor((available + gap) / (cell + gap)));
		// Grip, collapse, the indicator when it is up, whatever the plan left
		// on the row, and the chevron when there is one. The dividers are not
		// counted: they are not painted in this state.
		const cells =
			2 + (dot ? 1 : 0) + (this.buttons.length - plan.moved.length) + (plan.chevron ? 1 : 0);
		const wrapped = !plan.fits;
		const grid = wrapped ? `${gridColumns(cells, perLine)}:${cell}` : "";
		if (grid !== this.appliedGrid) {
			this.appliedGrid = grid;
			if (wrapped) {
				const [cols, px] = grid.split(":");
				this.el.style.setProperty("--hw-strip-cols", cols ?? "2");
				this.el.style.setProperty("--hw-strip-cell", `${px ?? 32}px`);
			}
		}
		// Outside the `grid` guard: the class can change while the columns do
		// not - a strip that stops wrapping keeps whatever grid it last wrote,
		// unread, until it wraps again.
		this.el.toggleClass("is-wrapped", wrapped);
		// Applied only when it CHANGED. This runs on every resize frame while
		// a pane is being dragged, and re-parenting eleven buttons per frame
		// to land them where they already are is the kind of chrome cost that
		// shows up as stroke lag on the e-ink devices this plugin is used on.
		const key = plan.chevron ? plan.moved.join(",") : "";
		const priority = [...foldOrder].reverse();
		const orderKey = priority.join(",");
		if (key === this.appliedPlan && orderKey === this.appliedOrder) return;
		this.appliedPlan = key;
		this.appliedOrder = orderKey;
		this.el.toggleClass("is-more-needed", plan.chevron);
		if (!plan.chevron) this.setMoreOpen(false);
		const moved = new Set(plan.moved);
		// Keep fixed controls/dividers in their slots; saved priority fills
		// only the draggable slots, including when every button fits.
		const ordered = priority.flatMap(id => {
			const button = this.buttons.find(b => b.spec.commandId === id);
			return button ? [button.el] : [];
		});
		const draggable = new Set(ordered);
		let slot = 0;
		for (const original of this.rowOrder) {
			const node = draggable.has(original) ? ordered[slot++]! : original;
			const spec = this.buttons.find((b) => b.el === node)?.spec;
			if (spec && moved.has(spec.commandId)) continue;
			this.el.insertBefore(node, this.moreBtn);
		}
		// Then row two, in the order the plan says it reads.
		for (const id of plan.moved) {
			const btn = this.buttons.find((b) => b.spec.commandId === id)?.el;
			if (btn) this.moreRow.appendChild(btn);
		}
		// The dot is not in the row order, so the loop above left every tool after it. It belongs at the row's
		// far end, before the chevron.
		this.el.insertBefore(this.recordingDot, this.moreBtn);
	}

	/**
	 * Show or hide the folded row. The chevron flips with it - down means
	 * "there is more below", up means "put it away" - which is the only thing
	 * on the strip that tells a user the row is openable at all.
	 */
	private setMoreOpen(on: boolean): void {
		if (this.moreOpen === on) return;
		this.moreOpen = on;
		this.el.toggleClass("is-more-open", on);
		// Emptied FIRST: setIcon APPENDS, it does not replace - the same trap
		// the pill and the collapse chevron are both written around, and the
		// same fix. The tooltip's sr-only name goes back in after the sweep.
		this.moreBtn.empty();
		setIcon(this.moreBtn, on ? "chevron-up" : "chevron-down");
		if (!this.moreBtn.querySelector("svg")) this.moreBtn.setText(on ? "^" : "v");
		const label = this.moreBtn.dataset.tipLabel;
		if (label) this.moreBtn.createSpan({ cls: "handwriting-sr-only", text: label });
	}

	private refreshQueued = false;

	/**
	 * Coalesced, off-the-input-handler refresh: pen-up and pen-down call
	 * this from latency-critical handlers, and the body does forced layout
	 * reads (hangUnder measures offsets). One rAF defers the work past the
	 * stroke's frame and collapses bursts into a single pass.
	 */
	refresh(): void {
		if (this.refreshQueued) return;
		this.refreshQueued = true;
		// The strip's own window, so a popout editor ticks on its own frames.
		(this.el.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
			this.refreshQueued = false;
			this.refreshNow();
		});
	}

	/** The synchronous body; the constructor uses it before first paint. */
	refreshNow(): void {
		this.viewportControls?.refresh();

		const recording = this.host.recordingOn();
		this.recordingDot.toggleClass("is-recording", recording);
		// The dot takes a cell of the row's budget while it shows, and it shows only under this class, so the
		// fold has to be planned again when the class flips: a strip that fit without it may not fit with it.
		if (recording !== this.recordingShown) {
			this.recordingShown = recording;
			this.layoutOverflow();
		}
		for (const { el, spec } of this.buttons) {
			// The lights follow the TOOL state and nothing else. They used to
			// dim for a text-mode mouse, keyed off the last pointer type seen
			// - but hover events on a Surface arrive mouse-flavoured even
			// from a pen, so the eraser's light died under a hovering pen and
			// came back when the nib touched the editor (glass, 2026-08-31).
			// The mouse is just a pen here; pointer type is not state. isLit
			// (falling back to isActive) rather than isActive alone: a mouse
			// user who just clicked the lit pen button to hand the mouse back
			// to text must see the light go out too (alan, 2026-09-02) - see
			// isLit's doc comment on ButtonSpec for why this is a separate
			// field from the one the click chain below still branches on.
			el.classList.toggle("is-active", (spec.isLit ?? spec.isActive)?.(this.host) ?? false);
			const enabled = spec.isEnabled?.(this.host) ?? true;
			el.classList.toggle("is-disabled", !enabled);
			// The dimming is for eyes only; this is the same fact for anything
			// that cannot see it. aria-disabled rather than the disabled
			// property on purpose: a disabled button is skipped by the
			// keyboard and stops firing hover, and the tooltip explaining WHY
			// it is unavailable is the part worth keeping.
			el.setAttribute("aria-disabled", enabled ? "false" : "true");
			// A TINTED button answers "which colour" by BEING it. This was the
			// palette button's trick and it is the two nibs' now - they wear
			// their own ink at all times, so a glance at the strip says what
			// the pen will draw with (alan, 2026-09-05).
			//
			// Off `spec.inkTool` rather than a `commandId ===` branch: there
			// are two of these, and the branch this replaced had been written
			// for exactly one button.
			if (spec.inkTool !== undefined) {
				const hex = this.host.toolColor(spec.inkTool);
				// Blended toward the theme's own readable text colour rather
				// than painted with the raw hex: a pen this close to the
				// background (black in dark mode, white in light mode) used to
				// nearly disappear while unlit (item 140). The blend still
				// reads as "that colour" - it is mostly the pen's own hue - it
				// just never goes all the way to invisible against the page.
				el.setCssStyles({ color: `color-mix(in srgb, ${hex} 70%, var(--text-normal))` });
				// The tooltip names the colour beside the tool - the tinted
				// icon says WHICH colour and cannot say its name, and "Pen"
				// alone told a hover nothing about the ink it is holding
				// (the palette button's own rule, alan, 2026-08-31, moved
				// here with the tint). The label is read at hover time, so
				// keeping the dataset current is all it takes; the sr-only
				// span is the same name for screen readers, which get the
				// colour they cannot see.
				const colour = this.host
					.paletteFor(spec.inkTool)
					.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name;
				const label = colour ? `${spec.label}: ${colour}` : spec.label;
				if (el.dataset.tipLabel !== label) {
					el.dataset.tipLabel = label;
					const sr = el.querySelector(".handwriting-sr-only");
					if (sr) sr.textContent = label;
				}
			}
		}
		// The collapsed pill wears the tool in hand.
		//
		// It used to be a pen, set once when the strip was built and never
		// touched again, labelled "Pen tools" forever. The pill is what is on
		// screen WHILE YOU WRITE - the strip is collapsed precisely then - so
		// the one moment the active tool matters most was the one moment
		// nothing said what it was, while the open strip goes to real trouble
		// to show it (the palette button is tinted with the live color and
		// names it on hover).
		//
		// Taken from the button that reports itself active rather than from a
		// second switch on the modes: one source of truth, and a tool added to
		// BUTTONS later is carried here without anyone remembering to.
		{
			// Same isLit-falls-back-to-isActive read as the per-button light
			// above (literally the same expression there, so it moves here
			// too): the pill must not keep wearing "Pen" once a mouse click
			// has handed the mouse back to text and no nib is actually
			// inking - it falls through to the generic "Pen tools" default
			// below, same as when eraser/lasso/space/pan all read false.
			//
			// PEN OFF WINS IT OUTRIGHT, and it is the one state that gets to.
			// The scan below finds the first LIT button, and the two nibs come
			// first. This branch used to be the ONLY thing keeping a pen icon
			// off the pill in keyboard mode, because `nibIsLit` kept reading
			// true while the pen was off; since 2026-09-06 it does not (see
			// `penDrawsHere`), so for a pen user the scan now finds no nib lit
			// here either and the two agree instead of one covering for the
			// other. The branch stays, and still wins outright, because
			// agreeing on DARK is not the same as saying WHY: the pill is what
			// is on screen while the strip is folded, which is exactly when
			// someone wonders why their pen stopped drawing, and it must name
			// the state rather than fall through to the generic "Pen tools"
			// default. It also still carries the one case where the two are
			// MEANT to differ: a pen user who has ALSO armed mouse ink by
			// name, whose nib stays honestly lit in keyboard mode because
			// their mouse really does still draw there - the pill says "Pen
			// off" over the top of it, which is the truth about the PEN that
			// a folded strip is being asked for. Design §5 asks for
			// the keyboard icon for the same reason. The label says the state
			// rather than naming a tool - "Keyboard tools" would read as one
			// more tool - so a hover or a screen reader gets the answer in two
			// words.
			//
			// Through the host, same reason as the button's own isActive: a
			// surface that keeps inking while the flag is off must not borrow
			// the "Pen off" wording, and the host is the only thing that can
			// say so. Both real surfaces honour the flag today, so both wear
			// the pill.
			const penOffBtn = this.host.penInksHere()
				? undefined
				: this.buttons.find(({ spec }) => spec.commandId === PEN_INK_TOGGLE);
			const active =
				penOffBtn ?? this.buttons.find(({ spec }) => (spec.isLit ?? spec.isActive)?.(this.host));
			const icon = active?.spec.icon ?? "pen";
			const label = penOffBtn ? "Pen off" : active ? `${active.spec.label} tools` : "Pen tools";
			if (this.pill.dataset.icon !== icon) {
				this.pill.dataset.icon = icon;
				// Emptied FIRST: setIcon APPENDS an svg, it does not replace
				// the button's children, so the pill wore every tool it had
				// ever been at once - a pen and a highlighter overlapping in
				// the one circle (alan and samuelbits, with screenshots;
				// there since the pill started following the tool in hand).
				// This comment used to assert the opposite, which is what
				// stopped anyone checking. Same sweep, for the same reason,
				// as the chevron gets in setCorner. It takes the sr-only
				// name attachTip left there with it, so that goes back in
				// the same move, or the pill goes quiet for a screen reader
				// the first time the tool changes.
				this.pill.empty();
				setIcon(this.pill, icon);
				if (!this.pill.querySelector("svg")) this.pill.setText(active?.spec.glyph ?? "P");
				this.pill.createSpan({ cls: "handwriting-sr-only", text: label });
			}
			// The tooltip reads this, not aria-label: ownName moves the name
			// off the attribute so the tip and the screen reader do not say it
			// twice.
			if (this.pill.dataset.tipLabel !== label) {
				this.pill.dataset.tipLabel = label;
				const sr = this.pill.querySelector(".handwriting-sr-only");
				if (sr) sr.textContent = label;
			}
		}
		// Hang a drop-down under its button, measured live so it survives
		// the strip wrapping on narrow screens.
		const hangUnder = (
			slider: SliderParts,
			commandId: string,
			show: boolean,
			value: number
		) => {
			slider.pop.toggleClass("is-showing", show);
			if (!show) return;
			// Never into a control the user is holding. The placement below
			// still has to run - the strip can wrap under an open pop - but
			// the VALUE belongs to the finger until it lifts. Any refresh
			// landing mid-drag would otherwise write over the drag: a hover
			// preview on the next button along, the 300ms close timer, or any
			// command that refreshes every strip.
			if (this.heldSlider !== slider.input) slider.input.value = String(value);
			// UNCONDITIONAL, outside the guard above, because it reads the
			// input's OWN value: held or not, the readout says what the
			// control holds, which is the dragged value mid-drag and the
			// written one after. A refresh that did not touch the input
			// writes nothing at all - `paintValue` compares before it sets.
			paintValue(slider);
			// The colours, for a nib's pop: rebuilt while it is SHOWING, which
			// is the same budget the old colour pop worked to (a palette is
			// eight buttons) and the same reason - a rebuild is what keeps the
			// current-colour ring honest with no second listener watching the
			// setting. Nothing is built for a pop that is shut, so the eraser's
			// pop and the nib pop that is not up cost nothing.
			this.paintPresets(slider);
			this.paintSwatches(slider);
			const btn = this.buttons.find((b) => b.spec.commandId === commandId)?.el;
			if (btn) {
				// Measured rects, and CENTERED under the button: the offset
				// arithmetic drifted a full button's width in the bottom-left
				// corner (glass, 2026-08-31). The pop is visible by here, so
				// its width is real.
				// The arithmetic is `popRightOffset` (PopPlacement.ts) so the nine
				// anchors can be pinned without a layout; this is the measuring.
				// The PANE is measured too now: the old `Math.max(0, right)`
				// clamped the pop to the strip's own right edge, which is nearly
				// the pane's edge in a right-hand corner and nowhere near it for
				// a centred strip - so a centre-column anchor could hang a wide pop off
				// the side of the pane.
				const right = popRightOffset({
					strip: this.el.getBoundingClientRect(),
					button: btn.getBoundingClientRect(),
					popWidth: slider.pop.offsetWidth,
					pane: this.pane.getBoundingClientRect(),
				});
				slider.pop.setCssStyles({ right: `${right}px` });
			}
		};
		const whole = this.host.eraserWholeStroke();
		this.strokeChip.toggleClass("is-current", whole);
		this.reticleChip.toggleClass("is-current", !whole);
		// The strip button's own click handler now resets `eraserPopClosed`
		// too (a re-tap while active toggles it, mirroring the nib
		// branches), but that only covers the strip: the palette command and
		// a hotkey both call `handwriting:inline-tool-eraser` directly
		// (main.ts's `on = !getInlineEraserMode()`, the "inline-tool-eraser"
		// command) without passing through this file at all. The OFF-to-ON
		// edge watched here is what catches those two paths alike; the strip
		// button's own click just gets there first.
		const eraserOn = this.host.eraserOn();
		if (eraserOn && !this.wasEraserOn) {
			this.eraserPopClosed = false;
			// A fresh activation opened this, not a hover in flight - a stale
			// `true` here would let a leave timer from a previous session
			// wrongly close the pop this edge just opened.
			this.eraserPopFromHover = false;
		}
		this.wasEraserOn = eraserOn;
		hangUnder(
			this.slider,
			"handwriting:inline-tool-eraser",
			// The eraser slider rides the MODE, not a toggle. `eraserPopOpen`
			// folds in `eraserOn()` plus the one bit `closeInkSliders` sets to
			// suppress the pop without touching the mode (hasOpenPop, above;
			// every caller of closeInkSliders - pen contact, an outside tap,
			// Escape - sets it alike). Its `!colorsOpen` conjunct went with
			// the colour pop: there is no longer a separate pop that could
			// open next to this one and have to be stepped aside for.
			this.eraserPopOpen(),
			this.host.eraserRadiusPx()
		);
		const nib = this.host.eraserOn() ? null : this.openInkSlider;
		hangUnder(
			this.penSlider,
			"handwriting:inline-tool-pen",
			nib === "pen" && this.host.activeTool() === "pen",
			multToPx(this.host.inkSizeMult("pen"), DEFAULT_PEN.baseWidth)
		);
		hangUnder(
			this.hlSlider,
			"handwriting:inline-tool-highlighter",
			nib === "highlighter" && this.host.activeTool() === "highlighter",
			multToPx(this.host.inkSizeMult("highlighter"), HIGHLIGHTER_PEN.baseWidth)
		);
	}

	/**
	 * The quick-pen row at the top of one nib's pop: up to four chips in
	 * their own colours, sized by their own widths, then the star that saves
	 * the pair in hand (design §4, §10).
	 *
	 * Rebuilt per refresh while the pop shows, the same budget and the same
	 * reason as the swatches under it: the ring that says "this is the pen
	 * you are holding" has to follow a colour or size changed by any route -
	 * a swatch, the slider, a hotkey - and a rebuild is what keeps it honest
	 * without a listener per pop.
	 *
	 * The whole row goes through the ACTION HOOK (`applyPreset` and friends
	 * on the host), never through the preset commands: those register only
	 * behind "Extra commands for hotkeys", and a row of chips that did
	 * nothing on a fresh install is exactly the dead palette this file's
	 * `pickColor` comment was written after.
	 */
	private paintPresets(slider: SliderParts): void {
		const row = slider.presets;
		const tool = slider.tool;
		if (!row || tool === null) return;
		// BEFORE `empty()`, and this order is the fix rather than a tidiness:
		// the chips about to be destroyed own the pointer listeners that would
		// cancel their own hold, so a timer left armed here fires after its
		// button is gone and calls `forgetPreset` with an index that now names
		// a different pen.
		this.cancelPresetHold();
		row.empty();
		const presets = this.host.presetsFor(tool);
		const chips = presetChips(presets, this.host.toolColor(tool), this.host.inkSizeMult(tool));
		for (const chip of chips) {
			const btn = row.createEl("button", {
				cls: "handwriting-preset-chip",
				attr: { "aria-label": chip.label, type: "button" },
			});
			btn.toggleClass("is-current", chip.current);
			// The dot lives INSIDE the button: the button is a constant
			// 22px hit target whatever the preset's width, so a fine pen's
			// chip is no harder to hit than a bold one's. A dot drawn by
			// resizing the button itself would have made the finest preset
			// the smallest target on the strip.
			const dot = btn.createDiv({ cls: "handwriting-preset-dot" });
			dot.setCssStyles({
				backgroundColor: chip.hex,
				width: `${chip.dotPx}px`,
				height: `${chip.dotPx}px`,
			});
			// One hold timer per chip, the recording dot's shape: press and
			// hold 600ms to forget. `held` is what stops the pointerup's
			// click from then APPLYING the preset the hold just removed.
			let held = false;
			const cancelHold = (): void => this.cancelPresetHold();
			btn.addEventListener("pointerdown", (ev) => {
				// The same guard every control in this pop uses: a contact
				// here is a decision about the strip, and must not reach the
				// ink surface underneath as the start of a stroke.
				ev.preventDefault();
				held = false;
				this.suppressNextPresetContextMenu = false;
				cancelHold();
				this.presetHoldTimer = window.setTimeout(() => {
					this.presetHoldTimer = null;
					held = true;
					this.host.forgetPreset(tool, chip.index);
					// The release's contextmenu, still to come, must not land
					// on whatever fresh button the rebuild below puts under
					// the finger (item 73).
					this.suppressNextPresetContextMenu = true;
					// In place: the pop stays open and the row redraws
					// without it, so a second unwanted preset is one more
					// hold away rather than a re-open.
					this.refresh();
				}, 600);
			});
			btn.addEventListener("pointerup", cancelHold);
			btn.addEventListener("pointerleave", cancelHold);
			btn.addEventListener("pointercancel", cancelHold);
			btn.addEventListener("contextmenu", (ev) => {
				// The mouse's half of the same gesture. preventDefault so the
				// app's own context menu does not open over the pop.
				ev.preventDefault();
				cancelHold();
				// STRIP-LEVEL GUARD FIRST (item 73): a hold that already fired
				// rebuilds the row before the release, so this contextmenu may
				// be landing on a BRAND NEW button - the former neighbour's,
				// shifted into this screen slot - whose own `held` closure
				// knows nothing about the hold that just ran. The flag lives
				// on the strip, not the chip, so it survives the rebuild.
				if (this.suppressNextPresetContextMenu) {
					this.suppressNextPresetContextMenu = false;
					return;
				}
				// ONE GUARD PER CHIP, not two independent triggers: on Windows
				// pen and touch a long press fires BOTH the 600ms hold timer
				// above AND this contextmenu handler once the finger lifts, and
				// both used to call forgetPreset unconditionally - one long
				// press could delete two presets (auditor, 2026-09-05). `held`
				// is already true here if the timer got there first, so this
				// branch is the one that stands down; a contextmenu that
				// arrives FIRST (a plain mouse right-click, no hold in
				// progress) still forgets, exactly as before. The mark clears
				// on the chip's next pointerdown, above.
				if (held) return;
				held = true;
				this.host.forgetPreset(tool, chip.index);
				this.refresh();
			});
			btn.addEventListener("click", (ev) => {
				ev.preventDefault();
				if (held) {
					held = false;
					return;
				}
				this.host.applyPreset(tool, chip.index);
				// The pop CLOSES here, where a swatch leaves it open: a
				// swatch is half a choice and the slider beside it is the
				// other half, but a preset is the whole pen. Design §4:
				// "pen colour and size become the preset's, pop closes".
				this.closeInkSliders();
			});
		}
		const star = row.createEl("button", {
			cls: "handwriting-preset-star",
			attr: {
				"aria-label": starReplaces(presets)
					? "Star this pen, replacing the last preset"
					: "Star this pen",
				type: "button",
			},
		});
		// Never disabled, not even with four saved: a fifth star is a
		// legitimate thing to want, and `addPreset` has a rule for it
		// (replace the last). The label is what says so.
		// The icon set's star, with a glyph fallback the same way the collapse
		// chevron falls back to ">": an icon pack that lacks a name must not
		// leave a nameless empty button in the row.
		setIcon(star, "star");
		if (!star.querySelector("svg")) star.setText("*");
		star.addEventListener("pointerdown", (ev) => ev.preventDefault());
		star.addEventListener("click", (ev) => {
			ev.preventDefault();
			this.host.starPreset(tool);
			// Stays open, unlike a chip tap: the new chip appearing in the
			// row is the confirmation that the star worked.
			this.refresh();
		});
	}

	/**
	 * The swatch row inside one nib's pop: that nib's own palette, the
	 * current colour ringed, each swatch applying its colour and closing
	 * nothing else.
	 *
	 * Rebuilt on every refresh the pop is showing for, exactly as the old
	 * standalone colour pop was: a palette is eight buttons, and rebuilding
	 * is what keeps the `is-current` ring true without a listener watching
	 * the setting from the outside.
	 *
	 * `pickColor` is not parameterised by tool and does not need to be. It
	 * applies to `getInlineTool()` on both surfaces, and `hangUnder` only
	 * ever shows a nib's pop while `activeTool()` IS that nib - so the tool
	 * whose swatch was tapped and the tool the host applies to are the same
	 * one by construction. See `MobileToolsHost.pickColor`.
	 */
	private paintSwatches(slider: SliderParts): void {
		const row = slider.colors;
		const tool = slider.tool;
		if (!row || tool === null) return;
		row.empty();
		const current = this.host.toolColor(tool);
		for (const c of this.host.paletteFor(tool)) {
			const sw = row.createEl("button", {
				cls: "handwriting-color-swatch",
				attr: { "aria-label": c.name, type: "button" },
			});
			sw.setCssStyles({ backgroundColor: c.hex });
			sw.toggleClass("is-current", c.hex.toLowerCase() === current.toLowerCase());
			sw.addEventListener("pointerdown", (ev) => ev.preventDefault());
			sw.addEventListener("click", (ev) => {
				ev.preventDefault();
				// Not through the per-name commands: those live behind an
				// off-by-default setting, and a palette that only works when
				// a hidden toggle is on is a dead palette.
				this.host.pickColor(c.name, c.hex);
				// The pop STAYS OPEN, where the old colour pop closed itself.
				// It closed because it was a pop of its own and picking a
				// colour was the whole of what it was for; this row shares a
				// pop with the size slider, and shutting that under the finger
				// because a swatch was tapped would take the size control away
				// mid-adjustment. Pen contact, an outside tap and Escape close
				// it, the same as they always have.
				this.refresh();
			});
		}
	}

	/** Writing started: nib-size drop-downs get out of the way.
	 *
	 * Returns whether anything was actually open; Escape needs to know.
	 * Closes every pop the strip can show, the eraser's included - pen-down,
	 * outsideTap and Escape all route through here now (alan, 2026-09-02:
	 * "you eraser pop should close when pen touches down... we did it for
	 * other tools but never did it for eraser"). There used to be a second
	 * method, `closePops`, that Escape alone called to also take the eraser
	 * pop; once this closed it too, `closePops` had nothing left to add over
	 * this and was removed. */
	closeInkSliders(): boolean {
		if (!this.hasOpenPop()) return false;
		// The nib pops carry the swatches now, so closing a nib's slider
		// closes its colours with it - the `colorsOpen = false` that used to
		// stand beside this line had a second pop to put away and there is no
		// second pop.
		this.openInkSlider = null;
		// The one bit `eraserPopOpen` checks (below) - set unconditionally,
		// same as the line above, rather than gated on `eraserPopOpen()`
		// first: harmless when the eraser pop was not showing, and it saves
		// a second read of `eraserOn()` here for the common case where it
		// was not the eraser that had anything open.
		this.eraserPopClosed = true;
		// The eraser pop has no timer of its own (see eraserPopOpen), but
		// `sliderHoverTimer` is shared with the pen/highlighter pops this
		// same call just closed; cancel it here too so a hover-away already
		// in flight for one of them cannot reopen a pop this call just put
		// away.
		this.cancelSliderClose();
		this.refresh();
		return true;
	}

	/**
	 * The chrome steps aside while the pen is down. The original reason was
	 * that anything overlapping a desynchronized canvas can demote it off the
	 * low-latency path; that flag is off now (see INLINE_DESYNCHRONIZED), so
	 * the behaviour rests on the simpler reason instead - a toolbar over the
	 * page is a toolbar in the way of the nib.
	 *
	 * Pure class toggles - no reads, nothing forced, safe inside the pen-down
	 * handler.
	 */
	setInking(on: boolean): void {
		this.inking = on;
		this.stepAside.set(on && getPenToolsMode() === "auto");
		// The zoom bar mirrors the same step-aside, on its own mode. Pure class
		// toggle, no reads - same hot path as the two above.
		this.viewportControls?.setInking(on);
	}

	/**
	 * Re-ask both halves of the rule and re-run the step-aside, exactly as the
	 * mode listener does. Public for `refreshNoteZoomControlsAll`.
	 */
	refreshNoteZoomControls(): void {
		this.viewportControls?.refresh();
	}

	/**
	 * Park the strip and its pill at an anchor. Both move together: they are
	 * one control in two sizes, and the old classes come off first so a
	 * change cannot leave two anchors asserted at once.
	 */
	setCorner(corner: ToolbarCorner): void {
		this.corner = corner;
		const stale = allToolbarCornerClasses();
		const want = toolbarCornerClass(corner);
		for (const el of [this.el, this.pill]) {
			for (const c of stale) el.classList.remove(c);
			el.classList.add(want);
		}
		// The chevron points toward the edge the strip collapses into; a
		// hardwired chevron-right pointed off-screen from a left corner.
		// Emptied FIRST: setIcon does not clear the button, and setCorner
		// runs on every bind, so the chevrons stacked up side by side
		// (glass, 2026-08-31, bottom corners). The tooltip's sr-only name
		// goes back in after the sweep.
		this.collapseBtn.empty();
		setIcon(this.collapseBtn, collapseChevronIcon(corner));
		if (!this.collapseBtn.querySelector("svg")) {
			this.collapseBtn.setText(collapseChevronGlyph(corner));
		}
		const label = this.collapseBtn.dataset.tipLabel;
		if (label) this.collapseBtn.createSpan({ cls: "handwriting-sr-only", text: label });
		// The corner just moved, so whether the strip is over the pane's
		// three-dots menu just changed with it (item 5).
		this.applyHeaderClearance();
	}

	/**
	 * Keep the strip off the pane's own "More options" button (item 5).
	 *
	 * The RULE is `stripClearance` (StripClearance.ts) and is pure; this is
	 * the measuring and the applying, and the reason the two are split is the
	 * usual one - the suite has no layout, so a rule living in here could
	 * only be tested by not testing it. What IS tested in a real browser is
	 * this whole path: `test/render/StripHeaderClearance.test.ts` builds a
	 * leaf with a real `.view-actions`, runs this, and measures the two
	 * boxes.
	 *
	 * The pane's OWN actions row. A pdf hands in the leaf and contains the row;
	 * a note hands in an element inside `.view-content`, so its row is found
	 * through the nearest `.workspace-leaf-content`. Never a document-wide
	 * lookup: two open panes must not dodge one another's controls. A
	 * measurement rather than a surface name.
	 */
	private applyHeaderClearance(): void {
		// Cleared FIRST, so the strip is measured where the stylesheet puts
		// it rather than where the last dodge left it. Without this the shift
		// would compound on every resize until the strip walked off the far
		// edge of the pane. A LIVE DRAG'S offset is cleared by the same line
		// and for the same reason - the dodge is computed for where the strip
		// will come to REST, not for where the finger is holding it - and
		// `paintTransform` at the foot of this function puts it straight
		// back, inside the same synchronous task, so nothing paints between.
		for (const el of [this.el, this.pill]) el.setCssStyles({ transform: "" });
		const actions =
			this.pane.querySelector?.(".view-actions") ??
			this.pane.closest?.(".workspace-leaf-content")?.querySelector(".view-actions");
		if (!actions) {
			this.dodge = { x: 0, y: 0 };
			this.paintTransform();
			return;
		}
		// The one that is ON SCREEN. Collapsed, the pill is what sits in the
		// corner and the strip is `display: none` with a zero box - measuring
		// the strip then would report no overlap and leave the pill on the
		// dots, which is the exact state Alan was in when he found this (a
		// collapsed strip is what a phone leaves up while writing).
		const box = this.el.classList.contains("is-collapsed") ? this.pill : this.el;
		const dodge = stripClearance({
			corner: this.corner,
			strip: box.getBoundingClientRect(),
			actions: actions.getBoundingClientRect(),
			pane: this.pane.getBoundingClientRect(),
			// One button's breathing room, matching the 8px the corner rules
			// already hold the strip off the pane's edges by.
			gap: 8,
		});
		this.dodge = { x: Math.round(dodge.x), y: Math.round(dodge.y) };
		this.paintTransform();
	}

	/**
	 * THE ONLY WRITER of `transform` on the strip and the pill.
	 *
	 * Two things want to translate this chrome - the actions-row dodge above
	 * and a live drag - and `transform` is one property, so a second writer
	 * would be a clobber rather than a composition (see the `dodge` field for
	 * the failure). Both keep their answer as numbers and this adds them.
	 *
	 * BOTH ELEMENTS, always together: they are one control in two sizes, and
	 * the pill appearing somewhere the strip was not is the same defect as
	 * either of them covering the dots. Only one of the two is ever visible,
	 * so the collapsed pill picks up a drag made on the expanded strip and
	 * the other way round, with no state to keep in step.
	 *
	 * The lift is a SCALE and it rides here rather than in the stylesheet,
	 * because a `transform` in a rule for these elements is exactly what
	 * `CornerSafeArea.test.ts` forbids - it would be erased by the first
	 * dodge. Scaling about the default origin leaves the centre where it is,
	 * which is what lets the drop measure a centre without unpicking it.
	 */
	private paintTransform(): void {
		const x = this.dodge.x + this.dragOffset.x;
		const y = this.dodge.y + this.dragOffset.y;
		const lift = this.drag?.moved === true ? " scale(1.04)" : "";
		const value = x === 0 && y === 0 && lift === "" ? "" : `translate(${x}px, ${y}px)${lift}`;
		for (const el of [this.el, this.pill]) el.setCssStyles({ transform: value });
	}

	/**
	 * DRAG TO ANCHOR (1.4.12). Pick the toolbar up by its handle, put it
	 * anywhere, and on release it flies to the nearest of the nine placements
	 * and writes that placement to settings.
	 *
	 * ONLY THE HANDLES ARE DRAGGABLE, and that is the whole design. Alan's
	 * convention here is Apple's pencil palette, where the palette itself is
	 * draggable because it has no buttons to confuse a drag with; this strip
	 * is thirteen buttons, and a drag that could start on one of them would
	 * mean every mis-swiped tool press moved the toolbar instead. So the
	 * expanded strip grows a grip at its leading end and the collapsed pill -
	 * which is one button and IS the whole control - is its own handle.
	 *
	 * Pointer capture, so the gesture keeps arriving here once the finger has
	 * left the 24px of grip it started on, which it does immediately. Pen,
	 * finger and mouse alike: only the second-finger test below reads
	 * `pointerType`, because a drag is a drag whatever is doing it and the
	 * three differ only in how much they jitter - which is what the
	 * threshold is for.
	 */
	private armDrag(handle: HTMLElement): void {
		handle.addEventListener("pointerdown", (ev: PointerEvent) => {
			// One at a time. A second finger landing on the grip mid-drag is
			// not a second drag, and taking it would leave the first one's
			// pointer captured with nothing left to end it.
			if (this.drag !== null) return;
			// LEFT BUTTON, AND NOT A SECOND FINGER. A right- or middle-button
			// press on the grip is a menu gesture, not a drag, and a secondary
			// contact of a multi-touch is not one either; either would otherwise
			// travel six px and commit a placement the hand never asked for.
			// Touch only: Windows reports a pen as not primary whenever a second
			// mouse is live beside it, and that pen is still the only hand on it.
			if ((ev.button ?? 0) !== 0 || (ev.isPrimary === false && ev.pointerType === "touch")) return;
			// A tap that is about to be a tap: nothing is painted, no pop is
			// closed, and the pill's click still fires, until the pointer has
			// travelled far enough to say otherwise.
			this.dragClickArmed = false;
			// A contact during the last few px of a flight takes the strip
			// back off the transition, so the new drag tracks the pointer
			// instead of chasing it 160ms behind.
			this.endAnchorFlight();
			ev.preventDefault();
			this.drag = {
				pointerId: ev.pointerId,
				handle,
				startX: ev.clientX,
				startY: ev.clientY,
				moved: false,
				box: { left: 0, top: 0, right: 0, bottom: 0 },
				dodge: { x: 0, y: 0 },
			};
			// Wrapped for the reason the resize observer is: a real engine
			// refuses capture for a pointer it no longer believes is down,
			// and a tree that has no such method at all throws the same way.
			// Losing capture costs the drag its moves once the finger leaves
			// the handle, which the document-level end below cleans up after;
			// throwing here would cost the press entirely.
			try {
				handle.setPointerCapture(ev.pointerId);
			} catch {
				/* no capture: the drag still works while the pointer stays on the handle */
			}
		});
		handle.addEventListener("pointermove", (ev: PointerEvent) => {
			const drag = this.drag;
			if (!drag || ev.pointerId !== drag.pointerId) return;
			const dx = ev.clientX - drag.startX;
			const dy = ev.clientY - drag.startY;
			if (!drag.moved) {
				if (!dragPassedThreshold(dx, dy)) return;
				drag.moved = true;
				// THE POPS AND THE FOLDED ROW GO FIRST, BEFORE THE MEASURE. They
				// hang off the strip's edges and would fly around with it, and a
				// menu the user is no longer looking at is not one they still want
				// open - but the ORDER is the load-bearing part. The folded row is
				// IN FLOW inside the strip (`.handwriting-mobile-tools-more`,
				// styles.css), so with the chevron open the strip stands roughly
				// twice as tall. Measured before this closes, the box below would
				// carry a height that is gone by the next frame, and the centre
				// every drop is judged by would sit half a second row too low -
				// biasing an open-chevron drag toward the bottom anchors, at the
				// phone widths that are the only place that row exists at all.
				this.closeInkSliders();
				this.setMoreOpen(false);
				// MEASURED HERE, once, and before the lift goes on: this is
				// the strip's resting box with whatever dodge it carries, and
				// every later question - its size, its centre - is this box
				// plus the offset, which is arithmetic rather than a second
				// forced layout on a pointermove.
				const box = this.visibleBox().getBoundingClientRect();
				drag.box = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
				// The dodge that box carries, kept with it: the drop compares
				// this box against anchor centres that have no dodge in them,
				// so it has to be able to take this one back out again.
				drag.dodge = { x: this.dodge.x, y: this.dodge.y };
				for (const el of [this.el, this.pill]) el.addClass("is-dragging");
			}
			this.dragOffset = { x: dx, y: dy };
			this.paintTransform();
		});
	}

	/** Whichever of the two is on screen - the pill, when the strip is folded
	 * away and `display: none` with a zero box. The same choice
	 * `applyHeaderClearance` makes, and for the same reason. */
	private visibleBox(): HTMLElement {
		return this.el.classList.contains("is-collapsed") ? this.pill : this.el;
	}

	/**
	 * The pointer came up. A drag that never passed the threshold was a tap
	 * and is left alone; one that did is dropped on the nearest anchor.
	 *
	 * Reached from the DOCUMENT, in capture, beside the held slider's release
	 * and for the same reason: a gesture very often ends with the pointer
	 * somewhere else, and on an engine that refused pointer capture the
	 * handle would never hear the lift at all - leaving a drag live forever,
	 * which is the one failure here with no way back for the user.
	 */
	private readonly endDrag = (ev: PointerEvent): void => {
		const drag = this.drag;
		if (!drag) return;
		// A second finger's lift is not this drag's lift. This listener is
		// document-wide, so it hears every pointer in the window.
		if (ev.pointerId !== drag.pointerId) return;
		try {
			drag.handle.releasePointerCapture(drag.pointerId);
		} catch {
			/* already released, or never taken */
		}
		if (ev.type === "pointercancel") {
			this.cancelDrag(false);
			return;
		}
		if (!drag.moved) {
			this.drag = null;
			return;
		}
		this.dropDrag(drag);
	};

	/**
	 * Put the strip down: choose the anchor, tell the plugin, and fly the
	 * last few px.
	 */
	private dropDrag(drag: ToolbarDragState): void {
		const pane = this.pane.getBoundingClientRect();
		const size = {
			width: drag.box.right - drag.box.left,
			height: drag.box.bottom - drag.box.top,
		};
		// IN THE ANCHORS' OWN FRAME, which is the un-dodged one. `drag.box` was
		// read off the live element and carries the actions-row dodge; the nine
		// resting centres this is about to be compared against are where the
		// stylesheet would put the strip, dodge or no dodge. Taking the dodge
		// back out here is what makes the two comparable - and it is taken out
		// HERE rather than added to all nine, because the strip is one box and
		// the anchors are nine predictions of it.
		const centre = {
			x: (drag.box.left + drag.box.right) / 2 + this.dragOffset.x - drag.dodge.x,
			y: (drag.box.top + drag.box.bottom) / 2 + this.dragOffset.y - drag.dodge.y,
		};
		const corner = nearestAnchor({
			centre,
			pane,
			size,
			inset: TOOLBAR_ANCHOR_INSET_PX,
			current: this.corner,
		});
		// The lift comes off BEFORE the measurement, so `before` is the box
		// and not the box plus 4%. `this.drag` is cleared in the same breath:
		// `paintTransform` reads it for the lift, and everything from here on
		// is a landing rather than a drag.
		const box = this.visibleBox();
		this.drag = null;
		for (const el of [this.el, this.pill]) el.removeClass("is-dragging");
		this.paintTransform();
		const before = box.getBoundingClientRect();
		// A DRAG IS NOT A TAP: the release that ends a drag on the pill also
		// synthesizes a click on it, and the pill's click expands the strip.
		// ONLY for a drag that ended on the pill, because the pill is a real
		// <button> and a keyboard Enter reaches its click with no pointerdown
		// to clear the flag first - a grip drag arming this would swallow
		// that later keypress.
		this.dragClickArmed = drag.handle === this.pill;
		// THE DRAG'S OWN OFFSET GOES HERE, not on the rebound from
		// `setPlacement`. That call does reach this strip's `setCorner` on
		// both real surfaces, and the `applyHeaderClearance` inside it would
		// repaint - but a strip whose translate is only ever cleared by
		// something else calling back into it is a strip stuck at the far end
		// of a gesture the moment a fan-out changes shape. It clears its own.
		this.dragOffset = { x: 0, y: 0 };
		this.paintTransform();
		// THE SAME ROAD THE DROPDOWN TAKES. `setPlacement` persists the
		// placement and moves every open strip on both surfaces, which is
		// what brings this one to its new anchor - including this call's own
		// `setCorner`, and the `applyHeaderClearance` inside it.
		this.host.setPlacement(corner);
		this.flyInto(box, before);
	}

	/**
	 * Animate the last few px, from where the strip was let go to where the
	 * anchor put it.
	 *
	 * MEASURED, NOT COMPUTED. The distance is `before` minus `after`, both
	 * read off the real element, so safe-area insets, android's shade
	 * constant, the pill's concentric offsets and a dodge that changed with
	 * the corner are all in the answer without this function knowing any of
	 * them exist. The alternative - animating towards the resting centre the
	 * anchor rule predicted - would trust a prediction that the stylesheet is
	 * free to disagree with, and would land the strip in the wrong place on
	 * exactly the phones the insets are for.
	 *
	 * `prefers-reduced-motion` is answered in the stylesheet rather than
	 * here: `.is-anchoring` carries the transition and the media query turns
	 * it off, so the class goes on and off the same way either way and the
	 * strip simply arrives.
	 */
	private flyInto(box: HTMLElement, before: { left: number; top: number }): void {
		const after = box.getBoundingClientRect();
		const dx = before.left - after.left;
		const dy = before.top - after.top;
		// Nothing to fly - the drop landed where it already was, or the
		// element cannot be measured (the suite, a detached pane). Half a
		// pixel because a sub-pixel flight is a repaint that shows nothing.
		if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
		// A flight already in the air is over: its class comes off before the
		// start value below is written, so this one really does start where
		// it says it does.
		this.endAnchorFlight();
		// Back to where it was let go, with NO transition on yet...
		this.dragOffset = { x: dx, y: dy };
		this.paintTransform();
		// ...a forced style read, so the browser has a start value to animate
		// FROM rather than coalescing both writes into one paint...
		void box.getBoundingClientRect();
		// ...and then the transition, and the trip home.
		for (const el of [this.el, this.pill]) el.addClass("is-anchoring");
		this.dragOffset = { x: 0, y: 0 };
		this.paintTransform();
		this.anchorTimer = window.setTimeout(() => {
			this.anchorTimer = null;
			for (const el of [this.el, this.pill]) el.removeClass("is-anchoring");
		}, ANCHOR_FLIGHT_MS + 40);
	}

	/**
	 * Take the transition back off, whether or not it has run its course.
	 *
	 * The class must not outlive the flight: `transform` is also what the
	 * actions-row dodge writes, and a strip left with `.is-anchoring` on
	 * would animate a resize's dodge over 160ms instead of applying it.
	 * `window` is only reached when a timer is actually armed, which is the
	 * same guard `cancelSliderClose` and the hold timers rely on to be safe
	 * in a suite that has no window at all.
	 */
	private endAnchorFlight(): void {
		if (this.anchorTimer !== null) window.clearTimeout(this.anchorTimer);
		this.anchorTimer = null;
		for (const el of [this.el, this.pill]) el.removeClass("is-anchoring");
	}

	/**
	 * Abandon a live drag and leave the strip where it started.
	 *
	 * The previous anchor needs no restoring because it was never left: a
	 * drag paints a translate and nothing else, and the placement is written
	 * only on a drop. So cancelling is exactly "put the offset back to zero".
	 *
	 * `liftFollows` says whether a real pointer lift is still coming, and
	 * it is the whole reason this takes an argument. Escape cancels a drag
	 * whose finger is STILL DOWN: that finger lifts a moment later, and on
	 * the pill that lift synthesizes a click which must not expand the
	 * strip - so the swallow is armed. A `pointercancel` IS the lift going
	 * away (the system took the pointer), and no click follows it; arming
	 * there leaves the flag standing with nothing to eat, and the pill is a
	 * real button, so the next Enter or Space on it - a keyboard press,
	 * which reaches `click` with no pointerdown to clear the flag first -
	 * would be swallowed instead, and the strip would silently fail to open
	 * once. Teardown passes false for the same reason: nothing follows it.
	 */
	private cancelDrag(liftFollows: boolean): void {
		if (!this.drag) return;
		const drag = this.drag;
		this.drag = null;
		try {
			drag.handle.releasePointerCapture(drag.pointerId);
		} catch {
			/* already released, or never taken */
		}
		this.dragOffset = { x: 0, y: 0 };
		for (const el of [this.el, this.pill]) el.removeClass("is-dragging");
		this.paintTransform();
		// Only when a lift is still coming, and only on the pill: that is
		// the one handle whose lift synthesizes a click, and Escape is the
		// one cancel a lift still follows. See the header.
		this.dragClickArmed = liftFollows && drag.moved && drag.handle === this.pill;
	}

	/** Did a drag just end on this element? Consumes the answer. */
	private consumeDragClick(): boolean {
		const was = this.dragClickArmed;
		this.dragClickArmed = false;
		return was;
	}

	setCollapsed(on: boolean): void {
		collapsedSession = on;
		// A collapsing strip takes its folded row with it. The row is a child
		// of the strip and would go with it anyway; closing it means the strip
		// comes BACK the way it was last chosen to be seen, rather than
		// re-opening a menu somebody dismissed by collapsing the whole thing.
		if (on) this.setMoreOpen(false);
		// Folding hides any open ink pop along with the rest of the strip
		// (display:none), but leaves `hasOpenPop()` true - so the first Escape
		// pressed after folding is swallowed with nothing visible to show for
		// it (item 101). Close pops here so folding and closing them happen
		// together.
		if (on) this.closeInkSliders();
		this.el.toggleClass("is-collapsed", on);
		this.pill.toggleClass("is-showing", on);
		// Expanding is the moment the strip has widths again - it was
		// `display: none` until this line - so the fold is recomputed here
		// rather than waiting for a resize that may never come. Collapsing
		// skips it, by the guard at the top of `layoutOverflow`.
		this.layoutOverflow();
		// The corner's occupant just changed size - a 34px pill where a full
		// strip was, or the other way - so whether it clears the pane's
		// three-dots changed with it (item 5).
		this.applyHeaderClearance();
	}

	/** Leaving the button or its pop closes the slider, after a beat so
	 * the pointer can travel the gap between them. */
	private scheduleSliderClose(): void {
		this.cancelSliderClose();
		this.sliderHoverTimer = window.setTimeout(() => {
			this.sliderHoverTimer = null;
			let changed = false;
			if (this.openInkSlider !== null && this.sliderFromHover) {
				this.openInkSlider = null;
				changed = true;
			}
			// Same protection, aimed at the eraser's own bit: only close it
			// if it is still open AND hover is what opened it - a tap-opened
			// pop (`eraserPopFromHover` false) is a decision, not a preview,
			// and this timer leaves it alone exactly like it leaves a
			// tap-opened nib slider alone above.
			if (!this.eraserPopClosed && this.eraserPopFromHover) {
				this.eraserPopFromHover = false;
				this.eraserPopClosed = true;
				changed = true;
			}
			if (changed) this.refresh();
		}, 300);
	}

	private tip!: HTMLElement;
	/** The folded pill's tooltip: on the strip's parent, because `tip` is inside the strip and hidden with it. */
	private pillTip!: HTMLElement;
	private tipTimer: number | null = null;

	/**
	 * Obsidian renders its own tooltip from aria-label on MOUSE hover, so
	 * every control showed two bubbles - Obsidian's and ours. The name
	 * moves into a visually-hidden span (screen readers read content), the
	 * attribute goes, and our tip - which also answers PEN hover - is the
	 * only one left.
	 */
	private ownName(el: HTMLElement): void {
		const label = el.getAttribute("aria-label");
		if (!label) return;
		el.removeAttribute("aria-label");
		el.dataset.tipLabel = label;
		el.createSpan({ cls: "handwriting-sr-only", text: label });
	}

	/** OS-style tooltip: a beat of hover shows it, anything else hides it.
	 * Touch is skipped - a tap would flash the tip under the finger while
	 * the button acts, explaining nothing and covering the pops. */
	private attachTip(el: HTMLElement, tipOf: () => HTMLElement = () => this.tip): void {
		this.ownName(el);
		const hide = () => {
			if (this.tipTimer !== null) window.clearTimeout(this.tipTimer);
			this.tipTimer = null;
			this.tip?.removeClass("is-showing");
			this.pillTip?.removeClass("is-showing");
		};
		el.addEventListener("pointerenter", (ev: PointerEvent) => {
			if (ev.pointerType === "touch") return;
			hide();
			this.tipTimer = window.setTimeout(() => {
				this.tipTimer = null;
				const text = el.dataset.tipLabel ?? el.getAttribute("aria-label");
				if (!text) return;
				const tip = tipOf();
				tip.setText(text);
				// Aligned to the hovered control and clamped by the tip's
				// MEASURED width - the old guess of 180px let a long label
				// (the recording dot's) run 80px past the strip's edge.
				// Shown first, so the width is real when read.
				tip.addClass("is-showing");
				if (tip === this.pillTip) {
					this.placePillTip(el, tip);
					return;
				}
				const left = Math.max(
					0,
					Math.min(el.offsetLeft, this.el.offsetWidth - tip.offsetWidth)
				);
				tip.setCssStyles({ left: `${left}px`, right: "auto" });
			}, 350);
		});
		el.addEventListener("pointerleave", hide);
		el.addEventListener("pointercancel", hide);
		el.addEventListener("pointerdown", hide);
	}

	/**
	 * Put the pill's tip beside the pill, in the parent's coordinates: below it, or above it when the pill hangs
	 * at a bottom corner (the strip's own tip flips the same way), clamped inside the parent by its measured width.
	 */
	private placePillTip(pill: HTMLElement, tip: HTMLElement): void {
		const parent = pill.parentElement;
		const room = parent ? parent.clientWidth - tip.offsetWidth : 0;
		const left = Math.max(0, Math.min(pill.offsetLeft, room));
		const above = ["left", "center", "right"].some((x) => pill.classList.contains(`handwriting-corner-bottom-${x}`));
		const top = above ? pill.offsetTop - tip.offsetHeight - 6 : pill.offsetTop + pill.offsetHeight + 6;
		tip.setCssStyles({ left: `${left}px`, top: `${top}px`, right: "auto", bottom: "auto" });
	}

	private cancelSliderClose(): void {
		if (this.sliderHoverTimer !== null) {
			window.clearTimeout(this.sliderHoverTimer);
			this.sliderHoverTimer = null;
		}
	}

	/** The recording dot's press-and-hold, cancelled from anywhere. */
	private cancelRecordingHold(): void {
		if (this.recordingHoldTimer !== null) window.clearTimeout(this.recordingHoldTimer);
		this.recordingHoldTimer = null;
	}

	/**
	 * The quick-pen chip's press-and-hold. Called by the chip's own
	 * pointerup/leave/cancel, by `paintPresets` before it rebuilds the row,
	 * and by `destroy`.
	 */
	private cancelPresetHold(): void {
		if (this.presetHoldTimer !== null) window.clearTimeout(this.presetHoldTimer);
		this.presetHoldTimer = null;
	}

	/** The hover tooltip's beat. */
	private cancelTipTimer(): void {
		if (this.tipTimer !== null) window.clearTimeout(this.tipTimer);
		this.tipTimer = null;
	}

	destroy(): void {
		this.stopModeWatch?.();
		this.stopModeWatch = null;
		this.cancelSliderClose();
		this.stepAside.cancel();
		// Every timer this strip can have armed, cancelled before the elements
		// they would touch are removed. A strip is destroyed and rebuilt on a
		// pen edge, so each of these is a real window, not a theoretical one.
		this.cancelRecordingHold();
		this.cancelPresetHold();
		this.cancelTipTimer();
		// A strip is destroyed and rebuilt on a pen edge, which can land
		// inside a drag - the pen's first contact of the session while the
		// other hand is moving the toolbar. The offset is cleared with it, so
		// nothing is left translated on elements about to be removed.
		this.cancelDrag(false);
		this.endAnchorFlight();
		// The observer outlives the elements it watches unless it is told
		// not to, and this class is now destroyed and rebuilt on a pen edge
		// (`stale()`), so a leak here would accumulate one dead observer per
		// pen-first-contact per pane rather than one per session.
		liveStrips.delete(this);
		this.resizeWatch?.disconnect();
		this.resizeWatch = null;
		this.el.ownerDocument.removeEventListener("pointerdown", this.outsideTap, { capture: true });
		this.el.ownerDocument.removeEventListener("keydown", this.escapeKey, { capture: true });
		this.el.ownerDocument.removeEventListener("pointerup", this.releaseSlider, { capture: true });
		this.el.ownerDocument.removeEventListener("pointercancel", this.releaseSlider, {
			capture: true,
		});
		this.el.ownerDocument.removeEventListener("pointerup", this.endDrag, { capture: true });
		this.el.ownerDocument.removeEventListener("pointercancel", this.endDrag, { capture: true });
		this.el.ownerDocument.removeEventListener("click", this.traceClick, { capture: true });
		this.heldSlider = null;
		this.el.remove();
		this.pill.remove();
		this.pillTip.remove();
		this.viewportControls?.destroy();
		this.viewportControls = null;
		this.buttons = [];
	}

	/**
	 * The fold order changed under a strip that is already on screen.
	 *
	 * The chevron closes first, and that is the whole reason this is a method
	 * rather than a bare `layoutOverflow()` from the setter: the second row's
	 * contents are about to change, and a row left open would silently redraw
	 * under the user's hand holding different buttons than the tap that opened
	 * it asked for.
	 */
	applyFoldOrder(): void {
		this.setMoreOpen(false);
		this.layoutOverflow();
	}

	/**
	 * The ids on the SECOND ROW right now, in the order they read there.
	 *
	 * The settings preview draws its fold line and its caption from this, so
	 * both come from the plan the strip ACTUALLY APPLIED rather than from a
	 * second call to `overflowPlan` with the control's own idea of how wide a
	 * button is. That second call is exactly how a preview and a strip come to
	 * disagree, and disagreeing is the only thing a preview can do wrong.
	 *
	 * Read back off `appliedPlan` - the same string `layoutOverflow` compares
	 * against before it moves anything - so it cannot drift from what is on
	 * screen. Empty whenever the row fits, which is every desktop, and empty
	 * on a strip that has never had a width to measure.
	 */
	get foldedIds(): string[] {
		return this.appliedPlan === "" ? [] : this.appliedPlan.split(",");
	}

	/** Test seam / debugging: the currently open nib slider, if any. */
	get openNibSlider(): "pen" | "highlighter" | null {
		return this.openInkSlider;
	}

	/**
	 * Would a strip built RIGHT NOW carry a different set of buttons than
	 * this one does?
	 *
	 * `shownOn` is read once, at build (see `ButtonSpec.shownOn`), and one of
	 * the two facts it reads has an edge: the pen latch goes false-to-true
	 * the first time real pen hardware touches this device. Nothing else in
	 * this class would notice. `refreshNow` repaints the buttons that exist
	 * and cannot conjure one that does not, and both surfaces' ensure-calls
	 * return early unless the strip is being created or destroyed - so
	 * without this, a phone (where the strip exists from mount, `penToolsVisible`
	 * being unconditionally true on mobile) would get no Keyboard button on
	 * its first pen contact, and none until something else happened to
	 * recreate the strip. That is the bug this method exists to make
	 * impossible, not a theoretical one: it is the exact shape of the phone
	 * case the ruling was made for.
	 *
	 * The surfaces destroy and rebuild on a true answer. A rebuild is cheap
	 * and rare - at most once per session per strip, since the latch cannot
	 * go back down and the device's digitizer cannot change - and it costs
	 * only open pops, which a pen contact was closing anyway.
	 *
	 * Allocation-free, and walking `CONDITIONAL_BUTTONS` rather than all of
	 * them: the pdf surface reaches its `ensureTools` from a cursor path.
	 */
	stale(): boolean {
		for (const spec of CONDITIONAL_BUTTONS) {
			const want = spec.shownOn?.(this.host) ?? true;
			if (want !== this.built.has(spec.commandId)) return true;
		}
		return false;
	}

	/**
	 * Trace-only snapshot of this strip's hit-testability, for
	 * InlinePenRouter's window mirror (InlinePenCallbacks.describeChrome).
	 * `target` is the pointerdown's actual hit element - classified against
	 * THIS strip's real element references rather than a caller guessing
	 * selector strings, because the router deliberately holds none of them
	 * (InlinePenRouter.ts: "the router doesn't know chrome exists, by
	 * design"). Deliberately NOT `instanceof Element` anywhere below - a
	 * popout window's elements belong to another realm and instanceof
	 * refuses them (see `outsideTap`'s own note on this, above); `contains`
	 * and `classList` work across realms and duck-type fine in a test's
	 * hand-rolled element fakes too. Read-only: getComputedStyle calls and
	 * class/field reads, never a write - and it only ever runs while the
	 * router is already composing a trace line, which is itself gated on
	 * `diagnosticsEnabled`, so this costs nothing on the ordinary path.
	 */
	traceState(target: Element | null): string {
		const style = (el: Element | null): string => {
			if (!el) return "(none)";
			const cs = getComputedStyle(el);
			return `vis=${cs.visibility} pe=${cs.pointerEvents} op=${cs.opacity} disp=${cs.display}`;
		};
		const part = ((): string => {
			if (!target) return "none";
			if (this.pill.contains(target)) return "pill";
			// Three pops, not four: the colour pop is gone and its swatches
			// live inside the two nib pops already named here, so a tap on a
			// swatch still classifies as "slider-pop" - the same answer a
			// trace line gave before, reached through the pop that now
			// contains it.
			if (
				this.penSlider.pop.contains(target) ||
				this.hlSlider.pop.contains(target) ||
				this.slider.pop.contains(target)
			) {
				return "slider-pop";
			}
			if (this.buttons.some(({ el }) => el.contains(target))) return "button";
			if (this.el.contains(target)) return "strip-root";
			return "none";
		})();
		const openPop = this.eraserPopOpen() ? "eraser" : (this.openInkSlider ?? "none");
		// Named rather than a bare boolean: which element is stuck, not just
		// whether one is, is the part worth reading off a trace line - a
		// resting finger's lost pointerup (the same shape abandonActiveStroke
		// exists for) would strand this class on exactly one button or the
		// pill, forever, with nothing else in this file's own state to say so.
		const stuckPressed = [this.pill, ...this.buttons.map((b) => b.el)]
			.filter((el) => el.classList.contains("is-pressed"))
			.map((el) => describeEl(el));
		return (
			`hit=${describeEl(target)} strip-part=${part} ` +
			`hitStyle[${style(target)}] stripStyle[${style(this.el)}] pillStyle[${style(this.pill)}] ` +
			`is-inking=${this.el.classList.contains("is-inking")} ` +
			`is-collapsed=${this.el.classList.contains("is-collapsed")} ` +
			`openPop=${openPop} stuckPressed=${stuckPressed.length ? stuckPressed.join(",") : "none"} ` +
			`activeTool=${this.host.activeTool()}`
		);
	}
}
