import { beforeEach, describe, expect, it } from "vitest";
import {
	EXPORT_MIN_CONTRAST,
	contrastRatio,
	exportInkColor,
	inkColorFor,
	inkExportReadabilityEnabled,
	readableInkColor,
	relativeLuminance,
	resetInkTheme,
	resolveInkColor,
	setInkExportReadability,
	withInkDestination,
} from "./InkTheme";
import { PEN_COLORS } from "./InkColor";
import { inkSvgLayers, inkToSvg } from "./SvgExport";
import { PDF_PAGE_WHITE, PdfPageAssumption, inkPdfContent, inkToPdf } from "./InkPdf";
import { appendInkToPdf } from "./InkPdfAppend";
import { drawStroke } from "./StrokeRenderer";
import { InkPoint, InkStroke, computeBBox } from "./Stroke";
import { CameraState } from "../camera/coordinates";
import { document as pdfDocumentFixture, streamObject } from "../../test/pdf-fixture";
import { PdfInkController } from "../pdf/PdfInkController";

/**
 * THE COMPLAINT, AS A SUITE.
 *
 * Public, from the Reddit thread: ink drawn on the dark theme with the
 * palette's near-white pen exports onto a white page and is invisible. Alan
 * ruled the direction - asked whether an export should reproduce the screen
 * or guarantee readable ink, "guarantee readable ink" - so what is pinned
 * here is the GUARANTEE, path by path, and the two things the guarantee is
 * not allowed to cost: the hue you chose, and the highlighter.
 *
 * Every path is asserted SEPARATELY and on purpose. This defect survived four
 * paint paths precisely because one painter was fixed and the rest were
 * assumed, and Flatten - which was about to be recommended publicly as the
 * workaround - had it too.
 */

const WHITE = "#ffffff";
/** A dark destination, for the half of the rule that points the other way. */
const NEAR_BLACK = "#1e1e1e";
/** The palette's white pen: the exact colour the complaint was about. */
const PEN_WHITE = "#f4f4f2";
/** The palette's highlighter yellow, which the mirror rule would have missed. */
const YELLOW = "#ffd60a";
const NAVY = "#004F8B";
const GREEN = "#008C3A";

const CAM: CameraState = { x: 0, y: 0, zoom: 1 };

function rgbOf(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function lumOf(hex: string): number {
	const [r, g, b] = rgbOf(hex);
	return relativeLuminance(r, g, b);
}

function contrastOn(hex: string, destination: string): number {
	return contrastRatio(lumOf(hex), lumOf(destination));
}

/**
 * Hue in degrees, computed independently of the module under test - the point
 * of the assertion is that the rule's own conversion did not drift the hue,
 * so sharing its arithmetic would defeat it.
 */
function hueOf(hex: string): number {
	const [r, g, b] = rgbOf(hex).map((v) => v / 255) as [number, number, number];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	if (d === 0) return 0;
	const h =
		max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return (h * 60 + 360) % 360;
}

function strokeOf(color: string, tool: "pen" | "highlighter" = "pen", page?: number): InkStroke {
	const points: InkPoint[] = [0, 1, 2, 3].map((i) => ({
		x: 100 + i * 10,
		y: 200 + i * 2,
		pressure: 0.5,
		t: i * 8,
	}));
	return {
		id: `s-${tool}-${color}`,
		tool,
		color,
		width: 3,
		points,
		bbox: computeBBox(points, 3),
		createdAt: 0,
		...(page === undefined ? {} : { page }),
	};
}

/** Enough of a 2d context to capture what colour a stroke was painted with. */
function fakeCtx(): CanvasRenderingContext2D {
	return {
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 0,
		lineCap: "",
		lineJoin: "",
		globalAlpha: 1,
		beginPath() {},
		moveTo() {},
		lineTo() {},
		quadraticCurveTo() {},
		closePath() {},
		arc() {},
		fill() {},
		stroke() {},
		save() {},
		restore() {},
		setTransform() {},
	} as unknown as CanvasRenderingContext2D;
}

/** Every colour a PDF content stream sets, as hex, in the order written. */
function pdfFills(content: string): string[] {
	const out: string[] = [];
	const re = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) rg/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		const two = (v: string) =>
			Math.round(Number(v) * 255)
				.toString(16)
				.padStart(2, "0");
		out.push(`#${two(m[1]!)}${two(m[2]!)}${two(m[3]!)}`);
	}
	return out;
}

function latin1(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return s;
}

