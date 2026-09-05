/**
 * The surface matrix, executed.
 *
 * Seven times in the 1.4.x cycle a ruling reached one ink surface and not
 * another. The surfaces ground-truth section of `1.4.9-design.md` writes that
 * down as a table of rules against surfaces - cited by title because that
 * doc's numbering has collided twice from parallel appends, and the section
 * this used to call §15 is a different one now - and a table in a document is
 * the same material as the two comments
 * that hid the two most expensive bugs of this cycle: the collapsed pill's,
 * which said `setIcon` replaces children when it appends, and the Pen spec's,
 * which said `isLit` "only diverges for a mouse-without-a-pen user" when it had
 * never worked for anybody. Both were believed for releases. Neither was ever
 * run. This file is the same table wired to `INK_SURFACES` (InkSurfaces.ts) so
 * that it runs, and so that a fifth surface fails the suite the day it is added
 * rather than the day someone remembers the table exists.
 *
 * WHAT THIS CAN ANSWER
 *   - is a rule's marker present in every surface that is supposed to carry it
 *   - has somebody ruled, in writing, on every surface a rule does NOT apply
 *     to - adding a surface, or a rule, leaves a hole that fails here
 *   - do the registry's own columns match the tree: the file exists, the
 *     router family is the one it actually constructs, a surface that claims
 *     to mount a strip mentions one
 *   - do note and pdf still each wire every `InlinePenRouter` callback BOTH
 *     surfaces owe an answer to, which is the duplication surface every one of
 *     the divergences happened on. That set is not the same as the type's
 *     required members: the interface declares ten, three of them optional,
 *     and two of those three are note-only while the third
 *     (`onStrokeAbandoned?`) is owed by both - see INLINE_PEN_CALLBACKS
 *     (InkSurfaces.ts)
 *
 * WHAT THIS CANNOT ANSWER
 *   - whether the rule is CORRECT where it is present. `markPenSeen` was in
 *     both surfaces through all three releases in which the nib light was
 *     dead; a marker check would have been green the whole time. It is a
 *     presence test and nothing more.
 *   - whether the rule is reached. A call behind a condition that is never
 *     true, in a method nothing invokes, or after an early return, counts
 *     here exactly as a live one does.
 *   - whether two surfaces that both carry a marker AGREE, in general. The
 *     hover sites were the live example - the note raised the strip for any
 *     hover with mouse ink armed and the pdf refused unless the pointer was a
 *     pen - and the way that ended is instructive: not by a guard noticing,
 *     but by Alan ruling. See "THE HOVER DIVERGENCE" below. What the guard
 *     can do now is hold them to the ruling, because both read one predicate.
 *
 *     One shape of disagreement IS caught now, because it is the one that
 *     cost us the eighth divergence: a surface that claims strip VISIBILITY
 *     without ever claiming pen HARDWARE. That was invisible to the row
 *     below on the day this file was written - its markers were an OR over
 *     `markPenSeen(` and `markPenHardwareSeen(`, both files contained the
 *     first, and the row read yes|yes while the two surfaces called
 *     different functions. The OR is split and the pairing is asserted.
 *   - anything about a rule with no marker. A rule that is a shape rather
 *     than a symbol - an ordering, a coordinate convention, a guard placed
 *     before rather than after an early return - is invisible to a text scan
 *     and needs a behavioural test or a reader.
 *   - anything about the canvas or the pen lab beyond what is asserted. Both
 *     are mostly exemptions here, and an exemption is a claim that a rule does
 *     not apply, never a claim that the surface is right.
 *
 * The honest summary: this catches a rule that reached one surface and not
 * another, which is the defect that keeps happening. It does not catch a rule
 * that reached both surfaces and is wrong on both.
 *
 * Source text via `import.meta.glob` + `?raw`, the same mechanism
 * `StripPenChrome.test.ts` uses and for the same reason its header gives: this
 * repo has no `@types/node`, so `fs.readFileSync` fails `tsc -noEmit`.
 */

import { describe, expect, it } from "vitest";
import { codeOnly } from "../CodeOnly";
import { INK_SURFACES, INLINE_PEN_CALLBACKS, type InkSurfaceId } from "./InkSurfaces";

const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

/**
 * `codeOnly` moved to `src/CodeOnly.ts` and is imported above.
 *
 * It was defined here, and `StripPenChrome.test.ts` - built for the same
 * defect class, scanning the same tree - had no equivalent, so only one of the
 * two guards could not be satisfied by a comment. Copying it across would have
 * left two implementations of one rule free to diverge, which is the shape
 * these guards exist to catch. The reasoning that used to sit here, including
 * why string literals are deliberately not blanked, moved with it.
 *
 * The four fixture tests at the bottom of this file stayed. They now pin the
 * shared function, so a change made for one guard's benefit that broke the
 * other still fails here.
 */

/** A file's raw text, empty if it is not in the scan. */
function surfaceRaw(file: string): string {
	return ALL_TS[file] ?? "";
}
/** A surface's text, comments blanked. Throws on a rename rather than passing vacuously. */
function surfaceText(file: string): string {
	const text = ALL_TS[file];
	if (text === undefined) throw new Error(`ink surface file not in the source scan: ${file}`);
	return codeOnly(text);
}

const ALL_IDS = INK_SURFACES.map((s) => s.id);

/**
 * One row of the matrix.
 *
 * `markers` is an OR: some rules are carried by a different symbol on each
 * surface (the keyboard claim is `focusClaimedPenEditor` on a note, whose
 * surface is an editor, and `stripPenFocus` on a pdf, whose surface is not),
 * and forcing one spelling would either be a lie or a refactor this file has
 * no business demanding.
 *
 * `exempt` is the load-bearing half. Every surface not in `on` must appear
 * here with a reason, and the reason is prose for a human - the test only
 * checks that somebody wrote one. A rule with a surface in neither list fails,
 * which is what makes adding surface number five a decision rather than an
 * omission.
 */
interface SurfaceRule {
	readonly rule: string;
	readonly markers: readonly string[];
	readonly on: readonly InkSurfaceId[];
	readonly exempt: Partial<Record<InkSurfaceId, string>>;
}

