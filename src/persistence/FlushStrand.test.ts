/**
 * A flush that outlasts the save bound stranded a batch scheduled during it.
 *
 * flush takes its page list once and then awaits the writes. A batch scheduled
 * during that await is not in the list. Its quiet timer fires with a pen down
 * and holds it for the pen; its bound timer fires with the pen still down and
 * holds it past the bound under a cap. flush then ends with unwatchPens, which
 * drops the pen listeners, both holds and the cap. The page sat in `pending`
 * with no timer at all, written only by the next schedule, a later flush, a
 * backgrounding or the unload: a crash before then lost it, and until then the
 * page took no ink from the other device.
 *
 * The contract: when flush returns, every page still in
 * `pending` has a live quiet or bound timer. One queue state is left out, by
 * design: a page whose retries are spent and whose user has been told waits
 * for the next schedule or flush, so a flush does not restart a retry loop
 * the budget already ended. The other state with no timer, a recycle that
 * failed after its note was deleted, is never in `pending`
 * (PageStoreRemove.ts, recycleFailedWrite), so the contract does not reach it.
 *
 * A real store over FakeAdapter, the flush held open with its write gate, and
 * the pen watch on an EventTarget standing in for the window's listeners.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { MAX_DIRTY_MS, PageStore } from "./PageStore";
import { FakeAdapter, gate } from "./FakeAdapter";
import { PageData, emptyPage } from "../model/PageData";

const DEBOUNCE_MS = 700;

function pageWithInk(id: string, ...strokeIds: string[]): PageData {
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

type Inner = {
	pending: Map<string, unknown>;
	timers: Map<string, unknown>;
	maxTimers: Map<string, unknown>;
	heldForPen: Set<string>;
	heldPastBound: Map<string, unknown>;
	errorNotified: Set<string>;
};

const g = globalThis as Record<string, unknown>;
let fake: FakeAdapter;
let store: PageStore;
let inner: Inner;
let pens: EventTarget;

function pen(type: "pointerdown" | "pointerup", pointerId = 1): Event {
	return Object.assign(new Event(type), { pointerType: "pen", pointerId });
}

/** A live sidecar for this page, not a temporary or a conflict copy. */
function written(id: string): boolean {
	return [...fake.files.keys()].some((k) => k.includes(id) && k.endsWith(".json") && !k.includes(".conflict-"));
}

beforeEach(() => {
	vi.useFakeTimers();
	g.window = globalThis;
	pens = new EventTarget();
	g.addEventListener = pens.addEventListener.bind(pens);
	g.removeEventListener = pens.removeEventListener.bind(pens);
	fake = new FakeAdapter();
	store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
	inner = store as unknown as Inner;
});

afterEach(() => {
	vi.useRealTimers();
	delete g.addEventListener;
	delete g.removeEventListener;
});

describe("a flush that outlasts the save bound", () => {
	it("returns with a live timer for a batch scheduled during it, held for a pen past its bound, and the batch is written", async () => {
		store.schedule("page-a", pageWithInk("page-a", "s1"));
		const held = gate();
		fake.writeGate = held.promise;
		const flushing = store.flush();
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.writeAttempts, "precondition: the flush's write is held in the gate").toBeGreaterThan(0);

		// A pen goes down and a stroke is scheduled on another page while the flush waits.
		pens.dispatchEvent(pen("pointerdown"));
		store.schedule("page-b", pageWithInk("page-b", "s2"));
		await vi.advanceTimersByTimeAsync(MAX_DIRTY_MS + 100);
		expect(inner.heldForPen.has("page-b"), "precondition: the quiet timer held the batch for the pen").toBe(true);
		expect(inner.heldPastBound.has("page-b"), "precondition: the bound timer held the batch past the bound").toBe(true);

		fake.writeGate = null;
		held.release();
		await flushing;
		expect(inner.pending.has("page-b"), "precondition: the batch is still queued").toBe(true);
		expect(
			inner.timers.has("page-b") || inner.maxTimers.has("page-b"),
			"flush returned with the batch queued and no quiet or bound timer"
		).toBe(true);

		// No further schedule, no lift the store can hear: the timer alone writes it.
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
		expect(inner.pending.has("page-b"), "the stranded batch was never written").toBe(false);
		expect(written("page-b"), JSON.stringify([...fake.files.keys()])).toBe(true);
	});

	it("gives no new timer to a page whose retries are spent and whose user was told", async () => {
		const told: string[] = [];
		store.onWriteError = (id: string) => told.push(id);
		fake.failWriteTimes = 1000;
		store.schedule("page-c", pageWithInk("page-c", "s3"));
		await vi.runAllTimersAsync();
		expect(told, "precondition: the retries ran out and the user was told once").toEqual(["page-c"]);
		expect(inner.pending.has("page-c"), "precondition: the state is still queued").toBe(true);
		expect(inner.timers.has("page-c") || inner.maxTimers.has("page-c"), "precondition: no timer, by design").toBe(false);

		await store.flush();
		expect(inner.pending.has("page-c")).toBe(true);
		expect(
			inner.timers.has("page-c") || inner.maxTimers.has("page-c"),
			"the flush restarted a retry loop the budget had ended"
		).toBe(false);
		const attempts = fake.writeAttempts;
		await vi.runAllTimersAsync();
		expect(fake.writeAttempts, "a timer wrote the spent page again").toBe(attempts);
		expect(told, "the user was told again").toEqual(["page-c"]);
	});
});
