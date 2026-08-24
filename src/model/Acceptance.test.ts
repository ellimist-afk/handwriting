/**
 * The v0.8.1 acceptance suite, letter for letter (Alan's list after the
 * v0.8.0 audit). Everything automatable at the model level lives here; what
 * needs a running Obsidian is marked and verified on the test Surface:
 *
 *   B (write ORDERING on disk), D (a real link rename firing through the
 *   vault), H (two live views), and mtime assertions.
 *
 * The two rules this file enforces are written into the project decisions:
 *
 *   1. An unclaimed note is identified by the file currently loaded in the
 *      view. Absence of a page id is never evidence the document changed.
 *   2. The reference must exist before the referent: the Markdown page id is
 *      persisted before any sidecar keyed by it.
 */

import { describe, expect, it } from "vitest";
import { BODY_BOX_ID, PageDocument } from "./PageDocument";
import { parseMarkdownPage } from "./MarkdownPage";
import { InkStroke } from "../ink/Stroke";

const WIDTH = 320;

const UNTOUCHED = [
	"---",
	"tags: [lecture]",
	"---",
	"",
	"# Lecture notes",
	"",
	"Links to [[Some Note]] here.",
	"",
	"- bullet",
	"",
].join("\n");

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

describe("A: open, look around, close", () => {
	it("composes byte-identical, is not dirty, and has nothing worth a sidecar", () => {
		const doc = open(UNTOUCHED);
		expect(doc.compose()).toBe(UNTOUCHED);
		expect(doc.markdownDirty).toBe(false);
		// The view's sidecar and camera gates both key off this: false means
		// no sidecar file and no camera entry can be created by viewing.
		expect(doc.hasSpatialState).toBe(false);
	});
});

describe("B: first stroke claims identity before any sidecar (model half)", () => {
	it("no spatial state → the claim gate stays closed", () => {
		expect(open(UNTOUCHED).hasSpatialState).toBe(false);
	});

	it("a stroke opens the gate; the claim writes the id the sidecar will be keyed by", () => {
		const doc = open(UNTOUCHED);
		doc.page.strokes.push(stroke("s1"));
		expect(doc.hasSpatialState).toBe(true);
		doc.claimIdentity();
		const out = doc.compose();
		expect(parseMarkdownPage(out).pageId).toBe(doc.pageId);
		// Reopen: the stroke's sidecar key is recoverable from the file.
		expect(open(out).pageId).toBe(doc.pageId);
	});
	// The on-disk ordering (id write AWAITED before store.schedule) lives in
	// HandwritingPageView.scheduleSidecar, verified on the test Surface.
});

describe("C: external edit while ink is on the page", () => {
	it("text reconciles; the stroke, the page id and the mode survive", () => {
		const doc = open(UNTOUCHED);
		doc.page.strokes.push(stroke("s1"));
		const pageId = doc.pageId;

		const edited = UNTOUCHED.replace("- bullet", "- bullet\n- added elsewhere");
		// The view-level guard: no id in the file is NOT a different document.
		expect(doc.isSameDocument(undefined)).toBe(true);
		const result = doc.reconcile(edited, { defaultWidth: WIDTH });

		expect(result.dirty).toBe(true);
		expect(doc.textOf(BODY_BOX_ID)).toContain("- added elsewhere");
		expect(doc.page.strokes).toHaveLength(1);
		expect(doc.pageId).toBe(pageId);
		expect(doc.bodyMode).toBe(true);
	});

	it("a genuinely different persisted id IS a different document", () => {
		const doc = open(UNTOUCHED);
		expect(doc.isSameDocument("someone-elses-id")).toBe(false);
		expect(doc.isSameDocument(doc.pageId)).toBe(true);
	});
});

