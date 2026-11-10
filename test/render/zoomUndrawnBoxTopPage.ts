/**
 * The issue 48 slide page plus one read of the stroke's line anchor against CodeMirror's drawn range and
 * the scroller's visible rect, and the steps the cell takes (scroll away, zoom, walk on, and the sensor's box write).
 * Used by ZoomUndrawnBoxTop.test.ts.
 */
import { frames } from "./issue48EmbedZoomPage";
import { inlineInk, overlayForPath } from "../../src/inline/InkOverlay";

const path = "issue-48.md";
const ov = () => overlayForPath(path) as any;

/** The committed layer's ink, as a client rect. One stroke exists, so every opaque pixel is it. */
function ink() {
	const canvas = ov().committedCanvas as HTMLCanvasElement, rect = canvas.getBoundingClientRect();
	if (!canvas.width || !canvas.height) return { count: 0, left: NaN, top: NaN, right: NaN, bottom: NaN };
	const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data, sx = rect.width / canvas.width, sy = rect.height / canvas.height;
	let count = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) if (data[(y * canvas.width + x) * 4 + 3]! > 10) {
		count++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
	}
	return { count, left: rect.left + minX * sx, top: rect.top + minY * sy, right: rect.left + (maxX + 1) * sx, bottom: rect.top + (maxY + 1) * sy };
}

/** The stroke's line, whether CodeMirror draws it, its box top on record and its height-map top (world units), and its ink. */
function state() {
	const o = ov(), view = o.view, doc = view.state.doc, s = inlineInk.strokes(path)[0] as any;
	const n: number | null = s?.lineAnchor?.line ?? null;
	const first = doc.lineAt(view.viewport.from).number, last = doc.lineAt(view.viewport.to).number;
	const layout = o.lineLayout();
	const box = n === null ? undefined : (o.lineAnchors.boxTops as Map<number, number>).get(n);
	const hm = layout && n !== null ? layout.lineTop(n) / layout.pxPerWorld : null;
	const i = ink(), v = view.scrollDOM.getBoundingClientRect();
	const inView = i.count > 0 && i.bottom > v.top && i.top < v.bottom && i.right > v.left && i.left < v.right;
	return { n, anchorTop: s?.lineAnchor?.top ?? null, drawn: [first, last], lineDrawn: n !== null && n >= first && n <= last,
		box: box ?? null, hm, dy: s ? o.lineAnchorDy(s) as number : null, scale: o.pinchScaleNow as number, scrollTop: view.scrollDOM.scrollTop,
		ink: i, viewport: { top: v.top, bottom: v.bottom }, inView,
		slides: [...view.contentDOM.querySelectorAll(".issue48-slide")].map((e: any) => Number(e.dataset.slide)) };
}

/**
 * Wait for the stroke's line to be read from its box. New ink is anchored at its commit, and the read is asked only by an
 * editor update that changes the viewport, the heights or the geometry (updateLineAnchors). On this rig a scroll inside
 * CodeMirror's drawn margin changes none of them (measured: no read after 240 frames and a 700 px scroll there and back), so
 * after 30 frames with no read the overlay's own request is made (requestLineBoxes, the call that update makes).
 */
async function settle(n: number) {
	let k = 0, nudged = false;
	for (; k < n; k++) {
		if (state().box !== null) break;
		if (!nudged && k >= 30) { nudged = true; ov().requestLineBoxes(true); }
		await frames(1);
	}
	return { ...state(), waited: k, nudged };
}

/** Scroll by `step` css px at a time until the stroke's line leaves CodeMirror's drawn range, then `extra` steps more. */
async function away(step: number, extra = 2) {
	const view = ov().view;
	for (let k = 0; k < 60; k++) {
		if (!state().lineDrawn) {
			for (let j = 0; j < extra; j++) { view.scrollDOM.scrollTop += step; await frames(6); }
			return { steps: k, stuck: false, after: state() };
		}
		const before = view.scrollDOM.scrollTop;
		view.scrollDOM.scrollTop += step; await frames(6);
		if (view.scrollDOM.scrollTop === before) return { steps: k, stuck: true, after: state() };
	}
	return { steps: 60, stuck: true, after: state() };
}

