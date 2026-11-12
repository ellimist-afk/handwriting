/**
 * The marks (held tags, link icons) are worked out again on a committed paint only when something they show moved: a
 * group's correction, a member stroke, the selection, which groups are held, or a held group's kept correction. A
 * keystroke that hands over a new list object, every record mapped to new offsets with nothing a mark shows changed, leaves
 * them as they are, a following group's newly stamped kept correction included. Each other change still marks them stale.
 * Bare overlay stand-ins: no DOM, no layout.
 */
import { describe, expect, it } from "vitest";
import { heldTagsStale, refreshHeldTags, staleTagsOnPaint, type ChromeOverlay } from "./AttachDecoration";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import type { AttachmentData, AttachmentRecord, OpaqueAttachment } from "./InkAttachments";

const PATH = "note.md";

function stroke(id: string, x: number, y: number): InkStroke {
	const points = [{ x, y, pressure: 0.5, t: 0 }, { x: x + 20, y: y + 10, pressure: 0.5, t: 1 }];
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 0), createdAt: 1 };
}

function record(id: string, from: number, strokeIds: string[]): AttachmentRecord {
	return {
		v: 1, id, strokeIds,
		target: { kind: "range", from, to: from + 5, text: "words", before: "", after: "" },
		ref: { x: 0, y: from }, layout: { width: 600, font: 16 }, probe: { id: strokeIds[0]!, x: 0, y: 0 },
	};
}

/** A keystroke above every group: each record mapped one place on, a new list object, nothing a mark shows changed. */
const typed = (list: readonly AttachmentData[]): AttachmentData[] =>
	list.map((a) => ("opaque" in a ? a : { ...a, target: { ...a.target, from: a.target.from + 1, to: a.target.to + 1 } }));

function rig(list: AttachmentData[]) {
	const strokes = [stroke("s1", 10, 10), stroke("s2", 30, 30), stroke("s3", 300, 300), stroke("s4", 320, 320)];
	const members = new Map<string, readonly InkStroke[]>([["g1", strokes.slice(0, 2)], ["g2", strokes.slice(2, 4)]]);
	const held = new Set<string>();
	const follow = {
		attachments: list as readonly AttachmentData[],
		generation: 0,
		setList(l: readonly AttachmentData[]) { follow.attachments = l; },
		followsText(id: string) {
			const r = follow.attachments.find((a) => !("opaque" in a) && a.id === id) as AttachmentRecord | undefined;
			return !!r && !held.has(id) && r.target.to > r.target.from;
		},
		groupOffset: () => ({ dx: 0, dy: 0 }),
		memberMap: new Map<string, string>(),
	};
	const selection = { strokeIds: [] as string[], revision: 0, isEmpty: true };
	const o = {
		filePath: () => PATH,
		selection,
		lineAnchors: { follow, freeFor: () => ({ free: [], members }) },
		view: { dom: { isConnected: false }, dispatch: () => {} },
		camera: { snapshot: { x: 0, y: 0, zoom: 1 } },
		cssScale: 1,
		damage: { addRect: () => {} },
		refreshStrip: () => {},
		scheduleRepaint: () => {},
	} as unknown as ChromeOverlay;
	/** One committed paint: the check, then the refresh it may ask for. Answers whether the check found the marks stale. */
	const paint = (l: readonly AttachmentData[], gen = 0): boolean => {
		staleTagsOnPaint(o, l, strokes, gen);
		const stale = heldTagsStale(o);
		refreshHeldTags(o, l, strokes, gen, 1, "all");
		return stale;
	};
	return { o, follow, held, selection, strokes, paint };
}

const TWO: AttachmentData[] = [record("g1", 10, ["s1", "s2"]), record("g2", 40, ["s3", "s4"])];

describe("a keystroke's new list object alone leaves the marks as they are", () => {
	it("every record mapped on, the follow holding the new list: not stale", () => {
		const r = rig(TWO);
		expect(r.paint(TWO), "premise: the first paint works the marks out").toBe(true);
		const next = typed(TWO);
		r.follow.attachments = next;
		expect(r.paint(next), "a new list object with nothing a mark shows changed").toBe(false);
	});

	it("thirty keystrokes in a row: the marks are worked out once, at the first paint", () => {
		const r = rig(TWO);
		let list: readonly AttachmentData[] = TWO, stale = r.paint(list) ? 1 : 0;
		for (let i = 0; i < 30; i++) {
			list = typed(list);
			r.follow.attachments = list;
			if (r.paint(list)) stale++;
		}
		expect(stale).toBe(1);
	});

	it("a keystroke that stamps a following group's kept correction: not stale", () => {
		const r = rig(TWO);
		r.paint(TWO);
		const next = typed(TWO).map((a) => ("opaque" in a || a.id !== "g1" ? a : { ...a, shown: { dx: 0, dy: 12 } }));
		r.follow.attachments = next;
		expect(r.paint(next), "a following group's kept correction is the keystroke's stamp, not a mark's place").toBe(false);
	});
});

