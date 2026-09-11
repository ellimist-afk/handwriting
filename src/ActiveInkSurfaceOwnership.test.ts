/**
 * THE REGISTERED INK COMMANDS MUST ACT ON THE EDITOR THE USER IS LOOKING AT.
 *
 * With two editors A then B open on the same note, A holding a selection and
 * the ACTIVE editor B holding its own, `activeInkSurface()` (main.ts) resolved
 * its inline answer through `overlayForPath(file.path)` (InkOverlay.ts), which
 * answers the FIRST mounted overlay showing that path - A. So the palette and
 * the hotkeys deleted A's stroke, put the history step in A, and copied A's
 * ink. B's Undo could not restore what B's Delete took, because the step was
 * never in B's history.
 *
 * FOUR COMMANDS come through here, verified by id in main.ts rather than taken
 * from a description: `delete-selected-ink`, `copy-selected-ink`,
 * `cut-selected-ink` and `paste-ink`. Delete by hotkey is the most destructive
 * of the four, and a hotkey is how people delete.
 *
 * NOT A NEW REGRESSION. The same bare `overlayForPath(file.path)` stands at
 * `refs/heads/1.4.12:1007`. This is shipped exposure, not something this
 * release introduced.
 *
 * THIS IS NOT THE STRIP. A strip button knows the overlay it is mounted on and
 * is already corrected by interception inside `InkOverlay.ts` - see
 * `InlineStripSelectionRouting.test.ts`, which drives that host path and
 * deliberately stands in for the registered command. This file drives the
 * REGISTERED COMMAND itself: the actual `addCommand` blocks and the actual
 * `activeInkSurface` / `pdfControllerWithSelection` methods, lifted out of
 * `main.ts` source and transpiled - the house pattern of
 * `ConcurrentExports.test.ts` - bound to the REAL `InkOverlayPlugin`, the REAL
 * `inlineInk` store, real `SelectionModel` selections, the real ink clipboard,
 * and a REAL headless CodeMirror history. Nothing about the routing is
 * re-implemented here, because a test that reimplements a routing bug cannot
 * see it.
 *
 * `editorInfoField` IS A REAL CODEMIRROR STATE FIELD HERE. The shipped
 * `obsidian` test stub exports it as `{}`, which no real `EditorState` can
 * answer, so this file mocks the module with a genuine `StateField` carrying a
 * distinct `Editor` object and a distinct `TFile` per editor. It is the same
 * field `InkOverlay.ts` reads in `filePath()`, so `showsPath`, `overlayForPath`
 * and the active-editor lookup all read ONE source of truth - and an identity
 * test cannot pass by quietly comparing paths instead.
 *
 * `overlayForPath` ITSELF IS UNCHANGED, asserted at the end: its
 * first-mounted-wins policy is still what the background callers get. The fix
 * is a narrower lookup beside it, not a change to that global policy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { history, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { transformSync } from "esbuild";
import mainSource from "./main.ts?raw";
import type { InkStroke } from "./ink/Stroke";

const notices = vi.hoisted(() => ({ said: [] as string[] }));

/**
 * `Notice` counts what the user was told; `editorInfoField` becomes a REAL
 * `StateField` so a real `EditorState` can carry per-editor identity. The
 * production module and this file import the same instance through this mock.
 */
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	const { StateField } = await import("@codemirror/state");
	class Notice {
		constructor(message: string) {
			notices.said.push(message);
		}
	}
	const editorInfoField = StateField.define<unknown>({
		create: () => null,
		update: (value) => value,
	});
	return { ...actual, Notice, editorInfoField };
});

import { Notice, TFile, editorInfoField } from "obsidian";
import type { Editor, MarkdownFileInfo } from "obsidian";
import * as InkOverlayModule from "./inline/InkOverlay";
import {
	InkOverlayPlugin,
	copySelectionNotice,
	copySelectionNoticeIsRoutine,
	cutSelectionNotice,
	cutSelectionNoticeIsRoutine,
	inlineInk,
	overlayForPath,
} from "./inline/InkOverlay";
import { clearInkClipboard, clipboardSize, pasteInk } from "./inline/InkClipboard";
import { lassoDeleteNotice } from "./inline/InlineSelectionDelete";
import { inkApplied, inkEffect, inkHistorySupport, type InkOp } from "./inline/InkHistory";

