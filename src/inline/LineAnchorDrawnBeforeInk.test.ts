/**
 * Ink line anchors: the drawn-line record runs from the mount whether or not the note's ink has loaded, and it never starts
 * from nothing.
 *
 * Before this, the overlay recorded drawn lines only once
 * the note had strokes, so a note opened at its top whose ink loaded after the first draw started its measured prefix at
 * the first scroll step instead, which begins below line 1 and so never joins it. Old ink below the first screen was not
 * anchored until line 1 was drawn again. Here the real updateLineAnchors, lineAnchorInkLoaded and lineSignatureMeasured
 * (the signature measure's write) run on a bare overlay instance over a CodeMirror Text and a viewport the test sets; the store holds the ink through
 * its host. A line drawn in one update joins the prefix at the measure loop's update after it, which reads it. Asserted: lines
 * drawn before the ink loads start the prefix; ink landing on measured lines, or on lines shown that the next measure reads,
 * arms the old-ink pass; a scroll down from there extends the prefix; another note's record starts from the first update that
 * brings no document change; a new signature starts the record again from the lines shown in that same measure. Also: the
 * record keeps each line's measured height, and a line break typed while the note has no anchored ink moves the heights
 * below it with their lines instead of dropping them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { LineAnchors } from "./LineAnchor";
import { emptyPage, type ParseResult } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const SIG = { width: 892, fontPx: 26, charWidth: 14 };
const LINE_PX = 24;
let serial = 0;
const paths = new Set<string>();

afterEach(() => {
	for (const p of paths) inlineInk.handleDelete(p);
	paths.clear();
});

function stroke(id: string, y: number): InkStroke {
	return {
		id, tool: "pen", color: "#000000", width: 2, createdAt: 0,
		points: [{ x: 10, y, pressure: 0.5, t: 0 }, { x: 20, y: y + 10, pressure: 0.5, t: 8 }],
		bbox: { x: 10, y, width: 10, height: 10 },
	};
}

/** A note of `lines` lines and `strokes` strokes whose ink loads only when `load` is called; the overlay's view shows `doc`. */
function rig(lines: number, strokes: number) {
	const path = `drawn-before-ink-${++serial}.md`, pageId = `drawn-before-ink-id-${serial}`;
	paths.add(path);
	inlineInk.attachHost({
		readPageId: (p: string) => (p === path ? pageId : null),
		claimId: async () => ({ pageId }),
		loadSidecar: async (): Promise<ParseResult> => {
			const page = emptyPage(pageId);
			page.surface = "inline";
			for (let i = 0; i < strokes; i++) page.strokes.push(stroke(`s${i}`, 40 + i * 30));
			return { data: page, recovered: false };
		},
		scheduleSidecar() {},
		scheduleSidecarNow: async () => {},
		notify() {},
	} as never);
	const doc = Text.of(Array.from({ length: lines }, (_, i) => `line ${i + 1}`));
	const timers: number[] = [];
	let file = path;
	// The overlay reaches its window through winRef, a prototype getter over the view's document: the pass's timer lands here.
	const win = { setTimeout: vi.fn((_f: () => void, ms: number) => { timers.push(ms); return timers.length; }), clearTimeout: () => undefined };
	const view = { viewport: { from: 0, to: 0 }, defaultLineHeight: LINE_PX, defaultCharacterWidth: 9, state: { doc }, requestMeasure: () => undefined,
		dom: { ownerDocument: { defaultView: win } } };
	// Every line LINE_PX tall, over the document the view shows now.
	const anchors = new LineAnchors(() => ({ lines: view.state.doc.lines, lineText: (n) => view.state.doc.line(n).text, lineTop: (n) => (n - 1) * LINE_PX,
		pxPerWorld: 1 }));
	anchors.setSignature(SIG);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const overlay = Object.create(InkOverlayPlugin.prototype) as any;
	// Object.create skips the field initialisers; the zoom hold reads pinchScaleNow, 1 at rest.
	overlay.pinchScaleNow = 1;
	Object.assign(overlay, { filePath: () => file, view, lineAnchorState: anchors, lineAnchorPassTimer: 0, lineDrawnAt: 0 });
	/** The viewport over lines `a` to `b`, 1-based. */
	const show = (a: number, b: number): void => {
		view.viewport = { from: view.state.doc.line(a).from, to: view.state.doc.line(b).to };
	};
	/** An editor update with no document change, from the measure loop (no transaction) unless `transaction`. */
	const update = (flags: { viewportChanged?: boolean; geometryChanged?: boolean; heightChanged?: boolean; transaction?: boolean }): void =>
		overlay.updateLineAnchors({ docChanged: false, viewportChanged: false, geometryChanged: false, ...flags, transactions: flags.transaction ? [{}] : [],
			state: view.state, startState: view.state });
	/** The measure after an update that drew lines: it reads them, and the height it finds moves the line's. */
	const measured = (): void => update({ heightChanged: true });
	/** A line break typed at the end of line `n`, as the editor's update brings it: a document change and nothing else. */
	const enter = (n: number): void => {
		const startState = view.state, changes = ChangeSet.of({ from: startState.doc.line(n).to, insert: "\n" }, startState.doc.length);
		view.state = { doc: changes.apply(startState.doc) };
		overlay.updateLineAnchors({ docChanged: true, viewportChanged: false, heightChanged: false, geometryChanged: true, transactions: [{}], changes, startState,
			state: view.state });
	};
	return {
		path, anchors, overlay, timers, show, update, measured, enter,
		load: () => inlineInk.ensureLoaded(path),
		switchTo: (other: string) => { file = other; paths.add(other); },
	};
}

