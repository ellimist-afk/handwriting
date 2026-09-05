/**
 * The page half of the RE-SYNC TRIGGER measurement.
 *
 * `ContentOriginColumn.test.ts` answered the MEASUREMENT half of Bug C: given
 * that the overlay looks, `contentOriginLeft` returns the right number under
 * Minimal. This file answers the other half: does anything the overlay
 * OBSERVES fire when Minimal moves the column, so that it looks at all?
 *
 * The technique is to install, in a real page, the same observers
 * `InkOverlay.mount()` installs, plus the candidate triggers a fix might add,
 * and then count callbacks across a perturbation. Nothing here decides
 * anything; `MinimalResync.test.ts` supplies the stylesheets, holds every
 * citation, and draws every conclusion.
 *
 * WHAT IS MIRRORED, and from where (`src/inline/InkOverlay.ts`):
 *
 *   - `resizeObserver`      -> `ResizeObserver` on `view.dom` (`.cm-editor`),
 *                              installed at InkOverlay.ts:1180-1181, callback
 *                              `handleResize()`.
 *   - `contentResizeObserver` -> `ResizeObserver` on `view.contentDOM`
 *                              (`.cm-content`), InkOverlay.ts:1182-1187,
 *                              callback `syncCamera()` + repaint.
 *   - `originLineObserver`  -> `ResizeObserver` on the element
 *                              `contentOrigin()` measured, re-armed from
 *                              `syncCamera` (`watchOriginLine`). Added in
 *                              1.4.10 because the two above are exactly the
 *                              elements Minimal holds still. Mirrored here
 *                              by asking the BUNDLED production scan which
 *                              element to watch, not by picking one by
 *                              index - so this page cannot agree with the
 *                              plugin about the trigger while disagreeing
 *                              about the element.
 *   - `metadataObserver`    -> `MutationObserver` on
 *                              `view.dom.closest(".markdown-source-view")`,
 *                              InkOverlay.ts:1341-1359, with EXACTLY
 *                              `{childList, subtree, attributes,
 *                              attributeFilter: ["data-property-key"]}`.
 *
 * WHAT IS NOT MIRRORED, and why it cannot be:
 *
 *   - The CodeMirror `ViewUpdate` hook (InkOverlay.ts:1620) and the
 *     `scrollDOM` scroll listener (InkOverlay.ts:1258). There is no
 *     CodeMirror in this page and no scrolling in these perturbations, so
 *     neither can be counted here. The test file states, per perturbation,
 *     what CodeMirror's own re-measure would have done, reading
 *     `@codemirror/view@6.38.6`'s `ViewState.measure` directly.
 *   - The resolution media query (InkOverlay.ts:1296). Nothing here changes
 *     `devicePixelRatio`.
 *   - `penDown` (InkOverlay.ts:~2452). That is the user acting, not the
 *     overlay noticing; the whole question is what happens BEFORE the user
 *     touches the pane again.
 *
 * A COUNT OF ZERO IS ONLY MEANINGFUL IF THE PLUMBING WORKS, so the test file
 * opens with a control perturbation that must fire the editor observer. If
 * `ResizeObserver` delivery or the frame budget in `settle()` were broken,
 * that control goes red rather than every scenario quietly "confirming".
 */

import { contentOrigin, contentOriginLeft } from "../../src/inline/ContentOrigin";

/** One counter per observer. Named for what installs it. */
export interface Fires {
	/** PLUGIN: ResizeObserver on `.cm-editor` (InkOverlay.ts:1180). */
	editorRO: number;
	/** PLUGIN: ResizeObserver on `.cm-content` (InkOverlay.ts:1187). */
	contentRO: number;
	/** PLUGIN: MutationObserver on `.markdown-source-view` (InkOverlay.ts:1354). */
	metadataMO: number;
	/**
	 * PLUGIN (1.4.10): ResizeObserver on the element the production origin
	 * scan picked. Distinct from `lineRO` below on purpose - that candidate
	 * watches the FIRST non-degenerate `.cm-line`, which in this fixture is
	 * the wide table, while this one watches whatever `contentOrigin` says
	 * the column is.
	 */
	originLineRO: number;
	/** CANDIDATE: ResizeObserver on the first non-degenerate `.cm-line`. */
	lineRO: number;
	/**
	 * CANDIDATE: ResizeObserver on the first ORDINARY text line. Separate
	 * from `lineRO` because this fixture's first line is the wide table
	 * hazard, and a fix that watched "the first line" would be watching that
	 * one in a note that opens with a table.
	 */
	textLineRO: number;
	/** CANDIDATE: MutationObserver on `.markdown-source-view`, class only, no subtree. */
	viewClassMO: number;
	/** CANDIDATE: MutationObserver on `document.body`, class only. */
	bodyClassMO: number;
	/** CANDIDATE: MutationObserver on `document.head`, childList + characterData. */
	headStyleMO: number;
}

