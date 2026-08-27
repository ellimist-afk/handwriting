/**
 * Adaptive pressure gain (the iPad width problem).
 *
 * WebKit hands the page a compressed pressure range: two test iPads topped
 * out near 0.24 where the Surface reaches 0.61, so the width law - tuned on
 * the Surface - only ever saw its bottom quarter and iPad ink came out
 * nearly flat. The gain rescales input pressure toward the regime the law
 * was tuned for: REFERENCE (0.55) over the maximum this DEVICE has actually
 * produced, clamped to [1, 3].
 *
 * The clamp floor is the desktop guarantee: a device already spanning the
 * reference range gets gain 1, so nothing about Surface rendering changes.
 * The ceiling caps a device that has only ever been touched gently. A freak
 * high spike ratchets the max up and drives the gain DOWN toward 1 - the
 * failure mode is the status quo, never over-thick ink.
 *
 * Applied at INPUT time, so corrected pressure is what gets stored: a
 * stroke renders the same forever, instead of restyling as the gain learns.
 * Frozen per stroke by the caller, so a mid-stroke ratchet cannot kink the
 * width. The device max persists per DEVICE on purpose, because settings
 * data.json syncs between devices and a Surface's 0.61 must not silence an
 * iPad's 0.24. Obsidian's own per-vault local store is what holds it: this
 * module names a seam and the plugin wires `App#saveLocalStorage` /
 * `App#loadLocalStorage` into it at load, so nothing here touches the raw
 * `localStorage` global (community directory scorecard, 2026-08-27).
 */

const REFERENCE_MAX = 0.55;
const GAIN_CAP = 3;
const STORAGE_KEY = "handwriting-device-pressure-max";

/**
 * What two test iPads topped out at. On iOS, where WebKit's compression is
 * a hardware certainty rather than a guess, this seeds the gain BEFORE the
 * first stroke - otherwise the first stroke of a fresh install draws thin
 * while the max learns. Everything learned afterwards wins over it.
 */
export const IOS_WEBKIT_CEILING = 0.24;

let deviceMax = 0;
let assumedMax = 0;

/**
 * The host's per-vault local store. Null until the plugin registers one -
 * and in the unit tests, which have no Obsidian - so every access below is
 * a no-op rather than a crash when it is absent.
 */
export interface PressureStore {
	load(key: string): string | null;
	save(key: string, value: string): void;
}

let store: PressureStore | null = null;

export function setPressureStore(s: PressureStore | null): void {
	store = s;
}

function readStored(): number {
	try {
		const raw = store?.load(STORAGE_KEY);
		if (raw === null || raw === undefined) return 0;
		const v = Number(raw);
		return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0;
	} catch {
		return 0;
	}
}

function writeStored(v: number): void {
	try {
		store?.save(STORAGE_KEY, String(v));
	} catch {
		/* storage denied: the gain just relearns next session */
	}
}

export function initPressureGain(coldStartMax = 0): void {
	deviceMax = readStored();
	assumedMax = coldStartMax;
}

/** The gain a stroke starting now should use, frozen by the caller. */
export function strokeGain(): number {
	// Anything actually learned beats the platform assumption, even a
	// lighter writer's smaller max - the design normalizes against how
	// THIS person writes, and the assumption only covers the blank slate.
	const max = deviceMax > 0 ? deviceMax : assumedMax;
	if (max <= 0) return 1; // nothing learned, nothing assumed: status quo
	return Math.min(GAIN_CAP, Math.max(1, REFERENCE_MAX / max));
}

/**
 * Forget the learned max (a freak spike pins the gain at 1 with no way
 * back). The platform assumption survives; the next strokes relearn.
 */
export function resetPressureCalibration(): void {
	deviceMax = 0;
	try {
		// Empty rather than removed: the host store exposes save and load,
		// and readStored already reads "" back as nothing learned.
		store?.save(STORAGE_KEY, "");
	} catch {
		/* nothing stored, nothing to clear */
	}
}

/**
 * A pen stroke finished with this raw (pre-gain) maximum pressure. Ratchets
 * the device max; only pen strokes report (a mouse's constant would poison
 * the estimate).
 */
export function observeStrokeMax(rawMax: number): void {
	if (!Number.isFinite(rawMax) || rawMax <= 0 || rawMax > 1) return;
	if (rawMax > deviceMax) {
		deviceMax = rawMax;
		writeStored(rawMax);
	}
}

/** Test seam. */
export function resetPressureGainForTest(max = 0, assumed = 0): void {
	deviceMax = max;
	assumedMax = assumed;
}
