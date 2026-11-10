import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
	InkOverlayPlugin,
	inkOverlayExtension,
	inlineInk,
	overlayForPath,
} from "../../src/inline/InkOverlay";
import { clearInkClipboard } from "../../src/inline/InkClipboard";
import type { InkStroke } from "../../src/ink/Stroke";
import { installObsidianDom } from "./obsidianDom";
import {
	type BrowserEditorInfo,
	editorInfoField,
} from "./iphoneObsidianStub";

installObsidianDom();

const SOURCE = "paste/source.md";
const LOADED_EMPTY = "paste/loaded-empty.md";
const LOADING_EMPTY = "paste/loading-empty.md";
const LOADING_ID = "loading-empty-id";
const ALL_PATHS = [SOURCE, LOADED_EMPTY, LOADING_EMPTY];

type SelectionSize = "small" | "wide" | "tall" | "spanning" | "sparse" | "l-shaped";
type Destination = "other-note" | "same-note";

function sourceStrokes(size: SelectionSize): InkStroke[] {
	if (size === "small") {
		return [{
				id: "small-editable-stroke",
				tool: "pen",
				color: "#111111",
				width: 5,
				points: [
					{ x: 90, y: 120, pressure: 0.5, t: 0 },
					{ x: 140, y: 140, pressure: 0.5, t: 8 },
					{ x: 190, y: 120, pressure: 0.5, t: 16 },
				],
				bbox: { x: 87.5, y: 117.5, width: 105, height: 25 },
				createdAt: 1,
			}];
	}
	if (size === "wide") {
		return [{
			id: "wide-editable-stroke",
			tool: "pen",
			color: "#111111",
			width: 5,
			points: [
				{ x: 600, y: 120, pressure: 0.5, t: 0 },
				{ x: 1000, y: 140, pressure: 0.5, t: 8 },
				{ x: 1400, y: 120, pressure: 0.5, t: 16 },
			],
			bbox: { x: 597.5, y: 117.5, width: 805, height: 25 },
			createdAt: 1,
		}];
	}
	if (size === "tall") {
		return [{
			id: "tall-editable-stroke",
			tool: "pen",
			color: "#111111",
			width: 5,
			points: [
				{ x: 90, y: 800, pressure: 0.5, t: 0 },
				{ x: 140, y: 1600, pressure: 0.5, t: 8 },
				{ x: 190, y: 2400, pressure: 0.5, t: 16 },
			],
			bbox: { x: 87.5, y: 797.5, width: 105, height: 1605 },
			createdAt: 1,
		}];
	}
	if (size === "spanning") return [{
				// One stroke, so this differs from the control only in geometry:
				// its selection bounds start outside the destination viewport and
				// span more than two viewport heights and widths.
				id: "spanning-editable-stroke",
				tool: "pen",
				color: "#111111",
				width: 5,
				points: [
					{ x: 600, y: 800, pressure: 0.5, t: 0 },
					{ x: 1000, y: 1600, pressure: 0.5, t: 8 },
					{ x: 1400, y: 2400, pressure: 0.5, t: 16 },
				],
				bbox: { x: 597.5, y: 797.5, width: 805, height: 1605 },
		createdAt: 1,
	}];
	if (size === "l-shaped") {
		return [{
			// The bbox overlaps the top-left viewport, but neither painted leg
			// does: the vertical leg is beyond its right edge and the horizontal
			// leg is beyond its bottom edge.
			id: "l-shaped-editable-stroke",
			tool: "pen",
			color: "#111111",
			width: 5,
			points: [
				{ x: 1200, y: 20, pressure: 0.5, t: 0 },
				{ x: 1200, y: 1800, pressure: 0.5, t: 8 },
				{ x: 20, y: 1800, pressure: 0.5, t: 16 },
			],
			bbox: { x: 17.5, y: 17.5, width: 1185, height: 1785 },
			createdAt: 1,
		}];
	}
	// The union top-left is in view but contains no ink: one short stroke is
	// beyond the right edge and the other is beyond the bottom edge. Revealing
	// only selectionBounds.x/y would still leave the pasted selection invisible.
	return [
		{
			id: "sparse-right-stroke",
			tool: "pen",
			color: "#111111",
			width: 5,
			points: [
				{ x: 1200, y: 20, pressure: 0.5, t: 0 },
				{ x: 1300, y: 40, pressure: 0.5, t: 8 },
			],
			bbox: { x: 1197.5, y: 17.5, width: 105, height: 25 },
			createdAt: 1,
		},
		{
			id: "sparse-bottom-stroke",
			tool: "pen",
			color: "#111111",
			width: 5,
			points: [
				{ x: 20, y: 1800, pressure: 0.5, t: 0 },
				{ x: 120, y: 1820, pressure: 0.5, t: 8 },
			],
			bbox: { x: 17.5, y: 1797.5, width: 105, height: 25 },
			createdAt: 2,
		},
	];
}

