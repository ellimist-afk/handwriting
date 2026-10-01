import { expect, it } from "vitest";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { DEFAULT_PEN } from "../ink/PenStyle";

it("C1-001 includes the leading interior of a smoothed inline stroke while contact is live", () => {
	const geometryX: number[] = [];
	const ctx = new Proxy({}, {
		get(_target, name) {
			if (name === "getContextAttributes") return () => ({ desynchronized: false });
			if (name === "moveTo" || name === "lineTo" || name === "arc") {
				return (x: number) => { geometryX.push(x); };
			}
			return () => undefined;
		},
		set: () => true,
	});
	const canvas = { getContext: () => ctx } as unknown as HTMLCanvasElement;
	const wet = new WetInkRenderer(canvas, false);
	wet.smooth = true;
	wet.shape = false;
	const cam = { x: 0, y: 0, zoom: 1 };
	const style = { ...DEFAULT_PEN, baseWidth: 2.2 };
	wet.beginStroke({ x: 100, y: 20, pressure: 0.5, t: 0 }, style);
	wet.appendPoint(cam, style, { x: 140, y: 20, pressure: 0.5, t: 8 });
	wet.appendPoint(cam, style, { x: 160, y: 20, pressure: 0.5, t: 16 });

	// The accepted start is 100 and the committed line covers x=110.
	// A tiny half-width cannot hide a 20px leading gap in the settled wet strip.
	expect(geometryX.length).toBeGreaterThan(0);
	expect(Math.min(...geometryX)).toBeLessThanOrEqual(110);
});
