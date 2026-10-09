/**
 * J1C-76: pasting PDF ink copied from page 5 into a 2-page PDF. Real code:
 * PdfInkController.pasteFromClipboard, InkClipboard, applyOp, appendInkToPdf on a
 * real 2-page PDF from test/pdf-fixture.ts. Stubbed: PdfViewerProbe (2 pages),
 * minimal root/win (controller not mounted).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../pdf/PdfViewerProbe", () => ({ probeViewer: () => probe.current }));

import { PdfInkController } from "../pdf/PdfInkController";
import { applyOp } from "../pdf/PdfInkHistory";
import { appendInkToPdf } from "../ink/InkPdfAppend";
import { clearInkClipboard, copyInk } from "../inline/InkClipboard";
import type { InkStroke } from "../ink/Stroke";
import type { InkOp } from "../inline/InkHistory";
import { document as pdfDocument } from "../../test/pdf-fixture";

function pdfStroke(page: number): InkStroke {
	return {
		id: `src-${page}`, page, tool: "pen", color: "#111111", width: 2, createdAt: 0,
		points: [{ x: 10, y: 10, pressure: 0.5, t: 0 }, { x: 40, y: 30, pressure: 0.5, t: 8 }],
		bbox: { x: 10, y: 10, width: 30, height: 20 },
	} as InkStroke;
}

afterEach(() => clearInkClipboard());

describe("J1C-76: paste into a PDF with fewer pages", () => {
	it("does not store page-5 strokes in a 2-page PDF and claim success", () => {
		probe.current = {
			scroller: null,
			scaleFactor: 1,
			scaleSource: "test",
			pages: [1, 2].map((n) => ({ pageNumber: n, leftPx: 0, topPx: (n - 1) * 800, widthPx: 612, heightPx: 792, hasCanvas: true })),
		};
		let stored: InkStroke[] = [];
		const notes: string[] = [];
		const root = { addEventListener: () => {}, removeEventListener: () => {}, setAttribute: () => {}, hasAttribute: () => false } as unknown as HTMLElement;
		const win = { devicePixelRatio: 1, clearTimeout: () => {}, setTimeout: () => 0, requestAnimationFrame: () => 0,
			getComputedStyle: () => ({ position: "relative" }), navigator: { maxTouchPoints: 0, userAgent: "test" } };
		const ctl = new PdfInkController(
			root,
			win as unknown as Window,
			(page) => stored.filter((s) => s.page === page),
			() => "short-doc",
			() => stored,
			(op: InkOp) => { stored = applyOp(stored, op); },
			() => {},
			(m) => notes.push(m),
		);

		expect(copyInk([pdfStroke(5)], "long-doc")).toBe(1);
		ctl.pasteFromClipboard();

		const pdf = new TextEncoder().encode(pdfDocument(2));
		const flat = appendInkToPdf(pdf, stored);
		const outcome = { stored: stored.map((s) => s.page), notes, flattenOk: flat.ok, reason: flat.ok ? null : flat.reason };

		expect(outcome.stored.filter((p) => p! > 2), `no stroke stored past the last page (${JSON.stringify(outcome)})`).toEqual([]);
		expect(notes.some((n) => /^Handwriting: pasted \d/.test(n)) && stored.every((s) => s.page! > 2), "no 'pasted' claim for nothing visible").toBe(false);
		expect(flat.ok, `the PDF still flattens: ${outcome.reason}`).toBe(true);
	});
});
