import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState, Transaction, type StateCommand, type TransactionSpec } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport, type InkOp } from "./InkHistory";
import { onInkChanged } from "./InkEvents";
import type { InlineInkHost } from "./InlineInkStore";
import { emptyPage, parsePage, serializePage, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

let serial = 0;
const paths = new Set<string>();
const subscriptions: Array<() => void> = [];
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
});
afterEach(() => {
	for (const off of subscriptions.splice(0)) off();
	for (const path of paths) inlineInk.handleDelete(path);
	paths.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function stroke(id: string, x = 0): InkStroke {
	return { id, tool: "pen", color: "#000000", width: 2, createdAt: 0,
		points: [{ x, y: 0, pressure: 0.5, t: 0 }, { x: x + 10, y: 10, pressure: 0.5, t: 8 }],
		bbox: { x, y: 0, width: 10, height: 10 } };
}
const ids = (strokes: readonly InkStroke[]) => strokes.map(s => s.id);
type Mode = "claimed" | "pending" | "memory" | "locked";

/** Real CM history and production overlay/store; only host I/O and overlay paint are fake. */
async function rig(initial: InkStroke[] = [], mode: Mode = "claimed") {
	let path = `replacement-boundary-${++serial}.md`;
	paths.add(path);
	const pageId = `replacement-boundary-id-${serial}`;
	const metadata = new Map(mode === "pending" || mode === "memory" ? [] : [[path, pageId]]);
	const page = emptyPage(pageId);
	page.surface = "inline";
	page.strokes = initial;
	const writes: Array<{ id: string; payload: string }> = [];
	let finishClaim!: (value: { pageId: string }) => void;
	const claim = new Promise<{ pageId: string }>(resolve => { finishClaim = resolve; });
	let load: () => Promise<ParseResult | null> = async () => ({ data: page, recovered: false,
		...(mode === "locked" ? { futureVersion: 999 } : {}) });
	if (mode !== "memory") inlineInk.attachHost({
		readPageId: p => metadata.get(p) ?? null,
		claimId: () => claim,
		loadSidecar: () => load(),
		scheduleSidecar: (id, data) => writes.push({ id, payload: serializePage(data) }),
		notify() {},
	});
	await inlineInk.ensureLoaded(path);
	if (mode === "pending" || mode === "memory") inlineInk.applyAddLive(path, initial);
	let state = EditorState.create({ doc: "note", extensions: [history(), inkHistorySupport()] });
	const published: InkOp[] = [];
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	Object.assign(overlay, { filePath: () => path, selection: { prune: vi.fn() },
		scheduleRepaint: vi.fn(), repaintPath: vi.fn(), updateExtent: vi.fn(), indexDirty: false });
	const dispatch = (input: Transaction | TransactionSpec) => {
		const tr = input instanceof Transaction ? input : state.update(input);
		state = tr.state;
		for (const effect of tr.effects) if (effect.is(inkEffect)) {
			if (tr.annotation(inkApplied)) published.push(effect.value);
			else overlay.applyInkOp(effect.value);
		}
	};
	overlay.view = { get state() { return state; }, dispatch };
	const observed: Array<{ path: string; ids: string[]; payloadIds: string[] | null }> = [];
	subscriptions.push(onInkChanged(p => {
		if (p !== path) return;
		const latest = writes.at(-1);
		observed.push({ path: p, ids: ids(inlineInk.strokes(p)),
			payloadIds: latest ? ids(parsePage(latest.payload, latest.id).data.strokes) : null });
	}));
	return { overlay, writes, observed, published, pageId,
		get path() { return path; },
		strokes: () => inlineInk.strokes(path),
		run: (command: StateCommand) => command({ state, dispatch }),
		clear() { writes.length = 0; observed.length = 0; },
		add(s: InkStroke) { inlineInk.commit(path, s); overlay.dispatchInk({ type: "add", path, strokes: [s] }); },
		replace(removed: InkStroke[], inserted: InkStroke[]) {
			const removedAt = removed.map(s => inlineInk.strokes(path).findIndex(current => current.id === s.id));
			const insertedAt = inserted.map((_, i) => i);
			inlineInk.takeLive(path, ids(removed));
			inlineInk.applyAddLive(path, inserted, insertedAt);
			inlineInk.save(path);
			overlay.dispatchInk({ type: "replace", path, removed, removedAt, inserted, insertedAt });
		},
		rename() {
			const next = `${path}.renamed.md`;
			paths.add(next);
			metadata.delete(path); metadata.set(next, pageId);
			inlineInk.handleRename(path, next); path = next;
		},
		async finishClaim() { metadata.set(path, pageId); finishClaim({ pageId }); expect(await inlineInk.settle()).toBe(true); },
		beginReload() {
			let resolve!: (value: ParseResult) => void;
			load = () => new Promise<ParseResult>(done => { resolve = done; });
			const pending = inlineInk.reloadExternal(path);
			return async () => { resolve({ data: page, recovered: false }); await pending; expect(await inlineInk.settle()).toBe(true); };
		},
	};
}
type Rig = Awaited<ReturnType<typeof rig>>;
function boundary(r: Rig, expected: string[]) {
	expect(ids(r.strokes())).toEqual(expected);
	expect(r.writes).toHaveLength(1);
	expect(r.writes[0]!.id).toBe(r.pageId);
	expect(r.observed).toEqual([{ path: r.path, ids: expected, payloadIds: expected }]);
}

it.each([false, true])("replace with pieces=%s publishes one complete snapshot and event on undo/redo", async pieces => {
	const original = stroke("original"), unrelated = stroke("unrelated");
	const r = await rig([original, unrelated]);
	const inserted = pieces ? [stroke("left"), stroke("right")] : [];
	r.replace([original], inserted);
	r.clear(); expect(r.run(undo)).toBe(true); boundary(r, ["original", "unrelated"]);
	expect(r.strokes()[1]).toBe(unrelated);
	r.clear(); expect(r.run(redo)).toBe(true); boundary(r, [...ids(inserted), "unrelated"]);
	expect(r.strokes().at(-1)).toBe(unrelated);
	expect(r.overlay.selection.prune).toHaveBeenCalledTimes(2);
	expect(r.overlay.repaintPath).toHaveBeenLastCalledWith(r.path);
});

it.each(["empty-to-ink", "ink-to-empty", "same-id"])("%s replacement publishes the final contents", async kind => {
	const original = stroke("original");
	const r = await rig(kind === "empty-to-ink" ? [] : [original]);
	const inserted = kind === "ink-to-empty" ? [] : [stroke(kind === "same-id" ? "original" : "inserted", 40)];
	r.overlay.applyInkOp({ type: "replace", path: r.path,
		removed: kind === "empty-to-ink" ? [] : [original], removedAt: [0], inserted, insertedAt: [0] });
	boundary(r, ids(inserted));
	if (inserted.length) expect(r.strokes()[0]).toBe(inserted[0]);
});

// Revised: this used to be the "missing-removed" row above, which put the inserted stroke in although the stroke
// it replaces was not there. A replace now applies whole or not at all: with a removed stroke missing (another device
// erased or split it and the sync poll adopted that), inserting lays ink over what is there, so nothing changes and
// nothing is saved or announced. ReplaceWholeOrNothing.test.ts has the user's sequence.
it("a replacement whose removed stroke is missing changes nothing and publishes nothing", async () => {
	const r = await rig([]);
	r.overlay.applyInkOp({ type: "replace", path: r.path,
		removed: [stroke("original")], removedAt: [0], inserted: [stroke("inserted", 40)], insertedAt: [0] });
	expect(ids(r.strokes())).toEqual([]);
	expect(r.writes).toEqual([]);
	expect(r.observed).toEqual([]);
});

it("replacement history follows rename and publishes only at the current path", async () => {
	const original = stroke("original"), r = await rig([original]);
	r.replace([original], [stroke("piece")]);
	const old = r.path;
	r.rename(); r.clear();
	const notifications: string[] = [];
	subscriptions.push(onInkChanged(p => notifications.push(p)));
	expect(r.run(undo)).toBe(true); boundary(r, ["original"]);
	expect(notifications).toEqual([r.path]);
	expect(inlineInk.strokes(old)).toEqual([]);
	r.clear(); expect(r.run(redo)).toBe(true); boundary(r, ["piece"]);
});

it.each(["delete", "declaim"])("%s retires replacement replay without saving or notifying", async lifecycle => {
	const original = stroke("original"), r = await rig([original]);
	r.replace([original], [stroke("piece")]);
	if (lifecycle === "delete") inlineInk.handleDelete(r.path); else inlineInk.handleDeclaimed(r.path);
	await inlineInk.ensureLoaded(r.path);
	r.clear();
	expect(r.run(undo)).toBe(true); expect(r.run(redo)).toBe(true);
	expect(ids(r.strokes())).toEqual(["original"]);
	expect(r.writes).toEqual([]); expect(r.observed).toEqual([]);
});

it("snap acceptance and history publish the final shape with two chronological undo steps", async () => {
	const freehand = stroke("freehand"), snapped = stroke("snapped", 30), r = await rig();
	r.add(freehand); r.clear();
	r.overlay.takeSnapOffer(r.path, freehand, snapped); boundary(r, ["snapped"]);
	expect(r.overlay.indexDirty).toBe(true);
	expect(r.overlay.updateExtent).toHaveBeenCalledWith(true);
	expect(r.published.map(op => op.type)).toEqual(["add", "replace"]);
	for (const [command, expected] of [[undo, ["freehand"]], [redo, ["snapped"]],
		[undo, ["freehand"]], [undo, []]] as Array<[StateCommand, string[]]>) {
		r.clear(); expect(r.run(command)).toBe(true); boundary(r, expected);
	}
	expect(r.run(undo)).toBe(false);
});

it("a stale snap offer leaves ink, history and all publication hooks untouched", async () => {
	const r = await rig([stroke("unrelated")]);
	r.overlay.takeSnapOffer(r.path, stroke("gone"), stroke("snap"));
	expect(ids(r.strokes())).toEqual(["unrelated"]);
	expect(r.observed).toEqual([]); expect(r.writes).toEqual([]); expect(r.published).toEqual([]);
	expect(r.run(undo)).toBe(false);
	expect(r.overlay.indexDirty).toBe(false);
	expect(r.overlay.scheduleRepaint).not.toHaveBeenCalled();
	expect(r.overlay.updateExtent).not.toHaveBeenCalled();
});

it.each(["pending", "memory", "locked"] as const)("replacement retains the %s persistence contract", async mode => {
	const original = stroke("original"), r = await rig([original], mode);
	r.overlay.applyInkOp({ type: "replace", path: r.path, removed: [original], removedAt: [0],
		inserted: [stroke("piece")], insertedAt: [0] });
	expect(r.writes).toEqual([]);
	expect(r.observed).toEqual([{ path: r.path, ids: ["piece"], payloadIds: null }]);
	if (mode === "pending") { await r.finishClaim(); expect(r.writes).toHaveLength(1);
		expect(ids(parsePage(r.writes[0]!.payload, r.pageId).data.strokes)).toEqual(["piece"]); }
});

it("silent live mutation retains local deletions and insertions across a pending reload", async () => {
	const original = stroke("original"), unrelated = stroke("unrelated"), r = await rig([original, unrelated]);
	const finish = r.beginReload();
	expect(inlineInk.takeLive(r.path, ["original"])).toEqual([{ stroke: original, index: 0 }]);
	const piece = stroke("piece");
	inlineInk.applyAddLive(r.path, [piece, piece], [0, 0]);
	expect(r.observed).toEqual([]); expect(r.writes).toEqual([]);
	inlineInk.save(r.path);
	expect(r.writes).toEqual([]);
	expect(r.observed).toEqual([{ path: r.path, ids: ["piece"], payloadIds: null }]);
	await finish();
	expect(ids(r.strokes())).toEqual(["unrelated", "piece"]);
	expect(r.writes).toHaveLength(1);
	expect(ids(parsePage(r.writes[0]!.payload, r.pageId).data.strokes)).toEqual(["unrelated", "piece"]);
});

it("replacement replay during loading schedules only after the complete merge", async () => {
	const original = stroke("original"), r = await rig([original, stroke("unrelated")]);
	const finish = r.beginReload();
	r.overlay.applyInkOp({ type: "replace", path: r.path, removed: [original], removedAt: [0],
		inserted: [stroke("piece")], insertedAt: [0] });
	expect(r.writes).toEqual([]); expect(r.observed).toHaveLength(1);
	await finish();
	expect(r.writes).toHaveLength(1);
	expect(ids(parsePage(r.writes[0]!.payload, r.pageId).data.strokes)).toEqual(["unrelated", "piece"]);
});
