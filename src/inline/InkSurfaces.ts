/**
 * The ink surfaces, named once.
 *
 * There are SIX places where a pointer becomes a stroke, and this project's
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
 * This header then said FIVE until 2026-09-05, and that was wrong from the
 * moment the slides line landed. `src/slides/SlidesInkSurface.ts` ships in the
 * plugin, but the presenter it draws on is `div.slides-container` appended to
 * `<body>` - not a workspace leaf, no workspace event, so every grep that
 * starts from a view misses it exactly the way the greps that start from the
 * plugin bundle missed the demo. It is the sixth, and it was caught by the
 * StrokeBuilder sweep below on the day the two lines were merged, which is the
 * only reason this sentence is being corrected on the same day rather than in
 * three releases' time.
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

export type InkSurfaceId = "note" | "pdf" | "penlab" | "demo" | "slides";

/**
 * Which pointer router a surface is built on. This is the fault line: `note`
 * and `pdf` share `InlinePenRouter`, which declares TEN callbacks and lets
 * each surface answer them independently, so it is the pair that diverges.
 * `penlab` is on `PointerRouter` and owns its whole surface; `demo` and
 * `slides` are on neither and wire their own pointer handlers.
 * Those two are "none" for different reasons: the demo cannot reach a router
 * because the site bundle does not carry one, and the slides surface will not
 * reach for `InlinePenRouter` because doing so would drag its whole eighteen-
 * import input stack into a bundle that today depends on nothing heavier than
 * `src/ink`, `src/model` and the DOM-free `src/inline` leaves. Its own comment
 * on `eraserIntent` is where that reasoning lives, and the price it pays for
 * it - a handful of the routers' predicates restated - is priced in the
 * `penContactIntent` row of `InkSurfaceRules.test.ts`, not waved through.
 *
 * This said "seven callbacks", then "EIGHT", and was wrong both times - the
 * count went stale the moment an optional member was added and nobody
 * recounted. Ten today: seven required, plus `claimBandContact?`,
 * `describeChrome?` and `onStrokeAbandoned?`. Which of them BOTH surfaces owe
 * an answer to is a separate question, and INLINE_PEN_CALLBACKS below is the
 * one that gets executed.
 */
export type InkRouterFamily = "InlinePenRouter" | "PointerRouter" | "none";

export interface InkSurface {
	readonly id: InkSurfaceId;
	/** Root-absolute, forward slashes - the key shape `import.meta.glob` uses. */
	readonly file: string;
	/**
	 * The other files that hold this surface's code, once `file` has been split
	 * into more than one. The rules read `file` and these together as the one
	 * surface; the membership checks read `file` alone, because that is still
	 * where the stroke is built.
	 */
	readonly parts?: readonly string[];
	readonly router: InkRouterFamily;
	/**
	 * Can a user get here at all? `penlab` cannot: nothing in the UI opens it.
	 * Its value is that its head and its ribbon are allowed to disagree, which
	 * is what makes it a probe rather than a surface, and it is the reason a
	 * rule may legitimately skip it.
	 */
	readonly userReachable: boolean;
	/** Does this surface construct a `MobileTools` strip, directly or through an adapter? */
	readonly mountsStrip: boolean;
	/** Separate adapter construction site, when the input surface stays DOM-only. */
	readonly stripFile?: string;
	/**
	 * Does the pen TIP here obey `TipMode` - eraser, lasso, pan, space? A
	 * surface can answer `false` without that being an omission: a surface
	 * whose own tool set has no `pan` member pans by transient gesture
	 * instead, and a rule about the tip mode is inapplicable to it rather
	 * than missing from it.
	 */
	readonly honoursTipMode: boolean;
}

/**
 * Each `file` is where the stroke is built, and for the three router-bearing
 * surfaces it is also where the router is constructed and the callbacks are
 * wired. `demo` and `slides` have no router, so for them the stroke and the
 * pointer wiring are both the whole of it.
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
 */
