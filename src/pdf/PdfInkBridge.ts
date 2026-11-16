/**
 * The pdf surface as the e-ink companion sees it (src/bridge/): where the
 * viewer is on screen, what the pen looks like, and how a stroke the
 * companion drew in firmware becomes ink on a page.
 *
 * The note surface's twin (inline/InkOverlayBridge.ts). A companion stroke
 * joins the ordinary path where a finished stroke is emitted, so it is
 * stored against its page, drawn by the committed painter and undone like
 * any other.
 */
import { DEFAULT_PEN } from "../ink/PenStyle";
import { getInkColorHex } from "../ink/InkColor";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { bridgePreviewWidth } from "../bridge/BridgePreviewWidth";
import type { BridgeGeometry, BridgePen, BridgePoint, BridgeRect } from "../bridge/BridgeProtocol";
import type { BridgeSurface } from "../bridge/BridgeSession";
import { getInkSizeMult, getInlineTool } from "../inline/InkOverlay";
import { installMethods } from "../inline/InstallMethods";
import { tipMode } from "../inline/TipMode";
import { pageAt, toPagePoint, type PageBox } from "./PageMap";
import { pdfPenWidth, type PdfInkController } from "./PdfInkController";

/**
 * How a viewport point becomes a point in the viewer's scrolled content, and
 * where the pages were in that content, as it all stood at one moment. The
 * router's mapping is affine, so two probes through it are the whole of it.
 */
export interface PdfBridgeSnapshot {
	boxes: PageBox[];
	scaleFactor: number;
	/** Content coordinates of client (0, 0): the router's sample plus the scroll. */
	x0: number;
	y0: number;
	/** Sample units per client px. */
	k: number;
}

declare module "./PdfInkController" {
	interface PdfInkController {
		/** This controller's face toward the companion, made on first use. */
		bridgeFace?: BridgeSurface;
		/**
		 * The pen-ink contact now down, as the companion stands to it: "claimed" when the companion is delivering it, so its
		 * own ink is not kept; "open" when it may yet be; null for a contact the companion never draws.
		 */
		bridgeContact?: "claimed" | "open" | null;
		bridgeSurface(): BridgeSurface;
		bridgeGeometry(): BridgeGeometry | null;
		bridgePen(): BridgePen | null;
		bridgeSnapshot(): PdfBridgeSnapshot | null;
		landBridgeStroke(points: readonly BridgePoint[], snapshot: PdfBridgeSnapshot | null): boolean;
	}
}

const PROBE = 1000;

const probeEvent = (at: number): PointerEvent =>
	({ clientX: at, clientY: at, pointerType: "pen", pressure: 0.5, timeStamp: 0, tiltX: 0, tiltY: 0 }) as unknown as PointerEvent;

