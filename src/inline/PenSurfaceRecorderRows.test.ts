/**
 * The bug recorder's rows for a pen button on a pen with no hover.
 *
 * The click in the air reads the button from hover rows, and a pen that sends none gives it nothing to read, so for
 * such a pen it is not known whether its button reaches the page at all. Three things it might send are written to
 * the trace while Bug report: record is on: every context menu on the writing surface (a note or a PDF: both run
 * this router), every key while the surface has focus, and every selection change inside it. Before, a context menu
 * left a row only when it was eaten, and a key or a selection change never did. Nothing is eaten or handled that was
 * not before.
 *
 * A typed letter must not ride in a bug report, so only a named key (F13, Unidentified, ArrowLeft) writes its key,
 * code and key code. A letter, a symbol, a space, an emoji, a dead key or a composing keystroke writes only which of
 * the two it was, and the modifier flags. Typed into a field (an input, a text area, a select, or anything editable,
 * which a note's editor is) it writes no row at all, so the report does not carry the count and timing of typed
 * text; a named key there still writes its row. In the PDF's password box, or any password input, no key writes a
 * row, not even Shift or Backspace.
 *
 * The same holds for selection changes: only a selection with extent writes a row (a pen drag that leaves one
 * behind), never a caret move, which typing makes once per character; while a password box has focus none writes a
 * row, the focus read from the surface's own window. No row carries the selected text.
 *
 * Recording off, each new listener returns at its first line and reads nothing.
 *
 * Driven through the router's real registered handlers on the harness's element fake; the selection change rides
 * on test/popoutWindow.ts, whose remove must name the capture its add named.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InlinePenRouter } from "./InlinePenRouter";
import { clearInlinePenTrace, formatInlinePenTrace } from "./InlinePenRouterTrace";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { resetPenToolsForTest } from "./PenToolsMode";
import { fakeEl, installFakeWindow, recorder } from "../../test/routerHarness";
import { makePopoutWindow, type PopoutWindow } from "../../test/popoutWindow";

let undoWindow: () => void = () => undefined;
beforeAll(() => {
	undoWindow = installFakeWindow();
});
afterAll(() => undoWindow());

type Scroller = ReturnType<typeof fakeEl> & { ownerDocument?: unknown };

const built: InlinePenRouter[] = [];
beforeEach(() => {
	resetPenToolsForTest();
	setDiagnosticsEnabled(false);
	clearInlinePenTrace();
});
afterEach(() => {
	for (const r of built.splice(0)) r.dispose();
	setDiagnosticsEnabled(false);
	clearInlinePenTrace();
	resetPenToolsForTest();
});

/** A router on a fresh scroller, in the window whose document is `doc` (the harness window when none). */
function surface(opts: { doc?: unknown; penOff?: boolean } = {}): { el: Scroller; router: InlinePenRouter } {
	const el = fakeEl() as Scroller;
	if (opts.doc !== undefined) el.ownerDocument = opts.doc;
	const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, {
		...recorder().cb,
		penOff: () => opts.penOff === true,
	});
	built.push(router);
	return { el, router };
}

function record(): void {
	setDiagnosticsEnabled(true);
	clearInlinePenTrace();
}

/** The trace lines of one row type, as a bug report prints them. */
function rows(type: string): string[] {
	const head = new RegExp(`ms {2}${type} +id=`);
	return formatInlinePenTrace()
		.split("\n")
		.filter((l) => head.test(l));
}

function handler(el: Scroller, type: string): (ev: Event) => void {
	const h = el.handlers.get(type);
	if (!h) throw new Error(`the router registered no ${type} on the scroller`);
	return h;
}

/** Fire one contextmenu at the scroller; how many times it was prevented. */
function menu(el: Scroller, pointerType: string): number {
	let prevented = 0;
	handler(el, "contextmenu")({
		type: "contextmenu",
		pointerType,
		pointerId: 3,
		buttons: 0,
		button: 2,
		clientX: 10,
		clientY: 20,
		preventDefault: () => void prevented++,
		stopPropagation: () => {},
	} as unknown as Event);
	return prevented;
}

interface Key {
	key: string;
	code: string;
	keyCode: number;
	isComposing?: boolean;
	ctrlKey?: boolean;
	/** Where the key lands; none is the surface itself, as before. */
	target?: unknown;
}

