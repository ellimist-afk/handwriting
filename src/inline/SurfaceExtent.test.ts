/**
 * THE ONE STYLESHEET ASSERTION HERE READS CODE, NOT THE STYLESHEET'S TEXT, and
 * it is the worst-shaped member of the family: a commented-out rule does not
 * merely satisfy the presence match, it SUPPLIES THE BODY the two assertions
 * after it inspect. `String.match` returns the FIRST match, so a retired copy
 * sitting above the live rule is the one that gets read.
 *
 * Demonstrated on this branch: a commented copy of the axis rule was inserted
 * ahead of the real one, and the real one was given `overflow-x: auto
 * !important` - the exact thing the third assertion forbids, because the
 * `.handwriting-page` ancestor already supplies the specificity. All 33 tests
 * passed. The guard reported on a comment and never looked at the cascade.
 *
 * `codeOnly` (src/CodeOnly.ts) is the shared stripper, imported not copied.
 * `styles.css` carries no `//` sequence (verified), so the line-comment half
 * cannot over-blank it. Nothing here is weakened: blanking comments can only
 * remove candidate matches, and the match that remains is the rule the browser
 * actually applies. No assertion in this file pins a documented REASON, so
 * none is left reading raw.
 */

import { describe, expect, it } from "vitest";
import { codeOnly } from "../CodeOnly";
import {
	EXTENT_CHUNK,
	ScrollExpansionDemand,
	EXTENT_HEADROOM,
	EXTENT_MARGIN,
	HSCROLL_AXIS_CLASS,
	ScrollAxisGuard,
	SurfaceExtents,
	ZERO_EXTENT,
	grownAxis,
	grownExtent,
	inkClaimX,
	inkFrontier,
	inkLeftReach,
	leftReserve,
	isScrollableOverflow,
	onScreenFloorX,
	shrunkAxis,
	spacerPosition,
	surfaceOriginInScroller,
	writeFrontier,
	writeFrontierApplies,
	WRITE_FRONTIER_VIEWPORT_FRACTION,
	zoomFrontier,
} from "./SurfaceExtent";
import { InkStroke } from "../ink/Stroke";
import css from "../../styles.css?raw";

/**
 * The axis rule's declarations as the browser would see them, or null if the
 * sheet does not carry the rule. A pure function over sheet text so the
 * fixtures below can attack it with a string.
 */
function axisRuleBody(sheet: string): string | null {
	const rule = new RegExp(
		`\\.markdown-source-view\\s+\\.cm-editor\\s+\\.cm-scroller\\.${HSCROLL_AXIS_CLASS}\\s*\\{([^}]*)\\}`
	);
	return codeOnly(sheet).match(rule)?.[1] ?? null;
}

function stroke(x: number, y: number, w: number, h: number): InkStroke {
	return {
		id: `s-${x}-${y}`,
		tool: "pen",
		color: "#000",
		width: 2,
		points: [],
		bbox: { x, y, width: w, height: h },
		createdAt: 0,
	};
}

describe("grownAxis — chunked, never-shrinking grants", () => {
	it("grants nothing for a frontier at or below zero", () => {
		expect(grownAxis(0, 0)).toBe(0);
		expect(grownAxis(0, -5)).toBe(0);
		expect(grownAxis(512, Number.NaN)).toBe(512);
	});

	it("rounds the first grant up to whole chunks past the headroom", () => {
		// 1 + 256 headroom = 257 -> 2 chunks = 512.
		expect(grownAxis(0, 1)).toBe(2 * EXTENT_CHUNK);
		// 300 + 256 = 556 -> 3 chunks = 768.
		expect(grownAxis(0, 300)).toBe(3 * EXTENT_CHUNK);
	});

	it("keeps the current grant while the frontier stays clear of the margin", () => {
		const current = 512;
		// Frontier exactly at the margin edge: still inside, no growth.
		expect(grownAxis(current, current - EXTENT_MARGIN)).toBe(current);
		expect(grownAxis(current, 100)).toBe(current);
	});

	it("grows preemptively when the frontier crosses the margin", () => {
		const current = 512;
		const needed = current - EXTENT_MARGIN + 1; // 393
		expect(grownAxis(current, needed)).toBe(
			Math.ceil((needed + EXTENT_HEADROOM) / EXTENT_CHUNK) * EXTENT_CHUNK
		);
	});

	it("never shrinks", () => {
		expect(grownAxis(1024, 200)).toBe(1024);
		expect(grownAxis(1024, 950)).toBeGreaterThanOrEqual(1024);
	});
});

