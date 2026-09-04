/**
 * `codeOnly` - source text with COMMENTS blanked out, length and line count
 * preserved.
 *
 * WHY IT EXISTS. Several tests in this repo assert on SOURCE TEXT rather than
 * on behaviour, because the thing worth pinning is not what a surface does, it
 * is WHERE the decision lives. A text match over raw source measures
 * DOCUMENTATION, not code, and that has cost this project twice:
 *
 *   - the canvas tap-floor call was deleted and a doc comment spelling the
 *     symbol with its opening paren was left behind. All 89 tests passed.
 *   - a doc comment in the surface registry spelled a strip construction while
 *     EXPLAINING it, and a raw-source sweep counted the registry as a file
 *     that mounts a strip.
 *
 * Both directions are the same fault. The second is loud and costs an hour.
 * The first is silent and ships a defect, and it is the one this function is
 * for: a guard a comment can satisfy is a guard a comment can defeat.
 *
 * WHY IT IS A MODULE AND NOT A HELPER INSIDE ONE TEST FILE. It was one, in
 * `InkSurfaceRules.test.ts`, and its sibling `StripPenChrome.test.ts` scanned
 * raw source with no equivalent - so of the two guards built for the same
 * defect class, only one was protected. Copying the function across would have
 * left two implementations of one rule to diverge, which is the defect class
 * these guards exist to catch. It lives at the root of `src` rather than in
 * `src/inline/` because the raw-source readers are spread across `src/inline`,
 * `src/persistence` and `src` itself.
 *
 * It is a plain module rather than a `.test.ts` on purpose: importing a test
 * file from another test file would re-register its describes in the importing
 * file. Being an ordinary source file also means it is swept by the guards it
 * powers, like anything else under `src`, which is correct - the stripper is
 * not exempt from the rules it enforces. Nothing in production imports it, so
 * it is not in the bundle; esbuild starts from `main.ts`.
 *
 * WHAT IT DOES NOT DO, stated rather than discovered:
 *
 *   - STRING LITERALS ARE NOT BLANKED. Deliberate. Every marker in both guards
 *     ends in an opening paren, so reaching one inside a string needs source
 *     that quotes a call, which no ink surface does today. If one ever does,
 *     this is the place to fix it.
 *   - it is not a parser. A comment opener inside a string literal, or a
 *     comment-looking sequence inside a regex, is treated as a comment. That
 *     fails toward blanking MORE than it should, which for a presence guard
 *     means a false ALARM rather than a false all-clear - the direction that
 *     announces itself. See the failure-family section of `1.4.9-design.md`.
 *
 * Blanked rather than deleted so offsets survive and a future assertion can
 * report a line number that still means something. The four fixture tests in
 * `InkSurfaceRules.test.ts` pin that, and pin the function against returning
 * its input unchanged - which would leave every assertion in both guards
 * passing with a test standing over it claiming the hole was shut.
 */
export function codeOnly(src: string): string {
	const blank = (m: string): string => m.replace(/[^\r\n]/g, " ");
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\r\n]*/g, blank);
}