/** A key target, duck-typed the way the router reads one. `inDialog`: inside the PDF's password box. */
function target(tagName: string, more: { type?: string; editable?: boolean; inDialog?: boolean } = {}): unknown {
	return {
		tagName,
		type: more.type ?? "",
		isContentEditable: more.editable === true,
		closest: (sel: string) => (sel === ".pdf-password-dialog" && more.inDialog === true ? { className: "pdf-password-dialog" } : null),
	};
}

/** Fire one keydown at the scroller; how many times it was prevented or stopped. */
function press(el: Scroller, k: Key): number {
	let touched = 0;
	handler(el, "keydown")({
		type: "keydown",
		repeat: false,
		isComposing: false,
		altKey: false,
		shiftKey: false,
		metaKey: false,
		ctrlKey: false,
		...k,
		preventDefault: () => void touched++,
		stopPropagation: () => void touched++,
	} as unknown as Event);
	return touched;
}

interface Sel {
	anchorNode: unknown;
	focusNode: unknown;
	type: string;
	isCollapsed: boolean;
	rangeCount: number;
}

/** A window whose document answers getSelection with `sel()`, counting the calls. */
function windowWith(sel: () => Sel | null): PopoutWindow & { asked: () => number } {
	const w = makePopoutWindow();
	let asked = 0;
	Object.assign(w.document, {
		getSelection: () => {
			asked++;
			return sel();
		},
	});
	return Object.assign(w, { asked: () => asked });
}

const range = (anchorNode: unknown, focusNode: unknown = anchorNode): Sel => ({
	anchorNode,
	focusNode,
	type: "Range",
	isCollapsed: false,
	rangeCount: 1,
});

describe("a context menu on the writing surface leaves a row while recording", () => {
	it("nothing near, no pointer type: one row with its buttons and the router's state, and the menu still opens", () => {
		const { el } = surface();
		record();
		expect(menu(el, ""), "the menu was eaten").toBe(0);
		const got = rows("contextmenu");
		expect(got.length, "contextmenu rows").toBe(1);
		expect(got[0], "the row's buttons").toContain("buttons=0 button=2");
		expect(got[0], "the row's outcome").toContain("passed");
		expect(got[0], "the row's pen state").toContain("pen near no");
		expect(got[0], "the row's touch state").toContain("touches 0");
		expect(got[0], "a hover stamp never set").toContain("last pen hover never");
		expect(got[0], "a pen down never made").toContain("last pen down never");
	});

	it("recording off: no row, and the menu still opens", () => {
		const { el } = surface();
		expect(menu(el, ""), "the menu was eaten").toBe(0);
		expect(rows("contextmenu"), "a row with recording off").toEqual([]);
	});

	it("a pen near: eaten once as before, the old eaten row still written, and one row saying it was eaten", () => {
		const { el, router } = surface();
		record();
		router.gate.penHoverSeen(performance.now());
		expect(menu(el, ""), "the menu was not eaten once").toBe(1);
		const eaten = rows("suppressed");
		expect(eaten.length, "the old eaten row").toBe(1);
		expect(eaten[0]).toContain("contextmenu(scroller)");
		const got = rows("contextmenu");
		expect(got.length, "contextmenu rows").toBe(1);
		expect(got[0], "the row's outcome").toContain("suppressed");
		expect(got[0], "the row's pen state").toContain("pen near yes");
	});

	it("a pen with the pen off: a row saying the menu passed with the pen off, and the menu still opens", () => {
		const { el } = surface({ penOff: true });
		record();
		expect(menu(el, "pen"), "the menu was eaten").toBe(0);
		const got = rows("contextmenu");
		expect(got.length, "contextmenu rows").toBe(1);
		expect(got[0], "the row's outcome").toContain("pen off, passed");
	});

	it("recording on eats no menu that recording off lets open, and lets none open that it eats", () => {
		const outcome = (on: boolean) =>
			["", "mouse", "touch", "pen"].map((pt) => {
				const { el } = surface();
				if (on) record();
				return menu(el, pt);
			});
		const off = outcome(false);
		expect(off, "the menus as they were").toEqual([0, 0, 0, 1]);
		expect(outcome(true), "the menus while recording").toEqual(off);
	});
});

