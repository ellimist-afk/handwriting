/**
 * ON A PDF PAGE THE INSERT-SPACE LINE IS DRAWN WHERE IT CUTS.
 *
 * A row the line crosses now splits at the line, so the line is drawn under the pen. It used to be drawn at the
 * crossed row's nearest edge, which was right while a crossed row moved or stayed whole, and now shows a seam that is
 * not the one that cuts. Rig as PdfSwitchMidDrag.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeBBox, type InkPoint, type InkStroke } from "../ink/Stroke";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { PenSample } from "../input/PointerRouter";
import { PageBox } from "./PageMap";

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current, viewerCanvasOf: () => null }));
import { PdfInkController } from "./PdfInkController";

const SCALE = 2;
/** A pen sample at a page point (the page sits at the scroller's origin, unscrolled). */
const at = (x: number, y: number): PenSample => ({ x: x * SCALE, y: y * SCALE, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
const pt = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5, t: 0 });
/** A stroke on page 1 drawn as the outline of the box left..right by top..bottom. */
const box = (id: string, left: number, right: number, top: number, bottom: number): InkStroke => {
	const points = [pt(left, top), pt(right, top), pt(right, bottom), pt(left, bottom), pt(left, top)];
	return { id, tool: "pen", color: "#000000", width: 2, points, bbox: computeBBox(points, 2), createdAt: 0, page: 1 };
};

/** A drawing whose strokes chain into one row from 931 to 1144. */
function drawing(): InkStroke[] {
	return [
		box("outer", 0, 90, 931, 990),
		box("chain", 40, 46, 960, 1035),
		box("small-box", 0, 60, 1027, 1053),
		box("tall-box", 30, 70, 1041, 1144),
		box("inner-1", 50, 80, 1058, 1144),
	];
}

function rig(ink: InkStroke[]) {
	const context = { clearRect() {}, save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {} };
	const boxes: PageBox[] = [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 1200, heightPx: 2400 }];
	const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add() {}, remove() {} }, querySelector: () => null };
	probe.current = { scroller, scaleFactor: SCALE, scaleSource: "test", pages: boxes.map((b) => ({ ...b, hasCanvas: true })) };
	const win = { devicePixelRatio: 1, clearTimeout() {}, setTimeout: () => 0, requestAnimationFrame: () => 0, cancelAnimationFrame() {} };
	const controller = new PdfInkController({} as HTMLElement, win as unknown as Window,
		(page) => ink.filter((s) => s.page === page), () => "pdf-A", () => ink, () => {}, () => {}, () => {}, vi.fn());
	const pen = controller as unknown as {
		boundScroller: unknown; wetOn(page: number): unknown; cameraFor(box: PageBox): unknown;
		penDown(s: PenSample, ev?: PointerEvent): void; penUp(ev?: PointerEvent): void;
		spaceLineY: number | null; spaceIds: string[];
	};
	pen.boundScroller = scroller;
	pen.wetOn = () => ({ wetCanvas: { getContext: () => context }, wet: { clear() {} }, tail: { clear() {} } });
	pen.cameraFor = () => ({ x: 0, y: 0, zoom: SCALE });
	return pen;
}

describe("a PDF insert-space line through a row is drawn under the pen", () => {
	beforeEach(() => {
		resetTipModeForTest();
		setTipMode("space");
	});

	it("the pen at 1055 crosses the drawing: the line is drawn at 1055, where the drawing splits", () => {
		const pen = rig(drawing());
		pen.penDown(at(50, 1055));
		expect(pen.spaceIds, "premise: the strokes whose middles lie below the line move").toEqual(["tall-box", "inner-1"]);
		expect(pen.spaceLineY, "the line is drawn at a row edge, not where it cuts").toBe(1055);
		pen.penUp();
	});

	it("control: a line in the clear gap below the drawing is drawn under the pen too", () => {
		const pen = rig([...drawing(), box("next", 0, 40, 1300, 1340)]);
		pen.penDown(at(50, 1200));
		expect(pen.spaceIds).toEqual(["next"]);
		expect(pen.spaceLineY).toBe(1200);
		pen.penUp();
	});
});
