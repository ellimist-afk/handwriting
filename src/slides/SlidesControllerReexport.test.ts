/**
 * The slides ink controller lives in SlidesController.ts and
 * SlidesInkSurface.ts re-exports it, so every importer keeps its import line.
 * Four things a type check cannot see are held here.
 *
 * LOAD. SlidesController.ts is imported first and alone. It takes the deck class
 * back from the surface file, so the two modules form a cycle. Every other test
 * imports the surface first; a cycle that only works in that order fails here,
 * at load.
 *
 * ONE COPY. Each moved name must be the very same function or set from both
 * files. The teardown drains are the case that matters: the deck pushes into the
 * set and the controller waits on it, and two sets would let a shutdown report
 * settled with a write still in flight. They are compared by identity.
 *
 * THE DOOR. The new file exports exactly the names the surface re-exports, so
 * the module state and the three private helpers stay private to it.
 *
 * NO BODY LEFT BEHIND. The surface file holds no declaration of a moved name,
 * and the new file holds exactly one of each, so a half-finished move cannot
 * pass with the old copy still shadowing the new one.
 */
import { describe, expect, it, vi } from "vitest";

import { codeOnly } from "../CodeOnly";
import * as controller from "./SlidesController";
import * as surface from "./SlidesInkSurface";
import surfaceRaw from "./SlidesInkSurface.ts?raw";
import controllerRaw from "./SlidesController.ts?raw";

const MOVED_VALUES = [
	"drains",
	"log",
	"now",
	"describe",
	"isTextEntryElement",
	"scanForSlides",
	"onSlidesCssChange",
	"slidesInkEnabled",
	"slidesReloadCandidate",
	"reloadSlidesExternal",
	"settleSlidesInk",
	"setSlidesInk",
	"activeSlidesActions",
] as const;

const surfaceSrc = surfaceRaw.replace(/\r\n/g, "\n");
const controllerSrc = controllerRaw.replace(/\r\n/g, "\n");

function declarations(source: string, name: string): number {
	const text = source.replace(/\r\n/g, "\n");
	return text.match(new RegExp(`^(?:export )?(?:async )?(?:function|const|let|interface|type) ${name}\\b`, "gm"))?.length ?? 0;
}

describe("the controller lives in SlidesController.ts", () => {
	it("loads with the new file imported first, and answers its idle state", async () => {
		expect(controller.slidesInkEnabled()).toBe(false);
		expect(controller.slidesReloadCandidate()).toBeNull();
		expect(controller.activeSlidesActions({} as Document)).toBeNull();
		expect(() => controller.scanForSlides()).not.toThrow();
		expect(controller.slidesInkEnabled()).toBe(false);
		await expect(controller.settleSlidesInk(0)).resolves.toBe(true);
	});

	it("writes a log line through console.debug with the slides prefix", () => {
		const spy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
		try {
			controller.log("x");
			expect(spy).toHaveBeenCalledWith("[slides] x");
		} finally {
			spy.mockRestore();
		}
	});

	it("reads the clock as a number", () => {
		expect(typeof controller.now()).toBe("number");
	});

	it("describes an element by its tag, id and classes", () => {
		const el = { tagName: "DIV", id: "box", className: "one two" } as unknown as Element;
		expect(controller.describe(el)).toBe("div#box.one.two");
		expect(controller.describe({ tagName: "SPAN", id: "", className: "" } as unknown as Element)).toBe("span");
	});

	it("tells a text field from a plain element", () => {
		const as = (fields: object): Element => fields as unknown as Element;
		expect(controller.isTextEntryElement(as({ tagName: "INPUT" }))).toBe(true);
		expect(controller.isTextEntryElement(as({ tagName: "DIV", isContentEditable: true }))).toBe(true);
		expect(controller.isTextEntryElement(as({ tagName: "DIV" }))).toBe(false);
	});

	it("is re-exported from the surface file as the same value, name by name", () => {
		const fromSurface = surface as unknown as Record<string, unknown>;
		const fromController = controller as unknown as Record<string, unknown>;
		for (const name of MOVED_VALUES) {
			expect(fromController[name], `${name} is not exported by SlidesController.ts`).toBeDefined();
			expect(fromSurface[name], `${name} is not the same value from both files`).toBe(fromController[name]);
		}
	});

	it("shares one set of teardown drains between both names", () => {
		expect(surface.drains).toBe(controller.drains);
		const probe = Promise.resolve();
		controller.drains.add(probe);
		expect(surface.drains.has(probe)).toBe(true);
		controller.drains.delete(probe);
		expect(surface.drains.has(probe)).toBe(false);
	});

	it("exports exactly the thirteen moved names, so the module state and helpers stay private", () => {
		expect(Object.keys(controller).sort()).toEqual([...MOVED_VALUES].sort());
	});
});

describe("no declaration is left behind in SlidesInkSurface.ts", () => {
	it("declares each moved name once in the new file and never in the surface file", () => {
		for (const name of MOVED_VALUES) {
			expect(declarations(controllerSrc, name), `${name} in SlidesController.ts`).toBe(1);
			expect(declarations(surfaceSrc, name), `${name} in SlidesInkSurface.ts`).toBe(0);
		}
	});

	it("matches a name exactly, not as the start of a longer one", () => {
		const text = "export function nowhere(): void {\n}\nexport function now(): number {\n";
		expect(declarations(text, "no")).toBe(0);
		expect(declarations(text, "now")).toBe(1);
	});

	it("re-exports by name from the new file, never with a star", () => {
		const surfaceText = codeOnly(surfaceSrc);
		expect(surfaceText).toMatch(/^export \{[^}]*\} from "\.\/SlidesController";/m);
		expect(surfaceText).not.toMatch(/export\s*\*\s*from\s*["']\.\/SlidesController/);
	});

	it("keeps the controller banner above the re-export, after every install", () => {
		const banner = "// ---- module-level controller";
		const at = surfaceSrc.indexOf(banner);
		expect(at).toBeGreaterThan(-1);
		expect(surfaceSrc.split(banner).length - 1).toBe(1);
		expect(at).toBeGreaterThan(surfaceSrc.lastIndexOf("(SlidesDeck.prototype);"));
		expect(at).toBeLessThan(surfaceSrc.lastIndexOf('} from "./SlidesController";'));
	});
});
