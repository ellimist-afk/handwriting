/**
 * JOB6B findings on the phone/tablet strip (MobileTools). Each `it` not marked
 * CONTROL fails on master. Fake DOM copied from src/__audit__/MobileTools-2-2.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTools, type MobileToolsHost } from "./MobileTools";
import { markPenHardwareSeen, resetPenToolsForTest } from "./PenToolsMode";
import { clearToolPicked, markToolPicked } from "./MouseInk";
import { penInkEnabled } from "./PenInk";
import type { InkPreset } from "../ink/InkPresets";
import { HIGHLIGHTER_PEN } from "../ink/PenStyle";
import { INK_SIZE_STEPS, clampInkSize } from "../ink/InkSize";

vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, setIcon: (p: unknown): void => void (p as { createEl(t: string): unknown }).createEl("svg") };
});

interface ElOpts { cls?: string; text?: string; attr?: Record<string, string> }
class FakeDoc {
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	readonly frames: Array<() => void> = [];
	readonly defaultView = {
		requestAnimationFrame: (cb: () => void): number => this.frames.push(cb),
	};
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	removeEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		const at = list.indexOf(fn);
		if (at >= 0) list.splice(at, 1);
	}
	fire(type: string, ev: Record<string, unknown> = {}): void {
		const event = { type, defaultPrevented: false, preventDefault(): void {}, stopPropagation(): void {}, pointerType: "mouse", ...ev };
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
	}
	flushFrames(): void {
		for (let i = 0; i < 20 && this.frames.length > 0; i++) for (const cb of this.frames.splice(0)) cb();
	}
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
			if (want) this.classes.add(c); else this.classes.delete(c);
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
	createDiv(opts: ElOpts = {}): FakeEl { return this.createEl("div", opts); }
	createSpan(opts: ElOpts = {}): FakeEl { return this.createEl("span", opts); }
	get firstChild(): FakeEl | null { return this.children[0] ?? null; }
	insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl {
		const had = this.children.indexOf(node);
		if (had >= 0) this.children.splice(had, 1);
		const at = ref ? this.children.indexOf(ref) : -1;
		if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
		return node;
	}
	empty(): void { this.children.length = 0; this.textContent = ""; }
	remove(): void {}
	setText(t: string): void { this.children.length = 0; this.textContent = t; }
	setCssStyles(styles: Record<string, string>): void { Object.assign(this.style, styles); }
	rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
	getBoundingClientRect() { return this.rect; }
	captured: number | null = null;
	setPointerCapture(id: number): void { this.captured = id; }
	releasePointerCapture(id: number): void { if (this.captured === id) this.captured = null; }
	addClass(c: string): void { this.classes.add(c); }
	removeClass(c: string): void { this.classes.delete(c); }
	toggleClass(c: string, on: boolean): void { this.classList.toggle(c, on); }
	setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
	getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
	removeAttribute(k: string): void { this.attrs.delete(k); }
	querySelector(sel: string): FakeEl | null {
		for (const kid of this.children) {
			if (sel.startsWith(".") ? kid.classes.has(sel.slice(1)) : kid.tag === sel) return kid;
			const deep = kid.querySelector(sel);
			if (deep) return deep;
		}
		return null;
	}
	contains(node: unknown): boolean {
		return node === this || this.children.some((kid) => kid.contains(node));
	}
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	removeEventListener(): void {}
	fire(type: string, ev: Record<string, unknown> = {}): void {
		const event = { type, preventDefault(): void {}, stopPropagation(): void {}, pointerType: "mouse", target: this, ...ev };
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}
	findByTipLabel(label: string): FakeEl | null {
		for (const kid of this.children) {
			if (kid.dataset.tipLabel === label) return kid;
			const deep = kid.findByTipLabel(label);
			if (deep) return deep;
		}
		return null;
	}
}
const descendants = (el: FakeEl): FakeEl[] => el.children.flatMap((k) => [k, ...descendants(k)]);
const byClass = (el: FakeEl, cls: string): FakeEl[] => descendants(el).filter((k) => k.classes.has(cls));

const fakeHost = (over: Partial<MobileToolsHost> = {}): MobileToolsHost => ({
	exec: () => {}, activeTool: () => "pen", setPlacement: () => {},
	eraserOn: () => false, eraserWholeStroke: () => false, setEraserWholeStroke: () => {},
	lassoOn: () => false, spaceOn: () => false, panOn: () => false, toolColor: () => "#000000",
	eraserRadiusPx: () => 10, setEraserRadiusPx: () => {}, inkSizeMult: () => 1, setInkSizeMult: () => {},
	canUndo: () => false, canRedo: () => false, canPasteInk: () => false,
	mouseInkOn: () => false, armMouseInkQuietly: () => {}, disarmMouseInkQuietly: () => {},
	toast: () => {}, recordingOn: () => false, hasInkSelection: () => false,
	paletteFor: () => [], pickColor: () => {}, presetsFor: () => [], applyPreset: () => {},
	starPreset: () => {}, forgetPreset: () => {}, setEditorFocus: () => {},
	penInksHere: () => penInkEnabled(), hasTouch: () => true,
	...over,
});

/** A fake box that moves with the painted translate, so a drag can be measured. */
const liveRect = (el: FakeEl, r: { left: number; top: number; width: number; height: number }): void => {
	el.getBoundingClientRect = () => {
		const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform ?? "");
		const dx = m ? Number(m[1]) : 0, dy = m ? Number(m[2]) : 0;
		return { left: r.left + dx, top: r.top + dy, right: r.left + r.width + dx, bottom: r.top + r.height + dy, width: r.width, height: r.height };
	};
};

