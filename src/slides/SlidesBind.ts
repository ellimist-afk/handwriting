/**
 * The slides surface's binding and teardown: the listeners, the palm shield and contact guard, the slide-change stroke end, dispose and the parked write.
 * They are methods of SlidesDeck, installed on its prototype when SlidesInkSurface.ts loads.
 */
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { penHardwareEverSeen } from "../inline/PenToolsMode";
import { palmRadiusTrustworthy } from "../input/PalmShield";
import { setInkThemeOverride } from "../ink/InkTheme";
import { IDLE_SESSION, strokeSessionReducer } from "./SlidesStrokeSession";
import { installMethods } from "../inline/InstallMethods";
import { drains, log, now, PEN_CONTACT_GUARDED_EVENTS, PEN_GUARDED_EVENTS, presentIndex, type SlidesDeck } from "./SlidesInkSurface";

declare module "./SlidesInkSurface" {
	interface SlidesDeck {
		bind(): void;
		armPalmShield(): void;
		armGestureGuard(): void;
		armContactGuard(): void;
		disarmContactGuard(): void;
		onPresentClassChanged(): void;
		endStrokeForSlideChange(): void;
		dispose(): void;
		drainParkedWrite(parked: Promise<unknown>, initialLoad?: boolean): Promise<void>;
	}
}

	function bind(this: SlidesDeck): void {
		// `slidechanged` is dispatched on the `.reveal` element itself and
		// bubbles. Listening on the element rather than reaching for the deck
		// object is the containment rule: no Reveal API is ever touched.
		const onSlideChanged = () => this.remount();
		this.revealEl.addEventListener("slidechanged", onSlideChanged);
		this.disposers.push(() =>
			this.revealEl.removeEventListener("slidechanged", onSlideChanged)
		);
		// `slidechanged` never fires for the slide the deck opens on, so on its
		// own it leaves slide 0 without ink. `ready` does fire, once.
		const onReady = () => this.remount();
		this.revealEl.addEventListener("ready", onReady);
		this.disposers.push(() => this.revealEl.removeEventListener("ready", onReady));
		// ...and the class itself, for the case `ready` has already gone by.
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		const classes = new win.MutationObserver(() => this.onPresentClassChanged());
		classes.observe(this.slidesEl, {
			subtree: true,
			attributes: true,
			attributeFilter: ["class"],
		});
		this.disposers.push(() => classes.disconnect());
		// Reveal's own resize, fired when k changes, plus the window's: the
		// canvas box is in screen px and the camera carries k, so both the
		// backing store and the camera want re-measuring (§3.4).
		const onResize = () => this.refresh();
		this.revealEl.addEventListener("resize", onResize);
		this.disposers.push(() => this.revealEl.removeEventListener("resize", onResize));
		win.addEventListener("resize", onResize);
		this.disposers.push(() => win.removeEventListener("resize", onResize));
		// B2: neither of the above fires for every way `.reveal`'s own box can
		// change - a pane resize, a sidebar toggling, an Obsidian layout
		// change - only Reveal's internal resize and the window's. A
		// ResizeObserver on `.reveal` itself catches those too, through the
		// SAME re-measure-then-repaint path (`refresh`), not a second one:
		// `refresh` already re-measures k and the offset (`syncGeometry`),
		// resizes both canvases' backing stores, and repaints, so there is
		// nothing for this observer to do but call it again. Calling it twice
		// for one real resize costs a redundant re-measure, never a race.
		if (typeof win.ResizeObserver !== "undefined") {
			const ro = new win.ResizeObserver((entries) => {
				if (diagnosticsEnabled()) {
					const box = entries[0]?.contentRect;
					log(
						`reveal resize observed: ${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "?"}`
					);
				}
				this.refresh();
			});
			ro.observe(this.revealEl);
			this.disposers.push(() => ro.disconnect());
		}
		// B2's other half, and the one no box observer can see: the ratio can
		// change while the box does not. Electron moves devicePixelRatio when
		// the window crosses onto a different-DPI monitor - plugging into a
		// projector mid-deck, unplugging from it, or Windows changing display
		// scale - and the `.reveal` box stays exactly the size it was in css
		// px, so `resize` never fires and the ResizeObserver never beats. Page
		// zoom IS covered by the observer above, because these canvases are
		// sized off the viewport and zoom changes the viewport's css size; a
		// monitor move is not. Same repair, same path: `refresh` re-reads the
		// ratio and re-sizes all four stores, so this arms nothing parallel.
		this.watchResolution();
		this.disposers.push(() => this.unwatchResolution());

		// Pointer routing. A capture-phase listener on the HOST decides, by
		// pointerType, whether to claim; on a claim it preventDefaults and
		// takes setPointerCapture. Unclaimed contacts are left completely
		// alone, so mouse clicks and touch swipes still reach Reveal.
		//
		// S4: no `stopPropagation`, ever. The bubbled pointerdown is what keeps
		// Reveal focused and the arrow keys alive.
		const handlers: Array<[string, (ev: Event) => void]> = [
			["pointerdown", (ev) => this.onPointerDown(ev as PointerEvent)],
			["pointermove", (ev) => this.onPointerMove(ev as PointerEvent)],
			["pointerup", (ev) => this.onPointerEnd(ev as PointerEvent, "up")],
			["pointercancel", (ev) => this.onPointerEnd(ev as PointerEvent, "cancel")],
			["lostpointercapture", (ev) => this.onPointerEnd(ev as PointerEvent, "lost-capture")],
			["gotpointercapture", (ev) => this.onPointerEnd(ev as PointerEvent, "got-capture")],
		];
		for (const [type, fn] of handlers) {
			this.revealEl.addEventListener(type, fn, { capture: true });
			this.disposers.push(() =>
				this.revealEl.removeEventListener(type, fn, { capture: true })
			);
		}

		// A1/S6: the navigation guard. Capture phase on `.reveal`, so it runs
		// before Reveal's own listeners wherever they sit - the arrow buttons
		// and the progress bar are descendants, and a capture-phase
		// stopPropagation on the ancestor never lets the event reach them.
		// Registered as its own listener rather than folded into the pointer
		// handlers, because `stopPropagation` does not stop the other listeners
		// on the element it is called on and the two must not be able to cancel
		// each other by registration order.
		// The UNION of the two guarded lists, registered blind: which rule an
		// event falls under - the stroke one, the palm one, or neither - is
		// `swallowDuringPenContact`'s decision and nothing else's. The lists
		// stay separate for the reason spelled out on
		// `PEN_CONTACT_GUARDED_EVENTS`; only the registration is shared,
		// because a listener that never swallows costs nothing.
		//
		// The guard runs AFTER the pointer handlers above on the same element
		// and the same phase (registration order), so `penContact` is already
		// true for the pen's own pointerdown by the time the palm rule is
		// asked about the next touch - and stopPropagation here cannot cancel
		// them, since it does not stop other listeners on the element it is
		// called on.
		const guard = (ev: Event) => this.onGuardedEvent(ev);
		for (const type of new Set([...PEN_GUARDED_EVENTS, ...PEN_CONTACT_GUARDED_EVENTS])) {
			this.revealEl.addEventListener(type, guard, { capture: true });
			this.disposers.push(() =>
				this.revealEl.removeEventListener(type, guard, { capture: true })
			);
		}

		// The native menu over a live deck. Its own listener and its own
		// element scope, because `onGuardedEvent` never calls preventDefault
		// and a menu is a default action - see `onDeckContextMenu`.
		const menu = (ev: Event) => this.onDeckContextMenu(ev);
		this.revealEl.addEventListener("contextmenu", menu, { capture: true });
		this.disposers.push(() =>
			this.revealEl.removeEventListener("contextmenu", menu, { capture: true })
		);

		this.armPalmShield();
		this.armGestureGuard();
	}

	/**
	 * The shape-based veto, on the platform condition the pdf surface uses.
	 *
	 * `palmRadiusTrustworthy` is the whole of the gate and it is imported, not
	 * restated: the 16px line is calibrated for Windows touch digitizers, an
	 * iPad reports the honest contact ellipse and every fingertip would read as
	 * a palm, and a Boox is the same. A deck presented on a Surface Pro is
	 * exactly the case it is calibrated for.
	 *
	 * Fail CLOSED when there is no `navigator` to ask. A window that cannot say
	 * what platform it is cannot have its radii trusted, and the shield's own
	 * doctrine is that a shield which cannot see palms must stay inert rather
	 * than start seeing them everywhere.
	 *
	 * `palmShieldLive` mirrors the decision for the POINTER half of the same
	 * rule (`palmShapedContact` in `onGuardedEvent`), which the shield itself
	 * cannot see: one platform question, one answer, two paths.
	 */
	function armPalmShield(this: SlidesDeck): void {
		const nav = (this.revealEl.ownerDocument.defaultView ?? window)?.navigator;
		this.palmShieldLive = !!nav && palmRadiusTrustworthy(nav);
		if (this.palmShieldLive) this.palmShield.attach(this.revealEl);
		else this.palmShield.dispose();
		this.disposers.push(() => {
			this.palmShieldLive = false;
			this.palmShield.dispose();
		});
	}

	/**
	 * DECIDE AT CONTACT, NOT BEFORE IT. The deck keeps `touch-action: auto`.
	 *
	 * WHAT THIS REPLACES. The deck used to carry a standing `touch-action:
	 * none` plus a subtree rule forcing it on every descendant, armed on every
	 * presentation and conditional on nothing - so pinch, swipe and section
	 * scrolling were gone for every user, including one who has never owned a
	 * stylus. Alan, 2026-09-08: "oh hell nah that's not ok" / "it must work
	 * seamlessly".
	 *
	 * WHY A `touch-action` ANSWER CANNOT BE SEAMLESS. Measured on Chromium
	 * 151: `touch-action` is LATCHED AT CONTACT. Set after the
	 * contact's `touchstart` and the deck scrolls exactly like an unguarded
	 * control. So the value has to be committed before the pen lands, which is
	 * why it was unconditional, which is why touch paid for it.
	 *
	 * WHAT WORKS INSTEAD, and it needs no arming window at all. `pointerdown`
	 * fires BEFORE `touchstart` for the same contact and carries `pointerType`
	 * - so by the time `touchstart` runs, the page already knows whether a pen
	 * or a finger is landing. A `preventDefault()` in a NON-PASSIVE
	 * `touchstart` stops the pan with the deck at `auto`, measured 0px, and
	 * measured 0px INSIDE a nested `overflow:auto` scroller too, because it
	 * cancels the touch sequence rather than negotiating with an inherited
	 * value. That is why this route needs no `*` subtree rule: the Blink
	 * pan-x/pan-y OR-back is a `touch-action` problem and this is not one.
	 *
	 * `preventDefault` on `pointerdown` does nothing (measured, and it agrees
	 * with the hardware note in `ManipulationGuard.ts`) - it must be the
	 * `touchstart`.
	 *
	 * THE COST, NAMED. A non-passive `touchstart` listener makes the browser
	 * wait for the main thread before any finger gesture in the deck may
	 * begin: one frame on a healthy thread, up to Chrome's touch-ack timeout
	 * on a busy e-ink one. So it is registered ONLY on a device that has
	 * actually seen a pen - `penHardwareEver` is persisted per device
	 * (`PenToolsMode`), restored before any deck opens, and a synced `true`
	 * from another machine is deliberately ignored. A device that has never
	 * held a stylus never registers the listener and pays exactly nothing,
	 * which is stronger than making the handler cheap.
	 */
	function armGestureGuard(this: SlidesDeck): void {
		this.disposers.push(() => this.disarmContactGuard());
		if (penHardwareEverSeen()) this.armContactGuard();
	}

	/** Idempotent: the first pen event arms, every later one is a no-op. */
	function armContactGuard(this: SlidesDeck): void {
		if (this.contactGuardArmed || this.disposed) return;
		this.contactGuardArmed = true;
		// NON-PASSIVE on purpose: a passive listener may not preventDefault,
		// and preventDefault is the whole mechanism. Capture phase so it runs
		// before Reveal's own touch plugin, which is what would otherwise
		// carry the swipe.
		this.revealEl.addEventListener("touchstart", this.onDeckTouchStart, {
			capture: true,
			passive: false,
		});
	}

	function disarmContactGuard(this: SlidesDeck): void {
		if (!this.contactGuardArmed) return;
		this.contactGuardArmed = false;
		this.revealEl.removeEventListener("touchstart", this.onDeckTouchStart, { capture: true });
	}

	/** A section's class list changed: repoint if that made a slide current. */
	function onPresentClassChanged(this: SlidesDeck): void {
		if (this.disposed) return;
		const index = presentIndex(this.sections());
		if (index < 0) return;
		if (this.layers && this.layers.index === index) return;
		this.remount();
	}

	/**
	 * The deck is about to show another slide and a stroke or an erase is live.
	 *
	 * The note surface's rule for a stroke torn off its surface
	 * (`abandonActiveStroke` / `onStrokeAbandoned`, InlinePenRouter and
	 * InkOverlay): COMMIT it to the surface it started on, then clear the live
	 * layers and stand the guards down. Both halves matter and they are
	 * different bugs. Without the commit the ink is finished later against
	 * whichever index the layer carries by then, so the reader's sentence
	 * lands on the next slide. Without the clear the half-drawn wet line and
	 * the head on the tail canvas stay painted over the new slide until the
	 * stroke ends - and the committed layer under them has already been
	 * repainted for the new index, so the reader is looking at two slides at
	 * once.
	 *
	 * `commitStroke` does all of it, unchanged: it is the one funnel, it takes
	 * the OLD `l.index` because the caller has not moved it yet, and it clears
	 * both live canvases and releases the capture on the way through.
	 *
	 * The contact is still physically DOWN. Nothing here tries to end it: the
	 * session is idle after this, so its further moves are dropped at
	 * `onPointerMoveBody`'s pointer-identity test and start nothing on the new
	 * slide, and `commitStroke`'s `holdPenGuard` keeps the navigation guard up
	 * until the real lift - whose `click` would otherwise turn the page a
	 * SECOND time, one slide past where the reader asked to be.
	 *
	 * Persistence needs no special case: `persist` already parks behind a claim
	 * or a load in flight, and every parked continuation asks `stale()`.
	 * `remount` itself returns early once `disposed` is set, so a slide change
	 * cannot reach here during a teardown drain at all.
	 */
	function endStrokeForSlideChange(this: SlidesDeck): void {
		this.restedContact = null;
		const before = this.session;
		if (before.phase !== "drawing") return;
		const step = strokeSessionReducer(before, { kind: "slide-change", t: now() });
		this.session = step.state;
		this.syncHoldTimer();
		if (!step.end) return;
		this.commitStroke(before.pointerId ?? -1, step.end, before.samples);
	}

	function dispose(this: SlidesDeck): void {
		if (this.disposed) return;
		// The stroke in the reader's hand, FIRST. Teardown is a closed
		// presentation and a closed presentation is usually a pen still on the
		// glass: dropping the builder here threw away the last stroke drawn,
		// silently, and the flush below then wrote the sidecar without it.
		// `commitStroke` is the same tail every other ending runs - the release
		// filter, the page number, the repaint, the log - so the stroke that
		// survives a teardown is the same stroke a lift would have produced.
		if (this.session.phase === "drawing" && (this.builder !== null || this.erasing)) {
			this.commitStroke(this.session.pointerId ?? -1, "leave", this.session.samples);
		}
		this.flushErase();
		this.disposed = true;
		this.restedContact = null;
		this.actionsChanged();
		this.session = IDLE_SESSION;
		this.syncHoldTimer();
		this.clearQuietTimer();
		this.clearGuardTimers();
		this.dropPenGuard();
		this.builder = null;
		this.activeStyle = null;
		// Flush before the canvases go: the debounce is 700 ms and a reader who
		// closes a presentation right after a stroke would otherwise lose it.
		// `saveNow` is the store's own no-quiet-period write, so this is a
		// flush and not a second copy of the write path.
		//
		// Only when something is actually dirty, though. A deck that changed
		// nothing - no sidecar loaded, and no stroke or erase this session -
		// has nothing to write, and writing it anyway is what turned "present a
		// note, press Escape" into a phantom `.slides.json` and every later
		// close into an unchanged rewrite.
		//
		// AMENDED (live-reload/settle slice): this used to read "`save()` is
		// the only place that sets it, and every path that changes what the
		// sidecar should hold already runs through `save()`". The second half
		// was never true. A stroke can park its write behind a first-stroke
		// claim or behind the load window and reach `save()` only when that
		// promise lands, which is after teardown - so `dirty` was false and the
		// stroke was dropped. Teardown now marks those two parked states dirty
		// itself and drains them below.
		// A claim or a load-window save that is still PARKED is dirt the flag
		// cannot see. Both are opened by the reader's own stroke - `persist()`
		// reaches the claim branch and the `!loaded` branch only from a commit
		// or an erase - and neither has reached `save()` yet, so a literal
		// reading of `dirty` logged "nothing changed, no write" and threw the
		// first mark on a never-inked note away. The gate stands; what counts
		// as dirty is what widens.
		let parked = this.claimInFlight ?? ((this.saveAfterLoad || this.dirty) ? this.loadInFlight : null);
		if (!parked && this.initialLoadFailed && (this.saveAfterLoad || this.dirty)) {
			// The retry must see a draining deck, never a stale disposed one.
			this.draining = true;
			parked = this.startInitialLoad();
		}
		if (parked) this.dirty = true;
		if (this.dirty && parked) {
			// The deck's state is kept alive until the parked work lands: the
			// claim publishes the id and merges any sidecar the note turned out
			// to already have, and only then is there something to write. The
			// UI thread is not held - `dispose()` returns now, and `settle()`
			// is what a shutdown awaits.
			log(
				`teardown: ${this.strokes.size} slide(s) inked, ${this.totalStrokes()} stroke(s), ` +
					`waiting on the ${this.claimInFlight ? "page id claim" : "sidecar load"} before the write` +
					`${this.loaded ? "" : " (load never finished)"}`
			);
			this.draining = true;
			const drain = this.drainParkedWrite(parked, !this.loaded && !this.sidecarId && !this.claimInFlight);
			this.teardownDrain = drain;
			drains.add(drain);
			void drain.finally(() => drains.delete(drain));
		} else if (this.dirty) {
			const page = this.snapshot();
			if (page && this.sidecarId) {
				const id = this.sidecarId;
				void this.host.saveSidecarNow(id, page).catch((err) => {
					log(`save failed at teardown: ${id}: ${String(err)}`);
				});
			}
			log(
				`teardown: ${this.strokes.size} slide(s) inked, ${this.totalStrokes()} stroke(s), ` +
					`${this.sidecarId ? `flushed to ${this.sidecarId}` : "nothing to save"}` +
					`${this.loaded ? "" : " (load never finished)"}`
			);
		} else {
			log(
				`teardown: ${this.strokes.size} slide(s) inked, ${this.totalStrokes()} stroke(s), ` +
					`nothing changed, no write` +
					`${this.loaded ? "" : " (load never finished)"}`
			);
		}
		// The deck's theme dies with the deck. Cleared before the canvases go,
		// and unconditionally: a mount that never happened leaves the override
		// null already, and a `null` written over a `null` costs nothing.
		setInkThemeOverride(null);
		if (this.layers) {
			this.layers.highlightGroup.remove();
			this.layers.committed.remove();
			this.layers.wetCanvas.remove();
			this.layers.tailCanvas.remove();
			this.layers = null;
		}
		this.moveTrace.dispose();
		for (const d of this.disposers.splice(0)) d();
		this.actionListeners.clear();
		// Not while a drain is running: `snapshot()` reads these lists, and
		// clearing them here is what made the disposed-bails in the claim and
		// load continuations load-bearing (letting one through would have
		// written an EMPTY page). The drain clears them when it is done.
		if (!this.draining) this.strokes.clear();
	}

	/**
	 * Teardown's one write, made after the claim or load it was waiting on.
	 *
	 * The parked promise is the WHOLE chain, `finally` included, so by the time
	 * it resolves `sidecarId` is published and any sidecar the note already had
	 * is merged. `save()` refuses once `disposed` is set, so nothing else can
	 * have written in the meantime and this is the single flush.
	 */
	async function drainParkedWrite(this: SlidesDeck, parked: Promise<unknown>, initialLoad = false): Promise<void> {
		try {
			await parked;
			// A claim can end by parking a load (the merge), and a load can end
			// by starting a claim (`finishLoad` -> `persist`). One more round
			// covers that hand-off; beyond it the reader has gone.
			const second = this.claimInFlight ?? this.loadInFlight;
			if (second && second !== parked) await second;
			// A caught rejection is settlement, not permission to write.
			if (!this.loaded) {
				if (this.initialLoadFailed) this.noticeSaveFailure();
				return;
			}
			const page = this.snapshot();
			const id = this.sidecarId;
			if (page && id) {
				await this.host.saveSidecarNow(id, page);
				log(
					`teardown: parked write flushed to ${id}, ${page.strokes.length} stroke(s) ` +
						`(the claim/load landed after the deck was gone)`
				);
			} else {
				log(
					`teardown: parked write dropped - ${id ? "the deck is read-only" : "no page id was claimed"}`
				);
			}
		} catch (err) {
			log(`save failed at teardown: ${String(err)}`);
			if (initialLoad) this.noticeSaveFailure();
		} finally {
			this.draining = false;
			this.teardownDrain = null;
			this.strokes.clear();
		}
	}

export function installSlidesBind(proto: SlidesDeck): void {
	installMethods(proto, {
		bind,
		armPalmShield,
		armGestureGuard,
		armContactGuard,
		disarmContactGuard,
		onPresentClassChanged,
		endStrokeForSlideChange,
		dispose,
		drainParkedWrite,
	});
}
