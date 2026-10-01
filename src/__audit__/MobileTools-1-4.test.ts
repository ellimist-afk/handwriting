/**
 * AUDIT PROBE MobileTools-1-4 (1.4.21, tag 1a05f62c). Read-only audit; not part of the product suite.
 *
 * Claim: the strip's nib click handler (MobileTools.ts :1738) branches on `ev.pointerType` of the CLICK
 * event (:1786). WebKit before Safari/iOS 18.2 dispatches click as a plain MouseEvent, which has no
 * pointerType at all. On an iPhone (fingerInkAvailable true) at launch - pen nominally active, nothing
 * picked, so the nib is not lit - the only branch that turns the first finger tap into a pick is :1812,
 * gated on ptr === "touch". With ptr undefined the handler falls through to :1915, which only opens the
 * pen pop: no exec, no pick, the finger still cannot draw.
 *
 * Correct behaviour (the product's own spec, MobileTools.test.ts "the apparent default Pen tap picks and
 * arms instead of opening its slider"): a finger tap on the unpicked default Pen on an iPhone picks the
 * pen (exec inline-tool-pen), leaves toolPicked true and pen ink on, drops editor focus, and opens NO pop.
 * These cells assert that for a click event shaped the way older iOS WebKit delivers it (no pointerType
 * key), so they go red only if the handler really depends on the click's pointerType.
 *
 * Rig: the real MobileTools strip, real PenInk/MouseInk/PenToolsMode module state; fake DOM and fake host
 * copied verbatim from src/inline/MobileTools.test.ts (buildPhone is that file's own iPhone rig).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTools, nibIsLit, type MobileToolsHost } from "../inline/MobileTools";
import { clearToolPicked, markToolPicked, toolPickedHere } from "../inline/MouseInk";
import { penInkEnabled, resetPenInkForTest, setPenInk } from "../inline/PenInk";
import { markPenHardwareSeen, resetPenToolsForTest } from "../inline/PenToolsMode";

const icons = vi.hoisted(() => ({ appends: true }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		setIcon: (parent: unknown): void => {
			if (icons.appends) (parent as { createEl(tag: string): unknown }).createEl("svg");
		},
	};
});

// ---------------------------------------------------------------- fake host (copied from MobileTools.test.ts)
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
	hasTouch: () => false,
	...over,
});

// ---------------------------------------------------------------- fake DOM (copied from MobileTools.test.ts)
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
	fire(type: string, ev: Record<string, unknown> = {}): void {
		const event = { type, preventDefault: (): void => {}, pointerType: "mouse", ...ev };
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}
	flushFrames(): void {
		for (let i = 0; i < 20 && this.frames.length > 0; i++) {
			const due = this.frames.splice(0, this.frames.length);
			for (const cb of due) cb();
		}
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
			if (want) this.classes.add(c);
			else this.classes.delete(c);
			return want;
		},
	};

	constructor(
		readonly tag: string,
		readonly ownerDocument: FakeDoc,
		opts: ElOpts = {}
	) {
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
	/**
	 * A click the way WebKit before 18.2 delivers it: a plain MouseEvent, so the
	 * object has NO pointerType key at all (not "mouse", not "touch").
	 */
	fireLegacyWebKitClick(): Record<string, unknown> {
		const event: Record<string, unknown> = {
			type: "click",
			preventDefault: (): void => {},
			stopPropagation: (): void => {},
			target: this,
			button: 0,
			detail: 1,
		};
		for (const fn of this.listeners.get("click") ?? []) fn(event);
		return event;
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

// ---------------------------------------------------------------- the iPhone rig (MobileTools.test.ts buildPhone)
function buildPhone(fingerInk = true) {
	const doc = new FakeDoc();
	const pane = new FakeEl("div", doc);
	let active = "pen";
	const execed: string[] = [];
	const focused: boolean[] = [];
	const host = fakeHost({
		activeTool: () => active,
		fingerInkAvailable: () => fingerInk,
		exec: (id) => {
			execed.push(id);
			if (id === "handwriting:inline-tool-pen") active = "pen";
			if (id === "handwriting:inline-tool-highlighter") active = "highlighter";
			if (id === "handwriting:inline-tool-pen" || id === "handwriting:inline-tool-highlighter") {
				markToolPicked();
			}
			if (id === "handwriting:pen-ink-toggle") setPenInk(!penInkEnabled());
		},
		setEditorFocus: (on) => void focused.push(on),
		hasTouch: () => true,
	});
	const strip = new MobileTools(pane as unknown as HTMLElement, host);
	return { doc, pane, strip, execed, focused, host };
}

describe("MobileTools-1-4: iPhone first finger tap on the default Pen, click without pointerType", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		resetPenInkForTest();
		clearToolPicked();
	});
	afterEach(() => {
		resetPenInkForTest();
		resetPenToolsForTest();
		clearToolPicked();
	});

	function assertLaunchState(host: MobileToolsHost): void {
		// Launch on an iPhone: pen ink on (default), Pen is the nominal tool, nothing picked, nib dark.
		expect(host.fingerInkAvailable?.()).toBe(true);
		expect(penInkEnabled()).toBe(true);
		expect(host.penInksHere()).toBe(true);
		expect(host.activeTool()).toBe("pen");
		expect(toolPickedHere()).toBe(false);
		expect(nibIsLit(host, "pen")).toBe(false);
	}

	it("CONTROL: with click.pointerType 'touch' (Chromium / iOS >= 18.2) the tap picks the pen", () => {
		const { doc, pane, strip, execed, focused, host } = buildPhone();
		const pen = pane.findByTipLabel("Pen");
		if (!pen) throw new Error("no Pen button");
		assertLaunchState(host);

		pen.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(execed).toEqual(["handwriting:inline-tool-pen"]);
		expect(toolPickedHere()).toBe(true);
		expect(focused).toEqual([false]);
		expect(strip.openNibSlider).toBeNull();
		expect(nibIsLit(host, "pen")).toBe(true);
	});

	it("MECHANISM: the same finger tap delivered as a legacy-WebKit MouseEvent click also picks the pen", () => {
		const { doc, pane, strip, execed, focused, host } = buildPhone();
		const pen = pane.findByTipLabel("Pen");
		if (!pen) throw new Error("no Pen button");
		assertLaunchState(host);

		const ev = pen.fireLegacyWebKitClick();
		doc.flushFrames();
		// Precondition: the event really carried no pointerType, as a pre-18.2 WebKit click does.
		expect("pointerType" in ev).toBe(false);
		// Correct behaviour: the iPhone's first tap on the unpicked default nib picks the tool.
		expect({ execed, picked: toolPickedHere(), openPop: strip.openNibSlider, focused }).toEqual({
			execed: ["handwriting:inline-tool-pen"],
			picked: true,
			openPop: null,
			focused: [false],
		});
		expect(nibIsLit(host, "pen")).toBe(true);
	});

	it("a legacy click keeps its mouse pointerdown on a touch-capable device", () => {
		const { doc, pane, strip, execed, host } = buildPhone();
		const pen = pane.findByTipLabel("Pen");
		if (!pen) throw new Error("no Pen button");
		assertLaunchState(host);
		pen.fire("pointerdown", { pointerType: "mouse" });
		pen.fireLegacyWebKitClick();
		doc.flushFrames();
		expect(execed).toEqual([]);
		expect(strip.openNibSlider).toBe("pen");
	});

	it("MECHANISM (repeat): further legacy taps still never pick the pen", () => {
		const { doc, pane, strip, execed, host } = buildPhone();
		const pen = pane.findByTipLabel("Pen");
		if (!pen) throw new Error("no Pen button");
		assertLaunchState(host);
		for (let i = 0; i < 3; i++) {
			pen.fireLegacyWebKitClick();
			doc.flushFrames();
		}
		expect({ execed, picked: toolPickedHere(), lit: nibIsLit(host, "pen"), openPop: strip.openNibSlider }).toEqual({
			execed: ["handwriting:inline-tool-pen"],
			picked: true,
			lit: true,
			openPop: null,
		});
	});
});

