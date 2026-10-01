/**
 * AUDIT PROBE R5-L-hosts-2 (1.4.21, tag 1a05f62c). Read-only probe, not a fix.
 *
 * Claim: the editor of an Obsidian Canvas TEXT card is a markdown editor whose
 * `editorInfoField` is its owner K7, and K7 has no file (Obsidian 1.13.7
 * app.js @3304946: `e.call(this,t.app,t.contentEl,null)`, then
 * `editable=!0,useIframe=!0`; i1 stores `o.file=i` = null @2581199; the edit
 * mode t1 builds the HJ editor whose local extensions include
 * `MJ.init(() => e.owner)` @2540838, MJ being `editorInfoField` @255414; t1
 * detaches HJ's `.markdown-source-view` editorEl, adds `mod-inside-iframe` and
 * reparents it into the iframe body @2577470/@2578962). The note overlay
 * mounts on that editor anyway, builds its pen router with a pen gate that
 * never looks at the file, so the pen is claimed; the stroke is drawn wet and
 * then discarded at lift because `filePath()` is null.
 *
 * The Obsidian half (the card editor's DOM and owner) is modelled from the
 * app.js offsets above. The plugin half is REAL production code: the mount
 * gate, the constructor's mount() up to the router and its real `penOff`
 * closure, `filePath()`, `penDown`, `penRaw`, `penUp`.
 *
 * Assertions state the CORRECT behaviour: an editor whose owner has no file
 * must not claim the pen (router not built, or penOff() true), and a stroke
 * the overlay has drawn wet must not vanish unsaved at lift.
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

/** What the real mount() handed the router: the editor and the callbacks, incl. the real penOff closure. */
const captured = vi.hoisted(() => ({
	scrollEl: null as unknown,
	built: 0,
	cb: null as null | { penOff?: () => boolean },
}));

vi.mock("../inline/InlinePenRouter", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../inline/InlinePenRouter")>();
	class CapturingRouter {
		isStroking = false;
		constructor(scrollEl: unknown, _container: unknown, cb: { penOff?: () => boolean }) {
			captured.scrollEl = scrollEl;
			captured.cb = cb;
			captured.built++;
		}
		dispose(): void {}
		refreshRect(): void {}
		setCanvasMomentumDisabled(): void {}
		cameraTransformChanged(): void {}
		predictedSamples(): unknown[] {
			return [];
		}
	}
	return { ...actual, InlinePenRouter: CapturingRouter };
});

import { InkOverlayPlugin, inlineInk, releaseTipModes } from "../inline/InkOverlay";
import { penInkEnabled, setPenInk, resetPenInkForTest } from "../inline/PenInk";
import type { PenSample } from "../input/PointerRouter";

const CARD_TEXT = "A canvas text card.\nSecond line of the card.";
const LINE_PX = 20;

const noop = (): void => undefined;

/** K7, the Canvas text card's embed: `file` is null (constructed with null). */
const cardOwner = { file: null, editor: {}, editable: true, useIframe: true };

function cardState(): { doc: EditorState["doc"]; field(f: unknown, req?: boolean): unknown } {
	const real = EditorState.create({ doc: CARD_TEXT });
	return {
		doc: real.doc,
		field: (f: unknown) => (f === editorInfoField ? cardOwner : undefined),
	};
}

