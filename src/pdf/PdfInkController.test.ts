
/** Extend the existing cursor fixture with its owned clipping parent. */
function cursorChildren(createCursor: () => any): (options?: { cls?: string }) => any {
	return (options) => {
		const cursor = createCursor();
		if (options?.cls !== "handwriting-pdf-cursor-viewport") return cursor;
		const viewport = {
			parentElement: cursor.parentElement,
			classList: { contains: (cls: string) => cls === "handwriting-pdf-cursor-viewport" },
			setCssStyles() {},
			createDiv: () => cursor,
			remove() { cursor.remove(); viewport.parentElement = null; },
		};
		cursor.parentElement = viewport;
		return viewport;
	};
}
/**
 * The PDF lasso, driven through the controller's own pen callbacks.
 *
 * Nothing constructed this class before, which is how the lasso shipped
 * unreachable. Its branch in `penRaw` sat below a guard that returns unless a
 * stroke builder or the eraser is live, and a lasso has neither, so every
 * movement sample was dropped: pen-up closed a one-point polygon and nothing
 * was ever selected. Reading the lasso code did not show it, because the bug
 * was in the routing ABOVE it - which is the argument for driving the class
 * rather than testing its parts.
 *
 * The viewer probe is the only thing stubbed. The page geometry, the hit
 * test, the selection and the history are all the real code.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest, setTipMode, setTipModeListener, tipMode } from "../inline/TipMode";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { setInkShaping } from "../ink/InkShape";
import {
	addStripSurface,
	endLiveStrokesEverywhere,
	getEraserRadiusPx,
	getInkSizeMult,
	releaseMouseInkQuietlyEverywhere,
	setEraserWholeStrokes,
	setInlineTool,
	setPenReticle,
} from "../inline/InkOverlay";
import { resetPenInkForTest, setPenInk } from "../inline/PenInk";
// Source text, not the module: nothing here can construct the plugin class,
// and importing main.ts for real would pull obsidian's runtime in. `?raw`
// (raw-imports.d.ts) is the house pattern for asking what a file says.
import mainSrc from "../main.ts?raw";
import { strokesHitByCircle } from "../ink/Eraser";
import { calibrationStrokes } from "./PdfCalibration";
import { clearInkClipboard, clipboardSize } from "../inline/InkClipboard";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { captureInlinePenTrace, clearInlinePenTrace } from "../inline/InlinePenRouter";
import { clearToolPicked, setMouseInk } from "../inline/MouseInk";
import { predictionEinkOn } from "../inline/StrokePrediction";
// The one element fake the router's own suites drive it with; see
// `test/routerHarness.ts`. Used by the pointerleave suite at the bottom of
// this file, which needs a REAL router rather than a captured callbacks bag.
import { fakeEl, installFakeWindow, penEvent, winHandlers } from "../../test/routerHarness";

/**
 * The gesture path reaches sync, which rebinds, which constructs observers.
 * Node has neither, and neither does the plugin need them to be real here: a
 * no-op keeps the code path honest without pretending to observe anything.
 */
class NoopObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
const g = globalThis as unknown as Record<string, unknown>;
g.ResizeObserver ??= NoopObserver;
g.MutationObserver ??= NoopObserver;

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({
	probeViewer: () => probe.current,
	// The snip asks for the viewer's own page canvas. Answering null is the
	// documented fallback - a page the viewer has not rendered snips as paper
	// white with the ink on it - and it is what this file's fakes are.
	viewerCanvasOf: () => null,
	wholePageCanvasOf: () => null,
}));

import {
	PDF_NIB_REFERENCE_SCALE,
	PdfInkController,
	pdfPenWidth,
	pointerScale,
} from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";
import { PdfInkStore } from "./PdfInkStore";
import { emptyPage, ParseResult } from "../model/PageData";

/** css px per point, as `--scale-factor` reports it. */
const SCALE = 2;

function sample(x: number, y: number): PenSample {
	return { x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 };
}

/** A short stroke around page point (100,100) - content px (200,200). */
function inkAt(id: string): InkStroke {
	const points = [100, 105, 110].map((v, i) => ({ x: v, y: v, pressure: 0.5, t: i * 8 }));
	return {
		id,
		tool: "pen",
		color: "#000000",
		width: 2,
		points,
		bbox: computeBBox(points, 4),
		createdAt: 0,
		page: 1,
	};
}

describe("PdfInkController lasso", () => {
	let strokes: InkStroke[];
	/** The one stroke the store starts with, kept because the store loses it. */
	let s1: InkStroke;
	let ops: InkOp[];
	let controller: PdfInkController;
	let flushFrame: () => void;
	let pen: {
		penDown(s: PenSample): void;
		penRaw(s: PenSample[]): void;
		penUp(): void;
	};

	beforeEach(() => {
		resetTipModeForTest();
		s1 = inkAt("s1");
		strokes = [s1];
		ops = [];
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
		};
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{
					pageNumber: 1,
					leftPx: 0,
					topPx: 0,
					widthPx: 600,
					heightPx: 800,
					hasCanvas: true,
				},
			],
		};
		const frames = new Map<number, () => void>();
		let frameId = 0;
		flushFrame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); };
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			cancelAnimationFrame: (id: number) => frames.delete(id),
			requestAnimationFrame: (fn: () => void) => { frames.set(++frameId, fn); return frameId; },
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => strokes,
			() => "doc-1",
			() => strokes,
			// The sink main.ts installs, not a recorder. A sink that only
			// pushes to an array leaves `deleteSelection`'s BOOLEAN as the
			// whole assertion, and a delete that returns true while removing
			// nothing passed every test in this block - which is how a bug
			// that emptied the selection and deleted no ink got as far as a
			// device. main.ts (`:430-435`) works the op out into a new stroke
			// list and writes it back, so that is what the store does here;
			// "live" decides only whether the sidecar is persisted, never
			// whether the list changed.
			(op) => {
				ops.push(op);
				strokes = applyOp(strokes, op);
			}
		);
		pen = controller as unknown as typeof pen;
	});

	/** The ids the store holds now, which is the question that matters. */
	function stored(): string[] {
		return strokes.map((s) => s.id);
	}

	/** Trace a closed loop through the given scroller-relative corners. */
	function lasso(corners: [number, number][]): void {
		const first = corners[0]!;
		pen.penDown(sample(first[0], first[1]));
		for (const [x, y] of corners.slice(1)) pen.penRaw([sample(x, y)]);
		pen.penRaw([sample(first[0], first[1])]);
		pen.penUp();
	}

	it("selects the ink the loop encircles", () => {
		setTipMode("lasso");
		lasso([
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		]);
		expect(controller.deleteSelection()).toBe(true);
		expect(ops).toEqual([{ type: "remove", path: "doc-1", strokes: [s1], indices: [0] }]);
		// The op is only half of it. What the report was about is the ink:
		// "lasso'd it, trashcan lit up, hit delete, trashcan and undo dimed,
		// but nothing deleted" - a true return with the stroke still there.
		expect(stored()).toEqual([]);
	});

	it("cutSelection copies to the clipboard, then empties the selection", () => {
		clearInkClipboard();
		setTipMode("lasso");
		lasso([
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		]);
		expect(controller.cutSelection()).toBe(1);
		expect(clipboardSize()).toBe(1);
		// A cut is a copy and a delete, so the ink has to be GONE from the
		// store as well as out of the selection.
		expect(stored()).toEqual([]);
		// deleteSelection is the public witness: false once the lasso holds
		// nothing, which is what a cut's own delete leaves behind.
		expect(controller.deleteSelection()).toBe(false);
		expect(ops).toEqual([{ type: "remove", path: "doc-1", strokes: [s1], indices: [0] }]);
	});

	it("cutSelection is a no-op with nothing lassoed", () => {
		clearInkClipboard();
		expect(controller.cutSelection()).toBe(0);
		expect(clipboardSize()).toBe(0);
		expect(ops).toEqual([]);
		expect(stored()).toEqual(["s1"]);
	});

	it("selects nothing when the loop encircles nothing", () => {
		setTipMode("lasso");
		lasso([
			[450, 450],
			[550, 450],
			[550, 550],
			[450, 550],
		]);
		expect(controller.deleteSelection()).toBe(false);
		expect(ops).toEqual([]);
		expect(stored()).toEqual(["s1"]);
	});

	it("a second loop elsewhere drops the first selection", () => {
		setTipMode("lasso");
		lasso([
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		]);
		lasso([
			[450, 450],
			[550, 450],
			[550, 550],
			[450, 550],
		]);
		expect(controller.deleteSelection()).toBe(false);
		expect(stored()).toEqual(["s1"]);
	});

	it("dragging a selection moves it by the travel", () => {
		setTipMode("lasso");
		lasso([
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		]);
		ops = [];
		// Down inside the selection's bounds, then 20 css px right = 10 points.
		pen.penDown(sample(205, 205));
		pen.penRaw([sample(215, 205)]);
		pen.penRaw([sample(225, 205)]);
		pen.penUp();
		const moves = ops.filter((op) => op.type === "move");
		expect(moves.length).toBeGreaterThan(0);
		const dx = moves.reduce((sum, op) => sum + (op as { dx: number }).dx, 0);
		const dy = moves.reduce((sum, op) => sum + (op as { dy: number }).dy, 0);
		expect(dx).toBeCloseTo(10, 6);
		expect(dy).toBeCloseTo(0, 6);
		for (const op of moves) expect((op as { strokeIds: string[] }).strokeIds).toEqual(["s1"]);
		// And the store moved with them: the live moves are applied sample by
		// sample, exactly as main.ts applies them, so the stroke that started
		// at page x=100 sits at 110.
		expect(strokes[0]!.points.map((p) => p.x)).toEqual([110, 115, 120]);
		expect(strokes[0]!.bbox.x).toBeCloseTo(s1.bbox.x + 10, 6);
	});

	it("does not spend history or clear the selection during a live drag", () => {
		setTipMode("lasso");
		lasso([[150, 150], [250, 150], [250, 250], [150, 250]]);
		pen.penDown(sample(205, 205));
		pen.penRaw([sample(225, 205)]);
		pen.penUp(); // seed one completed move in history
		pen.penDown(sample(225, 205));
		pen.penRaw([sample(245, 205)]);
		flushFrame(); // Observe the live move at its display frame.
		const xDuring = strokes[0]!.points[0]!.x;
		const opsBefore = ops.length;
		const step = controller as unknown as { historyStep(redo: boolean): boolean };
		expect(step.historyStep(false)).toBe(false);
		expect(step.historyStep(true)).toBe(false);
		expect(ops).toHaveLength(opsBefore);
		expect(strokes[0]!.points[0]!.x).toBe(xDuring);
		pen.penUp();
		expect(step.historyStep(false)).toBe(true);
		expect(strokes[0]!.points[0]!.x).toBeCloseTo(xDuring - 10);
		expect(step.historyStep(true)).toBe(true);
		expect(strokes[0]!.points[0]!.x).toBeCloseTo(xDuring);
	});

	// A BARE tip inside the selection drags it - onenote's grammar (alan,
	// 2026-08-27). The note surface has had this since the ruling; here the
	// only ways into a drag were the side button and the toolbar's lasso mode,
	// so a tip landing on ink the user had just selected drew a stroke across
	// it. These three pin the whole rule: bare tip drags, eraser erases,
	// outside inks.
	it("a bare tip inside the selection drags it", () => {
		setTipMode("lasso");
		lasso([
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		]);
		ops = [];
		// Not lasso, not the side button, not the eraser: the plain nib.
		setTipMode("nib");
		pen.penDown(sample(205, 205));
		pen.penRaw([sample(225, 205)]);
		pen.penUp();
		const moves = ops.filter((op) => op.type === "move");
		expect(moves.length).toBeGreaterThan(0);
		const dx = moves.reduce((sum, op) => sum + (op as { dx: number }).dx, 0);
		expect(dx).toBeCloseTo(10, 6);
		// And nothing was drawn over the selection, which was the defect.
		expect(ops.some((op) => op.type === "add")).toBe(false);
		expect(stored()).toEqual(["s1"]);
	});

	it("the eraser still reaches ink inside a selection", () => {
		setTipMode("lasso");
		lasso([
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		]);
		ops = [];
		// BARE is load-bearing: an eraser is not a bare tip. Swallowed by the
		// grab test, lassoed ink becomes the one ink on the page the eraser
		// cannot reach - it drags instead, on every contact.
		setTipMode("eraser");
		pen.penDown(sample(205, 205));
		pen.penUp();
		expect(ops.some((op) => op.type === "move")).toBe(false);
		expect(stored()).toEqual([]);
	});

	it("a bare tip outside the selection still inks", () => {
		setTipMode("lasso");
		lasso([
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		]);
		ops = [];
		setTipMode("nib");
		// Well clear of the bounds and its pad.
		pen.penDown(sample(500, 500));
		pen.penRaw([sample(530, 530), sample(560, 560)]);
		pen.penUp();
		expect(ops.filter((op) => op.type === "add")).toHaveLength(1);
		expect(ops.some((op) => op.type === "move")).toBe(false);
	});

	it("a document switch mid-gesture leaves the pane able to sync again", () => {
		setTipMode("nib");
		pen.penDown(sample(200, 200));
		// A stroke is open, so the reload poll must leave this pane alone.
		expect(controller.idle).toBe(false);
		// The pane is reused for another document; the half-open gesture must
		// not be inherited, or `idle` never comes back and the pane silently
		// stops receiving the other device's ink.
		controller.forgetHistory();
		expect(controller.idle).toBe(true);
	});

	it("dissolveSelection empties the selection directly", () => {
		setTipMode("lasso");
		lasso([
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		]);
		controller.dissolveSelection();
		const priv = controller as unknown as { selected: string[] };
		expect(priv.selected).toEqual([]);
		// deleteSelection is the public witness used elsewhere in this file:
		// true only if the lasso still holds those stroke ids.
		expect(controller.deleteSelection()).toBe(false);
		// Dissolving a selection puts it away; it does not take the ink.
		expect(stored()).toEqual(["s1"]);
	});

	/**
	 * §5o: production wiring is InkOverlay's tip-mode listener (`:276`)
	 * walking every `addStripSurface` registrant - main.ts registers
	 * exactly `() => c.dissolveSelection()` for every open PDF pane.
	 * Importing InkOverlay from this file DOES load cleanly (obsidian is
	 * aliased in vitest.config.mts and CodeMirror has no DOM dependency at
	 * import time), so that is not the obstacle the design doc anticipated.
	 * The real obstacle: InkOverlay installs its ONE listener singleton via
	 * `setTipModeListener` once, at module-import time, and this file's own
	 * `beforeEach(resetTipModeForTest)` nulls that singleton before every
	 * `it` in this describe block runs - so by the time this test's body
	 * executes, the listener InkOverlay installed is already gone.
	 * `vi.resetModules()` plus a fresh dynamic import would reinstall it,
	 * but against a SECOND, disconnected `TipMode` module instance that
	 * this file's own `setTipMode` calls could not reach, which would not
	 * be "the way main.ts wires it" either. So this asserts the rule
	 * through the documented fallback: `setTipMode("nib")` (the design doc
	 * said `"pen"`; the code's `TipMode` union has no such literal - the
	 * plain-pen value is `"nib"`) with a minimal listener of the same
	 * shape, registered via the real `setTipModeListener` seam.
	 */
	it("a tip-mode change away from lasso dissolves the selection (listener seam)", () => {
		setTipMode("lasso");
		lasso([
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		]);
		setTipModeListener(() => {
			if (tipMode() !== "lasso") controller.dissolveSelection();
		});
		setTipMode("nib");
		expect(controller.deleteSelection()).toBe(false);
		expect(stored()).toEqual(["s1"]);
	});

	it("switching to lasso after a fresh lasso does not clear it", () => {
		setTipMode("lasso");
		lasso([
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		]);
		setTipModeListener(() => {
			if (tipMode() !== "lasso") controller.dissolveSelection();
		});
		setTipMode("lasso");
		expect(controller.deleteSelection()).toBe(true);
		expect(stored()).toEqual([]);
	});
});

describe("PdfInkController, the rest of what went wrong", () => {
	let strokes: InkStroke[];
	let ops: InkOp[];
	let notices: string[];
	let docId: string | null;
	let modes: (string | undefined)[];
	let persists: string[];
	let controller: PdfInkController;
	let pen: { penDown(s: PenSample, ev?: unknown): void; penRaw(s: PenSample[]): void; penUp(): void };

	/** Two pages, so a stroke can be asked to wander onto the second. */
	function probeTwoPages(scroller: unknown) {
		return {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
				{ pageNumber: 2, leftPx: 0, topPx: 810, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
	}

	beforeEach(() => {
		resetTipModeForTest();
		strokes = [inkAt("s1")];
		ops = [];
		notices = [];
		modes = [];
		persists = [];
		docId = "doc-1";
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
		};
		probe.current = probeTwoPages(scroller);
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			(page) => strokes.filter((s) => (s.page ?? 1) === page),
			() => docId,
			// The document list, which is what op indices are positions in.
			() => strokes,
			(op, mode) => {
				ops.push(op);
				modes.push(mode);
				// A store that actually applies, so an op can be measured
				// against what it left behind. `applyOp` is the same function
				// main.ts's sink calls (`:430-435`), rather than the erase-only
				// approximation this used to carry: a hand-written `replace`
				// answered erases and left every other op recorded but never
				// applied, so a delete that removed nothing still passed.
				strokes = applyOp(strokes, op);
			},
			() => {},
			(message) => notices.push(message),
			(id) => persists.push(id)
		);
		pen = controller as unknown as typeof pen;
		// Already bound, as it would be after the first sync in the app. Without
		// this the pen-up handoff rebinds a real router onto a fake scroller,
		// which is a different test than the one being written here.
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
	});

	it("refuses to start before the document is identified, and says so once", () => {
		docId = null;
		pen.penDown(sample(200, 200));
		pen.penUp();
		pen.penDown(sample(210, 210));
		pen.penUp();
		expect(ops).toEqual([]);
		// Once per wait, not once per contact: a notice on every touch of the
		// pen would be its own bug.
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("identifying");
	});

	it("starts drawing as soon as the document lands", () => {
		docId = null;
		pen.penDown(sample(200, 200));
		pen.penUp();
		docId = "doc-1";
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(230, 230), sample(260, 260)]);
		pen.penUp();
		expect(ops.filter((op) => op.type === "add")).toHaveLength(1);
	});

	it("keeps a stroke on the page it started on when samples cross onto the next", () => {
		// Down on page 1, then well past its bottom edge into page 2's box.
		pen.penDown(sample(200, 700));
		pen.penRaw([sample(200, 900), sample(200, 1100)]);
		pen.penUp();
		const add = ops.find((op) => op.type === "add") as { strokes: InkStroke[] };
		expect(add).toBeDefined();
		expect(add.strokes[0]!.page).toBe(1);
	});

	it("stores the pen width in page units, at the reference scale", () => {
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(230, 230), sample(260, 260)]);
		pen.penUp();
		const add = ops.find((op) => op.type === "add") as { strokes: InkStroke[] };
		// A note's 2.2 rendered at a page scale of 2 would be 4.4 css px, twice
		// note ink; divided by the reference it is stored as 1.1 page units and
		// renders at 2.2 on a page shown at that reference. This fixture's
		// scale happens to BE the reference - the point that it no longer
		// matters what the scale is belongs to the zoom suite below.
		expect(add.strokes[0]!.width).toBeCloseTo(
			DEFAULT_PEN.baseWidth / PDF_NIB_REFERENCE_SCALE,
			6
		);
	});

	// The undo entry's indices are positions in the WHOLE document, because
	// that is the list undo applies against (applyOp over pdfStore.strokes).
	// Page-local indices there were right only on page one: undo an erase on
	// page five and the ink came back at whatever depth those numbers named.
	// The per-sample live op is the other way round on purpose: it is a
	// "live-page" op, applied to its page alone (PdfInkStore.applyLivePage),
	// so its indices are the page's.
	it("indexes an erase's undo entry against the document, and its live op against the page", () => {
		// Two strokes on page 1 ahead of the target, so a page-local index (0)
		// and a document index (2) cannot be mistaken for one another.
		strokes = [inkAt("s1"), inkAt("s2"), { ...inkAt("s3"), page: 2 }];
		setTipMode("eraser");
		// Page 2's box starts at 810, so this is the same page-local point the
		// page-1 erase test uses.
		pen.penDown(sample(200, 1010));
		pen.penUp();
		const replace = ops.find((op) => op.type === "replace") as {
			removed: InkStroke[];
			removedAt: number[];
		};
		expect(replace.removed.map((st) => st.id)).toEqual(["s3"]);
		expect(replace.removedAt, "the live op names the page's position").toEqual([0]);
		expect(modes[ops.indexOf(replace as InkOp)]).toBe("live-page");

		// Undo: the entry built at pen-up puts s3 back at its DOCUMENT position.
		ops.length = 0;
		expect((controller as unknown as { historyStep(redo: boolean): boolean }).historyStep(false)).toBe(true);
		const undo = ops.find((op) => op.type === "replace") as { inserted: InkStroke[]; insertedAt: number[] };
		expect(undo.inserted.map((st) => st.id)).toEqual(["s3"]);
		expect(undo.insertedAt, "the undo entry names the document's position").toEqual([2]);
		expect(strokes.map((st) => st.id)).toContain("s3");
	});

	it("indexes a selection delete against the document too", () => {
		strokes = [inkAt("s1"), inkAt("s2"), { ...inkAt("s3"), page: 2 }];
		const priv = controller as unknown as { selected: string[]; selectionPage: number };
		priv.selected = ["s3"];
		priv.selectionPage = 2;
		expect(controller.deleteSelection()).toBe(true);
		const remove = ops.find((op) => op.type === "remove") as {
			strokes: InkStroke[];
			indices: number[];
		};
		expect(remove.strokes.map((st) => st.id)).toEqual(["s3"]);
		expect(remove.indices).toEqual([2]);
		// The index is for undo's sake; the delete is for the ink's. Assert
		// both, or a delete that indexes correctly and removes nothing reads
		// as a pass.
		expect(strokes.map((st) => st.id)).toEqual(["s1", "s2"]);
	});

	// One write per gesture, not one per sample. The eraser, the lasso drag
	// and insert-space each apply an op per pointer sample, and every one of
	// those went through replaceAll: a scheduled sidecar write per sample, on
	// top of the whole-document copies applyOp and replaceAll each make. The
	// screen has to keep up with the pen; the disk does not.
	it("erases live and writes once, at pen-up", () => {
		setTipMode("eraser");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(205, 205), sample(210, 210), sample(215, 215)]);
		expect(persists).toEqual([]); // nothing written mid-gesture
		pen.penUp();

		const replaces = modes.filter((m, i) => ops[i]!.type === "replace");
		expect(replaces.length).toBeGreaterThan(0);
		expect(replaces.every((m) => m === "live-page")).toBe(true);
		expect(persists).toEqual(["doc-1"]);
	});

	it("a finished stroke still writes immediately - it is not a live gesture", () => {
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(230, 230), sample(260, 260)]);
		pen.penUp();
		const addAt = ops.findIndex((op) => op.type === "add");
		expect(addAt).toBeGreaterThanOrEqual(0);
		expect(modes[addAt]).toBe("commit");
	});

	it("an erase gesture that removed nothing writes nothing", () => {
		setTipMode("eraser");
		// Far from the only stroke, so no sample hits anything.
		pen.penDown(sample(20, 20));
		pen.penRaw([sample(25, 25)]);
		pen.penUp();
		expect(ops.filter((op) => op.type === "replace")).toEqual([]);
		expect(persists).toEqual([]);
	});

	it("an interrupted gesture is written by unmount, not lost", () => {
		// Before batching, every sample wrote, so an erase interrupted by the
		// pane closing was already durable. It has to stay that way.
		setTipMode("eraser");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(205, 205)]);
		expect(persists).toEqual([]);
		controller.unmount();
		expect(persists).toEqual(["doc-1"]);
	});

	it("records one history entry for a whole erase gesture, not one per sample", () => {
		setTipMode("eraser");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(205, 205), sample(210, 210), sample(215, 215)]);
		pen.penUp();
		const ring = controller as unknown as { history: { depth: { done: number } } };
		expect(ops.filter((op) => op.type === "replace").length).toBeGreaterThan(0);
		expect(ring.history.depth.done).toBe(1);
	});

	it("does not undo a prior action while a live erase is unfinished", () => {
		pen.penDown(sample(400, 400));
		pen.penRaw([sample(430, 430)]);
		pen.penUp(); // a completed add, so undo has something to consume
		const added = strokes.find((s) => s.id !== "s1")!;
		setTipMode("eraser");
		pen.penDown(sample(200, 200));
		const opsBefore = ops.length;
		const step = controller as unknown as { historyStep(redo: boolean): boolean };
		expect(step.historyStep(false)).toBe(false);
		expect(step.historyStep(true)).toBe(false);
		expect(ops).toHaveLength(opsBefore);
		expect(strokes.some((s) => s.id === added.id)).toBe(true);
		pen.penUp();
		expect(step.historyStep(false)).toBe(true);
		expect(strokes.some((s) => s.id === "s1")).toBe(true);
	});

	/**
	 * This surface never called `beginStroke`, so the wet renderer's per-stroke
	 * decisions stayed at their initialisers: the centerline was smoothed
	 * forever while the commit followed "Ink smoothing", and the stroke visibly
	 * re-shaped at pen-up (Alan, on a PDF, 2026-09-02). The seam here is
	 * `wetFlat`, the TOOL's flatness read at pen-down: the wet pair is shared
	 * between the two tools, so the layer cannot work it out and must be told.
	 * What the renderer then does with it is pinned in WetInkRenderer.test.ts;
	 * a wet pair needs canvases, which this harness has none of.
	 */
	describe("the wet layer is told the stroke started, and with which tool", () => {
		afterEach(() => {
			setInlineTool("pen");
			setInkShaping(true);
		});

		const wetState = () => controller as unknown as { wetBegun: boolean; wetFlat: boolean };

		it("reads the tool again on every pen-down", () => {
			// One field per stroke, not per layer: two strokes with different
			// tools land on the same wet pair and must not inherit each other.
			setInlineTool("highlighter");
			pen.penDown(sample(200, 200));
			pen.penUp();
			expect(wetState().wetFlat).toBe(true);
			setInlineTool("pen");
			pen.penDown(sample(200, 200));
			pen.penUp();
			expect(wetState().wetFlat).toBe(false);
		});

		it("carries the pen's flatness, so the setting reaches the wet line", () => {
			setInkShaping(false);
			pen.penDown(sample(200, 200));
			pen.penRaw([sample(230, 230)]);
			expect(wetState().wetFlat).toBe(false);
			pen.penUp();
		});

		it("carries the highlighter's flatness on the same shared pair", () => {
			// The booby trap: `shape` is permanently true on this surface, so
			// inferring flatness from it would hand the highlighter exactly the
			// inverse of its exemption.
			setInkShaping(false);
			setInlineTool("highlighter");
			pen.penDown(sample(200, 200));
			pen.penRaw([sample(230, 230)]);
			expect(wetState().wetFlat).toBe(true);
			pen.penUp();
		});
	});
});

