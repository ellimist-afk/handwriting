import { CameraState } from "../camera/coordinates";
import { PenSample } from "../input/PointerRouter";
import { PenStyle, widthForPressure } from "./PenStyle";
import { Point2 } from "./Smoothing";
import { fillRibbon } from "./RibbonRenderer";
import { inkColorFor } from "./InkTheme";
import type { InkStroke } from "./Stroke";
import { strokeRev } from "./StrokeRev";
import { canvasLayerBox } from "../inline/ZoomScale";

/**
 * How much width the predicted tail gives up by its tip.
 *
 * The far end of a guess is the least certain part of it, so it is drawn as
 * the faintest part. At full weight a wrong guess announces itself - the tip
 * jumps a nib-width sideways and the eye follows it - which is what made
 * prediction read as distortion while writing even though the committed
 * stroke was correct.
 */
const TAIL_TIP_TAPER = 0.5;

/**
 * Side of the compact inline tail backing, in canvas CSS px. The bitmap is
 * sized once, when the band is configured, and a stroke only moves it:
 * writing a canvas width or height reallocates the bitmap, and the pen path
 * must not pay that per event. 256 px holds a live head and the capped
 * prediction at ordinary speeds; a larger envelope takes the full backing.
 */
const COMPACT_TILE_CSS_PX = 256;

type LiveHead = {
	cam: CameraState;
	style: PenStyle;
	from: Point2;
	to: Point2;
	pressure: number;
	hwWorld: number;
};

type LivePrediction = {
	fromX: number;
	fromY: number;
	points: readonly PenSample[];
	lineWidthPx: number;
};

type InlineBacking = {
	width: number;
	height: number;
	backing: number;
	cssScale: number;
	hostZoom: boolean;
	grid: number | null;
	/** The compact tile in backing px, on the grid; 0 when no tile fits. */
	tileW: number;
	tileH: number;
};

/** The one compact tile size for a configured band, or 0 x 0 when compact placement is off. */
function compactTile(width: number, height: number, backing: number, grid: number | null): { tileW: number; tileH: number } {
	if (!grid) return { tileW: 0, tileH: 0 };
	const fullW = Math.round(width * backing), fullH = Math.round(height * backing);
	const side = Math.ceil(COMPACT_TILE_CSS_PX * backing / grid) * grid;
	const tileW = Math.min(side, Math.floor(fullW / grid) * grid);
	const tileH = Math.min(side, Math.floor(fullH / grid) * grid);
	return tileW > 0 && tileH > 0 && tileW * tileH < fullW * fullH ? { tileW, tileH } : { tileW: 0, tileH: 0 };
}

/** Tile origin on one axis: centred on the envelope, on the grid, inside the band, covering lo..hi. */
function tileOrigin(lo: number, hi: number, tile: number, full: number, grid: number): number {
	const min = Math.max(0, hi - tile);
	const max = Math.min(lo, Math.floor((full - tile) / grid) * grid);
	const centred = Math.floor(((lo + hi) / 2 - tile / 2) / grid) * grid;
	return Math.min(max, Math.max(min, centred));
}

/** A joint backing, CSS-layout and displayed-device grid, in backing pixels. */
function backingGrid(backing: number, cssScale: number, dpr: number, hostZoom: boolean): number | null {
	if (!(backing > 0) || !(cssScale > 0) || !(dpr > 0) ||
		![backing, cssScale, dpr].every(Number.isFinite)) return null;
	const k = !hostZoom && cssScale < 1 ? cssScale : 1;
	const whole = (n: number) => Math.abs(n - Math.round(n)) < 1e-8;
	for (let grid = 1; grid <= 64; grid++) {
		if (whole(grid * cssScale * dpr / backing) &&
			whole(64 * grid / backing) && whole(64 * grid * k / backing)) return grid;
	}
	return null;
}

type ContextState = {
	lineCap: CanvasLineCap;
	lineJoin: CanvasLineJoin;
	lineWidth: number;
	strokeStyle: string | CanvasGradient | CanvasPattern;
	fillStyle: string | CanvasGradient | CanvasPattern;
	globalAlpha: number;
	globalCompositeOperation: GlobalCompositeOperation;
	lineDash: number[];
	lineDashOffset: number;
	miterLimit: number;
	filter: string;
	imageSmoothingEnabled: boolean;
	shadowBlur: number;
	shadowColor: string;
	shadowOffsetX: number;
	shadowOffsetY: number;
	font: string;
	textAlign: CanvasTextAlign;
	textBaseline: CanvasTextBaseline;
};

