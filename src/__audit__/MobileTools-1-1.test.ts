/**
 * AUDIT PROBE MobileTools-1-1 (1.4.21, 1a05f62c). Read-only probe.
 *
 * Claim: the note zoom bar (.handwriting-note-viewport-controls) is pinned by
 * one stylesheet rule at top:52px/right:8px/z-index:30, in the same parent as
 * the pen pill and strip, and nothing moves it with them. On Android the pill
 * sits at top 55 / right 15 (34x34), fully under the higher-z zoom bar.
 *
 * Half 1 runs the REAL MobileTools (the fake DOM is MobileTools.test.ts's):
 * same parent, zoom bar still showing while the pill shows, setCorner and the
 * transform writer never touch the zoom bar.
 * Half 2 reads the REAL styles.css (postcss) and resolves the cascade for the
 * few properties that place these boxes. The suite has no layout engine, so
 * box sizes are summed from the declared px values (border + padding +
 * button); env() insets are taken as 0 unless an arm says otherwise.
 * Control arms (desktop, iPad) must come out clear, so a red on Android is a
 * red on the geometry, not on the arithmetic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import css from "../../styles.css?raw";
import postcss from "postcss";
import { MobileTools, type MobileToolsHost } from "../inline/MobileTools";
import { resetPenToolsForTest } from "../inline/PenToolsMode";
import {
	resetNoteZoomControlsForTest,
	setZoomBarCanvasEnabled,
	getNoteZoomControlsMode,
} from "../inline/NoteZoomControlsMode";
import { setCanvasNoteOverrideForTest } from "../inline/CanvasNoteOverride";
import { clearToolPicked } from "../inline/MouseInk";
import { penInkEnabled } from "../inline/PenInk";

// ---------------------------------------------------------------- fake DOM
// Copied from src/inline/MobileTools.test.ts (FakeDoc / FakeEl), trimmed.
interface ElOpts {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}
class FakeDoc {
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	readonly frames: Array<() => void> = [];
	readonly defaultView = {
		requestAnimationFrame: (cb: () => void): number => {
			this.frames.push(cb);
			return this.frames.length;
		},
	};
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}
	removeEventListener(): void {}
}
class FakeEl {
	readonly children: FakeEl[] = [];
	readonly classes = new Set<string>();
	readonly attrs = new Map<string, string>();
	readonly dataset: Record<string, string> = {};
	readonly style: Record<string, string> = {};
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	textContent = "";
	value = "";
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
	constructor(readonly tag: string, readonly ownerDocument: FakeDoc, opts: ElOpts = {}) {
		for (const c of (opts.cls ?? "").split(" ").filter(Boolean)) this.classes.add(c);
		for (const [k, v] of Object.entries(opts.attr ?? {})) this.attrs.set(k, v);
		if (opts.text !== undefined) this.textContent = opts.text;
	}
	createEl(tag: string, opts: ElOpts = {}): FakeEl {
		const el = new FakeEl(tag, this.ownerDocument, opts);
		this.children.push(el);
		return el;
	}
	createDiv(opts: ElOpts = {}): FakeEl {
		return this.createEl("div", opts);
	}
	createSpan(opts: ElOpts = {}): FakeEl {
		return this.createEl("span", opts);
	}
	get firstChild(): FakeEl | null {
		return this.children[0] ?? null;
	}
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
	remove(): void {}
	setText(t: string): void {
		this.children.length = 0;
		this.textContent = t;
	}
	setCssStyles(styles: Record<string, string>): void {
		Object.assign(this.style, styles);
	}
	rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
	getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
		return this.rect;
	}
	captured: number | null = null;
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
	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}
	getAttribute(k: string): string | null {
		return this.attrs.get(k) ?? null;
	}
	removeAttribute(k: string): void {
		this.attrs.delete(k);
	}
	querySelector(sel: string): FakeEl | null {
		for (const kid of this.children) {
			const hit = sel.startsWith(".") ? kid.classes.has(sel.slice(1)) : kid.tag === sel;
			if (hit) return kid;
			const deep = kid.querySelector(sel);
			if (deep) return deep;
		}
		return null;
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
}

// Copied from src/inline/MobileTools.test.ts's fakeHost, phone (hasTouch) arm.
const fakeHost = (over: Partial<MobileToolsHost> = {}): MobileToolsHost => ({
	exec: () => {},
	activeTool: () => "pen",
	setPlacement: () => {},
	eraserOn: () => false,
	eraserWholeStroke: () => false,
	setEraserWholeStroke: () => {},
	lassoOn: () => false,
	spaceOn: () => false,
	panOn: () => false,
	toolColor: () => "#000000",
	eraserRadiusPx: () => 10,
	setEraserRadiusPx: () => {},
	inkSizeMult: () => 1,
	setInkSizeMult: () => {},
	canUndo: () => false,
	canRedo: () => false,
	canPasteInk: () => false,
	mouseInkOn: () => false,
	armMouseInkQuietly: () => {},
	disarmMouseInkQuietly: () => {},
	toast: () => {},
	recordingOn: () => false,
	hasInkSelection: () => false,
	paletteFor: () => [],
	pickColor: () => {},
	presetsFor: () => [],
	applyPreset: () => {},
	starPreset: () => {},
	forgetPreset: () => {},
	setEditorFocus: () => {},
	penInksHere: () => penInkEnabled(),
	hasTouch: () => true,
	...over,
});
const fakeNoteViewport = (): NonNullable<MobileToolsHost["noteViewport"]> => ({
	getNoteViewportState: () => ({ zoom: 1, busy: false, fitAvailable: true }),
	zoomNoteBy: () => true,
	resetNoteZoom: () => true,
	fitHandwriting: () => "ok",
});

// ------------------------------------------------ tiny cascade over styles.css
interface Decl {
	value: string;
	important: boolean;
	spec: number;
	order: number;
	selector: string;
	atRule: string | null;
}
interface Compound {
	tag: string | null;
	classes: string[];
}
function parseCompound(s: string): Compound | null {
	const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)$/.exec(s);
	if (!m) return null; // pseudo, attribute, combinator char: not modelled
	return { tag: m[1] ?? null, classes: (m[2] ?? "").split(".").filter(Boolean) };
}
interface Node {
	tag: string;
	classes: Set<string>;
}
function compoundHits(c: Compound, n: Node): boolean {
	if (c.tag && c.tag !== n.tag) return false;
	return c.classes.every((k) => n.classes.has(k));
}
/** Descendant-only selector match. `chain` is [element, parent, ..., body]. */
function selectorMatches(sel: string, chain: Node[]): { hit: boolean; spec: number; unmodelled: boolean } {
	const parts = sel.trim().split(/\s+/);
	const comps = parts.map(parseCompound);
	if (comps.some((c) => c === null)) return { hit: false, spec: 0, unmodelled: true };
	const cs = comps as Compound[];
	const last = cs[cs.length - 1]!;
	if (!compoundHits(last, chain[0]!)) return { hit: false, spec: 0, unmodelled: false };
	let i = 1;
	for (let k = cs.length - 2; k >= 0; k--) {
		while (i < chain.length && !compoundHits(cs[k]!, chain[i]!)) i++;
		if (i >= chain.length) return { hit: false, spec: 0, unmodelled: false };
		i++;
	}
	const spec = cs.reduce((s, c) => s + c.classes.length * 10 + (c.tag ? 1 : 0), 0);
	return { hit: true, spec, unmodelled: false };
}
const root = postcss.parse(css);
function cascade(chain: Node[], props: string[]): { won: Record<string, Decl | undefined>; all: Record<string, Decl[]>; unmodelled: string[] } {
	const all: Record<string, Decl[]> = {};
	const unmodelled: string[] = [];
	for (const p of props) all[p] = [];
	let order = 0;
	root.walkRules((rule) => {
		order++;
		const parent = rule.parent;
		const atRule = parent && parent.type === "atrule" ? `@${(parent as postcss.AtRule).name} ${(parent as postcss.AtRule).params}` : null;
		for (const sel of rule.selectors) {
			const r = selectorMatches(sel, chain);
			if (r.unmodelled) {
				// Report any unmodelled selector that names the element's own
				// classes AND sets a watched property, so nothing hides here.
				const names = [...chain[0]!.classes].some((c) => sel.includes(`.${c}`));
				if (names) rule.walkDecls((d) => void (props.includes(d.prop) && unmodelled.push(`${sel} { ${d.prop}: ${d.value} }`)));
				continue;
			}
			if (!r.hit) continue;
			rule.walkDecls((d) => {
				if (!props.includes(d.prop)) return;
				all[d.prop]!.push({ value: d.value, important: d.important, spec: r.spec, order, selector: sel, atRule });
			});
		}
	});
	const won: Record<string, Decl | undefined> = {};
	for (const p of props) {
		const live = all[p]!.filter((d) => d.atRule === null);
		live.sort((a, b) => Number(a.important) - Number(b.important) || a.spec - b.spec || a.order - b.order);
		won[p] = live[live.length - 1];
	}
	return { won, all, unmodelled };
}
/** px value of `calc(env(x, 0px) + Npx)` / `Npx` with env() = the given inset. */
function px(v: string | undefined, inset = 0): number {
	if (!v) return NaN;
	const s = v.replace(/env\([^)]*\)/g, `${inset}px`).replace(/calc\(|\)/g, "");
	return s.split("+").reduce((sum, t) => sum + parseFloat(t.trim()), 0);
}

