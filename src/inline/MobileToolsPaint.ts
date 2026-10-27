/**
 * The strip's refresh and paint: the coalesced refresh, the full repaint of every button, pop and slider, and the preset and swatch rows.
 * They are methods of MobileTools, installed on its prototype when MobileTools.ts loads.
 */
import { setIcon } from "obsidian";
import { popRightOffset } from "./PopPlacement";
import { DEFAULT_PEN, HIGHLIGHTER_PEN } from "../ink/PenStyle";
import { presetChips, starReplaces } from "../ink/InkPresets";
import { nibInkColor, PEN_INK_TOGGLE } from "./MobileToolsButtons";
import { installMethods } from "./InstallMethods";
import { eraserEdge, multToPx, paintValue, type SliderParts, type MobileTools } from "./MobileTools";

declare module "./MobileTools" {
	interface MobileTools {
		refresh(): void;
		refreshNow(): void;
		paintPresets(slider: SliderParts): void;
		paintSwatches(slider: SliderParts): void;
	}
}


	/**
	 * Coalesced, off-the-input-handler refresh: pen-up and pen-down call
	 * this from latency-critical handlers, and the body does forced layout
	 * reads (hangUnder measures offsets). One rAF defers the work past the
	 * stroke's frame and collapses bursts into a single pass.
	 */
	function refresh(this: MobileTools): void {
		if (this.refreshQueued) return;
		this.refreshQueued = true;
		// The strip's own window, so a popout editor ticks on its own frames.
		(this.el.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
			this.refreshQueued = false;
			this.refreshNow();
		});
	}

	/** The synchronous body; the constructor uses it before first paint. */
	function refreshNow(this: MobileTools): void {
		this.viewportControls?.refresh();

		const recording = this.host.recordingOn();
		this.recordingDot.toggleClass("is-recording", recording);
		// The dot takes a cell of the row's budget while it shows, and it shows only under this class, so the
		// fold has to be planned again when the class flips: a strip that fit without it may not fit with it.
		if (recording !== this.recordingShown) {
			this.recordingShown = recording;
			this.layoutOverflow();
		}
		for (const { el, spec } of this.buttons) {
			// The lights follow the TOOL state and nothing else. They used to
			// dim for a text-mode mouse, keyed off the last pointer type seen
			// - but hover events on a Surface arrive mouse-flavoured even
			// from a pen, so the eraser's light died under a hovering pen and
			// came back when the nib touched the editor (glass, 2026-08-31).
			// The mouse is just a pen here; pointer type is not state. isLit
			// (falling back to isActive) rather than isActive alone: a mouse
			// user who just clicked the lit pen button to hand the mouse back
			// to text must see the light go out too (alan, 2026-09-02) - see
			// isLit's doc comment on ButtonSpec for why this is a separate
			// field from the one the click chain below still branches on.
			el.classList.toggle("is-active", (spec.isLit ?? spec.isActive)?.(this.host) ?? false);
			const enabled = spec.isEnabled?.(this.host) ?? true;
			el.classList.toggle("is-disabled", !enabled);
			// The dimming is for eyes only; this is the same fact for anything
			// that cannot see it. aria-disabled rather than the disabled
			// property on purpose: a disabled button is skipped by the
			// keyboard and stops firing hover, and the tooltip explaining WHY
			// it is unavailable is the part worth keeping.
			el.setAttribute("aria-disabled", enabled ? "false" : "true");
			// A TINTED button answers "which colour" by BEING it. This was the
			// palette button's trick and it is the two nibs' now - they wear
			// their own ink at all times, so a glance at the strip says what
			// the pen will draw with (alan, 2026-09-05).
			//
			// Off `spec.inkTool` rather than a `commandId ===` branch: there
			// are two of these, and the branch this replaced had been written
			// for exactly one button.
			if (spec.inkTool !== undefined) {
				const hex = this.host.toolColor(spec.inkTool);
				el.setCssStyles({ color: nibInkColor(hex) });
				// The tooltip names the colour beside the tool - the tinted
				// icon says WHICH colour and cannot say its name, and "Pen"
				// alone told a hover nothing about the ink it is holding
				// (the palette button's own rule, alan, 2026-08-31, moved
				// here with the tint). The label is read at hover time, so
				// keeping the dataset current is all it takes; the sr-only
				// span is the same name for screen readers, which get the
				// colour they cannot see.
				const colour = this.host
					.paletteFor(spec.inkTool)
					.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name;
				const label = colour ? `${spec.label}: ${colour}` : spec.label;
				if (el.dataset.tipLabel !== label) {
					el.dataset.tipLabel = label;
					const sr = el.querySelector(".handwriting-sr-only");
					if (sr) sr.textContent = label;
				}
			}
		}
		// The collapsed pill wears the tool in hand.
		//
		// It used to be a pen, set once when the strip was built and never
		// touched again, labelled "Pen tools" forever. The pill is what is on
		// screen WHILE YOU WRITE - the strip is collapsed precisely then - so
		// the one moment the active tool matters most was the one moment
		// nothing said what it was, while the open strip goes to real trouble
		// to show it (the palette button is tinted with the live color and
		// names it on hover).
		//
		// Taken from the button that reports itself active rather than from a
		// second switch on the modes: one source of truth, and a tool added to
		// BUTTONS later is carried here without anyone remembering to.
		{
			// Same isLit-falls-back-to-isActive read as the per-button light
			// above (literally the same expression there, so it moves here
			// too): the pill must not keep wearing "Pen" once a mouse click
			// has handed the mouse back to text and no nib is actually
			// inking - it falls through to the generic "Pen tools" default
			// below, same as when eraser/lasso/space/pan all read false.
			//
			// PEN OFF WINS IT OUTRIGHT, and it is the one state that gets to.
			// The scan below finds the first LIT button, and the two nibs come
			// first. This branch used to be the ONLY thing keeping a pen icon
			// off the pill in keyboard mode, because `nibIsLit` kept reading
			// true while the pen was off; since 2026-09-06 it does not (see
			// `penDrawsHere`), so for a pen user the scan now finds no nib lit
			// here either and the two agree instead of one covering for the
			// other. The branch stays, and still wins outright, because
			// agreeing on DARK is not the same as saying WHY: the pill is what
			// is on screen while the strip is folded, which is exactly when
			// someone wonders why their pen stopped drawing, and it must name
			// the state rather than fall through to the generic "Pen tools"
			// default. It also still carries the one case where the two are
			// MEANT to differ: a pen user who has ALSO armed mouse ink by
			// name, whose nib stays honestly lit in keyboard mode because
			// their mouse really does still draw there - the pill says "Pen
			// off" over the top of it, which is the truth about the PEN that
			// a folded strip is being asked for. Design §5 asks for
			// the keyboard icon for the same reason. The label says the state
			// rather than naming a tool - "Keyboard tools" would read as one
			// more tool - so a hover or a screen reader gets the answer in two
			// words.
			//
			// Through the host, same reason as the button's own isActive: a
			// surface that keeps inking while the flag is off must not borrow
			// the "Pen off" wording, and the host is the only thing that can
			// say so. Both real surfaces honour the flag today, so both wear
			// the pill.
			const penOffBtn = this.host.penInksHere()
				? undefined
				: this.buttons.find(({ spec }) => spec.commandId === PEN_INK_TOGGLE);
			const active =
				penOffBtn ?? this.buttons.find(({ spec }) => (spec.isLit ?? spec.isActive)?.(this.host));
			const icon = active?.spec.icon ?? "pen";
			const label = penOffBtn ? "Pen off" : active ? `${active.spec.label} tools` : "Pen tools";
			if (this.pill.dataset.icon !== icon) {
				this.pill.dataset.icon = icon;
				// Emptied FIRST: setIcon APPENDS an svg, it does not replace
				// the button's children, so the pill wore every tool it had
				// ever been at once - a pen and a highlighter overlapping in
				// the one circle (alan and samuelbits, with screenshots;
				// there since the pill started following the tool in hand).
				// This comment used to assert the opposite, which is what
				// stopped anyone checking. Same sweep, for the same reason,
				// as the chevron gets in setCorner. It takes the sr-only
				// name attachTip left there with it, so that goes back in
				// the same move, or the pill goes quiet for a screen reader
				// the first time the tool changes.
				this.pill.empty();
				setIcon(this.pill, icon);
				if (!this.pill.querySelector("svg")) this.pill.setText(active?.spec.glyph ?? "P");
				this.pill.createSpan({ cls: "handwriting-sr-only", text: label });
			}
			// The tooltip reads this, not aria-label: ownName moves the name
			// off the attribute so the tip and the screen reader do not say it
			// twice.
			if (this.pill.dataset.tipLabel !== label) {
				this.pill.dataset.tipLabel = label;
				const sr = this.pill.querySelector(".handwriting-sr-only");
				if (sr) sr.textContent = label;
			}
		}
		// Hang a drop-down under its button, measured live so it survives
		// the strip wrapping on narrow screens.
		const hangUnder = (
			slider: SliderParts,
			commandId: string,
			show: boolean,
			value: number
		) => {
			slider.pop.toggleClass("is-showing", show);
			if (!show) return;
			// Never into a control the user is holding. The placement below
			// still has to run - the strip can wrap under an open pop - but
			// the VALUE belongs to the finger until it lifts. Any refresh
			// landing mid-drag would otherwise write over the drag: a hover
			// preview on the next button along, the 300ms close timer, or any
			// command that refreshes every strip.
			if (this.heldSlider !== slider.input) slider.input.value = String(value);
			// UNCONDITIONAL, outside the guard above, because it reads the
			// input's OWN value: held or not, the readout says what the
			// control holds, which is the dragged value mid-drag and the
			// written one after. A refresh that did not touch the input
			// writes nothing at all - `paintValue` compares before it sets.
			paintValue(slider);
			// The colours, for a nib's pop: rebuilt while it is SHOWING, which
			// is the same budget the old colour pop worked to (a palette is
			// eight buttons) and the same reason - a rebuild is what keeps the
			// current-colour ring honest with no second listener watching the
			// setting. Nothing is built for a pop that is shut, so the eraser's
			// pop and the nib pop that is not up cost nothing.
			this.paintPresets(slider);
			this.paintSwatches(slider);
			const btn = this.buttons.find((b) => b.spec.commandId === commandId)?.el;
			if (btn) {
				// Measured rects, and CENTERED under the button: the offset
				// arithmetic drifted a full button's width in the bottom-left
				// corner (glass, 2026-08-31). The pop is visible by here, so
				// its width is real.
				// The arithmetic is `popRightOffset` (PopPlacement.ts) so the nine
				// anchors can be pinned without a layout; this is the measuring.
				// The PANE is measured too now: the old `Math.max(0, right)`
				// clamped the pop to the strip's own right edge, which is nearly
				// the pane's edge in a right-hand corner and nowhere near it for
				// a centred strip - so a centre-column anchor could hang a wide pop off
				// the side of the pane.
				const right = popRightOffset({
					strip: this.el.getBoundingClientRect(),
					button: btn.getBoundingClientRect(),
					popWidth: slider.pop.offsetWidth,
					pane: this.pane.getBoundingClientRect(),
				});
				slider.pop.setCssStyles({ right: `${right}px` });
			}
		};
		const whole = this.host.eraserWholeStroke();
		this.strokeChip.toggleClass("is-current", whole);
		this.reticleChip.toggleClass("is-current", !whole);
		// The strip button's own click handler now resets `eraserPopClosed`
		// too (a re-tap while active toggles it, mirroring the nib
		// branches), but that only covers the strip: the palette command and
		// a hotkey both call `handwriting:inline-tool-eraser` directly
		// (main.ts's `on = !getInlineEraserMode()`, the "inline-tool-eraser"
		// command) without passing through this file at all. The OFF-to-ON
		// edge watched here is what catches those two paths alike; the strip
		// button's own click just gets there first.
		const eraserOn = this.host.eraserOn();
		if (eraserOn && !this.wasEraserOn) {
			this.eraserPopClosed = eraserEdge.owner !== null && eraserEdge.owner !== this;
			// A fresh activation opened this, not a hover in flight - a stale
			// `true` here would let a leave timer from a previous session
			// wrongly close the pop this edge just opened.
			this.eraserPopFromHover = false;
		}
		this.wasEraserOn = eraserOn;
		if (!eraserOn) eraserEdge.owner = null;
		hangUnder(
			this.slider,
			"handwriting:inline-tool-eraser",
			// The eraser slider rides the MODE, not a toggle. `eraserPopOpen`
			// folds in `eraserOn()` plus the one bit `closeInkSliders` sets to
			// suppress the pop without touching the mode (hasOpenPop, above;
			// every caller of closeInkSliders - pen contact, an outside tap,
			// Escape - sets it alike). Its `!colorsOpen` conjunct went with
			// the colour pop: there is no longer a separate pop that could
			// open next to this one and have to be stepped aside for.
			this.eraserPopOpen(),
			this.host.eraserRadiusPx()
		);
		const nib = this.host.eraserOn() ? null : this.openInkSlider;
		hangUnder(
			this.penSlider,
			"handwriting:inline-tool-pen",
			nib === "pen" && this.host.activeTool() === "pen",
			multToPx(this.host.inkSizeMult("pen"), DEFAULT_PEN.baseWidth)
		);
		hangUnder(
			this.hlSlider,
			"handwriting:inline-tool-highlighter",
			nib === "highlighter" && this.host.activeTool() === "highlighter",
			multToPx(this.host.inkSizeMult("highlighter"), HIGHLIGHTER_PEN.baseWidth)
		);
	}

	/**
	 * The quick-pen row at the top of one nib's pop: up to four chips in
	 * their own colours, sized by their own widths, then the star that saves
	 * the pair in hand (design §4, §10).
	 *
	 * Rebuilt per refresh while the pop shows, the same budget and the same
	 * reason as the swatches under it: the ring that says "this is the pen
	 * you are holding" has to follow a colour or size changed by any route -
	 * a swatch, the slider, a hotkey - and a rebuild is what keeps it honest
	 * without a listener per pop.
	 *
	 * The whole row goes through the ACTION HOOK (`applyPreset` and friends
	 * on the host), never through the preset commands: those register only
	 * behind "Extra commands for hotkeys", and a row of chips that did
	 * nothing on a fresh install is exactly the dead palette this file's
	 * `pickColor` comment was written after.
	 */
	function paintPresets(this: MobileTools, slider: SliderParts): void {
		const row = slider.presets;
		const tool = slider.tool;
		if (!row || tool === null) return;
		// BEFORE `empty()`, and this order is the fix rather than a tidiness:
		// the chips about to be destroyed own the pointer listeners that would
		// cancel their own hold, so a timer left armed here fires after its
		// button is gone and calls `forgetPreset` with an index that now names
		// a different pen.
		this.cancelPresetHold();
		row.empty();
		const presets = this.host.presetsFor(tool);
		const chips = presetChips(presets, this.host.toolColor(tool), this.host.inkSizeMult(tool));
		for (const chip of chips) {
			const btn = row.createEl("button", {
				cls: "handwriting-preset-chip",
				attr: { "aria-label": chip.label, type: "button" },
			});
			btn.toggleClass("is-current", chip.current);
			// The dot lives INSIDE the button: the button is a constant
			// 22px hit target whatever the preset's width, so a fine pen's
			// chip is no harder to hit than a bold one's. A dot drawn by
			// resizing the button itself would have made the finest preset
			// the smallest target on the strip.
			const dot = btn.createDiv({ cls: "handwriting-preset-dot" });
			dot.setCssStyles({
				backgroundColor: chip.hex,
				width: `${chip.dotPx}px`,
				height: `${chip.dotPx}px`,
			});
			// One hold timer per chip, the recording dot's shape: press and
			// hold 600ms to forget. `held` is what stops the pointerup's
			// click from then APPLYING the preset the hold just removed.
			let held = false;
			const cancelHold = (): void => this.cancelPresetHold();
			btn.addEventListener("pointerdown", (ev) => {
				// The same guard every control in this pop uses: a contact
				// here is a decision about the strip, and must not reach the
				// ink surface underneath as the start of a stroke.
				ev.preventDefault();
				held = false;
				this.suppressNextPresetContextMenu = false;
				this.suppressNextPresetClick = false;
				cancelHold();
				this.presetHoldTimer = window.setTimeout(() => {
					this.presetHoldTimer = null;
					held = true;
					this.host.forgetPreset(tool, chip.index);
					// The release's contextmenu, still to come, must not land
					// on whatever fresh button the rebuild below puts under
					// the finger (item 73).
					this.suppressNextPresetContextMenu = true;
					this.suppressNextPresetClick = true;
					// In place: the pop stays open and the row redraws
					// without it, so a second unwanted preset is one more
					// hold away rather than a re-open.
					this.refresh();
				}, 600);
			});
			btn.addEventListener("pointerup", cancelHold);
			btn.addEventListener("pointerleave", cancelHold);
			btn.addEventListener("pointercancel", cancelHold);
			btn.addEventListener("contextmenu", (ev) => {
				// The mouse's half of the same gesture. preventDefault so the
				// app's own context menu does not open over the pop.
				ev.preventDefault();
				cancelHold();
				// STRIP-LEVEL GUARD FIRST (item 73): a hold that already fired
				// rebuilds the row before the release, so this contextmenu may
				// be landing on a BRAND NEW button - the former neighbour's,
				// shifted into this screen slot - whose own `held` closure
				// knows nothing about the hold that just ran. The flag lives
				// on the strip, not the chip, so it survives the rebuild.
				if (this.suppressNextPresetContextMenu) {
					this.suppressNextPresetContextMenu = false;
					return;
				}
				// ONE GUARD PER CHIP, not two independent triggers: on Windows
				// pen and touch a long press fires BOTH the 600ms hold timer
				// above AND this contextmenu handler once the finger lifts, and
				// both used to call forgetPreset unconditionally - one long
				// press could delete two presets (auditor, 2026-09-05). `held`
				// is already true here if the timer got there first, so this
				// branch is the one that stands down; a contextmenu that
				// arrives FIRST (a plain mouse right-click, no hold in
				// progress) still forgets, exactly as before. The mark clears
				// on the chip's next pointerdown, above.
				if (held) return;
				held = true;
				this.host.forgetPreset(tool, chip.index);
				this.refresh();
			});
			btn.addEventListener("click", (ev) => {
				ev.preventDefault();
				const releaseOfHold = this.consumePresetHoldClick(ev);
				if (held || releaseOfHold) {
					held = false;
					return;
				}
				this.host.applyPreset(tool, chip.index);
				// The pop CLOSES here, where a swatch leaves it open: a
				// swatch is half a choice and the slider beside it is the
				// other half, but a preset is the whole pen. Design §4:
				// "pen colour and size become the preset's, pop closes".
				this.closeInkSliders();
			});
		}
		const star = row.createEl("button", {
			cls: "handwriting-preset-star",
			attr: {
				"aria-label": starReplaces(presets)
					? "Star this pen, replacing the last preset"
					: "Star this pen",
				type: "button",
			},
		});
		// Never disabled, not even with four saved: a fifth star is a
		// legitimate thing to want, and `addPreset` has a rule for it
		// (replace the last). The label is what says so.
		// The icon set's star, with a glyph fallback the same way the collapse
		// chevron falls back to ">": an icon pack that lacks a name must not
		// leave a nameless empty button in the row.
		setIcon(star, "star");
		if (!star.querySelector("svg")) star.setText("*");
		star.addEventListener("pointerdown", (ev) => {
			ev.preventDefault();
			this.suppressNextPresetClick = false;
		});
		star.addEventListener("click", (ev) => {
			ev.preventDefault();
			if (this.consumePresetHoldClick(ev)) return;
			this.host.starPreset(tool);
			// Stays open, unlike a chip tap: the new chip appearing in the
			// row is the confirmation that the star worked.
			this.refresh();
		});
	}

	/**
	 * The swatch row inside one nib's pop: that nib's own palette, the
	 * current colour ringed, each swatch applying its colour and closing
	 * nothing else.
	 *
	 * Rebuilt on every refresh the pop is showing for, exactly as the old
	 * standalone colour pop was: a palette is eight buttons, and rebuilding
	 * is what keeps the `is-current` ring true without a listener watching
	 * the setting from the outside.
	 *
	 * `pickColor` is not parameterised by tool and does not need to be. It
	 * applies to `getInlineTool()` on both surfaces, and `hangUnder` only
	 * ever shows a nib's pop while `activeTool()` IS that nib - so the tool
	 * whose swatch was tapped and the tool the host applies to are the same
	 * one by construction. See `MobileToolsHost.pickColor`.
	 */
	function paintSwatches(this: MobileTools, slider: SliderParts): void {
		const row = slider.colors;
		const tool = slider.tool;
		if (!row || tool === null) return;
		row.empty();
		const current = this.host.toolColor(tool);
		for (const c of this.host.paletteFor(tool)) {
			const sw = row.createEl("button", {
				cls: "handwriting-color-swatch",
				attr: { "aria-label": c.name, type: "button" },
			});
			sw.setCssStyles({ backgroundColor: c.hex });
			sw.toggleClass("is-current", c.hex.toLowerCase() === current.toLowerCase());
			sw.addEventListener("pointerdown", (ev) => ev.preventDefault());
			sw.addEventListener("click", (ev) => {
				ev.preventDefault();
				// Not through the per-name commands: those live behind an
				// off-by-default setting, and a palette that only works when
				// a hidden toggle is on is a dead palette.
				this.host.pickColor(c.name, c.hex);
				// The pop STAYS OPEN, where the old colour pop closed itself.
				// It closed because it was a pop of its own and picking a
				// colour was the whole of what it was for; this row shares a
				// pop with the size slider, and shutting that under the finger
				// because a swatch was tapped would take the size control away
				// mid-adjustment. Pen contact, an outside tap and Escape close
				// it, the same as they always have.
				this.refresh();
			});
		}
	}

export function installMobileToolsPaint(proto: MobileTools): void {
	installMethods(proto, {
		refresh,
		refreshNow,
		paintPresets,
		paintSwatches,
	});
}
