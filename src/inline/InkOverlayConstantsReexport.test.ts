/**
 * The note surface's module constants and small helpers (the pan, extent,
 * overscroll and paper numbers, the measure-hold and pinch-constraint types and
 * the canvas reallocation counter) live in InkOverlayConstants.ts, and
 * InkOverlay.ts re-exports them, so every importer keeps its import line. Four
 * things a type check cannot see are held here, as the tool-state and registry
 * tests hold theirs for their files.
 *
 * LOAD. This file imports the constants first. The constants file reads
 * nothing from InkOverlay.ts or any overlay part, so it loads on its own; every
 * other test imports InkOverlay.ts first and so checks the other direction.
 *
 * ONE COPY. Each moved name must be the very same function or binding from
 * both files, not a second definition that happens to behave alike. The
 * reallocation counter is checked live: a bump through the new file is read
 * through InkOverlay.ts.
 *
 * NO BODY LEFT BEHIND. InkOverlay.ts holds no declaration of a moved name and
 * no write to the counter, and the new file holds exactly one of each name.
 * The new file takes nothing back from InkOverlay.ts or an overlay part.
 *
 * LISTED. The note row of the ink-surface ledger names the new file, so every
 * rule that reads the note surface's files reads this one too.
 */
import { describe, expect, it } from "vitest";

import * as constants from "./InkOverlayConstants";
import * as overlay from "./InkOverlay";
import overlayRaw from "./InkOverlay.ts?raw";
import constantsRaw from "./InkOverlayConstants.ts?raw";
import { surfaceFiles } from "./surfaceFiles.testutil";

/** Values exported by the new file and re-exported, under the same name, by InkOverlay.ts. */
const MOVED = [
	"PINCH_SCROLL_QUIET_MS",
	"PAN_MIN_VISIBLE_PX",
	"PAN_DRAG_SCALE_EPS",
	"PAN_DRAG_FRAME_EPS",
	"PAN_DRAG_WINDOW",
	"PAN_FIT_SLACK_PX",
	"PAN_SETTLE_ZOOM_BAND",
	"EXTENT_RASTER_MAX_PX_DESKTOP",
	"EXTENT_RASTER_MAX_PX_MOBILE",
	"inkLookKey",
	"EXTENT_PIECE_MS",
	"EXTENT_PIECE_RETRY_MS",
	"EXTENT_SCROLL_QUIET_MS",
	"extentRasterFits",
	"EXTENT_PAIR_FACTOR",
	"STAND_IN_MIN_FACTOR",
	"ZOOM_STAND_IN_ENABLED",
	"standInFactorFits",
	"extentPairFits",
	"OVERSCROLL_BOUNCE_MS",
	"OVERSCROLL_BOUNCE_MIN_PX",
	"OVERSCROLL_GIVE_PX",
	"travelledEaseRoom",
	"canvasReallocs",
	"inkCanvasReallocs",
	"bumpCanvasReallocs",
	"SCALE_EPSILON",
	"CONTENT_ORIGIN_EPSILON",
	"PAPER_PROPERTIES",
	"SELECTION_GRAB_PAD",
	"INLINE_DESYNCHRONIZED",
	"PRED_HISTORY",
] as const;

/** Types exported by the new file and re-exported by InkOverlay.ts. */
const MOVED_TYPES = ["CmMeasureRequest", "MeasureHoldEntry", "MeasureHold"] as const;

/** Types exported by the new file for InkOverlay.ts's own code, and never re-exported from it. */
const SHARED_TYPES = ["PinchConstraintGeometry", "PinchConstraint", "PenMode"] as const;

function declarations(source: string, name: string): number {
	const text = source.replace(/\r\n/g, "\n");
	return text.match(new RegExp(`^(?:export )?(?:async function|function|const|let|type|interface) ${name}\\b`, "gm"))?.length ?? 0;
}

