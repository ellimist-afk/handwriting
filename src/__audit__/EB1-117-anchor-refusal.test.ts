/**
 * Probe for audit item 117 (finding id Geometry-3): a document-anchor refusal
 * persists for the tab's life.
 *
 * Claim: refuseDocumentAnchor adds the EditorView to a WeakSet, and
 * mountDocumentAnchor returns null for any view in it. Obsidian reuses one
 * EditorView when a tab opens another note, so one refusal (a theme snippet
 * that shifts .cm-content on one note) keeps every later note in that tab on
 * the slower shipped path. The module's own comment says the opposite is
 * intended: "a fixed theme is allowed to take effect on the next note open".
 *
 * Production code driven: the real refuseDocumentAnchor, documentAnchorRefused
 * and mountDocumentAnchor. The view is the smallest stand-in they touch: a
 * state whose editorInfoField answer names the open note, and a contentDOM
 * whose parentElement read is counted, because that read is the first thing
 * a mount does once it is past the refusal check.
 *
 * Asserts the CORRECT behaviour: after the tab moves to another note, the
 * anchor is not refused and a mount is attempted. The control keeps the
 * refusal on the note that was refused.
 */
import { describe, expect, it } from "vitest";
import type { EditorView } from "@codemirror/view";
import { documentAnchorRefused, mountDocumentAnchor, refuseDocumentAnchor } from "../inline/DocumentAnchor";

function tab(path: string) {
	let note = path;
	let hostReads = 0;
	const view = {
		state: { field: () => ({ file: { path: note } }) },
		contentDOM: {
			get parentElement() {
				hostReads++;
				return null;
			},
		},
		scrollDOM: {},
	} as unknown as EditorView;
	return {
		view,
		open(next: string) {
			note = next;
		},
		hostReads: () => hostReads,
	};
}

const detail = { implied: 10, shipped: 12, bar: 0.5, reason: "theme shifted .cm-content" };

describe("audit 117 control: the refused note stays refused", () => {
	it("a mount on the same note stops at the refusal", () => {
		const t = tab("Themed.md");
		refuseDocumentAnchor(t.view, detail);
		expect(mountDocumentAnchor(t.view)).toBeNull();
		expect([documentAnchorRefused(t.view), t.hostReads()]).toEqual([true, 0]);
	});
});

describe("audit 117 probe: the refusal ends when the tab opens another note", () => {
	it("another note in the same tab is not refused, and its mount looks for a host again", () => {
		const t = tab("Themed.md");
		refuseDocumentAnchor(t.view, detail);
		t.open("Plain.md");
		mountDocumentAnchor(t.view);
		expect({ refused: documentAnchorRefused(t.view), mountTried: t.hostReads() > 0 }).toEqual({
			refused: false,
			mountTried: true,
		});
	});
});
