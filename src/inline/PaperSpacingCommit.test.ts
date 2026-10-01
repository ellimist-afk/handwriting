/**
 * The paper through the real camera. The host's CSS zoom scales the paper with
 * the note, so a pinch's preview frames write no paper property and no commit
 * moves the pitch; the text size and the note origin are what re-plan pitch and
 * phase. The zoom reaches two things, at a commit: the thickness of rules and
 * dots, so they stay at least one device px, and the phase's device px grid,
 * which moves it at most half a device px. Drives the real `pinch` and `commitCameraScale` on the
 * prototype rig ZoomFloorLock.test.ts uses; only the DOM, frame clock and
 * layout sinks are stubbed, and the host's style records every write of the
 * three paper properties with the phase of the gesture it happened in. The
 * render suite reads the same on the real engine.
 */
import { describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";
import { MIN_PINCH_SCALE } from "./PinchScale";

/** The phase PaperPlan plans for an origin at `d` device px per layout px, as the property string: on the device px grid, then to 1/64 px, mod 28. */
const phaseAt = (origin: number, d: number): string => { const w = Math.round((Math.round(((origin % 28) + 28) % 28 * d) / d) * 64) / 64; return `${w >= 28 ? 0 : w}px`; };

type Phase = "start" | "move" | "end";
type Fields = Record<string, unknown>;
type Write = { name: string; value: string; during: string; frame: number };

const PAPER = ["--handwriting-paper-pitch", "--handwriting-paper-rule", "--handwriting-paper-dot", "--handwriting-paper-phase"];
const THICKNESS = ["--handwriting-paper-rule", "--handwriting-paper-dot"];

interface OverlayMethods {
	pinch(phase: Phase, ratio: number, centroid: { x: number; y: number }): void;
	commitCameraScale(next: number, scroll?: { left: number; top: number }): boolean;
	updatePaperSpacing(): void;
	capturePaperOrigin(originInScroller: number): void;
}
const methods = InkOverlayPlugin.prototype as unknown as OverlayMethods;

function sweep(from: number, to: number, steps: number): number[] {
	return Array.from({ length: steps + 1 }, (_, i) => from * (to / from) ** (i / steps));
}

function makeRig(external = 1, dpr = 1) {
	let nextFrame = 1, frame = 0, during = "setup";
	const frames = new Map<number, FrameRequestCallback>();
	const win = {
		requestAnimationFrame: vi.fn((callback: FrameRequestCallback): number => { const id = nextFrame++; frames.set(id, callback); return id; }),
		cancelAnimationFrame: vi.fn((id: number): void => { frames.delete(id); }),
		setTimeout: vi.fn((): number => 0),
		clearTimeout: vi.fn(),
	};
	const styles: Record<string, string> = {};
	const priorities: Record<string, string> = {};
	const writes: Write[] = [];
	const host = {
		clientWidth: 640, clientHeight: 480,
		isConnected: true,
		ownerDocument: { defaultView: win },
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
		style: {
			getPropertyValue: (name: string): string => styles[name] ?? "",
			getPropertyPriority: (name: string): string => priorities[name] ?? "",
			setProperty: (name: string, value: string, priority = ""): void => { styles[name] = value; priorities[name] = priority; if (PAPER.includes(name)) writes.push({ name, value, during, frame }); },
			removeProperty: (name: string): void => { delete styles[name]; delete priorities[name]; },
		},
		setCssStyles: (s: Record<string, string>): void => { Object.assign(styles, s); },
	};
	const scroller = { scrollLeft: 0, scrollTop: 0, scrollWidth: 64000, scrollHeight: 48000, clientTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }) };

	const overlay = Object.create(InkOverlayPlugin.prototype) as Fields;
	overlay.view = { dom: host, scrollDOM: scroller, contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }), children: [] as unknown[] }, requestMeasure: vi.fn(), measure: vi.fn() };
	overlay.container = { setCssStyles: vi.fn() };
	overlay.frame = { locked: false };
	// THIS RIG'S SUBJECT IS ZOOM MECHANICS, so its note is a CANVAS note. With the canvas off a
	// two-finger gesture is not a zoom at all (`pinch` returns on its first line), and a fixture left in
	// that mode would run none of the code these arms are about while still reporting a result - measured,
	// the mode gate alone turned several of them green by doing nothing. `canvasMode` is a class field and
	// `Object.create` runs no field initializers, so it is set here rather than assumed.
	overlay.canvasMode = true;
	overlay.cssScale = external; overlay.fontZoom = 1; overlay.scale = external;
	overlay.pinchScaleNow = 1;
	overlay.zoomFloor = MIN_PINCH_SCALE;
	overlay.pinchRasterScale = 1;
	overlay.pinchRefScale = null;
	overlay.pinchStartPan = { x: 0, y: 0 };
	overlay.pinchBand = { history: [] as number[], lastPan: { x: 0, y: 0 } };
	overlay.pinchAnchor = null;
	overlay.pinchPending = null;
	overlay.pinchRaf = 0;
	overlay.pinchScrollAt = 0;
	overlay.pinchHiddenCanvases = new Map();
	overlay.viewportGeneration = 0;
	overlay.retiring = false;
	overlay.panAnchorHold = null;
	overlay.scrollExpansion = null;
	overlay.dpr = dpr;
	// Object.create reaches methods, not class fields: production initialises these.
	overlay.paperOriginLayout = null;
	overlay.paperFontPx = 16;
	overlay.paperWritten = new Map<string, string>();
	overlay.getNoteViewportState = () => ({ zoom: overlay.pinchScaleNow, busy: false, fitAvailable: true });
	overlay.prepareViewportLayout = () => true;
	overlay.viewportLayout = { width: 640, height: 480, baseTransform: "none", externalScale: external };
	overlay.filePath = () => "note.md";
	overlay.panX = () => 0;
	overlay.panY = () => 0;
	for (const name of ["restorePinchLayers", "retirePanSettle", "releaseMeasures", "clearViewportPan", "refreshPenCursor", "updateExtent", "reanchorPan", "scheduleRepaint", "handleResize"]) overlay[name] = vi.fn();
	overlay.applyViewportBox = (next: number) => host.setCssStyles({ transform: `scale(${next})`, transformOrigin: "0 0" });
	overlay.setViewportScroll = (left: number, top: number) => { scroller.scrollLeft = left; scroller.scrollTop = top; };
	overlay.syncBand = () => "none";
	overlay.firstSettleConsumer = () => false;

	const centroid = { x: 320, y: 240 };
	const scale = (): number => overlay.pinchScaleNow as number;
	const runFrame = (): void => {
		const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
		if (!entry) throw new Error("expected one requested animation frame");
		frames.delete(entry[0]);
		frame++;
		entry[1](0);
	};
	const pinch = (phase: Phase, ratio: number): void => methods.pinch.call(overlay, phase, ratio, centroid);
	/** One gesture through the listed scales, one painted frame per move, then lift. */
	const moveThrough = (targets: number[]): number => {
		const from = scale();
		pinch("start", 1);
		let ratio = 1;
		during = "preview";
		for (const target of targets) { ratio = target / from; pinch("move", ratio); if (frames.size > 0) runFrame(); }
		during = "commit";
		pinch("end", ratio);
		during = "after";
		expect(frames.size, "a frame survived the lift").toBe(0);
		return scale();
	};
	const commit = (next: number): boolean => {
		during = "commit";
		const ok = methods.commitCameraScale.call(overlay, next, { left: 0, top: 0 });
		during = "after";
		return ok;
	};
	/** The plan at rest, as the refresh path and updateExtent leave it before any gesture. */
	const planAtRest = (origin: number): void => {
		during = "rest";
		methods.capturePaperOrigin.call(overlay, origin);
		during = "setup";
	};
	return { overlay, styles, priorities, writes, commit, moveThrough, planAtRest, scale };
}

