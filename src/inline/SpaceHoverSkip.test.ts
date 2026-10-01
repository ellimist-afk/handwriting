/**
 * Insert-space hover skips a frame that would draw what the last one drew.
 *
 * With Insert space picked, every hover frame re-planned the seam (layout
 * queries), rebuilt the preview, cleared the tail canvas and re-stroked every
 * previewed stroke, with no check that anything had changed.
 *
 * Rig: the REAL InkOverlayPlugin.prototype queueSpaceFeedback, planSpace,
 * spaceTextBoundary, previewSpace, redrawSelectionUI, strokesHere and the
 * REAL inlineInk store (memory mode). Only the browser is modelled: a
 * row-per-line layout stand-in for CodeMirror's geometry (24 px rows), a
 * captured requestAnimationFrame, and a counting tail canvas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import type { InkStroke } from "../ink/Stroke";
import { resetTipModeForTest, setTipMode, tipMode } from "./TipMode";

const BODY = 24;
const N_BELOW = 300; // visible strokes below the seam
const N_ABOVE = 2;

let serial = 0;
const paths = new Set<string>();
beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	resetTipModeForTest();
});
afterEach(() => {
	for (const p of paths) inlineInk.handleDelete(p);
	paths.clear();
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	resetTipModeForTest();
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

interface FakeLine { nodeType: 1; top: number; closest(sel: string): FakeLine | null; getBoundingClientRect(): { top: number; left: number } }

async function rig() {
	const path = `space-hover-skip-${++serial}.md`;
	paths.add(path);
	await inlineInk.ensureLoaded(path);
	// 40 one-line paragraphs separated by blank lines: 79 rows of 24 px.
	const text = Array.from({ length: 40 }, (_, i) => `paragraph ${i + 1}`).join("\n\n") + "\n";
	const state = EditorState.create({ doc: text });
	const rowOf = (n: number) => {
		const line = state.doc.line(n), top = (n - 1) * BODY;
		const el: FakeLine = {
			nodeType: 1, top,
			closest(sel: string) { return sel === ".cm-line" ? this : null; },
			getBoundingClientRect() { return { top: this.top, left: 0 }; },
		};
		return { n, from: line.from, to: line.to, top, el };
	};
	const rowAtY = (y: number) => rowOf(Math.min(state.doc.lines, Math.max(1, Math.floor(y / BODY) + 1)));
	const rowAtPos = (pos: number) => rowOf(state.doc.lineAt(pos).number);
	const count = { posAtCoords: 0, coordsAtPos: 0, clearAll: 0, drawSpaceStroke: 0, rafRequests: 0, frames: 0 };
	const pending: FrameRequestCallback[] = [];
	const fakeWin = {
		getComputedStyle: () => ({ lineHeight: `${BODY}px` }),
		requestAnimationFrame: (cb: FrameRequestCallback) => { count.rafRequests++; pending.push(cb); return count.rafRequests; },
		cancelAnimationFrame() {},
	};
	const view = {
		get state() { return state; },
		dom: { isConnected: true, ownerDocument: { defaultView: fakeWin } },
		contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
		documentTop: 0, scaleX: 1, scaleY: 1, defaultLineHeight: BODY,
		posAtCoords: ({ y }: { x: number; y: number }) => { count.posAtCoords++; return rowAtY(y).from; },
		coordsAtPos: (pos: number) => { count.coordsAtPos++; const r = rowAtPos(pos); return { top: r.top, bottom: r.top + BODY, left: 0, right: 0 }; },
		domAtPos: (pos: number) => ({ node: rowAtPos(pos).el, offset: 0 }),
		lineBlockAt: (pos: number) => { const r = rowAtPos(pos); return { from: r.from, to: r.to, top: r.top, bottom: r.top + BODY, height: BODY }; },
	};
	const tail = {
		configureInlineBacking: () => undefined,
		placeInline: () => undefined,
		restoreFullSurface: () => undefined,
		prepareLive: () => undefined,
		clearAll() { count.clearAll++; },
		drawLasso() {},
		drawSpaceStroke() { count.drawSpaceStroke++; return true; },
		drawSpaceDivider() {},
		drawSpaceLabel() {},
		drawSelectionBox() {},
		drawHead() {},
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	Object.assign(overlay, {
		view, container: {}, tail, scale: 1, cssScale: 1, contentStyle: undefined,
		cssWidth: 800, cssHeight: 2000, mode: "ink", lassoActive: false, lassoPts: [], builder: null,
		spaceTextEnd: null, spacePreview: null, spacePlan: null, spaceHoverY: null, spaceFeedbackRaf: null,
		spaceRowsCache: null, spaceLineY: null, spaceTotalDy: 0,
		filePath: () => path,
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 } },
		selection: { bounds: () => null },
	});
	// Ink: two strokes near the top, N_BELOW strokes spread down the visible page.
	const strokes: InkStroke[] = [];
	for (let i = 0; i < N_ABOVE; i++) strokes.push(stroke(`above-${i}`, 10 + i * 20));
	for (let i = 0; i < N_BELOW; i++) strokes.push(stroke(`below-${i}`, 200 + (i % 60) * 25));
	inlineInk.applyAddLive(path, strokes);
	return {
		overlay, count, path,
		/** One hover sample: the real paintPenCursor -> queueSpaceFeedback call. */
		hover(worldY: number) { overlay.queueSpaceFeedback(worldY); },
		/** The browser runs the queued animation frame. */
		frame() { const cbs = pending.splice(0); for (const cb of cbs) { count.frames++; cb(0); } },
	};
}

