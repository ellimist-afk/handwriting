import { describe, expect, it } from "vitest";
import {
	BAND_MARGIN_MAX,
	BAND_MARGIN_MIN,
	Band,
	BandViewport,
	bandCovers,
	bandFor,
	bandMargin,
	bandNeedsMove,
} from "./ScrollBand";

function viewport(over: Partial<BandViewport> = {}): BandViewport {
	return {
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: 800,
		clientHeight: 900,
		scrollWidth: 800,
		scrollHeight: 20000,
		...over,
	};
}

describe("bandMargin", () => {
	it("scales with the viewport, between a floor and a ceiling", () => {
		expect(bandMargin(900)).toBe(225);
		expect(bandMargin(200)).toBe(BAND_MARGIN_MIN);
		expect(bandMargin(4000)).toBe(BAND_MARGIN_MAX);
	});
});

describe("bandFor", () => {
	it("puts a margin above and below the viewport", () => {
		const b = bandFor(viewport({ scrollTop: 5000 }));
		expect(b.top).toBe(5000 - 225);
		expect(b.height).toBe(900 + 450);
	});

	it("never extends past the end of the content", () => {
		// An absolutely positioned child extends scrollable overflow. A band
		// hanging below the document would add scroll range, which would move
		// the band, which would add more range - a scroll that never ends.
		const v = viewport({ scrollTop: 19100, scrollHeight: 20000 });
		const b = bandFor(v);
		expect(b.top + b.height).toBeLessThanOrEqual(v.scrollHeight);
		expect(bandCovers(b, v)).toBe(true);
	});

	it("covers the last row when the scroller sits past its rounded end", () => {
		// scrollHeight is an integer; scrollTop is not. Clamping to the plain
		// reported number leaves a hairline of ink undrawn at the end of a note.
		const v = viewport({ scrollTop: 19100.6, scrollHeight: 20000, clientHeight: 900 });
		expect(bandCovers(bandFor(v), v)).toBe(true);
	});

	it("covers the last column when scrolled fully right", () => {
		const v = viewport({ scrollWidth: 3000, scrollLeft: 2200.4, clientWidth: 800 });
		expect(bandCovers(bandFor(v), v)).toBe(true);
	});

	it("never hangs below the content, however stale the viewport looks", () => {
		// A pinch changes the client size before the scroll offset is
		// reconciled with it, so this pair can read far past the end of the
		// document. A band built on it would hang below the content and ADD
		// scroll range - phantom room the next flick falls into.
		const v = viewport({ scrollTop: 19500, clientHeight: 2400, scrollHeight: 20000 });
		const b = bandFor(v);
		expect(b.top + b.height).toBeLessThanOrEqual(v.scrollHeight + 1);
	});

	it("does the same sideways", () => {
		const v = viewport({ scrollLeft: 2900, clientWidth: 2000, scrollWidth: 3000 });
		const b = bandFor(v);
		expect(b.left + b.width).toBeLessThanOrEqual(v.scrollWidth + 1);
	});

	it("hangs above the origin rather than shrinking, on a short note", () => {
		// Block-start overflow is not scrollable, so a negative top costs
		// nothing - and keeping the HEIGHT constant is what stops five backing
		// stores from being reallocated on every keystroke.
		const v = viewport({ clientHeight: 900, scrollHeight: 900 });
		const b = bandFor(v);
		expect(b.height).toBe(900 + 450);
		expect(b.top).toBe(900 - 1350);
		expect(bandCovers(b, v)).toBe(true);
	});

	it("keeps its height when the document grows or shrinks", () => {
		const tall = bandFor(viewport({ scrollTop: 300, scrollHeight: 90000 }));
		const short = bandFor(viewport({ scrollTop: 300, scrollHeight: 4000 }));
		expect(tall.height).toBe(short.height);
	});

	it("spends horizontal margin only when there is sideways scroll", () => {
		expect(bandFor(viewport()).width).toBe(800);
		const wide = bandFor(viewport({ scrollWidth: 3000, scrollLeft: 500 }));
		expect(wide.width).toBe(800 + 450);
		expect(wide.left).toBe(500 - 225);
	});

	it("reports an empty band for a zero-size editor", () => {
		// A background tab keeps its editor at zero size; this is what lets
		// the canvases be released instead of held on an invisible surface.
		expect(bandFor(viewport({ clientWidth: 0, clientHeight: 0 }))).toEqual({
			left: 0,
			top: 0,
			width: 0,
			height: 0,
		});
	});
});

