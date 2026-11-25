/**
 * Ink attached to text: the model's acceptance cells, A1 to A15 where the model alone can answer them. Nothing is mounted
 * and no stroke point is written. Each cell names the defect that must turn it red.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import {
	alignShown,
	applyAttachStep,
	attachGroup,
	attachmentMembership,
	attachmentSelection,
	detachGroup,
	followOffset,
	hiddenInCell,
	insertSpaceMembers,
	invertAttachStep,
	liveAttachments,
	mapAttachments,
	mapTarget,
	readAttachment,
	refreshTarget,
	replaceMembers,
	resolveAttachments,
	resolveTarget,
	targetAt,
	type AttachmentData,
	type AttachmentRecord,
} from "./InkAttachments";
import { isSafePageId } from "../model/PageData";
import { clearInkClipboard, copyInk, inkClipboardMarker, markerIsCurrent, pasteInk } from "./InkClipboard";
import type { InkStroke } from "../ink/Stroke";
import { appendFileSync } from "node:fs";

declare module "node:fs" { export function appendFileSync(path: string, data: string): void; }
declare const process: { env: Record<string, string | undefined> };
/** HW_TABLE_ATTACH_OUT=<path>: the long cell's time is appended there too (passing cells' console is not kept). */
const OUT = process.env.HW_TABLE_ATTACH_OUT ?? "";

const DOC = "Intro line here.\nThe word benzene sits in this line.\nLast line of the note.\n";
const at = (doc: string, word: string) => { const from = doc.indexOf(word); return { from, to: from + word.length }; };
const record = (doc = DOC, word = "benzene", id = "att-1", strokeIds = ["s1", "s2"]): AttachmentRecord => {
	const { from, to } = at(doc, word);
	return { v: 1, id, strokeIds, target: targetAt(doc, from, to, "range"), ref: { x: 0, y: 40 }, layout: { width: 672, font: 19 }, probe: { id: strokeIds[0]!, x: 101.25, y: 52.5 } };
};
const insert = (doc: string, pos: number, text: string) => ChangeSet.of([{ from: pos, insert: text }], doc.length);
const apply = (doc: string, cs: ChangeSet) => cs.apply(Text.of(doc.split("\n"))).toString();

describe("A1 attach", () => {
	it("records the group, moves no point, one history step; the follow offset at the recorded ref is zero", () => {
		const r = record();
		const { list, step } = attachGroup([], r);
		expect(list).toEqual([r]);
		expect(step).toEqual({ type: "attach", id: "att-1", before: null, after: r });
		// Plant a1-ref-off: attach records the ref one line off; the next follow then moves the ink.
		expect(followOffset(list[0] as AttachmentRecord, { x: 0, y: 40 })).toEqual({ dx: 0, dy: 0 });
		expect(followOffset(r, { x: 0, y: 64 })).toEqual({ dx: 0, dy: 24 });
		expect(followOffset(r, null)).toBeNull();
	});
});

