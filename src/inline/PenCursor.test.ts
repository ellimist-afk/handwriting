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
 *
 * `InkOverlay.ts` is no longer scanned at all. Its cursor reveals run on a
 * real overlay mounted all the way (`mountRig.test.util.ts`), and the pan
 * drag's reticle and grabbing hand are proved by `GestureReticlePersists.test.ts`,
 * which drives the real `penDown`, `penRaw` and `penUp`. The stylesheet and the
 * pdf surface are still read as code here.
 */

import { describe, expect, it } from "vitest";
import { MIN_CURSOR_VISUAL_PX } from "./PenCursor";
import css from "../../styles.css?raw";
import { codeOnly } from "../CodeOnly";
import { mountOverlay } from "./mountRig.test.util";
import { setTipMode, type TipMode } from "./TipMode";
import { surfaceCode } from "./surfaceFiles.testutil";

const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

function cursorCss(): string {
	return codeOnly(css);
}

/**
 * What a scroller rule naming `cls` sets `cursor` to, or null if the sheet has
 * no such rule. Scoped to the rule that names the class rather than to the
 * whole sheet, for the reason `penCursorDefaultsToHidden` below gives.
 */
function scrollerCursorFor(sheet: string, cls: string): string | null {
	const rules = codeOnly(sheet).match(/[^{}]+\{[^}]*\}/g) ?? [];
	for (const rule of rules) {
		const brace = rule.indexOf("{");
		if (!new RegExp(`\\.${cls}(?![-\\w])`).test(rule.slice(0, brace))) continue;
		const declared = /cursor:\s*([\w-]+)/.exec(rule.slice(brace));
		if (declared?.[1]) return declared[1];
	}
	return null;
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

