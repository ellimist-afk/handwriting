/**
 * Ink in a phone or tablet Export to PDF.
 *
 * The mobile app's export (Obsidian 1.15.1, printToPdfMobile) fires no print event. It renders the note into
 * `body > div.print`, awaits print() (which awaits every post-processor's returned promise), sets that div's zoom to the
 * dialog's downscale, waits 200 ms and hands the native side one HTML string: the head, and the div cloned deep. A canvas
 * carries no pixels through that string, so here the ink is built as svg the moment the zoom is written, and cut at once
 * into one strip per block: the native side pages the layout itself, after the string is taken, and no print-media call
 * follows to cut it then. Everything the build leaves is DOM with inline styles or the plugin's classes, which the cloned
 * head styles.
 *
 * Armed by `armPrintSwap` on the mobile app only: one observer on the body for an export div that comes or goes, and on
 * each such div its zoom being written (the render is done) builds every root inside it, and a canvas added inside it
 * after the zoom (an attach that came late) builds that canvas's root. Desktop arms none of it.
 */
import { Platform } from "obsidian";
import { timerHost } from "../util/RuntimeScheduler";
import { embedInkRootIsEmbed, layers, sweepDisconnected } from "./EmbedInk";
import { countPrintSwap, isPrintContainer, printVectorFor } from "./EmbedInkPrint";

/** The screen's canvas; one added inside an export div after its zoom is an attach that came late. */
const CANVAS_SEL = "canvas.handwriting-embed-ink";

/**
 * How long an export waits for an embedded note's ink to load, ms. Obsidian's own wait for an image in the same export
 * gives up after 5 s (app.js 1.15.1 @765127); a note whose ink takes longer prints without it rather than holding the PDF.
 */
export const MOBILE_EXPORT_WAIT_MS = 5000;

/** Whether a node is an export div: a `div.print` right inside its document's body. */
function isExportDiv(node: Node | null | undefined, body: HTMLElement): node is HTMLElement {
	const el = node as HTMLElement | null | undefined;
	return !!el && el.parentElement === body && el.tagName === "DIV" && el.classList?.contains("print") === true;
}

/** The export div an element sits in, on desktop and mobile alike: its closest `.print`, when that is an export div. */
export function exportDivOf(el: Element): HTMLElement | null {
	const div = el.closest?.(".print");
	const body = el.ownerDocument?.body;
	return body && isExportDiv(div, body) ? div : null;
}

/** The export div an element sits in, on the mobile app; null on desktop and outside one. */
export function mobileExportDiv(el: Element): HTMLElement | null {
	if (!Platform.isMobileApp) return null;
	return exportDivOf(el);
}

/**
 * The post-processor's answer for a section whose note's ink is still loading: on the mobile app, for a section inside an
 * export div, a wait print() awaits, so the ink is attached before the zoom and the clone. It settles once `loading` has,
 * never rejects (a failed load is no ink for that note, not a failed export), and gives up at `MOBILE_EXPORT_WAIT_MS`.
 * Undefined everywhere else, as before.
 */
export function mobileExportWait(el: HTMLElement, loading: Promise<unknown>): Promise<void> | undefined {
	if (!mobileExportDiv(el)) return undefined;
	const host = timerHost(el.ownerDocument?.defaultView);
	return new Promise<void>((resolve) => {
		const cap = host.setTimeout(() => resolve(), MOBILE_EXPORT_WAIT_MS);
		const done = () => {
			host.clearTimeout(cap);
			resolve();
		};
		loading.then(done, done);
	});
}

/** An export root: Obsidian's print container right inside the export div. Its ink is cut into strips. */
function isExportRoot(root: HTMLElement, div: HTMLElement): boolean {
	return root.parentElement === div && isPrintContainer(root);
}

/** Export roots whose padding is pinned. The roots are the export's own and leave with its div, so a pin is never undone. */
const pinned = new WeakSet<HTMLElement>();

/**
 * Pin an export root's side and top padding inline at the px the screen gives it, before the print layout is held. The
 * app's print rule gives `body.is-mobile > .print` its own --file-margins, so in the native print the text would sit at
 * another inset than the one the ink was placed against; inline values survive the clone and win over that rule. Before
 * `holdPrintLayout` reads them, so a reach that pads the root and then goes puts the pinned px back.
 */
