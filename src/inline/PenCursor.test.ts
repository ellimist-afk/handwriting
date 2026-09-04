/**
 * BOTH SOURCE INPUTS ARE READ AS CODE, NOT AS TEXT. This is the only file in
 * the family that scans two - `InkOverlay.ts` and `styles.css` - and it was
 * unprotected on both.
 *
 * Demonstrated on this branch in one edit, with every assertion below staying
 * green through it:
 *
 *   - the stylesheet's `display: none` default was retired into a comment and
 *     a live copy without it left in its place. The second assertion below,
 *     whose entire job is "if this rule ever goes away the empty-string form
 *     starts working by accident, which is worse than failing loudly", read
 *     the retired copy and passed.
 *   - both `penCursorEl.setCssStyles({ display: "none" })` sites were moved
 *     behind a helper and the old lines left as `// was: …` comments. The
 *     first assertion's anti-vacuity check - `showBlocks.length > 0` - was
 *     then satisfied entirely by comments, and its loop inspected sentences.
 *
 * There is a loud direction too, and it is unusually likely here: the needle
 * is `display: ""`, the exact buggy form, so the natural comment to write
 * beside the fix - one QUOTING what went wrong - trips the assertion that
 * forbids it. That is a false alarm; the two above are false all-clears. One
 * call closes all three.
 *
 * `codeOnly` (src/CodeOnly.ts) is the shared stripper, imported not copied.
 * `styles.css` carries no `//` sequence at all (verified), and `InkOverlay.ts`
 * already goes through `codeOnly` in `StripPenChrome.test.ts`, so neither
 * input is a new case for it. Blanking can only remove candidate matches, so
 * no real reveal site and no real stylesheet rule stops being seen; what stops
 * being seen is one that was only ever a sentence. Nothing here pins a
 * documented REASON, so no assertion is left reading raw.
 */

import { describe, expect, it } from "vitest";
import { MIN_CURSOR_VISUAL_PX } from "./PenCursor";
import overlaySrc from "./InkOverlay.ts?raw";
import css from "../../styles.css?raw";
import { codeOnly } from "../CodeOnly";

function overlaySource(): string {
	return codeOnly(overlaySrc);
}

function cursorCss(): string {
	return codeOnly(css);
}

/**
 * The cursor's style-writing sites in a piece of overlay source, comments
 * excluded. A pure function so the fixtures at the bottom can attack it with
 * a string rather than by editing the real overlay and putting it back.
 */
function cursorStyleBlocks(src: string): string[] {
	return codeOnly(src).match(/(penCursorEl|eraserEl)\.setCssStyles\(\{[^}]*\}/gs) ?? [];
}

/**
 * Does the pen cursor's OWN rule default it to `display: none`?
 *
 * Bound to the rule, not to the file, and that is a second defect found while
 * closing the first. The assertion this replaces was
 * `/\.handwriting-pen-cursor[\s\S]*?display:\s*none/` across the whole sheet,
 * and `styles.css` carries TWELVE `display: none` declarations - so it passed
 * on the class name appearing anywhere above any of the other eleven, and
 * would pass over a pen-cursor rule with no `display` in it at all. Blanking
 * comments does not close that by itself; the match has to be scoped to the
 * rule. Strictly stronger than what it replaces: every sheet the new form
 * accepts, the old pattern accepted too.
 *
 * `(?![-\w.])` keeps it on the BASE rule - `.handwriting-pen-cursor` bare, in
 * a selector list - rather than on the hover-state rules that extend it.
 */
function penCursorDefaultsToHidden(sheet: string): boolean {
	const rules = codeOnly(sheet).match(/[^{}]+\{[^}]*\}/g) ?? [];
	return rules.some((rule) => {
		const brace = rule.indexOf("{");
		if (!/\.handwriting-pen-cursor(?![-\w.])/.test(rule.slice(0, brace))) return false;
		return /display:\s*none/.test(rule.slice(brace));
	});
}

import { isPenCompatMouseMove, penCursorLayout } from "./PenCursor";

describe("inline pen cursor layout", () => {
	it("centers a visible minimum-size cursor under a thin pen", () => {
		const cursor = penCursorLayout({
			x: 100,
			y: 50,
			strokeWidth: 2,
			cameraZoom: 1,
			cssScale: 1,
		});

		// Pinned to the constant, not a literal: the floor is a presentation
		// choice that moved once already (6px was a speck under the nib).
		const d = MIN_CURSOR_VISUAL_PX;
		expect(cursor).toEqual({ x: 100 - d / 2, y: 50 - d / 2, diameter: d });
	});

	it("keeps the minimum diameter constant in VISUAL pixels under page scaling", () => {
		const cursor = penCursorLayout({
			x: 100,
			y: 50,
			strokeWidth: 2,
			cameraZoom: 1,
			cssScale: 1.25,
		});

		expect(cursor.diameter * 1.25).toBeCloseTo(MIN_CURSOR_VISUAL_PX);
		expect(cursor.x + cursor.diameter / 2).toBe(100);
		expect(cursor.y + cursor.diameter / 2).toBe(50);
	});

	it("shows the selected stroke width when it is larger than the minimum", () => {
		const cursor = penCursorLayout({
			x: 40,
			y: 30,
			strokeWidth: 18,
			cameraZoom: 1.2,
			cssScale: 1,
		});

		expect(cursor.diameter).toBeCloseTo(21.6);
		expect(cursor.x + cursor.diameter / 2).toBeCloseTo(40);
		expect(cursor.y + cursor.diameter / 2).toBeCloseTo(30);
	});
});

