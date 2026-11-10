/**
 * Ctrl+V with copied ink on the clipboard, in a PDF pane and in a note.
 *
 * Copying ink puts a marker line on the system clipboard ("handwriting-ink/v1
 * <token> (n strokes)"). In a note, the editor's paste handler sees the marker,
 * pastes the ink and keeps the marker out of the text. A PDF pane binds keydown
 * on its root and nothing for paste, so the same Ctrl+V pastes no ink there,
 * and when the viewer's find bar has focus the marker is typed into it.
 *
 * The PDF cells mount a real controller on a stand-in leaf whose root records
 * every listener it is given, then deliver a paste event to that root the way
 * the browser would: to its capture and bubble listeners, with the event's
 * target inside the pane. The event's default action (the text landing in the
 * focused input) happens unless a listener prevents it, so `defaultPrevented`
 * is the question "did the marker reach the input".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isMobileApp: false }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		Platform: {
			...(actual.Platform as Record<string, unknown>),
			get isMobileApp(): boolean {
				return platform.isMobileApp;
			},
		},
	};
});
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
import { clearInkClipboard, copyInk, inkClipboardMarker } from "../inline/InkClipboard";
import { InkOverlayPlugin, inlineEditorHandlers, inlineInk } from "../inline/InkOverlay";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const DOC = "pdf-doc-paste";

function pdfStroke(id: string, x: number): InkStroke {
	const points = [0, 5, 10].map((v) => ({ x: x + v, y: 30 + v, pressure: 0.5, t: v }));
	return { id, points, bbox: computeBBox(points, 2), tool: "pen", color: "#112233", width: 2, createdAt: 0, page: 1 };
}

type Listener = { type: string; fn: (ev: Event) => void; capture: boolean };

/** Minimal element: attributes, a parent chain, and a record of its listeners. */
class N {
	attrs = new Map<string, string>();
	parentElement: N | null = null;
	children: N[] = [];
	listeners: Listener[] = [];
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
	addEventListener(type: string, fn: (ev: Event) => void, opts?: boolean | { capture?: boolean }): void {
		const capture = typeof opts === "boolean" ? opts : opts?.capture === true;
		this.listeners.push({ type, fn, capture });
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

/** A PDF leaf as Obsidian builds it, with the find bar inside the pdf container. */
function buildPdfLeaf() {
	const leafContent = new N("DIV", "workspace-leaf-content");
	const viewContent = leafContent.add(new N("DIV", "view-content"));
	const pdfContainer = viewContent.add(new N("DIV", "pdf-container"));
	const findBar = pdfContainer.add(new N("DIV", "pdf-findbar"));
	const findInput = findBar.add(new N("INPUT", "pdf-findbar-input"));
	const contentContainer = pdfContainer.add(new N("DIV", "pdf-content-container"));
	const scroller = contentContainer.add(new N("DIV", "pdf-viewer-container"));
	const pdfViewer = scroller.add(new N("DIV", "pdfViewer"));
	const page = pdfViewer.add(new N("DIV", "page"));
	return { leafContent, findInput, page };
}

function mountPdf() {
	const leaf = buildPdfLeaf();
	let ink: InkStroke[] = [pdfStroke("on-page", 100)];
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
		leaf.leafContent as unknown as HTMLElement,
		win as unknown as Window,
		() => ink,
		() => DOC,
		() => ink,
		(op) => {
			ink = applyOp(ink, op);
		},
		() => {},
		(message) => void notices.push(message)
	);
	controller.mount();
	return { controller, leaf, ink: () => ink, notices };
}

/** A paste event as the browser builds it: clipboard text, a target, a default action. */
function pasteEvent(text: string, target: unknown) {
	let prevented = false;
	const ev = {
		type: "paste",
		target,
		clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") },
		get defaultPrevented(): boolean {
			return prevented;
		},
		preventDefault: () => {
			prevented = true;
		},
		stopPropagation: () => {},
		stopImmediatePropagation: () => {},
	};
	return ev;
}

/** Deliver to the root's capture listeners, then its bubble listeners: the root is an ancestor of the target. */
function deliverToRoot(root: N, ev: ReturnType<typeof pasteEvent>): number {
	const ours = root.listeners.filter((l) => l.type === "paste");
	for (const l of ours.filter((l) => l.capture)) l.fn(ev as unknown as Event);
	for (const l of ours.filter((l) => !l.capture)) l.fn(ev as unknown as Event);
	return ours.length;
}

/** A real pasteInkHere on a note overlay with just its host chrome replaced (as InlinePasteReveal.test.ts builds it). */
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

describe("Ctrl+V with copied ink on the clipboard", () => {
	let marker: string;
	beforeEach(() => {
		clearInkClipboard();
		copyInk([pdfStroke("copied", 300)], DOC);
		marker = inkClipboardMarker()!;
	});
	afterEach(() => clearInkClipboard());

	it("the clipboard holds the copy marker", () => {
		expect(marker).not.toBeNull();
		expect(marker.startsWith("handwriting-ink/v1 ")).toBe(true);
	});

	it("in a note, the paste puts the ink in and keeps the marker out of the text", () => {
		const path = "pdf-ink-pasted-into-a-note.md";
		const overlay = noteOverlay(path);
		const ev = pasteEvent(marker, {});
		const before = inlineInk.strokes(path).length;
		const handled = inlineEditorHandlers.paste!(ev as unknown as ClipboardEvent, {
			plugin: () => overlay,
		} as never);
		expect(handled).toBe(true);
		expect(inlineInk.strokes(path).length - before).toBe(1);
		expect(ev.defaultPrevented).toBe(true);
	});

	it("in a PDF, the same ink pastes onto the page by command", () => {
		const r = mountPdf();
		try {
			r.controller.pasteFromClipboard();
			expect(r.ink().filter((s) => s.page === 1)).toHaveLength(2);
		} finally {
			r.controller.unmount();
		}
	});

	it("in a PDF, Ctrl+V over the page puts the copied ink on the page", () => {
		const r = mountPdf();
		try {
			const ev = pasteEvent(marker, r.leaf.page);
			const heard = deliverToRoot(r.leaf.leafContent, ev);
			expect(r.ink().filter((s) => s.page === 1), `paste listeners on the pane: ${heard}`).toHaveLength(2);
			expect(ev.defaultPrevented).toBe(true);
		} finally {
			r.controller.unmount();
		}
	});

	it("in a PDF, Ctrl+V in the find bar does not type the marker into it", () => {
		const r = mountPdf();
		try {
			const ev = pasteEvent(marker, r.leaf.findInput);
			const heard = deliverToRoot(r.leaf.leafContent, ev);
			expect(ev.defaultPrevented, `paste listeners on the pane: ${heard}`).toBe(true);
		} finally {
			r.controller.unmount();
		}
	});

	it("in a PDF, ordinary text pasted into the find bar still lands there", () => {
		const r = mountPdf();
		try {
			const ev = pasteEvent("search words", r.leaf.findInput);
			deliverToRoot(r.leaf.leafContent, ev);
			expect(ev.defaultPrevented).toBe(false);
			expect(r.ink()).toHaveLength(1);
		} finally {
			r.controller.unmount();
		}
	});

	it("in a PDF, Ctrl+V with copied ink in the find bar pastes no ink and says where ink goes", () => {
		const r = mountPdf();
		try {
			const ev = pasteEvent(marker, r.leaf.findInput);
			const heard = deliverToRoot(r.leaf.leafContent, ev);
			expect(r.notices, `paste listeners on the pane: ${heard}`).toContain(
				"Handwriting: ink pastes on the page, not in a text field"
			);
			expect(r.ink()).toHaveLength(1);
			expect(ev.defaultPrevented).toBe(true);
		} finally {
			r.controller.unmount();
		}
	});

	it("in a PDF, Ctrl+V with a marker from an earlier copy pastes no ink and says so", () => {
		const r = mountPdf();
		try {
			// A second copy names new ink: the first marker, replayed from a
			// clipboard manager's history, no longer names what is held.
			copyInk([pdfStroke("copied-again", 400)], DOC);
			const ev = pasteEvent(marker, r.leaf.page);
			const heard = deliverToRoot(r.leaf.leafContent, ev);
			expect(r.notices, `paste listeners on the pane: ${heard}`).toContain(
				"Handwriting: that ink was copied before the app restarted"
			);
			expect(r.ink()).toHaveLength(1);
			expect(ev.defaultPrevented).toBe(true);
		} finally {
			r.controller.unmount();
		}
	});
});

/**
 * After a Ctrl+V on a PDF the pasted ink is what is selected, as after a paste in a note. The user copies a selected
 * stroke and presses Ctrl+V: the copies land on the copied page, a step off the originals. If the old selection stays
 * on the originals, the pasted ink is not marked, a Delete straight after removes the originals the user meant to
 * keep, and a drag moves them instead of the copies.
 */
describe("Ctrl+V on a PDF selects what it pasted", () => {
	beforeEach(() => clearInkClipboard());
	afterEach(() => clearInkClipboard());

	function selectAndCopyTheStroke(r: ReturnType<typeof mountPdf>): string {
		const c = r.controller as unknown as { selected: string[]; selectionPage: number };
		c.selected = ["on-page"];
		c.selectionPage = 1;
		copyInk(r.ink().filter((s) => s.id === "on-page"), DOC);
		return inkClipboardMarker()!;
	}

	it("the selection holds the pasted strokes, not the originals", () => {
		const r = mountPdf();
		try {
			const marker = selectAndCopyTheStroke(r);
			deliverToRoot(r.leaf.leafContent, pasteEvent(marker, r.leaf.page));
			const pasted = r.ink().filter((s) => s.id !== "on-page").map((s) => s.id);
			expect(pasted, "premise: one stroke pasted").toHaveLength(1);
			const c = r.controller as unknown as { selected: string[]; selectionPage: number };
			expect(c.selected, `selection after the paste ${JSON.stringify(c.selected)}`).toEqual(pasted);
			expect(c.selectionPage, "on the page the ink was pasted to").toBe(1);
		} finally {
			r.controller.unmount();
		}
	});

	it("Delete straight after the paste removes the copies and keeps the originals", () => {
		const r = mountPdf();
		try {
			const marker = selectAndCopyTheStroke(r);
			deliverToRoot(r.leaf.leafContent, pasteEvent(marker, r.leaf.page));
			expect(r.ink(), "premise: original and copy on the page").toHaveLength(2);
			r.controller.deleteSelection();
			expect(r.ink().map((s) => s.id), "the original stays").toEqual(["on-page"]);
		} finally {
			r.controller.unmount();
		}
	});
});
