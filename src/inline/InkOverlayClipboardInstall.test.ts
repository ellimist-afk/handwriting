/**
 * The note surface's clipboard and snip commands (snip the selection to a PNG,
 * copy, cut, paste and delete the lasso selection) live in
 * InkOverlayClipboard.ts and are installed on InkOverlayPlugin.prototype when
 * InkOverlay.ts loads. Five things a type check cannot see are held here, as
 * InkOverlayLassoSpaceInstall.test.ts holds them for the lasso file.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when a
 * menu, key or export command ran on a device.
 *
 * NO BODY LEFT BEHIND. The clipboard file declares each command once, and the
 * lasso file declares neither a command nor a helper that moved with them.
 *
 * THE ORDER. InkOverlay.ts installs the clipboard once, after the class and
 * after the lasso install.
 *
 * ONE DOOR. The clipboard file takes one value from an overlay file
 * (InkOverlay.ts, for the ink state), and imports the install helper before it.
 *
 * LISTED. The note row of the ink-surface ledger names the clipboard file, so
 * every rule that reads the note surface's files reads this one too.
 */
import { describe, expect, it } from "vitest";

import { installInkOverlayClipboard } from "./InkOverlayClipboard";
import { InkOverlayPlugin } from "./InkOverlay";
import overlayRaw from "./InkOverlay.ts?raw";
import clipboardRaw from "./InkOverlayClipboard.ts?raw";
import lassoRaw from "./InkOverlayLassoSpace.ts?raw";
import { surfaceFiles } from "./surfaceFiles.testutil";

const MOVED = ["snipSelection", "copySelectedInk", "cutSelectedInk", "pasteInkHere", "deleteSelectedInk"] as const;

/** Module-level helpers and constants that only the five commands use, and moved with them. */
const MOVED_HELPERS = [
	"segmentIntersectsViewport",
	"strokeIntersectsViewport",
	"publishInkMarker",
	"NOTE_SNIP_CAP_PX",
	"SNIP_PAGE",
] as const;

const overlaySrc = overlayRaw.replace(/\r\n/g, "\n");
const clipboardSrc = clipboardRaw.replace(/\r\n/g, "\n");
const lassoSrc = lassoRaw.replace(/\r\n/g, "\n");

/** An overlay with no host: the prototype, and the one field the commands ask first. */
function bareOverlay(path: string | null): InkOverlayPlugin {
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.defineProperty(overlay, "filePath", { value: () => path, writable: true, configurable: true, enumerable: true });
	return overlay;
}

describe("clipboard and snip methods on the overlay prototype", () => {
	it("load with the clipboard file imported first", () => {
		expect(typeof installInkOverlayClipboard).toBe("function");
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

	it("each command is declared once in the clipboard file and not in the lasso file", () => {
		for (const name of MOVED) {
			const inFile = clipboardSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: InkOverlayPlugin\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in InkOverlayClipboard.ts`).toBe(1);
			expect(lassoSrc, `${name} still declared in InkOverlayLassoSpace.ts`).not.toMatch(
				new RegExp(`^\\t(?:async )?function ${name}\\(`, "m")
			);
		}
	});

	it("each helper is declared once in the clipboard file and not in the lasso file", () => {
		for (const name of MOVED_HELPERS) {
			const inFile = clipboardSrc.match(new RegExp(`^(?:function|const) ${name}\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in InkOverlayClipboard.ts`).toBe(1);
			expect(lassoSrc, `${name} still declared in InkOverlayLassoSpace.ts`).not.toMatch(
				new RegExp(`^(?:function|const) ${name}\\b`, "m")
			);
		}
	});

	it("the overlay installs the clipboard once, after the class and after the lasso install", () => {
		const call = "installInkOverlayClipboard(InkOverlayPlugin.prototype);";
		const lasso = "installLassoSpace(InkOverlayPlugin.prototype);";
		expect(overlaySrc.split(call).length - 1).toBe(1);
		expect(overlaySrc.split(lasso).length - 1).toBe(1);
		const classStart = overlaySrc.indexOf("export class InkOverlayPlugin");
		const classEnd = overlaySrc.indexOf("\n}\n", classStart);
		expect(classStart).toBeGreaterThan(-1);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(overlaySrc.indexOf(lasso)).toBeGreaterThan(classEnd);
		expect(overlaySrc.indexOf(call)).toBeGreaterThan(overlaySrc.indexOf(lasso));
	});

	it("the clipboard file takes InkOverlay as its only value import from an overlay file, after the install helper", () => {
		const imports = [...clipboardSrc.matchAll(/^import\s+(type\s+)?([^;]*?)\s+from\s+"(\.\/[^"]+)";/gm)];
		const fromOverlay = imports.filter((m) => /^\.\/InkOverlay[A-Za-z]*$/.test(m[3]!));
		expect(fromOverlay.map((m) => m[3])).toEqual(["./InkOverlay"]);
		expect(fromOverlay[0]![1], "the InkOverlay import is not type-only").toBeUndefined();
		const order = imports.map((m) => m[3]);
		expect(order.indexOf("./InstallMethods")).toBeGreaterThan(-1);
		expect(order.indexOf("./InstallMethods")).toBeLessThan(order.indexOf("./InkOverlay"));
		expect(clipboardSrc).not.toMatch(/^export [^;]*from\s+"\.\/InkOverlay[A-Za-z]*";/m);
	});

	it("is listed in the note row of the ink-surface ledger", () => {
		expect(surfaceFiles("note")).toContain("/src/inline/InkOverlayClipboard.ts");
	});

	it("copySelectedInk with no open note is 0, and cutSelectedInk answers empty", () => {
		const overlay = bareOverlay(null);
		expect(overlay.copySelectedInk()).toBe(0);
		expect(overlay.cutSelectedInk()).toEqual({ kind: "empty" });
	});
});
