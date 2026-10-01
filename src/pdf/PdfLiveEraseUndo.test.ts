// Undo after a live-page erase keeps each page's z-order, and the store's
// by-page index and forget guard see changes made after they were taken.
// The erase entry mirrors PdfInkController.recordErase (a before/after diff at
// pen-up) and the undo mirrors the history inverse (invertInkOp + applyOp),
// both through the real PdfInkStore.
import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PdfInkStore } from "./PdfInkStore";
import { applyOp } from "./PdfInkHistory";
import { invertInkOp, InkOp } from "../inline/InkHistory";

function stroke(id: string, page: number): InkStroke {
	const points = [
		{ x: 10, y: 10, pressure: 0.5, t: 0 },
		{ x: 20, y: 20, pressure: 0.5, t: 8 },
	];
	return { id, tool: "pen", color: "#000", width: 2, points, bbox: computeBBox(points, 4), createdAt: 0, page } as InkStroke;
}

// recordErase's entry: indices against before (removed) and after (inserted).
function eraseEntry(before: readonly InkStroke[], after: readonly InkStroke[]): InkOp {
	const afterIds = new Set(after.map((s) => s.id));
	const beforeIds = new Set(before.map((s) => s.id));
	const removedAt: number[] = [];
	const removed = before.filter((s, i) => !afterIds.has(s.id) && removedAt.push(i) > 0);
	const insertedAt: number[] = [];
	const inserted = after.filter((s, i) => !beforeIds.has(s.id) && insertedAt.push(i) > 0);
	return { type: "replace", path: "doc", removed, removedAt, inserted, insertedAt } as InkOp;
}

const ids = (list: readonly InkStroke[]) => list.map((s) => s.id);
const onPage = (list: readonly InkStroke[], p: number) => ids(list.filter((s) => s.page === p));

describe("undo after a live-page erase", () => {
	it("two strokes wiped on page 1 with another page's stroke between them: undo restores page 1's order", () => {
		const store = new PdfInkStore();
		const a = stroke("a", 1), x = stroke("x", 2), b = stroke("b", 1), c = stroke("c", 1);
		store.replaceAll("doc", [a, x, b, c]);
		const before = [...store.strokes("doc")];
		// One sample wipes a and b; indices are page 1's list [a, b, c].
		store.applyLivePage("doc", { type: "replace", path: "doc", removed: [a, b], removedAt: [0, 1], inserted: [], insertedAt: [] } as InkOp);
		const after = [...store.strokes("doc")];
		expect(onPage(after, 1), "page 1 after the erase").toEqual(["c"]);
		expect(ids(after), "the survivor keeps its own slot").toEqual(["x", "c"]);
		const undone = applyOp(after, invertInkOp(eraseEntry(before, after)));
		expect(onPage(undone, 1), "page 1 after undo").toEqual(["a", "b", "c"]);
		expect(ids(undone), "the whole document after undo").toEqual(["a", "x", "b", "c"]);
	});

	it("control: the same erase on the document list kept in place undoes right", () => {
		const a = stroke("a", 1), x = stroke("x", 2), b = stroke("b", 1), c = stroke("c", 1);
		const before = [a, x, b, c];
		const after = applyOp(before, { type: "replace", path: "doc", removed: [a, b], removedAt: [0, 2], inserted: [], insertedAt: [] } as InkOp);
		const undone = applyOp(after, invertInkOp(eraseEntry(before, after)));
		expect(onPage(undone, 1)).toEqual(["a", "b", "c"]);
	});

	it("split pieces take the split stroke's slot, and undo then redo lands where the live state was", () => {
		const store = new PdfInkStore();
		const a = stroke("a", 1), x = stroke("x", 2), b = stroke("b", 1), c = stroke("c", 1), y = stroke("y", 2);
		store.replaceAll("doc", [a, x, b, y, c]);
		const before = [...store.strokes("doc")];
		// b is split into two pieces; page 1's list is [a, b, c].
		const b1 = stroke("b1", 1), b2 = stroke("b2", 1);
		store.applyLivePage("doc", { type: "replace", path: "doc", removed: [b], removedAt: [1], inserted: [b1, b2], insertedAt: [1, 2] } as InkOp);
		const after = [...store.strokes("doc")];
		expect(ids(after), "survivors keep their slots; the pieces take b's slot").toEqual(["a", "x", "b1", "b2", "y", "c"]);
		const entry = eraseEntry(before, after);
		const undone = applyOp(after, invertInkOp(entry));
		expect(ids(undone), "undo gives the document back").toEqual(["a", "x", "b", "y", "c"]);
		const redone = applyOp(undone, entry);
		expect(ids(redone), "redo gives the live state back").toEqual(ids(after));
	});

	it("an erase that empties the page leaves every other page where it was", () => {
		const store = new PdfInkStore();
		const a = stroke("a", 1), x = stroke("x", 2), b = stroke("b", 1);
		store.replaceAll("doc", [a, x, b]);
		store.applyLivePage("doc", { type: "replace", path: "doc", removed: [a, b], removedAt: [0, 1], inserted: [], insertedAt: [] } as InkOp);
		expect(ids(store.strokes("doc"))).toEqual(["x"]);
	});
});

