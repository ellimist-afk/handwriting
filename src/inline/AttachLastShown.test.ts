/**
 * A group whose target text is lost reopens where it was last shown, not where it was first attached. The page keeps the
 * group's last correction beside its record; a reopen that cannot find the target shows the group by it. Stored stroke
 * points never change. A follow, the page writer and reader, and the text resolver; for the measure's write, a bare
 * overlay over a note in the store with a fake view: no DOM, no layout read.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { AttachFollow, applyAttachOp, type FollowMeasure } from "./AttachFollow";
import { resolveAttachments, targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import type { InkStroke } from "../ink/Stroke";

const DOC = "Intro line here.\nThe word benzene sits in this line.\nLast line of the note.\n";
/** Editor px per line, and editor px per world unit: a line is 20 world units. */
const LH = 40, PX = 2;
const lineOf = (doc: string, pos: number) => doc.slice(0, pos).split("\n").length - 1;
const blockTopIn = (doc: string) => (pos: number) => lineOf(doc, pos) * LH;
const record = (): AttachmentRecord => {
	const from = DOC.indexOf("benzene");
	return { v: 1, id: "att-1", strokeIds: ["s1", "s2"], target: targetAt(DOC, from, from + 7, "range"), ref: { x: 36, y: 20 }, layout: { width: 672, font: 19 }, probe: { id: "s1", x: 40, y: 24 } };
};
const apply = (doc: string, cs: ChangeSet) => cs.apply(Text.of(doc.split("\n"))).toString();
const stroke = (id: string, y: number): InkStroke => ({
	id, tool: "pen", color: "#000000", width: 2,
	points: [{ x: 40, y, pressure: 0.5, t: 0 }, { x: 60, y: y + 8, pressure: 0.5, t: 8 }],
	bbox: { x: 40, y, width: 20, height: 8 }, createdAt: 1,
}) as InkStroke;
const STROKES = [stroke("s1", 24), stroke("s2", 30)];

/** The page as written with this list and read back: what a reopen finds. */
function written(list: readonly AttachmentData[], strip = false): AttachmentData[] {
	const json = serializePage({ ...emptyPage("pg-last-shown"), strokes: STROKES, attachments: [...list] });
	let text = json;
	if (strip) {
		const o = JSON.parse(json) as { attachments: Array<Record<string, unknown>> };
		for (const a of o.attachments) delete a.shown;
		text = JSON.stringify(o);
	}
	const back = parsePage(text, "pg-last-shown").data;
	expect(back.strokes.map((s) => s.points[0]!.y)).toEqual([24, 30]);
	return back.attachments ?? [];
}

/** Attach on line 1, then a line typed above: the follow shows the group one line (20 world units) lower. */
function followedDown(): { follow: AttachFollow; doc: string; list: readonly AttachmentData[] } {
	const follow = new AttachFollow();
	follow.setList([record()]);
	follow.attached(record(), LH);
	const cs = ChangeSet.of([{ from: 0, insert: "a\n" }], DOC.length);
	const doc = apply(DOC, cs);
	const list = follow.docChanged(cs, blockTopIn(doc), PX);
	expect(follow.groupOffset("att-1")).toEqual({ dx: 0, dy: 20 });
	return { follow, doc, list };
}

/**
 * followedDown on a bare overlay over a note in the store: its editor update maps the target and writes the list.
 * `measure` runs the follow's measure as the editor does, read then write, with the typed line taller than the height
 * map's guess by `taller` editor px. `writes`: the page writes so far.
 */
