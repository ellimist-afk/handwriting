/**
 * The raster probe: what one scaled draw of the pane costs on this device, measured once per session at the first zoom
 * with diagnostics on. With diagnostics off it never arms: its only output is a line in the diagnostics zoom report, and
 * its two pane-size canvases are not worth paying for on every device.
 *
 * The test rig rasterizes on the CPU (SwiftShader), so its frame numbers say nothing about a real GPU. This measures the
 * real one: a pane-size raster drawn into a pane-size scratch canvas at a 1.21 scale, against the same draw at 1:1, each
 * draw followed by a 1 px readback so the draw is finished before the clock stops. It runs on idle, after the first
 * commit that changed the scale, and never again; the zoom report prints the result.
 *
 * Hot path: a commit pays one flag check. Nothing runs per frame.
 */

import { countPaintedPixels } from "../diag/Raster";
import { diagnosticsEnabled } from "../diag/DiagSwitch";

/** The scale of the scaled draw: one pinch step out of a typical gesture. */
export const RASTER_PROBE_SCALE = 1.21;
const REPS = 5;
/** Stop when the idle period has less than this left. */
const STOP_UNDER_MS = 10;
/** With no idle callback (iOS WebKit) the timer's run counts as an idle period of this length. */
const TIMER_BUDGET_MS = 50;

interface RasterProbeResult { scaled: number[]; unscaled: number[]; width: number; height: number; dpr: number }

let armed = false;
let result: RasterProbeResult | null = null;

type IdleWindow = Window & { requestIdleCallback?: (cb: (deadline: IdleDeadline) => void, o?: { timeout: number }) => number };

/**
 * Called by a commit that changed the scale. The first call in the session with diagnostics on schedules the probe; every
 * other call returns on the flags. The pane's css size is read here, after the flags, so those commits never read it.
 */
export function armRasterProbe(win: Window, pane: Pick<HTMLElement, "clientWidth" | "clientHeight">): void {
	if (armed || !diagnosticsEnabled()) return;
	armed = true;
	const cssWidth = pane.clientWidth, cssHeight = pane.clientHeight;
	const w = win as IdleWindow;
	const run = (deadline?: IdleDeadline) => {
		try {
			result = measureRaster(win, cssWidth, cssHeight, deadline);
		} catch {
			result = null;
		}
	};
	if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 2000 });
	else win.setTimeout(() => run(), 50);
}

function measureRaster(win: Window, cssWidth: number, cssHeight: number, deadline?: IdleDeadline): RasterProbeResult {
	const now = () => win.performance?.now() ?? Date.now();
	const start = now();
	const remaining = () => deadline ? deadline.timeRemaining() : TIMER_BUDGET_MS - (now() - start);
	const dpr = win.devicePixelRatio || 1;
	const width = Math.max(0, Math.round(cssWidth * dpr)), height = Math.max(0, Math.round(cssHeight * dpr));
	const out: RasterProbeResult = { scaled: [], unscaled: [], width, height, dpr };
	if (width === 0 || height === 0) return out;
	// Detached canvases, never in the page.
	const source = createEl("canvas"), scratch = createEl("canvas");
	source.width = scratch.width = width;
	source.height = scratch.height = height;
	// No willReadFrequently on the scratch: that hint keeps a canvas on the CPU, and the probe is after the GPU draw.
	const src = source.getContext("2d"), dst = scratch.getContext("2d");
	if (!src || !dst) return out;
	// Filled once: a raster the draw has to read, not an empty one the backend can skip.
	src.fillStyle = "#808080";
	src.fillRect(0, 0, width, height);
	src.fillStyle = "#202020";
	for (let x = 0; x < width; x += 16) src.fillRect(x, 0, 1, height);
	const draw = (k: number): number => {
		const t0 = now();
		dst.setTransform(k, 0, 0, k, 0, 0);
		dst.drawImage(source, 0, 0);
		dst.setTransform(1, 0, 0, 1, 0, 0);
		// The repo's one readback site: a 1 px read, so the draw has finished before the clock stops.
		countPaintedPixels(dst, 0, 0, 1, 1, 1);
		return now() - t0;
	};
	for (let rep = 0; rep < REPS; rep++) {
		if (remaining() < STOP_UNDER_MS) break;
		out.scaled.push(draw(RASTER_PROBE_SCALE));
		if (remaining() < STOP_UNDER_MS) break;
		out.unscaled.push(draw(1));
	}
	// Give the backing stores back now rather than at collection.
	source.width = source.height = scratch.width = scratch.height = 0;
	return out;
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function stat(xs: number[]): string {
	return xs.length ? `${median(xs).toFixed(2)}/${Math.max(...xs).toFixed(2)}` : "-/-";
}

/** The zoom report's line. With recording off and the probe never armed, a zoom would not run it, so the line says so. */
export function rasterProbeLine(): string {
	if (!result && !armed && !diagnosticsEnabled()) return "raster probe: not run (recording is off: run 'Diagnostics: begin recording', then zoom)";
	if (!result) return "raster probe: not run (zoom once first)";
	const r = result;
	return `raster probe: scaled ${stat(r.scaled)} ms k ${RASTER_PROBE_SCALE}, unscaled ${stat(r.unscaled)} ms, reps ${r.scaled.length}, pane ${r.width}x${r.height} px, dpr ${r.dpr}`;
}

/** Tests only: a fresh session. */
export function resetRasterProbe(): void {
	armed = false;
	result = null;
}
