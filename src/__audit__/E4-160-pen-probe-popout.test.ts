/**
 * E4 probe for audit item 160 (finding id Input-6): the pen probe's document
 * tracer ignores popouts and never reaches the JSON export.
 *
 * Claim: PenDiagnosticsView.onOpen binds its capture-phase pen tracer to the
 * global `document`, the main window's, so a probe opened in a popout never
 * sees that window's pen contacts. And the tracer's rows go through
 * recordNote, which draws a DOM row and never pushes to `entries`, so Show
 * JSON leaves them out even in the main window.
 *
 * Production code driven: the real PenDiagnosticsView.onOpen and its Show JSON
 * button, with showDiagnosticText captured. The view's elements are the
 * smallest stand-ins onOpen touches, owned by a popout built by
 * test/popoutWindow.ts; the global `document` and `window` are the main
 * window's, recorded.
 *
 * Asserts the CORRECT behaviour: the tracer sits on the popout's document and
 * nothing on the main one, a popout pen contact is traced, and the trace row
 * is in the JSON. The control proves the capture box's own rows reach the JSON
 * through the same button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePopoutWindow, PopoutWindow } from "../../test/popoutWindow";

const shown = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("../diag/DiagnosticTextModal", () => ({
	showDiagnosticText: (_app: unknown, _title: string, text: string) => void shown.texts.push(text),
}));

import { PenDiagnosticsView } from "../input/PenDiagnosticsView";

type Fn = (ev: unknown) => void;

interface FakeEl {
	ownerDocument: unknown;
	text: string;
	children: FakeEl[];
	empty(): void;
	addClass(): void;
	setText(t: string): void;
	createEl(tag: string, o?: { text?: string }): FakeEl;
	createDiv(o?: { text?: string }): FakeEl;
	addEventListener(type: string, fn: Fn): void;
	removeEventListener(type: string, fn: Fn): void;
	fire(type: string, ev: unknown): void;
	setPointerCapture(): void;
	getBoundingClientRect(): { left: number; top: number };
	scrollIntoView(): void;
	find(t: string): FakeEl | undefined;
	readonly lastElementChild: null;
	readonly childElementCount: number;
}

/** An element stand-in: children, text, listeners by type, all in one document. */
function el(ownerDocument: unknown, text = ""): FakeEl {
	const listeners = new Map<string, Fn[]>();
	const node: FakeEl = {
		ownerDocument,
		text,
		children: [],
		empty(): void {
			node.children.length = 0;
		},
		addClass(): void {},
		setText(t: string): void {
			node.text = t;
		},
		createEl(_tag: string, o: { text?: string } = {}) {
			const c = el(ownerDocument, o.text ?? "");
			node.children.push(c);
			return c;
		},
		createDiv(o: { text?: string } = {}) {
			return node.createEl("div", o);
		},
		addEventListener(type: string, fn: Fn): void {
			listeners.set(type, [...(listeners.get(type) ?? []), fn]);
		},
		removeEventListener(type: string, fn: Fn): void {
			listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
		},
		fire(type: string, ev: unknown): void {
			for (const fn of listeners.get(type) ?? []) fn(ev);
		},
		setPointerCapture(): void {},
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
		scrollIntoView(): void {},
		find(t: string): FakeEl | undefined {
			for (const c of node.children) {
				if (c.text === t) return c;
				const hit = c.find(t);
				if (hit) return hit;
			}
			return undefined;
		},
		get lastElementChild() {
			return null;
		},
		get childElementCount() {
			return node.children.length;
		},
	};
	return node;
}

const g = globalThis as unknown as { document?: unknown; window?: unknown };
const realDocument = g.document;
const realWindow = g.window;
let mainDocListeners: string[];

beforeEach(() => {
	shown.texts.length = 0;
	mainDocListeners = [];
	g.document = {
		addEventListener: (type: string) => void mainDocListeners.push(type),
		removeEventListener: () => {},
	};
	g.window = { requestAnimationFrame: () => 0, addEventListener() {}, removeEventListener() {} };
});

afterEach(() => {
	g.document = realDocument;
	g.window = realWindow;
});

async function openIn(popout: PopoutWindow) {
	const view = new (PenDiagnosticsView as unknown as new (leaf: unknown, v: string) => PenDiagnosticsView)(
		{},
		"test"
	);
	const content = el(popout.document);
	Object.assign(view, { contentEl: content, containerEl: content, app: {} });
	await view.onOpen();
	return { view, content };
}

const pen = { pointerType: "pen", pointerId: 3, button: 0, buttons: 1, pressure: 0.5, preventDefault() {} };

describe("E4 item 160 control: the capture box's rows reach the JSON", () => {
	it("a pen contact on the capture box is in Show JSON", async () => {
		const popout = makePopoutWindow();
		const { content } = await openIn(popout);
		const box = content.find("Write / touch / hover here");
		expect(box).toBeDefined();
		box!.fire("pointerdown", { ...pen, type: "pointerdown", timeStamp: 1, clientX: 5, clientY: 6, tiltX: 0, tiltY: 0 });
		content.find("Show JSON")!.fire("click", {});
		expect(shown.texts).toHaveLength(1);
		expect(shown.texts[0]).toContain('"type":"pointerdown"');
	});
});

describe("E4 item 160 probe: the pen tracer follows the view's window into the export", () => {
	it("traces a popout's pen contacts on the popout's document and puts the rows in Show JSON", async () => {
		const popout = makePopoutWindow();
		const { content, view } = await openIn(popout);

		popout.dispatchDocument("pointerdown", { ...pen, target: { tagName: "DIV", className: "cm-content" } });
		content.find("Show JSON")!.fire("click", {});
		const json = shown.texts[0] ?? "";

		expect({
			onPopoutDocument: ["pointerdown", "pointerup", "pointercancel"].map((t) => popout.documentListeners(t)),
			onMainDocument: mainDocListeners,
			traceInJson: json.includes("DOC pointerdown pen id=3"),
		}).toEqual({ onPopoutDocument: [1, 1, 1], onMainDocument: [], traceInJson: true });

		await view.onClose();
		expect(["pointerdown", "pointerup", "pointercancel"].map((t) => popout.documentListeners(t))).toEqual([0, 0, 0]);
	});
});