function pinPadding(root: HTMLElement): void {
	if (pinned.has(root)) return;
	const style = root.ownerDocument?.defaultView?.getComputedStyle?.(root);
	if (!style) return;
	pinned.add(root);
	root.style.paddingLeft = style.paddingLeft;
	root.style.paddingRight = style.paddingRight;
	root.style.paddingTop = style.paddingTop;
}

/** Embed views whose box is pinned. Like the export roots, they are the export's own and leave with its div. */
const pinnedViews = new WeakSet<HTMLElement>();

/**
 * Pin an inked embed's view as the export lays it out: its four paddings and its width, inline. The native side parses
 * the export's HTML string again. An embed's span sits in its line's paragraph, and a div start tag closes an open p,
 * so after that parse the embed's content box is no longer inside the span. The app's embed rules stop matching its
 * view (`.inline-embed > .markdown-embed-content > .markdown-preview-view`, --embed-padding), and it takes
 * `.markdown-preview-view`'s --file-margins, 32 px on every side in a mobile print. The ink was placed against the
 * screen's padding (24 px left, 0 above), so it printed about 8 px left of its words and 32 px above them. The text
 * column also lost 40 px, so a line that wraps on screen could wrap elsewhere, out from under its ink. Inline values
 * survive the string and win over those rules.
 *
 * The width is held as a max-width at the view's computed width, in the view's own box model, so no box-sizing is
 * written. Outside the span the content box loses the span's border and grows by it, and the cap keeps every line
 * wrapping where it wraps on screen.
 *
 * An embed that holds the inked one falls out of its own span in the same parse, and its 32 px would narrow the inked
 * embed's column. So the walk goes from the root up to the export div and pins every embed's view on the way, the inked
 * one's first.
 *
 * Only from a root that is an embed's content box and whose build drew ink (its vector layer stands): an embed with no
 * ink anywhere inside it prints as Obsidian prints it. A view that is not laid out (a hidden embed) is left alone. Once
 * per view, after the export root's build in the same pass has laid its container out at the column width, so the width
 * read is the one the native side gets.
 */
function pinEmbedView(root: HTMLElement, div: HTMLElement): void {
	if (!embedInkRootIsEmbed(root) || !root.querySelector(":scope > svg.handwriting-embed-ink")) return;
	for (let box: HTMLElement | null = root; box && box !== div; box = box.parentElement) {
		if (embedInkRootIsEmbed(box)) pinView(box.querySelector<HTMLElement>(":scope > .markdown-preview-view"));
	}
}

/** One embed view's paddings and width, inline at their computed values (see `pinEmbedView`). */
function pinView(view: HTMLElement | null): void {
	if (!view || pinnedViews.has(view)) return;
	const style = view.ownerDocument?.defaultView?.getComputedStyle?.(view);
	if (!style || !(Number.parseFloat(style.width) > 0)) return;
	pinnedViews.add(view);
	view.style.paddingTop = style.paddingTop;
	view.style.paddingRight = style.paddingRight;
	view.style.paddingBottom = style.paddingBottom;
	view.style.paddingLeft = style.paddingLeft;
	view.style.maxWidth = style.width;
}

/** The export root's strips: each one stands in the block whose ink it is (`buildPrintStrips` appends it there). */
const HOST_STRIP_SEL = ":scope > * > svg.handwriting-embed-ink-strip";

/** An embed's span, of every kind: Obsidian's internal embeds (a note, a PDF, a Canvas, a Bases view, a picture) and the inline note embeds. */
const EMBED_SEL = ".internal-embed, .inline-embed";

/**
 * The elements whose start tag makes the HTML parser close an open p (the body's "close a p element" when a p is in button
 * scope; a table too, the string's doctype being no-quirks). One anywhere inside an embed's span breaks that span's line in
 * the native parse. A picture's img, a video or an audio is none of them, so a line of pictures stays a p.
 */
const P_CLOSER_SEL = [
	"address", "article", "aside", "blockquote", "center", "details", "dialog", "dir", "div", "dl", "dd", "dt", "fieldset",
	"figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "listing",
	"main", "menu", "nav", "ol", "p", "plaintext", "pre", "search", "section", "summary", "table", "ul", "xmp",
].join(", ");

/** Lines written as divs by `holdHostLines`. Like the pins, the export's own; they leave with its div. */
const heldLines = new WeakSet<Element>();