describe("grownExtent", () => {
	it("returns the SAME object when nothing grew (cheap-compare contract)", () => {
		const cur = { x: 512, y: 768 };
		expect(grownExtent(cur, { x: 100, y: 100 })).toBe(cur);
	});

	it("grows each axis independently", () => {
		const next = grownExtent({ x: 512, y: 512 }, { x: 600, y: 100 });
		expect(next.x).toBe(Math.ceil((600 + EXTENT_HEADROOM) / EXTENT_CHUNK) * EXTENT_CHUNK);
		expect(next.y).toBe(512);
	});
});

describe("inkClaimX (sideways room grows from ink near the edge, or from any ink with Infinite Canvas on)", () => {
	const pane = { originLeft: 40, clientWidth: 420, fontZoom: 1 };

	it("with Infinite Canvas on, is the frontier, as before", () => {
		expect(inkClaimX({ ...pane, frontierX: 100, infiniteCanvas: true })).toBe(100);
		expect(inkClaimX({ ...pane, frontierX: 370, infiniteCanvas: true })).toBe(370);
	});

	it("with it off, is nothing while the ink stays further than the margin from the pane's right edge", () => {
		// 40 + 260 = 300 = 420 - 120: at the margin, not inside it.
		expect(inkClaimX({ ...pane, frontierX: 260, infiniteCanvas: false })).toBe(0);
		expect(inkClaimX({ ...pane, frontierX: 10, infiniteCanvas: false })).toBe(0);
	});

	it("with it off, is the frontier once the ink comes within the margin of the pane's right edge", () => {
		expect(inkClaimX({ ...pane, frontierX: 261, infiniteCanvas: false })).toBe(261);
		// At the pane's edge: within the margin, so it claims (it did not under the old past-the-edge rule).
		expect(inkClaimX({ ...pane, frontierX: 380, infiniteCanvas: false })).toBe(380);
		expect(inkClaimX({ ...pane, frontierX: 1500, infiniteCanvas: false })).toBe(1500);
	});

	it("scales the frontier and the margin by the font zoom before comparing them with the pane", () => {
		// 40 + 70 * 2 = 180 = 420 - 120 * 2.
		expect(inkClaimX({ ...pane, fontZoom: 2, frontierX: 70, infiniteCanvas: false })).toBe(0);
		expect(inkClaimX({ ...pane, fontZoom: 2, frontierX: 71, infiniteCanvas: false })).toBe(71);
	});

	it("asks for nothing on no ink or an unusable zoom", () => {
		expect(inkClaimX({ ...pane, frontierX: 0, infiniteCanvas: false })).toBe(0);
		expect(inkClaimX({ ...pane, frontierX: 900, fontZoom: 0, infiniteCanvas: false })).toBe(0);
		expect(inkClaimX({ ...pane, frontierX: Number.NaN, infiniteCanvas: false })).toBe(0);
	});
});

describe("onScreenFloorX (a shrink never pulls the range under the view)", () => {
	it("is nothing at the left edge", () => {
		expect(onScreenFloorX({ scrollLeft: 0, clientWidth: 420, originLeft: 40, fontZoom: 1 })).toBe(0);
	});

	it("reaches the right edge of the view, in whole chunks", () => {
		// 815 + 420 + 1 - 40 = 1196 -> 5 chunks.
		const floor = onScreenFloorX({ scrollLeft: 815, clientWidth: 420, originLeft: 40, fontZoom: 1 });
		expect(floor).toBe(5 * EXTENT_CHUNK);
		expect(40 + floor).toBeGreaterThanOrEqual(815 + 420);
	});

	it("is in note px under a font zoom", () => {
		// (815 + 420 + 1 - 40) / 2 = 598 -> 3 chunks.
		expect(onScreenFloorX({ scrollLeft: 815, clientWidth: 420, originLeft: 40, fontZoom: 2 })).toBe(3 * EXTENT_CHUNK);
	});
});

