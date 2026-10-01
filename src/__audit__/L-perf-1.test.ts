/**
 * Audit probe L-perf-1 (1.4.21 @ 1a05f62c). Read-only audit; this file is the
 * only one written.
 *
 * CLAIM: the `.cm-content` ResizeObserver (InkOverlay.ts:2438-2442) calls
 * `scheduleRepaint("content-resize")` unconditionally, so a content-height
 * change with the camera standing still (Enter, a wrap, a CM height fix)
 * clears and redraws the whole committed layer and dirties the stroke index.
 *
 * HOW: a REAL overlay (`new InkOverlayPlugin`, every field initialiser runs),
 * then the real `mount()` against a DOM-free fake editor. The global
 * `ResizeObserver` is a capturing stand-in, so the exact closure mount wires
 * to `view.contentDOM` is the one this file fires. `InlinePenRouter` is
 * replaced with an inert stub (same seam as MoveRateInstrument.test.ts).
 * `drawCommitted` / `drawRegion` are wrapped only to COUNT calls; the real
 * functions still run. Repaints go through the real `scheduleRepaint` and the
 * real `repaint()` via the captured requestAnimationFrame queue.
 *
 * The assertions state the CORRECT behaviour: with the camera and band
 * unchanged, a content resize must not redraw the whole committed layer nor
 * dirty the index. Red means the claim reproduces on production code.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const g = vi.hoisted(() => {
	const G = globalThis as unknown as Record<string, unknown>;
	G.window ??= globalThis;
	const observers: Array<{ cb: () => void; targets: unknown[] }> = [];
	class CapturingResizeObserver {
		cb: () => void;
		targets: unknown[] = [];
		constructor(cb: () => void) {
			this.cb = cb;
			observers.push(this);
		}
		observe(t: unknown): void {
			this.targets.push(t);
		}
		unobserve(): void {}
		disconnect(): void {}
	}
	class NoopObserver {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
		takeRecords(): unknown[] {
			return [];
		}
	}
	G.ResizeObserver = CapturingResizeObserver;
	G.MutationObserver ??= NoopObserver;
	return { observers, counts: { drawCommitted: 0, drawRegion: 0 } };
});

vi.mock("../inline/InlinePenRouter", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../inline/InlinePenRouter")>();
	class InertRouter {
		isStroking = false;
		constructor() {}
		dispose(): void {}
		refreshRect(): void {}
		cameraTransformChanged(): void {}
		setCanvasMomentumDisabled(): void {}
	}
	return { ...actual, InlinePenRouter: InertRouter };
});

vi.mock("../ink/StrokeRenderer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../ink/StrokeRenderer")>();
	return {
		...actual,
		drawCommitted: (...args: Parameters<typeof actual.drawCommitted>) => {
			g.counts.drawCommitted++;
			return actual.drawCommitted(...args);
		},
		drawRegion: (...args: Parameters<typeof actual.drawRegion>) => {
			g.counts.drawRegion++;
			return actual.drawRegion(...args);
		},
	};
});

import { InkOverlayPlugin, inlineInk } from "../inline/InkOverlay";
import { computeBBox, type InkPoint, type InkStroke } from "../ink/Stroke";

const noop = (): void => undefined;
const PATH = "audit/L-perf-1.md";

interface CtxStats {
	calls: Record<string, number>;
	fullClears: number;
}
const statsOf = new WeakMap<object, CtxStats>();

function countingCtx(canvas: Record<string, unknown>): object {
	const stats: CtxStats = { calls: {}, fullClears: 0 };
	const props: Record<string | symbol, unknown> = {};
	const ctx = new Proxy(
		{},
		{
			get(_t, key) {
				if (key in props) return props[key];
				if (key === "canvas") return canvas;
				if (key === "then") return undefined;
				return (...args: unknown[]) => {
					const k = String(key);
					stats.calls[k] = (stats.calls[k] ?? 0) + 1;
					if (k === "clearRect" && args[0] === 0 && args[1] === 0) stats.fullClears++;
					if (k === "getTransform") return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
					if (k === "getImageData") return { data: new Uint8ClampedArray(16) };
					return undefined;
				};
			},
			set(_t, key, value) {
				props[key] = value;
				return true;
			},
		}
	);
	statsOf.set(ctx, stats);
	return ctx;
}

type El = Record<string, unknown>;

function baseEl(doc: El | undefined): El {
	const style: Record<string, unknown> = { removeProperty: noop, setProperty: noop, getPropertyValue: () => "", visibility: "" };
	const el: El = {
		ownerDocument: doc,
		style,
		classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
		setCssStyles: (s: Record<string, unknown>) => Object.assign(style, s),
		setCssProps: noop,
		setAttribute: noop,
		removeAttribute: noop,
		addEventListener: noop,
		removeEventListener: noop,
		remove: noop,
		detach: noop,
		appendChild: noop,
		insertBefore: noop,
		contains: () => false,
		querySelector: () => null,
		querySelectorAll: () => [],
		closest: () => null,
		children: [],
		parentElement: null,
		isConnected: true,
		offsetWidth: 800,
		offsetHeight: 600,
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
	};
	el.createDiv = () => baseEl(doc);
	el.createSpan = () => baseEl(doc);
	el.createEl = (tag: string) => (tag === "canvas" ? fakeCanvas(doc) : baseEl(doc));
	return el;
}

function fakeCanvas(doc: El | undefined): El {
	const c = baseEl(doc);
	c.width = 0;
	c.height = 0;
	let ctx: object | null = null;
	c.getContext = () => (ctx ??= countingCtx(c));
	return c;
}

/** A `.cm-line` the origin scan accepts (same shape as OriginLineObserved.test.ts). */
function fakeLine(left: number): El {
	return {
		classList: { contains: (c: string) => c === "cm-line" },
		children: [],
		querySelector: () => null,
		matches: () => false,
		isConnected: true,
		getBoundingClientRect: () => ({ left, top: 0, width: 700, height: 24, right: left + 700, bottom: 24 }),
	};
}

