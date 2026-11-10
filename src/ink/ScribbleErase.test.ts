import { describe, expect, it } from "vitest";
import { isScribbleShape, scribbleEraseTargets } from "./ScribbleErase";
import { computeBBox, type InkPoint, type InkStroke } from "./Stroke";
import {
	boxFill,
	circled,
	densePage,
	ordinaryStrokes,
	outlinedBox,
	scribble,
	steppedScribble,
	strokeFrom,
	threeStrokeWord,
	word,
	wordNeighbours,
} from "./ScribbleErase.fixture";
import { RUN_A_HATCH, type HatchStroke } from "./ScribbleErase.hatch.fixture";

describe("scribble to erase: the detector", () => {
	it("a dense back-and-forth scribble over a three-stroke word takes exactly those three strokes", () => {
		const target = threeStrokeWord();
		const page = [...wordNeighbours().slice(0, 1), ...target, ...wordNeighbours().slice(1)];
		const s = scribble("scribble", 96, 204, 101, 117);
		expect(isScribbleShape(s), "the scribble reads as a scribble").toBe(true);
		expect(scribbleEraseTargets(s, page)).toEqual(["w1", "w2", "w3"]);
	});

	it("a scribble over one word on a dense page takes that word only", () => {
		const page = densePage();
		// Row 2, word 3 sits at x 160 to 190, y 160 to 178.
		const s = scribble("scribble", 157, 193, 161, 177, 10);
		expect(scribbleEraseTargets(s, page)).toEqual(["page-2-3"]);
	});

	it("highlighter ink under the scribble is taken with the pen ink", () => {
		const target = threeStrokeWord();
		target[1] = { ...target[1]!, tool: "highlighter" };
		const s = scribble("scribble", 96, 204, 101, 117);
		expect(scribbleEraseTargets(s, target)).toEqual(["w1", "w2", "w3"]);
	});

	it("a fast scribble takes a thin stroke it crosses midway between two samples 9 apart", () => {
		// Samples sit at x = 96 + 9k on every leg; the thin stroke stands at 96 + 49.5, midway between two of them.
		const s = scribble("scribble", 96, 204, 101, 117, 8, 9);
		const line = Array.from({ length: 8 }, (_, k) => ({ x: 145.5, y: 103 + 2 * k }));
		const thin = { ...strokeFrom("thin", line), width: 0.5 };
		expect(isScribbleShape(s)).toBe(true);
		expect(scribbleEraseTargets(s, [thin])).toEqual(["thin"]);
	});

	it("a word 12 below the scribble's path stays", () => {
		const s = scribble("scribble", 96, 204, 101, 117);
		const below = word("below", 100, 117 + 12, 100, 18, 5);
		expect(scribbleEraseTargets(s, [...threeStrokeWord(), below])).toEqual(["w1", "w2", "w3"]);
	});

	it("a fast scribble, samples 24 apart, leaves a dash 8 below its path", () => {
		const s = scribble("scribble", 96, 216, 101, 117, 8, 24);
		const dash = strokeFrom("dash", [{ x: 150, y: 126 }, { x: 152, y: 126 }, { x: 154, y: 126 }]);
		expect(isScribbleShape(s)).toBe(true);
		expect(scribbleEraseTargets(s, [...threeStrokeWord(), dash])).toEqual(["w1", "w2", "w3"]);
	});

	it("a flat scribble takes a dash 4.5 below its legs, reached only by segments outside the dash's box", () => {
		// Defect: the inside count asks only the scribble segments whose box meets the stroke's own box, so a stroke the band
		// reaches from beside it (within half-width plus 4) is left.
		const s = scribble("scribble", 96, 204, 109, 112, 8, 3);
		const dash = strokeFrom("dash", Array.from({ length: 6 }, (_, k) => ({ x: 140 + 4 * k, y: 116.5 })));
		expect(isScribbleShape(s)).toBe(true);
		expect(Math.max(...s.points.map((p) => p.y)), "premise: every leg lies above the dash's box").toBeLessThan(dash.bbox.y);
		expect(scribbleEraseTargets(s, [dash])).toEqual(["dash"]);
	});

	it("a phrase circled three times on a dense page erases nothing", () => {
		// Row 2 is y 160 to 178; the ellipse rings its words 2 to 4 and crosses rows 1 and 3.
		expect(scribbleEraseTargets(circled("circled", 175, 169, 60, 18, 3), densePage())).toBeNull();
	});

	it("a word underlined three times back and forth, touching its bottom, stays", () => {
		const s = scribble("underline", 100, 200, 119.5, 122, 6);
		expect(scribbleEraseTargets(s, threeStrokeWord())).toBeNull();
	});

	it("a scribble over empty page is plain ink", () => {
		const s = scribble("scribble", 96, 204, 101, 117);
		expect(isScribbleShape(s)).toBe(true);
		expect(scribbleEraseTargets(s, [])).toBeNull();
		expect(scribbleEraseTargets(s, [word("far", 100, 400)])).toBeNull();
	});

	const ordinary = ordinaryStrokes();
	it("the control set is twenty strokes", () => {
		expect(ordinary).toHaveLength(20);
	});

	it.each(ordinary.map((s) => [s.id, s] as const))("ordinary stroke over a dense page erases nothing: %s", (_name, s) => {
		expect(scribbleEraseTargets(s, [...densePage(), ...threeStrokeWord()])).toBeNull();
	});
});

