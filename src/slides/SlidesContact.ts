/**
 * The slides surface's contact and eraser helpers: tap against stroke, the palm guard's windows, the contact claim
 * and the eraser. Pure functions and constants; SlidesInkSurface.ts re-exports every name.
 */
import { PALM_RADIUS_SWALLOW_PX } from "../input/PalmShield";
import { penContactIntent } from "../inline/TipMode";
import { splitStrokeByCircle, strokesHitByCircle } from "../ink/Eraser";
import { InkStroke } from "../ink/Stroke";
import { mapScreenToSlide, type ScreenRect, slideScale } from "./SlidesInkSurface";

// ---- tap vs stroke (A1) ---------------------------------------------------

/** How far a pen may travel and still be a tap, in screen px. */
export const TAP_SLOP_PX = 6;
/** How long a pen may stay down and still be a tap, in ms. */
export const TAP_MS = 250;

/**
 * Has this contact become a stroke, or is it still a tap? (§3.3)
 *
 * Screen px rather than logical units on purpose: this is a question about the
 * reader's hand, and the same wobble is the same wobble whether the deck is
 * scaled to a laptop or a projector. Distance OR time, because a slow
 * deliberate dot is ink and a fast flick across a button is not a tap.
 */
export function contactBecameStroke(
	dxPx: number,
	dyPx: number,
	elapsedMs: number
): boolean {
	if (elapsedMs > TAP_MS) return true;
	return Math.hypot(dxPx, dyPx) > TAP_SLOP_PX;
}

/**
 * The event types that can navigate the deck once a contact has been delivered
 * (S6), and which a live pen STROKE therefore has to swallow.
 *
 * `click` is the one that actually navigated the deck on hardware: a pen tap
 * still produces one however hard the pointerdown was preventDefaulted. The
 * touch three are Reveal's other navigation path, swallowed at no cost since a
 * pen does not synthesise them.
 *
 * This list is matched against events of EVERY pointer type, so `pointerdown`
 * is deliberately absent and MUST stay absent: swallowing a pen's own
 * pointerdown once its stroke went live would cost the deck its focus and its
 * keyboard (S4). The palm guard does need `pointerdown`, and that is exactly
 * why it has a list of its own - see `PEN_CONTACT_GUARDED_EVENTS`.
 */
export const PEN_GUARDED_EVENTS: readonly string[] = [
	"click",
	"auxclick",
	"dblclick",
	"pointerup",
	"touchstart",
	"touchmove",
	"touchend",
];

/**
 * The event types swallowed for a TOUCH contact the whole time a pen owns the
 * glass - the palm guard (Alan, 2026-09-05: "palm during a stroke, yes add the
 * palm rejection so it is bullet proof").
 *
 * Reveal 4 navigates touch through its POINTER handlers as well as its touch
 * handlers - `onPointerMove` forwards a `pointerType === "touch"` event
 * straight to `onTouchMove` - so a palm resting on the deck and dragged while
 * the pen writes reaches Reveal's swipe as a plain `pointermove`, which the
 * stroke list above never saw. The standing `touch-action: none` does not stop
 * it either: that guard stops the BROWSER's gesture, not Reveal's own
 * JavaScript one. The slide turned mid-stroke.
 *
 * TWO LISTS, AND THEY MUST STAY TWO. This one is consulted only for touch (a
 * `pointerType === "touch"` pointer event, or a `touch*` event, which carries
 * no pointer type and is touch by definition), so it can afford `pointerdown`;
 * the stroke list is consulted for every pointer type, so it cannot (S4).
 * Folding these four into `PEN_GUARDED_EVENTS` would swallow the PEN's own
 * pointerdown the moment a stroke went live and take the deck's keyboard with
 * it. `swallowDuringPenContact` is the one place the two rules meet.
 *
 * The window is CONTACT, not stroke: the palm has to be rejected from the
 * instant the pen claims the glass, including the whole life of a tap that has
 * not been promoted yet.
 */