function stroke(id: string, tool: "pen" | "highlighter", x: number, y: number): InkStroke {
	const points: InkPoint[] = [];
	for (let i = 0; i < 12; i++) points.push({ x: x + i * 6, y: y + (i % 3) * 2, pressure: 0.5, t: i * 8 });
	return { id, tool, color: "#000000", width: 2, points, bbox: computeBBox(points, 2), createdAt: 0 };
}

interface Rig {
	overlay: Record<string, unknown> & { scheduleRepaint(via?: string): void };
	fireContentResize(): void;
	flush(): number;
	grow(px: number): void;
	penCtx: CtxStats;
	hlCtx: CtxStats;
	mountError: unknown;
	hasContentObserver: boolean;
}

function makeRig(): Rig {
	const raf: Array<() => void> = [];
	const win: El = {
		setTimeout: () => 1,
		clearTimeout: noop,
		setInterval: () => 1,
		clearInterval: noop,
		getComputedStyle: () => ({ position: "relative", fontSize: "16px", overflowX: "auto", overflowY: "auto", getPropertyValue: () => "" }),
		requestAnimationFrame: (cb: () => void) => {
			raf.push(cb);
			return raf.length;
		},
		cancelAnimationFrame: noop,
		devicePixelRatio: 1,
		matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
	};
	const doc: El = { defaultView: win };
	doc.body = baseEl(doc);

	// A long note scrolled into its middle: the band's placement does not
	// depend on the note's total height here, as in a real long note.
	const scroll = { top: 2000, height: 6000 };
	let contentHeight = 6000;

	const scroller = baseEl(doc);
	// defineProperty, not Object.assign: assign would snapshot the getters.
	Object.defineProperty(scroller, "scrollTop", { get: () => scroll.top, set: () => undefined });
	Object.defineProperty(scroller, "scrollHeight", { get: () => scroll.height });
	Object.assign(scroller, {
		scrollLeft: 0,
		scrollWidth: 800,
		clientWidth: 800,
		clientHeight: 600,
	});
	// The overlay container lives inside the scroller at the band's content
	// coordinates; its screen rect follows the band `syncBand` writes.
	const container = baseEl(doc);
	const cstyle = container.style as Record<string, string>;
	const px = (v: unknown): number => Number.parseFloat(String(v ?? "0")) || 0;
	container.getBoundingClientRect = () => {
		const left = px(cstyle.left) - (scroller.scrollLeft as number);
		const top = px(cstyle.top) - scroll.top;
		const width = px(cstyle.width);
		const height = px(cstyle.height);
		return { left, top, width, height, right: left + width, bottom: top + height };
	};
	Object.defineProperty(container, "offsetWidth", { get: () => px(cstyle.width) });
	Object.defineProperty(container, "offsetHeight", { get: () => px(cstyle.height) });
	scroller.createDiv = (o?: { cls?: string }) => (o?.cls === "handwriting-ink-overlay" ? container : baseEl(doc));

	const lines = [fakeLine(40), fakeLine(40), fakeLine(40)];
	const contentDOM = baseEl(doc);
	Object.assign(contentDOM, {
		children: lines,
		firstElementChild: lines[0],
		getBoundingClientRect: () => ({
			left: 0,
			top: -scroll.top,
			width: 800,
			height: contentHeight,
			right: 800,
			bottom: -scroll.top + contentHeight,
		}),
	});

	// Satisfies ownsMarkdownEditorRoot, exactly as MoveRateInstrument.test.ts does.
	const dom = baseEl(doc);
	const root = baseEl(doc);
	root.querySelector = (sel: string) => (sel === ".cm-editor" ? dom : null);
	dom.closest = (sel: string) => (sel === ".markdown-source-view" ? root : null);
	dom.parentElement = { closest: () => null };

	let info: unknown = undefined;
	const view = {
		dom,
		scrollDOM: scroller,
		contentDOM,
		hasFocus: false,
		focus: noop,
		get documentTop() {
			return -scroll.top;
		},
		scaleX: 1,
		scaleY: 1,
		state: { field: () => info },
		requestMeasure: noop,
		dispatch: noop,
	};

	// Constructed with no editor info: mount()'s own cheap exit.
	const overlay = new InkOverlayPlugin(view as never) as unknown as Rig["overlay"];
	// Now a file-backed note editor; no `app`, so the pen-tools strip bails.
	info = { file: { path: PATH } };
	let mountError: unknown = null;
	try {
		(overlay as unknown as { mount(): void }).mount();
	} catch (e) {
		mountError = e;
	}

	const contentObserver = g.observers.find((o) => o.targets.includes(contentDOM));
	const penCtx = statsOf.get(overlay.committedCtx as object)!;
	const hlCtx = statsOf.get(overlay.highlightCtx as object)!;

	return {
		overlay,
		mountError,
		hasContentObserver: contentObserver !== undefined,
		penCtx,
		hlCtx,
		fireContentResize: () => {
			if (!contentObserver) throw new Error("no ResizeObserver was wired to view.contentDOM");
			contentObserver.cb();
		},
		flush: () => {
			let frames = 0;
			while (raf.length > 0 && frames < 50) {
				const cb = raf.shift()!;
				cb();
				frames++;
			}
			return frames;
		},
		grow: (d: number) => {
			contentHeight += d;
			scroll.height += d;
		},
	};
}

