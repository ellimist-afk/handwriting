/**
 * The page id write keeps the text where it was.
 *
 * What it looks like: on a new note with a long paste, the first pen stroke writes the note's page id. Before: the
 * pasted text jumped up off the screen while the scroll stayed put, and the page showed only the ink. Now: the text
 * stays where it was.
 *
 * Rule: just before our page id write, every open editor of that note notes the character at its top edge, its
 * distance from the body's first character and its offset from the edge. When the write reaches that editor (a change
 * holding the id), the anchor is the body's new first character plus that distance, checked by its text; the editor is
 * asked once, after its update and in the same task, for that character at that offset. Nothing is read back and nothing
 * is asked again, in the task or in any frame after. Nothing is asked when the body's first line or the anchor's line is
 * one the editor draws in parts: 20,000 characters or more when lines wrap, 4,000 or more when they do not; there the
 * page stays as the write leaves it (not covered). A pane with no layout is never asked. An anchor is dropped when the
 * claim writes nothing, when another edit comes first, when the page scrolled, when its text reads different, or after
 * 3 s. What is written to the note does not change.
 *
 * The real store (claim, persist) and the real update. The editor is a fake that shows what CodeMirror does with the
 * view's top inside one long wrapped line: Obsidian's reload after the write is one replace range from the start, which
 * leaves the line's height an estimate, so the text in it goes up by the measured jump while the line's own top and the
 * scroll stay flat. A request for a line's top (a scroll snapshot) leaves the text moved; a request for a character in
 * the line lays the line out around it again, except while its heights are still collapsed (a line drawn in parts, or
 * the id block not laid out yet), where it lands off. A layout read while a measure is pending runs that measure first,
 * as CodeMirror's readMeasured does; each measure, read-run or in a frame, settles one step of collapsed heights.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, Transaction, type SelectionRange, type TransactionSpec } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin, inkOverlayExtension, inlineInk, instances } from "./InkOverlay";
import * as reload from "./InkOverlayReload";
import { type MountedOverlay, RigEl, mountOverlay } from "./mountRig.test.util";
import { penEvent } from "../../test/routerHarness";
import { resetPenInkForTest } from "./PenInk";
import { resetTipModeForTest } from "./TipMode";
import { setMouseInk } from "./MouseInk";
import { noteCameras } from "./NoteCamera";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { clearInlinePenTrace, formatInlinePenTrace } from "./InlinePenRouterTrace";
import type { InlineInkHost } from "./InlineInkStore";
import { UnreadableFrontmatterError, claimMarkdown } from "./InlineClaim";
import { SelectionModel } from "../objects/SelectionModel";
import { emptyPage, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const PATH = "page-id-write-keeps-text.md";
const OTHER = "page-id-write-other-note.md";
/** The pasted line's length on the rig's 18,876 case. */
const LONG = 18876;
/** The pasted line's length on the rig's 22,022 case (g7). */
const G7 = 22022;
/** A long pasted line of distinct words, `n` characters. */
const paste = (n: number) => { let s = ""; for (let i = 0; s.length < n; i++) s += `w${i} `; return s.slice(0, n); };
const PASTE = paste(LONG);
/** The 12 Enters: the tail Obsidian's reload leaves out of its one replace range (v15h). */
const TAIL = "\n".repeat(12);
const DOC = PASTE + TAIL;
/** How far the text went up on the rig (v15g), px. */
const JUMP = 2087.4;
/** How far a request lands off while a line drawn in parts has collapsed heights, px. */
const PART_MISS = 782.2;
const SCROLL = 3202.8;
/** The fake's layout: a row is 10 px and holds 50 characters; the scroller's top is at 100 px on screen. */
const ROW = 10, PER_ROW = 50, BOX = 100, LEFT = 40;
/** The view's size, px. */
const VIEW_H = 800, VIEW_W = 1000;

let claims: { path: string; id: string }[] = [];
let landing: { resolve: (r: { pageId: string; futureVersion?: number }) => void; reject: (e: unknown) => void }[] = [];
let readId: string | null = null;
/** The next frame's callbacks, and each editor's measure in that frame (run first, as CodeMirror's own frame is). */
let frames: FrameRequestCallback[] = [];
let measures: (() => void)[] = [];