export interface BlankPasteTrace {
	phase: "loaded" | "loading";
	size: SelectionSize;
	destination: Destination;
	copied: number;
	pasted: number;
	destinationBefore: number;
	loadedBeforePaste: boolean;
	storedAfterPaste: number;
	storedFirstPoint: { x: number; y: number } | null;
	selectedAfterPaste: number;
	visibleCommittedBeforePaste: PixelProbe;
	immediate: {
		scrollLeft: number;
		scrollTop: number;
		scrollWidth: number;
		scrollHeight: number;
	};
	afterPaint: {
		scrollLeft: number;
		scrollTop: number;
		scrollWidth: number;
		scrollHeight: number;
		clientWidth: number;
		clientHeight: number;
		visibleCommitted: PixelProbe;
	};
	afterManualScroll: {
		scrollLeft: number;
		scrollTop: number;
		visibleCommitted: PixelProbe;
	};
	sameNoteWithoutPasteAtManual: PixelProbe | null;
	storedAfterLoad: number;
}

interface PixelProbe {
	alphaPixels: number;
	hash: number;
}

interface MountedNote {
	wrapper: HTMLElement;
	view: EditorView;
	overlay: InkOverlayPlugin;
}

let releaseLoading: (() => void) | null = null;
let loadingRead = new Promise<void>((resolve) => {
	releaseLoading = resolve;
});
const pageIds = new Map<string, string>([[LOADING_EMPTY, LOADING_ID]]);

inlineInk.attachHost({
	readPageId: (path) => pageIds.get(path) ?? null,
	claimId: async (path, proposedId) => {
		const pageId = pageIds.get(path) ?? proposedId;
		pageIds.set(path, pageId);
		return { pageId };
	},
	loadSidecar: async (pageId) => {
		if (pageId === LOADING_ID) await loadingRead;
		return null;
	},
	scheduleSidecar: () => undefined,
	scheduleSidecarNow: async () => undefined,
	notify: () => undefined,
});

