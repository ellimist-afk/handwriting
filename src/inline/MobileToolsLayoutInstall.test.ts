/**
 * The strip's layout lives in MobileToolsLayout.ts and is installed on
 * MobileTools.prototype when MobileTools.ts loads: the overflow fold, the
 * corner, the header clearance and the transform that places the strip and the
 * pill. Four things a type check cannot see are held here, as the install tests
 * of the other split files hold them for theirs.
 *
 * LOAD ORDER. MobileTools.ts imports the install function, and the layout file
 * imports a value back (foldOrder, a module variable it reads at call time), so
 * the two modules form a cycle. Most tests import MobileTools.ts first. This
 * file imports the layout file first, and one cell loads the two in each order
 * from a clean module graph, so a cycle that only works in one order fails
 * here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when the
 * strip was dragged or the pane resized on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * layout file declares each once, so a half-finished move cannot pass with the
 * old copy still shadowing the new one.
 *
 * ONE DOOR. The layout file names nothing of the strip beyond the list below.
 *
 * The transform and corner cells run the moved text on a bare strip: the
 * transform is the one writer of the strip's and the pill's transform, and a
 * toolbar drag calls it on every pointer move.
 */
import { describe, expect, it, vi } from "vitest";

import { installMobileToolsLayout } from "./MobileToolsLayout";
import { MobileTools } from "./MobileTools";
import { allToolbarCornerClasses, toolbarCornerClass } from "./ToolbarCorner";
import stripRaw from "./MobileTools.ts?raw";
import layoutRaw from "./MobileToolsLayout.ts?raw";

const MOVED = ["layoutOverflow", "setCorner", "applyHeaderClearance", "paintTransform"] as const;

/** Every name the layout file takes from the strip, and nothing else. */
const FROM_STRIP = ["MobileTools", "foldOrder"];

const stripSrc = stripRaw.replace(/\r\n/g, "\n");
const layoutSrc = layoutRaw.replace(/\r\n/g, "\n");

/** A strip with no host, as the other install tests build theirs: the prototype and the fields a call reads. */
function bareStrip(fields: Record<string, unknown>): MobileTools {
	const strip = Object.create(MobileTools.prototype) as MobileTools;
	for (const [key, value] of Object.entries(fields)) {
		Object.defineProperty(strip, key, { value, writable: true, configurable: true });
	}
	return strip;
}

/** An element that records every transform written to it. */
function recorder(): { setCssStyles: (s: { transform: string }) => void; written: string[] } {
	const written: string[] = [];
	return { written, setCssStyles: (s) => void written.push(s.transform) };
}

describe("layout methods on the strip prototype", () => {
	it("load with the layout file imported first", () => {
		expect(typeof installMobileToolsLayout).toBe("function");
		for (const name of MOVED) expect(typeof MobileTools.prototype[name], name).toBe("function");
	});

	it("load in either order from a clean module graph", async () => {
		for (const order of ["strip first", "layout first"]) {
			vi.resetModules();
			if (order === "strip first") {
				await import("./MobileTools");
				await import("./MobileToolsLayout");
			} else {
				await import("./MobileToolsLayout");
				await import("./MobileTools");
			}
			const { MobileTools: Fresh } = await import("./MobileTools");
			for (const name of MOVED) expect(typeof Fresh.prototype[name], `${name}, ${order}`).toBe("function");
		}
	});

	it("paintTransform writes the dodge plus the drag offset to the strip and the pill, with a lift while a drag has moved", () => {
		const el = recorder();
		const pill = recorder();
		const strip = bareStrip({ el, pill, dodge: { x: 1, y: 2 }, dragOffset: { x: 3, y: 4 }, drag: null });
		strip.paintTransform();
		expect(el.written).toEqual(["translate(4px, 6px)"]);
		expect(pill.written).toEqual(["translate(4px, 6px)"]);

		(strip as unknown as { drag: unknown }).drag = { moved: true };
		strip.paintTransform();
		expect(el.written.at(-1)).toBe("translate(4px, 6px) scale(1.04)");
		expect(pill.written.at(-1)).toBe("translate(4px, 6px) scale(1.04)");

		(strip as unknown as { drag: unknown }).drag = { moved: false };
		strip.paintTransform();
		expect(el.written.at(-1), "a drag that has not moved adds no lift").toBe("translate(4px, 6px)");
	});

	it("paintTransform clears the transform when nothing offsets the strip and nothing lifts it", () => {
		const el = recorder();
		const pill = recorder();
		const strip = bareStrip({ el, pill, dodge: { x: 0, y: 0 }, dragOffset: { x: 0, y: 0 }, drag: null });
		strip.paintTransform();
		expect(el.written).toEqual([""]);
		expect(pill.written).toEqual([""]);

		(strip as unknown as { drag: unknown }).drag = { moved: true };
		strip.paintTransform();
		expect(el.written.at(-1), "a lift alone is still a transform").toBe("translate(0px, 0px) scale(1.04)");
	});

	it("setCorner stores the corner, leaves exactly its class of the corner classes on the strip and the pill, and clears the header once", () => {
		const classed = () => {
			const classes = new Set<string>(["keep", ...allToolbarCornerClasses()]);
			return {
				classes,
				classList: {
					remove: (c: string) => void classes.delete(c),
					add: (c: string) => void classes.add(c),
					contains: (c: string) => classes.has(c),
				},
			};
		};
		const el = classed();
		const pill = classed();
		const collapseBtn = {
			empty: vi.fn(),
			querySelector: () => ({}),
			setText: vi.fn(),
			createSpan: vi.fn(),
			dataset: {} as Record<string, string>,
		};
		const applyHeaderClearance = vi.fn();
		const strip = bareStrip({ el, pill, collapseBtn, corner: "top-right", applyHeaderClearance });

		strip.setCorner("bottom-left");

		expect(strip.corner).toBe("bottom-left");
		const want = toolbarCornerClass("bottom-left");
		for (const [name, side] of [["strip", el], ["pill", pill]] as const) {
			expect([...side.classes].filter((c) => allToolbarCornerClasses().includes(c)), name).toEqual([want]);
			expect(side.classes.has("keep"), `${name} keeps its other classes`).toBe(true);
		}
		expect(collapseBtn.empty).toHaveBeenCalledTimes(1);
		expect(applyHeaderClearance).toHaveBeenCalledTimes(1);
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

	it("each moved name is declared once in the layout file and not in the class", () => {
		const classStart = stripSrc.indexOf("export class MobileTools {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = stripSrc.slice(classStart, stripSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = layoutSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: MobileTools\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in MobileToolsLayout.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the strip installs once, after the class closing brace and after the drag, build and paint installs", () => {
		const call = "installMobileToolsLayout(MobileTools.prototype);";
		expect(stripSrc.split(call).length - 1).toBe(1);
		const classStart = stripSrc.indexOf("export class MobileTools {");
		const classEnd = stripSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		const at = stripSrc.indexOf(call);
		expect(at).toBeGreaterThan(classEnd);
		for (const earlier of ["Build", "Drag", "Paint"]) {
			expect(at, earlier).toBeGreaterThan(stripSrc.indexOf(`installMobileTools${earlier}(MobileTools.prototype);`));
		}
	});

	it("the layout file takes exactly the listed names from the strip", () => {
		const imports = [...layoutSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/MobileTools";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_STRIP].sort());
	});
});
