/**
 * The fold-order control.
 *
 * THREE KINDS OF TEST, and the split is the point. The mapping between the
 * list and the setting is pure and is attacked with arrays. Where the fold
 * falls is pure and is attacked with numbers, through the real `overflowPlan`.
 * The drag is neither, so it is driven against a fake element tree - the same
 * idiom as `MobileTools.test.ts`, with one deliberate difference: that file's
 * `removeEventListener` is a no-op, and half of what this control owes on
 * teardown is listeners going away, which a no-op cannot witness. The fake
 * below removes what it is asked to remove, so "torn down" is a claim with
 * evidence rather than a claim.
 *
 * WHAT THE SUITE CANNOT SEE, stated so nobody reads a green run as more than
 * it is: there is no layout here - every element answers 0 to every dimension -
 * so the detected width is 0, the preview strip folds nothing, and none of
 * this says anything about how the control LOOKS. That half is Alan's screen.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Platform } from "obsidian";
import controlSrc from "./FoldOrderControl.ts?raw";
import css from "../../styles.css?raw";
import { codeOnly } from "../CodeOnly";
import {
	FoldOrderControl,
	detectStripWidth,
	foldOrderFromPriority,
	moreCaption,
	previewStripHost,
	priorityFromFoldOrder,
	rowFate,
} from "./FoldOrderControl";
import {
	DEFAULT_FOLD_ORDER,
	NEVER_FOLDING_FACES,
	normalizeFoldOrder,
	setStripFoldOrder,
	stripButtonFace,
} from "./MobileTools";
import { overflowPlan, type StripItem } from "./StripOverflow";
import { markPenHardwareSeen, resetPenToolsForTest } from "./PenToolsMode";

// ---------------------------------------------------------------- the fake

interface ElOpts {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

class FakeWin {
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	readonly frames: Array<() => void> = [];
	innerWidth = 0;
	requestAnimationFrame(cb: () => void): number {
		this.frames.push(cb);
		return this.frames.length;
	}
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}
	removeEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		const at = list.indexOf(fn);
		if (at >= 0) list.splice(at, 1);
		this.listeners.set(type, list);
	}
	count(type: string): number {
		return (this.listeners.get(type) ?? []).length;
	}
	fire(type: string, ev: Record<string, unknown> = {}): void {
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
	}
}

class FakeDoc {
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	readonly defaultView = new FakeWin();
	/**
	 * The document's own tree, when a test gives it one. Null means "nothing on
	 * screen", which is what every test that says nothing about the workspace
	 * runs in and what drives `detectStripWidth` to its window fallback.
	 */
	root: FakeEl | null = null;
	querySelector(sel: string): FakeEl | null {
		return this.root?.querySelectorAll(sel)[0] ?? null;
	}
	querySelectorAll(sel: string): FakeEl[] {
		return this.root?.querySelectorAll(sel) ?? [];
	}
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}
	removeEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		const at = list.indexOf(fn);
		if (at >= 0) list.splice(at, 1);
		this.listeners.set(type, list);
	}
	count(type: string): number {
		return (this.listeners.get(type) ?? []).length;
	}
	fire(type: string, ev: Record<string, unknown> = {}): void {
		const event = {
			preventDefault: (): void => {},
			stopPropagation: (): void => {},
			pointerType: "mouse",
			...ev,
		};
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
	}
}