describe("paper through the camera", () => {
	it.each([1, 0.8])("a commit keeps the pitch, puts the phase on the new zoom's device px grid, and re-plans rule and dot thickness at the intended zoom (external scale %s)", external => {
		const rig = makeRig(external);
		rig.planAtRest(10.3);
		const rest = external === 1 ? "1px" : "1.26953125px";
		expect(PAPER.map(name => rig.styles[name]), "premise: the paper was planned at rest").toEqual(["28px", rest, "1px", phaseAt(10.3, external)]);
		for (const next of [0.5, 0.25, 0.1, 0.37, 1.3, 1]) {
			rig.writes.length = 0;
			expect(rig.commit(next), `commit ${next}`).toBe(true);
			const rule = `${external * next >= 1 ? 1 : (1 + 1 / 64) / (external * next)}px`, dot = `${Math.max(1, Math.SQRT1_2 / (external * next))}px`;
			expect(rig.styles["--handwriting-paper-rule"], `rule after the commit at ${next}`).toBe(rule);
			expect(rig.styles["--handwriting-paper-dot"], `dot radius after the commit at ${next}`).toBe(dot);
			expect([rig.styles["--handwriting-paper-pitch"], rig.styles["--handwriting-paper-phase"]], `pitch and phase after the commit at ${next}`).toEqual(["28px", phaseAt(10.3, external * next)]);
			expect(rig.writes.every(w => THICKNESS.includes(w.name) || w.name === "--handwriting-paper-phase"), `only thickness and the phase were written at the commit to ${next}: ${JSON.stringify(rig.writes)}`).toBe(true);
		}
	});

	it("writes rule and dot thickness at a commit only where the floor changes them: at 20 percent on dpr 2, not at 100 percent, and not again at the same zoom", () => {
		const rig = makeRig(1, 2);
		rig.planAtRest(10.3);
		rig.writes.length = 0;
		expect(rig.commit(1), "commit 1").toBe(true);
		expect(rig.writes, "a commit at 100 percent on dpr 2: the literal 1 px rule already covers two device px").toEqual([]);
		expect(rig.commit(0.2), "commit 0.2").toBe(true);
		expect(rig.writes.map(w => `${w.name}=${w.value}`), "a commit at 20 percent on dpr 2: the rule floors at 1 + 1/64 device px, the dot at sqrt(2)/2, and the phase goes onto the new grid").toEqual(["--handwriting-paper-rule=2.5390625px", `--handwriting-paper-dot=${Math.SQRT1_2 / 0.4}px`, `--handwriting-paper-phase=${phaseAt(10.3, 0.4)}`]);
		rig.writes.length = 0;
		expect(rig.commit(0.2), "commit 0.2 again").toBe(true);
		expect(rig.writes, "a second commit at the same zoom").toEqual([]);
	});

	it("a preview writes no paper property on any frame of any sweep, and its commit keeps the pitch and puts the phase on the new grid", () => {
		const cases: Array<[number, number[]]> = [
			[1, sweep(1, 0.1, 60).slice(1)],
			[0.3, sweep(0.3, 0.2, 20).slice(1)],
			[0.9, sweep(0.9, 0.85, 10).slice(1)],
			[0.2, sweep(0.2, 2, 40).slice(1)],
		];
		for (const [start, targets] of cases) {
			const rig = makeRig();
			rig.planAtRest(10.3);
			expect(rig.commit(start), `commit ${start}`).toBe(true);
			rig.writes.length = 0;
			expect(rig.moveThrough(targets), `gesture from ${start}`).toBeCloseTo(targets.at(-1)!, 9);
			expect(rig.writes.filter(w => w.during === "preview"), `paper writes on the preview frames from ${start}`).toEqual([]);
			expect(rig.writes.filter(w => w.name === "--handwriting-paper-pitch"), `pitch writes anywhere in the gesture from ${start}`).toEqual([]);
			const phaseWrites = rig.writes.filter(w => w.name === "--handwriting-paper-phase");
			expect(phaseWrites.every(w => w.during === "commit"), `phase writes only at the commit from ${start}: ${JSON.stringify(phaseWrites)}`).toBe(true);
			expect(rig.styles["--handwriting-paper-phase"], `the phase on the grid of the zoom the gesture from ${start} committed`).toBe(phaseAt(10.3, targets.at(-1)!));
		}
	});

	it("re-plans pitch and rule at the text's size, not the size the overlay mounted at", () => {
		const rig = makeRig();
		rig.planAtRest(10.3);
		rig.overlay.fontZoom = 1;
		rig.overlay.paperFontPx = 24;
		methods.updatePaperSpacing.call(rig.overlay);
		expect(rig.styles["--handwriting-paper-pitch"]).toBe("42px");
		expect(rig.styles["--handwriting-paper-rule"]).toBe("1.5px");
		expect(rig.styles["--handwriting-paper-phase"], "10.3 mod 42 on the device px grid at 100 percent").toBe("10px");
	});

	it("never replaces a paper value the host set itself, zoomed or at rest", () => {
		const rig = makeRig();
		rig.planAtRest(10.3);
		(rig.overlay.view as { dom: { style: { setProperty(n: string, v: string, p?: string): void } } }).dom.style.setProperty("--handwriting-paper-pitch", "31px", "important");
		rig.writes.length = 0;
		rig.overlay.paperFontPx = 24;
		methods.updatePaperSpacing.call(rig.overlay);
		expect(rig.commit(0.1), "commit 0.1").toBe(true);
		methods.updatePaperSpacing.call(rig.overlay);
		expect([rig.styles["--handwriting-paper-pitch"], rig.priorities["--handwriting-paper-pitch"]]).toEqual(["31px", "important"]);
		expect(rig.writes.map(w => `${w.name}=${w.value}`), "only the overlay's own properties were re-planned: thickness for the text, then for the floor at 10 percent").toEqual(["--handwriting-paper-rule=1.5px", "--handwriting-paper-dot=1.5px", "--handwriting-paper-rule=10.15625px", `--handwriting-paper-dot=${Math.SQRT1_2 / 0.1}px`]);
	});

	it("re-plans the phase only for an origin move of 1/32 screen px or more", () => {
		const rig = makeRig();
		rig.planAtRest(10.3);
		expect(rig.commit(0.1), "commit 0.1").toBe(true);
		rig.overlay.cssScale = 0.1;
		rig.writes.length = 0;
		// At 10 percent a sixth of a layout px is 1/60 screen px: a rect's rounding, not a move.
		for (const noise of [0.1, -0.15, 0.3, -0.3]) methods.capturePaperOrigin.call(rig.overlay, 10.3 + noise);
		expect(rig.writes, "phase writes for sub-1/32-screen-px origin reads").toEqual([]);
		methods.capturePaperOrigin.call(rig.overlay, 10.3 + 0.35);
		expect(rig.overlay.paperOriginLayout, "an origin that moved 0.035 screen px is taken").toBeCloseTo(10.65, 9);
		expect(rig.writes, "and its phase, on the 10 layout px grid of 10 percent, is the one already written").toEqual([]);
		methods.capturePaperOrigin.call(rig.overlay, 15.3);
		expect(rig.writes.map(w => `${w.name}=${w.value}`), "an origin past the next grid line re-plans the phase onto it").toEqual(["--handwriting-paper-phase=20px"]);
	});
});