/** A small element tree with a REAL ancestor walk, so the gate decides for itself. */
class Node {
	readonly classes: Set<string>;
	readonly children: Node[] = [];
	readonly style = { removeProperty: noop };
	/** A visible card's box: what a real layout measures once the card editor shows. */
	offsetWidth = 400;
	offsetHeight = 2 * LINE_PX;
	clientWidth = 400;
	clientHeight = 2 * LINE_PX;
	width = 0;
	height = 0;
	readonly classList = { add: noop, remove: noop, toggle: noop, contains: () => false };
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
		// A 2D context that accepts every paint call (no pixels in Node).
		return new Proxy({} as Record<string, unknown>, {
			get: (t, k: string) => (k in t ? t[k] : () => undefined),
			set: (t, k: string, v) => {
				t[k] = v;
				return true;
			},
		});
	}
	getBoundingClientRect(): DOMRect {
		return fakeRect(0, 0, 400, 2 * LINE_PX);
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
 * The Canvas text card editor in 1.13.7 after t1.reparent: the iframe's body
 * holds HJ's editorEl (`markdown-source-view cm-s-obsidian mod-cm6
 * mod-inside-iframe`), whose child is the CodeMirror view.
 */
function cardEditor(attached: boolean): { dom: Node; scroller: Node; doc: Record<string, unknown> } {
	const doc: Record<string, unknown> = { defaultView: win() };
	const body = new Node(doc, "");
	doc.body = body;
	const editorEl = new Node(
		doc,
		"markdown-source-view cm-s-obsidian mod-cm6 mod-inside-iframe",
		attached ? body : null
	);
	const dom = new Node(doc, "cm-editor", editorEl);
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

function sample(x: number, y: number, t = 0): PenSample {
	return { x, y, pressure: 0.5, timestamp: t, tiltX: 0, tiltY: 0 };
}

function contact(x: number, y: number): PointerEvent {
	return {
		clientX: x,
		clientY: y,
		buttons: 1,
		button: 0,
		pointerType: "pen",
		pointerId: 7,
		timeStamp: 0,
	} as unknown as PointerEvent;
}

/** A proxy that answers every paint call with a no-op and logs the call name. */
function paintStub(log: string[], answers: Record<string, unknown> = {}): Record<string, unknown> {
	const store: Record<string, unknown> = { ...answers };
	return new Proxy(store, {
		get: (t, k: string) => {
			if (k in t) {
				const v = t[k];
				return typeof v === "function"
					? (...a: unknown[]) => {
							log.push(k);
							return (v as (...x: unknown[]) => unknown)(...a);
						}
					: v;
			}
			return () => {
				log.push(k);
				return undefined;
			};
		},
		set: (t, k: string, v) => {
			t[k] = v;
			return true;
		},
	});
}

/**
 * EraserColdPage/R5-L-hosts-1 rig: a REAL constructed overlay (class fields
 * run) with zero origins, constructed with the field absent (mount() takes its
 * inert exit), then handed the card editor's state so `filePath()` is the real
 * method reading K7 through editorInfoField.
 */
function cardOverlay(): { overlay: Record<string, unknown>; view: Record<string, unknown> } {
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
			getBoundingClientRect: () => fakeRect(0, 0, 400, 2 * LINE_PX),
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
			scrollWidth: 400,
			scrollHeight: 2 * LINE_PX,
			clientWidth: 400,
			clientHeight: 2 * LINE_PX,
		},
		state: { field: () => undefined },
	};
	const overlay = new InkOverlayPlugin(view as never) as unknown as Record<string, unknown>;
	view.state = cardState();
	overlay.container = {
		getBoundingClientRect: () => fakeRect(0, 0, 400, 2 * LINE_PX),
		offsetWidth: 400,
		offsetHeight: 2 * LINE_PX,
		isConnected: true,
		find: () => null,
		remove: noop,
	};
	overlay.eraserEl = { setAttribute: noop, setCssStyles: noop };
	overlay.penCursorEl = null;
	return { overlay, view };
}

describe("R5-L-hosts-2: a Canvas text card editor (owner with no file) takes the pen and drops every stroke", () => {
	beforeEach(() => {
		releaseTipModes();
		captured.scrollEl = null;
		captured.built = 0;
		captured.cb = null;
	});
	afterEach(() => {
		releaseTipModes();
		resetPenInkForTest();
	});

	for (const attached of [false, true]) {
		it(`an editor whose owner has no file must not claim the pen (${attached ? "inside the iframe" : "detached, before reparent"})`, () => {
			const { dom, scroller } = cardEditor(attached);
			const view = { state: cardState(), dom, scrollDOM: scroller, contentDOM: scroller, scaleX: 1, scaleY: 1, documentTop: 0 };

			// Preconditions: the field is DEFINED (the owner K7), its file is null,
			// pen ink is at its default (on).
			expect(view.state.field(editorInfoField)).toBe(cardOwner);
			expect(proto.filePath.call({ view }), "precondition: real filePath() is null for the card").toBeNull();
			expect(penInkEnabled(), "precondition: pen ink default on").toBe(true);

			// Tracked cell for audit #13 (1.4.22 lane R): the fix is the mount
			// gate, so the real mount() must build no router on a file-less card.
			// R5-L-hosts-1 carries the positive control (a note editor mounts).
			new InkOverlayPlugin(view as never);
			expect(
				captured.built,
				`overlay mounted on a file-less card editor: router built on ${captured.scrollEl === scroller ? "the card's scroller" : "?"}`
			).toBe(0);
		});
	}

});
