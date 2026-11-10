/**
 * Ink attached to text, A8 and A13 at the history level: the attach step is one InkOp, inverted by swapping its two
 * records, with both identities carried through. Applying it on undo comes with the overlay (InkOverlayOps applyInkOp
 * ignores it until then).
 */
import { describe, expect, it } from "vitest";
import { invertInkOp, type InkOp } from "./InkHistory";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

const H = Symbol("h1");
const DOC = "The word benzene sits here.\n";
const rec: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1"], target: targetAt(DOC, 9, 16, "range"), ref: { x: 0, y: 0 }, layout: { width: 672, font: 19 }, probe: { id: "s1", x: 1, y: 2 } };

describe("attach InkOp", () => {
	it("attach inverts to detach and back, identities kept", () => {
		// Plant h-invert-same: the inverse keeps before and after in place.
		const op: InkOp = { type: "attach", path: "a.md", historyIdentity: H, pageId: "p1", id: "att-1", before: null, after: rec };
		const inv = invertInkOp(op);
		expect(inv).toEqual({ type: "attach", path: "a.md", historyIdentity: H, pageId: "p1", id: "att-1", before: rec, after: null });
		expect(invertInkOp(inv)).toEqual(op);
	});
	it("change attachment inverts to the old record", () => {
		const changed = { ...rec, strokeIds: ["s1", "s2"] };
		const op: InkOp = { type: "attach", path: "a.md", id: "att-1", before: rec, after: changed };
		expect(invertInkOp(op)).toMatchObject({ before: changed, after: rec });
	});
});