describe("every change a mark shows still marks them stale", () => {
	it("a group turned held under the new list", () => {
		const r = rig(TWO);
		r.paint(TWO);
		const next = typed(TWO);
		r.follow.attachments = next;
		r.held.add("g2");
		expect(r.paint(next)).toBe(true);
	});

	it("a target deleted by the keystroke (collapsed)", () => {
		const r = rig(TWO);
		r.paint(TWO);
		const next = typed(TWO).map((a) => ("opaque" in a || a.id !== "g1" ? a : { ...a, target: { ...a.target, to: a.target.from } }));
		r.follow.attachments = next;
		expect(r.paint(next)).toBe(true);
	});

	it("a held group freed under the new list", () => {
		const r = rig(TWO);
		r.held.add("g2");
		r.paint(TWO);
		const next = typed(TWO);
		r.follow.attachments = next;
		r.held.delete("g2");
		expect(r.paint(next)).toBe(true);
	});

	it("a held group whose kept correction alone moved under the new list (another pane's stamp)", () => {
		const r = rig(TWO);
		r.held.add("g2");
		expect(r.paint(TWO), "premise: the first paint works the marks out").toBe(true);
		const next = TWO.map((a) => ("opaque" in a || a.id !== "g2" ? a : { ...a, shown: { dx: 0, dy: 12 } }));
		r.follow.attachments = next;
		expect(r.paint(next), "a held group's tag sits at its kept correction: a new one moves the tag").toBe(true);
	});

	it("a held group whose kept correction alone moved sideways under the new list", () => {
		const r = rig(TWO);
		r.held.add("g2");
		expect(r.paint(TWO), "premise: the first paint works the marks out").toBe(true);
		const next = TWO.map((a) => ("opaque" in a || a.id !== "g2" ? a : { ...a, shown: { dx: 8, dy: 0 } }));
		r.follow.attachments = next;
		expect(r.paint(next), "a held group's tag sits at its kept correction: a sideways one moves the tag").toBe(true);
	});

	it("a deleted target found again by the keystroke (undo of the delete)", () => {
		const gone = TWO.map((a) => ("opaque" in a || a.id !== "g1" ? a : { ...a, target: { ...a.target, to: a.target.from } }));
		const r = rig(gone);
		expect(r.paint(gone), "premise: the first paint works the marks out").toBe(true);
		const next = typed(TWO);
		r.follow.attachments = next;
		expect(r.paint(next)).toBe(true);
	});

	it("a record gone from the list", () => {
		const r = rig(TWO);
		r.paint(TWO);
		const next = typed(TWO).slice(0, 1);
		r.follow.attachments = next;
		expect(r.paint(next)).toBe(true);
	});

	it("the same records in another order", () => {
		const r = rig(TWO);
		r.paint(TWO);
		const next = typed(TWO).reverse();
		r.follow.attachments = next;
		expect(r.paint(next)).toBe(true);
	});

	it("an opaque record replaced by another object", () => {
		const op: OpaqueAttachment = { opaque: true, id: "op", raw: { strokeIds: ["s1"] } };
		const list: AttachmentData[] = [...TWO, op], r = rig(list);
		r.paint(list);
		const next = [...typed(TWO), { opaque: true, id: "op", raw: { strokeIds: ["s3"] } } as OpaqueAttachment];
		r.follow.attachments = next;
		expect(r.paint(next)).toBe(true);
	});

	it("the follow not yet holding the new list (another pane's list)", () => {
		const r = rig(TWO);
		r.paint(TWO);
		expect(r.paint(typed(TWO))).toBe(true);
	});

	it("a correction moved (the follow's generation)", () => {
		const r = rig(TWO);
		r.paint(TWO);
		r.follow.generation++;
		expect(r.paint(TWO)).toBe(true);
	});

	it("a member stroke moved (the stroke list's generation)", () => {
		const r = rig(TWO);
		r.paint(TWO);
		expect(r.paint(TWO, 1)).toBe(true);
	});

	it("the selection moved", () => {
		const r = rig(TWO);
		r.paint(TWO);
		r.selection.revision++;
		expect(r.paint(TWO)).toBe(true);
	});

	it("a keystroke kept, then a group turned held at the next: the kept state is the newest list's", () => {
		const r = rig(TWO);
		r.paint(TWO);
		const a = typed(TWO);
		r.follow.attachments = a;
		expect(r.paint(a), "premise: the first keystroke kept the marks").toBe(false);
		const b = typed(a);
		r.follow.attachments = b;
		r.held.add("g1");
		expect(r.paint(b)).toBe(true);
	});
});
