import { describe, expect, it } from "vitest";
import {
	DEFAULT_TOOLBAR_CORNER,
	TOOLBAR_CORNERS,
	TOOLBAR_CORNER_LABELS,
	allToolbarCornerClasses,
	normalizeToolbarCorner,
	toolbarCornerClass,
} from "./ToolbarCorner";
import css from "../../styles.css?raw";

describe("ToolbarCorner", () => {
	it("offers all four corners and defaults to the one that shipped", () => {
		expect(TOOLBAR_CORNERS).toHaveLength(4);
		expect(DEFAULT_TOOLBAR_CORNER).toBe("top-right");
	});

	it("turns anything off disk into a real corner", () => {
		// Settings files get hand-edited, synced across versions and
		// truncated. An unknown value must not leave the strip unpositioned.
		expect(normalizeToolbarCorner("bottom-left")).toBe("bottom-left");
		expect(normalizeToolbarCorner("sideways")).toBe(DEFAULT_TOOLBAR_CORNER);
		expect(normalizeToolbarCorner(undefined)).toBe(DEFAULT_TOOLBAR_CORNER);
		expect(normalizeToolbarCorner(null)).toBe(DEFAULT_TOOLBAR_CORNER);
		expect(normalizeToolbarCorner(3)).toBe(DEFAULT_TOOLBAR_CORNER);
		expect(normalizeToolbarCorner({ corner: "top-left" })).toBe(DEFAULT_TOOLBAR_CORNER);
	});

	it("labels every corner exactly once, for the dropdown", () => {
		expect(TOOLBAR_CORNER_LABELS.map((o) => o.value).sort()).toEqual([...TOOLBAR_CORNERS].sort());
	});

	it("gives each corner its own class, and can list them all to clear", () => {
		const classes = allToolbarCornerClasses();
		expect(new Set(classes).size).toBe(4);
		for (const c of TOOLBAR_CORNERS) expect(classes).toContain(toolbarCornerClass(c));
	});

	it("every corner class actually exists in the stylesheet", () => {
		// The one that can rot: a corner nobody styled positions the strip
		// wherever it lands, which reads as a broken toolbar rather than as
		// a missing rule. Same guard the required-CSS packager check uses.
		for (const corner of TOOLBAR_CORNERS) {
			expect(css).toContain(`.${toolbarCornerClass(corner)}`);
		}
	});
});
