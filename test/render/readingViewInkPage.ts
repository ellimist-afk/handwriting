/**
 * The page for ReadingViewInk.test.ts: one note rendered the two ways a second view renders it, with strokes anchored
 * to the editor's lines, and where each stroke is painted.
 *
 * The note, in the editor's 1-based lines: a three-line frontmatter, three one-line paragraphs with two blank lines
 * between each, a blank line, a three-item list whose second item wraps, a fenced code block of four rows (the second
 * empty) and a paragraph of three lines joined by hard breaks (the first wraps), a blank line between each. The editor is modelled as every line 24 px with the frontmatter
 * hidden, so line 4 is at the top: a stroke `off` px under line n's top was drawn at y = (n - 4) * 24 + off, and its
 * anchor holds that line's top. The views lay the text out by their own rules (an inline title and a Properties block
 * above the text in Reading view, paragraph margins in place of the blank lines), so page positions come off the words.
 *
 * - `readingView(c)`: Obsidian's reading view shape (view > sizer > pusher, header, one div per section), each section
 *   post-processed with its own section info, as the preview renderer gives it.
 * - `exportPrint(c, late)`: the export's shape (div.print > view, no sizer, every block in a div of its own),
 *   post-processed once with no section info; the note's cached sections and text stand in for the metadata cache, at
 *   once or (`late`) only after a timer, as a file read would.
 * - `reattach(c)`, `sizerBatch(c)`, `sizerWatch(c)`: reading view as the virtualised renderer changes the sizer's
 *   sections on scroll: a section attached after the paint, what one batch of such changes reads and queues, and the
 *   observers left on the sizer after the teardown.
 * Every case paints one horizontal stroke and returns its painted centre and the y it should be painted at, page px.
 */
import { attachEmbedInkOnceReady, initEmbedInkColumnWidth, initEmbedInkRefresh, teardownEmbedInk } from "../../src/inline/EmbedInk";
import { aboveOf, lineKey, newAboveRun } from "../../src/inline/LineAnchor";
import type { InkStroke } from "../../src/ink/Stroke";
import { installObsidianDom } from "./obsidianDom";

installObsidianDom();

/** Long enough to wrap onto a second rendered line in every view here (a 700 px column, 16 px text), not a third. */
const WRAPS = "a line long enough to wrap onto a second rendered line in each of the views, so its block's lines are not of one height";
const NOTE = [
	"---", "tags: note", "---",
	"This is the first paragraph of the note.", "", "",
	"Here the circle is second in its line.", "", "",
	"The underline goes under pargaph and a trick.", "",
	"- one", `- two, ${WRAPS}`, "- three", "",
	"```js", "const a = 1;", "", "const b = 2;", "const c = a + b;", "```", "",
	`First, ${WRAPS}`, "a second line after a hard break", "and a third line after another",
];
const TEXT = NOTE.join("\n");
const SECTIONS = [
	{ type: "yaml", lineStart: 0, lineEnd: 2 },
	{ type: "paragraph", lineStart: 3, lineEnd: 3 },
	{ type: "paragraph", lineStart: 6, lineEnd: 6 },
	{ type: "paragraph", lineStart: 9, lineEnd: 9 },
	{ type: "list", lineStart: 11, lineEnd: 13 },
	{ type: "code", lineStart: 15, lineEnd: 20 },
	{ type: "paragraph", lineStart: 22, lineEnd: 24 },
];
const EDITOR_LINE = 24;
const editorTop = (line: number) => Math.max(0, line - 4) * EDITOR_LINE;

