import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MobileTools, nibIsLit, type MobileToolsHost } from "./MobileTools";
// markPenHardwareSeen, not markPenSeen: these tests want "a pen exists", and
// markPenSeen only means "show the strip" - it is set by every tool command,
// which is exactly the confusion that left the nib light stuck on for three
// releases. See PenToolsMode.ts's `penHardware`.
import {
	clearPenHardwareSeen,
	markPenHardwareSeen,
	markPenSeen,
	penSeenThisSession,
	resetPenToolsForTest,
} from "./PenToolsMode";
import { consumeMousePutDown } from "./MouseInk";

/**
 * Obsidian's real `setIcon` APPENDS an svg to the parent; it does not clear
 * what is already there. The suite-wide stub (test/obsidian-stub.ts) is a
 * no-op, which is the same assumption that let the pill stack icons up in the
 * first place, so this file mocks the honest behaviour instead: every call
 * adds one more <svg>. `appends` false is the other real case - an icon name
 * Obsidian does not know renders nothing - which is what the glyph fallback
 * downstream of every setIcon call is there for.
 */
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

/**
 * nibIsLit is the pure seam that fell out of splitting the light's predicate
 * from the click chain's (design doc 1.4.6 §6a, "the pen button unhilights
 * when the mouse hands the tool back"): pin it directly with a fake host.
 *
 * The strip class itself is constructed further down, against the fake
 * element tree in this file. The header here used to say it could not be -
 * that was true when nibIsLit was extracted and is not any more.
 */
const fakeHost = (over: Partial<MobileToolsHost> = {}): MobileToolsHost => ({
	exec: () => {},
	activeTool: () => "pen",
	eraserOn: () => false,
	eraserWholeStroke: () => false,
	setEraserWholeStroke: () => {},
	lassoOn: () => false,
	spaceOn: () => false,
	panOn: () => false,
	activeColor: () => "#000000",
	eraserRadiusPx: () => 10,
	setEraserRadiusPx: () => {},
	inkSizeMult: () => 1,
	setInkSizeMult: () => {},
	canUndo: () => false,
	canRedo: () => false,
	canPasteInk: () => false,
	mouseInkOn: () => false,
	setMouseInk: () => {},
	armMouseInkQuietly: () => {},
	disarmMouseInkQuietly: () => {},
	recordingOn: () => false,
	hasInkSelection: () => false,
	palette: () => [],
	pickColor: () => {},
	...over,
});

describe("nibIsLit", () => {
	beforeEach(() => resetPenToolsForTest());

	it("is lit for a pen that has been seen this session, mouse ink off", () => {
		markPenHardwareSeen();
		expect(nibIsLit(fakeHost({ activeTool: () => "pen", mouseInkOn: () => false }), "pen")).toBe(true);
	});

	it("is dark for a mouse user with mouse ink off and no pen seen", () => {
		expect(nibIsLit(fakeHost({ activeTool: () => "pen", mouseInkOn: () => false }), "pen")).toBe(
			false
		);
	});

	// ALAN'S RULE, 2026-09-03: the light is dark "until you touch with your
	// pen", and turning mouse ink off puts it out "at any point". Before this
	// the hardware flag latched for the whole session, so once he had used his
	// pen the button stayed lit however often mouse ink was switched off - by
	// hand it read as stuck, and no amount of toggling could make it go dark.
	it("goes dark when mouse ink is turned off, even after a pen has been seen", () => {
		markPenHardwareSeen();
		const off = fakeHost({ activeTool: () => "pen", mouseInkOn: () => false });
		expect(nibIsLit(off, "pen")).toBe(true);
		clearPenHardwareSeen();
		expect(nibIsLit(off, "pen")).toBe(false);
	});

	it("comes back on the next pen contact - the whole of 'until you touch with your pen'", () => {
		markPenHardwareSeen();
		clearPenHardwareSeen();
		const off = fakeHost({ activeTool: () => "pen", mouseInkOn: () => false });
		expect(nibIsLit(off, "pen")).toBe(false);
		// Both surfaces call this on every real pen contact.
		markPenHardwareSeen();
		expect(nibIsLit(off, "pen")).toBe(true);
	});

	it("leaves the TOOLBAR alone - clearing the light must not take the strip away", () => {
		// The half he was explicit about twice, and the reason the clear is
		// narrow: "make turning ink turns off the pen light, but NOT the
		// toolbar off", then "why the fuck would the toolbar disappear".
		// `penSeen` decides the strip exists; only `penHardware` may be
		// cleared here. Clearing both would delete the toolbar out from under
		// him, which is the opposite of the request.
		markPenHardwareSeen();
		expect(penSeenThisSession()).toBe(true);
		clearPenHardwareSeen();
		expect(penSeenThisSession()).toBe(true);
	});

	it("still lights for an armed mouse with no pen, which the clear must not break", () => {
		// A mouse user's light does not ride the hardware flag at all - it
		// rides `mouseInkOn()`. Pinned because the obvious wrong fix for the
		// rule above is to drop the `|| h.mouseInkOn()` disjunct, and that
		// would leave a mouse user staring at a dark button while their mouse
		// was drawing.
		clearPenHardwareSeen();
		expect(nibIsLit(fakeHost({ activeTool: () => "pen", mouseInkOn: () => true }), "pen")).toBe(
			true
		);
	});

	it("is lit for a mouse user with mouse ink armed, no pen seen", () => {
		expect(nibIsLit(fakeHost({ activeTool: () => "pen", mouseInkOn: () => true }), "pen")).toBe(true);
	});

	it("is dark when the tip is claimed by another mode, even if mouse ink is on", () => {
		expect(
			nibIsLit(
				fakeHost({ activeTool: () => "pen", mouseInkOn: () => true, eraserOn: () => true }),
				"pen"
			)
		).toBe(false);
	});

	it("is dark when the nominal tool is not this nib", () => {
		markPenHardwareSeen();
		expect(nibIsLit(fakeHost({ activeTool: () => "highlighter" }), "pen")).toBe(false);
	});

	it("checks the highlighter independently of the pen", () => {
		expect(
			nibIsLit(fakeHost({ activeTool: () => "highlighter", mouseInkOn: () => true }), "highlighter")
		).toBe(true);
	});
});

