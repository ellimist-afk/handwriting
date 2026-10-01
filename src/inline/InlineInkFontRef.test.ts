/** Audit 46: the store's font-reference accessor. Set once, rides an ordinary save. */
import { describe, expect, it } from "vitest";
import { InkStroke } from "../ink/Stroke";
import { emptyPage } from "../model/PageData";
import type { PageData } from "../model/PageData";

(globalThis as { window?: unknown }).window = globalThis;
import { InlineInkStore } from "./InlineInkStore";
import type { InlineInkHost } from "./InlineInkStore";

function stroke(id: string): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x: 10, y: 10, pressure: 0.5, t: 0 },
			{ x: 20, y: 20, pressure: 0.5, t: 8 },
		],
		bbox: { x: 8, y: 8, width: 16, height: 16 },
		createdAt: 1,
	} as InkStroke;
}

function rig(stored?: PageData) {
	const saves: PageData[] = [];
	const host: InlineInkHost = {
		readPageId: () => "pg1",
		claimId: async (_p, id) => ({ pageId: id }),
		loadSidecar: async () => (stored ? { data: stored, recovered: false } : null),
		scheduleSidecar: (_id, page) => void saves.push(page),
		notify: () => undefined,
	};
	const store = new InlineInkStore();
	store.attachHost(host);
	return { store, saves };
}

const PATH = "a.md";

/**
 * The accessor pair, reached the way a caller that may not have it would: an
 * absent method answers undefined instead of throwing, so every cell below
 * fails on its own BEHAVIORAL assertion at a base that lacks the accessors
 * (the note's saved reference, or the accessor's answer), not on a missing
 * method.
 */
function fontRef(store: InlineInkStore) {
	const api = store as unknown as {
		fontRefPx?(path: string): number | null;
		setFontRefPx?(path: string, px: number): boolean;
	};
	return {
		get: (path: string) => api.fontRefPx?.(path),
		set: (path: string, px: number) => api.setFontRefPx?.(path, px),
	};
}

describe("InlineInkStore font reference", () => {
	it("is null until set, and set-once", async () => {
		const { store } = rig();
		await store.ensureLoaded(PATH);
		expect(fontRef(store).get(PATH)).toBeNull();
		expect(fontRef(store).set(PATH, 16)).toBe(true);
		expect(fontRef(store).get(PATH)).toBe(16);
		expect(fontRef(store).set(PATH, 20)).toBe(false);
		expect(fontRef(store).get(PATH)).toBe(16);
	});

	it("refuses a value that is not finite and above zero", async () => {
		const { store } = rig();
		await store.ensureLoaded(PATH);
		for (const bad of [0, -1, NaN, Infinity]) expect(fontRef(store).set(PATH, bad)).toBe(false);
		expect(fontRef(store).get(PATH)).toBeNull();
	});

	it("a stored reference wins and cannot be replaced", async () => {
		const stored = emptyPage("pg1");
		stored.surface = "inline";
		stored.fontRefPx = 16;
		const { store } = rig(stored);
		await store.ensureLoaded(PATH);
		expect(fontRef(store).get(PATH)).toBe(16);
		expect(fontRef(store).set(PATH, 24)).toBe(false);
		expect(fontRef(store).get(PATH)).toBe(16);
	});

	it("a reference set before the sidecar loads yields to the one on disk", async () => {
		const stored = emptyPage("pg1");
		stored.surface = "inline";
		stored.fontRefPx = 16;
		const { store, saves } = rig(stored);
		store.commit(PATH, stroke("s0")); // the record exists; the sidecar read is still ahead
		expect(fontRef(store).set(PATH, 18)).toBe(true);
		await store.ensureLoaded(PATH);
		expect(fontRef(store).get(PATH)).toBe(16);
		store.commit(PATH, stroke("s1"));
		expect(saves[saves.length - 1]!.fontRefPx).toBe(16);
	});

	it("writes nothing by itself, then rides the next ordinary save once", async () => {
		const { store, saves } = rig();
		await store.ensureLoaded(PATH);
		const before = saves.length;
		fontRef(store).set(PATH, 18);
		expect(saves.length).toBe(before);
		store.commit(PATH, stroke("s1"));
		const last = saves[saves.length - 1]!;
		expect(last.fontRefPx).toBe(18);
		store.commit(PATH, stroke("s2"));
		expect(saves[saves.length - 1]!.fontRefPx).toBe(18);
	});

	it("an unknown path has no reference and takes none", () => {
		const { store } = rig();
		expect(fontRef(store).get("nowhere.md")).toBeNull();
		expect(fontRef(store).set("nowhere.md", 16)).toBe(false);
	});
});
