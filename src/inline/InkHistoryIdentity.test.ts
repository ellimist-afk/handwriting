import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction, type StateCommand, type TransactionSpec } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport, invertInkOp, type InkOp } from "./InkHistory";
import { InlineInkStore, type InlineInkHost } from "./InlineInkStore";
import { emptyPage, parsePage, serializePage, type PageData } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

let serial = 0;
const paths = new Set<string>();
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	// Each rig owns the singleton's host; memory mode deliberately has none.
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
});
afterEach(() => {
	for (const path of paths) inlineInk.handleDelete(path);
	paths.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function stroke(id: string): InkStroke {
	return { id, tool: "pen", color: "#000000", width: 2,
		points: [{ x: 0, y: 0, pressure: 0.5, t: 0 }, { x: 10, y: 10, pressure: 0.5, t: 8 }],
		bbox: { x: 0, y: 0, width: 10, height: 10 }, createdAt: 0 };
}
const ids = (strokes: readonly InkStroke[]) => strokes.map(s => s.id);
type Mode = "claimed" | "pending" | "rejected" | "memory";

/** Real store, CM history commands, and overlay publication/replay; only I/O and paint are fake. */
async function rig(mode: Mode = "claimed", initial: InkStroke[] = []) {
	let path = `history-identity-${++serial}.md`;
	paths.add(path);
	const pageId = `history-identity-id-${serial}`;
	const metadata = new Map<string, string>(mode === "claimed" ? [[path, pageId]] : []);
	const sidecars = new Map<string, PageData>();
	const saved = new Map<string, string>();
	const writes: string[] = [];
	const page = emptyPage(pageId);
	page.surface = "inline";
	page.strokes = initial;
	sidecars.set(pageId, page);
	let resolveClaim!: (value: { pageId: string }) => void;
	const claim = new Promise<{ pageId: string }>(resolve => { resolveClaim = resolve; });
	const host: InlineInkHost = {
		readPageId: p => metadata.get(p) ?? null,
		claimId: () => mode === "rejected" ? Promise.reject(new Error("claim rejected")) : claim,
		loadSidecar: async id => sidecars.has(id) ? { data: sidecars.get(id)!, recovered: false } : null,
		scheduleSidecar: (id, data) => { saved.set(id, serializePage(data)); writes.push(id); },
		notify() {},
	};
	if (mode !== "memory") inlineInk.attachHost(host);
	if (mode === "rejected") vi.spyOn(console, "error").mockImplementation(() => {});
	await inlineInk.ensureLoaded(path);
	if (mode === "memory") inlineInk.applyAddLive(path, initial);
	let state = EditorState.create({ doc: "text", extensions: [history(), inkHistorySupport()] });
	const published: InkOp[] = [];
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	Object.assign(overlay, { filePath: () => path, selection: { prune() {} },
		scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {} });
	const dispatch = (input: Transaction | TransactionSpec) => {
		const tr = input instanceof Transaction ? input : state.update(input);
		state = tr.state;
		for (const effect of tr.effects) {
			if (!effect.is(inkEffect)) continue;
			if (tr.annotation(inkApplied)) published.push(effect.value);
			else overlay.applyInkOp(effect.value);
		}
	};
	overlay.view = { get state() { return state; }, dispatch };
	return { overlay, published, saved, writes, pageId,
		get path() { return path; }, get text() { return state.doc.toString(); },
		strokes: () => inlineInk.strokes(path),
		add(s: InkStroke) {
			inlineInk.commit(path, s);
			overlay.dispatchInk({ type: "add", path, strokes: [s] });
		},
		type(text: string) { dispatch({ changes: { from: state.doc.length, insert: text } }); },
		run: (cmd: StateCommand) => cmd({ state, dispatch }),
		rename() {
			const next = `${path}.renamed.md`;
			paths.add(next);
			const id = metadata.get(path);
			metadata.delete(path);
			if (id) metadata.set(next, id);
			inlineInk.handleRename(path, next);
			path = next;
		},
		async finishClaim() {
			if (mode === "pending") { metadata.set(path, pageId); resolveClaim({ pageId }); }
			expect(await inlineInk.settle()).toBe(true);
		},
		async replacement(at: string, id: string, strokes: InkStroke[]) {
			paths.add(at);
			metadata.set(at, id);
			const replacement = emptyPage(id);
			replacement.surface = "inline";
			replacement.strokes = strokes;
			sidecars.set(id, replacement);
			await inlineInk.ensureLoaded(at);
			inlineInk.save(at);
		},
	};
}

describe("session history record identity", () => {
	it("capture is synchronous, unique by record, and performs no host I/O", () => {
		const store = new InlineInkStore();
		const host = { readPageId: vi.fn(), claimId: vi.fn(), loadSidecar: vi.fn(),
			scheduleSidecar: vi.fn(), notify: vi.fn() };
		store.attachHost(host);
		const identity = store.captureHistoryIdentity("a.md");
		expect(typeof identity).toBe("symbol");
		expect(store.captureHistoryIdentity("a.md")).toBe(identity);
		expect(store.captureHistoryIdentity("b.md")).not.toBe(identity);
		expect(store.pathForHistoryIdentity(identity)).toBe("a.md");
		expect(store.cacheStats()).toEqual({ notes: 2, strokes: 0, points: 0 });
		for (const call of Object.values(host)) expect(call).not.toHaveBeenCalled();
	});

	it("rename retains identity and deletion permanently invalidates it", () => {
		const store = new InlineInkStore();
		const identity = store.captureHistoryIdentity("a.md");
		store.handleRename("a.md", "b.md");
		store.handleRename("b.md", "c.md");
		expect(store.captureHistoryIdentity("c.md")).toBe(identity);
		expect(store.pathForHistoryIdentity(identity)).toBe("c.md");
		store.handleDelete("c.md");
		expect(store.captureHistoryIdentity("c.md")).not.toBe(identity);
		expect(store.pathForHistoryIdentity(identity)).toBeNull();
	});

	const variants: InkOp[] = [
		{ type: "add", path: "a.md", strokes: [stroke("s")], indices: [0] },
		{ type: "remove", path: "a.md", strokes: [stroke("s")], indices: [0] },
		{ type: "move", path: "a.md", strokeIds: ["s"], dx: 5, dy: 7 },
		{ type: "replace", path: "a.md", removed: [stroke("s")], removedAt: [0], inserted: [stroke("piece")], insertedAt: [0] },
	];
	it.each(variants)("$type preserves both identities through inverse and inverse-of-inverse", op => {
		const original = { ...op, historyIdentity: Symbol("note"), pageId: "durable-id" };
		const inverse = invertInkOp(original);
		expect(inverse.historyIdentity).toBe(original.historyIdentity);
		expect(inverse.pageId).toBe(original.pageId);
		expect(invertInkOp(inverse)).toEqual(original);
	});
});

describe("production overlay with CodeMirror history", () => {
	const cases = (["claimed", "pending", "rejected", "memory"] as const).flatMap(mode =>
		[0, 1, 3].map(renames => ({ mode, renames })));
	it.each(cases)("first stroke in $mode mode survives $renames renames with undo/redo", async ({ mode, renames }) => {
		const r = await rig(mode);
		r.add(stroke("first"));
		expect(typeof r.published[0]!.historyIdentity).toBe("symbol");
		expect(r.published[0]!.pageId).toBe(mode === "claimed" ? r.pageId : undefined);
		for (let i = 0; i < renames; i++) r.rename();
		expect(r.run(undo)).toBe(true);
		expect(ids(r.strokes())).toEqual([]);
		await r.finishClaim();
		if (mode === "claimed" || mode === "pending") {
			expect(ids(parsePage(r.saved.get(r.pageId)!, r.pageId).data.strokes)).toEqual([]);
		}
		expect(r.run(redo)).toBe(true);
		expect(ids(r.strokes())).toEqual(["first"]);
		await r.finishClaim();
		if (mode === "claimed" || mode === "pending") {
			const serialized = r.saved.get(r.pageId)!;
			expect(ids(parsePage(serialized, r.pageId).data.strokes)).toEqual(["first"]);
			expect(serialized).not.toContain("historyIdentity");
		} else expect(r.saved.size).toBe(0);
	});

	it.each([0, 1, 3])("first-stroke history still resolves after claim completion and %s renames", async renames => {
		const r = await rig("pending");
		r.add(stroke("first"));
		await r.finishClaim();
		for (let i = 0; i < renames; i++) r.rename();
		expect(r.run(undo)).toBe(true);
		expect(ids(r.strokes())).toEqual([]);
		expect(r.run(redo)).toBe(true);
		expect(ids(r.strokes())).toEqual(["first"]);
	});

	it("reusing the old path cannot receive a first-stroke redo in memory or serialized saves", async () => {
		const r = await rig("pending");
		const old = r.path;
		r.add(stroke("first"));
		r.rename();
		await r.finishClaim();
		await r.replacement(old, "unrelated-id", [stroke("unrelated")]);
		const savedBefore = r.saved.get("unrelated-id");
		const writesBefore = r.writes.filter(id => id === "unrelated-id").length;
		expect(r.run(undo)).toBe(true);
		expect(ids(r.strokes())).toEqual([]);
		expect(r.run(redo)).toBe(true);
		expect(ids(r.strokes())).toEqual(["first"]);
		expect(ids(inlineInk.strokes(old))).toEqual(["unrelated"]);
		expect(r.saved.get("unrelated-id")).toBe(savedBefore);
		expect(r.writes.filter(id => id === "unrelated-id")).toHaveLength(writesBefore);
	});

	it.each(["delete", "declaim"] as const)("%s invalidates history even when the path and durable id are reused", async lifecycle => {
		const r = await rig();
		r.add(stroke("same-stroke-id"));
		const identity = r.published[0]!.historyIdentity!;
		if (lifecycle === "delete") inlineInk.handleDelete(r.path);
		else inlineInk.handleDeclaimed(r.path);
		await r.replacement(r.path, r.pageId, [stroke("same-stroke-id"), stroke("replacement")]);
		expect(inlineInk.pathForHistoryIdentity(identity)).toBeNull();
		const savedBefore = r.saved.get(r.pageId);
		const writesBefore = r.writes.length;
		expect(r.run(undo)).toBe(true);
		expect(r.run(redo)).toBe(true);
		expect(ids(r.strokes())).toEqual(["same-stroke-id", "replacement"]);
		expect(r.saved.get(r.pageId)).toBe(savedBefore);
		expect(r.writes).toHaveLength(writesBefore);
	});

	it("duplicate reassignment keeps the copy's history away from the original owner", async () => {
		const r = await rig();
		r.add(stroke("shared-stroke"));
		const token = r.published[0]!.historyIdentity;
		const ownerPath = `owner-${serial}.md`;
		await r.replacement(ownerPath, r.pageId, [stroke("shared-stroke"), stroke("owner")]);
		expect(inlineInk.reassignPage(r.path, "copy-new-id", ownerPath)).toBe("rescheduled-owner");
		expect(inlineInk.captureHistoryIdentity(r.path)).toBe(token);
		const ownerBefore = r.saved.get(r.pageId);
		r.rename();
		expect(r.run(undo)).toBe(true);
		expect(ids(r.strokes())).toEqual([]);
		expect(r.run(redo)).toBe(true);
		expect(ids(r.strokes())).toEqual(["shared-stroke"]);
		expect(ids(inlineInk.strokes(ownerPath))).toEqual(["shared-stroke", "owner"]);
		expect(r.saved.get(r.pageId)).toBe(ownerBefore);
		expect(ids(parsePage(r.saved.get("copy-new-id")!, "copy-new-id").data.strokes)).toEqual(["shared-stroke"]);
	});

	it.each(["claimed", "memory"] as const)("insert-space in %s mode is one text-and-ink event across rename", async mode => {
		const r = await rig(mode, [stroke("s")]);
		inlineInk.moveStrokes(r.path, ["s"], 0, 20);
		Object.assign(r.overlay, { spaceTotalDy: 20, spaceIds: ["s"], spacePlan: { y:0,from:0,lineHeight:20 },
			spaceTextChange: () => ({ dy: 20, changes: { from: 0, insert: "\n" } }) });
		r.overlay.spaceUp();
		expect(typeof r.published[0]!.historyIdentity).toBe("symbol");
		expect(r.published[0]!.pageId).toBe(mode === "claimed" ? r.pageId : undefined);
		r.rename();
		expect(r.text).toBe("\ntext");
		expect(r.run(undo)).toBe(true);
		expect(r.text).toBe("text");
		expect(r.strokes()[0]!.points[0]!.y).toBe(0);
		expect(r.run(undo)).toBe(false);
		expect(r.run(redo)).toBe(true);
		expect(r.text).toBe("\ntext");
		expect(r.strokes()[0]!.points[0]!.y).toBe(20);
		expect(r.run(redo)).toBe(false);
	});

	it("separate gestures and intervening text retain chronological undo/redo after rename", async () => {
		const r = await rig("pending");
		r.add(stroke("one"));
		r.type(" edit");
		r.add(stroke("two"));
		r.rename();
		await r.finishClaim();
		expect(r.run(undo)).toBe(true);
		expect(ids(r.strokes())).toEqual(["one"]);
		expect(r.text).toBe("text edit");
		expect(r.run(undo)).toBe(true);
		expect(r.text).toBe("text");
		expect(ids(r.strokes())).toEqual(["one"]);
		expect(r.run(undo)).toBe(true);
		expect(ids(r.strokes())).toEqual([]);
		expect(r.run(undo)).toBe(false);
		for (let i = 0; i < 3; i++) expect(r.run(redo)).toBe(true);
		expect(ids(r.strokes())).toEqual(["one", "two"]);
		expect(r.text).toBe("text edit");
	});

	it("supplied identities survive stamping and legacy page-id/path replay remains available", async () => {
		const r = await rig();
		const supplied = Symbol("supplied");
		r.overlay.dispatchInk({ type: "move", path: r.path, strokeIds: [], dx: 1, dy: 1,
			historyIdentity: supplied, pageId: "supplied-id" });
		expect(r.published[0]).toMatchObject({ historyIdentity: supplied, pageId: "supplied-id" });
		const old = r.path;
		r.rename();
		r.overlay.applyInkOp({ type: "add", path: old, pageId: r.pageId, strokes: [stroke("legacy-id")] });
		r.overlay.applyInkOp({ type: "add", path: r.path, strokes: [stroke("legacy-path")] });
		expect(ids(r.strokes())).toEqual(["legacy-id", "legacy-path"]);
		// An unknown supplied token and an unknown durable id each fail closed.
		r.overlay.applyInkOp({ type: "add", path: r.path, pageId: r.pageId,
			historyIdentity: supplied, strokes: [stroke("wrong-token")] });
		r.overlay.applyInkOp({ type: "add", path: r.path, pageId: "missing", strokes: [stroke("wrong-id")] });
		expect(ids(r.strokes())).toEqual(["legacy-id", "legacy-path"]);
	});
});
