/**
 * The algebra of E's Y origin, on its own, where a wrong sign or a lost term
 * is a one-line failure instead of a pixel of drift in a browser.
 *
 * The identity these tests are about: `cameraY_layout = k x spacing +
 * (overlay.top - rect(rung_k).top + panY) / cssScale` must give the SAME
 * camera for every k, because k is a choice and not a measurement. That is the
 * whole reason the ladder can be picked arithmetically, with no DOM write on
 * the scroll path, and it is worth an assertion rather than a sentence.
 */

import { describe, it, expect } from "vitest";
import {
	MAX_RUNGS, RUNG_SPACING, cameraOriginYLayout, impliedDocumentTop, ladderShape, rungIndexFor,
} from "./DocumentAnchor";

/** The shipped expression, for comparison: the whole document top divided by
 * the scale. E must agree with it exactly in exact arithmetic. */
const shipped = (overlayTop: number, documentTop: number, panY: number, cssScale: number) =>
	(overlayTop - documentTop + panY) / cssScale;

/** The declared top padding, in screen px. The wrapper sits at the content's
 * border-box top, so every fixture here models the document top as
 * `wrapperTop + PAD` - which is exactly what `anchorTop` computes. */
const PAD = 4 * 0.15;

describe("cameraOriginYLayout", () => {
	it("agrees with the document-top form it replaces", () => {
		const cssScale = 0.15, panY = 37, documentTop = -17218.2;
		const rungTop = 56 * RUNG_SPACING;
		// Where the browser puts that rung: the wrapper is PAD above the document
		// top, and the rung is `rungTop` layout px below the wrapper.
		const rungRectTop = documentTop - PAD + rungTop * cssScale;
		expect(cameraOriginYLayout(rungTop, 940, rungRectTop, panY, cssScale, PAD)!)
			.toBeCloseTo(shipped(940, documentTop, panY, cssScale), 6);
	});

	it("gives the same camera from every rung, which is why picking one reseeds nothing", () => {
		const cssScale = 0.1, panY = -12, overlayTop = 880, documentTop = -22960.8;
		const pad = 4 * cssScale;
		const at = (k: number) => {
			const rungTop = k * RUNG_SPACING;
			return cameraOriginYLayout(rungTop, overlayTop, documentTop - pad + rungTop * cssScale, panY, cssScale, pad)!;
		};
		const base = at(0);
		// Deliberately including rungs nowhere near the viewport: a wrong k must
		// cost distance and nothing else.
		for (const k of [1, 56, 112, 225, 1023]) expect(at(k)).toBeCloseTo(base, 6);
	});

	it("carries only the residual through the believed scale", () => {
		// A scale wrong by 1% costs 1% OF THE RESIDUAL, not 1% of the extent.
		// This is E's entire precision argument, as a number.
		const truth = 0.15, believed = 0.15 * 1.01, panY = 0, overlayTop = 900;
		const documentTop = -17218.2;
		const rungTop = 56 * RUNG_SPACING;
		const rungRectTop = documentTop - PAD + rungTop * truth;
		const wrongE = cameraOriginYLayout(rungTop, overlayTop, rungRectTop, panY, believed, PAD)!;
		const rightE = cameraOriginYLayout(rungTop, overlayTop, rungRectTop, panY, truth, PAD)!;
		const wrongShipped = shipped(overlayTop, documentTop, panY, believed);
		const rightShipped = shipped(overlayTop, documentTop, panY, truth);
		// Both forms have an error. E's is the SHIPPED one scaled down by exactly
		// the ratio of what each divides: E divides the residual
		// `overlay.top - rect(rung).top + panY`, the shipped form divides the
		// whole `overlay.top - documentTop + panY`. Asserting the ratio, and not
		// a bare inequality, is what pins the claim: a bound like "20x smaller"
		// would be a property of the numbers this test happened to pick.
		const residual = overlayTop - rungRectTop + panY - PAD;
		const whole = overlayTop - documentTop + panY;
		expect(Math.abs(wrongE - rightE) / Math.abs(wrongShipped - rightShipped))
			.toBeCloseTo(Math.abs(residual) / Math.abs(whole), 6);
		// And at this extent that ratio is a 20-fold reduction, which is the
		// point of the mechanism.
		expect(Math.abs(wrongE - rightE)).toBeLessThan(Math.abs(wrongShipped - rightShipped) / 10);
	});

	it("refuses rather than guesses on unusable input", () => {
		expect(cameraOriginYLayout(0, NaN, 0, 0, 0.15, 0)).toBeNull();
		expect(cameraOriginYLayout(0, 0, NaN, 0, 0.15, 0)).toBeNull();
		expect(cameraOriginYLayout(0, 0, 0, 0, 0, 0)).toBeNull();
		expect(cameraOriginYLayout(0, 0, 0, 0, -1, 0)).toBeNull();
		expect(cameraOriginYLayout(NaN, 0, 0, 0, 1, 0)).toBeNull();
		// The padding is the new operand, and an unusable one must refuse too.
		expect(cameraOriginYLayout(0, 0, 0, 0, 1, NaN)).toBeNull();
	});
});