/**
 * The tap floor, on the pdf.
 *
 * A tap draws at exactly the nib whatever the pressure (alan, 2026-09-02);
 * `WetInkRenderer.contactHalfWidth` is that ruling and WetInkRenderer.test.ts
 * pins the arithmetic. What is pinned HERE is the thing this surface got
 * wrong: which width it ASKS for. One shared head-draw call site served both
 * the contact dot and the moving head, so the contact dot came out at the
 * shaper's tip floor - 12% of the nib, a speck - and the obvious repair
 * (point that site at `contactHalfWidth`) would have floored the moving head
 * too and taken the taper out of every stroke. Two call sites is the fix and
 * the split is what these assert.
 */
describe("the contact draw is floored and the moving draw is not", () => {
	/** Distinguishable answers, so the assertion is about which was asked. */
	const LIVE_HW = 0.11;
	const CONTACT_HW = 5;

	function harness() {
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
		};
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
		};
		let strokes: InkStroke[] = [];
		const controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => strokes,
			() => "doc-1",
			() => strokes,
			(op) => {
				strokes = applyOp(strokes, op);
			}
		);
		const asked: string[] = [];
		const widths: number[] = [];
		// A stub pair, because the real one needs canvases this harness has
		// none of. It records the QUESTION, which is the whole subject.
		const pair = {
			wetCanvas: { setCssProps: () => {} },
			headCanvas: { setCssProps: () => {} },
			wet: {
				clear: () => {},
				// Pen-up takes the stroke-box clear on EVERY device since
				// 1.4.13, not just under the Boox toggle, so a wet stub that
				// answers only `clear` no longer survives one.
				clearStroke: () => {},
				shape: true,
				beginStroke: () => {},
				appendPoint: () => {},
				finishStroke: () => {},
				head: () => ({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, pressure: 0.5 }),
				liveHalfWidth: () => {
					asked.push("live");
					return LIVE_HW;
				},
				contactHalfWidth: () => {
					asked.push("contact");
					return CONTACT_HW;
				},
				liveWidthPx: () => 1,
			},
			tail: {
				clear: () => {},
				clearAll: () => {},
				draw: () => {},
				drawHead: (
					_cam: unknown,
					_style: unknown,
					_from: unknown,
					_to: unknown,
					_pressure: number,
					hw: number
				) => {
					widths.push(hw);
				},
			},
		};
		const priv = controller as unknown as {
			pair: unknown;
			wetHostPage: number;
			pageSize: Map<number, { wPt: number; hPt: number }>;
		};
		// The page's size in points, which `cameraFor` needs and only a
		// measured page element would otherwise supply. 600 css px / 300 pt
		// is the SCALE the rest of this file's coordinates assume.
		priv.pageSize.set(1, { wPt: 300, hPt: 400 });
		priv.pair = pair;
		priv.wetHostPage = 1;
		const pen = controller as unknown as {
			penDown(s: PenSample): void;
			penRaw(s: PenSample[]): void;
			penUp(): void;
		};
		return { pen, asked, widths };
	}

	afterEach(() => {
		resetTipModeForTest();
	});

	it("asks for the floored width on the first sample and the live width after", () => {
		const { pen, asked, widths } = harness();
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(230, 230)]);
		pen.penRaw([sample(260, 260)]);
		pen.penUp();
		// First accepted sample is the contact dot; everything after it is the
		// moving head and must stay unfloored or the stroke cannot taper.
		expect(asked[0]).toBe("contact");
		expect(asked.slice(1)).not.toContain("contact");
		expect(asked.slice(1)).toContain("live");
		expect(widths[0]).toBe(CONTACT_HW);
		expect(widths.slice(1).every((w) => w === LIVE_HW)).toBe(true);
	});

	it("a tap that never moves is drawn once, at the floored width", () => {
		const { pen, asked, widths } = harness();
		// Down and straight up. The whole visible mark is the contact dot, so
		// if this asked for the bare live width the tap would be a speck.
		pen.penDown(sample(200, 200));
		pen.penUp();
		expect(asked).toEqual(["contact"]);
		expect(widths).toEqual([CONTACT_HW]);
	});
});

describe("pdfPenWidth — the reticle and the stroke must agree", () => {
	// The dot promises the width of the line. It is drawn in css px; the
	// stroke is stored in page units and rendered times the scale. Those two
	// only stay equal if both go through this function, which they did not
	// until a dot came out twice the width of its line on hardware.
	//
	// The function divided by the LIVE scale for a while, which made both of
	// them constant in CSS PX: whatever the zoom, a stroke came out the same
	// number of screen pixels as it was drawn. That is the wrong law, and it
	// is what these cases now pin. Ink belongs to the page, not to the pane:
	// zoom in and the line has to thicken with the text, and a line laid down
	// zoomed in has to still be a full nib when you zoom back out (it came
	// back a hairline - alan, hardware, 2026-09-04). So the divisor is a
	// FIXED reference scale, the stored width is a constant in page points,
	// and the scale enters only where the renderer applies it.
	/** Fit-width on Alan's pane, measured on hardware 2026-08-29. */
	const FIT_WIDTH_SCALE = 1.8692810457516338;
	const SCALES = [1, FIT_WIDTH_SCALE, 3, 5.6];

	it("stores one width in page units, whatever the page is scaled to", () => {
		expect(pdfPenWidth(DEFAULT_PEN.baseWidth, 1)).toBeCloseTo(
			DEFAULT_PEN.baseWidth / PDF_NIB_REFERENCE_SCALE,
			12
		);
		// Not "returns the same number for every scale we pass it" - it takes
		// no scale to pass. That is the fix, stated the only way it can be
		// stated from outside: the live scale cannot reach this width, so no
		// caller can put it back by accident.
		expect(pdfPenWidth).toHaveLength(2);
	});

	it("renders wider as the page is zoomed in, the way the text does", () => {
		for (const scale of SCALES) {
			const stored = pdfPenWidth(DEFAULT_PEN.baseWidth, 1);
			expect(stored * scale).toBeCloseTo(
				(DEFAULT_PEN.baseWidth * scale) / PDF_NIB_REFERENCE_SCALE,
				6
			);
		}
		// Said once more without the formula, because a formula written twice
		// proves only that it was copied: three times the zoom is three times
		// the pixels.
		const one = pdfPenWidth(DEFAULT_PEN.baseWidth, 1) * 1;
		const three = pdfPenWidth(DEFAULT_PEN.baseWidth, 1) * 3;
		expect(three).toBeCloseTo(one * 3, 6);
	});

	it("puts the nib within a tenth of note ink at an ordinary fit-width view", () => {
		// The 2026-08-29 requirement, and the ONLY assertion that pins the
		// reference itself: every other case here is written in terms of
		// PDF_NIB_REFERENCE_SCALE and so survives any value of it. Undivided,
		// a note's 2.2 landed as 4.1 css px on a page shown at 1.87 - nearly
		// twice note ink - which is the number this keeps out.
		const onScreen = pdfPenWidth(DEFAULT_PEN.baseWidth, 1) * FIT_WIDTH_SCALE;
		expect(Math.abs(onScreen - DEFAULT_PEN.baseWidth) / DEFAULT_PEN.baseWidth).toBeLessThan(0.1);
	});

	it("agrees with the reticle at every scale, above the dot's visibility floor", () => {
		for (const scale of SCALES) {
			// The line: what the stroke stores, times what the renderer
			// multiplies by (StrokeRenderer's cam.zoom is this same scale).
			const line = pdfPenWidth(DEFAULT_PEN.baseWidth, 1) * scale;
			// The dot: showCursor's own arithmetic, floor and all - a radius of
			// max(1.5, width * scale / 2), drawn as a square of twice that.
			const dot = Math.max(1.5, (pdfPenWidth(DEFAULT_PEN.baseWidth, 1) * scale) / 2) * 2;
			// Below the floor the dot is deliberately bigger than its line (a
			// sub-3px dot is not a pointer); above it the two must be equal.
			if (line >= 3) expect(dot).toBeCloseTo(line, 12);
			else expect(dot).toBe(3);
		}
		// That the CONTROLLER actually draws this is a separate proof, in
		// "PdfInkController pen reticle - mode-specific looks" below; this one
		// can only say the two formulas agree.
	});

	it("carries the nib size multiplier through", () => {
		const stored = pdfPenWidth(DEFAULT_PEN.baseWidth, 2.5);
		expect(stored).toBeCloseTo((DEFAULT_PEN.baseWidth * 2.5) / PDF_NIB_REFERENCE_SCALE, 12);
		expect(stored * 2).toBeCloseTo((DEFAULT_PEN.baseWidth * 2.5 * 2) / PDF_NIB_REFERENCE_SCALE, 6);
	});
});

/**
 * The same page, at two zooms, has to take the same ink.
 *
 * This is the hardware report of 2026-09-04 as a test: zoom in on a pdf,
 * write, zoom back out, and the line is a hairline. The stored width was
 * divided by the LIVE scale, so a stroke drawn at 3.74 stored half of what
 * the same stroke stored at 1.87 - it looked right while you drew it and was
 * half a nib on the page forever after.
 *
 * Driven through the real penDown/penRaw/penUp, because the divisor lives in
 * penDown's strokeStyle and nothing below it would notice.
 */
describe("a stroke weighs the same on the page at any zoom", () => {
	/** Fit-width on Alan's pane, measured on hardware 2026-08-29. */
	const FIT_WIDTH_SCALE = 1.8692810457516338;

	/** Draw one stroke on a page shown at `scale`, and return what was stored. */
	function strokeDrawnAt(scale: number): InkStroke {
		resetTipModeForTest();
		setInlineTool("pen");
		const ops: InkOp[] = [];
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
		};
		// One page, the same page in POINTS both times - 320 x 420 - shown at
		// whatever css px per point the viewer is currently at. Zooming a pdf
		// is exactly this: the box grows, the page does not.
		probe.current = {
			scroller,
			scaleFactor: scale,
			scaleSource: "test",
			pages: [
				{
					pageNumber: 1,
					leftPx: 0,
					topPx: 0,
					widthPx: 320 * scale,
					heightPx: 420 * scale,
					hasCanvas: true,
				},
			],
		};
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
		};
		const controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => [],
			() => "doc-1",
			() => [],
			(op) => ops.push(op)
		);
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
		const pen = controller as unknown as {
			penDown(s: PenSample): void;
			penRaw(s: PenSample[]): void;
			penUp(): void;
		};
		// The same three PAGE points either way: (100,100) to (130,130).
		pen.penDown(sample(100 * scale, 100 * scale));
		pen.penRaw([sample(115 * scale, 115 * scale), sample(130 * scale, 130 * scale)]);
		pen.penUp();
		const add = ops.find((op) => op.type === "add") as { strokes: InkStroke[] };
		expect(add).toBeDefined();
		return add.strokes[0]!;
	}

	it("stores the same width zoomed in as it does at fit-width", () => {
		const atFit = strokeDrawnAt(FIT_WIDTH_SCALE);
		const zoomedIn = strokeDrawnAt(FIT_WIDTH_SCALE * 2);
		// Not "close to": the width must not depend on the zoom at all. Before
		// this, the second one was half the first, which is the hairline.
		expect(zoomedIn.width).toBeCloseTo(atFit.width, 12);
	});

	it("stores the nib width the reticle promised", () => {
		const stored = strokeDrawnAt(FIT_WIDTH_SCALE).width;
		expect(stored).toBeCloseTo(pdfPenWidth(DEFAULT_PEN.baseWidth, getInkSizeMult("pen")), 12);
	});
});

describe("pan and space on a pdf", () => {
	// Both buttons were on this surface's strip from day one, and both modes
	// DREW. This suite is the routing regression net the lasso taught us to
	// keep: a mode's whole failure can live above its code, in penDown.
	let ops: InkOp[];
	let notices: string[];
	let strokes: InkStroke[];
	let scroller: { scrollLeft: number; scrollTop: number };
	let pen: { penDown(s: PenSample, ev?: unknown): void; penRaw(s: PenSample[]): void; penUp(): void };

	beforeEach(() => {
		resetTipModeForTest();
		ops = [];
		notices = [];
		strokes = [];
		const sc = {
			scrollLeft: 500,
			scrollTop: 500,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
		};
		scroller = sc;
		probe.current = {
			scroller: sc,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
		};
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
		};
		const controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			(page) => strokes.filter((st) => (st.page ?? 1) === page),
			() => "doc-1",
			() => strokes,
			(op) => ops.push(op),
			() => {},
			(message) => notices.push(message)
		);
		pen = controller as unknown as typeof pen;
		(controller as unknown as { boundScroller: unknown }).boundScroller = sc;
	});

	it("pan drags the scroller and never inks", () => {
		setTipMode("pan");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(210, 190)]);
		pen.penRaw([sample(230, 170)]);
		pen.penUp();
		// Content follows the pen: +30 right of travel pulls scrollLeft down.
		expect(scroller.scrollLeft).toBe(470);
		expect(scroller.scrollTop).toBe(530);
		expect(ops).toEqual([]);
	});

	it("space with nothing below the line says so and moves nothing", () => {
		setTipMode("space");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(200, 260)]);
		pen.penUp();
		expect(ops).toEqual([]);
		expect(notices.some((n) => n.includes("below the line"))).toBe(true);
	});

	it("space shoves the rows below the divider, and only those", () => {
		// This suite's scroller sits at scrollTop 500 and the scale is 2, so
		// a sample's page y is (y + 500) / 2: the pen can only reach page y
		// 250 and down. The ink goes at page y ~350, the divider at 300.
		const pts = [100, 105, 110].map((v, i) => ({ x: v, y: 348 + i * 2, pressure: 0.5, t: i * 8 }));
		strokes = [
			{
				id: "s1",
				tool: "pen",
				color: "#000000",
				width: 2,
				points: pts,
				bbox: computeBBox(pts, 4),
				createdAt: 0,
				page: 1,
			},
		];
		setTipMode("space");
		pen.penDown(sample(200, 100)); // page y 300, above the ink at 348
		pen.penRaw([sample(200, 140)]); // page y 320: 20 page units down
		pen.penUp();
		const moves = ops.filter((op) => op.type === "move");
		expect(moves.length).toBeGreaterThan(0);
		const dy = moves.reduce((sum, op) => sum + (op as { dy: number }).dy, 0);
		const dx = moves.reduce((sum, op) => sum + (op as { dx: number }).dx, 0);
		expect(dy).toBeCloseTo(20, 6);
		expect(dx).toBe(0);
		for (const op of moves) expect((op as { strokeIds: string[] }).strokeIds).toEqual(["s1"]);
	});

	it("a live space gesture holds the pane against the reload poll", () => {
		// idle=true mid-shove let the poll swap the strokes out from under a
		// frozen id list. Every gesture that touches the store must hold it.
		const pts = [100, 105, 110].map((v, i) => ({ x: v, y: 348 + i * 2, pressure: 0.5, t: i * 8 }));
		strokes = [
			{
				id: "s1",
				tool: "pen",
				color: "#000000",
				width: 2,
				points: pts,
				bbox: computeBBox(pts, 4),
				createdAt: 0,
				page: 1,
			},
		];
		setTipMode("space");
		const c = pen as unknown as { idle: boolean; forgetHistory(): void };
		pen.penDown(sample(200, 100));
		expect(c.idle).toBe(false);
		// A document switch mid-shove must free the pane, or it never syncs
		// again - the exact failure the drag already guards against.
		c.forgetHistory();
		expect(c.idle).toBe(true);
	});

	it("the nib still inks once pan is left", () => {
		setTipMode("pan");
		pen.penDown(sample(200, 200));
		pen.penUp();
		setTipMode("nib");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(230, 200)]);
		pen.penUp();
		expect(ops.some((op) => op.type === "add")).toBe(true);
	});

	// Alan, hardware, testing on a page with no ink: "all of the tools only
	// work when there's ink on the page but no indication that it's not
	// working other than it's not working". The eraser and the lasso both
	// need existing ink to do anything at all - unlike pan above, which
	// never touches the store and keeps working on a blank page - so an
	// empty page guarantees the whole gesture finds nothing, whichever way
	// the pen moves. Same shape as the space refusal above: said once, at
	// contact, not merely quiet.

	it("erase with no ink on the page says so and erases nothing", () => {
		setTipMode("eraser");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(210, 210)]);
		pen.penUp();
		expect(ops).toEqual([]);
		expect(notices).toEqual(["Handwriting: no ink on the page to erase"]);
	});

	it("erase with ink present on the page does not nag, even though this gesture never reaches it", () => {
		// The ink sits far from where the eraser actually drags: a miss is
		// ordinary use, not a broken tool, and must stay as quiet as it
		// always has. The check is existence on the PAGE, not proximity to
		// the gesture, so this must not fire just because the ink happens
		// to lie elsewhere.
		strokes = [inkAt("s1")];
		setTipMode("eraser");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(210, 210)]);
		pen.penUp();
		expect(notices).toEqual([]);
	});

	it("lasso with no ink on the page says so and selects nothing", () => {
		setTipMode("lasso");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(260, 200)]);
		pen.penRaw([sample(260, 260)]);
		pen.penRaw([sample(200, 260)]);
		pen.penUp();
		expect(notices).toEqual(["Handwriting: no ink on the page to select"]);
	});

	it("lasso with ink present on the page does not nag, even when the loop misses it", () => {
		strokes = [inkAt("s1")];
		setTipMode("lasso");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(260, 200)]);
		pen.penRaw([sample(260, 260)]);
		pen.penRaw([sample(200, 260)]);
		pen.penUp();
		expect(notices).toEqual([]);
	});
});

