/**
 * C2 red-first cells for audit items 109 and 110.
 * Written red-first behind HANDWRITING_C2_CELLS=1; the fix commit (lane EI2) dropped
 * that condition, so every cell runs. Rig: the real InkOverlayPlugin behind a real CodeMirror
 * EditorState and a stubbed DOM (the InkOverlay-2-2 fixture, copied).
 *
 * 109 (audit 109): a note switch during a held stroke resets the gesture but
 *   never stops the frame ticker; the pen lift then finds no builder and is a
 *   no-op, so the rAF loop runs on. A rename of the open note takes the
 *   `renamedFrom` branch (it keeps the gesture), so
 *   the audit's rename trigger no longer resets anything; the switch is what
 *   still does.
 * 110 (audit 110): a sidecar read that finishes after unmount passes
 *   loadInk's only guard (`filePath() === path`) and updateHandwritingPageClass
 *   creates a fresh MutationObserver on the dead overlay.
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


type Ticker = Priv & { frameTicking: boolean; frameTickToken: unknown; frameRaf: number; loadInk(path: string | null): void; metadataObserver: unknown; pageClassHost: unknown };

describe("C2-109: the frame ticker follows the gesture", () => {
	const live: Priv[] = [];
	afterEach(() => {
		for (const o of live.splice(0)) {
			try { o.destroy(); } catch { /* DOM-less fake */ }
		}
	});
	function holdStroke(f: Fixture): { overlay: Ticker; cancelled: number[] } {
		const overlay = f.overlay as Ticker;
		const cancelled: number[] = [];
		const win = (overlay as unknown as { winRef: { cancelAnimationFrame(n: number): void } }).winRef;
		win.cancelAnimationFrame = (n: number) => void cancelled.push(n);
		// A pen is down: pen-down started the metrics ticker.
		overlay.frameTicking = true;
		overlay.frameTickToken = {};
		overlay.frameRaf = 77;
		return { overlay, cancelled };
	}

	it("control: a scroll update on the same note leaves the running ticker alone", () => {
		const f = mountOverlay(tfile("c2/109-a.md"));
		live.push(f.overlay);
		const { overlay, cancelled } = holdStroke(f);
		overlay.update(scrollUpdate(f));
		expect(overlay.frameTicking).toBe(true);
		expect(cancelled).toEqual([]);
	});

	it("control: renaming the open note mid-stroke keeps the gesture and its ticker (the audit's rename trigger no longer resets it)", () => {
		const oldPath = "c2/109-old.md";
		const file = tfile(oldPath);
		const f = mountOverlay(file);
		live.push(f.overlay);
		const { overlay } = holdStroke(f);
		inlineInk.handleRename(oldPath, "c2/109-new.md");
		file.path = "c2/109-new.md";
		overlay.update(scrollUpdate(f));
		expect(overlay.lastPath).toBe("c2/109-new.md");
		expect(overlay.frameTicking).toBe(true);
	});

	it("a note switch during a held stroke stops the frame ticker", () => {
		const f = mountOverlay(tfile("c2/109-b.md"));
		live.push(f.overlay);
		const { overlay, cancelled } = holdStroke(f);
		f.setFile(tfile("c2/109-other.md"));
		overlay.update(scrollUpdate(f));
		// The switch reset the gesture: the lift that would stop the ticker has nothing to lift.
		expect(overlay.lastPath).toBe("c2/109-other.md");
		expect(overlay.frameTicking, "the rAF loop is still running after the gesture was dropped").toBe(false);
		expect(cancelled).toEqual([77]);
	});
});

describe("C2-110: a sidecar read that finishes after unmount does not revive the metadata observer", () => {
	const observers = { created: 0, live: 0 };
	class CountingObserver {
		private on = false;
		constructor(_cb: unknown) { observers.created++; }
		observe(): void { if (!this.on) { this.on = true; observers.live++; } }
		unobserve(): void {}
		disconnect(): void { if (this.on) { this.on = false; observers.live--; } }
	}
	const prev = (globalThis as unknown as Record<string, unknown>).MutationObserver;
	afterEach(() => {
		(globalThis as unknown as Record<string, unknown>).MutationObserver = prev;
	});

	async function unmountDuringRead(path: string): Promise<Ticker> {
		observers.created = 0;
		observers.live = 0;
		(globalThis as unknown as Record<string, unknown>).MutationObserver = CountingObserver;
		const f = mountOverlay(tfile(path));
		const overlay = f.overlay as Ticker;
		overlay.loadInk(path); // the read is in flight
		overlay.destroy(); // plugin disabled / reloaded meanwhile
		await new Promise((r) => setTimeout(r, 0)); // the read finishes
		return overlay;
	}

	it("control: while mounted, the read's continuation may create the observer", async () => {
		observers.created = 0;
		observers.live = 0;
		(globalThis as unknown as Record<string, unknown>).MutationObserver = CountingObserver;
		const path = "c2/110-live.md";
		const f = mountOverlay(tfile(path));
		const overlay = f.overlay as Ticker;
		overlay.loadInk(path);
		await new Promise((r) => setTimeout(r, 0));
		expect(observers.created).toBe(1);
		expect(observers.live).toBe(1);
		try { overlay.destroy(); } catch { /* DOM-less fake */ }
	});

	it("after destroy() no observer is created or left observing", async () => {
		await unmountDuringRead("c2/110-dead.md");
		expect(observers.live, "an observer is watching the dead overlay's DOM").toBe(0);
		expect(observers.created, "the continuation created an observer after unmount").toBe(0);
	});
});