/**
 * A fake element tree, enough of one for the strip to build itself in.
 *
 * The suite runs on node with no DOM and no jsdom dependency, and the strip
 * needs Obsidian's HTMLElement extensions (createEl/createDiv/createSpan,
 * setText, setCssStyles, toggleClass) as much as it needs the standard ones.
 * Both are implemented here rather than shimmed onto a real prototype: the
 * strip only ever touches the handful of calls below, and a fake that
 * records classes is exactly what an assertion about `is-disabled` wants to
 * read. Measurement (getBoundingClientRect, offsetWidth) IS reached, by the
 * reader these tests get as far as: `hangUnder` returns before measuring
 * while a pop is shut - the state the C16 tests below run in - and goes on
 * to measure the strip and the button when one opens, to centre the pop
 * under it. It used to be true that no test here opened one at all. Three
 * groups at the foot of this file now do: the eraser's pop off the mode's
 * own OFF-to-ON edge, all three pops under the held-slider tests, and the
 * eraser's again off the tap that reopens it. So the rects answer zeros
 * rather than not answering at all. Nothing asserts on the placement they
 * produce - only on whether a pop is showing, and on what its slider holds.
 */
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
	/** Fire a DOCUMENT-level handler: the strip releases a held slider here,
	 * because a drag very often ends with the pointer off the input. */
	fire(type: string, ev: Record<string, unknown> = {}): void {
		const event = { preventDefault: (): void => {}, pointerType: "mouse", ...ev };
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}
	/** Run every frame callback `refresh()` queued, including any queued by one. */
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
	/** Zeros: nothing here asserts on where an open pop is placed. */
	getBoundingClientRect(): { left: number; right: number; width: number } {
		return { left: 0, right: 0, width: 0 };
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
	/** Tag ("svg") or one class (".handwriting-sr-only"); nothing else is used. */
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
	/** Fire the handlers the strip registered, the way a real click would. */
	fire(type: string, ev: Record<string, unknown> = {}): void {
		const event = {
			preventDefault: (): void => {},
			stopPropagation: (): void => {},
			pointerType: "mouse",
			target: this,
			...ev,
		};
		for (const fn of this.listeners.get(type) ?? []) fn(event);
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
}

/**
 * C16, design doc 5i: Redo can sit lit and dead.
 *
 * The strip reads enablement two ways that disagree. Live, at click time:
 * `isEnabled` runs the host predicate fresh. Cached, as a class: `is-disabled`
 * is written by `refresh()` and stays until the next one - and nothing on the
 * note surface refreshes the strip when the document changes. Undo, so Redo
 * lights; type, and CodeMirror drops the redo stack; the button still looks
 * available and every press does nothing, forever.
 */
describe("MobileTools: a dimmed button's refused click corrects the stale class", () => {
	beforeEach(() => resetPenToolsForTest());

	/**
	 * Builds the strip on a fake pane and hands back the pieces a test drives.
	 * `canRedo` reads a live box, so a test can flip the predicate WITHOUT
	 * telling the strip - which is the defect itself, not a shortcut around it.
	 */
	const buildStrip = (
		redo: { value: boolean }
	): { doc: FakeDoc; execed: string[]; redoBtn: FakeEl } => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const execed: string[] = [];
		const host = fakeHost({
			canRedo: () => redo.value,
			exec: (id: string) => void execed.push(id),
		});
		new MobileTools(pane as unknown as HTMLElement, host);
		const redoBtn = pane.findByTipLabel("Redo");
		if (!redoBtn) throw new Error("no Redo button was built");
		return { doc, execed, redoBtn };
	};

	it("dims Redo on the wasted press, once the redo stack went away underneath it", () => {
		// Redo is live when the strip is built, so it paints as available.
		const redo = { value: true };
		const { doc, execed, redoBtn } = buildStrip(redo);
		expect(redoBtn.classes.has("is-disabled")).toBe(false);

		// The document changes and CodeMirror drops the redo stack. Nothing
		// here refreshes the strip, so the LIVE predicate is now false while
		// the CACHED class still says available. That divergence is what the
		// user is looking at, and flipping the predicate alone is exactly how
		// typing produces it.
		redo.value = false;
		doc.flushFrames();
		expect(redoBtn.classes.has("is-disabled")).toBe(false);

		// Press it. The click guard refuses the command - correctly, there is
		// nothing to redo - and that refusal is the button's one chance to
		// stop lying about itself. No toast: the user asked for nothing (the
		// eraser/Backspace ruling, 2026-09-02). It just goes dim.
		redoBtn.fire("click");
		doc.flushFrames();

		expect(execed).not.toContain("editor:redo");
		expect(redoBtn.classes.has("is-disabled")).toBe(true);
		expect(redoBtn.getAttribute("aria-disabled")).toBe("true");
	});

	it("still runs Redo, and leaves it undimmed, while the redo stack is really there", () => {
		// The other half: a genuinely available button must not be dimmed by
		// the correction above. Without this, a "fix" that dimmed everything
		// on click would satisfy the test before it.
		const redo = { value: true };
		const { doc, execed, redoBtn } = buildStrip(redo);

		redoBtn.fire("click");
		doc.flushFrames();

		expect(execed).toContain("editor:redo");
		expect(redoBtn.classes.has("is-disabled")).toBe(false);
		expect(redoBtn.getAttribute("aria-disabled")).toBe("false");
	});
});

/**
 * The collapsed pill wore every tool it had ever been rather than the one in
 * hand: a pen and a highlighter overlapping inside the one circle, reported
 * with screenshots twice (alan, and samuelbits - "though it works properly",
 * which is the whole of it, the pill is cosmetic).
 *
 * `setIcon` appends, so the swap path needed the same `empty()` the chevron
 * in `setCorner` has had since the chevrons stacked the same way (glass,
 * 2026-08-31). Present since the pill started wearing the tool in hand, 1.4.5
 * included; not a 1.4.6 regression.
 */