const RULES: readonly SurfaceRule[] = [
	{
		// THE TENTH one-surface divergence, and the first this registry was
		// standing when it was found rather than after. Alan hit it by hand on
		// 2026-09-03 running checklist item 5: hold the side button, touch a
		// PDF, and the eraser erases while its ring disappears - you are
		// erasing blind. Note and canvas both drive the ring through the
		// stroke; the pdf drove it on HOVER only, so its own 1000ms watchdog
		// took it away the moment the pen was down.
		//
		// Not a 1.4.9 regression. `git log -S showEraserCursor` on the pdf
		// file is EMPTY - it never had it - and the note got it in d862eec,
		// whose message says "on the inline surface" out loud. It shipped that
		// way from v0.11.0 and nobody wrote it down.
		//
		// The marker is the reason the pdf grew a two-line named wrapper. Its
		// ring is drawn by `showCursor`, which is in that file for hover
		// whether or not the erase path touches it - so a marker of
		// `showCursor(` would have passed green for the entire life of this
		// defect, which is the failure mode this whole registry exists to
		// refuse. `showEraserCursor(` is present only because the erase path
		// drives the ring on that surface.
		//
		// THE MARKER ITSELF WAS VACUOUS, and stayed that way through the row
		// above being written. `showEraserCursor(` matches the wrapper's own
		// DECLARATION - `private showEraserCursor(sample: PenSample): void {`
		// - on all three surfaces, so deleting every CALL to it and leaving
		// the empty method declared still satisfied this row: the exact
		// failure mode the header three paragraphs up says this registry
		// exists to refuse, reproduced inside the row built to refuse it.
		// `this.showEraserCursor(` is the fix - every call site on note, pdf
		// and canvas is written that way (checked: `grep -n
		// "showEraserCursor(" src/inline/InkOverlay.ts src/pdf/
		// PdfInkController.ts src/view/HandwritingPageView.ts`, all six call
		// sites carry the `this.` prefix and none of the three declarations
		// do) - and it cannot match a declaration, because a method never
		// calls itself through `this.` in its own signature. Mutation-
		// verified below the same way d2b6f4a verified the original: deleting
		// every `this.showEraserCursor(` call on the pdf while leaving the
		// method declared fails this row now, where it used to pass.
		rule: "an erasing surface shows what the eraser is about to take",
		markers: ["this.showEraserCursor("],
		on: ["note", "pdf", "canvas"],
		exempt: {
			penlab:
				"has no eraser at all - its own header: \"No file, no persistence, no text, no eraser\". It is a probe for the stroke pipeline",
			demo: "ships on the website, not in the plugin. One tool, no modes and no eraser, so there is nothing to show the reach of",
		},
	},
	{
		// COMPANION to the row above, not a widening of it in place - eraser's
		// exemptions (canvas ON, penlab/demo exempt) are not this rule's
		// exemptions (canvas itself is exempt here; see its reason). Folding
		// the two into one row with a wider `on` would have put canvas back
		// into the "no ruling" hole this whole file exists to close, since
		// canvas carries an eraser reticle but not a lasso one.
		//
		// Three of these rows exist (lasso, pan, space) rather than one with
		// all three markers OR'd together, on purpose: an OR lets a surface
		// that implements only ONE of the three modes' reticles satisfy the
		// row for all three, which is exactly the "too narrow" gap Alan's
		// brief named - three gestures (space, lasso, pan) were left behind
		// on the pdf while only the eraser's row existed to catch anything.
		// One row per mode means a surface has to earn each one.
		//
		// UPDATED, 1.4.9: the note grew the same named-wrapper idiom as the
		// pdf, closing the note-side half of the defect 2127ed6 left NOTED,
		// NOT FIXED ("onPenHover stops firing once a contact is claimed, so
		// the NOTE surface's reticle likely goes stale through its own
		// lasso, pan and space gestures for the same reason").
		//
		// Before this, the note's only marker was `.add(LASSO_CURSOR_CLASS)`
		// - true only because `showPenCursor`'s existing lasso branch,
		// reached from HOVER alone, contains it, so the marker stayed green
		// whether or not the note's gesture methods (lassoDown, lassoMove,
		// lassoUp) ever called through to it. That is the same vacuousness
		// the eraser row's own history two rows up warns about, sitting
		// quietly in the row meant to refuse it: the note was carrying this
		// rule for the wrong reason for as long as the row has existed,
		// because the marker described the LOOK rather than the CALL.
		//
		// `this.showLassoCursor(` is the fix here too, and it is now the
		// ONLY marker: a real call site on both surfaces (lassoDown, the
		// raw-batch handler and pen-up, on each), never the wrapper's own
		// declaration - `private showLassoCursor(sample: PenSample): void {`
		// carries no `this.` - because a method never calls itself through
		// `this.` in its own signature. Deleting the note's three call
		// sites while leaving the method declared fails this row now, where
		// the old marker would not have.
		rule: "a lasso surface shows what the tip is about to select",
		markers: ["this.showLassoCursor("],
		on: ["note", "pdf"],
		exempt: {
			canvas:
				"has a lasso TOOL (`type Tool` includes it) but no general pen-hover reticle for any tool to give a look to - the only reticle element canvas builds is `eraserEl` (`showEraserCursor`/`hideEraserCursor`), a plain circle used for the eraser alone. A lasso gesture's only on-screen feedback is the loop itself (`tail.drawLasso`), not a mark under the tip before it starts",
			penlab:
				"no lasso and no selection of any kind - its own header: \"No file, no persistence, no text, no eraser\". It is a probe for the stroke pipeline",
			demo: "no TipMode on the site - one tool, chosen by its own buttons, and no eraser, lasso, pan or space",
		},
	},
	{
		// See the lasso row above for why this dropped `.add(PAN_CURSOR_CLASS)`
		// in 1.4.9: the note now carries `this.showPanCursor(` as a real call
		// site (the pan branch in penDown, penRaw's pan branch, and penUp's
		// pan branch), and the class marker was true from hover alone -
		// proving nothing about whether the gesture itself called through.
		rule: "a pan surface shows that the tip is panning, not marking",
		markers: ["this.showPanCursor("],
		on: ["note", "pdf"],
		exempt: {
			canvas:
				"no pan MODE at all to hold a reticle for - panning here is a transient gesture (two-finger drag), not a tip state, and `type Tool` has no pan member. The row above's canvas reason (no general reticle) would also apply, but this is the more specific one: there is no mode to show in the first place",
			penlab: "no tip mode; the lab draws with a fixed nib on purpose",
			demo: "no TipMode on the site - one tool, chosen by its own buttons, and no eraser, lasso, pan or space",
		},
	},
	{
		// See the lasso row above: the note now carries `this.showSpaceCursor(`
		// as a real call site (spaceDown, penRaw's space branch, and penUp's
		// space branch), so `.add(SPACE_CURSOR_CLASS)` dropped for the same
		// reason the other two did.
		rule: "an insert-space surface shows the seam the tip is about to cut",
		markers: ["this.showSpaceCursor("],
		on: ["note", "pdf"],
		exempt: {
			canvas:
				"no insert-space mode - a canvas page is fixed size and nothing here moves rows to make room for ink, and `type Tool` has no space member",
			penlab: "no tip mode; the lab draws with a fixed nib on purpose",
			demo: "no TipMode on the site - one tool, chosen by its own buttons, and no eraser, lasso, pan or space",
		},
	},
	{
		// THE TWELFTH one-surface divergence, and the third this registry was
		// standing for. a7eba85 taught the pdf that the reticle watchdog is a
		// PEN's guard and not a mouse's: a mouse cannot leave hover range
		// without sending pointerleave, so the timer protects it against
		// nothing, and firing it took the ring away from anyone who paused for
		// a second - at hover, and mid-drag, where hiding the ring also drops
		// `cursor: none` while the button is still down (alan, hardware,
		// 2026-09-04, mouse ink armed). The note surface, which has the same
		// watchdog and the same three in-gesture wrappers that pass no
		// pointerType, was left with no exemption at all.
		//
		// The marker is the PREDICATE rather than the name `mousePointer`,
		// which would be satisfied by a `const` nobody read - the same vacuity
		// the eraser row above had to be rewritten to escape. Both halves are
		// in it on purpose: an explicit "mouse" is exempt, and a caller that
		// says nothing is answered by what pen-down wrote down, which is the
		// half the in-gesture wrappers need and the half that was missing.
		rule: "the reticle watchdog is the pen's guard, and a mouse is exempt from it",
		markers: ['pointerType === "mouse" || (pointerType === undefined && this.mouseStroke)'],
		on: ["note", "pdf"],
		exempt: {
			canvas:
				"has no pen-hover reticle for a watchdog to guard, and no watchdog: the only reticle element it builds is `eraserEl` (a plain circle, shown and hidden by the erase gesture itself at `showEraserCursor`/`hideEraserCursor`), so nothing here is ever left on screen by a hover sample that stopped arriving",
			penlab:
				"draws no reticle of any kind - its own header: \"No file, no persistence, no text, no eraser\". It is a probe for the stroke pipeline, and a probe with a fixed nib has no ring to strand",
			demo: "no reticle on the site: one tool chosen by its own buttons, no hover mark under the pointer, and so no timer that could take one away",
		},
	},
	{
		rule: "pen-contact arbitration is shared, not re-implemented",
		markers: ["penContactIntent("],
		on: ["note", "pdf"],
		exempt: {
			canvas:
				"no tip mode at all - its own `type Tool` has no `pan` member and it pans by transient gesture, so there is nothing here to arbitrate",
			penlab: "not user-reachable, and no tip mode; it is a probe for the stroke pipeline",
			demo: "ships on the website, not in the plugin. One tool, no modes and no eraser, so there is no contact to arbitrate",
		},
	},
	{
		rule: "the strip steps aside at pen contact",
		markers: ["stripPenDown("],
		on: ["note", "pdf"],
		exempt: {
			canvas: "constructs no MobileTools strip",
			penlab: "constructs no MobileTools strip",
			demo: "constructs no MobileTools strip - the site has no plugin chrome at all",
		},
	},
	{
		rule: "the strip returns at pen lift",
		markers: ["stripPenUp("],
		on: ["note", "pdf"],
		exempt: {
			canvas: "constructs no MobileTools strip",
			penlab: "constructs no MobileTools strip",
			demo: "constructs no MobileTools strip - the site has no plugin chrome at all",
		},
	},
	{
		// THE ELEVENTH one-surface divergence, and the second this registry
		// was standing for - the row below the watchdog's in the file and the
		// one BEFORE it in the count, which is how they came to share a
		// number. The note surface learned in `7c95c39` that a pane which
		// shows a different document in place has to tell its router:
		// Obsidian REUSES the editor and the pdf pane alike, so the router
		// survives the switch still holding whatever gesture was in flight,
		// and a pen contact whose lift was lost across it (a finger resting on
		// the glass) leaves `activePenId` set forever - which keeps
		// armOwnership's window click-suppressor armed forever, which eats
		// every future pen tap on the strip. `f5f2333` then added the chrome
		// half on the same surface.
		//
		// `git log -S abandonActiveStroke src/pdf/PdfInkController.ts` was
		// EMPTY: the pdf never had either half, on the same router, reached by
		// the same main.ts file-change sweep (`forgetHistory`). Same shape as
		// the eraser ring above - not a regression, a rule that only ever
		// reached one of the two surfaces and was never written down.
		rule: "a pane that changes document in place abandons the router's stroke",
		markers: ["abandonActiveStroke("],
		on: ["note", "pdf"],
		exempt: {
			canvas:
				"a whole-surface view on PointerRouter, which has no abandonActiveStroke: its leaf is not reused for a different document under a live gesture",
			penlab:
				"not user-reachable and shows no document, so there is no in-place file switch to strand a contact across",
			demo: "ships on the website with no router and one document; nothing swaps out from under a stroke",
		},
	},
	{
		rule: "the keyboard follows a claimed pen",
		markers: ["focusClaimedPenEditor(", "stripPenFocus("],
		on: ["note", "pdf"],
		exempt: {
			canvas:
				"its router does not preventDefault the mousedown that focuses a pane, so nothing has to be given back",
			penlab: "not user-reachable; no keys are bound to it",
			demo: "no editor and no pane focus to claim; the site is a canvas on a static page",
		},
	},
	{
		// NOT an OR with `markPenHardwareSeen(` any more, and the split is the
		// whole point. This row was written as one, and because both surfaces
		// contained `markPenSeen(` it read yes|yes on a tree where the note
		// claimed pen hardware and the pdf did not - the eighth divergence,
		// green in the guard built to catch it. Two questions, two rows.
		rule: "marks the pen seen, so the strip can appear",
		markers: ["markPenSeen("],
		on: ["note", "pdf"],
		exempt: {
			canvas: "the strip is not mounted here, so there is no visibility question to answer",
			penlab: "the strip is not mounted here, and nothing opens it",
			demo: "no strip to reveal, and no session-scoped pen state on the site",
		},
	},
	{
		// The other half. `nibIsLit` (MobileTools.ts) reads `penHardwareSeen()`
		// as of `cff850d`, and both strip-mounting surfaces build their nib
		// buttons from the same `isLit: (h) => nibIsLit(h, tool)` specs - so a
		// surface that mounts a strip and never claims hardware ships buttons
		// that cannot light for a pen user. That is what the pdf did between
		// `cff850d` and `77454fc`.
		rule: "claims pen HARDWARE, which is not the same claim as visibility",
		markers: ["markPenHardwareSeen("],
		on: ["note", "pdf"],
		exempt: {
			canvas:
				"mounts no strip, so it builds no nib button and has no light for a hardware answer to feed",
			penlab:
				"mounts no strip and nothing opens it; its fixed nib is the instrument, not a tool the user picks",
			demo: "no strip lights to drive; nothing on the site changes when a pen is present",
		},
	},
	{
		rule: "the pen-seen claim is gated on the pointer type",
		markers: ['pointerType === "pen"'],
		on: ["note", "pdf"],
		exempt: {
			canvas: "marks no pen seen - see the row above",
			penlab: "marks no pen seen - see the row above",
			demo: "reads `e.pointerType` at pen-down for the mouse device mark, but has no pen-seen claim to gate",
		},
	},
	{
		// NEW, and it exists because the divergence it covers was RULED
		// rather than discovered. Until 2026-09-03 the note raised the strip
		// for any hover that could ink and the pdf refused unless the pointer
		// was a pen (1.4.6-design.md 5m/AF5); both were deliberate, both were
		// written down, and this file's header said in so many words that it
		// must not pick a winner. Alan picked one - "with mouse ink armed,
		// yes a hovering mouse should bring toolbar out" - so the surfaces
		// must agree, and the way they agree is by reading one predicate
		// instead of each spelling the condition out.
		rule: "the strip rises for any pointer that can ink, through one shared predicate",
		markers: ["pointerRaisesPenTools("],
		on: ["note", "pdf"],
		exempt: {
			canvas: "mounts no strip, so there is no toolbar for a hovering pointer to raise",
			penlab: "mounts no strip and nothing opens it; no toolbar to raise here either",
			// Read out of DemoInk.ts rather than assumed from "it's the demo",
			// which is a category and not a mechanism.
			demo: "MECHANICAL, twice over. It has no hover path to gate: it binds pointerdown/move/up/cancel and nothing else, and `move()` returns on its first line unless the pointer is the captured, actively-drawing one - so a hovering pen or mouse is dropped before its type is ever read. And the predicate cannot reach here: `pointerRaisesPenTools` lives in PenToolsMode.ts, which is not in the site bundle - build-site.mjs bundles src/site/DemoInk.ts as the sole entry point and that import graph is camera/coordinates plus src/ink only. Importing it would drag PenToolsMode's module-level mode and penSeen, and MouseInk behind them, into a static page with no settings layer to source either from",
		},
	},
	{
		// The row that goes red on a real, live regression - just not on this
		// branch. Alan ruled on 2026-09-03 that a mouse-only user's way to the
		// toolbar is "the command palette, or the settings menu", which makes
		// both of them load-bearing rather than convenient: a surface that
		// cannot HEAR a Pen-toolbar change has no way in at all for anyone
		// without a pen, and no fallback, because the control that arms mouse
		// ink is a button on the strip they cannot get.
		//
		// The note surface hears through `refreshPenToolsAll` and the pdf
		// through this subscription, so the two mechanisms are genuinely
		// different and this row cannot demand one symbol on both. What it can
		// do is pin the half that is easy to lose - and that half HAS been
		// lost: `d0ee549` added it for 1.4.8 after "Pen toolbar → Hide" left
		// the strip on every PDF (alan, 2026-09-02), and the 1.5.0 line does
		// not carry it. That branch's `PdfInkController` imports `markPenSeen`
		// and nothing else, never calls `penToolsVisible`, and its
		// `ensureTools` is `if (this.tools) return;` in front of a build - so
		// the setting is inert on a PDF in both directions and no number of
		// palette presses can produce a strip there.
		rule: "hears a Pen-toolbar change that no pointer caused",
		markers: ["onPenToolsChanged("],
		on: ["pdf"],
		exempt: {
			note: "it owns the OTHER mechanism rather than lacking this one: `instances` and `refreshPenToolsAll` both live in InkOverlay.ts, and every call site in main.ts that moves the mode calls the fan-out on the next line. Subscribing here as well would refresh every open note twice per change",
			canvas:
				"mounts no MobileTools strip, so a Pen-toolbar change has nothing on this surface to create or destroy",
			penlab: "mounts no strip and nothing opens it; there is no toolbar here to show or hide",
			// Also read out of the file. The demo's tool buttons are static
			// markup in docs/index.html, found by `boot()` through
			// `[data-tool]` and never shown or hidden by anything.
			demo: "there is no Pen-toolbar mode on the site to hear a change to. The only things that announce one are `setPenToolsMode` and `markPenSeen` (PenToolsMode.ts), both plugin-settings paths, and the site has neither a settings layer nor a plugin instance. The subscription would also be unhonourable here: it returns an unsubscribe a surface MUST call at teardown, and the demo has no teardown at all - `boot()` runs once per page load, adds its listeners and removes none, and InkDemo lives until the page unloads",
		},
	},
	{
		rule: "reads the tip mode",
		markers: ["tipMode()"],
		on: ["note", "pdf"],
		exempt: {
			canvas: "no tip mode - `type Tool` has no `pan` member; it pans by transient gesture",
			penlab: "no tip mode; the lab draws with a fixed nib on purpose",
			demo: "no TipMode on the site - one tool, chosen by its own buttons, and no eraser, lasso, pan or space",
		},
	},
	{
		rule: "honours the mouse-ink setting",
		markers: ["mouseInkEnabled("],
		on: ["note", "pdf"],
		exempt: {
			canvas:
				"Handwriting owns this whole surface, so a mouse draws here unconditionally and there is no setting to honour",
			penlab: "same as the canvas: the lab surface is ours, and a mouse is a valid input to it",
			demo: "no settings layer exists on the site, so the accessor cannot reach it; a mouse always inks here by design, which is the point of a demo",
		},
	},
	{
			// Companion to MoveRateInstrument.test.ts, not a substitute for it.
			// `beb6fbb` fixed the pdf so a stroke counts its own move events
			// (`onPenMove: () => {}` -> `onPenMove: (_ev, count) =>
			// this.metrics.recordEvent("move", count, 0, false)`), and an audit
			// found the fix UNPINNED: reverting either surface's `onPenMove`
			// back to a no-op left every existing suite green, because nothing
			// had ever driven the wiring - `StrokeMetrics.test.ts` exercises the
			// class directly, never the closure a surface registers. That gap
			// is exactly the shape this whole file exists to refuse, one rule
			// short of its own table.
			//
			// The marker is not vacuous: `recordEvent("move"` occurs exactly
			// once in each of note, pdf and canvas, at the call site itself,
			// never inside a declaration (checked: `grep -n "recordEvent(\"move\""
			// src/inline/InkOverlay.ts src/pdf/PdfInkController.ts
			// src/view/HandwritingPageView.ts` - one hit apiece). But a marker
			// is still only a presence test, per this file's own header - it
			// cannot tell a live call from a dead comment quoting it, which is
			// why note and pdf both narrate this exact fix in prose directly
			// above their call sites. `MoveRateInstrument.test.ts` is the
			// backstop that presence alone cannot be: it captures the real
			// callback object each surface hands its router and calls
			// `.onPenMove(...)` on it directly, and mutation-verifies that
			// reverting either surface to `() => {}` turns that call red.
			rule: "a surface counts its stroke's move events",
			markers: ['recordEvent("move"'],
			on: ["note", "pdf", "canvas"],
			exempt: {
				// Read out of PenLabView.ts rather than assumed: it is NOT
				// silent about move events, it just does not route them
				// through StrokeMetrics. Its own `onPenMove` callback
				// (PointerRouter, not InlinePenRouter) is `(_samples, _ev,
				// count) => { this.lastCoalesced = count; }` - a real,
				// non-vacuous assignment that its own diagnostics overlay
				// prints on the `Coalesced:` line, not a discarded value. The
				// lab never constructs a StrokeMetrics at all (grep: zero
				// hits for "StrokeMetrics" or "metrics" in this file), so it
				// carries no instance for `recordEvent("move"` to be called
				// on - the surface answers this rule's QUESTION through a
				// simpler, separate mechanism rather than failing to answer
				// it.
				penlab:
					"already counts its stroke's move events, just not through this call - its own onPenMove assigns the coalesced count to `this.lastCoalesced`, live in its own overlay's `Coalesced:` line - and it never constructs a StrokeMetrics at all (grep: zero hits in this file), so there is no instance here for `recordEvent(\"move\"` to be called on",
				// Read out of DemoInk.ts rather than assumed: no import of
				// StrokeMetrics, no construction of one, and its own pointer
				// handlers (down/move/up/cancel, wired directly on the
				// canvas - this surface has no router at all) never mention
				// metrics of any kind. There is no move-rate figure on the
				// site to go quietly wrong the way the pdf's did, because
				// there is no move-rate figure at all.
				demo: "no metrics system of any kind to fall silent in - DemoInk.ts imports no StrokeMetrics and builds none, and its own pointerdown/pointermove/pointerup/pointercancel handlers carry no diagnostics whatsoever",
			},
		},
	{
		rule: "the tap floor lives at the nib, not at the caller",
		markers: ["contactHalfWidth("],
		on: ["note", "pdf", "canvas"],
		exempt: {
			penlab:
				"the lab exists so its head and its ribbon CAN disagree - that disagreement is what it is for, and holding it to the shared floor would remove the instrument",
			demo: "MECHANICAL, not policy: the demo has no wet head layer at all - it draws through `drawStroke` only, with no `drawHead` and no TailRenderer, so there is no head to floor. A tap renders through the committed path, whose own `applyEndTaper` returns early below one nib width of travel (InkShape.ts, 'the honest shape is the nib itself'), so the thin-speck defect this rule exists to prevent is unreachable here",
		},
	},
	{
		// Another one-surface divergence, this one caught by reading source
		// rather than by a device report: the note's Escape-releases-a-
		// held-mode rule (InkOverlay.ts:1627-1637, "Landing in pan or insert
		// space used to strand you until you found the Pen button; Escape is
		// what a hand reaches for") never reached the pdf. `tipModeHeld` and
		// `releaseTipMode` had ZERO hits in PdfInkController.ts before
		// 1.4.9, so Pan or Insert-space on a pdf stranded the pen with no
		// way back but the strip - worse there than on a note, which at
		// least has this rule.
		//
		// The marker is the whole condition, not a bare `tipModeHeld()`,
		// and that is deliberate. A bare marker would be VACUOUS for the
		// note: InkOverlay.ts re-exports its own wrapper, `export function
		// tipModeHeld(): boolean { return tipModeHeldNow(); }` (:347), and
		// that empty-parens SIGNATURE contains the literal text
		// "tipModeHeld()" - so the marker would stay green on a note with
		// the Escape branch itself deleted, the exact failure this file
		// exists to refuse (checked: `grep -n "tipModeHeld("
		// src/inline/InkOverlay.ts` shows exactly two hits, the declaration
		// at :347 and the real call at :1631 - nothing else to fall back
		// on). Anchoring to the whole condition reaches only the real call
		// on both files: one hit apiece (checked the same way on
		// PdfInkController.ts - one hit, the call, at :857).
		//
		// Two spellings, not one, because the two surfaces name the release
		// differently: the note calls its own `releaseTipModes()` wrapper
		// (plural, InkOverlay.ts's own name for it), the pdf calls
		// TipMode.ts's `releaseTipMode()` directly (singular, the only
		// export that exists there). Same held state either way - `tipMode`
		// is process-global (TipMode.ts) - so the note surface's own
		// mode-release is what a pdf pane's Escape now reaches too.
		rule: "Escape hands the tip back to the nib from a held mode (pan, lasso or space)",
		markers: [
			'event.key === "Escape" && tipModeHeld()',
			'ev.key === "Escape" && tipModeHeld()',
		],
		on: ["note", "pdf"],
		exempt: {
			canvas:
				"no TipMode at all - INK_SURFACES marks it honoursTipMode: false, and its own Escape branch (HandwritingPageView.onKeyDown) only clears the lasso selection and the caret; there is no pan/lasso/space mode here for a key to hand back",
			penlab:
				"no tip mode; the lab draws with a fixed nib on purpose, and it wires no keydown listener of any kind (grep: zero hits for keydown/KeyDown/Escape in PenLabView.ts)",
			demo: "no TipMode on the site - one tool, chosen by its own buttons, and no eraser, lasso, pan or space - and it wires no keydown listener of any kind (grep: zero hits for keydown/KeyDown/Escape in DemoInk.ts)",
		},
	},
	{
		// The note's Ctrl/Cmd+C and +X rule (InkOverlay.ts:1638-1664, "that
		// is what a lasso means everywhere else") never reached the pdf
		// either - its only ctrlKey/metaKey hit before 1.4.9 was the
		// undo/redo check. Ported here reusing the CONTROLLER'S OWN
		// copy-selected-ink / cut-selected-ink command methods
		// (`copySelection`, `cutSelectionCommand` - the same methods
		// `stripExec` and the palette/hotkey commands in main.ts already
		// call) rather than a fourth dispatcher onto the clipboard -
		// main.ts carries its own audit note on exactly that mistake, next
		// to `pdfControllerWithSelection`.
		//
		// Neither `this.copySelection(` nor `this.cutSelectionCommand(`
		// will do as the marker on the pdf side: both already had a call
		// from `stripExec` (the strip button's own dispatch) before this
		// branch existed, so either one would have stayed green with the
		// new keydown branch deleted entirely - vacuous the same way a bare
		// `tipModeHeld()` would have been on the note, in the row above
		// (checked: `grep -n "this.copySelection(\|this.cutSelectionCommand("
		// src/pdf/PdfInkController.ts` shows two hits apiece, stripExec and
		// this branch). The marker instead anchors to the branch's own key
		// comparison, which exists nowhere else in either file (checked,
		// one hit apiece): the note spells its local variable `k`, the pdf
		// spells it `key` - the same two-spellings-one-rule shape as the
		// Escape row above, for the same reason.
		rule: "Ctrl/Cmd+C and +X copy or cut a live lasso selection",
		markers: ['k === "c" || k === "x"', 'key === "c" || key === "x"'],
		on: ["note", "pdf"],
		exempt: {
			canvas:
				"no TipMode and no lasso-to-clipboard path - INK_SURFACES marks it honoursTipMode: false, and its own onKeyDown (HandwritingPageView.ts) only ever branches on undo/redo, Delete/Backspace and Escape; there is no Ctrl+C/X handling of any kind to divide by selection type",
			penlab:
				'no lasso and no selection of any kind - its own header: "No file, no persistence, no text, no eraser" - and it wires no keydown listener at all (grep: zero hits for keydown/KeyDown/ctrlKey in PenLabView.ts)',
			demo: "no TipMode and no lasso on the site - one tool, chosen by its own buttons - and it wires no keydown listener at all (grep: zero hits for keydown/KeyDown/ctrlKey in DemoInk.ts)",
		},
	},
];

