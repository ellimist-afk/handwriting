/**
 * AUDIT PROBE R5-L-edge-1 (1.4.21 audit, read-only probe).
 *
 * Claim: `PdfInkController.snipSelection` takes the page image from
 * `viewerCanvasOf(pageEl)`, the LAST visible non-overlay canvas in the page
 * div. Under pdf.js 5.3.34 (Obsidian 1.13.7) a capped page canvas gets a
 * second canvas from PDFPageDetailView, inserted right AFTER the main canvas
 * (`s.firstElementChild.after(e)`), covering only the visible sub-rect of the
 * page: backing `width = c.width * pixelRatio`, placed at
 * `left = 100*c.minX/viewport.width %`, `top = 100*c.minY/viewport.height %`.
 * The snip then crops at `(vp.x0*k, vp.y0*k)` with `k = canvas.width / wPt`,
 * as if canvas pixel (0,0) were the page's top-left corner.
 *
 * The rig is PdfSnipDestination.test.ts's: the controller production builds
 * (`syncPdfControllers`), the real probe and the real `viewerCanvasOf`,
 * reading a fake pdf.js page div. Only `mount` is stubbed and `createEl` is a
 * recording canvas.
 *
 * ASSERTED (correct behaviour): the rect the snip copies out of whatever
 * canvas it picked, mapped back to page points through THAT canvas's placement
 * in the page div, is the snip's own page rect and covers the selected ink. A
 * control case with only the main canvas must pass the same assertion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HandwritingPlugin from "../main";
import { PdfInkController } from "../pdf/PdfInkController";
import { viewerCanvasOf } from "../pdf/PdfViewerProbe";
import { InkStroke, computeBBox } from "../ink/Stroke";

/** css px per PDF point (`--scale-factor`): a zoomed page. */
const SCALE = 4;
/** 300 x 400 pt page -> 1200 x 1600 css px. */
const PAGE_W = 1200;
const PAGE_H = 1600;
const DPR = 2;

/**
 * Uncapped the page canvas would be 2400 x 3200 = 7.68 MP, over Obsidian's
 * mobile maxCanvasPixels 5,242,880, so pdf.js caps the main canvas (factor
 * sqrt(5242880/7680000) = 0.826) and builds a detail view. Visible area
 * 300..1100 x 400..1200 css px; PDFPageDetailView.update pads it by
 * (sqrt(cap/(800*800*4)) - 1)/2 = 0.2156 of each side, clamped to the page:
 * minX 127.5, minY 227.5, width 1072.5, height 1145 (css px).
 */
const MAIN = { w: 1983, h: 2644, left: 0, top: 0, cssW: PAGE_W, cssH: PAGE_H };
const DETAIL = {
	w: 1072.5 * DPR,
	h: 1145 * DPR,
	left: 127.5,
	top: 227.5,
	cssW: 1072.5,
	cssH: 1145,
};

interface Call {
	op: string;
	args: unknown[];
}

function recordingCtx(calls: Call[]): CanvasRenderingContext2D {
	const state: Record<string, unknown> = { fillStyle: "#000000", strokeStyle: "#000000", globalAlpha: 1 };
	const methods: Record<string, (...a: unknown[]) => unknown> = {
		fill: (...args) => void calls.push({ op: "fill", args }),
		stroke: (...args) => void calls.push({ op: "stroke", args }),
		fillRect: (...args) => void calls.push({ op: "fillRect", args }),
		drawImage: (...args) => void calls.push({ op: "drawImage", args }),
	};
	return new Proxy(state, {
		get: (t, p) => (typeof p === "string" && p in methods ? methods[p] : p in t ? t[p as string] : () => undefined),
		set: (t, p, v) => {
			t[p as string] = v;
			return true;
		},
	}) as unknown as CanvasRenderingContext2D;
}

function strokeAt(xPt: number, yPt: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: xPt + i * 10, y: yPt + i * 3, pressure: 0.5, t: i * 8 }));
	return { id: "s1", tool: "pen", color: "#000000", width: 3, points, bbox: computeBBox(points, 3), createdAt: 0, page: 1 };
}

type Placement = typeof MAIN;

function fakeCanvas(p: Placement, page: Record<string, unknown>, detail: boolean): Record<string, unknown> {
	return {
		tagName: "CANVAS",
		width: p.w,
		height: p.h,
		hidden: false,
		offsetParent: page,
		offsetLeft: p.left,
		offsetTop: p.top,
		clientWidth: p.cssW,
		clientHeight: p.cssH,
		style: {
			left: `${(100 * p.left) / PAGE_W}%`,
			top: `${(100 * p.top) / PAGE_H}%`,
			width: `${(100 * p.cssW) / PAGE_W}%`,
			height: `${(100 * p.cssH) / PAGE_H}%`,
		},
		getAttribute: (n: string) => (detail && n === "aria-hidden" ? "true" : n === "role" && !detail ? "presentation" : null),
		getBoundingClientRect: () => ({
			left: p.left,
			top: p.top,
			x: p.left,
			y: p.top,
			width: p.cssW,
			height: p.cssH,
			right: p.left + p.cssW,
			bottom: p.top + p.cssH,
		}),
	};
}

