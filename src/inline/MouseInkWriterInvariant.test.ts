/**
 * The raw `setMouseInk` (MouseInk.ts) flips the mode and NOTHING else — no
 * strip repaints, no light changes. Everything that repaints on a mode change
 * hangs off two wrappers: the `mouse-ink-toggle` command's `applyMouseInkUiFanout`
 * (main.ts), and `releaseMouseInkQuietlyEverywhere` (InkOverlay.ts). Both call
 * `refreshAllStrips`, which reaches every open editor's strip AND every surface
 * registered via `addStripSurface` — the PDF's, in production.
 *
 * So the surfaces and the strip must change the mode only THROUGH those paths:
 * `host.setMouseInk` executes the command (InkOverlay.ts / PdfInkController.ts
 * wire it to `executeCommandById("handwriting:mouse-ink-toggle")`), and the
 * quiet arm/disarm go through the wrappers. None of them calls the raw setter.
 *
 * WHY THIS IS PINNED AS AN IMPORT INVARIANT rather than a behavioural test.
 * TipModeCommand.test.ts already proves `applyMouseInkUiFanout` reaches a
 * registered surface in both directions, and QuietMouseInkFanout.test.ts proves
 * the same for the quiet release. What NEITHER pins is that a surface keeps
 * ROUTING through them. Today that is an inherited accident: `host.setMouseInk`
 * goes through the command because that is how the setting persists and the
 * Notice reads right — the fan-out is a side effect of that choice, not a stated
 * guarantee. If a surface later imported the raw `setMouseInk` and called it to
 * skip a toast or break a cycle, the multi-pane light would go stale exactly as
 * the tip-tool put-down did before `releaseMouseInkQuietlyEverywhere` — and no
 * behavioural test would catch it, because `applyMouseInkUiFanout` would still
 * fan out; the surface simply would not be calling it.
 *
 * The reachability of the raw setter is the thing that can regress, so that is
 * what this pins: the raw `setMouseInk` is imported by exactly one module, the
 * command that owns the fan-out. A surface cannot call what it does not import.
 *
 * Source text via `import.meta.glob` + `?raw`, the house pattern for an
 * invariant the type system cannot see (StripPenChrome.test.ts, InkSurfaceRules
 * .test.ts). Comments are stripped first through the shared `codeOnly`, so a
 * mention of `setMouseInk` in prose — this very file's neighbours included —
 * cannot be read as an import.
 */

import { describe, expect, it } from "vitest";
import { codeOnly } from "../CodeOnly";

const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

/** Files whose CODE imports the named specifier from a `MouseInk` module. */
function rawSetMouseInkImporters(): string[] {
	const out: string[] = [];
	for (const [path, raw] of Object.entries(ALL_TS)) {
		if (path.endsWith(".test.ts") || path.endsWith(".d.ts")) continue;
		const code = codeOnly(raw);
		// A NAMESPACE import reaches every export, the raw setter included, so
		// `import * as MI from "./MouseInk"` then `MI.setMouseInk(...)` would
		// evade a braces-only scan. Checked first, because it is the quiet way
		// past a named-import ban and the codebase's uniform named-import style
		// is exactly what would make it stand out if it ever appeared.
		if (/import\s*\*\s*as\s+\w+\s*from\s*"[^"]*MouseInk"/.test(code)) {
			out.push(path);
			continue;
		}
		// Every `import { ... } from "<...>MouseInk"` block, specifiers split
		// on commas and matched whole so `armMouseInkQuietly`,
		// `disarmMouseInkQuietly` and `mouseInkEnabled` are never mistaken for
		// `setMouseInk`. `[^}]*` spans newlines, so a multi-line import block is
		// covered (verified: a multi-line named import is caught, a namespace
		// import is not, which is why the branch above exists).
		const re = /import\s*\{([^}]*)\}\s*from\s*"([^"]*MouseInk)"/g;
		for (let m = re.exec(code); m; m = re.exec(code)) {
			const names = m[1]!.split(",").map((n) => n.trim());
			if (names.includes("setMouseInk")) {
				out.push(path);
				break;
			}
		}
	}
	return out.sort();
}

/**
 * The one evasion this scan does NOT cover, stated rather than left silent: a
 * DYNAMIC import - `const { setMouseInk } = await import("./MouseInk")`. It is
 * not worth matching. Static named and namespace imports are the only two forms
 * anywhere in this repo, a dynamic import of a sibling module would be a glaring
 * anomaly a reviewer would stop on, and matching it robustly means parsing await
 * expressions a regex has no business attempting. Named + namespace is the whole
 * of the realistic regression surface; this is the acknowledged remainder.
 */

describe("mouse-ink writer invariant: only the command imports the raw setter", () => {
	it("the raw setMouseInk is imported by exactly one module", () => {
		// main.ts is where `applyMouseInkUiFanout` lives, so it is the one place
		// the raw setter and the fan-out sit together. Any other importer is a
		// mode change that can skip the repaint - the regression this pins.
		expect(rawSetMouseInkImporters()).toEqual(["/src/main.ts"]);
	});

	it("neither ink surface nor the strip imports it", () => {
		// Stated separately from the count so a failure names the surface that
		// broke the rule, not just "the number moved". These three are the
		// files that draw a strip light off `mouseInkOn()` (nibIsLit,
		// MobileTools.ts) and so are the ones a stale mode would show wrong.
		const importers = rawSetMouseInkImporters();
		for (const surface of [
			"/src/inline/InkOverlay.ts",
			"/src/pdf/PdfInkController.ts",
			"/src/inline/MobileTools.ts",
		]) {
			expect(importers, `${surface} imports the raw setMouseInk`).not.toContain(surface);
		}
	});

	it("the scan can see a real import (it is not matching nothing)", () => {
		// P3: a regex that silently matched no import would pass the two
		// assertions above by finding an empty set, then reporting the rule
		// held. Prove the matcher fires on the one importer that must exist.
		expect(rawSetMouseInkImporters()).toContain("/src/main.ts");
	});
});