function overlayFollowedDown(path: string): { overlay: InkOverlayPlugin; doc: string; measure: (taller: number) => void; writes: () => number } {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [record()] };
	let writes = 0;
	Object.defineProperty(inlineInk, "persist", { value: () => { writes++; }, configurable: true });
	const state = { doc: Text.of(DOC.split("\n")) };
	let shift = 0;
	// The typed line is the first: the lines below it start `shift` px lower than the height map guessed.
	const top = (pos: number) => {
		const line = lineOf(state.doc.toString(), pos);
		return line === 0 ? 0 : line * LH + shift;
	};
	const view = {
		scaleY: PX, viewport: { from: 0, to: Infinity }, lineBlockAt: (pos: number) => ({ top: top(pos) }),
		requestMeasure: (req: { read: () => unknown; write: (m: unknown) => void }) => req.write(req.read()),
	};
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, {
		view, fontZoom: 1, lineAnchorState: new LineAnchors(() => null), lineAnchorsMoved: () => {}, filePath: () => path,
		followRefAt: (pos: number) => ({ x: 36, y: top(pos) / PX }),
	});
	const follow = overlay.lineAnchors.follow;
	follow.setList(inlineInk.attachments(path));
	follow.attached(record(), LH);
	const changes = ChangeSet.of([{ from: 0, insert: "a\n" }], state.doc.length);
	state.doc = changes.apply(state.doc);
	overlay.followDocChanged(path, { changes } as unknown as ViewUpdate);
	expect(follow.groupOffset("att-1")).toEqual({ dx: 0, dy: 20 });
	const measure = (taller: number) => {
		shift = taller;
		overlay.requestFollowMeasure();
	};
	return { overlay, doc: state.doc.toString(), measure, writes: () => writes };
}

/** The note's text with the target's word deleted. */
const withoutTarget = (doc: string) => doc.replace("benzene ", "");

/** A reopen: a new follow on the page as read, the target resolved against `doc`. */
function reopened(list: AttachmentData[], doc: string): AttachFollow {
	const { list: resolved, status } = resolveAttachments(list, doc);
	const follow = new AttachFollow();
	follow.setList(resolved, status);
	return follow;
}

