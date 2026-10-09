/**
 * A stroke in a file is never dropped on load. Two strokes under one id (a hand edit, an outside merge tool, a sync
 * client's union merge) are two strokes: the second gets a name of its own, the first `<id>-N` that nothing in the
 * file carries (strokes, text boxes and images share one id space through unknownByObject). An exact copy, equal in
 * every field, is one stroke written twice and loads once: kept twice, a highlighter copy would draw darker. A new
 * name the id rules refuse counts as an unusable id at this read, so the note locks instead of losing the stroke.
 */
import { expect, it } from "vitest";
import { parsePage } from "./PageData";

function raw(id: string, y: number, extra: Record<string, unknown> = {}) {
	return { id, tool: "pen", color: "#000000", width: 2, createdAt: 1, pts: [0, y, 0.5, 0, 10, y, 0.5, 8], ...extra };
}
function file(strokes: unknown[], more: Record<string, unknown> = {}): string {
	return JSON.stringify({ schemaVersion: 1, pageId: "p1", surface: "inline", textBoxes: [], images: [], strokes, ...more });
}
const ys = (r: ReturnType<typeof parsePage>) => r.data.strokes.map((s) => s.points[0]!.y);
const ids = (r: ReturnType<typeof parsePage>) => r.data.strokes.map((s) => s.id);

it("two different strokes under one id both load, the second under a name of its own", () => {
	const r = parsePage(file([raw("s1", 0), raw("s1", 50)]), "p1");
	expect(r.damaged).toBeFalsy();
	expect(ys(r)).toEqual([0, 50]);
	expect(ids(r)).toEqual(["s1", "s1-2"]);
});

it("an exact copy loads once", () => {
	const r = parsePage(file([raw("s1", 0), raw("s1", 0)]), "p1");
	expect(r.damaged).toBeFalsy();
	expect(ids(r)).toEqual(["s1"]);
});

it("id, id, id-2: three strokes, and the real id-2 keeps its name", () => {
	const r = parsePage(file([raw("s1", 0), raw("s1", 50), raw("s1-2", 100)]), "p1");
	expect(r.damaged).toBeFalsy();
	expect(ys(r)).toEqual([0, 50, 100]);
	const named = Object.fromEntries(r.data.strokes.map((s) => [s.points[0]!.y, s.id]));
	expect(named[100], "the file's own s1-2 keeps its name").toBe("s1-2");
	expect(new Set(ids(r)).size, "three distinct ids").toBe(3);
	expect(named[50]).toBe("s1-3");
});

it("three different strokes under one id load as id, id-2, id-3", () => {
	const r = parsePage(file([raw("s1", 0), raw("s1", 50), raw("s1", 100)]), "p1");
	expect(r.damaged).toBeFalsy();
	expect(ys(r)).toEqual([0, 50, 100]);
	expect(ids(r), "each new name is taken before the next is chosen").toEqual(["s1", "s1-2", "s1-3"]);
});

it("a new name never takes an id a text box or an image carries", () => {
	const r = parsePage(file([raw("s1", 0), raw("s1", 50)], {
		textBoxes: [{ id: "s1-2", x: 0, y: 0 }],
		images: [{ id: "s1-3", x: 0, y: 0, width: 10, height: 10, path: "a.png" }],
	}), "p1");
	expect(ids(r)).toEqual(["s1", "s1-4"]);
});

it("unknown fields stay with each stroke under its own name", () => {
	const r = parsePage(file([raw("s1", 0, { future: "a" }), raw("s1", 50, { future: "b" })]), "p1");
	expect(ids(r)).toEqual(["s1", "s1-2"]);
	expect(r.data.unknownByObject["s1"]).toEqual({ future: "a" });
	expect(r.data.unknownByObject["s1-2"]).toEqual({ future: "b" });
});

it("the same file read twice names its strokes the same", () => {
	const text = file([raw("s1", 0), raw("s1", 50), raw("s1", 70)]);
	expect(ids(parsePage(text, "p1"))).toEqual(ids(parsePage(text, "p1")));
});

it("a new name the id rules refuse counts as an unusable id, so the note locks instead of losing the stroke", () => {
	const long = "a".repeat(127);
	const r = parsePage(file([raw(long, 0), raw(long, 50)]), "p1");
	expect(r.damaged, "the second stroke cannot be named: the read is lossy").toBe(true);
});