import {
	PAN_DRAG_CLASS,
	PEN_HOVER_CLASS,
	isPenCompatMouseMove,
	penCursorLayout,
	penReticleShown,
} from "./PenCursor";

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

	it("never uses an empty display string to reveal a cursor", () => {
		// Run, not read: a real overlay, mounted all the way, shows each cursor
		// through its own method, and each element's style record is asked what
		// display it was given. The reticle is shown by opacity on a layer that
		// stays display: block; the eraser ring is shown by display itself.
		//
		// The reticle is painted by a different branch for every tip mode (the
		// nib's dot, the eraser-mode radius, the lasso and pan rings, the
		// insert-space bar), and each branch writes its own style block. The
		// scan this replaced read every one of those blocks, so every mode is
		// shown here: a reveal written into any one branch is caught in that
		// mode, not only in the nib's.
		const m = mountOverlay("pen-cursor-display.md");
		try {
			const o = m.o as Record<string, unknown> & {
				showPenCursor(s: unknown, pointerType?: string): void;
				hidePenCursor(): void;
				showEraserCursor(s: unknown): void;
			};
			const sample = { x: 40, y: 40, pressure: 0.5, t: 0 };
			const pen = (o.penCursorEl as { style: Record<string, string> }).style;
			const eraser = (o.eraserEl as { style: Record<string, string> }).style;

			expect(pen.display, "the reticle was created without a real display value").toBe("block");
			o.showPenCursor(sample, "pen");
			expect(Number(pen.opacity), "precondition: the reticle really was shown").toBeGreaterThan(0);
			expect(pen.display, "showing the reticle left it without a real display value").toBe("block");
			o.hidePenCursor();
			o.showPenCursor(sample, "pen");
			expect(pen.display, "showing the reticle again left it without a real display value").toBe("block");

			const modes: readonly TipMode[] = ["nib", "eraser", "lasso", "space", "pan"];
			for (const mode of modes) {
				setTipMode(mode);
				o.hidePenCursor();
				expect(Number(pen.opacity), `precondition: the reticle was hidden before the ${mode} tip showed it`).toBe(0);
				o.showPenCursor(sample, "pen");
				expect(Number(pen.opacity), `the ${mode} tip did not show the reticle`).toBeGreaterThan(0);
				expect(pen.display, `the ${mode} tip showed the reticle without a real display value`).toBe("block");
			}

			o.showEraserCursor(sample);
			expect(eraser.display, "the eraser ring was shown with an empty display string").toBe("block");
		} finally {
			setTipMode("nib");
			m.destroy();
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

/**
 * A PAN DRAG PAINTS NO RETICLE (alan, 2026-09-05, hardware: "pan reticle
 * allows you to like fling it away from the point of pan and it flickers").
 *
 * The rule is pure and lives in this module because the thing that used to
 * carry it - three call sites inside `InkOverlay` - cannot be unit-tested at
 * all: that file imports `obsidian`. `penReticleShown`'s own header carries
 * the mechanism (a rect frozen at pen-down, an overlay that scrolls out from
 * under it) and the ruling.
 */
describe("the pan drag's reticle rule", () => {
	it("shows the ring for a pan tip that is only hovering", () => {
		expect(penReticleShown("pan", false)).toBe(true);
	});

	it("refuses it once the pan drag is live", () => {
		expect(penReticleShown("pan", true)).toBe(false);
	});

	it("leaves every other tip alone, dragging or not", () => {
		// The reversal is the pan's alone. Lasso and space persistence
		// through a drag is real and is what `GestureReticlePersists.test.ts`
		// is named for; the eraser drives its own element entirely.
		for (const tip of ["nib", "eraser", "lasso", "space"] as const) {
			expect(penReticleShown(tip, true), `${tip} lost its reticle to the pan rule`).toBe(true);
			expect(penReticleShown(tip, false)).toBe(true);
		}
	});
});

describe("the pan drag's move handler positions nothing, and the hand is on the scroller", () => {
	// The overlay's halves of this rule run in GestureReticlePersists.test.ts:
	// "pan: pen-down puts the reticle away for the grabbing hand, the raw batch
	// leaves it away, and pen-up brings it back under the pointer" drives the
	// real penDown, penRaw and penUp, and asserts the ring stays down through the
	// drag and the grabbing-hand class goes on and comes off; "pan: nothing can
	// paint the ring mid-drag, not even a direct showPenCursor" closes the rest.
	// What stays here is the stylesheet half and the pdf surface.

	it("the stylesheet gives the drag a cursor, and the rule that makes it necessary is still there", () => {
		// Hiding the reticle without this leaves the surface with NO pointer
		// at all - `cursor: none` over a hidden ring - which is the defect the
		// third suite of GestureReticlePersists.test.ts was written for, on a
		// different edge. Both halves are read from their own rule rather than
		// from anywhere in a sheet that mentions `cursor` many times over.
		expect(scrollerCursorFor(css, PAN_DRAG_CLASS)).toBe("grabbing");
		expect(scrollerCursorFor(css, PEN_HOVER_CLASS)).toBe("none");
	});

	it("and the pdf surface carries the same ruling, class for class", () => {
		// THE OTHER SURFACE, ASSERTED HERE rather than in a pdf test, because
		// the scanner and the ruling both live in this file and this project's
		// most expensive recurring defect is a ruling that reached one ink
		// surface and not another - which is exactly what happened to this
		// one. 1.4.12-design §11: "the pan-drag reticle
		// fix is note-only, the pdf pan still paints the ring per sample via
		// `showPanCursor` and never wears the grabbing hand".
		//
		// The class is spelled rather than imported: the pdf surface names its
		// cursor classes as literals throughout (`handwriting-pdf-hover` and
		// the three mode rings), so there is no constant to import and
		// inventing one for this alone would leave the file's other five
		// unguarded.
		expect(scrollerCursorFor(css, "handwriting-pdf-pan-drag")).toBe("grabbing");
		expect(scrollerCursorFor(css, "handwriting-pdf-hover")).toBe("none");
		// Both ends again: a class added and never removed strands `cursor:
		// grabbing` over the viewer for the rest of the session.
		const pdf = surfaceCode("pdf", ALL_TS);
		expect(pdf).toContain('classList.add("handwriting-pdf-pan-drag")');
		expect(pdf, "nothing takes the grabbing hand off the pdf viewer again").toContain(
			'classList.remove("handwriting-pdf-pan-drag")'
		);
		// And the gate, called rather than re-implemented: it is the reason a
		// mid-drag `showCursor` from anywhere cannot put the ring back.
		expect(pdf, "the pdf surface decides the pan reticle rule for itself").toContain(
			"penReticleShown(tipMode(), this.panLast !== null)"
		);
	});
});

describe("both scans read code, not the sentences beside it", () => {
	// Fixtures. Without them a green run above is only a coincidence, which is
	// the failure this whole family is named for.
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

	it("reads a scroller cursor from its own rule and nowhere else", () => {
		const sheet =
			".cm-scroller.handwriting-pan-drag,\n.cm-scroller.handwriting-pan-drag * {\n\tcursor: grabbing;\n}\n";
		expect(scrollerCursorFor(sheet, "handwriting-pan-drag")).toBe("grabbing");
		expect(scrollerCursorFor(sheet, "handwriting-pen-hover")).toBe(null);
		// Retired into a comment is not declared.
		expect(scrollerCursorFor(`/*\n${sheet}*/\n`, "handwriting-pan-drag")).toBe(null);
		// And a neighbouring rule's cursor is not this rule's.
		expect(
			scrollerCursorFor(`.something-else {\n\tcursor: grabbing;\n}\n`, "handwriting-pan-drag")
		).toBe(null);
	});
});
