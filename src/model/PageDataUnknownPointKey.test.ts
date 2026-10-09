/**
 * A STROKE WHOSE POINTS SIT UNDER A KEY THIS BUILD DOES NOT READ MARKS THE FILE DAMAGED.
 *
 * This build reads a stroke's points from `ptsd`, `pts` or `points`. A newer
 * build that stores them under another key wrote a stroke this build cannot
 * draw. It was dropped with no loss counted, so the file read as whole, the
 * note stayed writable, and the next save wrote the page without that stroke:
 * the ink was gone for the build that drew it too. A file that does not come
 * back whole is damaged, and the damage lock keeps it from being written over.
 *
 * Assertions state the CORRECT behaviour: green = no bug, red = bug. Controls:
 * a stroke with readable points loads whole, and a stroke that holds nothing
 * at all beyond its own fields is still dropped with nothing lost.
 */
import { describe, expect, it } from "vitest";
import { parsePage } from "./PageData";

function fileWith(strokes: Record<string, unknown>[]): string {
	return JSON.stringify({ schemaVersion: 1, pageId: "p1", surface: "inline", strokes, textBoxes: [], images: [] });
}

const base = { tool: "pen", color: "#4b7bec", width: 2.2, createdAt: 1 };

describe("a stroke with points under an unknown key", () => {
	it("control: a stroke with readable points loads whole", () => {
		const parsed = parsePage(fileWith([{ id: "s1", ...base, pts: [0, 0, 0.5, 0, 10, 0, 0.5, 8] }]), "p1");
		expect(parsed.damaged).toBeFalsy();
		expect(parsed.data.strokes.map((s) => s.id)).toEqual(["s1"]);
	});

	it("control: a stroke that holds nothing beyond its own fields is dropped with nothing lost", () => {
		const parsed = parsePage(
			fileWith([
				{ id: "s1", ...base, pts: [0, 0, 0.5, 0, 10, 0, 0.5, 8] },
				{ id: "s2", ...base },
			]),
			"p1"
		);
		expect(parsed.damaged).toBeFalsy();
		expect(parsed.data.strokes.map((s) => s.id)).toEqual(["s1"]);
	});

	it("marks the file damaged, so the next save cannot write the page without that stroke", () => {
		const parsed = parsePage(
			fileWith([
				{ id: "s1", ...base, pts: [0, 0, 0.5, 0, 10, 0, 0.5, 8] },
				{ id: "s2", ...base, ptsv3: "AAECAwQFBgc=" },
			]),
			"p1"
		);
		expect(parsed.data.strokes.map((s) => s.id), "precondition: this build cannot draw the second stroke").toEqual(["s1"]);
		expect(parsed.damaged, "a stroke this build could not read was dropped and the file read as whole").toBe(true);
	});
});
