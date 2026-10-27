/**
 * THE SAVE'S SLICED SERIALIZER WRITES SERIALIZEPAGE'S BYTES. On a big page the save stringified the whole page in one
 * task, 40 to 80 ms at 3000 strokes, and the next pen-down landed inside it. The save path now builds the same text a
 * few strokes at a time and pauses between slices (PageStore waits there for a lifted pen). What reaches the disk must
 * not change by a byte: every case here compares the sliced text with serializePage's, with a slice of no time at all,
 * so it pauses before every stroke and every join between two slices is exercised.
 */
import { describe, expect, it } from "vitest";
import { READ_SCHEMA_VERSION, SCHEMA_VERSION, parsePage, serializePage, serializePageSliced, type PageData } from "./PageData";
import { translateStroke } from "../objects/Selection";
import fixture from "../../test/render/fixtures/alan-ink-75d1627a.json";

/** A pause that only counts, and runs `then` at the pause numbered `at`. */
function counter(at = -1, then: () => void = () => {}) {
	const c = { n: 0, pause: async () => { if (c.n++ === at) then(); } };
	return c;
}

/** Every field the writer emits, and fields it does not know at the top and on each kind of object. */
function richPage(): PageData {
	const text = JSON.stringify({
		"0": "an integer-like key, which object key order puts first",
		future: { nested: [1, "two", null] },
		schemaVersion: 1,
		pageId: "p-rich",
		surface: "pdf",
		coordSpace: "page-css@1",
		pdfPaths: ["Folder/A file.pdf", "Other/B \"quoted\".pdf"],
		fontRefPx: 17.5,
		noteCanvas: true,
		textBoxes: [{ id: "t1", x: 1.234, y: 5.678, width: 300.111, z: 2, boxColor: "teal" }],
		images: [{ id: "i1", x: 10, y: 20.555, width: 100.004, height: 50, z: 1, crop: [0, 0, 1, 1] }],
		strokes: [
			{ id: "s1", tool: "pen", color: "#4b7bec", width: 2.2004, createdAt: 1, device: "mouse", widthMode: "uniform", pts: [0, 0, 0.5, 0, 10.129, 3.333, 0.5126, 8], layer: "top" },
			{ id: "s2", tool: "marker", color: "#ff0", width: 9, createdAt: 2, pressureProfile: "exp7", pressureSensitivity: "off", page: 3, pts: [1, 1, 1, 1] },
			{ id: "s3", tool: "highlighter", color: "rgba(1,2,3,0.4)", width: 12, createdAt: 3, pts: [5, 5, 0.1, 0, 6, 6, 0.2, 16, 7, 7, 0.3, 33] },
		],
		trailer: "an unknown key after the strokes",
	});
	const parsed = parsePage(text, "p-rich");
	expect(parsed.damaged, "precondition: the rich page parses whole").toBeFalsy();
	return parsed.data;
}

function alanPage(): PageData {
	return parsePage(JSON.stringify(fixture), (fixture as { pageId: string }).pageId).data;
}

describe("serializePageSliced writes serializePage's bytes", () => {
	for (const version of [SCHEMA_VERSION, READ_SCHEMA_VERSION]) {
		it(`Alan's ink fixture, schema ${version}, a pause before every stroke`, async () => {
			const page = alanPage();
			expect(page.strokes.length, "precondition: the fixture's strokes").toBeGreaterThan(1000);
			const c = counter();
			const sliced = await serializePageSliced(page, c.pause, version, 0);
			expect(c.n, "it paused before every stroke").toBe(page.strokes.length);
			expect(sliced === serializePage(page, version), "the sliced text differs from serializePage's").toBe(true);
		});

		it(`text boxes, images, pdfPaths and unknown fields, schema ${version}`, async () => {
			const page = richPage();
			page.deck = { width: 960.004, height: 700 };
			page.slides = [{ index: 0, hash: "h0" }, { index: 1, hash: "h1" }];
			const c = counter();
			const sliced = await serializePageSliced(page, c.pause, version, 0);
			expect(c.n).toBe(page.strokes.length);
			expect(sliced).toBe(serializePage(page, version));
		});
	}

	it("a page with no strokes, and a page with one", async () => {
		const page = richPage();
		for (const strokes of [[], page.strokes.slice(0, 1)]) {
			const p = { ...page, strokes };
			expect(await serializePageSliced(p, counter().pause, SCHEMA_VERSION, 0)).toBe(serializePage(p));
		}
	});

	it("a small page finishes inside one slice and never pauses", async () => {
		const c = counter();
		const page = richPage();
		expect(await serializePageSliced(page, c.pause)).toBe(serializePage(page));
		expect(c.n).toBe(0);
	});

	it("an unknown top field that holds the splice mark falls back to serializePage's text", async () => {
		const page = richPage();
		page.unknownTop = { ...page.unknownTop, odd: "\u0000handwriting strokes\u0000" };
		expect(await serializePageSliced(page, counter().pause, SCHEMA_VERSION, 0)).toBe(serializePage(page));
	});
});

describe("serializePageSliced writes one state of the page", () => {
	it("a stroke added during a pause is the next save's: the text is the list as it was", async () => {
		const page = alanPage();
		const before = serializePage(page);
		const extra = { ...page.strokes[0]!, id: "added-during-the-save" };
		const text = await serializePageSliced(page, counter(5, () => page.strokes.push(extra)).pause, SCHEMA_VERSION, 0);
		expect(text === before, "the text is not the page as it was when the save began").toBe(true);
	});

	it("a stroke already written that moves in place during a pause starts the pass over: the text is the moved page", async () => {
		const page = alanPage();
		const text = await serializePageSliced(page, counter(50, () => translateStroke(page.strokes[3]!, 40, 0)).pause, SCHEMA_VERSION, 0);
		expect(text === serializePage(page), "the text mixes the stroke before and after its move").toBe(true);
	});

	it("a second move in place writes the rest in one piece, still one state", async () => {
		const page = alanPage();
		let n = 0;
		const pause = async () => { n++; if (n === 50 || n === page.strokes.length + 60) translateStroke(page.strokes[3]!, 40, 0); };
		const text = await serializePageSliced(page, pause, SCHEMA_VERSION, 0);
		expect(text === serializePage(page), "the text mixes the stroke before and after its move").toBe(true);
	});
});
