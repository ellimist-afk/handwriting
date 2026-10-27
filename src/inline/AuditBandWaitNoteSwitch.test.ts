/**
 * A lasso lift's "the band may wait" mark and a note switch in the same pane.
 *
 * The lift marks that the range it grew needs no new band until a scroll does. The only clear is the sync that takes the
 * growth. Obsidian reuses the editor across notes, so the overlay is not unmounted, and the switch's reset
 * (resetGestureState) leaves the mark. The next note, wide from its first frame, then has its sideways margin wait for a
 * scroll, where a note arriving takes it at once.
 *
 * The real syncBand on a bare overlay, as BandGrowthDeferred.test.ts drives it; the real resetGestureState on the same
 * overlay with every other member a no-op.
 */
import { describe, expect, it } from "vitest";
import { InkOverlayPlugin } from "./InkOverlay";
import { bandMargin, type Band } from "./ScrollBand";

const CLIENT_W = 1383;
const CLIENT_H = 800;
const CONTENT_H = 6000;

/** A member that is anything: callable, and every member of it the same. */
function anything(): unknown {
	const f: unknown = new Proxy(function () {}, {
		get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : f),
		apply: () => f,
	});
	return f;
}

function rig() {
	const scroller = { scrollLeft: 0, scrollTop: 0, clientWidth: CLIENT_W, clientHeight: CLIENT_H, scrollWidth: CLIENT_W, scrollHeight: CONTENT_H };
	const overlay = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	Object.assign(overlay, {
		container: { setCssStyles: () => undefined },
		view: { scrollDOM: scroller, contentHeight: CONTENT_H },
		cssScale: 1,
		bounceState: null,
		bandEase: null,
		band: null,
		bandSyncDeferred: false,
		bandFreeScrollWidth: null,
		bandGrowthMayWait: false,
		frame: { locked: false, cancel: () => undefined },
		router: { refreshRect: () => undefined },
	});
	const sync = (): string => (overlay as unknown as { syncBand(): string }).syncBand();
	// The reset a note switch runs, on the same overlay; members the rig does not hold are no-ops.
	const reset = (): void => {
		const handler: ProxyHandler<Record<string | symbol, unknown>> = {
			get: (t, k, receiver) => {
				if (!(k in t)) return anything();
				const v: unknown = Reflect.get(t, k, receiver);
				return v !== null && typeof v === "object" ? new Proxy(v as Record<string | symbol, unknown>, handler) : v;
			},
		};
		const loose = new Proxy(overlay as Record<string | symbol, unknown>, handler);
		(InkOverlayPlugin.prototype as unknown as { resetGestureState(this: unknown): void }).resetGestureState.call(loose);
	};
	return { scroller, sync, reset, overlay, band: () => overlay.band as Band };
}

describe("a lasso lift near the note's top, then another note opened in the same pane", () => {
	it("control: a wide note arriving with no lift before takes its sideways margin at once", () => {
		const r = rig();
		r.sync();
		r.reset();
		r.scroller.scrollWidth = CLIENT_W + 400;
		expect(r.sync()).toBe("resized");
		expect(r.band().width).toBe(CLIENT_W + 2 * bandMargin(CLIENT_H, 1));
	});

	it("the next note, wide, takes its sideways margin at once: the lift's mark ends with the switch", () => {
		const r = rig();
		expect(r.sync(), "premise: the first sync places the band").toBe("resized");
		// The lift grows the range right; the band covers the pane, so the growth waits and the mark stays.
		r.overlay.bandGrowthMayWait = true;
		r.scroller.scrollWidth = CLIENT_W + 400;
		expect(r.sync(), "premise: the growth waits").toBe("none");
		// The switch: the reset, scroll back to the top left, and the new note is as wide.
		r.reset();
		r.scroller.scrollLeft = 0;
		r.scroller.scrollTop = 0;
		r.scroller.scrollWidth = CLIENT_W + 600;
		expect.soft(r.overlay.bandGrowthMayWait, "the mark after the switch's reset").toBe(false);
		expect(r.sync(), "the new note's first sync").toBe("resized");
	});
});
