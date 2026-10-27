/**
 * A FLUSH WAKES A PARKED SAVE.
 *
 * A timer's save (writePending with yieldToPen) parks while a pen is down, in
 * the middle of its serialization or at the pen gate right before its tmp
 * write, and goes on after the last lift or at its MAX_DIRTY_MS ceiling.
 * flush, flushPage and keepAsideUnder wait on the page's write chain, which
 * holds that parked save, so they must end the park: a page switch, a view
 * close or an unload with the pen on the glass otherwise waits up to 5 s for
 * the page to be written, and on unload the write lands after teardown began.
 * Waking alone is not enough, since the park loop parks again while the pen
 * stays down, so a save of a page being flushed goes on with the pen down.
 * A save of another page still parks while the flushed page's own parked
 * save is written, and once the flush ends the page's next save parks again.
 *
 * Each case enters the park by calling writePending with the pen already
 * down, which stands for a pen that comes down during the save's awaits; the
 * park itself is the production path SaveStallPenDown drives.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { MAX_DIRTY_MS, PageStore } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";

const g = globalThis as { window?: unknown };
g.window ??= globalThis;

/** The store's own fields and steps this cell drives. */
type Inner = {
	pending: Map<string, PageData>;
	pendingWriter: Map<string, unknown>;
	pensDown: Set<number>;
	parked: Set<() => void> | undefined;
	writePending(pageId: string, yieldToPen?: boolean): Promise<void>;
	releaseHeld(): void;
};

function pageOf(id: string, ...strokeIds: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = strokeIds.map((sid) => ({
		id: sid,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	})) as PageData["strokes"];
	return p;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits, a few ms at a time, up to `ms` for `cond`; answers whether it held. */
async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
	const end = Date.now() + ms;
	while (!cond() && Date.now() < end) await sleep(5);
	return cond();
}

/** "done" when `p` settles first, "ceiling" when half of MAX_DIRTY_MS passes first (the ceiling is what woke it). */
async function beforeCeiling(p: Promise<unknown>): Promise<"done" | "ceiling"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const ceiling = new Promise<"ceiling">((resolve) => {
		timer = setTimeout(() => resolve("ceiling"), MAX_DIRTY_MS / 2);
	});
	try {
		return await Promise.race([p.then(() => "done" as const), ceiling]);
	} finally {
		clearTimeout(timer);
	}
}

/** Page X on disk with one stroke; a timer's save of X with a second stroke, parked with pen 7 down. */
async function parkedSave(): Promise<{ store: PageStore; inner: Inner; fake: FakeAdapter; save: Promise<void> }> {
	const fake = new FakeAdapter();
	fake.dirs.add(".handwriting");
	fake.externalWrite(".handwriting/X.json", serializePage(pageOf("X", "base")));
	const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5000);
	await store.load("X");
	const inner = store as unknown as Inner;
	inner.pending.set("X", pageOf("X", "base", "mine"));
	inner.pendingWriter.set("X", undefined);
	inner.pensDown.add(7);
	const save = inner.writePending("X", true);
	expect(await waitFor(() => (inner.parked?.size ?? 0) === 1), "premise: the timer's save parked for the pen").toBe(true);
	return { store, inner, fake, save };
}

function strokeIds(fake: FakeAdapter, path: string, id: string): string[] {
	const text = fake.files.get(path);
	if (text === undefined) return [];
	return parsePage(text, id).data.strokes.map((s) => s.id);
}

