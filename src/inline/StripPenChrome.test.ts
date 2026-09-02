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
 * IT NOW SCANS THE WHOLE SOURCE TREE. It read two named files until 1.4.7,
 * then three; three closed that day's gap and not the SHAPE of it, because a
 * hardcoded list is opt-in and a surface is checked only if somebody
 * remembered to add it. The canvas page view (src/view/HandwritingPageView.ts)
 * was invisible to this guard for its entire life for exactly that reason,
 * and `src/view/PenLabView.ts` - a fourth implementation of the stroke
 * pipeline (1.4.7-design.md C8) - was invisible to it the day the list grew
 * to three. So the default is inverted: every source file is checked, and a
 * file is skipped only by appearing on a NAMED ALLOWLIST below with a reason.
 * A file that must be exempted announces itself; a file nobody remembered is
 * caught rather than silently skipped, and surface number five is caught on
 * the day it is written rather than the day someone recalls the guard exists.
 *
 * What the inversion costs, stated rather than discovered: `.focus(` is an
 * ordinary DOM call, so the allowlist for it carries four entries that have
 * nothing to do with pen chrome (a modal field, a dialog button, a text-box
 * editor, and the note's own shared claim helper). Each names why it is not
 * the bug shape. A new modal that focuses a button will fail this test until
 * someone writes that line - which is the trade the inversion is: a small
 * standing tax in exchange for never again being blind to a surface.
 *
 * The per-surface assertions BELOW THE SCAN are kept, not folded into it, and
 * deliberately. They are the historical record of which surface had which bug,
 * they say which surfaces each claim is about and why, and - the load-bearing
 * reason - the allowlist is a hole: naming the three known surfaces separately
 * means an allowlist entry added for one of them cannot quietly void the
 * assertion that was written about it. They read the same file text the scan
 * does, through `src()`, so a rename fails loudly instead of silently
 * removing a check.
 *
 * What this file is NOT is a claim that every surface is a copy of every
 * other, so not every assertion below applies to all of them; each one names
 * the surfaces it is about, and why.
 *
 * This test reads source files as TEXT rather than exercising their
 * behaviour, which is unusual - but the thing worth pinning is not what a
 * surface does, it is WHERE the decision lives. Every surface still behaves
 * identically if a future edit re-inlines a raw `setInking(true)` at a new
 * call site; only a source scan notices that the fan-out grew a second place
 * instead of staying at one. `stripPenDown`/`stripPenUp`/`stripPenFocus`
 * (StripPenChrome.ts) are that one place, and the sweep fails on any
 * `setInking(`, `closeInkSliders(` or `.focus(` in ANY non-test .ts under src
 * beyond what the named allowlist below permits that file - three needles
 * across the whole tree, not two methods in two named files.
 *
 * `closeInkSliders(` has one legitimate direct call left, in InkOverlay's
 * file-switch reset ("a fresh note starts reading, so the strip starts as
 * the pill") - that is a document-switch concern, not pen-gesture chrome,
 * and routing it through `stripPenDown` would wrongly mark a freshly
 * opened note as mid-stroke. It is named and counted explicitly below so a
 * SECOND direct call anywhere still fails the test.
 *
 * Read via vite/vitest's `?raw` (raw-imports.d.ts, already used by
 * GuardStyle.test.ts for the same kind of source-text assertion) rather than
 * `fs.readFileSync`: this repo has no `@types/node`, so a raw node:fs import
 * fails `tsc -noEmit` outright - `?raw` gets the same file text without it.
 * `import.meta.glob` is the repo-wide form of the same thing, and is what
 * makes the scan opt-out instead of opt-in.
 */

import { describe, expect, it } from "vitest";

/**
 * Every `.ts` under src, as text. Keys are root-absolute with forward slashes
 * ("/src/inline/InkOverlay.ts") on Windows too, and the text keeps the tree's
 * CRLF line endings - both matter to the assertions below.
 *
 * Verified against the installed vite (8.2.1) / vitest (4.1.11): the option is
 * `query: "?raw"` with `import: "default"`. The older `as: "raw"` spelling was
 * removed in vite 6 and would not work here.
 *
 * The pattern is deliberately the widest one that exists - every `.ts` under
 * src, recursively, with no exclusion in the glob itself - so that what gets
 * skipped is decided by readable code below rather than by a character in a
 * glob string that nobody re-reads. It costs the text of the test files,
 * which is a few hundred KB of string in a run that already parses them.
 */
const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

/**
 * The two things dropped before scanning, each for a stated reason:
 *
 * - `*.test.ts`: a test is not a surface. Tests quote these calls in comments
 *   (this file names all three needles many times over) and drive stubs that
 *   define them, so scanning tests would make every assertion below fail on
 *   itself. Coverage of test files is a separate question and not this one.
 * - `*.d.ts`: ambient declarations. No call sites, by construction.
 *
 * Nothing else is dropped. In particular src/main.ts, the diagnostics views,
 * the persistence layer and PenLabView are all scanned like anything else.
 */
function isScannedSource(path: string): boolean {
	return !path.endsWith(".test.ts") && !path.endsWith(".d.ts");
}

const SOURCES: ReadonlyArray<readonly [string, string]> = Object.entries(ALL_TS)
	.filter(([path]) => isScannedSource(path))
	.sort(([a], [b]) => a.localeCompare(b));

const SOURCE_TEXT = new Map(SOURCES);

/**
 * A named file's text, from the same scan the sweeps use. Throws rather than
 * returning "" if the path is gone, so renaming a surface fails the assertion
 * that was written about it instead of passing it vacuously.
 */
function src(path: string): string {
	const text = SOURCE_TEXT.get(path);
	if (text === undefined) throw new Error(`not in the source scan: ${path}`);
	return text;
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/**
 * An allowlist entry. `max` is the number of occurrences this file is allowed
 * - exact, so a SECOND direct call in a file allowed one still fails - and
 * `why` is why. `ANY` is for the files that OWN the call: bounding those would
 * assert that the shared module may not grow another wrapper, which is the
 * opposite of what this guard wants.
 */
type Exemption = { readonly max: number; readonly why: string };
const ANY = Number.POSITIVE_INFINITY;

const SET_INKING_ALLOWED: Readonly<Record<string, Exemption>> = {
	"/src/inline/MobileTools.ts": {
		max: ANY,
		why: "declares setInking; the strip is the thing being driven, not a caller of it",
	},
	"/src/inline/StripPenChrome.ts": {
		max: ANY,
		why: "the one shared place, by definition - stripPenDown/stripPenUp are the wrappers this guard exists to funnel every surface through",
	},
};

const CLOSE_INK_SLIDERS_ALLOWED: Readonly<Record<string, Exemption>> = {
	"/src/inline/MobileTools.ts": {
		max: ANY,
		why: "declares closeInkSliders and closes its own pops from inside; WHICH pops close is this file's decision to make",
	},
	"/src/inline/StripPenChrome.ts": {
		max: ANY,
		why: "the one shared place, as above",
	},
	"/src/inline/InkOverlay.ts": {
		max: 1,
		why: "the file-switch reset, and ONE of it: a fresh note starts reading, so the strip starts as the pill. A document switch is not pen-gesture chrome, and routing it through stripPenDown would wrongly mark a freshly opened note as mid-stroke. The comment stating that is pinned by its own test below, so deleting the reason fails as surely as adding a second call does",
	},
};

const FOCUS_ALLOWED: Readonly<Record<string, Exemption>> = {
	"/src/inline/StripPenChrome.ts": {
		max: ANY,
		why: "stripPenFocus, the shared keyboard claim for a non-editor ink surface - the pdf half of the pair the note gets from InlineFocus",
	},
	"/src/inline/InlineFocus.ts": {
		max: 1,
		why: "focusClaimedPenEditor, the note half of the same pair: one module, one call, both note paths route through it. This is a shared claim helper, not a hand-rolled one - the thing this assertion wants surfaces to call",
	},
	"/src/view/HandwritingPageView.ts": {
		max: 1,
		why: "the mouse-tap caret placement, exempt for the four reasons its own test below spells out and pins by comment. Not a claimed pen gesture and nothing stripped its native focus",
	},
	"/src/diag/DiagnosticTextModal.ts": {
		max: 1,
		why: "an Obsidian Modal focusing its own text field on open (desktop only, deliberately not on iOS). A modal is not an ink surface: no pen gesture, no PointerRouter, nothing suppressed the native focus this restores",
	},
	"/src/main.ts": {
		max: 1,
		why: "the delete-all-ink confirm dialog focusing its Cancel button so Enter takes the safe branch. A dialog button, not a surface reclaiming the keyboard after a gesture",
	},
	"/src/objects/TextLayer.ts": {
		max: 1,
		why: "the text box editor taking the caret when a box opens for editing - the user asked to type, which is the ordinary reason to call focus and the opposite of the pen-gesture case",
	},
};

/**
 * The sweep itself: every scanned file that uses `needle` more than its
 * allowlist entry permits, as a readable line. Returning strings rather than
 * asserting per file is what makes the failure say WHICH file and HOW MANY in
 * one diff, and what tells whoever hits it that the fix is either to route the
 * call through StripPenChrome or to add a line here saying why not.
 */
function overAllowance(needle: string, allowed: Readonly<Record<string, Exemption>>): string[] {
	const over: string[] = [];
	for (const [path, text] of SOURCES) {
		const count = occurrences(text, needle);
		if (count === 0) continue;
		const max = allowed[path]?.max ?? 0;
		if (count > max) over.push(`${path}: ${count}x ${needle} (allowed ${max})`);
	}
	return over;
}

describe("strip pen chrome — one shared place, not two", () => {
	it("the scan actually reads the source tree", () => {
		// P3, the harness that cannot fail: every sweep below is an assertion
		// that a list is EMPTY, so a glob that silently matched nothing would
		// pass all of them and look like a clean tree. The tree is ~112 source
		// files; a hundred is a floor that catches a broken glob without
		// failing every time a file is added or removed.
		expect(SOURCES.length).toBeGreaterThan(100);
		// All four implementations of the stroke pipeline (1.4.7-design.md P1
		// and C8), named so that the scan losing one is a failure rather than
		// a quieter test run. PenLabView is here because it is the file that
		// motivated the inversion: it is a fourth ink surface, it was outside
		// the three-file list, and it is inside the scan now. It needs no
		// exemption today - it contains none of the three needles - and that
		// is a fact this test re-checks on every run rather than a claim.
		const paths = SOURCES.map(([path]) => path);
		expect(paths).toContain("/src/inline/InkOverlay.ts");
		expect(paths).toContain("/src/pdf/PdfInkController.ts");
		expect(paths).toContain("/src/view/HandwritingPageView.ts");
		expect(paths).toContain("/src/view/PenLabView.ts");
		// And the drop rule dropped something: no test files, no declarations.
		expect(paths.filter((p) => p.endsWith(".test.ts"))).toEqual([]);
		expect(Object.keys(ALL_TS).length).toBeGreaterThan(SOURCES.length);
	});

	it("every allowlist entry names a file that is still in the tree", () => {
		// An exemption for a file that no longer exists is a stale reason
		// nobody will read again, and worse, it hides that the exemption was
		// never re-examined when the file moved.
		const stale: string[] = [];
		for (const list of [SET_INKING_ALLOWED, CLOSE_INK_SLIDERS_ALLOWED, FOCUS_ALLOWED]) {
			for (const path of Object.keys(list)) {
				if (!SOURCE_TEXT.has(path)) stale.push(path);
			}
		}
		expect(stale).toEqual([]);
	});

	it("no file in the tree calls setInking outside the shared place", () => {
		// Repo-wide, opt-out. The bug this is about: PdfInkController had zero
		// calls to either method before 1.4.7, so the note surface's pen-down
		// chrome simply did not happen over a pdf. Any direct call anywhere -
		// on a surface that exists today or one written next month - either
		// routes through stripPenDown/stripPenUp or earns a line in
		// SET_INKING_ALLOWED saying why it does not.
		expect(overAllowance("setInking(", SET_INKING_ALLOWED)).toEqual([]);
	});

	it("no file in the tree calls closeInkSliders outside the shared place and the named exception", () => {
		expect(overAllowance("closeInkSliders(", CLOSE_INK_SLIDERS_ALLOWED)).toEqual([]);
	});

	it("no file in the tree reclaims the keyboard by hand", () => {
		// The fifth divergence, swept the same way. A claimed pen gesture is
		// cancelled before the browser can focus anything, so every surface
		// that claims one has to put the keyboard back - and the two that do
		// go through a shared helper (`focusClaimedPenEditor` for the note's
		// CodeMirror view, `stripPenFocus` for a pdf's root element). A raw
		// `.focus(` appearing anywhere else is the shape of the bug coming
		// back, which is why the sweep is over the tree and not over the two
		// files that had it.
		//
		// This is the needle that costs something: `.focus(` is ordinary DOM
		// and four of its allowlist entries are not ink surfaces at all. They
		// are named anyway, because a reason on a line is the price of never
		// having to remember to add a file.
		expect(overAllowance(".focus(", FOCUS_ALLOWED)).toEqual([]);
	});

	it("the pdf surface never calls setInking or closeInkSliders directly", () => {
		// This is the actual bug: PdfInkController had zero calls to either
		// before this slice. Any direct call re-introduced here recreates it.
		// Named as well as swept, so that an allowlist entry cannot void it.
		const pdfInkControllerSrc = src("/src/pdf/PdfInkController.ts");
		expect(occurrences(pdfInkControllerSrc, "setInking(")).toBe(0);
		expect(occurrences(pdfInkControllerSrc, "closeInkSliders(")).toBe(0);
	});

	it("the note surface never calls setInking directly", () => {
		expect(occurrences(src("/src/inline/InkOverlay.ts"), "setInking(")).toBe(0);
	});

	it("the note surface's only direct closeInkSliders call is the named file-switch exception", () => {
		const inkOverlaySrc = src("/src/inline/InkOverlay.ts");
		expect(occurrences(inkOverlaySrc, "closeInkSliders(")).toBe(1);
		// \r?\n rather than a literal newline: the tree is CRLF.
		expect(inkOverlaySrc).toMatch(
			/\/\/ A fresh note starts reading, so the strip starts as the pill\.\r?\n\s*this\.mobileTools\?\.closeInkSliders\(\);/
		);
	});

	it("the canvas surface drives no strip chrome directly either", () => {
		// The canvas has no MobileTools at all: its toolbar is a different
		// object, built inline by buildToolbar and pinned top-left
		// (1.4.7-design.md 5e-C.5). Zero is therefore both the count it has
		// today and the count it keeps if a strip is ever given to it, since
		// the only supported way to drive one is stripPenDown/stripPenUp.
		// Same assertion the pdf gets, for the same reason.
		const pageViewSrc = src("/src/view/HandwritingPageView.ts");
		expect(occurrences(pageViewSrc, "setInking(")).toBe(0);
		expect(occurrences(pageViewSrc, "closeInkSliders(")).toBe(0);
	});

	it("no pen-claimed surface reclaims the keyboard by hand", () => {
		// The fifth divergence. Both PEN-CLAIMED surfaces claim the keyboard
		// after a gesture the router stripped native focus from, and neither
		// does it with a bare `focus()` call: the note through
		// `focusClaimedPenEditor` (InlineFocus.ts, a CodeMirror view), the pdf
		// through `stripPenFocus` here (a root element). A raw `.focus(`
		// reappearing in either file is the shape of the bug coming back.
		expect(occurrences(src("/src/inline/InkOverlay.ts"), ".focus(")).toBe(0);
		expect(occurrences(src("/src/pdf/PdfInkController.ts"), ".focus(")).toBe(0);
		// The canvas is NOT held to zero - the next test says which single
		// call it is allowed, and why. Counted here as well so that a SECOND
		// focus call on that surface fails even if the exemption below is
		// edited to match it.
		expect(occurrences(src("/src/view/HandwritingPageView.ts"), ".focus(")).toBe(1);
	});

	it("the canvas surface's only focus call is the named caret exception", () => {
		// A scoped allowance, not a hole: the count above is exact, and the
		// comment stating the reason is matched here, so deleting the reason
		// fails this test just as adding a second call fails that one.
		//
		// Why it is exempt rather than routed through `stripPenFocus`: that
		// call is on the MOUSE tap path. `onTap` reaches `setCaret` only for
		// source === "mouse" - touch returns into `createBox`, and pen contact
		// goes to `penDown`, which CLEARS the caret - so no claimed pen
		// gesture is involved and nothing stripped its native focus
		// (`PointerRouter.mouseDown` preventDefaults the middle-button and
		// space pans only). Its root also carries tabIndex 0, the opposite of
		// the tabindex="-1" `armStripPenFocus` exists to set, because a whole
		// view is a tab stop where an in-editor overlay must not be. And
		// `stripPenFocus` declines whenever focus is already inside the root,
		// which is exactly the state after a click on this view's own in-root
		// toolbar: routing this call through it would place a caret and leave
		// the keyboard on a button.
		// `\s*` rather than the `\r?\n\s*` the note exception above uses:
		// it spans the CRLF and the indent in one class, and still lets
		// nothing but whitespace sit between the comment and the call.
		expect(src("/src/view/HandwritingPageView.ts")).toMatch(
			/\/\/ StripPenChrome\.test\.ts pins this exemption by name\.\s*this\.rootEl\.focus\(\);/
		);
	});

	it("both strip-driving surfaces import the shared pair", () => {
		// Two, not three, and deliberately: `stripPenDown`/`stripPenUp` take a
		// MobileTools and the canvas has none to hand them (5e-C.5). Requiring
		// the import there would assert something that is not true of that
		// surface, which is worse than no guard; the canvas is held to the
		// zero-direct-calls rule above instead. This one stays named rather
		// than swept for the same reason: it asserts a PRESENCE, and no scan
		// can demand every file in the tree import a module.
		expect(src("/src/inline/InkOverlay.ts")).toContain('from "./StripPenChrome"');
		expect(src("/src/pdf/PdfInkController.ts")).toContain('from "../inline/StripPenChrome"');
	});

	it("the pdf surface takes its focus claim from the shared file", () => {
		const pdfInkControllerSrc = src("/src/pdf/PdfInkController.ts");
		expect(pdfInkControllerSrc).toContain("stripPenFocus(this.root)");
		expect(pdfInkControllerSrc).toContain("armStripPenFocus(this.root)");
	});
});
