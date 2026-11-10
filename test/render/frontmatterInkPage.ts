/**
 * The page for FrontmatterInk.test.ts: the real CodeMirror editor with the real ink overlay, a note in the shape of the rig
 * vault's ATMS note (blank lines, then text), and the frontmatter shown the three ways the Properties in document setting
 * shows it.
 *
 * Visible (the setting's default): the frontmatter lines are hidden in the editor and the Properties block is drawn apart from
 * the text, above it in the sizer (readingDriftPage.ts hideFrontmatter: a block replace with no widget, so the hidden lines
 * take no height). Hidden: the same lines hidden, and no Properties block. Source: the same lines drawn as text, and no
 * Properties block. A switch is a decoration and block change only, never a document change, as in the app.
 *
 * The plugin's page-id write is the host's claim: on a note with no frontmatter it inserts `---`, the id line and `---` at
 * the top of the document, the change the editor receives when the file is written under it. Every ink-file write the store
 * asks for is counted and kept, so a cell can tell whether opening a note wrote its ink file.
 *
 * Every read reports, per stroke, where the surface shows it (its page top plus its line correction) against the top of the
 * body line it was drawn on, in editor px. It changes nothing.
 */
import { EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { Platform } from "obsidian";
import { inlineInk, inkOverlayExtension, overlayForPath, setInlineTool, setInkSizeMult, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
import { setInkColorHex } from "../../src/ink/InkColor";
import { setPenInk } from "../../src/inline/PenInk";
import { ABOVE_SEED, lineKey } from "../../src/inline/LineAnchor";
import { parsePage, serializePage } from "../../src/model/PageData";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";

Object.assign(Platform, { isMobile: false, isDesktop: true, isIosApp: false, isDesktopApp: true, isMobileApp: false, isPhone: false, isWin: true });
installObsidianDom();

const PATH = "ATMS.md";
const PAGE_ID = "5b0f6c1e-9a7d-4c2b-8e3f-1d2a3b4c5d6e";
const FONT_PX = 16, LINE_PX = 24, CONTENT_PAD = 32, PROPERTIES_PX = 46;
const w = window as unknown as Record<string, unknown>;
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await frame(); };
const r3 = (v: number) => Math.round(v * 1000) / 1000;

type Mode = "visible" | "hidden" | "source";

const ids = new Map<string, string>();
const sidecars = new Map<string, string>();
let claimWrites = 0, sidecarWrites = 0;
inlineInk.attachHost({
	readPageId: (p) => ids.get(p) ?? null,
	claimId: async (p, id) => {
		ids.set(p, id);
		// The page id goes into the note's frontmatter: on a note without one, the block is written at the top.
		if (EV && frontmatterEnd(EV.state.doc) === 0) {
			EV.dispatch({ changes: { from: 0, insert: `---\nhandwriting-page-id: ${id}\n---\n` } });
			claimWrites++;
		}
		return { pageId: id };
	},
	loadSidecar: async (id) => (sidecars.has(id) ? parsePage(sidecars.get(id)!, id) : null),
	scheduleSidecar: (id, page) => { sidecars.set(id, serializePage(page)); sidecarWrites++; },
	scheduleSidecarNow: async (id, page) => { sidecars.set(id, serializePage(page)); sidecarWrites++; },
	notify: () => {},
});

let EV: EditorView | null = null;
let PROPS: HTMLElement | null = null;

/** The frontmatter's last line, 1-based (its closing fence), or 0 when the note does not open with a closed block. */
function frontmatterEnd(doc: { lines: number; line(n: number): { text: string } }): number {
	if (doc.lines < 2 || doc.line(1).text !== "---") return 0;
	for (let n = 2; n <= doc.lines; n++) if (doc.line(n).text === "---") return n;
	return 0;
}

/** The Properties in document setting. */
const setMode = StateEffect.define<Mode>();
const modeField = StateField.define<Mode>({
	create: () => (globalThis as { __fmStartMode?: Mode }).__fmStartMode ?? "visible",
	update(v, tr) {
		for (const e of tr.effects) if (e.is(setMode)) v = e.value;
		return v;
	},
});
/** The frontmatter lines hidden unless in Source: a block replace with no widget, so they take no height. */
const hideField = StateField.define<DecorationSet>({
	create: (state) => hideOf(state),
	update: (d, tr) => (tr.docChanged || tr.effects.some((e) => e.is(setMode)) ? hideOf(tr.state) : d),
	provide: (f) => EditorView.decorations.from(f),
});
function hideOf(state: EditorState): DecorationSet {
	const b = new RangeSetBuilder<Decoration>();
	const end = frontmatterEnd(state.doc);
	if (end > 0 && state.field(modeField, false) !== "source") b.add(0, state.doc.line(end).to, Decoration.replace({ block: true }));
	return b.finish();
}
/** The Properties block above the text: drawn only in Visible, and only when the note has frontmatter. */
function showProperties(state: EditorState): void {
	if (PROPS) PROPS.style.display = state.field(modeField, false) === "visible" && frontmatterEnd(state.doc) > 0 ? "block" : "none";
}

const pen = (type: string, x: number, y: number, buttons: number) =>
	document.elementFromPoint(x, y)?.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 902, isPrimary: true, clientX: x, clientY: y, buttons, pressure: buttons ? 0.5 : 0 }));

