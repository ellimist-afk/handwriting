/**
 * A resized picture keeps its ink: a picture's link replaced whole by a link to the same file (Obsidian's resize, its
 * undo, its redo) maps the group's target to the new link instead of collapsing it. Every other whole replace collapses
 * as before. Real ChangeSets, nothing mounted. Each cell names the defect that must turn it red.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { AttachFollow } from "./AttachFollow";
import {
	mapAttachments,
	pictureLinkFile,
	refreshTarget,
	resolveTarget,
	sameFileLinkSwaps,
	targetAt,
	type AttachmentRecord,
	type AttachmentTarget,
} from "./InkAttachments";

const LH = 40, PX = 2;
const text = (doc: string) => Text.of(doc.split("\n"));
const lineOf = (doc: string, pos: number) => doc.slice(0, pos).split("\n").length - 1;
const blockTopIn = (doc: string) => (pos: number) => lineOf(doc, pos) * LH;
const noteWith = (link: string) => `Intro line.\n\n${link}\n\nLast line.\n`;

/** A record whose target is exactly `link` in `doc`, as Attach on a picture stores it (a paragraph holding the link). */
const recordOn = (doc: string, link: string, kind: AttachmentTarget["kind"] = "paragraph", id = "att-1"): AttachmentRecord => {
	const from = doc.indexOf(link);
	return { v: 1, id, strokeIds: ["s1"], target: targetAt(doc, from, from + link.length, kind), ref: { x: 6, y: blockTopIn(doc)(from) / PX }, layout: { width: 672, font: 19 }, probe: { id: "s1", x: 40, y: 80 } };
};

/** One replace of `[from, to)` by `insert`, the new document, and the swaps the plugin reads from it. */
function replace(doc: string, from: number, to: number, insert: string) {
	const cs = ChangeSet.of([{ from, to, insert }], doc.length), after = cs.apply(text(doc)).toString();
	return { cs, after, swaps: sameFileLinkSwaps(cs, text(doc), text(after)) };
}

/** `old` replaced whole by `next` in a note holding it on its own line; the record mapped through it. */
function resize(old: string, next: string, kind: AttachmentTarget["kind"] = "paragraph") {
	const doc = noteWith(old), r = recordOn(doc, old, kind), at = doc.indexOf(old);
	const { cs, after, swaps } = replace(doc, at, at + old.length, next);
	const mapped = mapAttachments([r], cs, swaps ?? undefined)[0] as AttachmentRecord;
	return { doc, after, cs, swaps, r, t: mapped.target, link: after.indexOf(next) };
}

describe("a picture link replaced by a link to the same file keeps its target", () => {
	for (const [name, old, next] of [
		["a size added", "![[pic.png]]", "![[pic.png|200]]"],
		["a size changed", "![[pic.png|200]]", "![[pic.png|250]]"],
		["a size removed", "![[pic.png|200]]", "![[pic.png]]"],
		["a size by width and height", "![[pic.png]]", "![[pic.png|200x100]]"],
		["a markdown picture's size added", "![x](pic.png)", "![x|200](pic.png)"],
		["a markdown picture in angle brackets, a title kept", '![x](<my pic.png> "t")', '![x|200](<my pic.png> "t")'],
		["a picture with alt text, resized", "![[pic.png|alt]]", "![[pic.png|alt|200]]"],
		["an extension in capitals (a camera's IMG_1.JPG)", "![[IMG_1.JPG]]", "![[IMG_1.JPG|200]]"],
	] as const) it(`${name}: the target is the new link, not collapsed`, () => {
		// Defect: mapTarget collapses every target a change covers whole, so a resize pins the group and its ink stays
		// behind at the next edit above.
		const { t, link } = resize(old, next);
		expect(t.from, "target from").toBe(link);
		expect(t.to, "target to").toBe(link + next.length);
	});

	it("after the keep, the stored text is refreshed to the new link and a reopen finds the target there", () => {
		// Defect: the offsets follow in the session but the stored text stays `![[pic.png]]`; a save and reopen search for
		// a link the note no longer holds and the group needs reattachment.
		const { t, after, link } = resize("![[pic.png]]", "![[pic.png|200]]");
		const saved = refreshTarget(t, after);
		expect(saved.text).toBe("![[pic.png|200]]");
		expect(resolveTarget(saved, after)).toMatchObject({ from: link, to: link + "![[pic.png|200]]".length });
		// Without the refresh the reopen does not find it: what refreshTouched in the plugin is for.
		expect(resolveTarget({ ...t, from: 0, to: 0 }, after)).toBeNull();
	});
});

