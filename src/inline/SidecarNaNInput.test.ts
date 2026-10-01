/**
 * Can the public pen input path put a non-finite coordinate into a
 * stroke? The sidecar writer has no finite or MAX_COORD guard, so such a point
 * would be written as null and the file would read back as damaged (path B).
 * The writer guard is parked behind this cell: red means the guard is
 * in scope, green means it stays parked and this cell stays as the tripwire.
 *
 * The input path is InlinePenRouter.sampleFrom, the one place a pointer event
 * becomes a note-space sample. It reads `rect`, `scaleProvider` and `originPan`.
 * `rect` is a DOMRect, which the browser keeps finite; the scale and the pan are
 * live fields on the surface and are the hostile inputs here.
 */
import { describe, expect, it } from "vitest";
import { InlinePenRouter } from "./InlinePenRouter";

type Sample = { x: number; y: number; pressure: number };
type Rig = {
	rect: { left: number; top: number };
	scaleProvider: () => number;
	originPan?: () => { x: number; y: number } | null;
};

const sampleFrom = (
	InlinePenRouter.prototype as unknown as { sampleFrom(this: unknown, e: unknown): Sample }
).sampleFrom;

function sample(scale: number, pan: { x: number; y: number } | null, clientX = 120, clientY = 80): Sample {
	const rig = Object.create(InlinePenRouter.prototype) as Rig;
	rig.rect = { left: 20, top: 10 };
	rig.scaleProvider = () => scale;
	rig.originPan = () => pan;
	return sampleFrom.call(rig, {
		clientX,
		clientY,
		pressure: 0.5,
		pointerType: "pen",
		timeStamp: 0,
		tiltX: 0,
		tiltY: 0,
	});
}

describe("the pen input path cannot make a non-finite point", () => {
	const scales = [0, -1, NaN, Infinity, -Infinity, 1e-320, 1];
	const pans = [null, { x: NaN, y: NaN }, { x: Infinity, y: -Infinity }, { x: 5, y: 5 }];
	for (const scale of scales) {
		for (const pan of pans) {
			it(`scale ${scale}, pan ${pan ? `${pan.x},${pan.y}` : "none"}: x and y are finite`, () => {
				const s = sample(scale, pan);
				expect(Number.isFinite(s.x)).toBe(true);
				expect(Number.isFinite(s.y)).toBe(true);
				expect(Number.isFinite(s.pressure)).toBe(true);
			});
		}
	}
});