// "no ink on the page to erase/select" fires once per PAGE, not once per
// contact, ruled 2026-09-14 - the note surface's own bug
// (EmptyPageNotice.ts) reached the PDF controller, which never adopted the
// gate. Two real pages (3 and 4, stacked so a real page hit-test picks
// between them) so per-page scoping - not just per-file - is what is tested;
// a single-page rig cannot tell a composite key from an unscoped one.
describe("PDF empty-page notice fires once per page, not once per contact", () => {
	let ops: InkOp[];
	let notices: string[];
	let strokes: InkStroke[];
	let documentId: string | null;
	let pen: { penDown(s: PenSample, ev?: unknown): void; penRaw(s: PenSample[]): void; penUp(): void };
	let controller: PdfInkController;

	beforeEach(() => {
		resetTipModeForTest();
		ops = [];
		notices = [];
		strokes = [];
		documentId = "doc-1";
		const sc = { scrollLeft: 0, scrollTop: 0, classList: { add: () => {}, remove: () => {} }, querySelector: () => null };
		probe.current = {
			scroller: sc,
			scaleFactor: SCALE,
			scaleSource: "test",
			// Page 3 spans content y 0-800, page 4 spans 800-1600 - a sample at
			// y=200 hits page 3, a sample at y=1000 hits page 4, scroller at 0.
			pages: [
				{ pageNumber: 3, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
				{ pageNumber: 4, leftPx: 0, topPx: 800, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = { devicePixelRatio: 1, clearTimeout: () => {}, setTimeout: () => 0, cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0 };
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			(page) => strokes.filter((st) => (st.page ?? 1) === page),
			() => documentId,
			() => strokes,
			(op) => ops.push(op),
			() => {},
			(message) => notices.push(message)
		);
		pen = controller as unknown as typeof pen;
		(controller as unknown as { boundScroller: unknown }).boundScroller = sc;
	});

	const eraseAt = (y: number) => { setTipMode("eraser"); pen.penDown(sample(200, y)); pen.penRaw([sample(210, y + 10)]); pen.penUp(); };

	it("three erase gestures on an empty page produce ONE notify, not three", () => {
		eraseAt(200); eraseAt(200); eraseAt(200);
		expect(notices).toEqual(["Handwriting: no ink on the page to erase"]);
	});

	it("a different empty page gets its own notify - per-page, not per-file", () => {
		eraseAt(200); // page 3, claims it
		eraseAt(1000); // page 4, its own episode
		expect(notices).toEqual(["Handwriting: no ink on the page to erase", "Handwriting: no ink on the page to erase"]);
	});

	it("ink arriving on a claimed page re-arms it; ink leaving again does not re-notify until it is claimed again", () => {
		eraseAt(200); // page 3 empty, claims and notifies once
		strokes = [{ ...inkAt("s1"), page: 3 }];
		eraseAt(200); // page 3 now has ink: no notify, and this re-arms the episode
		expect(notices).toEqual(["Handwriting: no ink on the page to erase"]);
		strokes = []; // erased again, page 3 empty once more
		eraseAt(200); // re-armed, so this is news again
		expect(notices).toEqual(["Handwriting: no ink on the page to erase", "Handwriting: no ink on the page to erase"]);
	});

	// The gesture-start re-arm above is
	// a belt, not the only re-arm - ink that arrives and leaves again BETWEEN
	// gestures (undo, another pane, a sync), with no erase or lasso gesture
	// in between to notice it, must still be forgotten the moment refresh()
	// reports "the ink changed underneath us", or the eraser's next verdict
	// on that now-empty page is stale.
	// refresh() runs on every undo,
	// paste, other-pane commit and sync, so it must not filter every page's
	// strokes when nothing is claimed - only claimedPages is ever walked.
	it("refresh() with no claimed pages does no per-page stroke filtering at all", () => {
		let strokesCalls = 0;
		const spiedController = new PdfInkController(
			{} as HTMLElement,
			{ devicePixelRatio: 1, clearTimeout: () => {}, setTimeout: () => 0, cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0 } as unknown as Window,
			(page) => { strokesCalls++; return strokes.filter((st) => (st.page ?? 1) === page); },
			() => documentId,
			() => strokes,
			(op) => ops.push(op),
			() => {},
			(message) => notices.push(message)
		);
		strokesCalls = 0; // discard any calls the constructor itself made
		spiedController.refresh();
		expect(strokesCalls).toBe(0);
	});

	it("refresh() (ink changed with no gesture) re-arms a claimed page too, not only a gesture start", () => {
		eraseAt(200); // page 3 empty, claims and notifies once
		strokes = [{ ...inkAt("s1"), page: 3 }];
		controller.refresh(); // ink arrived with NO erase/lasso gesture in between
		strokes = []; // and left again (undo, another pane, a sync) - still no gesture
		eraseAt(200); // re-armed by refresh(), so this is news again
		expect(notices).toEqual(["Handwriting: no ink on the page to erase", "Handwriting: no ink on the page to erase"]);
	});

	it("unmount (the note surface's file-switch/teardown site) forgets every page", () => {
		eraseAt(200);
		expect(notices).toEqual(["Handwriting: no ink on the page to erase"]);
		controller.unmount();
		eraseAt(200);
		expect(notices).toEqual(["Handwriting: no ink on the page to erase", "Handwriting: no ink on the page to erase"]);
	});

	it("lasso on an empty page also fires once per page, same gate", () => {
		const lassoAt = (y: number) => { setTipMode("lasso"); pen.penDown(sample(200, y)); pen.penRaw([sample(260, y)]); pen.penRaw([sample(260, y + 60)]); pen.penRaw([sample(200, y + 60)]); pen.penUp(); };
		lassoAt(200); lassoAt(200);
		expect(notices).toEqual(["Handwriting: no ink on the page to select"]);
	});

	// The gate's own contract (EmptyPageNotice.ts): a null path never speaks
	// and never RECORDS, because there is no key that would later be
	// forgotten. `documentId() ?? ""` would have broken that - every
	// unidentified document reduces to the same "#3" key, so the first one to
	// touch page 3 would speak and silently arm the key for every other
	// unidentified document that ever touches page 3.
	//
	// NOT reachable through a real gesture: `penDown`'s own `!this.documentId()`
	// guard (above every call site) already returns "still identifying this
	// PDF" before an erase or lasso branch runs, so a real pen never lets
	// `sayIfPageEmpty` see a null id today (confirmed - driving `eraseAt` with
	// `documentId = null` here produces that OTHER notice, not this method at
	// all, so it cannot be this method's red/green proof). This is a contract
	// test on the method directly: `sayIfPageEmpty` must hold its own
	// invariant regardless of what happens to call it, now or later.
	it("sayIfPageEmpty never speaks or records for a null document id (contract, not gesture-reachable today)", () => {
		documentId = null;
		(controller as unknown as { sayIfPageEmpty(page: number, kind: "erase" | "select"): void }).sayIfPageEmpty(3, "erase");
		(controller as unknown as { sayIfPageEmpty(page: number, kind: "erase" | "select"): void }).sayIfPageEmpty(3, "erase");
		expect(notices).toEqual([]);
		documentId = "doc-1";
		(controller as unknown as { sayIfPageEmpty(page: number, kind: "erase" | "select"): void }).sayIfPageEmpty(3, "erase");
		expect(notices).toEqual(["Handwriting: no ink on the page to erase"]);
	});
});

describe("the scale a pointer sample is converted with", () => {
	// The offset this prevents: input converted with `--scale-factor` while
	// the ink was drawn at the box's own scale. Settled, the two agree and
	// nothing shows. Mid-zoom they do not, and the ink lands where the
	// pointer was at the PREVIOUS zoom - growing with the distance moved,
	// then healing when the viewer catches up (alan, on hardware).
	it("comes from the box when the page has been measured", () => {
		// A page of 612pt shown 2145px wide is at 3.5, whatever the viewer
		// variable happens to say this frame.
		expect(pointerScale(2145, 612, 1.87)).toBeCloseTo(3.5049, 4);
	});

	it("agrees with the viewer once it has settled", () => {
		expect(pointerScale(612 * 1.87, 612, 1.87)).toBeCloseTo(1.87, 10);
	});

	it("falls back to the viewer for a page nobody has painted", () => {
		expect(pointerScale(2145, 0, 1.87)).toBe(1.87);
	});

	it("falls back rather than dividing by a box with no width", () => {
		expect(pointerScale(0, 612, 1.87)).toBe(1.87);
		expect(Number.isFinite(pointerScale(0, 0, 1.87))).toBe(true);
	});
});

describe("PDF destructive gestures while the sidecar is unknown", () => {
	function rig(read: () => Promise<ParseResult>) {
		resetTipModeForTest();
		const notices: string[] = [];
		const saved: string[][] = [];
		const store = new PdfInkStore();
		store.attachHost({
			load: read,
			schedule: (_id, data) => void saved.push(data.strokes.map((s) => s.id)),
			notice: (message) => notices.push(message),
		});
		const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add: () => {}, remove: () => {} }, querySelector: () => null };
		probe.current = {
			scroller, scaleFactor: SCALE, scaleSource: "test",
			pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true }],
		};
		const win = { devicePixelRatio: 1, clearTimeout: () => {}, setTimeout: () => 0, cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0 };
		const controller = new (PdfInkController as unknown as new (...args: any[]) => PdfInkController)(
			{} as HTMLElement, win as unknown as Window,
			(page: number) => store.strokesOnPage("doc-1", page), () => "doc-1", () => store.strokes("doc-1"),
			(op: InkOp, mode?: string) => {
				if (mode === "live-page") store.applyLivePage("doc-1", op);
				else store.replaceAll("doc-1", applyOp(store.strokes("doc-1"), op));
			},
			() => {}, (message: string) => notices.push(message), (id: string) => store.save(id),
			() => false, () => "darken", () => store.inkReady("doc-1")
		);
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
		const pen = controller as unknown as { penDown(s: PenSample): void; penRaw(s: PenSample[]): void; penUp(): void };
		return { store, controller, pen, notices, saved };
	}

	it("refuses an erase before the first read and makes the later erase undoable", async () => {
		let finish!: (result: ParseResult) => void;
		const pending = new Promise<ParseResult>((resolve) => { finish = resolve; });
		const { store, controller, pen, notices, saved } = rig(() => pending);
		const loading = store.ensureLoaded("doc-1");
		setTipMode("eraser");
		pen.penDown(sample(200, 200));
		pen.penDown(sample(200, 200));
		expect(controller.idle).toBe(true);
		expect(notices).not.toContain("Handwriting: no ink on the page to erase");
		expect(notices.filter((message) => message.includes("not ready"))).toHaveLength(1);
		finish({ data: { ...emptyPage("doc-1"), surface: "pdf", strokes: [inkAt("saved"), { ...inkAt("other-page"), page: 2 }] }, recovered: false });
		await loading;
		pen.penRaw([sample(210, 210)]);
		pen.penUp();
		expect(store.strokes("doc-1").map((s) => s.id)).toEqual(["saved", "other-page"]);
		expect(saved).toEqual([]);
		pen.penDown(sample(200, 200));
		pen.penUp();
		expect(store.strokes("doc-1").map((s) => s.id)).toEqual(["other-page"]);
		const step = controller as unknown as { historyStep(redo: boolean): boolean };
		expect(step.historyStep(false)).toBe(true);
		expect(store.strokes("doc-1").map((s) => s.id)).toEqual(["saved", "other-page"]);
		expect(step.historyStep(true)).toBe(true);
		expect(store.strokes("doc-1").map((s) => s.id)).toEqual(["other-page"]);
	});

	it("keeps a damaged or pending lasso silent and does not spend the later empty-page notice", async () => {
		const bad: ParseResult = { data: emptyPage("doc-1"), recovered: true, damaged: true };
		const answers = [bad, { data: { ...emptyPage("doc-1"), surface: "pdf" as const }, recovered: false }];
		const { store, pen, notices } = rig(async () => answers.shift()!);
		setTipMode("lasso");
		const loading = store.ensureLoaded("doc-1");
		pen.penDown(sample(200, 200));
		pen.penUp();
		await loading;
		pen.penDown(sample(200, 200));
		pen.penUp();
		expect(notices).not.toContain("Handwriting: no ink on the page to select");
		await store.ensureLoaded("doc-1");
		pen.penDown(sample(200, 200));
		pen.penUp();
		expect(notices).toContain("Handwriting: no ink on the page to select");
	});
});

describe("PDF page rotation changes while a pane stays open", () => {
	function rig(widthPx: number, heightPx: number) {
		resetTipModeForTest();
		const notices: string[] = [];
		const ops: InkOp[] = [];
		const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add: () => {}, remove: () => {} }, querySelector: () => null };
		probe.current = {
			scroller, scaleFactor: 1, scaleSource: "test",
			pages: [{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx, heightPx, hasCanvas: true }],
		};
		const win = { devicePixelRatio: 1, clearTimeout: () => {}, setTimeout: () => 0, cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0 };
		const controller = new PdfInkController(
			{} as HTMLElement, win as unknown as Window, () => [], () => "doc-1", () => [],
			(op) => ops.push(op), () => {}, (message) => notices.push(message)
		);
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
		const measure = (page: number, w: number, h: number, scale: number) =>
			(controller as unknown as { pageWidthPt(p: number, w: number, h: number, s: number): number })
				.pageWidthPt(page, w, h, scale);
		const pen = controller as unknown as { penDown(s: PenSample): void; penRaw(s: PenSample[]): void; penUp(): void };
		return { controller, measure, pen, notices, ops };
	}

	it("does not call a near-square page rotated when zoom rounds its sides to a tie", () => {
		const { controller, measure, pen, ops } = rig(301, 300);
		measure(1, 301, 300, 1);
		measure(1, 150, 150, 0.5);
		measure(1, 150, 151, 0.5);
		expect(controller.isRotated(1)).toBe(false);
		pen.penDown(sample(100, 100));
		pen.penRaw([sample(120, 120)]);
		pen.penUp();
		expect(ops.some((op) => op.type === "add")).toBe(true);
	});

	it("refuses a truly rotated page with a notice, then admits it after restoration", () => {
		const { controller, measure, pen, notices, ops } = rig(300, 400);
		measure(1, 300, 400, 1);
		measure(2, 500, 700, 1);
		measure(1, 400, 300, 1);
		expect(controller.isRotated(1)).toBe(true);
		expect(controller.isRotated(2)).toBe(false);
		pen.penDown(sample(100, 100));
		pen.penDown(sample(100, 100));
		expect(ops).toEqual([]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("rotated");
		measure(1, 300, 400, 1);
		expect(controller.isRotated(1)).toBe(false);
		pen.penDown(sample(100, 100));
		pen.penRaw([sample(120, 120)]);
		pen.penUp();
		expect(ops.some((op) => op.type === "add")).toBe(true);
	});
});

/**
 * Audit doc §5f: the note surface's hover dot obeys the "Pen reticle"
 * setting (and Boox mode, which turns it off for e-ink); this surface
 * consulted nothing, so the dot kept repainting on the PDF regardless. The
 * fix reads the same flag (InkOverlay's `penReticleOn`, via the new
 * `penReticleEnabled` getter) at the same two points the note surface
 * already gates: before painting the dot, and before arming the timer that
 * repaints it - an invisible dot that still costs a timer per move defeats
 * the e-ink point.
 *
 * `showCursor`/`hideCursor`/`refreshStrip` are private; reached the same way
 * the lasso tests above reach `penDown`/`penRaw`/`penUp` - a cast, not a
 * parallel public API grown just for a test.
 */
describe("PdfInkController pen reticle", () => {
	let controller: PdfInkController;
	let priv: {
		showCursor(sample: PenSample, pointerType?: string): void;
		hideCursor(): void;
		refreshStrip(): void;
	};
	let cursorEl: {
		setAttribute(): void;
		remove(): void;
		classList: { toggle(): void; add(): void; remove(): void };
		setCssStyles(styles: Record<string, unknown>): void;
		parentElement: unknown;
	} | null;
	let cursorStyle: Record<string, unknown>;
	let setTimeoutSpy: ReturnType<typeof vi.fn>;
	let clearTimeoutSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		resetTipModeForTest();
		cursorEl = null;
		cursorStyle = {};
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
			setCssStyles: () => {},
			createDiv: cursorChildren(() => {
				cursorEl = {
					setAttribute: () => {},
					remove: () => {},
					classList: { toggle: () => {}, add: () => {}, remove: () => {} },
					setCssStyles: (styles: Record<string, unknown>) => {
						Object.assign(cursorStyle, styles);
					},
					parentElement: scroller,
				};
				return cursorEl;
			}),
		};
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		setTimeoutSpy = vi.fn(() => 1);
		clearTimeoutSpy = vi.fn();
		const win = {
			devicePixelRatio: 1,
			clearTimeout: clearTimeoutSpy,
			setTimeout: setTimeoutSpy,
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
			getComputedStyle: () => ({ position: "relative" }),
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => [],
			() => "doc-1",
			() => [],
			() => {}
		);
		priv = controller as unknown as typeof priv;
	});

	afterEach(() => {
		setPenReticle(true);
	});

	it("flag off: a hover paints no cursor and arms no timer", () => {
		setPenReticle(false);
		priv.showCursor(sample(10, 10), "pen");
		expect(cursorEl).toBeNull();
		expect(setTimeoutSpy).not.toHaveBeenCalled();
	});

	it("flag on: a hover is unchanged - dot painted, hide timer armed", () => {
		setPenReticle(true);
		priv.showCursor(sample(10, 10), "pen");
		expect(cursorEl).not.toBeNull();
		expect(cursorStyle.display).toBe("block");
		expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
	});

	it("flag turned off while a dot is showing: refreshStrip hides it", () => {
		setPenReticle(true);
		priv.showCursor(sample(10, 10), "pen");
		expect(cursorStyle.display).toBe("block");
		setPenReticle(false);
		priv.refreshStrip();
		expect(cursorStyle.display).toBe("none");
		expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
	});
});

/**
 * Task 2: the pdf reticle used to special-case ONLY the eraser - every other
 * mode got `Math.max(1.5, nib)`, the same near-invisible dot the nib itself
 * gets, sized off the ink width rather than off what the tip is about to do.
 * These pin the three looks `showCursor` now gives lasso, pan and space,
 * against the exact fixed constants the note surface's `showPenCursor` uses
 * for `LASSO_CURSOR_CLASS` (9), `PAN_CURSOR_CLASS` (11) and
 * `SPACE_CURSOR_CLASS` (24, half-width) - see `InkOverlay.ts`.
 *
 * The fake `classList` here actually tracks membership (a `Set`), unlike the
 * no-op one in "PdfInkController pen reticle" above: those tests only needed
 * `display`/timers, these need to know WHICH class survived.
 */
describe("PdfInkController pen reticle - mode-specific looks", () => {
	let controller: PdfInkController;
	let priv: { showCursor(sample: PenSample, pointerType?: string): void };
	let cursorClasses: Set<string>;
	let cursorStyle: Record<string, unknown>;

	beforeEach(() => {
		resetTipModeForTest();
		setPenReticle(true);
		cursorClasses = new Set();
		cursorStyle = {};
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
			setCssStyles: () => {},
			createDiv: cursorChildren(() => ({
				setAttribute: () => {},
				remove: () => {},
				classList: {
					add: (...cls: string[]) => cls.forEach((c) => cursorClasses.add(c)),
					remove: (...cls: string[]) => cls.forEach((c) => cursorClasses.delete(c)),
					toggle: (cls: string, on?: boolean) => {
						const next = on ?? !cursorClasses.has(cls);
						if (next) cursorClasses.add(cls);
						else cursorClasses.delete(cls);
					},
				},
				setCssStyles: (styles: Record<string, unknown>) => {
					Object.assign(cursorStyle, styles);
				},
				parentElement: scroller,
			})),
		};
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 1,
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
			getComputedStyle: () => ({ position: "relative" }),
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => [],
			() => "doc-1",
			() => [],
			() => {}
		);
		priv = controller as unknown as typeof priv;
	});

	afterEach(() => {
		setPenReticle(true);
	});

	it("nib: no ring, no pan ring, no space rule", () => {
		setTipMode("nib");
		priv.showCursor(sample(10, 10), "pen");
		expect(cursorClasses.has("handwriting-pdf-cursor-ring")).toBe(false);
		expect(cursorClasses.has("handwriting-pdf-cursor-pan")).toBe(false);
		expect(cursorClasses.has("handwriting-pdf-cursor-space")).toBe(false);
	});

	it("lasso: a dashed ring at the fixed 9px radius, not the nib width", () => {
		setTipMode("lasso");
		priv.showCursor(sample(10, 10), "pen");
		expect(cursorClasses.has("handwriting-pdf-cursor-ring")).toBe(true);
		expect(cursorClasses.has("handwriting-pdf-cursor-pan")).toBe(false);
		// 9px radius -> 18px square, whatever the nib width setting is.
		expect(cursorStyle.width).toBe("18px");
		expect(cursorStyle.height).toBe("18px");
	});

	it("pan: the one solid ring, at the fixed 11px radius", () => {
		setTipMode("pan");
		priv.showCursor(sample(10, 10), "pen");
		expect(cursorClasses.has("handwriting-pdf-cursor-pan")).toBe(true);
		// Solid, not dashed: must not also carry the eraser/lasso ring class.
		expect(cursorClasses.has("handwriting-pdf-cursor-ring")).toBe(false);
		expect(cursorStyle.width).toBe("22px");
		expect(cursorStyle.height).toBe("22px");
	});

	it("space: a dashed rule, not a ring - zero height, fixed 48px width", () => {
		setTipMode("space");
		priv.showCursor(sample(10, 10), "pen");
		expect(cursorClasses.has("handwriting-pdf-cursor-space")).toBe(true);
		expect(cursorClasses.has("handwriting-pdf-cursor-ring")).toBe(false);
		expect(cursorClasses.has("handwriting-pdf-cursor-pan")).toBe(false);
		expect(cursorStyle.width).toBe("48px");
		expect(cursorStyle.height).toBe("0px");
	});

	it("nib: the dot grows with the zoom, because the ink it promises does", () => {
		setTipMode("nib");
		setInlineTool("pen");
		// Zoomed past this fixture's own scale, and well past the 1.5px floor,
		// so the number can only come from the live scale. Under the old law
		// the dot was the same size at every zoom (width / scale * scale) and
		// small enough to be floored to 3px at the default nib.
		(probe.current as { scaleFactor: number }).scaleFactor = 4;
		priv.showCursor(sample(10, 10), "pen");
		const ink = pdfPenWidth(DEFAULT_PEN.baseWidth, getInkSizeMult("pen")) * 4;
		expect(parseFloat(String(cursorStyle.width))).toBeCloseTo(ink, 6);
		expect(parseFloat(String(cursorStyle.height))).toBeCloseTo(ink, 6);
	});

	it("eraser still reads its true erase radius, unaffected by the new branches", () => {
		setTipMode("eraser");
		priv.showCursor(sample(10, 10), "pen");
		expect(cursorClasses.has("handwriting-pdf-cursor-ring")).toBe(true);
		const r = getEraserRadiusPx();
		expect(cursorStyle.width).toBe(`${r * 2}px`);
	});
});

/**
 * Task 1: pan, lasso and space left the reticle exactly where the eraser was
 * before d2b6f4a - shown only from a hover sample, so the same 1000ms
 * watchdog (`showCursor`'s own `setTimeout`) took it away mid-gesture because
 * nothing re-armed it once the pen was down and hover samples stopped
 * arriving. These drive a REAL gesture through `penDown`/`penRaw`/`penUp` -
 * not the wrapper methods directly - and check the same evidence the erase
 * fix rests on: the watchdog is re-armed (a fresh `setTimeout`) at pen-down
 * and again on the next raw batch, without a fresh hover sample in between,
 * and the reticle is put away at pen-up rather than left for the watchdog.
 *
 * `cursorEl` is primed by one hover first, matching the limit
 * `showLasso/SpaceCursor` both state in their own comments: neither BUILDS
 * the reticle, they only refresh one that hover already built.
 *
 * THE PAN IS THE EXCEPTION NOW, and its case in here is the inverse of the
 * other two. 1.4.12 ruled that a pan drag paints no reticle at all
 * (`penReticleShown`, PenCursor.ts) and wears the grabbing hand instead; the
 * pdf surface was left behind by that fix, as the design notes say
 * (1.4.12-design §11). So where lasso and space assert that the ring SURVIVES
 * the drag, the pan asserts that it goes away once, stays away for every
 * batch, and that something is under the hand in its place the whole time.
 */
