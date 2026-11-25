/**
 * A PDF paste goes by where the ink was copied from, not where it was first drawn.
 *
 * PDF ink keeps its page through a note: the clipboard's copy keeps it, the note paste stores it, the note's file
 * saves it and reads it back, and the note copy takes it again. Copied back out of the note it is note ink, in the
 * note's coordinates, so a PDF paste says "that ink was copied from a note - paste it on a note." and adds nothing.
 * Only a clipboard filled from a PDF pastes on a PDF.
 *
 * Real code: copySelection and pasteFromClipboard on a mounted PdfInkController, pasteInkHere and copySelectedInk on a
 * note overlay with its host chrome replaced (both built as PdfCtrlVPaste.test.ts builds them). The PDF's store is a
 * list the controller's ops are applied to; an op that reaches it is what a save would write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../inline/MobileTools", () => {
	class MobileTools {
		setCorner(): void {}
		refresh(): void {}
		setInking(): void {}
		closeInkSliders(): void {}
		stale(): boolean {
			return false;
		}
		destroy(): void {}
	}
	return { MobileTools };
});
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => null }));

import { PdfInkController } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import type { InkOp } from "../inline/InkHistory";
import { clearInkClipboard } from "../inline/InkClipboard";
import { InkOverlayPlugin, inlineInk } from "../inline/InkOverlay";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const NOTE_INK = "Handwriting: that ink was copied from a note - paste it on a note.";

function pdfStroke(id: string, x: number, page = 2): InkStroke {
	const points = [0, 5, 10].map((v) => ({ x: x + v, y: 30 + v, pressure: 0.5, t: v }));
	return { id, points, bbox: computeBBox(points, 2), tool: "pen", color: "#112233", width: 2, createdAt: 0, page };
}

/** A stroke drawn in a note: no page. */
function noteStroke(id: string, x: number): InkStroke {
	const s = pdfStroke(id, x);
	delete s.page;
	return s;
}

/** Minimal element: attributes, a parent chain, and a record of its listeners. */
class N {
	attrs = new Map<string, string>();
	parentElement: N | null = null;
	children: N[] = [];
	listeners: { type: string; fn: (ev: Event) => void }[] = [];
	isContentEditable = false;
	constructor(readonly tagName: string, readonly cls: string) {}
	add(child: N): N {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}
	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}
	hasAttribute(k: string): boolean {
		return this.attrs.has(k);
	}
	getAttribute(k: string): string | null {
		return this.attrs.get(k) ?? null;
	}
	removeAttribute(k: string): void {
		this.attrs.delete(k);
	}
	addEventListener(type: string, fn: (ev: Event) => void): void {
		this.listeners.push({ type, fn });
	}
	removeEventListener(type: string, fn: (ev: Event) => void): void {
		this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn));
	}
	querySelector(): null {
		return null;
	}
	contains(n: unknown): boolean {
		if (n === this) return true;
		return this.children.some((c) => c.contains(n));
	}
	closest(): null {
		return null;
	}
}

type Pdf = { controller: PdfInkController; ink: () => InkStroke[]; ops: InkOp[]; notices: string[] };

const mounted: PdfInkController[] = [];

/** A mounted PDF controller on a stand-in leaf, its ink in a list the ops are applied to. */
function mountPdf(id: string, first: InkStroke[] = [pdfStroke("on-page", 100)]): Pdf {
	const leafContent = new N("DIV", "workspace-leaf-content");
	leafContent.add(new N("DIV", "view-content")).add(new N("DIV", "pdf-container"));
	let ink = first;
	const ops: InkOp[] = [];
	const notices: string[] = [];
	const win = {
		devicePixelRatio: 1,
		clearTimeout: () => {},
		setTimeout: () => 0,
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		getComputedStyle: () => ({ position: "relative" }),
		navigator: { maxTouchPoints: 0, userAgent: "test" },
	};
	const controller = new PdfInkController(
		leafContent as unknown as HTMLElement,
		win as unknown as Window,
		() => ink,
		() => id,
		() => ink,
		(op) => {
			ops.push(op);
			ink = applyOp(ink, op);
		},
		() => {},
		(message) => void notices.push(message)
	);
	controller.mount();
	mounted.push(controller);
	return { controller, ink: () => ink, ops, notices };
}

