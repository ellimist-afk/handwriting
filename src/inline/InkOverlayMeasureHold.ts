/**
 * The note surface's measure holds and deferred repaint: the hold on
 * CodeMirror's measuring for a pinch preview and its release, the watchdog
 * that settles a preview whose end was lost, the resize run out of
 * CodeMirror's update, and the pinch deferral of raster work with the one
 * repaint it holds. They are methods of InkOverlayPlugin, installed on its
 * prototype when InkOverlay.ts loads.
 */
import type { EditorView } from "@codemirror/view";
import { installMethods } from "./InstallMethods";
import { PINCH_SCROLL_QUIET_MS, type CmMeasureRequest, type InkOverlayPlugin, type MeasureHold, type MeasureHoldEntry } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		armDeferredRepaint(): void;
		clearDeferredRepaint(): void;
		holdMeasures(): void;
		resizeOutOfUpdate(): void;
		releaseMeasures(deferred?: boolean): void;
		rebasePinch(): void;
		deferPinchRaster(): boolean;
	}
}

/**
 * How long a pinch preview may hold CodeMirror's measure scheduling with no
 * preview frame before the hold releases itself; see `holdMeasures`.
 *
 * Every end path releases the hold. This is the bound for an end that never
 * arrives (a pointer lost without its cancel event, which leaves the preview
 * flagged for the rest of the gesture's lifetime): past it, CodeMirror
 * schedules again, so typing and scrolling get their measures back. The price
 * is on the other side: a pinch held still for longer than this gets one
 * CodeMirror rescale of the scroll under the frozen preview, the pre-fix
 * displacement, once, until the next preview frame solves the pan against
 * the moved scroll. Ten seconds is long for a held pinch and short for a
 * lost end.
 */
