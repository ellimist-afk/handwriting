/**
 * A lift that widens the scroll range leaves the band alone while the band still covers the pane.
 *
 * What it looks like: dropping a dragged lasso selection on a heavy note stalls for a whole repaint, 26 to 31 ms on
 * MCB EXAM 4, with nothing on screen changing.
 *
 * Cause: the lift grows the ink frontier, the extent's spacer moves right, and the scroller's scrollWidth passes its
 * clientWidth. bandFor then spends the sideways margin, so the band it wants is the current one plus a margin on each
 * side, and every size change reaches handleResize: four backings reallocated and the whole layer painted. The
 * current band still covers every pixel the pane shows.
 *
 * The real syncBand runs on a bare overlay against a scroller model, with the mark a lasso lift sets (commitLiveDrag) or
 * without it, as a note arriving. Asserted: after a lift that growth alone returns "none" and
 * writes no band while the band covers the pane; it is taken, with the move it comes with, at the first sync where the
 * pane leaves the band; without a lift, and for every other size change (a narrower range, a narrower or shorter pane),
 * it resizes as before.
 */
import { describe, expect, it } from "vitest";
import { InkOverlayPlugin } from "./InkOverlay";
import { bandCovers, bandMargin, type Band } from "./ScrollBand";

const CLIENT_W = 1383;
const CLIENT_H = 800;
const CONTENT_H = 6000;

function rig(scrollWidth = CLIENT_W) {
	const writes: Record<string, string>[] = [];
	const scroller = { scrollLeft: 0, scrollTop: 2000, clientWidth: CLIENT_W, clientHeight: CLIENT_H, scrollWidth, scrollHeight: CONTENT_H };
	const overlay = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	Object.assign(overlay, {
		container: { setCssStyles: (styles: Record<string, string>) => void writes.push(styles) },
		view: { scrollDOM: scroller, contentHeight: CONTENT_H },
		cssScale: 1,
		bounceState: null,
		bandEase: null,
		band: null,
		bandSyncDeferred: false,
		bandFreeScrollWidth: null,
		frame: { locked: false },
		router: { refreshRect: () => undefined },
	});
	const sync = (): string => (overlay as unknown as { syncBand(): string }).syncBand();
	// What commitLiveDrag sets at a lasso lift.
	const lift = (): void => void (overlay.bandGrowthMayWait = true);
	const band = (): Band => overlay.band as Band;
	const view = () => ({ ...scroller, scale: 1 });
	return { scroller, sync, band, view, writes, lift, overlay };
}

const margin = bandMargin(CLIENT_H, 1);

