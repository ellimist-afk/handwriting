import { ItemView, WorkspaceLeaf } from "obsidian";
import { Camera } from "../camera/Camera";
import { PointerRouter, PenSample, PointerStatus } from "../input/PointerRouter";
import { DEFAULT_PEN, PenStyle } from "../ink/PenStyle";
import { InkStroke } from "../ink/Stroke";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { drawCommitted, drawStroke } from "../ink/StrokeRenderer";
import { WetInkRenderer } from "../ink/WetInkRenderer";
import { TailRenderer } from "../ink/TailRenderer";
import { InputPrecision, computeCanvasSize, formatRaster, inspectRaster } from "../diag/Raster";

export const HANDWRITING_PEN_LAB_VIEW_TYPE = "handwriting-pen-lab";

const MINOR_GRID_WORLD = 40;
const MAJOR_GRID_WORLD = 200;
const OVERLAY_MS = 100;

/**
 * The pen lab: the §86 spike surface, kept permanently.
 *
 * Nothing but the stroke pipeline: camera, pointer router, wet ink, committed
 * ink, and a diagnostics overlay. No file, no persistence, no text, no eraser,
 * no toolbar beyond what the ink comparison needs. Strokes live in memory for
 * the life of the view and are thrown away when it closes. That is the point.
 * If pen feel ever needs re-judging, it gets judged here, with none of the
 * application in the way.
 *
 * The one control that matters: Raw vs Smoothed. Raw is the original faceted
 * polyline. Smoothed (the default, and what ships in pages) draws the settled
 * tail as midpoint quadratics while a raw stub carries the line to the nib, so
 * curves stop looking polygonal without the tip losing a millisecond. Same
 * pressure mapping, same scheduling, same everything else.
 */
export class PenLabView extends ItemView {
	private camera = new Camera();
	private router: PointerRouter | null = null;

	private rootEl!: HTMLElement;
	private paperEl!: HTMLElement;
	private committedCanvas!: HTMLCanvasElement;
	private wetCanvas!: HTMLCanvasElement;
	private headCanvas!: HTMLCanvasElement;
	private overlayEl!: HTMLElement;
	private modeButtons: Array<{ el: HTMLButtonElement; active: () => boolean }> = [];

	private committedCtx!: CanvasRenderingContext2D;
	private wetInk!: WetInkRenderer;
	private head!: TailRenderer;

	private strokes: InkStroke[] = [];
	private builder: StrokeBuilder | null = null;
	private penStyle: PenStyle = { ...DEFAULT_PEN };
	private smooth = true;

	// diagnostics
	private status: PointerStatus | null = null;
	private lastCoalesced = 0;
	private rawSamples = 0;
	private acceptedSamples = 0;
	private strokeRawSamples = 0;
	private strokeAcceptedSamples = 0;
	private fps = 0;
	private frameCount = 0;
	private fpsWindowStart = 0;
	private lastOverlay = 0;
	private tickerActive = false;
	private precision = new InputPrecision();

