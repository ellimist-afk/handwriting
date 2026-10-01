/**
 * A TOUCHPAD PINCH, AND CTRL+WHEEL, ZOOM THE NOTE.
 *
 * Windows delivers a precision-touchpad pinch as a wheel event with `ctrlKey`
 * set - there is no touch contact to route - and Obsidian reads that as its
 * "Quick font size adjustment". The plugin only followed the resulting font
 * change, so the pinch stopped where Obsidian's font range stops and the zoom
 * counter never moved with it (alan, device, 2026-09-20: "I can't pinch to
 * zoom any further in than 100%, and zooming out doesn't make the zoom counter
 * correspond").
 *
 * This module is the arithmetic of that gesture and nothing else: wheel deltas
 * in, a ratio against the run's start out, plus the quiet-time question that
 * decides when a run has ended. It holds no DOM, reads no clock of its own and
 * drives nothing; `InkOverlay` feeds it events and turns the steps it returns
 * into the existing pinch path, which is what makes the floor, the cap, the
 * give, the focal hold and the settle come for free rather than being written
 * a second time here.
 *
 * A WHEEL RUN HAS NO LIFT. Two fingers on glass announce their own end; a
 * touchpad pinch just stops sending. So the end is a quiet time - no ctrl+wheel
 * for WHEEL_ZOOM_QUIET_MS - and the caller asks for it on its frame clock.
 */

/**
 * Ratio per pixel of accumulated deltaY. `exp(-dy * k)`: wheel up (negative
 * deltaY, fingers spreading) zooms in, and the same number of pixels always
 * multiplies the scale by the same factor, which is what makes a slow run and
 * a fast one land in the same place.
 *
 * 0.002 and not the canvas router's 0.0015 (PointerRouter :130): that router
 * zooms a camera with no cap, where a slower curve costs nothing. Here the
 * range is 10%..600%, so a full sweep should cross it.
 */
export const WHEEL_ZOOM_K = 0.002;

/**
 * Alan direct: the same travel under two fingers on a touchpad moves the
 * zoom 1.5 times as far as it does under a mouse wheel. A touchpad pinch
 * arrives as a stream of small pixel deltas and a mouse wheel as a few big
 * notches, and a hand that pinches expects the whole range within one gesture.
 * The mouse keeps 0.002: nothing about a wheel notch changed.
 */
export const TOUCHPAD_ZOOM_K = 0.003;

/**
 * A wheel notch is coarse: a line or page unit, or a pixel count at least this
 * big. Anything finer with deltaMode 0 is a touchpad. Read ONCE, at the run's
 * first event (see `WheelZoomRun.feed`): mid-run the two kinds overlap - a fast
 * touchpad pinch does send a big delta - and a gain that changed halfway would
 * move the note under fingers that did not move.
 */
export const WHEEL_NOTCH_PX = 50;

/** The kind of a run, from its FIRST event only. */
export function wheelRunKind(deltaY: number, deltaMode: number): "wheel" | "touchpad" {
	return deltaMode !== 0 || Math.abs(deltaY) >= WHEEL_NOTCH_PX ? "wheel" : "touchpad";
}

/** No ctrl+wheel for this long ends the run. One frame at 60 Hz is ~16 ms, so this is ~9 frames. */
export const WHEEL_ZOOM_QUIET_MS = 150;

/** deltaMode 1 (DOM_DELTA_LINE): Firefox and some mice report lines, not pixels. Matches PointerRouter's WHEEL_LINE_HEIGHT. */
export const WHEEL_ZOOM_LINE_PX = 16;

/** deltaMode 2 (DOM_DELTA_PAGE): rare, and only from a mouse. A page is a screenful of lines. */
export const WHEEL_ZOOM_PAGE_PX = 400;

export type WheelZoomEvent = {
	deltaY: number;
	deltaMode: number;
	/** Cursor, in the frame the pinch path takes its centroid in: client coordinates. */
	x: number;
	y: number;
	/** Event time, in the same clock the caller later passes to `endIfQuiet`. */
	t: number;
};

