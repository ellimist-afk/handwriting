/**
 * The one node builtin this harness cannot do without.
 *
 * The repo has no `@types/node` on purpose - every other test that wants a
 * file's text uses a `?raw` import (see `src/raw-imports.d.ts`), and this
 * harness does the same for `styles.css`. But esbuild's `entryPoints` and
 * `alias` take filesystem paths, not module text, so the page bundle needs a
 * real path built from `import.meta.url`. Declared narrowly here rather than
 * taking on all of `@types/node` for two functions.
 */
declare module "node:url" {
	export function fileURLToPath(url: string | URL): string;
}
