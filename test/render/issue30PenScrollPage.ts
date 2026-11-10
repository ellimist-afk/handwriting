/**
 * Issue 30 page: a real CodeMirror note taller than its view, with the real
 * overlay and pen router. The caret sits on line 1, the note is scrolled
 * down, and focus is on a button outside the editor, so the pen-down is the
 * contact that brings focus back to the editor.
 *
 * `plant` adds one focusin listener on the editor that scrolls the caret into
 * view, the way the report's "snaps back to the first available place to
 * write" reads. It proves the cell sees a scroll when one happens.
 */
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { inlineInk, inkOverlayExtension, overlayForPath } from "../../src/inline/InkOverlay";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";

installObsidianDom();
inlineInk.attachHost({
	readPageId: () => "existing-page",
	claimId: async () => ({ pageId: "existing-page" }),
	loadSidecar: async () => null,
	scheduleSidecar: () => {},
	scheduleSidecarNow: async () => {},
	notify: () => {},
} as never);

const frames = async (n: number): Promise<void> => {
	for (let i = 0; i < n; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
};
const path = "issue-30.md";
let view: EditorView;
const focusins: number[] = [];

async function setupNote(plant: boolean) {
	const outside = document.body.appendChild(document.createElement("button"));
	outside.textContent = "outside";
	const host = document.body.appendChild(document.createElement("div"));
	host.className = "markdown-source-view";
	host.style.cssText = "width:1000px;height:700px;overflow:hidden;position:relative";
	const doc = Array.from({ length: 200 }, (_, i) => `${i} ${"some text ".repeat(8)}`).join("\n");
	view = new EditorView({
		parent: host,
		state: EditorState.create({
			doc,
			selection: EditorSelection.cursor(0),
			extensions: [
				editorInfoField.init(() => ({ app: { commands: { executeCommandById: () => false } }, file: { path }, editor: {} }) as never),
				inkOverlayExtension(),
				EditorView.theme({ "&": { width: "1000px", height: "700px" }, ".cm-scroller": { overflow: "auto" } }),
			],
		}),
	});
	view.contentDOM.addEventListener("focusin", () => {
		focusins.push(view.scrollDOM.scrollTop);
		if (plant) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) });
	});
	await frames(6);
	setPenInk(true);
	await frames(2);
	view.scrollDOM.scrollTop = 2000;
	await frames(4);
	outside.focus();
	await frames(2);
	return {
		overlay: overlayForPath(path) !== null,
		scrollTop: view.scrollDOM.scrollTop,
		caret: view.state.selection.main.head,
		hasFocus: view.hasFocus,
		active: document.activeElement?.tagName ?? null,
		scrollerTop: view.scrollDOM.getBoundingClientRect().top,
	};
}

function read() {
	return {
		scrollTop: view.scrollDOM.scrollTop,
		hasFocus: view.hasFocus,
		active: document.activeElement === view.contentDOM ? "contentDOM" : document.activeElement?.tagName ?? null,
		focusins: [...focusins],
		strokes: inlineInk.strokes(path).length,
	};
}

(window as unknown as { __i30: unknown }).__i30 = { setupNote, read, frames };
