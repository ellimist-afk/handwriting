/**
 * EACH NOTE'S ZOOM AND SCROLL SURVIVE A RESTART (discussion 42).
 *
 * The cameras are kept on the device under one local-storage key, handwriting:note-cameras, as
 * { v: 1, cameras: { path: { zoom, left, top, at } } }; never in the note, the ink file or data.json. Every change to
 * the map writes the whole key, debounced 500 ms, a dropped entry too. At most 300 entries are kept; the oldest go first.
 * The unload clear empties memory and detaches the store, so nothing written after it can overwrite the key with a
 * map that has lost every other note.
 *
 * Each cell hands the module a fake store (the app's loadLocalStorage and saveLocalStorage), as plugin load does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteCameras, setNoteCameraStore } from "./NoteCamera";

// The store's timers are the window's, as in a popout; here the window is the global, so the fake clock drives them.
(globalThis as { window?: unknown }).window ??= globalThis;

const KEY = "handwriting:note-cameras";

interface Stored {
	v: number;
	cameras: Record<string, { zoom: number; left: number; top: number; at: number }>;
}

function store(initial: Stored | null = null) {
	const values = new Map<string, unknown>();
	if (initial) values.set(KEY, initial);
	const save = vi.fn((key: string, value: unknown) => void values.set(key, value));
	return { load: (key: string) => values.get(key) ?? null, save, read: () => values.get(KEY) as Stored | undefined };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
	noteCameras.clear();
});
afterEach(() => {
	noteCameras.clear();
	vi.useRealTimers();
});

describe("a note's camera is kept on the device", () => {
	it("a fresh load gives back the camera a note had before the restart", () => {
		const s = store({ v: 1, cameras: { "Kept.md": { zoom: 0.5, left: 0, top: 600, at: 900_000 } } });
		setNoteCameraStore(s);
		expect(noteCameras.get("Kept.md")).toEqual({ zoom: 0.5, left: 0, top: 600 });
	});

	it("a save writes the whole key once, 500 ms after the last change", () => {
		const s = store();
		setNoteCameraStore(s);
		noteCameras.save("A.md", { zoom: 2, left: 40, top: 10 });
		vi.advanceTimersByTime(499);
		expect(s.save).not.toHaveBeenCalled();
		noteCameras.save("B.md", { zoom: 0.5, left: 0, top: 300 });
		vi.advanceTimersByTime(499);
		expect(s.save, "the second save restarts the 500 ms").not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(s.save).toHaveBeenCalledTimes(1);
		expect(s.save.mock.calls[0]?.[0]).toBe(KEY);
		expect(Object.keys(s.read()!.cameras).sort()).toEqual(["A.md", "B.md"]);
		expect(s.read()!.v).toBe(1);
		expect(s.read()!.cameras["B.md"]).toEqual({ zoom: 0.5, left: 0, top: 300, at: 1_000_499 });
	});

	it("zoom 1 at the origin removes the entry from storage too", () => {
		const s = store({ v: 1, cameras: { "Back.md": { zoom: 0.5, left: 0, top: 600, at: 900_000 } } });
		setNoteCameraStore(s);
		noteCameras.save("Back.md", { zoom: 1, left: 0, top: 0 });
		vi.advanceTimersByTime(500);
		expect(s.save).toHaveBeenCalledTimes(1);
		expect(s.read()!.cameras).not.toHaveProperty("Back.md");
	});

	it("a save equal to the kept camera writes nothing", () => {
		const s = store({ v: 1, cameras: { "Same.md": { zoom: 0.5, left: 0, top: 600, at: 900_000 } } });
		setNoteCameraStore(s);
		noteCameras.save("Same.md", { zoom: 0.5, left: 0, top: 600 });
		noteCameras.save("Absent.md", { zoom: 1, left: 0, top: 0 });
		vi.advanceTimersByTime(1000);
		expect(s.save).not.toHaveBeenCalled();
	});

	it("keeps 300 entries: the 301st save drops the oldest", () => {
		const s = store();
		setNoteCameraStore(s);
		for (let i = 0; i < 301; i++) {
			vi.setSystemTime(1_000_000 + i * 1000);
			noteCameras.save(`N${i}.md`, { zoom: 2, left: 0, top: i });
		}
		vi.advanceTimersByTime(500);
		const kept = Object.keys(s.read()!.cameras);
		expect(kept).toHaveLength(300);
		expect(kept).not.toContain("N0.md");
		expect(kept).toContain("N1.md");
		expect(kept).toContain("N300.md");
		expect(noteCameras.get("N0.md")).toBeNull();
	});

	it("a rename moves the entry in storage and a delete drops it", () => {
		const s = store({
			v: 1,
			cameras: {
				"Old.md": { zoom: 0.5, left: 0, top: 600, at: 900_000 },
				"Gone.md": { zoom: 2, left: 40, top: 0, at: 900_000 },
			},
		});
		setNoteCameraStore(s);
		// Each on its own, read back from storage after its own 500 ms, so neither can ride the other's write.
		noteCameras.handleRename("Old.md", "New.md");
		vi.advanceTimersByTime(500);
		expect(s.save, "the rename was not written").toHaveBeenCalledTimes(1);
		expect(Object.keys(s.read()!.cameras).sort()).toEqual(["Gone.md", "New.md"]);
		expect(s.read()!.cameras["New.md"]).toMatchObject({ zoom: 0.5, left: 0, top: 600 });
		noteCameras.handleDelete("Gone.md");
		vi.advanceTimersByTime(500);
		expect(s.save, "the delete was not written").toHaveBeenCalledTimes(2);
		expect(Object.keys(s.read()!.cameras)).toEqual(["New.md"]);
	});

	it("the unload clear empties memory, leaves storage as it was, and a save after it writes nothing", () => {
		const s = store({ v: 1, cameras: { "Kept.md": { zoom: 0.5, left: 0, top: 600, at: 900_000 } } });
		setNoteCameraStore(s);
		expect(noteCameras.get("Kept.md")).not.toBeNull();
		noteCameras.clear();
		expect(noteCameras.get("Kept.md")).toBeNull();
		// An editor torn down after the plugin's unload still saves its camera; written, it would replace the key with a
		// map holding that one note.
		noteCameras.save("Late.md", { zoom: 2, left: 0, top: 50 });
		vi.advanceTimersByTime(1000);
		expect(s.save).not.toHaveBeenCalled();
		expect(Object.keys(s.read()!.cameras)).toEqual(["Kept.md"]);
	});

	it("flush writes a pending change at once, and the 500 ms timer then writes nothing more", () => {
		const s = store();
		setNoteCameraStore(s);
		noteCameras.save("Quit.md", { zoom: 2, left: 0, top: 80 });
		noteCameras.flush();
		expect(s.save).toHaveBeenCalledTimes(1);
		expect(s.read()!.cameras["Quit.md"]).toMatchObject({ zoom: 2, left: 0, top: 80 });
		vi.advanceTimersByTime(1000);
		expect(s.save).toHaveBeenCalledTimes(1);
	});

	it("drops the paths the vault no longer has when asked, and writes the drop", () => {
		const s = store({
			v: 1,
			cameras: {
				"Here.md": { zoom: 0.5, left: 0, top: 600, at: 900_000 },
				"Gone.md": { zoom: 2, left: 40, top: 0, at: 900_000 },
			},
		});
		setNoteCameraStore(s);
		noteCameras.dropVanished((path) => path === "Here.md");
		expect(noteCameras.get("Gone.md")).toBeNull();
		expect(noteCameras.get("Here.md")).toEqual({ zoom: 0.5, left: 0, top: 600 });
		vi.advanceTimersByTime(500);
		expect(Object.keys(s.read()!.cameras)).toEqual(["Here.md"]);
	});

	it("reads a stored value it cannot use as no cameras, and never throws", () => {
		for (const bad of ["{", 42, { v: 2, cameras: {} }, { v: 1, cameras: { "X.md": { zoom: -1, left: 0, top: 0, at: 1 } } }]) {
			const values = new Map<string, unknown>([[KEY, bad]]);
			setNoteCameraStore({ load: (k) => values.get(k) ?? null, save: () => {} });
			expect(noteCameras.get("X.md")).toBeNull();
			noteCameras.clear();
		}
	});
});
