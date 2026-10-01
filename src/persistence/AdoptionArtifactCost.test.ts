/**
 * WHAT AN EXTERNAL ADOPTION COSTS ON DISK, measured by executing the shipped
 * `PageStore.prepareExternalAdoption` rather than replicating it.
 *
 * The claim under test was a ship-blocker: that the outgoing recovery artifact
 * is several times the size of the sidecar it preserves, that a pair was
 * written on EVERY adoption rather than only on divergence, and that nothing
 * ever removes one. A pair is now written only when the incoming revision
 * would lose something the outgoing one holds, so the size cells below adopt
 * a revision that lacks one stroke. All three are asserted here against the real store with a
 * capturing adapter, so the numbers come from the real serializer and the real
 * write path, not from a reconstruction of them.
 *
 * WHY THE ARTIFACT IS BIGGER, and it is not a doubling. `serializePage` PACKS
 * strokes: each point becomes four numbers in a flat `pts` array.
 * `serializeExactOutgoing` nests the whole `PageData` under an unknown
 * top-level key, and unknown keys are written as raw JSON - so the nested copy
 * keeps `points` as an array of `{x, y, pressure, t}` OBJECTS. The artifact is
 * therefore one packed page plus one unpacked page, and the unpacked form is
 * the expensive half.
 */

import { describe, expect, it } from "vitest";
import { EXACT_OUTGOING_KEY, PageStore, PageAdapterLike } from "./PageStore";
import { PageData, serializePage } from "../model/PageData";

const PAGE = "504fdb34-aed8-42a0-8df8-66f7db7a02de";
const FOLDER = ".handwriting";
const LIVE = `${FOLDER}/${PAGE}.json`;

/** A page of `n` strokes, each with `pts` points - the shape a note really has. */
function pageOf(n: number, pts = 40, seed = 0): PageData {
	return {
		schemaVersion: 1,
		pageId: PAGE,
		surface: "inline",
		textBoxes: [],
		images: [],
		unknownTop: {},
		unknownByObject: {},
		strokes: Array.from({ length: n }, (_, i) => ({
			id: `stroke-${seed}-${i}`,
			tool: "pen" as const,
			color: "#5f6673",
			width: 2.86,
			createdAt: 1788853814257 + i,
			points: Array.from({ length: pts }, (_, k) => ({
				x: 100 + k * 1.37,
				y: 200 + k * 0.91,
				pressure: 0.4 + (k % 10) / 40,
				t: k * 8,
			})),
		})),
	} as unknown as PageData;
}

interface Captured {
	adapter: PageAdapterLike;
	files: Map<string, string>;
	removed: string[];
	written: string[];
}

function capturing(seed: Record<string, string>): Captured {
	const files = new Map(Object.entries(seed));
	const removed: string[] = [];
	const written: string[] = [];
	const adapter: PageAdapterLike = {
		exists: async (p) => files.has(p),
		read: async (p) => {
			const t = files.get(p);
			if (t === undefined) throw new Error(`no such file ${p}`);
			return t;
		},
		write: async (p, d) => {
			written.push(p);
			files.set(p, d);
		},
		rename: async (from, to) => {
			const t = files.get(from);
			if (t !== undefined) {
				files.set(to, t);
				files.delete(from);
			}
		},
		remove: async (p) => {
			removed.push(p);
			files.delete(p);
		},
		mkdir: async () => {},
		stat: async (p) => (files.has(p) ? { mtime: 1_700_000_000_000 } : null),
	};
	return { adapter, files, removed, written };
}

function artifacts(c: Captured): { outgoing: string; incoming: string } {
	const out = [...c.files.keys()].find((p) => p.includes("-outgoing.json"));
	const inc = [...c.files.keys()].find((p) => p.includes("-incoming.json"));
	expect(out, "no outgoing artifact was written").toBeTypeOf("string");
	expect(inc, "no incoming artifact was written").toBeTypeOf("string");
	return { outgoing: c.files.get(out!)!, incoming: c.files.get(inc!)! };
}

/** `page` with its last stroke gone: the other device erased one, so a pair is due. */
function lessLast(page: PageData): PageData {
	return { ...page, strokes: page.strokes.slice(0, -1) };
}

/** Drive the real store through one adoption and hand back what it wrote. */
async function adopt(outgoing: PageData, incoming: PageData) {
	const liveText = serializePage(incoming);
	const c = capturing({ [LIVE]: liveText });
	const store = new PageStore({ vault: { adapter: c.adapter } }, FOLDER);
	const prep = await store.prepareExternalAdoption(PAGE, outgoing);
	expect(prep.kind, "the store refused to prepare").toBe("prepared");
	return { c, liveText, ...artifacts(c) };
}

