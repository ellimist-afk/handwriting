/**
 * The time a pdf pen stroke stores. The note and slides surfaces start the builder at pen-down, so a point's `t` is
 * milliseconds since the stroke's first sample. The pdf pen path never started its builder, so each point stored the
 * browser's absolute event time (seven to nine digits after a window has been open for hours). Nothing drawn depends
 * on it: every reader takes differences inside one stroke, and the outline never reads `t`.
 *
 * Two things are held here. New pdf ink stores `t` relative to its first sample. And a stroke already on disk with
 * absolute `t` comes back with the same outline as the same stroke with relative `t`, so old ink is read as it is.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { strokeOutline } from "../ink/StrokeOutline";
import { computeBBox, InkStroke } from "../ink/Stroke";
import { resetTipModeForTest } from "../inline/TipMode";
import { PenSample } from "../input/PointerRouter";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { applyOp } from "./PdfInkHistory";
import { PageBox } from "./PageMap";

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current, viewerCanvasOf: () => null }));
import { PdfInkController } from "./PdfInkController";

const SCALE = 2;

function sample(x: number, y: number, timestamp: number): PenSample {
	return { x, y, pressure: 0.5, timestamp, tiltX: 0, tiltY: 0 };
}

/** A controller over one page, with every stroke it commits kept in `ink()`. */
function rig() {
	let ink: InkStroke[] = [];
	const boxes: PageBox[] = [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800 }];
	const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add() {}, remove() {} }, querySelector: () => null };
	probe.current = { scroller, scaleFactor: SCALE, scaleSource: "test", pages: boxes.map((b) => ({ ...b, hasCanvas: true })) };
	const context = {
		clearRect() {}, save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {},
		stroke() {}, strokeRect() {},
	};
	const win = {
		devicePixelRatio: 1, clearTimeout() {}, setTimeout: () => 0,
		requestAnimationFrame: () => 0, cancelAnimationFrame() {},
	};
	const controller = new PdfInkController(
		{} as HTMLElement,
		win as unknown as Window,
		(page) => ink.filter((s) => s.page === page),
		() => "pdf-id",
		() => ink,
		(op) => { ink = applyOp(ink, op); },
		() => {},
		() => {},
		vi.fn()
	);
	const pen = controller as unknown as {
		boundScroller: unknown;
		wetOn(page: number): unknown;
		cameraFor(box: PageBox): unknown;
		penDown(s: PenSample, ev?: PointerEvent): void;
		penRaw(s: PenSample[]): void;
		penUp(ev?: PointerEvent): void;
	};
	pen.boundScroller = scroller;
	// The wet layers only draw: every property and call on them answers a no-op.
	const quiet = (): unknown => new Proxy(function () {}, { get: () => quiet(), apply: () => quiet(), set: () => true });
	const pair = new Proxy({ wetCanvas: { getContext: () => context } } as Record<string, unknown>, {
		get: (t, k) => (k in t ? t[k as string] : quiet()),
		set: () => true,
	});
	pen.wetOn = () => pair;
	pen.cameraFor = () => ({ x: 0, y: 0, zoom: SCALE });
	return { pen, ink: () => ink };
}

describe("time stored by a pdf pen stroke", () => {
	beforeEach(() => resetTipModeForTest());

	it("stores t relative to the first sample, not the browser's event time", () => {
		const { pen, ink } = rig();
		pen.penDown(sample(200, 200, 100000), { buttons: 1, button: 0, pointerType: "pen" } as PointerEvent);
		pen.penRaw([sample(240, 220, 100016), sample(280, 260, 100032)]);
		pen.penUp();
		const stroke = ink()[0]!;
		expect(stroke, "the stroke was committed").toBeDefined();
		expect(stroke.points.map((p) => p.t)).toEqual([0, 16, 32]);
	});

	it("draws an old stroke with absolute t the same as the same stroke with relative t", () => {
		const base = [0, 16, 32, 48, 64].map((ms, i) => ({ x: 100 + i * 30, y: 100 + (i % 2) * 12, pressure: 0.5, t: ms }));
		const relative: InkStroke = {
			id: "s", tool: "pen", color: "#000000", width: 2, points: base,
			bbox: computeBBox(base, 2), createdAt: 0, page: 1,
		};
		const absolute: InkStroke = { ...relative, points: base.map((p) => ({ ...p, t: p.t + 5123456789 })) };
		const page = emptyPage("p1");
		page.strokes = [absolute];
		const loaded = parsePage(serializePage(page), "p1").data.strokes[0]!;
		expect(loaded.points[0]!.t).toBe(5123456789);
		const outline = strokeOutline(loaded);
		expect(outline, "the loaded stroke has an outline").not.toBeNull();
		expect(outline).toEqual(strokeOutline(relative));
	});
});
