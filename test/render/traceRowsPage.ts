/**
 * Trace rows page (issues 30 and 37): a real CodeMirror note taller than its
 * view, with the real overlay and pen router, driven by real pen input from
 * the test over CDP. Recording is switched on or off before the pen moves,
 * and the pen trace is read back as text.
 */
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { inlineInk, inkOverlayExtension, overlayForPath } from "../../src/inline/InkOverlay";
import { setPenInk } from "../../src/inline/PenInk";
import { setDiagnosticsEnabled } from "../../src/diag/DiagSwitch";
import { clearInlinePenTrace, formatInlinePenTrace } from "../../src/inline/InlinePenRouterTrace";
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
const path = "trace-rows.md";
let view: EditorView;
let focusinAdds = 0;

async function setupNote(recording: boolean) {
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
	const add = view.contentDOM.addEventListener.bind(view.contentDOM);
	view.contentDOM.addEventListener = ((type: string, fn: never, opts?: never) => {
		if (type === "focusin") focusinAdds++;
		add(type, fn, opts);
	}) as never;
	await frames(6);
	setPenInk(true);
	await frames(2);
	view.scrollDOM.scrollTop = 2000;
	await frames(4);
	outside.focus();
	await frames(2);
	setDiagnosticsEnabled(recording);
	clearInlinePenTrace();
	focusinAdds = 0;
	return {
		overlay: overlayForPath(path) !== null,
		scrollTop: view.scrollDOM.scrollTop,
		hasFocus: view.hasFocus,
		scrollerTop: view.scrollDOM.getBoundingClientRect().top,
	};
}

function read() {
	const lines = formatInlinePenTrace().split("\n");
	return {
		strokeEnd: lines.filter((l) => l.includes("stroke end:")),
		focusin: lines.filter((l) => l.includes("focusin after pen-down")),
		focusinAdds,
		strokes: inlineInk.strokes(path).length,
		scrollTop: view.scrollDOM.scrollTop,
	};
}

(window as unknown as { __tr: unknown }).__tr = { setupNote, read, frames };
