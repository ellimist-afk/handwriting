/**
 * Insert space whose text edit cannot be applied puts the ink back.
 *
 * The drag moves the ink and the same lift edits the text in one transaction.
 * When the dispatch throws, the ink shift had already been saved and the
 * failure was only logged: the ink stayed offset from the lines it belongs to,
 * on disk too, with no word to the user.
 *
 * The rule: the ink goes back exactly where the drag began (as the rollback
 * for an abandoned gesture does), the restored state is saved, and one notice
 * says the space was not made.
 *
 * Rig: the same body-line editor stand-in as the heading-rows cells, with the
 * real spaceDown / spaceMove / spaceUp and the real inlineInk store over a host
 * that records every write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notices = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Notice: class {
			constructor(message: string) {
				notices.messages.push(message);
			}
		},
	};
});

import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { emptyPage, type PageData } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const BODY = 24; // 16 px * 1.5
const H1 = 1.2 * 1.618 * 16;
const HEADING_PAD = 16;

let serial = 0;
const paths = new Set<string>();
beforeEach(() => {
	notices.messages.length = 0;
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	for (const p of paths) inlineInk.handleDelete(p);
	paths.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function stroke(id: string, y: number): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2,
		points: [{ x: 300, y, pressure: 0.5, t: 0 }, { x: 320, y: y + 8, pressure: 0.5, t: 8 }],
		bbox: { x: 300, y, width: 20, height: 8 }, createdAt: 1,
	} as InkStroke;
}

interface Row { n: number; from: number; to: number; top: number; pad: number; lh: number; height: number; textTop: number; kind: "h1" | "body"; el: FakeLine }
interface FakeLine { nodeType: 1; kind: "h1" | "body"; top: number; closest(sel: string): FakeLine | null; getBoundingClientRect(): { top: number; left: number } }

/** Browser stand-in: stacks one visual row per line with Obsidian's CSS. */
function layout(state: EditorState): Row[] {
	const doc = state.doc;
	const rows: Row[] = [];
	let top = 0;
	for (let n = 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		const isH1 = /^# /.test(line.text);
		const blank = line.text.trim() === "";
		const prev = n > 1 ? doc.line(n - 1).text : null;
		const prev2 = n > 2 ? doc.line(n - 2).text : null;
		let pad = 0;
		if (isH1) pad = prev !== null && prev.trim() === "" && prev2 !== null && /^#{1,6} /.test(prev2) ? 0 : HEADING_PAD;
		else if (!blank && prev !== null && /^#{1,6} /.test(prev)) pad = 0; // --p-spacing-empty: 0rem
		const lh = isH1 ? H1 : BODY;
		const kind = isH1 ? "h1" : "body";
		const el: FakeLine = {
			nodeType: 1, kind, top,
			closest(sel: string) { return sel === ".cm-line" ? this : null; },
			getBoundingClientRect() { return { top: this.top, left: 0 }; },
		};
		rows.push({ n, from: line.from, to: line.to, top, pad, lh, height: pad + lh, textTop: top + pad, kind, el });
		top += pad + lh;
	}
	return rows;
}

async function rig(text: string) {
	const path = `space-failed-edit-${++serial}.md`;
	paths.add(path);
	const pageId = `space-failed-edit-id-${serial}`;
	const written: PageData[] = [];
	inlineInk.attachHost({
		readPageId: (p) => (p === path ? pageId : null),
		claimId: async () => ({ pageId }),
		loadSidecar: async () => null,
		scheduleSidecar: (_id, page) => void written.push(page),
		notify() {},
	});
	await inlineInk.ensureLoaded(path);
	let failDispatch = false;
	let state = EditorState.create({ doc: text });
	const rowAtY = (y: number) => {
		const rows = layout(state);
		return rows.find(r => y >= r.top && y < r.top + r.height) ?? (y < 0 ? rows[0]! : rows[rows.length - 1]!);
	};
	const rowAtPos = (pos: number) => {
		const n = state.doc.lineAt(pos).number;
		return layout(state)[n - 1]!;
	};
	const fakeWin = {
		getComputedStyle: (el: FakeLine) => ({ lineHeight: `${el.kind === "h1" ? H1 : BODY}px` }),
		requestAnimationFrame: () => 0, cancelAnimationFrame() {},
	};
	const view = {
		get state() { return state; },
		dom: { isConnected: true, ownerDocument: { defaultView: fakeWin } },
		contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
		documentTop: 0, scaleX: 1, scaleY: 1, defaultLineHeight: BODY,
		posAtCoords: ({ y }: { x: number; y: number }) => rowAtY(y).from,
		coordsAtPos: (pos: number) => { const r = rowAtPos(pos); return { top: r.textTop, bottom: r.textTop + r.lh, left: 0, right: 0 }; },
		domAtPos: (pos: number) => ({ node: rowAtPos(pos).el, offset: 0 }),
		lineBlockAt: (pos: number) => { const r = rowAtPos(pos); return { from: r.from, to: r.to, top: r.top, bottom: r.top + r.height, height: r.height }; },
		dispatch: (input: Transaction | TransactionSpec) => {
			if (failDispatch) throw new Error("injected dispatch failure");
			state = (input instanceof Transaction ? input : state.update(input)).state;
		},
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	Object.assign(overlay, {
		view, container: {}, scale: 1, cssScale: 1, contentStyle: undefined,
		spaceTextEnd: null, spacePreview: null, spacePlan: null, spaceHoverY: null, spaceFeedbackRaf: null,
		spaceIds: [], spaceBounds: null, spaceLineY: null, spaceTotalDy: 0, spaceFromY: 0,
		filePath: () => path,
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }) },
		damage: { addRect() {}, addAll() {} },
		selection: { prune() {} },
		frontierCache: { invalidate() {} },
		showSpaceCursor() {}, scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {},
	});
	return {
		overlay, path, written,
		failNextEdit: () => void (failDispatch = true),
		get state() { return state; },
		rows: () => layout(state),
		inkY: (id: string) => inlineInk.strokes(path).find(s => s.id === id)!.points[0]!.y,
		/** Pen-down at y, drag by `drag` in small steps, lift: the real tool path. */
		gesture(y: number, drag: number) {
			overlay.spaceDown({ x: 300, y, pressure: 0.5, t: 0 }, {} as PointerEvent);
			const plan = overlay.spacePlan;
			const n = 8;
			for (let i = 1; i <= n; i++) overlay.spaceMove([{ x: 300, y: y + drag * i / n, pressure: 0.5, t: i * 8 }]);
			overlay.spaceUp();
			return plan as { y: number; from: number; lineHeight: number; doc: unknown };
		},
	};
}