describe("bandNeedsMove", () => {
	it("leaves the band alone for small scrolls", () => {
		const v = viewport({ scrollTop: 5000 });
		const band = bandFor(v);
		expect(bandNeedsMove(band, { ...v, scrollTop: 5060 })).toBe(false);
	});

	it("moves once the viewport eats into the slack", () => {
		const v = viewport({ scrollTop: 5000 });
		const band = bandFor(v);
		expect(bandNeedsMove(band, { ...v, scrollTop: 5200 })).toBe(true);
	});

	it("stops asking at the end of the document", () => {
		// The clamp makes the wanted position equal the current one, so no
		// amount of consumed slack asks for a move that changes nothing.
		// Without this the last screen of every note repaints forever.
		const v = viewport({ scrollTop: 19100, scrollHeight: 20000 });
		expect(bandNeedsMove(bandFor(v), v)).toBe(false);
	});

	it("stops asking at the top of the document", () => {
		const v = viewport({ scrollTop: 0 });
		expect(bandNeedsMove(bandFor(v), v)).toBe(false);
	});

	it("ignores the sub-pixel wobble at the end of a document", () => {
		// scrollTop is fractional and scrollHeight is a rounded integer, so
		// the wanted position jitters in its last decimals down here. Acting
		// on that repositions the band - and re-rasterizes every visible
		// stroke - on every single scroll event at the bottom of every note.
		const v = viewport({ scrollTop: 19100, scrollHeight: 20000 });
		const band = bandFor(v);
		for (const drift of [0.1, 0.4, 0.6, 0.9, -0.3, -0.8]) {
			expect(bandNeedsMove(band, { ...v, scrollTop: 19100 + drift })).toBe(false);
		}
	});

	it("always takes a size change", () => {
		const v = viewport();
		const band = bandFor(v);
		expect(bandNeedsMove(band, { ...v, clientHeight: 600 })).toBe(true);
		expect(bandNeedsMove(band, { ...v, clientWidth: 0, clientHeight: 0 })).toBe(true);
	});

	it("has nothing to say once the editor is already empty", () => {
		const dead = viewport({ clientWidth: 0, clientHeight: 0 });
		expect(bandNeedsMove(bandFor(dead), dead)).toBe(false);
	});
});

describe("the invariant: a checked scroll position is always covered", () => {
	// This is the property the whole design rests on. Coverage may lapse
	// BETWEEN scroll events - that is what the margin is for, and it shows as
	// ink not yet drawn at an edge rather than ink in the wrong place - but at
	// every position the overlay actually looks at, the band must contain the
	// viewport. A slack too large for the margin would break this, and nothing
	// else in the codebase would notice until ink went missing on hardware.
	function sweep(steps: number[], v0: BandViewport): void {
		let band: Band | null = null;
		let scrollTop = 0;
		for (const step of steps) {
			scrollTop = Math.max(0, Math.min(v0.scrollHeight - v0.clientHeight, scrollTop + step));
			const v = { ...v0, scrollTop };
			if (bandNeedsMove(band, v)) band = bandFor(v);
			expect(band).not.toBeNull();
			if (band && !bandCovers(band, v)) {
				throw new Error(`uncovered at scrollTop=${scrollTop}: band=${JSON.stringify(band)}`);
			}
		}
	}

	it("holds through a slow read-speed scroll", () => {
		sweep(Array.from({ length: 400 }, () => 8), viewport());
	});

	it("holds through a hard fling (113px per frame, hardware-measured)", () => {
		sweep(Array.from({ length: 300 }, () => 113), viewport());
	});

	it("holds through direction reversals", () => {
		const steps: number[] = [];
		for (let i = 0; i < 200; i++) steps.push(i % 2 === 0 ? 240 : -180);
		sweep(steps, viewport());
	});

	it("holds when a single jump crosses the whole band", () => {
		sweep([9000, -9000, 4321, -1, 15000], viewport());
	});

	it("holds against the ends of a short document", () => {
		sweep([200, 200, 200, -600, 50], viewport({ scrollHeight: 1200 }));
	});

	it("holds while scrolling sideways too", () => {
		const v0 = viewport({ scrollWidth: 4000 });
		let band: Band | null = null;
		for (let scrollLeft = 0; scrollLeft <= 3200; scrollLeft += 97) {
			const v = { ...v0, scrollLeft: Math.min(scrollLeft, v0.scrollWidth - v0.clientWidth) };
			if (bandNeedsMove(band, v)) band = bandFor(v);
			if (band && !bandCovers(band, v)) {
				throw new Error(`uncovered at scrollLeft=${v.scrollLeft}`);
			}
		}
	});
});
