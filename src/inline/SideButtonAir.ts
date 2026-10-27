/**
 * The pen's side button pressed and released in the air switches the tip
 * between pen and eraser. Android only (GitHub issue 45).
 *
 * WHY THE AIR. On Android the browser takes a pen contact that begins with the
 * side button held and hands it to its own text selection; the page never
 * receives that contact, and the selection popup is what the writer sees. So
 * the in-contact read in `penContactIntent` (TipMode.ts, `buttons & 2`) never
 * fires there. What the page does receive is the hover stream: rows with
 * buttons 0, then buttons 1 while the button is held in the air, then 0 again.
 * That press and release, with no contact between, is the one switch signal
 * that avoids the popup.
 *
 * WHAT IS NOT A CLICK. A press that ends in a pointerleave is the held touch
 * Android takes for selection; a press that ends in a pointerdown is a
 * contact. Both are cancelled through `sideButtonAirInterrupt`. A pressed row
 * with pressure above 0 is a contact landing, not a button in the air. No
 * double click, no timing, no lasso.
 *
 * Every other platform reports the side button in contact as buttons bit 2
 * and keeps that path; this machine does nothing there.
 *
 * DOM-free apart from the `Platform` read, so the rules are unit-tested on
 * their own (SideButtonAir.test.ts) and the router only feeds rows.
 */

import { Notice, Platform } from "obsidian";
import { airSwitchEnabled, setTipMode, takeAirSwitchHint, tipMode } from "./TipMode";

/** The one-time note at the first held touch (TipMode.ts, `takeAirSwitchHint`). */
const AIR_HINT = "Click the pen button while hovering over the screen to switch pen and eraser.";

/**
 * "idle": no button held. "pressed": the button went down in the air and
 * nothing has touched since. "spent": the press was ended by a contact, a
 * leave or a landing nib; it stays spent, whatever rows follow, until the
 * button is released, so the held touch's own rows (1 after the leave, then 0)
 * cannot complete a click.
 */
let state: "idle" | "pressed" | "spent" = "idle";

/**
 * The newest hover row's event stamp. The two hover streams do not keep each
 * other's order: on a Galaxy Tab S9+ (trace ff7102b5, 24.500 s) the
 * pointerrawupdate release came first, then a pointermove row still pressed
 * but four milliseconds OLDER, then the pointermove copy of the release. Fed
 * in arrival order, that old row re-armed the press and the copy clicked a
 * second time. A row older than one already fed is dropped; an equal stamp is
 * the same event on the other stream and is fed (it changes nothing).
 */
let lastStamp = Number.NEGATIVE_INFINITY;

/**
 * Feed one hover row (no active contact). Returns the trace line when the row
 * completes a click and switches the tip, otherwise null.
 *
 * Both hover streams (pointermove and pointerrawupdate) feed the same rows; the
 * first release returns the machine to idle, so the second copy of it does
 * nothing, and a row older than one already fed is dropped (`lastStamp`).
 */
export function sideButtonAirHover(pointerType: string, buttons: number, pressure: number, timeStamp: number): string | null {
	if (!Platform.isAndroidApp || pointerType !== "pen" || !airSwitchEnabled()) return null;
	if (timeStamp < lastStamp) return null;
	lastStamp = timeStamp;
	if ((buttons & 1) !== 0) {
		// Pressure above 0 is the nib landing, not the button in the air.
		if (pressure > 0) state = "spent";
		else if (state === "idle") state = "pressed";
		return null;
	}
	if (buttons !== 0) return null;
	const was = state;
	state = "idle";
	if (was !== "pressed") return null;
	const from = tipMode();
	const to = from === "eraser" ? "nib" : "eraser";
	// setTipMode repaints every strip through its listener, so the toolbar
	// shows which tool the tip now is.
	setTipMode(to);
	return `side button in the air: ${from} -> ${to}`;
}

/**
 * A pointerdown or a pointerleave: a press in progress is not a click. Returns
 * the trace line when a press was cancelled, otherwise null.
 *
 * `leave` is the pen leaving the page with the button down: the held touch
 * Android takes for text selection. The first one on a device shows the
 * one-time note. A pointerdown is a contact the page did receive, and shows
 * nothing.
 */
export function sideButtonAirInterrupt(leave = false): string | null {
	if (state !== "pressed") return null;
	state = "spent";
	if (leave && takeAirSwitchHint()) new Notice(AIR_HINT);
	return "side button held into a touch: no switch";
}

/** Test seam. */
export function resetSideButtonAirForTest(): void {
	state = "idle";
	lastStamp = Number.NEGATIVE_INFINITY;
}
