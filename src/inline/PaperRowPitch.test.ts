/**
 * Paper lines take the text's row height. The product shape: the lines follow the text spacing for
 * everyone, no setting, text never moves.
 *
 * The pitch is the height of one plain body row in layout px: the editor content's computed line height, read where
 * the font is read (the refresh path, InkOverlayLayout handleResize; the camera sync on a font change, InkOverlayCamera
 * syncCamera). CodeMirror's default line height stands in when the computed value is not a px length ("normal"), and
 * 28 x font / 16 only when both fail. A line height that changes with no font change (a theme, a snippet) reaches the
 * refresh path from the editor's geometry update (InkOverlayReload updateInner), the same way a font change does.
 *
 * Cells (unit; the render cells C2 to C4 read the real engine):
 * - C1: the plan's pitch is the row height given; with none, the old formula. Rule, dot and phase do not move.
 * - The refresh path writes the row height as the pitch: 24 at 16/24, 30 at 20/30, CodeMirror's default line height
 *   under "normal", 28 x font / 16 with neither.
 * - The camera sync's font change writes the new row height in the same task, before any refresh.
 * - C5: a geometry update whose line height moved with the font unchanged runs the refresh path.
 * - That refresh re-plans the paper even while a stroke owns the frame: nothing later asks again.
 *
 * Rigs: the real InkOverlayPlugin off its prototype, as FontRefPerNote.test.ts (handleResize) and
 * GridPaperBoxFollowsContent.test.ts (syncCamera) build it; the host's style records every paper property written.
 */
import { describe, expect, it } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;
if (typeof (globalThis as { HTMLElement?: unknown }).HTMLElement === "undefined") {
	(globalThis as { HTMLElement?: unknown }).HTMLElement = class ProbeHTMLElement {};
}

import { InkOverlayPlugin } from "./InkOverlay";
import { paperPlan } from "./PaperPlan";
import { WheelZoomRun } from "./WheelZoom";
import { FrontierCache } from "./FrontierCache";

type Fields = Record<string, unknown>;
type Call = (...args: unknown[]) => unknown;

const PITCH = "--handwriting-paper-pitch";

function hostStyle(styles: Record<string, string>): Fields {
	return {
		getPropertyValue: (n: string) => styles[n] ?? "",
		getPropertyPriority: () => "",
		setProperty: (n: string, v: string) => { styles[n] = v; },
		removeProperty: (n: string) => { delete styles[n]; },
	};
}

function paperFields(o: Fields): void {
	o.paperKindWatch = [];
	o.paperKindFrame = null;
	o.paperGridBox = null;
	o.paperGridBoxSize = null;
	o.paperGridBoxPanX = "";
	o.paperPanWritten = null;
	o.paperOriginLayout = null;
	o.paperOriginLeft = null;
	o.paperFontPx = Number.NaN;
	o.paperRestZoom = Number.NaN;
	o.paperWritten = new Map<string, string>();
	o.previewPaperEl = null;
	o.previewPaperSettling = false;
	o.pinchPreview = false;
	o.paperSnapResidual = { x: 0, y: 0 };
	o.viewportLayout = null;
	o.syncGridPaperBox = () => undefined;
	o.syncPageGuideBox = () => undefined;
}

function el(extra: Fields = {}): Fields {
	return {
		setCssStyles: () => undefined,
		remove: () => undefined,
		classList: { add: () => undefined, remove: () => undefined },
		style: { removeProperty: () => undefined },
		...extra,
	};
}