describe("A3 mixed selections (model half)", () => {
	const two: AttachmentData[] = [record(DOC, "benzene", "g1", ["a", "b"]), record(DOC, "Last", "g2", ["c"])];
	it("one group: Detach on; group plus free: Attach gives the union, Detach off; two groups: Attach on, Detach on", () => {
		expect(attachmentSelection(two, ["a"])).toMatchObject({ attach: true, detach: true, groupIds: ["g1"], expandedIds: ["a", "b"] });
		expect(attachmentSelection(two, ["a", "free"])).toMatchObject({ attach: true, detach: false, groupIds: ["g1"] });
		expect(attachmentSelection(two, ["a", "c"])).toMatchObject({ attach: true, detach: true, groupIds: ["g1", "g2"] });
		expect(attachmentSelection(two, ["a", "c", "free"]), "loose ink in the lasso").toMatchObject({ attach: true, detach: true, groupIds: ["g1", "g2"] });
		expect(attachmentSelection(two, ["free"])).toMatchObject({ attach: true, detach: false, groupIds: [] });
	});
	it("Detach removes only the chosen group's record, whatever is selected", () => {
		// Plant a3-detach-by-selection: detach removes every group the selection touches.
		const { list, step } = detachGroup(two, "g1");
		expect(list).toEqual([two[1]]);
		expect(step?.before).toEqual(two[0]);
	});
	it("a stroke belongs to one group: an attach reaching another group's stroke is refused, no step", () => {
		const { list, step } = attachGroup(two, { ...record(DOC, "Last", "g2"), strokeIds: ["c", "b"] });
		expect(step).toBeNull();
		expect(list).toEqual(two);
		expect(attachmentMembership(list).get("b")).toBe("g1");
	});
	it("the union of a group and free ink, under the group's id, still attaches", () => {
		const { list, step } = attachGroup(two, record(DOC, "benzene", "g1", ["a", "b", "free"]));
		expect(step?.before).toEqual(two[0]);
		expect((list.find((g) => g.id === "g1") as AttachmentRecord).strokeIds).toEqual(["a", "b", "free"]);
	});
	it("an attach that reaches another group's strokes, then undo: every group is as it was, including one the attach would empty", () => {
		// Plant: the attach takes the strokes out of the other group while its step carries only the attached record, so undo
		// leaves g1 short, or gone. The attach is refused instead, with no step.
		const one: AttachmentData[] = [record(DOC, "benzene", "g1", ["a"]), record(DOC, "Last", "g2", ["c"])];
		for (const [before, taken] of [[two, "b"], [one, "a"]] as const) {
			const { list, step } = attachGroup(before, record(DOC, "Last", "g2", ["c", taken]));
			expect(step, `no step for attaching ${taken} to g2`).toBeNull();
			const undone = step ? applyAttachStep(list, invertAttachStep(step)) : list;
			expect(undone, `undo after attaching ${taken} to g2`).toEqual(before);
		}
	});
});

describe("A5 edits inside the target", () => {
	const r = record();
	it("insertion at from and at to stays outside; inside grows the range", () => {
		const { from, to } = r.target;
		expect(mapTarget(r.target, insert(DOC, from, "XX"))).toMatchObject({ from: from + 2, to: to + 2 });
		// Plant a5-assoc: from mapped with assoc -1 and to with 1; the insertion at the edge joins the target.
		expect(mapTarget(r.target, insert(DOC, to, "XX"))).toMatchObject({ from, to });
		expect(mapTarget(r.target, insert(DOC, from + 3, "XX"))).toMatchObject({ from, to: to + 2 });
	});
	it("text typed above maps the target down; paragraph split keeps the range; a merge maps", () => {
		expect(mapTarget(r.target, insert(DOC, 0, "New line\n"))).toMatchObject({ from: r.target.from + 9, to: r.target.to + 9 });
		const p = { ...r.target, kind: "paragraph" as const, from: DOC.indexOf("The"), to: DOC.indexOf("\nLast") };
		const split = mapTarget(p, insert(DOC, DOC.indexOf(" sits"), "\n"));
		expect(split).toMatchObject({ from: p.from, to: p.to + 1 });
		const merge = mapTarget(p, ChangeSet.of([{ from: p.from - 1, to: p.from }], DOC.length));
		expect(merge).toMatchObject({ from: p.from - 1, to: p.to - 1 });
	});
	it("an edit elsewhere returns the record list unchanged by identity", () => {
		const list = [r];
		expect(mapAttachments(list, insert(DOC, DOC.length, "tail"))).toBe(list);
	});
});

