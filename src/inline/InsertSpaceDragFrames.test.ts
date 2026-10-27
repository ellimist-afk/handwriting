/**
 * An insert-space drag does the work of one draw per pen sample, and a hover
 * frame asks the rows cache at most once.
 *
 * During a drag the hover feedback frame used to ask the rows cache for the
 * note's rows (the cache misses, because the drag has just moved the strokes,
 * and rebuilds the rows of the whole note), plan a seam it never uses, and
 * draw the selection layer a second time for the same sample. The set of moving
 * strokes is frozen at pen-down, so none of that is read. (The drag now moves
 * only its picture and moves the strokes at the lift; the cells hold the frame
 * to no ask and one draw all the same.)
 *
 * Cells count calls and never time. Real `spaceMove`, `queueSpaceFeedback`,
 * `previewSpace`, `moveLive` and `InsertSpaceRows`, driven the way
 * A2-1-lasso-drag-above-top drives them: an overlay built with Object.create
 * holding only the fields those methods read. Substituted: the draw itself
 * (`redrawSelectionUI` is a counter that keeps its one rows-cache ask, skipped when the frame hands it the rows), `planSpace`, and the animation frame,
 * which the cells run by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Text } from "@codemirror/state";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { InsertSpaceRows } from "./InsertSpace";
import { SelectionModel } from "../objects/SelectionModel";
import { DamageLedger } from "../ink/DamageLedger";
import { StrokeIndex } from "../ink/StrokeIndex";
import { FrontierCache } from "./FrontierCache";
import { resetTipModeForTest, setTipMode } from "./TipMode";
import type { InkStroke } from "../ink/Stroke";

const NOTE = "insert-space-drag-frames.md";
const proto = InkOverlayPlugin.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const s = (x: number, y: number) => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

function stroke(id: string, y: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x: 100, y, pressure: 0.5, t: 0 },
			{ x: 160, y: y + 10, pressure: 0.5, t: 8 },
		],
		bbox: { x: 100, y, width: 60, height: 10 },
		createdAt: 1,
	} as InkStroke;
}

/** Twelve short lines of ink, 30 apart, the first at y = 40. */
const LINES = Array.from({ length: 12 }, (_, i) => stroke(`l${i}`, 40 + i * 30));

const doc = Text.of(["one line of text"]);
let frames: (() => void)[] = [];

function overlay(extra: Record<string, unknown> = {}) {
	const o = Object.create(InkOverlayPlugin.prototype) as Record<string, any>;
	const cache = new InsertSpaceRows();
	Object.assign(o, {
		filePath: () => NOTE,
		scale: 1,
		cssScale: 1,
		cssWidth: 800,
		cssHeight: 600,
		camera: {
			screenToWorld: (x: number, y: number) => ({ x, y }),
			snapshot: { x: 0, y: 0, zoom: 1 },
			zoom: 1,
		},
		selection: new SelectionModel(),
		damage: new DamageLedger(),
		strokeIndex: new StrokeIndex(),
		frontierCache: new FrontierCache(),
		indexDirty: true,
		dragIds: [],
		tail: {},
		container: {},
		mode: "ink",
		view: { state: { doc }, dispatch: () => {} },
		spaceRowsCache: cache,
		spaceFeedbackRaf: null,
		spaceFeedbackKey: null,
		spaceHoverY: null,
		spacePreview: null,
		scheduleRepaint() {},
		repaintPath() {},
		stampInkIdentity: (op: unknown) => op,
		...extra,
	});
	// `winRef` is a getter on the prototype: shadow it with the frame queue.
	Object.defineProperty(o, "winRef", {
		value: { requestAnimationFrame: (cb: () => void) => frames.push(cb), cancelAnimationFrame: () => {} },
	});
	const draws = { n: 0 };
	// The draw is a counter, but it keeps the one line of the real draw that
	// reaches the rows cache (the hover preview is dropped when the ink changed
	// under it), so the asks it makes are counted with the frame's own.
	o.redrawSelectionUI = (rows?: unknown) => {
		draws.n++;
		if (o.spacePreview && !o.spacePlan) rows ?? cache.get(inlineInk.strokes(NOTE));
	};
	return { o, cache, draws };
}

function runFrames(): number {
	const run = frames;
	frames = [];
	for (const cb of run) cb();
	return run.length;
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	frames = [];
	resetTipModeForTest();
	setTipMode("space");
	inlineInk.applyAdd(NOTE, LINES.map((l) => structuredClone(l)));
});
afterEach(() => {
	inlineInk.handleDelete(NOTE);
	resetTipModeForTest();
	vi.unstubAllGlobals();
});

