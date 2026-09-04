/**
 * When the floating pen-tools strip shows (roadmap wishlist: pen GUI).
 *
 * Mobile always shows it: the palette lives in a toolbar the pen keeps
 * hidden, so the strip is the only path. Desktop is the judgment call - a
 * keyboard user writing prose does not want floating chrome, and a Surface
 * in tablet mode has exactly the iPad's problem. "auto" resolves it without
 * a setting safari: the strip appears the first time a pen is actually
 * seen (hover or contact) and stays for the session. "show" and "hide"
 * override in either direction, for the people auto guesses wrong about.
 */

import { disarmMouseInkQuietly, mouseActsAsPen } from "./MouseInk";

export type PenToolsMode = "auto" | "show" | "hide";

export const PEN_TOOLS_MODES: readonly PenToolsMode[] = ["auto", "show", "hide"];

let mode: PenToolsMode = "auto";
let penSeen = false;
/**
 * A real pen fired a real event.
 *
 * SEPARATE from `penSeen`, which answers the STRIP-VISIBILITY question and is
 * deliberately set by UI paths too: every tool command, the mouse-ink toggle
 * and the settings switch call `markPenSeen` so that asking for a pen tool
 * raises the pen UI on a machine that has never held a pen. That is correct
 * for visibility and fatal for anything reading `penSeen` as "a pen exists" -
 * a mouse-only user turns it true on their first click of the strip, and
 * every read after that is a constant.
 *
 * `nibIsLit` was reading it that way, which is why the pen button would not
 * go dark when a mouse click handed the tip back to text (alan, 2026-09-02:
 * "doesnt unhighlight the boxes, they are still lit"). This flag answers the
 * question that one actually wanted - does the tip ink WITHOUT mouse ink -
 * and only genuine pen contact or pen hover may set it.
 */
let penHardware = false;

/**
 * Surfaces waiting to be told the answer changed.
 *
 * The note surface never needed this: `refreshPenToolsAll` (InkOverlay.ts)
 * walks InkOverlay's own set of open editors, and every place in main.ts that
 * changes the mode or marks a pen calls it on the next line. The PDF surface
 * is not in that set - main.ts holds its controllers in a different map, and
 * the note's fan-out has never looked there - so "Pen toolbar → Hide" hid the
 * strip on notes and left it on screen over every PDF (alan, 2026-09-02).
 *
 * A registry HERE rather than a second fan-out in main.ts, because the two
 * things that can change the answer - `setPenToolsMode` and `markPenSeen` -
 * both live in this file, and a subscriber therefore cannot be missed by a
 * caller who forgot to refresh. That is not hypothetical: `markPenSeen` is
 * called from inside both ink surfaces' own pen paths (InkOverlay's
 * `showPenCursor` and ink branch, PdfInkController's `showCursor` and
 * `penDown`), where no `refreshPenToolsAll` follows it and none should.
 */
type PenToolsListener = () => void;
const listeners = new Set<PenToolsListener>();

/**
 * Be told whenever `penToolsVisible` would answer differently than it just
 * did. Returns the unsubscribe, which a surface MUST call at teardown: a PDF
 * viewer is rebuilt inside a leaf that outlives it, and a controller leaking
 * one of these per teardown would hold a dead pane's strip logic alive for
 * the rest of the session.
 */
export function onPenToolsChanged(listener: PenToolsListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Tell everyone, and let nobody's failure stop the next.
 *
 * Copied before walking, because a listener is allowed to unsubscribe from
 * inside the call - tearing a surface down IS one of the things a mode change
 * can do - and mutating the set being iterated is how that turns into a
 * missed surface. Each call is bulkheaded for the reason every strip path in
 * this plugin is: chrome must never take the ink down with it.
 */
function announce(): void {
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch (err) {
			console.error("[handwriting] pen tools listener failed", err);
		}
	}
}

export function getPenToolsMode(): PenToolsMode {
	return mode;
}

