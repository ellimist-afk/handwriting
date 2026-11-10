/**
 * The raster probe line in "Diagnostics: show zoom report": absent a zoom it says so, and with recording off it names
 * recording as the reason; with diagnostics on, one commit that
 * changes the scale arms the probe once, on idle, and the line carries its numbers; a refused commit, a same-scale
 * re-commit and any commit with diagnostics off never arm it.
 *
 * Drives the real `commitCameraScale` on a prototype rig (as ZoomFloorLock.test.ts); the DOM, the idle callback, the
 * canvases (Obsidian's global createEl) and the layout sinks are stubbed. The rig's draws cost nothing, so the numbers are zero; the line's shape and
 * its counts are the subject.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { window?: unknown }).window = globalThis;

import { InkOverlayPlugin } from "./InkOverlay";
import { copyInlineZoomReport, instances } from "./InkOverlayRegistry";
import { resetRasterProbe } from "./RasterProbe";
import { setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { MIN_PINCH_SCALE } from "./PinchScale";

type Fields = Record<string, unknown>;
const NOT_RUN = "raster probe: not run (zoom once first)";
const RECORDING_OFF = "raster probe: not run (recording is off: run 'Diagnostics: begin recording', then zoom)";
const RAN = /^raster probe: scaled \d+\.\d\d\/\d+\.\d\d ms k 1\.21, unscaled \d+\.\d\d\/\d+\.\d\d ms, reps 5, pane 1280x960 px, dpr 2$/;

function makeRig() {
	const idle: ((deadline: IdleDeadline) => void)[] = [];
	const draws: number[] = [];
	const contextOptions: unknown[] = [];
	const readbacks: number[] = [];
	const canvases: unknown[] = [];
	const canvas = () => {
		const ctx = {
			fillStyle: "", fillRect: () => {}, setTransform: vi.fn(),
			drawImage: () => { draws.push(1); }, getImageData: () => { readbacks.push(1); return { data: new Uint8ClampedArray(4) }; },
		};
		const el = { width: 0, height: 0, getContext: (_kind: string, options?: unknown) => { contextOptions.push(options); return ctx; } };
		canvases.push(el);
		return el;
	};
	const win = {
		requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn(),
		setTimeout: vi.fn((): number => 0), clearTimeout: vi.fn(),
		requestIdleCallback: vi.fn((cb: (deadline: IdleDeadline) => void) => { idle.push(cb); return idle.length; }),
		devicePixelRatio: 2,
		performance: { now: () => 0 },
	};
	vi.stubGlobal("createEl", () => canvas());
	const hostStyles: Record<string, string> = {};
	const host = {
		clientWidth: 640, clientHeight: 480,
		ownerDocument: { defaultView: win },
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
		style: {
			getPropertyValue(name: string): string { return hostStyles[name] ?? ""; },
			setProperty(name: string, value: string): void { hostStyles[name] = value; },
			removeProperty(name: string): void { delete hostStyles[name]; },
		},
		setCssStyles(styles: Record<string, string>): void { Object.assign(hostStyles, styles); },
	};
	const scroller = { scrollLeft: 0, scrollTop: 0, scrollWidth: 64000, scrollHeight: 48000, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }) };
	const overlay = Object.create(InkOverlayPlugin.prototype) as Fields;
	overlay.view = { dom: host, scrollDOM: scroller, contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0 }), children: [] as unknown[] }, posAtCoords: () => null, requestMeasure: vi.fn(), measure: vi.fn() };
	overlay.container = { setCssStyles: vi.fn() };
	overlay.frame = { locked: false };
	overlay.canvasMode = true;
	overlay.cssScale = 1; overlay.fontZoom = 1; overlay.scale = 1;
	overlay.pinchScaleNow = 1;
	overlay.zoomFloor = MIN_PINCH_SCALE;
	overlay.pinchRasterScale = 1;
	overlay.pinchRefScale = null;
	overlay.pinchHiddenCanvases = new Map();
	overlay.viewportGeneration = 0;
	overlay.retiring = false;
	overlay.panAnchorHold = null;
	overlay.scrollExpansion = null;
	overlay.prepareViewportLayout = () => true;
	overlay.viewportLayout = { width: 640, height: 480, baseTransform: "none" };
	overlay.filePath = () => "note.md";
	overlay.panX = () => 0;
	overlay.panY = () => 0;
	for (const name of ["restorePinchLayers", "retirePanSettle", "releaseMeasures", "clearViewportPan", "updatePaperSpacing", "refreshPenCursor", "updateExtent", "reanchorPan", "scheduleRepaint", "handleResize"]) overlay[name] = vi.fn();
	overlay.applyViewportBox = (next: number) => host.setCssStyles({ transform: `scale(${next})`, transformOrigin: "0 0" });
	overlay.setViewportScroll = (left: number, top: number) => { scroller.scrollLeft = left; scroller.scrollTop = top; };
	overlay.syncBand = () => "none";
	overlay.firstSettleConsumer = () => false;
	const commitCameraScale = (InkOverlayPlugin.prototype as unknown as { commitCameraScale(next: number, scroll?: { left: number; top: number }): boolean }).commitCameraScale;
	const commit = (next: number): boolean => commitCameraScale.call(overlay, next, { left: 0, top: 0 });
	/** One idle period with plenty of time left. */
	const runIdle = () => { const cb = idle.shift(); if (!cb) throw new Error("no idle callback queued"); cb({ didTimeout: false, timeRemaining: () => 40 }); };
	return { overlay, win, idle, draws, contextOptions, readbacks, canvases, commit, runIdle };
}

