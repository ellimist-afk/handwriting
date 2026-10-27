/**
 * THE SAVE'S STAMPS, TAKEN IN PARTS, EQUAL THE WHOLE-TEXT STAMP. On the 25 MB MCB EXAM 3 page the save stamped its new
 * text whole after the sliced serializer (24 to 37 ms with the join) and the file it replaces whole (46 ms), each one
 * main-thread task. The stamp is now fed as the serializer builds the text, and the replaced file is stamped in slices.
 * The stamp is the store's identity for its own bytes: a different value makes the store keep its own last file as a
 * conflict copy, or take another writer's file for its own. Every case here compares with contentStamp itself.
 */
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, parsePage, serializePage, serializePageSlicedStamped, type PageData } from "../model/PageData";
import { translateStroke } from "../objects/Selection";
import { beginContentStamp, contentStamp, contentStampSliced } from "./PageStore";
import fixture from "../../test/render/fixtures/alan-ink-75d1627a.json";

function alanPage(): PageData {
	return parsePage(JSON.stringify(fixture), (fixture as { pageId: string }).pageId).data;
}

const alanText = (): string => serializePage(alanPage());

/** Text with characters outside the basic plane, so a split can fall between the two halves of a surrogate pair. */
const PAIRS = "ink ✍️ 🖊️ 𝒜𝒝 and 😀😀😀 end";

/** A fixed sequence of numbers in [0, 1), so a failure names the same splits every run. */
function seeded(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The text cut at `n` points, in order; a cut may repeat, so empty parts occur too. */
function cut(text: string, n: number, seed: number): string[] {
	const rnd = seeded(seed);
	const at = Array.from({ length: n }, () => Math.floor(rnd() * (text.length + 1))).sort((a, b) => a - b);
	const parts: string[] = [];
	let from = 0;
	for (const i of at) {
		parts.push(text.slice(from, i));
		from = i;
	}
	parts.push(text.slice(from));
	return parts;
}

function streamed(parts: string[]): string {
	const stamp = beginContentStamp();
	for (const p of parts) stamp.push(p);
	return stamp.end();
}

describe("beginContentStamp gives contentStamp's value for any split of the text", () => {
	it("the alan-ink page text, whole and in one part", () => {
		const text = alanText();
		expect(text.length, "premise: the fixture is a big page").toBeGreaterThan(1_000_000);
		expect(streamed([text])).toBe(contentStamp(text));
	});

	it("an empty text, with no part and with one empty part", () => {
		expect(streamed([])).toBe(contentStamp(""));
		expect(streamed([""])).toBe(contentStamp(""));
	});

	it("text with surrogate pairs, cut at every position, inside a pair too", () => {
		const whole = contentStamp(PAIRS);
		const inside = [...PAIRS].findIndex((ch) => ch.length === 2);
		expect(inside, "premise: the text holds a pair").toBeGreaterThanOrEqual(0);
		for (let i = 0; i <= PAIRS.length; i++) {
			expect(streamed([PAIRS.slice(0, i), PAIRS.slice(i)]), `cut at ${i}`).toBe(whole);
		}
	});

	it("the alan-ink page text cut at 50 random points, by parts and by ranges of the one string", () => {
		const text = alanText();
		const whole = contentStamp(text);
		const parts = cut(text, 50, 0x5a7e);
		expect(parts.length).toBe(51);
		expect(parts.join("") === text, "premise: the parts rebuild the text").toBe(true);
		expect(streamed(parts)).toBe(whole);
		const ranges = beginContentStamp();
		let from = 0;
		for (const p of parts) {
			ranges.push(text, from, from + p.length);
			from += p.length;
		}
		expect(ranges.end()).toBe(whole);
	});
});

describe("contentStampSliced stamps the replaced file in slices, with the same value", () => {
	it("a slice of no time pauses between every chunk and still gives contentStamp's value", async () => {
		const text = alanText();
		let pauses = 0;
		const stamp = await contentStampSliced(text, async () => void pauses++, 0);
		expect(pauses, "premise: the text spans several chunks and every one paused").toBeGreaterThan(10);
		expect(stamp).toBe(contentStamp(text));
	});

	it("an empty text and a short one never pause", async () => {
		let pauses = 0;
		const pause = async (): Promise<void> => void pauses++;
		expect(await contentStampSliced("", pause, 0)).toBe(contentStamp(""));
		expect(await contentStampSliced(PAIRS, pause, 0)).toBe(contentStamp(PAIRS));
		expect(pauses).toBe(0);
	});
});

describe("serializePageSlicedStamped returns the stamp of the text it returns", () => {
	it("a slice of no time: serializePage's bytes and their contentStamp", async () => {
		const page = alanPage();
		let pauses = 0;
		const out = await serializePageSlicedStamped(page, async () => void pauses++, beginContentStamp, SCHEMA_VERSION, 0);
		expect(pauses, "premise: the serializer paused between strokes").toBeGreaterThan(10);
		expect(out.text === serializePage(page), "the text is serializePage's").toBe(true);
		expect(out.stamp).toBe(contentStamp(out.text));
	});

	it("a pass that starts over (a stroke moved in place during a pause) stamps the second pass only", async () => {
		const page = alanPage();
		let n = 0;
		const pause = async (): Promise<void> => {
			if (++n === 50) translateStroke(page.strokes[3]!, 40, 0);
		};
		const out = await serializePageSlicedStamped(page, pause, beginContentStamp, SCHEMA_VERSION, 0);
		expect(n, "premise: the pass started over").toBeGreaterThan(page.strokes.length);
		expect(out.text === serializePage(page), "the text is the moved page").toBe(true);
		expect(out.stamp).toBe(contentStamp(out.text));
	});

	it("a second move in place hands the page to serializePage, stamped whole", async () => {
		const page = alanPage();
		let n = 0;
		const pause = async (): Promise<void> => {
			n++;
			if (n === 50 || n === page.strokes.length + 60) translateStroke(page.strokes[3]!, 40, 0);
		};
		const out = await serializePageSlicedStamped(page, pause, beginContentStamp, SCHEMA_VERSION, 0);
		expect(out.text === serializePage(page), "the text is the twice-moved page").toBe(true);
		expect(out.stamp).toBe(contentStamp(out.text));
	});
});