describe("MobileTools: the collapsed pill wears one tool, not all of them", () => {
	beforeEach(() => resetPenToolsForTest());
	afterEach(() => {
		icons.appends = true;
	});

	/** Direct children only - setIcon puts its svg straight on the pill. */
	const svgCount = (el: FakeEl): number => el.children.filter((k) => k.tag === "svg").length;

	const buildPill = (over: Partial<MobileToolsHost>): { strip: MobileTools; pill: FakeEl } => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = new MobileTools(pane as unknown as HTMLElement, fakeHost(over));
		const pill = pane.querySelector(".handwriting-pen-pill");
		if (!pill) throw new Error("no pen pill was built");
		return { strip, pill };
	};

	it("swaps the pill's icon on a tool change instead of stacking a second one", () => {
		markPenHardwareSeen();
		const tool = { value: "pen" };
		const lasso = { value: false };
		const { strip, pill } = buildPill({
			activeTool: () => tool.value,
			lassoOn: () => lasso.value,
		});

		// Preconditions. The pill has to be wearing something to begin with,
		// or "exactly one svg" below could pass on a pill that never drew an
		// icon at all.
		expect(pill.dataset.icon).toBe("pen");
		expect(svgCount(pill)).toBe(1);

		// Change one: pen -> highlighter, which is the report verbatim.
		tool.value = "highlighter";
		strip.refreshNow();
		expect(pill.dataset.icon).toBe("highlighter");

		// Change two: the lasso claims the tip, the nibs go dark, and the
		// pill follows to a third icon. dataset.icon is asserted at each step
		// because the swap block is guarded on it - a change that did not
		// change anything would leave this test passing for no reason.
		lasso.value = true;
		strip.refreshNow();
		expect(pill.dataset.icon).toBe("lasso");

		// The defect, as the screenshots show it.
		expect(svgCount(pill)).toBe(1);

		// Clearing the pill takes the screen reader's name with it, so it has
		// to go back in the same move, carrying the NEW label.
		expect(pill.querySelector(".handwriting-sr-only")?.textContent).toBe("Lasso tools");
		expect(pill.dataset.tipLabel).toBe("Lasso tools");
	});

	it("still falls back to the glyph when the icon renders nothing", () => {
		// Not the defect - a guard on the fix. `setText` on a pill that was
		// just emptied has to leave the same glyph behind it left on one full
		// of stale svgs, and the sr-only name still has to survive it.
		icons.appends = false;
		markPenHardwareSeen();
		const tool = { value: "pen" };
		const { strip, pill } = buildPill({ activeTool: () => tool.value });
		expect(svgCount(pill)).toBe(0);
		expect(pill.textContent).toBe("P");

		tool.value = "highlighter";
		strip.refreshNow();

		expect(pill.dataset.icon).toBe("highlighter");
		expect(svgCount(pill)).toBe(0);
		expect(pill.textContent).toBe("H");
		expect(pill.querySelector(".handwriting-sr-only")?.textContent).toBe("Highlighter tools");
	});
});

/**
 * A newly mounted strip does not open the eraser pop by itself.
 *
 * `wasEraserOn` is per-strip; the tip mode it watches is global. So a strip
 * built while the eraser was already on ran its constructor's `refreshNow`
 * with `wasEraserOn` still false, read that as the OFF-to-ON edge, and hung
 * the eraser's size pop open with no user action behind it - on every new
 * pane, every split and every popout, and again on each one after that.
 *
 * The edge itself is load-bearing and must survive the fix: it is a touch
 * user's only route back to the pop once pen contact has closed it, and it
 * is the route the palette command and a hotkey both take, neither of which
 * passes through this file's own click handler.
 */
describe("MobileTools: the eraser pop opens on a deliberate switch, not on mount", () => {
	beforeEach(() => resetPenToolsForTest());

	/** The eraser's pop is the first `dropSlider` the strip builds. */
	const eraserPop = (pane: FakeEl): FakeEl => {
		const pop = pane.querySelector(".handwriting-slider-pop");
		if (!pop) throw new Error("no slider pop was built");
		// Named rather than assumed: three pops share the class, and the pen
		// and highlighter ones are built after this. If that order ever
		// changes, this fails loudly instead of asserting about the wrong pop.
		const label = pop.querySelector("input")?.getAttribute("aria-label");
		if (label !== "Eraser size") throw new Error(`first pop is ${label}, not the eraser's`);
		return pop;
	};

	const buildStrip = (over: Partial<MobileToolsHost>): { strip: MobileTools; pop: FakeEl } => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const strip = new MobileTools(pane as unknown as HTMLElement, fakeHost(over));
		return { strip, pop: eraserPop(pane) };
	};

	it("stays shut on a strip mounted while the eraser is already on", () => {
		const { strip, pop } = buildStrip({ eraserOn: () => true });

		expect(pop.classes.has("is-showing")).toBe(false);

		// And it does not arrive one refresh late: a pane that opened the pop
		// on its second frame would be the same defect, deferred.
		strip.refreshNow();
		expect(pop.classes.has("is-showing")).toBe(false);
	});

	it("still opens when the eraser is switched on while the strip is up", () => {
		// The real edge, and the only way back to the pop for a touch user
		// once pen contact has closed it. A fix that suppressed this has
		// traded one defect for a worse one.
		const on = { value: false };
		const { strip, pop } = buildStrip({ eraserOn: () => on.value });

		expect(pop.classes.has("is-showing")).toBe(false);

		on.value = true;
		strip.refreshNow();

		expect(pop.classes.has("is-showing")).toBe(true);
	});
});

/**
 * "Weird distortion on the pen slider as i slide it up and down, like the
 * slider is just vibrating" (alan, on hardware, 2026-09-02; 1.4.7 from the
 * store, and the same code is in 1.4.6).
 *
 * `hangUnder` writes `slider.input.value` on EVERY `refreshNow` while a pop
 * is showing, with nothing asking whether that input is under a finger.
 * Refreshes land while a slider is open from several directions - a hover
 * preview on the next button along, the 300ms close timer, any command that
 * goes through refreshAllStrips - and each one shoves the control the user
 * is holding.
 *
 * Whatever an engine does with a value assigned mid-drag (the thumb may hold
 * still, it may jump, the drag may be dropped entirely - this is the part
 * nobody has demonstrated yet), writing into a control the user is holding
 * is wrong on all of them. The guard is that rule and nothing more, so it is
 * correct regardless of how the mechanism turns out.
 *
 * All three sliders, table-driven. The eraser has no lossy arithmetic to fix
 * - it is native px, no conversion at either edge - but it is dragged by the
 * same finger through the same `hangUnder`, and a fourth slider gets a row
 * here whether or not anyone remembers why.
 */
