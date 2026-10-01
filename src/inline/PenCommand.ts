/**
 * ONE PEN COMMAND (1.4.12). Alan, 2026-09-05: "there are two of these
 * Handwriting: Pen and Handwriting: toggle pen input on/off - i think that's
 * stupid there should only be one", then "Pen on / off like Mouse on / off".
 *
 * THE MODEL HE ACCEPTED, in his own framing. On a machine with a pen AND a
 * mouse, "Pen on / off" says whether the pen inks or taps and selects like a
 * finger, and "Mouse on / off" says whether the mouse draws with the lit tool
 * or selects text; neither touches the other there. On a machine that has
 * never seen a pen, "Pen on / off" carries the mouse along - not by reaching
 * into the mouse switch, which stays exactly the explicit override it has
 * always been, but because there is nothing else for the mouse to be: the
 * derived grant already in the tree (`mouseDrawsFromLitTool`, MouseInk.ts)
 * hands a pen-less device whichever tool is lit. So lighting the pen IS
 * turning the mouse on there, and putting it down IS turning it off, and
 * `mouseInkEnabled` is not written either way.
 *
 * His walkthrough, which is the round trip the tests pin: mouse-only machine,
 * fresh state, run it - the toolbar appears with the pen lit and a drag inks;
 * run it again - the pen goes dark, a drag selects text, the toolbar stays;
 * run it a third time and the pen is back, lit AND drawing. That third press
 * is why this composes a PICK with the switch rather than only flipping the
 * switch: `setPenInk(false)` unpicks the tool (PenInk.ts), so coming back
 * through keyboard mode with nothing re-picked would come up dark on exactly
 * the device the ruling is about.
 *
 * NO NEW STATE. `penInkEnabled` is the one source of truth for whether the
 * pen inks - the palette command here and the strip's keyboard button both
 * write it and nothing else, so the two can never disagree - and "which tool
 * is lit" is read through the same `toolIsLit` the strip's own light and the
 * router's mouse grant read. This module adds no flag of its own.
 *
 * THE HOST SEAM exists so the decision can be tested without an Obsidian.
 * Everything below the switch - the nib, the tip modes, the toolbars, the
 * live stroke, the hover reticle - lives in modules that need a real editor,
 * and main.ts already holds all of them; it passes them in as one object and
 * keeps the ORDER it has always run them in (`afterFlip`). What is here is
 * only the rule.
 */

import { toolIsLit } from "./MouseInk";
import { penInkEnabled, setPenInk } from "./PenInk";
import { penHardwareSeen } from "./PenToolsMode";

/** What the pen-input paths need that this module cannot reach on its own. */
export interface PenCommandHost {
	/** The nominal nib, `getInlineTool()`: "pen" or "highlighter". */
	tool(): string;
	/** Is a tip MODE holding the tip - eraser, lasso, insert space or pan? */
	tipMode(): boolean;
	/**
	 * Pick the pen, the way every tool command picks one: `setInlineTool("pen")`
	 * plus the exits from the four tip modes. `setInlineTool` is one of the two
	 * writers that call `markToolPicked` (MouseInk.ts), which is the half of
	 * "lit" this module reads back.
	 */
	pickPen(): void;
	/**
	 * The chrome, in main.ts's own order, after the switch has moved: commit
	 * the live stroke, raise the pen UI (or not, on the OFF side of a device
	 * that has never seen pen hardware), redraw the toolbars, and put a
	 * stranded hover reticle out. Told the state it is running for.
	 */
	afterFlip(on: boolean): void;
}

/**
 * Is the PEN the lit tool right now?
 *
 * `toolIsLit(penInkEnabled())` is the shared half - pen input on AND some tool
 * picked this session - and the rest asks whether the tool in question is the
 * pen rather than the highlighter or one of the four tip modes. A highlighter
 * user pressing "Pen on / off" is asking for the pen, not for keyboard mode,
 * which is why this is narrower than `toolIsLit` alone.
 *
 * A pen that has written here is lit too, picked or not: pen input on and pen
 * hardware seen, the strip's own reading (`penDrawsHere`, MobileTools.ts). A
 * pen contact never sets the picked flag, so on a pen device the first press
 * used to take the pick-up branch and turn on a pen that was already on
 * (audit 170).
 */
export function penIsLit(h: PenCommandHost): boolean {
	const lit = toolIsLit(penInkEnabled()) || (penInkEnabled() && penHardwareSeen());
	return lit && h.tool() === "pen" && !h.tipMode();
}

/**
 * "Pen on / off" (command id `inline-tool-pen`). Returns the state the pen
 * input is in afterwards, which is what the caller's toast names.
 *
 * Two cases and no third: the pen is lit, so put it down; or it is not - pen
 * input off, or a different tool holding the tip - so raise it and pick it.
 *
 * NOT AN UNDO. The "up" press is a PICK as well as a switch, and a pick is not
 * something the next press takes back, so two presses are not a no-op. What
 * they always do: leave the pen as the nib with no tip mode holding it, and
 * leave pen input on only where the pen was ALREADY lit. A highlighter, an
 * eraser-held tip or an unpicked tool therefore does not come back - the pair
 * ends in keyboard mode with the pen as the nib, which is the state the pick
 * had to pass through. Only the two starts that already look like where the
 * pair lands come back unchanged; PenCommandIsOne.test.ts writes out all six.
 *
 * ORDER, and it only works one way round: `setPenInk(true)` never unpicks a
 * tool and `setPenInk(false)` always does, so the switch goes first and the
 * pick second. Picking first would work today and break the moment anything
 * else reaches `clearToolPicked`.
 */
export function penOnOff(h: PenCommandHost): boolean {
	if (penIsLit(h)) {
		setPenInk(false);
		h.afterFlip(false);
		return false;
	}
	setPenInk(true);
	h.pickPen();
	h.afterFlip(true);
	return true;
}

/**
 * The strip's keyboard button, unchanged in meaning: flip the pen-input
 * switch and nothing else. Returns the new state.
 *
 * DELIBERATELY NOT `penOnOff`. The button says "keyboard mode", it is only
 * built where a pen has actually been seen (MobileTools.ts), and a pen user
 * coming back from typing is not asking to have the highlighter taken out of
 * their hand. It writes the same one flag the command does, so the two are
 * always telling the same story about whether the pen inks.
 */
export function togglePenInput(h: PenCommandHost): boolean {
	const on = !penInkEnabled();
	setPenInk(on);
	h.afterFlip(on);
	return on;
}