/**
 * The transient overlay: a canvas above the wet ink layer holding only
 * geometry that will be replaced on the next input event. Two things live
 * here:
 *
 *   the live head   the short raw stub from the settled smooth curve to the
 *                   nib, which is what keeps the tip lag-free
 *   prediction      the experimental predicted tail, when enabled
 *
 * Both are erased and redrawn constantly, which is why they cannot live on the
 * append-only wet canvas. Erasing clears only the bounding box of the last
 * draw: at ~200–250 Hz a full-viewport clear per event is real GPU work, and
 * this is a few dozen pixels across.
 */
export class TailRenderer {
	private ctx: CanvasRenderingContext2D;
	private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
	private readonly requested: boolean;
	private spacePaths = new WeakMap<InkStroke,{rev:number;path:Path2D}>();
	private blank = false;
	private untrackedPixels = true;
	private backingScale = 1;
	private inlineBacking: InlineBacking | null = null;
	private backingMode: "full" | "compact" | "empty" = "full";
	private originX = 0;
	private originY = 0;
	private backingResizeTotal = 0;
	private fullFallbacks = 0;
	private translateSupport: boolean | undefined;
	beforeWrite?: () => void;
	get provenBlank(): boolean { return this.blank; }
	/** Monotonic count of backing size changes on this renderer. */
	get resizeTotal(): number { return this.backingResizeTotal; }
	/** Monotonic count of live envelopes that took the full surface from a tile or an empty backing. */
	get fullFallbackTotal(): number { return this.fullFallbacks; }
	private fallBackToFullSurface(): void {
		if (this.backingMode !== "full") this.fullFallbacks++;
		this.restoreFullSurface();
	}
	noteBackingCleared(): void { this.blank = true; this.untrackedPixels = false; }
	private contextState(): ContextState {
		const c = this.ctx;
		return {
			lineCap: c.lineCap, lineJoin: c.lineJoin, lineWidth: c.lineWidth,
			strokeStyle: c.strokeStyle, fillStyle: c.fillStyle,
			globalAlpha: c.globalAlpha, globalCompositeOperation: c.globalCompositeOperation,
			lineDash: c.getLineDash?.() ?? [], lineDashOffset: c.lineDashOffset,
			miterLimit: c.miterLimit, filter: c.filter, imageSmoothingEnabled: c.imageSmoothingEnabled,
			shadowBlur: c.shadowBlur, shadowColor: c.shadowColor,
			shadowOffsetX: c.shadowOffsetX, shadowOffsetY: c.shadowOffsetY,
			font: c.font, textAlign: c.textAlign, textBaseline: c.textBaseline,
		};
	}
	private restoreContext(state: ContextState): void {
		const c = this.ctx;
		c.lineCap = state.lineCap; c.lineJoin = state.lineJoin; c.lineWidth = state.lineWidth;
		c.strokeStyle = state.strokeStyle; c.fillStyle = state.fillStyle;
		c.globalAlpha = state.globalAlpha; c.globalCompositeOperation = state.globalCompositeOperation;
		c.setLineDash(state.lineDash); c.lineDashOffset = state.lineDashOffset;
		c.miterLimit = state.miterLimit; c.filter = state.filter;
		c.imageSmoothingEnabled = state.imageSmoothingEnabled;
		c.shadowBlur = state.shadowBlur; c.shadowColor = state.shadowColor;
		c.shadowOffsetX = state.shadowOffsetX; c.shadowOffsetY = state.shadowOffsetY;
		c.font = state.font; c.textAlign = state.textAlign; c.textBaseline = state.textBaseline;
	}
	/**
	 * Whether the page places a canvas with the CSS translate property. The
	 * compact tile moves by translate; an old WebView ignores the property and
	 * would leave the tile at the band origin, off the pen. Asked once.
	 */
	private translateSupported(): boolean {
		if (this.translateSupport === undefined) {
			const css = (this.canvas.ownerDocument?.defaultView as unknown as { CSS?: { supports?: (property: string, value: string) => boolean } } | null | undefined)?.CSS;
			this.translateSupport = css?.supports?.("translate", "1px 1px") === true;
		}
		return this.translateSupport;
	}
	private placeInlineBacking(): void {
		const config = this.inlineBacking;
		if (!config) return;
		const width = this.backingMode === "full" ? config.width : this.canvas.width / config.backing;
		const height = this.backingMode === "full" ? config.height : this.canvas.height / config.backing;
		const box = canvasLayerBox(width, height, config.cssScale, config.hostZoom);
		const style = this.canvas.style;
		const translation = this.originX || this.originY
			? `${this.originX / config.backing}px ${this.originY / config.backing}px`
			: "none";
		// Individual translate precedes the box transform, including in RTL.
		if (style.left !== "0px") style.left = "0px";
		if (style.top !== "0px") style.top = "0px";
		if (style.right !== "auto") style.right = "auto";
		if (style.bottom !== "auto") style.bottom = "auto";
		// Asked at configure; this reads the answer.
		if (this.translateSupport === true && style.translate !== translation) style.translate = translation;
		if (style.width !== `${box.width}px`) style.width = `${box.width}px`;
		if (style.height !== `${box.height}px`) style.height = `${box.height}px`;
		if (style.transform !== box.transform) style.transform = box.transform;
		const transformOrigin = box.transform ? "0 0" : "";
		if (style.transformOrigin !== transformOrigin) style.transformOrigin = transformOrigin;
	}
	/** Erase every backing pixel, whatever the origin: stale pixels must not ride a moved tile. */
	private wipeBacking(): void {
		if (this.blank) return;
		this.beforeWrite?.();
		this.ctx.save();
		this.ctx.setTransform(1, 0, 0, 1, 0, 0);
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.restore();
		this.noteBackingCleared();
	}
	/** The size an empty inline backing keeps: the tile, or the full band when no tile fits. */
	private emptySize(config: InlineBacking): { width: number; height: number } {
		return config.tileW > 0
			? { width: config.tileW, height: config.tileH }
			: { width: Math.round(config.width * config.backing), height: Math.round(config.height * config.backing) };
	}
	/** Release the live bitmap's content without resizing it when it already has the empty size. */
	private emptyBacking(config: InlineBacking): void {
		const { width, height } = this.emptySize(config);
		const keep = this.canvas.width === width && this.canvas.height === height;
		if (keep) this.wipeBacking();
		this.resizeBacking(width, height, keep ? this.originX : 0, keep ? this.originY : 0, "empty");
	}
	private resizeBacking(width: number, height: number, x: number, y: number,
		mode: "full" | "compact" | "empty"): void {
		const changed = this.canvas.width !== width || this.canvas.height !== height;
		if (changed) this.beforeWrite?.();
		const state = changed ? this.contextState() : null;
		if (this.canvas.width !== width) this.canvas.width = width;
		if (this.canvas.height !== height) this.canvas.height = height;
		if (changed) this.backingResizeTotal++;
		this.originX = x; this.originY = y; this.backingMode = mode;
		if (state) {
			this.restoreContext(state);
			this.dirty = null;
			this.noteBackingCleared();
		}
		if (mode === "empty") { this.dirty = null; this.noteBackingCleared(); }
		const b = this.backingScale;
		this.ctx.setTransform(b, 0, 0, b, -x, -y);
		this.placeInlineBacking();
	}
	/** Inline only. PDF and slides keep their original full-surface backing. */
	configureInlineBacking(width: number, height: number, backing: number, cssScale: number, hostZoom: boolean): void {
		const dpr = this.canvas.ownerDocument?.defaultView?.devicePixelRatio ?? backing;
		const grid = backingGrid(backing, cssScale, dpr, hostZoom);
		this.inlineBacking = {
			width, height, backing, cssScale, hostZoom, grid,
			...(this.translateSupported() ? compactTile(width, height, backing, grid) : { tileW: 0, tileH: 0 }),
		};
		this.backingScale = backing;
		this.emptyBacking(this.inlineBacking);
	}
	/** Reapply placement after a band style update; changing scale uses a safe full backing. */
	placeInline(cssScale: number, hostZoom: boolean): void {
		const config = this.inlineBacking;
		if (!config) return;
		if (config.cssScale !== cssScale || config.hostZoom !== hostZoom) {
			config.cssScale = cssScale;
			config.hostZoom = hostZoom;
			config.grid = backingGrid(config.backing, cssScale,
				this.canvas.ownerDocument?.defaultView?.devicePixelRatio ?? config.backing, hostZoom);
			Object.assign(config, this.translateSupported()
				? compactTile(config.width, config.height, config.backing, config.grid) : { tileW: 0, tileH: 0 });
			if (this.backingMode === "compact") this.restoreFullSurface(true);
			else if (this.backingMode === "empty") this.emptyBacking(config);
		}
		this.placeInlineBacking();
	}
	/** UI drawers need the whole band. Preserve live pixels only for carry fallback. */
	restoreFullSurface(preserve = false): void {
		const config = this.inlineBacking;
		if (!config || this.backingMode === "full") return;
		const x = this.originX, y = this.originY;
		const oldW = this.canvas.width, oldH = this.canvas.height;
		const oldDirty = this.dirty, oldUntracked = this.untrackedPixels, oldBlank = this.blank;
		let copy: HTMLCanvasElement | null = null;
		if (preserve && oldW > 0 && oldH > 0) {
			// A detached canvas in the layer's own document (a popout's, in a popout).
			copy = this.canvas.cloneNode(false) as HTMLCanvasElement;
			copy.width = oldW; copy.height = oldH;
			copy.getContext("2d")?.drawImage(this.canvas, 0, 0);
		}
		this.resizeBacking(Math.round(config.width * config.backing), Math.round(config.height * config.backing), 0, 0, "full");
		if (copy) {
			this.ctx.save();
			this.ctx.setTransform(1, 0, 0, 1, 0, 0);
			this.ctx.globalAlpha = 1;
			this.ctx.globalCompositeOperation = "source-over";
			this.ctx.filter = "none";
			this.ctx.drawImage(copy, x, y);
			this.ctx.restore();
			this.blank = oldBlank;
			this.untrackedPixels = oldUntracked;
			this.dirty = oldDirty;
		}
	}
	/** Size the next event's head and prediction together, before either draw. */
	prepareLive(head: LiveHead | null, prediction: LivePrediction | null): void {
		const config = this.inlineBacking;
		if (!config) return;
		if (!head && (!prediction || prediction.points.length === 0)) {
			this.emptyBacking(config);
			return;
		}
		let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
		const cover = (x: number, y: number, radius: number) => {
			const pad = radius + Math.max(2, 2 / config.backing);
			left = Math.min(left, x - pad); top = Math.min(top, y - pad);
			right = Math.max(right, x + pad); bottom = Math.max(bottom, y + pad);
		};
		if (head) {
			const { cam, from, to } = head;
			const radius = Math.max(0.25, head.hwWorld * cam.zoom);
			cover((from.x - cam.x) * cam.zoom, (from.y - cam.y) * cam.zoom, radius);
			cover((to.x - cam.x) * cam.zoom, (to.y - cam.y) * cam.zoom, radius);
		}
		if (prediction?.points.length) {
			const radius = Math.max(0.25, prediction.lineWidthPx / 2);
			cover(prediction.fromX, prediction.fromY, radius);
			for (const point of prediction.points) cover(point.x, point.y, radius);
		}
		const grid = config.grid, b = config.backing;
		if (!grid || ![left, top, right, bottom].every(Number.isFinite)) {
			this.fallBackToFullSurface();
			return;
		}
		const x0 = Math.floor(Math.floor(left * b) / grid) * grid;
		const y0 = Math.floor(Math.floor(top * b) / grid) * grid;
		const x1 = Math.ceil(Math.ceil(right * b) / grid) * grid;
		const y1 = Math.ceil(Math.ceil(bottom * b) / grid) * grid;
		const fullW = Math.round(config.width * b), fullH = Math.round(config.height * b);
		const { tileW, tileH } = config;
		if (x0 < 0 || y0 < 0 || x1 > fullW || y1 > fullH || x1 <= x0 || y1 <= y0 ||
			!(tileW > 0) || x1 - x0 > tileW || y1 - y0 > tileH) {
			this.fallBackToFullSurface();
			return;
		}
		// Full already (UI chrome, or an envelope larger than the tile): it
		// stays full until the release, because shrinking here would
		// reallocate on the pen path.
		if (this.backingMode === "full") return;
		const sized = this.canvas.width === tileW && this.canvas.height === tileH;
		if (sized && x0 >= this.originX && y0 >= this.originY &&
			x1 <= this.originX + tileW && y1 <= this.originY + tileH) {
			if (this.backingMode !== "compact") { this.backingMode = "compact"; this.placeInlineBacking(); }
			return;
		}
		const x = tileOrigin(x0, x1, tileW, fullW, grid), y = tileOrigin(y0, y1, tileH, fullH, grid);
		if (!sized) {
			this.resizeBacking(tileW, tileH, x, y, "compact");
			return;
		}
		// Same bitmap, new place: translate only, no allocation.
		this.wipeBacking();
		this.dirty = null;
		this.originX = x; this.originY = y; this.backingMode = "compact";
		this.ctx.setTransform(b, 0, 0, b, -x, -y);
		this.placeInlineBacking();
	}
	/** See WetInkRenderer.carry: the band moved under a live stroke. */
	carry(shiftX: number, shiftY: number): void {
		if (shiftX === 0 && shiftY === 0) return;
		if (this.inlineBacking && this.backingMode === "empty") return;
		if (this.inlineBacking && this.backingMode === "compact") {
			const { grid, backing, width, height } = this.inlineBacking;
			const dx = Math.round(shiftX * backing), dy = Math.round(shiftY * backing);
			const x = this.originX + dx, y = this.originY + dy;
			if (grid && dx % grid === 0 && dy % grid === 0 &&
				x >= 0 && y >= 0 && x + this.canvas.width <= Math.round(width * backing) &&
				y + this.canvas.height <= Math.round(height * backing)) {
				this.beforeWrite?.();
				this.originX = x; this.originY = y;
				this.ctx.setTransform(backing, 0, 0, backing, -x, -y);
				this.placeInlineBacking();
				if (this.dirty) this.dirty = { x0: this.dirty.x0 + shiftX, y0: this.dirty.y0 + shiftY,
					x1: this.dirty.x1 + shiftX, y1: this.dirty.y1 + shiftY };
				return;
			}
			// Off the grid or out of the band: shift the pixels inside the
			// same tile below, as the full backing does, rather than reallocate.
		}
		this.beforeWrite?.();
		const ctx = this.ctx, b = this.backingScale;
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.globalCompositeOperation = "copy";
		ctx.drawImage(this.canvas, Math.round(shiftX * b), Math.round(shiftY * b));
		ctx.restore();
		if (this.dirty) this.dirty = { x0: this.dirty.x0 + shiftX, y0: this.dirty.y0 + shiftY, x1: this.dirty.x1 + shiftX, y1: this.dirty.y1 + shiftY };
	}
	private fullClearCovers(width: number, height: number): boolean {
		return Number.isFinite(width) && Number.isFinite(height) && this.backingScale > 0 &&
			width >= this.canvas.width / this.backingScale && height >= this.canvas.height / this.backingScale;
	}
	private markPaint(): void {
		this.beforeWrite?.();
		this.blank = false;
		this.untrackedPixels = true;
	}