describe("ink surfaces - the registry describes the tree it claims to", () => {
	it.each(INK_SURFACES)("$id: its file is where it says it is", (surface) => {
		expect(surfaceText(surface.file).length).toBeGreaterThan(0);
	});

	it.each(INK_SURFACES)("$id: constructs the router family it is filed under", (surface) => {
		// Proved from the construction site rather than trusted, because the
		// router family is the fault line: `InlinePenRouter` hands the same
		// seven callbacks to two surfaces that then answer independently, and
		// `PointerRouter` does not. A surface filed under the wrong one would
		// be exempted from rules it actually needs.
		const text = surfaceText(surface.file);
		if (surface.router === "none") {
			// The demo wires pointerdown/move/up on the canvas itself. Filed
			// under no family, so the assertion inverts: it must construct
			// NEITHER, or it has quietly grown a router and its exemptions
			// below stop being true.
			expect(text, `${surface.id} constructs InlinePenRouter`).not.toContain("new InlinePenRouter(");
			expect(text, `${surface.id} constructs PointerRouter`).not.toContain("new PointerRouter(");
			return;
		}
		const other = surface.router === "InlinePenRouter" ? "PointerRouter" : "InlinePenRouter";
		expect(text, `${surface.id} does not construct ${surface.router}`).toContain(
			`new ${surface.router}(`
		);
		expect(text, `${surface.id} also constructs ${other}`).not.toContain(`new ${other}(`);
	});

	it.each(INK_SURFACES)("$id: mountsStrip matches whether it mentions MobileTools", (surface) => {
		expect(surfaceText(surface.file).includes("MobileTools")).toBe(surface.mountsStrip);
	});

	it("the glob found a source tree, not an empty one", () => {
		// A pattern that matched nothing would make every `toContain` above
		// throw and every exemption below pass - but a future edit to the glob
		// could leave a subset that still contains these four files while
		// silently dropping the rest. A floor is the cheap witness.
		expect(Object.keys(ALL_TS).length).toBeGreaterThan(100);
	});
});

