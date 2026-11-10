/**
 * The viewer's page turn, read off Obsidian's PDF view. The read is optional:
 * every way it can fail answers null, and null keeps PDF ink as it was before
 * turns were read.
 */
import { describe, expect, it } from "vitest";
import { readViewTurn } from "./PdfViewerProbe";

const root = {} as HTMLElement;
/** A view shaped as Obsidian 1.15.0 builds it: view.viewer.child.pdfViewer (the pdf.js app) .pdfViewer (the page viewer). */
function view(pagesRotation: unknown, containerEl: unknown = root): unknown {
	return { containerEl, viewer: { child: { pdfViewer: { pdfViewer: { pagesRotation } } } } };
}

describe("reading the viewer's page turn", () => {
	it("answers each of the four turns", () => {
		for (const deg of [0, 90, 180, 270]) expect(readViewTurn(view(deg), root)).toBe(deg);
	});

	it("takes any whole number of turns round to one of the four", () => {
		expect(readViewTurn(view(450), root)).toBe(90);
		expect(readViewTurn(view(-90), root)).toBe(270);
		expect(readViewTurn(view(-360), root)).toBe(0);
	});

	it("answers null for anything that is not a quarter turn", () => {
		for (const bad of [45, 89.5, Number.NaN, Number.POSITIVE_INFINITY, "90", null, undefined, {}]) {
			expect(readViewTurn(view(bad), root), String(bad)).toBeNull();
		}
	});

	it("answers null when the view no longer shows this root", () => {
		expect(readViewTurn(view(90, {} as HTMLElement), root)).toBeNull();
		expect(readViewTurn({ viewer: { child: { pdfViewer: { pdfViewer: { pagesRotation: 90 } } } } }, root)).toBeNull();
	});

	it("answers null when any step of the path is missing", () => {
		expect(readViewTurn(null, root)).toBeNull();
		expect(readViewTurn(undefined, root)).toBeNull();
		expect(readViewTurn({ containerEl: root }, root)).toBeNull();
		expect(readViewTurn({ containerEl: root, viewer: {} }, root)).toBeNull();
		expect(readViewTurn({ containerEl: root, viewer: { child: null } }, root)).toBeNull();
		// The app object alone, without its page viewer.
		expect(readViewTurn({ containerEl: root, viewer: { child: { pdfViewer: { pagesRotation: 90 } } } }, root)).toBeNull();
	});

	it("answers null when a read throws", () => {
		const v = { containerEl: root, viewer: { get child(): unknown { throw new Error("torn down"); } } };
		expect(readViewTurn(v, root)).toBeNull();
	});

	it("reads live on every call, never a remembered value", () => {
		const pv = { pagesRotation: 0 };
		const v = { containerEl: root, viewer: { child: { pdfViewer: { pdfViewer: pv } } } };
		expect(readViewTurn(v, root)).toBe(0);
		pv.pagesRotation = 90;
		expect(readViewTurn(v, root)).toBe(90);
		pv.pagesRotation = 180;
		expect(readViewTurn(v, root)).toBe(180);
	});
});
