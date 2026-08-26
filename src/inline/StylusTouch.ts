/**
 * The webkit text layer, and why the pen must be eaten twice on an ipad.
 *
 * On iPadOS the Pencil produces TWO event streams: the pointer events the
 * router claims, and a parallel touch stream Safari synthesizes for
 * compatibility. `preventDefault` on the pointer events does nothing to the
 * touch stream, and the touch stream is the one CodeMirror and the system
 * listen to for text interaction. The result on hardware (2026-08-26, two
 * testers): the keyboard slides up on every stroke, the selection wash
 * paints over fresh ink, and a palm on the risen keyboard defeats palm
 * rejection that was otherwise holding.
 *
 * WebKit marks Pencil-derived touches with `Touch.touchType === "stylus"`
 * (a WebKit extension; the property does not exist on Chromium, and
 * Chromium does not synthesize touches for pens anyway). So the rule is
 * exact and cheap: a touch event whose every changed touch is a stylus is
 * the pen wearing its second costume, and the pen already has an owner.
 * Finger touches pass untouched; scrolling and caret placement by hand
 * keep working. On any engine without the property nothing matches and the
 * listeners are inert.
 *
 * Split out of the router for the usual reason: no obsidian import, loads
 * under vitest, the router owns the events and this module owns the rule.
 */

interface TouchLike {
	touchType?: string;
}

/**
 * True when the event's changed touches are all stylus-typed. Mixed events
 * (finger and stylus in one event) pass untouched: eating them would take a
 * real finger with them, and a stray extra classification is cheaper than a
 * dead scroll.
 */
export function stylusOnlyTouches(touches: ArrayLike<TouchLike>): boolean {
	if (touches.length === 0) return false;
	for (let i = 0; i < touches.length; i++) {
		if (touches[i]?.touchType !== "stylus") return false;
	}
	return true;
}