/** Where a case's stroke sits in the editor, and which rendered block (and rule) says where it belongs. */
export interface InkCase {
	name: string;
	/** 1-based editor line under the stroke's bbox top; 0 for a stroke with no anchor. */
	line: number;
	/** px under that line's top. */
	off: number;
	/** The block the stroke belongs to: its 0-based first line. */
	block: number;
	/**
	 * How the rendered line top follows from that block: its top, one line above it, its bottom, or a row inside it (a
	 * list's item k, a code block's row k, the k-th line after a paragraph's hard breaks).
	 */
	rule: "top" | "above" | "below" | { item: number } | { row: number } | { brk: number };
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const later = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One horizontal stroke at editor y, anchored to `line` (or not, at line 0). */
function strokeFor(c: InkCase, y: number): InkStroke {
	const pad = 4;
	const points = Array.from({ length: 12 }, (_, j) => ({ x: 60 + j * 8, y, pressure: 0.5, t: j * 9 }));
	const bbox = { x: 60 - pad, y: y - pad, width: 88 + 2 * pad, height: 2 * pad };
	const s = { id: `case-${c.line}-${c.off}`, tool: "pen", color: "#ff00ff", width: 3, createdAt: 0, points, bbox } as InkStroke;
	if (c.line > 0) s.lineAnchor = { line: c.line, top: editorTop(c.line), y: bbox.y, key: lineKey(NOTE[c.line - 1]!), width: 668, fontPx: 16, above: aboveOf(newAboveRun(), c.line, (k) => lineKey(NOTE[k - 1]!)) };
	return s;
}

function blockHtml(line: number): string {
	if (line === 3) return "<p>This is the first paragraph of the note.</p>";
	if (line === 6) return '<p>Here the circle is <span id="w-second">second</span> in its line.</p>';
	if (line === 9) return '<p>The underline goes under <span id="w-pargaph">pargaph</span> and a trick.</p>';
	// As the renderer writes them: a code block's text ends with a line feed; a hard break is followed by one.
	if (line === 15) return '<pre><code class="language-js">const a = 1;\n\nconst b = 2;\nconst c = a + b;\n</code></pre>';
	if (line === 22) return `<p>First, ${WRAPS}<br>\na second line after a hard break<br>\nand a third line after another</p>`;
	return `<ul><li>one</li><li>two, ${WRAPS}</li><li>three</li></ul>`;
}

/**
 * The y the case's stroke belongs at, page px, from its block's box, each row by its own geometry rather than by the
 * code's method: a list item's own box; a code row by the code's content height shared by its rows (none wraps); a
 * hard-break line by the paragraph's rendered lines, the first source line taking all but one per later line.
 */
function wanted(c: InkCase, el: HTMLElement): number {
	const r = el.getBoundingClientRect();
	const lh = parseFloat(getComputedStyle(el.firstElementChild ?? el).lineHeight);
	if (c.rule === "top") return r.top + c.off;
	if (c.rule === "above") return r.top - lh + c.off;
	if (c.rule === "below") return r.bottom + c.off;
	if ("item" in c.rule) return el.querySelectorAll("li")[c.rule.item]!.getBoundingClientRect().top + c.off;
	if ("row" in c.rule) {
		const pre = el.querySelector("pre")!;
		const s = getComputedStyle(pre);
		const padTop = parseFloat(s.paddingTop), content = pre.clientHeight - padTop - parseFloat(s.paddingBottom);
		const rows = (pre.textContent ?? "").replace(/\n$/, "").split("\n").length;
		return pre.getBoundingClientRect().top + pre.clientTop + padTop + (c.rule.row * content) / rows + c.off;
	}
	const p = el.querySelector("p")!;
	const plh = parseFloat(getComputedStyle(p).lineHeight);
	const later = p.querySelectorAll("br").length;
	const firstTakes = Math.round(p.getBoundingClientRect().height / plh) - later;
	return p.getBoundingClientRect().top + (firstTakes + c.rule.brk - 1) * plh + c.off;
}

/** Where the estimate (the line's share of its block's height) would put the case's stroke, page px. */
function estimated(c: InkCase, el: HTMLElement): number {
	const r = el.getBoundingClientRect();
	const s = SECTIONS.find((x) => x.lineStart === c.block)!;
	return r.top + ((c.line - 1 - s.lineStart) * r.height) / (s.lineEnd - s.lineStart + 1) + c.off;
}

/** The painted centre of the canvas layer's pixels, page px, or null when nothing is painted. */
function canvasCentre(root: HTMLElement): { x: number; y: number } | null {
	const layer = root.querySelector<HTMLCanvasElement>(":scope > canvas.handwriting-embed-ink");
	if (!layer) return null;
	const lr = layer.getBoundingClientRect();
	const d = layer.getContext("2d")!.getImageData(0, 0, layer.width, layer.height).data;
	let y0 = 1e9, y1 = -1, x0 = 1e9, x1 = -1;
	for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) if (d[(y * layer.width + x) * 4 + 3]! > 0) {
		if (y < y0) y0 = y;
		if (y > y1) y1 = y;
		if (x < x0) x0 = x;
		if (x > x1) x1 = x;
	}
	if (y1 < 0) return null;
	return { x: lr.left + ((x0 + x1 + 1) / 2) * (lr.width / layer.width), y: lr.top + ((y0 + y1 + 1) / 2) * (lr.height / layer.height) };
}