class FakeEl {
	children: FakeEl[] = [];
	readonly classes = new Set<string>();
	readonly attrs = new Map<string, string>();
	readonly dataset: Record<string, string> = {};
	readonly style: Record<string, string> & { setProperty(k: string, v: string): void };
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	readonly captured: number[] = [];
	textContent = "";
	disabled = false;
	focused = false;
	hidden = false;
	/**
	 * The one thing the shared fake in MobileTools.test.ts cannot do: answer a
	 * width. Left at 0 - which is the state every test that says nothing about
	 * layout runs in, and the state the strip's own bail-out expects - but
	 * SETTABLE, so the folding tests can give the preview a real pane and real
	 * buttons and let `layoutOverflow` and `overflowPlan` do the actual work.
	 */
	offsetWidth = 0;
	readonly offsetLeft = 0;
	clientWidth = 0;
	parent: FakeEl | null = null;
	get parentElement(): FakeEl | null {
		return this.parent;
	}
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
		const bag: Record<string, string> = {};
		this.style = Object.assign(bag, {
			setProperty: (k: string, v: string): void => void (bag[k] = v),
		}) as Record<string, string> & { setProperty(k: string, v: string): void };
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
	createDiv(opts: ElOpts = {}): FakeEl {
		return this.createEl("div", opts);
	}
	createSpan(opts: ElOpts = {}): FakeEl {
		return this.createEl("span", opts);
	}
	get firstChild(): FakeEl | null {
		return this.children[0] ?? null;
	}
	appendChild(node: FakeEl): FakeEl {
		node.parent?.detach(node);
		node.parent = this;
		this.children.push(node);
		return node;
	}
	insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl {
		node.parent?.detach(node);
		node.parent = this;
		const at = ref ? this.children.indexOf(ref) : -1;
		if (at < 0) this.children.push(node);
		else this.children.splice(at, 0, node);
		return node;
	}
	private detach(node: FakeEl): void {
		const at = this.children.indexOf(node);
		if (at >= 0) this.children.splice(at, 1);
	}
	empty(): void {
		this.children = [];
		this.textContent = "";
	}
	remove(): void {
		this.parent?.detach(this);
		this.parent = null;
	}
	setText(t: string): void {
		this.children = [];
		this.textContent = t;
	}
	setCssStyles(styles: Record<string, string>): void {
		Object.assign(this.style, styles);
		// A width written on an element is a width it then HAS. The control
		// sizes the preview pane this way and the strip inside reads the pane's
		// clientWidth, so a fake that recorded the string and kept answering 0
		// would make the whole measured path untestable.
		const w = styles["width"];
		if (typeof w === "string" && w.endsWith("px")) {
			const n = Number.parseInt(w, 10);
			if (Number.isFinite(n)) {
				this.clientWidth = n;
				this.offsetWidth = n;
			}
		}
	}
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
	focus(): void {
		this.focused = true;
	}
	click(): void {
		this.fire("click");
	}
	setPointerCapture(id: number): void {
		this.captured.push(id);
	}
	releasePointerCapture(id: number): void {
		const at = this.captured.indexOf(id);
		if (at >= 0) this.captured.splice(at, 1);
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
	/** Comma-separated simple selectors: a tag, or one class. */
	querySelectorAll(sel: string): FakeEl[] {
		const parts = sel.split(",").map((s) => s.trim()).filter(Boolean);
		const hit = (el: FakeEl): boolean =>
			parts.some((p) => (p.startsWith(".") ? el.classes.has(p.slice(1)) : el.tag === p));
		const out: FakeEl[] = [];
		for (const kid of this.children) {
			if (hit(kid)) out.push(kid);
			out.push(...kid.querySelectorAll(sel));
		}
		return out;
	}
	/** The nearest ancestor matching, self included - `Element.closest`. */
	closest(sel: string): FakeEl | null {
		const want = sel.startsWith(".") ? sel.slice(1) : sel;
		let at: FakeEl | null = this;
		while (at) {
			if (sel.startsWith(".") ? at.classes.has(want) : at.tag === want) return at;
			at = at.parent;
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
	removeEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		const at = list.indexOf(fn);
		if (at >= 0) list.splice(at, 1);
		this.listeners.set(type, list);
	}
	fire(type: string, ev: Record<string, unknown> = {}): void {
		const event = {
			preventDefault: (): void => {},
			stopPropagation: (): void => {},
			pointerType: "mouse",
			target: this,
			currentTarget: this,
			...ev,
		};
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
		if (type === "pointerdown") this.parentElement?.fire(type, event);
	}
	/**
	 * Everything in this subtree a person could read or hear: text nodes, and
	 * the two attributes a screen reader speaks. Class names are deliberately
	 * NOT included - they are the strip's internal vocabulary.
	 */
	spokenText(): string {
		const out: string[] = [this.textContent];
		for (const key of ["aria-label", "title"]) {
			const v = this.attrs.get(key);
			if (v !== undefined) out.push(v);
		}
		for (const kid of this.children) out.push(kid.spokenText());
		return out.filter(Boolean).join("\n");
	}

	/** Every descendant carrying a class, in tree order. */
	all(cls: string): FakeEl[] {
		const out: FakeEl[] = [];
		for (const kid of this.children) {
			if (kid.classes.has(cls)) out.push(kid);
			out.push(...kid.all(cls));
		}
		return out;
	}
}

// ------------------------------------------------------------- the harness

const PREVIEW_READS = {
	toolColor: () => "#123456",
	paletteFor: () => [],
	recordingOn: () => false,
};

interface Harness {
	doc: FakeDoc;
	pane: FakeEl;
	control: FoldOrderControl;
	/** Every order handed to `applyStripFoldOrder`, in order. */
	applied: string[][];
	/** What the plugin would have saved, read back by the control. */
	saved(): readonly string[];
	rows(): FakeEl[];
	gripOf(index: number): FakeEl;
}

function build(): Harness {
	const doc = new FakeDoc();
	const pane = new FakeEl("div", doc);
	const applied: string[][] = [];
	let saved: string[] = normalizeFoldOrder([]);
	const control = new FoldOrderControl(pane as unknown as HTMLElement, {
		order: () => saved,
		// The plugin's own two lines: normalise into the setting, then push the
		// result at every strip on screen. Written out rather than stubbed, so
		// what this suite exercises is the round trip the control actually has.
		apply: (order) => {
			applied.push([...order]);
			saved = normalizeFoldOrder(order);
			setStripFoldOrder(saved);
		},
		corner: () => "top-right",
		previewHost: previewStripHost(PREVIEW_READS),
	});
	const rows = (): FakeEl[] => pane.all("handwriting-fold-row");
	const gripOf = (index: number): FakeEl => {
		const grip = rows()[index]?.querySelector(".handwriting-fold-grip");
		if (!grip) throw new Error(`no row at index ${index}`);
		return grip;
	};
	return { doc, pane, control, applied, saved: () => saved, rows, gripOf };
}

/** One whole drag, from a grip to a row `steps` places away. */
function drag(h: Harness, from: number, steps: number, opts: { escape?: boolean } = {}): void {
	const grip = h.gripOf(from);
	grip.fire("pointerdown", { button: 0, pointerId: 7, clientY: 0 });
	// 40px per row: 36 tall plus the 4px gap under it, the same step the
	// stylesheet lays the list out on.
	h.doc.fire("pointermove", { pointerId: 7, clientY: steps * 40 });
	if (opts.escape) h.doc.fire("keydown", { key: "Escape" });
	else h.doc.fire("pointerup", { pointerId: 7 });
}

const label = (id: string): string => stripButtonFace(id)?.label ?? id;

/**
 * A list of the rows this device shows, with the Keyboard id put back in the
 * slot the default order gives it: the id a mouse-only device has no row for,
 * which a drag must leave where it was saved (audit 120).
 */
function withKeyboardInPlace(list: readonly string[]): string[] {
	const keyboard = "handwriting:pen-ink-toggle";
	const out = [...list];
	out.splice(priorityFromFoldOrder(normalizeFoldOrder([])).indexOf(keyboard), 0, keyboard);
	return out;
}

// ------------------------------------------------------------- the mapping

describe("fold order: the list and the setting are the same array backwards", () => {
	it("reverses, in both directions", () => {
		expect(priorityFromFoldOrder(["a", "b", "c"])).toEqual(["c", "b", "a"]);
		expect(foldOrderFromPriority(["c", "b", "a"])).toEqual(["a", "b", "c"]);
	});

	it("round-trips a normalised order without moving it", () => {
		const order = normalizeFoldOrder([]);
		expect(foldOrderFromPriority(priorityFromFoldOrder(order))).toEqual(order);
		// And through the normaliser again, which is the trip a saved order
		// really makes: control -> applyStripFoldOrder -> disk -> control.
		expect(normalizeFoldOrder(foldOrderFromPriority(priorityFromFoldOrder(order)))).toEqual(order);
	});

	it("puts the FIRST button to fold at the BOTTOM of the list", () => {
		// The whole reason the pair is named rather than inlined. Reversing an
		// odd number of times leaves a list that reads correctly and folds from
		// the wrong end, which looks right until the pane is narrow.
		const order = normalizeFoldOrder([]);
		const list = priorityFromFoldOrder(order);
		expect(list[list.length - 1]).toBe(order[0]);
		expect(list[0]).toBe(order[order.length - 1]);
		expect(order[0]).toBe(DEFAULT_FOLD_ORDER[0]);
	});
});

// ---------------------------------------------------------- where it folds

/**
 * The real widths, off styles.css, the same way StripOverflow.test.ts takes
 * them: a mobile strip button is 40px and the row's gap is 2px, so a button
 * costs 42 including its gap; a divider is a 9px box with its hairline down
 * the middle, so 11. Using the real numbers is what lets these say something
 * about a phone.
 */
const BTN = 42;
const DIV = 11;
const CHEVRON = 42;
const FIXED = 42 + 3 * DIV;

const STRIP_TODAY: StripItem[] = [
	"handwriting:inline-tool-pen",
	"handwriting:inline-tool-highlighter",
	"handwriting:inline-tool-eraser",
	"handwriting:inline-tool-lasso",
	"handwriting:inline-tool-space",
	"handwriting:inline-tool-pan",
	"handwriting:pen-ink-toggle",
	"handwriting:delete-selected-ink",
	"handwriting:copy-selected-ink",
	"handwriting:paste-ink",
	"editor:undo",
	"editor:redo",
].map((id) => ({ id, width: BTN }));

const FULL = FIXED + STRIP_TODAY.length * BTN;

/** Where the dashed line goes: the number of rows that stay on the row. */
function keptAt(available: number): number {
	const order = normalizeFoldOrder([]);
	const plan = overflowPlan({
		available,
		fixed: FIXED,
		items: STRIP_TODAY,
		chevron: CHEVRON,
		demote: order,
	});
	return order.length - plan.moved.length;
}

describe("fold order: the fold line is the plan's own count", () => {
	it("keeps the whole list when the row fits", () => {
		expect(keptAt(FULL + 200)).toBe(normalizeFoldOrder([]).length);
	});

	it("folds three at a width that has room for three", () => {
		// 500px: the chevron comes out of the budget first (458 left), then
		// Redo, Pan and Keyboard leave in the default order, which lands at 453.
		expect(keptAt(500)).toBe(3);
	});

	it("the rows that fold are the TAIL of the list, which is what the line means", () => {
		// The fold line is drawn from a COUNT, so this is the invariant that
		// makes a count enough: `overflowPlan` demotes in fold order, and fold
		// order is this list read bottom-up, so the folded set is always the
		// bottom N rows and never a hole in the middle.
		const list = priorityFromFoldOrder(normalizeFoldOrder([]));
		const plan = overflowPlan({
			available: 500,
			fixed: FIXED,
			items: STRIP_TODAY,
			chevron: CHEVRON,
			demote: normalizeFoldOrder([]),
		});
		expect([...plan.moved].sort()).toEqual([...list.slice(keptAt(500))].sort());
	});
});

// ------------------------------------------------------------------ the DOM

describe("fold order: the control against a fake tree", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		setStripFoldOrder(DEFAULT_FOLD_ORDER);
	});

