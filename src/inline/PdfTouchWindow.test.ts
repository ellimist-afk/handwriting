/**
 * A FINGER PAN ON A PDF, LIFTED AND STARTED AGAIN AT ONCE, STILL PANS.
 *
 * THE SYMPTOM, on a Surface with a PDF open: the first one-finger pan moves the page; lift, pan
 * again straight away, and nothing moves, for a second or more and for as long as the touches keep
 * coming. The trace shows why: the first gesture is carried by the assist, its lift opens the native
 * window ("touch-action restored (touch-end)"), and every later down inside the window is "touch
 * passthrough (native window)" - handed to the browser, which on the PDF viewer does nothing with it.
 *
 * THE FIX. The PDF surface builds its router without the native window: the lift of a pan leaves the
 * guard armed, so every finger pan there is carried by the assist, as the first one already was. The
 * note surface keeps the window; the control below pins that.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { captureInlinePenTrace, clearInlinePenTrace, InlinePenRouter } from "./InlinePenRouter";
import { resetPenToolsForTest } from "./PenToolsMode";
import { fakeEl, installFakeWindow, penEvent, recorder } from "../../test/routerHarness";
import { surfaceCode } from "./surfaceFiles.testutil";

// The pdf surface's code across every file the ink-surface ledger lists for it (surfaceCode), so a split that
// moves the router construction into a part is still read. The glob literal stays here: Vite needs it per module.
const ALL_TS = import.meta.glob("/src/**/*.ts", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

let undoWindow: () => void;
const routers: InlinePenRouter[] = [];

beforeAll(() => {
	undoWindow = installFakeWindow();
	setDiagnosticsEnabled(true);
});

afterAll(() => {
	setDiagnosticsEnabled(false);
	undoWindow();
});

afterEach(() => {
	for (const r of routers.splice(0)) r.dispose();
	clearInlinePenTrace();
});

/**
 * A scroller in the middle of a page that can scroll both ways, so no lift lands against an end.
 * `surface` "pdf" builds the router the way PdfInkController does: guard value "pinch-zoom" and no
 * native window. "note" builds it with the defaults, the way the note surface's window is kept.
 */
function rig(surface: "pdf" | "note") {
	resetPenToolsForTest();
	const el: ReturnType<typeof fakeEl> & { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number; scrollTo(o: { left?: number; top?: number }): void } =
		Object.assign(fakeEl(), { scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0, scrollTo(o: { left?: number; top?: number }) { if (o.left !== undefined) el.scrollLeft = o.left; if (o.top !== undefined) el.scrollTop = o.top; } });
	Object.assign(el, { scrollWidth: 800, clientWidth: 800, scrollHeight: 1200, clientHeight: 600 });
	el.scrollTop = 300;
	const cb = { ...recorder().cb, fingerInk: () => false, penOff: () => false } as never;
	const router =
		surface === "pdf"
			? new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb, () => 1, "pinch-zoom", undefined, false)
			: new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, cb, () => 1);
	routers.push(router);

	function pointer(type: string, x: number, y: number, target?: object, pointerType = "touch"): void {
		const ev = penEvent(type, type === "pointerdown" ? 10 : 700, {
			pointerId: pointerType === "pen" ? 77 : 31, pointerType, x, y, isPrimary: true,
			pressure: pointerType === "pen" && type !== "pointerup" ? 0.5 : 0,
			buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
		});
		if (target) Object.assign(ev, { target });
		const handler = el.handlers.get(type);
		if (!handler) throw new Error(`missing handler ${type}`);
		handler(ev);
	}

	/** One finger down, dragged up the page in six 20 px steps, then lifted. */
	function pan(): void {
		pointer("pointerdown", 400, 300);
		for (let i = 1; i <= 6; i++) pointer("pointermove", 400, 300 - i * 20);
		pointer("pointerup", 400, 180);
	}

	function downNotes(): string[] {
		return captureInlinePenTrace({}).events.filter((r) => r.type === "pointerdown").map((r) => r.note);
	}

	function guardNotes(): string[] {
		return captureInlinePenTrace({}).events.filter((r) => r.type === "guard").map((r) => r.note);
	}

	return { el, router, pointer, pan, downNotes, guardNotes, panned: () => (router as unknown as { gesturePanned: boolean }).gesturePanned };
}