describe("shrunkAxis (the grant after ink is removed)", () => {
	it("comes down to what the remaining need would earn from nothing", () => {
		expect(shrunkAxis(2048, 0, 0)).toEqual({ value: 0, complete: true });
		expect(shrunkAxis(2048, 300, 0)).toEqual({ value: grownAxis(0, 300), complete: true });
	});

	it("stops at the floor and owes the rest", () => {
		expect(shrunkAxis(2048, 0, 1280)).toEqual({ value: 1280, complete: false });
	});

	it("is complete once the floor is under the need", () => {
		expect(shrunkAxis(2048, 1000, 512)).toEqual({ value: grownAxis(0, 1000), complete: true });
	});

	it("never raises the grant", () => {
		expect(shrunkAxis(256, 0, 1280)).toEqual({ value: 256, complete: false });
		expect(shrunkAxis(512, 1000, 0)).toEqual({ value: 512, complete: true });
	});

	it("does not grow back on the next pass: the shrunk grant clears the growth margin", () => {
		const { value } = shrunkAxis(4096, 700, 0);
		expect(grownAxis(value, 700)).toBe(value);
	});
});

describe("inkFrontier", () => {
	it("is zero for no strokes", () => {
		expect(inkFrontier([])).toEqual({ x: 0, y: 0 });
	});

	it("is the furthest right/bottom bbox corner across strokes", () => {
		const f = inkFrontier([stroke(10, 400, 50, 20), stroke(300, 5, 40, 10)]);
		expect(f).toEqual({ x: 340, y: 420 });
	});
});

describe("inkLeftReach", () => {
	it("is zero when no ink reaches left of the origin", () => {
		expect(inkLeftReach([])).toBe(0);
		expect(inkLeftReach([stroke(0, 10, 50, 20), stroke(300, 5, 40, 10)])).toBe(0);
	});

	it("is the furthest any bbox reaches left of the origin", () => {
		expect(inkLeftReach([stroke(-40, 10, 50, 20), stroke(-218, 5, 116, 10), stroke(20, 0, 5, 5)])).toBe(218);
	});
});

describe("leftReserve", () => {
	it("holds no room left of the page, however far the ink reaches past the margin", () => {
		expect(leftReserve({ reachNote: 218, naturalMargin: 100, fontZoom: 1 })).toBe(0);
		expect(leftReserve({ reachNote: 100, naturalMargin: 40.4, fontZoom: 1.5 })).toBe(0);
		expect(leftReserve({ reachNote: 620, naturalMargin: 0, fontZoom: 2 })).toBe(0);
		expect(leftReserve({ reachNote: 30, naturalMargin: -12, fontZoom: 1 })).toBe(0);
	});

	it("holds nothing where the margin covers the reach, or there is no reach", () => {
		expect(leftReserve({ reachNote: 218, naturalMargin: 341, fontZoom: 1 })).toBe(0);
		expect(leftReserve({ reachNote: 0, naturalMargin: 0, fontZoom: 1 })).toBe(0);
		expect(leftReserve({ reachNote: 50, naturalMargin: 0, fontZoom: 0 })).toBe(0);
		expect(leftReserve({ reachNote: Number.NaN, naturalMargin: 0, fontZoom: 1 })).toBe(0);
	});
});