describe("A7 deletion and restoration (model half)", () => {
	const r = record();
	it("deleting the target collapses it: needs reattachment, ref untouched; undo resolves without a move", () => {
		const del = ChangeSet.of([{ from: r.target.from, to: r.target.to }], DOC.length);
		const after = apply(DOC, del);
		const mapped = mapAttachments([r], del);
		const gone = resolveAttachments(mapped, after);
		expect(gone.status.get("att-1")).toBe("needs-reattachment");
		expect((gone.list[0] as AttachmentRecord).ref).toEqual(r.ref);
		const undo = del.invert(Text.of(DOC.split("\n")));
		const back = resolveAttachments(mapAttachments(gone.list, undo), apply(after, undo));
		expect(back.status.get("att-1")).toBe("resolved");
		expect((back.list[0] as AttachmentRecord).target).toMatchObject({ from: r.target.from, to: r.target.to });
		expect((back.list[0] as AttachmentRecord).ref).toEqual(r.ref);
	});
	it("delete and retype the same text with the same context twice elsewhere: still needs reattachment", () => {
		// Every copy of the line sits between the same 40-dash rules, so each retyped copy carries the original's text and
		// its 32 characters of context on both sides.
		const rule = `\n${"-".repeat(40)}\n`, line = "The word benzene sits in this line.";
		const doc = `${rule}${line}${rule}`, own = record(doc);
		const del = ChangeSet.of([{ from: own.target.from, to: own.target.to }], doc.length);
		const after = apply(doc, del) + `${line}${rule}${line}${rule}`;
		// Plant a7-nearest: resolve takes the first match instead of refusing a duplicate.
		expect(resolveAttachments(mapAttachments([own], del), after).status.get("att-1")).toBe("needs-reattachment");
	});
});

describe("A8 undo and redo", () => {
	it("attach, change attachment and detach are one step each and invert exactly", () => {
		const r = record(), changed = { ...r, strokeIds: ["s1"] };
		const a = attachGroup([], r), c = attachGroup(a.list, changed), d = detachGroup(c.list, r.id);
		expect([a.step!.before, c.step!.before, d.step!.before]).toEqual([null, r, changed]);
		expect(applyAttachStep(d.list, invertAttachStep(d.step!))).toEqual(c.list);
		expect(applyAttachStep(c.list, invertAttachStep(c.step!))).toEqual(a.list);
		expect(applyAttachStep(a.list, invertAttachStep(a.step!))).toEqual([]);
		expect(applyAttachStep([], a.step!)).toEqual(a.list);
	});
	it("undo of a text edit maps the target back; no step carries a move", () => {
		const r = record(), cs = insert(DOC, 0, "Three\nnew\nlines\n");
		const down = mapAttachments([r], cs);
		const back = mapAttachments(down, cs.invert(Text.of(DOC.split("\n"))));
		expect((back[0] as AttachmentRecord).target).toEqual(r.target);
		expect((back[0] as AttachmentRecord).ref).toEqual(r.ref);
	});
});

describe("A9 reopen (model half)", () => {
	it("targets at their offsets: resolved, list returned as is (no write)", () => {
		const list = [record()];
		const out = resolveAttachments(list, DOC);
		expect(out.list).toBe(list);
		expect(out.status.get("att-1")).toBe("resolved");
	});
	it("text shifted by an external edit: resolved by text and context, offsets rewritten, ref untouched", () => {
		const r = record(), doc = "Added by another device.\n" + DOC;
		const out = resolveAttachments([r], doc);
		expect((out.list[0] as AttachmentRecord).target.from).toBe(doc.indexOf("benzene"));
		expect((out.list[0] as AttachmentRecord).ref).toEqual(r.ref);
	});
	it("text gone: needs reattachment, never another state", () => {
		expect(resolveAttachments([record()], DOC.replace("benzene", "toluene")).status.get("att-1")).toBe("needs-reattachment");
	});
});

describe("A10 sync", () => {
	it("adopting a sidecar whose ink and refs moved together computes no move", () => {
		const r = record(), moved = { ...r, ref: { x: 0, y: 88 } };
		// Plant a10-reconcile-on-adoption: resolveAttachments rewrites ref from the old record.
		const out = resolveAttachments([moved], DOC);
		expect((out.list[0] as AttachmentRecord).ref).toEqual({ x: 0, y: 88 });
		expect(followOffset(out.list[0] as AttachmentRecord, { x: 0, y: 88 })).toEqual({ dx: 0, dy: 0 });
	});
	it("text arrives without its sidecar: resolve only, the record's ref and probe stay", () => {
		const r = record(), doc = "Synced text above.\n" + DOC;
		const out = resolveAttachments([r], doc).list[0] as AttachmentRecord;
		expect(out.ref).toEqual(r.ref);
		expect(out.probe).toEqual(r.probe);
	});
});

