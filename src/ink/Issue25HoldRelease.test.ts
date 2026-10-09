/**
 * Issue 25 device side-button choice and unchanged contact/tool controls.
 * The contact assertions use the real
 * router, contact intent, tool state, restoration, eraser chip and toolbar
 * rendering are not mocked. Canvas painting and an absent note are the same
 * unit boundary used by EraserModeSticks and InlineEraserSelection.
 */
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "../pdf/Sha256";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ISSUE25_FIXTURE } from "./Issue25HoldRelease.fixture";
import { InlinePenRouter, type InlinePenCallbacks } from "../inline/InlinePenRouter";
import {
  InkOverlayPlugin, getInlineTool, setInlineTool, getInkSizeMult, setInkSizeMult,
  getInlineEraserMode, getInlineLassoMode, getInlineSpaceMode, getInlinePanMode,
  getEraserWholeStrokes, setEraserWholeStrokes, getEraserRadiusPx, setEraserRadiusPx,
} from "../inline/InkOverlay";
import { tipMode, setTipMode, setSideButtonErases, sideButtonErasesEnabled } from "../inline/TipMode";
import { MobileTools, type MobileToolsHost } from "../inline/MobileTools";
import { Camera } from "../camera/Camera";
import { SelectionModel } from "../objects/SelectionModel";
import { StrokeFrame } from "../inline/StrokeFrame";
import { DEFAULT_PEN, HIGHLIGHTER_PEN } from "./PenStyle";
import type { PenSample } from "../input/PointerRouter";
import { diagnosticsEnabled, setDiagnosticsEnabled } from "../diag/DiagSwitch";
import { penInkEnabled, setPenInk } from "../inline/PenInk";
import { mouseInkEnabled, setMouseInk } from "../inline/MouseInk";
import {
  fakeEl, installFakeWindow, penEvent, winHandlers, rafCallbacks,
} from "../../test/routerHarness";

type InkTool = Parameters<typeof setInlineTool>[0];
interface Stimulus {
  type: string; timeStamp: number; advanceClockToMs: number;
  pointerType: string; pointerId: number; isPrimary?: boolean;
  button: number; buttons: number; pressure: number;
  clientX: number; clientY: number; deliverySite: "owned-element" | "window";
}
interface OverlayCalls {
  penDown(sample: PenSample, event: PointerEvent): void;
  penRaw(samples: PenSample[], event: PointerEvent): void;
  penUp(event?: PointerEvent): void;
  beforePenDown(): void;
  showPenCursor(sample: PenSample, pointerType?: string): void;
  hidePenCursor(): void;
  resumeStrandedPan(): boolean;
  clearSnapPreview(): void;
  mode: string;
  eraseWhole: boolean;
}
type Overlay = OverlayCalls & Record<string, unknown>;
const noop = (): void => {};
const priorPen = { inlineTool: "pen" as const, inkSizeMult: 1.5, tipMode: "nib" as const, toolbarTool: "pen" as const };
const reticle = { wholeStrokes: false, radiusPx: 23 };

/** DOM methods copied from the pinned MobileTools.test.ts fake, below. */
function toolbarHost(focus: (focused: boolean) => void): MobileToolsHost {
  return {
    exec: vi.fn(), activeTool: getInlineTool, setPlacement: noop,
    eraserOn: getInlineEraserMode, eraserWholeStroke: getEraserWholeStrokes,
    setEraserWholeStroke: setEraserWholeStrokes,
    lassoOn: getInlineLassoMode, spaceOn: getInlineSpaceMode, panOn: getInlinePanMode,
    toolColor: () => "#000000", eraserRadiusPx: getEraserRadiusPx,
    setEraserRadiusPx, inkSizeMult: () => getInkSizeMult(getInlineTool()),
    setInkSizeMult: (tool, mult) => {
      if (tool === "pen" || tool === "highlighter") setInkSizeMult(tool, mult);
    },
    canUndo: () => false, canRedo: () => false, canPasteInk: () => false,
    mouseInkOn: () => false, armMouseInkQuietly: noop, disarmMouseInkQuietly: noop,
    toast: noop, recordingOn: () => false, hasInkSelection: () => false,
    paletteFor: () => [], pickColor: noop, presetsFor: () => [], applyPreset: noop,
    starPreset: noop, forgetPreset: noop, setEditorFocus: focus,
    penInksHere: penInkEnabled, hasTouch: () => false,
  };
}

