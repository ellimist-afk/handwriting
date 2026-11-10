/**
 * The column width a note's ink is held at (ColumnRef.ts): set once, kept through a re-take of the anchors and through a
 * save at another width, taken once from the file's anchors when the file predates it, absent without anchors, and kept by
 * an older build that does not know the field.
 */
import { describe, expect, it } from "vitest";
import type { InkStroke, LineAnchor } from "../ink/Stroke";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import type { PageData } from "../model/PageData";

(globalThis as { window?: unknown }).window = globalThis;
import { InlineInkStore } from "./InlineInkStore";
import type { InlineInkHost } from "./InlineInkStore";

function anchor(width: number): LineAnchor {
	return { line: 4, top: 72, y: 80, key: 1, width, fontPx: 16 };
}

function stroke(id: string, width?: number, createdAt = 1): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x: 10, y: 80, pressure: 0.5, t: 0 },
			{ x: 60, y: 84, pressure: 0.5, t: 8 },
		],
		bbox: { x: 8, y: 80, width: 54, height: 6 },
		createdAt,
		...(width === undefined ? {} : { lineAnchor: anchor(width) }),
	} as InkStroke;
}

function page(strokes: InkStroke[], columnRefPx?: number): PageData {
	const p = emptyPage("pg1");
	p.surface = "inline";
	p.strokes = strokes;
	if (columnRefPx !== undefined) (p as { columnRefPx?: number }).columnRefPx = columnRefPx;
	return p;
}

function rig(stored?: PageData) {
	const saves: PageData[] = [];
	const host: InlineInkHost = {
		readPageId: () => "pg1",
		claimId: async (_p, id) => ({ pageId: id }),
		loadSidecar: async () => (stored ? { data: stored, recovered: false } : null),
		scheduleSidecar: (_id, p) => void saves.push(p),
		notify: () => undefined,
	};
	const store = new InlineInkStore();
	store.attachHost(host);
	return { store, saves };
}

const PATH = "a.md";

/** Reached as a caller that may not have it would, so a base without the accessor fails on the value, not on a throw. */
const held = (store: InlineInkStore, path = PATH) => (store as unknown as { columnRefPx?(p: string): number | null }).columnRefPx?.(path);
const savedRef = (p: PageData | undefined) => (p as { columnRefPx?: number } | undefined)?.columnRefPx;

/** What a re-take at another width does to an anchor in memory (LineAnchor.ts, anchorMeasured): the width is the new one. */
function retake(store: InlineInkStore, width: number) {
	for (const s of store.strokes(PATH)) if (s.lineAnchor) s.lineAnchor.width = width;
}

describe("column width a note's ink is held at", () => {
	it("a stored width wins over the anchors and is never replaced", async () => {
		const { store, saves } = rig(page([stroke("a", 529), stroke("b", 529)], 604));
		await store.ensureLoaded(PATH);
		expect(held(store)).toBe(604);
		store.commit(PATH, stroke("c", 529, 2));
		expect(savedRef(saves[saves.length - 1])).toBe(604);
	});

	it("a file without the field takes the width most of its anchors carry, once, from the file as read", async () => {
		const { store, saves } = rig(page([stroke("a", 604), stroke("b", 529), stroke("c", 604)]));
		await store.ensureLoaded(PATH);
		// A re-take at another width before anyone asks: the width is the file's, not the re-take's.
		retake(store, 398);
		expect(held(store)).toBe(604);
		store.commit(PATH, stroke("d", 398, 2));
		expect(savedRef(saves[saves.length - 1])).toBe(604);
	});

	it("a tie goes to the width of the first stroke in the file", async () => {
		const { store } = rig(page([stroke("a", 529), stroke("b", 604)]));
		await store.ensureLoaded(PATH);
		expect(held(store)).toBe(529);
	});

	it("the newest stroke's width does not decide it", async () => {
		const { store } = rig(page([stroke("a", 604, 1), stroke("b", 604, 2), stroke("c", 398, 9)]));
		await store.ensureLoaded(PATH);
		expect(held(store)).toBe(604);
	});

	it("a save at another width keeps the width", async () => {
		const { store, saves } = rig(page([stroke("a", 604)], 604));
		await store.ensureLoaded(PATH);
		retake(store, 398);
		store.commit(PATH, stroke("b", 398, 2));
		expect(savedRef(saves[saves.length - 1])).toBe(604);
		store.commit(PATH, stroke("c", 398, 3));
		expect(savedRef(saves[saves.length - 1])).toBe(604);
	});

	it("a note with no anchored ink has none, and its save carries none", async () => {
		const { store, saves } = rig(page([stroke("a"), stroke("b")]));
		await store.ensureLoaded(PATH);
		expect(held(store)).toBeNull();
		store.commit(PATH, stroke("c", undefined, 2));
		expect(saves.length).toBeGreaterThan(0);
		expect(savedRef(saves[saves.length - 1])).toBeUndefined();
	});

	it("a new note takes the width of its first anchored ink, and the next save carries it", async () => {
		const { store, saves } = rig();
		await store.ensureLoaded(PATH);
		expect(held(store)).toBeNull();
		store.commit(PATH, stroke("a", 604));
		expect(held(store)).toBe(604);
		retake(store, 398);
		store.commit(PATH, stroke("b", 398, 2));
		expect(held(store)).toBe(604);
		expect(savedRef(saves[saves.length - 1])).toBe(604);
	});

	it("an unknown note has none", () => {
		const { store } = rig();
		expect(held(store, "nowhere.md")).toBeNull();
	});
});

describe("column width in the file", () => {
	it("reads and writes back a whole number of px above zero", () => {
		const text = serializePage(page([stroke("a", 604)], 604));
		expect(JSON.parse(text).columnRefPx).toBe(604);
		expect(savedRef(parsePage(text, "pg1").data)).toBe(604);
	});

	it("drops a value that is not a whole number of px above zero", () => {
		for (const bad of [0, -604, 604.5, "604", null]) {
			const raw = JSON.parse(serializePage(page([stroke("a", 604)])));
			raw.columnRefPx = bad;
			const read = parsePage(JSON.stringify(raw), "pg1").data;
			expect(savedRef(read), String(bad)).toBeUndefined();
			expect(JSON.parse(serializePage(read)).columnRefPx, String(bad)).toBeUndefined();
		}
	});

	it("survives a save by a build that does not know the field", () => {
		const read = parsePage(serializePage(page([stroke("a", 604)], 604)), "pg1").data;
		// An older build holds the field as an unknown top-level key and writes it back as found.
		const older = { ...read, unknownTop: { ...read.unknownTop, columnRefPx: 604 } } as PageData;
		delete (older as { columnRefPx?: number }).columnRefPx;
		const again = parsePage(serializePage(older), "pg1").data;
		expect(savedRef(again)).toBe(604);
		expect(JSON.parse(serializePage(again)).columnRefPx).toBe(604);
	});
});
