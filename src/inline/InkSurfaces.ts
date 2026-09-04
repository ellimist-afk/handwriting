/**
 * The ink surfaces, named once.
 *
 * There are FIVE places where a pointer becomes a stroke, and this project's
 * most expensive recurring defect - seven times in the 1.4.x cycle - is a
 * ruling that reached one of them and not another. The seventh is the shape of
 * all of them: the router already knew the `pointerType`, already passed it to
 * both surfaces, and each surface then decided independently what to do with
 * it. One decided right and one decided wrong, and the wrong one was invisible
 * for three releases because a comment asserted it was fine.
 *
 * This header said FOUR until 2026-09-03, and that was wrong the whole time.
 * `src/site/DemoInk.ts` ships on the website rather than in the plugin, so it
 * sits outside every plugin test and most greps, but it runs the plugin's real
 * ink path and it built strokes all along. It is the fifth. "Four" was not a
 * miscount so much as a scope the sentence never said out loud, which is how
 * every one of the seven divergences started.
 *
 * A document cannot hold this. The surfaces ground-truth section of
 * `1.4.9-design.md` carries the same table as prose, and prose that is not
 * executed rots exactly the way the two comments that hid the two most
 * expensive bugs of this cycle rotted. So the table lives HERE, in code, and
 * `InkSurfaceRules.test.ts` drives its assertions off this array. Cited by
 * title rather than section number on purpose: the numbering has collided
 * twice from parallel appends, and a number that has moved reads exactly like
 * one that has not.
 *
 * WHAT MAKES THAT MORE THAN A LIST. This array is hand-written, and a
 * hand-written list looks executable because it compiles - compiling is not
 * checking. The header used to claim on its own authority that the array "makes
 * surface number five fail the suite on the day it is written", and it did not:
 * the demo HAD been surface five all along and the suite was green, because
 * nothing compared the array to the tree. The enforcement is now real and it
 * lives in `InkSurfaceRules.test.ts`, in the "derived from the tree, not
 * maintained by hand" block: every file constructing a StrokeBuilder must be a
 * named surface, every named surface must construct one, and `mountsStrip` is
 * derived from the MobileTools construction site rather than believed. That is
 * the same inversion `StripPenChrome.test.ts` made when it stopped reading a
 * hardcoded list of three files, and the same one `CornerSafeArea.test.ts` gets
 * from driving off `TOOLBAR_CORNERS`.
 *
 * WHY THE TWO CONSTRUCTIONS ABOVE ARE NAMED IN PROSE AND NOT SPELLED OUT -
 * AND WHY THAT IS NOW HABIT RATHER THAN NECESSITY. Writing either of them here
 * as the literal `new X(` used to put this file into the guards' own needles.
 * It was not hypothetical: spelling the MobileTools one turned this registry
 * into a strip-mounting surface and failed `StripPenChrome.test.ts`'s pairing
 * sweep, which demands that a file mounting a strip also consult
 * `penToolsVisible`. This file mounts nothing; it is a DOM-free description of
 * the tree.
 *
 * The reason it could happen was worth more than the workaround: that sweep
 * read RAW source, while `InkSurfaceRules.test.ts` blanked comments before
 * matching. Two guards built for one defect class, one of them protected. The
 * expensive direction was the inverse of the failure above and it was open:
 * a comment merely MENTIONING `penToolsVisible(` satisfied the pairing for a
 * file that never called it.
 *
 * CLOSED. Both guards now match against `codeOnly` (src/CodeOnly.ts) - one
 * function, imported by both, with fixtures in `InkSurfaceRules.test.ts`
 * pinning it against returning its input and fixtures in
 * `StripPenChrome.test.ts` pinning this file's own trigger against prose. The
 * prose-only spelling above is kept because it reads better, not because the
 * guard requires it.
 *
 * DOM-free by construction, like `TipMode.ts`, `PenToolsMode.ts` and
 * `ToolbarCorner.ts`: it is a description of the tree, imported by a test and
 * by nothing that runs in the plugin.
 */

export type InkSurfaceId = "note" | "pdf" | "canvas" | "penlab" | "demo";

/**
 * Which pointer router a surface is built on. This is the fault line: `note`
 * and `pdf` share `InlinePenRouter`, which declares EIGHT callbacks and lets
 * each surface answer them independently, so it is the pair that diverges.
 * `canvas` and `penlab` share `PointerRouter` and own their whole surface;
 * `demo` is on neither and wires its own pointer handlers.
 *
 * This said "seven callbacks" and so did INLINE_PEN_CALLBACKS's doc below.
 * Both were wrong: `claimBandContact?` is the eighth. See that array's own
 * comment for why seven is nonetheless the right number to require.
 */
export type InkRouterFamily = "InlinePenRouter" | "PointerRouter" | "none";

