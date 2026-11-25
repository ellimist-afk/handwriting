/**
 * This device's record of the PDF paths it saw, on its own: what the next session's record answers before its listing
 * (is this path one the record never held?), how it is kept in the device's local store, and how it fails. Every
 * failure answers "held", today's result.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOST_GONE_KEPT, PdfSeenPaths, SAVE_AFTER_MS, seenPdf, type PdfSeenPathsStore } from "./PdfSeenPaths";

const PAPER = "Paper.pdf";
const NEW = "New.pdf";
const NEVER = "Never.pdf";
const COMPOSED = `Caf${String.fromCharCode(0xe9)}.pdf`;
const DECOMPOSED = COMPOSED.normalize("NFD");
/** The most characters the events key may take before the whole record is written in the event's task. */
const EVENTS_CAP = 32 * 1024;

const seen = (path: string, size = 100, mtime = 1) => seenPdf({ path, stat: { size, mtime } });

/**
 * This device's local store for the record and its events key: what each holds, how many times each was written and
 * how many times the events were cleared (a clear is not a write), and the longest events value written. `keepEvents`
 * drops every clear of the events key, as an app stopped right after a whole write would. `stopAtWrite` stops the app
 * inside the next whole write: that write throws, and nothing after it reaches the store. `refuse` makes every save of
 * the record throw, a clear too when `refuseClear`; `refuseLoad` makes its load throw.
 */
function device() {
	const held = new Map<string, string>();
	const d = {
		held,
		recordWrites: 0,
		eventsWrites: 0,
		eventsClears: 0,
		longestEvents: 0,
		keepEvents: false,
		stopAtWrite: false,
		stopped: false,
		refuse: false,
		refuseClear: false,
		refuseLoad: false,
		record: {
			load: () => {
				if (d.refuseLoad) throw new Error("load refused");
				return held.get("record") ?? null;
			},
			save: (saved: string | null) => {
				if (d.stopped) return;
				if (saved === null) {
					if (d.refuseClear) throw new Error("clear refused");
					held.delete("record");
				} else if (d.refuse) throw new Error("store full");
				else if (d.stopAtWrite) {
					d.stopped = true;
					throw new Error("the app stopped inside this write");
				} else {
					d.recordWrites++;
					held.set("record", saved);
				}
			},
		} as PdfSeenPathsStore,
		events: {
			load: () => held.get("events") ?? null,
			save: (saved: string | null) => {
				if (d.stopped) return;
				if (saved === null) {
					d.eventsClears++;
					if (!d.keepEvents) held.delete("events");
				} else {
					d.eventsWrites++;
					d.longestEvents = Math.max(d.longestEvents, saved.length);
					held.set("events", saved);
				}
			},
		} as PdfSeenPathsStore,
	};
	return d;
}
type Device = ReturnType<typeof device>;

/** The next session's record, before its listing. */
const next = (d: Device) => new PdfSeenPaths(d.record, d.events);

/** The next session's record holds `path`: it is not unknown, while a path never seen is (so there is a record). */
function expectHeld(d: Device, path: string) {
	const record = next(d);
	expect(record.unknownBeforeListing(NEVER), "precondition: the next session has a record").toBe(true);
	expect(record.unknownBeforeListing(path), `${path} read as never seen`).toBe(false);
}

/** The next session has no record: every path, one never seen too, answers held. */
function expectNoRecord(d: Device) {
	expect(next(d).unknownBeforeListing(NEVER), "a path read as never seen with no record").toBe(false);
}

beforeEach(() => {
	vi.useFakeTimers();
});

