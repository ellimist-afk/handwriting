/**
 * Which rendered root an embed's ink goes to, and where inside it, lives in
 * EmbedInkRoot.ts, and EmbedInk.ts re-exports the thirteen values and the one
 * type its importers use, so every importer keeps its import line. Four things a
 * type check cannot see are held here.
 *
 * LOAD. EmbedInkRoot.ts is imported first and alone. It takes four values back
 * from EmbedInk.ts and one from EmbedInkPrint.ts, and EmbedInk.ts imports from
 * it, so the modules form a cycle. Every other test imports EmbedInk.ts first; a
 * cycle that only works in that order fails here, at load.
 *
 * ONE COPY. Each re-exported value must be the very same function (or number)
 * from both files, not a second definition that happens to behave alike.
 *
 * NO BODY LEFT BEHIND. EmbedInk.ts holds no declaration of a moved name, and the
 * new file holds exactly one of each, so a half-finished move cannot pass with
 * the old copy still shadowing the new one.
 *
 * ONE DOOR EACH WAY. The new file names nothing of EmbedInk.ts or
 * EmbedInkPrint.ts beyond the lists below, and EmbedInk.ts names nothing of the
 * new file beyond its own list.
 */
import { describe, expect, it } from "vitest";

import { codeOnly } from "../CodeOnly";
import * as root from "./EmbedInkRoot";
import * as embed from "./EmbedInk";
import embedRaw from "./EmbedInk.ts?raw";
import rootRaw from "./EmbedInkRoot.ts?raw";

/** The values EmbedInk.ts re-exports from the new file (the type EmbedInkVia goes with them). */
const REEXPORTED = [
	"EMBED_INK_WAIT_MS",
	"embedInkAnchor",
	"embedInkDiagLine",
	"embedInkInPopover",
	"embedInkIsCollapsed",
	"embedInkIsLiveEditorBlock",
	"embedInkIsSectionEmbed",
	"embedInkKeepWaiting",
	"embedInkResolveRoot",
	"embedInkRetryDelay",
	"embedInkRoot",
	"embedInkRootFor",
	"embedInkRootIsEmbed",
] as const;

/** Every declaration the new file holds. */
const MOVED = [
	"embedInkRoot",
	"embedInkIsLiveEditorBlock",
	"embedInkIsSectionEmbed",
	"embedInkInPopover",
	"embedInkRootHidden",
	"embedInkRootFor",
	"EmbedInkVia",
	"embedInkResolveRoot",
	"EMBED_INK_WAIT_MS",
	"embedInkKeepWaiting",
	"embedInkRetryDelay",
	"embedInkDiagLine",
	"embedInkIsCollapsed",
	"embedInkRootIsEmbed",
	"embedInkAnchor",
] as const;

/** Every name the new file takes from EmbedInk.ts, and nothing else. */
const FROM_EMBED = ["anchorSizer", "columnInset", "printAnchor", "sizerHeaderHeight"];

/** Every name EmbedInk.ts takes from the new file, and nothing else. */
const FROM_ROOT = ["embedInkAnchor", "embedInkRootHidden", "embedInkRootIsEmbed", "EmbedInkVia"];

const embedSrc = embedRaw.replace(/\r\n/g, "\n");
const rootSrc = rootRaw.replace(/\r\n/g, "\n");

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

/** An element that answers `closest` from a table of selector to result, and nothing else. */
const finds = (table: Record<string, unknown>): HTMLElement =>
	({ closest: (selector: string) => table[selector] ?? null }) as unknown as HTMLElement;