const fakeEditor = { zoomReport: () => "editor zoom report" } as unknown as InkOverlayPlugin;
function probeLine(): string | undefined {
	instances.add(fakeEditor);
	try {
		return copyInlineZoomReport().split("\n").find((line) => line.startsWith("raster probe:"));
	} finally {
		instances.delete(fakeEditor);
	}
}

// The probe arms only with diagnostics on: each cell runs with them on unless it says otherwise.
beforeEach(() => setDiagnosticsEnabled(true));
afterEach(() => {
	setDiagnosticsEnabled(false);
	resetRasterProbe();
	vi.unstubAllGlobals();
	instances.delete(fakeEditor);
});

describe("raster probe line in the zoom report", () => {
	it("says not run before any zoom, and carries the numbers after one commit that changed the scale", () => {
		const rig = makeRig();
		expect(probeLine()).toBe(NOT_RUN);
		expect(rig.commit(0.8), "premise: the commit went through").toBe(true);
		expect(rig.idle.length, "the commit queued the probe on idle").toBe(1);
		expect(probeLine(), "nothing measured before the idle period").toBe(NOT_RUN);
		rig.runIdle();
		expect(rig.draws.length, "five scaled and five unscaled draws").toBe(10);
		expect(probeLine()).toMatch(RAN);
	});

	it("sits right after the header, before the editor sections", () => {
		instances.add(fakeEditor);
		const lines = copyInlineZoomReport().split("\n");
		expect(lines[0]).toMatch(/^Handwriting zoom report: /);
		expect(lines[1]).toBe(NOT_RUN);
	});

	it("arms once per session: a second commit at a new scale queues nothing", () => {
		const rig = makeRig();
		rig.commit(0.8);
		rig.commit(0.6);
		expect(rig.idle.length).toBe(1);
	});

	it("once armed, a commit reads the pane size no more than before the probe: 4 reads over 2 commits, the refusal check's", () => {
		const rig = makeRig();
		rig.commit(0.8);
		const host = (rig.overlay.view as { dom: Record<string, unknown> }).dom;
		let reads = 0;
		Object.defineProperty(host, "clientWidth", { get: () => { reads++; return 640; } });
		Object.defineProperty(host, "clientHeight", { get: () => { reads++; return 480; } });
		expect(rig.commit(0.6), "premise: the first armed commit went through").toBe(true);
		expect(rig.commit(0.7), "premise: the second armed commit went through").toBe(true);
		expect(reads).toBe(4);
	});

	it("asks for no CPU canvas: no context is opened with willReadFrequently, and the draw still ends in its 1 px read", () => {
		const rig = makeRig();
		rig.commit(0.8);
		rig.runIdle();
		expect(rig.contextOptions.length, "premise: the probe opened its two contexts").toBe(2);
		expect(rig.contextOptions.filter((o) => (o as { willReadFrequently?: boolean } | undefined)?.willReadFrequently)).toEqual([]);
		expect(rig.readbacks.length, "one readback per draw").toBe(rig.draws.length);
	});

	it("a refused commit never arms it", () => {
		const rig = makeRig();
		(rig.overlay.frame as { locked: boolean }).locked = true;
		expect(rig.commit(0.8), "premise: the commit was refused").toBe(false);
		expect(rig.idle.length).toBe(0);
		expect(probeLine()).toBe(NOT_RUN);
	});

	it("a same-scale re-commit never arms it", () => {
		const rig = makeRig();
		expect(rig.commit(1), "premise: the re-commit went through").toBe(true);
		expect(rig.idle.length).toBe(0);
	});

	it("with diagnostics off, a zoom allocates no probe canvas and the line says it has not run", () => {
		// Defect: every device pays two pane-size canvases at its first zoom for a line only the diagnostics report shows.
		setDiagnosticsEnabled(false);
		const rig = makeRig();
		expect(rig.commit(0.8), "premise: the commit went through").toBe(true);
		while (rig.idle.length > 0) rig.runIdle();
		expect(rig.canvases.length, "probe canvases allocated").toBe(0);
		expect(probeLine()).toMatch(/^raster probe: not run \(/);
	});

	it("with recording off, a zoom leaves the line naming recording as the reason, not another zoom", () => {
		// Defect: the line said "zoom once first", but with recording off no zoom ever runs the probe.
		setDiagnosticsEnabled(false);
		const rig = makeRig();
		expect(rig.commit(0.8), "premise: the commit went through").toBe(true);
		while (rig.idle.length > 0) rig.runIdle();
		expect(probeLine()).toBe(RECORDING_OFF);
	});

	it("with recording on, a zoom keeps the line as before: not run until the idle period, then the numbers, kept after recording stops", () => {
		const rig = makeRig();
		expect(rig.commit(0.8), "premise: the commit went through").toBe(true);
		expect(probeLine(), "armed, not yet measured").toBe(NOT_RUN);
		rig.runIdle();
		expect(probeLine()).toMatch(RAN);
		setDiagnosticsEnabled(false);
		expect(probeLine(), "the numbers outlive the recording").toMatch(RAN);
	});

	it("stops when the idle period runs short", () => {
		const rig = makeRig();
		rig.commit(0.8);
		const cb = rig.idle.shift()!;
		let left = 25;
		cb({ didTimeout: false, timeRemaining: () => (left -= 5) });
		expect(rig.draws.length, "draws while more than 10 ms remain").toBeLessThan(10);
		expect(probeLine()).toMatch(/reps [0-4],/);
	});
});