describe("ink line anchors: the drawn-line record runs from the mount, before the ink loads", () => {
	it("a note opened at its top: the lines drawn before its ink loads start the prefix, the ink arms the pass, a scroll down extends it", async () => {
		const r = rig(400, 5);
		r.show(1, 55);
		r.update({ viewportChanged: true, geometryChanged: true, transaction: true });
		expect(r.anchors.measuredThrough, "drawn at the mount, not yet measured").toBe(0);
		r.measured();
		expect(inlineInk.strokes(r.path).length, "the ink has not loaded").toBe(0);
		expect(r.anchors.measuredThrough, "lines 1 to 55 drawn and measured at the mount, before the ink").toBe(55);
		expect(r.timers, "no ink: no old-ink pass").toEqual([]);
		await r.load();
		expect(inlineInk.strokes(r.path).length).toBe(5);
		r.overlay.lineAnchorInkLoaded(r.path);
		expect(r.timers.length, "the ink landed on measured lines: the old-ink pass is armed").toBe(1);
		r.overlay.lineAnchorPassTimer = 0;
		r.show(25, 110);
		r.update({ viewportChanged: true });
		expect(r.anchors.measuredThrough, "the scroll step's new lines wait for the measure that reads them").toBe(55);
		expect(r.timers.length, "lines shown under ink that the next measure reads: the pass is armed again").toBe(2);
		r.measured();
		expect(r.anchors.measuredThrough, "the first scroll step down joins the lines drawn at the mount").toBe(110);
	});

	it("ink that loads before any line is measured arms nothing; the first draw does", async () => {
		const r = rig(400, 5);
		await r.load();
		r.overlay.lineAnchorInkLoaded(r.path);
		expect(r.timers, "nothing measured yet").toEqual([]);
		r.show(1, 55);
		r.update({ geometryChanged: true });
		expect(r.anchors.measuredThrough, "drawn, not yet measured").toBe(0);
		expect(r.timers.length, "the pass marks them once the editor is quiet").toBe(1);
		r.measured();
		expect(r.anchors.measuredThrough).toBe(55);
	});

	it("another note: its record starts from the first update with no document change, and a new signature from the same measure", () => {
		const r = rig(400, 0);
		r.show(1, 55);
		r.update({ geometryChanged: true });
		r.measured();
		expect(r.anchors.measuredThrough).toBe(55);
		r.switchTo(`drawn-before-ink-other-${serial}.md`);
		r.update({});
		r.measured();
		expect(r.anchors.measuredThrough, "the other note's record took the lines drawn now, not nothing").toBe(55);
		r.overlay.lineSignatureMeasured({ width: 700, fontPx: 26, charWidth: 14 });
		expect(r.anchors.measuredThrough, "a new signature: the record starts again").toBe(0);
		r.measured();
		expect(r.anchors.measuredThrough, "from the lines shown in this measure").toBe(55);
		r.show(30, 120);
		r.update({ viewportChanged: true });
		r.measured();
		expect(r.anchors.measuredThrough, "so a scroll down after it extends the prefix, as before the signature changed").toBe(120);
	});

	it("a line break typed before the ink anchors: the heights below it move with their lines, so the prefix holds past it", () => {
		const r = rig(400, 0);
		r.show(1, 55);
		r.update({ geometryChanged: true });
		r.measured();
		r.show(50, 110);
		r.update({ viewportChanged: true });
		r.measured();
		expect(r.anchors.measuredThrough).toBe(110);
		r.show(1, 55);
		r.enter(1);
		expect(r.anchors.changedLines).toEqual({ from: 1, to: 2 });
		expect(r.anchors.measuredThrough, "lines 1 and 2 drawn in the change's own update, under the editor's guess").toBe(0);
		r.measured();
		expect(r.anchors.measuredThrough, "measured after it; lines 2 to 110 are now 3 to 111, their heights kept").toBe(111);
	});
});
