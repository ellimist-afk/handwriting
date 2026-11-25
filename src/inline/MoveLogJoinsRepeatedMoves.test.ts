/**
 * A lasso drag with no lasso picture moves the store once per pen sample (lassoMove, then moveLive, then the store's
 * moveStrokes), so one contact calls the store's move hundreds of times over the same strokes. The versions kept without
 * a copy of their points read them back through the note's log of moves, so the log must take those calls as one: as
 * many entries as one call, however many calls, while no version is kept between them. A call that keeps a new version
 * (the first change of a stroke after a save) gets an entry of its own, so the versions it keeps read only the moves from
 * it on; a call over other strokes gets one too.
 *
 * Real InlineInkStore (the plugin's), the host and the file as in MoveKeepsVersionsAsStood.test.ts: saves are handed to
 * a list and none lands. Each version is read once, after the last call. Its x and y are compared within 1e-6 (the bar
 * after many moves); its id, createdAt, tool, colour, width and each point's pressure and time exactly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { handedBefore, keptShifts, unsavedChanges } from "./InlineInkStoreCommit";
import { emptyPage, serializePage, type PageData } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkPoint, InkStroke } from "../ink/Stroke";

const N = "MoveLog.md";
const PID = "move-log-page";
const FILE = `.handwriting/${PID}.json`;
/** Within this a rebuilt x or y after many moves is the number it stood at. */
const NEAR = 1e-6;

/** A stroke of 101 samples at uneven, non-integer places. */
function stroke(id: string, createdAt: number, x0 = 5.3, y0 = 100.37): InkStroke {
	const points: InkPoint[] = [];
	for (let i = 0; i <= 100; i++) points.push({ x: x0 + i * 2.07, y: y0 + (i % 5) * 0.13, pressure: 0.25 + (i % 3) * 0.25, t: i * 4 });
	const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
	const bbox = { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1, width: Math.max(...xs) - Math.min(...xs) + 2, height: Math.max(...ys) - Math.min(...ys) + 2 };
	return { id, tool: "pen", color: "#1f2a44", width: 2, points, bbox, createdAt };
}

function copyOf(s: InkStroke): InkStroke {
	return { ...s, points: s.points.map((p) => ({ ...p })), bbox: { ...s.bbox } };
}

function strokes(n: number): InkStroke[] {
	return Array.from({ length: n }, (_, i) => stroke(`m${i}`, 10 + i, 5.3, 100.37 + i * 9));
}

/** Pen sample i's step: small, uneven, never zero. */
const dxOf = (i: number): number => -0.73 + (i % 13) * 0.171;
const dyOf = (i: number): number => -0.29 + (i % 7) * 0.083;

/** The version is the stroke as it stood: exact in all but x and y, which are within NEAR. Returns the farthest point. */
function expectStood(v: InkStroke | null | undefined, was: InkStroke, label: string): number {
	expect(v, `${label}: a version is kept`).toBeTruthy();
	const got = v!;
	expect([got.id, got.createdAt, got.tool, got.color, got.width], `${label}: id, createdAt, tool, colour and width as they stood`).toEqual([was.id, was.createdAt, was.tool, was.color, was.width]);
	const pts = got.points;
	expect(pts.length, `${label}: as many points as it stood with`).toBe(was.points.length);
	let worst = 0;
	for (let i = 0; i < pts.length; i++) {
		const a = pts[i]!, b = was.points[i]!;
		worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
		if (a.pressure !== b.pressure || a.t !== b.t) expect([i, a.pressure, a.t], `${label}: point ${i}'s pressure and time as they stood`).toEqual([i, b.pressure, b.t]);
	}
	expect(worst, `${label}: the farthest point from where it stood`).toBeLessThanOrEqual(NEAR);
	return worst;
}

function rig(fileStrokes: readonly InkStroke[]) {
	const fake = new FakeAdapter();
	const store = new PageStore({ vault: { adapter: fake } } as never);
	const page = emptyPage(PID);
	page.surface = "inline";
	page.strokes = fileStrokes.map(copyOf);
	fake.files.set(FILE, serializePage(page));
	const handed: PageData[] = [];
	const host: InlineInkHost = {
		readPageId: () => PID,
		claimId: async () => ({ pageId: PID }) as never,
		loadSidecar: (id) => store.load(id),
		scheduleSidecar: (_id, p) => {
			handed.push(p);
		},
		sidecarLanded: () => false,
		notify: () => undefined,
	};
	inlineInk.attachHost(host);
	const rec = (): never => (inlineInk as unknown as { record(path: string): never }).record(N);
	const live = (id: string): InkStroke => inlineInk.strokes(N).find((s) => s.id === id)!;
	const stood = (ids: readonly string[]): InkStroke[] => ids.map((id) => copyOf(live(id)));
	return { handed, rec, live, stood };
}

/** `calls` moves of the store over `ids`, the steps of pen samples `from` on. */
function drag(ids: readonly string[], calls: number, from = 0): void {
	for (let i = from; i < from + calls; i++) inlineInk.moveStrokes(N, ids, dxOf(i), dyOf(i));
}

/** The handed versions of `id`, oldest save first. */
const handedOf = (r: ReturnType<typeof rig>, id: string): InkStroke[] => handedBefore(r.rec()).filter(([k]) => k === id).map(([, v]) => v);

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});

