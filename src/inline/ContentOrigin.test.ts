/**
 * The content-origin scan, at the logic level: candidate selection, the
 * degenerate-rect skip, the scan limit, and - since 1.4.10 - which ELEMENT
 * the winning left edge was read from.
 *
 * The render suite (`test/render/ContentOriginColumn.test.ts`) is the real
 * engine under the real Minimal cascade and is what proves the function
 * fixes the actual defect. It cannot cheaply reach every branch, though: its
 * fixture's only non-`.cm-line` children (the block marker, the widget
 * buffer) are BOTH zero-size, so the `others`-pool fallback and the
 * degenerate skip's effect on that pool are never exercised there - a
 * mutation run against this worktree's copy of the render test confirmed it
 * (removing the skip killed nothing). This file is narrow on purpose: fake
 * elements, no browser, one behaviour per test.
 */

import { describe, expect, it } from "vitest";
import { contentOrigin, contentOriginLeft } from "./ContentOrigin";

type Fields = Record<string, unknown>;

interface Rect {
	left: number;
	width: number;
	height: number;
}

/**
 * An immediate child of a `.cm-line`, which is what the block-widget probe
 * inspects since 1.4.10. `tagName` and `classList` only - the probe never
 * descends, so a fake that offered a subtree would be modelling a cost the
 * scan no longer pays.
 */
function fakeKid(tag: string, classes: string[] = []): Fields {
	const kid: Fields = {
		tagName: tag,
		classList: {
			length: classes.length,
			contains: (c: string) => classes.includes(c),
		},
	};
	// Indexed access, the way a real `DOMTokenList` answers the prefix scan.
	classes.forEach((c, i) => {
		(kid.classList as Record<string, unknown>)[String(i)] = c;
	});
	return kid;
}

/** The immediate children of a line carrying a rendered block table. */
const TABLE_KIDS = (): Fields[] => [fakeKid("DIV", ["cm-table-widget"])];

function fakeChild(rect: Rect, isLine: boolean, widget = false, kids?: Fields[]): Fields {
	return {
		getBoundingClientRect: () => rect,
		classList: { contains: (c: string) => c === "cm-line" && isLine },
		children: kids ?? (widget ? TABLE_KIDS() : []),
		// The probe the scan USED to run. Present so a regression to a
		// subtree query is a failure rather than a harness crash, and
		// answering `null` unconditionally so it can never satisfy one.
		querySelector: () => {
			throw new Error("the block-widget probe must not walk the subtree");
		},
	};
}

function fakeContent(children: Fields[], ownLeft: number): HTMLElement {
	return {
		children,
		getBoundingClientRect: () => ({ left: ownLeft, width: 0, height: 0 }),
	} as unknown as HTMLElement;
}

const R = (left: number, width = 100, height = 20): Rect => ({ left, width, height });

