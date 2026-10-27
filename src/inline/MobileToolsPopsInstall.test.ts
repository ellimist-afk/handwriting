/**
 * The strip's pops (the more row, the slider pops and their timers, the hover tips, the collapse, the fold order
 * and the stale check) live in MobileToolsPops.ts and are installed on MobileTools.prototype when MobileTools.ts
 * loads. Five things a type check cannot see are held here, as the install tests of the other split files hold
 * them for theirs.
 *
 * LOAD ORDER. This file imports the pops file first, and one cell loads the two in each order from a clean
 * module graph. The pops file takes only a type from the strip, so there is no cycle; a value import added back
 * fails here, at load, in whichever order it breaks.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the descriptor a class method has.
 * A name left out of the install still type-checks, because the interface declares it, and would only fail when
 * a pen contact or a hover reached it on a device. The install is once, after the class and after the build
 * rest's install.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the pops file declares each once.
 *
 * ONE DOOR. The pops file takes only the strip's type from MobileTools.ts, so the collapsed flag it keeps is
 * read by the build through the re-export, and that re-export is a live binding: the test below sets the flag
 * through the moved method and reads it through MobileTools.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { installMobileToolsPops } from "./MobileToolsPops";
import * as popsModule from "./MobileToolsPops";
import { MobileTools, collapsedSession } from "./MobileTools";
import stripRaw from "./MobileTools.ts?raw";
import popsRaw from "./MobileToolsPops.ts?raw";

const MOVED = [
	"setMoreOpen",
	"closeInkSliders",
	"setCollapsed",
	"scheduleSliderClose",
	"ownName",
	"attachTip",
	"placePillTip",
	"cancelSliderClose",
	"cancelRecordingHold",
	"cancelPresetHold",
	"cancelTipTimer",
	"applyFoldOrder",
	"stale",
] as const;

const stripSrc = stripRaw.replace(/\r\n/g, "\n");
const popsSrc = popsRaw.replace(/\r\n/g, "\n");

/** A strip with no host, as the other install tests build theirs: the prototype and the fields a call reads. */
function bareStrip(fields: Record<string, unknown>): MobileTools {
	const strip = Object.create(MobileTools.prototype) as MobileTools;
	for (const [key, value] of Object.entries(fields)) {
		Object.defineProperty(strip, key, { value, writable: true, configurable: true });
	}
	return strip;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("pop methods on the strip prototype", () => {
	it("load with the pops file imported first", () => {
		expect(typeof installMobileToolsPops).toBe("function");
		for (const name of MOVED) expect(typeof MobileTools.prototype[name], name).toBe("function");
	});

	it("load in either order from a clean module graph", async () => {
		for (const order of ["strip first", "pops first"]) {
			vi.resetModules();
			if (order === "strip first") {
				await import("./MobileTools");
				await import("./MobileToolsPops");
			} else {
				await import("./MobileToolsPops");
				await import("./MobileTools");
			}
			const { MobileTools: Fresh } = await import("./MobileTools");
			for (const name of MOVED) expect(typeof Fresh.prototype[name], `${name}, ${order}`).toBe("function");
		}
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

	it("each moved name is declared once in the pops file and not in the class", () => {
		const classStart = stripSrc.indexOf("export class MobileTools {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = stripSrc.slice(classStart, stripSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = popsSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: MobileTools\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in MobileToolsPops.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the pen contact test stays in the class", () => {
		expect(stripSrc).toMatch(/^\thasOpenPop\(\): boolean \{/m);
		expect(popsSrc).not.toMatch(/function hasOpenPop\b/);
	});

	it("the strip installs once, after the class closing brace and after the build rest's install", () => {
		const call = "installMobileToolsPops(MobileTools.prototype);";
		expect(stripSrc.split(call).length - 1).toBe(1);
		const classStart = stripSrc.indexOf("export class MobileTools {");
		const classEnd = stripSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		const at = stripSrc.indexOf(call);
		expect(at).toBeGreaterThan(classEnd);
		expect(at).toBeGreaterThan(stripSrc.indexOf("installMobileToolsBuildRest(MobileTools.prototype);"));
	});

	it("the pops file takes only a type from the strip", () => {
		const imports = [...popsSrc.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"\.\/MobileTools";/g)];
		expect(imports.length).toBeGreaterThan(0);
		for (const m of imports) expect(m[1], m[0]).toBeTruthy();
		expect(popsSrc).not.toMatch(/import\s+\{[^}]*\}\s+from\s+"\.\/MobileTools";/);
	});

	it("cancelTipTimer clears a pending timer and nulls it", () => {
		const cleared: unknown[] = [];
		vi.stubGlobal("window", { clearTimeout: (id: unknown) => cleared.push(id) });
		const strip = bareStrip({ tipTimer: 42 });
		strip.cancelTipTimer();
		expect(cleared).toEqual([42]);
		expect((strip as unknown as { tipTimer: number | null }).tipTimer).toBeNull();
		strip.cancelTipTimer();
		expect(cleared, "no timer, nothing to clear").toEqual([42]);
	});

	it("setCollapsed(true) closes the pops once and the flag is read live through MobileTools.ts", () => {
		const calls: string[] = [];
		const toggled: Array<[string, boolean]> = [];
		const strip = bareStrip({
			el: { toggleClass: (c: string, on: boolean) => toggled.push([c, on]) },
			pill: { toggleClass: (c: string, on: boolean) => toggled.push([c, on]) },
			setMoreOpen: (on: boolean) => calls.push(`more ${on}`),
			closeInkSliders: () => {
				calls.push("close");
				return false;
			},
			layoutOverflow: () => calls.push("layout"),
			applyHeaderClearance: () => calls.push("clearance"),
		});
		expect(collapsedSession).toBe(false);
		strip.setCollapsed(true);
		expect(popsModule.collapsedSession).toBe(true);
		expect(collapsedSession, "the re-export reads the moved flag, not a copy").toBe(true);
		expect(calls).toEqual(["more false", "close", "layout", "clearance"]);
		expect(toggled).toEqual([
			["is-collapsed", true],
			["is-showing", true],
		]);
		strip.setCollapsed(false);
		expect(collapsedSession).toBe(false);
	});
});