/**
 * PATH 5's painter: the PDF snip, run by the real controller over one page the
 * viewer has not rendered (so the snip paints its own white ground), with the
 * page assumption handed to it the way main.ts hands it the setting. The fuller
 * cases - the viewer's page crop, a dark page, the production construction
 * site, a live setting change and the scope ending before the encode - are in
 * src/pdf/PdfSnipDestination.test.ts. What this returns is the context's
 * fillStyle once the snip has painted: the ink's, because the ink is the last
 * thing the snip fills, and the white ground's if no ink was painted at all.
 */
async function pdfSnipFill(assumption: PdfPageAssumption, stroke: InkStroke): Promise<string> {
	const page = {
		tagName: "DIV",
		className: "page",
		parentElement: null,
		clientWidth: 600,
		clientHeight: 800,
		offsetTop: 0,
		offsetLeft: 0,
		clientTop: 0,
		clientLeft: 0,
		getAttribute: (n: string) => (n === "data-page-number" ? "1" : null),
		querySelector: () => null,
		querySelectorAll: () => [],
	};
	const scroller = {
		querySelectorAll: (sel: string) => (sel === "div.page[data-page-number]" ? [page] : []),
		querySelector: (sel: string) => (sel === 'div.page[data-page-number="1"]' ? page : null),
	};
	const root = { querySelector: (sel: string) => (sel === ".pdf-viewer-container" ? scroller : null) };
	const win = {
		devicePixelRatio: 1,
		getComputedStyle: () => ({ getPropertyValue: (p: string) => (p === "--scale-factor" ? "2" : "") }),
	};
	const ctx = Object.assign(fakeCtx(), { fillRect() {}, drawImage() {} });
	const g = globalThis as unknown as Record<string, unknown>;
	g.createEl = () => ({
		width: 0,
		height: 0,
		getContext: () => ctx,
		toBlob: (cb: (b: Blob | null) => void) => cb(new Blob([new Uint8Array([0x89])])),
	});
	try {
		const strokes = [{ ...stroke, page: 1 }];
		const controller = new PdfInkController(
			root as unknown as HTMLElement,
			win as unknown as Window,
			() => strokes,
			() => "doc-1",
			() => strokes,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			() => assumption
		);
		const priv = controller as unknown as { selected: string[]; selectionPage: number };
		priv.selected = [stroke.id];
		priv.selectionPage = 1;
		const r = await controller.snipSelection();
		if (!r.ok) throw new Error(`pdf snip refused: ${r.reason}`);
		return String(ctx.fillStyle);
	} finally {
		delete g.createEl;
	}
}

beforeEach(() => {
	resetInkTheme();
});

