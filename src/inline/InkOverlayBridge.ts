/**
 * The note surface as the e-ink companion sees it (src/bridge/): where the
 * note is on screen, what the pen looks like, and how a stroke the companion
 * drew in firmware becomes ink in the note.
 *
 * A companion stroke skips everything that exists to make live ink feel
 * right - the wet layer, prediction, smoothing behind the nib, the snap
 * dwell - because the firmware already showed the writer the line. It joins
 * the ordinary path at the point where a finished stroke is stored
 * (`handoffStrokes`, InkOverlayPenPath.ts), so its line anchor, its place in
 * the erase index and its undo step are the ones a pen stroke gets.
 */
import { type CameraState, screenToWorld } from "../camera/coordinates";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { getInkColorHex } from "../ink/InkColor";
import { strokeGain } from "../ink/PressureGain";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { strokeWidthPolicy } from "../ink/StrokeWidth";
import type { BridgeGeometry, BridgePen, BridgePoint, BridgeRect } from "../bridge/BridgeProtocol";
import type { BridgeSurface } from "../bridge/BridgeSession";
import { getInkSizeMult, inlineTool } from "./InkOverlayToolState";
import { installMethods } from "./InstallMethods";
import { normalizeInlinePenPressure } from "./PenPressure";
import { tipMode } from "./TipMode";
import type { InkOverlayPlugin } from "./InkOverlay";

/**
 * How a viewport point becomes a page point, as it stood at one moment. The
 * router's own mapping is affine, so two probes through it are the whole of
 * it: no field of the router is read, and whatever it accounts for (the
 * host's zoom, a sideways pan) is accounted for here.
 */
export interface NoteBridgeSnapshot {
	cam: CameraState;
	/** The router's sample for client (0, 0). */
	x0: number;
	y0: number;
	/** Sample units per client px. */
	k: number;
}

declare module "./InkOverlay" {
	interface InkOverlayPlugin {
		/** This overlay's face toward the companion, made on first use. */
		bridgeFace?: BridgeSurface;
		/**
		 * The pen-ink contact now down, as the companion stands to it: "claimed" when the companion is delivering it, so its
		 * own ink is not kept; "open" when it may yet be; null for a contact the companion never draws.
		 */
		bridgeContact?: "claimed" | "open" | null;
		bridgeSurface(): BridgeSurface;
		bridgeGeometry(): BridgeGeometry | null;
		bridgePen(): BridgePen | null;
		bridgeSnapshot(): NoteBridgeSnapshot | null;
		landBridgeStroke(points: readonly BridgePoint[], snapshot: NoteBridgeSnapshot | null): boolean;
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

	function bridgeSurface(this: InkOverlayPlugin): BridgeSurface {
		return (this.bridgeFace ??= {
			geometry: () => this.bridgeGeometry(),
			pen: () => this.bridgePen(),
			snapshot: () => this.bridgeSnapshot(),
			land: (points, snapshot) => this.landBridgeStroke(points, snapshot as NoteBridgeSnapshot | null),
		});
	}

	function bridgeGeometry(this: InkOverlayPlugin): BridgeGeometry | null {
		const win = this.view?.dom?.ownerDocument?.defaultView;
		if (!win || !this.filePath()) return null;
		const vw = win.innerWidth, vh = win.innerHeight;
		const rect = visibleRect(this.view.scrollDOM, vw, vh);
		if (!rect) return null;
		const exclude: BridgeRect[] = [];
		const strip = this.mobileTools?.el;
		const stripRect = strip ? visibleRect(strip, vw, vh) : null;
		if (stripRect) exclude.push(stripRect);
		return { kind: "note", rect, exclude, viewport: { w: vw, h: vh }, dpr: win.devicePixelRatio || 1 };
	}

	function bridgePen(this: InkOverlayPlugin): BridgePen | null {
		// The companion draws one thing, an opaque pen line. Every other use of
		// the tip - highlighter, eraser, lasso, space, pan, or the pen switched
		// off - stays with the webview.
		if (inlineTool !== "pen" || tipMode() !== "nib" || (this.router?.penOff() ?? true)) return null;
		return { color: getInkColorHex("pen"), width: Math.round(DEFAULT_PEN.baseWidth * getInkSizeMult("pen") * this.scale * 100) / 100 };
	}

	function bridgeSnapshot(this: InkOverlayPlugin): NoteBridgeSnapshot | null {
		const router = this.router;
		if (!router) return null;
		// What a pen-down does before it maps its first sample: the camera and
		// the router's box as the layout has them now. Both stand down while a
		// stroke of the webview's own holds the frame.
		this.syncCamera();
		if (!this.frame.locked) router.refreshRect();
		const a = router.sampleFrom(probeEvent(0));
		const b = router.sampleFrom(probeEvent(PROBE));
		const k = (b.x - a.x) / PROBE;
		if (!Number.isFinite(k) || k <= 0) return null;
		return { cam: { ...this.camera.snapshot }, x0: a.x, y0: a.y, k };
	}

	function landBridgeStroke(this: InkOverlayPlugin, points: readonly BridgePoint[], snapshot: NoteBridgeSnapshot | null): boolean {
		const path = this.filePath();
		if (!path || !snapshot || points.length === 0) return false;
		// The nib as the pen path binds it at contact: the selection now, which
		// is the one the companion was told to draw with.
		const style = strokeWidthPolicy(
			{ ...this.penStyle, baseWidth: DEFAULT_PEN.baseWidth * getInkSizeMult("pen"), color: getInkColorHex("pen") },
			undefined
		).style;
		const builder = new StrokeBuilder("pen", style.color, style.baseWidth);
		// No coarse grid: that averages out a webview's whole-pixel samples,
		// and these come from the digitizer at full resolution.
		builder.start(0);
		const gain = strokeGain();
		for (const p of points) {
			const w = screenToWorld(snapshot.cam, snapshot.x0 + p.x * snapshot.k, snapshot.y0 + p.y * snapshot.k);
			builder.add(w.x, w.y, normalizeInlinePenPressure(p.pressure * gain), p.t);
		}
		const strokes = builder.finishReleaseFiltered();
		const stroke = strokes.at(-1);
		if (!stroke) return false;
		this.handoffStrokes(path, strokes, null, null);
		const pad = 4;
		this.lastCommitNote = { x: stroke.bbox.x - pad, y: stroke.bbox.y - pad, w: stroke.bbox.width + pad * 2, h: stroke.bbox.height + pad * 2 };
		this.lastCommitPath = path;
		this.lastCommitId = stroke.id;
		this.lastCommitColor = stroke.color;
		this.lastCommitAt = performance.now();
		// A second pane on the same note shows the new ink too.
		this.repaintPath(path);
		this.updateExtent(true);
		return true;
	}

export function installBridge(proto: InkOverlayPlugin): void {
	installMethods(proto, { bridgeSurface, bridgeGeometry, bridgePen, bridgeSnapshot, landBridgeStroke });
}
