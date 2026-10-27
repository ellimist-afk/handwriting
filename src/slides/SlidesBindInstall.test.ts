/**
 * The slides surface's binding and teardown live in SlidesBind.ts and are
 * installed on SlidesDeck.prototype when SlidesInkSurface.ts loads. Four things
 * a type check cannot see are held here, as the install tests of the other split
 * files hold them for theirs.
 *
 * LOAD ORDER. SlidesInkSurface.ts imports the install function, and the bind
 * file imports values back (the teardown drains, the logger and the clock, the
 * two guarded event lists, the present index and the deck class), so the two
 * modules form a cycle. Every other test imports SlidesInkSurface.ts first. This
 * file imports the bind file first, so a cycle that only works in the usual
 * order fails here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when that
 * method ran on a device.
 *
 * NO BODY LEFT BEHIND. The class body declares none of the moved names, and the
 * bind file declares each once, so a half-finished move cannot pass with the old
 * copy still shadowing the new one.
 *
 * ONE DOOR. The bind file names nothing of the surface beyond the list below.
 */
import { describe, expect, it } from "vitest";

import { installSlidesBind } from "./SlidesBind";
import { SlidesDeck } from "./SlidesInkSurface";
import { IDLE_SESSION } from "./SlidesStrokeSession";
import surfaceRaw from "./SlidesInkSurface.ts?raw";
import bindRaw from "./SlidesBind.ts?raw";

const MOVED = [
	"bind",
	"armPalmShield",
	"armGestureGuard",
	"armContactGuard",
	"disarmContactGuard",
	"onPresentClassChanged",
	"endStrokeForSlideChange",
	"dispose",
	"drainParkedWrite",
] as const;

/** Every name the bind file takes from the surface, and nothing else. */
const FROM_SURFACE = [
	"drains",
	"log",
	"now",
	"PEN_CONTACT_GUARDED_EVENTS",
	"PEN_GUARDED_EVENTS",
	"presentIndex",
	"SlidesDeck",
];

const surfaceSrc = surfaceRaw.replace(/\r\n/g, "\n");
const bindSrc = bindRaw.replace(/\r\n/g, "\n");

/** A deck with no DOM, as the other install tests build one: the prototype and the fields a method reads. */
function bareDeck(fields: object = {}): SlidesDeck {
	return Object.assign(Object.create(SlidesDeck.prototype) as SlidesDeck, fields);
}

describe("binding and teardown on the slides deck prototype", () => {
	it("load with the bind file imported first, and moved methods run on a bare deck", () => {
		expect(typeof installSlidesBind).toBe("function");

		// A disposed deck answers a class change without touching the sections.
		expect(bareDeck({ disposed: true }).onPresentClassChanged()).toBeUndefined();

		// An armed guard returns at once: nothing is added, nothing is read from the reveal element.
		const armed = bareDeck({ contactGuardArmed: true });
		armed.armContactGuard();
		expect(armed.contactGuardArmed).toBe(true);

		// A disarmed guard returns at once on the way out.
		const idle = bareDeck({ contactGuardArmed: false });
		idle.disarmContactGuard();
		expect(idle.contactGuardArmed).toBe(false);

		// An idle session ends nothing: the rested contact is cleared and the call returns.
		const slide = bareDeck({ restedContact: { stub: true }, session: IDLE_SESSION });
		slide.endStrokeForSlideChange();
		expect(slide.restedContact).toBeNull();
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

	it("each moved name is declared once in the bind file and not in the class", () => {
		const classStart = surfaceSrc.indexOf("export class SlidesDeck");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = surfaceSrc.slice(classStart, surfaceSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile = bindSrc.match(new RegExp(`^\\t(?:async )?function ${name}\\(\\s*this: SlidesDeck\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in SlidesBind.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\\t(?:private |public )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the class installs once, after the pointer path install and before the module controller", () => {
		const call = "installSlidesBind(SlidesDeck.prototype);";
		expect(surfaceSrc.split(call).length - 1).toBe(1);
		const at = surfaceSrc.indexOf(call);
		expect(at).toBeGreaterThan(surfaceSrc.indexOf("installSlidesPointerPath(SlidesDeck.prototype);"));
		expect(at).toBeLessThan(surfaceSrc.indexOf("// ---- module-level controller"));
	});

	it("the bind file takes exactly the listed names from the surface", () => {
		const imports = [...bindSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/SlidesInkSurface";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_SURFACE].sort());
	});
});
