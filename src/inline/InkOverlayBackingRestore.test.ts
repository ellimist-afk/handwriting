/**
 * A canvas the browser gives back blank (`contextrestored`, after a GPU reset on desktop or Android): the ink on screen comes
 * back without a zoom or a note switch, at the scale it was painted at. The heal is the resize arm at the same size, the one
 * place the committed and highlight contexts get their scale; a bare repaint would draw every stroke at 1/backing of its size.
 *
 * The rig is the repaint rig with `sized`: every canvas a fake whose context loses its transform when the canvas is sized or
 * given back, wet and tail the real renderers, the backing 2. A reset blanks the detached canvases as well, so the pictures
 * kept on them (the stand-in, the extent raster and the overview with their builds, a drag's picture) are let go and the
 * whole paint draws by path. Each cell names the defect that turns it red.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { committedFloorFor, InkOverlayPlugin } from "./InkOverlay";
import { canvasReallocs } from "./InkOverlayConstants";
import { TailRenderer } from "../ink/TailRenderer";
import { AttachedLayer, type AttachedGroup } from "./InkOverlayAttachedLayer";
import { computeBBox, type InkStroke } from "../ink/Stroke";
import { DEFAULT_PEN, HIGHLIGHTER_PEN } from "../ink/PenStyle";
import { fakeCanvas, openRepaintRig, type FakeCanvas, type RepaintRig, type SizedCanvases } from "./overlayRig.testutil";
import { PINCH_SCROLL_QUIET_MS } from "./InkOverlayConstants";

const noHooks = { onCommittedDraw: () => undefined, onPostDraw: () => undefined };
const proto = InkOverlayPlugin.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const SCALE_2 = [2, 0, 0, 2, 0, 0];

type Fields = Record<string, unknown>;

/** Counts the overlay's repaints, as the arm and the queued frame both call `this.repaint()`. */
function countRepaints(o: Fields): { n: number } {
	const box = { n: 0 };
	o.repaint = function (this: unknown, ...a: unknown[]) {
		box.n++;
		return proto.repaint!.apply(this, a);
	};
	return box;
}

/** A sized rig at backing 2: three strokes, the middle one a highlighter stroke unless `penOnly`. */
async function open(extra: { attached?: boolean; highlightDeferred?: boolean; penOnly?: boolean } = {}): Promise<{
	rig: RepaintRig;
	o: Fields;
	cs: SizedCanvases;
	paints: { n: number };
	addAll: ReturnType<typeof vi.fn>;
}> {
	const rig = await openRepaintRig(3, noHooks, { dpr: 2, sized: true, attached: extra.attached, highlightDeferred: extra.highlightDeferred },
		(i) => !extra.penOnly && !extra.highlightDeferred && i === 1);
	const o = rig.overlay;
	const cs = rig.canvases!;
	// The frames the open's own paint asked for (the overview build's first piece), so a cell counts only its own pass.
	rig.deliverPaintCallbacks();
	const paints = countRepaints(o);
	const damage = o.damage as { addAll(): void };
	const real = damage.addAll.bind(damage);
	const addAll = vi.fn(real);
	damage.addAll = addAll;
	return { rig, o, cs, paints, addAll };
}

/** What a canvas's context took after `from` (its transform count at the event). */
const after = (c: FakeCanvas, from: number): number[][] => c.transforms.slice(from);

