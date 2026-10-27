/**
 * The page for ExportShape.test.ts: Alan's canvas note "Untitled 1" in the Export to PDF shape (div.print > view, every
 * block in a div of its own), its ink from a copy of the vault's sidecar, parsed by the plugin's own parser.
 *
 * - `shapeLoad(sidecar)`: parse once; counts.
 * - `shapeMount(lines, column)`: builds the note with one block per text line, wires the canvas, paper and column
 *   providers (column null = no editor column, as when Reading view hides the editor), paints, fires the screen call
 *   (beforeprint at screen media). The test then flips the media to print, which runs the print-media call.
 * - `shapeRead()`: the container's zoom and padding, the layer's box and the export's diagnostic lines.
 * - `shapeEnd()`: afterprint.
 */
import { attachEmbedInkOnceReady, initEmbedInkColumnWidth, initEmbedInkDiagnostics, initEmbedInkRefresh, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { initEmbedInkPrintCanvas, initEmbedInkPrintPaper } from "../../src/inline/EmbedInkPrint";
import * as printModule from "../../src/inline/EmbedInkPrint";
import { embedInkDiagLine } from "../../src/inline/EmbedInkRoot";
import type { InkStroke } from "../../src/ink/Stroke";
import { parsePage } from "../../src/model/PageData";
import { installObsidianDom } from "./obsidianDom";

installObsidianDom();

const PATH = "Untitled 1.md";
const LETTER = { pageSize: "Letter", landscape: false, margin: "0", downscalePercent: 100 };
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const w = window as unknown as Record<string, unknown>;

let STROKES: InkStroke[] = [];
const diag: string[] = [];

w.shapeLoad = (sidecar: string) => {
	const parsed = parsePage(sidecar, "75d1627a-c4d7-4a11-947d-bc26b7f83c20");
	STROKES = parsed.data.strokes as InkStroke[];
	return { strokes: STROKES.length, noteCanvas: (parsed.data as unknown as { noteCanvas?: boolean }).noteCanvas ?? null, damaged: parsed.damaged ?? false };
};

w.shapeMount = async (lines: string[], column: number | null, reading = false, columnAtPrint = true) => {
	teardownEmbedInk();
	diag.length = 0;
	document.body.replaceChildren();
	document.body.className = "theme-dark";
	initEmbedInkRefresh(() => STROKES);
	if (reading) {
		// The note's own Reading view, shown beside the export as in Obsidian: view > sizer, one div per block, its
		// column 700 px. The editor is hidden (column null), as Reading view hides it.
		const view = document.body.createDiv({ cls: "markdown-reading-view" }).createDiv({ cls: "markdown-preview-view markdown-rendered" });
		const sizer = view.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
		sizer.style.width = "700px";
		for (const line of lines) {
			const el = sizer.createDiv({ cls: "el-p" });
			el.createEl("p", { text: line });
			attachEmbedInkOnceReady(el, sizer, PATH, () => STROKES);
		}
		await frame();
		await frame();
	}
	const print = document.body.createDiv({ cls: "print" });
	const root = print.createDiv({ cls: "markdown-preview-view markdown-rendered" });
	for (const line of lines) root.createDiv().createEl("p", { text: line });
	initEmbedInkRefresh(() => STROKES);
	// An editor not pinched reads its column off a line, and the print media hides the workspace (app.css :3143): the
	// print-media call reads null then. A pinched editor holds its measured column box through the print.
	initEmbedInkColumnWidth(() => (!columnAtPrint && window.matchMedia("print").matches ? null : column));
	initEmbedInkPrintCanvas(() => true);
	initEmbedInkPrintPaper(() => LETTER);
	initEmbedInkDiagnostics((via, path, ms) => diag.push(embedInkDiagLine(via, path, ms)));
	attachEmbedInkOnceReady(root, root, PATH, () => STROKES);
	await frame();
	await frame();
	window.dispatchEvent(new Event("beforeprint"));
	await frame();
	await frame();
	return true;
};

w.shapeRead = async () => {
	await frame();
	await frame();
	const root = document.querySelector<HTMLElement>(".print > .markdown-preview-view")!;
	const reading = document.querySelector<HTMLElement>(".markdown-reading-view .markdown-preview-sizer");
	const layer = root.querySelector<SVGSVGElement>(":scope > svg.handwriting-embed-ink");
	const r = (v: number) => Math.round(v * 10) / 10;
	return {
		zoom: root.style.zoom || "",
		width: root.style.width || "",
		paddingLeft: root.style.paddingLeft || "",
		paddingTop: root.style.paddingTop || "",
		minHeight: root.style.minHeight || "",
		rootBox: { w: r(root.offsetWidth), h: r(root.offsetHeight) },
		layer: layer ? { w: layer.getAttribute("width"), h: layer.getAttribute("height"), viewBox: layer.getAttribute("viewBox") } : null,
		readingColumn: reading ? reading.clientWidth : null,
		readingColumnFor: (printModule as { readingColumnFor?: (p: string) => number | null }).readingColumnFor?.(PATH) ?? "absent",
		diag: [...diag],
	};
};

w.shapeEnd = async () => {
	window.dispatchEvent(new Event("afterprint"));
	await frame();
	initEmbedInkDiagnostics(null);
	initEmbedInkPrintCanvas(null);
	initEmbedInkPrintPaper(null);
};
