/**
 * The pen router's constructor body from the pointer listeners onward, as four methods of InlinePenRouter installed on its prototype
 * when InlinePenRouter.ts loads. The constructor calls them in the order they ran as inline text.
 */
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { palmSizedTouches, stylusOnlyTouches } from "./StylusTouch";
import { mouseInkEnabled } from "./MouseInk";
import { penSeenThisSession } from "./PenToolsMode";
import { tr } from "./InlinePenRouterTrace";
import { installMethods } from "./InstallMethods";
import { contextMenuSuppressed, type InlinePenRouter } from "./InlinePenRouter";
import { sideButtonAirInterrupt } from "./SideButtonAir";

declare module "./InlinePenRouter" {
	interface InlinePenRouter {
		bindPointerListeners(): void;
		bindBandRoot(scrollEl: HTMLElement): void;
		bindStylusTouches(): void;
		bindContextMenu(): void;
	}
}

	/** The scroller's pointer listeners, the window blur commit and the pointerleave handler. */
	function bindPointerListeners(this: InlinePenRouter): void {
		// Everything is CAPTURE phase: the scroller is the content element's
		// parent, so these run before any CodeMirror handler regardless of
		// registration order. Non-pen events (and pen hover) fall straight
		// through; the listener returns without touching them.
		const on = (type: string, fn: (ev: PointerEvent) => void) => {
			const h = (ev: Event) => fn(ev as PointerEvent);
			this.scrollEl.addEventListener(type, h, { capture: true });
			this.disposers.push(() =>
				this.scrollEl.removeEventListener(type, h, { capture: true })
			);
		};

		on("pointerdown", (e) => this.pointerDown(e));
		on("pointermove", (e) => this.pointerMove(e));
		on("pointerrawupdate", (e) => this.pointerRawUpdate(e));
		on("pointerup", (e) => this.pointerUpOrCancel(e));
		on("pointercancel", (e) => this.pointerUpOrCancel(e));
		on("gotpointercapture", (e) => {
			if (e.pointerType === "pen") tr("gotpointercapture", e);
		});
		on("lostpointercapture", (e) => {
			const ownedFinger =
				e.pointerType === "touch" && this.activeIsFinger && e.pointerId === this.activePenId;
			const ownedMouse = this.ownedMouseStroke(e);
			if (!ownedFinger && e.pointerType !== "pen" && !ownedMouse) return;
			tr("lostpointercapture", e, this.activePenId !== null ? "DURING STROKE" : "");
			this.endPenStroke(e, false);
		});
		// pointercancel and lostpointercapture already fold a lost stroke back
		// through endPenStroke (above). The one loss neither covers: the OS
		// takes focus away from the window mid-stroke (alt-tab, a system
		// dialog, the on-screen keyboard) with no pointer event at all - the
		// pen contact just goes quiet. Without this, activePenId stays set
		// and the window-capture click suppressor (armOwnership) never comes
		// down: the same failure mode as the note-switch bug abandonActiveStroke
		// was added for, reached a different way.
		{
			const onBlur = () => {
				if (this.activePenId !== null) tr("blur", null, "DURING STROKE: committing");
				// COMMITS, it does not abandon (alan, 2026-09-04: "alt tab mid
				// stroke - sure make it consistent"). A blur used to run
				// `abandonActiveStroke()` and drop whatever had been drawn, so
				// alt-tabbing away mid-word threw the word away - "it never
				// landed", on hardware. The manual already states the opposite
				// rule for the other teardown a writer can hit mid-stroke, the
				// pdf viewer rebuilding under the pen: the stroke commits what
				// was drawn instead of vanishing, and only the gesture ends.
				// A blur is the same event from the writer's side and now has
				// the same answer on both surfaces.
				//
				// `finishActiveStroke()` is the whole answer when a stroke was
				// live: it ends the stroke exactly as a lift does, so the
				// surface's own `penUp` commits the ink AND stands the chrome
				// down, and there is nothing left for the abandon path to do.
				//
				// The second branch is not the same event and is not dead: a
				// blur with NO stroke but an armed ownership guard or a
				// running tail still needs that bookkeeping torn down, and
				// `abandonActiveStroke()` is what does it. Its return value
				// stays wired to `onStrokeAbandoned` because the callback's
				// contract is "a stroke was really torn down" and a future
				// caller of this branch could satisfy it; today it cannot,
				// since a live stroke never reaches here. The surfaces keep
				// their `strokeAbandoned` bodies for the paths that still DROP
				// a stroke - the note switch (`InkOverlayPlugin.update`) and
				// the pdf's in-place document change (`forgetHistory`), both of
				// which call `abandonActiveStroke()` themselves.
				//
				// KNOWN, unchanged by the ruling, recorded for the design doc:
				// a pen still ON THE GLASS across blur -> refocus. Its stroke
				// ends here, so every later sample from that same contact takes
				// the hover branch, and its eventual real pointerup is not a
				// stroke end any more - it escapes natively once the 350 ms
				// ownership tail has expired, which by then it has. So a caret
				// placement or a click can follow the pen finally coming up.
				// That is exactly what happened before this handler committed
				// rather than abandoned; the ruling changed what the ink does,
				// not what the contact does.
				if (this.finishActiveStroke()) return;
				if (this.abandonActiveStroke()) this.cb.onStrokeAbandoned?.();
			};
			this.winRef.addEventListener("blur", onBlur);
			this.disposers.push(() => this.winRef.removeEventListener("blur", onBlur));
		}
		// A pen leaving takes the surface's reticle with it. So does an ARMED
		// MOUSE, and that half was missing: this handler tested `pointerType
		// === "pen"` and nothing else, so a mouse with mouse ink on hovered a
		// PDF, painted the reticle, left the pane - and left the reticle
		// behind with `display: block` and `handwriting-pdf-hover` still on
		// the scroller, whose rule is `cursor: none` across the whole viewer
		// (styles.css). The mouse is exactly the pointer that cannot recover
		// from this on its own: both surfaces exempt it from the hover
		// watchdog that hides a stranded reticle, on the correct grounds that
		// a mouse is either over the pane or has sent this very event. The
		// exemption and the event have to be the same rule, and they were not.
		//
		// `onPenLeave` is safe for a mouse on both surfaces and does nothing
		// else: the note's `hidePenCursor` clears the hover watchdog, drops
		// PEN_HOVER_CLASS and hides the reticle element; the pdf's
		// `hideCursor` does the same three things with its own names. Neither
		// touches stroke state - and the `activePenId === null` guard below,
		// which is kept for both pointers, means a button held while the
		// pointer leaves the pane delivers nothing at all.
		//
		// What stays PEN-ONLY is the trace line. `tr` writes into the shared
		// pen trace a bug report is read from, whose lines are a pen's story;
		// a mouse drifting off the pane is not an event that story is missing,
		// and adding it would put a line in every report that has a mouse near
		// the pane. The mouse takes the ONE action it needs and no bookkeeping.
		on("pointerleave", (e) => {
			const isPen = e.pointerType === "pen";
			if (!isPen && !this.mouseMayStartOrHover(e)) return;
			if (isPen) tr("pointerleave", e, this.activePenId !== null ? "DURING STROKE" : "");
			const next = e.relatedTarget as Node | null;
			const stillInside =
				next !== null && typeof next.nodeType === "number" && this.scrollEl.contains(next);
			// A pen leaving the pane in the middle of a side-button press in the air is the held touch Android takes: no
			// switch. A leave onto an element the pane holds is not, and keeps the press and the device's one note.
			const held = isPen && !stillInside ? sideButtonAirInterrupt(true) : null;
			if (held !== null) tr("pointerleave", e, held);
			if (this.activePenId === null && !stillInside) this.cb.onPenLeave();
		});
	}

	/** The linked-mentions band's eraser claim, on the view root. */
	function bindBandRoot(this: InlinePenRouter, scrollEl: HTMLElement): void {
		// The linked-mentions band (`.embedded-backlinks`) renders in the SAME
		// view but OUTSIDE the scroller, so a pen landing there was never
		// claimed: the contact stayed native and the browser synthesized a
		// click - erasing near the band pressed its buttons (orion
		// 2026-08-26). One capture listener on the view root claims
		// eraser-intent contacts whose target sits inside the band; after the
		// claim, setPointerCapture retargets the rest of the gesture to the
		// scroller and every existing listener takes over. Tip and side button
		// contacts on the band stay native so backlink rows keep clicking.
		const bandRoot =
			typeof scrollEl.closest === "function"
				? scrollEl.closest(".markdown-source-view")
				: null;
		if (bandRoot && bandRoot !== scrollEl) {
			const h = (ev: Event) => {
				const pe = ev as PointerEvent;
				const t = pe.target as Element | null;
				// Duck-typed, not instanceof: a popout window's elements are
				// another realm's and instanceof would refuse them.
				if (!t || typeof t.closest !== "function") return;
				if (this.scrollEl.contains(t)) return; // scroller listeners own it
				if (!t.closest(".embedded-backlinks")) return;
				if (!(this.cb.claimBandContact?.(pe) ?? false)) return;
				this.pointerDown(pe);
			};
			bandRoot.addEventListener("pointerdown", h, { capture: true });
			this.disposers.push(() =>
				bandRoot.removeEventListener("pointerdown", h, { capture: true })
			);
		}
	}

	/** The window touch listeners that eat the Pencil's synthesized touch stream and palm-sized touches. */
	function bindStylusTouches(this: InlinePenRouter): void {
		// iOS port: on iPadOS the Pencil produces a SECOND event stream, the
		// touch events Safari synthesizes for compatibility, and that stream
		// is the one CodeMirror and the system read for text interaction.
		// preventDefault on our pointer events never touches it, which is why
		// the keyboard rose on every stroke and the selection wash painted
		// over fresh ink on both test iPads. WebKit marks these touches
		// `touchType: "stylus"`; eat any touch event made only of them, in
		// the capture phase, before the editor sees it. Finger touches pass
		// (scroll and caret placement by hand keep working), and on engines
		// without the property nothing matches, so this is inert on the
		// Surface. Registered non-passive explicitly: preventDefault is the
		// entire point.
		{
			const eatStylus = (ev: Event) => {
				const te = ev as TouchEvent;
				if (!te.changedTouches) return;
				// Registered on the WINDOW (see below), so the first question
				// is whether this touch is even ours. Everything past this
				// line behaves exactly as it did when the listener sat on the
				// scroller - including the bookkeeping, which must only ever
				// count contacts on our own surface.
				//
				// `contains` and not instanceof: a popout window's elements
				// belong to another realm, and the scroller is asked about its
				// own descendants either way.
				const target = te.target as Node | null;
				if (!target || !this.scrollEl.contains(target)) return;
				const nativeGateBlocks = !this.penOff() && this.anyGateBlocksNewTouch(performance.now());
				if (te.type === "touchstart" && nativeGateBlocks) {
					for (let i = 0; i < te.changedTouches.length; i++) {
						const id = te.changedTouches[i]?.identifier;
						if (typeof id === "number" && !this.liveTouchIds.has(id)) {
							this.blockedNativeTouchIds.add(id);
						}
					}
				}
				// Snapshot before end/cancel cleanup: the final event is still
				// owned, even when the hover/release timer has since expired.
				let blockedNativeContact = false;
				for (let i = 0; i < te.changedTouches.length; i++) {
					const id = te.changedTouches[i]?.identifier;
					if (typeof id === "number" && this.blockedNativeTouchIds.has(id)) {
						blockedNativeContact = true;
					}
				}
				// Bookkeeping first, and for every event including the ones
				// eaten below: the set has to reflect what the browser thinks
				// is down, not what we let through.
				if (te.type === "touchstart") {
					for (let i = 0; i < te.changedTouches.length; i++) {
						const id = te.changedTouches[i]?.identifier;
						if (typeof id === "number") this.liveTouchIds.add(id);
					}
				} else if (te.type === "touchend" || te.type === "touchcancel") {
					for (let i = 0; i < te.changedTouches.length; i++) {
						const id = te.changedTouches[i]?.identifier;
						if (typeof id === "number") {
							this.liveTouchIds.delete(id);
							this.blockedNativeTouchIds.delete(id);
						}
					}
					if (te.touches.length === 0) this.blockedNativeTouchIds.clear();
					// The browser's own statement that the hand is off the glass.
					// A contact whose pointerup never arrived is still in
					// `touchPos`, and the next single finger would make the size
					// 2 and pinch with itself. A document switch or a capture
					// transfer with fingers still down reports a non-empty
					// `touches` and never takes this branch.
					// A touch paroled into the assist pan is in guardTouches and
					// not touchPos, so it is checked for here too.
					if (
						te.touches.length === 0 &&
						(this.touchPos.size > 0 || this.guardTouches.size > 0 || this.assistPointerId !== null)
					) {
						this.retireAllContactsOnNativeEnd();
					}
					// A palm the gate swallowed is in neither map above, and
					// only its own pointerup removed it: lost, it read as a
					// hand on the glass for good (the mouse ring hidden in every
					// pane, the edge ease never given back). The browser's
					// "no touch left" covers it too. Its pointerup, when it
					// comes, is dispatched before this touchend, so a lift that
					// does arrive has already taken it out.
					if (te.touches.length === 0 && this.swallowedTouches.size > 0) {
						this.swallowedTouches.clear();
						this.paroleId = null;
						this.paroleOverlapped = false;
						this.resumeEaseIfIdle();
					}
					this.finishFingerInkPreparation();
				}
				// PEN OFF: nothing below this line may eat a touch. The three
				// rules under it exist to keep the pen's SECOND event stream
				// off the editor - the stylus touches WebKit synthesizes for a
				// Pencil, the untagged ones Chromium delivers on Android
				// tablets, and the palm that rises the keyboard before a
				// stroke - and every one of them is written to stop the
				// keyboard coming up. With the pen off the keyboard coming up
				// is the point: that touch stream is how iPadOS and Android
				// place the caret at all, so eating it would take the caret
				// with it and leave the pen doing nothing whatsoever.
				//
				// AFTER the bookkeeping above, never before it. `liveTouchIds`
				// mirrors what the browser thinks is down and is what
				// `touchesAtStrokeStart` is snapshotted from; a contact that
				// went down while the pen was off and lifted after it came
				// back on would otherwise leave a stale id in the set forever.
				if (this.penOff()) {
					this.blockedNativeTouchIds.clear();
					return;
				}
				// The native touch stream is the same owned finger gesture. Keep
				// it away from CodeMirror while the pointer stream feeds ink; this
				// does not use the pen palm gate or stylus touch classification.
				if (this.activeIsFinger || this.fingerInkBlockedUntilAllLift) {
					te.preventDefault();
					te.stopPropagation();
					return;
				}
				if (stylusOnlyTouches(te.changedTouches)) {
					te.preventDefault();
					te.stopPropagation();
					tr(te.type, null, "stylus touch eaten (webkit text layer)");
					return;
				}
				// The pen's parallel TOUCH stream on engines with no stylus
				// marking. WebKit tags Pencil touches and the branch above
				// eats them; Chromium tags nothing, so on Android tablets
				// (Onyx Boox, reported 2026-08-27) the stylus arrives twice -
				// once as the pointer events we claim, once as touches we
				// never saw. Those touches reach the app: they focus the
				// contenteditable and raise the keyboard, and a stroke that
				// travels sideways reads as Obsidian's open-the-sidebar
				// swipe, mid-word.
				//
				// Use the same live-pane hover/stroke/release policy as pointer
				// touch admission, but retain ownership by native identifier.
				// Existing fingers are not reclassified when a pen arrives.
				if (blockedNativeContact) {
					te.preventDefault();
					te.stopPropagation();
					tr(te.type, null, "touch eaten: native contact belongs to palm gate");
					return;
				}
				if (nativeGateBlocks) return;
				// A palm resting BEFORE the pen touches down. PalmGate's
				// "palm placed before pen" rule keys off pen hover, and
				// Pencil hover only exists on recent iPads - on the rest the
				// palm reaches the contenteditable with no pen signal yet and
				// the keyboard slides up before a stroke is drawn (alan,
				// iPad). Contact size is the only signal at that instant.
				// The radius threshold is the one constant here chosen without
				// hardware to check it against. Trace what the device actually
				// reports on every touchstart, so a single pen trace from an
				// Android tablet settles whether 40px is right rather than
				// another round of guessing.
				if (te.type === "touchstart" && diagnosticsEnabled()) {
					const sizes: string[] = [];
					for (let i = 0; i < te.changedTouches.length; i++) {
						const touch = te.changedTouches[i];
						sizes.push(
							`${touch?.radiusX ?? "?"}x${touch?.radiusY ?? "?"}` +
								(typeof (touch as { touchType?: string })?.touchType === "string"
									? `/${(touch as { touchType?: string }).touchType}`
									: "")
						);
					}
					tr(te.type, null, `touch radii: ${sizes.join(", ")}`);
				}
				if (palmSizedTouches(te.changedTouches)) {
					te.preventDefault();
					te.stopPropagation();
					tr(te.type, null, "palm-sized touch eaten (keyboard suppression)");
				}
			};
			// On the WINDOW, not the scroller. Capture descends from the
			// outside in, so a listener on the scroller is the LAST thing to
			// see a touch - after every app-level handler above it. Obsidian's
			// open-the-sidebar swipe is one of those, which is why a sideways
			// stroke still opened a side panel on an Onyx Boox even with the
			// rule below saying it must not (reported 2026-08-27, and the rule
			// was right; it was just being applied somewhere it could be
			// pre-empted). armOwnership already states the principle for
			// mouse-like fallout - "window precedes document in capture order,
			// so these pre-empt Obsidian's app-level handlers" - and the touch
			// stream simply never got the same treatment.
			//
			// Nothing widens except reach: the target check above confines
			// every decision to our own scroller, so touches anywhere else in
			// the app never meet this code at all.
			// touchcancel included, and it is the reason this list is not
			// just the three "normal" ones. The browser sends it instead of
			// touchend whenever it takes a gesture over - a system swipe, a
			// palm the OS rejects - and without it the contact's id was
			// never removed from liveTouchIds. The set is what
			// touchesAtStrokeStart is snapshotted from, so one cancelled
			// touch made every later stroke believe a finger had been down
			// since before it started, and stopped eating it.
			for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
				this.winRef.addEventListener(type, eatStylus, {
					capture: true,
					passive: false,
				});
				this.disposers.push(() =>
					this.winRef.removeEventListener(type, eatStylus, { capture: true })
				);
			}
		}
	}

	/** The scroller's context-menu suppressor. */
	function bindContextMenu(this: InlinePenRouter): void {
		// Pen-sourced context menus on the note are never wanted: mid-stroke
		// long-press, side-button press at contact (fires AFTER pointerup, so the old
		// during-stroke check missed it and menus stacked), and side-button press
		// while merely hovering. Mouse right-click away from the pen passes.
		{
			const h = (ev: Event) => {
				// Mouse-ink mode: hover moves run the pen-hover path, so the
				// palm gate reads "pen near" whenever the mouse just moved -
				// and a right-click straight after moving is the NORMAL case.
				// The first click ate the menu (orion 2026-08-26); the mouse
				// keeps its menu, and only its own stroke/tail suppress it.
				const pt = (ev as PointerEvent).pointerType;
				// PEN OFF, and PEN ONLY. `contextMenuSuppressed` answers true
				// for every pen-sourced menu unconditionally, on the grounds
				// that a claimed pen's long-press is ours; while the pen is
				// off it is nobody's but the app's, and a pen that can place a
				// caret but cannot open the menu a finger opens is not the
				// native pointer this feature promises.
				//
				// The other two pointers keep their rules exactly. A mouse
				// matters here: mouse ink is untouched by pen off, so a live
				// mouse-ink stroke must still suppress its own menu, which a
				// blanket return would have handed back mid-stroke. Touch
				// keeps `stabilizingHand` because that is a rule about the
				// hand steadying the glass, not about who owns the pen.
				if (pt === "pen" && this.penOff()) return;
				// A finger planted to stabilize the hand BEFORE the pen
				// arrives long-presses into a right-click on windows (orion
				// 2026-08-26: switch note, plant finger, menu). Chromium
				// stamps that contextmenu pointerType "touch". Once a pen
				// has been seen this session, a touch long-press on the
				// writing surface is a stabilizing hand; sessions that never
				// see a pen keep their long-press menu.
				const stabilizingHand = pt === "touch" && penSeenThisSession();
				const suppress =
					stabilizingHand ||
					contextMenuSuppressed({
						activeStroke: this.activePenId !== null,
						now: performance.now(),
						ownershipTailUntil: this.ownershipTailUntil,
						pointerType: pt,
						penNear:
							this.gate.isPenNear(performance.now()) &&
							!(pt === "mouse" && mouseInkEnabled()),
					});
				if (suppress) {
					this.traceSuppressed("contextmenu(scroller)");
					ev.preventDefault();
					ev.stopPropagation();
				}
			};
			this.scrollEl.addEventListener("contextmenu", h, { capture: true });
			this.disposers.push(() =>
				this.scrollEl.removeEventListener("contextmenu", h, { capture: true })
			);
		}
	}

export function installInlinePenRouterBind(proto: InlinePenRouter): void {
	installMethods(proto, {
		bindPointerListeners,
		bindBandRoot,
		bindStylusTouches,
		bindContextMenu,
	});
}
