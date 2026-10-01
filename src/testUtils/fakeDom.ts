/**
 * Shared fake DOM for tests that run real production code (Obsidian element
 * helpers, presentation surfaces) against a minimal browser stand-in.
 *
 * Base shape and querySelector/Proxy behaviour: MobileTools.test.ts's fake,
 * the oracle for addClass/removeClass, offsetWidth/offsetLeft (readonly 0),
 * firstChild, value, hidden. Presentation surface additions (rect,
 * clientWidth/clientHeight, style.setProperty, getContext, dispatch,
 * focus/blur, disabled, FakeWin's timers/matchMedia/MutationObserver):
 * UnloadFlushColdReopen.test.ts's prior private copy, itself trimmed from
 * SlidesInkSurface.test.ts.
 *
 * Unknown-member-throws: any FakeEl member not implemented here throws by
 * name on first access, rather than silently returning undefined. querySelector
 * answers from children by tag or ".class", or throws on an unsupported
 * selector - never a silent null.
 */

export interface ElOpts {
	text?: string;
	cls?: string;
	attr?: Record<string, string>;
}

interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** Tag or ".class" - the only selector shapes any call site in this repo needs today. */
function matchesSimpleSelector(el: FakeEl, sel: string): boolean {
	if (sel.startsWith(".")) return el.classes.has(sel.slice(1));
	if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(sel)) return el.tagName === sel;
	throw new Error(`FakeEl: unsupported selector ${sel}`);
}

export class FakeDoc {
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	readonly frames: Array<() => void> = [];
	activeElement: FakeEl | null = null;
	head: FakeEl | undefined = undefined;
	container: FakeEl | null = null;
	readonly body = {
		classList: {
			add: (): void => undefined,
			remove: (): void => undefined,
			contains: (): boolean => false,
		},
		querySelector: (sel: string): FakeEl | null => {
			if (sel === ":scope > .slides-container") return this.container;
			throw new Error(`FakeDoc.body: unsupported selector ${sel}`);
		},
	};
	readonly defaultView = {
		devicePixelRatio: 1,
		navigator: undefined,
		requestAnimationFrame: (cb: () => void): number => {
			this.frames.push(cb);
			return this.frames.length;
		},
		cancelAnimationFrame: (): void => {},
		setTimeout: (): number => 0,
		clearTimeout: (): void => {},
		getComputedStyle: (): { position: string; backgroundColor: unknown } => ({
			position: "static",
			backgroundColor: undefined,
		}),
		matchMedia: (query: string): MediaQueryList =>
			({
				media: query,
				matches: true,
				addEventListener: (): undefined => undefined,
				removeEventListener: (): undefined => undefined,
			}) as unknown as MediaQueryList,
		addEventListener: (): void => {},
		removeEventListener: (): void => {},
		MutationObserver: class {
			observe(): void {}
			disconnect(): void {}
		},
	};
	createElement(tag: string): FakeEl {
		return new FakeEl(tag, this);
	}
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}
	removeEventListener(): void {}
	/** Fire a DOCUMENT-level handler, e.g. a drag's pointer-end registered off the target. */
	fire(type: string, ev: Record<string, unknown> = {}): void {
		const event = { type, preventDefault: (): void => {}, pointerType: "mouse", ...ev };
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}
	/** Run every frame callback queued, including any queued by one. */
	flushFrames(): void {
		for (let i = 0; i < 20 && this.frames.length > 0; i++) {
			const due = this.frames.splice(0, this.frames.length);
			for (const cb of due) cb();
		}
	}
}

