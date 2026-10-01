/**
 * The note surface's pen reticle is shown and hidden by opacity on its own
 * layer, never by display, so neither edge invalidates the document. These
 * cells pin the two writes a style-record rig
 * cannot reach: the reticle is created hidden, and an ink pen-down puts a
 * showing reticle away. The overlay is the real one, mounted for real up to
 * the router (the scaffold is HighlighterTipWash.test.ts's).
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

import { InkOverlayPlugin, overlayForPath, setInlineTool, getInlineTool, setPenReticle } from "./InkOverlay";
import { reticleShown, reticleVisible } from "../testUtils/ReticleShown";

const PATH = "pen-reticle-opacity.md";

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

type R = O & {
	showPenCursor(s: unknown, pointerType?: string): void;
};

function reticleOf(o: O): El {
	const el = o.penCursorEl as unknown as El | null;
	expect(el, "mount created no reticle").toBeTruthy();
	return el!;
}

describe("the note surface's reticle is created hidden and put away by an ink pen-down", () => {
	let prevTool: ReturnType<typeof getInlineTool>;
	beforeEach(() => {
		prevTool = getInlineTool();
		setPenReticle(true);
	});
	afterEach(() => {
		setInlineTool(prevTool);
		setPenReticle(true);
	});

	it("a freshly mounted note shows no reticle", () => {
		const { o } = build();
		// Read as a browser would: the inline style over an opacity that defaults to 1.
		const style = reticleOf(o).style;
		expect(reticleVisible({ display: style.display ?? "", opacity: style.opacity ?? "1" }), "the reticle was created visible").toBe(false);
	});

	it("an ink pen-down puts a showing reticle away", () => {
		const { o } = build();
		const r = o as R;
		setInlineTool("pen");
		r.showPenCursor({ x: 100, y: 100, pressure: 0, timestamp: 0, tiltX: 0, tiltY: 0 }, "pen");
		expect(reticleShown(reticleOf(o).style), "precondition: hover lit the ring").toBe(true);

		o.penDown({ x: 100, y: 100, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 }, penEv(0));
		expect(o.mode).toBe("ink");
		expect(reticleShown(reticleOf(o).style), "the ring stayed lit under the nib").toBe(false);
	});
});