describe("A11 duplicate paragraphs", () => {
	const para = "Same paragraph text.";
	// Each copy sits between the same 40-dash rules, so both carry the same text and the same 32 characters of context:
	// only the stored position tells them apart.
	const rule = `\n${"-".repeat(40)}\n`;
	const doc = `${rule}${para}${rule}${para}${rule}`;
	const secondFrom = 2 * rule.length + para.length;
	const second = (): AttachmentRecord => ({ ...record(doc, para), target: targetAt(doc, secondFrom, secondFrom + para.length, "paragraph") });
	it("attached to the second of two identical paragraphs: resolved at the stored offset", () => {
		// Plant a11-search-first: resolve searches before checking the stored offset.
		expect(resolveTarget(second().target, doc)).toEqual(second().target);
	});
	it("second moved above the first by a local cut and paste: needs reattachment", () => {
		const r = second();
		const cut = ChangeSet.of([{ from: r.target.from, to: r.target.to + rule.length }], doc.length);
		const cutDoc = apply(doc, cut);
		const paste = ChangeSet.of([{ from: rule.length, insert: para + rule }], cutDoc.length);
		const list = mapAttachments(mapAttachments([r], cut), paste);
		expect(resolveAttachments(list, apply(cutDoc, paste)).status.get(r.id)).toBe("needs-reattachment");
	});
});

describe("A13 detach", () => {
	it("record removed, one step, undo restores it", () => {
		const r = record();
		const { list, step } = detachGroup([r], r.id);
		expect(list).toEqual([]);
		expect(step).toEqual({ type: "attach", id: r.id, before: r, after: null });
		expect(applyAttachStep(list, invertAttachStep(step!))).toEqual([r]);
		expect(detachGroup(list, r.id).step).toBeNull();
	});
});

describe("A14 older and newer records", () => {
	it("a v 2 record is kept opaque, needs reattachment and is untouched by mapping", () => {
		const raw = { v: 2, id: "att-9", strokeIds: ["s1"], shape: { anything: [1, 2] } };
		const a = readAttachment(raw, isSafePageId)!;
		expect(a).toEqual({ opaque: true, id: "att-9", raw });
		expect(resolveAttachments([a], DOC).status.get("att-9")).toBe("needs-reattachment");
		const list = [a];
		expect(mapAttachments(list, insert(DOC, 0, "x"))).toBe(list);
	});
	it("a v 1 record with a bad field or an unsafe id is dropped (null)", () => {
		expect(readAttachment({ ...record(), ref: { x: "0", y: 1 } } as unknown as Record<string, unknown>, isSafePageId)).toBeNull();
		expect(readAttachment({ ...record(), id: "__proto__" } as unknown as Record<string, unknown>, isSafePageId)).toBeNull();
	});
});

describe("A15 erase", () => {
	it("partial erase: pieces stay in the group; full erase: one fewer; empty group survives until load", () => {
		const r = record(DOC, "benzene", "g", ["s1", "s2"]);
		const partial = replaceMembers([r], new Map([["s1", ["s1a", "s1b"]]]));
		expect((partial[0] as AttachmentRecord).strokeIds).toEqual(["s1a", "s1b", "s2"]);
		const full = replaceMembers(partial, new Map([["s2", []]]));
		expect((full[0] as AttachmentRecord).strokeIds).toEqual(["s1a", "s1b"]);
		const empty = replaceMembers(full, new Map([["s1a", []], ["s1b", []]]));
		expect(empty).toHaveLength(1);
		// Plant a15-keep-empty: liveAttachments keeps a group with no live member.
		expect(liveAttachments(empty, new Set(["free"]))).toEqual([]);
		expect(liveAttachments(full, new Set(["s1a", "free"]))).toEqual([{ ...full[0], strokeIds: ["s1a"] }]);
	});
});