describe("MobileTools: a refresh does not write into the slider under a finger", () => {
	beforeEach(() => resetPenToolsForTest());

	/** aria-label stays on the inputs; only buttons get it moved by ownName. */
	const findByAria = (el: FakeEl, aria: string): FakeEl | null => {
		if (el.getAttribute("aria-label") === aria) return el;
		for (const kid of el.children) {
			const hit = findByAria(kid, aria);
			if (hit) return hit;
		}
		return null;
	};
	/** The pop holding the named slider: pop > slot > input, and the pops
	 * hang off the strip inside the pane rather than off the pane itself. */
	const popFor = (el: FakeEl, aria: string): FakeEl => {
		for (const kid of el.children) {
			if (kid.classes.has("handwriting-slider-pop") && findByAria(kid, aria)) return kid;
			try {
				return popFor(kid, aria);
			} catch {
				// Not down this branch; keep looking.
			}
		}
		throw new Error(`no pop was built for ${aria}`);
	};

	interface Row {
		/** The slider's aria-label, which is how the pop is found. */
		aria: string;
		/** A px value this slider can actually hold; asserted against its own step. */
		dragTo: string;
		/** Moved under the drag by something that is not the finger. */
		away: number;
		/** What `hangUnder` writes for `away` once the finger has lifted. */
		awayShown: string;
	}
	const ROWS: Row[] = [
		// (20 - 3) / 1 = 17 steps up from the eraser's own min.
		{ aria: "Eraser size", dragTo: "20", away: 40, awayShown: "40" },
		// (3.36 - 0.66) / 0.1 = 27 steps up from the pen's min.
		{ aria: "Pen size", dragTo: "3.36", away: 1, awayShown: "2.2" },
		// (9 - 4) / 1 = 5 steps up from the highlighter's min.
		{ aria: "Highlighter size", dragTo: "9", away: 1, awayShown: "16" },
	];

	interface Rig {
		doc: FakeDoc;
		strip: MobileTools;
		pop: FakeEl;
		input: FakeEl;
		stored: () => number;
		moveUnderTheDrag: (to: number) => void;
		refreshes: () => number;
	}

	/** A strip with the named slider's pop open and a live store behind it. */
	const rigFor = (aria: string): Rig => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const nib = aria === "Highlighter size" ? "highlighter" : "pen";
		const sizes: Record<string, number> = { pen: 1, highlighter: 1 };
		const eraser = { on: false, radius: 10 };
		let refreshes = 0;
		const host = fakeHost({
			// refreshNow reads this first, so it counts the refreshes that
			// actually ran - a test that asserted "unchanged" after nothing
			// happened would be asserting nothing at all.
			recordingOn: () => {
				refreshes++;
				return false;
			},
			activeTool: () => nib,
			eraserOn: () => eraser.on,
			eraserRadiusPx: () => eraser.radius,
			setEraserRadiusPx: (px: number) => void (eraser.radius = px),
			inkSizeMult: (tool: string) => sizes[tool] ?? 1,
			setInkSizeMult: (tool: string, mult: number) => void (sizes[tool] = mult),
		});
		const strip = new MobileTools(pane as unknown as HTMLElement, host);
		const pop = popFor(pane, aria);
		const input = findByAria(pop, aria);
		if (!input) throw new Error(`no input for ${aria}`);
		if (aria === "Eraser size") {
			// The eraser pop rides the MODE, and opens on the off-to-on edge.
			eraser.on = true;
			strip.refreshNow();
		} else {
			// A nib pop opens from its button. The TOUCH tap is the route
			// used here: hover would open it just as well, but hover also
			// arms the tooltip, and that reaches for a real `window`, which
			// this suite deliberately does not have.
			const label = nib === "pen" ? "Pen" : "Highlighter";
			const btn = pane.findByTipLabel(label);
			if (!btn) throw new Error(`no ${label} button was built`);
			btn.fire("click", { pointerType: "touch" });
			doc.flushFrames();
		}
		const stored = (): number => (aria === "Eraser size" ? eraser.radius : sizes[nib]!);
		const moveUnderTheDrag = (to: number): void => {
			if (aria === "Eraser size") eraser.radius = to;
			else sizes[nib] = to;
		};
		return { doc, strip, pop, input, stored, moveUnderTheDrag, refreshes: () => refreshes };
	};

	/**
	 * THE defect Alan can see, and the one that tells the three sliders
	 * apart.
	 *
	 * The pop is a centered column whose width is its widest child - the
	 * value chip - and `hangUnder` re-centres it from its own measured
	 * `offsetWidth` on every refresh, with a `Math.max(0, right)` clamp that
	 * makes it grow leftward only once it reaches the strip's edge. So a
	 * chip that changes width slides the whole pop, and the slider inside
	 * it, sideways under the finger.
	 *
	 * The old formatter dropped trailing zeros, so the pen's label lost and
	 * regained a character at every whole number: counted off the real
	 * constructions, pen 12 width changes across its range, highlighter 1,
	 * eraser 1. That asymmetry is the whole reason Alan named the pen and
	 * not the other two, and no account based on the px<->mult rounding can
	 * produce it - that one is near-symmetric (53% of pen steps, 48% of
	 * highlighter steps) and would have had him reporting both.
	 *
	 * There is no layout in this suite, so this cannot measure a rendered
	 * pop. It asserts the property that MAKES the width constant instead:
	 * every label a slider can produce is the same run of digit-width
	 * glyphs. Fixed decimals keep the point from appearing and disappearing;
	 * U+2007 FIGURE SPACE is by definition a digit's width, which is exactly
	 * what the chip's `tabular-nums` has already equalised.
	 */
	describe("the value chip keeps one width across the whole range", () => {
		for (const row of ROWS) {
			it(`shows ${row.aria} at a single width, every step of the way`, () => {
				const rig = rigFor(row.aria);
				const val = rig.pop.children.find((k) =>
					k.classes.has("handwriting-slider-val")
				);
				if (!val) throw new Error(`no value chip for ${row.aria}`);

				const min = Number(rig.input.getAttribute("min"));
				const max = Number(rig.input.getAttribute("max"));
				const step = Number(rig.input.getAttribute("step"));
				// Preconditions: a real range, walked at its own grain.
				expect(max).toBeGreaterThan(min);
				expect(step).toBeGreaterThan(0);

				const labels: string[] = [];
				for (let v = min; v <= max + 1e-9; v = Math.round((v + step) * 1000) / 1000) {
					rig.input.value = String(v);
					rig.input.fire("input");
					labels.push(val.textContent);
				}
				// The walk has to have actually happened, and have crossed
				// the places the width used to change - a whole number for
				// the pen, and 9->10 for the other two.
				expect(labels.length).toBeGreaterThan(20);
				expect(labels.some((l) => l.includes("1"))).toBe(true);

				// The defect: more than one length here is a pop that
				// changes width, which is a pop that moves.
				const widths = new Set(labels.map((l) => l.length));
				expect([...widths]).toHaveLength(1);
				// And the same glyph SHAPE, not just the same count: a
				// digit, a figure space and a period are three different
				// widths, so "1px" padded to five characters would satisfy a
				// length check and still be narrower than "0.7px".
				const shapes = new Set(
					labels.map((l) => l.replace(/\d/g, "#").replace(/\u2007/g, "#"))
				);
				expect([...shapes]).toHaveLength(1);
			});
		}
	});

	for (const row of ROWS) {
		it(`leaves the ${row.aria} slider alone while it is held`, () => {
			const rig = rigFor(row.aria);

			// Preconditions. The pop has to be OPEN, or `hangUnder` returns
			// before it writes anything and every assertion below passes for
			// the wrong reason.
			expect(rig.pop.classes.has("is-showing")).toBe(true);
			// And the value being dragged to has to be one the slider can
			// actually hold - `min + k * step` off the input's own
			// attributes, not off a number copied into this file.
			const min = Number(rig.input.getAttribute("min"));
			const step = Number(rig.input.getAttribute("step"));
			const steps = (Number(row.dragTo) - min) / step;
			expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);

			// The finger takes hold and drags.
			const before = rig.stored();
			rig.input.fire("pointerdown");
			rig.input.value = row.dragTo;
			rig.input.fire("input");
			expect(rig.stored()).not.toBe(before);

			// The stored value moves under the drag. Any of the refresh
			// routes can do this, and the lossy px<->mult round trip does it
			// on the two nibs without anyone's help; this states it outright
			// so the test says what it means and holds for the eraser too.
			rig.moveUnderTheDrag(row.away);
			const ran = rig.refreshes();
			rig.strip.refreshNow();

			// A refresh really did run...
			expect(rig.refreshes()).toBeGreaterThan(ran);
			// ...and it did not touch the control under the finger.
			expect(rig.input.value).toBe(row.dragTo);

			// The other half: the guard releases. A slider that stayed held
			// would go deaf to every later refresh, which is a worse defect
			// than the one being fixed - so prove the pointer coming up puts
			// the write-back back.
			rig.doc.fire("pointerup");
			rig.strip.refreshNow();
			expect(rig.input.value).toBe(row.awayShown);
		});
	}
});

