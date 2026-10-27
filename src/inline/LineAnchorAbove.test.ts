/**
 * The lines-above hash on a line anchor (`above`, Stroke.ts) in the file: an older file without it reads, and its anchors
 * are honoured as that build honoured them until the editor's quiet pass gives them the hash, with no change to where the
 * ink shows; a file with it round-trips byte for byte; a record an older build wrote with the keys it knows drops it, and
 * the anchor then reads as that build read it.
 */
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { LineAnchors, aboveOf, lineKey, newAboveRun, type LineLayout } from "./LineAnchor";
import { computeBBox, settleLineAnchors, type InkStroke } from "../ink/Stroke";
import { emptyPage, parsePage, serializePage } from "../model/PageData";

const PATH = "above.md";
const ROW = 40;
const doc = Text.of(Array.from({ length: 12 }, (_, i) => `line ${i + 1} words`));

/** Line 1 `first` px tall, every other line ROW. */
function layoutOf(d: Text, first: number): LineLayout {
	return { lines: d.lines, lineText: (n) => d.line(n).text, lineTop: (n) => (n === 1 ? 0 : first + (n - 2) * ROW), pxPerWorld: 1 };
}

/** A surface on `d`, measured; line 1 `first` px tall, so an honoured anchor taken at ROW shows `first - ROW` lower. */
function surface(d: Text, first = ROW): LineAnchors {
	const layout = layoutOf(d, first);
	const a = new LineAnchors(() => layout);
	a.setSignature({ width: 892, fontPx: 26, charWidth: 14 });
	a.drawn(1, d.lines);
	a.drawn(1, d.lines, true, true);
	return a;
}

