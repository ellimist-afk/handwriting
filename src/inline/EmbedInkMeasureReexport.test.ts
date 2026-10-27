/**
 * How a rendered root's lines are measured lives in EmbedInkMeasure.ts, and
 * EmbedInk.ts re-exports the two types its importers use, so every importer
 * keeps its import line. Four things a type check cannot see are held here.
 *
 * LOAD. EmbedInkMeasure.ts is imported first and alone. It takes two values
 * back from EmbedInk.ts and one from EmbedInkRoot.ts, and EmbedInk.ts imports
 * from it, so the modules form a cycle. Every other test imports EmbedInk.ts
 * first; a cycle that only works in that order fails here, at load.
 *
 * ONE COPY. The line sources and the line memos are state that crosses the file
 * boundary: EmbedInk.ts clears them at teardown and reads them at paint, and the
 * new file fills them. The new file holds each exactly once, and EmbedInk.ts
 * holds none, so a second map cannot hide behind the import.
 *
 * NO BODY LEFT BEHIND. EmbedInk.ts holds no declaration of a moved name, and the
 * new file holds exactly one of each.
 *
 * ONE DOOR EACH WAY. The new file names nothing of EmbedInk.ts or EmbedInkRoot.ts
 * beyond the lists below, and EmbedInk.ts names nothing of the new file beyond
 * its own list. A type has no runtime identity, so the two re-exported types are
 * held by their declarations and the re-export line alone.
 */
import { describe, expect, it } from "vitest";

import { codeOnly } from "../CodeOnly";
import * as measure from "./EmbedInkMeasure";
import embedRaw from "./EmbedInk.ts?raw";
import measureRaw from "./EmbedInkMeasure.ts?raw";

/** Every declaration the new file holds. */
const MOVED = [
	"EmbedInkLineSource",
	"lineSources",
	"lineMemos",
	"lastBlockBoxes",
	"recordLines",
	"topInRoot",
	"lineHeightOf",
	"ROW_HOST",
	"rowsOf",
	"textNodes",
	"charTop",
	"firstCharTop",
	"NOT_SECTION",
	"notSection",
	"topBlocks",
	"HeldTops",
	"measureSpans",
] as const;

/** Every name the new file takes from EmbedInk.ts, and nothing else. */
const FROM_EMBED = ["isNotColumn", "queueReplace"];

/** Every name the new file takes from EmbedInkRoot.ts, and nothing else. */
const FROM_ROOT = ["embedInkAnchor"];

/** Every name EmbedInk.ts takes from the new file, and nothing else. */
const FROM_MEASURE = ["HeldTops", "lineMemos", "lineSources", "measureSpans"];

const embedSrc = embedRaw.replace(/\r\n/g, "\n");
const measureSrc = measureRaw.replace(/\r\n/g, "\n");

function declarations(source: string, name: string): number {
	return source.match(new RegExp(`^(?:export )?(?:async )?(?:function|const|let|interface|type) ${name}\\b`, "gm"))?.length ?? 0;
}

/** The names an import statement takes from one module, in any order, with `type` marks dropped. */
function importedNames(source: string, from: string): string[] {
	const found = [...codeOnly(source).matchAll(new RegExp(`^import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+"${from}";`, "gm"))];
	return found
		.flatMap((m) => m[1]!.split(","))
		.map((n) => n.trim().replace(/^type\s+/, ""))
		.filter(Boolean)
		.sort();
}

const asEl = (n: unknown) => n as unknown as HTMLElement;

describe("line measure lives in EmbedInkMeasure.ts", () => {
	it("loads with the new file imported first, and has nothing to measure for a root with no source", () => {
		const root = asEl({});
		expect(measure.measureSpans(root)).toBeNull();
		measure.lineSources.set(root, new Map());
		expect(measure.measureSpans(root)).toBeNull();
	});

	it("remembers each section of a root with its source, in the one shared map", () => {
		const root = asEl({});
		const first = asEl({});
		const second = asEl({});
		const source = { section: () => null, cached: () => null };
		measure.recordLines(root, first, source);
		measure.recordLines(root, second, source);
		expect([...(measure.lineSources.get(root)?.keys() ?? [])]).toEqual([first, second]);
		expect(measure.lineSources.get(root)?.get(first)).toBe(source);
		expect(measure.lineMemos.get(root)).toBeUndefined();
	});
});

describe("no declaration is left behind in EmbedInk.ts", () => {
	it("declares each moved name once in the new file and never in EmbedInk.ts", () => {
		expect(MOVED).toHaveLength(17);
		for (const name of MOVED) {
			expect(declarations(measureSrc, name), `${name} in EmbedInkMeasure.ts`).toBe(1);
			expect(declarations(embedSrc, name), `${name} in EmbedInk.ts`).toBe(0);
		}
	});

	it("matches a name exactly, not as the start of a longer one", () => {
		const text = "export const lineSources2 = 1;\nfunction rowsOf() {\n}\nexport interface HeldTops {\n}\n";
		expect(declarations(text, "lineSources")).toBe(0);
		expect(declarations(text, "rowsOf")).toBe(1);
		expect(declarations(text, "HeldTops")).toBe(1);
	});

	it("re-exports its two types by name from the new file, never with a star", () => {
		const text = codeOnly(embedSrc);
		expect(text).toMatch(/^export type \{[^}]*EmbedInkLineSource[^}]*HeldTops[^}]*\} from "\.\/EmbedInkMeasure";/m);
		expect(text).not.toMatch(/export\s*\*\s*from\s*["']\.\/EmbedInkMeasure/);
	});
});

describe("one door each way", () => {
	it("EmbedInkMeasure.ts takes exactly two names from EmbedInk.ts and one from EmbedInkRoot.ts", () => {
		const fromEmbed = importedNames(measureSrc, "\\./EmbedInk");
		expect(fromEmbed).toEqual([...FROM_EMBED].sort());
		expect(fromEmbed).toHaveLength(2);
		expect(importedNames(measureSrc, "\\./EmbedInkRoot")).toEqual(FROM_ROOT);
	});

	it("EmbedInk.ts takes exactly four names from EmbedInkMeasure.ts", () => {
		const names = importedNames(embedSrc, "\\./EmbedInkMeasure");
		expect(names).toEqual([...FROM_MEASURE].sort());
		expect(names).toHaveLength(4);
	});
});
