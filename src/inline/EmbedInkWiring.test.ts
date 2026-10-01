/**
 * main.ts wiring for the embed-ink registry hooks (audits 25, 118, 119).
 * main.ts cannot be loaded in a unit test, so these read its source, the same
 * way LiveReloadTestHarness does: fail closed if the call sites move.
 */
import { describe, expect, it } from "vitest";
import mainSource from "../main.ts?raw";

const src = mainSource.replace(/\r\n/g, "\n");

function caseBody(name: string): string {
	const at = src.indexOf(`case "${name}":`);
	expect(at).toBeGreaterThan(0);
	const next = src.indexOf("\n\t\t\tcase ", at + 10);
	return src.slice(at, next);
}

describe("main.ts calls the embed-ink hooks", () => {
	it.each(["pressureSensitivity", "inkSmoothing", "booxMode"])("the %s setting repaints reading-view and embedded ink (audit 25)", (name) => {
		expect(caseBody(name)).toContain("embedInkRepaintAll();");
	});

	it("a note rename re-keys embed layers right after the ink store moves (audit 118)", () => {
		expect(src).toMatch(/inlineInk\.handleRename\(oldPath, file\.path\);\n\s*embedInkRenamed\(oldPath, file\.path\);/);
	});

	it("opening a file reconciles the active view's reading-view layer (audit 119)", () => {
		expect(src).toMatch(/workspace\.on\("file-open", \(file\) => \{\n\s*if \(file\) embedInkFileOpened\(/);
	});
});
