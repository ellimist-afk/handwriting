/**
 * `mergePages` directly, and above all its FORWARD-COMPATIBILITY half.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `PageStoreTwoDocuments.test.ts`. That
 * file drives the whole store and proves the two-pane loss is closed; it reaches
 * `mergePages` only through `reconcileInProcess`, where BOTH pages were parsed
 * from the same bytes. So `disk.unknownTop` and `mine.unknownTop` are EQUAL on
 * every path production can produce today, and equal maps make a mistake in the
 * merge invisible: swap the two spreads, drop one side entirely, and every
 * existing test still passes. The branches that carry a NEWER build's fields are
 * therefore exercised by nothing, and getting them wrong silently deletes data
 * this version cannot even see. Hence: the asymmetric cases, built by hand,
 * with the asymmetry asserted before the merge result is.
 *
 * WHAT IS PINNED HERE IS WHAT THE CODE DOES, not what it ought to do. Two of
 * the behaviours below are recorded because they are load-bearing and
 * surprising, not because they are endorsed:
 *
 *   1. THE EARLY RETURN SKIPS THE UNKNOWN MERGE ENTIRELY. When `disk` holds no
 *      stroke, box or image that `mine` lacks, `mergePages` returns `mine`
 *      itself by identity - so a top-level unknown key that only `disk` carries
 *      is NOT folded in. Unknown-field preservation happens only as a passenger
 *      on object recovery. Consistent with the function's stated safety
 *      property (the result is always a superset of `mine`, and `mine` is what
 *      the unfixed code wrote, so nothing is lost RELATIVE TO THE OLD
 *      BEHAVIOUR) - but it is not what the "an unequal pair still loses
 *      nothing" comment on the `unknownTop` line reads as in isolation.
 *
 *   2. `unknownByObject` MERGES ONE LEVEL DEEP, NOT TWO. `{ ...disk, ...mine }`
 *      is keyed by object id, so for an id BOTH sides carry, `mine`'s whole
 *      record replaces `disk`'s and any field inside `disk`'s copy is dropped.
 *      Only an id `mine` does not carry at all survives intact.
 *
 * Both are asserted below in their true form. Changing either is a behaviour
 * change and is not this file's business; the tests exist so that changing one
 * by accident is loud.
 */

import { describe, expect, it } from "vitest";

