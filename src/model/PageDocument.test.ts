import { describe, expect, it } from "vitest";
import { PageDocument } from "./PageDocument";
import { parseMarkdownPage } from "./MarkdownPage";
import { emptyPage, parsePage, serializePage } from "./PageData";
import { moveObjects } from "../objects/ObjectOps";

const WIDTH = 320;

/** A document holding two containers, as if freshly opened. */
function loaded(): PageDocument {
	const doc = new PageDocument();
	const md = [
		"---",
		"handwriting: page",
		"handwriting-version: 1",
		"handwriting-page-id: p1",
		"tags: [meeting]",
		"---",
		"",
		"<!-- handwriting:textbox id=tb-1 -->",
		"first",
		"<!-- /handwriting:textbox -->",
		"",
		"<!-- handwriting:textbox id=tb-2 -->",
		"second",
		"<!-- /handwriting:textbox -->",
		"",
		"loose paragraph",
	].join("\n");
	const parsed = doc.loadMarkdown(md);
	const sidecar = emptyPage("p1");
	sidecar.textBoxes.push(
		{ id: "tb-1", x: 10, y: 10, width: WIDTH, z: 0 },
		{ id: "tb-2", x: 10, y: 200, width: WIDTH, z: 1 }
	);
	doc.applySidecar(sidecar, parsed.blocks, parsed.images, WIDTH);
	return doc;
}

/** Rewrite of the same page as another window/device would leave it. */
function external(blocks: Array<[string, string]>, extra = "loose paragraph"): string {
	const parts = ["---", "handwriting: page", "handwriting-version: 1", "handwriting-page-id: p1", "tags: [meeting]", "---", ""];
	for (const [id, text] of blocks) {
		parts.push(`<!-- handwriting:textbox id=${id} -->`, text, "<!-- /handwriting:textbox -->", "");
	}
	if (extra) parts.push(extra, "");
	return parts.join("\n");
}

describe("PageDocument load", () => {
	it("joins text with geometry and keeps both", () => {
		const doc = loaded();
		expect(doc.boxes.map((b) => b.text)).toEqual(["first", "second"]);
		expect(doc.boxes[0]!.data.x).toBe(10);
		expect(doc.pageId).toBe("p1");
	});

	it("round-trips to markdown without losing the user's frontmatter or body", () => {
		const doc = loaded();
		const parsed = parseMarkdownPage(doc.compose());
		expect(parsed.frontmatter).toContain("tags: [meeting]");
		expect(parsed.extra).toBe("loose paragraph");
		expect(parsed.blocks.map((b) => b.text)).toEqual(["first", "second"]);
	});

	it("invents a page id when the file has none", () => {
		const doc = new PageDocument();
		const parsed = doc.loadMarkdown("---\nhandwriting: page\n---\n");
		expect(parsed.generatedId).toBe(true);
		expect(doc.pageId.length).toBeGreaterThan(0);
	});
});