describe("surfaceOriginInScroller", () => {
	it("maps the note origin into scroller-content coordinates", () => {
		const o = surfaceOriginInScroller({
			contentLeftVisual: 260,
			documentTopVisual: -900,
			scrollRectLeft: 60,
			scrollRectTop: 100,
			scrollLeft: 0,
			scrollTop: 1000,
			scale: 1,
		});
		expect(o.left).toBe(200);
		expect(o.top).toBe(0); // -900 - 100 + 1000
	});

	it("divides the visual-px rect deltas by the scale, not the scroll offsets", () => {
		const o = surfaceOriginInScroller({
			contentLeftVisual: 260,
			documentTopVisual: 300,
			scrollRectLeft: 60,
			scrollRectTop: 100,
			scrollLeft: 40,
			scrollTop: 80,
			scale: 2,
		});
		expect(o.left).toBe(100 + 40);
		expect(o.top).toBe(100 + 80);
	});
});

describe("spacerPosition", () => {
	it("adds the granted extent to the origin and rounds to whole px", () => {
		expect(spacerPosition({ left: 200.4, top: 0.6 }, { x: 512, y: 768 })).toEqual({
			left: 712,
			top: 769,
		});
	});
});

describe("isScrollableOverflow", () => {
	it("accepts auto/scroll/overlay in any case or padding", () => {
		expect(isScrollableOverflow("auto")).toBe(true);
		expect(isScrollableOverflow(" SCROLL ")).toBe(true);
		expect(isScrollableOverflow("overlay")).toBe(true);
	});

	it("rejects hidden/visible/clip", () => {
		expect(isScrollableOverflow("hidden")).toBe(false);
		expect(isScrollableOverflow("visible")).toBe(false);
		expect(isScrollableOverflow("clip")).toBe(false);
	});
});

/** The guard touches only el.style's property API — stub exactly that. */
function fakeClassedElement(): HTMLElement & { classes: Set<string> } {
	const classes = new Set<string>();
	const classList = {
		add: (c: string) => void classes.add(c),
		remove: (c: string) => void classes.delete(c),
	};
	return { classList, classes } as unknown as HTMLElement & { classes: Set<string> };
}

describe("ScrollAxisGuard", () => {
	it("patches only when the computed value is not scrollable", () => {
		const el = fakeClassedElement();
		const guard = new ScrollAxisGuard();
		guard.assert(el, "hidden");
		expect(guard.patched).toBe(true);
		expect(el.classes.has(HSCROLL_AXIS_CLASS)).toBe(true);
	});

	it("leaves an already-scrollable axis alone", () => {
		const el = fakeClassedElement();
		const guard = new ScrollAxisGuard();
		guard.assert(el, "auto");
		expect(guard.patched).toBe(false);
		expect(el.classes.size).toBe(0);
	});

	it("restore drops the class and nothing else, idempotently", () => {
		const el = fakeClassedElement();
		const guard = new ScrollAxisGuard();
		guard.assert(el, "hidden");
		guard.assert(el, "hidden");
		expect(el.classes.size).toBe(1);
		guard.restore(el);
		guard.restore(el);
		expect(guard.patched).toBe(false);
		expect(el.classes.size).toBe(0);
	});

	it("styles.css carries the rule the class relies on", () => {
		// The guard is inert without its stylesheet half; the packager asserts
		// this too, but a stale styles.css in dev should fail loudly here. The
		// Editor ancestor supplies enough specificity without important.
		//
		// The body comes from the cascade, not from the file. A retired copy
		// above the live rule used to be the one this read.
		const body = axisRuleBody(css);
		expect(body, "axis rule present in the cascade, not merely in the file").not.toBeNull();
		expect(body!).toMatch(/overflow-x:\s*auto/);
		expect(body!).not.toContain("!important");
	});

	it("the axis-rule reader takes its body from the cascade", () => {
		// Fixtures. Anti-vacuity first, then THE DEFEAT verbatim: a commented
		// copy ahead of a live rule that has grown !important. Read raw, the
		// comment answered for the rule and all 33 tests passed.
		const live = `.markdown-source-view .cm-editor .cm-scroller.${HSCROLL_AXIS_CLASS} {\n\toverflow-x: auto;\n}\n`;
		const loud = `.markdown-source-view .cm-editor .cm-scroller.${HSCROLL_AXIS_CLASS} {\n\toverflow-x: auto !important;\n}\n`;

		expect(axisRuleBody(live)).toMatch(/overflow-x:\s*auto/);
		expect(axisRuleBody(`/*\n${live}*/\n`)).toBeNull();
		expect(axisRuleBody(`/*\n${live}*/\n${loud}`)).toContain("!important");
	});
});

