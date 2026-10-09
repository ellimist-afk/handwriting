/**
 * An undo of our partial erase after another device split one of its pieces. The erase was a replace (S out, its
 * pieces p1 and p2 in); the other device erased part of p1 into p1a and p1b, and the sync poll adopted that file.
 * The undo is the inverse replace (p1 and p2 out, S in). p1 is no longer there, so it applies whole or not at all:
 * nothing changes. Before, it took p2 out (loss) and laid S over p1a and p1b (duplicate ink).
 *
 * The real store, applyInkOp and CodeMirror history; host I/O in memory, with the sync poll's preserving adoption
 * (adoptExternal), as in RedoAfterSyncAdoption.test.ts.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState, Transaction, type StateCommand, type TransactionSpec } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport } from "./InkHistory";
import type { InlineInkHost } from "./InlineInkStore";
import { SelectionModel } from "../objects/SelectionModel";
import { emptyPage, type PageData, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

let serial = 0;
const paths = new Set<string>();
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
});
afterEach(() => {
	for (const p of paths) inlineInk.handleDelete(p);
	paths.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.unstubAllGlobals();
});

function stroke(id: string, x = 0): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2, createdAt: 0,
		points: [{ x, y: 0, pressure: 0.5, t: 0 }, { x: x + 10, y: 10, pressure: 0.5, t: 8 }],
		bbox: { x, y: 0, width: 10, height: 10 },
	};
}
const ids = (s: readonly InkStroke[]) => s.map((x) => x.id);
const inlinePage = (id: string, strokes: InkStroke[]): PageData => {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = strokes;
	return p;
};

async function rig() {
	const path = `replace-whole-${++serial}.md`;
	paths.add(path);
	const pageId = `replace-whole-id-${serial}`;
	let incoming: PageData | null = null;
	inlineInk.attachHost({
		readPageId: (p) => (p === path ? pageId : null),
		claimId: async () => ({ pageId }),
		loadSidecar: async (): Promise<ParseResult> => ({ data: inlinePage(pageId, []), recovered: false }),
		scheduleSidecar() {},
		prepareExternalAdoption: async () => ({ kind: "prepared", prepared: {
			pageId, data: incoming!, reused: false, mtime: 1, stamp: "s" } as never }),
		acceptExternalAdoption() {},
		notify() {},
	});
	await inlineInk.ensureLoaded(path);
	let state = EditorState.create({ doc: "note", extensions: [history(), inkHistorySupport()] });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	Object.assign(overlay, { filePath: () => path, selection: new SelectionModel(),
		scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {} });
	const dispatch = (input: Transaction | TransactionSpec) => {
		const tr = input instanceof Transaction ? input : state.update(input);
		state = tr.state;
		for (const e of tr.effects) if (e.is(inkEffect) && !tr.annotation(inkApplied)) overlay.applyInkOp(e.value);
	};
	overlay.view = { get state() { return state; }, dispatch };
	return {
		strokes: () => inlineInk.strokes(path),
		run: (c: StateCommand) => c({ state, dispatch }),
		draw(s: InkStroke) { inlineInk.commit(path, s); overlay.dispatchInk({ type: "add", path, strokes: [s] }); },
		/** Our partial erase, as the eraser's lift records it: S out, its pieces in at S's place. */
		partialErase(s: InkStroke, pieces: InkStroke[]) {
			inlineInk.takeLive(path, [s.id]);
			inlineInk.applyAddLive(path, pieces, pieces.map((_, i) => i));
			inlineInk.save(path);
			overlay.dispatchInk({ type: "replace", path, removed: [s], removedAt: [0], inserted: pieces,
				insertedAt: pieces.map((_, i) => i) });
		},
		async otherDeviceWrote(strokes: InkStroke[]) {
			incoming = inlinePage(pageId, strokes);
			expect((await inlineInk.adoptExternal(path, () => true)).outcome).toBe("adopted");
		},
	};
}

it("an undo of a partial erase after another device split one of its pieces changes nothing", async () => {
	const r = await rig();
	r.draw(stroke("S"));
	r.partialErase(stroke("S"), [stroke("p1", 0), stroke("p2", 6)]);
	expect(ids(r.strokes()), "precondition: our erase left two pieces").toEqual(["p1", "p2"]);
	await r.otherDeviceWrote([stroke("p1a", 0), stroke("p1b", 3), stroke("p2", 6)]);
	expect(ids(r.strokes()), "precondition: the other device split p1").toEqual(["p1a", "p1b", "p2"]);

	expect(r.run(undo)).toBe(true);
	expect(ids(r.strokes()), "no S over the pieces, and p2 kept").toEqual(["p1a", "p1b", "p2"]);
	expect(r.run(redo)).toBe(true);
	expect(ids(r.strokes()), "the redo changes nothing either").toEqual(["p1a", "p1b", "p2"]);
});

it("control: the undo and redo of a partial erase still round-trip", async () => {
	const r = await rig();
	r.draw(stroke("S"));
	r.partialErase(stroke("S"), [stroke("p1", 0), stroke("p2", 6)]);
	expect(r.run(undo)).toBe(true);
	expect(ids(r.strokes())).toEqual(["S"]);
	expect(r.run(redo)).toBe(true);
	expect(ids(r.strokes())).toEqual(["p1", "p2"]);
});
