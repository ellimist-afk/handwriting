/**
 * The padding rule, as arithmetic.
 *
 * WHAT THE DEFECT IS AND WHERE IT IS MEASURED. `view.documentTop` is
 * `contentDOM.getBoundingClientRect().top + viewState.paddingTop`, and the
 * second term is 0 from construction until CodeMirror's first measure cycle
 * writes the computed value into it. The CSS padding is in force on the text
 * the whole time, so in that window the reported top is short by the padding
 * while the `.cm-line` has not moved, and a stroke stored against it is
 * stored that far off its line - permanently. That is measured on a real
 * `EditorView` in `test/render/UnsettledTopMechanisms.test.ts`, and the
 * outcome of correcting it is measured there too. Nothing here re-measures
 * it; this file pins the two rules the correction rests on.
 *
 * ONE: THE FORMULA IS CODEMIRROR'S, VERBATIM. `parseInt` and `* scaleY`,
 * exactly as `ViewState.measure` spells them
 * (@codemirror/view/dist/index.js:6065). Not because rounding a fractional
 * padding is right, but because it is what CodeMirror will latch: match it
 * and the settled anchor is bit-for-bit `view.documentTop`, so nothing moves
 * once the belief is true and no drift compare fires on arithmetic noise.
 * `parseFloat` would disagree with the belief by half a pixel forever at any
 * fractional padding.
 *
 * TWO: ONE READ ON EITHER BRANCH. `syncCamera` runs at pen-down and once a
 * scrolled frame, so the cost of the anchor is a standing latency question
 * and not a detail: this must read the content rect when it corrects, read
 * `documentTop` (which reads the same rect) when it cannot, and never both.
 */

import { describe, expect, it } from "vitest";

import { anchorTop, declaredPaddingTop } from "./DocumentTop";

/** A `TopAnchorView` that counts which of its two sources was touched. */
function view(o: { contentTop: number; documentTop: number; scaleY?: number }) {
	const reads = { rect: 0, documentTop: 0 };
	return {
		reads,
		view: {
			contentDOM: {
				getBoundingClientRect: () => {
					reads.rect++;
					return { top: o.contentTop };
				},
			},
			get documentTop(): number {
				reads.documentTop++;
				return o.documentTop;
			},
			scaleY: o.scaleY ?? 1,
		},
	};
}

describe("declaredPaddingTop", () => {
	it("evaluates CodeMirror's own expression against the computed style", () => {
		expect(declaredPaddingTop("8px", 1)).toBe(8);
		expect(declaredPaddingTop("0px", 1)).toBe(0);
		// `parseInt`, so a fractional resolved value truncates - which is what
		// CodeMirror will believe, and matching it is the point.
		expect(declaredPaddingTop("8.5px", 1)).toBe(8);
		// Scaled, because CodeMirror scales it: the padding is a layout-px
		// declaration and `documentTop` is in visual px.
		expect(declaredPaddingTop("8px", 2)).toBe(16);
	});

	it("says nothing rather than zero when it cannot read the padding", () => {
		// No style object held - the overlay before its first `handleResize`.
		expect(declaredPaddingTop(undefined, 1)).toBeNull();
		// A detached element, or any host that answers with nothing.
		expect(declaredPaddingTop("", 1)).toBeNull();
		expect(declaredPaddingTop("auto", 1)).toBeNull();
		// CodeMirror's `|| 0` maps these to zero, but it only ever evaluates
		// them inside a measure cycle on a mounted element. Here an unreadable
		// style means "keep the anchor you had": assuming no padding would
		// move ink on a page nothing is wrong with.
	});

	it("falls back to an unscaled reading rather than a nonsensical one", () => {
		expect(declaredPaddingTop("8px", 0)).toBe(8);
		expect(declaredPaddingTop("8px", Number.NaN)).toBe(8);
	});
});

describe("anchorTop", () => {
	it("adds the declared padding to the live content rect, and reads that rect once", () => {
		const { view: v, reads } = view({ contentTop: 40, documentTop: 40 });
		expect(anchorTop(v, "8px")).toBe(48);
		expect(reads.rect).toBe(1);
		// `documentTop` is CodeMirror's sum with the stale belief inside it;
		// on this branch it is not consulted at all, so the correction costs
		// no second rect read.
		expect(reads.documentTop).toBe(0);
	});

	it("is exactly CodeMirror's own answer once the belief is true", () => {
		// The settled state: `documentTop` already includes the 8.
		const { view: v } = view({ contentTop: 40, documentTop: 48 });
		expect(anchorTop(v, "8px")).toBe(v.documentTop);
	});

	it("keeps CodeMirror's answer when the padding cannot be read, and reads no rect", () => {
		const { view: v, reads } = view({ contentTop: 40, documentTop: 48 });
		expect(anchorTop(v, undefined)).toBe(48);
		expect(reads.documentTop).toBe(1);
		expect(reads.rect).toBe(0);
	});

	it("passes the rect term through untouched, which is the case that must not move", () => {
		// Something above `.cm-content` grew by an inch: the content rect and
		// every line in it moved together, and CodeMirror's belief is
		// untouched. The anchor has to follow by the whole inch, exactly as it
		// did before - ink stored earlier is still on its line.
		const before = anchorTop(view({ contentTop: 40, documentTop: 48 }).view, "8px");
		const after = anchorTop(view({ contentTop: 136, documentTop: 144 }).view, "8px");
		expect(after - before).toBe(96);
	});
});

it("uses live uniform zoom before CM measures, retaining the settled Y/X ratio", () => {
 const v = { contentDOM: { getBoundingClientRect: () => ({ top: 20 }) }, documentTop: 28, scaleX: 1, scaleY: 1 };
 expect(anchorTop(v, "8px", 1.75)).toBe(34);
 const settled = { ...v, scaleX: 1.75, scaleY: 1.7518 };
 expect(anchorTop(settled, "8px", 1.75)).toBe(anchorTop(settled, "8px"));
 expect(anchorTop(settled, "8px", 1)).toBeCloseTo(20 + 8 * settled.scaleY / settled.scaleX);
 expect(anchorTop(v, undefined, 1.75)).toBe(28);
});
