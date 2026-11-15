/**
 * A stroke handed in by the e-ink companion, on the bare overlay
 * InlineEraseFresh.test.ts uses: the real `landBridgeStroke`, the real
 * `penUp`, the real store, no DOM.
 *
 * Two things are held here. A companion stroke lands where it was written,
 * as one stroke and one undo step, through the same handoff a pen stroke
 * takes. And a pen contact the companion is delivering leaves nothing of its
 * own behind, while a contact nobody claimed is kept exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InkOverlayPlugin, inlineInk } from "./InkOverlay";
import type { NoteBridgeSnapshot } from "./InkOverlayBridge";
import { setBridgeSession } from "../bridge/BridgeHub";
import type { BridgePoint } from "../bridge/BridgeProtocol";
import { BridgeSession } from "../bridge/BridgeSession";
import { DEFAULT_PEN } from "../ink/PenStyle";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { StrokeIndex } from "../ink/StrokeIndex";

const PATH = "bridge-note.md";

function fakeCtx(): CanvasRenderingContext2D {
	return {
		fillStyle: "", strokeStyle: "", lineWidth: 0, lineCap: "", lineJoin: "",
		beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {}, fill() {}, stroke() {}, save() {}, restore() {},
	} as unknown as CanvasRenderingContext2D;
}

interface Rig {
	view: Record<string, unknown>;
	ops: Array<{ type: string; strokes?: unknown[] }>;
	land(points: readonly BridgePoint[], snapshot: NoteBridgeSnapshot | null): boolean;
	/** Finish a six-point pen contact through the real `penUp`, with the companion standing to it as given. */
	penUp(contact: "claimed" | "open" | null): void;
}

function makeRig(): Rig {
	const view = Object.create(InkOverlayPlugin.prototype) as Record<string, unknown>;
	const ops: Rig["ops"] = [];
	const wet = { clear: () => undefined, clearStroke: () => undefined, countPainted: () => 0 };
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
	view.strokeIndex = new StrokeIndex();
	view.indexDirty = false;
	view.activeWet = wet;
	view.highlightWet = { ...wet };
	view.highlightWetCanvas = { setCssStyles: () => undefined };
	view.tail = { clear: () => undefined, clearAll: () => undefined, prepareLive: () => undefined };
	view.committedCtx = fakeCtx();
	view.highlightCtx = fakeCtx();
	view.damage = { addRect: () => undefined, addAll: () => undefined };
	view.frame = { locked: false, end: () => undefined };
	view.penStyle = { ...DEFAULT_PEN };
	view.viewportPan = { x: 0, y: 0 };
	view.boundReadout = { floorX: 0, floorY: 0, bx: 0, width: 0, rawX: 0, cx: 0, rawY: 0, cy: 0,
		dragFrame: false, neverZoomed: false, steady: false, next: 0, fromScale: 0, fromScaleValid: false,
		restCeilX: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, bounded: false, settling: false };
	view.camera = { snapshot: { x: 0, y: 0, zoom: 1 }, screenToWorld: (x: number, y: number) => ({ x, y }) };
	view.filePath = () => PATH;
	view.updateHandwritingPageClass = () => undefined;
	view.dispatchInk = (op: { type: string }) => void ops.push(op);
	view.repaintPath = () => undefined;
	view.updateExtent = () => undefined;
	view.recordCommitDiagnostics = () => undefined;
	view.scheduleRepaint = () => undefined;
	const proto = InkOverlayPlugin.prototype as unknown as {
		penUp(this: unknown): void;
		landBridgeStroke(this: unknown, points: readonly BridgePoint[], snapshot: NoteBridgeSnapshot | null): boolean;
	};
	return {
		view,
		ops,
		land: (points, snapshot) => proto.landBridgeStroke.call(view, points, snapshot),
		penUp(contact) {
			const builder = new StrokeBuilder("pen", DEFAULT_PEN.color, DEFAULT_PEN.baseWidth);
			builder.start(0);
			for (let i = 0; i < 6; i++) builder.add(300 + i * 2, 300, 0.5, i * 8);
			view.builder = builder;
			view.strokePenGesture = true;
			view.bridgeContact = contact;
			view.mode = "ink";
			proto.penUp.call(view);
		},
	};
}