describe("the outgoing recovery artifact costs several times the sidecar it preserves", () => {
	it("carries a second, UNPACKED copy of the whole page", async () => {
		const page = pageOf(200);
		const r = await adopt(page, lessLast(page));

		const parsed = JSON.parse(r.outgoing) as Record<string, unknown>;
		// The nested capture is there, and it is the unpacked form: `points`
		// objects, not the packed `pts` array the live sidecar uses.
		expect(Object.keys(parsed)).toContain(EXACT_OUTGOING_KEY);
		const nested = parsed[EXACT_OUTGOING_KEY] as { strokes: { points?: unknown; pts?: unknown }[] };
		expect(nested.strokes[0]!.points, "the nested copy is not unpacked").toBeInstanceOf(Array);
		expect(r.liveText).toContain('"pts"');
	});

	/**
	 * THE NUMBER THE RELEASE DECISION RESTS ON, and it is smaller than the
	 * figure in circulation. MEASURED here across 8 to 400 points per stroke:
	 *
	 *      8 pts  2.88x    20 pts  3.13x    40 pts  3.23x
	 *    120 pts  3.38x   400 pts  3.47x
	 *
	 * So the OUTGOING artifact is ~2.9x-3.5x the sidecar, and the PAIR (both
	 * legs together) is ~3.9x-4.5x. Bounds rather than one number, because it
	 * drifts with points per stroke - but it is nowhere near a doubling and
	 * nowhere near nine times either.
	 */
	it("is about three times the sidecar, across every realistic geometry", async () => {
		for (const pts of [8, 40, 400]) {
			const page = pageOf(300, pts);
			const r = await adopt(page, lessLast(page));

			const ratio = r.outgoing.length / r.liveText.length;
			const msg = `${pts} pts: outgoing ${r.outgoing.length}B vs sidecar ${r.liveText.length}B = ${ratio.toFixed(2)}x`;
			expect(ratio, msg).toBeGreaterThan(2.5);
			expect(ratio, msg).toBeLessThan(4);
		}
	});

	it("the pair together is about four and a half times the sidecar at worst", async () => {
		const page = pageOf(300, 400);
		const r = await adopt(page, lessLast(page));

		const pair = (r.outgoing.length + r.incoming.length) / r.liveText.length;
		expect(pair, `pair ${pair.toFixed(2)}x`).toBeGreaterThan(3.8);
		expect(pair, `pair ${pair.toFixed(2)}x`).toBeLessThan(4.7);
	});

	it("the incoming leg is the other device's bytes and costs one sidecar", async () => {
		const page = pageOf(500);
		const r = await adopt(page, lessLast(page));

		// The incoming leg is verbatim, so it is the cheap half. The pair's
		// total cost is dominated by the outgoing artifact.
		expect(r.incoming.length).toBe(r.liveText.length);
	});

	/**
	 * The multiplier does NOT amortise. It is set by the shape of a stroke,
	 * not by how many there are, so a big note pays proportionally - which is
	 * what makes the absolute numbers on a real page large.
	 */
	it("the multiplier is independent of how many strokes the page has", async () => {
		const small = await adopt(pageOf(100), lessLast(pageOf(100)));
		const large = await adopt(pageOf(1000), lessLast(pageOf(1000)));

		const rs = small.outgoing.length / small.liveText.length;
		const rl = large.outgoing.length / large.liveText.length;
		expect(Math.abs(rs - rl), `100 strokes ${rs.toFixed(2)}x, 1000 strokes ${rl.toFixed(2)}x`).toBeLessThan(0.05);
	});
});

describe("a pair is written only when the incoming revision would lose something", () => {
	/**
	 * A receive-only device - one that never edited the note - used to pay the
	 * full artifact cost on every revision, because nothing compared the two
	 * revisions before writing. Now nothing is written unless the outgoing
	 * revision holds something the incoming one lacks.
	 */
	async function pairsAfter(mine: PageData, theirs: PageData): Promise<string[]> {
		const c = capturing({ [LIVE]: serializePage(theirs) });
		const store = new PageStore({ vault: { adapter: c.adapter } }, FOLDER);
		const prep = await store.prepareExternalAdoption(PAGE, mine);
		expect(prep.kind).toBe("prepared");
		return [...c.files.keys()].filter((p) => p.includes(".conflict-external-"));
	}

	it("writes nothing when the incoming revision is a strict superset", async () => {
		expect(await pairsAfter(pageOf(100), pageOf(140))).toEqual([]);
	});

	it("writes nothing when the two revisions are byte-identical", async () => {
		expect(await pairsAfter(pageOf(100), pageOf(100))).toEqual([]);
	});

	it("writes the pair when the incoming revision lacks a stroke the outgoing one has", async () => {
		expect(await pairsAfter(pageOf(100), lessLast(pageOf(100)))).toHaveLength(2);
	});

	it("writes the pair when a stroke kept its id but changed", async () => {
		const mine = pageOf(100);
		const theirs = pageOf(100);
		theirs.strokes[0] = { ...theirs.strokes[0]!, color: "#123456" };
		expect(await pairsAfter(mine, theirs)).toHaveLength(2);
	});
});

