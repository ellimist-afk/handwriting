import { describe, it, expect, beforeEach } from "vitest";
import { MobileTools, nibIsLit, type MobileToolsHost } from "./MobileTools";
import { markPenSeen, resetPenToolsForTest } from "./PenToolsMode";

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
 * read. Measurement (getBoundingClientRect, offsetWidth) is never reached -
 * the only reader is `hangUnder`, which returns before measuring while every
 * pop is shut, which is the state these tests run in.
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
