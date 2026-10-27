/**
 * The rest of the strip's construction lives in MobileToolsBuildRest.ts and is
 * installed on MobileTools.prototype when MobileTools.ts loads: the pill, grip,
 * collapse and More buttons (buildChrome), the slider pops (buildPops), and the
 * first refresh, layout and resize watch (finishBuild). Four things a type check
 * cannot see are held here, as the install tests of the other split files hold
 * them for theirs.
 *
 * LOAD ORDER. MobileTools.ts imports the install function, and the build file
 * imports values back (collapsedSession, liveStrips, multToPx, paintValue,
 * pxToMult), so the two modules form a cycle. Most tests import MobileTools.ts
 * first. This file imports the build file first, and one cell loads the two in
 * each order from a clean module graph, so a cycle that only works in one order
 * fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when a
 * strip was constructed on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * build file declares each once, so a half-finished move cannot pass with the
 * old copy still shadowing the new one.
 *
 * ONE DOOR. The build file names nothing of the strip beyond the list below.
 *
 * THE CONSTRUCTOR. It keeps its first lines and calls the three methods in the
 * order the text ran in; one cell reads that order off the source and one
 * constructs a strip through the fake host and finds what the three build.
 */
import { describe, expect, it, vi } from "vitest";

import { installMobileToolsBuildRest } from "./MobileToolsBuildRest";
import { MobileTools, type MobileToolsHost } from "./MobileTools";
import { getInlineTool } from "./InkOverlay";
import { clearToolPicked } from "./MouseInk";
import { markPenHardwareSeen, resetPenToolsForTest } from "./PenToolsMode";
import { penInkEnabled, resetPenInkForTest } from "./PenInk";
import { FakeDoc, FakeEl } from "../testUtils/fakeDom";
import stripRaw from "./MobileTools.ts?raw";
import buildRestRaw from "./MobileToolsBuildRest.ts?raw";

const MOVED = ["buildChrome", "buildPops", "finishBuild"] as const;

/** Every name the build file takes from the strip, and nothing else. */
const FROM_STRIP = [
	"MobileTools",
	"MobileToolsHost",
	"MobileToolsOptions",
	"SliderParts",
	"collapsedSession",
	"liveStrips",
	"multToPx",
	"paintValue",
	"pxToMult",
];

const stripSrc = stripRaw.replace(/\r\n/g, "\n");
const buildRestSrc = buildRestRaw.replace(/\r\n/g, "\n");

const host = (): MobileToolsHost => ({
	exec: () => {},
	activeTool: () => getInlineTool(),
	setPlacement: () => {},
	eraserOn: () => false,
	eraserWholeStroke: () => false,
	setEraserWholeStroke: () => {},
	lassoOn: () => false,
	spaceOn: () => false,
	panOn: () => false,
	toolColor: () => "#000000",
	eraserRadiusPx: () => 10,
	setEraserRadiusPx: () => {},
	inkSizeMult: () => 1,
	setInkSizeMult: () => {},
	canUndo: () => false,
	canRedo: () => false,
	canPasteInk: () => false,
	mouseInkOn: () => false,
	armMouseInkQuietly: () => {},
	disarmMouseInkQuietly: () => {},
	toast: () => {},
	recordingOn: () => false,
	hasInkSelection: () => false,
	paletteFor: () => [],
	pickColor: () => {},
	presetsFor: () => [],
	applyPreset: () => {},
	starPreset: () => {},
	forgetPreset: () => {},
	setEditorFocus: () => {},
	penInksHere: () => penInkEnabled(),
	hasTouch: () => true,
});

describe("build methods on the strip prototype", () => {
	it("load with the build file imported first", () => {
		expect(typeof installMobileToolsBuildRest).toBe("function");
		for (const name of MOVED) expect(typeof MobileTools.prototype[name], name).toBe("function");
	});

	it("load in either order from a clean module graph", async () => {
		for (const order of ["strip first", "build first"]) {
			vi.resetModules();
			if (order === "strip first") {
				await import("./MobileTools");
				await import("./MobileToolsBuildRest");
			} else {
				await import("./MobileToolsBuildRest");
				await import("./MobileTools");
			}
			const { MobileTools: Fresh } = await import("./MobileTools");
			for (const name of MOVED) expect(typeof Fresh.prototype[name], `${name}, ${order}`).toBe("function");
		}
	});

	it("the constructor calls the three build methods in order", () => {
		const classStart = stripSrc.indexOf("export class MobileTools {");
		const ctorStart = stripSrc.indexOf("\tconstructor(", classStart);
		expect(ctorStart).toBeGreaterThan(classStart);
		const ctorEnd = stripSrc.indexOf("\n\t}\n", ctorStart);
		expect(ctorEnd).toBeGreaterThan(ctorStart);
		const ctor = stripSrc.slice(ctorStart, ctorEnd);
		const chrome = ctor.indexOf("this.buildChrome(parent, host, opts);");
		const pops = ctor.indexOf("this.buildPops();");
		const finish = ctor.indexOf("this.finishBuild(parent, host, preview);");
		expect(chrome, "buildChrome call").toBeGreaterThan(-1);
		expect(pops, "buildPops call").toBeGreaterThan(chrome);
		expect(finish, "finishBuild call").toBeGreaterThan(pops);
		for (const call of ["this.buildChrome(", "this.buildPops(", "this.finishBuild("]) {
			expect(ctor.split(call).length - 1, call).toBe(1);
		}
	});

	it("a constructed strip has its pill, grip, collapse button, three slider pops and More row", () => {
		resetPenToolsForTest();
		resetPenInkForTest();
		clearToolPicked();
		markPenHardwareSeen();
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = new MobileTools(pane as unknown as HTMLElement, host());
		try {
			expect(strip.el, "the strip element is set by buildChrome").toBeDefined();
			expect(strip.pill, "the pill is set by buildChrome").toBeDefined();
			expect(pane.querySelector(".handwriting-pen-pill")).not.toBeNull();
			expect(pane.querySelector(".handwriting-tools-grip")).not.toBeNull();
			expect(pane.querySelector(".handwriting-tools-collapse")).not.toBeNull();
			expect(pane.querySelector(".handwriting-tools-more")).not.toBeNull();
			expect(pane.querySelector(".handwriting-mobile-tools-more")).not.toBeNull();
			expect(pane.querySelectorAll(".handwriting-slider-pop"), "the eraser, pen and highlighter size pops").toHaveLength(3);
		} finally {
			strip.destroy();
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

	it("each moved name is declared once in the build file and not in the class", () => {
		const classStart = stripSrc.indexOf("export class MobileTools {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = stripSrc.slice(classStart, stripSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = buildRestSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: MobileTools\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in MobileToolsBuildRest.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the strip installs once, after the class closing brace and after the drag, build, paint and layout installs", () => {
		const call = "installMobileToolsBuildRest(MobileTools.prototype);";
		expect(stripSrc.split(call).length - 1).toBe(1);
		const classStart = stripSrc.indexOf("export class MobileTools {");
		const classEnd = stripSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		const at = stripSrc.indexOf(call);
		expect(at).toBeGreaterThan(classEnd);
		for (const earlier of ["Build", "Drag", "Paint", "Layout"]) {
			expect(at, earlier).toBeGreaterThan(stripSrc.indexOf(`installMobileTools${earlier}(MobileTools.prototype);`));
		}
	});

	it("the build file takes exactly the listed names from the strip", () => {
		const imports = [...buildRestSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/MobileTools";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_STRIP].sort());
	});
});