describe("Insert Space membership rule", () => {
	it("a group moves whole by its target's first line, never in part", () => {
		const g = record(DOC, "benzene", "g", ["above", "below"]);
		expect(insertSpaceMembers([g], 30, new Map([["g", 40]])).move).toEqual(new Set(["above", "below"]));
		expect(insertSpaceMembers([g], 50, new Map([["g", 40]])).hold).toEqual(new Set(["above", "below"]));
	});
});

describe("refresh at save", () => {
	it("a resolved target's text and context follow the document", () => {
		const r = record(), doc = DOC.replace("sits", "rests");
		expect(refreshTarget(r.target, doc).after.startsWith(" rests in this line. Last")).toBe(true);
		expect(refreshTarget(r.target, DOC)).toBe(r.target);
	});
});

describe("A12 copy and paste", () => {
	const stroke = (id: string): InkStroke => ({ id, tool: "pen", color: "#000000", width: 2, points: [{ x: 10, y: 20, pressure: 0.5, t: 0 }, { x: 20, y: 30, pressure: 0.5, t: 8 }], bbox: { x: 9, y: 19, width: 12, height: 12 }, createdAt: 0 });
	it("pasted ink, in the same note and in another, joins no group; the marker carries no attachment", () => {
		clearInkClipboard();
		const g = record(DOC, "benzene", "g", ["s1", "s2"]);
		copyInk([stroke("s1"), stroke("s2")], "a.md");
		const marker = inkClipboardMarker();
		const pasted = [...pasteInk("a.md"), ...pasteInk("b.md")];
		const members = attachmentMembership([g]);
		expect(pasted).toHaveLength(4);
		expect(pasted.every((s) => !members.has(s.id))).toBe(true);
		expect(marker !== null && markerIsCurrent(marker)).toBe(true);
		expect(marker).toMatch(/^handwriting-ink\/v1 \S+ \(2 strokes\)$/);
		clearInkClipboard();
	});
});

