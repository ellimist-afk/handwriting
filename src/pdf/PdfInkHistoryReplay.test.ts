import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type InkStroke } from "../ink/Stroke";
import { type InkOp } from "../inline/InkHistory";
import { parsePage, serializePage } from "../model/PageData";
import { PdfInkController } from "./PdfInkController";
import { applyOp, PdfInkHistory } from "./PdfInkHistory";
import { PdfInkStore } from "./PdfInkStore";

const ID = "pdf-replay";
const ids = (strokes: readonly InkStroke[]) => strokes.map((s) => s.id);

function stroke(id: string, x = 0, page = 1): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2, createdAt: 0, page,
		points: [{ x, y: 0, pressure: 0.5, t: 0 }, { x: x + 10, y: 10, pressure: 0.5, t: 8 }],
		bbox: { x, y: 0, width: 10, height: 10 },
	};
}

type Insertion = "append" | "indexed" | "replace";
function insertion(kind: Insertion, strokes: InkStroke[], indices: number[]): InkOp {
	return kind === "replace"
		? { type: "replace", path: ID, removed: [], removedAt: [], inserted: strokes, insertedAt: indices }
		: { type: "add", path: ID, strokes, ...(kind === "indexed" ? { indices } : {}) };
}

describe("PDF replay insertion identity", () => {
	it.each<Insertion>(["append", "indexed", "replace"])("%s preserves the surviving object and its current geometry", (kind) => {
		const current = Object.assign(stroke("same", 90, 3), { color: "#ff0000", width: 7, futureData: { value: 42 } });
		const input = Object.freeze([stroke("before"), current]);
		const op = insertion(kind, [stroke("same"), stroke("new")], [0, 2]);
		const before = structuredClone({ input, op });
		const result = applyOp(input, op);
		expect(ids(result)).toEqual(["before", "same", "new"]);
		expect(result[1]).toBe(current);
		expect(result).not.toBe(input);
		expect({ input, op }).toEqual(before);
	});

	it.each<Insertion>(["indexed", "replace"])("%s keeps original unsorted index pairs when collisions are skipped", (kind) => {
		const current = stroke("same", 40);
		const input = [stroke("a"), current, stroke("b"), stroke("c")];
		const op = insertion(kind, [stroke("late"), stroke("same"), stroke("early")], [4, 0, 1]);
		const before = structuredClone({ input, op });
		const result = applyOp(input, op);
		expect(ids(result)).toEqual(["a", "early", "same", "b", "late", "c"]);
		expect(result[2]).toBe(current);
		expect({ input, op }).toEqual(before);
	});

	it.each<Insertion>(["append", "indexed", "replace"])("%s accepts each new payload ID only once", (kind) => {
		const first = stroke("new", 10);
		const duplicate = stroke("new", 99);
		const result = applyOp([stroke("base")], insertion(kind, [first, duplicate, stroke("other")], [1, 2, 3]));
		expect(ids(result)).toEqual(["base", "new", "other"]);
		expect(result[1]).toBe(first);
	});

	it.each<Insertion>(["indexed", "replace"])("%s preserves equal-index ordering and fallback positions", (kind) => {
		const op = insertion(kind, [stroke("same"), stroke("x"), stroke("y"), stroke("fallback")], [0, 1, 1]);
		expect(ids(applyOp([stroke("a"), stroke("same"), stroke("b")], op)))
			.toEqual(["a", "y", "x", "fallback", "same", "b"]);
	});

	it("explicit same-ID removal and insertion still replaces the old snapshot", () => {
		const old = stroke("same");
		const updated = stroke("same", 70, 2);
		const result = applyOp([old], {
			type: "replace", path: ID, removed: [old], removedAt: [0],
			inserted: [updated, stroke("same", 999)], insertedAt: [0, 1],
		});
		expect(result).toEqual([updated]);
		expect(result[0]).toBe(updated);
	});

	it("does not clean up preexisting duplicate arrays during insertion", () => {
		const first = stroke("same");
		const second = stroke("same", 30);
		const result = applyOp([first, second], insertion("append", [stroke("same"), stroke("new")], []));
		expect(ids(result)).toEqual(["same", "same", "new"]);
		expect(result[0]).toBe(first);
		expect(result[1]).toBe(second);
	});
});

