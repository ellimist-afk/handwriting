import { afterEach, describe, expect, it } from "vitest";
import { setInkShaping, inkShapingEnabled } from "./InkShape";
import { strokeOutline } from "./StrokeOutline";
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
 */

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

	it("changes the outline geometry of a stroke", () => {
		const s = acceleratingStroke();

		setInkShaping(true);
		const shaped = strokeOutline(s);

		setInkShaping(false);
		const plain = strokeOutline(s);

		// Same stroke, same zoom: if the switch does nothing these are equal.
		expect(JSON.stringify(shaped)).not.toBe(JSON.stringify(plain));
	});

	it("the shaped stroke varies in width where the plain one does not", () => {
		const s = acceleratingStroke();

		// left[i] and right[i] are the two sides at the same sample, so their
		// separation is the local width. How much that RANGES along the stroke
		// is the whole visible effect of shaping.
		const widthRange = (): number => {
			const o = strokeOutline(s);
			if (!o) throw new Error("no outline");
			const w = o.left.map((a, i) => {
				const b = o.right[i]!;
				return Math.hypot(a.x - b.x, a.y - b.y);
			});
			return Math.max(...w) - Math.min(...w);
		};

		setInkShaping(false);
		const plain = widthRange();
		setInkShaping(true);
		const shaped = widthRange();

		expect(shaped).toBeGreaterThan(plain);
	});
});
