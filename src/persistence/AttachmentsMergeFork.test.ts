/**
 * Ink attached to text at the three places a page is compared or joined:
 * mergePages keeps a record only the disk carries when every member survives in the merged strokes and none is in a
 * group of ours (ours wins on a shared id, an opaque record is kept as found), including where the strokes agree and
 * the early return would hand back ours; outgoingDiverges counts a record of ours the arriving page lacks or changed;
 * a fork decision reads the live page back with its records, so "Take the other" writes when only the records differ.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mergePages } from "./PageMerge";
import { outgoingDiverges } from "./PageStore";
import { applyForkDecision, recordFork, resetForks, type ForkHost, type ForkRecord } from "./ForkResolution";
import { parsePage, serializePage, type PageData } from "../model/PageData";
import { targetAt, type AttachmentData, type AttachmentRecord } from "../inline/InkAttachments";

const PAGE = "504fdb34-aed8-42a0-8df8-66f7db7a02de";
const DOC = "line 1 words\nline 2 words\nline 3 words";
const LIVE = `.handwriting/${PAGE}.json`;
const MINE = ".handwriting/p.conflict-external-t-outgoing.json";
const THEIRS = ".handwriting/p.conflict-external-t-incoming.json";

function group(id: string, strokeIds: string[], refY = 80): AttachmentRecord {
	const from = DOC.indexOf("line 3 words");
	return { v: 1, id, strokeIds, target: targetAt(DOC, from, from + 12, "range"), ref: { x: 0, y: refY }, layout: { width: 892, font: 26 }, probe: { id: strokeIds[0]!, x: 10, y: 20 } };
}

/** A page with the given stroke ids and attachments, parsed the way the store reads it. */
function page(ids: string[], attachments: AttachmentData[] = []): PageData {
	const json = JSON.stringify({
		schemaVersion: 1,
		pageId: PAGE,
		surface: "inline",
		textBoxes: [],
		images: [],
		strokes: ids.map((id, i) => ({ id, tool: "pen", color: "#5f6673", width: 2.86, createdAt: 1788853814257 + i, pts: [10 + i, 20 + i, 0.5, 0, 11 + i, 21 + i, 0.5, 1] })),
	});
	const data = parsePage(json, PAGE).data;
	return attachments.length ? { ...data, attachments } : data;
}

const text = (ids: string[], attachments: AttachmentData[] = []) => serializePage(page(ids, attachments));
const ids = (p: PageData) => (p.attachments ?? []).map((a) => a.id);

describe("mergePages keeps attachment records by id", () => {
	it("keeps a record only the disk carries when the strokes agree (past the early return)", () => {
		// Defect: the early return hands back ours, so the other writer's Attach is lost from the page.
		const out = mergePages(page(["a", "b"], [group("att-d", ["a", "b"])]), page(["a", "b"]));
		expect(ids(out)).toEqual(["att-d"]);
	});

	it("keeps a disk-only record beside strokes the disk adds, and ours wins on a shared id", () => {
		// Defect: mine wins as a whole key, so the disk-only record goes; or the disk's copy of a shared id replaces ours.
		const disk = page(["a", "b", "c"], [group("att-1", ["a"], 300), group("att-d", ["c"])]);
		const out = mergePages(disk, page(["a", "b"], [group("att-1", ["a"], 80)]));
		expect(ids(out)).toEqual(["att-1", "att-d"]);
		expect((out.attachments![0] as AttachmentRecord).ref.y).toBe(80);
	});

	it("drops a disk-only record a member of which is not in the merged strokes or is in a group of ours", () => {
		// Defect: a record kept over a stroke the page does not hold, or a stroke left in two groups.
		const disk = page(["a", "b"], [group("att-d", ["b"])]);
		const dangling: AttachmentRecord = group("att-x", ["a", "gone"]);
		const out = mergePages({ ...disk, attachments: [...disk.attachments!, dangling] }, page(["a", "b"], [group("att-1", ["b"])]));
		expect(ids(out)).toEqual(["att-1"]);
	});

	it("keeps an opaque record only the disk carries, as found", () => {
		// Defect: a record of a later build is dropped by this build's merge.
		const opaque: AttachmentData = { opaque: true, id: "att-v2", raw: { v: 2, id: "att-v2", strokeIds: ["a"] } };
		const out = mergePages(page(["a"], [opaque]), page(["a"]));
		expect(out.attachments).toEqual([opaque]);
	});

	it("hands back ours by identity when neither side has anything the other lacks", () => {
		const mine = page(["a"], [group("att-1", ["a"])]);
		expect(mergePages(page(["a"], [group("att-1", ["a"], 300)]), mine)).toBe(mine);
	});
});

describe("outgoingDiverges counts attachment records", () => {
	it("is true when the arriving page lacks or changed a record of ours, false when it holds it", () => {
		// Defect: only strokes, boxes and images are compared, so a lost Attach is adopted with no fork kept.
		const mine = page(["a"], [group("att-1", ["a"])]);
		expect(outgoingDiverges(mine, page(["a"]))).toBe(true);
		expect(outgoingDiverges(mine, page(["a"], [group("att-1", ["a"], 300)]))).toBe(true);
		expect(outgoingDiverges(mine, page(["a"], [group("att-1", ["a"])]))).toBe(false);
	});
});

describe("a fork decision reads the live page back with its records", () => {
	const rec = (): ForkRecord => ({ pageId: PAGE, path: "Demo/two devices.md", outgoingPath: MINE, incomingPath: THEIRS, at: 5 });
	function vault(seed: Record<string, string>) {
		const files = new Map(Object.entries(seed));
		const saved: PageData[] = [];
		const host: ForkHost = {
			read: async (p: string) => files.get(p) ?? null,
			stat: async (p: string) => (files.has(p) ? { mtime: 1000 + files.get(p)!.length } : null),
			saveNow: async (_id: string, data: PageData) => {
				saved.push(data);
				files.set(LIVE, serializePage(data));
			},
		};
		return { host, saved };
	}
	beforeEach(() => resetForks());

	it("Take the other writes when the live page has its strokes but not its record", async () => {
		// Defect: the read-back compares strokes only, so the live page "already holds" the other revision and the
		// other device's Attach is never written.
		const v = vault({ [MINE]: text(["a"]), [THEIRS]: text(["a"], [group("att-1", ["a"])]), [LIVE]: text(["a"]) });
		recordFork(rec());
		const out = await applyForkDecision(v.host, rec(), "take-theirs");
		expect(out).toMatchObject({ kind: "applied", wrote: true, stillListed: false });
		expect(v.saved.map(ids)).toEqual([["att-1"]]);
	});

	it("Take the other writes nothing when the live page already holds its strokes and record", async () => {
		const v = vault({ [MINE]: text(["a"]), [THEIRS]: text(["a"], [group("att-1", ["a"])]), [LIVE]: text(["a"], [group("att-1", ["a"])]) });
		recordFork(rec());
		const out = await applyForkDecision(v.host, rec(), "take-theirs");
		expect(out).toMatchObject({ kind: "applied", wrote: false });
		expect(v.saved).toEqual([]);
	});
});
