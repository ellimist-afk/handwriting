/**
 * A held or capped text column changes neither the editor's width nor its
 * content's height, so CodeMirror would keep the line heights of the old wrap
 * and every anchor read from them would put the ink off its words. The column
 * hold sets CodeMirror's own `viewState.mustMeasureContent` flag, the one its
 * theme path sets, so the next measure reads the lines again.
 *
 * The flag is not public API. Two things are held here: the npm build the
 * plugin compiles against still declares, reads and clears the flag, and a
 * build without it is reported once, by name, rather than skipped in silence.
 * The page-top cells of the render suite stay the check on the build Obsidian
 * itself ships.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InkOverlayPlugin } from "./InkOverlay";
import { contentMeasureFlagState, markContentForMeasure } from "./InkOverlayViewportBox";

const FIELD = "viewState.mustMeasureContent";

describe("the editor re-measure flag a held column sets", () => {
	afterEach(() => vi.restoreAllMocks());

	it("the npm @codemirror/view build declares the flag, measures the content when it is set, and clears it after", () => {
		const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
		const declared = pkg.dependencies?.["@codemirror/view"] ?? pkg.devDependencies?.["@codemirror/view"];
		const installed = (JSON.parse(readFileSync("node_modules/@codemirror/view/package.json", "utf8")) as { version: string }).version;
		expect(installed, "the installed build is the one package.json names").toBe(declared);
		const dist = readFileSync("node_modules/@codemirror/view/dist/index.js", "utf8").replace(/\r\n/g, "\n");
		// ViewState's constructor declares it, measure() reads it into measureContent and clears it, and the theme path sets it.
		expect(dist.match(/^ {8}this\.mustMeasureContent = true;$/gm)?.length ?? 0, "declared in ViewState").toBe(1);
		expect(dist.match(/let measureContent = refresh \|\| this\.mustMeasureContent \|\|/g)?.length ?? 0, "read by measure").toBe(1);
		expect(dist.match(/^ {8}this\.mustMeasureContent = false;$/gm)?.length ?? 0, "cleared by measure").toBe(1);
		expect(dist.match(/this\.viewState\.mustMeasureContent = true;/g)?.length ?? 0, "set by the editor's own redraw").toBeGreaterThanOrEqual(1);
	});

	it("sets the flag when the editor has it, and warns once, naming the field, when it does not", () => {
		void InkOverlayPlugin;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(contentMeasureFlagState()).toBe("not asked yet");

		const view = { viewState: { mustMeasureContent: false } };
		markContentForMeasure(view);
		expect(view.viewState.mustMeasureContent).toBe(true);
		expect(warn).not.toHaveBeenCalled();
		expect(contentMeasureFlagState()).toBe("set");

		markContentForMeasure({});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]![0])).toContain(FIELD);
		expect(contentMeasureFlagState()).toContain(FIELD);
		expect(contentMeasureFlagState()).toContain("viewState is missing");

		// A field of another type is not written, and the warning is not repeated in the same session.
		const renamed = { viewState: { mustMeasureContent: undefined as unknown } };
		markContentForMeasure(renamed);
		markContentForMeasure(null);
		expect(renamed.viewState.mustMeasureContent).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(contentMeasureFlagState()).toContain("viewState is missing");
	});
});
