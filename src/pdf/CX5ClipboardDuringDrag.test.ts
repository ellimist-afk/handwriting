import { PageStore } from "../persistence/PageStore";
import { FakeAdapter } from "../persistence/FakeAdapter";
import { PdfInkStore } from "./PdfInkStore";
import { emptyPage, parsePage, serializePage } from "../model/PageData";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeBBox, InkStroke } from "../ink/Stroke";
import { InkOp } from "../inline/InkHistory";
import { resetTipModeForTest, setTipMode } from "../inline/TipMode";
import { PenSample } from "../input/PointerRouter";
import { PageBox } from "./PageMap";

const probe = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./PdfViewerProbe", () => ({ probeViewer: () => probe.current, viewerCanvasOf: () => null }));
import { PdfInkController } from "./PdfInkController";
import { applyOp } from "./PdfInkHistory";

const sample = (x: number, y: number): PenSample => ({ x, y, pressure: 0.5, timestamp: 0, tiltX: 0, tiltY: 0 });

function rig(scale = 2) {
	const points = Array.from({ length: 200 }, (_, i) => ({ x: 100 + (i%11), y: 100 + (i%11), pressure: 0.5, t: i }));
	let ink: InkStroke[] = [{ id: "picked", points, bbox: computeBBox(points, 2), tool: "pen", color: "#000000", width: 2, createdAt: 0, page: 1 }];
		const untouched = Array.from({ length: 1500 }, (_, i) => ({ ...ink[0]!, id: `other-${i}`, page: 2 }));
	ink.push(...untouched);
	const ops: InkOp[] = [];
	const counts = { lines: 0, paints: 0, copiedPoints: 0 };
	let painted = false;
	const context = {
		clearRect: () => { painted = false; }, save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() { counts.lines++; },
		stroke: () => { painted = true; counts.paints++; }, strokeRect: () => { painted = true; },
	};
	const boxes: PageBox[] = [1, 2].map((pageNumber) => ({ pageNumber, leftPx: 0, topPx: (pageNumber - 1) * 810, widthPx: 600, heightPx: 800 }));
	const scroller = { scrollLeft: 0, scrollTop: 0, classList: { add() {}, remove() {} }, querySelector: () => null };
	probe.current = { scroller, scaleFactor: scale, scaleSource: "test", pages: boxes.map((b) => ({ ...b, hasCanvas: true })) };
	const frames = new Map<number, () => void>();
	let next = 0;
	const win = {
		devicePixelRatio: 1, clearTimeout() {}, setTimeout: () => 0,
		requestAnimationFrame: (fn: () => void) => { frames.set(++next, fn); return next; },
		cancelAnimationFrame: (id: number) => frames.delete(id),
	};
	const persist = vi.fn();
	const controller = new PdfInkController({} as HTMLElement, win as unknown as Window,
		(page) => ink.filter((s) => s.page === page), () => "pdf-id", () => ink,
		(op) => { ops.push(op); if (op.type === "move") counts.copiedPoints += ink.filter((s) => op.strokeIds.includes(s.id)).reduce((n,s) => n+s.points.length,0); ink = applyOp(ink, op); }, () => {}, () => {}, persist);
	const pen = controller as unknown as {
		boundScroller: unknown; wetOn(page: number): unknown; cameraFor(box: PageBox): unknown;
		penDown(s: PenSample, ev?: PointerEvent): void; penRaw(s: PenSample[]): void; penUp(ev?: PointerEvent): void; historyStep(redo: boolean): boolean; handleKeyDown(ev: KeyboardEvent): void; lassoPts: {x: number; y: number}[];
	};
	pen.boundScroller = scroller;
	pen.wetOn = () => ({ wetCanvas: { getContext: () => context }, wet: { clear: () => { painted = false; } } });
	pen.cameraFor = () => ({ x: 0, y: 0, zoom: scale });
	const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); };
	const loop = () => {
		pen.penDown(sample(150, 150), { buttons: 2, button: 2, pointerType: "pen" } as PointerEvent);
		pen.penRaw([sample(250, 150), sample(250, 250), sample(150, 250), sample(150, 150)]);
		pen.penUp();
		expect(controller.hasSelection).toBe(true);
	};
	return { controller, pen, loop, ops, persist, flush, counts, untouched, painted: () => painted, ink: () => ink };
}


import { clearInkClipboard, copyInk, inkClipboardMarker, pasteInk } from "../inline/InkClipboard";

