/**
 * A note highlighter's live tip wears the same wash as its trail.
 *
 * The pen-down dot, the live head and the predicted tail are painted on the
 * tail canvas, the topmost layer; only the highlight canvases carried
 * HIGHLIGHTER_ALPHA, so the tip of a live highlighter stroke was an opaque
 * disc over the text until the pen lifted. The PDF and slide surfaces already
 * dress their head canvas this way.
 *
 * Drives the real InkOverlayPlugin constructor and mount() up to and
 * including the canvas stack, the real wet and tail renderers, then the real
 * setInlineTool("highlighter"), penDown() and penRaw(). InlinePenRouter's
 * constructor throws a sentinel so mount() stops right after the canvases are
 * built; syncCamera and ensurePenTools are no-ops (no layout here). Canvases
 * carry a recording 2d context that snapshots fillStyle, strokeStyle and
 * globalAlpha at each fill() and stroke().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

const SENTINEL = "stop mount after the canvas stack";

vi.mock("./InlinePenRouter", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class InlinePenRouter {
		constructor() {
			throw new Error("stop mount after the canvas stack");
		}
	}
	return { ...actual, InlinePenRouter };
});

import { InkOverlayPlugin, overlayForPath, setInlineTool, getInlineTool } from "./InkOverlay";
import { HIGHLIGHTER_ALPHA } from "../ink/PenStyle";
import { getInkColorHex } from "../ink/InkColor";

const PATH = "highlighter-tip-wash.md";

interface Paint {
	op: "fill" | "stroke";
	color: string;
	globalAlpha: number;
}

class RecCtx {
	paints: Paint[] = [];
	private state: Record<string, unknown> = { globalAlpha: 1, fillStyle: "#000000", strokeStyle: "#000000" };
	private stack: Record<string, unknown>[] = [];
	proxy: CanvasRenderingContext2D;
	constructor() {
		const self = this;
		this.proxy = new Proxy({} as Record<string, unknown>, {
			get(_t, prop) {
				if (typeof prop === "symbol") return undefined;
				switch (prop) {
					case "getContextAttributes":
						return () => ({ desynchronized: false });
					case "save":
						return () => void self.stack.push({ ...self.state });
					case "restore":
						return () => {
							const s = self.stack.pop();
							if (s) self.state = s;
						};
					case "fill":
						return () =>
							void self.paints.push({
								op: "fill",
								color: String(self.state.fillStyle),
								globalAlpha: Number(self.state.globalAlpha),
							});
					case "stroke":
						return () =>
							void self.paints.push({
								op: "stroke",
								color: String(self.state.strokeStyle),
								globalAlpha: Number(self.state.globalAlpha),
							});
					case "canvas":
						return undefined;
				}
				if (prop in self.state) return self.state[prop];
				// Every other member is a drawing method (beginPath, arc, moveTo, clearRect, ...).
				return () => undefined;
			},
			set(_t, prop, value) {
				if (typeof prop === "string") self.state[prop] = value;
				return true;
			},
		}) as unknown as CanvasRenderingContext2D;
	}
}

class FakeWin {
	devicePixelRatio = 1;
	frames: Array<(t: number) => void> = [];
	getComputedStyle(): { position: string } {
		return { position: "relative" };
	}
	requestAnimationFrame(cb: (t: number) => void): number {
		this.frames.push(cb);
		return this.frames.length;
	}
	cancelAnimationFrame(): void {}
	setTimeout(): number {
		return 1;
	}
	clearTimeout(): void {}
	matchMedia(): { matches: boolean; addEventListener: () => void; removeEventListener: () => void } {
		return { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
	}
}

class FakeDocument {
	defaultView = new FakeWin();
	body: El;
	constructor() {
		this.body = new El("body", this);
	}
}

class El {
	children: El[] = [];
	parentElement: El | null = null;
	style: Record<string, string> = {};
	classes = new Set<string>();
	attrs = new Map<string, string>();
	isConnected = true;
	scrollLeft = 0;
	scrollTop = 0;
	rec: RecCtx | null = null;
	constructor(
		readonly tag: string,
		readonly ownerDocument: FakeDocument,
		cls?: string
	) {
		if (cls) for (const c of cls.split(" ")) this.classes.add(c);
	}
	createEl(tag: string, opts: { cls?: string } = {}): El {
		const e = new El(tag, this.ownerDocument, opts.cls);
		e.parentElement = this;
		this.children.push(e);
		return e;
	}
	createDiv(opts: { cls?: string } = {}): El {
		return this.createEl("div", opts);
	}
	setCssStyles(s: Record<string, string>): void {
		Object.assign(this.style, s);
	}
	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}
	addClass(c: string): void {
		this.classes.add(c);
	}
	removeClass(c: string): void {
		this.classes.delete(c);
	}
	toggleClass(c: string, on: boolean): void {
		if (on) this.classes.add(c);
		else this.classes.delete(c);
	}
	get classList() {
		return {
			add: (c: string) => this.classes.add(c),
			remove: (c: string) => this.classes.delete(c),
			contains: (c: string) => this.classes.has(c),
			toggle: (c: string, on?: boolean) => this.toggleClass(c, on ?? !this.classes.has(c)),
		};
	}
	closest(sel: string): El | null {
		if (sel === ".markdown-source-view" && this.classes.has("markdown-source-view")) return this;
		return null;
	}
	querySelector(): El | null {
		return null;
	}
	contains(n: unknown): boolean {
		return n === this || this.children.some((c) => c.contains(n));
	}
	addEventListener(): void {}
	removeEventListener(): void {}
	getBoundingClientRect() {
		return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
	}
	getContext(): CanvasRenderingContext2D {
		this.rec ??= new RecCtx();
		return this.rec.proxy;
	}
}

/** Alpha carried by the colour string itself (rgba()/hsla()/#rrggbbaa); 1 for an opaque colour. */
function colorAlpha(c: string): number {
	const s = c.trim().toLowerCase();
	if (/^#[0-9a-f]{8}$/.test(s)) return parseInt(s.slice(7, 9), 16) / 255;
	if (/^#[0-9a-f]{4}$/.test(s)) return parseInt(s[4]! + s[4]!, 16) / 255;
	const m = /^(?:rgba|hsla)\(([^)]*)\)$/.exec(s);
	if (m) {
		const parts = m[1]!.split(/[,\s/]+/).filter(Boolean);
		const a = parts[3];
		if (a !== undefined) return a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
	}
	return 1;
}

function cssOpacity(el: El): number {
	const o = el.style.opacity;
	return o === undefined || o === "" ? 1 : parseFloat(o);
}

type O = Record<string, unknown> & {
	penDown(s: unknown, ev: unknown): void;
	penRaw(s: unknown[], ev: unknown): void;
};

function build(): { o: O; layer: El } {
	const doc = new FakeDocument();
	const root = new El("div", doc, "markdown-source-view cm-editor");
	const scrollDOM = root.createDiv({ cls: "cm-scroller" });
	const contentDOM = scrollDOM.createDiv({ cls: "cm-content" });
	const view = {
		dom: root,
		scrollDOM,
		contentDOM,
		hasFocus: true,
		focus: () => {},
		state: { field: () => ({ file: { path: PATH }, editor: {} }) },
	};
	let thrown: unknown = null;
	try {
		new InkOverlayPlugin(view as never);
	} catch (e) {
		thrown = e;
	}
	// mount() ran for real up to the router: the only permitted stop is our sentinel.
	expect((thrown as Error | null)?.message).toBe(SENTINEL);
	const o = overlayForPath(PATH) as unknown as O;
	expect(o).not.toBeNull();
	// No layout here: these two read DOM geometry / build chrome, neither paints ink.
	o.syncCamera = () => {};
	o.ensurePenTools = () => {};
	const container = scrollDOM.children.find((c) => c.classes.has("handwriting-ink-overlay"))!;
	const layer = container.children.find((c) => c.classes.has("handwriting-ink-layer"))!;
	return { o, layer };
}

const penEv = (t: number) =>
	({ pointerType: "pen", buttons: 1, button: 0, pointerId: 7, timeStamp: t, clientX: 0, clientY: 0 }) as unknown;

describe("note highlighter tip wears the same wash as its trail", () => {
	let prevTool: ReturnType<typeof getInlineTool>;
	beforeEach(() => {
		prevTool = getInlineTool();
	});
	afterEach(() => {
		setInlineTool(prevTool);
	});

	it("pen-down dot, live head and predicted tail are no more opaque than the highlighter trail", () => {
		const { o, layer } = build();
		const canvases = layer.children.filter((c) => c.tag === "canvas");
		const highlightCanvas = o.highlightCanvas as unknown as El;
		const highlightWetCanvas = o.highlightWetCanvas as unknown as El;
		const committedCanvas = o.committedCanvas as unknown as El;
		const wetCanvas = o.wetCanvas as unknown as El;
		const tailCanvas = o.tailCanvas as unknown as El;

		// Precondition: the real stack, in DOM order (later sibling paints on top; no z-index on any).
		const wetTileCanvas = o.wetTileCanvas as unknown as El;
		expect(canvases).toEqual([highlightCanvas, highlightWetCanvas, committedCanvas, wetCanvas, wetTileCanvas, tailCanvas]);
		for (const c of canvases) expect(c.style.zIndex).toBeUndefined();
		// Precondition: the trail layer carries the highlighter wash.
		expect(cssOpacity(highlightWetCanvas)).toBeCloseTo(HIGHLIGHTER_ALPHA, 6);

		setInlineTool("highlighter");
		expect(getInlineTool()).toBe("highlighter");

		const tailRec = tailCanvas.rec!;
		const trailRec = highlightWetCanvas.rec!;
		expect(tailRec).toBeTruthy();
		expect(trailRec).toBeTruthy();

		// Pen down.
		o.penDown({ x: 100, y: 100, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 }, penEv(0));
		expect(o.mode).toBe("ink");
		expect(o.activeWet).toBe(o.highlightWet);
		const hiColor = getInkColorHex("highlighter");
		expect((o.activeStyle as { color: string }).color).toBe(hiColor);
		const dotPaints = tailRec.paints.slice();
		// Precondition: the contact dot really went to the tip layer.
		expect(dotPaints.length).toBeGreaterThan(0);

		// Pen moves: a quick straight run, the shape the wet layer and the tip both paint.
		const samples = Array.from({ length: 10 }, (_, i) => ({
			x: 100 + (i + 1) * 6,
			y: 100,
			pressure: 0.5,
			timestamp: (i + 1) * 4,
			tiltX: 0,
			tiltY: 0,
		}));
		o.penRaw(samples.slice(0, 5), penEv(20));
		o.penRaw(samples.slice(5), penEv(40));

		const movePaints = tailRec.paints.slice(dotPaints.length);
		// Precondition: the live head / predicted tail really went to the tip layer.
		expect(movePaints.length).toBeGreaterThan(0);
		// Precondition: the trail was painted, on the highlight wet layer.
		expect(trailRec.paints.length).toBeGreaterThan(0);

		const trailAlpha = Math.max(
			...trailRec.paints.map((p) => p.globalAlpha * colorAlpha(p.color) * cssOpacity(highlightWetCanvas))
		);
		expect(trailAlpha).toBeCloseTo(HIGHLIGHTER_ALPHA, 6);

		const tipPaints = tailRec.paints.map((p) => ({
			...p,
			effective: p.globalAlpha * colorAlpha(p.color) * cssOpacity(tailCanvas),
		}));
		// Every tip paint is the highlighter's own colour (the claim is about alpha, not hue).
		for (const p of tipPaints) expect(p.color.toLowerCase()).toBe(hiColor.toLowerCase());

		const maxTip = Math.max(...tipPaints.map((p) => p.effective));
		const summary = `tip paints=${tipPaints.length} (dot ${dotPaints.length}, move ${movePaints.length}) ` +
			`ops=${[...new Set(tipPaints.map((p) => p.op))].join("+")} color=${tipPaints[0]!.color} ` +
			`ctxAlpha=${tipPaints[0]!.globalAlpha} tailCanvasOpacity=${cssOpacity(tailCanvas)} ` +
			`maxTipEffective=${maxTip} trailEffective=${trailAlpha}`;
		// CORRECT BEHAVIOUR: the tip is no more opaque than its trail.
		expect(maxTip, summary).toBeLessThanOrEqual(trailAlpha + 1e-6);
	});

	it("selection chrome drawn after the stroke is opaque again, and a pen stroke's tip is never washed", () => {
		const { o } = build();
		const tailCanvas = o.tailCanvas as unknown as El;
		setInlineTool("highlighter");
		o.penDown({ x: 100, y: 100, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 }, penEv(0));
		expect(cssOpacity(tailCanvas)).toBeCloseTo(HIGHLIGHTER_ALPHA, 6);
		// The stroke is over (no builder): the next chrome repaint draws UI, not ink.
		(o as Record<string, unknown>).builder = null;
		(o as unknown as { redrawSelectionUI(): void }).redrawSelectionUI();
		expect(cssOpacity(tailCanvas), "chrome after a highlighter stroke").toBe(1);
		// A pen stroke after a highlighter stroke paints its tip at full strength.
		o.penDown({ x: 100, y: 100, pressure: 0.5, timestamp: 50, tiltX: 0, tiltY: 0 }, penEv(50));
		(o as Record<string, unknown>).builder = null;
		setInlineTool("pen");
		o.penDown({ x: 120, y: 100, pressure: 0.5, timestamp: 100, tiltX: 0, tiltY: 0 }, penEv(100));
		expect(o.activeWet).toBe(o.wet);
		expect(cssOpacity(tailCanvas), "pen tip after a highlighter stroke").toBe(1);
	});
});
