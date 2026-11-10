/**
 * A typed text edit lets go of the ink selection, so a Backspace after it is the text's.
 *
 * What it looks like: you tap a word to put the cursor there, but an underline attached to that word is within reach, so
 * the tap selects the ink group and the cursor stays where it was. You type a letter, which lands at the old cursor, and
 * press Backspace to fix it. Before: the Backspace deleted the whole ink group and the letter stayed. Now: typing lets go
 * of the ink, so the Backspace takes the letter back and the ink is untouched.
 *
 * Rule: an editor transaction that changes the text with user event input.type, input.paste or delete (each with its
 * sub-events, such as input.type.compose or delete.backward) clears the ink selection. A text change with no such user
 * event (another pane, a sync, a command) and a cursor move keep it.
 *
 * The real updateInner, the real overlay key handler (handleKeyDown, the selection's Delete and Backspace keys, the
 * delete), CodeMirror's own history and Backspace command, and the real store; host I/O in memory as in
 * UndoWhileUnmounted.test.ts. The overlay is built off the prototype. Its selectionDeleteKeys is the class field's
 * wiring, written out because Object.create runs no field initialisers (InkOverlay.ts, `selectionDeleteKeys`). The
 * group is selected as the finger tap selects it (AttachFingerSelect.test.ts covers the tap itself).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, Transaction, type StateCommand, type TransactionSpec } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { deleteCharBackward, history, undo } from "@codemirror/commands";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { inkHistorySupport } from "./InkHistory";
import { InlineSelectionDeleteKeys } from "./InlineSelectionDelete";
import type { InlineInkHost } from "./InlineInkStore";
import { SelectionModel } from "../objects/SelectionModel";
import { emptyPage, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const PATH = "typed-edit-drops-selection.md";
const PAGE = "typed-edit-drops-selection-id";
const DOC = "first line\nthe chemist wrote benzene here\nlast line";
const WORD = DOC.indexOf("benzene");
/** Where the cursor was before the tap: the end of the first line. The tap did not move it. */
const CURSOR = DOC.indexOf("\n");

function stroke(id: string, y: number): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2, createdAt: 0,
		points: [{ x: 0, y, pressure: 0.5, t: 0 }, { x: 60, y, pressure: 0.5, t: 8 }],
		bbox: { x: 0, y, width: 60, height: 1 },
	};
}

