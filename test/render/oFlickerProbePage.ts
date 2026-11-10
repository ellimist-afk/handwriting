/**
 * The page for OFlickerProbe.test.ts: the real CodeMirror editor with the real ink overlay, a new note with no frontmatter,
 * and a Properties block that only Obsidian's own CSS shows and only the plugin's id-only class hides.
 *
 * frontmatterInkPage.ts hides its block with an inline style, so it can never paint the block for a frame. Here the block is
 * shown by the host rules (obsidianMetadataHost.css: `.markdown-source-view.is-live-preview.show-properties
 * .metadata-container`) and hidden only by `handwriting-metadata-id-only` from the shipped styles.css, which the plugin's
 * MutationObserver adds on the frame after it sees the block (InkOverlayLifecycle.ts updateHandwritingPageClass).
 *
 * The first stroke's claim writes the page-id frontmatter into the editor and draws the block in one of several orders. Which
 * order Obsidian uses is not known; this page only shows which orders paint a dropped frame. Only a run in real Obsidian
 * says which order is real.
 *
 * A sampler reads once per frame, from a message posted inside the frame's animation callback, so the read lands after the
 * frame's callbacks (the plugin's class callback included) and after its paint. Per frame it keeps the block's computed
 * display and height, the id-only class, the row count, `.cm-content` top, CodeMirror's document top, the camera's last
 * synced document top, and the O's top on screen as the camera draws it (synced document top plus the stroke's page y and
 * line correction, editor px). That last number is the model the canvas is drawn from, not a pixel read.
 *
 * It changes nothing in src/.
 */
import { EditorState, RangeSetBuilder, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setInlineTool, setInkSizeMult, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { parsePage, serializePage } from "../../src/model/PageData";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";

Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isWin: true });
installObsidianDom();

const PATH = "Untitled.md";
const FONT_PX = 16, LINE_PX = 24, CONTENT_PAD = 32, PROPERTIES_PX = 46;
const w = window as unknown as Record<string, unknown>;
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * How the claim's frontmatter and the Properties block arrive, after the first stroke.
 *  - textThenBlock: editor text, then the block with its id row, one task.
 *  - blockThenText: the block with its id row, then the editor text, one task.
 *  - rowsNextFrame: editor text and a rowless block in one task; the id row one frame later.
 *  - blockInFrame: editor text in the task; the block with its id row from inside the next animation callback.
 *  - blockBeforeText: a rowless block first (the file write seen before the editor syncs); the editor text two frames later;
 *    the id row two frames after that.
 *  - inlineHidden (control): the block drawn with an inline display none, as frontmatterInkPage.ts does. Must drop nothing.
 *  - userRow (plant): the block with a user row (`title`), which the plugin must not hide. Must drop and stay dropped,
 *    so a read that sees nothing here is a blind instrument.
 */
export type Order = "textThenBlock" | "blockThenText" | "rowsNextFrame" | "blockInFrame" | "blockBeforeText" | "inlineHidden" | "userRow";

let ORDER: Order = "textThenBlock";
let EV: EditorView | null = null;
let SIZER: HTMLElement | null = null;
let CONTAINER: HTMLElement | null = null;
let PROPS: HTMLElement | null = null;
let claimAt = -1, claimDoneAt = -1, textAt = -1, blockAt = -1, rowAt = -1;
const ids = new Map<string, string>();
const sidecars = new Map<string, string>();

/** The frontmatter's last line, 1-based (its closing fence), or 0 when the note does not open with a closed block. */
function frontmatterEnd(doc: { lines: number; line(n: number): { text: string } }): number {
	if (doc.lines < 2 || doc.line(1).text !== "---") return 0;
	for (let n = 2; n <= doc.lines; n++) if (doc.line(n).text === "---") return n;
	return 0;
}

/** The frontmatter lines hidden, as in Visible: a block replace with no widget, so they take no height. */
const hideField = StateField.define<DecorationSet>({
	create: (state) => hideOf(state),
	update: (d, tr) => (tr.docChanged ? hideOf(tr.state) : d),
	provide: (f) => EditorView.decorations.from(f),
});
function hideOf(state: EditorState): DecorationSet {
	const b = new RangeSetBuilder<Decoration>();
	const end = frontmatterEnd(state.doc);
	if (end > 0) b.add(0, state.doc.line(end).to, Decoration.replace({ block: true }));
	return b.finish();
}

