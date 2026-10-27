/**
 * The reload and identity methods live in InkOverlayReload.ts and are
 * installed on InkOverlayPlugin.prototype when InkOverlay.ts loads. Two things
 * a type check cannot see are held here, as the install tests of the other
 * split files hold them for theirs.
 *
 * LOAD ORDER. InkOverlay.ts imports the install function, and the reload file
 * imports values back, so the two modules form a cycle. Every other test
 * imports InkOverlay.ts first. This file imports the reload file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it. CodeMirror calls `update`
 * only when the plugin has one, so a missing `update` would not even throw: the
 * overlay would stop following the editor, the file switch and the reload.
 */
import { describe, expect, it } from "vitest";

import { installReload } from "./InkOverlayReload";
import { InkOverlayPlugin } from "./InkOverlay";

const MOVED = [
	"showsPath",
	"ownsActiveEditor",
	"filePath",
	"ownsMarkdownEditorRoot",
	"update",
	"updateInner",
	"noteExternallyReloaded",
	"renamedFrom",
	"invalidateReloadBindings",
	"reloadBinding",
	"reloadCandidatePath",
	"setCanvasMomentumDisabled",
] as const;

describe("reload and identity methods on the overlay prototype", () => {
	it("load with the reload file imported first, and a moved method runs on a bare overlay", () => {
		expect(typeof installReload).toBe("function");
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		// No container and no editor: nothing is bound, so there is no reload candidate.
		expect(overlay.reloadCandidatePath()).toBeNull();
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(InkOverlayPlugin.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
		}
	});
});
