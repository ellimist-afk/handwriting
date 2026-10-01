/**
 * Insert space at a heading: the ink moves as far as the text beside it.
 *
 * The drag snaps in rows of the seam line's line-height, but the text edit
 * inserts or removes BLANK body lines. At an H1 seam the two heights differ;
 * the ink used to move by heading rows while the text moved by body rows.
 *
 * Rig: the real InkOverlayPlugin.prototype.spaceDown / spaceMove / spaceUp,
 * planSpace, spaceTextBoundary, spaceTextChange, previewSpace and the real
 * inlineInk store (memory mode). Only the browser is modelled: a small layout
 * engine standing in for CodeMirror's DOM geometry, with Obsidian's app.css
 * values: --font-text-size 16px and --line-height-normal 1.5 give a 24 px body
 * row; .HyperMD-header-1 has line-height 1.2 at 1.618em, a 31.0656 px row;
 * a header line carries padding-top var(--p-spacing) = 1rem, 0 after
 * header + blank, and a nonblank line after a header gets 0. Scale 1, css
 * scale 1, document top 0: note units equal screen px. A body-line seam is
 * the control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import type { InkStroke } from "../ink/Stroke";

const BODY = 24; // 16 px * 1.5
const H1 = 1.2 * 1.618 * 16; // 31.0656
const HEADING_PAD = 16; // var(--p-spacing) = 1rem

let serial = 0;
const paths = new Set<string>();
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
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
	const path = `space-heading-${++serial}.md`;
	paths.add(path);
	await inlineInk.ensureLoaded(path);
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
		showSpaceCursor() {}, scheduleRepaint() {}, repaintPath() {}, redrawSelectionUI() {},
	});
	return {
		overlay, path,
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

describe("insert space at an H1 seam moves ink as far as the text", () => {
	it("downward: ink below the seam moves exactly as far as the text beside it", async () => {
		const r = await rig("Intro paragraph\n# Heading\nBody under heading\n");
		const before = r.rows();
		// Preconditions on the model: line 2 is an H1 row, others body rows.
		expect(before.map(x => x.kind)).toEqual(["body", "h1", "body", "body"]);
		const body3Top = before[2]!.textTop; // "Body under heading" text top = 24+16+31.0656
		inlineInk.applyAddLive(r.path, [stroke("above", 4), stroke("beside", body3Top + 4)]);
		const inkBefore = r.inkY("beside");
		const headingFrom = r.state.doc.line(2).from;

		// Touch inside the heading's row box and drag down three H1 rows.
		const plan = r.gesture(50, 3 * H1);
		// Precondition: the seam is the heading line and the step is the H1 height.
		expect(plan.from).toBe(headingFrom);
		expect(plan.lineHeight).toBeCloseTo(H1, 4);
		// Precondition: the text edit inserted three blank lines before the heading.
		expect(r.state.doc.toString()).toBe("Intro paragraph\n\n\n\n# Heading\nBody under heading\n");
		const after = r.rows();
		expect(after.slice(1, 4).map(x => x.kind)).toEqual(["body", "body", "body"]);

		const textMoved = after[5]!.textTop - body3Top; // same line, now line 6
		const inkMoved = r.inkY("beside") - inkBefore;
		// Precondition: "above" did not move, "beside" did.
		expect(r.inkY("above")).toBe(4);
		expect(inkMoved).not.toBe(0);
		// CORRECT behaviour: the ink stays on its line.
		expect(inkMoved, `ink moved ${inkMoved}, text moved ${textMoved}`).toBeCloseTo(textMoved, 1);
	});

	it("upward: closing three blank lines above an H1 moves ink as far as the text", async () => {
		const r = await rig("Intro paragraph\n\n\n\n# Heading\nBody under heading\n");
		const before = r.rows();
		expect(before.map(x => x.kind)).toEqual(["body", "body", "body", "body", "h1", "body", "body"]);
		const bodyTop = before[5]!.textTop;
		inlineInk.applyAddLive(r.path, [stroke("above", 4), stroke("beside", bodyTop + 4)]);
		const inkBefore = r.inkY("beside");

		// Touch inside the heading row box (top 96, text 112) and drag up three H1 rows.
		const plan = r.gesture(122, -3 * H1);
		expect(plan.lineHeight).toBeCloseTo(H1, 4);
		expect(r.state.doc.toString()).toBe("Intro paragraph\n# Heading\nBody under heading\n");
		const after = r.rows();
		const textMoved = after[2]!.textTop - bodyTop;
		const inkMoved = r.inkY("beside") - inkBefore;
		expect(r.inkY("above")).toBe(4);
		expect(inkMoved).not.toBe(0);
		expect(inkMoved, `ink moved ${inkMoved}, text moved ${textMoved}`).toBeCloseTo(textMoved, 1);
	});

	it("control: a body-line seam keeps ink and text together", async () => {
		const r = await rig("Intro paragraph\nSecond line\nThird line\nFourth line\n");
		const before = r.rows();
		const thirdTop = before[2]!.textTop; // 48
		inlineInk.applyAddLive(r.path, [stroke("above", 4), stroke("beside", thirdTop + 4)]);
		const inkBefore = r.inkY("beside");
		const plan = r.gesture(46, 3 * BODY);
		expect(plan.lineHeight).toBe(BODY);
		expect(r.state.doc.toString()).toBe("Intro paragraph\nSecond line\n\n\n\nThird line\nFourth line\n");
		const textMoved = r.rows()[5]!.textTop - thirdTop;
		const inkMoved = r.inkY("beside") - inkBefore;
		expect(inkMoved).not.toBe(0);
		expect(inkMoved).toBeCloseTo(textMoved, 1);
	});
});
