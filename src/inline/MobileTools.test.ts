import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MobileTools, nibIsLit, type MobileToolsHost } from "./MobileTools";
import { markPenSeen, resetPenToolsForTest } from "./PenToolsMode";

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
	recordingOn: () => false,
	hasInkSelection: () => false,
	palette: () => [],
	pickColor: () => {},
	...over,
});

describe("nibIsLit", () => {
	beforeEach(() => resetPenToolsForTest());

	it("is lit for a pen that has been seen this session, mouse ink off", () => {
		markPenSeen();
		expect(nibIsLit(fakeHost({ activeTool: () => "pen", mouseInkOn: () => false }), "pen")).toBe(true);
	});

	it("is dark for a mouse user with mouse ink off and no pen seen", () => {
		expect(nibIsLit(fakeHost({ activeTool: () => "pen", mouseInkOn: () => false }), "pen")).toBe(
			false
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
		markPenSeen();
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
 * one reader there is: `hangUnder` returns before measuring while a pop is
 * shut, and goes on to measure when one opens. It used to be true that no
 * test here ever opened one; the eraser-pop tests at the foot of this file do,
 * so the rects answer zeros rather than throwing. Nothing asserts on the
 * placement they produce - only on whether the pop is showing at all.
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
		markPenSeen();
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
		markPenSeen();
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