/**
 * The eraser's tap, both halves at once.
 *
 * §5p gave the eraser button a branch of its own so that a re-tap reopens
 * the size pop: pen contact closes every pop (`closeInkSliders`, driven by
 * StripPenChrome), and once it had, the only route back was to switch the
 * tool off and on again - two taps through the OFF-to-ON edge `refreshNow`
 * watches. The branch was written for pen and touch alike (`ptr !== "mouse"`)
 * and so it also swallowed the tap that used to put the eraser DOWN, on
 * every device that is not a mouse. Shipped in 1.4.6.
 *
 * Either half is satisfiable alone by a fix that loses the other - deleting
 * the branch restores the toggle and reinstates the two-tap trap - so both
 * are pinned here, and the state the pop is IN is what tells them apart.
 */
describe("MobileTools: tapping the eraser while it is already active", () => {
	beforeEach(() => resetPenToolsForTest());

	const descendants = (el: FakeEl): FakeEl[] =>
		el.children.flatMap((kid) => [kid, ...descendants(kid)]);

	/** The eraser's own pop, found by the slider it carries rather than by
	 * the order the strip happens to build its three pops in. */
	const eraserPop = (pane: FakeEl): FakeEl => {
		const hit = descendants(pane).find(
			(el) =>
				el.classes.has("handwriting-slider-pop") &&
				descendants(el).some((kid) => kid.getAttribute("aria-label") === "Eraser size")
		);
		if (!hit) throw new Error("no eraser pop was built");
		return hit;
	};

	/**
	 * `eraser` is a live box the host reads, and `exec` flips it the way the
	 * command does: `main.ts`'s eraser command is a plain toggle,
	 * `on = !getInlineEraserMode()`. So a test can tell "the branch ran" from
	 * "the command ran" by reading the box rather than by trusting the strip.
	 *
	 * The strip is built with the eraser OFF and `pickUp()` switches it on.
	 * That is now the only route to an open pop: a strip stopped reading its
	 * own mount as an OFF-to-ON edge (the describe above), so building one
	 * with the eraser already on leaves every pop shut. It is also the
	 * honest sequence - the pop is showing because the user just picked the
	 * eraser up, which is the moment before the tap under test.
	 */
	const buildStrip = (
		eraser: { value: boolean }
	): {
		doc: FakeDoc;
		execed: string[];
		tools: MobileTools;
		btn: FakeEl;
		pop: FakeEl;
		pickUp: () => void;
	} => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const execed: string[] = [];
		const host = fakeHost({
			eraserOn: () => eraser.value,
			exec: (id: string) => {
				execed.push(id);
				if (id === "handwriting:inline-tool-eraser") eraser.value = !eraser.value;
			},
		});
		const tools = new MobileTools(pane as unknown as HTMLElement, host);
		const btn = pane.findByTipLabel("Eraser");
		if (!btn) throw new Error("no Eraser button was built");
		const pickUp = (): void => {
			eraser.value = true;
			tools.refreshNow();
		};
		return { doc, execed, tools, btn, pop: eraserPop(pane), pickUp };
	};

	for (const ptr of ["touch", "pen"]) {
		it(`switches the eraser off on a ${ptr} tap while the pop is showing`, () => {
			// The eraser is picked up, which fires the OFF-to-ON edge and
			// hangs the pop out - the state a user is in the moment after
			// taking the tool, and the state they tap in to put it down.
			const eraser = { value: false };
			const { doc, execed, btn, pop, pickUp } = buildStrip(eraser);
			pickUp();
			expect(pop.classes.has("is-showing")).toBe(true);

			btn.fire("click", { pointerType: ptr });
			doc.flushFrames();

			expect(execed).toContain("handwriting:inline-tool-eraser");
			expect(eraser.value).toBe(false);
			expect(pop.classes.has("is-showing")).toBe(false);
		});
	}

	it("reopens the pop instead, in one tap, once pen contact has closed it", () => {
		const eraser = { value: false };
		const { doc, execed, tools, btn, pop, pickUp } = buildStrip(eraser);
		pickUp();
		expect(pop.classes.has("is-showing")).toBe(true);

		// Pen contact takes every pop down without touching the mode.
		tools.closeInkSliders();
		doc.flushFrames();
		expect(pop.classes.has("is-showing")).toBe(false);
		expect(eraser.value).toBe(true);

		btn.fire("click", { pointerType: "touch" });
		doc.flushFrames();

		// One tap, and the tool is still in hand: this is the half the §5p
		// branch exists for, and the half a bare deletion would lose.
		expect(execed).not.toContain("handwriting:inline-tool-eraser");
		expect(eraser.value).toBe(true);
		expect(pop.classes.has("is-showing")).toBe(true);
	});

	/**
	 * "mouse sould disable" (alan, 2026-09-02): a mouse only draws because
	 * its owner has no pen, so the eraser button IS the mode for them and
	 * the pop never gets in the way of putting it down.
	 *
	 * Both pop states are run, and the hidden one carries the weight: that
	 * is the exact state in which the pen tap above reopens the pop instead
	 * of switching the tool off, so it is the row that would catch a fix
	 * that reached the mouse. Neither row goes red when the fix is taken out
	 * - the mouse path is not what changed - which is the point of them.
	 */
	for (const showing of [true, false]) {
		it(`still switches the eraser off on a mouse click, pop ${
			showing ? "showing" : "hidden"
		}`, () => {
			const eraser = { value: false };
			const { doc, execed, tools, btn, pop, pickUp } = buildStrip(eraser);
			pickUp();
			if (!showing) {
				// Pen contact, the same way the reopen test gets there.
				tools.closeInkSliders();
				doc.flushFrames();
			}
			// Asserted, not assumed: a row that had silently lost its own
			// state would be the other row over again.
			expect(pop.classes.has("is-showing")).toBe(showing);
			expect(eraser.value).toBe(true);

			btn.fire("click", { pointerType: "mouse" });
			doc.flushFrames();

			expect(execed).toContain("handwriting:inline-tool-eraser");
			expect(eraser.value).toBe(false);
		});
	}
});