export const PEN_CONTACT_GUARDED_EVENTS: readonly string[] = [
	"pointerdown",
	"pointermove",
	"pointerup",
	"pointercancel",
	"touchstart",
	"touchmove",
	"touchend",
];

/**
 * How long the navigation guard outlives a stroke that ended without a lift.
 *
 * The same 300 ms as `STROKE_HOLD_MS` and for the same reason: a pen that is
 * still on the glass keeps reporting, so a silence this long is the only
 * evidence there is that the contact really is over.
 */
export const PEN_GUARD_TAIL_MS = 300;

// ---- the palm's three unguarded windows (S4, amended) ----------------------
//
// `PEN_NEAR_TAIL_MS`, `PEN_RELEASE_TAIL_MS` and `PALM_CONTACT_SWALLOW_PX` are
// the three numbers the palm rule was missing. The first two are `PalmGate`'s
// own, restated rather than imported because `src/input/PalmGate.ts` declares
// them `const` at module scope and exports NEITHER (only `PAROLE_*` are
// exported), so there is nothing to import - the same restating this file
// already does for `bandEraserIntent`, and for the same kind of reason. IF
// PalmGate ever exports them, delete these two and import them: PalmGate.ts is
// the source of truth for both and a drift here is a bug here.
//
// The third is genuinely imported: `PalmShield.ts` is a LEAF (it imports
// nothing at all - checked, not assumed), so unlike `InlinePenRouter.ts` it
// drags no input stack into the slides bundle. Only the conversion is local,
// see `PALM_CONTACT_SWALLOW_PX`.

/**
 * How long after the last pen HOVER sample the pen still counts as near.
 *
 * PalmGate.ts's `HOVER_TAIL_MS`, which is the source of truth for this number.
 * Its reason is this file's reason: while the pen hovers, the hand is holding
 * the pen, so a new touch is very likely the palm arriving a beat ahead of the
 * nib ("palm placed before pen"). Without it the slides palm guard could not
 * arm until the pen's own pointerdown, which is one beat too late.
 */
export const PEN_NEAR_TAIL_MS = 300;

/**
 * How long the PALM half of the guard outlives a normal lift.
 *
 * PalmGate.ts's `RELEASE_TAIL_MS`, which is the source of truth: "the palm
 * usually lingers". The nib leaves the glass first and the heel of the hand
 * follows, so the moves it makes on the way up are the ones that reach
 * Reveal's swipe and carry the ink that was just written off the screen.
 *
 * This is NOT `PEN_GUARD_TAIL_MS` and must not be folded into it. That one is
 * 300 ms and covers a stroke that ended WITHOUT a lift, holding the whole
 * navigation guard - the `click` rule included - until the real `pointerup`
 * arrives. This one runs only AFTER a lift, holds only the touch-shaped rule,
 * and deliberately lets the pen's own trailing `click` through on the next
 * tick exactly as it does today (that is what lets a pen tap reach the arrow).
 */
export const PEN_RELEASE_TAIL_MS = 250;

/**
 * Contact size, in css px, at and above which a POINTER event is palm-shaped.
 *
 * `PalmShield.PALM_RADIUS_SWALLOW_PX` is a RADIUS (`Touch.radiusX/radiusY`);
 * `PointerEvent.width/height` are the contact's full extent. Doubling is the
 * whole of the conversion, and it is the only thing restated from the shield -
 * the classifier itself, and the platform gate that decides whether contact
 * radii mean anything at all, are imported and used unchanged.
 *
 * Why a pointer-side copy exists when the shield is attached to `.reveal`
 * anyway: `PalmShield` listens to `touch*` only, and this file's whole reason
 * for having a palm guard is that Reveal 4 ALSO navigates through its POINTER
 * handlers (see `PEN_CONTACT_GUARDED_EVENTS`). The shield closes the
 * `touchstart` half - Controls' `.navigate-*` bindings, and the browser's own
 * defaults - and cannot see the pointer half at all.
 */