describe("PageDocument.reconcile — the clobber bug", () => {
	it("ADOPTS a container added externally, and composes it back out", () => {
		// The regression: the old code only refreshed containers it already
		// knew, so an externally added one was dropped from the next save.
		const doc = loaded();
		const result = doc.reconcile(
			external([
				["tb-1", "first"],
				["tb-2", "second"],
				["tb-3", "added on the other machine"],
			]),
			{ defaultWidth: WIDTH }
		);

		expect(result.added.map((b) => b.data.id)).toEqual(["tb-3"]);
		expect(doc.textOf("tb-3")).toBe("added on the other machine");

		// The decisive assertion: what we would write to disk still contains it.
		const written = parseMarkdownPage(doc.compose());
		expect(written.blocks.map((b) => b.id)).toEqual(["tb-1", "tb-2", "tb-3"]);
		expect(written.blocks[2]!.text).toBe("added on the other machine");
	});

	it("gives an adopted container real geometry so it is visible", () => {
		const doc = loaded();
		doc.reconcile(external([["tb-1", "first"], ["tb-2", "second"], ["tb-3", "new"]]), {
			defaultWidth: WIDTH,
		});
		const box = doc.boxes.find((b) => b.data.id === "tb-3")!;
		expect(box.data.width).toBe(WIDTH);
		// Placed clear of what is already on the page, not stacked at the origin.
		expect(box.data.y).toBeGreaterThan(200);
	});

	it("DROPS a container deleted externally instead of resurrecting it", () => {
		const doc = loaded();
		const result = doc.reconcile(external([["tb-1", "first"]]), { defaultWidth: WIDTH });
		expect(result.removed).toEqual(["tb-2"]);
		expect(doc.hasBox("tb-2")).toBe(false);
		// Geometry goes with it — no invisible orphan box.
		expect(doc.page.textBoxes.map((b) => b.id)).toEqual(["tb-1"]);
		expect(parseMarkdownPage(doc.compose()).blocks.map((b) => b.id)).toEqual(["tb-1"]);
	});

	it("takes externally edited text", () => {
		const doc = loaded();
		const result = doc.reconcile(
			external([["tb-1", "edited elsewhere"], ["tb-2", "second"]]),
			{ defaultWidth: WIDTH }
		);
		expect(result.changed.map((c) => c.data.id)).toEqual(["tb-1"]);
		expect(doc.textOf("tb-1")).toBe("edited elsewhere");
	});

	it("takes external frontmatter and loose body changes", () => {
		const doc = loaded();
		const md = external([["tb-1", "first"], ["tb-2", "second"]], "rewritten paragraph")
			.replace("tags: [meeting]", "tags: [meeting, urgent]");
		const result = doc.reconcile(md, { defaultWidth: WIDTH });
		expect(result.frontmatterChanged).toBe(true);
		expect(result.extraChanged).toBe(true);
		expect(doc.extra).toBe("rewritten paragraph");
		expect(parseMarkdownPage(doc.compose()).frontmatter).toContain("tags: [meeting, urgent]");
	});

	it("leaves the container being typed in alone, but still reconciles the others", () => {
		const doc = loaded();
		doc.setText("tb-1", "half-typed word");
		const result = doc.reconcile(
			external([
				["tb-1", "stale text from disk"],
				["tb-2", "second edited"],
				["tb-3", "added"],
			]),
			{ editingId: "tb-1", defaultWidth: WIDTH }
		);
		expect(result.skipped).toContain("tb-1");
		expect(doc.textOf("tb-1")).toBe("half-typed word");
		expect(doc.textOf("tb-2")).toBe("second edited");
		expect(doc.hasBox("tb-3")).toBe(true);
	});

	it("does not delete the container being typed in, even if the file lost it", () => {
		const doc = loaded();
		const result = doc.reconcile(external([["tb-2", "second"]]), {
			editingId: "tb-1",
			defaultWidth: WIDTH,
		});
		expect(result.skipped).toContain("tb-1");
		expect(doc.hasBox("tb-1")).toBe(true);
	});

	it("reports clean when the file matches what we hold", () => {
		const doc = loaded();
		const result = doc.reconcile(external([["tb-1", "first"], ["tb-2", "second"]]), {
			defaultWidth: WIDTH,
		});
		expect(result.dirty).toBe(false);
		expect(result.added).toEqual([]);
		expect(result.removed).toEqual([]);
		expect(result.changed).toEqual([]);
	});

	it("survives the file being emptied of containers", () => {
		const doc = loaded();
		const result = doc.reconcile(external([], "just prose now"), { defaultWidth: WIDTH });
		expect(result.removed.sort()).toEqual(["tb-1", "tb-2"]);
		expect(doc.boxes).toEqual([]);
		expect(doc.extra).toBe("just prose now");
	});

	it("keeps ink untouched — external text edits never disturb strokes", () => {
		const doc = loaded();
		doc.page.strokes.push({
			id: "s1",
			tool: "pen",
			color: "#000",
			width: 2,
			points: [{ x: 1, y: 2, pressure: 0.5, t: 0 }],
			bbox: { x: 0, y: 0, width: 2, height: 2 },
			createdAt: 0,
		});
		doc.reconcile(external([["tb-1", "changed"]]), { defaultWidth: WIDTH });
		expect(doc.strokes).toHaveLength(1);
		expect(doc.strokes[0]!.points[0]).toMatchObject({ x: 1, y: 2 });
	});
});

