/**
 * The stored target text and context follow the document. Without this, an edit in or near the attached words makes
 * the group "Needs reattachment" at the next open, shown where it was first attached. An edit inside the target or within its context, mapped through the overlay's editor update, then the page
 * as written and a reopen on the new text (the real lineAnchorInkLoaded): the group resolves and follows the text. A
 * target an edit deleted keeps its old text, so an undo can find it again. A bare overlay, a fake view: no DOM.
 */
import { describe, expect, it, vi } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { targetAt, type AttachmentData, type AttachmentRecord, type AttachmentStatus } from "./InkAttachments";

/** The first line is longer than the context, so an edit at its start is outside the target's window. */
const DOC = "Intro line with many more words so the context ends here.\nThe word benzene here.\nLast line.\n";
const LH = 30;
const FROM = DOC.indexOf("benzene");

/** The overlay's editor update on `path`, one attached group on "benzene". */
function rig(path: string) {
	const record: AttachmentRecord = { v: 1, id: "att-1", strokeIds: ["s1"], target: targetAt(DOC, FROM, FROM + 7, "range"), ref: { x: 0, y: LH }, layout: { width: 600, font: 16 }, probe: { id: "s1", x: 1, y: 40 } };
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [record] };
	const writes: number[] = [];
	Object.defineProperty(inlineInk, "persist", { value: () => writes.push(1), configurable: true });
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	const state = { doc: Text.of(DOC.split("\n")) };
	const view = { scaleY: 1, state, lineBlockAt: (pos: number) => ({ top: state.doc.lineAt(pos).number * LH - LH, bottom: state.doc.lineAt(pos).number * LH }) };
	Object.assign(overlay, { view, fontZoom: 1, lineAnchorState: new LineAnchors(() => null), lineAnchorsMoved: () => {}, followMoved: () => {} });
	overlay.lineAnchors.follow.setList(inlineInk.attachments(path));
	overlay.lineAnchors.follow.attached(record, LH);
	const change = (spec: { from: number; to?: number; insert?: string }) => {
		const startState = { doc: state.doc };
		const changes = ChangeSet.of([spec], state.doc.length);
		state.doc = changes.apply(state.doc);
		overlay.followDocChanged(path, { changes, startState, state: { doc: state.doc } } as unknown as ViewUpdate);
	};
	/** The group needs reattachment, as a load that could not find its words leaves it. */
	const hold = () => overlay.lineAnchors.follow.setList(inlineInk.attachments(path), new Map<string, AttachmentStatus>([["att-1", "needs-reattachment"]]));
	return { change, doc: () => state.doc, writes, hold, follow: overlay.lineAnchors.follow };
}