describe("PdfInkController pen reticle - stays alive through lasso and space, and stands down for a pan", () => {
	let controller: PdfInkController;
	let pen: {
		showCursor(s: PenSample, pointerType?: string): void;
		penDown(s: PenSample, ev?: unknown): void;
		penRaw(s: PenSample[]): void;
		penUp(): void;
	};
	let strokes: InkStroke[];
	let cursorStyle: Record<string, unknown>;
	let setTimeoutSpy: ReturnType<typeof vi.fn>;
	let clearTimeoutSpy: ReturnType<typeof vi.fn>;
	/** Real membership, not a no-op: the pan case asks WHICH class survived. */
	let scrollerClasses: Set<string>;

	beforeEach(() => {
		resetTipModeForTest();
		setPenReticle(true);
		strokes = [];
		cursorStyle = { display: "none" };
		scrollerClasses = new Set<string>();
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: {
				add: (c: string) => scrollerClasses.add(c),
				remove: (c: string) => scrollerClasses.delete(c),
			},
			querySelector: () => null,
			setCssStyles: () => {},
			createDiv: cursorChildren(() => ({
				setAttribute: () => {},
				remove: () => {},
				classList: { add: () => {}, remove: () => {}, toggle: () => {} },
				setCssStyles: (styles: Record<string, unknown>) => {
					Object.assign(cursorStyle, styles);
				},
				parentElement: scroller,
			})),
		};
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		setTimeoutSpy = vi.fn(() => 1);
		clearTimeoutSpy = vi.fn();
		const win = {
			devicePixelRatio: 1,
			clearTimeout: clearTimeoutSpy,
			setTimeout: setTimeoutSpy,
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
			getComputedStyle: () => ({ position: "relative" }),
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			(page) => strokes.filter((st) => (st.page ?? 1) === page),
			() => "doc-1",
			() => strokes,
			() => {}
		);
		pen = controller as unknown as typeof pen;
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
	});

	afterEach(() => {
		setPenReticle(true);
	});

	it("pan: pen-down puts the reticle away for the grabbing hand, and every batch leaves it away", () => {
		// Hover first, as the hardware would: ring up, `cursor: none` on.
		pen.showCursor(sample(10, 10), "pen");
		expect(cursorStyle.display).toBe("block");
		expect(scrollerClasses.has("handwriting-pdf-hover")).toBe(true);
		setTimeoutSpy.mockClear();
		setTipMode("pan");

		pen.penDown(sample(200, 200));
		expect(cursorStyle.display, "the pan kept a ring for a tip that is not marking").toBe(
			"none"
		);
		expect(
			scrollerClasses.has("handwriting-pdf-pan-drag"),
			"the drag hid the reticle and put no cursor in its place"
		).toBe(true);
		expect(
			scrollerClasses.has("handwriting-pdf-hover"),
			"`cursor: none` was left on the viewer under the grabbing hand"
		).toBe(false);
		expect(
			setTimeoutSpy,
			"a watchdog was armed for a reticle that is not on screen"
		).not.toHaveBeenCalled();

		// TWO batches, because "once per drag" is a claim about the second one
		// as much as the first: the branch used to repaint and re-arm on each.
		pen.penRaw([sample(210, 190)]);
		pen.penRaw([sample(230, 170)]);
		expect(cursorStyle.display, "a raw batch brought the ring back").toBe("none");
		expect(scrollerClasses.has("handwriting-pdf-pan-drag")).toBe(true);
		expect(setTimeoutSpy, "a raw batch re-armed the reticle watchdog").not.toHaveBeenCalled();

		pen.penUp();
		expect(
			scrollerClasses.has("handwriting-pdf-pan-drag"),
			"the grabbing hand outlived the drag"
		).toBe(false);
		expect(cursorStyle.display).toBe("none");
	});

	it("pan: nothing can paint the ring mid-drag, not even a direct showCursor", () => {
		// The call sites that used to paint it are gone, so this reaches the
		// gate that keeps them gone - `penReticleShown` read inside
		// `showCursor` itself. A new mode, or a new caller (`refreshStrip`
		// reaches this method), must not be able to put a ring back.
		pen.showCursor(sample(10, 10), "pen");
		setTipMode("pan");
		pen.penDown(sample(200, 200));
		expect(cursorStyle.display).toBe("none");

		pen.showCursor(sample(300, 300), "pen");

		expect(cursorStyle.display, "a direct call painted a ring mid-pan").toBe("none");
		// And it REFUSED rather than hid: hiding here would take the grabbing
		// hand off and leave the viewer with no pointer at all mid-drag.
		expect(
			scrollerClasses.has("handwriting-pdf-pan-drag"),
			"the gate took the grabbing hand away mid-drag"
		).toBe(true);
		expect(
			scrollerClasses.has("handwriting-pdf-hover"),
			"the gate put `cursor: none` back over a hidden reticle"
		).toBe(false);
	});

	it("pan: the ring comes back on the next hover once the drag is over", () => {
		// The other end of the gate. `panLast` is cleared before the reticle
		// is touched at pen-up, so the mode is pan and the ring is allowed
		// again the moment there is no drag under it.
		pen.showCursor(sample(10, 10), "pen");
		setTipMode("pan");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(210, 190)]);
		pen.penUp();

		pen.showCursor(sample(40, 40), "pen");

		expect(cursorStyle.display, "the pan tip lost its hover ring for good").toBe("block");
		expect(scrollerClasses.has("handwriting-pdf-pan-drag")).toBe(false);
		expect(scrollerClasses.has("handwriting-pdf-hover")).toBe(true);
	});

	it("lasso: a fresh loop's pen-down and its raw batch each re-arm the watchdog", () => {
		pen.showCursor(sample(10, 10), "pen");
		setTimeoutSpy.mockClear();
		setTipMode("lasso");
		pen.penDown(sample(200, 200));
		expect(setTimeoutSpy, "pen-down did not refresh the reticle").toHaveBeenCalledTimes(1);
		pen.penRaw([sample(210, 210)]);
		expect(setTimeoutSpy, "the raw batch did not refresh the reticle").toHaveBeenCalledTimes(2);
		expect(cursorStyle.display).toBe("block");
		pen.penUp();
		expect(cursorStyle.display, "pen-up left the reticle up instead of hiding it").toBe("none");
	});

	it("space: pen-down and the next raw batch each re-arm the watchdog", () => {
		// `showSpaceCursor` is only reached once the gesture has ink to move -
		// the "no ink below the line" refusal returns before it, matching the
		// eraser's own "show only once the erase actually begins" shape. So
		// this needs real ink below the touch point, the same as "space
		// shoves the rows below the divider" in the "pan and space" suite.
		const pts = [100, 105, 110].map((v, i) => ({ x: v, y: 200 + i * 2, pressure: 0.5, t: i * 8 }));
		strokes = [
			{
				id: "s1",
				tool: "pen",
				color: "#000000",
				width: 2,
				points: pts,
				bbox: computeBBox(pts, 4),
				createdAt: 0,
				page: 1,
			},
		];
		pen.showCursor(sample(10, 10), "pen");
		setTimeoutSpy.mockClear();
		setTipMode("space");
		// Page y at scrollTop 0, scale 2: contentY / 2. 100 -> page y 50,
		// above the ink at ~200, so strokeIdsBelow finds it.
		pen.penDown(sample(200, 100));
		expect(setTimeoutSpy, "pen-down did not refresh the reticle").toHaveBeenCalledTimes(1);
		expect(cursorStyle.display).toBe("block");
		pen.penRaw([sample(200, 140)]);
		expect(setTimeoutSpy, "the raw batch did not refresh the reticle").toHaveBeenCalledTimes(2);
		expect(cursorStyle.display).toBe("block");
		pen.penUp();
		expect(cursorStyle.display, "pen-up left the reticle up instead of hiding it").toBe("none");
	});
});

/**
 * The strip's buttons, and what the selection commands say when they refuse.
 *
 * Audit doc §5k/AD1: Z routed the strip's delete/copy/paste out to the
 * commands, and the commands resolve a surface from the workspace - so on a
 * split with a note active the PDF's own trash button deleted the NOTE's ink.
 * These drive `stripExec` directly, which is the whole dispatch: a button acts
 * on the controller it is mounted on, and the injected `exec` - the passthrough
 * to Obsidian's command palette - must never be reached for those four ids.
 */
describe("PdfInkController strip dispatch", () => {
	let strokes: InkStroke[];
	let ops: InkOp[];
	let notices: string[];
	let execs: string[];
	let docId: string | null;
	let controller: PdfInkController;
	let pen: { penDown(s: PenSample): void; penRaw(s: PenSample[]): void; penUp(): void };
	let priv: { stripExec(id: string): void };

	beforeEach(() => {
		resetTipModeForTest();
		clearInkClipboard();
		strokes = [inkAt("s1")];
		ops = [];
		notices = [];
		execs = [];
		docId = "doc-1";
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
		};
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => strokes,
			() => docId,
			() => strokes,
			(op) => ops.push(op),
			(id) => execs.push(id),
			(message) => notices.push(message)
		);
		pen = controller as unknown as typeof pen;
		priv = controller as unknown as typeof priv;
	});

	afterEach(() => {
		clearInkClipboard();
	});

	/** Select s1, through the real lasso path. */
	function select(): void {
		setTipMode("lasso");
		const corners: [number, number][] = [
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		];
		pen.penDown(sample(corners[0]![0], corners[0]![1]));
		for (const [x, y] of corners.slice(1)) pen.penRaw([sample(x, y)]);
		pen.penRaw([sample(corners[0]![0], corners[0]![1])]);
		pen.penUp();
	}

	it("the trash button deletes THIS controller's selection and calls no command", () => {
		select();
		priv.stripExec("handwriting:delete-selected-ink");
		expect(ops).toEqual([
			{ type: "remove", path: "doc-1", strokes: [strokes[0]], indices: [0] },
		]);
		expect(execs).toEqual([]);
	});

	it("the copy button copies THIS controller's selection and calls no command", () => {
		select();
		priv.stripExec("handwriting:copy-selected-ink");
		expect(clipboardSize()).toBe(1);
		expect(notices).toEqual(["Handwriting: copied 1 stroke(s)"]);
		expect(execs).toEqual([]);
	});

	it("the paste button pastes into THIS controller and calls no command", () => {
		select();
		controller.copySelection();
		notices.length = 0;
		priv.stripExec("handwriting:paste-ink");
		expect(ops.map((o) => o.type)).toEqual(["add"]);
		expect(notices).toEqual(["Handwriting: pasted 1 stroke"]);
		expect(execs).toEqual([]);
	});

	it("cut is routed here too, in the wording the note command uses", () => {
		select();
		priv.stripExec("handwriting:cut-selected-ink");
		expect(clipboardSize()).toBe(1);
		expect(ops.map((o) => o.type)).toEqual(["remove"]);
		expect(notices).toEqual(["Handwriting: cut 1 stroke(s)"]);
		expect(execs).toEqual([]);
	});

	it("every other command id still reaches the host's exec", () => {
		priv.stripExec("handwriting:inline-tool-pen");
		expect(execs).toEqual(["handwriting:inline-tool-pen"]);
	});

	it("undo stays on this view's own ring, not the editor's", () => {
		select();
		controller.deleteSelection();
		priv.stripExec("editor:undo");
		expect(ops.map((o) => o.type)).toEqual(["remove", "add"]);
		expect(execs).toEqual([]);
	});

	it("copy with nothing lassoed says lasso first and leaves the clipboard alone", () => {
		// Audit doc §5k/AD3: this said "copied 0 strokes", and the clipboard
		// still held whatever was copied before - so the next paste brought
		// back the older ink and read as this copy having gone astray.
		select();
		controller.copySelection();
		notices.length = 0;
		controller.dissolveSelection();
		priv.stripExec("handwriting:copy-selected-ink");
		expect(notices).toEqual(["Handwriting: lasso some ink first"]);
		expect(clipboardSize()).toBe(1);
	});

	it("paste before the document is identified says so and changes nothing", () => {
		select();
		controller.copySelection();
		notices.length = 0;
		ops.length = 0;
		docId = null;
		priv.stripExec("handwriting:paste-ink");
		expect(notices).toEqual(["Handwriting: still identifying this PDF - try again in a moment"]);
		expect(ops).toEqual([]);
	});

	it("delete before the document is identified names the id, not the lasso", () => {
		docId = null;
		priv.stripExec("handwriting:delete-selected-ink");
		expect(notices).toEqual(["Handwriting: still identifying this PDF - try again in a moment"]);
		expect(ops).toEqual([]);
	});

	it("cut refreshes the strip itself, not only through deleteSelection", () => {
		// Audit doc §5k/(b): a cut that copies nothing never reaches
		// deleteSelection, and the strip kept the lights of a selection that
		// had already gone.
		const refreshStrip = vi.spyOn(controller, "refreshStrip");
		expect(controller.cutSelection()).toBe(0);
		expect(refreshStrip).toHaveBeenCalled();
	});

	it("a selection whose strokes are gone says lasso first and is not a selection", () => {
		// Audit doc §5q/AK2. The ids survive a sidecar reload that took the
		// strokes (deleted on another device); `deleteSelection` resolves them
		// against live strokes and refuses, while the strip's enablement used
		// to ask `selected.length` and light the trash anyway. This is that
		// state: a real lasso, then the document emptied under it.
		select();
		strokes.length = 0;
		expect(controller.hasSelection).toBe(false);
		priv.stripExec("handwriting:delete-selected-ink");
		expect(notices).toEqual(["Handwriting: lasso some ink first"]);
		expect(ops).toEqual([]);
	});
});

/**
 * `deleteSelectionCommand()`, what the strip button, the palette/hotkey
 * command and (since §5s) a Delete/Backspace key WITH A LIVE SELECTION all
 * call. Audit doc §5r: the key used to call `deleteSelection()` directly, a
 * fourth dispatcher beside those three that skipped the id gate and every
 * notice. §5s/AM-B then drew the finer line: an ordinary Backspace with
 * nothing lassoed is not a request to delete ink and must stay silent, so
 * the keydown handler now checks `this.hasSelection` itself (§5u: the
 * bounds-resolved question, not the raw id list, so a selection whose
 * strokes were deleted on another device reads as "nothing lassoed" too)
 * and never calls this method at all in that case - there is nothing to
 * assert for
 * that branch beyond "not called", which these tests do not exercise
 * because they call the method directly. What every OTHER path shares -
 * button, palette, and the key once something is actually lassoed - is this
 * method, unchanged in its own notify contract (audit doc §5s/AM-B: "the
 * strip and palette wrappers keep notifying on every refusal, because
 * pressing those IS the deliberate act") and now returning whether it
 * deleted (§5s/AM-A).
 *
 * The keydown handler itself is a local closure bound in `mount()`, not a
 * class member, and `root` here is a plain object with no real
 * `addEventListener` - so the closure and its `hasSelection` gate cannot
 * be reached from this harness; this is the wrapper it deletes to,
 * §5s/AM-A's part of the fix, driven directly. Uses the applying sink
 * (§5r/AL2), never the collecting one, so a delete that returns/notifies
 * correctly but leaves the store untouched would still fail here.
 */
describe("PdfInkController deleteSelectionCommand (what the strip, palette and a live-selection Delete/Backspace all call)", () => {
	let strokes: InkStroke[];
	let ops: InkOp[];
	let notices: string[];
	let docId: string | null;
	let controller: PdfInkController;
	let pen: { penDown(s: PenSample): void; penRaw(s: PenSample[]): void; penUp(): void };

	beforeEach(() => {
		resetTipModeForTest();
		strokes = [inkAt("s1")];
		ops = [];
		notices = [];
		docId = "doc-1";
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
		};
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => strokes,
			() => docId,
			() => strokes,
			(op) => {
				ops.push(op);
				strokes = applyOp(strokes, op);
			},
			() => {},
			(message) => notices.push(message)
		);
		pen = controller as unknown as typeof pen;
	});

	/** Select s1, through the real lasso path. */
	function select(): void {
		setTipMode("lasso");
		const corners: [number, number][] = [
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		];
		pen.penDown(sample(corners[0]![0], corners[0]![1]));
		for (const [x, y] of corners.slice(1)) pen.penRaw([sample(x, y)]);
		pen.penRaw([sample(corners[0]![0], corners[0]![1])]);
		pen.penUp();
	}

	it("no document id: notifies, removes nothing, and returns false (§5s/AM-A)", () => {
		docId = null;
		expect(controller.deleteSelectionCommand()).toBe(false);
		expect(notices).toEqual(["Handwriting: still identifying this PDF - try again in a moment"]);
		expect(ops).toEqual([]);
		expect(strokes.map((s) => s.id)).toEqual(["s1"]);
	});

	it("identified, empty selection: notifies, removes nothing, and returns false", () => {
		expect(controller.deleteSelectionCommand()).toBe(false);
		expect(notices).toEqual(["Handwriting: lasso some ink first"]);
		expect(ops).toEqual([]);
		expect(strokes.map((s) => s.id)).toEqual(["s1"]);
	});

	it("identified, live selection: removes the strokes from the store and returns true, not merely a true return with nothing removed", () => {
		select();
		expect(controller.deleteSelectionCommand()).toBe(true);
		expect(strokes.map((s) => s.id)).toEqual([]);
		expect(ops).toEqual([
			expect.objectContaining({
				type: "remove",
				path: "doc-1",
				indices: [0],
				strokes: [expect.objectContaining({ id: "s1" })],
			}),
		]);
		expect(notices).toEqual([]);
	});

	it("selected ids resolve to no live stroke (deleted on another device, §5u): hasSelection reads false, the same wrapper removes nothing and returns false", () => {
		select();
		// Another device deleted s1 and the reload poll ran in the idle gap:
		// `this.selected` still holds the id (a lasso capture, never
		// invalidated by an external store change) but it resolves to
		// nothing in the live store. This is the getter the keydown handler
		// now gates on instead of `this.selected.length` (§5u).
		strokes = [];
		expect(controller.hasSelection).toBe(false);
		expect(controller.deleteSelectionCommand()).toBe(false);
		expect(ops).toEqual([]);
		expect(strokes).toEqual([]);
	});
});

/**
 * C13 (1.4.7-design.md §5h): the trash button and the delete ask one question
 * of two different lists, and nothing in this class ties the two together.
 *
 * `hasSelection` goes through `selectionBounds`, which filters `strokes(page)`
 * - the PAGE-filtered source. `deleteSelection` goes through `opList`, which
 * filters `allStrokes()` - the WHOLE-DOCUMENT source. They are two
 * independently injected constructor callbacks. `d7b02e9` made the button ask
 * the bounds rather than the raw id list, so the two now ask the same
 * QUESTION; they still read different LISTS, and they agree in production
 * only because main.ts builds both from one store at one synchronous instant.
 *
 * Latent, not live: ids are unique across pages, so filtering either list by
 * the picked ids lands on the same strokes today. This therefore CANNOT be
 * shown red against the shipped wiring, and was shown red against a divergent
 * one instead - `allStrokes` returning a document list that predates the
 * selected page's ink, which is what a lagging document source or a second
 * page filter looks like. There `hasSelection` stayed true and
 * `deleteSelection` returned false having removed nothing: "trashcan lit up,
 * hit delete, nothing deleted", the report this class's lasso work started
 * from.
 *
 * The harness is the part that can go quietly worthless (P3). `allStrokes`
 * used to default to `() => []` and `opList` used to fall back to the page
 * list when it answered empty, so a controller built without a document
 * source made both questions read ONE list and every assertion below a
 * tautology. Both are gone; the signature now refuses that controller.
 *
 * That does NOT make this block redundant, and the reason is the whole point
 * of it: passing the SAME list to both parameters still type-checks, and it
 * reproduces the identical blindness one argument later. The signature closes
 * the omission, this closes the coincidence. Hence a document across three
 * pages, a selection on page three rather than page one, and the difference
 * between the two lists asserted before the invariant that depends on it.
 */
describe("PdfInkController: the button's list and the delete's list resolve alike (C13)", () => {
	const SELECTION_PAGE = 3;
	let strokes: InkStroke[];
	let ops: InkOp[];
	let controller: PdfInkController;
	let pen: { penDown(s: PenSample): void; penRaw(s: PenSample[]): void; penUp(): void };

	/** `inkAt`'s stroke, moved onto a page and optionally out of the loop. */
	function inkOn(id: string, page: number, dx = 0): InkStroke {
		const base = inkAt(id);
		const points = base.points.map((p) => ({ ...p, x: p.x + dx }));
		return { ...base, points, bbox: computeBBox(points, 4), page };
	}

	/** The page source main.ts installs: this page's ink and nothing else. */
	function onPage(page: number): InkStroke[] {
		return strokes.filter((s) => (s.page ?? 1) === page);
	}

	beforeEach(() => {
		resetTipModeForTest();
		// Interleaved deliberately. The two strokes inside the loop sit at
		// document positions 2 and 4 and at page positions 0 and 1, so an
		// index or a filter taken from the wrong list cannot come out right
		// by coincidence - which is exactly what page one hides.
		strokes = [
			inkOn("p1-a", 1),
			inkOn("p1-b", 1),
			inkOn("p3-in-1", SELECTION_PAGE),
			inkOn("p2-a", 2),
			inkOn("p3-in-2", SELECTION_PAGE),
			inkOn("p3-out", SELECTION_PAGE, 200),
		];
		ops = [];
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
		};
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
				{ pageNumber: 2, leftPx: 0, topPx: 810, widthPx: 600, heightPx: 800, hasCanvas: true },
				{ pageNumber: 3, leftPx: 0, topPx: 1620, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			// The two sources, wired as main.ts wires them and as nothing else
			// in this file's older blocks does: page-filtered here, whole
			// document below. Wiring both from one list is the P3 hole.
			(page) => onPage(page),
			() => "doc-1",
			() => strokes,
			(op) => {
				ops.push(op);
				strokes = applyOp(strokes, op);
			}
		);
		pen = controller as unknown as typeof pen;
	});

	/** Trace a closed loop over page three's ink, through the real pen path. */
	function lassoPageThree(): void {
		setTipMode("lasso");
		// Page three's box starts at 1620 content px, so these are the same
		// page-local corners the page-one lasso above traces.
		const corners: [number, number][] = [
			[150, 1770],
			[250, 1770],
			[250, 1870],
			[150, 1870],
		];
		pen.penDown(sample(corners[0]![0], corners[0]![1]));
		for (const [x, y] of corners.slice(1)) pen.penRaw([sample(x, y)]);
		pen.penRaw([sample(corners[0]![0], corners[0]![1])]);
		pen.penUp();
	}

	it("a selection on page three: the delete takes exactly the strokes the button lit for", () => {
		lassoPageThree();
		// Captured before the delete, which replaces the array.
		const documentList = strokes;
		const pageList = onPage(SELECTION_PAGE);

		// Anti-vacuity, first because everything after it depends on it: the
		// two sources must genuinely differ, or both questions read one list
		// and the invariant is asserted about nothing.
		expect(documentList.length).toBeGreaterThan(pageList.length);
		expect(pageList.map((s) => s.id)).toEqual(["p3-in-1", "p3-in-2", "p3-out"]);

		// The ids the lasso actually picked, rather than a list written out by
		// hand - the shared input both sides filter by.
		const picked = new Set((controller as unknown as { selected: string[] }).selected);
		expect([...picked]).toEqual(["p3-in-1", "p3-in-2"]);
		const viaPageSource = pageList.filter((s) => picked.has(s.id));
		const viaDocumentSource = documentList.filter((s) => picked.has(s.id));

		// The button is lit, off the page source.
		expect(controller.hasSelection).toBe(true);

		// And the delete, off the document source, removes exactly those - one
		// question, one answer, whichever list it was asked of.
		const documentIndices = viaPageSource.map((s) => documentList.indexOf(s));
		expect(documentIndices).toEqual([2, 4]);
		expect(viaPageSource.map((s) => pageList.indexOf(s))).toEqual([0, 1]);
		expect(controller.deleteSelection()).toBe(true);
		expect(ops).toEqual([
			{ type: "remove", path: "doc-1", strokes: viaPageSource, indices: documentIndices },
		]);
		// The op is half of it; the store is the other half. A delete that
		// returns true and leaves the ink where it was is the original report.
		expect(strokes.map((s) => s.id)).toEqual(["p1-a", "p1-b", "p2-a", "p3-out"]);

		// The invariant itself, stated against the two callbacks rather than
		// against the controller's behaviour: whatever the lasso picked, the
		// page list and the document list resolve it to the same strokes.
		expect(viaDocumentSource).toEqual(viaPageSource);
	});
});

