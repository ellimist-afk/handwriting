/**
 * A lasso resize, rotate or drag draws its preview once per shown frame, from the newest pen sample.
 *
 * A 240 Hz pen sends about four samples per 60 Hz frame. Each sample updates the gesture's state at once and asks for one
 * animation frame; the frame draws the picture once, from the state the last sample left. The lift draws the final sample
 * before it commits, while the picture still rides the tail, so the ink lands where it was last seen. An overlay torn down
 * before the frame draws nothing.
 *
 * Cells count the selection boxes drawn and compare each with the gesture's state; they never time. Real `lassoDown`,
 * `lassoMove`, `lassoUp`, `commitLiveDrag`, `redrawSelectionUI`, `selectionFrame` and `SelectionModel` on an overlay built with
 * Object.create, as LassoDragPicture.test.ts builds it. Substituted: the window's animation frames (a queue the cell runs), the
 * layer that draws (a proxy that draws nothing and records each selection box with its transform step, as the redraw passed
 * them), the repaint asks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { InsertSpaceRows } from "./InsertSpace";
import { SelectionModel } from "../objects/SelectionModel";
import { DamageLedger } from "../ink/DamageLedger";
import { StrokeIndex } from "../ink/StrokeIndex";
import { FrontierCache } from "./FrontierCache";
import type { InkStroke } from "../ink/Stroke";
import { handlePoints, type TransformHandle } from "./LassoTransform";

const NOTE = "transform-preview-frame.md";
const proto = InkOverlayPlugin.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const s = (x: number, y: number) => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

function stroke(id: string, x: number, y: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points: [
			{ x, y, pressure: 0.5, t: 0 },
			{ x: x + 30.25, y: y + 10.125, pressure: 0.5, t: 8 },
			{ x: x + 11.7, y: y + 3.3, pressure: 0.5, t: 16 },
		],
		bbox: { x, y, width: 30.25, height: 10.125 },
		createdAt: 1,
	} as InkStroke;
}

const K = 1.8257;
const SELECTED = ["a", "b", "c"];
const ALL = [stroke("a", 100.1, 160.3), stroke("b", 140.7, 190.9), stroke("c", 120.3, 220.2), stroke("other", 400, 40)];

type Frame = { box: unknown; step: unknown };
type Drawn = Frame & { snapshot: boolean };

function overlay() {
	const o = Object.create(InkOverlayPlugin.prototype) as Record<string, any>;
	const noop = () => {};
	// The window's animation frames: queued, run when the cell says a frame is shown.
	const frames = new Map<number, () => void>();
	let next = 1;
	const win = {
		requestAnimationFrame: (cb: () => void) => { const id = next++; frames.set(id, cb); return id; },
		cancelAnimationFrame: (id: number) => { frames.delete(id); },
	};
	Object.defineProperty(o, "winRef", { value: win });
	const drawn: Drawn[] = [];
	Object.assign(o, {
		filePath: () => NOTE,
		view: { dom: null },
		container: {},
		scale: 1,
		cssScale: 1,
		cssWidth: 800,
		cssHeight: 600,
		camera: { screenToWorld: (x: number, y: number) => ({ x, y }), snapshot: { x: 0, y: 0, zoom: 1 }, zoom: 1 },
		committedBacking: K,
		dpr: K,
		selection: new SelectionModel(),
		damage: new DamageLedger(),
		strokeIndex: new StrokeIndex(),
		frontierCache: new FrontierCache(),
		indexDirty: true,
		dragIds: [],
		dragFrom: null,
		dragTotal: null,
		dragBox: null,
		dragHistoryIdentity: null,
		lassoActive: false,
		lassoPts: [],
		builder: null,
		tail: new Proxy({}, {
			get: (_t, name) => name === "drawSelectionBox"
				? (_cam: unknown, box: unknown, _colour: unknown, _handles: unknown, step?: unknown) => {
					drawn.push({ box: structuredClone(box), step: structuredClone(step ?? null), snapshot: !!o.spaceSnapshot });
				}
				: noop,
		}),
		band: null,
		paintedStrokeCount: 0,
		spaceSnapshot: null,
		spacePreview: null,
		spacePlan: null,
		spaceTotalDy: 0,
		spaceRowsCache: new InsertSpaceRows(),
		spaceFeedbackRaf: null,
		selectionPreviewRaf: null,
		repaintQueued: false,
		pinchPreview: null,
		scheduleRepaint: noop,
		repaintPath: noop,
		dropExtentBuild: noop,
		showLassoCursor: noop,
		dressTail: noop,
		dispatchInk: noop,
		retakeLineAnchors: noop,
		noteStrokes: (p: string) => inlineInk.strokes(p),
	});
	o.selection.selectExactly(SELECTED);
	/** Show one frame: run every queued frame callback once. */
	const frame = () => { const cbs = [...frames.values()]; frames.clear(); for (const cb of cbs) cb(); };
	/** What the newest state would draw now. */
	const state = (): Frame => {
		const f = proto.selectionFrame!.call(o) as { box: unknown; step?: unknown } | null;
		return { box: structuredClone(f?.box ?? null), step: structuredClone(f?.step ?? null) };
	};
	return { o, drawn, frame, frames, state };
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
	inlineInk.applyAdd(NOTE, ALL.map((st) => structuredClone(st)));
});
afterEach(() => {
	inlineInk.handleDelete(NOTE);
	vi.unstubAllGlobals();
});