	it("lists only the movable buttons THIS device builds, top last to move", () => {
		// A mouse-only device, which is what `resetPenToolsForTest` leaves:
		// Keyboard is in the fold order on every device but is only BUILT once
		// a pen has been seen, and `overflowPlan` skips an id it cannot find
		// and keeps demoting. A list that showed it here would offer a row for
		// a button that is not on the toolbar AND put the line a row wrong.
		const h = build();
		const ids = h.rows().map((r) => r.dataset.commandId);
		const all = priorityFromFoldOrder(normalizeFoldOrder([]));
		expect(ids).toEqual(all.filter((id) => id !== "handwriting:pen-ink-toggle"));
		expect(ids).not.toContain("handwriting:pen-ink-toggle");
		expect(ids).toHaveLength(all.length - 1);
		h.control.destroy();
	});

	it("lists all six on a device that has held a pen", () => {
		// The other end of the same claim: the row is absent because the BUTTON
		// is absent, not because the list lost one.
		markPenHardwareSeen();
		const h = build();
		expect(h.rows().map((r) => r.dataset.commandId)).toEqual(
			priorityFromFoldOrder(normalizeFoldOrder([]))
		);
		h.control.destroy();
	});

	it("numbers the rows 1..N and names each one on the strip's own label", () => {
		const h = build();
		const rows = h.rows();
		expect(rows[0]?.querySelector(".handwriting-fold-index")?.textContent).toBe("1");
		expect(rows[rows.length - 1]?.querySelector(".handwriting-fold-index")?.textContent).toBe(
			String(rows.length)
		);
		const first = rows[0]?.dataset.commandId ?? "";
		expect(rows[0]?.querySelector(".handwriting-fold-name")?.textContent).toBe(label(first));
		h.control.destroy();
	});