/**
 * Calibration mode: a synthetic stroke source, and the ops it must not emit.
 *
 * Design §5o/C22. With `pdfCalibration` on, main.ts deliberately makes the two
 * sources disagree: the PAGE source hands back `calibrationStrokes(page)` and
 * the DOCUMENT source hands back an empty list. The controller had no idea, so
 * every mutating gesture hit-tested the synthetic crosses like real ink and
 * emitted a real op against the user's sidecar - and `applyOp`'s `replace`
 * removes by id (a no-op, those ids are not in the document) while splicing the
 * eraser's split fragments in at `insertedAt`. Synthetic geometry, in a real
 * file, in the one class §4 calls unrecoverable.
 *
 * The wiring below is main.ts's calibration wiring, not an approximation of it:
 * page source `calibrationStrokes`, document source `[]`, and a sink that runs
 * the real `applyOp` against a real document list - so what these tests read at
 * the end is what would have been written.
 */
describe("PdfInkController with a synthetic stroke source", () => {
	/** The user's actual ink. Nothing in this block may ever change it. */
	let real: InkStroke[];
	let ops: InkOp[];
	let persists: string[];
	let controller: PdfInkController;
	let pen: { penDown(s: PenSample, ev?: unknown): void; penRaw(s: PenSample[]): void; penUp(): void };

	/** Page point (100,100) is a calibration mark, and content px (200,200). */
	const MARK_X = 100;
	const MARK_Y = 100;

	beforeEach(() => {
		resetTipModeForTest();
		real = [inkAt("real-1")];
		ops = [];
		persists = [];
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
		};
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			// main.ts: `if (this.pdfCalibration) return calibrationStrokes(page)`.
			(page) => calibrationStrokes(page),
			() => "doc-1",
			// main.ts: `if (this.pdfCalibration) return []`.
			() => [],
			(op) => {
				ops.push(op);
				real = applyOp(real, op);
			},
			() => {},
			() => {},
			(id) => persists.push(id),
			// The flag main.ts already holds. Without it the controller cannot
			// know its sources are made up.
			() => true
		);
		pen = controller as unknown as typeof pen;
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
	});

	/**
	 * Anti-vacuity, and the point of the whole block: the nib really is on a
	 * calibration cross. Asserted against the same hit test `eraseAt` runs,
	 * over the same generated strokes, so a fix that stopped the gesture
	 * reaching the ink at all could not make these tests pass by accident.
	 */
	it("the nib is genuinely on synthetic ink - precondition", () => {
		const page = calibrationStrokes(1);
		expect(page.length).toBeGreaterThan(0);
		const hit = strokesHitByCircle(page, MARK_X, MARK_Y, getEraserRadiusPx() / SCALE);
		expect(hit.length).toBeGreaterThan(0);
		for (const id of hit) expect(id.startsWith("cal-")).toBe(true);
	});

	// Restored because it is module state: leaving it off would change what
	// every later eraser test in this file is measuring.
	afterEach(() => setEraserWholeStrokes(true));

	it("erasing a calibration cross writes nothing to the document", () => {
		// Split erase, not whole-stroke: this is the setting under which the
		// defect actually SPLICES geometry in. Whole-stroke erase emits an op
		// with an empty `inserted`, which is a no-op against the real list and
		// would let a broken guard look fine.
		setEraserWholeStrokes(false);
		setTipMode("eraser");
		pen.penDown(sample(MARK_X * SCALE, MARK_Y * SCALE));
		pen.penRaw([sample(MARK_X * SCALE + 2, MARK_Y * SCALE)]);
		pen.penUp();
		// The user's ink first, because it is the thing that cannot be
		// recovered: before the guard this list came back holding the split
		// halves of a synthetic cross.
		expect(real.map((s) => s.id)).toEqual(["real-1"]);
		// No op at all - not an op that happens to be harmless. `replace`
		// splices `inserted` in whether or not `removed` matched anything.
		expect(ops).toEqual([]);
		// And no write, so the sidecar is not even rewritten.
		expect(persists).toEqual([]);
	});

	it("lasso-deleting a calibration cross writes nothing, and leaves no undo to write later", () => {
		setTipMode("lasso");
		pen.penDown(sample(150, 150));
		const corners: [number, number][] = [
			[250, 150],
			[250, 250],
			[150, 250],
			[150, 150],
		];
		for (const [x, y] of corners) pen.penRaw([sample(x, y)]);
		pen.penUp();
		// The lasso still SELECTS - calibration ink is drawn, so it is
		// selectable; what it may not do is produce an op. And the boolean has
		// to say so: `deleteSelectionCommand` picks its sentence off it.
		expect(controller.hasSelection).toBe(true);
		expect(controller.deleteSelection()).toBe(false);
		expect(ops).toEqual([]);
		// Cut is a copy and a delete, and the clipboard is the slower door:
		// synthetic ink parked there outlives calibration mode and comes back
		// as an `add` into a real document.
		clearInkClipboard();
		expect(controller.cutSelection()).toBe(0);
		expect(clipboardSize()).toBe(0);
		// The delayed leg: a recorded `remove` inverts to an `add`, so an undo
		// pressed later would splice the crosses into the real document even
		// though the delete itself removed nothing.
		expect((controller as unknown as { historyStep(r: boolean): boolean }).historyStep(false)).toBe(
			false
		);
		expect(ops).toEqual([]);
		expect(real.map((s) => s.id)).toEqual(["real-1"]);
	});

	it("insert-space over calibration ink writes nothing", () => {
		setTipMode("space");
		pen.penDown(sample(MARK_X * SCALE, 60 * SCALE));
		pen.penRaw([sample(MARK_X * SCALE, 90 * SCALE), sample(MARK_X * SCALE, 120 * SCALE)]);
		pen.penUp();
		expect(ops).toEqual([]);
		expect(persists).toEqual([]);
		expect(real.map((s) => s.id)).toEqual(["real-1"]);
	});
});

/**
 * The pane's keydown handler, driven directly.
 *
 * `handleKeyDown` became a class field (rather than the local closure `mount`
 * used to build) so it could be called here without a root that implements
 * `addEventListener` for real - the same way `stripExec` is already driven in
 * the strip-dispatch block above. That refactor is the reason this block
 * exists: the two rules ported onto this surface from the note
 * (InkOverlay.handleKeyDown - Escape hands the tip back, Ctrl/Cmd+C and +X
 * act on a lasso) arrived with only registry MARKERS pinning them, and a
 * marker proves the source text contains a condition, not that pressing the
 * key does anything. It also moved the undo branch below a new early return,
 * which is the kind of reordering that silently eats a hotkey.
 */
describe("PdfInkController keyboard: Escape hands the tip back, Ctrl/Cmd+C and +X act on a lasso", () => {
	let strokes: InkStroke[];
	let ops: InkOp[];
	let notices: string[];
	let execs: string[];
	let controller: PdfInkController;
	let pen: { penDown(s: PenSample): void; penRaw(s: PenSample[]): void; penUp(): void };
	let keys: { handleKeyDown(ev: KeyboardEvent): void };
	/**
	 * What `win.getSelection()` answers. Null is "no text selected anywhere",
	 * the state every test but the guard cases wants; `textSelectionLive`
	 * reads it through `this.win`, never the bare global, so a stub is enough.
	 */
	let textSel: { isCollapsed: boolean; anchorNode: unknown } | null;
	/** A node the pane's root contains, and one it does not. */
	const inPane = {};
	const otherPane = {};

	beforeEach(() => {
		resetTipModeForTest();
		clearInkClipboard();
		strokes = [inkAt("s1")];
		ops = [];
		notices = [];
		execs = [];
		textSel = null;
		setMouseInk(false);
		clearToolPicked();
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
		};
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		// A root that can answer `contains`, which the other blocks' `{}` cannot:
		// the Ctrl+C guard is scoped to THIS pane's text selection, and a root
		// that contained everything (or threw) would not show the difference.
		const root = { contains: (n: unknown) => n === inPane } as unknown as HTMLElement;
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
			getSelection: () => textSel,
		};
		controller = new PdfInkController(
			root,
			win as unknown as Window,
			() => strokes,
			() => "doc-1",
			() => strokes,
			(op) => {
				ops.push(op);
				strokes = applyOp(strokes, op);
			},
			(id) => execs.push(id),
			(message) => notices.push(message)
		);
		pen = controller as unknown as typeof pen;
		keys = controller as unknown as typeof keys;
	});

	afterEach(() => {
		clearInkClipboard();
	});

	/** A keydown, and a way to ask afterwards whether it was consumed. */
	function press(
		key: string,
		mods: {
			ctrl?: boolean;
			meta?: boolean;
			alt?: boolean;
			shift?: boolean;
			target?: unknown;
		} = {}
	): boolean {
		let prevented = false;
		const ev = {
			key,
			ctrlKey: mods.ctrl ?? false,
			metaKey: mods.meta ?? false,
			altKey: mods.alt ?? false,
			shiftKey: mods.shift ?? false,
			target: mods.target ?? null,
			preventDefault: () => {
				prevented = true;
			},
			stopPropagation: () => {},
		};
		keys.handleKeyDown(ev as unknown as KeyboardEvent);
		return prevented;
	}

	/** Select s1 through the real lasso path, which also leaves lasso holding the tip. */
	function select(): void {
		setTipMode("lasso");
		const corners: [number, number][] = [
			[150, 150],
			[250, 150],
			[250, 250],
			[150, 250],
		];
		pen.penDown(sample(corners[0]![0], corners[0]![1]));
		for (const [x, y] of corners.slice(1)) pen.penRaw([sample(x, y)]);
		pen.penRaw([sample(corners[0]![0], corners[0]![1])]);
		pen.penUp();
	}

	it("Escape puts the selection away first, and leaves the mode holding the tip", () => {
		select();
		expect(controller.hasSelection).toBe(true);
		expect(press("Escape")).toBe(true);
		expect(controller.hasSelection).toBe(false);
		// Deliberately NOT released: the note surface splits these across two
		// presses for the same reason - someone clearing a stray selection
		// mid-lasso has not asked to put the lasso away too.
		expect(tipMode()).toBe("lasso");
	});

	it("a second Escape, with nothing selected, hands the tip back to the nib", () => {
		select();
		press("Escape");
		expect(press("Escape")).toBe(true);
		expect(tipMode()).toBe("nib");
	});

	it("Escape releases a held mode that never had a selection - the stranding this fixes", () => {
		// The report this rule comes from: landing in pan on a PDF stranded the
		// pen, and the strip is the only way back on this surface - there is no
		// toolbar row above an editor to fall back on.
		setTipMode("pan");
		expect(press("Escape")).toBe(true);
		expect(tipMode()).toBe("nib");
	});

	it("Escape with no selection, held mode or mouse tool is left alone", () => {
		expect(press("Escape")).toBe(false);
		expect(tipMode()).toBe("nib");
	});

	it("Escape inside the viewer's find bar belongs to the find bar", () => {
		setTipMode("pan");
		expect(press("Escape", { target: { tagName: "INPUT" } })).toBe(false);
		// Still panning: the key never reached our branch, which is the point -
		// closing a find bar must not also change what the pen is.
		expect(tipMode()).toBe("pan");
	});

	it("Ctrl+C copies the lassoed ink and consumes the key", () => {
		select();
		expect(press("c", { ctrl: true })).toBe(true);
		expect(clipboardSize()).toBe(1);
		expect(notices).toEqual(["Handwriting: copied 1 stroke(s)"]);
		// Through the controller's own command method, not a fourth dispatcher.
		expect(execs).toEqual([]);
	});

	it("Cmd+X cuts the lassoed ink, and the ink is gone from the store", () => {
		select();
		expect(press("x", { meta: true })).toBe(true);
		expect(clipboardSize()).toBe(1);
		expect(notices).toEqual(["Handwriting: cut 1 stroke(s)"]);
		expect(ops.map((o) => o.type)).toEqual(["remove"]);
		expect(strokes.map((s) => s.id)).toEqual([]);
	});

	it("Ctrl+C with nothing lassoed reaches the viewer, so a PDF's own text still copies", () => {
		expect(press("c", { ctrl: true })).toBe(false);
		expect(clipboardSize()).toBe(0);
		expect(notices).toEqual([]);
	});

	it("Ctrl+C with text selected in this pane is the text's, not the lasso's", () => {
		select();
		textSel = { isCollapsed: false, anchorNode: inPane };
		expect(press("c", { ctrl: true })).toBe(false);
		expect(clipboardSize()).toBe(0);
		expect(notices).toEqual([]);
	});

	it("text selected in ANOTHER pane does not block this pane's lasso copy", () => {
		select();
		textSel = { isCollapsed: false, anchorNode: otherPane };
		expect(press("c", { ctrl: true })).toBe(true);
		expect(clipboardSize()).toBe(1);
	});

	it("a collapsed caret is not a text selection", () => {
		select();
		textSel = { isCollapsed: true, anchorNode: inPane };
		expect(press("c", { ctrl: true })).toBe(true);
		expect(clipboardSize()).toBe(1);
	});

	it("Ctrl+Alt+C is not ours", () => {
		select();
		expect(press("c", { ctrl: true, alt: true })).toBe(false);
		expect(clipboardSize()).toBe(0);
	});

	it("Ctrl+Z still undoes while a selection is live - the new branch must not eat it", () => {
		select();
		controller.deleteSelection();
		expect(ops.map((o) => o.type)).toEqual(["remove"]);
		select();
		expect(press("z", { ctrl: true })).toBe(true);
		expect(ops.map((o) => o.type)).toEqual(["remove", "add"]);
		expect(clipboardSize()).toBe(0);
	});

	it("Delete with a live selection still deletes, and a bare Backspace still says nothing", () => {
		expect(press("Backspace")).toBe(false);
		expect(notices).toEqual([]);
		select();
		expect(press("Delete")).toBe(true);
		expect(ops.map((o) => o.type)).toEqual(["remove"]);
	});
});

/**
 * 1.4.10-pdf-trace: the pdf controller had zero lines in the shared pen
 * trace (InlinePenRouter's `tr()`, read out by "Bug report: show as text"),
 * so a pdf bug report showed only the router's view of the pointer stream.
 * `pdf-pendown` / `pdf-raw` / `pdf-penup` / `pdf-hover` close that gap - see
 * `traceSurface` (InlinePenRouter.ts) and the "pdf trace" section at the top
 * of PdfInkController.ts.
 *
 * Harness matches "stays alive through pan, lasso and space" above: a real
 * gesture through `penDown`/`penRaw`/`penUp`, `cursorEl` primed by one hover
 * first (none of `showEraserCursor`'s family build the reticle themselves).
 */
describe("PdfInkController pdf trace (pdf-pendown / pdf-raw / pdf-penup)", () => {
	let controller: PdfInkController;
	let pen: {
		showCursor(s: PenSample, pointerType?: string): void;
		penDown(s: PenSample, ev?: unknown): void;
		penRaw(s: PenSample[]): void;
		penUp(): void;
	};
	let privTrace: { pdfTrace: { batchIndex: number } };

	beforeEach(() => {
		resetTipModeForTest();
		setPenReticle(true);
		clearInlinePenTrace();
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
			setCssStyles: () => {},
			createDiv: cursorChildren(() => ({
				setAttribute: () => {},
				remove: () => {},
				classList: { add: () => {}, remove: () => {}, toggle: () => {} },
				setCssStyles: () => {},
				parentElement: scroller,
			})),
		};
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 1,
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
			getComputedStyle: () => ({ position: "relative" }),
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => [],
			() => "doc-1",
			() => [],
			() => {}
		);
		pen = controller as unknown as typeof pen;
		privTrace = controller as unknown as typeof privTrace;
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
	});

	afterEach(() => {
		setPenReticle(true);
		setDiagnosticsEnabled(false);
		clearInlinePenTrace();
	});

	/**
	 * RED, before `tracePenDown`/`traceRawBatch`/`tracePenUp` existed: this
	 * exact block asserted against an empty trace and failed -
	 *   expect(pendown.length).toBe(1) => 0 !== 1
	 * - because nothing in PdfInkController.ts ever called `traceSurface`.
	 * Left here as the paper trail the brief asks for; it is GREEN now that
	 * the source carries the calls.
	 */
	it("diagnostics on: an erase gesture emits pdf-pendown, rate-limited pdf-raw, and pdf-penup", () => {
		setDiagnosticsEnabled(true);
		pen.showCursor(sample(10, 10), "pen"); // primes cursorEl, the reuse-only wrappers never build one
		setTipMode("eraser");
		pen.penDown(sample(200, 200));
		// 7 batches: 1-5 auto-emit (rate limit), 6 is skipped, 7 is forced out
		// at pen-up because the limit skipped it - see pdfRawShouldEmitBatch.
		for (let i = 0; i < 7; i++) pen.penRaw([sample(200 + i, 200 + i)]);
		pen.penUp();

		const events = captureInlinePenTrace({}).events;

		const pendown = events.filter((e) => e.type === "pdf-pendown");
		expect(pendown.length).toBe(1);
		expect(pendown[0]!.note).toContain("intent=erase");
		expect(pendown[0]!.note).toContain("erasing=true");
		expect(pendown[0]!.note).toContain("tip=eraser");

		const raw = events.filter((e) => e.type === "pdf-raw");
		expect(raw.length).toBe(6);
		expect(raw.every((e) => e.note.includes("branch=erase"))).toBe(true);
		expect(raw.every((e) => e.note.includes("reticle=wrote transform=translate("))).toBe(true);
		expect(raw.map((e) => e.note.match(/batch=(\d+)/)?.[1])).toEqual(["1", "2", "3", "4", "5", "7"]);
		expect(raw[5]!.note).toContain("forced at pen-up");

		const penup = events.filter((e) => e.type === "pdf-penup");
		expect(penup.length).toBe(1);
		expect(penup[0]!.note).toContain("wasErasing=true");
		expect(penup[0]!.note).toContain("cursorHidden=true");
		expect(penup[0]!.note).toContain("batches=7");
		expect(penup[0]!.note).toContain("reticleSkipped=0/7");
	});

	it("diagnostics off: the same gesture writes no pdf- lines and does not even count batches", () => {
		setDiagnosticsEnabled(false);
		pen.showCursor(sample(10, 10), "pen");
		setTipMode("eraser");
		pen.penDown(sample(200, 200));
		for (let i = 0; i < 7; i++) pen.penRaw([sample(200 + i, 200 + i)]);
		pen.penUp();

		expect(captureInlinePenTrace({}).events.length).toBe(0);
		// The stronger claim, and the one the mutation test below exercises:
		// THE CALL-SITE RULE means the batch counter itself never moves when
		// off, not just that its trace line is swallowed by tr()'s own gate.
		expect(privTrace.pdfTrace.batchIndex).toBe(0);
	});

	it("showCursor early-return reason reaches the report: reticle off -> the erase pdf-raw line says why", () => {
		setDiagnosticsEnabled(true);
		pen.showCursor(sample(10, 10), "pen"); // primes cursorEl while the reticle is still on
		setPenReticle(false);
		setTipMode("eraser");
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(205, 205)]);
		pen.penUp();

		const raw = captureInlinePenTrace({}).events.filter((e) => e.type === "pdf-raw");
		expect(raw.length).toBeGreaterThan(0);
		expect(raw[0]!.note).toContain("branch=erase");
		expect(raw[0]!.note).toContain("reticle=skipped reason=off");
	});
});

/**
 * 1.4.10, the three mouse-reticle defects (alan, hardware, mouse ink armed).
 *
 * The reticle's watchdog exists for a PEN that leaves hover range without
 * ever sending pointerleave - digitizers differ, and a dot left painted on
 * the page is worse than no dot. A MOUSE cannot do that: it is either over
 * the pane or it has sent pointerleave. `showCursor` has said so since it
 * was written, and exempts `pointerType === "mouse"` from arming the timer.
 *
 * The exemption only ever reached the HOVER call. The in-stroke wrappers -
 * `showEraserCursor`, `showLassoCursor`, `showSpaceCursor` - call
 * `showCursor(sample)` with NO pointerType at all (deliberately: the
 * hardware and pen-seen marks belong to the hover and the pen-down that
 * already happened, not to every sample of a stroke in flight). So a mouse
 * erasing, lassoing or panning a PDF inherited the pen's 1000ms timer, and
 * any stall over a second in raw delivery while the button was held took the
 * ring away in the middle of the gesture.
 *
 * There were FOUR wrappers when this was written, and `showPanCursor` was the
 * fourth. 1.4.12 removed it: a pan drag paints no reticle at all, so it has
 * no watchdog to be exempt from either (`penReticleShown`, PenCursor.ts, and
 * the pan cases in the reticle suite above). The pan is still named in the
 * sentence above because the defect really did reach it.
 *
 * These drive the real gesture through `penDown`/`penRaw` and let the clock
 * actually run: `win.setTimeout` here is the (fake-timed) global one rather
 * than the counting spy the older reticle suites use, so what is asserted is
 * the ring on screen after 1500ms, not how many timers were armed.
 */
