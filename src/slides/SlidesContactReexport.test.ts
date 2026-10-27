/**
 * The slides surface's contact and eraser helpers live in SlidesContact.ts and
 * SlidesInkSurface.ts re-exports them, so every importer keeps its import line.
 * Four things a type check cannot see are held here.
 *
 * LOAD. SlidesContact.ts is imported first and alone. It takes three hoisted
 * declarations back from the surface file (the screen mapping, the screen
 * rectangle type and the slide scale), so the two modules form a cycle. Every
 * other test imports the surface first; a cycle that only works in that order
 * fails here, at load.
 *
 * ONE COPY. Each moved value must be the very same function, constant or array
 * from both files, not a second definition that happens to behave alike.
 *
 * THE LITERALS. The surface tests compare the tap and tail windows through the
 * constants, and loop over the two event lists, so changing a number or
 * dropping a name from a list would shrink or move the comparison with it. The
 * numbers and both lists are pinned here on the new module.
 *
 * NO BODY LEFT BEHIND. The surface file holds no declaration of a moved name,
 * and the new file holds exactly one of each, so a half-finished move cannot
 * pass with the old copy still shadowing the new one.
 */
import { describe, expect, it } from "vitest";

import { codeOnly } from "../CodeOnly";
import * as contact from "./SlidesContact";
import * as surface from "./SlidesInkSurface";
import surfaceRaw from "./SlidesInkSurface.ts?raw";
import contactRaw from "./SlidesContact.ts?raw";

const MOVED_VALUES = [
	"TAP_SLOP_PX",
	"TAP_MS",
	"contactBecameStroke",
	"PEN_GUARDED_EVENTS",
	"PEN_CONTACT_GUARDED_EVENTS",
	"PEN_GUARD_TAIL_MS",
	"PEN_NEAR_TAIL_MS",
	"PEN_RELEASE_TAIL_MS",
	"PALM_CONTACT_SWALLOW_PX",
	"isPenHoverEvent",
	"penIsNear",
	"withinPalmReleaseTail",
	"palmShapedContact",
	"suppressDeckContextMenu",
	"swallowDuringPenContact",
	"claimsContact",
	"isEraserContact",
	"eraserIntent",
	"slideEraseCircle",
	"eraserHitsInSlide",
	"partialEraseInSlide",
] as const;

const MOVED_TYPES = ["SlideEraseCircle"] as const;

/** Every name the new file takes from the surface, and nothing else. */
const FROM_SURFACE = ["mapScreenToSlide", "ScreenRect", "slideScale"];

function declarations(source: string, name: string): number {
	const text = source.replace(/\r\n/g, "\n");
	return text.match(new RegExp(`^(?:export )?(?:function|const|interface|type) ${name}\\b`, "gm"))?.length ?? 0;
}

