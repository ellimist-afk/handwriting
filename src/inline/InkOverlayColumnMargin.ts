/**
 * The note surface's column margin and overscroll: the painted and applied
 * margin, the column rest, and the overscroll give and bounce. They are
 * methods of InkOverlayPlugin, installed on its prototype when InkOverlay.ts
 * loads.
 */
import { installMethods } from "./InstallMethods";
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { scrollProbeExtent } from "./ScrollProbe";
import { PAN_FIT_SLACK_PX, OVERSCROLL_BOUNCE_MS, OVERSCROLL_BOUNCE_MIN_PX, OVERSCROLL_GIVE_PX, travelledEaseRoom, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		paintedColumnMargin(): number | null;
		appliedColumnMargin(next: number): number;
		restColumnAgainstCurrentGrant(next: number, effective: number, shownPainted?: number | null, book?: boolean): void;
		columnMarginDebtScrollLeft(effective: number, left: number): number;
		columnRestPan(next: number, effective: number): number | null;
		ownLinesPageBoxScrollLeft(next: number, effective: number, left: number): number;
		columnFitsPane(next: number, effective: number): boolean;
		columnRestCentred(_next: number, _effective: number): number | null;
		holdOverscrollGive(x: number, y: number): void;
		releaseOverscrollGive(): void;
		startOverscrollBounce(hold: object, dx: number, dy: number, travelled?: boolean, reaim?: boolean): boolean;
		overscrollBounceReadout(): { active: boolean; x: number; y: number; fromX: number; fromY: number; startedAt: number | null; restX: number; restY: number; floorX: number; floorY: number; bx: number; width: number; rawX: number; cx: number; rawY: number; cy: number };
		notePanBound(fits: boolean, requested: number, accepted: number): void;
	}
}

	/**
	 * THE MARGIN THE COLUMN IS PAINTED AT, host-local, read off the element that carries it: the first line when the theme
	 * centres its own lines (every line takes the same margin), the sizer otherwise. Null when there is no column or nothing
	 * to read, and the caller falls back to `appliedColumnMargin`. It forces style, so a commit reads it twice - once at its
	 * top, for what the page is showing, and once after its own layout writes - and a preview frame never reads it.
	 */
	function paintedColumnMargin(this: InkOverlayPlugin): number | null {
		const layout = this.viewportLayout;
		if (!layout || layout.columnLocal === null) return null;
		const el = layout.ownLines ? this.view.contentDOM?.firstElementChild : layout.sizerColumn ? this.panSizer() : null;
		const win = el?.ownerDocument?.defaultView;
		if (!el || !win) return null;
		const px = parseFloat(win.getComputedStyle(el).marginLeft);
		return Number.isFinite(px) ? px : null;
	}

	/**
	 * THE MARGIN THE PAGE ACTUALLY SITS AT at scale `next`, host-local: what the box write asked for, after the
	 * stylesheet clamps it against the auto term. NOT the custom property, which is written unclamped - measured on a
	 * tiny note at 10% with Readable line length off, the property reads 6907.03 and the page sits at 6562.5, and it is
	 * this one that carries the page.
	 * Under a theme that centres its own lines the auto term is floored at the gutter's reserve, as applyViewportBox writes it.
	 *
	 * One expression, two readers that must agree or the page pays twice: `columnRestPan` turns the part the layout did
	 * not take into a pan, and the box write records it so the next resting frame can tell that the law moved under it.
	 */
	function appliedColumnMargin(this: InkOverlayPlugin, next: number): number {
		const layout = this.viewportLayout, auto = layout?.columnAuto;
		if (!layout || layout.columnLocal === null) return 0;
		const want = Math.max(0, this.columnRestMargin ?? this.columnMarginLocal(layout)!);
		return (layout.sizerColumn || layout.ownLines) && auto
			? Math.max(0, Math.min(Math.max(layout.ownLines ? this.columnGutterReserve ?? 0 : 0, (layout.width / next - auto.fixed - this.scrollbarLocalAt(auto.scrollbar, next) - auto.lineWidth) / 2), want))
			: want;
	}

	/**
	 * THE CENTRING, RECOMPUTED AGAINST THE GRANT THIS COMMIT JUST MADE, with whatever the page was actually showing
	 * booked as a debt for the scroll below to pay.
	 *
	 * `applyViewportBox` runs before `updateExtent`, so the margin it wrote was computed from the granted extent as it
	 * stood at the top of the commit. Under Infinite Canvas the extent then grows - measured 3072 -> 22528 on a tiny
	 * note at 10% - which leaves a centring that was correct when written and is stale by the end of the same commit.
	 * Nothing withdrew it there, so the page went on standing centred until the NEXT commit of any kind recomputed it
	 * and dropped it: measured 536.70 px on a bare commit at the same scale, no gesture behind it at all. That is the
	 * defect: it snaps on any commit rather than only at a lift. Not the device report about ink separating from
	 * text - this is page and column POSITION, and the anchor holds through it.
	 *
	 * Done BEFORE the frame is presented, so the stale value is never shown and there is usually nothing to pay. The
	 * debt is measured against what the page WAS showing - the previous commit's settled margin - and never against the
	 * stale write this call replaces, which the page never presented.
	 */
	function restColumnAgainstCurrentGrant(this: InkOverlayPlugin, next: number, effective: number, shownPainted: number | null = null, book = true): void {
		const layout = this.viewportLayout;
		if (!layout || this.pinchPreview || layout.columnLocal === null) return;
		this.columnRestMargin = !layout.sizerColumn ? null : this.columnRestCentred(next, layout.externalScale * next);
		const host = this.view.dom, value = `${Math.max(0, this.columnRestMargin ?? (layout.sizerColumn || layout.ownLines ? this.columnMarginLocal(layout)! : 0))}px`;
		if (host.style.getPropertyValue("--handwriting-column-margin-left") !== value) {
			host.style.setProperty("--handwriting-column-margin-left", value);
			// The margin moves the sizer, so the gutters' counter translate is re-read on the next pan write.
			this.panGuttersMode = null;
		}
		// The debt is what the PAINTED column moved by, not what the margin law says it should have. The stylesheet clamps the
		// margin against the theme's own auto term, which tracks the pane live during a preview, so the law's value can move
		// while the painted one does not: measured with Readable line length on, 221 to 123 percent, the law went 0 to 151.73
		// while each line was painted at 151.73 in the last preview frame and after the commit, and paying that difference
		// as scroll glided the page 186 px left after the lift. The law stands in only where there is nothing to read, and
		// then for both ends: a painted value is never netted against a law value.
		const after = shownPainted === null ? null : this.paintedColumnMargin(), painted = after !== null;
		const settled = painted ? after : this.appliedColumnMargin(next), shown = painted ? shownPainted : this.restingColumnMargin;
		this.restingColumnMargin = settled;
		// A restored camera books nothing: the margin it leaves with is the one painted at the restored zoom.
		if (!book || shown === null || settled === shown) return;
		this.columnMarginDebt += (shown - settled) * effective;
	}

	/**
	 * THE MARGIN DEBT, PAID IN THIS COMMIT'S OWN SCROLL TARGET. Scroll and not pan, at a commit: a pan parked here is
	 * indistinguishable from the gesture residue `commitCameraScale` clears on any later commit carrying a scroll
	 * target, it cannot be reached at all by a commit with no gesture behind it (Fit, the zoom buttons, Ctrl+scroll
	 * establish no pan anchor hold), and a standing pan at rest costs on every path that assumes none.
	 *
	 * A positive debt owes the page a move RIGHT, which is a scroll LEFT, and the room for it is the scroll already
	 * taken. A negative debt owes a move left, and its room is the range past it. Anything the range cannot cover stays
	 * owed rather than being silently dropped, so a later commit with room pays the remainder.
	 */
	function columnMarginDebtScrollLeft(this: InkOverlayPlugin, effective: number, left: number): number {
		const debt = this.columnMarginDebt;
		if (!debt || !Number.isFinite(left) || !(effective > 0)) return left;
		const scroller = this.view.scrollDOM, want = -debt / effective;
		const room = want > 0 ? Math.max(0, scroller.scrollWidth - scroller.clientWidth - left) : Math.max(0, left);
		const by = want > 0 ? Math.min(room, want) : -Math.min(room, -want);
		if (!Number.isFinite(by) || by === 0) return left;
		this.columnMarginDebt = debt + by * effective;
		return left + by;
	}

	/**
	 * THE PAN THAT PUTS A READABLE-LINE-LENGTH COLUMN AT ITS REST at scale
	 * `next`, painted px from where it sits with no pan and no scroll; null when
	 * the column has no inset to rest in.
	 *
	 * The rest is centred, which is what the setting means at every zoom. The
	 * layout does not centre it below 100%: the sizer's margin is
	 * `clamp(0, auto, frozen)` (styles.css, the note viewport's sizer), the frozen
	 * term holding the 100% margin in host px so that a margin re-centring by 1/k
	 * cannot open a blank band Infinite Canvas would scroll into. The difference
	 * between the centring the engine would give this column and the margin the
	 * clamp applies is carried as pan instead; above 100% the auto term already
	 * wins and this is 0. Arithmetic only, from the inputs `applyViewportBox`
	 * writes the auto term from, so a preview frame reads nothing for it.
	 *
	 * Keyed on the column itself, not the setting's class: its inset must BE the
	 * centring, a margin within a px of half the room beside the column at 100%.
	 * Null for a frozen margin of zero (Readable line length off), no measured
	 * inputs, a column as wide as the scroller's content (a pane narrower than the
	 * line), and an inset that is not centred (a theme's or a note's own left
	 * margin), which keeps its natural inset as before.
	 * Null too where the page does not fit the pane at this scale - the column, or
	 * ink granted room past it - since there the scroll is the rest, as it was.
	 */
	function columnRestPan(this: InkOverlayPlugin, next: number, effective: number): number | null {
		const centred = this.columnRestCentred(next, effective);
		const layout = this.viewportLayout;
		if (centred === null || !layout || layout.columnLocal === null) return null;
		// A THEME THAT CENTRES ITS OWN LINES is its own rest: with the freeze lifted, the column sits where the theme centres
		// it at this zoom, so there is nothing for the overlay to add - not a margin, not a translate.
		//
		// KNOWN, WITH ITS NUMBER, and not fixed here: the theme centres the LINE, and it knows nothing about ink granted
		// room past the column, so where a note has some the theme's centring carries it out of the pane. Measured on Fit
		// with a stroke 3000 note px past the column under Minimal: the ink's right edge lands 16.31 px past the pane's
		// (1713.81 against 1697.5). Correcting it needs a carrier a no-gesture commit does not have - Fit takes no settle
		// and establishes no pan anchor, and the sizer margin is not the column's place under this theme - so it is a
		// resting translate, which is the cost this candidate exists to remove. Pinned as KNOWN in the cell, a decision
		// still open. Under Obsidian's own theme the centring is taken over the page's whole box, ink
		// included, and the ink stays inside the pane as it always did.
		if (layout.ownLines) return 0;
		// WHERE THE COLUMN ALREADY IS at pan zero, as a host-local margin. Where the sizer carries the column this is the
		// margin the stylesheet resolves - the one this frame wrote, clamped against the auto term - as before. Where it
		// does not (Minimal: a full-width sizer with the LINE centred inside it) the sizer's margin is not the column's
		// place at all, and the column sits at its own measured inset instead. Arithmetic either way: no forced read on a
		// preview frame, which is the reason this is not simply re-measured here.
		const rest = (centred - this.appliedColumnMargin(next)) * effective;
		return Number.isFinite(rest) ? rest : null;
	}

	/**
	 * THIS COMMIT'S SCROLL TARGET, WITH THE PAGE BOX PULLED BACK INSIDE THE PANE under a theme that centres its own
	 * lines. Returns `left` unchanged everywhere else, which is every path on Obsidian's own theme.
	 *
	 * Part 21 Edge 2's contract is that the PAGE BOX - the column plus whatever room ink has been granted past it -
	 * stays inside the pane at every commit. Obsidian's own theme meets it through the sizer margin, which
	 * `columnRestCentred` sizes over the whole box. A theme that centres its own LINES meets it for an ordinary note
	 * and breaks it for a note with far ink: the theme knows only the line, so it centres as if the page ended at the
	 * column and carries the ink out of the pane with it - measured on Fit with a stroke 3000 note px past the column
	 * under Minimal, 16 to 24 px past the pane's right edge.
	 *
	 * `own` below is where the theme puts the page's left edge: half the room beside the COLUMN's box, which is all it
	 * knows. From there the box's right edge is `own + width`, and whatever that is past the pane, measured from the
	 * scroll this commit is about to take, is the debt. THE MINIMUM, not a re-centring: centring the box instead moved
	 * the page 247 px where 16 were owed. An ordinary note has `width` equal to the column's own box, which makes the
	 * overflow negative and the debt zero, so an ordinary page is never scrolled by this.
	 *
	 * PAID IN SCROLL, in this commit's own scroll target, and never as a pan. A pan parked here is indistinguishable
	 * from the gesture residue `commitCameraScale` clears on any later commit carrying a scroll target, which made an
	 * earlier attempt at this intermittent (the same fixture read 0.81, 8.81 and 16.31 px). Scroll survives, and the
	 * room is there by construction: ink granted room past the column IS scrollable range - measured 471 local px on
	 * the arm that needs it, against the ~66 local px it asks for.
	 *
	 * Measured from `left` rather than from the live scroll, so this is idempotent: a commit re-running against an
	 * already-corrected page computes a debt of zero rather than paying it twice.
	 */
	function ownLinesPageBoxScrollLeft(this: InkOverlayPlugin, next: number, effective: number, left: number): number {
		const layout = this.viewportLayout;
		if (!layout || !layout.ownLines || !(effective > 0) || !Number.isFinite(left)) return left;
		const width = this.pageContentWidth() * effective;
		const span = layout.width * layout.externalScale - layout.gutterScreen;
		// The same fit gate `columnRestCentred` takes: where the page does NOT fit the pane the scroll is already the
		// rest, as it always was, and this owes nothing.
		if (!(width > 0 && width <= span + PAN_FIT_SLACK_PX)) return left;
		// The line inset is frozen at its 100% value (styles.css own-lines rule), so the column sits at that inset,
		// clamped by the theme's auto term above 100%, and no longer at the centre of the widened box.
		const own = Math.max(0, this.appliedColumnMargin(next) * effective);
		const overflow = own + width - span - left * effective;
		if (!Number.isFinite(overflow) || !(overflow > PAN_FIT_SLACK_PX)) return left;
		const scroller = this.view.scrollDOM;
		const room = Math.max(0, scroller.scrollWidth - scroller.clientWidth - left);
		const by = Math.min(room, overflow / effective);
		return by > 0 ? left + by : left;
	}

	/**
	 * THE FIT QUESTION SURVIVES THE CENTRED REST. Two settle sites asked "does the column have a
	 * rest to sit in" by testing `columnRestPan !== null`, and used the answer for something else: a page that
	 * fits the pane never settles onto a sideways SCROLL (its place is the margin, and a scroll left standing
	 * displaces it by its whole width - measured at :8622, 57 px of column off the pane). With the centred rest
	 * gone that answer went false everywhere, and the 25 -> 100 round trip missed the text by 1079 px.
	 * The predicate is the fit half of what columnRestCentred used to compute, and only that.
	 */
	function columnFitsPane(this: InkOverlayPlugin, next: number, effective: number): boolean {
		const layout = this.viewportLayout;
		if (!layout || !layout.columnInset || !(next > 0) || !(effective > 0)) return false;
		if (this.canvasMode) return false;
		const width = this.pageContentWidth() * effective;
		const span = layout.width * layout.externalScale - layout.gutterScreen;
		return width > 0 && width <= span + PAN_FIT_SLACK_PX;
	}

	function columnRestCentred(this: InkOverlayPlugin, _next: number, _effective: number): number | null {
		// ALAN DIRECT, AND IT RETIRES THIS QUANTITY: "I don't want it to center anywhere."
		// The contract: Readable line length moves the LEFT BOUND to the column's border and does
		// nothing else; the viewport is otherwise Obsidian's own, and zoomed out the note sits top-left. The
		// plugin never adds a centring rest under either setting, so there is nothing here to compute.
		//
		// WHAT IT USED TO DO, kept because the numbers are the reason it is gone: it centred the page in the
		// room beside it and returned that as a HOST-LOCAL margin, so the value grew as the zoom fell.
		// Measured on Alan's device (Orion, fresh Untitled, Readable line length OFF, opened at 100% and
		// pinched to 10%): --handwriting-column-margin-left written at 4292.70px, the sizer 432.46 px right of
		// the scroller, "Untitled" mid-top. Measured in the rig on a theme-narrow column, setting off: 6588.50px.
		// It read `layout.columnInset` to decide there was a column to centre, and that flag is true of any page
		// that fits its scroller - which at 10% is every page.
		//
		// THE COLUMN'S OWN PLACE IS UNTOUCHED. With the setting on, `columnRestMargin` now falls through to
		// `columnLocal` - Obsidian's own margin for the readable column - so the column still sits where
		// Obsidian puts it and the left bound still lands on its border. We simply stop adding anything.
		return null;
	}

	/**
	 * The page is being held past an end by the finger. Painted here, live, on the same
	 * offset the bounce uses - `panX`/`panY` already add it, so one write shows it on the
	 * sizer, the paper and the ink together and nothing else has to learn about it.
	 *
	 * The scroller's own offset is not touched: the router kept it inside its range, and
	 * this give is visual for as long as the hand holds it.
	 *
	 * Alan 2026-09-21, the slide ships in 1.4.20: `travelled` marks a correction that is the page's own MEASURED
	 * travel across the commit (painted before minus landed), not a bound's share. The direction rule above is about a
	 * bound with nothing to bounce off; measured travel is a move the viewer would otherwise see land in one frame
	 * whichever way it points (measured: a held-out page let go at scrollLeft 500 closed 154 px leftward-signed in the
	 * lift's own frame), so it is eased in both directions. Callers that pass a bound's share keep the rule.
	 */
	function holdOverscrollGive(this: InkOverlayPlugin, x: number, y: number): void {
		const offset = this.bounceOffset;
		if (!offset) return;
		// A CLOSED OVERLAY TAKES NO GIVE. Its paper has come down and its router is going; a pull that
		// still arrives would put a fresh paper up on a scroller the next note keeps.
		if (this.retiring) return;
		// A give that arrives mid-bounce replaces it: the finger is back on the glass and
		// owns the page again.
		if (this.bounceState) this.cancelOverscrollBounce();
		// THE GIVE IS MEASURED FROM THE REST, NOT FROM WHERE THE FINGER LANDED. The cancel above
		// folds what the spring still owed into the standing pan (so the page does not jump
		// under the finger), and the router's pull starts from zero on every gesture. Painted as it
		// arrived, the page then stood the allowance PAST that fold - and a hand that grabbed early in
		// each spring and pulled again walked the page out by nearly the allowance per grab (Alan,
		// device, 2026-09-20: "repeatedly left scroll, lift, left scroll" goes way out of bounds).
		// So the pull is applied to the page's standing overshoot past its bound - the same bound the
		// lift's resume measures against - and the total is held to the allowance: a page already
		// standing out is pulled no further than the allowance itself, a pull back inward is
		// carried in full, and a page inside its bound gives exactly as before.
		const pan = this.viewportPan, px = pan?.x ?? 0, py = pan?.y ?? 0;
		const give = OVERSCROLL_GIVE_PX * (this.viewportLayout?.externalScale ?? 1);
		const standX = px - (this.canvasMode ? Math.min(px, 0) : Math.max(this.boundReadout.floorX, Math.min(px, 0)));
		const standY = py - (this.canvasMode ? Math.min(py, 0) : Math.max(this.boundReadout.floorY, Math.min(py, 0)));
		// THE ORIGIN SIDE ONLY, and never past the allowance. The lower bound is 0, not -give: a
		// negative total is the page held past a FAR end, which in canvas mode is room rather than a
		// boundary, so a step refused there paints no pull. The upper bound is unchanged.
		const gx = Number.isFinite(give) ? Math.max(0, Math.min(give, standX + x)) - standX : x;
		const gy = Number.isFinite(give) ? Math.max(0, Math.min(give, standY + y)) - standY : y;
		if (offset.x === gx && offset.y === gy) return;
		if (offset.x === 0 && offset.y === 0) this.beginPreviewPaper();
		offset.x = gx;
		offset.y = gy;
		this.writeViewportPan();
	}

	/** The hand is off: send the give home through the one return the lift already has. */
	function releaseOverscrollGive(this: InkOverlayPlugin): void {
		const offset = this.bounceOffset;
		if (!offset) return;
		// A CLOSED OVERLAY SENDS NOTHING HOME. Disposing the router releases a give that was held, and
		// that release arrives after unmount took the paper down: the return below would start a bounce,
		// put a new paper up on the scroller the next note keeps, and could pay scroll into it.
		if (this.retiring) return;
		const x = offset.x, y = offset.y;
		// A RELEASE WITH NOTHING HELD STILL SENDS A STANDING PAGE HOME. With the give measured
		// from the rest, a finger that lands on a page already standing the allowance past its end
		// holds nothing (its pull adds no offset), and its lift used to return here at once - the page
		// then stayed out until the next contact. The resume below measures the way home from the
		// standing pan and is a no-op when nothing is owed, so it is the right call either way.
		// ONE RETURN MECHANISM. The give goes back through `resumeStrandedPan`, the same
		// method a lift already uses for a pan left standing, rather than starting a bounce
		// of its own. That method measures the way home from the STANDING pan, and the give
		// is not in the standing pan - it is in this offset - so fold it in first. A bare
		// hand-off finds no distance to cover, does nothing, and leaves the page held out
		// past the end.
		offset.x = 0;
		offset.y = 0;
		const pan = this.viewportPan;
		pan.x += x;
		pan.y += y;
		if (this.resumeStrandedPan()) return;
		// Nothing was held and nothing is owed. A spring already running, or a pinch preview, still shows the
		// paper and takes it down itself; otherwise a give that came back to zero before the lift leaves the
		// paper this gesture put up, so it comes down here.
		if (x === 0 && y === 0) {
			if (!this.bounceState && !this.pinchPreview) this.endPreviewPaper("bounce-end");
			return;
		}
		// It would not take it: a bounce already running, a preview holding the frame, or a
		// give too small to animate. Put the page back on the bound and take the preview
		// paper down - what a refused bounce did here before.
		pan.x -= x;
		pan.y -= y;
		this.endPreviewPaper("bounce-end");
		this.writeViewportPan();
	}

	/** The distances an ease may start from: under the minimum is none, and with Infinite Canvas on a leftward or upward
	 * distance is eased only when travelled and within the room past the far edge (travelledEaseRoom). */
	function easedDistances(this: InkOverlayPlugin, dx: number, dy: number, travelled: boolean): { x: number; y: number } {
		let room = { x: Infinity, y: Infinity };
		if (travelled && (dx < 0 || dy < 0) && this.cssScale > 0) {
			const s = this.view.scrollDOM;
			room = travelledEaseRoom({ scrollLeft: s.scrollLeft, scrollTop: s.scrollTop, clientWidth: s.clientWidth, clientHeight: s.clientHeight, scrollWidth: this.bandFreeScrollWidth ?? s.scrollWidth, scrollHeight: s.scrollHeight, scale: this.cssScale });
		}
		return {
			x: Math.abs(dx) >= OVERSCROLL_BOUNCE_MIN_PX && !(this.canvasMode && dx < 0 && (!travelled || Math.ceil(-dx / this.cssScale) > room.x)) ? dx : 0,
			y: Math.abs(dy) >= OVERSCROLL_BOUNCE_MIN_PX && !(this.canvasMode && dy < 0 && (!travelled || Math.ceil(-dy / this.cssScale) > room.y)) ? dy : 0,
		};
	}
	/**
	 * Start the bounce for the settle `hold`, from the overshoot `dx`/`dy` (the
	 * clamp's correction, painted px, requested minus accepted). A settle
	 * re-anchoring itself on a later frame does not bounce again, whether its
	 * bounce is still playing or has ended: that would put the page back at the
	 * overshoot.
	 *
	 * Per axis, and not where Infinite Canvas is on in that direction: a page
	 * pushed left or up shows the room scrolling would grow into there, so there
	 * is no boundary to bounce off (the correction then lands as it always did).
	 * A page pushed right or down shows the note's origin edge, which Infinite
	 * Canvas never extends past, so it bounces either way.
	 */
	function startOverscrollBounce(this: InkOverlayPlugin, hold: object, dx: number, dy: number, travelled = false, reaim = false): boolean {
		const offset = this.bounceOffset;
		// The unit fixtures drive the settle against partial objects built with Object.create: no class fields, no bounce.
		if (!offset) return false;
		// A RE-AIM OF THE SAME SETTLE'S EASE, never a second start. The settle's hold re-pans on each attempt of its measure,
		// after CodeMirror's measure has moved the layout the first ease was measured against (the whole-pixel scroll, the
		// height rebuild), so each attempt hands its own distance here: the running ease starts again from it, in the same
		// task as the attempt's write, before anything paints. An ease that has already ended is not started again.
		if (this.bouncedHold === hold) {
			const running = this.bounceState;
			if (!reaim || !running || running.hold !== hold) return false;
			// The start's rule, not a second one: with Infinite Canvas on, a leftward or upward distance the room refuses is
			// refused here too, so a re-aim never eases where a start would not.
			const eased = easedDistances.call(this, dx, dy, travelled);
			running.fromX = eased.x;
			running.fromY = eased.y;
			running.startedAt = this.winRef.performance.now();
			offset.x = running.fromX; offset.y = running.fromY;
			return true;
		}
		// A LEFTWARD OR UPWARD EASE SHOWS THE INK RASTER'S FAR EDGE. The ink canvases ride the page by the same
		// offset, and they cover the pane plus the band margin and no more (measured: 185 to 200 px spare at rest; an
		// offset of -326 left 141 px of the pane's right with no ink raster while the ease played). The band now covers
		// the ease instead: syncBand widens it by the bounce's start offset on the side the ease uncovers, at the sync
		// that follows the settle's pan write. So measured travel is eased in every direction, up to the bound
		// travelledEaseRoom sets on each axis; a travelled correction leftward or upward past it lands in the commit's
		// frame, as it did before the slide. An untravelled correction leftward or upward still lands as it always did:
		// with Infinite Canvas on there is no edge there. The ink cover past the pane is read for the probe line only,
		// with diagnostics on.
		let coverX = Infinity, coverY = Infinity;
		if (travelled && diagnosticsEnabled() && (dx < 0 || dy < 0)) {
			const ink = this.committedCanvas?.getBoundingClientRect?.(), pane = this.view?.scrollDOM?.getBoundingClientRect?.();
			coverX = ink && pane ? Math.max(0, ink.right - pane.right) : 0;
			coverY = ink && pane ? Math.max(0, ink.bottom - pane.bottom) : 0;
		}
		const { x: bx, y: by } = easedDistances.call(this, dx, dy, travelled);
		// One line per settle ease (the travelled call is the settle's only), for the device probe. The cover is the
		// band before the widening sync.
		if (travelled) scrollProbeExtent(`settle ease ${bx === 0 && by === 0 ? "refused" : "eased"} correction ${dx.toFixed(2)},${dy.toFixed(2)} cover ${coverX.toFixed(2)},${coverY.toFixed(2)} pan ${this.viewportPan.x.toFixed(2)},${this.viewportPan.y.toFixed(2)} offset ${offset.x.toFixed(2)},${offset.y.toFixed(2)} to ${(bx === 0 && by === 0 ? offset.x : bx).toFixed(2)},${(bx === 0 && by === 0 ? offset.y : by).toFixed(2)}`);
		if (bx === 0 && by === 0) return false;
		this.cancelOverscrollBounce();
		this.bouncedHold = hold;
		offset.x = bx; offset.y = by;
		// THE BOUNCE MOVES THE PAGE, so it moves the paper the way a preview does: on the element, by a transform, not by
		// re-rastering the scroller's background every frame. The copy is taken here, after the settle, so it is the
		// settled zoom's rules the bounce carries. Its last frame takes the element down again.
		this.beginPreviewPaper();
		// The spring moves the ink layer and the sizer by a transform every frame; marked as moving for its length they stay on the
		// compositor instead of being re-rastered each frame. Taken down on the last frame and in cancelOverscrollBounce.
		this.inkLayer?.setCssStyles({ willChange: "transform" });
		this.panSizer()?.setCssStyles({ willChange: "transform" });
		// This window's clock: the frames below are stamped by it, and a popout's is not the main window's (audit 59).
		const state = { hold, fromX: bx, fromY: by, startedAt: this.winRef.performance.now(), raf: 0 };
		this.bounceState = state;
		const step = (now: number): void => {
			if (this.bounceState !== state) return;
			const t = Math.min(1, Math.max(0, (now - state.startedAt) / OVERSCROLL_BOUNCE_MS));
			// Ease out: fast off the overshoot, settling gently onto the rest, never past it.
			const left = t >= 1 ? 0 : (1 - t) ** 3;
			// Exactly zero at the end, not the -0 a negative overshoot times zero leaves.
			offset.x = left === 0 ? 0 : state.fromX * left; offset.y = left === 0 ? 0 : state.fromY * left;
			this.writeViewportPan();
			// The page is at its rest: a preview paper that rode the bounce comes down on this frame.
			// The compare in syncCamera sat out the bounce; one sync now asks for the repaint a moved camera owes.
			if (t >= 1) {
				this.bounceState = null;
				this.inkLayer?.setCssStyles({ willChange: "" });
				this.panSizer()?.setCssStyles({ willChange: "" });
				this.endPreviewPaper("bounce-end"); this.syncCamera(); return;
			}
			state.raf = this.winRef.requestAnimationFrame(step);
		};
		state.raf = this.winRef.requestAnimationFrame(step);
		scrollProbeExtent(`overscroll bounce from ${bx.toFixed(2)},${by.toFixed(2)} px`);
		return true;
	}

	/** The bounce as it stands, read-only, for a fixture that has to see it rather than infer it from positions. */
	function overscrollBounceReadout(this: InkOverlayPlugin): { active: boolean; x: number; y: number; fromX: number; fromY: number; startedAt: number | null; restX: number; restY: number;
		floorX: number; floorY: number; bx: number; width: number; rawX: number; cx: number; rawY: number; cy: number } {
		const s = this.bounceState;
		return { active: !!s, x: this.bounceOffset.x, y: this.bounceOffset.y, fromX: s?.fromX ?? 0, fromY: s?.fromY ?? 0, startedAt: s?.startedAt ?? null,
			restX: this.restPanX(), restY: this.restPanY(),
			// The bound's own geometry from the last settle.
			floorX: this.boundReadout.floorX, floorY: this.boundReadout.floorY, bx: this.boundReadout.bx, width: this.boundReadout.width,
			rawX: this.boundReadout.rawX, cx: this.boundReadout.cx, rawY: this.boundReadout.rawY, cy: this.boundReadout.cy };
	}

	function notePanBound(this: InkOverlayPlugin, fits: boolean, requested: number, accepted: number): void {
		if (!fits || !(Number.isFinite(requested) && Number.isFinite(accepted)) || accepted === requested) return;
		this.panBoundHits++;
		const by = Math.abs(accepted - requested);
		if (by > this.panBoundMaxPx) this.panBoundMaxPx = by;
	}

export function installInkOverlayColumnMargin(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		paintedColumnMargin,
		appliedColumnMargin,
		restColumnAgainstCurrentGrant,
		columnMarginDebtScrollLeft,
		columnRestPan,
		ownLinesPageBoxScrollLeft,
		columnFitsPane,
		columnRestCentred,
		holdOverscrollGive,
		releaseOverscrollGive,
		startOverscrollBounce,
		overscrollBounceReadout,
		notePanBound,
	});
}
