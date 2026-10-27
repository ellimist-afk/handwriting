/**
 * The slides surface's load and persistence methods live in SlidesPersistence.ts
 * and are installed on SlidesDeck.prototype when SlidesInkSurface.ts loads. Four
 * things a type check cannot see are held here, as the install tests of the other
 * split files hold them for theirs.
 *
 * LOAD ORDER. SlidesInkSurface.ts imports the install function, and the
 * persistence file imports a value back (the logger), so the two modules form a
 * cycle. Every other test imports SlidesInkSurface.ts first. This file imports the
 * persistence file first, so a cycle that only works in the usual order fails
 * here, at load.
 *
 * THE INSTALL. Each moved name must be an own property of the prototype with the
 * descriptor a class method has. A name left out of the install still
 * type-checks, because the interface declares it, and would only fail when that
 * load or save path ran on a device.
 *
 * NO BODY LEFT BEHIND. The surface file holds no declaration of a moved name, and
 * the persistence file holds exactly one of each, so a half-finished move cannot
 * pass with the old copy still shadowing the new one.
 *
 * ONE DOOR. The persistence file names nothing of the surface but the deck type
 * and the logger.
 */
import { describe, expect, it, vi } from "vitest";

import { installSlidesPersistence } from "./SlidesPersistence";
import { SlidesDeck } from "./SlidesInkSurface";
import surfaceRaw from "./SlidesInkSurface.ts?raw";
import persistenceRaw from "./SlidesPersistence.ts?raw";

const MOVED = [
	"startInitialLoad",
	"loadSidecar",
	"finishLoad",
	"adoptSidecar",
	"noteMemoryOnly",
	"persist",
	"snapshot",
	"save",
	"noticeSaveFailure",
	"noticeReadOnly",
	"noticeTransient",
	"stale",
	"inFlightWork",
	"reloadCandidateSidecarId",
	"reloadExternal",
	"strokeFingerprint",
] as const;

const surfaceSrc = surfaceRaw.replace(/\r\n/g, "\n");
const persistenceSrc = persistenceRaw.replace(/\r\n/g, "\n");

/** A deck with no DOM, as the other install tests build one: the prototype and the fields a method reads. */
function bareDeck(): SlidesDeck {
	return Object.create(SlidesDeck.prototype) as SlidesDeck;
}

describe("load and persistence methods on the slides deck prototype", () => {
	it("load with the persistence file imported first, and moved methods run on a bare deck", () => {
		expect(typeof installSlidesPersistence).toBe("function");
		const deck = bareDeck();
		deck.disposed = true;
		deck.draining = true;
		expect(deck.stale()).toBe(false);
		deck.draining = false;
		expect(deck.stale()).toBe(true);

		const claim = Promise.resolve();
		const load = Promise.resolve();
		const drain = Promise.resolve();
		deck.claimInFlight = claim;
		deck.loadInFlight = load;
		deck.teardownDrain = drain;
		expect(deck.inFlightWork()).toEqual([claim, load, drain]);

		const notify = vi.fn();
		deck.saveFailureNoticed = false;
		(deck as unknown as { host: { notify(message: string): void } }).host = { notify };
		deck.noticeSaveFailure();
		deck.noticeSaveFailure();
		expect(notify).toHaveBeenCalledTimes(1);
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

	it("each moved name is declared once in the persistence file and not in the class", () => {
		const classStart = surfaceSrc.indexOf("export class SlidesDeck");
		expect(classStart).toBeGreaterThan(-1);
		const classSrc = surfaceSrc.slice(classStart, surfaceSrc.indexOf("\n}\n", classStart));
		for (const name of MOVED) {
			const inFile =persistenceSrc.match(new RegExp(`^\t(?:async )?function ${name}\\(\\s*this: SlidesDeck\\b`, "gm"));
			expect(inFile?.length ?? 0, `${name} in SlidesPersistence.ts`).toBe(1);
			const inClass = classSrc.match(new RegExp(`^\t(?:private |public )?(?:async )?${name}\\(`, "gm"));
			expect(inClass, `${name} still declared in the class`).toBeNull();
		}
	});

	it("the class calls the install once, after the class and before the module controller", () => {
		const call = "installSlidesPersistence(SlidesDeck.prototype);";
		expect(surfaceSrc.split(call).length - 1).toBe(1);
		const classEnd = surfaceSrc.indexOf("\n}\n", surfaceSrc.indexOf("export class SlidesDeck"));
		expect(surfaceSrc.indexOf(call)).toBeGreaterThan(classEnd);
		expect(surfaceSrc.indexOf(call)).toBeLessThan(surfaceSrc.indexOf("// ---- module-level controller"));
	});

	it("the transient notice constants live in the persistence file only", () => {
		for (const name of ["TRANSIENT_SILENCE_MS", "TRANSIENT_NOTICE", "TRANSIENT_HEALED", "TRANSIENT_GONE"]) {
			expect(persistenceSrc.match(new RegExp(`^const ${name}\\b`, "gm"))?.length ?? 0, name).toBe(1);
			expect(surfaceSrc, name).not.toContain(name);
		}
	});

	it("the persistence file names only the deck type and the logger of the surface", () => {
		const imports = [...persistenceSrc.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"\.\/SlidesInkSurface";/g)];
		expect(imports.length).toBeGreaterThan(0);
		const names = imports
			.flatMap((m) => m[1]!.split(","))
			.map((n) => n.trim().replace(/^type\s+/, ""))
			.filter(Boolean)
			.sort();
		expect(names).toEqual(["SlidesDeck", "log"]);
	});
});