export const PALM_CONTACT_SWALLOW_PX = PALM_RADIUS_SWALLOW_PX * 2;

/**
 * Is this pointer event a pen HOVER sample - the nib in range, off the glass?
 *
 * `buttons === 0` is the test: a pen on the glass reports at least the tip
 * bit, so zero buttons on a pen `pointermove` is the nib in the air. Read
 * from the capture-phase guard listener rather than from the session
 * handlers, because those return early for any pointer that is not the active
 * contact (`this.session.pointerId !== ev.pointerId`) and a hovering nib is
 * never the active contact by definition.
 */
export function isPenHoverEvent(
	type: string,
	pointerType: string | undefined,
	buttons: number | undefined
): boolean {
	return type === "pointermove" && pointerType === "pen" && buttons === 0;
}

/** Is the pen still near, `PEN_NEAR_TAIL_MS` after its last hover sample? */
export function penIsNear(lastHoverAt: number, at: number): boolean {
	return at - lastHoverAt < PEN_NEAR_TAIL_MS;
}

/** Is the lift recent enough that the palm is still expected on the glass? */
export function withinPalmReleaseTail(lastLiftAt: number, at: number): boolean {
	return at - lastLiftAt < PEN_RELEASE_TAIL_MS;
}

/**
 * Does this contact's reported geometry look like a slab rather than a finger?
 *
 * `PalmShield.isPalmTouch` for the pointer path. A pointer event that carries
 * no size information reports width/height 1 (the spec default), which is
 * nowhere near the threshold, so unknown geometry is judged by nothing at all
 * rather than judged wrongly - the shield's own rule ("a shield that cannot
 * see palms must not start seeing them everywhere").
 */
export function palmShapedContact(width: number | undefined, height: number | undefined): boolean {
	return Math.max(width ?? 0, height ?? 0) >= PALM_CONTACT_SWALLOW_PX;
}

/**
 * Should this `contextmenu` be suppressed?
 *
 * `InlinePenRouter.contextMenuSuppressed` (~475) in this surface's terms, and
 * deliberately the same shape: suppress while a claimed gesture owns the
 * moment, when the event is itself pen-sourced (Chromium >=115 delivers
 * `contextmenu` as a PointerEvent), or while a pen is writing or hovering -
 * because a side-button press while merely HOVERING raises the menu with no
 * contact for anything to claim. A reader with no pen in the room keeps the
 * deck's ordinary right-click, which is why this is a predicate and not a
 * blanket `preventDefault`.
 *
 * The mouse needs no carve-out here that the note surface needed: there,
 * `penNear` is fed by mouse hover moves in mouse-ink mode, so an ordinary
 * right-click after moving the mouse read as "pen near" and ate the menu. This
 * file's `penNear` is fed by `isPenHoverEvent`, which requires
 * `pointerType === "pen"`, so a mouse can never set it. A mouse right-click
 * during the mouse's OWN live stroke is suppressed, and that is the same
 * answer the note surface gives.
 */
export function suppressDeckContextMenu(opts: {
	penDown: boolean;
	strokeLive: boolean;
	penNear: boolean;
	pointerType: string | undefined;
}): boolean {
	if (opts.strokeLive || opts.penDown) return true;
	if (opts.pointerType === "pen") return true;
	return opts.penNear;
}

