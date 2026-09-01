import { describe, expect, it } from "vitest";
import { InkStroke } from "../ink/Stroke";
import {
	SCHEMA_VERSION,
	emptyPage,
	migratePageData,
	parsePage,
	serializePage,
} from "./PageData";
import {
	composeMarkdownPage,
	newPageMarkdown,
	parseMarkdownPage,
	updateFrontmatter,
} from "./MarkdownPage";
import { joinPage } from "./PageJoin";

function stroke(id: string): InkStroke {
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points: [
			{ x: 10.123456, y: 20.5, pressure: 0.4, t: 0 },
			{ x: 30, y: 40, pressure: 0.5, t: 8 },
		],
		bbox: { x: 0, y: 0, width: 0, height: 0 },
		createdAt: 1700000000000,
	};
}

describe("PageData serialization", () => {
	it("round-trips strokes and text boxes", () => {
		const page = emptyPage("page-1");
		page.strokes.push(stroke("s1"));
		page.textBoxes.push({ id: "tb-1", x: 100, y: 200, width: 320, z: 1 });

		const back = parsePage(serializePage(page), "page-1").data;
		expect(back.schemaVersion).toBe(SCHEMA_VERSION);
		expect(back.pageId).toBe("page-1");
		expect(back.textBoxes).toEqual(page.textBoxes);
		expect(back.strokes).toHaveLength(1);
		expect(back.strokes[0]!.points).toHaveLength(2);
		expect(back.strokes[0]!.points[0]!.x).toBeCloseTo(10.12, 2);
		expect(back.strokes[0]!.points[1]!.pressure).toBeCloseTo(0.5, 3);
	});

	it("recomputes bboxes on load rather than trusting the file", () => {
		const page = emptyPage("p");
		page.strokes.push(stroke("s1"));
		const back = parsePage(serializePage(page), "p").data;
		const b = back.strokes[0]!.bbox;
		// Points span (10,20)–(30,40) padded by width*2.
		expect(b.x).toBeLessThan(10);
		expect(b.width).toBeGreaterThan(20);
	});

	it("survives a corrupt sidecar instead of throwing", () => {
		const r = parsePage("{not json", "p9");
		expect(r.recovered).toBe(true);
		expect(r.data.pageId).toBe("p9");
		expect(r.data.strokes).toEqual([]);
	});

	it("drops junk entries but keeps good ones", () => {
		const raw = {
			pageId: "p",
			textBoxes: [{ id: "ok", x: 1, y: 2 }, { x: 3, y: 4 }, null],
			strokes: [
				{ id: "s-ok", pts: [0, 0, 0.5, 0, 5, 5, 0.5, 4] },
				{ id: "s-empty", pts: [] },
				{ pts: [1, 1, 1, 1] },
			],
		};
		const data = migratePageData(raw, "p");
		expect(data.textBoxes.map((b) => b.id)).toEqual(["ok"]);
		expect(data.textBoxes[0]!.width).toBe(320); // defaulted
		expect(data.strokes.map((s) => s.id)).toEqual(["s-ok"]);
	});

	it("accepts unpacked point objects too", () => {
		const data = migratePageData(
			{ pageId: "p", strokes: [{ id: "s", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }] },
			"p"
		);
		expect(data.strokes[0]!.points).toHaveLength(2);
		expect(data.strokes[0]!.points[0]!.pressure).toBe(0.5);
	});

	it("treats a non-object as an empty page", () => {
		expect(migratePageData(null, "p").strokes).toEqual([]);
		expect(migratePageData(42, "p").textBoxes).toEqual([]);
	});
});

describe("joinPage", () => {
	const opts = { defaultWidth: 320 };

	it("pairs blocks with their geometry and keeps order", () => {
		const r = joinPage(
			[
				{ id: "a", text: "first" },
				{ id: "b", text: "second" },
			],
			[
				{ id: "b", x: 5, y: 6, width: 200, z: 1 },
				{ id: "a", x: 1, y: 2, width: 100, z: 0 },
			],
			opts
		);
		expect(r.boxes.map((b) => b.data.id)).toEqual(["a", "b"]);
		expect(r.boxes[0]!.data.x).toBe(1);
		expect(r.boxes[1]!.text).toBe("second");
		expect(r.orphanedText).toBe(0);
		expect(r.droppedGeometry).toBe(0);
	});

	it("keeps text that has no geometry, stacking it", () => {
		const r = joinPage(
			[
				{ id: "a", text: "kept" },
				{ id: "b", text: "also kept" },
			],
			[],
			opts
		);
		expect(r.boxes).toHaveLength(2);
		expect(r.boxes.map((b) => b.text)).toEqual(["kept", "also kept"]);
		expect(r.boxes[1]!.data.y).toBeGreaterThan(r.boxes[0]!.data.y);
		expect(r.orphanedText).toBe(2);
	});

	it("drops geometry that has no text", () => {
		const r = joinPage([], [{ id: "ghost", x: 0, y: 0, width: 10, z: 0 }], opts);
		expect(r.boxes).toEqual([]);
		expect(r.droppedGeometry).toBe(1);
	});

	it("does not mutate the geometry it was given", () => {
		const geo = [{ id: "a", x: 1, y: 2, width: 100, z: 0 }];
		const r = joinPage([{ id: "a", text: "t" }], geo, opts);
		r.boxes[0]!.data.x = 999;
		expect(geo[0]!.x).toBe(1);
	});
});

