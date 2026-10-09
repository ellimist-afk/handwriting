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
	return { id, tool: "pen", color: "#000000", width: 2, createdAt: 0,
		points: [{ x, y: 0, pressure: 0.5, t: 0 }, { x: x + 10, y: 10, pressure: 0.5, t: 8 }],
		bbox: { x, y: 0, width: 10, height: 10 } };
}
const ids = (s: readonly InkStroke[]) => s.map((x) => x.id);
const inlinePage = (id: string, strokes: InkStroke[]): PageData => {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = strokes;
	return p;
};

/** Production store, overlay replay and CodeMirror history; host I/O is in memory. */
async function rig() {
	const path = `redo-after-sync-${++serial}.md`;
	paths.add(path);
	const pageId = `redo-after-sync-id-${serial}`;
	let incoming: PageData | null = null;
	inlineInk.attachHost({
		readPageId: (p) => (p === path ? pageId : null),
		claimId: async () => ({ pageId }),
		loadSidecar: async (): Promise<ParseResult> => ({ data: inlinePage(pageId, []), recovered: false }),
		scheduleSidecar() {},
		// The sync poll's preserving adoption (main.ts live-reload poll).
		prepareExternalAdoption: async () => ({ kind: "prepared", prepared: {
			pageId, data: incoming!, reused: false, mtime: 1, stamp: "s" } as never }),
		acceptExternalAdoption() {},
		notify() {},
	});
	await inlineInk.ensureLoaded(path);
	let state = EditorState.create({ doc: "note", extensions: [history(), inkHistorySupport()] });
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
		async otherDeviceWrote(strokes: InkStroke[]) {
			incoming = inlinePage(pageId, strokes);
			expect((await inlineInk.adoptExternal(path, () => true)).outcome).toBe("adopted");
		},
	};
}

it("redo after a sync adoption does not lay a stroke back over the pieces another device erased it into", async () => {
	const r = await rig();
	r.draw(stroke("S"));
	// The other device partially erased S: two surviving pieces, new ids.
	await r.otherDeviceWrote([stroke("piece-a", 0), stroke("piece-b", 6)]);
	expect(ids(r.strokes())).toEqual(["piece-a", "piece-b"]);
	expect(r.run(undo)).toBe(true); // S is not on the page; nothing changes
	expect(ids(r.strokes())).toEqual(["piece-a", "piece-b"]);
	expect(r.run(redo)).toBe(true); // must not resurrect S on top of its own pieces
	expect(ids(r.strokes())).toEqual(["piece-a", "piece-b"]);
});

it("redo still restores exactly what the undo removed", async () => {
	const r = await rig();
	r.draw(stroke("S"));
	r.run(undo);
	expect(ids(r.strokes())).toEqual([]);
	r.run(redo);
	expect(ids(r.strokes())).toEqual(["S"]);
});