/** What spaceDown leaves behind for a seam at y = 30 above all twelve lines. */
function dragging(o: Record<string, any>): void {
	const plan = { y: 30, from: doc.length, lineHeight: 24, text: false };
	const ids = LINES.map((l) => l.id);
	Object.assign(o, {
		mode: "space",
		spacePlan: { ...plan, doc },
		spaceLineY: 30,
		spaceFromY: 30,
		spaceTotalDy: 0,
		spaceIds: ids,
		spaceBounds: { x: 100, y: 40, width: 60, height: 350 },
		spaceHistoryIdentity: null,
		spacePreview: { plan, doc, moving: ids, staying: [], rows: [] },
	});
}

/** One pen sample of the drag as `penRaw` runs it: the move, then the cursor, which queues the hover frame. */
function sample(o: Record<string, any>, y: number): void {
	proto.spaceMove!.call(o, [s(130, y)]);
	proto.queueSpaceFeedback!.call(o, y);
	runFrames();
}

describe("an insert-space drag that is live", () => {
	it("ten samples: the rows cache is not asked at all", () => {
		const { o, cache } = overlay();
		dragging(o);
		const get = vi.spyOn(cache, "get");

		for (let i = 1; i <= 10; i++) sample(o, 30 + i * 4);

		expect(o.spaceTotalDy, "the drag moved nothing, so this cell proves nothing").toBeGreaterThan(0);
		expect(get, "the hover frame rebuilt the note's rows during a live drag").not.toHaveBeenCalled();
	});

	it("ten samples: the selection layer is drawn once per sample, not twice", () => {
		const { o, draws } = overlay();
		dragging(o);

		for (let i = 1; i <= 10; i++) sample(o, 30 + i * 4);

		expect(draws.n, "a second draw for the same sample").toBe(10);
	});

	it("the pen up draws the selection layer once, not once to drop the preview and again at the release's end", () => {
		const { o, draws } = overlay();
		dragging(o);
		for (let i = 1; i <= 10; i++) sample(o, 30 + i * 4);
		const applied = o.spaceTotalDy as number;
		expect(applied, "premise: the drag moved").toBeGreaterThan(0);
		o.spaceTextChange = () => ({ dy: applied, changes: null });
		// What the pen up reaches besides the insert space: stubbed, so the cell counts only the space branch's draws.
		Object.assign(o, { frame: { end() {} }, retryCanvasOffReset() {}, releaseHeldFontRef() {}, replayDeferredResize() {},
			updateExtent() {}, penCursorEl: null, clearHoverWatchdog() {} });
		o.view.scrollDOM = { classList: { remove() {} } };
		draws.n = 0;
		proto.endPenGesture!.call(o);
		expect(o.mode, "premise: the pen up ended the insert space").toBe("ink");
		expect(o.spacePreview, "the release dropped the preview").toBeNull();
		expect(draws.n, "selection layer draws in the pen up").toBe(1);
	});

	it("ten samples: the hover frame does run and plans nothing", () => {
		const { o } = overlay();
		dragging(o);
		const plan = vi.fn(() => null);
		o.planSpace = plan;
		let ran = 0;
		for (let i = 1; i <= 10; i++) {
			proto.spaceMove!.call(o, [s(130, 30 + i * 4)]);
			proto.queueSpaceFeedback!.call(o, 30 + i * 4);
			ran += runFrames();
		}

		expect(ran, "no frame ran, so the cells above prove nothing").toBe(10);
		expect(plan).not.toHaveBeenCalled();
	});
});

describe("a hover frame with no drag", () => {
	it("over a seam that changed: the rows cache is asked once", () => {
		const { o, cache } = overlay();
		let planY = 30;
		o.planSpace = () => ({ y: planY, from: doc.length, lineHeight: 24, text: false });
		proto.queueSpaceFeedback!.call(o, 30);
		runFrames();
		const get = vi.spyOn(cache, "get");
		planY = 100;

		proto.queueSpaceFeedback!.call(o, 100);
		const ran = runFrames();

		expect(ran).toBe(1);
		expect(o.spacePreview.plan.y, "the seam did not change, so this cell proves nothing").toBe(100);
		expect(get.mock.calls.length, "the frame asked the rows cache more than once").toBe(1);
	});
});
