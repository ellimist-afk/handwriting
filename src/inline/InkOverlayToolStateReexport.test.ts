/**
 * The note surface's module tool and setting state lives in
 * InkOverlayToolState.ts and InkOverlay.ts re-exports it, so every importer
 * keeps its import line. Four things a type check cannot see are held here,
 * in the way the install tests of the other split files hold theirs for a
 * prototype install.
 *
 * LOAD. The two modules form a cycle: InkOverlayToolState.ts imports
 * `instances`, `refreshAllStrips` and `prepareFingerInkEverywhere` back from
 * InkOverlay.ts. This file imports the tool-state module first, so InkOverlay.ts
 * loads in full before the tool-state module's own body runs, and a top-level
 * read of a tool-state name in InkOverlay.ts fails here, at load. Every other
 * test imports InkOverlay.ts first and so checks the other direction.
 *
 * ONE COPY. Each moved name must be the very same function or binding from
 * both files, not a second definition that happens to behave alike. The `let`
 * bindings are checked live: a write through one file is read through the other.
 *
 * NO BODY LEFT BEHIND. InkOverlay.ts holds no declaration of a moved name, and
 * the new file holds exactly one of each.
 *
 * LISTED. The note row of the ink-surface ledger names the new file, so every
 * rule that reads the note surface's files reads this one too.
 */
import { describe, expect, it, vi } from "vitest";

import * as toolState from "./InkOverlayToolState";
import * as overlay from "./InkOverlay";
import overlayRaw from "./InkOverlay.ts?raw";
import toolStateRaw from "./InkOverlayToolState.ts?raw";
import { surfaceFiles } from "./surfaceFiles.testutil";
import { DEFAULT_ERASER_RADIUS_PX, clampEraserRadius } from "../ink/EraserSize";
import { clampInkSize } from "../ink/InkSize";
import { DEFAULT_TOOLBAR_CORNER } from "./ToolbarCorner";

/** Exported by the new file and re-exported, under the same name, by InkOverlay.ts. */
const MOVED = [
	"inlineTool",
	"getInkSizeMult",
	"setInkSizeMult",
	"getInlineTool",
	"setInlineTool",
	"getInlineEraserMode",
	"setInlineEraserMode",
	"getInlineLassoMode",
	"setInlineLassoMode",
	"getInlineSpaceMode",
	"setInlineSpaceMode",
	"tipModeHeld",
	"releaseTipModes",
	"getInlinePanMode",
	"setInlinePanMode",
	"inlineEraserRadiusPx",
	"getEraserRadiusPx",
	"setEraserRadiusPx",
	"setPersistEraserRadius",
	"getToolbarCorner",
	"addStripSurface",
	"setToolbarCorner",
	"setPersistToolbarCorner",
	"applyToolbarPlacement",
	"setShapeSnap",
	"setPenReticle",
	"penReticleEnabled",
	"setEraserWholeStrokes",
	"getEraserWholeStrokes",
	"persistEraserMode",
	"setPersistEraserMode",
	"persistEraserModeNow",
	"pickStripColor",
	"commitEraserRadius",
	"persistInkSize",
	"setPersistInkSize",
	"applyInkSize",
] as const;

/** Exported by the new file for InkOverlay.ts's own code, and never re-exported from it. */
const SHARED = [
	"toolbarCorner",
	"repaintSurfaces",
	"hideCursorSurfaces",
	"endStrokeSurfaces",
	"refreshStripSurfaces",
	"penReticleOn",
	"eraserWholeStrokes",
	"shapeSnapOn",
] as const;

/** Declared in the new file and used by nothing outside it. */
const PRIVATE = ["inkSizeMult", "persistEraserRadius", "stripSurfaces", "tipModeSurfaces", "persistToolbarCorner"] as const;

function declarations(source: string, name: string): number {
	const text = source.replace(/\r\n/g, "\n");
	return text.match(new RegExp(`^(?:export )?(?:function|const|let) ${name}\\b`, "gm"))?.length ?? 0;
}

function count(source: string, needle: string): number {
	return source.replace(/\r\n/g, "\n").split(needle).length - 1;
}