function writeText(id: string): void {
	if (!EV || frontmatterEnd(EV.state.doc) !== 0) return;
	EV.dispatch({ changes: { from: 0, insert: `---\nhandwriting-page-id: ${id}\n---\n` } });
	textAt = performance.now();
}
function addBlock(): HTMLElement {
	const el = document.createElement("div");
	el.className = "metadata-container";
	el.style.cssText = `height:${PROPERTIES_PX}px;box-sizing:border-box`;
	if (ORDER === "inlineHidden") el.style.display = "none";
	SIZER!.insertBefore(el, CONTAINER);
	PROPS = el;
	blockAt = performance.now();
	return el;
}
function addRow(el: HTMLElement, key: string, value: string): void {
	const row = document.createElement("div");
	row.className = "metadata-property";
	row.setAttribute("data-property-key", key);
	row.textContent = `${key}: ${value}`;
	el.appendChild(row);
	rowAt = performance.now();
}

/** The claim: page id into the editor text and a Properties block into the sizer, in the chosen order. */
function claimInOrder(id: string): void {
	switch (ORDER) {
		case "textThenBlock": writeText(id); addRow(addBlock(), "handwriting-page-id", id); break;
		case "blockThenText": addRow(addBlock(), "handwriting-page-id", id); writeText(id); break;
		case "rowsNextFrame": { writeText(id); const el = addBlock(); requestAnimationFrame(() => addRow(el, "handwriting-page-id", id)); break; }
		case "blockInFrame": writeText(id); requestAnimationFrame(() => addRow(addBlock(), "handwriting-page-id", id)); break;
		case "blockBeforeText": {
			const el = addBlock();
			void (async () => { await settle(2); writeText(id); await settle(2); addRow(el, "handwriting-page-id", id); })();
			break;
		}
		case "inlineHidden": writeText(id); addRow(addBlock(), "handwriting-page-id", id); break;
		case "userRow": writeText(id); { const el = addBlock(); addRow(el, "handwriting-page-id", id); addRow(el, "title", "plant"); } break;
	}
}

inlineInk.attachHost({
	readPageId: (p) => ids.get(p) ?? null,
	claimId: async (p, id) => {
		claimAt = performance.now();
		ids.set(p, id);
		claimInOrder(id);
		claimDoneAt = performance.now();
		return { pageId: id };
	},
	loadSidecar: async (id) => (sidecars.has(id) ? parsePage(sidecars.get(id)!, id) : null),
	scheduleSidecar: (id, page) => { sidecars.set(id, serializePage(page)); },
	scheduleSidecarNow: async (id, page) => { sidecars.set(id, serializePage(page)); },
	notify: () => {},
});

const pen = (type: string, x: number, y: number, buttons: number) =>
	document.elementFromPoint(x, y)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 903, isPrimary: true, clientX: x, clientY: y, buttons, pressure: buttons ? 0.5 : 0 }));

// ---- the per-frame sampler --------------------------------------------------

type Sample = {
	f: number; t: number; mark: string;
	block: boolean; display: string; height: number; idOnly: boolean; rows: number;
	docHasFm: boolean; contentTop: number; cmDocTop: number; camDocTop: number;
	oTop: number | null; oDy: number | null; anchorGen: number | null; shownMoves: number | null;
};
const samples: Sample[] = [];
let sampling = false, frameNo = 0, mark = "";
const channel = new MessageChannel();
channel.port1.onmessage = () => { if (sampling) samples.push(read()); };

function read(): Sample {
	const view = EV!, ov = overlayForPath(PATH) as any;
	const el = PROPS, cs = el ? getComputedStyle(el) : null;
	const s = (inlineInk.strokes(PATH) as any[])[0];
	let oTop: number | null = null, oDy: number | null = null;
	const layout = ov?.lineLayout?.();
	if (s && layout) {
		oDy = ov.lineAnchorDy(s);
		oTop = r3(ov.lastSyncDocumentTop + (s.bbox.y + oDy!) * layout.pxPerWorld);
	}
	return {
		f: frameNo, t: r3(performance.now()), mark,
		block: !!el, display: cs?.display ?? "absent", height: el ? r3(el.getBoundingClientRect().height) : 0,
		idOnly: el?.classList.contains("handwriting-metadata-id-only") ?? false, rows: el?.querySelectorAll(".metadata-property").length ?? 0,
		docHasFm: frontmatterEnd(view.state.doc) > 0, contentTop: r3(view.contentDOM.getBoundingClientRect().top),
		cmDocTop: r3(view.documentTop), camDocTop: r3(ov?.lastSyncDocumentTop ?? NaN),
		oTop, oDy: oDy === null ? null : r3(oDy), anchorGen: ov?.lineAnchors?.generation ?? null, shownMoves: ov?.shownMoves ?? null,
	};
}
function tick(): void {
	if (!sampling) return;
	frameNo++;
	channel.port2.postMessage(0);
	requestAnimationFrame(tick);
}