describe("a key while the writing surface has focus leaves a row while recording", () => {
	it("a named key writes its key, code and key code, and nothing is prevented or stopped", () => {
		const { el } = surface();
		record();
		const keys: Key[] = [
			{ key: "F13", code: "F13", keyCode: 124 },
			{ key: "Unidentified", code: "", keyCode: 0 },
			{ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
		];
		for (const k of keys) expect(press(el, k), `${k.key} was prevented or stopped`).toBe(0);
		const got = rows("keydown");
		expect(got.length, "keydown rows").toBe(3);
		expect(got[0]).toContain("key=F13 code=F13 keyCode=124");
		expect(got[1]).toContain("key=Unidentified code= keyCode=0");
		expect(got[2]).toContain("key=ArrowLeft code=ArrowLeft keyCode=37");
	});

	it("a typed character, an emoji, a dead key or a composing keystroke writes no key, code or key code", () => {
		const { el } = surface();
		record();
		const keys: [Key, string][] = [
			[{ key: "a", code: "KeyA", keyCode: 65 }, "printable"],
			[{ key: " ", code: "Space", keyCode: 32 }, "printable"],
			[{ key: "😀", code: "", keyCode: 0 }, "printable"],
			[{ key: "Dead", code: "KeyE", keyCode: 222 }, "printable"],
			[{ key: "Process", code: "KeyA", keyCode: 229 }, "composing"],
			[{ key: "a", code: "KeyA", keyCode: 65, isComposing: true }, "composing"],
			[{ key: "Unidentified", code: "KeyA", keyCode: 229 }, "composing"],
			[{ key: "c", code: "KeyC", keyCode: 67, ctrlKey: true }, "printable mods=ctrl"],
		];
		for (const [k] of keys) expect(press(el, k), `${k.key} was prevented or stopped`).toBe(0);
		const got = rows("keydown");
		expect(got.length, "keydown rows").toBe(keys.length);
		keys.forEach(([k, kind], i) => {
			const row = got[i] ?? "";
			expect(row, `${JSON.stringify(k)}: its kind`).toContain(kind);
			for (const leak of ["key=", "code=", "keyCode=", "KeyA", "KeyC", "KeyE", "Space", "😀"])
				expect(row.includes(leak), `${JSON.stringify(k)}: the row carries ${leak}`).toBe(false);
		});
	});

	it("recording off: no row", () => {
		const { el } = surface();
		press(el, { key: "F13", code: "F13", keyCode: 124 });
		expect(rows("keydown"), "a row with recording off").toEqual([]);
	});
});

/** Keys a typist sends: characters, a dead key, composing keystrokes, a shortcut. */
const TYPED: Key[] = [
	{ key: "a", code: "KeyA", keyCode: 65 },
	{ key: " ", code: "Space", keyCode: 32 },
	{ key: "Dead", code: "KeyE", keyCode: 222 },
	{ key: "Process", code: "KeyA", keyCode: 229 },
	{ key: "a", code: "KeyA", keyCode: 65, isComposing: true },
	{ key: "c", code: "KeyC", keyCode: 67, ctrlKey: true },
];

/** Named keys, the ones a pen's button might send and the ones a typist corrects with. */
const NAMED: Key[] = [
	{ key: "F13", code: "F13", keyCode: 124 },
	{ key: "Unidentified", code: "", keyCode: 0 },
	{ key: "Shift", code: "ShiftLeft", keyCode: 16 },
	{ key: "Backspace", code: "Backspace", keyCode: 8 },
	{ key: "CapsLock", code: "CapsLock", keyCode: 20 },
	{ key: "Enter", code: "Enter", keyCode: 13 },
];

describe("a key in a field writes no typed key, and a key in a password box writes no row", () => {
	it("in the PDF's password box, or any password input, no key writes a row: not Shift, not Backspace, not F13", () => {
		const { el } = surface();
		record();
		const places: [string, unknown][] = [
			["the password box's input", target("INPUT", { type: "password", inDialog: true })],
			["a text input inside the password box", target("INPUT", { type: "text", inDialog: true })],
			["the password box's own button", target("BUTTON", { inDialog: true })],
			["a password input elsewhere", target("INPUT", { type: "password" })],
		];
		for (const [where, t] of places) {
			for (const k of [...NAMED, ...TYPED]) expect(press(el, { ...k, target: t }), `${where}: ${k.key} was prevented or stopped`).toBe(0);
			expect.soft(rows("keydown"), `${where}: key rows`).toEqual([]);
			clearInlinePenTrace();
		}
	});

	it("typing in a text input, a text area, a select or a note writes no printable or composing row", () => {
		const { el } = surface();
		record();
		const places: [string, unknown][] = [
			["a text input", target("INPUT", { type: "text" })],
			["a text area", target("TEXTAREA")],
			["a select", target("SELECT")],
			["a note's editor", target("DIV", { editable: true })],
			["a line inside a note's editor", target("SPAN", { editable: true })],
		];
		for (const [where, t] of places) {
			for (const k of TYPED) expect(press(el, { ...k, target: t }), `${where}: ${k.key} was prevented or stopped`).toBe(0);
			expect.soft(rows("keydown"), `${where}: key rows`).toEqual([]);
			clearInlinePenTrace();
		}
	});

	it("a named key in a note or a field still writes its row: F13 and Unidentified included", () => {
		const { el } = surface();
		record();
		for (const t of [target("DIV", { editable: true }), target("INPUT", { type: "text" })]) {
			for (const k of NAMED) press(el, { ...k, target: t });
		}
		const got = rows("keydown");
		expect(got.length, "keydown rows").toBe(NAMED.length * 2);
		NAMED.forEach((k, i) => {
			for (const row of [got[i] ?? "", got[i + NAMED.length] ?? ""])
				expect.soft(row, `${k.key}: its row`).toContain(`key=${k.key} code=${k.code} keyCode=${k.keyCode}`);
		});
	});

	it("on the ink surface every key writes its row as before", () => {
		const { el } = surface();
		record();
		const places: [string, unknown][] = [
			["the scroller", el],
			["a page canvas", target("CANVAS")],
			["a page", target("DIV")],
		];
		const keys: [Key, string][] = [
			[{ key: "a", code: "KeyA", keyCode: 65 }, "printable mods=none"],
			[{ key: "Process", code: "KeyA", keyCode: 229 }, "composing mods=none"],
			[{ key: "F13", code: "F13", keyCode: 124 }, "key=F13 code=F13 keyCode=124"],
		];
		for (const [where, t] of places) {
			for (const [k] of keys) press(el, { ...k, target: t });
			const got = rows("keydown");
			expect.soft(got.length, `${where}: keydown rows`).toBe(keys.length);
			keys.forEach(([, kind], i) => expect.soft(got[i] ?? "", `${where}: row ${i}`).toContain(kind));
			clearInlinePenTrace();
		}
	});
});

describe("a selection change inside the writing surface leaves a row while recording", () => {
	it("anchor in the surface: one row with the selection's type, and no text", () => {
		let sel: Sel | null = null;
		const w = windowWith(() => sel);
		const { el } = surface({ doc: w.document });
		sel = range(el);
		record();
		w.dispatch("selectionchange");
		const got = rows("selectionchange");
		expect(got.length, "selectionchange rows").toBe(1);
		expect(got[0]).toContain("type=Range collapsed=false ranges=1");
	});

	it("focus in the surface, anchor elsewhere: one row", () => {
		let sel: Sel | null = null;
		const w = windowWith(() => sel);
		const { el } = surface({ doc: w.document });
		sel = range({}, el);
		record();
		w.dispatch("selectionchange");
		expect(rows("selectionchange").length, "selectionchange rows").toBe(1);
	});

	it("a selection elsewhere in the window: no row", () => {
		let sel: Sel | null = null;
		const w = windowWith(() => sel);
		surface({ doc: w.document });
		sel = range({}, {});
		record();
		w.dispatch("selectionchange");
		expect(rows("selectionchange"), "a row for a selection outside the surface").toEqual([]);
	});

	it("recording off: no row", () => {
		let sel: Sel | null = null;
		const w = windowWith(() => sel);
		const { el } = surface({ doc: w.document });
		sel = range(el);
		w.dispatch("selectionchange");
		expect(rows("selectionchange"), "a row with recording off").toEqual([]);
	});
});

/** A collapsed caret, which typing moves once per character. */
const caret = (node: unknown): Sel => ({ anchorNode: node, focusNode: node, type: "Caret", isCollapsed: true, rangeCount: 1 });

/** A window as above whose document says `focused()` has focus. */
function focusedWindow(sel: () => Sel | null, focused: () => unknown): ReturnType<typeof windowWith> {
	const w = windowWith(sel);
	Object.defineProperty(w.document, "activeElement", { configurable: true, get: focused });
	return w;
}

describe("typing writes no selection row: only a selection with extent does, and none while a password box has focus", () => {
	it("typing in a note's editor, a text input or a text area inside the surface: no row for any caret move", () => {
		let sel: Sel | null = null;
		let focused: unknown = null;
		const w = focusedWindow(() => sel, () => focused);
		const { el } = surface({ doc: w.document });
		const places: [string, unknown][] = [
			["a note's editor", target("DIV", { editable: true })],
			["a line inside a note's editor", target("SPAN", { editable: true })],
			["a text input", target("INPUT", { type: "text" })],
			["a text area", target("TEXTAREA")],
			["the scroller itself", el],
		];
		record();
		for (const [where, t] of places) {
			focused = t;
			for (let typed = 0; typed < 8; typed++) {
				sel = caret(el);
				w.dispatch("selectionchange");
			}
			expect.soft(rows("selectionchange"), `${where}: rows for eight typed characters`).toEqual([]);
			clearInlinePenTrace();
		}
	});

	it("a drag's selection, then typing over it in a note: the drag's one row, and none for the typing", () => {
		let sel: Sel | null = null;
		const w = focusedWindow(() => sel, () => target("DIV", { editable: true }));
		const { el } = surface({ doc: w.document });
		record();
		sel = range(el);
		w.dispatch("selectionchange");
		for (let typed = 0; typed < 5; typed++) {
			sel = caret(el);
			w.dispatch("selectionchange");
		}
		const got = rows("selectionchange");
		expect(got.length, "selectionchange rows").toBe(1);
		expect(got[0]).toContain("type=Range collapsed=false ranges=1");
	});

	it("in the PDF's password box, or any password input, no selection change writes a row: no caret move, no Shift+Arrow or select-all", () => {
		let sel: Sel | null = null;
		let focused: unknown = null;
		const w = focusedWindow(() => sel, () => focused);
		const { el } = surface({ doc: w.document });
		const places: [string, unknown][] = [
			["the password box's input", target("INPUT", { type: "password", inDialog: true })],
			["a text input inside the password box", target("INPUT", { type: "text", inDialog: true })],
			["the password box's own button", target("BUTTON", { inDialog: true })],
			["a password input elsewhere", target("INPUT", { type: "password" })],
		];
		record();
		for (const [where, t] of places) {
			focused = t;
			for (let typed = 0; typed < 4; typed++) {
				sel = caret(el);
				w.dispatch("selectionchange");
			}
			for (let step = 0; step < 3; step++) {
				sel = range(el);
				w.dispatch("selectionchange");
			}
			expect.soft(rows("selectionchange"), `${where}: selection rows`).toEqual([]);
			clearInlinePenTrace();
		}
	});

	it("a pen drag that leaves a selection behind still writes its row: focus in a note, a text field, the scroller, or nowhere", () => {
		let sel: Sel | null = null;
		let focused: unknown = null;
		const w = focusedWindow(() => sel, () => focused);
		const { el } = surface({ doc: w.document });
		const places: [string, unknown][] = [
			["a note's editor", target("DIV", { editable: true })],
			["a text input", target("INPUT", { type: "text" })],
			["the scroller", el],
			["nothing", null],
		];
		record();
		for (const [where, t] of places) {
			focused = t;
			sel = range(el);
			w.dispatch("selectionchange");
			const got = rows("selectionchange");
			expect.soft(got.length, `${where}: selectionchange rows`).toBe(1);
			expect.soft(got[0] ?? "", `${where}: the row`).toContain("type=Range collapsed=false ranges=1");
			clearInlinePenTrace();
		}
	});

	it("no row carries the selected text", () => {
		let sel: Sel | null = null;
		const w = focusedWindow(() => sel, () => target("DIV", { editable: true }));
		const { el } = surface({ doc: w.document });
		sel = Object.assign(range(el), { toString: () => "hunter2 the selected words" });
		record();
		w.dispatch("selectionchange");
		const got = rows("selectionchange");
		expect(got.length, "selectionchange rows").toBe(1);
		for (const leak of ["hunter2", "selected words"]) expect(got[0]?.includes(leak), `the row carries ${leak}`).toBe(false);
	});

	it("moved to another window with a password box focused there: no row, read from that window's document", () => {
		let sel: Sel | null = null;
		let focusedB: unknown = target("DIV", { editable: true });
		const A = focusedWindow(() => sel, () => target("DIV", { editable: true }));
		const B = focusedWindow(() => sel, () => focusedB);
		const { el, router } = surface({ doc: A.document });
		el.ownerDocument = B.document;
		router.followWindow();
		// A global document whose focus is a note: a read of it in place of the surface's own says "not a password box".
		const g = globalThis as { document?: unknown };
		const hadDocument = "document" in g;
		const was = g.document;
		g.document = { activeElement: target("DIV", { editable: true }) };
		try {
			record();
			sel = range(el);
			B.dispatch("selectionchange");
			expect(rows("selectionchange").length, "a note focused in the new window: the drag's row").toBe(1);
			clearInlinePenTrace();
			focusedB = target("INPUT", { type: "password", inDialog: true });
			B.dispatch("selectionchange");
			expect(rows("selectionchange"), "the password box focused in the new window: rows").toEqual([]);
		} finally {
			if (hadDocument) g.document = was;
			else delete g.document;
		}
	});

	it("a document that names no focused element still writes the pen drag's row", () => {
		let sel: Sel | null = null;
		const w = windowWith(() => sel);
		const { el } = surface({ doc: w.document });
		expect("activeElement" in w.document, "the fake document names a focused element").toBe(false);
		sel = range(el);
		record();
		w.dispatch("selectionchange");
		const got = rows("selectionchange");
		expect(got.length, "selectionchange rows").toBe(1);
		expect(got[0]).toContain("type=Range collapsed=false ranges=1");
	});
});

describe("the selection listener follows the surface to another window", () => {
	it("moved: on the new window only, its row comes from there; closed: on neither", () => {
		let sel: Sel | null = null;
		const A = windowWith(() => sel);
		const B = windowWith(() => sel);
		const { el, router } = surface({ doc: A.document });
		expect(A.listeners("selectionchange"), "built in the first window").toBe(1);
		el.ownerDocument = B.document;
		router.followWindow();
		expect(A.listeners("selectionchange"), "moved out: still on the first window").toBe(0);
		expect(B.listeners("selectionchange"), "moved out: the new window").toBe(1);
		sel = range(el);
		record();
		B.dispatch("selectionchange");
		expect(rows("selectionchange").length, "the row from the new window").toBe(1);
		expect(B.asked(), "the selection asked of the new window's document").toBe(1);
		expect(A.asked(), "the selection asked of the first window's document").toBe(0);
		built.splice(built.indexOf(router), 1);
		router.dispose();
		expect(B.listeners("selectionchange"), "closed: left on the new window").toBe(0);
		expect(A.listeners("selectionchange"), "closed: left on the first window").toBe(0);
	});
});

describe("recording off, the new listeners stop at their first line", () => {
	it("the key listener reads nothing of the event", () => {
		const { el } = surface();
		let reads = 0;
		const ev = new Proxy(
			{},
			{
				get: () => {
					reads++;
					return undefined;
				},
			}
		);
		handler(el, "keydown")(ev as Event);
		expect(reads, "reads of the key event").toBe(0);
		expect(rows("keydown")).toEqual([]);
	});

	it("the selection listener asks no selection", () => {
		let sel: Sel | null = null;
		const w = windowWith(() => sel);
		const { el } = surface({ doc: w.document });
		sel = range(el);
		w.dispatch("selectionchange");
		expect(w.asked(), "getSelection calls").toBe(0);
		expect(rows("selectionchange")).toEqual([]);
	});

	it("the context menu writes no row", () => {
		const { el } = surface();
		menu(el, "pen");
		menu(el, "");
		expect(rows("contextmenu")).toEqual([]);
		expect(rows("suppressed")).toEqual([]);
	});
});
