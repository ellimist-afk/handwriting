/**
 * The note surface's module registry (the shared ink store, the set of
 * mounted overlays, the on/off switches, the sweeps and reports over every
 * overlay, the copy and cut notices and the committed-layer floor) lives in
 * InkOverlayRegistry.ts, and InkOverlay.ts re-exports it, so every importer
 * keeps its import line. Four things a type check cannot see are held here,
 * as the tool-state test holds them for its file.
 *
 * LOAD. This file imports the registry first. The registry reads
 * InkOverlayPlugin as a type only, so it loads without InkOverlay.ts; its value
 * import of the tool-state module leads back to InkOverlay.ts, which then loads
 * in full. Every other test imports InkOverlay.ts first and so checks the other
 * direction.
 *
 * ONE COPY. Each moved name must be the very same function or binding from
 * both files, not a second definition that happens to behave alike. The two
 * `let` switches are checked live: a write through the registry's setter is
 * read through InkOverlay.ts.
 *
 * NO BODY LEFT BEHIND. InkOverlay.ts holds no declaration of a moved name, and
 * the registry holds exactly one of each.
 *
 * LISTED. The note row of the ink-surface ledger names the registry, so every
 * rule that reads the note surface's files reads this one too.
 */
import { describe, expect, it } from "vitest";

import * as registry from "./InkOverlayRegistry";
import * as overlay from "./InkOverlay";
import overlayRaw from "./InkOverlay.ts?raw";
import registryRaw from "./InkOverlayRegistry.ts?raw";
import { surfaceFiles } from "./surfaceFiles.testutil";

/** Values exported by the registry and re-exported, under the same name, by InkOverlay.ts. */
const MOVED = [
	"enabled",
	"inlineInk",
	"instances",
	"scrollExpansionEnabled",
	"setScrollExpansionEnabled",
	"prepareFingerInkEverywhere",
	"metrics",
	"isInlineInkEnabled",
	"setInlineInkEnabled",
	"gutterPanMode",
	"overlayForPath",
	"overlayForActiveEditor",
	"refreshPenToolsAll",
	"endLiveStrokesEverywhere",
	"refreshAllStrips",
	"hidePenCursorsEverywhere",
	"releaseMouseInkQuietlyEverywhere",
	"peelInkEscapeFloor",
	"peelInlineEscapeSelection",
	"closeInlineInkDocument",
	"bindInkEscapeWindow",
	"armMouseInkQuietlyEverywhere",
	"repaintAllInkOverlays",
	"copyInlineInkMetrics",
	"inkExternallyReloaded",
	"inlineReloadBindings",
	"inlineReloadCandidates",
	"captureInlineReloadAdmission",
	"copyInlineZoomReport",
	"copyRegionCensus",
	"copyPresentationReport",
	"deleteAllInkOn",
	"copyInlineSurfaceReport",
	"copySelectionNotice",
	"copySelectionNoticeIsRoutine",
	"cutSelectionNotice",
	"cutSelectionNoticeIsRoutine",
	"committedFloorFor",
	"onDeviceGrid",
] as const;

/** Types exported by the registry and re-exported by InkOverlay.ts. */
const MOVED_TYPES = ["InlineReloadBinding", "CutSelectionOutcome"] as const;

/** Exported by the registry for InkOverlay.ts's own code, and never re-exported from it. */
const SHARED_TYPES = ["GutterPanMode"] as const;

/** Declared in the registry and used by nothing outside it. */
const PRIVATE = ["sessionStartMs", "newestCommitInstance"] as const;

function declarations(source: string, name: string): number {
	const text = source.replace(/\r\n/g, "\n");
	return text.match(new RegExp(`^(?:export )?(?:async function|function|const|let|type|interface) ${name}\\b`, "gm"))?.length ?? 0;
}