// ---- the page's calls -------------------------------------------------------

w.ofMount = async (o: { text: string; paneW: number; paneH: number; order: Order }) => {
	ORDER = o.order;
	setPenInk(true);
	setScrollExpansionEnabled(true);
	setInlineTool("pen");
	setInkColorHex("pen", "#ff00ff");
	setInkSizeMult("pen", 2);
	// .view-content is the plugin observer's root; show-properties is the host class that shows the block in Visible.
	const viewContent = document.body.appendChild(document.createElement("div"));
	viewContent.className = "view-content";
	const pane = viewContent.appendChild(document.createElement("div"));
	pane.className = "markdown-source-view mod-cm6 is-live-preview show-properties";
	pane.style.cssText = `position:relative;width:${o.paneW}px;height:${o.paneH}px;overflow:hidden`;
	const view = new EditorView({ parent: pane, state: EditorState.create({ doc: o.text, extensions: [
		EditorView.lineWrapping,
		editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path: PATH }, editor: {} }) as any),
		hideField,
		inkOverlayExtension() as any[],
		EditorView.theme({ "&": { width: `${o.paneW}px`, height: `${o.paneH}px` }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" },
			".cm-content": { fontSize: `${FONT_PX}px`, lineHeight: `${LINE_PX}px`, fontFamily: "sans-serif", paddingTop: `${CONTENT_PAD}px` } }),
	] }) });
	// Obsidian's .cm-sizer wrapper; the Properties block goes in it above .cm-contentContainer when the claim draws it.
	const content = view.contentDOM, sizer = document.createElement("div"), container = document.createElement("div");
	sizer.className = "cm-sizer";
	container.className = "cm-contentContainer";
	content.parentElement!.insertBefore(sizer, content);
	sizer.appendChild(container);
	container.appendChild(content);
	EV = view; SIZER = sizer; CONTAINER = container;
	await settle(30);
	if (!overlayForPath(PATH)) return { error: "no overlay" };
	return { mounted: true, order: ORDER, lines: view.state.doc.lines, frontmatterEnd: frontmatterEnd(view.state.doc) };
};

/**
 * Alan's steps: an O drawn on body line `onBody`, lift, wait `gapMs`, pen down again beside it for `holdMs`, lift, then
 * `tailMs` more. Sampled every frame from just before the first pen down to the end.
 */
w.ofRun = async (o: { onBody: number; gapMs: number; holdMs: number; tailMs: number }) => {
	const view = EV!, cr = view.contentDOM.getBoundingClientRect();
	const line = view.state.doc.line(1 + o.onBody), c = view.coordsAtPos(line.from);
	if (!c) throw new Error("body line not drawn");
	const cx = cr.left + 120, cy = (c.top + c.bottom) / 2, r = 9;
	samples.length = 0; frameNo = 0; sampling = true; mark = "rest";
	requestAnimationFrame(tick);
	await settle(6);
	mark = "O";
	pen("pointerdown", cx + r, cy, 1);
	for (let j = 1; j <= 24; j++) {
		const a = (j / 24) * Math.PI * 2;
		pen("pointermove", cx + r * Math.cos(a), cy + r * Math.sin(a), 1);
		if (j % 6 === 0) await frame();
	}
	pen("pointerup", cx + r, cy, 0);
	mark = "lifted";
	await sleep(o.gapMs);
	mark = "pen2";
	const x2 = cx + 160;
	pen("pointerdown", x2, cy, 1);
	const t2 = performance.now();
	for (let j = 1; performance.now() - t2 < o.holdMs; j++) { pen("pointermove", x2 + (j % 8), cy, 1); await frame(); }
	pen("pointerup", x2 + 8, cy, 0);
	mark = "tail";
	await sleep(o.tailMs);
	sampling = false;
	await settle(2);
	return { order: ORDER, samples: samples.slice(), times: { claimAt: r3(claimAt), claimDoneAt: r3(claimDoneAt), textAt: r3(textAt), blockAt: r3(blockAt), rowAt: r3(rowAt) },
		strokes: inlineInk.strokes(PATH).length, frontmatterEnd: frontmatterEnd(view.state.doc) };
};
