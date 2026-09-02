/**
 * The eraser can erase ink drawn since the file was opened.
 *
 * User report (Android, 1.4.6, via Alan): "eraser only works if you open the
 * file and use eraser. if you change to pen tool and back to eraser, eraser
 * will not work." The precise form is narrower than the report: ink that was
 * present at file-open erases, ink drawn since does not, silently.
 *
 * Mechanism, all in `InkOverlay`. `eraseAt` hit-tests `eraseCandidates`,
 * which answers from `strokeIndex` and only rebuilds it when `indexDirty` is
 * set. A stroke enters the index by `rebuild` or by the eraser's own
 * `insertLike` - and the commit path (`penUp` -> `handoffFinishedStroke`'s
 * store callback -> `inlineInk.commitGesture`) did neither, and did not set
 * `indexDirty`. So the first erase after opening rebuilds over the sidecar
 * and works; every stroke drawn after that is in the STORE and not in the
 * INDEX, `query` returns nothing, and `eraseAt` returns early.
 *
 * NOT a 1.4.6 regression: `StrokeIndex.ts`, `InlineInkStore.ts` and the
 * `eraseAt`/`eraseCandidates`/`scheduleRepaint` region of `InkOverlay.ts`
 * are unchanged between 1.4.5 and 1.4.6.
 *
 * The sequence below is the user's, in order, against the real store and the
 * real index: open a note with ink, erase some of it (the case that works),
 * draw a stroke through the real commit path, erase over that stroke. The
 * pre-existing erase is not decoration - it is what leaves `indexDirty`
 * false, which is the state the bug needs. Every step asserts its
 * precondition, because a test whose fresh stroke happened to be in the
 * index anyway would pass against the defect.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { InkStroke } from "../ink/Stroke";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DEFAULT_PEN } from "../ink/PenStyle";

const PATH = "note.md";
/** Far apart, so an eraser at one is nowhere near the other. */
const OLD_AT = { x: 20, y: 20 };
const FRESH_AT = { x: 400, y: 400 };
/** The eraser's world radius at scale 1; the default is 14 visual px. */
const R = 14;

function fakeCtx(): CanvasRenderingContext2D {
	return {
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 0,
		lineCap: "",
		lineJoin: "",
		beginPath() {},
		moveTo() {},
		lineTo() {},
		closePath() {},
		arc() {},
		fill() {},
		stroke() {},
		save() {},
		restore() {},
	} as unknown as CanvasRenderingContext2D;
}

/** A stroke as the sidecar would hand it over: already in the store at open. */
function openedWith(id: string, at: { x: number; y: number }): InkStroke {
	return {
		id,
		tool: "pen",
		color: DEFAULT_PEN.color,
		width: DEFAULT_PEN.baseWidth,
		points: [
			{ x: at.x, y: at.y, pressure: 0.5, t: 0 },
			{ x: at.x + 10, y: at.y, pressure: 0.5, t: 8 },
		],
		bbox: { x: at.x, y: at.y, width: 10, height: 0 },
		createdAt: 0,
	};
}

/** A pen contact at `at`, as the router would have built it by pen-up. */
function contactAt(at: { x: number; y: number }): StrokeBuilder {
	const builder = new StrokeBuilder("pen", DEFAULT_PEN.color, DEFAULT_PEN.baseWidth);
	builder.start(0);
	for (let i = 0; i < 6; i++) {
		builder.add(at.x + i * 2, at.y, 0.5, i * 8);
	}
	return builder;
}

interface Rig {
	/** Finish a pen contact at `at` through the real `penUp`. */
	draw(at: { x: number; y: number }): readonly InkStroke[];
	/** The real `eraseAt`, driven with a screen sample. */
	eraseAt(at: { x: number; y: number }): void;
	/** The real `eraseCandidates`, asked what the index would answer. */
	candidatesAt(at: { x: number; y: number }): readonly InkStroke[];
}