describe("a second finger pan on a PDF, straight after the first", () => {
	it("is carried by the assist, like the first", () => {
		const h = rig("pdf");
		h.pan();
		expect(h.el.scrollTop, "premise: the first pan moved the page").not.toBe(300);
		h.pointer("pointerdown", 400, 300);
		const notes = h.downNotes();
		expect(notes.length, "premise: both downs were traced").toBe(2);
		expect(notes[0], "premise: the first gesture went to the assist").toContain("assist will carry");
		expect(notes[1], "the second gesture went to the browser's native window").toContain("assist will carry");
	});

	it("the lift of a pan leaves the PDF scroller at its armed touch-action", () => {
		const h = rig("pdf");
		h.pan();
		expect(h.el.style.touchAction).toBe("pinch-zoom");
	});

	it("the PDF surface builds its router that way: guard value pinch-zoom, no native window", () => {
		const pdfSrc = surfaceCode("pdf", ALL_TS);
		expect(pdfSrc.split("new InlinePenRouter(").length - 1, "premise: exactly one router construction across the pdf surface's files").toBe(1);
		const at = pdfSrc.indexOf("new InlinePenRouter(");
		expect(at, "premise: the PDF surface builds a router").toBeGreaterThan(-1);
		const end = pdfSrc.indexOf("\n\t\t);", at);
		expect(end, "premise: the call's closing line was found").toBeGreaterThan(at);
		const args = pdfSrc.slice(at, end).replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim();
		expect(args.endsWith('"pinch-zoom", undefined, false'), args.slice(-60)).toBe(true);
	});

	it("CONTROL: on a note the second gesture still goes to the native window", () => {
		const h = rig("note");
		h.pan();
		expect(h.el.scrollTop, "premise: the first pan moved the page").not.toBe(300);
		h.pointer("pointerdown", 400, 300);
		const notes = h.downNotes();
		expect(notes.length, "premise: both downs were traced").toBe(2);
		expect(notes[1]).toContain("touch passthrough (native window)");
	});
});

describe("the native window's trace rows say what the browser was given", () => {
	const g = globalThis as Record<string, unknown>;
	let reads: unknown[] = [];

	beforeAll(() => {
		g.getComputedStyle = (node: unknown) => {
			reads.push(node);
			return { touchAction: (node as { computedTouchAction?: string }).computedTouchAction ?? "auto" };
		};
	});

	afterAll(() => {
		delete g.getComputedStyle;
	});

	afterEach(() => {
		reads = [];
	});

	it("the restore row carries the scroller's computed touch-action", () => {
		const h = rig("note");
		Object.assign(h.el, { computedTouchAction: "pan-x pan-y" });
		h.pan();
		const restored = h.guardNotes().filter((n) => n.startsWith("touch-action restored (touch-end)"));
		expect(restored.length, "premise: the pan's lift opened the window").toBe(1);
		expect(restored[0]).toContain("computed touch-action, scroller: pan-x pan-y");
	});

	it("a native touch down reads the touched element's computed touch-action, once", () => {
		const h = rig("note");
		h.pan();
		reads = [];
		const page = { computedTouchAction: "none" };
		h.pointer("pointerdown", 400, 300, page);
		expect(h.downNotes()[1]).toContain("touch passthrough (native window); computed touch-action, touched element: none");
		expect(reads, "one style read per native touch down, and it is the touched element's").toEqual([page]);
	});

	it("a touch lift inside the window gets its own row", () => {
		const h = rig("note");
		h.pan();
		h.pointer("pointerdown", 400, 300);
		h.pointer("pointerup", 400, 300);
		expect(h.guardNotes()).toContain("touch lift inside the native window (pointerup)");
	});

	it("CONTROL: a pen stroke reads no style at all", () => {
		const h = rig("note");
		reads = [];
		h.pointer("pointerdown", 300, 300, undefined, "pen");
		for (let i = 1; i <= 4; i++) h.pointer("pointermove", 300 + i * 10, 300, undefined, "pen");
		h.pointer("pointerup", 340, 300, undefined, "pen");
		expect(reads).toEqual([]);
	});

	it("CONTROL: with recording off no style is read", () => {
		setDiagnosticsEnabled(false);
		try {
			const h = rig("note");
			h.pan();
			h.pointer("pointerdown", 400, 300, { computedTouchAction: "none" });
			expect(reads).toEqual([]);
		} finally {
			setDiagnosticsEnabled(true);
		}
	});
});
