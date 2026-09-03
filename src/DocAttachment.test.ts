/**
 * A `/** ... *\/` block documents the symbol IMMEDIATELY below it. Insert a
 * new method between an existing doc and the symbol it was written for and
 * the doc silently re-attaches to the newcomer: the original symbol is left
 * undocumented, and the stranded block now makes false claims about whatever
 * happens to follow it. Nothing warns. `tsc` does not care, the bundle is
 * byte-identical, and the file still reads as though every symbol is
 * documented - which is the whole problem, because it reads that way to the
 * next person too.
 *
 * WHAT THIS GUARD BEATS, stated so the cost of it is judged against
 * something real. Two instances shipped in this release alone:
 *
 * - `8a518de` (main.ts): a new method landed between `armTipModeInput` and
 *   its doc, so an eight-line rationale ending "Returns whether it turned
 *   mouse ink on" ended up over a method returning `void`. Caught by eye,
 *   late, and only because the return type contradicted the last sentence.
 *
 * - `07fe518` (PdfInkController.ts) is the one that matters. It edited the
 *   CONTENT of the block opening "Draw the newest segment onto the page's
 *   wet overlay" to make its claims true, and its commit body argues the
 *   correction carefully. TWO SESSIONS REVIEWED THAT COMMIT AND BOTH
 *   CONFIRMED IT. Neither noticed the block was not attached to the symbol
 *   it describes: it has sat above `scaleFor` since `e859d02`, and its real
 *   subject is `drawWet` (`579b678` attached it there; `e859d02` inserted
 *   `cameraFor` under it and wrote `drawWet` a fresh one-liner, so the
 *   function now has two docs in two places and neither reader saw it).
 *   Everyone involved had read that file and written a design document
 *   about that exact function. Checking whether a comment is TRUE and
 *   checking what it is ATTACHED TO are different acts, and a deliberate
 *   adversarial review did the first and not the second. That is not a
 *   review anyone will reliably do; it is a scan.
 *
 * THE SHAPE, and why it is exactly this narrow. A doc block whose next
 * non-blank line opens ANOTHER doc block is a doc attached to nothing: two
 * blocks stacked with no symbol between them, so at most one of them can be
 * documenting the code below. It is a purely textual property, it needs no
 * parse, and it has no false-positive story in this tree beyond a doc
 * deliberately split in two - which is itself worth merging, and is why the
 * allowlist below is empty rather than pre-loaded.
 *
 * TAB-INDENTED ONLY, which is the difference between a guard and noise. A
 * file-level header followed by the first symbol's own doc is the normal,
 * correct shape of nearly every file here, and both of those blocks sit at
 * column zero. Requiring at least one leading tab restricts the sweep to
 * CLASS AND INTERFACE MEMBERS, where two stacked blocks are always wrong.
 * Unindented, the same rule reports 39 sites in this tree and is useless;
 * indented it reported 20 at 9c85c4a, every one of them a genuine orphan.
 *
 * EVERY spelling of a block is matched, because the tree uses three and the
 * cheap version of this scan sees one. A regex keyed on a lone `*\/` LINE
 * finds the multi-line form and is blind to both the one-line `/** ... *\/`
 * and the block whose closer carries text ("... and was removed. *\/"). Six
 * of the twenty were one of those two shapes - the dead `layerEl` and
 * `pinchRefFontPx` field docs in InkOverlay, `onPenHover` in the router,
 * `closeInkSliders` and `attachTip` in MobileTools, `saveSettingsNow` in
 * main.ts - so the closer-line regex found 14 and left nearly a third of the
 * defect standing, which is the failure mode of guessing at a comment's
 * shape rather than walking it. This walks it: opener, then the first line
 * carrying a closer, wherever that sits.
 *
 * Read via vite/vitest's `?raw` through `import.meta.glob`
 * (raw-imports.d.ts), the same mechanism StripPenChrome.test.ts uses and for
 * the same two reasons: this repo has no `@types/node`, so a `node:fs`
 * import fails `tsc -noEmit` outright, and a glob makes the scan OPT-OUT.
 * Every source file is checked; a file is skipped only by appearing on a
 * named allowlist with a written reason. A guard that has to be told about
 * each file is a guard that is blind to the file nobody remembered.
 */