	private cssWidth = 0;
	private cssHeight = 0;
	private dpr = 1;
	private renderQueued = false;
	private resizeObserver: ResizeObserver | null = null;
	private detachCamera: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return HANDWRITING_PEN_LAB_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Handwriting pen lab";
	}

	getIcon(): string {
		return "pencil";
	}

	async onOpen(): Promise<void> {
		const content = this.contentEl;
		content.empty();
		content.addClass("handwriting-content");

		this.rootEl = content.createDiv({ cls: "handwriting-root" });
		this.rootEl.tabIndex = 0;
		this.paperEl = this.rootEl.createDiv({ cls: "handwriting-paper" });
		this.committedCanvas = this.rootEl.createEl("canvas", { cls: "handwriting-committed" });
		this.wetCanvas = this.rootEl.createEl("canvas", { cls: "handwriting-wet" });
		// Above the wet layer: the live head, redrawn every event.
		this.headCanvas = this.rootEl.createEl("canvas", { cls: "handwriting-tail" });

		this.buildToolbar();
		this.overlayEl = this.rootEl.createDiv({ cls: "handwriting-overlay" });

		const ctx = this.committedCanvas.getContext("2d");
		if (!ctx) throw new Error("Handwriting: no 2d context");
		this.committedCtx = ctx;
		// Frozen pipeline: plain canvas, sync draw in pointerrawupdate.
		this.wetInk = new WetInkRenderer(this.wetCanvas, false);
		this.wetInk.smooth = this.smooth;
		this.head = new TailRenderer(this.headCanvas);

		this.router = new PointerRouter(this.rootEl, this.camera, {
			onPenDown: (s) => this.penDown(s),
			onPenMove: (_samples, _ev, count) => {
				// Ink comes from pointerrawupdate; pointermove only reports how
				// many samples it would have carried.
				this.lastCoalesced = count;
			},
			onPenRaw: (samples) => this.penRaw(samples),
			onPenUp: () => this.penUp(),
			onStatus: (status) => {
				this.status = status;
			},
		});
		this.router.deliverMoveSamples = false;

		this.detachCamera = this.camera.onChange(() => {
			this.router?.refreshRect();
			this.requestRender();
		});

		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.rootEl);
		this.handleResize();
		this.updateOverlay();
	}

	async onClose(): Promise<void> {
		this.tickerActive = false;
		this.router?.dispose();
		this.router = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.detachCamera?.();
		this.detachCamera = null;
	}

	private buildToolbar(): void {
		const toolbar = this.rootEl.createDiv({ cls: "handwriting-toolbar handwriting-ui" });
		toolbar.createSpan({ cls: "handwriting-mode-label", text: "ink" });

		const addMode = (label: string, isActive: () => boolean, apply: () => void) => {
			const btn = toolbar.createEl("button", { text: label });
			btn.addEventListener("click", () => {
				if (this.builder) return; // never switch mid-stroke
				apply();
				this.refreshButtons();
				this.requestRender();
			});
			this.modeButtons.push({ el: btn, active: isActive });
		};

		addMode("Raw", () => !this.smooth, () => {
			this.smooth = false;
			this.wetInk.smooth = false;
			this.head.clearAll(this.cssWidth, this.cssHeight);
		});
		addMode("Smoothed", () => this.smooth, () => {
			this.smooth = true;
			this.wetInk.smooth = true;
		});

		const clearBtn = toolbar.createEl("button", { text: "Clear" });
		clearBtn.addEventListener("click", () => {
			this.strokes = [];
			this.rawSamples = 0;
			this.acceptedSamples = 0;
			this.wetInk.clear(this.cssWidth, this.cssHeight);
			this.head.clearAll(this.cssWidth, this.cssHeight);
			this.requestRender();
		});
		const resetBtn = toolbar.createEl("button", { text: "Reset view" });
		resetBtn.addEventListener("click", () => this.camera.setState(0, 0, 1));

		this.refreshButtons();
	}

	private refreshButtons(): void {
		for (const { el, active } of this.modeButtons) el.toggleClass("is-active", active());
	}

	// ---- pen path -----------------------------------------------------------

	private penDown(sample: PenSample): void {
		this.builder = new StrokeBuilder("pen", this.penStyle.color, this.penStyle.baseWidth);
		this.builder.start(sample.timestamp);
		this.strokeRawSamples = 1;
		this.strokeAcceptedSamples = 0;
		this.precision.reset();
		const w = this.camera.screenToWorld(sample.x, sample.y);
		const point = this.builder.add(
			w.x,
			w.y,
			normalizePressure(sample.pressure),
			sample.timestamp,
			sample.tiltX,
			sample.tiltY
		);
		if (point) {
			this.wetInk.beginStroke(point);
			this.strokeAcceptedSamples++;
			this.acceptedSamples++;
		}
		this.rawSamples++;
		this.startTicker();
	}

	private penRaw(samples: PenSample[]): void {
		if (!this.builder || samples.length === 0) return;
		const cam = this.camera.snapshot;
		for (const s of samples) {
			this.precision.add(s.x, s.y);
			const w = this.camera.screenToWorld(s.x, s.y);
			const point = this.builder.add(
				w.x,
				w.y,
				normalizePressure(s.pressure),
				s.timestamp,
				s.tiltX,
				s.tiltY
			);
			if (point) {
				this.wetInk.appendPoint(cam, this.penStyle, point);
				this.strokeAcceptedSamples++;
				this.acceptedSamples++;
			}
		}
		this.rawSamples += samples.length;
		this.strokeRawSamples += samples.length;
		this.drawHead();
	}

	/**
	 * The unsmoothed stub that reaches the nib. Erased and redrawn on every
	 * event, so the visible tip sits exactly where the raw build put it while
	 * everything behind it is curved.
	 */
	private drawHead(): void {
		this.head.clear();
		const h = this.wetInk.head();
		if (!h) return;
		this.head.drawHead(this.camera.snapshot, this.penStyle, h.from, h.to, h.pressure);
	}

	private penUp(): void {
		this.tickerActive = false;
		const builder = this.builder;
		this.builder = null;
		if (!builder) return;
		this.head.clearAll(this.cssWidth, this.cssHeight);
		this.wetInk.finishStroke(this.camera.snapshot, this.penStyle);
		const stroke = builder.finish();
		if (stroke) {
			this.strokes.push(stroke);
			drawStroke(this.committedCtx, this.camera.snapshot, stroke, this.penStyle, this.smooth);
		}
		this.wetInk.clear(this.cssWidth, this.cssHeight);
		this.updateOverlay(true);
	}

	/**
	 * Runs only while a stroke is in flight. It measures frame rate and
	 * refreshes the overlay, then stops. No permanent render loop (§63).
	 */
	private startTicker(): void {
		if (this.tickerActive) return;
		this.tickerActive = true;
		this.frameCount = 0;
		this.fpsWindowStart = performance.now();
		const tick = (ts: number) => {
			if (!this.tickerActive) return;
			this.frameCount++;
			const elapsed = ts - this.fpsWindowStart;
			if (elapsed >= 500) {
				this.fps = Math.round((this.frameCount * 1000) / elapsed);
				this.frameCount = 0;
				this.fpsWindowStart = ts;
			}
			if (ts - this.lastOverlay > OVERLAY_MS) {
				this.lastOverlay = ts;
				this.updateOverlay();
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}

	private updateOverlay(force = false): void {
		if (!this.overlayEl) return;
		void force;
		const s = this.status;
		const lines = [
			`Pointer:   ${s?.pointerType || "-"}`,
			`Pressure:  ${(s?.pressure ?? 0).toFixed(2)}`,
			`Tilt:      ${s?.tiltX ?? 0}, ${s?.tiltY ?? 0}`,
			`Buttons:   ${s?.buttons ?? 0}`,
			`Coalesced: ${this.lastCoalesced}`,
			`Samples:   ${this.acceptedSamples}`,
			`Raw/Acc:   ${this.rawSamples} / ${this.acceptedSamples}`,
			`Stroke:    ${this.strokeRawSamples} raw, ${this.strokeAcceptedSamples} accepted`,
			`Strokes:   ${this.strokes.length}`,
			`Zoom:      ${Math.round(this.camera.zoom * 100)}%`,
			`FPS:       ${this.fps || "-"}`,
			`Ink:       ${this.smooth ? "Smoothed" : "Raw"}`,
			this.precision.summary(),
			formatRaster(inspectRaster(this.committedCanvas), this.camera.zoom),
			`Palm:      ${s?.penStrokeActive ? "pen down" : "idle"}  touches ${s?.activeTouches ?? 0}  blocked ${s?.blockedTouches ?? 0}`,
		];
		this.overlayEl.setText(lines.join("\n"));
	}

	// ---- rendering ----------------------------------------------------------

	private handleResize(): void {
		const rect = this.rootEl.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		this.dpr = window.devicePixelRatio || 1;
		// Exactly dpr backing pixels per CSS pixel, so no compositor resampling.
		const size = computeCanvasSize(rect.width, rect.height, this.dpr);
		this.cssWidth = size.cssW;
		this.cssHeight = size.cssH;
		for (const c of [this.committedCanvas, this.wetCanvas, this.headCanvas]) {
			c.width = size.backingW;
			c.height = size.backingH;
			c.style.width = `${size.cssW}px`;
			c.style.height = `${size.cssH}px`;
		}
		this.committedCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		this.wetInk.applyDpr(this.dpr);
		this.head.applyDpr(this.dpr);
		this.router?.refreshRect();
		this.requestRender();
	}

	private requestRender(): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		requestAnimationFrame(() => {
			this.renderQueued = false;
			if ((window.devicePixelRatio || 1) !== this.dpr) {
				this.handleResize();
				return;
			}
			this.updateGrid();
			drawCommitted(
				this.committedCtx,
				this.camera.snapshot,
				this.strokes,
				this.cssWidth,
				this.cssHeight,
				this.smooth
			);
			this.updateOverlay();
		});
	}

	private updateGrid(): void {
		const z = this.camera.zoom;
		const minorPx = MINOR_GRID_WORLD * z;
		const majorPx = MAJOR_GRID_WORLD * z;
		const ox = this.camera.x * z;
		const oy = this.camera.y * z;
		const mod = (a: number, n: number) => ((a % n) + n) % n;
		const minorColor = "rgba(128, 128, 128, 0.10)";
		const majorColor = "rgba(128, 128, 128, 0.22)";

		const layers = [
			`linear-gradient(to right, ${majorColor} 1px, transparent 1px)`,
			`linear-gradient(to bottom, ${majorColor} 1px, transparent 1px)`,
		];
		const sizes = [`${majorPx}px ${majorPx}px`, `${majorPx}px ${majorPx}px`];
		const positions = [`${-mod(ox, majorPx)}px 0px`, `0px ${-mod(oy, majorPx)}px`];
		if (minorPx >= 8) {
			layers.push(
				`linear-gradient(to right, ${minorColor} 1px, transparent 1px)`,
				`linear-gradient(to bottom, ${minorColor} 1px, transparent 1px)`
			);
			sizes.push(`${minorPx}px ${minorPx}px`, `${minorPx}px ${minorPx}px`);
			positions.push(`${-mod(ox, minorPx)}px 0px`, `0px ${-mod(oy, minorPx)}px`);
		}
		this.paperEl.style.backgroundImage = layers.join(", ");
		this.paperEl.style.backgroundSize = sizes.join(", ");
		this.paperEl.style.backgroundPosition = positions.join(", ");
	}
}

function normalizePressure(p: number): number {
	if (!Number.isFinite(p) || p <= 0) return 0.5;
	return Math.min(1, p);
}
