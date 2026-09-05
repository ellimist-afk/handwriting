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

/**
 * `MinimalCameraScale.test.ts` injects Minimal's WHOLE stylesheet, vendored
 * at `test/render/fixtures/minimal-9.0.2-theme.css`. A `?raw` import cannot
 * carry it: vitest empties a `.css?raw` id unless it matches the render
 * config's `css.include`, which is pinned to `styles.css?raw` on purpose
 * (see `vitest.render.mts`). One synchronous read, declared as narrowly as
 * the one above.
 */
declare module "node:fs" {
	export function readFileSync(path: string, encoding: "utf8"): string;
}
