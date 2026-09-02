import { afterEach, describe, expect, it } from "vitest";
import { setInkShaping, inkShapingEnabled, flattenStrokeShaped } from "./InkShape";
import { flattenStroke, RibbonPt } from "./Ribbon";
import { PenStyle } from "./PenStyle";
import { InkStroke } from "./Stroke";

/**
 * The Ink smoothing switch has to actually change the ink.
 *
 * It was shipped after two users asked for it, and the first person to try it
 * could not see a difference (alan's mother, ipad, 2026-08-30). That is the
 * same shape as every instrument bug tonight: a control that does nothing and
 * a control whose effect is subtle look identical from outside. So this
 * asserts the GEOMETRY differs, which settles it either way - if the numbers
 * come out equal the switch is inert, and if they differ the effect is real
 * and merely gentle on slow, even handwriting.
 *
 * Measured through the on-screen ribbon (StrokeRenderer.drawStroke's own
 * selection, reproduced below), not through StrokeOutline: exports stopped
 * reading this toggle entirely (§5n, Alan, 2026-09-02 - exports are always
 * shaped), so export geometry no longer varies with it and cannot be used to
 * prove the switch does anything. The screen is the only surface left where
 * it does.
 */

function screenRibbon(stroke: InkStroke): RibbonPt[] {
	const flat = stroke.tool === "highlighter";
	const style: PenStyle = {
		color: stroke.color,
		baseWidth: stroke.width,
		minWidthFactor: flat ? 0.9 : 0.35,
		gamma: flat ? 1 : 0.75,
	};
	return !flat && stroke.device !== "mouse" && inkShapingEnabled()
		? flattenStrokeShaped(stroke.points, style, 1)
		: flattenStroke(stroke.points, style, 1);
}

function stroke(pts: Array<[number, number, number]>): InkStroke {
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return {
		id: "s1",
		tool: "pen",
		color: "#000000",
		width: 3,
		points: pts.map(([x, y, t]) => ({ x, y, pressure: 0.5, t })),
		bbox: {
			x: Math.min(...xs),
			y: Math.min(...ys),
			width: Math.max(...xs) - Math.min(...xs),
			height: Math.max(...ys) - Math.min(...ys),
		},
		createdAt: 0,
	} as InkStroke;
}

/**
 * A stroke that speeds up: even time steps, growing distance. Velocity
 * thinning has something to bite on, which a constant-speed stroke denies it.
 */
function acceleratingStroke(): InkStroke {
	const pts: Array<[number, number, number]> = [];
	let x = 0;
	for (let i = 0; i < 24; i++) {
		x += 1 + i * 0.9;
		pts.push([x, 40, i * 8]);
	}
	return stroke(pts);
}

afterEach(() => setInkShaping(true));

describe("the ink smoothing switch", () => {
	it("flips the flag it is asked to flip", () => {
		setInkShaping(false);
		expect(inkShapingEnabled()).toBe(false);
		setInkShaping(true);
		expect(inkShapingEnabled()).toBe(true);
	});

	it("changes the on-screen ribbon geometry of a stroke", () => {
		const s = acceleratingStroke();

		setInkShaping(true);
		const shaped = screenRibbon(s);

		setInkShaping(false);
		const plain = screenRibbon(s);

		// Same stroke, same zoom: if the switch does nothing these are equal.
		expect(JSON.stringify(shaped)).not.toBe(JSON.stringify(plain));
	});

	it("the shaped stroke varies in width where the plain one does not", () => {
		const s = acceleratingStroke();

		// hw is the half-width at each sample. How much that RANGES along the
		// stroke is the whole visible effect of shaping.
		const widthRange = (): number => {
			const ribbon = screenRibbon(s);
			const w = ribbon.map((p) => p.hw);
			return Math.max(...w) - Math.min(...w);
		};

		setInkShaping(false);
		const plain = widthRange();
		setInkShaping(true);
		const shaped = widthRange();

		expect(shaped).toBeGreaterThan(plain);
	});
});
