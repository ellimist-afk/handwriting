/**
 * Vite/vitest `?raw` imports: a file's text as a string. Used only by tests
 * that assert on source or stylesheet text; never reached by the esbuild
 * bundle (no runtime module imports it).
 */
declare module "*?raw" {
	const content: string;
	export default content;
}

/**
 * `import.meta.glob` with `?raw`: many files' text at once, keyed by
 * root-absolute path. The repo-wide form of the declaration above, and what
 * lets StripPenChrome.test.ts scan the whole tree rather than a hardcoded
 * list of files that a new surface is invisible to until someone remembers it.
 *
 * Declared here rather than by adding `vite/client` to tsconfig's `types`:
 * that would pull in vite's own ambient module declarations for `*?raw` and
 * every other asset query alongside this one, which is a large surface to
 * take on for one call. Deliberately narrowed to the exact option shape that
 * yields `Record<string, string>` - `eager` false returns loader functions and
 * a different `query` returns something other than text, so a call written in
 * either of those shapes should not typecheck against this. Verified against
 * the installed vite 8.2.1, where `query: "?raw"` is the spelling; the older
 * `as: "raw"` was removed in vite 6.
 */
interface ImportMeta {
	glob(
		pattern: string,
		options: { readonly query: "?raw"; readonly eager: true; readonly import: "default" }
	): Record<string, string>;
}
