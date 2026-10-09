/**
 * A save writes `<id>.json.tmp` and then replaces `<id>.json`. If replacing
 * the live file fails (a sync client or antivirus holding it, or the app is
 * killed in between), the newest ink exists only in the .tmp. The next
 * session reads the older live file, ignores the .tmp, and its first save
 * writes the same .tmp name - the stranded ink is gone from disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { emptyPage } from "../model/PageData";

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("window", globalThis);
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function page(id: string, ...labels: string[]) {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = labels.map((label) => ({
		id: label,
		tool: "pen" as const,
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	}));
	return p;
}

const holdsStroke = (a: FakeAdapter, id: string) =>
	[...a.files.values()].some((text) => text.includes(`"id":"${id}"`));

describe("an interrupted save beside a readable live file", () => {
	it("is not overwritten by the next session's first save", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const a = new FakeAdapter();
		const first = new PageStore({ vault: { adapter: a } }, ".handwriting");
		await first.saveNow("p", page("p", "A"));

		// Session 1: stroke B is saved, but the live file cannot be replaced.
		// The lock blocks moving the live file as well as deleting it, as a sync
		// client's or antivirus lock does (re-staged for L1, ORDER-L1.md: the
		// save now moves the live file aside before it judges it, R5).
		const realRemove = a.remove.bind(a);
		const realRename = a.rename.bind(a);
		a.remove = async (path: string) => {
			if (path === ".handwriting/p.json") throw new Error("EBUSY: file is locked");
			return realRemove(path);
		};
		a.rename = async (from: string, to: string) => {
			if (from === ".handwriting/p.json") throw new Error("EBUSY: file is locked");
			return realRename(from, to);
		};
		first.schedule("p", page("p", "A", "B"));
		await vi.runAllTimersAsync();
		expect(a.files.has(".handwriting/p.json.tmp")).toBe(true);
		expect(holdsStroke(a, "B")).toBe(true); // B is on disk, only in the .tmp
		a.remove = realRemove;
		a.rename = realRename;

		// Session 2 (app restarted): open the note, draw C.
		const second = new PageStore({ vault: { adapter: a } }, ".handwriting");
		await second.load("p");
		await second.saveNow("p", page("p", "A", "C"));

		// B must still exist somewhere on disk (live file or a recovery copy).
		expect(holdsStroke(a, "B")).toBe(true);
	});
});
