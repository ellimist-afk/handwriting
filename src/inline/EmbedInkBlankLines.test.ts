/**
 * Issue 67: ink drawn on blank lines in the editor, as a read-only view (Reading view, embeds, hover, print) shows it.
 *
 * Two notes as the reporter wrote them: (a) "Testing", five blank lines, "Testing123"; (b) eight blank lines, then
 * "Testing123". Each with and without the plugin's page-id frontmatter (three lines, hidden in the editor, crossed as
 * blank). Every editor line is 24 px; the frontmatter takes none. Rendered: one block per text line, 24 px tall, a 16 px
 * paragraph margin between blocks in place of the blank lines, the first block at the frame's top, 0. The frame's top is
 * the top of what the view can show (Reading view: the bottom of the title and Properties; an embed: its box's top), and
 * nothing scrolls above it (EmbedInk.ts:412-415). In this model the editor's first body line is at the frame's top too,
 * so a blank line shown at its editor top shows its ink where it was drawn (dy 0).
 *
 * The rule (issue 67, 2026-11-22): a blank line rides the block below only when it is the line right above that block.
 * Any other blank line keeps its distance under the block above; with none above, the run counts down from the first
 * block's top. Frontmatter is not counted. Unchanged: the 10-18 case, ink on a word whose top is in the blank line right
 * above it.
 *
 * RED at 23a4686b (the old rule, the nearest block, a tie going down): the rule's cells. GUARD (B67-4, B67-5, B67-6,
 * B67-7): green at 23a4686b and through the fix; each is planted red against the fix.
 */
import { describe, expect, it } from "vitest";
import type { InkStroke, LineAnchor } from "../ink/Stroke";
import type { AttachmentRecord } from "./InkAttachments";
import { embedInkDy, lineTopIn, shownStrokes, splitLines, type BlockLines, type LineSpans } from "./EmbedInkLines";
import { aboveOf, lineKey, newAboveRun } from "./LineAnchor";

const LINE = 24;
const MARGIN = 16;
const FM = ["---", "handwriting-page-id: 6a670000-0000-4000-8000-00000000000a", "---"];
const A_BODY = ["Testing", "", "", "", "", "", "Testing123"];
const B_BODY = ["", "", "", "", "", "", "", "", "Testing123"];

interface Note {
	name: string;
	lines: readonly string[];
	spans: LineSpans;
	/** Frontmatter lines above the body. */
	f: number;
	/** 0-based line numbers of the body's blank lines, top to bottom. */
	blanks: number[];
}

function note(name: string, body: readonly string[], fm: boolean): Note {
	const lines = splitLines([...(fm ? FM : []), ...body].join("\n"));
	const f = fm ? FM.length : 0;
	const blocks: BlockLines[] = [];
	const blanks: number[] = [];
	let top = 0;
	body.forEach((text, j) => {
		if (text === "") {
			blanks.push(f + j);
			return;
		}
		const t = top;
		blocks.push({ lineStart: f + j, lineEnd: f + j, box: () => ({ top: t, height: LINE }), lineHeight: () => LINE });
		top += LINE + MARGIN;
	});
	return { name, lines, f, blanks, spans: { lines, blocks, skip: fm ? [{ from: 0, to: f - 1 }] : [] } };
}

const A = note("a", A_BODY, false);
const A_FM = note("a with page-id frontmatter", A_BODY, true);
const B = note("b", B_BODY, false);
const B_FM = note("b with page-id frontmatter", B_BODY, true);

/** The editor's top of 1-based line n: the frontmatter is hidden, the body's first line is at 0. */
const editorTop = (N: Note, n: number) => (n - 1 - N.f) * LINE;
const aboveIn = (lines: readonly string[], n: number) => aboveOf(newAboveRun(), n, (k) => lineKey(lines[k - 1]!));

