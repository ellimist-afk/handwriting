/**
 * The strip's drag to anchor lives in MobileToolsDrag.ts and is installed on
 * MobileTools.prototype when MobileTools.ts loads. Four things a type check
 * cannot see are held here, as the install tests of the other split files hold
 * them for theirs.
 *
 * LOAD ORDER. MobileTools.ts imports the install function, and the drag file
 * imports a value back (ANCHOR_FLIGHT_MS), so the two modules form a cycle.
 * Every other test imports MobileTools.ts first. This file imports the drag
 * file first, so a cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with
 * the descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when a
 * drag ran on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * drag file declares each once, so a half-finished move cannot pass with the
 * old copy still shadowing the new one.
 *
 * ONE DOOR. The drag file names nothing of the strip beyond the list below.
 */
import { describe, expect, it, vi } from "vitest";

import { installMobileToolsDrag } from "./MobileToolsDrag";
import { MobileTools } from "./MobileTools";
import stripRaw from "./MobileTools.ts?raw";
import dragRaw from "./MobileToolsDrag.ts?raw";

const MOVED = [
	"armDrag",
	"visibleBox",
	"dropDrag",
	"flyInto",
	"endAnchorFlight",
	"cancelDrag",
	"consumeDragClick",
] as const;

/** Every name the drag file takes from the strip, and nothing else. */
const FROM_STRIP = ["ANCHOR_FLIGHT_MS", "MobileTools", "ToolbarDragState"];

const stripSrc = stripRaw.replace(/\r\n/g, "\n");
const dragSrc = dragRaw.replace(/\r\n/g, "\n");

/** A strip with no host, as the other install tests build theirs: the prototype and the fields a call reads. */
function bareStrip(fields: Record<string, unknown>): MobileTools {
	const strip = Object.create(MobileTools.prototype) as MobileTools;
	for (const [key, value] of Object.entries(fields)) {
		Object.defineProperty(strip, key, { value, writable: true, configurable: true });
	}
	return strip;
}

describe("drag methods on the strip prototype", () => {
	it("load with the drag file imported first, and moved methods run on a bare strip", () => {
		expect(typeof installMobileToolsDrag).toBe("function");

		const unarmed = bareStrip({ dragClickArmed: false });
		expect(unarmed.consumeDragClick()).toBe(false);
		expect(unarmed.dragClickArmed).toBe(false);
		const armed = bareStrip({ dragClickArmed: true });
		expect(armed.consumeDragClick()).toBe(true);
		expect(armed.dragClickArmed).toBe(false);
		expect(armed.consumeDragClick()).toBe(false);

		let collapsed = false;
		const el = { classList: { contains: (c: string) => c === "is-collapsed" && collapsed } } as unknown as HTMLElement;
		const pill = {} as HTMLElement;
		const strip = bareStrip({ el, pill });
		expect(strip.visibleBox()).toBe(el);
		collapsed = true;
		expect(strip.visibleBox()).toBe(pill);
	});

	it("endAnchorFlight clears the flight timer and the anchoring class on the strip and the pill", () => {
		const removed: string[] = [];
		const mark = (name: string) => ({ removeClass: (c: string) => removed.push(`${name}:${c}`) });
		const clear = vi.fn();
		vi.stubGlobal("window", { clearTimeout: clear });
		try {
			const idle = bareStrip({ el: mark("el"), pill: mark("pill"), anchorTimer: null });
			idle.endAnchorFlight();
			expect(clear).not.toHaveBeenCalled();
			expect(removed).toEqual(["el:is-anchoring", "pill:is-anchoring"]);
			expect(idle.anchorTimer).toBeNull();

			removed.length = 0;
			const flying = bareStrip({ el: mark("el"), pill: mark("pill"), anchorTimer: 42 });
			flying.endAnchorFlight();
			expect(clear).toHaveBeenCalledWith(42);
			expect(removed).toEqual(["el:is-anchoring", "pill:is-anchoring"]);
			expect(flying.anchorTimer).toBeNull();
		} finally {
			vi.unstubAllGlobals();
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

	it("each moved name is declared once in the drag file and not in the class", () => {
		const classStart = stripSrc.indexOf("export class MobileTools {");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = stripSrc.slice(classStart, stripSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = dragSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: MobileTools\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in MobileToolsDrag.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public |protected )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the strip installs once, after the class closing brace, followed only by the other prototype installs", () => {
		const call = "installMobileToolsDrag(MobileTools.prototype);";
		expect(stripSrc.split(call).length - 1).toBe(1);
		const classStart = stripSrc.indexOf("export class MobileTools {");
		const classEnd = stripSrc.indexOf("\n}\n", classStart);
		expect(classEnd).toBeGreaterThan(classStart);
		expect(stripSrc.indexOf(call)).toBeGreaterThan(classEnd);
		const after = stripSrc.slice(stripSrc.indexOf(call) + call.length).split("\n").map((l) => l.trim()).filter(Boolean);
		for (const line of after) expect(line, "only a prototype install may follow").toMatch(/^installMobileTools\w+\(MobileTools\.prototype\);$/);
	});

	it("the drag file takes exactly the listed names from the strip", () => {
		const imports = [...dragSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/MobileTools";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_STRIP].sort());
	});
});