// Exercise the production controller history boundary and real store with only
// painting and host I/O replaced. Each schedule captures the actual sidecar bytes.
async function sharedPanes() {
	const store = new PdfInkStore();
	const saved = new Map<string, string>();
	const writes: { id: string; bytes: string }[] = [];
	store.attachHost({
		load: async () => null,
		schedule: (id, page) => {
			const bytes = serializePage(page);
			saved.set(id, bytes);
			writes.push({ id, bytes });
		},
		notice() {},
	});
	await store.ensureLoaded(ID);
	await store.ensureLoaded("other-pdf");
	const onOp = (op: InkOp) => store.replaceAll(op.path, applyOp(store.strokes(op.path), op));
	function pane() {
		const controller = Object.create(PdfInkController.prototype) as {
			recordOp(op: InkOp): void;
			historyStep(redo: boolean): boolean;
			documentId(): string;
		};
		Object.assign(controller, {
			history: new PdfInkHistory(), syntheticSources: () => false, onOp,
			builder: null, erasing: false, dragFrom: null, lassoPts: [], spaceLineY: null,
			documentId: () => ID, clearSelection() {}, refresh() {}, refreshStrip() {},
		});
		return controller;
	}
	const a = pane();
	const b = pane();
	const gesture = (pane: typeof a, op: InkOp) => {
		onOp(op);
		pane.recordOp(op);
	};
	const expectInk = (expected: string[], id = ID) => {
		expect(ids(store.strokes(id))).toEqual(expected);
		expect(ids(parsePage(saved.get(id)!, id).data.strokes)).toEqual(expected);
	};
	const expectUniqueWrites = () => {
		for (const { id, bytes } of writes) {
			const written = ids(parsePage(bytes, id).data.strokes);
			expect(new Set(written).size).toBe(written.length);
		}
	};
	return { store, saved, a, b, gesture, onOp, expectInk, expectUniqueWrites };
}

describe("PDF shared-pane history replay", () => {
	beforeEach(() => vi.stubGlobal("window", globalThis));
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		["remove", false], ["remove", true], ["replace", false], ["replace", true],
	] as const)("%s erase undo keeps one stroke with cross-pane replay=%s", async (kind, crossPane) => {
		const r = await sharedPanes();
		const s = stroke("s");
		r.gesture(r.a, { type: "add", path: ID, strokes: [s] });
		r.gesture(r.b, kind === "remove"
			? { type: "remove", path: ID, strokes: [s], indices: [0] }
			: { type: "replace", path: ID, removed: [s], removedAt: [0], inserted: [], insertedAt: [] });
		r.expectInk([]);
		if (crossPane) {
			expect(r.a.historyStep(false)).toBe(true);
			expect(r.a.historyStep(true)).toBe(true);
		}
		expect(r.b.historyStep(false)).toBe(true);
		r.expectInk(["s"]);
		for (let cycle = 0; cycle < 8; cycle++) {
			expect(r.b.historyStep(true)).toBe(true);
			r.expectInk([]);
			expect(r.a.historyStep(false)).toBe(true);
			expect(r.a.historyStep(true)).toBe(true);
			expect(r.b.historyStep(false)).toBe(true);
			r.expectInk(["s"]);
		}
		r.expectUniqueWrites();
	});

	it("partial erase replay preserves already restored pieces and their moved geometry", async () => {
		const r = await sharedPanes();
		const original = stroke("original");
		const pieces = [stroke("left"), stroke("right", 20)];
		r.onOp({ type: "add", path: ID, strokes: [original] });
		r.gesture(r.a, {
			type: "replace", path: ID, removed: [original], removedAt: [0], inserted: pieces, insertedAt: [0, 1],
		});
		r.gesture(r.b, { type: "remove", path: ID, strokes: pieces, indices: [0, 1] });
		expect(r.a.historyStep(false)).toBe(true);
		r.expectInk(["original"]);
		expect(r.b.historyStep(false)).toBe(true);
		r.expectInk(["left", "right", "original"]);
		r.onOp({ type: "move", path: ID, strokeIds: ["left"], dx: 45, dy: 12 });
		const moved = r.store.strokes(ID)[0];
		expect(r.a.historyStep(true)).toBe(true);
		r.expectInk(["left", "right"]);
		expect(r.store.strokes(ID)[0]).toBe(moved);
		expect(parsePage(r.saved.get(ID)!, ID).data.strokes[0]!.points[0]).toMatchObject({ x: 45, y: 12 });
		for (let cycle = 0; cycle < 8; cycle++) {
			expect(r.a.historyStep(false)).toBe(true);
			r.expectInk(["original"]);
			expect(r.a.historyStep(true)).toBe(true);
			r.expectInk(["left", "right"]);
		}
		r.expectUniqueWrites();
	});

	it("replays the captured document across pages after panes switch documents", async () => {
		const r = await sharedPanes();
		const one = stroke("one", 10, 1);
		const two = stroke("two", 20, 2);
		const unrelated = stroke("one", 80, 4);
		r.onOp({ type: "add", path: "other-pdf", strokes: [unrelated] });
		r.gesture(r.a, { type: "add", path: ID, strokes: [one, two] });
		r.gesture(r.b, { type: "remove", path: ID, strokes: [one], indices: [0] });
		r.a.documentId = r.b.documentId = () => "other-pdf";
		expect(r.a.historyStep(false)).toBe(true);
		expect(r.a.historyStep(true)).toBe(true);
		expect(r.b.historyStep(false)).toBe(true);
		r.expectInk(["one", "two"]);
		expect(r.store.strokesOnPage(ID, 1)).toEqual([one]);
		expect(r.store.strokesOnPage(ID, 2)).toEqual([two]);
		r.expectInk(["one"], "other-pdf");
		expect(r.store.strokes("other-pdf")[0]).toBe(unrelated);
		r.expectUniqueWrites();
	});
});