describe("MarkdownPage", () => {
	it("round-trips blocks", () => {
		const md = composeMarkdownPage({
			pageId: "pid",
			blocks: [
				{ id: "tb-1", text: "## Meeting\nTalked about [[LanMouse]]." },
				{ id: "tb-2", text: "second" },
			],
		});
		const parsed = parseMarkdownPage(md);
		// Composing does not invent the marker: it is a view preference the user
		// sets, not a stamp Handwriting applies to files it writes.
		expect(parsed.isHandwritingPage).toBe(false);
		expect(parsed.pageId).toBe("pid");
		expect(parsed.blocks).toEqual([
			{ id: "tb-1", text: "## Meeting\nTalked about [[LanMouse]]." },
			{ id: "tb-2", text: "second" },
		]);
	});

	it("preserves a marker the user already has, and New page sets one", () => {
		const kept = composeMarkdownPage({
			pageId: "pid",
			frontmatter: ["handwriting: page"],
			blocks: [],
		});
		expect(parseMarkdownPage(kept).isHandwritingPage).toBe(true);
		expect(parseMarkdownPage(newPageMarkdown("pid")).isHandwritingPage).toBe(true);
	});

	it("keeps the user's own frontmatter keys", () => {
		const fm = updateFrontmatter(["tags: [a, b]", "handwriting-page-id: old"], "new-id");
		expect(fm).toContain("tags: [a, b]");
		expect(fm).toContain("handwriting-page-id: new-id");
		expect(fm.filter((l) => l.startsWith("handwriting-page-id"))).toHaveLength(1);
	});

	it("preserves body content that is not ours", () => {
		const md = [
			"---",
			"handwriting: page",
			"handwriting-page-id: pid",
			"---",
			"",
			"<!-- handwriting:textbox id=tb-1 -->",
			"hello",
			"<!-- /handwriting:textbox -->",
			"",
			"A stray paragraph a user typed in the markdown editor.",
			"",
		].join("\n");
		const parsed = parseMarkdownPage(md);
		expect(parsed.blocks).toHaveLength(1);
		expect(parsed.extra).toBe("A stray paragraph a user typed in the markdown editor.");

		const again = parseMarkdownPage(
			composeMarkdownPage({
				pageId: "pid",
				frontmatter: parsed.frontmatter,
				blocks: parsed.blocks,
				extra: parsed.extra,
			})
		);
		expect(again.extra).toBe(parsed.extra);
		expect(again.blocks).toEqual(parsed.blocks);
	});

	it("recovers text from an unterminated block", () => {
		const md = ["<!-- handwriting:textbox id=tb-9 -->", "orphaned text"].join("\n");
		expect(parseMarkdownPage(md).blocks).toEqual([{ id: "tb-9", text: "orphaned text" }]);
	});

	it("does not claim ordinary notes", () => {
		const parsed = parseMarkdownPage("# Just a note\n\nSome text.");
		expect(parsed.isHandwritingPage).toBe(false);
		expect(parsed.pageId).toBeUndefined();
		expect(parsed.extra).toBe("# Just a note\n\nSome text.");
	});

	it("creates a valid empty page", () => {
		const parsed = parseMarkdownPage(newPageMarkdown("abc"));
		expect(parsed.isHandwritingPage).toBe(true);
		expect(parsed.pageId).toBe("abc");
		expect(parsed.blocks).toEqual([]);
	});

	it("handles CRLF input", () => {
		const md = "---\r\nhandwriting: page\r\n---\r\n\r\n<!-- handwriting:textbox id=t -->\r\nhi\r\n<!-- /handwriting:textbox -->";
		const parsed = parseMarkdownPage(md);
		expect(parsed.isHandwritingPage).toBe(true);
		expect(parsed.blocks).toEqual([{ id: "t", text: "hi" }]);
	});
});

