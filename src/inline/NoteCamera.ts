/**
 * Each note's last zoom and scroll, kept for the app session (GitHub issue 9).
 *
 * Alan's contract for Back: it never changes scroll or zoom. Obsidian turns Back into a history step on the leaf,
 * which either rebuilds the note's editor on the same file or switches the editor to another note and later back.
 * Both used to open the note at 100 percent and the top. The overlay saves the camera here when a note leaves the
 * editor (unmount, note switch) and gives it back when the note opens again. A note never seen this session has no
 * entry and opens as before: zoom 1, scroll 0.
 *
 * In memory only. Keyed by path, so the vault's rename and delete handlers move and drop entries the way they do for
 * the other path-keyed state; nothing is written to disk.
 */
export interface NoteCamera {
	zoom: number;
	left: number;
	top: number;
}

const cameras = new Map<string, NoteCamera>();

/** A camera worth keeping: finite, positive zoom, scroll at or past the origin. */
function valid(c: NoteCamera): boolean {
	return Number.isFinite(c.zoom) && c.zoom > 0 && Number.isFinite(c.left) && Number.isFinite(c.top) && c.left >= 0 && c.top >= 0;
}

export const noteCameras = {
	/** Keep the camera a note had when it left the editor. Zoom 1 at the origin is the default and drops the entry. */
	save(path: string, camera: NoteCamera): void {
		if (!valid(camera)) return;
		if (camera.zoom === 1 && camera.left === 0 && camera.top === 0) cameras.delete(path);
		else cameras.set(path, { zoom: camera.zoom, left: camera.left, top: camera.top });
	},
	/** The camera to restore when the note opens, or null for a note to open as new. */
	get(path: string): NoteCamera | null {
		return cameras.get(path) ?? null;
	},
	handleRename(oldPath: string, newPath: string): void {
		const camera = cameras.get(oldPath);
		cameras.delete(oldPath);
		if (camera) cameras.set(newPath, camera);
	},
	handleDelete(path: string): void {
		cameras.delete(path);
	},
	clear(): void {
		cameras.clear();
	},
};
