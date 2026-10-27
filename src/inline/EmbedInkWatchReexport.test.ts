/**
 * Attaching embed ink to a rendered root and keeping it there lives in
 * EmbedInkWatch.ts, and EmbedInk.ts re-exports the five values its importers
 * use, so every importer keeps its import line. Four things a type check cannot
 * see are held here.
 *
 * LOAD. EmbedInkWatch.ts is imported first and alone. It takes ten values back
 * from EmbedInk.ts, and EmbedInk.ts imports nine from it, so the two modules form
 * a cycle. Every other test imports EmbedInk.ts first; a cycle that only works
 * in that order fails here, at load.
 *
 * ONE COPY. Each re-exported value must be the very same function from both
 * files, not a second definition that happens to behave alike.
 *
 * NO BODY LEFT BEHIND. EmbedInk.ts holds no declaration of a moved name, and the
 * new file holds exactly one of each. The waits, the watches and their counters
 * are the state that crosses the file boundary: teardown stays in EmbedInk.ts
 * and clears them through the import, so a second set of maps in either file
 * would leave a wait running after a reload. The last cell below holds that.
 *
 * ONE DOOR EACH WAY. The new file names nothing of EmbedInk.ts, EmbedInkRoot.ts,
 * EmbedInkMeasure.ts or EmbedInkPrint.ts beyond the lists below, and EmbedInk.ts
 * names nothing of the new file beyond its own list.
 */
import { afterEach, describe, expect, it } from "vitest";

import { codeOnly } from "../CodeOnly";
import * as watch from "./EmbedInkWatch";
import * as embed from "./EmbedInk";
import { fontZoomFactor } from "./ZoomScale";
import embedRaw from "./EmbedInk.ts?raw";
import watchRaw from "./EmbedInkWatch.ts?raw";

afterEach(() => {
	embed.teardownEmbedInk();
	embed.disarmPrintSwaps();
});

/** The values EmbedInk.ts re-exports from the new file. */
const REEXPORTED = [
	"attachEmbedInk",
	"attachEmbedInkOnceReady",
	"embedInkAnchorWatchCount",
	"embedInkPendingWaitCount",
	"embedInkSizeWatchCount",
] as const;

/** Every declaration the new file holds. */
const MOVED = [
	"pendingWaits",
	"pendingWaitPaths",
	"bodyWatches",
	"sizeWatches",
	"anchorWatches",
	"embedInkAnchorWatchCount",
	"embedInkPendingWaitCount",
	"embedInkSizeWatchCount",
	"sweepSizeWatches",
	"attachEmbedInk",
	"attachEmbedInkOnceReady",
	"watchBodyForSections",
	"setTimer",
	"clearTimer",
	"cancelPendingWaits",
	"stopSizeWatch",
	"stopAllSizeWatches",
	"stopAnchorWatch",
	"stopAllAnchorWatches",
	"watchAnchor",
	"watchIfCollapsed",
] as const;

/** Every name the new file takes from EmbedInk.ts, and nothing else. */
const FROM_EMBED = [
	"anchorLayer",
	"anchorSizer",
	"diagnose",
	"layers",
	"MARKER_ATTR",
	"paint",
	"queueReplace",
	"reserveLeft",
	"strokesFor",
	"sweepDisconnected",
];

/** Every name the new file takes from EmbedInkRoot.ts, and nothing else. */
const FROM_ROOT = [
	"embedInkInPopover",
	"embedInkIsCollapsed",
	"embedInkIsLiveEditorBlock",
	"embedInkIsSectionEmbed",
	"embedInkKeepWaiting",
	"embedInkResolveRoot",
	"embedInkRetryDelay",
];

/** Every name the new file takes from EmbedInkMeasure.ts, and nothing else. */
const FROM_MEASURE = ["EmbedInkLineSource", "lineSources", "recordLines"];

/** Every name the new file takes from EmbedInkPrint.ts, and nothing else. */
const FROM_PRINT = ["armPrintSwap", "printing", "printVectorFor"];

/** Every name EmbedInk.ts takes from the new file, and nothing else. */
const FROM_WATCH = [
	"cancelPendingWaits",
	"pendingWaitPaths",
	"stopAllAnchorWatches",
	"stopAllSizeWatches",
	"stopAnchorWatch",
	"stopSizeWatch",
	"sweepSizeWatches",
	"watchAnchor",
	"watchIfCollapsed",
];

const embedSrc = embedRaw.replace(/\r\n/g, "\n");
const watchSrc = watchRaw.replace(/\r\n/g, "\n");

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