describe("ink surfaces - the shared callbacks are still wired twice", () => {
	// The duplication surface itself, stated as a fact rather than a wish.
	// Every one of the divergences happened inside one of these, and this
	// assertion exists so that the day somebody collapses the two wirings
	// into one, the change is loud rather than quiet.
	//
	// The list is INLINE_PEN_CALLBACKS, and it is not simply "the required
	// members": `claimBandContact?` and `describeChrome?` are optional AND
	// note-only, so demanding them of the pdf would report a legitimately
	// surface-specific member as a divergence, while `onStrokeAbandoned?` is
	// optional and owed by both. That file carries the reason for each.
	const inline = INK_SURFACES.filter((s) => s.router === "InlinePenRouter");

	it("there are exactly two InlinePenRouter surfaces", () => {
		expect(inline.map((s) => s.id)).toEqual(["note", "pdf"]);
	});

	it.each(inline)("$id wires every shared callback itself", (surface) => {
		const text = surfaceText(surface.file);
		for (const cb of INLINE_PEN_CALLBACKS) {
			expect(text, `${surface.id} does not wire ${cb}`).toContain(`${cb}:`);
		}
	});
});

describe("ink surfaces - every rule is ruled on for every surface", () => {
	it.each(RULES)("$rule: the ledger is total", (rule) => {
		// THE PROPERTY THIS FILE EXISTS FOR. A surface that is neither carrying
		// the rule nor written down as exempt is a hole, and a hole is exactly
		// what all seven divergences were. Adding a fifth surface opens one in
		// every row at once and the suite goes red until somebody rules.
		const ruled = new Set<string>([...rule.on, ...Object.keys(rule.exempt)]);
		const unruled = ALL_IDS.filter((id) => !ruled.has(id));
		expect(
			unruled,
			`no ruling for ${unruled.join(", ")} on "${rule.rule}" - carry it or exempt it with a reason`
		).toEqual([]);
	});

	it.each(RULES)("$rule: no surface is both carried and exempt", (rule) => {
		const both = rule.on.filter((id) => id in rule.exempt);
		expect(both, `contradictory ruling for ${both.join(", ")}`).toEqual([]);
	});

	it.each(RULES)("$rule: every exemption carries a reason", (rule) => {
		for (const [id, reason] of Object.entries(rule.exempt)) {
			// A blank reason is worse than none: it looks ruled-on and says
			// nothing, which is the property of the comments this whole file
			// is a reaction to.
			expect((reason ?? "").trim().length, `${id} is exempt with no reason`).toBeGreaterThan(20);
		}
	});

	it.each(RULES)("$rule: names only surfaces that exist", (rule) => {
		const known = new Set<string>(ALL_IDS);
		for (const id of [...rule.on, ...Object.keys(rule.exempt)]) {
			expect(known.has(id), `"${rule.rule}" names unknown surface ${id}`).toBe(true);
		}
	});
});