describe("what the next session's record answers before its listing", () => {
	it("with no record, no path is unknown", () => {
		expectNoRecord(device());
	});

	it("a path listed is held; a path never listed is not", () => {
		const d = device();
		next(d).listed([seen(PAPER)]);
		expectHeld(d, PAPER);
	});

	it("after this session's listing, no path is unknown", () => {
		const d = device();
		next(d).listed([seen(PAPER)]);
		const record = next(d);
		record.listed([seen(PAPER)]);
		expect(record.unknownBeforeListing(NEVER)).toBe(false);
	});

	it("a path that came, went or was renamed to or from after the listing is held, gone or not", () => {
		const d = device();
		const record = next(d);
		record.listed([seen(PAPER), seen("Gone.pdf"), seen("From.pdf")]);
		record.arrived(seen(NEW));
		record.left("Gone.pdf");
		record.renamed("From.pdf", seen("To.pdf"));
		for (const path of [PAPER, NEW, "Gone.pdf", "From.pdf", "To.pdf"]) expectHeld(d, path);
	});

	it("a path whose file went at a listing (gone while no session ran) is still held", () => {
		const d = device();
		next(d).listed([seen(PAPER), seen(NEW)]);
		next(d).listed([seen(PAPER)]);
		expectHeld(d, NEW);
	});

	it("a path listed with another size or modified time is still held", () => {
		const d = device();
		next(d).listed([seen(PAPER), seen(NEW, 100, 1)]);
		next(d).listed([seen(PAPER), seen(NEW, 200, 9)]);
		expectHeld(d, NEW);
	});

	it("events before this session's listing are left to it: a create then is not recorded by itself", () => {
		const d = device();
		next(d).listed([seen(PAPER)]);
		const record = next(d);
		record.arrived(seen(NEW));
		record.left(PAPER);
		record.listed([seen(PAPER)]);
		vi.advanceTimersByTime(SAVE_AFTER_MS);
		const after = next(d);
		expect(after.unknownBeforeListing(NEW)).toBe(true);
		expect(after.unknownBeforeListing(PAPER)).toBe(false);
	});

	it("one listing a session: a second is ignored", () => {
		const d = device();
		const record = next(d);
		record.listed([seen(PAPER)]);
		record.listed([seen(NEW)]);
		expect(next(d).unknownBeforeListing(NEW)).toBe(true);
	});

	it.each([
		["recorded composed, asked decomposed", COMPOSED, DECOMPOSED],
		["recorded decomposed, asked composed", DECOMPOSED, COMPOSED],
	] as const)("one path in two Unicode forms is one path (%s)", (_case, recorded, asked) => {
		const d = device();
		next(d).listed([seen(PAPER), seen(recorded)]);
		expectHeld(d, asked);
	});

	it(`keeps the ${MOST_GONE_KEPT} newest paths of files gone; an older one dropped is not held`, () => {
		const d = device();
		const record = next(d);
		const gone = Array.from({ length: MOST_GONE_KEPT + 1 }, (_, i) => `gone-${i}.pdf`);
		record.listed([seen(PAPER), ...gone.map((p) => seen(p))]);
		for (const p of gone) record.left(p);
		vi.advanceTimersByTime(SAVE_AFTER_MS);
		const after = next(d);
		expect(after.unknownBeforeListing("gone-0.pdf")).toBe(true);
		expect(after.unknownBeforeListing("gone-1.pdf")).toBe(false);
		expect(after.unknownBeforeListing(`gone-${MOST_GONE_KEPT}.pdf`)).toBe(false);
	});
});

describe("a record that cannot be kept or read is no record", () => {
	it("a record that does not parse to its shape is no record", () => {
		const good = { tick: 1, spans: [[PAPER, 1, null, 100, 1]] };
		const bad: unknown[] = [
			"{not json",
			42,
			{ tick: 0, spans: [] },
			{ tick: 1 },
			{ tick: 1, spans: [[PAPER, 1, null, 100]] },
			{ tick: 1, spans: [[PAPER, 2, null, 100, 1]] },
			{ tick: 2, spans: [[PAPER, 2, 1, 100, 1]] },
			{ tick: 1, spans: [[PAPER, 1, null, 100, 1], [PAPER, 1, null, 100, 1]] },
			{ tick: 1, spans: [[PAPER, 1, null, -5, 1]] },
		];
		for (const held of bad) {
			const d = device();
			d.held.set("record", typeof held === "string" ? held : JSON.stringify(held));
			expect(next(d).unknownBeforeListing(NEVER), JSON.stringify(held)).toBe(false);
		}
		const d = device();
		d.held.set("record", JSON.stringify(good));
		expectHeld(d, PAPER);
	});

	it("a record past the size kept: nothing saved, the stored one cleared, its events too, and later events ignored", () => {
		const d = device();
		next(d).listed([seen(PAPER)]);
		const record = next(d);
		record.listed(Array.from({ length: 30 }, (_, i) => seen(`${"a".repeat(10_000)}-${i}.pdf`)));
		expect(d.held.has("record")).toBe(false);
		record.arrived(seen(NEW));
		vi.advanceTimersByTime(SAVE_AFTER_MS);
		expect(d.held.has("record")).toBe(false);
		expect(d.held.has("events")).toBe(false);
		expectNoRecord(d);
	});

	it("a store that refuses the listing's save: nothing throws, the record is off, the stored one cleared", () => {
		const d = device();
		next(d).listed([seen(PAPER)]);
		d.refuse = true;
		const record = next(d);
		expect(() => record.listed([seen(PAPER)])).not.toThrow();
		expect(() => record.arrived(seen(NEW))).not.toThrow();
		d.refuse = false;
		expectNoRecord(d);
	});

	it("a store that refuses a timed save, and its clear too: nothing throws, the record is off", () => {
		const d = device();
		const record = next(d);
		record.listed([seen(PAPER)]);
		d.refuse = true;
		d.refuseClear = true;
		record.arrived(seen(NEW));
		expect(() => vi.advanceTimersByTime(SAVE_AFTER_MS)).not.toThrow();
		expect(record.unknownBeforeListing(NEVER)).toBe(false);
	});

	it("a store that refuses the load: nothing throws, no record this session, and the stored one is cleared", () => {
		const d = device();
		next(d).listed([seen(PAPER)]);
		d.refuseLoad = true;
		let record: PdfSeenPaths | undefined;
		expect(() => (record = next(d))).not.toThrow();
		expect(record!.unknownBeforeListing(NEVER)).toBe(false);
		d.refuseLoad = false;
		expect(d.held.has("record")).toBe(false);
		expectNoRecord(d);
	});
});

