/**
 * The veto on palm-shaped touches, for surfaces that hand gestures to the
 * browser.
 *
 * The pdf surface passes `touch-action: pinch-zoom` on purpose: the viewer
 * owns two-finger zoom, and taking every touch made the iPad read them as
 * sidebar swipes. The cost arrived later - a hand nudging the glass lands as
 * two contacts, the browser reads them as a pinch, and the document zooms
 * under someone who was reaching for the keyboard (alan, surface,
 * 2026-08-30). The pen-proximity gate never fires there, because there was
 * no pen anywhere near.
 *
 * So this rejects by SHAPE instead of by proximity. A fingertip reports a
 * contact radius of a few pixels; the heel of a hand reports a slab. Any
 * touch whose radius crosses the threshold is swallowed at capture, before
 * the browser's gesture recognizer or the viewer's own handlers see it -
 * which is the only stage where preventDefault still cancels a native
 * gesture.
 *
 * What this deliberately does NOT do: guess from timing or spread. Two
 * fingertips landing close together and moving apart is a real pinch that
 * merely started small, and a rejector that eats it teaches people the
 * feature is broken. Hardware that reports no radius at all (some drivers
 * report 0 for everything) makes the shield inert rather than trigger-happy:
 * a shield that cannot see palms must not start seeing them everywhere.
 *
 * The classifier is pure and the DOM wiring is thin, so the decision table
 * is testable without synthesizing TouchEvents.
 */

/**
 * Contact radius, in css px, at and above which a touch is a palm.
 *
 * A fingertip on the hardware here reports 2-10px; a palm heel 20-40. The
 * threshold sits well clear of fingers rather than close to palms: a missed
 * palm zooms one document once, a swallowed finger breaks scrolling in a way
 * nobody can diagnose from the outside.
 */
export const PALM_RADIUS_PX = 16;

/**
 * Whether this platform's contact radii mean what the threshold assumes.
 *
 * The 16px line was calibrated on Windows touch hardware, where a fingertip
 * reports a few pixels. iOS reports the honest contact ellipse - a fingertip
 * lands at 20-40px - so on an iPad EVERY finger read as a palm and the
 * shield swallowed all touch on the pdf scroller: no scroll, no pinch, from
 * the first finger after a stroke (release eve, 2026-08-30). Apple runs its
 * own palm rejection whenever a Pencil is active, so the shield is not just
 * miscalibrated there - it is redundant. It stays off on Apple touch
 * platforms rather than re-tuned for them.
 */
export function isAppleTouchPlatform(nav: {
	userAgent?: string;
	platform?: string;
	maxTouchPoints?: number;
}): boolean {
	const ua = nav.userAgent ?? "";
	return (
		/iPad|iPhone|iPod/.test(ua) ||
		// iPadOS reports itself as MacIntel; the touch points give it away.
		(nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1)
	);
}

export function palmRadiusTrustworthy(nav: {
	userAgent?: string;
	platform?: string;
	maxTouchPoints?: number;
}): boolean {
	// Android Chromium reports honest ellipses like iOS does: on a Boox a
	// fingertip meets the 16px line and the shield ate all finger scroll
	// (found in the 1.3.11 review before any Boox user could). The
	// threshold is desktop-calibrated and runs only there.
	if (/Android/i.test(nav.userAgent ?? "")) return false;
	return !isAppleTouchPlatform(nav);
}

/** The slice of Touch this cares about, for tests and for the future. */
export interface TouchLike {
	identifier: number;
	radiusX?: number;
	radiusY?: number;
}

export function isPalmTouch(t: TouchLike): boolean {
	return Math.max(t.radiusX ?? 0, t.radiusY ?? 0) >= PALM_RADIUS_PX;
}

/**
 * One event's verdict: which new identifiers to start swallowing, and
 * whether this event must be vetoed. An event is vetoed when ANY of its
 * changed touches is a palm or already swallowed - a palm plus a finger is
 * still a hand on the glass, and letting the finger half through hands the
 * browser a one-finger gesture the person never meant.
 */
export function palmVerdict(
	changed: readonly TouchLike[],
	swallowed: ReadonlySet<number>
): { veto: boolean; begin: number[] } {
	const begin: number[] = [];
	let veto = false;
	for (const t of changed) {
		if (swallowed.has(t.identifier)) {
			veto = true;
		} else if (isPalmTouch(t)) {
			begin.push(t.identifier);
			veto = true;
		}
	}
	return { veto, begin };
}

/**
 * The wiring. Capture phase and non-passive, or the veto arrives after the
 * browser has already committed to the gesture. `stopImmediatePropagation`
 * keeps the viewer's own touch handlers - pdf.js implements pinch itself on
 * some platforms - from acting on a contact the shield has claimed.
 */
export class PalmShield {
	private swallowed = new Set<number>();
	private el: HTMLElement | null = null;
	/** Palm contacts rejected since attach, for the diagnostics report. */
	rejected = 0;

	private onStart = (e: TouchEvent): void => {
		const { veto, begin } = palmVerdict(Array.from(e.changedTouches), this.swallowed);
		for (const id of begin) this.swallowed.add(id);
		this.rejected += begin.length;
		if (veto) {
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	};

	private onMove = (e: TouchEvent): void => {
		// The same begin logic as the start handler: a palm that lands
		// gently and FLATTENS mid-contact only crosses the threshold on a
		// move, and judging moves by past verdicts alone let it through.
		// Still shape, never timing.
		const { veto, begin } = palmVerdict(Array.from(e.changedTouches), this.swallowed);
		for (const id of begin) this.swallowed.add(id);
		this.rejected += begin.length;
		if (veto) {
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	};

	private onEnd = (e: TouchEvent): void => {
		let held = false;
		for (const t of Array.from(e.changedTouches)) {
			if (this.swallowed.delete(t.identifier)) held = true;
		}
		if (held) {
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	};

	attach(el: HTMLElement): void {
		this.dispose();
		this.el = el;
		const opts = { capture: true, passive: false } as const;
		el.addEventListener("touchstart", this.onStart, opts);
		el.addEventListener("touchmove", this.onMove, opts);
		el.addEventListener("touchend", this.onEnd, opts);
		el.addEventListener("touchcancel", this.onEnd, opts);
	}

	dispose(): void {
		if (!this.el) return;
		const opts = { capture: true } as const;
		this.el.removeEventListener("touchstart", this.onStart, opts);
		this.el.removeEventListener("touchmove", this.onMove, opts);
		this.el.removeEventListener("touchend", this.onEnd, opts);
		this.el.removeEventListener("touchcancel", this.onEnd, opts);
		this.el = null;
		this.swallowed.clear();
	}
}
