/**
 * Cells for the rest of audit item 60 (finding id L-compat-2): Snip and the
 * diagnostics Copy button write through the main window's clipboard, which
 * Chromium refuses while a popout has focus.
 *
 * Claim: snipNote and snipPdf (main.ts) write the embed with the bare global
 * `navigator.clipboard`, and DiagnosticTextModal.copyToClipboard writes the
 * report the same way. Plugin code runs in the main window's realm, so both go
 * to the main window's Clipboard, which rejects "Document is not focused"
 * while the user is working in a popout.
 *
 * Production code driven: snipNote and snipPdf sliced verbatim out of main.ts
 * and run as src/DirectOutputCreation.test.ts runs them, with `navigator` (the
 * main window's) and `activeWindow` (Obsidian's focused window, here a popout)
 * handed in; and the real DiagnosticTextModal.prototype.copyToClipboard with a
 * button that lives in the popout. Each window's clipboard follows Chromium's
 * rule: it refuses unless its own document has focus. The popout has focus.
 *
 * Asserts the CORRECT behaviour: the popout's clipboard receives the text and
 * the user is told it is there. Controls: with no popout (activeWindow absent,
 * the main window focused) the main clipboard is used, as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformSync } from "esbuild";
import mainSource from "../main.ts?raw";

const notices = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock("obsidian", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	class Notice {
		constructor(message: string) {
			notices.said.push(message);
		}
	}
	return { ...actual, Notice };
});

import { Notice } from "obsidian";
import { DiagnosticTextModal } from "../diag/DiagnosticTextModal";

const source = mainSource.replace(/\r\n/g, "\n");
function slice(startMarker: string): string {
	expect(source.split(startMarker)).toHaveLength(2);
	const start = source.indexOf(startMarker);
	return source.slice(start, source.indexOf("\n\t}", start) + 3);
}
const SNIP_NOTE = slice("\tprivate async snipNote(file: TFile, overlay: InkOverlayPlugin): Promise<void> {");
const SNIP_PDF = slice("\tprivate async snipPdf(file: TFile, controller: PdfInkController): Promise<void> {");
expect(SNIP_NOTE).toContain("clipboard.writeText(md)");
expect(SNIP_PDF).toContain("clipboard.writeText(md)");

/** A window whose clipboard, like Chromium's, refuses a write unless its own document has focus. */
function clipWindow(name: string, focused: () => string, board: { text: string }) {
	return {
		navigator: {
			clipboard: {
				writeText: async (text: string): Promise<void> => {
					if (focused() !== name) throw new Error("NotAllowedError: Document is not focused.");
					board.text = text;
				},
			},
		},
	};
}

type Snipper = { snipNote(file: unknown, o: unknown): Promise<void>; snipPdf(file: unknown, c: unknown): Promise<void> };

function snipper(deps: Record<string, unknown>): Snipper {
	const names = Object.keys(deps);
	const cls = `return class { ${SNIP_NOTE}\n${SNIP_PDF} }`;
	const Holder = new Function(...names, transformSync(cls, { loader: "ts", target: "es2022" }).code)(
		...names.map((n) => deps[n])
	) as new () => Snipper;
	const inst = new Holder() as Snipper & Record<string, unknown>;
	inst.firstFreePath = async (candidate: (n: number) => string) => candidate(1);
	inst.snipBacklink = () => "[[source]]";
	inst.app = {
		vault: { createBinary: async () => ({}) },
		metadataCache: { getFirstLinkpathDest: () => null },
	};
	return inst;
}

function world(withPopout: boolean) {
	const board = { text: "stale text the user copied earlier" };
	let focused = withPopout ? "popout" : "main";
	const main = clipWindow("main", () => focused, board);
	const popout = clipWindow("popout", () => focused, board);
	const deps: Record<string, unknown> = {
		Notice,
		console: { error() {}, warn() {}, log() {} },
		navigator: main.navigator,
		stripMarkdownExtension: (p: string) => p.replace(/\.md$/, ""),
		createFreshFile: async (choose: () => Promise<string>, create: (p: string) => Promise<unknown>) => {
			const path = await choose();
			return { path, result: await create(path) };
		},
	};
	if (withPopout) deps.activeWindow = popout;
	return { board, deps, popout, focus: (w: string) => void (focused = w) };
}

const bytes = { ok: true, bytes: new Uint8Array([1]), pageNumber: 3 };
const note = { path: "notes/source.md", basename: "source", extension: "md" };
const pdf = { path: "papers/source.pdf", basename: "source", extension: "pdf" };

beforeEach(() => {
	notices.said.length = 0;
});

describe("audit 60 controls: no popout, the main window's clipboard as before", () => {
	it("a note snip puts the embed on the clipboard", async () => {
		const w = world(false);
		await snipper(w.deps).snipNote(note, { snipSelection: async () => bytes });
		expect(w.board.text).toContain("source.snip-1.png");
		expect(notices.said).toEqual(["Handwriting: snipped to source.snip-1.png; the embed is on your clipboard"]);
	});
});

describe("audit 60 probe: Snip in a focused popout", () => {
	it("a note snip's embed reaches the clipboard", async () => {
		const w = world(true);
		await snipper(w.deps).snipNote(note, { snipSelection: async () => bytes });
		expect({ clipboard: w.board.text.includes("source.snip-1.png"), said: notices.said }).toEqual({
			clipboard: true,
			said: ["Handwriting: snipped to source.snip-1.png; the embed is on your clipboard"],
		});
	});

	it("a PDF snip's embed reaches the clipboard", async () => {
		const w = world(true);
		await snipper(w.deps).snipPdf(pdf, { snipSelection: async () => bytes });
		expect({ clipboard: w.board.text.includes("source.snip-1.png"), said: notices.said }).toEqual({
			clipboard: true,
			said: ["Handwriting: snipped to source.snip-1.png; the embed is on your clipboard"],
		});
	});
});

describe("audit 60: the diagnostics Copy button in a popout", () => {
	const g = globalThis as unknown as { navigator?: unknown; window?: unknown };
	const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	const realWindow = g.window;
	afterEach(() => {
		if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
		g.window = realWindow;
	});

	function copy(buttonWindow: unknown, focused: string) {
		const board = { text: "stale" };
		const main = clipWindow("main", () => focused, board);
		Object.defineProperty(globalThis, "navigator", { value: main.navigator, configurable: true });
		g.window = { setTimeout: () => 0 };
		const labels: string[] = [];
		const button = {
			ownerDocument: { defaultView: buttonWindow },
			setText: (t: string) => void labels.push(t),
		};
		const modal = Object.create(DiagnosticTextModal.prototype) as {
			copyToClipboard(text: string, b: unknown, label: string, markDelivered: boolean): Promise<void>;
		};
		return { board, labels, run: () => modal.copyToClipboard("the report", button, "Copy", false) };
	}

	it("control: a button in the main window, main focused, copies", async () => {
		const c = copy(undefined, "main");
		await c.run();
		expect([c.board.text, c.labels[0]]).toEqual(["the report", "Copied"]);
	});

	it("a button in a focused popout copies through the popout's clipboard", async () => {
		const board = { text: "" };
		const popout = clipWindow("popout", () => "popout", board);
		const c = copy(popout, "popout");
		await c.run();
		expect({ popoutClipboard: board.text, label: c.labels[0] }).toEqual({ popoutClipboard: "the report", label: "Copied" });
	});
});