describe("PageDocument write gating", () => {
	it("refuses markdown writes when the file declares a newer format", () => {
		const doc = new PageDocument();
		doc.loadMarkdown("---\nhandwriting: page\nhandwriting-version: 99\nhandwriting-page-id: p9\n---\n");
		expect(doc.markdownWritable).toBe(false);
		expect(doc.markdownFutureVersion).toBe(99);
	});

	it("allows writes at the current version", () => {
		const doc = loaded();
		expect(doc.markdownWritable).toBe(true);
		expect(doc.spatialWritable).toBe(true);
	});
});

describe("images", () => {
	/** Markdown for a page holding one text container and one image. */
	function withImage(target = "attachments/cat.png"): string {
		return [
			"---",
			"handwriting: page",
			"handwriting-version: 1",
			"handwriting-page-id: p1",
			"---",
			"",
			"<!-- handwriting:textbox id=tb-1 -->",
			"first",
			"<!-- /handwriting:textbox -->",
			"",
			"<!-- handwriting:image id=im-1 -->",
			`![[${target}]]`,
			"<!-- /handwriting:image -->",
			"",
		].join("\n");
	}

	function loadedWithImage(): PageDocument {
		const doc = new PageDocument();
		const parsed = doc.loadMarkdown(withImage());
		const sidecar = emptyPage("p1");
		sidecar.textBoxes.push({ id: "tb-1", x: 10, y: 10, width: WIDTH, z: 0 });
		sidecar.images.push({ id: "im-1", x: 100, y: 200, width: 400, height: 300, z: 1 });
		doc.applySidecar(sidecar, parsed.blocks, parsed.images, WIDTH);
		return doc;
	}

	it("keeps the attachment path in the Markdown and the geometry in the sidecar", () => {
		const doc = loadedWithImage();
		expect(doc.targetOf("im-1")).toBe("attachments/cat.png");
		expect(doc.imageData("im-1")).toMatchObject({ x: 100, y: 200, width: 400, height: 300 });
		// The sidecar half carries no path at all.
		expect(JSON.stringify(doc.page.images)).not.toContain("cat.png");
	});

	it("round-trips the embed so Obsidian still sees the attachment as used", () => {
		const doc = loadedWithImage();
		const composed = doc.compose();
		expect(composed).toContain("![[attachments/cat.png]]");
		const reparsed = parseMarkdownPage(composed);
		expect(reparsed.images).toEqual([{ id: "im-1", target: "attachments/cat.png" }]);
		expect(reparsed.blocks.map((b) => b.id)).toEqual(["tb-1"]);
	});

	it("follows a rename Obsidian made to the embed", () => {
		// Obsidian rewrites ![[...]] when an attachment moves. Because the path
		// lives there and not in our sidecar, we inherit that for free.
		const doc = loadedWithImage();
		doc.reconcile(withImage("images/renamed cat.png"), { defaultWidth: WIDTH });
		expect(doc.targetOf("im-1")).toBe("images/renamed cat.png");
		// Geometry is untouched by the rename.
		expect(doc.imageData("im-1")).toMatchObject({ x: 100, y: 200 });
	});

	it("adopts an image added externally and drops one removed externally", () => {
		const doc = loadedWithImage();
		const twoImages = withImage().replace(
			"<!-- /handwriting:image -->",
			"<!-- /handwriting:image -->\n\n<!-- handwriting:image id=im-2 -->\n![[b.png]]\n<!-- /handwriting:image -->"
		);
		const added = doc.reconcile(twoImages, { defaultWidth: WIDTH });
		expect(added.addedImages.map((i) => i.data.id)).toEqual(["im-2"]);
		expect(added.dirty).toBe(true);

		const removed = doc.reconcile(withImage(), { defaultWidth: WIDTH });
		expect(removed.removedImages).toEqual(["im-2"]);
		expect(doc.hasImage("im-2")).toBe(false);
	});

	it("keeps an image whose geometry was lost, inventing a position", () => {
		const doc = new PageDocument();
		const parsed = doc.loadMarkdown(withImage());
		doc.applySidecar(undefined, parsed.blocks, parsed.images, WIDTH);
		expect(doc.hasImage("im-1")).toBe(true);
		expect(doc.imageData("im-1")!.width).toBe(WIDTH);
	});

	it("drops geometry for an image the Markdown no longer embeds", () => {
		const doc = new PageDocument();
		const parsed = doc.loadMarkdown(withImage());
		const sidecar = emptyPage("p1");
		sidecar.images.push(
			{ id: "im-1", x: 0, y: 0, width: 100, height: 100, z: 0 },
			{ id: "ghost", x: 0, y: 0, width: 100, height: 100, z: 1 }
		);
		doc.applySidecar(sidecar, parsed.blocks, parsed.images, WIDTH);
		expect(doc.page.images.map((i) => i.id)).toEqual(["im-1"]);
	});

	it("leaves an unreadable image block in the file rather than eating it", () => {
		const doc = new PageDocument();
		const md = [
			"---",
			"handwriting: page",
			"handwriting-page-id: p1",
			"---",
			"",
			"<!-- handwriting:image id=im-9 -->",
			"this block has no embed",
			"<!-- /handwriting:image -->",
		].join("\n");
		const parsed = doc.loadMarkdown(md);
		expect(parsed.images).toEqual([]);
		expect(doc.extra).toContain("this block has no embed");
	});
});