describe("the contact and eraser helpers live in SlidesContact.ts", () => {
	it("holds the tap, tail and palm numbers on the new module", () => {
		expect(contact.TAP_SLOP_PX).toBe(6);
		expect(contact.TAP_MS).toBe(250);
		expect(contact.PEN_GUARD_TAIL_MS).toBe(300);
		expect(contact.PEN_NEAR_TAIL_MS).toBe(300);
		expect(contact.PEN_RELEASE_TAIL_MS).toBe(250);
		expect(contact.PALM_CONTACT_SWALLOW_PX).toBe(32);
	});

	it("holds both guarded event lists as exact arrays of seven", () => {
		expect([...contact.PEN_GUARDED_EVENTS]).toEqual([
			"click",
			"auxclick",
			"dblclick",
			"pointerup",
			"touchstart",
			"touchmove",
			"touchend",
		]);
		expect([...contact.PEN_CONTACT_GUARDED_EVENTS]).toEqual([
			"pointerdown",
			"pointermove",
			"pointerup",
			"pointercancel",
			"touchstart",
			"touchmove",
			"touchend",
		]);
	});

	it("loads with the new file imported first, and one real call per predicate answers", () => {
		expect(contact.contactBecameStroke(0, 0, 10)).toBe(false);
		expect(contact.contactBecameStroke(7, 0, 1)).toBe(true);
		expect(contact.contactBecameStroke(0, 0, contact.TAP_MS + 1)).toBe(true);

		expect(contact.claimsContact("mouse", true, 1, false)).toBe(false);
		expect(contact.claimsContact("mouse", true, 1, true)).toBe(true);
		expect(contact.claimsContact("pen", true, 0, false)).toBe(true);
		expect(contact.claimsContact("touch", true, 1, true)).toBe(false);

		expect(contact.isEraserContact(32, 0)).toBe(true);
		expect(contact.isEraserContact(0, 5)).toBe(true);
		expect(contact.isEraserContact(1, 0)).toBe(false);

		expect(contact.palmShapedContact(40, 10)).toBe(true);
		expect(contact.palmShapedContact(contact.PALM_CONTACT_SWALLOW_PX, 0)).toBe(true);
		expect(contact.palmShapedContact(contact.PALM_CONTACT_SWALLOW_PX - 1, 0)).toBe(false);
		expect(contact.palmShapedContact(undefined, undefined)).toBe(false);

		expect(
			contact.suppressDeckContextMenu({ penDown: false, strokeLive: false, penNear: false, pointerType: "pen" })
		).toBe(true);
		expect(
			contact.suppressDeckContextMenu({ penDown: false, strokeLive: false, penNear: false, pointerType: "touch" })
		).toBe(false);
	});

	it("is re-exported from the surface file as the same value, name by name", () => {
		const fromSurface = surface as unknown as Record<string, unknown>;
		const fromContact = contact as unknown as Record<string, unknown>;
		for (const name of MOVED_VALUES) {
			expect(fromContact[name], `${name} is not exported by SlidesContact.ts`).toBeDefined();
			expect(fromSurface[name], `${name} is not the same value from both files`).toBe(fromContact[name]);
		}
		expect(surface.PEN_GUARDED_EVENTS).toBe(contact.PEN_GUARDED_EVENTS);
		expect(surface.PEN_CONTACT_GUARDED_EVENTS).toBe(contact.PEN_CONTACT_GUARDED_EVENTS);
	});

	it("keeps the moved type importable from the surface file", () => {
		// A 200 px wide rect for a 100 unit wide slide: a scale of 2, so 8 px is a radius of 4.
		const rect: surface.ScreenRect = { left: 10, top: 20, width: 200, height: 100 };
		const circle: surface.SlideEraseCircle = contact.slideEraseCircle(30, 60, rect, 100, 8);
		const same: contact.SlideEraseCircle = circle;
		expect(same).toEqual({ x: 10, y: 20, r: 4 });
		expect(MOVED_TYPES).toHaveLength(1);
	});
});

describe("no declaration is left behind in SlidesInkSurface.ts", () => {
	it("declares each moved name once in the new file and never in the surface file", () => {
		for (const name of [...MOVED_VALUES, ...MOVED_TYPES]) {
			expect(declarations(contactRaw, name), `${name} in SlidesContact.ts`).toBe(1);
			expect(declarations(surfaceRaw, name), `${name} in SlidesInkSurface.ts`).toBe(0);
		}
	});

	it("matches a name exactly, not as the start of a longer one", () => {
		const text = "export function penIsNear(): boolean {\n}\nexport const TAP_MS = 250;\n";
		expect(declarations(text, "penIs")).toBe(0);
		expect(declarations(text, "penIsNear")).toBe(1);
		expect(declarations(text, "TAP_MS")).toBe(1);
	});

	it("re-exports by name from the new file, never with a star", () => {
		const surfaceText = codeOnly(surfaceRaw.replace(/\r\n/g, "\n"));
		expect(surfaceText).toMatch(/^export \{[^}]*\} from "\.\/SlidesContact";/m);
		expect(surfaceText).toMatch(/^export type \{[^}]*\} from "\.\/SlidesContact";/m);
		expect(surfaceText).not.toMatch(/export\s*\*\s*from\s*["']\.\/SlidesContact/);
	});
});

describe("SlidesContact.ts takes exactly three names from the surface", () => {
	it("lists them", () => {
		const text = codeOnly(contactRaw.replace(/\r\n/g, "\n"));
		const imports = [...text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/SlidesInkSurface";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual([...FROM_SURFACE].sort());
	});
});
