/**
 * A large move must keep the strokes as they stood without a copy of the points it moves, wherever such a copy would be
 * held: in a version's own fields, in a private field, in a list beside it. So this cell does not look at what a version
 * holds. It wraps every live point of the note and notes each point read past its x and y while the moves and the saves
 * run. A copy of a point reads its other fields (a spread reads its keys, a field copy its pressure and time, a structured
 * clone cannot take the wrapper at all), and a move only reads and writes x and y. A version may build its points on its
 * first read; the versions are read after the noting stops.
 *
 * Real InlineInkStore (the plugin's). The host hands every save to a list, lands one only when the cell says so, and
 * writes nothing; the file is read through PageStore over FakeAdapter, as in MoveKeepsVersionsAsStood.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inlineInk } from "./InkOverlay";
import type { InlineInkHost } from "./InlineInkStore";
import { landedVersions } from "./InlineInkStoreCommit";
import { emptyPage, serializePage, type PageData } from "../model/PageData";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PageStore } from "../persistence/PageStore";
import type { InkPoint, InkStroke } from "../ink/Stroke";

const N = "NoPointCopy.md";
const PID = "no-point-copy-page";
const FILE = `.handwriting/${PID}.json`;
/** Within this a rebuilt x or y after one move is the number it stood at. */
const EXACT = 1e-9;
const STROKES = 200;
const SAMPLES = 101;

/** A stroke of 101 samples at uneven, non-integer places. */
function stroke(id: string, createdAt: number, x0: number, y0: number): InkStroke {
	const points: InkPoint[] = [];
	for (let i = 0; i < SAMPLES; i++) points.push({ x: x0 + i * 2.07, y: y0 + (i % 5) * 0.13, pressure: 0.25 + (i % 3) * 0.25, t: i * 4 });
	const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
	const bbox = { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1, width: Math.max(...xs) - Math.min(...xs) + 2, height: Math.max(...ys) - Math.min(...ys) + 2 };
	return { id, tool: "pen", color: "#1f2a44", width: 2, points, bbox, createdAt };
}

/** What the stroke is now, as plain data, read field by field (so it is taken only while nothing is noted). */
function copyOf(s: InkStroke): InkStroke {
	return { ...s, points: s.points.map((p) => ({ x: p.x, y: p.y, pressure: p.pressure, t: p.t })), bbox: { ...s.bbox } };
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

describe("a large move keeps no copy of the points it moves", () => {
	it("200 strokes of 101 points moved three times, a save landed and another handed after each: no live point is read past x and y while the moves and saves run, and each landed version reads as it stood", async () => {
		const fake = new FakeAdapter();
		const store = new PageStore({ vault: { adapter: fake } } as never);
		const page = emptyPage(PID);
		page.surface = "inline";
		page.strokes = Array.from({ length: STROKES }, (_, i) => stroke(`m${i}`, 10 + i, 5.3, 100.37 + i * 9));
		fake.files.set(FILE, serializePage(page));
		const handed: PageData[] = [];
		const landed = new Set<PageData>();
		const host: InlineInkHost = {
			readPageId: () => PID,
			claimId: async () => ({ pageId: PID }) as never,
			loadSidecar: (id) => store.load(id),
			scheduleSidecar: (_id, p) => {
				handed.push(p);
			},
			sidecarLanded: (p) => landed.has(p),
			notify: () => undefined,
		};
		inlineInk.attachHost(host);
		await inlineInk.ensureLoaded(N);
		const live = inlineInk.strokes(N);
		expect(live.length, "precondition: 200 strokes loaded").toBe(STROKES);
		const ids = live.map((s) => s.id);
		const rec = (): never => (inlineInk as unknown as { record(path: string): never }).record(N);

		// Every live point behind a wrapper that notes a read of anything but x and y while `noting` is on. Writes go
		// straight to the point, so a move's `p.x += dx` reads x, writes x, and is never noted.
		let noting = false;
		const read = new Set<object>();
		const wrapped = new WeakSet<object>();
		const xy = (k: string | symbol): boolean => k === "x" || k === "y";
		const handler: ProxyHandler<InkPoint> = {
			get(t, k) {
				if (noting && !xy(k)) read.add(t);
				return Reflect.get(t, k);
			},
			set(t, k, v) {
				return Reflect.set(t, k, v);
			},
			has(t, k) {
				if (noting && !xy(k)) read.add(t);
				return Reflect.has(t, k);
			},
			ownKeys(t) {
				if (noting) read.add(t);
				return Reflect.ownKeys(t);
			},
			getOwnPropertyDescriptor(t, k) {
				if (noting) read.add(t);
				return Reflect.getOwnPropertyDescriptor(t, k);
			},
		};
		for (const s of live) {
			for (let i = 0; i < s.points.length; i++) {
				const w = new Proxy(s.points[i]!, handler);
				wrapped.add(w);
				s.points[i] = w;
			}
		}

		const stood: InkStroke[][] = [];
		const counts: number[] = [];
		for (let move = 0; move < 3; move++) {
			const now = inlineInk.strokes(N);
			expect(now.every((s) => s.points.every((p) => wrapped.has(p))), `precondition, move ${move + 1}: every live point is wrapped`).toBe(true);
			stood.push(ids.map((id) => copyOf(now.find((s) => s.id === id)!)));
			read.clear();
			noting = true;
			inlineInk.moveStrokes(N, ids, 3.3 - move, 7.7 + move);
			inlineInk.save(N);
			landed.add(handed[handed.length - 1]!);
			inlineInk.save(N);
			noting = false;
			counts.push(read.size);
		}
		expect(handed.length, "precondition: two saves handed per move").toBe(6);
		const first = inlineInk.strokes(N).find((s) => s.id === ids[0])!.points[0]!;
		expect(Math.abs(first.x - (stood[0]![0]!.points[0]!.x + 3.3 + 2.3 + 1.3)), "precondition: the live stroke moved by all three moves").toBeLessThanOrEqual(EXACT);
		console.log(`[no-point-copy] points read past x and y per move and its saves: ${counts.join(", ")} (of ${STROKES * SAMPLES})`);
		expect(counts, "points read past x and y during each move and its saves (one per point moved is a copy kept)").toEqual([0, 0, 0]);

		for (let move = 0; move < 3; move++) {
			for (let i = 0; i < ids.length; i += 37) {
				const v = landedVersions(rec(), ids[i]!)[move];
				const was = stood[move]![i]!;
				const label = `landed version ${move + 1} of ${ids[i]}`;
				expect(v, `${label}: kept`).toBeTruthy();
				expect([v!.id, v!.createdAt, v!.tool, v!.color, v!.width], `${label}: id, createdAt, tool, colour and width as they stood`).toEqual([was.id, was.createdAt, was.tool, was.color, was.width]);
				expect(v!.points.length, `${label}: as many points as it stood with`).toBe(was.points.length);
				let worst = 0;
				v!.points.forEach((p, j) => {
					const b = was.points[j]!;
					worst = Math.max(worst, Math.abs(p.x - b.x), Math.abs(p.y - b.y));
					if (p.pressure !== b.pressure || p.t !== b.t) expect([j, p.pressure, p.t], `${label}: point ${j}'s pressure and time as they stood`).toEqual([j, b.pressure, b.t]);
				});
				expect(worst, `${label}: the farthest point from where it stood`).toBeLessThanOrEqual(EXACT);
			}
		}
	});
});
