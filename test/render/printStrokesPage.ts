/**
 * The page for PrintStrokes.test.ts: a heavily inked note in the Export to PDF shape (div.print > view, every block in a
 * div of its own), its print layer built by the beforeprint swap, and what that layer holds.
 *
 * The ink (printStrokesInk.ts): seeded rows of handwriting-like pen strokes on one page, in long runs of one colour,
 * and two highlighter strokes across the first rows. A long run of one colour is the case that folded: the run printed
 * as one fill holding every stroke in it.
 *
 * - `mountPrint(rows, perRow)`: builds the note, paints it, fires beforeprint, returns the print layer's counts.
 * - `endPrint()`: afterprint.
 */
import { attachEmbedInkOnceReady, initEmbedInkColumnWidth, initEmbedInkRefresh, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { heavyInk } from "./printStrokesInk";
import { installObsidianDom } from "./obsidianDom";

installObsidianDom();

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

const w = window as unknown as Record<string, unknown>;

w.mountPrint = async (rows: number, perRow: number) => {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
	const print = document.body.createDiv({ cls: "print" });
	const root = print.createDiv({ cls: "markdown-preview-view markdown-rendered" });
	root.createEl("h1", { text: "Heavy note" });
	for (let i = 0; i < 4; i++) root.createDiv().createEl("p", { text: `Paragraph ${i + 1} of the heavy note.` });
	const strokes = heavyInk(rows, perRow);
	initEmbedInkRefresh(() => strokes);
	initEmbedInkColumnWidth(() => 700);
	attachEmbedInkOnceReady(root, root, "print-strokes.md", () => strokes);
	await frame();
	await frame();
	window.dispatchEvent(new Event("beforeprint"));
	await frame();
	await frame();
	const layer = root.querySelector<SVGSVGElement>(":scope > svg.handwriting-embed-ink");
	const pen = strokes.filter((s) => s.tool !== "highlighter").length;
	return {
		layer: layer !== null,
		penStrokes: pen,
		highlighterStrokes: strokes.length - pen,
		// Pen paths sit on the layer itself; the highlighter runs sit in its one <g>.
		penPaths: layer ? layer.querySelectorAll(":scope > path").length : 0,
		highlighterPaths: layer ? layer.querySelectorAll(":scope > g > path").length : 0,
	};
};

w.endPrint = async () => {
	window.dispatchEvent(new Event("afterprint"));
	await frame();
};
