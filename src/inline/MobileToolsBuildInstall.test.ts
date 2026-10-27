/**
 * The strip's button build lives in MobileToolsBuild.ts and is installed on
 * MobileTools.prototype when MobileTools.ts loads. Four things a type check
 * cannot see are held here, as the install tests of the other split files hold
 * them for theirs.
 *
 * LOAD ORDER. MobileTools.ts imports the install function, and the build file
 * imports values back (eraserEdge), so the two modules form a cycle. Every
 * other test imports MobileTools.ts first. This file imports the build file
 * first, so a cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. The moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when a
 * strip was constructed on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares no buildButtons, and the build
 * file declares it once, so a half-finished move cannot pass with the old copy
 * still shadowing the new one.
 *
 * ONE DOOR. The build file names nothing of the strip beyond the list below.
 *
 * No cell here constructs a strip: MobileTools.test.ts does, and a constructor
 * with no buildButtons fails there at once.
 */
import { describe, expect, it } from "vitest";

import { installMobileToolsBuild } from "./MobileToolsBuild";
import { MobileTools } from "./MobileTools";
import stripRaw from "./MobileTools.ts?raw";
import buildRaw from "./MobileToolsBuild.ts?raw";

const MOVED = ["buildButtons"] as const;

/** Every name the build file takes from the strip, and nothing else. */
const FROM_STRIP = ["MobileTools", "MobileToolsHost", "MobileToolsOptions", "eraserEdge"];

const stripSrc = stripRaw.replace(/\r\n/g, "\n");
const buildSrc = buildRaw.replace(/\r\n/g, "\n");

describe("button build on the strip prototype", () => {
	it("loads with the build file imported first", () => {
		expect(typeof installMobileToolsBuild).toBe("function");
		expect(typeof MobileTools.prototype.buildButtons).toBe("function");
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(MobileTools.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
		}
	});

	it("each moved name is declared once in the build file and not in the class", () => {
		const classStart = stripSrc.indexOf("export class MobileTools {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = stripSrc.slice(classStart, stripSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = buildSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: MobileTools\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in MobileToolsBuild.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the strip installs once, after the class closing brace", () => {
		const call = "installMobileToolsBuild(MobileTools.prototype);";
		expect(stripSrc.split(call).length - 1).toBe(1);
		const classStart = stripSrc.indexOf("export class MobileTools {");
		const classEnd = stripSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(stripSrc.indexOf(call)).toBeGreaterThan(classEnd);
	});

	it("the build file takes exactly the listed names from the strip", () => {
		const imports = [...buildSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/MobileTools";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_STRIP].sort());
	});
});