describe("a flush ends a timer's save parked for a pen, with the pen still down", () => {
	it("flush wakes it at once, and the page is written before the pen lifts", async () => {
		const { store, inner, fake, save } = await parkedSave();
		const flushed = store.flush();
		const parkedAfterCall = inner.parked?.size ?? 0;
		const first = await beforeCeiling(flushed);
		await flushed;
		await save;
		expect(parkedAfterCall, "the flush left the save parked").toBe(0);
		expect(first, "the flush waited for the pen or the ceiling").toBe("done");
		expect(strokeIds(fake, ".handwriting/X.json", "X")).toEqual(["base", "mine"]);
	}, 15000);

	it("flushPage of that page wakes it at once and answers that nothing is left queued", async () => {
		const { store, inner, fake, save } = await parkedSave();
		const flushed = store.flushPage("X");
		const parkedAfterCall = inner.parked?.size ?? 0;
		const first = await beforeCeiling(flushed);
		const answer = await flushed;
		await save;
		expect(parkedAfterCall, "flushPage left the save parked").toBe(0);
		expect(first, "flushPage waited for the pen or the ceiling").toBe("done");
		expect(answer).toBe(true);
		expect(strokeIds(fake, ".handwriting/X.json", "X")).toEqual(["base", "mine"]);
	}, 15000);

	it("keepAsideUnder of that page wakes it at once and moves the newest bytes", async () => {
		const { store, inner, fake, save } = await parkedSave();
		const moved = store.keepAsideUnder("X", "Y");
		const parkedAfterCall = inner.parked?.size ?? 0;
		const first = await beforeCeiling(moved);
		const result = await moved;
		await save;
		expect(parkedAfterCall, "keepAsideUnder left the save parked").toBe(0);
		expect(first, "keepAsideUnder waited for the pen or the ceiling").toBe("done");
		expect(result.kind).toBe("moved");
		const to = result.kind === "moved" ? result.to : "";
		expect(strokeIds(fake, to, "Y")).toEqual(["base", "mine"]);
	}, 15000);

	it("a flushPage of another page with its own parked save writes that page and leaves this one parked while the pen is down; the lift still writes it", async () => {
		const { store, inner, fake, save } = await parkedSave();
		fake.externalWrite(".handwriting/Z.json", serializePage(pageOf("Z", "zbase")));
		await store.load("Z");
		inner.pending.set("Z", pageOf("Z", "zbase", "zmine"));
		inner.pendingWriter.set("Z", undefined);
		const saveZ = inner.writePending("Z", true);
		expect(await waitFor(() => (inner.parked?.size ?? 0) === 2), "premise: both saves parked for the pen").toBe(true);
		expect(await store.flushPage("Z")).toBe(true);
		await saveZ;
		expect(strokeIds(fake, ".handwriting/Z.json", "Z")).toEqual(["zbase", "zmine"]);
		expect(strokeIds(fake, ".handwriting/X.json", "X"), "X was written with the pen down during Z's flush").toEqual(["base"]);
		expect(await waitFor(() => (inner.parked?.size ?? 0) === 1), "the save of X did not park again").toBe(true);
		inner.pensDown.delete(7);
		inner.releaseHeld();
		expect(await beforeCeiling(save), "the lift did not wake the save").toBe("done");
		expect(strokeIds(fake, ".handwriting/X.json", "X")).toEqual(["base", "mine"]);
	}, 15000);

	it("once a flushPage ends, the page's next timer save parks for the pen again", async () => {
		const { store, inner, fake, save } = await parkedSave();
		expect(await store.flushPage("X")).toBe(true);
		await save;
		inner.pending.set("X", pageOf("X", "base", "mine", "later"));
		inner.pendingWriter.set("X", undefined);
		const next = inner.writePending("X", true);
		expect(await waitFor(() => (inner.parked?.size ?? 0) === 1), "the next save did not park after the flush ended").toBe(true);
		expect(strokeIds(fake, ".handwriting/X.json", "X"), "the next save wrote with the pen down").toEqual(["base", "mine"]);
		inner.pensDown.delete(7);
		inner.releaseHeld();
		expect(await beforeCeiling(next), "the lift did not wake the next save").toBe("done");
		expect(strokeIds(fake, ".handwriting/X.json", "X")).toEqual(["base", "mine", "later"]);
	}, 15000);
});
