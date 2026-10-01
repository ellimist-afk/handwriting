/**
 * Audit probe InkOverlay-1-1 (1.4.21 audit, tag 1a05f62c).
 *
 * Claim: with one note open in two panes, A built first and B second, running
 * "Delete all ink on this note" from B puts the undo step in A's editor
 * history, so Ctrl+Z in B does not restore the ink even though the notice
 * says "Undo restores them".
 *
 * Production code driven: the real InkOverlayPlugin constructor (so the real
 * module-level registry is populated in construction order), the real
 * inlineInk store, the real HandwritingPlugin prototype methods
 * deleteAllInkOrSaySo -> confirmDeleteAllInk -> (modal onConfirm) ->
 * confirmedDeleteAllInk -> deleteAllInk -> finishDeleteAllInk -> deleteAllInkOn
 * -> clearAllInk -> dispatchInk, and a real CodeMirror history per pane.
 * editorInfoField is a real StateField here (the stub exports {}), so the
 * overlays' own filePath()/ownsActiveEditor read per-pane identity; nothing
 * about routing is re-implemented.
 *
 * Asserts the CORRECT behaviour: the undo step lands in the pane the user ran
 * the command from (B, the workspace's active editor), and B's Ctrl+Z brings
 * the ink back. Red only if the step goes elsewhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { history, undo, undoDepth } from "@codemirror/commands";

const notices = vi.hoisted(() => ({ list: [] as string[] }));
const modals = vi.hoisted(() => ({ list: [] as Array<{ onConfirm?: () => void }> }));

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	const { StateField } = await import("@codemirror/state");
	const editorInfoField = StateField.define<unknown>({
		create: () => null,
		update: (value) => value,
	});
	return {
		...actual,
		editorInfoField,
		Notice: class {
			constructor(message: string) {
				notices.list.push(message);
			}
			hide(): void {}
		},
		Modal: class {
			constructor(_app: unknown) {
				modals.list.push(this as { onConfirm?: () => void });
			}
			open(): void {}
			close(): void {}
		},
	};
});

import { editorInfoField } from "obsidian";
import type { Editor, TFile } from "obsidian";
import {
	InkOverlayPlugin,
	inlineInk,
	overlayForActiveEditor,
	overlayForPath,
} from "../inline/InkOverlay";
import { inkApplied, inkEffect, inkHistorySupport } from "../inline/InkHistory";
import type { InlineInkHost } from "../inline/InlineInkStore";
import { emptyPage, serializePage, type PageData } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";
import HandwritingPlugin from "../main";

const PATH = "audit-two-panes.md";
const PAGE_ID = "audit-two-panes-id";
const TRASH = ".handwriting/trash/audit-kept.json";

const vaultFiles = new Map<string, { path: string; extension: string }>();
const teardown: Array<() => void> = [];

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	notices.list.length = 0;
	modals.list.length = 0;
	vi.spyOn(InkOverlayPlugin.prototype, "mount").mockImplementation(() => {});
});

afterEach(() => {
	for (const t of teardown.splice(0)) t();
	inlineInk.handleDelete(PATH);
	vaultFiles.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 10, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 10 },
		createdAt: 0,
	};
}
const ids = (s: readonly InkStroke[]): string[] => s.map((x) => x.id);

function attachHost(initial: InkStroke[]): void {
	const sidecars = new Map<string, PageData>();
	const page = emptyPage(PAGE_ID);
	page.surface = "inline";
	page.strokes = initial;
	sidecars.set(PAGE_ID, page);
	const host: InlineInkHost = {
		readPageId: (p) => (p === PATH ? PAGE_ID : null),
		claimId: async (_p, pageId) => ({ pageId }),
		loadSidecar: async (id) =>
			sidecars.has(id) ? { data: sidecars.get(id)!, recovered: false } : null,
		scheduleSidecar: () => {},
		notify() {},
	};
	inlineInk.attachHost(host);
}

type Pane = {
	name: string;
	overlay: InkOverlayPlugin;
	editor: Editor;
	view: { state: EditorState; dispatch(tr: Transaction | TransactionSpec): void };
};

/** One editor pane on the note: its own EditorState/history, its own Editor identity. */
function pane(name: string, file: object): Pane {
	const editor = { name } as unknown as Editor;
	let state = EditorState.create({
		doc: "note body",
		extensions: [
			history(),
			inkHistorySupport(),
			(editorInfoField as unknown as { init(f: () => unknown): never }).init(() => ({
				file,
				editor,
			})),
		],
	});
	let overlay!: InkOverlayPlugin;
	const view = {
		get state() {
			return state;
		},
		dispatch(input: Transaction | TransactionSpec) {
			const tr = input instanceof Transaction ? input : state.update(input);
			state = tr.state;
			for (const effect of tr.effects) {
				if (effect.is(inkEffect) && !tr.annotation(inkApplied)) {
					(overlay as unknown as { applyInkOp(op: unknown): void }).applyInkOp(effect.value);
				}
			}
		},
	};
	overlay = new InkOverlayPlugin(view as never);
	// Mounted (container non-null) so showsPath/ownsActiveEditor answer; paint is stubbed.
	Object.assign(overlay, {
		container: {},
		selection: { clear() {}, prune() {} },
		scheduleRepaint() {},
		repaintPath() {},
		redrawSelectionUI() {},
		unmount() {},
	});
	teardown.push(() => (overlay as unknown as { destroy(): void }).destroy());
	return { name, overlay, editor, view };
}