describe("D: Obsidian rewrites a link under us (model half)", () => {
	it("the link update reconciles as a body text change; ink does not blink", () => {
		const doc = open(UNTOUCHED);
		doc.page.strokes.push(stroke("s1"));
		const renamed = UNTOUCHED.replace("[[Some Note]]", "[[Renamed Note]]");
		const result = doc.reconcile(renamed, { defaultWidth: WIDTH });
		expect(result.dirty).toBe(true);
		expect(doc.textOf(BODY_BOX_ID)).toContain("[[Renamed Note]]");
		expect(doc.page.strokes).toHaveLength(1);
		// And the round trip does not resurrect the old link.
		doc.claimIdentity();
		expect(doc.compose()).toContain("[[Renamed Note]]");
		expect(doc.compose()).not.toContain("[[Some Note]]");
	});
});

describe("E: accidental finger tap, then blur", () => {
	it("an empty box is ephemeral: nothing dirty, nothing spatial, bytes identical", () => {
		const doc = open(UNTOUCHED);
		doc.addBox({ id: "tb-tap", x: 100, y: 100, width: WIDTH, z: 1 }, "");
		expect(doc.markdownDirty).toBe(false);
		expect(doc.hasSpatialState).toBe(false);
		expect(doc.bodyMode).toBe(true);
		expect(doc.compose()).toBe(UNTOUCHED);

		doc.removeBox("tb-tap");
		expect(doc.markdownDirty).toBe(false);
		expect(doc.compose()).toBe(UNTOUCHED);
	});

	it("the same on an empty note, including tapping into the empty body", () => {
		for (const md of ["", "---\ntags: x\n---\n"]) {
			const doc = open(md);
			// Tap in, tap out: the empty body box is auto-deleted on blur.
			doc.removeBox(BODY_BOX_ID);
			expect(doc.markdownDirty).toBe(false);
			expect(doc.compose()).toBe(md);
		}
	});
});

