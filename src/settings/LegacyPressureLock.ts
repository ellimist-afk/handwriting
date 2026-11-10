/**
 * The legacy pressure lock: what strokes saved without their own pressure setting draw under on THIS device.
 *
 * It lives in Obsidian's per-vault, per-device local store, not in data.json. data.json syncs, and a lock that
 * travelled could land another device's value on this one's old ink for good: a new device that launched before sync
 * delivered the file would lock the default and push it everywhere, and a file arriving without the key would clear
 * the lock (ink-safety read, 1.5.0 pressure mark F1 and F2). Here each device locks from its own switch and sync
 * carries nothing.
 *
 * Taken once, at this build's first launch on the device that reads a settings file, from the choice that file holds
 * (`pressureChoiceFrom`). Never from no file. A fresh install or an empty file holds no choice, and the file that
 * launch saves holds only this device's defaults, so a lock from it would pin old ink to a value nobody chose. That
 * launch marks the device pending instead, with no toast, and the pending path below does the rest. An unreadable file
 * changes nothing: no lock, and the next launch that reads it locks from the choice it holds. A wiped store relocks from
 * the switch at that launch. The 1.4.20 cohort (the switch pinned on, no pressureChoice key, last seen 1.4.20) is
 * marked pending too, and its toast asks the user to turn pressure off for their old ink. Pending lasts the whole
 * session, old ink following the switch, so flipping back undoes an accidental flip as in 1.4.24. The store remembers
 * the last value the user set on this device, and the next launch locks from that. No set, still pending. Only the
 * launch that first marks the 1.4.20 cohort pending shows the toast, once per device.
 *
 * Same seam shape as the pen-hardware latch (PenToolsMode.ts), wired in onloadDevice above loadSettings. Null in the
 * unit tests unless one sets it, so every access is a no-op rather than a crash.
 */
import { pressureChoiceFrom, type HandwritingSettings } from "./SettingsModel";

export const LEGACY_PRESSURE_KEY = "handwriting-legacy-ink-pressure";
/** What loadSettings passes when no settings file existed (fresh install) or the file was empty: nobody's choice. */
export const NO_FILE = "no settings file";
/** Stored for the 1.4.20 cohort until the user sets the switch. */
const PENDING = "pending";
/** The 1.4.20 cohort, still pending, with the last value the user set on this device: the next launch locks from it. */
const SET_ON = "pending, set on";
const SET_OFF = "pending, set off";

export interface LegacyPressureStore {
	/** `unknown`: some Obsidian versions read back through a JSON decode, so "true" may arrive as the boolean. */
	load(key: string): unknown;
	save(key: string, value: string): void;
}

let store: LegacyPressureStore | null = null;

export function setLegacyPressureStore(s: LegacyPressureStore | null): void {
	store = s;
}

type Stored = boolean | typeof PENDING | typeof SET_ON | typeof SET_OFF | null;

function read(): Stored {
	let v: unknown = null;
	try {
		v = store?.load(LEGACY_PRESSURE_KEY) ?? null;
	} catch {
		return null;
	}
	if (v === true || v === "true") return true;
	if (v === false || v === "false") return false;
	if (v === PENDING) return PENDING;
	if (v === SET_ON) return SET_ON;
	if (v === SET_OFF) return SET_OFF;
	return null;
}

function write(v: Exclude<Stored, null>): void {
	try {
		store?.save(LEGACY_PRESSURE_KEY, String(v));
	} catch {
		/* storage denied: this session draws under the value in memory, and the next launch locks again */
	}
}

/** A vault straight from 1.4.20: the switch pinned on, no second key, and 1.4.20 the last version seen. */
function from1420(raw: Partial<HandwritingSettings>): boolean {
	return raw.lastSeenVersion === "1.4.20" && raw.pressureSensitivity === true && typeof raw.pressureChoice !== "boolean";
}

/**
 * The launch half, from loadSettings. `raw` is the settings file as read, NO_FILE when there was none or it was empty,
 * or null when it could not be read. Returns what unmarked ink draws under this session; null means it follows the
 * switch. `onMarkedPending` runs at the one launch that first marks the 1.4.20 cohort pending on this device.
 */
export function takeLegacyPressureLock(
	raw: Partial<HandwritingSettings> | typeof NO_FILE | null,
	onMarkedPending?: () => void
): boolean | null {
	const stored = read();
	if (typeof stored === "boolean") return stored;
	if (stored === SET_ON || stored === SET_OFF) {
		const v = stored === SET_ON;
		write(v);
		return v;
	}
	if (stored === PENDING) return null;
	if (raw === NO_FILE) {
		write(PENDING);
		return null;
	}
	if (raw === null) return null;
	if (from1420(raw)) {
		write(PENDING);
		onMarkedPending?.();
		return null;
	}
	const v = pressureChoiceFrom(raw);
	write(v);
	return v;
}

/**
 * The switch half, from the settings row. For the 1.4.20 cohort it remembers this value as the last one set on this
 * device, for the next launch to lock from; this session stays pending. Nothing else changes. Returns the lock now
 * (null while it still follows the switch).
 */
export function lockOnSwitch(on: boolean): boolean | null {
	const stored = read();
	if (typeof stored === "boolean") return stored;
	if (stored === null) return null;
	write(on ? SET_ON : SET_OFF);
	return null;
}