/** Lasso these ids on the page and copy, as the copy command does. */
function copyFromPdf(pdf: Pdf, ids: string[], page = 2): void {
	const c = pdf.controller as unknown as { selected: string[]; selectionPage: number };
	c.selected = ids;
	c.selectionPage = page;
	pdf.controller.copySelection();
}

/** A real note overlay with just its host chrome replaced (as PdfCtrlVPaste.test.ts builds it). */
function noteOverlay(path: string): InkOverlayPlugin {
	const noop = (): void => undefined;
	let fileReady = false;
	const scrollDOM = {
		clientWidth: 800, clientHeight: 600, clientLeft: 0, clientTop: 0,
		scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }),
	};
	const dom = {
		ownerDocument: { defaultView: { getComputedStyle: () => ({ position: "relative" }) } },
		parentElement: null,
		closest: (selector: string): unknown => (selector === ".markdown-source-view" ? root : null),
	};
	const root = { ownerDocument: dom.ownerDocument, querySelector: () => dom };
	const view = {
		dom,
		scrollDOM,
		state: { field: () => (fileReady ? { file: { path } } : undefined) },
		dispatch: noop,
	};
	const overlay = new InkOverlayPlugin(view as never) as unknown as Record<string, unknown>;
	fileReady = true;
	overlay.container = { nodeType: 1, remove: noop, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
	overlay.mobileTools = null;
	overlay.scheduleRepaint = noop;
	overlay.repaintPath = noop;
	overlay.redrawSelectionUI = noop;
	overlay.updateExtent = noop;
	overlay.syncCamera = noop;
	return overlay as unknown as InkOverlayPlugin;
}

let serial = 0;
const notePath = (): string => `pdf-paste-copied-from-${++serial}.md`;

/** Paste the clipboard into a note; the strokes that landed. */
function pasteIntoNote(path: string): InkStroke[] {
	const n = noteOverlay(path).pasteInkHere();
	expect(n, "premise: the note took the paste").toBeGreaterThan(0);
	return inlineInk.strokes(path).slice(-n);
}

/** Lasso these ids in the note and copy, as the note's copy command does. */
function copyFromNote(path: string, ids: string[]): void {
	const overlay = noteOverlay(path);
	(overlay as unknown as { selection: { selectExactly(ids: string[]): void } }).selection.selectExactly(ids);
	expect(overlay.copySelectedInk(), "premise: the note copy took the strokes").toBe(ids.length);
}

/** Note strokes as the note's file holds them, read back into the note store. */
async function noteWith(strokes: InkStroke[]): Promise<string> {
	const path = notePath();
	await inlineInk.ensureLoaded(path);
	inlineInk.applyAdd(path, strokes);
	return path;
}

const ids = (strokes: readonly InkStroke[]): string[] => strokes.map((s) => s.id);

beforeEach(() => clearInkClipboard());
afterEach(() => {
	for (const c of mounted.splice(0)) c.unmount();
	clearInkClipboard();
});