/** The part of `el` inside the viewport, or null when none of it is. */
function visibleRect(el: Element, vw: number, vh: number): BridgeRect | null {
	if (!el.isConnected) return null;
	const r = el.getBoundingClientRect();
	const x = Math.max(0, r.left), y = Math.max(0, r.top);
	const w = Math.min(vw, r.right) - x, h = Math.min(vh, r.bottom) - y;
	return w > 0 && h > 0 ? { x, y, w, h } : null;
}

	function bridgeSurface(this: PdfInkController): BridgeSurface {
		return (this.bridgeFace ??= {
			geometry: () => this.bridgeGeometry(),
			pen: () => this.bridgePen(),
			snapshot: () => this.bridgeSnapshot(),
			land: (points, snapshot) => this.landBridgeStroke(points, snapshot as PdfBridgeSnapshot | null),
		});
	}

	function bridgeGeometry(this: PdfInkController): BridgeGeometry | null {
		const scroller = this.probe()?.scroller;
		const win = scroller?.ownerDocument?.defaultView;
		if (!scroller || !win || !this.documentId()) return null;
		const vw = win.innerWidth, vh = win.innerHeight;
		const rect = visibleRect(scroller, vw, vh);
		if (!rect) return null;
		const exclude: BridgeRect[] = [];
		const strip = this.tools?.el;
		const stripRect = strip ? visibleRect(strip, vw, vh) : null;
		if (stripRect) exclude.push(stripRect);
		return { kind: "pdf", rect, exclude, viewport: { w: vw, h: vh }, dpr: win.devicePixelRatio || 1 };
	}

	function bridgePen(this: PdfInkController): BridgePen | null {
		// The companion draws one thing, an opaque pen line; every other use of
		// the tip stays with the webview. So does a document whose ink is not
		// loaded yet: a stroke that cannot be stored must not be drawn.
		if (getInlineTool() !== "pen" || tipMode() !== "nib" || (this.router?.penOff() ?? true) || !this.inkReady()) return null;
		const probed = this.probe();
		const box = probed?.pages[0];
		if (!probed || probed.scaleFactor === null || !box) return null;
		// Stored widths are in page units; on screen they are that times the page's scale.
		const scale = this.scaleFor(box, probed.scaleFactor);
		// And the width a stroke ordinarily comes out at, not the nib as selected (BridgePreviewWidth.ts).
		const width = bridgePreviewWidth(pdfPenWidth(DEFAULT_PEN.baseWidth, getInkSizeMult("pen"))) * scale;
		return { color: getInkColorHex("pen"), width: Math.round(width * 100) / 100 };
	}

	function bridgeSnapshot(this: PdfInkController): PdfBridgeSnapshot | null {
		const router = this.router;
		const probed = this.probe();
		if (!router || !probed || probed.scaleFactor === null) return null;
		if (!this.frame) router.refreshRect();
		const a = router.sampleFrom(probeEvent(0));
		const b = router.sampleFrom(probeEvent(PROBE));
		const k = (b.x - a.x) / PROBE;
		if (!Number.isFinite(k) || k <= 0) return null;
		return {
			boxes: probed.pages.map((p) => ({ pageNumber: p.pageNumber, leftPx: p.leftPx, topPx: p.topPx, widthPx: p.widthPx, heightPx: p.heightPx })),
			scaleFactor: probed.scaleFactor,
			x0: a.x + probed.scroller.scrollLeft,
			y0: a.y + probed.scroller.scrollTop,
			k,
		};
	}

	function landBridgeStroke(this: PdfInkController, points: readonly BridgePoint[], snapshot: PdfBridgeSnapshot | null): boolean {
		const id = this.documentId();
		const first = points[0];
		if (!id || !snapshot || !first || !this.inkReady()) return false;
		const content = (p: BridgePoint): { x: number; y: number } => ({ x: snapshot.x0 + p.x * snapshot.k, y: snapshot.y0 + p.y * snapshot.k });
		// A stroke belongs to the page its first point landed on, as a pen stroke does.
		const start = content(first);
		const box = pageAt(snapshot.boxes, start.x, start.y);
		if (!box || this.rotated.has(box.pageNumber)) return false;
		const scale = this.scaleFor(box, snapshot.scaleFactor);
		const builder = new StrokeBuilder("pen", getInkColorHex("pen"), pdfPenWidth(DEFAULT_PEN.baseWidth, getInkSizeMult("pen")));
		builder.start(0);
		for (const p of points) {
			const c = content(p);
			const at = toPagePoint(box, scale, c.x, c.y);
			if (at) builder.add(at.x, at.y, p.pressure, p.t);
		}
		const stroke = builder.finish();
		if (!stroke) return false;
		this.emit({ type: "add", path: id, strokes: [{ ...stroke, page: box.pageNumber }] });
		this.sync();
		return true;
	}

export function installPdfInkBridge(proto: PdfInkController): void {
	installMethods(proto, { bridgeSurface, bridgeGeometry, bridgePen, bridgeSnapshot, landBridgeStroke });
}