	it("a drag from row 5 to row 2 saves the order that move implies", () => {
		const h = build();
		const before = h.rows().map((r) => r.dataset.commandId ?? "");
		const moved = before[4] ?? "";
		drag(h, 4, -3);
		const expectedList = [...before];
		expectedList.splice(4, 1);
		expectedList.splice(1, 0, moved);
		expect(h.applied).toHaveLength(1);
		// Written to the SETTING as a fold order - reversed - which is the one
		// direction this control could get backwards without anything looking
		// wrong until the pane narrowed.
		expect(h.applied[0]).toEqual(foldOrderFromPriority(withKeyboardInPlace(expectedList)));
		// And read back: the list now says what was saved, not what was asked.
		expect(h.rows().map((r) => r.dataset.commandId)).toEqual(expectedList);
		h.control.destroy();
	});

	it("Escape during a drag puts the row back and saves nothing", () => {
		const h = build();
		const before = h.rows().map((r) => r.dataset.commandId);
		drag(h, 4, -3, { escape: true });
		expect(h.applied).toEqual([]);
		expect(h.rows().map((r) => r.dataset.commandId)).toEqual(before);
		h.control.destroy();
	});

	it("a tap on the grip with no movement changes nothing", () => {
		// Not a nicety: a bare tap that wrote the setting would re-fold every
		// strip on screen and write data.json for a gesture that moved nothing.
		const h = build();
		const grip = h.gripOf(2);
		grip.fire("pointerdown", { button: 0, pointerId: 7, clientY: 0 });
		h.doc.fire("pointerup", { pointerId: 7 });
		expect(h.applied).toEqual([]);
		h.control.destroy();
	});

	it("a drag releases its pointer capture and leaves no transform behind", () => {
		const h = build();
		const grip = h.gripOf(4);
		drag(h, 4, -3);
		expect(grip.captured).toEqual([]);
		for (const row of h.rows()) expect(row.style.transform ?? "").toBe("");
		expect(h.rows().every((r) => !r.classes.has("is-dragging"))).toBe(true);
		h.control.destroy();
	});

	it("the keyboard moves a row one place and keeps the focus on its handle", () => {
		const h = build();
		const before = h.rows().map((r) => r.dataset.commandId ?? "");
		const moved = before[3] ?? "";
		h.gripOf(3).fire("keydown", { key: "ArrowUp" });
		const expectedList = [...before];
		expectedList.splice(3, 1);
		expectedList.splice(2, 0, moved);
		expect(h.applied[0]).toEqual(foldOrderFromPriority(withKeyboardInPlace(expectedList)));
		expect(h.rows()[2]?.querySelector(".handwriting-fold-grip")?.focused).toBe(true);
		h.control.destroy();
	});

	it("the keyboard refuses to walk off either end", () => {
		const h = build();
		h.gripOf(0).fire("keydown", { key: "ArrowUp" });
		h.gripOf(h.rows().length - 1).fire("keydown", { key: "ArrowDown" });
		expect(h.applied).toEqual([]);
		h.control.destroy();
	});

	it("Reset writes the default and hides itself again", () => {
		// Hidden, not disabled: a colour-only disabled state is invisible on
		// e-ink, so the button must be absent at the default order, not grey.
		const h = build();
		const reset = h.pane.all("handwriting-fold-reset")[0];
		expect(reset?.hidden).toBe(true);
		drag(h, 4, -3);
		expect(reset?.hidden).toBe(false);
		reset?.fire("click");
		expect(h.saved()).toEqual(normalizeFoldOrder([]));
		expect(reset?.hidden).toBe(true);
		h.control.destroy();
	});

	it("draws the six that never fold, with no grip among them", () => {
		const h = build();
		const fixed = h.pane.all("handwriting-fold-fixed-btn");
		expect(fixed).toHaveLength(6);
		// The only mark of "always shown" is that these six are not in the
		// list at all - no pin, no dimming, no handle. Counting grips against
		// ROWS is what carries that: a grip drawn for a fixed button would
		// have to be a seventh, and one missing from a row would be a sixth.
		expect(h.pane.all("handwriting-fold-grip")).toHaveLength(h.rows().length);
		const listed = h.rows().map((r) => r.dataset.commandId);
		for (const face of NEVER_FOLDING_FACES) expect(listed).not.toContain(face.commandId);
		h.control.destroy();
	});

	it("puts each row's position and fate on the handle, which is what takes focus", () => {
		const h = build();
		const first = h.rows()[0];
		expect(first?.querySelector(".handwriting-fold-grip")?.getAttribute("aria-label")).toBe(
			`Reorder ${label(first?.dataset.commandId ?? "")}, position 1 of ${h.rows().length}, ` +
				"stays on the first row. Drag, or press the up and down arrow keys."
		);
		h.control.destroy();
	});

	it("says they all fit when nothing is behind More", () => {
		// The suite has no layout, so the preview strip measures nothing and
		// moves nothing - which is the state a desktop is in, and the caption
		// for it is the one branch this can honestly check.
		const h = build();
		const cap = h.pane.all("handwriting-fold-cap")[0];
		expect(cap?.textContent).toBe("Drag to order. Everything fits on the screen.");
		expect(h.pane.all("handwriting-fold-list")[0]?.classes.has("is-nofold")).toBe(true);
		h.control.destroy();
	});

	it("draws the line even when everything fits, and keeps it in the list", () => {
		// Alan, on the fourth mock: "what happened to the purple line". The
		// line is the only mark of where the split is, so it exists at every
		// width - `is-nofold` moves it below the last row, it does not take it
		// away. The stylesheet half of that claim is pinned further down.
		const h = build();
		const list = h.pane.all("handwriting-fold-list")[0];
		expect(list?.classes.has("is-nofold")).toBe(true);
		expect(list?.querySelector(".handwriting-fold-line")).not.toBeNull();
		expect(list?.style["--handwriting-fold-keep"]).toBe(String(h.rows().length));
		h.control.destroy();
	});

