/**
 * A move of the same strokes as the last entry of the note's move log, with no version kept in it, goes into that entry
 * (MoveLogJoinsRepeatedMoves.test.ts). "The same strokes" must mean every one of them: a drag over A and C after a drag
 * over A and B has as many strokes and the same first one. A drag over A and B joined into the A and C entry would leave
 * B's version short of that drag's move and give C's version a move it never had. So: drags over A and B, then A and C,
 * then A and B again, and each version read back must be its stroke before its first move.
 *
 * Real InlineInkStore (the plugin's), the host and the file as in MoveLogJoinsRepeatedMoves.test.ts: saves are handed to
 * a list and none lands; here no save is made. Each version is read once, after the last call. Its x and y are compared
 * within 1e-6; its id, createdAt, tool, colour, width and each point's pressure and time exactly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { keptShifts, unsavedChanges } from "./InlineInkStoreCommit";
import { emptyPage, serializePage } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkPoint, InkStroke } from "../ink/Stroke";

const N = "MoveLogJoin.md";
const PID = "move-log-join-page";
const FILE = `.handwriting/${PID}.json`;
/** Within this a rebuilt x or y after many moves is the number it stood at. */
const NEAR = 1e-6;

/** A stroke of 101 samples at uneven, non-integer places. */
function stroke(id: string, createdAt: number, x0: number, y0: number): InkStroke {
	const points: InkPoint[] = [];
	for (let i = 0; i <= 100; i++) points.push({ x: x0 + i * 2.07, y: y0 + (i % 5) * 0.13, pressure: 0.25 + (i % 3) * 0.25, t: i * 4 });
	const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
	const bbox = { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1, width: Math.max(...xs) - Math.min(...xs) + 2, height: Math.max(...ys) - Math.min(...ys) + 2 };
	return { id, tool: "pen", color: "#1f2a44", width: 2, points, bbox, createdAt };
}

function copyOf(s: InkStroke): InkStroke {
	return { ...s, points: s.points.map((p) => ({ ...p })), bbox: { ...s.bbox } };
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

beforeEach(() => {
	vi.stubGlobal("window", globalThis);
});

afterEach(() => {
	inlineInk.handleDelete(N);
	(inlineInk as unknown as { host: InlineInkHost | null }).host = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("the move log joins a move only into an entry of every one of the same strokes", () => {
	it.each([1, 50])("drags of %i calls over A and B, then A and C, then A and B, no save: each version is the stroke before its first move", async (calls) => {
		const fake = new FakeAdapter();
		const store = new PageStore({ vault: { adapter: fake } } as never);
		const page = emptyPage(PID);
		page.surface = "inline";
		page.strokes = [0, 1, 2].map((i) => stroke(`m${i}`, 10 + i, 5.3, 100.37 + i * 9));
		fake.files.set(FILE, serializePage(page));
		const host: InlineInkHost = {
			readPageId: () => PID,
			claimId: async () => ({ pageId: PID }) as never,
			loadSidecar: (id) => store.load(id),
			scheduleSidecar: () => undefined,
			sidecarLanded: () => false,
			notify: () => undefined,
		};
		inlineInk.attachHost(host);
		await inlineInk.ensureLoaded(N);
		const rec = (): never => (inlineInk as unknown as { record(path: string): never }).record(N);
		const live = (id: string): InkStroke => inlineInk.strokes(N).find((s) => s.id === id)!;
		const [a, b, c] = inlineInk.strokes(N).map((s) => s.id) as [string, string, string];
		expect([a, b, c], "precondition: three strokes loaded in file order").toEqual(["m0", "m1", "m2"]);
		const was = [a, b, c].map((id) => copyOf(live(id)));

		// Each drag's own sum of steps, so the live strokes can be checked against the moves they took part in.
		const runs = [[a, b], [a, c], [a, b]];
		const sums = runs.map(() => ({ x: 0, y: 0 }));
		runs.forEach((ids, run) => {
			for (let i = run * calls; i < (run + 1) * calls; i++) {
				inlineInk.moveStrokes(N, ids, dxOf(i), dyOf(i));
				sums[run]!.x += dxOf(i);
				sums[run]!.y += dyOf(i);
			}
		});
		expect(Math.hypot(sums[2]!.x, sums[2]!.y), "precondition: the last drag moves its strokes far past NEAR").toBeGreaterThan(0.1);
		const took: Record<string, number[]> = { [a]: [0, 1, 2], [b]: [0, 2], [c]: [1] };
		[a, b, c].forEach((id, k) => {
			const dx = took[id]!.reduce((s, r) => s + sums[r]!.x, 0);
			const dy = took[id]!.reduce((s, r) => s + sums[r]!.y, 0);
			const p = live(id).points[0]!, q = was[k]!.points[0]!;
			expect(Math.max(Math.abs(p.x - (q.x + dx)), Math.abs(p.y - (q.y + dy))), `precondition: the live ${id} moved by the drags it took part in`).toBeLessThanOrEqual(NEAR);
		});

		const entries = keptShifts(rec());
		let worst = 0;
		[b, c, a].forEach((id) => (worst = Math.max(worst, expectStood(unsavedChanges(rec())?.get(id), was[[a, b, c].indexOf(id)]!, `the unsaved version of ${id}`))));
		console.log(`[move-log-join] drags of ${calls} calls over A+B, A+C, A+B, no save: entries ${entries}, farthest point ${worst}`);
	});
});
