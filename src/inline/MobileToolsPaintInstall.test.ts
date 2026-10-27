/**
 * The strip's refresh and paint live in MobileToolsPaint.ts and are installed on
 * MobileTools.prototype when MobileTools.ts loads. Four things a type check
 * cannot see are held here, as the install tests of the other split files hold
 * them for theirs.
 *
 * LOAD ORDER. MobileTools.ts imports the install function, and the paint file
 * imports values back (eraserEdge, multToPx, paintValue), so the two modules
 * form a cycle. Most tests import MobileTools.ts first. This file imports the
 * paint file first, and one cell loads the two in each order from a clean
 * module graph, so a cycle that only works in one order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when a
 * pen contact refreshed the strip on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * paint file declares each once, so a half-finished move cannot pass with the
 * old copy still shadowing the new one.
 *
 * ONE DOOR. The paint file names nothing of the strip beyond the list below.
 *
 * The refresh cell is the pen contact path: the microtask after every contact
 * asks for one frame, a second ask while it waits adds none, and the frame
 * clears the flag and paints once.
 */
import { describe, expect, it, vi } from "vitest";

import { installMobileToolsPaint } from "./MobileToolsPaint";
import { MobileTools } from "./MobileTools";
import stripRaw from "./MobileTools.ts?raw";
import paintRaw from "./MobileToolsPaint.ts?raw";

const MOVED = ["refresh", "refreshNow", "paintPresets", "paintSwatches"] as const;

/** Every name the paint file takes from the strip, and nothing else. */
const FROM_STRIP = ["MobileTools", "SliderParts", "eraserEdge", "multToPx", "paintValue"];

const stripSrc = stripRaw.replace(/\r\n/g, "\n");
const paintSrc = paintRaw.replace(/\r\n/g, "\n");

/** A strip with no host, as the other install tests build theirs: the prototype and the fields a call reads. */
function bareStrip(fields: Record<string, unknown>): MobileTools {
	const strip = Object.create(MobileTools.prototype) as MobileTools;
	for (const [key, value] of Object.entries(fields)) {
		Object.defineProperty(strip, key, { value, writable: true, configurable: true });
	}
	return strip;
}

describe("paint methods on the strip prototype", () => {
	it("load with the paint file imported first", () => {
		expect(typeof installMobileToolsPaint).toBe("function");
		for (const name of MOVED) expect(typeof MobileTools.prototype[name], name).toBe("function");
	});

	it("load in either order from a clean module graph", async () => {
		for (const order of ["strip first", "paint first"]) {
			vi.resetModules();
			if (order === "strip first") {
				await import("./MobileTools");
				await import("./MobileToolsPaint");
			} else {
				await import("./MobileToolsPaint");
				await import("./MobileTools");
			}
			const { MobileTools: Fresh } = await import("./MobileTools");
			for (const name of MOVED) expect(typeof Fresh.prototype[name], `${name}, ${order}`).toBe("function");
		}
	});

	it("refresh asks the strip's window for one frame, and the frame clears the flag and paints once", () => {
		const frames: Array<() => void> = [];
		const win = {
			requestAnimationFrame: (cb: () => void): number => {
				frames.push(cb);
				return frames.length;
			},
		};
		const el = { ownerDocument: { defaultView: win } };
		const refreshNow = vi.fn();
		const strip = bareStrip({ el, refreshQueued: false, refreshNow });

		strip.refresh();
		expect(frames).toHaveLength(1);
		expect(strip.refreshQueued).toBe(true);

		strip.refresh();
		strip.refresh();
		expect(frames, "a call while one is queued asks for no second frame").toHaveLength(1);
		expect(refreshNow).not.toHaveBeenCalled();

		frames[0]!();
		expect(strip.refreshQueued).toBe(false);
		expect(refreshNow).toHaveBeenCalledTimes(1);

		strip.refresh();
		expect(frames, "after the frame ran, the next call queues again").toHaveLength(2);
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

	it("each moved name is declared once in the paint file and not in the class", () => {
		const classStart = stripSrc.indexOf("export class MobileTools {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = stripSrc.slice(classStart, stripSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = paintSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: MobileTools\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in MobileToolsPaint.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the strip installs once, after the class closing brace and after the drag and build installs", () => {
		const call = "installMobileToolsPaint(MobileTools.prototype);";
		expect(stripSrc.split(call).length - 1).toBe(1);
		const classStart = stripSrc.indexOf("export class MobileTools {");
		const classEnd = stripSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		const at = stripSrc.indexOf(call);
		expect(at).toBeGreaterThan(classEnd);
		expect(at).toBeGreaterThan(stripSrc.indexOf("installMobileToolsBuild(MobileTools.prototype);"));
		expect(at).toBeGreaterThan(stripSrc.indexOf("installMobileToolsDrag(MobileTools.prototype);"));
	});

	it("the paint file takes exactly the listed names from the strip", () => {
		const imports = [...paintSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/MobileTools";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_STRIP].sort());
	});
});
