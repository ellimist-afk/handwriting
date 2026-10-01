/**
 * AUDIT PROBE R5-L-hosts-1 (1.4.21, tag 1a05f62c). Read-only probe, not a fix.
 *
 * Claim: a section-only editor (hover preview of [[Note#Heading]], a Canvas
 * card with a heading subpath, a footnote popover) is an HJ-based Obsidian
 * editor whose `editorInfoField` is the owner (owner.file = the WHOLE note)
 * while its CodeMirror document holds ONE section. The note overlay mounts on
 * it anyway, takes the whole note's path, and puts world y = 0 at the
 * SECTION's first line. So ink drawn there is saved into the note's record
 * measured from the section, and the eraser there hit-tests the whole note's
 * ink against the section's origin.
 *
 * The Obsidian half (the embed editor's DOM, owner and section-cut doc) is not
 * runnable here; it is modelled from Obsidian 1.13.7 app.js: HJ's constructor
 * creates `n.createDiv("markdown-source-view cm-s-obsidian mod-cm6")` with the
 * CodeMirror view as its child (@2540838), only the table-cell subclass UJ
 * removes that class (@2570428), the embed's doc is `ID(...)`'s substring
 * (@1381122, @2650037) and `editorInfoField` is `MJ.init(() => e.owner)`
 * (@2545347). The plugin half below is REAL production code: the mount gate,
 * the constructor's mount() up to the router, `filePath()`, `syncCamera`,
 * `penDown`, `eraseAt`, `penUp` and `inlineInk.commitGesture`.
 *
 * Assertions state the CORRECT behaviour: pen input in a section-only editor
 * must not erase note ink that sits above the section, and must not store a
 * stroke drawn on the section into the note above the section.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { editorInfoField } from "obsidian";

class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

/** What the real mount() handed the router: which editor the overlay went live on. */
const captured = vi.hoisted(() => ({ scrollEl: null as unknown, built: 0 }));

vi.mock("../inline/InlinePenRouter", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../inline/InlinePenRouter")>();
	class CapturingRouter {
		isStroking = false;
		constructor(scrollEl: unknown) {
			captured.scrollEl = scrollEl;
			captured.built++;
		}
		dispose(): void {}
		refreshRect(): void {}
		predictedSamples(): unknown[] {
			return [];
		}
	}
	return { ...actual, InlinePenRouter: CapturingRouter };
});

import { InkOverlayPlugin, inlineInk, releaseTipModes } from "../inline/InkOverlay";
import type { InkStroke } from "../ink/Stroke";
import { DEFAULT_PEN } from "../ink/PenStyle";
import type { PenSample } from "../input/PointerRouter";

const NOTE = "audit-hosts-note.md";
/** Lines above the heading's first body line in the note itself. */
const LINES_ABOVE = 42;
const LINE_PX = 20;
/** Where the section's first body line sits in the note's own world frame. */
const SECTION_TOP = LINES_ABOVE * LINE_PX;

const NOTE_TEXT = [
	"# Title",
	...Array.from({ length: LINES_ABOVE - 2 }, (_, i) => `Paragraph ${i + 1}.`),
	"## Heading",
	"Section line one.",
	"Section line two.",
].join("\n");
/** What ID() leaves an EDITABLE heading embed: the body, heading line dropped. */
const SECTION_TEXT = "Section line one.\nSection line two.";

const noop = (): void => undefined;

/** The owner object Obsidian puts in editorInfoField: owner.file is the whole note. */
const ownerInfo = { file: { path: NOTE }, editor: {} };

/** The section editor's state: a real CM state for the doc, the owner for the field. */
function sectionState(): { doc: EditorState["doc"]; field(f: unknown, req?: boolean): unknown } {
	const real = EditorState.create({ doc: SECTION_TEXT });
	return {
		doc: real.doc,
		field: (f: unknown) => (f === editorInfoField ? ownerInfo : undefined),
	};
}

