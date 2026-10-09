/**
 * Two panes on one note, each with its own editor history. Pane A draws S; pane B deletes S (B's own history step).
 * A's undo of the draw finds nothing to take: S is already gone. A's redo must then put back nothing; it used to
 * re-add every stroke the op captured, so S came back after the user in the other pane had removed it.
 *
 * The real applyInkOp and CodeMirror history in both panes, over the real store; host I/O in memory, as in
 * RedoAfterSyncAdoption.test.ts.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState, Transaction, type StateCommand, type TransactionSpec } from "@codemirror/state";
import { history, redo, undo } from "@codemirror/commands";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport } from "./InkHistory";
import type { InlineInkHost } from "./InlineInkStore";
import { SelectionModel } from "../objects/SelectionModel";
import { emptyPage, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const PATH = "redo-two-panes.md";
const PAGE = "redo-two-panes-id";

beforeEach(async () => {
	vi.stubGlobal("window", globalThis);
	inlineInk.attachHost({
		readPageId: (p) => (p === PATH ? PAGE : null),
		claimId: async () => ({ pageId: PAGE }),
		loadSidecar: async (): Promise<ParseResult> => {
			const page = emptyPage(PAGE);
			page.surface = "inline";
			return { data: page, recovered: false };
		},
		scheduleSidecar() {},
		notify() {},
	});
	await inlineInk.ensureLoaded(PATH);
});
afterEach(() => {
	inlineInk.handleDelete(PATH);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.unstubAllGlobals();
});

function stroke(id: string): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2, createdAt: 0,
		points: [{ x: 0, y: 0, pressure: 0.5, t: 0 }, { x: 10, y: 10, pressure: 0.5, t: 8 }],
		bbox: { x: 0, y: 0, width: 10, height: 10 },
	};
}

/** One pane: an overlay with its own editor state and history, replaying ink ops through the real applyInkOp. */
function pane() {
	let state = EditorState.create({ doc: "note", extensions: [history(), inkHistorySupport()] });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	Object.assign(overlay, {
		filePath: () => PATH, selection: new SelectionModel(),
		scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {},
	});
	const dispatch = (input: Transaction | TransactionSpec) => {
		const tr = input instanceof Transaction ? input : state.update(input);
		state = tr.state;
		for (const e of tr.effects) if (e.is(inkEffect) && !tr.annotation(inkApplied)) overlay.applyInkOp(e.value);
	};
	overlay.view = { get state() { return state; }, dispatch };
	return {
		run: (c: StateCommand) => c({ state, dispatch }),
		draw(s: InkStroke) {
			inlineInk.commit(PATH, s);
			overlay.dispatchInk({ type: "add", path: PATH, strokes: [s] });
		},
		delete(s: InkStroke) {
			inlineInk.applyRemove(PATH, [s.id]);
			overlay.dispatchInk({ type: "remove", path: PATH, strokes: [s] });
		},
	};
}

const ids = () => inlineInk.strokes(PATH).map((s) => s.id);

it("a redo in one pane does not bring back a stroke the other pane deleted", () => {
	const a = pane(), b = pane();
	const s = stroke("S");
	a.draw(s);
	b.delete(s);
	expect(ids(), "precondition: pane B deleted S").toEqual([]);
	expect(a.run(undo)).toBe(true); // S is not on the page; nothing to take
	expect(ids()).toEqual([]);
	expect(a.run(redo)).toBe(true);
	expect(ids(), "pane A's redo brought back the stroke pane B deleted").toEqual([]);
	expect(b.run(undo)).toBe(true); // B's own undo still restores S, once
	expect(ids()).toEqual(["S"]);
});
