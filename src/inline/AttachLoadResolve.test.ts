/**
 * Ink attached to text at load (spec section 5.3): when a note's ink has loaded, its records are
 * resolved against the note's text. A target found elsewhere has its offsets rewritten in the session's list, with no
 * page write; a target not found needs reattachment: its group is held, shown at its stored points and never pending,
 * and typing does not move it. The real lineAnchorInkLoaded on a bare overlay over a CodeMirror Text; no DOM.
 */
import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { InkOverlayPlugin } from "./InkOverlay";
import { inlineInk } from "./InkOverlayRegistry";
import { LineAnchors } from "./LineAnchor";
import { emptyPage } from "../model/PageData";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { targetAt, type AttachmentRecord } from "./InkAttachments";

/** Line 2 is longer than the target context, so line 3's context is line 2 alone. */
const SAVED = "line 1 words\nline 2 has a good many more words in it\nline 3 words";
/** Since the save, two lines were typed above and line 1 was rewritten: line 3's words moved, line 1's are gone. */
const NOW = "new a\nnew bb words\n" + SAVED.replace("line 1 words", "line one");

function strokeAt(id: string, x: number, y: number): InkStroke {
	const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + 4 + (i % 2) * 2, pressure: 0.5, t: i }));
	return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
}

function record(id: string, word: string, strokeIds: string[]): AttachmentRecord {
	const from = SAVED.indexOf(word);
	return { v: 1, id, strokeIds, target: targetAt(SAVED, from, from + word.length, "range"), ref: { x: 0, y: 80 }, layout: { width: 892, font: 26 }, probe: { id: strokeIds[0]!, x: 10, y: 89 } };
}

function rig(path: string) {
	const rec = inlineInk.record(path);
	rec.pageId = `page-${path}`;
	rec.basePage = { ...emptyPage(rec.pageId), attachments: [record("att-moved", "line 3 words", ["s1"]), record("att-gone", "line 1 words", ["s2"])] };
	rec.strokes = [strokeAt("s1", 10, 85), strokeAt("s2", 40, 45)];
	const writes: number[] = [];
	Object.defineProperty(inlineInk, "persist", { value: () => writes.push(1), configurable: true });
	const doc = Text.of(NOW.split("\n"));
	const anchors = new LineAnchors(() => ({ lines: doc.lines, lineText: (n) => doc.line(n).text, lineTop: (n) => (n - 1) * 40, pxPerWorld: 1 }));
	anchors.setSignature({ width: 892, fontPx: 26, charWidth: 14 });
	// The overlay reaches its window through winRef, over the view's document: the ink load's box read asks it for a frame,
	// which never comes here.
	const win = { requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined };
	const overlay = Object.create(InkOverlayPlugin.prototype) as InkOverlayPlugin;
	Object.assign(overlay, { filePath: () => path, view: { state: { doc }, dom: { ownerDocument: { defaultView: win } } }, lineAnchorState: anchors, lineAnchorPassTimer: 0, lineDrawnAt: 0 });
	return { overlay, anchors, writes };
}

describe("attached ink at load", () => {
	it("rewrites a target found elsewhere in the session's list, with no page write", () => {
		// Defect: the stored offsets stand, so the group follows the text now at the stored offsets until someone edits the note.
		const path = "attach-load-moved.md";
		const { overlay, anchors, writes } = rig(path);
		overlay.lineAnchorInkLoaded(path);
		const moved = inlineInk.attachments(path).find((a) => a.id === "att-moved") as AttachmentRecord;
		expect(moved.target.from).toBe(NOW.indexOf("line 3 words"));
		expect(anchors.follow.followsText("att-moved")).toBe(true);
		expect(writes).toEqual([]);
	});

	it("holds a group whose target is not found: shown at its stored points, not pending, and typing does not move it", () => {
		// Defect: the status never reaches the follow, so the group waits for a read of a target that is gone: pending,
		// never painted; or a read lands it on whatever text now sits at the stale offsets.
		const path = "attach-load-gone.md";
		const { overlay, anchors } = rig(path);
		overlay.lineAnchorInkLoaded(path);
		expect(anchors.follow.groupOffset("att-gone"), "held: no correction, painted").toEqual({ dx: 0, dy: 0 });
		expect(anchors.follow.followsText("att-gone")).toBe(false);
		expect(anchors.follow.groupOffset("att-moved"), "resolved: pending until its line is read").toBeNull();
	});
});