describe("a band growth the pane does not need waits for the scroll that needs it", () => {
	it("the range widens past the pane under a band that covers it: no resize, no band write", () => {
		const r = rig();
		expect(r.sync(), "premise: the first sync places the band").toBe("resized");
		const placed = { ...r.band() };
		expect(placed.width, "premise: no sideways margin while the range fits the pane").toBe(CLIENT_W);
		r.lift();
		r.scroller.scrollWidth = CLIENT_W + 400; // the lift moved ink right: the spacer grew the range
		const writes = r.writes.length;
		const out = r.sync();
		expect({ out, band: r.band(), writes: r.writes.length - writes }, "the band covers the pane: the growth waits").toEqual({ out: "none", band: placed, writes: 0 });
		expect(bandCovers(r.band(), r.view()), "the band still covers every pixel the pane shows").toBe(true);
	});

	it("the first scroll sideways takes the growth: resized, and the new band covers the pane", () => {
		const r = rig();
		r.sync();
		r.lift();
		r.scroller.scrollWidth = CLIENT_W + 400;
		expect(r.sync(), "deferred").toBe("none");
		r.scroller.scrollLeft = 1; // one css px right: the band has no margin on that side
		expect(r.sync(), "the pane left the band").toBe("resized");
		expect([r.band().width, bandCovers(r.band(), r.view())], "the grown band, covering the pane").toEqual([CLIENT_W + 2 * margin, true]);
	});

	it("a scroll down inside the band's margin still waits; one css px past its bottom takes the growth with the move", () => {
		const r = rig();
		r.sync();
		r.lift();
		r.scroller.scrollWidth = CLIENT_W + 400;
		expect(r.sync(), "deferred").toBe("none");
		const b = r.band();
		r.scroller.scrollTop = b.top + b.height - CLIENT_H - margin / 2 + 1; // inside the half-margin slack, still covered
		expect(bandCovers(b, r.view()), "premise: the pane is still inside the band").toBe(true);
		expect(r.sync(), "covered: nothing new shows, the growth still waits").toBe("none");
		r.scroller.scrollTop = b.top + b.height - CLIENT_H + 1; // the pane's bottom one css px past the band's
		expect(r.sync(), "the pane left the band").toBe("resized");
		expect([r.band().width, bandCovers(r.band(), r.view())]).toEqual([CLIENT_W + 2 * margin, true]);
	});

	it("the note grew down as well: a band whose bottom sat on the old end, the pane's bottom on its edge, waits", () => {
		const r = rig();
		r.scroller.scrollHeight = CLIENT_H; // a note one pane long: the band's bottom is clamped to its end
		r.scroller.scrollTop = 0;
		r.sync();
		const placed = { ...r.band() };
		expect(placed.top + placed.height, "premise: the band's bottom on the note's end").toBe(CLIENT_H);
		r.lift();
		r.scroller.scrollHeight = CLIENT_H + 600; // the lift grew the range down and sideways
		r.scroller.scrollWidth = CLIENT_W + 400;
		expect({ out: r.sync(), band: r.band() }, "covered: the growth and the move both wait").toEqual({ out: "none", band: placed });
		r.scroller.scrollTop = 1;
		expect(r.sync(), "one css px down: the pane left the band").toBe("resized");
		expect(bandCovers(r.band(), r.view())).toBe(true);
	});

	it("no lift: a range that widens past the pane (a note arriving) takes the margin at once, as before", () => {
		const r = rig();
		r.sync();
		r.scroller.scrollWidth = CLIENT_W + 400;
		expect(r.sync()).toBe("resized");
		expect(r.band().width).toBe(CLIENT_W + 2 * margin);
	});

	it("the wait ends with the sync that takes the growth: a later widening resizes at once", () => {
		const r = rig();
		r.sync();
		r.lift();
		r.scroller.scrollWidth = CLIENT_W + 400;
		expect(r.sync(), "deferred").toBe("none");
		r.scroller.scrollLeft = 1;
		expect(r.sync(), "taken").toBe("resized");
		expect(r.overlay.bandGrowthMayWait, "the mark is spent").toBe(false);
	});

	it("control: the range narrows back to the pane, the margin goes at once", () => {
		const r = rig(CLIENT_W + 400);
		r.sync();
		expect(r.band().width, "premise: the sideways margin is spent").toBe(CLIENT_W + 2 * margin);
		r.scroller.scrollWidth = CLIENT_W;
		expect(r.sync()).toBe("resized");
		expect(r.band().width).toBe(CLIENT_W);
	});

	it("control: a narrower pane resizes the band at once", () => {
		const r = rig();
		r.sync();
		r.scroller.clientWidth = CLIENT_W - 100;
		r.scroller.scrollWidth = CLIENT_W + 400;
		expect(r.sync()).toBe("resized");
		expect(r.band().width).toBe(CLIENT_W - 100 + 2 * bandMargin(CLIENT_H, 1));
	});

	it("control: a shorter pane under a band that covers it, slack to spare, resizes at once", () => {
		const r = rig();
		r.sync();
		r.scroller.clientHeight = CLIENT_H - 40;
		expect(bandCovers(r.band(), r.view()), "premise: the band still covers the shorter pane").toBe(true);
		expect(r.sync()).toBe("resized");
		const m = bandMargin(CLIENT_H - 40, 1);
		expect(r.band().height).toBe(CLIENT_H - 40 + 2 * m);
	});

	it("control: the range widens and the pane gets shorter in one sync, resized at once", () => {
		const r = rig();
		r.sync();
		r.scroller.clientHeight = CLIENT_H - 40;
		r.scroller.scrollWidth = CLIENT_W + 400;
		expect(r.sync()).toBe("resized");
	});
});