/** The real handleResize over FontRefPerNote's rig; the content's font and line height are what the test sets. */
function resizeRig(defaultLineHeight?: number) {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	const content = { fontSize: "16px", lineHeight: "24px" };
	const styles: Record<string, string> = {};
	const canvas = (): Fields => el({ width: 0, height: 0, getContext: () => null });
	const canvases = [canvas(), canvas(), canvas(), canvas(), canvas()];
	const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
	const win = {
		devicePixelRatio: 1,
		getComputedStyle: () => ({ get fontSize() { return content.fontSize; }, get lineHeight() { return content.lineHeight; }, getPropertyValue: (n: string) => styles[n] ?? "" }),
		cancelAnimationFrame: () => undefined,
		clearTimeout: () => undefined,
	};
	o.view = {
		state: { field: () => undefined },
		dom: { ...el({ ownerDocument: { defaultView: win }, parentElement: null }), isConnected: true, style: hostStyle(styles) },
		scrollDOM: el({ scrollLeft: 0, scrollTop: 0, clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 600, addEventListener: () => undefined, removeEventListener: () => undefined }),
		contentDOM: el({ children: [] as unknown[], getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }) }),
		scaleX: 1, scaleY: 1, documentTop: 0,
		defaultLineHeight,
	};
	o.container = el({ getBoundingClientRect: () => rect, offsetWidth: 800, offsetHeight: 600 });
	o.committedCanvas = canvases[0]; o.wetCanvas = canvases[1]; o.tailCanvas = canvases[2]; o.highlightCanvas = canvases[3]; o.highlightWetCanvas = canvases[4];
	o.committedCtx = { setTransform: () => undefined };
	o.highlightCtx = { setTransform: () => undefined };
	const renderer = { applyDpr: () => undefined, clear: () => undefined };
	o.wet = renderer; o.highlightWet = renderer;
	o.tail = { applyDpr: () => undefined, clearAll: () => undefined, configureInlineBacking: () => undefined, placeInline: () => undefined, restoreFullSurface: () => undefined, prepareLive: () => undefined };
	o.contentStyle = null;
	o.refFontPx = 0; o.lastFontStr = ""; o.lastSyncFontStr = "";
	o.cssScale = 1; o.fontZoom = 1; o.scale = 1; o.dpr = 1; o.cssWidth = 0; o.cssHeight = 0;
	o.frame = { locked: false, cancel: () => undefined };
	o.wheelZoomRun = new WheelZoomRun();
	o.band = null; o.router = null; o.axisChecked = false; o.lastReach = null; o.indexDirty = true; o.lastPaintCam = null;
	o.damage = { addAll: () => undefined };
	o.spacer = null; o.spacerLeft = Number.NaN; o.spacerTop = Number.NaN;
	o.pinchScaleNow = 1; o.pinchRasterScale = 1;
	o.mobileTools = null; o.noteZoomControls = null;
	o.repaint = () => undefined; o.scheduleRepaint = () => undefined; o.updateHandwritingPageClass = () => undefined;
	o.filePath = () => null;
	paperFields(o);
	return {
		resize(fontSize: string, lineHeight: string): string | undefined {
			content.fontSize = fontSize; content.lineHeight = lineHeight;
			(InkOverlayPlugin.prototype as unknown as { handleResize: Call }).handleResize.call(o);
			return styles[PITCH];
		},
		/** A stroke in flight owns the frame (frame.locked), or lets go of it. */
		lock(on: boolean): void { (o.frame as { locked: boolean }).locked = on; },
	};
}