function lastWrittenY(r: { written: PageData[] }, id: string): number | undefined {
	return r.written.at(-1)?.strokes.find((s) => s.id === id)?.points[0]?.y;
}

describe("insert space whose text edit fails", () => {
	const text = "Intro paragraph\nSecond line\nThird line\nFourth line\n";

	async function dragWithFailingEdit() {
		const r = await rig(text);
		const thirdTop = r.rows()[2]!.textTop; // 48
		inlineInk.applyAddLive(r.path, [stroke("above", 4), stroke("beside", thirdTop + 4)]);
		const start = r.inkY("beside");
		r.failNextEdit();
		r.gesture(46, 3 * BODY);
		return { r, start };
	}

	it("puts the ink back where the drag began", async () => {
		const { r, start } = await dragWithFailingEdit();
		expect(r.state.doc.toString(), "premise: the text did not change").toBe(text);
		expect(r.inkY("beside")).toBe(start);
	});

	it("saves the restored ink, not the shifted ink", async () => {
		const { r, start } = await dragWithFailingEdit();
		expect(r.written.length, "premise: something was saved").toBeGreaterThan(0);
		expect(lastWrittenY(r, "beside")).toBe(start);
	});

	it("tells the user once that the space was not made", async () => {
		await dragWithFailingEdit();
		expect(notices.messages).toHaveLength(1);
	});

	it("control: an edit that works moves the ink with the text and says nothing", async () => {
		const r = await rig(text);
		const thirdTop = r.rows()[2]!.textTop;
		inlineInk.applyAddLive(r.path, [stroke("above", 4), stroke("beside", thirdTop + 4)]);
		const start = r.inkY("beside");
		r.gesture(46, 3 * BODY);
		expect(r.inkY("beside")).toBe(start + 3 * BODY);
		expect(notices.messages).toEqual([]);
	});
});
