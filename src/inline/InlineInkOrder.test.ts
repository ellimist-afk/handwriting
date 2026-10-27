import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction, type StateCommand, type TransactionSpec } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport, type InkOp } from "./InkHistory";
import { InlineInkStore, type InlineInkHost } from "./InlineInkStore";
import { emptyPage, parsePage, serializePage, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import { DamageLedger } from "../ink/DamageLedger";

let serial = 0;
const paths = new Set<string>();
beforeEach(() => vi.stubGlobal("window", globalThis));
afterEach(() => {
	for (const path of paths) inlineInk.handleDelete(path);
	paths.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.unstubAllGlobals();
});

function stroke(id: string): InkStroke {
	return { id, tool: "pen", color: "#000000", width: 2,
		points: [{ x: 0, y: 0, pressure: 0.5, t: 0 }, { x: 10, y: 10, pressure: 0.5, t: 8 }],
		bbox: { x: 0, y: 0, width: 10, height: 10 }, createdAt: 0 };
}
const ids = (strokes: readonly InkStroke[]) => strokes.map(s => s.id);

async function storeRig(initial: InkStroke[], store = new InlineInkStore()) {
	const path = `inline-order-${++serial}.md`;
	if (store === inlineInk) paths.add(path);
	const pageId = `inline-order-id-${serial}`;
	let page = emptyPage(pageId);
	page.surface = "inline";
	page.strokes = initial;
	const saved: string[] = [];
	let load: () => Promise<ParseResult | null> = async () => ({ data: page, recovered: false });
	store.attachHost({
		readPageId: p => p === path ? pageId : null,
		claimId: async (_p, proposed) => ({ pageId: proposed }),
		loadSidecar: () => load(),
		scheduleSidecar: (_id, data) => { saved.push(serializePage(data)); },
		notify() {},
	});
	await store.ensureLoaded(path);
	return { store, path, pageId, saved,
		strokes: () => store.strokes(path),
		persisted: () => parsePage(saved.at(-1)!, pageId).data.strokes,
		deferLoad() {
			let resolve!: (result: ParseResult) => void;
			const pending = new Promise<ParseResult>(done => { resolve = done; });
			load = () => pending;
			return (strokes: InkStroke[]) => {
				page = { ...page, strokes };
				resolve({ data: page, recovered: false });
			};
		},
	};
}

/** Production pen-up, publication and replay with real CodeMirror history; fake only I/O and paint. */
async function historyRig(initial: InkStroke[]) {
	const r = await storeRig(initial, inlineInk);
	let state = EditorState.create({ doc: "text", extensions: [history(), inkHistorySupport()] });
	const published: InkOp[] = [];
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	Object.assign(overlay, { filePath: () => r.path, selection: { prune() {} },
		scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {}, damage: new DamageLedger() });
	const dispatch = (input: Transaction | TransactionSpec) => {
		const tr = input instanceof Transaction ? input : state.update(input);
		state = tr.state;
		for (const e of tr.effects) {
			if (!e.is(inkEffect)) continue;
			if (tr.annotation(inkApplied)) published.push(e.value);
			else overlay.applyInkOp(e.value);
		}
	};
	overlay.view = { get state() { return state; }, dispatch };
	return { ...r, published,
		run: (cmd: StateCommand) => cmd({ state, dispatch }),
		erase(order: readonly string[], partial = false) {
			const before = [...r.strokes()];
			const erased = order.flatMap(id => inlineInk.takeLive(r.path, [id]));
			const pieces = partial ? [stroke("b-left"), stroke("b-right"), stroke("c-left")] : [];
			if (partial) inlineInk.applyAddLive(r.path, pieces, [1, 2, 3]);
			Object.assign(overlay, { mode: "erase", frame: { end() {} }, mobileTools: null,
				erased, eraseFrom: before, erasePieces: new Set(ids(pieces)),
				stopFrameTicker() {}, hideEraserCursor() {}, frontierCache: { invalidate() {} },
				viewportPan: { x: 0, y: 0 },
				boundReadout: { floorX: 0, floorY: 0, bx: 0, width: 0, rawX: 0, cx: 0, rawY: 0, cy: 0,
					dragFrame: false, neverZoomed: false, steady: false, next: 0, fromScale: 0, fromScaleValid: false,
					restCeilX: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, bounded: false, settling: false } });
			overlay.penUp();
		},
	};
}

describe("production erase restoration order", () => {
	it.each([["b", "c"], ["c", "b"]])("restores order after scrubbing %s then %s", async (one, two) => {
		const initial = ["a", "b", "c", "d"].map(stroke);
		const r = await historyRig(initial);
		r.erase([one, two]);
		expect(ids(r.strokes())).toEqual(["a", "d"]);
		expect(r.run(undo)).toBe(true);
		expect(ids(r.persisted())).toEqual(["a", "b", "c", "d"]);
		expect(ids(r.strokes())).toEqual(["a", "b", "c", "d"]);
	});
});

describe("erase history cycles", () => {
	const orders = [
		["a"], ["e"], ["e", "a"], ["d", "b"], ["b", "d"],
		["e", "c", "a"], ["e", "d", "c", "b", "a"], ["c", "a", "e", "b", "d"],
	];
	it.each(orders.map(order => ({ order, label: order.join(",") })))("restores $label through three cycles", async ({ order }) => {
		const initial = ["a", "b", "c", "d", "e"].map(stroke);
		const r = await historyRig(initial);
		r.erase(order);
		const erased = initial.filter(s => !order.includes(s.id));
		expect(r.published).toHaveLength(1);
		expect(r.published[0]).toMatchObject({ type: "replace", removedAt: order.map(id => initial.findIndex(s => s.id === id)) });
		for (let cycle = 0; cycle < 3; cycle++) {
			expect(ids(r.strokes())).toEqual(ids(erased));
			expect(ids(r.persisted())).toEqual(ids(erased));
			expect(r.run(undo)).toBe(true);
			expect(ids(r.persisted())).toEqual(ids(initial));
			expect(r.strokes()).toEqual(initial);
			r.strokes().forEach((s, i) => expect(s).toBe(initial[i]));
			expect(r.run(redo)).toBe(true);
		}
		expect(ids(r.strokes())).toEqual(ids(erased));
		expect(ids(r.persisted())).toEqual(ids(erased));
	});

	it.each([["b", "c"], ["c", "b"]])("restores partial replacements after %s then %s", async (one, two) => {
		const initial = ["a", "b", "c", "d"].map(stroke);
		const r = await historyRig(initial);
		r.erase([one, two], true);
		const pieces = [...r.strokes()];
		expect(ids(pieces)).toEqual(["a", "b-left", "b-right", "c-left", "d"]);
		for (let cycle = 0; cycle < 3; cycle++) {
			expect(r.run(undo)).toBe(true);
			expect(r.strokes()).toEqual(initial);
			expect(ids(r.persisted())).toEqual(ids(initial));
			expect(r.run(redo)).toBe(true);
			expect(r.strokes()).toEqual(pieces);
			expect(ids(r.persisted())).toEqual(ids(pieces));
		}
	});
});

const addMethods = ["applyAdd", "applyAddLive"] as const;
describe.each(addMethods)("%s insertion contract", method => {
	it("restores frozen operands and indices, retaining survivor objects and persistence boundaries", async () => {
		const initial = ["a", "b", "c", "d"].map(stroke);
		for (const s of initial) {
			s.points.forEach(Object.freeze);
			Object.freeze(s.points); Object.freeze(s.bbox); Object.freeze(s);
		}
		const r = await storeRig([initial[0]!, initial[3]!]);
		const operands = Object.freeze([initial[2]!, initial[1]!]);
		const indices = Object.freeze([2, 1]);
		r.store[method](r.path, operands, indices);
		expect(ids(r.strokes())).toEqual(["a", "b", "c", "d"]);
		r.strokes().forEach((s, i) => expect(s).toBe(initial[i]));
		expect(operands).toEqual([initial[2], initial[1]]);
		expect(indices).toEqual([2, 1]);
		expect(r.saved).toHaveLength(method === "applyAddLive" ? 0 : 1);
		r.store.save(r.path);
		expect(r.saved).toHaveLength(method === "applyAddLive" ? 1 : 2);
		expect(ids(r.persisted())).toEqual(["a", "b", "c", "d"]);
	});

	it("keeps the first original duplicate operand and the already-present newer object", async () => {
		const survivor = { ...stroke("a"), color: "#ff0000" };
		const first = { ...stroke("c"), color: "#0000ff" };
		const later = { ...stroke("c"), color: "#00ff00" };
		const b = stroke("b");
		const r = await storeRig([survivor]);
		r.store[method](r.path, [first, later, stroke("a"), b], [2, 0, 0, 1]);
		expect(ids(r.strokes())).toEqual(["a", "b", "c"]);
		expect(r.strokes()[0]).toBe(survivor);
		expect(r.strokes()[2]).toBe(first);
		r.store[method](r.path, [later, stroke("a"), b], [0, 1, 2]);
		expect(ids(r.strokes())).toEqual(["a", "b", "c"]);
		expect(r.strokes()[0]).toBe(survivor);
		expect(r.strokes()[2]).toBe(first);
	});

	it("marks inserted IDs during reload but does not mark skipped stale IDs", async () => {
		const cached = stroke("a");
		const r = await storeRig([cached]);
		const finish = r.deferLoad();
		const reloading = r.store.reloadExternal(r.path);
		const c = stroke("c"); const b = stroke("b");
		r.store[method](r.path, [c, stroke("a"), b], [2, 0, 1]);
		expect(ids(r.strokes())).toEqual(["b", "c"]); // Unchanged cached ink stays hidden during reload.
		const remote = { ...stroke("a"), color: "#ff0000" };
		finish([remote]);
		expect(await reloading).toBe(true);
		expect(ids(r.strokes())).toEqual(["a", "b", "c"]);
		expect(r.strokes()[0]).toBe(remote);
		expect(r.strokes()[1]).toBe(b);
		expect(r.strokes()[2]).toBe(c);
	});

	it("uses current insertion length, including indices initially beyond survivors", async () => {
		const r = await storeRig([stroke("a"), stroke("e")]);
		r.store[method](r.path, [stroke("d"), stroke("c"), stroke("b")], [3, 2, 1]);
		expect(ids(r.strokes())).toEqual(["a", "b", "c", "d", "e"]);
	});

	it("appends still-out-of-range valid indices at their insertion time", async () => {
		const r = await storeRig([stroke("a")]);
		r.store[method](r.path, [stroke("far"), stroke("near"), stroke("b")], [9, 5, 1]);
		expect(ids(r.strokes())).toEqual(["a", "b", "near", "far"]);
	});

	const fallbacks: Array<{ label: string; indices?: readonly number[]; expected: string[] }> = [
		{ label: "unindexed", expected: ["a", "d", "c", "b"] },
		{ label: "empty", indices: [], expected: ["a", "d", "c", "b"] },
		{ label: "partial", indices: [2], expected: ["a", "d", "c", "b"] },
		{ label: "negative", indices: [2, -1], expected: ["a", "d", "c", "b"] },
		{ label: "fractional splice coercion", indices: [2, 1.5], expected: ["a", "b", "d", "c"] },
		{ label: "NaN", indices: [2, NaN], expected: ["a", "d", "c", "b"] },
		{ label: "infinite", indices: [2, Infinity], expected: ["a", "d", "c", "b"] },
		{ label: "negative infinity", indices: [-Infinity, 1], expected: ["a", "b", "d", "c"] },
		{ label: "sparse", indices: [, 1] as number[], expected: ["a", "b", "d", "c"] },
		{ label: "surplus metadata", indices: [2, 1, 0], expected: ["a", "b", "d", "c"] },
	];
	it.each(fallbacks)("preserves traversal and fallback for $label metadata", async ({ indices, expected }) => {
		const r = await storeRig([stroke("a"), stroke("d")]);
		r.store[method](r.path, Object.freeze([stroke("c"), stroke("b")]), indices && Object.freeze(indices));
		expect(ids(r.strokes())).toEqual(expected);
	});
});