describe("contentOriginLeft: candidate selection", () => {
	it("prefers .cm-line children over other children, even when others is larger", () => {
		const content = fakeContent(
			[
				fakeChild(R(9999), false), // a non-line child - must be ignored
				fakeChild(R(380), true),
			],
			0
		);
		expect(contentOriginLeft(content)).toBe(380);
	});

	it("returns the MAXIMUM among line candidates, not the first or last scanned", () => {
		const content = fakeContent(
			[fakeChild(R(200), true), fakeChild(R(380), true), fakeChild(R(300), true)],
			0
		);
		expect(contentOriginLeft(content)).toBe(380);
	});

	it("skips a degenerate rect (zero width) even if it reports the largest left", () => {
		// A collapsed line reporting left:9999 must not win just because it is
		// numerically the max - it is not a real column position.
		const content = fakeContent(
			[fakeChild(R(9999, 0, 20), true), fakeChild(R(380), true)],
			0
		);
		expect(contentOriginLeft(content)).toBe(380);
	});

	it("KEEPS a flat rect (zero height, real width) - 1.4.10 dropped that arm", () => {
		// A zero-WIDTH box under `margin-inline: auto` centres on a point, so
		// its left edge is meaningless. A zero-HEIGHT box with a real width is
		// centred by the same rule as any other block and its left edge IS the
		// column's - which is what a hidden HTML embed renders as. Rejecting
		// those cost 380px of origin error on a note built out of them
		// ("twelve hidden html embeds", `MinimalNoteShapes.test.ts`).
		const flat = fakeChild(R(380, 100, 0), true);
		expect(contentOriginLeft(fakeContent([flat], 0))).toBe(380);
		// And in the any-child pool too: the flat blocks that shape is built
		// out of are not `.cm-line`s.
		const flatBlock = fakeChild(R(380, 100, 0), false);
		expect(contentOriginLeft(fakeContent([flatBlock], 0))).toBe(380);
	});

	it("falls back to the `others` pool only when no usable .cm-line exists", () => {
		// Every .cm-line present is degenerate; a real, non-degenerate
		// non-line child (e.g. an embed) is what's left to measure.
		const content = fakeContent(
			[fakeChild(R(9999, 0, 0), true), fakeChild(R(220), false)],
			0
		);
		expect(contentOriginLeft(content)).toBe(220);
	});

	it("reports COLUMN NOT FOUND when nothing usable is found at all", () => {
		// `null`, not `.cm-content`'s own left. Under Minimal that fallback is
		// the PANE edge, so answering it moved a correct camera by 380px at a
		// 1400px pane. The caller keeps the last origin the scan did find.
		const content = fakeContent(
			[fakeChild(R(1, 0, 0), true), fakeChild(R(2, 0, 0), false)],
			55
		);
		expect(contentOriginLeft(content)).toBeNull();
	});

	it("reports COLUMN NOT FOUND for an empty document", () => {
		expect(contentOriginLeft(fakeContent([], 42))).toBeNull();
	});

	it("finds a line past the twelfth child, which the old window could not", () => {
		// THE POOL-STARVATION FIX. Twelve non-line children then a `.cm-line`:
		// the twelve-child window closed before the line and answered the
		// contentDOM fallback (7 here). The class walk that finds the line
		// forces no layout, so it can look at all of them.
		const children: Fields[] = [];
		for (let i = 0; i < 12; i++) children.push(fakeChild(R(1, 0, 0), false));
		children.push(fakeChild(R(9999), true));
		const content = fakeContent(children, 7);
		expect(contentOriginLeft(content)).toBe(9999);
	});

	it("does see a candidate within the 12-child scan window", () => {
		// Same shape, one fewer filler child. Kept from 1.4.9 so the head of
		// the list is proven to be reached at all.
		const children: Fields[] = [];
		for (let i = 0; i < 11; i++) children.push(fakeChild(R(1, 0, 0), false));
		children.push(fakeChild(R(9999), true));
		const content = fakeContent(children, 7);
		expect(contentOriginLeft(content)).toBe(9999);
	});
});

/**
 * The two-phase scan and its budget, added in 1.4.10.
 *
 * Phase A is a free class walk over every child followed by rect reads on the
 * first and last six LINES; phase B is the old any-child pass over the first
 * twelve children, and it runs only when phase A found nothing usable. The
 * ORDER is the fix: a leading run of widened blocks no longer decides where
 * the column is while an ordinary line sits just past the window.
 */
