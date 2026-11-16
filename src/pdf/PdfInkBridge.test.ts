/**
 * The pdf surface as the e-ink companion sees it (PdfInkBridge.ts).
 *
 * A stroke the companion drew in firmware arrives as viewport points and has
 * to become ink on the right page, in that page's own units, however far the
 * viewer had scrolled when the pen went down. These pin that mapping and the
 * cases where a stroke must be refused rather than stored somewhere wrong.
 *
 * No jsdom: the controller is built against the thinnest stubs it will hold
 * still for, as PdfAbandonStrokeOnSwitch.test.ts does, and the members the
 * bridge reads are supplied directly.
 */
import { describe, expect, it } from "vitest";

import { bridgePreviewWidth } from "../bridge/BridgePreviewWidth";
import type { BridgePoint } from "../bridge/BridgeProtocol";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { getInkSizeMult } from "../inline/InkOverlay";
import type { PdfBridgeSnapshot } from "./PdfInkBridge";
import { PdfInkController, pdfPenWidth } from "./PdfInkController";

interface Op {
	type: string;
	path: string;
	strokes: Array<{ page: number; points: Array<{ x: number; y: number }>; width: number; tool: string }>;
}

/** Two A5 pages, 420 pt wide, shown 840 px wide: two css px per page unit. */
const PAGE_1 = { pageNumber: 1, leftPx: 100, topPx: 50, widthPx: 840, heightPx: 1190 };
const PAGE_2 = { pageNumber: 2, leftPx: 100, topPx: 1260, widthPx: 840, heightPx: 1190 };

/** The viewer scrolled 300 px down, its content starting 20 px in from the viewport's left and 80 px from its top. */
const SNAPSHOT: PdfBridgeSnapshot = { boxes: [PAGE_1, PAGE_2], scaleFactor: 2, x0: -20, y0: -80 + 300, k: 1 };

const line = (x: number, y: number): BridgePoint[] => [
	{ x, y, pressure: 0.5, t: 0 },
	{ x: x + 40, y: y + 10, pressure: 0.6, t: 8 },
	{ x: x + 80, y: y + 20, pressure: 0.5, t: 16 },
];

function makeRig(opts: { ready?: boolean; documentId?: string | null } = {}) {
	const ops: Op[] = [];
	let synced = 0;
	const win = { devicePixelRatio: 1, innerWidth: 1000, innerHeight: 1400, clearTimeout: () => {}, setTimeout: () => 0, requestAnimationFrame: () => 0 };
	const controller = new PdfInkController(
		{ querySelector: () => null } as unknown as HTMLElement,
		win as unknown as Window,
		() => [],
		() => (opts.documentId === undefined ? "doc-1" : opts.documentId),
		() => []
	);
	const priv = controller as unknown as Record<string, unknown>;
	priv.emit = (op: Op) => void ops.push(op);
	priv.sync = () => void synced++;
	priv.inkReady = () => opts.ready ?? true;
	priv.pageSize = new Map([
		[1, { wPt: 420, hPt: 595 }],
		[2, { wPt: 420, hPt: 595 }],
	]);
	return { controller, priv, ops, synced: () => synced };
}

