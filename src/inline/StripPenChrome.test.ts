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
 * does, through `code()`/`raw()`, so a rename fails loudly instead of silently
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
 * THE SIXTH DIVERGENCE needed a different sweep, and saying why is the point.
 * `penToolsVisible` (PenToolsMode.ts) is the whole rule for whether a strip
 * exists at all, and it is pure, factored and tested - and it had exactly ONE
 * caller in the tree, on the note surface. `PdfInkController.ensureTools`
 * built a MobileTools on the first pen contact and asked nothing, so "Pen
 * toolbar → Hide" hid the strip on notes and left it floating over every PDF
 * (alan, 2026-09-02). Counting `penToolsVisible(` the way the three needles
 * above are counted would assert the OPPOSITE of what is wanted: an
 * over-allowance sweep forbids a call, and here the call is the fix. So this
 * needle is a PAIRING - a file that contains `new MobileTools(` must also
 * contain `penToolsVisible(` - and it is still opt-out over the whole tree,
 * still allowlisted by name, and still fails on the file rather than on a
 * count. `new MobileTools(` is the trigger because constructing the strip is
 * the act that needs a reason; the canvas view builds a different toolbar
 * object entirely (5e-C.5) and is correctly not caught by it, which is the
 * same reason the import assertion at the bottom of this file covers two
 * surfaces rather than three.
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
 *
 * IT NOW MATCHES CODE, NOT PROSE, AND ONLY WHERE IT MEANS TO. Every needle
 * above used to be counted in RAW source, so a comment counted as an
 * implementation. Both directions of that were real and both happened here:
 *
 *   - toward a false ALARM: a doc comment in `InkSurfaces.ts` spelled a strip
 *     construction while EXPLAINING it, and this file's pairing sweep filed
 *     the registry as a surface that mounts one. Loud, and it cost an hour.
 *   - toward a false ALL-CLEAR, which is the expensive one: `penToolsVisible(`
 *     is satisfied by PRESENCE, so a file that really did mount a strip and
 *     really did not ask the rule passed the pairing on a comment that merely
 *     mentioned the symbol. Demonstrated on this branch by deleting the pdf
 *     surface's real call and leaving such a comment: all 16 tests here
 *     passed. That is the same shape that once passed 89.
 *
 * The needles are matched against `codeOnly` (src/CodeOnly.ts), the same
 * function `InkSurfaceRules.test.ts` uses, imported rather than copied - two
 * strippers in two sibling guards is precisely the divergence these guards
 * exist to catch, and the four fixture tests that pin it shut live over there
 * and now stand over this file too.
 *
 * BLANKING IS APPLIED PER ASSERTION, NOT PER FILE, AND THAT IS LOAD-BEARING.
 * Two assertions below deliberately read a COMMENT: the note's file-switch
 * exception and the canvas's caret exemption each pin the sentence stating
 * WHY, so that deleting the reason fails as surely as adding a second call
 * does. Those keep reading `raw()`. Everything asking "is this symbol
 * implemented" reads `code()`. Blanking the whole file would have voided two
 * real assertions while looking like a safety improvement.
 *
 * Note the direction of the change for the over-allowance sweeps: counting
 * code rather than raw text can only LOWER a count, so no real call escapes
 * that was caught before - what stops being caught is a mention in a comment,
 * which was never a call.
 */

import { describe, expect, it } from "vitest";
import { codeOnly } from "../CodeOnly";

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
 * The same files with comments blanked, computed once. Length and line count
 * survive, so an offset into one is an offset into the other.
 */
const CODE_TEXT = new Map(SOURCES.map(([path, text]) => [path, codeOnly(text)] as const));

/**
 * A named file's RAW text, from the same scan the sweeps use. Throws rather
 * than returning "" if the path is gone, so renaming a surface fails the
 * assertion that was written about it instead of passing it vacuously.
 *
 * Only the two assertions that pin a documented REASON use this. An assertion
 * about whether a symbol is implemented must not, or a comment satisfies it.
 */
function raw(path: string): string {
	const text = SOURCE_TEXT.get(path);
	if (text === undefined) throw new Error(`not in the source scan: ${path}`);
	return text;
}