async function rig(withDetail: boolean, stroke: InkStroke) {
	const g = globalThis as unknown as Record<string, unknown>;
	g.document ??= { body: { classList: { add: () => {}, toggle: () => {}, contains: () => false } } };

	const page: Record<string, unknown> = {
		tagName: "DIV",
		className: "page",
		parentElement: null,
		clientWidth: PAGE_W,
		clientHeight: PAGE_H,
		offsetTop: 0,
		offsetLeft: 0,
		clientTop: 0,
		clientLeft: 0,
		getAttribute: (n: string) => (n === "data-page-number" ? "1" : null),
		appendChild: () => {},
		setCssStyles: () => {},
		getBoundingClientRect: () => ({ left: 0, top: 0, x: 0, y: 0, width: PAGE_W, height: PAGE_H, right: PAGE_W, bottom: PAGE_H }),
	};
	const main = fakeCanvas(MAIN, page, false);
	const detail = fakeCanvas(DETAIL, page, true);
	// Document order inside .canvasWrapper: main canvas (prepended), then the
	// detail canvas (`firstElementChild.after`).
	const canvases = withDetail ? [main, detail] : [main];
	const placements = new Map<unknown, Placement>([
		[main, MAIN],
		[detail, DETAIL],
	]);
	page.querySelector = (sel: string) => (sel.startsWith("canvas") ? canvases[0] : null);
	page.querySelectorAll = (sel: string) => (sel.startsWith("canvas") ? canvases : []);
	page.createEl = () => ({
		width: 0,
		height: 0,
		parentElement: page,
		setAttribute: () => {},
		setCssStyles: () => {},
		getContext: () => recordingCtx([]),
		remove: () => {},
	});

	const scroller = {
		scrollTop: 0,
		scrollLeft: 0,
		querySelectorAll: (sel: string) => (sel === "div.page[data-page-number]" ? [page] : []),
		querySelector: (sel: string) => (sel === 'div.page[data-page-number="1"]' ? page : null),
	};
	const win = {
		devicePixelRatio: DPR,
		getComputedStyle: (el: unknown) => ({
			position: "relative",
			getPropertyValue: (p: string) => (p === "--scale-factor" && el === page ? String(SCALE) : ""),
		}),
	};
	const root = {
		isConnected: true,
		ownerDocument: { defaultView: win },
		querySelector: (sel: string) => (sel === ".pdf-viewer-container" ? scroller : null),
	};

	const strokes = [stroke];
	const plugin = Object.create(HandwritingPlugin.prototype) as Record<string, unknown>;
	plugin.loadData = (): Promise<unknown> => Promise.resolve({});
	plugin.saveData = (): Promise<void> => Promise.resolve();
	plugin.settingsTimer = null;
	plugin.settingsDirty = false;
	plugin.settingsWriting = null;
	plugin.settingsWriteAgain = false;
	plugin.saveSettingsNow = (): void => {};
	plugin.store = { useInkFolder: () => {}, load: () => null, schedule: () => {} };
	plugin.applyPaperTo = (): void => {};
	plugin.applyBooxMode = (): void => {};
	plugin.pdfStore = {
		attachHost: () => {},
		strokesOnPage: (_id: string, n: number) => strokes.filter((s) => s.page === n),
		strokes: () => strokes,
		replaceAll: () => {},
		replaceAllLive: () => {},
		save: () => {},
	};
	plugin.app = {
		workspace: {
			onLayoutReady: () => {},
			getLeavesOfType: (type: string) =>
				type === "pdf" ? [{ view: { containerEl: root, file: { path: "slides.pdf" } } }] : [],
		},
	};
	plugin.pdfInk = new Map();
	plugin.pdfFiles = new Map();
	plugin.pdfIds = new Map([[root, "doc-1"]]);
	plugin.pdfCalibration = false;
	plugin.resolvePdfId = (): Promise<void> => Promise.resolve();

	const proto = HandwritingPlugin.prototype as unknown as {
		loadSettings(this: unknown): Promise<void>;
		syncPdfControllers(this: unknown): void;
	};
	await proto.loadSettings.call(plugin);
	proto.syncPdfControllers.call(plugin);
	const controller = (plugin.pdfInk as Map<unknown, PdfInkController>).get(root);
	if (!controller) throw new Error("syncPdfControllers built no controller for the pdf leaf");

	const snipCalls: Call[][] = [];
	g.createEl = (): unknown => {
		const calls: Call[] = [];
		snipCalls.push(calls);
		const ctx = recordingCtx(calls);
		return {
			width: 0,
			height: 0,
			getContext: () => ctx,
			toBlob: (cb: (b: Blob | null) => void) =>
				cb(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" })),
		};
	};

	const priv = controller as unknown as { selected: string[]; selectionPage: number };
	priv.selected = [stroke.id];
	priv.selectionPage = 1;
	return { controller, page, main, detail, placements, snipCalls };
}

/** The drawImage source rect mapped back to page points through its canvas's placement. */
function sourceRectInPagePt(args: unknown[], placements: Map<unknown, Placement>) {
	const [src, sx, sy, sw, sh] = args as [object, number, number, number, number];
	const p = placements.get(src);
	if (!p) throw new Error("drawImage source is not one of the page's canvases");
	const cssPerPxX = p.cssW / p.w;
	const cssPerPxY = p.cssH / p.h;
	return {
		src,
		x0: (p.left + sx * cssPerPxX) / SCALE,
		y0: (p.top + sy * cssPerPxY) / SCALE,
		x1: (p.left + (sx + sw) * cssPerPxX) / SCALE,
		y1: (p.top + (sy + sh) * cssPerPxY) / SCALE,
	};
}

async function snipAndMap(withDetail: boolean, stroke: InkStroke) {
	const r = await rig(withDetail, stroke);
	const result = await r.controller.snipSelection();
	expect(result.ok, result.ok ? "" : `snip refused: ${result.reason}`).toBe(true);
	const calls = r.snipCalls[r.snipCalls.length - 1];
	if (!calls) throw new Error("the snip made no canvas");
	const draw = calls.find((c) => c.op === "drawImage");
	expect(draw, "the snip never drew the viewer's page").toBeTruthy();
	return { r, mapped: sourceRectInPagePt(draw!.args, r.placements) };
}

beforeEach(() => {
	vi.spyOn(PdfInkController.prototype, "mount").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	delete (globalThis as unknown as Record<string, unknown>).createEl;
});

describe("R5-L-edge-1: PDF snip background on a zoomed page with a pdf.js detail canvas", () => {
	// Ink at the middle of what is on screen: (150, 200) pt = (600, 800) css px.
	const stroke = strokeAt(150, 200);
	const bb = stroke.bbox;

	it("control: main canvas only - the crop maps back onto the selected ink", async () => {
		const { mapped } = await snipAndMap(false, stroke);
		expect(mapped.x0).toBeLessThanOrEqual(bb.x);
		expect(mapped.y0).toBeLessThanOrEqual(bb.y);
		expect(mapped.x1).toBeGreaterThanOrEqual(bb.x + bb.width);
		expect(mapped.y1).toBeGreaterThanOrEqual(bb.y + bb.height);
	});

	it("with the detail canvas present - the crop still maps back onto the selected ink", async () => {
		const { r, mapped } = await snipAndMap(true, stroke);
		// Preconditions: the trigger DOM is in place and the ink lies inside
		// both canvases' coverage, so either canvas holds the right pixels.
		expect(viewerCanvasOf(r.page as unknown as HTMLElement)).toBe(r.detail);
		const inDetail = (xPt: number, yPt: number) =>
			xPt * SCALE >= DETAIL.left &&
			xPt * SCALE <= DETAIL.left + DETAIL.cssW &&
			yPt * SCALE >= DETAIL.top &&
			yPt * SCALE <= DETAIL.top + DETAIL.cssH;
		expect(inDetail(bb.x - 8, bb.y - 8) && inDetail(bb.x + bb.width + 8, bb.y + bb.height + 8)).toBe(true);

		// Correct behaviour: the page region copied under the ink is the ink's.
		const got = `${mapped.src === r.detail ? "detail" : "main"} canvas, page rect (${mapped.x0.toFixed(1)}, ${mapped.y0.toFixed(1)})-(${mapped.x1.toFixed(1)}, ${mapped.y1.toFixed(1)}) pt; ink bbox (${bb.x.toFixed(1)}, ${bb.y.toFixed(1)})-(${(bb.x + bb.width).toFixed(1)}, ${(bb.y + bb.height).toFixed(1)}) pt`;
		expect(mapped.x0, got).toBeLessThanOrEqual(bb.x);
		expect(mapped.y0, got).toBeLessThanOrEqual(bb.y);
		expect(mapped.x1, got).toBeGreaterThanOrEqual(bb.x + bb.width);
		expect(mapped.y1, got).toBeGreaterThanOrEqual(bb.y + bb.height);
	});
});