function stroke(id: string): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2, createdAt: 0,
		points: [{ x: 0, y: 900, pressure: 0.5, t: 0 }, { x: 60, y: 900, pressure: 0.5, t: 8 }],
		bbox: { x: 0, y: 900, width: 60, height: 1 },
	};
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
	claims = [];
	landing = [];
	readId = null;
	frames = [];
	measures = [];
	inlineInk.attachHost({
		readPageId: () => readId,
		claimId: (path, id) => {
			claims.push({ path, id });
			return new Promise((resolve, reject) => landing.push({ resolve, reject }));
		},
		loadSidecar: async (pageId): Promise<ParseResult> => {
			const page = emptyPage(pageId);
			page.surface = "inline";
			return { data: page, recovered: false };
		},
		scheduleSidecar() {},
		notify() {},
	});
});
afterEach(() => {
	instances.clear();
	inlineInk.handleDelete(PATH);
	inlineInk.handleDelete(OTHER);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
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

interface PaneOptions {
	path?: string; scroll?: number; source?: boolean; hidden?: boolean;
	/** Text above the pasted line: body lines, or a frontmatter block. */
	above?: string;
	/** Measures the text's heights stay collapsed after the write: a line drawn in parts, or the id block not laid out yet. */
	parts?: number;
	/** The pasted line's length. */
	long?: number;
	/** Whether the editor wraps lines. */
	wrap?: boolean;
	/** The page's scroll left, px: an Infinite canvas page panned right. */
	left?: number;
	/** Blank page above the text, px. */
	gap?: number;
	/** Where the text's left edge sits in the scroller, px. */
	inset?: number;
	/** The note's zoom: a scale on the editor's DOM, so a screen px is a layout px times this. */
	zoom?: number;
	/** A real pen router for the overlay: the editor then runs its scroll handlers (the issue 66 guard) before each request. */
	router?: unknown;
	/** The scroll handlers run inside the editor's update, where a layout read throws, as CodeMirror 6.38.6's measure runs them. */
	inMeasure?: boolean;
}

/** The scroll handlers our extension puts on an editor, highest first. */
const guardChain = () => EditorState.create({ doc: "a", extensions: inkOverlayExtension() }).facet(EditorView.scrollHandler);

/** The editor's own request path (DocView.scrollIntoView, @codemirror/view 6.38.6): the first handler to answer true takes it. */
function guardTakes(view: unknown, target: { range: SelectionRange }, thrown: unknown[]): boolean {
	for (const h of guardChain()) {
		try {
			if (h(view as EditorView, target.range, target as unknown as Parameters<typeof h>[2])) return true;
		} catch (err) {
			thrown.push(err);
		}
	}
	return false;
}

/** The last line of a leading frontmatter block (its closing fence), 0 when there is none. */
function fenceEnd(doc: EditorState["doc"]): number {
	if (doc.lines < 3 || doc.line(1).text !== "---") return 0;
	for (let n = 2; n < doc.lines; n++) if (doc.line(n).text === "---") return n;
	return 0;
}

/** One open editor of `path`, with an overlay whose every update runs the real update. */
function pane({ path = PATH, scroll = SCROLL, source = false, hidden = false, above = "", parts = 0, long = LONG, wrap = true, left = 0, gap = 0, inset = LEFT, zoom = 1, router, inMeasure = false }: PaneOptions = {}) {
	const dom = editorDom();
	let state = EditorState.create({ doc: above + (long === LONG ? PASTE : paste(long)) + TAIL });
	/** lineFrom: where the pasted line starts; lineTop: its top in the content; drift: how far the text in it went up; domThrows: the page's own box read throws. */
	const screen = { scrollTop: scroll, scrollLeft: left, lineFrom: above.length, lineTop: 0, drift: 0, reads: 0, updateState: 0, collapsed: 0, pending: false, measured: 0, domThrows: false };
	const sent: Transaction[] = [];
	/** Requests a scroll handler took, and what the handlers threw. */
	const taken: object[] = [];
	const thrown: unknown[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	/** The editor's measure: one step of collapsed heights settles. */
	const measure = () => { screen.pending = false; screen.measured++; if (screen.collapsed > 0) screen.collapsed--; };
	const noLayoutRead = () => {
		if (screen.updateState === 2) throw new Error("Reading the editor layout isn't allowed during an update");
		screen.reads++;
		if (screen.pending) measure();
	};
	/** A block line's top in the content: every line above shows in Source mode; Live Preview hides the frontmatter. */
	const blockTop = (pos: number) => {
		const n = state.doc.lineAt(pos).number;
		return (n - 1 - (source ? 0 : Math.min(fenceEnd(state.doc), n - 1))) * ROW;
	};
	/** The pasted line: the first line as long as the paste that starts with its words. */
	const findLine = () => {
		for (let n = 1; n <= state.doc.lines; n++) {
			const line = state.doc.line(n);
			if (line.length >= long && state.doc.sliceString(line.from, line.from + 6) === "w0 w1 ") return line.from;
		}
		return 0;
	};
	screen.lineTop = blockTop(screen.lineFrom);
	measures.push(measure);
	/** Where a position's row sits in the content. */
	const contentY = (pos: number): number => {
		if (pos < screen.lineFrom) return blockTop(pos);
		const at = pos - screen.lineFrom;
		const y = at <= long ? Math.floor(Math.min(at, long - 1) / PER_ROW) * ROW : Math.ceil(long / PER_ROW) * ROW + (at - long - 1) * ROW;
		return screen.lineTop + y - screen.drift;
	};
	const screenTop = (pos: number) => (hidden ? 0 : BOX + (gap + contentY(pos) - screen.scrollTop) * zoom);
	/** The text's left edge on screen. */
	const screenLeft = () => (inset - screen.scrollLeft) * zoom;
	/** The position at a screen height, at the row's start; above the text, its first. */
	const posAt = (y: number): number => {
		if (hidden) return 0;
		const c = (y - BOX) / zoom + screen.scrollTop - gap;
		if (c < 0) return 0;
		if (c < screen.lineTop) return state.doc.line(Math.min(Math.floor(c / ROW) + 1 + (source ? 0 : fenceEnd(state.doc)), state.doc.lines)).from;
		const row = Math.floor((c - screen.lineTop + screen.drift) / ROW);
		return screen.lineFrom + Math.min(row * PER_ROW, long);
	};
	const view = {
		dom,
		plugin: () => overlay,
		get state() { return state; },
		get updateState() { return screen.updateState; },
		get lineWrapping() { return wrap; },
		scrollDOM: {
			get scrollTop() { return screen.scrollTop; }, set scrollTop(v: number) { screen.scrollTop = Math.max(0, v); },
			get scrollLeft() { return screen.scrollLeft; }, set scrollLeft(v: number) { screen.scrollLeft = Math.max(0, v); },
			get clientHeight() { return hidden ? 0 : VIEW_H; }, get clientWidth() { return hidden ? 0 : VIEW_W; },
			get offsetHeight() { return hidden ? 0 : VIEW_H; }, get offsetWidth() { return hidden ? 0 : VIEW_W; },
			getBoundingClientRect: () => (hidden ? { top: 0, left: 0, width: 0, height: 0 } : { top: BOX, left: 0, width: VIEW_W * zoom, height: VIEW_H * zoom }),
		},
		contentDOM: { getBoundingClientRect: () => (hidden ? { left: 0 } : { left: screenLeft() }), contains: () => true },
		posAtCoords: (c: { x: number; y: number }) => { noLayoutRead(); return posAt(c.y); },
		coordsAtPos: (pos: number) => { noLayoutRead(); const top = screenTop(pos), x = screenLeft(); return { top, bottom: top + ROW * zoom, left: x, right: x + zoom }; },
		/** The character's text node; a DOM range over it reads the page's own box, no editor layout read, so it holds inside the update. */
		domAtPos: (pos: number) => {
			if (screen.domThrows) throw new Error("the page's box read failed");
			const rects = () => { const top = screenTop(pos), x = screenLeft(); return [{ top, bottom: top + ROW * zoom, left: x, right: x + zoom, width: zoom, height: ROW * zoom }]; };
			return { node: { nodeType: 3, length: 1, nodeValue: "w", ownerDocument: { createRange: () => ({ setStart() {}, setEnd() {}, getClientRects: rects }) } }, offset: 0 };
		},
		/** CodeMirror's snapshot: the line block at the view's top and its offset; put back, it sets that line's top. */
		scrollSnapshot: () => {
			const from = state.doc.lineAt(posAt(BOX)).from;
			const top = from >= screen.lineFrom ? screen.lineTop : blockTop(from);
			const effect = EditorView.scrollIntoView(EditorSelection.cursor(from), { y: "start", yMargin: top - screen.scrollTop });
			(effect.value as { isSnapshot: boolean }).isSnapshot = true;
			return effect;
		},
		dispatch: (input: Transaction | TransactionSpec) => {
			if (screen.updateState === 2) throw new Error("Calls to EditorView.update are not allowed while an update is in progress");
			const tr = input instanceof Transaction ? input : state.update(input);
			const startState = state;
			state = tr.state;
			sent.push(tr);
			if (tr.docChanged) {
				let atStart = false;
				tr.changes.iterChangedRanges((fromA) => { if (fromA === 0) atStart = true; });
				screen.lineFrom = findLine();
				// A change from the start: the pasted line's height is an estimate again, so the text in it goes up.
				if (atStart) { screen.drift += JUMP; screen.lineTop = blockTop(screen.lineFrom); screen.collapsed = parts; }
			}
			for (const e of tr.effects) {
				const target = e.value as { range?: SelectionRange | { head: number }; isSnapshot?: boolean; yMargin?: number; x?: string; xMargin?: number } | null;
				if (!target || typeof target !== "object" || !target.range || target.yMargin === undefined || !("isSnapshot" in target)) continue;
				const head = target.range.head;
				if (target.isSnapshot) {
					screen.scrollTop = Math.max(0, (head >= screen.lineFrom ? screen.lineTop : blockTop(head)) - target.yMargin);
					continue;
				}
				if (router) {
					if (inMeasure) screen.updateState = 2;
					let took: boolean;
					try { took = guardTakes(view, target as { range: SelectionRange }, thrown); } finally { if (inMeasure) screen.updateState = 0; }
					if (took) { taken.push(target); continue; }
				}
				// A request for a character: the editor lays out the line holding it, then puts its row at the margin, cut to the
				// view's height as CodeMirror does; on collapsed heights the row lands off. Sideways ("nearest"), a character off the
				// view's left or right edge is brought in by the x margin. Zoomed, the move is in screen px and the scroll takes it
				// divided by the scale, and the view's edges on screen are its client size times the scale (scrollRectIntoView).
				if (head >= screen.lineFrom) screen.drift = 0;
				const yMargin = Math.max(Math.min(target.yMargin, VIEW_H), -VIEW_H);
				screen.scrollTop = Math.max(0, screen.scrollTop + (screenTop(head) - (BOX + yMargin)) / zoom);
				if (head >= screen.lineFrom && screen.collapsed > 0) screen.drift = PART_MISS;
				const x = screenLeft(), xMargin = Math.max(Math.min(target.xMargin ?? 5, VIEW_W), -VIEW_W);
				if ((target.x ?? "nearest") === "nearest") {
					if (x < 0) screen.scrollLeft = Math.max(0, screen.scrollLeft + (x - xMargin) / zoom);
					else if (x + zoom > VIEW_W * zoom) screen.scrollLeft += (x + zoom - VIEW_W * zoom + xMargin) / zoom;
				}
			}
			screen.pending = true;
			screen.updateState = 2;
			try {
				overlay.update({
					view, state, startState, transactions: [tr], docChanged: tr.docChanged, changes: tr.changes,
					geometryChanged: false, viewportChanged: false, heightChanged: false,
				} as unknown as ViewUpdate);
			} finally { screen.updateState = 0; }
		},
	};
	Object.assign(overlay, {
		view, container: {} as object | null, panAnchorHold: null, bouncedHold: null, lastPath: path, lastFile: null, destroyed: false,
		filePath: () => path, currentFile: () => null, selection: new SelectionModel(), router: router ?? { isStroking: false },
		scheduleRepaint() {}, redrawSelectionUI() {}, clearSpaceFeedback() {}, updateLineAnchors() {},
		retirePanSettle: vi.fn(),
		mount() { if (!this.container) this.container = {}; },
		unmount() { this.container = null; },
	});
	instances.add(overlay);
	/** The text at the view's top and its row's offset from the top edge (posAtCoords of the edge + 1 px). */
	const top = () => { const p = posAt(BOX + 1); return { pos: p, text: state.doc.sliceString(p, p + 24), offset: Math.round((screenTop(p) - BOX) * 10) / 10 }; };
	return {
		overlay, screen, sent, top, taken, thrown,
		/** A request not ours: the same character, side, edge and margin as `like`, a new object. */
		askLike(like: { range: SelectionRange; y: string; yMargin: number }) {
			view.dispatch({
				effects: EditorView.scrollIntoView(EditorSelection.cursor(like.range.head, like.range.assoc as 1 | -1), { y: like.y as "start", yMargin: like.yMargin }),
				annotations: Transaction.addToHistory.of(false),
			});
		},
		/** The cursor line (the last of the 12 Enters): its top on screen. */
		cursorTop: () => screenTop(state.doc.length),
		/** The pasted line's first character: its top on screen. */
		pasteTop: () => screenTop(screen.lineFrom),
		/**
		 * Obsidian's setViewData after the write (its "set", v15h): one range replaced from the start to the 12 Enters, holding
		 * our write's bytes (claimMarkdown with `id`); `edit` changes those bytes first.
		 */
		writeLands(id: string, edit: (next: string) => string = (next) => next) {
			const old = state.doc.toString();
			const next = edit(claimMarkdown(old, id).content);
			view.dispatch({ changes: { from: 0, to: old.length - TAIL.length, insert: next.slice(0, next.length - TAIL.length) }, userEvent: "set" });
		},
		/** The rig's dry shape: one insert at the start holding the id block. */
		writeLandsAsInsert(id: string) { view.dispatch({ changes: { from: 0, insert: `---\nhandwriting-page-id: ${id}\n---\n` } }); },
		type(text: string, at = state.doc.length) { view.dispatch({ changes: { from: at, insert: text }, userEvent: "input.type" }); },
		/** Runs `work` as if inside this editor's update. */
		inEditorUpdate(work: () => void) {
			screen.updateState = 2; overlay.inUpdate = true;
			try { work(); } finally { screen.updateState = 0; overlay.inUpdate = false; }
		},
		asks: () => sent.filter((tr) => tr.effects.some((e) => typeof e.value === "object" && e.value !== null && "yMargin" in (e.value as object))),
	};
}

/** The pane holds an anchor waiting for the write. */
const held = (e: ReturnType<typeof pane>): boolean =>
	typeof reload.claimAnchorHeldForTest === "function" ? reload.claimAnchorHeldForTest(e.overlay) : false;

/** Everything queued in this task runs; no timer and no frame. */
async function beforePaint() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

/** One frame: each editor's measure, then the frame's callbacks, then what they queued. */
async function frame() {
	for (const measure of measures) measure();
	for (const cb of frames.splice(0)) cb(0);
	await beforePaint();
}

/** The first pen stroke on a note with no id: the store claims it. */
async function firstStroke(path = PATH) {
	await inlineInk.ensureLoaded(path);
	inlineInk.commit(path, stroke("s1"));
}

/** The id the store proposed in its one claim. */
const firstId = () => claims[0]!.id;
/** The claim settles with the proposed id: the write happened. */
const land = () => landing[0]!.resolve({ pageId: firstId() });

/** The text at the top is the same characters at the same offset, within 1 px. */
function expectTextHeld(e: ReturnType<typeof pane>, before: { text: string; offset: number }) {
	const now = e.top();
	expect(now.text, `TEXT MOVED: the top shows "${now.text}" for "${before.text}"`).toBe(before.text);
	expect(Math.abs(now.offset - before.offset), `TEXT MOVED ${Math.round((before.offset - now.offset) * 10) / 10} px within its row`).toBeLessThan(1);
}

describe("the page id write keeps the text in place", () => {
	it("the write reaching the editor before the claim settles: the same text at the top, before paint", async () => {
		const e = pane();
		const before = e.top();
		const cursor = e.cursorTop();
		await firstStroke();
		expect(claims).toHaveLength(1);
		e.writeLands(firstId());
		await beforePaint();
		expectTextHeld(e, before);
		expect(Math.abs(e.cursorTop() - cursor), "the cursor line moved").toBeLessThan(2);
		expect(Math.abs(e.screen.scrollTop - SCROLL), "the scroll moved in Live Preview").toBeLessThan(2);
		land();
		await beforePaint();
		expectTextHeld(e, before);
	});

	it("the write reaching the editor after the claim settles (Obsidian's setViewData about 7 ms later): the same text at the top", async () => {
		const e = pane();
		const before = e.top();
		await firstStroke();
		land();
		await new Promise((r) => setTimeout(r, 7));
		e.writeLands(firstId());
		await beforePaint();
		expectTextHeld(e, before);
	});

	it("the editor is asked for a character inside the long line, not for the line's top", async () => {
		const e = pane();
		const before = e.top();
		await firstStroke();
		e.writeLands(firstId());
		expect(e.asks(), "asked inside the editor's own update").toHaveLength(0);
		await beforePaint();
		const asks = e.asks();
		expect(asks, `TEXT MOVED: ${asks.length} requests`).toHaveLength(1);
		const target = asks[0]!.effects[0]!.value as { range: SelectionRange; isSnapshot: boolean; y: string; yMargin: number };
		expect(target.isSnapshot, "a line-grained snapshot").toBe(false);
		expect(target.y).toBe("start");
		expect(e.screen.lineFrom).toBeGreaterThan(0);
		expect(target.range.head, "the request is the line's start, not the text at the top").toBeGreaterThan(e.screen.lineFrom + 10000);
		expect(e.top().text).toBe(before.text);
		expect(asks[0]!.docChanged).toBe(false);
		expect(asks[0]!.annotation(Transaction.addToHistory)).toBe(false);
	});

	it("each open editor of the note keeps its own text; an editor on another note is not touched", async () => {
		const a = pane();
		const b = pane({ scroll: 1200 });
		const c = pane({ path: OTHER, scroll: 300 });
		const aBefore = a.top(), bBefore = b.top();
		await firstStroke();
		a.writeLands(firstId());
		b.writeLands(firstId());
		await beforePaint();
		expectTextHeld(a, aBefore);
		expectTextHeld(b, bBefore);
		expect(c.screen.reads).toBe(0);
		expect(c.asks()).toHaveLength(0);
	});

	it("the write and the bytes are unchanged: one claim with the store's new id, and the note keeps it", async () => {
		pane();
		await firstStroke();
		expect(claims).toHaveLength(1);
		expect(claims[0]!.path).toBe(PATH);
		land();
		await new Promise((r) => setTimeout(r, 0));
		inlineInk.commit(PATH, stroke("s2"));
		expect(claims, "a second write for the same note").toHaveLength(1);
	});

	it("the view's top at the paste's first character: the anchor stays on the text, not on the new block", async () => {
		const e = pane({ scroll: 0, source: true });
		const before = e.top();
		expect(before.text.startsWith("w0 w1")).toBe(true);
		await firstStroke();
		e.writeLands(firstId());
		await beforePaint();
		expectTextHeld(e, before);
	});

	it("Source mode: the text holds and the scroll moves by the block's three rows", async () => {
		const e = pane({ source: true });
		const before = e.top();
		await firstStroke();
		e.writeLands(firstId());
		await beforePaint();
		expectTextHeld(e, before);
		expect(Math.abs(e.screen.scrollTop - (SCROLL + 3 * ROW)), "the scroll did not move by three rows").toBeLessThan(2);
	});

	it("the pen live when the write lands: the text holds and the page does not move under the pen", async () => {
		const e = pane();
		const before = e.top();
		await firstStroke();
		e.overlay.router.isStroking = true;
		e.writeLands(firstId());
		await beforePaint();
		expectTextHeld(e, before);
		expect(Math.abs(e.screen.scrollTop - SCROLL), "the page moved under the live pen").toBeLessThan(2);
	});

	it("a pane with no layout (a background tab) is never read or asked, and keeps its scroll", async () => {
		const shown = pane();
		const hidden = pane({ scroll: 900, hidden: true });
		const before = shown.top();
		await firstStroke();
		shown.writeLands(firstId());
		hidden.writeLands(firstId());
		await beforePaint();
		expectTextHeld(shown, before);
		expect(hidden.screen.reads, "a pane with no layout was read").toBe(0);
		expect(hidden.asks(), "a pane with no layout was asked").toHaveLength(0);
		expect(hidden.screen.scrollTop).toBe(900);
	});

	it("a claim reached inside the editor's update: no throw, no console error, and the text holds", async () => {
		const e = pane();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const before = e.top();
		await inlineInk.ensureLoaded(PATH);
		e.inEditorUpdate(() => inlineInk.commit(PATH, stroke("s1")));
		expect(claims).toHaveLength(1);
		await beforePaint();
		expect(errors).not.toHaveBeenCalled();
		e.writeLands(firstId());
		await beforePaint();
		expectTextHeld(e, before);
		expect(errors).not.toHaveBeenCalled();
	});

	it("Obsidian's reload is one range replaced over the anchor: the request is the anchor moved by the id block, not the range's end", async () => {
		const e = pane();
		const before = e.top();
		await firstStroke();
		e.writeLands(firstId());
		const write = e.sent[e.sent.length - 1]!;
		const ranges: [number, number][] = [];
		write.changes.iterChangedRanges((fromA, toA) => ranges.push([fromA, toA]));
		expect(ranges, "the fake's write is not one range over the anchor").toHaveLength(1);
		expect(ranges[0]![0]).toBe(0);
		expect(ranges[0]![1]).toBeGreaterThan(before.pos);
		await beforePaint();
		const asks = e.asks();
		expect(asks, `TEXT MOVED: ${asks.length} requests`).toHaveLength(1);
		const head = (asks[0]!.effects[0]!.value as { range: SelectionRange }).range.head;
		const block = claimMarkdown(DOC, firstId()).content.length - DOC.length;
		expect(head, `TEXT MOVED: asked ${head}, the anchor moved by the id block is ${before.pos + block}`).toBe(before.pos + block);
		expectTextHeld(e, before);
	});

	it("the rig's dry shape, one insert at the start: the same text at the top", async () => {
		const e = pane();
		const before = e.top();
		await firstStroke();
		e.writeLandsAsInsert(firstId());
		await beforePaint();
		expectTextHeld(e, before);
	});

	it("a top line that starts inside the replaced range (a short line above the paste): the same text at the top", async () => {
		const e = pane({ above: "A short line above the paste.\n" });
		const before = e.top();
		expect(e.screen.lineFrom).toBeGreaterThan(0);
		await firstStroke();
		e.writeLands(firstId());
		await beforePaint();
		expectTextHeld(e, before);
		expect(Math.abs(e.screen.scrollTop - SCROLL), "the scroll moved in Live Preview").toBeLessThan(2);
	});

	it("a note with its own frontmatter: the id line goes inside it and the same text stays at the top", async () => {
		const e = pane({ above: "---\ntags: draft\n---\n" });
		const before = e.top();
		await firstStroke();
		e.writeLands(firstId());
		await beforePaint();
		expectTextHeld(e, before);
	});

	it("the text already back after the first request: no second request in the frames after", async () => {
		const e = pane();
		const before = e.top();
		await firstStroke();
		e.writeLands(firstId());
		await beforePaint();
		for (let i = 0; i < 5; i++) await frame();
		expect(e.asks(), "asked again with the text in place").toHaveLength(1);
		expectTextHeld(e, before);
	});

	it("one request only: when it lands off (the id block not laid out yet), nothing reads it back or asks again, in the task or after a frame", async () => {
		const e = pane({ parts: 1 });
		await firstStroke();
		const reads = e.screen.reads;
		e.writeLands(firstId());
		await beforePaint();
		expect(e.asks(), "SECOND ASK in the task").toHaveLength(1);
		expect(e.screen.reads, "READ-BACK: the layout was read after the request").toBe(reads);
		expect(frames, "a frame waits to ask again").toHaveLength(0);
		const scroll = e.screen.scrollTop;
		for (let i = 0; i < 5; i++) await frame();
		expect(e.asks(), "SECOND ASK after a frame").toHaveLength(1);
		expect(e.screen.scrollTop, "the scroll was written again after the request").toBe(scroll);
		expect(held(e)).toBe(false);
	});

	it("heights that never settle: still one request, never a second after any frame", async () => {
		const e = pane({ parts: 99 });
		await firstStroke();
		e.writeLands(firstId());
		await beforePaint();
		expect(e.asks(), "SECOND ASK in the task").toHaveLength(1);
		expect(frames, "a frame waits to ask again").toHaveLength(0);
		for (let i = 0; i < 8; i++) await frame();
		expect(e.asks(), "SECOND ASK after a frame").toHaveLength(1);
	});
});

describe("a line the editor draws in parts is never asked for: the page stays as the write leaves it (not covered)", () => {
	/** The write lands on a pane; the number of requests in the task and after five frames, and the layout reads after the write. */
	async function asksAfterWrite(e: ReturnType<typeof pane>) {
		await firstStroke();
		expect(held(e), "no anchor taken before the write").toBe(true);
		const reads = e.screen.reads;
		e.writeLands(firstId());
		await beforePaint();
		const inTask = e.asks().length;
		for (let i = 0; i < 5; i++) await frame();
		return { inTask, afterFrames: e.asks().length, reads: e.screen.reads - reads };
	}

	it("the rig's 22,022 note (g7), lines wrapping: nothing asked or read, and the scroll stays flat", async () => {
		const e = pane({ long: G7, parts: 1 });
		const n = await asksAfterWrite(e);
		expect(n.inTask, `ASK ON A LINE DRAWN IN PARTS: ${n.inTask} requests in the task`).toBe(0);
		expect(n.afterFrames, `ASK ON A LINE DRAWN IN PARTS: ${n.afterFrames} requests after the frames`).toBe(0);
		expect(n.reads, "the layout was read after the write").toBe(0);
		expect(e.screen.scrollTop, "the scroll moved").toBe(SCROLL);
	});

	it("a wrapped line of exactly 20,000 characters: nothing asked", async () => {
		const e = pane({ long: 20000 });
		const n = await asksAfterWrite(e);
		expect(n.afterFrames, `ASK ON A LINE DRAWN IN PARTS: ${n.afterFrames} requests`).toBe(0);
		expect(e.screen.scrollTop).toBe(SCROLL);
	});

	it("a wrapped line of 19,999 characters is drawn whole: one request, and the text holds", async () => {
		const e = pane({ long: 19999 });
		const before = e.top();
		const n = await asksAfterWrite(e);
		expect(n.afterFrames, "a line drawn whole was not asked for").toBe(1);
		expectTextHeld(e, before);
	});

	it("lines not wrapping, a line of exactly 4,000 characters: nothing asked", async () => {
		const e = pane({ long: 4000, wrap: false, scroll: 200 });
		const n = await asksAfterWrite(e);
		expect(n.afterFrames, `ASK ON A LINE DRAWN IN PARTS: ${n.afterFrames} requests`).toBe(0);
		expect(e.screen.scrollTop).toBe(200);
	});

	it("lines not wrapping, a line of 3,999 characters is drawn whole: one request, and the text holds", async () => {
		const e = pane({ long: 3999, wrap: false, scroll: 200 });
		const before = e.top();
		const n = await asksAfterWrite(e);
		expect(n.afterFrames, "a line drawn whole was not asked for").toBe(1);
		expectTextHeld(e, before);
	});

	it("the body's first line drawn in parts (20,000 characters) above a shorter anchor line: nothing asked", async () => {
		const e = pane({ above: `${"x".repeat(20000)}\n` });
		expect(e.top().pos, "the anchor is not on the pasted line").toBeGreaterThan(20000);
		const n = await asksAfterWrite(e);
		expect(n.afterFrames, `ASK UNDER A FIRST LINE DRAWN IN PARTS: ${n.afterFrames} requests`).toBe(0);
		expect(e.screen.scrollTop).toBe(SCROLL);
	});

	it("the anchor's line drawn in parts under a short first line: nothing asked", async () => {
		const e = pane({ above: "A short line above the paste.\n", long: 20000 });
		const n = await asksAfterWrite(e);
		expect(n.afterFrames, `ASK ON A LINE DRAWN IN PARTS: ${n.afterFrames} requests`).toBe(0);
		expect(e.screen.scrollTop).toBe(SCROLL);
	});
});

describe("an anchor that cannot be right is dropped, never asked for", () => {
	it("a note that already has its id: no write, no read, nothing asked", async () => {
		readId = "already-there";
		const e = pane();
		await firstStroke();
		expect(claims).toHaveLength(0);
		expect(e.screen.reads).toBe(0);
		e.type("y");
		await beforePaint();
		expect(e.asks()).toHaveLength(0);
	});

	it("a claim that finds an id on disk writes nothing: the anchor is dropped, and a letter typed at the top asks nothing", async () => {
		const e = pane();
		await firstStroke();
		expect(held(e), "no anchor taken before the write").toBe(true);
		landing[0]!.resolve({ pageId: "on-disk-already" });
		await new Promise((r) => setTimeout(r, 0));
		expect(held(e), "the anchor outlived a claim that wrote nothing").toBe(false);
		e.type("y", 0);
		await beforePaint();
		expect(e.asks()).toHaveLength(0);
	});

	it("a claim on a newer format writes nothing: the anchor is dropped", async () => {
		const e = pane();
		await firstStroke();
		landing[0]!.resolve({ pageId: firstId(), futureVersion: 99 });
		await new Promise((r) => setTimeout(r, 0));
		expect(held(e)).toBe(false);
	});

	it("a claim refused on unreadable frontmatter: the anchor is dropped", async () => {
		const e = pane();
		await firstStroke();
		landing[0]!.reject(new UnreadableFrontmatterError());
		await new Promise((r) => setTimeout(r, 0));
		expect(held(e)).toBe(false);
	});

	it("a claim that fails: the anchor is dropped", async () => {
		const e = pane();
		vi.spyOn(console, "error").mockImplementation(() => {});
		await firstStroke();
		landing[0]!.reject(new Error("disk"));
		await new Promise((r) => setTimeout(r, 0));
		expect(held(e)).toBe(false);
	});

	it("a claim that wrote: the anchor waits for the write to reach the editor", async () => {
		const e = pane();
		await firstStroke();
		land();
		await new Promise((r) => setTimeout(r, 0));
		expect(held(e), "the anchor was dropped before the write reached the editor").toBe(true);
	});

	it("the page scrolled after the pen-up: the scroll is not pulled back", async () => {
		const e = pane();
		await firstStroke();
		e.screen.scrollTop = SCROLL + 240;
		e.writeLands(firstId());
		await beforePaint();
		expect(e.asks()).toHaveLength(0);
		expect(e.screen.scrollTop).toBe(SCROLL + 240);
	});

	it("another edit reached the editor first: nothing asked", async () => {
		const e = pane();
		await firstStroke();
		e.type("y");
		e.writeLands(firstId());
		await beforePaint();
		expect(e.asks()).toHaveLength(0);
	});

	it("the characters at the anchor read different after the write: nothing asked, and the scroll stays", async () => {
		const e = pane();
		const before = e.top();
		await firstStroke();
		e.writeLands(firstId(), (next) => {
			const at = next.length - DOC.length + before.pos;
			return next.slice(0, at) + "X" + next.slice(at + 1);
		});
		await beforePaint();
		expect(e.asks()).toHaveLength(0);
		expect(e.screen.scrollTop).toBe(SCROLL);
		expect(held(e)).toBe(false);
	});

	it("Source mode at the very top of a note with its own frontmatter: no anchor taken inside the frontmatter", async () => {
		const e = pane({ above: "---\ntags: draft\n---\n", scroll: 0, source: true });
		expect(e.top().pos).toBe(0);
		await firstStroke();
		expect(held(e), "an anchor taken inside the frontmatter").toBe(false);
		e.writeLands(firstId());
		await beforePaint();
		expect(e.asks()).toHaveLength(0);
	});

	it("a change that does not hold the id: nothing asked", async () => {
		const e = pane();
		await firstStroke();
		e.writeLands("some-other-id");
		await beforePaint();
		expect(e.asks()).toHaveLength(0);
	});

	it("the write reaching the editor more than 3 s after the pen-up: nothing asked", async () => {
		const e = pane();
		const now = vi.spyOn(performance, "now").mockReturnValue(1000);
		await firstStroke();
		now.mockReturnValue(1000 + 3001);
		e.writeLands(firstId());
		await beforePaint();
		expect(e.asks()).toHaveLength(0);
	});

	it("the pan settle hold does not count the request as a move", async () => {
		const e = pane();
		await firstStroke();
		e.writeLands(firstId());
		e.overlay.retirePanSettle.mockClear();
		e.overlay.panAnchorHold = { issuance: [] };
		await beforePaint();
		expect(e.asks(), "TEXT MOVED: nothing asked").toHaveLength(1);
		expect(e.overlay.retirePanSettle).not.toHaveBeenCalled();
	});

	it("a pan settle hold pending when the write lands: the write's own change retires it, once", async () => {
		const e = pane();
		await firstStroke();
		e.overlay.panAnchorHold = { issuance: [] };
		e.writeLands(firstId());
		await beforePaint();
		expect(e.asks(), "TEXT MOVED: nothing asked").toHaveLength(1);
		expect(e.overlay.retirePanSettle).toHaveBeenCalledTimes(1);
	});
});

describe("an Infinite canvas page: the editor is asked only for a character on screen, and the page never moves sideways", () => {
	/** A short note: four rows of text, then the 12 Enters. */
	const SHORT = 200;

	/** The first stroke, the write reaching the editor, the task, then one frame. */
	async function strokeAndWrite(e: ReturnType<typeof pane>) {
		await firstStroke();
		const anchored = held(e);
		e.writeLands(firstId());
		await beforePaint();
		await frame();
		return anchored;
	}

	it.each([1150, 2500])("the view's top %d px down a short note, on the blank page under the text (c1, c2): no anchor, nothing asked, the scroll stays", async (scroll) => {
		const e = pane({ long: SHORT, scroll });
		expect(e.top().offset, "the fake's top character is not more than a view above the view").toBeLessThan(-VIEW_H);
		const anchored = await strokeAndWrite(e);
		expect(e.screen.scrollTop, `PAGE MOVED: scroll top ${scroll} to ${e.screen.scrollTop}`).toBe(scroll);
		expect(e.screen.scrollLeft).toBe(0);
		expect(e.asks(), "the editor was asked for a character above the view").toHaveLength(0);
		expect(anchored, "an anchor was taken above the view").toBe(false);
	});

	it("the page panned right 1000 px, the view's top on the text's rows (c3): no anchor, nothing asked, scroll left stays 1000 and scroll top stays", async () => {
		const e = pane({ left: 1000 });
		const anchored = await strokeAndWrite(e);
		expect(e.screen.scrollLeft, `PAGE MOVED: scroll left 1000 to ${e.screen.scrollLeft}`).toBe(1000);
		expect(e.screen.scrollTop).toBe(SCROLL);
		expect(e.asks(), "the editor was asked for a character left of the view").toHaveLength(0);
		expect(anchored, "an anchor was taken left of the view").toBe(false);
	});

	it("panned right 41 px, the top character 1 px left of the view's edge: no anchor, nothing asked, scroll left stays 41", async () => {
		const e = pane({ left: 41 });
		const anchored = await strokeAndWrite(e);
		expect(e.screen.scrollLeft, `PAGE MOVED: scroll left 41 to ${e.screen.scrollLeft}`).toBe(41);
		expect(e.asks()).toHaveLength(0);
		expect(anchored, "an anchor was taken 1 px left of the view").toBe(false);
	});

	it("2000 px of blank page above a short note, the view's top 1000 px down: the text's first character is under the view, no anchor, nothing asked, the scroll stays", async () => {
		const e = pane({ long: SHORT, gap: 2000, scroll: 1000 });
		expect(e.top().offset, "the fake's top character is not under the view").toBeGreaterThanOrEqual(VIEW_H);
		const anchored = await strokeAndWrite(e);
		expect(e.screen.scrollTop, `PAGE MOVED: scroll top 1000 to ${e.screen.scrollTop}`).toBe(1000);
		expect(e.asks()).toHaveLength(0);
		expect(anchored, "an anchor was taken under the view").toBe(false);
	});

	it("the text's left edge 1100 px into a 1000 px view, not panned: the top character is right of the view, no anchor, nothing asked, scroll left stays 0", async () => {
		const e = pane({ inset: 1100 });
		const anchored = await strokeAndWrite(e);
		expect(e.screen.scrollLeft, `PAGE MOVED: scroll left 0 to ${e.screen.scrollLeft}`).toBe(0);
		expect(e.asks()).toHaveLength(0);
		expect(anchored, "an anchor was taken right of the view").toBe(false);
	});

	it("panned right 40 px, the top character at the view's left edge: one request, the text holds, scroll left stays 40", async () => {
		const e = pane({ left: 40 });
		const before = e.top();
		const anchored = await strokeAndWrite(e);
		expect(anchored, "no anchor for a character on screen").toBe(true);
		expectTextHeld(e, before);
		expect(e.asks()).toHaveLength(1);
		expect(e.screen.scrollLeft, `PAGE MOVED: scroll left 40 to ${e.screen.scrollLeft}`).toBe(40);
	});

	it("Source mode, panned right 20 px, the text on screen: one request, the text holds, scroll top moves by the id block's three rows only, scroll left stays 20", async () => {
		const e = pane({ left: 20, source: true });
		const before = e.top();
		const anchored = await strokeAndWrite(e);
		expect(anchored, "no anchor for a character on screen").toBe(true);
		expectTextHeld(e, before);
		expect(e.asks()).toHaveLength(1);
		expect(Math.abs(e.screen.scrollTop - (SCROLL + 3 * ROW)), "the scroll did not move by the id block's three rows").toBeLessThan(2);
		expect(e.screen.scrollLeft, `PAGE MOVED: scroll left 20 to ${e.screen.scrollLeft}`).toBe(20);
	});

	describe("the note zoomed off 100%: on screen is the view's size on screen, inside the editor's margin cut", () => {
		it("zoomed to 50%, the text's left edge 1100 px in (550 on screen, a 500 px wide view): no anchor, nothing asked, scroll left stays 0", async () => {
			const e = pane({ inset: 1100, zoom: 0.5 });
			const anchored = await strokeAndWrite(e);
			expect(e.screen.scrollLeft, `PAGE MOVED: scroll left 0 to ${e.screen.scrollLeft}`).toBe(0);
			expect(e.asks(), "the editor was asked for a character right of the view on screen").toHaveLength(0);
			expect(anchored, "an anchor was taken right of the view on screen").toBe(false);
		});

		it("zoomed to 50%, 2000 px of blank page above a short note, the view's top 800 px down: the text's first character 600 px down a 400 px high view, no anchor, nothing asked, the scroll stays", async () => {
			const e = pane({ long: SHORT, gap: 2000, scroll: 800, zoom: 0.5 });
			expect(e.top().offset, "the fake's top character is not under the view on screen, inside its unscaled height").toBe(600);
			const anchored = await strokeAndWrite(e);
			expect(e.screen.scrollTop, `PAGE MOVED: scroll top 800 to ${e.screen.scrollTop}`).toBe(800);
			expect(e.asks(), "the editor was asked for a character under the view on screen").toHaveLength(0);
			expect(anchored, "an anchor was taken under the view on screen").toBe(false);
		});

		it("zoomed to 200%, the text's first character 1200 px down a 1600 px high view: past the editor's 800 px margin cut, no anchor, nothing asked, the scroll stays", async () => {
			const e = pane({ long: SHORT, gap: 1000, scroll: 400, zoom: 2 });
			expect(e.top().offset, "the fake's top character is not past the margin cut").toBe(1200);
			const anchored = await strokeAndWrite(e);
			expect(e.screen.scrollTop, `PAGE MOVED: scroll top 400 to ${e.screen.scrollTop}`).toBe(400);
			expect(e.asks(), "the editor was asked for a character past its margin cut").toHaveLength(0);
			expect(anchored, "an anchor was taken past the margin cut").toBe(false);
		});

		it("zoomed to 200%, the text's first character 600 px down: one request, the text holds, the scroll stays", async () => {
			const e = pane({ long: SHORT, gap: 1000, scroll: 700, zoom: 2 });
			const before = e.pasteTop();
			expect(before - BOX, "the fake's top character is not 600 px down").toBe(600);
			const anchored = await strokeAndWrite(e);
			expect(anchored, "no anchor for a character on screen").toBe(true);
			expect(e.asks()).toHaveLength(1);
			expect(Math.abs(e.pasteTop() - before), `TEXT MOVED ${Math.round((before - e.pasteTop()) * 10) / 10} px`).toBeLessThan(1);
			expect(e.screen.scrollTop, `PAGE MOVED: scroll top 700 to ${e.screen.scrollTop}`).toBe(700);
		});

		it("zoomed to 200%, the text's left edge 600 px in (1200 on screen, a 2000 px wide view): one request, the text holds, scroll left stays 0", async () => {
			const e = pane({ inset: 600, zoom: 2 });
			const before = e.top();
			const anchored = await strokeAndWrite(e);
			expect(anchored, "no anchor for a character on screen").toBe(true);
			expectTextHeld(e, before);
			expect(e.asks()).toHaveLength(1);
			expect(e.screen.scrollLeft, `PAGE MOVED: scroll left 0 to ${e.screen.scrollLeft}`).toBe(0);
		});

		it.each([0.5, 2])("zoomed %s times, the view's top on the text: one request, the text holds, scroll left stays 0", async (zoom) => {
			const e = pane({ zoom });
			const before = e.top();
			const anchored = await strokeAndWrite(e);
			expect(anchored, "no anchor for a character on screen").toBe(true);
			expectTextHeld(e, before);
			expect(e.asks()).toHaveLength(1);
			expect(e.screen.scrollLeft, `PAGE MOVED: scroll left 0 to ${e.screen.scrollLeft}`).toBe(0);
		});
	});
});

describe("with the issue 66 guard: the write's own request goes through in the lift tail, a request not ours is still taken", () => {
	/** A second note whose real overlay lends its real pen router. */
	const RIG = "pen66/page-id-rig.md";
	let rig: MountedOverlay;
	let seen: { el: unknown; type: string; fn: (ev: unknown) => void }[];
	const fire = (type: string, ev: unknown) => {
		const l = seen.find((x) => x.el === rig.scrollDOM && x.type === type);
		if (!l) throw new Error(`the router put no ${type} listener on the scroller`);
		l.fn(ev);
	};
	const pen = { pointerType: "pen", pointerId: 7, x: 40, y: 40 };
	const down = () => fire("pointerdown", penEvent("pointerdown", performance.now(), { ...pen, pressure: 0.5 }));
	const lift = () => fire("pointerup", penEvent("pointerup", performance.now(), { ...pen, buttons: 0, pressure: 0 }));
	const router = () => rig.o.router as { activePenId: number | null; ownershipTailUntil: number; penOff(): boolean };
	const rows = () => formatInlinePenTrace().split("\n").filter((line) => /ms {2}scroll-request-foreign /.test(line));
	type Target = { range: SelectionRange; y: string; yMargin: number };
	const asked = (e: ReturnType<typeof pane>): Target => e.asks()[0]!.effects[0]!.value as Target;

	/** A tool lit, a pen stroke on this note's router, its lift 36 ms before the write lands (g1: 24137.6 to 24173.5). */
	async function strokeThenWrite(e: ReturnType<typeof pane>, beforeWrite: () => void = () => {}) {
		down();
		lift();
		await firstStroke();
		vi.advanceTimersByTime(36);
		expect(router().penOff(), "precondition: a tool is lit").toBe(false);
		expect(router().activePenId, "precondition: the pen is up").toBe(null);
		expect(performance.now(), "precondition: inside the lift tail").toBeLessThan(router().ownershipTailUntil);
		beforeWrite();
		e.writeLands(firstId());
		await beforePaint();
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
		resetPenInkForTest();
		resetTipModeForTest();
		setMouseInk(false);
		noteCameras.clear();
		seen = [];
		vi.spyOn(RigEl.prototype, "addEventListener").mockImplementation(function (this: RigEl, ...a: unknown[]) {
			seen.push({ el: this, type: String(a[0]), fn: a[1] as (ev: unknown) => void });
		});
		rig = mountOverlay(RIG);
		for (const name of ["penDown", "penRaw", "penUp"]) rig.o[name] = () => {};
		setDiagnosticsEnabled(true);
		clearInlinePenTrace();
		vi.advanceTimersByTime(10_000);
	});
	afterEach(() => {
		setDiagnosticsEnabled(false);
		clearInlinePenTrace();
		rig.destroy();
		noteCameras.clear();
		resetPenInkForTest();
		resetTipModeForTest();
		setMouseInk(false);
		vi.useRealTimers();
	});

	it("the pen lifted 36 ms before the write lands (g1): the write's one request goes through, the text holds, no row", async () => {
		const e = pane({ router: rig.o.router });
		const before = e.top();
		await strokeThenWrite(e);
		expect(e.asks(), "one request").toHaveLength(1);
		expect(e.taken, "the write's own request is taken in the scroll handler").toEqual([asked(e)]);
		expectTextHeld(e, before);
		expect(rows(), "a guard row for the write's own request").toEqual([]);
		expect(e.thrown).toEqual([]);
	});

	it("the handlers run inside the editor's update, where a layout read throws (CodeMirror 6.38.6 measure): the write's own request is taken, nothing thrown, the text holds", async () => {
		const e = pane({ router: rig.o.router, inMeasure: true });
		const before = e.top();
		await strokeThenWrite(e);
		expect(e.asks(), "one request").toHaveLength(1);
		expect(e.thrown, "THROWN: the scroll handler read the layout inside the update").toEqual([]);
		expect(e.taken, "DEFAULT: the write's own request went on to the editor's default scroll").toEqual([asked(e)]);
		expectTextHeld(e, before);
		expect(rows(), "a guard row for the write's own request").toEqual([]);
	});

	it("the page's box read throws in the handler: the write's own request is still taken, the scroll stays, one console error", async () => {
		const e = pane({ router: rig.o.router, inMeasure: true });
		const errs = vi.spyOn(console, "error").mockImplementation(() => {});
		let top = -1;
		await strokeThenWrite(e, () => { e.screen.domThrows = true; top = e.screen.scrollTop; });
		expect(e.asks(), "one request").toHaveLength(1);
		expect(e.taken, "DEFAULT: the write's own request went on to the editor's default scroll").toEqual([asked(e)]);
		expect(e.thrown).toEqual([]);
		expect(e.screen.scrollTop, "the scroll moved on a failed read").toBe(top);
		expect(errs.mock.calls.filter((c) => String(c[0]).startsWith("[handwriting] keeping the text after the page id write failed"))).toHaveLength(1);
	});

	it("a request not ours with the write's look (same character, side, edge, margin) in the same window is taken: the page stays, one row", async () => {
		const e = pane({ router: rig.o.router });
		await strokeThenWrite(e);
		const own = asked(e);
		const top = e.screen.scrollTop;
		clearInlinePenTrace();
		e.askLike(own);
		const like = e.sent[e.sent.length - 1]!.effects[0]!.value as Target;
		expect(like, "precondition: a new object").not.toBe(own);
		expect({ head: like.range.head, assoc: like.range.assoc, y: like.y, yMargin: like.yMargin }).toEqual({ head: own.range.head, assoc: own.range.assoc, y: own.y, yMargin: own.yMargin });
		expect(e.taken, "the lookalike was let through").toContain(like);
		expect(e.screen.scrollTop, "the page moved for a request not ours").toBe(top);
		expect(rows()).toEqual([expect.stringContaining("kept, 36 ms since lift")]);
		expect(e.thrown).toEqual([]);
	});
});