/** The real unmount, with what it reaches past the listeners that this rig's editor lacks each made inert. */
function unmountHere(o: Fields): void {
	o.wheelZoomRun = { cancel: () => undefined };
	o.paperKindWatch = [];
	o.paperKindFrame = null;
	for (const name of ["restoreScrollableAxis", "restoreViewportLayout", "releaseColumnHold", "resetGestureState"]) o[name] = () => undefined;
	(proto.unmount as () => void).call(o);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a canvas the browser gives back blank", () => {
	it("the committed canvas: its scale is set again, all damage is added, and one whole paint draws every stroke at that scale", async () => {
		// Defect: no listener, so the ink stays blank until a zoom or a note switch. Or a handler that only asks a repaint:
		// scheduleRepaint("other") draws every stroke at scale 1 (half size here); scheduleRepaint("scroll") adds no damage.
		const { rig, cs, paints, addAll } = await open({ penOnly: true });
		expect(cs.committed.drawScales.length, "precondition: the open painted the pen strokes").toBe(3);
		const t0 = cs.committed.transforms.length;
		const d0 = cs.committed.drawScales.length;
		cs.committed.restore();
		const passes = rig.deliverPaintCallbacks();
		expect(after(cs.committed, t0), "the committed context's scale after the event").toEqual([SCALE_2]);
		expect(addAll, "all damage added").toHaveBeenCalled();
		expect(paints.n, "whole paints").toBe(1);
		expect(cs.committed.drawScales.slice(d0), "each stroke drawn again, at the backing scale").toEqual([2, 2, 2]);
		expect(cs.committed.painted).toBe(true);
		expect(passes, "one pass").toBe(1);
		rig.deliverPaintCallbacks();
		expect(after(cs.committed, t0), "no second pass").toEqual([SCALE_2]);
		expect(paints.n, "no second whole paint").toBe(1);
	});

	it("the highlight canvas with a highlighter stroke: its scale is set again and the stroke drawn at it", async () => {
		// Defect: the highlight layer is left out of the heal, or keeps the identity transform and paints its wash at half size.
		const { rig, cs, paints } = await open();
		expect(cs.highlight.drawScales.length, "precondition: the open painted the highlighter stroke").toBe(1);
		const t0 = cs.highlight.transforms.length;
		const d0 = cs.highlight.drawScales.length;
		cs.highlight.restore();
		rig.deliverPaintCallbacks();
		expect(after(cs.highlight, t0)).toEqual([SCALE_2]);
		expect(cs.highlight.drawScales.slice(d0)).toEqual([2]);
		expect(paints.n).toBe(1);
	});

	for (const name of ["wet", "wetTile", "tail", "highlightWet", "attachedPen", "attachedHl"] as const) {
		it(`the ${name} canvas: the same single pass, the wet and tail scales written again`, async () => {
			// Defect: only the committed pair listens, so a lost wet or tail canvas draws the next stroke at scale 1 until a resize.
			const { rig, cs, paints } = await open({ attached: true });
			const target = cs[name]!;
			const t0 = { committed: cs.committed.transforms.length, wet: cs.wet.transforms.length, tail: cs.tail.transforms.length };
			target.restore();
			const passes = rig.deliverPaintCallbacks();
			expect(passes, "one pass").toBe(1);
			expect(after(cs.committed, t0.committed), "the arm ran once").toEqual([SCALE_2]);
			expect(after(cs.wet, t0.wet), "the wet renderer's scale").toEqual([SCALE_2]);
			expect(after(cs.tail, t0.tail).map((m) => [m[0], m[3]]), "the tail renderer's scale").toContainEqual([2, 2]);
			expect(paints.n).toBe(1);
		});
	}

	it("three canvases given back in one task make one pass and one paint", async () => {
		// Defect: each event runs the arm, so a GPU reset reallocates and repaints every layer once per canvas.
		const { rig, cs, paints } = await open();
		const t0 = cs.committed.transforms.length;
		cs.committed.restore();
		cs.highlight.restore();
		cs.wet.restore();
		const passes = rig.deliverPaintCallbacks();
		expect([passes, after(cs.committed, t0).length, paints.n]).toEqual([1, 1, 1]);
	});

	it("given back with a stroke in flight: no paint in that pass, one whole paint scheduled, the router's rect left alone", async () => {
		// Defect: the heal paints under a planted pen, or re-bases the router's rect while the camera stays frozen at pen-down.
		const { rig, o, cs, paints, addAll } = await open();
		const refreshRect = vi.fn();
		o.router = { refreshRect, cameraTransformChanged: () => undefined };
		(o.frame as { begin(): void }).begin();
		o.builder = {};
		const t0 = cs.committed.transforms.length;
		cs.committed.restore();
		const passes = rig.deliverPaintCallbacks();
		expect(passes, "one pass").toBe(1);
		expect(after(cs.committed, t0), "the arm ran").toEqual([SCALE_2]);
		expect(paints.n, "no paint in the pass").toBe(0);
		expect(o.repaintQueued, "a paint is scheduled").toBe(true);
		expect(addAll, "the scheduled paint is whole").toHaveBeenCalled();
		expect(refreshRect).not.toHaveBeenCalled();
	});

	it("given back, then the pen lands before the next frame: that frame still runs the arm, and the wet layer takes the backing scale", async () => {
		// Defect: the pass rides the resize frame a new gesture drops (a pen-down moves the viewport generation), so nothing runs
		// the arm, the restore waits on the next resize of any kind, the ink stays blank and the stroke draws at scale 1.
		const { rig, o, cs } = await open({ penOnly: true });
		o.router = { refreshRect: () => undefined, cameraTransformChanged: () => undefined };
		// The editor already has focus, so the pen-down takes no keyboard hold on this rig's bare editor.
		Object.defineProperty(o.view as object, "hasFocus", { value: true, configurable: true });
		// What the pen-down reaches past the camera, the generation and the wet layer that this rig lacks, each inert here: no
		// selection to drop, no pen tools strip, and the frame ticker (its frames would mix with the restore's).
		(o.selection as Fields).clear = () => false;
		o.ensurePenTools = () => undefined;
		o.startFrameTicker = () => undefined;
		// The pen styles a constructed overlay starts with.
		o.penStyle = { ...DEFAULT_PEN };
		o.highlighterStyle = { ...HIGHLIGHTER_PEN };
		const t0 = { committed: cs.committed.transforms.length, wet: cs.wet.transforms.length };
		cs.committed.restore();
		cs.wet.restore();
		const g0 = o.viewportGeneration;
		const sample = { x: 40, y: 40, pressure: 0.5, timestamp: 1, tiltX: 0, tiltY: 0 };
		const ev = { pointerType: "pen", buttons: 1, button: 0, clientX: 40, clientY: 40, pressure: 0.5, tiltX: 0, tiltY: 0 };
		(proto.penDown as (s: unknown, e: unknown) => void).call(o, sample, ev);
		expect(o.viewportGeneration, "precondition: the pen-down moved the viewport generation").not.toBe(g0);
		expect(o.mode, "precondition: a pen stroke is in flight").toBe("ink");
		rig.deliverPaintCallbacks();
		expect(after(cs.committed, t0.committed), "the arm ran").toEqual([SCALE_2]);
		expect(after(cs.wet, t0.wet), "the wet renderer's scale").toContainEqual(SCALE_2);
		expect(o.backingRestored, "the restore is done").toBe(false);
	});

	it("given back, then the note switches before the next frame: that frame still runs the arm once", async () => {
		// Defect: the restore's frame is kept only for the note it was asked on. The canvases are the overlay's, not the note's,
		// so a note switch strands the flag and the next note shows on blank layers until a resize of any kind.
		const { rig, o, cs } = await open({ penOnly: true });
		const t0 = cs.committed.transforms.length;
		cs.committed.restore();
		o.filePath = () => "another note.md";
		rig.deliverPaintCallbacks();
		expect(after(cs.committed, t0), "the arm ran once").toEqual([SCALE_2]);
		expect(o.backingRestored, "the restore is done").toBe(false);
	});

	it("a deferred highlight pair takes no context call when the committed canvas is given back", async () => {
		// Defect: the heal sizes or scales the 0x0 highlight pair a note with no highlighter stroke keeps unallocated.
		const { rig, cs } = await open({ highlightDeferred: true });
		expect(cs.highlight.el.width, "precondition: the pair is 0x0").toBe(0);
		const t0 = { committed: cs.committed.transforms.length, highlight: cs.highlight.transforms.length };
		cs.committed.restore();
		rig.deliverPaintCallbacks();
		expect(after(cs.committed, t0.committed), "the arm ran").toEqual([SCALE_2]);
		expect(after(cs.highlight, t0.highlight)).toEqual([]);
		expect([cs.highlight.el.width, cs.highlight.el.height]).toEqual([0, 0]);
	});

	it("after unmount a canvas given back does nothing and throws nothing", async () => {
		// Defect: the listeners outlive the overlay and drive a resize pass against a torn-down editor.
		const { rig, o, cs } = await open({ attached: true });
		unmountHere(o);
		const all = [cs.committed, cs.highlight, cs.highlightWet, cs.wet, cs.wetTile, cs.tail, cs.attachedPen!, cs.attachedHl!];
		expect(all.map((c) => c.listeners("contextrestored"))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
		const t0 = cs.committed.transforms.length;
		expect(() => {
			for (const c of all) c.restore();
			rig.deliverPaintCallbacks();
		}).not.toThrow();
		expect(after(cs.committed, t0)).toEqual([]);
	});

	it("a restore frame still owed at unmount is let go, and no pass runs after", async () => {
		// Defect: unmount leaves the restore's own frame owed, so it fires against a torn-down overlay and holds it until then.
		const { rig, o, cs } = await open({ attached: true });
		cs.committed.restore();
		expect(o.backingRestoreRaf, "precondition: the restore's own frame is owed").toBeTruthy();
		unmountHere(o);
		expect(o.backingRestoreRaf, "the frame let go").toBe(0);
		expect(o.backingRestored, "no restore left owed").toBe(false);
		const t0 = cs.committed.transforms.length;
		expect(() => rig.deliverPaintCallbacks()).not.toThrow();
		expect(after(cs.committed, t0)).toEqual([]);
	});

	it("with no canvas given back, a same-size resize tick still reallocates nothing", async () => {
		// Defect: the heal's flag reads as set when nothing was lost, and every resize tick (the iOS keyboard streams them)
		// blanks and repaints the canvases: a flicker per tick.
		const { cs, o, paints } = await open();
		const r0 = canvasReallocs;
		const t0 = cs.committed.transforms.length;
		(proto.handleResize as () => void).call(o);
		(proto.handleResize as () => void).call(o);
		expect([canvasReallocs - r0, after(cs.committed, t0).length, paints.n]).toEqual([0, 0, 0]);
	});

	it("each listener is on its canvas once the overlay is sized", async () => {
		// Defect: a canvas the overlay owns is left out of the listeners (a lost tail or attached canvas never heals).
		const { cs } = await open({ attached: true });
		const all = [cs.committed, cs.highlight, cs.highlightWet, cs.wet, cs.wetTile, cs.tail, cs.attachedPen!, cs.attachedHl!];
		expect(all.map((c) => c.listeners("contextrestored"))).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
		// contextlost is not taken: cancelling it would stop the browser restoring the canvas.
		expect(all.map((c) => c.listeners("contextlost"))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
	});

	it("the pass after a restore tells the attached layer its canvases were given back, once", async () => {
		// Defect: the arm only marks the layer dirty; its sprites, drawn on canvases of their own, are reused blank, and its
		// backing size is kept, so no allocate sets its scale again.
		const { rig, o, cs } = await open({ attached: true });
		const layer = o.attachedLayer as AttachedLayer;
		// Counted on the instance: the layer's own paint lets its sprites go too when it shows no group.
		const told: number[] = [];
		const own = layer as unknown as Record<string, unknown>;
		const real = own.canvasesRestored as (() => void) | undefined;
		own.canvasesRestored = () => {
			told.push(1);
			real?.call(layer);
		};
		cs.attachedPen!.restore();
		rig.deliverPaintCallbacks();
		expect(told.length).toBe(1);
	});

	describe("inside a pinch preview", () => {
		function pinchAt(o: Fields, now: { t: number }): void {
			vi.spyOn(performance, "now").mockImplementation(() => now.t);
			o.pinchPreview = true;
			o.pinchScrollAt = now.t;
		}

		it("within the quiet window after a pinch scroll the pass returns and the restore waits; past it, still in the preview, it waits again", async () => {
			// Defect: the flag is cleared before the early returns, so the restore is dropped and the ink stays blank.
			const { rig, o, cs } = await open();
			const now = { t: 10_000 };
			pinchAt(o, now);
			const t0 = { committed: cs.committed.transforms.length, highlight: cs.highlight.transforms.length };
			cs.committed.restore();
			rig.deliverPaintCallbacks();
			expect(after(cs.committed, t0.committed), "inside the window").toEqual([]);
			now.t += PINCH_SCROLL_QUIET_MS + 80;
			(proto.handleResize as () => void).call(o);
			expect(after(cs.committed, t0.committed), "past the window, preview still on").toEqual([]);
			// The preview ends: the next pass runs the arm once, both transforms set.
			o.pinchPreview = false;
			(proto.handleResize as () => void).call(o);
			expect(after(cs.committed, t0.committed)).toEqual([SCALE_2]);
			expect(after(cs.highlight, t0.highlight)).toEqual([SCALE_2]);
			(proto.handleResize as () => void).call(o);
			expect(after(cs.committed, t0.committed), "once").toEqual([SCALE_2]);
		});

		it("control: with no preview the restore runs the arm at once", async () => {
			const { rig, o, cs } = await open();
			const now = { t: 10_000 };
			vi.spyOn(performance, "now").mockImplementation(() => now.t);
			o.pinchPreview = false;
			const t0 = cs.committed.transforms.length;
			cs.committed.restore();
			rig.deliverPaintCallbacks();
			expect(after(cs.committed, t0)).toEqual([SCALE_2]);
		});

		it("given back in a preview whose lift's commit is refused: the arm runs once after the preview ends", async () => {
			// Defect: the refused commit returns before its resize pass and the preview's end runs none, so the restore waits on
			// the next resize of any kind and the ink stays blank.
			const { rig, o, cs } = await open();
			const now = { t: 10_000 };
			pinchAt(o, now);
			o.canvasMode = true;
			o.pinchRefScale = 1;
			o.pinchAnchor = null;
			const t0 = { committed: cs.committed.transforms.length, highlight: cs.highlight.transforms.length };
			cs.committed.restore();
			rig.deliverPaintCallbacks();
			expect(after(cs.committed, t0.committed), "inside the window").toEqual([]);
			// The lift. Its settle commit is refused (the scale geometry is not valid, as when the pane had no box), so it returns
			// before its own resize pass.
			o.scaleGeometryValid = false;
			const committed: unknown[] = [];
			o.applyPinchScale = (next: number) => {
				committed.push(proto.commitCameraScale!.call(o, next));
			};
			(proto.pinch as (...a: unknown[]) => void).call(o, "end", 1, { x: Number.NaN, y: Number.NaN });
			expect(committed, "precondition: the lift's commit was refused").toEqual([false]);
			expect(o.pinchPreview, "the preview ended").toBe(false);
			rig.deliverPaintCallbacks();
			expect(after(cs.committed, t0.committed), "the arm once after the preview").toEqual([SCALE_2]);
			expect(after(cs.highlight, t0.highlight)).toEqual([SCALE_2]);
		});

		it("given back in a preview whose lift's commit lands: the arm runs once after the lift", async () => {
			// Defect: the settle's own pass and the frame the preview's end asks each run the arm, blanking and painting the
			// layers twice; or neither runs it, and the ink stays blank after the lift.
			const { rig, o, cs } = await open();
			const now = { t: 10_000 };
			pinchAt(o, now);
			o.canvasMode = true;
			o.pinchRefScale = 1;
			o.pinchAnchor = null;
			const t0 = cs.committed.transforms.length;
			cs.committed.restore();
			rig.deliverPaintCallbacks();
			expect(after(cs.committed, t0), "inside the window").toEqual([]);
			// The lift's commit lands. This rig has no viewport layout for the real commit, so it is the commit's two steps that
			// reach the restore: it ends the preview, then runs its own resize pass (commitCameraScale's handleResize).
			const committed: unknown[] = [];
			o.applyPinchScale = () => {
				o.pinchPreview = false;
				(proto.handleResize as () => void).call(o);
				committed.push(true);
			};
			(proto.pinch as (...a: unknown[]) => void).call(o, "end", 1, { x: Number.NaN, y: Number.NaN });
			expect(committed, "precondition: the lift's commit landed").toEqual([true]);
			expect(o.pinchPreview, "the preview ended").toBe(false);
			rig.deliverPaintCallbacks();
			rig.deliverPaintCallbacks();
			expect(after(cs.committed, t0).length, "the arm once").toBe(1);
			expect(o.backingRestored, "the restore is done").toBe(false);
		});

		it("given back, then a pinch starts before the restore frame, then the preview ends with no commit: the arm runs once after", async () => {
			// Defect: the preview's end asks no pass, so the restore frame that met the preview is the last one owed, and with a lift
			// that commits no scale (no resize pass of its own) the ink stays blank until the next resize of any kind.
			const { rig, o, cs } = await open();
			const now = { t: 10_000 };
			vi.spyOn(performance, "now").mockImplementation(() => now.t);
			o.pinchPreview = false;
			const t0 = { committed: cs.committed.transforms.length, highlight: cs.highlight.transforms.length };
			cs.committed.restore();
			expect(o.backingRestoreRaf, "precondition: the restore frame is owed when the pinch starts").not.toBe(0);
			// The pinch starts before that frame. This rig has no editor view for the real start, so the start is what the
			// restore reads of it, as in the cells above: the preview on and a pinch scroll just now.
			pinchAt(o, now);
			rig.deliverPaintCallbacks();
			expect(o.backingRestoreRaf, "the restore frame ran, inside the preview").toBe(0);
			expect(after(cs.committed, t0.committed), "the restore waits in the preview").toEqual([]);
			expect(o.backingRestored, "still owed").toBe(true);
			// The lift. Its commit is refused, so the settle runs no resize pass of its own.
			o.canvasMode = true;
			o.pinchRefScale = 1;
			o.pinchAnchor = null;
			o.scaleGeometryValid = false;
			const committed: unknown[] = [];
			o.applyPinchScale = (next: number) => {
				committed.push(proto.commitCameraScale!.call(o, next));
			};
			(proto.pinch as (...a: unknown[]) => void).call(o, "end", 1, { x: Number.NaN, y: Number.NaN });
			expect(committed, "precondition: the lift's commit was refused").toEqual([false]);
			expect(o.pinchPreview, "the preview ended").toBe(false);
			rig.deliverPaintCallbacks();
			rig.deliverPaintCallbacks();
			expect(after(cs.committed, t0.committed), "the arm once after the preview, the committed transform set").toEqual([SCALE_2]);
			expect(after(cs.highlight, t0.highlight)).toEqual([SCALE_2]);
			expect(o.backingRestored, "the restore is done").toBe(false);
		});
	});
});

/** What a constructed overlay starts with that the kept pictures' code reads and the rig leaves unset. */
function picturesReady(o: Fields): void {
	o.pinchRefScale = null;
	o.lastScrollAskAt = Number.NEGATIVE_INFINITY;
	o.standInSnapshots ??= 0;
	o.standInRetryTimer ??= 0;
}

/** Every canvas the rig made, the detached ones included: a GPU reset gives them all back blank. */
function restoreAll(cs: SizedCanvases): void {
	const owned = [cs.committed, cs.highlight, cs.highlightWet, cs.wet, cs.wetTile, cs.tail, cs.attachedPen, cs.attachedHl];
	for (const c of [...owned, ...cs.clones, ...cs.tiles]) c?.restore();
}

/** A clock that moves 10 ms at each read, so a piece of a build draws one stroke and stops. */
function movingClock(): { mockRestore(): void } {
	let t = 50_000;
	return vi.spyOn(performance, "now").mockImplementation(() => (t += 10));
}

describe("the pictures kept on detached canvases, after the canvases are given back blank", () => {
	/** The whole paint drew every pen stroke by path at the backing scale, and copied nothing onto the committed layer. */
	function byPath(cs: SizedCanvases, d0: number, i0: number): void {
		expect(cs.committed.images.slice(i0), "nothing copied onto the committed layer").toEqual([]);
		expect(cs.committed.drawScales.slice(d0), "each stroke drawn by path at the backing scale").toEqual([2, 2, 2]);
	}
	const marks = (cs: SizedCanvases) => ({ d0: cs.committed.drawScales.length, i0: cs.committed.images.length });

	it("no stand-in is copied from the blank layers, and the whole paint draws by path", async () => {
		// Defect: the arm takes its stand-in as a zoom's does, a copy of the layer the browser just blanked, and the frame shows
		// that copy: the ink stays blank.
		const { rig, o, cs } = await open({ penOnly: true });
		picturesReady(o);
		const s0 = o.standInSnapshots;
		const { d0, i0 } = marks(cs);
		cs.committed.restore();
		rig.deliverPaintCallbacks();
		expect(o.standIn ?? null, "no stand-in held").toBeNull();
		expect(o.standInSnapshots, "none taken").toBe(s0);
		byPath(cs, d0, i0);
	});

	it("a stand-in held when the canvases are given back is let go, and the whole paint draws by path", async () => {
		// Defect: the stand-in a zoom left, a picture on a canvas of its own and blank after the reset too, is kept and copied in.
		const { rig, o, cs } = await open({ penOnly: true });
		picturesReady(o);
		(proto.takeStandIn as (dpr: number, backing: number) => void).call(o, o.dpr as number, o.committedBacking as number);
		const st = o.standIn as { pen: HTMLCanvasElement } | null | undefined;
		expect(st, "precondition: a stand-in is held").toBeTruthy();
		const { d0, i0 } = marks(cs);
		restoreAll(cs);
		rig.deliverPaintCallbacks();
		expect(o.standIn ?? null, "let go").toBeNull();
		expect([st!.pen.width, st!.pen.height], "its canvas freed").toEqual([0, 0]);
		byPath(cs, d0, i0);
	});

	it("the extent raster is let go, a zoom preview showing it taken down first, and the whole paint draws by path", async () => {
		// Defect: the raster's copy is the whole paint's picture at this zoom, so a blank raster is copied over the layer.
		const { rig, o, cs } = await open({ penOnly: true });
		picturesReady(o);
		const path = (o.filePath as () => string)();
		const ink = (o.committedStrokes as (s: unknown) => unknown[])((o.freeStrokes as (p: string) => unknown)(path));
		const cam = { ...(o.lastPaintCam as { x: number; y: number; zoom: number }) };
		(proto.armExtentBuild as (...a: unknown[]) => void).call(o, cam, ink, committedFloorFor(o.committedBacking as number, o.dpr as number));
		for (let i = 0; i < 20 && o.extentBuild; i++) (proto.runExtentPiece as () => void).call(o);
		const ext = o.extentRaster as { pen: HTMLCanvasElement } | null | undefined;
		expect(ext, "precondition: the raster is whole").toBeTruthy();
		expect((proto.extentHolds as (...a: unknown[]) => boolean).call(o, ext, cam, ink), "precondition: it holds for the next paint").toBe(true);
		// A zoom preview shows it: taken down here, before its canvas goes.
		let widthAtTakeDown = -1;
		o.heldRaster = { src: { pen: ext!.pen } };
		o.takeDownHeldRaster = () => {
			widthAtTakeDown = ext!.pen.width;
			o.heldRaster = null;
		};
		o.landHeldRaster = () => undefined;
		const { d0, i0 } = marks(cs);
		restoreAll(cs);
		rig.deliverPaintCallbacks();
		expect(o.extentRaster ?? null, "let go").toBeNull();
		expect([ext!.pen.width, ext!.pen.height], "its canvas freed").toEqual([0, 0]);
		expect(widthAtTakeDown, "the preview took it down before its canvas was freed").toBeGreaterThan(0);
		byPath(cs, d0, i0);
	});

	it("an extent build in flight is let go: its pieces were drawing on a canvas given back blank", async () => {
		// Defect: the build goes on from where it was and hands over a raster missing every stroke drawn before the reset.
		const { rig, o, cs } = await open({ penOnly: true });
		picturesReady(o);
		const path = (o.filePath as () => string)();
		const ink = (o.committedStrokes as (s: unknown) => unknown[])((o.freeStrokes as (p: string) => unknown)(path));
		const cam = { ...(o.lastPaintCam as { x: number; y: number; zoom: number }) };
		(proto.armExtentBuild as (...a: unknown[]) => void).call(o, cam, ink, committedFloorFor(o.committedBacking as number, o.dpr as number));
		const clock = movingClock();
		(proto.runExtentPiece as () => void).call(o);
		clock.mockRestore();
		const b = o.extentBuild as { pen: HTMLCanvasElement | null; next: number; count: number } | null | undefined;
		expect(b?.pen, "precondition: a build in flight holds its canvas").toBeTruthy();
		expect(b!.next, "precondition: not whole yet").toBeLessThan(b!.count);
		const { d0, i0 } = marks(cs);
		restoreAll(cs);
		rig.deliverPaintCallbacks();
		expect(o.extentBuild ?? null, "let go").not.toBe(b);
		expect([b!.pen!.width, b!.pen!.height], "its canvas freed").toEqual([0, 0]);
		byPath(cs, d0, i0);
	});

	it("the overview picture is let go, and the whole paint draws by path", async () => {
		// Defect: the picture a zoom out holds up is blank after the reset and is kept, since it still holds the note's strokes.
		const { rig, o, cs } = await open({ penOnly: true });
		picturesReady(o);
		const path = (o.filePath as () => string)();
		const ink = (o.committedStrokes as (s: unknown) => unknown[])((o.freeStrokes as (p: string) => unknown)(path));
		const cam = { ...(o.lastPaintCam as { x: number; y: number; zoom: number }) };
		(proto.armOverviewBuild as (...a: unknown[]) => void).call(o, cam, ink);
		for (let i = 0; i < 20 && !o.overview; i++) (proto.runOverviewPiece as () => void).call(o);
		const ov = o.overview as { pen: HTMLCanvasElement } | null | undefined;
		expect(ov, "precondition: the overview is whole").toBeTruthy();
		const { d0, i0 } = marks(cs);
		restoreAll(cs);
		rig.deliverPaintCallbacks();
		expect(o.overview ?? null, "let go").not.toBe(ov);
		expect([ov!.pen.width, ov!.pen.height], "its canvas freed").toEqual([0, 0]);
		byPath(cs, d0, i0);
	});

	it("an overview build in flight is let go", async () => {
		// Defect: the build goes on and makes a picture missing every stroke drawn before the reset.
		const { rig, o, cs } = await open({ penOnly: true });
		picturesReady(o);
		const path = (o.filePath as () => string)();
		const ink = (o.committedStrokes as (s: unknown) => unknown[])((o.freeStrokes as (p: string) => unknown)(path));
		const cam = { ...(o.lastPaintCam as { x: number; y: number; zoom: number }) };
		(proto.armOverviewBuild as (...a: unknown[]) => void).call(o, cam, ink);
		const clock = movingClock();
		for (let i = 0; i < 5 && !(o.overviewBuild as { pen?: unknown } | null | undefined)?.pen; i++) (proto.runOverviewPiece as () => void).call(o);
		clock.mockRestore();
		const b = o.overviewBuild as { pen: HTMLCanvasElement | null; next: number; count: number } | null | undefined;
		expect(b?.pen, "precondition: a build in flight holds its canvas").toBeTruthy();
		expect(b!.next, "precondition: not whole yet").toBeLessThan(b!.count);
		const { d0, i0 } = marks(cs);
		restoreAll(cs);
		rig.deliverPaintCallbacks();
		expect(o.overviewBuild ?? null, "let go").not.toBe(b);
		expect([b!.pen!.width, b!.pen!.height], "its canvas freed").toEqual([0, 0]);
		byPath(cs, d0, i0);
	});

	for (const kind of ["space", "lasso"] as const) {
		it(`given back in ${kind === "space" ? "an insert space" : "a lasso"} drag: the next frame draws the moving ink again`, async () => {
			// Defect: the drag's picture, on a canvas of its own, is blank after the reset and is made again only when the camera,
			// the backing or the tail's size moves, so the moving ink is gone until the release.
			// The insert space picture builds each stroke as a Path2D; the test runtime has none.
			if (typeof (globalThis as { Path2D?: unknown }).Path2D === "undefined") vi.stubGlobal("Path2D", class { moveTo(): void {} lineTo(): void {} });
			const { rig, o, cs } = await open({ penOnly: true });
			const path = (o.filePath as () => string)();
			const here = (o.freeStrokes as (p: string) => InkStroke[])(path);
			const moving = here[0]!;
			if (kind === "space") {
				o.spaceBounds = { ...moving.bbox };
				o.spacePreview = { staying: [] };
				o.spaceIds = [moving.id];
				o.spaceTotalDy = 6;
			} else {
				o.dragBox = { box: { ...moving.bbox }, size: 0 };
				o.dragIds = [moving.id];
				o.dragTotal = { dx: 6, dy: 6 };
			}
			(o.view as { scrollDOM: Fields }).scrollDOM.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 });
			const begun = (proto[kind === "space" ? "beginSpaceSnapshot" : "beginLassoSnapshot"] as (h: unknown) => boolean).call(o, here);
			expect(begun, "precondition: the drag took its snapshot").toBe(true);
			const snap = o.spaceSnapshot as { canvas: HTMLCanvasElement | null };
			const cam = (o.camera as { snapshot: unknown }).snapshot;
			// One drag frame's picture: the tail at its full surface, as the selection frame keeps it, then the picture drawn on it.
			const frame = (): void => {
				(o.tail as TailRenderer).restoreFullSurface();
				(proto.drawSpacePicture as (s: unknown, c: unknown) => void).call(o, snap, cam);
			};
			frame();
			const pic = snap.canvas;
			expect(cs.clones.find((c) => c.el === pic)?.painted, "precondition: the picture holds the moving ink").toBe(true);
			restoreAll(cs);
			rig.deliverPaintCallbacks();
			expect(o.spaceSnapshot, "the drag's snapshot stays").toBe(snap);
			const i0 = cs.tail.images.length;
			frame();
			const shown = cs.tail.images.slice(i0).map((src) => cs.clones.find((c) => c.el === src));
			expect(shown.length, "the frame drew the picture").toBeGreaterThan(0);
			expect(shown.every((c) => c?.painted === true), "the picture the tail shows holds the moving ink").toBe(true);
			expect([pic!.width, pic!.height], "the blank picture was freed").toEqual([0, 0]);
		});
	}
});