/** The zoom bar's step: the call the button makes. Read at the settle and after 60 quiet frames. */
async function zoom(f: number) {
	const ok = ov().zoomNoteBy(f);
	await frames(8); const settled = state(); await frames(60);
	return { ok, settled, quiet: state() };
}

/** After the zoom: up to `count` scroll steps of `step` css px, the read at each. */
async function walk(step: number, count: number) {
	const view = ov().view, out: ReturnType<typeof state>[] = [];
	for (let k = 0; k < count; k++) {
		const before = view.scrollDOM.scrollTop;
		view.scrollDOM.scrollTop += step; await frames(6);
		out.push(state());
		if (view.scrollDOM.scrollTop === before) break;
	}
	return out;
}

/**
 * SENSOR: the failure made on purpose by the path the sweep names. With the stroke's line not drawn, a box top is written for it
 * through the overlay's own box write (LineAnchors.boxesRead, then lineAnchorsMoved, as lineBoxesRead does), chosen so the ink
 * lands at the scroller's middle. LineAnchors.top then answers the line from that box, as it would from a stale one.
 */
async function plantBox() {
	const o = ov(), view = o.view, doc = view.state.doc, before = state(), layout = o.lineLayout(), s = inlineInk.strokes(path)[0] as any;
	const v = view.scrollDOM.getBoundingClientRect(), cx = v.left + v.width / 2, cy = v.top + v.height / 2;
	const pos = view.posAtCoords({ x: cx, y: cy });
	const mid = doc.lineAt(pos ?? view.viewport.from).number;
	const box = view.domAtPos(doc.line(mid).from).node as Node;
	const el = (box.nodeType === 1 ? box as HTMLElement : box.parentElement!).closest(".cm-line") as HTMLElement | null;
	const scale = view.dom.getBoundingClientRect().width / parseFloat(getComputedStyle(view.dom).width);
	const into = el ? (cy - el.getBoundingClientRect().top) / scale / layout.pxPerWorld : 0;
	const midWorld = layout.lineTop(mid) / layout.pxPerWorld + into;
	const target = s.lineAnchor.top + midWorld - s.bbox.y;
	const moved = o.lineAnchors.boxesRead(path, inlineInk.strokes(path), new Map([[before.n, target]]), 0);
	if (moved) o.lineAnchorsMoved(path);
	await frames(8);
	return { mid, target, moved, before, after: state() };
}

/** Why a line is or is not read from its box: each early exit of readLineBoxes, read the same way. */
async function why() {
	const o0 = ov(), before = { ...(o0.lineAnchors.boxCounts ?? {}) };
	o0.requestLineBoxes(true);
	await frames(6);
	const o = ov(), view = o.view, doc = view.state.doc, src = inlineInk.strokes(path) as any[], n = src[0]?.lineAnchor?.line;
	const first = doc.lineAt(view.viewport.from).number, last = doc.lineAt(view.viewport.to).number;
	const content = view.contentDOM as HTMLElement, rect = content.getBoundingClientRect();
	const lineEl = n ? view.domAtPos(doc.line(n).from).node : null;
	const el = lineEl ? ((lineEl as Node).nodeType === 1 ? lineEl as HTMLElement : (lineEl as Node).parentElement) : null;
	return { inView: view.inView, visibility: document.visibilityState, lineOnScreen: o.lineOnScreen(), cssScale: o.cssScale, fontZoom: o.fontZoom,
		live: content.offsetWidth > 0 ? rect.width / content.offsetWidth : null,
		boxLines: o.lineAnchors.boxLines(path, src, first, last), tracks: o.lineAnchors.tracks?.(path, src),
		anchor: src[0]?.lineAnchor ?? null, lineElTag: el ? `${el.tagName}.${el.className}` : null,
		closestLine: el?.closest?.(".cm-line") ? true : false, parentIsContent: el?.closest?.(".cm-line")?.parentElement === content,
		boxCountsBeforeAsk: before, boxCounts: { ...(o.lineAnchors.boxCounts ?? {}) }, boxTopsSize: (o.lineAnchors.boxTops as Map<number, number>).size };
}

(window as any).zoomBox = { state, settle, away, zoom, walk, plantBox, why };
