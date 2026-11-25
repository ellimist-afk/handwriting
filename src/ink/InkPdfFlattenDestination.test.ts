/**
 * What the flatten writer may assume about the page it is writing onto.
 *
 * `inkToPdf` CREATES its page, so it knows that page is white and adapting the
 * ink to it is a guarantee. `appendInkToPdf` writes onto a page that already
 * exists and reads that page's dictionary, not its pixels - so white there is
 * a GUESS. It is the right guess for almost every document and the wrong one
 * for grey and dark stock, where adapting parks every adapted ink at one
 * luminance (~0.29, the smallest move that reaches the target) and a mid-grey
 * page sits exactly there.
 *
 * Alan ruled both halves on 2026-09-08: "ink readable on white pages" (so the
 * guess stays, by default) then "with a toggle in the setings" (so the people
 * it hurts can turn it off). Both branches are pinned here, along with the
 * proof that no third colour would have served both - which is why this is a
 * toggle and not a cleverer rule.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "./Stroke";
import { appendInkToPdf } from "./InkPdfAppend";
import { inkToPdf, PDF_PAGE_DARK, PdfPageAssumption, normalizePdfPageAssumption } from "./InkPdf";
import { latin1 } from "../pdf/PdfSyntax";
import { document } from "../../test/pdf-fixture";
import {
	EXPORT_MIN_CONTRAST,
	contrastRatio,
	relativeLuminance,
	resetInkTheme,
} from "./InkTheme";

/** The palette's light pen - the colour the public complaint was about. */
const NEAR_WHITE = "#f4f4f2";
/** What `pdfColor` writes for it untouched, and adapted to white: the palette's black (FOLLOWUPS 378). */
const STORED_RG = "0.96 0.96 0.95 rg";
const ADAPTED_RG = "0 0 0 rg";
const HIGHLIGHTER_RG = "1 0.84 0.04 rg";

function strokeOf(color: string, tool: "pen" | "highlighter"): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: 100 + i * 10, y: 200 + i, pressure: 0.5, t: i * 8 }));
	return {
		id: `s-${tool}`,
		tool,
		color,
		width: 3,
		points,
		bbox: computeBBox(points, 3),
		createdAt: 0,
		page: 1,
	};
}

function bytes(src: string): Uint8Array {
	const out = new Uint8Array(src.length);
	for (let i = 0; i < src.length; i++) out[i] = src.charCodeAt(i) & 0xff;
	return out;
}

/** The flattened file, as text, the way a viewer's parser would see it. */
function flattened(strokes: readonly InkStroke[], mode: PdfPageAssumption = "darken"): string {
	const r = appendInkToPdf(bytes(document(1)), strokes, mode);
	if (!r.ok) throw new Error(`unexpected refusal: ${r.reason}`);
	return latin1(r.bytes);
}

/** Every `r g b rg` fill in a content stream, as 0..255 channels. */
function fills(pdfText: string): [number, number, number][] {
	const out: [number, number, number][] = [];
	const re = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) rg/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(pdfText)) !== null) {
		out.push([Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255]);
	}
	return out;
}