export const INK_SURFACES: readonly InkSurface[] = [
	{
		id: "note",
		file: "/src/inline/InkOverlay.ts",
		parts: ["/src/inline/InkOverlayCursors.ts", "/src/inline/InkOverlayLassoSpace.ts", "/src/inline/InkOverlayClipboard.ts", "/src/inline/InkOverlayPaperPinch.ts", "/src/inline/InkOverlayPanSettle.ts", "/src/inline/InkOverlayViewportBox.ts", "/src/inline/InkOverlayColumnMargin.ts", "/src/inline/InkOverlayDiagnostics.ts", "/src/inline/InkOverlayMeasureHold.ts", "/src/inline/InkOverlayLayout.ts", "/src/inline/InkOverlayLifecycle.ts", "/src/inline/InkOverlayKeys.ts", "/src/inline/InkOverlayZoomApi.ts", "/src/inline/InkOverlayPinch.ts", "/src/inline/InkOverlayLineAnchors.ts", "/src/inline/InkOverlayToolState.ts", "/src/inline/InkOverlayReload.ts", "/src/inline/InkOverlayGestureEnd.ts", "/src/inline/InkOverlayOps.ts", "/src/inline/InkOverlayErase.ts", "/src/inline/InkOverlayExtent.ts", "/src/inline/InkOverlayBand.ts", "/src/inline/InkOverlayPenSupport.ts", "/src/inline/InkOverlayPenPath.ts", "/src/inline/InkOverlayRegistry.ts", "/src/inline/InkOverlayCamera.ts", "/src/inline/InkOverlayRepaint.ts", "/src/inline/InkOverlayConstants.ts"],
		router: "InlinePenRouter",
		userReachable: true,
		mountsStrip: true,
		stripFile: "/src/inline/InkOverlayLifecycle.ts",
		honoursTipMode: true,
	},
	{
		id: "pdf",
		file: "/src/pdf/PdfInkController.ts",
		parts: ["/src/pdf/PdfInkCursors.ts", "/src/pdf/PdfInkSelection.ts", "/src/pdf/PdfInkTools.ts", "/src/pdf/PdfInkTrace.ts", "/src/pdf/PdfInkBand.ts", "/src/pdf/PdfInkBind.ts", "/src/pdf/PdfInkPenPath.ts", "/src/pdf/PdfInkCommit.ts"],
		router: "InlinePenRouter",
		userReachable: true,
		mountsStrip: true,
		stripFile: "/src/pdf/PdfInkTools.ts",
		honoursTipMode: true,
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
	{
		// The SIXTH, and the one the correction at the top of this file is
		// about. It ships IN the plugin but outside the workspace: the
		// presenter is `div.slides-container` appended to `<body>`, not a
		// leaf, so no workspace event fires for it (its own header, S1).
		//
		// EVERY COLUMN BELOW WAS READ OUT OF THE FILE, and the evidence is on
		// the line above it, because the surrounding entries' columns are
		// claims a reader can check rather than facts the suite guarantees -
		// only `file` and `mountsStrip` are executed.
		//
		// router "none": it constructs NEITHER router - `grep -c "new
		// InlinePenRouter(" / "new PointerRouter("` is 0 for both, which is
		// also what this registry's own router-family test asserts for a
		// "none" surface. It wires six capture-phase pointer handlers on
		// `.reveal` itself (pointerdown/move/up/cancel plus the two capture
		// events) and RESTATES a few of the routers' predicates -
		// `claimsContact`, `isEraserContact`, `eraserIntent` - rather than
		// importing them. The reason is written down at `eraserIntent`: it
		// declines the eighteen-import cost of `InlinePenRouter.ts`. That
		// choice is a cost, not a free pass, and the `penContactIntent` row
		// of `InkSurfaceRules.test.ts` records the half of it that is real.
		//
		// userReachable true: a user presents a note through core Slides and
		// writes on the deck with the pen. Unlike `penlab`, something in the
		// UI opens it, so no rule may skip it for being unreachable.
		//
		// The presentation owns its toolbar through the dedicated SlidesTools adapter.
		// The input surface remains independent of Obsidian and MobileTools imports.
		//
		// honoursTipMode: THE TRUTH IS PARTIAL, and `true` is the honest half
		// of the two available. The tip obeys exactly ONE member of TipMode -
		// `tipMode() === "eraser"`, read once per contact in the pen-down arm
		// and handed to `eraserIntent` - and no other, because a deck has no
		// lasso, no pan and no insert-space for the remaining three to mean
		// anything on. So read `true` as "the tip obeys TipMode wherever
		// TipMode has something to say here", NEVER as all four: the lasso,
		// pan and space rows in `InkSurfaceRules.test.ts` exempt this surface
		// and are right to. `false` would be the worse lie of the two. It is
		// the value a surface with no TipMode at all carries, and the two
		// exemptions that cite this column by name read it that way - which
		// would hide the fact that eraser MODE is the only way a pen with no
		// tail end takes ink back off a slide, and would contradict the
		// "reads the tip mode" row, which this surface carries with a real
		// call site.
		id: "slides",
		file: "/src/slides/SlidesInkSurface.ts",
		parts: ["/src/slides/SlidesSections.ts", "/src/slides/SlidesStrokeSession.ts", "/src/slides/SlidesPersistence.ts", "/src/slides/SlidesPenGuards.ts", "/src/slides/SlidesMount.ts", "/src/slides/SlidesPointerPath.ts", "/src/slides/SlidesContact.ts", "/src/slides/SlidesBind.ts", "/src/slides/SlidesController.ts"],
		router: "none",
		userReachable: true,
		mountsStrip: true,
		stripFile: "/src/slides/SlidesTools.ts",
		honoursTipMode: true,
	},
];

/**
 * The callbacks BOTH inline surfaces must wire. Named here rather than left
 * implicit in the interface because THIS is the duplication surface: note and
 * pdf each supply all of them, independently, and a rule implemented inside
 * two of these is a rule that can diverge. Kept in the declaration's own order.
 *
 * `InlinePenCallbacks` declares ELEVEN members: seven required, and four
 * optional. Membership here is not "is it required by the type" - it is "must
 * both surfaces answer it", and the two questions have come apart:
 *
 *   - `claimBandContact?` is optional and note-ONLY. Only the overlay has a
 *     linked-mentions band rendering outside the scroller to claim a contact
 *     on, so requiring it of both would report a legitimately surface-specific
 *     member as a divergence - the false positive that fills an allowlist with
 *     entries that mean nothing.
 *   - `describeChrome?` is optional and note-only for the same kind of reason:
 *     it is trace-only, and it answers for a strip the router holds no
 *     reference to. The pdf leaves it undefined.
 *   - `penOff?` is optional in the TYPE and required of both here, and it is
 *     the newest entry precisely because it spent two days being the other
 *     kind. It shipped note-only - the pdf passed nothing, so its router never
 *     gated on the pen-off state - and the owner reversed that ("why would you
 *     take keyboard mode away from pdf"): the state is whether this router
 *     claims the pen at all, which is a question every ink surface has the
 *     same answer to. It is here so the next surface that quietly stops
 *     wiring the gate fails this scan instead of shipping a switch that does
 *     nothing on one of two panes. Optional in the type because a router built
 *     by a harness has no opinion and undefined reads as "never off".
 *   - `onStrokeAbandoned?` is optional in the TYPE and required of both here.
 *     Optional because a router may be built by something with no chrome to
 *     stand down (the harnesses do); required of both because the thing it
 *     reports - a live stroke torn down with no lift, by a path that cannot
 *     commit what was drawn - happens identically on a note and on a pdf, and
 *     a surface that skipped it would be left wearing `is-inking` (opacity 0,
 *     visibility hidden) with no later switch able to repair it. That is
 *     exactly the one-surface divergence this array exists to make loud.
 *
 *     A WINDOW BLUR is no longer such a path, and this entry named it as the
 *     example until 2026-09-04. The owner's ruling that day ("alt tab mid
 *     stroke - sure make it consistent") made a blur COMMIT: the router's blur
 *     handler runs `finishActiveStroke()`, which reaches `onPenUp` exactly as
 *     a lift does. What still abandons is a surface tearing its own stroke
 *     down - the note switch (`InkOverlayPlugin.update`) and the pdf's
 *     in-place document change (`PdfInkController.forgetHistory`) - each of
 *     which calls `abandonActiveStroke()` itself and reads the boolean. The
 *     pdf routes that into its own `strokeAbandoned`; the note's branch runs
 *     the same teardown inline, so `InkOverlay.strokeAbandoned` is today
 *     reached through this member alone.
 *
 * This header said "seven REQUIRED" and "declares EIGHT". The first is now a
 * different claim, and the second was simply wrong before this edit:
 * `describeChrome?` had been added and the sentence never counted it.
 *
 * WHAT THIS ARRAY DOES NOT PROVE, said here so the row cannot be read as
 * coverage it is not. The check driven off it is a scan for `<name>:` in the
 * surface's own source: it proves the identifier is WIRED and says nothing
 * about what the body does, so replacing any of these bodies with an empty
 * arrow keeps it green. That is not a flaw in the row - presence across two
 * surfaces is exactly the divergence question it exists for - but for
 * `onStrokeAbandoned` it was, for two releases, the ONLY thing asserted, while
 * the body was the whole payload a user sees. The behaviour now lives where
 * behaviour belongs: `PdfInkController.test.ts`'s "the in-place document
 * switch stands down exactly the same things" drives `forgetHistory()` against
 * the real router the pdf builds, and `AbandonedGestureStandsDown.test.ts`
 * calls the note's body directly, because nothing in this repo can construct
 * an InkOverlayPlugin - its mount wants real canvases and a 2d context - so
 * the note's WIRING is still held by the scan alone. If that ever becomes
 * possible, that test is where the missing half goes.
 *
 * `onStrokeAbandoned` is, since the blur became a commit, UNREACHABLE from the
 * router itself: the one call site left (the blur handler's second branch)
 * can only run when no stroke was live, and `abandonActiveStroke()` returns
 * false in exactly that case. The row stays required all the same - the
 * callback's contract is "a stroke was really torn down", a future caller of
 * that branch could satisfy it, and the surfaces' `strokeAbandoned` bodies are
 * live code reached by their own abandon calls.
 */
export const INLINE_PEN_CALLBACKS = [
	"onPenDown",
	"onPenHover",
	"onPenLeave",
	"onPinch",
	"onPenRaw",
	"onPenMove",
	"onPenUp",
	"penOff",
	"onStrokeAbandoned",
] as const;

export function inkSurface(id: InkSurfaceId): InkSurface {
	const found = INK_SURFACES.find((s) => s.id === id);
	// Throws rather than returning undefined: a caller that named a surface
	// that no longer exists has a stale assumption, and a silent undefined
	// would turn that into an assertion nobody notices passing vacuously.
	if (!found) throw new Error(`no such ink surface: ${id}`);
	return found;
}
