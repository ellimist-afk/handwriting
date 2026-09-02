/**
 * Raster diagnostics: is ink actually being rasterized at the display's
 * resolution, or is a bitmap being scaled up somewhere?
 *
 * Three separate things can silently degrade canvas ink, and they look alike:
 *
 * 1. Backing store / CSS size mismatch. If the backing store is
 *    `round(cssPx × dpr)` while the CSS box stays fractional, the ratio is not
 *    exactly dpr and the compositor resamples the whole canvas every frame.
 *    Thin, high-contrast strokes show it first.
 * 2. Stale devicePixelRatio. Electron changes `devicePixelRatio` when the app
 *    zoom level changes or the window moves to a different-DPI monitor. A
 *    canvas sized once at load is then under-rasterized and upscaled.
 * 3. An ancestor CSS transform. If any ancestor is scaled, Chromium may
 *    rasterize the layer at its untransformed size and scale the result:
 *    genuine bitmap magnification, no matter how correct the canvas is.
 *
 * None of these are visible by reading the drawing code, which is why this
 * reports what is actually true at runtime.
 */

export interface CanvasSize {
	backingW: number;
	backingH: number;
	cssW: number;
	cssH: number;
}

/**
 * Size a canvas so the backing store maps to CSS pixels at exactly `dpr`:
 * one backing pixel per device pixel, no resampling. The CSS size is derived
 * back from the rounded backing store rather than kept fractional.
 */
export function computeCanvasSize(
	cssWidth: number,
	cssHeight: number,
	dpr: number
): CanvasSize {
	const backingW = Math.max(1, Math.round(cssWidth * dpr));
	const backingH = Math.max(1, Math.round(cssHeight * dpr));
	return {
		backingW,
		backingH,
		// Exact inverse: backingW / dpr * dpr === backingW.
		cssW: backingW / dpr,
		cssH: backingH / dpr,
	};
}

/**
 * Count non-transparent pixels in a CSS-px rectangle of a canvas whose
 * context transform is `backing`-scaled. Ground truth for "did that draw
 * call actually paint anything". Culling, clipping, and compositing lies
 * all end at the backing store. Strided so a large sample stays ~1e5 reads.
 */
export function countPaintedPixels(
	ctx: CanvasRenderingContext2D,
	xCss: number,
	yCss: number,
	wCss: number,
	hCss: number,
	backing: number
): number {
	const x = Math.max(0, Math.floor(xCss * backing));
	const y = Math.max(0, Math.floor(yCss * backing));
	const w = Math.floor(wCss * backing);
	const h = Math.floor(hCss * backing);
	if (w <= 0 || h <= 0) return 0;
	let data: Uint8ClampedArray;
	try {
		data = ctx.getImageData(x, y, w, h).data;
	} catch {
		return -1; // readback refused (tainted/failed): report, don't throw
	}
	const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / 100_000)));
	let painted = 0;
	for (let row = 0; row < h; row += stride) {
		const base = row * w * 4;
		for (let col = 0; col < w; col += stride) {
			if (data[base + col * 4 + 3]! > 0) painted++;
		}
	}
	// Scale the strided count back up to an estimate of the full area.
	return painted * stride * stride;
}

export interface RasterReport {
	dpr: number;
	backingW: number;
	backingH: number;
	cssW: number;
	cssH: number;
	/** True when backing/CSS is exactly dpr in both axes. */
	exact: boolean;
	/** Product of every ancestor's CSS transform scale. 1 = untransformed. */
	ancestorScale: number;
	/** Ancestors carrying a transform, zoom or filter, nearest first. */
	offenders: string[];
}

/**
 * matrix(a, b, c, d, e, f) transforms the basis vector (1, 0) to (a, b), so
 * Math.hypot(a, b) is that vector's new length: the horizontal scale, in any
 * rotation. `a` alone is only the horizontal scale when there is no rotation
 * - a layer scaled by 2 and rotated 90° has a=0, b=2, and reading `a` alone
 * reports scale 0 (audit-fixes-design.md §5l L2, 2026-09-02).
 * matrix3d(...) is not parsed: past the XY plane there is no single
 * "horizontal scale" this formula still answers correctly, so it falls
 * through to the untransformed default instead of reporting a wrong number.
 */