export interface Box {
	left: number;
	width: number;
	height: number;
}

export interface Snapshot {
	/** The real production measurement, bundled from `src`. */
	originLeft: number;
	/**
	 * Ground truth: the left edge of an ORDINARY line of text - where the
	 * words the ink sits on actually are. Read from a plain `.cm-line`, never
	 * from the table hazard, so "the column moved" is a fact about the text
	 * rather than about whatever `contentOriginLeft` happened to pick.
	 */
	textLeft: number;
	/** The used width of that ordinary line. */
	textWidth: number;
	/** The used width of the first non-degenerate `.cm-line`, table or not. */
	firstLineWidth: number;
	/** `.cm-content`: what both plugin ResizeObservers and the old code read. */
	content: Box;
	/**
	 * `.cm-contentContainer`: the last element above `.cm-content` that fills
	 * the pane under BOTH themes. The fixture's standing precondition is
	 * asserted on this rather than on `.cm-content`, because under stock
	 * Obsidian `.cm-content` is the element that deliberately does not fill.
	 */
	container: Box;
	/** `.cm-editor`: the other plugin ResizeObserver's target. */
	editor: Box;
	scroller: Box;
	/** Precondition guard: the column chain must fill the pane in every state. */
	scrollerClientWidth: number;
}

export interface Trial {
	before: Snapshot;
	after: Snapshot;
	fired: Fires;
	/** Signed: how far the TEXT column moved. The thing a camera must track. */
	columnShift: number;
	/** Signed: how far the plugin's computed origin moved. */
	originShift: number;
	/** How far `.cm-content`'s own left moved. Pre-1.4.9's whole world. */
	contentShift: number;
	/** How much `.cm-content` changed SIZE - the only thing a RO on it sees. */
	contentResize: number;
	/** How much `.cm-editor` changed SIZE. */
	editorResize: number;
}

/**
 * The perturbations. Each is one thing a user does, spelled as the DOM change
 * that reaches the page; the test file cites the Minimal rule each one moves.
 */
export type Kind =
	/** Readable line length OFF (Obsidian setting; class on the source view). */
	| "readable-off"
	/** Readable line length ON. */
	| "readable-on"
	/** A sidebar opening/closing: the pane, and only the pane, gets narrower. */
	| "pane-width"
	/** Minimal Theme Settings line width, delivered as an inline body style. */
	| "line-width-inline"
	/** The same setting delivered the way Style Settings delivers it: a
	 *  `<style>` element appended to `document.head`. */
	| "line-width-style-tag"
	/** `cssclasses: wide` in frontmatter - Obsidian puts it on the view. */
	| "view-wide"
	/** `cssclasses: max`. */
	| "view-max"
	/** The same class on `body` instead, which is what the brief asked for. */
	| "body-wide"
	| "body-max"
	/** Editor font size (Obsidian's Appearance setting). */
	| "font-size"
	/** Minimal's focus mode, with the pane width held constant. */
	| "focus-mode";

interface ResyncApi {
	build(opts: BuildOptions): void;
	trial(kind: Kind, arg?: string | number): Promise<Trial>;
}

export interface BuildOptions {
	paneWidth: number;
	paneHeight: number;
	/**
	 * Whether the ordinary lines are long enough to REWRAP when the column
	 * width changes. This is the whole difference between a note of prose and
	 * a note of short bullets, and - as the test file shows - it decides
	 * whether `.cm-content`'s height moves, which decides whether the
	 * plugin's own `contentResizeObserver` fires at all.
	 */
	wrap: boolean;
}

declare global {
	interface Window {
		__hwsync: ResyncApi;
	}
}

