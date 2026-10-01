/**
 * Audit probe InkOverlay-2-2 (1.4.21, tag 1a05f62c). Asserts the CORRECT
 * behavior: renaming the note that is open (Obsidian mutates the SAME TFile's
 * `path` in place; the editor, its state and this overlay all stay) must not
 * reset the reader's scroll position, zoom or ink selection on the next
 * editor update. Red here means `updateInner`'s `path !== this.lastPath`
 * branch (InkOverlay.ts:3182) treats the rename as a note switch.
 *
 * Drives the REAL `InkOverlayPlugin.update()` behind a REAL CodeMirror
 * `EditorState` carrying a real `editorInfoField` (the mock pattern of
 * src/ActiveInkSurfaceOwnership.test.ts), and the REAL production rename route
 * for the store (`inlineInk.handleRename`, what main.ts:3534 calls). Only
 * host chrome is stubbed: this environment has no DOM, so mount() bails and
 * the fields it would have set (container, lastPath, paint layers) are
 * supplied by hand the same way the house fixtures do.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import type { InkStroke } from "../ink/Stroke";

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	const { StateField } = await import("@codemirror/state");
	class Notice {
		constructor(_message: string) {}
	}
	const editorInfoField = StateField.define<unknown>({
		create: () => null,
		update: (value) => value,
	});
	return { ...actual, Notice, editorInfoField };
});

import { TFile, editorInfoField } from "obsidian";
import type { Editor, MarkdownFileInfo } from "obsidian";
import { InkOverlayPlugin, inlineInk } from "../inline/InkOverlay";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

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
	file.extension = "md";
	file.basename = path.replace(/^.*\//, "").replace(/\.md$/, "");
	return file;
}

type Priv = Record<string, unknown> & {
	update(u: unknown): void;
	destroy(): void;
	filePath(): string | null;
	currentFile(): unknown;
	selection: { selectExactly(ids: string[]): void; isEmpty: boolean };
	pinchScaleNow: number;
};

type Fixture = {
	overlay: Priv;
	scroller: { scrollTop: number; scrollLeft: number };
	info: MarkdownFileInfo;
	setFile(file: TFile): void;
	state(): EditorState;
};

function mountOverlay(file: TFile): Fixture {
	const noop = (): void => undefined;
	const style = {
		removeProperty: noop,
		setProperty: noop,
		getPropertyValue: () => "",
		getPropertyPriority: () => "",
	};
	const classList = { add: noop, remove: noop, toggle: noop, contains: () => false };
	const win = {
		getComputedStyle: () => ({ position: "relative" }),
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: noop,
		setTimeout: () => 0,
		clearTimeout: noop,
		devicePixelRatio: 1,
	};
	const doc = { defaultView: win };
	// The editor root: `.markdown-source-view` is the root itself, not inside a
	// table cell or a nested editor, so ownsMarkdownEditorRoot() answers true.
	const dom: Record<string, unknown> = {
		ownerDocument: doc,
		parentElement: { setCssStyles: noop, closest: () => null, classList },
		style,
		classList,
		setCssStyles: noop,
		isConnected: false,
		querySelector: () => null,
		querySelectorAll: () => [],
		contains: () => false,
	};
	dom.closest = (sel: string) => (sel === ".markdown-source-view" ? dom : null);
	const scroller = {
		removeEventListener: noop,
		addEventListener: noop,
		classList,
		setCssStyles: noop,
		style,
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
		clientHeight: 800,
		clientWidth: 800,
		clientLeft: 0,
		clientTop: 0,
		scrollHeight: 20000,
		scrollWidth: 800,
		scrollTop: 0,
		scrollLeft: 0,
	};
	const view: Record<string, unknown> = {
		dom,
		scrollDOM: scroller,
		// mount() reads this at construction and stays inert on undefined.
		state: { field: () => undefined },
	};
	const overlay = new InkOverlayPlugin(view as never) as unknown as Priv;
	overlay.container = { nodeType: 1, remove: noop, isConnected: true, setCssStyles: noop, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
	overlay.mobileTools = null;
	overlay.applyToolbarCorner = noop;
	overlay.redrawSelectionUI = noop;
	overlay.scheduleRepaint = noop;
	overlay.repaintPath = noop;
	overlay.updateExtent = noop;
	overlay.syncCamera = noop;
	// Paint layers mount() would have built; the branch clears them.
	overlay.wet = { clear: noop };
	overlay.highlightWet = { clear: noop };
	overlay.highlightWetCanvas = { setCssStyles: noop };
	overlay.tail = {
		clearAll: noop,
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
	};

	let info = { app: {}, file, editor: { name: "E" } as unknown as Editor, hoverPopover: null } as unknown as MarkdownFileInfo;
	const setFile = (f: TFile): void => {
		info = { ...info, file: f } as MarkdownFileInfo;
		view.state = EditorState.create({ doc: "# note\n\nbody\n", extensions: [editorInfoField.init(() => info)] });
	};
	view.state = EditorState.create({ doc: "# note\n\nbody\n", extensions: [editorInfoField.init(() => info)] });
	// What mount() sets on a real mount: the path and the file object it names.
	overlay.lastPath = overlay.filePath();
	overlay.lastFile = overlay.currentFile();
	return {
		overlay,
		scroller,
		get info() {
			return info;
		},
		setFile,
		state: () => view.state as EditorState,
	};
}

/** A viewport-moving update with no transactions: what a scroll produces. */
function scrollUpdate(f: Fixture) {
	return {
		transactions: [],
		docChanged: false,
		geometryChanged: false,
		viewportChanged: true,
		focusChanged: false,
		selectionSet: false,
		heightChanged: false,
		state: f.state(),
		startState: f.state(),
	};
}