/** The overlay's line geometry: px per world unit and line tops, editor px. */
function geometry() {
	const ov = overlayForPath(PATH) as any;
	const layout = ov?.lineLayout?.();
	if (!layout) throw new Error("no line layout");
	return { ov, layout };
}

/** What each stroke's row says: its body line, the line it is anchored to, and the shown offset to its body line. */
function rows(bodyLines: number[]) {
	const view = EV!, { ov, layout } = geometry(), px = layout.pxPerWorld, k = frontmatterEnd(view.state.doc);
	const list = inlineInk.strokes(PATH);
	return list.map((s: any, i: number) => {
		const body = bodyLines[i]!, line = k + 1 + body, dy = ov.lineAnchorDy(s);
		const shownTop = (s.bbox.y + dy) * px, lineTop = view.lineBlockAt(view.state.doc.line(line).from).top;
		return { body, docLine: line, anchorLine: s.lineAnchor ? s.lineAnchor.line : null, anchorText: s.lineAnchor ? view.state.doc.line(Math.min(s.lineAnchor.line, view.state.doc.lines)).text : null,
			bboxY: r3(s.bbox.y), dy: r3(dy), shownTop: r3(shownTop), lineTop: r3(lineTop), offset: r3(shownTop - lineTop) };
	});
}

w.fmMount = async (o: { text: string; sidecar?: string; paneW: number; paneH: number; mode?: Mode }) => {
	// The mode the next editor opens in: Visible unless a cell opens it in another first.
	(globalThis as { __fmStartMode?: Mode }).__fmStartMode = o.mode;
	setPenInk(true);
	setScrollExpansionEnabled(true);
	setInlineTool("pen");
	setInkColorHex("pen", "#ff00ff");
	setInkSizeMult("pen", 2);
	if (o.sidecar) { ids.set(PATH, PAGE_ID); sidecars.set(PAGE_ID, o.sidecar); }
	const pane = document.body.appendChild(document.createElement("div"));
	pane.className = "markdown-source-view mod-cm6 is-live-preview";
	pane.style.cssText = `position:relative;width:${o.paneW}px;height:${o.paneH}px;overflow:hidden`;
	const view = new EditorView({ parent: pane, state: EditorState.create({ doc: o.text, extensions: [
		EditorView.lineWrapping,
		editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path: PATH }, editor: {} }) as any),
		modeField,
		hideField,
		EditorView.updateListener.of((u) => { if (u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setMode)))) showProperties(u.state); }),
		inkOverlayExtension() as any[],
		EditorView.theme({ "&": { width: `${o.paneW}px`, height: `${o.paneH}px` }, ".cm-scroller": { overflowY: "auto", overflowX: "hidden" },
			".cm-content": { fontSize: `${FONT_PX}px`, lineHeight: `${LINE_PX}px`, fontFamily: "sans-serif", paddingTop: `${CONTENT_PAD}px` } }),
	] }) });
	// Obsidian's .cm-sizer wrapper (readingDriftPage.ts), with the Properties block drawn above the text in it.
	const content = view.contentDOM, sizer = document.createElement("div"), container = document.createElement("div");
	sizer.className = "cm-sizer";
	container.className = "cm-contentContainer";
	content.parentElement!.insertBefore(sizer, content);
	PROPS = sizer.appendChild(document.createElement("div"));
	PROPS.className = "metadata-container";
	PROPS.style.cssText = `height:${PROPERTIES_PX}px;box-sizing:border-box`;
	sizer.appendChild(container);
	container.appendChild(content);
	EV = view;
	showProperties(view.state);
	await settle(30);
	if (!overlayForPath(PATH)) return { error: "no overlay" };
	return { mounted: true, lines: view.state.doc.lines, frontmatterEnd: frontmatterEnd(view.state.doc), strokes: inlineInk.strokes(PATH).length, sidecarWrites };
};