const el = (tag: string, cls: string): HTMLElement => {
	const node = document.createElement(tag);
	node.className = cls;
	return node;
};

/** Short enough never to wrap at any column width this fixture uses. */
const SHORT_LINE = "ink";
/**
 * Long enough to wrap at every column width this fixture uses, on any font.
 * Built from short words so the wrap points are dense and a width change of
 * a hundred-odd px always moves at least one of them onto another row.
 */
const LONG_LINE = Array.from({ length: 120 }, (_, i) => `word${i % 10}`).join(" ");

let fires: Fires = blankFires();
const observers: { disconnect(): void }[] = [];

function blankFires(): Fires {
	return {
		editorRO: 0,
		contentRO: 0,
		metadataMO: 0,
		originLineRO: 0,
		lineRO: 0,
		textLineRO: 0,
		viewClassMO: 0,
		bodyClassMO: 0,
		headStyleMO: 0,
	};
}

function q<T extends Element = HTMLElement>(sel: string): T {
	const found = document.querySelector<T>(sel);
	if (!found) throw new Error(`fixture not built: no ${sel}`);
	return found;
}

/**
 * The first child of `.cm-content` that `contentOriginLeft` would actually
 * measure - a `.cm-line` with a non-degenerate rect. This is the element a
 * line ResizeObserver would have to watch, so the fixture picks it by the
 * same rule the production code uses rather than by index.
 */
function firstRealLine(content: HTMLElement): HTMLElement | null {
	for (const child of Array.from(content.children)) {
		if (!(child instanceof HTMLElement)) continue;
		if (!child.classList.contains("cm-line")) continue;
		const rect = child.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) continue;
		return child;
	}
	return null;
}

function build(opts: BuildOptions): void {
	for (const o of observers.splice(0)) o.disconnect();
	document.body.className = "";
	document.body.removeAttribute("style");
	for (const tag of Array.from(document.querySelectorAll("style[data-fixture-injected]"))) {
		tag.remove();
	}
	document.body.innerHTML = "";

	// The pane. Width and height are set inline rather than in CSS so a
	// perturbation can move the pane and nothing else - a sidebar opening is
	// a pane-width change and nothing more.
	const pane = el("div", "workspace-leaf-content hw-pane");
	pane.style.width = `${opts.paneWidth}px`;
	pane.style.height = `${opts.paneHeight}px`;
	const view = el("div", "markdown-source-view cm-s-obsidian mod-cm6 is-readable-line-width");
	const editor = el("div", "cm-editor");
	const scroller = el("div", "cm-scroller");
	const sizer = el("div", "cm-sizer");
	const container = el("div", "cm-contentContainer");
	// `cm-lineWrapping` is what `EditorView.lineWrapping` puts on the content
	// DOM (@codemirror/view 6.38.6, dist/index.js:8622). Obsidian's markdown
	// editor always has it on, in both wrap regimes below - what differs is
	// whether the LINES are long enough for it to bite.
	const content = el("div", "cm-content cm-lineWrapping");
	content.id = "content";

	// The same three hazards `columnPage.ts` builds, for the same reasons: a
	// zero-size block marker, CodeMirror's zero-size widget buffer, and a
	// deliberately wider table line. They are here so the origin the trigger
	// is being asked to notice is the same origin the other render test
	// measured, not a simplified one.
	const marker = el("div", "hw-block-marker");
	marker.style.width = "0px";
	marker.style.height = "0px";
	content.appendChild(marker);

	const buffer = document.createElement("img");
	buffer.className = "cm-widgetBuffer";
	buffer.setAttribute("aria-hidden", "true");
	content.appendChild(buffer);

	const wide = el("div", "cm-line hw-wide");
	const table = document.createElement("table");
	const row = document.createElement("tr");
	const cell = document.createElement("td");
	cell.textContent = "cell";
	row.appendChild(cell);
	table.appendChild(row);
	wide.appendChild(table);
	content.appendChild(wide);

	// Enough lines to overflow the pane, so `.cm-scroller` really scrolls and
	// `.cm-editor`'s height is fixed by the PANE rather than by the document.
	// Without that the editor's own height would track every rewrap and the
	// editor ResizeObserver would fire for reasons a real editor never has.
	for (let i = 0; i < 40; i++) {
		const line = el("div", "cm-line");
		line.id = `line${i}`;
		line.textContent = opts.wrap ? LONG_LINE : SHORT_LINE;
		content.appendChild(line);
	}

	container.appendChild(content);
	sizer.appendChild(container);
	scroller.appendChild(sizer);
	// The overlay's own container, placed exactly where `mount()` places it:
	// `scroller.createDiv({cls:"handwriting-ink-overlay"})`, absolutely
	// positioned at 0x0 (InkOverlay.ts:1026-1050). It is in the fixture so
	// the subtree the MutationObserver watches is the real one; being
	// absolute and zero-sized it cannot move a measurement.
	const overlay = el("div", "handwriting-ink-overlay");
	overlay.style.cssText =
		"position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none;z-index:250";
	scroller.appendChild(overlay);
	editor.appendChild(scroller);
	view.appendChild(editor);
	pane.appendChild(view);
	document.body.appendChild(pane);

	installObservers(view, editor, content);
}

