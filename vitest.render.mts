import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The rendered-geometry suite, kept OUT of the default run on purpose.
 *
 * `vitest.config.mts` includes `src/**` + '/' + `*.test.ts`. Everything here
 * lives under `test/render/`, so `npx vitest run` - the gate - never sees it:
 * no browser launch, no browser download in CI, and the gate's timing and
 * counts are untouched. The cost is that a suite nobody invokes is a suite
 * nobody runs, which is why it is one npm script (`npm run test:render`) and
 * not a script in `scripts/` that prints numbers and asserts nothing.
 */
export default defineConfig({
	resolve: {
		// Same reason as the main config: the `obsidian` package ships types
		// and no runtime entry, so anything importing it dies at resolution.
		alias: {
			obsidian: fileURLToPath(new URL("./test/obsidian-stub.ts", import.meta.url)),
		},
	},
	test: {
		include: ["test/render/**/*.test.ts"],
		// Same reason as the main config: vitest empties a `.css` import
		// unless it matches css.include, and a `?raw` id still ends in
		// `.css?raw`. The harness injects the real stylesheet, so this is
		// load-bearing rather than cosmetic - without it the page would get
		// an empty string and every width would be the browser default.
		css: { include: [/styles[.]css[?]raw$/] },
		// Launching a browser and bundling the page shim both happen inside
		// the first test.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
