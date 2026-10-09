/**
 * A PDF in-place document switch in the middle of a live drag.
 * forgetHistory() and resetGestureState() left `liveDirty` set, so the new
 * document inherited "a live op is unwritten" and its next gesture wrote its
 * ink file with no change in it.
 * Rig as CX5DeleteDuringDrag.test.ts, with a document id that can change.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeBBox, InkStroke } from "../ink/Stroke";
import { InkOp } from "../inline/InkHistory";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { PenSample } from "../input/PointerRouter";
import { PageBox } from "./PageMap";

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current, viewerCanvasOf: () => null }));
import { PdfInkController } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";

const sample = (x: number, y: number): PenSample => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

function rig() {
	const points = Array.from({ length: 50 }, (_, i) => ({ x: 100 + (i % 11), y: 100 + (i % 11), pressure: 0.5, t: i }));
	let ink: InkStroke[] = [{ id: "picked", points, bbox: computeBBox(points, 2), tool: "pen", color: "#000000", width: 2, createdAt: 0, page: 1 }];
	const ops: InkOp[] = [];
	const context = { clearRect() {}, save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {} };
	const boxes: PageBox[] = [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800 }];
	const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add() {}, remove() {} }, querySelector: () => null };
	probe.current = { scroller, scaleFactor: 2, scaleSource: "test", pages: boxes.map((b) => ({ ...b, hasCanvas: true })) };
	const frames = new Map<number, () => void>();
	let next = 0;
	const win = {
		devicePixelRatio: 1, clearTimeout() {}, setTimeout: () => 0,
		requestAnimationFrame: (fn: () => void) => { frames.set(++next, fn); return next; },
		cancelAnimationFrame: (id: number) => frames.delete(id),
	};
	// A drag applies its move in the next animation frame (editFrame).
	const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); };
	const doc = { id: "pdf-A" };
	const persist = vi.fn();
	const controller = new PdfInkController({} as HTMLElement, win as unknown as Window,
		(page) => ink.filter((s) => s.page === page), () => doc.id, () => ink,
		(op) => { ops.push(op); ink = applyOp(ink, op); }, () => {}, () => {}, persist);
	const pen = controller as unknown as {
		boundScroller: unknown; wetOn(page: number): unknown; cameraFor(box: PageBox): unknown;
		penDown(s: PenSample, ev?: PointerEvent): void; penRaw(s: PenSample[]): void; penUp(ev?: PointerEvent): void;
		liveDirty: boolean;
	};
	pen.boundScroller = scroller;
	pen.wetOn = () => ({ wetCanvas: { getContext: () => context }, wet: { clear() {} }, tail: { clear() {} } });
	pen.cameraFor = () => ({ x: 0, y: 0, zoom: 2 });
	const writes = (id: string) => persist.mock.calls.filter((c) => c[0] === id).length;
	return { controller, pen, doc, writes, flush, ink: () => ink };
}

describe("a PDF document switch in the middle of a live drag", () => {
	beforeEach(() => resetTipModeForTest());

	function dragThenSwitch(r: ReturnType<typeof rig>): void {
		// Select the stroke with a barrel-button lasso, then drag it live.
		r.pen.penDown(sample(150, 150), { buttons: 2, button: 2, pointerType: "pen" } as PointerEvent);
		r.pen.penRaw([sample(250, 150), sample(250, 250), sample(150, 250), sample(150, 150)]);
		r.pen.penUp();
		expect(r.controller.hasSelection, "precondition: the lasso selected the stroke").toBe(true);
		r.pen.penDown(sample(205, 205));
		r.pen.penRaw([sample(225, 235)]);
		r.flush();
		expect(r.pen.liveDirty, "precondition: the drag applied a live move").toBe(true);
		r.doc.id = "pdf-B";
		r.controller.forgetHistory();
	}

	it("the switch does not carry the old document's unwritten move onto the new one", () => {
		const r = rig();
		dragThenSwitch(r);
		expect(r.pen.liveDirty, "the new document inherits 'a live op is unwritten'").toBe(false);
	});

	it("a gesture on the new document that changes nothing writes nothing", () => {
		const r = rig();
		dragThenSwitch(r);
		setTipMode("space");
		// Above the stroke, so the divider has ink below it (a space move
		// with none refuses at pen-down). No travel: it changes nothing.
		r.pen.penDown(sample(300, 100));
		expect((r.pen as unknown as { spaceLineY: number | null }).spaceLineY, "precondition: the space contact started").not.toBeNull();
		r.pen.penUp();
		expect(r.writes("pdf-B"), "the new document's ink file was written with no change in it").toBe(0);
	});
});