const PINCH_MEASURE_HOLD_MAX_MS = 10_000;

	/**
	 * Hold ONE repaint until the pinch deferral lapses.
	 *
	 * Idempotent: while the latch is set nothing new is scheduled, so a gesture
	 * of any length costs one timer and no per-frame work. The timer re-arms
	 * itself only while the deferral is still in force, which a live gesture
	 * keeps true; a settle clears the latch through `clearDeferredRepaint`
	 * before this can matter.
	 */
	function armDeferredRepaint(this: InkOverlayPlugin): void {
		if (this.repaintDeferredByPinch) return;
		this.repaintDeferredByPinch = true;
		const tick = (): void => {
			this.pinchDeferTimer = 0;
			if (!this.container) { this.repaintDeferredByPinch = false; return; }
			if (!this.repaintDeferredByPinch) return;
			if (this.deferPinchRaster()) {
				this.pinchDeferTimer = this.winRef.setTimeout(tick, PINCH_SCROLL_QUIET_MS);
				return;
			}
			this.repaintDeferredByPinch = false;
			// "partial" preserves the pending rects; every other via asserts
			// `damage.addAll()` and would escalate them to a full re-raster.
			this.scheduleRepaint("partial");
		};
		this.pinchDeferTimer = this.winRef.setTimeout(tick, PINCH_SCROLL_QUIET_MS);
	}

	/** The deferral is over and the raster is being redrawn anyway. */
	function clearDeferredRepaint(this: InkOverlayPlugin): void {
		this.repaintDeferredByPinch = false;
		if (this.pinchDeferTimer) {
			this.winRef.clearTimeout(this.pinchDeferTimer);
			this.pinchDeferTimer = 0;
		}
	}

	/**
	 * Keep CodeMirror from measuring for the preview lifetime.
	 *
	 * THE WRITER OF THE MID-PREVIEW SCROLL IS CODEMIRROR. Every preview frame
	 * writes the counter-sized host box and its scale; CodeMirror's observer
	 * schedules a measure for that, and `EditorView.measure` (6.38.6) reads
	 * `scrollTop` with its previous `scaleY`, refreshes the scale, then writes
	 * `scrollTop = S x k_prev / k_next` back, keeping its scaled scroll
	 * constant across a scale change its ancestor made. That write lands in
	 * CodeMirror's animation frame, after this frame's pan solve and before
	 * the paint, so the pan is one rescale behind on every frame it runs.
	 * Measured on the far fixture at scrollTop 114820, k 0.10 -> 0.11: the
	 * write was 105252, about 1052 visual px, and text and ink left the pane
	 * together, registration intact (2026-09-13, lag-far-xy-fixture d4nav2).
	 * The preview needs no measure of its own: it is a transform and a
	 * translate, and its reads are client rects. So the scheduling entry is
	 * held for the preview and released on every end path, where CodeMirror
	 * then measures once against the settled layout, which is also where the
	 * plugin's own settle requests go. Other callers' requests made meanwhile
	 * are kept, last per key as CodeMirror itself keeps them, and replayed at
	 * the release. What goes with the write: the two or three CodeMirror
	 * measures a preview frame paid before.
	 *
	 * TWO ENTRIES ARE SHADOWED on the instance, and both are needed.
	 * `requestMeasure`, the public scheduler, is where the resize debounce,
	 * the mutation flush and every other caller arrive. `measure`, the sink,
	 * is where a callback CodeMirror scheduled BEFORE the hold went on still
	 * arrives (its animation frame resolves `this.measure` at call time), and
	 * where the synchronous measure a scroll event runs arrives - and the
	 * browser raises a scroll event on its own when a zoom-out shrinks the
	 * scroll range under a far scroll and clamps it. Holding the scheduler
	 * alone leaves both of those to rescale the scroll under the pan.
	 * `measure` is not in CodeMirror's typings (marked internal); a build
	 * where it is absent degrades to holding the scheduler only.
	 *
	 * A swallowed callback leaves CodeMirror's own "measure scheduled" mark
	 * set, and its public scheduler queues without scheduling while that mark
	 * is set, so the release does not rely on it: when anything was held, the
	 * release runs the captured `measure` itself in the next animation frame,
	 * which drains every queued request and clears the mark (a destroyed view
	 * returns from it at once). Each shadow is inert once its hold is over:
	 * a caller that kept the function, or a wrapper that displaced it, reaches
	 * the callable captured at install, never the live property, so no wrapper
	 * chain can loop. The release puts back what it displaced only where the
	 * property is still its own. Re-armed on every preview frame;
	 * PINCH_MEASURE_HOLD_MAX_MS bounds a lost end (`rebasePinch`).
	 */
	function holdMeasures(this: InkOverlayPlugin): void {
		const view = this.view as EditorView | null;
		if (!view) return;
		const held = this.measureHold ?? null;
		if (held) {
			this.winRef.clearTimeout(held.timer);
			held.timer = this.winRef.setTimeout(() => this.rebasePinch(), PINCH_MEASURE_HOLD_MAX_MS);
			return;
		}
		const hold: MeasureHold = { entries: [], requests: [], plain: false, swallowed: false, timer: 0 };
		const target = view as unknown as Record<string, unknown>;
		for (const name of ["requestMeasure", "measure"] as const) {
			const displaced = Object.getOwnPropertyDescriptor(view, name);
			const resolved: unknown = displaced ? (displaced.get ? displaced.get.call(view) : displaced.value) : (Object.getPrototypeOf(view) as Record<string, unknown> | null)?.[name];
			if (typeof resolved !== "function") continue;
			const callable = resolved as MeasureHoldEntry["callable"];
			const shadow = name === "requestMeasure"
				? (request?: CmMeasureRequest): void => {
					if (this.measureHold !== hold) { callable.call(view, request); return; }
					if (!request) { hold.plain = true; return; }
					if (hold.requests.includes(request)) return;
					const key: unknown = request.key;
					const at = key == null ? -1 : hold.requests.findIndex((r) => r.key === key);
					if (at > -1) hold.requests[at] = request; else hold.requests.push(request);
				}
				: (flush?: boolean): void => {
					if (this.measureHold !== hold) { callable.call(view, flush); return; }
					hold.swallowed = true;
				};
			Object.defineProperty(target, name, { configurable: true, writable: true, enumerable: false, value: shadow });
			hold.entries.push({ name, displaced, callable, shadow: shadow as MeasureHoldEntry["shadow"] });
		}
		// COMPATIBILITY LIMIT, not an observed case: CodeMirror 6.38.6 has
		// `measure` on the instance chain and every build measured had it. In
		// a build without it the supported fallback is the scheduler-only
		// hold: the preview, the clip lift and the settle proceed; requests
		// through `requestMeasure` are still held and replayed; but a measure
		// entered synchronously (a scroll event, an intersection flip) would
		// rescale the scroll under the pan, and the release's plain
		// `requestMeasure()` cannot put the fold before the settle write. The
		// warning names that once per gesture; `measureHold.entries` says
		// which entries were found, for the arms that read the hold state.
		if (!hold.entries.some((e) => e.name === "measure")) console.warn("Handwriting: pinch preview holds CodeMirror's scheduler only; view.measure was not found");
		hold.timer = this.winRef.setTimeout(() => this.rebasePinch(), PINCH_MEASURE_HOLD_MAX_MS);
		this.measureHold = hold;
		// THE CONTAINER'S CLIP COMES OFF FOR THE SAME LIFETIME. With the scroll
		// held, the focal pan carries the whole move, and the inner layer's
		// translate takes the canvases out of the band-sized, overflow-hidden
		// container, which clips them (measured 2026-09-13, zoom-out to k 0.3
		// at scrollTop 1809: translate 983 layout px, the mark inside the band
		// and inside the pane, and absent). `.cm-sizer` carries the same
		// translate with no clip of its own, so the pixels land where the text
		// does. One style write per gesture; the clip returns with the release.
		this.container?.setCssStyles({ overflow: "visible" });
	}

	/**
	 * A resize met inside CodeMirror's update while the measure hold is live,
	 * run whole in the next frame with the state re-checked: the same view,
	 * note and viewport generation, and a container still mounted. Outside
	 * the update its commit releases the hold the ordinary way, fold first.
	 */
	function resizeOutOfUpdate(this: InkOverlayPlugin): void {
		if (this.resizeOutOfUpdateRaf) return;
		const view = this.view, path = this.filePath(), generation = this.viewportGeneration;
		this.resizeOutOfUpdateRaf = this.winRef.requestAnimationFrame(() => {
			this.resizeOutOfUpdateRaf = 0;
			if (this.retiring || !this.container || this.view !== view || this.filePath() !== path || this.viewportGeneration !== generation) return;
			this.handleResize();
		});
	}

	/**
	 * Give CodeMirror its measuring back and replay what was held. Idempotent;
	 * every end path calls it.
	 *
	 * THE FOLD COMES FIRST. CodeMirror's first measure after a scale change
	 * rescales `scrollTop` by the scale ratio it missed; on the settle path
	 * that measure must land BEFORE the settle's own scroll write, as it did
	 * when CodeMirror measured every frame, so the settle overwrites the fold
	 * and not the other way round (measured 2026-09-13 with the fold replayed
	 * a frame later: zoom-in 1 -> 2 settled at scrollTop 969 for 2048). So
	 * the captured `measure` runs synchronously here whenever anything was
	 * held; a teardown passes `deferred` and gets it in the next frame, since
	 * an unmount can run inside CodeMirror's own update.
	 */
	function releaseMeasures(this: InkOverlayPlugin, deferred = false): void {
		const hold = this.measureHold ?? null;
		if (!hold) return;
		if (this.inUpdate && !deferred) {
			// The net, not a route: see `update`. Named so it can be found.
			console.warn("Handwriting: measure hold released inside CodeMirror's update; measure deferred a frame", new Error().stack);
			deferred = true;
		}
		this.measureHold = null;
		this.winRef.clearTimeout(hold.timer);
		// THE TRANSLATE COMES OFF BEFORE THE CLIP RETURNS (D-COV, AD-4 ii): a
		// resize commit ends the preview without the pinch-end path, and the
		// column term it left on the layer put the mark into the pane's own
		// clip (measured on e355b259: translate(-341.25px, 0) at in2 k 2.0,
		// 59% of the mark by the detector's area). Every release is a commit
		// or a teardown, and both re-raster against the settled column.
		this.clearPreviewInkOffset();
		this.container?.setCssStyles({ overflow: "hidden" });
		const view = this.view as EditorView | null;
		if (!view) return;
		const target = view as unknown as Record<string, unknown>;
		for (const entry of hold.entries) {
			// Still the hold's own property: put back what it displaced. A
			// wrapper that took the property over meanwhile keeps it; the
			// shadow it may still reach is inert now (see holdMeasures).
			if (Object.getOwnPropertyDescriptor(view, entry.name)?.value !== entry.shadow) continue;
			if (entry.displaced) Object.defineProperty(target, entry.name, entry.displaced);
			else delete target[entry.name];
		}
		for (const request of hold.requests) view.requestMeasure(request);
		if (!hold.plain && !hold.swallowed && hold.requests.length === 0) return;
		const measure = hold.entries.find((e) => e.name === "measure")?.callable;
		if (!measure) view.requestMeasure();
		else if (deferred) this.winRef.requestAnimationFrame(() => {
			// OWNERSHIP AT FIRE TIME, through the view's LIVE entry. A hold this
			// overlay installed since the capture takes the measure as its own
			// swallowed callback; so does a hold a SUCCESSOR overlay on the same
			// view installed after this one unmounted (its shadow is what the
			// live entry resolves to, and it replays at that hold's release).
			// Only when nothing holds the view does the call reach CodeMirror.
			// The captured callable is never called from here: it would measure
			// beneath whatever hold is live.
			if (this.view !== view) return;
			const own = this.measureHold ?? null;
			if (own) { own.swallowed = true; return; }
			const entry = (view as unknown as Record<string, unknown>).measure;
			if (typeof entry === "function") (entry as (this: EditorView, flush?: boolean) => unknown).call(view, false);
			else view.requestMeasure();
		});
		else measure.call(view, false);
	}

	/**
	 * The watchdog's outcome for a preview still live at PINCH_MEASURE_HOLD_MAX_MS.
	 *
	 * Releasing the hold under a frozen preview would let CodeMirror's next
	 * measure rescale the scroll under the pan - the displacement the hold
	 * exists to prevent - and re-arming it would keep an editor whose end
	 * event was lost from measuring for its lifetime. So the gesture is
	 * settled IN PLACE, the way a lift settles it (the raster lands at the
	 * current scale where the preview showed it), and re-anchored at once at
	 * the same target, the way the router itself re-arms a live pinch when a
	 * third finger lands. Fingers still on the glass continue from that
	 * anchor: their ratios are the router's, relative to its own start, so
	 * `pinch` divides them by the ratio at which this happened. A lost end
	 * gets the same settle and a harmless re-anchor the next real start
	 * replaces.
	 */
	function rebasePinch(this: InkOverlayPlugin): void {
		// A give easing back at the watchdog's deadline finishes in place; no fingers are on the glass to re-anchor.
		if (this.pinchGive) { this.finishPinchGive(); return; }
		const anchor = this.pinchAnchor;
		if (!this.pinchPreview || !anchor || this.pinchRefScale === null || this.retiring) { this.releaseMeasures(); return; }
		// THE RAW CLIENT CENTROID, not the accepted target: `pinch` takes the
		// client point and applies the constraint's offset itself, so the
		// offset-applied target would be offset twice and a still hold would
		// move when this fires. With the same client point the next move reads
		// as not moved, which is what a still hold is.
		const c = anchor.constraint;
		const target = c ? { x: c.clientX, y: c.clientY } : { x: anchor.targetX ?? anchor.focalX, y: anchor.targetY ?? anchor.focalY };
		const base = this.pinchLastRatio || 1;
		this.pinch("end", 1, target);
		// A preview past the cap lifts into the ease back to the cap; a re-anchor would cancel it and leave the zoom past the cap.
		if (this.pinchGive) return;
		this.pinch("start", 1, target);
		this.pinchRatioBase = base;
	}

	function deferPinchRaster(this: InkOverlayPlugin): boolean {
		// Match the scroll handler's bounded suppression: a lost end event must
		// never suppress future geometry work for the lifetime of the editor.
		return this.pinchPreview && performance.now() - this.pinchScrollAt < PINCH_SCROLL_QUIET_MS;
	}

export function installMeasureHold(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		armDeferredRepaint,
		clearDeferredRepaint,
		holdMeasures,
		resizeOutOfUpdate,
		releaseMeasures,
		rebasePinch,
		deferPinchRaster,
	});
}