/** The real syncCamera over GridPaperBoxFollowsContent's rig, layout readers fixed; the content style is set per test. */
function cameraRig() {
	const styles: Record<string, string> = {};
	const H = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement;
	const sizer = Object.create(H.prototype) as Record<string, unknown>;
	Object.defineProperties(sizer, { offsetTop: { get: () => 0 }, offsetLeft: { get: () => 0 }, offsetWidth: { get: () => 700 }, offsetHeight: { get: () => 1000 } });
	const scroller = {
		isConnected: true, scrollLeft: 0, scrollTop: 0, clientWidth: 800, clientHeight: 600, clientTop: 0, clientLeft: 0,
		scrollWidth: 800, scrollHeight: 1000, firstElementChild: sizer, firstChild: sizer,
		getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
		classList: { add: () => undefined, remove: () => undefined, contains: () => false, toggle: () => false },
		style: { setProperty: () => undefined, removeProperty: () => undefined },
		setCssStyles: () => undefined,
	};
	const win = {
		devicePixelRatio: 1, setTimeout: () => 1, clearTimeout: () => undefined, requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined,
		getComputedStyle: () => ({ position: "relative", overflowX: "hidden", overflowY: "auto", fontSize: "16px", paddingTop: "0px", getPropertyValue: (n: string) => styles[n] ?? "" }),
	};
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	o.view = {
		state: { field: () => ({ file: { path: "row-pitch.md" } }) },
		dom: { isConnected: true, ownerDocument: { defaultView: win, body: {} }, style: hostStyle(styles) },
		scrollDOM: scroller,
		contentDOM: { parentElement: null, children: [] as unknown[], getBoundingClientRect: () => ({ left: 100, top: 0, right: 800, bottom: 1000, width: 700, height: 1000 }) },
		documentTop: 0, scaleX: 1, scaleY: 1,
	};
	o.canvasMode = false;
	o.router = { setCanvasMomentumDisabled: () => undefined, refreshRect: () => undefined, cameraTransformChanged: () => undefined };
	o.container = { offsetWidth: 800, setCssStyles: () => undefined, getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) };
	o.frame = { locked: false };
	o.builder = null; o.band = null; o.bandFreeScrollWidth = null; o.bandSyncDeferred = false;
	o.pinchScrollAt = 0; o.pinchScaleNow = 1;
	o.wheelZoomRun = new WheelZoomRun(); o.wheelZoomTimer = 0;
	let camState = { x: 0, y: 0, zoom: 1 };
	o.camera = {
		get snapshot() { return { ...camState }; },
		get x() { return camState.x; }, get y() { return camState.y; }, get zoom() { return camState.zoom; },
		setState: (x: number, y: number, zoom: number) => { camState = { x, y, zoom }; },
	};
	o.frontierCache = new FrontierCache();
	o.fontZoom = 1; o.cssScale = 1; o.scale = 1; o.cssWidth = 800; o.cssHeight = 600; o.dpr = 1;
	o.lastExtentInputs = null; o.spacer = null; o.spacerLeft = Number.NaN; o.spacerTop = Number.NaN;
	o.scrollPositionPatched = false; o.lastReach = null;
	o.extentFrontierSeen = new Map<string, number>(); o.shrinkStepped = new Map<string, number>(); o.shrinksSeen = new Map<string, number>();
	o.sidewaysView = null; o.bandMarginReleasePending = false; o.scrollExpansion = null;
	paperFields(o);
	o.paperRewrapY = 0; o.paperColumnDrift = 0;
	o.refFontPx = 16; o.rasterPan = null; o.lastPaintCam = null;
	o.anchorGateDue = false; o.anchorAdoptionEvent = false; o.anchorCameraYLayout = Number.NaN; o.scaleGeometryValid = true;
	o.columnLeft = () => 100; o.documentTopUnpanned = () => 0; o.panX = () => 0; o.panY = () => 0;
	o.resolveColumnLeft = (x: number | null) => x ?? 100; o.unpanX = (x: number | null) => x;
	o.watchOriginLine = () => undefined; o.anchorCameraY = () => null; o.ownedColumnLayoutLeft = () => null;
	o.canonicalCameraY = (y: number) => y; o.gateAnchorParity = () => undefined;
	o.requestLineSignature = () => undefined; o.scheduleRepaint = () => undefined;
	return {
		o, styles,
		/** The content's font and line height move together, then one camera sync runs. */
		sync(fontSize: string, lineHeight: string): string | undefined {
			o.contentStyle = { fontSize, lineHeight, paddingTop: "0px" };
			(o.syncCamera as Call).call(o);
			return styles[PITCH];
		},
	};
}

/** The real updateInner with every route before the geometry branch stubbed to pass: the open note, no ink op, no hold. */
function updateRig() {
	const o = Object.create(InkOverlayPlugin.prototype) as Fields;
	let resizes = 0;
	o.selection = { isEmpty: true };
	o.ownsMarkdownEditorRoot = () => true;
	o.panAnchorHold = null;
	o.clearSpaceFeedback = () => undefined;
	o.container = {};
	o.filePath = () => "row-pitch.md";
	o.currentFile = () => null;
	o.lastPath = "row-pitch.md";
	o.measureHold = null;
	o.handleResize = () => { resizes++; };
	o.resizeOutOfUpdate = () => { resizes++; };
	o.scheduleRepaint = () => undefined;
	o.updateLineAnchors = () => undefined;
	return {
		o,
		/** One geometry update from the editor with the content style as given; how many refreshes it ran. */
		geometry(fontSize: string, lineHeight: string): number {
			o.contentStyle = { fontSize, lineHeight };
			const before = resizes;
			(o.updateInner as Call).call(o, { transactions: [], docChanged: false, geometryChanged: true, viewportChanged: false });
			return resizes - before;
		},
	};
}