// ------------------------------------------------------------------- probe
interface Box {
	top: number;
	bottom: number;
	rIn: number; // distance of the right edge from the pane's right edge
	rOut: number; // distance of the left edge from the pane's right edge
	z: number;
}
function zoomBarBox(): { box: Box; rules: Decl[] } {
	const chain: Node[] = [
		{ tag: "div", classes: new Set(["handwriting-note-viewport-controls"]) },
		{ tag: "div", classes: new Set() },
		{ tag: "body", classes: new Set(["is-mobile", "handwriting-android"]) },
	];
	const { won, all } = cascade(chain, ["top", "right", "bottom", "left", "z-index", "padding", "border", "gap", "transform", "inset"]);
	const btn = cascade(
		[{ tag: "button", classes: new Set() }, ...chain],
		["height", "min-width"]
	).won;
	const border = parseFloat(won.border!.value); // "1px solid ..."
	const padding = px(won.padding!.value);
	const gap = px(won.gap!.value);
	const bh = px(btn.height!.value);
	const bw = px(btn["min-width"]!.value);
	const top = px(won.top!.value);
	const right = px(won.right!.value);
	const height = 2 * border + 2 * padding + bh;
	const minWidth = 2 * border + 2 * padding + 4 * bw + 3 * gap; // four buttons, lower bound
	const rules = ["top", "right", "bottom", "left", "transform", "inset"].flatMap((p) => all[p]!);
	return { box: { top, bottom: top + height, rIn: right, rOut: right + minWidth, z: Number(won["z-index"]!.value) }, rules };
}
function pillBox(body: string[], inset: number): { box: Box; used: Record<string, string> } {
	const chain: Node[] = [
		{ tag: "button", classes: new Set(["handwriting-pen-pill", "handwriting-corner-top-right", "is-showing"]) },
		{ tag: "div", classes: new Set() },
		{ tag: "body", classes: new Set(body) },
	];
	const { won, unmodelled } = cascade(chain, ["top", "right", "width", "height", "z-index", "display", "transform"]);
	expect(unmodelled, "an unmodelled selector sets a placing property on the pill").toEqual([]);
	const top = px(won.top!.value, inset);
	const right = px(won.right!.value, 0);
	const box = { top, bottom: top + px(won.height!.value), rIn: right, rOut: right + px(won.width!.value), z: Number(won["z-index"]!.value) };
	const used: Record<string, string> = {};
	for (const [k, d] of Object.entries(won)) if (d) used[k] = `${d.value}  <- ${d.selector}`;
	return { box, used };
}
const centreCovered = (pill: Box, bar: Box): boolean => {
	const cy = (pill.top + pill.bottom) / 2;
	const cr = (pill.rIn + pill.rOut) / 2;
	return bar.z > pill.z && cy > bar.top && cy < bar.bottom && cr > bar.rIn && cr < bar.rOut;
};