describe("the note surface's tool and setting state lives in InkOverlayToolState.ts", () => {
	it("loads with the new file imported first, and runs one real call per group", () => {
		// The nib, read before anything here writes it.
		expect(toolState.inlineTool).toBe("pen");

		// Nib and ink size.
		toolState.setInlineTool("highlighter");
		expect(overlay.getInlineTool()).toBe("highlighter");
		toolState.setInlineTool("pen");
		toolState.setInkSizeMult("pen", 1.5);
		expect(overlay.getInkSizeMult("pen")).toBe(clampInkSize(1.5));
		const persistSize = vi.fn();
		toolState.setPersistInkSize(persistSize);
		toolState.applyInkSize("pen", 9);
		expect(persistSize).toHaveBeenCalledWith("pen", clampInkSize(9));
		toolState.setPersistInkSize(null);
		toolState.setInkSizeMult("pen", 1);

		// Tip-mode wrappers.
		toolState.setInlineLassoMode(true);
		expect(overlay.getInlineLassoMode()).toBe(true);
		expect(overlay.tipModeHeld()).toBe(true);
		toolState.releaseTipModes();
		expect(overlay.getInlineLassoMode()).toBe(false);
		expect(overlay.tipModeHeld()).toBe(false);

		// Eraser radius and its persist hook.
		const persistRadius = vi.fn();
		toolState.setPersistEraserRadius(persistRadius);
		toolState.setEraserRadiusPx(200);
		toolState.commitEraserRadius();
		expect(persistRadius).toHaveBeenCalledWith(clampEraserRadius(200));
		toolState.setPersistEraserRadius(null);
		toolState.setEraserRadiusPx(DEFAULT_ERASER_RADIUS_PX);

		// Toolbar corner and the strip surfaces it refreshes.
		expect(overlay.getToolbarCorner()).toBe(DEFAULT_TOOLBAR_CORNER);
		const refresh = vi.fn();
		const remove = toolState.addStripSurface(refresh);
		toolState.applyToolbarPlacement("bottom-left");
		expect(overlay.getToolbarCorner()).toBe("bottom-left");
		expect(refresh).toHaveBeenCalledTimes(1);
		remove();
		toolState.setToolbarCorner(DEFAULT_TOOLBAR_CORNER);
		expect(refresh).toHaveBeenCalledTimes(1);

		// Flags.
		toolState.setEraserWholeStrokes(false);
		expect(overlay.getEraserWholeStrokes()).toBe(false);
		toolState.setEraserWholeStrokes(true);
		toolState.setPenReticle(false);
		expect(overlay.penReticleEnabled()).toBe(false);
		toolState.setPenReticle(true);
	});

	it("is re-exported from InkOverlay.ts as the same function or binding, name by name", () => {
		const fromOverlay = overlay as unknown as Record<string, unknown>;
		const fromState = toolState as unknown as Record<string, unknown>;
		expect(Object.keys(fromState).sort()).toEqual([...MOVED, ...SHARED].sort());
		for (const name of MOVED) {
			expect(name in fromOverlay, `${name} is not exported by InkOverlay.ts`).toBe(true);
			expect(fromOverlay[name], `${name} is not the same value from both files`).toBe(fromState[name]);
		}
	});

	it("reads each moved let binding live through InkOverlay.ts", () => {
		toolState.setInlineTool("highlighter");
		expect(overlay.inlineTool).toBe("highlighter");
		toolState.setInlineTool("pen");
		expect(overlay.inlineTool).toBe("pen");
		toolState.setEraserRadiusPx(31);
		expect(overlay.inlineEraserRadiusPx).toBe(clampEraserRadius(31));
		toolState.setEraserRadiusPx(DEFAULT_ERASER_RADIUS_PX);
		expect(overlay.inlineEraserRadiusPx).toBe(DEFAULT_ERASER_RADIUS_PX);
		const persistMode = vi.fn();
		toolState.setPersistEraserMode(persistMode);
		expect(overlay.persistEraserMode).toBe(persistMode);
		toolState.setPersistEraserMode(null);
		expect(overlay.persistEraserMode).toBe(null);
	});

	it("hands InkOverlay.ts the eight names its own code reads without re-exporting them", () => {
		const fromOverlay = overlay as unknown as Record<string, unknown>;
		for (const name of SHARED) expect(name in fromOverlay, `${name} must stay out of InkOverlay.ts's exports`).toBe(false);
	});

	it("is listed in the note row of the ink-surface ledger", () => {
		expect(surfaceFiles("note")).toContain("/src/inline/InkOverlayToolState.ts");
	});
});

describe("no declaration is left behind in InkOverlay.ts", () => {
	it("declares each moved name once in the new file and never in InkOverlay.ts", () => {
		for (const name of [...MOVED, ...SHARED, ...PRIVATE]) {
			expect(declarations(toolStateRaw, name), `${name} in InkOverlayToolState.ts`).toBe(1);
			expect(declarations(overlayRaw, name), `${name} in InkOverlay.ts`).toBe(0);
		}
	});

	it("moves the three marker texts: once in the new file, never in InkOverlay.ts", () => {
		for (const needle of ["export function applyInkSize(", "export let inlineTool", "setTipModeListener("]) {
			expect(count(toolStateRaw, needle), `${needle} in InkOverlayToolState.ts`).toBe(1);
			expect(count(overlayRaw, needle), `${needle} in InkOverlay.ts`).toBe(0);
		}
	});

	it("imports the new file from InkOverlay.ts, and only the three cycle names back", () => {
		const overlayText = overlayRaw.replace(/\r\n/g, "\n");
		const stateText = toolStateRaw.replace(/\r\n/g, "\n");
		expect(overlayText).toMatch(/^export \{[^}]*\} from "\.\/InkOverlayToolState";/m);
		const back = stateText.match(/^import \{([^}]*)\} from "\.\/InkOverlay";/m);
		expect(back?.[1]?.split(",").map((s) => s.trim()).sort()).toEqual(["instances", "prepareFingerInkEverywhere", "refreshAllStrips"]);
	});
});