describe("ink surfaces - each rule reaches every surface that carries it", () => {
	for (const rule of RULES) {
		for (const id of rule.on) {
			const surface = INK_SURFACES.find((s) => s.id === id)!;
			it(`${rule.rule} - present on ${id}`, () => {
				const text = surfaceText(surface.file);
				const found = rule.markers.filter((m) => text.includes(m));
				expect(
					found.length,
					`${surface.file} carries none of: ${rule.markers.join(", ")}`
				).toBeGreaterThan(0);
			});
		}
	}
});

/** The visibility claim: "show the strip". Every tool command makes it too. */
const VISIBILITY_CLAIM = "markPenSeen(";
/** The hardware claim: "a real pen fired a real event". Only pen events may. */
const HARDWARE_CLAIM = "markPenHardwareSeen(";
/**
 * Comment-only lines dropped, so a call named in prose is not read as a call.
 * Both surfaces discuss these functions at length in exactly the comments that
 * sit above them, and a scan that counted those would pass on a file that had
 * described the rule and not implemented it - which is the failure this whole
 * file is a reaction to, one level up.
 */
function codeLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
}

/**
 * The pairing, and the gate on it.
 *
 * WHY THIS IS NOT ANOTHER ROW. The rows above ask "is this marker present",
 * one rule at a time, and that question is what missed the eighth divergence:
 * `markPenSeen(` and `markPenHardwareSeen(` sat in one row as an OR, both
 * surfaces carried the first, and the row read yes|yes while the note claimed
 * pen hardware and the pdf claimed none. Splitting the row (done above) makes
 * the presence visible. This block asks the two questions a presence row still
 * cannot: are the two claims made TOGETHER, and is the hardware one gated.
 *
 * Driven off `mountsStrip` rather than a list of names, so surface number five
 * is covered the day it is added and not the day someone remembers.
 *
 *
 * THE HOVER DIVERGENCE: WAS OPEN, NOW RULED
 *
 * This block used to be headed "the one divergence this file must not close",
 * and it was right to be. The two hover sites disagreed about VISIBILITY,
 * deliberately on both sides and in writing on both sides:
 *
 *   - note, `InkOverlay.showPenCursor`: a mouse hovering with mouse ink armed
 *     still raised the strip, because gating that "would silently take the
 *     toolbar away from every mouse-ink user".
 *   - pdf, `PdfInkController.showCursor`: no mouse raised it, because "a
 *     mouse in the room, reticle off, raised the pen toolbar in auto mode for
 *     a pointer that was never a pen" (1.4.6-design.md 5m/AF5).
 *
 * ALAN RULED, 2026-09-03, asked directly and told plainly that it reverses his
 * own 1.4.6 call: "with mouse ink armed, yes a hovering mouse should bring
 * toolbar out". So the note's behaviour is the right one, the pdf matches it,
 * and AF5's surviving half is the UNARMED mouse, which still raises nothing.
 * The rows above now carry a `pointerRaisesPenTools(` row for it, and that row
 * is the first real test of whether this ledger is worth having: an exemption
 * written for a legitimate divergence had to come out the moment the
 * divergence stopped being legitimate, or the guard would go on certifying a
 * gap that a person had already closed.
 *
 * What has NOT changed is which claim is gated. The hardware claim is a real
 * pen on both surfaces, and an armed mouse must never make it - `nibIsLit`
 * answers the mouse through its own `|| h.mouseInkOn()`, and routing the mouse
 * into `penHardware` to light the nib would rebuild the 1.4.6-to-1.4.8 bug
 * from the far end. The assertions below are about that claim.
 */