describe("inline pen cursor ownership", () => {
	it("keeps the pen cursor through an immediate same-point mouse-compatible move", () => {
		expect(
			isPenCompatMouseMove({
				now: 1050,
				lastPenHoverAt: 1000,
				mouseX: 401,
				mouseY: 299,
				penX: 400,
				penY: 300,
			})
		).toBe(true);
	});

	it("lets a real mouse at another point restore the editor cursor", () => {
		expect(
			isPenCompatMouseMove({
				now: 1050,
				lastPenHoverAt: 1000,
				mouseX: 450,
				mouseY: 300,
				penX: 400,
				penY: 300,
			})
		).toBe(false);
	});

	it("lets a later mouse move restore the editor cursor at the same point", () => {
		expect(
			isPenCompatMouseMove({
				now: 1201,
				lastPenHoverAt: 1000,
				mouseX: 400,
				mouseY: 300,
				penX: 400,
				penY: 300,
			})
		).toBe(false);
	});
});

describe("the cursors have to be shown with a real display value", () => {
	// Both cursors sat at display:none in the stylesheet and were "shown"
	// with setCssStyles({ display: "" }). An empty string REMOVES the inline
	// declaration, so the element fell back to the stylesheet and neither the
	// pen reticle nor the eraser ring ever appeared on screen. They were
	// positioned and sized correctly every frame, invisibly.
	const source = overlaySource();

	it("never uses an empty display string to reveal a cursor", () => {
		// Code, not text. The anti-vacuity count below is the half comments
		// used to prop up: read raw, two `// was: …` lines kept it above zero
		// over an overlay with no reveal sites left at all.
		const showBlocks = cursorStyleBlocks(source);
		expect(showBlocks.length).toBeGreaterThan(0);
		for (const block of showBlocks) {
			if (!block.includes("display")) continue;
			expect(block).not.toMatch(/display:\s*""/);
		}
	});

	it("keeps the stylesheet default that made the bug possible", () => {
		// If this rule ever goes away the empty-string form would start
		// working by accident, which is worse than failing loudly. Read from
		// the cascade, and from the pen cursor's own rule rather than from
		// anywhere in a sheet that declares `display: none` twelve times.
		expect(penCursorDefaultsToHidden(css)).toBe(true);
	});
});

describe("both scans read code, not the sentences beside it", () => {
	// Fixtures. Without them a green run above is only a coincidence, which is
	// the failure this whole family is named for.
	const REVEAL = '\t\tthis.penCursorEl.setCssStyles({\n\t\t\tdisplay: "block",\n\t\t});\n';

	it("finds a real reveal site", () => {
		// Anti-vacuity for the fixtures themselves.
		expect(cursorStyleBlocks(REVEAL)).toHaveLength(1);
	});

	it("still catches a real reveal site using the empty-string form", () => {
		// The assertion's original job, unchanged by reading code.
		const buggy = '\t\tthis.penCursorEl.setCssStyles({ display: "" });\n';
		expect(cursorStyleBlocks(buggy)[0]).toMatch(/display:\s*""/);
	});

	it("does NOT count a reveal site that survives only as a comment", () => {
		// THE DEFEAT, verbatim: the shape a refactor leaves behind.
		const moved =
			'\t\t// moved into hideCursorEl(); was:\n\t\t//   this.penCursorEl.setCssStyles({ display: "none" })\n\t\tthis.hideCursorEl(this.penCursorEl);\n';
		expect(cursorStyleBlocks(moved)).toEqual([]);
	});

	it("does NOT fire on a comment that quotes the buggy form while explaining it", () => {
		// The loud direction, and the likeliest comment anyone would write
		// here: the fix's own explanation contains the thing it forbids.
		const explained =
			'\t/**\n\t * Both cursors were "shown" with setCssStyles({ display: "" }), which\n\t * REMOVES the declaration, so they fell back to display: none.\n\t */\n';
		expect(cursorStyleBlocks(explained)).toEqual([]);
	});

	it("does NOT accept a retired copy of the stylesheet default", () => {
		const live = ".handwriting-pen-cursor,\n.handwriting-eraser-cursor {\n\tdisplay: none;\n}\n";
		expect(penCursorDefaultsToHidden(live)).toBe(true);
		expect(penCursorDefaultsToHidden(`/*\n${live}*/\n`)).toBe(false);
	});

	it("does NOT accept a display: none belonging to some other rule", () => {
		// The second defect, pinned: the pattern this replaced spanned the
		// whole sheet, and styles.css declares display: none twelve times.
		const elsewhere =
			".handwriting-pen-cursor {\n\tposition: absolute;\n}\n\n.handwriting-whats-new {\n\tdisplay: none;\n}\n";
		expect(penCursorDefaultsToHidden(elsewhere)).toBe(false);
		expect(/\.handwriting-pen-cursor[\s\S]*?display:\s*none/.test(elsewhere)).toBe(true);
	});

	it("does NOT accept it from a hover-state rule that merely extends the class", () => {
		const hoverOnly = ".handwriting-pen-cursor.handwriting-pen-hover-space {\n\tdisplay: none;\n}\n";
		expect(penCursorDefaultsToHidden(hoverOnly)).toBe(false);
	});
});