beforeEach(async () => {
	vi.stubGlobal("window", globalThis);
	inlineInk.attachHost({
		readPageId: (p) => (p === PATH ? PAGE : null),
		claimId: async () => ({ pageId: PAGE }),
		loadSidecar: async (): Promise<ParseResult> => {
			const page = emptyPage(PAGE);
			page.surface = "inline";
			const group: AttachmentRecord = {
				v: 1, id: "g1", strokeIds: ["u1", "u2"], target: targetAt(DOC, WORD, WORD + 7, "range"),
				ref: { x: 0, y: 30 }, layout: { width: 600, font: 16 }, probe: { id: "u1", x: 1, y: 40 },
			};
			page.attachments = [group];
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

/** The editor's DOM as ownsMarkdownEditorRoot reads it: inside a Markdown source view. */
function editorDom() {
	const doc = {};
	const sourceView = { ownerDocument: doc, querySelector: (sel: string) => (sel === ".cm-editor" ? dom : null) };
	const dom: Record<string, unknown> = {
		ownerDocument: doc,
		parentElement: { closest: () => null },
		closest: (sel: string) => (sel === ".markdown-source-view" ? sourceView : null),
		contains: () => true,
	};
	return dom;
}

/** One editor with its history and an overlay whose every update runs the real updateInner. */
function editor() {
	const dom = editorDom();
	let state = EditorState.create({ doc: DOC, selection: EditorSelection.cursor(CURSOR), extensions: [history(), inkHistorySupport()] });
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
		geometryChanged: false, viewportChanged: false, heightChanged: false,
	} as unknown as ViewUpdate);
	const selection = new SelectionModel();
	Object.assign(overlay, {
		view, container: {} as object | null, panAnchorHold: null, bouncedHold: null, lastPath: PATH, lastFile: null, destroyed: false,
		filePath: () => PATH, currentFile: () => null, selection,
		selectionDeleteKeys: new InlineSelectionDeleteKeys(() => !selection.isEmpty, () => overlay.deleteSelectedInk()),
		dragTotal: null, attachPickOpen: () => false,
		scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {}, refreshStrip() {}, clearSpaceFeedback() {},
		// The line anchors and the follow are not under test; the text edit's own work there is.
		updateLineAnchors() {},
		mount() { if (!this.container) this.container = {}; },
		unmount() { this.container = null; },
	});
	const key = (k: string) => {
		let prevented = false;
		const ev = { key: k, repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, target: null, preventDefault: () => void (prevented = true) };
		const taken = overlay.handleKeyDown(ev) === true;
		return { taken, prevented };
	};
	return {
		overlay, selection,
		run: (c: StateCommand) => c({ state, dispatch: view.dispatch }),
		dispatch: (spec: TransactionSpec) => view.dispatch(spec),
		/** A letter typed at the cursor, as the editor's input handling dispatches it. */
		type(text: string, userEvent = "input.type") {
			const at = state.selection.main.head;
			view.dispatch({ changes: { from: at, insert: text }, selection: EditorSelection.cursor(at + text.length), userEvent });
		},
		/** Backspace: the overlay's key handler first, then the editor's own command if the key is not taken. */
		backspace() {
			const k = key("Backspace");
			// CodeMirror's Backspace command takes a view; over one cursor and plain text it reads only state and dispatch.
			if (!k.taken) deleteCharBackward({ state, dispatch: view.dispatch } as unknown as Parameters<typeof deleteCharBackward>[0]);
			return k;
		},
		doc: () => state.doc.toString(),
		draw(s: InkStroke) {
			inlineInk.commit(PATH, s);
			overlay.dispatchInk({ type: "add", path: PATH, strokes: [s] });
		},
	};
}

const ids = () => inlineInk.strokes(PATH).map((s) => s.id);
const selected = (e: ReturnType<typeof editor>) => [...e.selection.strokeIds].sort();

/** The note with the attached group drawn (two strokes) and selected, as a finger tap on its underline leaves it. */
function tapped() {
	const e = editor();
	e.draw(stroke("u1", 40)); e.draw(stroke("u2", 44));
	e.selection.selectExactly(["u1", "u2"]);
	expect([ids(), selected(e), inlineInk.attachments(PATH).map((a) => a.id)], "premise: the group drawn, attached and selected").toEqual([["u1", "u2"], ["u1", "u2"], ["g1"]]);
	return e;
}

describe("a typed text edit lets go of the ink selection", () => {
	it("tap on attached ink, type a letter, Backspace: the letter goes, the ink stays", () => {
		const e = tapped();
		e.type("a");
		expect(e.doc(), "premise: the letter landed at the old cursor").toBe(DOC.slice(0, CURSOR) + "a" + DOC.slice(CURSOR));
		const afterTyping = selected(e);
		const k = e.backspace();
		expect([afterTyping, k.taken, ids(), e.doc()], "[selected after typing, Backspace taken by the ink, strokes, text]").toEqual([[], false, ["u1", "u2"], DOC]);
	});

	it("a phone keyboard's composed letter (input.type.compose) lets go of the ink too", () => {
		const e = tapped();
		e.type("a", "input.type.compose");
		expect(selected(e), "composing let go of the ink").toEqual([]);
	});

	it("a text paste lets go of the ink", () => {
		const e = tapped();
		e.type("pasted words", "input.paste");
		expect(selected(e), "the paste let go of the ink").toEqual([]);
	});

	it("a text delete (delete.forward, delete.cut) lets go of the ink", () => {
		const got = ["delete.forward", "delete.cut"].map((userEvent) => {
			const e = tapped();
			e.dispatch({ changes: { from: CURSOR, to: CURSOR + 1 }, userEvent });
			const out = [userEvent, selected(e)];
			inlineInk.applyRemove(PATH, ["u1", "u2"]);
			return out;
		});
		expect(got, "[user event, selected]").toEqual([["delete.forward", []], ["delete.cut", []]]);
	});

	it("CONTROL: a text change with no user event (another pane, a sync, a command) keeps the selection", () => {
		const e = tapped();
		e.dispatch({ changes: { from: 0, insert: "x" } });
		expect(selected(e)).toEqual(["u1", "u2"]);
	});

	it("CONTROL: a cursor move (user event select) keeps the selection", () => {
		const e = tapped();
		e.dispatch({ selection: EditorSelection.cursor(0), userEvent: "select" });
		expect(selected(e)).toEqual(["u1", "u2"]);
	});

	it("CONTROL: with no typing, Backspace deletes the group, and one undo brings both strokes back", () => {
		const e = tapped();
		const k = e.backspace();
		expect([k.taken, k.prevented, ids(), e.doc()], "[taken, prevented, strokes, text]: the delete is the ink's").toEqual([true, true, [], DOC]);
		e.overlay.handleKeyUp({ key: "Backspace", preventDefault() {} });
		expect(e.run(undo), "the editor took one undo off its history").toBe(true);
		expect([ids(), e.doc()], "[strokes, text] after one undo").toEqual([["u1", "u2"], DOC]);
	});
});
