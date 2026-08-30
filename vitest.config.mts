import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// The `obsidian` package ships types and no runtime entry, so a test that
	// pulls in anything importing it dies at resolution. Aliasing it to a
	// do-nothing stub is what lets the pen surfaces be constructed in a test
	// at all - see test/obsidian-stub.ts.
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL("./test/obsidian-stub.ts", import.meta.url)),
		},
	},
	test: {
		// Only the plugin's own suite. Without this, a worktree or repo copy
		// sitting anywhere under the root gets swept into the run and the
		// counts stop meaning anything.
		include: ["src/**/*.test.ts"],
		// Vitest swaps every CSS import for "" unless it matches css.include,
		// and a `?raw` text import still has an id ending in `.css?raw`, so it
		// was emptied too. GuardStyle.test.ts asserts on styles.css as text.
		css: { include: [/styles[.]css[?]raw$/] },
	},
});