	/**
	 * `desynchronized` asks the browser to present this canvas without waiting
	 * for the normal compositing sync - the low-latency path.
	 *
	 * It belongs here more than anywhere else in the plugin. This canvas holds
	 * the stub that reaches the nib; the wet canvas below it holds geometry
	 * that is already, by construction, behind the pen. The inline overlay
	 * asked for it on the wet layer from the start and never asked for it
	 * here, which had the tip presenting on the slower path than the ink
	 * trailing it.
	 *
	 * It is only a HINT. Browsers refuse it silently, so `actualDesynchronized`
	 * reports what was really granted rather than what was asked for - the same
	 * shape WetInkRenderer uses, and the reason a latency claim about this can
	 * be checked instead of assumed.
	 */
	constructor(private canvas: HTMLCanvasElement, desynchronized = false) {
		this.requested = desynchronized;
		// Exactly the call this made before the flag existed when nothing is
		// asked for. Passing `{ desynchronized: false }` ought to be identical
		// to passing nothing, and after what asking for `true` did on hardware
		// here, "ought to be" is not a good enough reason to change the call
		// the working path makes.
		const ctx = desynchronized
			? canvas.getContext("2d", { desynchronized: true })
			: canvas.getContext("2d");
		if (!ctx) throw new Error("Handwriting: could not acquire tail 2d context");
		this.ctx = ctx;
	}

