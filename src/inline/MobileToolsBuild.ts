/**
 * The strip's tool buttons: one per spec, built in order into the row, with their pointer, click and hold handlers.
 * It is a method of MobileTools, installed on its prototype when MobileTools.ts loads.
 */
import { setIcon } from "obsidian";
import { markMousePutDown, markToolPicked } from "./MouseInk";
import { penInkEnabled, setPenInk } from "./PenInk";
import { BUTTONS, mouseDrawsHere, PEN_INK_TOGGLE } from "./MobileToolsButtons";
import { installMethods } from "./InstallMethods";
import { eraserEdge, type MobileToolsHost, type MobileToolsOptions, type MobileTools } from "./MobileTools";

declare module "./MobileTools" {
	interface MobileTools {
		buildButtons(host: MobileToolsHost, opts: MobileToolsOptions, noFocus: (el: HTMLElement) => void): void;
	}
}


	/** The strip's tool buttons, one per spec in order, appended to the row. Called once, from the constructor. */
	function buildButtons(this: MobileTools, host: MobileToolsHost, opts: MobileToolsOptions, noFocus: (el: HTMLElement) => void): void {
		for (const spec of [...BUTTONS, ...(opts.additionalButtons ?? [])]) {
			if (opts.supportedCommands && !opts.supportedCommands.has(spec.commandId)) continue;
			// AHEAD of the divider, so a skipped button that opens a group
			// cannot leave an orphan divider standing where it was. Neither
			// of today's two skippable buttons starts a group - Pan sits mid
			// tip-group and Keyboard closes it - so this changes no divider
			// yet; it is written this way because the next one might.
			if (!(spec.shownOn?.(host) ?? true)) continue;
			if (spec.startsGroup) {
				this.rowOrder.push(this.el.createDiv({ cls: "handwriting-mobile-tools-divider" }));
			}
			const b = this.el.createEl("button", {
				cls: "handwriting-mobile-tool",
				attr: { "aria-label": spec.label, type: "button" },
			});
			this.rowOrder.push(b);
			setIcon(b, spec.icon);
			// If the icon set yields no svg, the button says its initial.
			if (!b.querySelector("svg")) b.setText(spec.glyph);
			noFocus(b);
			// Older WebKit sends a plain MouseEvent for click. Keep the type of
			// this button's contact so its click still takes the touch path.
			let contactType: string | null = null;
			b.addEventListener("pointerdown", (ev) => { contactType = ev.pointerType; });
			b.addEventListener("pointercancel", () => { contactType = null; });
			b.addEventListener("pointerenter", (ev) => {
				if (ev.pointerType === "touch") return;
				const hoverNib =
					spec.commandId === "handwriting:inline-tool-pen"
						? "pen"
						: spec.commandId === "handwriting:inline-tool-highlighter"
							? "highlighter"
							: null;
				// THE LIT predicate, not the active one (alan, 2026-09-03: "plain
				// mouse without mouse ink armed should not open the slider
				// popout, correct?" - he is right). `isActive` means "the
				// NOMINAL tool" and deliberately ignores mouse ink, so a plain
				// mouse with ink off used to hover the Pen button and be handed
				// a size slider for a tool that cannot lay down a stroke. Same
				// family as the dead-looking button that produced
				// `armMouseInkQuietly`, and the light was already telling the
				// truth beside it - this is the preview catching up to it.
				//
				// `spec.isLit ?? spec.isActive` is the render path's own
				// resolution (:1046 and the pill at :1093), so a button with no
				// `isLit` of its own - every one but the two nibs - is
				// untouched, and the eraser's preview branch below keeps its
				// separate §5p ruling.
				//
				// HOVER ONLY. The click path below still branches on `isActive`
				// and must: clicking an unlit nib is exactly how a mouse user
				// arms mouse ink (the final `else`'s `armMouseInkQuietly`), and
				// gating that would leave them no way in at all. Hover previews,
				// click decides.
				if (hoverNib && (spec.isLit ?? spec.isActive)?.(this.host)) {
					// The `if (this.colorsOpen) return` that used to guard this -
					// "crossing this button on the way to the palette must not
					// close what a CLICK opened" - guarded a pop that no longer
					// exists. The colours are a row inside the pop this branch
					// opens, so there is nothing left for a hover to cross to.
					this.cancelSliderClose();
					if (this.openInkSlider !== hoverNib) {
						this.openInkSlider = hoverNib;
						this.sliderFromHover = true;
						this.refresh();
					}
					return;
				}
				// The eraser has no slot in `hoverNib` - its pop rides
				// `eraserPopClosed`, not `openInkSlider` - so it needs its own
				// preview branch, and MOUSE ONLY (§5p AI CONFIRMED, item 1).
				// Pen is not excluded above, only touch is, so a pen reaches
				// this point too; it is turned away here on purpose, and the
				// reason is stronger than it was. The eraser's tap branch
				// below reads the pop's state: with the pop SHOWING, a
				// pen/touch press on the active eraser falls through to
				// exec() and switches the tool off. So a pen hover that
				// opened the pop first would turn the tap that followed it
				// into a tool-off - the pointer merely crossing the button on
				// its way there would change what pressing it does. The nib
				// case above has no such hazard: its pen branch only confirms
				// the slider open, and re-tapping a nib never puts it down.
				if (
					ev.pointerType === "mouse" &&
					spec.commandId === "handwriting:inline-tool-eraser" &&
					spec.isActive?.(this.host)
				) {
					this.cancelSliderClose();
					if (this.eraserPopClosed) {
						this.eraserPopClosed = false;
						this.eraserPopFromHover = true;
						this.refresh();
					}
				}
			});
			b.addEventListener("pointerleave", (ev) => {
				if (ev.pointerType === "touch") return;
				this.scheduleSliderClose();
			});
			b.addEventListener("click", (ev) => {
				ev.preventDefault();
				// A button drawn as unavailable must BE unavailable. Delete,
				// copy, paste, undo and redo dim to 0.35 when their predicate
				// says no, but nothing used to stop the click: the command ran
				// and answered with a toast saying what the dimming had
				// already said - "lasso some ink first" on a button greyed out
				// precisely because there is no selection. Worse, the press
				// animation is suppressed for a dimmed button, so it felt dead
				// and then scolded you.
				//
				// Guarded here rather than with pointer-events: none, which
				// would also take the tooltip away. A disabled control that
				// still explains itself on hover is the more useful one.
				//
				// The refresh on the way out is the whole reason this branch
				// is not just `return` (design doc §5i, C16). `isEnabled` is
				// read LIVE here; `is-disabled` is a class written by
				// `refresh()` and left alone until the next one, and nothing
				// on this surface refreshes the strip when the document
				// changes. So Redo lights after an undo, a keystroke drops
				// CodeMirror's redo stack, and the button goes on LOOKING
				// available while its predicate says no - and the bare return
				// skipped the trailing refresh at the bottom of this handler,
				// so it kept looking available and kept doing nothing on
				// every press after that. Refreshing here recomputes the
				// class from the same live predicate the guard just asked,
				// which costs one wasted press and then the button tells the
				// truth. Deliberately NOT a toast: the user asked for nothing
				// and a notice for pressing a button that looked pressable is
				// noise (the eraser/Backspace ruling, 2026-09-02). The button
				// stops lying rather than explaining itself.
				if (!(spec.isEnabled?.(this.host) ?? true)) {
					this.refresh();
					return;
				}
				if (spec.commandId === "handwriting:inline-tool-eraser") eraserEdge.owner = this;
				// The GoodNotes pattern: tapping the tool you are already
				// holding opens its options instead of re-picking it.
				const nib =
					spec.commandId === "handwriting:inline-tool-pen"
						? "pen"
						: spec.commandId === "handwriting:inline-tool-highlighter"
							? "highlighter"
							: null;
				// A mouse only draws because its owner has no pen, so for
				// them the nib button IS the mode: clicking the active tool
				// hands the mouse back to text. Pen and touch keep the tap
				// (hover already opened the slider for anything that hovers).
				// A synthetic click has no pointerdown. On a touch device, a
				// legacy WebKit click with no pointerType is a finger tap unless a
				// preceding pointerdown identified a mouse or pen.
				const ptr = ev.pointerType || contactType || (this.host.hasTouch() ? "touch" : "mouse");
				contactType = null;
				const claimsTip =
					nib !== null ||
					spec.commandId === "handwriting:inline-tool-eraser" ||
					spec.commandId === "handwriting:inline-tool-lasso" ||
					spec.commandId === "handwriting:inline-tool-space" ||
					spec.commandId === "handwriting:inline-tool-pan";
				// `mouseDrawsHere`, not `mouseInkOn()`: on a pen-less device the
				// mouse draws because a tool is PICKED, with nothing armed, so
				// the old guard left that user's lit button unable to put
				// itself down at all.
				if (claimsTip && !this.host.penInksHere()) {
					// A paused tool is selected, not put down. Run Pen while still
					// paused so its command cannot toggle a newly lit pen off.
					if (nib === "pen" || !spec.isActive?.(this.host)) this.host.exec(spec.commandId);
					markToolPicked();
					if (!this.host.penInksHere()) this.host.exec(PEN_INK_TOGGLE);
					if (ptr === "mouse" && !this.host.mouseInkOn()) this.host.armMouseInkQuietly();
					if (nib) this.host.prepareFingerInk?.();
					this.host.setEditorFocus(false);
					// The iPhone first-tap rule (below: a tap that GRANTS a nib
					// its first ink, rather than adjusting one already drawing,
					// picks the tool without opening its pop) applies here too.
					// Leaving Keyboard mode reaches THIS branch, not that one -
					// ink is off in Keyboard mode, so `!penInksHere()` is true
					// and this branch runs first - so without this check the
					// pop opened over the note on every Keyboard exit (item 200).
					const iphoneFirstTap =
						nib !== null && ptr === "touch" && (this.host.fingerInkAvailable?.() ?? false);
					this.openInkSlider = iphoneFirstTap ? null : nib;
					this.sliderFromHover = false;
					if (spec.commandId === "handwriting:inline-tool-eraser") {
						this.eraserPopClosed = false;
						this.eraserPopFromHover = false;
					}
				} else if (
					nib &&
					ptr === "touch" &&
					(this.host.fingerInkAvailable?.() ?? false) &&
					!(spec.isLit ?? spec.isActive)?.(this.host)
				) {
					// On iPhone an apparent/default nib is not a grant. Its first
					// tap must pick the tool (or re-enter from Keyboard), not open
					// an options pop for a tool that cannot draw yet.
					this.host.exec(spec.commandId);
					setPenInk(true);
					this.host.prepareFingerInk?.();
					this.host.setEditorFocus(false);
					this.openInkSlider = null;
					this.sliderFromHover = false;
				} else if (nib && spec.isActive?.(this.host) && ptr === "mouse" && mouseDrawsHere(this.host)) {
					// Clicking the tool you are drawing with hands the mouse
					// back to text. Click it again and it draws again.
					//
					// QUIET, SINCE 1.4.10. This used to call `host.setMouseInk
					// (false)`, which both surfaces wired to the LOUD toggle
					// command - so putting the nib down wrote `mouseInk: false`
					// to data.json, and picking it back up wrote `true`. That
					// is the fourth path the "dont persist a quiet arm" ruling
					// (alan, 2026-09-04) was about and the one it missed: the
					// two edges below are the same session-only edges the four
					// tip tools take, and the rule is now written once for all
					// six buttons. Someone who turned the mode on BY NAME still
					// has it tomorrow; a nib click moves this session's pointer
					// and nothing else.
					//
					// The LIGHT is unchanged, which is the point of routing
					// through the wrappers rather than the bare module
					// functions: `releaseMouseInkQuietlyEverywhere` clears
					// `penHardware` and repaints every strip, which is exactly
					// what `applyMouseInkUiFanout(false)` did on the way past.
					// A nib put-down darkening the pen-hardware light is right
					// for the same reason the tip tools' put-down is - the
					// light says "something can ink with this", the mouse just
					// stopped being that something, and a mouse user has no
					// hardware for the flag to be true about (alan, 2026-09-03:
					// off "at any point").
					this.host.disarmMouseInkQuietly();
					// The words the loud command's off branch used, said here
					// because there is no exec on this branch to say them.
					this.host.toast("Handwriting: cursor");
					this.openInkSlider = null;
				} else if (nib && spec.isActive?.(this.host) && ptr === "mouse") {
					// Cold or warm: clicking the ACTIVE tool with a mouse is
					// meaningless for a pen (it is already selected), so it can
					// only mean "give the mouse this tool". Clicking again hands
					// the mouse back - the branch above. The toggle's own toast
					// names the tool picked up.
					//
					// This pair is Alan's rule for every mouse-without-a-pen
					// branch here, not just this one - the eraser's
					// ptr !== "mouse" guard below reads the same way. His
					// words, in order (alan, 2026-09-02): "yes tapping a tool
					// should turn it off", then "yes for mouse users without
					// a pen" - the second sentence scopes the first. Tapping
					// an active tool turns it off for a mouse without a pen;
					// pen and touch keep what they have. A mouse has nothing
					// to put the tool DOWN to; a pen does - putting a tool
					// down means picking the nib back up, and the nib buttons
					// already do that, which is why re-tapping a nib was
					// never allowed to deselect it (alan, 2026-08-31: "the
					// nib buttons pick, they never put down"). Lasso,
					// insert-space and pan need no branch of their own: for a
					// mouse their command is still a plain toggle
					// (toggleTipMode in TipMode.ts), so tapping the active
					// one already lands on off.
					//
					// Quiet, and session-only, for the reason its mirror above
					// is. `armMouseInkQuietlyEverywhere` is the arm half of the
					// same fan-out, so the second open pane's nib lights with
					// this one exactly as it did through the command.
					this.host.armMouseInkQuietly();
					// AND THE PICK, because this is the one button press that
					// gives the mouse a tool without an exec: the nib is
					// already the NOMINAL active tool (that is what put the
					// press in this branch), so no command runs and neither
					// `setInlineTool` nor `setTipMode` - the two places a pick
					// is normally recorded - is reached. Without this line the
					// strip's Pen button would arm the mouse while the tool
					// stayed unpicked, which is the same disagreement between
					// the light and the draw that the whole rule exists to
					// forbid. Harmless on a device that has seen a pen:
					// nothing there reads the flag.
					markToolPicked();
					// `isActive` for a nib is `tipInks(h) && activeTool() ===
					// nib`, so no tip mode is on and the loud command's own
					// `tip` expression can only have come out as this nib -
					// the same words it would have shown.
					this.host.toast(`Handwriting: ${nib}`);
					this.openInkSlider = nib;
					this.sliderFromHover = false;
				} else if (nib && spec.isActive?.(this.host) && ptr === "touch") {
					// Touch has no hover, so the tap is the toggle.
					// This lit branch executes no command, so explicitly reach the
					// same eligibility-scoped preparation as a real nib pick.
					this.host.prepareFingerInk?.();
					this.openInkSlider = this.openInkSlider === nib ? null : nib;
					this.sliderFromHover = false;
				} else if (nib && spec.isActive?.(this.host)) {
					this.sliderFromHover = false;
					// A pen hovers BEFORE it taps, so hover has already opened
					// the slider; a toggle here would flash it shut under the
					// nib. The tap just makes sure it is open. Re-tapping the
					// tool you already hold RESELECTS it - a deselect-to-pen
					// was tried and unwanted (alan, 2026-08-31): the nib
					// buttons pick, they never put down.
					this.openInkSlider = nib;
				} else if (
					spec.commandId === "handwriting:inline-tool-eraser" &&
					spec.isActive?.(this.host) &&
					ptr !== "mouse" &&
					!this.eraserPopOpen()
				) {
					// Mirrors the nib branches above: pressing the tool you
					// already hold reopens its pop instead of picking it again.
					// The eraser command is a plain toggle in main.ts
					// (on = !getInlineEraserMode()), so without this branch it
					// fell to the generic exec() below on every press and the
					// only way back to the pop once AH's pen-contact close had
					// hidden it was two taps through the OFF->ON edge
					// eraserPopClosed clears on, below (alan, 2026-09-02,
					// design doc 5p). A mouse keeps switching the tool off
					// instead ("mouse sould disable", alan, ~19:52): a mouse
					// only draws because its owner has no pen, so for them the
					// eraser button IS the mode, exactly the reasoning the
					// nibs' ptr === "mouse" branches give above - it falls
					// through to exec() untouched.
					//
					// The `!eraserPopOpen()` half is what keeps pen and touch
					// able to put the eraser DOWN. As first written this
					// branch took EVERY non-mouse press on the active eraser,
					// and since the pop is showing whenever the eraser was
					// just picked up, the ordinary re-tap - the one that had
					// switched the tool off since before the strip existed -
					// only toggled the pop shut and back. Shipped in 1.4.6.
					// The tool was still escapable by picking a nib, which is
					// what the Pen button is for, but the eraser's OWN button
					// no longer answered a press the way it looked like it
					// would. Reading the pop's own state splits
					// the two intents the one press carries: pop hidden means
					// pen contact took it away and the press is asking for it
					// back, which is the case the branch was added for; pop
					// showing means the user is looking at the thing this
					// branch would reopen, so the press can only mean the
					// other thing, and it falls through to exec() the way a
					// mouse click does. Each intent costs one tap and neither
					// is reachable only through the other.
					this.eraserPopClosed = false;
					// A tap is a decision, same as the nib branches' own
					// `sliderFromHover = false`: whatever hover was previewing
					// is settled now, so the leave timer must not later undo it.
					this.eraserPopFromHover = false;
				} else {
					// Selecting a nib leaves its slider OUT: the pointer is
					// already sitting on the button it just clicked, so no
					// pointerenter will ever fire to open it - the slider
					// needed a leave-and-return to appear (glass, 2026-08-31).
					this.openInkSlider = nib;
					this.sliderFromHover = false;
					// A mouse picking a tool it cannot use means "give the
					// mouse this tool" - nib, eraser, lasso, space or pan
					// alike. Without arming, the mode switched but the mouse
					// still could not use it: a dead-looking button (glass,
					// 2026-08-31). Only on the way IN - clicking an active
					// mode toggles it off, and turning a thing off must not
					// claim the mouse. The exec's own toast names what was
					// picked; the arming is silent beside it.
					const wasActive = spec.isActive?.(this.host) ?? false;
					// Computed BEFORE exec, and now that matters in two ways
					// rather than one. It always had to be: exec is what
					// actually flips the mode, and `markMousePutDown` below
					// has to be in place before it runs so the command's own
					// Notice can see it while it is building.
					//
					// It ALSO has to be, since `mouseDrawsHere` replaced
					// `mouseInkOn()` here. None of these four commands touches
					// mouse ink - that half still cannot change underneath us -
					// but every one of them re-picks a tool on its way through
					// `setTipMode` (TipMode.ts), including the OFF direction
					// that hands the tip back to the nib. Read after exec, the
					// derived half would therefore always say "drawing" and a
					// put-down could never be told from a pick. Read here, it
					// is the state the CLICK met, which is the question.
					const puttingDown = claimsTip && wasActive && ptr === "mouse" && mouseDrawsHere(this.host);
					if (puttingDown) {
						// Tell the command its own toast is about to be wrong.
						// The exec's toast names the nib the tip fell back to,
						// which is correct for a pen or touch tap actually
						// picking that nib and false here - a mouse put-down
						// picked nothing, it got its cursor back (alan,
						// hardware finding 2026-09-03: "it says highlighter
						// after doing it"). `consumeMousePutDown` reads this
						// while composing that Notice and substitutes the
						// words the loud mouse-ink-toggle command already
						// uses for "off" - matching, not inventing. See
						// MouseInk.ts for why the command cannot infer this
						// itself from `mouseInkEnabled()` alone.
						markMousePutDown();
					}
					this.host.exec(spec.commandId);
					// THE KEYBOARD, INSIDE THE GESTURE. The exec above has
					// already flipped the state, so `penInkEnabled()` now
					// reads the NEW answer: off means the user asked to type,
					// and focusing the editor here - in a click handler, which
					// is a user gesture - is the only thing that raises the
					// soft keyboard on iOS and Android. The command cannot do
					// it: reached from a hotkey or the palette it has no
					// gesture behind it and both platforms ignore the focus.
					// On means the pen is writing again, so the keyboard is
					// dismissed and the glass goes back to the ink.
					//
					// This is the one place the strip does something its
					// command does not, and the file's header says it invents
					// nothing - so the exception is stated rather than
					// smuggled: the STATE is still the command's, and only the
					// focus, which is not state at all, is the button's.
					// `noFocus`'s pointerdown preventDefault (above) is what
					// keeps every OTHER button off the editor, and this call
					// deliberately steps past it for this one.
					if (spec.commandId === PEN_INK_TOGGLE) {
						this.host.setEditorFocus(!penInkEnabled());
					}
					if (claimsTip && !wasActive && ptr === "mouse" && !this.host.mouseInkOn()) {
						// Quietly: the exec above already toasted the tool.
						// One click, one toast (alan, 2026-08-31).
						this.host.armMouseInkQuietly();
					} else if (puttingDown) {
						// PUTTING IT DOWN, the mirror of the arm above (alan,
						// 2026-09-03). The two nibs already did this - their own
						// branches near the top - but through the loud toggle
						// command, which toasted right and wrote data.json with
						// it; they take this same quiet edge since 1.4.10 and
						// say the command's words themselves. These four tools
						// went through the generic exec above instead, whose
						// toast is written for a different caller of the same
						// off edge (see `markMousePutDown` above for the fix).
						// The eraser, lasso, insert-space and pan only toggled
						// back to the last nib, and for a MOUSE that is not
						// putting anything down: the pointer is still claimed
						// and still cannot select text, so the only way back to
						// the cursor was to click a button you were not using.
						// His words: "much more consistent for them all to be
						// dropped and revert back to mouse cursor".
						//
						// The `exec` above has already toggled the tool off, so
						// this only has to release the pointer. Quiet, and for
						// a different reason than the arm now: the toast this
						// time is `markMousePutDown`'s, consumed inside the
						// exec above, not a second Notice stacked on top of it.
						//
						// MOUSE ONLY, and the guard is what keeps it that way.
						// A pen's resting state is the nib, so returning there
						// IS its put-down and nothing about pen or touch should
						// move; he asked for the two to stay as they are while
						// he thinks the flow through. The nibs never reach here
						// with a mouse - their branches catch that case first -
						// so this is exactly the four tools.
						this.host.disarmMouseInkQuietly();
					}
				}
				// PICKING A TOOL CLOSES THE SECOND ROW (item 4). Every button
				// this handler runs for is a pick or an action, and the folded
				// row is a menu: a menu that stayed open over the thing it was
				// used to reach would be covering the page the tool is for.
				// Placed here rather than in each branch so a button added
				// later cannot forget it, and after the branches so a branch
				// that reads the row's state still sees what the press met.
				this.setMoreOpen(false);
				this.refresh();
			});
			this.attachTip(b);
			this.buttons.push({ el: b, spec });
			this.built.add(spec.commandId);
		}
	}

export function installMobileToolsBuild(proto: MobileTools): void {
	installMethods(proto, {
		buildButtons,
	});
}