function makeRig(): Rig {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const wet = {
		clear: () => undefined,
		clearStroke: () => undefined,
		countPainted: () => 0,
	};
	view.mode = "ink";
	view.builder = null;
	view.strokePenGesture = false;
	view.strokeRawMax = 0;
	view.rawLastMoveT = 0;
	view.frameTicking = false;
	view.scrollsDuringStroke = 0;
	view.scale = 1;
	view.cssWidth = 800;
	view.cssHeight = 600;
	view.eraseWhole = true;
	view.erased = [];
	view.erasePieces = new Set<string>();
	view.eraseFrom = [];
	view.strokeIndex = new StrokeIndex();
	view.indexDirty = true;
	view.repaintQueued = false;
	view.activeWet = wet;
	view.highlightWet = { ...wet };
	view.highlightWetCanvas = { setCssStyles: () => undefined };
	view.tail = { clear: () => undefined, clearAll: () => undefined };
	view.committedCtx = fakeCtx();
	view.highlightCtx = fakeCtx();
	view.damage = { addRect: () => undefined, addAll: () => undefined };
	view.eraserEl = null;
	view.frame = { locked: false, end: () => undefined };
	view.camera = {
		snapshot: { x: 0, y: 0, zoom: 1 },
		screenToWorld: (x: number, y: number) => ({ x, y }),
	};
	// Own properties, so the prototype's versions never run: `filePath`
	// reads a CodeMirror field, and the rest reach the editor, the strip or
	// the other panes - none of which is the subject here.
	view.filePath = () => PATH;
	view.updateHandwritingPageClass = () => undefined;
	view.dispatchInk = () => undefined;
	view.repaintPath = () => undefined;
	view.updateExtent = () => undefined;
	view.recordCommitDiagnostics = () => undefined;
	view.scheduleRepaint = () => undefined;

	const proto = InkOverlayPlugin.prototype as unknown as {
		penUp(this: unknown): void;
		eraseAt(this: unknown, sample: unknown): void;
		eraseCandidates(this: unknown, w: { x: number; y: number }, r: number): readonly InkStroke[];
	};
	return {
		draw(at) {
			const before = new Set(inlineInk.strokes(PATH).map((s) => s.id));
			view.builder = contactAt(at);
			view.mode = "ink";
			proto.penUp.call(view);
			return inlineInk.strokes(PATH).filter((s) => !before.has(s.id));
		},
		eraseAt(at) {
			view.mode = "erase";
			proto.eraseAt.call(view, { ...at, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });
			view.mode = "ink";
		},
		candidatesAt(at) {
			return proto.eraseCandidates.call(view, at, R);
		},
	};
}

function idsInStore(): string[] {
	return inlineInk.strokes(PATH).map((s) => s.id);
}

describe("erasing a stroke drawn since the file was opened", () => {
	beforeEach(() => {
		// Session-memory mode (no host), so nothing persists and each test
		// starts from a note whose ink is exactly what it puts there.
		inlineInk.applyRemove(PATH, idsInStore());
	});

	it("erases ink present at open, and ink committed after it", () => {
		inlineInk.applyAdd(PATH, [openedWith("old", OLD_AT)]);
		const rig = makeRig();

		// The case the user says works: ink from the sidecar, erased on the
		// first eraser contact after opening. It is also what leaves
		// `indexDirty` false for the rest of the test, which is the state
		// the defect needs.
		expect(rig.candidatesAt(OLD_AT).map((s) => s.id)).toEqual(["old"]);
		rig.eraseAt(OLD_AT);
		expect(idsInStore()).toEqual([]);

		// Draw, through the real commit path: penUp ->
		// handoffFinishedStroke's store callback -> commitGesture.
		const fresh = rig.draw(FRESH_AT);
		expect(fresh).toHaveLength(1);
		const freshId = fresh[0]!.id;
		// Precondition: the stroke really is in the store. Without this, a
		// failure below could be a builder that produced nothing.
		expect(idsInStore()).toEqual([freshId]);

		// The defect, named directly: the index does not know about it, so
		// the eraser's candidate list comes back empty and `eraseAt` returns
		// before touching the store.
		expect(rig.candidatesAt(FRESH_AT).map((s) => s.id)).toEqual([freshId]);
		rig.eraseAt(FRESH_AT);
		expect(idsInStore()).toEqual([]);
	});

	it("erases a fresh stroke with older ink still on the note", () => {
		// The whole-note rebuild has to keep the ink it already had: a fix
		// that dropped the old strokes would pass the test above.
		inlineInk.applyAdd(PATH, [openedWith("old", OLD_AT)]);
		const rig = makeRig();
		rig.candidatesAt(OLD_AT); // settles the index, as a first erase would

		const freshId = rig.draw(FRESH_AT)[0]!.id;
		expect(idsInStore()).toEqual(["old", freshId]);

		rig.eraseAt(FRESH_AT);
		expect(idsInStore()).toEqual(["old"]);
		// And the older stroke is still reachable afterwards.
		expect(rig.candidatesAt(OLD_AT).map((s) => s.id)).toEqual(["old"]);
		rig.eraseAt(OLD_AT);
		expect(idsInStore()).toEqual([]);
	});
});
