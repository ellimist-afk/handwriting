/**
 * The note surface's pen-path support: the pen probe, the pan readers, the overscroll cancel and stranded-pan resume, the frame ticker,
 * the empty-page notice, the pan drag, and the strip and tail dressing. They are methods of InkOverlayPlugin, installed on its prototype
 * when InkOverlay.ts loads.
 */
import { EditorView } from "@codemirror/view";
import { Notice } from "obsidian";
import { tipMode } from "./TipMode";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";
import { PenSample } from "../input/PointerRouter";
import { emptyPageNoticeText, EmptyPageTool } from "./EmptyPageNotice";
import { noteToVisual } from "./ZoomScale";
import { isPenProbeEnabled, markMappedTip, recordProbe } from "./PenProbe";
import { scrollProbeExtent } from "./ScrollProbe";
import { recordPresentAge } from "../ink/LatencyEstimate";
import { installMethods } from "./InstallMethods";
import { toolbarCorner } from "./InkOverlayToolState";
import { consumeViewportScroll, inlineInk, metrics, type InkOverlayPlugin } from "./InkOverlay";

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		probeSample(sample: PenSample, ev: PointerEvent, point: { x: number; y: number } | undefined, coalesced: number, accepted: boolean, source: "down" | "rawupdate" | "coalesced"): void;
		panX(): number;
		panY(): number;
		restPanX(): number;
		restPanY(): number;
		inkPanX(): number;
		inkPanY(): number;
		inkInputPanX(): number;
		inkInputPanY(): number;
		cancelOverscrollBounce(): void;
		resumeStrandedPan(): boolean;
		firstSettleConsumer(): boolean;
		retirePanSettle(reason: string): void;
		startFrameTicker(): void;
		stopFrameTicker(): void;
		sayIfPageEmpty(path: string | null, kind: EmptyPageTool): void;
		panMove(ev: PointerEvent): void;
		applyToolbarCorner(): void;
		refreshStrip(): void;
		dressTail(highlighter: boolean): void;
	}
}

	/**
	 * Record the newest sample's full chain, and map the DRAWN endpoint back
	 * out to client space so the round-trip error is measured against the real
	 * transforms rather than asserted.
	 */
	function probeSample(
		this: InkOverlayPlugin,
		sample: PenSample,
		ev: PointerEvent,
		point: { x: number; y: number } | undefined,
		coalesced: number,
		accepted: boolean,
		source: "down" | "rawupdate" | "coalesced"
	): void {
		if (!isPenProbeEnabled()) return;
		const rect = this.container?.getBoundingClientRect();
		if (!rect) return;
		const head = this.activeWet?.head();
		// The endpoint actually submitted for drawing. Falls back to the
		// accepted point when the head has not formed yet (first sample).
		const headX = head?.to.x ?? point?.x ?? 0;
		const headY = head?.to.y ?? point?.y ?? 0;
		// …mapped back out through the production camera + scale.
		const screen = this.camera.worldToScreen(headX, headY);
		const backX = rect.left + noteToVisual(screen.x, this.cssScale);
		const backY = rect.top + noteToVisual(screen.y, this.cssScale);
		const noteWorld = this.camera.screenToWorld(sample.x, sample.y);
		// Where the raw pointer itself maps to, for the tip-gap measure.
		const rawScreen = this.camera.worldToScreen(noteWorld.x, noteWorld.y);
		const rawBackX = rect.left + noteToVisual(rawScreen.x, this.cssScale);
		const rawBackY = rect.top + noteToVisual(rawScreen.y, this.cssScale);
		recordProbe({
			at: performance.now(),
			source,
			clientX: ev.clientX,
			clientY: ev.clientY,
			eventTs: ev.timeStamp,
			deliveryAgeMs: performance.now() - ev.timeStamp,
			coalesced,
			accepted,
			noteX: noteWorld.x,
			noteY: noteWorld.y,
			headX,
			headY,
			backX,
			backY,
			// Round-trip fidelity of the raw pointer through every transform.
			errPx: Math.hypot(rawBackX - ev.clientX, rawBackY - ev.clientY),
			// How far the drawn tip sits behind the raw pointer.
			tipGapPx: Math.hypot(backX - ev.clientX, backY - ev.clientY),
		});
		markMappedTip(backX, backY);
	}

	/** The live focal pan on x, in painted px. Zero when there is none. */
	function panX(this: InkOverlayPlugin): number {
		const bounce = this.bounceOffset;
		return this.restPanX() + (bounce && Number.isFinite(bounce.x) ? bounce.x : 0);
	}
	/** The live focal pan on y, in painted px. Zero when there is none. */
	function panY(this: InkOverlayPlugin): number {
		const bounce = this.bounceOffset;
		return this.restPanY() + (bounce && Number.isFinite(bounce.y) ? bounce.y : 0);
	}
	/** The pan without a playing overscroll bounce: where the page rests. */
	function restPanX(this: InkOverlayPlugin): number {
		const pan = this.viewportPan;
		return pan && Number.isFinite(pan.x) ? pan.x : 0;
	}
	function restPanY(this: InkOverlayPlugin): number {
		const pan = this.viewportPan;
		return pan && Number.isFinite(pan.y) ? pan.y : 0;
	}
	/** Only the pan not already represented by the raster camera moves pixels. */
	function inkPanX(this: InkOverlayPlugin): number { return this.panX() - (this.rasterPan?.x ?? 0) * this.cssScale; }
	function inkPanY(this: InkOverlayPlugin): number { return this.panY() - (this.rasterPan?.y ?? 0) * this.cssScale; }
	/**
	 * WHERE THE INK IS PAINTED, for a pen sample. The ink layer's transform carries one more term
	 * than the pan: the preview offset (column re-centring under a live pinch preview, note px), which the pen's
	 * client point must also be read against or a stroke drawn under a live preview lands off by exactly that
	 * offset (measured: 115 note px, x only, on a paused cap ease). Zero outside a preview, so the settled path
	 * is byte-identical.
	 */
	function inkInputPanX(this: InkOverlayPlugin): number { return this.inkPanX() + this.previewInkOffset * this.cssScale; }
	function inkInputPanY(this: InkOverlayPlugin): number { return this.inkPanY() + (this.previewInkOffsetY || 0) * this.cssScale; }

	/** Put the page on its rest now, ending a bounce wherever it is: before an input is mapped, a new gesture, a teardown. */
	function cancelOverscrollBounce(this: InkOverlayPlugin): void {
		const offset = this.bounceOffset, state = this.bounceState;
		if (!offset || (!state && offset.x === 0 && offset.y === 0)) return;
		if (state?.raf) this.winRef.cancelAnimationFrame(state.raf);
		this.bounceState = null;
		// The spring's will-change comes off with it (startOverscrollBounce put it on).
		this.inkLayer?.setCssStyles({ willChange: "" });
		this.panSizer()?.setCssStyles({ willChange: "" });
		// A CANCELLED EASE LEAVES THE PAGE WHERE IT IS. What the viewer sees is
		// `pan + offset`, so zeroing the offset on its own drops the page by whatever the ease still had
		// to run - measured, the seed release arrived at -225.20 and -244.50 against the -300.00 it owed,
		// and on that arm no ease ever reached its last frame because the next gesture cancels it. The
		// remainder folds into the pan here, which moves nothing on screen and leaves the page under the
		// fingers that grabbed it. Every cancel site inherits it.
		// Infinite Canvas ON keeps 3578f29e's drop, byte-identical.
		// Alan direct, "yes fix it": BOTH SETTINGS. The fold is what keeps a page from
		// jumping when an ease is cut, and that is as true with Infinite Canvas on as off; the earlier
		// byte-identical rule is relaxed for this one site by his word. Everything else on the IC-on
		// path stays 3578f29e.
		if (offset.x !== 0 || offset.y !== 0) {
			this.viewportPan.x += offset.x; this.viewportPan.y += offset.y;
		}
		offset.x = 0; offset.y = 0;
		this.writeViewportPan();
	}

	/**
	 * EVERY CONTACT IS GONE AND NOTHING CLAIMED THE VIEWPORT. A tap, a palm or a pen stroke calls
	 * `onViewportInput` at its own pointerdown (InlinePenRouter.pointerDown, before it knows what the
	 * contact is), which cancels a playing ease; the fold leaves the difference sitting in
	 * `viewportPan` rather than dropping it, so the page is exactly where it was, just no longer easing
	 * anywhere. A real gesture's own settle already drives the page to its rest before this fires, so in
	 * that case there is nothing left to do here - this only ever finds work behind a contact that owned
	 * nothing. The rest is not always 0: a page bigger than its room keeps the far-end floor,
	 * read off the last settle's own numbers (`boundReadout`, no scale change since) rather than
	 * recomputed here. Park the standing pan at that bound and ease the difference back in as the bounce
	 * offset, so the page keeps painting exactly where it stood and glides on from there.
	 */
	function resumeStrandedPan(this: InkOverlayPlugin): boolean {
		if (this.bounceState || this.pinchPreview || this.frame.locked) return false;
		const pan = this.viewportPan;
		// SCROLL BEYOND THE LEFT RESERVE IS PAID FIRST. A pan standing right of the ceiling while the scroller holds scroll
		// past the reserve is the same world place as less pan and less scroll, so that much is paid into the scroll in this
		// frame and the screen does not move. The reserve's own scroll is never paid: it is room for ink left of the page,
		// reached by scrolling, so the rest of the pan eases back below and the page slides to its edge with the margin ink
		// off-screen left. A scroll already inside the reserve (the user scrolled there) pays nothing and is kept.
		if (pan.x > 0) {
			const scroller = this.view.scrollDOM, scale = this.cssScale > 0 ? this.cssScale : 1, before = scroller.scrollLeft;
			const reserve = this.leftReserveHeld > 0 ? this.leftReserveHeld : 0;
			const want = Math.min(pan.x, Math.max(0, before - reserve) * scale);
			if (want > 0) {
				this.setViewportScroll(before - want / scale, scroller.scrollTop);
				// What the range actually moved, not what was asked: scrollLeft rounds.
				pan.x -= (before - scroller.scrollLeft) * scale;
				this.writeViewportPan();
			}
		}
		// The bound the last settle left standing, at the scale still in force (no zoom since): a ceiling of 0
		// always, and IC off only, a floor too - byte-identical to 3578f29e with it on.
		const targetX = this.canvasMode ? Math.min(pan.x, 0) : Math.max(this.boundReadout.floorX, Math.min(pan.x, 0));
		const targetY = this.canvasMode ? Math.min(pan.y, 0) : Math.max(this.boundReadout.floorY, Math.min(pan.y, 0));
		const dx = pan.x - targetX, dy = pan.y - targetY;
		if (dx === 0 && dy === 0) return false;
		pan.x = targetX; pan.y = targetY;
		if (!this.startOverscrollBounce({}, dx, dy)) { pan.x += dx; pan.y += dy; return false; }
		this.writeViewportPan();
		return true;
	}

	function firstSettleConsumer(this: InkOverlayPlugin): boolean {
		return this.view.state.facet(EditorView.scrollHandler)[0] === consumeViewportScroll;
	}

	/** `reason` names the caller; a hold retired while still pending is logged
	 * with it through the scroll probe, so a cancelled settle is never silent. */
	function retirePanSettle(this: InkOverlayPlugin, reason: string): void {
		const hold = this.panAnchorHold;
		if (this.bouncedHold === hold) this.bouncedHold = null;
		if (hold?.outcome === "pending") {
			hold.outcome = "cancelled";
			scrollProbeExtent(`settle hold cancelled while pending: ${reason}`);
		}
		this.panAnchorHold = null;
	}

	/**
	 * Feed StrokeMetrics.recordFrame while a stroke is live.
	 *
	 * That recorder had exactly ONE caller - the canvas page view's ticker -
	 * so every stroke drawn in a note reported `frame 0/0ms`. Not "the frames
	 * were perfect": nothing ever measured them. It cost a flicker hunt the
	 * one number that would have located it (alan, hardware, 2026-08-30).
	 *
	 * Runs only between pen-down and pen-up, and does nothing per frame but
	 * read a timestamp, so the latency path pays a rAF callback and no work.
	 */
	function startFrameTicker(this: InkOverlayPlugin): void {
		if (this.frameTicking) return;
		this.frameTicking = true;
		const token = this.frameTickToken = {};
		const tick = (ts: number): void => {
			if (this.frameTickToken !== token) return;
			this.frameRaf = 0;
			this.snapPreview?.check();
			if (this.frameTickToken !== token) return;
			metrics.recordFrame(ts);
			// The present probe's frame, read here rather than from a second
			// callback of its own (schedulePresentProbe).
			const probeTs = this.presentProbeTs;
			if (typeof probeTs === "number") {
				this.presentProbeTs = null;
				this.presentProbePending = false;
				const presentAge = performance.now() - probeTs;
				recordPresentAge(presentAge);
				metrics.recordPresent(presentAge);
			}
			this.frameRaf = this.winRef.requestAnimationFrame(tick);
		};
		this.frameRaf = this.winRef.requestAnimationFrame(tick);
	}

	function stopFrameTicker(this: InkOverlayPlugin): void {
		this.frameTicking = false;
		// A new pen-down may precede the old callback. Cancel its frame and
		// invalidate its closure so consecutive strokes cannot multiply tickers.
		this.frameTickToken = null;
		if (this.frameRaf) this.winRef.cancelAnimationFrame(this.frameRaf);
		this.frameRaf = 0;
		// A probe still waiting on the ticker gets its own frame, as it would
		// have before it rode the ticker, so the last batch's age is recorded.
		const held = this.presentProbeTs;
		if (typeof held === "number") {
			this.presentProbeTs = null;
			this.presentProbePending = false;
			this.schedulePresentProbe(held);
		}
	}

	/**
	 * The empty-page refusal, for whichever tool discovered it - the ONE
	 * place either of them is allowed to say it.
	 *
	 * Three things happen here that the two call sites each used to get
	 * wrong on their own:
	 *
	 * 1. CERTAINTY FIRST. An empty stroke list is not evidence the page is
	 *    empty; it is the store's cache, and until `ensureLoaded` has read
	 *    the sidecar the cache is empty for every note in the vault. On
	 *    "unknown" this says nothing and kicks the read instead - which is
	 *    also what puts the ink on screen, so the user gets their page back
	 *    rather than a sentence denying it exists.
	 * 2. ONCE PER EPISODE. `EmptyPageNoticeGate` remembers what has been
	 *    said, so an eraser scrub's second through twentieth contacts are
	 *    silent. Cleared when the note's ink changes, or the note does.
	 * 3. NO PALETTE COMMAND. This raises a Notice and returns. It does not
	 *    reach `app.commands`, and a source guard
	 *    (EraserContactSource.test.ts) holds the whole eraser branch to
	 *    that - the original 1.4.12 report was filed against
	 *    `delete-all-ink`'s toast, and the first thing worth being able to
	 *    prove is that a pen contact cannot run a palette command at all.
	 */
	function sayIfPageEmpty(this: InkOverlayPlugin, path: string | null, kind: EmptyPageTool): void {
		if (!path) return;
		const presence = inlineInk.inkPresence(path);
		if (presence === "unknown") {
			this.loadInk(path);
			return;
		}
		const text = emptyPageNoticeText(presence, kind);
		if (text !== null && this.emptyNotice.claim(path, kind)) new Notice(text);
	}

	/**
	 * Drag the scroller by the pen's travel. Client coordinates, like the
	 * touch assist pan: they are viewport-absolute, so scrolling the surface
	 * cannot feed back into the next delta the way overlay-relative ones
	 * would (the page would accelerate away under the nib).
	 */
	function panMove(this: InkOverlayPlugin, ev: PointerEvent): void {
		const last = this.panLast;
		if (!last) return;
		const dx = ev.clientX - last.x;
		const dy = ev.clientY - last.y;
		if (dx === 0 && dy === 0) return;
		this.panLast = { x: ev.clientX, y: ev.clientY };
		const el = this.view.scrollDOM;
		el.scrollLeft -= dx;
		el.scrollTop -= dy;
	}

	/** Move this editor's strip to the configured corner. */
	function applyToolbarCorner(this: InkOverlayPlugin): void {
		this.mobileTools?.setCorner(toolbarCorner);
	}

	/** The strip's active-tool marks are stale; recompute them. */
	function refreshStrip(this: InkOverlayPlugin): void {
		if(tipMode()!=="space")this.clearSpaceFeedback();
		this.snapPreview?.check();
		this.mobileTools?.refresh();
		this.noteZoomControls?.refresh();
	}

	/**
	 * The tail canvas carries a live highlighter's tip and, between strokes,
	 * selection chrome. The tip is a wash like the trail under it (what the
	 * PDF head canvas does); the chrome is UI and stays opaque.
	 */
	function dressTail(this: InkOverlayPlugin, highlighter: boolean): void {
		if (this.tailWashed === highlighter) return;
		this.tailWashed = highlighter;
		// Optional-chained for the harnesses that build this off the prototype.
		this.tailCanvas?.setCssStyles({ opacity: highlighter ? String(HIGHLIGHTER_ALPHA) : "1" });
	}

export function installPenSupport(proto: InkOverlayPlugin): void {
	installMethods(proto, {
		probeSample,
		panX,
		panY,
		restPanX,
		restPanY,
		inkPanX,
		inkPanY,
		inkInputPanX,
		inkInputPanY,
		cancelOverscrollBounce,
		resumeStrandedPan,
		firstSettleConsumer,
		retirePanSettle,
		startFrameTicker,
		stopFrameTicker,
		sayIfPageEmpty,
		panMove,
		applyToolbarCorner,
		refreshStrip,
		dressTail,
	});
}