describe("ink surfaces - visibility and hardware are separate claims", () => {
	const stripSurfaces = INK_SURFACES.filter((s) => s.mountsStrip);

	it("there are strip surfaces to check at all", () => {
		// The witness. Every assertion below is a filter over source lines and
		// a filter that finds nothing passes; this is the floor that says the
		// suite is looking at something.
		expect(stripSurfaces.map((s) => s.id)).toEqual(["note", "pdf"]);
	});

	it.each(stripSurfaces)(
		"$id: a surface that claims strip visibility also claims pen hardware",
		(surface) => {
			// THE ASSERTION THAT WOULD HAVE CAUGHT THE EIGHTH DIVERGENCE.
			// `nibIsLit` reads `penHardwareSeen()`, and both of these build
			// their nib buttons from the same `isLit` specs - so a surface
			// that only ever announces visibility ships pen and highlighter
			// buttons that stay dark for a pen user unless mouse ink is on.
			// That is precisely what the pdf did between `cff850d`, which
			// split the flags on the note surface, and `77454fc`.
			const lines = codeLines(surfaceText(surface.file));
			const visibility = lines.filter((l) => l.includes(VISIBILITY_CLAIM)).length;
			const hardware = lines.filter((l) => l.includes(HARDWARE_CLAIM)).length;
			if (visibility === 0 && hardware === 0) return;
			expect(
				hardware,
				`${surface.file} claims strip visibility (${VISIBILITY_CLAIM}) but never claims pen ` +
					`hardware (${HARDWARE_CLAIM}) - its nib buttons cannot light for a pen user`
			).toBeGreaterThan(0);
		}
	);

	it.each(INK_SURFACES)("$id: every hardware claim is gated on the pointer type", (surface) => {
		// A hardware claim is a claim about the DEVICE, and the only code that
		// still knows what the device was is the call site - which is why
		// `markPenHardwareSeen` deliberately does not gate itself
		// (PenToolsMode.ts). An ungated one is a mouse stroke announcing a
		// pen, which is the exact reading of `penSeen` that killed the nib
		// light for three releases.
		//
		// Line-local on purpose. If a future change moves the gate somewhere
		// this cannot see - into a helper, or a branch above - the honest
		// response is to re-rule this assertion in the open, not to widen it
		// until it passes.
		const claims = codeLines(surfaceText(surface.file)).filter((l) => l.includes(HARDWARE_CLAIM));
		const ungated = claims.filter((l) => !/pointerType === "pen"\)\s*markPenHardwareSeen\(/.test(l));
		expect(
			ungated,
			`${surface.file} claims pen hardware without a pointer-type gate on the same line`
		).toEqual([]);
	});

	it("the two strip surfaces gate the same number of hardware claims", () => {
		// Contact and hover, on each. Not a style rule - it is the count that
		// goes wrong when a fix lands on one site and not its twin, which is
		// the same defect shape one scale down from the one this file exists
		// for. A deliberate third site on one surface should change this
		// number and make somebody say why.
		const counts = stripSurfaces.map((s) => ({
			id: s.id,
			sites: codeLines(surfaceText(s.file)).filter((l) => l.includes(HARDWARE_CLAIM)).length,
		}));
		expect(counts).toEqual([
			{ id: "note", sites: 2 },
			{ id: "pdf", sites: 2 },
		]);
	});
});