/**
 * The nib light follows mouse ink going OFF.
 *
 * alan, 2026-09-02: "left clicking with mouse on pen and highlighter gives
 * the toast that mouse ink is now enabled, but doesnt unhighlight the boxes,
 * they are still lit". His own earlier request - "can we make sure that the
 * pen button unhilights when we click it with mouse and moes ink turns off?"
 * - shipped in 1.4.6 and did not work in 1.4.6, 1.4.7 or 1.4.8, because
 * `nibIsLit` read `penSeenThisSession()`, which every tool command sets.
 *
 * The rig wires the fake host to what the real code actually does, which is
 * the only reason this test can see the defect at all:
 *   - `inline-tool-pen` calls markPenSeen() unconditionally (main.ts)
 *   - `mouse-ink-toggle` calls markPenSeen() whenever it turns ink ON,
 *     inside its own `if (on)` (main.ts)
 *   - the host's setMouseInk EXECS that command (InkOverlay.ts), which is
 *     where Alan's toast comes from - not from armMouseInkQuietly, which is
 *     genuinely silent and is on a branch he never reaches.
 */
describe("MobileTools: the nib light follows mouse ink going off", () => {
	beforeEach(() => resetPenToolsForTest());

	const rig = (): {
		doc: FakeDoc;
		btn: FakeEl;
		mouseInk: { value: boolean };
		toasts: string[];
	} => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const mouseInk = { value: false };
		const toasts: string[] = [];
		const exec = (id: string): void => {
			if (id === "handwriting:inline-tool-pen") {
				markPenSeen();
				toasts.push("Handwriting: pen");
			}
			if (id === "handwriting:mouse-ink-toggle") {
				const on = !mouseInk.value;
				mouseInk.value = on;
				if (on) markPenSeen();
				toasts.push(on ? "Handwriting: pen" : "Handwriting: cursor");
			}
		};
		const host = fakeHost({
			exec,
			activeTool: () => "pen",
			mouseInkOn: () => mouseInk.value,
			setMouseInk: (on: boolean) => {
				if (mouseInk.value !== on) exec("handwriting:mouse-ink-toggle");
			},
			armMouseInkQuietly: () => {
				mouseInk.value = true;
			},
		});
		new MobileTools(pane as unknown as HTMLElement, host);
		const btn = pane.findByTipLabel("Pen");
		if (!btn) throw new Error("no Pen button was built");
		return { doc, btn, mouseInk, toasts };
	};

	it("goes dark when a mouse click hands the tip back to text", () => {
		const { doc, btn, mouseInk, toasts } = rig();

		// Cold: no pen has ever been seen and mouse ink is off. Pen is the
		// nominal tool, so isActive is true - but nothing inks with it, so
		// the button is dark. Asserted rather than assumed: if this were
		// already lit the last assertion could pass for the wrong reason.
		expect(btn.classes.has("is-active")).toBe(false);

		// Click one: the mouse claims the pen, mouse ink comes on, the
		// button lights. This half worked before the fix and must keep
		// working after it.
		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();
		expect(mouseInk.value).toBe(true);
		expect(btn.classes.has("is-active")).toBe(true);

		// Click two: Alan's click. The mouse goes back to text.
		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();

		// The BEHAVIOUR was never broken - mouse ink really did go off, and
		// the toast really did say so. Pinned so a later fix to the light
		// cannot quietly change what the button does.
		expect(mouseInk.value).toBe(false);
		expect(toasts.at(-1)).toBe("Handwriting: cursor");

		// The LIGHT is the defect: "doesnt unhighlight the boxes".
		expect(btn.classes.has("is-active")).toBe(false);
	});

	/**
	 * The other half of the same rule, and the one a careless fix breaks: a
	 * real pen lights the nib with mouse ink off and keeps it lit. Deleting
	 * the `penHardwareSeen()` disjunct outright would pass the test above and
	 * fail this one, leaving every pen user with a permanently dark strip.
	 */
	it("stays lit for a real pen with mouse ink off", () => {
		markPenHardwareSeen();
		const { btn, mouseInk } = rig();
		expect(mouseInk.value).toBe(false);
		expect(btn.classes.has("is-active")).toBe(true);
	});
});

