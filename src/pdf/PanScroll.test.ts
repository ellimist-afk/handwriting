/**
 * The pan drag's arithmetic, and the rule that keeps it out of the DOM.
 *
 * TWO HALVES, and the second is the one the slice exists for. The first is
 * ordinary: `panBatchDelta` and `panScrollNext` are pure, so they are called.
 * The second cannot be executed by this repo at all - `penRaw` needs a mounted
 * pdf viewer, and the cost being asserted is a cost that shows up as NOTHING
 * happening, a forced layout that no longer occurs - so it is pinned as source
 * shape, the house technique (PdfPanTrace.test.ts, InkSurfaceRules.test.ts),
 * with comments blanked through `codeOnly` first. A guard a comment can
 * satisfy is a guard a comment can defeat, and the controller's own prose in
 * this area quotes `scroller.scrollLeft -= smp.x - last.x` while explaining
 * why it is gone.
 *
 * WHAT THE SOURCE HALF ASSERTS:
 *
 *   - the move path writes each scroll axis exactly ONCE, and mentions it
 *     exactly once, so a write cannot come back with a read attached;
 *   - it makes no read of the offsets by any of the spellings that reach them
 *     - a compound assignment, a bare mention on the right of anything, or
 *     `toContent`, which takes both;
 *   - pen-down does take the read, once, because a drag that never read at
 *     all would be a drag that scrolls from zero.
 *
 * WHAT IT CANNOT ANSWER: whether the pan FEELS better on Alan's Surface.
 * Nothing here can. What it can say is that the layout flush a review
 * pointed at is not in the move path any more, and that it cannot come back
 * without this failing.
 */
import { describe, expect, it } from "vitest";
import { codeOnly } from "../CodeOnly";
import { surfaceCode } from "../inline/surfaceFiles.testutil";
import {
	PAN_EDGE_CLEAR,
	panBatchDelta,
	panEdgeContact,
	panScrollLimit,
	panScrollNext,
	type PanPoint,
	type PanScrollLimit,
} from "./PanScroll";

// The pdf surface's code across every file the ink-surface ledger lists for it (surfaceCode). The glob literal stays per module.
const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

const CONTROLLER = surfaceCode("pdf", ALL_TS);

/** No limit at all, for the cases that are about the delta and not the clamp. */
const OPEN: PanScrollLimit = panScrollLimit(null);

describe("panBatchDelta: one batch, one scroll delta", () => {
	it("negates the hand's travel, because content follows the pen", () => {
		const d = panBatchDelta({ x: 200, y: 200 }, [{ x: 210, y: 190 }]);
		expect(d.dx).toBe(-10);
		expect(d.dy).toBe(10);
		expect(d.last).toEqual({ x: 210, y: 190 });
	});

	it("is EXACTLY the per-sample loop it replaced, term for term", () => {
		// The claim `panBatchDelta`'s header makes, executed rather than
		// asserted in prose: the old branch applied smp[i] - smp[i-1] for
		// every i and the interior cancels. This is that loop, run beside it.
		const from: PanPoint = { x: 100, y: 100 };
		const samples = [
			{ x: 103, y: 97 },
			{ x: 111, y: 92 },
			{ x: 112, y: 88 },
			{ x: 130, y: 70 },
		];
		let loopX = 0;
		let loopY = 0;
		let last = from;
		for (const s of samples) {
			loopX -= s.x - last.x;
			loopY -= s.y - last.y;
			last = s;
		}
		const d = panBatchDelta(from, samples);
		expect(d.dx).toBe(loopX);
		expect(d.dy).toBe(loopY);
		expect(d.last).toEqual({ x: 130, y: 70 });
	});

	it("treats an empty batch as a hand that did not move", () => {
		// The router can hand penRaw a batch it filtered down to nothing, and
		// reading off the end of it would put NaN into the carried total for
		// the rest of the drag.
		const d = panBatchDelta({ x: 40, y: 50 }, []);
		expect(d.dx).toBe(0);
		expect(d.dy).toBe(0);
		expect(d.last).toEqual({ x: 40, y: 50 });
	});

	it("copies the last sample rather than keeping the sample itself", () => {
		// The samples carry pressure and a timestamp and are recycled by the
		// router; the drag holds this object until the next move.
		const samples = [{ x: 1, y: 2, pressure: 0.5, t: 9 }];
		const d = panBatchDelta({ x: 0, y: 0 }, samples);
		expect(d.last).not.toBe(samples[0]);
		expect(Object.keys(d.last).sort()).toEqual(["x", "y"]);
	});
});