/** The page as written (its attachments through JSON), opened on `doc` in a fresh session: the real load resolve. */
function reopen(path: string, doc: Text) {
	const written = JSON.parse(JSON.stringify(inlineInk.attachments(path))) as AttachmentData[];
	const again = `${path}-reopened`;
	const rec = inlineInk.record(again);
	rec.pageId = `page-${again}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: written };
	rec.strokes = [];
	const anchors = new LineAnchors(() => null);
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, { filePath: () => again, view: { state: { doc } }, lineAnchorState: anchors, lineAnchorPassTimer: 0, lineDrawnAt: 0, requestFollowMeasure: () => {} });
	overlay.lineAnchorInkLoaded(again);
	const now = inlineInk.attachments(again)[0] as AttachmentRecord;
	return { follows: anchors.follow.followsText("att-1"), target: now.target, doc: doc.toString() };
}

describe("the stored target text follows the document", () => {
	it("a line typed just before the target, within its context, then two lines at the top: resolved at reopen", () => {
		// Defect: the stored context is never refreshed, so the reopen finds neither the stored offsets
		// nor the old context: "Needs reattachment", shown at its Attach place.
		const path = "attach-refresh-before.md";
		const { change, doc } = rig(path);
		change({ from: DOC.indexOf("The"), insert: "abc\n" });
		change({ from: 0, insert: "a\nb\n" });
		const r = reopen(path, doc());
		expect(r.follows, "resolved: follows the text").toBe(true);
		expect(r.doc.slice(r.target.from, r.target.to)).toBe("benzene");
	});

	it("a typo fixed inside the target, then a line at the top: resolved at reopen on the new words", () => {
		// Defect: the stored text is the old word, which is nowhere in the note now.
		const path = "attach-refresh-inside.md";
		const { change, doc } = rig(path);
		change({ from: FROM + 3, insert: "x" });
		change({ from: 0, insert: "a\n" });
		const r = reopen(path, doc());
		expect(r.follows, "resolved: follows the text").toBe(true);
		expect(r.doc.slice(r.target.from, r.target.to)).toBe("benxzene");
	});

	it("control: an edit far above, outside the context, resolves at base too", () => {
		const path = "attach-refresh-far.md";
		const { change, doc } = rig(path);
		change({ from: 0, insert: "x".repeat(40) + "\n" });
		const r = reopen(path, doc());
		expect(r.follows).toBe(true);
		expect(r.doc.slice(r.target.from, r.target.to)).toBe("benzene");
	});

	it("control: a deleted target keeps its old text, so the undo finds it again", () => {
		// Defect guarded: a refresh of a collapsed target stores the empty text, and the undo's text is never found.
		const path = "attach-refresh-deleted.md";
		const { change } = rig(path);
		change({ from: FROM, to: FROM + 7 });
		const t = (inlineInk.attachments(path)[0] as AttachmentRecord).target;
		expect(t.from).toBe(t.to);
		expect(t.text).toBe("benzene");
		expect(t.before).toBe(targetAt(DOC, FROM, FROM + 7, "range").before);
	});

	it("control: a target that needs reattachment keeps its old text through an edit next to it", () => {
		// Defect guarded: a held target's offsets are stale, so a refresh there stores whatever words now sit at them and
		// a reattachment can no longer find the old ones.
		const path = "attach-refresh-held.md";
		const { change, hold, writes } = rig(path);
		const was = (inlineInk.attachments(path)[0] as AttachmentRecord).target;
		hold();
		change({ from: FROM - 1, insert: "x" });
		const t = (inlineInk.attachments(path)[0] as AttachmentRecord).target;
		expect([t.text, t.before, t.after]).toEqual([was.text, was.before, was.after]);
		expect(writes, "nothing scheduled").toHaveLength(0);
	});

	it("a key just before the target on its own line, no line moved: the page is written with the new context", () => {
		// Defect: a mapped-only list is held and typing writes nothing, so a close keeps the old context
		// on disk and the reopen cannot find the target.
		const path = "attach-refresh-write.md";
		const { change, writes, doc } = rig(path);
		change({ from: FROM - 1, insert: "x" });
		expect(writes, "the refresh is an edit: one page write").toHaveLength(1);
		const t = (inlineInk.attachments(path)[0] as AttachmentRecord).target;
		expect(t.before).toBe(targetAt(doc().toString(), t.from, t.to, "range").before);
	});

	it("control: an edit on another line outside the window changes no text and writes nothing", () => {
		const path = "attach-refresh-outside.md";
		const { change, writes } = rig(path);
		const was = (inlineInk.attachments(path)[0] as AttachmentRecord).target;
		change({ from: 0, insert: "x" });
		const t = (inlineInk.attachments(path)[0] as AttachmentRecord).target;
		expect([t.text, t.before, t.after]).toEqual([was.text, was.before, was.after]);
		expect(writes).toHaveLength(0);
	});

	it("the refresh's time is read only while the diagnostics switch is on: one part per change, off reads no clock", () => {
		// Defect: the refresh has no measured part, so a keystroke budget cannot say what it costs; or the part is
		// timed with the switch off and every key pays the clock.
		const path = "attach-refresh-timed.md";
		const { change, follow } = rig(path);
		const clock = vi.spyOn(performance, "now");
		try {
			change({ from: 0, insert: "x" });
			const off = clock.mock.calls.length;
			const parts: string[] = [];
			follow.onTime = (part) => parts.push(part);
			change({ from: 0, insert: "x" });
			change({ from: FROM - 1, insert: "x" });
			follow.onTime = null;
			expect([off, parts.filter((p) => p === "refreshTouched").length], "[clock reads with the switch off, refresh parts over two changes]").toEqual([0, 2]);
		} finally { clock.mockRestore(); }
	});
});