describe("a group whose target is lost reopens where it was last shown", () => {
	it("followed one line down, written, its target deleted, reopened: shown one line down", () => {
		// Defect: a held group's correction is 0 at reopen, so the ink jumps back up by everything it followed.
		const { doc, list } = followedDown();
		const back = written(list);
		const follow = reopened(back, withoutTarget(doc));
		expect(follow.followsText("att-1")).toBe(false);
		expect(follow.groupOffset("att-1")).toEqual({ dx: 0, dy: 20 });
		expect(follow.offsetOf("s1")).toEqual({ dx: 0, dy: 20 });
	});

	it("the target deleted in the session, then a write: reopened one line down, its stored points unchanged", () => {
		// Defect: the write after the delete drops what the group showed, so the reopen shows it at its Attach-time place.
		const { follow, doc } = followedDown();
		const gone = withoutTarget(doc), del = ChangeSet.of([{ from: doc.indexOf("benzene "), to: doc.indexOf("benzene ") + 8 }], doc.length);
		const after = follow.docChanged(del, blockTopIn(gone), PX);
		expect(follow.groupOffset("att-1")).toEqual({ dx: 0, dy: 20 });
		const back = written(after);
		expect(reopened(back, gone).groupOffset("att-1")).toEqual({ dx: 0, dy: 20 });
	});

	it("a move only the measure found, then the target deleted and the page written: reopened where last shown", () => {
		// Defect: the page keeps the correction of the last text change that moved the group, not the one shown at the write.
		// The typed line is taller than the height map's guess (a heading): only the measure finds the 10 world units more.
		const { follow, doc } = followedDown();
		const view: FollowMeasure = { inView: () => true, refAt: (pos) => ({ x: 36, y: (blockTopIn(doc)(pos) + 20) / PX }), blockTop: (pos) => blockTopIn(doc)(pos) + 20 };
		follow.measure(view);
		expect(follow.groupOffset("att-1"), "premise: the measure shows the group 30 down").toEqual({ dx: 0, dy: 30 });
		const gone = withoutTarget(doc), at = doc.indexOf("benzene ");
		const after = follow.docChanged(ChangeSet.of([{ from: at, to: at + 8 }], doc.length), (pos) => blockTopIn(gone)(pos) + 20, PX);
		expect(follow.groupOffset("att-1"), "premise: the held group shows where it was").toEqual({ dx: 0, dy: 30 });
		expect(reopened(written(after), gone).groupOffset("att-1"), "reopened where last shown").toEqual({ dx: 0, dy: 30 });
	});

	it("a move only the measure found, then a page write with no text change, the target lost elsewhere: reopened where last shown", () => {
		// Defect: the measure's move stays out of the store's list, so a page written by a stroke or an erase keeps the
		// correction of the last text change, and the reopen shows the group half a line above where it was last seen.
		const path = "last-shown-measure-write.md";
		const { overlay, doc, measure, writes } = overlayFollowedDown(path);
		const before = writes();
		measure(20);
		expect(overlay.lineAnchors.follow.groupOffset("att-1"), "premise: the measure shows the group 30 down").toEqual({ dx: 0, dy: 30 });
		expect(writes(), "the measure writes no page").toBe(before);
		expect(reopened(written(inlineInk.attachments(path)), withoutTarget(doc)).groupOffset("att-1"), "reopened where last shown").toEqual({ dx: 0, dy: 30 });
	});

	it("control: a measure that finds no move leaves the store's list as it is", () => {
		const path = "last-shown-measure-same.md";
		const { measure } = overlayFollowedDown(path);
		const list = inlineInk.attachments(path);
		measure(0);
		expect(inlineInk.attachments(path)).toBe(list);
	});

	it("a move only the measure found, then a text change that leaves the group, written, the target lost elsewhere: reopened where last shown", () => {
		const { follow, doc } = followedDown();
		const view: FollowMeasure = { inView: () => true, refAt: (pos) => ({ x: 36, y: (blockTopIn(doc)(pos) + 20) / PX }), blockTop: (pos) => blockTopIn(doc)(pos) + 20 };
		follow.measure(view);
		expect(follow.groupOffset("att-1"), "premise: the measure shows the group 30 down").toEqual({ dx: 0, dy: 30 });
		const at = doc.indexOf("The word"), cs = ChangeSet.of([{ from: at, insert: "x" }], doc.length), doc2 = apply(doc, cs);
		const after = follow.docChanged(cs, (pos) => blockTopIn(doc2)(pos) + 20, PX);
		expect(follow.groupOffset("att-1"), "premise: the change leaves the group 30 down").toEqual({ dx: 0, dy: 30 });
		expect(reopened(written(after), withoutTarget(doc2)).groupOffset("att-1"), "reopened where last shown").toEqual({ dx: 0, dy: 30 });
	});

	it("control: a page written without the last correction reopens as today, at the stored points", () => {
		const { doc, list } = followedDown();
		const back = written(list, true);
		expect(reopened(back, withoutTarget(doc)).groupOffset("att-1")).toEqual({ dx: 0, dy: 0 });
	});

	it("control: a target found at reopen is read again; the kept correction is not shown first", () => {
		// Two lines were typed above on another device: the target is found two lines further down, and the read decides.
		const { doc, list } = followedDown();
		const back = written(list), moved = "b\nc\n" + doc;
		const follow = reopened(back, moved);
		expect(follow.followsText("att-1")).toBe(true);
		expect(follow.groupOffset("att-1")).toBeNull();
		const view: FollowMeasure = { inView: () => true, refAt: (pos) => ({ x: 36, y: blockTopIn(moved)(pos) / PX }), blockTop: blockTopIn(moved) };
		follow.measure(view);
		expect(follow.groupOffset("att-1")).toEqual({ dx: 0, dy: 60 });
	});

	it("control: an Attach step still undoes on a record that carries a kept correction", () => {
		// Defect: the kept correction makes the record differ from the step's, so the undo is spent and nothing happens.
		// The step's record is the one Attach made; the list's was followed one line down since (its target mapped by the typing).
		const { list } = followedDown();
		expect(applyAttachOp(list, { type: "attach", id: "att-1", before: record(), after: null }, true)).toEqual([]);
	});

	it("control: with no text change in the step, an Attach still undoes on a record that carries a kept correction", () => {
		// Defect: as above, on the branch for a step that changes no text: the record matches the step's but for the kept correction.
		const { list } = followedDown();
		const kept = list[0] as AttachmentRecord;
		expect(kept.shown, "premise: the list's record carries a kept correction").toEqual({ dx: 0, dy: 20 });
		const before: AttachmentRecord = { ...kept };
		delete before.shown;
		expect(applyAttachOp(list, { type: "attach", id: "att-1", before, after: null }, false)).toEqual([]);
	});
});