describe("the attached layer after its canvases are given back blank", () => {
	const SIZE = { backingW: 800, backingH: 600, backing: 2, cssW: 400, cssH: 300 };
	const CAM = { x: 0, y: 0, zoom: 1 };
	function strokeAt(id: string, x: number, y: number): InkStroke {
		const points = [0, 1, 2, 3].map((i) => ({ x: x + i * 4, y: y + (i % 2) * 2, pressure: 0.5, t: i }));
		return { id, tool: "pen", color: "#111", width: 1, points, bbox: computeBBox(points, 2), createdAt: 1 };
	}
	const group = (members: InkStroke[], dy = 0): AttachedGroup => ({ id: "att-1", members, offset: { dx: 0, dy }, shown: () => members });

	it("every tile of a showing group is drawn again, and a rect paint after the whole one clears at the backing scale", async () => {
		// Defect: the sprite is reused with its tiles blank (no clearSprites); or the layer keeps its backing size, so no
		// allocate sets the standing scale and a rect paint clears and clips at scale 1 (the whole paint's own transform is
		// undone by its restore).
		const clones: FakeCanvas[] = [];
		const tiles: FakeCanvas[] = [];
		const pen = fakeCanvas(clones), hl = fakeCanvas(clones);
		const layer = new AttachedLayer(pen.el, hl.el, () => {
			const t = fakeCanvas(clones);
			tiles.push(t);
			return t.el;
		});
		const members = [strokeAt("s1", 40, 40), strokeAt("s2", 60, 44)];
		layer.paint(CAM, [group(members)], true, undefined, SIZE);
		const built = tiles.length;
		expect(built, "precondition: the group has a sprite with tiles").toBeGreaterThan(0);
		expect(tiles.every((t) => t.painted)).toBe(true);
		// The browser gives every canvas back blank, the tiles included; the arm tells the layer.
		for (const c of [pen, hl, ...tiles]) c.restore();
		layer.invalidate("layout");
		(layer as unknown as { canvasesRestored?: () => void }).canvasesRestored?.();
		layer.paint(CAM, [group(members)], false, undefined, SIZE);
		expect(layer.counts.tilesLastPaint, "tiles drawn again by the whole paint").toBe(built);
		const live = tiles.slice(-built);
		expect(live.every((t) => t.painted), "every tile the sprite copies holds ink").toBe(true);
		const c0 = pen.clearScales.length;
		layer.moved([{ x: 30, y: 30, width: 60, height: 60 }]);
		layer.paint(CAM, [group(members, 0.5)], false, undefined, SIZE);
		const rectClears = pen.clearScales.slice(c0);
		expect(rectClears.length, "precondition: the rect paint cleared its rect").toBeGreaterThan(0);
		expect(rectClears.every((a) => a === 2), `rect paint clears at scale ${rectClears.join(",")}`).toBe(true);
	});
});