describe("flattening onto a page whose colour cannot be known", () => {
	beforeEach(() => {
		resetInkTheme();
	});

	it("ADAPTS by default, which is the answer Alan ruled for the common page", () => {
		const text = flattened([strokeOf(NEAR_WHITE, "pen")]);
		expect(text).toContain(ADAPTED_RG);
		expect(text).not.toContain(STORED_RG);
	});

	it("writes the STORED colour on \"keep\"", () => {
		const text = flattened([strokeOf(NEAR_WHITE, "pen")], "keep");
		expect(text).toContain(STORED_RG);
		expect(text).not.toContain(ADAPTED_RG);
	});

	it("on \"keep\", leaves no grey page worse off than 1.4.12 did", () => {
		const written = fills(flattened([strokeOf(NEAR_WHITE, "pen")], "keep"))[0]!;
		const storedLum = relativeLuminance(0xf4, 0xf4, 0xf2);
		const writtenLum = relativeLuminance(written[0], written[1], written[2]);
		const lost: string[] = [];
		for (let v = 0; v <= 255; v += 5) {
			const pageLum = relativeLuminance(v, v, v);
			const before = contrastRatio(storedLum, pageLum);
			const after = contrastRatio(writtenLum, pageLum);
			if (before >= EXPORT_MIN_CONTRAST && after < EXPORT_MIN_CONTRAST) {
				const hex = `#${v.toString(16).padStart(2, "0").repeat(3)}`;
				lost.push(`${hex} ${before.toFixed(2)} -> ${after.toFixed(2)}`);
			}
		}
		expect(lost).toEqual([]);
	});

	it("never touches the highlighter, which is exempt at the rule's first line", () => {
		expect(flattened([strokeOf("#ffd60a", "highlighter")])).toContain(HIGHLIGHTER_RG);
		expect(flattened([strokeOf("#ffd60a", "highlighter")], "keep")).toContain(HIGHLIGHTER_RG);
		expect(flattened([strokeOf("#ffd60a", "highlighter")], "lighten")).toContain(HIGHLIGHTER_RG);
	});

	// The COST of the default, pinned so it stays deliberate. If the rule in
	// readableInkColor is ever retuned, this is the case that should notice.
	// It was retuned for FOLLOWUPS 378: a grey pen on a light page now goes to
	// the palette's black instead of stopping near luminance 0.29, so the band
	// moved from mid-grey pages to the darkest ones - white ink written over a
	// dark picture leaves as black. A documented trade, and the reason the
	// toggle above exists at all.
	it("by default gives up readability on the darkest pages, and that band is known", () => {
		const written = fills(flattened([strokeOf(NEAR_WHITE, "pen")]))[0]!;
		const adaptedLum = relativeLuminance(written[0], written[1], written[2]);
		const storedLum = relativeLuminance(0xf4, 0xf4, 0xf2);
		const lost: string[] = [];
		for (let v = 0; v <= 255; v += 15) {
			const pageLum = relativeLuminance(v, v, v);
			if (
				contrastRatio(storedLum, pageLum) >= EXPORT_MIN_CONTRAST &&
				contrastRatio(adaptedLum, pageLum) < EXPORT_MIN_CONTRAST
			) {
				lost.push(`#${v.toString(16).padStart(2, "0").repeat(3)}`);
			}
		}
		expect(lost).toEqual(["#000000", "#0f0f0f", "#1e1e1e", "#2d2d2d", "#3c3c3c", "#4b4b4b"]);
	});
});

describe("the standalone PDF, which does know its page", () => {
	beforeEach(() => {
		resetInkTheme();
	});

	// The control against over-correcting: the fix above must not reach this
	// path. `inkToPdf` paints no background and a PDF page with none is white
	// in every reader, so here the destination is a fact and not a guess.
	it("still adapts near-white ink, which is the complaint the slice fixed", () => {
		const text = inkToPdf([strokeOf(NEAR_WHITE, "pen")]);
		expect(text).toContain(ADAPTED_RG);
		expect(text).not.toContain(STORED_RG);
	});

	it("still leaves the highlighter alone", () => {
		expect(inkToPdf([strokeOf("#ffd60a", "highlighter")])).toContain(HIGHLIGHTER_RG);
	});
});

describe("why the flatten path cannot have both", () => {
	// Not a behaviour test: an arithmetic proof that no output colour whatsoever
	// satisfies "reach 3.08:1 on white" AND "no worse than 1.4.12 on black".
	// It is luminance-only, so it holds for ANY adaptation strategy, not just
	// this one - which is why the fix is to stop guessing rather than to guess
	// better.
	it("no luminance reaches 3.08 on white and still matches 1.4.12 on black", () => {
		const storedLum = relativeLuminance(0xf4, 0xf4, 0xf2);
		const blackLum = relativeLuminance(0, 0, 0);
		const whiteLum = relativeLuminance(255, 255, 255);
		// To be no worse than the stored colour on black, an output must be at
		// least as light as it was.
		const floor = contrastRatio(storedLum, blackLum) * (blackLum + 0.05) - 0.05;
		// To reach 3.08 on white, it must be no lighter than this.
		const ceiling = (whiteLum + 0.05) / 3.08 - 0.05;
		expect(floor).toBeGreaterThan(ceiling);
	});
});