async function settle(): Promise<void> {
	await Promise.resolve();
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function mount(path: string): Promise<MountedNote> {
	const wrapper = document.body.appendChild(document.createElement("div"));
	wrapper.className = "markdown-source-view";
	wrapper.style.cssText = "position:relative;width:393px;height:720px;overflow:hidden";
	const info: BrowserEditorInfo = {
		app: { commands: { executeCommandById: () => false } },
		file: { path },
		editor: {},
	};
	const view = new EditorView({
		parent: wrapper,
		state: EditorState.create({
			doc: "",
			extensions: [
				editorInfoField.init(() => info),
				inkOverlayExtension(),
				EditorView.theme({
					"&": { height: "700px", width: "390px" },
					".cm-scroller": { overflow: "auto" },
					".cm-content": {
						fontFamily: "sans-serif",
						fontSize: "16px",
						lineHeight: "24px",
						minHeight: "100%",
					},
				}),
			],
		}),
	});
	await settle();
	const overlay = overlayForPath(path);
	if (!overlay) throw new Error(`overlay did not mount for ${path}`);
	return { wrapper, view, overlay };
}

function selection(overlay: InkOverlayPlugin): {
	selectExactly(ids: string[]): void;
	strokeIds: string[];
} {
	return (overlay as unknown as {
		selection: { selectExactly(ids: string[]): void; strokeIds: string[] };
	}).selection;
}

/** Pixels the user can see: committed canvas cropped to the scroller viewport. */
function visibleCommitted(note: MountedNote): PixelProbe {
	// The overlay's own committed canvas, by identity: the ink layer's DOM order changes as layers are added.
	const committed = note.overlay.committedCanvas;
	if (!committed) throw new Error("committed canvas missing");
	const ctx = committed.getContext("2d");
	if (!ctx) throw new Error("committed context missing");
	const canvasRect = committed.getBoundingClientRect();
	const viewportRect = note.view.scrollDOM.getBoundingClientRect();
	const left = Math.max(canvasRect.left, viewportRect.left);
	const top = Math.max(canvasRect.top, viewportRect.top);
	const right = Math.min(canvasRect.right, viewportRect.right);
	const bottom = Math.min(canvasRect.bottom, viewportRect.bottom);
	if (right <= left || bottom <= top || canvasRect.width <= 0 || canvasRect.height <= 0) {
		return { alphaPixels: 0, hash: 0 };
	}
	const sx = Math.max(0, Math.floor(((left - canvasRect.left) / canvasRect.width) * committed.width));
	const sy = Math.max(0, Math.floor(((top - canvasRect.top) / canvasRect.height) * committed.height));
	const ex = Math.min(committed.width, Math.ceil(((right - canvasRect.left) / canvasRect.width) * committed.width));
	const ey = Math.min(committed.height, Math.ceil(((bottom - canvasRect.top) / canvasRect.height) * committed.height));
	const pixels = ctx.getImageData(sx, sy, Math.max(1, ex - sx), Math.max(1, ey - sy)).data;
	let count = 0;
	let hash = 2166136261;
	for (let i = 0; i < pixels.length; i++) {
		if (i % 4 === 3 && pixels[i] !== 0) count++;
		hash ^= pixels[i]!;
		hash = Math.imul(hash, 16777619);
	}
	return { alphaPixels: count, hash: hash >>> 0 };
}

async function scenario(
	phase: BlankPasteTrace["phase"],
	size: SelectionSize,
	destinationKind: Destination
): Promise<BlankPasteTrace> {
	for (const path of ALL_PATHS) inlineInk.handleDelete(path);
	clearInkClipboard();
	pageIds.delete(SOURCE);
	pageIds.delete(LOADED_EMPTY);
	pageIds.set(LOADING_EMPTY, LOADING_ID);
	loadingRead = new Promise<void>((resolve) => {
		releaseLoading = resolve;
	});

	const source = await mount(SOURCE);
	const destinationPath =
		destinationKind === "same-note"
			? SOURCE
			: phase === "loaded"
				? LOADED_EMPTY
				: LOADING_EMPTY;
	const destination = destinationKind === "same-note" ? source : await mount(destinationPath);
	try {
		const strokes = sourceStrokes(size);
		inlineInk.applyAdd(SOURCE, strokes);
		inlineInk.save(SOURCE);
		source.overlay.scheduleRepaint();
		await settle();
		selection(source.overlay).selectExactly(strokes.map((stroke) => stroke.id));
		const copied = source.overlay.copySelectedInk();

		const scroller = destination.view.scrollDOM;
		const destinationBefore = inlineInk.strokes(destinationPath).length;
		const loadedBeforePaste = inlineInk.isLoaded(destinationPath);
		const visibleCommittedBeforePaste = visibleCommitted(destination);
		const pasted = destination.overlay.pasteInkHere();
		const stored = inlineInk.strokes(destinationPath);
		const storedAfterPaste = stored.length;
		const storedFirstPoint = stored[0]
			? { x: stored[0].points[0]!.x, y: stored[0].points[0]!.y }
			: null;
		const selectedAfterPaste = selection(destination.overlay).strokeIds.length;
		const immediate = {
			scrollLeft: scroller.scrollLeft,
			scrollTop: scroller.scrollTop,
			scrollWidth: scroller.scrollWidth,
			scrollHeight: scroller.scrollHeight,
		};

		await settle();
		const afterPaint = {
			scrollLeft: scroller.scrollLeft,
			scrollTop: scroller.scrollTop,
			scrollWidth: scroller.scrollWidth,
			scrollHeight: scroller.scrollHeight,
			clientWidth: scroller.clientWidth,
			clientHeight: scroller.clientHeight,
			visibleCommitted: visibleCommitted(destination),
		};

		// A real ink coordinate, not the bbox's possibly empty top-left corner.
		scroller.scrollLeft = strokes[0]!.points[0]!.x - 100;
		scroller.scrollTop = strokes[0]!.points[0]!.y - 120;
		scroller.dispatchEvent(new Event("scroll"));
		await settle();
		const afterManualScroll = {
			scrollLeft: scroller.scrollLeft,
			scrollTop: scroller.scrollTop,
			visibleCommitted: visibleCommitted(destination),
		};

		if (phase === "loading") {
			releaseLoading?.();
			await settle();
		}
		const storedAfterLoad = inlineInk.strokes(destinationPath).length;
		let sameNoteWithoutPasteAtManual: PixelProbe | null = null;
		if (destinationKind === "same-note") {
			inlineInk.applyRemove(destinationPath, selection(destination.overlay).strokeIds);
			destination.overlay.scheduleRepaint();
			await settle();
			sameNoteWithoutPasteAtManual = visibleCommitted(destination);
		}
		return {
			phase,
			size,
			destination: destinationKind,
			copied,
			pasted,
			destinationBefore,
			loadedBeforePaste,
			storedAfterPaste,
			storedFirstPoint,
			selectedAfterPaste,
			visibleCommittedBeforePaste,
			immediate,
			afterPaint,
			afterManualScroll,
			sameNoteWithoutPasteAtManual,
			storedAfterLoad,
		};
	} finally {
		source.view.destroy();
		if (destination !== source) destination.view.destroy();
		source.wrapper.remove();
		if (destination !== source) destination.wrapper.remove();
	}
}

(window as unknown as Window & {
	blankNotePaste: {
		run(
			phase: BlankPasteTrace["phase"],
			size: SelectionSize,
			destination: Destination
		): Promise<BlankPasteTrace>;
	};
}).blankNotePaste = { run: scenario };