describe("MobileTools-1-4 secondary: iPad finger re-tap on the active nib toggles its pop", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		resetPenInkForTest();
		clearToolPicked();
	});
	afterEach(() => {
		resetPenInkForTest();
		resetPenToolsForTest();
		clearToolPicked();
	});

	function litIpad() {
		const rig = buildPhone(false); // iPad: fingerInkAvailable false
		markPenHardwareSeen();
		markToolPicked();
		expect(rig.host.fingerInkAvailable?.()).toBe(false);
		expect(nibIsLit(rig.host, "pen")).toBe(true);
		return rig;
	}

	it("CONTROL: touch click opens then closes the pen pop", () => {
		const { doc, pane, strip } = litIpad();
		const pen = pane.findByTipLabel("Pen");
		if (!pen) throw new Error("no Pen button");
		pen.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
		pen.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBeNull();
	});

	it("MECHANISM: legacy-WebKit click (no pointerType) opens then closes the pen pop", () => {
		const { doc, pane, strip } = litIpad();
		const pen = pane.findByTipLabel("Pen");
		if (!pen) throw new Error("no Pen button");
		pen.fireLegacyWebKitClick();
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
		pen.fireLegacyWebKitClick();
		doc.flushFrames();
		expect(strip.openNibSlider).toBeNull();
	});
});
