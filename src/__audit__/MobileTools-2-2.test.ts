/**
 * AUDIT PROBE MobileTools-2-2 (1.4.21, tag 1a05f62c). Read-only audit; not part of the product suite.
 *
 * Claim: a mouse hover on the ACTIVE eraser reopens its size/mode pop and marks it hover-opened
 * (MobileTools.ts :1721-1731). Leaving the button schedules the 300 ms close (:1734-1737, :3587-3607),
 * which closes a hover-opened eraser pop (:3601-3605). The pop's own pointerenter (cancel the close) and
 * pointerdown (a contact is a decision) listeners are added only to the pen and highlighter pops
 * (:2279-2296), never to the eraser pop (this.slider, :2224-2249). So the pop vanishes under the cursor
 * 300 ms after the mouse leaves the button for the pop, even mid slider drag or after a chip click.
 *
 * Correct behaviour asserted: once the mouse has entered the eraser pop (and, in the other cells, pressed
 * its slider or clicked a mode chip), the pop is still showing after the close timer's 300 ms has passed.
 * A red here means the claimed mechanism is real. Preconditions asserted: the eraser is on, the pop was
 * closed by a real outside tap (the document pointerdown outsideTap handler), the mouse hover reopened it,
 * and the button's pointerleave armed a 300 ms timer. A CONTROL cell runs the identical sequence on the
 * PEN pop, which does carry the :2279 listeners, and must stay green: it shows the rig models the pop
 * listeners faithfully, so a red on the eraser is the missing listener and not the rig.
 *
 * Rig: the REAL MobileTools, on the fake DOM copied from src/inline/MobileTools.test.ts, with the host
 * fake copied from the same file. `window.setTimeout` is shimmed with a clock that records delays, as the
 * "hover previews a nib" describe in MobileTools.test.ts does, so time can be advanced exactly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTools, type MobileToolsHost } from "../inline/MobileTools";
import { resetPenToolsForTest, markPenHardwareSeen } from "../inline/PenToolsMode";
import { clearToolPicked, markToolPicked } from "../inline/MouseInk";
import { penInkEnabled } from "../inline/PenInk";

// Same honest setIcon mock MobileTools.test.ts uses: every call appends an svg.
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		setIcon: (parent: unknown): void => {
			(parent as { createEl(tag: string): unknown }).createEl("svg");
		},
	};
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
		if (at < 0) this.children.push(node);
		else this.children.splice(at, 0, node);
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
	findByTipLabel(label: string): FakeEl | null {
		for (const kid of this.children) {
			if (kid.dataset.tipLabel === label) return kid;
			const deep = kid.findByTipLabel(label);
			if (deep) return deep;
		}
		return null;
	}
}

// ---------------------------------------------------------------- host fake (copied from MobileTools.test.ts)
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
	hasTouch: () => false, // a desktop, mouse-only device
	...over,
});

// ---------------------------------------------------------------- fake clock for window.setTimeout
interface Timer { id: number; due: number; delay: number; fn: () => void }
let timers: Timer[] = [];
let now = 0;
let priorWindow: unknown;
const advance = (ms: number): void => {
	const until = now + ms;
	for (;;) {
		const next = timers.filter((t) => t.due <= until).sort((a, b) => a.due - b.due)[0];
		if (!next) break;
		timers.splice(timers.indexOf(next), 1);
		now = next.due;
		next.fn();
	}
	now = until;
};

beforeEach(() => {
	resetPenToolsForTest();
	clearToolPicked();
	timers = [];
	now = 0;
	let nextId = 1;
	priorWindow = (globalThis as Record<string, unknown>).window;
	(globalThis as Record<string, unknown>).window = {
		setTimeout: (fn: () => void, delay = 0): number => {
			const id = nextId++;
			timers.push({ id, due: now + delay, delay, fn });
			return id;
		},
		clearTimeout: (id: number): void => {
			const at = timers.findIndex((t) => t.id === id);
			if (at >= 0) timers.splice(at, 1);
		},
	};
});
afterEach(() => {
	(globalThis as Record<string, unknown>).window = priorWindow;
});

const descendants = (el: FakeEl): FakeEl[] => el.children.flatMap((kid) => [kid, ...descendants(kid)]);
const popByAria = (pane: FakeEl, aria: string): FakeEl => {
	const hit = descendants(pane).find(
		(el) =>
			el.classes.has("handwriting-slider-pop") &&
			descendants(el).some((kid) => kid.getAttribute("aria-label") === aria)
	);
	if (!hit) throw new Error(`no pop carrying "${aria}" was built`);
	return hit;
};

function buildEraserRig() {
	const doc = new FakeDoc();
	const pane = new FakeEl("div", doc);
	const outside = new FakeEl("div", doc); // a page element, not inside the strip
	const eraser = { value: false };
	const whole = { value: true };
	const host = fakeHost({
		eraserOn: () => eraser.value,
		eraserWholeStroke: () => whole.value,
		setEraserWholeStroke: (w: boolean) => { whole.value = w; },
		exec: (id: string) => {
			if (id === "handwriting:inline-tool-eraser") eraser.value = !eraser.value;
		},
	});
	const tools = new MobileTools(pane as unknown as HTMLElement, host);
	const btn = pane.findByTipLabel("Eraser");
	if (!btn) throw new Error("no Eraser button was built");
	const pop = popByAria(pane, "Eraser size");
	const input = descendants(pop).find((el) => el.getAttribute("aria-label") === "Eraser size")!;
	const reticle = descendants(pop).find((el) => el.textContent === "Reticle")!;
	// Pick the eraser up (the OFF-to-ON edge the strip watches), then erase on the page: the page
	// pointerdown reaches the document-level outsideTap, which runs closeInkSliders (:1380 -> :3079).
	eraser.value = true;
	tools.refreshNow();
	const showingAfterPickUp = pop.classes.has("is-showing");
	doc.fire("pointerdown", { target: outside, pointerType: "mouse" });
	doc.flushFrames();
	return { doc, tools, btn, pop, input, reticle, eraser, whole, showingAfterPickUp };
}

/** Mouse hovers the active eraser, then travels down off the button into its pop. */
function hoverThenEnterPop(r: ReturnType<typeof buildEraserRig>): void {
	expect(r.eraser.value, "precondition: eraser is on").toBe(true);
	expect(r.pop.classes.has("is-showing"), "precondition: the page click closed the eraser pop").toBe(false);
	r.btn.fire("pointerenter", { pointerType: "mouse" });
	r.doc.flushFrames();
	expect(r.pop.classes.has("is-showing"), "precondition: mouse hover reopened the eraser pop").toBe(true);
	r.btn.fire("pointerleave", { pointerType: "mouse" });
	expect(
		timers.some((t) => t.delay === 300),
		"precondition: leaving the button armed the 300 ms slider close"
	).toBe(true);
	// The pointer arrives on the pop (pointerenter does not bubble; it is dispatched to the pop itself).
	r.pop.fire("pointerenter", { pointerType: "mouse" });
}

