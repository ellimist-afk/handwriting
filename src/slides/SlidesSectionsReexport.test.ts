/**
 * The slide-section functions live in SlidesSections.ts and SlidesInkSurface.ts
 * re-exports them, so every importer keeps its import line. Three things a type
 * check cannot see are held here, in the way the install tests of the other split
 * files hold theirs for a prototype install.
 *
 * LOAD. SlidesSections.ts is imported first and alone, so a dependency that only
 * resolves once the surface file has loaded fails here, at load.
 *
 * ONE COPY. Each moved name must be the very same function or constant from both
 * files, not a second definition that happens to behave alike.
 *
 * NO BODY LEFT BEHIND. The surface file holds no declaration of a moved name, and
 * the new file holds exactly one of each, so a half-finished move cannot pass
 * with the old copy still shadowing the new one.
 */
import { describe, expect, it } from "vitest";

import { codeOnly } from "../CodeOnly";
import * as sections from "./SlidesSections";
import * as surface from "./SlidesInkSurface";
import surfaceRaw from "./SlidesInkSurface.ts?raw";
import sectionsRaw from "./SlidesSections.ts?raw";

const MOVED_VALUES = [
	"SLIDES_SIDECAR_SUFFIX",
	"slidesSidecarId",
	"pageOfSlide",
	"slideOfPage",
	"splitSlideSections",
	"sectionHash",
	"sectionHashes",
	"NOTE_CHECK_CHARS",
	"NOTE_CHECK_NEEDLE_CHARS",
	"NOTE_CHECK_COVERAGE_NUMERATOR",
	"NOTE_CHECK_COVERAGE_DENOMINATOR",
	"deckSectionText",
	"noteMatchesDeck",
	"remapSlides",
	"keptSlides",
	"remapStrokes",
] as const;

/** Declared in the new file and used by the surface class, but never re-exported from the surface. */
const SHARED_HELPERS = ["normaliseSectionText", "renderedNoteText"] as const;

/** Declared in the new file and used by nothing outside it. */
const PRIVATE_NAMES = [
	"stripInlineComments",
	"frontmatterTexts",
	"coveredLetters",
	"THEMATIC_BREAK",
	"SETEXT_UNDERLINE",
	"FENCE",
	"FENCE_CLOSE",
	"OPENS_OTHER_BLOCK",
	"LIST_START",
	"INLINE_HTML_LINE",
	"UNCUT",
	"FRONTMATTER_CLASSES",
] as const;

const MOVED_TYPES = ["DeckSectionEl", "StoredSlide"] as const;

/**
 * A module specifier naming SlidesInkSurface.ts, in any import form: side-effect, named,
 * namespace, type, re-export, dynamic or require, with or without the .ts suffix.
 * Run on text with the comments blanked, so prose that mentions the file is not a hit.
 */
const NAMES_SURFACE = /["'`](?:\.\/|\.\.\/slides\/)SlidesInkSurface(?:\.ts)?["'`]/;

function declarations(source: string, name: string): number {
	const text = source.replace(/\r\n/g, "\n");
	return text.match(new RegExp(`^(?:export )?(?:function|const|interface) ${name}\\b`, "gm"))?.length ?? 0;
}

describe("the slide-section functions live in SlidesSections.ts", () => {
	it("loads with the new file imported first, and runs real calls on it", () => {
		expect(sections.splitSlideSections("a\n\n~~~\n---\n~~~\n")).toHaveLength(1);
		expect(sections.splitSlideSections("a\n\n---\n\nb\n")).toHaveLength(2);
		const [first, second] = sections.sectionHashes("# one\n\n---\n\n# two\n");
		expect(sections.remapSlides([{ index: 0, hash: second! }], [first!, second!]).get(0)).toBe(1);
		expect(sections.noteMatchesDeck(["# Slide one\n\nDraw here."], ["Slide oneDraw here."])).toBe(true);
		expect(sections.noteMatchesDeck(["# Shopping list"], ["Quarterly review"])).toBe(false);
		expect(sections.SLIDES_SIDECAR_SUFFIX).toBe(".slides");
		expect(sections.slidesSidecarId("page")).toBe(`page${sections.SLIDES_SIDECAR_SUFFIX}`);
	});

	it("is re-exported from the surface file as the same function or constant, name by name", () => {
		const fromSurface = surface as unknown as Record<string, unknown>;
		const fromSections = sections as unknown as Record<string, unknown>;
		for (const name of MOVED_VALUES) {
			expect(fromSections[name], `${name} is not exported by SlidesSections.ts`).toBeDefined();
			expect(fromSurface[name], `${name} is not the same value from both files`).toBe(fromSections[name]);
		}
	});

	it("keeps the moved types importable from the surface file", () => {
		const slide: surface.StoredSlide = { index: 0, hash: "00000000" };
		const el: surface.DeckSectionEl = { textContent: "", children: [], classList: { contains: () => false } };
		const same: sections.StoredSlide = slide;
		expect(same.index).toBe(0);
		expect(surface.deckSectionText(el)).toBe("");
		expect(MOVED_TYPES).toHaveLength(2);
	});

	it("hands the surface class the two shared helpers without re-exporting them", () => {
		const fromSections = sections as unknown as Record<string, unknown>;
		const fromSurface = surface as unknown as Record<string, unknown>;
		for (const name of SHARED_HELPERS) {
			expect(typeof fromSections[name], name).toBe("function");
			expect(fromSurface[name], `${name} must stay out of the surface file's exports`).toBeUndefined();
		}
	});
});

describe("no declaration is left behind in SlidesInkSurface.ts", () => {
	it("declares each moved name once in the new file and never in the surface file", () => {
		const names = [...MOVED_VALUES, ...SHARED_HELPERS, ...PRIVATE_NAMES, ...MOVED_TYPES];
		for (const name of names) {
			expect(declarations(sectionsRaw, name), `${name} in SlidesSections.ts`).toBe(1);
			expect(declarations(surfaceRaw, name), `${name} in SlidesInkSurface.ts`).toBe(0);
		}
	});

	it("imports the new file from the surface file and nothing back", () => {
		const surfaceText = surfaceRaw.replace(/\r\n/g, "\n");
		expect(surfaceText).toMatch(/^import \{[^}]*\} from "\.\/SlidesSections";/m);
		expect(NAMES_SURFACE.test(codeOnly(sectionsRaw)), "SlidesSections.ts names SlidesInkSurface").toBe(false);
	});

	it("sees every import form that names the surface file, and not a comment", () => {
		const forms = [
			'import "./SlidesInkSurface";',
			'import { slidesSidecarId } from "./SlidesInkSurface";',
			'import {\n\tslidesSidecarId,\n} from "./SlidesInkSurface";',
			'import * as surface from "./SlidesInkSurface";',
			'import type { StoredSlide } from "./SlidesInkSurface";',
			'import surface from "./SlidesInkSurface.ts";',
			'export { sectionHash } from "./SlidesInkSurface";',
			'export * from "./SlidesInkSurface";',
			'const surface = await import("./SlidesInkSurface");',
			"const surface = require('./SlidesInkSurface');",
			'import { sectionHash } from "../slides/SlidesInkSurface";',
		];
		for (const form of forms) expect(NAMES_SURFACE.test(codeOnly(form)), form).toBe(true);
		expect(NAMES_SURFACE.test(codeOnly('// import "./SlidesInkSurface";'))).toBe(false);
		expect(NAMES_SURFACE.test(codeOnly('/* from "./SlidesInkSurface" */ const x = 1;'))).toBe(false);
	});
});