describe("ink surfaces - the registry is derived from the tree, not maintained by hand", () => {
	// THE GAP THIS CLOSES. The header above says the table in code "is what
	// makes surface number five fail the suite on the day it is written rather
	// than the day somebody remembers the guard exists." That was not enforced:
	// `ALL_TS` was read only to fetch a NAMED file's text and to assert the glob
	// found more than 100 files. Nothing compared the registry to reality.
	//
	// The proof was `DemoInk.ts`. It WAS surface five, it existed the whole
	// time, and the suite was green. It got added by hand because nothing
	// failed - the same opt-in blindness that hid the canvas from
	// StripPenChrome.test.ts for that file's entire life.
	const built = Object.keys(ALL_TS)
		.filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
		.filter((f) => codeOnly(ALL_TS[f]!).includes("new StrokeBuilder("))
		.sort();

	it("every file that builds a stroke is in INK_SURFACES", () => {
		const listed = INK_SURFACES.map((s) => s.file).sort();
		expect(built, "a file constructs a StrokeBuilder and is not a named surface").toEqual(
			listed
		);
	});

	it("every surface in INK_SURFACES really builds a stroke", () => {
		for (const s of INK_SURFACES) {
			expect(
				codeOnly(surfaceRaw(s.file)).includes("new StrokeBuilder("),
				`${s.file} is listed as a surface but constructs no StrokeBuilder`
			).toBe(true);
		}
	});

	it("mountsStrip is derived, not asserted", () => {
		const mounts = Object.keys(ALL_TS)
			.filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
			.filter((f) => codeOnly(ALL_TS[f]!).includes("new MobileTools("))
			.sort();
		const claimed = INK_SURFACES.filter((s) => s.mountsStrip)
			.map((s) => s.file)
			.sort();
		expect(mounts).toEqual(claimed);
	});
});

describe("ink surfaces - the comment stripper cannot fail open", () => {
	// P3: if codeOnly returned its input unchanged, every marker assertion
	// would still pass and the doc-comment hole would be back with a test
	// standing over it saying it was closed.
	//
	// These four now stand over BOTH guards. `codeOnly` lives in
	// `src/CodeOnly.ts` and `StripPenChrome.test.ts` imports the same
	// function, so weakening it to suit one sweep fails here.
	it("blanks a block comment", () => {
		expect(codeOnly("/* contactHalfWidth( */ x").includes("contactHalfWidth(")).toBe(false);
	});

	it("blanks a line comment", () => {
		expect(codeOnly("// contactHalfWidth(\nx").includes("contactHalfWidth(")).toBe(false);
	});

	it("leaves real code alone", () => {
		expect(codeOnly("a.contactHalfWidth(b)").includes("contactHalfWidth(")).toBe(true);
	});

	it("preserves length and line count", () => {
		const src = "/* aa */\n// bb\ncode";
		expect(codeOnly(src)).toHaveLength(src.length);
		expect(codeOnly(src).split("\n")).toHaveLength(src.split("\n").length);
	});
});