function installObservers(view: HTMLElement, editor: HTMLElement, content: HTMLElement): void {
	fires = blankFires();

	// --- The three the plugin actually installs -------------------------
	const editorRO = new ResizeObserver(() => {
		fires.editorRO++;
	});
	editorRO.observe(editor);
	observers.push(editorRO);

	const contentRO = new ResizeObserver(() => {
		fires.contentRO++;
	});
	contentRO.observe(content);
	observers.push(contentRO);

	// Verbatim options from InkOverlay.ts:1354-1359. The gate on the records
	// (`isMetadataMutation`) is deliberately NOT mirrored: this counts the
	// callback arriving at all, which is the most generous possible reading
	// of "the plugin noticed". Even that count is what the test reports.
	const metadataMO = new MutationObserver(() => {
		fires.metadataMO++;
	});
	metadataMO.observe(view, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["data-property-key"],
	});
	observers.push(metadataMO);

	// The 1.4.10 trigger. The TARGET comes from the bundled production scan,
	// so deleting `contentOrigin`'s element half from `src` breaks this page
	// rather than quietly leaving the fixture watching the right line by
	// coincidence. Production re-arms this from `syncCamera` because
	// CodeMirror recycles line divs; nothing in these perturbations edits the
	// document, so one arming is the whole of it here.
	const picked = contentOrigin(content).line;
	if (picked) {
		const originLineRO = new ResizeObserver(() => {
			fires.originLineRO++;
		});
		originLineRO.observe(picked);
		observers.push(originLineRO);
	}

	// --- Candidate triggers a fix might add -----------------------------
	const line = firstRealLine(content);
	if (line) {
		const lineRO = new ResizeObserver(() => {
			fires.lineRO++;
		});
		lineRO.observe(line);
		observers.push(lineRO);
	}

	const textLineRO = new ResizeObserver(() => {
		fires.textLineRO++;
	});
	textLineRO.observe(q("#line0"));
	observers.push(textLineRO);

	const viewClassMO = new MutationObserver(() => {
		fires.viewClassMO++;
	});
	// No `subtree`: CodeMirror toggles `cm-activeLine` on every cursor move,
	// so a subtree class observer would be a per-keystroke callback whose
	// record array grows with the edit. This one sees the view element only.
	viewClassMO.observe(view, { attributes: true, attributeFilter: ["class"] });
	observers.push(viewClassMO);

	const bodyClassMO = new MutationObserver(() => {
		fires.bodyClassMO++;
	});
	bodyClassMO.observe(document.body, { attributes: true, attributeFilter: ["class"] });
	observers.push(bodyClassMO);

	const headStyleMO = new MutationObserver(() => {
		fires.headStyleMO++;
	});
	headStyleMO.observe(document.head, {
		childList: true,
		subtree: true,
		characterData: true,
	});
	observers.push(headStyleMO);
}

/**
 * Four animation frames, with a wall-clock fallback so a throttled rAF cannot
 * hang the suite. `ResizeObserver` callbacks are delivered after the
 * `requestAnimationFrame` callbacks of the frame in which the layout changed,
 * and `MutationObserver` callbacks are microtasks, so four frames clears both
 * with room to spare. The fallback resolving first would show up as the
 * control test going red, which is what that test is for.
 */
