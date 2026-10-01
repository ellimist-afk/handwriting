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
		// The CI bounds cell lives under test/, not src/: the build digest walks src/**.
		include: ["src/**/*.test.ts", "test/CiTimingBounds.test.ts"],
		// Vitest swaps every CSS import for "" unless it matches css.include,
		// and a `?raw` text import still has an id ending in `.css?raw`, so it
		// was emptied too. GuardStyle.test.ts asserts on styles.css as text.
		css: { include: [/styles[.]css[?]raw$/] },
		// Several gates run at once on this machine (four runners, the
		// architects, CI-equivalent full gates). Without a cap each run forks
		// one worker per core, so eight concurrent gates put ~120 workers on
		// sixteen cores and the real-clock tests start missing their windows -
		// the 2026-09-05 "unidentified flake". Four per run keeps a single
		// gate fast enough and six at once under the core count.
		maxWorkers: 4,
	},
});