export type WheelZoomStep = {
	phase: "start" | "move" | "end";
	/** Against the run's start, exactly as the router's pinch ratios are. */
	ratio: number;
	centroid: { x: number; y: number };
};

/** One wheel event's travel in pixels, whatever unit the browser reported it in. */
export function wheelDeltaPx(deltaY: number, deltaMode: number): number {
	if (!Number.isFinite(deltaY)) return 0;
	if (deltaMode === 1) return deltaY * WHEEL_ZOOM_LINE_PX;
	if (deltaMode === 2) return deltaY * WHEEL_ZOOM_PAGE_PX;
	return deltaY;
}

/** The ratio a run that has travelled `px` pixels is at. */
export function wheelRatio(px: number, k: number = WHEEL_ZOOM_K): number {
	if (!Number.isFinite(px)) return 1;
	const r = Math.exp(-px * k);
	return Number.isFinite(r) && r > 0 ? r : 1;
}

/**
 * The state of one ctrl+wheel run. Pure: `feed` is the only writer, and the
 * caller's clock is the only clock.
 */
export class WheelZoomRun {
	private live = false;
	private travelPx = 0;
	private anchor = { x: 0, y: 0 };
	private lastAt = 0;
	private kind: "wheel" | "touchpad" = "wheel";

	get isLive(): boolean {
		return this.live;
	}

	/** The ratio the run is at now, against its start, at the run's own gain. 1 when no run is live. */
	get ratio(): number {
		return this.live ? wheelRatio(this.travelPx, this.gain) : 1;
	}

	/** The gain this run was opened with: `TOUCHPAD_ZOOM_K` for a touchpad pinch, `WHEEL_ZOOM_K` for a wheel. */
	private get gain(): number {
		return this.kind === "touchpad" ? TOUCHPAD_ZOOM_K : WHEEL_ZOOM_K;
	}

	/** The point every frame of this run is held about. */
	get centroid(): { x: number; y: number } {
		return { x: this.anchor.x, y: this.anchor.y };
	}

	/**
	 * One ctrl+wheel event. Returns the steps to drive the pinch path with, in
	 * order: the first event of a run opens it with a `start` at ratio 1 - the
	 * same thing two fingers landing do - and then every event, including that
	 * first one, contributes its `move`.
	 *
	 * THE ANCHOR IS THE RUN'S FIRST CURSOR, not each event's. A touchpad pinch
	 * does not move the pointer, and holding the anchor still is what lets the
	 * pinch path read a run of frames as a pure zoom rather than as a zoom that
	 * is also being dragged.
	 */
	feed(e: WheelZoomEvent): WheelZoomStep[] {
		const steps: WheelZoomStep[] = [];
		if (!this.live) {
			this.live = true;
			this.travelPx = 0;
			this.anchor = { x: e.x, y: e.y };
			// The kind is read here and nowhere else, so one gesture keeps one gain.
			this.kind = wheelRunKind(e.deltaY, e.deltaMode);
			steps.push({ phase: "start", ratio: 1, centroid: this.centroid });
		}
		this.lastAt = e.t;
		this.travelPx += wheelDeltaPx(e.deltaY, e.deltaMode);
		steps.push({ phase: "move", ratio: wheelRatio(this.travelPx, this.gain), centroid: this.centroid });
		return steps;
	}

	/**
	 * The end, asked on the caller's frame clock. Null while the run is still
	 * inside its quiet window, or when no run is live. Returning the step also
	 * closes the run, so a second ask cannot end the same run twice.
	 */
	endIfQuiet(now: number): WheelZoomStep | null {
		if (!this.live) return null;
		if (now - this.lastAt < WHEEL_ZOOM_QUIET_MS) return null;
		const step: WheelZoomStep = { phase: "end", ratio: 1, centroid: this.centroid };
		this.live = false;
		this.travelPx = 0;
		return step;
	}

	/** Drop the run without an end step: the caller has already torn the gesture down. */
	cancel(): void {
		this.live = false;
		this.travelPx = 0;
	}
}
