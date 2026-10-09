/**
 * An undo the editor takes while the ink overlay is not mounted must still reach the ink.
 *
 * Route (the editor's tab moved to another split): Obsidian detaches the editor's DOM and attaches it under another
 * container. While the editor is outside a Markdown source view the overlay does not own it: the next update unmounts
 * the overlay and returns (updateInner, "Retire a surface that lost its root"). When the root comes back, the first
 * update mounts the overlay again and returns. An undo or redo is a CodeMirror transaction like any other: if it is
 * the transaction of either of those updates, CodeMirror takes the step off its history, and the ink op it carries
 * must still be applied to the store, or the history and the ink disagree for good.
 *
 * Two arms, each over two drawn strokes (two history steps), through the editor's own undo command:
 *   ARM 1, undo while unmounted: the editor's root is lost, one update with no transaction unmounts the overlay, then
 *          undo. The store must lose the second stroke on that update and still lack it after one more update with no
 *          transaction (lost, not deferred). Redo, once the root is back and the overlay mounted, brings it back.
 *   ARM 2, undo as the first update after the root returns: the root is lost and the overlay unmounted as above, the
 *          root comes back with no update, then undo. Same reads.
 * Control: the same undo and redo with the overlay mounted throughout.
 *
 * The real updateInner, applyInkOp, CodeMirror history and store; host I/O in memory as in RedoTwoPanes.test.ts. The
 * overlay is built off the prototype; mount() and unmount() are shadowed to set and clear the container only, since
 * their canvas work is not what is under test and the early returns around them are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction, type StateCommand, type TransactionSpec } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { inkHistorySupport } from "./InkHistory";
import type { InlineInkHost } from "./InlineInkStore";
import { SelectionModel } from "../objects/SelectionModel";
import { emptyPage, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const PATH = "undo-while-unmounted.md";
const PAGE = "undo-while-unmounted-id";

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

/**
 * The editor's DOM as ownsMarkdownEditorRoot reads it: inside a Markdown source view while attached, under a plain
 * container (another split, mid-move) while not.
 */
function editorDom() {
	const doc = {};
	let attached = true;
	const sourceView = { ownerDocument: doc, querySelector: (sel: string) => (sel === ".cm-editor" ? dom : null) };
	const dom: Record<string, unknown> = {
		ownerDocument: doc,
		parentElement: { closest: () => null },
		closest: (sel: string) => (sel === ".markdown-source-view" && attached ? sourceView : null),
	};
	return { dom, attach: (on: boolean) => { attached = on; } };
}

/** One editor with its history and an overlay whose every update runs the real updateInner. */
function editor() {
	const { dom, attach } = editorDom();
	let state = EditorState.create({ doc: "note", extensions: [history(), inkHistorySupport()] });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	const view = {
		dom,
		get state() { return state; },
		dispatch: (input: Transaction | TransactionSpec) => {
			const tr = input instanceof Transaction ? input : state.update(input);
			const startState = state;
			state = tr.state;
			update([tr], startState);
		},
	};
	const update = (transactions: readonly Transaction[], startState = state) => overlay.update({
		view, state, startState, transactions, docChanged: transactions.some(t => t.docChanged),
		geometryChanged: false, viewportChanged: false,
	} as unknown as ViewUpdate);
	Object.assign(overlay, {
		view, container: {} as object | null, panAnchorHold: null, lastPath: PATH, lastFile: null, destroyed: false,
		filePath: () => PATH, currentFile: () => null, selection: new SelectionModel(),
		scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {},
		mount() { if (!this.container) this.container = {}; },
		unmount() { this.container = null; },
	});
	return {
		overlay, attach,
		/** One update with no transaction: what a reparent, a resize or a focus change brings. */
		quiet: () => update([]),
		run: (c: StateCommand) => c({ state, dispatch: view.dispatch }),
		draw(s: InkStroke) {
			inlineInk.commit(PATH, s);
			overlay.dispatchInk({ type: "add", path: PATH, strokes: [s] });
		},
	};
}

const ids = () => inlineInk.strokes(PATH).map((s) => s.id);

describe("an undo taken while the ink overlay is unmounted reaches the ink", () => {
	it("control: mounted throughout, undo takes the second stroke and redo brings it back", () => {
		const e = editor();
		e.draw(stroke("S1")); e.draw(stroke("S2"));
		expect(ids(), "premise: two strokes drawn").toEqual(["S1", "S2"]);
		expect(e.run(undo)).toBe(true);
		expect(ids(), "mounted undo").toEqual(["S1"]);
		expect(e.run(redo)).toBe(true);
		expect(ids(), "mounted redo").toEqual(["S1", "S2"]);
	});

	it("arm 1: undo while the editor's root is lost and the overlay unmounted", () => {
		const e = editor();
		e.draw(stroke("S1")); e.draw(stroke("S2"));
		e.attach(false);
		e.quiet();
		expect(e.overlay.container, "premise: the overlay unmounted when its root was lost").toBeNull();
		expect(e.run(undo), "the editor took the undo off its history").toBe(true);
		expect(ids(), "UNDO WHILE UNMOUNTED: the store after the undo's own update").toEqual(["S1"]);
		e.quiet();
		expect(ids(), "UNDO WHILE UNMOUNTED: the store one quiet update later (lost, not deferred)").toEqual(["S1"]);
		e.attach(true);
		e.quiet();
		expect(e.overlay.container, "premise: the overlay mounted again when its root came back").not.toBeNull();
		expect(e.run(redo)).toBe(true);
		expect(ids(), "redo after the root came back").toEqual(["S1", "S2"]);
	});

	it("arm 2: undo as the first update after the editor's root comes back", () => {
		const e = editor();
		e.draw(stroke("S1")); e.draw(stroke("S2"));
		e.attach(false);
		e.quiet();
		expect(e.overlay.container, "premise: the overlay unmounted when its root was lost").toBeNull();
		e.attach(true);
		expect(e.run(undo), "the editor took the undo off its history").toBe(true);
		expect(e.overlay.container, "premise: the undo's update mounted the overlay").not.toBeNull();
		expect(ids(), "UNDO ON REMOUNT: the store after the undo's own update").toEqual(["S1"]);
		e.quiet();
		expect(ids(), "UNDO ON REMOUNT: the store one quiet update later (lost, not deferred)").toEqual(["S1"]);
		expect(e.run(redo)).toBe(true);
		expect(ids(), "redo after the remount").toEqual(["S1", "S2"]);
	});
});