describe("contentOrigin: the two-phase scan", () => {
	it("phase A wins over phase B even when a non-line child reports a larger left", () => {
		// A bare `img` child right of the column returned 960 against a column
		// at 380 ("twelve external images", `MinimalNoteShapes.test.ts`). The
		// any-child pool is only ever consulted when there is no line.
		const line = fakeChild(R(380), true);
		const content = fakeContent([fakeChild(R(960), false), line], 0);
		expect(contentOrigin(content).line).toBe(line);
		expect(contentOriginLeft(content)).toBe(380);
	});

	it("phase B runs only when phase A found no usable line", () => {
		// Every line degenerate: the any-child pass is what is left.
		const block = fakeChild(R(220), false);
		const content = fakeContent([fakeChild(R(9999, 0, 0), true), block], 0);
		expect(contentOrigin(content).line).toBe(block);
	});

	it("drops a line carrying a block widget before reading its rect", () => {
		// Under `cssclasses: wide` a table line lands 71.5px RIGHT of the text
		// column and wins the maximum outright
		// (`MinimalSettingsSweep.test.ts`). A line carrying a table, an embed
		// or a dataview block is not evidence about where the column is.
		const text = fakeChild(R(380), true);
		const tableLine = fakeChild(R(451.5), true, true);
		expect(contentOriginLeft(fakeContent([tableLine, text], 0))).toBe(380);
	});

	it("falls through to phase B when every sampled line carries a widget", () => {
		// The rect budget is shared by both phases, so rejecting a line must
		// cost no rect read - otherwise a note of nothing but tables would
		// leave phase B nothing to spend and report COLUMN NOT FOUND.
		const children: Fields[] = [];
		for (let i = 0; i < 14; i++) children.push(fakeChild(R(300), true, true));
		expect(contentOriginLeft(fakeContent(children, 0))).toBe(300);
	});

	it("spends the rect budget on both ends of the line list, not the head", () => {
		// THE WIDE-LINES FIX, in the small. Thirteen lines: twelve wide ones
		// and then the ordinary line. A head-only sample never reaches the
		// thirteenth, which is exactly the "twelve table lines" shape.
		const children: Fields[] = [];
		for (let i = 0; i < 12; i++) children.push(fakeChild(R(364), true));
		children.push(fakeChild(R(380), true));
		expect(contentOriginLeft(fakeContent(children, 0))).toBe(380);
	});

	it("still reads no more than 12 rects, so the middle of a long note is unread", () => {
		// The cost statement, asserted rather than claimed: a line buried in
		// the middle of a 400-line viewport is never measured, which is what
		// keeps this a constant-cost call on the scroll and pen-down paths.
		const children: Fields[] = [];
		for (let i = 0; i < 400; i++) children.push(fakeChild(R(380), true));
		children[200] = fakeChild(R(9999), true);
		expect(contentOriginLeft(fakeContent(children, 0))).toBe(380);
	});
});

/**
 * The ELEMENT half of the same scan, added in 1.4.10.
 *
 * `contentOriginLeft` answers "where is the column"; the overlay also needs
 * "which element is that", because a `ResizeObserver` on that element is the
 * only trigger that notices Minimal moving the column by any of the three
 * routes it offers (`test/render/MinimalResync.test.ts`). The two answers
 * come out of one scan so they can never be derived from different frames,
 * and so the re-arm inside `syncCamera` costs no extra layout reads.
 */
describe("contentOrigin: the element the left edge was read from", () => {
	it("returns the element that won, not merely one that was scanned", () => {
		const winner = fakeChild(R(380), true);
		const content = fakeContent([fakeChild(R(200), true), winner, fakeChild(R(300), true)], 0);
		const origin = contentOrigin(content);
		expect(origin.left).toBe(380);
		// Identity, not equality: an observer armed on a copy would watch
		// nothing the theme ever resizes.
		expect(origin.line).toBe(winner);
	});

	it("agrees with contentOriginLeft, which is a wrapper over it", () => {
		// One scan rule. If these ever disagreed the camera would paint
		// against one element's edge while watching another's size.
		const content = fakeContent([fakeChild(R(9999), false), fakeChild(R(380), true)], 0);
		expect(contentOrigin(content).left).toBe(contentOriginLeft(content));
	});

	it("never returns a degenerate child, the way the left edge never uses one", () => {
		// A zero-height block marker centres to a point under `margin-inline:
		// auto`. Watching one would be watching an element whose size does not
		// track the column at all.
		const real = fakeChild(R(380), true);
		const content = fakeContent([fakeChild(R(9999, 0, 0), true), real], 0);
		expect(contentOrigin(content).line).toBe(real);
	});

	it("reports no element and no left edge for COLUMN NOT FOUND", () => {
		// The honest answer for an empty document, a detached editor or a
		// jsdom fixture. The two nulls travel together: the element returned
		// is always the element the number was read from.
		const origin = contentOrigin(fakeContent([], 42));
		expect(origin.left).toBeNull();
		expect(origin.line).toBeNull();
	});

	it("returns a line from the `others` pool when no .cm-line is usable", () => {
		// Same fallback order as the left edge: the any-child pass exists so a
		// viewport holding only widgets is still watched by something.
		const other = fakeChild(R(300), false);
		const content = fakeContent([fakeChild(R(200), false), other], 0);
		expect(contentOrigin(content).line).toBe(other);
	});
});