describe("MobileTools-2-2: a hover-opened eraser pop under the mouse", () => {
	it("stays open once the mouse has moved from the eraser button onto its pop", () => {
		const r = buildEraserRig();
		expect(r.showingAfterPickUp, "precondition: picking the eraser up shows its pop").toBe(true);
		hoverThenEnterPop(r);
		advance(400); // the cursor rests on the pop past the 300 ms beat
		r.doc.flushFrames();
		expect(r.eraser.value, "the eraser is still the tool").toBe(true);
		expect(r.pop.classes.has("is-showing"), "eraser pop closed under the cursor 300 ms after leaving the button").toBe(true);
	});

	it("stays open while the mouse is dragging its size slider", () => {
		const r = buildEraserRig();
		hoverThenEnterPop(r);
		// Mouse presses the range input; the pointerdown bubbles input -> pop -> strip (document capture first).
		r.doc.fire("pointerdown", { target: r.input, pointerType: "mouse" });
		r.input.fire("pointerdown", { pointerType: "mouse" });
		r.pop.fire("pointerdown", { pointerType: "mouse", target: r.input });
		r.input.value = "20";
		r.input.fire("input", { pointerType: "mouse" });
		// Contact makes this a chosen pop. A later leave still arms the
		// normal close timer, but it must not close the chosen eraser pop.
		r.pop.fire("pointerleave", { pointerType: "mouse" });
		expect(timers.some((t) => t.delay === 300), "pop leave armed the close timer").toBe(true);
		advance(400);
		r.doc.flushFrames();
		expect(r.pop.classes.has("is-showing"), "eraser pop vanished mid slider drag").toBe(true);
	});

	it("stays open after the mouse clicks a Stroke/Reticle chip in it", () => {
		const r = buildEraserRig();
		hoverThenEnterPop(r);
		expect(r.whole.value, "precondition: Stroke is selected before the Reticle click").toBe(true);
		r.doc.fire("pointerdown", { target: r.reticle, pointerType: "mouse" });
		r.reticle.fire("pointerdown", { pointerType: "mouse" });
		r.pop.fire("pointerdown", { pointerType: "mouse", target: r.reticle });
		r.reticle.fire("click", { pointerType: "mouse" });
		r.doc.fire("pointerup", { target: r.reticle, pointerType: "mouse" });
		r.doc.flushFrames();
		expect(r.whole.value, "chip click changed the host from Stroke to Reticle").toBe(false);
		r.pop.fire("pointerleave", { pointerType: "mouse" });
		expect(timers.some((t) => t.delay === 300), "pop leave armed the close timer").toBe(true);
		advance(400);
		r.doc.flushFrames();
		expect(r.pop.classes.has("is-showing"), "eraser pop closed after a chip click under the cursor").toBe(true);
	});

	it("CONTROL: a hover-only eraser pop closes after leaving without contact", () => {
		const r = buildEraserRig();
		hoverThenEnterPop(r);
		r.pop.fire("pointerleave", { pointerType: "mouse" });
		expect(timers.some((t) => t.delay === 300), "pop leave armed the close timer").toBe(true);
		advance(400);
		r.doc.flushFrames();
		expect(r.pop.classes.has("is-showing")).toBe(false);
	});

	it("CONTROL: the pen pop, same hover -> leave -> enter pop sequence, stays open (it has the :2279 listeners)", () => {
		markPenHardwareSeen();
		markToolPicked();
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const tools = new MobileTools(pane as unknown as HTMLElement, fakeHost({ activeTool: () => "pen" }));
		const btn = pane.findByTipLabel("Pen")!;
		const pop = popByAria(pane, "Pen size");
		doc.flushFrames();
		btn.fire("pointerenter", { pointerType: "mouse" });
		doc.flushFrames();
		expect(tools.openNibSlider, "precondition: hover opened the pen pop").toBe("pen");
		expect(pop.classes.has("is-showing")).toBe(true);
		btn.fire("pointerleave", { pointerType: "mouse" });
		expect(timers.some((t) => t.delay === 300)).toBe(true);
		pop.fire("pointerenter", { pointerType: "mouse" });
		advance(400);
		doc.flushFrames();
		expect(pop.classes.has("is-showing"), "control: pen pop stays under the cursor").toBe(true);
		// And the no-entry case still closes, so the timer really is live in this rig.
		pop.fire("pointerleave", { pointerType: "mouse" });
		advance(400);
		doc.flushFrames();
		expect(pop.classes.has("is-showing"), "control: leaving the pen pop closes it").toBe(false);
	});
});