export interface InkSurface {
	readonly id: InkSurfaceId;
	/** Root-absolute, forward slashes - the key shape `import.meta.glob` uses. */
	readonly file: string;
	readonly router: InkRouterFamily;
	/**
	 * Can a user get here at all? `penlab` cannot: nothing in the UI opens it.
	 * Its value is that its head and its ribbon are allowed to disagree, which
	 * is what makes it a probe rather than a surface, and it is the reason a
	 * rule may legitimately skip it.
	 */
	readonly userReachable: boolean;
	/** Does this surface construct a `MobileTools` strip? Only note and pdf do. */
	readonly mountsStrip: boolean;
	/**
	 * Does the pen TIP here obey `TipMode` - eraser, lasso, pan, space? The
	 * canvas does not, and not by omission: its own `type Tool` has no `pan`
	 * member at all and it pans by transient gesture instead. A rule about the
	 * tip mode is therefore not missing from the canvas, it is inapplicable.
	 */
	readonly honoursTipMode: boolean;
}

/**
 * Each `file` is where the stroke is built, and for the four router-bearing
 * surfaces it is also where the router is constructed and the callbacks are
 * wired. `demo` has no router, so for it the stroke is the whole of it.
 *
 * The MEMBERSHIP of this array is not a matter of memory or of enumeration by
 * hand: `InkSurfaceRules.test.ts` holds it to the StrokeBuilder construction
 * site in both directions, so a file that grows one and is not listed here
 * fails, and an entry here that builds no stroke fails too. Named rather than
 * spelled for the reason the header gives - a literal `new X(` in this file's
 * prose is a needle in somebody's sweep, and one of the two sweeps reads raw
 * source. The columns are still hand-set
 * and only `mountsStrip` is derived, so treat the rest as claims a reader can
 * check rather than as facts the suite guarantees.
 *
 * `canvas` is PARKED by Alan, twice - see the "Canvas: pan-mode selection
 * clear - FILED, NOT TO BE WORKED" entry in `1.4.9-design.md`'s claims
 * register, and the claim-released note right after it. It is listed because
 * leaving it out is exactly the omission this file exists to make impossible;
 * nothing here asks for behaviour to be added to it.
 */
export const INK_SURFACES: readonly InkSurface[] = [
	{
		id: "note",
		file: "/src/inline/InkOverlay.ts",
		router: "InlinePenRouter",
		userReachable: true,
		mountsStrip: true,
		honoursTipMode: true,
	},
	{
		id: "pdf",
		file: "/src/pdf/PdfInkController.ts",
		router: "InlinePenRouter",
		userReachable: true,
		mountsStrip: true,
		honoursTipMode: true,
	},
	{
		id: "canvas",
		file: "/src/view/HandwritingPageView.ts",
		router: "PointerRouter",
		userReachable: true,
		mountsStrip: false,
		honoursTipMode: false,
	},
	{
		id: "penlab",
		file: "/src/view/PenLabView.ts",
		router: "PointerRouter",
		userReachable: false,
		mountsStrip: false,
		honoursTipMode: false,
	},
	{
		// The fifth, and the one the header was written about. It ships on the
		// WEBSITE rather than in the plugin, so it sits outside every plugin
		// test and most greps - which is exactly why it was missed. It wires
		// its own pointer handlers directly: no router, hence "none".
		//
		// This said it "builds strokes four times over, more than any other
		// surface", and that was FALSE. Four is the number of times the file
		// MENTIONS StrokeBuilder - the import, two type positions and the
		// construction - and InkOverlay.ts mentions it four times too. Every
		// surface constructs exactly one. The demo is an ordinary surface, and
		// the inference the "x4" was carrying, that it is too heavily used to
		// be a token stub, has no support and did not need any: it reads pen
		// pressure and stands the shaped width law down for a mouse
		// specifically, which is a surface that expects a pen.
		id: "demo",
		file: "/src/site/DemoInk.ts",
		router: "none",
		userReachable: true,
		mountsStrip: false,
		honoursTipMode: false,
	},
];

/**
 * The seven REQUIRED callbacks `InlinePenRouter` declares. Named here rather
 * than left implicit in the interface because THIS is the duplication surface:
 * note and pdf each supply all seven, independently, and a rule implemented
 * inside two of these is a rule that can diverge. Kept in the declaration's
 * own order.
 *
 * `InlinePenCallbacks` declares EIGHT. The eighth is `claimBandContact?`, and
 * it is deliberately not in this list: it is optional and note-only - only the
 * overlay has a linked-mentions band rendering outside the scroller to claim a
 * contact on - so requiring it of both surfaces would report a legitimately
 * surface-specific member as a divergence, which is the false positive that
 * fills an allowlist with entries that mean nothing. The prose above and in
 * `InkRouterFamily` used to say the router declares seven; the ARRAY was right
 * all along and only the sentences were wrong.
 */
export const INLINE_PEN_CALLBACKS = [
	"onPenDown",
	"onPenHover",
	"onPenLeave",
	"onPinch",
	"onPenRaw",
	"onPenMove",
	"onPenUp",
] as const;

export function inkSurface(id: InkSurfaceId): InkSurface {
	const found = INK_SURFACES.find((s) => s.id === id);
	// Throws rather than returning undefined: a caller that named a surface
	// that no longer exists has a stale assumption, and a silent undefined
	// would turn that into an assertion nobody notices passing vacuously.
	if (!found) throw new Error(`no such ink surface: ${id}`);
	return found;
}
