/**
 * Attached ink at rest in a read-only view (a Reading view or an embed of the note).
 *
 * While lines are typed above a group, its members can lose their anchors, and a read-only view paints them at their stored
 * place. Once the editor is quiet the anchor pass takes the anchors back. These cells hold what reaches the views then:
 *
 * - The pass tells the note's views once when it set or changed an attached member's anchor, and never when it anchored free
 *   ink alone. The tell is the views' own (embedInkChanged): the editor's ink-changed listeners do not hear it, so a second
 *   editor pane on the note applies nothing at rest.
 * - When the note's line source moves (the metadata cache's "changed" for that path), the views of a note with an attached
 *   group repaint once from the new text, so a view whose text was read before the save does not keep the old lines. A note
 *   with no group, or a path no view shows, gets no repaint.
 *
 * The pass runs on a bare overlay whose anchors are stand-ins: anchorMeasured sets the anchors the cell names, as the real
 * one sets them on the store's own strokes. The repaint on "changed" runs through the plugin's real onload and its real
 * markdown post-processor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./EmbedInk", async (importOriginal) => {
	const real = await importOriginal<typeof import("./EmbedInk")>();
	return { ...real, embedInkChanged: vi.fn(real.embedInkChanged) };
});

import { installFakeWindow } from "../../test/routerHarness";
import HandwritingPlugin from "../main";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { embedInkChanged, initEmbedInkAttachments, onEmbedInkLinesMoved, teardownEmbedInk } from "./EmbedInk";
import { onInkChanged } from "./InkEvents";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke, type LineAnchor } from "../ink/Stroke";

installFakeWindow();
const noop = () => {};
const told = embedInkChanged as unknown as ReturnType<typeof vi.fn>;

/** A stroke through the given points, its box computed. */
function strokeOf(id: string, pts: [number, number][]): InkStroke {
	const points = pts.map(([x, y], i) => ({ x, y, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** The store's record for `path`, emptied and given `strokes`. */
function freshNote(path: string, strokes: InkStroke[]): void {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [] };
	rec.attachments = undefined as unknown as typeof rec.attachments;
	rec.strokes = strokes;
	Object.defineProperty(inlineInk, "persist", { value: () => {}, configurable: true });
}

afterEach(() => {
	teardownEmbedInk();
	told.mockClear();
	vi.restoreAllMocks();
});

describe("the anchor pass tells the note's read-only views", () => {
	const PATH = "reading-rest.md";

	/**
	 * A bare overlay on PATH whose pass, once run, anchors the strokes named in `take`. `members`: the strokes in a readable
	 * group. Answers the pass to run, and every path the editor's ink-changed listeners heard.
	 */
	function overlayOn(members: ReadonlySet<string>, take: ReadonlySet<string>) {
		const timers: (() => void)[] = [];
		const follow = {
			get any() { return members.size > 0; },
			offsetOf: (id: string) => (members.size === 0 ? undefined : members.has(id) ? { dy: 0 } : undefined),
		};
		const anchors = {
			generation: 0,
			follow,
			anchorMeasured(_p: string, src: readonly InkStroke[]): number {
				let n = 0;
				for (const s of src) {
					if (!take.has(s.id)) continue;
					s.lineAnchor = { line: 2, top: 40, y: s.bbox.y, key: 7, width: 600, fontPx: 16 } satisfies LineAnchor;
					n++;
				}
				if (n > 0) this.generation++;
				return n;
			},
		};
		const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
		const order: string[] = [];
		// winRef and lineAnchors are getters on the prototype: own values here.
		Object.defineProperty(overlay, "winRef", { value: { setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; } } });
		Object.defineProperty(overlay, "lineAnchors", { value: anchors });
		Object.assign(overlay, {
			filePath: () => PATH,
			lineDrawnAt: -1e9,
			frame: { locked: false, begin: noop, end: noop },
			builder: null,
			router: null,
			pinchRefScale: null,
			lineOnScreen: () => true,
			lineAnchorPassTimer: 0,
			applyColumnHold: noop,
			lineAnchorsMoved: () => { order.push("editor repaint"); },
			requestLineBoxes: noop,
		});
		const heard: string[] = [];
		const off = onInkChanged((p) => heard.push(p));
		told.mockImplementation(() => { order.push("views told"); });
		const run = () => {
			overlay.armLineAnchorPass(PATH, 300);
			expect(timers).toHaveLength(1);
			timers.shift()!();
			off();
		};
		return { run, heard, order };
	}

	const notes = () => [
		strokeOf("m1", [[10, 90], [60, 110]]),
		strokeOf("m2", [[70, 92], [120, 108]]),
		strokeOf("f1", [[10, 210], [80, 230]]),
	];

	it("a member's anchor taken: the views are told once, after the editor's own repaint, and the editor's listeners hear nothing", () => {
		freshNote(PATH, notes());
		const o = overlayOn(new Set(["m1", "m2"]), new Set(["m1", "m2"]));
		o.run();
		expect(told).toHaveBeenCalledTimes(1);
		expect(told).toHaveBeenCalledWith(PATH);
		expect(o.order).toEqual(["editor repaint", "views told"]);
		expect(o.heard).toEqual([]);
	});

	it("free ink alone anchored: the views are not told", () => {
		freshNote(PATH, notes());
		const o = overlayOn(new Set(["m1", "m2"]), new Set(["f1"]));
		o.run();
		expect(told).not.toHaveBeenCalled();
		expect(o.heard).toEqual([]);
	});

	it("a note with no groups, its old free ink anchored: the views are not told", () => {
		freshNote(PATH, notes());
		const o = overlayOn(new Set(), new Set(["m1", "m2", "f1"]));
		o.run();
		expect(told).not.toHaveBeenCalled();
	});

	it("members and free ink anchored by one pass: one tell; the free stroke's anchor before and after is recorded", () => {
		freshNote(PATH, notes());
		const f1 = inlineInk.strokes(PATH).find((s) => s.id === "f1")!;
		const before = f1.lineAnchor ?? null;
		const o = overlayOn(new Set(["m1", "m2"]), new Set(["m1", "f1"]));
		o.run();
		const after = f1.lineAnchor ?? null;
		console.log(`free ink f1 anchor before ${JSON.stringify(before)} after ${JSON.stringify(after && { line: after.line, top: after.top, y: after.y })}`);
		expect(told).toHaveBeenCalledTimes(1);
		expect(o.heard).toEqual([]);
	});

	it("nothing anchored: the views are not told", () => {
		freshNote(PATH, notes());
		const o = overlayOn(new Set(["m1", "m2"]), new Set());
		o.run();
		expect(told).not.toHaveBeenCalled();
	});

	it("a member whose anchor the pass leaves as it was: the views are not told", () => {
		freshNote(PATH, notes());
		const m1 = inlineInk.strokes(PATH).find((s) => s.id === "m1")!;
		m1.lineAnchor = { line: 2, top: 40, y: m1.bbox.y, key: 7, width: 600, fontPx: 16 } satisfies LineAnchor;
		const o = overlayOn(new Set(["m1", "m2"]), new Set(["f1"]));
		o.run();
		expect(told).not.toHaveBeenCalled();
	});
});

describe("a note's views repaint when its line source moves", () => {
	const classes = { add: noop, remove: noop, contains: () => false, toggle: () => false };
	const doc = { body: { classList: classes, querySelector: () => null, querySelectorAll: () => [], appendChild: noop },
		documentElement: { classList: classes }, head: { appendChild: noop },
		createElement: () => ({ classList: classes, style: {}, appendChild: noop, setAttribute: noop }),
		addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [] };
	Object.assign(globalThis, { document: doc, MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } } });
	Object.assign(window, { document: doc, setInterval, clearInterval,
		matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
		getComputedStyle: () => ({ getPropertyValue: () => "" }) });

	// Obsidian hands a "changed" handler the file, its text and its new cache.
	type Handler = (file: { path: string; extension: string }, data: string, cache: { frontmatter: object; sections: never[] }) => void;
	function app(changed: Handler[]) {
		const adapter = { exists: async () => false, read: async () => "", write: async () => {},
			mkdir: async () => {}, list: async () => ({ files: [], folders: [] }), stat: async () => null,
			remove: async () => {}, rename: async () => {} };
		return { loadLocalStorage: () => null, saveLocalStorage: noop,
			vault: { adapter, on: () => ({}), getFileByPath: () => null,
				getMarkdownFiles: () => [], getFiles: () => [], getAbstractFileByPath: () => null,
				cachedRead: async () => "", configDir: ".obsidian" },
			workspace: { on: () => ({}), onLayoutReady: (fn: () => void) => fn(),
				getLeavesOfType: () => [], getActiveFile: () => null, getActiveViewOfType: () => null,
				activeLeaf: null, iterateAllLeaves: noop, trigger: noop },
			metadataCache: {
				on: (name: string, fn: Handler) => { if (name === "changed") changed.push(fn); return {}; },
				getFileCache: () => null, getCache: () => null,
			},
			keymap: { pushScope: noop, popScope: noop }, scope: {},
			fileManager: { processFrontMatter: async () => {} } };
	}

	type Child = { onload?(): void; onunload?(): void };
	type Callback = (el: HTMLElement, ctx: { sourcePath: string; containerEl: HTMLElement; addChild(child: Child): void;
		getSectionInfo(el: HTMLElement): null }) => void;

	/** The plugin loaded: its markdown post-processor and every metadata "changed" handler it registered. */
	async function loaded() {
		const callbacks: Callback[] = [], changed: Handler[] = [];
		const plugin = new (HandwritingPlugin as unknown as new (a: unknown, m: unknown) => Record<string, unknown> & { onload(): Promise<void> })(app(changed), {});
		Object.assign(plugin, { app: app(changed), manifest: { id: "handwriting", version: "1.5.2", dir: ".obsidian/plugins/handwriting" },
			addCommand: noop, registerView: noop, addSettingTab: noop,
			addRibbonIcon: () => ({ addClass: noop }), registerEvent: noop, registerDomEvent: noop,
			registerInterval: noop, registerEditorExtension: noop,
			registerMarkdownPostProcessor: (cb: Callback) => callbacks.push(cb),
			registerObsidianProtocolHandler: noop, register: noop, showWhatsNewIfDue: noop,
			loadData: async () => ({}), saveData: async () => {} });
		await plugin.onload();
		expect(callbacks).toHaveLength(1);
		return { process: callbacks[0]!, fire: (path: string) => { for (const fn of changed) fn({ path, extension: "md" }, "", { frontmatter: {}, sections: [] }); } };
	}

	/** A Reading view section of `path`, its child loaded. Answers the child, to unload. */
	function readingSection(process: Callback, path: string): Child {
		const root = {
			isConnected: true, parentElement: null, ownerDocument: { defaultView: window },
			classList: { contains: (name: string) => name === "markdown-preview-view" },
			style: { position: "", removeProperty: noop },
			querySelector: () => null, getAttribute: () => null, setAttribute: noop, removeAttribute: noop,
			closest(sel: string): unknown { return sel === ".markdown-preview-view" ? root : null; },
		};
		const section = { isConnected: true, parentElement: root, classList: classes,
			ownerDocument: { defaultView: window, body: doc.body },
			closest(sel: string): unknown { return sel === ".markdown-preview-view" ? root : null; } };
		let child: Child | null = null;
		process(section as unknown as HTMLElement, { sourcePath: path, containerEl: root as unknown as HTMLElement,
			getSectionInfo: () => null, addChild(c) { child = c; c.onload?.(); } });
		expect(child).not.toBeNull();
		return child!;
	}

	const group = { id: "g1", strokeIds: ["m1"], target: { kind: "word", from: 0, to: 4 } };

	// The registry wires the views' groups provider once, at import; afterEach's teardown clears it. Wire it again, as the
	// registry does, so each cell here reads the groups its spies give.
	beforeEach(() => {
		initEmbedInkAttachments((p) => inlineInk.attachments(p));
	});

	it("a note with an attached group, shown in a Reading view: one repaint when its metadata changes", async () => {
		const { process, fire } = await loaded();
		vi.spyOn(inlineInk, "isLoaded").mockReturnValue(true);
		vi.spyOn(inlineInk, "strokes").mockReturnValue([]);
		vi.spyOn(inlineInk, "attachments").mockImplementation((p) => (p === "grouped.md" ? [group as never] : []));
		readingSection(process, "grouped.md");
		told.mockClear();
		fire("grouped.md");
		expect(told.mock.calls.filter(([p]) => p === "grouped.md")).toHaveLength(1);
	});

	it("a note with no group: no repaint when its metadata changes", async () => {
		const { process, fire } = await loaded();
		vi.spyOn(inlineInk, "isLoaded").mockReturnValue(true);
		vi.spyOn(inlineInk, "strokes").mockReturnValue([]);
		vi.spyOn(inlineInk, "attachments").mockReturnValue([]);
		readingSection(process, "plain.md");
		told.mockClear();
		fire("plain.md");
		expect(told).not.toHaveBeenCalled();
	});

	it("a grouped note no view shows: no repaint", async () => {
		const { fire } = await loaded();
		vi.spyOn(inlineInk, "attachments").mockReturnValue([group as never]);
		told.mockClear();
		fire("unshown.md");
		expect(told).not.toHaveBeenCalled();
	});

	it("a rendered section's read text is let go when its note's metadata changes, and not once the section unloaded", async () => {
		const { fire } = await loaded();
		vi.spyOn(inlineInk, "attachments").mockReturnValue([]);
		let drops = 0;
		const stop = onEmbedInkLinesMoved("read.md", () => { drops++; });
		fire("other.md");
		expect(drops).toBe(0);
		fire("read.md");
		expect(drops).toBe(1);
		stop();
		fire("read.md");
		expect(drops).toBe(1);
	});
});
