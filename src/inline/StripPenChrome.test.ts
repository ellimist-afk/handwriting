/**
 * A grep would have caught every one of the five times this release that a
 * strip fix landed on the note surface (InkOverlay.ts) and never reached
 * the pdf surface (PdfInkController.ts): the pen reticle, the selection
 * commands, the strip dispatch, the pen-down chrome - the pdf's `penDown`
 * called neither `setInking` nor `closeInkSliders` at all, so the eraser's
 * pop and the strip itself sat over the ink being erased - and this slice's
 * bug, keyboard focus: the note has called `focusClaimedPenEditor` since a
 * claimed pen first started cancelling the mousedown that focuses a pane,
 * and the pdf file contained no `focus()` call whatsoever, so Delete over a
 * pdf lasso went to whatever had focus instead.
 *
 * This test reads both source files as TEXT rather than exercising their
 * behaviour, which is unusual - but the thing worth pinning is not what
 * either surface does, it is WHERE the decision lives. Both surfaces still
 * behave identically if a future edit re-inlines a raw `setInking(true)` at
 * a new call site; only a source scan notices that the fan-out grew a
 * second place instead of staying at one. `stripPenDown`/`stripPenUp`
 * (StripPenChrome.ts) are that one place; this asserts nothing else calls
 * the two methods they wrap.
 *
 * `closeInkSliders(` has one legitimate direct call left, in InkOverlay's
 * file-switch reset ("a fresh note starts reading, so the strip starts as
 * the pill") - that is a document-switch concern, not pen-gesture chrome,
 * and routing it through `stripPenDown` would wrongly mark a freshly
 * opened note as mid-stroke. It is named and counted explicitly below so a
 * SECOND direct call anywhere still fails the test.
 *
 * Read via vite/vitest's `?raw` import (raw-imports.d.ts, already used by
 * GuardStyle.test.ts for the same kind of source-text assertion) rather
 * than `fs.readFileSync`: this repo has no `@types/node`, so a raw node:fs
 * import fails `tsc -noEmit` outright - `?raw` gets the same file text
 * without it.
 */

import { describe, expect, it } from "vitest";
import inkOverlaySrc from "./InkOverlay.ts?raw";
import pdfInkControllerSrc from "../pdf/PdfInkController.ts?raw";

function occurrences(src: string, needle: string): number {
	return src.split(needle).length - 1;
}

describe("strip pen chrome — one shared place, not two", () => {
	it("the pdf surface never calls setInking or closeInkSliders directly", () => {
		// This is the actual bug: PdfInkController had zero calls to either
		// before this slice. Any direct call re-introduced here recreates it.
		expect(occurrences(pdfInkControllerSrc, "setInking(")).toBe(0);
		expect(occurrences(pdfInkControllerSrc, "closeInkSliders(")).toBe(0);
	});

	it("the note surface never calls setInking directly", () => {
		expect(occurrences(inkOverlaySrc, "setInking(")).toBe(0);
	});

	it("the note surface's only direct closeInkSliders call is the named file-switch exception", () => {
		expect(occurrences(inkOverlaySrc, "closeInkSliders(")).toBe(1);
		// \r?\n rather than a literal newline: the tree is CRLF.
		expect(inkOverlaySrc).toMatch(
			/\/\/ A fresh note starts reading, so the strip starts as the pill\.\r?\n\s*this\.mobileTools\?\.closeInkSliders\(\);/
		);
	});

	it("neither surface focuses an element by hand", () => {
		// The fifth divergence. Both surfaces claim the keyboard after a pen
		// gesture the router stripped native focus from, and neither does it
		// with a bare `focus()` call: the note through `focusClaimedPenEditor`
		// (InlineFocus.ts, a CodeMirror view), the pdf through
		// `stripPenFocus` here (a root element). A raw `.focus(` reappearing
		// in either file is the shape of the bug coming back.
		expect(occurrences(inkOverlaySrc, ".focus(")).toBe(0);
		expect(occurrences(pdfInkControllerSrc, ".focus(")).toBe(0);
	});

	it("both surfaces import the shared pair", () => {
		expect(inkOverlaySrc).toContain('from "./StripPenChrome"');
		expect(pdfInkControllerSrc).toContain('from "../inline/StripPenChrome"');
	});

	it("the pdf surface takes its focus claim from the shared file", () => {
		expect(pdfInkControllerSrc).toContain("stripPenFocus(this.root)");
		expect(pdfInkControllerSrc).toContain("armStripPenFocus(this.root)");
	});
});