describe("impliedDocumentTop", () => {
	it("reconstructs the document top the anchor stands for", () => {
		const rungTop = 56 * RUNG_SPACING;
		expect(impliedDocumentTop(rungTop, -17218.2 - PAD + rungTop * 0.15, 0.15, PAD)).toBeCloseTo(-17218.2, 6);
	});
});

describe("rungIndexFor", () => {
	it("picks the nearest rung to where the camera was left", () => {
		expect(rungIndexFor(0, RUNG_SPACING, 100)).toBe(0);
		expect(rungIndexFor(RUNG_SPACING * 0.49, RUNG_SPACING, 100)).toBe(0);
		expect(rungIndexFor(RUNG_SPACING * 0.51, RUNG_SPACING, 100)).toBe(1);
		// Alan's 114822 layout px note.
		expect(rungIndexFor(114822, RUNG_SPACING, 100)).toBe(56);
	});
	it("clamps instead of reading a rung that is not there", () => {
		expect(rungIndexFor(1e9, RUNG_SPACING, 10)).toBe(9);
		expect(rungIndexFor(-1e9, RUNG_SPACING, 10)).toBe(0);
	});
	it("answers 0 rather than NaN on unusable input, because rung 0 always exists", () => {
		expect(rungIndexFor(NaN, RUNG_SPACING, 10)).toBe(0);
		expect(rungIndexFor(1000, 0, 10)).toBe(0);
		expect(rungIndexFor(1000, RUNG_SPACING, 0)).toBe(0);
	});
	it("the worst residual is half a spacing, which is E's precision claim", () => {
		// Whatever the camera is, the chosen rung is within half a spacing of it.
		for (const y of [0, 1, 1023, 1025, 114822, 306186, 1_000_000]) {
			const k = rungIndexFor(y, RUNG_SPACING, MAX_RUNGS);
			if (k > 0 && k < MAX_RUNGS - 1) expect(Math.abs(y - k * RUNG_SPACING)).toBeLessThanOrEqual(RUNG_SPACING / 2);
		}
	});
});

describe("ladderShape", () => {
	it("covers the extent and no more", () => {
		expect(ladderShape(0)).toEqual({ count: 1, spacing: RUNG_SPACING });
		// Alan's note: 57 rungs.
		expect(ladderShape(114822)).toEqual({ count: 57, spacing: RUNG_SPACING });
		// Four times it: 225.
		expect(ladderShape(114822 * 4)).toEqual({ count: 225, spacing: RUNG_SPACING });
	});
	it("doubles the spacing rather than passing the cap", () => {
		const huge = ladderShape(RUNG_SPACING * MAX_RUNGS * 3);
		expect(huge.count).toBeLessThanOrEqual(MAX_RUNGS);
		expect(huge.spacing).toBe(RUNG_SPACING * 4);
	});
	it("treats a missing or negative extent as no extent", () => {
		expect(ladderShape(NaN).count).toBe(1);
		expect(ladderShape(-5).count).toBe(1);
	});
});
