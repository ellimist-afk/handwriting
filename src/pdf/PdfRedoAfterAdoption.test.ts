import { beforeEach, expect, it, vi } from "vitest";
import { computeBBox, InkStroke } from "../ink/Stroke";
import { InkOp } from "../inline/InkHistory";
import { resetTipModeForTest } from "../inline/TipMode";
import { PageBox } from "./PageMap";

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current, viewerCanvasOf: () => null }));
import { PdfInkController } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";

/**
 * Undo and redo on a PDF after the sync poll adopted another device's ink.
 *
 * The other device erased a stroke this one drew, whole or into pieces with
 * new ids, and the poll replaced this document's strokes with that file. The
 * undo of the draw then removes nothing. The redo must put back only what
 * that undo took, as the note surface does (RedoAfterSyncAdoption.test.ts),
 * or the erased stroke returns, is written to disk and syncs back.
 *
 * The op sink is main.ts's committed path: applyOp over the document's
 * strokes, then the whole list replaces the store's.
 */
function stroke(id: string, x = 100): InkStroke {
	const points = [{ x, y: 100, pressure: 0.5, t: 0 }, { x: x + 10, y: 110, pressure: 0.5, t: 8 }];
	return { id, points, bbox: computeBBox(points, 2), tool: "pen", color: "#000000", width: 2, createdAt: 0, page: 1 };
}

function rig() {
	let ink: InkStroke[] = [];
	const ops: InkOp[] = [];
	const boxes: PageBox[] = [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800 }];
	const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add() {}, remove() {} }, querySelector: () => null };
	probe.current = { scroller, scaleFactor: 1, scaleSource: "test", pages: boxes.map((b) => ({ ...b, hasCanvas: true })) };
	const win = {
		devicePixelRatio: 1, clearTimeout() {}, setTimeout: () => 0,
		requestAnimationFrame: () => 0, cancelAnimationFrame() {},
	};
	const controller = new PdfInkController({} as HTMLElement, win as unknown as Window,
		(page) => ink.filter((s) => s.page === page), () => "pdf-id", () => ink,
		(op) => { ops.push(op); ink = applyOp(ink, op); });
	const pen = controller as unknown as { emit(op: InkOp): boolean; historyStep(redo: boolean): boolean };
	return {
		ops,
		ids: () => ink.map((s) => s.id),
		/** A committed gesture: applied through the op sink and recorded for undo. */
		draw: (...strokes: InkStroke[]) => expect(pen.emit({ type: "add", path: "pdf-id", strokes })).toBe(true),
		/** The poll's completed adoption: the store holds the other file, the pane refreshes. */
		otherDeviceWrote(strokes: InkStroke[]) { ink = strokes; controller.refresh(); },
		undo: () => pen.historyStep(false),
		redo: () => pen.historyStep(true),
	};
}

beforeEach(() => resetTipModeForTest());

it("redo after an adoption does not lay a stroke back over the pieces another device erased it into", () => {
	const r = rig();
	r.draw(stroke("S"));
	r.otherDeviceWrote([stroke("piece-a", 100), stroke("piece-b", 106)]);
	expect(r.undo()).toBe(true); // S is not on the page; nothing changes
	expect(r.ids()).toEqual(["piece-a", "piece-b"]);
	expect(r.redo()).toBe(true);
	expect(r.ids()).toEqual(["piece-a", "piece-b"]);
});

it("redo after an adoption does not bring back a stroke another device erased whole", () => {
	const r = rig();
	r.draw(stroke("S"));
	r.otherDeviceWrote([]);
	expect(r.undo()).toBe(true);
	expect(r.redo()).toBe(true);
	expect(r.ids()).toEqual([]);
});

it("redo after an adoption puts back the strokes its undo took and not the one another device erased", () => {
	const r = rig();
	r.draw(stroke("S", 100), stroke("T", 200));
	r.otherDeviceWrote([stroke("T", 200)]);
	expect(r.undo()).toBe(true);
	expect(r.ids()).toEqual([]);
	expect(r.redo()).toBe(true);
	expect(r.ids()).toEqual(["T"]);
});

it("redo with no adoption between still restores exactly what the undo removed", () => {
	const r = rig();
	r.draw(stroke("S"));
	expect(r.undo()).toBe(true);
	expect(r.ids()).toEqual([]);
	expect(r.redo()).toBe(true);
	expect(r.ids()).toEqual(["S"]);
});
