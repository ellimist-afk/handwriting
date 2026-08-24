import { describe, expect, it } from "vitest";
import {
	EXTENT_CHUNK,
	EXTENT_HEADROOM,
	EXTENT_MARGIN,
	HSCROLL_AXIS_CLASS,
	ScrollAxisGuard,
	SurfaceExtents,
	ZERO_EXTENT,
	grownAxis,
	grownExtent,
	inkFrontier,
	isScrollableOverflow,
	spacerPosition,
	surfaceOriginInScroller,
} from "./SurfaceExtent";
import { InkStroke } from "../ink/Stroke";
import css from "../../styles.css?raw";

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

describe("inkFrontier", () => {
	it("is zero for no strokes", () => {
		expect(inkFrontier([])).toEqual({ x: 0, y: 0 });
	});

	it("is the furthest right/bottom bbox corner across strokes", () => {
		const f = inkFrontier([stroke(10, 400, 50, 20), stroke(300, 5, 40, 10)]);
		expect(f).toEqual({ x: 340, y: 420 });
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
		// Handwriting-page ancestor supplies enough specificity without important.
		const rule = new RegExp(
			`\\.markdown-source-view\\.handwriting-page\\s+\\.cm-scroller\\.${HSCROLL_AXIS_CLASS}\\s*\\{([^}]*)\\}`
		);
		const m = css.match(rule);
		expect(m, "axis rule present").not.toBeNull();
		expect(m![1]).toMatch(/overflow-x:\s*auto/);
		expect(m![1]).not.toContain("!important");
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