describe("SurfaceExtents: a sideways shrink falls due", () => {
	it("only for a note holding sideways room", () => {
		const extents = new SurfaceExtents();
		extents.grow("tall.md", { x: 0, y: 900 });
		extents.oweShrinkX("tall.md");
		expect(extents.owesShrinkX("tall.md")).toBe(false);
		extents.grow("wide.md", { x: 1500, y: 0 });
		extents.oweShrinkX("wide.md");
		expect(extents.owesShrinkX("wide.md")).toBe(true);
		extents.settleShrinkX("wide.md");
		expect(extents.owesShrinkX("wide.md")).toBe(false);
	});

	it("for every wide note at once when Infinite Canvas is turned off", () => {
		const extents = new SurfaceExtents();
		extents.grow("a.md", { x: 1500, y: 0 });
		extents.grow("b.md", { x: 0, y: 900 });
		extents.grow("c.md", { x: 700, y: 700 });
		extents.oweShrinkXEverywhere();
		expect(["a.md", "b.md", "c.md"].map(p => extents.owesShrinkX(p))).toEqual([true, false, true]);
	});

	it("carries a new generation each time it falls due, so a fresh shrink is told from a held one", () => {
		const extents = new SurfaceExtents();
		extents.grow("a.md", { x: 1500, y: 0 });
		expect(extents.shrinkDue("a.md")).toBeUndefined();
		extents.oweShrinkX("a.md");
		const first = extents.shrinkDue("a.md");
		expect(first).toBeDefined();
		extents.oweShrinkX("a.md");
		expect(extents.shrinkDue("a.md")).not.toBe(first);
		extents.oweShrinkXEverywhere();
		const third = extents.shrinkDue("a.md");
		expect([first, third].every(g => g !== undefined) && third !== first).toBe(true);
		extents.settleShrinkX("a.md");
		expect(extents.shrinkDue("a.md")).toBeUndefined();
	});

	it("follows a rename and goes with a delete", () => {
		const extents = new SurfaceExtents();
		extents.grow("old.md", { x: 1500, y: 0 });
		extents.oweShrinkX("old.md");
		const due = extents.shrinkDue("old.md");
		extents.handleRename("old.md", "new.md");
		expect(extents.owesShrinkX("old.md")).toBe(false);
		expect(extents.owesShrinkX("new.md")).toBe(true);
		expect(extents.shrinkDue("new.md"), "the rename keeps the generation").toBe(due);
		extents.handleDelete("new.md");
		expect(extents.owesShrinkX("new.md")).toBe(false);
	});
});

describe("SurfaceExtents.shrinkX", () => {
	it("lowers only the x grant, and only downward", () => {
		const extents = new SurfaceExtents();
		extents.grow("a.md", { x: 1500, y: 900 });
		const before = extents.get("a.md");
		expect(extents.shrinkX("a.md", 4096)).toBe(before);
		const after = extents.shrinkX("a.md", 256);
		expect(after).toEqual({ x: 256, y: before.y });
		expect(extents.get("a.md")).toBe(after);
		expect(extents.shrinkX("a.md", -10)).toEqual({ x: 0, y: before.y });
	});

	it("counts the shrinks, and only the shrinks, per note", () => {
		const extents = new SurfaceExtents();
		extents.grow("a.md", { x: 1500, y: 900 });
		expect(extents.shrinkCount("a.md")).toBe(0);
		extents.shrinkX("a.md", 4096);
		extents.grow("a.md", { x: 3000, y: 900 });
		expect(extents.shrinkCount("a.md"), "a no-op shrink and a grow are not shrinks").toBe(0);
		extents.shrinkX("a.md", 512);
		expect(extents.shrinkCount("a.md")).toBe(1);
		extents.handleRename("a.md", "b.md");
		expect([extents.shrinkCount("a.md"), extents.shrinkCount("b.md")]).toEqual([0, 1]);
		extents.handleDelete("b.md");
		expect(extents.shrinkCount("b.md")).toBe(0);
	});

	it("merges the counters on a rename onto a note that has its own, like the grant", () => {
		const extents = new SurfaceExtents();
		extents.grow("old.md", { x: 1500, y: 0 });
		extents.grow("new.md", { x: 1500, y: 0 });
		extents.shrinkX("old.md", 900);
		extents.shrinkX("new.md", 900);
		extents.shrinkX("new.md", 600);
		extents.oweShrinkX("old.md");
		extents.oweShrinkX("new.md");
		const newerDue = extents.shrinkDue("new.md");
		extents.handleRename("old.md", "new.md");
		expect(extents.shrinkCount("new.md"), "the target's larger shrink count survives").toBe(2);
		expect(extents.shrinkDue("new.md"), "the target's newer due generation survives").toBe(newerDue);
		expect([extents.shrinkCount("old.md"), extents.owesShrinkX("old.md")]).toEqual([0, false]);
	});
});

