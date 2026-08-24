/**
 * There are no Handwriting files.
 *
 * Any Markdown note can be opened on the canvas. Opening one shows the note's
 * own body, changes nothing on disk, and requires no marker, no conversion and
 * no import. The file only ever gains a line when the page acquires spatial
 * state that has to survive a rename — and even then it stays an ordinary note.
 *
 * The acceptance test Alan wrote is the shape of this file: take an untouched
 * old note → open as Handwriting → see all of it → write next to it → close → reopen
 * as Markdown → nothing weird happened.
 */

import { describe, expect, it } from "vitest";
import { BODY_BOX_ID, PageDocument } from "./PageDocument";
import { FM_MARKER, parseMarkdownPage } from "./MarkdownPage";
import { InkStroke } from "../ink/Stroke";

const WIDTH = 320;

/** A note from before Handwriting existed: no frontmatter of ours, no markers. */
const ORDINARY = [
	"---",
	"tags: [lecture]",
	"---",
	"",
	"# Lecture notes",
	"",
	"Some text with [[a link]].",
	"",
	"- bullet",
	"- another",
	"",
].join("\n");

/** A note with no frontmatter at all — the most ordinary thing in a vault. */
const BARE = "# Shopping\n\n- milk\n- bread\n";

/** Open a note the way the view does: markdown first, then the sidecar. */
function open(md: string): PageDocument {
	const doc = new PageDocument();
	const parsed = doc.loadMarkdown(md);
	doc.applySidecar(undefined, parsed.blocks, parsed.images, WIDTH);
	return doc;
}

function stroke(id: string): InkStroke {
	return {
		id,
		color: "#000",
		width: 2,
		tool: "pen",
		points: [
			{ x: 10, y: 10, p: 0.5, t: 0 },
			{ x: 20, y: 20, p: 0.5, t: 8 },
		],
	} as unknown as InkStroke;
}

describe("opening an ordinary note", () => {
	it("shows the note's body as canvas content, not as invisible extra", () => {
		const doc = open(ORDINARY);
		expect(doc.boxes).toHaveLength(1);
		expect(doc.boxes[0]!.data.id).toBe(BODY_BOX_ID);
		const text = doc.boxes[0]!.text;
		expect(text).toContain("# Lecture notes");
		expect(text).toContain("[[a link]]");
		expect(text).toContain("- another");
		// Nothing hiding off-canvas: everything the file said is in the container.
		expect(doc.extra).toBe("");
	});

	it("works with no frontmatter and no marker at all", () => {
		const doc = open(BARE);
		expect(doc.boxes).toHaveLength(1);
		expect(doc.boxes[0]!.text).toBe("# Shopping\n\n- milk\n- bread");
	});

	it("does not consider the note dirty", () => {
		expect(open(ORDINARY).markdownDirty).toBe(false);
		expect(open(BARE).markdownDirty).toBe(false);
	});

	it("round-trips byte for byte when nothing is touched", () => {
		for (const md of [ORDINARY, BARE]) {
			expect(open(md).compose()).toBe(md);
		}
	});
});

describe("writing on an ordinary note", () => {
	it("ink alone never rewrites the Markdown body", () => {
		const doc = open(ORDINARY);
		doc.page.strokes.push(stroke("s1"));
		// Ink lives in the sidecar. Until the id is claimed, the file is untouched.
		expect(doc.markdownDirty).toBe(false);
		expect(doc.compose()).toBe(ORDINARY);
	});

	it("claiming identity adds only a page id — no marker, no block markers", () => {
		const doc = open(ORDINARY);
		doc.page.strokes.push(stroke("s1"));
		doc.claimIdentity();
		expect(doc.markdownDirty).toBe(true);

		const out = doc.compose();
		const parsed = parseMarkdownPage(out);
		expect(parsed.pageId).toBe(doc.pageId);
		// The thing being killed: an id must not imply a document class.
		expect(parsed.isHandwritingPage).toBe(false);
		expect(out).not.toContain("handwriting:textbox");
		expect(out).not.toContain(`${FM_MARKER}: page`);
		// The user's own frontmatter and body survive verbatim.
		expect(out).toContain("tags: [lecture]");
		expect(out).toContain("# Lecture notes");
		expect(out).toContain("Some text with [[a link]].");
		expect(out).toContain("- another");
	});

	it("claiming identity twice is idempotent", () => {
		const doc = open(ORDINARY);
		doc.claimIdentity();
		const once = doc.compose();
		doc.claimIdentity();
		expect(doc.compose()).toBe(once);
	});

	it("reopening after ink shows the same content and stays stable", () => {
		const first = open(ORDINARY);
		first.claimIdentity();
		const saved = first.compose();

		const second = open(saved);
		expect(second.boxes).toHaveLength(1);
		expect(second.boxes[0]!.text).toBe(first.boxes[0]!.text);
		expect(second.pageId).toBe(first.pageId);
		expect(second.markdownDirty).toBe(false);
		// Second open changes nothing further: the id is already there.
		expect(second.compose()).toBe(saved);
	});

	it("switching back to Markdown shows the same semantic content", () => {
		const doc = open(ORDINARY);
		doc.claimIdentity();
		const out = doc.compose();
		const body = out.slice(out.indexOf("---", 3) + 3).trim();
		expect(body).toBe(ORDINARY.slice(ORDINARY.indexOf("---", 3) + 3).trim());
	});
});