function listFrom(text: string, head: string, from: string): string[] | undefined {
	const escaped = from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	const match = text.match(new RegExp(`^${head} \\{([^}]*)\\} from "${escaped}";`, "m"));
	return match?.[1]?.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

describe("the note surface's module constants live in InkOverlayConstants.ts", () => {
	it("loads with the constants imported first, with the counter at zero", () => {
		expect(constants.inkCanvasReallocs()).toBe(0);
		expect(constants.PAN_MIN_VISIBLE_PX).toBeGreaterThan(0);
		expect(overlay.inkCanvasReallocs()).toBe(0);
	});

	it("is re-exported from InkOverlay.ts as the same function or value, name by name", () => {
		const fromOverlay = overlay as unknown as Record<string, unknown>;
		const fromConstants = constants as unknown as Record<string, unknown>;
		expect(Object.keys(fromConstants).sort()).toEqual([...MOVED].sort());
		for (const name of MOVED) {
			expect(name in fromOverlay, `${name} is not exported by InkOverlay.ts`).toBe(true);
			expect(fromOverlay[name], `${name} is not the same value from both files`).toBe(fromConstants[name]);
		}
	});

	it("reads the reallocation counter live through InkOverlay.ts", () => {
		const before = constants.inkCanvasReallocs();
		constants.bumpCanvasReallocs();
		expect(constants.inkCanvasReallocs()).toBe(before + 1);
		expect(overlay.inkCanvasReallocs()).toBe(before + 1);
		expect(overlay.canvasReallocs).toBe(before + 1);
		expect(constants.canvasReallocs).toBe(before + 1);
		overlay.bumpCanvasReallocs();
		expect(constants.inkCanvasReallocs()).toBe(before + 2);
	});

	it("keeps the three types InkOverlay.ts only uses out of its exports", () => {
		const text = overlayRaw.replace(/\r\n/g, "\n");
		expect(listFrom(text, "export type", "./InkOverlayConstants")?.sort()).toEqual([...MOVED_TYPES].sort());
		expect(listFrom(text, "export", "./InkOverlayConstants")?.sort()).toEqual([...MOVED].sort());
		for (const name of SHARED_TYPES) {
			expect(declarations(constantsRaw, name), `${name} in InkOverlayConstants.ts`).toBe(1);
			expect(constantsRaw, `${name} is not exported by InkOverlayConstants.ts`).toMatch(new RegExp(`^export (?:type|interface) ${name}\\b`, "m"));
			expect(listFrom(text, "export type", "./InkOverlayConstants"), name).not.toContain(name);
			expect(listFrom(text, "export", "./InkOverlayConstants"), name).not.toContain(name);
		}
	});

	it("is listed in the note row of the ink-surface ledger", () => {
		expect(surfaceFiles("note")).toContain("/src/inline/InkOverlayConstants.ts");
	});
});

describe("no declaration is left behind in InkOverlay.ts", () => {
	it("declares each moved name once in the new file and never in InkOverlay.ts", () => {
		for (const name of [...MOVED, ...MOVED_TYPES, ...SHARED_TYPES]) {
			expect(declarations(constantsRaw, name), `${name} in InkOverlayConstants.ts`).toBe(1);
			expect(declarations(overlayRaw, name), `${name} in InkOverlay.ts`).toBe(0);
		}
		expect(MOVED.length + MOVED_TYPES.length + SHARED_TYPES.length).toBe(38);
	});

	it("writes the counter only through its function, and the new file takes nothing back from the overlay", () => {
		const overlayText = overlayRaw.replace(/\r\n/g, "\n");
		const constantsText = constantsRaw.replace(/\r\n/g, "\n");
		expect(overlayText).not.toMatch(/\bcanvasReallocs\s*(?:\+\+|--|[-+*/]?=[^=])/);
		expect(overlayText).toMatch(/^import \{[^}]*\} from "\.\/InkOverlayConstants";/m);
		expect(constantsText).not.toMatch(/from "\.\/InkOverlay[A-Za-z]*"/);
		expect(constantsText).not.toMatch(/import\("\.\/InkOverlay[A-Za-z]*"\)/);
	});
});