const SETTLE_FRAMES = 4;

function settle(): Promise<void> {
	return new Promise<void>((resolve) => {
		let n = 0;
		const tick = (): void => {
			if (++n >= SETTLE_FRAMES) {
				resolve();
				return;
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
		// HANG GUARD ONLY, deliberately far longer than four frames. It was
		// 400ms once, and that was a bug: on a freshly created page Chromium
		// does not run `requestAnimationFrame` until the first paint, so the
		// timer won the race, the counters were zeroed BEFORE the observers'
		// initial callbacks were delivered, and the first trial of each page
		// reported those initial callbacks as a reaction to the perturbation.
		// It read as `.cm-editor` and `.cm-content` "noticing" a change that
		// left both of them exactly the same size.
		window.setTimeout(resolve, 5000);
	});
}

function box(node: Element): Box {
	const rect = node.getBoundingClientRect();
	return { left: rect.left, width: rect.width, height: rect.height };
}

function snapshot(): Snapshot {
	const content = q("#content");
	const editor = q(".cm-editor");
	const scroller = q(".cm-scroller");
	const first = firstRealLine(content);
	if (!first) throw new Error("fixture has no measurable line");
	const textRect = q("#line0").getBoundingClientRect();
	return {
		originLeft: contentOriginLeft(content) ?? content.getBoundingClientRect().left,
		textLeft: textRect.left,
		textWidth: textRect.width,
		firstLineWidth: first.getBoundingClientRect().width,
		content: box(content),
		container: box(q(".cm-contentContainer")),
		editor: box(editor),
		scroller: box(scroller),
		scrollerClientWidth: scroller.clientWidth,
	};
}

function injectStyle(css: string): void {
	const tag = document.createElement("style");
	tag.setAttribute("data-fixture-injected", "");
	tag.textContent = css;
	document.head.appendChild(tag);
}

function perturb(kind: Kind, arg?: string | number): void {
	const view = q(".markdown-source-view");
	switch (kind) {
		case "readable-off":
			view.classList.remove("is-readable-line-width");
			return;
		case "readable-on":
			view.classList.add("is-readable-line-width");
			return;
		case "pane-width":
			q(".hw-pane").style.width = `${Number(arg)}px`;
			return;
		case "line-width-inline":
			document.body.style.setProperty("--line-width", String(arg));
			return;
		case "line-width-style-tag":
			injectStyle(`body { --line-width: ${String(arg)}; }`);
			return;
		case "view-wide":
			view.classList.add("wide");
			return;
		case "view-max":
			view.classList.add("max");
			return;
		case "body-wide":
			document.body.classList.add("wide");
			return;
		case "body-max":
			document.body.classList.add("max");
			return;
		case "font-size":
			// Obsidian's Appearance > Font size. The rule that applies it to
			// the editor lives in app.css, which is not on disk here, so the
			// fixture sets the resolved property on the same element that
			// rule targets and lets it inherit down to the lines.
			view.style.fontSize = String(arg);
			return;
		case "focus-mode":
			document.body.classList.add("minimal-focus-mode");
			return;
	}
}

async function trial(kind: Kind, arg?: string | number): Promise<Trial> {
	// Settle FIRST, then zero the counters: `ResizeObserver` delivers one
	// callback per target on the frame after `observe()`, and counting those
	// as a reaction to the perturbation would make every scenario look
	// covered. Twice, because the first one on a brand-new page can resolve
	// off the hang guard rather than off a real frame; the second is then
	// guaranteed to be four real frames of quiet.
	await settle();
	await settle();
	const before = snapshot();
	fires = blankFires();

	perturb(kind, arg);
	await settle();
	const after = snapshot();

	return {
		before,
		after,
		fired: { ...fires },
		columnShift: after.textLeft - before.textLeft,
		originShift: after.originLeft - before.originLeft,
		contentShift: Math.abs(after.content.left - before.content.left),
		contentResize:
			Math.abs(after.content.width - before.content.width) +
			Math.abs(after.content.height - before.content.height),
		editorResize:
			Math.abs(after.editor.width - before.editor.width) +
			Math.abs(after.editor.height - before.editor.height),
	};
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
	window.__hwsync = { build, trial };
}
