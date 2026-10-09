/**
 * The insert-space rows cache answers a hover ask on an unchanged note
 * without reading every stroke, and still sees every change the store makes.
 *
 * The cache used to confirm a hit by comparing each stroke's object and
 * revision with the ones it was built from: on the 28555-stroke note that
 * scan cost about 2 ms on every hover frame. A hit is now one comparison of
 * the list object, its length and one ink revision that every stroke change
 * and every in-place change to a store's list moves. The first cell proves a
 * hit reads no stroke. The second drives each in-place change the store can
 * make to the list it hands out (add, live add, commit with a replace,
 * remove, live remove, move) and checks the cache against a fresh build after
 * each one, on the same list object, so a store change that forgot the ink
 * revision would leave the cache serving the rows from before it.
 */
import { describe, expect, it } from "vitest";
import { InsertSpaceRows } from "./InsertSpace";
import { InlineInkStore } from "./InlineInkStore";
import type { InkStroke } from "../ink/Stroke";

function line(id: string, x: number, y: number, h = 18): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x, y, pressure: 0.5, t: 0 },
			{ x: x + 30, y: y + h, pressure: 0.5, t: 8 },
		],
		bbox: { x, y, width: 30, height: h },
		createdAt: 1,
	} as InkStroke;
}

/** Three rows of four words each, rows 40 apart. */
const page = (): InkStroke[] =>
	Array.from({ length: 12 }, (_, i) => line(`s${i}`, 20 + (i % 4) * 50, 30 + Math.floor(i / 4) * 40));

describe("rows cache hit is one ink revision compare", () => {
	it("a get on an unchanged list reads no stroke", () => {
		let reads = 0;
		const list = new Proxy(page(), {
			get(target, key, recv) {
				if (typeof key === "string" && /^\d+$/.test(key)) reads++;
				return Reflect.get(target, key, recv);
			},
		});
		const cache = new InsertSpaceRows();
		const first = cache.get(list);
		expect(first.length, "premise: three rows").toBe(3);
		reads = 0;
		for (let i = 0; i < 5; i++) expect(cache.get(list)).toBe(first);
		expect(reads, "strokes read by five hit gets").toBe(0);
	});

	it("a different list of the same length at the same ink revision is checked, not taken as a hit", () => {
		const a = page(), cache = new InsertSpaceRows();
		cache.get(a);
		const b = a.slice();
		b[0] = line("other", 20, 400);
		expect(b.length, "premise: same length").toBe(a.length);
		expect(cache.get(b), "the rows of the new list").toEqual(new InsertSpaceRows().get(b));
	});

	it("every in-place change the store makes to its list reaches the cache", () => {
		const store = new InlineInkStore();
		const NOTE = "rows-revision.md";
		store.applyAddLive(NOTE, page());
		const list = store.strokes(NOTE);
		const cache = new InsertSpaceRows();
		const check = (step: string) => {
			expect(store.strokes(NOTE), `${step}: premise, same list object`).toBe(list);
			expect(cache.get(list), step).toEqual(new InsertSpaceRows().get(list));
		};
		cache.get(list);
		store.applyAddLive(NOTE, [line("new1", 20, 150)]);
		check("live add");
		store.applyAddLive(NOTE, [line("mid", 400, 30)], [2]);
		check("live add at an index");
		store.commitGesture(NOTE, [line("s5", 20, 190)]);
		check("commit replacing a stroke in place");
		store.commitGesture(NOTE, [line("new2", 20, 230)]);
		check("commit adding a stroke");
		store.takeLive(NOTE, ["s0"]);
		check("live remove");
		store.moveStrokes(NOTE, ["s8", "s9"], 0, 24);
		check("move");
		const before = cache.get(list);
		store.takeLive(NOTE, ["s1"]);
		store.applyAddLive(NOTE, [line("s1", 20, 300)], [0]);
		const after = cache.get(list);
		expect(after, "remove then add keeps the length").not.toBe(before);
		check("remove then add at the same length");
	});
});