describe("nothing removes an artifact", () => {
	it("the adoption path never calls remove", async () => {
		const page = pageOf(100);
		const r = await adopt(page, lessLast(page));

		expect(r.c.removed).toEqual([]);
	});

	it("a second adoption adds a second pair rather than replacing the first", async () => {
		const c = capturing({ [LIVE]: serializePage(pageOf(100)) });
		const store = new PageStore({ vault: { adapter: c.adapter } }, FOLDER);

		await store.prepareExternalAdoption(PAGE, pageOf(100, 40, 1));
		// A different outgoing revision means a different dedup key, so the
		// store allocates a fresh pair rather than reusing the last one.
		c.files.set(LIVE, serializePage(pageOf(120)));
		await store.prepareExternalAdoption(PAGE, pageOf(100, 40, 2));

		const pairs = [...c.files.keys()].filter((p) => p.includes("-outgoing.json"));
		expect(pairs.length).toBe(2);
		expect(c.removed).toEqual([]);
	});
});

// ---- what the adoption actually costs the CPU -------------------------------

/**
 * COUNTED, NOT TIMED. A millisecond figure measures the machine that produced
 * it; the number of JSON operations and the bytes each one chews are properties
 * of the code and are identical on a tablet and a desktop. So the CPU claim is
 * settled here by counting work, and the timings in the handback are reported
 * as ratios and labelled machine-dependent rather than asserted.
 */
function countingJson() {
	const parses: number[] = [];
	const stringifies: number[] = [];
	const realParse = JSON.parse;
	const realStringify = JSON.stringify;
	JSON.parse = ((text: string, ...rest: unknown[]) => {
		if (typeof text === "string") parses.push(text.length);
		return (realParse as (t: string, ...r: unknown[]) => unknown)(text, ...rest);
	}) as typeof JSON.parse;
	JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
		const out = (realStringify as (v: unknown, ...r: unknown[]) => string)(value, ...rest);
		if (typeof out === "string") stringifies.push(out.length);
		return out;
	}) as typeof JSON.stringify;
	return {
		parses,
		stringifies,
		restore: () => {
			JSON.parse = realParse;
			JSON.stringify = realStringify;
		},
	};
}

describe("what one adoption costs the CPU, counted rather than timed", () => {
	it("parses and re-stringifies the inflated artifact, so the cost is paid on ~3x twice", async () => {
		const page = pageOf(300, 40);
		const liveText = serializePage(lessLast(page));
		const c = capturing({ [LIVE]: liveText });
		const store = new PageStore({ vault: { adapter: c.adapter } }, FOLDER);

		const j = countingJson();
		try {
			await store.prepareExternalAdoption(PAGE, page);
		} finally {
			j.restore();
		}

		const sidecar = liveText.length;
		const parsed = j.parses.reduce((a, b) => a + b, 0);
		const stringified = j.stringifies.reduce((a, b) => a + b, 0);
		const biggestParse = Math.max(...j.parses);
		const biggestStringify = Math.max(...j.stringifies);
		const note = `sidecar ${sidecar}B | parsed ${parsed}B in ${j.parses.length} calls (max ${biggestParse}B) | stringified ${stringified}B in ${j.stringifies.length} calls (max ${biggestStringify}B)`;

		// The artifact is parsed at least once at full size - that is
		// `writeVerified` reopening what it just wrote.
		expect(biggestParse, note).toBeGreaterThan(sidecar * 2);
		// And the unpacked capture is stringified TWICE, for the semantic
		// equality check against the frozen capture.
		expect(biggestStringify, note).toBeGreaterThan(sidecar * 2);
		// Total JSON work is several sidecars' worth, on a path that in a
		// synced vault runs whenever another device's edits land.
		expect(parsed + stringified, note).toBeGreaterThan(sidecar * 6);
	});

	it("a reused pair skips the write and the parse but still pays the serialise", async () => {
		const page = pageOf(300, 40);
		const liveText = serializePage(lessLast(page));
		const c = capturing({ [LIVE]: liveText });
		const store = new PageStore({ vault: { adapter: c.adapter } }, FOLDER);

		await store.prepareExternalAdoption(PAGE, page);
		const afterFirst = c.written.length;

		const j = countingJson();
		try {
			await store.prepareExternalAdoption(PAGE, page);
		} finally {
			j.restore();
		}

		// No second pair: the dedup key matched and the artifacts were re-proved.
		expect(c.written.length, "a retry wrote new artifacts").toBe(afterFirst);
		// But it still serialised the inflated outgoing text to compute the key
		// and to compare against what is on disk.
		const stringified = j.stringifies.reduce((a, b) => a + b, 0);
		expect(stringified, `retry stringified ${stringified}B`).toBeGreaterThan(liveText.length * 2);
	});
});
