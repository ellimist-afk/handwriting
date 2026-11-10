/**
 * A read-only view (reading view, embeds, print) draws attached ink where the editor shows it.
 *
 * The editor shows a member stroke at its stored points plus its group's correction {dx, dy}, kept on the record as
 * `shown`, and takes the member's line anchor at that shown place (line under the shown top, top less the shown dy). A
 * read-only view draws each stroke with its own anchor's dy, plus its group's kept dx: never the record's dy, which the
 * anchor already carries. Every editor line and every rendered line here is 20 px, one block per text line, so rendered
 * tops equal the editor's and only the group's correction can move anything. Each cell names the defect that turns it red.
 */
import { describe, expect, it } from "vitest";
import type { InkStroke, LineAnchor } from "../ink/Stroke";
import type { AttachmentData, AttachmentRecord } from "./InkAttachments";
import { shownStrokes, splitLines, type BlockLines, type LineSpans } from "./EmbedInkLines";
import { aboveOf, lineKey, newAboveRun } from "./LineAnchor";

const LINE = 20;
const aboveHash = (lines: readonly string[], n: number) => aboveOf(newAboveRun(), n, (k) => lineKey(lines[k - 1]!));
const spansOf = (lines: readonly string[]): LineSpans => ({
	lines,
	blocks: lines.map((_, i): BlockLines => ({ lineStart: i, lineEnd: i, box: () => ({ top: i * LINE, height: LINE }), lineHeight: () => LINE })),
	skip: [],
});

/** A stroke stored at x, y (world units), its anchor taken as the editor takes it when the stroke is shown `dy` below. */
function stroke(id: string, x: number, y: number, lines: readonly string[], dy: number): InkStroke {
	const line = Math.floor((y + dy) / LINE) + 1;
	const a: LineAnchor = { line, top: (line - 1) * LINE - dy, y, key: lineKey(lines[line - 1]!), width: 668, fontPx: 16, above: aboveHash(lines, line) };
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		createdAt: 0,
		points: [{ x: x + 2, y: y + 2, pressure: 0.5, t: 0 }, { x: x + 30, y: y + 2, pressure: 0.5, t: 9 }],
		bbox: { x, y, width: 32, height: 12 },
		lineAnchor: a,
	} as InkStroke;
}

const record = (strokeIds: string[], shown: { dx: number; dy: number }, id = "g1"): AttachmentRecord => ({
	v: 1,
	id,
	strokeIds,
	target: { from: 8, to: 11 } as unknown as AttachmentRecord["target"],
	ref: { x: 60, y: 0 },
	layout: { width: 668, font: 16 },
	probe: { id: strokeIds[0]!, x: 62, y: 6 },
	shown,
});