beforeEach(() => {
	resetPenToolsForTest();
	clearToolPicked();
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("F3 pill: a drag's click swallow that no click consumes eats the next Enter", () => {
	const folded = () => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const placed: string[] = [];
		const strip = new MobileTools(pane as unknown as HTMLElement, fakeHost({ setPlacement: (c) => void placed.push(c) }));
		strip.setCollapsed(false);
		const el = pane.querySelector(".handwriting-mobile-tools")!;
		const pill = pane.querySelector(".handwriting-pen-pill")!;
		pane.rect = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };
		liveRect(el, { left: 592, top: 8, width: 400, height: 40 });
		liveRect(pill, { left: 955, top: 11, width: 34, height: 34 });
		strip.setCollapsed(true);
		return { doc, el, pill, placed };
	};
	it("Escape mid-drag, lift off the pill, then Enter (click detail 0) opens the strip", () => {
		const r = folded();
		r.pill.fire("pointerdown", { pointerId: 7, clientX: 972, clientY: 28 });
		r.pill.fire("pointermove", { pointerId: 7, clientX: 872, clientY: 128 });
		r.doc.fire("keydown", { key: "Escape" });
		r.doc.fire("pointerup", { pointerId: 7 }); // lands 100px away: no click reaches the pill
		expect(r.placed).toEqual([]);
		r.pill.fire("click", { detail: 0 });
		expect(r.el.classes.has("is-collapsed")).toBe(false);
	});
	it("finger drag of the pill (touch synthesizes no click for a pan), then Enter opens the strip", () => {
		const r = folded();
		r.pill.fire("pointerdown", { pointerId: 21, clientX: 972, clientY: 28, pointerType: "touch" });
		r.pill.fire("pointermove", { pointerId: 21, clientX: 972, clientY: 328, pointerType: "touch" });
		r.doc.fire("pointerup", { pointerId: 21, pointerType: "touch" });
		expect(r.placed.length).toBe(1);
		vi.runAllTimers();
		r.pill.fire("click", { detail: 0 });
		expect(r.el.classes.has("is-collapsed")).toBe(false);
	});
	it("CONTROL: the click a mouse drop synthesizes on the pill is still swallowed", () => {
		const r = folded();
		r.pill.fire("pointerdown", { pointerId: 1, clientX: 972, clientY: 28 });
		r.pill.fire("pointermove", { pointerId: 1, clientX: 972, clientY: 328 });
		r.doc.fire("pointerup", { pointerId: 1 });
		r.pill.fire("click", { detail: 1 });
		expect(r.el.classes.has("is-collapsed")).toBe(true);
	});
});