function readout(f: Fixture) {
	return {
		scrollTop: f.scroller.scrollTop,
		scrollLeft: f.scroller.scrollLeft,
		selectionEmpty: f.overlay.selection.isEmpty,
		pinchScaleNow: f.overlay.pinchScaleNow,
	};
}

/** The reader has scrolled down, zoomed (Infinite Canvas on) and lassoed a stroke. */
function readerState(f: Fixture, path: string) {
	inlineInk.applyAdd(path, [stroke("a", 10)]);
	f.scroller.scrollTop = 1234;
	f.scroller.scrollLeft = 0;
	f.overlay.pinchScaleNow = 2;
	f.overlay.selection.selectExactly(["a"]);
	return readout(f);
}

describe("InkOverlay-2-2: renaming the open note is not a note switch", () => {
	const live: Priv[] = [];
	afterEach(() => {
		for (const o of live.splice(0)) {
			try {
				o.destroy();
			} catch {
				// Teardown on a DOM-less fake; not what is under test.
			}
		}
	});

	it("control: an ordinary scroll update on the same note keeps scroll, zoom and selection", () => {
		const file = tfile("probe22/control.md");
		const f = mountOverlay(file);
		live.push(f.overlay);
		const before = readerState(f, file.path);
		expect(before).toEqual({ scrollTop: 1234, scrollLeft: 0, selectionEmpty: false, pinchScaleNow: 2 });

		f.overlay.update(scrollUpdate(f));

		expect(readout(f)).toEqual(before);
	});

	it("control: a genuine switch to a different note does reset (the branch under test)", () => {
		const file = tfile("probe22/switch-a.md");
		const f = mountOverlay(file);
		live.push(f.overlay);
		readerState(f, file.path);

		f.setFile(tfile("probe22/switch-b.md"));
		f.overlay.update(scrollUpdate(f));

		expect(readout(f)).toEqual({ scrollTop: 0, scrollLeft: 0, selectionEmpty: true, pinchScaleNow: 1 });
	});

	it("a rename of the open note (same TFile, path mutated in place) keeps scroll, zoom and selection", () => {
		const oldPath = "probe22/before.md";
		const newPath = "probe22/folder/after.md";
		const file = tfile(oldPath);
		const f = mountOverlay(file);
		live.push(f.overlay);
		const before = readerState(f, oldPath);
		const infoBefore = f.state().field(editorInfoField as never) as MarkdownFileInfo;

		// THE PRODUCTION RENAME ROUTE: main.ts:3532-3536 moves the store record;
		// Obsidian moves the same TFile by assigning its path.
		inlineInk.handleRename(oldPath, newPath);
		file.path = newPath;
		file.basename = "after";

		// Preconditions: nothing about the editor changed except the file's path.
		const infoAfter = f.state().field(editorInfoField as never) as MarkdownFileInfo;
		expect(infoAfter, "same editor info object").toBe(infoBefore);
		expect(infoAfter.file, "same TFile object").toBe(file);
		expect(f.overlay.filePath(), "filePath() reads the renamed path live").toBe(newPath);
		expect(f.overlay.lastPath, "lastPath still holds the old path").toBe(oldPath);
		expect(inlineInk.strokes(newPath).map((s) => s.id), "the ink moved with the note").toEqual(["a"]);

		// The next ordinary editor update (a scroll that moves the viewport).
		f.overlay.update(scrollUpdate(f));

		// CORRECT behavior: the reader's view survives the rename.
		expect(readout(f), "rename must not run the note-switch reset").toEqual(before);
	});

	it("the same note open in two panes, renamed once: both panes keep scroll, zoom and selection", () => {
		const oldPath = "probe22/two.md";
		const newPath = "probe22/two-renamed.md";
		const file = tfile(oldPath);
		const a = mountOverlay(file);
		const b = mountOverlay(file);
		live.push(a.overlay, b.overlay);
		const beforeA = readerState(a, oldPath);
		b.scroller.scrollTop = 1234;
		b.overlay.pinchScaleNow = 2;
		const beforeB = readout(b);

		// One vault rename record, two editors showing the note: the first update consumes the record, so the
		// second pane can only know the note by its file object.
		inlineInk.handleRename(oldPath, newPath);
		file.path = newPath;
		a.overlay.update(scrollUpdate(a));
		b.overlay.update(scrollUpdate(b));

		expect(readout(a), "pane A kept its view").toEqual(beforeA);
		expect(readout(b), "pane B kept its view after pane A consumed the rename record").toEqual(beforeB);
	});

	it("with no file object recorded, the store's rename record alone keeps the view", () => {
		const oldPath = "probe22/fallback.md";
		const newPath = "probe22/fallback-renamed.md";
		const file = tfile(oldPath);
		const f = mountOverlay(file);
		live.push(f.overlay);
		f.overlay.lastFile = null;
		const before = readerState(f, oldPath);

		inlineInk.handleRename(oldPath, newPath);
		file.path = newPath;
		f.overlay.update(scrollUpdate(f));

		expect(readout(f), "rename recorded by the store must not run the note-switch reset").toEqual(before);
	});

	it("a stale rename record does not turn a switch between two known, different files into a rename", () => {
		const pathA = "probe22/stale-a.md";
		const pathB = "probe22/stale-b.md";
		const original = tfile(pathA);
		const f = mountOverlay(original);
		live.push(f.overlay);

		// 1. The open note is renamed A -> B: the same TFile, its path mutated in place.
		inlineInk.handleRename(pathA, pathB);
		original.path = pathB;
		original.basename = "stale-b";
		f.overlay.update(scrollUpdate(f));

		// 2. A different note is created at the freed path A and opened in the same editor; the reader works there.
		const reused = tfile(pathA);
		f.setFile(reused);
		f.overlay.update(scrollUpdate(f));
		expect(readerState(f, pathA), "the reader's view on the new A").toEqual({ scrollTop: 1234, scrollLeft: 0, selectionEmpty: false, pinchScaleNow: 2 });

		// 3. Back to the original note, now B: both file objects are known, and they differ.
		f.setFile(original);
		expect(f.overlay.currentFile(), "the editor names the original file").toBe(original);
		expect(f.overlay.lastFile, "the overlay last saw the new A").toBe(reused);
		expect(original, "two different files").not.toBe(reused);
		f.overlay.update(scrollUpdate(f));

		expect(readout(f), "a switch between two known, different files resets the view").toEqual({ scrollTop: 0, scrollLeft: 0, selectionEmpty: true, pinchScaleNow: 1 });
	});

	it("a note renamed while no editor shows it, a new note at its old path, then the renamed note: a switch", () => {
		const pathA = "probe22/closed-a.md";
		const pathB = "probe22/closed-b.md";
		const other = tfile("probe22/closed-other.md");
		const f = mountOverlay(other);
		live.push(f.overlay);

		// 1. A is renamed to B while this editor shows another note: the store records A -> B and no editor consumes it.
		inlineInk.handleRename(pathA, pathB);
		const renamed = tfile(pathB);

		// 2. A new note at the freed path A, opened here; the reader works there.
		const reused = tfile(pathA);
		f.setFile(reused);
		f.overlay.update(scrollUpdate(f));
		expect(readerState(f, pathA), "the reader's view on the new A").toEqual({ scrollTop: 1234, scrollLeft: 0, selectionEmpty: false, pinchScaleNow: 2 });

		// 3. Then the renamed note B: two known, different files, and a record A -> B nobody consumed.
		f.setFile(renamed);
		f.overlay.update(scrollUpdate(f));
		expect(readout(f), "a switch between two known, different files resets the view").toEqual({ scrollTop: 0, scrollLeft: 0, selectionEmpty: true, pinchScaleNow: 1 });
	});

	it("a rename retires external-reload captures taken before it, and still keeps the view", () => {
		const oldPath = "probe22/reload.md";
		const newPath = "probe22/reload-renamed.md";
		const file = tfile(oldPath);
		const f = mountOverlay(file);
		live.push(f.overlay);
		const before = readerState(f, oldPath);
		// A reload capture holds the path and this epoch; the capture is only honoured while the epoch is unchanged.
		const epochBefore = f.overlay.reloadBindingEpoch;

		inlineInk.handleRename(oldPath, newPath);
		file.path = newPath;
		f.overlay.update(scrollUpdate(f));

		expect(readout(f), "rename must not run the note-switch reset").toEqual(before);
		expect(f.overlay.reloadBindingEpoch, "a capture from before the rename names the old path and must be retired").not.toBe(epochBefore);
	});
});