export function setPenToolsMode(m: PenToolsMode): void {
	// Only on a real change. The setting is re-applied at every settings save
	// and again at load, and announcing an unchanged answer would have every
	// open surface re-run its create-or-destroy for nothing.
	if (mode === m) return;
	mode = m;
	announce();
}

export function normalizePenToolsMode(raw: unknown): PenToolsMode {
	return raw === "show" || raw === "hide" ? raw : "auto";
}

export function nextPenToolsMode(cur: PenToolsMode): PenToolsMode {
	const i = PEN_TOOLS_MODES.indexOf(cur);
	return PEN_TOOLS_MODES[(i + 1) % PEN_TOOLS_MODES.length] ?? "auto";
}

/**
 * Show the strip: something asked for the pen UI. NOT proof of a pen - see
 * `penHardware` above for why, and `markPenHardwareSeen` for the flag that is.
 */
export function markPenSeen(): void {
	// The false-to-true edge only. This runs on every pen-down on both
	// surfaces, and announcing on each of them would put a create-or-destroy
	// sweep in the middle of every stroke's first sample - the one place in
	// this plugin where nothing may be spent.
	if (penSeen) return;
	penSeen = true;
	announce();
}

export function penSeenThisSession(): boolean {
	return penSeen;
}

/**
 * A real pen touched or hovered the glass (hover counts: it is proof enough).
 *
 * Marks the strip visible too - a pen is proof for both questions, and every
 * caller of this one used to call `markPenSeen` here, so routing visibility
 * through it is what keeps the strip appearing exactly when it did before.
 *
 * No `announce` on the hardware edge of its own: the visibility answer is
 * what listeners create and destroy surfaces for, `markPenSeen` already
 * announces that edge, and this runs from inside both surfaces' pen-down -
 * the one place in this plugin where nothing may be spent. The LIGHT does not
 * need one either; every caller follows this with `ensurePenTools`, whose
 * strip refreshes on the same contact.
 *
 * The gate lives at the CALL SITES rather than in here, matching
 * `PdfInkController.showCursor`'s `if (pointerType === "pen") markPenSeen()` -
 * they are the only code that still knows what fired the event.
 */
export function markPenHardwareSeen(): void {
	// The hardware answer FIRST, then visibility. `markPenSeen` announces,
	// and a listener that woke on that edge and read `penHardwareSeen()`
	// would otherwise be told there was no pen by the very call a pen made.
	// It also survives anyone later putting a guard on `markPenSeen`: the
	// flag this function exists to set is already set by then.
	penHardware = true;
	markPenSeen();
}

/**
 * Does the tip ink without mouse ink? Only a real pen makes this true.
 *
 * Read by `nibIsLit` (MobileTools.ts) and by nothing that decides visibility.
 * A finger cannot ink an ordinary note at all - `InlinePenRouter.pointerDown`
 * returns on every branch of its `pointerType === "touch"` block - so touch
 * not setting this is the honest answer rather than a gap.
 */
export function penHardwareSeen(): boolean {
	return penHardware;
}

/**
 * Forget the pen, for the LIGHT only. Turning mouse ink off calls this.
 *
 * ALAN'S RULE, 2026-09-03, in his words: the pen button "should be dark until
 * you touch with your pen", and turning mouse ink off should turn the light
 * off "at any point". Before this, one stroke from a real pen latched
 * `penHardware` for the rest of the session, so the button stayed lit however
 * many times mouse ink was switched off afterwards - he read that as the light
 * being stuck, and testing it by hand could not make it go dark.
 *
 * It clears `penHardware` and DELIBERATELY NOT `penSeen`. Those two answer
 * different questions and he separated them explicitly when asked: `penSeen`
 * decides whether the pen TOOLBAR exists, and he does not want the toolbar
 * disappearing ("why the fuck would the toolbar disappear"). `penHardware`
 * decides only whether the nib reads as able to ink. Clearing both would take
 * the strip away from under him, which is the opposite of what he asked for.
 *
 * Nothing is lost by clearing it: every real pen contact calls
 * `markPenHardwareSeen` again on both surfaces, so the next touch of the nib
 * lights it straight back up. That is the whole of "dark until you touch with
 * your pen".
 *
 * No `announce()`. This changes no surface's existence - only how the strip
 * draws - and both callers follow it with `refreshPenToolsAll()`, which is the
 * repaint that actually matters here.
 */
