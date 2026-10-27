/**
 * The slides surface's pointer path lives in SlidesPointerPath.ts and is
 * installed on SlidesDeck.prototype when SlidesInkSurface.ts loads. Four things
 * a type check cannot see are held here, as the install tests of the other split
 * files hold them for theirs.
 *
 * LOAD ORDER. SlidesInkSurface.ts imports the install function, and the pointer
 * path file imports values back (the stroke and eraser helpers, the clock and the
 * logger), so the two modules form a cycle. Every other test imports
 * SlidesInkSurface.ts first. This file imports the pointer path file first, so a
 * cycle that only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when that
 * method ran on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * pointer path file declares each once, so a half-finished move cannot pass with
 * the old copy still shadowing the new one.
 *
 * ONE DOOR. The pointer path file names nothing of the surface beyond the list
 * below.
 */
import { describe, expect, it } from "vitest";

import { installSlidesPointerPath } from "./SlidesPointerPath";
import { SlidesDeck } from "./SlidesInkSurface";
import surfaceRaw from "./SlidesInkSurface.ts?raw";
import pathRaw from "./SlidesPointerPath.ts?raw";

const MOVED = [
	"onPointerDown",
	"beginInkAt",
	"eraserRadiusPx",
	"eraseAt",
	"markErased",
	"flushErase",
	"capture",
	"promoteToStroke",
	"startRestedContact",
	"liftAfterRest",
	"onPointerMove",
	"onPointerMoveBody",
	"onPointerEnd",
	"onHoldExpired",
	"syncHoldTimer",
	"endSilentLift",
	"armQuietTimer",
	"clearQuietTimer",
	"onQuietExpired",
	"logStrokeEndFocus",
	"commitStroke",
	"totalStrokes",
] as const;

/** Every name the pointer path file takes from the surface, and nothing else. */
const FROM_SURFACE = [
	"contactBecameStroke",
	"describe",
	"eraserHitsInSlide",
	"eraserIntent",
	"insideRect",
	"Layers",
	"log",
	"mapScreenToSlide",
	"now",
	"partialEraseInSlide",
	"RestedContact",
	"slideEraseCircle",
	// The grid's device px per slide unit at pen-down.
	"slideScale",
	"SlideNib",
	"SlidesDeck",
];

const surfaceSrc = surfaceRaw.replace(/\r\n/g, "\n");
const pathSrc = pathRaw.replace(/\r\n/g, "\n");

/** A deck with no DOM, as the other install tests build one: the prototype and the fields a method reads. */
function bareDeck(): SlidesDeck {
	return Object.create(SlidesDeck.prototype) as SlidesDeck;
}

describe("pointer path on the slides deck prototype", () => {
	it("load with the pointer path file imported first, and a moved method runs on a bare deck", () => {
		expect(typeof installSlidesPointerPath).toBe("function");
		const deck = bareDeck();
		// totalStrokes reads only this.strokes: two lists of 2 and 1 make 3.
		Object.defineProperty(deck, "strokes", {
			value: new Map([
				[0, [{}, {}]],
				[1, [{}]],
			]),
		});
		expect(deck.totalStrokes()).toBe(3);
	});

	it("every moved name is a prototype method with a class method's descriptor", () => {
		for (const name of MOVED) {
			const d = Object.getOwnPropertyDescriptor(SlidesDeck.prototype, name);
			expect(d, `${name} is not on the prototype`).toBeDefined();
			expect(typeof d!.value, name).toBe("function");
			expect(
				{ writable: d!.writable, enumerable: d!.enumerable, configurable: d!.configurable },
				name
			).toEqual({ writable: true, enumerable: false, configurable: true });
		}
	});

	it("each moved name is declared once in the pointer path file and not in the class", () => {
		const classStart = surfaceSrc.indexOf("export class SlidesDeck");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = surfaceSrc.slice(classStart, surfaceSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = pathSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: SlidesDeck\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in SlidesPointerPath.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the class installs once, after the mount install and before the module controller", () => {
		const call = "installSlidesPointerPath(SlidesDeck.prototype);";
		expect(surfaceSrc.split(call).length - 1).toBe(1);
		const at = surfaceSrc.indexOf(call);
		expect(at).toBeGreaterThan(surfaceSrc.indexOf("installSlidesMount(SlidesDeck.prototype);"));
		expect(at).toBeLessThan(surfaceSrc.indexOf("// ---- module-level controller"));
	});

	it("the pointer path file takes exactly the listed names from the surface", () => {
		const imports = [...pathSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/SlidesInkSurface";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names, "slideScale read for the grid").toEqual([...FROM_SURFACE].sort());
	});
});
