/**
 * The rest of the strip's construction: the pill, grip, recording dot, collapse and More buttons, the slider pops, and the first refresh, layout and resize watch.
 * They are methods of MobileTools, installed on its prototype when MobileTools.ts loads.
 */
import { setIcon } from "obsidian";
import { onPenToolsChanged } from "./PenToolsMode";
import { DEFAULT_PEN, HIGHLIGHTER_PEN } from "../ink/PenStyle";
import { installMethods } from "./InstallMethods";
import { collapsedSession, liveStrips, type MobileToolsHost, type MobileToolsOptions, multToPx, paintValue, pxToMult, type SliderParts, type MobileTools } from "./MobileTools";

declare module "./MobileTools" {
	interface MobileTools {
		buildChrome(parent: HTMLElement, host: MobileToolsHost, opts: MobileToolsOptions): void;
		buildPops(): void;
		finishBuild(parent: HTMLElement, host: MobileToolsHost, preview: boolean): void;
	}
}


	/** The strip's pill, grip, recording dot, collapse button, tool buttons and More row, in order. Called once, from the constructor. */
	function buildChrome(this: MobileTools, parent: HTMLElement, host: MobileToolsHost, opts: MobileToolsOptions): void {
		// The collapsed form: one small pen button that brings the strip back.
		this.pill = parent.createEl("button", {
			cls: "handwriting-pen-pill",
			attr: { "aria-label": "Pen tools", type: "button" },
		});
		// Obsidian's mobile swipe recogniser ignores touch-action and stands down only for a target under
		// `data-ignore-swipe`, so a finger dragging the pill would also open a sidebar or the palette.
		this.pill.dataset.ignoreSwipe = "true";
		setIcon(this.pill, "pen");
		if (!this.pill.querySelector("svg")) this.pill.setText("P");
		// Buttons must not take focus from the editor: undo/redo route to the
		// active editor, and a focus-stealing toolbar makes that a coin flip.
		// preventDefault here kills the compat mouse events that drive CSS
		// :active, so a pressed button showed NOTHING on touch until the click
		// landed at finger-lift (emulation, 2026-08-30). The pressed state is
		// a class managed on the same events instead.
		const noFocus = (el: HTMLElement) => {
			el.addEventListener("pointerdown", (ev) => {
				ev.preventDefault();
				el.classList.add("is-pressed");
				// A contact is a decision, not a hover preview: the diagnosis's
				// probe found a direct-manipulation pen (no hover) fires
				// pointerenter AT CONTACT, marking whatever pop that opened as
				// hover-opened even though the pen has already landed. Clearing
				// both flags here, rather than waiting for the click that
				// normally does it (below), means the close timer armed by this
				// same press's own pointerleave - or by a click that is late or
				// never arrives at all (pointercancel from tap drift) - has
				// nothing left to close.
				this.sliderFromHover = false;
				this.eraserPopFromHover = false;
			});
			const release = () => el.classList.remove("is-pressed");
			el.addEventListener("pointerup", release);
			el.addEventListener("pointerleave", release);
			el.addEventListener("pointercancel", release);
		};
		noFocus(this.pill);
		// The pill has its OWN tip, on the strip's parent beside it. The shared tip lives inside the strip,
		// which is display:none while the strip is folded, so a tip shown from the pill was never painted.
		this.pillTip = parent.createDiv({ cls: "handwriting-pill-tip" });
		this.attachTip(this.pill, () => this.pillTip);
		this.pill.addEventListener("click", (ev) => {
			ev.preventDefault();
			// A DRAG IS NOT A TAP. Pointer capture keeps the whole gesture on
			// the pill, so a drag that started here also ends here and the
			// browser synthesizes a click for it - which would expand the
			// strip at the far end of a gesture that was only ever about
			// moving it. `armDrag` leaves the flag up for exactly this check
			// and clears it on the next contact. A click with no press behind
			// it (`detail` 0: Enter, Space, a screen reader) is not the drop's
			// click: after an Escape mid-drag, or a finger drag, no click ever
			// reaches the pill, and the flag would eat the first keyboard
			// activation instead. The flag is consumed either way.
			const dropClick = this.consumeDragClick();
			if (dropClick && ev.detail !== 0) return;
			this.setCollapsed(false);
		});
		// The pill IS the handle while the strip is folded away: it is the
		// only thing on screen, and a collapsed toolbar is the state a phone
		// spends most of its time in. Same threshold, so the tap above still
		// reads as a tap.
		this.armDrag(this.pill);
		parent.ownerDocument.addEventListener("pointerdown", this.outsideTap, { capture: true });
		parent.ownerDocument.addEventListener("keydown", this.escapeKey, { capture: true });
		parent.ownerDocument.addEventListener("pointerup", this.releaseSlider, { capture: true });
		parent.ownerDocument.addEventListener("pointercancel", this.releaseSlider, { capture: true });
		parent.ownerDocument.addEventListener("pointerup", this.endDrag, { capture: true });
		parent.ownerDocument.addEventListener("pointercancel", this.endDrag, { capture: true });
		parent.ownerDocument.addEventListener("click", this.traceClick, { capture: true });
		this.el = parent.createDiv({ cls: "handwriting-mobile-tools" });
		// The whole strip, its grip and its pops included: see the pill above.
		this.el.dataset.ignoreSwipe = "true";
		// THE GRIP, and it is first so it is the strip's leading end - the row
		// is a plain flex row, so dom order is what the user sees left to
		// right, and the handle of a draggable thing belongs at its edge
		// rather than buried between two buttons.
		//
		// HIDDEN FROM ASSISTIVE TECH, deliberately: an aria-label on a bare
		// div is dropped by most screen readers anyway, and the keyboard route
		// to placement is the settings dropdown, which names all nine anchors. A
		// half-announced handle that cannot be operated is worse than a silent
		// one.
		//
		// A DIV, NOT A BUTTON. Every button on this strip runs a command on
		// click and is reached by the keyboard; the grip does neither - it is
		// a place to put a finger. Making it a button would put a dead stop in
		// the tab order and offer a press that does nothing.
		//
		// The dots are painted by the stylesheet on a fixed-size child rather
		// than by six spans: six elements to draw six dots is six more things
		// for `layoutOverflow` to walk and for a theme to disagree with.
		this.grip = this.el.createDiv({
			cls: "handwriting-tools-grip",
			attr: { "aria-hidden": "true" },
		});
		this.grip.dataset.ignoreSwipe = "true";
		this.grip.createDiv({ cls: "handwriting-tools-grip-dots" });
		this.armDrag(this.grip);
		// The recording indicator lives HERE, not the status bar: status
		// bars get hidden by themes and snippets, and an indicator nobody
		// can see indicates nothing. The strip is the plugin's own chrome.
		// An INDICATOR, not a button - it appears when recording starts and
		// disappears when recording ends, and does nothing when touched.
		this.recordingDot = this.el.createSpan({
			cls: "handwriting-recording-dot",
			attr: {
				"aria-label":
					"from Alan: records how your pen behaves - nothing from your notes 🙈 press and hold to stop",
			},
		});
		// Obsidian's tooltip machinery answers MOUSE hover only - a hovering
		// pen showed nothing (surface, windows ink). And it was not just the
		// dot: EVERY strip button relied on aria-label, so the whole toolbar
		// explained nothing on hover. One shared tip serves them all now,
		// driven by pointerenter, which every input fires. Text comes from
		// each element's aria-label - one source, editable in one place.
		this.tip = this.el.createDiv({ cls: "handwriting-strip-tip" });
		this.recordingDot.setText("●");
		this.attachTip(this.recordingDot);
		// The grip is built first, so that it is the row's leading element,
		// but named here: `attachTip` shows `this.tip`, which did not exist
		// until the line above.
		this.attachTip(this.grip);
		// Touch has no hover and deserves an exit: press and HOLD the dot to
		// stop recording. A hold, not a tap, so a stray finger cannot end a
		// recording someone is mid-way through reproducing a bug for. Runs
		// the real toggle command so every indicator syncs.
		const cancelHold = (): void => this.cancelRecordingHold();
		this.recordingDot.addEventListener("pointerdown", (ev) => {
			ev.preventDefault();
			cancelHold();
			this.recordingHoldTimer = window.setTimeout(() => {
				this.recordingHoldTimer = null;
				this.host.exec("handwriting:toggle-diagnostics");
			}, 600);
		});
		this.recordingDot.addEventListener("pointerup", cancelHold);
		this.recordingDot.addEventListener("pointerleave", cancelHold);
		this.recordingDot.addEventListener("pointercancel", cancelHold);
		const collapse = this.el.createEl("button", {
			cls: "handwriting-mobile-tool handwriting-tools-collapse",
			attr: { "aria-label": "Collapse pen tools", type: "button" },
		});
		this.collapseBtn = collapse;
		setIcon(collapse, "chevron-right");
		if (!collapse.querySelector("svg")) collapse.setText(">");
		noFocus(collapse);
		this.attachTip(collapse);
		collapse.addEventListener("click", (ev) => {
			ev.preventDefault();
			this.setCollapsed(true);
		});
		this.buildButtons(host, opts, noFocus);
		// THE "MORE" BUTTON AND THE SECOND ROW (item 4).
		//
		// Built after every tool button, so the chevron sits at the END of the
		// row where the brief puts it, and so nothing that indexes the strip's
		// children by button position is disturbed by it.
		//
		// Always built, never conditional: `layoutOverflow` runs from a
		// ResizeObserver and has to have somewhere to put a button at the
		// moment it decides to. It shows only when the row does not fit, which
		// is `is-more-needed` below, and a strip that always fits carries two
		// empty elements and no chevron.
		this.moreBtn = this.el.createEl("button", {
			cls: "handwriting-mobile-tool handwriting-tools-more",
			attr: { "aria-label": "More tools", type: "button" },
		});
		setIcon(this.moreBtn, "chevron-down");
		if (!this.moreBtn.querySelector("svg")) this.moreBtn.setText("v");
		noFocus(this.moreBtn);
		this.attachTip(this.moreBtn);
		this.moreBtn.addEventListener("click", (ev) => {
			ev.preventDefault();
			this.setMoreOpen(!this.moreOpen);
		});
		this.moreRow = this.el.createDiv({ cls: "handwriting-mobile-tools-more" });
		// THE RECORDING DOT SITS AT THE ROW'S FAR END, not beside the grip
		// (alan, 2026-09-06: "it already has a pulse, probably move it to
		// trailing or far edge"). It is BUILT up with the grip because the
		// shared tooltip has to be wired before the buttons are made, and
		// MOVED here, once every element that precedes it exists. Nothing
		// else changes: `layoutOverflow` prices it by `offsetWidth` and not
		// by position, and it is still absent from `rowOrder`, so it cannot
		// fold and it still costs the budget the same width when visible.
		// BEFORE the More chevron, not after it: the chevron is the row's own
		// affordance and a test pins it as the last labelled control, so the
		// dot takes the last place a TOOL can hold rather than the last place
		// in the row.
		this.el.insertBefore(this.recordingDot, this.moreBtn);
	}

	/** The three drop-down slider pops and their hover wiring. Called once, from the constructor. */
	function buildPops(this: MobileTools): void {
		// Drop-down sliders. No noFocus here: a range input needs its native
		// pointerdown to start a drag on webkit. Focus loss is tolerable for
		// a slider; a slider that will not slide is not.
		// Each slider rides in a pop with a live value readout: on glass
		// without hover there is otherwise NO feedback while dragging.
		const dropSlider = (
			aria: string,
			min: string,
			max: string,
			step: string,
			onValue: (v: number, commit: boolean) => void,
			/**
			 * Whose pop this is. A nib's pop carries that nib's SWATCH ROW
			 * under the slider (item 1); the eraser passes nothing and gets
			 * the pop it always had. The row's element is built here and
			 * FILLED in `refreshNow`, the same split the old colour pop used:
			 * a palette is tiny, and rebuilding it per refresh is what keeps
			 * the current-colour ring honest without a second listener.
			 */
			tool: "pen" | "highlighter" | null = null
		): SliderParts => {
			const pop = this.el.createDiv({ cls: "handwriting-slider-pop" });
			// FLAT, and the flatness is the whole of the redesign (1.4.12,
			// panel B). The slider used to ride a 28x104 slot ROTATED a
			// quarter turn, with a live number chip under it, and the two of
			// them made the pop half again as tall as everything else in it
			// put together. Unrotated it is one row across the pop's own
			// width: the same range, the same step, more travel than the
			// rotated slot ever had, and a pop that is dramatically shorter
			// hanging over the page. "It's supposed to be small and out of
			// the way, the UI, that's why people like it" (alan, 2026-09-05).
			//
			// A READOUT, on the owner's ruling of 2026-09-06 ("as well", asked
			// whether the number should come back with the rest) - the thumb's
			// own position is feedback, but it is not a number, and "if the
			// number is there then it is easier to set on ones liking", "it
			// will be difficult to remember one like" (a second user, the same
			// day). It goes on its OWN ROW under the track, in a box of fixed
			// width (`.handwriting-slider-num`), never inline beside the
			// track: inline it would eat the travel that widening the pop was
			// for. What makes it safe at all is that the pop's width is
			// declared in the stylesheet now, so nothing the pop holds can
			// move it - see `SliderParts` for the judder this replaces.
			//
			// NO STROKE PREVIEW, though: that was tried and refused. The ink
			// under the pop is already redrawing live as the value moves
			// (`onValue(..., false)` previews on every input event), so a
			// swatch of it inside the pop would be the same information twice,
			// in the one place there is no room for it.
			const input = pop.createEl("input", {
				cls: "handwriting-eraser-slider",
				attr: { type: "range", min, max, step, "aria-label": aria },
			});
			// As Obsidian's own range slider does: a thumb dragged sideways is not a sidebar swipe.
			input.dataset.ignoreSwipe = "true";
			// Under the track and above the hairline, so the nib's pop reads
			// slider, value, saved pens, palette, and the eraser's reads
			// chips, slider, value: the number belongs to the control it
			// describes and to nothing below it.
			const num = pop.createDiv({ cls: "handwriting-slider-num" });
			// A hairline between sections, drawn as its OWN element rather
			// than as a border-top on the row below it. The rows are built
			// once and emptied per refresh, and a nib whose palette or preset
			// row is momentarily empty would otherwise show a rule with
			// nothing under it. An element can simply not be built.
			const rule = (): HTMLElement | null =>
				tool === null ? null : pop.createDiv({ cls: "handwriting-pop-rule" });
			rule();
			// Presets ABOVE the swatches, which is the one placement relation
			// design §10 cares about (a preset is reached before the colour it
			// would otherwise be assembled from), and both below the slider,
			// which is where the slider already was.
			const presets = tool === null ? null : pop.createDiv({ cls: "handwriting-pop-presets" });
			rule();
			const colors = tool === null ? null : pop.createDiv({ cls: "handwriting-pop-colors" });
			// The parts BEFORE the listeners, so the input listener can paint
			// through the same object every other caller of `paintValue`
			// holds. There is one slider per parts object and one parts object
			// per slider; building it here rather than at the return is what
			// lets the two agree without a second reference to the element.
			// From the step, so a control that cannot be set to a hundredth
			// never claims one. `Number(step)` rather than a parse: the
			// callers pass "1", "0.1" and "1" as literals.
			const decimals = Number(step) < 1 ? 1 : 0;
			const parts: SliderParts = { pop, input, tool, colors, presets, num, decimals };
			// Which input is under a finger, for hangUnder's guard. On the
			// input rather than the pop: the eraser's pop carries mode chips
			// too, and pressing one of those is not holding the slider.
			input.addEventListener("pointerdown", () => {
				this.heldSlider = input;
			});
			input.addEventListener("input", () => {
				paintValue(parts);
				onValue(Number(input.value), false);
			});
			input.addEventListener("change", () => onValue(Number(input.value), true));
			return parts;
		};
		this.slider = dropSlider("Eraser size", "3", "64", "1", (v, c) =>
			this.host.setEraserRadiusPx(v, c)
		);
		// The eraser's pop leads with its behavior: Stroke deletes what the
		// ring touches whole, Reticle takes only what it covers. Same
		// setting as the tab, so the two always agree.
		{
			const chips = this.slider.pop.createDiv({ cls: "handwriting-mode-chips" });
			this.slider.pop.insertBefore(chips, this.slider.pop.firstChild);
			const chip = (label: string, whole: boolean): HTMLElement => {
				const el = chips.createEl("button", {
					cls: "handwriting-mode-chip",
					text: label,
					attr: { type: "button" },
				});
				el.addEventListener("pointerdown", (ev) => ev.preventDefault());
				el.addEventListener("click", (ev) => {
					ev.preventDefault();
					this.host.setEraserWholeStroke(whole);
					this.refresh();
				});
				return el;
			};
			this.strokeChip = chip("Stroke", true);
			this.reticleChip = chip("Reticle", false);
		}
		// Bounds are the OLD slider's own multiplier range (0.3-3) times the
		// pen's base width, so dragging to either end of this px slider
		// produces exactly the multiplier the old slider produced at that
		// same end - never a mult outside what clampInkSize already allows.
		// Step 0.1px, not a mechanically converted 0.05 mult (0.11px): the
		// pen's whole range is under 6px, where 0.1px is already a finer
		// grain than the eye can place, and it reads as a round number.
		this.penSlider = dropSlider(
			"Pen size",
			String(multToPx(0.3, DEFAULT_PEN.baseWidth)),
			String(multToPx(3, DEFAULT_PEN.baseWidth)),
			// A grid from this fractional min (0.66) never lands exactly on the
			// default (1x = 2.2px) or the max (3x = 6.6px) at a 0.1 step either -
			// both sat 0.04px off the nearest grid point (item 137). 0.01 divides
			// evenly into both distances from this min, so dragging to either
			// lands on it exactly.
			"0.01",
			(v, c) => this.host.setInkSizeMult("pen", pxToMult(v, DEFAULT_PEN.baseWidth), c),
			"pen"
		);
		// The highlighter runs a narrower range: its base is already wide.
		// Its OWN bounds (0.25x to 29px), not the pen's (0.3-3x) - each
		// nib's pixel range is its own base times its own range, not one
		// shared range. The top is the whole pixel above the "Ink size: bold"
		// step (1.8 x 16 = 28.8px): a lower top made the pop read 24px for a
		// line drawn 28.8px wide, and a touch on the slider then shrank it
		// (Alan, 2026-10-04: the slider reaches 29px, the size is not capped).
		// Step 1px, same grain as the eraser's own integer-px slider, over
		// a 4-29px span wide enough to want it.
		this.hlSlider = dropSlider(
			"Highlighter size",
			String(multToPx(0.25, HIGHLIGHTER_PEN.baseWidth)),
			String(Math.ceil(multToPx(1.8, HIGHLIGHTER_PEN.baseWidth))),
			"1",
			(v, c) => this.host.setInkSizeMult("highlighter", pxToMult(v, HIGHLIGHTER_PEN.baseWidth), c),
			"highlighter"
		);
		for (const pop of [this.slider.pop, this.penSlider.pop, this.hlSlider.pop]) {
			pop.addEventListener("pointerenter", (ev: PointerEvent) => {
				if (ev.pointerType !== "touch") this.cancelSliderClose();
			});
			pop.addEventListener("pointerleave", (ev: PointerEvent) => {
				if (ev.pointerType !== "touch") this.scheduleSliderClose();
			});
			// Same rule as the button's `noFocus` pointerdown above: a contact
			// on the pop itself - dragging the slider, tapping a mode chip - is
			// a decision too. Without this, a hover-opened pop still died 300ms
			// after the pen lifted OFF THE SLIDER: this pop's own pointerleave
			// (above) re-armed the close timer, and nothing had told it the
			// preview was over. The native pointerdown the range input needs
			// for its own drag (see dropSlider's comment) bubbles here first.
			pop.addEventListener("pointerdown", (ev: PointerEvent) => {
				if (ev.pointerType !== "touch") {
					this.sliderFromHover = false;
					this.eraserPopFromHover = false;
				}
			});
		}
	}

	/** The eraser seed, the first refresh, fold and layout passes, and the resize observer. Called once, from the constructor. */
	function finishBuild(this: MobileTools, parent: HTMLElement, host: MobileToolsHost, preview: boolean): void {
		// The tip mode is GLOBAL and this pair of bits is per-strip, so a
		// strip built while the eraser was already on has to be told that it
		// arrived mid-mode rather than watching a switch. Seeded here, before
		// the first refresh, because the constructor's own `refreshNow` is
		// what read the unseeded values and fired the OFF-to-ON edge: every
		// new pane, split and popout opened the eraser's size pop with no
		// user action behind it. `eraserPopClosed` needs seeding too - the
		// edge is not the only route in, since `eraserPopOpen` is true on a
		// fresh strip whose flag still says nothing has closed the pop.
		//
		// With the eraser off both values are the ones the fields already
		// declare, and the switch that turns it on later is still the real
		// edge - which is the route this must not take away.
		this.wasEraserOn = host.eraserOn();
		this.eraserPopClosed = this.wasEraserOn;
		this.refreshNow();
		// A preview is born expanded and tells the session nothing about it:
		// `setCollapsed` writes `collapsedSession`, which every real strip in
		// the window reads. See `MobileToolsOptions.preview`.
		if (!preview) this.setCollapsed(collapsedSession);
		// ON LAYOUT and on resize (item 4). The first pass runs here, after
		// the strip is in the tree and has widths to read; the observer
		// catches every later change - rotation, a split pane being dragged,
		// the sidebar opening, a popout being resized.
		//
		// Observe the two INPUTS, never the strip. The parent's width is the
		// available room; the collapse button's width is the grid cell. The
		// latter matters at startup: Obsidian can construct the plugin before
		// its stylesheet settles, while the button's screen-reader label is
		// still in flow and makes the first cell measurement about 175px. The
		// stylesheet then makes the button 40px without resizing the absolutely
		// positioned strip's parent. Watching the button repairs that stale
		// plan; watching the strip would feed this calculation's own output back
		// into itself whenever folding changed its width.
		// In the tree and measurable, so it can be re-folded from here on: the
		// fold order is a setting, and a change to it has to reach the strips
		// that are already open. Dropped again in `destroy()`.
		liveStrips.add(this);
		if (!preview) this.stopModeWatch = onPenToolsChanged(() => this.setInking(this.inking));
		this.layoutOverflow();
		// Item 5 rides the same two triggers as item 4 - a first pass now, and
		// the observer below - because they answer the same question about the
		// same pane: how much room there is and who else is using it. A pane
		// that gets narrower moves the actions row under the strip just as
		// surely as it makes the row too wide.
		if (!preview) this.applyHeaderClearance();
		const win = this.el.ownerDocument.defaultView;
		const Observer = (win as { ResizeObserver?: new (cb: () => void) => { observe(el: Element): void; disconnect(): void } } | null)
			?.ResizeObserver;
		// Guarded, not assumed: this class is constructed under a suite with
		// no DOM at all, and a strip that throws in its constructor takes the
		// pen down with it - the iPad lesson this file's every other bulkhead
		// was written for. The presence check covers the suite (no
		// `ResizeObserver` on the fake window at all); the try/catch covers a
		// real engine refusing the element, which is the case a presence
		// check cannot see.
		if (Observer) {
			try {
				const watch = new Observer(() => {
					this.layoutOverflow();
					if (!preview) this.applyHeaderClearance();
				});
				watch.observe(parent);
				watch.observe(this.collapseBtn);
				this.resizeWatch = watch;
			} catch (err) {
				console.error("[handwriting] strip overflow observer failed", err);
			}
		}
	}

export function installMobileToolsBuildRest(proto: MobileTools): void {
	installMethods(proto, {
		buildChrome,
		buildPops,
		finishBuild,
	});
}