describe("MobileTools-1-1: zoom bar over the collapsed pen pill", () => {
	beforeEach(() => {
		clearToolPicked();
		resetPenToolsForTest();
		resetNoteZoomControlsForTest();
		setCanvasNoteOverrideForTest(null);
	});
	afterEach(() => setCanvasNoteOverrideForTest(null));

	it("precondition (real MobileTools): zoom bar and pill are siblings, both showing, and nothing moves the zoom bar", () => {
		setZoomBarCanvasEnabled(true); // Infinite Canvas on (global), default "auto" zoom-bar mode
		const pane = new FakeEl("div", new FakeDoc());
		const strip = new MobileTools(pane as unknown as HTMLElement, fakeHost({ noteViewport: fakeNoteViewport(), notePath: () => "a.md" }));
		strip.setCorner("top-right"); // DEFAULT_TOOLBAR_CORNER
		strip.setCollapsed(true); // InkOverlay does this on every note open
		const bar = pane.children.find((c) => c.classes.has("handwriting-note-viewport-controls"));
		const pill = pane.children.find((c) => c.classes.has("handwriting-pen-pill"));
		const el = pane.children.find((c) => c.classes.has("handwriting-mobile-tools"));
		expect(getNoteZoomControlsMode()).toBe("auto");
		expect(bar, "zoom bar is a direct child of the same parent").toBeTruthy();
		expect(pill, "pill is a direct child of the same parent").toBeTruthy();
		expect(el!.classes.has("is-collapsed")).toBe(true);
		expect(pill!.classes.has("is-showing")).toBe(true);
		expect(pill!.classes.has("handwriting-corner-top-right")).toBe(true);
		expect(bar!.classes.has("is-hidden"), "zoom bar still shown while collapsed").toBe(false);
		expect(bar!.classes.has("is-inking")).toBe(false);
		// setCorner / paintTransform write only strip + pill.
		expect([...bar!.classes].filter((c) => c.startsWith("handwriting-corner-")), "zoom bar carries no corner class").toEqual([]);
		expect(bar!.style, "no inline placement on zoom bar").toEqual({});
		// Last strip BUTTON is the More chevron (right end of a flex-end row);
		// the divs after it are the folded row and the absolute pops.
		const btns = el!.children.filter((c) => c.tag === "button");
		console.log("[probe] strip children after last button:", JSON.stringify(el!.children.slice(el!.children.indexOf(btns[btns.length - 1]!) + 1).map((c) => `${c.tag}.${[...c.classes].join(".")}`)));
		expect(btns[btns.length - 1]!.classes.has("handwriting-tools-more")).toBe(true);
		strip.destroy();
	});

	it("styles.css: on Android the zoom bar resolves below the strip and pill (top 100, right 8, z 30); the phone rules move only its top", () => {
		const { box, rules } = zoomBarBox();
		console.log("[probe] zoom bar placing rules:", JSON.stringify(rules.map((r) => `${r.selector} { ${r.value} } ${r.atRule ?? ""}`)));
		console.log("[probe] zoom bar box:", JSON.stringify(box));
		// top + right from the base rule, plus one top each from the .is-mobile and .handwriting-android rules.
		expect(rules.length).toBe(4);
		expect(box.top).toBe(100);
		expect(box.rIn).toBe(8);
		expect(box.z).toBe(30);
	});

	it("control: desktop pill (no body class) is clear of the zoom bar", () => {
		const bar = zoomBarBox().box;
		const { box, used } = pillBox([], 0);
		console.log("[probe] desktop pill:", JSON.stringify(box), JSON.stringify(used));
		expect(centreCovered(box, bar)).toBe(false);
		expect(box.bottom <= bar.top).toBe(true);
	});

	it("control: iPad / non-notched iOS pill (is-mobile, inset 0) is clear of the zoom bar", () => {
		const bar = zoomBarBox().box;
		const { box, used } = pillBox(["is-mobile"], 0);
		console.log("[probe] iPad pill:", JSON.stringify(box), JSON.stringify(used));
		expect(centreCovered(box, bar)).toBe(false);
		expect(box.bottom <= bar.top).toBe(true);
	});

	it("CLAIM: Android pill (is-mobile + handwriting-android, inset 0) is not under the zoom bar", () => {
		const bar = zoomBarBox().box;
		const { box, used } = pillBox(["is-mobile", "handwriting-android"], 0);
		console.log("[probe] Android pill:", JSON.stringify(box), JSON.stringify(used));
		console.log("[probe] zoom bar:", JSON.stringify(bar));
		const fully = box.top >= bar.top && box.bottom <= bar.bottom && box.rIn >= bar.rIn && box.rOut <= bar.rOut;
		console.log("[probe] Android pill fully inside zoom bar box:", fully, " zoom z", bar.z, "> pill z", box.z);
		expect(centreCovered(box, bar), "Android: the pill's centre lies under the higher-z zoom bar").toBe(false);
	});

	it("CLAIM: notched iPhone pill (is-mobile, inset-top 47) is not under the zoom bar", () => {
		const bar = zoomBarBox().box;
		const { box } = pillBox(["is-mobile"], 47);
		console.log("[probe] iPhone inset 47 pill:", JSON.stringify(box));
		console.log("[probe] iPhone inset 59 pill:", JSON.stringify(pillBox(["is-mobile"], 59).box), "centre covered:", centreCovered(pillBox(["is-mobile"], 59).box, bar));
		expect(centreCovered(box, bar), "iPhone 47: the pill's centre lies under the higher-z zoom bar").toBe(false);
	});

	it("CLAIM: Android expanded strip's rightmost (More) button is not under the zoom bar", () => {
		const bar = zoomBarBox().box;
		const chain: Node[] = [
			{ tag: "div", classes: new Set(["handwriting-mobile-tools", "handwriting-corner-top-right"]) },
			{ tag: "div", classes: new Set() },
			{ tag: "body", classes: new Set(["is-mobile", "handwriting-android"]) },
		];
		const s = cascade(chain, ["top", "right", "padding", "border", "z-index"]).won;
		const b = cascade(
			[{ tag: "button", classes: new Set(["handwriting-mobile-tool", "handwriting-tools-more"]) }, ...chain],
			["width", "height"]
		).won;
		const top = px(s.top!.value), right = px(s.right!.value), pad = px(s.padding!.value), border = parseFloat(s.border!.value);
		const bw = px(b.width!.value), bh = px(b.height!.value);
		const btn: Box = { top: top + border + pad, bottom: top + border + pad + bh, rIn: right + border + pad, rOut: right + border + pad + bw, z: Number(s["z-index"]!.value) };
		console.log("[probe] Android strip rightmost button:", JSON.stringify(btn), JSON.stringify({ top: s.top?.selector, bw: b.width?.selector }));
		expect(centreCovered(btn, bar), "Android: the strip's rightmost button centre lies under the zoom bar").toBe(false);
	});
});