/**
 * Should this event be swallowed because a pen owns the contact?
 *
 * The whole of Alan's ruling as one pure predicate, in two rules that stack:
 *
 * - The PALM rule (`penOwnsGlass`): from the instant a pen claims the glass,
 *   promoted or not, every touch-shaped event is swallowed. A resting palm
 *   cannot swipe the deck, tap a control or start a second gesture while its
 *   hand is writing. Pen and mouse are never touched by this rule, so a
 *   pointerdown of theirs still bubbles and the deck keeps its focus (S4).
 *
 *   The parameter used to be `penDown` and this comment used to end "with no
 *   pen down nothing changes at all: a finger alone still swipes". AMENDED
 *   2026-09-05: the first clause was too narrow and the second is now only
 *   half true. `penOwnsGlass` is pen-down OR pen-near OR inside the release
 *   tail (`penIsNear`, `withinPalmReleaseTail`), because a palm plants a beat
 *   before the nib lands and lingers a beat after it lifts. The deliberate
 *   part survives unchanged and is still the point: a FINGER, with no pen
 *   anywhere near the glass, still swipes the deck - touch navigation is
 *   Reveal's on purpose. What no longer swipes is a palm-SHAPED contact, and
 *   that rule is `palmShapedContact`, deliberately kept OUT of this predicate
 *   so the shape question and the proximity question stay separable.
 *
 * - The STROKE rule (`strokeLive`): `strokeLive` is false for the entire life
 *   of a tap, so a pen tap's click reaches `.navigate-right` and
 *   `.slides-close-btn` exactly as a mouse click does; it is true from the
 *   moment a contact crosses the slop or the clock until one tick past the
 *   lift, so nothing a drawing hand produces can turn the page.
 *
 * There is no target whitelist in either: a whitelist would have to name every
 * control Reveal ever adds.
 *
 * `pointerType` is `undefined` for every event that is not a PointerEvent -
 * `click` and the `touch*` three - which is why the palm rule reads the event
 * NAME as well: a `touchmove` is touch whatever it fails to say about itself.
 */
export function swallowDuringPenContact(
	penOwnsGlass: boolean,
	strokeLive: boolean,
	type: string,
	pointerType: string | undefined
): boolean {
	if (penOwnsGlass && PEN_CONTACT_GUARDED_EVENTS.includes(type)) {
		if (pointerType === "touch" || type.startsWith("touch")) return true;
	}
	if (!strokeLive) return false;
	return PEN_GUARDED_EVENTS.includes(type);
}

// ---- claim (mouse ink, roadmap: mouse input) -------------------------------

/**
 * Should this pointer contact be claimed as a slides-ink gesture?
 *
 * Bug: "slides dont work with mouse ink" (Alan, Paladin, mouse-only,
 * 2026-09-05) - this used to be pen-only (`pointerType === "pen"`), so
 * turning on mouse-ink mode (`MouseInk.ts`, roadmap: mouse input) had no
 * effect here even though the editor surface already honoured it.
 *
 * Pen: any contact, primary or not - Windows reports a pen as not primary
 * whenever a second mouse is live beside it. Reveal's touch plugin ignores pens
 * outright (S6, top of file), so claiming one never costs the deck a
 * navigation gesture. Mouse: only while mouse-ink mode is on AND the LEFT
 * button is down - the same two-part test `InlinePenRouter.mouseActsAsPen`
 * plus its pointerdown call sites' `buttons&1` guard apply for the editor
 * (InlinePenRouter.ts ~1284 and ~1454), restated here rather than imported so
 * this file does not have to pull in the router's whole input stack (see the
 * comment on `eraserIntent`, below, for why that matters). Right and middle
 * stay native even with mouse ink on: there is no lasso on slides for a side
 * button to reach for, so those two are simply left alone, same as the
 * editor leaves them to the context menu. Touch is never claimed, mode or
 * not - Reveal's swipe is touch's only navigation path and this file has no
 * reason to take it from it.
 */
export function claimsContact(
	pointerType: string,
	isPrimary: boolean,
	buttons: number,
	mouseInk: boolean
): boolean {
	if (pointerType === "pen") return true;
	if (pointerType === "mouse") return mouseInk && (buttons & 1) !== 0;
	return false;
}

// ---- eraser (§3.7, item B1) ------------------------------------------------

