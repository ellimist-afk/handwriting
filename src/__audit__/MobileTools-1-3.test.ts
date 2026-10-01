/**
 * AUDIT PROBE MobileTools-1-3 (1.4.21, tag 1a05f62c). Read-only audit; not part of the product suite.
 *
 * Claim: the note zoom bar (-, 100%, +, Fit) is built only inside the MobileTools constructor
 * (MobileTools.ts :1486-1503), and InkOverlay builds that strip only when
 * penToolsVisible(getPenToolsMode(), Platform.isMobileApp, penSeenThisSession()) is true
 * (InkOverlay.ts :2809-2811, destroyed at :2834-2837). On desktop with Toolbar visibility "auto" and no pen
 * seen, or with Toolbar visibility "hide", there is no strip, so there is no zoom bar, even with Infinite
 * Canvas on and Zoom bar on Auto/On ("Turns on Infinite canvas. Also turns on zoom bar.", main.ts :6123;
 * NoteZoomControlsMode.ts :13-16, :72-78 say the bar's existence does not ride the strip's pen-seen rule).
 *
 * Correct behaviour asserted: with Infinite Canvas on and the Zoom bar mode not "hide", an open note has a
 * zoom bar group, shown. The cells go red only if the bar is missing.
 *
 * Rig: the REAL InkOverlayPlugin.ensurePenTools / ensurePenToolsInner off the prototype (Object.create, the
 * idiom HoverRaisesPenTools.test.ts uses), which constructs the REAL MobileTools with the REAL production
 * host literal (InkOverlay.ts :2845-2982) on the REAL chromeHost(). Real PenToolsMode, NoteZoomControlsMode,
 * MouseInk. Only the editor view is faked: view.dom is a fake element with no parent (chromeHost() then
 * hangs the strip on view.dom itself), and state.field(editorInfoField) answers { app.commands, file }.
 * The control cells (Toolbar "show", and after a pen-tool command marks pen seen) prove the rig builds and
 * finds the bar when the strip exists, so a red elsewhere is the gate, not the rig.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { Platform, editorInfoField } from "obsidian";
import { InkOverlayPlugin, inlineInk, setScrollExpansionEnabled } from "../inline/InkOverlay";
import { refreshNoteZoomControlsAll } from "../inline/MobileTools";
import {
	getNoteZoomControlsMode,
	resetNoteZoomControlsForTest,
	setNoteZoomControlsMode,
	setZoomBarCanvasEnabled,
	getZoomBarCanvasEnabled,
} from "../inline/NoteZoomControlsMode";
import {
	getPenToolsMode,
	markPenSeen,
	penSeenThisSession,
	resetPenToolsForTest,
	setPenToolsMode,
} from "../inline/PenToolsMode";
import { mouseInkEnabled, setMouseInk } from "../inline/MouseInk";
import { canvasForNote } from "../inline/CanvasNoteOverride";
import { stripPenDown, stripPenUp } from "../inline/StripPenChrome";

type Fields = Record<string, unknown>;
const NOTE = "mt13-note.md";

// ---------------------------------------------------------------- fake DOM (copied from MobileTools-1-2 / MobileTools.test.ts)
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
	children: FakeEl[] = [];
	parent: FakeEl | null = null;
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
	readonly parentElement: FakeEl | null = null;
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
		el.parent = this;
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
		node.parent = this;
		return node;
	}
	empty(): void { this.children.length = 0; this.textContent = ""; }
	// Real removal, so a destroyed strip's zoom bar leaves the tree.
	remove(): void {
		if (!this.parent) return;
		const at = this.parent.children.indexOf(this);
		if (at >= 0) this.parent.children.splice(at, 1);
		this.parent = null;
	}
	setText(t: string): void { this.children.length = 0; this.textContent = t; }
	setCssStyles(styles: Record<string, string>): void { Object.assign(this.style, styles); }
	rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
	getBoundingClientRect() { return this.rect; }
	setPointerCapture(): void {}
	releasePointerCapture(): void {}
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
}

// ---------------------------------------------------------------- overlay rig: real ensurePenTools, fake editor view
function makeOverlay() {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	const doc = new FakeDoc();
	const dom = new FakeEl("div", doc, { cls: "cm-editor" }); // parentElement null -> chromeHost() returns view.dom
	const exec = vi.fn();
	const info = { app: { commands: { executeCommandById: exec } }, file: { path: NOTE } };
	o.view = { dom, state: { field: (f: unknown) => (f === editorInfoField ? info : undefined) } }; // no history field -> undoDepth 0
	o.container = {}; // mounted
	o.mobileTools = null;
	o.chromeHostPatched = null;
	o.selection = { isEmpty: true }; // read by the host literal's hasInkSelection (:2937)
	const ensure = () => {
		(o.ensurePenTools as () => void).call(o);
		// ensurePenTools swallows a throw into console.error; surface it so a rig gap is never read as the gate.
		const bad = errSpy.mock.calls.find((c: unknown[]) => c[0] === "[handwriting] pen tools strip failed");
		if (bad) throw bad[1];
	};
	const bar = () => dom.querySelector(".handwriting-note-viewport-controls");
	return {
		o,
		dom,
		ensure,
		bar,
		stripBuilt: () => o.mobileTools !== null && o.mobileTools !== undefined,
		barShown: () => {
			const b = bar();
			return b !== null && !b.classes.has("is-hidden");
		},
		destroy: () => {
			(o.mobileTools as { destroy(): void } | null)?.destroy();
			o.mobileTools = null;
			(o.noteZoomControls as { destroy(): void } | null)?.destroy();
			o.noteZoomControls = null;
		},
	};
}

function infiniteCanvasOn(): void {
	// main.ts setControlValue("extendCanvasWhileScrolling", true) (:6488-6497): both halves plus the push.
	setScrollExpansionEnabled(true);
	setZoomBarCanvasEnabled(true);
	refreshNoteZoomControlsAll();
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	resetPenToolsForTest(); // Toolbar visibility "auto", penSeen false, no hardware latch
	resetNoteZoomControlsForTest(); // Zoom bar "auto"
	setMouseInk(false); // main.ts:543 default
	infiniteCanvasOn();
	errSpy = vi.spyOn(console, "error");
});
afterEach(() => {
	setScrollExpansionEnabled(false);
	setZoomBarCanvasEnabled(true);
	errSpy.mockRestore();
	vi.restoreAllMocks();
});

describe("MobileTools-1-3: the zoom bar exists only while the pen strip does", () => {
	it("preconditions: desktop, Toolbar auto, no pen seen, mouse ink off, Infinite Canvas on, Zoom bar auto", () => {
		expect(Platform.isMobileApp).toBe(false);
		expect(getPenToolsMode()).toBe("auto");
		expect(penSeenThisSession()).toBe(false);
		expect(mouseInkEnabled()).toBe(false);
		expect(getZoomBarCanvasEnabled()).toBe(true);
		expect(canvasForNote(NOTE, true)).toBe(true);
		expect(getNoteZoomControlsMode()).toBe("auto");
	});

	it("CONTROL: Toolbar On -> the real ensurePenTools builds the strip and a shown zoom bar the rig can find", () => {
		setPenToolsMode("show");
		const r = makeOverlay();
		r.ensure();
		expect(errSpy, "ensurePenTools threw inside its try/catch").not.toHaveBeenCalled();
		expect(r.stripBuilt(), "control: strip built").toBe(true);
		expect(r.bar(), "control: zoom bar group built on chromeHost").not.toBeNull();
		expect(r.barShown(), "control: zoom bar shown (canvas on, mode auto)").toBe(true);
		r.destroy();
		expect(r.bar(), "control: overlay teardown removes the zoom bar").toBeNull();
	});

	it("CONTROL: after a pen-tool command marks pen seen, the zoom bar appears (the only way in on a mouse desktop)", () => {
		const r = makeOverlay();
		r.ensure();
		expect(r.stripBuilt()).toBe(false);
		markPenSeen(); // what main.ts :3156/:4013/:4470 do on a pen-tool / color command
		r.ensure(); // refreshPenToolsAll -> ensurePenTools
		expect(errSpy).not.toHaveBeenCalled();
		expect(r.stripBuilt()).toBe(true);
		expect(r.barShown()).toBe(true);
		r.destroy();
	});

	it("TRIGGER 1: mouse/trackpad desktop, Toolbar Auto, Infinite Canvas on, Zoom bar Auto -> a zoom bar must exist", () => {
		const r = makeOverlay();
		r.ensure(); // mount path, InkOverlay.ts :2310-2311
		expect(errSpy, "ensurePenTools threw inside its try/catch").not.toHaveBeenCalled();
		// Mechanism: the strip gate said no.
		expect(r.stripBuilt(), "mechanism: penToolsVisible(auto, desktop, unseen) = false, no strip").toBe(false);
		// The Infinite canvas row's push after the fact builds nothing either.
		infiniteCanvasOn();
		refreshNoteZoomControlsAll();
		expect(r.bar(), "no zoom bar at all on a desktop note with Infinite Canvas on and Zoom bar Auto").not.toBeNull();
		expect(r.barShown()).toBe(true);
		r.destroy();
	});

	it("TRIGGER 1b: same with Zoom bar explicitly On", () => {
		setNoteZoomControlsMode("show");
		const r = makeOverlay();
		r.ensure();
		expect(errSpy).not.toHaveBeenCalled();
		expect(r.bar(), "no zoom bar with Zoom bar = On, Infinite Canvas on, Toolbar Auto, no pen").not.toBeNull();
		expect(r.barShown()).toBe(true);
		r.destroy();
	});

	it("TRIGGER 2: Toolbar Off with Zoom bar On and Infinite Canvas on -> the zoom bar must still exist", () => {
		setNoteZoomControlsMode("show");
		setPenToolsMode("show");
		const r = makeOverlay();
		r.ensure();
		expect(r.barShown(), "setup: bar present while the toolbar is On").toBe(true);
		setPenToolsMode("hide"); // settings row / toolbar toggle command; the mode listener fans out
		r.ensure(); // refreshPenToolsAll -> ensurePenTools
		expect(errSpy).not.toHaveBeenCalled();
		expect(r.stripBuilt(), "mechanism: Toolbar Off destroyed the strip").toBe(false);
		expect(r.bar(), "Toolbar Off took the zoom bar with it although Zoom bar = On").not.toBeNull();
		expect(r.barShown()).toBe(true);
		r.destroy();
	});

	it("after a pan ends, ready zoom buttons re-enable without another event", async () => {
		setPenToolsMode("hide");
		vi.spyOn(inlineInk, "isLoaded").mockReturnValue(true);
		vi.spyOn(inlineInk, "deleteAllReadiness").mockReturnValue({ kind: "ready" } as never);
		const r = makeOverlay();
		Object.assign(r.o, {
			frame: { locked: false, end() {} }, builder: null, mode: "ink", canvasMode: true, pinchScaleNow: 1,
			retryCanvasOffReset() {}, hidePenCursor() {}, restoreReticleAfterPan() {}, updateExtent() {},
		});
		try {
			r.ensure();
			const buttons = r.bar()!.children;
			expect(buttons.map(b => b.disabled), "precondition: ready zoom buttons").toEqual([false, false, false, false]);
			r.o.mode = "pan";
			(r.o.noteZoomControls as { setInking(on: boolean): void }).setInking(true);
			(r.o.endPenGesture as () => void).call(r.o);
			await Promise.resolve();
			await Promise.resolve();
			expect(r.o.mode).toBe("ink");
			expect((r.o.getNoteViewportState as () => { busy: boolean }).call(r.o).busy).toBe(false);
			expect(r.bar()!.classes.has("is-inking")).toBe(false);
			expect(buttons.map(b => b.disabled), "ready zoom buttons after pan").toEqual([false, false, false, false]);
		} finally { r.destroy(); }
	});

	it("shared pen chrome reaches zoom once with and without a pen strip", async () => {
		const down = stripPenDown as (...args: unknown[]) => void;
		const up = stripPenUp as (...args: unknown[]) => void;
		for (const tools of [null, { setInking: vi.fn(), closeInkSliders: vi.fn(), refresh: vi.fn() }]) {
			const zoom = { setInking: vi.fn(), penUp: vi.fn() };
			down(tools, zoom);
			expect(zoom.setInking).toHaveBeenCalledExactlyOnceWith(true);
			up(tools, zoom);
			expect(zoom.penUp).toHaveBeenCalledOnce();
			await Promise.resolve();
		}
	});
});