describe("Clipboard commands during a selection drag", () => {
	beforeEach(() => { resetTipModeForTest(); clearInkClipboard(); });
	const chosen = (r: ReturnType<typeof rig>) => r.ink().find((s) => s.id === "picked");
	const expectedPoints = (stroke: InkStroke, dx: number, dy: number) =>
		stroke.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }));

	for (const drainBeforeCommand of [false, true]) {
		it(`Cut clipboard contains moved ink before lift, drained=${drainBeforeCommand}`, () => {
			const r = rig(); r.loop(); const initial = structuredClone(chosen(r)!);
			r.pen.penDown(sample(205, 205)); r.pen.penRaw([sample(225, 235)]);
			if (drainBeforeCommand) r.flush();
			expect(r.controller.cutSelection()).toBe(1);
			const pasted = pasteInk("another-document");
			expect(pasted).toHaveLength(1);
			expect(pasted[0]!.points[0]!.x, "clipboard x is the moved x").toBe(110);
			expect(pasted[0]!.points).toEqual(expectedPoints(initial, 10, 15));
			expect(pasted[0]!.bbox).toEqual({ ...initial.bbox, x: initial.bbox.x + 10, y: initial.bbox.y + 15 });
			expect(pasted[0]!.page).toBe(1);
			expect(chosen(r)).toBeUndefined();
		});

		it(`Cut operands and Undo contain moved ink before lift, drained=${drainBeforeCommand}`, () => {
			const r = rig(); r.loop(); const initial = structuredClone(chosen(r)!);
			r.pen.penDown(sample(205, 205)); r.pen.penRaw([sample(225, 235)]);
			if (drainBeforeCommand) r.flush();
			expect(r.controller.cutSelection()).toBe(1);
			const remove = r.ops.find((op) => op.type === "remove");
			expect(remove?.type).toBe("remove");
			if (!remove || remove.type !== "remove") throw new Error("Cut must emit removal");
			expect(remove.strokes[0]!.points).toEqual(expectedPoints(initial, 10, 15));
			expect(r.pen.historyStep(false)).toBe(true);
			expect(chosen(r)!.points).toEqual(expectedPoints(initial, 10, 15));
			const afterUndo = structuredClone(r.ink()); const operations = r.ops.length;
			r.pen.penRaw([sample(295, 305)]); r.flush(); r.pen.penUp({ type: "pointerup" } as PointerEvent); r.flush();
			expect(r.ink()).toEqual(afterUndo); expect(r.ops).toHaveLength(operations);
			expect(r.pen.historyStep(false)).toBe(true); expect(chosen(r)).toEqual(initial);
			expect(r.pen.historyStep(false)).toBe(false);
			expect(r.pen.historyStep(true)).toBe(true); expect(chosen(r)!.points).toEqual(expectedPoints(initial, 10, 15));
			expect(r.pen.historyStep(true)).toBe(true); expect(chosen(r)).toBeUndefined();
			expect(r.pen.historyStep(true)).toBe(false);
			expect(r.ink()).toEqual(r.untouched);
		});

		it(`Copy uses current ink and keeps the drag live, drained=${drainBeforeCommand}`, () => {
			const r = rig(); r.loop(); const initial = structuredClone(chosen(r)!);
			r.pen.penDown(sample(205, 205)); r.pen.penRaw([sample(225, 235)]);
			if (drainBeforeCommand) r.flush();
			r.controller.copySelection();
			const pasted = pasteInk("another-document");
			expect(pasted[0]!.points[0]!.x, "Copy clipboard x is the moved x").toBe(110);
			expect(pasted[0]!.points).toEqual(expectedPoints(initial, 10, 15));
			expect(r.controller.hasSelection).toBe(true);
			r.pen.penRaw([sample(245, 255)]); r.pen.penUp({ type: "pointerup" } as PointerEvent); r.flush();
			expect(chosen(r)!.points).toEqual(expectedPoints(initial, 20, 25));
			expect(r.persist).toHaveBeenCalledTimes(1);
			expect(r.pen.historyStep(false)).toBe(true); expect(chosen(r)).toEqual(initial);
			expect(r.pen.historyStep(false)).toBe(false);
			expect(r.ink().slice(1)).toEqual(r.untouched);
		});
	}

	for (const command of ["Copy", "Cut"] as const) {
		for (const refused of ["synthetic", "no-id", "empty"] as const) {
			it(`${command} refusal preserves the clipboard and live drag: ${refused}`, () => {
				const r = rig(); r.loop();
				copyInk([structuredClone(chosen(r)!)], "prior-document");
				const marker = inkClipboardMarker();
				r.pen.penDown(sample(205, 205)); r.pen.penRaw([sample(225, 235)]);
				const access = r.controller as unknown as {
					syntheticSources: () => boolean; documentId: () => string | null; selected: string[];
					frame: unknown; dragFrom: unknown; editDelta: unknown; history: { depth: { done: number; undone: number } };
				};
				if (refused === "synthetic") access.syntheticSources = () => true;
				if (refused === "no-id") access.documentId = () => null;
				if (refused === "empty") access.selected = [];
				const ink = structuredClone(r.ink()), frame = access.frame;
				const drag = structuredClone(access.dragFrom), delta = structuredClone(access.editDelta);
				if (command === "Cut") expect(r.controller.cutSelection()).toBe(0); else r.controller.copySelection();
				expect(inkClipboardMarker()).toBe(marker);
				expect(r.ink()).toEqual(ink); expect(r.ops).toHaveLength(0); expect(r.persist).not.toHaveBeenCalled();
				expect(access.frame).toBe(frame); expect(access.dragFrom).toEqual(drag); expect(access.editDelta).toEqual(delta);
				expect(access.history.depth).toEqual({ done: 0, undone: 0 });
			});
		}
	}
});

describe("Clipboard commands after selected ink is removed", () => {
	beforeEach(() => { resetTipModeForTest(); clearInkClipboard(); });
	for (const command of ["Copy", "Cut"] as const) {
		it(`${command} leaves a prior clipboard intact for stale selected IDs`, () => {
			const r = rig(); r.loop();
			copyInk([structuredClone(r.ink()[0]!)], "prior-document");
			const marker = inkClipboardMarker();
			// Another writer removed the selected stroke; its old selection ID remains.
			r.ink().splice(0, 1);
			const remaining = structuredClone(r.ink());
			expect(r.controller.hasSelection).toBe(false);
			if (command === "Cut") expect(r.controller.cutSelection()).toBe(0); else r.controller.copySelection();
			expect(inkClipboardMarker()).toBe(marker);
			expect(r.ink()).toEqual(remaining);
			expect(r.ops).toHaveLength(0); expect(r.persist).not.toHaveBeenCalled();
			const history = (r.controller as unknown as { history: { depth: { done: number; undone: number } } }).history;
			expect(history.depth).toEqual({ done: 0, undone: 0 });
		});
	}
});