describe("scribble to erase: ink drawn round the scribble stays", () => {
	// The box is 60 by 30 at (300, 300), drawn in one stroke; the fill runs 15 legs, 2 apart, down from its top edge.
	const box = () => outlinedBox("box", 300, 300, 60, 30);

	it("a box drawn in one stroke and filled in edge to edge stays; the fill takes nothing", () => {
		expect(scribbleEraseTargets(boxFill("fill", 300, 360, 300, 15, 2), [box()])).toBeNull();
	});

	it("a box filled in 1 past its outline on every side stays", () => {
		expect(scribbleEraseTargets(boxFill("fill", 299, 361, 299, 15, 32 / 15), [box()])).toBeNull();
	});

	it("a box filled in 5 past its right edge stays", () => {
		expect(scribbleEraseTargets(boxFill("fill", 300, 365, 300, 15, 2), [box()])).toBeNull();
	});

	it("a scribble that runs 5.5 past the box's right edge takes the box, as a scribble across its edge does", () => {
		expect(scribbleEraseTargets(boxFill("fill", 300, 365.5, 300, 15, 2), [box()])).toEqual(["box"]);
	});

	it("a phrase circled once and scribbled out inside the circle loses its words; the circle stays", () => {
		const page = [...threeStrokeWord(), circled("circle", 150, 109, 60, 16, 1)];
		expect(scribbleEraseTargets(scribble("scribble", 96, 204, 101, 117), page)).toEqual(["w1", "w2", "w3"]);
	});

	it("a phrase circled twice and scribbled out inside the circle loses its words; the circle stays", () => {
		const page = [...threeStrokeWord(), circled("circle", 150, 109, 58, 14, 2)];
		expect(scribbleEraseTargets(scribble("scribble", 96, 204, 101, 117), page)).toEqual(["w1", "w2", "w3"]);
	});

	it.each([1, 2])("a scribble %s inside the word's edges on every side still takes the word", (k) => {
		// Row 2, word 3 sits at x 160 to 190, y 160 to 178.
		expect(scribbleEraseTargets(scribble("scribble", 157 + k, 193 - k, 161 + k, 177 - k, 10), densePage())).toEqual(["page-2-3"]);
	});

	it.each([24, 30])("a 16 tall scribble over the middle of a word %s tall takes the word", (h) => {
		const tall = word("tall", 100, 100, 30, h, 2);
		expect(scribbleEraseTargets(scribble("scribble", 98, 132, 100 + h / 2 - 8, 100 + h / 2 + 8, 10), [tall])).toEqual(["tall"]);
	});

	it("a pen scribble 6 past each end of a 12 wide highlight takes the highlight", () => {
		const points = Array.from({ length: 30 }, (_, k) => ({ x: 100 + (100 * k) / 29, y: 110 }));
		const hl = { ...strokeFrom("hl", points), tool: "highlighter" as const, width: 12 };
		expect(scribbleEraseTargets(scribble("scribble", 94, 206, 103, 117), [{ ...hl, bbox: computeBBox(hl.points, 12) }])).toEqual(["hl"]);
	});

	it("a dash 4 below the scribble's last leg is taken", () => {
		const legY = (x: number): number => 115 + (2 * (204 - x)) / 108;
		const dash = strokeFrom("dash", [100, 102, 104].map((x) => ({ x, y: legY(x) + 4 })));
		expect(scribbleEraseTargets(steppedScribble("scribble", 96, 204, 101, 117, 8, 3), [dash])).toEqual(["dash"]);
	});

	it("a dash just below the scribble, at y 122.5, is taken", () => {
		const dash = strokeFrom("dash", [100, 102, 104].map((x) => ({ x, y: 122.5 })));
		expect(scribbleEraseTargets(steppedScribble("scribble", 96, 204, 101, 117, 8, 3), [dash])).toEqual(["dash"]);
	});

	it("a word and its underline, scribbled over together with the bottom legs on the underline, are both taken", () => {
		const ul = strokeFrom("ul", Array.from({ length: 21 }, (_, k) => ({ x: 100 + 5 * k, y: 121 })));
		expect(scribbleEraseTargets(scribble("scribble", 96, 204, 101, 122, 10), [word("w", 100, 100, 100, 18, 5), ul])).toEqual(["w", "ul"]);
	});
});