	it("keeps the preview out of the keyboard's reach", () => {
		// The preview is a REAL strip of real buttons. `pointer-events: none`
		// stops a mouse and says nothing about Tab, and one of those buttons -
		// Collapse - reaches `setCollapsed`, whose first line writes the
		// session-wide `collapsedSession` that every strip in the window reads.
		// A settings tab must not be able to collapse the user's toolbar.
		const h = build();
		const pane = h.pane.all("handwriting-fold-preview-pane")[0];
		if (!pane) throw new Error("no preview pane");
		const buttons = pane.querySelectorAll("button");
		// Cannot fail open: there really are buttons in there to seal.
		expect(buttons.length).toBeGreaterThan(5);
		for (const btn of buttons) expect(btn.getAttribute("tabindex")).toBe("-1");
		expect(pane.getAttribute("aria-hidden")).toBe("true");
		h.control.destroy();
	});

	it("keeps them sealed after a re-fold has moved them between rows", () => {
		const h = build();
		const pane = h.pane.all("handwriting-fold-preview-pane")[0];
		if (!pane) throw new Error("no preview pane");
		for (const btn of pane.all("handwriting-mobile-tool")) btn.offsetWidth = 42;
		h.doc.defaultView.innerWidth = 476;
		h.doc.defaultView.fire("resize");
		for (const btn of pane.querySelectorAll("button")) {
			expect(btn.getAttribute("tabindex")).toBe("-1");
		}
		h.control.destroy();
	});

	it("gives back every listener it took when the tab closes", () => {
		const h = build();
		// The strip's five capturing document listeners, plus the window's
		// resize. A leaked control would be re-folded by every later
		// setStripFoldOrder on behalf of a settings pane that had closed.
		expect(h.doc.count("pointerdown") + h.doc.count("keydown")).toBeGreaterThan(0);
		expect(h.doc.defaultView.count("resize")).toBe(1);
		h.control.destroy();
		for (const type of ["pointerdown", "keydown", "pointerup", "pointercancel", "click"]) {
			expect(h.doc.count(type), `${type} left behind`).toBe(0);
		}
		expect(h.doc.defaultView.count("resize")).toBe(0);
	});

	it("drops its drag listeners the moment the drag ends", () => {
		// Against a BASELINE, not against zero: the preview strip is a real
		// MobileTools and keeps its own capturing pointerup on this document to
		// release a held slider. What is being measured is the drag's own pair,
		// which exists only between pointerdown and pointerup.
		const h = build();
		const base = h.doc.count("pointerup");
		h.gripOf(4).fire("pointerdown", { button: 0, pointerId: 7, clientY: 0 });
		expect(h.doc.count("pointermove")).toBe(1);
		expect(h.doc.count("pointerup")).toBe(base + 1);
		h.doc.fire("pointerup", { pointerId: 7 });
		expect(h.doc.count("pointermove")).toBe(0);
		expect(h.doc.count("pointerup")).toBe(base);
		h.control.destroy();
	});
});

// ------------------------------------------------- the fold, with real widths

describe("fold order: the line at a width that really folds", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		setStripFoldOrder(DEFAULT_FOLD_ORDER);
	});

	/**
	 * Give the preview a pane and buttons with the widths styles.css gives them
	 * on a phone - 40px plus the row's 2px gap - and let the real
	 * `layoutOverflow` and the real `overflowPlan` do the work.
	 *
	 * 476px of window: the strip's budget is 476 - 16 = 460, the chevron takes
	 * 44 of it, and Redo, Pan and Paste leave to get the rest under 416.
	 * Keyboard is NOT among them, because this device has never seen a pen and
	 * the button does not exist - which is the case the fold line was silently
	 * wrong in before the list started filtering.
	 */
	const foldAt = (h: Harness, innerWidth: number): void => {
		const pane = h.pane.all("handwriting-fold-preview-pane")[0];
		if (!pane) throw new Error("no preview pane");
		for (const btn of pane.all("handwriting-mobile-tool")) btn.offsetWidth = 42;
		h.doc.defaultView.innerWidth = innerWidth;
		h.doc.defaultView.fire("resize");
	};

	it("puts three behind More, and they are the bottom three of the list", () => {
		const h = build();
		foldAt(h, 476);
		const list = h.pane.all("handwriting-fold-list")[0];
		const ids = h.rows().map((r) => r.dataset.commandId ?? "");
		expect(ids).toHaveLength(5);
		// The line falls after two rows, and the three below it are the three
		// the strip actually moved - read off the strip, not recomputed here.
		expect(list?.style["--handwriting-fold-keep"]).toBe("2");
		expect(list?.classes.has("is-nofold")).toBe(false);
		const strip = (h.control as unknown as { strip: { foldedIds: string[] } }).strip;
		expect([...strip.foldedIds].sort()).toEqual([...ids.slice(2)].sort());
		h.control.destroy();
	});

	it("says so, and labels each row with the side it landed on", () => {
		const h = build();
		foldAt(h, 476);
		expect(h.pane.all("handwriting-fold-cap")[0]?.textContent).toBe(
			"Drag to order. Buttons below this line will collapse when window narrows."
		);
		const labels = h
			.rows()
			.map((r) => r.querySelector(".handwriting-fold-grip")?.getAttribute("aria-label") ?? "");
		expect(labels[0]).toContain("stays on the first row");
		expect(labels[1]).toContain("stays on the first row");
		expect(labels[2]).toContain("behind More on this screen");
		expect(labels[4]).toContain("behind More on this screen");
		h.control.destroy();
	});

	it("re-folds when a row is dragged, and announces where it landed", () => {
		const h = build();
		foldAt(h, 476);
		// Row 5 to the top: it was behind More, and now it is not.
		drag(h, 4, -4);
		const moved = h.rows()[0]?.dataset.commandId ?? "";
		const strip = (h.control as unknown as { strip: { foldedIds: string[] } }).strip;
		expect(strip.foldedIds).not.toContain(moved);
		expect(h.pane.all("handwriting-fold-live")[0]?.textContent).toContain(
			"moved to position 1 of 5. Stays on the first row."
		);
		h.control.destroy();
	});

	it("goes back to all-fit when the window opens up again", () => {
		const h = build();
		foldAt(h, 476);
		expect(h.pane.all("handwriting-fold-list")[0]?.classes.has("is-nofold")).toBe(false);
		foldAt(h, 1400);
		const list = h.pane.all("handwriting-fold-list")[0];
		expect(list?.classes.has("is-nofold")).toBe(true);
		expect(list?.style["--handwriting-fold-keep"]).toBe("5");
		expect(h.pane.all("handwriting-fold-cap")[0]?.textContent).toBe(
			"Drag to order. Everything fits on the screen."
		);
		h.control.destroy();
	});

	it("starts the second row open on first render when something is behind More", () => {
		const h = build();
		foldAt(h, 476);
		const strip = (h.control as unknown as { strip: { moreOpen: boolean } }).strip;
		expect(strip.moreOpen).toBe(true);
		h.control.destroy();
	});

	it("draws no open row - none behind More - at a width nothing folds at", () => {
		const h = build();
		foldAt(h, 1400);
		const strip = (h.control as unknown as { strip: { moreOpen: boolean } }).strip;
		expect(strip.moreOpen).toBe(false);
		h.control.destroy();
	});

	it("re-evaluates the open row on every re-fold, not just the first", () => {
		const h = build();
		const strip = (h.control as unknown as { strip: { moreOpen: boolean } }).strip;
		foldAt(h, 476);
		expect(strip.moreOpen).toBe(true);
		foldAt(h, 1400);
		expect(strip.moreOpen).toBe(false);
		h.control.destroy();
	});
});

