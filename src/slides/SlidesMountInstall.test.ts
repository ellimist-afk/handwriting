/**
 * The slides surface's mount, geometry and theme methods live in SlidesMount.ts and
 * are installed on SlidesDeck.prototype when SlidesInkSurface.ts loads. Four things
 * a type check cannot see are held here, as the install tests of the other split
 * files hold them for theirs.
 *
 * LOAD ORDER. SlidesInkSurface.ts imports the install function, and the mount file
 * imports values back (the class names, the deck links, the logger and the geometry
 * helpers), so the two modules form a cycle. Every other test imports
 * SlidesInkSurface.ts first. This file imports the mount file first, so a cycle that
 * only works in the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still type-checks,
 * because the interface declares it, and would only fail when that method ran on a
 * device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * mount file declares each once, so a half-finished move cannot pass with the old
 * copy still shadowing the new one.
 *
 * ONE DOOR. The mount file names nothing of the surface beyond the list below.
 */
import { describe, expect, it } from "vitest";

import { installSlidesMount } from "./SlidesMount";
import { SlidesDeck } from "./SlidesInkSurface";
import surfaceRaw from "./SlidesInkSurface.ts?raw";
import mountRaw from "./SlidesMount.ts?raw";

const MOVED = [
	"remount",
	"mountCanvases",
	"measureDeckTheme",
	"setDeckTheme",
	"onCssChange",
	"win",
	"measureGeometry",
	"geometry",
	"refresh",
	"watchResolution",
	"unwatchResolution",
	"syncGeometry",
	"ensureCanvasesMounted",
	"repaint",
	"dressWet",
] as const;

/** Every name the mount file takes from the surface, and nothing else. */
const FROM_SURFACE = [
	"BLACK_DECK_LINK",
	"COMMITTED_CLASS",
	"DeckGeometry",
	"HeadLike",
	"Layers",
	"SLIDES_DESYNCHRONIZED",
	"SlidesDeck",
	"TAIL_CLASS",
	"WET_CLASS",
	"WHITE_DECK_LINK",
	"describe",
	"log",
	"opaqueRgb",
	"presentIndex",
	"slideCamera",
	"slideScale",
	"slidesBackingScale",
];

const surfaceSrc = surfaceRaw.replace(/\r\n/g, "\n");
const mountSrc = mountRaw.replace(/\r\n/g, "\n");

/** A deck with no DOM, as the other install tests build one: the prototype and the fields a method reads. */
function bareDeck(): SlidesDeck {
	return Object.create(SlidesDeck.prototype) as SlidesDeck;
}

describe("mount, geometry and theme on the slides deck prototype", () => {
	it("load with the mount file imported first, and moved methods run on a bare deck", () => {
		expect(typeof installSlidesMount).toBe("function");

		// geometry() answers from its own geom with no layout read: measureGeometry would throw on a bare deck.
		const deck = bareDeck();
		const geom = { sentinel: true } as unknown as NonNullable<SlidesDeck["geom"]>;
		deck.geom = geom;
		expect(deck.geometry()).toBe(geom);

		// unwatchResolution() removes the listener it armed and nulls both fields.
		const removed: Array<[string, unknown]> = [];
		const fn = () => {};
		deck.mediaQuery = {
			removeEventListener: (type: string, listener: unknown) => removed.push([type, listener]),
		} as unknown as MediaQueryList;
		deck.mediaFn = fn;
		deck.unwatchResolution();
		expect(removed).toEqual([["change", fn]]);
		expect(deck.mediaQuery).toBeNull();
		expect(deck.mediaFn).toBeNull();
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

	it("each moved name is declared once in the mount file and not in the class", () => {
		const classStart = surfaceSrc.indexOf("export class SlidesDeck");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = surfaceSrc.slice(classStart, surfaceSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = mountSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: SlidesDeck\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in SlidesMount.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the class installs once, after the pen guards install and before the module controller", () => {
		const call = "installSlidesMount(SlidesDeck.prototype);";
		expect(surfaceSrc.split(call).length - 1).toBe(1);
		const at = surfaceSrc.indexOf(call);
		expect(at).toBeGreaterThan(surfaceSrc.indexOf("installSlidesPenGuards(SlidesDeck.prototype);"));
		expect(at).toBeLessThan(surfaceSrc.indexOf("// ---- module-level controller"));
	});

	it("the mount file takes exactly the listed names from the surface", () => {
		const imports = [...mountSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/SlidesInkSurface";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_SURFACE].sort());
	});
});