describe("images in the sidecar", () => {
	it("round-trips geometry and never carries the picture itself", () => {
		const page = emptyPage("p1");
		page.images.push({ id: "im-1", x: 10.5, y: 20.25, width: 400, height: 300, z: 2 });
		const json = serializePage(page);
		// The bytes belong to the vault. Nothing image-shaped should be inlined.
		expect(json).not.toMatch(/base64|data:image/);
		expect(json).not.toContain("cat.png");

		const back = parsePage(json, "p1").data;
		expect(back.images).toEqual([
			{ id: "im-1", x: 10.5, y: 20.25, width: 400, height: 300, z: 2 },
		]);
	});

	it("defaults missing dimensions and drops entries with no position", () => {
		const data = migratePageData(
			{
				pageId: "p",
				images: [{ id: "ok", x: 1, y: 2 }, { id: "nowhere" }, null],
			},
			"p"
		);
		expect(data.images.map((i) => i.id)).toEqual(["ok"]);
		expect(data.images[0]!.width).toBe(320);
		expect(data.images[0]!.height).toBe(240);
	});
});

describe("forward compatibility", () => {
	it("preserves top-level fields written by a newer Handwriting", () => {
		// Two plugin versions can be live in one synced vault. An older build
		// that drops what it doesn't understand silently destroys the newer
		// build's data on its first save.
		const raw = JSON.stringify({
			schemaVersion: 1,
			pageId: "p1",
			textBoxes: [],
			strokes: [],
			shapes: [{ id: "sh-1", kind: "arrow" }],
			recognition: { engine: "v2" },
		});
		const back = JSON.parse(serializePage(parsePage(raw, "p1").data)) as Record<string, unknown>;
		expect(back.shapes).toEqual([{ id: "sh-1", kind: "arrow" }]);
		expect(back.recognition).toEqual({ engine: "v2" });
	});

	it("preserves unknown per-stroke and per-box fields", () => {
		const raw = JSON.stringify({
			schemaVersion: 1,
			pageId: "p1",
			textBoxes: [{ id: "b1", x: 1, y: 2, width: 100, z: 0, locked: true }],
			strokes: [
				{ id: "s1", pts: [0, 0, 0.5, 0, 5, 5, 0.5, 4], recognizedText: "hello", layer: 3 },
			],
		});
		const back = JSON.parse(serializePage(parsePage(raw, "p1").data)) as {
			textBoxes: Array<Record<string, unknown>>;
			strokes: Array<Record<string, unknown>>;
		};
		expect(back.textBoxes[0]!.locked).toBe(true);
		expect(back.strokes[0]!.recognizedText).toBe("hello");
		expect(back.strokes[0]!.layer).toBe(3);
		// ...without disturbing the fields we do own.
		expect(back.strokes[0]!.id).toBe("s1");
		expect(back.textBoxes[0]!.x).toBe(1);
	});

	it("never lets a preserved field shadow one we own", () => {
		const raw = JSON.stringify({
			schemaVersion: 99,
			pageId: "p1",
			textBoxes: [],
			strokes: [],
		});
		const parsed = parsePage(raw, "p1");
		const back = JSON.parse(serializePage(parsed.data)) as Record<string, unknown>;
		expect(back.schemaVersion).toBe(SCHEMA_VERSION);
	});

	it("flags a sidecar from a newer schema so the caller can go read-only", () => {
		const raw = JSON.stringify({ schemaVersion: 7, pageId: "p1", textBoxes: [], strokes: [] });
		const parsed = parsePage(raw, "p1");
		expect(parsed.futureVersion).toBe(7);
		// It still loads what it recognises — read-only, not blank.
		expect(parsed.recovered).toBe(false);
	});

	it("does not flag the current or an older schema", () => {
		for (const v of [undefined, 1]) {
			const raw = JSON.stringify({ schemaVersion: v, pageId: "p", textBoxes: [], strokes: [] });
			expect(parsePage(raw, "p").futureVersion).toBeUndefined();
		}
	});
});