describe("SurfaceExtents", () => {
	it("starts at the shared zero extent", () => {
		const s = new SurfaceExtents();
		expect(s.get("a.md")).toBe(ZERO_EXTENT);
	});

	it("grows per path and remembers", () => {
		const s = new SurfaceExtents();
		const grown = s.grow("a.md", { x: 300, y: 10 });
		expect(grown.x).toBeGreaterThan(0);
		expect(s.get("a.md")).toBe(grown);
		expect(s.get("b.md")).toBe(ZERO_EXTENT);
	});

	it("moves the grant on rename, keeping the larger when both exist", () => {
		const s = new SurfaceExtents();
		s.grow("a.md", { x: 900, y: 10 });
		s.grow("b.md", { x: 10, y: 900 });
		const a = s.get("a.md");
		const b = s.get("b.md");
		s.handleRename("a.md", "b.md");
		expect(s.get("a.md")).toBe(ZERO_EXTENT);
		expect(s.get("b.md")).toEqual({ x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) });
	});

	it("drops the grant on delete", () => {
		const s = new SurfaceExtents();
		s.grow("a.md", { x: 300, y: 300 });
		s.handleDelete("a.md");
		expect(s.get("a.md")).toBe(ZERO_EXTENT);
	});
});

describe("zoomFrontier (the magnified note must be reachable)", () => {
	const base = {
		clientWidth: 800,
		clientHeight: 600,
		contentBottom: 2000,
		origin: { left: 100, top: 0 },
		fontZoom: 1,
	};

	it("grants nothing at scale 1 or below", () => {
		expect(zoomFrontier({ ...base, pinchScale: 1 })).toEqual({ x: 0, y: 0 });
		expect(zoomFrontier({ ...base, pinchScale: 0.5 })).toEqual({ x: 0, y: 0 });
	});

	it("at 2x, reaches the far half the transform pushed past the pane", () => {
		// The pane shows a 1/2 slice of the scroller at 2x, so reaching the
		// content's far edge needs scroll up to size * (1 - 1/2) beyond what
		// scale 1 needed - on both axes, past the document bottom too.
		const f = zoomFrontier({ ...base, pinchScale: 2 });
		expect(f.x).toBe(800 * 1.5 - 100);
		expect(f.y).toBe(2000 + 600 * 0.5);
	});

	it("scales down with font zoom, since the spacer scales it back up", () => {
		const f = zoomFrontier({ ...base, fontZoom: 2, pinchScale: 2 });
		expect(f.x).toBe((800 * 1.5 - 100) / 2);
	});

	it("never returns a negative axis", () => {
		const f = zoomFrontier({ ...base, origin: { left: 5000, top: 5000 }, pinchScale: 1.1 });
		expect(f.x).toBe(0);
	});

	it("holds still on junk scales", () => {
		expect(zoomFrontier({ ...base, pinchScale: Number.NaN })).toEqual({ x: 0, y: 0 });
	});
});