describe("every other whole replace collapses as before", () => {
	it("a link to another file: collapses", () => {
		// Defect: the same-file test dropped; a rename to another picture hands the ink to that one.
		const { t, swaps } = resize("![[pic.png]]", "![[pic-2.png]]");
		expect(swaps).toBeNull();
		expect(t.from).toBe(t.to);
	});

	it("a wiki link swapped for a markdown link to the same file: collapses (not a resize)", () => {
		const { t, swaps } = resize("![[pic.png]]", "![x](pic.png)");
		expect(swaps).toBeNull();
		expect(t.from).toBe(t.to);
	});

	it("one change replacing the link and the words after it on its line: collapses", () => {
		// Defect: the exact-range test dropped; any covering change with a link in it keeps the target.
		const doc = noteWith("![[pic.png]] tail words"), r = recordOn(doc, "![[pic.png]] tail words"), at = doc.indexOf("![[pic.png]]");
		const { cs, swaps } = replace(doc, at, at + "![[pic.png]] tail words".length, "![[pic.png|200]] other words");
		expect(swaps).toBeNull();
		const t = (mapAttachments([r], cs, swaps ?? undefined)[0] as AttachmentRecord).target;
		expect(t.from).toBe(t.to);
	});

	it("a target narrower than the replaced link keeps today's collapse", () => {
		const doc = noteWith("![[pic.png]]"), at = doc.indexOf("pic.png"), r = recordOn(doc, "pic.png", "range");
		const link = doc.indexOf("![[pic.png]]");
		const { cs, swaps } = replace(doc, link, link + "![[pic.png]]".length, "![[pic.png|200]]");
		expect(swaps).not.toBeNull();
		const t = (mapAttachments([r], cs, swaps ?? undefined)[0] as AttachmentRecord).target;
		expect(at).toBeGreaterThan(link);
		expect(t.from).toBe(t.to);
	});

	it("a link to a note, not a picture: collapses", () => {
		const { t, swaps } = resize("![[note]]", "![[note|x]]");
		expect(swaps).toBeNull();
		expect(t.from).toBe(t.to);
	});

	it("two lines of the same picture swapped by Move line up (two replaces): collapses", () => {
		// Defect: the one-range test dropped; each replace is a same-file swap, and the ink stays on its line while the
		// picture it was drawn on moves to the other line.
		const a = "![[pic.png]]", b = "![[pic.png|200]]", doc = `Intro.\n${a}\n${b}\nEnd.\n`;
		const r = recordOn(doc, a, "paragraph"), ia = doc.indexOf(a), ib = doc.indexOf(b);
		const cs = ChangeSet.of([{ from: ia, to: ia + a.length, insert: b }, { from: ib, to: ib + b.length, insert: a }], doc.length);
		const after = cs.apply(text(doc)).toString(), swaps = sameFileLinkSwaps(cs, text(doc), text(after));
		expect(swaps).toBeNull();
		const t = (mapAttachments([r], cs, swaps ?? undefined)[0] as AttachmentRecord).target;
		expect(t.from).toBe(t.to);
	});

	it("an insertion alone, or a change over 1024 characters, reads no swap", () => {
		const doc = noteWith("![[pic.png]]"), at = doc.indexOf("]]");
		expect(replace(doc, at, at, "|200").swaps).toBeNull();
		const long = `![[${"p".repeat(1100)}.png]]`, d2 = noteWith(long), a2 = d2.indexOf(long);
		expect(replace(d2, a2, a2 + long.length, `![[${"p".repeat(1100)}.png|200]]`).swaps).toBeNull();
	});

	it("pictureLinkFile: Obsidian's picture extensions in any case, the path before the first bar", () => {
		expect(pictureLinkFile("![[a/b.PNG|1]]")).toBe("w:a/b.PNG");
		expect(pictureLinkFile("![[a.pdf]]")).toBeNull();
		expect(pictureLinkFile("![[a.png]] x")).toBeNull();
		expect(pictureLinkFile("![](a.avif)")).toBe("m:a.avif");
	});
});