// ------------------------------------------------------------- the wording

describe("fold order: nothing a user reads says fold, or narrow", () => {
	// "can we improve wording o the caption? nothing folds on this screen isnt
	// great... i dont even know what folding is as a noob" (alan, fifth mock).
	// The control names the button he can see - More - and never the mechanism
	// behind it. Internal names keep the strip's vocabulary; no user meets them.
	//
	// "narrow" went the same way on the seventh pass: a screen is SMALL, which
	// is the word people use about their own, and "narrow" is what a developer
	// calls a viewport.

	it("the caption says where the buttons are, in both branches", () => {
		expect(moreCaption(0)).toBe("Drag to order. Everything fits on the screen.");
		// Actual overflow selects the second caption; its wording is count-independent.
		expect(moreCaption(1)).toBe("Drag to order. Buttons below this line will collapse when window narrows.");
		expect(moreCaption(3)).toBe("Drag to order. Buttons below this line will collapse when window narrows.");
	});

	it("a row's fate is named by the button, not the mechanism", () => {
		expect(rowFate(true)).toBe("behind More on this screen");
		expect(rowFate(false)).toBe("stays on the first row");
	});

	it("no rendered text and no label in the whole control says it", () => {
		// The honest check, and the reason the source-scraping version of this
		// was thrown away: `folded.length` inside a template made a scan of the
		// SOURCE report the word while nothing on screen said it. This reads
		// what the control actually put in the tree.
		const h = build();
		const spoken = h.pane.spokenText();
		// Cannot fail open: the strings that should be there are.
		expect(spoken).toContain("Keep on the toolbar");
		expect(spoken).toContain("Always shown");
		expect(spoken).toContain("Drag to order. Everything fits on the screen.");
		// The section is named after the setting row it is drawn under, so a
		// screen reader announces the group by the name the user searched for.
		expect(spoken).toContain("Toolbar buttons");
		expect(spoken.toLowerCase()).not.toContain("fold");
		expect(spoken.toLowerCase()).not.toContain("narrow");
		h.control.destroy();
	});

	it("says neither of every row's handle either, at both fates", () => {
		for (const s of [rowFate(true), rowFate(false)]) {
			expect(s.toLowerCase()).not.toContain("fold");
			expect(s.toLowerCase()).not.toContain("narrow");
		}
	});
});

// --------------------------------------------------------- width detection