class FakeElImpl {
	readonly children: FakeEl[] = [];
	readonly classes = new Set<string>();
	readonly attrs = new Map<string, string>();
	readonly dataset: Record<string, string> = {};
	readonly style: Record<string, string> & {
		setProperty(prop: string, value: string): void;
		removeProperty(prop: string): void;
		getPropertyValue(prop: string): string;
	} = (() => {
		const record: Record<string, string> = { position: "", touchAction: "" };
		return Object.assign(record, {
			setProperty: (prop: string, value: string): void => {
				record[prop] = value;
			},
			removeProperty: (prop: string): void => {
				delete record[prop];
			},
			getPropertyValue: (prop: string): string => record[prop] ?? "",
		});
	})();
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	textContent = "";
	value = "";
	className = "";
	id = "";
	tabIndex = -1;
	width = 0;
	height = 0;
	clientWidth = 0;
	clientHeight = 0;
	isConnected = true;
	isContentEditable = false;
	parentElement: FakeEl | null = null;
	/** Mocks the DOM `hidden` property; nothing here asserts on where an open pop is placed. */
	hidden = false;
	disabled = false;
	readonly offsetWidth = 0;
	readonly offsetLeft = 0;
	readonly classList = {
		add: (c: string): void => void this.classes.add(c),
		remove: (c: string): void => void this.classes.delete(c),
		contains: (c: string): boolean => this.classes.has(c),
		toggle: (c: string, on?: boolean): boolean => {
			const want = on ?? !this.classes.has(c);
			if (want) this.classes.add(c);
			else this.classes.delete(c);
			return want;
		},
	};
	/** Zeros by default - a test that wants real box math sets this. */
	rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
	captured: number | null = null;
	/**
	 * Deliberately omitted (MobileTools.ts:3143 optional-chains it): an own
	 * property so the unknown-member throw does not fire on the mere access,
	 * matching closest()'s prior "absence never threw" behaviour exactly.
	 */
	readonly closest: ((sel: string) => FakeEl | null) | undefined = undefined;

	constructor(
		readonly tagName: string,
		readonly ownerDocument: FakeDoc,
		opts: ElOpts = {}
	) {
		for (const c of (opts.cls ?? "").split(" ").filter(Boolean)) this.classes.add(c);
		for (const [k, v] of Object.entries(opts.attr ?? {})) this.attrs.set(k, v);
		if (opts.text !== undefined) this.textContent = opts.text;
	}

