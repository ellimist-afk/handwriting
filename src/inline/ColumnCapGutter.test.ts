/**
 * A capped text column (Infinite Canvas off, the pane has room for the width the note's ink was drawn at) whose
 * line-number gutter changes while it is capped: one more digit at line 100, or line numbers turned on.
 *
 * The layout is modelled on Obsidian 1.15.0's editor (obsidian-1.15.0.asar, read-only) and this plugin's styles.css:
 * .cm-scroller > .cm-sizer > .cm-contentContainer > [.cm-gutters, .cm-content], side by side. The gutter keeps its own
 * width and the content gets the container's width less the gutter's, up to its max-width. Readable line length on: the
 * sizer is held at --file-line-width, or at --handwriting-note-column-cap-sizer while capped, and the content at the
 * readable width, or at the held width while capped. Readable line length off: the sizer is the pane's full width and
 * only the content is held, so a wider gutter takes room from the slack beside it.
 *
 * Cells drive the real applyColumnHold and watchColumnFit on a bare overlay with a fake ResizeObserver that reports what
 * changed size, as the browser does, until nothing does. The render suite holds the same cases on the real CSS
 * (test/render/ColumnCapGutter.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { InkOverlayPlugin, inlineInk } from "./InkOverlay";

const HELD = 700;
const FILE_LINE_WIDTH = 760;
const CAPPED = "handwriting-note-column-capped";
const HOLD_VAR = "--handwriting-note-column-hold";
const CAP_SIZER_VAR = "--handwriting-note-column-cap-sizer";

type Entry = { target: unknown; contentRect: { width: number }; borderBoxSize?: Array<{ inlineSize: number }> };

class FakeElement {}

function rig(o: { readable: boolean; gutter: number; room?: number }) {
	(globalThis as unknown as { HTMLElement: unknown }).HTMLElement ??= FakeElement;
	const El = (globalThis as unknown as { HTMLElement: new () => object }).HTMLElement;
	const room = o.room ?? 1200;
	const vars = new Map<string, string>();
	const classes = new Set<string>();
	const pane = {
		classList: {
			remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
			toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
			contains: (c: string) => classes.has(c),
		},
		style: { setProperty: (k: string, v: string) => vars.set(k, v), removeProperty: (k: string) => vars.delete(k) },
	};
	let gutter = o.gutter;
	const px = (k: string): number | null => (vars.has(k) ? Number.parseFloat(vars.get(k)!) : null);
	const sizerWidth = (): number => {
		if (!o.readable) return room;
		const cap = classes.has(CAPPED) ? px(CAP_SIZER_VAR) ?? px(HOLD_VAR) : null;
		return Math.min(room, cap ?? FILE_LINE_WIDTH);
	};
	const contentWidth = (): number => {
		const max = classes.has(CAPPED) ? px(HOLD_VAR)! : o.readable ? FILE_LINE_WIDTH : Number.POSITIVE_INFINITY;
		return Math.min(sizerWidth() - gutter, max);
	};
	const sizer = Object.assign(new El(), { offsetWidth: 0 });
	Object.defineProperty(sizer, "offsetWidth", { get: sizerWidth });
	const content = {
		get offsetWidth() { return contentWidth(); },
		closest: (sel: string) => (sel === ".cm-sizer" ? sizer : null),
	};
	const scroller = { clientWidth: room };
	// A browser observer reports a box once after observe() and then whenever it changes size; an unobserved box is not
	// reported. `last` is the size last reported per box, -1 for one not reported since it was observed.
	const last = new Map<unknown, number>();
	let observer: { cb: (e: Entry[]) => void } | null = null;
	let unobserves = 0;
	class RO {
		cb: (e: Entry[]) => void;
		constructor(cb: (e: Entry[]) => void) { this.cb = cb; observer = this; }
		observe(t: unknown): void { last.set(t, -1); }
		unobserve(t: unknown): void { last.delete(t); unobserves++; }
		disconnect(): void { last.clear(); }
	}
	const win = { ResizeObserver: RO, getComputedStyle: () => ({ paddingLeft: "0", paddingRight: "0" }) };
	const ov = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(ov as object, {
		view: {
			dom: { parentElement: pane, ownerDocument: { defaultView: win } },
			scrollDOM: scroller,
			contentDOM: content,
			viewState: { mustMeasureContent: false },
			requestMeasure: () => {},
		},
		filePath: () => "gutter.md",
		canvasMode: false,
		requestLineSignature: () => {},
		viewportLayout: null,
	});
	let rounds = 0;
	const settle = (): void => {
		for (let i = 0; i < 8; i++) {
			const entries: Entry[] = [];
			for (const [t, w] of [[scroller, room], [sizer, sizerWidth()], [content, contentWidth()]] as const) {
				if (!last.has(t) || last.get(t) === w) continue;
				last.set(t, w);
				entries.push(t === scroller ? { target: t, contentRect: { width: w } } : { target: t, contentRect: { width: w }, borderBoxSize: [{ inlineSize: w }] });
			}
			if (entries.length === 0) return;
			rounds++;
			observer!.cb(entries);
		}
		throw new Error("the layout did not come to rest in 8 observer rounds");
	};
	return {
		start: () => {
			ov.applyColumnHold();
			settle();
		},
		gutterTo: (to: number) => { gutter = to; rounds = 0; settle(); return rounds; },
		text: () => contentWidth(),
		capped: () => ov.columnCapped === true,
		watched: () => ({ sizer: last.has(sizer), content: last.has(content), unobserves }),
		written: () => ({ classes: [...classes].sort(), vars: Object.fromEntries([...vars].sort()) }),
	};
}

describe("a capped column whose line-number gutter changes while it is capped", () => {
	afterEach(() => vi.restoreAllMocks());

	it("readable line length on: the gutter gains a digit (line 99 to line 100) and the text goes back to the held width", () => {
		vi.spyOn(inlineInk, "columnRefPx").mockReturnValue(HELD);
		const r = rig({ readable: true, gutter: 30 });
		r.start();
		expect(r.capped(), "capped at the start").toBe(true);
		expect(r.text(), "text column at the start").toBe(HELD);
		r.gutterTo(38);
		expect(r.capped(), "still capped").toBe(true);
		expect(r.text(), "text column after the gutter widened").toBe(HELD);
		expect(r.written().vars[CAP_SIZER_VAR], "the sizer takes the wider gutter").toBe(`${HELD + 38}px`);
	});

	it("readable line length on: line numbers turned on while capped and the text stays at the held width", () => {
		vi.spyOn(inlineInk, "columnRefPx").mockReturnValue(HELD);
		const r = rig({ readable: true, gutter: 0 });
		r.start();
		expect(r.capped(), "capped at the start").toBe(true);
		expect(r.text(), "text column at the start").toBe(HELD);
		r.gutterTo(30);
		expect(r.capped(), "still capped").toBe(true);
		expect(r.text(), "text column after line numbers came on").toBe(HELD);
		expect(r.written().vars[CAP_SIZER_VAR], "the sizer takes the gutter").toBe(`${HELD + 30}px`);
	});

	it("readable line length on: a gutter that widens past the pane's room gives the pane its own layout back", () => {
		vi.spyOn(inlineInk, "columnRefPx").mockReturnValue(HELD);
		// Room for the column beside a 30 px gutter (735 - 30 >= 700), not beside a 38 px one.
		const r = rig({ readable: true, gutter: 30, room: 735 });
		r.start();
		expect(r.capped(), "capped at the start").toBe(true);
		expect(r.text(), "text column at the start").toBe(HELD);
		r.gutterTo(38);
		expect(r.capped(), "no longer capped").toBe(false);
		expect(r.written(), "nothing written: the pane's own layout").toEqual({ classes: [], vars: {} });
		expect(r.text(), "the text wraps to the pane as it always did").toBe(735 - 38);
	});

	for (const c of [{ from: 30, to: 38, what: "the gutter gains a digit" }, { from: 0, to: 30, what: "line numbers turned on" }])
		it(`readable line length off: ${c.what} while capped and nothing changes`, () => {
			vi.spyOn(inlineInk, "columnRefPx").mockReturnValue(HELD);
			const r = rig({ readable: false, gutter: c.from });
			r.start();
			expect(r.capped(), "capped at the start").toBe(true);
			expect(r.text(), "text column at the start").toBe(HELD);
			const before = r.written();
			r.gutterTo(c.to);
			expect(r.capped(), "still capped").toBe(true);
			expect(r.text(), "text column after the gutter changed").toBe(HELD);
			expect(r.written(), "the classes and widths written are the same as before").toEqual(before);
		});
});
