import { countPaintedPixels } from "../diag/Raster";

/**
 * The purged-canvas sentinel: an invisible pixel that says whether WebKit
 * still has our pixels.
 *
 * WHAT IT IS FOR. 1.4.12-design.md §14 ranks the iPad "ink disappears while
 * scrolling" report first as this: WebKit reclaims a canvas's backing store
 * under memory pressure and fires no event, and the scroll repaint draws
 * NOTHING while the camera is still (`scheduleRepaint("scroll")` adds no
 * damage; a band scroll is not camera motion by design). So purged ink stays
 * gone until the band moves or the note is reopened - which is precisely the
 * "open another note and come back" workaround the reporter found. The
 * foreground repaint (ForegroundRepaint.ts) covers a purge that happened
 * while the app was away. This covers one that happens while the user never
 * leaves: paint a marker the eye cannot see, and on a scroll repaint that had
 * no work, read it back. Gone means the canvas was reclaimed.
 *
 * IT IS OFF UNLESS DIAGNOSTICS ARE RECORDING, and that is a decision, not an
 * oversight. `getImageData` is a synchronous readback: WebKit's GPU-process
 * architecture makes it a blocking IPC round trip, and this repo has already
 * been here once - `WetInkRenderer.countPainted` is documented "never on the
 * hot path", and of the two `getImageData` sites in this codebase,
 * diag/Raster.ts is a diagnostics call reached once per pen-up and
 * PdfViewerProbe.ts reads a PDF page's shade once per finished page canvas,
 * never on a pen or scroll path. What nobody could establish
 * from a primary source is whether the pixel TRANSFER is scoped to the
 * requested 1x1 rect or to the whole multi-megapixel surface. That unknown is
 * the difference between microseconds and milliseconds at 3 Hz, during a
 * scroll, on a device none of us owns. So the logic ships complete and under
 * test, and the readback runs only while `diagnosticsEnabled()` - the
 * SESSION switch, not the persisted `devDiagnostics` setting, so an ordinary
 * session pays one boolean and nothing else. One `performance.now()`
 * measurement of the real call on the reporter's iPad, under the exact
 * "scroll repaint found no work" condition, is what would turn it on for
 * everyone.
 *
 * WHAT IS ASSUMED AND NOT PROVEN: that a canvas WebKit has reclaimed reads
 * back as transparent rather than being restored under the reader. If WebKit
 * replays or restores the surface before serving `getImageData`, the sentinel
 * reads healthy on a canvas that is visibly blank and the heal never fires.
 * That failure is silent and costs nothing but the readback, which is the
 * right way round for a guess: it cannot make the bug worse.
 */

/** Milliseconds between readbacks. Three a second, at the very most. */
export const PURGE_PROBE_INTERVAL_MS = 300;

/**
 * Alpha of the marker, as an exact 8-bit 1/255 so the round trip through a
 * byte cannot lose it. Invisible: one part in 255 of black, over 2 CSS px.
 */
export const PURGE_SENTINEL_ALPHA = 1 / 255;

/**
 * Side of the marker in CSS px. Two, not one, because since the area budget
 * bounds the device ratio ON MOBILE (ZoomScale.ts - desktop keeps its floor)
 * a backing scale below 1 is now reachable there, and a 1 CSS px square would
 * then cover less than one whole device pixel. Mobile is the only place this
 * sentinel ever runs (`purgeProbeArmed`), so that is the case it has to
 * survive.
 */
export const PURGE_SENTINEL_CSS = 2;

/**
 * Paint the marker at the band's top-left corner.
 *
 * The corner is never on screen: `bandFor` (ScrollBand.ts) sets the band's
 * top to `scrollTop - margin` or higher up still, with `margin` at least 120
 * CSS px, so canvas row 0 sits above anything the scroller can show. Even at
 * full opacity nobody would see this; at 1/255 it is not a question.
 *
 * Cleared before it is filled so calling it twice is the same as calling it
 * once. That matters: a partial repaint whose damage covers the corner wipes
 * the marker, so the caller repaints it after every armed paint, and without
 * the clear the alpha would climb one step per paint until it was visible.
 */
