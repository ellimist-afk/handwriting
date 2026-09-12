/**
 * Shared regression fixture ported from 93857707: compare a fixed-size pane
 * with one whose layout dimensions follow the counter-scaled editor.
 * The content-sized arm exposes feedback from a camera-owned host write
 * into handleResize's external-pane delta. Native Orion layout and gesture
 * behavior require separate evidence.
 */

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { inlineInk, inkOverlayExtension, overlayForPath, setScrollExpansionEnabled } from "../../src/inline/InkOverlay";
import { setPenInk } from "../../src/inline/PenInk";
import { installObsidianDom } from "./obsidianDom";
import { editorInfoField } from "./iphoneObsidianStub";
import { serializePage, parsePage, type PageData } from "../../src/model/PageData";

installObsidianDom();

const ids = new Map<string, string>();
const pages = new Map<string, string>();
const save = (id: string, page: PageData) => void pages.set(id, serializePage(page));
inlineInk.attachHost({
	readPageId: (p) => ids.get(p) ?? null,
	claimId: async (p, id) => {
		ids.set(p, id);
		return { pageId: id };
	},
	loadSidecar: async (id) => (pages.has(id) ? parsePage(pages.get(id)!, id) : null),
	scheduleSidecar: save,
	scheduleSidecarNow: async (id, p) => save(id, p),
	notify: () => {},
});

const settle = async (frames = 12): Promise<void> => {
	for (let i = 0; i < frames; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
};

/**
 * The two modeled pane layouts differ only in who owns the pane's size.
 * This synthetic content-sized parent is not proof of Orion's actual layout.
 */
async function mount(kind: "constrained" | "shrinkToFit") {
	setScrollExpansionEnabled(true);
	setPenInk(true);
	const path = `loop-${kind}.md`;
	const parent = document.body.appendChild(document.createElement("div"));
	parent.className = "markdown-source-view loop-pane";
	parent.dataset.kind = kind;
	if (kind === "constrained") {
		parent.style.width = "640px";
		parent.style.height = "480px";
		parent.style.overflow = "hidden";
	} else {
		// No fixed size: the pane's client box follows whatever the editor
		// inside it becomes. Nothing else about the editor changes.
		parent.style.display = "inline-block";
	}

	const doc = "alpha beta gamma delta ".repeat(40) + "\nsecond line";
	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc,
			extensions: [
				history(),
				EditorView.lineWrapping,
				editorInfoField.init(() => ({
					app: { commands: { executeCommandById: () => false } },
					file: { path },
					editor: {},
				})),
				inkOverlayExtension(),
				EditorView.theme({
					"&": { width: "640px", height: "480px" },
					".cm-content": { fontFamily: "monospace", fontSize: "16px", lineHeight: "24px" },
				}),
			],
		}),
	});
	await settle();
	const overlay = overlayForPath(path)! as any;
	return { parent, view, overlay, path };
}

/** Host and pane dimensions, which is what the loop inflates. */
function dims(rig: { parent: HTMLElement; view: EditorView; overlay: any }) {
	const host = rig.view.dom as HTMLElement;
	return {
		hostWidth: host.clientWidth,
		hostHeight: host.clientHeight,
		paneWidth: rig.parent.clientWidth,
		paneHeight: rig.parent.clientHeight,
		styleWidth: host.style.width,
		styleHeight: host.style.height,
		layoutWidth: rig.overlay.viewportLayout?.width ?? null,
		layoutHeight: rig.overlay.viewportLayout?.height ?? null,
		cachedPaneWidth: rig.overlay.viewportLayout?.paneWidth ?? null,
		cachedPaneHeight: rig.overlay.viewportLayout?.paneHeight ?? null,
	};
}

/**
 * Zoom out repeatedly and watch the pane, counting resize callbacks.
 *
 * A settled camera produces a bounded number of resize notifications. A
 * feedback loop produces them until the frame budget runs out, which is what
 * the reader sees as flicker and an unresponsive editor.
 */
async function zoomOutAndWatch(kind: "constrained" | "shrinkToFit", steps: number, resize: boolean | "beforeZoom" = false) {
	const rig = await mount(kind);
	const before = dims(rig);
	let resizes = 0;
	const watcher = new ResizeObserver(() => {
		resizes++;
	});
	watcher.observe(rig.view.dom);
	watcher.observe(rig.parent);
	await settle();
	const baseline = resizes;

	const zooms: number[] = [];
	const samples: ReturnType<typeof dims>[] = [];
	for (let i = 0; i < steps; i++) {
		if (resize === "beforeZoom" && i === 1) {
			rig.parent.style.width = "800px";
			rig.parent.style.height = "600px";
		}
		rig.overlay.zoomNoteBy?.(0.5);
		await settle();
		zooms.push(rig.overlay.getNoteViewportState?.().zoom ?? NaN);
		samples.push(dims(rig));
	}
	if (resize === true) {
		rig.parent.style.width = "800px";
		rig.parent.style.height = "600px";
	}
	await settle(20);
	const after = dims(rig);
	watcher.disconnect();

	// A coordinate query is a limited layout check, not an input-latency or
	// native gesture acceptance measurement.
	let interactive = false;
	try {
		interactive = rig.view.coordsAtPos(4) !== null;
	} catch {
		interactive = false;
	}

	rig.view.destroy();
	rig.parent.remove();
	return { kind, before, after, zooms, samples, resizes: resizes - baseline, interactive };
}

(window as any).unconstrainedLoop = zoomOutAndWatch;

// Reuse the actual pointer router for preview/end/cancel ordering. Event
// dispatch is synthetic; this does not measure native input latency.
(window as any).unconstrainedPinch = async (kind: "constrained" | "shrinkToFit", cancel: boolean, resize: boolean) => {
	const rig = await mount(kind);
	rig.overlay.zoomNoteBy(0.5);
	await settle();
	const before = dims(rig);
	const point = (type: string, id: number, x: number) => rig.view.scrollDOM.dispatchEvent(new PointerEvent(type, {
		bubbles: true, cancelable: true, pointerType: "touch", pointerId: id,
		clientX: x, clientY: 40, buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
		width: 8, height: 8,
	}));
	point("pointerdown", 501, 20); point("pointerdown", 502, 100);
	for (let i = 1; i <= 12; i++) {
		const half = 40 * (1 - 0.5 * i / 12);
		point("pointermove", 501, 60 - half); point("pointermove", 502, 60 + half);
		await settle(1);
	}
	const liveScale = rig.overlay.pinchScaleNow;
	if (resize) { rig.parent.style.width = "800px"; rig.parent.style.height = "600px"; }
	point(cancel ? "pointercancel" : "pointerup", 501, 40); point("pointerup", 502, 80);
	await settle(20);
	const after = dims(rig), finalScale = rig.overlay.pinchScaleNow;
	const previewPending = !!rig.overlay.viewportLayout?.previewBox;
	rig.view.destroy(); rig.parent.remove();
	return { before, after, liveScale, finalScale, previewPending };
};
