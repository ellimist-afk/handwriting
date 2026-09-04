/**
 * `contentOriginLeft`, at the logic level: candidate selection, the
 * degenerate-rect skip, and the scan limit.
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
import { contentOriginLeft } from "./ContentOrigin";

type Fields = Record<string, unknown>;

interface Rect {
	left: number;
	width: number;
	height: number;
}

function fakeChild(rect: Rect, isLine: boolean): Fields {
	return {
		getBoundingClientRect: () => rect,
		classList: { contains: (c: string) => c === "cm-line" && isLine },
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

	it("skips a degenerate rect (zero height) the same way", () => {
		const content = fakeContent(
			[fakeChild(R(9999, 100, 0), true), fakeChild(R(380), true)],
			0
		);
		expect(contentOriginLeft(content)).toBe(380);
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

	it("falls back to contentDOM's own left when nothing usable is found at all", () => {
		const content = fakeContent(
			[fakeChild(R(1, 0, 0), true), fakeChild(R(2, 0, 0), false)],
			55
		);
		expect(contentOriginLeft(content)).toBe(55);
	});

	it("falls back to contentDOM's own left for an empty document", () => {
		expect(contentOriginLeft(fakeContent([], 42))).toBe(42);
	});

	it("scans no more than 12 children - a candidate past the limit is invisible", () => {
		// 12 unusable (non-line, small) children, then a huge .cm-line 13th.
		// If the scan ever reached it, the result would be 9999 instead of the
		// contentDOM fallback.
		const children: Fields[] = [];
		for (let i = 0; i < 12; i++) children.push(fakeChild(R(1, 0, 0), false));
		children.push(fakeChild(R(9999), true));
		const content = fakeContent(children, 7);
		expect(contentOriginLeft(content)).toBe(7);
	});

	it("does see a candidate within the 12-child scan window", () => {
		// Same shape, one fewer filler child - the real line is now within
		// range and must be found, so the limit above is proven to bind on
		// count rather than accidentally always falling back.
		const children: Fields[] = [];
		for (let i = 0; i < 11; i++) children.push(fakeChild(R(1, 0, 0), false));
		children.push(fakeChild(R(9999), true));
		const content = fakeContent(children, 7);
		expect(contentOriginLeft(content)).toBe(9999);
	});
});