/** Viewport px to samples one to one, the page under it scrolled by (0, 100) and shown at twice its size. */
const SNAPSHOT: NoteBridgeSnapshot = { cam: { x: 0, y: 100, zoom: 2 }, x0: -10, y0: -20, k: 1 };
const POINTS: BridgePoint[] = [
	{ x: 110, y: 220, pressure: 0.4, t: 0 },
	{ x: 130, y: 220, pressure: 0.6, t: 8 },
	{ x: 150, y: 240, pressure: 0.5, t: 16 },
];

const stored = () => inlineInk.strokes(PATH);

describe("a stroke from the e-ink companion on the note surface", () => {
	beforeEach(() => inlineInk.applyRemove(PATH, stored().map((s) => s.id)));
	afterEach(() => setBridgeSession(null));

	it("lands as one pen stroke, placed by the mapping it was drawn under", () => {
		const rig = makeRig();
		expect(rig.land(POINTS, SNAPSHOT)).toBe(true);
		expect(stored()).toHaveLength(1);
		const stroke = stored()[0]!;
		expect(stroke.tool).toBe("pen");
		// Sample = client - (10, 20); world = sample / 2 + (0, 100).
		expect(stroke.points[0]).toMatchObject({ x: 50, y: 200, t: 0 });
		expect(stroke.points.at(-1)).toMatchObject({ x: 70, y: 210, t: 16 });
	});

	it("is one undo step, and the erase index hears about it", () => {
		const rig = makeRig();
		rig.land(POINTS, SNAPSHOT);
		expect(rig.ops).toHaveLength(1);
		expect(rig.ops[0]).toMatchObject({ type: "add", path: PATH });
		expect(rig.ops[0]!.strokes).toHaveLength(1);
		expect(rig.view.indexDirty).toBe(true);
	});

	it("carries the selected pen's colour and width", () => {
		const rig = makeRig();
		rig.land(POINTS, SNAPSHOT);
		const control = new StrokeBuilder("pen", stored()[0]!.color, stored()[0]!.width);
		control.start(0);
		control.add(0, 0, 0.5, 0);
		control.add(9, 9, 0.5, 8);
		expect(stored()[0]!.width).toBeGreaterThan(0);
		expect(control.finish()?.pressureProfile).toBe(stored()[0]!.pressureProfile);
	});

	it("refuses a stroke it cannot place and stores nothing", () => {
		const rig = makeRig();
		expect(rig.land(POINTS, null)).toBe(false);
		expect(rig.land([], SNAPSHOT)).toBe(false);
		rig.view.filePath = () => null;
		expect(rig.land(POINTS, SNAPSHOT)).toBe(false);
		expect(stored()).toHaveLength(0);
		expect(rig.ops).toHaveLength(0);
	});

	describe("the webview's own copy of the contact", () => {
		const session = (): BridgeSession => {
			const s = new BridgeSession(() => true, () => 0);
			setBridgeSession(s);
			return s;
		};

		it("is kept when there is no companion at all", () => {
			const rig = makeRig();
			rig.penUp("open");
			expect(stored()).toHaveLength(1);
		});

		it("is kept when the companion never claimed it", () => {
			session();
			const rig = makeRig();
			rig.penUp("open");
			expect(stored()).toHaveLength(1);
		});

		it("is dropped when the companion claimed it at pen-down", () => {
			const rig = makeRig();
			rig.penUp("claimed");
			expect(stored()).toHaveLength(0);
			expect(rig.ops).toHaveLength(0);
		});

		it("is dropped when the companion's claim arrived during the stroke", () => {
			const s = session();
			const rig = makeRig();
			s.handle({ type: "stroke-begin", id: 1, rev: 1 });
			rig.penUp("open");
			expect(stored()).toHaveLength(0);
			// The claim was spent on that contact: the next one is the webview's.
			rig.penUp("open");
			expect(stored()).toHaveLength(1);
		});

		it("is kept for a contact the companion never draws, whatever claims are waiting", () => {
			const s = session();
			const rig = makeRig();
			s.handle({ type: "stroke-begin", id: 1, rev: 1 });
			rig.penUp(null);
			expect(stored()).toHaveLength(1);
		});
	});
});