describe("the rule: readable at the destination", () => {
	it("rescues the pen the complaint was about", () => {
		// ACCEPTANCE 1. Against unchanged production this fails with the input
		// colour, because the export painters emit the stored value.
		const out = readableInkColor(PEN_WHITE, WHITE);
		expect(
			contrastOn(out, WHITE),
			`near-white pen exported as ${out} onto a white page`
		).toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);
	});

	it("rescues highlighter yellow when it is a PEN, and leaves the highlighter alone", () => {
		// ACCEPTANCE 2. This pair is what separates a contrast rule from the
		// mirror: #ffd60a is not neutral, so a neutrality-gated rule waves it
		// through at about 1.4:1 on white.
		expect(contrastOn(YELLOW, WHITE)).toBeLessThan(EXPORT_MIN_CONTRAST);

		const asPen = readableInkColor(YELLOW, WHITE, "pen");
		expect(contrastOn(asPen, WHITE), `yellow pen exported as ${asPen}`).toBeGreaterThanOrEqual(
			EXPORT_MIN_CONTRAST
		);

		expect(
			readableInkColor(YELLOW, WHITE, "highlighter"),
			"a highlighter is a wash you read THROUGH; darkening it destroys what it is for"
		).toBe(YELLOW);
	});

	it("moves lightness and never hue", () => {
		// ACCEPTANCE 3. The dark rule protects hues by refusing non-neutral
		// colours outright. A contrast rule cannot: it MUST touch the yellow.
		// So the weaker promise is the one asserted - the hue survives.
		const asPen = readableInkColor(YELLOW, WHITE, "pen");
		expect(asPen).not.toBe(YELLOW);
		expect(hueOf(asPen), "yellow stayed yellow").toBeCloseTo(hueOf(YELLOW), 0);

		// Navy on a dark page is the case the module header warns about from
		// the other side: a luminance-only rule repaints blue annotations grey.
		const navyOnDark = readableInkColor(NAVY, NEAR_BLACK);
		expect(navyOnDark).not.toBe(NAVY);
		expect(hueOf(navyOnDark), "navy stayed navy").toBeCloseTo(hueOf(NAVY), 0);
		expect(contrastOn(navyOnDark, NEAR_BLACK)).toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);
	});

	it("leaves hues that already read on the destination exactly as they were", () => {
		// Both of these clear 3:1 on white unaided (navy 8.4:1, green 4.4:1),
		// so the rule has no business touching them at all.
		expect(contrastOn(NAVY, WHITE)).toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);
		expect(contrastOn(GREEN, WHITE)).toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);
		expect(readableInkColor(NAVY, WHITE)).toBe(NAVY);
		expect(readableInkColor(GREEN, WHITE)).toBe(GREEN);
	});

	it("stops a hued pen at the target instead of crushing it to black", () => {
		// ACCEPTANCE 4. A page of coloured annotations all driven to #000 is a
		// different complaint arriving by the same route.
		const out = readableInkColor(YELLOW, WHITE);
		expect(out, `${YELLOW} was crushed to black`).not.toBe("#000000");
		expect(contrastOn(out, WHITE), `${YELLOW} -> ${out} overshot the target`).toBeLessThan(
			EXPORT_MIN_CONTRAST + 1
		);
	});

	// FOLLOWUPS 378. A grey pen that fails on a light page used to stop at the
	// target too, so the white pen, #dddddd and #cccccc all arrived as the same
	// mid grey near #959595. Now a neutral pen there is the palette's black.
	it.each([PEN_WHITE, "#dddddd", "#cccccc"])(
		"a neutral %s pen that fails on a white page exports as the palette's black",
		(c) => {
			expect(contrastOn(c, WHITE), `premise: ${c} fails on white`).toBeLessThan(EXPORT_MIN_CONTRAST);
			expect(readableInkColor(c, WHITE)).toBe("#000000");
		}
	);

	it("the black a neutral pen exports as is the palette's black pen", () => {
		expect(PEN_COLORS.find((c) => c.name === "black")?.hex).toBe("#000000");
	});

	it("a neutral pen keeps its alpha when it goes to black", () => {
		expect(readableInkColor("#f4f4f280", WHITE)).toBe("#00000080");
		expect(readableInkColor("rgba(244, 244, 242, 0.5)", WHITE)).toBe("rgba(0, 0, 0, 0.5)");
	});

	it("a neutral pen on a dark page still takes the smallest move toward white", () => {
		const out = readableInkColor("#111111", NEAR_BLACK);
		expect(out).not.toBe("#ffffff");
		expect(contrastOn(out, NEAR_BLACK)).toBeLessThan(EXPORT_MIN_CONTRAST + 1);
	});

	it("points both ways: near-black ink lightens on a dark destination", () => {
		const out = readableInkColor("#111111", NEAR_BLACK);
		expect(lumOf(out)).toBeGreaterThan(lumOf("#111111"));
		expect(contrastOn(out, NEAR_BLACK)).toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);
	});

	it("hands back anything it cannot read, rather than guessing", () => {
		expect(readableInkColor("currentColor", WHITE)).toBe("currentColor");
		expect(readableInkColor(PEN_WHITE, "var(--background)")).toBe(PEN_WHITE);
		expect(readableInkColor("", WHITE)).toBe("");
	});

	it("carries alpha through the adjustment", () => {
		const out = readableInkColor("#f4f4f280", WHITE);
		expect(out.length, `expected an 8-digit hex, got ${out}`).toBe(9);
		expect(out.slice(7)).toBe("80");
		expect(contrastOn(out.slice(0, 7), WHITE)).toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);
	});

	it("cites its threshold rather than inventing one", () => {
		// WCAG 2.1 SC 1.4.11 (Non-text Contrast): 3:1 for graphical objects.
		expect(EXPORT_MIN_CONTRAST).toBe(3);
	});
});

describe("the setting gates the rule, and nothing else does", () => {
	it("is on unless something turns it off", () => {
		expect(inkExportReadabilityEnabled()).toBe(true);
	});

	it("off means the stored colour leaves, on every path", () => {
		setInkExportReadability(false);
		expect(exportInkColor(PEN_WHITE, WHITE)).toBe(PEN_WHITE);
		expect(inkSvgLayers([strokeOf(PEN_WHITE)], WHITE).pen[0]!.color).toBe(PEN_WHITE);
		// The PDF writer quantises each channel to two decimals, so the stored
		// colour cannot be compared as an exact hex through that path - it
		// comes back a rounding step away. What the setting promises is that
		// the ink was NOT adapted, and an unreadable ratio is exactly that.
		// (This rounding is also why the rule aims a hair past its target.)
		const off = pdfFills(inkToPdf([strokeOf(PEN_WHITE)]));
		expect(off.length).toBe(1);
		expect(contrastOn(off[0]!, WHITE)).toBeLessThan(EXPORT_MIN_CONTRAST);
	});

	it("a null destination means the caller does not know, so nothing moves", () => {
		expect(exportInkColor(PEN_WHITE, null)).toBe(PEN_WHITE);
		expect(exportInkColor(PEN_WHITE, undefined)).toBe(PEN_WHITE);
	});
});