describe("ink copied from a note is refused on a PDF, page or no page", () => {
	it("PDF ink pasted into a note, copied from the note and pasted on the PDF it came from: the notice, nothing added", () => {
		const pdf = mountPdf("pdf-a");
		copyFromPdf(pdf, ["on-page"]);
		const note = notePath();
		const inNote = pasteIntoNote(note);
		expect(inNote.map((s) => s.page), "premise: the note keeps the page").toEqual([2]);
		copyFromNote(note, ids(inNote));
		const lassoed = pdf.controller as unknown as { selected: string[] };
		expect(lassoed.selected, "premise: the PDF's lasso is still up at the paste").toEqual(["on-page"]);
		pdf.controller.pasteFromClipboard();
		expect(pdf.notices.at(-1), "the PDF paste of ink copied from a note").toBe(NOTE_INK);
		expect(pdf.ops, "an op reached the PDF's store, so a save would write it").toEqual([]);
		expect(ids(pdf.ink())).toEqual(["on-page"]);
		expect(lassoed.selected, "a refused paste dropped the PDF's lasso").toEqual(["on-page"]);
	});

	it("note strokes saved with a page, copied from the note and pasted on a PDF: the notice, nothing added", async () => {
		const note = await noteWith([pdfStroke("saved-with-page", 200)]);
		copyFromNote(note, ["saved-with-page"]);
		const pdf = mountPdf("pdf-a");
		pdf.controller.pasteFromClipboard();
		expect(pdf.notices.at(-1), "the PDF paste of ink copied from a note").toBe(NOTE_INK);
		expect(pdf.ops, "an op reached the PDF's store, so a save would write it").toEqual([]);
		expect(ids(pdf.ink())).toEqual(["on-page"]);
	});

	it("PDF ink pasted into a note, copied from the note and pasted on another PDF: the notice, nothing added", () => {
		const from = mountPdf("pdf-a");
		copyFromPdf(from, ["on-page"]);
		const note = notePath();
		copyFromNote(note, ids(pasteIntoNote(note)));
		const other = mountPdf("pdf-b", []);
		other.controller.pasteFromClipboard();
		expect(other.notices.at(-1), "the PDF paste of ink copied from a note").toBe(NOTE_INK);
		expect(other.ops, "an op reached the PDF's store, so a save would write it").toEqual([]);
		expect(other.ink()).toEqual([]);
	});

	it("a PDF copy that takes nothing (its lasso names a stroke gone since) leaves the note's copy: the notice, nothing added", async () => {
		const note = await noteWith([pdfStroke("saved-with-page", 200)]);
		copyFromNote(note, ["saved-with-page"]);
		const pdf = mountPdf("pdf-a");
		copyFromPdf(pdf, ["gone"]);
		expect(pdf.notices.at(-1), "premise: the PDF copy took nothing").toBe("Handwriting: lasso some ink first");
		pdf.controller.pasteFromClipboard();
		expect(pdf.notices.at(-1), "the PDF paste of ink copied from a note").toBe(NOTE_INK);
		expect(pdf.ops, "an op reached the PDF's store, so a save would write it").toEqual([]);
	});

	it("control: a note stroke with no page, copied from the note and pasted on a PDF: the notice, nothing added", async () => {
		const note = await noteWith([noteStroke("drawn-in-the-note", 200)]);
		copyFromNote(note, ["drawn-in-the-note"]);
		const pdf = mountPdf("pdf-a");
		pdf.controller.pasteFromClipboard();
		expect(pdf.notices.at(-1)).toBe(NOTE_INK);
		expect(pdf.ops).toEqual([]);
	});

	it("control: a note selection of a stroke with a page and one without, pasted on a PDF: the notice, nothing added", async () => {
		const note = await noteWith([pdfStroke("with-page", 200), noteStroke("without", 300)]);
		copyFromNote(note, ["with-page", "without"]);
		const pdf = mountPdf("pdf-a");
		pdf.controller.pasteFromClipboard();
		expect(pdf.notices.at(-1)).toBe(NOTE_INK);
		expect(pdf.ops).toEqual([]);
	});
});

describe("ink copied from a PDF still pastes on a PDF, and into a note as before", () => {
	it("control: copied from the PDF and pasted on it: one stroke added on the copied page", () => {
		const pdf = mountPdf("pdf-a");
		copyFromPdf(pdf, ["on-page"]);
		pdf.controller.pasteFromClipboard();
		expect(pdf.notices.at(-1)).toBe("Handwriting: pasted 1 stroke");
		expect(pdf.ops.map((op) => op.type)).toEqual(["add"]);
		expect(pdf.ink().filter((s) => s.page === 2)).toHaveLength(2);
	});

	it("control: the last copy decides: a note copy, then a PDF copy, then a PDF paste adds the PDF's ink", async () => {
		const note = await noteWith([pdfStroke("saved-with-page", 200)]);
		copyFromNote(note, ["saved-with-page"]);
		const pdf = mountPdf("pdf-a");
		copyFromPdf(pdf, ["on-page"]);
		pdf.controller.pasteFromClipboard();
		expect(pdf.notices.at(-1)).toBe("Handwriting: pasted 1 stroke");
		const added = pdf.ink().filter((s) => s.id !== "on-page");
		// The PDF's own stroke starts at x 100 and a paste back into its source steps 16 px off; the note's is at 200.
		expect(added.map((s) => s.points[0]!.x), "the pasted stroke is the PDF's, a step off").toEqual([116]);
	});

	it("control: PDF ink pasted into a note keeps its page in the note", () => {
		const pdf = mountPdf("pdf-a");
		copyFromPdf(pdf, ["on-page"]);
		const note = notePath();
		pasteIntoNote(note);
		expect(inlineInk.strokes(note).map((s) => s.page)).toEqual([2]);
	});
});
