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

function anchor(width: number, fontPx = 16): LineAnchor {
	return { line: 4, top: 72, y: 80, key: 1, width, fontPx };
}

function stroke(id: string, width?: number, createdAt = 1, fontPx = 16): InkStroke {
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
		...(width === undefined ? {} : { lineAnchor: anchor(width, fontPx) }),
	} as InkStroke;
}

function page(strokes: InkStroke[], columnRefPx?: number, fontRefPx?: number): PageData {
	const p = emptyPage("pg1");
	p.surface = "inline";
	p.strokes = strokes;
	if (columnRefPx !== undefined) (p as { columnRefPx?: number }).columnRefPx = columnRefPx;
	if (fontRefPx !== undefined) p.fontRefPx = fontRefPx;
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

describe("column width taken from anchors drawn at more than one text size", () => {
	/** A stroke whose anchor was taken at this text size. Every file here has no stored width unless one is passed. */
	const at = (id: string, width: number, fontPx: number) => stroke(id, width, 1, fontPx);

	it("only the anchors at the note's own text size vote when there are any", async () => {
		// Three anchors at 18 px carry 906, two at 16 px carry 805: the note's text size is 16, so the column is 805.
		const { store, saves } = rig(page([at("a", 906, 18), at("b", 805, 16), at("c", 906, 18), at("d", 805, 16), at("e", 906, 18)], undefined, 16));
		await store.ensureLoaded(PATH);
		expect(held(store)).toBe(805);
		store.commit(PATH, stroke("f", 805, 2));
		expect(savedRef(saves[saves.length - 1])).toBe(805);
	});

	it("a width an older build held at another text size is not scaled when anchors at the note's size exist", async () => {
		// Two at 16 px and three at 18 px all carry 805 (an older build held 805 at either size): 805, not 716.
		const { store } = rig(page([at("a", 805, 16), at("b", 805, 18), at("c", 805, 18), at("d", 805, 16), at("e", 805, 18)], undefined, 16));
		await store.ensureLoaded(PATH);
		expect(held(store)).toBe(805);
	});

	it("a tie among the anchors at the note's size goes to the one met first; other sizes do not break it", async () => {
		const { store } = rig(page([at("a", 700, 18), at("b", 604, 16), at("c", 700, 18), at("d", 529, 16), at("e", 700, 18)], undefined, 16));
		await store.ensureLoaded(PATH);
		expect(held(store)).toBe(604);
	});

	it("with no anchor at the note's size, each width is scaled to it and rounded before the vote", async () => {
		// 906 at 18 px for a note at 16 px: 906 x 16 / 18 = 805.3, so 805.
		const { store, saves } = rig(page([at("a", 906, 18)], undefined, 16));
		await store.ensureLoaded(PATH);
		expect(held(store)).toBe(805);
		store.commit(PATH, stroke("b", 805, 2));
		expect(savedRef(saves[saves.length - 1])).toBe(805);
	});

	it("with no anchor at the note's size, the vote runs on the scaled widths", async () => {
		// 900 at 18 and 1000 at 20 both scale to 800 at 16; 720 at 18 scales to 640. Unscaled, each width is met once and
		// 720 would win as the first met.
		const { store } = rig(page([at("a", 720, 18), at("b", 900, 18), at("c", 1000, 20)], undefined, 16));
		await store.ensureLoaded(PATH);
		expect(held(store)).toBe(800);
	});

	it("a stored width still wins whatever the anchors carry", async () => {
		const { store } = rig(page([at("a", 906, 18), at("b", 906, 18)], 805, 16));
		await store.ensureLoaded(PATH);
		expect(held(store)).toBe(805);
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