	private appendNew(tag: string, opts: ElOpts): FakeEl {
		const el = new FakeEl(tag, this.ownerDocument, opts);
		this.appendChild(el);
		return el;
	}
	createEl(tag: string, opts: ElOpts = {}): FakeEl {
		return this.appendNew(tag, opts);
	}
	createDiv(opts: ElOpts = {}): FakeEl {
		return this.appendNew("div", opts);
	}
	createSpan(opts: ElOpts = {}): FakeEl {
		return this.appendNew("span", opts);
	}
	get firstChild(): FakeEl | null {
		return this.children[0] ?? null;
	}
	appendChild(child: FakeEl): void {
		if (child.parentElement) child.remove();
		this.children.push(child);
		child.parentElement = this;
	}
	/**
	 * DETACH FIRST, which the DOM does: `insertBefore` MOVES a node that is
	 * already a child rather than adding a second copy of it.
	 */
	insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl {
		const had = this.children.indexOf(node);
		if (had >= 0) this.children.splice(had, 1);
		const at = ref ? this.children.indexOf(ref) : -1;
		if (at < 0) this.children.push(node);
		else this.children.splice(at, 0, node);
		return node;
	}
	empty(): void {
		this.children.length = 0;
		this.textContent = "";
	}
	remove(): void {
		const p = this.parentElement;
		if (p) {
			const i = p.children.indexOf(this);
			if (i >= 0) p.children.splice(i, 1);
		}
		this.parentElement = null;
	}
	setText(t: string): void {
		this.children.length = 0;
		this.textContent = t;
	}
	setCssStyles(styles: Record<string, string>): void {
		Object.assign(this.style, styles);
	}
	getBoundingClientRect(): Rect {
		return this.rect;
	}
	setPointerCapture(id: number): void {
		this.captured = id;
	}
	releasePointerCapture(id: number): void {
		if (this.captured === id) this.captured = null;
	}
	addClass(c: string): void {
		this.classes.add(c);
	}
	removeClass(c: string): void {
		this.classes.delete(c);
	}
	toggleClass(c: string, on: boolean): void {
		this.classList.toggle(c, on);
	}
	hasAttribute(k: string): boolean {
		return this.attrs.has(k);
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
	/** Answers from children by tag/.class, recursively; throws on an unsupported selector. */
	querySelector(sel: string): FakeEl | null {
		for (const kid of this.children) {
			if (matchesSimpleSelector(kid, sel)) return kid;
			const deep = kid.querySelector(sel);
			if (deep) return deep;
		}
		return null;
	}
	/**
	 * Comma-separated tag/.class tokens, matched the same way as `querySelector`
	 * (reached at SlidesTools.ts:104: "root.querySelectorAll(\".a, .b\")" while
	 * building the mobile tools strip; a review's "dead at this head" did not hold
	 * once the migration ran real production code through it).
	 */
	querySelectorAll(sel: string): FakeEl[] {
		const tokens = sel.split(",").map((s) => s.trim());
		const out: FakeEl[] = [];
		const walk = (el: FakeElImpl): void => {
			for (const kid of el.children) {
				if (tokens.some((t) => matchesSimpleSelector(kid, t))) out.push(kid);
				walk(kid);
			}
		};
		walk(this);
		return out;
	}
	contains(node: unknown): boolean {
		if (node === this) return true;
		return this.children.some((kid) => kid.contains(node));
	}
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}
	removeEventListener(): void {}
	/** Fire the handlers this element registered, the way a real click/pointer event would. */
	fire(type: string, ev: Record<string, unknown> = {}): void {
		const event = {
			type,
			preventDefault: (): void => {},
			stopPropagation: (): void => {},
			pointerType: "mouse",
			target: this,
			...ev,
		};
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}
	/** Raw dispatch to this element's own listeners, unlike `fire` it adds no defaults to `ev`. */
	dispatch(ev: Record<string, unknown>): void {
		for (const fn of (this.listeners.get(ev.type as string) ?? []).slice()) fn(ev);
	}
	/** The control carrying this label - ownName moves aria-label to dataset. */
	findByTipLabel(label: string): FakeEl | null {
		for (const kid of this.children) {
			if (kid.dataset.tipLabel === label) return kid;
			const deep = kid.findByTipLabel(label);
			if (deep) return deep;
		}
		return null;
	}
	focus(): void {
		if (this.attrs.has("tabindex") || this.tabIndex !== -1)
			this.ownerDocument.activeElement = this;
	}
	blur(): void {
		if (this.ownerDocument.activeElement === (this as unknown as FakeEl)) this.ownerDocument.activeElement = null;
	}
	getContext(): CanvasRenderingContext2D {
		return new Proxy(
			{},
			{
				get: (_t, prop) =>
					prop === "getContextAttributes" ? () => ({ desynchronized: false }) : () => undefined,
				set: () => true,
			}
		) as unknown as CanvasRenderingContext2D;
	}
}

/**
 * The test framework's own probes on a FakeEl: read during equality checks,
 * failure diffs and thenable checks, never by production code. Must pass
 * through (undefined when unimplemented) rather than throw, or a real
 * assertion failure on a FakeEl reports "unsupported member" instead of the
 * mismatch that actually failed (fake-unify-1420 T1).
 */
const FRAMEWORK_PROBES = new Set(["then", "toJSON", "asymmetricMatch", "$$typeof", "nodeType", "constructor"]);

/**
 * `new FakeEl(...)` returns a Proxy over the real instance: any member not
 * implemented above throws by name on first access, rather than silently
 * reading undefined (the durable fix for FakeEl surface gaps
 * found one red at a time). Symbols and FRAMEWORK_PROBES are exempt: every
 * real DOM/Obsidian member is a plain string outside that list.
 */
export class FakeEl extends FakeElImpl {
	constructor(tag: string, ownerDocument: FakeDoc, opts: ElOpts = {}) {
		super(tag, ownerDocument, opts);
		return new Proxy(this, {
			get(target, prop, receiver) {
				if (typeof prop === "symbol" || FRAMEWORK_PROBES.has(prop)) return Reflect.get(target, prop, receiver);
				if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
				throw new Error(`FakeEl: unsupported member ${String(prop)}`);
			},
		});
	}
}