describe("duplicate block ids (content preservation)", () => {
	const wrap = (body: string[]) =>
		["---", "handwriting: page", "handwriting-page-id: p1", "---", "", ...body].join("\n");

	it("keeps BOTH images when two blocks share an id", () => {
		// Before this was fixed, the later embed won and was written back into
		// both blocks: the user's link to cat.png was destroyed in their own
		// file. Copying a block is the ordinary way to hit this.
		const parsed = parseMarkdownPage(
			wrap([
				"<!-- handwriting:image id=im-1 -->",
				"![[cat.png]]",
				"<!-- /handwriting:image -->",
				"",
				"<!-- handwriting:image id=im-1 -->",
				"![[dog.png]]",
				"<!-- /handwriting:image -->",
			])
		);
		expect(parsed.images).toHaveLength(2);
		expect(parsed.images[0]!.id).not.toBe(parsed.images[1]!.id);
		expect(parsed.images.map((i) => i.target)).toEqual(["cat.png", "dog.png"]);
	});

	it("keeps BOTH texts when two containers share an id", () => {
		const parsed = parseMarkdownPage(
			wrap([
				"<!-- handwriting:textbox id=tb-1 -->",
				"FIRST",
				"<!-- /handwriting:textbox -->",
				"",
				"<!-- handwriting:textbox id=tb-1 -->",
				"SECOND",
				"<!-- /handwriting:textbox -->",
			])
		);
		expect(parsed.blocks.map((b) => b.text)).toEqual(["FIRST", "SECOND"]);
		expect(parsed.blocks[0]!.id).not.toBe(parsed.blocks[1]!.id);
	});

	it("keeps ids unique across block TYPES, since the sidecar shares the keyspace", () => {
		const parsed = parseMarkdownPage(
			wrap([
				"<!-- handwriting:textbox id=dup -->",
				"words",
				"<!-- /handwriting:textbox -->",
				"",
				"<!-- handwriting:image id=dup -->",
				"![[cat.png]]",
				"<!-- /handwriting:image -->",
			])
		);
		expect(parsed.blocks[0]!.id).not.toBe(parsed.images[0]!.id);
	});

	it("handles three or more collisions", () => {
		const parsed = parseMarkdownPage(
			wrap(
				["a", "b", "c"].flatMap((t) => [
					"<!-- handwriting:textbox id=tb-1 -->",
					t,
					"<!-- /handwriting:textbox -->",
					"",
				])
			)
		);
		expect(parsed.blocks.map((b) => b.text)).toEqual(["a", "b", "c"]);
		expect(new Set(parsed.blocks.map((b) => b.id)).size).toBe(3);
	});

	it("leaves ordinary unique ids exactly as written", () => {
		const parsed = parseMarkdownPage(
			wrap([
				"<!-- handwriting:textbox id=tb-1 -->",
				"one",
				"<!-- /handwriting:textbox -->",
				"",
				"<!-- handwriting:textbox id=tb-2 -->",
				"two",
				"<!-- /handwriting:textbox -->",
			])
		);
		expect(parsed.blocks.map((b) => b.id)).toEqual(["tb-1", "tb-2"]);
	});

	it("round-trips a de-duplicated page without losing anything", () => {
		const parsed = parseMarkdownPage(
			wrap([
				"<!-- handwriting:image id=im-1 -->",
				"![[cat.png]]",
				"<!-- /handwriting:image -->",
				"",
				"<!-- handwriting:image id=im-1 -->",
				"![[dog.png]]",
				"<!-- /handwriting:image -->",
			])
		);
		const again = parseMarkdownPage(
			composeMarkdownPage({
				pageId: "p1",
				frontmatter: parsed.frontmatter,
				blocks: parsed.blocks,
				images: parsed.images,
			})
		);
		expect(again.images.map((i) => i.target)).toEqual(["cat.png", "dog.png"]);
		// The renamed id is now settled in the file, so it is stable from here.
		expect(again.images.map((i) => i.id)).toEqual(parsed.images.map((i) => i.id));
	});
});

describe("the pdf surface round-trips", () => {
	// A persistence change that does not survive save-and-load is silent data
	// loss: the ink is drawn, the file is written, and the page number is gone
	// by the time anyone reopens it.
	function pdfPage() {
		const page = emptyPage("pdf-abc123");
		page.surface = "pdf";
		page.strokes = [
			{ ...stroke("s1"), page: 1 },
			{ ...stroke("s2"), page: 50 },
		];
		return page;
	}

	it("keeps the surface and every stroke's page", () => {
		const back = parsePage(serializePage(pdfPage()), "pdf-abc123").data;
		expect(back.surface).toBe("pdf");
		expect(back.strokes.map((s) => s.page)).toEqual([1, 50]);
	});

	it("leaves note strokes without a page, rather than inventing one", () => {
		// The note surface has no pages. A default of 1 would make every note
		// stroke look like a pdf stroke to anything that switches on it.
		const page = emptyPage("note");
		page.strokes = [stroke("s1")];
		const back = parsePage(serializePage(page), "note").data;
		expect(back.surface).toBeUndefined();
		expect(back.strokes[0]!.page).toBeUndefined();
	});

	it("records which coordinate convention it was written in", () => {
		// Both conventions produce plausible numbers, so a file that does not
		// say cannot be told apart later. The stamp is what would make a future
		// migration safe rather than a guess.
		const page = pdfPage();
		page.coordSpace = "page-css@1";
		const back = parsePage(serializePage(page), "pdf-abc123").data;
		expect(back.coordSpace).toBe("page-css@1");
	});

	it("drops a page number that is not a page", () => {
		const raw = JSON.parse(serializePage(pdfPage()));
		raw.strokes[0].page = 0;
		raw.strokes[1].page = "50";
		const back = parsePage(JSON.stringify(raw), "pdf-abc123").data;
		expect(back.strokes.every((s) => s.page === undefined)).toBe(true);
	});
});