describe("panScrollLimit: the range, from fields somebody else measured", () => {
	it("is the overflow on each axis", () => {
		expect(
			panScrollLimit({ clientWidth: 800, clientHeight: 600, scrollWidth: 1200, scrollHeight: 9000 })
		).toEqual({ maxX: 400, maxY: 8400 });
	});

	it("is zero, not negative, for content that fits", () => {
		expect(
			panScrollLimit({ clientWidth: 800, clientHeight: 600, scrollWidth: 700, scrollHeight: 500 })
		).toEqual({ maxX: 0, maxY: 0 });
	});

	it("is unbounded when nothing has been measured yet", () => {
		// A pan that starts before the first sync has nothing to clamp
		// against, and refusing to move would be a far worse answer than
		// letting the browser's own clamp on the write stand.
		expect(panScrollLimit(null)).toEqual({
			maxX: Number.POSITIVE_INFINITY,
			maxY: Number.POSITIVE_INFINITY,
		});
	});
});

describe("panScrollNext: the carried total, clamped the way the element would", () => {
	it("adds the delta when there is room", () => {
		expect(panScrollNext({ x: 500, y: 500 }, { dx: -10, dy: 10 }, OPEN)).toEqual({
			x: 490,
			y: 510,
		});
	});

	it("stops at the top instead of counting into a dead zone", () => {
		// THE REGRESSION THIS EXISTS FOR. `scrollLeft -= d` was clamped by the
		// browser on every step; an unclamped carried total keeps counting
		// past 0, and coming back needs the whole overshoot paid off before
		// anything moves. Twice in a row, because once is the easy case.
		const first = panScrollNext({ x: 5, y: 5 }, { dx: -80, dy: -80 }, OPEN);
		expect(first).toEqual({ x: 0, y: 0 });
		const second = panScrollNext(first, { dx: -80, dy: -80 }, OPEN);
		expect(second).toEqual({ x: 0, y: 0 });
		// And the very next pull the other way MOVES, rather than spending
		// 160px repaying an overshoot the page never made.
		expect(panScrollNext(second, { dx: 3, dy: 3 }, OPEN)).toEqual({ x: 3, y: 3 });
	});

	it("stops at the far end too", () => {
		const limit = panScrollLimit({
			clientWidth: 800,
			clientHeight: 600,
			scrollWidth: 1000,
			scrollHeight: 1000,
		});
		expect(panScrollNext({ x: 190, y: 390 }, { dx: 50, dy: 50 }, limit)).toEqual({
			x: 200,
			y: 400,
		});
	});

	it("pins both axes to zero when the content fits the viewport", () => {
		const limit = panScrollLimit({
			clientWidth: 800,
			clientHeight: 600,
			scrollWidth: 400,
			scrollHeight: 300,
		});
		expect(panScrollNext({ x: 0, y: 0 }, { dx: 40, dy: 40 }, limit)).toEqual({ x: 0, y: 0 });
	});
});

