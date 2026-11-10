/**
 * Each note's last zoom and scroll, kept on this device across restarts (GitHub issue 9, discussion 42).
 *
 * Alan's contract for Back: it never changes scroll or zoom. Obsidian turns Back into a history step on the leaf,
 * which either rebuilds the note's editor on the same file or switches the editor to another note and later back.
 * Both used to open the note at 100 percent and the top. The overlay saves the camera here when a note leaves the
 * editor (unmount, note switch) and when the page comes to rest, and gives it back when the note opens again. A note
 * with no entry opens as before: zoom 1, scroll 0.
 *
 * Kept in the app's local storage, one key for every note: per vault and per device, never in
 * the note, the ink file or data.json, which sync and would carry a phone's zoom to a desktop. Plugin load hands this
 * module the store; the stored value is read once, on first use. Every change writes the whole key, debounced 500 ms,
 * a dropped entry too. At most 300 entries; a save past that drops the oldest. Keyed by path, so the vault's rename and
 * delete handlers move and drop entries; layout-ready drops the paths the vault no longer has. Unload writes a pending
 * change at once and then empties memory and lets the store go, so an editor torn down after it saves to memory only
 * and can never replace the key with a map that has lost every other note.
 */
export interface NoteCamera {
	zoom: number;
	left: number;
	top: number;
}

interface Kept extends NoteCamera {
	/** When this entry was last saved, ms since the epoch; the prune drops the smallest first. */
	at: number;
}

/** The app's per-vault, per-device local storage, as plugin load passes it. */
export interface NoteCameraStore {
	load(key: string): unknown;
	save(key: string, value: unknown): void;
}

const KEY = "handwriting:note-cameras";
const VERSION = 1;
const WRITE_DELAY_MS = 500;
const MAX_ENTRIES = 300;

const cameras = new Map<string, Kept>();
let store: NoteCameraStore | null = null;
let read = false;
let writeTimer: number | null = null;

/** A camera worth keeping: finite, positive zoom, scroll at or past the origin. */
function valid(c: NoteCamera): boolean {
	return Number.isFinite(c.zoom) && c.zoom > 0 && Number.isFinite(c.left) && Number.isFinite(c.top) && c.left >= 0 && c.top >= 0;
}

/** Hand the module the device's store. Called at plugin load, before anything saves or reads. */
export function setNoteCameraStore(next: NoteCameraStore): void {
	cancelWrite();
	cameras.clear();
	store = next;
	read = false;
}

/** The stored map, once per store. Anything that is not a version-1 map of valid cameras reads as no cameras. */
function ensureRead(): void {
	if (read || !store) return;
	read = true;
	let value: unknown;
	try {
		value = store.load(KEY);
		if (typeof value === "string") value = JSON.parse(value);
	} catch {
		return;
	}
	if (!value || typeof value !== "object") return;
	const { v, cameras: stored } = value as { v?: unknown; cameras?: unknown };
	if (v !== VERSION || !stored || typeof stored !== "object") return;
	for (const [path, c] of Object.entries(stored as Record<string, Partial<Kept>>)) {
		if (!c || typeof c !== "object") continue;
		const kept = { zoom: Number(c.zoom), left: Number(c.left), top: Number(c.top), at: Number.isFinite(c.at) ? Number(c.at) : 0 };
		if (valid(kept)) cameras.set(path, kept);
	}
}

function cancelWrite(): void {
	if (writeTimer !== null) window.clearTimeout(writeTimer);
	writeTimer = null;
}

/** Write the whole key 500 ms after the last change. Never while no store is attached. */
function scheduleWrite(): void {
	if (!store) return;
	cancelWrite();
	writeTimer = window.setTimeout(write, WRITE_DELAY_MS);
}

function write(): void {
	writeTimer = null;
	if (!store) return;
	const out: Record<string, Kept> = {};
	for (const [path, c] of cameras) out[path] = { zoom: c.zoom, left: c.left, top: c.top, at: c.at };
	store.save(KEY, { v: VERSION, cameras: out });
}

/** Drop the oldest entries until at most 300 are left. */
function prune(): void {
	if (cameras.size <= MAX_ENTRIES) return;
	const byAge = [...cameras].sort((a, b) => a[1].at - b[1].at);
	for (const [path] of byAge.slice(0, cameras.size - MAX_ENTRIES)) cameras.delete(path);
}

export const noteCameras = {
	/** Keep the camera a note has. Zoom 1 at the origin is the default and drops the entry. */
	save(path: string, camera: NoteCamera): void {
		if (!valid(camera)) return;
		ensureRead();
		if (camera.zoom === 1 && camera.left === 0 && camera.top === 0) {
			if (!cameras.delete(path)) return;
		} else {
			// The commit funnel runs on a pane resize and on the restore too: a camera equal to the kept one writes nothing.
			const kept = cameras.get(path);
			if (kept && kept.zoom === camera.zoom && kept.left === camera.left && kept.top === camera.top) return;
			cameras.delete(path);
			cameras.set(path, { zoom: camera.zoom, left: camera.left, top: camera.top, at: Date.now() });
			prune();
		}
		scheduleWrite();
	},
	/** The camera to restore when the note opens, or null for a note to open as new. */
	get(path: string): NoteCamera | null {
		ensureRead();
		const c = cameras.get(path);
		return c ? { zoom: c.zoom, left: c.left, top: c.top } : null;
	},
	handleRename(oldPath: string, newPath: string): void {
		ensureRead();
		const camera = cameras.get(oldPath);
		if (!camera) return;
		cameras.delete(oldPath);
		cameras.set(newPath, camera);
		scheduleWrite();
	},
	handleDelete(path: string): void {
		ensureRead();
		if (cameras.delete(path)) scheduleWrite();
	},
	/** Drop every entry whose note the vault no longer has. Run once the vault is indexed (layout-ready), never earlier. */
	dropVanished(exists: (path: string) => boolean): void {
		ensureRead();
		let dropped = false;
		for (const path of [...cameras.keys()]) {
			if (!exists(path)) {
				cameras.delete(path);
				dropped = true;
			}
		}
		if (dropped) scheduleWrite();
	},
	/** Write a pending change now. saveLocalStorage is synchronous, so this is done when it returns. */
	flush(): void {
		if (writeTimer === null) return;
		cancelWrite();
		write();
	},
	/** Empty memory and let the store go; storage keeps what was last written. */
	clear(): void {
		cancelWrite();
		cameras.clear();
		store = null;
		read = false;
	},
};
