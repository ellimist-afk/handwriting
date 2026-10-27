/**
 * The embedded ink's print and export path lives in EmbedInkPrint.ts and
 * EmbedInk.ts re-exports the three names its importers use, so every importer
 * keeps its import line. Four things a type check cannot see are held here.
 *
 * LOAD. EmbedInkPrint.ts is imported first and alone. It takes fifteen values
 * back from EmbedInk.ts, and EmbedInk.ts imports six from it, so the two
 * modules form a cycle. Every other test imports EmbedInk.ts first; a cycle that
 * only works in that order fails here, at load.
 *
 * ONE COPY. Each re-exported value must be the very same function from both
 * files, not a second definition that happens to behave alike.
 *
 * NO BODY LEFT BEHIND. EmbedInk.ts holds no declaration of a moved name, and the
 * new file holds exactly one of each, so a half-finished move cannot pass with
 * the old copy still shadowing the new one. The print note, the swap counter and
 * the printing set are the state that crosses the file boundary, so they are the
 * names that matter most here.
 *
 * ONE DOOR EACH WAY. The new file names nothing of EmbedInk.ts beyond the list
 * below, and EmbedInk.ts names nothing of the new file beyond its own list.
 */
import { describe, expect, it } from "vitest";

import { codeOnly } from "../CodeOnly";
import * as print from "./EmbedInkPrint";
import * as embed from "./EmbedInk";
import embedRaw from "./EmbedInk.ts?raw";
import printRaw from "./EmbedInkPrint.ts?raw";

/** The three names EmbedInk.ts re-exports from the new file. */
const REEXPORTED = ["disarmPrintSwaps", "embedInkPrintSwaps", "printColumnWidth"] as const;

/** Every declaration the new file holds. */
const MOVED = [
	"printArmed",
	"printing",
	"printDisarms",
	"printSwaps",
	"embedInkPrintSwaps",
	"PRINT_PAGE_WHITE",
	"printNote",
	"armPrintSwap",
	"disarmPrintSwaps",
	"usePrintVector",
	"printVectorFor",
	"isPrintContainer",
	"PrintFit",
	"printFits",
	"holdPrintLayout",
	"PRINT_INK_PAD",
	"fitPrintColumn",
	"PrintFitInfo",
	"printMedia",
	"printBlocks",
	"printSpans",
	"holdPrintSpans",
	"holdWholeBlocks",
	"PrintStrips",
	"printStrips",
	"STRIP_CLS",
	"STRIPPED_CLS",
	"buildStrip",
	"buildPrintStrips",
	"dropStrips",
	"releasePrintStrips",
	"noteExport",
	"printColumnWidth",
	"releasePrintFit",
	"growPrintContainer",
	"inkPathEl",
] as const;

/** Every name the new file takes from EmbedInk.ts, and nothing else. */
const FROM_EMBED = [
	"anchorLayer",
	"anchorSizer",
	"columnWidthFor",
	"diagnose",
	"embedInkBounds",
	"inkZoomOf",
	"isNotColumn",
	"layerOrigins",
	"layers",
	"MIN_HEIGHT_ATTR",
	"placeStrokes",
	"reserveLeft",
	"strokesFor",
	"SVG_NS",
	"sweepDisconnected",
];

/** Every name EmbedInk.ts takes from the new file, and nothing else. */
const FROM_PRINT = [
	"growPrintContainer",
	"isPrintContainer",
	"printing",
	"printSpans",
	"printVectorFor",
	"releasePrintStrips",
];

const embedSrc = embedRaw.replace(/\r\n/g, "\n");
const printSrc = printRaw.replace(/\r\n/g, "\n");

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

describe("the print path lives in EmbedInkPrint.ts", () => {
	it("loads with the new file imported first, and answers its idle state", () => {
		expect(print.embedInkPrintSwaps()).toBe(0);
		expect(print.printColumnWidth(700, 650)).toBe(700);
		expect(print.printColumnWidth(0, 650)).toBe(650);
		expect(print.printColumnWidth(0, 0)).toBeNull();
	});

	it("is re-exported from EmbedInk.ts as the same function, name by name", () => {
		const fromEmbed = embed as unknown as Record<string, unknown>;
		const fromPrint = print as unknown as Record<string, unknown>;
		for (const name of REEXPORTED) {
			expect(fromPrint[name], `${name} is not exported by EmbedInkPrint.ts`).toBeDefined();
			expect(fromEmbed[name], `${name} is not the same function from both files`).toBe(fromPrint[name]);
		}
	});
});

describe("no declaration is left behind in EmbedInk.ts", () => {
	it("declares each moved name once in the new file and never in EmbedInk.ts", () => {
		expect(MOVED).toHaveLength(36);
		for (const name of MOVED) {
			expect(declarations(printSrc, name), `${name} in EmbedInkPrint.ts`).toBe(1);
			expect(declarations(embedSrc, name), `${name} in EmbedInk.ts`).toBe(0);
		}
	});

	it("matches a name exactly, not as the start of a longer one", () => {
		const text = "interface PrintFitInfo {\n}\nconst printFits = 1;\nexport let printNote = \"\";\n";
		expect(declarations(text, "PrintFit")).toBe(0);
		expect(declarations(text, "PrintFitInfo")).toBe(1);
		expect(declarations(text, "printFit")).toBe(0);
		expect(declarations(text, "printNote")).toBe(1);
	});

	it("re-exports by name from the new file, never with a star", () => {
		const text = codeOnly(embedSrc);
		expect(text).toMatch(/^export \{[^}]*\} from "\.\/EmbedInkPrint";/m);
		expect(text).not.toMatch(/export\s*\*\s*from\s*["']\.\/EmbedInkPrint/);
	});
});

describe("one door each way", () => {
	it("EmbedInkPrint.ts takes exactly fifteen names from EmbedInk.ts", () => {
		const names = importedNames(printSrc, "\\./EmbedInk");
		expect(names).toEqual([...FROM_EMBED].sort());
		expect(names).toHaveLength(15);
	});

	it("EmbedInk.ts takes exactly six names from EmbedInkPrint.ts", () => {
		const names = importedNames(embedSrc, "\\./EmbedInkPrint");
		expect(names).toEqual([...FROM_PRINT].sort());
		expect(names).toHaveLength(6);
	});
});
