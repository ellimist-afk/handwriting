import { describe, expect, it } from "vitest";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { composeMarkdownPage, newPageMarkdown, parseMarkdownPage } from "./MarkdownPage";
import { emptyPage, parsePage, serializePage } from "./PageData";
import { joinPage } from "./PageJoin";
import { translateStroke } from "../objects/Selection";

/**
 * The end-to-end workflow, exercised at the layer that can be tested without
 * a browser: new page → type → write ink → move things → close → reopen.
 *
 * This does not prove the pen feels right or that the DOM behaves; it proves
 * the part that loses data if it is wrong. Every step below round-trips
 * through the real serialization the plugin writes to disk.
 */

function ink(id: string, at: [number, number]): InkStroke {
	const points = [
		{ x: at[0], y: at[1], pressure: 0.4, t: 0 },
		{ x: at[0] + 20, y: at[1] + 5, pressure: 0.5, t: 8 },
		{ x: at[0] + 35, y: at[1] - 4, pressure: 0.45, t: 16 },
	];
	return {
		id,
		tool: "pen",
		color: "#4b7bec",
		width: 2.2,
		points,
		bbox: computeBBox(points, 4.4),
		createdAt: 1700000000000,
	};
}

describe("end-to-end page workflow", () => {
	it("survives new page → text → ink → move → close → reopen", () => {
		// 1. New Handwriting page.
		const md0 = newPageMarkdown("page-uuid-1");
		const parsed0 = parseMarkdownPage(md0);
		expect(parsed0.isHandwritingPage).toBe(true);
		const page = emptyPage(parsed0.pageId!);

		// 2. Click and type: a container is created with text.
		page.textBoxes.push({ id: "tb-1", x: 120, y: 80, width: 320, z: 0 });
		const blocks = [{ id: "tb-1", text: "## Meeting\nTalked about [[LanMouse]] #orion" }];

		// 3. Write two strokes with the pen.
		page.strokes.push(ink("s-1", [200, 200]), ink("s-2", [400, 260]));

		// 4. Lasso one stroke and the text box, and drag them.
		translateStroke(page.strokes[0]!, 40, -15);
		page.textBoxes[0]!.x += 40;
		page.textBoxes[0]!.y -= 15;

		// 5. Close: markdown and sidecar are written.
		const savedMd = composeMarkdownPage({
			pageId: page.pageId,
			frontmatter: parsed0.frontmatter,
			blocks,
			extra: parsed0.extra,
		});
		const savedSidecar = serializePage(page);

		// 6. Reopen: read both back and join them.
		const reopened = parseMarkdownPage(savedMd);
		const sidecar = parsePage(savedSidecar, reopened.pageId!);
		expect(sidecar.recovered).toBe(false);
		const joined = joinPage(reopened.blocks, sidecar.data.textBoxes, {
			defaultWidth: 320,
		});

		// The page id is stable across the round trip — this is what keeps the
		// sidecar attached to the note through renames.
		expect(reopened.pageId).toBe("page-uuid-1");

		// Text survived, with its wiki link and tag intact.
		expect(joined.boxes).toHaveLength(1);
		expect(joined.boxes[0]!.text).toContain("[[LanMouse]]");
		expect(joined.boxes[0]!.text).toContain("#orion");

		// The move survived, on both the container and the ink.
		expect(joined.boxes[0]!.data.x).toBe(160);
		expect(joined.boxes[0]!.data.y).toBe(65);
		expect(sidecar.data.strokes[0]!.points[0]!.x).toBeCloseTo(240, 2);
		expect(sidecar.data.strokes[0]!.points[0]!.y).toBeCloseTo(185, 2);

		// Both strokes came back, with usable bounding boxes.
		expect(sidecar.data.strokes).toHaveLength(2);
		for (const s of sidecar.data.strokes) {
			expect(s.bbox.width).toBeGreaterThan(0);
			expect(s.points.length).toBeGreaterThanOrEqual(3);
		}
	});

	it("keeps the words when the sidecar is lost entirely", () => {
		// The failure mode that matters: geometry is disposable, text is not.
		const md = composeMarkdownPage({
			pageId: "page-2",
			blocks: [
				{ id: "tb-1", text: "first thought" },
				{ id: "tb-2", text: "second thought" },
			],
		});
		const reopened = parseMarkdownPage(md);
		const joined = joinPage(reopened.blocks, [], { defaultWidth: 320 });
		expect(joined.boxes.map((b) => b.text)).toEqual(["first thought", "second thought"]);
		expect(joined.orphanedText).toBe(2);
		// Laid out rather than stacked on top of each other.
		expect(joined.boxes[1]!.data.y).toBeGreaterThan(joined.boxes[0]!.data.y);
	});

	it("does not eat text a user typed in the markdown editor", () => {
		const md = [
			"---",
			"handwriting: page",
			"handwriting-page-id: page-3",
			"tags: [meeting]",
			"---",
			"",
			"<!-- handwriting:textbox id=tb-1 -->",
			"canvas text",
			"<!-- /handwriting:textbox -->",
			"",
			"A paragraph typed outside the canvas.",
		].join("\n");
		const parsed = parseMarkdownPage(md);
		const again = parseMarkdownPage(
			composeMarkdownPage({
				pageId: parsed.pageId!,
				frontmatter: parsed.frontmatter,
				blocks: parsed.blocks,
				extra: parsed.extra,
			})
		);
		expect(again.extra).toBe("A paragraph typed outside the canvas.");
		expect(again.frontmatter).toContain("tags: [meeting]");
		expect(again.blocks[0]!.text).toBe("canvas text");
	});
});
