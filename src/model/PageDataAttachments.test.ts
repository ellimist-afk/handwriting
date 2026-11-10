/**
 * Ink attached to text, A14 and the load rules: the `attachments` key of a page sidecar. Written only when a note has groups, so a
 * note without them keeps its bytes; a record this build cannot read goes back as it came; a damaged version 1 record
 * is dropped and counted; a group whose strokes are all gone is dropped at load.
 */
import { describe, expect, it } from "vitest";
import { emptyPage, parsePage, serializePage } from "./PageData";
import { emptyDecodeLoss, migratePageData, wasLossy } from "./PageMigrate";
import { isOpaqueAttachment, type AttachmentRecord } from "../inline/InkAttachments";

const stroke = (id: string) => ({ id, tool: "pen", color: "#000000", width: 2, createdAt: 0, points: [{ x: 10, y: 20, pressure: 0.5, t: 0 }, { x: 20, y: 30, pressure: 0.5, t: 8 }] });
const v1 = (id = "att-1", strokeIds = ["s1"]) => ({ v: 1, id, strokeIds, target: { kind: "range", from: 9, to: 16, text: "benzene", before: "The word ", after: " sits here." }, ref: { x: 0, y: 40.5 }, layout: { width: 672, font: 19 }, probe: { id: strokeIds[0], x: 10, y: 20 } });
const file = (attachments: unknown) => JSON.stringify({ schemaVersion: 1, pageId: "p1", textBoxes: [], images: [], strokes: [stroke("s1"), stroke("s2")], ...(attachments === undefined ? {} : { attachments }) });

describe("attachments in the sidecar", () => {
	it("a note without groups writes no attachments key (bytes unchanged)", () => {
		const page = emptyPage("p1");
		expect(serializePage(page)).not.toContain("attachments");
		const back = parsePage(file(undefined), "p1").data;
		expect(back.attachments).toBeUndefined();
		expect(serializePage(back)).not.toContain("attachments");
	});
	it("a version 1 record round-trips, unknown keys kept, beside textBoxes", () => {
		const raw = { ...v1(), later: { kept: true } };
		const page = parsePage(file([raw]), "p1").data;
		expect(page.attachments).toHaveLength(1);
		const out = JSON.parse(serializePage(page));
		expect(out.attachments).toEqual([raw]);
		expect(Object.keys(out).indexOf("attachments")).toBe(Object.keys(out).indexOf("textBoxes") + 1);
	});
	it("A14: a version 2 record loads opaque and is written back byte-identical", () => {
		// Plant p-v2-drop: a record of another version is dropped instead of kept.
		const raw = { v: 2, id: "att-9", strokeIds: ["s1"], anchor: { line: 3, kind: "future" }, z: [1, 2.5] };
		const page = parsePage(file([raw]), "p1").data;
		expect(page.attachments!.every(isOpaqueAttachment)).toBe(true);
		expect(JSON.stringify(JSON.parse(serializePage(page)).attachments)).toBe(JSON.stringify([raw]));
	});
	it("a damaged version 1 record and one with an unsafe id are dropped and counted; a non-array list is counted", () => {
		const loss = emptyDecodeLoss();
		const page = migratePageData(JSON.parse(file([{ ...v1(), ref: { x: "0", y: 1 } }, { ...v1(), id: "__proto__" }, 7, v1("att-ok")])), "p1", loss);
		expect(loss.unusableAttachments).toBe(3);
		expect(page.attachments!.map((a) => a.id)).toEqual(["att-ok"]);
		expect(wasLossy(loss)).toBe(true);
		const list = emptyDecodeLoss();
		migratePageData(JSON.parse(file({ not: "a list" })), "p1", list);
		expect(list.unreadableAttachmentList).toBe(true);
	});
	it("A15 at load: members the page no longer holds leave; a group with none is dropped", () => {
		const page = parsePage(file([v1("att-1", ["s1", "gone"]), v1("att-2", ["gone"])]), "p1").data;
		expect(page.attachments!.map((a) => [a.id, (a as AttachmentRecord).strokeIds])).toEqual([["att-1", ["s1"]]]);
	});
});
