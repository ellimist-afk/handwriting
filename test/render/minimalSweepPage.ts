/**
 * The page half of the Minimal settings sweep: a CodeMirror-shaped editor
 * subtree plus the plugin's own overlay container, rendered by a real engine
 * and measured by the REAL `contentOriginLeft` and the REAL `effectiveScale`.
 *
 * The node half (`MinimalSettingsSweep.test.ts`) supplies the stylesheets and
 * holds every theme.css citation. Nothing here decides anything: it builds the
 * DOM, applies one configuration, and reports rects.
 *
 * WHY THE ELEMENT NAMES MATTER. Minimal's column rule is
 * `.cm-contentContainer.cm-contentContainer > .cm-content > div` and its block
 * rules are `> .cm-content > div:has(table)` and `> .cm-content >
 * div:has(.image-embed)`. A fixture that skipped `.cm-contentContainer`, or
 * that hung the image inside something other than a direct `div` child, would
 * be styled by nothing and would measure a bug that is not there.
 *
 * WHY THE OVERLAY IS INSIDE `.cm-scroller`. That is where `InkOverlay.mount`
 * puts it (`InkOverlay.ts:1026`, `scroller.createDiv({ cls:
 * "handwriting-ink-overlay" })`). Being inside the editor is load-bearing for
 * the scale: a CSS transform on `.cm-editor` scales the overlay's visual rect
 * and not its `offsetWidth`, which is exactly the ratio `effectiveScale`
 * measures. An overlay hung outside the transformed element would report 1.
 */

import { contentOriginLeft } from "../../src/inline/ContentOrigin";
import { effectiveScale } from "../../src/inline/ZoomScale";

/**
 * Which document the fixture builds.
 *
 * `prose` is an ordinary note: one wide table line, one wide image line, and
 * ordinary text lines, all inside the 12-child scan window.
 *
 * The two `gallery-*` shapes are the hazard: TWELVE consecutive wide block
 * lines, so the scan window (`ContentOrigin.ts#SCAN_LIMIT`, 12) closes before
 * any ordinary text line is reached. CodeMirror renders the viewport plus a
 * margin, so `contentDOM.children` is the rendered range and this is what a
 * gallery note looks like from inside `contentOriginLeft` once it is scrolled
 * into a run of embeds.
 *
 * `gallery-mixed` is the control for those two: six wide lines then text, all
 * within the window, which is the case the maximum-over-candidates rule was
 * written for.
 *
 * `inline-img` is the opposite hazard, and it is one the block-widget probe
 * created: ordinary text lines that each hold an INLINE image embed. Their
 * left edge is the column's, a subtree probe rejects them all, and phase B
 * then measures the wide table line sitting right of the text.
 */
export type Shape =
	| "prose"
	| "gallery-img"
	| "gallery-table"
	| "gallery-mixed"
	| "inline-img";

export interface SweepConfig {
	shape: Shape;
	/** `--line-width` on `body` (theme.css:53 ships `40rem`). */
	lineWidth: string;
	/** `--max-width` on `body` (theme.css:56 ships `88%`). */
	maxWidth: string;
	/**
	 * Classes on `.markdown-source-view`. This is where Obsidian puts a note's
	 * `cssclasses` frontmatter, and it is the only place Minimal's `body .wide`
	 * / `body .max` helpers can match - they are DESCENDANT selectors
	 * (theme.css:1951, 1960), so a class on `body` itself matches neither.
	 */
	viewClasses: string[];
	/** Classes on `body`: the Minimal Settings global toggles. */
	bodyClasses: string[];
	paneWidth: number;
	/** `font-size` on `.cm-content` - Obsidian's quick font size adjustment. */
	fontSize: string;
	/** Whether Obsidian's "Readable line length" class is on. */
	readable: boolean;
	/** A CSS transform scale on `.cm-editor`: the pinch/zoom-plugin case. */
	editorScale: number;
}

export interface Reading {
	/** `.cm-content`'s own left - what the overlay read before 1.4.9. */
	contentLeft: number;
	contentWidth: number;
	/** What `contentOriginLeft` returns: the origin the camera pins to. */
	originLeft: number;
	/** Ground truth: the left edge of an ordinary, non-wrapping text line. */
	textLeft: number;
	textWidth: number;
	/** A word inside that line. Its offset from `textLeft` must not move. */
	wordLeft: number;
	/** The wide table line's left, or null when the shape has none. */
	tableLeft: number | null;
	/** The wide image line's left, or null when the shape has none. */
	imgLeft: number | null;
	overlayLeft: number;
	overlayVisualWidth: number;
	overlayLayoutWidth: number;
	/** The REAL `effectiveScale`, from the same two reads `syncCamera` uses. */
	cssScale: number;
	/** Resolved `font-size` of `.cm-content`, in px. */
	fontPx: number;
	/** How many children the scan actually saw, and how many were `.cm-line`. */
	childCount: number;
	scannedLines: number;
}

