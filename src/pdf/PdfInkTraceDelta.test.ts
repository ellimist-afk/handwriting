/**
 * The bug report's pen-down record (`recordDownUnsafe`, read back as "last
 * pen-down" in the controller's report) ends in the point where the ink will
 * be painted and its DELTA from the pen. That record is the evidence an
 * offset hunt starts from, so a page with the ink under the nib must read
 * DELTA 0.00, 0.00.
 *
 * At high zoom the overlay canvas covers only a BAND of the page
 * (`placeBanded`): its screen rectangle is the band's, not the page's. These
 * cells drive the record with a band painted on the overlay and the pen put
 * exactly where the band's raster puts the ink, and pin a page the band covers
 * whole to the lines the record has always printed.
 *
 * No layout here: the scroller, the overlay canvas and its page div are plain
 * objects carrying the rectangles and sizes a real pane would report.
 */
import { describe, expect, it } from "vitest";

import { PdfInkController } from "./PdfInkController";
import type { PageBandBox } from "./PageBand";
import type { PageBox } from "./PageMap";
import type { PenSample } from "../input/PointerRouter";

interface Scene {
	client: { x: number; y: number };
	scrollerRect: { left: number; top: number };
	scroll: { left: number; top: number };
	box: PageBox;
	scale: number;
	overlayRect: { left: number; top: number; width: number; height: number };
	paintedBand: PageBandBox | null;
	/** The page div's own size (clientWidth/clientHeight), or null for a canvas with no parent. */
	pageEl: { clientWidth: number; clientHeight: number } | null;
}

function record(scene: Scene): string {
	const controller = Object.create(PdfInkController.prototype) as PdfInkController;
	const o = scene.overlayRect;
	const canvas = {
		getBoundingClientRect: () => ({ left: o.left, top: o.top, width: o.width, height: o.height }),
		parentElement: scene.pageEl,
	} as unknown as HTMLCanvasElement;
	controller.overlays = new Map([
		[scene.box.pageNumber, { canvas, paintedScale: scene.scale, paintedCount: 1, paintedBand: scene.paintedBand }],
	]);
	controller.probe = (() => ({ scaleFactor: scene.scale })) as never;
	const scroller = {
		getBoundingClientRect: () => ({ left: scene.scrollerRect.left, top: scene.scrollerRect.top }),
		scrollLeft: scene.scroll.left,
		scrollTop: scene.scroll.top,
	} as unknown as HTMLElement;
	const ev = { clientX: scene.client.x, clientY: scene.client.y, pointerType: "pen" } as PointerEvent;
	// The pen path's own conversion: client to scroller, then to content.
	const sample: PenSample = {
		x: scene.client.x - scene.scrollerRect.left,
		y: scene.client.y - scene.scrollerRect.top,
		pressure: 0.5,
		timestamp: 0,
		tiltX: 0,
		tiltY: 0,
	};
	const content = { x: sample.x + scene.scroll.left, y: sample.y + scene.scroll.top };
	controller.recordDownUnsafe(ev, sample, scene.box, scene.scale, scroller, content);
	return controller.lastDownDebug ?? "";
}

// A letter page (612 x 792 pt) at 800%: 4896 x 6336 css px, far past the band.
const PAGE_800: PageBox = { pageNumber: 2, leftPx: 10, topPx: 20, widthPx: 4896, heightPx: 6336 };
const SCROLLER = { left: 100, top: 50 };

describe("the bug report's pen-down DELTA on a page the overlay covers only a band of", () => {
	it("a band in the middle of the page, ink under the nib: DELTA 0.00, 0.00", () => {
		// Page on screen at (100 + 10 - 2000, 50 + 20 - 3000) = (-1890, -2930);
		// the band starts 1800, 2800 css px into it, so the overlay sits at
		// (-90, -130). The pen at (500.5, 400.25) is page css (2390.5, 3330.25),
		// which the band's raster paints at -90 + 590.5 = 500.5, -130 + 530.25 = 400.25.
		const text = record({
			client: { x: 500.5, y: 400.25 },
			scrollerRect: SCROLLER,
			scroll: { left: 2000, top: 3000 },
			box: PAGE_800,
			scale: 8,
			overlayRect: { left: -90, top: -130, width: 1400, height: 1200 },
			paintedBand: { left: 1800, top: 2800, width: 1400, height: 1200 },
			pageEl: { clientWidth: 4896, clientHeight: 6336 },
		});
		expect(text).toContain("  overlay rect (-90.00, -130.00) size 1400.00x1200.00");
		expect(text).toContain("  ink lands at client (500.50, 400.25)  DELTA (0.00, 0.00)");
	});

	it("a band at the page's top-left corner, smaller than the page, ink under the nib: DELTA 0.00, 0.00", () => {
		// Scrolled to the top: the page and the band both start at (110, 70) on
		// screen, but the band is 1400 x 1200 of a 4896 x 6336 page. The pen at
		// (500.5, 400.25) is page css (390.5, 330.25), painted at 110 + 390.5, 70 + 330.25.
		const text = record({
			client: { x: 500.5, y: 400.25 },
			scrollerRect: SCROLLER,
			scroll: { left: 0, top: 0 },
			box: PAGE_800,
			scale: 8,
			overlayRect: { left: 110, top: 70, width: 1400, height: 1200 },
			paintedBand: { left: 0, top: 0, width: 1400, height: 1200 },
			pageEl: { clientWidth: 4896, clientHeight: 6336 },
		});
		expect(text).toContain("  ink lands at client (500.50, 400.25)  DELTA (0.00, 0.00)");
	});
});

describe("the bug report's pen-down record on a page the overlay covers whole: the lines it has always printed", () => {
	// 150%, the page div mid-resize: the overlay's rectangle (917.37 x 1187.11)
	// is not the probe's box (918 x 1188), so the record's ratio term is not 1
	// and its arithmetic shows in the second decimal.
	const BOX: PageBox = { pageNumber: 3, leftPx: 41, topPx: 10, widthPx: 918, heightPx: 1188 };
	const base: Scene = {
		client: { x: 412.25, y: 333.5 },
		scrollerRect: SCROLLER,
		scroll: { left: 0, top: 240 },
		box: BOX,
		scale: 1.5,
		overlayRect: { left: 141, top: -180, width: 917.37, height: 1187.11 },
		paintedBand: { left: 0, top: 0, width: 918, height: 1188 },
		pageEl: { clientWidth: 918, clientHeight: 1188 },
	};
	const TODAY = [
		"  client (412.25, 333.50)  type pen",
		"  sample (312.25, 283.50)  scroller rect (100.00, 50.00)  scroll (0.00, 240.00)",
		"  content (312.25, 523.50)  box page 3 at (41.00, 10.00) size 918.00x1188.00",
		"  scale 1.500000 (viewer says 1.500000)  page point (180.83, 342.33)",
		"  overlay rect (141.00, -180.00) size 917.37x1187.11",
		"  ink lands at client (412.06, 333.12)  DELTA (-0.19, -0.38)",
	].join("\n");

	it("the band is the whole page", () => {
		expect(record(base)).toBe(TODAY);
	});

	it("no band painted yet", () => {
		expect(record({ ...base, paintedBand: null })).toBe(TODAY);
	});

	it("the canvas has no page div", () => {
		expect(record({ ...base, pageEl: null })).toBe(TODAY);
	});
});