describe("a companion stroke landing on a pdf", () => {
	it("lands on the page under its first point, in that page's units", () => {
		const rig = makeRig();
		// Viewport (220, 130) is content (200, 350): 100 px into page 1 across, 300 px down it.
		expect(rig.controller.landBridgeStroke(line(220, 130), SNAPSHOT)).toBe(true);
		expect(rig.ops).toHaveLength(1);
		expect(rig.ops[0]).toMatchObject({ type: "add", path: "doc-1" });
		const stroke = rig.ops[0]!.strokes[0]!;
		expect(stroke.page).toBe(1);
		expect(stroke.tool).toBe("pen");
		expect(stroke.points[0]!.x).toBeCloseTo(50, 6);
		expect(stroke.points[0]!.y).toBeCloseTo(150, 6);
		expect(rig.synced()).toBe(1);
	});

	it("stores the nib a pen stroke on a pdf is built with", () => {
		const rig = makeRig();
		rig.controller.landBridgeStroke(line(220, 130), SNAPSHOT);
		expect(rig.ops[0]!.strokes[0]!.width).toBeCloseTo(pdfPenWidth(DEFAULT_PEN.baseWidth, getInkSizeMult("pen")), 6);
	});

	it("belongs to the second page when it starts there, measured from that page's corner", () => {
		const rig = makeRig();
		// Viewport (220, 1140) is content (200, 1360): 100 px down page 2.
		expect(rig.controller.landBridgeStroke(line(220, 1140), SNAPSHOT)).toBe(true);
		const stroke = rig.ops[0]!.strokes[0]!;
		expect(stroke.page).toBe(2);
		expect(stroke.points[0]!.x).toBeCloseTo(50, 6);
		expect(stroke.points[0]!.y).toBeCloseTo(50, 6);
	});

	it("uses the scroll position of the snapshot, not of the moment it lands", () => {
		const rig = makeRig();
		const later: PdfBridgeSnapshot = { ...SNAPSHOT, y0: SNAPSHOT.y0 + 400 };
		rig.controller.landBridgeStroke(line(220, 130), SNAPSHOT);
		rig.controller.landBridgeStroke(line(220, 130), later);
		const [a, b] = [rig.ops[0]!.strokes[0]!, rig.ops[1]!.strokes[0]!];
		// 400 css px further down the content is 200 page units.
		expect(b.points[0]!.y - a.points[0]!.y).toBeCloseTo(200, 6);
	});

	it("scales by the webview's own px, when its samples are not css px", () => {
		const rig = makeRig();
		const zoomed: PdfBridgeSnapshot = { ...SNAPSHOT, x0: 0, y0: 0, k: 0.5 };
		// Viewport (600, 400) is content (300, 200): page 1 at (100, 75).
		rig.controller.landBridgeStroke(line(600, 400), zoomed);
		const stroke = rig.ops[0]!.strokes[0]!;
		expect(stroke.points[0]!.x).toBeCloseTo(100, 6);
		expect(stroke.points[0]!.y).toBeCloseTo(75, 6);
	});

	describe("is refused, and nothing is stored", () => {
		it("without a snapshot", () => {
			const rig = makeRig();
			expect(rig.controller.landBridgeStroke(line(220, 130), null)).toBe(false);
			expect(rig.ops).toHaveLength(0);
		});

		it("with no points", () => {
			const rig = makeRig();
			expect(rig.controller.landBridgeStroke([], SNAPSHOT)).toBe(false);
			expect(rig.ops).toHaveLength(0);
		});

		it("while the document's ink has not been read", () => {
			const rig = makeRig({ ready: false });
			expect(rig.controller.landBridgeStroke(line(220, 130), SNAPSHOT)).toBe(false);
			expect(rig.ops).toHaveLength(0);
		});

		it("with no document", () => {
			const rig = makeRig({ documentId: null });
			expect(rig.controller.landBridgeStroke(line(220, 130), SNAPSHOT)).toBe(false);
			expect(rig.ops).toHaveLength(0);
		});

		it("on a page shown rotated", () => {
			const rig = makeRig();
			(rig.priv.rotated as Set<number>).add(1);
			expect(rig.controller.landBridgeStroke(line(220, 130), SNAPSHOT)).toBe(false);
			expect(rig.ops).toHaveLength(0);
		});

		it("when the viewer has no pages", () => {
			const rig = makeRig();
			expect(rig.controller.landBridgeStroke(line(220, 130), { ...SNAPSHOT, boxes: [] })).toBe(false);
			expect(rig.ops).toHaveLength(0);
		});
	});
});

describe("what the companion is told about a pdf's pen", () => {
	const probe = { pages: [PAGE_1], scaleFactor: 2, scroller: {} };

	it("is the width a stroke comes out at on screen: page units times the page's scale", () => {
		const rig = makeRig();
		rig.priv.probe = () => probe;
		rig.priv.router = { penOff: () => false };
		const pen = rig.controller.bridgePen();
		expect(pen).not.toBeNull();
		const want = bridgePreviewWidth(pdfPenWidth(DEFAULT_PEN.baseWidth, getInkSizeMult("pen"))) * 2;
		expect(pen!.width).toBeCloseTo(want, 2);
		expect(pen!.color).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("is nothing while the pen is switched off", () => {
		const rig = makeRig();
		rig.priv.probe = () => probe;
		rig.priv.router = { penOff: () => true };
		expect(rig.controller.bridgePen()).toBeNull();
	});

	it("is nothing until the document's ink has been read", () => {
		const rig = makeRig({ ready: false });
		rig.priv.probe = () => probe;
		rig.priv.router = { penOff: () => false };
		expect(rig.controller.bridgePen()).toBeNull();
	});

	it("is nothing when the viewer shows no page", () => {
		const rig = makeRig();
		rig.priv.probe = () => ({ ...probe, pages: [] });
		rig.priv.router = { penOff: () => false };
		expect(rig.controller.bridgePen()).toBeNull();
	});
});
