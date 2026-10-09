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
 * Undo and redo of a partial erase on a PDF, after another device's ink was adopted.
 *
 * An erase is one replace step: the stroke it cut out, and the pieces it left.
 * Its undo takes the pieces out and puts the stroke back; its redo does the
 * reverse. If another device erased one of the strokes the step would take
 * out, and the sync poll adopted that file, the step must not run at all:
 * taking out the rest loses ink, and putting its strokes back lays ink over
 * what is there now. The note surface refuses such a step whole
 * (InkOverlay.applyInkOp); the PDF surface ran whatever part it could.
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
	const pen = controller as unknown as { emit(op: InkOp): boolean; historyStep(redo: boolean): boolean; refreshStrip(): void };
	const stripRefreshes = vi.spyOn(pen, "refreshStrip");
	return {
		ops,
		/** How many times the history strip was refreshed since the rig was built. */
		stripRefreshes: () => stripRefreshes.mock.calls.length,
		ids: () => ink.map((s) => s.id),
		/** A committed gesture: applied through the op sink and recorded for undo. */
		draw: (...strokes: InkStroke[]) => expect(pen.emit({ type: "add", path: "pdf-id", strokes })).toBe(true),
		/** A committed partial erase: `cut` leaves `pieces` in its place. */
		erase: (cut: InkStroke, pieces: InkStroke[]) =>
			expect(pen.emit({
				type: "replace", path: "pdf-id", removed: [cut], removedAt: [ink.indexOf(cut)],
				inserted: pieces, insertedAt: pieces.map((_, i) => ink.indexOf(cut) + i),
			})).toBe(true),
		/** The poll's completed adoption: the store holds the other file, the pane refreshes. */
		otherDeviceWrote(strokes: InkStroke[]) { ink = strokes; controller.refresh(); },
		undo: () => pen.historyStep(false),
		redo: () => pen.historyStep(true),
	};
}

beforeEach(() => resetTipModeForTest());

it("undoing a partial erase does nothing when another device erased one of its pieces", () => {
	const r = rig();
	const whole = stroke("S");
	const a = stroke("A", 100);
	const b = stroke("B", 106);
	r.draw(whole);
	r.erase(whole, [a, b]);
	r.otherDeviceWrote([a]); // the other device erased piece B
	r.undo();
	expect(r.ids(), "the undo took piece A out and laid the whole stroke back over what the other device erased").toEqual(["A"]);
});

it("redoing a partial erase does nothing when another device erased the stroke it would cut", () => {
	const r = rig();
	const whole = stroke("S");
	r.draw(whole);
	r.erase(whole, [stroke("A", 100), stroke("B", 106)]);
	expect(r.undo()).toBe(true);
	expect(r.ids()).toEqual(["S"]);
	r.otherDeviceWrote([]); // the other device erased the whole stroke
	r.redo();
	expect(r.ids(), "the redo laid the pieces back over a stroke the other device erased").toEqual([]);
});

it("undo and redo of a partial erase with nothing adopted between restore it and cut it again", () => {
	const r = rig();
	const whole = stroke("S");
	r.draw(whole);
	r.erase(whole, [stroke("A", 100), stroke("B", 106)]);
	expect(r.ids()).toEqual(["A", "B"]);
	expect(r.undo()).toBe(true);
	expect(r.ids()).toEqual(["S"]);
	expect(r.redo()).toBe(true);
	expect(r.ids()).toEqual(["A", "B"]);
});

it("a refused undo or redo of a partial erase refreshes the history strip, so its buttons match what is left to undo", () => {
	const r = rig();
	const whole = stroke("S");
	const a = stroke("A", 100);
	const b = stroke("B", 106);
	r.draw(whole);
	r.erase(whole, [a, b]);
	r.otherDeviceWrote([a]); // the other device erased piece B
	const before = r.stripRefreshes();
	expect(r.undo(), "a refused step still reports a step").toBe(true);
	expect(r.ids()).toEqual(["A"]);
	expect(r.stripRefreshes() - before, "the refused step consumed the entry and left the strip as it was").toBe(1);
});