describe("PdfInkController reticle - a mouse mid-gesture is exempt from the pen's hide watchdog", () => {
	let controller: PdfInkController;
	let priv: {
		showCursor(s: PenSample, pointerType?: string): void;
		hideCursor(): void;
		penDown(s: PenSample, ev?: unknown): void;
		penRaw(s: PenSample[], ev?: unknown): void;
		penUp(ev?: unknown): void;
	};
	let cursorStyle: Record<string, unknown>;
	let cursorClasses: Set<string>;
	let scrollerClasses: Set<string>;
	let scroller: Record<string, unknown>;

	/** The event a claimed contact carries; `buttons`/`button` feed penContactIntent. */
	function down(pointerType: string) {
		return { pointerType, buttons: 1, button: 0 };
	}

	beforeEach(() => {
		vi.useFakeTimers();
		resetTipModeForTest();
		setPenReticle(true);
		cursorStyle = { display: "none" };
		cursorClasses = new Set<string>();
		scrollerClasses = new Set<string>();
		scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: {
				add: (c: string) => void scrollerClasses.add(c),
				remove: (c: string) => void scrollerClasses.delete(c),
			},
			querySelector: () => null,
			setCssStyles: () => {},
			createDiv: cursorChildren(() => ({
				setAttribute: () => {},
				remove: () => {},
				classList: {
					add: (...cls: string[]) => cls.forEach((c) => cursorClasses.add(c)),
					remove: (...cls: string[]) => cls.forEach((c) => cursorClasses.delete(c)),
					toggle: (cls: string, on?: boolean) => {
						const next = on ?? !cursorClasses.has(cls);
						if (next) cursorClasses.add(cls);
						else cursorClasses.delete(cls);
					},
				},
				setCssStyles: (styles: Record<string, unknown>) => {
					Object.assign(cursorStyle, styles);
				},
				parentElement: scroller,
			})),
		};
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = {
			devicePixelRatio: 1,
			// The REAL clock (faked by vitest), not a counting spy: these
			// tests need the watchdog to fire or not fire, not to be tallied.
			setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
			clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
			getComputedStyle: () => ({ position: "relative" }),
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => [],
			() => "doc-1",
			() => [],
			() => {}
		);
		priv = controller as unknown as typeof priv;
		(controller as unknown as { boundScroller: unknown }).boundScroller = scroller;
	});

	afterEach(() => {
		vi.useRealTimers();
		setPenReticle(true);
	});

	it("a mouse erase drag arms no hide watchdog: a 1500ms stall leaves the ring up", () => {
		setTipMode("eraser");
		// An armed mouse hovers first, which is what BUILDS the reticle - the
		// in-stroke wrappers only ever refresh one that already exists.
		priv.showCursor(sample(10, 10), "mouse");
		expect(cursorStyle.display).toBe("block");
		priv.penDown(sample(200, 200), down("mouse"));
		priv.penRaw([sample(210, 210)]);
		expect(cursorStyle.display).toBe("block");
		// The button is still held; the samples just stopped arriving.
		vi.advanceTimersByTime(1500);
		expect(
			cursorStyle.display,
			"the pen's 1000ms hide watchdog took the mouse's eraser ring away mid-drag"
		).toBe("block");
	});

	it("the mouse's locator ring survives its own erase drag", () => {
		setTipMode("eraser");
		priv.showCursor(sample(10, 10), "mouse");
		expect(cursorClasses.has("handwriting-pdf-cursor-mouse")).toBe(true);
		priv.penDown(sample(200, 200), down("mouse"));
		priv.penRaw([sample(210, 210)]);
		expect(
			cursorClasses.has("handwriting-pdf-cursor-mouse"),
			"the in-stroke refresh stripped the locator ring a mouse steers by"
		).toBe(true);
	});

	it("a pen erase drag still arms it: 1500ms with no samples hides the ring", () => {
		setTipMode("eraser");
		priv.showCursor(sample(10, 10), "pen");
		priv.penDown(sample(200, 200), down("pen"));
		priv.penRaw([sample(210, 210)]);
		expect(cursorStyle.display).toBe("block");
		vi.advanceTimersByTime(1500);
		expect(cursorStyle.display, "the pen lost its stranded-reticle watchdog").toBe("none");
	});

	it("a pen hover after a mouse stroke still arms the watchdog", () => {
		// `mouseStroke` is written at pen-down and NOT cleared at pen-up (only
		// unmount and a document change reset it), so it is still true here.
		// Keying the exemption on that field alone would hand the next PEN
		// hover a mouse's exemption and quietly delete the pen's only
		// protection against a reticle stranded by a missing pointerleave.
		setTipMode("nib");
		priv.showCursor(sample(10, 10), "mouse");
		priv.penDown(sample(200, 200), down("mouse"));
		priv.penRaw([sample(210, 210)]);
		priv.penUp();
		priv.showCursor(sample(20, 20), "pen");
		expect(cursorStyle.display).toBe("block");
		vi.advanceTimersByTime(1500);
		expect(cursorStyle.display, "a stale mouseStroke disarmed the pen's watchdog").toBe("none");
	});

	it("hideCursor takes the hover class off the bound scroller even when the probe is gone", () => {
		priv.showCursor(sample(10, 10), "mouse");
		expect(scrollerClasses.has("handwriting-pdf-hover")).toBe(true);
		// The viewer was rebuilt under us: the probe answers null now. The
		// class is still on the scroller it was ADDED to, and `cursor: none`
		// (styles.css) rides on it across the whole viewer.
		probe.current = null;
		(controller as unknown as { invalidateProbe(): void }).invalidateProbe();
		priv.hideCursor();
		expect(
			scrollerClasses.has("handwriting-pdf-hover"),
			"cursor:none was stranded on the scroller the class was added to"
		).toBe(false);
	});
});

/**
 * Defect 2: an armed mouse that hovers a PDF and then leaves the pane.
 *
 * `InlinePenRouter`'s pointerleave handler is pen-only in its entirety, so
 * nothing told the surface the pointer had gone - and the mouse is precisely
 * the pointer with no watchdog to fall back on (see the suite above). The
 * reticle stayed painted with `display: block` and, worse, the scroller kept
 * `handwriting-pdf-hover`, whose rule is `cursor: none` on the container AND
 * every descendant (styles.css): the mouse pointer itself was invisible over
 * the whole viewer until something else happened to call `hideCursor`.
 *
 * This drives the REAL router built by the controller's own `bindTo` - not a
 * hand-made callbacks object - over the thin element fake
 * `test/routerHarness` was extracted for exactly this kind of test, so what
 * is proven is the whole path: a pointerleave on the scroller reaching this
 * surface's `hideCursor`.
 */
describe("PdfInkController reticle - an armed mouse leaving the pane puts the reticle away", () => {
	let uninstallWindow: () => void = () => {};
	beforeAll(() => {
		uninstallWindow = installFakeWindow();
	});
	afterAll(() => {
		uninstallWindow();
	});

	let controller: PdfInkController;
	let priv: { showCursor(s: PenSample, pointerType?: string): void };
	let cursorStyle: Record<string, unknown>;
	let scroller: ReturnType<typeof fakeEl>;

	/** A pointerleave with a real `relatedTarget: null` - left to nothing. */
	function leaveEvent(pointerType: string): PointerEvent {
		return {
			type: "pointerleave",
			pointerType,
			pointerId: 9,
			isPrimary: true,
			clientX: 10,
			clientY: 10,
			pressure: 0,
			buttons: 0,
			button: -1,
			timeStamp: 0,
			tiltX: 0,
			tiltY: 0,
			width: 0,
			height: 0,
			relatedTarget: null,
			preventDefault: () => {},
			stopPropagation: () => {},
		} as unknown as PointerEvent;
	}

	function fire(ev: PointerEvent): void {
		const h = scroller.handlers.get(ev.type);
		if (!h) throw new Error(`the router registered no handler for ${ev.type}`);
		h(ev as unknown as Event);
	}

	beforeEach(() => {
		resetTipModeForTest();
		setPenReticle(true);
		setMouseInk(false);
		cursorStyle = { display: "none" };
		const el = fakeEl() as ReturnType<typeof fakeEl> & Record<string, unknown>;
		el.querySelector = () => null;
		el.createDiv = cursorChildren(() => ({
			setAttribute: () => {},
			remove: () => {},
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			setCssStyles: (styles: Record<string, unknown>) => {
				Object.assign(cursorStyle, styles);
			},
			parentElement: el,
		}));
		scroller = el;
		probe.current = {
			scroller: el,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = {
			devicePixelRatio: 1,
			// Desktop, non-Apple: the palm shield and the pinch bridge both
			// attach, and both take only touch events, so neither can shadow
			// the router's pointer handlers on this one-handler-per-type fake.
			navigator: { userAgent: "", platform: "", maxTouchPoints: 0 },
			setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
			clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
			getComputedStyle: () => ({ position: "relative" }),
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => [],
			() => "doc-1",
			() => [],
			() => {}
		);
		priv = controller as unknown as typeof priv;
		(controller as unknown as { bindTo(el: unknown): void }).bindTo(el);
	});

	afterEach(() => {
		(controller as unknown as { router: { dispose(): void } | null }).router?.dispose();
		setMouseInk(false);
		setPenReticle(true);
	});

	it("mouse ink ON: the reticle is hidden and the hover class comes off", () => {
		setMouseInk(true);
		priv.showCursor(sample(10, 10), "mouse");
		expect(cursorStyle.display).toBe("block");
		expect(scroller.classList.contains("handwriting-pdf-hover")).toBe(true);
		fire(leaveEvent("mouse"));
		expect(cursorStyle.display, "the reticle was stranded on screen").toBe("none");
		expect(
			scroller.classList.contains("handwriting-pdf-hover"),
			"cursor:none was left on the whole viewer after the mouse left"
		).toBe(false);
	});

	it("mouse ink OFF: a mouse leave still changes nothing", () => {
		priv.showCursor(sample(10, 10), "mouse");
		expect(cursorStyle.display).toBe("block");
		fire(leaveEvent("mouse"));
		expect(cursorStyle.display).toBe("block");
		expect(scroller.classList.contains("handwriting-pdf-hover")).toBe(true);
	});

	it("a pen leave is unchanged", () => {
		priv.showCursor(sample(10, 10), "pen");
		expect(cursorStyle.display).toBe("block");
		fire(leaveEvent("pen"));
		expect(cursorStyle.display).toBe("none");
		expect(scroller.classList.contains("handwriting-pdf-hover")).toBe(false);
	});

	/**
	 * The third way, which neither of the two above covers: mouse ink is
	 * switched OFF while the pointer is still over the viewer.
	 *
	 * No pointerleave is coming - the mouse has not moved - and the mouse is
	 * exempt from the hide watchdog by design (the suite above this one), so
	 * before `hidePenCursorsEverywhere` the ring stayed painted and
	 * `handwriting-pdf-hover`'s `cursor: none` stayed on the whole viewer with
	 * nothing left to justify either.
	 *
	 * Driven through a REAL off edge, `releaseMouseInkQuietlyEverywhere` (the
	 * strip's quiet put-down), with this controller's `hideCursor` registered
	 * the way main.ts registers every open pane's - `addStripSurface`'s fourth
	 * callback. `QuietMouseInkFanout.test.ts`'s idiom, and the same reason:
	 * asserting the REGISTERED callback ran is what fails if the fan-out is
	 * deleted, where "some hide happened" would not.
	 */
	it("mouse ink turned OFF under a still pointer puts the reticle away", () => {
		setMouseInk(true);
		priv.showCursor(sample(10, 10), "mouse");
		expect(cursorStyle.display).toBe("block");
		expect(scroller.classList.contains("handwriting-pdf-hover")).toBe(true);

		const undo = addStripSurface(
			() => {},
			undefined,
			undefined,
			() => controller.hideCursor()
		);
		try {
			releaseMouseInkQuietlyEverywhere();
		} finally {
			undo();
		}

		expect(cursorStyle.display, "the reticle outlived the mode that raised it").toBe("none");
		expect(
			scroller.classList.contains("handwriting-pdf-hover"),
			"cursor:none was left on the whole viewer after mouse ink went off"
		).toBe(false);
	});
});

/**
 * `onStrokeAbandoned`, executed rather than grepped for (D2, 1.4.10 audit).
 *
 * The callback body on BOTH surfaces was reachable by no test in the tree.
 * `AbandonStrokeOnSwitch.test.ts` proves the ROUTER fires it against a
 * counter, `PdfAbandonStrokeOnSwitch.test.ts` proves the SWITCH path's
 * `stripPenUp`, and `InkSurfaceRules.test.ts` scans this file's raw text for
 * `onStrokeAbandoned:` - which a comment satisfies. Replacing the body with
 * `() => {}` left every one of them green, and that body is the whole payload:
 * the stale `is-inking` strip (opacity 0 AND visibility hidden, so
 * unhit-testable) Alan reported as "same thing on a pdf".
 *
 * So this drives the REAL router the controller builds in `bindTo`, over the
 * same element fake as the pointerleave suite above. `InlinePenRouter` takes
 * no window parameter - it registers blur on the global `window` through its
 * `winRef` getter - so `winHandlers` from `test/routerHarness` is where that
 * handler lands, and firing it is a real alt-tab.
 *
 * The strip is supplied AFTER the pen-down on purpose. This controller is
 * never mounted here, so `ensureTools()` builds nothing and the contact's own
 * `stripPenDown` is a no-op on a null strip; handing the stub over afterwards
 * makes `inking` say exactly what the blur did and nothing else. The wet/head
 * pair is handed over the same way and for the same reason - `pageElement`
 * answers null against this element fake, so pen-down attaches nothing.
 *
 * THE FILE SWITCH IS THE SAME EVENT and is driven here too. `forgetHistory()`
 * (main.ts, the in-place document change) tears a stranded contact down with
 * no pointerup exactly as a blur does, on a router the pane REUSES, and the
 * two paths had each grown their own half of the answer: the switch never put
 * the reticle away, and neither of them cleared the wet layer. Both now run
 * one method, and both are asserted against it below.
 */
describe("PdfInkController: a stroke torn down with no pointerup stands the surface down", () => {
	let uninstallWindow: () => void = () => {};
	beforeAll(() => {
		uninstallWindow = installFakeWindow();
	});
	afterAll(() => {
		uninstallWindow();
	});

	interface ToolsStub {
		inking: boolean[];
		refreshes: number;
		setInking(on: boolean): void;
		refresh(): void;
		closeInkSliders(): void;
	}
	function toolsStub(): ToolsStub {
		const stub: ToolsStub = {
			inking: [],
			refreshes: 0,
			setInking: (on: boolean) => void stub.inking.push(on),
			refresh: () => void stub.refreshes++,
			closeInkSliders: () => {},
		};
		return stub;
	}

	/**
	 * The one wet/head pair this surface shares across pages, stubbed to say
	 * what was cleared and at what size. The renderers are the real thing in
	 * production; here only the calls a teardown can make on them matter, and
	 * `frameBox` measures the page off the probe above - 600x800.
	 */
	function wetStub() {
		const wetCleared: number[][] = [];
		const tailCleared: number[][] = [];
		const dressed: string[] = [];
		// WHICH method, not just the size. `wetCleared` above cannot tell the
		// whole-canvas `clear` from the stroke-box `clearStroke` - both push
		// the same pair of numbers - and which of the two a pen-up takes IS
		// the behaviour the box-clear change is. See the Boox-off test below.
		const wetCalls: string[] = [];
		const tailCalls: string[] = [];
		const pair = {
			wetCanvas: {
				setCssProps: (css: Record<string, string>) => void dressed.push(css.opacity ?? ""),
			},
			headCanvas: { setCssProps: () => {} },
			wet: {
				clear: (w: number, h: number) => {
					wetCalls.push("clear");
					wetCleared.push([w, h]);
				},
				clearStroke: (w: number, h: number) => {
					wetCalls.push("clearStroke");
					wetCleared.push([w, h]);
				},
			},
			tail: {
				// The size is optional on the real method and the pen-up sites
				// pass it - it is what selects the no-box fallback - so it is
				// recorded here the same way `clearAll`'s is.
				clear: (w?: number, h?: number) => {
					tailCalls.push("clear");
					tailCleared.push(w === undefined || h === undefined ? [] : [w, h]);
				},
				clearAll: (w: number, h: number) => {
					tailCalls.push("clearAll");
					tailCleared.push([w, h]);
				},
			},
		};
		return { pair, wetCleared, tailCleared, wetCalls, tailCalls, dressed };
	}

	let controller: PdfInkController;
	let priv: {
		tools: unknown;
		erasing: boolean;
		pair: unknown;
		wetHostPage: number;
		strokePageNumber: number;
		wetHighlighter: boolean;
		showCursor(s: PenSample, pointerType?: string): void;
	};
	/** What the teardown committed. An abandoned stroke commits nothing. */
	let ops: InkOp[];
	let scroller: ReturnType<typeof fakeEl>;
	let cursorStyle: Record<string, unknown>;

	/** The window blur the router registered, i.e. alt-tab with the pen down. */
	function blur(): void {
		const h = winHandlers.get("blur");
		if (!h) throw new Error("the router registered no window blur handler");
		h({ type: "blur" } as unknown as Event);
	}

	beforeEach(() => {
		resetTipModeForTest();
		setPenReticle(true);
		setMouseInk(false);
		cursorStyle = { display: "none" };
		const el = fakeEl() as ReturnType<typeof fakeEl> & Record<string, unknown>;
		el.querySelector = () => null;
		el.createDiv = cursorChildren(() => ({
			setAttribute: () => {},
			remove: () => {},
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			setCssStyles: (styles: Record<string, unknown>) => {
				Object.assign(cursorStyle, styles);
			},
			parentElement: el,
		}));
		scroller = el;
		probe.current = {
			scroller: el,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = {
			devicePixelRatio: 1,
			navigator: { userAgent: "", platform: "", maxTouchPoints: 0 },
			setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
			clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
			getComputedStyle: () => ({ position: "relative" }),
		};
		ops = [];
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => [],
			() => "doc-1",
			() => [],
			(op) => void ops.push(op)
		);
		priv = controller as unknown as typeof priv;
		(controller as unknown as { bindTo(el: unknown): void }).bindTo(el);
	});

	afterEach(() => {
		(controller as unknown as { router: { dispose(): void } | null }).router?.dispose();
		resetTipModeForTest();
		setPenReticle(true);
	});

	/**
	 * A real eraser contact: tip mode decides, so this is `penContactIntent`'s
	 * own path, and `erasing` is set by the controller rather than by the test.
	 *
	 * `pointerType` is a parameter because the reticle's fate at contact
	 * differs by device and only one of the two can witness the hide: a PEN
	 * contact hides the ring itself ("the hand is at the nib and a dot under
	 * it reads as a smudge", penDown), so there is nothing left for the blur
	 * to take away, while under a MOUSE the dot IS the nib and stays on
	 * through the gesture. The mouse is also the pointer with no watchdog
	 * behind it any more (a7eba85), so the blur is the only thing that can
	 * put its ring away.
	 */
	function eraseContact(pointerType = "pen"): void {
		setTipMode("eraser");
		if (pointerType === "mouse") setMouseInk(true);
		const h = scroller.handlers.get("pointerdown");
		if (!h) throw new Error("the router registered no pointerdown handler");
		h(penEvent("pointerdown", 100, { pointerType }) as unknown as Event);
	}

	/**
	 * A real INK contact - the nib, so `penDown` builds a stroke and the wet
	 * layer is what the gesture is painting on. The erase contact above
	 * cannot stand in for it: an erase draws no wet trail, and the trail is
	 * the thing an abandon has to take off the page.
	 */
	function inkContact(pointerType = "pen"): void {
		setTipMode("nib");
		if (pointerType === "mouse") setMouseInk(true);
		const h = scroller.handlers.get("pointerdown");
		if (!h) throw new Error("the router registered no pointerdown handler");
		h(penEvent("pointerdown", 100, { pointerType }) as unknown as Event);
	}

	it("a blur mid-erase puts the strip chrome back down", async () => {
		// Since the 2026-09-04 ruling this is the COMMIT path, not the abandon
		// path: the router's `finishActiveStroke()` reaches `penUp()`, and it
		// is `penUp` that runs `stripPenUp` here. What is pinned is unchanged -
		// an alt-tab must not leave the strip and pill wearing `is-inking`
		// (opacity 0 AND visibility hidden, so unhit-testable) - but the route
		// to it is, so the name says blur rather than abandon. An erase commits
		// nothing to the page, which is why this contact can assert the chrome
		// on its own; the ink half is the `COMMITS the stroke` test below.
		eraseContact();
		const tools = toolsStub();
		priv.tools = tools;

		blur();
		await new Promise<void>((r) => queueMicrotask(() => r()));

		expect(tools.inking, "the blur left `is-inking` on the strip").toEqual([false]);
		expect(tools.refreshes).toBe(1);
	});

	it("and a blur stands the gesture down, so the pane can still be reloaded", () => {
		// `idle` is what main.ts asks before swapping another device's ink in
		// (main.ts, the reload poll and the same-document refresh). A blur
		// mid-erase used to leave `erasing` true forever: before `dcf0254`
		// nothing at all ran when the window went away, so `resetGestureState`
		// was never reached, and a pane that is never idle again silently
		// stops receiving ink for the life of the view with nothing on screen
		// to say so. `resetGestureState`'s own header names this hazard. The
		// blur reaches it through `penUp` now rather than through
		// `strokeAbandoned`, and the guarantee is the same either way, which
		// is the whole reason to keep asserting it on this path.
		eraseContact();
		priv.tools = toolsStub();
		expect(priv.erasing, "the eraser contact never took").toBe(true);
		expect(controller.idle).toBe(false);

		blur();

		expect(priv.erasing).toBe(false);
		expect(controller.idle, "the pane can never be reloaded again").toBe(true);
	});

	it("and takes the reticle with it", () => {
		// Nothing else will: hover has gone quiet under a claimed contact, and
		// for a mouse the watchdog that used to catch this is deliberately
		// never armed (a7eba85), so the ring would sit on the pane - with
		// `handwriting-pdf-hover`'s `cursor: none` over the whole viewer -
		// until something else happened to call hideCursor.
		// One hover first, the limit `showEraserCursor` states out loud: it
		// reuses the reticle and never builds one mid-stroke, so a gesture
		// that never hovered has no ring to keep or to take away.
		setMouseInk(true);
		priv.showCursor(sample(10, 10), "mouse");
		eraseContact("mouse");
		priv.tools = toolsStub();
		expect(cursorStyle.display).toBe("block");

		blur();

		expect(cursorStyle.display).toBe("none");
		expect(scroller.classList.contains("handwriting-pdf-hover")).toBe(false);
	});

	it("and COMMITS the stroke drawn so far, handing the wet trail off", () => {
		// Owner's ruling, 2026-09-04: "alt tab mid stroke - sure make it
		// consistent". This test asserted the opposite until then - that a
		// blur DROPPED the partial stroke and simply wiped its wet trail - and
		// on hardware that reads as "alt tabbing out mid stroke causes stroke
		// to disappear as it never landed". `docs/manual.md` already promises
		// the other answer for the other mid-stroke teardown, the pdf viewer
		// rebuilding under the pen: the stroke commits what was drawn instead
		// of vanishing, and only the gesture ends. The blur now reaches
		// `penUp()` through the router's `finishActiveStroke()`, so this is
		// the ordinary wet-to-committed handoff: one `add` op, and the wet
		// layer cleared at the page's size because the committed layer has
		// taken the ink over - not because it was thrown away.
		inkContact();
		priv.tools = toolsStub();
		const wet = wetStub();
		priv.pair = wet.pair;
		priv.wetHostPage = 1;
		// A highlighter dresses this shared canvas with its wash at pen-down
		// and `undressWet` takes it off at pen-up; a stroke dropped mid-wash
		// left every later gesture - the lasso loop included - drawn at a
		// third of its brightness.
		priv.wetHighlighter = true;
		expect(priv.strokePageNumber, "the ink contact never took").toBe(1);

		blur();

		expect(wet.wetCleared, "the wet ink stayed on the page after the handoff").toEqual([
			[600, 800],
		]);
		expect(wet.tailCleared, "the predicted tail stayed on the page").toEqual([[600, 800]]);
		expect(priv.wetHighlighter, "the wash stayed dressed for the next gesture").toBe(false);
		// The whole point of the ruling: what was drawn LANDS. One `add`, on
		// the page the contact started on, persisted exactly once.
		expect(ops.length, "the partial stroke vanished instead of committing").toBe(1);
		const op = ops[0] as Extract<InkOp, { type: "add" }>;
		expect(op.type).toBe("add");
		expect(op.path).toBe("doc-1");
		expect(op.strokes.length).toBe(1);
		expect(op.strokes[0]?.page, "the commit lost the page the stroke was drawn on").toBe(1);
		// And the gesture is over even though the ink is not lost: `idle` is
		// what main.ts asks before swapping another device's ink in.
		expect(controller.idle).toBe(true);
	});

	/**
	 * The behaviour change of 1.4.13, EXECUTED on both of this surface's
	 * pen-up exits with the Boox toggle OFF.
	 *
	 * The box clear (`clearStroke`) shipped in 1.4.4 gated behind
	 * `predictionEinkOn()` - default false - because the comment beside it
	 * said everyone else waits "until an e-ink user has confirmed the box on
	 * hardware", and nobody on this project has the device to give that
	 * confirmation. A 128-case pixel proof replaced it
	 * (`test/measure/WetClearBox.test.ts`, outside the gate): every
	 * `appendPoint` branch, four path shapes, both zooms, both device pixel
	 * ratios, both pens, read back exhaustively, leave nothing behind.
	 *
	 * `wetCleared` above cannot see this: `clear` and `clearStroke` push the
	 * same pair of numbers into it, so it was green before the change and
	 * would be green if the gate were put back. `wetCalls` records WHICH.
	 */
	it("clears the wet layer's own box on both pen-up exits, with Boox OFF", () => {
		expect(predictionEinkOn(), "the e-ink toggle was on, so this proves nothing").toBe(false);

		// Exit 1: the commit branch at the end of `penUp`, reached the way the
		// test above reaches it - a blur through `finishActiveStroke`.
		inkContact();
		priv.tools = toolsStub();
		const committed = wetStub();
		priv.pair = committed.pair;
		priv.wetHostPage = 1;
		blur();
		expect(
			committed.wetCalls,
			"the commit handoff took the whole-canvas clear, damaging the whole canvas"
		).toEqual(["clearStroke"]);
		// The tail takes its dirty rect too, and is handed the page size so
		// `clear()`'s no-box fallback is armed - see `TailRenderer.clear` and
		// `test/measure/TailClearBox.test.ts`. Both halves are asserted: a
		// `clear()` called WITHOUT the size would leave a nulled box painted.
		expect(committed.tailCalls, "the tail stayed on the whole-canvas clear").toEqual([
			"clear",
		]);
		expect(
			committed.tailCleared,
			"the tail's clear was not handed the size, so the fallback is disarmed"
		).toEqual([[600, 800]]);

		// Exit 2: `clearWetTrail`, the abandoned-stroke path, reached through
		// the in-place document switch. It needs a contact of its OWN - the
		// blur above already stood the gesture down, and a switch with nothing
		// live clears nothing.
		inkContact();
		const abandoned = wetStub();
		priv.pair = abandoned.pair;
		priv.wetHostPage = 1;
		controller.forgetHistory();
		expect(
			abandoned.wetCalls,
			"clearWetTrail took the whole-canvas clear"
		).toEqual(["clearStroke"]);
		expect(abandoned.tailCalls).toEqual(["clear"]);
		expect(abandoned.tailCleared).toEqual([[600, 800]]);
	});

	it("and the in-place document switch stands down exactly the same things", () => {
		// `forgetHistory` is the blur's twin: the pane shows a different file,
		// the router is reused, and a contact whose lift was lost across the
		// switch is torn down with no pointerup. It ran the strip and the
		// gesture state and left the reticle and the wet trail behind - one
		// teardown answered two different ways, which is how the strip half
		// came to be missing here in the first place. One method now, so the
		// two cannot drift again.
		setMouseInk(true);
		priv.showCursor(sample(10, 10), "mouse");
		inkContact("mouse");
		const tools = toolsStub();
		priv.tools = tools;
		const wet = wetStub();
		priv.pair = wet.pair;
		priv.wetHostPage = 1;
		expect(cursorStyle.display).toBe("block");

		controller.forgetHistory();

		expect(tools.inking).toEqual([false]);
		expect(cursorStyle.display, "the switch carried the reticle onto the new file").toBe(
			"none"
		);
		expect(scroller.classList.contains("handwriting-pdf-hover")).toBe(false);
		expect(wet.wetCleared, "the old file's wet trail stayed over the new one").toEqual([
			[600, 800],
		]);
		expect(controller.idle).toBe(true);
		expect(ops).toEqual([]);
	});

	it("a blur with nothing live is still byte-for-byte a no-op on the strip", async () => {
		// 2e880b4 and f5f2333 together: the router returns false, the callback
		// never fires, and a healthy strip is not put down by an alt-tab.
		const tools = toolsStub();
		priv.tools = tools;

		blur();
		await new Promise<void>((r) => queueMicrotask(() => r()));

		expect(tools.inking).toEqual([]);
		expect(tools.refreshes).toBe(0);
	});
});

/**
 * PEN OFF ON A PDF (PenInk.ts, design §5), driven through the real router.
 *
 * The state shipped note-only: `PdfInkController` passed no `penOff`
 * predicate, so this router gated on nothing and the pen kept inking on a pdf
 * however the switch read. Two follow-ups then made the strip agree with that
 * - the keyboard button first went dark on a pdf strip, then vanished from it
 * - and the owner reversed the whole line: "i think the dude was having
 * trouble with his keyboard coming up on pdf when he didnt want it to? so why
 * would you take keyboard mode away from pdf".
 *
 * So the assertion is about the CLAIM, not about the strip. A pdf with the pen
 * off must hand a pen contact back to the viewer untouched - that is what lets
 * the pen select text, follow a link and put the caret in a form field, and it
 * is the same refusal the note makes. Driven over the same element fake and
 * the same real router as the teardown suite above, because the thing that
 * broke was the wiring between the two surfaces and only a real router can
 * say whether this one is wired.
 *
 * `InkSurfaceRules.test.ts` scans both surfaces' source for `penOff:` now that
 * it is in `INLINE_PEN_CALLBACKS`; that catches the member going missing. What
 * it cannot catch is a body that answers wrongly, which is this file's half.
 */
describe("PdfInkController: the pen off on a pdf claims nothing", () => {
	let uninstallWindow: () => void = () => {};
	beforeAll(() => {
		uninstallWindow = installFakeWindow();
	});
	afterAll(() => {
		uninstallWindow();
	});

	let controller: PdfInkController;
	let priv: { tools: unknown; builder: unknown; pair: unknown; wetHostPage: number };
	let ops: InkOp[];
	let scroller: ReturnType<typeof fakeEl>;
	/** What a claimed contact would have spent on the event, and did not. */
	let prevented: number;

	/** The strip stand-in, counting only what a claim would move. */
	function toolsStub(): { inking: boolean[]; setInking(on: boolean): void; refresh(): void; closeInkSliders(): void } {
		const stub = {
			inking: [] as boolean[],
			setInking: (on: boolean) => void stub.inking.push(on),
			refresh: () => {},
			closeInkSliders: () => {},
		};
		return stub;
	}

	beforeEach(() => {
		resetTipModeForTest();
		resetPenInkForTest();
		setPenReticle(true);
		setMouseInk(false);
		prevented = 0;
		const el = fakeEl() as ReturnType<typeof fakeEl> & Record<string, unknown>;
		el.querySelector = () => null;
		el.createDiv = cursorChildren(() => ({
			setAttribute: () => {},
			remove: () => {},
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			setCssStyles: () => {},
			parentElement: el,
		}));
		scroller = el;
		probe.current = {
			scroller: el,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{ pageNumber: 1, leftPx: 0, topPx: 0, widthPx: 600, heightPx: 800, hasCanvas: true },
			],
		};
		const win = {
			devicePixelRatio: 1,
			navigator: { userAgent: "", platform: "", maxTouchPoints: 0 },
			setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
			clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
			cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
			getComputedStyle: () => ({ position: "relative" }),
		};
		ops = [];
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => [],
			() => "doc-1",
			() => [],
			(op) => void ops.push(op)
		);
		priv = controller as unknown as typeof priv;
		(controller as unknown as { bindTo(el: unknown): void }).bindTo(el);
		priv.tools = toolsStub();
	});

	afterEach(() => {
		(controller as unknown as { router: { dispose(): void } | null }).router?.dispose();
		resetPenInkForTest();
		resetTipModeForTest();
		setPenReticle(true);
	});

	/** A real nib contact on the viewer, through the router's own handler. */
	function penDown(): void {
		setTipMode("nib");
		const h = scroller.handlers.get("pointerdown");
		if (!h) throw new Error("the router registered no pointerdown handler");
		const ev = penEvent("pointerdown", 100) as unknown as Record<string, unknown>;
		ev.preventDefault = () => void prevented++;
		h(ev as unknown as Event);
	}

	function mouseEvent(type: string, timestamp: number, pointerId: number, buttons: number): PointerEvent {
		const ev = penEvent(type, timestamp, {
			pointerType: "mouse",
			pointerId,
			buttons,
		}) as unknown as PointerEvent & { defaultPrevented: boolean };
		let wasPrevented = false;
		Object.defineProperty(ev, "defaultPrevented", { configurable: true, get: () => wasPrevented });
		ev.preventDefault = () => {
			wasPrevented = true;
			prevented++;
		};
		return ev;
	}

	it("hands a pen contact back to the viewer while the pen is off", () => {
		setPenInk(false);

		penDown();

		// Nothing was claimed, so nothing on this surface changed: no builder,
		// no strip stand-down, and - the half a user feels - no
		// preventDefault, which is what lets the viewer place its own caret
		// and raise the keyboard from a field the pen taps.
		expect(priv.builder, "the pdf built a stroke with the pen off").toBe(null);
		expect(controller.idle, "the pdf claimed a gesture with the pen off").toBe(true);
		expect(prevented, "the contact was eaten instead of handed to the viewer").toBe(0);
		expect(ops).toEqual([]);
	});

	it("and inks again the moment the pen comes back on", () => {
		// The other half, so the test above cannot pass because this harness
		// simply never inks.
		setPenInk(false);
		penDown();
		expect(controller.idle).toBe(true);

		setPenInk(true);
		penDown();

		expect(priv.builder, "the pdf refused the pen after it was turned back on").not.toBe(null);
		expect(controller.idle).toBe(false);
		expect(prevented, "a claimed contact was left to the viewer").toBeGreaterThan(0);
	});

	it("preserves a claimed pdf mouse through the registered Keyboard pause fanout", () => {
		setTipMode("nib");
		setMouseInk(true);
		setPenInk(true);
		priv.pair = {
			wetCanvas: { setCssProps: () => {} },
			headCanvas: { setCssProps: () => {} },
			wet: { clear: () => {}, clearStroke: () => {} },
			tail: { clear: () => {}, clearAll: () => {} },
		};
		priv.wetHostPage = 1;
		priv.tools = toolsStub();
		const fire = (ev: PointerEvent) => scroller.handlers.get(ev.type)!(ev);
		const down = mouseEvent("pointerdown", 100, 41, 1);
		fire(down);
		expect(controller.idle).toBe(false);
		const undo = addStripSurface(() => {}, undefined, undefined, undefined, (preserveMouse) =>
			controller.endLiveStroke(preserveMouse)
		);
		try {
			setPenInk(false);
			endLiveStrokesEverywhere(true);
			expect(controller.idle, "Keyboard pause force-finished the PDF mouse").toBe(false);
			expect(ops).toEqual([]);
			fire(mouseEvent("pointermove", 108, 41, 1));
			fire(mouseEvent("pointerrawupdate", 112, 41, 1));
			const up = mouseEvent("pointerup", 120, 41, 0);
			fire(up);
			expect(ops.length, "the owned mouse did not commit at its own lift").toBe(1);
			expect(controller.idle).toBe(true);
			expect(up.defaultPrevented).toBe(true);
			const fresh = mouseEvent("pointerdown", 128, 42, 1);
			fire(fresh);
			expect(fresh.defaultPrevented, "a paused fresh mouse was claimed").toBe(false);
			expect(ops.length).toBe(1);
		} finally {
			undo();
		}
	});

	/**
	 * The toggle can be hit with the nib on the glass - a hotkey, the palette,
	 * or the other hand on the strip - and the router's gate refuses only NEW
	 * claims (`InlinePenCallbacks.penOff`). The note answers that by committing
	 * the live stroke, on the owner's alt-tab ruling ("sure make it
	 * consistent"), and a pdf that answered differently would eat the word
	 * being written on one surface and keep it on the other.
	 *
	 * Driven through the REAL fan-out, `endLiveStrokesEverywhere`, with this
	 * controller registered the way main.ts registers every open pane's -
	 * `addStripSurface`'s fifth callback. Asserting the REGISTERED callback ran
	 * is what fails if that wiring is dropped, where calling `endLiveStroke()`
	 * directly would stay green with the fan-out deleted; the idiom is the
	 * mouse-ink one two suites above.
	 */
	it("commits a live pdf stroke when the pen goes off under it", () => {
		setTipMode("nib");
		penDown();
		const wetCleared: number[][] = [];
		priv.pair = {
			wetCanvas: { setCssProps: () => {} },
			headCanvas: { setCssProps: () => {} },
			wet: {
				clear: (w: number, h: number) => void wetCleared.push([w, h]),
				clearStroke: (w: number, h: number) => void wetCleared.push([w, h]),
			},
			tail: { clear: () => {}, clearAll: () => {} },
		};
		priv.wetHostPage = 1;
		const tools = toolsStub();
		priv.tools = tools;
		expect(controller.idle, "the ink contact never took").toBe(false);

		const undo = addStripSurface(
			() => {},
			undefined,
			undefined,
			undefined,
			() => controller.endLiveStroke()
		);
		try {
			setPenInk(false);
			endLiveStrokesEverywhere();
		} finally {
			undo();
		}

		// COMMITTED, not dropped: one `add` op on the page the contact started
		// on, exactly as a lift would have made.
		expect(ops.length, "the live pdf stroke vanished when the pen went off").toBe(1);
		const op = ops[0] as Extract<InkOp, { type: "add" }>;
		expect(op.type).toBe("add");
		expect(op.path).toBe("doc-1");
		expect(op.strokes[0]?.page).toBe(1);
		// And the gesture is over, so the pane can be reloaded and the strip
		// is not left wearing `is-inking`.
		expect(controller.idle).toBe(true);
		expect(tools.inking).toEqual([false]);
	});

	it("and main.ts really registers that fan-out for every open pdf pane", () => {
		// The half the test above cannot reach: it registers the callback
		// itself, so it stays green if main.ts stops registering one. Nothing
		// in this repo can construct the plugin class, so this is a source
		// read - `?raw` (raw-imports.d.ts), the house pattern - and it is
		// bounded at BOTH ends by anchors asserted to exist, so it cannot pass
		// on a stray `endLiveStroke` somewhere else in the file.
		const from = mainSrc.indexOf("addStripSurface(");
		expect(from, "main.ts no longer registers a strip surface at all").toBeGreaterThan(-1);
		const to = mainSrc.indexOf('this.app.workspace.on("file-open"', from);
		expect(to, "the anchor after the registration moved").toBeGreaterThan(from);
		expect(
			mainSrc.slice(from, to),
			"main.ts registers no end-live-stroke callback, so a pdf stroke survives the pen going off"
		).toContain("c.endLiveStroke(preserveMouse)");
	});
});