/** The gesture path rebinds, which constructs observers Node does not have. */
class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

// ---- the real source, lifted -----------------------------------------------

const source = mainSource.replace(/\r\n/g, "\n");

/** A source slice, with both ends proven present and unique. */
function slice(startMarker: string, endMarker: string): string {
	expect(source.split(startMarker), `start marker not unique: ${startMarker}`).toHaveLength(2);
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	expect(end, `end marker missing after: ${startMarker}`).toBeGreaterThan(start);
	return source.slice(start, end + endMarker.length);
}

const SURFACE_BLOCK = slice(
	'\tprivate activeInkSurface(): { kind: "inline"; overlay: InkOverlayPlugin } | { kind: "pdf"; controller: PdfInkController } | null {',
	"\n\t}",
);
const PDF_SELECTION_BLOCK = slice(
	"\tprivate pdfControllerWithSelection(path: string): PdfInkController | null {",
	"\n\t}",
);
const DELETE_BLOCK = slice('\t\tthis.addCommand({\n\t\t\tid: "delete-selected-ink",', "\n\t\t});");
const COPY_BLOCK = slice('\t\tthis.addCommand({\n\t\t\tid: "copy-selected-ink",', "\n\t\t});");
const CUT_BLOCK = slice('\t\tthis.addCommand({\n\t\t\tid: "cut-selected-ink",', "\n\t\t});");
const PASTE_BLOCK = slice('\t\tthis.addCommand({\n\t\t\tid: "paste-ink",', "\n\t\t});");

// Fail closed if the shapes these tests assume ever move: every one of the four
// commands must still choose its surface through the one method, and that
// method must still be the place the active file is read.
expect(SURFACE_BLOCK).toContain("getActiveFile()");
for (const block of [DELETE_BLOCK, COPY_BLOCK, CUT_BLOCK, PASTE_BLOCK]) {
	expect(block.match(/this\.activeInkSurface\(\)/g)).toHaveLength(1);
}

const js = (code: string): string => transformSync(code, { loader: "ts", target: "es2022" }).code;

type Deps = Record<string, unknown>;
const build = (code: string, deps: Deps): unknown => {
	const names = Object.keys(deps);
	return new Function(...names, js(code))(...names.map((n) => deps[n]));
};

/** Only what the PDF branch of the surface method reads off a controller. */
type PdfController = {
	hasSelection: boolean;
	identified: boolean;
	acted: string[];
	deleteSelectionCommand(): void;
	copySelection(): void;
	cutSelectionCommand(): void;
	pasteFromClipboard(): void;
};

type Surface = { kind: "inline"; overlay: InkOverlayPlugin } | { kind: "pdf"; controller: PdfController } | null;

/**
 * The two private methods, as real methods on a real prototype.
 *
 * The whole `InkOverlay` module namespace is spread in as the dependency set
 * deliberately: whatever lookup `activeInkSurface` reaches for is the REAL
 * exported one, and this file did not have to change between the red run
 * against unmodified production and the green one to introduce a new name.
 */
const methods = build(`class Lifted { ${SURFACE_BLOCK}\n${PDF_SELECTION_BLOCK} }\nreturn Lifted.prototype;`, {
	...InkOverlayModule,
	View: class {},
}) as {
	activeInkSurface(this: unknown): Surface;
	pdfControllerWithSelection(this: unknown, path: string): PdfController | null;
};

type CommandSpec = { id: string; checkCallback: (checking: boolean) => boolean };
type PluginStub = Record<string, unknown>;