/**
 * Whether `el` is a line `holdHostLines` wrote as a div in a paragraph's place. The measure reads such a div's rows as
 * the paragraph's (`rowsOf`), so a later build of its root (the late look's, a layer watch's replace) still places ink
 * on the paragraph's later lines by their rows. Known by identity only: a div the hold did not write, whatever its look,
 * is not one.
 */
export function isHeldLine(el: Element | null | undefined): boolean {
	return !!el && heldLines.has(el);
}

/** Paragraphs a hold has taken, written or not: none is taken twice, so a late look never comes back to one. */
const takenLines = new WeakSet<Element>();

/**
 * The paragraphs `holdHostLines` holds in an export root: in each block that holds one of its strips, the parent p of
 * each embed span that holds an element the parser closes a p at, whether the embed has ink of its own or not. Every
 * such span in the block, nested ones too, since the host's strip is the block's and its ink can sit on any word in it.
 */
function linesToHold(root: HTMLElement): HTMLElement[] {
	const out = new Set<HTMLElement>();
	for (const strip of Array.from(root.querySelectorAll(HOST_STRIP_SEL))) {
		const block = strip.parentElement;
		if (!block) continue;
		for (const span of Array.from(block.querySelectorAll<HTMLElement>(EMBED_SEL))) {
			if (!span.querySelector(P_CLOSER_SEL)) continue;
			const line = span.parentElement;
			if (line && line.tagName === "P" && !takenLines.has(line)) out.add(line);
		}
	}
	return [...out];
}

/**
 * Hold the host's own ink in a block with an embed in it. The native side parses the export's HTML string again, and a
 * div start tag (or a list's, a rule's, any the parser closes a p at) closes an open p: an embed's span sits in its
 * line's paragraph, so after that parse the span's content stands outside it. A note embed's content box falls below its
 * title and the emptied paragraphs and takes the print's --file-margins; a PDF's viewer, a Canvas board, a Bases view
 * fall out loose in the block. The host's ink sits in the host block's strip, so the embed's words moved out from under
 * it (about 8 px left and 40 px up on a phone or tablet for a note embed with no ink, 8 px down for one with ink, whose
 * view is pinned), and so did the host's words after the embed in the same block (8 to 160 px and more). An inked
 * embed's own ink sits in its own content box and moves with its words.
 *
 * So each paragraph `linesToHold` names is written as a div with the paragraph's margins inline: that line then parses
 * back as the page holds it, the span keeps its content, and the app's embed rules keep matching. Nothing in a block
 * with no host ink: there an embed prints as Obsidian prints it, and an inked embed's view pin (`pinEmbedView`) holds
 * its ink on its words. Once per paragraph, after the export root's build has cut its strips, so the strips are the
 * ones the native side gets.
 */
function holdHostLines(root: HTMLElement): void {
	for (const line of linesToHold(root)) holdLine(line);
}

/** One paragraph as a div: its attributes, its margins inline at their computed values, its children moved over. */
function holdLine(line: HTMLElement): void {
	takenLines.add(line);
	const style = line.ownerDocument?.defaultView?.getComputedStyle?.(line);
	if (!style) return;
	// Obsidian's own DOM helper, not the raw DOM call the plugin checker refuses (DocumentAnchor makeRung's shape); the
	// render harness installs the same global. The div takes the line's place in the line's own document.
	const div = createDiv();
	for (const attr of Array.from(line.attributes)) div.setAttribute(attr.name, attr.value);
	div.style.marginTop = style.marginTop;
	div.style.marginBottom = style.marginBottom;
	heldLines.add(div);
	while (line.firstChild) div.appendChild(line.firstChild);
	line.replaceWith(div);
}

/** Run `fn` with the export div's zoom off, then put the zoom back, also after a throw. */
function unzoomed(div: HTMLElement, fn: () => void): void {
	const zoom = div.style.zoom;
	if (zoom) div.style.removeProperty("zoom");
	try {
		fn();
	} finally {
		if (zoom) div.style.zoom = zoom;
	}
}

/**
 * Each export root's children's tops against its own, px with the zoom off, as they stood when its strips were last cut
 * (read after the cut, before its lines are held). A late change that moves one leaves strips cut against another page.
 */
const cutTops = new WeakMap<HTMLElement, number[]>();

