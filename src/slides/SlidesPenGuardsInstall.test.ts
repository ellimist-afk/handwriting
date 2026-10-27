/**
 * The slides surface's pen and palm guards live in SlidesPenGuards.ts and are
 * installed on SlidesDeck.prototype when SlidesInkSurface.ts loads. Four things
 * a type check cannot see are held here, as the install tests of the other split
 * files hold them for theirs.
 *
 * LOAD ORDER. SlidesInkSurface.ts imports the install function, and the guards
 * file imports values back (the guard predicates, the clock and the logger), so
 * the two modules form a cycle. Every other test imports SlidesInkSurface.ts
 * first. This file imports the guards file first, so a cycle that only works in
 * the usual order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when that
 * guard ran on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * guards file declares each once, so a half-finished move cannot pass with the
 * old copy still shadowing the new one.
 *
 * ONE DOOR. The guards file names nothing of the surface beyond the list below.
 */
import { describe, expect, it } from "vitest";

import { installSlidesPenGuards } from "./SlidesPenGuards";
import { SlidesDeck } from "./SlidesInkSurface";
import surfaceRaw from "./SlidesInkSurface.ts?raw";
import guardsRaw from "./SlidesPenGuards.ts?raw";

const MOVED = [
	"controlEvent",
	"claims",
	"onGuardedEvent",
	"penOwnsGlass",
	"onDeckContextMenu",
	"armPenGuard",
	"clearGuardTimers",
	"releasePenGuard",
	"holdPenGuard",
	"dropPenGuard",
	"ensureDeckFocused",
	"logDeckTookFocus",
] as const;

/** Every name the guards file takes from the surface, and nothing else. */
const FROM_SURFACE = [
	"PEN_CONTACT_GUARDED_EVENTS",
	"PEN_GUARD_TAIL_MS",
	"SlidesDeck",
	"claimsContact",
	"describe",
	"isPenHoverEvent",
	"isTextEntryElement",
	"log",
	"now",
	"palmShapedContact",
	"penIsNear",
	"suppressDeckContextMenu",
	"swallowDuringPenContact",
	"withinPalmReleaseTail",
];

const surfaceSrc = surfaceRaw.replace(/\r\n/g, "\n");
const guardsSrc = guardsRaw.replace(/\r\n/g, "\n");

/** A deck with no DOM, as the other install tests build one: the prototype and the fields a method reads. */
function bareDeck(): SlidesDeck {
	return Object.create(SlidesDeck.prototype) as SlidesDeck;
}

describe("pen and palm guards on the slides deck prototype", () => {
	it("load with the guards file imported first, and moved methods run on a bare deck", () => {
		expect(typeof installSlidesPenGuards).toBe("function");
		const deck = bareDeck();
		deck.penContact = true;
		deck.penStroke = true;
		deck.guardPointerId = 7;
		deck.dropPenGuard();
		expect(deck.penContact).toBe(false);
		expect(deck.penStroke).toBe(false);
		expect(deck.guardPointerId).toBeNull();

		deck.penContact = false;
		deck.lastPenHoverAt = 0;
		deck.lastPenLiftAt = 0;
		expect(deck.penOwnsGlass(1_000_000)).toBe(false);
		deck.penContact = true;
		expect(deck.penOwnsGlass(1_000_000)).toBe(true);
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

	it("each moved name is declared once in the guards file and not in the class", () => {
		const classStart = surfaceSrc.indexOf("export class SlidesDeck");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = surfaceSrc.slice(classStart, surfaceSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = guardsSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: SlidesDeck\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in SlidesPenGuards.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the class installs once, after the persistence install and before the module controller", () => {
		const call = "installSlidesPenGuards(SlidesDeck.prototype);";
		expect(surfaceSrc.split(call).length - 1).toBe(1);
		const at = surfaceSrc.indexOf(call);
		expect(at).toBeGreaterThan(surfaceSrc.indexOf("installSlidesPersistence(SlidesDeck.prototype);"));
		expect(at).toBeLessThan(surfaceSrc.indexOf("// ---- module-level controller"));
	});

	it("the guards file takes exactly the listed names from the surface", () => {
		const imports = [...guardsSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/SlidesInkSurface";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_SURFACE].sort());
	});
});