/**
 * The band: which part of a page the ink canvases cover, and at what
 * resolution.
 *
 * The defect these were written against is one sentence from hardware - "at
 * max zoom, pretty blurry still" (alan, 2026-09-04) - and one line of the old
 * code. The canvases covered the WHOLE page div and their backing store was
 * capped at 4M device px, so a page at high zoom (tens of millions of css px)
 * got `sqrt(cap / area)` device pixels per css pixel: well under one. The ink
 * was rasterised below screen resolution and stretched, while pdf.js's own
 * page canvas kept a far larger budget and stayed sharp underneath. The cap
 * was never the problem; asking for the whole page was.
 *
 * Driven through the controller's own privates rather than a gesture, because
 * what is under test is arithmetic about pixels and every one of these numbers
 * is reachable directly. `sync` is the real one, `attachPair` is the real one,
 * `backingFor` is the real one, and the scroll handler is the one `bindTo`
 * actually registered - the routing above them is covered by the suites that
 * drive gestures.
 */
describe("PdfInkController band", () => {
	/** The viewport, chosen so the numbers in the assertions are checkable. */
	const VIEW_W = 1200;
	const VIEW_H = 800;
	/** margin = clamp(round(800 * 0.25), 120, 320) = 200. */
	const MARGIN = 200;
	/** A page at high zoom: 48M css px, far past any per-canvas cap. */
	const PAGE_W = 6000;
	const PAGE_H = 8000;

	interface Rec {
		transforms: number[][];
		clears: number[][];
		/** The selection outline, which is the only strokeRect this surface draws. */
		strokeRects: number[][];
	}

	/**
	 * A 2D context that records the two calls this cares about and absorbs
	 * every other one.
	 *
	 * A Proxy rather than a hand-written stub because `drawCommitted` runs the
	 * REAL `drawStroke` over real strokes, which touches a long tail of canvas
	 * API. Listing that tail would be a second implementation of the renderer
	 * to keep in sync; absorbing it leaves the assertions on the two calls that
	 * carry the geometry.
	 */
	function fakeCtx(): { ctx: CanvasRenderingContext2D; rec: Rec } {
		const rec: Rec = { transforms: [], clears: [], strokeRects: [] };
		const target: Record<string, unknown> = {
			setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) =>
				void rec.transforms.push([a, b, c, d, e, f]),
			clearRect: (x: number, y: number, w: number, h: number) => void rec.clears.push([x, y, w, h]),
			strokeRect: (x: number, y: number, w: number, h: number) => void rec.strokeRects.push([x, y, w, h]),
		};
		const ctx = new Proxy(target, {
			get: (t, p) => (p in t ? t[p as string] : () => undefined),
			set: (t, p, v) => {
				t[p as string] = v;
				return true;
			},
		});
		return { ctx: ctx as unknown as CanvasRenderingContext2D, rec };
	}

	interface FakeCanvas {
		width: number;
		height: number;
		css: Record<string, string>;
		rec: Rec;
		parentElement: unknown;
	}

	function makeCanvas(parent: unknown): FakeCanvas & Record<string, unknown> {
		const { ctx, rec } = fakeCtx();
		const c: FakeCanvas & Record<string, unknown> = {
			width: 300,
			height: 150,
			css: {},
			rec,
			parentElement: parent,
			setAttribute: () => {},
			remove() {
				c.parentElement = null;
			},
			getContext: () => ctx,
			setCssStyles: (s: Record<string, string>) => Object.assign(c.css, s),
			// The wet layer's highlighter wash, written at every pen-down.
			setCssProps: () => {},
			toggleClass: () => {},
			classList: { add: () => {}, remove: () => {} },
		};
		return c;
	}

	let scroller: Record<string, unknown> & {
		scrollTop: number;
		scrollLeft: number;
		handlers: Map<string, (e: unknown) => void>;
	};
	type FakePage = Record<string, unknown> & { children: FakeCanvas[] };
	let pages: Map<number, FakePage>;
	/** Page 1, which every assertion written before the second page existed uses. */
	let pageEl: FakePage;
	let controller: PdfInkController;
	let priv: {
		mounted: boolean;
		frame: unknown;
		band: { left: number; top: number; width: number; height: number } | null;
		sync(): void;
		syncBand(el: unknown): boolean;
		attachPair(el: unknown, box: unknown): unknown;
		bindTo(el: unknown): void;
		penDown(s: PenSample): void;
		penUp(): void;
		selected: string[];
		selectionPage: number;
	};
	let strokes: InkStroke[];
	/** The fake window, kept so a test can change the display under the controller. */
	let win: { devicePixelRatio: number } & Record<string, unknown>;
	/**
	 * How many times the scroller's four SIZE fields have been read.
	 *
	 * In a browser each of those reads flushes pending layout; the offsets do
	 * not. Counting them is the only way to assert the hot-path claim from a
	 * test, since a fake element has no layout to force.
	 */
	let layoutReads = 0;
	let uninstallWindow: (() => void) | null = null;

	/** The committed canvas: the first one the page was given. */
	function committed(): FakeCanvas {
		const c = pageEl.children[0];
		if (!c) throw new Error("no committed canvas was ever created");
		return c;
	}

	/**
	 * The canvases a page is holding RIGHT NOW.
	 *
	 * By parentage rather than by index, because a page can be given a canvas,
	 * have it taken away when it leaves the band and be given another when it
	 * comes back - the fake keeps every one it ever made, and only the live
	 * ones are the question.
	 */
	function attachedOn(pageNumber: number): FakeCanvas[] {
		const p = pages.get(pageNumber);
		return p ? p.children.filter((c) => c.parentElement !== null) : [];
	}

	/** The last transform written to a canvas, as [scale, offsetX, offsetY]. */
	function lastTransform(c: FakeCanvas): number[] {
		const t = c.rec.transforms[c.rec.transforms.length - 1];
		if (!t) throw new Error("nothing was ever drawn on this canvas");
		return [t[0]!, t[4]!, t[5]!];
	}

	/** How many times this canvas has been repainted. */
	function paints(c: FakeCanvas): number {
		return c.rec.transforms.length;
	}

	function scrollTo(top: number): void {
		scroller.scrollTop = top;
		const h = scroller.handlers.get("scroll");
		if (!h) throw new Error("bindTo registered no scroll listener");
		h({});
	}

	beforeEach(() => {
		resetTipModeForTest();
		// The router this controller builds reaches for a real `window` and
		// for the scroller's inline `touchAction`. Neither exists in node; the
		// harness both other suites in this file use supplies them.
		uninstallWindow = installFakeWindow();
		// One stroke per page. A page with no ink of its own is dropped by
		// `paint` before the band is ever consulted, so a second page with
		// nothing on it could not witness anything about the band.
		strokes = [inkAt("b1"), { ...inkAt("b2"), page: 2 }];
		function makePage(): FakePage {
			const children: FakeCanvas[] = [];
			const p: FakePage = {
				children,
				clientWidth: PAGE_W,
				clientHeight: PAGE_H,
				createEl: () => {
					const c = makeCanvas(p);
					children.push(c);
					return c;
				},
				appendChild: () => {},
				get lastElementChild() {
					return children[children.length - 1];
				},
				setCssStyles: () => {},
				// The snip asks the page for the viewer's own canvas; this
				// harness has none, which is the paper-white fallback.
				querySelectorAll: () => [],
			};
			return p;
		}
		pages = new Map([
			[1, makePage()],
			[2, makePage()],
		]);
		pageEl = pages.get(1)!;
		const handlers = new Map<string, (e: unknown) => void>();
		scroller = {
			handlers,
			scrollTop: 0,
			scrollLeft: 0,
			clientWidth: VIEW_W,
			clientHeight: VIEW_H,
			scrollWidth: PAGE_W,
			scrollHeight: PAGE_H * 2,
			style: { touchAction: "" },
			contains: () => false,
			setPointerCapture: () => {},
			releasePointerCapture: () => {},
			classList: { add: () => {}, remove: () => {}, contains: () => false },
			// The real selector carries the page number, and the two-page
			// harness has to answer it: handing every page number the same
			// element is what let a one-page fake hide a per-page defect.
			querySelector: (sel: string) => {
				const n = Number(/data-page-number="(\d+)"/.exec(sel)?.[1] ?? 0);
				return pages.get(n) ?? null;
			},
			addEventListener: (t: string, h: (e: unknown) => void) => void handlers.set(t, h),
			removeEventListener: () => {},
			getBoundingClientRect: () => ({ left: 0, top: 0, width: VIEW_W, height: VIEW_H }),
			setCssStyles: () => {},
		};
		// The four layout reads, counted. Values still assign through, so a
		// test can resize the pane.
		layoutReads = 0;
		for (const k of ["clientWidth", "clientHeight", "scrollWidth", "scrollHeight"] as const) {
			let v = scroller[k] as number;
			Object.defineProperty(scroller, k, {
				configurable: true,
				get: () => {
					layoutReads++;
					return v;
				},
				set: (n: number) => {
					v = n;
				},
			});
		}
		probe.current = {
			scroller,
			scaleFactor: SCALE,
			scaleSource: "test",
			pages: [
				{
					pageNumber: 1,
					leftPx: 0,
					topPx: 0,
					widthPx: PAGE_W,
					heightPx: PAGE_H,
					hasCanvas: true,
				},
				{
					pageNumber: 2,
					leftPx: 0,
					topPx: PAGE_H,
					widthPx: PAGE_W,
					heightPx: PAGE_H,
					hasCanvas: true,
				},
			],
		};
		let rafDepth = 0;
		win = {
			devicePixelRatio: 2,
			navigator: { userAgent: "", platform: "", maxTouchPoints: 0 },
			setTimeout: () => 0,
			clearTimeout: () => {},
			// Synchronous, so `schedule()` -> `sync()` happens inside the call
			// that asked for it and the assertions can be written in a line.
			//
			// One level deep only. `startFrameTicker` re-arms itself from
			// inside its own callback, which a synchronous frame turns into
			// unbounded recursion the moment a test drives a real pen-down;
			// dropping the nested request runs the ticker exactly once, which
			// is all this suite needs of it.
			requestAnimationFrame: (fn: (t: number) => void) => {
				if (rafDepth > 0) return 0;
				rafDepth++;
				try {
					fn(0);
				} finally {
					rafDepth--;
				}
				return 0;
			},
			getComputedStyle: () => ({ position: "relative" }),
		};
		controller = new PdfInkController(
			{} as HTMLElement,
			win as unknown as Window,
			() => strokes,
			() => "doc-1",
			() => strokes,
			() => {}
		);
		priv = controller as unknown as typeof priv;
		priv.mounted = true;
		priv.bindTo(scroller);
		priv.sync();
	});

	afterEach(() => {
		(controller as unknown as { router: { dispose(): void } | null }).router?.dispose();
		uninstallWindow?.();
		uninstallWindow = null;
	});

	/**
	 * (a) The defect itself.
	 *
	 * The page is 6000x8000 = 48M css px. Under the old law that is
	 * `sqrt(4_000_000 / 48_000_000)` = 0.289 device px per css px, at a dpr of
	 * 2 - the ink drawn at under a seventh of the screen's linear resolution
	 * and scaled up, which is what "pretty blurry" was.
	 *
	 * The BAND at the page's top-left corner is the viewport plus ONE margin
	 * on each axis: the band hangs 200px off the page on the two leading
	 * sides and the intersection cuts that away, which is the whole reason it
	 * is intersected. 1400 x 1000 = 1.4M css px, 5.6M device px at dpr 2, and
	 * it fits the 10M cap with room to spare - so there is no reason to spend
	 * a single pixel of sharpness.
	 */
	it("at a zoom that dwarfs the cap, the band still gets a full device pixel", () => {
		const [backing] = lastTransform(committed());
		expect(backing, "the committed canvas was rasterised below screen resolution at high zoom").toBe(2);
		expect(committed().width).toBe((VIEW_W + MARGIN) * 2);
		expect(committed().height).toBe((VIEW_H + MARGIN) * 2);
	});

	/**
	 * (b) One law, two callers - the rule `backingFor`'s header has always
	 * stated, now with a position in it as well as a size. Wet ink drawn on a
	 * canvas offset by even one pixel from the committed one lands in the
	 * wrong place the moment the pen lifts and the committed painter takes
	 * over.
	 */
	it("the wet pair and the committed canvas agree on band and backing", () => {
		const box = { pageNumber: 1, leftPx: 0, topPx: 0, widthPx: PAGE_W, heightPx: PAGE_H };
		priv.attachPair(pageEl, box);
		const wet = pageEl.children[1]!;
		const head = pageEl.children[2]!;
		const c = committed();
		for (const [name, other] of [
			["wet", wet],
			["head", head],
		] as const) {
			expect(other.css, `the ${name} canvas sits somewhere else than the committed ink`).toEqual(c.css);
			expect(other.width, `the ${name} canvas has a different backing`).toBe(c.width);
			expect(other.height, `the ${name} canvas has a different backing`).toBe(c.height);
			expect(lastTransform(other), `the ${name} canvas draws page units elsewhere`).toEqual(
				lastTransform(c)
			);
		}
	});

	/**
	 * (f) (MINOR finding, later review.) The comment above `bandTransform`'s
	 * call site in `attachPair` says a same-sized band at a different offset
	 * gets its transform rewritten so future drawing lands correctly - true,
	 * but silent on whatever was already rasterised on the pair before that
	 * rewrite (today: a lasso outline between gestures). The clear a few
	 * lines below only ran on a page change or a resize, so a PURE
	 * translation - same width and height, pen landing on the SAME page -
	 * hit neither, and any standing pixels would have been carried forward
	 * into the new band, displaced by exactly the delta the band moved.
	 *
	 * Driven straight through `attachPair`, per this describe block's own
	 * header, rather than a real pen-down: a "nib" pen-down clears the wet
	 * layer itself at the start of every stroke (line ~2445, unconditional -
	 * a fresh page for a fresh stroke), which would clear on the second
	 * pen-down regardless of whether `attachPair`'s OWN clear fired and hide
	 * the very thing this test exists to catch.
	 *
	 * Page 1 is 8000 css px tall against an 800px viewport, so a scroll
	 * within [margin, pageBottom - viewport - margin] moves the band well
	 * past `bandNeedsMove`'s hysteresis, on the same page, without touching
	 * its size - the case the size check and the page check both miss. The
	 * FIRST attach is at scrollTop 1000 rather than 0: at 0 the band clamps
	 * against the page's top edge (asymmetric margin), so the very next
	 * scroll would change the band's size along with its origin and no
	 * longer isolate a pure translation.
	 */
	it("attachPair clears the pair when the band translates without changing size", () => {
		const box = { pageNumber: 1, leftPx: 0, topPx: 0, widthPx: PAGE_W, heightPx: PAGE_H };
		scrollTo(1000);
		priv.attachPair(pageEl, box);
		const wet = pageEl.children[1]!;
		const clearsBefore = wet.rec.clears.length;
		const sizeBefore = [wet.width, wet.height];

		scrollTo(4000);
		priv.attachPair(pageEl, box);

		expect(
			[wet.width, wet.height],
			"the band's size changed too - this test needs a pure translation"
		).toEqual(sizeBefore);
		expect(
			wet.rec.clears.length,
			"a same-sized band translation rewrote the transform without clearing standing pixels"
		).toBeGreaterThan(clearsBefore);
	});

	/**
	 * (c) The hot-path rule. A scroll inside the margin must cost a
	 * comparison; only a scroll that has eaten into it may cost a raster.
	 */
	it("a scroll inside the band repositions nothing, and one past it repaints once", () => {
		const before = paints(committed());
		const box0 = { ...committed().css };
		// Half a margin is the hysteresis `bandNeedsMove` allows; 40px is well
		// inside it and is a scroll a finger makes constantly.
		const reads = layoutReads;
		scrollTo(40);
		// And it does not force layout. The listener used to read all four size
		// fields on every scroll event, each of which flushes pending layout
		// in a browser; they change only on a resize or a zoom, which are
		// already observed and already reach `sync`, so they are measured
		// there and cached.
		expect(layoutReads - reads, "the scroll listener read the scroller's size").toBe(0);
		expect(paints(committed()), "an ordinary scroll re-rasterised the page").toBe(before);
		expect(committed().css, "an ordinary scroll moved the canvas").toEqual(box0);

		scrollTo(1500);
		expect(paints(committed()), "a scroll past the margin did not repaint - or repainted twice").toBe(
			before + 1
		);
		expect(committed().css.top, "the band did not follow the viewport").not.toBe(box0.top);
	});

	/**
	 * (d) The invariant the whole change rests on: page units are page units.
	 *
	 * A page point's position ON SCREEN is the canvas's css offset plus where
	 * the transform puts it inside the canvas. That sum must not depend on
	 * where the band happens to be sitting, or ink would slide by the size of
	 * every reposition.
	 */
	it("a page point lands in the same place before and after a band move", () => {
		const pagePoint = 300; // page units
		const screenOf = (): number => {
			const c = committed();
			const [backing, offY] = [lastTransform(c)[0]!, lastTransform(c)[2]!];
			// The box is written as a percentage of the page (`placeBanded`),
			// so resolving it needs the page's height - which is what the
			// browser does with it too.
			const cssTop = (parseFloat(c.css.top ?? "0") / 100) * PAGE_H;
			// device px inside the canvas, back to css px, plus where the
			// canvas starts inside the page.
			return cssTop + (pagePoint * SCALE * backing + offY) / backing;
		};
		const at0 = screenOf();
		expect(at0).toBeCloseTo(pagePoint * SCALE, 6);
		scrollTo(3000);
		expect(screenOf(), "the ink moved on the page when the band moved under it").toBeCloseTo(at0, 6);
	});

	/**
	 * (e) The frame is frozen at pen-down and the band goes with it. Moving
	 * the canvas under a live stroke would shear it: the samples are mapping
	 * through a frame that no longer describes where the pixels are.
	 */
	it("a live gesture freezes the band until pen-up", () => {
		// Driven, not poked. Setting `frame` by hand asserted that the FIELD
		// freezes the band, which was true and was the defect: `frame` is set
		// by every gesture including a pan, and it outlived two of them. What
		// has to freeze the band is ink actually being drawn, so the test has
		// to draw.
		setTipMode("nib");
		priv.penDown(sample(150, 150));
		const box0 = { ...committed().css };
		const before = paints(committed());
		expect(priv.syncBand(scroller), "syncBand moved the band during a stroke").toBe(false);
		scrollTo(4000);
		expect(committed().css, "the canvas moved under a live stroke").toEqual(box0);
		expect(paints(committed())).toBe(before);
		// And pen-up releases it: the same scroll now lands.
		priv.penUp();
		scrollTo(4000);
		expect(committed().css.top, "the band stayed frozen after the gesture ended").not.toBe(box0.top);
	});

	/**
	 * The two gestures that are not ink, and the reason they get a test each.
	 *
	 * `frame` is written at pen-down for EVERY gesture, and `penUp`'s pan and
	 * space branches both returned before the line that cleared it. So one pan
	 * - the gesture whose whole purpose is to move the viewport - froze the
	 * band permanently: `syncBand` answered false for the life of the view,
	 * and every page the reader then scrolled to fell outside the stale band,
	 * failed `pageBandFor`, and had its committed canvas dropped by `paint`.
	 * The document went blank below the fold and stayed blank until an
	 * ordinary stroke or a viewer rebuild happened to clear the field.
	 *
	 * Page 2 starts outside the band and is scrolled to afterwards, because
	 * "the band did not move" and "the page you scrolled to has no ink on it"
	 * are the same defect seen from two ends, and the second one is what the
	 * reader actually reports.
	 */
	/**
	 * And the other half of it: a pan is a SCROLL, so the band has to move
	 * while the pan is still happening. Gating the freeze on `frame` froze it
	 * for the duration too, so a long drag scrolled the viewer clean off the
	 * band and the ink under the finger vanished until the pen came up.
	 */
	it("the band follows a pan while the pan is still happening", () => {
		setTipMode("pan");
		priv.penDown(sample(150, 150));
		const box0 = { ...committed().css };
		scrollTo(3000);
		expect(committed().css.top, "the band froze under the one gesture that scrolls").not.toBe(box0.top);
		priv.penUp();
	});

	for (const mode of ["pan", "space"] as const) {
		it(`a ${mode} gesture releases the band when it ends`, () => {
			expect(attachedOn(2), "page 2 was in the band before the scroll").toEqual([]);
			setTipMode(mode);
			priv.penDown(sample(150, 150));
			priv.penUp();
			// The field itself, because it is what `penRaw` reads to decide a
			// gesture is live: a frame that outlives its gesture is a lie told
			// to every path that asks, and the band was only the loudest of
			// them.
			expect(priv.frame, `a ${mode} gesture left its frozen frame behind`).toBeNull();
			scrollTo(9000);
			expect(priv.band?.top, `the band never moved again after a ${mode}`).toBeGreaterThan(1000);
			expect(
				attachedOn(2).length,
				`the page scrolled to after a ${mode} was given no ink canvas`
			).toBeGreaterThan(0);
		});
	}

	/**
	 * The canvas has to survive the gap between the viewer resizing a page and
	 * our repaint catching up.
	 *
	 * `paint` writes the band's box into the element, overriding the
	 * stylesheet's `inset: 0; width: 100%; height: 100%`. Written in px that
	 * override detaches the canvas from the page the moment the page changes
	 * size, and our repaint arrives through `scheduleThrottled` - up to
	 * SYNC_MIN_GAP_MS (120ms) later. A ctrl+wheel zoom is a burst of resizes,
	 * so the ink sat at the wrong offset and the wrong scale for a tenth of a
	 * second per step, which is the entire gesture. Written as percentages it
	 * stretches with the page, exactly as `inset: 0` did.
	 */
	it("a page resized before the repaint keeps its canvas over the same part of it", () => {
		/** The canvas's box as a fraction of the page, however it was written. */
		const boxOf = (w: number, h: number): Record<string, number> => {
			const css = committed().css;
			const frac = (v: string | undefined, of: number): number => {
				const n = parseFloat(v ?? "0");
				return (v ?? "").trim().endsWith("%") ? n / 100 : n / of;
			};
			return {
				left: frac(css.left, w),
				top: frac(css.top, h),
				width: frac(css.width, w),
				height: frac(css.height, h),
			};
		};
		// Somewhere with a non-zero offset on both axes, or the defect hides
		// behind a band that happens to start at the page's corner.
		scroller.scrollLeft = 2000;
		scrollTo(3000);
		const before = boxOf(PAGE_W, PAGE_H);
		expect(before.top, "the band sat at the page's top edge, where this cannot fail").toBeGreaterThan(0);
		expect(before.left, "the band sat at the page's left edge, where this cannot fail").toBeGreaterThan(0);
		// One zoom step. The viewer has stretched the page div; nothing has
		// repainted yet, which is the state that lasts up to 120ms.
		pageEl.clientWidth = PAGE_W * 1.25;
		pageEl.clientHeight = PAGE_H * 1.25;
		expect(boxOf(PAGE_W * 1.25, PAGE_H * 1.25), "the canvas came off the page when the page resized").toEqual(
			before
		);
	});

	/**
	 * One band, one resolution, and one budget.
	 *
	 * The backing was worked out from each page's INTERSECTION with the band,
	 * so two pages sharing a band got different answers. At dpr 3 the seam
	 * below puts 300px of a 1200px band on page 1 and 900px on page 2: the
	 * 300px slice fits the 10M cap at a full 3 device px per css px, the 900px
	 * one does not and is divided to 2.82, and the two rasters meet on screen
	 * at the page join. Worse, the cap then bounded each canvas separately
	 * rather than the band - 13.8M device px held across the two, against a
	 * band whose whole allowance is 10M.
	 */
	it("every page in one band is rasterised at one backing, inside one budget", () => {
		win.devicePixelRatio = 3;
		// The seam, deliberately off centre: band 7700..8900 leaves 300px on
		// page 1 (0..8000) and 900px on page 2. Equal slices would answer the
		// same by accident and prove nothing.
		scrollTo(7900);
		const top = attachedOn(1);
		const bottom = attachedOn(2);
		expect(top.length, "page 1 left the band at the seam").toBeGreaterThan(0);
		expect(bottom.length, "page 2 never entered the band at the seam").toBeGreaterThan(0);
		const backing = lastTransform(top[0]!)[0]!;
		expect(lastTransform(bottom[0]!)[0], "the two pages sharing a band drew at different resolutions").toBe(
			backing
		);
		// Band css area x backing^2 is the whole allowance, and `MAX_OVERLAY_PX`
		// (10M) is the ceiling on that allowance. Every canvas the band touches
		// comes out of one or the other; neither is a per-canvas budget.
		const held = [...top, ...bottom].reduce((n, c) => n + c.width * c.height, 0);
		const budget = (VIEW_W + MARGIN * 2) * (VIEW_H + MARGIN * 2) * backing * backing;
		expect(held, "the canvases in one band held more pixels than the band's own budget").toBeLessThanOrEqual(
			Math.ceil(budget)
		);
		expect(held, "the cap bounded each canvas instead of the band").toBeLessThanOrEqual(10_000_000);
	});

	/**
	 * A selection survives its page leaving the band; its OUTLINE did not.
	 *
	 * The dashed box lives on the wet layer, and the wet layer is one pair for
	 * the whole surface: the page leaving the band calls `detachPairFrom`,
	 * which un-parents it and zeroes `wetHostPage`. `selected` and
	 * `selectionPage` are untouched - they are a statement about ink, not
	 * about pixels - so the toolbar stayed lit and delete and snip still
	 * worked while the reader could no longer see what they had picked up.
	 * Redrawn rather than cleared: scrolling is not a decision to throw a
	 * selection away.
	 */
	it("a selection's outline comes back when its page re-enters the band", () => {
		priv.selected = ["b2"];
		priv.selectionPage = 2;
		expect(attachedOn(2), "page 2 was already in the band").toEqual([]);
		scrollTo(9000);
		const drew = pages.get(2)!.children.some((c) => c.rec.strokeRects.length > 0);
		expect(drew, "the selection outline never came back with the page").toBe(true);
	});

	/**
	 * A measured-empty band and a band that has not been measured are
	 * opposite answers, and `bandBoxFor` gave both of them the whole page.
	 *
	 * `bandFor` returns an empty band DELIBERATELY for a scroller reporting
	 * zero client size - that is how the note surface releases its canvases in
	 * a background tab, where the editor stays alive at no size. Reading it as
	 * "we cannot tell, so paint everything" inverted it exactly: five live
	 * pages, each allowed the raised 10M cap, is 200MB of backing store for a
	 * tab nobody is looking at.
	 */
	it("a scroller with no size releases every page canvas", () => {
		expect(attachedOn(1).length, "page 1 had no canvas to release").toBeGreaterThan(0);
		scroller.clientWidth = 0;
		scroller.clientHeight = 0;
		(controller as unknown as { invalidateProbe(): void }).invalidateProbe();
		priv.sync();
		expect(attachedOn(1), "a background tab kept a full-page backing store").toEqual([]);
		expect(attachedOn(2)).toEqual([]);
		// And the pixels are actually let go, not merely orphaned.
		expect(committed().width * committed().height, "the backing store outlived the canvas").toBe(0);
	});

	/** The other half of the distinction: unmeasured still paints whole pages. */
	it("a controller that has not measured yet still covers whole pages", () => {
		const unmeasured = priv as unknown as {
			band: unknown;
			bandBoxFor(p: { leftPx: number; topPx: number; widthPx: number; heightPx: number }): unknown;
		};
		unmeasured.band = null;
		expect(
			unmeasured.bandBoxFor({ leftPx: 0, topPx: 0, widthPx: PAGE_W, heightPx: PAGE_H }),
			"an unmeasured surface stopped drawing instead of degrading to the whole page"
		).toEqual({ left: 0, top: 0, width: PAGE_W, height: PAGE_H });
	});

	/**
	 * The snip has its own cap, and it did not before.
	 *
	 * `snipSelection` was handed `MAX_OVERLAY_PX` because the two numbers
	 * happened to be the same 4M. Raising the overlay cap to 10M for the band
	 * therefore raised the size of every lasso-and-snip PNG with it - two and a
	 * half times the pixels, into a note, into a vault, into sync - with
	 * nothing in the band's argument saying a picture should get bigger.
	 */
	it("a snip is capped at its own 4M, not at the overlay's", () => {
		// Big enough that the cap is what decides the size: the crop is the
		// whole 3000x4000pt page at 4 device px per point, ~192M px asked for.
		const pts = [0, 1500, 2900].map((v, i) => ({ x: v, y: v, pressure: 0.5, t: i * 8 }));
		strokes = [{ ...inkAt("big"), points: pts, bbox: computeBBox(pts, 4) }];
		priv.selected = ["big"];
		priv.selectionPage = 1;
		// The peak, not the final value: `snipSelection` zeroes the backing
		// store in a `finally` to release it, so the size it actually asked
		// for is only visible while it is being written.
		const peak = { w: 0, h: 0 };
		const g2 = globalThis as unknown as Record<string, unknown>;
		const hadCreateEl = "createEl" in g2;
		g2.createEl = (): unknown => ({
			set width(v: number) {
				peak.w = Math.max(peak.w, v);
			},
			get width() {
				return peak.w;
			},
			set height(v: number) {
				peak.h = Math.max(peak.h, v);
			},
			get height() {
				return peak.h;
			},
			getContext: () => fakeCtx().ctx,
			toBlob: (cb: (b: unknown) => void) => cb(null),
		});
		try {
			// The blob is refused above, so the result is a failure - but the
			// canvas was sized before that, and its size is the question.
			return controller.snipSelection().then(() => {
				expect(peak.w * peak.h, "the snip never got as far as sizing a canvas").toBeGreaterThan(0);
				expect(
					peak.w * peak.h,
					"the snip was still sharing the overlay's raised cap"
				).toBeLessThanOrEqual(4_000_000);
				// And it is genuinely the cap that bound it, not a small crop.
				expect(peak.w * peak.h, "the crop was too small to be capped by anything").toBeGreaterThan(
					3_000_000
				);
			});
		} finally {
			if (!hadCreateEl) delete g2.createEl;
		}
	});

	/**
	 * A page the reader has scrolled away from should be holding no pixels.
	 * This is what makes the cost of a hundred-page pdf the band's area rather
	 * than the sum of every live page's - the claim the memory numbers in the
	 * commit body rest on.
	 */
	/**
	 * And it should never have been given one. `paint` built the canvas, set
	 * its attribute and appended it before asking whether the page was in the
	 * band at all, then removed it again - two childList mutations on a page
	 * div, which our own observer cannot tell from the viewer's writes, for
	 * every off-band page on every sync. At a zoom where the band covers one
	 * page of ten, that is most of the document churning the DOM to no effect.
	 */
	it("a page outside the band is never given a canvas to take away", () => {
		// Page 2 (8000..16000) has ink of its own and has been through a full
		// sync; the band at the top of the document does not reach it.
		expect(pages.get(2)!.children, "an off-band page had a canvas built and then removed").toEqual([]);
	});

	it("a page outside the band drops its canvas", () => {
		expect(committed().parentElement).not.toBeNull();
		probe.current = {
			...(probe.current as Record<string, unknown>),
			pages: [
				{
					pageNumber: 1,
					leftPx: 0,
					topPx: 40000,
					widthPx: PAGE_W,
					heightPx: PAGE_H,
					hasCanvas: true,
				},
			],
		};
		(controller as unknown as { invalidateProbe(): void }).invalidateProbe();
		priv.sync();
		expect(committed().parentElement, "an off-screen page kept its backing store").toBeNull();
	});
});