/**
 * The size slider previews what the tip can DO, not what it is nominally set to.
 *
 * alan, 2026-09-03: "plain mouse without mouse ink armed should not open the
 * slider popout, correct?" He is right, and it was broken. The hover branch
 * read `spec.isActive`, which means "the nominal tool" and deliberately
 * ignores mouse ink (see ButtonSpec.isLit for why the two predicates are split
 * at all), so a plain mouse with ink off hovered the Pen button and was handed
 * a size slider for a tool that could not lay down a stroke. The BUTTON was
 * already dark beside it - the light read `isLit` and the preview did not,
 * which is two controls on one button disagreeing about the same question.
 *
 * The hover gate now uses the render path's own resolution,
 * `spec.isLit ?? spec.isActive`, so buttons without their own `isLit` - all of
 * them but the two nibs - are untouched, and the eraser's separate §5p preview
 * branch keeps its own ruling.
 *
 * WHAT IS DELIBERATELY NOT CHANGED: the click path. Clicking an unlit nib is
 * the only way a mouse user arms mouse ink at all (the final else's
 * `armMouseInkQuietly`), and gating that would strand them with no way in. The
 * last test here is the one that goes red if anyone tidies the two into
 * agreement.
 *
 * The window shim is why this describe stands apart: the hover path arms the
 * tooltip through `window.setTimeout`, which the rest of this suite avoids by
 * opening pops with a touch tap instead. Here hover IS the subject, so the
 * timers are supplied and made flushable.
 */
