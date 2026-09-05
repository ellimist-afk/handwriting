/**
 * The page half of the content-origin measurement: a real CodeMirror-shaped
 * editor subtree, rendered by a real engine, measured by the REAL
 * `contentOriginLeft` the overlay calls.
 *
 * The node half (`ContentOriginColumn.test.ts`) supplies the stylesheets and
 * holds every citation. Nothing here decides anything; it builds the DOM,
 * flips the class Obsidian's "Readable line length" flips, and reports rects.
 *
 * The element names are the ones the themes select on, and they are not
 * decorative: Minimal's column rule is
 * `.cm-contentContainer.cm-contentContainer > .cm-content > div`, so a
 * fixture that skipped `.cm-contentContainer` would be styled by nothing and
 * would measure a bug that is not there.
 */

import { contentOriginLeft } from "../../src/inline/ContentOrigin";

export interface ColumnReading {
	/** `.cm-content`'s own left - what the overlay read before 1.4.9. */
	contentLeft: number;
	/** What `contentOriginLeft` returns: the origin the camera pins to. */
	originLeft: number;
	/** Ground truth: the left edge of an ordinary line of text. */
	textLeft: number;
	/** A deliberately WIDER block (a table line), which starts further left. */
	wideLeft: number;
	/** The collapsed block marker's left - what `firstElementChild` would pick. */
	markerLeft: number;
	markerWidth: number;
	markerHeight: number;
	contentWidth: number;
	textWidth: number;
}

interface ColumnApi {
	build(): void;
	setReadable(on: boolean): void;
	setPaneWidth(px: number): void;
	read(): ColumnReading;
}

declare global {
	interface Window {
		__hwcol: ColumnApi;
	}
}

const el = (tag: string, cls: string): HTMLElement => {
	const node = document.createElement(tag);
	node.className = cls;
	return node;
};

function build(): void {
	document.body.innerHTML = "";
	// The pane. Width is set here rather than in CSS so the test can move it
	// (a sidebar opening is a pane-width change and nothing else).
	const pane = el("div", "workspace-leaf-content hw-pane");
	const view = el("div", "markdown-source-view cm-s-obsidian mod-cm6 is-readable-line-width");
	const editor = el("div", "cm-editor");
	const scroller = el("div", "cm-scroller");
	const sizer = el("div", "cm-sizer");
	const container = el("div", "cm-contentContainer");
	const content = el("div", "cm-content");
	content.id = "content";

	// HAZARD 1: a zero-height block marker, which is what the movable text
	// box work renders into `.cm-content`. Under `margin-inline: auto` it
	// still has a left edge, and that edge is NOT the column's if the element
	// has collapsed - taking `firstElementChild` lands here.
	const marker = el("div", "hw-block-marker");
	marker.id = "marker";
	// Inline, so it beats the theme's `width: var(--line-width)` - which is
	// not `!important`, unlike the `margin-inline: auto` beside it. A
	// zero-width element with auto margins centres on a POINT: its left edge
	// is the middle of the pane, nowhere near the column.
	marker.style.width = "0px";
	marker.style.height = "0px";
	content.appendChild(marker);

	// HAZARD 2: CodeMirror's own zero-size widget buffer. It is not a `div`,
	// so Minimal styles it with a different rule entirely.
	const buffer = document.createElement("img");
	buffer.className = "cm-widgetBuffer";
	buffer.setAttribute("aria-hidden", "true");
	content.appendChild(buffer);

	// HAZARD 3: a table line. Minimal widens these on purpose, so this line
	// starts further LEFT than the text column and would drag the origin out
	// with it if the measurement just took the first line it found.
	const wide = el("div", "cm-line hw-wide");
	wide.id = "wide";
	const table = document.createElement("table");
	const row = document.createElement("tr");
	const cell = document.createElement("td");
	cell.textContent = "cell";
	row.appendChild(cell);
	table.appendChild(row);
	wide.appendChild(table);
	content.appendChild(wide);

	// Ordinary text. The last one is the ground truth the assertions use.
	for (let i = 0; i < 3; i++) {
		const line = el("div", "cm-line");
		line.id = `line${i}`;
		line.textContent = "the quick brown fox jumps over the lazy dog";
		content.appendChild(line);
	}

	container.appendChild(content);
	sizer.appendChild(container);
	scroller.appendChild(sizer);
	editor.appendChild(scroller);
	view.appendChild(editor);
	pane.appendChild(view);
	document.body.appendChild(pane);
}

function setReadable(on: boolean): void {
	const view = document.querySelector(".markdown-source-view");
	if (!view) throw new Error("fixture not built");
	view.classList.toggle("is-readable-line-width", on);
}

function setPaneWidth(px: number): void {
	const pane = document.querySelector(".hw-pane");
	if (!(pane instanceof HTMLElement)) throw new Error("fixture not built");
	pane.style.width = `${px}px`;
}

function read(): ColumnReading {
	const content = document.getElementById("content");
	const text = document.getElementById("line2");
	const wide = document.getElementById("wide");
	const marker = document.getElementById("marker");
	if (!(content instanceof HTMLElement) || !text || !wide || !marker) {
		throw new Error("fixture not built");
	}
	const c = content.getBoundingClientRect();
	const t = text.getBoundingClientRect();
	const m = marker.getBoundingClientRect();
	return {
		contentLeft: c.left,
		// The real production measurement, bundled from src. This is the
		// whole point of the file: not a copy of the rule, the rule.
		originLeft: contentOriginLeft(content) ?? c.left,
		textLeft: t.left,
		wideLeft: wide.getBoundingClientRect().left,
		markerLeft: m.left,
		markerWidth: m.width,
		markerHeight: m.height,
		contentWidth: c.width,
		textWidth: t.width,
	};
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
	window.__hwcol = { build, setReadable, setPaneWidth, read };
}