describe("F4 quick-pen chip: hold-to-delete, then the finger lifts", () => {
	const openPenPop = (presets: InkPreset[], over: Partial<MobileToolsHost>) => {
		markPenHardwareSeen();
		markToolPicked();
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = new MobileTools(pane as unknown as HTMLElement, fakeHost({
			presetsFor: () => presets,
			forgetPreset: (_t, i) => void presets.splice(i, 1),
			...over,
		}));
		doc.flushFrames();
		const pen = pane.findByTipLabel("Pen")!;
		pen.fire("pointerdown", { pointerType: "touch" });
		pen.fire("pointerup", { pointerType: "touch" });
		pen.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
		return { doc, pane, strip };
	};
	it("the release click on the chip that slid under the finger neither applies it nor closes the pop", () => {
		const applied: number[] = [];
		const presets: InkPreset[] = [
			{ tool: "pen", hex: "#1a1a1a", name: "black", size: 1 },
			{ tool: "pen", hex: "#dd2222", name: "red", size: 2 },
		];
		const r = openPenPop(presets, { applyPreset: (_t, i) => void applied.push(i) });
		const before = byClass(r.pane, "handwriting-preset-chip");
		before[0]!.fire("pointerdown", { pointerType: "touch" });
		vi.advanceTimersByTime(600); // hold fires: black is forgotten, row rebuilt under the finger
		r.doc.flushFrames();
		const after = byClass(r.pane, "handwriting-preset-chip");
		expect(after).toHaveLength(1);
		after[0]!.fire("pointerup", { pointerType: "touch" });
		after[0]!.fire("click", { pointerType: "touch" });
		r.doc.flushFrames();
		expect({ applied, open: r.strip.openNibSlider }).toEqual({ applied: [], open: "pen" });
	});
	it("deleting the last chip does not star a new preset when the star slides under the finger", () => {
		const starred: string[] = [];
		const r = openPenPop([{ tool: "pen", hex: "#1a1a1a", name: "black", size: 1 }], {
			starPreset: (t) => void starred.push(t),
		});
		byClass(r.pane, "handwriting-preset-chip")[0]!.fire("pointerdown", { pointerType: "touch" });
		vi.advanceTimersByTime(600);
		r.doc.flushFrames();
		const star = byClass(r.pane, "handwriting-preset-star")[0]!;
		star.fire("pointerup", { pointerType: "touch" });
		star.fire("click", { pointerType: "touch" });
		expect(starred).toEqual([]);
	});
});

describe("F5 split view: Eraser tapped in pane A", () => {
	it("does not open the eraser size pop over pane B", () => {
		markPenHardwareSeen();
		markToolPicked();
		const doc = new FakeDoc();
		const paneA = new FakeEl("div", doc);
		const paneB = new FakeEl("div", doc);
		const state = { eraser: false };
		const strips: MobileTools[] = [];
		const host = () => fakeHost({
			eraserOn: () => state.eraser,
			exec: (id) => {
				if (id === "handwriting:inline-tool-eraser") state.eraser = !state.eraser;
				for (const s of strips) s.refresh(); // main.ts refreshAllStrips()
			},
		});
		strips.push(new MobileTools(paneA as unknown as HTMLElement, host()), new MobileTools(paneB as unknown as HTMLElement, host()));
		doc.flushFrames();
		const eraserPop = (pane: FakeEl) => byClass(pane, "handwriting-slider-pop")
			.find((p) => descendants(p).some((k) => k.getAttribute("aria-label") === "Eraser size"))!;
		const btn = paneA.findByTipLabel("Eraser")!;
		doc.fire("pointerdown", { target: btn, pointerType: "touch" });
		btn.fire("pointerdown", { pointerType: "touch" });
		btn.fire("pointerup", { pointerType: "touch" });
		btn.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(state.eraser).toBe(true);
		expect(eraserPop(paneA).classes.has("is-showing")).toBe(true);
		expect(eraserPop(paneB).classes.has("is-showing")).toBe(false);
	});
});