/**
 * Same eraser test InlinePenRouter uses to classify a pen contact
 * (`kind = buttons&32 || button===5 ? "eraser" : (buttons&2)!==0 ? "side" :
 * "tip"`, InlinePenRouter.ts): `buttons&32` and `button===5` are two
 * browsers' different ways of reporting the SAME thing, the stylus's tail
 * eraser end touching the surface, not two separate gestures. The barrel
 * (side) button is InlinePenRouter's OTHER arm, `buttons&2`, mapped there to
 * lasso/move - slides ink has no lasso yet, so a held barrel button falls
 * through to the tip here exactly as it does nowhere else in this file.
 */
export function isEraserContact(buttons: number, button: number): boolean {
	return (buttons & 32) !== 0 || button === 5;
}

/**
 * The mouse's share of the erase-or-ink split, once mouse ink can reach the
 * deck at all (roadmap: mouse input): a mouse has no tail end for
 * `isEraserContact` to read, so without a mode there is no way for a mouse
 * contact to mean erase. `InlinePenRouter.ts`'s `bandEraserIntent` (~106)
 * makes the identical call for a mouse contact on the linked-mentions band -
 * `eraserMode && mouseInk && (buttons & 1) !== 0` - and this restates that
 * one line rather than importing it: `InlinePenRouter.ts` pulls in the whole
 * editor input stack (eighteen imports - Telemetry, PalmGate, PointerRouter,
 * ZoomScale, PenProbe and thirteen more), where today `src/slides` depends on
 * nothing heavier than `src/ink`, `src/model`, and the DOM-free
 * `src/inline` leaves (`GuardStyle.ts`, and now `MouseInk.ts`/`TipMode.ts`);
 * reaching into the router for one pure function would drag all eighteen
 * into the slides bundle for free and silently, since it still compiles and
 * the gate stays green either way. `bandEraserIntent` is also not free to
 * extract to somewhere shared: `InkOverlay.ts` imports it AND
 * `BandEraser.test.ts` imports it by name from `InlinePenRouter.ts`, so
 * moving it touches two files this brief has no business touching. Pinned
 * instead: `SlidesInkSurface.test.ts` copies `BandEraser.test.ts`'s own
 * vectors verbatim onto this function - BOTH arms now, not just the mouse's -
 * so the two rules cannot drift apart without turning a test red on one side
 * or the other.
 *
 * AMENDED: that whole eighteen-import argument used to be given for the PEN
 * arm as well, which restated `eraserEnd || eraserMode` inline. It was never
 * true of the pen arm. Pen-contact arbitration already has one shared
 * implementation - `penContactIntent` in `TipMode.ts`, a DOM-free leaf this
 * file ALREADY imports for `tipMode()` - so calling it costs no imports at
 * all, let alone eighteen, and the note and pdf surfaces both go through it.
 * The pen arm calls it now. Only the mouse arm is genuinely restated, and
 * only because `bandEraserIntent` is where its one line lives.
 *
 * The pen arm asks `penContactIntent` for "erase", which is `eraserEnd ||
 * mode === "eraser"`, deliberately identical to the
 * router's. It used to be the tail end alone, and that divergence was
 * documented here as intentional; Alan overruled it ("slides needs to be
 * able to be erased with eraser end", "with a pen", "it should work
 * seamlessly", 2026-09-05). The mode arm is not a convenience: it is the only
 * way a pen with NO tail eraser can erase on a slide at all, and remote
 * desktop drops the eraser-end flag even for pens that have one, so without
 * it those pens could ink on a deck and never take anything back off it.
 *
 * `penContactIntent`'s other answers do not change this one: it takes a
 * `TipMode` rather than a boolean, and the only mode this arm has to hand is
 * "is the eraser mode on", so a pen contact with the mode off asks it as
 * "nib". Everything that answer can be other than "erase" - a held barrel
 * button is "lasso" there - is not "erase" here and falls through to the tip,
 * exactly as the restated line left it, because there is no lasso on a slide
 * for the barrel button to reach for.
 */