describe("detectStripWidth", () => {
	it("never measures the control's OWN bar, which wears the strip's class", () => {
		// The always-shown bar carries `.handwriting-mobile-tools` on purpose:
		// it is how the stylesheet paints it exactly as the toolbar is painted.
		// A scan that matched it would hand back the settings card's own width
		// and call it the note pane's - and it would do that precisely when no
		// real strip is up, which is when somebody is most likely to have this
		// control open (toolbar set to Hide, or auto before the first pen).
		const doc = new FakeDoc();
		const win = new FakeWin();
		win.innerWidth = 1024;
		const control = new FakeEl("div", doc, { cls: "handwriting-fold-order" });
		const row = control.createDiv({ cls: "handwriting-fold-fixed-row" });
		row.clientWidth = 568;
		row.createDiv({ cls: "handwriting-mobile-tools handwriting-fold-fixed-bar" });
		const pane = control.createDiv({ cls: "handwriting-fold-preview-pane" });
		pane.clientWidth = 380;
		pane.createDiv({ cls: "handwriting-mobile-tools" });
		doc.root = control;
		expect(detectStripWidth(doc as unknown as Document, win as unknown as Window)).toBe(1024);
	});

	it("measures a REAL strip's pane when there is one", () => {
		// The other end: the skip above must not have turned the first and best
		// branch off. Same tree, plus an editor's strip outside the control.
		const doc = new FakeDoc();
		const win = new FakeWin();
		win.innerWidth = 1024;
		const body = new FakeEl("div", doc);
		const control = body.createDiv({ cls: "handwriting-fold-order" });
		const row = control.createDiv({ cls: "handwriting-fold-fixed-row" });
		row.clientWidth = 568;
		row.createDiv({ cls: "handwriting-mobile-tools handwriting-fold-fixed-bar" });
		const editorPane = body.createDiv({ cls: "cm-host" });
		editorPane.clientWidth = 742;
		editorPane.createDiv({ cls: "handwriting-mobile-tools" });
		doc.root = body;
		expect(detectStripWidth(doc as unknown as Document, win as unknown as Window)).toBe(742);
	});

	it("falls back to the window when nothing in the tree can be measured", () => {
		const doc = new FakeDoc();
		const win = new FakeWin();
		win.innerWidth = 812;
		expect(detectStripWidth(doc as unknown as Document, win as unknown as Window)).toBe(812);
	});

	it("answers 0 rather than throwing when there is no window either", () => {
		expect(detectStripWidth(new FakeDoc() as unknown as Document, null)).toBe(0);
	});
});

// ------------------------------------------------------------ the source

describe("fold order: drag handles only", () => {
	const code = codeOnly(controlSrc);
	const count = (needle: string): number => code.split(needle).length - 1;

	it("builds exactly two buttons, and neither of them is an arrow", () => {
		// BOTH ENDS. The count proves the file really is being read and really
		// does build buttons; the absences prove which ones. Alan: "i
		// personally prefer drag handles, like most people.... i dont want
		// both" - so an arrow button appearing here, on hover or on touch or
		// as a fallback, is the ruling being undone.
		expect(count('createEl("button"')).toBe(2);
		expect(code).toContain('setIcon(grip, "grip-vertical")');
		expect(code).toContain('text: "Reset to default"');
		expect(code).not.toMatch(/"(arrow|chevron|move|triangle)-(up|down)"/);
		expect(code).not.toContain("Move up");
		expect(code).not.toContain("Move down");
	});

	it("has no width slider and no presets", () => {
		// "a toolbar width is insane lol. can we autodetect so it doesnt have
		// ugly presets?" - the width is measured, never offered.
		expect(code).not.toContain('type: "range"');
		expect(code).not.toContain("addSlider");
		expect(code).toContain("detectStripWidth(");
	});

	it("has no pin glyph", () => {
		// "get rid of the pin", on the third mock.
		expect(code).not.toContain('"pin"');
	});

	it("the line is always drawn, and labelled, in the stylesheet", () => {
		// The behaviour half is asserted against the DOM above; this is the
		// half that lives in CSS. `is-nofold` may only MOVE the line - a
		// display rule here would put the fourth mock's complaint straight back.
		const sheet = codeOnly(css);
		const rule = sheet.match(/\.handwriting-fold-list\.is-nofold[^{]*\{[^}]*\}/);
		expect(rule, "no is-nofold rule for the line").not.toBeNull();
		expect(rule?.[0]).toContain("top:");
		expect(rule?.[0]).not.toContain("display");
		expect(sheet).toContain('content: "More"');
	});

	it("writes the setting through applyStripFoldOrder and nowhere else", () => {
		// The control must not be a second store. It reads through `order()`
		// and writes through `apply()`, both injected, and touches neither
		// `stripFoldOrder` nor `setStripFoldOrder` itself.
		expect(code).not.toContain("stripFoldOrder =");
		expect(code).not.toContain("setStripFoldOrder(");
		expect(count("this.opts.apply(")).toBe(1);
	});

	it("the comment stripper is really running on this file", () => {
		// P3: every "does not contain" above would pass over an empty string,
		// and would also pass over raw text if a forbidden word only ever
		// appeared in prose. Blanking must remove characters and keep lines.
		expect(code).not.toEqual(controlSrc);
		expect(code).toHaveLength(controlSrc.length);
		expect(code.split("\n")).toHaveLength(controlSrc.split("\n").length);
	});
});

// ------------------------------------- the fold, with the hidden boxes hidden

/**
 * The same real widths as the block above, plus the one fact it leaves out: a
 * `display: none` element has NO BOX, and answers 0 to every dimension.
 *
 * THE DEFECT THIS BLOCK EXISTS FOR, in the owner's words (2026-09-05):
 * "draggong wrks fine, i narrowed the window and it didnt update the more
 * line". `layoutOverflow` reads two boxes that are display:none most of the
 * time - the More chevron, painted only under `is-more-needed`, and every
 * button already parked on the second row, painted only under `is-more-open`.
 * Read as they sit, the chevron costs nothing where it costs a button's width,
 * so a row that has just stopped fitting folds one button too few; and a
 * folded button costs nothing, so the very next pass hands it back to the row
 * it did not fit on. The strip settles on a later pass and looks right; the
 * fold line, drawn once from `foldedIds` the moment `applyFoldOrder` returns,
 * does not.
 *
 * THE MODEL, stated as a parameter rather than derived here: those two
 * stylesheet rules, and the DOM's own answer for a box that is not painted.
 * `test/render/FoldLineResize.test.ts` pins the same behaviour in a real
 * engine under the real `styles.css`, which is what stops this from being a
 * measurement of its own copy.
 */