interface SweepApi {
	apply(cfg: SweepConfig): Reading;
}

declare global {
	interface Window {
		__hwmin: SweepApi;
	}
}

const el = (tag: string, cls: string): HTMLElement => {
	const node = document.createElement(tag);
	node.className = cls;
	return node;
};

/** An ordinary line of text. Short on purpose - see `textLine`. */
function textLine(id: string): HTMLElement {
	const line = el("div", "cm-line");
	line.id = id;
	// SHORT, and deliberately so. The painted-x check has to isolate the
	// ORIGIN from reflow: if the line wrapped differently in the two states
	// the word would move for a reason that has nothing to do with the
	// camera. Twenty-odd characters fits the narrowest column in the sweep
	// (30rem) at any font in the range, and the test asserts the word's
	// offset within the line is unchanged rather than assuming it.
	line.append(document.createTextNode("ab cd "));
	const word = el("span", "hw-word");
	word.id = id === "text" ? "word" : `${id}-word`;
	word.textContent = "ef";
	line.appendChild(word);
	return line;
}

/** A line holding a block image embed: `div:has(.image-embed)`, theme.css:2225. */
function imageLine(id: string): HTMLElement {
	const line = el("div", "cm-line");
	line.id = id;
	const embed = el("div", "internal-embed image-embed");
	line.appendChild(embed);
	return line;
}

/**
 * An ORDINARY line that happens to contain an inline image embed.
 *
 * `text ![[img.png]] text` renders `span.internal-embed.image-embed` in the
 * middle of the line - a span, where a block embed on its own line is a div.
 * The line around it is text and its left edge IS the column's, which is what
 * makes rejecting it a defect rather than a conservative choice.
 *
 * The theme still sees it: `div:has(.image-embed)` (theme.css:2225) matches a
 * descendant, so this line is sized from `--container-img-width` - which
 * defaults to `--line-width`, so under every helper but the `img-*` family it
 * lands exactly on the column. That is the configuration this shape is for.
 */
function inlineImageLine(id: string): HTMLElement {
	const line = textLine(id);
	const embed = el("span", "internal-embed image-embed is-loaded");
	line.appendChild(embed);
	return line;
}

/** A line holding a table: `div:has(table)`, theme.css:2172. */
function tableLine(id: string): HTMLElement {
	const line = el("div", "cm-line");
	line.id = id;
	const table = document.createElement("table");
	const row = document.createElement("tr");
	const cell = document.createElement("td");
	cell.textContent = "cell";
	row.appendChild(cell);
	table.appendChild(row);
	line.appendChild(table);
	return line;
}

let built: Shape | null = null;

function build(shape: Shape): void {
	document.body.innerHTML = "";
	const pane = el("div", "workspace-leaf-content hw-pane");
	const view = el("div", "markdown-source-view cm-s-obsidian mod-cm6");
	view.id = "view";
	const editor = el("div", "cm-editor");
	editor.id = "editor";
	const scroller = el("div", "cm-scroller");
	const sizer = el("div", "cm-sizer");
	const container = el("div", "cm-contentContainer");
	const content = el("div", "cm-content");
	content.id = "content";

	// The overlay the camera measures itself against. Inside `.cm-scroller`,
	// as `InkOverlay.mount` puts it.
	const overlay = el("div", "handwriting-ink-overlay");
	overlay.id = "overlay";

	if (shape === "prose") {
		// HAZARD 1: a zero-height block marker - what the movable text box
		// work renders into `.cm-content`. Under `margin-inline: auto` a
		// zero-size element centres on a POINT, so its left edge is half a
		// pane away from the column. It still consumes one of the 12 scan
		// slots, which is why it is here rather than assumed away.
		const marker = el("div", "hw-block-marker");
		marker.id = "marker";
		marker.style.width = "0px";
		marker.style.height = "0px";
		content.appendChild(marker);

		// HAZARD 2: CodeMirror's own zero-size widget buffer. Not a `div`, so
		// Minimal styles it with the `*:not(div)` arm (theme.css:1869).
		const buffer = document.createElement("img");
		buffer.className = "cm-widgetBuffer";
		buffer.setAttribute("aria-hidden", "true");
		content.appendChild(buffer);

		content.appendChild(tableLine("table"));
		content.appendChild(imageLine("img"));
		content.appendChild(textLine("text"));
		for (let i = 0; i < 4; i++) content.appendChild(textLine(`t${i}`));
	} else if (shape === "inline-img") {
		// A wide table line FIRST, then twelve ordinary lines each carrying an
		// inline image embed. Every line phase A samples holds an
		// `.image-embed` somewhere in its subtree, so a probe that walks the
		// subtree rejects all thirteen and hands the answer to phase B - which
		// measures the leading children of any kind, and the table line is the
		// first of them. Under `cssclasses: wide` that is +71.5px right of the
		// text: the exact defect the block-widget probe was added to prevent,
		// reintroduced by the probe itself.
		content.appendChild(tableLine("table"));
		content.appendChild(inlineImageLine("text"));
		for (let i = 0; i < 11; i++) content.appendChild(inlineImageLine(`ii${i}`));
	} else if (shape === "gallery-mixed") {
		for (let i = 0; i < 6; i++) content.appendChild(imageLine(`img${i}`));
		content.appendChild(imageLine("img"));
		content.appendChild(textLine("text"));
		for (let i = 0; i < 4; i++) content.appendChild(textLine(`t${i}`));
	} else {
		const make = shape === "gallery-img" ? imageLine : tableLine;
		// Exactly SCAN_LIMIT of them, so the window closes before the text.
		for (let i = 0; i < 12; i++) content.appendChild(make(`w${i}`));
		content.appendChild(shape === "gallery-img" ? imageLine("img") : tableLine("table"));
		content.appendChild(textLine("text"));
		for (let i = 0; i < 4; i++) content.appendChild(textLine(`t${i}`));
	}

	container.appendChild(content);
	sizer.appendChild(container);
	scroller.appendChild(sizer);
	scroller.appendChild(overlay);
	editor.appendChild(scroller);
	view.appendChild(editor);
	pane.appendChild(view);
	document.body.appendChild(pane);
	built = shape;
}