/** How far a child's top may move after the cut and the strips still hold, px: the pass bar of a strip on its words. */
const TOP_MOVE_PX = 0.5;

/** The tops of an export root's children against the root's own top, px, as laid out now. */
function childTops(root: HTMLElement): number[] {
	const top = root.getBoundingClientRect().top;
	return Array.from(root.children, (child) => child.getBoundingClientRect().top - top);
}

/** Note an export root's layout as its strips were cut, before its lines are held (see `cutTops`). */
function noteCut(root: HTMLElement): void {
	cutTops.set(root, childTops(root));
}

/**
 * Whether an export root's strips were cut against a page it no longer holds: a line to hold has come in (an embed's
 * content entered its span after the hold), or a child of the root stands at another top than at the cut (content that
 * entered took height). A root never cut here is not stale. Read with the zoom off, as `noteCut` read.
 */
function stripsStale(root: HTMLElement): boolean {
	const was = cutTops.get(root);
	if (!was) return false;
	if (linesToHold(root).length > 0) return true;
	const now = childTops(root);
	return now.length !== was.length || now.some((top, i) => Math.abs(top - (was[i] ?? top)) > TOP_MOVE_PX);
}

/** The plugin's own nodes in an export: its ink layers, strips and canvases. Nodes added in them are its own build's. */
const OWN_NODE_SEL = "svg.handwriting-embed-ink, svg.handwriting-embed-ink-strip, canvas.handwriting-embed-ink";

/** Whether an added node is a late entry in the export div: in it, and not one of the plugin's own nodes or inside one. */
function lateEntry(node: Node, div: HTMLElement): boolean {
	if (!div.contains(node)) return false;
	const el = (node.nodeType === 1 ? node : node.parentNode) as Element | null;
	return !el || typeof el.closest !== "function" || el.closest(OWN_NODE_SEL) === null;
}

/** Add to `out` each export root in the export div whose strips are stale (`stripsStale`), read with the zoom off. */
function staleRoots(div: HTMLElement, out: Set<HTMLElement>): void {
	try {
		unzoomed(div, () => {
			for (const root of layers.keys()) {
				if (!out.has(root) && isExportRoot(root, div) && stripsStale(root)) out.add(root);
			}
		});
	} catch (error) {
		console.error("[handwriting] look again at a phone or tablet export", error);
	}
}

/**
 * Build one root's ink inside an export div: the old layer cleared, the padding pinned, the desktop's screen call, and the
 * strips cut at once (`printVectorFor` with the cut). The div's zoom is off for the build, so offsets are read unzoomed as
 * the desktop's screen call reads them, and goes back in a finally: a throw mid-build must not leave the page the native
 * side gets at the wrong scale.
 *
 * `pinView`: an embed's view is pinned here, and the export root's lines over embeds held (`holdHostLines`), when
 * a build comes after the export's zoom (a repaint). Then the layout is the one the native side gets. `buildInside`
 * passes false and pins and holds once all of its roots are built.
 */
export function buildMobileExport(root: HTMLElement, path: string, div: HTMLElement, pinView = true): void {
	const zoomed = div.style.zoom !== "";
	unzoomed(div, () => {
		printVectorFor(root, path, false);
		const outer = isExportRoot(root, div);
		if (outer) pinPadding(root);
		printVectorFor(root, path, true, true);
		if (pinView && zoomed) {
			if (outer) {
				noteCut(root);
				holdHostLines(root);
			} else pinEmbedView(root, div);
		}
	});
}

/** One watched export div: the zoom its roots were last built at ("" before any). */
interface ExportWatch {
	zoom: string;
	observers: MutationObserver[];
}

/**
 * Build the roots inside an export div (only those in `only`, when given): the roots of embedded notes first, then the
 * export root, whose blocks are measured for its strips once the ink inside them stands. Then each embed's view is
 * pinned (`pinEmbedView`), once the export root's build has laid the container out. The pin changes no layout on this
 * page, so the strips stay true. One print swap per build that found a root. A root whose build throws is logged and the
 * others still build.
 */