function withRig(
  prior: { inlineTool: InkTool; inkSizeMult: number },
  eraser: { wholeStrokes: boolean; radiusPx: number },
  run: (rig: ReturnType<typeof makeRig>) => void,
  erases = true,
): void {
  const saved = {
    tool: getInlineTool(), pen: getInkSizeMult("pen"), highlighter: getInkSizeMult("highlighter"),
    tip: tipMode(), whole: getEraserWholeStrokes(), radius: getEraserRadiusPx(),
    diagnostics: diagnosticsEnabled(), penInk: penInkEnabled(), sideButtonErases: sideButtonErasesEnabled(),
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(0);
  const undoWindow = installFakeWindow();
  let rig: ReturnType<typeof makeRig> | undefined;
  try {
    setSideButtonErases(erases);
    setDiagnosticsEnabled(false);
    setPenInk(true);
    setInlineTool(prior.inlineTool);
    setInkSizeMult(prior.inlineTool, prior.inkSizeMult);
    setTipMode("nib");
    setEraserWholeStrokes(eraser.wholeStrokes);
    setEraserRadiusPx(eraser.radiusPx);
    rig = makeRig();
    run(rig);
  } finally {
    try { rig?.dispose(); }
    finally {
      vi.clearAllTimers();
      rafCallbacks.clear();
      winHandlers.clear();
      undoWindow();
      vi.restoreAllMocks();
      vi.useRealTimers();
      setInlineTool(saved.tool);
      setInkSizeMult("pen", saved.pen);
      setInkSizeMult("highlighter", saved.highlighter);
      setTipMode(saved.tip);
      setEraserWholeStrokes(saved.whole);
      setEraserRadiusPx(saved.radius);
      setPenInk(saved.penInk);
      setDiagnosticsEnabled(saved.diagnostics);
      setSideButtonErases(saved.sideButtonErases);
    }
  }
}

function makeRig() {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const element = fakeEl();
  const editorFocus = vi.fn();
  const keyboardOpening = vi.fn();
  const captured: number[] = [], released: number[] = [], downs: number[] = [], ups: number[] = [];
  const raw: PenSample[] = [], hovered: PenSample[] = [], delivered: Stimulus[] = [];
  const contacts: Array<{ pointerId: number; mode: string }> = [];
  Object.assign(element, {
    setPointerCapture: (id: number) => { captured.push(id); },
    releasePointerCapture: (id: number) => { released.push(id); },
  });
  const doc = new FakeDoc();
  const pane = new FakeEl("div", doc);
  const eraserEl = new FakeEl("div", doc);
  const overlay = Object.create(InkOverlayPlugin.prototype) as Overlay;
  // Drawing surfaces only: contact handlers and state getters/setters stay real.
  const wet = {
    beginStroke: noop, appendPoint: noop, clearStroke: noop,
    contactHalfWidth: () => 1, liveHalfWidth: () => 1, liveWidthPx: () => 2,
    head: () => null, shape: false,
  };
  Object.assign(overlay, {
    mode: "ink", camera: new Camera(), scale: 1, cssScale: 1,
    selection: new SelectionModel(), lassoPts: [], lassoActive: false,
    dragFrom: null, dragTotal: null, spaceLineY: null, spaceIds: [],
    spaceBounds: null, spaceClient: null, panLast: null, spaceFromY: 0, spaceTotalDy: 0,
    hoverWatchdog: null, mouseStroke: false, frame: new StrokeFrame(),
    erased: [], erasePieces: new Set<string>(), eraseFrom: [], builder: null,
    viewportGeneration: 0, heldFontRef: null, leftReserveHeld: 0,
    viewportPan: { x: 0, y: 0 }, boundReadout: { floorX: 0, floorY: 0 },
    wheelZoomRun: { isLive: false }, noteZoomControls: null,
    penCursorEl: null, eraserEl, container: element,
    view: {
      dom: { ownerDocument: { defaultView: window } },
      hasFocus: true, focus: editorFocus, scrollDOM: element,
    },
    penStyle: { ...DEFAULT_PEN }, highlighterStyle: { ...HIGHLIGHTER_PEN },
    wet, highlightWet: wet, activeWet: wet,
    tail: { clear: noop, prepareLive: noop, drawHead: noop, draw: noop, resizeTotal: 0 },
    highlightWetCanvas: { setCssStyles: noop }, cssWidth: 800, cssHeight: 600,
    ensurePenTools: noop, syncCamera: noop, recordPenDownState: noop,
    redrawSelectionUI: noop, updateExtent: noop, sayIfPageEmpty: noop,
    startFrameTicker: noop, stopFrameTicker: noop,
    allocateWet: noop, allocateHighlightPair: noop, dressTail: noop,
    cancelOverscrollBounce: noop, restorePinchLayers: noop, rasterPanNeedsBake: () => false,
    filePath: () => null,
  });
  const host = toolbarHost(keyboardOpening);
  const tools = new MobileTools(pane as unknown as HTMLElement, host);
  overlay.mobileTools = tools;
  const callbacks: InlinePenCallbacks = {
    onBeforePenDown: () => overlay.beforePenDown(),
    onPenDown: (sample, event) => {
      downs.push(event.pointerId);
      overlay.penDown(sample, event);
      contacts.push({ pointerId: event.pointerId, mode: overlay.mode });
    },
    onPenRaw: (samples, event) => { raw.push(...samples); overlay.penRaw(samples, event); },
    onPenMove: noop,
    onPenUp: event => { if (event) ups.push(event.pointerId); overlay.penUp(event); },
    onPenHover: (sample, pointerType) => { hovered.push(sample); overlay.showPenCursor(sample, pointerType); },
    onPenLeave: () => overlay.hidePenCursor(),
    onHandOnGlass: () => overlay.hidePenCursor(),
    onPinch: noop,
    onAllContactsLifted: () => { overlay.resumeStrandedPan(); },
    penOff: () => !penInkEnabled(),
    fingerInk: () => false,
  };
  const router = new InlinePenRouter(element as unknown as HTMLElement, element as unknown as HTMLElement, callbacks);
  overlay.router = router;
  function refreshToolbar(): void { tools.refresh(); doc.flushFrames(); }
  function toolbar(): string[] {
    refreshToolbar();
    return ["Pen", "Highlighter", "Eraser", "Lasso", "Insert space", "Pan"]
      .filter(label => pane.findByTipLabel(label)?.classes.has("is-active"))
      .map(label => label.toLowerCase());
  }
  function deliver(input: Stimulus): void {
    expect(input.advanceClockToMs, "clock must never run backwards").toBeGreaterThanOrEqual(clock);
    const elapsed = input.advanceClockToMs - clock;
    clock = input.advanceClockToMs;
    vi.advanceTimersByTime(elapsed);
    const event = penEvent(input.type, input.timeStamp, {
      pointerId: input.pointerId, pointerType: input.pointerType,
      isPrimary: input.isPrimary, x: input.clientX, y: input.clientY,
      pressure: input.pressure, buttons: input.buttons,
    });
    // penEvent has no button option; also retain absent captured isPrimary.
    Object.assign(event, { button: input.button, isPrimary: input.isPrimary,
      target: element, composedPath: () => [element, window] });
    if (input.type === "pointerleave") Object.assign(event, { relatedTarget: null });
    for (const field of ["type", "timeStamp", "pointerId", "pointerType", "isPrimary", "button", "buttons", "pressure", "clientX", "clientY"] as const) {
      expect(event[field], `event fidelity ${field}`).toBe(input[field]);
    }
    const handler = input.deliverySite === "owned-element" ? element.handlers.get(input.type) : winHandlers.get(input.type);
    expect(handler, `registered ${input.deliverySite} ${input.type}`).toBeTypeOf("function");
    delivered.push({ ...input });
    handler!(event);
    refreshToolbar();
  }
  return {
    overlay, router, eraserEl, editorFocus, keyboardOpening, captured, released,
    downs, ups, raw, hovered, delivered, contacts, deliver, toolbar,
    dispose(): void {
      try { router.dispose(); }
      finally { tools.destroy(); overlay.clearSnapPreview(); doc.frames.length = 0; doc.listeners.clear(); }
    },
  };
}

function assertState(rig: ReturnType<typeof makeRig>, expected: {
  inlineTool: InkTool; inkSizeMult: number; tipMode: string; toolbarTool: string;
  contactIntent?: string; eraseWhole?: boolean; eraserRadiusPx?: number;
}): void {
  expect(getInlineTool(), "original nib retained").toBe(expected.inlineTool);
  expect(getInkSizeMult(expected.inlineTool), "original nib size retained").toBe(expected.inkSizeMult);
  expect(tipMode(), "contact preserves selected tip mode").toBe(expected.tipMode);
  expect(rig.toolbar(), "visible selected toolbar tool").toEqual([expected.toolbarTool]);
  if (expected.contactIntent !== undefined) expect(rig.overlay.mode, "actual contact intent").toBe(expected.contactIntent);
  if (expected.eraseWhole !== undefined) expect(rig.overlay.eraseWhole, "actual selected eraser chip").toBe(expected.eraseWhole);
  if (expected.eraserRadiusPx !== undefined) {
    expect(getEraserRadiusPx()).toBe(expected.eraserRadiusPx);
    expect(rig.eraserEl.style.width, "actual erase cursor diameter").toBe(`${2 * expected.eraserRadiusPx}px`);
    expect(rig.eraserEl.style.height).toBe(`${2 * expected.eraserRadiusPx}px`);
  }
}

describe("issue25 constructed hold and release routes", () => {
  it.each(ISSUE25_FIXTURE.holdCases)("$id", arm => {
    withRig(arm.prior, arm.eraser, rig => {
      for (const step of arm.steps) {
        const samplesBefore = rig.raw.length;
        rig.deliver(step.event);
        if ("contactDowns" in step) expect(rig.downs.length).toBe(step.contactDowns);
        if ("focusCalls" in step) {
          expect(rig.editorFocus).toHaveBeenCalledTimes(step.focusCalls);
          expect(rig.keyboardOpening).toHaveBeenCalledTimes(0);
        }
        if ("requireNonemptyAcceptedSamples" in step) expect(rig.raw.length).toBeGreaterThan(samplesBefore);
        assertState(rig, step.expected);
        if ("contactIntent" in step) expect(rig.overlay.mode).toBe(step.contactIntent);
      }
      expect(rig.delivered).toHaveLength(7);
      expect(rig.downs).toEqual([31, 31]);
      expect(rig.ups).toEqual([31, 31]);
      expect(rig.captured).toEqual([31, 31]);
      // Native up releases capture in the platform; endPenStroke does not call releasePointerCapture.
      expect(rig.released).toEqual([]);
      expect(rig.router.isStroking).toBe(false);
      assertState(rig, arm.prior);
    });
  });

  it.each(ISSUE25_FIXTURE.holdCases)("flag-off same events $id", arm => {
    withRig(arm.prior, arm.eraser, rig => {
      for (const step of arm.steps) {
        rig.deliver(step.event);
        assertState(rig, arm.prior);
        if (step.event.type === "pointerdown") {
          expect(rig.overlay.mode, "flag-off side button retains lasso").toBe(
            (step.event.buttons & 2) !== 0 ? "lasso" : "ink",
          );
        }
      }
      expect(rig.delivered).toHaveLength(7);
      expect(rig.downs).toEqual([31, 31]);
      expect(rig.ups).toEqual([31, 31]);
      expect(rig.captured).toEqual([31, 31]);
      expect(rig.router.isStroking).toBe(false);
    }, false);
  });

  it.each([true, false])("mouse right+left contact follows side-button setting %s", erases => {
    withRig(priorPen, reticle, rig => {
      const savedMouseInk = mouseInkEnabled();
      setMouseInk(true);
      try {
        const steps = ISSUE25_FIXTURE.holdCases[0].steps;
        const down = steps.find(step => step.event.type === "pointerdown")!.event;
        const up = steps.find(step => step.event.type === "pointerup")!.event;
        rig.deliver({ ...down, pointerType: "mouse", button: 0, buttons: 3 });
        expect(rig.downs, "mouse contact reaches real overlay").toEqual([down.pointerId]);
        expect(rig.overlay.mode, "mouse side/right button follows the setting").toBe(erases ? "erase" : "lasso");
        assertState(rig, priorPen);
        rig.deliver({ ...up, pointerType: "mouse", button: 0, buttons: 0 });
        expect(rig.ups).toEqual([up.pointerId]);
        expect(rig.router.isStroking).toBe(false);
        assertState(rig, priorPen);
      } finally {
        setMouseInk(savedMouseInk);
      }
    }, erases);
  });

  it.each(ISSUE25_FIXTURE.controls)("control $id", control => {
    withRig(priorPen, reticle, rig => {
      for (const event of control.events) {
        rig.deliver(event);
        if (event.type === "pointerdown" && event.pointerType === "pen") {
          const erase = control.id === "native-eraser" || control.id === "cancel-releases-hold" || control.id === "lost-capture-releases-hold";
          expect(rig.overlay.mode, `${control.id} real contact intent`).toBe(erase ? "erase" : "ink");
          if (erase) {
            expect(rig.overlay.eraseWhole).toBe(false);
            expect(rig.eraserEl.style.width).toBe("46px");
          }
          if (control.id === "cancel-releases-hold" || control.id === "lost-capture-releases-hold") {
            assertState(rig, priorPen);
          }
        }
        if (control.id === "pressed-hover-then-real-down" && event.type === "pointermove") {
          expect(rig.downs).toEqual([]);
          expect(rig.captured).toEqual([]);
          expect(rig.editorFocus).not.toHaveBeenCalled();
          expect(rig.keyboardOpening).not.toHaveBeenCalled();
        }
        if (control.id === "barrel-hover-only" || control.id === "touch-not-barrel") {
          assertState(rig, priorPen);
          expect(rig.downs).toEqual([]);
          expect(rig.captured).toEqual([]);
          expect(rig.editorFocus).not.toHaveBeenCalled();
          expect(rig.keyboardOpening).not.toHaveBeenCalled();
        }
      }
      const count = control.id === "barrel-hover-only" || control.id === "touch-not-barrel" ? 0 : 1;
      const id = control.id === "pressed-hover-then-real-down" ? 3 : 31;
      expect(rig.delivered.length).toBe(control.events.length);
      expect(rig.downs).toEqual(count ? [id] : []);
      expect(rig.ups).toEqual(count ? [id] : []);
      expect(rig.captured).toEqual(count ? [id] : []);
      // Native up/cancel/lost-capture ends ownership without requesting release again.
      expect(rig.released).toEqual([]);
      if (control.id === "barrel-hover-only") expect(rig.hovered.length).toBeGreaterThan(0);
      if (control.id === "ordinary-tip") expect(rig.raw.length).toBeGreaterThan(0);
      expect(rig.router.isStroking).toBe(false);
      assertState(rig, priorPen);
    });
  });
});

interface TraceRecord {
  line: number; timeMs: number; kind: string; pointerId: number | null;
  pointerType: string | null; buttons: number | null; button: number | null;
  pressure: number | null; x: number | null; y: number | null; body: string;
}
interface Ledger {
  traceEvents: TraceRecord[]; rawRows: Array<Record<string, unknown>>;
  traceMetadata: Array<{ line: number; text: string }>;
  [key: string]: unknown;
}
const ledgerText = readFileSync(fileURLToPath(new URL("./Issue25CaptureLedger.fixture.json", import.meta.url)), "utf8");
const ledgerSha = "6ff82191242fa5d4168394d24d86b5e08a6f16135e6499bc5c8ef3a1fc73e145";
const sealedLedger = JSON.parse(ledgerText) as Ledger;
function assertLedgerFidelity(candidate: Ledger): void {
  expect(Array.from(sha256(new TextEncoder().encode(ledgerText)), byte => byte.toString(16).padStart(2, "0")).join(""), "pinned complete ledger bytes").toBe(ledgerSha);
  expect(candidate.traceEvents).toHaveLength(253);
  expect(candidate.rawRows).toHaveLength(1678);
  for (const key of Object.keys(sealedLedger)) {
    const expected = sealedLedger[key];
    const actual = candidate[key];
    if (Array.isArray(expected)) {
      expect(Array.isArray(actual), `ledger ${key}`).toBe(true);
      expect(actual).toHaveLength(expected.length);
      expected.forEach((record: unknown, index: number) => {
        expect((actual as unknown[])[index], `${key}[${index}] all fields and original line provenance`).toEqual(record);
      });
    } else expect(actual, `ledger ${key}`).toEqual(expected);
  }
  expect(Object.keys(candidate).sort()).toEqual(Object.keys(sealedLedger).sort());
}

/** Only trace sites emitted by the pinned router's known registrations.
 * pen-hover/first-raw/suppressed are diagnostic annotations, not native inputs.
 * Raw R/P channels do not establish a target: retain every row, route none.
 * Captured primary status is absent; leave it undefined instead of inventing it.
 * timeMs is a recorded trace observation time, not a native event.timeStamp.
 * Replay uses it as a synthetic event timestamp and independent fake-clock
 * target. This does not recover a native timestamp, coalesced batch or target.
 */
const elementKinds = new Set(["pointerdown", "pointermove", "pointerrawupdate", "pointerup", "pointerleave", "gotpointercapture", "lostpointercapture"]);
function traceStimulus(row: TraceRecord): Stimulus | null {
  const windowRoute = (row.kind === "window-pointerdown" && row.body.includes("includes a Handwriting editor scroller")) ||
    (row.kind === "window-pointerup" && row.body.includes("scroller in path"));
  if ((!elementKinds.has(row.kind) && !windowRoute) || row.pointerType !== "pen") return null;
  if ([row.pointerId, row.buttons, row.button, row.pressure, row.x, row.y].some(v => v === null)) return null;
  return { type: windowRoute ? row.kind.slice("window-".length) : row.kind, timeStamp: row.timeMs, advanceClockToMs: row.timeMs,
    pointerType: row.pointerType, pointerId: row.pointerId!, button: row.button!,
    buttons: row.buttons!, pressure: row.pressure!, clientX: row.x!, clientY: row.y!,
    isPrimary: undefined, deliverySite: windowRoute ? "window" : "owned-element" };
}

describe("issue25 complete captured-ledger fidelity and bounded replay", () => {
  it("retains every record, unknown field, annotation and capture change before routing", () => {
    const retained = structuredClone(sealedLedger);
    assertLedgerFidelity(retained);
    const header = retained.traceMetadata.map(row => row.text).join("\n");
    expect(header).toMatch(/6 native event\(s\) suppressed/);
    expect(retained.traceEvents.filter(row => row.kind === "suppressed")).toHaveLength(2);
    expect(retained.rawRows.filter(row => row.kind === "contextmenu")).toHaveLength(3);
    // All 253 trace records and 1678 rows survive even when not routable.
    const ledgerBefore = JSON.stringify(retained);
    withRig(priorPen, reticle, rig => {
      let routed = 0;
      for (const row of retained.traceEvents) {
        const stimulus = traceStimulus(row);
        if (stimulus) { rig.deliver(stimulus); routed++; }
      }
      expect(routed).toBeGreaterThan(0);
      expect(rig.delivered).toHaveLength(routed);
      expect(rig.downs).toEqual([3]);
      expect(rig.ups).toEqual([3]);
      expect(rig.contacts).toEqual([{ pointerId: 3, mode: "ink" }]);
      expect(rig.delivered.filter(event => event.deliverySite === "window")).toHaveLength(2);
      expect(rig.delivered.filter(event => event.type === "gotpointercapture").map(event => event.pointerId)).toEqual([3]);
      expect(rig.delivered.filter(event => event.type === "lostpointercapture").map(event => event.pointerId)).toEqual([3]);
      expect(rig.captured).toEqual([3]);
      expect(rig.released).toEqual([]);
      expect(rig.raw.length).toBeGreaterThan(0);
      expect(rig.router.isStroking).toBe(false);
      assertState(rig, priorPen);
    });
    expect(JSON.stringify(retained)).toBe(ledgerBefore);
    assertLedgerFidelity(retained);
  });
});

// Reused verbatim: pinned MobileTools.test.ts lines 595-599 and 698-898.
interface ElOpts {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

class FakeDoc {
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	readonly frames: Array<() => void> = [];
	readonly defaultView = {
		requestAnimationFrame: (cb: () => void): number => {
			this.frames.push(cb);
			return this.frames.length;
		},
	};
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}
	removeEventListener(): void {}
	/** Fire a DOCUMENT-level handler: the strip releases a held slider here,
	 * because a drag very often ends with the pointer off the input. `type`
	 * is on the event because the drag's document-level end reads it to tell
	 * a lift from a cancel. */
	fire(type: string, ev: Record<string, unknown> = {}): void {
		const event = { type, preventDefault: (): void => {}, pointerType: "mouse", ...ev };
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}
	/** Run every frame callback `refresh()` queued, including any queued by one. */
	flushFrames(): void {
		for (let i = 0; i < 20 && this.frames.length > 0; i++) {
			const due = this.frames.splice(0, this.frames.length);
			for (const cb of due) cb();
		}
	}
}

class FakeEl {
	readonly children: FakeEl[] = [];
	readonly classes = new Set<string>();
	readonly attrs = new Map<string, string>();
	readonly dataset: Record<string, string> = {};
	readonly style: Record<string, string> = {};
	readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
	textContent = "";
	value = "";
	/** Mocks the DOM `hidden` property - not a class, so it needs its own
	 * field rather than riding `classes`. Nothing in `MobileTools.ts` writes
	 * it today: Delete selection, Lasso: copy selection and Lasso: paste dim
	 * instead of hiding (the owner's ruling after trying the hide on vault
	 * test 2, 2026-09-05 - see "the selection group dims rather than hides"
	 * below). Kept for whichever button first needs it. */
	hidden = false;
	/** Mocks the DOM `disabled` property, same reasoning as `hidden` above:
	 * the note-viewport buttons write it directly (`button.disabled = ...` in
	 * `refreshNow`), never through a class. */
	disabled = false;
	readonly offsetWidth = 0;
	readonly offsetLeft = 0;
	readonly classList = {
		add: (c: string): void => void this.classes.add(c),
		remove: (c: string): void => void this.classes.delete(c),
		contains: (c: string): boolean => this.classes.has(c),
		toggle: (c: string, on?: boolean): boolean => {
			const want = on ?? !this.classes.has(c);
			if (want) this.classes.add(c);
			else this.classes.delete(c);
			return want;
		},
	};

	constructor(
		readonly tag: string,
		readonly ownerDocument: FakeDoc,
		opts: ElOpts = {}
	) {
		for (const c of (opts.cls ?? "").split(" ").filter(Boolean)) this.classes.add(c);
		for (const [k, v] of Object.entries(opts.attr ?? {})) this.attrs.set(k, v);
		if (opts.text !== undefined) this.textContent = opts.text;
	}

	createEl(tag: string, opts: ElOpts = {}): FakeEl {
		const el = new FakeEl(tag, this.ownerDocument, opts);
		this.children.push(el);
		return el;
	}
	createDiv(opts: ElOpts = {}): FakeEl {
		return this.createEl("div", opts);
	}
	createSpan(opts: ElOpts = {}): FakeEl {
		return this.createEl("span", opts);
	}
	get firstChild(): FakeEl | null {
		return this.children[0] ?? null;
	}
	insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl {
		// DETACH FIRST, which the DOM does and this fake used to not:
		// `insertBefore` MOVES a node that is already a child rather than
		// adding a second copy of it. `MobileTools` builds the eraser's mode
		// chips with `createDiv` (which appends) and then insertBefore's them
		// to the front, so the eraser's pop read as chips, slider, chips here
		// and as chips, slider in a browser. Nothing asserted the pop's whole
		// shape before, so the extra child sat unnoticed.
		const had = this.children.indexOf(node);
		if (had >= 0) this.children.splice(had, 1);
		const at = ref ? this.children.indexOf(ref) : -1;
		if (at < 0) this.children.push(node);
		else this.children.splice(at, 0, node);
		return node;
	}
	empty(): void {
		this.children.length = 0;
		this.textContent = "";
	}
	remove(): void {}
	setText(t: string): void {
		this.children.length = 0;
		this.textContent = t;
	}
	setCssStyles(styles: Record<string, string>): void {
		Object.assign(this.style, styles);
	}
	/**
	 * Zeros by default: nothing here asserts on where an open pop is placed.
	 * SETTABLE since drag-to-anchor, because the drop rule is answered from
	 * boxes and a strip whose every edge is zero cannot express a drag at
	 * all - a test that wants a real pane, a real strip and a real actions
	 * row writes them here.
	 */
	rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
	getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
		return this.rect;
	}
	/**
	 * Pointer capture, recorded rather than performed. The strip takes it on
	 * the handle so the gesture keeps arriving once the finger leaves the
	 * 24px of grip it started on; there is no retargeting to model here, so
	 * what a test can read is that it was asked for and given back.
	 */
	captured: number | null = null;
	setPointerCapture(id: number): void {
		this.captured = id;
	}
	releasePointerCapture(id: number): void {
		if (this.captured === id) this.captured = null;
	}
	addClass(c: string): void {
		this.classes.add(c);
	}
	removeClass(c: string): void {
		this.classes.delete(c);
	}
	toggleClass(c: string, on: boolean): void {
		this.classList.toggle(c, on);
	}
	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}
	getAttribute(k: string): string | null {
		return this.attrs.get(k) ?? null;
	}
	removeAttribute(k: string): void {
		this.attrs.delete(k);
	}
	/** Tag ("svg") or one class (".handwriting-sr-only"); nothing else is used. */
	querySelector(sel: string): FakeEl | null {
		for (const kid of this.children) {
			const hit = sel.startsWith(".") ? kid.classes.has(sel.slice(1)) : kid.tag === sel;
			if (hit) return kid;
			const deep = kid.querySelector(sel);
			if (deep) return deep;
		}
		return null;
	}
	contains(node: unknown): boolean {
		if (node === this) return true;
		return this.children.some((kid) => kid.contains(node));
	}
	addEventListener(type: string, fn: (ev: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}
	removeEventListener(): void {}
	/** Fire the handlers the strip registered, the way a real click would. */
	fire(type: string, ev: Record<string, unknown> = {}): void {
		const event = {
			type,
			preventDefault: (): void => {},
			stopPropagation: (): void => {},
			pointerType: "mouse",
			target: this,
			...ev,
		};
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}
	/** The control carrying this label - ownName moves aria-label to dataset. */
	findByTipLabel(label: string): FakeEl | null {
		for (const kid of this.children) {
			if (kid.dataset.tipLabel === label) return kid;
			const deep = kid.findByTipLabel(label);
			if (deep) return deep;
		}
		return null;
	}
}