describe("scribble to erase: long hatch lines are plain ink", () => {
	// Hatching keeps paper between its lines; a scribble covers it. The sideways step per leg is the stroke's sideways
	// spread shared out between its legs.
	function fromXY(s: HatchStroke): InkStroke {
		const points: InkPoint[] = [];
		for (let k = 0; k < s.xy.length; k += 2) points.push({ x: s.xy[k]!, y: s.xy[k + 1]!, pressure: 0.5, t: (k / 2) * 8 });
		return { id: s.id, tool: "pen", color: "#222222", width: s.width, points, bbox: computeBBox(points, s.width), createdAt: 1 };
	}

	it.each(RUN_A_HATCH.map((c) => [c.label, c.hatch.name, c] as const))(
		"a drawing's long hatch lines (%s, %s) take nothing under them",
		(_label, _name, c) => {
			const hatch = fromXY(c.hatch);
			const under = c.under.map(fromXY);
			expect(scribbleEraseTargets(hatch, under)).toBeNull();
			expect(isScribbleShape(hatch), "the hatch reads as plain ink").toBe(false);
		}
	);

	it("hatch lines 2.6 pen widths apart over a word take nothing", () => {
		// 8 legs over x 96 to 204, each 2.6 * 2.2 = 5.72 below the last.
		const s = steppedScribble("hatch", 96, 204, 98, 98 + 8 * 5.72, 8, 3);
		expect(scribbleEraseTargets(s, threeStrokeWord())).toBeNull();
	});

	it("a fine pen scribble, legs 1.8 pen widths apart, still takes the word under it", () => {
		// Fine pen 1.32 wide: 8 legs, each 1.8 * 1.32 = 2.376 below the last, over the word at y 100 to 118.
		const raw = steppedScribble("scribble", 96, 204, 100, 100 + 8 * 2.376, 8, 3);
		const s = { ...raw, width: 1.32, bbox: computeBBox(raw.points, 1.32) };
		expect(isScribbleShape(s), "the fine scribble reads as a scribble").toBe(true);
		expect(scribbleEraseTargets(s, threeStrokeWord())).toEqual(["w1", "w2", "w3"]);
	});
});

describe("scribble to erase: the step bar sits at two pen widths", () => {
	// A scribble whose legs step more than two pen widths sideways lands as plain ink, even over writing; one undo
	// clears it. Every scribble here runs x 96 to 204 with no jitter, so its sideways step is its height over its legs.
	const FINE = 1.32;
	function withWidth(s: InkStroke, width: number): InkStroke {
		return { ...s, width, bbox: computeBBox(s.points, width) };
	}

	it("a fine pen scribble of 6 wide legs over one long word, 2.53 pen widths apart, stays as ink", () => {
		// 6 legs from y 99 to 119: a step of 20 / 6 = 3.33, against a bar of 2 * 1.32 = 2.64.
		const s = withWidth(steppedScribble("scribble", 96, 204, 99, 119, 6, 3), FINE);
		expect(isScribbleShape(s), "the wide fine scribble reads as plain ink").toBe(false);
		expect(scribbleEraseTargets(s, [word("long", 100, 100, 100, 18, 5)])).toBeNull();
	});

	it("a medium pen scribble of 8 legs over two lines, 5 apart, stays as ink", () => {
		// 8 legs from y 99 to 139: a step of 5 = 2.27 pen widths, against a bar of 2 * 2.2 = 4.4.
		const s = steppedScribble("scribble", 96, 204, 99, 139, 8, 3);
		expect(isScribbleShape(s), "the two-line scribble reads as plain ink").toBe(false);
		expect(scribbleEraseTargets(s, [word("line1", 100, 100, 100, 18, 5), word("line2", 100, 120, 100, 18, 4)])).toBeNull();
	});

	it("a fine pen scribble, legs 1.9 pen widths apart, takes the word under it", () => {
		// 8 legs, each 1.9 * 1.32 = 2.508 below the last.
		const s = withWidth(steppedScribble("scribble", 96, 204, 100, 100 + 8 * 2.508, 8, 3), FINE);
		expect(isScribbleShape(s), "the 1.9 width scribble reads as a scribble").toBe(true);
		expect(scribbleEraseTargets(s, threeStrokeWord())).toEqual(["w1", "w2", "w3"]);
	});

	it("a fine pen scribble, legs 2.1 pen widths apart, stays as ink", () => {
		// 8 legs, each 2.1 * 1.32 = 2.772 below the last.
		const s = withWidth(steppedScribble("scribble", 96, 204, 100, 100 + 8 * 2.772, 8, 3), FINE);
		expect(isScribbleShape(s), "the 2.1 width scribble reads as plain ink").toBe(false);
		expect(scribbleEraseTargets(s, threeStrokeWord())).toBeNull();
	});
});