describe("the record's events are kept in the event's own task, the whole record at most once a second", () => {
	it("the listing is one whole write, at once", () => {
		const d = device();
		next(d).listed([seen(PAPER)]);
		expect(d.recordWrites).toBe(1);
		expect(d.eventsWrites).toBe(0);
	});

	it("a record built on this device's store after an event, before any timer runs, holds the path", () => {
		const d = device();
		const first = next(d);
		first.listed([seen(PAPER)]);
		first.arrived(seen(NEW));
		expect(d.recordWrites, "precondition: no whole write since the listing").toBe(1);
		expectHeld(d, NEW);
	});

	it("a delete then a create of one path, both only in the events, end with the path there", () => {
		const d = device();
		const first = next(d);
		first.listed([seen(PAPER), seen(NEW)]);
		first.left(NEW);
		first.arrived(seen(NEW));
		const replayed = next(d);
		replayed.listed([seen(PAPER)]);
		// The listing ends the span of a file there after the replay: it ends one tick before the listing's.
		const record = JSON.parse(d.held.get("record")!) as { tick: number; spans: [string, number, number | null][] };
		const span = record.spans.find(([p]) => p === NEW)!;
		expect(span[2], "the replay left the path gone").toBe(record.tick - 1);
	});

	it("a stop between a whole write and the clearing of the events loads the same record as no stop", () => {
		const run = (keepEvents: boolean) => {
			const d = device();
			const one = next(d);
			one.listed([seen(PAPER)]);
			one.arrived(seen(NEW));
			vi.clearAllTimers();
			d.keepEvents = keepEvents;
			next(d).listed([seen(PAPER)]);
			d.keepEvents = false;
			next(d).listed([seen(PAPER)]);
			return d.held.get("record");
		};
		expect(run(true)).toBe(run(false));
	});

	it("a stop inside the whole write: the events still hold what it would have written", () => {
		const d = device();
		const one = next(d);
		one.listed([seen(PAPER)]);
		one.arrived(seen(NEW));
		d.stopAtWrite = true;
		vi.advanceTimersByTime(SAVE_AFTER_MS);
		expect(d.stopped, "precondition: the app stopped inside the timer's whole write").toBe(true);
		d.stopAtWrite = false;
		d.stopped = false;
		expectHeld(d, NEW);
	});

	it.each([
		["not JSON", "{not json"],
		["not a list", JSON.stringify({ events: [] })],
		["an entry not of the shape", JSON.stringify([[2, NEW, 1, 100]])],
		["an entry neither came nor went", JSON.stringify([[2, NEW, 2, 100, 1]])],
		["ticks going down", JSON.stringify([[3, NEW, 1, 100, 1], [2, "Other.pdf", 1, 100, 1]])],
	] as const)("an events key that cannot be read (%s) is no record", (_case, events) => {
		const d = device();
		next(d).listed([seen(PAPER)]);
		d.held.set("events", events);
		expectNoRecord(d);
	});

	it("2500 PDF creates after ready, 10 ms apart: one events write each, no more whole writes than seconds passed", () => {
		const d = device();
		const record = next(d);
		record.listed([seen(PAPER)]);
		expect(d.recordWrites, "precondition: the listing is one whole write").toBe(1);
		for (let i = 0; i < 2500; i++) {
			record.arrived(seen(`Synced/p-${i}.pdf`));
			vi.advanceTimersByTime(10);
		}
		vi.advanceTimersByTime(1_000);
		expect(d.eventsWrites).toBe(2500);
		expect(d.recordWrites - 1).toBeLessThanOrEqual(26);
		expect(d.eventsClears, "one clear of the events after each whole write past the listing").toBe(d.recordWrites - 1);
		expect(d.longestEvents).toBeLessThanOrEqual(EVENTS_CAP);
		expect(d.held.has("events"), "the last whole write cleared the events").toBe(false);
		expectHeld(d, "Synced/p-2499.pdf");
	});

	it("events past the cap: the whole record is written in that event's task and the events cleared", () => {
		const d = device();
		const record = next(d);
		record.listed([seen(PAPER)]);
		let i = 0;
		while (d.recordWrites === 1 && i < 100) record.arrived(seen(`${"b".repeat(2000)}-${i++}.pdf`));
		expect(d.recordWrites, "a whole write ran with no timer").toBe(2);
		expect(d.longestEvents).toBeLessThanOrEqual(EVENTS_CAP);
		expect(d.held.has("events")).toBe(false);
		expectHeld(d, `${"b".repeat(2000)}-${i - 1}.pdf`);
	});

	it("unload writes a change still waiting on its timer; with none waiting it writes nothing", () => {
		const d = device();
		const record = next(d);
		record.listed([seen(PAPER)]);
		record.flush();
		expect(d.recordWrites).toBe(1);
		record.arrived(seen(NEW));
		record.flush();
		expect(d.recordWrites).toBe(2);
		expect(d.held.has("events")).toBe(false);
		vi.advanceTimersByTime(SAVE_AFTER_MS);
		expect(d.recordWrites, "the timer was done with at the flush").toBe(2);
	});
});