describe("F5 control: the eraser switched by a hotkey or the palette", () => {
	it("still opens the eraser size pop in every pane", () => {
		markPenHardwareSeen();
		markToolPicked();
		const doc = new FakeDoc();
		const paneA = new FakeEl("div", doc);
		const paneB = new FakeEl("div", doc);
		const state = { eraser: false };
		const strips: MobileTools[] = [];
		const host = () => fakeHost({ eraserOn: () => state.eraser });
		strips.push(new MobileTools(paneA as unknown as HTMLElement, host()), new MobileTools(paneB as unknown as HTMLElement, host()));
		doc.flushFrames();
		state.eraser = true; // main.ts: the command runs with no strip button pressed
		for (const s of strips) s.refresh();
		doc.flushFrames();
		const eraserPop = (pane: FakeEl) => byClass(pane, "handwriting-slider-pop")
			.find((p) => descendants(p).some((k) => k.getAttribute("aria-label") === "Eraser size"))!;
		expect(eraserPop(paneA).classes.has("is-showing")).toBe(true);
		expect(eraserPop(paneB).classes.has("is-showing")).toBe(true);
	});
});

describe("F6 highlighter pop after 'Ink size: bold'", () => {
	it("the readout names the width actually drawn (1.8 x 16 = 28.8px), not the slider max", () => {
		const stored = clampInkSize(INK_SIZE_STEPS.find((s) => s.name === "bold")!.mult);
		const drawn = stored * HIGHLIGHTER_PEN.baseWidth;
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		new MobileTools(pane as unknown as HTMLElement, fakeHost({
			activeTool: () => "highlighter",
			inkSizeMult: (tool) => (tool === "highlighter" ? stored : 1),
		}));
		const input = descendants(pane).find((el) => el.getAttribute("aria-label") === "Highlighter size")!;
		// <input type=range> value sanitization, as every browser does it: clamp to [min,max], snap to step.
		let raw = "";
		Object.defineProperty(input, "value", { configurable: true, get: () => raw, set: (v: string) => {
			const min = Number(input.getAttribute("min")), max = Number(input.getAttribute("max")), step = Number(input.getAttribute("step"));
			let n = Math.min(max, Math.max(min, Number(v)));
			n = min + Math.round((n - min) / step) * step;
			raw = String(Math.round(Math.min(n, max) * 1e6) / 1e6);
		} });
		const pop = byClass(pane, "handwriting-slider-pop").find((p) => p.contains(input))!;
		pane.findByTipLabel("Highlighter")!.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(pop.classes.has("is-showing")).toBe(true);
		expect(pop.querySelector(".handwriting-slider-num")!.textContent).toBe(`${drawn.toFixed(0)}px`);
	});
});

describe("F7 settings 'Toolbar buttons' preview strip", () => {
	it("a tap elsewhere in Settings does not close the preview's More row", () => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		new MobileTools(pane as unknown as HTMLElement, fakeHost(), { preview: true });
		const root = pane.querySelector(".handwriting-mobile-tools")!;
		// FoldOrderControl.syncMoreOpen opens the row by clicking the chevron.
		pane.querySelector(".handwriting-tools-more")!.fire("click", { pointerType: "touch" });
		expect(root.classes.has("is-more-open")).toBe(true);
		doc.fire("pointerdown", { target: new FakeEl("div", doc), pointerType: "touch" }); // e.g. the scroll to reach it
		expect(root.classes.has("is-more-open")).toBe(true);
	});
});