describe("F: create a second box, type, then undo it", () => {
	it("typing is what materialises; undoing it restores the original bytes", () => {
		const doc = open(UNTOUCHED);
		doc.addBox({ id: "tb-2", x: 400, y: 0, width: WIDTH, z: 1 }, "");
		expect(doc.bodyMode).toBe(true); // still ephemeral

		doc.setText("tb-2", "aside");
		expect(doc.bodyMode).toBe(false); // now it needs an anchor
		const marked = doc.compose();
		expect(marked).toContain("<!-- handwriting:textbox id=handwriting-body -->");
		expect(marked).toContain("aside");

		doc.removeBox("tb-2");
		expect(doc.bodyMode).toBe(true); // back to body form
		expect(doc.compose()).toBe(UNTOUCHED); // and to the original bytes
	});

	it("with a claimed identity, undo returns to original plus only the id line", () => {
		const doc = open(UNTOUCHED);
		doc.claimIdentity(); // ink existed, sidecar written — id is legitimate
		doc.addBox({ id: "tb-2", x: 400, y: 0, width: WIDTH, z: 1 }, "aside");
		doc.removeBox("tb-2");
		const out = doc.compose();
		expect(out.replace(/^handwriting-page-id: .*\n/m, "")).toBe(UNTOUCHED);
	});

	it("a real v0.7 marker note never flips to body form", () => {
		const marked = [
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
		const doc = open(marked);
		doc.addBox({ id: "tb-2", x: 0, y: 0, width: WIDTH, z: 1 }, "x");
		doc.removeBox("tb-2");
		expect(doc.bodyMode).toBe(false);
		expect(doc.compose()).toContain("<!-- handwriting:textbox id=tb-1 -->");
	});
});

describe("G: the nasty frontmatter corpus survives first ink", () => {
	const CORPUS: Record<string, string> = {
		"valid YAML": "---\ntitle: Real\ntags: [a, b]\n---\n\nBody line.\n",
		"no frontmatter": "# Plain\n\nJust text.\n",
		"leading horizontal rule": "---\n\nA thematic break opened this note.\n",
		"unterminated ---": "---\nnot yaml, just text\nmore text\n",
		"--- with whitespace": "--- \ntags: x\n---\nBody after odd fence.\n",
		"CRLF line endings": "---\r\ntags: x\r\n---\r\n\r\nWindows body.\r\n",
		"code fence containing ---": [
			"# Doc",
			"",
			"```",
			"---",
			"not: frontmatter",
			"---",
			"```",
			"",
			"After the fence.",
			"",
		].join("\n"),
	};

	for (const [name, md] of Object.entries(CORPUS)) {
		it(`${name}: untouched is byte-identical`, () => {
			expect(open(md).compose()).toBe(md);
		});

		it(`${name}: first ink adds the id without duplication or loss`, () => {
			const doc = open(md);
			doc.page.strokes.push(stroke("s1"));
			doc.claimIdentity();
			const out = doc.compose();

			// Every distinctive body line appears exactly once.
			const lines = md.replace(/\r\n/g, "\n").split("\n");
			for (const line of lines) {
				if (line.trim().length < 4 || line.trim() === "---") continue;
				const count = out.split(line.trim()).length - 1;
				expect(count, `"${line}" duplicated or lost in:\n${out}`).toBe(1);
			}
			// The id is recoverable and a reopen shows the same body content.
			const again = open(out);
			expect(again.pageId).toBe(doc.pageId);
			expect(again.textOf(BODY_BOX_ID)).toBe(doc.textOf(BODY_BOX_ID));
			// And a second save changes nothing further.
			expect(again.compose()).toBe(out);
		});
	}

	it("an unterminated leading --- is body, not swallowed frontmatter", () => {
		const doc = open("---\nprose that is not yaml\n");
		expect(doc.textOf(BODY_BOX_ID)).toContain("prose that is not yaml");
		expect(doc.textOf(BODY_BOX_ID)).toContain("---");
	});
});

describe("H: two views of one note (model half)", () => {
	it("adopting the other view's persisted id via reconcile, not inventing a second", () => {
		const a = open(UNTOUCHED);
		a.page.strokes.push(stroke("s1"));
		a.claimIdentity();
		const saved = a.compose();

		// View B opened the same unclaimed file earlier and now sees A's save.
		const b = open(UNTOUCHED);
		expect(b.isSameDocument(a.pageId)).toBe(false); // triggers a reopen…
		const b2 = open(saved); // …which adopts A's identity
		expect(b2.pageId).toBe(a.pageId);
		expect(b2.identityClaimed).toBe(true);
	});
	// Live two-view editing is the promoted public-alpha blocker; full fix is
	// a shared document per page id, tracked in status.
});

describe("deleting the implicit body container tells the truth", () => {
	it("deletion is a real edit: the Markdown body empties", () => {
		const doc = open(UNTOUCHED);
		const removed = doc.removeBox(BODY_BOX_ID);
		expect(removed).toBeDefined();
		expect(doc.markdownDirty).toBe(true);
		const out = doc.compose();
		expect(out).not.toContain("# Lecture notes");
		expect(out).toContain("tags: [lecture]"); // frontmatter survives
	});

	it("undo restores the body and the original bytes", () => {
		const doc = open(UNTOUCHED);
		const removed = doc.removeBox(BODY_BOX_ID)!;
		doc.addBox(removed.data, removed.text, removed.index);
		expect(doc.compose()).toBe(UNTOUCHED);
	});
});

describe("external materialisation while editing the body", () => {
	it("does not duplicate the body next to the adopted blocks", () => {
		const doc = open(UNTOUCHED);
		const materialised = [
			"---",
			"tags: [lecture]",
			"handwriting-version: 1",
			"handwriting-page-id: p9",
			"---",
			"",
			"<!-- handwriting:textbox id=tb-a -->",
			"# Lecture notes",
			"",
			"Links to [[Some Note]] here.",
			"<!-- /handwriting:textbox -->",
			"",
		].join("\n");
		doc.reconcile(materialised, {
			defaultWidth: WIDTH,
			editingId: BODY_BOX_ID, // mid-keystroke in the body container
		});
		const out = doc.compose();
		expect(out.split("# Lecture notes").length - 1).toBe(1);
		expect(doc.hasBox(BODY_BOX_ID)).toBe(false);
	});
});