export function eraserIntent(
	pointerType: string,
	buttons: number,
	button: number,
	eraserMode: boolean,
	mouseInk: boolean
): boolean {
	if (pointerType === "pen")
		return penContactIntent(buttons, button, eraserMode ? "eraser" : "nib") === "erase";
	if (pointerType === "mouse") return eraserMode && mouseInk && (buttons & 1) !== 0;
	return false;
}

/** The eraser ring, in the slide's own deck-logical units. */
export interface SlideEraseCircle {
	x: number;
	y: number;
	r: number;
}

/**
 * The eraser ring at a screen point, mapped into deck-logical units.
 *
 * The centre goes through the same `mapScreenToSlide` every ink sample uses,
 * and the radius is divided by the same `k` (screen px stay a constant
 * physical size on the glass at any zoom, exactly like the inline eraser's
 * `visualToNote`), so the ring lines up with the ink under the nib whatever
 * the deck's current scale.
 *
 * One function, because the hit test and the PARTIAL cut have to use the SAME
 * ring: a circle computed twice from two spellings of the mapping is exactly
 * how a stroke gets reported as hit and then cut with a ring that missed it.
 */
export function slideEraseCircle(
	clientX: number,
	clientY: number,
	rect: ScreenRect,
	layoutWidth: number,
	radiusPx: number
): SlideEraseCircle {
	const k = slideScale(rect, layoutWidth);
	const center = mapScreenToSlide(clientX, clientY, rect, layoutWidth);
	return { x: center.x, y: center.y, r: k > 0 ? radiusPx / k : radiusPx };
}

/**
 * Ids of the strokes an eraser circle at a screen point touches, in the
 * slide's own deck-logical space. The hit test itself is `Eraser.ts`'s,
 * unchanged - stroke-level, and coarse on purpose: it is the bbox-then-segment
 * gate that BOTH erase branches start from.
 */
export function eraserHitsInSlide(
	strokes: readonly InkStroke[],
	clientX: number,
	clientY: number,
	rect: ScreenRect,
	layoutWidth: number,
	radiusPx: number
): string[] {
	const c = slideEraseCircle(clientX, clientY, rect, layoutWidth, radiusPx);
	return strokesHitByCircle(strokes, c.x, c.y, c.r);
}

/**
 * The PARTIAL erase pass over one slide's strokes: the note surface's rule
 * (`InkOverlay.eraseAt`'s second branch) restated in deck-logical units.
 *
 * Every hit stroke is replaced, AT ITS OWN INDEX, by whatever `Eraser.ts`
 * leaves of it - which is what holds z-order, so erasing through the middle of
 * a line under a highlighter does not bring the halves back on top of it.
 * `splitStrokeByCircle` spreads the original, so each piece keeps the stroke's
 * `page`, i.e. its slide, along with its tool, colour and width; only the id
 * and the geometry are new.
 *
 * A result of exactly ONE piece that is the SAME OBJECT means the ring never
 * crossed the line - the stroke was hit by the coarse bbox-then-segment gate
 * and nothing more - so it goes back untouched and is not counted. That is not
 * an optimisation: counting it would make an eraser pass NEAR ink report a
 * change, repaint, and persist a save for ink nobody altered.
 *
 * `touched` is the number of ORIGINAL strokes actually cut or consumed, which
 * is what the gesture's log line and its one save at lift are gated on.
 */
export function partialEraseInSlide(
	list: readonly InkStroke[],
	hits: readonly string[],
	circle: SlideEraseCircle,
	makeId: () => string
): { strokes: InkStroke[]; touched: number } {
	const hitSet = new Set(hits);
	const out: InkStroke[] = [];
	let touched = 0;
	for (const s of list) {
		if (!hitSet.has(s.id)) {
			out.push(s);
			continue;
		}
		const pieces = splitStrokeByCircle(s, circle.x, circle.y, circle.r, makeId);
		if (pieces.length === 1 && pieces[0] === s) {
			out.push(s);
			continue;
		}
		touched++;
		for (const p of pieces) out.push(p);
	}
	return { strokes: out, touched };
}