describe("InkOverlay-1-1: delete-all from the second pane on one note", () => {
	it("records the undo step in the pane the command was run from, so its Ctrl+Z restores the ink", async () => {
		attachHost([stroke("s-1"), stroke("s-2")]);
		await inlineInk.ensureLoaded(PATH);
		const file = { path: PATH, extension: "md", basename: "audit-two-panes" };
		vaultFiles.set(PATH, file);

		// A opened first, then B: two panes on one note.
		const a = pane("A", file);
		const b = pane("B", file);

		// B has a text edit of its own, so its history is not empty.
		b.view.dispatch({ changes: { from: 0, insert: "typed in B " }, userEvent: "input.type" });
		const docBBefore = b.view.state.doc.toString();

		// ---- preconditions ------------------------------------------------
		expect(ids(inlineInk.strokes(PATH))).toEqual(["s-1", "s-2"]);
		// Production's own resolver for "the pane the user is IN" names B...
		expect(overlayForActiveEditor(b.editor, file as unknown as TFile)).toBe(b.overlay);
		// ...while the first-mounted-by-path policy names A.
		expect(overlayForPath(PATH)).toBe(a.overlay);
		const depthA = undoDepth(a.view.state);
		const depthB = undoDepth(b.view.state);
		expect(depthA).toBe(0);
		expect(depthB).toBe(1);

		// The plugin, on the real prototype. The workspace says the user is in B.
		const files = new Map<string, string>();
		const plugin = Object.assign(Object.create(HandwritingPlugin.prototype) as object, {
			unloaded: false,
			store: {
				preserve: async () => {
					const page = emptyPage(PAGE_ID);
					page.surface = "inline";
					page.strokes = [...inlineInk.strokes(PATH)];
					files.set(TRASH, serializePage(page));
					return TRASH;
				},
			},
			app: {
				vault: {
					getFileByPath: (p: string) => vaultFiles.get(p) ?? null,
					getAbstractFileByPath: (p: string) => vaultFiles.get(p) ?? null,
					adapter: {
						read: async (at: string) => {
							const t = files.get(at);
							if (t === undefined) throw new Error(`no such file: ${at}`);
							return t;
						},
					},
				},
				metadataCache: { getFileCache: () => ({}) },
				workspace: {
					activeEditor: { file, editor: b.editor },
					getActiveFile: () => file,
				},
			},
		}) as unknown as { deleteAllInkOrSaySo(p: string, overlay?: InkOverlayPlugin | null): void; app: { workspace: { getActiveFile(): { path: string }; activeEditor: { file: object; editor: Editor } } } };

		// An unavailable active pane must refuse before a modal or safety-copy path.
		plugin.deleteAllInkOrSaySo(PATH, null);
		expect(ids(inlineInk.strokes(PATH))).toEqual(["s-1", "s-2"]);
		expect(modals.list.length).toBe(0);
		expect(notices.list.join(" ")).toContain("open the note in editing view");
		notices.list.length = 0;

		// ---- the trigger: the command's own call with getActiveFile()'s path, then Confirm
		plugin.deleteAllInkOrSaySo(plugin.app.workspace.getActiveFile().path);
		await new Promise((r) => setTimeout(r, 0));
		expect(modals.list.length, "the confirmation opened").toBe(1);
		// The target pane was captured at invocation; a focus change while the modal is open cannot reroute undo.
		plugin.app.workspace.activeEditor = { file, editor: a.editor };
		modals.list[0]!.onConfirm!();
		for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

		// The wipe really ran and the user was promised an undo.
		expect(ids(inlineInk.strokes(PATH)), "wipe ran").toEqual([]);
		expect(notices.list.join(" ")).toContain("Undo restores them");

		// ---- the correct behaviour --------------------------------------
		expect.soft(undoDepth(b.view.state), "undo step recorded in B, the pane the command ran from").toBe(depthB + 1);
		expect.soft(undoDepth(a.view.state), "no undo step in A, a pane the user is not in").toBe(depthA);

		// Ctrl+Z in B.
		undo({ state: b.view.state, dispatch: (tr: Transaction) => b.view.dispatch(tr) });
		expect.soft(ids(inlineInk.strokes(PATH)), "Ctrl+Z in B restores the ink").toEqual(["s-1", "s-2"]);
		expect.soft(b.view.state.doc.toString(), "Ctrl+Z in B did not undo B's text instead").toBe(docBBefore);

		// Diagnostic: A's Ctrl+Z (where the step would be if the bug is real).
		const restoredByA = undo({ state: a.view.state, dispatch: (tr: Transaction) => a.view.dispatch(tr) });
		console.log(
			`[probe] after B undo: B doc=${JSON.stringify(b.view.state.doc.toString())}; A undo ran=${restoredByA}; strokes now=${JSON.stringify(ids(inlineInk.strokes(PATH)))}`
		);
	});

	it("the note Snip command resolves the active pane, not the first overlay for the path", () => {
		const source = readFileSync(fileURLToPath(new URL("../main.ts", import.meta.url)), "utf8");
		const start = source.indexOf('id: "snip-pdf-selection"');
		const end = source.indexOf('id: "delete-all-pdf-ink"', start);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const command = source.slice(start, end);
		expect(command).toContain("const surface = this.activeInkSurface();");
		expect(command).toContain('const overlay = surface?.kind === "inline" ? surface.overlay : null;');
		expect(command).not.toContain("const overlay = overlayForPath(file.path);");
	});
});