describe("L-perf-1: .cm-content resize with a still camera", () => {
	let rig: Rig;
	const snap = () => {
		const cam = (rig.overlay.camera as { snapshot: { x: number; y: number; zoom: number } }).snapshot;
		return { x: cam.x, y: cam.y, zoom: cam.zoom };
	};
	const counters = () => ({
		drawCommitted: g.counts.drawCommitted,
		drawRegion: g.counts.drawRegion,
		penFullClears: rig.penCtx.fullClears,
		hlFullClears: rig.hlCtx.fullClears,
		penFills: rig.penCtx.calls.fill ?? 0,
	});

	beforeAll(() => {
		rig = makeRig();
		// Ink in the note: 40 pen and 10 highlighter strokes across the
		// visible band (world y 1850..2750 at this scroll) and 30 below it.
		const strokes: InkStroke[] = [];
		for (let i = 0; i < 40; i++) strokes.push(stroke(`p${i}`, "pen", 20 + (i % 8) * 80, 1900 + Math.floor(i / 8) * 60));
		for (let i = 0; i < 10; i++) strokes.push(stroke(`h${i}`, "highlighter", 20 + i * 60, 2300));
		for (let i = 0; i < 30; i++) strokes.push(stroke(`far${i}`, "pen", 20, 4500 + i * 40));
		inlineInk.applyAddLive(PATH, strokes);
		// First paint of the note, as mount's own repaint would produce.
		rig.overlay.scheduleRepaint();
		rig.flush();
	});

	it("setup: real mount wired a ResizeObserver to contentDOM and the first paint drew the ink", () => {
		expect(rig.overlay.container, `mount error: ${String(rig.mountError)}`).toBeTruthy();
		expect(rig.hasContentObserver).toBe(true);
		expect(rig.overlay.lastPaintCam).not.toBeNull();
		expect(rig.penCtx.calls.fill ?? 0).toBeGreaterThan(0);
	});

	it("control: a scroll-via repaint with nothing moved draws nothing (the rig is quiet)", () => {
		const before = counters();
		rig.overlay.scheduleRepaint("scroll");
		rig.flush();
		expect(counters()).toEqual(before);
	});

	it("control: the same content growth repainted via \"scroll\" draws nothing (the via, not the growth, is the cost)", () => {
		const cam0 = snap();
		const before = counters();
		rig.grow(24);
		rig.overlay.scheduleRepaint("scroll");
		rig.flush();
		expect(snap()).toEqual(cam0);
		expect(counters()).toEqual(before);
	});

	it("an Enter-sized .cm-content resize with the camera still does not redraw the whole committed layer", () => {
		// Build the index once via a partial repaint, so indexDirty starts false.
		(rig.overlay.damage as { addRect(b: unknown): void }).addRect({ x: 20, y: 1900, width: 10, height: 10 });
		rig.overlay.scheduleRepaint("partial");
		rig.flush();
		expect(rig.overlay.indexDirty).toBe(false);

		const band0 = JSON.stringify(rig.overlay.band);
		const cam0 = snap();
		const painted0 = JSON.stringify(rig.overlay.lastPaintCam);
		const before = counters();

		// Enter: one more 24px line; .cm-content and scrollHeight grow, nothing above moves.
		rig.grow(24);
		rig.fireContentResize();
		const frames = rig.flush();

		// Precondition: the trigger really left the camera and the band still.
		expect(JSON.stringify(rig.overlay.band)).toBe(band0);
		expect(snap()).toEqual(cam0);
		expect(JSON.stringify(rig.overlay.lastPaintCam)).toBe(painted0);

		const after = counters();
		const delta = {
			frames,
			drawCommitted: after.drawCommitted - before.drawCommitted,
			penFullClears: after.penFullClears - before.penFullClears,
			hlFullClears: after.hlFullClears - before.hlFullClears,
			penFillsForStrokes: after.penFills - before.penFills,
			indexDirtyAfter: rig.overlay.indexDirty,
		};
		// CORRECT behaviour: nothing moved, so no full-layer redraw.
		expect(delta, `per-Enter cost: ${JSON.stringify(delta)}`).toEqual({
			frames: delta.frames,
			drawCommitted: 0,
			penFullClears: 0,
			hlFullClears: 0,
			penFillsForStrokes: 0,
			indexDirtyAfter: false,
		});
	});

	it("the next small partial repaint after a still-camera content resize does not rebuild the whole index", () => {
		const index = rig.overlay.strokeIndex as { rebuild(s: unknown): void };
		const spy = vi.spyOn(index, "rebuild");
		// Clean state first.
		(rig.overlay.damage as { addRect(b: unknown): void }).addRect({ x: 20, y: 1900, width: 10, height: 10 });
		rig.overlay.scheduleRepaint("partial");
		rig.flush();
		spy.mockClear();

		rig.grow(24);
		rig.fireContentResize();
		rig.flush();
		// A later one-rect damage frame (an erase or a stroke commit).
		(rig.overlay.damage as { addRect(b: unknown): void }).addRect({ x: 20, y: 1900, width: 10, height: 10 });
		rig.overlay.scheduleRepaint("partial");
		rig.flush();
		expect(spy, "strokeIndex.rebuild calls after one content resize").toHaveBeenCalledTimes(0);
		spy.mockRestore();
	});

	it("five Enters cost zero full redraws", () => {
		const before = counters();
		for (let i = 0; i < 5; i++) {
			rig.grow(24);
			rig.fireContentResize();
			rig.flush();
		}
		const after = counters();
		expect(after.drawCommitted - before.drawCommitted, `pen ribbon fills: ${after.penFills - before.penFills}`).toBe(0);
	});
});