/** The four commands, registered the way the real `onload` registers them. */
function registerCommands(host: PluginStub, routineNotices = true): Record<string, CommandSpec> {
	const captured: Record<string, CommandSpec> = {};
	const self = { ...host, addCommand: (spec: CommandSpec) => void (captured[spec.id] = spec) };
	(
		build(`return function () { ${DELETE_BLOCK}\n${COPY_BLOCK}\n${CUT_BLOCK}\n${PASTE_BLOCK} }`, {
			Notice,
			lassoDeleteNotice,
			copySelectionNotice,
			cutSelectionNotice,
			// The copy and cut sentences became branch-aware when the routine
			// ones moved behind the developer switch (2026-09-09). These cases
			// are about WHICH EDITOR a command acts on, and the notice is how
			// they observe it - so the switch is held ON here and every string
			// assertion below is unchanged. The gating itself is proven in
			// RoutineNoticesBehindDevMode.test.ts, not weakened here.
			routineNoticesVisible: () => routineNotices,
			copySelectionNoticeIsRoutine,
			cutSelectionNoticeIsRoutine,
			clipboardSize,
		}) as (this: unknown) => void
	).call(self);
	for (const id of ["delete-selected-ink", "copy-selected-ink", "cut-selected-ink", "paste-ink"]) {
		expect(captured[id], `the registration did not add ${id}`).toBeDefined();
	}
	return captured;
}

function pdfController(hasSelection: boolean, identified = true): PdfController {
	const acted: string[] = [];
	return {
		hasSelection,
		identified,
		acted,
		deleteSelectionCommand: () => void acted.push("delete"),
		copySelection: () => void acted.push("copy"),
		cutSelectionCommand: () => void acted.push("cut"),
		pasteFromClipboard: () => void acted.push("paste"),
	};
}

// ---- fixtures ---------------------------------------------------------------

