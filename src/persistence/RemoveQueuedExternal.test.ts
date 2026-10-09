import { afterEach, describe, expect, it, vi } from "vitest";
import { PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";

(globalThis as { window?: unknown }).window = globalThis;
afterEach(() => vi.useRealTimers());

function pageOf(id: string, ...labels: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = labels.map((l) => ({
		id: l,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
	})) as PageData["strokes"];
	return p;
}

class ListingAdapter extends FakeAdapter {
	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = `${path}/`;
		const files = [...this.files.keys()].filter(
			(p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/")
		);
		if (files.length === 0 && !this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
		return { files, folders: [] };
	}
}

describe("recycling a page while a save is still queued", () => {
	it("keeps another device's revision the queued save never saw", async () => {
		vi.useFakeTimers();
		const fake = new ListingAdapter();
		fake.dirs.add(".handwriting");
		fake.externalWrite(".handwriting/X.json", serializePage(pageOf("X", "base")));
		const store = new PageStore({ vault: { adapter: fake } }, ".handwriting", () => 5000);
		await store.load("X");

		// This device's newest stroke has not landed (the write failed and is queued for retry).
		fake.failWriteTimes = 1;
		await store.saveNow("X", pageOf("X", "base", "mine"));
		expect(store.hasQueuedWrite("X")).toBe(true);
		// Sync delivers the other device's revision; the poll will not adopt it while a save is queued.
		fake.externalWrite(".handwriting/X.json", serializePage(pageOf("X", "base", "other-device")));
		expect(await store.externallyChanged("X")).toBe(false);

		// The note is deleted (main.ts recycleIfStillGone -> store.remove).
		await store.remove("X");

		const files = [...fake.files.entries()].map(([path, text]) => ({
			path,
			ids: parsePage(text, "X").data.strokes.map((s) => s.id),
		}));
		expect(files.some((f) => f.ids.includes("mine")), JSON.stringify(files)).toBe(true);
		expect(files.some((f) => f.ids.includes("other-device")), JSON.stringify(files)).toBe(true);
	});
});