let serial = 0;
/** A stroke whose bbox top sits `below` px under editor line n's top (1-based), anchored there as the editor would. */
function anchored(N: Note, n: number, below = 4, x = 8): InkStroke {
	const y = editorTop(N, n) + below;
	const a: LineAnchor = { line: n, top: editorTop(N, n), y, key: lineKey(N.lines[n - 1]!), width: 668, fontPx: 16, above: aboveIn(N.lines, n) };
	return {
		id: `b${serial++}`,
		tool: "pen",
		color: "#000000",
		width: 2,
		createdAt: 0,
		points: [{ x: x + 2, y: y + 2, pressure: 0.5, t: 0 }, { x: x + 32, y: y + 2, pressure: 0.5, t: 9 }],
		bbox: { x, y, width: 34, height: 4 },
		lineAnchor: a,
	} as InkStroke;
}

/** The blank lines of a note less the last one, the line right above the text below. */
const notRightAbove = (N: Note) => N.blanks.slice(0, -1);
const rightAbove = (N: Note) => N.blanks[N.blanks.length - 1]!;

describe("RED at 23a4686b: a blank line not right above the text below keeps its place (issue 67)", () => {
	it.each([A, A_FM])("note $name: each blank line under \"Testing\" keeps its distance under it, at its editor top", (N) => {
		// "Testing" is 0 to 24. Body lines 1 to 4 are 24, 48, 72, 96: their editor tops. Today 24, 48, -32, -8 (the middle
		// is a tie and goes down; then the lines ride "Testing123", which the view pulled up).
		const got = notRightAbove(N).map((i) => lineTopIn(N.spans, i));
		expect(got).toEqual(notRightAbove(N).map((i) => editorTop(N, i + 1)));
	});

	it.each([B, B_FM])("note $name: no text above, the run counts down from the first block's top, frontmatter not counted", (N) => {
		// "Testing123" is the first block, at 0. Body lines 0 to 6 are 0 to 144: their editor tops. Today -192 to -48.
		const got = notRightAbove(N).map((i) => lineTopIn(N.spans, i));
		expect(got).toEqual(notRightAbove(N).map((i) => editorTop(N, i + 1)));
	});

	it.each([A, A_FM, B, B_FM])("note $name: a stroke on each blank line not right above the text is shown where it was drawn (dy 0)", (N) => {
		const strokes = notRightAbove(N).map((i) => anchored(N, i + 1, 10));
		const shown = shownStrokes(strokes, N.spans);
		expect(shown.map((s) => s.bbox.y)).toEqual(strokes.map((s) => s.bbox.y));
		// None above the frame's top: the rig's "none above the header's bottom".
		expect(shown.every((s) => s.bbox.y >= 0)).toBe(true);
	});

	it("the middle of note a's gap (today's tie): strokes on body lines 3 and 4 are shown 24 px apart, at their editor tops", () => {
		// Body lines 3 and 4, 1-based, are blank lines 2 and 3 of the gap. Today the lower one is shown 80 px above the upper.
		const upper = anchored(A, 3), lower = anchored(A, 4);
		const [u, l] = shownStrokes([upper, lower], A.spans);
		expect([u!.bbox.y, l!.bbox.y]).toEqual([upper.bbox.y, lower.bbox.y]);
		expect(l!.bbox.y - u!.bbox.y).toBe(LINE);
	});

	it("text with no block above a run (a comment line): the run counts down from the block below's top (a block above that text blocks counts as none above)", () => {
		// "Text", a comment line the view renders as nothing, three blank lines, "More". The comment has no block, so no
		// block above is on a clear path. Blank lines 2 and 3 count down from "More"'s top (40); line 4 is right above it.
		// Today: -32 and -8 (they ride "More").
		const lines = ["Text", "%% a comment %%", "", "", "", "More"];
		const blocks: BlockLines[] = [
			{ lineStart: 0, lineEnd: 0, box: () => ({ top: 0, height: LINE }), lineHeight: () => LINE },
			{ lineStart: 5, lineEnd: 5, box: () => ({ top: LINE + MARGIN, height: LINE }), lineHeight: () => LINE },
		];
		const spans: LineSpans = { lines, blocks, skip: [] };
		expect([2, 3, 4].map((i) => lineTopIn(spans, i))).toEqual([40, 64, 16]);
	});
});