export function clearPenHardwareSeen(): void {
	penHardware = false;
}

/**
 * Put a tool DOWN with a mouse: hand the pointer back to text, light out.
 *
 * The two halves are paired here, once, because they are one rule with two
 * writers. Mouse ink going off darkens the nib light "at any point" (alan,
 * 2026-09-03); the loud toggle command spells that pair out itself, and this
 * is the quiet path that the strip's own buttons take. Written twice - once
 * per ink surface's host - it would be the same duplication that has cost
 * this project nine one-surface divergences.
 *
 * It lives in THIS module rather than `MouseInk.ts` because the light is this
 * module's state and `MouseInk` cannot reach it: the import already runs the
 * other way (`mouseActsAsPen`, above), so the cycle would be real.
 *
 * `penSeen` is untouched, deliberately, exactly as in `clearPenHardwareSeen`.
 * Putting a tool down must not take the toolbar away.
 */
export function releaseMouseInkQuietly(): void {
	disarmMouseInkQuietly();
	penHardware = false;
}

/**
 * May this pointer raise the pen toolbar? "Can it ink", not "is it a pen".
 *
 * ALAN REVERSED HIS OWN 1.4.6 RULING TO GET THIS, 2026-09-03. He was asked
 * directly, with the old rationale quoted back to him - "a mouse in the room,
 * reticle off, raised the pen toolbar in auto mode for a pointer that was
 * never a pen" (1.4.6-design.md 5m/AF5) - and answered "with mouse ink armed,
 * yes a hovering mouse should bring toolbar out". AF5 refused the mouse
 * outright; the armed mouse is the case it did not separate out, and a mouse
 * whose owner has deliberately turned mouse ink on is asking for the tools.
 * The unarmed mouse is still refused, which is the half of AF5 that stands.
 *
 * The gate lives here and the surfaces read it, rather than each spelling the
 * condition out: the note and the pdf disagreeing about exactly this was the
 * defect (this was the note surface's behaviour and not the pdf's), and two
 * copies of the new rule would be the same defect with a fresh coat.
 *
 * VISIBILITY ONLY. A mouse with ink armed may raise the strip and may never
 * set the hardware flag - `markPenHardwareSeen` stays gated on a real pen on
 * both surfaces. `nibIsLit` already answers the mouse case through its own
 * `|| h.mouseInkOn()` disjunct, and routing the mouse into `penHardware` to
 * light the nib would be the 1.4.6-through-1.4.8 bug rebuilt from the far end.
 */
export function pointerRaisesPenTools(pointerType?: string): boolean {
	return pointerType === "pen" || mouseActsAsPen(pointerType);
}

/** The whole visibility rule, pure. */
export function penToolsVisible(m: PenToolsMode, isMobile: boolean, seen: boolean): boolean {
	if (m === "show") return true;
	if (m === "hide") return false;
	return isMobile || seen;
}

/** Test seam. */
export function resetPenToolsForTest(): void {
	mode = "auto";
	penSeen = false;
	penHardware = false;
	// The subscribers too, and not as an afterthought: this is module state
	// like the other two, and a listener left over from a surface an earlier
	// test never tore down would fire into a dead fixture on the next test's
	// first mode change.
	listeners.clear();
}

/**
 * How many surfaces are listening. Test seam, and the only witness there is
 * that a teardown actually ran its unsubscribe - a leaked listener is
 * invisible from the outside until the session has accumulated enough of them
 * to matter, which is exactly too late to notice.
 */
export function penToolsListenerCountForTest(): number {
	return listeners.size;
}