	/** What the browser actually granted; undefined where unreportable. */
	get actualDesynchronized(): boolean | undefined {
		return (
			this.ctx as CanvasRenderingContext2D & {
				getContextAttributes?: () => { desynchronized?: boolean };
			}
		).getContextAttributes?.().desynchronized;
	}

	/** Compact one-line report, for the metrics panel. */
	describeLatency(): string {
		return `tail: req ${this.requested} | granted ${String(this.actualDesynchronized ?? "n/a")}`;
	}

	applyDpr(dpr: number): void {
		this.ctx.setTransform(dpr, 0, 0, dpr, -this.originX, -this.originY);
		this.backingScale = dpr;
	}

	/**
	 * Erase the previous tail: the dirty rect when there is one, and the WHOLE
	 * canvas when there is not and a size is given.
	 *
	 * The fallback is the point, and it is the same one `WetInkRenderer.
	 * clearStroke` has: no box means clear everything, because leaving ink
	 * behind is the one outcome an erase must never produce. Without it this
	 * method was `if (!this.dirty) return;` - a total no-op - and three paths
	 * on this class paint the canvas and then NULL the box without leaving one
	 * behind: `drawLasso`, `drawSelectionBox` and `drawSpaceDivider`, one of
	 * which says so in a comment ("selection UI clears with clearAll, not a
	 * dirty rect"). Measured in real Chromium with an exhaustive pixel count
	 * (`test/measure/TailClearBox.test.ts`), a `clear()` over a nulled box
	 * left 920, 1453, 3356 and 5091 px across the four zoom/dpr configs - in
	 * every one, EXACTLY what had just been drawn, so nothing was erased at
	 * all - where `clearAll` erased the canvas in all twelve cases. An
	 * independent run on another tree saw the same total no-op at its own
	 * fixture's counts (1027/3170/1191/3784).
	 *
	 * That is a CONDITIONAL fact: IF the box is null then the old `clear()`
	 * erased nothing. Whether an ink pen-up can actually reach that state is
	 * NOT established - a pen-down dissolves the selection for a bare tip, and
	 * a lasso gesture ends on its own branch - so this is not the fix for a
	 * known on-screen defect. The fallback makes the question moot at no cost,
	 * which is why it is here instead of a reachability hunt.
	 *
	 * The size is OPTIONAL so the hot-path callers do not have to change. They
	 * erase the previous tail once per pointer event at 200-250 Hz, where the
	 * dirty rect is a few dozen pixels across and a whole-canvas clear is real
	 * GPU work; they pass nothing and keep exactly the behaviour they have,
	 * including the early return. The pen-up sites, which run once per stroke
	 * and must leave the canvas clean for the committed layer, pass the size
	 * and get the fallback.
	 */
	clear(cssWidth?: number, cssHeight?: number): void {
		this.beforeWrite?.();
		const d = this.dirty;
		if (!d) {
			// No box. Clear everything if we were told how big everything is,
			// and otherwise do what this always did.
			if (
				cssWidth !== undefined &&
				cssHeight !== undefined &&
				cssWidth > 0 &&
				cssHeight > 0
			) {
				this.ctx.clearRect(0, 0, cssWidth, cssHeight);
				if (this.fullClearCovers(cssWidth, cssHeight)) this.noteBackingCleared();
			}
			return;
		}
		this.ctx.clearRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
		this.blank = !this.untrackedPixels && Number.isFinite(d.x0) && Number.isFinite(d.y0) && Number.isFinite(d.x1) && Number.isFinite(d.y1);
		this.dirty = null;
	}

