import { EditorState, StateField, Prec, type Extension } from "@codemirror/state";
import { history, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { Decoration, EditorView, WidgetType, type ViewPlugin } from "@codemirror/view";
import { InkOverlayPlugin, inlineInk, inkOverlayExtension, inkExternallyReloaded, overlayForPath } from "../../src/inline/InkOverlay";
import type { InkStroke } from "../../src/ink/Stroke";
import type { SelectionModel } from "../../src/objects/SelectionModel";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField, issue22Notices, type Issue22EditorOwner } from "./issue22ObsidianStub";
import HandwritingPlugin from "../../src/main";
import { embedInkChanged } from "../../src/inline/EmbedInk";
import { clearInkClipboard, copyInk, inkClipboardMarker } from "../../src/inline/InkClipboard";
import { setRoutineNoticesVisible } from "../../src/diag/RoutineNotices";

installObsidianDom();
const fixtureInkHost = { readPageId: () => null, claimId: async (_path: string, pageId: string) => ({ pageId }),
	loadSidecar: async () => null, scheduleSidecar: () => { persistenceWrites++; },
	scheduleSidecarNow: async () => {}, notify: () => {} };
inlineInk.attachHost(fixtureInkHost);

const prefix = "Synthetic heading\n\n\n\n\n\n\n\n";
const markdown = "| item | value |\n| --- | --- |\n| alpha | beta |\n";
const suffix = "\nSynthetic footer\n";
// Obsidian's renderer is not available in Chromium. Use a real CodeMirror
// block replacement with the table widget DOM classes from shapesPage.ts.
// The Markdown transaction, widget lifecycle, overlay and raster are real.
class TableWidget extends WidgetType {
	eq(other: WidgetType): boolean { return other instanceof TableWidget; }
	toDOM(): HTMLElement {
		const block = document.createElement("div");
		block.className = "cm-embed-block cm-table-widget markdown-rendered";
		const table = block.appendChild(document.createElement("table"));
		for (const cells of [["item", "value"], ["alpha", "beta"]]) {
			const row = table.insertRow();
			for (const text of cells) {
				const content = row.insertCell().appendChild(document.createElement("span"));
				content.className = "table-cell-content"; content.textContent = text;
			}
		}
		return block;
	}
}
function decorations(state: EditorState) {
	const start = state.doc.toString().indexOf(markdown);
	return start < 0 ? Decoration.none : Decoration.set([
		Decoration.replace({ widget: new TableWidget(), block: true }).range(start, start + markdown.length - 1),
	]);
}
const tables = StateField.define({ create: decorations,
	update: (value, transaction) => transaction.docChanged ? decorations(transaction.state) : value,
	provide: field => EditorView.decorations.from(field) });