import { describe, expect, it } from "vitest";

/**
 * Every `.ts` under src, as text. Keys are root-absolute with forward
 * slashes ("/src/pdf/PdfInkController.ts") on Windows too, and the text
 * keeps the tree's CRLF line endings - the scan below splits on `\r?\n` for
 * that reason.
 */
const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

/**
 * The two things dropped before scanning, each for a stated reason:
 *
 * - `*.test.ts`: a test is not documentation of a symbol. This file alone
 *   contains several deliberately stacked blocks as fixtures, and would fail
 *   on itself.
 * - `*.d.ts`: ambient declarations. raw-imports.d.ts legitimately carries
 *   two adjacent blocks over one `interface ImportMeta`.
 *
 * Nothing else is dropped.
 */
function isScannedSource(path: string): boolean {
	return !path.endsWith(".test.ts") && !path.endsWith(".d.ts");
}

const SOURCES: ReadonlyArray<readonly [string, string]> = Object.entries(ALL_TS)
	.filter(([path]) => isScannedSource(path))
	.sort(([a], [b]) => a.localeCompare(b));

/** At least one tab, then the opener. Column-zero blocks are file headers. */
const MEMBER_DOC_OPEN = /^\t+\/\*\*/;

/**
 * Every orphaned doc block in `text`, as `line: opening sentence`.
 *
 * Walks blocks rather than pattern-matching closers so that both spellings
 * are covered: from an opener, the block ends on the first line containing
 * `*\/` - which is the opening line itself for a one-liner. Whatever follows,
 * blank lines skipped, must be code. If it is another opener, the block that
 * just ended documents nothing.
 */
export function orphanedDocs(text: string): string[] {
	const lines = text.split(/\r?\n/);
	const at = (n: number): string => lines[n] ?? "";
	const found: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const open = at(i);
		if (!MEMBER_DOC_OPEN.test(open)) continue;
		let end = i;
		// A one-liner closes on its own line; look past its `/**` for the `*/`.
		if (!open.slice(open.indexOf("/**") + 3).includes("*/")) {
			end = i + 1;
			while (end < lines.length && !at(end).includes("*/")) end++;
			if (end >= lines.length) break; // unterminated; not this test's business
		}
		let next = end + 1;
		while (next < lines.length && at(next).trim() === "") next++;
		if (next < lines.length && MEMBER_DOC_OPEN.test(at(next))) {
			const head = open.slice(open.indexOf("/**") + 3).trim() || at(i + 1).trim();
			const opener = head
				.replace(/^\*+\s*/, "")
				.replace(/\s*\*\/\s*$/, "")
				.slice(0, 72);
			found.push(`${i + 1}: ${opener}`);
		}
		i = end;
	}
	return found;
}

/**
 * Files allowed to carry a stacked pair, by name, with the reason.
 *
 * DELIBERATELY EMPTY, and the emptiness is the point. Every instance this
 * guard was written for was fixed before it landed, including the two that
 * were genuinely one symbol's doc split across two blocks (`settle` in
 * InlineInkStore, `onPenHover` in InlinePenRouter) - those were MERGED, not
 * exempted, because a split doc is the same reading hazard as a stranded one
 * and merging costs a line. A guard whose first act is to exempt live
 * instances of the defect it was written for teaches that an exemption is
 * the normal way out, and six weeks later nobody can tell a temporary entry
 * from a permanent one. If you are about to add the first entry here, the
 * question to answer in `why` is what the two blocks say that one block
 * cannot.
 */
type Exemption = { readonly why: string };
const STACKED_DOCS_ALLOWED: Readonly<Record<string, Exemption>> = {};