describe("GUARD, green at 23a4686b: what the rule keeps", () => {
	it.each([A, A_FM])("note $name: the line right above \"Testing123\" rides it, one line above its top (the 10-18 case)", (N) => {
		expect(lineTopIn(N.spans, rightAbove(N))).toBe(LINE + MARGIN - LINE);
	});

	it.each([B, B_FM])("note $name: the line right above \"Testing123\" rides it, one line above its top (the 10-18 case)", (N) => {
		expect(lineTopIn(N.spans, rightAbove(N))).toBe(0 - LINE);
	});

	it("ink on a word whose top pokes into the blank line right above it stays on the word (the 10-18 case)", () => {
		// A stroke written on "Testing123" in note a, its top 20 px into the blank line above: anchored on that blank line.
		// In the editor it is 4 px above the word's top; shown 4 px above the word's rendered top.
		const s = anchored(A, rightAbove(A) + 1, 20);
		const [v] = shownStrokes([s], A.spans);
		expect(v!.bbox.y).toBe(LINE + MARGIN - 4);
	});
});

describe("GUARD, green at 23a4686b and through the fix: what a fix must not move", () => {
	it.each([A, A_FM])("ink on a text line of note $name stays on its word: dy is the block's top less the editor's (B67-4)", (N) => {
		const first = N.f + 1, last = N.f + A_BODY.length;
		expect(embedInkDy(anchored(N, first), N.spans)).toBe(0 - editorTop(N, first));
		expect(embedInkDy(anchored(N, last), N.spans)).toBe(LINE + MARGIN - editorTop(N, last));
	});

	it("a stroke with no anchor keeps its page position: drawn as stored, the same object (B67-4)", () => {
		const free = { ...anchored(A, 3), id: "free", lineAnchor: undefined } as InkStroke;
		const list = [anchored(A, 1), free];
		const shown = shownStrokes(list, A.spans);
		expect(shown[1]).toBe(free);
	});

	it.each([A, A_FM, B, B_FM])("every blank line of note $name has a top: never null (B67-5)", (N) => {
		const t = N.blanks.map((i) => lineTopIn(N.spans, i));
		expect(t.every((v) => typeof v === "number" && Number.isFinite(v)), `blank line tops ${JSON.stringify(t)}`).toBe(true);
	});

	it("an attached member anchored on blank line 1 of note b keeps its group's sideways move, dx 30 (B67-5)", () => {
		const member = { ...anchored(B, 1, 4, 60), id: "m67" } as InkStroke;
		const record: AttachmentRecord = {
			v: 1,
			id: "g67",
			strokeIds: ["m67"],
			target: { from: 8, to: 18 } as unknown as AttachmentRecord["target"],
			ref: { x: 60, y: 0 },
			layout: { width: 668, font: 16 },
			probe: { id: "m67", x: 62, y: 6 },
			shown: { dx: 30, dy: 0 },
		};
		const [view] = shownStrokes([member], B.spans, 1, null, [record]);
		expect(view!.bbox.x).toBe(member.bbox.x + 30);
	});

	it("strokes on blank lines 1 and 3 of note b keep their editor distance, 48 px: no clamp piles them on one line (B67-6)", () => {
		const one = anchored(B, 1), three = anchored(B, 3);
		const [o, t] = shownStrokes([one, three], B.spans);
		expect(t!.bbox.y - o!.bbox.y).toBe(2 * LINE);
	});

	it.each([A, A_FM, B, B_FM])("showing note $name writes nothing: each stored stroke's points, bbox and line anchor are as they were (B67-7)", (N) => {
		const strokes = N.blanks.map((i) => anchored(N, i + 1, 10)).concat(anchored(N, N.lines.length));
		const before = JSON.stringify(strokes);
		const shown = shownStrokes(strokes, N.spans);
		expect(JSON.stringify(strokes)).toBe(before);
		// A stroke shown away from its page position is a copy; the stored one is not handed out.
		shown.forEach((s, k) => {
			if (s.bbox.y !== strokes[k]!.bbox.y) expect(s).not.toBe(strokes[k]);
		});
	});
});