describe("panEdgeContact: one measurement per edge arrival, never per move", () => {
	// maxX 200, maxY 3400 - what the last `sync` measured.
	const CACHED = panScrollLimit({
		clientWidth: 800,
		clientHeight: 600,
		scrollWidth: 1000,
		scrollHeight: 4000,
	});

	it("asks for nothing while the move lands inside the cached range", () => {
		// The ordinary move, and the reason the whole design is at the
		// boundary: this one must stay exactly as cheap as it was.
		const to = panScrollNext({ x: 100, y: 1000 }, { dx: 10, dy: 40 }, CACHED);
		expect(to).toEqual({ x: 110, y: 1040 });
		const edge = panEdgeContact(to, CACHED, PAN_EDGE_CLEAR);
		expect(edge.remeasure).toBe(false);
		expect(edge.latch).toEqual({ x: false, y: false });
	});

	it("measures at the cached max, and the same move carries on past it", () => {
		// THE DEFECT. pdf.js laid out more pages after the last sync, so the
		// cached bottom is 5000px short of the real one and the drag stops
		// there until something else calls `sync`.
		const from = { x: 100, y: 3380 };
		const delta = { dx: 0, dy: 60 };
		const short = panScrollNext(from, delta, CACHED);
		expect(short).toEqual({ x: 100, y: 3400 });
		const edge = panEdgeContact(short, CACHED, PAN_EDGE_CLEAR);
		expect(edge.remeasure).toBe(true);
		// What the controller does with a true: measure, and clamp THIS move
		// again against what came back - not the next one, or the finger has
		// already paid a move at the wrong limit.
		const fresh = panScrollLimit({
			clientWidth: 800,
			clientHeight: 600,
			scrollWidth: 1000,
			scrollHeight: 9000,
		});
		const to = panScrollNext(from, delta, fresh);
		expect(to).toEqual({ x: 100, y: 3440 });
		// And it is off the edge again, so it asks for nothing further.
		expect(panEdgeContact(to, fresh, edge.latch)).toEqual({
			remeasure: false,
			latch: { x: false, y: false },
		});
	});

	it("measures once per contact at the REAL max, and clears when it leaves", () => {
		// The bottom is where the cache said it was: the measurement finds no
		// more room and the position stays put. What must NOT happen is a
		// second forced layout for every further move against the same edge -
		// which is a finger held at the bottom of a document, not a corner case.
		const first = panScrollNext({ x: 0, y: 3380 }, { dx: 0, dy: 60 }, CACHED);
		expect(first).toEqual({ x: 0, y: 3400 });
		const arrive = panEdgeContact(first, CACHED, PAN_EDGE_CLEAR);
		expect(arrive.remeasure).toBe(true);
		expect(arrive.latch).toEqual({ x: false, y: true });
		// Two more moves pushing into the same edge, both free.
		const held = panEdgeContact(first, CACHED, arrive.latch);
		expect(held.remeasure).toBe(false);
		const again = panScrollNext(first, { dx: 0, dy: 80 }, CACHED);
		expect(again).toEqual({ x: 0, y: 3400 });
		expect(panEdgeContact(again, CACHED, held.latch).remeasure).toBe(false);
		// Leaving the edge clears the latch...
		const off = panScrollNext(first, { dx: 0, dy: -40 }, CACHED);
		expect(off).toEqual({ x: 0, y: 3360 });
		const away = panEdgeContact(off, CACHED, held.latch);
		expect(away).toEqual({ remeasure: false, latch: { x: false, y: false } });
		// ...so coming back is a new contact and earns a new measurement.
		const back = panScrollNext(off, { dx: 0, dy: 90 }, CACHED);
		expect(back).toEqual({ x: 0, y: 3400 });
		expect(panEdgeContact(back, CACHED, away.latch).remeasure).toBe(true);
	});

	it("latches each axis on its own, so an edge-following drag still measures", () => {
		// THE PER-AXIS DECISION, executed. Dragging along the bottom of a
		// document is an ordinary diagonal drag: y is pinned and x is free. A
		// shared latch would still be held from the bottom when x arrives at
		// its own limit, and x would never measure.
		const atBottom = panEdgeContact({ x: 40, y: 3400 }, CACHED, PAN_EDGE_CLEAR);
		expect(atBottom).toEqual({ remeasure: true, latch: { x: false, y: true } });
		const toCorner = panScrollNext({ x: 40, y: 3400 }, { dx: 500, dy: 0 }, CACHED);
		expect(toCorner).toEqual({ x: 200, y: 3400 });
		const corner = panEdgeContact(toCorner, CACHED, atBottom.latch);
		expect(corner.remeasure).toBe(true);
		expect(corner.latch).toEqual({ x: true, y: true });
		// And the corner's one measurement covers both, so sitting in it is free.
		expect(panEdgeContact(toCorner, CACHED, corner.latch).remeasure).toBe(false);
	});

	it("never measures against a limit nothing has measured yet", () => {
		// `panScrollLimit(null)` is unbounded by design; a pan before the first
		// sync keeps that rather than acquiring a forced layout here.
		expect(panEdgeContact({ x: 0, y: 0 }, OPEN, PAN_EDGE_CLEAR)).toEqual({
			remeasure: false,
			latch: { x: false, y: false },
		});
	});
});

/** The `{ ... }` block opened by the first brace at or after `from`. */
function blockFrom(src: string, from: number): string {
	const open = src.indexOf("{", from);
	if (open < 0) return "";
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const ch = src[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return src.slice(open, i + 1);
		}
	}
	return "";
}

/**
 * `penRaw`'s pan branch, or a throw.
 *
 * THROWS rather than returning empty, for the reason PenCursor.test.ts's own
 * slicer gives: an empty slice satisfies every `not.toContain` below for free,
 * and a guard that passes vacuously is worse than no guard.
 */
function panMoveBranch(src: string): string {
	const at = src.indexOf("if (this.panLast !== null) {");
	if (at < 0) throw new Error("penRaw's pan branch was not found");
	const branch = blockFrom(src, at);
	if (!branch.includes("panBatchDelta(")) throw new Error("the pan branch does not pan");
	return branch;
}