describe("paper lines take the text's row height", () => {
	it("C1: the plan's pitch is the row height it is given, to 1/64 px; with none, 28 x font / 16; rule, dot and phase unchanged", () => {
		expect(paperPlan(16, 0, 2, null, 24)!.pitch, "16 px text, 24 px rows").toBe(24);
		expect(paperPlan(20, 0, 2, null, 30)!.pitch, "20 px text, 30 px rows").toBe(30);
		expect(paperPlan(16, 0, 1, null, 25.6)!.pitch, "a 25.6 px row, to the engine's 1/64 px").toBe(25.59375);
		expect(paperPlan(16, 0, 2, null, Number.NaN)!.pitch, "no row height: today's formula").toBe(28);
		expect(paperPlan(16, 0, 2, null, 0)!.pitch, "a zero row height: today's formula").toBe(28);
		const withRow = paperPlan(20, 37, 2, 11, 30)!, without = paperPlan(20, 37, 2, 11)!;
		expect(withRow.rule, "rule").toBe(without.rule);
		expect(withRow.dot, "dot").toBe(without.dot);
		// The phase is the origin mod the pitch, so it is read at the new pitch: 37 mod 30 is 7.
		expect(withRow.phase, "phase at the row pitch").toBe(7);
		expect(withRow.phaseX, "x phase at the row pitch").toBe(11);
	});

	it("the refresh path writes the content's row height as the pitch, at the text size and after a change of it", () => {
		const rig = resizeRig();
		expect(rig.resize("16px", "24px"), "Obsidian's default: 16 px text, line height 1.5").toBe("24px");
		expect(rig.resize("20px", "30px"), "quick font size to 20").toBe("30px");
		expect(rig.resize("16px", "25.6px"), "a theme at 1.6").toBe("25.59375px");
		// CodeMirror's default line height is measured from a drawn line, and a heading can be the one it measured.
		expect(resizeRig(31).resize("16px", "24px"), "a heading's 31 px row measured by CodeMirror does not set the pitch").toBe("24px");
	});

	it("the refresh path takes CodeMirror's default line height under \"normal\", and today's formula with neither", () => {
		expect(resizeRig(22).resize("16px", "normal"), "normal: CodeMirror's measured row").toBe("22px");
		expect(resizeRig().resize("16px", "normal"), "normal and no measure: 28 x 16 / 16").toBe("28px");
		expect(resizeRig().resize("20px", "1.5"), "a unitless read is not px: 28 x 20 / 16").toBe("35px");
	});

	it("the camera sync's font change writes the new row height in the same task, before any refresh", () => {
		const rig = cameraRig();
		expect(rig.sync("16px", "24px"), "first sync at 16/24").toBe("24px");
		expect(rig.sync("20px", "30px"), "the font goes 16 to 20").toBe("30px");
	});

	it("C5: a geometry update whose line height moved with the font unchanged runs the refresh path; an unchanged one does not", () => {
		const rig = updateRig();
		rig.o.lastFontStr = "16px";
		rig.o.lastLineHeightStr = "24px";
		expect(rig.geometry("16px", "24px"), "nothing moved").toBe(0);
		expect(rig.geometry("16px", "28px"), "a snippet sets the line height, font unchanged").toBe(1);
		expect(rig.geometry("20px", "24px"), "control: a font change alone").toBe(1);
	});

	it("a line height that moves alone while a stroke owns the frame re-plans the paper in that refresh", () => {
		const rig = resizeRig();
		expect(rig.resize("16px", "24px"), "at rest, 16/24").toBe("24px");
		rig.lock(true);
		// The refresh records the new line height, so no later geometry update asks again, and the font did not
		// change, so the camera sync does not either: this refresh is the paper's one chance.
		expect(rig.resize("16px", "28px"), "a snippet sets 28 px rows mid-stroke").toBe("28px");
		expect(rig.resize("16px", "28px"), "control: the same rows again, mid-stroke").toBe("28px");
		rig.lock(false);
		expect(rig.resize("16px", "28px"), "after the stroke").toBe("28px");
	});
});
