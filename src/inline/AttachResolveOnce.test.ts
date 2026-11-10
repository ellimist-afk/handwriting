/**
 * Opening a note with many attached groups whose stored offsets are stale builds the note's whitespace-collapsed text
 * once, not once per group. The count of builds is the instrument (a spy on the build), not a clock. Pure functions.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAttachments, resolveTarget, targetAt, type AttachmentData, type AttachmentRecord } from "./InkAttachments";

/** A note of at least 100,000 characters, every line's words its own. */
function bigDoc(): string {
	const lines: string[] = [];
	let n = 0;
	for (let i = 0; n < 100_000; i++) {
		const line = `line ${i} holds the words w${(i * 7919) % 100_003} and q${(i * 104_729) % 99_991}`;
		lines.push(line);
		n += line.length + 1;
	}
	return lines.join("\n");
}

function groups(doc: string, shift: number): AttachmentRecord[] {
	const out: AttachmentRecord[] = [];
	const lines = doc.split("\n");
	for (let g = 0; g < 20; g++) {
		const lineNo = Math.floor(((g + 0.5) * lines.length) / 20);
		const from = lines.slice(0, lineNo).reduce((a, l) => a + l.length + 1, 0) + 5;
		const target = targetAt(doc, from, from + 12, "range");
		out.push({ v: 1, id: `att-${g}`, strokeIds: [`s${g}`], target: { ...target, from: target.from + shift, to: target.to + shift }, ref: { x: 0, y: g * 30 }, layout: { width: 600, font: 16 }, probe: { id: `s${g}`, x: 1, y: g * 30 + 2 } });
	}
	return out;
}

/** Counts the builds of the collapsed text of `doc`: calls to matchAll on the document itself. */
function countBuilds(doc: string): { count: () => number } {
	let calls = 0;
	const real = String.prototype.matchAll;
	vi.spyOn(String.prototype, "matchAll").mockImplementation(function (this: string, re: RegExp) {
		if (this === doc) calls++;
		return real.call(this, re);
	} as typeof String.prototype.matchAll);
	return { count: () => calls };
}

afterEach(() => vi.restoreAllMocks());

describe("opening a note with many stale groups builds the flat text once", () => {
	it("twenty groups whose stored offsets are each one off: one build, each group found where it alone would be", () => {
		// Defect: resolveTarget builds the collapsed text for every group it searches, so a note with many stale
		// groups pays the whole note once per group at open.
		const doc = bigDoc();
		expect(doc.length).toBeGreaterThanOrEqual(100_000);
		const list = groups(doc, 1);
		const alone = list.map((a) => resolveTarget(a.target, doc));
		const builds = countBuilds(doc);
		const { list: out, status } = resolveAttachments(list as AttachmentData[], doc);
		expect(builds.count()).toBe(1);
		for (let i = 0; i < list.length; i++) {
			expect((out[i] as AttachmentRecord).target).toEqual(alone[i]);
			expect(status.get(list[i]!.id)).toBe("resolved");
		}
	});

	it("control: twenty groups whose stored offsets still match: at most one build, the list comes back as it was", () => {
		const doc = bigDoc();
		const list = groups(doc, 0);
		const builds = countBuilds(doc);
		const { list: out } = resolveAttachments(list as AttachmentData[], doc);
		expect(builds.count()).toBeLessThanOrEqual(1);
		expect(out).toBe(list);
	});
});