describe("insert-space hover skips an unchanged frame", () => {
	it("pen slides sideways along one line (same world y): the second frame does no work", async () => {
		setTipMode("space");
		expect(tipMode()).toBe("space");
		const r = await rig();
		expect(inlineInk.strokes([...paths][0]!).length).toBe(N_ABOVE + N_BELOW);

		r.hover(100); r.frame();
		const first = r.overlay.spacePreview;
		// Preconditions: frame 1 planned a text seam and previewed the ink below it.
		expect(first, "frame 1 produced a seam preview").toBeTruthy();
		expect(first.plan.y).toBe(96);
		expect(first.moving.length).toBe(N_BELOW);
		expect(r.count.clearAll).toBe(1);
		expect(r.count.drawSpaceStroke).toBe(N_BELOW);
		const after1 = { ...r.count };

		// Frame 2: identical hover y (horizontal pen motion along the line).
		r.hover(100); r.frame();
		expect(r.count.frames, "precondition: a second hover frame ran").toBe(2);
		const second = r.overlay.spacePreview;
		expect(second.plan, "precondition: the plan is unchanged").toEqual(first.plan);
		expect(second.moving, "precondition: the moving set is unchanged").toEqual(first.moving);
		expect(second.staying).toEqual(first.staying);

		const work = {
			layoutQueries: (r.count.posAtCoords - after1.posAtCoords) + (r.count.coordsAtPos - after1.coordsAtPos),
			canvasClears: r.count.clearAll - after1.clearAll,
			strokesRestroked: r.count.drawSpaceStroke - after1.drawSpaceStroke,
		};
		// CORRECT: an unchanged hover frame costs nothing.
		expect(work, `unchanged frame redid: ${JSON.stringify(work)}`).toEqual({ layoutQueries: 0, canvasClears: 0, strokesRestroked: 0 });
	});

	it("pen jitters 3 px inside one line band (same snapped plan): the frame does no repaint", async () => {
		setTipMode("space");
		const r = await rig();
		r.hover(100); r.frame();
		const first = r.overlay.spacePreview;
		expect(first.plan.y).toBe(96);
		const after1 = { ...r.count };

		r.hover(103); r.frame();
		expect(r.count.frames).toBe(2);
		const second = r.overlay.spacePreview;
		// Precondition: the snapped plan and both sets are identical, so the
		// frame this paints is pixel-identical to the last one.
		expect(second.plan).toEqual(first.plan);
		expect(second.moving).toEqual(first.moving);
		expect(second.staying).toEqual(first.staying);

		const work = {
			canvasClears: r.count.clearAll - after1.clearAll,
			strokesRestroked: r.count.drawSpaceStroke - after1.drawSpaceStroke,
		};
		// CORRECT: the identical frame is not repainted.
		expect(work, `identical frame repainted: ${JSON.stringify(work)}`).toEqual({ canvasClears: 0, strokesRestroked: 0 });
	});

	it("the camera moved under an unchanged hover: the frame redraws", async () => {
		setTipMode("space");
		const r = await rig();
		r.hover(100); r.frame();
		const after1 = { ...r.count };
		r.overlay.camera = { ...r.overlay.camera, snapshot: { x: 0, y: 30, zoom: 1 } };
		r.hover(100); r.frame();
		expect(r.count.clearAll - after1.clearAll, "a moved camera must redraw").toBe(1);
		expect(r.count.drawSpaceStroke - after1.drawSpaceStroke).toBeGreaterThan(0);
	});

	it("the ink changed under an unchanged hover: the frame re-plans and redraws", async () => {
		setTipMode("space");
		const r = await rig();
		r.hover(100); r.frame();
		const first = r.overlay.spacePreview;
		const after1 = { ...r.count };
		inlineInk.applyAddLive(r.path, [stroke("late", 1600)]);
		r.hover(100); r.frame();
		expect(r.count.clearAll - after1.clearAll, "new ink must redraw").toBe(1);
		expect(r.overlay.spacePreview.moving.length, "the new stroke is previewed").toBe(first.moving.length + 1);
	});
});