	/** Erase everything, for stroke end / resize. */
	clearAll(cssWidth: number, cssHeight: number): void {
		this.beforeWrite?.();
		this.ctx.clearRect(0, 0, cssWidth, cssHeight);
		if (this.fullClearCovers(cssWidth, cssHeight)) this.noteBackingCleared();
		this.dirty = null;
	}

	/**
	 * Selection UI: the lasso being drawn, and the outline around what it
	 * caught. Both take world coordinates and are redrawn whenever the camera
	 * moves, which is what keeps a selection glued to its contents through pan
	 * and zoom.
	 */
	drawLasso(cam: CameraState, world: readonly Point2[], color: string): void {
		if (world.length < 2) return;
		this.markPaint();
		const ctx = this.ctx;
		ctx.save();
		ctx.strokeStyle = color;
		ctx.lineWidth = 1.5;
		ctx.setLineDash([6, 4]);
		ctx.beginPath();
		ctx.moveTo((world[0]!.x - cam.x) * cam.zoom, (world[0]!.y - cam.y) * cam.zoom);
		for (let i = 1; i < world.length; i++) {
			ctx.lineTo((world[i]!.x - cam.x) * cam.zoom, (world[i]!.y - cam.y) * cam.zoom);
		}
		ctx.closePath();
		ctx.stroke();
		ctx.restore();
		this.dirty = null; // selection UI clears with clearAll, not a dirty rect
	}