export function paintPurgeSentinel(ctx: CanvasRenderingContext2D): void {
	ctx.save();
	ctx.globalCompositeOperation = "source-over";
	ctx.globalAlpha = PURGE_SENTINEL_ALPHA;
	ctx.fillStyle = "#000000";
	ctx.clearRect(0, 0, PURGE_SENTINEL_CSS, PURGE_SENTINEL_CSS);
	ctx.fillRect(0, 0, PURGE_SENTINEL_CSS, PURGE_SENTINEL_CSS);
	ctx.restore();
}

/**
 * Read the marker back: 1 if it is there, 0 if the canvas was reclaimed,
 * -1 if the readback was refused.
 *
 * Reached through `countPaintedPixels` rather than a third `getImageData`
 * call site, so this codebase keeps exactly two (the other is the PDF page
 * shade read in PdfViewerProbe.ts), and so the refusal path
 * (a tainted or failed canvas returns -1 instead of throwing) is the one
 * that is already written and already tested.
 *
 * The backing factor passed is 1 on purpose: it asks for backing pixel
 * (0, 0) whatever the canvas's real device ratio is. Passing the true
 * backing would ask for a `floor(backing)`-sized square, which is zero
 * pixels - and so a false "purged" - on any pane the area budget has
 * trimmed below 1.
 */
export function readPurgeSentinel(ctx: CanvasRenderingContext2D): number {
	return countPaintedPixels(ctx, 0, 0, 1, 1, 1);
}

/** A zero read, and only a zero read, means the pixels are gone. */
export function purgeDetected(painted: number): boolean {
	return painted === 0;
}

/** True when the sentinel is worth painting at all on this device. */
export function purgeProbeArmed(mobile: boolean, recording: boolean): boolean {
	return mobile && recording;
}

export interface PurgeProbeGate {
	/** `purgeProbeArmed`: mobile, with diagnostics recording. */
	armed: boolean;
	/** Every repaint folded into this frame asked for "scroll". */
	scrollRepaint: boolean;
	/** The frame drew something - a full repaint, or at least one rect. */
	foundWork: boolean;
	/**
	 * A stroke owns the coordinate frame (`StrokeFrame.locked`). On this
	 * surface that IS "a stroke is live": `begin()` is pen-down and `end()`
	 * / `cancel()` are every way a gesture finishes.
	 */
	strokeOwnsFrame: boolean;
	/**
	 * This note has ink. Note-level, not band-level, and deliberately: the
	 * marker is painted at the corner whether or not any stroke is near it,
	 * so the only thing a band scan would add is a per-probe pass over every
	 * stroke. What this guard is actually for is not paying a readback on a
	 * note nobody has written on.
	 */
	noteHasInk: boolean;
	now: number;
	/**
	 * When the last readback ran. Start it at -Infinity, not 0, so the first
	 * probe is due immediately however the clock is zeroed.
	 */
	lastProbe: number;
}

/**
 * Should this repaint end in a readback?
 *
 * Every term is a reason not to. `foundWork` because a frame that painted
 * cannot have found a purged canvas - it just wrote to it. `strokeOwnsFrame`
 * because a blocking readback mid-stroke is latency straight into the nib,
 * which is the one thing this plugin will not spend. `noteHasInk` because a
 * blank note has nothing to heal. The interval because three a second is the
 * most this is worth even when it is free, and it is not free.
 */
export function purgeProbeDue(g: PurgeProbeGate): boolean {
	if (!g.armed) return false;
	if (!g.scrollRepaint) return false;
	if (g.foundWork) return false;
	if (g.strokeOwnsFrame) return false;
	if (!g.noteHasInk) return false;
	return g.now - g.lastProbe >= PURGE_PROBE_INTERVAL_MS;
}
