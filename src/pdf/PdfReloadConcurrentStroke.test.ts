import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PageData, ParseResult, emptyPage } from "../model/PageData";
import { PdfInkHost, PdfInkStore } from "./PdfInkStore";

function stroke(id: string, x: number): InkStroke {
	const points = [
		{ x, y: 10, pressure: 0.5, t: 0 },
		{ x: x + 10, y: 20, pressure: 0.5, t: 8 },
	];
	return {
		id, tool: "pen", color: "#4b7bec", width: 2, points,
		bbox: computeBBox(points, 4), createdAt: 0, page: 1,
	};
}

function copy<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

describe("PDF reload preserves strokes committed during an unsuccessful read", () => {
	for (const failure of ["missing", "throws"] as const) {
		it(`${failure}: keeps the concurrent stroke on screen and in the next actual save`, async () => {
			const id = "pdf-reload-concurrent";
			const a = stroke("before-read", 10);
			const b = stroke("during-read", 40);
			const c = stroke("after-read", 70);
			let disk: PageData = { ...emptyPage(id), surface: "pdf", strokes: [a] };
			const saved: PageData[] = [];
			const loads: string[] = [];
			let release!: (result: ParseResult | null) => void;
			let reject!: (error: Error) => void;
			const pending = new Promise<ParseResult | null>((resolve, fail) => {
				release = resolve;
				reject = fail;
			});
			const host: PdfInkHost = {
				load: (loadedId) => {
					loads.push(loadedId);
					return loads.length === 1
						? Promise.resolve({ data: copy(disk), recovered: false })
						: pending;
				},
				schedule: (savedId, page) => {
					expect(savedId).toBe(id);
					const snapshot = copy(page);
					saved.push(snapshot);
					disk = copy(snapshot);
				},
				notice: () => {},
			};
			const store = new PdfInkStore();
			store.attachHost(host);
			await store.ensureLoaded(id);
			expect(store.strokes(id)).toEqual([a]);
			const outcome = store.reloadExternal(id).then(
				() => null,
				(error: unknown) => error,
			);
			try {
				expect(loads).toEqual([id, id]);
				store.commit(id, b);
				const visibleDuringRead = copy(store.strokes(id));
				const savesDuringRead = saved.length;
				const diskDuringRead = copy(disk);
				const readError = new Error("sidecar read rejected");
				if (failure === "throws") reject(readError);
				else release(null);
				const error = await outcome;
				const visibleAfterRead = copy(store.strokes(id));
				const savesAfterRead = copy(saved);
				store.commit(id, c);
				const visibleAfterCommit = copy(store.strokes(id));
				const nextSave = saved.length > 0 ? copy(saved[saved.length - 1]) : null;
				const finalDisk = copy(disk);
				const allSaves = copy(saved);

				// Observe every real host save before any defect assertion can stop the cell.
				expect(visibleDuringRead).toContainEqual(b);
				expect(savesDuringRead).toBe(0);
				expect(diskDuringRead.strokes).toEqual([a]);
				if (failure === "throws") expect(error).toBe(readError);
				else expect(error).toBeNull();
				expect({
					visibleAfterRead, savesAfterRead, visibleAfterCommit, nextSave, finalDisk, allSaves,
				}, "unsuccessful reload must not lose or overwrite session ink").toMatchObject({
					visibleAfterRead: [a, b],
					savesAfterRead: [{ strokes: [a, b] }],
					visibleAfterCommit: [a, b, c],
					nextSave: { strokes: [a, b, c] },
					finalDisk: { strokes: [a, b, c] },
				});
				expect(allSaves.length).toBeGreaterThan(0);
				for (const page of allSaves) {
					expect(page.strokes).toEqual(expect.arrayContaining([a, b]));
				}
			} finally {
				release(null);
				await outcome;
			}
		});
	}
});
