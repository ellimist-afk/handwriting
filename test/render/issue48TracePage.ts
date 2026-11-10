import type { EditorView } from "@codemirror/view";
import { inlineInk, overlayForPath, viewportScrollLifetime } from "../../src/inline/InkOverlay";
import { settleAnchorLines } from "../../src/inline/InkOverlayPinch";
import { settleLineApplied } from "../../src/inline/InkOverlayZoomApi";
import { frames, point } from "./issue48EmbedZoomPage";
// Trace rows for the issue 48 cell, 1.4.24 modules only: the settle-measure hold and the
// finger-line maps exist from 1.4.24 on. Reads only; every wrapper calls the original and is taken off before the return.
const path = "issue-48.md";
type Row = Record<string, unknown>;
function snapshot(o: any, view: EditorView): Row {
 const s = inlineInk.strokes(path).at(-1) as any, anchors = o.lineAnchorState as any;
 const canvas = o.committedCanvas as HTMLCanvasElement, rect = canvas.getBoundingClientRect();
 const ink = (window as any).issue48.read().ink;
 const a = s?.lineAnchor;
 return {
  scrollTop: view.scrollDOM.scrollTop, scrollHeight: view.scrollDOM.scrollHeight, clientHeight: view.scrollDOM.clientHeight,
  contentHeight: view.contentHeight, viewport: { from: view.viewport.from, to: view.viewport.to },
  panX: typeof o.panX === "function" ? o.panX() : null, panY: typeof o.panY === "function" ? o.panY() : null, cssScale: o.cssScale, scaleY: view.scaleY,
  bbox: s ? { ...s.bbox } : null,
  lineAnchor: a ? { line: a.line, top: a.top, y: a.y, dy: anchors?.dys?.get(s)?.dy ?? null } : "none",
  measuredPrefix: anchors?.measured ?? null,
  canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height, backingWidth: canvas.width, backingHeight: canvas.height },
  ink,
 };
}
async function trace(arm: "plus" | "pinch" | "fit", obsidian = false) {
 const api = (window as any).issue48;
 await api.setup(obsidian);
 const written = await api.write();
 const o = overlayForPath(path) as any, view = o.view as EditorView;
 const attempts: Row[] = [], warns: string[] = [], wrapped = new WeakSet<object>();
 const realWarn = console.warn, realRequest = view.requestMeasure, realCommit = o.commitCameraScale, commits: Row[] = [];
 // The hold and its preconditions at every commit, and who called.
 o.commitCameraScale = function (next: number, scroll?: unknown, settleHold?: unknown, ...rest: unknown[]) {
  const hold = this.panAnchorHold;
  const row: Row = { next, scroll: scroll ?? null, settleHold: settleHold === undefined ? "undefined" : settleHold === null ? null : "object",
   settleHoldIsPanAnchorHold: settleHold != null && settleHold === hold, panAnchorHold: hold ? { outcome: hold.outcome, toScale: hold.toScale } : null,
   panSizer: !!this.panSizer?.(), canvasMode: this.canvasMode, firstSettleConsumer: this.firstSettleConsumer?.() ?? null,
   stack: (new Error().stack ?? "").split("\n").slice(2, 7).map(s => s.trim()) };
  const result = realCommit.call(this, next, scroll, settleHold, ...rest);
  row.result = result; row.panAnchorHoldAfter = this.panAnchorHold ? { outcome: this.panAnchorHold.outcome } : null;
  commits.push(row);
  return result;
 };
 console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); return realWarn.apply(console, a as []); };
 (view as any).requestMeasure = function (req?: any) {
  if (req && req.key === o && typeof req.write === "function" && !wrapped.has(req)) {
   wrapped.add(req);
   const write = req.write;
   req.write = function (value: unknown, v: unknown) {
    const hold = viewportScrollLifetime(view).pending as any, kind = Array.isArray(value) ? "settle" : "generic";
    const fl = hold ? settleAnchorLines.get(hold) : undefined, appliedBefore = hold ? settleLineApplied.get(hold) ?? 0 : 0;
    const row: Row = { kind, attemptBefore: hold?.attempts ?? null, fingerLine: fl ? { pos: fl.pos, top: fl.top, paintScale: fl.paintScale, dpr: fl.dpr } : null, scrollTopBefore: view.scrollDOM.scrollTop, scrollWrites: [] as number[][] };
    const realSet = o.setViewportScroll;
    o.setViewportScroll = function (left: number, top: number, ...rest: unknown[]) {
     if (fl && !("moved" in row)) {
      const scaleY = view.scaleY || 1;
      row.moved = view.lineBlockAt(fl.pos).top / scaleY - fl.top - appliedBefore;
      row.band = (Number.isFinite(o.cssScale) && o.cssScale > 0 ? Math.abs(fl.top) * Math.abs(scaleY / o.cssScale - 1) : 0) + (fl.dpr > 0 && fl.paintScale > 0 ? .5 / (fl.dpr * fl.paintScale) : 0) + 1 / 16;
     }
     (row.scrollWrites as number[][]).push([left, top]);
     return realSet.call(this, left, top, ...rest);
    };
    try { return write.call(this, value, v); }
    finally {
     o.setViewportScroll = realSet;
     const appliedAfter = hold ? settleLineApplied.get(hold) ?? 0 : 0, first = (row.scrollWrites as number[][])[0];
     row.applied = appliedAfter - appliedBefore;
     row.targetTopAfter = first ? first[1] : null;
     row.targetTopBefore = first ? first[1]! - (appliedAfter - appliedBefore) : null;
     row.attemptAfter = hold?.attempts ?? null; row.outcome = hold?.outcome ?? null; row.ready = hold?.ready ?? null;
     row.scrollTopAfter = view.scrollDOM.scrollTop;
     attempts.push(row);
    }
   };
  }
  return realRequest.call(view, req);
 };
 try {
  const before = snapshot(o, view);
  let ok: boolean;
  if (arm === "plus") ok = o.zoomNoteBy(2);
  // Fit, measured only: its commit carries no hold.
  else if (arm === "fit") ok = o.fitHandwriting() === "fit";
  else {
   await new Promise<void>(r => setTimeout(r, 400));
   const v = view.scrollDOM.getBoundingClientRect(), cx = v.left + v.width / 2, cy = v.top + v.height / 2, half = 100;
   point("pointerdown", cx - half, cy, "touch", 501); point("pointerdown", cx + half, cy, "touch", 502);
   for (let k = 1; k <= 20; k++) { await frames(1); const h = half * (1 + k / 20); point("pointermove", cx - h, cy, "touch", 501); point("pointermove", cx + h, cy, "touch", 502); }
   point("pointerup", cx - 2 * half, cy, "touch", 501); point("pointerup", cx + 2 * half, cy, "touch", 502);
   ok = true;
  }
  await frames(8); const settled = { ...snapshot(o, view), overlayScale: o.pinchScaleNow };
  await frames(60); const quiet = { ...snapshot(o, view), overlayScale: o.pinchScaleNow };
  return { arm, obsidian, ok, slideId: written.slideId, before, settled, quiet, attempts, commits, warns };
 } finally { console.warn = realWarn; (view as any).requestMeasure = realRequest; o.commitCameraScale = realCommit; }
}
(window as any).issue48Trace = { trace };