describe("writeFrontier (room to write at the top - 1.4.6 §5n)", () => {
	// Phone-sized: a folding phone's inner display, per the user report.
	const base = {
		clientHeight: 700,
		contentBottom: 400,
		origin: { top: 0 },
		fontZoom: 1,
	};

	it("reaches most of a phone viewport past the document bottom", () => {
		const f = writeFrontier(base);
		expect(f).toEqual({ x: 0, y: 400 + 700 * WRITE_FRONTIER_VIEWPORT_FRACTION });
	});

	it("scales down with font zoom, matching zoomFrontier's convention", () => {
		const f = writeFrontier({ ...base, fontZoom: 2 });
		expect(f.y).toBe((400 + 700 * WRITE_FRONTIER_VIEWPORT_FRACTION) / 2);
	});

	it("subtracts the origin before dividing by font zoom", () => {
		const f = writeFrontier({ ...base, origin: { top: 200 } });
		expect(f.y).toBe(400 + 700 * WRITE_FRONTIER_VIEWPORT_FRACTION - 200);
	});

	it("never returns a negative axis", () => {
		const f = writeFrontier({ ...base, origin: { top: 5000 } });
		expect(f).toEqual({ x: 0, y: 0 });
	});

	it("holds still on a junk font zoom, like zoomFrontier does on junk scale", () => {
		expect(writeFrontier({ ...base, fontZoom: 0 })).toEqual({ x: 0, y: 0 });
		expect(writeFrontier({ ...base, fontZoom: Number.NaN })).toEqual({ x: 0, y: 0 });
	});

	it("not written on: folding ZERO_EXTENT into the vertical max changes nothing", () => {
		// `updateExtent` passes ZERO_EXTENT instead of calling writeFrontier
		// when the surface has not been written on. inkFrontier/zoomFrontier
		// both clamp to >= 0, so a 0 term never wins Math.max - the grant a
		// typing-only note gets is exactly what it is today, byte-identical.
		const ink = { x: 0, y: 340 };
		const zoom = zoomFrontier({
			clientWidth: 800,
			clientHeight: 600,
			contentBottom: 2000,
			origin: { left: 0, top: 0 },
			pinchScale: 1, // <= 1: zoom grants nothing, so it cannot mask the contrast below.
			fontZoom: 1,
		});
		const todaysGrant = Math.max(ink.y, zoom.y);
		expect(Math.max(ink.y, zoom.y, ZERO_EXTENT.y)).toBe(todaysGrant);
		// Contrast: when written on, the frontier DOES move the grant.
		expect(Math.max(ink.y, zoom.y, writeFrontier(base).y)).toBeGreaterThan(todaysGrant);
	});
});

describe("writeFrontierApplies (zooming out is a handwriting act)", () => {
	// The same phone-sized viewport, and the same fold `updateExtent` does:
	// the write term is writeFrontier when the predicate holds, ZERO_EXTENT
	// when it does not, and it joins the vertical max.
	const base = {
		clientHeight: 700,
		contentBottom: 400,
		origin: { top: 0 },
		fontZoom: 1,
	};
	const ink = { x: 0, y: 340 };
	const zoomTerm = (pinchScale: number) =>
		zoomFrontier({
			clientWidth: 800,
			clientHeight: 700,
			contentBottom: 400,
			origin: { left: 0, top: 0 },
			pinchScale,
			fontZoom: 1,
		});
	const grantY = (writtenOn: boolean, pinchScale: number) => {
		const write = writeFrontierApplies({ writtenOn, pinchScale })
			? writeFrontier(base)
			: ZERO_EXTENT;
		return Math.max(ink.y, zoomTerm(pinchScale).y, write.y);
	};

	it("grants an unwritten note the write frontier once the viewport is zoomed out", () => {
		expect(writeFrontierApplies({ writtenOn: false, pinchScale: 0.5 })).toBe(true);
		const granted = grantY(false, 0.5);
		expect(granted).toBeGreaterThan(0);
		// The value is the write frontier's, not a rounded stand-in for it.
		expect(granted).toBe(writeFrontier(base).y);
		expect(granted).toBeGreaterThan(grantY(false, 1));
	});

	it("grants an unwritten note nothing at 1.0, so a typing-only vault is unchanged", () => {
		expect(writeFrontierApplies({ writtenOn: false, pinchScale: 1 })).toBe(false);
		expect(grantY(false, 1)).toBe(Math.max(ink.y, zoomTerm(1).y));
	});

	it("grants an unwritten note nothing on zoom IN, which zoomFrontier already covers", () => {
		expect(writeFrontierApplies({ writtenOn: false, pinchScale: 2 })).toBe(false);
		expect(grantY(false, 2)).toBe(Math.max(ink.y, zoomTerm(2).y));
	});

	it("still grants a written-on note at every scale, which is the original rule", () => {
		for (const pinchScale of [0.5, 1, 2]) {
			expect(writeFrontierApplies({ writtenOn: true, pinchScale })).toBe(true);
		}
		expect(grantY(true, 1)).toBe(writeFrontier(base).y);
	});
});


