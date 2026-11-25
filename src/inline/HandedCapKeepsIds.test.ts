/**
 * A note hands more saves than are kept track of (64) before any is seen to land, as a held Ctrl+Z over ink steps does
 * inside one write window. The oldest save's changes pass to the next save kept, so once a later save is seen to land a
 * stroke changed in that oldest save is in the file, as it is below that count: a read of the file that shows another
 * device's cut of that stroke shows the cut, once, and one that shows its move shows the move. A stroke changed again in
 * a save not seen to land stays this note's.
 *
 * Real InlineInkStore (the plugin's). The host hands every save to a list and lands one only when the cell says so, so
 * no write lands early; the file is read through PageStore over FakeAdapter. The read is the merge of the note's file
 * that keeps the note's own ids (adoptSidecar), as a duplicate lock's lift and a heal run it: a reopen or a sync poll
 * replaces the page whole and forgets what was handed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { handedBefore } from "./InlineInkStoreCommit";
import { emptyPage, serializePage, type PageData } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkStroke } from "../ink/Stroke";

const N = "Note.md";
const PID = "note-page";
const FILE = `.handwriting/${PID}.json`;
/** Saves handed with none seen landed: two past the 64 kept. */
const SAVES = 66;

/** A straight stroke across the page at height y, a point every 2 px. */
function line(id: string, y: number, createdAt: number): InkStroke {
	const points = [];
	for (let i = 0; i <= 100; i++) points.push({ x: i * 2, y, pressure: 0.5, t: i });
	return { id, tool: "pen", color: "#000000", width: 2, points, bbox: { x: 0, y, width: 200, height: 0 }, createdAt } as InkStroke;
}

/** Stroke X as the file first holds it, at y 100. */
const X0 = (): InkStroke => line("X", 100, 1);

/** A piece the other device's eraser cut from X where this note moved it (y 130): X's samples 10 to 30. */
function pieceOfMovedX(): InkStroke {
	const moved = line("X", 130, 1);
	return { ...moved, id: "X-cut", points: moved.points.slice(10, 31), bbox: { x: 20, y: 130, width: 40, height: 0 } };
}

const ids = (list: readonly { id: string }[]): string[] => list.map((s) => s.id);
const heightOf = (list: readonly InkStroke[], id: string): number | undefined => list.find((s) => s.id === id)?.points[0]?.y;

function rig() {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const fileHolds = (strokes: readonly InkStroke[]): void => {
		const page = emptyPage(PID);
		page.surface = "inline";
		page.strokes = strokes.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) }));
		fake.files.set(FILE, serializePage(page));
	};
	fileHolds([X0()]);
	const handed: PageData[] = [];
	const landed = new Set<PageData>();
	const host: InlineInkHost = {
		readPageId: () => PID,
		claimId: async () => ({ pageId: PID }) as never,
		loadSidecar: (id) => store.load(id),
		scheduleSidecar: (_id, page) => void handed.push(page),
		scheduleSidecarNow: async (_id, page) => {
			handed.push(page);
			landed.add(page);
		},
		sidecarLanded: (page) => landed.has(page),
		notify: () => undefined,
	};
	inlineInk.attachHost(host);
	const rec = (): object => (inlineInk as unknown as { record(path: string): object }).record(N);
	/** The note's file read and merged into the note, its own ids kept. */
	const read = async (): Promise<readonly InkStroke[]> => {
		await (inlineInk as unknown as { adoptSidecar(rec: object, id: string): Promise<boolean> }).adoptSidecar(rec(), PID);
		return inlineInk.strokes(N);
	};
	return { handed, landed, fileHolds, rec, read };
}

/** Saves 2 to `to`: one new stroke each, none touching X. */
function drawUpTo(r: ReturnType<typeof rig>, to: number): void {
	while (r.handed.length < to) {
		const n = r.handed.length;
		inlineInk.commit(N, line(`s${n}`, 400 + 4 * n, 100 + n));
	}
}