describe("the five paint paths, each asserted on its own", () => {
	it("PATH 2, Flatten: ink appended to an existing PDF page adapts", () => {
		// Flatten was about to be recommended publicly as the workaround for
		// this complaint. It is better on sharpness and page breaks and
		// IDENTICAL on colour - it would have handed over the same ghost page.
		//
		// This case was briefly inverted on 2026-09-08 and is RESTORED here on
		// Alan's ruling ("ink readable on white pages"), not on anyone else's
		// judgement. Assuming white does cost readability on grey and dark
		// stock - see the sweep in InkPdfFlattenDestination.test.ts - and his
		// answer to that was a toggle rather than a different default. The OFF
		// branch is the case directly below.
		const src = pdfDocumentFixture(1, () => "/Contents 4 0 R ", "", [
			streamObject("BT /F1 12 Tf (hello) Tj ET"),
		]);
		const bytes = new Uint8Array(src.length);
		for (let i = 0; i < src.length; i++) bytes[i] = src.charCodeAt(i) & 0xff;

		const r = appendInkToPdf(bytes, [strokeOf(PEN_WHITE, "pen", 1)]);
		expect(r.ok, r.ok ? "" : `flatten refused: ${r.reason}`).toBe(true);
		if (!r.ok) return;

		const fills = pdfFills(latin1(r.bytes));
		expect(fills.length).toBeGreaterThan(0);
		for (const f of fills) {
			expect(contrastOn(f, WHITE), `flattened ink written as ${f}`).toBeGreaterThanOrEqual(
				EXPORT_MIN_CONTRAST
			);
		}
	});

	it("PATH 2 on \"keep\": the stored colour is written through", () => {
		// The third state of Alan's dropdown. "keep" is for the person on
		// mid-tone stock, for whom BOTH guesses are wrong; they get 1.4.12's
		// bytes back. (A dark page is served by "lighten" instead - see
		// InkPdfFlattenDestination.test.ts.)
		const src = pdfDocumentFixture(1, () => "/Contents 4 0 R ", "", [
			streamObject("BT /F1 12 Tf (hello) Tj ET"),
		]);
		const bytes = new Uint8Array(src.length);
		for (let i = 0; i < src.length; i++) bytes[i] = src.charCodeAt(i) & 0xff;

		const r = appendInkToPdf(bytes, [strokeOf(PEN_WHITE, "pen", 1)], "keep");
		expect(r.ok, r.ok ? "" : `flatten refused: ${r.reason}`).toBe(true);
		if (!r.ok) return;

		const fills = pdfFills(latin1(r.bytes));
		expect(fills.length).toBeGreaterThan(0);
		// Below the target on white, which is the POINT of the off branch and
		// not a failure of it.
		for (const f of fills) {
			expect(contrastOn(f, WHITE), `flattened ink written as ${f}`).toBeLessThan(
				EXPORT_MIN_CONTRAST
			);
		}
	});

	it("PATH 3, export-ink-pdf: a created page is white and the ink knows it", () => {
		const fills = pdfFills(inkToPdf([strokeOf(PEN_WHITE)]));
		expect(fills.length).toBe(1);
		expect(
			contrastOn(fills[0]!, WHITE),
			`exported PDF wrote ${fills[0]}`
		).toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);
		expect(PDF_PAGE_WHITE).toBe(WHITE);
	});

	it.each([PEN_WHITE, "#cccccc"])("PATH 3: the PDF writer fills a neutral %s pen with black", (c) => {
		const text = inkToPdf([strokeOf(c)]);
		expect(pdfFills(text)).toEqual(["#000000"]);
		expect(text).toContain("0 0 0 rg");
	});

	it("PATH 1, the print/export vector layer: adapts when handed the page", () => {
		// This is the painter `usePrintVector` calls, with the destination it
		// passes. Whether Obsidian's own export FIRES that swap is a runtime
		// question `embedInkPrintSwaps()` answers in the app - see the handback.
		const adapted = inkSvgLayers([strokeOf(PEN_WHITE)], WHITE);
		expect(
			contrastOn(adapted.pen[0]!.color, WHITE),
			`print vector emitted ${adapted.pen[0]!.color}`
		).toBeGreaterThanOrEqual(EXPORT_MIN_CONTRAST);

		// And with no destination named, the stored colour still leaves - which
		// is what the LIVE rendered layer wants.
		expect(inkSvgLayers([strokeOf(PEN_WHITE)]).pen[0]!.color).toBe(PEN_WHITE);
	});

	it("PATH 4, the note snip: ink is readable on the white page the snip paints", () => {
		// The snip draws through the shared committed renderer, so the scope is
		// how it says where the ink is going.
		const ctx = fakeCtx();
		withInkDestination(WHITE, () => {
			drawStroke(ctx, CAM, strokeOf(PEN_WHITE), undefined, true);
		});
		const painted = String(ctx.fillStyle);
		expect(contrastOn(painted, WHITE), `snip painted ${painted}`).toBeGreaterThanOrEqual(
			EXPORT_MIN_CONTRAST
		);
	});

	it("PATH 5, the PDF snip: ink is readable on the page the setting declares", async () => {
		// The snip paints the viewer's page under its ink and cannot see what
		// colour that page is, so the destination is the page the user declares
		// ("Ink color on PDFs"). Against fed59a8c this fails with
		// the stored colour: the snip declared no destination at all.
		const painted = await pdfSnipFill("darken", strokeOf(PEN_WHITE));
		expect(contrastOn(painted, WHITE), `pdf snip painted ${painted}`).toBeGreaterThanOrEqual(
			EXPORT_MIN_CONTRAST
		);
	});

	it("PATH 5 on \"keep\": the stored colour is painted through", async () => {
		expect(await pdfSnipFill("keep", strokeOf(PEN_WHITE))).toBe(PEN_WHITE);
	});

	it("PATH 4: a highlighter in the same snip comes through untouched", () => {
		const ctx = fakeCtx();
		withInkDestination(WHITE, () => {
			drawStroke(ctx, CAM, strokeOf(YELLOW, "highlighter"), undefined, true);
		});
		expect(String(ctx.fillStyle)).toBe(YELLOW);
	});

	it("the highlighter exemption holds on the vector paths too", () => {
		expect(inkSvgLayers([strokeOf(YELLOW, "highlighter")], WHITE).highlighter[0]!.color).toBe(
			YELLOW
		);
		expect(pdfFills(inkPdfContent([strokeOf(YELLOW, "highlighter")], 100, "GSa", WHITE))).toEqual(
			[YELLOW]
		);
	});
});