	drawSelectionBox(
		cam: CameraState,
		box: { x: number; y: number; width: number; height: number },
		color: string
	): void {
		this.markPaint();
		const ctx = this.ctx;
		const pad = 6;
		ctx.save();
		ctx.strokeStyle = color;
		ctx.lineWidth = 1.5;
		ctx.setLineDash([4, 4]);
		ctx.strokeRect(
			(box.x - cam.x) * cam.zoom - pad,
			(box.y - cam.y) * cam.zoom - pad,
			box.width * cam.zoom + pad * 2,
			box.height * cam.zoom + pad * 2
		);
		ctx.restore();
		this.dirty = null;
	}

	/**
	 * Insert-space divider: a full-width dashed rule at the gesture's world
	 * y. World-anchored like the rest of the selection chrome, so it stays
	 * glued to the seam it marks; the ink below it follows the pen, the
	 * rule itself never moves.
	 */
	drawSpaceDivider(cam: CameraState, yWorld: number, color: string, cssWidth: number): void {
		this.markPaint();
		const y = (yWorld - cam.y) * cam.zoom;
		const ctx = this.ctx;
		ctx.save();
		ctx.strokeStyle = color;
		ctx.lineWidth = 1.5;
		ctx.setLineDash([8, 5]);
		ctx.beginPath();
		ctx.moveTo(0, y);
		ctx.lineTo(cssWidth, y);
		ctx.stroke();
		ctx.restore();
		this.dirty = null;
	}

