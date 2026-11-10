/**
 * The line box read waits while the content is painted at a scale the overlay has not adopted (a zoom's lift where CodeMirror
 * measured first), and asks the next frame to try again. That retry is bounded: a mismatch that never clears (an editor inside
 * a scaled container) reads the boxes at most 8 frames after the first read, then waits for the next layout update, which
 * re-arms it. A mismatch that clears inside the bound is read at the frame it clears. The real box read on a bare overlay; the
 * view's window runs frames on demand, each frame its animation callbacks first, then the measures they and the frame before
 * asked for, as CodeMirror's own measure frame does.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors, type LineLayout } from "./LineAnchor";
import { computeBBox, type InkStroke } from "../ink/Stroke";

const LINES = 10;
const PITCH = 40;
const ZOOM = 1.5;
const LAYOUT_WIDTH = 600;
const doc = Text.of(Array.from({ length: LINES }, (_, i) => `line ${i + 1} words`));

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

type Req = { key: object; read: () => unknown; write: (m: unknown) => void };

/**
 * A bare overlay at a resting zoom of 1.5 with ink anchored on lines 2 and 5. `painted.scale` is the scale the content box is
 * painted at; the overlay holds 1.5. `frame()` runs one frame.
 */
function rig(path: string) {
	const layout = (): LineLayout => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * PITCH, pxPerWorld: 1 });
	const anchors = new LineAnchors(layout);
	anchors.setSignature({ width: 892, fontPx: 26, charWidth: 14 });
	const src = [2, 5].map((n) => strokeAt(`s${n}`, 10, (n - 1) * PITCH + 4));
	for (const s of src) anchors.anchorNew(path, s);
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.strokes = src;
	anchors.tracks(path, src);
	anchors.drawn(1, LINES);
	for (const s of src) expect(s.lineAnchor?.line, `premise: ${s.id} anchors on its line`).toBe(Number(s.id.slice(1)));

	const painted = { scale: ZOOM };
	const frames: Array<() => void> = [];
	let handles = 0;
	const win = {
		requestAnimationFrame: (f: () => void) => { frames.push(f); return ++handles; },
		cancelAnimationFrame: () => undefined,
		setTimeout: () => ++handles,
		clearTimeout: () => undefined,
	};
	const measures = new Map<object, Req>();
	const content = {
		offsetWidth: LAYOUT_WIDTH,
		offsetHeight: LINES * PITCH,
		getBoundingClientRect: () => ({ left: 0, top: 0, width: LAYOUT_WIDTH * painted.scale, height: LINES * PITCH * painted.scale }),
		childNodes: [] as unknown[],
	};
	const lineEls = Array.from({ length: LINES }, (_, i) => ({
		parentNode: content,
		nodeType: 1,
		classList: { contains: (c: string) => c === "cm-line" },
		getBoundingClientRect: () => ({ top: i * PITCH * ZOOM }),
	}));
	content.childNodes = lineEls;
	const view = {
		scaleY: ZOOM,
		state: { doc },
		viewport: { from: 0, to: doc.length },
		inView: true,
		hasFocus: true,
		documentTop: 0,
		contentDOM: content,
		dom: { isConnected: true, ownerDocument: { visibilityState: "visible", defaultView: win } },
		domAtPos: (pos: number) => ({ node: content, offset: doc.lineAt(pos).number - 1 }),
		requestMeasure: (req: Req) => { measures.set(req.key, req); },
	};
	const noop = () => {};
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		lineAnchorState: anchors,
		view,
		cssScale: ZOOM,
		scale: ZOOM,
		fontZoom: 1,
		filePath: () => path,
		lineAnchorsMoved: noop,
		lineAnchorPassTimer: 0,
		lineDrawnAt: 0,
		destroyed: false,
	});
	function frame(): void {
		for (const f of frames.splice(0)) f();
		const reqs = [...measures.values()];
		measures.clear();
		const read = reqs.map((r) => r.read());
		reqs.forEach((r, i) => r.write(read[i]));
	}
	return { overlay, anchors, painted, frame };
}

/** A layout update from the measure loop with no document change: the update-driven request (a zoom's layout, a resize). */
function layoutUpdate(): ViewUpdate {
	return {
		transactions: [], docChanged: false, geometryChanged: true, heightChanged: false, viewportChanged: false,
		startState: { doc }, state: { doc }, changes: undefined,
	} as unknown as ViewUpdate;
}

describe("the line box read's wait on the painted scale is bounded", () => {
	it("a mismatch of 2 percent that never clears reads at most 9 times over 60 frames", () => {
		// Defect: each waiting read asks the next frame for another, with no bound, so the boxes are measured every frame at rest.
		const { overlay, anchors, painted, frame } = rig("box-wait-persist.md");
		painted.scale = ZOOM * 1.02;
		overlay.requestLineBoxes();
		for (let i = 0; i < 60; i++) frame();
		expect(anchors.boxCounts.measures, "box reads over 60 frames").toBeLessThanOrEqual(9);
		expect(anchors.boxCounts.measures, "the wait still tries again for 8 frames").toBe(9);
		expect(anchors.boxCounts.reads, "every read waited: one rect each, no line read").toBe(anchors.boxCounts.measures);
	});

	it("a mismatch that clears at frame 3 reads the tops at frame 3", () => {
		const { overlay, anchors, painted, frame } = rig("box-wait-clears.md");
		painted.scale = ZOOM * 1.02;
		overlay.requestLineBoxes();
		frame();
		frame();
		expect(anchors.boxCounts.measures, "frames 1 and 2 waited").toBe(2);
		expect(anchors.boxCounts.reads, "frames 1 and 2 read no line").toBe(2);
		painted.scale = ZOOM;
		frame();
		expect(anchors.boxCounts.measures, "frame 3 read").toBe(3);
		// The rendered scale's rect, the document top's, and lines 2 and 5.
		expect(anchors.boxCounts.reads - 2, "frame 3 read both anchored lines' boxes").toBe(4);
		for (let i = 0; i < 20; i++) frame();
		expect(anchors.boxCounts.measures, "nothing more read once the scale agrees").toBe(3);
	});

	it("a layout update after the bound re-arms the wait for another 8 frames", () => {
		// Defect: a count that only a read with no wait resets leaves the surface without box reads after one bounded episode,
		// so a later zoom's lift where CodeMirror measured first is never read again.
		const { overlay, anchors, painted, frame } = rig("box-wait-rearm.md");
		painted.scale = ZOOM * 1.02;
		overlay.requestLineBoxes();
		for (let i = 0; i < 30; i++) frame();
		expect(anchors.boxCounts.measures, "premise: first episode bounded").toBe(9);
		overlay.updateLineAnchors(layoutUpdate());
		for (let i = 0; i < 30; i++) frame();
		expect(anchors.boxCounts.measures, "the layout update read once and tried again 8 frames").toBe(18);
	});

	it("a read with no wait resets the count: a later waiting retry runs its 8 frames again", () => {
		const { overlay, anchors, painted, frame } = rig("box-wait-reset.md");
		painted.scale = ZOOM * 1.02;
		overlay.requestLineBoxes();
		for (let i = 0; i < 5; i++) frame();
		painted.scale = ZOOM;
		frame();
		expect(anchors.boxCounts.measures, "premise: five waits, then a read").toBe(6);
		painted.scale = ZOOM * 1.02;
		overlay.requestLineBoxes();
		for (let i = 0; i < 30; i++) frame();
		expect(anchors.boxCounts.measures, "a fresh episode of 9 reads after the read with no wait").toBe(15);
	});
});
