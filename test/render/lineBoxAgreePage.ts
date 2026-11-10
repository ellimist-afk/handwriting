/**
 * The PanBakeRepaint page plus one read of each drawn anchored line's top by the two readers the line anchors hold: the height
 * map over pxPerWorld, and the line box top the anchors last read in a measure (LineAnchors.boxTops). Their difference is in
 * screen px at the overlay's scale; and where each line's anchored ink is shown against its box. Used by LineBoxAgree.test.ts.
 */
import "./panBakeRepaintPage";
import { inlineInk, overlayForPath } from "../../src/inline/InkOverlay";

(window as any).panBake.boxAgree = () => {
	const o: any = overlayForPath("Untitled 1.md");
	const view = o.view, path = o.filePath(), doc = view.state.doc, layout = o.lineLayout();
	const src = inlineInk.strokes(path) as any[];
	const anchored = new Map<number, string[]>();
	for (const s of src) {
		const n = s.lineAnchor?.line;
		if (n === undefined) continue;
		const ids = anchored.get(n) ?? [];
		ids.push(s.id);
		anchored.set(n, ids);
	}
	const vp = view.viewport, first = doc.lineAt(vp.from).number, last = doc.lineAt(vp.to).number;
	const stored: Map<number, number> = o.lineAnchors.boxTops;
	const screen = o.cssScale * o.fontZoom;
	const lines = [...anchored.keys()].sort((a, b) => a - b).map(n => {
		const hm = layout ? layout.lineTop(n) / layout.pxPerWorld : NaN, box = stored.get(n);
		const strokes = anchored.get(n)!.map(id => src.find(s => s.id === id));
		const dys = strokes.map(s => o.lineAnchorDy(s) as number);
		// Where each stroke's anchor top is shown (its stored top plus its correction) against the line's box, world units.
		const inkGap = box === undefined ? null : Math.max(...strokes.map((s, i) => Math.abs(s.lineAnchor.top + dys[i]! - box)));
		return { n, drawn: n >= first && n <= last, hm, box: box ?? null, gapPx: box === undefined ? null : (box - hm) * screen,
			dy: [Math.min(...dys), Math.max(...dys)], inkGap };
	});
	const content = view.contentDOM as HTMLElement, rect = content.getBoundingClientRect();
	return { cssScale: o.cssScale, scaleY: view.scaleY, fontZoom: o.fontZoom, boxH: rect.height, layoutH: content.offsetHeight,
		rendered: rect.height / content.offsetHeight, devicePerWorld: o.camera.snapshot.zoom * (o.committedBacking ?? 0),
		drawn: [first, last], docLines: doc.lines,
		anchored: [...anchored.values()].reduce((a, ids) => a + ids.length, 0), boxCounts: { ...o.lineAnchors.boxCounts }, lines };
};

