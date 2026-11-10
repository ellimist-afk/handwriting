/**
 * THE UNLOAD FLUSH STARTS EVERY PAGE'S SAVE AT ONCE.
 *
 * flush writes everything queued on a page switch, a view close and the plugin's unload, and the unload does not wait
 * for it. It used to write the queued pages one after another, each save awaited before the next one started, so a
 * process that ended partway kept the first pages and lost the rest. Every page's save now starts at once and they
 * are awaited together. Each page keeps its own order: its saves still run one after another on its own chain.
 *
 * The adapter here takes 50 ms for every write, on the fake clock, so the cells read time without depending on how
 * busy the machine is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { MAX_DIRTY_MS, PageStore, type PageWriter } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { PageData, emptyPage, parsePage, serializePage } from "../model/PageData";

const WRITE_MS = 50;
const PAGES = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"];

/** Every write takes WRITE_MS. Records when each write starts and each read, in order, with the stroke ids written. */
class SlowAdapter extends FakeAdapter {
	ops: string[] = [];
	started: string[] = [];

	override async read(path: string): Promise<string> {
		this.ops.push(`read ${path}`);
		return super.read(path);
	}

	override async write(path: string, data: string): Promise<void> {
		this.started.push(path);
		this.ops.push(`write ${path} ${strokesIn(data).join(",")}`);
		await new Promise<void>((resolve) => setTimeout(resolve, WRITE_MS));
		return super.write(path, data);
	}
}

/** The stroke ids in a page's text, or none when it is not a page. */
function strokesIn(text: string): string[] {
	try {
		return parsePage(text, "any").data.strokes.map((s) => s.id);
	} catch {
		return [];
	}
}

function pageOf(id: string, ...strokeIds: string[]): PageData {
	const p = emptyPage(id);
	p.surface = "inline";
	p.strokes = strokeIds.map((sid) => ({
		id: sid,
		tool: "pen",
		color: "#4b7bec",
		width: 2,
		points: [
			{ x: 0, y: 0, pressure: 0.5, t: 0 },
			{ x: 10, y: 0, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 10, height: 0 },
		createdAt: 0,
	})) as PageData["strokes"];
	return p;
}

/** The store's own fields and steps this cell drives. */
type Inner = {
	pending: Map<string, PageData>;
	pendingWriter: Map<string, PageWriter | undefined>;
	pensDown: Set<number>;
	parked: Set<() => void> | undefined;
	writePending(pageId: string, yieldToPen?: boolean): Promise<void>;
};

let fake: SlowAdapter;
let store: PageStore;

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as { window?: unknown }).window = globalThis;
	fake = new SlowAdapter();
	fake.dirs.add(".handwriting");
	store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5000);
});

afterEach(() => {
	vi.useRealTimers();
});

/** Eight dirty pages, each with one stroke, waiting on their quiet timers. */
function eightDirty(): void {
	for (const id of PAGES) store.schedule(id, pageOf(id, `${id}-s`));
}

/** Settles to true when `p` settles; read it after advancing the fake clock. */
function settled(p: Promise<unknown>): { done: boolean } {
	const state = { done: false };
	void p.then(
		() => (state.done = true),
		() => (state.done = true)
	);
	return state;
}

describe("the flush starts every page's save at once", () => {
	it("eight dirty pages with 50 ms writes: the flush is done within two writes' time", async () => {
		eightDirty();
		const flushed = store.flush();
		const state = settled(flushed);
		await vi.advanceTimersByTimeAsync(WRITE_MS - 1);
		expect(state.done, "premise: the flush cannot be done before the first write lands").toBe(false);
		await vi.advanceTimersByTimeAsync(WRITE_MS + 1);
		expect(state.done, "the flush took longer than two writes: the pages were written one after another").toBe(true);
		await flushed;
		for (const id of PAGES) {
			expect(strokesIn(fake.files.get(`.handwriting/${id}.json`) ?? ""), `page ${id} on disk`).toEqual([`${id}-s`]);
		}
	});

	it("the process ends before the first write lands: every page's write has started", async () => {
		eightDirty();
		const flushed = store.flush();
		await vi.advanceTimersByTimeAsync(WRITE_MS - 1);
		// Nothing after this point would run in a process that ended here.
		const startedTmp = PAGES.filter((id) => fake.started.includes(`.handwriting/${id}.json.tmp`));
		expect(startedTmp, "pages whose write had started when the process ended").toEqual(PAGES);
		await vi.advanceTimersByTimeAsync(20 * WRITE_MS);
		await flushed;
	});
});

describe("within one page, the order is unchanged", () => {
	it("a save parked for a pen writes first; a second writer's batch reconciles after it, then writes", async () => {
		const A: PageWriter = "writer-A";
		const B: PageWriter = "writer-B";
		fake.externalWrite(".handwriting/X.json", serializePage(pageOf("X", "base")));
		await store.load("X");
		// Writer A's first save lands, so the live file is A's and B's batch has to reconcile with it.
		const first = store.saveNow("X", pageOf("X", "base", "a1"), A);
		await vi.advanceTimersByTimeAsync(4 * WRITE_MS);
		await first;
		// A timer's save from A, parked with pen 7 down.
		const inner = store as unknown as Inner;
		inner.pensDown.add(7);
		inner.pending.set("X", pageOf("X", "base", "a1", "a2"));
		inner.pendingWriter.set("X", A);
		const parkedSave = inner.writePending("X", true);
		await vi.advanceTimersByTimeAsync(10);
		expect(inner.parked?.size ?? 0, "premise: the timer's save parked for the pen").toBe(1);
		// Writer B's batch for the same page, and seven other dirty pages.
		inner.pending.set("X", pageOf("X", "base", "a1", "b1"));
		inner.pendingWriter.set("X", B);
		for (const id of PAGES.slice(0, 7)) store.schedule(id, pageOf(id, `${id}-s`));
		const from = fake.ops.length;
		const flushed = store.flush();
		await vi.advanceTimersByTimeAsync(20 * WRITE_MS);
		await flushed;
		await parkedSave;
		expect(MAX_DIRTY_MS, "premise: the pen's ceiling was not reached").toBeGreaterThan(20 * WRITE_MS + 10);
		const ofX = fake.ops.slice(from).filter((op) => / \.handwriting\/X\.json(\.tmp)? ?/.test(`${op} `));
		const aWrite = ofX.indexOf("write .handwriting/X.json.tmp base,a1,a2");
		const bRead = ofX.indexOf("read .handwriting/X.json");
		const bWrite = ofX.findIndex((op) => op.startsWith("write .handwriting/X.json.tmp ") && op.includes("b1"));
		expect(aWrite, `the parked save's write (X's steps: ${ofX.join(" | ")})`).toBeGreaterThanOrEqual(0);
		expect(bRead, `B's reconcile read comes after A's write (X's steps: ${ofX.join(" | ")})`).toBeGreaterThan(aWrite);
		expect(bWrite, `B's write comes after its reconcile read (X's steps: ${ofX.join(" | ")})`).toBeGreaterThan(bRead);
		expect(strokesIn(fake.files.get(".handwriting/X.json") ?? "").sort()).toEqual(["a1", "a2", "b1", "base"]);
	});
});