describe("root resolution lives in EmbedInkRoot.ts", () => {
	it("loads with the new file imported first, and answers its pure questions", () => {
		expect(root.embedInkKeepWaiting(0)).toBe(true);
		expect(root.embedInkKeepWaiting(root.EMBED_INK_WAIT_MS)).toBe(false);
		expect(root.embedInkRetryDelay(0)).toBe(16);
		expect(root.embedInkRetryDelay(300)).toBe(50);
		expect(root.embedInkRetryDelay(2_000)).toBe(250);
		expect(root.embedInkIsCollapsed({ width: 0, height: 5 })).toBe(true);
		expect(root.embedInkIsCollapsed({ width: 5, height: 5 })).toBe(false);
		expect(root.embedInkIsCollapsed(null)).toBe(false);
		expect(root.embedInkDiagLine("timer", "a.md", 12)).toBe("[handwriting] embed ink root via timer after 12ms: a.md");
	});

	it("prefers an embed's content box, then the view, then the sizer, then the rendered block", () => {
		const embedBox = { id: "embed" };
		const view = { id: "view" };
		const sizer = { id: "sizer" };
		const rendered = { id: "rendered" };
		expect(root.embedInkRoot(finds({ ".markdown-embed-content": embedBox, ".markdown-preview-view": view }))).toBe(embedBox);
		expect(root.embedInkRoot(finds({ ".markdown-preview-view": view, ".markdown-preview-sizer": sizer }))).toBe(view);
		expect(root.embedInkRoot(finds({ ".markdown-preview-sizer": sizer, ".markdown-rendered": rendered }))).toBe(sizer);
		expect(root.embedInkRoot(finds({ ".markdown-rendered": rendered }))).toBe(rendered);
		expect(root.embedInkRoot(finds({}))).toBeNull();
	});

	it("falls back to the renderer's container, and says which route found the root", () => {
		const box = { id: "box" };
		expect(root.embedInkResolveRoot(finds({}), finds({ ".markdown-rendered": box }))).toEqual({ root: box, via: "container" });
		expect(root.embedInkResolveRoot(finds({ ".markdown-rendered": box }), null)).toEqual({ root: box, via: "section" });
		expect(root.embedInkResolveRoot(finds({}), undefined)).toEqual({ root: null, via: "none" });
		expect(root.embedInkRootFor(finds({}), finds({ ".markdown-rendered": box }))).toBe(box);
	});

	it("knows a hidden root and an embed's content box", () => {
		const hidden = { style: { display: "none" }, parentElement: null } as unknown as HTMLElement;
		const shown = { style: { display: "" }, parentElement: hidden } as unknown as HTMLElement;
		expect(root.embedInkRootHidden(hidden)).toBe(true);
		expect(root.embedInkRootHidden(shown)).toBe(true);
		expect(root.embedInkRootHidden({ style: { display: "" }, parentElement: null } as unknown as HTMLElement)).toBe(false);
		expect(root.embedInkRootIsEmbed({ classList: { contains: (c: string) => c === "markdown-embed-content" } })).toBe(true);
		expect(root.embedInkRootIsEmbed({ classList: { contains: () => false } })).toBe(false);
	});

	it("is re-exported from EmbedInk.ts as the same function, name by name", () => {
		const fromEmbed = embed as unknown as Record<string, unknown>;
		const fromRoot = root as unknown as Record<string, unknown>;
		expect(REEXPORTED).toHaveLength(13);
		for (const name of REEXPORTED) {
			expect(fromRoot[name], `${name} is not exported by EmbedInkRoot.ts`).toBeDefined();
			expect(fromEmbed[name], `${name} is not the same value from both files`).toBe(fromRoot[name]);
		}
	});
});

describe("no declaration is left behind in EmbedInk.ts", () => {
	it("declares each moved name once in the new file and never in EmbedInk.ts", () => {
		expect(MOVED).toHaveLength(15);
		for (const name of MOVED) {
			expect(declarations(rootSrc, name), `${name} in EmbedInkRoot.ts`).toBe(1);
			expect(declarations(embedSrc, name), `${name} in EmbedInk.ts`).toBe(0);
		}
	});

	it("matches a name exactly, not as the start of a longer one", () => {
		const text = "export function embedInkRootFor() {\n}\nconst embedInkRoot2 = 1;\nexport type EmbedInkVia = \"none\";\n";
		expect(declarations(text, "embedInkRoot")).toBe(0);
		expect(declarations(text, "embedInkRootFor")).toBe(1);
		expect(declarations(text, "EmbedInkVia")).toBe(1);
	});

	it("re-exports by name from the new file, never with a star", () => {
		const text = codeOnly(embedSrc);
		expect(text).toMatch(/^export \{[^}]*\} from "\.\/EmbedInkRoot";/m);
		expect(text).toMatch(/^export type \{[^}]*EmbedInkVia[^}]*\} from "\.\/EmbedInkRoot";/m);
		expect(text).not.toMatch(/export\s*\*\s*from\s*["']\.\/EmbedInkRoot/);
	});
});

describe("one door each way", () => {
	it("EmbedInkRoot.ts takes exactly four names from EmbedInk.ts and one from EmbedInkPrint.ts", () => {
		const names = importedNames(rootSrc, "\\./EmbedInk");
		expect(names).toEqual([...FROM_EMBED].sort());
		expect(names).toHaveLength(4);
		expect(importedNames(rootSrc, "\\./EmbedInkPrint")).toEqual(["printNote"]);
	});

	it("EmbedInk.ts takes exactly four names from EmbedInkRoot.ts", () => {
		const names = importedNames(embedSrc, "\\./EmbedInkRoot");
		expect(names).toEqual([...FROM_ROOT].sort());
		expect(names).toHaveLength(4);
	});
});