/** `penDown`'s pan branch, which is where the one read lives. */
function panDownBranch(src: string): string {
	const at = src.indexOf('if (intent === "pan") {');
	if (at < 0) throw new Error("penDown's pan branch was not found");
	return blockFrom(src, at);
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("the pan's move path writes the scroller and never reads it", () => {
	const MOVE = panMoveBranch(CONTROLLER);

	it("sliced the move branch and not the whole method", () => {
		// Anti-vacuity for the slice itself before anything is asserted of it.
		expect(MOVE).toContain("this.panLast = {");
		expect(MOVE.length).toBeLessThan(4000);
	});

	it("writes each axis exactly once, and mentions it exactly once", () => {
		// The count is the assertion. One MENTION per axis means the write
		// cannot come back with a read attached to it, which is the shape the
		// compound assignment had.
		expect(occurrences(MOVE, "scroller.scrollLeft")).toBe(1);
		expect(occurrences(MOVE, "scroller.scrollTop")).toBe(1);
		expect(MOVE).toContain("scroller.scrollLeft = to.x;");
		expect(MOVE).toContain("scroller.scrollTop = to.y;");
	});

	it("makes no compound assignment, which is a read and a write", () => {
		expect(MOVE, "a read came back into the pan's move path").not.toMatch(
			/scroller\.scroll(?:Left|Top)\s*(?:-=|\+=)/
		);
	});

	it("does not reach the offsets through toContent either", () => {
		// `toContent` adds both offsets to a sample, so it is a scroll read
		// wearing a different name - and every other gesture's branch calls
		// it, so it is the likeliest way one would come back here.
		expect(MOVE, "the move path took the scroll offsets through toContent").not.toContain(
			"this.toContent("
		);
	});

	it("takes the drag's one read at pen-down instead", () => {
		// The other end of the rule: a drag that read NOWHERE would satisfy
		// every assertion above and scroll from zero.
		const down = panDownBranch(CONTROLLER);
		expect(down).toContain("scrollX: scroller.scrollLeft,");
		expect(down).toContain("scrollY: scroller.scrollTop,");
		expect(occurrences(down, "scroller.scrollLeft")).toBe(1);
		expect(occurrences(down, "scroller.scrollTop")).toBe(1);
	});
});

describe("both scans read code, not the sentences beside it", () => {
	// Fixtures. Without them a green run above is only a coincidence, which is
	// the failure this family of guards is named for.
	const PEN_RAW = (panBody: string): string =>
		[
			"\tprivate penRaw(samples: PenSample[], ev?: PointerEvent): void {",
			"\t\tif (this.spaceLineY !== null) {",
			"\t\t\tconst content = this.toContent(s, scroller);",
			"\t\t\treturn;",
			"\t\t}",
			"\t\tif (this.panLast !== null) {",
			panBody,
			"\t\t\treturn;",
			"\t\t}",
			"\t}",
		].join("\n");

	const GOOD = [
		"\t\t\tconst batch = panBatchDelta(from, samples);",
		"\t\t\tscroller.scrollLeft = to.x;",
		"\t\t\tscroller.scrollTop = to.y;",
	].join("\n");

	it("slices the pan branch and not the space branch above it", () => {
		// The neighbour matters: the space branch legitimately calls
		// `toContent`, sits above, and would fail the rule if the slice
		// reached back over it.
		const branch = panMoveBranch(PEN_RAW(GOOD));
		expect(branch).toContain("scroller.scrollLeft = to.x;");
		expect(branch).not.toContain("this.toContent(");
	});

	it("still catches the compound assignment this slice removed", () => {
		const buggy = panMoveBranch(
			PEN_RAW(
				[
					"\t\t\tconst batch = panBatchDelta(from, samples);",
					"\t\t\tfor (const smp of samples) {",
					"\t\t\t\tscroller.scrollLeft -= smp.x - last.x;",
					"\t\t\t\tscroller.scrollTop -= smp.y - last.y;",
					"\t\t\t}",
				].join("\n")
			)
		);
		expect(buggy).toMatch(/scroller\.scroll(?:Left|Top)\s*-=/);
		expect(occurrences(buggy, "scroller.scrollLeft")).toBe(1);
	});

	it("still catches a second write, which is a second layout write per move", () => {
		const twice = panMoveBranch(
			PEN_RAW(`${GOOD}\n\t\t\tif (snap) scroller.scrollTop = Math.round(to.y);`)
		);
		expect(occurrences(twice, "scroller.scrollTop")).toBe(2);
	});

	it("does NOT fire on a comment in the pan branch that quotes the old form", () => {
		// THE LOUD DIRECTION, and the comment the controller actually carries:
		// the fix's own explanation contains the thing it forbids. Blanked by
		// `codeOnly` before any of the counts above are taken.
		const explained = panMoveBranch(
			codeOnly(
				PEN_RAW(
					[
						"\t\t\t// was: scroller.scrollLeft -= smp.x - last.x; a read AND a write",
						GOOD,
					].join("\n")
				)
			)
		);
		expect(explained).not.toMatch(/scroller\.scroll(?:Left|Top)\s*-=/);
		expect(occurrences(explained, "scroller.scrollLeft")).toBe(1);
	});

	it("THROWS rather than passing vacuously when the branch cannot be found", () => {
		expect(() => panMoveBranch("const nothing = 1;\n")).toThrow(/pan branch was not found/);
		expect(() => panMoveBranch(PEN_RAW("\t\t\tthis.panLast = null;"))).toThrow(
			/does not pan/
		);
		expect(() => panDownBranch("const nothing = 1;\n")).toThrow(/pan branch was not found/);
	});
});