describe("doc comments are attached to the symbol they describe", () => {
	it("the scan actually reads the source tree", () => {
		// P3, the harness that cannot fail: the sweep below asserts a list is
		// EMPTY, so a glob that silently matched nothing would pass and look
		// like a clean tree. The tree is ~112 source files.
		expect(SOURCES.length).toBeGreaterThan(100);
		const paths = SOURCES.map(([path]) => path);
		expect(paths).toContain("/src/pdf/PdfInkController.ts");
		expect(paths).toContain("/src/inline/InkOverlay.ts");
		expect(paths).toContain("/src/main.ts");
		expect(paths.filter((p) => p.endsWith(".test.ts"))).toEqual([]);
		expect(Object.keys(ALL_TS).length).toBeGreaterThan(SOURCES.length);
	});

	it("the detector detects, on both spellings of a block", () => {
		// The other half of P3, and the half a source scan usually skips: a
		// detector that finds nothing because its regex is wrong passes the
		// sweep exactly as a clean tree does. These fixtures are the two real
		// shapes from the tree, so a regex edit that breaks either one fails
		// HERE rather than going quiet.
		const multi = ["\t/**", "\t * stranded", "\t */", "\t/** attached */", "\tband = null;"].join("\n");
		expect(orphanedDocs(multi)).toEqual(["1: stranded"]);
		const oneLiner = ["\t/** stranded */", "\t/**", "\t * attached", "\t */", "\tband = null;"].join("\n");
		expect(orphanedDocs(oneLiner)).toEqual(["1: stranded"]);
		// A blank line between them does not make it not-stacked.
		expect(orphanedDocs(["\t/** stranded */", "", "\t/** attached */", "\tband = null;"].join("\n"))).toEqual([
			"1: stranded",
		]);
		// CRLF, which is what the glob actually hands us.
		expect(orphanedDocs("\t/** stranded */\r\n\t/** attached */\r\n\tband = null;\r\n")).toEqual(["1: stranded"]);
	});

	it("the detector does not flag the ordinary shapes", () => {
		// A file header above the first symbol's own doc is the normal shape
		// of nearly every file here and sits at column zero; flagging it is
		// what makes the unindented version of this rule useless.
		expect(orphanedDocs(["/**", " * file header", " */", "", "/** the class */", "export class X {}"].join("\n"))).toEqual(
			[]
		);
		// One doc, one symbol, at member indent.
		expect(orphanedDocs(["\t/** attached */", "\tband = null;"].join("\n"))).toEqual([]);
		// Two documented members in a row.
		expect(
			orphanedDocs(["\t/** first */", "\ta = 1;", "\t/** second */", "\tb = 2;"].join("\n"))
		).toEqual([]);
		// A doc followed by a plain `//` comment and then its symbol.
		expect(orphanedDocs(["\t/** attached */", "\t// an aside", "\ta = 1;"].join("\n"))).toEqual([]);
	});

	it("every allowlist entry names a file that is still in the tree", () => {
		// Vacuous while the list is empty, and kept anyway: an exemption for a
		// file that has moved is a reason nobody will read again.
		const known = new Set(SOURCES.map(([path]) => path));
		const stale = Object.keys(STACKED_DOCS_ALLOWED).filter((p) => !known.has(p));
		expect(stale).toEqual([]);
	});

	it("the allowlist is empty", () => {
		// Asserted rather than merely true, so that adding the first entry is
		// a deliberate edit to this line and its reason, not a quiet append.
		expect(Object.keys(STACKED_DOCS_ALLOWED)).toEqual([]);
	});

	it("no doc comment in the tree is stranded above another doc comment", () => {
		const stranded: string[] = [];
		for (const [path, text] of SOURCES) {
			if (STACKED_DOCS_ALLOWED[path]) continue;
			for (const hit of orphanedDocs(text)) stranded.push(`${path}:${hit}`);
		}
		// The fix is to move the block onto the symbol it describes - find
		// that symbol, do not guess from what follows the block today - or, if
		// the two blocks really are one symbol's doc split in two, to merge
		// them. If neither, its subject was deleted and so should it be.
		expect(stranded).toEqual([]);
	});
});