/** The same file with comments blanked. What every needle is matched against. */
function code(path: string): string {
	const text = CODE_TEXT.get(path);
	if (text === undefined) throw new Error(`not in the source scan: ${path}`);
	return text;
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/**
 * The two halves of the pairing needle, as pure predicates over source text so
 * that the fixtures at the bottom of this file can attack them directly with a
 * string instead of having to plant a comment in a real surface.
 *
 * `new MobileTools(` is the trigger - constructing the strip is the act that
 * needs a reason - and `penToolsVisible(` is what satisfies it.
 */
function mountsAStrip(text: string): boolean {
	return occurrences(codeOnly(text), "new MobileTools(") > 0;
}

function asksTheVisibilityRule(text: string): boolean {
	return occurrences(codeOnly(text), "penToolsVisible(") > 0;
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
		max: 2,
		why: "focusClaimedPenEditor, the note half of the same pair: one module, one call, both note paths route through it. This is a shared claim helper, not a hand-rolled one - the thing this assertion wants surfaces to call. The SECOND is setKeyboardFocus, the pen-off toggle's opposite request (PenInk.ts): turning the pen off focuses the editor inside the strip's click so the soft keyboard rises, which is the feature. Same module on purpose - the sweep exists so a surface cannot hand-roll a focus rule, and InkOverlay.ts calling contentDOM.focus() itself is exactly the shape it forbids",
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
 * The pairing needle's allowlist, and it is a different shape on purpose:
 * there is no count to allow, only a file excused from asking the rule at
 * all. `why` carries the same weight it does above.
 *
 * EMPTY, today. An entry here is a surface that mounts a floating strip
 * unconditionally, which is the exact bug this needle exists for - so it
 * needs a better reason than any entry above, not an equal one. "It is not an
 * ink surface" will not do: a `new MobileTools(` IS the ink chrome.
 */
type StripMount = { readonly why: string };
const PEN_TOOLS_RULE_ALLOWED: Readonly<Record<string, StripMount>> = {};

/** Files that construct a strip, in scan order. Prose about one does not count. */
function stripMounters(): string[] {
	return SOURCES.filter(([, text]) => mountsAStrip(text)).map(([path]) => path);
}

/**
 * Every scanned file that mounts a strip and never consults the rule that
 * says whether it should have one. The dual of `overAllowance` below: that
 * one fails on a call, this one fails on a MISSING call, because the two
 * failures are opposite shapes of the same divergence.
 *
 * This is the assertion the comment hole actually cost something on. It is
 * satisfied by PRESENCE, so before the needles were blanked a file that
 * mounted a strip and never asked the rule passed on a comment that spelled
 * the symbol. The fixtures at the bottom of this file attack both halves.
 */
function mountsWithoutTheRule(): string[] {
	const missing: string[] = [];
	for (const path of stripMounters()) {
		if (asksTheVisibilityRule(SOURCE_TEXT.get(path) ?? "")) continue;
		if (PEN_TOOLS_RULE_ALLOWED[path]) continue;
		missing.push(`${path}: new MobileTools( with no penToolsVisible( anywhere in the file`);
	}
	return missing;
}

/**
 * The sweep itself: every scanned file that uses `needle` more than its
 * allowlist entry permits, as a readable line. Returning strings rather than
 * asserting per file is what makes the failure say WHICH file and HOW MANY in
 * one diff, and what tells whoever hits it that the fix is either to route the
 * call through StripPenChrome or to add a line here saying why not.
 */
function overAllowance(needle: string, allowed: Readonly<Record<string, Exemption>>): string[] {
	const over: string[] = [];
	for (const [path] of SOURCES) {
		const count = occurrences(code(path), needle);
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
		for (const list of [
			SET_INKING_ALLOWED,
			CLOSE_INK_SLIDERS_ALLOWED,
			FOCUS_ALLOWED,
			PEN_TOOLS_RULE_ALLOWED,
		]) {
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

	it("no file in the tree mounts a strip without consulting the visibility rule", () => {
		// The sixth divergence. Whether a floating strip exists at all is
		// `penToolsVisible` (PenToolsMode.ts) and nothing else - "show",
		// "hide", and "auto" meaning mobile-or-once-a-pen-was-seen. The rule
		// was pure, factored and tested, and the pdf surface simply never
		// called it: `ensureTools` built one on the first pen contact, so
		// "Pen toolbar → Hide" worked on notes and did nothing over a PDF.
		//
		// Opt-out over the whole tree like every sweep above, and a PAIRING
		// rather than a count because the failure shape is inverted: what
		// fails here is a file that mounts a strip and does NOT ask.
		expect(mountsWithoutTheRule()).toEqual([]);
	});

	it("the strip-mounting trigger actually matches the surfaces that mount one", () => {
		// P3 again, and this needle needs it more than the others do: the
		// sweep above asserts a list is empty, so a trigger needle that
		// matched nothing would pass while checking nothing at all. Named
		// with `toContain` rather than pinned as an exact list - a third
		// surface that mounts a strip should fail the SWEEP, on its own
		// missing call, not this harness check.
		const mounters = stripMounters();
		expect(mounters).toContain("/src/inline/InkOverlay.ts");
		expect(mounters).toContain("/src/pdf/PdfInkController.ts");
	});

	it("both strip-mounting surfaces ask the same rule, once each", () => {
		// Named as well as swept, for the reason every assertion in this
		// block is: an allowlist entry added for either file cannot void the
		// claim written about it. Exactly one call each, so a second gate on
		// either surface - the beginning of a private answer to a shared
		// question - fails here.
		expect(occurrences(code("/src/inline/InkOverlay.ts"), "penToolsVisible(")).toBe(1);
		expect(occurrences(code("/src/pdf/PdfInkController.ts"), "penToolsVisible(")).toBe(1);
		expect(code("/src/pdf/PdfInkController.ts")).toContain('from "../inline/PenToolsMode"');
	});

	it("the pdf surface never calls setInking or closeInkSliders directly", () => {
		// This is the actual bug: PdfInkController had zero calls to either
		// before this slice. Any direct call re-introduced here recreates it.
		// Named as well as swept, so that an allowlist entry cannot void it.
		const pdfInkControllerSrc = code("/src/pdf/PdfInkController.ts");
		expect(occurrences(pdfInkControllerSrc, "setInking(")).toBe(0);
		expect(occurrences(pdfInkControllerSrc, "closeInkSliders(")).toBe(0);
	});

	it("the note surface never calls setInking directly", () => {
		expect(occurrences(code("/src/inline/InkOverlay.ts"), "setInking(")).toBe(0);
	});

	it("the note surface's only direct closeInkSliders call is the named file-switch exception", () => {
		// The count reads CODE - one real call, and a comment elsewhere in the
		// file mentioning the symbol is not a second one. The regex below reads
		// RAW, because what it pins is the COMMENT: the sentence saying why this
		// one call is not routed through stripPenDown. Deleting the reason has to
		// fail as surely as adding a call does, and blanking comments here would
		// have quietly voided that. The pair is what makes it sound - the count
		// proves a real call exists, the regex proves the reason sits against it.
		expect(occurrences(code("/src/inline/InkOverlay.ts"), "closeInkSliders(")).toBe(1);
		// \r?\n rather than a literal newline: the tree is CRLF.
		expect(raw("/src/inline/InkOverlay.ts")).toMatch(
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
		const pageViewSrc = code("/src/view/HandwritingPageView.ts");
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
		expect(occurrences(code("/src/inline/InkOverlay.ts"), ".focus(")).toBe(0);
		expect(occurrences(code("/src/pdf/PdfInkController.ts"), ".focus(")).toBe(0);
		// The canvas is NOT held to zero - the next test says which single
		// call it is allowed, and why. Counted here as well so that a SECOND
		// focus call on that surface fails even if the exemption below is
		// edited to match it.
		expect(occurrences(code("/src/view/HandwritingPageView.ts"), ".focus(")).toBe(1);
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
		// RAW, and deliberately: this assertion's subject IS the comment. The
		// exact count in the test above reads code, so the two together say
		// "one real call, and the reason for it written next to it".
		expect(raw("/src/view/HandwritingPageView.ts")).toMatch(
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
		expect(code("/src/inline/InkOverlay.ts")).toContain('from "./StripPenChrome"');
		expect(code("/src/pdf/PdfInkController.ts")).toContain('from "../inline/StripPenChrome"');
	});

	it("the pdf surface takes its focus claim from the shared file", () => {
		const pdfInkControllerSrc = code("/src/pdf/PdfInkController.ts");
		expect(pdfInkControllerSrc).toContain("stripPenFocus(this.root)");
		expect(pdfInkControllerSrc).toContain("armStripPenFocus(this.root)");
	});
});

describe("strip pen chrome — a comment is not an implementation", () => {
	// Every fixture here would have PASSED against raw source, which is the
	// only reason any of them is worth a line. `InkSurfaceRules.test.ts` pins
	// `codeOnly` itself; these pin THIS FILE'S needles going through it, which
	// is a different claim - the stripper was already correct over there while
	// this guard scanned raw text beside it for its whole life.

	it("the blanking is actually happening on the real tree", () => {
		// P3, the harness that cannot fail. If `code()` returned raw text every
		// fixture below would still pass on the strings, while the sweeps above
		// carried on reading prose. This file is doc-heavy by design, so its
		// own surfaces are a fair witness: blanking must remove characters and
		// must not remove lines.
		const rawText = raw("/src/inline/InkOverlay.ts");
		const codeText = code("/src/inline/InkOverlay.ts");
		expect(codeText).not.toEqual(rawText);
		expect(codeText.replace(/ /g, "").length).toBeLessThan(rawText.replace(/ /g, "").length);
		expect(codeText).toHaveLength(rawText.length);
		expect(codeText.split("\n")).toHaveLength(rawText.split("\n").length);
	});

	it("a comment mentioning the visibility rule does not satisfy the pairing", () => {
		// THE EXPENSIVE DIRECTION, and the one that was open here. The pairing
		// is satisfied by presence, so a surface that really mounts a strip and
		// really never asks could pass on prose alone. Demonstrated on the tree
		// before this changed: the pdf surface's real call was replaced and a
		// comment spelling the symbol left behind, and all 16 tests passed.
		const prose = [
			"const tools = new MobileTools(this.host);",
			"// whether it should exist at all is penToolsVisible( in PenToolsMode.ts",
		].join("\n");
		expect(mountsAStrip(prose)).toBe(true);
		expect(asksTheVisibilityRule(prose)).toBe(false);

		const blockComment = [
			"const tools = new MobileTools(this.host);",
			"/** the rule is penToolsVisible(mode, mobile, seen) - asked elsewhere */",
		].join("\n");
		expect(asksTheVisibilityRule(blockComment)).toBe(false);
	});

	it("a real call still satisfies it", () => {
		// The other half of the same fixture, and not decoration: a `codeOnly`
		// that blanked everything would pass the test above while making the
		// pairing sweep fail on both real surfaces - loudly, but for the wrong
		// reason. Pinned so the fix cannot be over-applied either.
		const real = [
			"const tools = new MobileTools(this.host);",
			"if (!penToolsVisible(getPenToolsMode(), mobile, seen)) return;",
		].join("\n");
		expect(mountsAStrip(real)).toBe(true);
		expect(asksTheVisibilityRule(real)).toBe(true);
	});

	it("a comment spelling a strip construction does not make a file a mounter", () => {
		// The loud direction, and it is not hypothetical: a doc comment in
		// InkSurfaces.ts spelled this construction while EXPLAINING it, and the
		// pairing sweep filed the registry - a DOM-free description of the tree
		// that mounts nothing - as a surface that mounts a strip. The workaround
		// was to write the symbol in prose without its paren. That workaround is
		// no longer load-bearing.
		const registryProse = "/** derived from the new MobileTools( construction site */";
		expect(mountsAStrip(registryProse)).toBe(false);
		expect(mountsAStrip("// see new MobileTools( in InkOverlay")).toBe(false);
	});

	it("a needle inside a comment does not count against an allowance", () => {
		// The over-allowance sweeps count `occurrences(code(path), needle)`;
		// this is that expression. Counting code can only LOWER a count against
		// raw text, so nothing real escapes - what stops being reported is a
		// file whose only mention was somebody explaining the rule, which is
		// the false-alarm half of the same fault.
		const explained = [
			"// routed through stripPenDown rather than calling setInking( here",
			"/* and closeInkSliders( is the strip's own business */",
			"this.el.querySelector('x')?.scrollIntoView();",
		].join("\n");
		expect(occurrences(codeOnly(explained), "setInking(")).toBe(0);
		expect(occurrences(codeOnly(explained), "closeInkSliders(")).toBe(0);
		// and a real one is still counted
		expect(occurrences(codeOnly("this.tools?.setInking(true);"), "setInking(")).toBe(1);
	});
});