function need(id: string): HTMLElement {
	const node = document.getElementById(id);
	if (!(node instanceof HTMLElement)) throw new Error(`fixture missing #${id}`);
	return node;
}

function apply(cfg: SweepConfig): Reading {
	if (built !== cfg.shape) build(cfg.shape);

	const body = document.body;
	const view = need("view");
	const pane = document.querySelector(".hw-pane");
	if (!(pane instanceof HTMLElement)) throw new Error("fixture not built");

	body.className = cfg.bodyClasses.join(" ");
	body.style.setProperty("--line-width", cfg.lineWidth);
	body.style.setProperty("--max-width", cfg.maxWidth);

	view.className = [
		"markdown-source-view",
		"cm-s-obsidian",
		"mod-cm6",
		...(cfg.readable ? ["is-readable-line-width"] : []),
		...cfg.viewClasses,
	].join(" ");

	pane.style.width = `${cfg.paneWidth}px`;
	const content = need("content");
	content.style.fontSize = cfg.fontSize;
	const editor = need("editor");
	editor.style.transform = cfg.editorScale === 1 ? "" : `scale(${cfg.editorScale})`;
	editor.style.transformOrigin = "top left";

	// Force layout before every read, so nothing below can be served a stale
	// box left over from the previous configuration in the sweep.
	void content.offsetWidth;

	const c = content.getBoundingClientRect();
	const text = need("text").getBoundingClientRect();
	const word = need("word").getBoundingClientRect();
	const overlay = need("overlay");
	const o = overlay.getBoundingClientRect();
	const table = document.getElementById("table");
	const img = document.getElementById("img");

	let scannedLines = 0;
	const limit = Math.min(content.children.length, 12);
	for (let i = 0; i < limit; i++) {
		const child = content.children[i];
		if (!child) continue;
		const r = child.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) continue;
		if (child.classList.contains("cm-line")) scannedLines++;
	}

	return {
		contentLeft: c.left,
		contentWidth: c.width,
		// The real production measurement, bundled from src.
		originLeft: contentOriginLeft(content) ?? c.left,
		textLeft: text.left,
		textWidth: text.width,
		wordLeft: word.left,
		tableLeft: table ? table.getBoundingClientRect().left : null,
		imgLeft: img ? img.getBoundingClientRect().left : null,
		overlayLeft: o.left,
		overlayVisualWidth: o.width,
		overlayLayoutWidth: overlay.offsetWidth,
		// The real production scale, from the same two reads `syncCamera`
		// makes of the same element (`InkOverlay.ts:1996-2000`). `cmScaleX` is
		// left undefined: there is no CodeMirror here, and the fallback only
		// fires when the element has no layout width at all.
		cssScale: effectiveScale({
			visualWidth: o.width,
			layoutWidth: overlay.offsetWidth,
		}),
		fontPx: Number.parseFloat(getComputedStyle(content).fontSize),
		childCount: content.children.length,
		scannedLines,
	};
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
	window.__hwmin = { apply };
}
