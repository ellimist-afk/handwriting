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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InkOp } from "../inline/InkHistory";
import { InkStroke, computeBBox } from "../ink/Stroke";
import { PenSample } from "../input/PointerRouter";
import { resetTipModeForTest, setTipMode, setTipModeListener, tipMode } from "../inline/TipMode";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { setInkShaping } from "../ink/InkShape";
import {
	getEraserRadiusPx,
	setEraserWholeStrokes,
	setInlineTool,
	setPenReticle,
} from "../inline/InkOverlay";
import { strokesHitByCircle } from "../ink/Eraser";
import { calibrationStrokes } from "./PdfCalibration";
import { clearInkClipboard, clipboardSize } from "../inline/InkClipboard";

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
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current }));

import { PdfInkController, pdfPenWidth, pointerScale } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";

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
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 0,
			requestAnimationFrame: () => 0,
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
			requestAnimationFrame: () => 0,
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

	it("divides the pen width by the page scale, so pdf ink is note ink", () => {
		pen.penDown(sample(200, 200));
		pen.penRaw([sample(230, 230), sample(260, 260)]);
		pen.penUp();
		const add = ops.find((op) => op.type === "add") as { strokes: InkStroke[] };
		// A note's 2.2 rendered at a page scale of 2 would be 4.4 css px; the
		// stored width is halved so it lands at 2.2 like everywhere else.
		expect(add.strokes[0]!.width).toBeCloseTo(DEFAULT_PEN.baseWidth / SCALE, 6);
	});

	// Op indices are positions in the WHOLE document, because that is the
	// list the store applies every op against (applyOp over pdfStore.strokes).
	// The controller only ever saw a page-filtered list, so its indices were
	// page-local and right only on page one: undo an erase on page five and
	// the ink came back at whatever depth those numbers happened to name.
	it("indexes an erase against the document, not the page it happened on", () => {
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
		expect(replace.removedAt).toEqual([2]);
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
		expect(replaces.every((m) => m === "live")).toBe(true);
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
			requestAnimationFrame: () => 0,
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
	it("renders at the same css width whatever the page scale", () => {
		for (const scale of [1, 1.8692810457516338, 3]) {
			const stored = pdfPenWidth(DEFAULT_PEN.baseWidth, 1, scale);
			expect(stored * scale).toBeCloseTo(DEFAULT_PEN.baseWidth, 6);
		}
	});

	it("carries the nib size multiplier through", () => {
		const stored = pdfPenWidth(DEFAULT_PEN.baseWidth, 2.5, 2);
		expect(stored * 2).toBeCloseTo(DEFAULT_PEN.baseWidth * 2.5, 6);
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
			requestAnimationFrame: () => 0,
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
			createDiv: () => {
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
			},
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
			requestAnimationFrame: () => 0,
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
			createDiv: () => ({
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
		const win = {
			devicePixelRatio: 1,
			clearTimeout: () => {},
			setTimeout: () => 1,
			requestAnimationFrame: () => 0,
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
 * `cursorEl` is primed by one hover first, matching the limit `showLasso/
 * Pan/SpaceCursor` all state in their own comments: none of them BUILD the
 * reticle, they only refresh one that hover already built.
 */
describe("PdfInkController pen reticle - stays alive through pan, lasso and space", () => {
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

	beforeEach(() => {
		resetTipModeForTest();
		setPenReticle(true);
		strokes = [];
		cursorStyle = { display: "none" };
		const scroller = {
			scrollLeft: 0,
			scrollTop: 0,
			classList: { add: () => {}, remove: () => {} },
			querySelector: () => null,
			setCssStyles: () => {},
			createDiv: () => ({
				setAttribute: () => {},
				remove: () => {},
				classList: { add: () => {}, remove: () => {}, toggle: () => {} },
				setCssStyles: (styles: Record<string, unknown>) => {
					Object.assign(cursorStyle, styles);
				},
				parentElement: scroller,
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
			requestAnimationFrame: () => 0,
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

	it("pan: pen-down and the next raw batch each re-arm the watchdog", () => {
		pen.showCursor(sample(10, 10), "pen"); // the pen approached and hovered first
		setTimeoutSpy.mockClear();
		setTipMode("pan");
		pen.penDown(sample(200, 200));
		expect(setTimeoutSpy, "pen-down did not refresh the reticle").toHaveBeenCalledTimes(1);
		expect(cursorStyle.display).toBe("block");
		pen.penRaw([sample(210, 190)]);
		expect(setTimeoutSpy, "the raw batch did not refresh the reticle").toHaveBeenCalledTimes(2);
		expect(cursorStyle.display).toBe("block");
		pen.penUp();
		expect(cursorStyle.display, "pen-up left the reticle up instead of hiding it").toBe("none");
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
			requestAnimationFrame: () => 0,
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
			requestAnimationFrame: () => 0,
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
			requestAnimationFrame: () => 0,
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
			requestAnimationFrame: () => 0,
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
			requestAnimationFrame: () => 0,
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

	it("Escape with neither a selection nor a held mode is left alone", () => {
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