describe("what the rule is not allowed to change", () => {
	it("ACCEPTANCE 7: the SVG still paints no background of its own", () => {
		const svg = inkToSvg([strokeOf(PEN_WHITE)], WHITE);
		expect(svg).toContain("<svg");
		expect(svg, "a background rect would stop the export being transparent").not.toContain(
			"<rect"
		);
		expect(svg).not.toContain("fillRect");
	});

	it("ACCEPTANCE 5: the light theme still has no rule at all", () => {
		expect(resolveInkColor(PEN_WHITE, false)).toBe(PEN_WHITE);
		expect(resolveInkColor("#000000", false)).toBe("#000000");
	});

	it("ACCEPTANCE 5: the dark rule is untouched by any of this", () => {
		expect(resolveInkColor("#000000", true)).toBe("#E6E6E6");
		expect(resolveInkColor(NAVY, true)).toBe(NAVY);
	});

	it("draw time is unchanged: no destination, no adjustment", () => {
		// The hot path pays one module-level null check and nothing else. On
		// screen there is never a destination, so the colour is the stored one.
		expect(inkColorFor(strokeOf(PEN_WHITE))).toBe(PEN_WHITE);
		expect(inkColorFor(YELLOW)).toBe(YELLOW);
	});

	it("the scope restores what it found, including when it is nested", () => {
		expect(inkColorFor(strokeOf(PEN_WHITE))).toBe(PEN_WHITE);
		withInkDestination(WHITE, () => {
			const outer = inkColorFor(strokeOf(PEN_WHITE));
			expect(outer).not.toBe(PEN_WHITE);
			withInkDestination(NEAR_BLACK, () => {
				expect(inkColorFor(strokeOf(PEN_WHITE))).toBe(PEN_WHITE);
			});
			expect(inkColorFor(strokeOf(PEN_WHITE))).toBe(outer);
		});
		expect(inkColorFor(strokeOf(PEN_WHITE))).toBe(PEN_WHITE);
	});

	it("the scope is restored even when the painter throws", () => {
		expect(() =>
			withInkDestination(WHITE, () => {
				throw new Error("painter blew up");
			})
		).toThrow("painter blew up");
		expect(inkColorFor(strokeOf(PEN_WHITE))).toBe(PEN_WHITE);
	});
});
