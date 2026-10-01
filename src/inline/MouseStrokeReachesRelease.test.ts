/**
 * Cell for audit 98 (lane C1): a quick mouse dash on a note is saved ending short of where the button
 * was released.
 *
 * Root cause read: the mouse's samples go through MouseTrail, a four-sample moving average that lags the pointer by
 * a sample and a half and has no flush, and the note's penUp commits only the smoothed points it was fed. It never
 * appends the release position that the pointerup carries, unlike the PDF surface's addFinalPoint. A dash that ends
 * while moving therefore stops well short of the release point.
 *
 * The real InlinePenRouter (mouse ink armed, on the shared element fake) is driven with a mouse dash: a pointerdown,
 * twelve pointermoves and a pointerup. Its callbacks are wired the way the overlay wires them: the first sample and
 * every later sample go into a real StrokeBuilder as penDown and penRaw do, and onPenUp calls the real penUp with the
 * lift event, which commits the stroke into the real store. So MouseTrail's smoothing and whatever the router does
 * at the lift both run for real.
 * Asserted: the saved stroke's last point is at the release point, within a pixel. It goes green when the router
 * (or penUp) adds the raw release point. The rig supplies clientX/clientY on every event, an identity camera and a
 * container at 0,0.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import { SnapChip } from "./SnapChip";
import { InlinePenRouter } from "./InlinePenRouter";
import { setMouseInk } from "./MouseInk";
import { fakeEl, installFakeWindow, penEvent } from "../../test/routerHarness";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { StrokeIndex } from "../ink/StrokeIndex";
import { DEFAULT_PEN } from "../ink/PenStyle";
import type { InkOp } from "./InkHistory";
import type { InkStroke } from "../ink/Stroke";

const PATH = "mouse-dash.md";

function fakeCtx(): CanvasRenderingContext2D {
	return new Proxy({}, { get: () => () => undefined, set: () => true }) as unknown as CanvasRenderingContext2D;
}

/** A bare overlay that can commit a mouse stroke through the real penUp. */
function makeOverlay(ops: InkOp[]): Record<string, unknown> {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const container = { setCssStyles: () => undefined, createDiv: () => ({}), getBoundingClientRect: () => ({ left: 0, top: 0 }) };
	const wet = { clear: () => undefined, clearStroke: () => undefined, countPainted: () => 0 };
	Object.assign(view, {
		mode: "ink",
		builder: null,
		snapChip: new SnapChip(),
		container,
		cssWidth: 800,
		cssHeight: 600,
		strokePenGesture: false,
		strokeRawMax: 0,
		mouseStroke: true,
		rawLastMoveT: 0,
		rawLastMoveX: 0,
		rawLastMoveY: 0,
		frameTicking: false,
		scrollsDuringStroke: 0,
		scale: 1,
		erased: [],
		erasePieces: new Set<string>(),
		eraseFrom: [],
		eraseWhole: false,
		strokeIndex: new StrokeIndex(),
		indexDirty: true,
		repaintQueued: false,
		activeWet: wet,
		highlightWet: { ...wet },
		highlightWetCanvas: { setCssStyles: () => undefined },
		tail: {
			clear: () => undefined, clearAll: () => undefined,
			configureInlineBacking: () => undefined,
			placeInline: () => undefined,
			restoreFullSurface: () => undefined,
			prepareLive: () => undefined,
		},
		committedCtx: fakeCtx(),
		highlightCtx: fakeCtx(),
		damage: { addRect: () => undefined, addAll: () => undefined },
		eraserEl: null,
		frame: { locked: false, end: () => undefined, cancel: () => undefined },
		viewportPan: { x: 0, y: 0 },
		previewInkOffset: 0,
		boundReadout: { floorX: 0, floorY: 0, bx: 0, width: 0, rawX: 0, cx: 0, rawY: 0, cy: 0, dragFrame: false,
			neverZoomed: false, steady: false, next: 0, fromScale: 0, fromScaleValid: false, restCeilX: 0, startX: 0,
			startY: 0, lastX: 0, lastY: 0, bounded: false, settling: false },
		selection: { clear: () => undefined, prune: () => undefined, isEmpty: true },
		selectionDeleteKeys: { reset: () => undefined },
		lassoPts: [],
		camera: { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) },
		view: {
			dom: { ownerDocument: { defaultView: { setTimeout, clearTimeout } }, addEventListener: () => undefined,
				removeEventListener: () => undefined },
			scrollDOM: { addEventListener: () => undefined, removeEventListener: () => undefined },
		},
		filePath: () => PATH,
		updateHandwritingPageClass: () => undefined,
		repaintPath: () => undefined,
		updateExtent: () => undefined,
		recordCommitDiagnostics: () => undefined,
		scheduleRepaint: () => undefined,
		hidePenCursor: () => undefined,
		hideEraserCursor: () => undefined,
		dispatchInk: (op: InkOp) => void ops.push(op),
	});
	return view;
}

