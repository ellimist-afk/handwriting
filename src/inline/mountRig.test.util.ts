/**
 * A REAL `InkOverlayPlugin`, built by its own constructor and mounted ALL the
 * way through `mount()`, for claims about wiring that only a finished mount
 * creates.
 *
 * The nearest rigs stop early on purpose. `PenReticleOpacity.test.ts` and
 * `HighlighterTipWash.test.ts` make the router's constructor throw, so mount
 * ends after the canvas stack. `InlineDeleteAllRouting.test.ts` replaces
 * `mount` outright. Neither reaches the subscriptions mount makes after the
 * router (the ink-change listener, the canvas-override listener, the note
 * camera restore), so claims about those could only be read off the source.
 * This rig closes that gap.
 *
 * What is real: the constructor and every field initialiser, `mount()` from
 * its first guard to its last line, the real `InlinePenRouter`, the real
 * `inlineInk` store (session memory, no host unless the caller attaches one)
 * and the real ink-change events. What is fake: the DOM (a small element tree
 * with no layout), the canvas contexts (inert), `ResizeObserver` (never
 * fires, unless the test installs `recordObservers` and fires one by hand),
 * animation frames (queued, never run), and two methods that need a
 * laid-out page or Obsidian chrome: `handleResize` and `ensurePenTools`. Both
 * are stood down only while the constructor runs and stay inert on the
 * returned overlay, so a test that wants layout must bring its own.
 *
 * Not a test file: the name does not end in `.test.ts`, so vitest does not
 * collect it, and the `.test.` in it keeps the plugin checker off it.
 * Nothing that ships imports this module.
 */

import { vi } from "vitest";
import { InkOverlayPlugin } from "./InkOverlay";

export class RigCtx {
	readonly proxy: CanvasRenderingContext2D;
	constructor() {
		const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: "#000000", strokeStyle: "#000000" };
		this.proxy = new Proxy<Record<string, unknown>>({}, {
			get(_t, prop) {
				if (typeof prop === "symbol") return undefined;
				if (prop === "getContextAttributes") return () => ({ desynchronized: false });
				if (prop === "canvas") return undefined;
				if (prop in state) return state[prop];
				return () => undefined;
			},
			set(_t, prop, value) {
				if (typeof prop === "string") state[prop] = value;
				return true;
			},
		}) as unknown as CanvasRenderingContext2D;
	}
}