describe("history and the follow", () => {
	it("two resizes in a row, then two undos: the target is each link in turn, never collapsed", () => {
		// Defect: without the keep the second resize (|200 to |250) collapses, and its undo cannot find `![[pic.png]]`.
		const links = ["![[pic.png]]", "![[pic.png|200]]", "![[pic.png|250]]"];
		let doc = noteWith(links[0]!), r = recordOn(doc, links[0]!);
		const steps: { cs: ChangeSet; before: string }[] = [];
		for (let i = 1; i < links.length; i++) {
			const at = doc.indexOf(links[i - 1]!), s = replace(doc, at, at + links[i - 1]!.length, links[i]!);
			steps.push({ cs: s.cs, before: doc });
			r = mapAttachments([r], s.cs, s.swaps ?? undefined)[0] as AttachmentRecord;
			doc = s.after;
			expect(r.target, `after resize ${i}`).toMatchObject({ from: doc.indexOf(links[i]!), to: doc.indexOf(links[i]!) + links[i]!.length });
		}
		for (let i = steps.length - 1; i >= 0; i--) {
			const undo = steps[i]!.cs.invert(text(steps[i]!.before)), back = undo.apply(text(doc)).toString();
			r = mapAttachments([r], undo, sameFileLinkSwaps(undo, text(doc), text(back)) ?? undefined)[0] as AttachmentRecord;
			doc = back;
			expect(r.target, `after undo ${i + 1}`).toMatchObject({ from: doc.indexOf(links[i]!), to: doc.indexOf(links[i]!) + links[i]!.length });
		}
	});

	it("the follow: a resize keeps the group following, and a line typed above then moves it", () => {
		// Defect: the swaps never reach docChanged; the group is pinned at the resize and stays at the next line above.
		const old = "![[pic.png]]", next = "![[pic.png|200]]", doc = noteWith(old), f = new AttachFollow();
		f.setList([recordOn(doc, old)]);
		f.measure({ inView: () => true, refAt: (pos) => ({ x: 6, y: blockTopIn(doc)(pos) / PX }), blockTop: blockTopIn(doc) });
		const at = doc.indexOf(old), s = replace(doc, at, at + old.length, next);
		f.docChanged(s.cs, blockTopIn(s.after), PX, undefined, s.swaps);
		expect(f.followsText("att-1"), "follows after the resize").toBe(true);
		const above = ChangeSet.of([{ from: 0, insert: "new\n" }], s.after.length), doc2 = above.apply(text(s.after)).toString();
		f.docChanged(above, blockTopIn(doc2), PX);
		expect(f.offsetOf("s1"), "moved down one line").toEqual({ dx: 0, dy: LH / PX });
	});

	it("carryLifted: a record let go of before a resize is carried to the new link", () => {
		// Defect: the swaps never reach carryLifted; the undo of a Detach in this pane finds a collapsed record.
		const old = "![[pic.png]]", next = "![[pic.png|200]]", doc = noteWith(old), f = new AttachFollow();
		f.setList([recordOn(doc, old)]);
		f.setList([]);
		const at = doc.indexOf(old), s = replace(doc, at, at + old.length, next);
		f.carryLifted(s.cs, s.swaps);
		// letGo is private; read it here only, as no public path returns the carried record without putBack's own test.
		const kept = (f as unknown as { letGo: Map<string, AttachmentRecord> }).letGo.get("att-1")!;
		expect(kept.target).toMatchObject({ from: s.after.indexOf(next), to: s.after.indexOf(next) + next.length });
	});
});