import { mergePages } from "./PageMerge";
import { PageData, emptyPage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import type { ImageData, TextBoxData } from "../model/PageData";

const PAGE_ID = "p1";

function stroke(id: string, color = "#4b7bec"): InkStroke {
	return {
		id,
		tool: "pen",
		color,
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	};
}

function box(id: string, z = 0): TextBoxData {
	return { id, x: 0, y: 0, width: 100, z };
}

function image(id: string, z = 0): ImageData {
	return { id, x: 0, y: 0, width: 40, height: 30, z };
}

function page(fill: (p: PageData) => void = () => {}): PageData {
	const p = emptyPage(PAGE_ID);
	fill(p);
	return p;
}

const ids = (xs: readonly { id: string }[]): string[] => xs.map((x) => x.id);

describe("mergePages - the ordinary union", () => {
	it("keeps both writers' strokes, mine first then the disk-only ones, with no duplicate", () => {
		const mine = page((p) => {
			p.strokes.push(stroke("mine-1"), stroke("shared"), stroke("mine-2"));
		});
		const disk = page((p) => {
			// `shared` is deliberately first and deliberately a DIFFERENT object,
			// so both "appears once" and "mine's copy is the survivor" are real
			// questions rather than artefacts of using the same reference.
			p.strokes.push(stroke("shared", "#ff0000"), stroke("disk-1"), stroke("disk-2"));
		});

		const out = mergePages(disk, mine);

		expect(ids(out.strokes)).toEqual(["mine-1", "shared", "mine-2", "disk-1", "disk-2"]);
		expect(ids(out.strokes).filter((id) => id === "shared")).toHaveLength(1);
		// Mine wins the shared id: the surviving object is mine's, by identity.
		expect(out.strokes[1]).toBe(mine.strokes[1]);
		expect(out.strokes[1]?.color).toBe("#4b7bec");
	});

	it("unions text boxes and images by id on the same rule", () => {
		const mine = page((p) => {
			p.textBoxes.push(box("tb-mine"), box("tb-shared", 1));
			p.images.push(image("im-shared", 2));
		});
		const disk = page((p) => {
			p.textBoxes.push(box("tb-shared", 99), box("tb-disk"));
			p.images.push(image("im-shared", 99), image("im-disk"));
		});

		const out = mergePages(disk, mine);

		expect(ids(out.textBoxes)).toEqual(["tb-mine", "tb-shared", "tb-disk"]);
		expect(ids(out.images)).toEqual(["im-shared", "im-disk"]);
		// The shared entries are mine's, not disk's - z proves which copy landed.
		expect(out.textBoxes[1]?.z).toBe(1);
		expect(out.images[0]?.z).toBe(2);
	});

	it("is deterministic: the same two pages merge to the same order every time", () => {
		const build = () => ({
			mine: page((p) => p.strokes.push(stroke("m1"), stroke("m2"))),
			disk: page((p) => p.strokes.push(stroke("d1"), stroke("m1"), stroke("d2"))),
		});
		const first = build();
		const second = build();

		expect(ids(mergePages(first.disk, first.mine).strokes)).toEqual(
			ids(mergePages(second.disk, second.mine).strokes)
		);
		expect(ids(mergePages(first.disk, first.mine).strokes)).toEqual(["m1", "m2", "d1", "d2"]);
	});

	it("carries mine's scalar fields through, never disk's", () => {
		const mine = page((p) => {
			p.surface = "pdf";
			p.coordSpace = "page-css@1";
			p.pdfPaths = ["mine.pdf"];
			p.strokes.push(stroke("m1"));
		});
		const disk = page((p) => {
			p.surface = "inline";
			p.coordSpace = "something-else";
			p.pdfPaths = ["disk.pdf"];
			p.strokes.push(stroke("d1"));
		});

		const out = mergePages(disk, mine);

		expect(out.surface).toBe("pdf");
		expect(out.coordSpace).toBe("page-css@1");
		expect(out.pdfPaths).toEqual(["mine.pdf"]);
	});
});

describe("mergePages - unknownTop, the forward-compatibility path", () => {
	/**
	 * Every test in this block puts one stroke on disk that `mine` lacks. That
	 * is not decoration: without it the early return fires and the unknown maps
	 * are never consulted at all (see "the early return" block below).
	 */
	it("keeps a top-level key only DISK carries", () => {
		const mine = page((p) => {
			p.strokes.push(stroke("m1"));
			p.unknownTop.mineOnly = { kept: true };
		});
		const disk = page((p) => {
			p.strokes.push(stroke("d1"));
			p.unknownTop.diskOnly = { from: "a newer build", n: 7 };
		});

		// PRECONDITION. If these two maps were equal the assertions below would
		// hold for the wrong reason and this test would prove nothing.
		expect(disk.unknownTop).not.toEqual(mine.unknownTop);
		expect(Object.keys(disk.unknownTop)).toEqual(["diskOnly"]);
		expect(Object.keys(mine.unknownTop)).toEqual(["mineOnly"]);

		const out = mergePages(disk, mine);

		expect(out.unknownTop.diskOnly).toEqual({ from: "a newer build", n: 7 });
		expect(out.unknownTop.mineOnly).toEqual({ kept: true });
	});

	it("keeps a top-level key only MINE carries when disk carries none at all", () => {
		const mine = page((p) => {
			p.strokes.push(stroke("m1"));
			p.unknownTop.mineOnly = "v";
		});
		const disk = page((p) => p.strokes.push(stroke("d1")));

		expect(Object.keys(disk.unknownTop)).toHaveLength(0);
		expect(Object.keys(mine.unknownTop)).toEqual(["mineOnly"]);

		const out = mergePages(disk, mine);

		expect(out.unknownTop).toEqual({ mineOnly: "v" });
	});

	it("MINE WINS a top-level key both writers carry - the precedence rule, pinned", () => {
		const mine = page((p) => {
			p.strokes.push(stroke("m1"));
			p.unknownTop.shared = "mine";
		});
		const disk = page((p) => {
			p.strokes.push(stroke("d1"));
			p.unknownTop.shared = "disk";
		});

		expect(disk.unknownTop.shared).not.toBe(mine.unknownTop.shared);

		const out = mergePages(disk, mine);

		// `{ ...disk.unknownTop, ...mine.unknownTop }` - mine is spread last.
		expect(out.unknownTop.shared).toBe("mine");
	});

	it("does not mutate either input's unknownTop", () => {
		const mine = page((p) => {
			p.strokes.push(stroke("m1"));
			p.unknownTop.mineOnly = 1;
		});
		const disk = page((p) => {
			p.strokes.push(stroke("d1"));
			p.unknownTop.diskOnly = 2;
		});

		mergePages(disk, mine);

		expect(Object.keys(mine.unknownTop)).toEqual(["mineOnly"]);
		expect(Object.keys(disk.unknownTop)).toEqual(["diskOnly"]);
	});

	it("copies a literal \"__proto__\" key as DATA and does not pollute the result", () => {
		// `emptyPage` builds these null-prototype on purpose (K1): an id or key
		// the sidecar controls can literally be "__proto__". Object spread uses
		// CreateDataProperty, so it must land as an own key rather than as an
		// assignment to the prototype.
		const mine = page((p) => p.strokes.push(stroke("m1")));
		const disk = page((p) => {
			p.strokes.push(stroke("d1"));
			p.unknownTop["__proto__"] = { polluted: true };
		});

		const out = mergePages(disk, mine);

		expect(Object.keys(out.unknownTop)).toContain("__proto__");
		expect(Object.getOwnPropertyDescriptor(out.unknownTop, "__proto__")?.value).toEqual({
			polluted: true,
		});
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

describe("mergePages - unknownByObject, the forward-compatibility path", () => {
	it("keeps the per-object entry of a RECOVERED object, keyed by its id", () => {
		const mine = page((p) => {
			p.strokes.push(stroke("m1"));
			p.unknownByObject["m1"] = { mineField: 1 };
		});
		const disk = page((p) => {
			p.strokes.push(stroke("d1"));
			p.unknownByObject["d1"] = { futureField: "must survive" };
		});

		// PRECONDITION: the two maps genuinely differ, and neither is empty.
		expect(disk.unknownByObject).not.toEqual(mine.unknownByObject);
		expect(Object.keys(disk.unknownByObject)).toEqual(["d1"]);
		expect(Object.keys(mine.unknownByObject)).toEqual(["m1"]);

		const out = mergePages(disk, mine);

		// The object came across, so its unknown fields must come with it.
		expect(ids(out.strokes)).toContain("d1");
		expect(out.unknownByObject["d1"]).toEqual({ futureField: "must survive" });
		expect(out.unknownByObject["m1"]).toEqual({ mineField: 1 });
	});

	it("keeps a disk-only entry whose id belongs to a recovered TEXT BOX", () => {
		const mine = page((p) => p.textBoxes.push(box("tb-mine")));
		const disk = page((p) => {
			p.textBoxes.push(box("tb-disk"));
			p.unknownByObject["tb-disk"] = { newerAttr: [1, 2, 3] };
		});

		expect(Object.keys(mine.unknownByObject)).toHaveLength(0);
		expect(Object.keys(disk.unknownByObject)).toEqual(["tb-disk"]);

		const out = mergePages(disk, mine);

		expect(ids(out.textBoxes)).toEqual(["tb-mine", "tb-disk"]);
		expect(out.unknownByObject["tb-disk"]).toEqual({ newerAttr: [1, 2, 3] });
	});

	it("MINE'S WHOLE RECORD REPLACES DISK'S for a shared id - a one-level merge, pinned as-is", () => {
		// This is the sharp edge. `{ ...disk.unknownByObject, ...mine.unknownByObject }`
		// is keyed by object id, so for an id both sides carry, the inner records
		// are NOT merged: disk's fields for that object are dropped whole. Today
		// both documents parse from the same bytes so this pair is always equal
		// and the case never arises; it is asserted so that it stays a decision
		// rather than becoming a surprise.
		const mine = page((p) => {
			p.strokes.push(stroke("shared"), stroke("m1"));
			p.unknownByObject["shared"] = { mineField: "kept" };
		});
		const disk = page((p) => {
			p.strokes.push(stroke("shared"), stroke("d1"));
			p.unknownByObject["shared"] = { diskField: "dropped" };
		});

		expect(disk.unknownByObject["shared"]).not.toEqual(mine.unknownByObject["shared"]);

		const out = mergePages(disk, mine);

		expect(out.unknownByObject["shared"]).toEqual({ mineField: "kept" });
		expect(out.unknownByObject["shared"]).not.toHaveProperty("diskField");
	});

	it("does not mutate either input's unknownByObject", () => {
		const mine = page((p) => {
			p.strokes.push(stroke("m1"));
			p.unknownByObject["m1"] = { a: 1 };
		});
		const disk = page((p) => {
			p.strokes.push(stroke("d1"));
			p.unknownByObject["d1"] = { b: 2 };
		});

		mergePages(disk, mine);

		expect(Object.keys(mine.unknownByObject)).toEqual(["m1"]);
		expect(Object.keys(disk.unknownByObject)).toEqual(["d1"]);
	});
});

describe("mergePages - the early return, and what it costs", () => {
	it("hands back MINE BY IDENTITY when disk holds no object mine lacks", () => {
		const mine = page((p) => p.strokes.push(stroke("m1"), stroke("m2")));
		const disk = page((p) => p.strokes.push(stroke("m1")));

		const out = mergePages(disk, mine);

		// `pending` holds live references; identity is deliberately preserved.
		expect(out).toBe(mine);
	});

	it("SKIPS the unknown merge on that path: a disk-only top-level key is NOT folded in", () => {
		// The behaviour this file exists to make loud. Unknown-field preservation
		// rides along with object recovery; with nothing to recover, it does not
		// happen. Not a loss relative to the unfixed code, which wrote `mine`
		// verbatim - but it is not what the comment on the `unknownTop` line
		// reads as on its own. Pinned as current behaviour, not endorsed.
		const mine = page((p) => {
			p.strokes.push(stroke("m1"));
			p.unknownTop.mineOnly = 1;
		});
		const disk = page((p) => {
			p.strokes.push(stroke("m1"));
			p.unknownTop.diskOnly = "from a newer build";
			p.unknownByObject["m1"] = { alsoDropped: true };
		});

		// PRECONDITION: the maps differ, and disk has nothing to recover.
		expect(disk.unknownTop).not.toEqual(mine.unknownTop);
		expect(ids(disk.strokes).every((id) => ids(mine.strokes).includes(id))).toBe(true);

		const out = mergePages(disk, mine);

		expect(out).toBe(mine);
		expect(out.unknownTop).not.toHaveProperty("diskOnly");
		expect(out.unknownByObject).not.toHaveProperty("m1");
	});

	it("returns mine untouched when disk is empty", () => {
		const mine = page((p) => p.strokes.push(stroke("m1")));
		const disk = page();

		expect(mergePages(disk, mine)).toBe(mine);
	});

	it("recovers everything when MINE is empty", () => {
		const mine = page();
		const disk = page((p) => {
			p.strokes.push(stroke("d1"));
			p.textBoxes.push(box("tb-disk"));
			p.images.push(image("im-disk"));
			p.unknownTop.diskOnly = 1;
			p.unknownByObject["d1"] = { futureField: true };
		});

		const out = mergePages(disk, mine);

		expect(out).not.toBe(mine);
		expect(ids(out.strokes)).toEqual(["d1"]);
		expect(ids(out.textBoxes)).toEqual(["tb-disk"]);
		expect(ids(out.images)).toEqual(["im-disk"]);
		expect(out.unknownTop.diskOnly).toBe(1);
		expect(out.unknownByObject["d1"]).toEqual({ futureField: true });
	});

	it("never returns fewer objects than mine brought - the stated safety property", () => {
		const mine = page((p) => {
			p.strokes.push(stroke("m1"), stroke("m2"));
			p.textBoxes.push(box("tb1"));
			p.images.push(image("im1"));
		});
		const disk = page((p) => p.strokes.push(stroke("d1")));

		const out = mergePages(disk, mine);

		for (const id of ids(mine.strokes)) expect(ids(out.strokes)).toContain(id);
		for (const id of ids(mine.textBoxes)) expect(ids(out.textBoxes)).toContain(id);
		for (const id of ids(mine.images)) expect(ids(out.images)).toContain(id);
	});
});