describe("fold order: the line follows the window", () => {
	beforeEach(() => {
		resetPenToolsForTest();
		setStripFoldOrder(DEFAULT_FOLD_ORDER);
	});

	/** A phone's button: 40px of button and the row's 2px gap. */
	const BUTTON = 42;

	/** Install display-aware widths on the preview strip. Once per harness. */
	const measurable = (h: Harness): void => {
		const pane = h.pane.all("handwriting-fold-preview-pane")[0];
		if (!pane) throw new Error("no preview pane");
		const strip = pane.all("handwriting-mobile-tools")[0];
		if (!strip) throw new Error("no preview strip");
		const unpainted = (el: FakeEl): boolean => {
			if (el.classes.has("handwriting-tools-more")) {
				return !strip.classes.has("is-more-needed");
			}
			for (let up: FakeEl | null = el.parent; up; up = up.parent) {
				if (up.classes.has("handwriting-mobile-tools-more")) {
					return !strip.classes.has("is-more-open");
				}
			}
			return false;
		};
		for (const btn of pane.all("handwriting-mobile-tool")) {
			Object.defineProperty(btn, "offsetWidth", {
				configurable: true,
				get: () => (unpainted(btn) ? 0 : BUTTON),
			});
		}
	};

	const narrowTo = (h: Harness, innerWidth: number): void => {
		h.doc.defaultView.innerWidth = innerWidth;
		h.doc.defaultView.fire("resize");
	};

	const keep = (h: Harness): number =>
		Number(h.pane.all("handwriting-fold-list")[0]?.style["--handwriting-fold-keep"]);

	const behind = (h: Harness): string[] =>
		(h.control as unknown as { strip: { foldedIds: string[] } }).strip.foldedIds;

	it("moves the line when the window narrows past the width the row fits at", () => {
		const h = build();
		measurable(h);
		narrowTo(h, 1400);
		expect(keep(h)).toBe(5);
		expect(h.pane.all("handwriting-fold-cap")[0]?.textContent).toBe(
			"Drag to order. Everything fits on the screen."
		);
		// The reported symptom: at this width the strip really does fold, and
		// the line has to say so. The chevron is not on the row yet at the
		// moment this is measured, and measuring it as 0px wide is what used
		// to leave the line one button - and, one step later, the whole fold -
		// behind what the strip had actually done.
		narrowTo(h, 476);
		expect(keep(h)).toBe(2);
		expect(h.pane.all("handwriting-fold-cap")[0]?.textContent).toBe(
			"Drag to order. Buttons below this line will collapse when window narrows."
		);
		h.control.destroy();
	});

	it("never puts FEWER behind More as the window gets narrower", () => {
		const h = build();
		measurable(h);
		const counts: number[] = [];
		for (const w of [1400, 520, 500, 480, 476, 460, 440, 420]) {
			narrowTo(h, w);
			counts.push(behind(h).length);
		}
		// Monotone, which the old measurement was not: a button already behind
		// More measured 0, so it looked free and came back out on the next,
		// narrower pass.
		expect(counts).toEqual([...counts].sort((a, b) => a - b));
		h.control.destroy();
	});

	it("keeps the list and the strip saying the same thing at every width", () => {
		const h = build();
		measurable(h);
		for (const w of [1400, 520, 500, 480, 476, 460, 440, 420, 480, 1400]) {
			narrowTo(h, w);
			// The line splits the list in two and nothing falls between: what
			// stays plus what is behind More is the whole list.
			expect(keep(h) + behind(h).length, `at ${w}px`).toBe(h.rows().length);
		}
		h.control.destroy();
	});

	it("leaves the chevron and the second row exactly as it found them", () => {
		// The measurement shows both boxes to read them. A pass that forgot to
		// put them back would leave every strip in the window wearing an open
		// second row it was never asked for - and would make the next pass's
		// reading of `is-more-open` meaningless.
		const h = build();
		measurable(h);
		const pane = h.pane.all("handwriting-fold-preview-pane")[0];
		const strip = pane?.all("handwriting-mobile-tools")[0];
		narrowTo(h, 1400);
		expect(strip?.classes.has("is-more-needed")).toBe(false);
		expect(strip?.classes.has("is-more-open")).toBe(false);
		narrowTo(h, 476);
		expect(strip?.classes.has("is-more-needed")).toBe(true);
		h.control.destroy();
	});
});

describe("fold order: Keyboard on a phone and a hidden id keeps its place (audit 120)", () => {
	const KEYBOARD = "handwriting:pen-ink-toggle";
	beforeEach(() => {
		resetPenToolsForTest();
		setStripFoldOrder(DEFAULT_FOLD_ORDER);
	});
	afterEach(() => {
		Platform.isIosApp = false;
		Platform.isPhone = false;
	});

	it("an iPhone lists the Keyboard row, because its strip has the button", () => {
		Platform.isIosApp = true;
		Platform.isPhone = true;
		const h = build();
		expect(h.rows().map((r) => r.dataset.commandId)).toEqual(
			priorityFromFoldOrder(normalizeFoldOrder([]))
		);
		h.control.destroy();
	});

	it("a drag on a device with no Keyboard button leaves Keyboard where it was saved", () => {
		const h = build();
		expect(h.rows().map((r) => r.dataset.commandId)).not.toContain(KEYBOARD);
		const at = normalizeFoldOrder([]).indexOf(KEYBOARD);
		drag(h, 3, -2);
		expect(h.applied).toHaveLength(1);
		expect(h.applied[0]?.indexOf(KEYBOARD)).toBe(at);
		expect(h.saved().indexOf(KEYBOARD)).toBe(at);
		h.control.destroy();
	});

	it("Reset still writes the default order", () => {
		const h = build();
		drag(h, 3, -2);
		const reset = h.pane.all("handwriting-fold-reset")[0] ?? h.pane.querySelector(".handwriting-fold-reset");
		expect(reset).toBeTruthy();
		reset?.fire("click");
		expect(h.saved()).toEqual(normalizeFoldOrder([]));
		h.control.destroy();
	});
});