let undoWindow: () => void;

describe("audit 98: a mouse stroke is saved as far as the release point", () => {
	beforeAll(() => {
		undoWindow = installFakeWindow();
	});
	afterAll(() => undoWindow());
	beforeEach(() => {
		inlineInk.applyRemove(PATH, inlineInk.strokes(PATH).map((s) => s.id));
		setMouseInk(true);
	});
	afterEach(() => {
		setMouseInk(false);
		inlineInk.applyRemove(PATH, inlineInk.strokes(PATH).map((s) => s.id));
	});

	it("a dash of thirteen 125 Hz samples released while moving ends at the release point", () => {
		const ops: InkOp[] = [];
		const view = makeOverlay(ops);
		const builder = new StrokeBuilder("pen", DEFAULT_PEN.color, DEFAULT_PEN.baseWidth, undefined, "mouse");
		const proto = InkOverlayPlugin.prototype as unknown as { penUp(this: unknown, ev?: unknown): void };

		// The real router, its callbacks wired as the overlay wires them.
		const el = fakeEl();
		const router = new InlinePenRouter(el as unknown as HTMLElement, el as unknown as HTMLElement, {
			onPenDown: (sample) => {
				builder.start(0);
				builder.add(sample.x, sample.y, 0.5, sample.timestamp);
				view.builder = builder;
			},
			onPenHover: () => {},
			onPenLeave: () => {},
			onPinch: () => {},
			onPenRaw: (samples) => {
				for (const s of samples) builder.add(s.x, s.y, 0.5, s.timestamp);
			},
			onPenMove: () => {},
			onPenUp: (ev) => proto.penUp.call(view, ev),
			onStrokeAbandoned: () => {},
		});
		// The overlay reads its router at the lift, as mount wires it (InkOverlay.ts, `this.router`).
		view.router = router;
		const fire = (ev: PointerEvent): void => {
			const h = el.handlers.get(ev.type);
			if (!h) throw new Error(`router registered no handler for ${ev.type}`);
			h(ev);
		};
		const RELEASE_X = 120;
		const mouse = { pointerType: "mouse", y: 50, pressure: 0.5 };
		fire(penEvent("pointerdown", 0, { ...mouse, x: 0, buttons: 1 }));
		for (let i = 1; i <= 12; i++) fire(penEvent("pointermove", i * 8, { ...mouse, x: i * 10, buttons: 1 }));
		view.rawLastMoveX = RELEASE_X;
		view.rawLastMoveY = 50;
		view.rawLastMoveT = performance.now(); // a release on the move: no hold, no chip
		fire(penEvent("pointerup", 13 * 8, { ...mouse, x: RELEASE_X, buttons: 0 }));
		router.dispose();

		const saved: readonly InkStroke[] = inlineInk.strokes(PATH);
		expect(saved, "the dash was saved as one stroke").toHaveLength(1);
		const last = saved[0]!.points[saved[0]!.points.length - 1]!;
		expect(
			Math.abs(last.x - RELEASE_X),
			`the saved stroke ends at x=${last.x.toFixed(1)}, the button was released at x=${RELEASE_X}`
		).toBeLessThanOrEqual(1);
	});
});