function listFrom(text: string, head: string, from: string): string[] | undefined {
	const escaped = from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	const match = text.match(new RegExp(`^${head} \\{([^}]*)\\} from "${escaped}";`, "m"));
	return match?.[1]?.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

describe("the note surface's module registry lives in InkOverlayRegistry.ts", () => {
	it("loads with the registry imported first, with no overlay mounted and both switches at their defaults", () => {
		expect(registry.instances.size).toBe(0);
		expect(registry.isInlineInkEnabled()).toBe(true);
		expect(registry.scrollExpansionEnabled).toBe(false);
		expect(overlay.overlayForPath("Note.md")).toBeNull();
	});

	it("is re-exported from InkOverlay.ts as the same function or binding, name by name", () => {
		const fromOverlay = overlay as unknown as Record<string, unknown>;
		const fromRegistry = registry as unknown as Record<string, unknown>;
		expect(Object.keys(fromRegistry).sort()).toEqual([...MOVED].sort());
		for (const name of MOVED) {
			expect(name in fromOverlay, `${name} is not exported by InkOverlay.ts`).toBe(true);
			expect(fromOverlay[name], `${name} is not the same value from both files`).toBe(fromRegistry[name]);
		}
	});

	it("reads the two let switches live through InkOverlay.ts", () => {
		registry.setInlineInkEnabled(false);
		expect(overlay.enabled).toBe(false);
		expect(overlay.isInlineInkEnabled()).toBe(false);
		registry.setInlineInkEnabled(true);
		expect(overlay.enabled).toBe(true);
		registry.setScrollExpansionEnabled(true);
		expect(overlay.scrollExpansionEnabled).toBe(true);
		registry.setScrollExpansionEnabled(false);
		expect(overlay.scrollExpansionEnabled).toBe(false);
	});

	it("keeps the session clock and the gutter pan type out of InkOverlay.ts's exports", () => {
		const fromOverlay = overlay as unknown as Record<string, unknown>;
		expect("sessionStartMs" in fromOverlay).toBe(false);
		expect("sessionStartMs" in (registry as unknown as Record<string, unknown>)).toBe(false);
		const text = overlayRaw.replace(/\r\n/g, "\n");
		expect(listFrom(text, "export type", "./InkOverlayRegistry")?.sort()).toEqual([...MOVED_TYPES].sort());
		for (const name of SHARED_TYPES) expect(listFrom(text, "export", "./InkOverlayRegistry"), name).not.toContain(name);
	});

	it("is listed in the note row of the ink-surface ledger", () => {
		expect(surfaceFiles("note")).toContain("/src/inline/InkOverlayRegistry.ts");
	});
});

describe("no declaration is left behind in InkOverlay.ts", () => {
	it("declares each moved name once in the registry and never in InkOverlay.ts", () => {
		for (const name of [...MOVED, ...MOVED_TYPES, ...SHARED_TYPES, ...PRIVATE]) {
			expect(declarations(registryRaw, name), `${name} in InkOverlayRegistry.ts`).toBe(1);
			expect(declarations(overlayRaw, name), `${name} in InkOverlay.ts`).toBe(0);
		}
	});

	it("re-exports the 41 names from InkOverlay.ts, and the registry takes only the overlay type back", () => {
		const overlayText = overlayRaw.replace(/\r\n/g, "\n");
		const registryText = registryRaw.replace(/\r\n/g, "\n");
		expect(listFrom(overlayText, "export", "./InkOverlayRegistry")?.sort()).toEqual([...MOVED].sort());
		expect(MOVED.length + MOVED_TYPES.length).toBe(41);
		expect(overlayText).toMatch(/^import \{[^}]*\} from "\.\/InkOverlayRegistry";/m);
		// The one door back: the overlay class as a type, so the registry adds no load-time read of InkOverlay.ts.
		expect(listFrom(registryText, "import", "./InkOverlay")).toBeUndefined();
		expect(listFrom(registryText, "import type", "./InkOverlay")).toEqual(["InkOverlayPlugin"]);
	});
});