function strokeAt(id: string, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: 10 + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

/** A page holding one stroke anchored on line 6 by a surface, as the file holds it. */
function writtenPage(): string {
	const s = strokeAt("s", ROW * 5 + 3);
	const a = surface(doc);
	a.anchorNew(PATH, s);
	a.detached();
	const page = emptyPage("above");
	page.strokes = [s];
	return serializePage(page);
}

const read = (text: string): InkStroke => parsePage(text, "above").data.strokes[0]!;

/** The same file with each line anchor's record cut to the keys an older build writes. */
function knownKeysOnly(text: string): string {
	const o = JSON.parse(text) as { strokes: { lineAnchor?: Record<string, unknown> }[] };
	for (const s of o.strokes) {
		const a = s.lineAnchor;
		if (a) s.lineAnchor = { line: a.line, top: a.top, y: a.y, key: a.key, width: a.width, fontPx: a.fontPx };
	}
	return JSON.stringify(o);
}

describe("the lines-above hash in the file", () => {
	it("a surface writes it: the hash of the text above the anchor's line", () => {
		const s = read(writtenPage());
		expect(s.lineAnchor!.line).toBe(6);
		expect(s.lineAnchor!.above).toBe(aboveOf(newAboveRun(), 6, (k) => lineKey(doc.line(k).text)));
	});

	it("an anchor with it, on unchanged text, is honoured after the mount", () => {
		const s = read(writtenPage());
		const a = surface(doc, ROW + 10);
		a.tracks(PATH, [s]);
		expect(a.dyOf(s), "line 1 is 10 taller here: the stroke rides its line").toBe(10);
	});

	it("round-trips byte for byte through this build", () => {
		const text = writtenPage();
		expect(text).toContain('"above"');
		const page = parsePage(text, "above").data;
		expect(serializePage(page)).toBe(text);
	});

	it("an older file without it reads; its anchor is honoured as before, and the quiet pass gives it the hash in place", () => {
		const old = knownKeysOnly(writtenPage());
		const s = read(old);
		expect(s.lineAnchor, "the anchor reads").toBeDefined();
		expect(s.lineAnchor!.above).toBeUndefined();
		const a = surface(doc, ROW + 10);
		a.tracks(PATH, [s]);
		expect(a.dyOf(s), "honoured as an older build honours it: the stroke rides its line").toBe(10);
		// The quiet pass takes nothing new; it gives the anchor the hash of the text above its line now, and the correction
		// stays. The next save writes it.
		const line = s.lineAnchor!.line, top = s.lineAnchor!.top;
		a.drawn(1, doc.lines);
		a.drawn(1, doc.lines, true, true);
		expect(a.anchorMeasured(PATH, [s])).toBe(0);
		expect(s.lineAnchor!.line).toBe(line);
		expect(s.lineAnchor!.top).toBe(top);
		expect(s.lineAnchor!.above).toBe(aboveOf(newAboveRun(), line, (k) => lineKey(doc.line(k).text)));
		expect(a.dyOf(s)).toBe(10);
		const page = emptyPage("above");
		page.strokes = [s];
		const saved = serializePage(page);
		expect(saved).toContain('"above"');
		// From then on an edit above made where no surface saw it is caught: the next mount does not honour it.
		const edited = doc.replace(doc.line(2).from, doc.line(2).to, Text.of(["line 2 words, edited where no surface saw it"]));
		const b = surface(edited, ROW + 10);
		const again = read(saved);
		b.tracks(PATH, [again]);
		expect(b.dyOf(again), "not honoured: the stroke shows where it was drawn").toBe(0);
	});

	it("an older file's anchor, never stamped, reads as before after an edit above", () => {
		const s = read(knownKeysOnly(writtenPage()));
		const edited = doc.replace(doc.line(2).from, doc.line(2).to, Text.of(["line 2 words, edited where no surface saw it"]));
		const a = surface(edited, ROW + 10);
		a.tracks(PATH, [s]);
		expect(a.dyOf(s), "as an older build reads it").toBe(10);
	});

	it("a record an older build wrote with the keys it knows drops it, and the anchor reads as that build reads it", () => {
		const s = read(knownKeysOnly(writtenPage()));
		const a = surface(doc, ROW + 10);
		a.tracks(PATH, [s]);
		expect(s.lineAnchor!.above).toBeUndefined();
		expect(a.dyOf(s)).toBe(10);
	});

	it("a value that is not a hash is kept as found, and the anchor reads as one without it", () => {
		const o = JSON.parse(writtenPage()) as { strokes: { lineAnchor: Record<string, unknown> }[] };
		o.strokes[0]!.lineAnchor.above = "later";
		const text = JSON.stringify(o);
		const page = parsePage(text, "above").data;
		expect(page.strokes[0]!.lineAnchor!.above).toBeUndefined();
		expect((JSON.parse(serializePage(page)) as typeof o).strokes[0]!.lineAnchor.above).toBe("later");
	});
});

describe("a page write between a sync capture and its re-check", () => {
	// A sync preparation captures the note's ink, writes the page (settleLineAnchors), and checks the ink again. An anchor
	// the quiet pass or a lasso drop took must already carry its hash, so that write changes nothing the capture holds.
	const capture = (strokes: readonly InkStroke[]) => JSON.stringify(strokes);

	it("leaves an anchor the quiet pass took as captured", () => {
		const s = strokeAt("fresh", ROW * 5 + 3);
		const a = surface(doc, ROW + 10);
		a.tracks(PATH, [s]);
		a.drawn(1, doc.lines);
		a.drawn(1, doc.lines, true, true);
		expect(a.anchorMeasured(PATH, [s])).toBe(1);
		const before = capture([s]);
		const page = emptyPage("above");
		page.strokes = [s];
		settleLineAnchors();
		serializePage(page);
		expect(capture([s])).toBe(before);
		expect(s.lineAnchor!.above).toBe(aboveOf(newAboveRun(), s.lineAnchor!.line, (k) => lineKey(doc.line(k).text)));
	});

	it("leaves an older build's anchor the quiet pass gave the hash as captured", () => {
		const s = read(knownKeysOnly(writtenPage()));
		const a = surface(doc, ROW + 10);
		a.tracks(PATH, [s]);
		a.drawn(1, doc.lines);
		a.drawn(1, doc.lines, true, true);
		expect(a.anchorMeasured(PATH, [s])).toBe(0);
		const before = capture([s]);
		const page = emptyPage("above");
		page.strokes = [s];
		settleLineAnchors();
		serializePage(page);
		expect(capture([s])).toBe(before);
		expect(s.lineAnchor!.above).toBe(aboveOf(newAboveRun(), s.lineAnchor!.line, (k) => lineKey(doc.line(k).text)));
	});

	it("leaves an anchor a lasso drop took again as captured", () => {
		const s = read(writtenPage());
		const a = surface(doc, ROW + 10);
		a.tracks(PATH, [s]);
		expect(a.dyOf(s)).toBe(10);
		a.retake(PATH, [s]);
		const before = capture([s]);
		const page = emptyPage("above");
		page.strokes = [s];
		settleLineAnchors();
		serializePage(page);
		expect(capture([s])).toBe(before);
		expect(s.lineAnchor!.above).toBe(aboveOf(newAboveRun(), s.lineAnchor!.line, (k) => lineKey(doc.line(k).text)));
	});
});

describe("a saved anchor's hash through a live edit before its first read", () => {
	// Mounted on a note, the anchor not read yet; the user types above it. A hash that matched the text before the typing
	// still matches after it, and one that did not (an edit above that no surface saw) still does not: on the shift log (a
	// line typed, every line read whole) and on the eager path's keep-the-line-count branch (line 1 edited in place, the
	// anchor below it not re-taken).
	function typedAbove(text: Text, lazy: boolean): { above: number | undefined; now: number; line: number } {
		const s = read(writtenPage());
		// Every line as tall as when the anchor was taken: the stroke shows where it was drawn whether honoured or not.
		let layout = layoutOf(text, ROW);
		const a = new LineAnchors(() => layout);
		a.setSignature({ width: 892, fontPx: 26, charWidth: 14 });
		a.tracks(PATH, [s]);
		if (lazy) {
			a.drawn(1, text.lines);
			a.drawn(1, text.lines, true, true);
		}
		const spec = lazy ? { from: 0, insert: "a typed line\n" } : { from: text.line(1).to, insert: ", typed" };
		const changes = ChangeSet.of(spec, text.length);
		const after = changes.apply(text);
		layout = layoutOf(after, ROW);
		a.docChanged(PATH, [s], text, changes, after);
		expect(a.changePaths[lazy ? "lazy" : "eager"], "the path this cell is for").toBe(1);
		a.drawn(a.changedLines.from, a.changedLines.to, false);
		a.fold();
		const at = s.lineAnchor!;
		return { above: at.above, now: aboveOf(newAboveRun(), at.line, (k) => lineKey(after.line(k).text)), line: at.line };
	}

	const unseen = doc.replace(doc.line(2).from, doc.line(2).to, Text.of(["line 2 words, edited where no surface saw it"]));

	for (const [name, lazy, line] of [["on the shift log", true, 7], ["on the eager path, the line count kept", false, 6]] as const) {
		it(name, () => {
			const same = typedAbove(doc, lazy), edited = typedAbove(unseen, lazy);
			expect([same.line, edited.line], "the anchor moved with its words, not re-taken").toEqual([line, line]);
			expect(same.above, "the text above as when it was taken: the hash still matches").toBe(same.now);
			expect(edited.above, "edited above where no surface saw it: the hash is kept").toBeDefined();
			expect(edited.above, "and still does not match").not.toBe(edited.now);
		});
	}
});