/** Grab the selection: inside the box for the drag, on the handle for a resize or a turn. Returns the grab point. */
function grab(o: Record<string, any>, gesture: "drag" | TransformHandle): { x: number; y: number } {
	const box = proto.selectionBounds!.call(o) as { x: number; y: number; width: number; height: number };
	const at = gesture === "drag" ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : handlePoints(box, 1)[gesture];
	proto.lassoDown!.call(o, s(at.x, at.y), "pen");
	expect(o.spaceSnapshot?.kind, "premise: the grab carries the selection as a picture").toBe("lasso");
	expect(!!o.spaceSnapshot?.transform, `premise: the grab ${gesture === "drag" ? "is a drag" : "began a transform"}`).toBe(gesture !== "drag");
	return at;
}

const GESTURES = [["a drag", "drag"], ["a resize from the se corner", "se"], ["a turn from the knob", "rotate"]] as const;

describe("the preview between two shown frames", () => {
	it.each(GESTURES)("%s: four samples draw nothing until the frame, and the frame draws once, from the fourth", (_name, gesture) => {
		const { o, drawn, frame, state } = overlay();
		const at = grab(o, gesture);
		for (let f = 1; f <= 3; f++) {
			drawn.length = 0;
			let first: ReturnType<typeof state> | null = null;
			for (let i = 1; i <= 4; i++) {
				const n = (f - 1) * 4 + i;
				proto.lassoMove!.call(o, [s(at.x + n * 3.3, at.y + n * 2.1)]);
				if (i === 1) first = state();
			}
			expect(drawn.length, `frame ${f}: the samples drew the picture before the frame`).toBe(0);
			const newest = state();
			expect(newest, `frame ${f}: the four samples left the same state as the first, so this cell proves nothing`).not.toEqual(first);
			frame();
			expect(drawn.length, `frame ${f}: the frame drew the picture this many times`).toBe(1);
			expect({ box: drawn[0]!.box, step: drawn[0]!.step }, `frame ${f}: the frame drew a state older than the newest sample`).toEqual(newest);
		}
	});
});