function buildInside(div: HTMLElement, only: Set<HTMLElement> | null): void {
	if (!Platform.isMobileApp) return;
	sweepDisconnected();
	const inner: Array<[HTMLElement, string]> = [];
	const outer: Array<[HTMLElement, string]> = [];
	for (const [root, path] of layers) {
		if (!div.contains(root) || (only !== null && !only.has(root))) continue;
		(isExportRoot(root, div) ? outer : inner).push([root, path]);
	}
	if (inner.length + outer.length === 0) return;
	countPrintSwap();
	for (const [root, path] of [...inner, ...outer]) {
		try {
			buildMobileExport(root, path, div, false);
		} catch (error) {
			console.error("[handwriting] build ink for a phone or tablet export", error);
		}
	}
	try {
		unzoomed(div, () => {
			for (const [root] of inner) pinEmbedView(root, div);
			for (const [root] of outer) {
				noteCut(root);
				holdHostLines(root);
			}
		});
	} catch (error) {
		console.error("[handwriting] pin an embed for a phone or tablet export", error);
	}
}

/** The roots of every screen canvas in an added node (the node itself or inside it) that the registry knows. */
function canvasRoots(node: Node, out: Set<HTMLElement>): void {
	const el = node as Element;
	if (typeof el.matches !== "function") return;
	const found = el.matches(CANVAS_SEL) ? [el] : Array.from(el.querySelectorAll(CANVAS_SEL));
	for (const canvas of found) {
		const root = canvas.parentElement;
		if (root && layers.has(root)) out.add(root);
	}
}

/**
 * Arm the export triggers in `win`, on the mobile app only. Returns the teardown (`disarmPrintSwaps` and the window's
 * pagehide run it), or null when nothing was armed.
 */
export function armMobileExport(win: Window): (() => void) | null {
	if (!Platform.isMobileApp) return null;
	const body = win.document?.body;
	// The window's own: a popout's observer watches its own document.
	const Observer = (win as Window & { MutationObserver?: typeof MutationObserver }).MutationObserver;
	if (!body || typeof Observer !== "function") return null;
	const watched = new Map<HTMLElement, ExportWatch>();
	const unwatch = (div: HTMLElement) => {
		const w = watched.get(div);
		if (!w) return;
		watched.delete(div);
		for (const o of w.observers) o.disconnect();
	};
	const watch = (div: HTMLElement) => {
		if (watched.has(div)) return;
		const w: ExportWatch = { zoom: "", observers: [] };
		watched.set(div, w);
		// The div's own style: Obsidian writes its zoom once print() has resolved. A write anywhere else, or one before
		// the zoom, builds nothing; the zoom put back by a build is the zoom built at, and builds nothing again.
		const onStyle = new Observer(() => {
			const zoom = div.style.zoom;
			if (!zoom || zoom === w.zoom || !div.isConnected) return;
			w.zoom = zoom;
			buildInside(div, null);
		});
		onStyle.observe(div, { attributes: true, attributeFilter: ["style"] });
		// A canvas added after the zoom: an attach that came late (its note's ink was still loading) builds its root. A
		// line the build held as a div (`holdHostLines`) brings its own canvases along and builds nothing. Any other node
		// added after the zoom (an embed's content that came late) builds again each export root whose strips it left
		// stale (`stripsStale`): its strips cut again, its new lines held. The plugin's own nodes (strips, layers, held
		// lines) build nothing, and a root built again is stale no more, so a build never wakes itself.
		const onTree = new Observer((records) => {
			if (!div.style.zoom || !div.isConnected) return;
			const roots = new Set<HTMLElement>();
			let entered = false;
			for (const r of records) {
				for (const node of Array.from(r.addedNodes)) {
					if (heldLines.has(node as Element)) continue;
					canvasRoots(node, roots);
					if (!entered && lateEntry(node, div)) entered = true;
				}
			}
			if (entered) staleRoots(div, roots);
			if (roots.size > 0) buildInside(div, roots);
		});
		onTree.observe(div, { childList: true, subtree: true });
		w.observers.push(onStyle, onTree);
	};
	const onBody = new Observer((records) => {
		for (const r of records) {
			for (const node of Array.from(r.removedNodes)) unwatch(node as HTMLElement);
			for (const node of Array.from(r.addedNodes)) if (isExportDiv(node, body)) watch(node);
		}
	});
	onBody.observe(body, { childList: true });
	// The first arm can be the export's own attach: its div already stands.
	for (const node of Array.from(body.querySelectorAll(":scope > div.print"))) if (isExportDiv(node, body)) watch(node);
	return () => {
		onBody.disconnect();
		for (const div of [...watched.keys()]) unwatch(div);
	};
}