export class RigWin {
	devicePixelRatio = 1;
	frames: Array<(t: number) => void> = [];
	getComputedStyle(): { position: string; fontSize: string } {
		return { position: "relative", fontSize: "16px" };
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
	setInterval(): number {
		return 1;
	}
	clearInterval(): void {}
	addEventListener(): void {}
	removeEventListener(): void {}
	matchMedia(): { matches: boolean; addEventListener: () => void; removeEventListener: () => void } {
		return { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
	}
}

export class RigDocument {
	defaultView = new RigWin();
	body: RigEl;
	constructor() {
		this.body = new RigEl("body", this);
	}
}

export class RigEl {
	children: RigEl[] = [];
	parentElement: RigEl | null = null;
	style: Record<string, string> = {};
	classes = new Set<string>();
	attrs = new Map<string, string>();
	isConnected = true;
	scrollLeft = 0;
	scrollTop = 0;
	clientWidth = 800;
	clientHeight = 600;
	scrollWidth = 800;
	scrollHeight = 600;
	width = 300;
	height = 150;
	ctx: RigCtx | null = null;
	constructor(
		readonly tag: string,
		readonly ownerDocument: RigDocument,
		cls?: string
	) {
		if (cls) for (const c of cls.split(" ")) this.classes.add(c);
		// Read as a plain record by tests, called as a CSSStyleDeclaration by
		// production; the methods are not enumerable, so they never show up
		// beside the properties a test inspects.
		const style = this.style;
		Object.defineProperties(style, {
			getPropertyValue: { value: (name: string): string => style[name] ?? "" },
			setProperty: { value: (name: string, value: string): void => void (style[name] = value) },
			removeProperty: {
				value: (name: string): string => {
					const was = style[name] ?? "";
					delete style[name];
					return was;
				},
			},
		});
	}
	createEl(tag: string, opts: { cls?: string } = {}): RigEl {
		const e = new RigEl(tag, this.ownerDocument, opts.cls);
		e.parentElement = this;
		this.children.push(e);
		return e;
	}
	createDiv(opts: { cls?: string } = {}): RigEl {
		return this.createEl("div", opts);
	}
	remove(): void {
		if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
		this.parentElement = null;
		this.isConnected = false;
	}
	detach(): void {
		this.remove();
	}
	empty(): void {
		this.children = [];
	}
	setCssStyles(s: Record<string, string>): void {
		Object.assign(this.style, s);
	}
	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}
	getAttribute(k: string): string | null {
		return this.attrs.get(k) ?? null;
	}
	removeAttribute(k: string): void {
		this.attrs.delete(k);
	}
	addClass(c: string): void {
		this.classes.add(c);
	}
	removeClass(c: string): void {
		this.classes.delete(c);
	}
	hasClass(c: string): boolean {
		return this.classes.has(c);
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
	closest(sel: string): RigEl | null {
		if (sel === ".markdown-source-view" && this.classes.has("markdown-source-view")) return this;
		return null;
	}
	querySelector(): RigEl | null {
		return null;
	}
	querySelectorAll(): RigEl[] {
		return [];
	}
	contains(n: unknown): boolean {
		return n === this || this.children.some((c) => c.contains(n));
	}
	find(cls: string): RigEl | null {
		for (const c of this.children) {
			if (c.classes.has(cls)) return c;
			const deep = c.find(cls);
			if (deep) return deep;
		}
		return null;
	}
	addEventListener(): void {}
	removeEventListener(): void {}
	setPointerCapture(): void {}
	releasePointerCapture(): void {}
	hasPointerCapture(): boolean {
		return false;
	}
	getBoundingClientRect() {
		return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
	}
	getContext(): CanvasRenderingContext2D {
		this.ctx ??= new RigCtx();
		return this.ctx.proxy;
	}
}

export interface MountedOverlay {
	/** The overlay itself, private members reachable by name. */
	o: Record<string, unknown>;
	/** The editor DOM the overlay was mounted into. */
	root: RigEl;
	scrollDOM: RigEl;
	contentDOM: RigEl;
	doc: RigDocument;
	/** The overlay's own container, inside the scroller. */
	container: RigEl;
	/** Every transaction spec the overlay dispatched to its editor, in order. */
	dispatched: unknown[];
	/** The real teardown: `destroy()`, which unmounts and leaves `instances`. */
	destroy(): void;
}

class InertResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

/**
 * An observer that records what it was pointed at and can be fired by hand.
 * Stands in for `ResizeObserver` and `MutationObserver` alike: production
 * hands either one a callback, then calls `observe`, `unobserve` and
 * `disconnect`, and the browser decides when the callback runs. Here the test
 * decides, through `fire`.
 */
export class RecordingObserver {
	readonly observed: Array<{ target: unknown; options: unknown }> = [];
	readonly unobserved: unknown[] = [];
	disconnects = 0;
	constructor(readonly callback: (records: unknown[], observer: unknown) => void) {}
	observe(target: unknown, options?: unknown): void {
		this.observed.push({ target, options });
	}
	unobserve(target: unknown): void {
		this.unobserved.push(target);
	}
	disconnect(): void {
		this.disconnects++;
	}
	/** Whether `target` is being watched now: observed, and not since released. */
	watches(target: unknown): boolean {
		return this.observed.some((o) => o.target === target) && !this.unobserved.includes(target);
	}
	fire(records: unknown[] = []): void {
		this.callback(records, this);
	}
}

/**
 * Put recording observers in place of the globals until `restore()`. Every
 * observer production builds in between lands in `resize` or `mutation`, in
 * construction order. Install before `mountOverlay`, which only fills a
 * global that is missing.
 */
export function recordObservers(): { resize: RecordingObserver[]; mutation: RecordingObserver[]; restore(): void } {
	const g = globalThis as { ResizeObserver?: unknown; MutationObserver?: unknown };
	const had = { resize: "ResizeObserver" in g, mutation: "MutationObserver" in g };
	const was = { resize: g.ResizeObserver, mutation: g.MutationObserver };
	const resize: RecordingObserver[] = [];
	const mutation: RecordingObserver[] = [];
	g.ResizeObserver = class extends RecordingObserver {
		constructor(cb: (records: unknown[], observer: unknown) => void) {
			super(cb);
			resize.push(this);
		}
	};
	g.MutationObserver = class extends RecordingObserver {
		constructor(cb: (records: unknown[], observer: unknown) => void) {
			super(cb);
			mutation.push(this);
		}
	};
	return {
		resize,
		mutation,
		restore() {
			if (had.resize) g.ResizeObserver = was.resize;
			else delete g.ResizeObserver;
			if (had.mutation) g.MutationObserver = was.mutation;
			else delete g.MutationObserver;
		},
	};
}

/**
 * Construct and fully mount a real overlay on `path`. Throws if mount stopped
 * early (no container, or the ink-change subscription was never made), so a
 * test cannot pass on a half-mounted overlay.
 *
 * `app`, when given, is what the editor's info field hands the overlay as
 * Obsidian's `app`: the one route the overlay has to commands, the vault and
 * the file manager. Without it the field carries no `app`, as before.
 */
export function mountOverlay(path: string, opts: { app?: unknown } = {}): MountedOverlay {
	// Node has no window. The router mirrors pointer events on the global
	// window and arms timers on it; nothing here ever dispatches one.
	const g = globalThis as { window?: unknown; ResizeObserver?: unknown; addEventListener?: unknown; removeEventListener?: unknown };
	g.window ??= globalThis;
	g.ResizeObserver ??= InertResizeObserver;
	g.addEventListener ??= () => {};
	g.removeEventListener ??= () => {};

	const doc = new RigDocument();
	const root = new RigEl("div", doc, "markdown-source-view cm-editor");
	const scrollDOM = root.createDiv({ cls: "cm-scroller" });
	const contentDOM = scrollDOM.createDiv({ cls: "cm-content" });
	const file = { path };
	const editor = {};
	const info = opts.app === undefined ? { file, editor } : { file, editor, app: opts.app };
	const dispatched: unknown[] = [];
	const view = {
		dom: root,
		scrollDOM,
		contentDOM,
		hasFocus: true,
		focus: () => {},
		state: { field: () => info },
		dispatch: (spec: unknown) => void dispatched.push(spec),
	};

	const proto = InkOverlayPlugin.prototype as unknown as { handleResize: () => void; ensurePenTools: () => void };
	const resize = vi.spyOn(proto, "handleResize").mockImplementation(() => {});
	const tools = vi.spyOn(proto, "ensurePenTools").mockImplementation(() => {});
	let plugin: InkOverlayPlugin;
	try {
		plugin = new InkOverlayPlugin(view as never);
	} finally {
		resize.mockRestore();
		tools.mockRestore();
	}
	const o = plugin as unknown as Record<string, unknown>;
	o.handleResize = () => {};
	o.ensurePenTools = () => {};

	const container = scrollDOM.find("handwriting-ink-overlay");
	if (!container || o.container !== container) throw new Error("mountOverlay: mount() stopped before the container");
	if (typeof o.offInkChanged !== "function") throw new Error("mountOverlay: mount() stopped before the ink-change subscription");

	return {
		o,
		root,
		scrollDOM,
		contentDOM,
		doc,
		container,
		dispatched,
		destroy: () => plugin.destroy(),
	};
}