export function scaleOfTransform(value: string): number {
	if (!value || value === "none") return 1;
	const m = /^matrix\(([^,]+),([^,]+),/.exec(value);
	if (!m || m[1] === undefined || m[2] === undefined) return 1;
	const a = Number.parseFloat(m[1]);
	const b = Number.parseFloat(m[2]);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
	const scale = Math.hypot(a, b);
	return scale !== 0 ? scale : 1;
}

function describe(el: Element): string {
	const cls = typeof el.className === "string" ? el.className.split(/\s+/)[0] : "";
	return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
}

export function inspectRaster(canvas: HTMLCanvasElement): RasterReport {
	const dpr = window.devicePixelRatio || 1;
	const cssW = Number.parseFloat(canvas.style.width) || canvas.clientWidth;
	const cssH = Number.parseFloat(canvas.style.height) || canvas.clientHeight;
	const exact =
		Math.abs(canvas.width - cssW * dpr) < 0.001 &&
		Math.abs(canvas.height - cssH * dpr) < 0.001;

	let ancestorScale = 1;
	const offenders: string[] = [];
	let node: Element | null = canvas.parentElement;
	let depth = 0;
	while (node && depth < 24) {
		const cs = getComputedStyle(node);
		const s = scaleOfTransform(cs.transform);
		const zoom = Number.parseFloat(cs.zoom || "1") || 1;
		if (s !== 1 || zoom !== 1 || (cs.filter && cs.filter !== "none")) {
			offenders.push(
				`${describe(node)}${s !== 1 ? ` scale ${s.toFixed(3)}` : ""}` +
					`${zoom !== 1 ? ` zoom ${zoom}` : ""}` +
					`${cs.filter && cs.filter !== "none" ? " filter" : ""}`
			);
		}
		ancestorScale *= s * zoom;
		node = node.parentElement;
		depth++;
	}

	return {
		dpr,
		backingW: canvas.width,
		backingH: canvas.height,
		cssW,
		cssH,
		exact,
		ancestorScale,
		offenders,
	};
}

/**
 * Human-readable summary. `zoom` is the camera zoom, so the last line answers
 * the real question: how many device pixels is one world unit rendered into?
 */
export function formatRaster(r: RasterReport, zoom: number): string {
	const lines = [
		`DPR:       ${r.dpr}`,
		`Backing:   ${r.backingW}×${r.backingH}`,
		`CSS box:   ${r.cssW.toFixed(2)}×${r.cssH.toFixed(2)}`,
		`1:1 pixels ${r.exact ? "yes" : "NO, canvas is being resampled"}`,
		`Ancestor:  ${r.ancestorScale === 1 ? "no transform" : `SCALED ×${r.ancestorScale.toFixed(3)}`}`,
		`Raster:    ${(r.dpr * zoom * r.ancestorScale).toFixed(2)} device px per world unit`,
	];
	if (r.offenders.length > 0) lines.push(`Offenders: ${r.offenders.join(", ")}`);
	return lines.join("\n");
}

/**
 * Sample-precision measurement, to separate raster aliasing from geometric
 * faceting: if the digitizer only reports whole CSS pixels, the stored path is
 * a staircase and no amount of raster resolution will smooth it. The geometry
 * has to interpolate instead.
 */
export class InputPrecision {
	private total = 0;
	private integral = 0;
	private steps: number[] = [];
	private lastX = 0;
	private lastY = 0;
	private has = false;

	reset(): void {
		this.total = 0;
		this.integral = 0;
		this.steps = [];
		this.has = false;
	}

	add(x: number, y: number): void {
		this.total++;
		if (Number.isInteger(x) && Number.isInteger(y)) this.integral++;
		if (this.has) {
			const d = Math.hypot(x - this.lastX, y - this.lastY);
			this.steps.push(d);
			if (this.steps.length > 512) this.steps.shift();
		}
		this.lastX = x;
		this.lastY = y;
		this.has = true;
	}

	/** Percentage of samples landing exactly on integer CSS pixels. */
	get integerPercent(): number {
		return this.total === 0 ? 0 : Math.round((this.integral / this.total) * 100);
	}

	get medianStepPx(): number {
		if (this.steps.length === 0) return 0;
		const sorted = [...this.steps].sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)] ?? 0;
	}

	summary(): string {
		return `Input:     ${this.integerPercent}% integer px, median step ${this.medianStepPx.toFixed(2)} css px`;
	}
}
