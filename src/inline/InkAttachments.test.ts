/**
 * Ink attached to text: the model's acceptance cells, A1 to A15 where the model alone can answer them. Nothing is mounted
 * and no stroke point is written. Each cell names the defect that must turn it red.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import {
	applyAttachStep,
	attachGroup,
	attachmentMembership,
	attachmentSelection,
	detachGroup,
	followOffset,
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
	it("one group: Detach on; group plus free: Attach gives the union, Detach off; two groups: Detach on, Attach off", () => {
		expect(attachmentSelection(two, ["a"])).toMatchObject({ attach: true, detach: true, groupIds: ["g1"], expandedIds: ["a", "b"] });
		expect(attachmentSelection(two, ["a", "free"])).toMatchObject({ attach: true, detach: false, groupIds: ["g1"] });
		expect(attachmentSelection(two, ["a", "c"])).toMatchObject({ attach: false, detach: true, groupIds: ["g1", "g2"] });
		expect(attachmentSelection(two, ["a", "c", "free"]), "loose ink in the lasso").toMatchObject({ attach: false, detach: true, groupIds: ["g1", "g2"] });
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