/**
 * WHAT THE SCAN COSTS, asserted rather than claimed.
 *
 * `repaint` calls `syncCamera`, and `update` schedules a repaint on
 * `docChanged` and `viewportChanged`, so this function runs per keystroke and
 * per scroll tick. Until 1.4.10 phase A collected every `.cm-line` index in
 * the viewport into an array and then sliced and spread it - one child visit
 * per child of the note's rendered viewport plus a heap allocation, every
 * time - and probed each sampled line with a `querySelector` whose
 * `[class*="block-language-"]` arm forces a full subtree walk on every line
 * that does not match, which is every ordinary line.
 *
 * The fakes below instrument both: `classList` reports how many children were
 * looked at, and `querySelector` throws.
 */
describe("contentOrigin: what one call costs", () => {
	/** A line that counts every time the scan asks whether it is a line. */
	function countingLine(rect: Rect, seen: { n: number }, kids: Fields[] = []): Fields {
		return {
			getBoundingClientRect: () => rect,
			classList: {
				contains: (c: string) => {
					seen.n++;
					return c === "cm-line";
				},
			},
			children: kids,
			querySelector: () => {
				throw new Error("the block-widget probe must not walk the subtree");
			},
		};
	}

	it("visits the ends of the child list, not all of it", () => {
		// 400 lines. The old pass looked at all 400 to build its index array;
		// this one walks in `SAMPLE_END` deep from each end and stops. The
		// bound is generous on purpose - what is being pinned is that the
		// count does not scale with the note, not an exact instruction count.
		const seen = { n: 0 };
		const children: Fields[] = [];
		for (let i = 0; i < 400; i++) children.push(countingLine(R(380), seen));
		expect(contentOriginLeft(fakeContent(children, 0))).toBe(380);
		expect(seen.n).toBeLessThanOrEqual(2 * 6 + 4);
		// And it really did reach both ends rather than stopping at one.
		expect(seen.n).toBeGreaterThanOrEqual(2 * 6);
	});

	it("probes the widget shapes without descending into the line", () => {
		// The fakes throw from `querySelector`, so a return to the subtree
		// query is a crash rather than a slow pass. The block table is still
		// found - by its immediate child, which is where Live Preview puts it.
		const seen = { n: 0 };
		const table = countingLine(R(451.5), seen, [fakeKid("DIV", ["cm-table-widget"])]);
		const text = countingLine(R(380), seen);
		expect(contentOriginLeft(fakeContent([table, text], 0))).toBe(380);
	});

	it("allocates no index array, so a 400-line viewport allocates nothing", () => {
		// Same shape as the visit-count case, read from the other side: the
		// answer is unchanged, which is what makes the visit count above a
		// cost fix rather than a behaviour change.
		const seen = { n: 0 };
		const children: Fields[] = [];
		for (let i = 0; i < 400; i++) children.push(countingLine(R(380), seen));
		children[0] = countingLine(R(300), seen);
		children[399] = countingLine(R(420), seen);
		expect(contentOriginLeft(fakeContent(children, 0))).toBe(420);
	});
});

/**
 * INLINE EMBEDS ARE NOT BLOCK WIDGETS, which is what makes the probe safe to
 * run at all.
 *
 * `text ![[img.png]] text` renders a `span.internal-embed.image-embed` inside
 * an ordinary `.cm-line`. A subtree probe rejected that line - and its left
 * edge IS the column's. Under `cssclasses: wide` or `max` a viewport whose
 * sampled lines all carry one left phase A with nothing to measure and handed
 * the answer to phase B, which picks the wide table line sitting RIGHT of the
 * text: the +71.5px and +280px defect that the block probe exists to prevent,
 * reintroduced by the probe itself. `test/render/MinimalSettingsSweep.test.ts`
 * measures it under the real cascade.
 */