describe("image identity is independent of the attachment path", () => {
	/** Two placements of the SAME attachment, plus one of another. */
	function twoInstances(target = "attachments/cat.png"): string {
		return [
			"---",
			"handwriting: page",
			"handwriting-version: 1",
			"handwriting-page-id: p1",
			"---",
			"",
			"<!-- handwriting:image id=im-a -->",
			`![[${target}]]`,
			"<!-- /handwriting:image -->",
			"",
			"<!-- handwriting:image id=im-b -->",
			`![[${target}]]`,
			"<!-- /handwriting:image -->",
			"",
			"<!-- handwriting:image id=im-c -->",
			"![[attachments/dog.png]]",
			"<!-- /handwriting:image -->",
			"",
		].join("\n");
	}

	function loadedTwo(): PageDocument {
		const doc = new PageDocument();
		const parsed = doc.loadMarkdown(twoInstances());
		const sidecar = emptyPage("p1");
		sidecar.images.push(
			{ id: "im-a", x: 0, y: 0, width: 200, height: 150, z: 0 },
			{ id: "im-b", x: 900, y: 800, width: 50, height: 40, z: 1 },
			{ id: "im-c", x: 400, y: 400, width: 100, height: 100, z: 2 }
		);
		doc.applySidecar(sidecar, parsed.blocks, parsed.images, WIDTH);
		return doc;
	}

	it("gives two placements of one attachment separate identity and geometry", () => {
		const doc = loadedTwo();
		expect(doc.page.images.map((i) => i.id)).toEqual(["im-a", "im-b", "im-c"]);
		// Same picture, different places and sizes — nothing collapses them.
		expect(doc.targetOf("im-a")).toBe("attachments/cat.png");
		expect(doc.targetOf("im-b")).toBe("attachments/cat.png");
		expect(doc.imageData("im-a")).toMatchObject({ x: 0, y: 0, width: 200 });
		expect(doc.imageData("im-b")).toMatchObject({ x: 900, y: 800, width: 50 });
	});

	it("moves one instance without touching the other", () => {
		const doc = loadedTwo();
		moveObjects(doc.page, { strokeIds: [], boxIds: [], imageIds: ["im-a"] }, 25, -10);
		expect(doc.imageData("im-a")).toMatchObject({ x: 25, y: -10 });
		expect(doc.imageData("im-b")).toMatchObject({ x: 900, y: 800 });
	});

	it("deletes one instance and leaves the other", () => {
		const doc = loadedTwo();
		doc.removeImage("im-a");
		expect(doc.hasImage("im-a")).toBe(false);
		expect(doc.hasImage("im-b")).toBe(true);
		expect(doc.targetOf("im-b")).toBe("attachments/cat.png");
		// The surviving instance still round-trips its embed.
		expect(doc.compose()).toContain("![[attachments/cat.png]]");
	});

	it("survives a rename that hits BOTH instances, keeping ids and geometry", () => {
		// Obsidian rewrites every embed pointing at the renamed file.
		const doc = loadedTwo();
		doc.reconcile(twoInstances("images/renamed cat.png"), { defaultWidth: WIDTH });
		expect(doc.targetOf("im-a")).toBe("images/renamed cat.png");
		expect(doc.targetOf("im-b")).toBe("images/renamed cat.png");
		// Identity and arrangement are untouched by a path change.
		expect(doc.page.images.map((i) => i.id)).toEqual(["im-a", "im-b", "im-c"]);
		expect(doc.imageData("im-a")).toMatchObject({ x: 0, y: 0, width: 200 });
		expect(doc.imageData("im-b")).toMatchObject({ x: 900, y: 800, width: 50 });
		// The unrelated image is not disturbed.
		expect(doc.targetOf("im-c")).toBe("attachments/dog.png");
	});

	it("keeps geometry attached to the right instance when blocks are reordered", () => {
		const doc = loadedTwo();
		const reordered = [
			"---",
			"handwriting: page",
			"handwriting-version: 1",
			"handwriting-page-id: p1",
			"---",
			"",
			"<!-- handwriting:image id=im-c -->",
			"![[attachments/dog.png]]",
			"<!-- /handwriting:image -->",
			"",
			"<!-- handwriting:image id=im-b -->",
			"![[attachments/cat.png]]",
			"<!-- /handwriting:image -->",
			"",
			"<!-- handwriting:image id=im-a -->",
			"![[attachments/cat.png]]",
			"<!-- /handwriting:image -->",
			"",
		].join("\n");
		doc.reconcile(reordered, { defaultWidth: WIDTH });
		// Order in the file changed; who is where did not.
		expect(doc.imageData("im-a")).toMatchObject({ x: 0, y: 0 });
		expect(doc.imageData("im-b")).toMatchObject({ x: 900, y: 800 });
		expect(doc.imageData("im-c")).toMatchObject({ x: 400, y: 400 });
	});

	it("adds a second instance of an existing attachment without disturbing the first", () => {
		const doc = new PageDocument();
		const first = [
			"---",
			"handwriting: page",
			"handwriting-page-id: p1",
			"---",
			"",
			"<!-- handwriting:image id=im-a -->",
			"![[attachments/cat.png]]",
			"<!-- /handwriting:image -->",
			"",
		].join("\n");
		const parsed = doc.loadMarkdown(first);
		const sidecar = emptyPage("p1");
		sidecar.images.push({ id: "im-a", x: 10, y: 20, width: 300, height: 200, z: 0 });
		doc.applySidecar(sidecar, parsed.blocks, parsed.images, WIDTH);

		const result = doc.reconcile(twoInstances(), { defaultWidth: WIDTH });
		expect(result.addedImages.map((i) => i.data.id).sort()).toEqual(["im-b", "im-c"]);
		// The pre-existing instance keeps its exact placement.
		expect(doc.imageData("im-a")).toMatchObject({ x: 10, y: 20, width: 300, height: 200 });
		// The new one is placed, not stacked on the old one.
		expect(doc.imageData("im-b")!.y).not.toBe(20);
	});

	it("removes exactly the instance the file dropped", () => {
		const doc = loadedTwo();
		const withoutB = twoInstances()
			.replace("<!-- handwriting:image id=im-b -->\n![[attachments/cat.png]]\n<!-- /handwriting:image -->\n\n", "");
		const result = doc.reconcile(withoutB, { defaultWidth: WIDTH });
		expect(result.removedImages).toEqual(["im-b"]);
		expect(doc.hasImage("im-a")).toBe(true);
		expect(doc.hasImage("im-c")).toBe(true);
		expect(doc.imageData("im-a")).toMatchObject({ x: 0, y: 0 });
	});

	it("carries identity and geometry through a full save and reload", () => {
		const doc = loadedTwo();
		const md = doc.compose();
		const sidecarJson = serializePage(doc.page);

		const reopened = new PageDocument();
		const parsed = reopened.loadMarkdown(md);
		reopened.applySidecar(parsePage(sidecarJson, "p1").data, parsed.blocks, parsed.images, WIDTH);

		expect(reopened.page.images.map((i) => i.id)).toEqual(["im-a", "im-b", "im-c"]);
		expect(reopened.imageData("im-b")).toMatchObject({ x: 900, y: 800, width: 50, height: 40 });
		expect(reopened.targetOf("im-a")).toBe("attachments/cat.png");
		expect(reopened.targetOf("im-b")).toBe("attachments/cat.png");
	});
});
