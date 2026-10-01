/**
 * Red cell for audit 178 (lane C1): the ink band keeps the old scroll height after a note shrinks near its
 * end.
 *
 * Root cause read: the band is an absolutely positioned child of the scroller, so its own box counts toward the
 * scroller's scrollHeight. Near the end of a note bandFor sets the band's bottom to the reported scrollHeight, and
 * syncBand feeds scroller.scrollHeight - which already includes that bottom - straight back into bandFor. After the
 * note shrinks, the scroller still reports the old height, the band asks for the old bottom again, and the blank
 * room below the last line never goes. (The sideways measure has a band-free reading, bandFreeScrollWidth; the
 * vertical one has none.)
 *
 * The real syncBand runs on a bare overlay instance against a scroller model that follows the browser's rule:
 * scrollHeight is the larger of the content's height and the bottom of the absolutely positioned band. Asserted:
 * after the content shrinks and the band syncs, the scroller reports the content's height (within the one pixel
 * bandFor allows for rounding), as stock Obsidian would. It goes green when the vertical measure stops counting
 * the band's own box, or when the band's bottom is released as the sideways margin is.
 * A fix that reads the content height from somewhere this model does not provide (the model has only the
 * scroller's box and the band's styles) would need the model extended.
 *
 * Extended with the fix (lane EI2): the fix reads CodeMirror's view.contentHeight, so the view models it from the
 * content height; setCssStyles now changes only the properties it is given, as the real one does (it zeroed the
 * band's height on a top-only write); the scroller counts its scrollHeight reads for the cost cell.
 * Written red-first behind HANDWRITING_C1_CELLS=1; the fix commit dropped the gate.
 */
import { describe, expect, it } from "vitest";
import { InkOverlayPlugin } from "./InkOverlay";

const CLIENT_H = 600;
const CLIENT_W = 800;

function rig(contentHeight: number, scrollTop: number) {
	const state = { contentHeight, scrollTop, bandTop: 0, bandHeight: 0, hasBand: false, heightReads: 0 };
	// The extent the browser would lay out. The scroller's own getters use it uncounted, so heightReads counts only
	// the reads the code under test makes.
	const extent = (): number => {
		const bandBottom = state.hasBand ? state.bandTop + state.bandHeight : 0;
		return Math.round(Math.max(state.contentHeight, bandBottom));
	};
	const scroller = {
		scrollLeft: 0,
		clientWidth: CLIENT_W,
		clientHeight: CLIENT_H,
		scrollWidth: CLIENT_W,
		get scrollTop(): number {
			// The browser clamps the scroll offset into [0, scrollHeight - clientHeight] whenever the extent shrinks.
			return Math.min(state.scrollTop, Math.max(0, extent() - CLIENT_H));
		},
		get scrollHeight(): number {
			state.heightReads++;
			return extent();
		},
	};
	const container = {
		setCssStyles(styles: Record<string, string>): void {
			state.hasBand = true;
			if (styles.top !== undefined) state.bandTop = parseFloat(styles.top);
			if (styles.height !== undefined) state.bandHeight = parseFloat(styles.height);
		},
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	Object.assign(overlay, {
		container,
		view: {
			scrollDOM: scroller,
			get contentHeight(): number {
				return state.contentHeight;
			},
		},
		cssScale: 1,
		bounceState: null,
		bandEase: null,
		band: null,
		bandSyncDeferred: false,
		bandFreeScrollWidth: null,
		frame: { locked: false },
		router: { refreshRect: () => undefined },
	});
	const sync = (): void => {
		(overlay as unknown as { syncBand(): string }).syncBand();
	};
	return { state, scroller, sync };
}

describe("audit 178: the band gives back the room a shrunk note no longer has", () => {
	it("control: a note that has not shrunk reports its own height with the band in place", () => {
		const r = rig(2000, 1400);
		r.sync();
		expect(r.state.hasBand, "the band was placed").toBe(true);
		expect(r.scroller.scrollHeight, "the band adds nothing while the note is as long as it was").toBeLessThanOrEqual(2001);
	});

	it("after the note shrinks near its end the scroller reports the shorter height", () => {
		const r = rig(2000, 1400);
		r.sync();
		r.state.contentHeight = 1800; // a block near the end was deleted or folded
		for (let i = 0; i < 3; i++) r.sync(); // a few frames: nothing else changes
		expect(
			r.scroller.scrollHeight,
			`blank scroll room below the last line: the scroller reports ${r.scroller.scrollHeight}, the content is 1800`
		).toBeLessThanOrEqual(1801);
	});
	it("cost: a scroll frame at the note's end with no shrink reads the height once, a shrink frame twice", () => {
		const r = rig(2000, 1400);
		r.sync();
		const perFrame: number[] = [];
		for (const top of [1380, 1400, 1390, 1400]) {
			r.state.scrollTop = top;
			const before = r.state.heightReads;
			r.sync();
			perFrame.push(r.state.heightReads - before);
		}
		expect(perFrame, "syncBand's own viewport read and nothing more on an unchanged note").toEqual([1, 1, 1, 1]);
		r.state.contentHeight = 1800;
		const before = r.state.heightReads;
		r.sync();
		expect(r.state.heightReads - before, "one band-free read on the frame the note shrank").toBe(2);
	});

	it("control: a note that shrinks with the band clear of its end measures nothing and keeps its band", () => {
		const r = rig(6000, 0);
		r.sync();
		const band = { top: r.state.bandTop, height: r.state.bandHeight };
		r.state.contentHeight = 5800;
		const before = r.state.heightReads;
		r.sync();
		expect(r.state.heightReads - before, "no band-free read while the band is nowhere near the end").toBe(1);
		expect({ top: r.state.bandTop, height: r.state.bandHeight }).toEqual(band);
	});
});