it("rebases camera offsets and resized viewports with remaining room without new demand",()=>{
 const demand=new ScrollExpansionDemand();
 const room={left:0,top:0,width:640,height:480,edgeX:1280,edgeY:960,origin:{left:0,top:0},fontZoom:1,pinchScale:1};
 demand.sample("note",true,0,0);demand.reserve(room);
 demand.rebase(500,400);demand.sample("note",true,500,400);
 const resized={...room,left:500,top:400,width:32000,height:24000,edgeX:64000,edgeY:48000,pinchScale:.02};
 expect(demand.reserve(resized)).toEqual({x:0,y:0});
 demand.sample("note",true,30000,23000);
 const grown=demand.reserve({...resized,left:30000,top:23000});
 expect(grown.x).toBeGreaterThan(0);expect(grown.y).toBeGreaterThan(0);
});

it("restores a native axis stranded by zoom rebase once, then stays still",()=>{
 const demand=new ScrollExpansionDemand();
 const room={left:0,top:0,width:640,height:480,edgeX:1280,edgeY:960,origin:{left:40,top:20},fontZoom:2,pinchScale:1};
 demand.sample("note",true,0,0);demand.reserve(room);demand.rebase(0,0);
 const resized={...room,width:6400,height:4800,edgeX:6400,edgeY:4800,pinchScale:.1};
 expect(demand.reserve(resized)).toEqual({x:6380,y:4790});
 demand.applied(12800,9600);
 for(let i=0;i<4;i++) { demand.rebase(0,0); expect(demand.reserve({...resized,edgeX:12800,edgeY:9600})).toEqual({x:0,y:0}); }
});

it("reserves accepted pinch travel before native clamping without reverse or cross-axis growth",()=>{
 const demand=new ScrollExpansionDemand();
 const room={left:500,top:300,width:640,height:480,edgeX:1800,edgeY:1400,origin:{left:40,top:20},fontZoom:2,pinchScale:.5};
 demand.sample("note",true,500,300);demand.reserve(room);demand.rebase(500,300);
 expect(demand.reserve(room,{left:1600,top:200})).toEqual({x:1420,y:0});
 demand.applied(2880,1400);demand.rebase(1600,300);
 expect(demand.reserve({...room,left:1600,edgeX:2880},{left:1200,top:200})).toEqual({x:0,y:0});
 demand.sample("note",false,1600,300);
 expect(demand.reserve(room,{left:5000,top:5000})).toBe(ZERO_EXTENT);
});

it("preserves admitted native demand through band resize and retires it on navigation",()=>{
 const room={left:0,top:0,width:640,height:480,edgeX:1280,edgeY:960,origin:{left:0,top:0},fontZoom:1,pinchScale:1};
 for(const mechanical of [false,true]) {
  const demand=new ScrollExpansionDemand();demand.sample("note",true,0,0);demand.reserve(room);
  demand.sample("note",true,620,0);demand.rebase(620,0,mechanical);
  expect(demand.reserve({...room,left:620})).toEqual({x:mechanical?1900:0,y:0});
 }
});