	/** Actual stroke paths, never a union box or a stored color change. Hover
	 * reuses geometry; offscreen strokes are rejected before path construction. */
	drawSpaceStroke(cam:CameraState,stroke:InkStroke,color:string,width:number,height:number,cssScale:number):boolean {
		const b=stroke.bbox,pad=4/cssScale;
		if((b.x+b.width-cam.x)*cam.zoom < -pad || (b.y+b.height-cam.y)*cam.zoom < -pad ||
			(b.x-cam.x)*cam.zoom > width+pad || (b.y-cam.y)*cam.zoom > height+pad || !stroke.points.length)return false;
		this.markPaint();
		let cached=this.spacePaths.get(stroke);
		const rev=strokeRev(stroke);
		if(!cached||cached.rev!==rev){
			const path=new Path2D(),points=stroke.points;
			path.moveTo(points[0]!.x,points[0]!.y);
			for(let i=1;i<points.length;i++)path.lineTo(points[i]!.x,points[i]!.y);
			if(points.length===1)path.lineTo(points[0]!.x+.001,points[0]!.y);
			cached={rev,path};this.spacePaths.set(stroke,cached);
		}
		const ctx=this.ctx;
		ctx.save();ctx.translate(-cam.x*cam.zoom,-cam.y*cam.zoom);ctx.scale(cam.zoom,cam.zoom);
		ctx.strokeStyle=color;ctx.globalAlpha=.65;ctx.lineWidth=Math.max(stroke.width,4/(cssScale*cam.zoom));
		ctx.lineCap="round";ctx.lineJoin="round";ctx.setLineDash([]);ctx.stroke(cached.path);ctx.restore();
		this.dirty=null;
		return true;
	}

	/** Small physical-size label/tick, including the exact rounded landing.
	 * Keep origin and landing labels on opposite sides when their Y agrees. */
	drawSpaceLabel(cam:CameraState,yWorld:number,label:string,color:string,cssScale:number,landing=false):void {
		this.markPaint();
		const ctx=this.ctx,y=(yWorld-cam.y)*cam.zoom;
		ctx.save();ctx.translate(0,y);ctx.scale(1/cssScale,1/cssScale);
		ctx.font="12px sans-serif";ctx.fillStyle=color;ctx.strokeStyle=color;ctx.lineWidth=2;ctx.setLineDash([]);
		if(landing){ctx.beginPath();ctx.moveTo(8,-4);ctx.lineTo(8,4);ctx.moveTo(8,0);ctx.lineTo(30,0);ctx.stroke();}
		ctx.fillText(label,landing?36:8,landing?16:-7);ctx.restore();this.dirty=null;
	}