/** The painted centre of every path in the given svgs, page px: each path's box through its svg's viewBox. */
function svgCentre(svgs: SVGSVGElement[]): { x: number; y: number } | null {
	let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
	for (const svg of svgs) {
		const r = svg.getBoundingClientRect();
		const vb = (svg.getAttribute("viewBox") ?? "0 0 1 1").split(" ").map(Number);
		const sx = r.width / vb[2]!, sy = r.height / vb[3]!;
		for (const path of Array.from(svg.querySelectorAll("path"))) {
			const b = path.getBBox();
			// A strip holds the part of the stroke inside its viewBox.
			const y0 = Math.max(b.y, vb[1]!), y1 = Math.min(b.y + b.height, vb[1]! + vb[3]!);
			if (y1 <= y0) continue;
			top = Math.min(top, r.top + (y0 - vb[1]!) * sy);
			bottom = Math.max(bottom, r.top + (y1 - vb[1]!) * sy);
			left = Math.min(left, r.left + (b.x - vb[0]!) * sx);
			right = Math.max(right, r.left + (b.x + b.width - vb[0]!) * sx);
		}
	}
	return bottom > top ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null;
}

function reset(): void {
	teardownEmbedInk();
	document.body.replaceChildren();
	document.body.className = "theme-light";
}

const w = window as unknown as Record<string, unknown>;

/**
 * Obsidian's reading view shape (view > sizer > pusher, header, one div per section), each section post-processed
 * with its own section info, as the preview renderer gives it, and painted. `detached`: that section is kept out of
 * the sizer at the paint, as the virtualised renderer keeps a section it has not attached, with the sizer held at the
 * height it has with every section in it (the renderer holds the text still with a margin), so attaching it later
 * resizes nothing.
 */