describe("editing an ordinary note on the canvas", () => {
	it("typing in the body container writes the edited body back", () => {
		const doc = open(ORDINARY);
		doc.setText(BODY_BOX_ID, "# Lecture notes\n\nrewritten");
		expect(doc.markdownDirty).toBe(true);
		const out = doc.compose();
		expect(out).toContain("rewritten");
		expect(out).not.toContain("- bullet");
		expect(out).toContain("tags: [lecture]");
		expect(out).not.toContain("handwriting:textbox");
	});

	it("a second container is what makes block markers appear", () => {
		const doc = open(ORDINARY);
		doc.addBox({ id: "tb-2", x: 400, y: 0, width: WIDTH, z: 1 }, "aside");
		const out = doc.compose();
		expect(out).toContain("<!-- handwriting:textbox id=handwriting-body -->");
		expect(out).toContain("<!-- handwriting:textbox id=tb-2 -->");
		// Materialising adds structure; it never loses a word.
		expect(out).toContain("# Lecture notes");
		expect(out).toContain("Some text with [[a link]].");
		expect(out).toContain("- another");
		expect(out).toContain("aside");
		expect(out).toContain("tags: [lecture]");
	});

	it("an image also needs an anchor, so it materialises too", () => {
		const doc = open(ORDINARY);
		doc.addImage({ id: "im-1", x: 0, y: 200, width: 100, height: 80, z: 0 }, "files/cat.png");
		const out = doc.compose();
		expect(out).toContain("<!-- handwriting:image id=im-1 -->");
		expect(out).toContain("![[files/cat.png]]");
		expect(out).toContain("# Lecture notes");
	});
});

describe("external edits to an ordinary note", () => {
	it("are absorbed into the body container", () => {
		const doc = open(ORDINARY);
		const edited = ORDINARY.replace("- another", "- another\n- third");
		const result = doc.reconcile(edited, { defaultWidth: WIDTH });
		expect(result.dirty).toBe(true);
		expect(doc.boxes).toHaveLength(1);
		expect(doc.boxes[0]!.text).toContain("- third");
	});

	it("do not resurrect the version we opened with", () => {
		const doc = open(ORDINARY);
		const edited = ORDINARY.replace("- another", "- another\n- third");
		doc.reconcile(edited, { defaultWidth: WIDTH });
		doc.claimIdentity();
		const out = doc.compose();
		expect(out).toContain("- third");
	});

	it("leave the container alone while it is being typed in", () => {
		const doc = open(ORDINARY);
		const edited = ORDINARY.replace("- another", "- clobbered");
		const result = doc.reconcile(edited, {
			defaultWidth: WIDTH,
			editingId: BODY_BOX_ID,
		});
		expect(result.skipped).toContain(BODY_BOX_ID);
		expect(doc.boxes[0]!.text).toContain("- another");
	});

	it("adopt real markers if another window materialises the file", () => {
		const doc = open(ORDINARY);
		const materialised = [
			"---",
			"tags: [lecture]",
			"handwriting-version: 1",
			"handwriting-page-id: p9",
			"---",
			"",
			"<!-- handwriting:textbox id=tb-a -->",
			"from elsewhere",
			"<!-- /handwriting:textbox -->",
			"",
		].join("\n");
		const result = doc.reconcile(materialised, { defaultWidth: WIDTH });
		expect(result.dirty).toBe(true);
		expect(doc.bodyMode).toBe(false);
		expect(doc.boxes.map((b) => b.data.id)).toEqual(["tb-a"]);
		expect(doc.textOf("tb-a")).toBe("from elsewhere");
	});
});

describe("notes that already carry the marker", () => {
	const MARKED = [
		"---",
		"handwriting: page",
		"handwriting-version: 1",
		"handwriting-page-id: p1",
		"---",
		"",
		"<!-- handwriting:textbox id=tb-1 -->",
		"hello",
		"<!-- /handwriting:textbox -->",
		"",
	].join("\n");

	it("still open, still keep their marker, still round-trip", () => {
		const doc = open(MARKED);
		expect(doc.bodyMode).toBe(false);
		expect(doc.boxes.map((b) => b.data.id)).toEqual(["tb-1"]);
		expect(doc.identityClaimed).toBe(true);
		const out = doc.compose();
		expect(parseMarkdownPage(out).isHandwritingPage).toBe(true);
		expect(out).toContain("hello");
	});
});

describe("no frontmatter is invented", () => {
	it("editing a note with no frontmatter does not add an empty fence", () => {
		const doc = open(BARE);
		doc.setText(BODY_BOX_ID, "# Shopping\n\n- milk\n- eggs");
		const out = doc.compose();
		expect(out.startsWith("---")).toBe(false);
		expect(out).toContain("- eggs");
	});

	it("but claiming identity on it does add the id", () => {
		const doc = open(BARE);
		doc.claimIdentity();
		const out = doc.compose();
		expect(parseMarkdownPage(out).pageId).toBe(doc.pageId);
		expect(parseMarkdownPage(out).isHandwritingPage).toBe(false);
		expect(out).toContain("- bread");
	});
});