describe("a table cell's source matched to the text the cell draws", () => {
	const log = (line: string) => {
		console.log(line);
		if (OUT) appendFileSync(OUT, line + "\n");
	};
	// Plain text that ends a longer cell.
	const TAIL = " and the rest of the cell is plain text";
	// [the source with the word in braces (not in the note), the drawn text, the word's first drawn index].
	const CASES: [string, string, number][] = [
		// Markup letters that a later word also holds: the word keeps its own drawn letters.
		["beta<br>{bob}", "betabob", 4],
		["x<br>{rb}", "xrb", 1],
		['[a](u "t") {t}', "a t", 2],
		// Markup letters that an earlier word also holds.
		["{bob}<br>x", "bobx", 0],
		// Between two <br>s that hold its letters.
		["a<br>{b}<br>c", "abc", 1],
		["1<br>{r}<br>2", "1r2", 1],
		["x<br>{br}<br>y", "xbry", 1],
		["to oa<br>b<br>{rlu}", "to oabrlu", 6],
		// Other markup with letters: an HTML tag, a wikilink's target under its alias, a link's title.
		["<b>{bold}</b> b", "bold b", 0],
		["[[bob\\|al]] {b}", "al b", 3],
		['[x](b "b") {b}', "x b", 2],
		// Read right before this fix too: they stay right.
		["beta<br>{gamma}", "betagamma", 4],
		["**b** {bold}", "b bold", 2],
		["[[alpha\\|al]] {x}", "al x", 3],
		["plain {words}", "plain words", 6],
		// Drawn characters the source does not hold in order: only the whole alignment places the word after them.
		["<https://a> {b}", "https://a b", 10],
		["x<br><https://a> {b}", "xhttps://a b", 11],
		["a &lt; {b}", "a < b", 4],
		["a&nbsp;{b}", "a\u00a0b", 2],
		["[[n#h]] {b}", "n > h b", 6],
		// The same in a longer cell, its plain text after the word.
		["<https://a> {b}" + TAIL, "https://a b" + TAIL, 10],
		["x<br><https://a> {b}" + TAIL, "xhttps://a b" + TAIL, 11],
		["a &lt; {b}" + TAIL, "a < b" + TAIL, 4],
		["a&nbsp;{b}" + TAIL, "a\u00a0b" + TAIL, 2],
		["[[n#h]] {b}" + TAIL, "n > h b" + TAIL, 6],
		// An entity's name and a comment's text hold the word's letters across a <br>.
		["&amp;<br>{amp}", "&amp", 1],
		["%%b%%<br>{b}", "b", 0],
		["%%s%%<br>{s}<br>x", "sx", 0],
	];
	for (const [marked, shown, first] of CASES) {
		const at = marked.indexOf("{"), word = marked.slice(at + 1, marked.indexOf("}")), src = marked.replace(/[{}]/g, "");
		it(`${JSON.stringify(src)} drawn ${JSON.stringify(shown)}: ${word} reads its own drawn letters`, () => {
			const map = alignShown(src, shown);
			expect(Array.from({ length: word.length }, (_, k) => map[at + k]!)).toEqual(Array.from({ length: word.length }, (_, k) => first + k));
		});
	}

	/** mulberry32, seeded. */
	const rng = (seed: number) => {
		let a = seed >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	};
	/** One cell of words, <br>s, bold, links with addresses and titles and escaped pipes, with each source character's true drawn index. */
	const fuzzCell = (r: () => number) => {
		const ALPHA = "abrtoul";
		const word = () => Array.from({ length: 1 + Math.floor(r() * 4) }, () => ALPHA[Math.floor(r() * ALPHA.length)]!).join("");
		let src = "", shown = "";
		const truth: number[] = [], words: { from: number; to: number }[] = [];
		const hidden = (s: string) => { for (const _ of s) truth.push(-1); src += s; };
		const drawn = (s: string) => { for (const ch of s) { truth.push(shown.length); src += ch; shown += ch; } };
		const n = 1 + Math.floor(r() * 5);
		for (let k = 0; k < n; k++) {
			if (k > 0) {
				const sep = r();
				if (sep < 0.5) drawn(" ");
				else if (sep < 0.8) hidden("<br>");
				else { drawn(" "); hidden("<br>"); }
			}
			const kind = r();
			if (kind < 0.45) { const from = src.length; drawn(word()); words.push({ from, to: src.length }); }
			else if (kind < 0.6) { hidden("**"); drawn(word()); hidden("**"); }
			else if (kind < 0.75) { hidden("["); drawn(word()); hidden(`](${word()})`); }
			else if (kind < 0.88) { hidden("["); drawn(word()); hidden(`](${word()} "${word()}")`); }
			else { drawn(word()); truth.push(shown.length, shown.length); src += "\\|"; shown += "|"; drawn(word()); }
		}
		return { src, shown, truth, words };
	};

	it("20000 seeded cells with markup: every plain word reads its own first and last drawn letter, every letter matched", () => {
		const r = rng(20261117);
		let cells = 0, words = 0, wrong = 0;
		const ex: string[] = [];
		for (let c = 0; c < 20000; c++) {
			const cell = fuzzCell(r);
			if (cell.src === cell.shown) continue;
			cells++;
			const map = alignShown(cell.src, cell.shown);
			for (const w of cell.words) {
				words++;
				let bad = map[w.from] !== cell.truth[w.from] || map[w.to - 1] !== cell.truth[w.to - 1];
				for (let i = w.from; i < w.to; i++) if (map[i]! < 0) bad = true;
				if (bad) { wrong++; if (ex.length < 5) ex.push(`${JSON.stringify(cell.src)} word ${JSON.stringify(cell.src.slice(w.from, w.to))}@${w.from}`); }
			}
		}
		log(`ALIGN fuzz: ${cells} cells, ${words} plain words, ${wrong} wrong ${ex.join(" | ")}`);
		expect(wrong).toBe(0);
	});

	/**
	 * One cell of more markup: italics, highlight, strike, code, HTML tags, wikilinks with an alias or a heading, entities,
	 * comments and autolinks too, with each source character's true drawn index.
	 */
	const fuzzCell2 = (r: () => number) => {
		const ALPHA = "abrtoulmpshin";
		const word = () => Array.from({ length: 1 + Math.floor(r() * 4) }, () => ALPHA[Math.floor(r() * ALPHA.length)]!).join("");
		const pick = <T,>(l: readonly T[]) => l[Math.floor(r() * l.length)]!;
		let src = "", shown = "";
		const truth: number[] = [], words: { from: number; to: number }[] = [];
		const hidden = (s: string) => { for (const _ of s) truth.push(-1); src += s; };
		const drawn = (s: string) => { for (const ch of s) { truth.push(shown.length); src += ch; shown += ch; } };
		const n = 1 + Math.floor(r() * 5);
		for (let k = 0; k < n; k++) {
			if (k > 0) {
				const sep = r();
				if (sep < 0.5) drawn(" ");
				else if (sep < 0.8) hidden("<br>");
				else { drawn(" "); hidden("<br>"); }
			}
			const kind = pick(["word", "word", "word", "bold", "ital", "hl", "strike", "code", "html", "link", "title", "wiki", "alias", "head", "ent", "comment", "auto", "pipe"] as const);
			if (kind === "word") { const from = src.length; drawn(word()); words.push({ from, to: src.length }); }
			else if (kind === "bold" || kind === "ital" || kind === "hl" || kind === "strike" || kind === "code") {
				const m = { bold: "**", ital: "*", hl: "==", strike: "~~", code: "`" }[kind];
				hidden(m); drawn(word()); hidden(m);
			}
			else if (kind === "html") { const tag = pick(["b", "i", "span", "u"]); hidden(`<${tag}>`); drawn(word()); hidden(`</${tag}>`); }
			else if (kind === "link") { hidden("["); drawn(word()); hidden(`](${word()})`); }
			else if (kind === "title") { hidden("["); drawn(word()); hidden(`](${word()} "${word()}")`); }
			else if (kind === "wiki") { hidden("[["); drawn(word()); hidden("]]"); }
			else if (kind === "alias") { hidden(`[[${word()}\\|`); drawn(word()); hidden("]]"); }
			else if (kind === "head") { hidden("[["); drawn(word()); hidden("#"); shown += " > "; drawn(word()); hidden("]]"); }
			else if (kind === "ent") { const [name, ch] = pick([["amp", "&"], ["lt", "<"], ["nbsp", "\u00a0"], ["#38", "&"], ["#x3C", "<"]] as const); truth.push(shown.length); src += "&"; shown += ch; hidden(`${name};`); }
			else if (kind === "comment") hidden(`%%${word()}%%`);
			else if (kind === "auto") { hidden("<"); drawn(`https://${word()}`); hidden(">"); }
			else { drawn(word()); truth.push(shown.length, shown.length); src += "\\|"; shown += "|"; drawn(word()); }
		}
		return { src, shown, truth, words };
	};

	it("20000 seeded cells of more markup: every plain word reads its own first and last drawn letter, every letter matched", () => {
		const r = rng(2026111703);
		let cells = 0, words = 0, wrong = 0;
		const ex: string[] = [];
		for (let c = 0; c < 20000; c++) {
			const cell = fuzzCell2(r);
			if (cell.src === cell.shown) continue;
			cells++;
			const map = alignShown(cell.src, cell.shown);
			for (const w of cell.words) {
				words++;
				let bad = map[w.from] !== cell.truth[w.from] || map[w.to - 1] !== cell.truth[w.to - 1];
				for (let i = w.from; i < w.to; i++) if (map[i]! < 0) bad = true;
				if (bad) { wrong++; if (ex.length < 5) ex.push(`${JSON.stringify(cell.src)} word ${JSON.stringify(cell.src.slice(w.from, w.to))}@${w.from}: ${JSON.stringify(Array.from(map.slice(w.from, w.to)))}`); }
			}
		}
		log(`ALIGN fuzz 2: ${cells} cells, ${words} plain words, ${wrong} wrong ${ex.join(" | ")}`);
		expect(wrong).toBe(0);
	});

	it("the same source and drawn text twice: the one map, not aligned again", () => {
		const a = alignShown("beta<br>bob", "betabob"), b = alignShown("beta<br>bob", "betabob");
		expect(b).toBe(a);
		expect(alignShown("beta<br>bob", "betab")).not.toBe(a);
	});

	it("an escaped pipe: both its characters read the one pipe drawn, the letters after it their own", () => {
		expect(Array.from(alignShown("al\\|pha", "al|pha"))).toEqual([0, 1, 2, 2, 3, 4, 5]);
	});

	it("an escaped pipe in a cell with bold: both its characters read the one pipe drawn, its word's letters their own", () => {
		expect(Array.from(alignShown("**x** a\\|b", "x a|b").slice(6, 10))).toEqual([2, 3, 3, 4]);
	});

	/** k blocks of `<p><i><br>**b<i>**`: the source, the drawn text, and each block's two words' source and drawn places. */
	const longCell = (k: number, p: string) => {
		let src = "", shown = "";
		const places: [number, number][] = [];
		for (let i = 0; i < k; i++) {
			if (i) { src += " "; shown += " "; }
			places.push([src.length, shown.length]);
			src += `${p}${i}<br>**`;
			shown += `${p}${i}`;
			places.push([src.length, shown.length]);
			src += `b${i}**`;
			shown += `b${i}`;
		}
		return { src, shown, places };
	};
	for (const [k, label] of [[60, "879 x 399"], [600, "9979 x 5179"]] as const) {
		it(`a long cell with markup through it (${label} characters): every word read right, within 50 ms`, () => {
			const warm = longCell(k, "v"), cell = longCell(k, "w");
			alignShown(warm.src, warm.shown);
			const t = performance.now(), map = alignShown(cell.src, cell.shown), ms = performance.now() - t;
			log(`ALIGN long cell: ${cell.src.length} x ${cell.shown.length} in ${ms.toFixed(2)} ms`);
			expect(`${cell.src.length} x ${cell.shown.length}`, "premise").toBe(label);
			expect(cell.places.filter(([s, d]) => map[s] !== d), "words read off their drawn letter").toEqual([]);
			expect(ms).toBeLessThan(50);
		});
	}
});