describe("contentOrigin: inline embeds inside an ordinary line", () => {
	it("keeps a line whose image embed is an inline span", () => {
		const inline = fakeChild(R(380), true, false, [
			fakeKid("SPAN", ["internal-embed", "image-embed", "is-loaded"]),
		]);
		const table = fakeChild(R(451.5), true, true);
		expect(contentOriginLeft(fakeContent([inline, table], 0))).toBe(380);
	});

	it("still rejects a line whose image embed is a block div", () => {
		// `![[img.png]]` alone on its line. Minimal sizes that from
		// `--container-img-width`, so its left edge is not the column's.
		const block = fakeChild(R(9999), true, false, [
			fakeKid("DIV", ["internal-embed", "media-embed", "image-embed"]),
		]);
		const text = fakeChild(R(380), true);
		expect(contentOriginLeft(fakeContent([block, text], 0))).toBe(380);
	});

	it("does not let inline images starve phase A into the wide-block defect", () => {
		// The full shape, in the small: twelve ordinary lines each holding an
		// inline image, plus one table line. Every sampled line rejected meant
		// phase B, and phase B measures the table.
		const children: Fields[] = [];
		for (let i = 0; i < 12; i++) {
			children.push(
				fakeChild(R(380), true, false, [fakeKid("SPAN", ["image-embed"])])
			);
		}
		children.push(fakeChild(R(451.5), true, true));
		expect(contentOriginLeft(fakeContent(children, 0))).toBe(380);
	});

	it("finds a fenced block by its class prefix without a substring selector", () => {
		// Dataview and every other fenced renderer. The prefix scan runs over
		// the classes the element actually has.
		const dv = fakeChild(R(9999), true, false, [
			fakeKid("DIV", ["block-language-dataview"]),
		]);
		const text = fakeChild(R(380), true);
		expect(contentOriginLeft(fakeContent([dv, text], 0))).toBe(380);
	});
});

/**
 * THE RECT BUDGET IS SPENT ON USABLE RECTS, added in 1.4.10.
 *
 * `consider` decremented the budget before testing the width, so a viewport
 * whose leading children are zero-width - the block markers a note of movable
 * text boxes renders - exhausted all twelve on rects that taught the scan
 * nothing, and left phase B unable to measure anything at all. The function
 * then reported COLUMN NOT FOUND for a viewport holding a perfectly
 * measurable line, and the overlay fell back to whatever origin it last had.
 */
describe("contentOrigin: the rect budget", () => {
	/**
	 * Twelve zero-width `.cm-line`s, six at each end of the sample, with a
	 * measurable non-line child sitting BETWEEN them.
	 *
	 * That shape and not "twelve markers then child thirteen", because phase
	 * B only ever scans the first `SCAN_LIMIT` children: a measurable child
	 * past that window was unreachable for reasons that have nothing to do
	 * with the budget, and asserting on it would have pinned the wrong
	 * mechanism. What the budget decided is whether phase B could measure
	 * anything INSIDE its window, and twelve degenerate rects in phase A took
	 * that away.
	 */
	function starved(): Fields[] {
		const children: Fields[] = [];
		for (let i = 0; i < 6; i++) children.push(fakeChild(R(1, 0, 20), true));
		children.push(fakeChild(R(380), false));
		for (let i = 0; i < 7; i++) children.push(fakeChild(R(2, 0, 20), true));
		return children;
	}

	it("is not exhausted by zero-width sampled lines", () => {
		// Phase A samples twelve lines and every one of them is a block
		// marker with no width - the shape a note of movable text boxes
		// renders. Charging the budget for those left phase B nothing to
		// spend and reported COLUMN NOT FOUND for a viewport holding a
		// perfectly measurable child.
		expect(contentOriginLeft(fakeContent(starved(), 55))).toBe(380);
	});

	it("still reports COLUMN NOT FOUND when nothing has a width", () => {
		// The budget is not what makes that answer, and must not start
		// hiding it: a viewport of degenerate rects is genuinely
		// unmeasurable, and the caller keeps the origin it already trusted.
		const children: Fields[] = [];
		for (let i = 0; i < 14; i++) children.push(fakeChild(R(1, 0, 20), true));
		expect(contentOriginLeft(fakeContent(children, 55))).toBeNull();
	});
});