describe("undo after a live-page erase, seeded sweep", () => {
	it("across random erases and splits, undo gives the document back and redo gives the fold back", () => {
		let seed = 12345;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return (seed >>> 16) % n;
		};
		let made = 0;
		for (let round = 0; round < 400; round++) {
			const doc: InkStroke[] = [];
			const n = 1 + rand(8);
			for (let i = 0; i < n; i++) doc.push(stroke(`s${made++}`, 1 + rand(3)));
			const page = doc[rand(doc.length)]!.page as number;
			const store = new PdfInkStore();
			store.replaceAll("doc", doc);
			const before = [...store.strokes("doc")];
			// One to three samples, each removing one stroke of the page and
			// inserting zero to two pieces where it was.
			const samples = 1 + rand(3);
			for (let t = 0; t < samples; t++) {
				const list = store.strokesOnPage("doc", page);
				if (list.length === 0) break;
				const at = rand(list.length);
				const pieces = Array.from({ length: rand(3) }, () => stroke(`s${made++}`, page));
				store.applyLivePage("doc", {
					type: "replace",
					path: "doc",
					removed: [list[at]!],
					removedAt: [at],
					inserted: pieces,
					insertedAt: pieces.map((_, j) => at + j),
				} as InkOp);
			}
			const live = store.strokesOnPage("doc", page);
			const after = [...store.strokes("doc")];
			const where = `round ${round}: ${ids(before).join(",")} page ${page}`;
			expect(onPage(after, page), `${where}: the page as the gesture left it`).toEqual(ids(live));
			const entry = eraseEntry(before, after);
			const undone = applyOp(after, invertInkOp(entry));
			expect(ids(undone), `${where}: undo`).toEqual(ids(before));
			expect(ids(applyOp(undone, entry)), `${where}: redo`).toEqual(ids(after));
		}
	});
});

describe("the store sees changes made after it answered", () => {
	it("the by-page index includes a stroke committed after the index was built", () => {
		const store = new PdfInkStore();
		store.replaceAll("doc", [stroke("a", 1), stroke("x", 2)]);
		expect(ids(store.strokesOnPage("doc", 1)), "index built").toEqual(["a"]);
		store.commit("doc", stroke("b", 1));
		expect(ids(store.strokesOnPage("doc", 1)), "the committed stroke is on its page").toEqual(["a", "b"]);
	});

	it("forgetIfUnchanged keeps a record that changed after its generation was taken", () => {
		const store = new PdfInkStore();
		store.replaceAll("doc", [stroke("a", 1)]);
		const g = store.generation("doc");
		expect(g).not.toBeNull();
		store.commit("doc", stroke("b", 1));
		expect(store.forgetIfUnchanged("doc", g!)).toBe(false);
		expect(ids(store.strokes("doc"))).toEqual(["a", "b"]);
	});
});