describe("a table cell's entities: the characters its drawing hides", () => {
	// [a cell's source, 1 for each character hiddenInCell marks hidden].
	const PINS: [string, string][] = [
		["&amp;", "01111"],
		["&#38;x", "011110"],
		["\\&amp;", "100000"],
		["\\\\&amp;", "1000000"],
		["&amp;&lt;", "011110111"],
		["a\\&amp;&lt;", "01000000111"],
	];
	for (const [src, hidden] of PINS) {
		it(`${JSON.stringify(src)} hides ${hidden}`, () => {
			expect(Array.from(hiddenInCell(src)).join("")).toBe(hidden);
		});
	}
});

describe("mapping cost", () => {
	it("50 groups mapped through one change within 5 ms of no groups", () => {
		const doc = DOC.repeat(2000);
		const groups: AttachmentData[] = Array.from({ length: 50 }, (_, i) => record(doc, "benzene", `g${i}`, [`s${i}`]));
		const cs = insert(doc, 0, "typed above\n");
		const median = (list: AttachmentData[]): number => {
			const times: number[] = [];
			for (let i = 0; i < 101; i++) { const t = performance.now(); mapAttachments(list, cs); times.push(performance.now() - t); }
			return times.sort((a, b) => a - b)[50]!;
		};
		median(groups); median([]);
		const control = median([]), arm = median(groups);
		// Plant cost-scan: each mapping rescans the document text.
		expect(arm - control).toBeLessThan(5);
	});
});
