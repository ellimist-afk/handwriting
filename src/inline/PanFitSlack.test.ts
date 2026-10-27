/**
 * PAN_FIT_SLACK_PX is the one pixel a page may overhang the pane and still count as fitting it. A page that fits is
 * held to the pane's left edge with room to spare on the right, and a page just past the slack is a page that hangs
 * off the pane and pans like one. Nothing else pinned the number: moving it from 1 to 2 or to 0 changed no other cell.
 *
 * Two of the nine reads of it are pure arithmetic on the overlay prototype and are held here, each at the
 * slack and a half pixel past it: the pan axis window (fits, and the room the page has to move in) and the fit
 * question the column asks. The other reads combine the slack with measured layout and need a laid-out page.
 */
import { describe, expect, it } from "vitest";

import { InkOverlayPlugin, PAN_MIN_VISIBLE_PX } from "./InkOverlay";

const SPAN = 1000;

describe("the pan fit slack", () => {
	it("a page within the slack of the pane fits it, and one half a pixel past the slack does not", () => {
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;

		const within = overlay.panAxisWindow(SPAN + 1, SPAN);
		expect(within, "a page one pixel wider than the pane fits and has no room to move").toEqual({ fits: true, min: 0, max: 0 });
		const past = overlay.panAxisWindow(SPAN + 1.5, SPAN);
		expect(past.fits, "a page one and a half pixels wider than the pane hangs off it").toBe(false);
		expect(past.min, "and may be carried left until PAN_MIN_VISIBLE_PX of it remains").toBe(PAN_MIN_VISIBLE_PX - (SPAN + 1.5));
		expect(overlay.panAxisWindow(SPAN - 40, SPAN), "a page narrower than the pane has the difference to move in").toEqual({ fits: true, min: 0, max: 40 });

		const asked = (page: number) => {
			const o = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
			(o as unknown as { viewportLayout: unknown }).viewportLayout = { columnInset: true, width: SPAN, externalScale: 1, gutterScreen: 0 };
			(o as unknown as { pageContentWidth: () => number }).pageContentWidth = () => page;
			return o.columnFitsPane(1, 1);
		};
		expect([asked(SPAN + 1), asked(SPAN + 1.5)], "the column's fit question draws the same line").toEqual([true, false]);
	});
});