afterEach(() => {
	inlineInk.handleDelete(N);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("repeated moves of the same strokes leave one entry in the move log", () => {
	it.each([2, 20])("%i strokes moved by 200 calls with no save between: at most 2 entries, and each version is the stroke before the first call", async (n) => {
		const r = rig(strokes(n));
		await inlineInk.ensureLoaded(N);
		const ids = inlineInk.strokes(N).map((s) => s.id);
		const was = r.stood(ids);
		drag(ids, 200);
		let sx = 0, sy = 0;
		for (let i = 0; i < 200; i++) {
			sx += dxOf(i);
			sy += dyOf(i);
		}
		expect(Math.abs(r.live(ids[0]!).points[0]!.x - (was[0]!.points[0]!.x + sx)), "precondition: the live stroke moved by every call").toBeLessThanOrEqual(NEAR);
		expect(Math.abs(r.live(ids[0]!).points[0]!.y - (was[0]!.points[0]!.y + sy)), "precondition: the live stroke moved by every call").toBeLessThanOrEqual(NEAR);
		const entries = keptShifts(r.rec());
		let worst = 0;
		ids.forEach((id, i) => (worst = Math.max(worst, expectStood(unsavedChanges(r.rec())?.get(id), was[i]!, `the unsaved version of ${id}`))));
		console.log(`[move-log] ${n} strokes, 200 calls, no save: entries ${entries}, farthest point ${worst}`);
		expect(entries, "entries the log holds after 200 calls over the same strokes (one per call is the per-sample growth)").toBeLessThanOrEqual(2);
	});

	it("200 calls in four runs of 50, a save handed after each of the first three: each save's version is the stroke before its run, the unsaved one the stroke before the last run, at most 2 entries a run", async () => {
		const r = rig(strokes(20));
		await inlineInk.ensureLoaded(N);
		const ids = inlineInk.strokes(N).map((s) => s.id);
		const before: InkStroke[][] = [];
		for (let run = 0; run < 4; run++) {
			before.push(r.stood(ids));
			drag(ids, 50, run * 50);
			if (run < 3) inlineInk.save(N);
		}
		expect(r.handed.length, "precondition: three saves handed, none landed").toBe(3);
		const entries = keptShifts(r.rec());
		let worst = 0;
		ids.forEach((id, i) => {
			const handed = handedOf(r, id);
			expect(handed.length, `precondition: ${id} has a version in each handed save`).toBe(3);
			handed.forEach((v, run) => (worst = Math.max(worst, expectStood(v, before[run]![i]!, `${id}'s version in save ${run + 1}`))));
			worst = Math.max(worst, expectStood(unsavedChanges(r.rec())?.get(id), before[3]![i]!, `${id}'s unsaved version`));
		});
		console.log(`[move-log] 20 strokes, four runs of 50 calls, three saves: entries ${entries}, farthest point ${worst}`);
		expect(entries, "entries after four runs, each begun by a call that kept new versions").toBeLessThanOrEqual(8);
	});

	it("runs of 50 calls over A and B, then C and D, then A and B, then all four, no save: each version is the stroke before its first move", async () => {
		const r = rig(strokes(4));
		await inlineInk.ensureLoaded(N);
		const [a, b, c, d] = inlineInk.strokes(N).map((s) => s.id) as [string, string, string, string];
		const was = r.stood([a, b, c, d]);
		const runs = [[a, b], [c, d], [a, b], [a, b, c, d]];
		runs.forEach((ids, run) => drag(ids, 50, run * 50));
		const entries = keptShifts(r.rec());
		let worst = 0;
		[a, b, c, d].forEach((id, i) => (worst = Math.max(worst, expectStood(unsavedChanges(r.rec())?.get(id), was[i]!, `the unsaved version of ${id}`))));
		console.log(`[move-log] four runs over other strokes, no save: entries ${entries}, farthest point ${worst}`);
		expect(entries, "entries after four runs over three sets of strokes").toBeLessThanOrEqual(8);
	});

	it("50 calls, a save, a cut of the stroke and its undo, 50 calls: the handed version is the stroke before the first call, the cut's version the stroke before the cut", async () => {
		const r = rig(strokes(1));
		await inlineInk.ensureLoaded(N);
		const [id] = inlineInk.strokes(N).map((s) => s.id) as [string];
		const [p0] = r.stood([id]);
		drag([id], 50);
		inlineInk.save(N);
		const [p1] = r.stood([id]);
		const s = r.live(id);
		const [taken] = inlineInk.takeLive(N, [id]);
		expect(taken?.stroke, "precondition: the cut took the live stroke").toBe(s);
		inlineInk.applyAddLive(N, [s], [taken!.index]);
		expect(r.live(id), "precondition: the undo put back the same stroke").toBe(s);
		drag([id], 50, 50);
		const entries = keptShifts(r.rec());
		const handed = handedOf(r, id);
		expect(handed.length, "precondition: one handed version").toBe(1);
		const worst = Math.max(expectStood(handed[0], p0!, "the handed version"), expectStood(unsavedChanges(r.rec())?.get(id), p1!, "the cut's version"));
		console.log(`[move-log] 100 calls around a save and a cut's undo: entries ${entries}, farthest point ${worst}`);
		expect(entries, "entries: the cut kept its version as a copy, so the moves after it go on in the same entry").toBeLessThanOrEqual(2);
	});
});