describe("the dark page, which nothing reached before the dropdown", () => {
	beforeEach(() => {
		resetInkTheme();
	});

	/** Palette black, and a dark-mode export's page. */
	const BLACK_INK = "#1c1f26";
	const DARK_PAGE = "#1a1a1a";

	const lumOf = (hex: string): number =>
		relativeLuminance(
			parseInt(hex.slice(1, 3), 16),
			parseInt(hex.slice(3, 5), 16),
			parseInt(hex.slice(5, 7), 16)
		);
	const writtenLum = (mode: PdfPageAssumption): number => {
		const w = fills(flattened([strokeOf(BLACK_INK, "pen")], mode))[0]!;
		return relativeLuminance(w[0], w[1], w[2]);
	};

	// Alan found this himself: "does it work the other way? like black ink on
	// dark pages?" It did not, and the reason is worth keeping - the rule
	// LEAVES dark ink alone under "darken" because it already passes against
	// white. The failure was an omission, not an over-correction, so both
	// positions of the old boolean wrote identical bytes.
	it("darken and keep are IDENTICAL for dark ink, and both are unreadable on a dark page", () => {
		const dark = flattened([strokeOf(BLACK_INK, "pen")], "darken");
		const kept = flattened([strokeOf(BLACK_INK, "pen")], "keep");
		expect(fills(dark)[0]).toEqual(fills(kept)[0]);
		const page = lumOf(DARK_PAGE);
		expect(contrastRatio(writtenLum("darken"), page)).toBeLessThan(EXPORT_MIN_CONTRAST);
		expect(contrastRatio(writtenLum("keep"), page)).toBeLessThan(EXPORT_MIN_CONTRAST);
	});

	it("lighten makes that same ink readable on a dark page", () => {
		const page = lumOf(DARK_PAGE);
		const before = contrastRatio(writtenLum("keep"), page);
		const after = contrastRatio(writtenLum("lighten"), page);
		expect(before, "the case this option exists for").toBeLessThan(EXPORT_MIN_CONTRAST);
		expect(after, "and what it is worth").toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);
	});

	// The assumed dark is #2d2d2d and NOT #000000, measured before it was
	// picked: contrast is compressed at the dark end, so ink lightened just
	// enough to clear black fails on a #1a1a1a page. This pins both ends of
	// the range the option claims to serve.
	it("serves the whole plausible dark range, both ends", () => {
		const l = writtenLum("lighten");
		for (const page of ["#000000", "#121212", "#1a1a1a", "#1e1e1e", PDF_PAGE_DARK]) {
			expect(
				contrastRatio(l, lumOf(page)),
				`a dark page at ${page} must be able to carry this ink`
			).toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);
		}
	});

	// The mirror of the band asserted above for the light side, and it is
	// WIDER - eight pages against five - because the assumed dark is #2d2d2d
	// rather than pure black, which pushes the ink further from the dark end.
	// That is the price of serving #1e1e1e, and it is paid in pages a user who
	// just declared their stock dark does not have. Neither guess is safe on a
	// mid-tone page, which is why "keep" is not a courtesy.
	it("gives up mid-grey pages in return, and that band is known too", () => {
		const l = writtenLum("lighten");
		const stored = lumOf(BLACK_INK);
		const lost: string[] = [];
		for (let v = 0; v <= 255; v += 15) {
			const page = relativeLuminance(v, v, v);
			if (
				contrastRatio(stored, page) >= EXPORT_MIN_CONTRAST &&
				contrastRatio(l, page) < EXPORT_MIN_CONTRAST
			) {
				lost.push(`#${v.toString(16).padStart(2, "0").repeat(3)}`);
			}
		}
		expect(lost).toEqual([
			"#696969", "#787878", "#878787", "#969696",
			"#a5a5a5", "#b4b4b4", "#c3c3c3", "#d2d2d2",
		]);
	});
});

describe("what an unrecognised stored value means", () => {
	// The enum's version of the coercion trap. The boolean needed `!== false`;
	// this needs "anything I do not know is the default", which covers an
	// absent key, a value from a newer version, and a hand-edited config.
	it("falls back to darken for absent, unknown, and wrong-typed values", () => {
		expect(normalizePdfPageAssumption(undefined)).toBe("darken");
		expect(normalizePdfPageAssumption(null)).toBe("darken");
		expect(normalizePdfPageAssumption("")).toBe("darken");
		expect(normalizePdfPageAssumption("DARKEN")).toBe("darken");
		expect(normalizePdfPageAssumption("invert")).toBe("darken");
		expect(normalizePdfPageAssumption(true)).toBe("darken");
		expect(normalizePdfPageAssumption(0)).toBe("darken");
	});

	it("keeps the two values it does know", () => {
		expect(normalizePdfPageAssumption("lighten")).toBe("lighten");
		expect(normalizePdfPageAssumption("keep")).toBe("keep");
		expect(normalizePdfPageAssumption("darken")).toBe("darken");
	});
});