/**
 * One short stroke per body line, inside the line's own box, each a column apart. Body line n is 0-based under the
 * frontmatter. A line given as "above:n" is drawn from above body line n's top (in the text's top padding) down to its
 * middle, so its top is above the line.
 */
w.fmDraw = async (bodyLines: Array<number | string>) => {
	const view = EV!, cr = view.contentDOM.getBoundingClientRect();
	for (let i = 0; i < bodyLines.length; i++) {
		// Read per stroke: the first stroke's claim can write the frontmatter above the body.
		const k = frontmatterEnd(view.state.doc);
		const spec = bodyLines[i]!, above = typeof spec === "string" && spec.startsWith("above:"), n = above ? Number((spec as string).slice(6)) : (spec as number);
		const line = view.state.doc.line(k + 1 + n), c = view.coordsAtPos(line.from);
		if (!c) throw new Error("body line " + n + " not drawn");
		const x0 = cr.left + 60 + i * 90;
		if (above) {
			const y0 = c.top - 14, y1 = (c.top + c.bottom) / 2;
			pen("pointerdown", x0, y0, 1);
			for (let j = 1; j <= 12; j++) pen("pointermove", x0 + j * 5, y0 + ((y1 - y0) * j) / 12, 1);
			pen("pointerup", x0 + 60, y1, 0);
		} else {
			const y = (c.top + c.bottom) / 2;
			pen("pointerdown", x0, y - 4, 1);
			for (let j = 1; j <= 12; j++) pen("pointermove", x0 + j * 5, y + (j % 2 ? 4 : -4), 1);
			pen("pointerup", x0 + 60, y - 4, 0);
		}
		await settle(10);
	}
	await settle(20);
	return { strokes: inlineInk.strokes(PATH).length, claimWrites, sidecarWrites, lines: view.state.doc.lines, frontmatterEnd: frontmatterEnd(view.state.doc) };
};

w.fmRead = async (bodyLines: number[]) => {
	await settle(12);
	const id = ids.get(PATH);
	return { mode: EV!.state.field(modeField), frontmatterEnd: frontmatterEnd(EV!.state.doc), rows: rows(bodyLines), sidecarWrites,
		sidecar: id ? sidecars.get(id) ?? null : null, text: EV!.state.doc.toString() };
};

w.fmMode = async (mode: Mode) => {
	EV!.dispatch({ effects: setMode.of(mode) });
	await settle(20);
	return { mode: EV!.state.field(modeField), properties: PROPS?.style.display ?? null };
};

/**
 * The saved page with every stroke anchored to the first body line rewritten as an older build wrote it under hidden
 * frontmatter: to line 1 (the opening fence), at the top it shared with the body, with the fence's text key and the empty
 * lines-above hash. A stroke whose top is just above the next line is anchored to the first body line too, so this can be
 * more than the first body line's stroke; that stroke is always among them.
 */
w.fmSavedLegacy = async (firstBody: number) => {
	const ov = overlayForPath(PATH) as any;
	ov?.lineAnchors?.fold?.();
	const raw = sidecars.get(ids.get(PATH)!);
	if (!raw) return { error: "no saved page" };
	const j = JSON.parse(raw), view = EV!, k = frontmatterEnd(view.state.doc), line = k + 1 + firstBody;
	// The anchors as the store holds them now, in the file's form (PageData.ts lineAnchorRecord): the last write may predate them.
	const live = new Map<string, any>();
	for (const s of inlineInk.strokes(PATH) as any[]) if (s.lineAnchor) live.set(s.id, s.lineAnchor);
	let rewritten = 0;
	for (const s of j.strokes ?? []) {
		const held = live.get(s.id);
		if (held) s.lineAnchor = { line: held.line, top: Math.round(held.top * 1000) / 1000, y: Math.round(held.y * 100) / 100, key: held.key, width: held.width, fontPx: held.fontPx };
		const a = s.lineAnchor;
		if (!a || (a.line !== 1 && a.line !== line)) continue;
		a.line = 1;
		a.key = lineKey("---");
		a.above = ABOVE_SEED;
		rewritten++;
	}
	return { sidecar: JSON.stringify(j), rewritten, anchors: (j.strokes ?? []).map((s: any) => s.lineAnchor ?? null) };
};
