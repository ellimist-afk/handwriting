/**
 * The strip's button table, its fold order and the faces the settings tab draws from it (data only; no DOM, no state).
 * The tip predicates the table's isActive and isLit read (tipInks through mouseDrawsHere) live here too, so this file imports only a type from MobileTools.ts and the two files form no cycle.
 * Moved out of MobileTools.ts; MobileTools.ts re-exports the names other files import.
 */

import { deviceHasNeverSeenAPen, penHardwareEverSeen, penHardwareSeen } from "./PenToolsMode";
import { mouseDrawsFromLitTool, toolIsLit } from "./MouseInk";
import type { MobileToolsHost } from "./MobileTools";

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
 * The colour a nib's icon is painted in: the pen's own ink blended toward the
 * theme's readable text colour rather than the raw hex. A pen this close to the
 * background (black in dark mode, white in light mode) would nearly disappear
 * while unlit. The blend still reads as "that colour" - it is mostly the pen's
 * own hue - it just never goes all the way to invisible against the page. The
 * strip and the always-shown row of the Fold Order preview both paint through
 * this, so the preview shows what the toolbar shows.
 */
export const nibInkColor = (hex: string): string => `color-mix(in srgb, ${hex} 70%, var(--text-normal))`;

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
export const mouseDrawsHere = (h: MobileToolsHost): boolean =>
	h.penInksHere() &&
	(h.mouseInkOn() || mouseDrawsFromLitTool(deviceHasNeverSeenAPen(), toolIsLit(h.penInksHere())));

export interface ButtonSpec {
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

export const BUTTONS: ButtonSpec[] = [
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