	/**
	 * Draw the live head: one straight world-space segment, widthed to match
	 * the ribbon underneath it so the join is invisible.
	 *
	 * `hwWorld` is that width - a WORLD half-width, the same unit as a ribbon
	 * point's `hw` - and it wins when given. Callers get it from
	 * `WetInkRenderer.liveHalfWidth`, which is the wet layer reporting what it
	 * is actually laying down. Widthing the head from raw pressure instead
	 * misses three things the ribbon has (velocity thinning, the start taper,
	 * smoothed pressure) and the head is a separate canvas layer over the
	 * ribbon, so the difference reads as a step at the join - up to ~12x wide
	 * at stroke start with a fast pen.
	 *
	 * `pressure` stays, and stays the fallback, because it is honest: it is
	 * exactly what the wet layer's own non-shaping branch computes. A caller
	 * with no wet renderer to ask still gets the width this drew before
	 * `hwWorld` existed rather than a zero or a guess.
	 *
	 * Accumulates into the dirty rect, so it can be combined with a predicted
	 * tail in the same pass.
	 */
	drawHead(
		cam: CameraState,
		style: PenStyle,
		from: Point2,
		to: Point2,
		pressure: number,
		hwWorld?: number
	): void {
		const x1 = (from.x - cam.x) * cam.zoom;
		const y1 = (from.y - cam.y) * cam.zoom;
		const x2 = (to.x - cam.x) * cam.zoom;
		const y2 = (to.y - cam.y) * cam.zoom;
		const hw = hwWorld ?? widthForPressure(style, pressure) / 2;
		const untracked = this.untrackedPixels;
		this.markPaint();
		fillRibbon(
			this.ctx,
			cam,
			[
				{ x: from.x, y: from.y, hw },
				{ x: to.x, y: to.y, hw },
			],
			// The head continues the wet ribbon; it has to be the same colour the
			// ribbon under it was painted (InkTheme.ts).
			inkColorFor(style)
		);
		this.growDirty(x1, y1, x2, y2, hw * cam.zoom + 2);
		this.untrackedPixels = untracked;
	}

	private growDirty(
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		pad: number
	): void {
		const box = {
			x0: Math.min(x1, x2) - pad,
			y0: Math.min(y1, y2) - pad,
			x1: Math.max(x1, x2) + pad,
			y1: Math.max(y1, y2) + pad,
		};
		if (!this.dirty) {
			this.dirty = box;
			return;
		}
		this.dirty = {
			x0: Math.min(this.dirty.x0, box.x0),
			y0: Math.min(this.dirty.y0, box.y0),
			x1: Math.max(this.dirty.x1, box.x1),
			y1: Math.max(this.dirty.y1, box.y1),
		};
	}

	/**
	 * Draw the tail from the last real screen-space position through the
	 * predicted points. Same colour and width as the live stroke, because the
	 * tail is meant to read as ink, not as a hint.
	 */
	draw(
		fromX: number,
		fromY: number,
		points: readonly PenSample[],
		color: string,
		lineWidthPx: number
	): void {
		if (points.length === 0) return;
		const untracked = this.untrackedPixels;
		this.markPaint();
		const ctx = this.ctx;
		// `color` here is always the pen's ink (the predicted tail), never
		// selection chrome - the lasso and the dividers below keep their raw
		// colour, because they are UI and not ink.
		ctx.strokeStyle = inkColorFor(color);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		const base = Math.max(0.5, lineWidthPx);
		let px = fromX;
		let py = fromY;
		let x0 = fromX;
		let y0 = fromY;
		let x1 = fromX;
		let y1 = fromY;
		// Segment at a time, narrowing toward the tip. One stroked polyline is
		// cheaper, but it draws the least certain end at full weight: when the
		// guess is wrong the eye is pulled to a full-width tip snapping
		// sideways. Tapered, a correction is a thin line moving slightly.
		for (let i = 0; i < points.length; i++) {
			const p = points[i]!;
			const t = (i + 1) / points.length;
			ctx.lineWidth = Math.max(0.5, base * (1 - TAIL_TIP_TAPER * t));
			ctx.beginPath();
			ctx.moveTo(px, py);
			ctx.lineTo(p.x, p.y);
			ctx.stroke();
			px = p.x;
			py = p.y;
			if (p.x < x0) x0 = p.x;
			if (p.y < y0) y0 = p.y;
			if (p.x > x1) x1 = p.x;
			if (p.y > y1) y1 = p.y;
		}
		this.growDirty(x0, y0, x1, y1, base / 2 + 2);
		this.untrackedPixels = untracked;
	}
}
