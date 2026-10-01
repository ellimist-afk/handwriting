/**
 * Probe for audit item 161 (finding id L-undo-7): undo after a plugin update
 * or re-enable jumps the caret and view to old ink spots.
 *
 * Claim: reloading main.js defines a new inkEffect type. The editor's history
 * keeps the entries the old module wrote through the reconfigure, and the
 * viewport-restore listener accepts only the current module's inkEffect. So
 * an undo that reaches ink drawn before the reload changes nothing on the page
 * but lets CodeMirror put the caret back where it was when that ink was drawn
 * and scroll to it. The audit's judge narrowed the defect to that caret and
 * view jump; the fix direction is a quiet no-op.
 *
 * Production code driven: the real src/inline/InkHistory.ts, loaded twice
 * across vi.resetModules() to model Obsidian re-running main.js, with the
 * history field outside the plugin's compartment as Obsidian's is. The only
 * stand-in is the EditorView handed to the real updateListener: it records
 * dispatches. The rig is the audit's own probe (L-undo-7), with the assertion
 * narrowed to the judged defect.
 *
 * Asserts the CORRECT behaviour: undoing pre-reload ink holds the caret where
 * the user left it and restores the viewport. Controls: ink drawn after the
 * reload does the same; an effect-only undo of some other extension's effect
 * is not taken over.
 */
import { describe, expect, it, vi } from "vitest";
import { Compartment, EditorSelection, EditorState, StateEffect, type Transaction } from "@codemirror/state";
import { history, invertedEffects, isolateHistory, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { InkStroke } from "../ink/Stroke";

type HistMod = typeof import("../inline/InkHistory");

async function loadPluginGeneration(): Promise<HistMod> {
	vi.resetModules();
	return await import("../inline/InkHistory");
}

function stroke(id: string): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x: 10, y: 10, pressure: 0.5, t: 0 },
			{ x: 20, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: 8, y: 8, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

const DOC = "x".repeat(3000);
const INK_CARET = 0;
const NOW_CARET = 2500;

/** Another extension's effect-only history entry. */
type Foreign = { type: string; path?: string; strokes?: unknown[] };
const foreign = StateEffect.define<Foreign>();
const foreignHistory = invertedEffects.of((tr) =>
	tr.effects.filter((e) => e.is(foreign)).map((e) => foreign.of((e as StateEffect<Foreign>).value))
);

async function run(draw: "before-reload" | "after-reload" | "foreign", foreignValue: Foreign = { type: "fold", path: "n.md" }) {
	const A = await loadPluginGeneration();
	const pluginSlot = new Compartment();
	let state = EditorState.create({
		doc: DOC,
		selection: EditorSelection.cursor(INK_CARET),
		extensions: [history(), foreignHistory, pluginSlot.of(A.inkHistorySupport())],
	});
	const drawWith = (gen: HistMod) => {
		const op = { type: "add" as const, path: "n.md", historyIdentity: Symbol("session"), strokes: [stroke("s1")] };
		state = state.update({
			effects: gen.inkEffect.of(op),
			annotations: [gen.inkApplied.of(true), isolateHistory.of("full")],
		}).state;
	};
	if (draw === "before-reload") drawWith(A);
	if (draw === "foreign") {
		state = state.update({ effects: foreign.of(foreignValue), annotations: isolateHistory.of("full") }).state;
	}
	const B = await loadPluginGeneration();
	state = state.update({ effects: pluginSlot.reconfigure(B.inkHistorySupport()) }).state;
	if (draw === "after-reload") drawWith(B);
	state = state.update({ selection: EditorSelection.cursor(NOW_CARET) }).state;

	let tr: Transaction | null = null;
	undo({ state, dispatch: (t: Transaction) => void (tr = t) });
	const undoTr = tr as unknown as Transaction;
	const dispatched: Array<{ selection?: EditorSelection }> = [];
	const view = {
		state: undoTr.state,
		dom: {},
		scrollDOM: { scrollLeft: 0, scrollTop: 0 },
		dispatch: (spec: { selection?: EditorSelection }) => void dispatched.push(spec),
		scrollSnapshot: () => ({ snapshot: true }),
	};
	for (const listener of undoTr.state.facet(EditorView.updateListener)) {
		listener({ transactions: [undoTr], state: undoTr.state, startState: state, view } as never);
	}
	return {
		newEffectType: A.inkEffect !== B.inkEffect,
		undoMovesCaretTo: undoTr.state.selection.main.head,
		viewportRestored: dispatched.length,
		caretAfter: dispatched[0]?.selection ? dispatched[0].selection.main.head : undoTr.state.selection.main.head,
	};
}

describe("audit 161 controls", () => {
	it("ink drawn after the reload: the undo holds the caret and restores the viewport", async () => {
		const r = await run("after-reload");
		expect(r).toEqual({ newEffectType: true, undoMovesCaretTo: INK_CARET, viewportRestored: 1, caretAfter: NOW_CARET });
	});

	it("another extension's effect-only undo is left to CodeMirror", async () => {
		const r = await run("foreign");
		expect([r.viewportRestored, r.caretAfter]).toEqual([0, INK_CARET]);
	});

	it("an effect shaped like an ink add but naming no note is not taken for ink", async () => {
		const r = await run("foreign", { type: "add", strokes: [] });
		expect([r.viewportRestored, r.caretAfter]).toEqual([0, INK_CARET]);
	});
});

describe("audit 161 probe: undo of ink drawn before a reload is a quiet no-op", () => {
	it("holds the caret where the user left it and restores the viewport", async () => {
		const r = await run("before-reload");
		expect(r.newEffectType).toBe(true);
		expect(r.undoMovesCaretTo).toBe(INK_CARET);
		expect({ viewportRestored: r.viewportRestored, caretAfter: r.caretAfter }).toEqual({ viewportRestored: 1, caretAfter: NOW_CARET });
	});
});
