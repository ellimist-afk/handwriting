/**
 * The strip's layout: the overflow fold, the corner, the header clearance and the transform that places the strip and pill.
 * They are methods of MobileTools, installed on its prototype when MobileTools.ts loads.
 */
import { setIcon } from "obsidian";
import { allToolbarCornerClasses, collapseChevronGlyph, collapseChevronIcon, ToolbarCorner, toolbarCornerClass } from "./ToolbarCorner";
import { gridColumns, type OverflowPlan, overflowPlan } from "./StripOverflow";
import { stripClearance } from "./StripClearance";
import { installMethods } from "./InstallMethods";
import { foldOrder, type MobileTools } from "./MobileTools";

declare module "./MobileTools" {
	interface MobileTools {
		layoutOverflow(): void;
		setCorner(corner: ToolbarCorner): void;
		applyHeaderClearance(): void;
		paintTransform(): void;
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
	function layoutOverflow(this: MobileTools): void {
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
	 * Park the strip and its pill at an anchor. Both move together: they are
	 * one control in two sizes, and the old classes come off first so a
	 * change cannot leave two anchors asserted at once.
	 */
	function setCorner(this: MobileTools, corner: ToolbarCorner): void {
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
	function applyHeaderClearance(this: MobileTools): void {
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
	function paintTransform(this: MobileTools): void {
		const x = this.dodge.x + this.dragOffset.x;
		const y = this.dodge.y + this.dragOffset.y;
		const lift = this.drag?.moved === true ? " scale(1.04)" : "";
		const value = x === 0 && y === 0 && lift === "" ? "" : `translate(${x}px, ${y}px)${lift}`;
		for (const el of [this.el, this.pill]) el.setCssStyles({ transform: value });
	}

export function installMobileToolsLayout(proto: MobileTools): void {
	installMethods(proto, {
		layoutOverflow,
		setCorner,
		applyHeaderClearance,
		paintTransform,
	});
}
