/**
 * TWO HAND-EDITED INK FILE CASES IN THE PAGE PARSER.
 *
 * 1. A stroke with no readable `createdAt` was stamped with the time of the
 *    load. Two devices that read one file then held two different strokes, and
 *    the adoption check recorded a fork where nothing diverged. The fallback is
 *    a fixed 0 now, so two parses of one file are equal under any two clocks.
 * 2. A leading byte-order mark made `JSON.parse` throw, so a note whose sidecar
 *    was saved by a tool that adds one showed no ink and locked. One leading
 *    U+FEFF is dropped before the parse, as the Markdown side already does.
 *
 * Every case runs the real parser. The two-clock cases freeze the clock at two
 * different values, because two parses in one millisecond agree by accident.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
	normalizePath: (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/"),
}));

import { PageStore, outgoingDiverges } from "./PageStore";
import { FakeAdapter } from "./FakeAdapter";
import { parsePage, serializePage } from "../model/PageData";

const PAGE_ID = "hand-edited";
const LIVE = ".handwriting/hand-edited.json";
const T1 = 1_000_000_000_000;
const T2 = 2_000_000_000_000;
const BOM = "\uFEFF";

function strokeJson(id: string, createdAt?: unknown): Record<string, unknown> {
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2,
		pts: [10, 20, 0.5, 0, 30, 40, 0.5, 8],
		...(createdAt === undefined ? {} : { createdAt }),
	};
}

/** A sidecar as a person or a tool would leave it: strokes with no `createdAt`. */
function sidecar(strokes: Record<string, unknown>[]): string {
	return JSON.stringify({
		schemaVersion: 1,
		pageId: PAGE_ID,
		surface: "inline",
		textBoxes: [],
		images: [],
		strokes,
	});
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("a missing createdAt reads the same on every load", () => {
	// The setup proof, green and first: the cells below rest on the clock being
	// frozen, on one stroke loading, and on a real createdAt being kept exactly.
	it("the harness holds: one stroke loads, a real createdAt is kept, the clock moves", () => {
		vi.setSystemTime(T1);
		const kept = parsePage(sidecar([strokeJson("s1", 12345)]), PAGE_ID);
		expect(kept.data.strokes).toHaveLength(1);
		expect(kept.data.strokes[0]!.createdAt).toBe(12345);
		expect(kept.damaged).toBeFalsy();
		expect(Date.now()).toBe(T1);
		vi.setSystemTime(T2);
		expect(Date.now()).toBe(T2);
	});

	it("absent, null, a string and NaN all fall back to 0 under any clock", () => {
		for (const bad of [undefined, null, "1700000000000", Number.NaN]) {
			const text = sidecar([strokeJson("s1", bad)]);
			vi.setSystemTime(T1);
			const first = parsePage(text, PAGE_ID).data.strokes[0]!.createdAt;
			vi.setSystemTime(T2);
			const second = parsePage(text, PAGE_ID).data.strokes[0]!.createdAt;
			expect(first, `value ${String(bad)} at clock 1`).toBe(0);
			expect(second, `value ${String(bad)} at clock 2`).toBe(0);
		}
	});

	it("a real createdAt of 0 and a real large one are both kept, never replaced", () => {
		vi.setSystemTime(T1);
		expect(parsePage(sidecar([strokeJson("s1", 0)]), PAGE_ID).data.strokes[0]!.createdAt).toBe(0);
		expect(
			parsePage(sidecar([strokeJson("s1", 1_700_000_000_000)]), PAGE_ID).data.strokes[0]!.createdAt
		).toBe(1_700_000_000_000);
	});

	it("re-saving one file under two clocks writes identical bytes", () => {
		const text = sidecar([strokeJson("s1")]);
		vi.setSystemTime(T1);
		const a = serializePage(parsePage(text, PAGE_ID).data);
		vi.setSystemTime(T2);
		const b = serializePage(parsePage(text, PAGE_ID).data);
		expect(a).toBe(b);
	});

	it("two devices that read one file, and one adds a stroke, see no divergence", () => {
		const base = [strokeJson("s1")];
		vi.setSystemTime(T1);
		const outgoing = parsePage(sidecar(base), PAGE_ID).data;
		vi.setSystemTime(T2);
		const incoming = parsePage(sidecar([...base, strokeJson("s2")]), PAGE_ID).data;
		expect(outgoing.strokes.map((s) => s.id)).toEqual(["s1"]);
		expect(incoming.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
		expect(outgoingDiverges(outgoing, incoming)).toBe(false);
	});

	// The same shape through the real adoption route: no fork recorded, no
	// recovery pair written, and the incoming revision is handed back whole.
	it("adopting a file that only added a stroke records no fork and writes no recovery pair", async () => {
		const fake = new FakeAdapter();
		const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
		const base = [strokeJson("s1")];
		vi.setSystemTime(T1);
		const outgoing = parsePage(sidecar(base), PAGE_ID).data;
		vi.setSystemTime(T2);
		fake.files.set(LIVE, sidecar([...base, strokeJson("s2")]));
		fake.mtimes.set(LIVE, ++fake.clock);

		const prep = await store.prepareExternalAdoption(PAGE_ID, outgoing);

		expect(prep.kind).toBe("prepared");
		if (prep.kind !== "prepared") return;
		expect(prep.prepared.outgoingPath).toBeUndefined();
		expect(prep.prepared.incomingPath).toBeUndefined();
		expect(prep.prepared.data.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
		expect([...fake.files.keys()].filter((k) => k.includes(".conflict-"))).toEqual([]);
	});

	// CONTROL: a stroke the other device does not have is still a fork. The fix
	// must not turn the divergence check into a check that never fires.
	it("CONTROL: a stroke the incoming file lacks is still a divergence", () => {
		vi.setSystemTime(T1);
		const outgoing = parsePage(sidecar([strokeJson("s1"), strokeJson("mine")]), PAGE_ID).data;
		vi.setSystemTime(T2);
		const incoming = parsePage(sidecar([strokeJson("s1")]), PAGE_ID).data;
		expect(outgoingDiverges(outgoing, incoming)).toBe(true);
	});

	// CONTROL: a real createdAt that differs between the devices is still a
	// difference in the stroke. The parser fix does not blind the comparison.
	it("CONTROL: two real createdAt values that differ are still a divergence", () => {
		const outgoing = parsePage(sidecar([strokeJson("s1", 111)]), PAGE_ID).data;
		const incoming = parsePage(sidecar([strokeJson("s1", 222)]), PAGE_ID).data;
		expect(outgoingDiverges(outgoing, incoming)).toBe(true);
	});

	it("two parses of one file under two clocks give strokes that are equal field for field", () => {
		// EVERY OPTIONAL FIELD MADE UNREADABLE, so any other clock default in the
		// parser would also show here. Only the id and the points are kept.
		const text = sidecar([{ id: "probe-1", pts: [10, 20, 0.5, 0, 30, 40, 0.5, 8] }]);
		vi.setSystemTime(T1);
		const first = parsePage(text, PAGE_ID).data.strokes[0]!;
		vi.setSystemTime(T2);
		const second = parsePage(text, PAGE_ID).data.strokes[0]!;
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
		expect(Object.keys(first)).toContain("createdAt");
	});
});

describe("a leading byte-order mark is stripped before the parse", () => {
	it("the harness holds: the same text without a mark parses clean", () => {
		const r = parsePage(sidecar([strokeJson("s1", 5)]), PAGE_ID);
		expect(r.recovered).toBe(false);
		expect(r.damaged).toBeFalsy();
		expect(r.data.strokes.map((s) => s.id)).toEqual(["s1"]);
	});

	it("a file that starts with U+FEFF loads its ink and is not damaged", () => {
		const r = parsePage(BOM + sidecar([strokeJson("s1", 5)]), PAGE_ID);
		expect(r.recovered).toBe(false);
		expect(r.damaged).toBeFalsy();
		expect(r.problem).toBeUndefined();
		expect(r.data.strokes.map((s) => s.id)).toEqual(["s1"]);
		expect(r.data.pageId).toBe(PAGE_ID);
	});

	it("only ONE leading mark is dropped: a second one is still an unreadable file", () => {
		const r = parsePage(BOM + BOM + sidecar([strokeJson("s1", 5)]), PAGE_ID);
		expect(r.damaged).toBe(true);
		expect(r.data.strokes).toEqual([]);
	});

	it("a mark in the middle of the text is not touched", () => {
		const r = parsePage(sidecar([strokeJson("s1", 5)]).replace('"tool"', `"tool"${BOM}`), PAGE_ID);
		expect(r.damaged).toBe(true);
	});

	it("through the store: a file with a mark loads its ink, and the next save writes none", async () => {
		const fake = new FakeAdapter();
		const store = new PageStore({ vault: { adapter: fake } } as never, ".handwriting", () => 5_000_000);
		fake.files.set(LIVE, BOM + sidecar([strokeJson("s1", 5)]));
		fake.mtimes.set(LIVE, ++fake.clock);

		const loaded = await store.load(PAGE_ID);

		expect(loaded).not.toBeNull();
		expect(loaded!.damaged).toBeFalsy();
		expect(loaded!.data.strokes.map((s) => s.id)).toEqual(["s1"]);

		await store.saveNow(PAGE_ID, loaded!.data);
		const written = fake.files.get(LIVE)!;
		expect(written.charCodeAt(0)).not.toBe(0xfeff);
		expect(parsePage(written, PAGE_ID).data.strokes.map((s) => s.id)).toEqual(["s1"]);
	});
});