describe("attach and watches live in EmbedInkWatch.ts", () => {
	it("loads with the new file imported first, and answers its idle state", () => {
		expect(watch.embedInkPendingWaitCount()).toBe(0);
		expect(watch.embedInkSizeWatchCount()).toBe(0);
		expect(watch.embedInkAnchorWatchCount()).toBe(0);
		expect(watch.pendingWaitPaths.size).toBe(0);
	});

	it("is re-exported from EmbedInk.ts as the same function, name by name", () => {
		const fromEmbed = embed as unknown as Record<string, unknown>;
		const fromWatch = watch as unknown as Record<string, unknown>;
		expect(REEXPORTED).toHaveLength(5);
		for (const name of REEXPORTED) {
			expect(fromWatch[name], `${name} is not exported by EmbedInkWatch.ts`).toBeDefined();
			expect(fromEmbed[name], `${name} is not the same function from both files`).toBe(fromWatch[name]);
		}
	});

	it("keeps one set of waits: a wait started through EmbedInk.ts is counted by both files and cleared by teardown", () => {
		// A section the renderer has not attached and no container: the third route, which waits.
		const view = {
			setTimeout: () => 1,
			clearTimeout: () => undefined,
			MutationObserver: class {
				observe(): void {}
				disconnect(): void {}
			},
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			getComputedStyle: () => ({ position: "static", fontSize: "40px" }),
			devicePixelRatio: 1,
		};
		const section = { closest: () => null, isConnected: false, ownerDocument: { defaultView: view, body: {} } };
		const root = { querySelector: () => null, ownerDocument: { defaultView: view } };

		embed.initEmbedInkFontRef(() => 20);
		const zoom = embed.inkZoomOf(root as unknown as HTMLElement, "note.md");
		expect(zoom).toBe(fontZoomFactor(40, 20));
		expect(zoom, "a reference font that changes nothing would make the last line of this cell prove nothing").not.toBe(1);

		embed.attachEmbedInkOnceReady(section as unknown as HTMLElement, null, "note.md", () => []);
		expect(embed.embedInkPendingWaitCount()).toBe(1);
		expect(watch.embedInkPendingWaitCount()).toBe(1);

		embed.teardownEmbedInk();
		expect(embed.embedInkPendingWaitCount()).toBe(0);
		expect(watch.embedInkPendingWaitCount()).toBe(0);
		// Teardown drops the font reference too: a root read afterwards draws at 1.
		expect(embed.inkZoomOf(root as unknown as HTMLElement, "note.md")).toBe(1);
	});
});

describe("no declaration is left behind in EmbedInk.ts", () => {
	it("declares each moved name once in the new file and never in EmbedInk.ts", () => {
		expect(MOVED).toHaveLength(21);
		for (const name of MOVED) {
			expect(declarations(watchSrc, name), `${name} in EmbedInkWatch.ts`).toBe(1);
			expect(declarations(embedSrc, name), `${name} in EmbedInk.ts`).toBe(0);
		}
	});

	it("matches a name exactly, not as the start of a longer one", () => {
		const text = "const pendingWaitPaths2 = 1;\nexport function setTimer() {\n}\nconst sizeWatches = new Map();\n";
		expect(declarations(text, "pendingWaitPaths")).toBe(0);
		expect(declarations(text, "setTimer")).toBe(1);
		expect(declarations(text, "sizeWatches")).toBe(1);
		expect(declarations(text, "size")).toBe(0);
	});

	it("re-exports by name from the new file, never with a star", () => {
		const text = codeOnly(embedSrc);
		expect(text).toMatch(/^export \{[^}]*\} from "\.\/EmbedInkWatch";/m);
		expect(text).not.toMatch(/export\s*\*\s*from\s*["']\.\/EmbedInkWatch/);
	});
});

describe("one door each way", () => {
	it("EmbedInkWatch.ts takes exactly ten names from EmbedInk.ts", () => {
		const names = importedNames(watchSrc, "\\./EmbedInk");
		expect(names).toEqual([...FROM_EMBED].sort());
		expect(names).toHaveLength(10);
	});

	it("EmbedInkWatch.ts takes its other names from the root, measure and print files, and nothing else", () => {
		expect(importedNames(watchSrc, "\\./EmbedInkRoot")).toEqual([...FROM_ROOT].sort());
		expect(importedNames(watchSrc, "\\./EmbedInkMeasure")).toEqual([...FROM_MEASURE].sort());
		expect(importedNames(watchSrc, "\\./EmbedInkPrint")).toEqual([...FROM_PRINT].sort());
	});

	it("EmbedInk.ts takes exactly nine names from EmbedInkWatch.ts", () => {
		const names = importedNames(embedSrc, "\\./EmbedInkWatch");
		expect(names).toEqual([...FROM_WATCH].sort());
		expect(names).toHaveLength(9);
	});
});
