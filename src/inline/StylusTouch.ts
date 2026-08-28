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

/**
 * How wide a contact has to be, in css px of RADIUS, before it is treated as
 * a palm rather than a finger.
 *
 * Deliberately high. Getting this wrong in one direction eats a real tap and
 * the caret stops working; in the other it lets a palm through and the
 * keyboard rises, which is exactly today's behaviour. So the threshold is set
 * where only a clearly hand-sized contact crosses it, and the failure mode is
 * the one we already live with. A fingertip on iPadOS reports a radius in the
 * low tens; a resting palm reports several times that.
 */
export const PALM_RADIUS_PX = 40;

interface SizedTouch {
	touchType?: string;
	radiusX?: number;
	radiusY?: number;
}

/**
 * True when every changed touch is big enough to be a palm.
 *
 * The gap this fills: PalmGate blocks touches that arrive while the pen is
 * hovering, which is the "palm placed before pen" rule - but Pencil hover
 * only exists on recent iPads, so on the rest the palm lands with no pen
 * signal at all, reaches the contenteditable, and brings the keyboard up
 * before a single stroke (alan, iPad, 2026-08-27). Contact size is the one
 * signal available at that moment.
 *
 * Mixed events pass, same reasoning as the stylus rule: eating a batch that
 * contains a real finger would take the finger with it. Touches that report
 * no radius at all (every non-WebKit engine) never match, so this is inert
 * off iPadOS.
 */
export function palmSizedTouches(touches: ArrayLike<SizedTouch>): boolean {
	if (touches.length === 0) return false;
	for (let i = 0; i < touches.length; i++) {
		const touch = touches[i];
		if (!touch) return false;
		const rx = touch.radiusX;
		const ry = touch.radiusY;
		if (typeof rx !== "number" || typeof ry !== "number") return false;
		if (!Number.isFinite(rx) || !Number.isFinite(ry)) return false;
		if (Math.max(rx, ry) < PALM_RADIUS_PX) return false;
	}
	return true;
}
