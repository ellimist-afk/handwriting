/**
 * The slides surface's mount, geometry and theme methods: hanging the ink layers over the reveal viewport, measuring the deck and sizing the
 * layers to it, reading the deck's theme, and repainting the committed ink. They are methods of SlidesDeck, installed on its prototype when
 * SlidesInkSurface.ts loads.
 */
import { diagnosticsEnabled } from "../diag/DiagSwitch";
import { computeCanvasSize } from "../diag/Raster";
import { DARK_MAX_LUMINANCE, isDarkTheme, relativeLuminance, setInkThemeOverride } from "../ink/InkTheme";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";
import { InkTool } from "../ink/Stroke";
import { drawStroke } from "../ink/StrokeRenderer";
import { TailRenderer } from "../ink/TailRenderer";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { installMethods } from "../inline/InstallMethods";
import { BLACK_DECK_LINK, COMMITTED_CLASS, type DeckGeometry, describe, type HeadLike, type Layers, log, opaqueRgb, presentIndex, slideCamera, SLIDES_DESYNCHRONIZED, slidesBackingScale, slideScale, TAIL_CLASS, WET_CLASS, WHITE_DECK_LINK, type SlidesDeck } from "./SlidesInkSurface";

declare module "./SlidesInkSurface" {
	interface SlidesDeck {
		remount(): void;
		mountCanvases(index: number): boolean;
		measureDeckTheme(): void;
		setDeckTheme(dark: boolean, how: "measured" | "link" | "body"): void;
		onCssChange(): void;
		win(): Window;
		measureGeometry(): DeckGeometry;
		geometry(): DeckGeometry;
		refresh(): void;
		watchResolution(): void;
		unwatchResolution(): void;
		syncGeometry(): void;
		ensureCanvasesMounted(): boolean;
		repaint(): void;
		dressWet(l: Layers, tool: InkTool): void;
	}
}


	// ---- mounting and painting -------------------------------------------

	function remount(this: SlidesDeck): void {
		if (this.disposed) return;
		const index = presentIndex(this.sections());
		if (index < 0) {
			if (!this.awaitingPresent) {
				this.awaitingPresent = true;
				if (diagnosticsEnabled()) log("no slide marked present yet; waiting for reveal to mark one");
			}
			return;
		}
		if (!this.layers && !this.mountCanvases(index)) return;
		const l = this.layers;
		if (!l) return;
		if (l.index !== index) {
			// The stroke in the reader's hand, FIRST and against the OLD index,
			// which `l.index` still is on this line. A clicker or an arrow key
			// changes the slide with no pointer event of any kind, so nothing
			// on the input path can see this coming.
			this.endStrokeForSlideChange();
			l.index = index;
			this.actionsChanged();
			if (diagnosticsEnabled()) {
				log(
					`slide ${index} now present: repainting ` +
						`${(this.strokes.get(index) ?? []).length} stroke(s)`
				);
			}
		}
		this.refresh();
	}

	/** Hang the ink layers over the `.reveal` viewport (A2). */
	function mountCanvases(this: SlidesDeck, index: number): boolean {
		const doc = this.revealEl.ownerDocument;
		const win = doc.defaultView ?? window;
		const make = (cls: string, z: string): HTMLCanvasElement => {
			const canvas = this.revealEl.createEl("canvas");
			canvas.className = cls;
			// `pointer-events:none` is not an optimisation, it is the routing
			// design: input is claimed on `.reveal`, never on a canvas. A
			// canvas that took pointers would sit between Reveal and its own
			// controls.
			Object.assign(canvas.style, {
				position: "absolute",
				left: "0",
				top: "0",
				pointerEvents: "none",
				// Above the sections and BELOW Reveal's controls (z-index 30ish),
				// so the arrows stay visible under ink drawn across them.
				zIndex: z,
			} as Partial<CSSStyleDeclaration>);
			return canvas;
		};
		// Apply alpha after composing committed, wet and head highlight pixels.
		// Separate translucent canvases would darken every live crossing/seam.
		const highlightGroup = this.revealEl.createDiv();
		highlightGroup.className = "handwriting-slides-highlight-group";
		Object.assign(highlightGroup.style, {
			position: "absolute", left: "0", top: "0", width: "100%", height: "100%",
			pointerEvents: "none", zIndex: "19", opacity: String(HIGHLIGHTER_ALPHA),
		});
		const highlight = make("handwriting-slides-highlight", "0");
		highlightGroup.appendChild(highlight);
		const committed = make(COMMITTED_CLASS, "20");
		const wetCanvas = make(WET_CLASS, "21");
		// Above the wet layer and still below Reveal's controls: the head is
		// the newest ink and must not be painted under the strip behind it.
		const tailCanvas = make(TAIL_CLASS, "22");
		if (win.getComputedStyle(this.revealEl).position === "static") {
			// Reveal positions `.reveal` itself; this is defensive only. A
			// static one would put both canvases at the nearest positioned
			// ancestor's corner, which is the body.
			//
			// Restored on dispose, like the touch-action guard beside it: the
			// surface leaves no trace on somebody else's element, and a
			// `position` this file wrote outliving the presentation is a change
			// to Reveal's own layout that nobody would think to look here for.
			const saved = this.revealEl.style.position;
			this.revealEl.setCssStyles({ position: "relative" });
			this.disposers.push(() => {
				this.revealEl.setCssStyles({ position: saved });
			});
			if (diagnosticsEnabled()) log("reveal element was position:static; patched to relative");
		}
		// `.reveal` carries no tabindex of its own, so a later call from
		// `ensureDeckFocused` to take DOM focus is a silent no-op: the
		// deck never actually takes it, a caret left in the note behind the
		// presentation keeps it, and Reveal's own document keydown handler
		// returns early whenever `document.activeElement.isContentEditable` is
		// true. `-1`: focusable from script, never from Tab - this is a
		// presentation, not a form. A `.reveal` that already carries a tabindex
		// (a snippet, a Reveal plugin) is left exactly as it is.
		if (this.revealEl.tabIndex < 0 && !this.revealEl.hasAttribute("tabindex")) {
			this.revealEl.tabIndex = -1;
			if (diagnosticsEnabled()) log("reveal element had no tabindex; patched to -1");
		} else {
			if (diagnosticsEnabled()) {
				log(
					`reveal element already has a tabindex ` +
						`(${this.revealEl.getAttribute("tabindex") ?? this.revealEl.tabIndex}); left alone`
				);
			}
		}
		this.revealEl.appendChild(committed);
		this.revealEl.appendChild(wetCanvas);
		this.revealEl.appendChild(tailCanvas);
		const ctx = committed.getContext("2d");
		const highlightCtx = highlight.getContext("2d");
		if (!ctx || !highlightCtx) {
			highlightGroup.remove();
			committed.remove();
			wetCanvas.remove();
			tailCanvas.remove();
			log("2d context refused; slides ink inert for this deck");
			return false;
		}
		let wet: WetInkRenderer;
		let tail: TailRenderer;
		try {
			wet = new WetInkRenderer(wetCanvas, SLIDES_DESYNCHRONIZED);
			// Both layers are plain (non-desynchronized) canvases: see
			// `SLIDES_DESYNCHRONIZED` above for the A/B InkOverlay ran on this
			// flag. The tail was never desynchronized in the first place - there
			// is no separate finding for it here.
			tail = new TailRenderer(tailCanvas);
		} catch (err) {
			highlightGroup.remove();
			committed.remove();
			wetCanvas.remove();
			tailCanvas.remove();
			log(`wet ink context refused (${String(err)}); slides ink inert for this deck`);
			return false;
		}
		wet.smooth = true;
		wet.shape = true;
		this.layers = {
			highlightGroup,
			highlight,
			highlightCtx,
			wetTool: "pen",
			committed,
			ctx,
			wetCanvas,
			wet,
			tailCanvas,
			tail,
			index,
			cssWidth: 0,
			cssHeight: 0,
		};
		// The allocation this deck is about to ask for, beside the flag that
		// was measured against it. `syncGeometry` writes the stores a moment
		// later; this is the same arithmetic it will do, reported where a
		// reader looking at a blank deck will find it. `capped` is the whole
		// diagnosis for the silent-refusal failure: with no ceiling this
		// surface asked for three stores of whatever the display implied.
		if (diagnosticsEnabled()) {
			const vw = this.revealEl.clientWidth;
			const vh = this.revealEl.clientHeight;
			const mountDpr = win.devicePixelRatio || 1;
			const ratio = slidesBackingScale(vw, vh, mountDpr);
			const mountSize = computeCanvasSize(vw, vh, ratio);
			log(
				`mount: four canvases on ${describe(this.revealEl)}, starting on slide ${index}, ` +
					`wet desynchronized: requested ${wet.requested} actual ${wet.actualDesynchronized}, ` +
					`backing ${mountSize.backingW}x${mountSize.backingH} at ratio ${ratio.toFixed(3)} ` +
					`(dpr ${mountDpr}${ratio < mountDpr ? ", capped" : ""}), build ${this.host.buildId}`
			);
		}
		this.measureDeckTheme();
		return true;
	}

	/**
	 * Once per deck mount, plus once more per `css-change` that actually
	 * moves `.reveal`'s paint (`onCssChange`, GAP 16) - never per stroke,
	 * never per repaint or slide change otherwise: tell the ink layer which
	 * way the DECK is painted, because it is not the way the body is.
	 *
	 * Measured from the deck's own paint rather than from Obsidian's Appearance
	 * setting. The setting is what Obsidian consults (see BLACK_DECK_LINK), but
	 * it is one indirection away from the thing that matters, and a theme or
	 * snippet that restyles `.reveal` moves the paint without moving the
	 * setting. Luminance against `DARK_MAX_LUMINANCE` - the same threshold the
	 * ink itself is judged by, imported rather than copied - separates the two
	 * decks with room to spare: black.css's #191919 sits at 0.010 and
	 * white.css's #fff at 1.0.
	 *
	 * The override it sets is module-wide while the deck is live, so an editor
	 * pane repainting behind the presentation takes the deck's theme for that
	 * repaint. Accepted: a presentation covers the screen. `dispose` clears it.
	 */
	function measureDeckTheme(this: SlidesDeck): void {
		const doc = this.revealEl.ownerDocument;
		const win = doc.defaultView ?? window;
		const rgb = opaqueRgb(win.getComputedStyle(this.revealEl)?.backgroundColor);
		if (rgb !== null) {
			this.setDeckTheme(relativeLuminance(rgb.r, rgb.g, rgb.b) < DARK_MAX_LUMINANCE, "measured");
			return;
		}
		// Nothing readable on `.reveal` itself. Which stylesheet the presenter
		// loaded says it just as well, and says it about the deck rather than
		// about the workspace behind it.
		const head: HeadLike | null = (doc as unknown as { head?: HeadLike | null }).head ?? null;
		if (typeof head?.querySelector === "function") {
			if (head.querySelector(BLACK_DECK_LINK)) return void this.setDeckTheme(true, "link");
			if (head.querySelector(WHITE_DECK_LINK)) return void this.setDeckTheme(false, "link");
		}
		// Neither: this is not the presenter we know about, so the body class is
		// the best evidence left and is what ink would have used anyway.
		this.setDeckTheme(isDarkTheme(doc), "body");
	}

	function setDeckTheme(this: SlidesDeck, dark: boolean, how: "measured" | "link" | "body"): void {
		this.deckDark = dark;
		setInkThemeOverride(dark);
		if (diagnosticsEnabled()) log(`deck theme: ${dark ? "dark" : "light"} (${how})`);
	}

	/**
	 * `css-change` re-arms the theme measurement (GAP 16): a theme or snippet
	 * switch mid-presentation restyles `.reveal` without remounting the deck,
	 * so nothing else calls `measureDeckTheme` again for the life of the
	 * presentation - the override taken at mount goes stale and ink is
	 * painted invisible against the new paint. Re-measure, and only reset the
	 * override and repaint when the answer actually changed, so a
	 * `css-change` for an unrelated reason (a font, a plugin's own CSS) costs
	 * one `getComputedStyle` and nothing else.
	 */
	function onCssChange(this: SlidesDeck): void {
		if (this.disposed) return;
		const before = this.deckDark;
		this.measureDeckTheme();
		if (this.deckDark !== before) this.repaint();
	}

	/** The deck's window. One place, so nothing has to spell it out again. */
	function win(this: SlidesDeck): Window {
		return this.revealEl.ownerDocument.defaultView ?? window;
	}

	/**
	 * The deck rect, its pre-transform width and its scale, measured off
	 * `.slides` (S3).
	 *
	 * `layoutWidth` is carried out with the rect rather than re-read at the
	 * call site so that every mapping divides by a k measured off the SAME
	 * pair of numbers as the offset it subtracts.
	 */
	function measureGeometry(this: SlidesDeck): DeckGeometry {
		// The move path's forced-layout counter. This method is the ONLY
		// forced layout reachable from a pointermove (through `geometry()`,
		// and only when the cache is empty), so a non-zero count in the trace
		// line is the whole finding: the cache was missed mid-stroke. Counted
		// once per entry rather than once per read - there are three reads
		// below - because the number that matters is zero versus not zero.
		this.moveTrace.countLayoutRead();
		const rect = this.slidesEl.getBoundingClientRect();
		const layoutWidth = this.slidesEl.clientWidth;
		const k = slideScale(rect, layoutWidth);
		// The camera is measured with the rect, not derived from it later: the
		// two used to be taken from separate `getBoundingClientRect` calls two
		// lines apart, which is both the second forced layout and the shape
		// that lets an offset drift from the k it is divided by.
		const camera = slideCamera(rect, this.revealEl.getBoundingClientRect(), k);
		const geom = { rect, k, layoutWidth, camera };
		this.geom = geom;
		return geom;
	}

	/** The cached geometry, measured on the spot only if there is none yet. */
	function geometry(this: SlidesDeck): DeckGeometry {
		return this.geom ?? this.measureGeometry();
	}

	/** Re-measure, then redraw. The one entry point after any layout move. */
	function refresh(this: SlidesDeck): void {
		this.syncGeometry();
		this.repaint();
	}

	/**
	 * Fire `refresh` when devicePixelRatio changes, and re-arm on the new one.
	 *
	 * A `(resolution: Ndppx)` query matches exactly while the ratio is N, so it
	 * flips the moment the ratio moves and only then - which is why both mature
	 * surfaces use one rather than polling. It is one-shot by nature (the new
	 * ratio does not match the old query either), so the handler re-arms
	 * itself, exactly as `InkOverlay.watchResolution` does.
	 *
	 * It calls `refresh`, the same path the resize listeners and the
	 * ResizeObserver call. Nothing about a ratio change is special: the css box
	 * is unchanged, the camera is unchanged (it carries k, A3), and all that is
	 * wrong is the raster density of four backing stores, which `syncGeometry`
	 * is already the sole owner of.
	 *
	 * Guarded on the method existing: this surface's window is a real one in
	 * Obsidian, but a host without `matchMedia` should lose the watcher, not
	 * the deck - the same shape as the `typeof win.ResizeObserver` guard.
	 */
	function watchResolution(this: SlidesDeck): void {
		this.unwatchResolution();
		const win = this.win();
		const dpr = win.devicePixelRatio || 1;
		this.watchedDpr = dpr;
		if (typeof win.matchMedia !== "function") return;
		const mq = win.matchMedia(`(resolution: ${dpr}dppx)`);
		if (!mq || typeof mq.addEventListener !== "function") return;
		const fn = () => {
			if (this.disposed) return;
			if (diagnosticsEnabled()) {
				log(`devicePixelRatio changed from ${dpr} to ${this.win().devicePixelRatio || 1}`);
			}
			this.refresh();
			this.watchResolution();
		};
		this.mediaQuery = mq;
		this.mediaFn = fn;
		mq.addEventListener("change", fn);
	}

	function unwatchResolution(this: SlidesDeck): void {
		if (this.mediaQuery && this.mediaFn) {
			this.mediaQuery.removeEventListener("change", this.mediaFn);
		}
		this.mediaQuery = null;
		this.mediaFn = null;
	}

	/**
	 * Size both canvases to the `.reveal` viewport, backing stores in device
	 * pixels.
	 *
	 * The context transform carries the EFFECTIVE device-pixel ratio alone; k
	 * rides in the camera (A3). So the wet layer's css-pixel clears stay honest
	 * for ink in the letterbox, where the logical coordinates are negative.
	 * "Effective" because `slidesBackingScale` reduces it when four
	 * full-viewport stores would blow the area budget - and because it is one
	 * number used four ways here (css box, backing store, `setTransform`, both
	 * `applyDpr` calls), a cap can never put the transform out of step with the
	 * store it is transforming into.
	 *
	 * The css box is derived BACK from the rounded backing store
	 * (`computeCanvasSize`, the same one the note surface and the page view
	 * use), never left at the raw measured size. Rounding the store while
	 * leaving the css box fractional - the obvious version - makes the ratio
	 * `round(w*r)/w` instead of `r`, and the compositor then resamples the
	 * whole full-viewport canvas every frame. `clientWidth` is integral, so
	 * this only bites when the RATIO is fractional: dpr 1.5 at 150% Windows
	 * scaling, any Obsidian zoom off zero, and now every capped ratio, which is
	 * fractional by construction. It also closes a second hole in the clears:
	 * `cssWidth * ratio` is now exactly `backingW`, so the last sub-pixel
	 * column and row are inside every clear instead of outside all of them.
	 */
	function syncGeometry(this: SlidesDeck): void {
		this.measureGeometry();
		// Before anything is sized: the canvases the last sync sized may not be
		// in the document any more (see `ensureCanvasesMounted`). Re-mounted
		// ones are sized by the recursive call this makes, and then again,
		// identically, by the rest of this pass.
		if (!this.ensureCanvasesMounted()) return;
		const l = this.layers;
		if (!l) return;
		const win = this.revealEl.ownerDocument.defaultView ?? window;
		const w = this.revealEl.clientWidth;
		const h = this.revealEl.clientHeight;
		if (w <= 0 || h <= 0) return;
		const dpr = win.devicePixelRatio || 1;
		// Belt and braces for the media query below: a dpr change that arrived
		// through a resize instead re-arms the watcher on the new value, so it
		// is never left listening for a resolution the display already left.
		if (dpr !== this.watchedDpr) this.watchResolution();
		const ratio = slidesBackingScale(w, h, dpr);
		const size = computeCanvasSize(w, h, ratio);
		const cssW = `${size.cssW}px`;
		const cssH = `${size.cssH}px`;
		l.cssWidth = size.cssW;
		l.cssHeight = size.cssH;
		for (const canvas of [l.highlight, l.committed, l.wetCanvas, l.tailCanvas]) {
			if (canvas.style.width !== cssW || canvas.style.height !== cssH) {
				canvas.style.width = cssW;
				canvas.style.height = cssH;
			}
			if (canvas.width !== size.backingW || canvas.height !== size.backingH) {
				canvas.width = size.backingW;
				canvas.height = size.backingH;
			}
		}
		l.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		l.highlightCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
		l.wet.applyDpr(ratio);
		l.tail.applyDpr(ratio);
		// The deck size the theme actually produced, measured rather than
		// assumed to be Reveal's 960x700, and stored with the ink (§4).
		const deckW = this.slidesEl.clientWidth;
		const deckH = this.slidesEl.clientHeight;
		if (deckW > 0 && deckH > 0) this.deckSize = { width: deckW, height: deckH };
	}

	/**
	 * Are the ink layers still under their expected parents? Repair any missing
	 * or reparented layer.
	 *
	 * `mountCanvases` used to be unreachable for the life of a presentation:
	 * `remount` gates it on `!this.layers` and only `dispose` ever nulls that.
	 * So if the host removed or replaced the canvases while `.reveal` survived,
	 * input kept working perfectly - capture, the palm guard and the tap rule
	 * all live on `.reveal`, not on a canvas - and nothing was painted. The
	 * reader draws invisibly for the rest of the deck, and the strokes DO reach
	 * the sidecar, so the ink turns up correctly the next time the note is
	 * presented and the report is unreproducible. `owns()`/`findDeck` catch the
	 * CONTAINER being swapped and nothing else; the body observer is
	 * deliberately non-subtree (S1), so a rebuild one level in is invisible to
	 * every signal this file has.
	 *
	 * Parent property reads, no layout, no allocation, and NOT on the sample
	 * path: the two callers are `syncGeometry` and `repaint`, so this runs once
	 * per geometry sync and once per committed stroke or erase - never per
	 * pointer event. That is the cheapest place that still notices within one
	 * stroke of the damage. The pdf surface makes the same comparison, and
	 * makes it every paint (`PdfInkController`), which is the precedent.
	 *
	 * `parentElement !== revealEl` rather than `isConnected`: it answers the
	 * re-parented case too, and `.reveal` is the element every coordinate here
	 * is relative to, so being attached SOMEWHERE ELSE is just as wrong as
	 * being detached.
	 *
	 * Returns false when there is nothing to paint on - no layers, a remount
	 * refused a 2d context, or a remount is already in flight - so both callers
	 * bail exactly the way they always did on `!this.layers`.
	 */
	function ensureCanvasesMounted(this: SlidesDeck): boolean {
		const l = this.layers;
		if (!l) return false;
		const liveParent = l.wetTool === "highlighter" ? l.highlightGroup : this.revealEl;
		if (
			l.highlightGroup.parentElement === this.revealEl &&
			l.highlight.parentElement === l.highlightGroup &&
			l.committed.parentElement === this.revealEl &&
			l.wetCanvas.parentElement === liveParent &&
			l.tailCanvas.parentElement === liveParent
		) {
			return true;
		}
		// `mountCanvases` ends in `syncGeometry` (through the caller), which
		// calls this again. One level, and the flag makes that explicit rather
		// than relying on the re-check above happening to be true by then.
		if (this.remounting) return false;
		this.remounting = true;
		try {
			const index = l.index;
			l.highlightGroup.remove();
			l.committed.remove();
			l.wetCanvas.remove();
			l.tailCanvas.remove();
			this.layers = null;
			log(`canvases no longer under ${describe(this.revealEl)}; remounting on slide ${index}`);
			if (!this.mountCanvases(index)) return false;
			// The fresh canvases are 0x0 until this runs, so a `repaint` that
			// triggered the remount would otherwise paint into nothing.
			this.syncGeometry();
		} finally {
			this.remounting = false;
		}
		return this.layers !== null;
	}

	/**
	 * Redraw the current slide's COMMITTED ink. Slide change, load, erase and
	 * resize only - never per sample (A2). That is the lag fix.
	 */
	function repaint(this: SlidesDeck): void {
		if (!this.ensureCanvasesMounted()) return;
		const l = this.layers;
		if (!l) return;
		l.ctx.clearRect(0, 0, l.cssWidth || l.committed.width, l.cssHeight || l.committed.height);
		l.highlightCtx.clearRect(0, 0, l.cssWidth || l.highlight.width, l.cssHeight || l.highlight.height);
		const cam = this.geometry().camera;
		for (const s of this.strokes.get(l.index) ?? []) {
			drawStroke(s.tool === "highlighter" ? l.highlightCtx : l.ctx, cam, s, undefined, true);
		}
	}

	/** Reuse the live renderers without replaying committed ink per sample. */
	function dressWet(this: SlidesDeck, l: Layers, tool: InkTool): void {
		if (l.wetTool === tool) return;
		const parent = tool === "highlighter" ? l.highlightGroup : this.revealEl;
		parent.appendChild(l.wetCanvas);
		parent.appendChild(l.tailCanvas);
		l.wetTool = tool;
	}

export function installSlidesMount(proto: SlidesDeck): void {
	installMethods(proto, {
		remount,
		mountCanvases,
		measureDeckTheme,
		setDeckTheme,
		onCssChange,
		win,
		measureGeometry,
		geometry,
		refresh,
		watchResolution,
		unwatchResolution,
		syncGeometry,
		ensureCanvasesMounted,
		repaint,
		dressWet,
	});
}