type Overlay = { committedCanvas: HTMLCanvasElement; selection: SelectionModel };
let view: EditorView, host: HTMLElement, overlay: Overlay, observer: MutationObserver;
const path = "synthetic-issue22.md";
let mutations = 0, measures = 0;
let persistenceWrites = 0;
const owner: Issue22EditorOwner = { app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} };
type EditorRecord = { id: string; view: EditorView; host: HTMLElement; kind: "note" | "cell" | "bare" | "popout" };
const editors: EditorRecord[] = [];
type RenderChild = { onload?(): void; onunload?(): void };
type Postprocessor = (el: HTMLElement, ctx: { sourcePath: string; containerEl: HTMLElement; addChild(child: RenderChild): void }) => void;
let postprocessor: Postprocessor | null = null;
type Command = { id: string; checkCallback?: (checking: boolean) => boolean };
let pasteCommand: Command | null = null;
let pluginInstance: Record<string, unknown> | null = null;
const noop = () => {};
async function registeredPostprocessor(): Promise<Postprocessor> {
	if (postprocessor) return postprocessor;
	const callbacks: Postprocessor[] = [];
	const adapter = { exists: async () => false, read: async () => "", write: async () => {},
		mkdir: async () => {}, list: async () => ({ files: [], folders: [] }), stat: async () => null,
		remove: async () => {}, rename: async () => {} };
	const app = { loadLocalStorage: () => null, saveLocalStorage: noop,
		vault: { adapter, on: () => ({}), getFileByPath: () => null, getMarkdownFiles: () => [],
			getFiles: () => [], getAbstractFileByPath: () => null, cachedRead: async () => "",
			configDir: ".obsidian" },
		workspace: { on: () => ({}), onLayoutReady: noop, getLeavesOfType: () => [],
			getActiveFile: () => null, getActiveViewOfType: () => null, activeLeaf: null,
			iterateAllLeaves: noop, trigger: noop },
		metadataCache: { on: () => ({}), getFileCache: () => null, getCache: () => null },
		keymap: { pushScope: noop, popScope: noop }, scope: {},
		fileManager: { processFrontMatter: async () => {} } };
	const plugin = new (HandwritingPlugin as unknown as new (a: unknown, m: unknown) => Record<string, unknown> & { onload(): Promise<void> })(app, {});
	Object.assign(plugin, { app, manifest: { id: "handwriting", version: "1.4.21", dir: ".obsidian/plugins/handwriting" },
		addCommand: (command: Command) => { if (command.id === "paste-ink") pasteCommand = command; },
		registerView: noop, addSettingTab: noop, addRibbonIcon: () => ({ addClass: noop }),
		registerEvent: noop, registerDomEvent: noop, registerInterval: noop,
		registerEditorExtension: noop, registerMarkdownPostProcessor: (cb: Postprocessor) => callbacks.push(cb),
		registerObsidianProtocolHandler: noop, register: noop,
		loadData: async () => ({}), saveData: async () => {} });
	await plugin.onload();
	// The registered plugin installs its own host sink. Restore this fixture's
	// counted synthetic adapter so persistence assertions still observe paste.
	inlineInk.attachHost(fixtureInkHost);
	pluginInstance = plugin;
	if (callbacks.length !== 1) throw Error(`expected production postprocessor, got ${callbacks.length}`);
	postprocessor = callbacks[0]!;
	return postprocessor;
}
let cell: EditorRecord | null = null;
let cellInkPlugin: ViewPlugin<InkOverlayPlugin> | null = null;
let cellWrapper: HTMLElement | null = null;
let cellContent: HTMLElement | null = null;
let cellNumber = 0;
let popoutFrame: HTMLIFrameElement | null = null;
const stroke: InkStroke = { id: "issue22-original", tool: "pen", color: "#000000", width: 8,
	widthMode: "uniform", createdAt: 1,
	points: [{ x: 80, y: 55, pressure: .5, t: 0 }, { x: 140, y: 65, pressure: .5, t: 20 },
		{ x: 200, y: 55, pressure: .5, t: 40 }], bbox: { x: 76, y: 51, width: 128, height: 18 } };

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function settle() {
	await new Promise<void>(resolve => view.requestMeasure({ read: () => { measures++; return null; }, write: () => resolve() }));
	// Let MutationObserver, ResizeObserver, CM measurement and the production
	// scheduled repaint finish. Never invoke syncCamera/repaint after insertion:
	// doing so could repair the stale raster that this reproduction must detect.
	for (let i = 0; i < 12; i++) await frame();
}
function rect(element: Element) {
	const r = element.getBoundingClientRect();
	return { x: r.x, y: r.y, width: r.width, height: r.height };
}
function canvasRaster(c: HTMLCanvasElement) {
	if (!c.width || !c.height) return { count: 0, backing: { x0: 0, y0: 0, x1: -1, y1: -1 }, screen: null };
	const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
	let count = 0, x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
	for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
		const i = (y * c.width + x) * 4;
		if (data[i + 3]! > 128 && data[i]! < 80 && data[i + 1]! < 80 && data[i + 2]! < 80) {
			count++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
		}
	}
	const r = rect(c);
	return { count, backing: { x0, y0, x1, y1 }, screen: count ? {
		x: r.x + x0 * r.width / c.width, y: r.y + y0 * r.height / c.height,
		width: (x1 - x0 + 1) * r.width / c.width, height: (y1 - y0 + 1) * r.height / c.height,
	} : null };
}
function raster() { return canvasRaster(overlay.committedCanvas); }
function snapshot() {
	const stored = inlineInk.strokes(path);
	// Exercise the mounted overlay's real lasso geometry, not selectExactly.
	// This is selection eligibility, not proof of a hardware drag or erase.
	overlay.selection.selectByLasso([{ x: 70, y: 40 }, { x: 215, y: 40 },
		{ x: 215, y: 80 }, { x: 70, y: 80 }], stored, [], () => null);
	const selectable = [...overlay.selection.strokeIds];
	overlay.selection.clear();
	return { strokes: structuredClone(stored), selectable, raster: raster(), mutations, measures,
		tableCount: host.querySelectorAll(".cm-table-widget table").length,
		doc: view.state.doc.toString() };
}
async function mount(tableFirst: boolean) {
	host = document.body.appendChild(document.createElement("div"));
	host.className = "markdown-source-view issue22-proof";
	view = new EditorView({ parent: host, state: EditorState.create({ doc: prefix + (tableFirst ? markdown : "") + suffix,
			extensions: [tables, history(), editorInfoField.init(() => owner),
			inkOverlayExtension(), EditorView.theme({ "&": { width: "640px", height: "600px" },
				".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
	view.dom.dataset.issue22Editor = "note-main";
	editors.push({ id: "note-main", view, host, kind: "note" });
	observer = new MutationObserver(records => { mutations += records.length; });
	observer.observe(view.contentDOM, { subtree: true, childList: true, attributes: true, characterData: true });
	await inlineInk.ensureLoaded(path);
	await settle();
	const mounted = overlayForPath(path);
	if (!mounted) throw Error("issue22 production overlay did not mount");
	overlay = mounted as unknown as Overlay;
	return snapshot();
}
async function addInk() {
	inlineInk.applyAdd(path, [structuredClone(stroke)]);
	inkExternallyReloaded(path);
	await settle();
	return snapshot();
}
async function insertTable() {
	view.dispatch({ changes: { from: prefix.length, insert: markdown } });
	await settle();
	return snapshot();
}
async function postprocessOwnBlock(kind: "table" | "callout") {
	const callback = await registeredPostprocessor();
	let container: HTMLElement, section: HTMLElement;
	if (kind === "table") {
		container = host.querySelector<HTMLElement>(".cm-table-widget") ?? (() => { throw Error("table widget missing"); })();
		section = container.querySelector<HTMLElement>(".table-cell-content") ?? (() => { throw Error("table cell missing"); })();
	} else {
		container = view.dom.appendChild(document.createElement("div"));
		container.className = "cm-embed-block cm-callout";
		section = container.appendChild(document.createElement("div"));
		section.className = "markdown-rendered";
		section.textContent = "Synthetic callout content";
	}
	let children = 0;
	callback(section, { sourcePath: path, containerEl: container,
		addChild(child) { children++; child.onload?.(); } });
	await settle();
	const result = { children, staticCanvases: container.querySelectorAll("canvas.handwriting-embed-ink").length,
		original: snapshot(), table: kind === "table" ? tableRect() : rect(container) };
	return result;
}
async function postprocessOwnBlockBoundary(kind: "detached-container" | "delayed") {
	const callback = await registeredPostprocessor();
	let container: HTMLElement;
	if (kind === "detached-container") {
		container = host.querySelector<HTMLElement>(".cm-table-widget") ??
			(() => { throw Error("own table widget missing"); })();
	} else {
		container = document.createElement("div");
	}
	const section = document.createElement("div"); // deliberately detached at callback entry
	let children = 0;
	callback(section, { sourcePath: path, containerEl: container,
		addChild(child) { children++; child.onload?.(); } });
	if (kind === "delayed") {
		container.className = "cm-embed-block cm-callout markdown-rendered";
		container.style.cssText = "width:320px;height:80px;background:white";
		section.className = "markdown-rendered";
		section.textContent = "Delayed own-note callout";
		container.appendChild(section);
		view.dom.appendChild(container);
	}
	await settle();
	return { kind, children, staticCanvases: container.querySelectorAll("canvas.handwriting-embed-ink").length,
		original: snapshot(), rect: kind === "detached-container" ? tableRect() : rect(container) };
}
async function postprocessRenderedControl(
	kind: "reading" | "embed" | "other-note" | "delayed" | "unloaded" | "popout",
	withInk: boolean
) {
	const callback = await registeredPostprocessor();
	const targetPath = kind === "other-note" ? "synthetic-target-b.md" : path;
	await inlineInk.ensureLoaded(targetPath);
	if (withInk) {
		inlineInk.applyAdd(targetPath, [{ ...structuredClone(stroke), id: `control-${kind}` }]);
		inkExternallyReloaded(targetPath);
	}
	let doc = document, iframe: HTMLIFrameElement | null = null;
	if (kind === "popout") {
		iframe = document.body.appendChild(document.createElement("iframe"));
		iframe.style.cssText = "position:absolute;left:0;top:0;width:640px;height:360px;border:0";
		doc = iframe.contentDocument!;
		for (const style of document.querySelectorAll("style")) doc.head.appendChild(style.cloneNode(true));
		const realm = doc.defaultView as unknown as { HTMLElement: typeof HTMLElement };
		for (const name of ["createEl", "createDiv", "createSpan", "setText", "empty", "detach", "addClass", "removeClass", "toggleClass", "setCssStyles"])
			Object.defineProperty(realm.HTMLElement.prototype, name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)!);
	}
	const root = doc.createElement("div");
	root.className = kind === "delayed" || kind === "unloaded" ? "" :
		kind === "reading" ? "markdown-preview-view" : "markdown-embed-content";
	root.style.cssText = "position:relative;width:320px;height:230px;background:white;overflow:visible";
	const section = doc.createElement("div");
	section.className = kind === "delayed" || kind === "unloaded" ? "" : "markdown-rendered";
	section.textContent = "Rendered note content";
	let callout: HTMLElement | null = null;
	if (kind === "other-note") {
		callout = view.dom.appendChild(document.createElement("div"));
		callout.className = "cm-embed-block cm-callout markdown-rendered";
		callout.appendChild(root);
	} else if (kind !== "delayed" && kind !== "unloaded") {
		(kind === "reading" || kind === "popout" ? doc.body : view.dom).appendChild(root);
	}
	if (kind !== "other-note") root.appendChild(section);
	let children = 0, renderChild: RenderChild | null = null;
	callback(section, { sourcePath: targetPath, containerEl: root,
		addChild(child) { children++; renderChild = child; child.onload?.(); } });
	if (kind === "other-note") root.appendChild(section); // detached section, valid attached container
	if (kind === "unloaded") (renderChild as RenderChild | null)?.onunload?.();
	if (kind === "delayed" || kind === "unloaded") {
		root.className = "markdown-embed-content";
		section.className = "markdown-rendered";
		view.dom.appendChild(root);
	}
	await settle();
	const canvas = root.querySelector<HTMLCanvasElement>("canvas.handwriting-embed-ink");
	const raster = canvas ? canvasRaster(canvas) : null;
	const box = rect(root), frame = iframe ? rect(iframe) : null;
	return { kind, children, canvasCount: root.querySelectorAll("canvas.handwriting-embed-ink").length,
		raster, rect: frame ? { ...box, x: box.x + frame.x, y: box.y + frame.y } : box,
		insideCallout: !!root.closest(".cm-callout"), storeCount: inlineInk.strokes(targetPath).length };
}
function notifyOwnBlockInkChanged() {
	embedInkChanged(path);
	return host.querySelectorAll("canvas.handwriting-embed-ink").length;
}
function tableRect() {
	const table = host.querySelector(".cm-table-widget table");
	if (!table) throw Error("issue22 table widget missing");
	return rect(table);
}
function duplicateRaster() {
	// Falsification only: copy the existing committed raster into the table
	// region without adding a stroke or changing selection. This emulates a
	// non-editable raster duplicate; it does not claim the user's causal path.
	const c = overlay.committedCanvas, bounds = raster().backing, target = tableRect(), r = rect(c);
	if (bounds.x1 < bounds.x0) throw Error("issue22 plant requires visible original ink");
	const copy = document.createElement("canvas");
	copy.width = bounds.x1 - bounds.x0 + 1; copy.height = bounds.y1 - bounds.y0 + 1;
	copy.getContext("2d")!.drawImage(c, bounds.x0, bounds.y0, copy.width, copy.height, 0, 0, copy.width, copy.height);
	const ctx = c.getContext("2d")!;
	ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.drawImage(copy, (target.x + 30 - r.x) * c.width / r.width, (target.y + 45 - r.y) * c.height / r.height);
	ctx.restore();
	return snapshot();
}
async function pixels(bytes: number[], reference?: number[]) {
	const decode = async (png: number[]) => {
		const bitmap = await createImageBitmap(new Blob([new Uint8Array(png)], { type: "image/png" }));
		const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
		const ctx = canvas.getContext("2d")!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
		return ctx.getImageData(0, 0, canvas.width, canvas.height);
	};
	const actual = await decode(bytes), clean = reference ? await decode(reference) : null;
	if (clean && (clean.width !== actual.width || clean.height !== actual.height)) throw Error("issue22 screenshot dimensions differ");
	const mask = new Uint8Array(actual.width * actual.height);
	let dark = 0, missingDark = 0;
	for (let p = 0; p < mask.length; p++) {
		const i = p * 4, d = actual.data;
		const black = d[i]! < 90 && d[i + 1]! < 90 && d[i + 2]! < 90;
		if (black) dark++;
		if (clean && clean.data[i]! < 90 && clean.data[i + 1]! < 90 && clean.data[i + 2]! < 90
			&& Math.min(d[i]!, d[i + 1]!, d[i + 2]!) > 180) missingDark++;
		// Table borders/text already dark in the no-ink control are excluded.
		if (black && (!clean || Math.min(clean.data[i]!, clean.data[i + 1]!, clean.data[i + 2]!) > 180)) mask[p] = 1;
	}
	const components: number[] = [];
	for (let p = 0; p < mask.length; p++) {
		if (!mask[p]) continue;
		const queue = [p]; mask[p] = 0;
		for (let i = 0; i < queue.length; i++) {
			const q = queue[i]!, x = q % actual.width, y = Math.floor(q / actual.width);
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const nx = x + dx, ny = y + dy, n = ny * actual.width + nx;
				if (nx >= 0 && nx < actual.width && ny >= 0 && ny < actual.height && mask[n]) { mask[n] = 0; queue.push(n); }
			}
		}
		components.push(queue.length);
	}
	return { width: actual.width, height: actual.height, dark, missingDark, largest: Math.max(0, ...components),
		addedDark: components.reduce((sum, n) => sum + n, 0) };
}

// Count by nearest CM root, never by file path or the first overlay instance.
// Include a detached child's own subtree as well as every connected document.
function surfaceRoots() {
	const roots = new Set<Element>();
	for (const doc of [document, ...(popoutFrame?.contentDocument ? [popoutFrame.contentDocument] : [])]) {
		for (const root of doc.querySelectorAll(".handwriting-ink-overlay")) roots.add(root);
	}
	for (const entry of editors) for (const root of entry.view.dom.querySelectorAll(".handwriting-ink-overlay")) roots.add(root);
	return [...roots];
}
function census() {
	const surfaces = surfaceRoots().map((root, index) => {
		const cm = root.closest(".cm-editor");
		const entry = editors.find(e => e.view.dom === cm);
		return { index, editor: entry?.id ?? "unregistered", kind: entry?.kind ?? "unknown", connected: root.isConnected,
			cmRect: cm ? rect(cm) : null, rect: rect(root), insideTable: !!root.closest(".cm-table-widget"),
			canvases: [...root.querySelectorAll("canvas")].map((canvas, layer) => ({ layer, width: canvas.width,
				height: canvas.height, rect: rect(canvas), raster: canvasRaster(canvas) })) };
	});
	return { surfaces, editors: editors.map(e => ({ id: e.id, kind: e.kind, connected: e.view.dom.isConnected,
		file: e.view.state.field(editorInfoField, false)?.file.path ?? null,
		sameOwner: e.view.state.field(editorInfoField, false) === owner,
		ownMarkdownRoot: e.host.classList.contains("markdown-source-view"),
		insideParentEditor: !!e.host.parentElement?.closest(".cm-editor"),
		focused: e.view.hasFocus, differentWindow: e.view.dom.ownerDocument.defaultView !== window, rect: rect(e.view.dom) })),
		original: snapshot() };
}
function removeCell() {
	if (!cell) return;
	const old = cell;
	old.view.destroy();
	cellWrapper?.remove();
	if (cellContent) cellContent.hidden = false;
	editors.splice(editors.indexOf(old), 1);
	cell = null; cellWrapper = null; cellContent = null;
	cellInkPlugin = null;
	host.querySelector(".cm-table-widget")?.classList.remove("has-focus");
}
async function destroyCell() {
	removeCell();
	await settle();
	return census();
}
async function focusCell(withOwner = true, index = 0) {
	const previous = cell ? { entry: cell, wrapper: cellWrapper, content: cellContent } : null;
	const td = host.querySelectorAll<HTMLTableCellElement>(".cm-table-widget td")[index];
	if (!td) throw Error("issue22 focus requires a real table cell");
	const content = td.querySelector<HTMLElement>(".table-cell-content");
	if (!content) throw Error("table cell's rendered content is absent");
	const text = content.textContent ?? "";
	const wrapper = document.createElement("div"); wrapper.className = "table-cell-wrapper";
	const childHost = wrapper.appendChild(document.createElement("div"));
	childHost.className = "markdown-source-view";
	// Obsidian 1.13.7 HJ -> UJ: construct while detached, remove the child's
	// own note-root class, initialize text/extensions, then append and focus.
	const child = new EditorView({ parent: childHost, state: EditorState.create({ doc: "" }) });
	childHost.classList.remove("markdown-source-view");
	const id = `cell-${++cellNumber}`;
	cell = { id, view: child, host: childHost, kind: withOwner ? "cell" : "bare" };
	editors.push(cell);
	// Keep the extension's production ViewPlugin token so the captured command
	// can call the real inert cell overlay, not a zero-result stand-in.
	const inkExtensions = inkOverlayExtension() as Extension[];
	cellInkPlugin = inkExtensions[2] as ViewPlugin<InkOverlayPlugin>;
	child.setState(EditorState.create({ doc: text, extensions: [history(), editorInfoField.init(() => withOwner ? owner : undefined),
		EditorView.updateListener.of(update => {
			// Synthetic HJ -> UJ host boundary: document and selection changes
			// forward to the parent; effects-only ink transactions do not.
			if (!update.docChanged && !update.selectionSet) return;
			const source = view.state.doc.toString(), from = source.indexOf(text);
			if (from < 0) return;
			const selection = update.state.selection.main;
			view.dispatch({
				...(update.docChanged ? { changes: { from, to: from + text.length,
					insert: update.state.doc.toString() } } : {}),
				...(update.selectionSet ? { selection: { anchor: from + selection.anchor,
					head: from + selection.head } } : {}),
			});
		}),
		Prec.highest(EditorView.domEventHandlers({ keydown(event) {
			// Synthetic host routes a cell's Mod-z to the owning note editor.
			if (event.key.toLowerCase() !== "z" || !(event.ctrlKey || event.metaKey)) return false;
			event.preventDefault(); event.stopPropagation(); undo(view); return true;
		} })),
		inkExtensions, EditorView.theme({ "&": { width: "100%", height: "80px" },
			".cm-content": { padding: "0", fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }));
	child.dom.dataset.issue22Editor = id;
	const detached = census();
	cellContent = content; content.hidden = true;
	cellWrapper = wrapper; td.appendChild(wrapper);
	child.focus();
	// Real editTableCell focuses the new child before retiring the old one.
	if (previous) {
		previous.entry.view.destroy(); previous.wrapper?.remove();
		if (previous.content && previous.content !== content) previous.content.hidden = false;
		editors.splice(editors.indexOf(previous.entry), 1);
	}
	host.querySelector(".cm-table-widget")?.classList.add("has-focus");
	await settle();
	return { detached, attached: census(), id };
}
async function blurCell() { view.focus(); await settle(); return census(); }
async function refocusCell() { if (!cell) throw Error("no cell to refocus"); cell.view.focus(); await settle(); return census(); }

function pasteSnapshot() {
	const other = editors.find(e => e.id === "note-second" || e.id === "note-popout");
	return { parentDoc: view.state.doc.toString(), cellDoc: cell?.view.state.doc.toString() ?? null,
		parentSelection: { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head },
		cellSelection: cell ? { anchor: cell.view.state.selection.main.anchor,
			head: cell.view.state.selection.main.head } : null,
		parentUndo: undoDepth(view.state), parentRedo: redoDepth(view.state),
		cellUndo: cell ? undoDepth(cell.view.state) : null,
		otherDoc: other?.view.state.doc.toString() ?? null,
		otherUndo: other ? undoDepth(other.view.state) : null,
		ids: inlineInk.strokes(path).map(s => s.id),
		points: inlineInk.strokes(path).map(s => s.points.map(p => ({ x: p.x, y: p.y }))),
		selected: [...overlay.selection.strokeIds], persistenceWrites,
		notices: [...issue22Notices] };
}
async function seedParentTextEdit() {
	view.dispatch({ changes: { from: view.state.doc.length, insert: "seed" } });
	await settle();
	return pasteSnapshot();
}
async function seedCellSelection() {
	if (!cell) throw Error("selection seed needs cell");
	cell.view.dispatch({ selection: { anchor: 1, head: 3 } });
	await settle();
	return pasteSnapshot();
}
async function cellUndoParent() {
	if (!cell) throw Error("cell undo needs cell");
	const before = pasteSnapshot();
	const event = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
	cell.view.contentDOM.dispatchEvent(event);
	await settle();
	return { before, prevented: event.defaultPrevented, after: pasteSnapshot() };
}
function dispatchPaste(target: HTMLElement, text: string) {
	const data = new DataTransfer(); data.setData("text/plain", text);
	const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
	let bubbled = 0;
	const onBubble = () => { bubbled++; };
	(host.parentElement ?? document.body).addEventListener("paste", onBubble);
	target.dispatchEvent(event);
	(host.parentElement ?? document.body).removeEventListener("paste", onBubble);
	return { prevented: event.defaultPrevented, bubbled };
}
async function cellPasteProbe(kind: "current" | "stale" | "text") {
	if (!cell) throw Error("cell paste needs a mounted cell");
	issue22Notices.length = 0;
	const text = kind === "current" ? inkClipboardMarker()! :
		kind === "stale" ? "handwriting-ink/v1 stale-token (1 stroke)" : "ordinary text";
	if (kind === "stale") clearInkClipboard();
	const before = pasteSnapshot();
	const event = dispatchPaste(cell.view.contentDOM, text);
	await settle();
	return { kind, text, event, before, after: pasteSnapshot() };
}
function prepareInkPaste() {
	copyInk([stroke], path);
	return inkClipboardMarker();
}
async function parentPasteAndUndo() {
	issue22Notices.length = 0;
	const before = pasteSnapshot();
	const event = dispatchPaste(view.contentDOM, inkClipboardMarker()!);
	await settle();
	const after = pasteSnapshot();
	const undid = undo(view);
	await settle();
	const afterUndo = pasteSnapshot();
	const redid = redo(view);
	await settle();
	return { before, event, after, undid, afterUndo, redid, afterRedo: pasteSnapshot() };
}
async function capturedCommandCellRefusal() {
	await registeredPostprocessor();
	if (!pluginInstance || !pasteCommand?.checkCallback || !cell || !cellInkPlugin)
		throw Error("paste command needs registered command and live cell overlay");
	const realCellOverlay = cell.view.plugin(cellInkPlugin);
	if (!realCellOverlay) throw Error("production cell ViewPlugin missing");
	const prior = pluginInstance.activeInkSurface;
	pluginInstance.activeInkSurface = () => ({ kind: "inline", overlay: realCellOverlay });
	const results = [];
	for (const routine of [false, true]) {
		setRoutineNoticesVisible(routine);
		issue22Notices.length = 0;
		const before = pasteSnapshot();
		const accepted = pasteCommand.checkCallback(false);
		results.push({ routine, accepted, before, after: pasteSnapshot() });
	}
	pluginInstance.activeInkSurface = prior;
	return results;
}

async function addLegitimatePane(popout: boolean) {
	let doc = document;
	if (popout) {
		if (popoutFrame) throw Error("only one popout control per page");
		popoutFrame = document.body.appendChild(document.createElement("iframe"));
		popoutFrame.style.cssText = "position:absolute;left:660px;top:0;width:640px;height:600px;border:0";
		doc = popoutFrame.contentDocument!;
		// Same-origin second-window control: same store/extension, different
		// ownerDocument/defaultView. This is not a native Obsidian popout claim.
		for (const style of document.querySelectorAll("style")) doc.head.appendChild(style.cloneNode(true));
		const realm = doc.defaultView as unknown as { HTMLElement: typeof HTMLElement };
		for (const name of ["createEl", "createDiv", "createSpan", "setText", "empty", "detach", "addClass", "removeClass", "toggleClass", "setCssStyles"]) {
			Object.defineProperty(realm.HTMLElement.prototype, name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)!);
		}
	}
	// Start without a source-view root: eligibility must not be cached false
	// forever from construction. Supply the real root only after attachment.
	const pane = doc.createElement("div"); pane.className = "issue22-proof";
	if (!popout) pane.style.cssText = "position:absolute;left:660px;top:0";
	const ownOwner = { ...owner, editor: {} };
	let updateTransactions = 0;
	const other = new EditorView({ parent: pane, state: EditorState.create({ doc: prefix + suffix,
		extensions: [editorInfoField.init(() => ownOwner), inkOverlayExtension(),
			EditorView.updateListener.of(update => { updateTransactions += update.transactions.length; }),
			EditorView.theme({ "&": { width: "640px", height: "600px" }, ".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" } })] }) });
	const id = popout ? "note-popout" : "note-second"; other.dom.dataset.issue22Editor = id;
	editors.push({ id, view: other, host: pane, kind: popout ? "popout" : "note" });
	const detached = census();
	doc.body.appendChild(pane); pane.classList.add("markdown-source-view");
	const attachedBeforeUpdate = census();
	const beforeUpdateTransactions = updateTransactions;
	// One real transaction reaches ViewPlugin.update -> updateInner. Do not
	// call mount, rebuild state, focus, or await a frame before this witness.
	other.dispatch({});
	const afterFirstUpdate = census();
	const firstUpdateTransactions = updateTransactions - beforeUpdateTransactions;
	other.focus();
	await settle();
	return { id, detached, attachedBeforeUpdate, afterFirstUpdate, firstUpdateTransactions, settled: census() };
}
async function setPaneRootEligibility(popout: boolean, eligible: boolean) {
	const entry = editors.find(e => e.id === (popout ? "note-popout" : "note-second"));
	if (!entry) throw Error("legitimate pane control is missing");
	entry.host.classList.toggle("markdown-source-view", eligible);
	// Keep the same EditorView/plugin instance. A normal CM update must retire
	// or remount it from live ownership, rather than a cached constructor answer.
	entry.view.dispatch({});
	await settle();
	return census();
}
function layerPNGs() {
	return surfaceRoots().flatMap((root, index) => {
		const entry = editors.find(e => e.view.dom === root.closest(".cm-editor"));
		return [...root.querySelectorAll("canvas")].map((canvas, layer) => ({ editor: entry?.id ?? `unregistered-${index}`,
			surface: index, layer, width: canvas.width, height: canvas.height,
			png: canvas.width && canvas.height ? canvas.toDataURL("image/png") : null }));
	});
}
const api = { mount, addInk, insertTable, postprocessOwnBlock, postprocessOwnBlockBoundary,
	postprocessRenderedControl, notifyOwnBlockInkChanged,
	snapshot, tableRect, duplicateRaster, pixels, settle,
	census, focusCell, blurCell, refocusCell, destroyCell, addLegitimatePane, setPaneRootEligibility, layerPNGs,
	pasteSnapshot, seedParentTextEdit, seedCellSelection, cellUndoParent,
	cellPasteProbe, prepareInkPaste, parentPasteAndUndo, capturedCommandCellRefusal,
	destroy: () => { observer.disconnect(); removeCell(); for (const e of editors.splice(0)) { e.view.destroy(); e.host.remove(); } popoutFrame?.remove(); } };
declare global { interface Window { issue22: typeof api } }
window.issue22 = api;