/** A small element tree with a REAL ancestor walk, so the gate decides for itself. */
class Node {
	readonly classes: Set<string>;
	readonly children: Node[] = [];
	readonly style = { removeProperty: noop };
	constructor(
		readonly ownerDocument: Record<string, unknown>,
		cls: string,
		readonly parentElement: Node | null = null
	) {
		this.classes = new Set(cls.split(/\s+/).filter(Boolean));
		parentElement?.children.push(this);
	}
	private matches(sel: string): boolean {
		if (!sel.startsWith(".")) throw new Error(`Node: unsupported selector ${sel}`);
		return sel
			.slice(1)
			.split(".")
			.every((c) => this.classes.has(c));
	}
	closest(selector: string): Node | null {
		const alts = selector.split(",").map((s) => s.trim());
		for (let n: Node | null = this; n; n = n.parentElement) {
			const cur = n;
			if (alts.some((a) => cur.matches(a))) return cur;
		}
		return null;
	}
	querySelector(selector: string): Node | null {
		for (const c of this.children) {
			if (c.closest(selector) === c) return c;
			const deep = c.querySelector(selector);
			if (deep) return deep;
		}
		return null;
	}
	querySelectorAll(): Node[] {
		return [];
	}
	createDiv(opts?: { cls?: string } | string): Node {
		const cls = typeof opts === "string" ? opts : (opts?.cls ?? "");
		return new Node(this.ownerDocument, `probe-child ${cls}`, this);
	}
	createEl(_tag: string, opts?: { cls?: string }): Node {
		return this.createDiv(opts);
	}
	setCssStyles = noop;
	setAttribute = noop;
	addEventListener = noop;
	removeEventListener = noop;
	getContext(): unknown {
		return {};
	}
	getBoundingClientRect(): DOMRect {
		return fakeRect(0, 0, 800, 600);
	}
}

function fakeRect(left: number, top: number, width: number, height: number): DOMRect {
	return { left, top, width, height, right: left + width, bottom: top + height } as DOMRect;
}

function win(): Record<string, unknown> {
	return {
		setTimeout: () => 1,
		clearTimeout: noop,
		getComputedStyle: () => ({ position: "relative", fontSize: "16px" }),
		cancelAnimationFrame: noop,
		requestAnimationFrame: () => 1,
		devicePixelRatio: 1,
		matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
		addEventListener: noop,
		removeEventListener: noop,
		navigator: {},
	};
}

/**
 * The hover popover of [[Note#Heading]] in 1.13.7, made editable:
 * body > .popover.hover-popover > .markdown-embed > .markdown-embed-content
 *   > .markdown-source-view (HJ.editorEl) > .cm-editor (the CM view).
 */
function popoverEditor(): { dom: Node; scroller: Node; doc: Record<string, unknown> } {
	const doc: Record<string, unknown> = { defaultView: win() };
	const body = new Node(doc, "app-container-body");
	// The popover sits in document.body; mount() puts the reticle there too.
	doc.body = body;
	const popover = new Node(doc, "popover hover-popover", body);
	const embed = new Node(doc, "markdown-embed is-loaded", popover);
	const content = new Node(doc, "markdown-embed-content", embed);
	const source = new Node(doc, "markdown-source-view cm-s-obsidian mod-cm6", content);
	const dom = new Node(doc, "cm-editor", source);
	const scroller = new Node(doc, "cm-scroller", dom);
	return { dom, scroller, doc };
}

/** Control: a table-cell editor (UJ removed its own markdown-source-view class). */
function tableCellEditor(): Node {
	const doc: Record<string, unknown> = { defaultView: win() };
	const source = new Node(doc, "markdown-source-view mod-cm6");
	const outer = new Node(doc, "cm-editor", source);
	const widget = new Node(doc, "cm-embed-block cm-table-widget", outer);
	const cellWrap = new Node(doc, "table-cell-wrapper", widget);
	return new Node(doc, "cm-editor", cellWrap);
}

interface Proto {
	ownsMarkdownEditorRoot(this: unknown): boolean;
	filePath(this: unknown): string | null;
	penDown(this: unknown, s: PenSample, ev: PointerEvent): void;
	penRaw(this: unknown, s: PenSample[], ev: PointerEvent): void;
	penUp(this: unknown, ev?: PointerEvent): void;
}
const proto = InkOverlayPlugin.prototype as unknown as Proto;

function inkAt(id: string, y: number): InkStroke {
	return {
		id,
		tool: "pen",
		color: DEFAULT_PEN.color,
		width: DEFAULT_PEN.baseWidth,
		points: [
			{ x: 120, y, pressure: 0.5, t: 0 },
			{ x: 130, y, pressure: 0.5, t: 8 },
		],
		bbox: { x: 120, y, width: 10, height: 0 },
		createdAt: 0,
	};
}

function sample(x: number, y: number, t = 0): PenSample {
	return { x, y, pressure: 0.5, timestamp: t, tiltX: 0, tiltY: 0 };
}

function contact(x: number, y: number, eraser: boolean): PointerEvent {
	return {
		clientX: x,
		clientY: y,
		buttons: eraser ? 32 : 1,
		button: eraser ? 5 : 0,
		pointerType: "pen",
		timeStamp: 0,
	} as unknown as PointerEvent;
}

/** A proxy that answers every paint call with a no-op (and keeps what is set on it). */
function paintStub(answers: Record<string, unknown> = {}): Record<string, unknown> {
	const store: Record<string, unknown> = { ...answers };
	return new Proxy(store, {
		get: (t, k: string) => (k in t ? t[k] : () => undefined),
		set: (t, k: string, v) => {
			t[k] = v;
			return true;
		},
	});
}