/** A stroke whose x says which editor's selection it came from. */
function stroke(id: string, x: number): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x, y: 10, pressure: 0.5, t: 0 },
			{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: x - 2, y: 8, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

type FakeFile = TFile & { path: string; extension: string; basename: string };

function tfile(path: string): FakeFile {
	const file = new TFile() as FakeFile;
	file.path = path;
	file.extension = path.split(".").pop() ?? "md";
	file.basename = path.replace(/\.[^.]+$/, "");
	return file;
}

function editorNamed(name: string): Editor {
	return { name } as unknown as Editor;
}

/** The active-editor info the workspace hands back for a pane. */
function info(file: TFile | null, editor: Editor | undefined): MarkdownFileInfo {
	return { app: {}, file, editor, hoverPopover: null } as unknown as MarkdownFileInfo;
}

type Fixture = {
	overlay: InkOverlayPlugin;
	editor: Editor;
	info: MarkdownFileInfo;
	state: () => EditorState;
	dispatch: (tr: Transaction) => void;
	unmount(): void;
};

/**
 * A real `InkOverlayPlugin` in the real `instances` set, behind a REAL
 * CodeMirror state that carries `editorInfoField` - so `filePath()`,
 * `showsPath()` and the active-editor lookup all read the field the shipped
 * code reads - and a REAL history, so "the step went to B and not to A" is the
 * mechanism `undo` actually uses rather than a bookkeeping stand-in.
 *
 * Construction is two-phase for the reason `InlineStripSelectionRouting.test.ts`
 * gives: `mount()` builds canvases this environment has no DOM for, and it
 * bails when the field lookup is `undefined`, so it is allowed to bail and the
 * fields it would have set are supplied by hand afterwards. Only host chrome is
 * stubbed - repaints, the selection redraw, and the paste scroll-into-view,
 * which needs a laid-out canvas.
 */
function mountOverlay(file: TFile, editor: Editor): Fixture {
	const noop = (): void => undefined;
	const dom = {
		parentElement: { setCssStyles: noop },
		ownerDocument: {
			defaultView: { getComputedStyle: () => ({ position: "relative" }), cancelAnimationFrame: noop },
		},
		style: { removeProperty: noop },
		setCssStyles: noop,
	};
	const view: Record<string, unknown> = {
		dom,
		scrollDOM: {
			removeEventListener: noop,
			addEventListener: noop,
			classList: { add: noop, remove: noop },
			setCssStyles: noop,
			style: { removeProperty: noop },
			getBoundingClientRect: () => ({ left: 0, top: 0 }),
			clientHeight: 800,
			clientWidth: 800,
			clientLeft: 0,
			clientTop: 0,
			scrollTop: 0,
			scrollLeft: 0,
		},
		// `mount()` reads this once at construction and stays inert on undefined.
		state: { field: () => undefined },
	};
	const overlay = new InkOverlayPlugin(view as never) as unknown as Record<string, unknown>;
	overlay.container = { nodeType: 1, remove: noop, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
	overlay.mobileTools = null;
	overlay.applyToolbarCorner = noop;
	overlay.redrawSelectionUI = noop;
	overlay.scheduleRepaint = noop;
	overlay.repaintPath = noop;
	overlay.updateExtent = noop;
	overlay.syncCamera = noop;
	// Chrome: a paste scrolls what it pasted into view, which needs a laid-out
	// canvas. WHERE the paste landed is asserted from the store, not from here.
	overlay.selectionBounds = () => null;

	const mine = info(file, editor);
	let cm = EditorState.create({
		doc: "",
		extensions: [history(), inkHistorySupport(), editorInfoField.init(() => mine)],
	});
	view.state = cm;
	const dispatch = (trOrSpec: unknown): void => {
		const tr = trOrSpec instanceof Transaction ? trOrSpec : cm.update(trOrSpec as never);
		cm = tr.state;
		view.state = cm;
		// What the real ViewPlugin's `update()` does first on every
		// transaction, with the same guard: the original gesture already put
		// its change in the store, so only a re-dispatch (undo/redo) applies.
		if (!tr.annotation(inkApplied)) {
			for (const effect of tr.effects) {
				if (effect.is(inkEffect)) {
					(overlay as unknown as { applyInkOp(op: InkOp): void }).applyInkOp(effect.value as InkOp);
				}
			}
		}
	};
	view.dispatch = dispatch;

	return {
		overlay: overlay as unknown as InkOverlayPlugin,
		editor,
		info: mine,
		state: () => cm,
		dispatch: dispatch as (tr: Transaction) => void,
		unmount: () => void ((overlay as unknown as { container: unknown }).container = null),
	};
}

const EMPTY_NOTICE = "Handwriting: lasso some ink first";

describe("the registered ink commands act on the ACTIVE editor", () => {
	let live: InkOverlayPlugin[] = [];

	beforeEach(() => {
		notices.said = [];
		live = [];
		clearInkClipboard();
	});

	afterEach(() => {
		for (const o of live) (o as unknown as { destroy(): void }).destroy();
		clearInkClipboard();
	});

	function mount(file: TFile, editor: Editor): Fixture {
		const f = mountOverlay(file, editor);
		live.push(f.overlay);
		return f;
	}

	function selection(overlay: InkOverlayPlugin): { selectExactly(ids: string[]): void; strokeIds: string[] } {
		return (overlay as unknown as { selection: { selectExactly(ids: string[]): void; strokeIds: string[] } })
			.selection;
	}

	/**
	 * The plugin the four registered callbacks run against: the real lifted
	 * `activeInkSurface`, the real lifted `pdfControllerWithSelection`, and a
	 * workspace answering exactly what the shipped method asks it.
	 */
	function commandsFor(opts: {
		activeFile: TFile | null;
		activeEditor?: MarkdownFileInfo | null;
		pdf?: { root: object; path: string; controller: PdfController }[];
		activeLeafRoot?: object;
		routineNotices?: boolean;
	}): Record<string, CommandSpec> {
		const pdfFiles = new Map<object, string>();
		const pdfInk = new Map<object, PdfController>();
		for (const entry of opts.pdf ?? []) {
			pdfFiles.set(entry.root, entry.path);
			pdfInk.set(entry.root, entry.controller);
		}
		return registerCommands({
			app: {
				workspace: {
					getActiveFile: () => opts.activeFile,
					activeEditor: opts.activeEditor ?? null,
					getActiveViewOfType: () => opts.activeLeafRoot ? { containerEl: opts.activeLeafRoot } : null,
				},
			},
			pdfFiles,
			pdfInk,
			activeInkSurface: methods.activeInkSurface,
			pdfControllerWithSelection: methods.pdfControllerWithSelection,
		}, opts.routineNotices);
	}

	function ids(path: string): string[] {
		return inlineInk.strokes(path).map((s) => s.id);
	}

	/** What the clipboard is holding, by the x that says whose stroke it is. */
	function clipboardXs(): number[] {
		return pasteInk("clipboard-probe.md").map((s) => s.points[0]!.x);
	}

	function undoIn(f: Fixture): void {
		undo({ state: f.state(), dispatch: f.dispatch } as never);
	}
	function redoIn(f: Fixture): void {
		redo({ state: f.state(), dispatch: f.dispatch } as never);
	}

	/** A then B on one note, A holding `a` (x10) and B holding `b` (x110). */
	function twoPanes(path: string): { file: FakeFile; a: Fixture; b: Fixture } {
		const file = tfile(path);
		inlineInk.applyAdd(file.path, [stroke("a", 10), stroke("b", 110)]);
		const a = mount(file, editorNamed("A"));
		const b = mount(file, editorNamed("B"));
		selection(a.overlay).selectExactly(["a"]);
		selection(b.overlay).selectExactly(["b"]);
		return { file, a, b };
	}

	// ---- the defect ---------------------------------------------------------

	it("Delete removes ONLY b, and the sole undo step is B's", () => {
		const { file, a, b } = twoPanes("case-delete.md");

		expect(commandsFor({ activeFile: file, activeEditor: b.info })["delete-selected-ink"]!.checkCallback(false)).toBe(
			true,
		);

		expect(ids(file.path)).toEqual(["a"]);
		expect(undoDepth(a.state())).toBe(0);
		expect(undoDepth(b.state())).toBe(1);
		expect(notices.said).toEqual([]);
	});

	it("the history step goes into B, and A's history stays empty", () => {
		// Its own case, asserted before anything about the store, so the
		// WRONG-OWNER receipt is legible on its own: the depths are the half
		// of this defect that makes B's Undo unable to restore what B deleted.
		const { file, a, b } = twoPanes("case-history-owner.md");

		commandsFor({ activeFile: file, activeEditor: b.info })["delete-selected-ink"]!.checkCallback(false);

		expect({ A: undoDepth(a.state()), B: undoDepth(b.state()) }).toEqual({ A: 0, B: 1 });
	});

	it("B's own Undo restores exactly what B's Delete took, and Redo removes only b", () => {
		const { file, a, b } = twoPanes("case-undo.md");
		commandsFor({ activeFile: file, activeEditor: b.info })["delete-selected-ink"]!.checkCallback(false);
		expect(ids(file.path)).toEqual(["a"]);

		undoIn(b);

		expect(ids(file.path).sort()).toEqual(["a", "b"]);
		// The restored stroke is the original, not a reconstruction.
		const restored = inlineInk.strokes(file.path).find((s) => s.id === "b");
		expect(restored?.points[0]?.x).toBe(110);
		expect(undoDepth(a.state())).toBe(0);
		expect(redoDepth(a.state())).toBe(0);

		redoIn(b);

		expect(ids(file.path)).toEqual(["a"]);
	});

	it("Copy takes B's ink (x110), not A's (x10), and changes no ink or history", () => {
		const { file, a, b } = twoPanes("case-copy.md");

		commandsFor({ activeFile: file, activeEditor: b.info })["copy-selected-ink"]!.checkCallback(false);

		expect(clipboardXs()).toEqual([110]);
		expect(ids(file.path)).toEqual(["a", "b"]);
		expect(undoDepth(a.state())).toBe(0);
		expect(undoDepth(b.state())).toBe(0);
		expect(notices.said).toEqual(["Handwriting: copied 1 stroke(s)"]);
	});

	it("Cut takes B's ink and removes only b, with the step in B", () => {
		const { file, a, b } = twoPanes("case-cut.md");

		commandsFor({ activeFile: file, activeEditor: b.info })["cut-selected-ink"]!.checkCallback(false);

		expect(clipboardXs()).toEqual([110]);
		expect(ids(file.path)).toEqual(["a"]);
		expect(undoDepth(a.state())).toBe(0);
		expect(undoDepth(b.state())).toBe(1);
		expect(notices.said).toEqual(["Handwriting: cut 1 stroke(s)"]);
	});

	// ---- the active editor's own empty selection ----------------------------

	it("A holds a selection and the active B is empty: every command says so and touches nothing", () => {
		const file = tfile("case-empty.md");
		inlineInk.applyAdd(file.path, [stroke("a", 10)]);
		const a = mount(file, editorNamed("A"));
		const b = mount(file, editorNamed("B"));
		selection(a.overlay).selectExactly(["a"]);
		// B: nothing selected.
		const commands = commandsFor({ activeFile: file, activeEditor: b.info });

		commands["delete-selected-ink"]!.checkCallback(false);
		commands["copy-selected-ink"]!.checkCallback(false);
		commands["cut-selected-ink"]!.checkCallback(false);

		expect(notices.said).toEqual([EMPTY_NOTICE, EMPTY_NOTICE, EMPTY_NOTICE]);
		expect(ids(file.path)).toEqual(["a"]);
		expect(clipboardSize()).toBe(0);
		expect(undoDepth(a.state())).toBe(0);
		expect(undoDepth(b.state())).toBe(0);
	});

	// ---- refusals -----------------------------------------------------------

	/** Every command unavailable, nothing copied, nothing mutated anywhere. */
	function expectRefused(commands: Record<string, CommandSpec>, path: string, before: string[]): void {
		for (const id of ["delete-selected-ink", "copy-selected-ink", "cut-selected-ink", "paste-ink"]) {
			expect(commands[id]!.checkCallback(true), `${id} should be unavailable`).toBe(false);
		}
		expect(ids(path)).toEqual(before);
		expect(clipboardSize()).toBe(0);
		expect(notices.said).toEqual([]);
	}

	it("no active editor at all: refused, and A is not reached instead", () => {
		const { file, a } = twoPanes("case-no-active.md");
		expectRefused(commandsFor({ activeFile: file, activeEditor: null }), file.path, ["a", "b"]);
		expect(undoDepth(a.state())).toBe(0);
	});

	it("the active editor has no editor: refused", () => {
		const { file } = twoPanes("case-no-editor.md");
		expectRefused(commandsFor({ activeFile: file, activeEditor: info(file, undefined) }), file.path, ["a", "b"]);
	});

	it("an active editor no overlay owns: refused, never redirected to A", () => {
		const { file } = twoPanes("case-unknown-editor.md");
		const stranger = info(file, editorNamed("stranger"));
		expectRefused(commandsFor({ activeFile: file, activeEditor: stranger }), file.path, ["a", "b"]);
	});

	it("SAME PATH, DIFFERENT TFile: refused, because identity is not a path", () => {
		const { file, b } = twoPanes("case-twin.md");
		// A different TFile object naming the same path - what `overlayForPath`
		// cannot tell apart, and the reason this lookup compares objects.
		const twin = tfile(file.path);
		expect(twin.path).toBe(file.path);
		expect(twin).not.toBe(file);

		expectRefused(commandsFor({ activeFile: twin, activeEditor: info(twin, b.editor) }), file.path, ["a", "b"]);
	});

	it("a reused editor carrying old metadata: refused", () => {
		const { file, b } = twoPanes("case-reused.md");
		// Obsidian reuses editors, so B's Editor object can turn up paired
		// with a file it no longer shows. The overlay's own field still says
		// case-reused.md, so the pairing does not match and nothing is chosen.
		const elsewhere = tfile("some-other-note.md");
		expectRefused(commandsFor({ activeFile: elsewhere, activeEditor: info(elsewhere, b.editor) }), file.path, [
			"a",
			"b",
		]);
	});

	it("the active overlay is unmounted: refused, not handed to the mounted A", () => {
		const { file, b } = twoPanes("case-unmounted.md");
		b.unmount();
		expectRefused(commandsFor({ activeFile: file, activeEditor: b.info }), file.path, ["a", "b"]);
	});

	it("checking=true never mutates", () => {
		const { file, a, b } = twoPanes("case-checking.md");
		const commands = commandsFor({ activeFile: file, activeEditor: b.info });

		for (const id of ["delete-selected-ink", "copy-selected-ink", "cut-selected-ink"]) {
			expect(commands[id]!.checkCallback(true)).toBe(true);
		}

		expect(ids(file.path)).toEqual(["a", "b"]);
		expect(clipboardSize()).toBe(0);
		expect(undoDepth(a.state())).toBe(0);
		expect(undoDepth(b.state())).toBe(0);
		expect(notices.said).toEqual([]);
	});

	// ---- preserved behaviour ------------------------------------------------

	it("one editor: an ordinary delete still works", () => {
		const file = tfile("case-single.md");
		inlineInk.applyAdd(file.path, [stroke("x", 10)]);
		const only = mount(file, editorNamed("only"));
		selection(only.overlay).selectExactly(["x"]);

		commandsFor({ activeFile: file, activeEditor: only.info })["delete-selected-ink"]!.checkCallback(false);

		expect(ids(file.path)).toEqual([]);
		expect(undoDepth(only.state())).toBe(1);
		expect(notices.said).toEqual([]);
	});

	it("two different notes, only the active one's selection is taken", () => {
		const noteA = tfile("case-note-a.md");
		const noteB = tfile("case-note-b.md");
		inlineInk.applyAdd(noteA.path, [stroke("a", 10)]);
		inlineInk.applyAdd(noteB.path, [stroke("b", 110)]);
		const a = mount(noteA, editorNamed("A"));
		const b = mount(noteB, editorNamed("B"));
		selection(a.overlay).selectExactly(["a"]);
		selection(b.overlay).selectExactly(["b"]);

		commandsFor({ activeFile: noteB, activeEditor: b.info })["delete-selected-ink"]!.checkCallback(false);

		expect(ids(noteA.path)).toEqual(["a"]);
		expect(ids(noteB.path)).toEqual([]);
		expect(undoDepth(a.state())).toBe(0);
		expect(undoDepth(b.state())).toBe(1);
	});

	it("an ordinary rename keeps the same TFile, so the command still lands in B", () => {
		const { file, a, b } = twoPanes("case-rename.md");
		// A rename mutates the path on the SAME TFile object. Identity holds,
		// so B is still B - the case a path comparison would also pass, and an
		// over-strict identity check would break.
		file.path = "case-renamed.md";
		inlineInk.applyAdd(file.path, [stroke("a", 10), stroke("b", 110)]);
		selection(a.overlay).selectExactly(["a"]);
		selection(b.overlay).selectExactly(["b"]);

		commandsFor({ activeFile: file, activeEditor: b.info })["delete-selected-ink"]!.checkCallback(false);

		expect(ids("case-renamed.md")).toEqual(["a"]);
		expect(undoDepth(b.state())).toBe(1);
		expect(undoDepth(a.state())).toBe(0);
	});

	// ---- paste, the fourth caller -------------------------------------------

	it("Paste lands in the ACTIVE editor's note, owns its undo step and shows success with the switch ON", () => {
		const { file, a, b } = twoPanes("case-paste.md");
		const commands = commandsFor({ activeFile: file, activeEditor: b.info, routineNotices: true });
		commands["copy-selected-ink"]!.checkCallback(false);
		notices.said = [];

		expect(commands["paste-ink"]!.checkCallback(false)).toBe(true);

		expect(ids(file.path)).toHaveLength(3);
		expect(undoDepth(b.state())).toBe(1);
		expect(undoDepth(a.state())).toBe(0);
		expect(notices.said).toEqual(["Handwriting: pasted 1 stroke(s)"]);
	});

	it("Paste still acts but keeps its routine success toast quiet when the switch is OFF", () => {
		const { file, a, b } = twoPanes("case-paste-routine-off.md");
		const commands = commandsFor({ activeFile: file, activeEditor: b.info, routineNotices: false });
		commands["copy-selected-ink"]!.checkCallback(false);
		notices.said = [];

		expect(commands["paste-ink"]!.checkCallback(false)).toBe(true);

		expect(ids(file.path)).toHaveLength(3);
		expect(undoDepth(b.state())).toBe(1);
		expect(undoDepth(a.state())).toBe(0);
		expect(notices.said).toEqual([]);
	});

	it("Paste refuses on an identity mismatch rather than pasting into A", () => {
		const { file, a, b } = twoPanes("case-paste-mismatch.md");
		commandsFor({ activeFile: file, activeEditor: b.info })["copy-selected-ink"]!.checkCallback(false);
		notices.said = [];
		const twin = tfile(file.path);

		const commands = commandsFor({ activeFile: twin, activeEditor: info(twin, b.editor) });

		expect(commands["paste-ink"]!.checkCallback(true)).toBe(false);
		expect(ids(file.path)).toEqual(["a", "b"]);
		expect(undoDepth(a.state())).toBe(0);
		expect(undoDepth(b.state())).toBe(0);
	});

	it("Paste with an empty clipboard is still listed and says the clipboard is empty", () => {
		const file = tfile("case-paste-empty.md");
		const only = mount(file, editorNamed("only"));

		const commands = commandsFor({ activeFile: file, activeEditor: only.info });
		expect(commands["paste-ink"]!.checkCallback(false)).toBe(true);

		expect(notices.said).toEqual(["Handwriting: the ink clipboard is empty, copy selected ink first"]);
		expect(ids(file.path)).toEqual([]);
	});

	// ---- the PDF branch, unchanged ------------------------------------------

	it("the ACTIVE pdf pane wins even with an empty selection, over a background pane holding one", () => {
		const pdf = tfile("doc.pdf");
		const activeRoot = {};
		const backgroundRoot = {};
		const activeController = pdfController(false);
		const backgroundController = pdfController(true);

		const commands = commandsFor({
			activeFile: pdf,
			activeLeafRoot: activeRoot,
			pdf: [
				{ root: backgroundRoot, path: pdf.path, controller: backgroundController },
				{ root: activeRoot, path: pdf.path, controller: activeController },
			],
		});
		commands["delete-selected-ink"]!.checkCallback(false);

		expect(activeController.acted).toEqual(["delete"]);
		expect(backgroundController.acted).toEqual([]);
	});

	it("no active pdf controller: the pane holding a selection on that path answers", () => {
		const pdf = tfile("doc2.pdf");
		const holdingRoot = {};
		const idleRoot = {};
		const holding = pdfController(true);
		const idle = pdfController(false);

		const commands = commandsFor({
			activeFile: pdf,
			pdf: [
				{ root: idleRoot, path: pdf.path, controller: idle },
				{ root: holdingRoot, path: pdf.path, controller: holding },
			],
		});
		commands["cut-selected-ink"]!.checkCallback(false);

		expect(holding.acted).toEqual(["cut"]);
		expect(idle.acted).toEqual([]);
	});

	it("a pdf with no controller at all: refused", () => {
		const pdf = tfile("doc3.pdf");
		const commands = commandsFor({ activeFile: pdf });
		for (const id of ["delete-selected-ink", "copy-selected-ink", "cut-selected-ink", "paste-ink"]) {
			expect(commands[id]!.checkCallback(true)).toBe(false);
		}
	});

	it("paste stays unavailable until the pdf is identified", () => {
		const pdf = tfile("doc4.pdf");
		const root = {};
		const commands = commandsFor({
			activeFile: pdf,
			activeLeafRoot: root,
			pdf: [{ root, path: pdf.path, controller: pdfController(false, false) }],
		});
		expect(commands["paste-ink"]!.checkCallback(true)).toBe(false);
		// Delete is not gated on identification and stays available.
		expect(commands["delete-selected-ink"]!.checkCallback(true)).toBe(true);
	});

	// ---- the global policy this fix must NOT have changed -------------------

	it("overlayForPath still answers the FIRST mounted overlay, unchanged", () => {
		const { file, a, b } = twoPanes("case-policy.md");
		void b;
		expect(overlayForPath(file.path)).toBe(a.overlay);
	});
});