/** X moved 30 px down in the first save, then 65 more saves, none seen landed. */
async function movedThenPastTheCap(r: ReturnType<typeof rig>): Promise<void> {
	await inlineInk.ensureLoaded(N);
	expect(ids(inlineInk.strokes(N)), "precondition: the note loaded its file").toEqual(["X"]);
	inlineInk.moveStrokes(N, ["X"], 0, 30);
	inlineInk.save(N);
	expect(r.handed.length, "precondition: the move was handed to the first save").toBe(1);
	drawUpTo(r, SAVES);
	expect(r.handed.length, "precondition: every change was handed to a save").toBe(SAVES);
	expect(r.landed.size, "precondition: no save has been seen to land").toBe(0);
	// The move's save was not taken early: its before-copy is still held as handed, past the cap.
	expect(handedBefore(r.rec() as never).some(([id, was]) => id === "X" && was.points[0]!.y === 100), "precondition: X's move is still held as handed").toBe(true);
}

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});

afterEach(() => {
	inlineInk.handleDelete(N);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("past 64 saves handed with none seen landed, a stroke changed in the oldest is in the file once a later save lands", () => {
	it.each([
		["the newest save", SAVES],
		["a middle save, the 30th", 30],
	] as const)("%s seen landed, the other device cut the stroke: the read shows its piece, once, and not the stroke whole", async (_label, at) => {
		const r = rig();
		await movedThenPastTheCap(r);
		const page = r.handed[at - 1]!;
		expect(heightOf(page.strokes, "X"), "precondition: the save seen landed holds X where this note moved it").toBe(130);
		r.landed.add(page);
		r.fileHolds([pieceOfMovedX(), ...page.strokes.filter((s) => s.id !== "X")]);
		const after = await r.read();
		expect(ids(after).filter((id) => id === "X" || id === "X-cut"), "the stroke the other device cut is drawn whole beside its piece, or its piece is gone").toEqual(["X-cut"]);
	});

	it.each([
		["the newest save", SAVES],
		["a middle save, the 30th", 30],
	] as const)("%s seen landed, the other device moved the stroke: the read shows it where the other device moved it", async (_label, at) => {
		const r = rig();
		await movedThenPastTheCap(r);
		const page = r.handed[at - 1]!;
		r.landed.add(page);
		r.fileHolds([line("X", 300, 1), ...page.strokes.filter((s) => s.id !== "X")]);
		const after = await r.read();
		expect(ids(after).filter((id) => id === "X"), "the stroke is not there once").toEqual(["X"]);
		expect(heightOf(after, "X"), "the other device's move of the stroke was put back").toBe(300);
	});
});

describe("past 64 saves handed with none seen landed, a stroke changed again in a save not seen landed stays this note's", () => {
	it("moved in the first save and again in the third, none landed: the read shows this note's latest place, not the file's", async () => {
		const r = rig();
		await inlineInk.ensureLoaded(N);
		inlineInk.moveStrokes(N, ["X"], 0, 30);
		inlineInk.save(N);
		drawUpTo(r, 2);
		inlineInk.moveStrokes(N, ["X"], 0, 30);
		inlineInk.save(N);
		expect(r.handed.length, "precondition: the second move was handed to the third save").toBe(3);
		drawUpTo(r, SAVES);
		expect(r.landed.size, "precondition: no save has been seen to land").toBe(0);
		expect(heightOf(inlineInk.strokes(N), "X"), "precondition: this note holds X at its latest place").toBe(160);
		r.fileHolds([X0(), ...r.handed[SAVES - 1]!.strokes.filter((s) => s.id !== "X")]);
		const after = await r.read();
		expect(ids(after).filter((id) => id === "X"), "the stroke is not there once").toEqual(["X"]);
		expect(heightOf(after, "X"), "a change in a save not seen landed lost to the file's older version").toBe(160);
	});
});