describe("MobileTools: hover previews a nib that can ink, and no other", () => {
	let timers: Array<{ id: number; fn: () => void }> = [];
	let priorWindow: unknown;

	beforeEach(() => {
		resetPenToolsForTest();
		timers = [];
		let next = 1;
		priorWindow = (globalThis as Record<string, unknown>).window;
		(globalThis as Record<string, unknown>).window = {
			setTimeout: (fn: () => void): number => {
				const id = next++;
				timers.push({ id, fn });
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

	/** Run every pending timer, the tooltip's included - harmless on fakes. */
	const flushTimers = (): void => {
		const due = timers.splice(0, timers.length);
		for (const t of due) t.fn();
	};

	const rig = (
		over: Partial<MobileToolsHost> = {}
	): {
		doc: FakeDoc;
		strip: MobileTools;
		btn: FakeEl;
		mouseInk: { value: boolean };
		armed: string[];
	} => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const mouseInk = { value: false };
		const armed: string[] = [];
		const host = fakeHost({
			activeTool: () => "pen",
			mouseInkOn: () => mouseInk.value,
			armMouseInkQuietly: () => {
				armed.push("quiet");
				mouseInk.value = true;
			},
			...over,
		});
		const strip = new MobileTools(pane as unknown as HTMLElement, host);
		const btn = pane.findByTipLabel("Pen");
		if (!btn) throw new Error("no Pen button was built");
		return { doc, strip, btn, mouseInk, armed };
	};

	it("a plain mouse with ink off is offered nothing", () => {
		// Alan's case exactly. Pen is the nominal tool, so isActive is true
		// and the old gate opened the pop; nothing inks, so isLit is false and
		// the button is dark. Both are asserted, because a test that checked
		// only the pop could pass on a build where the button lit as well.
		const { doc, strip, btn } = rig();
		doc.flushFrames();
		expect(btn.classes.has("is-active")).toBe(false);
		btn.fire("pointerenter", { pointerType: "mouse" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe(null);
	});

	it("a mouse with ink armed still gets its preview", () => {
		const { doc, strip, btn, mouseInk } = rig();
		mouseInk.value = true;
		strip.refreshNow();
		expect(btn.classes.has("is-active")).toBe(true);
		btn.fire("pointerenter", { pointerType: "mouse" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
	});

	it("a real pen gets its preview with mouse ink off", () => {
		// The interaction with the pdf fix, and why it matters: once a surface
		// sets the hardware flag its pen user is lit and gets the preview. A
		// PDF-only pen user was dark before that fix, so tightening this gate
		// on its own would have taken their slider away too.
		markPenHardwareSeen();
		const { doc, strip, btn, mouseInk } = rig();
		expect(mouseInk.value).toBe(false);
		btn.fire("pointerenter", { pointerType: "mouse" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
	});

	it("a pen hovering the glass gets it too", () => {
		markPenHardwareSeen();
		const { doc, strip, btn } = rig();
		btn.fire("pointerenter", { pointerType: "pen" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
	});

	it("leaving a previewed nib still closes the pop on the timer", () => {
		// The close half. `scheduleSliderClose` only closes what hover opened,
		// so a gate that stops hover opening must not leave a pop behind that
		// nothing will now take away.
		markPenHardwareSeen();
		const { doc, strip, btn } = rig();
		btn.fire("pointerenter", { pointerType: "mouse" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
		btn.fire("pointerleave", { pointerType: "mouse" });
		flushTimers();
		doc.flushFrames();
		expect(strip.openNibSlider).toBe(null);
	});

	it("a tap-opened pop survives a hover that can no longer open one", () => {
		// The other side of the same worry. A touch tap opens the pop as a
		// DECISION (sliderFromHover false). A mouse then crosses the button
		// with ink off: the new gate skips the branch, so no
		// `cancelSliderClose` runs - and the leave timer still declines to
		// close a pop that hover did not open. Nothing leaks, and nothing the
		// user asked for is taken away.
		const { doc, strip, btn } = rig();
		btn.fire("click", { pointerType: "touch" });
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
		btn.fire("pointerenter", { pointerType: "mouse" });
		btn.fire("pointerleave", { pointerType: "mouse" });
		flushTimers();
		doc.flushFrames();
		expect(strip.openNibSlider).toBe("pen");
	});

	it("clicking an unlit nib still arms mouse ink", () => {
		// HOVER ONLY. This is the way in for a mouse user with no pen and it
		// runs through the click chain's `isActive` branches, which are
		// untouched. If a later change points the click path at `isLit` too,
		// this goes red and says why.
		const { doc, strip, btn, mouseInk, armed } = rig({
			// The tip is not the pen right now, so the click is a PICK rather
			// than a toggle - the final else, which is the branch that arms.
			activeTool: () => "highlighter",
		});
		expect(mouseInk.value).toBe(false);
		btn.fire("click", { pointerType: "mouse" });
		doc.flushFrames();
		expect(armed).toEqual(["quiet"]);
		expect(mouseInk.value).toBe(true);
		expect(strip.openNibSlider).toBe("pen");
	});
});

/**
 * Putting a tool DOWN with a mouse hands the pointer back to text.
 *
 * ALAN, 2026-09-03. The two nibs already did this - clicking the nib you are
 * drawing with calls `setMouseInk(false)` - but the other four tip tools only
 * toggled back to the last nib. For a MOUSE that is not putting anything down:
 * the pointer is still claimed and still cannot select text, so the only way
 * back to the cursor from the eraser was to click a button you were not using.
 * His words: "much more consistent for them all to be dropped and revert back
 * to mouse cursor", and the extra click that costs is "correct behavior.
 * sometimes you need the mouse cursor back".
 *
 * PEN AND TOUCH ARE DELIBERATELY UNCHANGED and are pinned here as such. A
 * pen's resting state IS the nib, so returning there is already its put-down;
 * there is no cursor for it to get back. He asked for the two to stay as they
 * are while he thinks the flow through, so a change reaching them is a
 * regression against a live instruction, not a bonus.
 *
 * A second regression rode in on this feature (alan, hardware finding
 * 2026-09-03: "toast is incorrect ... it says highlighter after doing it"):
 * `exec(spec.commandId)` is what actually reverts the mode, and that
 * command's own Notice is written for a pen or touch tap really picking the
 * nib the tip fell back to - true for THEM, false for a mouse put-down, which
 * picked nothing. `markMousePutDown` (MouseInk.ts) is how the strip tells
 * that command its toast is about to be wrong; `putDownFlagAtExec` below
 * reads `consumeMousePutDown()` from INSIDE the exec mock, at the exact point
 * the real command callback would read it, so these tests pin both that the
 * flag is set and that it is set in time - not merely that it is set
 * eventually.
 */
describe("MobileTools: a mouse putting a tip tool down gets its cursor back", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		// Drain any flag a previous test's exec never consumed, so no test
		// here can pass because an EARLIER test left it set.
		consumeMousePutDown();
	});

	const TOOLS = [
		{ label: "Eraser", id: "handwriting:inline-tool-eraser", key: "eraserOn" },
		{ label: "Lasso", id: "handwriting:inline-tool-lasso", key: "lassoOn" },
		{ label: "Insert space", id: "handwriting:inline-tool-space", key: "spaceOn" },
		{ label: "Pan", id: "handwriting:inline-tool-pan", key: "panOn" },
	] as const;

	const rig = (
		tool: (typeof TOOLS)[number],
		opts: { active: boolean; inkOn: boolean }
	): {
		btn: FakeEl;
		doc: FakeDoc;
		disarmed: number;
		armed: number;
		execed: string[];
		putDownFlagAtExec: boolean | null;
	} => {
		const doc = new FakeDoc();
		const pane = new FakeEl("div", doc);
		const state = { active: opts.active, ink: opts.inkOn };
		const counts = { disarmed: 0, armed: 0 };
		const execed: string[] = [];
		let putDownFlagAtExec: boolean | null = null;
		const host = fakeHost({
			[tool.key]: () => state.active,
			mouseInkOn: () => state.ink,
			exec: (id: string) => {
				execed.push(id);
				if (id === tool.id) {
					// Read-and-clear, exactly as the real command's
					// `tipModeOffNotice` (main.ts) would while building its
					// own Notice - this IS that read, moved into the test.
					putDownFlagAtExec = consumeMousePutDown();
					state.active = !state.active;
				}
			},
			armMouseInkQuietly: () => {
				counts.armed++;
				state.ink = true;
			},
			disarmMouseInkQuietly: () => {
				counts.disarmed++;
				state.ink = false;
			},
		} as Partial<MobileToolsHost>);
		new MobileTools(pane as unknown as HTMLElement, host);
		const btn = pane.findByTipLabel(tool.label);
		if (!btn) throw new Error(`no ${tool.label} button was built`);
		return {
			btn,
			doc,
			get disarmed() {
				return counts.disarmed;
			},
			get armed() {
				return counts.armed;
			},
			execed,
			get putDownFlagAtExec() {
				return putDownFlagAtExec;
			},
		};
	};

	for (const tool of TOOLS) {
		it(`${tool.label}: a mouse click while active hands the cursor back`, () => {
			const r = rig(tool, { active: true, inkOn: true });
			r.btn.fire("click", { pointerType: "mouse" });
			// The tool still comes off through its own command - the put-down
			// is the tool AND the pointer, not one instead of the other.
			expect(r.execed).toContain(tool.id);
			expect(r.disarmed).toBe(1);
		});

		it(`${tool.label}: a mouse put-down tells the command its toast is wrong, before the command runs`, () => {
			const r = rig(tool, { active: true, inkOn: true });
			r.btn.fire("click", { pointerType: "mouse" });
			// If this is null, exec never ran (a different bug); if it is
			// false, the flag was not set before exec, which is exactly the
			// state that leaves the OFF toast naming a nib nobody picked.
			expect(r.putDownFlagAtExec).toBe(true);
		});

		it(`${tool.label}: a mouse click while INACTIVE still arms, unchanged`, () => {
			const r = rig(tool, { active: false, inkOn: false });
			r.btn.fire("click", { pointerType: "mouse" });
			expect(r.armed).toBe(1);
			expect(r.disarmed).toBe(0);
			// Picking UP is not putting down: the exec's own toast IS right
			// for this edge (it names what was picked), so the flag must
			// stay clear.
			expect(r.putDownFlagAtExec).toBe(false);
		});

		for (const ptr of ["pen", "touch"] as const) {
			it(`${tool.label}: a ${ptr} click while active does NOT touch mouse ink`, () => {
				const r = rig(tool, { active: true, inkOn: true });
				r.btn.fire("click", { pointerType: ptr });
				expect(r.disarmed).toBe(0);
				expect(r.armed).toBe(0);
				// A pen or touch tap really did just pick the nib the tip
				// fell back to - the exec's toast is correct for them, so
				// the flag that overrides it must never be seen true here
				// (some tools' pen/touch tap does not even reach exec - the
				// eraser's own pop-reopen branch is one - so `null`, meaning
				// exec never ran on this id at all, is an equally clean pass).
				expect(r.putDownFlagAtExec).not.toBe(true);
				// And whether or not exec ran, nothing may be left armed for
				// the NEXT off-toggle to pick up by mistake.
				expect(consumeMousePutDown()).toBe(false);
			});
		}
	}
});