/**
 * EraserColdPage.test.ts's rig: a REAL constructed overlay (class fields run)
 * with zero origins, so client (x, y) inside the popover's editor is world
 * (x, y) of whatever the overlay thinks its document is. Constructed with the
 * field absent (mount() takes its inert exit, no canvases), then handed the
 * section editor's state, so `filePath()` is the real method reading the
 * owner through editorInfoField.
 */
function sectionOverlay(): { overlay: Record<string, unknown>; eraserStyle: Record<string, unknown>; view: Record<string, unknown> } {
	const eraserStyle: Record<string, unknown> = { display: "none" };
	const view: Record<string, unknown> = {
		dom: {
			parentElement: { setCssStyles: noop },
			ownerDocument: { defaultView: win() },
			style: { removeProperty: noop },
			setCssStyles: noop,
		},
		hasFocus: true,
		focus: noop,
		dispatch: noop,
		documentTop: 0,
		scaleX: 1,
		scaleY: 1,
		contentDOM: {
			getBoundingClientRect: () => fakeRect(0, 0, 800, 2 * LINE_PX),
			querySelector: () => null,
			querySelectorAll: () => [],
			children: [],
			firstElementChild: null,
		},
		scrollDOM: {
			addEventListener: noop,
			removeEventListener: noop,
			classList: { add: noop, remove: noop },
			setCssStyles: noop,
			style: { removeProperty: noop },
			scrollLeft: 0,
			scrollTop: 0,
			scrollWidth: 800,
			scrollHeight: 2 * LINE_PX,
			clientWidth: 800,
			clientHeight: 2 * LINE_PX,
		},
		state: { field: () => undefined },
	};
	const overlay = new InkOverlayPlugin(view as never) as unknown as Record<string, unknown>;
	view.state = sectionState();
	overlay.container = {
		getBoundingClientRect: () => fakeRect(0, 0, 800, 2 * LINE_PX),
		offsetWidth: 800,
		offsetHeight: 2 * LINE_PX,
		isConnected: true,
		find: () => null,
		remove: noop,
	};
	overlay.eraserEl = {
		setAttribute: noop,
		setCssStyles: (s: Record<string, unknown>) => Object.assign(eraserStyle, s),
	};
	overlay.penCursorEl = null;
	return { overlay, eraserStyle, view };
}

function noteIds(): string[] {
	return inlineInk.strokes(NOTE).map((s) => s.id);
}

describe("R5-L-hosts-1: a section-only editor owns the whole note's ink", () => {
	beforeEach(() => {
		releaseTipModes();
		captured.scrollEl = null;
		captured.built = 0;
		inlineInk.applyRemove(NOTE, noteIds());
	});
	afterEach(() => {
		releaseTipModes();
		inlineInk.applyRemove(NOTE, noteIds());
	});

	// Tracked cell for audit #13 (1.4.22 lane R). The audit probe's erase and
	// stroke cases drove an overlay injected past mount(); the fix is the mount
	// gate itself, so what is pinned here is that gate and the real mount(),
	// with an ordinary note editor in the same fake DOM as the positive control.
	it("control: an ordinary note editor passes the gate and mount() builds its router", () => {
		const doc: Record<string, unknown> = { defaultView: win() };
		const body = new Node(doc, "app-container-body");
		doc.body = body;
		const leaf = new Node(doc, "workspace-leaf-content", body);
		const source = new Node(doc, "markdown-source-view cm-s-obsidian mod-cm6", leaf);
		const dom = new Node(doc, "cm-editor", source);
		const scroller = new Node(doc, "cm-scroller", dom);
		const view = { state: sectionState(), dom, scrollDOM: scroller, contentDOM: scroller };
		expect(proto.ownsMarkdownEditorRoot.call({ view })).toBe(true);
		try {
			new InkOverlayPlugin(view as never);
		} catch (error) {
			if (captured.built === 0) throw error;
		}
		expect(captured.built).toBe(1);
		expect(captured.scrollEl).toBe(scroller);
	});

	it("the mount gate refuses the popover's section editor, and mount() builds no router there", () => {
		const { dom, scroller } = popoverEditor();
		const view = { state: sectionState(), dom, scrollDOM: scroller, contentDOM: scroller };

		// The editor's document is one section, not the note it names.
		expect(view.state.doc.toString()).toBe(SECTION_TEXT);
		expect(NOTE_TEXT.endsWith(SECTION_TEXT)).toBe(true);
		expect(proto.filePath.call({ view })).toBe(NOTE);

		expect(proto.ownsMarkdownEditorRoot.call({ view }), "gate took the popover's section editor").toBe(false);
		try {
			new InkOverlayPlugin(view as never);
		} catch (error) {
			if (captured.built === 0) throw error;
		}
		expect(captured.built, "mount() built a router on the popover's section editor").toBe(0);
	});
});
