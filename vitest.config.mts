import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Vitest swaps every CSS import for "" unless it matches css.include,
		// and a `?raw` text import still has an id ending in `.css?raw`, so it
		// was emptied too. GuardStyle.test.ts asserts on styles.css as text.
		css: { include: [/styles[.]css[?]raw$/] },
	},
});