describe("a read-only view draws a member where the editor shows it", () => {
	it("a member whose group moved sideways (shown dx 30, dy 0) is drawn 30 right of its stored x", () => {
		// "the cat sat", "sat" circled and attached at x 60; "big " typed before "cat" moves the group 30 right.
		// Defect: the read-only view drops the group's sideways follow and draws the circle at its stored x.
		const lines = splitLines(["the big cat sat", "free ink here", "end"].join("\n"));
		const member = stroke("m1", 60, 4, lines, 0);
		const [view] = shownStrokes([member], spansOf(lines), 1, null, [record(["m1"], { dx: 30, dy: 0 })]);
		expect(view!.bbox.y).toBe(member.bbox.y);
		expect(view!.bbox.x).toBe(member.bbox.x + 30);
		expect(view!.points[0]!.x).toBe(member.points[0]!.x + 30);
		expect(member.bbox.x, "the stored stroke is untouched").toBe(60);
	});

	it("a member whose group moved down (shown dx 0, dy 40) is drawn 40 below its stored y, once", () => {
		// Two lines typed above the attached line move the group 40 down; the editor took the anchor at the shown place.
		// Defect: the record's dy is added on top of the anchor's, and the member is drawn 80 down.
		const lines = splitLines(["new one", "new two", "the cat sat", "end"].join("\n"));
		const member = stroke("m2", 60, 4, lines, 40);
		const [view] = shownStrokes([member], spansOf(lines), 1, null, [record(["m2"], { dx: 0, dy: 40 })]);
		expect(member.lineAnchor!.line).toBe(3);
		expect(view!.bbox.y).toBe(member.bbox.y + 40);
		expect(view!.bbox.x).toBe(member.bbox.x);
	});

	it("a member moved both ways takes the anchor's dy and the group's dx", () => {
		// Defect: dx and dy taken from different places twice, or the dx dropped when the anchor moves the stroke.
		const lines = splitLines(["new one", "new two", "the big cat sat", "end"].join("\n"));
		const member = stroke("m4", 60, 4, lines, 40);
		const [view] = shownStrokes([member], spansOf(lines), 1, null, [record(["m4"], { dx: 30, dy: 40 })]);
		expect(view!.bbox.y).toBe(member.bbox.y + 40);
		expect(view!.bbox.x).toBe(member.bbox.x + 30);
	});

	it("a free stroke beside a moved group stays at its stored place", () => {
		// Defect: the sideways follow reaches ink in no group.
		const lines = splitLines(["the big cat sat", "free ink here", "end"].join("\n"));
		const member = stroke("m3", 60, 4, lines, 0);
		const free = stroke("f1", 10, 24, lines, 0);
		const list = [member, free];
		const out = shownStrokes(list, spansOf(lines), 1, null, [record(["m3"], { dx: 30, dy: 0 })]);
		expect(out[1]).toBe(free);
		expect(out[0]!.bbox.x).toBe(member.bbox.x + 30);
	});

	it("no records, an opaque record, or a group at dx 0: the list as it was", () => {
		// Defect: a view with no sideways move copies every stroke (a new list per paint), or reads an opaque record.
		const lines = splitLines(["the cat sat", "end"].join("\n"));
		const list = [stroke("m5", 60, 4, lines, 0)];
		const opaque: AttachmentData = { opaque: true, id: "g9", raw: { v: 2, id: "g9", strokeIds: ["m5"] } };
		expect(shownStrokes(list, spansOf(lines))).toBe(list);
		expect(shownStrokes(list, spansOf(lines), 1, null, [opaque])).toBe(list);
		expect(shownStrokes(list, spansOf(lines), 1, null, [record(["m5"], { dx: 0, dy: 40 })])).toBe(list);
	});

	it("a member whose anchor fails a guard is drawn at its stored place, never moved sideways only", () => {
		// Blind B2: the text under the anchor was edited outside the plugin, so its line key no longer matches and dy is 0.
		// Defect: the group's kept dx is still added, and the circle is drawn sideways at its attach line, a place never shown.
		const anchoredOn = splitLines(["new one", "new two", "the big cat sat", "end"].join("\n"));
		const member = stroke("m7", 60, 4, anchoredOn, 40);
		const now = splitLines(["new one", "new two", "the big dog sat here", "end"].join("\n"));
		const list = [member];
		const out = shownStrokes(list, spansOf(now), 1, null, [record(["m7"], { dx: 30, dy: 40 })]);
		expect(out[0]!.bbox.x).toBe(member.bbox.x);
		expect(out[0]!.bbox.y).toBe(member.bbox.y);
		expect(out, "no copy: the list as it was").toBe(list);
	});

	it("a member with no anchor (no editor ever anchored it) takes no sideways move", () => {
		// Defect: dx is applied from the record to a stroke whose dy no anchor carries.
		const lines = splitLines(["the big cat sat", "end"].join("\n"));
		const member = { ...stroke("m8", 60, 4, lines, 0), lineAnchor: undefined } as InkStroke;
		const list = [member];
		expect(shownStrokes(list, spansOf(lines), 1, null, [record(["m8"], { dx: 30, dy: 0 })])).toBe(list);
	});

	it("the same placement twice gives the same copy; a new dx gives a new one", () => {
		// Defect: the copy cache keys on dy only, so a group moved sideways again keeps its old copy.
		const lines = splitLines(["the big cat sat", "end"].join("\n"));
		const member = stroke("m6", 60, 4, lines, 0);
		const a = shownStrokes([member], spansOf(lines), 1, null, [record(["m6"], { dx: 30, dy: 0 })])[0];
		expect(shownStrokes([member], spansOf(lines), 1, null, [record(["m6"], { dx: 30, dy: 0 })])[0]).toBe(a);
		const b = shownStrokes([member], spansOf(lines), 1, null, [record(["m6"], { dx: 50, dy: 0 })])[0];
		expect(b!.bbox.x).toBe(member.bbox.x + 50);
	});
});