describe("the lift", () => {
	it.each(GESTURES)("%s: a sample not yet drawn is drawn once at the lift, before the commit, and no frame draws after", (_name, gesture) => {
		const { o, drawn, frame, frames, state } = overlay();
		const at = grab(o, gesture);
		for (let n = 1; n <= 6; n++) proto.lassoMove!.call(o, [s(at.x + n * 3.3, at.y + n * 2.1)]);
		frame();
		proto.lassoMove!.call(o, [s(at.x + 40, at.y + 31)]);
		const last = state();
		drawn.length = 0;
		proto.lassoUp!.call(o);
		const before = drawn.filter((d) => d.snapshot);
		expect(before.length, "the lift drew the picture this many times while it still rode the tail").toBe(1);
		expect({ box: before[0]!.box, step: before[0]!.step }, "the lift drew a state older than the final sample").toEqual(last);
		expect(o.spaceSnapshot, "premise: the lift committed").toBeNull();
		expect(frames.size, "a preview frame is still queued after the lift").toBe(0);
		drawn.length = 0;
		frame();
		expect(drawn.length, "a frame drew the picture after the lift").toBe(0);
	});

	it("a synchronous redraw mid-gesture (Escape's) drops the pending frame", () => {
		const { o, frame, frames } = overlay();
		const at = grab(o, "drag");
		proto.lassoMove!.call(o, [s(at.x + 9, at.y + 7)]);
		expect(frames.size, "premise: the sample asked for a frame").toBe(1);
		proto.redrawSelectionUI!.call(o);
		expect(frames.size, "the pending frame survived a redraw that drew the newest state").toBe(0);
		frame();
		expect(o.selectionPreviewRaf, "the frame id was kept after the drop").toBeNull();
	});
});

describe("an overlay torn down with a preview frame pending", () => {
	it.each(GESTURES)("%s: the frame draws nothing", (_name, gesture) => {
		const { o, drawn, frame, frames } = overlay();
		const at = grab(o, gesture);
		proto.lassoMove!.call(o, [s(at.x + 12, at.y + 9)]);
		expect(frames.size, "premise: the sample asked for a frame").toBe(1);
		drawn.length = 0;
		o.container = null; // what teardown leaves
		frame();
		expect(drawn.length, "a torn-down overlay drew the picture").toBe(0);
	});
});

describe("the real unmount with a preview frame pending", () => {
	it("cancels the frame and clears its id, so nothing is left queued against the dead overlay", () => {
		// The constructor and destroy() -> unmount() run for real, on the rig UnmountReleasesBackings.test.ts builds.
		const noop = (): undefined => undefined;
		const el = (extra: Record<string, unknown> = {}) => ({
			setCssStyles: noop, remove: noop,
			classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
			style: { removeProperty: noop, setProperty: noop },
			...extra,
		});
		const frames = new Map<number, () => void>();
		let next = 1;
		const win = {
			devicePixelRatio: 2,
			CSS: { supports: () => false },
			getComputedStyle: () => ({ fontSize: "16px", paddingTop: undefined, position: "relative" }),
			setTimeout: () => 0,
			clearTimeout: noop,
			requestAnimationFrame: (cb: () => void) => { const id = next++; frames.set(id, cb); return id; },
			cancelAnimationFrame: (id: number) => { frames.delete(id); },
		};
		const view = {
			dom: el({ ownerDocument: { defaultView: win }, parentElement: el() }),
			scrollDOM: el({ scrollLeft: 0, scrollTop: 0, clientWidth: 0, clientHeight: 0, scrollWidth: 0, scrollHeight: 0,
				addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
			contentDOM: el({ children: [], getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }) }),
			scaleX: 1, scaleY: 1, documentTop: 0,
			state: { field: () => undefined },
		};
		const o = new InkOverlayPlugin(view as never) as unknown as Record<string, any>;
		o.container = el();
		o.filePath = () => NOTE;
		o.updateHandwritingPageClass = noop;
		o.updateExtent = noop;
		o.repaintPath = noop;
		let drew = 0;
		const id = win.requestAnimationFrame(() => { drew++; });
		o.selectionPreviewRaf = id;
		expect(frames.has(id), "premise: the preview frame is queued").toBe(true);

		(o.destroy as () => void)();

		expect(o.container, "premise: unmount ran").toBeNull();
		expect([frames.has(id), o.selectionPreviewRaf], "after unmount the preview frame is still queued, or its id kept").toEqual([false, null]);
		for (const cb of [...frames.values()]) cb();
		expect(drew, "the pending preview frame ran after unmount").toBe(0);
	});
});
