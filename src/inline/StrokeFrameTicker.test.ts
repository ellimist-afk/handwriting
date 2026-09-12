import { afterEach, expect, it, vi } from "vitest";
import { InkOverlayPlugin } from "./InkOverlay";
import { StrokeMetrics } from "../ink/StrokeMetrics";

afterEach(() => vi.restoreAllMocks());

// Real lifecycle methods with the browser's cancellable pending-frame contract.
// Stop/start can happen between two frames when consecutive strokes are quick.
function rig() {
 const pending = new Map<number, FrameRequestCallback>();
 let id = 0;
 const win = {
  requestAnimationFrame: (fn: FrameRequestCallback) => { pending.set(++id, fn); return id; },
  cancelAnimationFrame: (key: number) => { pending.delete(key); },
 };
 const overlay = Object.create(InkOverlayPlugin.prototype) as any;
 Object.assign(overlay, { frameTicking: false, frameRaf: 0,
  view: { dom: { ownerDocument: { defaultView: win } } },
  snapPreview: { check: vi.fn() },
 });
 const record = vi.spyOn(StrokeMetrics.prototype, "recordFrame");
 const frame = () => {
  const callbacks = [...pending];
  for (const [key, callback] of callbacks) {
   if (!pending.delete(key)) continue;
   callback(100);
  }
 };
 return { overlay, pending, record, frame };
}

it("keeps one frame callback across rapid consecutive strokes", () => {
 const r = rig();
 for (let stroke = 0; stroke < 20; stroke++) {
  r.overlay.startFrameTicker();
  r.frame();
  r.overlay.stopFrameTicker();
 }
 r.overlay.startFrameTicker();
 expect(r.pending.size).toBe(1);
 r.record.mockClear();
 r.frame();
 expect(r.record).toHaveBeenCalledTimes(1);
 expect(r.pending.size).toBe(1);
});

it("cancels the pending callback when a stroke or overlay stops", () => {
 const r = rig();
 r.overlay.startFrameTicker();
 r.overlay.startFrameTicker();
 expect(r.pending.size).toBe(1);
 r.overlay.stopFrameTicker();
 r.overlay.stopFrameTicker();
 expect(r.pending.size).toBe(0);
 r.frame();
 expect(r.record).not.toHaveBeenCalled();
 expect(r.overlay.snapPreview.check).not.toHaveBeenCalled();
});

it("does not let a stale callback join a restarted stroke", () => {
 const r = rig();
 r.overlay.startFrameTicker();
 const oldCallback = [...r.pending.values()][0]!;
 r.overlay.stopFrameTicker();
 r.overlay.startFrameTicker();
 oldCallback(100);
 expect(r.record).not.toHaveBeenCalled();
 expect(r.pending.size).toBe(1);
 r.frame();
 expect(r.record).toHaveBeenCalledTimes(1);
});

it("does not reschedule when a callback stops the ticker", () => {
 const r = rig();
 r.overlay.snapPreview.check.mockImplementation(() => r.overlay.stopFrameTicker());
 r.overlay.startFrameTicker();
 r.frame();
 expect(r.pending.size).toBe(0);
 expect(r.record).not.toHaveBeenCalled();
});