async function readingViewOf(c: InkCase, detached: number | null = null) {
	reset();
	const root = document.body.createDiv({ cls: "markdown-preview-view markdown-rendered" });
	const sizer = root.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
	sizer.createDiv({ cls: "markdown-preview-pusher" });
	const header = sizer.createDiv({ cls: "mod-header" });
	header.createDiv({ cls: "inline-title", text: "Three paragraphs" });
	const props = header.createDiv({ cls: "metadata-container" });
	props.createDiv({ cls: "metadata-property", text: "tags: note" });
	const sections: Array<{ el: HTMLElement; lineStart: number; lineEnd: number }> = [];
	const fm = sizer.createDiv({ cls: "mod-frontmatter mod-ui" });
	fm.createEl("pre", { cls: "frontmatter", text: "tags: note" });
	sections.push({ el: fm, lineStart: 0, lineEnd: 2 });
	for (const s of SECTIONS.slice(1)) {
		const el = sizer.createDiv({ cls: s.type === "list" ? "el-ul" : s.type === "code" ? "el-pre" : "el-p" });
		el.innerHTML = blockHtml(s.lineStart);
		sections.push({ el, lineStart: s.lineStart, lineEnd: s.lineEnd });
	}
	let next: Node | null = null;
	if (detached !== null) {
		const left = sections.find((s) => s.lineStart === detached)!.el;
		sizer.style.height = `${sizer.getBoundingClientRect().height}px`;
		next = left.nextSibling;
		left.remove();
	}
	await frame();
	const y = c.line > 0 ? editorTop(c.line) + c.off : c.off;
	const strokes = [strokeFor(c, y)];
	initEmbedInkRefresh(() => strokes);
	for (const s of sections) {
		attachEmbedInkOnceReady(s.el, sizer, "reading-view.md", () => strokes, undefined, false, {
			section: () => ({ text: TEXT, lineStart: s.lineStart, lineEnd: s.lineEnd }),
			cached: () => null,
		});
	}
	await frame();
	await frame();
	return { root, sizer, header, sections, y, next };
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Reading view: each section post-processed with the renderer's own answer for it. */
w.readingView = async (c: InkCase) => {
	const { root, header, sections, y } = await readingViewOf(c);
	const painted = canvasCentre(root);
	if (!painted) return { error: "nothing painted" };
	const block = sections.find((s) => s.lineStart === c.block)!.el;
	// With no anchor, the stroke's page position: the layer's y 0 is the header's foot.
	const want = c.line > 0 ? wanted(c, block) : header.getBoundingClientRect().bottom + y;
	return { painted: r2(painted.y), want: r2(want), dy: r2(painted.y - want), estimate: c.line > 0 ? r2(estimated(c, block)) : null };
};

/**
 * Reading view, the case's section kept out of the sizer at the paint (its stroke keeps its page position, the section
 * having no box), then attached where it belongs, as the renderer attaches a section scrolled back into view: no
 * resize, no new render. Where the stroke is painted before and after.
 */
w.reattach = async (c: InkCase) => {
	const { root, sizer, sections, next } = await readingViewOf(c, c.block);
	const before = canvasCentre(root);
	const el = sections.find((s) => s.lineStart === c.block)!.el;
	sizer.insertBefore(el, next);
	await frame();
	await frame();
	const painted = canvasCentre(root);
	if (!before || !painted) return { error: "nothing painted" };
	const want = wanted(c, el);
	return { before: r2(before.y), painted: r2(painted.y), want: r2(want), dy: r2(painted.y - want) };
};

/**
 * Counts layout reads on any element (offsets, client and scroll sizes, rects) and the microtasks queued, from now
 * until `stop`. A queued microtask's own reads are not counted: the replace it runs reads the blocks by design, once
 * the task's renders are done.
 */
function layoutProbe(): { stop(): { reads: number; queued: number; where: string[] } } {
	let reads = 0, queued = 0, inside = 0;
	const where: string[] = [];
	const undo: Array<() => void> = [];
	const count = (name: string, el: Element) => {
		if (inside > 0) return;
		reads++;
		if (where.length < 12) where.push(`${name} ${el.tagName}.${el.className}`);
	};
	const getter = (proto: object, prop: string) => {
		const d = Object.getOwnPropertyDescriptor(proto, prop)!;
		Object.defineProperty(proto, prop, { ...d, get(this: Element) { count(prop, this); return d.get!.call(this); } });
		undo.push(() => Object.defineProperty(proto, prop, d));
	};
	const method = (proto: Record<string, unknown>, prop: string) => {
		const orig = proto[prop] as (...a: unknown[]) => unknown;
		proto[prop] = function (this: Element, ...a: unknown[]) { count(prop, this); return orig.apply(this, a); };
		undo.push(() => { proto[prop] = orig; });
	};
	for (const p of ["offsetTop", "offsetLeft", "offsetWidth", "offsetHeight", "offsetParent"]) getter(HTMLElement.prototype, p);
	for (const p of ["clientTop", "clientLeft", "clientWidth", "clientHeight", "scrollTop", "scrollLeft", "scrollWidth", "scrollHeight"]) getter(Element.prototype, p);
	for (const p of ["getBoundingClientRect", "getClientRects"]) method(Element.prototype as unknown as Record<string, unknown>, p);
	const queue = window.queueMicrotask;
	window.queueMicrotask = (cb: VoidFunction) => {
		queued++;
		queue.call(window, () => {
			inside++;
			try { cb(); } finally { inside--; }
		});
	};
	undo.push(() => { window.queueMicrotask = queue; });
	return { stop: () => { for (const u of undo.reverse()) u(); return { reads, queued, where }; } };
}

/**
 * Reading view, painted; then one batch in the sizer as the renderer makes one on scroll (a section detached and
 * attached again in one task), and the microtasks it queues run. What the batch read and queued.
 */
w.sizerBatch = async (c: InkCase) => {
	const { sizer, sections } = await readingViewOf(c);
	const moved = sections.find((s) => s.lineStart === 9)!.el;
	const next = moved.nextSibling;
	const probe = layoutProbe();
	moved.remove();
	sizer.insertBefore(moved, next);
	for (let k = 0; k < 20; k++) await Promise.resolve();
	return probe.stop();
};

/** Which nodes each MutationObserver observes, from observe and disconnect (the platform does not say). */
const observed = new Map<MutationObserver, Set<Node>>();
const moObserve = MutationObserver.prototype.observe, moDisconnect = MutationObserver.prototype.disconnect;
MutationObserver.prototype.observe = function (this: MutationObserver, target: Node, options?: MutationObserverInit) {
	let held = observed.get(this);
	if (!held) observed.set(this, (held = new Set<Node>()));
	held.add(target);
	moObserve.call(this, target, options);
};
MutationObserver.prototype.disconnect = function (this: MutationObserver) {
	observed.delete(this);
	moDisconnect.call(this);
};
const observersOn = (node: Node) => [...observed.values()].filter((held) => held.has(node)).length;

/** Reading view, painted: the observers on its sizer, and after the teardown. */
w.sizerWatch = async (c: InkCase) => {
	const { sizer } = await readingViewOf(c);
	const watching = observersOn(sizer);
	teardownEmbedInk();
	return { watching, afterTeardown: observersOn(sizer) };
};

/**
 * Export to PDF: the print window's container, post-processed once with no section info. `late` holds the cached
 * text back for a timer; the first picture is then taken before it arrives.
 */
w.exportPrint = async (c: InkCase, late: boolean) => {
	reset();
	const print = document.body.createDiv({ cls: "print" });
	const root = print.createDiv({ cls: "markdown-preview-view markdown-rendered" });
	root.createEl("h1", { text: "Three paragraphs" });
	const blocks = new Map<number, HTMLElement>();
	for (const s of SECTIONS.slice(1)) {
		const el = root.createDiv();
		el.innerHTML = blockHtml(s.lineStart);
		blocks.set(s.lineStart, el);
	}
	await frame();
	const y = editorTop(c.line) + c.off;
	const strokes = [strokeFor(c, y)];
	initEmbedInkRefresh(() => strokes);
	initEmbedInkColumnWidth(() => 700);
	let ready = !late;
	let wake: (() => void) | null = null;
	attachEmbedInkOnceReady(root, root, "export-print.md", () => strokes, undefined, false, {
		section: () => null,
		cached: (wakeUp) => {
			if (ready) return { sections: SECTIONS, text: TEXT };
			wake = wakeUp;
			return null;
		},
	});
	await frame();
	await frame();
	const block = blocks.get(c.block)!;
	const first = blocks.get(3)!;
	let before: number | null = null;
	let pagePosition: number | null = null;
	if (late) {
		before = canvasCentre(root)?.y ?? null;
		// Before the text: the stroke's page position, from the print anchor (the first block's top).
		pagePosition = first.getBoundingClientRect().top + y;
		ready = true;
		await later(30);
		(wake as (() => void) | null)?.();
		await frame();
		await frame();
	}
	const canvas = canvasCentre(root);
	const canvasWant = wanted(c, block);
	// The print holds the container at the column's width, so the print layer is compared with the blocks after it.
	window.dispatchEvent(new Event("beforeprint"));
	await frame();
	await frame();
	const svg = svgCentre(Array.from(root.querySelectorAll<SVGSVGElement>(":scope > svg.handwriting-embed-ink")));
	const r2 = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
	return {
		canvas: r2(canvas?.y),
		canvasWant: r2(canvasWant),
		svg: r2(svg?.y),
		svgWant: r2(wanted(c, block)),
		before: r2(before),
		pagePosition: r2(pagePosition),
	};
};

/** With the print media on (the test switches it): the strips cut per block, and where the case's stroke is in them. */
w.printStrips = (c: InkCase) => {
	const root = document.querySelector<HTMLElement>(".print > .markdown-preview-view")!;
	const strips = Array.from(root.querySelectorAll<SVGSVGElement>("svg.handwriting-embed-ink-strip"));
	const blocks = Array.from(root.children).filter((el) => el.tagName === "DIV") as HTMLElement[];
	const block = blocks[SECTIONS.slice(1).findIndex((s) => s.lineStart === c.block)]!;
	const painted = svgCentre(strips);
	const want = wanted(c, block);
	return { strips: strips.length, painted: painted ? Math.round(painted.y * 100) / 100 : null, want: Math.round(want * 100) / 100 };
};

w.endPrint = async () => {
	window.dispatchEvent(new Event("afterprint"));
	await frame();
};
